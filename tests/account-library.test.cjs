const assert = require("node:assert/strict");
const test = require("node:test");
const { IDBFactory } = require("fake-indexeddb");

const modules = Promise.all([
  import("../src/platform/storage/database.js"),
  import("../src/platform/storage/schema.js"),
  import("../src/features/bookmarks/storage/bookmarks.js"),
  import("../src/features/favorites/storage/favorites.js"),
  import("../src/features/bookmarks/storage/bookmarks-domain.js"),
  import("../src/features/favorites/storage/favorites-domain.js"),
]);
const NOW = "2026-09-11T12:00:00.000Z";

function favorite(id, overrides = {}) {
  return { conversationId: id, title: `Favorite ${id}`, routePath: `/c/${id}`,
    savedAt: NOW, note: `Note ${id}`, groupId: "old-group", ...overrides };
}
function bookmark(id, overrides = {}) {
  return { bookmarkId: `${id}::message`, conversationId: id, messageId: "message",
    conversationTitle: `Bookmark ${id}`, excerpt: `Excerpt ${id}`, note: `Note ${id}`,
    role: "assistant", routePath: `/c/${id}`, bookmarkedAt: NOW, groupId: "old-group", ...overrides };
}
async function setup(t) {
  const [database, , bookmarks, favorites, bookmarkDomain] = await modules;
  const db = await database.openTidyDatabase(new IDBFactory());
  t.after(() => db.close());
  const options = { openDatabase: async () => db };
  return { db, bookmarks: bookmarks.createBookmarksRepository(options), favorites: favorites.createFavoritesRepository(options),
    createBookmarks: () => bookmarks.createBookmarksRepository(options), bookmarkDomain };
}

test("libraries reject missing or noncanonical owners before opening storage", async () => {
  const [, , bookmarks, favorites] = await modules;
  let opens = 0;
  for (const create of [bookmarks.createBookmarksRepository, favorites.createFavoritesRepository]) {
    const repository = create({ openDatabase: async () => { opens += 1; throw new Error("must not open"); } });
    for (const account of [undefined, null, "", " ", " a", "a ", 4, {}, "a\u0000b", "a".repeat(513)]) {
      await assert.rejects(repository.get(account), (error) => error.code === "ACCOUNT_REQUIRED");
      await assert.rejects(repository.transact(account, (state) => state), (error) => error.code === "ACCOUNT_REQUIRED");
    }
  }
  assert.equal(opens, 0);
});

test("same conversation/message IDs and groups remain isolated across accounts and reads never write", async (t) => {
  const { db, bookmarks, favorites } = await setup(t);
  for (const [repository, item, id] of [[favorites, favorite("same"), "same"], [bookmarks, bookmark("same"), "same::message"]]) {
    await repository.transact("owner-a", (state) => ({ ...state, items: { [id]: { ...item, note: "private A" } } }));
    await repository.transact("owner-b", (state) => ({ ...state, items: { [id]: { ...item, note: "private B" } } }));
    assert.equal((await repository.get("owner-a")).items[id].note, "private A");
    assert.equal((await repository.get("owner-b")).items[id].note, "private B");
    assert.equal((await repository.get("owner-a")).accountKey, "owner-a");
    await assert.rejects(repository.transact("owner-a", (state) => ({ ...state, accountKey: "owner-b" })),
      (error) => error.code === "VALIDATION_ERROR");
  }
  let writes = 0;
  const transaction = db.transaction.bind(db);
  db.transaction = (names, mode, ...rest) => { if (mode === "readwrite") writes += 1; return transaction(names, mode, ...rest); };
  await bookmarks.get("owner-a"); await bookmarks.get("owner-a"); await favorites.get("owner-b");
  assert.equal(writes, 0, "ordinary get() has no hidden migration or metadata write");
  db.transaction = transaction;
});

test("bookmark group reorders persist and concurrent repository instances cannot lose groups", async (t) => {
  const { bookmarks, createBookmarks, bookmarkDomain } = await setup(t);
  const first = await bookmarks.get("owner-a");
  const order = first.groups.map((group) => group.id).reverse();
  await bookmarks.transact("owner-a", (state) => bookmarkDomain.reorderBookmarkGroups(state, order));
  assert.deepEqual((await bookmarks.get("owner-a")).groups.map((group) => group.id), order);
  const other = createBookmarks();
  await Promise.all([
    bookmarks.transact("owner-a", (state) => bookmarkDomain.createBookmarkGroup(state, "One", { idFactory: () => "new-one" })),
    other.transact("owner-a", (state) => bookmarkDomain.createBookmarkGroup(state, "Two", { idFactory: () => "new-two" })),
  ]);
  assert.deepEqual((await bookmarks.get("owner-a")).groups.slice(-2).map((group) => group.id), ["new-one", "new-two"]);
  assert.equal((await bookmarks.get("owner-b")).groups.some((group) => group.id === "new-one"), false);
});

test("only absent libraries project defaults; deleted groups stay deleted across repository instances", async t => {
  const { db, bookmarks, favorites } = await setup(t);
  const [, , b, f] = await modules;
  for (const [repository, create] of [[bookmarks, b.createBookmarksRepository], [favorites, f.createFavoritesRepository]]) {
    const initial = await repository.get('new-owner');
    assert.ok(initial.groups.length > 0);
    await repository.transact('new-owner', state => ({ ...state, groups: [] }));
    const reopened = create({ openDatabase: async () => db });
    assert.deepEqual((await reopened.get('new-owner')).groups, []);
    assert.ok((await reopened.get('different-owner')).groups.length > 0);
  }
});

test("existing group rows without metadata are not mistaken for an empty library", async t => {
  const { db, bookmarks, favorites } = await setup(t);
  const transaction = db.transaction(['bookmark-groups', 'favorite-groups'], 'readwrite');
  for (const store of ['bookmark-groups', 'favorite-groups']) {
    transaction.objectStore(store).put({ accountKey: 'existing-owner', id: 'custom', name: 'Custom', order: 0 });
  }
  await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error); });
  for (const repository of [bookmarks, favorites]) {
    assert.deepEqual((await repository.get('existing-owner')).groups.map(group => group.id), ['custom']);
  }
});
