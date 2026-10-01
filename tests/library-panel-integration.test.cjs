const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const { snapshotHarness } = require("./helpers/adapter-snapshot.cjs");
const { createPanelRuntime } = require("./helpers/panel-runtime.cjs");
const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let index = 0; index < 5; index++) await new Promise(setImmediate); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

// These two narrow delegates still belong to the composition root, not a
// feature owner. Execute their exact source with explicit real-owner bindings,
// so a broken tab filter or document gate cannot be masked by test wiring.
function panelDelegate(context, pattern, bindings) {
  const matches = [...fs.readFileSync("src/app/sidepanel/panel.js", "utf8").matchAll(pattern)];
  assert.equal(matches.length, 1, "Expected exactly one production composition delegate");
  const names = Object.keys(bindings).join(",");
  return vm.runInContext("(({" + names + "}) => (" + matches[0][1] + "))", context)(bindings);
}

// The real list patcher runs against a small DOM boundary. Markup is represented
// by text nodes: no browser layout is needed, but production cached view models
// and their later local render callbacks must still obey ownership revocation.
function node(document, type = 1, value = "") {
  const handlers = new Map();
  const result = {
    ownerDocument: document, nodeType: type, nodeName: type === 3 ? "#text" : "DIV",
    nodeValue: type === 3 ? value : null, dataset: {}, handlers, childNodes: [], parentNode: null,
    className: "", _text: "",
    addEventListener: (name, handler) => handlers.set(name, handler),
    removeEventListener: (name, handler) => { if (handlers.get(name) === handler) handlers.delete(name); },
    querySelector: () => null, querySelectorAll: () => [], contains: () => false,
    setAttribute() {}, getAttribute: () => null,
    append(...children) { for (const child of children) { child.remove(); child.parentNode = this; this.childNodes.push(child); } },
    insertBefore(child, before) { child.remove(); child.parentNode = this; const index = this.childNodes.indexOf(before); if (index < 0) this.childNodes.push(child); else this.childNodes.splice(index, 0, child); },
    replaceChildren(...children) { for (const child of this.childNodes) child.parentNode = null; this.childNodes = []; this._text = ""; this.append(...children); },
    remove() { if (!this.parentNode) return; const siblings = this.parentNode.childNodes; siblings.splice(siblings.indexOf(this), 1); this.parentNode = null; },
    replaceWith(other) { const parent = this.parentNode; parent.insertBefore(other, this); this.remove(); },
    cloneNode() { return node(document, this.nodeType, this.nodeValue); },
  };
  result.classList = { contains: name => result.className.split(/\s+/).includes(name) };
  Object.defineProperties(result, {
    firstChild: { get: () => result.childNodes[0] || null },
    lastChild: { get: () => result.childNodes.at(-1) || null },
    firstElementChild: { get: () => result.childNodes.find(child => child.nodeType === 1) || null },
    childElementCount: { get: () => result.childNodes.filter(child => child.nodeType === 1).length },
    previousSibling: { get: () => result.parentNode?.childNodes[result.parentNode.childNodes.indexOf(result) - 1] || null },
    nextSibling: { get: () => result.parentNode?.childNodes[result.parentNode.childNodes.indexOf(result) + 1] || null },
    textContent: { get: () => result.nodeType === 3 ? result.nodeValue : result._text + result.childNodes.map(child => child.textContent).join(""), set(value) { result.replaceChildren(); result._text = String(value); } },
    innerHTML: { configurable: true, get: () => result.textContent, set(value) { result.replaceChildren(node(document, 3, value)); } },
  });
  return result;
}

// Real module graph and public owner capabilities replace legacy panel slices.
// Only transport, browser inputs and an already-admitted session are fixtures;
// no writable duplicate of account, snapshot, target-gate or selection exists.
function harness() {
  const requests = [], toasts = [], frames = [], animationFrames = [], timers = [], resize = [], exportFrames = [];
  const windowEvents = new Map(), documentEvents = new Map();
  let clock = 0, nextTimerId = 0, route = "time";
  let libraryResponse = null, contextResponse = null, actionResponse = null;
  const preferences = { language: "en", timeZone: "UTC", timeDisplayEnabled: false };
  const document = { hidden: false, getElementById: () => null,
    addEventListener: (name, handler) => documentEvents.set(name, handler),
    removeEventListener: name => documentEvents.delete(name),
    createElement(name) {
      const element = node(document);
      if (name === "template") {
        element.content = node(document);
        Object.defineProperty(element, "innerHTML", { set(value) { element.content.innerHTML = value; } });
      }
      return element;
    },
  };
  const window = {
    addEventListener(name, handler) { windowEvents.set(name, handler); if (name === "resize") resize.push(handler); },
    removeEventListener: name => windowEvents.delete(name),
  };
  const runtime = createPanelRuntime({ document, window,
    Date: class extends Date { static now() { return clock; } },
    requestAnimationFrame: callback => animationFrames.push(callback),
    setTimeout(callback, delay) { const timer = { id: ++nextTimerId, at: clock + delay, callback }; timers.push(timer); return timer.id; },
    clearTimeout(id) { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1); },
  });
  const context = runtime.context;
  for (const file of ["src/platform/protocol.js", "src/platform/library/library-hydration.js", "src/platform/snapshot.js",
    "src/platform/time-format.js", "src/platform/ui/context-state.js"]) runtime.load(file);
  const protocol = context.TidyProtocol, panelContext = context.TidyPanelContext;
  const { normalizeFavoritesState } = runtime.load("src/features/favorites/storage/favorites-domain.js");
  const { normalizeBookmarksState, bookmarkKey } = runtime.load("src/features/bookmarks/storage/bookmarks-domain.js");
  const { createFavoritesView } = runtime.load("src/features/favorites/ui/favorites-view.js");
  const { createBookmarksView } = runtime.load("src/features/bookmarks/ui/bookmarks-view.js");
  const { createLibraryController } = runtime.load("src/platform/library/ui/library-controller.js");
  const { createPanelNavigationOwner } = runtime.load("src/platform/navigation/ui/navigation-owner.js");
  const { createBookmarkNavigation } = runtime.load("src/features/bookmarks/ui/bookmark-navigation.js");
  const { createPanelContextController } = runtime.load("src/app/sidepanel/context-controller.js");
  const { createPanelNavigationCoordinator } = runtime.load("src/app/sidepanel/navigation-coordinator.js");
  const { createLibraryPanelController } = runtime.load("src/app/sidepanel/library-panel-controller.js");
  const { createShellPresentation } = runtime.load("src/app/sidepanel/shell-presentation.js");
  const { createFavoritesActions } = runtime.load("src/features/favorites/ui/favorites-actions.js");
  const { createBookmarksActions } = runtime.load("src/features/bookmarks/ui/bookmarks-actions.js");
  const { installPanelLifecycle } = runtime.load("src/app/sidepanel/panel-lifecycle.js");
  const favoritesRoot = node(document), bookmarksRoot = node(document);
  const request = async (type, payload) => {
    requests.push({ type, payload: payload && plain(payload) });
    if (type === protocol.Type.LIBRARY_GET) return libraryResponse;
    if (type === protocol.Type.GET_ACTIVE_CONTEXT) return contextResponse;
    if (type === protocol.Type.NAVIGATION_CANCELLED) return { cancelled: true };
    const value = await (typeof actionResponse === "function" ? actionResponse(type, payload) : actionResponse);
    return type === protocol.Type.BOOKMARKS_OPEN && value?.navigation
      ? { ...value, navigation: { navigationIntentId: payload.navigationIntentId, ...value.navigation } } : value;
  };
  const toast = (message, error = false) => toasts.push({ message, error });
  const isReady = () => true;
  let libraryPanel, favoriteActions, bookmarkActions;
  const favoritesView = createFavoritesView({ root: favoritesRoot, onAction: (...args) => favoriteActions.handle(...args) });
  const bookmarksView = createBookmarksView({ root: bookmarksRoot, onAction: (...args) => bookmarkActions.handle(...args) });
  const presentation = createShellPresentation({ document, window, elements: { favoritesRoot, bookmarksRoot }, translate: key => key });
  const renderFavorites = () => libraryPanel?.renderFavorites();
  const renderBookmarks = () => { libraryPanel?.renderBookmarks(); frames.push(bookmarksRoot.innerHTML); };
  const renderExport = () => exportFrames.push(library.getState().accountKey);
  const library = createLibraryController({
    request: ({ retryIdentity = false, expectedAccountKey, expectedIdentity } = {}) => request(protocol.Type.LIBRARY_GET,
      { expectedTabId: 31, ...(retryIdentity ? { retryIdentity: true } : {}), ...(expectedIdentity ? { expectedAccountKey, expectedIdentity } : {}) }),
    onChanged: model => libraryPanel.onLibraryChanged(model),
  });
  const panelNavigation = createPanelNavigationOwner({ createId: () => protocol.createRequestId("navigation"),
    cancel: (navigationIntentId, reason) => { void request(protocol.Type.NAVIGATION_CANCELLED, { expectedTabId: 31, navigationIntentId, reason }); },
  });
  const bookmarkNavigation = createBookmarkNavigation({
    createIntentId: () => panelNavigation.begin("bookmarks"), isActive: () => route === "bookmarks" && !document.hidden,
    isOwnerCurrent: library.isCurrent, isIntentCurrent: panelNavigation.isCurrent,
    getBookmark: id => library.getState().bookmarks?.items?.[id],
    open(target, owner) {
      panelNavigation.setTarget(target.navigationIntentId, target);
      return request(protocol.Type.BOOKMARKS_OPEN, { navigationIntentId: target.navigationIntentId, bookmarkId: target.bookmarkId,
        expectedTabId: 31, expectedAccountKey: owner.accountKey, expectedIdentity: owner.identity });
    },
    onCancel(target, reason) { panelNavigation.cancel(target.navigationIntentId, reason); renderBookmarks(); },
    onSelected: id => libraryPanel.selected(id),
    onResult(result) { renderBookmarks(); toast(result.located ? "bookmarkLocated"
      : result.error?.code === protocol.ErrorCode.CONTEXT_MISMATCH ? "contextChanged"
        : result.reason === "open-failed" ? "bookmarkOpenFailed" : "bookmarkLocateFallback", !result.located); },
  });
  const contextController = createPanelContextController({ ownerTabId: 31, isReady, isValidTabId: Number.isInteger,
    routeKey: panelContext.routeKey, request, contextType: protocol.Type.GET_ACTIVE_CONTEXT, errorCodes: protocol.ErrorCode,
    acceptsSnapshot: bookmarkNavigation.acceptsSnapshot, onRequestedRoute: payload => libraryPanel.requestRoute(payload),
    onChanged(_model, reason) {
      // Match the composition boundary: a pending read only updates shell status;
      // private source views render after the requested-route gate is installed.
      if (reason === "loading" || reason === "suspended") return;
      libraryPanel?.reconcileContext(); renderFavorites(); renderBookmarks(); renderExport();
    },
  });
  function setRoute(next) {
    // This is an external shell input. The real owner commands make cancellation
    // and selection decisions; the fixture only notifies their consumers.
    route = next; panelNavigation.leave(route);
    if (route !== "bookmarks") bookmarkNavigation.cancel();
    renderExport(); renderFavorites(); renderBookmarks();
  }
  libraryPanel = createLibraryPanelController({ ownerTabId: 31, readLibrary: library.getState,
    readPresentation: () => ({ snapshot: contextController.get().snapshot, preferences, t: key => key }),
    readRoute: () => route, isReady,
    views: { favorites: { root: favoritesRoot, ...favoritesView }, bookmarks: { root: bookmarksRoot, ...bookmarksView } },
    navigation: bookmarkNavigation, presentation, selectionState: () => ({ active: false }),
    filing: { favorites() {}, bookmarks() {} }, refreshLibrary: library.refresh, navigate: setRoute,
    onChanged() { renderExport(); renderFavorites(); renderBookmarks(); },
  });
  const sharedActions = { ownerTabId: 31, isReady, captureOwner: library.capture, isOwnerCurrent: library.isCurrent,
    refresh: library.refresh, request, toast };
  favoriteActions = createFavoritesActions({ ...sharedActions, acceptMutation: (owner, result) => library.acceptMutation(owner, "favorites", result),
    readCurrentConversation: () => { const conversationId = contextController.get().snapshot?.conversation?.conversationId;
      return { conversationId, isFavorite: Boolean(library.getState().favorites?.items?.[conversationId]) }; },
    beginNavigation: target => panelNavigation.begin("favorites", target), isNavigationCurrent: panelNavigation.isCurrent,
    isNavigationCompleted: panelNavigation.isCompleted,
  });
  bookmarkActions = createBookmarksActions({ ...sharedActions, acceptMutation: (owner, result) => library.acceptMutation(owner, "bookmarks", result),
    readCurrentConversationId: () => contextController.get().snapshot?.conversation?.conversationId, startNavigation: bookmarkNavigation.start,
  });
  const navigationCoordinator = createPanelNavigationCoordinator({ ownerTabId: 31, owner: panelNavigation, phase: () => "ready",
    consumers: { bookmarks: bookmarkNavigation.complete, favorites: () => true },
    onCancelled: ({ navigationIntentId, reason }) => bookmarkNavigation.cancelId(navigationIntentId, reason),
  });
  installPanelLifecycle({ document, window, isReady, getRoute: () => route, getContextError: () => contextController.get().error,
    refreshContext: contextController.refresh, dismissNotice() {},
    session: { check() { throw Error("Unexpected page handshake in library-only fixture"); }, dispose() {} },
    navigation: panelNavigation, bookmarks: bookmarkNavigation, library, search: { setVisible() {} },
    titles: { isBusy: () => false, render() {}, suspend() {}, pauseCatalog() {} }, preferences: { dispose() {} },
    titleRules: { dispose() {} }, time: { becameVisible() {}, dispose() {} }, settings: { dispose() {} }, backup: { dispose() {} },
    filing: { syncFavorites() {}, syncBookmarks() {}, closeFavorites() {}, closeBookmarks() {} },
  });
  // All assertions inspect read-only projections from the production owners.
  const state = {};
  for (const key of ["accountKey", "favorites", "bookmarks", "bookmarkCounts", "activeBookmarkId"]) {
    Object.defineProperty(state, key, { get: () => libraryPanel.get()[key] });
  }
  for (const key of ["snapshot", "routeKey", "error"]) Object.defineProperty(state, key, { get: () => contextController.get()[key] });
  Object.defineProperties(state, {
    route: { get: () => route }, moduleErrors: { get: () => library.getState().errors },
    pendingBookmarkViewTargetId: { get: () => libraryPanel.get().pendingTarget?.conversationId || null },
    pendingBookmarkViewAccountKey: { get: () => libraryPanel.get().pendingTarget?.accountKey || null },
  });
  Object.assign(context, { protocol, panelContext, library, favoritesView, bookmarksView,
    TidyLibraryDiagnostics: { get: library.getDiagnostic }, renderBookmarks, renderFavorites,
    handleFavoriteAction: favoriteActions.handle, handleBookmarkAction: bookmarkActions.handle,
    handleRequestedRoute: libraryPanel.requestRoute, refreshSnapshot: contextController.refresh, setRoute,
    refreshBookmarks: library.refresh, revalidateLibrary: () => library.refresh({ retryIdentity: true }),
  });
  const sessionState = { pageSession: { phase: "ready", documentId: "document" } };
  const session = { check() { throw Error("Unexpected page handshake in library-only fixture"); } };
  const invalidateContext = panelDelegate(context, /^(function invalidateContext\(payload\) \{[\s\S]*?^\})/gm,
    { context: contextController, isReady, state: sessionState, pageSession: session });
  const receiveRuntimeEvent = panelDelegate(context,
    /^chrome\.runtime\.onMessage\.addListener\((envelope => \{[\s\S]*?^\})\);/gm,
    { disposed: false, protocol, isReady, navigationResults: navigationCoordinator,
      panelOwnerTabId: 31, invalidateContext, pageSession: session,
      titleCatalog: { changed() { throw Error("Unexpected title event"); } },
      library, isValidTabId: Number.isInteger, state: sessionState, context: contextController, libraryPanel,
      exportView: { refreshJob() { throw Error("Unexpected export event"); }, handleFullPreviewClosed() { throw Error("Unexpected preview event"); } } });
  function snapshot(id, mounted = false) {
    return snapshotHarness({ url: "https://chatgpt.com/c/" + id,
      messages: mounted ? [{ id: "message", role: "assistant", record: { id: "message", conversation_id: id,
        author: { role: "assistant" }, create_time: 1788220800, content: { content_type: "text", parts: ["Synthetic mounted target"] } } }] : [],
      sidebar: [{ href: "/c/" + id, title: "Title " + id, record: { id, title: "Title " + id, create_time: 1785542400, update_time: 1788220800 } }] });
  }
  function stores(owner = "owner-a", revision = 1) {
    const bookmarks = normalizeBookmarksState({ revision, view: { groupId: "current" }, groups: [],
      items: Object.fromEntries(["chat-a", "chat-b"].map(id => {
        const bookmarkId = bookmarkKey(id, "message");
        return [bookmarkId, { bookmarkId, conversationId: id, routePath: "/c/" + id, messageId: "message", excerpt: owner + " private " + id, conversationTitle: id }];
      })) });
    const favorites = normalizeFavoritesState({ revision, groups: [],
      items: { "chat-a": { conversationId: "chat-a", routePath: "/c/chat-a", title: owner + " private favorite", note: owner + " private note" } } });
    return { accountKey: owner, identity: { documentId: "document", epoch: owner === "owner-b" ? 1 : 0 },
      favorites: { ...favorites, accountKey: owner }, bookmarks: { ...bookmarks, accountKey: owner }, errors: {} };
  }
  async function bind(owner = "owner-a") { libraryResponse = stores(owner); await library.refresh(); }
  return { context, state, requests, toasts, frames, timers, exportFrames, favoritesRoot, bookmarksRoot, stores, snapshot, bind,
    acceptSnapshot(value) { contextController.invalidate({ url: "https://chatgpt.com/c/" + value.conversation?.conversationId }); contextController.acceptSnapshot({ tabId: 31, snapshot: value }); },
    selectBookmark: libraryPanel.selected,
    event(type, payload) {
      // Preserve the original admitted-document fixture contract. Real runtime
      // routing below decides which exact owner may consume the event.
      if (type === protocol.Type.CONTEXT_CHANGED) payload = { documentId: "document", ...payload };
      receiveRuntimeEvent(protocol.event(type, payload));
    },
    focus() { windowEvents.get("focus")?.(); },
    visible(value) { document.hidden = !value; documentEvents.get("visibilitychange")?.(); },
    async advance(ms) {
      const end = clock + ms;
      for (let index = 0; index < 100; index++) {
        timers.sort((left, right) => left.at - right.at);
        if (!timers.length || timers[0].at > end) break;
        const timer = timers.shift(); clock = timer.at; timer.callback(); await flush();
      }
      clock = end; await flush();
    },
    libraryResponse: value => { libraryResponse = value; }, actionResponse: value => { actionResponse = value; },
    contextResponse: value => { contextResponse = value; },
    drainVisualCallbacks() { while (animationFrames.length) animationFrames.shift()(); for (const callback of resize) callback(); },
  };
}

test("B count request never renders A while destination snapshot is pending, including initial requestedRoute", async () => {
  for (const initial of [false, true]) {
    const h = harness(); h.acceptSnapshot(h.snapshot("chat-a")); await h.bind();
    h.context.renderBookmarks(); assert.match(h.bookmarksRoot.innerHTML, /owner-a private chat-a/);
    h.frames.length = 0;
    const route = { tabId: 31, accountKey: "owner-a", route: "bookmarks", conversationId: "chat-b" };
    if (initial) {
      h.contextResponse({ tab: { id: 31 }, snapshot: h.snapshot("chat-a"), requestedRoute: route });
      await h.context.refreshSnapshot();
    } else h.context.handleRequestedRoute(route);
    assert.equal(h.state.pendingBookmarkViewTargetId, "chat-b");
    assert.doesNotMatch(h.bookmarksRoot.innerHTML, /private chat-a|private chat-b|data-bookmark-jump/);
    assert.ok(h.frames.every(value => !value.includes("private chat-a")));
    // An unrelated refresh and the old local render callback cannot revive A.
    await h.bind(); h.context.bookmarksView.render(); h.drainVisualCallbacks();
    assert.doesNotMatch(h.bookmarksRoot.innerHTML, /private chat-a|private chat-b|data-bookmark-jump/);
    h.acceptSnapshot(h.snapshot("chat-b")); h.context.renderBookmarks();
    assert.equal(h.state.pendingBookmarkViewTargetId, null);
    assert.match(h.bookmarksRoot.innerHTML, /owner-a private chat-b/);
    assert.doesNotMatch(h.bookmarksRoot.innerHTML, /owner-a private chat-a/);
  }
});

test("real library error view offers only an effective recovery action", async () => {
  for (const [code, details, expected] of [["ADAPTER_UNAVAILABLE", { stage: "sidepanel.runtime-send-message", disconnect: "context-invalidated" }, "reopenTidyPanel"],
    ["ADAPTER_UNAVAILABLE", { stage: "service-worker.library-account-transport", disconnect: "receiver-missing" }, "refreshChatgptPage"],
    ["ADAPTER_UNAVAILABLE", { stage: "content.library-runtime-send-message", disconnect: "context-invalidated" }, "refreshChatgptPage"],
    ["ADAPTER_UNAVAILABLE", { stage: "sidepanel.runtime-send-message", disconnect: "connection-closed" }, "actionFailedretry"],
    ["LIBRARY_ACCOUNT_UNAVAILABLE", { status: 401 }, "actionFailedretry"], ["ADAPTER_UNAVAILABLE", { status: 503 }, "actionFailedretry"],
    ["STORAGE_ERROR", null, "actionFailedretry"]]) {
    const h = harness(), old = deferred(); h.libraryResponse(old.promise);
    const pending = h.context.library.refresh(); await flush(); old.reject(Object.assign(Error("failed"), { code, details })); await pending;
    assert.equal(h.bookmarksRoot.innerHTML, expected.replace('actionFailed', 'bookmarksReadFailed'));
    assert.equal(h.favoritesRoot.innerHTML, expected.replace('actionFailed', 'favoritesReadFailed'));
    assert.equal(h.toasts.length, 0);
    assert.equal(h.context.TidyLibraryDiagnostics.get().find(e => e.event === "read-failed").error.code, code);
  }
});

test("count-route events from another tab or a known other account do not replace the active target", async () => {
  const h = harness(); h.acceptSnapshot(h.snapshot("chat-a")); await h.bind();
  for (const patch of [{ tabId: 99 }, { accountKey: "owner-b" }, { accountKey: "" }, { accountKey: null }]) {
    h.context.handleRequestedRoute({ tabId: 31, accountKey: "owner-a", route: "bookmarks", conversationId: "chat-b", ...patch });
    assert.equal(h.state.pendingBookmarkViewTargetId, null); assert.equal(h.state.route, "time");
  }
});

test("real panel reload recovery clears the failed module and forwards the exact new ready lease", async () => {
  const h = harness(), old = deferred();
  h.acceptSnapshot(h.snapshot("chat-a")); h.context.setRoute("bookmarks");
  h.libraryResponse(old.promise); const initial = h.context.library.refresh(); await flush();
  const ready = { tabId: 31, documentId: "replacement-document", epoch: 1, phase: "ready", accountKey: "owner-a" };
  h.event("library.identity-changed", ready);
  h.libraryResponse({ ...h.stores(), identity: { documentId: ready.documentId, epoch: ready.epoch } });
  old.reject(Object.assign(Error("old port closed"), { code: "ADAPTER_UNAVAILABLE",
    details: { stage: "service-worker.library-account-transport", disconnect: "connection-closed" } }));
  await initial; await flush();
  const reads = h.requests.filter(r => r.type === "library.get");
  assert.equal(reads.length, 2); assert.deepEqual(reads[1].payload, { expectedTabId: 31, expectedAccountKey: "owner-a",
    expectedIdentity: { documentId: "replacement-document", epoch: 1 } });
  assert.equal(h.state.moduleErrors.bookmarks, undefined);
  assert.match(h.bookmarksRoot.innerHTML, /owner-a private chat-a/);
  assert.doesNotMatch(h.bookmarksRoot.innerHTML, /data-retry-library/);
  assert.equal(h.toasts.length, 0); h.context.library.dispose();
});

test("temporary null ownership keeps a same-account pending target until B is actually bound", async () => {
  const h = harness(); h.acceptSnapshot(h.snapshot("chat-a")); await h.bind();
  h.context.handleRequestedRoute({ tabId: 31, accountKey: "owner-a", route: "bookmarks", conversationId: "chat-b" });
  h.context.library.invalidate();
  assert.equal(h.state.pendingBookmarkViewTargetId, "chat-b"); assert.equal(h.state.pendingBookmarkViewAccountKey, "owner-a");
  await h.bind(); assert.equal(h.state.pendingBookmarkViewTargetId, "chat-b");
  h.acceptSnapshot(h.snapshot("chat-b")); h.context.renderBookmarks();
  assert.equal(h.state.pendingBookmarkViewTargetId, null); assert.equal(h.state.pendingBookmarkViewAccountKey, null);
});

test("a count route discards an earlier in-flight all-bookmarks read before it can expose A under B", async () => {
  const h = harness(); h.acceptSnapshot(h.snapshot("chat-a"));
  const stale = h.stores(); stale.bookmarks.view.groupId = "all";
  h.libraryResponse(stale); await h.context.library.refresh();
  const old = deferred(); h.libraryResponse(old.promise);
  const pendingRead = h.context.library.refresh(); await Promise.resolve();
  h.libraryResponse(h.stores("owner-a", 2)); // The worker's count action committed current-only and increased its revision.
  h.context.handleRequestedRoute({ tabId: 31, accountKey: "owner-a", route: "bookmarks", conversationId: "chat-b" });
  h.acceptSnapshot(h.snapshot("chat-b")); h.context.renderBookmarks();
  old.resolve(stale); await pendingRead; await flush();
  assert.equal(h.state.bookmarks.view.groupId, "current");
  assert.match(h.bookmarksRoot.innerHTML, /owner-a private chat-b/);
  assert.doesNotMatch(h.bookmarksRoot.innerHTML, /owner-a private chat-a/);
  assert.equal(h.requests.filter(value => value.type === h.context.protocol.Type.LIBRARY_GET).length, 3);
});

test("an initial route request is discarded when the separately verified library belongs to another account", async () => {
  const h = harness(); h.acceptSnapshot(h.snapshot("chat-a"));
  h.context.handleRequestedRoute({ tabId: 31, accountKey: "owner-a", route: "bookmarks", conversationId: "chat-b" });
  assert.equal(h.state.pendingBookmarkViewTargetId, "chat-b");
  await h.bind("owner-b");
  assert.equal(h.state.pendingBookmarkViewTargetId, null, "an old account cannot leave the new account behind an unrelated target gate");
  h.context.renderBookmarks(); assert.match(h.bookmarksRoot.innerHTML, /owner-b private chat-a/);
});

test("temporary library invalidation clears DOM and both cached view models before same-account revalidation", async () => {
  const h = harness(); h.acceptSnapshot(h.snapshot("chat-a")); await h.bind(); h.selectBookmark("chat-a::message");
  assert.match(h.favoritesRoot.innerHTML, /owner-a private favorite/); assert.match(h.bookmarksRoot.innerHTML, /owner-a private chat-a/);
  h.context.library.invalidate();
  assert.equal(h.state.activeBookmarkId, null); assert.equal(h.state.favorites, null); assert.equal(h.state.bookmarks, null);
  h.context.favoritesView.render(); h.context.bookmarksView.render(); h.drainVisualCallbacks();
  assert.doesNotMatch(h.favoritesRoot.innerHTML + h.bookmarksRoot.innerHTML, /owner-a private|data-bookmark-jump|data-favorite-open/);
  await h.bind("owner-b"); h.context.favoritesView.render(); h.context.bookmarksView.render();
  assert.doesNotMatch(h.favoritesRoot.innerHTML + h.bookmarksRoot.innerHTML, /owner-a private/);
  assert.match(h.favoritesRoot.innerHTML, /owner-b private favorite/);
});

for (const kind of ["favorites", "bookmarks"]) for (const rejection of [false, true]) {
  test(`${kind} late ${rejection ? "failure" : "success"} cannot update or refresh a newer account`, async () => {
    const h = harness(); h.acceptSnapshot(h.snapshot("chat-a")); await h.bind();
    const pending = deferred(); h.actionResponse(pending.promise);
    const handler = kind === "favorites" ? h.context.handleFavoriteAction : h.context.handleBookmarkAction;
    const action = handler("move", { conversationId: "chat-a", bookmarkId: "chat-a::message", groupId: null });
    assert.equal(h.requests.at(-1).payload.expectedAccountKey, "owner-a");
    assert.deepEqual(h.requests.at(-1).payload.expectedIdentity, { documentId: "document", epoch: 0 });
    h.context.library.invalidate(); await h.bind("owner-b");
    const calls = h.requests.length;
    if (rejection) pending.reject(Object.assign(new Error("old owner's delayed failure"), { code: "CONTEXT_MISMATCH" }));
    else pending.resolve(h.stores("owner-a", 99)[kind]);
    await action; await flush();
    assert.equal(h.state.accountKey, "owner-b"); assert.equal(h.state[kind].accountKey, "owner-b");
    assert.equal(h.requests.length, calls, "stale failures must not refresh the new owner"); assert.deepEqual(h.toasts, []);
  });
}

test('removed note editing actions do not send requests from either panel', async () => {
  const h = harness(); h.acceptSnapshot(h.snapshot('chat-a')); await h.bind();
  const count = h.requests.length;
  await h.context.handleFavoriteAction('note-update', { conversationId: 'chat-a', note: 'Ignored' });
  await h.context.handleBookmarkAction('note-update', { bookmarkId: 'chat-a::message', note: 'Ignored' });
  assert.equal(h.requests.length, count); assert.deepEqual(h.toasts, []);
});

test("unknown owner actions verify once but never replay the user's mutation automatically", async () => {
  const h = harness(); h.libraryResponse(h.stores());
  await h.context.handleFavoriteAction("remove", { conversationId: "chat-a" });
  assert.deepEqual(h.requests.map(value => value.type), [h.context.protocol.Type.LIBRARY_GET]);
  assert.equal(h.state.accountKey, "owner-a");
});

test("leaving Favorites revokes its pending OPEN before a receipt and ignores the late failure", async () => {
  const h = harness(), pending = deferred(); await h.bind(); h.context.setRoute("favorites"); h.acceptSnapshot(h.snapshot("chat-a"));
  h.actionResponse(() => pending.promise);
  const opening = h.context.handleFavoriteAction("open", { conversationId: "chat-b" }); await flush();
  const open = h.requests.find(x => x.type === h.context.protocol.Type.FAVORITES_OPEN);
  assert.ok(open.payload.navigationIntentId);
  h.context.setRoute("time");
  const cancel = h.requests.find(x => x.type === h.context.protocol.Type.NAVIGATION_CANCELLED);
  assert.equal(cancel.payload.navigationIntentId, open.payload.navigationIntentId);
  const reads = h.requests.filter(x => x.type === h.context.protocol.Type.LIBRARY_GET).length;
  pending.reject(Object.assign(Error("superseded"), { code: "CONTEXT_MISMATCH" })); await opening;
  assert.equal(h.toasts.length, 0);
  assert.equal(h.requests.filter(x => x.type === h.context.protocol.Type.LIBRARY_GET).length, reads);
});

test("a bound-tab manual cancel event revokes pending bookmark work without an error toast or IPC echo", async () => {
  const h = harness(), pending = deferred(); await h.bind(); h.context.setRoute("bookmarks"); h.acceptSnapshot(h.snapshot("chat-a"));
  h.actionResponse(pending.promise);
  const opening = h.context.handleBookmarkAction("open", { bookmarkId: "chat-a::message" }); await flush();
  const id = h.requests.find(x => x.type === h.context.protocol.Type.BOOKMARKS_OPEN).payload.navigationIntentId;
  h.event(h.context.protocol.Type.NAVIGATION_CANCELLED, { tabId: 99, navigationIntentId: id, reason: "user-cancelled" });
  h.event(h.context.protocol.Type.NAVIGATION_CANCELLED, { tabId: 31, navigationIntentId: "old", reason: "user-cancelled" });
  h.event(h.context.protocol.Type.NAVIGATION_CANCELLED, { tabId: 31, navigationIntentId: id, reason: "user-cancelled" });
  pending.reject(Object.assign(Error("superseded"), { code: "CONTEXT_MISMATCH" })); await opening; await h.advance(6000);
  assert.equal(h.toasts.length, 0); assert.equal(h.requests.filter(x => x.type === h.context.protocol.Type.NAVIGATION_CANCELLED).length, 0);
  assert.equal(h.timers.length, 0);
});

test("late bookmark-open success cannot set an active bookmark or clear the new owner's snapshot", async () => {
  const h = harness(); h.context.setRoute("bookmarks"); h.acceptSnapshot(h.snapshot("chat-a")); await h.bind();
  const pending = deferred(); h.actionResponse(pending.promise);
  const action = h.context.handleBookmarkAction("open", { bookmarkId: "chat-b::message" });
  const id = h.requests.find(r => r.type === h.context.protocol.Type.BOOKMARKS_OPEN).payload.navigationIntentId;
  h.event(h.context.protocol.Type.NAVIGATION_CANCELLED, { tabId: 31, navigationIntentId: id, reason: "identity-changed" });
  h.context.library.invalidate(); await h.bind("owner-b"); const current = h.state.snapshot;
  pending.resolve({ opened: true }); await action;
  assert.equal(h.state.activeBookmarkId, null); assert.equal(h.state.snapshot, current); assert.deepEqual(h.toasts, []);
});

test("worker cancellation makes a late bookmark result invisible to another account",async()=>{
    const h=harness();h.context.setRoute("bookmarks");h.acceptSnapshot(h.snapshot("chat-a"));await h.bind();
    h.actionResponse((type,payload)=>({...payload,conversationId:"chat-a",messageId:"message",pending:true}));
    await h.context.handleBookmarkAction("open",{bookmarkId:"chat-a::message"});
    const id=h.requests.find(r=>r.type===h.context.protocol.Type.BOOKMARKS_OPEN).payload.navigationIntentId;
    h.event(h.context.protocol.Type.NAVIGATION_CANCELLED,{tabId:31,navigationIntentId:id,reason:"identity-changed"});
    h.context.library.invalidate();await h.bind("owner-b");
    h.event(h.context.protocol.Type.NAVIGATION_RESULT,{tabId:31,navigationIntentId:id,conversationId:"chat-a",messageId:"message",located:true});
    assert.deepEqual(h.toasts,[]);
  });

test("normal panel navigation and focus/visibility preserve library leases, views and the export owner", async () => {
  const h = harness(); h.acceptSnapshot(h.snapshot("chat-a")); await h.bind();
  const before = h.context.library.getState(), lease = h.context.library.capture();
  const reads = h.requests.filter(value => value.type === h.context.protocol.Type.LIBRARY_GET).length;
  h.exportFrames.length = 0;
  for (let index = 0; index < 20; index++) {
    h.context.setRoute(["favorites", "bookmarks", "export", "settings"][index % 4]); h.focus(); h.visible(false); h.visible(true);
    const id = `chat-${index}`; h.contextResponse({ tab: { id: 31 }, snapshot: h.snapshot(id) });
    h.event(h.context.protocol.Type.CONTEXT_CHANGED, { tabId: 31, url: `https://chatgpt.com/c/${id}` }); await flush();
  }
  assert.equal(h.context.library.getState(), before); assert.equal(h.context.library.isCurrent(lease), true);
  assert.equal(h.requests.filter(value => value.type === h.context.protocol.Type.LIBRARY_GET).length, reads);
  assert.ok(h.exportFrames.every(owner => owner === "owner-a"));
});

test("successful shared bootstrap serves repeated Favorites/Bookmarks switches; only explicit retry rereads", async () => {
  const h = harness(); h.acceptSnapshot(h.snapshot("chat-a"));
  await h.bind();
  const before = h.context.library.getState(), lease = h.context.library.capture();
  const gets = () => h.requests.filter(value => value.type === h.context.protocol.Type.LIBRARY_GET);
  assert.equal(gets().length, 1); assert.ok(before.favorites && before.bookmarks);
  for (let i = 0; i < 30; i++) { h.context.setRoute("favorites"); h.context.setRoute("bookmarks"); await flush(); }
  assert.equal(gets().length, 1);
  assert.equal(h.context.library.getState(), before); assert.equal(h.context.library.isCurrent(lease), true);
  assert.match(h.favoritesRoot.innerHTML, /owner-a private favorite/);
  assert.match(h.bookmarksRoot.innerHTML, /owner-a private chat-a/);
  h.context.revalidateLibrary(); await flush();
  assert.equal(gets().length, 2); assert.equal(gets()[1].payload.retryIdentity, true);
  h.context.setRoute("favorites"); h.context.setRoute("bookmarks"); await flush(); assert.equal(gets().length, 2);
});

test("only the bound tab's identity event clears panel views; a same-owner update remains a background local read", async () => {
  const h = harness(); h.acceptSnapshot(h.snapshot("chat-a")); await h.bind();
  const identity = { accountKey: null, documentId: "document", epoch: 1, phase: "unavailable" };
  h.event(h.context.protocol.Type.LIBRARY_IDENTITY_CHANGED, { ...identity, tabId: 99 });
  assert.equal(h.state.accountKey, "owner-a");
  const wait = deferred(); h.libraryResponse(wait.promise);
  h.event(h.context.protocol.Type.FAVORITES_UPDATED, { accountKey: "owner-a", revision: 2 }); await Promise.resolve();
  assert.match(h.favoritesRoot.innerHTML, /owner-a private favorite/);
  h.event(h.context.protocol.Type.LIBRARY_IDENTITY_CHANGED, { ...identity, tabId: 31 });
  assert.equal(h.state.accountKey, null); assert.doesNotMatch(h.favoritesRoot.innerHTML, /owner-a private/);
  h.libraryResponse(h.stores("owner-b")); wait.resolve(h.stores("owner-a", 2)); await flush();
  h.event(h.context.protocol.Type.LIBRARY_IDENTITY_CHANGED, { ...identity, tabId: 31, phase: "ready", accountKey: "owner-b" });
  await h.context.library.refresh(); assert.equal(h.state.accountKey, "owner-b");
});

test("only explicit library retry passes retryIdentity, not unknown actions or ordinary refresh", async () => {
  const h = harness(); h.libraryResponse(h.stores());
  await h.context.handleFavoriteAction("remove", { conversationId: "chat-a" });
  assert.equal(h.requests[0].payload.retryIdentity, undefined);
  h.context.revalidateLibrary(); await flush(); assert.equal(h.requests.at(-1).payload.retryIdentity, true);
  await h.context.refreshBookmarks(); assert.equal(h.requests.at(-1).payload.retryIdentity, undefined);
});

test("a revision event supersedes an older pending library read without clearing rows or losing that update", async () => {
  const h = harness(); h.acceptSnapshot(h.snapshot("chat-a")); await h.bind(); const lease = h.context.library.capture();
  const old = deferred(); h.libraryResponse(old.promise); const pending = h.context.library.refresh(); await Promise.resolve();
  h.libraryResponse(h.stores("owner-a", 2)); h.event(h.context.protocol.Type.FAVORITES_UPDATED, { accountKey: "owner-a", revision: 2 });
  assert.match(h.favoritesRoot.innerHTML, /owner-a private favorite/); await flush();
  assert.equal(h.requests.filter(value => value.type === h.context.protocol.Type.LIBRARY_GET).length, 3);
  old.resolve(h.stores("owner-a", 1)); await pending;
  assert.equal(h.state.favorites.revision, 2); assert.equal(h.context.library.isCurrent(lease), true);
});

test("hidden library notifications coalesce into one local read when shown, without renewing ownership", async () => {
  const h = harness(); await h.bind(); const lease = h.context.library.capture();
  h.visible(false); h.libraryResponse(h.stores("owner-a", 3));
  for (const revision of [2, 2, 3]) {
    h.event(h.context.protocol.Type.FAVORITES_UPDATED, { accountKey: "owner-a", revision });
    h.event(h.context.protocol.Type.BOOKMARKS_UPDATED, { accountKey: "owner-a", revision });
  }
  await flush(); assert.equal(h.requests.length, 1, "hidden panels do not read or authenticate");
  h.visible(true); await flush();
  assert.equal(h.state.favorites.revision, 3); assert.equal(h.state.bookmarks.revision, 3);
  assert.equal(h.requests.length, 2); assert.equal(h.requests.at(-1).payload.retryIdentity, undefined);
  assert.equal(h.context.library.isCurrent(lease), true);
  h.visible(false); h.visible(true); await h.advance(40000); assert.equal(h.requests.length, 2);
  h.context.library.dispose();
});

test("notifications during initial hydration wait for proven ownership then repair only that account", async () => {
  const h = harness(), first = deferred(); h.libraryResponse(first.promise);
  const initial = h.context.library.refresh(); await flush();
  h.event(h.context.protocol.Type.FAVORITES_UPDATED, { accountKey: "owner-b", revision: 99 });
  h.event(h.context.protocol.Type.FAVORITES_UPDATED, { accountKey: "owner-a", revision: 2 });
  h.event(h.context.protocol.Type.BOOKMARKS_UPDATED, { accountKey: "owner-a", revision: 3 });
  await flush(); assert.equal(h.requests.length, 1); assert.equal(h.state.accountKey, null);
  h.libraryResponse(h.stores("owner-a", 3)); first.resolve(h.stores("owner-a", 1));
  await initial; await flush();
  assert.equal(h.state.accountKey, "owner-a"); assert.equal(h.state.favorites.revision, 3);
  assert.equal(h.state.bookmarks.revision, 3); assert.equal(h.requests.length, 2);
  assert.equal(h.requests.at(-1).payload.retryIdentity, undefined);
  assert.doesNotMatch(h.favoritesRoot.innerHTML + h.bookmarksRoot.innerHTML, /owner-b private/);
  h.context.library.dispose();
});

test("unrelated, malformed and already included revision notifications never create extra reads", async () => {
  const h = harness(), first = deferred(); h.libraryResponse(first.promise);
  const initial = h.context.library.refresh(); await flush();
  for (const token of [{ accountKey: "owner-b", revision: 99 }, { accountKey: "owner-a", revision: 2 },
    { accountKey: "owner-a", revision: -1 }, { accountKey: "owner-a", revision: "99" },
    { accountKey: "owner-a", revision: Number.MAX_SAFE_INTEGER + 1 }, { accountKey: " owner-a", revision: 99 }]) {
    h.event(h.context.protocol.Type.FAVORITES_UPDATED, token);
  }
  first.resolve(h.stores("owner-a", 2)); await initial; await flush();
  h.event(h.context.protocol.Type.FAVORITES_UPDATED, { accountKey: "owner-b", revision: 100 });
  h.event(h.context.protocol.Type.FAVORITES_UPDATED, { accountKey: "owner-a", revision: 2 });
  h.visible(false); h.visible(true); await h.advance(40000);
  assert.equal(h.requests.length, 1); assert.equal(h.state.favorites.revision, 2);
  h.context.library.dispose();
});

test("a notification target gets one read attempt, not a retry loop after stale data or transport failure", async () => {
  for (const failure of [false, true]) {
    const h = harness(); await h.bind();
    const next = deferred(); h.libraryResponse(next.promise);
    h.event(h.context.protocol.Type.FAVORITES_UPDATED, { accountKey: "owner-a", revision: 2 });
    await flush(); assert.equal(h.requests.length, 2);
    if (failure) next.reject(Object.assign(Error("transport unavailable"), { code: "ADAPTER_UNAVAILABLE" }));
    else next.resolve(h.stores("owner-a", 1));
    await flush();
    for (let i = 0; i < 3; i++) {
      h.event(h.context.protocol.Type.FAVORITES_UPDATED, { accountKey: "owner-a", revision: 2 });
      h.visible(false); h.visible(true); await flush();
    }
    await h.advance(40000); assert.equal(h.requests.length, 2);
    h.libraryResponse(h.stores("owner-a", 3));
    h.event(h.context.protocol.Type.FAVORITES_UPDATED, { accountKey: "owner-a", revision: 3 });
    await flush(); assert.equal(h.requests.length, 3); assert.equal(h.state.favorites.revision, 3);
    h.context.library.dispose();
  }
});

test("a mutation receipt satisfying a queued revision cancels the redundant local refresh", async () => {
  const h = harness(); await h.bind();
  h.event(h.context.protocol.Type.FAVORITES_UPDATED, { accountKey: "owner-a", revision: 2 });
  h.context.library.acceptMutation(h.context.library.capture(), "favorites", h.stores("owner-a", 2).favorites);
  await flush(); assert.equal(h.requests.length, 1); assert.equal(h.state.favorites.revision, 2);
  h.context.library.dispose();
});

test("identity invalidation retires scheduled and hidden revision targets, including A to B to A", async () => {
  for (const hidden of [false, true]) {
    const h = harness(); await h.bind();
    if (hidden) h.visible(false);
    h.event(h.context.protocol.Type.FAVORITES_UPDATED, { accountKey: "owner-a", revision: 99 });
    h.context.library.invalidate();
    if (hidden) h.visible(true);
    await h.bind("owner-b");
    const returned = h.stores("owner-a", 1); returned.identity.epoch = 2;
    h.libraryResponse(returned);
    h.event(h.context.protocol.Type.LIBRARY_IDENTITY_CHANGED, { tabId: 31, ...returned.identity,
      accountKey: "owner-a", phase: "ready" });
    await h.context.library.refresh(); await flush();
    assert.equal(h.requests.length, 3); assert.equal(h.state.accountKey, "owner-a");
    assert.equal(h.state.favorites.revision, 1); h.context.library.dispose();
  }
});

test("a newer revision supersedes the target read once, while duplicate hints preserve the pending read", async () => {
  const h = harness(); await h.bind(); const old = deferred(); h.libraryResponse(old.promise);
  h.event(h.context.protocol.Type.FAVORITES_UPDATED, { accountKey: "owner-a", revision: 2 });
  await flush(); assert.equal(h.requests.length, 2);
  h.event(h.context.protocol.Type.FAVORITES_UPDATED, { accountKey: "owner-a", revision: 2 });
  await flush(); assert.equal(h.requests.length, 2);
  h.libraryResponse(h.stores("owner-a", 3));
  h.event(h.context.protocol.Type.FAVORITES_UPDATED, { accountKey: "owner-a", revision: 3 });
  await flush(); assert.equal(h.requests.length, 3); assert.equal(h.state.favorites.revision, 3);
  old.resolve(h.stores("owner-a", 99)); await flush();
  assert.equal(h.state.favorites.revision, 3); h.context.library.dispose();
});

test("module revision targets stay independent when one initial storage read fails", async () => {
  const h = harness(), first = deferred(); h.libraryResponse(first.promise);
  const initial = h.context.library.refresh(); await flush();
  h.event(h.context.protocol.Type.FAVORITES_UPDATED, { accountKey: "owner-a", revision: 2 });
  h.event(h.context.protocol.Type.BOOKMARKS_UPDATED, { accountKey: "owner-a", revision: 3 });
  const partial = h.stores("owner-a", 2); partial.bookmarks = null;
  partial.errors.bookmarks = { code: "STORAGE_ERROR" };
  const recovered = h.stores("owner-a", 3); recovered.favorites.revision = 2;
  h.libraryResponse(recovered); first.resolve(partial); await initial; await flush();
  assert.equal(h.requests.length, 2); assert.equal(h.state.favorites.revision, 2);
  assert.equal(h.state.bookmarks.revision, 3); assert.equal(h.state.moduleErrors.bookmarks, undefined);
  h.context.library.dispose();
});

test("revision hints neither retry failed initial authentication nor survive panel disposal", async () => {
  const h = harness(), first = deferred(); h.libraryResponse(first.promise);
  const initial = h.context.library.refresh(); await flush();
  h.event(h.context.protocol.Type.FAVORITES_UPDATED, { accountKey: "owner-a", revision: 2 });
  first.reject(Object.assign(Error("authentication failed"), { code: "AUTH_REQUIRED" }));
  await initial;
  h.event(h.context.protocol.Type.FAVORITES_UPDATED, { accountKey: "owner-a", revision: 3 });
  h.visible(false); h.visible(true); await h.advance(40000);
  assert.equal(h.requests.length, 1); assert.equal(h.state.moduleErrors.favorites.code, "AUTH_REQUIRED");
  h.libraryResponse(h.stores()); h.context.revalidateLibrary(); await flush();
  assert.equal(h.requests.length, 2, "notifications without an in-flight read do not carry into an explicit retry");
  h.context.library.dispose();

  const closed = harness(); await closed.bind();
  closed.event(closed.context.protocol.Type.FAVORITES_UPDATED, { accountKey: "owner-a", revision: 2 });
  closed.context.library.dispose(); await flush();
  assert.equal(closed.requests.length, 1); assert.equal(closed.state.accountKey, null);
});



const opened = payload => ({...payload,conversationId:payload.bookmarkId.split("::")[0],messageId:"message",pending:true});
const opens = h => h.requests.filter(r=>r.type===h.context.protocol.Type.BOOKMARKS_OPEN);
const complete = (h,request=opens(h).at(-1),patch={}) => h.event(h.context.protocol.Type.NAVIGATION_RESULT,
  {tabId:31,navigationIntentId:request.payload.navigationIntentId,conversationId:request.payload.bookmarkId.split("::")[0],messageId:"message",located:true,...patch});
test("one panel OPEN consumes one worker completion; snapshots and later modules never issue LOCATE",async()=>{
  const h=harness();h.context.setRoute("bookmarks");h.acceptSnapshot(h.snapshot("chat-a"));await h.bind();
  h.actionResponse((type,payload)=>opened(payload));
  await h.context.handleBookmarkAction("open",{bookmarkId:"chat-a::message"});
  assert.equal(h.toasts.length,0);complete(h);complete(h);
  for(let i=0;i<20;i++)h.event(h.context.protocol.Type.SNAPSHOT_UPDATED,{tabId:31,snapshot:h.snapshot("chat-a")});
  h.context.setRoute("favorites");await h.advance(40000);
  assert.equal(opens(h).length,1);assert.equal(h.toasts.length,1);assert.equal(h.timers.length,0);
  assert.equal(h.requests.some(r=>r.type==="bookmarks.locate"),false);
});
for(const replyFirst of [true,false])test("panel command survives data rehydration when OPEN reply first="+replyFirst,async()=>{
  const h=harness();h.context.setRoute("bookmarks");h.acceptSnapshot(h.snapshot("chat-a"));await h.bind();
  assert.equal(h.state.routeKey,h.context.panelContext.routeKey(31,h.state.snapshot));
  const wait=deferred();h.actionResponse(()=>wait.promise);
  const opening=h.context.handleBookmarkAction("open",{bookmarkId:"chat-b::message"});
  const response=opened(opens(h)[0].payload);
  if(replyFirst){wait.resolve(response);await opening;}
  const identity={tabId:31,documentId:"destination",epoch:0,accountKey:null,phase:"unavailable"};
  h.event(h.context.protocol.Type.LIBRARY_IDENTITY_CHANGED,identity);
  const destination=h.snapshot("chat-b",true);h.event(h.context.protocol.Type.SNAPSHOT_UPDATED,{tabId:31,snapshot:destination});
  const next=h.stores();next.identity={documentId:"destination",epoch:1};h.libraryResponse(next);
  h.event(h.context.protocol.Type.LIBRARY_IDENTITY_CHANGED,{...identity,epoch:1,accountKey:"owner-a",phase:"ready"});
  await h.context.library.refresh();complete(h);
  if(!replyFirst){wait.resolve(response);await opening;}
  assert.equal(h.state.snapshot,destination);assert.equal(opens(h).length,1);assert.equal(h.toasts.length,1);
});
test("new bookmark selection rejects both an old OPEN and an old worker completion",async()=>{
  const h=harness();h.context.setRoute("bookmarks");h.acceptSnapshot(h.snapshot("chat-a"));await h.bind();
  const wait=deferred();h.actionResponse((type,payload)=>payload.bookmarkId==="chat-a::message"?wait.promise:opened(payload));
  const old=h.context.handleBookmarkAction("open",{bookmarkId:"chat-a::message"});
  await h.context.handleBookmarkAction("open",{bookmarkId:"chat-b::message"});
  complete(h,opens(h)[0]);wait.resolve(opened(opens(h)[0].payload));await old;
  assert.equal(h.toasts.length,0);assert.equal(h.state.activeBookmarkId,"chat-b::message");complete(h);assert.equal(h.toasts.length,1);
});
for(const reason of ["hidden","module-left","count-route","worker-cancel"])test("panel rejects completion after "+reason,async()=>{
  const h=harness();h.context.setRoute("bookmarks");h.acceptSnapshot(h.snapshot("chat-a"));await h.bind();h.actionResponse((type,payload)=>opened(payload));
  await h.context.handleBookmarkAction("open",{bookmarkId:"chat-a::message"});
  if(reason==="hidden")h.visible(false);if(reason==="module-left")h.context.setRoute("favorites");
  if(reason==="count-route")h.context.handleRequestedRoute({tabId:31,accountKey:"owner-a",route:"bookmarks",conversationId:"chat-b"});
  if(reason==="worker-cancel")h.event(h.context.protocol.Type.NAVIGATION_CANCELLED,{tabId:31,navigationIntentId:opens(h)[0].payload.navigationIntentId,reason:"route-changed"});
  complete(h);await h.advance(40000);assert.equal(h.toasts.length,0);assert.equal(opens(h).length,1);assert.equal(h.timers.length,0);
});
