const assert = require("node:assert/strict");
const test = require("node:test");

async function harness(options = {}) {
  const { createRequestRouter } = await import("../src/app/background/request-router.js");
  const protocol = globalThis.TidyProtocol;
  const calls = [], tab = { id: 4, url: "https://chatgpt.com/c/chat" }, intent = {};
  const owner = { tab, accountKey: "account", identity: { documentId: "doc", epoch: 2 } };
  const binding = {
    isSidePanelDocumentUrl: url => url === "panel",
    getBoundTab: async () => { calls.push("bound"); return tab; },
    libraryContext: async (payload, sender, policy) => { calls.push(["account", policy]); return owner; },
  };
  const pageSession = { assert: async (value, policy) => {
    calls.push(["page", policy]);
    if (options.pageError) throw options.pageError;
    return { ready: true, documentId: "doc" };
  } };
  const navigation = {
    begin: () => { calls.push("begin"); return intent; },
    assertCurrent: value => { assert.equal(value, intent); calls.push("current"); },
    prepare: async (value, target, identity) => { assert.equal(value, intent); calls.push("prepare"); },
    fail: value => { assert.equal(value, intent); calls.push("fail"); },
  };
  const handler = { types: Object.values(protocol.Type), handle: async context => {
    calls.push(["handle", context]); return { handled: context.envelope.type };
  } };
  const router = createRequestRouter({ binding, pageSession, navigation,
    panelHost: { open: id => { calls.push(["open", id]); return Promise.resolve(); } }, handlers: [handler] });
  return { router, protocol, calls, owner, intent };
}

test("router rejects malformed batch selection before tab, account or handler work", async () => {
  const h = await harness();
  await assert.rejects(h.router.handle(h.protocol.request(h.protocol.Type.EXPORT_CONVERSATIONS,
    { expectedTabId: 4, conversationIds: [] }), { url: "panel" }), { tidyCode: "INVALID_REQUEST" });
  assert.deepEqual(h.calls, []);
});

test("backup and export jobs reject non-panel senders before page admission", async () => {
  for (const name of ["LIBRARY_BACKUP_RESTORE", "EXPORT_JOB_START", "EXPORT_JOB_CANCEL"]) {
    const h = await harness();
    await assert.rejects(h.router.handle(h.protocol.request(h.protocol.Type[name], {}), { url: "https://chatgpt.com/" }),
      { tidyCode: "CONTEXT_MISMATCH" });
    assert.deepEqual(h.calls, []);
  }
});

test("unknown names never inherit admission or action permissions", async () => {
  const h = await harness();
  await assert.rejects(h.router.handle({ type: "favorites.future", payload: {} }, { url: "panel" }),
    { tidyCode: "UNSUPPORTED_TYPE" });
  assert.deepEqual(h.calls, []);
});

test("probe verifies the requesting document but never reads an account or dispatches a feature", async () => {
  const h = await harness();
  const result = await h.router.handle(h.protocol.request(h.protocol.Type.PAGE_SESSION_PROBE, { expectedTabId: 4 }),
    { tab: { id: 4 }, documentId: "doc" });
  assert.deepEqual(result, { ready: true, documentId: "doc" });
  assert.deepEqual(h.calls, ["bound", ["page", { expectedDocumentId: "doc" }]]);
});

test("page failure retires the exact navigation and stops before account or feature work", async () => {
  const error = Object.assign(new Error("not ready"), { tidyCode: "ADAPTER_UNAVAILABLE" });
  const h = await harness({ pageError: error });
  await assert.rejects(h.router.handle(h.protocol.request(h.protocol.Type.FAVORITES_OPEN, { expectedTabId: 4 }),
    { url: "panel" }), value => value === error);
  assert.deepEqual(h.calls, ["begin", "bound", ["page", { expectedDocumentId: null }], "fail"]);
});

test("bookmark count consumes the click gesture before any page or account await", async () => {
  const h = await harness();
  await h.router.handle(h.protocol.request(h.protocol.Type.BOOKMARKS_OPEN_CONVERSATION_VIEW, { expectedTabId: 4 }),
    { tab: { id: 4, url: "https://chatgpt.com/c/chat" }, documentId: "doc" });
  assert.deepEqual(h.calls.slice(0, 4), ["begin", ["open", 4], "current", "bound"]);
  assert.deepEqual(h.calls.find(value => Array.isArray(value) && value[0] === "account")[1],
    { requireExpected: true, requireIdentity: true, retryIdentity: false });
  const request = h.calls.at(-1)[1];
  assert.equal(request.libraryOwner, h.owner);
  assert.equal(request.libraryOwner.navigationHandle, h.intent);
  assert.equal(h.calls.at(-2), "prepare");
});

test("library retry is an explicit panel-only read capability", async () => {
  for (const [sender, retry] of [[{ url: "panel" }, true], [{ tab: { id: 4 } }, false]]) {
    const h = await harness();
    await h.router.handle(h.protocol.request(h.protocol.Type.LIBRARY_GET, { expectedTabId: 4, retryIdentity: true }), sender);
    assert.deepEqual(h.calls.find(value => Array.isArray(value) && value[0] === "account")[1],
      { requireExpected: false, requireIdentity: false, retryIdentity: retry });
  }
});

test("cancel controls skip page readiness but retain their original account owner check", async () => {
  const h = await harness();
  await h.router.handle(h.protocol.request(h.protocol.Type.EXPORT_JOB_CANCEL, { id: "job" }), { url: "panel" });
  assert.equal(h.calls[0][0], "account");
  assert.deepEqual(h.calls[0][1], { requireExpected: true, requireIdentity: false, retryIdentity: false });
  assert.equal(h.calls[1][0], "handle");
});

test("composition rejects duplicate protocol owners rather than shadowing a feature", async () => {
  const { createRequestRouter } = await import("../src/app/background/request-router.js");
  assert.throws(() => createRequestRouter({ binding: {}, handlers: [
    { types: ["same"], handle() {} }, { types: ["same"], handle() {} },
  ] }), /Duplicate background request owner/);
});
