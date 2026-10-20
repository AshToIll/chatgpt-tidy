const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { installPageSession } = require('./helpers/page-session.cjs');
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
const plain = value => JSON.parse(JSON.stringify(value));
const OWNER = '["user-a","personal"]';
const change = (id = 'one', status = 'deleted', startedAt = 100) => ({ ownerAccountKey: OWNER,
  catalogAccountKey: 'catalog-a', conversationId: id, status, startedAt, epoch: 1 });
// Sanitized contract read from the user's Edge Network panel on 2026-10-19.
// The real request is DELETE /backend-api/conversation/id/{id}, with no payload.
const deletionReply = () => new Response('{"success":true}', { headers: { 'content-type': 'application/json' } });

async function page() {
  const changes = [], calls = [], events = new Map(); let clock = 0;
  let session = { user: { id: 'user-a' }, activeAccountId: 'catalog-a', accessToken: 'private-token' };
  let reply = () => Promise.resolve(deletionReply());
  const context = vm.createContext({ URL, Request, Response, Headers, document: { cookie: '' },
    location: new URL('https://chatgpt.com/c/owner'), performance: { timeOrigin: 1000, now: () => ++clock },
    addEventListener: (type, fn) => events.set(type, fn),
    fetch(...args) { calls.push(args); return args[0] === '/api/auth/session'
      ? Promise.resolve(new Response(JSON.stringify(session))) : reply(...args); },
  });
  installPageSession(context);
  vm.runInContext(fs.readFileSync('src/platform/chatgpt/api.js', 'utf8'), context);
  const api = context.TidyChatgptApi;
  api.onConversationAvailabilityChanged(value => changes.push(plain(value)));
  await api.readLibraryAccount(); await settle();
  return { api, context, events, calls, changes, reply: value => { reply = value; },
    delete: (id = 'one') => context.fetch('/backend-api/conversation/id/' + id, { method: 'DELETE' }),
    switchUser: async () => { session = { ...session, user: { id: 'other' } }; await api.loadSession({ refresh: true }); },
  };
}

test('native confirmed deletion is asynchronous, preserves request/response identity, and does no extra HTTP', async () => {
  const h = await page(); let resolve;
  const pending = new Promise(done => { resolve = done; }), response = deletionReply();
  h.reply(() => pending); const result = h.delete();
  assert.equal(result, pending); assert.equal(h.changes.length, 0);
  resolve(response); assert.equal(await result, response); await settle();
  assert.deepEqual(h.changes, [{ ...change(), startedAt: 1001 }]);
  assert.equal(h.calls.length, 2); assert.equal(await response.text(), '{"success":true}');
  assert.doesNotMatch(JSON.stringify(h.changes), /private/);
});

test('Request and URL inputs observe the captured DELETE contract without consuming the request', async () => {
  const h = await page();
  const request = new Request('https://chatgpt.com/backend-api/conversation/id/request-id', {
    method: 'DELETE',
  });
  await h.context.fetch(request); await settle();
  assert.equal(request.bodyUsed, false); assert.equal(h.changes[0].conversationId, 'request-id');
  await h.context.fetch(new URL('https://chatgpt.com/backend-api/conversation/id/url-id'), { method: 'DELETE' });
  await settle(); assert.equal(h.changes[1].conversationId, 'url-id');
});

test('old PATCH guesses, archive, wrong endpoints and failed deletes are never deletion evidence', async () => {
  const h = await page();
  for (const body of [{ is_archived: true }, { is_visible: true }, { is_visible: false }, {}, null]) {
    await h.context.fetch('/backend-api/conversation/one', { method: 'PATCH', body: JSON.stringify(body) });
  }
  for (const url of ['https://example.com/backend-api/conversation/id/one', '/backend-api/conversations',
    '/backend-api/conversations/id/one', '/backend-api/conversation/one',
    '/backend-api/conversation/id/one?x=1', '/backend-api/conversation/id/one#hash',
    '/backend-api/conversation/id/one/rename']) {
    await h.context.fetch(url, { method: 'DELETE' });
  }
  for (const method of ['PATCH', 'POST', 'PUT']) {
    await h.context.fetch('/backend-api/conversation/id/one', { method });
  }
  for (const status of [400, 401, 403, 404, 409, 429, 500]) { h.reply(() => Promise.resolve(new Response('{}', { status }))); await h.delete(); }
  const error = new Error('network'); h.reply(() => Promise.reject(error)); await assert.rejects(h.delete(), e => e === error);
  h.reply(() => { throw error; }); assert.throws(h.delete, e => e === error);
  await settle(); assert.deepEqual(h.changes, []);
});

test('HTTP success without the observed explicit JSON success:true cannot erase saved data', async () => {
  const h = await page();
  for (const body of ['{}', '{"success":false}', '{"success":"true"}', 'true', 'null', 'broken']) {
    h.reply(() => Promise.resolve(new Response(body, { headers: { 'content-type': 'application/json' } })));
    await h.delete(); await settle();
  }
  for (const response of [new Response('{"success":true}'), new Response(null, { status: 204 }),
    Object.defineProperty(deletionReply(), 'redirected', { value: true })]) {
    h.reply(() => Promise.resolve(response)); await h.delete(); await settle();
  }
  assert.deepEqual(h.changes, []);
});

test('detail failures distinguish unavailable from deletion; authentication/rate/network failures leave records alone', async () => {
  const h = await page();
  for (const status of [401, 403, 429, 500]) {
    h.reply(() => Promise.resolve(new Response('{}', { status })));
    await h.context.fetch('/backend-api/conversation/one');
  }
  await settle(); assert.equal(h.changes.length, 0);
  for (const status of [404, 410]) {
    h.reply(() => Promise.resolve(new Response('{}', { status })));
    await h.context.fetch('/backend-api/conversations/one?include_has_versions=true&num_turns=10'); await settle();
    assert.equal(h.changes.at(-1).status, 'unavailable');
  }
  h.reply(() => Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json; charset=utf-8' } })));
  await h.context.fetch('/backend-api/conversation/one'); await settle(); assert.equal(h.changes.at(-1).status, 'available');
});

test('a late missing-detail response cannot undo a newer successful read or a newer failed attempt', async () => {
  for (const status of [200, 500]) {
    const h = await page(), pending = [];
    h.reply(() => new Promise(resolve => pending.push(resolve)));
    const old = h.context.fetch('/backend-api/conversation/one');
    const next = h.context.fetch('/backend-api/conversations/one?num_turns=10');
    pending[1](new Response('{}', { status, headers: { 'content-type': 'application/json' } })); await next; await settle();
    pending[0](new Response('{}', { status: 404 })); await old; await settle();
    assert.ok(h.changes.every(value => value.status === 'available'));
  }
});

for (const boundary of ['user', 'workspace', 'pagehide', 'dispose']) test(`late delete cannot cross ${boundary}`, async () => {
  const h = await page(); let resolve;
  h.reply(() => new Promise(done => { resolve = done; })); const pending = h.delete();
  if (boundary === 'user') await h.switchUser();
  else if (boundary === 'workspace') { h.context.document.cookie = '_account=team'; h.api.checkLibraryIdentity(); }
  else if (boundary === 'pagehide') h.events.get('pagehide')();
  else h.context.TidyPageSession.stop();
  resolve(deletionReply()); await pending; await settle(); assert.deepEqual(h.changes, []);
});

async function storage(t) {
  globalThis.IDBKeyRange = IDBKeyRange;
  const { openTidyDatabase } = await import('../src/platform/storage/database.js');
  const { createConversationAvailabilityRepository } = await import('../src/platform/storage/conversation-availability.js');
  const { createConversationCatalogRepository } = await import('../src/platform/catalog/storage/conversation-catalog.js');
  const { createFavoritesRepository } = await import('../src/features/favorites/storage/favorites.js');
  const { createBookmarksRepository } = await import('../src/features/bookmarks/storage/bookmarks.js');
  const db = await openTidyDatabase(new IDBFactory()); t.after(() => db.close());
  const options = { openDatabase: async () => db };
  const lifecycle = createConversationAvailabilityRepository(options), catalog = createConversationCatalogRepository(options);
  const favorites = createFavoritesRepository(options), bookmarks = createBookmarksRepository(options);
  const page = { conversations: ['one', 'two'].map(conversationId => ({ conversationId, title: conversationId, directoryBounds: { createdAt: 1 } })) };
  const state = { catalogVersion: 2, generation: 1, revision: 1, snapshotStartedAt: 1 };
  for (const account of ['catalog-a', 'catalog-b']) await catalog.commitPage(account, page, state);
  for (const account of [OWNER, 'other-owner']) {
    await favorites.transact(account, current => ({ ...current, revision: 1, items: { one: { conversationId: 'one', routePath: '/c/one', title: 'Saved', groupId: 'study' } } }));
    await bookmarks.transact(account, current => ({ ...current, revision: 1, items: { 'one::m': {
      bookmarkId: 'one::m', conversationId: 'one', messageId: 'm', routePath: '/c/one', excerpt: 'Keep this excerpt', groupId: 'bookmark-quote',
    } } }));
  }
  return { db, lifecycle, catalog, favorites, bookmarks, page, state };
}

test('unconfirmed unavailability preserves saved content and account isolation while hiding catalog candidates', async t => {
  const h = await storage(t), { favorites, bookmarks, catalog, lifecycle } = h;
  const before = await favorites.get(OWNER), beforeBookmarks = await bookmarks.get(OWNER);
  const other = await favorites.get('other-owner');
  const receipt = await lifecycle.accept(change('one', 'unavailable'));
  assert.deepEqual(receipt.libraries, { favorites: { accountKey: OWNER, revision: 2 }, bookmarks: { accountKey: OWNER, revision: 2 } });
  const after = await favorites.get(OWNER), afterBookmarks = await bookmarks.get(OWNER);
  assert.deepEqual(after.items, before.items); assert.deepEqual(after.groups, before.groups);
  assert.deepEqual(afterBookmarks.items, beforeBookmarks.items); assert.equal(afterBookmarks.items['one::m'].excerpt, 'Keep this excerpt');
  assert.deepEqual(after.conversationAvailability, { one: 'unavailable' });
  assert.deepEqual(afterBookmarks.conversationAvailability, { one: 'unavailable' });
  assert.deepEqual(await favorites.get('other-owner'), other);
  assert.equal(await catalog.getRow('catalog-a', 'one'), null);
  assert.deepEqual((await catalog.getSnapshot('catalog-a')).rows.map(x => x.conversationId), ['two']);
  assert.equal((await catalog.getSnapshot('catalog-b')).rows.length, 2);
  assert.deepEqual((await catalog.getSnapshot('catalog-a')).state.accountKey, 'catalog-a');
  assert.equal(await lifecycle.accept(change('one', 'unavailable')), null, 'duplicate status is a no-op');
  const moved = await favorites.transact(OWNER, current => ({ ...current, revision: current.revision + 1, view: { ...current.view, groupId: 'all' } }));
  assert.equal(moved.conversationAvailability.one, 'unavailable', 'normal writes keep the status projection');
});

test('confirmed deletion physically removes only that conversation and every associated bookmark, preserving groups', async t => {
  const h = await storage(t);
  await h.favorites.transact(OWNER, current => ({ ...current, items: { ...current.items,
    two: { ...current.items.one, conversationId: 'two', routePath: '/c/two' },
  } }));
  await h.bookmarks.transact(OWNER, current => ({ ...current, items: { ...current.items,
    'one::m2': { ...current.items['one::m'], bookmarkId: 'one::m2', messageId: 'm2' },
    'two::m': { ...current.items['one::m'], conversationId: 'two', bookmarkId: 'two::m', routePath: '/c/two' },
  } }));
  const before = await h.favorites.get(OWNER), beforeBookmarks = await h.bookmarks.get(OWNER);
  const otherFavorites = await h.favorites.get('other-owner'), otherBookmarks = await h.bookmarks.get('other-owner');
  const receipt = await h.lifecycle.accept(change());
  assert.deepEqual(receipt.libraries, { favorites: { accountKey: OWNER, revision: 2 }, bookmarks: { accountKey: OWNER, revision: 2 } });
  const after = await h.favorites.get(OWNER), afterBookmarks = await h.bookmarks.get(OWNER);
  assert.deepEqual(Object.keys(after.items), ['two']); assert.deepEqual(Object.keys(afterBookmarks.items), ['two::m']);
  assert.deepEqual(after.groups, before.groups); assert.deepEqual(afterBookmarks.groups, beforeBookmarks.groups);
  assert.deepEqual(after.items.two, before.items.two); assert.deepEqual(afterBookmarks.items['two::m'], beforeBookmarks.items['two::m']);
  assert.equal(after.conversationAvailability, undefined); assert.equal(afterBookmarks.conversationAvailability, undefined);
  assert.deepEqual(await h.favorites.get('other-owner'), otherFavorites);
  assert.deepEqual(await h.bookmarks.get('other-owner'), otherBookmarks);
  const raw = h.db.transaction(['favorites', 'bookmarks'], 'readonly');
  const request = request => new Promise(resolve => { request.onsuccess = () => resolve(request.result); });
  assert.deepEqual(await Promise.all([
    request(raw.objectStore('favorites').get([OWNER, 'one'])),
    request(raw.objectStore('bookmarks').get([OWNER, 'one::m'])),
    request(raw.objectStore('bookmarks').get([OWNER, 'one::m2'])),
  ]), [undefined, undefined, undefined], 'rows are deleted from storage, not merely hidden');
  assert.equal(await h.lifecycle.accept(change()), null);
  assert.deepEqual(await h.favorites.get(OWNER), after);
});

test('late scans and title receipts cannot resurrect tombstones, including a not-yet-enumerated conversation', async t => {
  const h = await storage(t);
  await h.lifecycle.accept(change()); await h.lifecycle.accept(change('not-yet-seen'));
  for (const snapshotStartedAt of [1, 1000]) {
    await h.catalog.commitPage('catalog-a', { conversations: [...h.page.conversations,
      { conversationId: 'not-yet-seen', title: 'Late' }] }, { ...h.state, snapshotStartedAt });
  }
  await h.catalog.acceptTitles('catalog-a', [{ conversationId: 'one', title: 'Accepted' }]);
  await h.catalog.observeTitles('catalog-a', [{ conversationId: 'one', title: 'Verified', updatedAt: new Date().toISOString() }]);
  assert.equal(await h.catalog.acceptTitleChange('catalog-a', { conversationId: 'one', title: 'Native', startedAt: 200 }), false);
  assert.deepEqual((await h.catalog.getSnapshot('catalog-a')).rows.map(x => x.conversationId), ['two']);
  assert.equal(await h.lifecycle.accept(change('one', 'available', 200)), null);
});

test('unavailable can recover from a newer detail response, never an older read or partial catalog page', async t => {
  const h = await storage(t);
  await h.lifecycle.accept(change('one', 'unavailable', 100));
  assert.equal(await h.lifecycle.accept(change('one', 'available', 90)), null);
  await h.catalog.commitPage('catalog-a', h.page, h.state);
  assert.equal(await h.catalog.getRow('catalog-a', 'one'), null);
  await h.lifecycle.accept(change('one', 'available', 200));
  assert.ok(await h.catalog.getRow('catalog-a', 'one'));
  assert.equal((await h.favorites.get(OWNER)).conversationAvailability, undefined);
  assert.equal(await h.lifecycle.accept(change('one', 'unavailable', 150)), null);
  assert.equal(await h.lifecycle.accept(change('unknown', 'available', 200)), null, 'successful ordinary reads create no cache');
});

test('identity is checked inside the transaction and injected storage failure rolls back the whole invalidation', async t => {
  const h = await storage(t), before = await h.favorites.get(OWNER), beforeBookmarks = await h.bookmarks.get(OWNER);
  assert.equal(await h.lifecycle.accept(change(), () => false), null);
  const original = h.db.transaction.bind(h.db);
  h.db.transaction = (...args) => {
    const tx = original(...args);
    if (args[1] === 'readwrite') {
      const objectStore = tx.objectStore.bind(tx);
      tx.objectStore = name => { const store = objectStore(name); if (name === 'conversation-index') store.put = () => { throw Error('injected'); }; return store; };
    }
    return tx;
  };
  await assert.rejects(h.lifecycle.accept(change())); h.db.transaction = original;
  assert.deepEqual(await h.favorites.get(OWNER), before);
  assert.deepEqual(await h.bookmarks.get(OWNER), beforeBookmarks); assert.ok(await h.catalog.getRow('catalog-a', 'one'));
});

test('observed native DELETE acknowledgment flows through the worker into local removal and revision notifications', async t => {
  const h = await storage(t), native = await page();
  const { createConversationAvailabilityObserver } = await import('../src/app/background/conversation-availability-observer.js');
  const sender = { tab: { id: 7 }, frameId: 0, documentId: 'doc', documentLifecycle: 'active', url: 'https://chatgpt.com/' };
  const events = [], pending = [];
  const observer = createConversationAvailabilityObserver({
    chrome: { runtime: { sendMessage: async event => events.push(event) } },
    identity: { acceptEvent: async () => {}, peek: () => ({ accountKey: OWNER, epoch: 1, documentId: 'doc', phase: 'ready' }) },
    repository: h.lifecycle, broadcast: async () => {},
  });
  native.api.onConversationAvailabilityChanged(event => pending.push(observer.accept(event, sender)));
  await native.delete(); await settle(); await Promise.all(pending);
  assert.equal(pending.length, 1); assert.equal(events.length, 3);
  assert.equal((await h.favorites.get(OWNER)).items.one, undefined);
  assert.equal((await h.bookmarks.get(OWNER)).items['one::m'], undefined);
  assert.equal(await h.catalog.getRow('catalog-a', 'one'), null);
  assert.equal(native.calls.length, 2, 'only the original auth read and original website DELETE were sent');
});

test('worker accepts only exact live document ownership and broadcasts locator/revision tokens, not private data', async () => {
  const { createConversationAvailabilityObserver } = await import('../src/app/background/conversation-availability-observer.js');
  const current = { accountKey: OWNER, epoch: 1, documentId: 'doc', phase: 'ready' };
  const sender = { tab: { id: 7 }, frameId: 0, documentId: 'doc', documentLifecycle: 'active', url: 'https://chatgpt.com/c/one' };
  const messages = [], broadcasts = [], writes = [];
  let revoke = false;
  const observer = createConversationAvailabilityObserver({
    chrome: { runtime: { sendMessage: async value => messages.push(value) } },
    identity: { acceptEvent: async () => {}, peek: () => current },
    repository: { accept: async (value, isCurrent) => {
      writes.push(value); assert.equal(isCurrent(), true);
      if (revoke) { current.epoch++; assert.equal(isCurrent(), false); return null; }
      return { accountKey: 'catalog-a', conversationId: 'one', libraries: {
        favorites: { accountKey: OWNER, revision: 2 }, bookmarks: { accountKey: OWNER, revision: 3 },
      } };
    } }, broadcast: async event => broadcasts.push(event),
  });
  for (const from of [null, { ...sender, frameId: 1 }, { ...sender, documentId: 'other' },
    { ...sender, documentLifecycle: 'cached' }, { ...sender, url: 'https://example.com' }]) {
    assert.equal(await observer.accept(change(), from), false);
  }
  assert.equal(writes.length, 0);
  assert.equal(await observer.accept({ ...change(), title: 'must-not-leak' }, sender), true);
  assert.equal(messages.length, 3); assert.equal(broadcasts.length, 2);
  assert.doesNotMatch(JSON.stringify(messages), /must-not-leak/);
  assert.deepEqual(messages[0].payload, { accountKey: 'catalog-a', conversationId: 'one' });
  revoke = true; assert.equal(await observer.accept(change(), sender), false); assert.equal(messages.length, 3);
});
