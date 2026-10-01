const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { installPageSession } = require("./helpers/page-session.cjs");
const { createWorkerModuleLoader } = require("./helpers/worker-runtime.cjs");

const root = path.resolve(__dirname, "..");
const source = (name) => fs.readFileSync(path.join(root, name), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

// Load whole production factories; the fixture supplies only host capabilities.
function installSearchActions(context) {
  const { createSearchActions } = context.modules.load("src/app/sidepanel/search-actions.js");
  context.handleSearchAction = createSearchActions({
    ownerTabId: context.panelOwnerTabId, protocol: context.protocol,
    isReady: () => context.pageSession.isReady(), request: context.sendRequest,
    dateSearch: context.conversationDateSearch, pauseTitleCatalog: () => context.titleCatalog.pause(),
  }).handle;
}

function contracts(globals = {}) {
  // Dispatch/transport seams use the real controller and finish admission
  // before executing business requests; blocked-page behavior has its own suite.
  const context = vm.createContext({ console, Date, Math, URL, setTimeout, clearTimeout, ...globals });
  for (const file of ["src/platform/protocol.js", "src/platform/catalog/date-search.js"]) {
    vm.runInContext(source(file), context, { filename: file });
  }
  context.protocol = context.TidyProtocol;
  context.dateSearchContract = context.TidyDateSearch;
  context.modules = createWorkerModuleLoader(context);
  const { createPageSessionController } = context.modules.load("src/platform/session/ui/page-session-controller.js");
  context.pageSession = createPageSessionController({
    probe: async () => ({ ready: true, documentId: "document-a" }),
  });
  context.pageSessionReady = context.pageSession.check();
  return context;
}

test("panel pure keyword dispatches native search only and returns its untouched page", async () => {
  const page = { items: [{ messageId: "native-hit" }], cursor: "native-next" };
  const calls = [];
  const pauses = [];
  const context = contracts({
    panelOwnerTabId: 31,
    sendRequest: async (type, payload) => { calls.push({ type, payload }); return page; },
    conversationDateSearch: new Proxy({}, { get(_target, key) {
      if (key === "pause") return async (reason) => { pauses.push(reason); };
      throw new Error("keyword touched date reads");
    } }),
  });
  await context.pageSessionReady;
  installSearchActions(context);
  assert.equal(await context.handleSearchAction("query", { mode: "keyword", query: "needle", hasDate: true, startMs: 100 }), page);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "search.messages");
  assert.equal(calls[0].payload.expectedTabId, 31);
  assert.equal(calls[0].payload.hasDate, undefined);
  assert.equal(calls[0].payload.startMs, undefined, "date fields cannot create a combined keyword path");
  assert.deepEqual(pauses, ["keyword-query"], "keyword only pauses local scheduling, without reading messages");
  assert.doesNotMatch(source("src/app/sidepanel/search-actions.js"), /enrichKeywordPage|date-progressive-scan|date-prefilter|date-search-service\.js/);
});

test("panel date mode uses metadata service and never dispatches keyword/message requests", async () => {
  const filtered = { items: [{ conversationId: "metadata-only", messageId: null }] };
  const payload = { mode: "date", query: "", dateField: "createdAt", startMs: 100, endMs: 200 };
  const context = contracts({
    panelOwnerTabId: 31,
    titleCatalog: { pause: async () => {} },
    sendRequest: async () => { throw new Error("date mode called keyword/history"); },
    conversationDateSearch: { queryDate: async (criteria) => {
      assert.equal(criteria, payload);
      return filtered;
    } },
  });
  await context.pageSessionReady;
  installSearchActions(context);
  assert.equal(await context.handleSearchAction("query", payload), filtered);
});

test("late native keyword results and retired expansion actions cannot trigger history reads", async () => {
  let resolveSearch;
  const calls = [];
  const native = new Promise((resolve) => { resolveSearch = resolve; });
  const context = contracts({
    panelOwnerTabId: 31, sendRequest: (type) => { calls.push(type); return native; },
    conversationDateSearch: { pause: async () => {} },
  });
  await context.pageSessionReady;
  installSearchActions(context);
  const oldQuery = context.handleSearchAction("query", { mode: "keyword", query: "needle" });
  await context.handleSearchAction("pause", { reason: "date-changed" });
  resolveSearch({ items: [{ conversationId: "late" }] });
  const result = await oldQuery;
  assert.deepEqual(calls, ["search.messages"]);
  assert.equal(result.items.length, 1, "view generation owns discarding stale native results");
  await context.handleSearchAction("expand", { query: "needle", conversationId: "selected", sessionId: "s" });
  assert.deepEqual(calls, ["search.messages"], "no legacy expansion action dispatch exists");
  assert.doesNotMatch(source("src/app/sidepanel/search-actions.js"), /keywordConversationSearch|createKeywordConversationSearch|SEARCH_CONVERSATION_PAGE/);
  await assert.rejects(context.handleSearchAction("query", { query: "needle" }), /explicit search mode/);
});

test("search contracts retire all message-history requests without aliases", () => {
  const { TidyDateSearch: contract, TidyProtocol: protocol } = contracts();
  assert.equal(protocol.Type.DATE_INDEX_CONVERSATION, undefined, "retired full-detail bridge has no alias");
  assert.equal(protocol.Type.DATE_INDEX_CONVERSATION_PAGE, undefined, "retired date message bridge has no alias");
  assert.equal(protocol.Type.SEARCH_CONVERSATION_PAGE, undefined);
  for (const name of ["normalizeConversationRequest", "validateConversation", "validateConversationPage", "timestampMs"]) {
    assert.equal(contract[name], undefined, `retired message-date contract: ${name}`);
  }
  assert.equal(typeof contract.normalizeSourceRequest, "function");
  assert.equal(typeof contract.validateSourcePage, "function");
});

test("typed read errors survive main-world, isolated, worker and panel boundaries", async () => {
  let receiveMain;
  let receiveRuntime;
  const detail = { code: "INACCESSIBLE", category: "INACCESSIBLE", status: 404, retryable: false, serverCode: "conversation_inaccessible" };
  const context = contracts({
    TidySnapshot: {}, TidySearch: {}, TidyExportContract: {},
    document: { documentElement: { dataset: {} } },
    dateIndexAdapter: { readSourcePage: async () => { throw Object.assign(new Error("inaccessible"), detail); } },
  });
  context.window = {
    location: { origin: "https://chatgpt.com" },
    addEventListener: (_type, listener) => { receiveMain = listener; },
    postMessage: ({ envelope }) => { context.dispatchDate(envelope); },
  };
  context.postEnvelope = (envelope) => receiveMain({
    source: context.window, origin: "https://chatgpt.com",
    data: { channel: context.protocol.WINDOW_CHANNEL, source: "chatgpt-main-world", envelope },
  });
  context.chrome = {
    tabs: { sendMessage: (_id, envelope) => new Promise((resolve) => receiveRuntime(envelope, {}, resolve)) },
    runtime: { id: "tidy-test", onMessage: { addListener: (listener) => { receiveRuntime = listener; } } },
  };
  installPageSession(context, { runtime: true });
  context.location = { origin: "https://chatgpt.com" };
  vm.runInContext(source("src/app/page/request-router.js"), context);
  const mainRouter = context.TidyPageRequestRouter.create({
    postEnvelope: context.postEnvelope, dateIndexAdapter: context.dateIndexAdapter,
  });
  const mainWindow = vm.runInContext("globalThis", context);
  context.dispatchDate = (envelope) => mainRouter.handleMessage({
    source: mainWindow, origin: context.location.origin,
    data: { channel: context.protocol.WINDOW_CHANNEL, source: "chatgpt-isolated", envelope },
  });
  vm.runInContext(source("src/app/page/isolated.js"), context);
  const { createSearchGateway } = context.modules.load("src/app/background/adapters/search-gateway.js");
  const history = createSearchGateway({
    binding: { getBoundTab: async id => ({ id, url: "https://chatgpt.com/c/current" }) },
    pageGateway: { send: (...args) => context.chrome.tabs.sendMessage(...args) },
  });
  context.chrome.runtime.sendMessage = async (envelope) => {
    try {
      return context.protocol.response(envelope, await history.readHistory(31, envelope.type, envelope.payload));
    } catch (error) {
      return context.protocol.failure(envelope, error.tidyCode, error.message, error.details || (error.stage ? { stage: error.stage } : null));
    }
  };
  await context.pageSessionReady;
  const { createPanelRequestClient } = context.modules.load("src/app/sidepanel/request-client.js");
  context.sendRequest = createPanelRequestClient({
    runtime: context.chrome.runtime, protocol: context.protocol,
    run: (type, request) => context.pageSession.run(type, request),
  }).send;
  await assert.rejects(context.sendRequest(context.protocol.Type.DATE_INDEX_SOURCE_PAGE, { source: "ordinary" }), (error) => {
    assert.equal(error.code, "DATE_INDEX_UNAVAILABLE");
    assert.deepEqual(plain(error.details), { stage: "main-world.date-index-adapter", ...detail });
    return true;
  });
});

test("partial date results and typed diagnostics use the existing notice instead of silent empty success", () => {
  const view = source("src/features/search/ui/search-query-controller.js");
  assert.match(view, /acceptDateResultStatus\(page\)/);
  assert.match(view, /resultStable: page\.resultStable === true/);
  assert.match(view, /page\.coverageState === "partial"/);
  assert.match(source("src/features/search/ui/search-presentation.js"), /notice\.dataset\.searchReadErrors/);
});
