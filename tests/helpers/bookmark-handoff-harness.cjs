const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IDBFactory } = require('fake-indexeddb');
const { installPageSession } = require('./page-session.cjs');

const ROOT = path.resolve(__dirname, '../..');
const OWNER = '["synthetic-user-a","synthetic-workspace-a"]';
const OTHER = '["synthetic-user-b","synthetic-workspace-b"]';
const TAB = 31, SOURCE = 'synthetic-source-document', DESTINATION = 'synthetic-destination-document';
const BOOKMARK = 'destination::message-1';
const SOURCE_ROOT = process.env.TIDY_HANDOFF_SOURCE_ROOT || ROOT;
const source = file => fs.readFileSync(path.join(SOURCE_ROOT, file), 'utf8');
const { sourceFiles: mainSourceFiles } = require(path.join(SOURCE_ROOT, 'tools/build-main-world.cjs'));
const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let index = 0; index < 12; index++) await new Promise(setImmediate); };
function event() {
  const listeners = new Set();
  return { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener),
    listener(...args) { let result; for (const listener of listeners) result = listener(...args); return result; } };
}
function load(context, file, exports = []) {
  const code = source(file).replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(`(() => { ${code}\nObject.assign(globalThis, { ${exports.join(',')} }); })()`, context, { filename: file });
}

/**
 * Full worker + actual panel wiring + actual MAIN message/identity listeners.
 * Only browser transport, synthetic session responses/cookies and host DOM are
 * replaced. Repositories, shared gates, owner leases, target/Fiber validation,
 * final MAIN fences and bounded physical scroll verification are production.
 */
async function createHandoffHarness(t) {
  const [database, favorites, bookmarks, favoriteDomain, bookmarkDomain, panelOwner, contextGuard,
    titleContext, favoriteFiling, bookmarkFiling, navigationEpoch] = await Promise.all([
    import('../../src/platform/storage/database.js'), import('../../src/features/favorites/storage/favorites.js'), import('../../src/features/bookmarks/storage/bookmarks.js'),
    import('../../src/features/favorites/storage/favorites-domain.js'), import('../../src/features/bookmarks/storage/bookmarks-domain.js'),
    import('../../src/platform/navigation/panel-owner.js'), import('../../src/platform/context-guard.js'),
    import('../../src/features/titles/model/title-context.js'), import('../../src/features/favorites/background/favorites-filing-context.js'),
    import('../../src/features/bookmarks/background/bookmarks-filing-context.js'), import('../../src/platform/navigation/storage/navigation-epoch.js'),
  ]);
  const db = await database.openTidyDatabase(new IDBFactory());
  t.after(() => db.close());
  const repositories = {
    favorites: favorites.createFavoritesRepository({ openDatabase: async () => db }),
    bookmarks: bookmarks.createBookmarksRepository({ openDatabase: async () => db }),
  };
  for (const owner of [OWNER, OTHER]) await repositories.bookmarks.transact(owner, state => ({ ...state,
    items: Object.fromEntries(['message-1', 'message-2'].map(messageId => {
      const bookmarkId = `destination::${messageId}`;
      return [bookmarkId, { bookmarkId, conversationId: 'destination', messageId,
        routePath: '/c/destination', role: 'assistant', excerpt: 'Synthetic local fixture', conversationTitle: 'Synthetic destination' }];
    })) }));

  let clock = 0, nextTimer = 0, activeDocument, worker, panel, pausedTabRead = null, pauseNextTabRead = false;
  let offscreenCreated = false;
  const timers = new Map(), pages = new Map(), calls = [], broadcasts = [], toasts = [];
  const DateClock = class extends Date { static now() { return 1789000000000 + clock; } };
  const setTimer = (fn, delay) => { const id = ++nextTimer; timers.set(id, { at: clock + Math.max(0, delay), fn }); return id; };
  const clearTimer = id => timers.delete(id);
  const stamp = () => ({ at: clock });
  const sender = page => ({ tab: { id: TAB, url: page.location.href }, url: page.location.href,
    frameId: 0, documentId: page.id, documentLifecycle: 'active' });
  const panelSender = { url: 'chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=31' };
  const chrome = {
    runtime: { id: 'tidy-test', getURL: value => `chrome-extension://tidy-test/${String(value || '').replace(/^\//, '')}`, onMessage: event(), onConnect: event(),
      getContexts: async () => offscreenCreated ? [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: chrome.runtime.getURL('features/export/engine/offscreen.html') }] : [],
      onInstalled: event(), onStartup: event(), sendMessage: async envelope => {
        // 浏览器宿主替身回传初始系统主题；后台主题处理器仍使用真实生产模块。
        if (envelope.channel === worker.TOOLBAR_THEME_CHANNEL && envelope.target === 'host' && envelope.type === 'sync') {
          return new Promise(resolve => chrome.runtime.onMessage.listener({ channel: worker.TOOLBAR_THEME_CHANNEL,
            target: 'service', type: 'changed', dark: false },
          { id: chrome.runtime.id, url: chrome.runtime.getURL('features/export/engine/offscreen.html') }, resolve));
        }
        broadcasts.push({ ...stamp(), ...plain(envelope) });
        panel?.chrome.runtime.onMessage.listener?.(envelope);
      } },
    tabs: { get: async id => {
      if (pauseNextTabRead) {
        pauseNextTabRead = false;
        await new Promise(resolve => { pausedTabRead = { resolve }; });
      }
      return { id, windowId: 1, url: activeDocument.location.href };
    }, query: async () => [{ id: TAB }],
      update: async (id, update) => { calls.push({ ...stamp(), type: 'tabs.update', id, ...update }); },
      sendMessage: async (tabId, envelope, target) => {
        if (envelope.kind === worker.TidyProtocol.Kind.EVENT) return;
        assert.equal(tabId, TAB);
        if (envelope.type !== 'snapshot.get') assert.ok(target?.documentId, `Physical/control transport must name one document: ${envelope.type}`);
        const documentId = target?.documentId || activeDocument.id;
        const page = pages.get(documentId);
        assert.ok(page, 'Transport cannot guess a destination document');
        if (envelope.type === worker.TidyProtocol.Type.PAGE_SESSION_PROBE) return worker.TidyProtocol.response(envelope, { ready: true });
        calls.push({ ...stamp(), lane: 'worker-page', type: envelope.type, documentId, payload: plain(envelope.payload) });
        return page.request(envelope);
      }, onUpdated: event(), onActivated: event(), onRemoved: event() },
    sidePanel: { setPanelBehavior: async () => {}, setOptions: async () => {}, open: async () => {},
      getOptions: async () => ({ enabled: true, path: 'app/sidepanel/index.html?tidyTabId=31' }) },
    webNavigation: { onHistoryStateUpdated: event(), onCommitted: event(), getFrame: async () => ({
      documentId: activeDocument.id, url: activeDocument.location.href, documentLifecycle: 'active' }) },
    storage: { onChanged: event(),
      sync: { get: async () => ({}), set: async () => {} },
      local: { get: async () => ({}), set: async () => {} } },
    offscreen: { createDocument: async () => { offscreenCreated = true; } },
    action: { setIcon: async () => {} },
  };
  worker = vm.createContext({ console, URL, URLSearchParams, Date: DateClock, chrome, setTimeout: setTimer, clearTimeout: clearTimer,
    ...panelOwner, ...contextGuard, ...titleContext, ...favoriteDomain, ...bookmarkDomain,
    assertAccountKey: database.assertAccountKey,
    createNavigationEpochAllocator: () => navigationEpoch.createNavigationEpochAllocator({ openDatabase: async () => db }),
    createFavoriteFilingContextRegistry: favoriteFiling.createFavoriteFilingContextRegistry,
    createBookmarkFilingContextRegistry: bookmarkFiling.createBookmarkFilingContextRegistry,
    createConversationCatalogRepository: () => ({ getSnapshot: async () => { throw Error('Unexpected catalog access'); } }),
    favoritesRepository: repositories.favorites, bookmarksRepository: repositories.bookmarks,
  });
  for (const file of ['src/platform/protocol.js', 'src/platform/navigation/navigation-identity.js', 'src/platform/snapshot.js', 'src/features/search/model/search.js', 'src/platform/catalog/date-search.js', 'src/features/export/model/export.js']) load(worker, file);
  require('./worker-navigation.cjs').loadWorkerNavigation(worker, source);
  require('./export-job-service.cjs').loadExportJobService(worker, source);
  load(worker, 'src/platform/theme/background/toolbar-theme.js', ['createToolbarTheme', 'TOOLBAR_THEME_CHANNEL']);
  // Follow the entire worker module graph; only browser/storage hosts and the
  // navigation owner's read-only test probe are supplied above.
  require('./worker-runtime.cjs').createWorkerModuleLoader(worker, { imports: worker, read: source })
    .load('src/app/background/service-worker.js');
  const protocol = worker.TidyProtocol;

  function createPage(id, conversation) {
    const listeners = new Map(), replies = new Map();
    const sessionWaiters = [];
    const page = { id, conversation, bound: false, mounted: false, contentReady: true, holdSession: false, fetchStatus: 200, user: 'synthetic-user-a', location: {
      href: `https://chatgpt.com/c/${conversation}`, origin: 'https://chatgpt.com' } };
    const rect = (top, left, width, height) => ({ top, left, width, height, right: left + width, bottom: top + height });
    const root = { style: { overflowY: 'visible', overflowX: 'visible' }, parentElement: null,
      clientTop: 0, clientLeft: 0, clientHeight: 800, clientWidth: 1000, scrollHeight: 800, scrollTop: 0,
      getBoundingClientRect: () => rect(0, 0, 1000, 800) };
    const viewport = { parentElement: root, style: { overflowY: 'auto', overflowX: 'hidden' },
      clientTop: 0, clientLeft: 0, clientHeight: 600, clientWidth: 800, scrollHeight: 4000, scrollTop: 0,
      getBoundingClientRect: () => rect(100, 100, 800, 600), contains: node => elements.includes(node),
      scrollTo({ top, behavior }) {
        calls.push({ ...stamp(), type: 'physical-scroll', documentId: id, top, behavior });
        this.scrollTop = top;
      } };
    const elements = ['message-1', 'message-2'].map((messageId, index) => ({ parentElement: viewport, style: {},
      get isConnected() { return page.mounted; },
      matches: selector => selector === '[data-message-author-role]', querySelector: () => null,
      closest(selector) { return selector.split(/,\s*/).includes('[data-message-id]') ? this : null; },
      getAttribute: name => name === 'data-message-id' ? messageId : null,
      getClientRects: () => page.mounted ? [rect(1100 + index * 300 - viewport.scrollTop, 120, 700, 40)] : [],
      getBoundingClientRect: () => rect(1100 + index * 300 - viewport.scrollTop, 120, 700, 40), animate() {},
      __reactFiber$fixture: { memoizedProps: { message: { id: messageId, conversation_id: conversation, author: { role: 'assistant' } },
        conversation: { id: conversation } }, return: null },
    }));
    const document = { documentElement: root, scrollingElement: root, readyState: 'complete', hidden: false,
      cookie: '_account=synthetic-workspace-a',
      createTreeWalker: element => { let read = false; return { nextNode: () => {
        if (read || !page.contentReady) return null; read = true;
        return { nodeType: 3, textContent: 'Synthetic rendered message', parentElement: element };
      } }; },
      addEventListener() {}, removeEventListener() {},
      querySelector: selector => selector === 'main' ? viewport : null,
      querySelectorAll(selector) {
        if (!page.mounted) return [];
        if (selector === 'div[data-message-id]') return [...elements];
        return elements.filter(element => selector === `div[data-message-id="${element.getAttribute('data-message-id')}"]`);
      } };
    // Latest placement uses the same native main container and message DOM
    // candidates as bookmarks; the fixture does not replace the resolver.
    viewport.querySelectorAll = selector => document.querySelectorAll(selector);
    page.snapshot = () => {
      const sourced = value => ({ value, source: 'fixture', status: 'available' });
      return { schemaVersion: worker.TidySnapshot.VERSION, capturedAt: '2026-09-12T00:00:00.000Z',
        appearance: { colorScheme: 'light', source: 'fixture', status: 'available', surface: sourced('rgb(255, 255, 255)') },
        route: { pathname: `/c/${conversation}`, kind: 'conversation', status: 'available' },
        conversation: { conversationId: conversation, draftId: null, kind: 'conversation', identityStatus: 'stable',
          bindingStatus: page.bound ? 'bound' : 'route-only', title: sourced(`Synthetic ${conversation}`),
          createdAt: sourced('2026-09-12T00:00:00.000Z'), updatedAt: sourced('2026-09-12T00:00:00.000Z'), project: null },
        sidebarConversations: [], messages: page.mounted ? ['message-1', 'message-2'].map((messageId, index) => ({
          messageId, idStatus: 'stable', presentationStatus: 'formal', role: 'assistant',
          timestamp: sourced('2026-09-12T00:00:00.000Z'), excerpt: sourced('Synthetic local fixture'),
          order: { index }, locator: { strategy: 'data-message-id', value: messageId },
        })) : [] };
    };
    const context = vm.createContext({ console, URL, URLSearchParams, document, location: page.location,
      Date: DateClock, setTimeout: setTimer, clearTimeout: clearTimer, innerHeight: 800, innerWidth: 1000,
      CSS: { escape: value => value }, getComputedStyle: node => node.style,
      history: { pushState() {}, replaceState() {} }, queueMicrotask,
      MutationObserver: class { observe() {} disconnect() {} },
      addEventListener: (name, callback) => {
        const callbacks = listeners.get(name) || [];
        callbacks.push(callback); listeners.set(name, callbacks);
      },
      removeEventListener: (name, callback) => {
        const callbacks = listeners.get(name) || [];
        listeners.set(name, callbacks.filter(candidate => candidate !== callback));
      },
      postEnvelope(envelope) {
        calls.push({ ...stamp(), lane: 'main-out', documentId: id, type: envelope.type, kind: envelope.kind, payload: plain(envelope.payload || {}) });
        if (envelope.kind === protocol.Kind.EVENT) chrome.runtime.onMessage.listener(envelope, sender(page), () => {});
        else replies.get(envelope.requestId)?.(envelope);
      }, buildSnapshot: () => page.snapshot(),
      fetch: async url => {
        assert.equal(url, '/api/auth/session', 'Integration fixture permits only synthetic session responses');
        const body = { user: { id: page.user }, accessToken: 'synthetic-token-never-exported' };
        const status = page.fetchStatus;
        calls.push({ ...stamp(), type: 'synthetic-session', documentId: id });
        if (page.holdSession) await new Promise(resolve => sessionWaiters.push(resolve));
        return { ok: status === 200, status, json: async () => body, clone: () => ({ json: async () => body }) };
      },
    });
    context.global = context;
    context.session = installPageSession(context);
    Object.defineProperty(context, '__reactRouterDataRouter', { get: () => page.nativeRouter ? {
      navigate: pathname => {
        calls.push({ ...stamp(), type: 'native-router', pathname, documentId: id });
        page.location.href = new URL(pathname, page.location.origin).href;
      },
    } : null });
    page.setConversation = value => {
      conversation = page.conversation = value;
      for (const element of elements) {
        const props = element.__reactFiber$fixture.memoizedProps;
        props.message.conversation_id = value; props.conversation.id = value;
      }
    };
    // Load intact classic factories in the production manifest order. This
    // navigation fixture owns only synthetic snapshot publications; the full
    // MAIN composition and snapshot lifecycle have their own adapter tests.
    for (const file of mainSourceFiles) {
      if (file === 'src/app/page/main-world.js' || file.startsWith('src/platform/session/')) continue;
      vm.runInContext(source(file), context, { filename: file });
    }
    context.protocol = context.TidyProtocol;
    vm.runInContext(`
      const reader = TidyChatgptNativeSnapshotReader.create();
      const navigation = TidyChatgptPageNavigationRuntime.create({ reader, postEnvelope });
      const router = TidyPageRequestRouter.create({
        readSnapshot: buildSnapshot, publishSnapshot() {}, postEnvelope, navigation,
        routeStillOwnsConversation: reader.routeStillOwnsConversation,
        searchAdapter: TidyChatgptSearch, dateIndexAdapter: TidyChatgptDateIndex,
        exportAdapter: TidyChatgptExport, titleAdapter: TidyChatgptTitles, titleProjection: TidyChatgptTitleSync,
      });
      const unsubscribeIdentity = TidyChatgptApi.onLibraryIdentityChanged(identity => {
        if (!session.check()) return;
        navigation.observeIdentity(identity);
        postEnvelope(protocol.event(protocol.Type.LIBRARY_IDENTITY_CHANGED, identity));
      });
      const observer = TidyChatgptNativeObserver.create({
        onRefresh() {}, onRoute: navigation.routeChanged, onHidden: navigation.hidden, onMessage: router.handleMessage,
      });
      globalThis.pageNavigation = navigation;
      globalThis.disposeNavigationFixture = () => {
        observer.dispose(); unsubscribeIdentity(); navigation.dispose(); reader.dispose();
      };
    `, context, { filename: 'handoff-production-factory-assembly.js' });
    page.context = context;
    page.request = envelope => new Promise(resolve => {
      replies.set(envelope.requestId, value => { replies.delete(envelope.requestId); resolve(value); });
      context.incomingEnvelope = envelope;
      // Evaluate in the realm so event.source is exactly the MAIN global.
      context.dispatchFixtureMessage = event => { for (const callback of listeners.get('message') || []) callback(event); };
      vm.runInContext('dispatchFixtureMessage({source: global, origin: location.origin, data: {channel: protocol.WINDOW_CHANNEL, source: "chatgpt-isolated", envelope: incomingEnvelope}})', context);
    });
    page.setWorkspace = workspace => {
      document.cookie = workspace == null ? '' : `_account=${encodeURIComponent(workspace)}`;
      return context.TidyChatgptApi.checkLibraryIdentity();
    };
    page.hide = () => {
      document.hidden = true;
      for (const callback of listeners.get('pagehide') || []) callback({ type: 'pagehide' });
    };
    page.showFromCache = () => {
      document.hidden = false;
      for (const callback of listeners.get('pageshow') || []) callback({ type: 'pageshow', persisted: true });
    };
    page.observeSessionFailure = async () => {
      // A site's independent fetch fails while the earlier initialization
      // response is still pending. The real API observer publishes the cause
      // escalation; neither an epoch nor a transition event is fabricated.
      page.holdSession = false; page.fetchStatus = 401;
      await context.fetch('/api/auth/session'); await flush();
      page.fetchStatus = 200;
    };
    page.emitIdentity = async (phase, epoch, accountKey = OWNER) => {
      // Input is a real cookie/session observation, NEVER an injected protocol
      // identity event. API emits it through MAIN's original identity listener.
      if (phase === 'unavailable') {
        page.holdSession = true;
        page.setWorkspace(epoch === 2 ? null : 'synthetic-workspace-a');
        return;
      }
      const [user, workspace] = JSON.parse(accountKey);
      page.user = user;
      page.setWorkspace(workspace);
      page.holdSession = false;
      while (sessionWaiters.length) sessionWaiters.shift()();
      await context.TidyChatgptApi.readLibraryAccount();
    };
    pages.set(id, page);
    return page;
  }
  activeDocument = createPage(SOURCE, 'origin');
  activeDocument.bound = true;

  const request = (type, payload = {}) => new Promise((resolve, reject) => {
    calls.push({ ...stamp(), lane: 'panel-worker', type, payload: plain(payload) });
    const envelope = protocol.request(type, payload);
    assert.equal(chrome.runtime.onMessage.listener(envelope, panelSender, result => {
      calls.push({ ...stamp(), lane: 'worker-panel', type, ok: result.ok, payload: plain(result.payload || {}), error: result.error });
      result.ok ? resolve(result.payload) : reject(Object.assign(Error(result.error.message), { code: result.error.code }));
    }), true);
  });
  // Run the entire panel entry and production owners. Only visual views and
  // browser/DOM/storage boundaries are doubles; there are no entrypoint seams.
  const noop = () => {};
  function node(tag = 'div') {
    const attributes = new Map();
    const value = { dataset: {}, hidden: false, childElementCount: 0, childNodes: [],
      classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
      addEventListener: noop, removeEventListener: noop, closest: () => null,
      querySelector: () => null, querySelectorAll: () => [],
      setAttribute: (name, entry) => attributes.set(name, entry),
      getAttribute: name => attributes.get(name) || null,
      replaceChildren(...children) { this.childNodes = children; this.childElementCount = children.length; },
    };
    let content = '';
    Object.defineProperty(value, 'textContent', { get: () => content, set: next => {
      content = next;
      if (tag === 'span') toasts.push({ ...stamp(), message: next });
    } });
    return value;
  }
  const panelNodes = new Map();
  const panelDocument = { hidden: false, addEventListener: noop, removeEventListener: noop,
    createElement: tag => node(tag), querySelector: () => node(), querySelectorAll: () => [],
    getElementById: id => {
      if (id === 'settings-diagnostics') return null;
      if (!panelNodes.has(id)) panelNodes.set(id, node());
      return panelNodes.get(id);
    } };
  const view = () => ({ reset: noop, render: noop, update: noop, dispose: noop, setActive: noop, setAvailable: noop, dismissTransientUi: noop });
  const panelRuntime = require('./panel-runtime.cjs').createPanelRuntime({
    console, URL, URLSearchParams, Date: DateClock, setTimeout: setTimer, clearTimeout: clearTimer,
    document: panelDocument, window: { addEventListener: noop, removeEventListener: noop, close: noop },
    location: { href: panelSender.url },
    chrome: { runtime: { getURL: chrome.runtime.getURL, onMessage: event(),
      sendMessage: envelope => new Promise(resolve => {
        calls.push({ ...stamp(), lane: 'panel-worker', type: envelope.type, payload: plain(envelope.payload || {}) });
        chrome.runtime.onMessage.listener(envelope, panelSender, result => {
          calls.push({ ...stamp(), lane: 'worker-panel', type: envelope.type, ok: result.ok,
            payload: plain(result.payload || {}), error: result.error });
          resolve(result);
        });
      }) }, storage: { onChanged: event() } },
  }, {
    modules: {
      'src/messages/i18n.js': { createTranslator: () => key => key },
      'src/features/time/ui/time-view.js': { createTimeView: () => ({ ...view(), renderControls: noop, renderPreview: noop, renderDateFormatLabels: noop }) },
      'src/features/settings/ui/settings-view.js': { createSettingsView: () => ({ ...view(), updateTheme: noop }) },
      'src/features/settings/ui/library-backup-view.js': { createLibraryBackupView: view },
      'src/features/favorites/ui/favorites-view.js': { createFavoritesView: view },
      'src/features/bookmarks/ui/bookmarks-view.js': { createBookmarksView: view },
      'src/features/search/ui/search-view.js': { createSearchView: () => ({ ...view(), cancelId: noop,
        completeNavigation: () => true, setTabId: noop, setConversationId: noop, setVisible: noop, setIndexStatus: noop }) },
      'src/features/titles/ui/title-organization-view.js': { createTitleOrganizationView: () => ({ ...view(), canLeave: () => true }) },
      'src/features/export/ui/export-view.js': { createExportView: () => ({ ...view(), suspend: noop, updateContext: noop, hasActiveJob: () => false }) },
      'src/platform/catalog/storage/conversation-catalog.js': { createConversationCatalogRepository: () => ({}) },
      'src/app/sidepanel/shell-presentation.js': { PANEL_ROUTES: { bookmarks: {}, time: {} }, LANGUAGE_LOCALES: {},
        createShellPresentation: () => ({ localize: noop, applyTheme: noop, renderModuleChrome: noop,
          currentAppearance: () => null, renderPageConnection: () => false, renderContextStatus: noop,
          renderExportDockBadge: noop, renderPreferenceNotice: noop, hasLibraryWaiting: () => false,
          renderLibraryWaiting: noop, renderModuleError: noop, clearLibraryNotice: noop }) },
    },
    transforms: { 'src/app/sidepanel/panel.js': code => code + `
      Object.assign(globalThis, { library, bookmarkNavigation, panelNavigation, pageSession,
        handleBookmarkAction: bookmarksActions.handle, disposePanelFixture: lifecycle.dispose });
      // Test-only read projection, not a mutable legacy panel state mirror.
      globalThis.handoffState = Object.freeze({
        get accountKey() { return library.getState().accountKey; },
        get snapshot() { return context.get().snapshot; },
        get routeKey() { return context.get().routeKey; },
        get pageSession() { return state.pageSession; },
      });
      setRoute('bookmarks');
    ` },
  });
  panel = panelRuntime.context;
  for (const file of ['src/platform/protocol.js', 'src/platform/time-format.js',
    'src/platform/library/library-hydration.js', 'src/platform/ui/context-state.js']) panelRuntime.load(file);
  panelRuntime.load('src/app/sidepanel/panel.js');
  const state = panel.handoffState;
  const admitted = await panel.pageSession.check();
  assert.equal(admitted, true, `Initial page handshake failed: ${state.pageSession.error?.stack || state.pageSession.phase}`);
  await panel.library.refresh(); await flush();
  assert.equal(state.accountKey, OWNER, `Initial library must independently verify its source owner: ${JSON.stringify(calls)}`);
  const initialLease = panel.library.capture();
  t.after(() => {
    panel.disposePanelFixture();
    for (const page of pages.values()) page.context.disposeNavigationFixture();
    timers.clear();
  });
  async function advance(ms) {
    const until = clock + ms;
    await flush();
    for (let index = 0; index < 1000; index++) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      timers.delete(next[0]); clock = next[1].at; next[1].fn(); await flush();
      assert.ok(index < 999, 'Integrated fixture must not create an unbounded timer loop');
    }
    clock = until; await flush();
  }
  function commit(id = DESTINATION, conversation = 'destination', url = null) {
    activeDocument = createPage(id, conversation);
    if (url == null && id === DESTINATION && conversation === 'destination') url = calls.findLast(call => call.type === 'tabs.update')?.url || null;
    if (url) activeDocument.location.href = url;
    chrome.webNavigation.onCommitted.listener({ tabId: TAB, frameId: 0, documentId: id,
      documentLifecycle: 'active', url: activeDocument.location.href });
    return activeDocument;
  }
  function snapshot({ bound = true, mounted = true } = {}) {
    activeDocument.bound = bound; activeDocument.mounted = mounted;
    chrome.runtime.onMessage.listener(protocol.event(protocol.Type.SNAPSHOT_UPDATED, { reason: 'synthetic-mount', snapshot: activeDocument.snapshot() }),
      sender(activeDocument), () => {});
  }
  return { calls, broadcasts, toasts, state, panel, worker, initialLease, advance, flush, commit, snapshot,
    restore(id) {
      // BFCache restores the same document and DOM. Do not fabricate an SPA
      // route event or a new snapshot publication: neither occurred in Chrome.
      assert.ok(pages.has(id), 'Only a previously created document can be restored');
      activeDocument = pages.get(id);
      chrome.webNavigation.onCommitted.listener({ tabId: TAB, frameId: 0, documentId: id,
        documentLifecycle: 'active', url: activeDocument.location.href, transitionQualifiers: ['forward_back'] });
      activeDocument.showFromCache();
    },
    page: () => activeDocument, now: () => clock,
    acceptNavigationResult: (payload, sender) => chrome.runtime.onMessage.listener(protocol.event(protocol.Type.NAVIGATION_RESULT, payload), sender, () => {}),
    currentIntent: () => plain(worker.readNavigationState(31)),
    searchClick: (extra = {}) => request('search.open-result', { navigationKind: 'keyword', expectedTabId: TAB, conversationId: 'destination', resultId: 'synthetic-search-hit', messageId: 'message-1', query: 'needle', ...extra }),
    click: (bookmarkId = BOOKMARK) => panel.handleBookmarkAction('open', { bookmarkId }),
    identity: async (phase, epoch, owner = OWNER) => { await activeDocument.emitIdentity(phase, epoch, owner); await flush(); },
    routeEvent(url = null) {
      if (url) activeDocument.location.href = url;
      activeDocument.context.TidyChatgptApi.checkLibraryIdentity();
      activeDocument.context.pageNavigation.routeChanged();
      chrome.webNavigation.onHistoryStateUpdated.listener({ tabId: TAB, frameId: 0,
      documentId: activeDocument.id, documentLifecycle: 'active', url: activeDocument.location.href }); },
    pauseBeforePhysical() { pauseNextTabRead = true; },
    paused: () => pausedTabRead,
    release() { const old = pausedTabRead; pausedTabRead = null; old?.resolve(); },
    cancel: () => panel.bookmarkNavigation.cancel('user-cancelled'),
  };
}
module.exports = { createHandoffHarness, OWNER, OTHER, BOOKMARK, SOURCE, DESTINATION };
