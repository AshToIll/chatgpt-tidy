const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

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
    assert.doesNotMatch(source, /NOTE_UPDATE|note-update|updateFavoriteNote|updateBookmarkNote/, file);
    if (file.startsWith('src/app/sidepanel/')) assert.doesNotMatch(source, /searchActionEpoch/, file);
  }
});

test('saved bookmark notes remain searchable without an editing API', async () => {
  const bookmarks = await import('../src/features/bookmarks/storage/bookmarks-domain.js');
  const saved = bookmarks.normalizeBookmarksState({ ...bookmarks.createEmptyBookmarksState(), items: {
    'saved::message': { bookmarkId: 'saved::message', conversationId: 'saved', messageId: 'message',
      routePath: '/c/saved', excerpt: 'Unrelated excerpt', conversationTitle: 'Unrelated title', note: '保留的备注 unique-note' },
  } });
  assert.equal(bookmarks.selectBookmarks(saved, { groupId: 'all', query: 'unique-note' }).length, 1);
  assert.equal(bookmarks.selectBookmarks(saved, { groupId: 'all', query: 'missing-note' }).length, 0);
});
