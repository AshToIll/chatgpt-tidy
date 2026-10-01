const test = require('node:test'), assert = require('node:assert/strict');
const { createPanelRuntime } = require('./helpers/panel-runtime.cjs');
const runtime = createPanelRuntime().load('src/platform/session/ui/page-session-controller.js');
const fs = require('node:fs'), vm = require('node:vm');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const error = (disconnect, documentId = 'old-document') => Object.assign(new Error('Not ready'), {
  code: 'ADAPTER_UNAVAILABLE', details: { stage: 'service-worker.page-session', documentId,
    ...(disconnect === 'connecting' ? { phase: 'connecting' } : { disconnect }) },
});
async function harness(probe = async () => ({ ready: true, documentId: 'old-document' })) {
  const { createPageSessionController } = await runtime;
  const timers = new Map(), states = []; let id = 0;
  const gate = createPageSessionController({ probe, maxAttempts: 3,
    setTimer(fn) { timers.set(++id, fn); return id; }, clearTimer(id) { timers.delete(id); },
    onChanged(state) { states.push(state); },
  });
  async function tick() { const next = timers.entries().next().value; if (next) { timers.delete(next[0]); next[1](); } await new Promise(setImmediate); }
  return { gate, timers, states, tick };
}

test('initial install on an existing page dispatches no business until the full handshake succeeds', async () => {
  const handshake = deferred(), h = await harness(() => handshake.promise); let sideEffects = 0;
  const check = h.gate.check();
  for (const type of ['favorites.toggle-current', 'bookmarks.open', 'preferences.update', 'search.messages',
    'export.job-start', 'library.backup-export', 'title.apply', 'future.unknown-command']) {
    await assert.rejects(h.gate.run(type, () => sideEffects++), { code: 'ADAPTER_UNAVAILABLE' });
  }
  assert.equal(sideEffects, 0);
  handshake.resolve({ ready: true, documentId: 'old-document' }); await check;
  await h.gate.run('preferences.update', () => sideEffects++);
  assert.equal(sideEffects, 1); assert.equal(h.gate.isReady(), true);
});

test('bootstrap reads and exact cancellation are explicit exceptions, not a wildcard', async () => {
  const { pageCommandCapability } = await runtime, h = await harness(); let calls = 0;
  for (const type of ['page-session.probe', 'snapshot.get-active-context', 'preferences.get',
    'navigation.cancelled', 'export.job-cancel', 'export.preview-close', 'library.backup-discard']) {
    await h.gate.run(type, () => calls++);
    assert.notEqual(pageCommandCapability(type), 'business');
  }
  assert.equal(calls, 7);
  assert.equal(pageCommandCapability('preferences.update'), 'business');
});

test('confirmed missing old document remains locked across snapshot/identity and same-document probe', async () => {
  let documentId = 'old-document', missing = true;
  const h = await harness(async () => { if (missing) throw error('receiver-missing'); return { ready: true, documentId }; });
  await h.gate.check(); assert.equal(h.gate.getState().phase, 'refresh-required');
  assert.equal(h.timers.size, 0, 'do not poll a document that requires reload');
  missing = false;
  await h.gate.check(); assert.equal(h.gate.isReady(), false, 'old snapshots only request a live probe, never admission');
  await h.gate.check({ contextChanged: true }); assert.equal(h.gate.isReady(), false, 'same-document route cannot unlock');
  documentId = 'new-document'; await h.gate.check({ contextChanged: true });
  assert.equal(h.gate.isReady(), true);
});

test('new-page bootstrap receiver delay has bounded retries without demanding another F5', async () => {
  let calls = 0;
  const h = await harness(async () => { calls++; throw error('connecting', 'new-document'); });
  await h.gate.check(); await h.tick(); await h.tick();
  assert.equal(calls, 3); assert.equal(h.timers.size, 0);
  assert.equal(h.gate.getState().phase, 'stalled');
  h.gate.dispose();
});

test('late business replies and late failures cannot revive or lock a replacement document', async () => {
  let documentId = 'old-document'; const h = await harness(async () => ({ ready: true, documentId }));
  await h.gate.check(); const old = deferred(), failed = deferred();
  const request = h.gate.run('library.get', () => old.promise);
  const failure = h.gate.run('title.preview', () => failed.promise);
  const rejected = assert.rejects(request, { code: 'ADAPTER_UNAVAILABLE' });
  const rejectedFailure = assert.rejects(failure, { code: 'ADAPTER_UNAVAILABLE' });
  documentId = 'new-document'; await h.gate.check({ contextChanged: true });
  old.resolve({ privateOldData: true }); failed.reject(error('context-invalidated'));
  await rejected; await rejectedFailure; assert.equal(h.gate.isReady(), true);
});

test('health is independent from library/auth/network/storage failures', async () => {
  const h = await harness(); await h.gate.check();
  for (const failure of [Object.assign(new Error('network'), { code: 'ADAPTER_UNAVAILABLE', details: { status: 503 } }),
    Object.assign(new Error('auth'), { code: 'LIBRARY_ACCOUNT_UNAVAILABLE' }), Object.assign(new Error('disk'), { code: 'STORAGE_ERROR' })]) {
    await assert.rejects(h.gate.run('library.get', () => Promise.reject(failure)));
    assert.equal(h.gate.isReady(), true);
  }
});

test('runtime rejection retires a previously ready document for every subsequent command', async () => {
  const h = await harness(); await h.gate.check(); let calls = 0;
  await assert.rejects(h.gate.run('favorites.toggle-current', () => Promise.reject(error('context-invalidated'))));
  await assert.rejects(h.gate.run('title.apply', () => calls++));
  assert.equal(calls, 0); assert.equal(h.gate.getState().phase, 'refresh-required');
});

test('an admitted navigation receipt may span a normal document handoff, but never terminal invalidation', async () => {
  let documentId = 'old-document'; const h = await harness(async () => ({ ready: true, documentId }));
  await h.gate.check(); const opened = deferred();
  const request = h.gate.run('bookmarks.open', () => opened.promise);
  documentId = 'new-document'; await h.gate.check({ contextChanged: true });
  opened.resolve({ navigationIntentId: 'intent-1' });
  assert.equal((await request).navigationIntentId, 'intent-1');
  const late = deferred(), rejected = h.gate.run('bookmarks.open', () => late.promise);
  h.gate.reject(error('context-invalidated', documentId)); late.resolve({ navigationIntentId: 'intent-2' });
  await assert.rejects(rejected, { code: 'ADAPTER_UNAVAILABLE' });
});

test('pagehide/dispose blocks queued commands and late callbacks without dispatching', async () => {
  const h = await harness(); await h.gate.check(); let calls = 0;
  const old = deferred(), pending = h.gate.run('library.get', () => old.promise);
  h.gate.dispose(); assert.equal(h.gate.isReady(), false);
  for (const type of ['bookmarks.open', 'library.get', 'preferences.get']) {
    await assert.rejects(h.gate.run(type, () => calls++), { code: 'ADAPTER_UNAVAILABLE' });
  }
  assert.equal(calls, 0); old.resolve({ old: true }); await assert.rejects(pending, { code: 'ADAPTER_UNAVAILABLE' });
  await h.gate.run('navigation.cancelled', () => calls++); assert.equal(calls, 1);
});

// Wire the production context/event seams to the real controller: tab load
// completion is a wake-up signal, not a synthetic snapshot or ready shortcut.
async function shell(probe) {
  const environment = createPanelRuntime();
  environment.load('src/platform/protocol.js');
  const protocol = environment.context.TidyProtocol;
  const { createPageSessionController } = environment.load('src/platform/session/ui/page-session-controller.js');
  const { createPanelContextController } = environment.load('src/app/sidepanel/context-controller.js');
  const timers = new Map(); let id = 0, listener, hydrated = 0;
  const state = { pageSession: { phase: 'connecting' } };
  const pageSession = createPageSessionController({ probe, maxAttempts: 2,
    onChanged(next) { state.pageSession = next; },
    setTimer(fn) { timers.set(++id, fn); return id; }, clearTimer(id) { timers.delete(id); },
  });
  const contextOwner = createPanelContextController({
    ownerTabId: 31, isReady: pageSession.isReady, isValidTabId: Number.isInteger,
    routeKey: () => 'route', contextType: protocol.Type.GET_ACTIVE_CONTEXT, errorCodes: protocol.ErrorCode,
    async request() { hydrated++; return { tab: { id: 31 }, snapshot: { route: { pathname: '/c/fixture' } } }; },
  });
  Object.assign(environment.context, {
    state, pageSession, context: contextOwner, panelOwnerTabId: 31, protocol,
    // This is the entry's document-lifecycle flag, not a substitute admission state.
    disposed: false, isReady: pageSession.isReady, isValidTabId: Number.isInteger,
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
  });
  const source = fs.readFileSync('src/app/sidepanel/panel.js', 'utf8');
  function wiring(first, last) {
    const start = source.indexOf(first), end = source.indexOf(last, start);
    assert.notEqual(start, -1, 'the production wiring entry must exist');
    assert.ok(end > start, 'the production wiring end must follow its entry');
    return source.slice(start, end);
  }
  // The composition root still owns this narrow event subscription. Execute it
  // unchanged against real context/session owners; never reconstruct its rules.
  vm.runInContext(wiring('function invalidateContext(', 'const lifecycle =')
    + wiring('chrome.runtime.onMessage.addListener(', 'chrome.storage.onChanged.addListener('), environment.context);
  const settle = () => new Promise(setImmediate);
  return { pageSession, state, timers, hydrated: () => hydrated,
    async tick() { const [key, fn] = timers.entries().next().value; timers.delete(key); fn(); await settle(); },
    async complete(documentId) { listener(protocol.event(protocol.Type.CONTEXT_CHANGED,
      { tabId: 31, documentId, reason: 'document-load-complete', url: 'https://chatgpt.com/c/fixture' })); await settle(); },
  };
}

test('long-loading first-install page wakes after retry budget and then asks for a reload', async () => {
  let loading = true;
  const h = await shell(async () => { throw error(loading ? 'connecting' : 'receiver-missing'); });
  await h.pageSession.check(); await h.tick();
  assert.equal(h.timers.size, 0); assert.equal(h.state.pageSession.phase, 'stalled');
  loading = false; await h.complete('old-document');
  assert.equal(h.state.pageSession.phase, 'refresh-required');
  await h.complete('old-document'); assert.equal(h.pageSession.isReady(), false);
  assert.equal(h.hydrated(), 0); h.pageSession.dispose();
});

test('long-loading healthy page wakes after retry budget, and ready same-document completion does not rehydrate', async () => {
  let loading = true, probes = 0;
  const h = await shell(async () => { probes++; if (loading) throw error('connecting', 'new-document');
    return { ready: true, documentId: 'new-document' }; });
  await h.pageSession.check(); await h.tick(); assert.equal(h.timers.size, 0);
  loading = false; await h.complete('new-document'); assert.equal(h.pageSession.isReady(), true);
  const before = probes; await h.complete('new-document');
  assert.equal(probes, before); assert.equal(h.hydrated(), 0);
  h.pageSession.dispose();
});
