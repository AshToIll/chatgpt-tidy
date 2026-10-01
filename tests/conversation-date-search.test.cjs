const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");

const root = path.resolve(__dirname, "..");
const ACCOUNT = "catalog-account";
const TIME = Date.parse("2026-09-07T12:00:00Z");
const NOW = Date.parse("2026-09-08T12:00:00Z");
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise(setImmediate); };
const criteria = (overrides = {}) => ({ startMs: TIME, endMs: TIME + 100,
  dateField: "createdAt", direction: "desc", limit: 8, sessionId: "catalog-query", ...overrides });
const candidate = (id, createdAt, updatedAt) => ({ conversationId: id, title: `Title ${id}`, updatedAt,
  directoryBounds: { createdAt, updatedAt, sources: ["ordinary"] } });
const page = (source, conversations = [], overrides = {}) => ({ schemaVersion: "tidy.date-search.v1", source,
  conversations, projects: [], nextCursor: null, done: true, coverageReasons: [], ...overrides });

function loadModule(context, file, names) {
  const source = fs.readFileSync(path.join(root, file), "utf8")
    .replace(/^import .*$/gm, "").replace(/^export \{.*\};?$/gm, "").replace(/^export /gm, "");
  vm.runInContext(`(() => { ${source}\n${names.map((name) => `globalThis.${name} = ${name};`).join("\n")} })();`,
    context, { filename: file });
}

async function setup(t, dispatch = async (request) => page(request.source)) {
  const indexedDB = new IDBFactory();
  const context = vm.createContext({ console, indexedDB, IDBKeyRange, structuredClone });
  vm.runInContext(fs.readFileSync(path.join(root, "src/platform/catalog/date-search.js"), "utf8"), context);
  loadModule(context, "src/platform/storage/schema.js", ["STORAGE_BOUNDARIES"]);
  loadModule(context, "src/platform/storage/database.js", ["openTidyDatabase", "storageError", "assertAccountKey"]);
  loadModule(context, "src/platform/catalog/storage/conversation-catalog.js", ["createConversationCatalogRepository"]);
  loadModule(context, "src/platform/catalog/ui/conversation-catalog-reader.js", ["createConversationCatalogReader"]);
  loadModule(context, "src/features/search/ui/conversation-date-search.js", ["createConversationDateSearch"]);
  const db = await context.openTidyDatabase(indexedDB);
  t.after(() => db.close());
  const stores = context.STORAGE_BOUNDARIES.indexedDb.stores;
  const repository = context.createConversationCatalogRepository({ openDatabase: async () => db, now: () => TIME });
  const requests = [], statuses = [];
  let visible = true;
  let account = ACCOUNT;
  const makeService = () => context.createConversationDateSearch({ repository, now: () => NOW, canDispatch: () => visible,
    onStatus: (value) => statuses.push(plain(value)), requestAdapter: async (action, request) => {
      requests.push({ action, request: plain(request) });
      if (action === "account") return { schemaVersion: "tidy.date-search.v1", accountKey: account };
      assert.equal(action, "source-page", "catalog search cannot request conversation messages");
      return dispatch(request);
    } });
  return { db, stores, repository, service: makeService(), makeService, requests, statuses,
    makeRepository: () => context.createConversationCatalogRepository({ openDatabase: async () => db, now: () => TIME }),
    setVisible: (value) => { visible = value; }, setAccount: (value) => { account = value; } };
}

async function seed(db, store, values) {
  const transaction = db.transaction(store, "readwrite");
  for (const value of values) {
    // Project adapter candidates into the current storage DTO for this fixture.
    const row = store === "conversation-index" && !Object.hasOwn(value, "catalogMetadata")
      ? { accountKey: value.accountKey, conversationId: value.conversationId, catalogMetadata: {
        title: value.title || "", projectId: value.projectId || null,
        createdAt: value.directoryBounds?.createdAt ?? null,
        updatedAt: value.directoryBounds?.updatedAt ?? null,
      } } : value;
    transaction.objectStore(store).put(row);
  }
  await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = reject; });
}

async function stored(db, store, key) {
  const transaction = db.transaction(store, "readonly");
  const request = transaction.objectStore(store).get(key);
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = reject; });
}

test("catalog searches the selected metadata field only with stable conversation pagination and missing-date coverage", async (t) => {
  const { db, stores, service, requests } = await setup(t);
  const values = [candidate("a", TIME + 20, TIME + 400), candidate("b", TIME - 50, TIME + 30),
    candidate("c", TIME + 20, TIME + 40), candidate("end", TIME + 100, TIME + 100), candidate("missing", null, TIME + 50)];
  await seed(db, stores.conversationIndex, values.map((value) => ({ ...value, accountKey: ACCOUNT })));
  const first = await service.queryDate(criteria({ refresh: true, limit: 1 }));
  assert.deepEqual(Array.from(first.items, (item) => item.conversationId), ["a"]);
  assert.equal(first.total, 2, "total counts all filtered conversations, not just the loaded page or directory");
  assert.equal(first.items[0].messageId, null);
  assert.equal(first.items[0].matchKind, "conversation-date");
  assert.equal(first.items[0].conversationUpdatedAt, new Date(TIME + 400).toISOString());
  assert.equal(first.partialResults, true);
  assert.ok(first.coverageReasons.includes("catalog-createdAt-missing"));
  const second = await service.queryDate(criteria({ refresh: true, cursor: first.cursor, limit: 1 }));
  assert.deepEqual(Array.from(second.items, (item) => item.conversationId), ["c"]);
  assert.equal(second.hasMore, false);
  assert.equal(second.total, 2);
  const updated = await service.queryDate(criteria({ refresh: true, dateField: "updatedAt", direction: "asc" }));
  assert.deepEqual(Array.from(updated.items, (item) => item.conversationId), ["b", "c", "missing"]);
  assert.equal(updated.total, 3, "total follows the selected metadata field");
  const empty = await service.queryDate(criteria({ refresh: true, startMs: TIME + 200, endMs: TIME + 300 }));
  assert.equal(empty.total, 0);
  assert.equal(requests.filter((request) => request.action === "source-page").length, 0);
  await assert.rejects(service.queryDate(criteria({ refresh: true, dateField: "updatedAt", cursor: first.cursor })),
    (error) => error.code === "CURSOR_STALE");
});

test("verified title observations update only the exact existing account row and preserve catalog scope", async (t) => {
  const { db, stores, repository } = await setup(t);
  const metadata = { title: "Before", projectId: "g-p-project", createdAt: TIME, updatedAt: TIME,
    catalogGeneration: 8, observedAt: TIME };
  await seed(db, stores.conversationIndex, [
    { accountKey: ACCOUNT, conversationId: "project", catalogMetadata: metadata },
    { accountKey: "other-account", conversationId: "project", catalogMetadata: metadata },
  ]);
  await repository.observeTitles(ACCOUNT, [{ conversationId: "project", title: "After", createdAt: new Date(TIME).toISOString(),
    updatedAt: new Date(NOW).toISOString() }, { conversationId: "missing", title: "Do not invent", updatedAt: new Date(NOW).toISOString() }]);
  const row = await stored(db, stores.conversationIndex, [ACCOUNT, "project"]);
  assert.equal(row.catalogMetadata.title, "After");
  assert.equal(row.catalogMetadata.updatedAt, NOW);
  assert.equal(row.catalogMetadata.projectId, "g-p-project");
  assert.equal(row.catalogMetadata.catalogGeneration, 8);
  assert.equal((await stored(db, stores.conversationIndex, ["other-account", "project"])).catalogMetadata.title, "Before");
  assert.equal(await stored(db, stores.conversationIndex, [ACCOUNT, "missing"]), undefined);
  await repository.observeTitles(ACCOUNT, [{ conversationId: "project", title: "Stale", updatedAt: new Date(TIME).toISOString() }]);
  assert.equal((await stored(db, stores.conversationIndex, [ACCOUNT, "project"])).catalogMetadata.title, "After");
});

test("accepted title projection preserves observed timestamps until a genuinely newer scan corrects it", async (t) => {
  const { db, stores, repository } = await setup(t);
  await repository.commitPage(ACCOUNT, page("ordinary", [candidate("chat", TIME, TIME)]),
    { catalogVersion: 2, generation: 1, snapshotStartedAt: TIME - 100 });
  await repository.acceptTitles(ACCOUNT, [{ conversationId: "chat", title: "Accepted title" },
    { conversationId: "missing", title: "Do not invent" }]);
  let row = await stored(db, stores.conversationIndex, [ACCOUNT, "chat"]);
  assert.equal(row.catalogMetadata.title, "Accepted title"); assert.equal(row.catalogMetadata.updatedAt, TIME);
  assert.equal(row.catalogMetadata.titleReadbackAt, null); assert.equal(row.catalogMetadata.titleAcceptedAt, TIME);
  assert.equal(await stored(db, stores.conversationIndex, [ACCOUNT, "missing"]), undefined);
  await repository.commitPage(ACCOUNT, page("ordinary", [{ ...candidate("chat", TIME, TIME), title: "Late stale title" }]),
    { catalogVersion: 2, generation: 2, snapshotStartedAt: TIME - 1 });
  assert.equal((await repository.getSnapshot(ACCOUNT)).rows[0].title, "Accepted title");
  await repository.commitPage(ACCOUNT, page("ordinary", [{ ...candidate("chat", TIME, TIME), title: "Fresh server title" }]),
    { catalogVersion: 2, generation: 3, snapshotStartedAt: TIME + 1 });
  row = await stored(db, stores.conversationIndex, [ACCOUNT, "chat"]);
  assert.equal(row.catalogMetadata.title, "Fresh server title"); assert.equal(row.catalogMetadata.titleAcceptedAt, null);
});

test("late catalog pages cannot replace verified text with stale text at a newer timestamp", async (t) => {
  const { db, stores, repository } = await setup(t);
  const state = { catalogVersion: 2, generation: 8, snapshotStartedAt: TIME - 100 };
  await repository.commitPage(ACCOUNT, page("project", [{ ...candidate("chat", TIME, TIME),
    title: "Before", projectId: "g-p-project" }]), state);
  await repository.observeTitles(ACCOUNT, [{ conversationId: "chat", title: "Verified", updatedAt: new Date(NOW).toISOString() }]);
  for (const stamp of [TIME, NOW, null]) {
    await repository.commitPage(ACCOUNT, page("pins", [{ ...candidate("chat", TIME, stamp), title: "Before" }]), state);
    const row = (await stored(db, stores.conversationIndex, [ACCOUNT, "chat"])).catalogMetadata;
    assert.equal(row.title, "Verified"); assert.equal(row.updatedAt, NOW);
    assert.equal(row.projectId, "g-p-project");
  }
  await repository.commitPage(ACCOUNT, page("ordinary", [{ ...candidate("chat", TIME, TIME), title: "Old snapshot" }]),
    { catalogVersion: 2, generation: 9, snapshotStartedAt: TIME - 1 });
  let row = (await stored(db, stores.conversationIndex, [ACCOUNT, "chat"])).catalogMetadata;
  assert.equal(row.title, "Verified"); assert.equal(row.updatedAt, NOW);
  assert.equal(row.projectId, null, "new directory generations can clear old project membership independently");
  await repository.commitPage(ACCOUNT, page("ordinary", [{ ...candidate("chat", TIME, NOW + 1), title: "External rename" }]),
    { catalogVersion: 2, generation: 9, snapshotStartedAt: TIME + 1 });
  row = (await stored(db, stores.conversationIndex, [ACCOUNT, "chat"])).catalogMetadata;
  assert.equal(row.title, "External rename"); assert.equal(row.updatedAt, NOW + 1);
  assert.equal(row.titleReadbackAt, null);
});

test("fresh catalog generations can correct missing and equal-time metadata without permanent readback overlays", async (t) => {
  const { repository } = await setup(t);
  await repository.commitPage(ACCOUNT, page("ordinary", [candidate("chat", TIME, TIME)]), { catalogVersion: 2, generation: 1, snapshotStartedAt: TIME - 1 });
  await repository.observeTitles(ACCOUNT, [{ conversationId: "chat", title: "Verified", updatedAt: new Date(TIME).toISOString() }]);
  await repository.commitPage(ACCOUNT, page("ordinary", [{ ...candidate("chat", TIME, TIME), title: "Fresh equal timestamp" }]),
    { catalogVersion: 2, generation: 2, snapshotStartedAt: TIME + 1 });
  assert.equal((await repository.getSnapshot(ACCOUNT)).rows[0].title, "Fresh equal timestamp");
  await repository.commitPage(ACCOUNT, page("ordinary", [{ ...candidate("chat", null, null), title: "Metadata missing" }]),
    { catalogVersion: 2, generation: 3, snapshotStartedAt: TIME + 2 });
  const row = (await repository.getSnapshot(ACCOUNT)).rows[0];
  assert.equal(row.title, "Metadata missing"); assert.equal(row.createdAt, null); assert.equal(row.updatedAt, null);
});

test("a scan begun after verified readback can replace its projection even if the server corrects the update time backward", async (t) => {
  const { repository } = await setup(t);
  await repository.commitPage(ACCOUNT, page("ordinary", [candidate("chat", TIME, TIME)]), { catalogVersion: 2, generation: 1, snapshotStartedAt: TIME - 1 });
  await repository.observeTitles(ACCOUNT, [{ conversationId: "chat", title: "Verified", updatedAt: new Date(NOW).toISOString() }]);
  await repository.commitPage(ACCOUNT, page("ordinary", [{ ...candidate("chat", TIME, TIME), title: "Native corrected title" }]),
    { catalogVersion: 2, generation: 2, snapshotStartedAt: TIME + 1 });
  const row = (await repository.getSnapshot(ACCOUNT)).rows[0];
  assert.equal(row.title, "Native corrected title"); assert.equal(row.updatedAt, TIME);
});

test("separate catalog writers cannot roll back a newer generation or revision with a late page or checkpoint", async (t) => {
  const { repository, makeRepository } = await setup(t);
  const otherPanel = makeRepository();
  const state = { catalogVersion: 2, generation: 8, revision: 20, snapshotStartedAt: TIME };
  await repository.commitPage(ACCOUNT, page("ordinary", [{ ...candidate("chat", TIME, TIME), title: "Fresh" }]), state);
  const snapshot = plain(await repository.getSnapshot(ACCOUNT));
  for (const stale of [{ ...state, generation: 7, revision: 30 }, { ...state, revision: 19 }]) {
    await assert.rejects(otherPanel.commitPage(ACCOUNT, page("ordinary", [
      { ...candidate("chat", TIME, TIME + 1), title: "Late stale title" }, candidate("stale-insert", TIME, TIME),
    ]), stale), error => error.code === "CATALOG_SUPERSEDED");
    await assert.rejects(otherPanel.putState(ACCOUNT, stale), error => error.code === "CATALOG_SUPERSEDED");
    assert.deepEqual(plain(await repository.getSnapshot(ACCOUNT)), snapshot, "both rows and checkpoint remain unchanged");
  }
  await otherPanel.putState(ACCOUNT, { ...state, phase: "settled" });
  assert.equal((await repository.getSnapshot(ACCOUNT)).state.phase, "settled", "same-revision final phase is valid");
});

test("filter and sort timestamps are independent, missing sort times stay last, and cursors include sort identity", async (t) => {
  const { db, stores, service, requests } = await setup(t);
  const values = [candidate("a", TIME + 10, TIME + 90), candidate("b", TIME + 30, TIME + 20),
    candidate("c", TIME + 20, null), candidate("outside", TIME - 10, TIME + 40),
    candidate("no-created", null, TIME + 50)];
  await seed(db, stores.conversationIndex, values.map((value) => ({ ...value, accountKey: ACCOUNT })));
  for (const [dateField, sortField, direction, expected] of [
    ["createdAt", "updatedAt", "desc", ["a", "b", "c"]],
    ["createdAt", "updatedAt", "asc", ["b", "a", "c"]],
    ["updatedAt", "createdAt", "desc", ["b", "a", "outside", "no-created"]],
    ["updatedAt", "createdAt", "asc", ["outside", "a", "b", "no-created"]],
  ]) {
    const result = await service.queryDate(criteria({ refresh: true, dateField, sortField, direction }));
    assert.deepEqual(Array.from(result.items, row => row.conversationId), expected);
    assert.equal(result.total, expected.length);
  }
  const first = await service.queryDate(criteria({ refresh: true, sortField: "updatedAt", limit: 1 }));
  await assert.rejects(service.queryDate(criteria({ refresh: true, sortField: "createdAt", cursor: first.cursor })),
    error => error.code === "CURSOR_STALE");
  await assert.rejects(service.queryDate(criteria({ sortField: "messageTimestamp" })), error => error.code === "SCHEMA");
  assert.ok(requests.every(request => request.action === "account"), "sorting is entirely local");
});

test("directory discovery advances without result pagination and exposes a stable partial-coverage total", async (t) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const secondStarted = new Promise(resolve => { started = resolve; });
  const { service, requests } = await setup(t, async request => {
    if (request.source !== "ordinary") return page(request.source);
    if (request.cursor === null) return page("ordinary", [candidate("first", TIME + 1, TIME + 2)],
      { nextCursor: "second", done: false });
    started(); return gate;
  });
  const cold = await service.queryDate(criteria());
  assert.equal(cold.total, 0); assert.equal(cold.resultStable, false);
  await secondStarted;
  assert.equal(requests.filter(r => r.action === "source-page").length, 2,
    "the second directory request starts without any next-page action");
  const early = await service.queryDate(criteria({ refresh: true, limit: 7 }));
  assert.equal(early.total, 1); assert.equal(early.resultStable, false);
  release(page("ordinary", Array.from({ length: 22 }, (_, i) => candidate(`rest-${i}`, TIME + i + 2, TIME + i + 3))));
  await service.whenIdle();
  const complete = await service.queryDate(criteria({ refresh: true, limit: 7 }));
  assert.equal(complete.items.length, 7); assert.equal(complete.total, 23);
  assert.equal(complete.catalogPhase, "settled"); assert.equal(complete.resultStable, true);
  assert.equal(complete.coverageState, "partial", "finished local run must not claim unverified global coverage");
  assert.ok(complete.coverageReasons.includes("shared-projects-unverified"));
  assert.equal(service.status().resultStable, true);
  assert.ok(requests.every(r => ["account", "source-page"].includes(r.action)));
});

test("manual refresh keeps its promise pending until directory reads finish while cached results remain queryable", async (t) => {
  let slow = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const readStarted = new Promise(resolve => { started = resolve; });
  const { service, requests } = await setup(t, async request => {
    if (request.source !== "ordinary") return page(request.source);
    if (slow) { started(); return gate; }
    return page("ordinary", [candidate("cached", TIME + 1, TIME + 2)]);
  });
  await service.queryDate(criteria()); await service.whenIdle();
  slow = true;
  let finished = false;
  const refreshing = service.refreshCatalog().then(status => { finished = true; return status; });
  await readStarted;
  assert.equal(finished, false);
  const cached = await service.queryDate(criteria({ refresh: true }));
  assert.equal(cached.total, 1); assert.equal(cached.catalogPhase, "loading");
  release(page("ordinary", [candidate("new", TIME + 3, TIME + 4)]));
  const result = await refreshing;
  assert.equal(finished, true); assert.equal(result.phase, "settled");
  assert.equal((await service.queryDate(criteria({ refresh: true }))).total, 2);
  assert.equal(requests.filter(r => r.action === "source-page").length, 8);
  assert.ok(requests.every(r => ["account", "source-page"].includes(r.action)));
});

test("cache resolves before unresolved discovery and the runtime catalog has no retired message index", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fixture = await setup(t, async (request) => request.source === "ordinary" ? gate : page(request.source));
  const { db, stores, service, requests } = fixture;
  await seed(db, stores.conversationIndex, [{ ...candidate("existing", TIME + 5, TIME + 20), accountKey: ACCOUNT }]);
  assert.equal(db.objectStoreNames.contains("message-times"), false);
  const transactions = [];
  const transaction = db.transaction.bind(db);
  db.transaction = (names, ...rest) => { transactions.push(typeof names === "string" ? [names] : Array.from(names)); return transaction(names, ...rest); };
  const initial = await service.queryDate(criteria());
  assert.equal(initial.items.length, 1);
  await flush();
  assert.equal(requests.filter((request) => request.action === "source-page").length, 1);
  const paused = service.pause();
  release(page("ordinary", [candidate("existing", TIME + 5, TIME + 40)]));
  await paused;
  assert.ok(transactions.every((names) => !names.includes("message-times")));
  db.transaction = transaction;
  const next = await stored(db, stores.conversationIndex, [ACCOUNT, "existing"]);
  assert.deepEqual(Object.keys(next).sort(), ["accountKey", "catalogMetadata", "conversationId"]);
  assert.equal(next.catalogMetadata.updatedAt, TIME + 40);
  assert.equal(await stored(db, stores.moduleState, `date-search:${ACCOUNT}`), undefined);
});

test("directory pagination discovers projects, deduplicates conversations, and completed catalogs survive criteria and service changes", async (t) => {
  const { service, makeService, requests, repository } = await setup(t, async (request) => {
    if (request.source === "ordinary") return request.cursor === null
      ? page("ordinary", [candidate("a", TIME + 10, TIME + 20)], { nextCursor: "next", done: false })
      : page("ordinary", [candidate("b", TIME + 15, TIME + 25)]);
    if (request.source === "pins") return page("pins", [candidate("a", TIME + 10, TIME + 20)]);
    if (request.source === "projects") return page("projects", [], { projects: [{ projectId: "project-one" }] });
    if (request.source === "project") return page("project", [{ ...candidate("project-chat", TIME + 30, TIME + 35), projectId: request.projectId }]);
    return page(request.source);
  });
  await service.queryDate(criteria());
  await service.whenIdle();
  const calls = requests.filter((request) => request.action === "source-page");
  assert.deepEqual(calls.map((call) => call.request.source), ["ordinary", "ordinary", "archived", "pins", "projects", "project"]);
  assert.equal(calls.at(-1).request.projectId, "project-one");
  const cached = await service.queryDate(criteria({ dateField: "updatedAt", direction: "asc", sessionId: "changed" }));
  await service.whenIdle();
  assert.deepEqual(Array.from(cached.items, (item) => item.conversationId), ["a", "b", "project-chat"]);
  const recreated = makeService();
  await recreated.queryDate(criteria({ startMs: TIME - 500, sessionId: "recreated" }));
  await recreated.whenIdle();
  assert.equal(requests.filter((request) => request.action === "source-page").length, calls.length);
  assert.equal((await repository.getSnapshot(ACCOUNT)).rows.length, 3);
});

test("429 stops all further dispatch until explicit resume and retains retry details", async (t) => {
  let fail = true;
  const { service, requests } = await setup(t, async (request) => {
    if (fail) throw Object.assign(new Error("Rate limited"), { details: { code: "HTTP", category: "HTTP", status: 429, retryable: true, serverCode: "rate_limit" } });
    return page(request.source, request.source === "ordinary" ? [candidate("ok", TIME + 10, TIME + 10)] : []);
  });
  await service.queryDate(criteria());
  await service.whenIdle();
  assert.equal(requests.filter((request) => request.action === "source-page").length, 1);
  assert.equal(service.status().phase, "paused");
  assert.equal(service.status().readErrors[0].status, 429);
  assert.equal(service.status().readErrors[0].retryable, true);
  assert.equal(service.status().readErrors[0].serverCode, "rate_limit");
  await service.queryDate(criteria({ dateField: "updatedAt", sessionId: "local-change" }));
  await service.whenIdle();
  assert.equal(requests.filter((request) => request.action === "source-page").length, 1);
  fail = false;
  await service.resume();
  await service.whenIdle();
  assert.equal(service.status().phase, "settled");
  assert.equal(service.status().readErrors.length, 0);
  assert.equal(requests.filter((request) => request.action === "source-page").length, 5);
});

test("failed and repeating sources remain partial without blocking other directories or automatic retry loops", async (t) => {
  let ordinary = 0, archived = 0;
  const { service, requests } = await setup(t, async (request) => {
    if (request.source === "ordinary") {
      ordinary += 1;
      return page("ordinary", [candidate("first", TIME + 10, TIME + 20)], { nextCursor: "same", done: false });
    }
    if (request.source === "archived") {
      archived += 1;
      throw Object.assign(new Error("Unavailable"), { code: "HTTP", category: "HTTP", status: 503, retryable: true });
    }
    return page(request.source, request.source === "pins" ? [candidate("pin", TIME + 20, TIME + 30)] : []);
  });
  await service.queryDate(criteria());
  await service.whenIdle();
  assert.equal(ordinary, 2);
  assert.equal(archived, 1);
  assert.equal(service.status().readErrors.length, 2);
  assert.ok(service.status().readErrors.some((error) => error.code === "SCHEMA"));
  const result = await service.queryDate(criteria({ refresh: true }));
  assert.deepEqual(Array.from(result.items, (item) => item.conversationId), ["pin", "first"]);
  const before = requests.length;
  await service.queryDate(criteria({ dateField: "updatedAt" }));
  await service.whenIdle();
  assert.equal(requests.slice(before).filter((request) => request.action === "source-page").length, 0);
  await service.resume();
  await service.whenIdle();
  assert.equal(archived, 2);
  assert.equal(ordinary, 2, "a structural cursor failure is not retried");
});

test("hidden views only query cache and resume from the committed catalog cursor", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service, requests, setVisible } = await setup(t, async (request) => request.source === "ordinary" && request.cursor === null
    ? gate : page(request.source));
  setVisible(false);
  await service.queryDate(criteria());
  await service.whenIdle();
  assert.equal(requests.filter((request) => request.action === "source-page").length, 0);
  setVisible(true);
  await service.resume();
  await flush();
  setVisible(false);
  const paused = service.pause();
  release(page("ordinary", [candidate("partial", TIME + 10, TIME + 20)], { nextCursor: "saved-next", done: false }));
  await paused;
  const cached = await service.queryDate(criteria({ refresh: true }));
  assert.equal(cached.items.length, 1);
  assert.equal(requests.filter((request) => request.action === "source-page").length, 1);
  setVisible(true);
  await service.resume();
  await service.whenIdle();
  assert.equal(requests.filter((request) => request.action === "source-page")[1].request.cursor, "saved-next");
});

test("dedicated missing metadata cannot fall back to old bounds and cache results stay account isolated", async (t) => {
  const { db, stores, service, setAccount } = await setup(t);
  await seed(db, stores.conversationIndex, [
    { ...candidate("missing", TIME + 10, TIME + 20), accountKey: ACCOUNT,
      catalogMetadata: { title: "Current", createdAt: null, updatedAt: TIME + 30 } },
    { ...candidate("foreign", TIME + 10, TIME + 20), accountKey: "other" },
  ]);
  const result = await service.queryDate(criteria({ refresh: true }));
  assert.equal(result.items.length, 0);
  assert.ok(result.coverageReasons.includes("catalog-createdAt-missing"));
  setAccount("other");
  const other = await service.queryDate(criteria());
  await service.pause();
  assert.deepEqual(Array.from(other.items, (item) => item.conversationId), ["foreign"]);
});

test("only explicit catalog refresh rediscovers new metadata and unseen old rows remain labeled stale", async (t) => {
  let version = 1;
  const { service, requests } = await setup(t, async (request) => page(request.source,
    request.source === "ordinary" ? version === 1
      ? [candidate("updated", TIME + 10, TIME + 20), candidate("unseen", TIME + 15, TIME + 20)]
      : [candidate("updated", TIME + 10, TIME + 60), candidate("new", TIME + 30, TIME + 40)] : []));
  await service.queryDate(criteria());
  await service.whenIdle();
  assert.ok(service.status().completedAt);
  version = 2;
  await service.queryDate(criteria({ dateField: "updatedAt", sessionId: "changed-field" }));
  await service.whenIdle();
  assert.equal(requests.filter((request) => request.action === "source-page").length, 4);
  const refreshed = await service.refreshCatalog();
  assert.equal(refreshed.phase, "settled", "explicit refresh remains pending until directory discovery stops");
  await service.whenIdle();
  const updated = await service.queryDate(criteria({ dateField: "updatedAt", sortField: "updatedAt", refresh: true }));
  assert.deepEqual(Array.from(updated.items, (item) => item.conversationId), ["updated", "new", "unseen"]);
  assert.equal(updated.items[0].conversationUpdatedAt, new Date(TIME + 60).toISOString());
  assert.equal(requests.filter((request) => request.action === "source-page").length, 8);
  assert.ok(updated.coverageReasons.includes("catalog-snapshot-stale"));
  assert.equal(service.status().progress.staleRows, 1);
  assert.ok(service.status().snapshotStartedAt);
  assert.ok(service.status().lastObservedAt);
});

test("an opt-in head refresh scans only the newest delta through the prior head boundary", async (t) => {
  let run = 1;
  const { service, requests, repository } = await setup(t, async (request) => {
    if (request.source !== "ordinary") return page(request.source);
    if (run === 1) return request.cursor === null
      ? page("ordinary", [candidate("old-head", TIME, TIME + 30)], { nextCursor: "old-2", done: false })
      : page("ordinary", [candidate("old-tail", TIME, TIME + 10)]);
    if (request.cursor === null) return page("ordinary", [candidate("new-a", TIME, TIME + 50), candidate("new-b", TIME, TIME + 40)],
      { nextCursor: "delta-2", done: false });
    if (request.cursor === "delta-2") return page("ordinary", [candidate("old-head", TIME, TIME + 30)],
      { nextCursor: "must-not-read", done: false });
    throw new Error("Head refresh crossed its known boundary");
  });
  await service.queryDate(criteria()); await service.whenIdle();
  run = 2;
  const before = requests.length;
  await service.refreshCatalog({ full: false });
  const delta = requests.slice(before).filter((request) => request.action === "source-page");
  assert.deepEqual(delta.filter(({ request }) => request.source === "ordinary").map(({ request }) => request.cursor), [null, "delta-2"]);
  assert.equal(delta.length, 5, "two ordinary delta pages plus the three one-page directory sources");
  const snapshot = await repository.getSnapshot(ACCOUNT);
  assert.deepEqual(snapshot.rows.map((row) => row.conversationId).sort(), ["new-a", "new-b", "old-head", "old-tail"]);
  assert.equal(snapshot.state.sources.ordinary.mode, "head");
  assert.deepEqual(snapshot.state.sources.ordinary.headIds, ["conversation:new-a", "conversation:new-b"]);
});

test("a new catalog snapshot accepts corrected earlier dates and missing fields instead of retaining stale timestamps", async (t) => {
  let version = 1;
  const { service } = await setup(t, async (request) => {
    if (request.source === "ordinary") return page("ordinary", [version === 1
      ? candidate("corrected", TIME + 10, TIME + 80) : candidate("corrected", null, TIME + 20)]);
    if (request.source === "pins") return page("pins", [candidate("corrected", null, null)]);
    return page(request.source);
  });
  await service.queryDate(criteria({ dateField: "updatedAt" }));
  await service.whenIdle();
  version = 2;
  await service.refreshCatalog();
  await service.whenIdle();
  const updated = await service.queryDate(criteria({ dateField: "updatedAt", refresh: true }));
  assert.equal(updated.items[0].conversationUpdatedAt, new Date(TIME + 20).toISOString());
  assert.equal(updated.items[0].conversationCreatedAt, null);
  const created = await service.queryDate(criteria({ refresh: true }));
  assert.equal(created.items.length, 0);
  assert.ok(created.coverageReasons.includes("catalog-createdAt-missing"));
});

test("pausing a slow account lookup cannot revive catalog dispatch or publish an obsolete query", async (t) => {
  const { db, repository } = await setup(t);
  let release;
  const account = new Promise((resolve) => { release = resolve; });
  const requests = [], statuses = [];
  const context = vm.createContext({ console, structuredClone, document: { hidden: false } });
  vm.runInContext(fs.readFileSync(path.join(root, "src/platform/catalog/date-search.js"), "utf8"), context);
  loadModule(context, "src/platform/catalog/ui/conversation-catalog-reader.js", ["createConversationCatalogReader"]);
  loadModule(context, "src/features/search/ui/conversation-date-search.js", ["createConversationDateSearch"]);
  const service = context.createConversationDateSearch({ repository, now: () => NOW,
    requestAdapter: async (action) => { requests.push(action); return account; },
    onStatus: (value) => statuses.push(value) });
  const initial = service.queryDate(criteria());
  await flush();
  await service.pause();
  release({ schemaVersion: "tidy.date-search.v1", accountKey: ACCOUNT });
  await assert.rejects(initial, error => error.name === "AbortError" && error.code === "CANCELLED");
  await service.whenIdle();
  assert.deepEqual(requests, ["account"]);
  assert.equal(statuses.length, 0);
  context.document.hidden = true;
  await service.queryDate(criteria());
  await service.whenIdle();
  assert.deepEqual(requests, ["account", "account"], "the default visibility gate blocks source dispatch");
  assert.ok(db);
});

test("raw date criteria enforce product bounds in the requested zone before any account or catalog read", async () => {
  const calls = [];
  const context = vm.createContext({ console, structuredClone });
  vm.runInContext(fs.readFileSync(path.join(root, "src/platform/catalog/date-search.js"), "utf8"), context);
  loadModule(context, "src/platform/catalog/ui/conversation-catalog-reader.js", ["createConversationCatalogReader"]);
  loadModule(context, "src/features/search/ui/conversation-date-search.js", ["createConversationDateSearch"]);
  const service = context.createConversationDateSearch({ now: () => Date.parse("2026-09-07T18:30:00Z"),
    repository: { getSnapshot: async () => { calls.push("snapshot"); return { rows: [], state: null }; } },
    requestAdapter: async () => { calls.push("account"); return { schemaVersion: "tidy.date-search.v1", accountKey: ACCOUNT }; } });
  for (const overrides of [
    { startMs: Date.parse("2022-11-29T23:59:59.999Z"), endMs: TIME },
    { startMs: TIME, endMs: Date.parse("2026-09-08T00:00:00.001Z") },
    { startMs: Date.parse("2026-09-08T00:00:00Z"), endMs: Date.parse("2026-09-08T00:00:00Z") },
    { startMs: TIME, endMs: TIME - 1 },
    { startMs: TIME, endMs: TIME, timeZone: "Not/A_Zone" },
    { startMs: -8_640_000_000_000_000, endMs: 8_640_000_000_000_000 },
  ]) {
    await assert.rejects(service.queryDate(criteria(overrides)), error => error.code === "SCHEMA");
  }
  assert.deepEqual(calls, []);
  const launch = context.TidyDateSearch.searchDateRange({ startDate: "2022-11-30", endDate: "2022-11-30",
    timeZone: "Asia/Singapore" }, Date.parse("2026-09-07T18:30:00Z"));
  await service.queryDate(criteria({ ...launch, timeZone: "Asia/Singapore", refresh: true }));
  const today = context.TidyDateSearch.searchDateRange({ startDate: "2026-09-08", endDate: "2026-09-08",
    timeZone: "Asia/Singapore" }, Date.parse("2026-09-07T18:30:00Z"));
  await service.queryDate(criteria({ ...today, timeZone: "Asia/Singapore", refresh: true }));
  assert.deepEqual(calls, ["account", "snapshot", "snapshot"], "both inclusive boundary days are valid");
});

test("valid empty intervals settle at zero without storage, account, or source reads, including resume and refresh", async () => {
  const statuses = [];
  const context = vm.createContext({ console, structuredClone });
  vm.runInContext(fs.readFileSync(path.join(root, "src/platform/catalog/date-search.js"), "utf8"), context);
  loadModule(context, "src/platform/catalog/ui/conversation-catalog-reader.js", ["createConversationCatalogReader"]);
  loadModule(context, "src/features/search/ui/conversation-date-search.js", ["createConversationDateSearch"]);
  const service = context.createConversationDateSearch({ now: () => NOW,
    repository: new Proxy({}, { get() { assert.fail("empty intervals cannot read catalog storage"); } }),
    requestAdapter: () => assert.fail("empty intervals cannot read the account or directory"),
    onStatus: status => statuses.push(status) });
  const result = await service.queryDate(criteria({ endMs: TIME }));
  assert.equal(result.total, 0);
  assert.equal(result.items.length, 0);
  assert.equal(result.hasMore, false);
  assert.equal(result.cursor, null);
  assert.equal(result.resultStable, true);
  assert.equal(result.catalogPhase, "settled");
  assert.equal(result.accountKey, null);
  await service.resume();
  await service.refreshCatalog();
  await service.whenIdle();
  assert.equal(statuses.length, 3);
  assert.ok(statuses.every(status => status.phase === "settled" && status.resultStable));
});

test("a valid empty interval stops prior discovery and keeps its zero result after in-flight completion", async (t) => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  const { service, requests, statuses } = await setup(t, async request => {
    started(); return gate;
  });
  await service.queryDate(criteria());
  await began;
  const zero = await service.queryDate(criteria({ endMs: TIME, sessionId: "empty-day" }));
  const count = statuses.length;
  assert.equal(zero.total, 0);
  release(page("ordinary", [candidate("irrelevant", TIME + 1, TIME + 2)], { nextCursor: "next", done: false }));
  await service.whenIdle();
  assert.equal(statuses.length, count, "stale directory completion cannot overwrite the empty status");
  assert.equal(service.status().sessionId, "empty-day");
  assert.equal(service.status().resultStable, true);
  assert.deepEqual(requests.map(request => request.action), ["account", "source-page"]);
});

test("an empty interval cancels a pending account lookup before it can open the catalog", async () => {
  let release, began;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  const requests = [], statuses = [];
  const context = vm.createContext({ console, structuredClone });
  vm.runInContext(fs.readFileSync(path.join(root, "src/platform/catalog/date-search.js"), "utf8"), context);
  loadModule(context, "src/platform/catalog/ui/conversation-catalog-reader.js", ["createConversationCatalogReader"]);
  loadModule(context, "src/features/search/ui/conversation-date-search.js", ["createConversationDateSearch"]);
  const service = context.createConversationDateSearch({ now: () => NOW,
    repository: new Proxy({}, { get() { assert.fail("obsolete account lookup cannot start a catalog read"); } }),
    requestAdapter: async action => { requests.push(action); began(); return gate; },
    onStatus: status => statuses.push(status) });
  const pending = service.queryDate(criteria());
  await started;
  const zero = await service.queryDate(criteria({ endMs: TIME, sessionId: "empty-day" }));
  assert.equal(zero.total, 0);
  release({ schemaVersion: "tidy.date-search.v1", accountKey: ACCOUNT });
  await assert.rejects(pending, error => error.name === "AbortError" && error.code === "CANCELLED"
    && error.category === "CANCELLED" && error.retryable === false);
  await service.whenIdle();
  assert.deepEqual(requests, ["account"]);
  assert.equal(statuses.length, 1);
  assert.equal(service.status().sessionId, "empty-day");
  assert.equal(service.status().resultStable, true);
});

test("an empty interval cancels manual refresh waiting for its account before further catalog reads", async () => {
  let release, began;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  const requests = [];
  let visible = false;
  const context = vm.createContext({ console, structuredClone });
  vm.runInContext(fs.readFileSync(path.join(root, "src/platform/catalog/date-search.js"), "utf8"), context);
  loadModule(context, "src/platform/catalog/ui/conversation-catalog-reader.js", ["createConversationCatalogReader"]);
  loadModule(context, "src/features/search/ui/conversation-date-search.js", ["createConversationDateSearch"]);
  let accountReads = 0;
  const service = context.createConversationDateSearch({ now: () => NOW, canDispatch: () => visible,
    repository: { getSnapshot: async () => { requests.push("snapshot"); return { rows: [], state: null }; },
      putState: () => assert.fail("cancelled refresh cannot reset catalog state") },
    requestAdapter: async action => {
      assert.equal(action, "account"); requests.push(action); accountReads += 1;
      if (accountReads === 1) return { schemaVersion: "tidy.date-search.v1", accountKey: ACCOUNT };
      began(); return gate;
    } });
  await service.queryDate(criteria());
  visible = true;
  const refreshing = service.refreshCatalog();
  await started;
  await service.queryDate(criteria({ endMs: TIME, sessionId: "empty-day" }));
  release({ schemaVersion: "tidy.date-search.v1", accountKey: ACCOUNT });
  const status = await refreshing;
  assert.equal(status.sessionId, "empty-day");
  assert.equal(status.resultStable, true);
  assert.deepEqual(requests, ["account", "snapshot", "account"]);
});

test("generic catalog criteria and filtering accept skipped historical days while the product service rejects them", async () => {
  const context = vm.createContext({ console, structuredClone });
  vm.runInContext(fs.readFileSync(path.join(root, "src/platform/catalog/date-search.js"), "utf8"), context);
  // Inspect the pure helpers through the test VM, not a production history-bound bypass.
  loadModule(context, "src/platform/catalog/ui/conversation-catalog-reader.js", ["createConversationCatalogReader"]);
  loadModule(context, "src/features/search/ui/conversation-date-search.js", ["createConversationDateSearch", "normalizeCriteria", "resultPage"]);
  const service = context.createConversationDateSearch({ now: () => NOW, repository: {},
    requestAdapter: () => assert.fail("out-of-product dates cannot issue reads") });
  for (const [date, timeZone] of [["2011-12-30", "Pacific/Apia"], ["1993-08-21", "Pacific/Kwajalein"]]) {
    const range = context.TidyDateSearch.dateRange({ startDate: date, endDate: date, timeZone });
    const value = context.normalizeCriteria(criteria({ ...range, timeZone }));
    const snapshot = { state: null, rows: [-1, 0, 1].map(delta => ({
      conversationId: String(delta), title: "Boundary", createdAt: range.startMs + delta, updatedAt: range.startMs + delta,
    })) };
    const result = context.resultPage(snapshot, value, {
      phase: "settled", resultStable: true, coverageState: "complete", coverageReasons: [], readErrors: [],
    });
    assert.equal(result.total, 0);
    assert.equal(result.items.length, 0);
    assert.equal(result.hasMore, false);
    assert.equal(result.resultStable, true);
    await assert.rejects(service.queryDate(value), error => error.code === "SCHEMA");
  }
});
