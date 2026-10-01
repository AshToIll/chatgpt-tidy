const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { installPageSession } = require("./helpers/page-session.cjs");

const root = path.resolve(__dirname, "..");
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function load({ loadSession, fetchAuthenticated, globals = {} } = {}) {
  const calls = [];
  const context = vm.createContext({
    console, Date, Intl, URL, URLSearchParams, Headers, AbortController, setTimeout, clearTimeout, encodeURIComponent,
    TidyChatgptApi: {
      loadSession: loadSession || (async () => ({ activeAccountId: "account-1", user: { id: "user-1" } })),
      fetchAuthenticated: async (url, options) => {
        calls.push({ url, options });
        return fetchAuthenticated ? fetchAuthenticated(url, options) : response({ items: [], total: 0 });
      },
    },
    ...globals,
  });
  const apiStub = context.TidyChatgptApi;
  installPageSession(context);
  delete context.TidyChatgptApi;
  vm.runInContext(fs.readFileSync(path.join(root, "src/platform/chatgpt/api.js"), "utf8"), context);
  context.TidyChatgptApi = { ...context.TidyChatgptApi, ...apiStub };
  for (const file of ["src/platform/catalog/date-search.js", "src/platform/chatgpt/messages.js", "src/platform/catalog/chatgpt/date-index.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  }
  return { adapter: context.TidyChatgptDateIndex, calls };
}

function categorized(code, expected = {}) {
  return (error) => {
    assert.equal(error.code, code);
    assert.equal(error.category, code);
    for (const [key, value] of Object.entries(expected)) assert.equal(error[key], value, key);
    return true;
  };
}

test("directory reads use shared authenticated GET with account/project context and reject changed accounts", async () => {
  const { adapter, calls } = load();
  await adapter.readSourcePage({ source: "project", cursor: null, projectId: "project/1", accountKey: "account-1" });
  const url = new URL(calls[0].url, "https://chatgpt.com");
  assert.equal(url.pathname, "/backend-api/gizmos/project%2F1/conversations");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Accept, "application/json");
  assert.equal(calls[0].options.headers["chatgpt-account-id"], "account-1");
  assert.equal(calls[0].options.headers["chatgpt-project-id"], "project/1");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  await assert.rejects(adapter.readSourcePage({ source: "ordinary", accountKey: "wrong-account" }), categorized("ACCOUNT_MISMATCH"));
  assert.equal(calls.length, 1, "wrong-account source discovery must fail before network dispatch");

  let currentAccount = "account-1";
  const changed = load({
    loadSession: async () => ({ activeAccountId: currentAccount }),
    fetchAuthenticated: async () => ({ ok: true, status: 200, json: async () => {
      currentAccount = "account-2";
      return { items: [{ id: "foreign-conversation" }], total: 1 };
    } }),
  });
  await assert.rejects(changed.adapter.readSourcePage({ source: "ordinary", accountKey: "account-1" }), categorized("ACCOUNT_MISMATCH"));
});

test("directory timeout bounds both authentication and JSON body reads, not only fetch", async () => {
  for (const stage of ["authentication", "body"]) {
    let expire;
    let timeoutMs;
    let cleared = false;
    const { adapter, calls } = load({
      loadSession: stage === "authentication" ? () => new Promise(() => {}) : undefined,
      fetchAuthenticated: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }),
      globals: {
        setTimeout(callback, delay) { expire = callback; timeoutMs = delay; return 17; },
        clearTimeout(id) { assert.equal(id, 17); cleared = true; },
      },
    });
    const request = adapter.readSourcePage({ source: "ordinary", accountKey: "account-1" });
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    assert.equal(timeoutMs, 20_000);
    assert.equal(calls.length, stage === "body" ? 1 : 0);
    const rejected = assert.rejects(request, categorized("TIMEOUT", { retryable: true, status: null }));
    expire();
    await rejected;
    assert.equal(cleared, true);
    if (stage === "body") assert.equal(calls[0].options.signal.aborted, true);
  }
});

test("directory HTTP errors keep status/retryability and malformed JSON or collections fail closed", async () => {
  for (const fixture of [
    { status: 429, code: "HTTP", retryable: true, serverCode: "rate_limit", canRetry: true },
    { status: 404, code: "INACCESSIBLE", retryable: false, serverCode: "conversation_inaccessible", canRetry: false },
    { status: 503, code: "HTTP", retryable: false, serverCode: "upstream_error", canRetry: false },
  ]) {
    const { adapter } = load({ fetchAuthenticated: async () => response({
      detail: { code: fixture.serverCode, can_retry: fixture.canRetry },
    }, fixture.status) });
    await assert.rejects(adapter.readSourcePage({ source: "ordinary", accountKey: "account-1" }), categorized(fixture.code, {
      status: fixture.status, retryable: fixture.retryable, serverCode: fixture.serverCode,
    }));
  }
  const badJson = load({ fetchAuthenticated: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("invalid JSON"); } }) });
  await assert.rejects(badJson.adapter.readSourcePage({ source: "ordinary" }), categorized("SCHEMA", { retryable: false }));
  const badCollection = load({ fetchAuthenticated: async () => response({ unexpected: [] }) });
  // A changed native collection is a structured failure, never an exhausted
  // empty catalog that would silently suppress discovery.
  await assert.rejects(badCollection.adapter.readSourcePage({ source: "ordinary" }),
    categorized("SCHEMA", { retryable: false }));
});
