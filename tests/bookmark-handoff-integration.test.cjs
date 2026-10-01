const assert = require('node:assert/strict');
const test = require('node:test');
const { createHandoffHarness, OWNER, OTHER, SOURCE, DESTINATION } = require('./helpers/bookmark-handoff-harness.cjs');
const requests = h => h.calls.filter(c => c.lane === 'worker-page' && c.type === 'snapshot.message-locate');
const scrolls = h => h.calls.filter(c => c.type === 'physical-scroll');
const results = h => h.broadcasts.filter(c => c.type === 'navigation.result');

async function enter(h, { ready = true, strip = true } = {}) {
  await h.click();
  const ticket = h.currentIntent();
  const urls = h.calls.filter(c => c.type === 'tabs.update');
  assert.equal(urls.length, 1);
  const url = new URL(urls[0].url);
  assert.equal(url.searchParams.get('messageId'), 'message-1');
  assert.equal(url.searchParams.has('historySearchQuery'), false, 'A bookmark never fabricates search text');
  h.page().hide();
  h.commit();
  if (strip) h.routeEvent('https://chatgpt.com/c/destination');
  assert.equal(requests(h).length, 1, 'No destination command until its owner is confirmed');
  if (ready) await h.identity('ready', 1);
  assert.equal(h.currentIntent().id, ticket.id);
  assert.equal(h.currentIntent().deadlineAt, ticket.deadlineAt);
  return ticket;
}

function oneLanding(h) {
  assert.equal(requests(h).length, 2, 'Source probe and one destination execution; no panel LOCATE pump');
  assert.equal(scrolls(h).length, 1);
  assert.equal(results(h).length, 1); assert.equal(results(h)[0].payload.located, true);
  assert.equal(h.toasts.filter(t => t.message === 'bookmarkLocated').length, 1);
  assert.equal(h.panel.library.isCurrent(h.initialLease), false, 'The old data lease remains revoked');
  const request = requests(h)[1];
  assert.equal(request.documentId, DESTINATION);
  assert.equal(request.payload.navigationControl.ownerAccountKey, OWNER);
  assert.equal(request.payload.query, '');
  assert.equal(Object.hasOwn(request.payload, 'expectedLibraryIdentity'), false);
  assert.equal(h.calls.some(c => c.type === 'bookmarks.locate'), false);
}

test('one bookmark OPEN loads its native target and reports an exact settled result to the real panel', async t => {
  const h = await createHandoffHarness(t); await enter(h); h.snapshot();
  await h.advance(200); assert.equal(results(h).length, 0, 'A physical scroll is not completion');
  await h.advance(1500); oneLanding(h);
  h.snapshot(); await h.advance(40000); oneLanding(h);
});

test('a committed history restore rebinds the panel without an SPA event or repeated MAIN snapshot', async t => {
  const h = await createHandoffHarness(t);
  h.routeEvent(); h.snapshot(); await h.flush();
  const originalPage = h.page();
  await enter(h); h.snapshot(); await h.advance(1800); oneLanding(h);
  assert.equal(h.state.snapshot.conversation.conversationId, 'destination');
  const start = h.broadcasts.length;
  h.page().hide(); h.restore(SOURCE); await h.flush();
  assert.equal(h.page(), originalPage, 'The browser restores the existing document');
  assert.equal(h.broadcasts.slice(start).some(e => e.type === 'snapshot.updated'), false);
  assert.equal(h.state.routeKey, '31|/c/origin');
  assert.equal(h.state.snapshot.conversation.conversationId, 'origin');
  // A late B snapshot must remain rejected; restoring context is not permission
  // to remove the panel's stale-route guard.
  const stale = { ...originalPage.snapshot(), route: { pathname: '/c/destination' },
    conversation: { ...originalPage.snapshot().conversation, conversationId: 'destination' } };
  h.panel.chrome.runtime.onMessage.listener(h.worker.TidyProtocol.event('snapshot.updated', { tabId: 31, snapshot: stale }));
  assert.equal(h.state.snapshot.conversation.conversationId, 'origin');
});

for (const mounted of [false, true]) test(`same-owner startup churn preserves one bookmark with ${mounted ? 'early' : 'late'} DOM mounting`, async t => {
  const h = await createHandoffHarness(t); const ticket = await enter(h);
  if (mounted) { h.snapshot(); await h.advance(100); }
  await h.identity('unavailable', 2); await h.advance(278);
  const before = scrolls(h).length;
  h.snapshot(); await h.advance(100); assert.equal(scrolls(h).length, before, 'No loading/scrolling while owner waits');
  await h.identity('unavailable', 3); await h.advance(469); await h.identity('ready', 4);
  h.snapshot(); await h.advance(1800); oneLanding(h);
  assert.equal(h.currentIntent().deadlineAt, ticket.deadlineAt);
});

for (const boundary of ['different-owner', 'A-B-A', 'workspace-excursion', 'session-revoked', 'third-document', 'manual-cancel', 'deadline']) {
  test(`bookmark continuation cannot revive after ${boundary}`, async t => {
    const h = await createHandoffHarness(t); await enter(h); await h.identity('unavailable', 2);
    if (boundary === 'different-owner' || boundary === 'A-B-A') await h.identity('ready', 3, OTHER);
    else if (boundary === 'workspace-excursion') { h.page().setWorkspace('another'); h.page().setWorkspace('business-w'); }
    else if (boundary === 'session-revoked') await h.page().observeSessionFailure();
    else if (boundary === 'third-document') h.commit('unrelated-document', 'another');
    else if (boundary === 'manual-cancel') h.cancel();
    else await h.advance(33000);
    await h.identity('ready', 4, OWNER); h.snapshot(); await h.advance(35000);
    assert.equal(scrolls(h).length, 0);
    assert.equal(results(h).filter(r => r.payload.located).length, 0);
    assert.equal(h.toasts.filter(t => t.message === 'bookmarkLocated').length, 0);
  });
}

test('source pagehide cannot cancel the committed command and late source results cannot complete it', async t => {
  const h = await createHandoffHarness(t); const ticket = await enter(h);
  h.worker.chrome.runtime.onMessage.listener(h.worker.TidyProtocol.event('navigation.result', {
    navigationIntentId: ticket.id, conversationId: 'destination', messageId: 'message-1', located: true, pending: false,
  }), { tab: { id: 31 }, documentId: SOURCE }, () => {});
  assert.equal(results(h).length, 0); h.snapshot(); await h.advance(1600); oneLanding(h);
});

test('ready bursts and removed URL parameters cannot replay a destination continuation', async t => {
  const h = await createHandoffHarness(t); await enter(h);
  for (let n = 0; n < 8; n++) { await h.identity('ready', 1); h.routeEvent(); h.snapshot({ mounted: false }); }
  assert.equal(requests(h).length, 2);
  h.snapshot(); await h.advance(1700); oneLanding(h);
});

test('a newer explicit bookmark replaces a pending destination without waking the earlier target', async t => {
  const h = await createHandoffHarness(t); const old = await enter(h);
  h.snapshot(); await h.click('destination::message-2'); await h.advance(1800);
  assert.notEqual(h.currentIntent().id, old.id); assert.equal(h.currentIntent().messageId, 'message-2');
  assert.equal(scrolls(h).length, 1); assert.equal(results(h).filter(r => r.payload.located).length, 1);
  assert.equal(results(h).at(-1).payload.messageId, 'message-2');
});

test('cold native loading may finish after 15 seconds without renewing either deadline', async t => {
  const h = await createHandoffHarness(t); const before = await enter(h);
  await h.advance(16000); h.snapshot(); await h.advance(1600); oneLanding(h);
  assert.equal(h.currentIntent().deadlineAt, before.deadlineAt);
  assert.equal(h.currentIntent().loadDeadlineAt, before.loadDeadlineAt);
});

test('a missing target or a destination that never becomes ready produces one bounded failure', async t => {
  for (const ready of [true, false]) {
    const h = await createHandoffHarness(t); await enter(h, { ready });
    await h.advance(35000);
    assert.equal(results(h).length, 1); assert.equal(results(h)[0].payload.located, false);
    assert.equal(results(h)[0].payload.reason, 'target-timeout');
    await h.identity('ready', 1); h.snapshot(); await h.advance(3000);
    assert.equal(results(h).length, 1); assert.equal(scrolls(h).length, 0);
  }
});

test('real MAIN keeps an exact empty message shell in loading until its native body hydrates', async t => {
  const h = await createHandoffHarness(t); const ticket = await enter(h);
  h.page().contentReady = false; h.snapshot();
  await h.advance(3500);
  assert.equal(results(h).length, 0, 'No empty-shell success or premature landing timeout');
  assert.equal(h.currentIntent().deadlineAt, ticket.deadlineAt);
  h.page().contentReady = true; await h.advance(1800);
  assert.equal(results(h).length, 1); assert.equal(results(h)[0].payload.located, true);
  assert.equal(h.toasts.filter(t => t.message === 'bookmarkLocated').length, 1);
  assert.equal(requests(h).length, 2, 'Content readiness never asks the panel to replay OPEN');
});

test('native bookmark opens within one document and never invokes latest placement or reload', async t => {
  const h = await createHandoffHarness(t); h.page().nativeRouter = true;
  const sessions = h.calls.filter(c => c.type === 'synthetic-session').length;
  await h.click();
  assert.equal(h.calls.filter(c => c.type === 'native-router').length, 1);
  assert.equal(h.calls.filter(c => c.type === 'tabs.update').length, 0);
  await h.advance(200); assert.equal(scrolls(h).length, 0, 'Pending SPA route cannot scroll origin');
  h.page().setConversation('destination'); h.routeEvent('https://chatgpt.com/c/destination'); h.snapshot();
  await h.advance(1800);
  assert.equal(results(h).length, 1); assert.equal(results(h)[0].payload.located, true);
  assert.equal(h.page().id, SOURCE); assert.equal(h.panel.library.isCurrent(h.initialLease), true);
  assert.equal(h.calls.filter(c => c.type === 'synthetic-session').length, sessions);
  assert.equal(requests(h).length, 2, 'Source presence probe plus one same-document executor');
  assert.ok(requests(h).every(c => !c.payload.placement));
  assert.equal(scrolls(h).length, 1); assert.equal(h.calls.some(c => c.type === 'tabs.update'), false);
  assert.equal(h.panel.bookmarkNavigation.pendingBookmarkId(), null);
});

test('native target absence uses one exact full-page continuation and the original deadline', async t => {
  const h = await createHandoffHarness(t); h.page().nativeRouter = true;
  await h.click(); const ticket = h.currentIntent();
  h.page().setConversation('destination'); h.routeEvent('https://chatgpt.com/c/destination'); h.snapshot({ mounted: false });
  await h.advance(5900); assert.equal(h.calls.some(c => c.type === 'tabs.update'), false);
  await h.advance(200);
  assert.equal(h.calls.filter(c => c.type === 'tabs.update').length, 1);
  assert.equal(results(h).length, 0, 'Loading handoff is not a terminal failure');
  h.page().hide(); h.commit(); await h.identity('ready', 1); h.snapshot(); await h.advance(1800);
  assert.equal(results(h).length, 1); assert.equal(results(h)[0].payload.located, true);
  assert.equal(h.currentIntent().deadlineAt, ticket.deadlineAt);
  assert.equal(requests(h).length, 3); assert.equal(scrolls(h).length, 1);
  assert.equal(h.calls.filter(c => c.type === 'tabs.update').length, 1);
});

test('a native router that never changes the route still hands off once instead of hanging', async t => {
  const h = await createHandoffHarness(t); h.page().nativeRouter = true;
  await h.click(); const ticket = h.currentIntent();
  await h.advance(5900);
  assert.equal(h.calls.filter(c => c.type === 'tabs.update').length, 0);
  assert.equal(scrolls(h).length, 0, 'Never scroll the origin conversation');
  await h.advance(200);
  assert.equal(h.calls.filter(c => c.type === 'tabs.update').length, 1);
  h.page().hide(); h.commit(); await h.identity('ready', 1); h.snapshot(); await h.advance(1800);
  assert.equal(results(h).length, 1); assert.equal(results(h)[0].payload.located, true);
  assert.equal(requests(h).length, 3); assert.equal(scrolls(h).length, 1);
  assert.equal(h.currentIntent().deadlineAt, ticket.deadlineAt);
  assert.equal(h.calls.filter(c => c.type === 'tabs.update').length, 1);
});

for (const boundary of ['cancel', 'owner', 'route', 'newer']) test(`native bookmark cannot reload or scroll after ${boundary}`, async t => {
  const h = await createHandoffHarness(t); h.page().nativeRouter = true;
  await h.click();
  h.page().setConversation('destination'); h.routeEvent('https://chatgpt.com/c/destination'); h.snapshot({ mounted: false });
  if (boundary === 'cancel') h.cancel();
  if (boundary === 'owner') await h.identity('ready', 2, OTHER);
  if (boundary === 'route') h.routeEvent('https://chatgpt.com/c/unrelated');
  if (boundary === 'newer') { h.snapshot(); await h.click('destination::message-2'); await h.advance(1800); }
  const before = scrolls(h).length;
  await h.advance(10000);
  assert.equal(h.calls.some(c => c.type === 'tabs.update'), false);
  assert.equal(scrolls(h).length, before);
  assert.equal(results(h).filter(c => c.payload.located).length, boundary === 'newer' ? 1 : 0);
});
