const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const { installPageSession } = require("./helpers/page-session.cjs");
const { IDBFactory } = require("fake-indexeddb");

const NOW = "2026-09-11T12:00:00.000Z";
const OWNER = '["user-a","personal"]';
const OTHER = '["user-b","personal"]';
const panelSender = { url: "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=31" };
const contentSender = { tab: { id: 31, url: "https://chatgpt.com/c/shared" }, url: "https://chatgpt.com/c/shared",
  frameId: 0, documentId: "document-a", documentLifecycle: "active" };
const plain = (value) => JSON.parse(JSON.stringify(value));
const source = (file) => fs.readFileSync(file, "utf8");
const flush = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function snapshot(contract, title = "Fresh current title") {
  const sourced = (value) => ({ value, source: "fixture", status: "available" });
  return {
    schemaVersion: contract.VERSION, capturedAt: NOW,
    appearance: { colorScheme: "light", source: "test", status: "available",
      surface: sourced("rgb(255, 255, 255)") },
    route: { pathname: "/c/shared", kind: "conversation", status: "available" },
    conversation: { conversationId: "shared", draftId: null, kind: "conversation", identityStatus: "stable", bindingStatus: "bound",
      title: sourced(title), createdAt: sourced(NOW), updatedAt: sourced(NOW), project: null },
    sidebarConversations: [], messages: [],
  };
}

function document(contract, id, title = "Exported title") {
  return { schemaVersion: contract.VERSION, conversation: { id, title, createdAt: NOW, updatedAt: NOW, resources: [],
    messages: [{ id: "message", role: "user", messageNumber: 1, timestamp: null,
      segments: [{ type: "content", sourceMessageId: "message", timestamp: null,
        blocks: [{ type: "paragraph", text: "Private exported content" }] }] }] }, warnings: [] };
}

async function setup(t, options = {}) {
  const [dbModule, favoriteModule, bookmarkModule, favoriteDomain, bookmarkDomain,
    ownerModule, contextGuard, titleContext, favoriteFiling, bookmarkFiling, navigationEpoch, backupRepositoryModule, backupServiceModule] = await Promise.all([
    import("../src/platform/storage/database.js"), import("../src/features/favorites/storage/favorites.js"), import("../src/features/bookmarks/storage/bookmarks.js"),
    import("../src/features/favorites/storage/favorites-domain.js"), import("../src/features/bookmarks/storage/bookmarks-domain.js"),
    import("../src/platform/navigation/panel-owner.js"), import("../src/platform/context-guard.js"),
    import("../src/features/titles/model/title-context.js"), import("../src/features/favorites/background/favorites-filing-context.js"),
    import("../src/features/bookmarks/background/bookmarks-filing-context.js"),
    import("../src/platform/navigation/storage/navigation-epoch.js"),
    import("../src/features/settings/storage/library-backup.js"), import("../src/features/settings/background/library-backup-service.js"),
  ]);
  const db = await dbModule.openTidyDatabase(new IDBFactory());
  t.after(() => db.close());
  const raw = {
    favorites: favoriteModule.createFavoritesRepository({ openDatabase: async () => db }),
    bookmarks: bookmarkModule.createBookmarksRepository({ openDatabase: async () => db }),
  };
  for (const accountKey of [OWNER, OTHER]) {
    await raw.favorites.transact(accountKey, (state) => ({ ...state, revision: 1, items: {
      shared: { conversationId: "shared", title: accountKey === OWNER ? "A title" : "B private title",
        routePath: "/c/shared", savedAt: NOW, note: accountKey === OWNER ? "A note" : "B private note" },
    } }));
    await raw.bookmarks.transact(accountKey, (state) => ({ ...state, revision: 1, items: {
      "shared::message": { bookmarkId: "shared::message", conversationId: "shared", messageId: "message", role: "assistant",
        conversationTitle: "Old bookmark title", excerpt: accountKey === OWNER ? "A excerpt" : "B private excerpt",
        note: "Keep my bookmark note", routePath: "/c/shared", bookmarkedAt: NOW },
    } }));
  }
  const calls = [], broadcasts = [];
  let accountKey = OWNER, accountReads = 0, epoch = 1, documentId = "document-a";
  const pageLocation = { href: options.tabUrl || "https://chatgpt.com/c/shared", origin: "https://chatgpt.com" };
  let pageNavigation;
  let pageIntent;
  const control = { setOwner: (value) => {
    if (value === accountKey) return;
    accountKey = value; epoch += 1;
    receiveRuntime(context.TidyProtocol.event("library.identity-changed", {
      accountKey, epoch, phase: "ready",
    }), { ...contentSender, documentId }, () => {});
  }, getOwner: () => accountKey };
  const repository = (kind) => ({
    get: async (owner) => {
      calls.push({ type: "get", kind, accountKey: owner });
      await options.onRepositoryGet?.({ kind, accountKey: owner, when: "before", ...control });
      const state = await raw[kind].get(owner);
      await options.onRepositoryGet?.({ kind, accountKey: owner, when: "after", ...control });
      return options.wrongRepositoryOwner === kind ? { ...state, accountKey: OTHER } : state;
    },
    transact: async (owner, mutator) => {
      calls.push({ type: "transact", kind, accountKey: owner });
      if (options.failMutationKind === kind) throw dbModule.storageError("Injected metadata storage failure");
      await options.beforeMutator?.({ kind, ...control });
      const state = await raw[kind].transact(owner, mutator);
      await options.onRepositoryTransact?.({ kind, accountKey: owner, ...control });
      return state;
    },
  });
  let receiveRuntime, receiveConnect, context;
  const event = () => ({ addListener(listener) { this.listener = listener; } });
  const sessionData = {};
  const sessionStorage = { get: async key => structuredClone({ [key]: sessionData[key] }),
    set: async values => Object.assign(sessionData, structuredClone(values)) };
  const chrome = {
    runtime: {
      getURL: (path = "") => `chrome-extension://tidy-test/${String(path).replace(/^\//, "")}`,
      sendMessage: async (envelope) => { broadcasts.push({ target: "runtime", envelope: plain(envelope) }); },
      onMessage: { addListener(listener) { receiveRuntime = listener; } },
      onConnect: { addListener(listener) { receiveConnect = listener; } }, onInstalled: event(), onStartup: event(),
    },
    tabs: {
      get: async (id) => {
        await options.onTabGet?.({ id });
        return { id, windowId: 1, url: pageLocation.href, status: 'complete' };
      },
      query: async () => [{ id: 31 }, { id: 32 }],
      update: async (id, update) => {
        calls.push({ type: "navigate", id, ...update });
        await options.onNavigate?.({ id, update });
        if (options.nativeTargets) pageLocation.href = update.url;
      },
      sendMessage: async (tabId, envelope, target) => {
        const protocol = context.TidyProtocol;
        if (envelope.kind === protocol.Kind.EVENT) { broadcasts.push({ target: tabId, envelope: plain(envelope) }); return; }
        // Infrastructure readiness has no account/data I/O; business assertions below count only business traffic.
        if (envelope.type === protocol.Type.PAGE_SESSION_PROBE) {
          if (options.onPageProbe) return options.onPageProbe({ envelope, target, protocol });
          return protocol.response(envelope, { ready: true });
        }
        calls.push({ type: envelope.type, tabId, target, payload: plain(envelope.payload) });
        if (envelope.type === protocol.Type.NAVIGATION_INTENT) {
          const result = await options.onNavigationControl?.({ envelope, target, ...control });
          return protocol.response(envelope, result || pageIntent.observe(envelope.payload));
        }
        if (envelope.type === protocol.Type.LIBRARY_ACCOUNT) {
          accountReads += 1;
          const observed = options.onAccountRead
            ? await options.onAccountRead({ index: accountReads, ...control }) : accountKey;
          return protocol.response(envelope, { accountKey: observed, epoch });
        }
        if (envelope.type === protocol.Type.LIBRARY_NAVIGATE) {
          const result = options.onLibraryNavigate ? await options.onLibraryNavigate({ envelope, target, ...control })
            : pageNavigation ? await pageNavigation.navigate(envelope.payload) : options.navigationResult || {
              navigated: true, ...(envelope.payload.placement === "native-search" ? { presentationOwner: "native" } : {}),
            };
          return protocol.response(envelope, result);
        }
        if (envelope.type === protocol.Type.GET_SNAPSHOT) {
          if (options.onSnapshot) return protocol.response(envelope, await options.onSnapshot({ envelope, target,
            snapshot: snapshot(context.TidySnapshot), ...control }));
          if (options.snapshotIdentityChanged) return protocol.failure(envelope, "CONTEXT_MISMATCH", "Page identity changed before its event reached the worker");
          return options.snapshot
            ? protocol.response(envelope, snapshot(context.TidySnapshot, options.snapshot))
            : protocol.failure(envelope, protocol.ErrorCode.ADAPTER_UNAVAILABLE, "Snapshot unavailable");
        }
        if (envelope.type === protocol.Type.LOCATE_MESSAGE) {
          const result = await options.onLocate?.({ envelope, target, ...control });
          return protocol.response(envelope, result || (new URL(pageLocation.href).pathname.endsWith('/c/'+envelope.payload.conversationId)
            ? { located: false, pending: true, targetPresent: true, reason: 'settling' }
            : { located: false, pending: true, targetPresent: false, reason: 'message-not-present' }));
        }
        if (envelope.type === protocol.Type.EXPORT_IMAGE_RESOURCE) {
          await options.onExport?.(control);
          return protocol.response(envelope, { readHandle: options.imageHandle || envelope.payload.readHandle,
            resource: { id: 'image', type: 'image', name: 'image.png', mimeType: 'image/png', sizeBytes: null, src: '', alt: '', pending: false } });
        }
        if (envelope.type === protocol.Type.EXPORT_CURRENT_CONVERSATION) {
          const result = protocol.response(envelope, document(context.TidyExportContract, "shared"));
          await options.onExport?.(control);
          return result;
        }
        if (envelope.type === protocol.Type.EXPORT_CONVERSATIONS) {
          const result = protocol.response(envelope, { schemaVersion: context.TidyExportContract.COLLECTION_VERSION,
            documents: envelope.payload.conversationIds.map((id) => document(context.TidyExportContract, id)) });
          await options.onExport?.(control);
          return result;
        }
        throw new Error(`Unexpected adapter operation: ${envelope.type}`);
      },
      onUpdated: event(), onActivated: event(), onRemoved: event(),
    },
    sidePanel: { setPanelBehavior: async () => {}, open: async ({ tabId }) => { await options.onPanelOpen?.({ tabId }); },
      getOptions: async ({ tabId }) => {
        await options.onPanelOptions?.({ tabId });
        return { enabled: true, path: `app/sidepanel/index.html?tidyTabId=${tabId}` };
      } },
    webNavigation: { onHistoryStateUpdated: event(), onCommitted: event(),
      getFrame: async () => ({ documentId, url: contentSender.url, documentLifecycle: "active" }) }, storage: { onChanged: event(), session: sessionStorage },
  };
  context = vm.createContext({ console, URL, URLSearchParams, chrome, Date: options.clock || Date,
    // 资料边界不依赖工具栏颜色；完整主题监听由 toolbar-theme.test.cjs 验证。
    TOOLBAR_THEME_CHANNEL: 'tidy.toolbar-theme.v1',
    createToolbarTheme: () => ({ start: async () => {}, acceptReport: async () => false }),
    setTimeout: () => 1, clearTimeout() {},
    ...ownerModule, ...contextGuard, ...titleContext, ...favoriteDomain, ...bookmarkDomain,
    assertAccountKey: dbModule.assertAccountKey,
    createNavigationEpochAllocator: () => navigationEpoch.createNavigationEpochAllocator({ openDatabase: async () => db }),
    createFavoriteFilingContextRegistry: favoriteFiling.createFavoriteFilingContextRegistry,
    createBookmarkFilingContextRegistry: bookmarkFiling.createBookmarkFilingContextRegistry,
    createConversationCatalogRepository: () => ({ getSnapshot: async () => { throw new Error("Library test touched catalog"); } }),
    favoritesRepository: repository("favorites"), bookmarksRepository: repository("bookmarks"),
    createLibraryBackupRepository: () => backupRepositoryModule.createLibraryBackupRepository({ openDatabase: async () => db }),
    createLibraryBackupService: backupServiceModule.createLibraryBackupService,
  });
  for (const file of ["src/platform/protocol.js", "src/platform/navigation/navigation-identity.js", "src/platform/snapshot.js", "src/features/search/model/search.js", "src/platform/catalog/date-search.js", "src/features/export/model/export.js"]) {
    vm.runInContext(source(file), context, { filename: file });
  }
  vm.runInContext(source("src/platform/navigation/chatgpt/navigation-intent.js"), context, { filename: "navigation-intent.js" });
  pageIntent = context.TidyChatgptNavigationIntent.create({
    parseRoute: () => ({ conversationId: /\/c\/([^/?#]+)/.exec(pageLocation.href)?.[1] || null }) });
  require("./helpers/worker-navigation.cjs").loadWorkerNavigation(context, source);
  // Load the real production module graph. Only existing host/storage seams are injected.
  const workerModules = require("./helpers/worker-runtime.cjs").createWorkerModuleLoader(context, { read: source, imports: {
    ...context,
    updatePreferences: patch => context.updatePreferences(patch),
    createWorkerNavigation: options => {
      const owner = context.createWorkerNavigation({ searchContract: context.TidySearch, ...options });
      context.navigation = owner;
      return owner;
    },
  } });
  context.pageSessionRequestPolicy = workerModules.load("src/platform/session/background/page-session.js").pageSessionRequestPolicy;
  workerModules.load("src/app/background/service-worker.js");
  if (options.nativeTargets) {
    // 使用真实导航适配器，只替身化站点已有路由器，不依赖侧栏链接。
    vm.runInContext(source("src/platform/navigation/chatgpt/library-navigation.js"), context, { filename: "library-navigation.js" });
    const router = { navigate(pathname) {
      assert.ok(options.nativeTargets.includes(new URL(pathname, pageLocation.origin).pathname.split('/c/')[1]));
      calls.push({ type: "native-router", pathname }); pageLocation.href = `https://chatgpt.com${pathname}`;
    } };
    pageNavigation = context.TidyChatgptLibraryNavigation.create({ location: pageLocation,
      isIntentCurrent: id => pageIntent.isCurrent(id),
      getRouter: () => router, readAccount: () => options.onNativeRead?.({ accountKey, epoch }) || ({ accountKey, epoch }),
      checkIdentity: () => ({ accountKey, epoch, phase: "ready" }) });
  }
  const request = (type, payload = {}, sender = panelSender) => new Promise((resolve) => {
    const envelope = context.TidyProtocol.request(type, { expectedTabId: 31,
      expectedIdentity: { documentId, epoch }, ...payload });
    assert.equal(receiveRuntime(envelope, sender, resolve), true);
  });
  return { calls, broadcasts, request, raw, context, receiveRuntime, receiveConnect, chrome, pageLocation,
    activateDocumentWithoutCommit(nextDocumentId) { documentId = nextDocumentId; epoch = 1; },
    commit(nextDocumentId, url = contentSender.url) {
      documentId = nextDocumentId; epoch = 1;
      pageLocation.href = url;
      pageIntent = context.TidyChatgptNavigationIntent.create({
        parseRoute: () => ({ conversationId: /\/c\/([^/?#]+)/.exec(pageLocation.href)?.[1] || null }) });
      chrome.webNavigation.onCommitted.listener({ tabId: 31, frameId: 0, documentId, url, documentLifecycle: "active" });
    }, ...control };
}

test("backup worker commands are panel-only and require the exact tab, account and document", async t => {
  const f = await setup(t), before = plain(await f.raw.favorites.get(OWNER));
  for (const type of ['library.backup-export', 'library.backup-preview', 'library.backup-restore', 'library.backup-discard']) {
    for (const [payload, sender] of [
      [{ expectedAccountKey: OWNER }, contentSender],
      [{ expectedAccountKey: OWNER }, { url: 'chrome-extension://tidy-test/offscreen/index.html' }],
      [{ expectedAccountKey: OTHER }, panelSender],
      [{ expectedAccountKey: OWNER, expectedTabId: 32 }, panelSender],
      [{ expectedAccountKey: OWNER, expectedIdentity: { documentId: 'old-document', epoch: 1 } }, panelSender],
      [{ expectedAccountKey: OWNER, expectedIdentity: null }, panelSender],
      [{}, panelSender],
    ]) {
      const result = await f.request(type, payload, sender);
      assert.equal(result.ok, false, type); assert.equal(result.error.code, payload.expectedTabId === 32 ? 'TAB_UNAVAILABLE' : 'CONTEXT_MISMATCH', type);
    }
  }
  assert.deepEqual(plain(await f.raw.favorites.get(OWNER)), before);
});

test("backup worker round-trip never sends files to the page and notifies only revisions after atomic restore", async t => {
  const f = await setup(t);
  await f.request('library.get');
  const beforeCalls = f.calls.length;
  const exported = await f.request('library.backup-export', { expectedAccountKey: OWNER });
  assert.equal(exported.ok, true); assert.doesNotMatch(exported.payload.text, /B private/);
  const value = JSON.parse(exported.payload.text);
  value.favorites.items.push({ ...value.favorites.items[0], conversationId: 'new-conv', routePath: '/c/new-conv', note: 'imported note' });
  value.bookmarks.items.push({ ...value.bookmarks.items[0], conversationId: 'new-conv', bookmarkId: 'new-conv::message', routePath: '/c/new-conv' });
  const preview = await f.request('library.backup-preview', { expectedAccountKey: OWNER, text: JSON.stringify(value) });
  assert.equal(preview.ok, true); assert.equal(preview.payload.summary.favorites.added, 1);
  assert.equal(Object.hasOwn((await f.raw.favorites.get(OWNER)).items, 'new-conv'), false);
  const result = await f.request('library.backup-restore', { expectedAccountKey: OWNER, previewId: preview.payload.id });
  assert.equal(result.ok, true); assert.equal(result.payload.favorites.items['new-conv'].note, 'imported note');
  assert.equal(Object.hasOwn((await f.raw.favorites.get(OTHER)).items, 'new-conv'), false);
  assert.equal(f.calls.slice(beforeCalls).some(call => /library\.backup|snapshot\.get|library\.account/.test(call.type)), false,
    'backup reads local storage; it does not forward payloads or fetch a new snapshot');
  const notices = f.broadcasts.filter(row => /^(favorites|bookmarks)\.updated$/.test(row.envelope.type));
  assert.ok(notices.length >= 2);
  for (const row of notices) assert.deepEqual(Object.keys(row.envelope.payload).sort(), ['accountKey', 'revision']);
  const repeated = await f.request('library.backup-restore', { expectedAccountKey: OWNER, previewId: preview.payload.id });
  assert.equal(repeated.ok, false); assert.equal(repeated.error.code, 'BACKUP_EXPIRED');
});

test("backup preview from a previous document is revoked even when the account is unchanged", async t => {
  const f = await setup(t), exported = await f.request('library.backup-export', { expectedAccountKey: OWNER });
  const preview = await f.request('library.backup-preview', { expectedAccountKey: OWNER, text: exported.payload.text });
  assert.equal(preview.ok, true);
  f.commit('document-b');
  const result = await f.request('library.backup-restore', { expectedAccountKey: OWNER, previewId: preview.payload.id });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'BACKUP_EXPIRED');
});

test("LIBRARY_GET returns only the authenticated account libraries", async (t) => {
  const fixture = await setup(t);
  const result = await fixture.request("library.get");
  assert.equal(result.ok, true);
  assert.equal(result.payload.accountKey, OWNER);
  assert.equal(result.payload.favorites.items.shared.note, "A note");
  assert.equal(result.payload.bookmarks.items["shared::message"].excerpt, "A excerpt");
  assert.equal(JSON.stringify(result).includes("B private"), false);
  assert.deepEqual(Object.keys(result.payload).sort(), ["accountKey", "bookmarks", "errors", "favorites", "identity"]);
  assert.ok(fixture.calls.filter((call) => call.type === "get").every((call) => call.accountKey === OWNER));
  assert.equal(fixture.calls.filter((call) => call.type === "library.account").length, 1);
  assert.deepEqual(plain(result.payload.identity), { documentId: "document-a", epoch: 1 });
});

test('first-install and reloaded missing page receivers deny every business command before account, storage or page work', async t => {
  let probes = 0;
  const f = await setup(t, { onPageProbe: () => { probes++; throw Error('Could not establish connection. Receiving end does not exist.'); } });
  const business = Object.values(f.context.TidyProtocol.Type).filter(type => f.context.pageSessionRequestPolicy(type) === 'business');
  assert.ok(business.length > 45, 'All module commands, not just favorites, must pass the same boundary');
  for (const type of business) {
    const result = await f.request(type, { expectedAccountKey: OWNER, expectedConversationId: 'shared',
      conversationId: 'shared', bookmarkId: 'shared::message', navigationIntentId: `blocked-${type}`,
      resultId: 'shared-result', navigationKind: 'keyword', messageId: null,
      conversationIds: ['shared'], bookmarkIds: [], query: 'needle', pathname: '/c/shared',
    }, type === 'bookmarks.open-conversation-view' ? contentSender : panelSender);
    assert.equal(result.ok, false, type);
    assert.equal(result.error.details?.stage, 'service-worker.page-session', `${type}: ${JSON.stringify(result.error)}`);
    assert.equal(result.error.details.disconnect, 'receiver-missing', type);
  }
  assert.equal(probes, business.length);
  assert.equal(f.calls.length, 0, 'No account/auth, library reads/writes, navigation or adapter commands can escape admission');
  assert.equal((await f.raw.favorites.get(OWNER)).revision, 1);
  assert.equal((await f.raw.bookmarks.get(OWNER)).revision, 1);
});

test('a once-ready worker rechecks the live bridge before a later library write', async t => {
  let stale = false;
  const f = await setup(t, { onPageProbe: ({ envelope, protocol }) => {
    if (stale) throw Error('Could not establish connection. Receiving end does not exist.');
    return protocol.response(envelope, { ready: true });
  } });
  assert.equal((await f.request('library.get')).ok, true);
  f.calls.length = 0; stale = true;
  const result = await f.request('favorites.remove', { expectedAccountKey: OWNER, conversationId: 'shared' });
  assert.equal(result.ok, false); assert.equal(result.error.details.stage, 'service-worker.page-session');
  assert.equal(f.calls.length, 0); assert.ok((await f.raw.favorites.get(OWNER)).items.shared);
});

test('export job ingress accepts only the exact owner panel, never page scripts or arbitrary extension pages', async t => {
  const f = await setup(t);
  for (const sender of [contentSender, { url: 'chrome-extension://tidy-test/features/export/engine/offscreen.html' },
    { url: 'chrome-extension://unrelated/app/sidepanel/index.html?tidyTabId=31' }]) {
    const result = await f.request('export.job-start', { expectedAccountKey: OWNER }, sender);
    assert.equal(result.ok, false);
  }
  assert.equal(f.calls.length, 0, 'untrusted ingress fails before account/content reads');
});

test('deferred image dispatch uses the bound document and rejects late account or handle mismatch', async t => {
  for (const mode of ['valid', 'changed-account', 'wrong-handle', 'malformed']) {
    const f = await setup(t, { ...(mode === 'changed-account' ? { onExport: ({ setOwner }) => setOwner(OTHER) } : {}),
      ...(mode === 'wrong-handle' ? { imageHandle: 'image-2-wrong' } : {}) });
    const readHandle = mode === 'malformed' ? 'https://outside.example/image' : 'image-1-test';
    const result = await f.request('export.image-resource', { expectedAccountKey: OWNER, readHandle });
    assert.equal(result.ok, mode === 'valid', mode);
    const calls = f.calls.filter(call => call.type === 'export.image-resource');
    assert.equal(calls.length, mode === 'malformed' ? 0 : 1, mode);
    if (calls.length) {
      assert.equal(calls[0].tabId, 31);
      assert.equal(calls[0].target.documentId, 'document-a');
      assert.deepEqual(calls[0].payload, { readHandle });
    }
  }
});

test('production export dispatch freezes verified document ownership and account change stops its host', async t => {
  const f = await setup(t, { snapshot: 'Export test' }); let exists = false, host = null, starts = 0, stops = 0;
  f.chrome.runtime.id = 'tidy-test';
  f.chrome.runtime.getContexts = async () => exists ? [{}] : [];
  const originalSend = f.chrome.runtime.sendMessage;
  f.chrome.runtime.sendMessage = async message => {
    if (message.channel !== 'tidy.export-host.v1') return originalSend(message);
    if (message.type === 'run') { starts++; host = { id: message.id, state: 'generating' }; }
    if (message.type === 'stop') { stops++; host = null; }
    return { ok: true, job: host };
  };
  f.chrome.offscreen = { createDocument: async () => { exists = true; }, closeDocument: async () => { exists = false; } };
  const payload = { id: 'integration', expectedAccountKey: OWNER, expectedConversationId: 'shared',
    spec: { plan: { format: 'txt', outputName: 'test.txt', messages: {}, files: [{ path: 'test.txt', kind: 'conversation', conversations: [{}] }] }, context: {}, warnings: [] } };
  const wrong = await f.request('export.job-start', { ...payload, expectedConversationId: 'wrong' });
  assert.equal(wrong.ok, false); assert.equal(starts, 0);
  const result = await f.request('export.job-start', payload);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.payload.state, 'generating');
  const stored = (await f.chrome.storage.session.get('tidy.export-job.v1'))['tidy.export-job.v1'];
  assert.equal(stored.owner.accountKey, OWNER); assert.equal(stored.owner.documentId, 'document-a'); assert.equal(stored.owner.epoch, 1);
  assert.equal((await f.request('export.job-start', { ...payload, id: 'second' })).payload.id, 'integration');
  assert.equal(starts, 1);
  f.setOwner(OTHER); await flush(); await flush();
  const interrupted = (await f.chrome.storage.session.get('tidy.export-job.v1'))['tidy.export-job.v1'];
  assert.equal(interrupted.state, 'failed'); assert.equal(interrupted.errorCode, 'exportJobOwnerChanged');
  assert.equal(stops, 1);
  assert.equal((await f.request('export.job-status', { expectedAccountKey: OTHER })).payload, null);
});

test("only an active top-level ChatGPT commit publishes panel context", async t => {
  const h = await setup(t);
  const commit = { tabId: 31, frameId: 0, documentId: 'restored-document',
    documentLifecycle: 'active', url: contentSender.url, transitionQualifiers: ['forward_back'] };
  for (const patch of [{ frameId: 1 }, { tabId: -1 }, { documentLifecycle: 'cached' },
    { documentLifecycle: 'prerender' }, { documentLifecycle: undefined }, { url: 'https://example.com/' }]) {
    h.chrome.webNavigation.onCommitted.listener({ ...commit, ...patch });
  }
  assert.equal(h.broadcasts.filter(e => e.envelope.type === 'context.changed').length, 0);
  h.chrome.webNavigation.onCommitted.listener(commit);
  const events = h.broadcasts.filter(e => e.envelope.type === 'context.changed');
  assert.equal(events.length, 1);
  assert.deepEqual(plain(events[0].envelope.payload), { reason: 'document-committed', tabId: 31, url: contentSender.url, documentId: 'restored-document' });
});

test("shared navigation dispatch preserves ordinary preference writes and favorite reads", async t => {
  const fixture = await setup(t), writes = [];
  fixture.context.updatePreferences = async patch => { writes.push(plain(patch)); return { theme: patch.theme }; };
  const preference = await fixture.request('preferences.update', { theme: 'sage' });
  assert.equal(preference.ok, true);
  assert.equal(preference.payload.theme, 'sage');
  assert.equal(writes.length, 1);
  assert.equal(fixture.calls.length, 0, 'A preference write must not acquire a navigation or account owner');
  const favorite = await fixture.request('favorites.get');
  assert.equal(favorite.ok, true);
  assert.equal(favorite.payload.items.shared.note, 'A note');
  assert.equal(JSON.stringify(favorite).includes('B private'), false);
});

test("removed legacy protocol strings are unsupported and cannot open account storage", async t => {
  const fixture = await setup(t);
  for (const type of ["library.unclaimed-get", "library.claim"]) {
    const result = await fixture.request(type);
    assert.equal(result.ok, false); assert.equal(result.error.code, "UNSUPPORTED_TYPE");
  }
  assert.equal(fixture.calls.length, 0);
});

test("snapshot transport preserves exact disconnect evidence; adapter HTTP errors keep their real status", async t => {
  const fixture = await setup(t), protocol = fixture.context.TidyProtocol;
  for (const [message, disconnect] of [["Could not establish connection. Receiving end does not exist.", "receiver-missing"],
    ["The message port closed before a response was received.", "connection-closed"], ["Failed to fetch", null]]) {
    fixture.chrome.tabs.sendMessage = async (_, envelope) => {
      if (envelope.type === protocol.Type.PAGE_SESSION_PROBE) return protocol.response(envelope, { ready: true });
      throw Error(message);
    };
    const result = await fixture.request(protocol.Type.GET_ACTIVE_CONTEXT);
    assert.equal(result.ok, false); assert.equal(result.error.code, "ADAPTER_UNAVAILABLE");
    assert.deepEqual(plain(result.error.details), { stage: "service-worker.snapshot-send-message", disconnect });
  }
  fixture.chrome.tabs.sendMessage = async (_, envelope) => envelope.type === protocol.Type.PAGE_SESSION_PROBE
    ? protocol.response(envelope, { ready: true }) : protocol.failure(envelope, "ADAPTER_UNAVAILABLE", "HTTP failure", { status: 503 });
  const result = await fixture.request(protocol.Type.GET_ACTIVE_CONTEXT);
  assert.equal(result.error.details.status, 503); assert.equal(result.error.details.disconnect, undefined);
});

for (const readyFirst of [true, false]) test(`extension reload: replacement ready ${readyFirst ? 'before' : 'after'} the old content-port failure recovers the initial library once`, async t => {
  let rejectOld;
  const oldPort = new Promise((_, reject) => { rejectOld = reject; });
  const fixture = await setup(t, { onAccountRead: () => oldPort });
  const timeline = [], requests = [];
  const panel = vm.createContext({ protocol: fixture.context.TidyProtocol, setTimeout, clearTimeout,
    // This fixture isolates library hydration; page-session admission is covered by its own production-controller tests.
    pageSession: { run: (_type, request) => request() },
    chrome: { runtime: { sendMessage: envelope => new Promise(resolve => {
      requests.push(plain(envelope)); timeline.push(`panel:${envelope.type}`);
      fixture.receiveRuntime(envelope, panelSender, response => {
        timeline.push(response.ok ? 'reply:ready' : `reply:${response.error.code}`); resolve(response);
      });
    }) } } });
  vm.runInContext(source("src/platform/library/library-hydration.js"), panel);
  vm.runInContext(source("src/platform/library/ui/library-controller.js").replace("export function", "function"), panel);
  const { createPanelRequestClient } = require("./helpers/worker-runtime.cjs").createWorkerModuleLoader(panel)
    .load("src/app/sidepanel/request-client.js");
  panel.sendRequest = createPanelRequestClient({ runtime: panel.chrome.runtime, protocol: panel.protocol, run: panel.pageSession.run }).send;
  const controller = panel.createLibraryController({ request: options => panel.sendRequest("library.get", { expectedTabId: 31, ...options }),
    onChanged: state => timeline.push(`model:${state.accountKey ? 'ready' : state.errors.bookmarks ? 'failed' : 'empty'}`) });
  t.after(() => controller.dispose());
  fixture.chrome.runtime.sendMessage = async envelope => {
    if (envelope.type !== "library.identity-changed") return;
    timeline.push(`worker:${envelope.payload.phase}:${envelope.payload.documentId}`);
    controller.observeIdentity(envelope.payload);
  };
  const first = controller.refresh();
  for (let i = 0; i < 8; i++) await flush();
  assert.equal(fixture.calls.filter(c => c.type === "library.account").length, 1);
  fixture.commit("reloaded-document");
  if (!readyFirst) {
    rejectOld(Error("The message port closed before a response was received.")); await first;
    assert.ok(controller.getState().errors.bookmarks, "Failure remains visible until the new document proves ready");
  }
  fixture.receiveRuntime(fixture.context.TidyProtocol.event("library.identity-changed", { phase: "ready", epoch: 1, accountKey: OWNER }),
    { ...contentSender, documentId: "reloaded-document" }, () => {});
  await flush();
  if (readyFirst) rejectOld(Error("The message port closed before a response was received."));
  else {
    assert.equal(requests.length, 2, "Ready must have started the recovery without an explicit retry");
    await controller.refresh(); // Join the already-issued request; do not race IndexedDB turns.
  }
  await first; for (let i = 0; i < 8; i++) await flush();
  console.log("reload-timeline", JSON.stringify(timeline));
  assert.equal(controller.getState().accountKey, OWNER, "A ready replacement cannot lose its wakeup behind the old failed request");
  assert.equal(requests.length, 2, "Exactly one ordinary recovery read");
  assert.ok(requests.every(r => !r.payload.retryIdentity), "No forced authentication retry");
  assert.equal(fixture.calls.filter(c => c.type === "library.account").length, 1, "Recovery uses the new worker's already-ready identity");
  assert.equal(controller.getState().bookmarks.items["shared::message"].note, "Keep my bookmark note");
  for (let i = 0; i < 20; i++) controller.observeIdentity({ documentId: "reloaded-document", epoch: 1, phase: "ready", accountKey: OWNER });
  await flush(); assert.equal(requests.length, 2);
});

for (const consumer of ["panel", "content"]) test(`${consumer}: ready overtaking the initializing account reply cannot strand hydration`, async t => {
  const accountReply = deferred();
  const fixture = await setup(t, { onAccountRead: () => accountReply.promise });
  const requests = [], listeners = [];
  const client = vm.createContext({ setTimeout, clearTimeout, console,
    pageSession: { run: (_type, request) => request() },
    addEventListener() {}, removeEventListener() {}, TidyContentBridge: {},
    chrome: { runtime: {
      id: "test-extension",
      onMessage: { addListener: listener => listeners.push(listener), removeListener(listener) {
        const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1);
      } },
      sendMessage: envelope => new Promise(resolve => {
        requests.push(plain(envelope));
        fixture.receiveRuntime(envelope, consumer === "panel" ? panelSender : contentSender, resolve);
      }),
    } },
  });
  vm.runInContext(source("src/platform/protocol.js"), client);
  vm.runInContext(source("src/platform/library/library-hydration.js"), client);
  let refresh, current, observe;
  if (consumer === "panel") {
    vm.runInContext("const protocol = TidyProtocol;", client);
    vm.runInContext(source("src/platform/library/ui/library-controller.js").replace("export function", "function"), client);
    const { createPanelRequestClient } = require("./helpers/worker-runtime.cjs").createWorkerModuleLoader(client)
      .load("src/app/sidepanel/request-client.js");
    client.sendRequest = createPanelRequestClient({ runtime: client.chrome.runtime, protocol: client.TidyProtocol, run: client.pageSession.run }).send;
    const controller = client.createLibraryController({ request: options => client.sendRequest("library.get", { expectedTabId: 31, ...options }) });
    t.after(() => controller.dispose());
    refresh = controller.refresh; current = controller.getState; observe = controller.observeIdentity;
    void refresh();
  } else {
    installPageSession(client, { runtime: true });
    vm.runInContext(source("src/platform/library/content/library-client.js"), client);
    refresh = client.TidyLibraryClient.refresh; current = client.TidyLibraryClient.current;
    observe = payload => listeners.forEach(listener => listener(client.TidyProtocol.event("library.identity-changed", payload)));
  }
  fixture.chrome.runtime.sendMessage = async envelope => {
    // Event delivery and the account reply are independent channels. Model a
    // consumer receiving the final ready, but not intermediate broadcasts.
    if (envelope.type === "library.identity-changed" && envelope.payload.epoch === 4) observe(envelope.payload);
  };
  for (let i = 0; i < 10; i++) await flush();
  assert.equal(fixture.calls.filter(c => c.type === "library.account").length, 1);
  for (const [epoch, phase, transition] of [[1, "ready", null], [2, "unavailable", "workspace-unconfirmed"], [3, "unavailable", "workspace-restored"], [4, "ready", null]]) {
    fixture.receiveRuntime(fixture.context.TidyProtocol.event("library.identity-changed", {
      epoch, phase, transition, accountKey: phase === "ready" ? OWNER : null,
    }), contentSender, () => {});
    await flush();
  }
  accountReply.resolve(OWNER);
  for (let i = 0; i < 20; i++) await flush();
  assert.equal(current()?.accountKey, OWNER, "Initial library cannot strand a verified ready document");
  assert.equal(current().identity.epoch, 4);
  assert.equal(requests.length, 1, "The initial read consumes worker ready without another IPC or auth read");
  assert.ok(requests.every(r => !r.payload?.retryIdentity));
  assert.equal(current().bookmarks.items["shared::message"].note, "Keep my bookmark note");
});

for (const boundary of ["soft", "context-changed", "session-revoked", "unknown", "A-B-A", "new-document", "ready-gap", "unavailable-gap"]) {
  test(`initial account reply convergence preserves ${boundary} boundary`, async t => {
    const old = deferred();
    const fixture = await setup(t, { onAccountRead: () => old.promise });
    const event = async (epoch, accountKey, transition = null, sender = contentSender) => {
      fixture.receiveRuntime(fixture.context.TidyProtocol.event("library.identity-changed", {
        epoch, accountKey, phase: accountKey ? "ready" : "unavailable", transition,
      }), sender, () => {}); await flush();
    };
    const result = new Promise(resolve => fixture.receiveRuntime(fixture.context.TidyProtocol.request("library.get", { expectedTabId: 31 }), panelSender, resolve));
    for (let i = 0; i < 5; i++) await flush();
    await event(1, OWNER);
    if (boundary !== "ready-gap" && boundary !== "unavailable-gap") await event(2, null, "workspace-unconfirmed");
    if (boundary === "new-document") {
      fixture.commit("replacement"); await event(4, OWNER, null, { ...contentSender, documentId: "replacement" });
    } else {
      if (boundary === "ready-gap") { /* No evidence for the intermediate epochs. */ }
      else if (boundary === "A-B-A") await event(3, OTHER);
      else if (boundary === "unavailable-gap") await event(3, null, "workspace-restored");
      else await event(3, null, boundary === "soft" ? "workspace-restored" : boundary === "unknown" ? null : boundary);
      await event(4, OWNER);
    }
    old.resolve(OWNER); const response = await result;
    assert.equal(response.ok, boundary === "soft");
    if (boundary === "soft") assert.equal(response.payload.identity.epoch, 4);
    else { assert.equal(response.error.code, "CONTEXT_MISMATCH"); assert.equal(response.payload, undefined); }
    assert.equal(fixture.calls.filter(c => c.type === "library.account").length, 1, "No forced auth retry");
  });
}

test("library account HTTP failures retain their status and layer rather than becoming reconnect signals", async t => {
  for (const [code, status] of [["LIBRARY_ACCOUNT_UNAVAILABLE", 401], ["ADAPTER_UNAVAILABLE", 429]]) {
    const fixture = await setup(t);
    fixture.chrome.tabs.sendMessage = async (_, envelope) => envelope.type === fixture.context.TidyProtocol.Type.PAGE_SESSION_PROBE
      ? fixture.context.TidyProtocol.response(envelope, { ready: true })
      : fixture.context.TidyProtocol.failure(envelope, code, "Account request failed", { status });
    const result = await fixture.request("library.get");
    assert.equal(result.ok, false); assert.equal(result.error.code, code);
    assert.equal(result.error.details.status, status);
    assert.equal(result.error.details.stage, "service-worker.library-account-response");
    assert.equal(result.error.details.disconnect, undefined);
    assert.equal(fixture.calls.filter(c => c.type === "get" || c.type === "transact").length, 0);
  }
});

test("converged initialization never renews an old mutation lease", async t => {
  const old = deferred(); const fixture = await setup(t, { onAccountRead: () => old.promise });
  const pending = fixture.request("favorites.move", { expectedAccountKey: OWNER, conversationId: "shared", groupId: "work" });
  for (let i = 0; i < 5; i++) await flush();
  for (const [epoch, phase, transition] of [[1, "ready", null], [2, "unavailable", "workspace-unconfirmed"], [3, "unavailable", "workspace-restored"], [4, "ready", null]]) {
    fixture.receiveRuntime(fixture.context.TidyProtocol.event("library.identity-changed", { epoch, phase, transition,
      accountKey: phase === "ready" ? OWNER : null }), contentSender, () => {}); await flush();
  }
  old.resolve(OWNER); const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.error.code, "CONTEXT_MISMATCH");
  assert.equal(fixture.calls.filter(c => c.type === "transact").length, 0);
  assert.equal((await fixture.raw.favorites.get(OWNER)).items.shared.groupId, null);
  assert.equal((await fixture.raw.favorites.get(OWNER)).items.shared.note, "A note");
});

test("a reply older than initialization ingress cannot converge to a later ready", async t => {
  const old = deferred(); const fixture = await setup(t, { onAccountRead: () => old.promise });
  const event = async (epoch, phase, accountKey, transition = null) => {
    fixture.receiveRuntime(fixture.context.TidyProtocol.event("library.identity-changed", { epoch, phase, accountKey, transition }), contentSender, () => {});
    await flush();
  };
  await event(2, "unavailable", null, "context-changed");
  const pending = new Promise(resolve => fixture.receiveRuntime(fixture.context.TidyProtocol.request("library.get", { expectedTabId: 31 }), panelSender, resolve));
  for (let i = 0; i < 5; i++) await flush(); await event(4, "ready", OWNER);
  old.resolve(OWNER); const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.error.code, "CONTEXT_MISMATCH");
});

test("wrong senders, conflicting tabs and missing expected mutation owner fail before library writes", async (t) => {
  const fixture = await setup(t);
  for (const sender of [null, {}, { url: "chrome-extension://tidy-test/other.html" },
    { url: "https://unrelated.invalid/" }, { ...panelSender, url: panelSender.url.replace("31", "32") }]) {
    const result = await fixture.request("favorites.move", { expectedAccountKey: OWNER, conversationId: "shared", groupId: "work" }, sender);
    assert.equal(result.ok, false);
  }
  const noOwner = await fixture.request("favorites.move", { conversationId: "shared", groupId: "work" });
  assert.equal(noOwner.ok, false);
  assert.equal(fixture.calls.some((call) => call.type === "transact"), false);
  assert.equal((await fixture.raw.favorites.get(OWNER)).items.shared.note, "A note");
});

for (const kind of ['favorites', 'bookmarks']) test(`${kind}: removed note-edit messages cannot write, and saved notes remain readable`, async t => {
  const fixture = await setup(t), before = await fixture.raw[kind].get(OWNER);
  const result = await fixture.request(`${kind}.note-update`, { expectedAccountKey: OWNER,
    conversationId: 'shared', bookmarkId: 'shared::message', note: 'Must not write' });
  assert.equal(result.ok, false);
  assert.equal(fixture.calls.some(call => call.type === 'transact'), false);
  assert.deepEqual(await fixture.raw[kind].get(OWNER), before);
  const read = await fixture.request('library.get');
  assert.equal(read.ok, true);
  assert.equal(read.payload[kind].items[kind === 'favorites' ? 'shared' : 'shared::message'].note,
    kind === 'favorites' ? 'A note' : 'Keep my bookmark note');
});

test("noncanonical account responses fail closed, including account-only probes", async (t) => {
  for (const account of [undefined, "", " ", " account-a", "account-a ", "a\u0000b", 12]) {
    const fixture = await setup(t, { onAccountRead: async () => account });
    const result = await fixture.request("library.account");
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "CONTEXT_MISMATCH");
    assert.equal(fixture.calls.some((call) => call.type === "get" || call.type === "transact"), false);
  }
});

test("an owner flip after repository reads suppresses the entire account payload", async (t) => {
  const fixture = await setup(t, { onRepositoryGet({ when, setOwner }) { if (when === "after") setOwner(OTHER); } });
  const result = await fixture.request("library.get");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CONTEXT_MISMATCH");
  assert.equal(result.payload, undefined);
  assert.equal(JSON.stringify(result).includes("A note"), false);
});

test("owner flips before mutation reject writes; flips after commit never leak state or mutate the new account", async (t) => {
  const before = await setup(t);
  await before.request("library.get");
  before.setOwner(OTHER);
  const rejected = await before.request("favorites.move", { expectedAccountKey: OWNER, conversationId: "shared", groupId: "work" });
  assert.equal(rejected.ok, false);
  assert.equal(before.calls.some((call) => call.type === "transact"), false);

  const after = await setup(t, { onRepositoryTransact({ setOwner }) { setOwner(OTHER); } });
  const committed = await after.request("favorites.move", { expectedAccountKey: OWNER, conversationId: "shared", groupId: "work" });
  assert.equal(committed.ok, false);
  assert.equal(committed.payload, undefined);
  assert.equal((await after.raw.favorites.get(OWNER)).items.shared.groupId, "work");
  assert.equal((await after.raw.favorites.get(OTHER)).items.shared.groupId, null);
  assert.equal((await after.raw.favorites.get(OWNER)).items.shared.note, "A note");
  assert.equal((await after.raw.favorites.get(OTHER)).items.shared.note, "B private note");
});

test("library changes broadcast metadata only and unchanged mutations produce no invalidation loop", async (t) => {
  const fixture = await setup(t);
  const changed = await fixture.request("favorites.move", { expectedAccountKey: OWNER, conversationId: "shared", groupId: "work" });
  assert.equal(changed.ok, true);
  await flush();
  assert.equal(fixture.broadcasts.length, 3, "one extension invalidation plus the two ChatGPT tabs");
  for (const event of fixture.broadcasts) {
    assert.equal(event.envelope.type, "favorites.updated");
    assert.deepEqual(Object.keys(event.envelope.payload).sort(), ["accountKey", "revision"]);
    assert.equal(JSON.stringify(event).includes("A note"), false);
    assert.equal(JSON.stringify(event).includes("A title"), false);
  }
  await fixture.request("favorites.move", { expectedAccountKey: OWNER, conversationId: "shared", groupId: "work" });
  await flush();
  assert.equal(fixture.broadcasts.length, 3);
});

test("export requires an expected owner and suppresses documents if ownership changes during the adapter read", async (t) => {
  const fixture = await setup(t, { onExport({ setOwner }) { setOwner(OTHER); } });
  const missing = await fixture.request("export.conversations", { conversationIds: ["shared"] });
  assert.equal(missing.ok, false);
  assert.equal(fixture.calls.some((call) => call.type === "export.conversations"), false);
  const changed = await fixture.request("export.conversations", { expectedAccountKey: OWNER, conversationIds: ["shared"] });
  assert.equal(changed.ok, false);
  assert.equal(changed.error.code, "CONTEXT_MISMATCH");
  assert.equal(JSON.stringify(changed).includes("Private exported content"), false);
  assert.ok(fixture.calls.filter((call) => call.type === "get").every((call) => call.accountKey === OWNER));
});

test("explicit library reads refresh one current snapshot, preserve user content and stop after one changed revision", async (t) => {
  const fixture = await setup(t, { snapshot: "Fresh current title" });
  const first = await fixture.request("library.get");
  assert.equal(first.ok, true);
  assert.equal(first.payload.favorites.items.shared.title, "Fresh current title");
  assert.equal(first.payload.favorites.items.shared.note, "A note");
  assert.equal(first.payload.bookmarks.items["shared::message"].conversationTitle, "Fresh current title");
  assert.equal(first.payload.bookmarks.items["shared::message"].excerpt, "A excerpt");
  assert.equal(first.payload.bookmarks.items["shared::message"].note, "Keep my bookmark note");
  assert.equal(fixture.calls.filter((call) => call.type === "snapshot.get").length, 1);
  await flush();
  const events = fixture.broadcasts.length;
  assert.equal(events, 6);
  const second = await fixture.request("library.get");
  assert.equal(second.ok, true);
  assert.equal(second.payload.favorites.revision, first.payload.favorites.revision);
  assert.equal(second.payload.bookmarks.revision, first.payload.bookmarks.revision);
  await flush();
  assert.equal(fixture.broadcasts.length, events, "refresh invalidations do not trigger an endless read/write loop");
  assert.equal((await fixture.raw.favorites.get(OTHER)).items.shared.title, "B private title");
});

test("metadata persistence failures stay module errors while unavailable snapshots return the saved account state", async (t) => {
  const fixture = await setup(t, { snapshot: "Fresh current title", failMutationKind: "favorites" });
  const result = await fixture.request("library.get");
  assert.equal(result.ok, true);
  assert.equal(result.payload.favorites, null);
  assert.equal(result.payload.errors.favorites.code, "STORAGE_ERROR");
  assert.equal(result.payload.bookmarks.items["shared::message"].conversationTitle, "Fresh current title");
  assert.equal((await fixture.raw.favorites.get(OWNER)).items.shared.title, "A title");
});

test("a repository result with a different owner is never passed to the panel", async (t) => {
  const fixture = await setup(t, { wrongRepositoryOwner: "favorites" });
  const result = await fixture.request("library.get");
  assert.equal(result.ok, true);
  assert.equal(result.payload.favorites, null);
  assert.equal(result.payload.errors.favorites.code, "CONTEXT_MISMATCH");
  assert.equal(result.payload.bookmarks.accountKey, OWNER);
});


test("ordinary active-context and streaming snapshot events never refresh account storage", async (t) => {
  const fixture = await setup(t, { snapshot: "Fresh current title" });
  const result = await fixture.request("snapshot.get-active-context");
  assert.equal(result.ok, true);
  const protocol = fixture.context.TidyProtocol;
  fixture.receiveRuntime(protocol.event(protocol.Type.SNAPSHOT_UPDATED, {
    snapshot: snapshot(fixture.context.TidySnapshot), reason: "streaming",
  }), contentSender, () => {});
  await flush();
  assert.equal(fixture.calls.some((call) => ["get", "transact", "library.account"].includes(call.type)), false);
});

test("one document bootstrap serves repeated library reads, navigation and local writes without further account probes", async (t) => {
  const fixture = await setup(t);
  await fixture.request("library.get");
  for (let index = 0; index < 20; index += 1) {
    assert.equal((await fixture.request("favorites.move", {
      expectedAccountKey: OWNER, conversationId: "shared", groupId: index % 2 ? "study" : "work",
    })).ok, true);
    assert.equal((await fixture.request("favorites.open", { expectedAccountKey: OWNER, conversationId: "shared" })).ok, true);
    fixture.chrome.webNavigation.onHistoryStateUpdated.listener({ tabId: 31, frameId: 0,
      documentId: "document-a", url: `https://chatgpt.com/c/conversation-${index}` });
  }
  assert.equal((await fixture.request("library.get")).ok, true);
  assert.equal(fixture.calls.filter((call) => call.type === "library.account").length, 1);
  assert.equal(fixture.calls.filter((call) => call.type === "library.navigate").length, 20);
  assert.equal(fixture.calls.filter((call) => call.type === "navigate").length, 0, "native navigation never reloads via tabs.update");
});

test("document commits retire old callbacks and leases even when the account returns to the same key", async (t) => {
  const fixture = await setup(t);
  const initial = await fixture.request("library.get");
  fixture.setOwner(OTHER);
  fixture.setOwner(OWNER);
  const rejected = await fixture.request("favorites.move", { expectedAccountKey: OWNER,
    expectedIdentity: plain(initial.payload.identity), conversationId: "shared", groupId: "work" });
  assert.equal(rejected.ok, false);
  assert.equal(fixture.calls.filter((call) => call.type === "transact").length, 0);
  fixture.commit("document-b");
  const renewed = await fixture.request("library.get");
  assert.equal(renewed.ok, true);
  assert.deepEqual(plain(renewed.payload.identity), { documentId: "document-b", epoch: 1 });
  const oldDocument = await fixture.request("favorites.remove", { expectedAccountKey: OWNER,
    expectedIdentity: plain(initial.payload.identity), conversationId: "shared" });
  assert.equal(oldDocument.ok, false);
  assert.equal(fixture.calls.filter((call) => call.type === "library.account").length, 2);
});

test("a queued IndexedDB mutation checks its epoch inside the transaction before changing data", async (t) => {
  const fixture = await setup(t, { beforeMutator({ setOwner }) { setOwner(OTHER); } });
  const result = await fixture.request("favorites.move", { expectedAccountKey: OWNER,
    conversationId: "shared", groupId: "work" });
  assert.equal(result.ok, false);
  assert.equal((await fixture.raw.favorites.get(OWNER)).items.shared.groupId, null);
  assert.equal((await fixture.raw.favorites.get(OTHER)).items.shared.groupId, null);
  assert.equal((await fixture.raw.favorites.get(OWNER)).items.shared.note, "A note");
  assert.equal((await fixture.raw.favorites.get(OTHER)).items.shared.note, "B private note");
});

test("identity events are monotonic, document-targeted and reject old documents, subframes and extension senders", async (t) => {
  const fixture = await setup(t);
  await fixture.request("library.get");
  for (const sender of [panelSender, { ...contentSender, frameId: 3 }, { ...contentSender, documentId: "old-document" },
    { ...contentSender, documentLifecycle: "cached" }]) {
    fixture.receiveRuntime(fixture.context.TidyProtocol.event("library.identity-changed", {
      accountKey: OTHER, epoch: 20, phase: "ready",
    }), sender, () => {});
  }
  assert.equal((await fixture.request("library.get")).payload.accountKey, OWNER);
  fixture.setOwner(OTHER);
  await flush();
  const identityEvents = fixture.broadcasts.filter((entry) => entry.envelope.type === "library.identity-changed");
  assert.deepEqual(identityEvents.map((entry) => entry.target), ["runtime", 31]);
  assert.equal(identityEvents.some((entry) => JSON.stringify(entry).includes("private")), false);
  fixture.receiveRuntime(fixture.context.TidyProtocol.event("library.identity-changed", {
    accountKey: OWNER, epoch: 1, phase: "ready",
  }), contentSender, () => {});
  assert.equal((await fixture.request("library.get")).payload.accountKey, OTHER);
});

test("local actions require an identity lease and navigation falls back only when no native anchor exists", async (t) => {
  const fixture = await setup(t, { navigationResult: { navigated: false, reason: "native-router-unavailable" } });
  const missing = await fixture.request("favorites.open", { expectedAccountKey: OWNER,
    expectedIdentity: null, conversationId: "shared" });
  assert.equal(missing.ok, false);
  assert.equal(fixture.calls.length, 0);
  assert.equal((await fixture.request("favorites.open", { expectedAccountKey: OWNER, conversationId: "shared" })).ok, true);
  assert.equal(fixture.calls.filter((call) => call.type === "navigate").length, 1);
  for (const reason of ["context-mismatch", "unknown-native-failure", "navigation-in-progress"]) {
    const other = await setup(t, { navigationResult: { navigated: false, reason } });
    assert.equal((await other.request("favorites.open", { expectedAccountKey: OWNER, conversationId: "shared" })).ok, false);
    assert.equal(other.calls.filter((call) => call.type === "navigate").length, 0);
  }
});

test("parallel and delayed same-target fallbacks dispatch one full navigation until the document commit", async (t) => {
  const fixture = await setup(t, { navigationResult: { navigated: false, reason: "native-router-unavailable" } });
  const payload = { expectedAccountKey: OWNER, conversationId: "shared", navigationIntentId: "same-request" };
  const pair = await Promise.all([fixture.request("favorites.open", payload), fixture.request("favorites.open", payload)]);
  assert.ok(pair.every((result) => result.ok));
  assert.equal((await fixture.request("favorites.open", payload)).ok, true);
  assert.equal(fixture.calls.filter((call) => call.type === "navigate").length, 1);
  assert.equal(fixture.calls.filter((call) => call.type === "library.navigate").length, 1);
  fixture.commit("document-b");
  assert.equal((await fixture.request("favorites.open", { ...payload, navigationIntentId: "new-document-request" })).ok, true);
  assert.equal(fixture.calls.filter((call) => call.type === "navigate").length, 2);
});

test("a snapshot identity mismatch is not swallowed as optional missing metadata", async (t) => {
  const fixture = await setup(t, { snapshotIdentityChanged: true });
  const result = await fixture.request("library.get");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CONTEXT_MISMATCH");
  assert.equal(fixture.calls.some((call) => ["get", "transact"].includes(call.type)), false);
  const snapshotCall = fixture.calls.find((call) => call.type === "snapshot.get");
  assert.deepEqual(plain(snapshotCall.payload.expectedLibraryIdentity), { accountKey: OWNER, epoch: 1 });
  assert.deepEqual(plain(snapshotCall.target), { documentId: "document-a" });
});

test("only an explicit panel retry can reopen failed identity initialization, and ready retries remain cached", async (t) => {
  const fixture = await setup(t, { onAccountRead: async ({ index }) => index === 1 ? null : OWNER });
  assert.equal((await fixture.request("library.get")).ok, false);
  assert.equal(fixture.calls.find((call) => call.type === "library.account").payload.retry, false);
  assert.equal((await fixture.request("library.get", { retryIdentity: true })).ok, true);
  assert.equal(fixture.calls.filter((call) => call.type === "library.account")[1].payload.retry, true);
  assert.equal((await fixture.request("library.get", { retryIdentity: true })).ok, true);
  assert.equal(fixture.calls.filter((call) => call.type === "library.account").length, 2);
  const content = await setup(t);
  assert.equal((await content.request("library.get", { retryIdentity: true }, contentSender)).ok, true);
  assert.equal(content.calls.find((call) => call.type === "library.account").payload.retry, false);
});

test("a rejected browser navigation releases its latch without automatic retry, allowing the next explicit click", async (t) => {
  let attempts = 0;
  const fixture = await setup(t, { navigationResult: { navigated: false, reason: "native-router-unavailable" },
    onNavigate: () => { if (++attempts === 1) throw new Error("Tabs cannot be edited right now"); } });
  const payload = { expectedAccountKey: OWNER, conversationId: "shared" };
  assert.equal((await fixture.request("favorites.open", payload)).ok, false);
  await flush();
  assert.equal(attempts, 1, "no automatic retry after browser rejection");
  assert.equal((await fixture.request("favorites.open", payload)).ok, true);
  assert.equal(attempts, 2);
});

test("non-active prerender commits cannot revoke the currently visible document's library", async (t) => {
  const fixture = await setup(t);
  const first = await fixture.request("library.get");
  fixture.chrome.webNavigation.onCommitted.listener({ tabId: 31, frameId: 0, documentId: "prerendered-document",
    documentLifecycle: "prerender", url: contentSender.url });
  const result = await fixture.request("favorites.move", { expectedAccountKey: OWNER,
    expectedIdentity: plain(first.payload.identity), conversationId: "shared", groupId: "work" });
  assert.equal(result.ok, true);
  assert.equal((await fixture.raw.favorites.get(OWNER)).items.shared.groupId, "work");
  assert.equal(fixture.calls.filter((call) => call.type === "library.account").length, 1);
});

test("an active document identity event repairs a missed commit only after Chrome proves that exact document", async (t) => {
  const fixture = await setup(t);
  await fixture.request("library.get");
  fixture.activateDocumentWithoutCommit("activated-document");
  fixture.receiveRuntime(fixture.context.TidyProtocol.event("library.identity-changed", {
    accountKey: OTHER, epoch: 2, phase: "ready",
  }), { ...contentSender, documentId: "activated-document" }, () => {});
  await flush();
  const result = await fixture.request("library.get", { expectedIdentity: null });
  assert.equal(result.ok, true);
  assert.equal(result.payload.accountKey, OTHER);
  assert.equal(result.payload.identity.documentId, "activated-document");
  assert.equal(fixture.calls.filter((call) => call.type === "library.account").length, 1, "accepted signal initializes the new active document without another probe");
});

test("bookmark OPEN probes the exact message or requests one native data load",async(t)=>{
  for(const mounted of [true,false]){
    const fixture=await setup(t,{navigationResult: { navigated: false, reason: "native-router-unavailable" }, tabUrl:mounted?undefined:"https://chatgpt.com/c/origin"});
    const result=await fixture.request("bookmarks.open",{expectedAccountKey:OWNER,bookmarkId:"shared::message"});
    assert.equal(result.ok,true);assert.equal(result.payload.pending,true);assert.equal(result.payload.located,false);
    assert.equal(result.payload.mode,mounted?"settling":"full-page");assert.equal(result.payload.bookmarkId,"shared::message");
    assert.equal(fixture.calls.filter(c=>c.type==="snapshot.message-locate").length,1);
    const full=fixture.calls.filter(c=>c.type==="navigate");assert.equal(full.length,mounted?0:1);
    if(!mounted){const url=new URL(full[0].url);assert.equal(url.searchParams.get("messageId"),"message");assert.equal(url.searchParams.has("historySearchQuery"),false);}
  }
});

test("bookmark commit before browser acknowledgement keeps the original intent and budget",async(t)=>{
  let fixture;fixture=await setup(t,{navigationResult: { navigated: false, reason: "native-router-unavailable" }, tabUrl:"https://chatgpt.com/c/origin",onNavigate:({update})=>fixture.commit("destination-document",update.url)});
  const result=await fixture.request("bookmarks.open",{expectedAccountKey:OWNER,bookmarkId:"shared::message"});
  assert.equal(result.ok,true);assert.equal(result.payload.mode,"full-page");
  const ticket=vm.runInContext("readNavigationState(31)",fixture.context);
  assert.equal(ticket.sourceDocumentId,"document-a");assert.equal(ticket.committedDocumentId,"destination-document");
  assert.equal(result.payload.navigationIntentId,ticket.id);assert.equal(fixture.calls.filter(c=>c.type==="navigate").length,1);
});

test("rejected full-page bookmark dispatch never returns a handoff receipt or retries automatically", async (t) => {
  const fixture = await setup(t, { tabUrl: "https://chatgpt.com/c/origin",
    navigationResult: { navigated: false, reason: "native-router-unavailable" },
    onNavigate: () => { throw new Error("Browser rejected navigation"); },
  });
  const result = await fixture.request("bookmarks.open", { expectedAccountKey: OWNER, bookmarkId: "shared::message" });
  assert.equal(result.ok, false);
  assert.equal(result.payload, undefined);
  await flush();
  assert.equal(fixture.calls.filter(call => call.type === "navigate").length, 1);
  assert.equal(vm.runInContext("readNavigationState(31).cancelled", fixture.context), true, "Admission error must retire its deadline as well as its reply");
});

test("duplicate bookmark OPEN transport shares one message execution and one data load", async t => {
  const held = deferred(), entered = deferred();
  const fixture = await setup(t, { navigationResult: { navigated: false, reason: "native-router-unavailable" }, tabUrl: "https://chatgpt.com/c/origin", onLocate: () => { entered.resolve(); return held.promise; } });
  const payload = { expectedAccountKey: OWNER, bookmarkId: "shared::message", navigationIntentId: "one-click" };
  const first = fixture.request("bookmarks.open", payload); await entered.promise;
  const second = fixture.request("bookmarks.open", payload); for (let n = 0; n < 8; n++) await flush();
  held.resolve({ located: false, pending: true, targetPresent: false });
  assert.ok((await Promise.all([first, second])).every(r => r.ok));
  assert.equal(fixture.calls.filter(c => c.type === "snapshot.message-locate").length, 1);
  assert.equal(fixture.calls.filter(c => c.type === "navigate").length, 1);
});

async function seedNavigationTargets(fixture) {
  await fixture.raw.favorites.transact(OWNER, (state) => ({ ...state, revision: state.revision + 1,
    items: { ...state.items, ...Object.fromEntries(["alpha", "bravo"].map((id) => [id,
      { ...state.items.shared, conversationId: id, routePath: `/c/${id}` }])) } }));
  await fixture.raw.bookmarks.transact(OWNER, (state) => ({ ...state, revision: state.revision + 1,
    items: { ...state.items, ...Object.fromEntries(["alpha", "bravo"].map((id) => [`${id}::message`,
      { ...state.items["shared::message"], bookmarkId: `${id}::message`, conversationId: id, routePath: `/c/${id}` }])) } }));
  assert.equal((await fixture.request("library.account")).ok, true);
}

function navigationClick(fixture, kind, id) {
  return fixture.request(kind === "count" ? "bookmarks.open-conversation-view" : `${kind}.open`,
    { expectedAccountKey: OWNER, ...(kind === "bookmarks" ? { bookmarkId: `${id}::message` } : { conversationId: id }) },
    kind === "count" ? contentSender : panelSender);
}

function navigationSnapshot(value) {
  return { ...value, sidebarConversations: ["alpha", "bravo"].map((id) => ({ ...value.conversation,
    conversationId: id, locator: { strategy: "href", value: `/c/${id}` } })) };
}

test("latest library click wins before repository or count-snapshot completion, including real native anchor dispatch", async (t) => {
  for (const earlier of ["bookmarks", "favorites", "count"]) {
    for (const later of ["bookmarks", "favorites", "count"]) await t.test(`${earlier} A then ${later} B`, async (t) => {
      const held = deferred(), entered = deferred(); let blocked = false;
      const hold = async () => { if (!blocked) { blocked = true; entered.resolve(); await held.promise; } };
      const fixture = await setup(t, { tabUrl: "https://chatgpt.com/c/origin", nativeTargets: ["alpha", "bravo"],
        onRepositoryGet: async ({ kind, when }) => { if (earlier === kind && when === "before") await hold(); },
        onSnapshot: async ({ snapshot }) => { if (earlier === "count") await hold(); return navigationSnapshot(snapshot); },
      });
      await seedNavigationTargets(fixture);
      const old = navigationClick(fixture, earlier, "alpha"); await entered.promise;
      const newest = await navigationClick(fixture, later, "bravo");
      assert.equal(newest.ok, true, JSON.stringify(newest.error));
      assert.equal(new URL(fixture.pageLocation.href).pathname, "/c/bravo");
      held.resolve(); const stale = await old;
      assert.equal(stale.ok, false); assert.equal(stale.error.code, "CONTEXT_MISMATCH");
      assert.deepEqual(fixture.calls.filter(call => call.type === "native-router").map(call => call.pathname), ["/c/bravo"]);
      assert.equal(fixture.calls.filter(call => call.type === "library.navigate").length, 1);
      assert.equal(fixture.calls.filter(call => call.type === "navigate").length, 0);
      assert.equal(new URL(fixture.pageLocation.href).pathname, "/c/bravo", "settling A cannot pull the actual page back from B");
      const routeEvents = fixture.broadcasts.filter(call => call.envelope.type === "panel.route-requested");
      assert.equal(routeEvents.some(call => call.envelope.payload.conversationId === "alpha"), false);
    });
  }
});

test("one tab's latest navigation spans search, favorites, bookmarks and count instead of four independent lanes", async (t) => {
  for (const earlier of ["search", "bookmarks", "favorites", "count"]) {
    for (const later of ["search", "bookmarks", "favorites", "count"]) await t.test(`${earlier} A then ${later} B`, async (t) => {
      const held = deferred(), entered = deferred(); let blocked = false;
      const hold = async () => { if (!blocked) { blocked = true; entered.resolve(); await held.promise; } };
      const fixture = await setup(t, { tabUrl: "https://chatgpt.com/c/origin", nativeTargets: ["alpha", "bravo"],
        onRepositoryGet: async ({ kind, when }) => { if (earlier === kind && when === "before") await hold(); },
        onSnapshot: async ({ snapshot }) => { if (earlier === "count") await hold(); return navigationSnapshot(snapshot); },
        // Keyword search no longer executes Tidy's locator. Hold the real
        // adapter's identity read, before its official SPA router dispatch.
        onNativeRead: async ({ accountKey, epoch }) => {
          if (earlier === "search") await hold();
          return { accountKey, epoch };
        },
      });
      await seedNavigationTargets(fixture);
      const click = (kind, id) => kind === "search" ? fixture.request("search.open-result", {
        navigationKind: "keyword", resultId: `result-${id}`, conversationId: id, messageId: "message", query: "fixture",
      }) : navigationClick(fixture, kind, id);
      const old = click(earlier, "alpha"); await entered.promise;
      const newest = await click(later, "bravo"); assert.equal(newest.ok, true, JSON.stringify(newest.error));
      held.resolve(); await old;
      const native = fixture.calls.filter(call => call.type === "native-router");
      const full = fixture.calls.filter(call => call.type === "navigate");
      assert.equal(native.length + full.length, 1, "the obsolete module cannot perform a second physical navigation");
      assert.equal(native.some(call => new URL(call.pathname, fixture.pageLocation.origin).pathname === "/c/alpha")
        || full.some(call => new URL(call.url).pathname === "/c/alpha"), false);
      const destination = new URL(native[0].pathname, fixture.pageLocation.origin);
      assert.equal(destination.pathname, "/c/bravo", "Search shares the same native route entry");
      assert.equal(full.length, 0, "search must not introduce a reload fallback into shared click ordering");
      if (later === "search") {
        assert.equal(destination.searchParams.get("src"), "history_search");
        assert.equal(destination.searchParams.get("messageId"), "message");
        assert.equal(destination.searchParams.get("historySearchQuery"), "fixture");
        assert.equal(newest.payload.presentationOwner, "native");
        assert.equal(newest.payload.navigated, true);
      }
    });
  }
});

test("a newer bookmark execution cannot be overwritten by an older failed native search dispatch",async(t)=>{
  const held=deferred(),entered=deferred();const fixture=await setup(t,{onLibraryNavigate:async({envelope})=>{
    if(envelope.payload.placement==="native-search"){entered.resolve();return held.promise;}
    return {navigated:true};
  }});
  const old=fixture.request("search.open-result",{navigationKind:"keyword",resultId:"old",conversationId:"old-search",messageId:"old-message",query:"fixture"});await entered.promise;
  const opened=await fixture.request("bookmarks.open",{expectedAccountKey:OWNER,bookmarkId:"shared::message"});assert.equal(opened.ok,true);
  held.resolve({navigated:false,reason:"native-router-unavailable"});await old;
  assert.equal(fixture.calls.filter(c=>c.type==="navigate").length,0);
  assert.deepEqual(fixture.calls.filter(c=>c.type==="snapshot.message-locate").map(c=>c.payload.messageId),["message"],
    "only the newer bookmark owns a Tidy message locator");
  assert.equal(vm.runInContext("readNavigationState(31).id",fixture.context),opened.payload.navigationIntentId);
});

test("an unrelated native route retires pending searches and saved-library reads before final physical dispatch", async (t) => {
  for (const kind of ["search", "bookmarks", "favorites", "count"]) await t.test(kind, async (t) => {
    const held = deferred(), entered = deferred(); let blocked = false;
    const hold = async () => { if (!blocked) { blocked = true; entered.resolve(); await held.promise; } };
    const fixture = await setup(t, { tabUrl: "https://chatgpt.com/c/origin", nativeTargets: ["alpha", "bravo"],
      onRepositoryGet: async ({ kind: store, when }) => { if (kind === store && when === "before") await hold(); },
      onSnapshot: async ({ snapshot }) => { if (kind === "count") await hold(); return navigationSnapshot(snapshot); },
      onNativeRead: async ({ accountKey, epoch }) => { if (kind === "search") await hold(); return { accountKey, epoch }; },
    });
    await seedNavigationTargets(fixture);
    const old = kind === "search" ? fixture.request("search.open-result", { navigationKind: "keyword", resultId: "old", conversationId: "alpha", messageId: "message", query: "fixture" })
      : navigationClick(fixture, kind, "alpha");
    await entered.promise;
    fixture.pageLocation.href = "https://chatgpt.com/c/native-choice";
    fixture.chrome.webNavigation.onHistoryStateUpdated.listener({ tabId: 31, frameId: 0, documentId: "document-a",
      documentLifecycle: "active", url: fixture.pageLocation.href });
    held.resolve(); await old;
    assert.equal(fixture.calls.some(call => ["native-router", "navigate"].includes(call.type)), false);
    assert.equal(fixture.pageLocation.href, "https://chatgpt.com/c/native-choice");
  });
});

test("click ordering is captured before the very first configured-panel await", async (t) => {
  const held = deferred(), entered = deferred(); let armed = false;
  const fixture = await setup(t, { tabUrl: "https://chatgpt.com/c/origin", nativeTargets: ["alpha", "bravo"],
    onPanelOptions: async () => { if (armed) { armed = false; entered.resolve(); await held.promise; } },
  });
  await seedNavigationTargets(fixture); armed = true;
  const old = navigationClick(fixture, "favorites", "alpha"); await entered.promise;
  assert.equal((await navigationClick(fixture, "favorites", "bravo")).ok, true);
  held.resolve(); assert.equal((await old).error.code, "CONTEXT_MISMATCH");
  assert.deepEqual(fixture.calls.filter(call => call.type === "native-router").map(call => call.pathname), ["/c/bravo"]);
  assert.equal(fixture.calls.filter(call => call.type === "get" && call.kind === "favorites").length, 1, "only the current click reads its favorite");
});

test("malformed or unrelated navigation senders cannot retire a valid pending click", async (t) => {
  const held = deferred(), entered = deferred(); let blocked = false;
  const fixture = await setup(t, { tabUrl: "https://chatgpt.com/c/origin", nativeTargets: ["alpha", "bravo"],
    onRepositoryGet: async ({ when }) => { if (when === "before" && !blocked) { blocked = true; entered.resolve(); await held.promise; } },
  });
  await seedNavigationTargets(fixture);
  const old = navigationClick(fixture, "favorites", "alpha"); await entered.promise;
  for (const [payload, sender] of [
    [{ conversationId: "bravo" }, { url: "chrome-extension://tidy-test/other.html" }],
    [{ conversationId: "bravo" }, { ...contentSender, frameId: 2 }],
    [{ conversationId: "bravo" }, { ...contentSender, documentLifecycle: "cached" }],
    [{ conversationId: "bravo", expectedTabId: 32 }, panelSender],
    [{ conversationId: "bravo", expectedIdentity: null }, panelSender],
    [{ conversationId: "bravo", expectedAccountKey: "" }, panelSender],
    [{ conversationId: "bravo/invalid" }, panelSender],
  ]) {
    const rejected = await fixture.request("favorites.open", { expectedAccountKey: OWNER, ...payload }, sender);
    assert.equal(rejected.ok, false);
  }
  held.resolve(); assert.equal((await old).ok, true);
  assert.deepEqual(fixture.calls.filter(call => call.type === "native-router").map(call => call.pathname), ["/c/alpha"]);
});

test("a newer different target replaces an old in-flight no-anchor fallback", async (t) => {
  const held = deferred(), entered = deferred();
  const fixture = await setup(t, { tabUrl: "https://chatgpt.com/c/origin",
    onLibraryNavigate: async ({ envelope }) => { if (envelope.payload.conversationId === "alpha") { entered.resolve(); await held.promise; }
      return { navigated: false, reason: "native-router-unavailable" }; },
  });
  await seedNavigationTargets(fixture);
  const old = navigationClick(fixture, "favorites", "alpha"); await entered.promise;
  const newest = await navigationClick(fixture, "favorites", "bravo");
  assert.equal(newest.ok, true, JSON.stringify(newest.error));
  held.resolve(); const stale = await old;
  assert.equal(stale.ok, false); assert.equal(stale.error.code, "CONTEXT_MISMATCH");
  assert.equal(fixture.calls.filter(call => call.type === "library.navigate").length, 2);
  assert.deepEqual(fixture.calls.filter(call => call.type === "navigate").map(call => new URL(call.url).pathname), ["/c/bravo"]);
});

test("a newer control for the same physical target owns the only accepted full-page dispatch", async (t) => {
  const held = deferred(), entered = deferred();
  const fixture = await setup(t, { tabUrl: "https://chatgpt.com/c/origin",
    onLibraryNavigate: async () => { entered.resolve(); await held.promise; return { navigated: false, reason: "native-router-unavailable" }; },
  });
  await seedNavigationTargets(fixture);
  const old = navigationClick(fixture, "favorites", "alpha"); await entered.promise;
  const newest = navigationClick(fixture, "bookmarks", "alpha");
  for (let index = 0; index < 6; index++) await flush();
  held.resolve(); const [a, b] = await Promise.all([old, newest]);
  assert.equal(a.ok, false); assert.equal(a.error.code, "CONTEXT_MISMATCH");
  assert.equal(b.ok, true, JSON.stringify(b.error));
  assert.equal(b.payload.mode,"full-page");
  assert.equal(fixture.calls.filter(call=>call.type==="library.navigate").length,2);
  assert.equal(fixture.calls.filter(call=>call.type==="snapshot.message-locate").length,1);
  assert.equal(fixture.calls.filter(call=>call.type==="navigate").length,1);
});

test("removing a tab clears its navigation ticket and prevents delayed dispatch", async (t) => {
  const held = deferred(), entered = deferred(); let blocked = false;
  const fixture = await setup(t, { tabUrl: "https://chatgpt.com/c/origin", nativeTargets: ["alpha"],
    onRepositoryGet: async ({ when }) => { if (when === "before" && !blocked) { blocked = true; entered.resolve(); await held.promise; } },
  });
  await seedNavigationTargets(fixture);
  const pending = navigationClick(fixture, "favorites", "alpha"); await entered.promise;
  assert.equal(vm.runInContext("navigationStateCount()", fixture.context), 1);
  fixture.chrome.tabs.onRemoved.listener(31);
  assert.equal(vm.runInContext("navigationStateCount()", fixture.context), 0);
  held.resolve(); assert.equal((await pending).ok, false);
  assert.equal(fixture.calls.some(call => call.type === "native-router" || call.type === "navigate"), false);
});

test("bookmark OPEN installs the admitted owner and dispatches one shared exact-document executor",async(t)=>{
  const fixture=await setup(t);const result=await fixture.request("bookmarks.open",{expectedAccountKey:OWNER,bookmarkId:"shared::message"});
  assert.equal(result.ok,true);const locate=fixture.calls.find(c=>c.type==="snapshot.message-locate");
  assert.deepEqual(plain(locate.target),{documentId:"document-a"});assert.equal(locate.payload.navigationIntentId,result.payload.navigationIntentId);
  assert.equal(locate.payload.navigationControl.ownerAccountKey,OWNER);assert.equal(locate.payload.messageId,"message");
  assert.equal(locate.payload.conversationId,"shared");assert.equal(locate.payload.query,"");
  assert.equal(locate.payload.deadlineAt-locate.payload.loadDeadlineAt,2400);assert.equal(locate.payload.waitForTarget,false);
  assert.equal(fixture.calls.filter(c=>c.type==="library.account").length,1);assert.equal(fixture.calls.some(c=>c.type==="snapshot.get"),false);
  const retired=await fixture.request("bookmarks.locate",{});assert.equal(retired.ok,false);
});

test("a document or identity change during bookmark target read prevents executor dispatch",async(t)=>{
  for(const change of ["document","identity"]){let fixture;
    fixture=await setup(t,{onRepositoryGet:({kind,when})=>{if(kind==="bookmarks"&&when==="after"){
      if(change==="document")fixture.commit("document-b");else fixture.setOwner(OTHER);
    }}});
    const result=await fixture.request("bookmarks.open",{expectedAccountKey:OWNER,bookmarkId:"shared::message"});
    assert.equal(result.ok,false);assert.equal(result.error.code,"CONTEXT_MISMATCH");assert.equal(fixture.calls.some(c=>c.type==="snapshot.message-locate"),false);
  }
});

test("worker intent controls fence an obsolete native-anchor read, not only its later response", async (t) => {
  const held = deferred(), entered = deferred(); let reads = 0;
  const fixture = await setup(t, { tabUrl: "https://chatgpt.com/c/origin", nativeTargets: ["alpha", "bravo"],
    onNativeRead: ({ accountKey, epoch }) => { if (++reads === 1) { entered.resolve(); return held.promise; } return { accountKey, epoch }; },
  });
  await seedNavigationTargets(fixture);
  const old = navigationClick(fixture, "favorites", "alpha"); await entered.promise;
  const newest = await navigationClick(fixture, "favorites", "bravo");
  assert.equal(newest.ok, true, JSON.stringify(newest.error));
  held.resolve({ accountKey: OWNER, epoch: 1 });
  assert.equal((await old).ok, false);
  assert.deepEqual(fixture.calls.filter(call => call.type === "native-router").map(call => call.pathname), ["/c/bravo"]);
  assert.equal(new URL(fixture.pageLocation.href).pathname, "/c/bravo");
});

test("exact cancellation before a pending OPEN acknowledgement prevents its final physical action", async (t) => {
  for (const reason of ["route-away", "hidden", "page-hidden", "identity-changed"]) await t.test(reason, async (t) => {
    const held = deferred(), entered = deferred(); let blocked = false;
    const fixture = await setup(t, { tabUrl: "https://chatgpt.com/c/origin", nativeTargets: ["alpha"],
      onRepositoryGet: async ({ when }) => { if (when === "before" && !blocked) { blocked = true; entered.resolve(); await held.promise; } },
    });
    await seedNavigationTargets(fixture);
    const pending = fixture.request("favorites.open", { expectedAccountKey: OWNER, conversationId: "alpha", navigationIntentId: "pending-open" });
    await entered.promise;
    const rejected = await fixture.request("navigation.cancelled", { navigationIntentId: "unrelated-id", reason });
    assert.equal(rejected.payload.cancelled, false);
    const cancelled = await fixture.request("navigation.cancelled", { navigationIntentId: "pending-open", reason });
    assert.equal(cancelled.payload.cancelled, true);
    held.resolve(); assert.equal((await pending).ok, false);
    assert.equal(fixture.calls.some(call => call.type === "native-router" || call.type === "navigate"), false);
    const broadcast = fixture.broadcasts.find(call => call.target === "runtime" && call.envelope.type === "navigation.cancelled");
    assert.deepEqual(broadcast.envelope.payload, { tabId: 31, navigationIntentId: "pending-open", reason });
  });
});

test("bookmark loading retains one ingress budget across slow storage reads",async(t)=>{
  for(const elapsed of [1900,16000,30000,34000])await t.test(String(elapsed),async(t)=>{
    let now=10000;class Clock extends Date{static now(){return now;}}
    const fixture=await setup(t,{clock:Clock,onRepositoryGet:({kind,when})=>{if(kind==="bookmarks"&&when==="after")now+=elapsed;}});
    const result=await fixture.request("bookmarks.open",{expectedAccountKey:OWNER,bookmarkId:"shared::message"});assert.equal(result.ok,true);
    const calls=fixture.calls.filter(c=>c.type==="snapshot.message-locate");
    if(elapsed<30000){assert.equal(calls.length,1);assert.equal(calls[0].payload.loadDeadlineAt,40000);assert.equal(calls[0].payload.deadlineAt,42400);}
    else{assert.equal(calls.length,0);assert.equal(result.payload.reason,"target-timeout");}
  });
});

test("an official initial history-search URL never acquires a worker-owned locator", async (t) => {
  const url = "https://chatgpt.com/c/shared?src=history_search&messageId=message&historySearchQuery=needle";
  const fixture = await setup(t, { tabUrl: url, nativeTargets: [] });
  assert.equal(vm.runInContext("navigation.acceptNative", fixture.context), undefined);
  assert.equal(fixture.context.TidyProtocol.Type.NAVIGATION_REQUESTED, undefined,
    "the obsolete official-URL nomination protocol must not retain a hidden ingress");
  fixture.commit("official-search-document", url);
  fixture.chrome.webNavigation.onHistoryStateUpdated.listener({ tabId: 31, frameId: 0, documentId: "official-search-document",
    documentLifecycle: "active", url: "https://chatgpt.com/c/shared" });
  for (let index = 0; index < 4; index++) await flush();
  assert.equal(vm.runInContext("navigationStateCount()", fixture.context), 0);
  assert.equal(fixture.calls.some(call => ["snapshot.message-locate", "library.navigate", "navigate", "native-router"].includes(call.type)), false);
  assert.equal(fixture.broadcasts.some(call => call.envelope.type === "navigation.result"), false);
  assert.doesNotMatch(source("src/app/background/service-worker.js"), /navigation\.acceptNative|Type\.NAVIGATION_REQUESTED/);
  assert.doesNotMatch(source("src/app/page/isolated.js"), /Type\.NAVIGATION_REQUESTED/);
});

test("an accepted keyword result delegates presentation and never creates a full-page locator handoff", async (t) => {
  const fixture = await setup(t, { tabUrl: "https://chatgpt.com/c/origin", nativeTargets: ["shared"] });
  const opened = await fixture.request("search.open-result", {
    navigationKind: "keyword", conversationId: "shared", resultId: "hit", messageId: "message", query: "needle",
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.payload.presentationOwner, "native");
  assert.equal(opened.payload.navigated, true);
  assert.equal(opened.payload.mode, "same-document");
  assert.equal(Object.hasOwn(opened.payload, "located"), false,
    "router acceptance does not prove that official positioning has completed");
  const dispatches = fixture.calls.filter(call => call.type === "library.navigate");
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].payload.placement, "native-search");
  assert.equal(dispatches[0].payload.messageId, "message");
  assert.equal(dispatches[0].payload.query, "needle");
  const destination = new URL(fixture.pageLocation.href);
  assert.equal(destination.pathname, "/c/shared");
  assert.equal(destination.searchParams.get("src"), "history_search");
  assert.equal(destination.searchParams.get("messageId"), "message");
  assert.equal(destination.searchParams.get("historySearchQuery"), "needle");
  fixture.commit("unrelated-manual-reload", destination.href);
  const sender = { ...contentSender, tab: { id: 31, url: destination.href }, url: destination.href,
    documentId: "unrelated-manual-reload" };
  fixture.receiveRuntime(fixture.context.TidyProtocol.event("library.identity-changed", {
    accountKey: OWNER, epoch: 1, phase: "ready",
  }), sender, () => {});
  for (let index = 0; index < 4; index++) await flush();
  assert.equal(fixture.calls.some(call => ["snapshot.message-locate", "navigate"].includes(call.type)), false,
    "neither source nor replacement document receives a Tidy locator or forced reload");
  assert.equal(fixture.broadcasts.some(call => call.envelope.type === "navigation.result"), false);
});

test("an unrelated official search can retire a pending panel click without starting its own Tidy executor", async (t) => {
  const url = "https://chatgpt.com/c/official-choice?src=history_search&messageId=message&historySearchQuery=needle";
  const held = deferred(), entered = deferred(); let first = true;
  const fixture = await setup(t, { tabUrl: "https://chatgpt.com/c/origin", nativeTargets: ["newer"], onTabGet: async () => {
    if (first) { first = false; entered.resolve(); await held.promise; }
  } });
  const explicit = fixture.request("search.open-result", {
    navigationKind: "keyword", conversationId: "newer", resultId: "new", messageId: "new-message", query: "new-query",
  });
  await entered.promise;
  fixture.pageLocation.href = url;
  fixture.chrome.webNavigation.onHistoryStateUpdated.listener({ tabId: 31, frameId: 0, documentId: "document-a",
    documentLifecycle: "active", url });
  held.resolve();
  assert.equal((await explicit).ok, false);
  assert.equal(fixture.pageLocation.href, url);
  assert.equal(vm.runInContext("navigation.acceptNative", fixture.context), undefined);
  assert.equal(fixture.calls.some(call => ["snapshot.message-locate", "library.navigate", "navigate", "native-router"].includes(call.type)), false);
  assert.equal(fixture.broadcasts.some(call => call.envelope.type === "navigation.result"), false);
});

test("a title-only keyword hit keeps native search ownership without inventing a message locator", async (t) => {
  const fixture = await setup(t, { tabUrl: "https://chatgpt.com/c/origin", nativeTargets: ["shared"] });
  const opened = await fixture.request("search.open-result", {
    navigationKind: "keyword", conversationId: "shared", resultId: "title-hit", messageId: null, query: "needle",
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.payload.presentationOwner, "native");
  assert.equal(opened.payload.navigated, true);
  const call = fixture.calls.find(row => row.type === "library.navigate");
  assert.equal(call.payload.placement, "native-search");
  assert.equal(call.payload.messageId, null);
  assert.equal(call.payload.query, "needle");
  const url = new URL(fixture.pageLocation.href);
  assert.equal(url.searchParams.get("src"), "history_search");
  assert.equal(url.searchParams.has("messageId"), false);
  assert.equal(url.searchParams.get("historySearchQuery"), "needle");
  assert.equal(fixture.calls.some(row => ["snapshot.message-locate", "navigate"].includes(row.type)), false);
  assert.equal(fixture.broadcasts.some(row => row.envelope.type === "navigation.result"), false);
});

test("date conversation results request latest presentation and never borrow native keyword parameters", async (t) => {
  const fixture = await setup(t, { tabUrl: "https://chatgpt.com/c/origin", nativeTargets: ["shared"] });
  const opened = await fixture.request("search.open-result", {
    navigationKind: "conversation", conversationId: "shared", resultId: "date-hit", messageId: null, query: "",
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.payload.navigated, true);
  assert.equal(opened.payload.pending, true);
  assert.equal(opened.payload.presentationOwner, undefined);
  const call = fixture.calls.find(row => row.type === "library.navigate");
  assert.equal(call.payload.placement, "latest");
  assert.equal(call.payload.messageId, undefined);
  assert.equal(call.payload.query, undefined);
  assert.equal(fixture.calls.filter(row => row.type === "native-router").length, 1);
  assert.equal(new URL(fixture.pageLocation.href).pathname, "/c/shared");
  assert.equal(new URL(fixture.pageLocation.href).search, "");
  assert.equal(fixture.calls.some(row => row.type === "navigate"), false);
});
