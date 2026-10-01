const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createPanelRuntime } = require("./helpers/panel-runtime.cjs");

const root = path.resolve(__dirname, "..");
const panelSource = fs.readFileSync(path.join(root, "src/app/sidepanel/panel.js"), "utf8");
const libraryPanelSource = fs.readFileSync(path.join(root, "src/app/sidepanel/library-panel-controller.js"), "utf8");

// Only the composition root's thin wiring is evaluated here. All state owners
// and their dependency graphs come from complete production factory modules.
function wiring(start, end) {
  const first = panelSource.indexOf(start);
  const last = panelSource.indexOf(end, first);
  assert.notEqual(first, -1, `panel wiring remains explicit: ${start}`);
  assert.ok(last > first, `panel wiring boundary remains explicit: ${end}`);
  return panelSource.slice(first, last);
}
const initSource = wiring("async function init()", "void init().catch");
const admissionSource = wiring("function handlePageSession(", "function syncRouteActivity(");

function element() {
  return { dataset: {}, children: [], hidden: false, textContent: "", setAttribute() {}, addEventListener() {},
    classList: { contains: () => false },
    replaceChildren(...children) { this.children = children; },
    get childElementCount() { return this.children.length; },
    get firstElementChild() { return this.children[0] || null; },
  };
}

async function createHarness(failingType) {
  const calls = [];
  const runtime = createPanelRuntime({ navigator: { language: "zh-CN" } });
  runtime.load("src/platform/protocol.js");
  runtime.load("src/platform/library/library-hydration.js");
  const { DEFAULT_PREFERENCES, normalizePreferences } = runtime.load("src/platform/preferences/preferences.js");
  const { createPreferenceController } = runtime.load("src/platform/preferences/preference-controller.js");
  const { createLibraryController } = runtime.load("src/platform/library/ui/library-controller.js");
  const { createPageSessionController } = runtime.load("src/platform/session/ui/page-session-controller.js");
  const { createPanelContextController } = runtime.load("src/app/sidepanel/context-controller.js");
  const { createLibraryPanelController } = runtime.load("src/app/sidepanel/library-panel-controller.js");
  const { createShellPresentation } = runtime.load("src/app/sidepanel/shell-presentation.js");
  const protocol = runtime.context.TidyProtocol;
  const { Type } = protocol;
  const fallbackPreferences = { ...DEFAULT_PREFERENCES };
  const loadedPreferences = normalizePreferences({ language: "en" });
  const favorites = { accountKey: "account-a", items: {}, groups: [], view: {} };
  const bookmarks = {
    accountKey: "account-a",
    items: {
      "bookmark-1": { conversationId: "conversation-1" },
      "bookmark-2": { conversationId: "conversation-1" },
    },
    groups: [], view: {},
  };
  const state = { route: "time", preferences: fallbackPreferences,
    pageSession: { phase: "connecting", generation: 0, documentId: null } };
  const sendRequest = async (type, payload = null) => {
    calls.push(type === Type.GET_ACTIVE_CONTEXT ? "context:start" : `load:${type}`);
    if (type === Type.GET_ACTIVE_CONTEXT) calls.push(`context:owner:${payload?.expectedTabId}`);
    if (type === Type.LIBRARY_GET) {
      return { accountKey: "account-a", identity: { documentId: "document", epoch: 0 },
        favorites: failingType === Type.FAVORITES_GET ? null : favorites,
        bookmarks: failingType === Type.BOOKMARKS_GET ? null : bookmarks,
        errors: {
          favorites: failingType === Type.FAVORITES_GET ? { code: "PERSISTENCE_REJECTED" } : null,
          bookmarks: failingType === Type.BOOKMARKS_GET ? { code: "PERSISTENCE_REJECTED" } : null,
        } };
    }
    if (type === failingType) throw Object.assign(new Error(`${type} failed`), { code: "PERSISTENCE_REJECTED" });
    if (type === Type.GET_ACTIVE_CONTEXT) return {
      tab: { id: 73 }, snapshot: { route: { pathname: "/c/conversation-1" },
        conversation: { conversationId: "conversation-1" } },
    };
    if (type === Type.PREFERENCES_GET) return loadedPreferences;
    throw new Error(`Unexpected request ${type}`);
  };
  const noop = () => {};
  const filing = Object.fromEntries(["favorites", "bookmarks"].map(kind => [kind, {
    sync: noop, connect: () => calls.push(`connect:${kind}`),
  }]));
  const shell = createShellPresentation({ elements: {}, translate: key => key,
    document: { createElement: element }, window: {}, hydration: runtime.context.TidyLibraryHydration,
    errorCode: protocol.ErrorCode });
  const globals = runtime.context;
  Object.assign(globals, {
    state, protocol, panelOwnerTabId: 73, sendRequest,
    createPreferenceController, createLibraryController, createPageSessionController, createPanelContextController,
    featureClients: { library: () => sendRequest(Type.LIBRARY_GET) },
    client: { transmit: async () => { calls.push("probe:ready"); return { ready: true, documentId: "document" }; } },
    document: { hidden: false }, elements: { close: {} }, filing, shell,
    createTranslator: () => key => key,
    isValidTabId: tabId => Number.isInteger(tabId) && tabId >= 0,
    panelContext: { routeKey: tabId => `${tabId}|route` },
    titleRulesController: { suspend: noop, resume: noop },
    timeView: { setAvailable: noop }, titleView: { update: noop },
    titleCatalog: { pause: noop }, conversationDateSearch: { pause: noop },
    backupView: { setActive: noop, update: noop },
    panelNavigation: { close: noop },
    navigationResults: { clear: noop, flush: noop },
    bookmarkNavigation: { acceptsSnapshot: () => false, cancel: noop },
    searchView: {
      setTabId: tabId => calls.push(`search:set-tab:${tabId}`),
      setConversationId: id => calls.push(`search:set-conversation:${id}`),
      setVisible: noop, setActive: noop,
    },
    dismissToast: noop, syncRouteActivity: noop, syncExportContext: noop, mountDiagnostics: noop,
    renderAll: () => calls.push("render:all"), renderPreview: () => calls.push("render:preview"),
    renderPageConnection: noop, renderExport: () => calls.push("render:export"),
    renderTitles: () => calls.push("render:titles"),
    renderPreferenceNotice: () => calls.push("render:preference-notice"),
    renderExportDockBadge: noop,
  });
  vm.runInContext("let mounted = false; let preferenceError = null; let t = key => key;", globals);
  vm.runInContext(wiring("function applyPreferences(", "function savePreference(")
    + wiring("function moduleError(", "function invalidateContext("), globals);
  vm.runInContext(wiring("const preferenceController =", "const titleRulesController ="), globals);
  vm.runInContext(wiring("const library = createLibraryController(", "globalThis.TidyLibraryDiagnostics"), globals);
  const library = vm.runInContext("library", globals);
  const libraryPanel = createLibraryPanelController({
    ownerTabId: 73, readLibrary: library.getState, readPresentation: () => ({}), readRoute: () => state.route,
    isReady: () => state.pageSession.phase === "ready", selectionState: () => null, refreshLibrary: library.refresh, navigate: noop,
    views: Object.fromEntries(["favorites", "bookmarks"].map(kind => [kind, {
      root: element(), reset: noop, render: () => calls.push(`render:${kind}`),
    }])),
    navigation: { pendingConversationId: () => null, pendingBookmarkId: () => null, cancel: noop },
    presentation: shell, filing: { favorites: filing.favorites.sync, bookmarks: filing.bookmarks.sync },
    onChanged: () => globals.renderLibraryViews(),
  });
  globals.libraryPanel = libraryPanel;
  // Context settlement now renders only library views, using the real narrow adapter.
  vm.runInContext(wiring("function renderLibraryViews()", "function renderSourceViews()"), globals);
  vm.runInContext("const isReady = () => pageSession.isReady(); const readSnapshot = () => context.get().snapshot;", globals);
  // Keep the production context callback (including title/search notification)
  // and admission ordering, rather than re-creating those decisions in tests.
  vm.runInContext(wiring("const context = createPanelContextController(", "const pageSession ="), globals);
  vm.runInContext(admissionSource + initSource, globals);
  vm.runInContext(wiring("const pageSession = createPageSessionController(", "// 只有生命周期转换"), globals);
  const owners = vm.runInContext("({ context, pageSession, init, errors: () => ({ preferences: preferenceError, ...library.getState().errors }) })", globals);
  return { ...owners, library, libraryPanel, bookmarks, calls, fallbackPreferences, favorites, loadedPreferences, state, Type };
}

async function settleDetachedLoaders() {
  await new Promise(resolve => setImmediate(resolve));
}

test("Side Panel waits for page admission before context/library, without awaiting optional preferences", async () => {
  const harness = await createHarness(null);
  await harness.init();
  await settleDetachedLoaders();

  const contextStart = harness.calls.indexOf("context:start");
  assert.notEqual(contextStart, -1);
  assert.ok(harness.calls.indexOf("probe:ready") < contextStart);
  assert.ok(contextStart < harness.calls.indexOf(`load:${harness.Type.LIBRARY_GET}`));
  assert.ok(harness.calls.includes("context:owner:73"));
  assert.ok(harness.calls.includes("search:set-tab:73"));
  assert.ok(harness.calls.includes("render:titles"), "The title view receives the independently loaded context");
  assert.deepEqual(harness.state.preferences, harness.loadedPreferences);
  assert.equal(harness.library.getState().favorites, harness.favorites);
  assert.equal(harness.library.getState().bookmarks, harness.bookmarks);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.libraryPanel.get().bookmarkCounts)), { "conversation-1": 2 });
});

for (const failure of ["preferences.get", "favorites.get", "bookmarks.get"]) {
  test(`${failure} failure is isolated from search context and sibling modules`, async () => {
    const harness = await createHarness(failure);
    await assert.doesNotReject(() => harness.init());
    await settleDetachedLoaders();

    assert.ok(harness.calls.includes("context:owner:73"));
    assert.ok(harness.calls.includes("search:set-tab:73"));
    assert.ok(harness.calls.includes("render:titles"), "Optional storage failure does not block title context rendering");
    const failedModule = failure.split(".")[0];
    assert.equal(harness.errors()[failedModule].code, "PERSISTENCE_REJECTED");
    for (const sibling of ["preferences", "favorites", "bookmarks"].filter(name => name !== failedModule)) {
      assert.equal(harness.errors()[sibling], null);
    }
    if (failure === harness.Type.PREFERENCES_GET) {
      assert.equal(harness.state.preferences, harness.fallbackPreferences);
      assert.ok(harness.calls.includes("render:preference-notice"));
    } else assert.deepEqual(harness.state.preferences, harness.loadedPreferences);
    assert.equal(harness.library.getState().favorites, failure === harness.Type.FAVORITES_GET ? null : harness.favorites);
    assert.equal(harness.library.getState().bookmarks, failure === harness.Type.BOOKMARKS_GET ? null : harness.bookmarks);
  });
}

test("panel source keeps defaults and does not restore all-or-nothing initialization", () => {
  assert.match(panelSource, /preferences:\s*\{\s*\.\.\.DEFAULT_PREFERENCES\s*\}/);
  assert.doesNotMatch(initSource + admissionSource, /Promise\.all\s*\(/);
  // Per-module error rendering moved to its actual owner, not shell mirrors.
  assert.match(libraryPanelSource, /model\.errors\.favorites[\s\S]{0,180}error\("favorites", model\.errors\.favorites\)/);
  assert.match(libraryPanelSource, /model\.errors\.bookmarks[\s\S]{0,180}error\("bookmarks", model\.errors\.bookmarks\)/);
});

test("an invalidated Side Panel tells the user to reopen instead of retrying", () => {
  const runtime = createPanelRuntime();
  runtime.load("src/platform/protocol.js");
  runtime.load("src/platform/library/library-hydration.js");
  const { createShellPresentation } = runtime.load("src/app/sidepanel/shell-presentation.js");
  const status = element();
  const shell = createShellPresentation({ elements: { status }, document: { createElement: element },
    window: {}, translate: key => key, hydration: runtime.context.TidyLibraryHydration,
    errorCode: runtime.context.TidyProtocol.ErrorCode });
  function presented(error) {
    shell.renderContextStatus({ route: "time", error, hasSnapshot: false, refreshRequired: false });
    return { messageKey: status.children[0]?.textContent,
      retryable: status.children.some(child => Object.hasOwn(child.dataset, "retryContext")) };
  }
  const invalidated = presented({ code: "ADAPTER_UNAVAILABLE",
    details: { stage: "sidepanel.runtime-send-message", disconnect: "context-invalidated" } });
  const pageBridge = presented({ code: "ADAPTER_UNAVAILABLE",
    details: { stage: "service-worker.snapshot-send-message", disconnect: "receiver-missing" } });
  assert.deepEqual(invalidated, { messageKey: "reopenTidyPanel", retryable: false });
  assert.deepEqual(pageBridge, { messageKey: "refreshChatgptPage", retryable: false });
});

test("a snapshot failure preserves the immutable owner for recovery", async () => {
  const harness = await createHarness("snapshot.get-active-context");
  await harness.init();
  await assert.doesNotReject(() => harness.context.refresh());
  assert.equal(harness.context.get().snapshot, null);
  assert.equal(harness.context.get().error.code, "PERSISTENCE_REJECTED");
  assert.ok(harness.calls.includes("context:owner:73"));
  assert.ok(harness.calls.includes("search:set-tab:73"));
  assert.ok(harness.calls.includes("render:titles"), "The title view is notified when the snapshot becomes unavailable");
});
