const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");

const root = path.resolve(__dirname, "..");
const ACCOUNT = "synthetic-paused-catalog";
const VERSION = "tidy.date-search.v1";
const clone = (value) => structuredClone(value);
const gate = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const page = (source, id = null, nextCursor = null) => ({ schemaVersion: VERSION, source,
  conversations: id ? [{ conversationId: id, title: id, updatedAt: null,
    directoryBounds: { createdAt: null, updatedAt: null, sources: [source] } }] : [],
  projects: [], nextCursor, done: nextCursor === null, coverageReasons: [] });

async function harness(t) {
  globalThis.IDBKeyRange = IDBKeyRange;
  const { openTidyDatabase } = await import("../src/platform/storage/database.js");
  const { createConversationCatalogRepository } = await import("../src/platform/catalog/storage/conversation-catalog.js");
  const db = await openTidyDatabase(new IDBFactory());
  const repository = createConversationCatalogRepository({ openDatabase: async () => db });
  const requests = [], statuses = [], hooks = {};
  let visible = true;
  const context = vm.createContext({ structuredClone });
  vm.runInContext(fs.readFileSync(path.join(root, "src/platform/catalog/date-search.js"), "utf8"), context);
  const source = fs.readFileSync(path.join(root, "src/platform/catalog/ui/conversation-catalog-reader.js"), "utf8")
    .replace(/^import[^\n]+\n/gm, "").replace(/^export /gm, "");
  vm.runInContext(source, context);
  const reader = context.createConversationCatalogReader({ canDispatch: () => visible,
    repository: { getSnapshot: async (...args) => { await hooks.beforeSnapshot?.(...args); return repository.getSnapshot(...args); },
      commitPage: async (...args) => { await hooks.beforeCommit?.(...args); return repository.commitPage(...args); },
      putState: async (...args) => { await hooks.beforeState?.(...args); return repository.putState(...args); } },
    requestAdapter: async (action, payload) => {
      if (action === "account") return { schemaVersion: VERSION, accountKey: ACCOUNT };
      requests.push(clone(payload));
      return hooks.sourcePage ? hooks.sourcePage(payload) : page(payload.source);
    }, onStatus: (status) => { statuses.push(clone(status)); hooks.onStatus?.(status); } });
  t.after(async () => { await reader.pause(); db.close(); });
  return { repository, reader, requests, statuses, hooks, setVisible: (value) => { visible = value; } };
}

// Navigation may retire a document while the directory GET is in flight. Its
// late error belongs to the revoked run, not the cached source or next view.
for (const failure of [
  { code: "CANCELLED", category: "CANCELLED", name: "AbortError" },
  { code: "ADAPTER_UNAVAILABLE", category: "ADAPTER_UNAVAILABLE" },
  { code: "NETWORK", category: "NETWORK", retryable: true },
  { code: "STORAGE_ERROR", category: "STORAGE" },
]) test(
  "a paused in-flight " + failure.code + " cannot poison the saved cursor or publish a current error", async (t) => {
    const h = await harness(t), waiting = gate(), began = gate();
    h.hooks.sourcePage = async ({ source, cursor }) => {
      if (source !== "ordinary") return page(source);
      if (cursor === null) return page(source, "already-visible", "next");
      began.resolve(); return waiting.promise;
    };
    await h.reader.read({ sessionId: "search" });
    await began.promise;
    const before = clone(await h.repository.getSnapshot(ACCOUNT));
    const mark = h.statuses.length;
    const paused = h.reader.pause();
    waiting.reject(Object.assign(new Error("Synthetic departed document"), failure));
    await paused;
    assert.deepEqual(clone(await h.repository.getSnapshot(ACCOUNT)), before,
      "a failed retired request cannot write a source failure or advance its checkpoint");
    assert.equal(h.statuses.length, mark, "retired work cannot push loading, paused or error UI into the current view");
    assert.equal(h.requests.length, 2, "pause prevents further source dispatch");
    h.hooks.sourcePage = async ({ source }) => page(source, source === "ordinary" ? "resumed" : null);
    await h.reader.resume(); await h.reader.whenIdle();
    assert.equal(h.requests[2].cursor, "next", "resume retries the unconsumed cursor, not the first page");
    assert.deepEqual(clone(h.reader.status().readErrors), []);
    assert.equal(h.reader.status().resultStable, true);
    assert.deepEqual((await h.repository.getSnapshot(ACCOUNT)).rows.map(row => row.conversationId).sort(),
      ["already-visible", "resumed"]);
  },
);

test("a valid page completed after pause remains cached without publishing into the retired view", async (t) => {
  const h = await harness(t), waiting = gate(), began = gate();
  h.hooks.sourcePage = async ({ source, cursor }) => {
    if (source !== "ordinary") return page(source);
    if (cursor === null) return page(source, "already-visible", "next");
    began.resolve(); return waiting.promise;
  };
  await h.reader.read({ sessionId: "search" }); await began.promise;
  const mark = h.statuses.length;
  const paused = h.reader.pause();
  waiting.resolve(page("ordinary", "late-valid", "after-valid"));
  await paused;
  const snapshot = await h.repository.getSnapshot(ACCOUNT);
  assert.deepEqual(snapshot.rows.map(row => row.conversationId).sort(), ["already-visible", "late-valid"]);
  assert.equal(snapshot.state.sources.ordinary.cursor, "after-valid");
  assert.equal(snapshot.state.sources.ordinary.error, null);
  assert.equal(snapshot.state.phase, "paused");
  assert.equal(h.statuses.length, mark);
  assert.equal(h.requests.length, 2);
});

test("an older request cannot publish into a resumed run with the same search session", async (t) => {
  const h = await harness(t), waiting = gate(), began = gate();
  let old = true;
  h.hooks.sourcePage = async ({ source }) => {
    if (!old) return page(source, source === "ordinary" ? "new-run" : null);
    began.resolve(); return waiting.promise;
  };
  await h.reader.read({ sessionId: "search" }); await began.promise;
  h.reader.pause();
  await h.reader.resume();
  const mark = h.statuses.length;
  old = false;
  waiting.reject(Object.assign(new Error("Synthetic retired transport"), { code: "NETWORK", category: "NETWORK" }));
  await h.reader.whenIdle();
  assert.ok(h.statuses.slice(mark).every(status => status.readErrors.length === 0));
  assert.equal(h.reader.status().resultStable, true);
  assert.deepEqual((await h.repository.getSnapshot(ACCOUNT)).rows.map(row => row.conversationId), ["new-run"]);
});

test("a hidden owner cannot publish or persist its late source failure", async (t) => {
  const h = await harness(t), waiting = gate(), began = gate();
  h.hooks.sourcePage = async () => { began.resolve(); return waiting.promise; };
  await h.reader.read({ sessionId: "search" }); await began.promise;
  const before = clone(await h.repository.getSnapshot(ACCOUNT)), mark = h.statuses.length;
  h.setVisible(false);
  waiting.reject(Object.assign(new Error("Synthetic hidden transport"), { code: "NETWORK", category: "NETWORK" }));
  await h.reader.whenIdle();
  assert.deepEqual(clone(await h.repository.getSnapshot(ACCOUNT)), before);
  assert.equal(h.statuses.length, mark);
});

for (const failure of [
  { code: "HTTP", category: "HTTP", status: 503, retryable: true },
  { code: "HTTP", category: "HTTP", status: 429, retryable: true },
  { code: "ACCOUNT_MISMATCH", category: "ACCOUNT_MISMATCH", retryable: false },
]) test(
  "an active source failure " + failure.code + "/" + (failure.status || "account") + " keeps its real error", async (t) => {
    const h = await harness(t);
    h.hooks.sourcePage = async ({ source }) => {
      if (source === "ordinary") throw Object.assign(new Error("Synthetic active failure"), failure);
      return page(source);
    };
    await h.reader.read({ sessionId: "search" }); await h.reader.whenIdle();
    const state = (await h.repository.getSnapshot(ACCOUNT)).state;
    assert.equal(state.sources.ordinary.error.code, failure.code);
    assert.equal(h.reader.status().readErrors[0].code, failure.code);
    assert.equal(h.reader.status().errorOrigin, "current");
    assert.equal(h.reader.status().resultStable, false);
    assert.equal(h.requests.length, failure.status === 503 ? 4 : 1);
  },
);

test("a real source failure observed before pause remains durable but its delayed checkpoint is not current UI", async (t) => {
  const h = await harness(t), waiting = gate(), began = gate();
  h.hooks.sourcePage = async () => { throw Object.assign(new Error("Synthetic real failure"), {
    code: "HTTP", category: "HTTP", status: 503, retryable: true }); };
  h.hooks.beforeState = async (_account, state) => {
    if (state.sources.ordinary.error && !began.done) {
      began.done = true; began.resolve(); await waiting.promise;
    }
  };
  await h.reader.read({ sessionId: "search" }); await began.promise;
  const mark = h.statuses.length, paused = h.reader.pause();
  waiting.resolve(); await paused;
  assert.equal((await h.repository.getSnapshot(ACCOUNT)).state.sources.ordinary.error.status, 503);
  assert.equal(h.statuses.length, mark);
});

test("a final-checkpoint failure after pause cannot publish a catalog interruption into the departed view", async (t) => {
  const h = await harness(t), waiting = gate(), began = gate();
  h.hooks.sourcePage = async ({ source }) => page(source, source === "ordinary" ? "committed" : null);
  h.hooks.beforeState = async (_account, state) => {
    if (state.phase === "settled") { began.resolve(); await waiting.promise; }
  };
  await h.reader.read({ sessionId: "search" }); await began.promise;
  const before = clone(await h.repository.getSnapshot(ACCOUNT));
  const mark = h.statuses.length, paused = h.reader.pause();
  waiting.reject(Object.assign(new Error("Synthetic late checkpoint failure"), {
    code: "STORAGE_ERROR", category: "STORAGE" }));
  await paused;
  assert.deepEqual(clone(await h.repository.getSnapshot(ACCOUNT)), before);
  assert.equal(h.statuses.length, mark);
  assert.deepEqual(before.rows.map(row => row.conversationId), ["committed"]);
});

test("an active catalog failure retains transport recovery evidence in its flat DTO", async (t) => {
  const h = await harness(t);
  h.hooks.sourcePage = async ({ source }) => {
    if (source !== "ordinary") return page(source);
    throw Object.assign(new Error("Synthetic invalid document"), { code: "ADAPTER_UNAVAILABLE",
      details: { stage: "page-session", disconnect: "context-invalidated", retryable: false } });
  };
  await h.reader.read({ sessionId: "search" }); await h.reader.whenIdle();
  const error = h.reader.status().readErrors[0];
  assert.equal(error.stage, "page-session", "source-fetch must not overwrite the actual recovery boundary");
  assert.equal(error.disconnect, "context-invalidated");
  assert.equal(error.retryable, false);
  const saved = (await h.repository.getSnapshot(ACCOUNT)).state.sources.ordinary.error;
  assert.equal(saved.disconnect, error.disconnect);
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, "src/platform/library/library-hydration.js"), "utf8"), context);
  assert.deepEqual(clone(context.TidyLibraryHydration.errorPresentation(saved, "searchDateReadFailed")),
    { messageKey: "refreshChatgptPage", retryable: false });
});

test("only new catalog failures have monotonic notices; cached errors and progress cannot replay them", async (t) => {
  const h = await harness(t);
  h.hooks.sourcePage = async ({ source }) => {
    if (source === "ordinary") throw Object.assign(new Error("Synthetic old schema error"), { code: "SCHEMA", retryable: false });
    return page(source, source === "pins" ? "known" : null);
  };
  await h.reader.read({ sessionId: "first" }); await h.reader.whenIdle();
  let notices = h.statuses.flatMap(status => status.failureNotice ? [status.failureNotice] : []);
  assert.deepEqual(notices.map(notice => [notice.id, notice.error.source]), [[1, "ordinary"]]);
  assert.equal(h.reader.status().failureNotice, undefined, "settling does not replay the earlier source failure");

  // Keep the historical ordinary failure while another source acquires a new
  // failure. The aggregate readErrors[0] deliberately remains the old one.
  const snapshot = await h.repository.getSnapshot(ACCOUNT), state = clone(snapshot.state);
  state.sources.archived.done = false; state.revision += 1;
  await h.repository.putState(ACCOUNT, state);
  h.hooks.sourcePage = async ({ source }) => {
    if (source === "archived") throw Object.assign(new Error("Synthetic new HTTP error"), { code: "HTTP", status: 503, retryable: true });
    return page(source);
  };
  await h.reader.read({ sessionId: "second" }); await h.reader.whenIdle();
  notices = h.statuses.flatMap(status => status.failureNotice ? [status.failureNotice] : []);
  assert.deepEqual(notices.map(notice => [notice.id, notice.error.source]), [[1, "ordinary"], [2, "archived"]]);
  const current = h.statuses.find(status => status.failureNotice?.id === 2);
  assert.equal(current.readErrors[0].source, "ordinary");
  assert.equal(current.failureNotice.error.source, "archived", "notification identifies the new failure, never errors[0]");
  const mark = h.statuses.length, requestCount = h.requests.length;
  await h.reader.read({ sessionId: "second", refresh: true });
  await h.reader.read({ sessionId: "third" }); await h.reader.whenIdle();
  assert.equal(h.requests.length, requestCount);
  assert.ok(h.statuses.slice(mark).every(status => !status.failureNotice));
  assert.equal(h.reader.status().readErrors.length, 2, "notification consumption must not hide partial data");
  await h.reader.resume(); await h.reader.whenIdle();
  notices = h.statuses.flatMap(status => status.failureNotice ? [status.failureNotice] : []);
  assert.deepEqual(notices.map(notice => notice.id), [1, 2, 3], "a genuinely retried failure is a new event even when its code matches");
  assert.equal(JSON.stringify(await h.repository.getSnapshot(ACCOUNT)).includes("failureNotice"), false);
});

test("catalog notice diagnostics are detached from the durable source error", async (t) => {
  const h = await harness(t);
  h.hooks.sourcePage = async ({ source }) => {
    if (source === "ordinary") throw Object.assign(new Error("Synthetic source failure"), { code: "HTTP", status: 429, retryable: true });
    return page(source);
  };
  h.hooks.onStatus = status => { if (status.failureNotice) status.failureNotice.error.code = "OUTSIDE_MUTATION"; };
  await h.reader.read({ sessionId: "search" }); await h.reader.whenIdle();
  assert.equal((await h.repository.getSnapshot(ACCOUNT)).state.sources.ordinary.error.code, "HTTP");
  assert.equal(h.reader.status().readErrors[0].code, "HTTP");
  assert.deepEqual(h.statuses.filter(status => status.failureNotice).map(status => status.failureNotice.id), [1]);
});

for (const stage of ["cache-read", "page-commit", "page-readback", "final-checkpoint", "status-publish"]) {
  test("a current " + stage + " failure publishes one catalog notice without replaying cached errors", async (t) => {
    const h = await harness(t);
    h.hooks.sourcePage = async ({ source }) => page(source, source === "ordinary" ? "known" : null);
    const failure = Object.assign(new Error("Synthetic " + stage), { code: "STORAGE_ERROR", retryable: false });
    let failed = false, committed = false, snapshotReads = 0;
    h.hooks.beforeCommit = async () => {
      committed = true;
      if (stage === "page-commit" && !failed) { failed = true; throw failure; }
    };
    h.hooks.beforeSnapshot = async () => {
      snapshotReads += 1;
      if (stage === "cache-read" && snapshotReads === 2 && !failed) { failed = true; throw failure; }
      if (stage === "page-readback" && committed && !failed) { failed = true; throw failure; }
    };
    h.hooks.beforeState = async (_account, state) => {
      if (stage === "final-checkpoint" && state.phase === "settled" && !failed) { failed = true; throw failure; }
    };
    h.hooks.onStatus = status => {
      if (stage === "status-publish" && status.phase === "loading" && !failed) { failed = true; throw failure; }
    };
    await h.reader.read({ sessionId: "search" }); await h.reader.whenIdle();
    const notices = h.statuses.flatMap(status => status.failureNotice ? [status.failureNotice] : []);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].id, 1);
    assert.equal(notices[0].error.source, "catalog");
    assert.equal(notices[0].error.code, "STORAGE_ERROR");
    assert.equal(notices[0].error.stage, stage);
    assert.equal(JSON.stringify(await h.repository.getSnapshot(ACCOUNT)).includes("failureNotice"), false);
  });
}

test("a source failure retired during checkpoint persistence never becomes a new notice after reentry", async (t) => {
  const h = await harness(t), waiting = gate(), began = gate();
  h.hooks.sourcePage = async () => { throw Object.assign(new Error("Synthetic current error"), { code: "HTTP", status: 429, retryable: true }); };
  h.hooks.beforeState = async (_account, state) => {
    if (state.sources.ordinary.error && !began.done) { began.done = true; began.resolve(); await waiting.promise; }
  };
  await h.reader.read({ sessionId: "search" }); await began.promise;
  const paused = h.reader.pause(); waiting.resolve(); await paused;
  assert.ok(h.statuses.every(status => !status.failureNotice));
  await h.reader.read({ sessionId: "search", refresh: true });
  assert.ok(h.statuses.every(status => !status.failureNotice));
  assert.equal(h.reader.status().readErrors[0].status, 429, "the durable source remains incomplete without replaying its old failure");
});
