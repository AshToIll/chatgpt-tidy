const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const SOURCE = fs.readFileSync('src/platform/navigation/chatgpt/library-navigation.js', 'utf8');
const OWNER = '["user-one","personal"]';
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const flush = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };

function harness({ href = 'https://chatgpt.com/c/current', read, getRouter, navigate, isIntentCurrent = () => true } = {}) {
  const calls = { reads: 0, routes: [], latest: [], timers: [], clearedTimers: [] };
  const timers = new Map(); let nextTimer = 0;
  const location = { href, origin: new URL(href).origin };
  const identity = { accountKey: OWNER, epoch: 4, phase: 'ready' };
  let now = 1000;
  const router = { navigate(path) {
    assert.equal(this, router, 'preserve native router receiver');
    calls.routes.push(path); return navigate?.(path);
  } };
  const context = vm.createContext({ URL, location, __reactRouterDataRouter: router,
    document: { querySelectorAll() { assert.fail('Navigation must not depend on sidebar DOM'); } },
    fetch() { assert.fail('No full-text search or other backend read'); },
    history: { pushState() { assert.fail('Do not fabricate native routing'); } },
    TidyChatgptApi: {
      readLibraryAccount: () => { calls.reads++; return read ? read() : { ...identity }; },
      checkLibraryIdentity: () => ({ ...identity }),
    },
  });
  vm.runInContext(fs.readFileSync('src/platform/navigation/navigation-identity.js', 'utf8'), context);
  vm.runInContext(SOURCE, context);
  const adapter = context.TidyChatgptLibraryNavigation.create({ isIntentCurrent,
    getRouter: getRouter || (() => router), now: () => now, revealLatest: target => calls.latest.push(plain(target)),
    setTimer(fn, delay) { const id = ++nextTimer; timers.set(id, fn); calls.timers.push({ id, delay }); return id; },
    clearTimer(id) { timers.delete(id); calls.clearedTimers.push(id); },
  });
  const payload = { conversationId: 'target', pathname: '/c/target', expectedAccountKey: OWNER,
    expectedEpoch: 4, navigationIntentId: 'intent-a' };
  return { context, adapter, location, identity, calls, router, payload, setTime: value => { now = value; },
    fireTimer(id = [...timers.keys()][0]) { const fn = timers.get(id); assert.ok(fn, 'expected one pending timer'); timers.delete(id); fn(); },
    pendingTimers: () => timers.size,
    open: (patch = {}) => adapter.navigate({ ...payload, ...patch }).then(plain) };
}

test('official router works without sidebar DOM, synthetic clicks, search or fabricated history', async () => {
  const h = harness();
  assert.deepEqual(await h.open(), { navigated: true, reason: 'native-router' });
  assert.deepEqual(h.calls.routes, ['/c/target']); assert.equal(h.calls.reads, 1);
  assert.equal(h.location.href, 'https://chatgpt.com/c/current', 'Only native router owns URL changes');
  assert.equal(h.calls.latest.length, 0, 'Message commands do not scroll to latest');
});

test('project routes stay exact and message/search metadata never enters the routing URL', async () => {
  const h = harness();
  await h.open({ pathname: '/g/g-p-correct/c/target', messageId: 'private-message', query: 'private excerpt' });
  assert.deepEqual(h.calls.routes, ['/g/g-p-correct/c/target']);
});

test('unsafe paths and malformed ownership leases are rejected before identity reads', async () => {
  const patches = ['https://chatgpt.com/c/target', 'https://evil.test/c/target', '//evil.test/c/target',
    '/c/other', '/c/target/', '/c/target?messageId=wrong', '/c/target#wrong', '/c/target/extra',
    '/x/../c/target', '/c/%74arget', '/c/target%2fother', '/c/target\\evil', '/c/target\n',
    '/gg/target', '/g/g-custom/c/target', '/g/g-p-project/project', '/c/WEB:target', ' /c/target'].map(pathname => ({ pathname }));
  patches.push({ conversationId: ' target' }, { conversationId: 'target/other' },
    { expectedAccountKey: '' }, { expectedAccountKey: ' owner ' }, { expectedAccountKey: null },
    { expectedEpoch: -1 }, { expectedEpoch: 1.5 }, { expectedEpoch: '4' }, { expectedEpoch: undefined },
    { expectedEpoch: Number.MAX_SAFE_INTEGER + 1 });
  for (const patch of patches) {
    const h = harness(); assert.equal((await h.open(patch)).reason, 'invalid-target', JSON.stringify(patch));
    assert.equal(h.calls.reads, 0); assert.equal(h.calls.routes.length, 0);
  }
});

test('non-ChatGPT documents cannot invoke the router', async () => {
  for (const href of ['https://evil.test/c/current', 'http://chatgpt.com/c/current', 'https://chatgpt.com:8443/c/current']) {
    const h = harness({ href }); assert.equal((await h.open()).reason, 'invalid-target');
    assert.equal(h.calls.reads, 0); assert.equal(h.calls.routes.length, 0);
  }
});

test('missing/changed router reports an explicit reason without an anchor compatibility path', async () => {
  for (const getRouter of [() => null, () => ({}), () => ({ navigate: true }), () => { throw Error('unavailable'); }]) {
    const h = harness({ getRouter });
    assert.deepEqual(await h.open(), { navigated: false, reason: 'native-router-unavailable' });
    assert.equal(h.calls.routes.length, 0);
  }
});

test('already-current message route validates identity without calling router', async () => {
  const h = harness({ href: 'https://chatgpt.com/c/target?messageId=old' });
  assert.equal((await h.open()).reason, 'already-current'); assert.equal(h.calls.routes.length, 0);
  h.identity.epoch++; assert.equal((await h.open()).reason, 'context-mismatch');
});

test('latest commands clean old URL state and preserve placement deadlines', async () => {
  for (const suffix of ['?messageId=old', '?src=history_search&historySearchQuery=old&messageId=old', '#old', '']) {
    const h = harness({ href: 'https://chatgpt.com/c/target' + suffix });
    assert.equal((await h.open({ placement: 'latest', loadDeadlineAt: 30000,
      deadlineAt: 32400, nativeFallbackAt: 6000 })).reason, suffix ? 'native-router' : 'already-current');
    assert.deepEqual(h.calls.routes, suffix ? ['/c/target'] : []);
    assert.equal(h.calls.latest.length, 1); assert.equal(h.calls.latest[0].messageId, undefined);
    assert.equal(h.calls.latest[0].nativeFallbackAt, 6000);
    await h.open({ placement: 'latest' }); assert.equal(h.calls.latest.length, 1);
  }
});

test('wrong account, epoch and unavailable identity block routing and fallback', async () => {
  for (const patch of [{ accountKey: '["other","personal"]' }, { epoch: 5 }, { phase: 'unavailable' }]) {
    const h = harness(); Object.assign(h.identity, patch);
    assert.equal((await h.open()).reason, 'context-mismatch'); assert.equal(h.calls.routes.length, 0);
  }
});

for (const boundary of ['identity', 'route', 'intent']) {
  test(`async owner read cannot overwrite changed ${boundary}`, async () => {
    const hold = deferred(); let current = true;
    const h = harness({ read: () => hold.promise, isIntentCurrent: () => current });
    const pending = h.open(); await Promise.resolve();
    if (boundary === 'identity') h.identity.epoch++;
    if (boundary === 'route') h.location.href = 'https://chatgpt.com/c/user-choice';
    if (boundary === 'intent') current = false;
    hold.resolve({ accountKey: OWNER, epoch: 4 });
    assert.equal((await pending).reason, { identity: 'context-mismatch', route: 'route-changed', intent: 'superseded' }[boundary]);
    assert.equal(h.calls.routes.length, 0);
  });
  test(`router discovery reentrancy cannot bypass ${boundary} fence`, async () => {
    let h, current = true;
    h = harness({ isIntentCurrent: () => current, getRouter: () => {
      if (boundary === 'identity') h.identity.epoch++;
      if (boundary === 'route') h.location.href = 'https://chatgpt.com/c/user-choice';
      if (boundary === 'intent') current = false;
      return h.router;
    } });
    assert.equal((await h.open()).reason, { identity: 'context-mismatch', route: 'route-changed', intent: 'superseded' }[boundary]);
    assert.equal(h.calls.routes.length, 0);
  });
}

test('duplicate calls share work; newer intent supersedes an old identity wait', async () => {
  const hold = deferred(); let current = 'intent-a', reads = 0;
  const h = harness({ isIntentCurrent: id => id === current,
    read: () => ++reads === 1 ? hold.promise : { accountKey: OWNER, epoch: 4 } });
  const first = h.adapter.navigate(h.payload); assert.equal(h.adapter.navigate({ ...h.payload }), first);
  assert.equal((await h.open({ pathname: '/c/other', conversationId: 'other' })).reason, 'navigation-in-progress');
  current = 'intent-b';
  assert.equal((await h.open({ pathname: '/c/newer', conversationId: 'newer', navigationIntentId: current })).reason, 'native-router');
  hold.resolve({ accountKey: OWNER, epoch: 4 }); assert.equal((await first).reason, 'superseded');
  assert.deepEqual(h.calls.routes, ['/c/newer']);
});

test('double-click merges dispatch but latest placement belongs to the newer command', async () => {
  const h = harness(); await h.open();
  assert.equal((await h.open({ navigationIntentId: 'new', placement: 'latest' })).reason, 'navigation-pending');
  assert.equal(h.calls.routes.length, 1); assert.equal(h.calls.latest[0].navigationIntentId, 'new');
  h.setTime(2500); await h.open(); assert.equal(h.calls.routes.length, 2);
});

test('sync failure is explicit; async rejection/non-settlement never hangs IPC', async () => {
  const sync = harness({ navigate: () => { throw Error('native failure'); } });
  assert.equal((await sync.open()).reason, 'native-router-failed');
  assert.equal((await sync.open()).reason, 'native-router-failed'); assert.equal(sync.calls.routes.length, 1);
  const rejected = harness({ navigate: () => Promise.reject(Error('native rejection')) });
  assert.equal((await rejected.open()).reason, 'native-router'); await Promise.resolve();
  assert.equal((await rejected.open()).reason, 'native-router-failed');
  const stalled = harness({ navigate: () => new Promise(() => {}) });
  assert.equal((await stalled.open()).reason, 'native-router', 'Common locator owns timeout, not native Promise');
});

test('reentrant router shares in-flight dispatch; missing intent fence fails closed', async () => {
  let h, reentered;
  h = harness({ navigate: () => { reentered = h.adapter.navigate(h.payload); } });
  const first = h.adapter.navigate(h.payload); await first;
  assert.equal(reentered, first); assert.equal(h.calls.routes.length, 1);
  assert.equal((await h.context.TidyChatgptLibraryNavigation.create().navigate(h.payload)).reason, 'superseded');
});

// Native-search delegates presentation to ChatGPT. These fixtures model the
// router's own URL mutation, never a Tidy history.pushState or sidebar mutation.
function nativeHarness(options = {}) {
  let h;
  h = harness({ ...options, navigate(route) {
    const pending = options.navigate?.(route, h);
    if (options.commitRoute !== false) h.location.href = new URL(route, 'https://chatgpt.com').href;
    return pending;
  } });
  h.search = patch => h.open({ placement: 'native-search', messageId: 'm1', query: 'needle', ...patch });
  return h;
}
const nativeSuccess = { navigated: true, reason: 'native-router', presentationOwner: 'native' };

test('native search uses the official search route and never claims a Tidy-located message', async () => {
  const h = nativeHarness();
  const receipt = await h.search();
  assert.deepEqual(receipt, nativeSuccess);
  assert.deepEqual(h.calls.routes, ['/c/target?src=history_search&messageId=m1&historySearchQuery=needle']);
  assert.equal(h.calls.latest.length, 0, 'the native search controller owns positioning');
  assert.equal(Object.hasOwn(receipt, 'located'), false, 'routing acknowledgement does not prove viewport placement');
  assert.equal(Object.hasOwn(receipt, 'highlighted'), false, 'Tidy did not paint a highlight');
  assert.equal(h.pendingTimers(), 0, 'a completed acknowledgement releases its timer');
});

test('native search encodes query and message as parameters without allowing path or query injection', async () => {
  const h = nativeHarness();
  const query = '  亲切 & src=evil # / ? % + "snowman☃"  ';
  const messageId = 'message&historySearchQuery=forged#fragment?/';
  assert.deepEqual(await h.search({ pathname: '/g/g-p-project/c/target', query, messageId }), nativeSuccess);
  const route = new URL(h.calls.routes[0], 'https://chatgpt.com');
  assert.equal(route.origin, 'https://chatgpt.com');
  assert.equal(route.pathname, '/g/g-p-project/c/target');
  assert.equal(route.hash, '');
  assert.deepEqual([...route.searchParams.keys()], ['src', 'messageId', 'historySearchQuery']);
  assert.equal(route.searchParams.get('src'), 'history_search');
  assert.equal(route.searchParams.get('messageId'), messageId);
  assert.equal(route.searchParams.get('historySearchQuery'), query.trim());
});

test('native search rejects malformed mode, query and message metadata before touching identity or router', async () => {
  for (const patch of [
    { placement: 'invented' }, { placement: {} }, { query: '' }, { query: '  ' }, { query: null },
    { query: 4 }, { query: 'a'.repeat(501) }, { messageId: '' }, { messageId: '  ' },
    { messageId: 4 }, { messageId: {} }, { messageId: 'a'.repeat(257) },
    { messageId: 'message' + String.fromCharCode(10) }, { messageId: String.fromCharCode(127) },
  ]) {
    const h = nativeHarness();
    assert.deepEqual(await h.search(patch), { navigated: false, reason: 'invalid-target' }, JSON.stringify(patch));
    assert.equal(h.calls.reads, 0);
    assert.equal(h.calls.routes.length, 0);
    assert.equal(h.calls.timers.length, 0);
  }
});

test('native title-only hits keep the official search entrance without fabricating messageId', async () => {
  for (const messageId of [null, undefined]) {
    const h = nativeHarness();
    assert.deepEqual(await h.search({ messageId }), nativeSuccess);
    const route = new URL(h.calls.routes[0], 'https://chatgpt.com');
    assert.equal(route.searchParams.has('messageId'), false);
    assert.equal(route.searchParams.get('src'), 'history_search');
    assert.equal(route.searchParams.get('historySearchQuery'), 'needle');
    assert.equal(h.calls.latest.length, 0);
  }
});

test('native search and latest conversation commands cannot leak presentation into each other', async () => {
  const h = nativeHarness();
  await h.search();
  const date = await h.open({ placement: 'latest', navigationIntentId: 'date-intent', messageId: 'irrelevant', query: 'retained query' });
  assert.equal(date.reason, 'native-router');
  assert.equal(h.calls.routes[1], '/c/target', 'date navigation clears the previous search route');
  assert.equal(h.calls.latest.length, 1);
  assert.equal(h.calls.latest[0].navigationIntentId, 'date-intent');
  await h.search({ navigationIntentId: 'keyword-again', messageId: 'm2' });
  assert.equal(h.calls.latest.length, 1, 'returning to keyword search does not invoke the latest locator');
  assert.equal(new URL(h.calls.routes[2], 'https://chatgpt.com').searchParams.get('messageId'), 'm2');
});

test('different messages of the same conversation and query each dispatch their own native search route', async () => {
  const h = nativeHarness({ href: 'https://chatgpt.com/c/target' });
  for (const [index, messageId] of ['m1', 'm2', 'm3', 'm1'].entries()) {
    assert.deepEqual(await h.search({ messageId, navigationIntentId: 'intent-' + index }), nativeSuccess);
  }
  assert.equal(h.calls.routes.length, 4);
  assert.deepEqual(h.calls.routes.map(route => new URL(route, 'https://chatgpt.com').searchParams.get('messageId')), ['m1', 'm2', 'm3', 'm1']);
  assert.equal(h.calls.latest.length, 0);
});

test('different queries with one conversation and message are not collapsed as the same search', async () => {
  const h = nativeHarness({ href: 'https://chatgpt.com/c/target' });
  await h.search({ query: 'first', navigationIntentId: 'intent-first' });
  await h.search({ query: 'second', navigationIntentId: 'intent-second' });
  assert.deepEqual(h.calls.routes.map(route => new URL(route, 'https://chatgpt.com').searchParams.get('historySearchQuery')), ['first', 'second']);
});

test('same native search intent shares one pending router call and one timeout', async () => {
  const hold = deferred();
  const h = nativeHarness({ navigate: () => hold.promise });
  const payload = { ...h.payload, placement: 'native-search', messageId: 'm1', query: 'needle' };
  const first = h.adapter.navigate(payload);
  const duplicate = h.adapter.navigate({ ...payload });
  assert.equal(first, duplicate);
  await flush();
  assert.equal(h.calls.routes.length, 1);
  assert.equal(h.calls.timers.length, 1);
  hold.resolve();
  assert.deepEqual(plain(await first), nativeSuccess);
  assert.equal(h.pendingTimers(), 0);
});

test('new intent taking over the same pending native route leaves the old receipt superseded', async () => {
  const hold = deferred(); let current = 'intent-a';
  const h = nativeHarness({ commitRoute: false, isIntentCurrent: id => id === current, navigate: () => hold.promise });
  const first = h.search(); await flush();
  current = 'intent-b';
  const second = h.search({ navigationIntentId: current }); await flush();
  assert.equal(h.calls.routes.length, 1, 'exact pending route can share its dispatch, not its ownership');
  h.location.href = new URL(h.calls.routes[0], 'https://chatgpt.com').href;
  hold.resolve();
  assert.deepEqual(await first, { navigated: false, reason: 'superseded' });
  assert.deepEqual(await second, nativeSuccess);
  assert.equal(h.calls.latest.length, 0);
});

test('a newer different native hit wins while the earlier router Promise is still pending', async () => {
  const firstRoute = deferred(), nextRoute = deferred(); let current = 'intent-a';
  const h = nativeHarness({ commitRoute: false, isIntentCurrent: id => id === current,
    navigate: route => new URL(route, 'https://chatgpt.com').searchParams.get('messageId') === 'm1' ? firstRoute.promise : nextRoute.promise });
  const first = h.search(); await flush();
  current = 'intent-b';
  const second = h.search({ navigationIntentId: current, messageId: 'm2' }); await flush();
  assert.equal(h.calls.routes.length, 2);
  h.location.href = new URL(h.calls.routes[1], 'https://chatgpt.com').href;
  nextRoute.resolve(); assert.deepEqual(await second, nativeSuccess);
  firstRoute.resolve(); assert.deepEqual(await first, { navigated: false, reason: 'superseded' });
  assert.equal(h.pendingTimers(), 0);
});

test('native search router rejection is not a successful or located acknowledgement', async () => {
  for (const navigate of [() => { throw Error('native failure'); }, () => Promise.reject(Error('native failure'))]) {
    const h = nativeHarness({ navigate });
    const result = await h.search();
    assert.deepEqual(result, { navigated: false, reason: 'native-router-failed' });
    assert.equal(h.calls.routes.length, 1);
    assert.equal(h.calls.latest.length, 0);
    assert.equal(h.pendingTimers(), 0);
    assert.equal(Object.hasOwn(result, 'located'), false);
  }
});

test('native search with a never-settling router finishes at the bounded acknowledgement deadline', async () => {
  const h = nativeHarness({ navigate: () => new Promise(() => {}) });
  let settled = false;
  const pending = h.search().then(result => { settled = true; return result; });
  await flush();
  assert.equal(settled, false);
  assert.equal(h.calls.timers.length, 1);
  assert.equal(h.calls.timers[0].delay, h.context.TidyChatgptLibraryNavigation.NATIVE_SEARCH_WINDOW_MS);
  assert.ok(h.calls.timers[0].delay > 0 && h.calls.timers[0].delay <= 30_000);
  h.fireTimer();
  assert.deepEqual(await pending, { navigated: false, reason: 'native-router-failed' });
  assert.equal(h.pendingTimers(), 0);
  assert.equal(h.calls.routes.length, 1, 'no full-page or repeated native navigation');
  assert.equal(h.calls.latest.length, 0);
});

test('a resolved native router that never reached the target conversation is not acknowledged', async () => {
  const h = nativeHarness({ commitRoute: false });
  assert.deepEqual(await h.search(), { navigated: false, reason: 'native-route-unconfirmed' });
  assert.equal(h.calls.routes.length, 1);
  assert.equal(h.calls.latest.length, 0);
});

test('official canonicalization may consume search parameters and resolve a normal route into its project', async () => {
  const h = nativeHarness({ commitRoute: false, navigate: (_route, state) => { state.location.href = 'https://chatgpt.com/g/g-p-project/c/target'; } });
  assert.deepEqual(await h.search(), nativeSuccess);
  assert.equal(h.calls.routes.length, 1);
  assert.equal(h.calls.latest.length, 0);
});

test('native search does not acknowledge an external redirect even with the same conversation path', async () => {
  const h = nativeHarness({ commitRoute: false, navigate: (_route, state) => { state.location.href = 'https://evil.test/c/target'; } });
  assert.deepEqual(await h.search(), { navigated: false, reason: 'native-route-unconfirmed' });
});

for (const staleParams of [
  '?src=history_search&messageId=wrong&historySearchQuery=needle',
  '?src=history_search&messageId=m1&historySearchQuery=wrong',
  '?src=history_search&messageId=wrong',
  '?src=history_search&historySearchQuery=wrong',
]) test('same-conversation native acknowledgement rejects stale hit parameters: ' + staleParams, async () => {
  const h = nativeHarness({ href: 'https://chatgpt.com/c/target' + staleParams, commitRoute: false });
  assert.deepEqual(await h.search(), { navigated: false, reason: 'native-route-unconfirmed' });
  assert.equal(h.calls.routes.length, 1);
  assert.equal(h.calls.latest.length, 0);
});

test('official route may clear one-time message and query parameters while keeping the search source', async () => {
  const h = nativeHarness({ commitRoute: false, navigate: (_route, state) => {
    state.location.href = 'https://chatgpt.com/c/target?src=history_search';
  } });
  assert.deepEqual(await h.search(), nativeSuccess);
  assert.equal(h.calls.routes.length, 1);
});

test('native search rechecks account after router settlement', async () => {
  const hold = deferred();
  const h = nativeHarness({ navigate: () => hold.promise });
  const pending = h.search(); await flush();
  h.identity.accountKey = '["other","personal"]';
  hold.resolve();
  assert.deepEqual(await pending, { navigated: false, reason: 'context-mismatch' });
  assert.equal(h.calls.routes.length, 1);
  assert.equal(h.calls.latest.length, 0);
});

// Exercise the real page intent gate: soft initialization preserves ownership,
// whereas a confirmed account change leaves a tombstone even after returning.
function nativePageGateHarness(options = {}) {
  let gate;
  const h = nativeHarness({ ...options, isIntentCurrent: id => gate?.isCurrent(id) === true });
  for (const file of ['src/platform/navigation/chatgpt/navigation-intent.js']) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), h.context);
  }
  const revoked = [];
  gate = h.context.TidyChatgptNavigationIntent.create({
    parseRoute: () => ({ conversationId: new URL(h.location.href).pathname.split('/').at(-1) }),
    readIdentity: () => ({ ...h.identity }), onRevoked: event => revoked.push(plain(event)),
  });
  const control = { navigationIntentId: h.payload.navigationIntentId, workerEpoch: 1, sequence: 1,
    conversationId: h.payload.conversationId, phase: 'active', ownerAccountKey: OWNER };
  assert.equal(gate.observe(control).accepted, true);
  return { ...h, gate, control, revoked, changeIdentity(identity) {
    Object.assign(h.identity, { accountKey: null, transition: null }, identity);
    gate.observeIdentity({ ...h.identity });
  } };
}

test('real page gate preserves native acknowledgement through same-account workspace restoration and epoch advance', async () => {
  const hold = deferred();
  const h = nativePageGateHarness({ navigate: () => hold.promise });
  const pending = h.search(); await flush();
  for (const [epoch, transition] of [[5, 'workspace-unconfirmed'], [6, 'workspace-restored']]) {
    h.changeIdentity({ phase: 'unavailable', epoch, transition });
    assert.equal(h.gate.isCurrent(h.payload.navigationIntentId), true);
    assert.equal(h.gate.canPresent(h.payload.navigationIntentId), false);
  }
  h.changeIdentity({ phase: 'ready', epoch: 7, accountKey: OWNER });
  assert.equal(h.gate.canPresent(h.payload.navigationIntentId), true);
  assert.equal(h.revoked.length, 0);
  hold.resolve();
  assert.deepEqual(await pending, nativeSuccess);
  assert.equal(h.calls.routes.length, 1);
});

test('real page gate keeps A-to-B-to-A cancellation tombstone when an old native route finally resolves', async () => {
  const hold = deferred();
  const h = nativePageGateHarness({ navigate: () => hold.promise });
  const pending = h.search(); await flush();
  h.changeIdentity({ phase: 'ready', epoch: 5, accountKey: '["other","personal"]' });
  assert.equal(h.gate.isCurrent(h.payload.navigationIntentId), false);
  h.changeIdentity({ phase: 'ready', epoch: 6, accountKey: OWNER });
  assert.equal(h.gate.observe(h.control).accepted, false, 'late active packets cannot reinstall a cancelled click');
  assert.equal(h.gate.canPresent(h.payload.navigationIntentId), false);
  assert.deepEqual(h.revoked.map(event => event.reason), ['identity-changed']);
  hold.resolve();
  assert.deepEqual(await pending, { navigated: false, reason: 'superseded' });
  assert.equal(h.calls.routes.length, 1);
  assert.equal(h.calls.latest.length, 0);
});

for (const pathname of ['/g/g-custom/c/target', '/unexpected/c/target']) {
  test('native acknowledgement rejects unsupported canonical conversation path ' + pathname, async () => {
    const h = nativeHarness({ commitRoute: false, navigate: (_route, state) => {
      state.location.href = 'https://chatgpt.com' + pathname + '?src=history_search';
    } });
    assert.deepEqual(await h.search(), { navigated: false, reason: 'native-route-unconfirmed' });
    assert.equal(h.calls.routes.length, 1);
    assert.equal(h.calls.latest.length, 0);
  });
}

for (const loadDeadlineAt of [999, 1000]) test('expired native load deadline is rejected before identity read: ' + loadDeadlineAt, async () => {
  const h = nativeHarness();
  assert.deepEqual(await h.search({ loadDeadlineAt }), { navigated: false, reason: 'native-router-timeout' });
  assert.equal(h.calls.reads, 0);
  assert.equal(h.calls.routes.length, 0);
  assert.equal(h.calls.timers.length, 0);
});

test('native router acknowledgement receives only the absolute budget remaining after identity wait', async () => {
  const identity = deferred();
  const h = nativeHarness({ read: () => identity.promise, navigate: () => new Promise(() => {}) });
  const pending = h.search({ loadDeadlineAt: 5000 }); await flush();
  assert.equal(h.calls.reads, 1);
  assert.equal(h.calls.routes.length, 0);
  h.setTime(4500);
  identity.resolve({ accountKey: OWNER, epoch: 4, phase: 'ready' }); await flush();
  assert.equal(h.calls.routes.length, 1);
  assert.equal(h.calls.timers.length, 1);
  assert.equal(h.calls.timers[0].delay, 500, 'identity lookup cannot renew the original deadline');
  h.setTime(5000); h.fireTimer();
  assert.deepEqual(await pending, { navigated: false, reason: 'native-router-failed' });
  assert.equal(h.pendingTimers(), 0);
});

test('identity read exhausting the absolute budget cannot dispatch a native route afterwards', async () => {
  const identity = deferred();
  const h = nativeHarness({ read: () => identity.promise });
  const pending = h.search({ loadDeadlineAt: 1500 }); await flush();
  h.setTime(1500);
  identity.resolve({ accountKey: OWNER, epoch: 4, phase: 'ready' });
  assert.deepEqual(await pending, { navigated: false, reason: 'native-router-timeout' });
  assert.equal(h.calls.reads, 1);
  assert.equal(h.calls.routes.length, 0);
  assert.equal(h.calls.timers.length, 0);
});

test('router discovery cannot spend the remaining deadline and still dispatch a native route', async () => {
  let h;
  h = nativeHarness({ getRouter: () => { h.setTime(2000); return h.router; } });
  assert.deepEqual(await h.search({ loadDeadlineAt: 2000 }), { navigated: false, reason: 'native-router-timeout' });
  assert.equal(h.calls.reads, 1);
  assert.equal(h.calls.routes.length, 0);
  assert.equal(h.calls.timers.length, 0);
});

test('a later absolute deadline cannot expand the native router window beyond thirty seconds', async () => {
  const h = nativeHarness({ navigate: () => new Promise(() => {}) });
  const pending = h.search({ loadDeadlineAt: 100000 }); await flush();
  assert.equal(h.calls.timers.length, 1);
  assert.equal(h.calls.timers[0].delay, 30000);
  h.fireTimer();
  assert.deepEqual(await pending, { navigated: false, reason: 'native-router-failed' });
  assert.equal(h.pendingTimers(), 0);
});

test('real page gate permits a native receipt during workspace confirmation while later account change still revokes it', async () => {
  const hold = deferred();
  const h = nativePageGateHarness({ navigate: () => hold.promise });
  const pending = h.search(); await flush();
  h.changeIdentity({ phase: 'unavailable', epoch: 5, transition: 'workspace-unconfirmed' });
  assert.equal(h.gate.isCurrent(h.payload.navigationIntentId), true);
  assert.equal(h.gate.canPresent(h.payload.navigationIntentId), false);
  hold.resolve();
  const receipt = await pending;
  assert.deepEqual(receipt, nativeSuccess, 'an accepted native route is not a claim that Tidy may present during identity recovery');
  assert.equal(Object.hasOwn(receipt, 'located'), false);
  assert.equal(Object.hasOwn(receipt, 'highlighted'), false);
  assert.equal(h.calls.latest.length, 0);
  assert.equal(h.gate.isCurrent(h.payload.navigationIntentId), true);
  assert.equal(h.gate.canPresent(h.payload.navigationIntentId), false);
  h.changeIdentity({ phase: 'ready', epoch: 6, accountKey: '["other","personal"]' });
  assert.equal(h.gate.isCurrent(h.payload.navigationIntentId), false);
  assert.deepEqual(h.revoked.map(event => event.reason), ['identity-changed']);
  h.changeIdentity({ phase: 'ready', epoch: 7, accountKey: OWNER });
  assert.equal(h.gate.observe(h.control).accepted, false);
  assert.deepEqual(await h.search(), { navigated: false, reason: 'superseded' });
  assert.equal(h.calls.routes.length, 1, 'the completed native receipt cannot revive or repeat the revoked command');
  assert.equal(h.calls.latest.length, 0);
});
