const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");

globalThis.IDBKeyRange = IDBKeyRange;
const ACCOUNT = '["version-test-user","workspace"]';
const VERSION = "tidy.date-search.v1";
const source = name => ({ source: name, projectId: null, cursor: null, done: false,
  seenCursors: [], signatures: [], error: null, coverageReasons: [], mode: "full", boundaryIds: [], headIds: [] });
const checkpoint = (overrides = {}) => ({ catalogVersion: 2, generation: 8, revision: 72, pages: 0,
  phase: "paused", pauseReason: null, snapshotStartedAt: 1000, lastObservedAt: null, completedAt: null,
  sources: Object.fromEntries(["ordinary", "archived", "pins", "projects"].map(name => [name, source(name)])),
  projectHeadHints: {}, ...overrides });
const emptyPage = name => ({ schemaVersion: VERSION, source: name, conversations: [], projects: [],
  nextCursor: null, done: true, coverageReasons: [] });
const result = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
const done = tx => new Promise((resolve, reject) => {
  tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error || Error("Aborted"));
});

async function harness(t) {
  const { openTidyDatabase } = await import("../src/platform/storage/database.js");
  const { createConversationCatalogRepository } = await import("../src/platform/catalog/storage/conversation-catalog.js");
  const db = await openTidyDatabase(new IDBFactory());
  const repository = createConversationCatalogRepository({ openDatabase: async () => db });
  // Raw injection simulates corrupt/unknown records. No runtime conversion API exists.
  async function rawState(state) {
    const tx = db.transaction("module-state", "readwrite"), finished = done(tx);
    tx.objectStore("module-state").put({ ...structuredClone(state), key: `conversation-catalog:${ACCOUNT}`, accountKey: ACCOUNT });
    await finished;
  }
  async function rawSnapshot() {
    const tx = db.transaction(["module-state", "conversation-index"]), finished = done(tx);
    const values = await Promise.all([result(tx.objectStore("module-state").getAll()), result(tx.objectStore("conversation-index").getAll())]);
    await finished; return values;
  }
  await repository.commitPage(ACCOUNT, { conversations: [{ conversationId: "retained", title: "Current title", updatedAt: 200 }] }, checkpoint());
  const calls = [], updates = [], timers = new Map(), hooks = {};
  const wrapped = {
    async getSnapshot(account) { await hooks.beforeRead?.(); return repository.getSnapshot(account); },
    async putState(account, state) { await hooks.beforeWrite?.(); return repository.putState(account, state); },
    commitPage: (...args) => repository.commitPage(...args),
  };
  const context = vm.createContext({ Intl, structuredClone, document: { hidden: false } });
  vm.runInContext(fs.readFileSync("src/platform/catalog/date-search.js", "utf8"), context);
  for (const [file, name] of [["conversation-catalog-reader", "createConversationCatalogReader"], ["title-catalog", "createTitleCatalog"]]) {
    const code = fs.readFileSync(file === "title-catalog" ? "src/features/titles/ui/title-catalog.js" : "src/platform/catalog/ui/conversation-catalog-reader.js", "utf8").replace(/^import[^\n]+\n/gm, "").replace(/^export /gm, "");
    vm.runInContext(`(() => { ${code}; globalThis.${name} = ${name}; })()`, context);
  }
  const requestAdapter = async (action, payload) => {
    if (action === "account") return { schemaVersion: VERSION, accountKey: ACCOUNT };
    assert.equal(action, "source-page"); calls.push(structuredClone(payload));
    return hooks.sourcePage ? hooks.sourcePage(payload) : emptyPage(payload.source);
  };
  const reader = context.createConversationCatalogReader({ repository: wrapped, requestAdapter, now: () => 1000,
    onStatus: (status, snapshot) => updates.push(structuredClone({ status, snapshot })) });
  let timerId = 0;
  const title = context.createTitleCatalog({ repository: wrapped, requestAdapter, now: () => 1000,
    schedule(callback) { timers.set(++timerId, callback); return timerId; }, cancelSchedule(id) { timers.delete(id); } });
  t.after(async () => { await title.pause(); await reader.pause(); db.close(); });
  return { db, repository, reader, title, rawState, rawSnapshot, calls, updates, hooks, timers };
}

const invalidVersions = [1, 0, -1, 3, 99, null, undefined, "2", true, NaN, Infinity, {}, []];
for (const [index, version] of invalidVersions.entries()) test(`catalog version rejection ${index + 1}: ${String(version)}`, async t => {
  const h = await harness(t);
  await h.rawState(checkpoint({ catalogVersion: version }));
  const before = await h.rawSnapshot();
  const rejectsVersion = error => error.code === "CATALOG_VERSION_UNSUPPORTED" && error.category === "SCHEMA"
    && error.retryable === false && error.expectedCatalogVersion === 2
    && error.observedCatalogVersion === (typeof version === "number" && Number.isFinite(version) ? version : null);
  for (const refresh of [false, true]) await assert.rejects(h.reader.read({ sessionId: "invalid", refresh }), rejectsVersion);
  await assert.rejects(h.reader.refreshCatalog(), rejectsVersion);
  await assert.rejects(h.repository.putState(ACCOUNT, checkpoint({ generation: 99, revision: 999 })), rejectsVersion);
  await assert.rejects(h.repository.commitPage(ACCOUNT, { conversations: [{ conversationId: "must-not-write", title: "Rejected" }] }, checkpoint()), rejectsVersion);
  assert.deepEqual(await h.rawSnapshot(), before); assert.equal(h.calls.length, 0); assert.equal(h.updates.length, 0);

  // Invalid incoming writes are rejected even when storage itself has a valid owner.
  await h.rawState(checkpoint()); const current = await h.rawSnapshot();
  await assert.rejects(h.repository.putState(ACCOUNT, checkpoint({ catalogVersion: version })), rejectsVersion);
  assert.deepEqual(await h.rawSnapshot(), current);
});

test("Titles rejects an unknown checkpoint without publishing cached rows or scheduling refreshes", async t => {
  const h = await harness(t); await h.rawState(checkpoint({ catalogVersion: 3 }));
  const before = await h.rawSnapshot(), updates = [];
  await assert.rejects(h.title.load({ onUpdate: value => updates.push(structuredClone(value)) }),
    error => error.code === "CATALOG_VERSION_UNSUPPORTED" && error.stage === "cache-read");
  assert.equal(updates.length, 0);
  assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0); assert.deepEqual(await h.rawSnapshot(), before);
});

test("future versions appearing at the start read or explicit refresh cannot be downgraded", async t => {
  const h = await harness(t); let reads = 0;
  h.hooks.beforeRead = async () => { if (++reads === 2) await h.rawState(checkpoint({ catalogVersion: 3 })); };
  await h.reader.read({ sessionId: "start-future" }); await h.reader.whenIdle();
  assert.equal(h.reader.status().readErrors[0].code, "CATALOG_VERSION_UNSUPPORTED");
  assert.equal(h.reader.status().readErrors[0].stage, "cache-read");
  const before = await h.rawSnapshot();
  await assert.rejects(h.reader.refreshCatalog(), error => error.code === "CATALOG_VERSION_UNSUPPORTED");
  assert.equal(h.calls.length, 0); assert.deepEqual(await h.rawSnapshot(), before);
});

test("future version racing a page commit stops before writing rows or issuing another source GET", async t => {
  const h = await harness(t); let before;
  h.hooks.sourcePage = async payload => {
    await h.rawState(checkpoint({ catalogVersion: 3 })); before = await h.rawSnapshot();
    return { ...emptyPage(payload.source), conversations: [{ conversationId: "new", title: "Must not commit", projectId: null,
      updatedAt: 200, directoryBounds: { createdAt: 100, updatedAt: 200, sources: [payload.source] } }] };
  };
  await h.reader.read({ sessionId: "commit-future" }); await h.reader.whenIdle();
  assert.equal(h.reader.status().readErrors[0].code, "CATALOG_VERSION_UNSUPPORTED");
  assert.equal(h.reader.status().readErrors[0].stage, "page-commit");
  assert.equal(h.calls.length, 1); assert.deepEqual(await h.rawSnapshot(), before);
});

test("future version racing an explicit reset is rechecked inside the write transaction", async t => {
  const h = await harness(t), settled = checkpoint({ phase: "settled", completedAt: 999 });
  for (const source of Object.values(settled.sources)) source.done = true;
  await h.rawState(settled); await h.reader.read({ sessionId: "reset-future" });
  let before;
  h.hooks.beforeWrite = async () => { await h.rawState(checkpoint({ catalogVersion: 3 })); before = await h.rawSnapshot(); };
  await assert.rejects(h.reader.refreshCatalog(), error => error.code === "CATALOG_VERSION_UNSUPPORTED" && error.stage === "refresh-reset");
  assert.equal(h.calls.length, 0); assert.deepEqual(await h.rawSnapshot(), before);
});

test("current checkpoint still scans, caches and explicitly refreshes without a conversion API", async t => {
  const h = await harness(t);
  assert.deepEqual(Object.keys(h.repository).sort(), ["acceptTitleChange", "acceptTitles", "commitPage", "getRow", "getSnapshot", "observeTitles", "putState"]);
  await h.reader.read({ sessionId: "current" }); await h.reader.whenIdle();
  assert.equal(h.calls.length, 4); assert.equal(h.reader.status().phase, "settled");
  const first = await h.repository.getSnapshot(ACCOUNT);
  await h.reader.read({ sessionId: "cached" }); await h.reader.whenIdle();
  assert.equal(h.calls.length, 4); assert.deepEqual(await h.repository.getSnapshot(ACCOUNT), first);
  await h.reader.refreshCatalog();
  assert.equal(h.calls.length, 8); assert.equal(h.reader.status().phase, "settled");
  assert.equal((await h.repository.getSnapshot(ACCOUNT)).state.generation, first.state.generation + 1);
});

test("current checkpoint counters cannot overflow or be coerced during explicit refresh", async t => {
  const h = await harness(t), settled = checkpoint({ phase: "settled", completedAt: 999 });
  for (const source of Object.values(settled.sources)) source.done = true;
  await h.rawState(settled); await h.reader.read({ sessionId: "counter" });
  for (const key of ["generation", "revision"]) for (const value of ["7", -1, null, Number.MAX_SAFE_INTEGER]) {
    await h.rawState(checkpoint({ [key]: value })); const before = await h.rawSnapshot();
    await assert.rejects(h.reader.refreshCatalog(), error => error.code === "SCHEMA" && error.stage === "refresh-reset");
    assert.deepEqual(await h.rawSnapshot(), before);
  }
  assert.equal(h.calls.length, 0);
});
