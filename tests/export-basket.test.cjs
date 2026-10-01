const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const model = import('../src/features/export/ui/export-basket.js');

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const sources = () => ({ favorites: { items: { a: {}, b: {}, c: {} } },
  bookmarks: { items: { 'a::m1': { conversationId: 'a' }, 'a::m2': { conversationId: 'a' } } },
  searchCandidates: new Map([['a', freeze({ accountKey: 'catalog', title: 'Search A', createdAt: null, updatedAt: null })],
    ['d', freeze({ accountKey: 'catalog', title: 'Search D', createdAt: null, updatedAt: null })]]) });
const draft = (source, ids) => freeze({ source, conversationIds: source === 'bookmarks' ? [] : ids,
  bookmarkIds: source === 'bookmarks' ? ids : [] });

test('empty basket and draft are fresh current-state values, not shared reset objects', async () => {
  const m = await model, basket = m.emptyBasket(), next = m.emptyBasket();
  basket.bookmarkIds.push('a::m1'); basket.conversations.push({ conversationId: 'a', sources: ['favorites'] });
  assert.deepEqual(next, { conversations: [], bookmarkIds: [] });
  assert.equal(m.count(basket), 2);
  const first = m.emptyDraft('search'); first.conversationIds.push('a');
  assert.deepEqual(m.emptyDraft('search'), { source: 'search', conversationIds: [], bookmarkIds: [] });
  assert.equal(m.emptyDraft().source, null);
});

test('draft toggle and page selection do not mutate input or lose other-page choices', async () => {
  const m = await model, s = sources(), empty = freeze(m.emptyBasket());
  const original = draft('favorites', ['a']);
  const toggled = m.toggleDraft(original, 'b');
  assert.deepEqual(toggled.conversationIds, ['a', 'b']);
  assert.deepEqual(m.toggleDraft(freeze(toggled), 'a').conversationIds, ['b']);
  const selected = m.selectDraftRange(empty, original, ['b', 'c', 'b', '', null], s.searchCandidates);
  assert.deepEqual(selected.conversationIds, ['a', 'b', 'c']);
  assert.deepEqual(m.selectDraftRange(empty, freeze(selected), ['b', 'c'], s.searchCandidates).conversationIds, ['a']);
  assert.deepEqual(original.conversationIds, ['a']);
  assert.deepEqual(m.selectDraftRange(empty, original, null, s.searchCandidates), original);
});

test('range selection excludes only the same submitted source and unregistered search candidates', async () => {
  const m = await model, s = sources();
  const basket = freeze({ conversations: [{ conversationId: 'a', sources: ['favorites'] }], bookmarkIds: ['a::m1'] });
  assert.deepEqual(m.selectDraftRange(basket, draft('favorites', []), ['a', 'b'], s.searchCandidates).conversationIds, ['b']);
  assert.deepEqual(m.selectDraftRange(basket, draft('search', []), ['a', 'd', 'unknown'], s.searchCandidates).conversationIds, ['a', 'd']);
  assert.deepEqual(m.selectDraftRange(basket, draft('bookmarks', []), ['a::m1', 'a::m2'], s.searchCandidates).bookmarkIds, ['a::m2']);
  const merged = m.submitDraft(basket, draft('search', ['a']), s).basket;
  assert.equal(m.searchCandidateSelectable(merged, s.searchCandidates, 'a'), false);
  assert.equal(m.searchCandidateSelectable(merged, s.searchCandidates, 'unknown'), false);
});

test('submitting merges source provenance without duplicate conversations or mutations in either source order', async () => {
  const m = await model, s = sources();
  for (const [first, second] of [['favorites', 'search'], ['search', 'favorites']]) {
    const initial = freeze(m.submitDraft(freeze(m.emptyBasket()), draft(first, ['a']), s).basket);
    const before = structuredClone(initial);
    const result = m.submitDraft(initial, draft(second, ['a']), s);
    assert.equal(result.added, 0); assert.equal(result.sourceUpdated, 1);
    assert.deepEqual(result.addedConversationIds, []);
    assert.deepEqual(result.basket.conversations[0].sources, [first, second]);
    assert.equal(result.basket.conversations[0].searchMetadata.title, 'Search A');
    assert.deepEqual(initial, before);
    const duplicate = m.submitDraft(freeze(result.basket), draft(second, ['a', 'a']), s);
    assert.equal(duplicate.added, 0); assert.equal(duplicate.sourceUpdated, 0);
    assert.equal(m.count(duplicate.basket), 1);
  }
});

test('submission copies candidate metadata and validates membership at commit, not draft time', async () => {
  const m = await model, s = sources();
  const candidate = { accountKey: 'catalog', title: 'Original', createdAt: null, updatedAt: null };
  s.searchCandidates.set('a', candidate);
  const result = m.submitDraft(freeze(m.emptyBasket()), draft('search', ['a', 'deleted']), s);
  candidate.title = 'Changed after submission'; s.searchCandidates.clear();
  assert.equal(result.basket.conversations[0].searchMetadata.title, 'Original');
  assert.deepEqual(result.addedConversationIds, ['a']);
  const missing = { favorites: { items: {} }, bookmarks: { items: {} }, searchCandidates: new Map() };
  for (const source of ['favorites', 'bookmarks', 'search']) {
    const rejected = m.submitDraft(freeze(m.emptyBasket()), draft(source, ['gone']), missing);
    assert.equal(rejected.added, 0); assert.equal(m.count(rejected.basket), 0);
  }
});

test('bookmark membership is independent of whole-conversation membership and produces exact highlight IDs', async () => {
  const m = await model, s = sources();
  const initial = freeze(m.submitDraft(m.emptyBasket(), draft('favorites', ['a']), s).basket);
  const result = m.submitDraft(initial, draft('bookmarks', ['a::m2', 'a::m1', 'a::m2']), s);
  assert.equal(m.count(result.basket), 3);
  assert.equal(result.added, 2); assert.equal(result.sourceUpdated, 0);
  assert.deepEqual(result.addedBookmarkIds, ['a::m2', 'a::m1']);
  assert.deepEqual(result.addedConversationIds, []);
  assert.equal(initial.bookmarkIds.length, 0);
});

test('reconciliation distinguishes unavailable repositories from proven deletions and retains alternate sources', async () => {
  const m = await model, basket = freeze({ conversations: [
    { conversationId: 'a', sources: ['favorites', 'search'], searchMetadata: { accountKey: 'catalog', title: 'A' } },
    { conversationId: 'b', sources: ['favorites'] },
  ], bookmarkIds: ['a::m1', 'a::m2'] });
  const favoritesDraft = draft('favorites', ['a', 'b']);
  assert.deepEqual(m.reconcile(basket, favoritesDraft, { favorites: null, bookmarks: null }), { basket, draft: favoritesDraft });
  const reconciled = m.reconcile(basket, favoritesDraft, { favorites: { items: {} }, bookmarks: { items: { 'a::m1': {} } } });
  assert.deepEqual(reconciled.basket.conversations.map(record => record.conversationId), ['a']);
  assert.deepEqual(reconciled.basket.conversations[0].sources, ['search']);
  assert.equal(reconciled.basket.conversations[0].searchMetadata.title, 'A');
  assert.deepEqual(reconciled.basket.bookmarkIds, ['a::m1']);
  assert.deepEqual(reconciled.draft.conversationIds, []);
  const searchDraft = draft('search', ['a', 'd']);
  assert.deepEqual(m.reconcile(basket, searchDraft, { favorites: { items: {} }, bookmarks: null }).draft, searchDraft);
  assert.deepEqual(m.reconcile(basket, draft('bookmarks', ['a::m1', 'a::m2']), {
    favorites: null, bookmarks: { items: { 'a::m2': {} } },
  }).draft.bookmarkIds, ['a::m2']);
});

test('removal and clear are independent immutable replacements, including grouped bookmark removal', async () => {
  const m = await model, basket = freeze({ conversations: [{ conversationId: 'a', sources: ['favorites', 'search'] }],
    bookmarkIds: ['a::m1', 'a::m2', 'b::m1'] });
  const conversationsRemoved = m.removeConversation(basket, 'a');
  assert.equal(conversationsRemoved.conversations.length, 0);
  assert.deepEqual(conversationsRemoved.bookmarkIds, basket.bookmarkIds);
  const groupRemoved = m.removeBookmarks(basket, new Set(['a::m1', 'a::m2']));
  assert.deepEqual(groupRemoved.bookmarkIds, ['b::m1']);
  assert.deepEqual(groupRemoved.conversations, basket.conversations);
  assert.deepEqual(m.emptyBasket(), { conversations: [], bookmarkIds: [] });
  assert.equal(m.count(basket), 4, 'neither removal nor reset mutates the prior basket');
});

test('pure basket values have one selection writer and document requests have their own invalidation owner', () => {
  const basket = fs.readFileSync('src/features/export/ui/export-basket.js', 'utf8');
  const selection = fs.readFileSync('src/features/export/ui/export-selection.js', 'utf8');
  const context = fs.readFileSync('src/features/export/ui/export-context-controller.js', 'utf8');
  const view = fs.readFileSync('src/features/export/ui/export-view.js', 'utf8');
  assert.doesNotMatch(basket, /\b(?:chrome|globalThis|document|fetch|setTimeout|addEventListener|requestGeneration|batchRequestGeneration|exportGeneration)\b/);
  assert.match(selection, /import \* as basketModel from "\.\/export-basket\.js"/);
  assert.doesNotMatch(selection, /basket\.(?:conversations|bookmarkIds)\s*=|basket\.[^;\n]*\.push\(|draft\[[^\]]+\]\s*=/);
  assert.doesNotMatch(view, /import \* as basketModel|state\.basket\s*=|state\.draft\s*=/, 'the view cannot become a second basket writer');
  assert.match(context, /function invalidateBatch\(/);
  assert.match(context, /function retireBatch\(/);
  assert.match(context, /batchEpoch\+\+/);
  assert.doesNotMatch(view, /data-export-clear/, 'do not retain an orphan handler for a nonexistent clear button');
});
