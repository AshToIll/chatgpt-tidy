const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { installPageSession } = require("./helpers/page-session.cjs");

const root = path.resolve(__dirname, "..");
const catalogUrl = "/backend-api/conversations?offset=0";
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const nativeSearch = () => ({ items: [], cursor: null, partial_results: false, source_statuses: [] });
const query = (cursor = null) => ({ query: "needle", sessionId: "session-test", cursor });

function load({ session, fetch } = {}) {
  const calls = { sessions: 0, fetches: [] };
  const attributes = new Map();
  const context = vm.createContext({
    console, Date, URL, URLSearchParams, AbortController, AbortSignal, setTimeout, clearTimeout,
    document: { documentElement: {
      getAttribute: key => attributes.get(key) ?? null,
      setAttribute: (key, value) => attributes.set(key, value),
    } },
    TidyChatgptApi: {
      loadSession: async () => { calls.sessions++; return session ? session() : { accountId: "account-1" }; },
      catalogIdentity: () => ({ accountKey: "account-1", accountId: "account-1" }),
      fetchAuthenticated: async (url, options) => {
        calls.fetches.push({ url, options });
        return fetch ? fetch(url, options) : jsonResponse({ items: [], total: 0 });
      },
    },
  });
  installPageSession(context);
  for (const file of ["features/search/model/search.js", "platform/catalog/date-search.js", "platform/chatgpt/messages.js",
    "features/search/chatgpt/search.js", "platform/catalog/chatgpt/date-index.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, "src", file), "utf8"), context, { filename: file });
  }
  return { context, calls, attributes, lifecycle: context.TidyPageSession,
    messages: context.TidyChatgptMessages, search: context.TidyChatgptSearch, date: context.TidyChatgptDateIndex };
}

function terminal(error) {
  assert.equal(error.code, "ADAPTER_UNAVAILABLE");
  assert.deepEqual(JSON.parse(JSON.stringify(error.details)), { stage: "page-session", disconnect: "context-invalidated" });
  assert.notEqual(error.retryable, true, "retirement never becomes an auth/network retry");
  return true;
}

test("retired message/search/date request entries issue no session or backend requests", async () => {
  const h = load();
  h.lifecycle.stop();
  for (const invoke of [() => h.messages.account(), () => h.messages.readJson(catalogUrl),
    () => h.search.search(query()), () => h.search.search(query("next")), () => h.date.account(),
    () => h.date.readSourcePage({ source: "ordinary", accountKey: "account-1" })]) {
    await assert.rejects(invoke(), terminal);
  }
  assert.equal(h.calls.sessions, 0);
  assert.equal(h.calls.fetches.length, 0);
});

test("a document retirement marker closes request entries even without its event", async () => {
  const h = load();
  h.attributes.set("data-tidy-page-session", "retired");
  await assert.rejects(h.search.search(query()), terminal);
  await assert.rejects(h.messages.readJson(catalogUrl), terminal);
  assert.equal(h.calls.fetches.length, 0);
  assert.equal(h.lifecycle.signal.aborted, true);
});

test("retirement during catalog authentication blocks late backend dispatch", async () => {
  const pending = deferred();
  const h = load({ session: () => pending.promise });
  const read = h.messages.readJson(catalogUrl);
  h.lifecycle.stop();
  await assert.rejects(read, terminal);
  pending.resolve({ accountId: "account-1" });
  await flush();
  assert.equal(h.calls.fetches.length, 0);
});

test("retirement aborts a catalog fetch and never reads its late body", async () => {
  const pending = deferred();
  let bodyReads = 0;
  const h = load({ fetch: () => pending.promise });
  const read = h.messages.readJson(catalogUrl);
  await flush();
  assert.equal(h.calls.fetches.length, 1);
  h.lifecycle.stop();
  assert.equal(h.calls.fetches[0].options.signal.aborted, true);
  await assert.rejects(read, terminal);
  pending.resolve({ ok: true, status: 200, json: async () => { bodyReads++; return { items: [] }; } });
  await flush();
  assert.equal(bodyReads, 0);
  assert.equal(h.calls.sessions, 1, "late fetch cannot schedule the identity re-check");
});

test("retirement during success/error catalog bodies rejects without reauthentication or output", async () => {
  for (const status of [200, 503]) {
    const pending = deferred();
    let bodyReads = 0;
    const h = load({ fetch: async () => ({ ok: status === 200, status, json: () => { bodyReads++; return pending.promise; } }) });
    const read = h.messages.readJson(catalogUrl);
    await flush();
    assert.equal(bodyReads, 1);
    const sessionCount = h.calls.sessions;
    h.lifecycle.stop();
    await assert.rejects(read, terminal);
    pending.resolve(status === 200 ? { items: [] } : { detail: { can_retry: true } });
    await flush();
    assert.equal(h.calls.sessions, sessionCount);
    assert.equal(h.calls.fetches.length, 1);
  }
});

test("retirement aborts all search pages, including continuations, before late response parsing", async () => {
  const pending = deferred();
  let bodyReads = 0;
  const h = load({ fetch: () => pending.promise });
  const reads = [h.search.search(query()), h.search.search(query("page-2")), h.search.search(query("page-3"))];
  assert.equal(h.calls.fetches.length, 3);
  h.lifecycle.stop();
  for (const read of reads) await assert.rejects(read, terminal);
  assert.ok(h.calls.fetches.every(call => call.options.signal.aborted));
  pending.resolve({ ok: true, json: async () => { bodyReads++; return nativeSearch(); } });
  await flush();
  assert.equal(bodyReads, 0);
});

test("retirement rejects stalled search JSON rather than returning a late page", async () => {
  const pending = deferred();
  let bodyReads = 0;
  const h = load({ fetch: async () => ({ ok: true, json: () => { bodyReads++; return pending.promise; } }) });
  const read = h.search.search(query());
  await flush();
  assert.equal(bodyReads, 1);
  h.lifecycle.stop();
  await assert.rejects(read, terminal);
  pending.resolve(nativeSearch());
  await flush();
  assert.equal(h.calls.fetches.length, 1);
});

test("ordinary backend failures remain non-terminal and permit a later user request", async () => {
  let fail = true;
  const h = load({ fetch: async () => fail ? jsonResponse({}, 503) : jsonResponse(nativeSearch()) });
  await assert.rejects(h.search.search(query()), /503/);
  assert.equal(h.lifecycle.check(), true);
  fail = false;
  assert.equal((await h.search.search(query())).items.length, 0);
  assert.equal(h.calls.fetches.length, 2);
});
