/* Local-only title pipeline audit. No browser, account or network is used.
 * The real worker entrypoint and whole page modules run in separate VM realms.
 * Only browser transports, DOM evidence, HTTP and durable storage are synthetic.
 * Counts/JSON byte volumes are measured. Delay totals are an explicit model,
 * not real ChatGPT or IndexedDB latency. Run: node tools/benchmark-title-backend.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");
const { sourceFiles: mainSourceFiles } = require("./build-main-world.cjs");
const root = path.resolve(__dirname, "..");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");
const plain = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const bytes = (value) => value == null ? 0 : Buffer.byteLength(JSON.stringify(value));

function auditSource(file) {
  const contents = source(file);
  if (file !== "src/features/titles/background/title-service.js") return contents;
  // Read-only instrumentation: expose the actual cache, without changing any
  // cache operation or the production service's public API.
  const marker = "const previewContexts = new Map();";
  assert.ok(contents.includes(marker), "title preview cache instrumentation marker changed");
  return contents.replace(marker, "const previewContexts = globalThis.__auditTitlePreviewContexts = new Map();");
}

/**
 * Load complete production ES modules into one worker realm. Only module
 * declarations are translated; module bodies/entrypoints are never sliced.
 * Storage substitutions are keyed by exact module path, not arbitrary symbols,
 * so a future business dependency cannot silently become a benchmark shortcut.
 */
function createWorkerModuleLoader(context, storageModules) {
  const cache = new Map();
  function load(file) {
    const name = path.posix.normalize(file.replaceAll("\\", "/"));
    assert.ok(name.startsWith("src/") && !name.includes("../"), "Only production modules belong in the worker graph");
    if (Object.hasOwn(storageModules, name)) return storageModules[name];
    if (cache.has(name)) return cache.get(name);
    const namespace = {};
    cache.set(name, namespace);
    const exports = [];
    let code = auditSource(name);
    code = code.replace(/^import\s+([^;]*?)\s+from\s+(['"])([^'"]+)\2\s*;[ \t]*$/gm,
      (_all, specifier, _quote, relative) => {
        assert.ok(relative.startsWith("."), "The worker graph must use explicit local dependencies");
        const dependency = path.posix.join(path.posix.dirname(name), relative);
        const spec = specifier.trim();
        if (spec.startsWith("{")) return spec.slice(1, -1).split(",").map(value => value.trim()).filter(Boolean).map(member => {
          const [remote, local = remote] = member.split(/\s+as\s+/);
          return "const " + local + " = __dependency(" + JSON.stringify(dependency) + ")[" + JSON.stringify(remote) + "];";
        }).join("\n");
        if (spec.startsWith("* as ")) return "const " + spec.slice(5).trim() + " = __dependency(" + JSON.stringify(dependency) + ");";
        if (/^[\w$]+$/.test(spec)) return "const " + spec + " = __dependency(" + JSON.stringify(dependency) + ").default;";
        throw new Error("Unsupported production import in " + name + ": " + spec);
      });
    code = code.replace(/^import\s+(['"])([^'"]+)\1\s*;[ \t]*$/gm,
      (_all, _quote, relative) => "__dependency(" + JSON.stringify(path.posix.join(path.posix.dirname(name), relative)) + ");");
    code = code.replace(/^export\s+(async\s+)?(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
      (_all, asyncPrefix = "", kind, identifier) => {
        exports.push([identifier, identifier]);
        return asyncPrefix + kind + " " + identifier;
      });
    code = code.replace(/^export\s*\{([^}]+)\}\s*;?[ \t]*$/gm, (_all, members) => {
      for (const member of members.split(",").map(value => value.trim()).filter(Boolean)) {
        const [local, remote = local] = member.split(/\s+as\s+/);
        exports.push([remote, local]);
      }
      return "";
    });
    if (/^\s*(?:import|export)\s/m.test(code)) throw new Error("Unsupported module declaration in " + name);
    const expose = exports.map(([remote, local]) =>
      "Object.defineProperty(__exports, " + JSON.stringify(remote) + ", { enumerable: true, get: () => " + local + " });").join("\n");
    vm.runInContext("(function (__dependency, __exports) {\n\"use strict\";\n" + code + "\n" + expose + "\n})",
      context, { filename: name })(load, namespace);
    return namespace;
  }
  return Object.freeze({ load });
}

/**
 * Host-only fixture for the standalone audit. It does not import tests or
 * duplicate title routing/planning/authorization. The actual service-worker
 * entrypoint registers the listener, and the actual ISOLATED/MAIN bridge
 * dispatches every page command, including probes and owner snapshots.
 */
function createBenchmarkRuntime({ rows }) {
  let receiveWorker, receiveIsolated, receiveWindow, counter = 0;
  const calls = [], projections = [], timers = [], records = new Map();
  const current = { conversationId: "current", title: "Original",
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z" };
  const targets = new Map([current, ...rows].map(row => [row.conversationId, row]));
  const event = () => ({ addListener() {}, removeListener() {} });
  const pageSender = { tab: { id: 31 }, frameId: 0, documentId: "doc-31",
    documentLifecycle: "active", url: "https://chatgpt.com/c/current" };
  const panelSender = { url: "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=31" };
  const base = { console, URL, URLSearchParams, Intl, Date, Math, AbortController, AbortSignal, Event,
    setTimeout, clearTimeout, crypto: { randomUUID: () => "audit-" + ++counter } };
  const operationRepository = {
    get: async key => records.has(key) ? plain(records.get(key)) : null,
    set: async (key, value) => { records.set(key, plain(value)); },
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) records.delete(key); },
  };
  // These are durable-store ports, not title services. Their contents are
  // deterministic synthetic directory rows; all selection/rules/receipts run
  // through production catalog selection, title core and batch services.
  const catalogRepository = {
    getRow: async (accountKey, id) => {
      const row = accountKey === "catalog-user-1" && targets.get(id);
      return row ? { ...row, createdAt: Date.parse(row.createdAt), updatedAt: Date.parse(row.updatedAt) } : null;
    },
    getSnapshot: async accountKey => ({ rows: accountKey === "catalog-user-1" ? [...targets.values()].map(row => ({
      ...row, createdAt: Date.parse(row.createdAt), updatedAt: Date.parse(row.updatedAt),
    })) : [], state: { accountKey } }),
    observeTitles: async (accountKey, observations) => { projections.push({ accountKey, observations: plain(observations) }); },
    acceptTitles: async (accountKey, intents) => { projections.push({ accountKey, intents: plain(intents), accepted: true }); },
  };
  const localValues = new Map([["tidy.titles.rules.v1", { mode: "range", dateFormat: "iso" }]]);
  const syncValues = new Map([["tidy.v1.preferences", { timeZone: "UTC" }]]);
  const worker = vm.createContext({ ...base, chrome: {
    runtime: {
      id: "tidy-test", getURL: (value = "") => "chrome-extension://tidy-test/" + String(value).replace(/^\//, ""),
      getContexts: async () => [],
      sendMessage: async envelope => { calls.push({ stage: "broadcast", type: envelope.type, payload: plain(envelope.payload) }); },
      onInstalled: event(), onStartup: event(), onConnect: event(),
      onMessage: { addListener: listener => { receiveWorker = listener; } },
    },
    tabs: {
      query: async () => [], get: async id => ({ id, url: pageSender.url }),
      sendMessage: async (tabId, envelope) => {
        assert.equal(tabId, 31, "All page requests must use the bound synthetic tab");
        calls.push({ stage: "worker", tabId, type: envelope.type, payload: plain(envelope.payload) });
        return new Promise(resolve => { assert.equal(receiveIsolated(envelope, {}, resolve), true); });
      },
      onUpdated: event(), onActivated: event(), onRemoved: event(),
    },
    sidePanel: {
      setPanelBehavior: async () => {},
      getOptions: async () => ({ enabled: true, path: "app/sidepanel/index.html?tidyTabId=31" }),
    },
    action: { setIcon: async () => {} },
    storage: { onChanged: event(), sync: {
      get: (key, callback) => callback({ [key]: plain(syncValues.get(key)) }),
      set: (values, callback) => { for (const [key, value] of Object.entries(values)) syncValues.set(key, plain(value)); callback(); },
    }, local: {
      get: async key => ({ [key]: plain(localValues.get(key)) }),
      set: async values => { for (const [key, value] of Object.entries(values)) localValues.set(key, plain(value)); },
    } },
    webNavigation: { onHistoryStateUpdated: event(), onCommitted: event(),
      getFrame: async () => ({ ...pageSender }) },
  } });
  const modules = createWorkerModuleLoader(worker, {
    "src/platform/catalog/storage/conversation-catalog.js": { createConversationCatalogRepository: () => catalogRepository },
    "src/features/titles/storage/title-operations.js": { titleOperationsRepository: operationRepository },
  });
  modules.load("src/app/background/service-worker.js");
  assert.equal(typeof receiveWorker, "function", "The genuine worker entrypoint must register its runtime listener");

  const attributes = new Map(), documentListeners = new Map();
  const nativeRow = {
    childNodes: [{ nodeType: 3, textContent: current.title }], parentElement: { closest: () => null },
    getAttribute: name => name === "href" ? "/c/current" : name === "data-sidebar-item" ? "true" : null,
    setAttribute() {}, closest: () => null, matches: () => false, querySelector: () => null,
    __reactFiber$audit: { memoizedProps: { historyItem: { id: "current", title: current.title,
      create_time: Date.parse(current.createdAt) / 1000, update_time: Date.parse(current.updatedAt) / 1000 } }, return: null },
  };
  const document = {
    title: "ChatGPT", cookie: "", body: null,
    documentElement: { dataset: {}, classList: { contains: () => false },
      setAttribute: (key, value) => attributes.set(key, String(value)), getAttribute: key => attributes.get(key) ?? null },
    querySelector: () => null,
    querySelectorAll: selector => selector.startsWith("a[") || selector.includes("a[href") ? [nativeRow] : [],
    addEventListener: (type, listener) => {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type).add(listener);
    },
    removeEventListener: (type, listener) => documentListeners.get(type)?.delete(listener),
    dispatchEvent: event => { for (const listener of documentListeners.get(event.type) || []) listener(event); return true; },
  };
  const main = vm.createContext({ ...base, Headers, encodeURIComponent, decodeURIComponent, document,
    location: { href: pageSender.url, origin: "https://chatgpt.com" },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, CSS: { escape: value => String(value) },
    addEventListener() {}, removeEventListener() {},
    getComputedStyle: () => ({ colorScheme: "", backgroundColor: "rgba(0, 0, 0, 0)" }),
  });
  // Use the build's canonical ordering for whole MAIN modules. Only its
  // browser-lifecycle composition root is omitted: this benchmark explicitly
  // drives requests, rather than running DOM observers or background polling.
  for (const file of mainSourceFiles) if (file !== "src/app/page/main-world.js") {
    vm.runInContext(source(file), main, { filename: file });
  }
  const reader = main.TidyChatgptNativeSnapshotReader.create();
  const metadata = main.TidyChatgptSnapshotMetadata.create({
    routeStillOwnsConversation: reader.routeStillOwnsConversation, onChanged() {},
  });
  const snapshot = main.TidyChatgptSnapshotProjection.create({ reader, metadata, titleProjection: main.TidyChatgptTitleSync });
  const titleAdapter = Object.fromEntries(["readCurrent", "writeCurrent", "beginBatchExecution", "endBatchExecution"]
    .map(method => [method, (...args) => {
      assert.ok(main.titleAdapter, "The measured real title adapter must be installed before a request");
      return main.titleAdapter[method](...args);
    }]));
  const router = main.TidyPageRequestRouter.create({
    titleAdapter, readSnapshot: snapshot.read, titleProjection: main.TidyChatgptTitleSync,
    dateIndexAdapter: main.TidyChatgptDateIndex,
    publishSnapshot: reason => calls.push({ stage: "snapshot-publish", reason }),
    postEnvelope: envelope => receiveWindow({ source: isolated.window, origin: main.location.origin,
      data: { channel: worker.TidyProtocol.WINDOW_CHANNEL, source: "chatgpt-main-world", envelope } }),
  });
  const mainWindow = vm.runInContext("globalThis", main);
  const isolated = vm.createContext({ ...base, document,
    setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout: timer => { timer.cleared = true; },
    chrome: { runtime: { id: "tidy-test",
      sendMessage: envelope => new Promise(resolve => { assert.equal(receiveWorker(envelope, pageSender, resolve), true); }),
      onMessage: { addListener: listener => { receiveIsolated = listener; }, removeListener() {} },
    } },
    window: { location: { origin: main.location.origin },
      addEventListener: (_type, listener) => { receiveWindow = listener; }, removeEventListener() {},
      postMessage: ({ envelope }) => router.handleMessage({ source: mainWindow, origin: main.location.origin,
        data: { channel: worker.TidyProtocol.WINDOW_CHANNEL, source: "chatgpt-isolated", envelope } }),
    },
  });
  for (const file of ["src/platform/protocol.js", "src/platform/snapshot.js", "src/features/search/model/search.js",
    "src/platform/catalog/date-search.js", "src/features/export/model/export.js",
    "src/platform/session/shared/page-session.js"]) vm.runInContext(source(file), isolated, { filename: file });
  isolated.TidyPageSession = isolated.TidyPageSessionContract.create({ runtime: isolated.chrome.runtime });
  vm.runInContext(source("src/app/page/isolated.js"), isolated, { filename: "src/app/page/isolated.js" });
  const request = (type, payload) => new Promise(resolve => {
    const envelope = worker.TidyProtocol.request(worker.TidyProtocol.Type[type], {
      expectedTabId: 31, expectedConversationId: "current", ...payload,
    });
    assert.equal(receiveWorker(envelope, panelSender, resolve), true);
  });
  return { worker, main, current, records, calls, projections, operationRepository, catalogRepository, request };
}
const assumptions = { sessionMs: 150, metadataMs: 200, postMs: 200, chromeBridgeMs: 2, durableOperationMs: 1 };

// These are the reviewed call budgets, not performance targets. An intentional
// pipeline change should update them only after its ownership/recovery tests pass.
// This keeps a harness shortcut from silently deleting a real guard or request.
function assertBudgets(stages, n) {
  const expected = {
    // 每条业务命令新增一次只读文档握手；它不发 HTTP、不读取账号或会话内容。
    preview: { session: 0, metadata: 0, post: 0, snapshots: 0, pageProbes: 1, bridge: 1, tabGet: 2, panelRequests: 1, operationGets: 1, operationSets: 2, modelPlan: n },
    // 替换时删除旧记录，不再写入墓碑；一次本地删除替代一次本地保存。
    replan: { session: 0, metadata: 0, post: 0, snapshots: 0, pageProbes: 1, bridge: 1, tabGet: 2, panelRequests: 1, operationGets: 2, operationSets: 2, operationRemoves: 1, modelPlan: n },
    apply: { session: 1, metadata: 0, post: 0, snapshots: 1, pageProbes: 1, bridge: 3, tabGet: 3, panelRequests: 1, operationGets: 2, operationSets: 1 },
    // Catalog intent validation reuses the metadata preflight. Each authorized
    // POST additionally refreshes identity after preflight: a batch lease must
    // not authorize another user's session in the same personal workspace.
    // Normal 2xx remains accepted without extra metadata/readback requests.
    // 每项派发前多一次本地读取与保存，区分“尚未发送”和“可能已发送”；HTTP 预算不变。
    step: { session: n, metadata: n, preflight: n, readback: 0, post: n, snapshots: n + 1, pageProbes: n, bridge: 3 * n + 2, tabGet: 3 * n + 1, panelRequests: n, operationGets: 5 * n, operationSets: 6 * n, catalogProjections: n, modelPlan: n },
  };
  const mismatches = [];
  for (const [stage, counters] of Object.entries(expected)) {
    for (const [counter, value] of Object.entries(counters)) if (stages[stage][counter] !== value) {
      mismatches.push({ counter: `${stage}.${counter}`, actual: stages[stage][counter], expected: value });
    }
  }
  assert.deepEqual(mismatches, [], `N=${n}: measured pipeline budgets changed`);
}

async function measure(n, { detailTimeOffsetMs = 0, mode = "created", dateFormat = "slash", locale = "en-US" } = {}) {
  const rows = Array.from({ length: n }, (_, index) => ({ conversationId: `target-${String(index).padStart(3, "0")}`,
    title: `Synthetic title ${index}`, projectId: index % 3 === 0 ? "g-p-benchmark" : null,
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }));
  const h = createBenchmarkRuntime({ rows });
  const targets = new Map([h.current, ...rows].map((row) => [row.conversationId, row]));
  let confirmedTitles = new Map();
  let stage = "preview", operation = "idle", writeMetadata = 0;
  const stages = {}, trace = [], previewCacheAfterStage = {};
  const metrics = () => stages[stage] ||= { session: 0, metadata: 0, preflight: 0, readback: 0, post: 0,
    adapterIdentity: 0, adapterFullRead: 0, adapterWrite: 0, snapshots: 0, pageProbes: 0, tabGet: 0, bridge: 0, panelRequests: 0,
    publicBytes: 0, operationGets: 0, operationSets: 0, operationRemoves: 0, readBytes: 0, writtenBytes: 0,
    jobGetBytes: 0, jobSetBytes: 0, coreGetBytes: 0, coreSetBytes: 0, catalogReads: 0, catalogProjections: 0,
    modelPlan: 0, modelCpuMs: 0, simulatedMs: 0, cpuWallMs: 0 };
  function bump(key, amount = 1) { metrics()[key] += amount; }
  function cost(key) { metrics().simulatedMs += assumptions[key]; }
  function auditModel(scope) {
    const model = scope.TidyTitleDates;
    scope.TidyTitleDates = Object.freeze({ ...model, plan(...args) {
      bump("modelPlan"); const start = performance.now();
      try { return model.plan(...args); } finally { bump("modelCpuMs", performance.now() - start); }
    } });
  }
  auditModel(h.worker);
  function cacheCheckpoint() {
    const values = [...(h.worker.__auditTitlePreviewContexts?.values() || [])];
    previewCacheAfterStage[stage] = { entries: values.length, batchEntries: values.filter(value => value.batchScopeId).length,
      serializedJSONBytes: bytes(values) };
  }
  const adapter = h.main;
  adapter.fetch = async (url, init = {}) => {
    let body;
    if (url === "/api/auth/session") {
      bump("session"); cost("sessionMs"); trace.push(`${stage}:${operation}:session`);
      body = { accessToken: "synthetic-not-a-real-token", user: { id: "user-1" }, activeAccountId: "catalog-user-1" };
    } else if (init.method === "POST") {
      const id = decodeURIComponent(url.match(/\/id\/([^/]+)\/rename$/)?.[1] || "");
      const row = targets.get(id); assert.ok(row, "POST is restricted to a synthetic selected target");
      const title = JSON.parse(init.body).title;
      assert.equal(title, confirmedTitles.get(id), "the POST must exactly match the confirmed title");
      row.title = title; row.updatedAt = "2026-09-10T00:00:00.000Z";
      bump("post"); cost("postMs"); trace.push(`${stage}:POST`); body = {};
    } else {
      const id = decodeURIComponent(url.match(/\/conversations\/([^?]+)/)?.[1] || "");
      const row = targets.get(id); assert.ok(row, "metadata is restricted to synthetic targets");
      bump("metadata"); cost("metadataMs");
      if (operation === "write") bump(++writeMetadata === 1 ? "preflight" : "readback");
      trace.push(`${stage}:${operation}:metadata`);
      body = { conversation_id: id, title: row.title, create_time: Date.parse(row.createdAt) / 1000,
        update_time: (Date.parse(row.updatedAt) + detailTimeOffsetMs) / 1000,
        ...(row.projectId ? { gizmo_type: "snorlax", gizmo_id: row.projectId } : {}) };
    }
    return { ok: true, status: 200, json: async () => plain(body) };
  };
  // MAIN has its own genuine model/formatter instance; never share the
  // worker object, which would hide cross-realm formatting disagreements.
  auditModel(adapter);
  h.main.titleAdapter = {
    async readCurrent(payload) { operation = payload.identityOnly ? "identity" : "read"; bump(payload.identityOnly ? "adapterIdentity" : "adapterFullRead"); return adapter.TidyChatgptTitles.readCurrent(payload); },
    async writeCurrent(payload) { operation = "write"; writeMetadata = 0; bump("adapterWrite"); return adapter.TidyChatgptTitles.writeCurrent(payload); },
    async beginBatchExecution(payload) { operation = "batch-begin"; return adapter.TidyChatgptTitles.beginBatchExecution(payload); },
    async endBatchExecution(payload) { operation = "batch-end"; return adapter.TidyChatgptTitles.endBatchExecution(payload); },
  };
  const getTab = h.worker.chrome.tabs.get, send = h.worker.chrome.tabs.sendMessage;
  h.worker.chrome.tabs.get = async (...args) => { bump("tabGet"); return getTab(...args); };
  h.worker.chrome.tabs.sendMessage = async (tabId, envelope, target) => {
    bump("bridge"); cost("chromeBridgeMs");
    if (envelope.type === "page-session.probe") bump("pageProbes");
    if (envelope.type === "snapshot.get") bump("snapshots");
    return send(tabId, envelope, target);
  };
  const repository = h.operationRepository, get = repository.get, set = repository.set, remove = repository.remove;
  repository.get = async (key) => {
    const value = await get(key), size = bytes(value);
    bump("operationGets"); bump("readBytes", size); cost("durableOperationMs");
    bump(key.startsWith("title-batch.") ? "jobGetBytes" : "coreGetBytes", size); return value;
  };
  repository.set = async (key, value) => {
    const size = bytes(value); bump("operationSets"); bump("writtenBytes", size); cost("durableOperationMs");
    bump(key.startsWith("title-batch.") ? "jobSetBytes" : "coreSetBytes", size); return set(key, value);
  };
  repository.remove = async (keys) => {
    bump("operationRemoves"); cost("durableOperationMs"); return remove(keys);
  };
  const catalog = h.catalogRepository, catalogRead = catalog.getSnapshot,
    observe = catalog.observeTitles, accept = catalog.acceptTitles;
  catalog.getSnapshot = async (...args) => { bump("catalogReads"); return catalogRead(...args); };
  catalog.observeTitles = async (...args) => { bump("catalogProjections"); return observe(...args); };
  catalog.acceptTitles = async (...args) => { bump("catalogProjections"); return accept(...args); };
  async function request(type, payload) {
    bump("panelRequests"); const start = performance.now();
    const response = await h.request(type, payload); metrics().cpuWallMs += performance.now() - start;
    assert.equal(response.ok, true, JSON.stringify(response.error)); bump("publicBytes", bytes(response.payload)); return response.payload;
  }
  let state = await request("TITLE_BATCH_PREVIEW", { conversationIds: rows.map((row) => row.conversationId), accountKey: "catalog-user-1",
    operation: "assign", rules: { mode, dateFormat: "iso", timeZone: "UTC", locale } });
  cacheCheckpoint();
  assert.equal(state.counts.ready, n);
  stage = "replan";
  state = await request("TITLE_BATCH_REPLAN", { batchId: state.batchId, rules: { ...state.rules, dateFormat } });
  confirmedTitles = new Map(state.items.map(item => [item.conversationId, item.plan.after]));
  cacheCheckpoint();
  stage = "apply"; state = await request("TITLE_BATCH_APPLY", { batchId: state.batchId });
  cacheCheckpoint();
  stage = "step";
  while (state.phase === "applying") state = await request("TITLE_BATCH_STEP", { batchId: state.batchId, stepId: state.nextStepId });
  assert.equal(state.counts.accepted, n, JSON.stringify({ state, stages, trace, calls: h.calls }));
  cacheCheckpoint();
  assertBudgets(stages, n);
  for (const [name, cache] of Object.entries(previewCacheAfterStage)) assert.equal(cache.entries, 0, `${name}: batch never creates unused editor contexts`);
  const sumStages = (entries) => Object.fromEntries(Object.keys(metrics()).map((key) => [key, entries.reduce((sum, value) => sum + value[key], 0)]));
  const total = sumStages(Object.values(stages));
  // Replan is optional: its page handshake does not read adapter data or issue HTTP.
  // This subtotal shows just local selection/preview -> confirm -> N writes.
  const pipelineWithoutOptionalReplan = sumStages(Object.entries(stages).filter(([name]) => name !== "replan").map(([, value]) => value));
  for (const value of [...Object.values(stages), total, pipelineWithoutOptionalReplan]) {
    value.cpuWallMs = +value.cpuWallMs.toFixed(3); value.simulatedMs = +value.simulatedMs.toFixed(3);
    value.modelCpuMs = +value.modelCpuMs.toFixed(3);
  }
  return { n, stages, total, pipelineWithoutOptionalReplan, previewCacheAfterStage, retainedOperationRecords: h.records.size, retainedJSONBytes: [...h.records.values()].reduce((sum, value) => sum + bytes(value), 0),
    ...(n === 1 ? { serialHttpTrace: trace } : {}) };
}

if (require.main === module) (async () => {
  const sizes = process.argv.slice(2).map(Number);
  const results = [];
  for (const n of sizes.length ? sizes : [1, 10, 100]) {
    assert.ok(Number.isInteger(n) && n > 0); results.push(await measure(n));
  }
  console.log(JSON.stringify({ source: "Real worker/core/batch/adapter, synthetic fetch and in-memory durable repository",
    disclaimer: "Measured call counts/JSON bytes; CPU wall includes instrumentation. JSON byte volume is serialization traffic, not physical disk IO or actual heap size. Simulated delays are additive assumptions, not live timings. Initial directory scan, UI rendering, IndexedDB engine and real-page React/DOM costs are excluded; production snapshot readers run against a small synthetic DOM. Catalog repository IO is counted only at getSnapshot/observeTitles, not its internal transactions or bytes. Total includes one optional local replan; the pipeline subtotal excludes it.",
    assertedFormulas: { session: "N + 1", metadata: "N", preflight: "N", readback: "0 on clear 2xx", post: "N", snapshots: "N + 2", pageProbes: "N + 3", bridge: "3N + 7", tabGet: "3N + 8", panelRequests: "N + 3", operationGets: "5N + 5", operationSets: "6N + 5", operationRemoves: "1", modelPlan: "3N", editorPreviewContexts: "0" },
    assumptions, results }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { measure };
