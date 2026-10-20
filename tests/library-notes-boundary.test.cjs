const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('list views and their DOM patcher have no retired multiline editor branches', () => {
  // These views use input/select controls. Removing note editing also removes
  // its textarea synchronization and event exemptions, not just its markup.
  for (const file of ['src/platform/ui/stable-list-dom.js',
    'src/features/favorites/ui/favorites-view.js', 'src/features/bookmarks/ui/bookmarks-view.js',
    'src/features/export/ui/export-view.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /textarea/i, file);
  }
});

// A thin entrypoint no longer contains every action. Check every production
// JavaScript owner so moving a forbidden API into a controller cannot hide it.
function productionJavaScript(directory = 'src') {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = directory + '/' + entry.name;
    return entry.isDirectory() ? productionJavaScript(relative)
      : entry.name.endsWith('.js') ? [relative] : [];
  });
}

test('note editing has no protocol, dispatcher, domain or panel entrypoint', async () => {
  const favorites = await import('../src/features/favorites/storage/favorites-domain.js');
  const bookmarks = await import('../src/features/bookmarks/storage/bookmarks-domain.js');
  assert.equal(Object.hasOwn(favorites, 'updateFavoriteNote'), false);
  assert.equal(Object.hasOwn(bookmarks, 'updateBookmarkNote'), false);
  const files = productionJavaScript();
  for (const required of ['src/platform/protocol.js', 'src/app/background/service-worker.js',
    'src/app/sidepanel/panel.js', 'src/app/page/main-world.bundle.js']) {
    assert.ok(files.includes(required), required + ' must remain in the production boundary scan');
  }
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /NOTE_UPDATE|note-update|updateFavoriteNote|updateBookmarkNote|MAX_(?:BOOKMARK_)?NOTE_LENGTH/, file);
    // The paper-shaped group icon is not a data field. Only the one-time
    // database purge may access a retired record property, and only to delete it.
    if (file !== 'src/platform/storage/database.js') {
      assert.doesNotMatch(source.replaceAll('GROUP_ICON_MARKUP.note', ''), /(?:\?\.)?\.note\b|\[\s*["']note["']\s*\]/, file);
    }
    if (file.startsWith('src/app/sidepanel/')) assert.doesNotMatch(source, /searchActionEpoch/, file);
  }
});

test('retired bookmark data is stripped, never searched, and active excerpts remain searchable', async () => {
  const bookmarks = await import('../src/features/bookmarks/storage/bookmarks-domain.js');
  const saved = bookmarks.normalizeBookmarksState({ ...bookmarks.createEmptyBookmarksState(), items: {
    'saved::message': { bookmarkId: 'saved::message', conversationId: 'saved', messageId: 'message',
      routePath: '/c/saved', excerpt: 'Active excerpt', conversationTitle: 'Active title', note: 'retired-only-keyword' },
  } });
  assert.equal(Object.hasOwn(saved.items['saved::message'], 'note'), false);
  assert.equal(bookmarks.selectBookmarks(saved, { groupId: 'all', query: 'retired-only-keyword' }).length, 0);
  for (const query of ['excerpt', 'title']) assert.equal(bookmarks.selectBookmarks(saved, { groupId: 'all', query }).length, 1);
});

for (const kind of ['favorites', 'bookmarks']) test(`${kind}: normal writes and backups cannot retain or restore retired fields`, async t => {
  const { IDBFactory } = require('fake-indexeddb');
  const { openTidyDatabase } = await import('../src/platform/storage/database.js');
  const module = await import(`../src/features/${kind}/storage/${kind}.js`);
  const backup = await import('../src/features/settings/storage/library-backup-domain.js');
  const db = await openTidyDatabase(new IDBFactory()); t.after(() => db.close());
  const repository = module[kind === 'favorites' ? 'createFavoritesRepository' : 'createBookmarksRepository']({ openDatabase: async () => db });
  const id = kind === 'favorites' ? 'saved' : 'saved::message';
  const item = { conversationId: 'saved', routePath: '/c/saved', title: 'Saved title',
    bookmarkId: id, messageId: 'message', conversationTitle: 'Saved title', excerpt: 'Saved excerpt', note: 'retired-only-keyword' };
  const saved = await repository.transact('owner', state => ({ ...state, items: { [id]: item } }));
  assert.equal(Object.hasOwn(saved.items[id], 'note'), false);
  assert.equal(Object.hasOwn((await repository.get('owner')).items[id], 'note'), false);
  const stored = await new Promise((resolve, reject) => {
    const request = db.transaction(kind).objectStore(kind).get(['owner', id]);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  assert.equal(Object.hasOwn(stored, 'note'), false, 'The field must be absent on disk, not only in the UI');
  const active = { groups: saved.groups, items: Object.values(saved.items) };
  assert.doesNotThrow(() => backup.validateBackupLibrary(kind, active));
  assert.throws(() => backup.validateBackupLibrary(kind, { ...active, items: [{ ...active.items[0], note: '' }] }),
    error => error.code === 'BACKUP_INVALID', 'Even an empty retired field is outside the current format');
});
