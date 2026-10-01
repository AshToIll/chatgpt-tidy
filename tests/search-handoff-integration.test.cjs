const assert = require('node:assert/strict');
const test = require('node:test');
const { createHandoffHarness, SOURCE } = require('./helpers/bookmark-handoff-harness.cjs');

// Integration scope: real worker, MAIN adapter, identity and panel listeners.
// The synthetic router proves the handoff contract, NOT ChatGPT's live pixel
// highlight or selected sidebar styling; those require the live-site check.
const routes = h => h.calls.filter(call => call.type === 'native-router');
const locates = h => h.calls.filter(call => call.type === 'snapshot.message-locate');
const receipts = h => h.broadcasts.filter(event => event.type === 'navigation.result');
const reloads = h => h.calls.filter(call => call.type === 'tabs.update');
const scrolls = h => h.calls.filter(call => call.type === 'physical-scroll');

async function nativeHarness(t) {
  const h = await createHandoffHarness(t);
  h.page().nativeRouter = true;
  return h;
}

test('keyword handoff gives the official router its exact search context without a second presentation owner', async t => {
  const h = await nativeHarness(t);
  const opened = await h.searchClick();
  assert.equal(opened.navigated, true);
  assert.equal(opened.presentationOwner, 'native');
  assert.equal(Object.hasOwn(opened, 'located'), false);
  assert.equal(Object.hasOwn(opened, 'highlighted'), false);
  assert.equal(routes(h).length, 1);
  const url = new URL(routes(h)[0].pathname, 'https://chatgpt.com');
  assert.equal(url.pathname, '/c/destination');
  assert.equal(url.searchParams.get('src'), 'history_search');
  assert.equal(url.searchParams.get('messageId'), 'message-1');
  assert.equal(url.searchParams.get('historySearchQuery'), 'needle');
  assert.equal(h.page().id, SOURCE);
  assert.equal(h.panel.library.isCurrent(h.initialLease), true);
  await h.advance(120000);
  assert.equal(locates(h).length, 0);
  assert.equal(receipts(h).length, 0);
  assert.equal(scrolls(h).length, 0);
  assert.equal(reloads(h).length, 0);
  assert.equal(h.toasts.length, 0);
});

test('same-conversation message and query changes remain distinct official search targets', async t => {
  const h = await nativeHarness(t);
  const first = await h.searchClick();
  h.page().setConversation('destination');
  h.routeEvent(h.page().location.href);
  const second = await h.searchClick({ messageId: 'message-2', resultId: 'second' });
  const third = await h.searchClick({ messageId: 'message-2', query: 'other term', resultId: 'third' });
  assert.notEqual(first.navigationIntentId, second.navigationIntentId);
  assert.notEqual(second.navigationIntentId, third.navigationIntentId);
  assert.deepEqual(routes(h).map(call => new URL(call.pathname, 'https://chatgpt.com').searchParams.get('messageId')),
    ['message-1', 'message-2', 'message-2']);
  assert.deepEqual(routes(h).map(call => new URL(call.pathname, 'https://chatgpt.com').searchParams.get('historySearchQuery')),
    ['needle', 'needle', 'other term']);
  assert.equal(locates(h).length, 0); assert.equal(reloads(h).length, 0);
});

test('a title-only keyword result preserves official search context without inventing a message', async t => {
  const h = await nativeHarness(t);
  const opened = await h.searchClick({ messageId: null, resultId: 'title-only' });
  assert.equal(opened.presentationOwner, 'native');
  const url = new URL(routes(h)[0].pathname, 'https://chatgpt.com');
  assert.equal(url.searchParams.get('src'), 'history_search');
  assert.equal(url.searchParams.get('historySearchQuery'), 'needle');
  assert.equal(url.searchParams.has('messageId'), false);
  assert.equal(locates(h).length, 0); assert.equal(scrolls(h).length, 0);
});

test('official URL parameter cleanup cannot re-start a Tidy locator after native handoff', async t => {
  const h = await nativeHarness(t);
  const opened = await h.searchClick();
  h.page().setConversation('destination');
  h.routeEvent('https://chatgpt.com/c/destination');
  h.snapshot(); await h.advance(35000);
  assert.equal(h.currentIntent().id, opened.navigationIntentId);
  assert.equal(routes(h).length, 1);
  assert.equal(locates(h).length, 0); assert.equal(receipts(h).length, 0);
  assert.equal(scrolls(h).length, 0); assert.equal(reloads(h).length, 0);
});

test('date navigation clears previous search parameters and settles latest in the same document', async t => {
  const h = await nativeHarness(t);
  await h.searchClick();
  h.page().setConversation('destination'); h.routeEvent(h.page().location.href); h.snapshot();
  const opened = await h.searchClick({ navigationKind: 'conversation', messageId: null, query: '', resultId: 'date' });
  assert.equal(opened.pending, true);
  assert.equal(routes(h).at(-1).pathname, '/c/destination');
  await h.advance(1800);
  assert.equal(receipts(h).length, 1);
  assert.equal(receipts(h)[0].payload.placement, 'latest');
  assert.equal(receipts(h)[0].payload.located, true);
  assert.equal(reloads(h).length, 0);
  assert.equal(h.page().id, SOURCE);
});

test('date target absence reports one bounded failure without full-page fallback', async t => {
  const h = await nativeHarness(t);
  await h.searchClick({ navigationKind: 'conversation', messageId: null, query: '', resultId: 'date' });
  h.page().setConversation('destination'); h.routeEvent('https://chatgpt.com/c/destination');
  h.snapshot({ mounted: false }); await h.advance(35000);
  assert.equal(receipts(h).length, 1);
  assert.equal(receipts(h)[0].payload.placement, 'latest');
  assert.equal(receipts(h)[0].payload.located, false);
  assert.equal(routes(h).length, 1); assert.equal(reloads(h).length, 0);
});

for (const navigationKind of ['keyword', 'conversation']) {
  test(`${navigationKind} fails explicitly when the native router is unavailable, without reloading`, async t => {
    const h = await createHandoffHarness(t);
    await assert.rejects(h.searchClick({ navigationKind,
      ...(navigationKind === 'conversation' ? { messageId: null, query: '' } : {}) }), { code: 'ADAPTER_UNAVAILABLE' });
    await h.advance(35000);
    assert.equal(reloads(h).length, 0); assert.equal(locates(h).length, 0);
    assert.equal(receipts(h).length, 0);
  });
}

test('a superseded keyword click cannot dispatch after its bound-tab read returns late', async t => {
  const h = await nativeHarness(t);
  h.pauseBeforePhysical();
  const old = h.searchClick({ resultId: 'old' });
  const rejected = assert.rejects(old, { code: 'CONTEXT_MISMATCH' });
  await h.flush(); assert.ok(h.paused());
  await h.searchClick({ resultId: 'new', messageId: 'message-2' });
  h.release(); await rejected;
  assert.equal(routes(h).length, 1);
  assert.equal(new URL(routes(h)[0].pathname, 'https://chatgpt.com').searchParams.get('messageId'), 'message-2');
  assert.equal(locates(h).length, 0); assert.equal(reloads(h).length, 0);
});
