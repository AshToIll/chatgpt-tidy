const assert = require('node:assert/strict');
const test = require('node:test');
const { IDBFactory } = require('fake-indexeddb');
const NOW = '2026-09-19T12:00:00.000Z', OWNER = '["user-a","personal"]', OTHER = '["user-a","workspace-b"]';
const modules = Promise.all([
  import('../src/features/settings/storage/library-backup-domain.js'), import('../src/features/settings/storage/library-backup.js'),
  import('../src/features/settings/background/library-backup-service.js'), import('../src/platform/storage/database.js'),
  import('../src/features/favorites/storage/favorites.js'), import('../src/features/bookmarks/storage/bookmarks.js'),
  import('../src/features/favorites/storage/favorites-domain.js'), import('../src/features/bookmarks/storage/bookmarks-domain.js'),
  import('../src/features/settings/model/library-backup-format.js'),
]);
const clone = value => JSON.parse(JSON.stringify(value));
const errorCode = code => error => error.code === code;
function item(kind, id, groupId = null, note = 'Saved note') {
  return kind === 'favorites' ? { conversationId: id, title: `Title ${id}`, routePath: `/c/${id}`, savedAt: NOW, groupId, note }
    : { conversationId: id, messageId: 'message', bookmarkId: `${id}::message`, role: 'assistant', excerpt: '<img onerror=alert(1)>',
      conversationTitle: `Title ${id}`, routePath: `/c/${id}`, bookmarkedAt: NOW, groupId, note };
}
async function setup(t) {
  const [domain, repoModule, serviceModule, database, f, b, fd, bd, format] = await modules;
  const db = await database.openTidyDatabase(new IDBFactory());
  t.after(() => db.close());
  const options = { openDatabase: async () => db };
  const repositories = { favorites: f.createFavoritesRepository(options), bookmarks: b.createBookmarksRepository(options) };
  const repository = repoModule.createLibraryBackupRepository(options);
  let clock = Date.parse(NOW), identity = { accountKey: OWNER, tab: { id: 31 }, identity: { documentId: 'doc-a', epoch: 1 } }, serial = 0;
  const notifications = [];
  const assertCurrent = context => {
    if (context.accountKey !== identity.accountKey || context.identity.documentId !== identity.identity.documentId
      || context.identity.epoch !== identity.identity.epoch || context.tab.id !== identity.tab.id) throw Object.assign(Error('revoked'), { code: 'CONTEXT_MISMATCH' });
  };
  const deps = { repository, assertCurrent, notify: (kind, state) => notifications.push({ kind, state }), now: () => clock, createId: () => `preview-${++serial}` };
  const service = serviceModule.createLibraryBackupService(deps);
  const sample = () => ({
    favorites: fd.normalizeFavoritesState({ ...fd.createEmptyFavoritesState(), items: { first: item('favorites', 'first', 'study') } }),
    bookmarks: bd.normalizeBookmarksState({ ...bd.createEmptyBookmarksState(), items: { 'first::message': item('bookmarks', 'first', 'bookmark-quote') } }),
  });
  return { domain, format, db, repository, repositories, service, deps, notifications, sample,
    context: () => clone(identity), switchOwner: value => { identity = value; }, advance: ms => { clock += ms; },
    text: (value = sample(), owner = OWNER) => domain.serializeLibraryBackup(owner, value, NOW),
    read: (owner = OWNER) => repository.read(owner, () => {}),
  };
}

test('backup has a strict standalone format; round-trip contains only library data', async t => {
  const f = await setup(t), sample = f.sample();
  sample.favorites.accountKey = OTHER; sample.favorites.view.query = 'private search';
  sample.favorites.token = 'must not leak'; sample.favorites.revision = 99;
  const text = f.text(sample), parsed = f.domain.parseLibraryBackup(text, OWNER);
  assert.equal(parsed.accountKey, OWNER);
  assert.equal(parsed.favorites.items[0].note, 'Saved note');
  assert.equal(parsed.bookmarks.items[0].note, 'Saved note');
  assert.equal(parsed.bookmarks.items[0].excerpt, '<img onerror=alert(1)>');
  assert.doesNotMatch(text, /private search|must not leak|"revision"|"view"|"token"/);
  assert.equal(parsed.favorites.groups.length, 4);
  assert.deepEqual(f.domain.parseLibraryBackup(JSON.stringify(parsed), OWNER), parsed);
});

test('malformed files fail instead of silently normalizing or discarding records', async t => {
  const f = await setup(t), original = JSON.parse(f.text());
  const cases = [
    value => { value.secret = 'extra'; },
    value => { value.exportedAt = 'yesterday'; },
    value => { value.bookmarks = null; },
    value => { value.favorites.items.push(clone(value.favorites.items[0])); },
    value => { value.bookmarks.items.push(clone(value.bookmarks.items[0])); },
    value => { value.favorites.groups.push(clone(value.favorites.groups[0])); },
    value => { value.favorites.items[0].note = 'a'.repeat(2001); },
    value => { value.favorites.items[0].groupId = 'absent'; },
    value => { value.favorites.items[0].routePath = 'https://evil.example/c/first'; },
    value => { value.favorites.items[0].routePath = '/c/second'; },
    value => { value.favorites.items[0].routePath = '/c/first?search=secret'; },
    value => { value.bookmarks.items[0].messageId = 'different'; },
    value => { value.bookmarks.items[0].locator.value = 'different'; },
    value => { value.bookmarks.items[0].excerpt = 'x'.repeat(321); },
    value => { value.bookmarks.items[0].orderNumber = -1; },
    value => { value.favorites.groups[0].name = ' '; },
    value => { value.bookmarks.groups[0].icon = 'invalid'; },
    value => { value.bookmarks.groups[0].order = 10; },
    value => { value.favorites.items[0].savedAt = '2026-09-19'; },
  ];
  for (const [index, mutate] of cases.entries()) {
    const value = clone(original); mutate(value);
    assert.throws(() => f.domain.parseLibraryBackup(JSON.stringify(value), OWNER), errorCode('BACKUP_INVALID'), `case ${index}`);
  }
  for (const text of ['', '{', 'null', '[]', '{"__proto__":{}}', f.text().replace('"note":', '"constructor":')]) {
    assert.throws(() => f.domain.parseLibraryBackup(text, OWNER), errorCode('BACKUP_INVALID'));
  }
  assert.throws(() => f.domain.parseLibraryBackup(JSON.stringify({ ...original, version: 2 }), OWNER), errorCode('BACKUP_VERSION'));
  assert.throws(() => f.domain.parseLibraryBackup(f.text(), OTHER), errorCode('BACKUP_ACCOUNT_MISMATCH'));
  assert.throws(() => f.domain.parseLibraryBackup(' '.repeat(f.format.LIBRARY_BACKUP_LIMITS.bytes + 1), OWNER), errorCode('BACKUP_TOO_LARGE'));
  assert.throws(() => f.domain.parseLibraryBackup('汉'.repeat(f.format.LIBRARY_BACKUP_LIMITS.bytes / 2), OWNER), errorCode('BACKUP_TOO_LARGE'));
  original.favorites.items = Array(20001).fill(original.favorites.items[0]);
  assert.throws(() => f.domain.parseLibraryBackup(JSON.stringify(original), OWNER), errorCode('BACKUP_TOO_LARGE'));
  assert.deepEqual(f.notifications, []);
});

test('preview is read-only; restore is atomic, account-local and repeat import is a no-op', async t => {
  const f = await setup(t), before = await f.read(), other = await f.read(OTHER), context = f.context();
  const modes = [], transaction = f.db.transaction.bind(f.db);
  f.db.transaction = (names, mode) => { modes.push({ names, mode }); return transaction(names, mode); };
  const preview = await f.service.preview(context, f.text());
  assert.deepEqual(await f.read(), before);
  assert.ok(modes.every(entry => entry.mode === 'readonly'));
  assert.deepEqual(preview.summary.favorites, { added: 1, skipped: 0, addedGroups: 0 });
  const restored = await f.service.restore(context, preview.id);
  assert.equal(restored.favorites.items.first.note, 'Saved note');
  assert.equal(restored.bookmarks.items['first::message'].note, 'Saved note');
  assert.equal(restored.bookmarks.items['first::message'].groupId, 'bookmark-quote');
  assert.deepEqual(await f.read(OTHER), other);
  assert.equal(modes.filter(entry => entry.mode === 'readwrite').length, 1);
  assert.equal(new Set(modes.find(entry => entry.mode === 'readwrite').names).size, 5);
  assert.equal(f.notifications.length, 2);
  const saved = await f.read(), next = await f.service.preview(context, f.text());
  assert.equal(next.summary.favorites.skipped, 1);
  await f.service.restore(context, next.id);
  assert.deepEqual(await f.read(), saved); assert.equal(f.notifications.length, 2);
  await assert.rejects(f.service.restore(context, preview.id), errorCode('BACKUP_EXPIRED'));
});

test('existing notes, items and view stay unchanged; conflicting group IDs are remapped deterministically', async t => {
  const f = await setup(t), incoming = f.sample();
  await f.repositories.favorites.transact(OWNER, state => ({ ...state, revision: 1,
    groups: state.groups.map(group => group.id === 'study' ? { ...group, name: 'My renamed group' } : group),
    items: { first: item('favorites', 'first', null, 'Keep this note') }, view: { ...state.view, sortDirection: 'asc' } }));
  const fd = (await modules)[6];
  incoming.favorites = fd.normalizeFavoritesState({ ...incoming.favorites, items: {
    ...incoming.favorites.items, second: item('favorites', 'second', 'study'),
  } });
  const context = f.context(), preview = await f.service.preview(context, f.text(incoming));
  assert.equal(preview.summary.favorites.addedGroups, 1);
  const result = await f.service.restore(context, preview.id), state = result.favorites;
  assert.equal(state.items.first.note, 'Keep this note'); assert.equal(state.items.first.groupId, null);
  assert.equal(state.view.sortDirection, 'asc');
  assert.equal(state.groups.find(group => group.id === 'study').name, 'My renamed group');
  assert.notEqual(state.items.second.groupId, 'study');
  const imported = state.groups.find(group => group.id === state.items.second.groupId);
  assert.equal(imported.name, '学习'); assert.equal(imported.preset, null);
  const again = await f.service.preview(context, f.text(incoming));
  assert.equal(again.summary.favorites.addedGroups, 0);
  await f.service.restore(context, again.id); assert.deepEqual(await f.read(), { favorites: result.favorites, bookmarks: result.bookmarks });
});

test('empty groups are backed up and restored; fresh export is one consistent read with no writes', async t => {
  const f = await setup(t), context = f.context();
  await f.repositories.favorites.transact(OWNER, state => ({ ...state, groups: [], revision: 1 }));
  const result = await f.service.exportBackup(context), value = JSON.parse(result.text);
  assert.deepEqual(value.favorites.groups, []); assert.match(result.filename, /^ChatGPT-Tidy-library-2026-09-19\.json$/);
  const sample = f.sample();
  sample.favorites.items = {}; sample.bookmarks.items = {};
  const preview = await f.service.preview(context, f.text(sample));
  assert.equal(preview.summary.favorites.addedGroups, 4);
  await f.service.restore(context, preview.id);
  assert.equal((await f.read()).favorites.groups.length, 4);
});

test('any concurrent revision change invalidates confirmation without modifying either library', async t => {
  const f = await setup(t), context = f.context(), preview = await f.service.preview(context, f.text());
  await f.repositories.bookmarks.transact(OWNER, state => ({ ...state, revision: state.revision + 1, groups: [] }));
  const changed = await f.read();
  await assert.rejects(f.service.restore(context, preview.id), errorCode('BACKUP_CHANGED'));
  assert.deepEqual(await f.read(), changed); assert.equal(f.notifications.length, 0);
});

test('a queued transaction rechecks ownership and cannot write after a switch', async t => {
  const f = await setup(t), context = f.context(), before = await f.read();
  const preview = await f.service.preview(context, f.text());
  const oldRead = f.db.transaction.bind(f.db);
  f.db.transaction = (...args) => {
    const tx = oldRead(...args);
    if (args[1] === 'readwrite') f.switchOwner({ ...context, accountKey: OTHER });
    return tx;
  };
  await assert.rejects(f.service.restore(context, preview.id), errorCode('CONTEXT_MISMATCH'));
  assert.deepEqual(await f.read(), before); assert.equal(f.notifications.length, 0);
});

test('an IndexedDB write failure rolls back both libraries and emits no success notification', async t => {
  const f = await setup(t), context = f.context(), before = await f.read();
  const preview = await f.service.preview(context, f.text());
  const oldTransaction = f.db.transaction.bind(f.db);
  f.db.transaction = (...args) => {
    const tx = oldTransaction(...args), oldStore = tx.objectStore.bind(tx);
    if (args[1] === 'readwrite') tx.objectStore = name => {
      const store = oldStore(name);
      if (name === 'bookmarks') store.put = () => { throw Error('quota failure on second library'); };
      return store;
    };
    return tx;
  };
  await assert.rejects(f.service.restore(context, preview.id), /quota failure/);
  assert.deepEqual(await f.read(), before); assert.equal(f.notifications.length, 0);
});

test('wrong owner, stale document, expired, discarded, revoked and restarted confirmations cannot restore', async t => {
  const f = await setup(t), context = f.context();
  await assert.rejects(f.service.preview(context, f.text(f.sample(), OTHER)), errorCode('BACKUP_ACCOUNT_MISMATCH'));
  let preview = await f.service.preview(context, f.text());
  await assert.rejects(f.service.restore({ ...context, identity: { ...context.identity, epoch: 2 } }, preview.id), errorCode('CONTEXT_MISMATCH'));
  await assert.rejects(f.service.restore({ ...context, tab: { id: 2 } }, preview.id), errorCode('CONTEXT_MISMATCH'));
  f.advance(10 * 60_000);
  await assert.rejects(f.service.restore(context, preview.id), errorCode('BACKUP_EXPIRED'));
  preview = await f.service.preview(context, f.text()); f.service.discard(context, preview.id);
  await assert.rejects(f.service.restore(context, preview.id), errorCode('BACKUP_EXPIRED'));
  preview = await f.service.preview(context, f.text()); f.service.revoke(context.tab.id);
  await assert.rejects(f.service.restore(context, preview.id), errorCode('BACKUP_EXPIRED'));
  preview = await f.service.preview(context, f.text());
  const restarted = (await modules)[2].createLibraryBackupService(f.deps);
  await assert.rejects(restarted.restore(context, preview.id), errorCode('BACKUP_EXPIRED'));
  assert.equal(f.notifications.length, 0);
});

test('new previews supersede old tokens and double-click confirmation writes only once', async t => {
  const f = await setup(t), context = f.context();
  const one = await f.service.preview(context, f.text()), two = await f.service.preview(context, f.text());
  f.service.discard(context, one.id);
  await assert.rejects(f.service.restore(context, one.id), errorCode('BACKUP_EXPIRED'));
  const [first, second] = await Promise.allSettled([f.service.restore(context, two.id), f.service.restore(context, two.id)]);
  assert.equal(first.status, 'fulfilled'); assert.equal(second.reason.code, 'BACKUP_EXPIRED');
  assert.equal(f.notifications.length, 2);
});

test('backup rejects malformed existing storage instead of exporting a silently shortened library', async t => {
  const f = await setup(t), context = f.context();
  const tx = f.db.transaction(['favorites'], 'readwrite');
  tx.objectStore('favorites').put({ accountKey: OWNER, conversationId: 'broken', note: 'Must not disappear silently' });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
  await assert.rejects(f.service.exportBackup(context), errorCode('STORAGE_ERROR'));
  await assert.rejects(f.service.preview(context, f.text()), errorCode('STORAGE_ERROR'));
  assert.equal(f.notifications.length, 0);
});

test('confirmation that expires while its write transaction is queued does not write', async t => {
  const f = await setup(t), context = f.context(), before = await f.read();
  const preview = await f.service.preview(context, f.text()), original = f.db.transaction.bind(f.db);
  f.db.transaction = (...args) => { const tx = original(...args); if (args[1] === 'readwrite') f.advance(10 * 60_000); return tx; };
  await assert.rejects(f.service.restore(context, preview.id), errorCode('BACKUP_EXPIRED'));
  assert.deepEqual(await f.read(), before);
});

test('a delayed preview cannot replace a newer selection in the same panel', async t => {
  const f = await setup(t), context = f.context();
  let release, reads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const service = (await modules)[2].createLibraryBackupService({ ...f.deps, repository: { ...f.repository,
    read: async (...args) => { if (++reads === 1) await gate; return f.repository.read(...args); } } });
  const old = service.preview(context, f.text());
  const oldRejected = assert.rejects(old, errorCode('BACKUP_EXPIRED'));
  while (!reads) await new Promise(setImmediate);
  const latest = await service.preview(context, f.text()); release(); await oldRejected;
  const result = await service.restore(context, latest.id); assert.equal(result.summary.favorites.added, 1);
});
