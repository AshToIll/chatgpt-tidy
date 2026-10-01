const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { installPageSession } = require("./helpers/page-session.cjs");
const { createWorkerModuleLoader } = require("./helpers/worker-runtime.cjs");

const root = path.resolve(__dirname, "..");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");
const PANEL_URL = "chrome-extension://tidy-test/app/sidepanel/index.html";

function nativePage() {
  return {
    items: [
      { id: "native-message", source_type: "conversation", source_key: "conversation", title: "Candidate",
        snippet: "Native preview need not repeat the search term", update_time: 1_700_000_000,
        payload: { kind: "conversation", conversation_id: "conversation-1", message_id: "message-1" } },
      { id: "native-title", source_type: "conversation", source_key: "conversation", title: "needle title",
        snippet: "", update_time: 1_700_000_000,
        payload: { kind: "conversation", conversation_id: "conversation-1" } },
    ],
    cursor: "opaque/+==", partial_results: false,
    source_statuses: [{ source: "conversation", status: "ok", has_more: true }],
  };
}

function load(options = {}) {
  const calls = { tabs: [], probes: [], fetches: [], timers: [], navigation: [], nativeRoutes: [], locates: [] };
  const identity = { accountKey: 'owner', phase: 'ready', documentId: 'document-a', epoch: 1 };
  let receiveMain;
  let receiveRuntime;
  const context = vm.createContext({
    console, Date: options.clock || Date, Math, URL, URLSearchParams, AbortController,
    setTimeout(callback, delay) { const timer = { callback, delay, cleared: false }; calls.timers.push(timer); return timer; },
    clearTimeout(timer) { timer.cleared = true; },
    TidyExportContract: {},
    document: { documentElement: { dataset: {} } },
    libraryDocument: async () => ({ documentId: "document-a" }),
    readLibraryAccount: async () => ({ accountKey: identity.accountKey, identity }),
    readLibraryIdentity: () => identity,
    assertLibraryContext() {},
    // Deliberately unavailable: global-search cannot hydrate a conversation.
    TidyChatgptMessages: new Proxy({}, { get() { throw new Error("Native keyword search touched history messages"); } }),
    TidyChatgptApi: { fetchAuthenticated: async (url, request) => {
      calls.fetches.push({ url, method: request.method, body: JSON.parse(request.body) });
      if (options.fail) throw new Error("Native global search failed");
      return { ok: true, json: async () => nativePage() };
    } },
    dateIndexAdapter: new Proxy({}, { get() { throw new Error("Native keyword search called the date adapter"); } }),
    requestTabMessageLocation: async (...args) => { calls.locates.push(args); return { located: false }; },
  });
  // One VM hosts both transport sides; both still use the real session gate.
  context.chrome = { runtime: { id: "tidy-test" } };
  installPageSession(context, { runtime: true });
  for (const file of ["src/platform/protocol.js", "src/platform/navigation/navigation-identity.js", "src/features/search/model/search.js", "src/platform/catalog/date-search.js", "src/features/search/chatgpt/search.js"]) {
    vm.runInContext(source(file), context, { filename: file });
  }
  context.protocol = context.TidyProtocol;
  context.navigationIdentity = context.TidyNavigationIdentity;
  context.searchContract = context.TidySearch;
  context.searchAdapter = context.TidyChatgptSearch;
  context.dateSearchContract = context.TidyDateSearch;
  context.window = {
    location: { origin: "https://chatgpt.com" },
    addEventListener: (_type, listener) => { receiveMain = listener; },
    postMessage: ({ envelope }) => { if (!options.stall) context.dispatchNativeSearch(envelope); },
  };
  context.postEnvelope = (envelope) => {
    const outgoing = options.mutateResponse ? options.mutateResponse(envelope) : envelope;
    receiveMain({ source: context.window, origin: "https://chatgpt.com",
      data: { channel: context.protocol.WINDOW_CHANNEL, source: "chatgpt-main-world", envelope: outgoing } });
  };
  context.chrome = {
    runtime: Object.assign(context.chrome.runtime, {
      getURL: (value = "") => `chrome-extension://tidy-test/${String(value).replace(/^\//, "")}`,
      onMessage: { addListener: (listener) => { receiveRuntime = listener; } },
    }),
    sidePanel: { getOptions: async ({ tabId }) => ({ enabled: true, path: `app/sidepanel/index.html?tidyTabId=${tabId}` }) },
    tabs: {
      get: async (id) => { calls.tabs.push(id); return { id, url: "https://chatgpt.com/c/current" }; },
      sendMessage: (_id, envelope) => new Promise((resolve) => receiveRuntime(envelope, {}, resolve)),
      update: async (id, update) => { calls.navigation.push({ id, ...update }); },
    },
    webNavigation: { getFrame: async () => ({ documentId: "document-a", documentLifecycle: "active", url: "https://chatgpt.com/c/current" }) },
  };

  // Full production factories own dispatch and admission; only Chrome and the
  // authenticated HTTP transport are synthetic. No entrypoint source slices.
  context.location = { origin: "https://chatgpt.com" };
  vm.runInContext(source("src/app/page/request-router.js"), context);
  const mainRouter = context.TidyPageRequestRouter.create({
    postEnvelope: context.postEnvelope, searchAdapter: context.searchAdapter,
    dateIndexAdapter: context.dateIndexAdapter,
  });
  const mainWindow = vm.runInContext("globalThis", context);
  context.dispatchNativeSearch = envelope => mainRouter.handleMessage({
    source: mainWindow, origin: context.location.origin,
    data: { channel: context.protocol.WINDOW_CHANNEL, source: "chatgpt-isolated", envelope },
  });
  vm.runInContext(source("src/platform/snapshot.js"), context);
  vm.runInContext(source("src/app/page/isolated.js"), context);
  const modules = createWorkerModuleLoader(context);
  const { createRequestBinding, isChatgptUrl } = modules.load("src/platform/session/background/request-binding.js");
  const binding = createRequestBinding({ chrome: context.chrome, libraryIdentity: {
    readAccount: context.readLibraryAccount,
  } });
  const { createPageGateway } = modules.load("src/platform/session/background/page-gateway.js");
  const pageGateway = createPageGateway({ chrome: context.chrome });
  const { createPageSession } = modules.load("src/platform/session/background/page-session.js");
  const pageSession = createPageSession({ chrome: context.chrome, isChatgptUrl });
  const { createWorkerNavigation } = modules.load("src/platform/navigation/background/worker-navigation.js");
  const navigation = createWorkerNavigation({ chrome: context.chrome, allocateNavigationEpoch: async () => 1,
    navigationSenderTab: binding.navigationSenderTab, getBoundTab: binding.getBoundTab,
    libraryDocument: context.libraryDocument, readLibraryAccount: context.readLibraryAccount,
    readLibraryIdentity: context.readLibraryIdentity, assertLibraryContext: context.assertLibraryContext,
    requestTabMessageLocation: context.requestTabMessageLocation, searchContract: context.searchContract });
  const { createSearchGateway } = modules.load("src/app/background/adapters/search-gateway.js");
  const { createSearchHandler } = modules.load("src/app/background/handlers/search.js");
  const { createNavigationHandler } = modules.load("src/app/background/handlers/navigation.js");
  const { createRequestRouter } = modules.load("src/app/background/request-router.js");
  context.handleRequest = createRequestRouter({ binding, pageSession, navigation,
    handlers: [createSearchHandler({ search: createSearchGateway({ binding, pageGateway }) }),
      createNavigationHandler({ navigation })],
  }).handle;

  const originalSend = context.chrome.tabs.sendMessage;
  context.chrome.tabs.sendMessage = async (id, envelope, target) => envelope.type === "page-session.probe"
    ? (calls.probes.push({ id, target }), context.protocol.response(envelope, { ready: true })) : envelope.type === "navigation.intent"
    ? context.protocol.response(envelope, { accepted: true }) : envelope.type === 'library.navigate'
      ? (calls.nativeRoutes.push({ id, ...envelope.payload }), context.protocol.response(envelope, { navigated: true, reason: 'native-router',
        ...(envelope.payload.placement === 'native-search' ? { presentationOwner: 'native' } : {}) }))
      : originalSend(id, envelope, target);
  const sender = { url: `${PANEL_URL}?tidyTabId=31` };
  const payload = { expectedTabId: 31, query: "needle", cursor: null, sessionId: "native-session", limit: 15 };
  return {
    context, calls, payload, sender,
    request: (value = payload, owner = sender) => context.handleRequest(
      context.protocol.request(context.protocol.Type.SEARCH_MESSAGES, value), owner,
    ),
    receiveRuntime: (...args) => receiveRuntime(...args),
  };
}

test("keyword bridge calls native global search exactly once per page without any message reads", async () => {
  const harness = load();
  const page = await harness.request();
  assert.equal(page.items.length, 2, "native-qualified snippet and title-only hits both survive");
  assert.equal(page.items[0].messageId, "message-1");
  assert.equal(page.items[1].messageId, null);
  assert.equal(page.cursor, "opaque/+==");
  assert.equal(harness.calls.fetches.length, 1);
  assert.equal(harness.calls.fetches[0].url, "/backend-api/global/search");
  assert.equal(harness.calls.fetches[0].method, "POST");
  await harness.request({ ...harness.payload, cursor: page.cursor });
  assert.equal(harness.calls.fetches.length, 2);
  assert.equal(harness.calls.fetches[1].body.cursor, "opaque/+==");
  assert.deepEqual(harness.calls.tabs, [31, 31, 31, 31], "each command checks admission and then resolves the same bound tab");
  assert.deepEqual(harness.calls.probes.map(call => call.id), [31, 31]);
  assert.ok(harness.calls.probes.every(call => call.target.documentId === "document-a"));
  assert.deepEqual(harness.calls.timers.map((timer) => timer.delay), [60_000, 60_000]);
  assert.ok(harness.calls.timers.every((timer) => timer.cleared));
});

test("a conflicting panel owner fails before the native search request", async () => {
  const harness = load();
  await assert.rejects(harness.request(harness.payload, { url: `${PANEL_URL}?tidyTabId=32` }),
    (error) => error.tidyCode === "TAB_UNAVAILABLE");
  assert.deepEqual(harness.calls.tabs, [], "a conflicting owner is rejected even before session admission");
  await assert.rejects(harness.request({ ...harness.payload, query: "" }),
    (error) => error.tidyCode === "INVALID_REQUEST");
  assert.deepEqual(harness.calls.tabs, [31], "the empty query reaches only the read-only session handshake");
  assert.deepEqual(harness.calls.fetches, []);
});

test("native search failure and malformed pages fail instead of becoming an empty success", async () => {
  for (const options of [{ fail: true }, { mutateResponse: (envelope) => ({ ...envelope, payload: { items: [] } }) }]) {
    const harness = load(options);
    await assert.rejects(harness.request(), (error) => error.tidyCode === "SEARCH_UNAVAILABLE");
    assert.equal(harness.calls.fetches.length, 1);
  }
});

test("native search bridge preserves its bounded 60-second deadline", async () => {
  const harness = load({ stall: true });
  const request = harness.request();
  const rejection = assert.rejects(request, (error) => error.tidyCode === "SEARCH_UNAVAILABLE");
  for (let turn = 0; turn < 30 && !harness.calls.timers.length; turn += 1) await Promise.resolve();
  assert.equal(harness.calls.timers.length, 1);
  assert.equal(harness.calls.timers[0].delay, 60_000);
  harness.calls.timers[0].callback();
  await rejection;
});

test("retired keyword message pages have no protocol, contract, adapter or live bridge", async () => {
  const harness = load();
  assert.equal(harness.context.protocol.Type.SEARCH_CONVERSATION_PAGE, undefined);
  assert.equal(harness.context.searchContract.normalizeConversationRequest, undefined);
  assert.equal(harness.context.searchContract.validateConversationPage, undefined);
  assert.equal(harness.context.searchAdapter.readConversationPage, undefined);
  for (const type of ["search.conversation-page", "date-index.conversation-page"]) {
    const retired = harness.context.protocol.request(type, {});
    assert.equal(harness.receiveRuntime(retired, {}, () => { throw new Error("retired bridge replied"); }), false);
    await assert.rejects(harness.context.handleRequest(retired, harness.sender),
      (error) => error.tidyCode === "UNSUPPORTED_TYPE");
  }
  for (const file of ["src/app/page/main-world.js", "src/app/page/request-router.js", "src/app/page/isolated.js",
    "src/app/background/service-worker.js", "src/app/background/request-router.js",
    "src/app/background/handlers/search.js", "src/app/background/adapters/search-gateway.js"]) {
    assert.doesNotMatch(source(file), /SEARCH_CONVERSATION_PAGE|DATE_INDEX_CONVERSATION_PAGE|validateConversationPage|normalizeConversationRequest|\.readConversationPage/);
  }
  assert.deepEqual(harness.calls.tabs, []);
  assert.deepEqual(harness.calls.fetches, []);
});

test("conversation-title navigation accepts messageId null without inventing a target or reading history", async () => {
  const harness = load();
  const result = await harness.context.handleRequest(harness.context.protocol.request(
    harness.context.protocol.Type.SEARCH_OPEN_RESULT,
    { expectedTabId: 31, navigationKind: 'keyword', resultId: "conversation:conversation-1", conversationId: "conversation-1", messageId: null, query: "needle" },
  ), harness.sender);
  assert.equal(result.presentationOwner, 'native');
  assert.equal(result.navigated, true);
  assert.equal(Object.hasOwn(result, 'located'), false);
  assert.equal(harness.calls.navigation.length, 0);
  const route = harness.calls.nativeRoutes[0];
  assert.equal(route.id, 31); assert.equal(route.pathname, '/c/conversation-1');
  assert.equal(route.placement, 'native-search'); assert.equal(route.messageId, null);
  assert.equal(route.query, 'needle');
  assert.deepEqual(harness.calls.fetches, []);
  assert.deepEqual(harness.calls.locates, [], "a title-only hit never invents a message or issues LOCATE");
});

test('native keyword handoff IPC shares the original load deadline plus reply grace, not a fresh four-second budget', async () => {
  const now = 10000;
  const h = load({ stall: true, clock: class extends Date { static now() { return now; } } });
  const request = h.context.protocol.request(h.context.protocol.Type.LIBRARY_NAVIGATE,
    { placement: 'native-search', loadDeadlineAt: 30000 });
  const response = new Promise(resolve => assert.equal(h.receiveRuntime(request, {}, resolve), true));
  assert.equal(h.calls.timers.length, 1);
  assert.equal(h.calls.timers[0].delay, 20000 + h.context.protocol.DEFAULT_TIMEOUT_MS);
  h.calls.timers[0].callback();
  const failed = await response;
  assert.equal(failed.error.code, 'ADAPTER_TIMEOUT');
  assert.equal(failed.error.details.stage, 'content.isolated.request-main-timeout');
});

test('latest and bookmark navigation retain their short acknowledgement IPC window', async () => {
  for (const placement of ['latest', undefined]) {
    const h = load({ stall: true });
    const request = h.context.protocol.request(h.context.protocol.Type.LIBRARY_NAVIGATE,
      { placement, loadDeadlineAt: Date.now() + 30000 });
    const response = new Promise(resolve => assert.equal(h.receiveRuntime(request, {}, resolve), true));
    assert.equal(h.calls.timers[0].delay, h.context.protocol.DEFAULT_TIMEOUT_MS);
    h.calls.timers[0].callback();
    assert.equal((await response).error.code, 'ADAPTER_TIMEOUT');
  }
});
