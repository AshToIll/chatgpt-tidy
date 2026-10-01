const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createPanelRuntime } = require('./helpers/panel-runtime.cjs');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness() {
  const toasts = [], requests = [], timers = new Map(); let next = 0, completed = null, clock = 0, nextTimer = 0;
  function node() {
    return { hidden: true, textContent: '', children: [], attributes: {}, listeners: {},
      classList: { toggle() {} }, append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, callback) { this.listeners[name] = callback; } };
  }
  const toast = node();
  const runtime = createPanelRuntime({
    panelOwnerTabId: 31, state: { route: 'search', pageSession: { phase: 'ready' } },
    document: { createElement: node },
    setTimeout(callback, delay) { timers.set(++nextTimer, { at: clock + delay, callback }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  }, { transforms: {
    // Observation only: keep the real notice owner and its lifecycle slot.
    'src/app/sidepanel/notice-controller.js': source => source.replace('return Object.freeze({', 'return Object.freeze({ readNotice: () => slot.current(),'),
  } });
  const context = runtime.context;
  runtime.load('src/platform/protocol.js'); context.protocol = context.TidyProtocol;
  const { createPanelNavigationOwner } = runtime.load('src/platform/navigation/ui/navigation-owner.js');
  context.panelNavigation = createPanelNavigationOwner({ createId: () => 'intent-' + (++next), cancel() {} });
  const { createNoticeController } = runtime.load('src/app/sidepanel/notice-controller.js');
  const notice = createNoticeController({ root: toast, translate: key => key, isReady: () => true,
    isCurrentNavigation: context.panelNavigation.isCurrent, now: () => clock,
    diagnostics: { cause: () => ({}), notice(event) {
      if (event.event === 'show') toasts.push({ key: event.messageKey, error: event.reasonCode !== 'UI_INFORMATIONAL_NOTICE' });
    } },
  });
  Object.assign(context, notice);
  context.notice = notice; // Route activity receives the same real notice owner, not a second slot.
  const { createSearchActions } = runtime.load('src/app/sidepanel/search-actions.js');
  const actions = createSearchActions({ ownerTabId: 31, protocol: context.protocol, isReady: () => true,
    request: (type, payload) => { const pending = deferred(); requests.push({ type, payload, ...pending }); return pending.promise; },
    dateSearch: {}, pauseTitleCatalog() {}, navigation: context.panelNavigation, notice,
  });
  context.handleSearchAction = actions.handle;
  context.bookmarkNavigation = { complete: payload => context.consumeBookmark(payload), cancelId() {} };
  context.consumeBookmark = () => true;
  context.searchView = { completeNavigation(payload) {
    if (completed === payload.navigationIntentId) return false;
    completed = payload.navigationIntentId; return true;
  }, cancelId() {}, setActive() {} };
  context.isReady = () => true;
  context.backupView = { setActive() {} };
  context.filing = { favorites: { sync() {} }, bookmarks: { sync() {} } };
  context.createPanelNavigationCoordinator = runtime.load('src/app/sidepanel/navigation-coordinator.js').createPanelNavigationCoordinator;
  const panel = read('src/app/sidepanel/panel.js');
  const left = panel.indexOf('const navigationResults = createPanelNavigationCoordinator(');
  const right = panel.indexOf('const context = createPanelContextController(', left);
  assert.ok(left >= 0 && right > left, 'the production navigation adapter remains explicit');
  // Only the composition callback is selected; every stateful owner is a full
  // production module above. No old panel implementation is reconstructed.
  vm.runInContext(panel.slice(left, right) + '\nglobalThis.completeNavigation = navigationResults.receive;', context);
  const activityStart = panel.indexOf('function syncRouteActivity()');
  const activityEnd = panel.indexOf('function syncExportContext()', activityStart);
  assert.ok(activityStart >= 0 && activityEnd > activityStart);
  vm.runInContext(panel.slice(activityStart, activityEnd), context);
  return { context, requests, toasts, toast, timers,
    begin() {
      const id = context.panelNavigation.begin('search', { conversationId: 'target' });
      context.beginSearchNotice(id); return id;
    },
    interact() { context.dismissSearchToast(); },
    leave() { context.state.route = 'time'; context.syncRouteActivity(); },
    advance(ms) {
      clock += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.callback(); }
    },
  };
}

for (const boundary of ['newer-click', 'module-left', 'worker-cancelled']) test('late search OPEN rejection is silent after ' + boundary, async () => {
  const h = harness(), id = h.begin();
  const opened = h.context.handleSearchAction('open', { navigationIntentId: id, conversationId: 'target' });
  const rejection = assert.rejects(opened, /retired request/);
  if (boundary === 'newer-click') h.begin();
  else if (boundary === 'module-left') h.context.panelNavigation.leave('time');
  else h.context.panelNavigation.revoked(id);
  h.requests[0].reject(Object.assign(new Error('retired request'), { code: 'CONTEXT_MISMATCH' }));
  await rejection;
  assert.deepEqual(h.toasts, [], 'only the current click may present a navigation failure');
});
test('a current search OPEN failure still reports once', async () => {
  const h = harness(), id = h.begin();
  const opened = h.context.handleSearchAction('open', { navigationIntentId: id, conversationId: 'target' });
  const rejection = assert.rejects(opened, /bridge failed/);
  h.requests[0].reject(Object.assign(new Error('bridge failed'), { code: 'ADAPTER_UNAVAILABLE' }));
  await rejection; assert.deepEqual(h.toasts, [{ key: 'actionFailed', error: true }]);
});
for (const reason of ['user-cancelled', 'cancelled', 'superseded']) test('normal search navigation cancellation is not a failed action: ' + reason, () => {
  const h = harness(), id = h.begin();
  h.context.completeNavigation({ tabId: 31, conversationId: 'target', navigationIntentId: id, located: false, reason });
  assert.deepEqual(h.toasts, []);
});
test('failed latest search landing has one specific notice, not a second generic error', () => {
  const h = harness(), id = h.begin();
  h.context.completeNavigation({ tabId: 31, conversationId: 'target', navigationIntentId: id, placement: 'latest', located: false, reason: 'target-timeout' });
  assert.deepEqual(h.toasts, [{ key: 'favoriteLatestUnavailable', error: true }]);
});

test('a duplicate latest search receipt is consumed once while cancellation ownership survives', () => {
  const h = harness(), id = h.begin();
  const receipt = { tabId: 31, conversationId: 'target', navigationIntentId: id, placement: 'latest', located: false, reason: 'target-timeout' };
  h.context.completeNavigation(receipt);
  h.context.completeNavigation(receipt);
  assert.deepEqual(h.toasts, [{ key: 'favoriteLatestUnavailable', error: true }]);
  assert.equal(h.context.panelNavigation.isCurrent(id), true,
    'consuming completion must not remove the handle used when leaving the module');
});

test('favorites retain their specific latest-message notice without a search receipt', () => {
  const h = harness();
  h.context.state.route = 'favorites';
  h.context.searchView.completeNavigation = () => false;
  const id = h.context.panelNavigation.begin('favorites', { conversationId: 'target', placement: 'latest' });
  const receipt = { tabId: 31, conversationId: 'target', navigationIntentId: id, placement: 'latest', located: false, reason: 'target-timeout' };
  h.context.completeNavigation(receipt);
  h.context.completeNavigation(receipt);
  assert.deepEqual(h.toasts, [{ key: 'favoriteLatestUnavailable', error: true }]);
});

test('a bookmark receipt belongs to its result adapter, not the latest-message warning', () => {
  const h = harness(); let completed = 0;
  h.context.state.route = 'bookmarks';
  h.context.searchView.completeNavigation = () => false;
  h.context.consumeBookmark = () => { completed += 1; return true; };
  const id = h.context.panelNavigation.begin('bookmarks', { conversationId: 'target', messageId: 'message' });
  const receipt = { tabId: 31, conversationId: 'target', navigationIntentId: id, messageId: 'message', located: false, reason: 'target-timeout' };
  h.context.completeNavigation(receipt);
  h.context.completeNavigation(receipt);
  assert.equal(completed, 1);
  assert.deepEqual(h.toasts, []);
});

test('native keyword handoff acknowledgement does not fabricate a location failure', async () => {
  const h = harness(), id = h.begin();
  const opened = h.context.handleSearchAction('open', { navigationIntentId: id, navigationKind: 'keyword', conversationId: 'target' });
  assert.equal(h.requests[0].payload.navigationKind, 'keyword', 'keyword intent is explicit even when a hit has no message ID');
  h.requests[0].resolve({ navigationIntentId: id, navigated: true, presentationOwner: 'native', mode: 'same-document' });
  const result = await opened;
  assert.equal(result.presentationOwner, 'native');
  assert.deepEqual(h.toasts, []);
});

test('a completed search result cannot be overwritten by a late OPEN transport rejection', async () => {
  const h = harness(), id = h.begin();
  const opened = h.context.handleSearchAction('open', { navigationIntentId: id, conversationId: 'target' });
  const rejected = assert.rejects(opened, /closed channel/);
  h.context.completeNavigation({ tabId: 31, conversationId: 'target', navigationIntentId: id, placement: 'latest', located: true });
  h.requests[0].reject(Object.assign(new Error('closed channel'), { code: 'ADAPTER_UNAVAILABLE' }));
  await rejected;
  assert.deepEqual(h.toasts, []);
});

test('an invalid completion cannot consume the later valid receipt', () => {
  const h = harness(), id = h.begin();
  h.context.completeNavigation({ tabId: 31, conversationId: 'target', navigationIntentId: id, placement: 'latest' });
  h.context.completeNavigation({ tabId: 31, conversationId: 'target', navigationIntentId: id, placement: 'latest', located: false, reason: 'target-timeout' });
  assert.deepEqual(h.toasts, [{ key: 'favoriteLatestUnavailable', error: true }]);
});

test('search failure is a five-second notice without a close button', () => {
  const h = harness(), id = h.begin();
  h.context.completeNavigation({ tabId: 31, conversationId: 'target', navigationIntentId: id, placement: 'latest', located: false, reason: 'landing-timeout' });
  assert.equal(h.toast.hidden, false); assert.equal(h.toast.children.length, 1);
  assert.equal(h.context.readNotice().owner, 'search');
  h.advance(4999); assert.equal(h.toast.hidden, false);
  h.advance(1); assert.equal(h.toast.hidden, true);
});

test('new search interaction clears the current search notice and does not revive it on language render', () => {
  const h = harness(), id = h.begin();
  h.context.completeNavigation({ tabId: 31, conversationId: 'target', navigationIntentId: id, placement: 'latest', located: false, reason: 'target-timeout' });
  h.interact(); h.context.renderToast();
  assert.equal(h.toast.hidden, true); assert.equal(h.timers.size, 0);
});

test('a new OPEN clears old search feedback without waiting for its asynchronous outcome', async () => {
  const h = harness(), old = h.begin();
  h.context.completeNavigation({ tabId: 31, conversationId: 'target', navigationIntentId: old, placement: 'latest', located: false, reason: 'target-timeout' });
  const id = h.context.panelNavigation.begin('search');
  const opened = h.context.handleSearchAction('open', { navigationIntentId: id, conversationId: 'target', navigationKind: 'keyword' });
  assert.equal(h.toast.hidden, true);
  h.requests[0].resolve({ navigated: true, presentationOwner: 'native' }); await opened;
  assert.equal(h.toast.hidden, true);
});

test('current native keyword acknowledgement clears only its owned search notice', async () => {
  const h = harness(), id = h.begin();
  const opened = h.context.handleSearchAction('open', { navigationIntentId: id, conversationId: 'target', navigationKind: 'keyword' });
  h.context.showSearchToast?.('actionFailed', id);
  h.requests[0].resolve({ navigated: true, presentationOwner: 'native' }); await opened;
  assert.equal(h.toast.hidden, true);
});

test('current latest success clears its notice while older success cannot clear a newer notice', () => {
  const h = harness(), old = h.begin();
  h.context.showSearchToast?.('actionFailed', old);
  h.context.completeNavigation({ tabId: 31, conversationId: 'target', navigationIntentId: old, placement: 'latest', located: true });
  assert.equal(h.toast.hidden, true);
  const next = h.begin();
  h.context.completeNavigation({ tabId: 31, conversationId: 'target', navigationIntentId: next, placement: 'latest', located: false, reason: 'target-timeout' });
  const notice = h.context.readNotice();
  h.context.completeNavigation({ tabId: 31, conversationId: 'target', navigationIntentId: old, placement: 'latest', located: true });
  assert.equal(h.context.readNotice(), notice); assert.equal(h.toast.hidden, false);
});

test('late OPEN failure after editing search conditions has no presentation ownership', async () => {
  const h = harness(), id = h.begin();
  const opened = h.context.handleSearchAction('open', { navigationIntentId: id, conversationId: 'target' });
  const rejection = assert.rejects(opened, /old conditions/);
  h.interact();
  h.requests[0].reject(Object.assign(Error('old conditions'), { code: 'ADAPTER_UNAVAILABLE' }));
  await rejection; assert.equal(h.toast.hidden, true); assert.deepEqual(h.toasts, []);
});

test('late latest failure after editing conditions cannot recreate a dismissed notice', () => {
  const h = harness(), id = h.begin(); h.interact();
  h.context.completeNavigation({ tabId: 31, conversationId: 'target', navigationIntentId: id, placement: 'latest', located: false, reason: 'target-timeout' });
  assert.equal(h.toast.hidden, true); assert.deepEqual(h.toasts, []);
});

test('leaving search dismisses its feedback but never a different module notice', () => {
  const h = harness(), id = h.begin();
  h.context.completeNavigation({ tabId: 31, conversationId: 'target', navigationIntentId: id, placement: 'latest', located: false, reason: 'target-timeout' });
  h.leave(); assert.equal(h.toast.hidden, true);
  h.context.showToast('libraryChangeUnknown', true);
  const notice = h.context.readNotice(); h.leave();
  assert.equal(h.context.readNotice(), notice); assert.equal(h.toast.hidden, false);
});

test('search interaction and successful completion preserve unrelated errors and their close control', () => {
  const h = harness(), id = h.begin();
  h.context.showToast('libraryChangeUnknown', true);
  const notice = h.context.readNotice(); h.interact();
  h.context.completeNavigation({ tabId: 31, conversationId: 'target', navigationIntentId: id, placement: 'latest', located: true });
  assert.equal(h.context.readNotice(), notice); assert.equal(h.toast.children.length, 2);
  h.advance(10000); assert.equal(h.toast.hidden, false);
});

test('an already queued old search timer cannot dismiss replacement feedback', () => {
  const h = harness(), id = h.begin();
  h.context.completeNavigation({ tabId: 31, conversationId: 'target', navigationIntentId: id, placement: 'latest', located: false, reason: 'target-timeout' });
  const oldTimer = [...h.timers.values()][0]; assert.ok(oldTimer);
  h.context.showToast('libraryChangeUnknown', true); const notice = h.context.readNotice();
  oldTimer.callback();
  assert.equal(h.context.readNotice(), notice); assert.equal(h.toast.hidden, false);
});

test('search-source export account mismatch uses the same transient ownership without changing export routing', () => {
  const h = harness(); h.context.state.route = 'export';
  h.context.showSearchToast?.('searchExportAccountChanged');
  assert.equal(h.toast.hidden, false); assert.equal(h.toast.children.length, 1);
  assert.equal(h.context.readNotice().owner, 'search');
  h.advance(5000); assert.equal(h.toast.hidden, true);
  const panel = read('src/app/sidepanel/panel.js');
  assert.match(read("src/app/sidepanel/export-workflow.js"), /showSearchToast\("searchExportAccountChanged"\)/);
  assert.match(panel, /onInteraction:\s*dismissSearchToast/);
});

test('late native acknowledgement cannot dismiss a newer search navigation notice', async () => {
  const h = harness(), old = h.begin();
  const opened = h.context.handleSearchAction('open', { navigationIntentId: old, conversationId: 'target', navigationKind: 'keyword' });
  const next = h.begin();
  h.context.completeNavigation({ tabId: 31, conversationId: 'target', navigationIntentId: next, placement: 'latest', located: false, reason: 'target-timeout' });
  const notice = h.context.readNotice();
  h.requests[0].resolve({ navigated: true, presentationOwner: 'native' }); await opened;
  assert.equal(h.context.readNotice(), notice); assert.equal(h.toast.hidden, false);
});

test('a newer search-source warning is not cleared by an earlier navigation success', () => {
  const h = harness(), id = h.begin();
  h.context.showSearchToast?.('searchExportAccountChanged');
  const notice = h.context.readNotice();
  h.context.completeNavigation({ tabId: 31, conversationId: 'target', navigationIntentId: id, placement: 'latest', located: true });
  assert.equal(h.context.readNotice(), notice);
  assert.equal(h.toast.hidden, false);
});
