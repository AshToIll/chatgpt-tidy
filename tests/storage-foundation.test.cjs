const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");

globalThis.IDBKeyRange = IDBKeyRange;
const modules = Promise.all([import("../src/platform/storage/database.js"), import("../src/platform/storage/schema.js"),
  import("../src/features/favorites/storage/favorites.js"), import("../src/features/bookmarks/storage/bookmarks.js"), import("../src/platform/catalog/storage/conversation-catalog.js")]);
const NAME = "chatgpt-tidy-storage";
const OWNERS = ['["same-user","personal"]', '["same-user","business"]', '["other-user","business"]'];
const NOW = "2026-09-14T00:00:00.000Z";
const OFFICIAL = ["bookmarks", "bookmark-groups", "favorites", "favorite-groups", "module-state", "conversation-index"].sort();
const result = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
const done = tx => new Promise((resolve, reject) => {
  tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error || Error("Aborted"));
});

async function snapshot(db) {
  const tx = db.transaction(OFFICIAL, "readonly"), finished = done(tx);
  const entries = await Promise.all(OFFICIAL.map(async name => {
    const store = tx.objectStore(name);
    return [name, { keyPath: store.keyPath, autoIncrement: store.autoIncrement,
      indexes: Array.from(store.indexNames, key => {
        const index = store.index(key);
        return { name: key, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
      }), rows: await result(store.getAll()) }];
  }));
  await finished; return Object.fromEntries(entries);
}

async function setup(t, factory = new IDBFactory()) {
  const [database, , favorites, bookmarks, catalog] = await modules;
  const db = await database.openTidyDatabase(factory); t.after(() => db.close());
  const options = { openDatabase: async () => db };
  return { db, factory, favorites: favorites.createFavoritesRepository(options),
    bookmarks: bookmarks.createBookmarksRepository(options), catalog: catalog.createConversationCatalogRepository(options) };
}

// Exercise production repositories, not an old-schema fixture or a migration.
async function populate(h) {
  for (const [i, owner] of OWNERS.entries()) {
    for (const kind of ["favorites", "bookmarks"]) {
      const item = { conversationId: "same", groupId: "custom", note: `note-${i}`,
        routePath: "/c/same", ...(kind === "favorites" ? { title: `favorite-${i}`, savedAt: NOW }
          : { bookmarkId: "same::message", messageId: "message", conversationTitle: `bookmark-${i}`,
            role: "assistant", excerpt: `excerpt-${i}`, bookmarkedAt: NOW }) };
      await h[kind].transact(owner, state => ({ ...state, revision: state.revision + 1,
        groups: [...state.groups, { id: "custom", name: `group-${i}`, order: state.groups.length }],
        items: { [kind === "favorites" ? "same" : "same::message"]: item },
        view: { ...state.view, groupId: "custom" } }));
    }
    await h.catalog.commitPage(owner, { conversations: [{ conversationId: "same", title: `catalog-${i}`,
      directoryBounds: { createdAt: 100 }, updatedAt: 200 }] },
    { catalogVersion: 2, generation: 1, revision: 1, snapshotStartedAt: 50 });
  }
}

test("new permanent database creates exactly the six current stores and their exact indexes", async t => {
  const [, schema] = await modules, { db } = await setup(t);
  assert.equal(schema.STORAGE_BOUNDARIES.indexedDb.databaseName, NAME);
  assert.equal(schema.STORAGE_BOUNDARIES.indexedDb.version, 1);
  assert.equal(db.name, NAME); assert.equal(db.version, 1);
  assert.deepEqual(Array.from(db.objectStoreNames), OFFICIAL);
  const shape = await snapshot(db);
  const index = (name, keyPath, unique = false) => ({ name, keyPath, unique, multiEntry: false });
  for (const name of OFFICIAL) {
    const group = name.endsWith("-groups"), bookmark = name === "bookmarks";
    const keyPath = name === "module-state" ? "key" : ["accountKey",
      group ? "id" : bookmark ? "bookmarkId" : "conversationId"];
    const indexes = group ? [index("accountKey", "accountKey"), index("order", ["accountKey", "order"])]
      : ["favorites", "bookmarks"].includes(name) ? [index("accountKey", "accountKey"), index("group", ["accountKey", "groupId"]),
        ...(bookmark ? [index("message", ["accountKey", "conversationId", "messageId"], true)] : [])] : [];
    assert.deepEqual(shape[name], { keyPath, autoIncrement: false, indexes, rows: [] }, name);
  }
  for (const retired of ["unclaimed-sources", "claim-receipts", "message-times"]) assert.equal(db.objectStoreNames.contains(retired), false);
});

test("reopening the same database does not rerun creation or change any stored data/index", async t => {
  const [database] = await modules, h = await setup(t); await populate(h);
  const before = await snapshot(h.db); h.db.close();
  let upgrades = 0;
  const factory = { open(name, version) {
    assert.equal(name, NAME); assert.equal(version, 1);
    const request = h.factory.open(name, version);
    request.addEventListener("upgradeneeded", () => { upgrades++; request.transaction.abort(); }); return request;
  } };
  for (let i = 0; i < 3; i++) {
    const reopened = await database.openTidyDatabase(factory);
    try { assert.deepEqual(await snapshot(reopened), before); } finally { reopened.close(); }
  }
  assert.equal(upgrades, 0);
});

test("favorites, bookmarks, both groups, module state and catalog read/write with user/workspace isolation", async t => {
  const h = await setup(t); await populate(h);
  const before = await snapshot(h.db);
  assert.ok(OFFICIAL.every(name => before[name].rows.length >= OWNERS.length));
  for (const [i, owner] of OWNERS.entries()) {
    for (const [kind, id] of [["favorites", "same"], ["bookmarks", "same::message"]]) {
      const state = await h[kind].get(owner);
      assert.equal(state.items[id].note, `note-${i}`);
      assert.equal(state.groups.find(group => group.id === "custom").name, `group-${i}`);
      assert.equal(state.view.groupId, "custom"); assert.equal(state.accountKey, owner);
    }
    const catalog = await h.catalog.getSnapshot(owner);
    assert.equal(catalog.rows.length, 1); assert.equal(catalog.rows[0].title, `catalog-${i}`);
    assert.equal(catalog.state.accountKey, owner); assert.equal(catalog.state.revision, 1);
  }
  // Delete one owner's colliding IDs/groups; the other user and workspace stay exact.
  for (const kind of ["favorites", "bookmarks"]) await h[kind].transact(OWNERS[0], state => ({ ...state,
    items: {}, groups: state.groups.filter(group => group.id !== "custom"), revision: state.revision + 1 }));
  await h.catalog.commitPage(OWNERS[0], { conversations: [{ conversationId: "same", title: "changed", updatedAt: 300 }] },
    { catalogVersion: 2, generation: 2, revision: 2 });
  const after = await snapshot(h.db);
  for (const name of OFFICIAL) assert.deepEqual(after[name].rows.filter(row => row.accountKey !== OWNERS[0]),
    before[name].rows.filter(row => row.accountKey !== OWNERS[0]), name);
  for (const kind of ["favorites", "bookmarks"]) assert.deepEqual((await h[kind].get(OWNERS[0])).items, {});
  assert.equal((await h.catalog.getSnapshot(OWNERS[0])).rows[0].title, "changed");
});

test("development databases can coexist without being opened, read, copied or deleted", async t => {
  const factory = new IDBFactory(), oldNames = ["chatgpt-tidy-v1", "chatgpt-tidy-v2", "tidy-development-scratch"];
  for (const name of oldNames) {
    const request = factory.open(name, 99);
    request.onupgradeneeded = () => request.result.createObjectStore("sentinel").put({ private: name }, "keep");
    const db = await result(request); db.close();
  }
  const opens = [], guarded = {
    open(name, version) { opens.push([name, version]); assert.equal(name, NAME); return factory.open(name, version); },
    deleteDatabase() { assert.fail("Runtime must not delete development databases"); },
    databases() { assert.fail("Runtime must not discover development databases"); },
  };
  const h = await setup(t, guarded);
  assert.ok(Object.values(await snapshot(h.db)).every(store => store.rows.length === 0));
  for (const kind of ["favorites", "bookmarks"]) assert.deepEqual((await h[kind].get(OWNERS[0])).items, {});
  assert.deepEqual(await h.catalog.getSnapshot(OWNERS[0]), { rows: [], state: null });
  await populate(h); assert.deepEqual(opens, [[NAME, 1]]);
  for (const name of oldNames) {
    const db = await result(factory.open(name, 99));
    assert.deepEqual(Array.from(db.objectStoreNames), ["sentinel"]);
    assert.deepEqual(await result(db.transaction("sentinel").objectStore("sentinel").get("keep")), { private: name });
    db.close();
  }
});

test("aborted new-database creation is atomic and a later explicit open creates a complete empty database", async t => {
  const [database] = await modules, factory = new IDBFactory();
  const failing = { open(name, version) {
    const request = factory.open(name, version);
    request.addEventListener("upgradeneeded", () => queueMicrotask(() => request.transaction?.abort())); return request;
  } };
  await assert.rejects(database.openTidyDatabase(failing), error => error.code === "STORAGE_ERROR");
  assert.deepEqual(await factory.databases(), []);
  const h = await setup(t, factory);
  assert.deepEqual(Array.from(h.db.objectStoreNames), OFFICIAL);
  assert.ok(Object.values(await snapshot(h.db)).every(store => store.rows.length === 0));
});

test("production storage/catalog contains no development database or checkpoint conversion path", () => {
  const files = ["src/platform/storage/schema.js", "src/platform/storage/database.js", "src/platform/catalog/storage/conversation-catalog.js",
    "src/platform/catalog/ui/conversation-catalog-reader.js"];
  for (const file of files) assert.doesNotMatch(fs.readFileSync(file, "utf8"),
    /chatgpt-tidy-v[12]|migrat|oldVersion|pre-account|unclaimed-sources|claim-receipts|deleteDatabase|deleteObjectStore|catalogVersion\s*===\s*1\b/i, file);
});
