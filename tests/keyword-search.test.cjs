const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(setImmediate);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const hit = (conversationId, messageId = "m1", extra = {}) => ({ resultId: `native:${conversationId}:${messageId}`,
  source: "conversation", conversationId, messageId, title: `Title ${conversationId}`, snippet: "Codex preview",
  conversationUpdatedAt: null, matchKind: "content", ...extra });
const page = (items = [], extra = {}) => ({ schemaVersion: "tidy.search.v1", query: "codex", items,
  cursor: null, hasMore: false, partialResults: false, ...extra });

function setup(t, fetchPage, options = {}) {
  const timers = new Set();
  const context = vm.createContext({ console, setTimeout: (callback, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timers.add(timer);
    return timer;
  }, clearTimeout: (timer) => { timers.delete(timer); clearTimeout(timer); } });
  vm.runInContext(fs.readFileSync(path.join(root, "src/features/search/model/search.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(root, "src/platform/library/library-hydration.js"), "utf8"), context);
  const source = fs.readFileSync(path.join(root, "src/features/search/ui/keyword-search.js"), "utf8")
    .replace(/^export /gm, "");
  vm.runInContext(source, context, { filename: "keyword-search.js" });
  let session = 0;
  const requests = [], changes = [];
  const service = context.createKeywordSearch({ fetchPage: (request) => {
    requests.push(plain(request));
    return fetchPage(request, requests.length);
  }, onChange: (value) => changes.push(plain(value)), createSessionId: () => `session-${++session}`,
  pageDelayMs: 0, ...options });
  t.after(() => {
    service.reset();
    assert.equal(timers.size, 0, "a reset must not leave a scheduled official request");
  });
  return { service, requests, changes, timers, createKeywordSearch: context.createKeywordSearch };
}

test("first batch resolves before background completion, totals grow, and requests keep opaque cursors", async (t) => {
  const second = deferred();
  const { service, requests, changes } = setup(t, (request) => request.cursor
    ? second.promise : page([hit("a")], { cursor: "opaque-next", hasMore: true }));
  const first = await service.start(" codex ");
  assert.equal(first.total, 1);
  assert.equal(first.phase, "loading");
  assert.equal(first.complete, false);
  const finished = service.whenIdle();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests.length, 2);
  second.resolve(page([hit("b")]));
  const complete = await finished;
  assert.equal(complete.total, 2);
  assert.equal(complete.complete, true);
  assert.equal(complete.phase, "complete");
  assert.deepEqual(requests.map(({ cursor, limit, sessionId, mode }) => ({ cursor, limit, sessionId, mode })), [
    { cursor: null, limit: 30, sessionId: "session-1", mode: "keyword" },
    { cursor: "opaque-next", limit: 30, sessionId: "session-1", mode: "keyword" },
  ]);
  assert.deepEqual(changes.filter((change) => change.total).map((change) => change.total), [1, 1, 2]);
});

test("message identities deduplicate across batches without grouping conversations or replacing first snippets", async (t) => {
  const { service } = setup(t, (_, count) => count === 1
    ? page([hit("a"), hit("a", null), hit("b")], { cursor: "next", hasMore: true })
    : page([hit("a", "m1", { snippet: "replacement" }), hit("a", "m2"), hit("a", null)]));
  await service.start("codex");
  const result = await service.whenIdle();
  assert.deepEqual(Array.from(result.items, (item) => item.resultId), [
    "keyword:a:m1", "keyword:a:title", "keyword:b:m1", "keyword:a:m2",
  ]);
  assert.equal(result.total, 4);
  assert.equal(result.items[0].snippet, "Codex preview");
  result.items[0].snippet = "outside mutation";
  assert.equal(service.snapshot().items[0].snippet, "Codex preview");
});

test("an empty intermediate batch still follows its new cursor without concurrent requests", async (t) => {
  let active = 0, maximum = 0;
  const { service, requests } = setup(t, async (_, count) => {
    active += 1;
    maximum = Math.max(active, maximum);
    await tick();
    active -= 1;
    return count < 3 ? page([], { cursor: `cursor-${count}`, hasMore: true }) : page([hit("last")]);
  });
  await service.start("codex");
  assert.equal((await service.whenIdle()).total, 1);
  assert.equal(maximum, 1);
  assert.deepEqual(requests.map((request) => request.cursor), [null, "cursor-1", "cursor-2"]);
});

for (const [label, response, code] of [
  ["missing cursor", page([hit("a")], { hasMore: true }), "SEARCH_CURSOR_INVALID"],
  ["dangling terminal cursor", page([hit("a")], { cursor: "dangling" }), "SEARCH_CURSOR_INVALID"],
  ["partial terminal page", page([hit("a")], { partialResults: true }), "SEARCH_PARTIAL_RESULTS"],
  ["partial intermediate page", page([hit("a")], { partialResults: true, cursor: "next", hasMore: true }), "SEARCH_PARTIAL_RESULTS"],
  ["source failure", page([hit("a")], { sourceStatus: { status: "error" } }), "SEARCH_PARTIAL_RESULTS"],
  ["malformed schema", page([hit("a")], { schemaVersion: "changed" }), "SEARCH_SCHEMA_CHANGED"],
  ["mismatched query", page([hit("a")], { query: "other" }), "SEARCH_QUERY_MISMATCH"],
]) {
  test(`${label} cannot claim a complete total and explicit retry starts a new session`, async (t) => {
    const { service, requests } = setup(t, (_, count) => count === 1 ? response : page([hit("clean")]));
    await service.start("codex");
    const failed = await service.whenIdle();
    assert.equal(failed.phase, "error");
    assert.equal(failed.error.code, code);
    assert.equal(failed.error.restartRequired, true);
    assert.equal(failed.partialResults, true);
    assert.equal(failed.complete, false);
    service.resume();
    await tick();
    assert.equal(requests.length, 1, "visibility resume must not retry errors");
    await service.retry();
    const complete = await service.whenIdle();
    assert.equal(complete.complete, true);
    assert.equal(complete.total, 1);
    assert.equal(complete.items[0].conversationId, "clean");
    assert.notEqual(requests[0].sessionId, requests[1].sessionId);
    assert.equal(requests[1].cursor, null);
  });
}

test("repeated cursors stop after retaining the last valid messages", async (t) => {
  const { service, requests } = setup(t, (_, count) => page([hit(`item-${count}`)], {
    cursor: count === 2 ? "second" : "first", hasMore: true,
  }));
  await service.start("codex");
  const result = await service.whenIdle();
  assert.equal(requests.length, 3);
  assert.equal(result.error.code, "SEARCH_CURSOR_LOOP");
  assert.equal(result.total, 3);
  assert.equal(result.complete, false);
});

test("network and rate-limit errors keep results and retry only the failed cursor when explicitly requested", async (t) => {
  const { service, requests } = setup(t, (_, count) => {
    if (count === 1) return page([hit("a")], { cursor: "second", hasMore: true });
    if (count === 2) throw Object.assign(new Error("Rate limited (429)"), { code: "SEARCH_UNAVAILABLE" });
    return page([hit("b")]);
  });
  await service.start("codex");
  const failed = await service.whenIdle();
  assert.equal(failed.total, 1);
  assert.equal(failed.error.restartRequired, false);
  service.resume();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests.length, 2, "no automatic retry or backoff loop");
  await service.retry();
  const result = await service.whenIdle();
  assert.equal(result.complete, true);
  assert.equal(result.total, 2);
  assert.deepEqual(requests.map((request) => request.cursor), [null, "second", "second"]);
  assert.equal(new Set(requests.map((request) => request.sessionId)).size, 1);
});

test("pause clears queued pages, and repeated resume does not dispatch duplicate cursors", async (t) => {
  const { service, requests, timers } = setup(t, (_, count) => count === 1
    ? page([hit("a")], { cursor: "next", hasMore: true }) : page([hit("b")]), { pageDelayMs: 20 });
  await service.start("codex");
  service.pause();
  assert.equal((await service.whenIdle()).phase, "paused");
  assert.equal(timers.size, 0);
  assert.equal(requests.length, 1);
  service.resume();
  service.resume();
  assert.equal((await service.whenIdle()).total, 2);
  assert.equal(requests.length, 2);
});

test("pause allows a sent page to settle, then resume continues from the accepted cursor", async (t) => {
  const first = deferred();
  const { service, requests } = setup(t, (_, count) => count === 1 ? first.promise : page([hit("b")]));
  const started = service.start("codex");
  await tick();
  service.pause();
  const idle = service.whenIdle();
  first.resolve(page([hit("a")], { cursor: "next", hasMore: true }));
  await started;
  assert.equal((await idle).phase, "paused");
  assert.equal(service.snapshot().total, 1);
  assert.equal(requests.length, 1);
  service.resume();
  assert.equal((await service.whenIdle()).total, 2);
  assert.deepEqual(requests.map((request) => request.cursor), [null, "next"]);
});

test("pause before the first dispatch settles start and idle, then resumes the first page once", async (t) => {
  const { service, requests } = setup(t, () => page([hit("a")]));
  const started = service.start("codex");
  service.pause();
  assert.equal((await started).phase, "paused");
  assert.equal((await service.whenIdle()).phase, "paused");
  assert.equal(requests.length, 0);
  service.resume();
  service.resume();
  assert.equal((await service.whenIdle()).complete, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].cursor, null);
});

test("first-page failure retries the same session without an automatic request", async (t) => {
  const { service, requests } = setup(t, (_, count) => {
    if (count === 1) throw new Error("Network unavailable");
    return page();
  });
  assert.equal((await service.start("codex")).phase, "error");
  assert.equal((await service.whenIdle()).total, 0);
  assert.equal(requests.length, 1);
  await service.retry();
  assert.equal((await service.whenIdle()).complete, true);
  assert.equal(requests[0].sessionId, requests[1].sessionId);
  assert.equal(requests[1].cursor, null);
});

test("resume during a sent page does not duplicate it, and an exhausted paused request still completes", async (t) => {
  const first = deferred();
  const { service, requests } = setup(t, () => first.promise);
  const started = service.start("codex");
  await tick();
  service.pause();
  service.resume();
  service.pause();
  first.resolve(page([hit("a")]));
  await started;
  assert.equal((await service.whenIdle()).phase, "complete");
  service.resume();
  assert.equal(requests.length, 1);
});

test("a new query ignores old success, including in-flight idle waiters", async (t) => {
  const old = deferred();
  const { service, requests } = setup(t, (request) => request.query === "codex"
    ? old.promise : page([hit("fresh")], { query: request.query }));
  const oldStart = service.start("codex");
  await tick();
  const oldIdle = service.whenIdle();
  await service.start("fresh");
  await oldIdle;
  old.resolve(page([hit("stale")], { cursor: "old-next", hasMore: true }));
  await oldStart;
  const result = await service.whenIdle();
  assert.equal(result.query, "fresh");
  assert.equal(result.total, 1);
  assert.equal(result.items[0].conversationId, "fresh");
  assert.equal(requests.length, 2);
});

test("a superseded query failure cannot overwrite the replacement query", async (t) => {
  const old = deferred();
  const { service, requests } = setup(t, (request) => request.query === "codex"
    ? old.promise : page([hit("fresh")], { query: request.query }));
  const oldStart = service.start("codex");
  await tick();
  await service.start("fresh");
  old.reject(new Error("Superseded request failed"));
  await oldStart;
  const result = await service.whenIdle();
  assert.equal(result.phase, "complete");
  assert.equal(result.query, "fresh");
  assert.equal(result.error, false);
  assert.equal(requests.length, 2);
});

test("reset before the dispatch microtask sends no request and leaves no work pending", async (t) => {
  const { service, requests } = setup(t, () => page());
  const started = service.start("codex");
  service.reset();
  assert.equal((await service.whenIdle()).phase, "idle");
  await started;
  assert.equal(requests.length, 0);
});

test("a typed schema failure starts a clean session rather than retrying the failed cursor", async (t) => {
  const { service, requests } = setup(t, (_, count) => {
    if (count === 1) return page([hit("first")], { cursor: "next", hasMore: true });
    if (count === 2) throw Object.assign(new Error("Official search schema changed"), { code: "SEARCH_SCHEMA_CHANGED" });
    return page([hit("clean")]);
  });
  await service.start("codex");
  assert.equal((await service.whenIdle()).error.restartRequired, true);
  await service.retry();
  assert.equal((await service.whenIdle()).items[0].conversationId, "clean");
  assert.equal(requests[2].cursor, null);
  assert.notEqual(requests[2].sessionId, requests[1].sessionId);
});

test("reset immediately releases idle waiters and rejects late errors without scheduling work", async (t) => {
  const pending = deferred();
  const { service, requests } = setup(t, () => pending.promise);
  const started = service.start("codex");
  await tick();
  const idle = service.whenIdle();
  service.reset();
  assert.equal((await idle).phase, "idle");
  pending.reject(new Error("late failure"));
  await started;
  assert.equal(service.snapshot().phase, "idle");
  assert.equal(service.snapshot().error, false);
  assert.equal(requests.length, 1);
});

test("configuration and query boundaries fail before dispatch", async (t) => {
  const { service, createKeywordSearch, requests } = setup(t, () => page());
  for (const batchSize of [0, -1, 61, 2.5, "30"]) {
    assert.throws(() => createKeywordSearch({ fetchPage: async () => page(), batchSize }), /batchSize/);
  }
  for (const pageDelayMs of [-1, Infinity, NaN, 60_001, "10"]) {
    assert.throws(() => createKeywordSearch({ fetchPage: async () => page(), pageDelayMs }), /pageDelayMs/);
  }
  assert.throws(() => service.start(" "), /query/);
  assert.throws(() => service.start("x".repeat(501)), /query/);
  assert.equal(requests.length, 0);
  assert.equal((await service.whenIdle()).phase, "idle");
});


test("document interruption ignores a late bridge failure and resumes the unaccepted cursor", async (t) => {
  const oldPage = deferred(), oldPageSent = deferred();
  const { service, requests, changes } = setup(t, (_, count) => {
    if (count === 1) return page([hit("a")], { cursor: "next", hasMore: true });
    if (count === 2) { oldPageSent.resolve(); return oldPage.promise; }
    return page([hit("a"), hit("b")]);
  });
  await service.start("codex");
  await oldPageSent.promise;
  service.pause({ invalidateInFlight: true });
  oldPage.reject(Object.assign(new Error("The target document was replaced"), { code: "TAB_UNAVAILABLE" }));
  await tick();
  assert.equal(service.snapshot().phase, "paused");
  assert.equal(service.snapshot().error, false);
  assert.equal(service.snapshot().total, 1);
  assert.equal(changes.some((value) => value.phase === "error"), false);
  service.resume();
  const complete = await service.whenIdle();
  assert.equal(complete.phase, "complete");
  assert.equal(complete.total, 2, "accepted results and their deduplication survive the document handoff");
  assert.deepEqual(requests.map((request) => request.cursor), [null, "next", "next"]);
  assert.equal(new Set(requests.map((request) => request.sessionId)).size, 1);
});

test("document interruption releases paused pending work without waiting for the old bridge", async (t) => {
  const oldPage = deferred(), oldPageSent = deferred();
  const { service, requests, changes } = setup(t, (_, count) => {
    if (count === 1) return page([hit("a")], { cursor: "next", hasMore: true });
    if (count === 2) { oldPageSent.resolve(); return oldPage.promise; }
    return page([hit("b")]);
  });
  await service.start("codex");
  await oldPageSent.promise;
  service.pause();
  let idleSettled = false;
  const idle = service.whenIdle().then((value) => { idleSettled = true; return value; });
  service.pause({ invalidateInFlight: true });
  await tick();
  assert.equal(idleSettled, true, "an old document cannot hold the current session's idle waiters");
  assert.equal((await idle).phase, "paused");
  service.resume();
  service.resume();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests.length, 3, "resume dispatches once without awaiting the obsolete bridge");
  assert.equal((await service.whenIdle()).total, 2);
  const published = changes.length;
  oldPage.resolve(page([hit("stale")], { cursor: "stale-next", hasMore: true }));
  await tick();
  assert.equal(changes.length, published, "late success must not publish or schedule from the old document");
  assert.deepEqual(Array.from(service.snapshot().items, (item) => item.conversationId), ["a", "b"]);
  assert.deepEqual(requests.map((request) => request.cursor), [null, "next", "next"]);
});

test("document interruption before dispatch resumes the first page without resetting the query", async (t) => {
  const { service, requests } = setup(t, () => page([hit("a")]));
  const started = service.start("codex");
  const sessionId = service.snapshot().sessionId;
  service.pause({ invalidateInFlight: true });
  assert.equal((await started).phase, "paused");
  assert.equal((await service.whenIdle()).phase, "paused");
  assert.equal(requests.length, 0);
  service.resume();
  assert.equal((await service.whenIdle()).complete, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].sessionId, sessionId);
  assert.equal(requests[0].cursor, null);
});

test("keyword transport failure retains recovery details and an explicitly forbidden retry", async (t) => {
  const { service, requests } = setup(t, () => {
    throw Object.assign(new Error("Synthetic invalid document"), { code: "ADAPTER_UNAVAILABLE",
      details: { stage: "page-session", disconnect: "context-invalidated", retryable: false } });
  });
  await service.start("codex");
  const error = service.snapshot().error;
  assert.equal(error.stage, "page-session");
  assert.equal(error.disconnect, "context-invalidated");
  assert.equal(error.retryable, false);
  await service.retry();
  assert.equal(requests.length, 1, "a removed retry action also has no programmatic retry path");
  assert.equal(service.snapshot().phase, "error", "real failures remain visible");
});

test("keyword HTTP errors retain their status while unknown failures remain visibly retryable", async (t) => {
  for (const failure of [
    Object.assign(new Error("Synthetic limit"), { code: "SEARCH_UNAVAILABLE", details: { status: 429, retryable: true } }),
    Object.assign(new Error("Synthetic network"), { code: "SEARCH_UNAVAILABLE" }),
  ]) {
    const { service, requests } = setup(t, () => { throw failure; });
    await service.start("codex");
    assert.equal(service.snapshot().phase, "error");
    assert.equal(service.snapshot().error.status, failure.details?.status ?? null);
    assert.equal(service.snapshot().error.retryable, failure.details?.retryable ?? null);
    await service.retry();
    assert.equal(requests.length, 2, "an explicit retry still works for transient or unknown failures");
  }
});

for (const [label, settlePage, code] of [
  ["HTTP rate limit", (pending) => pending.reject(Object.assign(new Error("HTTP 429"),
    { code: "SEARCH_UNAVAILABLE" })), "SEARCH_UNAVAILABLE"],
  ["network failure", (pending) => pending.reject(new Error("Network unavailable")), "SEARCH_UNAVAILABLE"],
  ["schema error", (pending) => pending.resolve(page([], { schemaVersion: "changed" })), "SEARCH_SCHEMA_CHANGED"],
]) {
  test("ordinary visibility pause still reports a real " + label + " and never retries it automatically", async (t) => {
    const pending = deferred();
    const { service, requests } = setup(t, () => pending.promise);
    const started = service.start("codex");
    await tick();
    service.pause();
    settlePage(pending);
    await started;
    const failed = await service.whenIdle();
    assert.equal(failed.phase, "error");
    assert.equal(failed.error.code, code);
    service.pause({ invalidateInFlight: true });
    service.resume();
    await tick();
    assert.equal(service.snapshot().phase, "error", "document handoff cannot clear an already-recorded failure");
    assert.equal(requests.length, 1);
  });
}
