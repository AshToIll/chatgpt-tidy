const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
require("../src/platform/protocol.js");
const protocol = globalThis.TidyProtocol;
const source = fs.readFileSync(path.join(__dirname, "../src/app/background/handlers/titles.js"), "utf8")
  .replace(/^import[^;]+;\r?\n/gm, "")
  .replace("export function createTitlesHandler", "function createTitlesHandler");
const plain = value => JSON.parse(JSON.stringify(value));
const panel = { url: "chrome-extension://tidy/app/sidepanel/index.html?tidyTabId=9" };
const payload = { expectedTabId: 9, expectedConversationId: "owner" };
const expectedTypes = [
  "TITLE_RULES_GET", "TITLE_RULES_UPDATE", "TITLE_RETURN_OWNER",
  "TITLE_BATCH_PREVIEW", "TITLE_BATCH_REPLAN", "TITLE_BATCH_RETRY_PREVIEW", "TITLE_BATCH_APPLY",
  "TITLE_BATCH_STEP", "TITLE_BATCH_STATUS", "TITLE_BATCH_RECONCILE",
  "TITLE_PREVIEW", "TITLE_REPLAN", "TITLE_APPLY", "TITLE_STATUS", "TITLE_RECONCILE",
].map(name => protocol.Type[name]);

async function harness() {
  const { parseConversationRoute } = await import("../src/platform/navigation/conversation-route.js");
  const { isValidTabId } = await import("../src/platform/navigation/panel-owner.js");
  const calls = { rules: [], bound: [], snapshots: [], gateway: [], current: [], batch: [], update: [], catalog: [] };
  const factories = [];
  const tab = { id: 9, url: "https://chatgpt.com/c/owner" };
  const rows = new Map([["a", { conversationId: "a", title: "A" }], ["b", { conversationId: "b", title: "B" }]]);
  const binding = {
    isSidePanelDocumentUrl: url => url === panel.url,
    getBoundTab: async (id, sender) => { calls.bound.push({ id, sender }); return tab; },
  };
  const pageGateway = {
    snapshot: async (owner, options) => { calls.snapshots.push({ owner, options }); return { snapshot: { owner: owner.id } }; },
  };
  const gateway = {
    context: (owner, snapshot, id) => ({ tabId: owner.id, ...parseConversationRoute(owner.url), conversationId: id, targetProjectId: null }),
    request: async (...args) => { calls.gateway.push(args); return { ok: true }; },
  };
  const chrome = { tabs: { update: async (...args) => calls.update.push(args) } };
  const catalog = {
    read: async selection => { calls.catalog.push(["read", selection]); return rows; },
    getRow: async (accountKey, id) => { calls.catalog.push(["row", accountKey, id]); return rows.get(id); },
    observeTitles: async (...args) => calls.catalog.push(["observe", ...args]),
    acceptTitles: async (...args) => calls.catalog.push(["accept", ...args]),
  };
  const context = vm.createContext({
    TidyProtocol: protocol, TidyTitleDates: {}, parseConversationRoute, isValidTabId,
    libraryError: message => Object.assign(new Error(message), { tidyCode: "CONTEXT_MISMATCH" }),
    getTitleRules: async () => { calls.rules.push("get"); return { mode: "created" }; },
    updateTitleRules: async patch => { calls.rules.push(patch); return patch; },
    createTitleGateway: dependencies => {
      assert.equal(dependencies.chrome, chrome); assert.equal(dependencies.pageGateway, pageGateway); return gateway;
    },
    createTitleService: options => {
      factories.push({ kind: "current", options });
      return { handle: async (...args) => { calls.current.push(args); return { kind: "current" }; } };
    },
    createTitleBatchService: options => {
      factories.push({ kind: "batch", options });
      return { handle: async (...args) => { calls.batch.push(args); return { kind: "batch" }; } };
    },
  });
  vm.runInContext(source + "\nglobalThis.factory = createTitlesHandler;", context);
  const handler = context.factory({ chrome, binding, pageGateway, catalog });
  const invoke = (type, value = payload, sender = panel) => handler.handle({ envelope: { type: protocol.Type[type] || type, payload: value }, sender });
  return { handler, invoke, calls, factories, tab, rows };
}

test("title handler exposes only an immutable explicit request list and handle", async () => {
  const h = await harness();
  assert.deepEqual(Object.keys(h.handler).sort(), ["handle", "types"]);
  assert.equal(Object.isFrozen(h.handler), true);
  assert.equal(Object.isFrozen(h.handler.types), true);
  assert.deepEqual([...h.handler.types].sort(), expectedTypes.sort());
  assert.equal(new Set(h.handler.types).size, expectedTypes.length);
  assert.deepEqual(h.factories, []);
});

test("local rules and return-owner do not instantiate title services or read the page", async () => {
  const h = await harness();
  assert.deepEqual(await h.invoke("TITLE_RULES_GET"), { mode: "created" });
  const rules = { mode: "range", dateFormat: "dot" };
  assert.equal(await h.invoke("TITLE_RULES_UPDATE", rules), rules);
  assert.deepEqual(plain(await h.invoke("TITLE_RETURN_OWNER", { expectedTabId: 9, pathname: "/c/owner" })), { navigated: true });
  assert.deepEqual(plain(h.calls.update), [[9, { url: "https://chatgpt.com/c/owner" }]]);
  assert.deepEqual(h.factories, []);
  assert.deepEqual(h.calls.snapshots, []);
  assert.deepEqual(h.calls.catalog, []);
});

test("rules and return-owner reject unrelated senders and non-canonical saved routes", async () => {
  const h = await harness();
  for (const type of ["TITLE_RULES_GET", "TITLE_RULES_UPDATE", "TITLE_RETURN_OWNER"]) {
    await assert.rejects(h.invoke(type, { ...payload, pathname: "/c/owner" }, { tab: { id: 9 }, url: "https://chatgpt.com/c/owner" }),
      error => error.tidyCode === "CONTEXT_MISMATCH");
  }
  for (const pathname of ["https://chatgpt.com/c/owner", "/c/owner/", "/c/owner?x=1", "/not-a-conversation"]) {
    await assert.rejects(h.invoke("TITLE_RETURN_OWNER", { ...payload, pathname }), error => error.tidyCode === "CONTEXT_MISMATCH");
  }
  assert.deepEqual(h.calls.bound, []);
  assert.deepEqual(h.calls.update, []);
});

test("all batch commands preserve exact actions and local route-only dispatch", async () => {
  const h = await harness();
  const actions = { TITLE_BATCH_PREVIEW: "preview", TITLE_BATCH_REPLAN: "replan", TITLE_BATCH_RETRY_PREVIEW: "retry-preview",
    TITLE_BATCH_APPLY: "apply", TITLE_BATCH_STEP: "step", TITLE_BATCH_STATUS: "status", TITLE_BATCH_RECONCILE: "reconcile" };
  for (const type of Object.keys(actions)) await h.invoke(type);
  assert.deepEqual(h.calls.batch.map(call => call[0]), Object.values(actions));
  for (const call of h.calls.batch) {
    assert.deepEqual(plain(call[1]), { tabId: 9, conversationId: "owner", pathname: "/c/owner", projectId: null, targetProjectId: null });
    assert.equal(call[2], payload);
  }
  assert.deepEqual(h.factories.map(entry => entry.kind), ["current", "batch"]);
  assert.deepEqual(h.calls.snapshots, []);
  assert.deepEqual(h.calls.gateway, []);
});

test("current replan is local while preview/apply/status/reconcile retain owner snapshot checks", async () => {
  const h = await harness();
  await h.invoke("TITLE_REPLAN");
  assert.deepEqual(h.calls.snapshots, []);
  const actions = { TITLE_PREVIEW: "preview", TITLE_APPLY: "apply", TITLE_STATUS: "status", TITLE_RECONCILE: "reconcile" };
  for (const type of Object.keys(actions)) await h.invoke(type);
  assert.deepEqual(h.calls.current.map(call => call[0]), ["replan", ...Object.values(actions)]);
  assert.equal(h.calls.snapshots.length, 4);
  for (const call of h.calls.snapshots) assert.deepEqual(plain(call.options), { scope: "title-owner" });
  assert.deepEqual(h.factories.map(entry => entry.kind), ["current"]);
});

test("current and batch actions reject missing owner claims before lazy initialization", async () => {
  const h = await harness();
  for (const type of ["TITLE_PREVIEW", "TITLE_REPLAN", "TITLE_BATCH_PREVIEW"]) {
    for (const value of [{}, { ...payload, expectedTabId: -1 }, { ...payload, expectedConversationId: "" }]) {
      await assert.rejects(h.invoke(type, value), error => error.tidyCode === "INVALID_REQUEST");
    }
    await assert.rejects(h.invoke(type, payload, { url: "https://chatgpt.com/c/owner" }), error => error.tidyCode === "INVALID_REQUEST");
  }
  assert.deepEqual(h.calls.bound, []);
  assert.deepEqual(h.factories, []);
});

test("replan and batch commands fail closed after a native route changes", async () => {
  const h = await harness();
  h.tab.url = "https://chatgpt.com/c/other";
  await assert.rejects(h.invoke("TITLE_REPLAN"), error => error.tidyCode === "CONTEXT_MISMATCH");
  await assert.rejects(h.invoke("TITLE_BATCH_PREVIEW"), error => error.tidyCode === "CONTEXT_MISMATCH");
  assert.deepEqual(h.factories, []);
  assert.deepEqual(h.calls.snapshots, []);
});

test("unknown commands cannot reach unrelated worker state or title services", async () => {
  const h = await harness();
  for (const type of ["TITLE_FUTURE_WRITE", "NAVIGATION_CANCELLED", "SEARCH_MESSAGES"]) {
    await assert.rejects(h.invoke(type), error => error.tidyCode === protocol.ErrorCode.UNSUPPORTED_TYPE);
  }
  assert.deepEqual(h.factories, []);
  assert.deepEqual(h.calls.bound, []);
});

test("verified and accepted titles use only adapter-proven catalog keys and exact projections", async () => {
  const h = await harness();
  await h.invoke("TITLE_REPLAN");
  const options = h.factories[0].options;
  const current = { conversationId: "a", title: "Verified", createdAt: "2026-09-29T00:00:00Z" };
  await options.onVerified({}, { catalogAccountKey: "directory", current });
  await options.onAccepted({}, { catalogAccountKey: "directory", accepted: { conversationId: "a", title: "Accepted", secret: "not persisted" } });
  assert.deepEqual(plain(h.calls.catalog), [
    ["observe", "directory", [current]],
    ["accept", "directory", [{ conversationId: "a", title: "Accepted" }]],
  ]);
  const context = { tabId: 9, conversationId: "owner" }, plan = { after: "X" }, checkpoint = () => {};
  await options.read(context, { fresh: true });
  await options.write(context, plan, checkpoint);
  assert.equal(h.calls.gateway[0][1], protocol.Type.TITLE_READ_CURRENT);
  assert.equal(h.calls.gateway[1][1], protocol.Type.TITLE_WRITE_CURRENT);
  assert.equal(h.calls.gateway[1][2], plan);
  assert.equal(h.calls.gateway[1][3], checkpoint);
});

test("batch selection validates membership locally and refresh-only reads exact affected keys", async () => {
  const h = await harness();
  await h.invoke("TITLE_BATCH_PREVIEW");
  const options = h.factories.find(entry => entry.kind === "batch").options;
  const selection = { accountKey: "directory", conversationIds: ["b", "a"] };
  assert.deepEqual(plain(await options.resolveSelection({}, selection)), { accountKey: "directory", rows: [h.rows.get("b"), h.rows.get("a")] });
  assert.deepEqual(plain(h.calls.catalog), [["read", selection]]);
  h.calls.catalog.length = 0;
  await options.resolveSelection({}, { ...selection, refreshOnly: true });
  assert.deepEqual(plain(h.calls.catalog), [["row", "directory", "b"], ["row", "directory", "a"]]);
  h.calls.catalog.length = 0;
  for (const invalid of [
    { ...selection, conversationIds: [] }, { ...selection, conversationIds: ["a", "a"] },
    { ...selection, conversationIds: ["bad/id"] }, { ...selection, accountKey: " " },
  ]) await assert.rejects(options.resolveSelection({}, invalid), error => error.tidyCode === "INVALID_REQUEST");
  assert.deepEqual(h.calls.catalog, []);
});

test("batch execution lease retains catalog account, identity, and exact scope", async () => {
  const h = await harness();
  await h.invoke("TITLE_BATCH_PREVIEW");
  const options = h.factories.find(entry => entry.kind === "batch").options;
  const context = { tabId: 9 }, identity = { accountKey: "account", workspaceKey: "workspace" };
  await options.beginExecution(context, { scopeId: "scope-1", catalogAccountKey: "directory", identity });
  await options.endExecution(context, "scope-1");
  assert.deepEqual(plain(h.calls.gateway), [
    [context, protocol.Type.TITLE_BATCH_EXECUTION_BEGIN, { batchScopeId: "scope-1", identity, expectedCatalogAccountKey: "directory" }],
    [context, protocol.Type.TITLE_BATCH_EXECUTION_END, { batchScopeId: "scope-1" }],
  ]);
});
