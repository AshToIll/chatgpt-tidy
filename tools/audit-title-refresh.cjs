const { installRulesRuntime } = require("../tests/helpers/title-rules.cjs");
/* Offline F5 boundary audit. No Chrome, real account or network is accessed.
 * Production view/catalog/services/adapters run against fake IndexedDB + fetch.
 * Chrome transport and native page hydration are explicit fixture inputs, not
 * a recording of the user's F5. In particular, these counts are NOT a live bill.
 * Run: node tools/audit-title-refresh.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");
const { snapshotHarness } = require("../tests/helpers/adapter-snapshot.cjs");
const { installPageSession } = require("../tests/helpers/page-session.cjs");
const ROOT = path.resolve(__dirname, "..");
const NOW = Date.parse("2026-09-11T00:00:00.000Z");
const ACCOUNT = "synthetic-catalog-account";
const plain = value => value == null ? value : JSON.parse(JSON.stringify(value));
const flush = () => new Promise(setImmediate);

async function auditScenario({ name, count = 679, seed = "fresh", accountStatus = 200,
  firstPageStatus = 200, bindingEvents = false } = {}) {
  const requests = [], ui = [], publications = [], catalogActions = [], timers = new Set();
  let authReads = 0, directoryReads = 0, sequence = 0, catalog, view, database, entryRead = null;
  let dbReads = 0, stateWrites = 0, pageWrites = 0;
  class AuditDate extends Date { static now() { return NOW; } }
  const nativeRows = Array.from({ length: count }, (_, i) => ({ id: `synthetic-${i}`,
    title: `Synthetic chat ${i}`, create_time: 1785542400, update_time: 1788220800 }));
  const context = vm.createContext({ URL, URLSearchParams, Headers, AbortController, IDBKeyRange,
    Intl, Date: AuditDate, structuredClone, console, setTimeout, clearTimeout,
    auditTitleEntry: promise => { entryRead = promise; },
    navigator: { language: "zh-CN" }, document: { hidden: false, cookie: "" },
    location: { href: "https://chatgpt.com/c/owner", origin: "https://chatgpt.com" },
    crypto: { randomUUID: () => `audit-${++sequence}` },
    chrome: { storage: { local: { get: async () => ({}), set: async () => {} } } },
    fetch: async (input, init = {}) => {
      const url = new URL(input, "https://chatgpt.com");
      assert.notEqual(init.method, "POST", "this audit must never perform even a synthetic write");
      let body, status = 200, kind;
      if (url.pathname === "/api/auth/session") {
        kind = "identity";
        authReads++;
        status = accountStatus;
        body = { user: { id: "synthetic-user" }, activeAccountId: ACCOUNT, accessToken: "not-a-real-token" };
      } else {
        kind = "directory"; status = ++directoryReads === 1 ? firstPageStatus : 200;
        if (url.pathname === "/backend-api/conversations") {
          const rows = url.searchParams.get("is_archived") === "true" ? [] : nativeRows;
          const offset = Number(url.searchParams.get("offset")), limit = Number(url.searchParams.get("limit"));
          body = { items: rows.slice(offset, offset + limit), total: rows.length };
        } else if (url.pathname === "/backend-api/pins") body = [];
        else if (url.pathname === "/backend-api/gizmos/snorlax/sidebar") body = { items: [], total: 0 };
        else throw new Error(`Unexpected offline request: ${url.pathname}`);
      }
      requests.push({ sequence: requests.length + 1, kind, endpoint: url.pathname + url.search, status });
      return { ok: status >= 200 && status < 300, status, json: async () => plain(body) };
    },
  });
  function load(file, exports = [], instrument = value => value) {
    const source = instrument(fs.readFileSync(path.join(ROOT, file), "utf8")
      .replace(/^import[^\n]+\n/gm, "").replace(/^export /gm, "").replace(/^\{ storageError \};$/gm, ""));
    vm.runInContext(`(() => { ${source}\nObject.assign(globalThis, { ${exports.join(", ")} }); })();`, context, { filename: file });
  }
  installPageSession(context);
  load("src/messages/i18n.js", ["createTranslator"]);
  for (const file of ["src/platform/snapshot.js", "src/platform/catalog/date-search.js", "src/platform/time-format.js", "src/features/titles/model/title-dates.js"]) load(file);
  load("src/platform/navigation/conversation-route.js", ["parseConversationRoute", "canonicalConversationPath"]);
  load("src/features/titles/model/title-context.js", ["titleSnapshotContext"]);
  load("src/platform/storage/schema.js", ["STORAGE_BOUNDARIES"]);
  load("src/platform/storage/database.js", ["ensureTidyStores", "storageError", "openTidyDatabase", "assertAccountKey"]);
  load("src/platform/catalog/storage/conversation-catalog.js", ["createConversationCatalogRepository"]);
  for (const file of ["src/platform/chatgpt/api.js", "src/platform/chatgpt/route.js", "src/platform/chatgpt/messages.js", "src/platform/catalog/chatgpt/date-index.js", "src/features/titles/chatgpt/titles.js"]) load(file);
  load("src/platform/catalog/ui/conversation-catalog-reader.js", ["createConversationCatalogReader"]);
  load("src/features/titles/ui/title-catalog.js", ["createTitleCatalog"], source => {
    const marker = "return Object.freeze({ load, pause, changed });";
    assert.ok(source.includes(marker), "catalog idle-inspection seam changed");
    return source.replace(marker, "return Object.freeze({ load, pause, changed, auditIdle: () => refreshing?.promise || loader.whenIdle() });");
  });
  load("src/platform/ui/loading-flower.js", ["loadingFlowerMarkup"]);
  installRulesRuntime(context, { conversationTimeMode: "range", dateFormat: "iso" });
  load("src/features/titles/background/title-service.js", ["createTitleService", "TITLE_PLAN_TTL_MS"]);
  load("src/features/titles/background/title-batch-service.js", ["createTitleBatchService"]);
  load("src/features/titles/ui/title-batch-view.js", ["createTitleBatchView"], source => {
    const marker = "return Object.freeze({ update, canLeave:";
    assert.ok(source.includes(marker), "state-inspection seam changed");
    // 只在审计夹具捕获实际进入流程的 Promise，生产状态不保存测试专用字段。
    const entryMarker = "void enter();";
    assert.equal(source.split(entryMarker).length, 2, "entry-inspection seam changed");
    return source.replace(marker, "return Object.freeze({ update, state, canLeave:")
      .replace(entryMarker, "auditTitleEntry(enter());");
  });
  database = await context.openTidyDatabase(new IDBFactory());
  const repository = context.createConversationCatalogRepository({ openDatabase: async () => database, now: () => NOW });
  if (seed !== "none") {
    const completedAt = NOW - (seed === "expired" ? 300001 : 60000);
    const state = { catalogVersion: 2, generation: 1, revision: 30, pages: 28, phase: "settled",
      pauseReason: null, snapshotStartedAt: completedAt - 10000, lastObservedAt: completedAt, completedAt,
      sources: Object.fromEntries(["ordinary", "archived", "pins", "projects"].map(source => [source,
        { source, projectId: null, cursor: null, done: true, seenCursors: [], signatures: [], error: null, coverageReasons: [],
          mode: "full", boundaryIds: [], headIds: source === "ordinary"
            ? nativeRows.slice(0, 28).map((row) => `conversation:${row.id}`) : [] }])) };
    if (seed === "rate-limited") {
      state.phase = "paused"; state.pauseReason = "rate-limited"; state.completedAt = null;
      Object.assign(state.sources.ordinary, { done: false,
        error: { code: "HTTP", category: "HTTP", status: 429, retryable: true } });
    }
    await repository.commitPage(ACCOUNT, { conversations: nativeRows.map(row => ({ conversationId: row.id, title: row.title,
      updatedAt: row.update_time * 1000, directoryBounds: { createdAt: row.create_time * 1000 } })) }, state);
  }
  const observedRepository = {
    getSnapshot: (...args) => { dbReads++; return repository.getSnapshot(...args); },
    putState: (...args) => { stateWrites++; return repository.putState(...args); },
    commitPage: (...args) => { pageWrites++; return repository.commitPage(...args); },
  };
  const records = new Map(), storage = {
    get: async key => plain(records.get(key)), set: async (key, value) => { records.set(key, plain(value)); },
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) records.delete(key); },
  };
  const noWrite = () => { throw new Error("F5 audit forbids writes"); };
  const titleService = context.createTitleService({ storage, read: (owner, options) => context.TidyChatgptTitles.readCurrent({ ...owner, ...options }), write: noWrite });
const batch = context.createTitleBatchService({ titleService, storage,
  beginExecution: async () => ({ identity, catalogAccountKey: "catalog-account" }), endExecution: async () => ({ ended: true }),
    resolveSelection: noWrite });
  catalog = context.createTitleCatalog({ repository: observedRepository, now: () => NOW,
    requestAdapter: (action, payload) => {
      catalogActions.push({ action, ...plain(payload) });
      return action === "account" ? context.TidyChatgptDateIndex.account() : context.TidyChatgptDateIndex.readSourcePage(payload);
    },
    schedule(callback, delay) {
      const timer = { callback, delay }; timers.add(timer);
      if (delay === 0) queueMicrotask(() => { if (timers.delete(timer)) callback(); });
      return timer;
    }, cancelSchedule: timer => timers.delete(timer),
  });
  let html = "";
  const root = { addEventListener() {}, removeEventListener() {}, setAttribute() {},
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value;
      const observation = { rows: (value.match(/data-batch-select=/g) || []).length,
        signInChanged: value.includes("账号或工作区状态不一致"), emptyResult: value.includes("当前结果没有会话"),
        authPending: value.includes("暂时无法确认登录"), catalogUnconfirmed: value.includes("会话目录尚未确认"),
        rateLimited: value.includes('data-catalog-issue="rate"'),
        previousRateLimit: value.includes('data-catalog-issue="rate"') && value.includes('data-catalog-origin="previous"'),
        currentRateLimit: value.includes('data-catalog-issue="rate"') && value.includes('data-catalog-origin="current"'), busy: value.includes('aria-busy="true"') };
      if (JSON.stringify(ui.at(-1)) !== JSON.stringify(observation)) ui.push(observation);
    },
  };
  const owner = { tabId: 7, conversationId: "owner", pathname: "/c/owner", projectId: null };
  const actions = [];
  view = context.createTitleBatchView({ root, ownerTabId: owner.tabId,
    request: async (action, payload) => {
      assert.equal(action, "batch-status", "reload must not start preview/apply/step"); actions.push(action);
      try { return await batch.handle("status", owner, payload); }
      catch (error) { throw Object.assign(new Error(error.message), { code: error.tidyCode || error.code }); }
    },
    loadCatalog: options => catalog.load({ ...options, onUpdate: value => {
      publications.push({ rows: value.rows.length, generation: value.generation, phase: value.phase,
        loading: value.loading, pauseReason: value.pauseReason, errorOrigin: value.errorOrigin, statuses: value.readErrors.map(error => error.status) });
      options.onUpdate(value);
    } }),
  });
  const snapshot = snapshotHarness({ url: "https://chatgpt.com/c/owner", sidebar: [{ href: "/c/owner", title: "Owner",
    record: { id: "owner", title: "Owner", create_time: 1785542400, update_time: 1788220800 } }] });
  const update = value => view.update({ snapshot: value, preferences: { timeZone: "UTC", language: "zh-CN" }, active: true,
    t: context.createTranslator("zh-CN") });
  async function settle() {
    await entryRead;
    // Await the actual catalog queue, not an early cached "paused" publication.
    // Otherwise a cold scan could be counted before its first page commits.
    await catalog.auditIdle(); await flush();
    assert.equal(Boolean(view.state.busy || view.state.loading), false, `offline ${name} did not settle`);
  }
  try {
    // Route-only/bound page events are not authentication evidence and must
    // not become a hidden account retry loop after the one F5 lookup fails.
    update(null); update(snapshot); await settle();
    if (bindingEvents) {
      const pending = plain(snapshot); pending.conversation.bindingStatus = "route-only";
      update(pending); update(snapshot); await settle();
    }
    const cached = await repository.getSnapshot(ACCOUNT);
    return { name, fixture: { count, seed, accountStatus, firstPageStatus, bindingEvents },
      calls: { identity: authReads, directory: directoryReads, detail: 0, write: 0, other: 0 },
      statusActions: actions.length, catalogAccountActions: catalogActions.filter(value => value.action === "account").length,
      db: { reads: dbReads, stateWrites, pageWrites, retainedRows: cached.rows.length, generation: cached.state?.generation ?? null },
      first429: requests.find(value => value.status === 429) || null,
      requests, publications, ui, finalError: view.state.error, finalCatalogIssue: view.state.catalogIssue };
  } finally { view.dispose(); await catalog.pause(); database.close(); }
}

const SCENARIOS = [
  { name: "fresh-persisted-directory", seed: "fresh" },
  { name: "expired-persisted-directory", seed: "expired" },
  { name: "empty-persistent-directory", seed: "none" },
  { name: "persisted-429-no-new-429", seed: "rate-limited" },
  { name: "catalog-auth-429-preserves-status", seed: "fresh", accountStatus: 429 },
  { name: "expired-first-page-429", seed: "expired", firstPageStatus: 429 },
  { name: "auth-unavailable-no-passive-retry", seed: "fresh", accountStatus: 503, bindingEvents: true },
  { name: "auth-unavailable-does-not-borrow-persisted-429", seed: "rate-limited", accountStatus: 503, bindingEvents: true },
];
if (require.main === module) (async () => {
  const results = [];
  for (const scenario of SCENARIOS) results.push(await auditScenario(scenario));
  console.log(JSON.stringify({ evidence: "OFFLINE: production title view/catalog/services/adapters; synthetic fetch, DOM, owner binding and fake IndexedDB. No Chrome transport, native hydration or live network.", results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { auditScenario, SCENARIOS };
