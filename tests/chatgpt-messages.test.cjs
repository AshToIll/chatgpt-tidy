const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { installPageSession } = require("./helpers/page-session.cjs");

const root = path.resolve(__dirname, "..");
const readerPath = "src/platform/chatgpt/messages.js";
const dateIndexPath = "src/platform/catalog/chatgpt/date-index.js";

function run(context, file) {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
}

function nativeMessage(id, overrides = {}) {
  return {
    id, author: { role: "user" }, create_time: 1_700_000_001.25,
    update_time: 1_900_000_000, content: { content_type: "text", parts: ["message content"] },
    ...overrides,
  };
}

const CATALOG_URL = "/backend-api/conversations?offset=0&limit=28";
function nativeCatalog(overrides = {}) {
  return { items: [{ id: "conversation-1", title: "Conversation title", create_time: 1_700_000_001.25 }], total: 1, ...overrides };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function load({ session, fetchAuthenticated, globals = {}, withAdapter = false, realApi = false } = {}) {
  const calls = [];
  const context = vm.createContext({
    console, Date, Intl, URL, URLSearchParams, Headers, AbortController,
    setTimeout, clearTimeout, encodeURIComponent,
    TidyChatgptApi: {
      loadSession: async () => session || { activeAccountId: "account-1", user: { id: "user-1" } },
      fetchAuthenticated: async (url, options) => {
        calls.push({ url, options });
        return fetchAuthenticated ? fetchAuthenticated(url, options) : response(nativeCatalog());
      },
    },
    ...globals,
  });
  context.globalThis = context;
  installPageSession(context);
  // Stub transport only. Identity tests must use the same pure projection as
  // production, rather than copying account-key precedence into the fixture.
  const apiStub = realApi ? null : context.TidyChatgptApi;
  delete context.TidyChatgptApi;
  run(context, "src/platform/chatgpt/api.js");
  if (apiStub) context.TidyChatgptApi = { ...context.TidyChatgptApi, ...apiStub };
  run(context, readerPath);
  if (withAdapter) {
    run(context, "src/platform/catalog/date-search.js");
    run(context, dateIndexPath);
  }
  return { context, calls, reader: context.TidyChatgptMessages, adapter: context.TidyChatgptDateIndex };
}

function categorized(category, expected = {}) {
  return (error) => {
    assert.equal(error.name, "MessageReadError");
    assert.equal(error.category, category);
    assert.equal(error.code, category);
    for (const [key, value] of Object.entries(expected)) assert.equal(error[key], value, key);
    return true;
  };
}

test("directory reader preserves the source payload and its authenticated GET headers", async () => {
  const payload = nativeCatalog({ items: [
    { id: "newer", title: "Newer", create_time: 1_700_000_100.125 },
    { id: "older", title: "Older", create_time: null },
  ] });
  const { reader, calls } = load({ fetchAuthenticated: async () => response(payload) });
  const result = await reader.readJson(CATALOG_URL, { accountKey: "account-1", projectId: "project-1" });
  assert.strictEqual(result, payload, "directory shape validation belongs to date-index, not the transport");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CATALOG_URL);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers["chatgpt-account-id"], "account-1");
  assert.equal(calls[0].options.headers["chatgpt-project-id"], "project-1");
});

test("directory reader uses existing authenticated API helper including its 401 refresh", async () => {
  let sessions = 0;
  let pageCalls = 0;
  const calls = [];
  const { reader } = load({ realApi: true, globals: {
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url === "/api/auth/session") {
        sessions += 1;
        return response({ active_account_id: "account-1", accessToken: `test-token-${sessions}` });
      }
      pageCalls += 1;
      return pageCalls === 1 ? response({}, 401) : response(nativeCatalog());
    },
  } });
  await reader.readJson(CATALOG_URL, { accountKey: "account-1", projectId: "project-1" });
  assert.equal(sessions, 2);
  assert.equal(pageCalls, 2);
  const pages = calls.filter((call) => call.url.startsWith("/backend-api/"));
  assert.equal(pages[0].options.headers.get("Authorization"), "Bearer test-token-1");
  assert.equal(pages[1].options.headers.get("Authorization"), "Bearer test-token-2");
  assert.equal(pages[1].options.headers.get("chatgpt-account-id"), "account-1");
  assert.equal(pages[1].options.headers.get("chatgpt-project-id"), "project-1");
  assert.equal(pages[1].options.credentials, "include");
});

test("user identity isolates caches but is never sent as the account header", async () => {
  const { reader, calls } = load({ session: { user: { id: "user-1" } } });
  const identity = await reader.account();
  assert.equal(identity.accountKey, "user-1");
  assert.equal(identity.accountId, null);
  await reader.readJson(CATALOG_URL, { accountKey: "user-1" });
  assert.equal(calls[0].options.headers["chatgpt-account-id"], undefined);
});

test("missing catalog identity remains the directory reader's SCHEMA error without I/O", async () => {
  const { reader, calls } = load({ session: { activeAccountId: " ", active_account_id: 1, account: {}, user: {} } });
  await assert.rejects(reader.account(), categorized("SCHEMA", { retryable: false }));
  await assert.rejects(reader.readJson(CATALOG_URL), categorized("SCHEMA", { retryable: false }));
  assert.equal(calls.length, 0);
});

test("account mismatches fail before issuing a directory request", async () => {
  const { reader, calls } = load();
  await assert.rejects(reader.readJson(CATALOG_URL, { accountKey: "other-account" }),
    categorized("ACCOUNT_MISMATCH", { retryable: false }));
  assert.equal(calls.length, 0);
});

test("account changes during auth refresh do not publish another account's response", async () => {
  let sessions = 0;
  let pages = 0;
  const { reader } = load({ realApi: true, globals: {
    fetch: async (url) => {
      if (url === "/api/auth/session") {
        sessions += 1;
        return response({ account: { id: `account-${sessions}` }, accessToken: "test-token" });
      }
      pages += 1;
      return pages === 1 ? response({}, 401) : response(nativeCatalog());
    },
  } });
  await assert.rejects(reader.readJson(CATALOG_URL, { accountKey: "account-1" }),
    categorized("ACCOUNT_MISMATCH"));
});

test("HTTP and inaccessible errors retain status, server code and explicit can_retry", async () => {
  for (const [status, detail, category, retryable] of [
    [404, { code: "conversation_inaccessible", can_retry: false }, "INACCESSIBLE", false],
    [403, { code: "permission_denied", can_retry: true }, "INACCESSIBLE", true],
    [429, { code: "rate_limit" }, "HTTP", true],
    [500, { code: "server_error", can_retry: false }, "HTTP", false],
    [422, { code: "invalid_cursor" }, "HTTP", false],
  ]) {
    const { reader } = load({ fetchAuthenticated: async () => response({ detail }, status) });
    await assert.rejects(reader.readJson(CATALOG_URL),
      categorized(category, { status, retryable, serverCode: detail.code }));
  }
});

test("non-JSON HTTP error bodies keep the HTTP status classification", async () => {
  const { reader } = load({ fetchAuthenticated: async () => ({
    ok: false, status: 502, json: async () => { throw new SyntaxError("HTML body"); },
  }) });
  await assert.rejects(reader.readJson(CATALOG_URL),
    categorized("HTTP", { status: 502, retryable: true }));
});

test("network failures are distinguishable from malformed success JSON", async () => {
  const network = load({ fetchAuthenticated: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(network.reader.readJson(CATALOG_URL),
    categorized("NETWORK", { status: null, retryable: true }));
  const schema = load({ fetchAuthenticated: async () => ({
    ok: true, status: 200, json: async () => { throw new SyntaxError("bad JSON"); },
  }) });
  await assert.rejects(schema.reader.readJson(CATALOG_URL),
    categorized("SCHEMA", { retryable: false }));
});

test("untyped authentication and helper errors retain uncertainty without invented HTTP details", async () => {
  const auth = load({ globals: { TidyChatgptApi: {
    loadSession: async () => { throw new Error("session failed"); },
    fetchAuthenticated: async () => { throw new Error("must not fetch"); },
  } } });
  await assert.rejects(auth.reader.readJson(CATALOG_URL),
    categorized("AUTH", { status: null, serverCode: null, retryable: true }));
  const unknown = load({ fetchAuthenticated: async () => { throw new Error("untyped helper rejection"); } });
  await assert.rejects(unknown.reader.readJson(CATALOG_URL),
    categorized("UNKNOWN", { status: null, serverCode: null, retryable: true }));
});

test("directory transport rejects non-backend paths without sending requests", async () => {
  const { reader, calls } = load();
  for (const input of [null, [], {}, "", "/api/auth/session", "https://example.com/backend-api/conversations"]) {
    await assert.rejects(reader.readJson(input), categorized("SCHEMA"));
  }
  assert.equal(calls.length, 0);
});

test("the 20-second directory timeout covers stalled session, fetch, and JSON body", async () => {
  const never = () => new Promise(() => {});
  for (const stage of ["session", "fetch", "body"]) {
    let timeoutCallback;
    let cleared = false;
    let signal;
    const { reader } = load({ globals: {
      setTimeout(callback, milliseconds) {
        assert.equal(milliseconds, 20_000);
        timeoutCallback = callback;
        return 1;
      },
      clearTimeout() { cleared = true; },
      TidyChatgptApi: {
        loadSession: stage === "session" ? never : async () => ({ activeAccountId: "account-1" }),
        fetchAuthenticated: async (_url, options) => {
          signal = options.signal;
          return stage === "fetch" ? never() : { ok: true, json: never };
        },
      },
    } });
    const promise = reader.readJson(CATALOG_URL);
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    timeoutCallback();
    await assert.rejects(promise, categorized("TIMEOUT", { retryable: true }));
    assert.equal(cleared, true);
    if (signal) assert.equal(signal.aborted, true);
  }
});

test("mounted message projection preserves text and real timestamps without network reads", () => {
  const { reader, calls } = load();
  const messages = [
    nativeMessage("user", { create_time: 1_700_000_100.25, content: { content_type: "text", parts: ["alpha", { text: "beta" }] } }),
    nativeMessage("assistant", { author: { role: "assistant" }, channel: "final", create_time: 1_600_000_000,
      content: { content_type: "code", text: "actual source code" } }),
    nativeMessage("tool", { author: { role: "tool" } }),
    nativeMessage("system", { author: { role: "system" } }),
    nativeMessage("thought", { author: { role: "assistant" }, channel: "analysis" }),
    nativeMessage("reasoning", { author: { role: "assistant" }, metadata: { reasoning_status: "is_reasoning" } }),
    nativeMessage("hidden", { metadata: { is_visually_hidden_from_conversation: true } }),
    nativeMessage("context", { content: { content_type: "user_editable_context" } }),
    nativeMessage("missing", { create_time: null }),
    nativeMessage("boolean", { create_time: false }),
    nativeMessage("string", { create_time: "2026-09-05" }),
  ].map(reader.visibleMessage).filter(Boolean);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    { messageId: "user", timestampMs: 1_700_000_100_250, text: "alpha\nbeta" },
    { messageId: "assistant", timestampMs: 1_600_000_000_000, text: "actual source code" },
    { messageId: "missing", timestampMs: null, text: "message content" },
    { messageId: "boolean", timestampMs: null, text: "message content" },
    { messageId: "string", timestampMs: null, text: "message content" },
  ]);
  assert.equal(calls.length, 0);
});

test("mounted visibility rules exclude hidden, reasoning and tool nodes even without timestamps", () => {
  const { reader, calls } = load();
  const messages = [
    nativeMessage("visible-null", { create_time: null }),
    nativeMessage("visible-invalid", { author: { role: "assistant" }, channel: "final", create_time: "invalid" }),
    nativeMessage("hidden-null", { create_time: null, metadata: { is_visually_hidden_from_conversation: true } }),
    nativeMessage("tool-null", { create_time: null, author: { role: "tool" } }),
    nativeMessage("context-null", { create_time: null, content: { content_type: "user_editable_context" } }),
    nativeMessage("reasoning-null", { create_time: null, author: { role: "assistant" }, channel: "analysis" }),
    nativeMessage("visible-timed"),
  ].map(reader.visibleMessage).filter(Boolean);
  assert.equal(messages.filter(message => message.timestampMs === null).length, 2);
  assert.equal(messages.length, 3);
  assert.equal(messages[2].messageId, "visible-timed");
  assert.equal(calls.length, 0);
});

test("source candidates preserve known project context for directory consumers", () => {
  const { adapter } = load({ withAdapter: true });
  const embedded = adapter.normalizeSourceResponse({ items: [
    { gizmo: { gizmo: { id: "project-1", gizmo_type: "snorlax" } },
      conversations: { items: [{ id: "conversation-1", title: "One" }], cursor: null } },
  ], cursor: null }, { source: "projects", cursor: null });
  assert.equal(embedded.conversations[0].projectId, "project-1");
  const project = adapter.normalizeSourceResponse({ items: [{ id: "conversation-2", title: "Two" }] },
    { source: "project", projectId: "project-2", cursor: null });
  assert.equal(project.conversations[0].projectId, "project-2");
  const ordinary = adapter.normalizeSourceResponse({ items: [{ id: "conversation-3", title: "Three", gizmo_id: "custom-gpt-id" }], total: 1 },
    { source: "ordinary", cursor: null });
  assert.equal(ordinary.conversations[0].projectId, null, "array index and custom GPT IDs must never become project IDs");
});
