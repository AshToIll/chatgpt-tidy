const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { snapshotHarness } = require("./helpers/adapter-snapshot.cjs");
const { createWorkerModuleLoader } = require("./helpers/worker-runtime.cjs");
const { installPageSession } = require("./helpers/page-session.cjs");
const root = path.resolve(__dirname, "..");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const panelSender = { url: "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=31" };

function load(options = {}) {
  const pageSender = { tab: { id: 31 }, frameId: 0, documentId: "doc-31", documentLifecycle: "active", url: "https://chatgpt.com/c/current" };
  let receiveWorker;
  let receiveIsolated;
  let receiveWindow;
  let counter = 0;
  let snapshotCalls = 0;
  let identityCalls = 0;
  let offscreenCreated = false;
  const calls = [];
  const projections = [];
  const records = new Map();
  const delayedWriteReplies = [];
  let titleSettings = { mode: "range", dateFormat: "iso" };
  const timers = [];
  const current = { conversationId: "current", title: options.currentTitle || "Original", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z" };
  const identity = { accountKey: "user-1", workspaceKey: "personal" };
  const targets = new Map([current, ...(options.rows || [])].map((row) => [row.conversationId, row]));
  const event = () => ({ addListener() {} });
  // A controllable worker clock exercises expiry without sleeping or changing
  // the date model's actual parsing / constructor behavior.
  class WorkerDate extends Date { static now() { return options.now ?? Date.now(); } }
  const base = { console, URL, URLSearchParams, Intl, Date: WorkerDate, Math,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}` } };
  const snapshot = snapshotHarness({
    url: options.url || "https://chatgpt.com/c/current",
    sidebar: [{ href: "/c/current", title: current.title, record: {
      id: "current", title: current.title, create_time: 1_700_000_000, update_time: 1_700_000_001,
    } }],
  });
  if (options.snapshotId) snapshot.conversation.conversationId = options.snapshotId;
  if (options.bound === false) {
    snapshot.conversation.bindingStatus = "route-only";
    for (const field of ["title", "createdAt", "updatedAt"]) {
      snapshot.conversation[field] = { value: null, source: null, status: "missing" };
    }
    snapshot.messages = [];
  }
  const worker = vm.createContext({ ...base,
    assertAccountKey: (value) => { assert.equal(typeof value, "string"); assert.ok(value.trim()); return value; },
    // Title setup may load navigation code, but may not allocate its epoch.
    createNavigationEpochAllocator: () => async () => { throw new Error("This non-navigation test must not allocate a navigation epoch"); },
    createConversationCatalogRepository: () => ({
      getRow: async (accountKey, id) => {
        options.onCatalogRowRead?.(accountKey, id);
        const row = accountKey === "catalog-user-1" && targets.get(id);
        return row ? { ...row, createdAt: Date.parse(row.createdAt), updatedAt: Date.parse(row.updatedAt) } : null;
      },
      acceptTitleChange: async (accountKey, change, isCurrent) => {
        await options.onTitleChange?.(accountKey, plain(change));
        if (options.failProjection) throw new Error("Catalog projection unavailable");
        const row = accountKey === "catalog-user-1" && targets.get(change.conversationId);
        if (!row || !isCurrent()) return false;
        row.title = change.title;
        projections.push({ accountKey, change: plain(change) });
        return true;
      },
      getSnapshot: async (accountKey) => {
        options.onCatalogRead?.();
        return { rows: accountKey === "catalog-user-1" ? [...targets.values()].map(row => ({ ...row,
          createdAt: options.completeCatalog !== false ? Date.parse(row.createdAt) : null,
          updatedAt: options.completeCatalog !== false ? Date.parse(row.updatedAt) : null })) : [],
          state: options.catalogState || { accountKey } };
      },
      observeTitles: async (accountKey, observations) => {
        // This is a cache projection, not another adapter call. Capture the
        // persisted receipt here so integration tests can prove its ordering.
        projections.push({ accountKey, observations: plain(observations),
          receipts: plain(observations).map((item) => plain([...records.values()].find((record) =>
            record.operation?.conversationId === item.conversationId)?.operation || null)) });
        if (options.failProjection) throw new Error("Catalog projection unavailable");
      },
      acceptTitles: async (accountKey, intents) => {
        projections.push({ accountKey, intents: plain(intents), accepted: true,
          receipts: plain(intents).map((item) => plain([...records.values()].find((record) =>
            record.operation?.conversationId === item.conversationId)?.operation || null)) });
        if (options.failProjection) throw new Error("Catalog projection unavailable");
      },
    }),
    getPreferences: async () => ({ timeZone: options.timeZone || "UTC" }),
    titleOperationsRepository: {
      get: async (key) => records.has(key) ? plain(records.get(key)) : null,
      set: async (key, value) => { await options.onStorageSet?.(key, plain(value)); records.set(key, plain(value)); },
      remove: async (keys) => { for (const key of Array.isArray(keys) ? keys : [keys]) records.delete(key); },
    },
    chrome: {
      runtime: {
        id: "tidy-test",
        getContexts: async () => offscreenCreated ? [{
          contextType: "OFFSCREEN_DOCUMENT", documentUrl: "chrome-extension://tidy-test/features/export/engine/offscreen.html",
        }] : [],
        sendMessage: async envelope => {
          // 工具栏 host 回复与标题业务广播分别记录；此标题工厂夹具
          // 不启动无关窗口 UI，也不改写生产标题服务的行为。
          if (envelope.channel === toolbarThemeChannel && envelope.target === "reporter" && envelope.type === "sync") {
            return { ok: true };
          }
          calls.push({ stage: "broadcast", type: envelope.type, payload: plain(envelope.payload) });
        },
        getURL: (value = "") => `chrome-extension://tidy-test/${String(value).replace(/^\//, "")}`,
        onInstalled: event(), onStartup: event(), onConnect: event(),
        onMessage: { addListener: (listener) => { receiveWorker = listener; } },
      },
      tabs: {
        query: async () => [],
        get: async (id) => ({ id, url: options.url || "https://chatgpt.com/c/current" }),
        sendMessage: async (tabId, envelope) => {
          const protocol = worker.TidyProtocol;
          if (envelope.type === protocol.Type.PAGE_SESSION_PROBE) return protocol.response(envelope, { ready: true });
          calls.push({ stage: "worker", tabId, type: envelope.type, payload: plain(envelope.payload) });
          if (envelope.type === protocol.Type.LIBRARY_IDENTITY_CHANGED) return;
          if (envelope.type === protocol.Type.DATE_INDEX_ACCOUNT) {
            return protocol.response(envelope, { schemaVersion: "tidy.date-search.v1", accountKey: "catalog-user-1" });
          }
          if (envelope.type === protocol.Type.GET_SNAPSHOT) {
            snapshotCalls++;
            if (options.failSnapshotAt === snapshotCalls) throw new Error("Page closed before dispatch");
            return protocol.response(envelope, snapshot);
          }
          const result = await new Promise((resolve) => { assert.equal(receiveIsolated(envelope, {}, resolve), true); });
          if (options.wrongResponseType) result.type = protocol.Type.GET_SNAPSHOT;
          return result;
        },
        onUpdated: event(), onActivated: event(), onRemoved: event(),
      },
      sidePanel: {
        setPanelBehavior: async () => {},
        getOptions: async () => ({ enabled: true, path: options.panelPath || "app/sidepanel/index.html?tidyTabId=31" }),
      },
      action: { setIcon: async () => {} },
      offscreen: { createDocument: async () => { offscreenCreated = true; } },
      storage: { onChanged: event(), local: {
        get: async key => { if (options.failSettingsRead) throw new Error("read failed"); return { [key]: { ...titleSettings } }; },
        set: async values => { if (options.failSettingsWrite) throw new Error("write failed"); titleSettings = plain(values["tidy.titles.rules.v1"]); },
      } }, webNavigation: { onHistoryStateUpdated: event(), onCommitted: event(),
        getFrame: async () => ({ ...pageSender, url: pageSender.url }),
      },
    },
  });
  // Execute complete production modules with only browser and durable-store
  // boundaries injected. Rebuilding the titles handler below resets its service
  // instances without reaching into private state or clearing durable records.
  const modules = createWorkerModuleLoader(worker, { imports: {
    assertAccountKey: worker.assertAccountKey, getPreferences: worker.getPreferences,
    titleOperationsRepository: worker.titleOperationsRepository,
  } });
  const loadModule = file => modules.load(file);
  const { createRequestBinding, isChatgptUrl } = loadModule("src/platform/session/background/request-binding.js");
  const { createLibraryIdentity } = loadModule("src/platform/library/background/library-identity.js");
  const { createPageGateway } = loadModule("src/platform/session/background/page-gateway.js");
  const { createPageSession } = loadModule("src/platform/session/background/page-session.js");
  const { createWorkerNavigation } = loadModule("src/platform/navigation/background/worker-navigation.js");
  const { createExportJobs } = loadModule("src/app/background/export-jobs.js");
  const { createToolbarTheme, TOOLBAR_THEME_CHANNEL: toolbarThemeChannel } = loadModule("src/platform/theme/background/toolbar-theme.js");
  const libraryIdentity = createLibraryIdentity({ chrome: worker.chrome, isChatgptUrl,
    beforeIdentityChange: (payload, sender, epoch) => navigation.identityChanged(payload, sender, epoch),
    afterIdentityChange: tabId => {
      void navigation.resume(tabId);
      void exportJobs.observeOwner(tabId, libraryIdentity.peek(tabId)).catch(() => {});
    },
  });
  const binding = createRequestBinding({ chrome: worker.chrome, libraryIdentity });
  const pageGateway = createPageGateway({ chrome: worker.chrome });
  const pageSession = createPageSession({ chrome: worker.chrome, isChatgptUrl });
  loadModule("src/features/search/model/search.js");
  const navigation = createWorkerNavigation({ chrome: worker.chrome, searchContract: worker.TidySearch,
    allocateNavigationEpoch: worker.createNavigationEpochAllocator(),
    navigationSenderTab: binding.navigationSenderTab, getBoundTab: binding.getBoundTab,
    libraryDocument: libraryIdentity.document, readLibraryAccount: libraryIdentity.readAccount,
    readLibraryIdentity: libraryIdentity.peek, assertLibraryContext: libraryIdentity.assertCurrent,
    requestTabMessageLocation: pageGateway.locate,
  });
  const exportJobs = createExportJobs({ chrome: worker.chrome, identity: libraryIdentity });
  const { createSearchGateway } = loadModule("src/app/background/adapters/search-gateway.js");
  const { createCatalogSelection } = loadModule("src/app/background/catalog-selection.js");
  const repository = worker.createConversationCatalogRepository();
  const catalog = createCatalogSelection({ repository, search: createSearchGateway({ binding, pageGateway }) });
  const { createTitlesHandler } = loadModule("src/app/background/handlers/titles.js");
  const { createRequestRouter } = loadModule("src/app/background/request-router.js");
  let requests;
  const restartTitles = () => {
    requests = createRequestRouter({ binding, pageSession, navigation,
      handlers: [createTitlesHandler({ chrome: worker.chrome, binding, pageGateway, catalog })],
    });
  };
  restartTitles();
  const { createTitleCatalogObserver } = loadModule("src/app/background/title-catalog-observer.js");
  const { createPageEvents } = loadModule("src/platform/session/background/page-events.js");
  const { createWorkerMessageListener } = loadModule("src/app/background/runtime-messages.js");
  receiveWorker = createWorkerMessageListener({
    toolbarTheme: createToolbarTheme(worker.chrome), exportJobs, navigation, identity: libraryIdentity,
    titleCatalog: createTitleCatalogObserver({ chrome: worker.chrome, identity: libraryIdentity, repository }),
    pageEvents: createPageEvents({ chrome: worker.chrome, identity: libraryIdentity }),
    requests: { handle: (...args) => requests.handle(...args) },
    diagnostics: { matches: () => false },
  });
  const isolated = vm.createContext({ ...base,
    TidySnapshot: {}, TidySearch: {}, TidyDateSearch: {}, TidyExportContract: {},
    document: { documentElement: { dataset: {} } },
    setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { timer.cleared = true; },
    chrome: { runtime: {
      id: "tidy-test",
      sendMessage: envelope => new Promise(resolve => { receiveWorker(envelope, pageSender, resolve); }),
      onMessage: { addListener: (listener) => { receiveIsolated = listener; }, removeListener() {} },
    } },
  });
  const main = vm.createContext({ ...base, TidyProtocol: worker.TidyProtocol,
    location: { origin: "https://chatgpt.com" },
    titleAdapter: {
      readCurrent: async (payload) => {
        calls.push({ stage: "adapter-read", payload: plain(payload) });
        if (options.readError) throw options.readError;
        if (options.failRead) throw Object.assign(new Error("redacted"), { tidyCode: "TITLE_AUTH_REQUIRED", httpStatus: 401 });
        if (payload.identityOnly === true) {
          identityCalls++;
          return { identity: plain(identity), catalogAccountKey: options.identityCatalogKey
            ? options.identityCatalogKey(identityCalls) : "catalog-user-1" };
        }
        return { identity, current: plain(targets.get(payload.conversationId)),
          catalogAccountKey: Object.hasOwn(options, "readCatalogAccountKey") ? options.readCatalogAccountKey : "catalog-user-1" };
      },
      writeCurrent: async (payload) => {
        if (options.rejectBeforeWrite) throw Object.assign(new Error("Changed route"), { tidyCode: "CONTEXT_MISMATCH" });
        if (options.writeErrorCode) throw Object.assign(new Error("private adapter error"), { tidyCode: options.writeErrorCode });
        calls.push({ stage: "adapter-write", payload: plain(payload) });
        assert.equal([...records.values()].find((record) => record.operation?.conversationId === payload.conversationId)?.operation.status, "pending", "persisted before write");
        assert.equal([...records.values()].find((record) => record.operation?.conversationId === payload.conversationId)?.operation.dispatchPhase, "dispatched", "dispatch permit persisted before the page sees a write");
        assert.deepEqual(plain(payload.identity), identity);
        const catalogAccountKey = Object.hasOwn(options, "writeCatalogAccountKey") ? options.writeCatalogAccountKey : "catalog-user-1";
        if (options.writeStatus === "accepted") {
          const target = targets.get(payload.conversationId); target.title = payload.after;
          return { status: "accepted", accepted: plain(target), catalogAccountKey, httpStatus: 200 };
        }
        if (options.uncertain || options.writeStatus) return { status: options.uncertain ? "uncertain" : options.writeStatus,
          current: plain(targets.get(payload.conversationId)), catalogAccountKey };
        const target = targets.get(payload.conversationId);
        target.title = payload.after;
        target.updatedAt = "2026-09-08T01:00:00.000Z";
        return { status: "verified", current: plain(target), httpStatus: 200, catalogAccountKey };
      },
      beginBatchExecution: async (payload) => {
        calls.push({ stage: "adapter-begin", payload: plain(payload) });
        return { identity: plain(identity), catalogAccountKey: options.beginCatalogKey || "catalog-user-1" };
      },
      endBatchExecution: async (payload) => {
        calls.push({ stage: "adapter-end", payload: plain(payload) });
        return { ended: true };
      },
    },
    buildSnapshot: (snapshotOptions) => {
      calls.push({ stage: "native-snapshot", options: plain(snapshotOptions) });
      assert.deepEqual(plain(snapshotOptions), { nativeTitles: true, titleOwnerOnly: true });
      return plain(snapshot);
    },
    titleSync: { acceptTitle: (metadata, account, before, native, scope) => {
      calls.push({ stage: "sync-title-accepted", current: plain(metadata), identity: plain(account), before, native: plain(native), scope: plain(scope) });
      return options.acceptSync !== false;
    }, accept: (metadata, account, before, native) => {
      calls.push({ stage: "sync-accept", current: plain(metadata), identity: plain(account), before, native: plain(native) });
      if (options.failSync) throw new Error("Presentation unavailable");
      return options.acceptSync !== false;
    } },
    publishSnapshot: (reason) => { calls.push({ stage: "snapshot-publish", reason }); },
      postEnvelope: (envelope) => {
        calls.push({ stage: "main-response", type: envelope.type, payload: plain(envelope.payload || {}), ok: envelope.ok });
        // 故障注入仅截住写入回信：实际 Worker、页面桥及超时清理仍照常执行。
        if (options.holdWriteReply && envelope.type === "titles.adapter.write-current") {
          delayedWriteReplies.push(envelope);
          return;
        }
        receiveWindow({ source: isolated.window, origin: "https://chatgpt.com",
        data: { channel: worker.TidyProtocol.WINDOW_CHANNEL, source: "chatgpt-main-world", envelope } });
    },
  });
  installPageSession(main);
  vm.runInContext(source("src/app/page/request-router.js"), main);
  const mainRouter = main.TidyPageRequestRouter.create({
    titleAdapter: main.titleAdapter, readSnapshot: main.buildSnapshot,
    titleProjection: main.titleSync, publishSnapshot: main.publishSnapshot, postEnvelope: main.postEnvelope,
  });
  const mainWindow = vm.runInContext("globalThis", main);
  const dispatchTitle = envelope => mainRouter.handleMessage({
    source: mainWindow, origin: main.location.origin,
    data: { channel: worker.TidyProtocol.WINDOW_CHANNEL, source: "chatgpt-isolated", envelope },
  });
  isolated.window = {
    location: { origin: "https://chatgpt.com" },
    addEventListener: (_name, listener) => { receiveWindow = listener; },
    removeEventListener() {},
    postMessage: ({ envelope }) => { dispatchTitle(envelope); },
  };
  installPageSession(isolated, { runtime: true });
  for (const file of ["src/platform/protocol.js", "src/app/page/isolated.js"]) vm.runInContext(source(file), isolated);
  const request = (type, payload = {}, sender = panelSender) => new Promise((resolve) => {
    const envelope = worker.TidyProtocol.request(worker.TidyProtocol.Type[type] || type, type.startsWith("TITLE_RULES_") ? payload : {
      expectedTabId: 31, expectedConversationId: "current", ...payload,
    });
    assert.equal(receiveWorker(envelope, sender, resolve), true);
  });
  return { request, current, calls, projections, records, timers, identity,
    pageSender,
    titleChange: (payload, sender = pageSender) => new Promise(resolve => {
      assert.equal(receiveWorker(worker.TidyProtocol.event(worker.TidyProtocol.Type.TITLE_CHANGED, payload), sender, resolve), true);
    }),
    pageTitleChange: payload => main.postEnvelope(worker.TidyProtocol.event(worker.TidyProtocol.Type.TITLE_CHANGED, payload)),
    revokePage: () => libraryIdentity.closeTab(31),
    pendingWriteReplies: () => delayedWriteReplies.length,
    releaseWriteReplies: () => {
      for (const envelope of delayedWriteReplies.splice(0)) receiveWindow({ source: isolated.window, origin: "https://chatgpt.com",
        data: { channel: worker.TidyProtocol.WINDOW_CHANNEL, source: "chatgpt-main-world", envelope } });
    },
    restartTitleService: restartTitles,
    restartAllTitleServices: restartTitles };
}

async function preparedBatch(h, conversationIds, patch = {}) {
  const response = await h.request("TITLE_BATCH_PREVIEW", { conversationIds, accountKey: "catalog-user-1",
    operation: "assign", rules: { timeZone: "UTC", dateFormat: "iso", mode: "created" }, ...patch });
  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(response.payload.phase, "preview", "The current preview is complete in one local operation; no retired preparation loop");
  return response.payload;
}

const nativeChange = (patch = {}) => ({ ownerAccountKey: "user-1", epoch: 1, catalogAccountKey: "catalog-user-1",
  conversationId: "current", title: "Official rename", startedAt: Date.now(), ...patch });

test("official rename crosses the real isolated/worker bridge and broadcasts only a single-row locator", async () => {
  let directoryReads = 0;
  const h = load({ onCatalogRead: () => directoryReads++ });
  h.pageTitleChange(nativeChange());
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.current.title, "Official rename");
  assert.equal(h.projections.length, 1);
  const notifications = h.calls.filter(call => call.type === "titles.catalog-changed");
  assert.deepEqual(notifications, [{ stage: "broadcast", type: "titles.catalog-changed",
    payload: { accountKey: "catalog-user-1", conversationId: "current" } }]);
  assert.equal(directoryReads, 0);
  assert.equal(h.calls.some(call => call.stage.startsWith("adapter-")), false);
});

test("rename bridge rejects wrong sender, invalid payload, stale identity, and missing rows", async () => {
  const h = load(), { pageSender } = h;
  for (const sender of [panelSender, { ...pageSender, frameId: 1 }, { ...pageSender, documentId: "old-doc" },
    { ...pageSender, documentLifecycle: "cached" }, { ...pageSender, url: "https://example.com" }]) {
    assert.equal((await h.titleChange(nativeChange(), sender)).ok, false);
  }
  for (const patch of [{ conversationId: [] }, { conversationId: "../other" }, { title: "" }, { title: "x".repeat(4097) },
    { catalogAccountKey: " catalog-user-1" }, { startedAt: NaN }, { epoch: -1 }, { ownerAccountKey: null }]) {
    assert.equal((await h.titleChange(nativeChange(patch))).ok, false);
  }
  assert.equal((await h.titleChange(nativeChange())).ok, true);
  for (const patch of [{ epoch: 0 }, { ownerAccountKey: "other-user" }, { conversationId: "missing" }]) {
    assert.equal((await h.titleChange(nativeChange(patch))).ok, false);
  }
  assert.equal(h.projections.length, 1);
  assert.equal(h.calls.filter(call => call.type === "titles.catalog-changed").length, 1);
});

test("rename bridge never announces an uncommitted or revoked cache update", async () => {
  const failed = load({ failProjection: true });
  assert.equal((await failed.titleChange(nativeChange())).ok, false);
  assert.equal(failed.calls.some(call => call.type === "titles.catalog-changed"), false);
  let release, started;
  const reached = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = load({ onTitleChange: async () => { started(); await gate; } });
  const pending = h.titleChange(nativeChange());
  await reached; h.revokePage(); release();
  assert.equal((await pending).ok, false);
  assert.equal(h.current.title, "Original");
  assert.equal(h.calls.some(call => call.type === "titles.catalog-changed"), false);
});

test("explicit refresh of a renamed preview reads only that catalog primary key", async () => {
  let directoryReads = 0;
  const rowReads = [];
  const h = load({ onCatalogRead: () => directoryReads++, onCatalogRowRead: (...args) => rowReads.push(args) });
  const job = await preparedBatch(h, ["current"]), originalReads = directoryReads;
  h.current.title = "Official rename";
  const updated = await h.request("TITLE_BATCH_RETRY_PREVIEW", { batchId: job.batchId, refreshConversationIds: ["current"] });
  assert.equal(updated.ok, true, JSON.stringify(updated.error));
  assert.equal(updated.payload.items[0].current.title, "Official rename");
  assert.deepEqual(rowReads, [["catalog-user-1", "current"]]);
  assert.equal(directoryReads, originalReads);
  assert.equal(h.calls.some(call => call.stage === "adapter-write"), false);
});

test('the real worker will not forward a title write until its dispatch checkpoint is durable', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { started = resolve; });
  const h = load({ onStorageSet: async (_key, value) => {
    if (value.operation?.status === 'pending' && value.operation.dispatchPhase === 'dispatched') { started(); await gate; }
  } });
  const first = await h.request('TITLE_PREVIEW', { rules: { timeZone: 'UTC' } });
  const pending = h.request('TITLE_APPLY', { planId: first.payload.plan.id });
  await reached;
  assert.equal(h.calls.filter(call => call.type === 'titles.adapter.write-current').length, 0);
  assert.equal([...h.records.values()][0].operation.dispatchPhase, 'prepared');
  release(); const result = await pending;
  assert.equal(result.payload.operation.status, 'verified');
  assert.equal(h.calls.filter(call => call.stage === 'adapter-write').length, 1);
});

test('a failed dispatch checkpoint has a known-unsent receipt and no outbound write', async () => {
  const h = load({ onStorageSet: async (_key, value) => {
    if (value.operation?.dispatchPhase === 'dispatched') throw new Error('private storage failure');
  } });
  const first = await h.request('TITLE_PREVIEW', { rules: { timeZone: 'UTC' } });
  const failed = await h.request('TITLE_APPLY', { planId: first.payload.plan.id });
  assert.equal(failed.ok, true); assert.equal(failed.payload.operation.status, 'failed');
  assert.equal(failed.payload.operation.messageCode, 'title_not_dispatched');
  assert.equal(h.calls.filter(call => call.type === 'titles.adapter.write-current').length, 0);
  h.restartTitleService();
  const next = await h.request('TITLE_PREVIEW', { rules: { timeZone: 'UTC' } });
  assert.ok(next.payload.plan); assert.notEqual(next.payload.plan.id, first.payload.plan.id);
  assert.equal(h.calls.filter(call => call.stage === 'adapter-write').length, 0);
  assert.doesNotMatch(JSON.stringify(failed), /private storage failure/);
});

test('the worker reports a failed preparation as unsent without forwarding a title write', async () => {
  const h = load({ onStorageSet: async (_key, value) => {
    if (value.operation?.status === 'pending' && value.operation.dispatchPhase === 'prepared') throw new Error('private storage failure');
  } });
  const first = await h.request('TITLE_PREVIEW', { rules: { timeZone: 'UTC' } });
  const failed = await h.request('TITLE_APPLY', { planId: first.payload.plan.id });
  assert.equal(failed.ok, false); assert.equal(failed.error.code, 'TITLE_NOT_DISPATCHED');
  assert.equal(h.calls.filter(call => call.type === 'titles.adapter.write-current').length, 0);
  assert.doesNotMatch(JSON.stringify(failed), /private storage failure/);
});

test('an adapter error cannot claim the worker-only unsent checkpoint after dispatch', async () => {
  const h = load({ writeErrorCode: 'TITLE_NOT_DISPATCHED' });
  const first = await h.request('TITLE_PREVIEW', { rules: { timeZone: 'UTC' } });
  const failed = await h.request('TITLE_APPLY', { planId: first.payload.plan.id });
  assert.equal(failed.ok, true); assert.equal(failed.payload.operation.status, 'uncertain');
  assert.equal(failed.payload.operation.messageCode, 'title_outcome_unknown');
  await h.request('TITLE_APPLY', { planId: first.payload.plan.id });
  const check = await h.request('TITLE_RECONCILE');
  assert.equal(check.payload.operation.status, 'conflict');
  assert.equal(check.payload.operation.messageCode, 'title_unchanged');
  assert.equal(check.payload.plan, null);
  const stale = await h.request('TITLE_APPLY', { planId: first.payload.plan.id });
  assert.equal(stale.error.code, 'TITLE_PREVIEW_REQUIRED');
  assert.equal(h.calls.filter(call => call.stage === 'worker' && call.type === 'titles.adapter.write-current').length, 1);
  assert.doesNotMatch(JSON.stringify(failed), /private adapter error/);
});

test("title settings patches stay in the real worker and never request ChatGPT identity or metadata", async () => {
  const h = load();
  const responses = await Promise.all([h.request("TITLE_RULES_UPDATE", { dateFormat: "dot" }), h.request("TITLE_RULES_UPDATE", { mode: "created" })]);
  assert.ok(responses.every(value => value.ok));
  const value = await h.request("TITLE_RULES_GET");
  assert.equal(value.ok, true); assert.deepEqual(plain(value.payload), { mode: "created", dateFormat: "dot" });
  assert.deepEqual(h.calls, [], "no snapshot, identity, adapter or remote title operation");
});

test("only the extension side panel can read or update title settings", async () => {
  const h = load();
  for (const sender of [{}, { url: "https://chatgpt.com/c/current", tab: { id: 31 } },
    { url: "chrome-extension://another/app/sidepanel/index.html" }]) {
    for (const type of ["TITLE_RULES_GET", "TITLE_RULES_UPDATE"]) {
      const response = await h.request(type, { mode: "created" }, sender);
      assert.equal(response.ok, false);
    }
  }
  assert.equal((await h.request("TITLE_RULES_GET")).payload.mode, "range");
  assert.deepEqual(h.calls, []);
});

test("worker returns failure for title-settings storage errors and unexpected payload fields", async () => {
  for (const options of [{ failSettingsRead: true }, { failSettingsWrite: true }]) {
    const h = load(options);
    assert.equal((await h.request("TITLE_RULES_UPDATE", { mode: "created" })).ok, false);
    assert.deepEqual(h.calls, []);
  }
  const h = load();
  const response = await h.request("TITLE_RULES_UPDATE", { mode: "created", conversationId: "private" });
  assert.equal(response.ok, false); assert.equal(response.error.code, "VALIDATION_ERROR");
});

test("real batch acceptance crosses worker and page bridges as title-only sync and remains readable by the current editor", async () => {
  const h = load({ writeStatus: "accepted" }), preview = await preparedBatch(h, ["current"]);
  const applying = await h.request("TITLE_BATCH_APPLY", { batchId: preview.batchId });
  const done = await h.request("TITLE_BATCH_STEP", { batchId: preview.batchId, stepId: applying.payload.nextStepId });
  assert.equal(done.ok, true); assert.equal(done.payload.phase, "result"); assert.equal(done.payload.items[0].status, "accepted");
  const synced = h.calls.filter(call => call.stage === "sync-title-accepted");
  assert.equal(synced.length, 1); assert.equal(synced[0].current.title, preview.items[0].plan.after);
  assert.deepEqual(synced[0].scope, { ownerContext: { conversationId: "current", pathname: "/c/current", projectId: null }, targetProjectId: null });
  assert.equal(h.calls.filter(call => call.stage === "sync-accept").length, 0, "accepted writes are not readback observations");
  assert.deepEqual(h.calls.filter(call => call.stage === "snapshot-publish").map(call => call.reason), ["title-accepted"]);
  assert.equal(h.projections.length, 1); assert.equal(h.projections[0].accepted, true);
  assert.equal(h.projections[0].receipts[0].status, "accepted");
  const current = await h.request("TITLE_PREVIEW", { rules: { timeZone: "UTC", dateFormat: "slash", mode: "created" } });
  assert.equal(current.ok, true); assert.equal(current.payload.operation.status, "accepted");
  assert.ok(current.payload.plan); assert.equal(current.payload.current.title, preview.items[0].plan.after);
});

test("batch selection reads local membership once with no page identity or owner snapshot", async () => {
  let reads = 0;
  const h = load({ onCatalogRead: () => reads++ });
  const result = await h.request("TITLE_BATCH_PREVIEW", { conversationIds: ["current"], accountKey: "catalog-user-1" });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(reads, 1);
  assert.equal(h.calls.filter(call => call.stage === "adapter-read").length, 0);
  assert.equal(h.calls.filter(call => call.type === "date-index.account").length, 0);
  const ownerSnapshots = h.calls.filter(call => call.type === "snapshot.get");
  assert.equal(ownerSnapshots.length, 0);
  assert.equal(h.calls.some(call => call.stage === "adapter-write"), false);
});

test("local preview tolerates no session access, while confirmation rejects a changed directory account", async () => {
  const h = load({ failRead: true, beginCatalogKey: "another-account" });
  const preview = await h.request("TITLE_BATCH_PREVIEW", { conversationIds: ["current"], accountKey: "catalog-user-1" });
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  assert.equal(h.calls.filter(call => call.stage === "adapter-read").length, 0);
  const applied = await h.request("TITLE_BATCH_APPLY", { batchId: preview.payload.batchId });
  assert.equal(applied.ok, false); assert.equal(applied.error.code, "TITLE_ACCOUNT_CHANGED");
  assert.equal(h.calls.some(call => call.stage === "adapter-write"), false);
});

test("title selection still rejects a catalog snapshot tagged for a different account", async () => {
  const h = load({ catalogState: { accountKey: "another-account" } });
  const result = await h.request("TITLE_BATCH_PREVIEW", { conversationIds: ["current"], accountKey: "catalog-user-1" });
  assert.equal(result.ok, false);
  assert.equal(h.records.size, 0);
});

test("ordinary title save projects exact verified metadata to the adapter's directory account after durable persistence", async () => {
  const h = load();
  const preview = await h.request("TITLE_PREVIEW", { rules: { mode: "created", dateFormat: "iso", timeZone: "UTC" } });
  assert.equal(preview.ok, true); assert.deepEqual(h.projections, []);
  h.calls.length = 0;
  const applied = await h.request("TITLE_APPLY", { planId: preview.payload.plan.id,
    catalogAccountKey: "forged-directory-account", current: { title: "forged-caller-title" } });
  assert.equal(applied.ok, true); assert.equal(applied.payload.operation.status, "verified");
  assert.deepEqual(h.projections, [{ accountKey: "catalog-user-1", observations: [plain(applied.payload.current)],
    receipts: [plain([...h.records.values()].find((record) => record.operation?.conversationId === "current").operation)] }]);
  assert.equal(h.projections[0].receipts[0].status, "verified");
  assert.equal(h.projections[0].receipts[0].id, preview.payload.plan.id);
  assert.equal(h.projections[0].observations[0].title, preview.payload.plan.after);
  assert.equal(h.projections[0].observations[0].updatedAt, "2026-09-08T01:00:00.000Z");
  assert.equal(applied.payload.catalogAccountKey, undefined, "directory projection key stays outside public core responses");
  assert.equal(applied.payload.plan.catalogAccountKey, undefined);
  assert.equal(h.calls.filter((call) => call.stage === "adapter-read").length, 1, "no extra session lookup for projection");
  assert.equal(h.calls.filter((call) => call.stage === "adapter-write").length, 1);
  assert.equal(h.calls.some((call) => call.type === "date-index.account"), false);
});

test("unknown ordinary save reconciles read-only and projects only the fresh confirmed after title", async () => {
  const options = { uncertain: true };
  const h = load(options);
  const preview = await h.request("TITLE_PREVIEW", { rules: { timeZone: "UTC" } });
  const applied = await h.request("TITLE_APPLY", { planId: preview.payload.plan.id });
  assert.equal(applied.payload.operation.status, "uncertain"); assert.deepEqual(h.projections, []);
  await h.request("TITLE_RECONCILE"); assert.deepEqual(h.projections, []);
  h.current.title = preview.payload.plan.after; h.current.updatedAt = "2026-09-10T00:00:00.000Z";
  h.restartTitleService();
  const reconciled = await h.request("TITLE_RECONCILE", { catalogAccountKey: "forged" });
  assert.equal(reconciled.payload.operation.status, "verified");
  assert.equal(h.projections.length, 1); assert.equal(h.projections[0].accountKey, "catalog-user-1");
  assert.deepEqual(h.projections[0].observations, [plain(h.current)]);
  assert.equal(h.projections[0].receipts[0].status, "verified");
  assert.equal(h.calls.filter((call) => call.stage === "adapter-write").length, 1);
  // That historical successful receipt cannot subsequently bless a new
  // unrelated title supplied by another device.
  h.current.title = "A later mobile rename";
  await h.request("TITLE_RECONCILE"); assert.equal(h.projections.length, 1);
  assert.equal(h.calls.filter((call) => call.stage === "adapter-write").length, 1);
});

test("batch writes share the core directory observer once per exact target, not a second batch projection path", async () => {
  const target = { conversationId: "target", projectId: "g-p-project", title: "Project original",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };
  const h = load({ rows: [target] });
  const preview = await preparedBatch(h, ["target", "current"]);
  assert.equal(h.projections.length, 0);
  let response = await h.request("TITLE_BATCH_APPLY", { batchId: preview.batchId });
  while (response.payload.phase === "applying") {
    const token = { batchId: response.payload.batchId, stepId: response.payload.nextStepId };
    const count = h.projections.length;
    response = await h.request("TITLE_BATCH_STEP", token);
    assert.equal(response.ok, true, JSON.stringify(response.error));
    assert.equal(h.projections.length, count + 1);
    const duplicate = await h.request("TITLE_BATCH_STEP", token);
    assert.equal(duplicate.ok, true); assert.equal(h.projections.length, count + 1, "a replayed step has no new readback or projection");
  }
  assert.equal(response.payload.counts.verified, 2);
  assert.deepEqual(h.projections.map((entry) => entry.accountKey), ["catalog-user-1", "catalog-user-1"]);
  assert.deepEqual(h.projections.map((entry) => entry.observations[0].conversationId), ["target", "current"]);
  assert.ok(h.projections.every((entry) => entry.receipts[0].status === "verified"));
  assert.deepEqual(h.projections.map((entry) => entry.observations[0]), plain(response.payload.items).map((item) => item.current));
  assert.equal(h.calls.filter((call) => call.stage === "adapter-write").length, 2);
});

test("worker batch ingress accepts shared named-project identity across service restarts", async () => {
  const h = load({ url: "https://chatgpt.com/g/g-p-69ea080a91a081919b8a0c0456e1763e-project-name/c/current" });
  for (let reopen = 0; reopen < 3; reopen++) {
    h.restartAllTitleServices();
    const status = await h.request("TITLE_BATCH_STATUS", { catalogAccountKey: "catalog-user-1" });
    assert.equal(status.ok, true); assert.equal(status.payload.batchId, null);
  }
  assert.equal(h.calls.some(call => ["adapter-read", "adapter-write", "adapter-begin"].includes(call.stage)), false);
  const preview = await preparedBatch(h, ["current"]);
  h.restartAllTitleServices();
  const status = await h.request("TITLE_BATCH_STATUS", { catalogAccountKey: "catalog-user-1" });
  assert.equal(status.ok, true); assert.equal(status.payload.batchId, preview.batchId);
  assert.equal(h.calls.some(call => call.stage === "adapter-write"), false);
});

test("unknown batch recovery reaches the same observer once without replaying its POST", async () => {
  const h = load({ uncertain: true });
  const preview = await preparedBatch(h, ["current"]);
  const authorized = await h.request("TITLE_BATCH_APPLY", { batchId: preview.batchId });
  const applied = await h.request("TITLE_BATCH_STEP", { batchId: preview.batchId, stepId: authorized.payload.nextStepId });
  assert.equal(applied.payload.counts.uncertain, 1); assert.equal(h.projections.length, 0);
  h.current.title = preview.items[0].plan.after; h.current.updatedAt = "2026-09-10T00:00:00.000Z";
  h.restartAllTitleServices();
  const result = await h.request("TITLE_BATCH_RECONCILE", { batchId: preview.batchId });
  assert.equal(result.ok, true); assert.equal(result.payload.counts.verified, 1);
  assert.equal(h.projections.length, 1); assert.equal(h.projections[0].accountKey, "catalog-user-1");
  assert.deepEqual(h.projections[0].observations, [plain(h.current)]);
  assert.equal(h.projections[0].receipts[0].status, "verified");
  assert.equal(h.calls.filter((call) => call.stage === "adapter-write").length, 1);
});

test("nonverified outcomes and missing readback directory identity never update the catalog", async () => {
  for (const writeStatus of ["pending", "uncertain", "conflict", "failed"]) {
    const h = load({ writeStatus });
    const preview = await h.request("TITLE_PREVIEW", { rules: { timeZone: "UTC" } });
    const result = await h.request("TITLE_APPLY", { planId: preview.payload.plan.id });
    assert.equal(result.ok, true); assert.notEqual(result.payload.operation.status, "verified");
    assert.deepEqual(h.projections, []); assert.equal(h.calls.filter((call) => call.stage === "adapter-write").length, 1);
  }
  const h = load({ writeCatalogAccountKey: null, readCatalogAccountKey: null });
  const preview = await h.request("TITLE_PREVIEW", { rules: { timeZone: "UTC" } });
  const result = await h.request("TITLE_APPLY", { planId: preview.payload.plan.id, catalogAccountKey: "forged" });
  assert.equal(result.payload.operation.status, "verified");
  await h.request("TITLE_RECONCILE"); assert.deepEqual(h.projections, []);
  assert.equal(h.calls.filter((call) => call.stage === "adapter-write").length, 1);
});

test("catalog projection failure does not obscure ordinary or batch verified receipts or permit another POST", async () => {
  for (const batch of [false, true]) {
    const options = { failProjection: true }, h = load(options);
    let result;
    if (batch) {
      const preview = await preparedBatch(h, ["current"]);
      const authorized = await h.request("TITLE_BATCH_APPLY", { batchId: preview.batchId });
      result = await h.request("TITLE_BATCH_STEP", { batchId: preview.batchId, stepId: authorized.payload.nextStepId });
      assert.equal(result.payload.counts.verified, 1); assert.equal(result.payload.phase, "result");
    } else {
      const preview = await h.request("TITLE_PREVIEW", { rules: { timeZone: "UTC" } });
      result = await h.request("TITLE_APPLY", { planId: preview.payload.plan.id });
      assert.equal(result.payload.operation.status, "verified"); assert.ok(result.payload.previewContext);
    }
    assert.equal(result.ok, true); assert.equal(h.projections.length, 1);
    assert.equal(h.projections[0].receipts[0].status, "verified");
    assert.equal(h.calls.filter((call) => call.stage === "adapter-write").length, 1);
    assert.equal([...h.records.values()].find((record) => record.operation?.conversationId === "current").operation.status, "verified");
  }
});

test("batch projection cannot fall back to the selection's older catalog key when write readback omits identity", async () => {
  const h = load({ writeCatalogAccountKey: null });
  const preview = await preparedBatch(h, ["current"]);
  assert.equal(preview.catalogAccountKey, "catalog-user-1");
  const authorized = await h.request("TITLE_BATCH_APPLY", { batchId: preview.batchId });
  const result = await h.request("TITLE_BATCH_STEP", { batchId: preview.batchId, stepId: authorized.payload.nextStepId });
  assert.equal(result.ok, true); assert.equal(result.payload.counts.verified, 1);
  assert.equal(result.payload.catalogAccountKey, "catalog-user-1", "selection identity still belongs to the receipt's directory view");
  assert.equal(result.payload.observed.length, 1, "legacy readback display fields are not authority to project into a guessed account");
  assert.deepEqual(h.projections, []);
  assert.equal(h.calls.filter((call) => call.stage === "adapter-write").length, 1);
});

test("batch bridge previews and writes a project target without borrowing its owner's title or project", async () => {
  const target = { conversationId: "target", projectId: "g-p-project", title: "Project original",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };
  const h = load({ rows: [target] });
  const preview = await preparedBatch(h, ["target"]);
  assert.equal(preview.phase, "preview");
  assert.equal(preview.items[0].plan.before, "Project original");
  assert.equal(h.calls.filter((call) => call.stage === "adapter-write").length, 0);
  h.calls.length = 0;
  const changed = await h.request("TITLE_BATCH_REPLAN", { batchId: preview.batchId,
    rules: { timeZone: "UTC", dateFormat: "slash", mode: "created" } });
  assert.equal(changed.ok, true, JSON.stringify(changed.error));
  assert.notEqual(changed.payload.batchId, preview.batchId);
  assert.deepEqual(h.calls, [], "batch choices do not ask ChatGPT for snapshots/session/metadata");
  const authorized = await h.request("TITLE_BATCH_APPLY", { batchId: changed.payload.batchId, after: "Unreviewed" });
  assert.equal(authorized.ok, true);
  const executed = await h.request("TITLE_BATCH_STEP", { batchId: authorized.payload.batchId, stepId: authorized.payload.nextStepId });
  assert.equal(executed.ok, true, JSON.stringify(executed.error));
  assert.equal(executed.payload.phase, "result");
  assert.equal(executed.payload.counts.verified, 1);
  assert.equal(h.current.title, "Original", "owner conversation stays untouched");
  const write = h.calls.find((call) => call.stage === "adapter-write");
  assert.equal(write.payload.conversationId, "target");
  assert.equal(write.payload.targetProjectId, "g-p-project");
  assert.deepEqual(write.payload.ownerContext, { conversationId: "current", pathname: "/c/current", projectId: null });
  assert.equal(write.payload.after, changed.payload.items[0].plan.after);
  const duplicate = await h.request("TITLE_BATCH_STEP", { batchId: authorized.payload.batchId, stepId: authorized.payload.nextStepId });
  assert.equal(duplicate.ok, true);
  assert.equal(h.calls.filter((call) => call.stage === "adapter-write").length, 1);
});

test("public batch payloads cannot choose timestamp provenance or replace the private catalog intent", async () => {
  for (const completeCatalog of [true, false]) {
    const h = load({ completeCatalog });
    const forged = { metadataSource: completeCatalog ? "detail" : "catalog", catalogIntent: { operation: "remove", rules: {}, decision: "stack" },
      current: { title: "Injected metadata" }, before: "Injected original", after: "Injected title" };
    const preview = await preparedBatch(h, ["current"], forged), recipe = plain(preview.items[0].plan);
    assert.equal(preview.items[0].metadataSource, undefined);
    const authorized = await h.request("TITLE_BATCH_APPLY", { batchId: preview.batchId, ...forged });
    assert.equal(authorized.ok, true);
    if (!completeCatalog) {
      assert.equal(authorized.payload.phase, "result"); assert.equal(authorized.payload.counts.skipped, 1);
      assert.equal(h.calls.some(call => call.stage === "adapter-write"), false);
      continue;
    }
    const executed = await h.request("TITLE_BATCH_STEP", { batchId: preview.batchId, stepId: authorized.payload.nextStepId, ...forged });
    assert.equal(executed.ok, true); assert.equal(executed.payload.counts.verified, 1);
    const write = h.calls.find(call => call.stage === "adapter-write");
    assert.equal(write.payload.metadataSource, "catalog");
    assert.equal(write.payload.before, recipe.before); assert.equal(write.payload.after, recipe.after);
    assert.deepEqual(write.payload.catalogIntent,
      { operation: recipe.operation, rules: recipe.rules, decision: recipe.selectedDecision });
  }
});

test("batch directory selection rejects cross-account IDs and non-panel senders before any title write", async () => {
  for (const [payload, sender] of [
    [{ conversationIds: ["not-in-directory"], accountKey: "catalog-user-1" }, panelSender],
    [{ conversationIds: ["current"], accountKey: "different-account" }, panelSender],
    [{ conversationIds: ["current"], accountKey: "catalog-user-1" }, { url: "https://chatgpt.com/c/current", tab: { id: 31 } }],
  ]) {
    const h = load();
    const response = await h.request("TITLE_BATCH_PREVIEW", payload, sender);
    assert.equal(response.ok, false);
    assert.equal(h.calls.filter((call) => call.stage === "adapter-write").length, 0);
  }
});

test("batch restart restores unknown outcomes read-only and never starts the next target", async () => {
  const h = load({ uncertain: true });
  const preview = await preparedBatch(h, ["current"]);
  const authorized = await h.request("TITLE_BATCH_APPLY", { batchId: preview.batchId });
  const executed = await h.request("TITLE_BATCH_STEP", { batchId: preview.batchId, stepId: authorized.payload.nextStepId });
  assert.equal(executed.payload.phase, "paused");
  h.restartAllTitleServices(); h.calls.length = 0;
  const restored = await h.request("TITLE_BATCH_STATUS", { catalogAccountKey: "catalog-user-1" });
  assert.equal(restored.ok, true);
  assert.equal(restored.payload.counts.uncertain, 1);
  const reconciled = await h.request("TITLE_BATCH_RECONCILE", { batchId: restored.payload.batchId });
  assert.equal(reconciled.ok, true);
  assert.equal(h.calls.filter((call) => call.stage === "adapter-write").length, 0);
});

test("title preview/apply/remove traverses the real worker, isolated and main-world branches", async () => {
  const h = load();
  const preview = await h.request("TITLE_PREVIEW", { rules: { mode: "range", dateFormat: "iso", timeZone: "UTC" } });
  assert.equal(preview.ok, true);
  assert.equal(preview.payload.plan.before, "Original");
  assert.equal(preview.payload.plan.canApply, true);
  const after = preview.payload.plan.after;
  const applied = await h.request("TITLE_APPLY", { planId: preview.payload.plan.id, after: "UNREVIEWED OVERRIDE" });
  assert.equal(applied.ok, true);
  assert.equal(applied.payload.operation.status, "verified");
  assert.equal(h.current.title, after);
  assert.equal(Object.hasOwn(applied.payload, "canUndo"), false);
  assert.equal(h.calls.filter((call) => call.stage === "adapter-write").length, 1);
  const remove = await h.request("TITLE_REPLAN", {
    previewContextId: applied.payload.previewContext.id,
    operation: "remove",
    rules: { mode: "range", dateFormat: "iso", timeZone: "UTC" },
  });
  assert.equal(h.current.title, after, "remove preview is read-only");
  assert.equal(remove.payload.plan.after, "Original");
  const removed = await h.request("TITLE_APPLY", { planId: remove.payload.plan.id });
  assert.equal(removed.payload.operation.status, "verified");
  assert.equal(h.current.title, "Original");
  assert.equal(Object.hasOwn(removed.payload, "canUndo"), false);
  assert.equal(h.calls.filter((call) => call.stage === "adapter-write").length, 2);
  assert.ok(h.timers.every((timer) => timer.delay === 60_000 && timer.cleared));
});

test("retired undo messages are not registered or routed and cannot start any I/O", async () => {
  const protocolContext = vm.createContext({});
  vm.runInContext(source("src/platform/protocol.js"), protocolContext);
  assert.equal(protocolContext.TidyProtocol.Type.TITLE_UNDO_PREVIEW, undefined);
  assert.equal(Object.values(protocolContext.TidyProtocol.Type).includes("titles.undo-preview"), false);
  // Test the old wire value as well as the removed symbol. A stale panel must
  // fail at the command boundary, not read metadata or infer another action.
  for (const type of ["titles.undo-preview", "TITLE_UNDO_PREVIEW", "undefined"]) {
    const h = load();
    const result = await h.request(type);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "UNSUPPORTED_TYPE");
    assert.deepEqual(h.calls, []);
    assert.equal(h.records.size, 0);
  }
  const panel = source("src/app/sidepanel/panel.js");
  assert.doesNotMatch(panel, /TITLE_UNDO_PREVIEW|undo-preview/);
});

test("project current conversation uses the same preview, local replan and strict write bridge", async () => {
  const h = load({ url: "https://chatgpt.com/g/g-p-project/c/current" });
  const preview = await h.request("TITLE_PREVIEW", { rules: { timeZone: "UTC", dateFormat: "iso" } });
  assert.equal(preview.ok, true);
  assert.equal(h.calls.find((call) => call.stage === "adapter-read").payload.targetProjectId, "g-p-project");
  h.calls.length = 0;
  const replanned = await h.request("TITLE_REPLAN", { previewContextId: preview.payload.previewContext.id,
    rules: { timeZone: "UTC", dateFormat: "dot" }, operation: "assign" });
  assert.equal(replanned.ok, true);
  assert.equal(h.calls.filter((call) => call.stage === "adapter-read" || call.stage === "worker").length, 0);
  const applied = await h.request("TITLE_APPLY", { planId: replanned.payload.plan.id });
  assert.equal(applied.payload.operation.status, "verified");
  const writes = h.calls.filter((call) => call.stage === "adapter-write");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.targetProjectId, "g-p-project");
});

test("authenticated title reads synchronize and publish before returning their response", async () => {
  const h = load();
  const result = await h.request("TITLE_STATUS");
  assert.equal(result.ok, true);
  const events = h.calls.filter((call) => call.stage !== "worker");
  assert.deepEqual(events.map((call) => call.stage), [
    "adapter-read", "native-snapshot", "sync-accept", "snapshot-publish", "main-response",
  ]);
  const synchronized = events.find((call) => call.stage === "sync-accept");
  assert.deepEqual(synchronized.identity, { accountKey: "user-1", workspaceKey: "personal" });
  assert.deepEqual(synchronized.current, plain(result.payload.current));
  assert.equal(synchronized.before, undefined);
  assert.equal(synchronized.native.conversationId, "current");
  assert.equal(events.find((call) => call.stage === "snapshot-publish").reason, "title-readback");
});

test("apply forwards identityOnly and synchronizes only its verified write before response", async () => {
  const h = load();
  const preview = await h.request("TITLE_PREVIEW", { rules: { timeZone: "UTC" } });
  h.calls.length = 0;
  const result = await h.request("TITLE_APPLY", { planId: preview.payload.plan.id });
  assert.equal(result.payload.operation.status, "verified");
  const adapterRead = h.calls.find((call) => call.stage === "adapter-read");
  assert.equal(adapterRead.payload.identityOnly, true);
  assert.equal(adapterRead.payload.conversationId, "current");
  const readEnvelope = h.calls.find((call) => call.stage === "worker" && call.payload?.identityOnly);
  assert.equal(readEnvelope.payload.identityOnly, true, "worker forwards the service's identity-only option through the bridge");
  const events = h.calls.filter((call) => call.stage !== "worker");
  assert.deepEqual(events.map((call) => call.stage), [
    "adapter-read", "main-response", "adapter-write", "native-snapshot", "sync-accept", "snapshot-publish", "main-response",
  ]);
  assert.equal(events[1].payload.current, undefined, "identity lookup does not invent title metadata");
  const synchronized = events.find((call) => call.stage === "sync-accept");
  assert.equal(synchronized.before, preview.payload.plan.before);
  assert.equal(synchronized.current.title, preview.payload.plan.after);
  assert.deepEqual(synchronized.identity, { accountKey: "user-1", workspaceKey: "personal" });
});

test("an uncertain write cannot synchronize or publish a title even with returned metadata", async () => {
  const h = load({ uncertain: true });
  const preview = await h.request("TITLE_PREVIEW", { rules: { timeZone: "UTC" } });
  h.calls.length = 0;
  const result = await h.request("TITLE_APPLY", { planId: preview.payload.plan.id });
  assert.equal(result.payload.operation.status, "uncertain");
  assert.deepEqual(h.calls.filter((call) => call.stage !== "worker").map((call) => call.stage), [
    "adapter-read", "main-response", "adapter-write", "main-response",
  ]);
  assert.equal(h.current.title, "Original");
});

test("rejected or failed presentation updates never publish or obscure verified server writes", async () => {
  for (const options of [{ acceptSync: false }, { failSync: true }]) {
    const h = load(options);
    const preview = await h.request("TITLE_PREVIEW", { rules: { timeZone: "UTC" } });
    h.calls.length = 0;
    const result = await h.request("TITLE_APPLY", { planId: preview.payload.plan.id });
    assert.equal(result.payload.operation.status, "verified");
    assert.equal(h.calls.filter((call) => call.stage === "sync-accept").length, 1);
    assert.equal(h.calls.some((call) => call.stage === "snapshot-publish"), false);
    assert.equal(h.calls.at(-1).stage, "main-response");
  }
});

test("content-script senders, owner mismatch, changed routes and unbound snapshots cannot reach title adapter", async () => {
  for (const [options, payload, sender] of [
    [{}, {}, { tab: { id: 31 }, url: "https://chatgpt.com/c/current" }],
    [{}, { expectedTabId: 32 }, panelSender],
    [{ panelPath: "app/sidepanel/index.html?tidyTabId=32" }, {}, panelSender],
    [{ snapshotId: "different" }, {}, panelSender],
    [{ url: "https://chatgpt.com/g/g-custom/c/current" }, {}, panelSender],
    [{ bound: false }, {}, panelSender],
  ]) {
    const h = load(options);
    const result = await h.request("TITLE_PREVIEW", payload, sender);
    assert.equal(result.ok, false);
    assert.equal(h.calls.some((call) => call.stage.startsWith("adapter-")), false);
  }
});

test("worker refuses public calls to internal writer and apply without stored preview", async () => {
  const h = load();
  assert.equal((await h.request("TITLE_WRITE_CURRENT", { before: "Original", after: "Arbitrary" })).error.code, "UNSUPPORTED_TYPE");
  assert.equal((await h.request("TITLE_APPLY", { planId: "invented" })).error.code, "TITLE_PREVIEW_REQUIRED");
  assert.equal(h.calls.some((call) => call.stage === "adapter-write"), false);
});

test("a fresh read resolves an uncertain receipt but cannot replay its old confirmation", async () => {
  const h = load({ uncertain: true });
  const preview = await h.request("TITLE_PREVIEW", { rules: { timeZone: "UTC" } });
  const result = await h.request("TITLE_APPLY", { planId: preview.payload.plan.id });
  assert.equal(result.payload.operation.status, "uncertain");
  await h.request("TITLE_APPLY", { planId: preview.payload.plan.id });
  const fresh = await h.request("TITLE_PREVIEW");
  assert.equal(fresh.payload.plan.before, h.current.title);
  assert.notEqual(fresh.payload.plan.id, preview.payload.plan.id);
  const stale = await h.request("TITLE_APPLY", { planId: preview.payload.plan.id });
  assert.equal(stale.error.code, "TITLE_PREVIEW_REQUIRED");
  const check = await h.request("TITLE_RECONCILE");
  assert.equal(check.payload.operation.status, "conflict");
  assert.equal(check.payload.operation.messageCode, "title_unchanged");
  assert.equal(check.payload.plan, null);
  assert.equal(h.calls.filter((call) => call.stage === "adapter-write").length, 1);
});

for (const outcome of ["committed", "unchanged", "manual"]) {
  test(`lost page reply, failed read and worker restart recover ${outcome} without accepting a late reply`, async () => {
    const options = { holdWriteReply: true, uncertain: outcome !== "committed" };
    const h = load(options);
    const first = await h.request("TITLE_PREVIEW", { rules: { timeZone: "UTC" } });
    const applying = h.request("TITLE_APPLY", { planId: first.payload.plan.id });
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    assert.equal(h.pendingWriteReplies(), 1, "write completed in MAIN, but its reply is held at the page bridge");
    const pendingTimers = h.timers.filter(timer => !timer.cleared);
    assert.equal(pendingTimers.length, 1, "only the write reply is still pending");
    // 使用真实超时回调，不实际等待几十秒，也不通过重复 POST 恢复。
    pendingTimers[0].callback();
    const lost = await applying;
    assert.equal(lost.ok, true); assert.equal(lost.payload.operation.status, "uncertain");
    h.restartTitleService();
    if (outcome === "manual") h.current.title = "Manual edit after the interruption";
    options.failRead = true;
    const unread = await h.request("TITLE_RECONCILE");
    assert.equal(unread.ok, false); assert.equal(unread.error.code, "TITLE_AUTH_REQUIRED");
    assert.equal([...h.records.values()][0].operation.status, "uncertain");
    options.failRead = false;
    const recovered = await h.request("TITLE_RECONCILE");
    assert.equal(recovered.ok, true);
    assert.equal(recovered.payload.operation.status, outcome === "committed" ? "verified" : "conflict");
    assert.equal(recovered.payload.current.title, h.current.title); assert.equal(recovered.payload.plan, null);
    const fresh = await h.request("TITLE_PREVIEW", { rules: { timeZone: "UTC" } });
    assert.equal(fresh.payload.plan.before, h.current.title);
    assert.notEqual(fresh.payload.plan.id, first.payload.plan.id);
    const checkpoint = plain([...h.records]);
    h.releaseWriteReplies(); await new Promise(setImmediate);
    assert.deepEqual(plain([...h.records]), checkpoint, "late reply cannot overwrite a new recovery or plan");
    assert.equal(h.calls.filter(call => call.stage === "adapter-write").length, 1);
    const stale = await h.request("TITLE_APPLY", { planId: first.payload.plan.id });
    assert.equal(stale.error.code, "TITLE_PREVIEW_REQUIRED");
    assert.equal(h.calls.filter(call => call.stage === "adapter-write").length, 1);
    if (outcome !== "committed") {
      options.holdWriteReply = false; options.uncertain = false;
      const saved = await h.request("TITLE_APPLY", { planId: fresh.payload.plan.id });
      assert.equal(saved.payload.operation.status, "verified");
      assert.equal(h.calls.filter(call => call.stage === "adapter-write").length, 2, "only a new explicit confirmation can write again");
    }
  });
}

test("title bridge rejects response type drift and preserves sanitized auth code", async () => {
  const h = load({ wrongResponseType: true });
  assert.equal((await h.request("TITLE_STATUS")).error.code, "TITLE_UNAVAILABLE");
  const unauthorized = await load({ failRead: true }).request("TITLE_STATUS");
  assert.equal(unauthorized.error.code, "TITLE_AUTH_REQUIRED");
  assert.equal(unauthorized.error.details.status, 401);
  assert.equal(Object.hasOwn(unauthorized.error.details, "httpStatus"), false);
  assert.doesNotMatch(JSON.stringify(unauthorized), /redacted/);
});

// Use the real diagnostics observer, transport, admission and session store;
// only Chrome messaging/storage are isolated. No generated file is written by this test.
let diagnosticBuild;
async function exportTitleFailure(response) {
  diagnosticBuild ||= require("../tools/build-message-index.cjs").buildOutputs().get("src/messages/build-info.js");
  const context = vm.createContext({ URL, TextEncoder, Uint8Array, crypto: require("node:crypto").webcrypto });
  const modules = createWorkerModuleLoader(context, {
    read: file => file === "src/messages/build-info.js" ? diagnosticBuild : source(file),
  });
  const { createDiagnosticsService } = modules.load("src/platform/diagnostics/worker-service.js");
  modules.load("src/platform/diagnostics/client.js");
  let saved;
  const runtime = { id: "tidy-test", getURL: file => "chrome-extension://tidy-test/" + file };
  const service = createDiagnosticsService({ chrome: { runtime, storage: { session: {
    get: async key => ({ [key]: saved }),
    set: async value => { saved = plain(value["tidy.diagnostics.session.v1"]); },
  } } } });
  const client = context.TidyDiagnosticsTransport.createClient({ runtime: {
    sendMessage: message => service.handle(message, { id: runtime.id, ...panelSender }),
  } });
  client.attach();
  const cause = context.ChatGPTTidyDiagnostics.cause({ ...response.error, requestId: response.requestId });
  context.ChatGPTTidyDiagnostics.notice({ event: "show", surface: "titles.current.notice",
    source: "src/features/titles/ui/title-view.js", messageKey: "titlesReadFailed", ...cause });
  await new Promise(setImmediate);
  const result = JSON.parse((await client.exportText()).text);
  client.dispose();
  return result;
}

test("title read failures preserve canonical HTTP status and only fixed stages through copied diagnostics", async () => {
  const stages = ["http", "conversation-id", "title-shape", "project-match", "read-only", "temporary", "owner-shape", "owner-match"];
  for (const suffix of stages) {
    const stage = "main-world.title.metadata." + suffix;
    const status = suffix === "http" ? 403 : 200;
    const readError = Object.assign(new Error("PRIVATE_SERVER_TEXT"), {
      tidyCode: suffix === "project-match" ? "TITLE_TARGET_CHANGED" : "TITLE_UNAVAILABLE", httpStatus: status, stage,
      details: { authorization: "Bearer PRIVATE_TOKEN", title: "PRIVATE_TITLE", accountKey: "PRIVATE_ACCOUNT" },
      body: { owner: { user_id: "PRIVATE_OWNER" }, conversation_id: "PRIVATE_CONVERSATION" },
    });
    const response = await load({ readError }).request("TITLE_PREVIEW");
    assert.equal(response.ok, false);
    assert.deepEqual(plain(response.error.details), { status, stage });
    assert.doesNotMatch(JSON.stringify(response), /PRIVATE|Bearer/);
    const report = await exportTitleFailure(response);
    assert.equal(report.events.length, 1);
    const event = report.events[0];
    assert.equal(event.reasonCode, readError.tidyCode);
    assert.equal(event.requestId, response.requestId);
    assert.equal(event.status, status);
    assert.equal(event.stage, stage);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE|Bearer|httpStatus/);
  }
});

test("title error projection rejects unknown stages and non-HTTP status values without coercion or aliases", async () => {
  for (const httpStatus of [undefined, null, 0, 99, 600, "403", 403.5, NaN, Infinity, {}, []]) {
    const readError = Object.assign(new Error("PRIVATE_SERVER_TEXT"), {
      tidyCode: "TITLE_UNAVAILABLE", httpStatus, stage: "https://PRIVATE_SERVER/PRIVATE_ID",
      // These fields must not become a fallback compatibility channel.
      status: 403, details: { httpStatus: 403, status: 403, stage: "main-world.title.metadata.http" },
    });
    const response = await load({ readError }).request("TITLE_PREVIEW");
    assert.deepEqual(plain(response.error.details), { status: null, stage: null });
    assert.doesNotMatch(JSON.stringify(response), /PRIVATE|httpStatus/);
  }
  for (const httpStatus of [100, 200, 401, 403, 429, 599]) {
    const response = await load({ readError: Object.assign(new Error("PRIVATE_SERVER_TEXT"), {
      tidyCode: "TITLE_UNAVAILABLE", httpStatus, stage: "main-world.search-adapter",
    }) }).request("TITLE_PREVIEW");
    assert.deepEqual(plain(response.error.details), { status: httpStatus, stage: null },
      "another feature's registered stage is still not a title stage");
  }
});

test("a changed global timezone rejects the frozen date plan before adapter dispatch", async () => {
  const h = load({ timeZone: "Asia/Tokyo" });
  const preview = await h.request("TITLE_PREVIEW", { rules: { mode: "range", dateFormat: "iso", timeZone: "UTC" } });
  const result = await h.request("TITLE_APPLY", { planId: preview.payload.plan.id });
  assert.equal(result.payload.operation.status, "failed");
  assert.equal(result.payload.operation.messageCode, "rules_changed");
  assert.equal(h.calls.filter((call) => call.stage === "adapter-write").length, 0);
});

test("provable pre-dispatch context failure is retryable via new preview, not permanently uncertain", async () => {
  // Preview: outer snapshot + read snapshot. Apply: outer snapshot + read
  // snapshot + write preflight snapshot (5). The write envelope never leaves.
  for (const options of [{ failSnapshotAt: 5 }, { rejectBeforeWrite: true }]) {
    const h = load(options);
    const preview = await h.request("TITLE_PREVIEW", { rules: { timeZone: "UTC" } });
    const result = await h.request("TITLE_APPLY", { planId: preview.payload.plan.id });
    assert.equal(result.payload.operation.status, "failed");
    assert.equal(h.calls.filter((call) => call.stage === "adapter-write").length, 0);
    const again = await h.request("TITLE_PREVIEW", { rules: { timeZone: "UTC" } });
    assert.equal(again.payload.plan.canApply, true);
  }
});

test("option replans never cross the ChatGPT bridge after the first authenticated preview", async () => {
  const h = load({ currentTitle: "2026-08-31｜Original" });
  const preview = await h.request("TITLE_PREVIEW", { rules: { mode: "created", dateFormat: "iso", timeZone: "UTC" } });
  assert.equal(preview.ok, true);
  assert.equal(typeof preview.payload.previewContext.id, "string");
  assert.equal(h.calls.filter((call) => call.stage === "adapter-read").length, 1);
  assert.equal(h.calls.filter((call) => call.type === "snapshot.get").length, 2);
  const authenticatedCalls = plain(h.calls);
  const planIds = new Set([preview.payload.plan.id]);
  const afterTitles = new Set();
  // The same conflict/rules controls as production: every one reuses this
  // frozen metadata even if the page or session endpoint is now unavailable.
  for (const [decision, dateFormat, mode] of [
    ["replace", "iso", "created"], ["stack", "iso", "created"], ["skip", "iso", "created"],
    ["replace", "slash", "created"], ["replace", "dot", "range"], ["stack", "compact", "range"],
  ]) {
    const result = await h.request("TITLE_REPLAN", {
      previewContextId: preview.payload.previewContext.id,
      operation: "assign", decision, rules: { mode, dateFormat, timeZone: "UTC" },
      current: { ...h.current, title: "Forged caller metadata" }, after: "Forged final title",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(plain(result.payload.previewContext), plain(preview.payload.previewContext));
    assert.equal(result.payload.plan.before, "2026-08-31｜Original");
    assert.equal(result.payload.plan.selectedDecision, decision);
    assert.equal(result.payload.plan.rules.dateFormat, dateFormat);
    assert.equal(result.payload.plan.rules.mode, mode);
    assert.ok(!planIds.has(result.payload.plan.id), "each local choice creates a new immutable plan");
    planIds.add(result.payload.plan.id);
    afterTitles.add(result.payload.plan.after);
    assert.deepEqual(plain(h.calls), authenticatedCalls, "no GET_SNAPSHOT, title read, session read or write is added");
  }
  assert.equal(afterTitles.size, 6);
});

test("local replanning retains the authenticated metadata instead of rereading a changed page", async () => {
  const options = {};
  const h = load(options);
  const preview = await h.request("TITLE_PREVIEW", { rules: { timeZone: "UTC" } });
  const frozen = plain(preview.payload.current);
  h.current.title = "Changed externally";
  h.current.updatedAt = "2026-09-09T00:00:00.000Z";
  options.failRead = true;
  options.failSnapshotAt = 3;
  h.calls.length = 0;
  const replanned = await h.request("TITLE_REPLAN", {
    previewContextId: preview.payload.previewContext.id,
    rules: { mode: "range", dateFormat: "iso", timeZone: "UTC" },
  });
  assert.equal(replanned.ok, true);
  assert.deepEqual(plain(replanned.payload.current), frozen);
  assert.equal(replanned.payload.plan.before, "Original");
  assert.equal(replanned.payload.plan.after, "2026-09-01\u2009~\u200909-08｜Original");
  assert.deepEqual(h.calls, []);
});

test("replan still rejects wrong panel senders, owner tabs and nonexact ordinary routes without messaging ChatGPT", async () => {
  for (const [changes, payload, sender] of [
    [{}, {}, { tab: { id: 31 }, url: "https://chatgpt.com/c/current" }],
    [{}, {}, { url: "chrome-extension://other/app/sidepanel/index.html?tidyTabId=31" }],
    [{}, { expectedTabId: 32 }, panelSender],
    [{ panelPath: "app/sidepanel/index.html?tidyTabId=32" }, {}, panelSender],
    [{}, {}, { url: "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=31&extra=1" }],
    [{ url: "https://chatgpt.com/c/different" }, {}, panelSender],
    [{ url: "https://chatgpt.com/g/g-custom/c/current" }, {}, panelSender],
    [{ url: "https://chatgpt.com/" }, {}, panelSender],
    [{ url: "https://example.com/c/current" }, {}, panelSender],
    [{ url: "http://chatgpt.com/c/current" }, {}, panelSender],
    [{ url: "https://chatgpt.com:9443/c/current" }, {}, panelSender],
  ]) {
    const options = {};
    const h = load(options);
    const preview = await h.request("TITLE_PREVIEW");
    Object.assign(options, changes);
    h.calls.length = 0;
    const result = await h.request("TITLE_REPLAN", { previewContextId: preview.payload.previewContext.id, ...payload }, sender);
    assert.equal(result.ok, false);
    assert.deepEqual(h.calls, [], "rejected local choices cannot trigger a fallback read");
  }
});

test("missing, expired and restarted preview contexts fail locally without an automatic authenticated reread", async () => {
  const missing = load();
  for (const payload of [{}, { previewContextId: "invented" }]) {
    const result = await missing.request("TITLE_REPLAN", payload);
    assert.equal(result.error.code, "TITLE_PREVIEW_REQUIRED");
    assert.deepEqual(missing.calls, []);
  }
  for (const restarted of [false, true]) {
    const options = { now: 1_000 };
    const h = load(options);
    const preview = await h.request("TITLE_PREVIEW");
    if (restarted) h.restartTitleService();
    else options.now = preview.payload.previewContext.expiresAt + 1;
    h.calls.length = 0;
    const result = await h.request("TITLE_REPLAN", { previewContextId: preview.payload.previewContext.id });
    assert.equal(result.error.code, restarted ? "TITLE_PREVIEW_REQUIRED" : "TITLE_PLAN_EXPIRED");
    assert.deepEqual(h.calls, []);
  }
});

test("a frozen context cannot be borrowed by another valid owner-bound panel", async () => {
  const options = {};
  const h = load(options);
  const preview = await h.request("TITLE_PREVIEW");
  options.panelPath = "app/sidepanel/index.html?tidyTabId=32";
  h.calls.length = 0;
  const result = await h.request("TITLE_REPLAN", {
    expectedTabId: 32, previewContextId: preview.payload.previewContext.id,
  }, { url: "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=32" });
  assert.equal(result.error.code, "CONTEXT_MISMATCH");
  assert.deepEqual(h.calls, []);
});

test("applying a locally replanned title retains live snapshots, identity checks and exact writer preconditions", async () => {
  const h = load();
  const preview = await h.request("TITLE_PREVIEW", { rules: { timeZone: "UTC" } });
  const replanned = await h.request("TITLE_REPLAN", {
    previewContextId: preview.payload.previewContext.id,
    rules: { mode: "range", dateFormat: "iso", timeZone: "UTC" },
  });
  const plan = plain(replanned.payload.plan);
  h.calls.length = 0;
  const applied = await h.request("TITLE_APPLY", { planId: plan.id, after: "UNREVIEWED OVERRIDE" });
  assert.equal(applied.ok, true);
  assert.equal(applied.payload.operation.status, "verified");
  assert.equal(h.current.title, plan.after);
  assert.deepEqual(h.calls.filter((call) => call.stage === "worker").map((call) => call.type), [
    "snapshot.get", "snapshot.get", "titles.adapter.read-current", "snapshot.get", "titles.adapter.write-current",
  ]);
  assert.deepEqual(h.calls.filter((call) => call.stage === "adapter-read").map((call) => call.payload), [
    { identityOnly: true, conversationId: "current", targetProjectId: null },
  ]);
  const writes = h.calls.filter((call) => call.stage === "adapter-write");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].payload, {
    identity: { accountKey: "user-1", workspaceKey: "personal" },
    before: "Original", after: plan.after, conversationId: "current", targetProjectId: null, metadataSource: "detail",
    expectedCreatedAt: "2026-09-01T00:00:00.000Z", expectedUpdatedAt: "2026-09-08T00:00:00.000Z", expectedTimeZone: "UTC",
  });
  assert.equal(h.calls.filter((call) => call.stage === "sync-accept").length, 1);
  h.calls.length = 0;
  const consumed = await h.request("TITLE_REPLAN", { previewContextId: preview.payload.previewContext.id });
  assert.equal(consumed.error.code, "TITLE_PREVIEW_REQUIRED");
  assert.deepEqual(h.calls, []);
});

test("a live account change still rejects application of a locally replanned title", async () => {
  const h = load();
  const preview = await h.request("TITLE_PREVIEW", { rules: { timeZone: "UTC" } });
  const replanned = await h.request("TITLE_REPLAN", {
    previewContextId: preview.payload.previewContext.id, rules: { dateFormat: "iso", timeZone: "UTC" },
  });
  h.identity.accountKey = "different-account";
  h.calls.length = 0;
  const result = await h.request("TITLE_APPLY", { planId: replanned.payload.plan.id });
  assert.equal(result.error.code, "TITLE_PREVIEW_REQUIRED");
  assert.equal(h.calls.filter((call) => call.stage === "adapter-read").length, 1);
  assert.equal(h.calls.some((call) => call.stage === "adapter-write"), false);
});

test("a live timezone change still blocks the locally replanned write before adapter dispatch", async () => {
  const options = {};
  const h = load(options);
  const preview = await h.request("TITLE_PREVIEW", { rules: { timeZone: "UTC" } });
  const replanned = await h.request("TITLE_REPLAN", {
    previewContextId: preview.payload.previewContext.id, rules: { dateFormat: "iso", timeZone: "UTC" },
  });
  options.timeZone = "Asia/Tokyo";
  h.calls.length = 0;
  const result = await h.request("TITLE_APPLY", { planId: replanned.payload.plan.id });
  assert.equal(result.payload.operation.status, "failed");
  assert.equal(result.payload.operation.messageCode, "rules_changed");
  assert.equal(h.calls.some((call) => call.stage === "adapter-write"), false);
});

test("normal complete directory preview never crosses the title page bridge", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ conversationId: `complete-${i}`, title: `Title ${i}`, projectId: null,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z" }));
  const h = load({ rows, completeCatalog: true });
  const result = await h.request("TITLE_BATCH_PREVIEW", { conversationIds: rows.map(row => row.conversationId), accountKey: "catalog-user-1",
    rules: { mode: "created", dateFormat: "iso", timeZone: "UTC" } });
  assert.equal(result.ok, true); assert.equal(result.payload.phase, "preview"); assert.equal(result.payload.counts.ready, 10);
  const reads = h.calls.filter(call => call.stage === "adapter-read");
  assert.equal(reads.length, 0);
  assert.equal(h.calls.some(call => call.stage === "adapter-write"), false);
});
