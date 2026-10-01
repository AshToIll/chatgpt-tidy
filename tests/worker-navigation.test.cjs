const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const ownerModule = import('../src/platform/navigation/background/worker-navigation.js');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const OWNER = '["navigation-user","personal"]';

// Real ESM owner/dependency graph; only browser transport and library reads
// are synthetic. No source stripping, ticket probe or mutable-state injection.
async function harness(t, { locate, send, bind, rawReply, readAccount } = {}) {
  const { createWorkerNavigation } = await ownerModule;
  await import('../src/features/search/model/search.js');
  const protocol = globalThis.TidyProtocol;
  const calls = [], events = [];
  let tab = { id: 31, url: 'https://chatgpt.com/c/origin' };
  let identity = Object.freeze({ documentId: 'source', epoch: 1, phase: 'ready', accountKey: OWNER });
  const owner = createWorkerNavigation({
    searchContract: globalThis.TidySearch,
    chrome: {
      runtime: { sendMessage: async envelope => { events.push(structuredClone(envelope)); } },
      tabs: {
        update: async (id, update) => { calls.push({ type: 'update', id, ...update }); },
        sendMessage: async (id, envelope, target) => {
          calls.push({ type: envelope.type, id, target, payload: structuredClone(envelope.payload) });
          if (rawReply) {
            const response = await rawReply(envelope, protocol);
            if (response !== undefined) return response;
          }
          return protocol.response(envelope, await send?.(envelope) || { accepted: true, navigated: true,
            ...(envelope.payload?.placement === 'native-search' ? { presentationOwner: 'native' } : {}) });
        },
      },
    },
    allocateNavigationEpoch: async () => 3,
    navigationSenderTab: (payload, sender) => sender?.tab?.id || payload.expectedTabId || 31,
    getBoundTab: async () => await bind?.() || tab,
    libraryDocument: async () => identity,
    readLibraryAccount: async target => readAccount ? await readAccount({ accountKey: OWNER, identity }, target) : { accountKey: OWNER, identity },
    readLibraryIdentity: () => identity,
    assertLibraryContext: context => {
      assert.equal(context.identity, identity, 'library lease must still be current');
    },
    requestTabMessageLocation: async (target, payload, documentId) => {
      calls.push({ type: 'locate', target, payload: structuredClone(payload), documentId });
      return await locate?.(payload) || { located: false, pending: true, targetPresent: true, reason: 'settling' };
    },
  });
  t.after(() => { owner.closeTab(31); owner.closeTab(32); });
  const request = (id = 'click', patch = {}, type = protocol.Type.SEARCH_OPEN_RESULT) => protocol.request(type, {
    expectedTabId: 31, navigationIntentId: id, conversationId: 'destination', messageId: 'message', resultId: 'hit', query: 'needle',
    ...(type !== protocol.Type.SEARCH_OPEN_RESULT ? { expectedAccountKey: OWNER, expectedIdentity: identity } : { navigationKind: 'keyword' }), ...patch,
  });
  const context = handle => ({ navigationHandle: handle, tab, identity, accountKey: OWNER, record: identity });
  return { owner, calls, events, request, context, protocol,
    setDocument(documentId, url = 'https://chatgpt.com/c/destination') {
      tab = { ...tab, url };
      identity = Object.freeze({ ...identity, documentId });
    },
    setIdentity(patch) { identity = Object.freeze({ ...identity, ...patch }); },
  };
}

test('ESM owner returns immutable opaque handles; clones and other instances have no ticket authority', async t => {
  const h = await harness(t), other = await harness(t);
  const envelope = h.request(), handle = h.owner.begin(envelope, {});
  assert.deepEqual(Object.keys(handle).sort(), ['id', 'tabId']);
  assert.ok(Object.isFrozen(handle));
  assert.ok(Object.isFrozen(h.owner));
  assert.equal(h.owner.begin(envelope, {}), handle, 'same admitted click reuses the same opaque handle');
  assert.equal(Reflect.set(handle, 'cancelled', false), false);
  assert.equal(Reflect.set(handle, 'deadlineAt', Infinity), false);
  assert.throws(() => h.owner.assertCurrent({ ...handle }), { tidyCode: 'CONTEXT_MISMATCH' });
  assert.throws(() => other.owner.assertCurrent(handle), { tidyCode: 'CONTEXT_MISMATCH' });
  const changed = h.request('click', { messageId: 'different' });
  assert.throws(() => h.owner.begin(changed, {}), /retired navigation ID/);
  h.owner.assertCurrent(handle);
  const latest = h.owner.begin(h.request('new-click'), {});
  assert.throws(() => h.owner.assertCurrent(handle), /newer library navigation/);
  h.owner.fail(handle);
  h.owner.assertCurrent(latest);
  h.owner.closeTab(31);
  assert.throws(() => h.owner.assertCurrent(latest), /newer library navigation/);
});

test('tab-scoped handles retire independently and failed ingress cannot consume the current click', async t => {
  const h = await harness(t);
  const first = h.owner.begin(h.request('one'), {});
  const second = h.owner.begin(h.request('two', { expectedTabId: 32 }), {});
  assert.throws(() => h.owner.begin(h.request('bad', { conversationId: 'bad/path' }), {}), /target is invalid/);
  h.owner.assertCurrent(first);
  h.owner.assertCurrent(second);
  h.owner.closeTab(31);
  h.owner.assertCurrent(second);
});

test('duplicate keyword OPEN shares one native handoff without a custom locator or landing timer', async t => {
  const entered = deferred(), held = deferred();
  const h = await harness(t, { send: envelope => {
    if (envelope.type === 'library.navigate') { entered.resolve(); return held.promise; }
    return { accepted: true };
  } });
  const envelope = h.request(), handle = h.owner.begin(envelope, {});
  const first = h.owner.openSearch(handle, envelope.payload, {});
  await entered.promise;
  const second = h.owner.openSearch(h.owner.begin(envelope, {}), envelope.payload, {});
  held.resolve({ navigated: true, reason: 'native-router', presentationOwner: 'native' });
  const result = await first;
  assert.deepEqual(result, await second);
  assert.equal(result.navigated, true);
  assert.equal(result.presentationOwner, 'native');
  assert.equal(result.mode, 'same-document');
  assert.equal(Object.hasOwn(result, 'located'), false, 'A native dispatch is not proof of a visual landing');
  assert.equal(result.pending === true, false, 'The worker must not promise a later custom landing receipt');
  const calls = h.calls.filter(call => call.type === 'library.navigate');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target.documentId, 'source');
  assert.equal(calls[0].payload.placement, 'native-search');
  assert.equal(calls[0].payload.messageId, 'message');
  assert.equal(calls[0].payload.query, 'needle');
  assert.equal(h.calls.some(call => call.type === 'locate' || call.type === 'update'), false);
  assert.equal(h.events.some(event => event.type === 'navigation.result'), false);
});

test('Favorite admission revokes bookmark navigation and dispatches latest without any bookmark message ID', async t => {
  const h = await harness(t);
  const oldEnvelope = h.request('old-bookmark', { bookmarkId: 'destination::old' }, 'bookmarks.open');
  const old = h.owner.begin(oldEnvelope, {});
  await h.owner.prepare(old, h.context(old).tab, h.context(old).identity);
  await h.owner.selectBookmark(old, { conversationId: 'destination', messageId: 'old' });
  const favorite = h.owner.begin(h.request('favorite', {}, 'favorites.open'), {});
  await h.owner.prepare(favorite, h.context(favorite).tab, h.context(favorite).identity);
  await h.owner.openLibrary(h.context(favorite), '/c/destination', 'destination');
  assert.throws(() => h.owner.assertCurrent(old));
  const sent = h.calls.filter(call => call.type === 'library.navigate').at(-1);
  assert.equal(sent.payload.placement, 'latest'); assert.equal(sent.payload.messageId, undefined);
  assert.equal(sent.payload.navigationIntentId, 'favorite');
  assert.ok(sent.payload.deadlineAt > sent.payload.loadDeadlineAt);
  const control = h.calls.filter(call => call.type === 'navigation.intent' && call.payload.navigationIntentId === 'favorite').at(-1);
  assert.equal(control.payload.ownerAccountKey, OWNER);
  assert.equal(h.calls.filter(call => call.type === 'locate').length, 0, 'Favorites do not invoke bookmark message lookup');
});

test('Favorite clean-URL fallback resumes once in the exact destination with the original deadline', async t => {
  let source = true;
  const h = await harness(t, { send: envelope => envelope.type === 'library.navigate'
    ? source ? { navigated: false, reason: 'native-router-unavailable' } : { navigated: true, reason: 'already-current' } : { accepted: true } });
  const handle = h.owner.begin(h.request('favorite', {}, 'favorites.open'), {});
  await h.owner.prepare(handle, h.context(handle).tab, h.context(handle).identity);
  await h.owner.openLibrary(h.context(handle), '/c/destination', 'destination');
  const first = h.calls.find(call => call.type === 'library.navigate');
  assert.equal(h.calls.find(call => call.type === 'update').url, 'https://chatgpt.com/c/destination');
  source = false; h.setDocument('destination-document');
  h.owner.committed({ tabId: 31, frameId: 0, documentId: 'destination-document', url: 'https://chatgpt.com/c/destination' });
  await h.owner.resume(31); await h.owner.resume(31);
  const navigation = h.calls.filter(call => call.type === 'library.navigate');
  assert.equal(navigation.length, 2); assert.equal(navigation[1].target.documentId, 'destination-document');
  assert.equal(navigation[1].payload.deadlineAt, first.payload.deadlineAt);
  assert.equal(h.calls.filter(call => call.type === 'update').length, 1);
  h.owner.acceptResult({ navigationIntentId: 'favorite', conversationId: 'destination', messageId: 'old-bookmark',
    placement: 'latest', pending: false, located: true }, { tab: { id: 31 }, documentId: 'destination-document' });
  assert.equal(h.events.filter(event => event.type === 'navigation.result').length, 0);
  h.owner.acceptResult({ navigationIntentId: 'favorite', conversationId: 'destination', messageId: null,
    placement: 'latest', pending: false, located: true }, { tab: { id: 31 }, documentId: 'destination-document' });
  assert.equal(h.events.filter(event => event.type === 'navigation.result').length, 1);
});

test('one browser-proven bookmark destination resumes the same opaque click and original absolute deadlines', async t => {
  let mounted = false;
  const h = await harness(t, { locate: () => ({ located: false, pending: mounted, targetPresent: mounted }),
    send: envelope => envelope.type === 'library.navigate' ? { navigated: false, reason: 'native-router-unavailable' } : { accepted: true } });
  const envelope = h.request('bookmark', { bookmarkId: 'destination::message' }, h.protocol.Type.BOOKMARKS_OPEN);
  const handle = h.owner.begin(envelope, {}), context = h.context(handle);
  await h.owner.prepare(handle, context.tab, context.identity);
  await h.owner.selectBookmark(handle, { conversationId: 'destination', messageId: 'message' });
  const opened = await h.owner.openBookmark(handle, context.tab, '/c/destination');
  assert.equal(opened.mode, 'full-page');
  const source = h.calls.find(call => call.type === 'locate');
  const destination = h.calls.find(call => call.type === 'update').url;
  // Source pagehide is not revocation of the destination command.
  h.owner.identityChanged({ phase: 'unavailable', accountKey: null, epoch: 2, transition: 'document-hidden' },
    { tab: { id: 31 }, documentId: 'source' }, 1);
  h.owner.assertCurrent(handle);
  h.owner.committed({ tabId: 31, frameId: 0, documentId: 'destination-doc', url: destination });
  h.setDocument('destination-doc');
  mounted = true;
  await Promise.all([h.owner.resume(31), h.owner.resume(31)]);
  const locations = h.calls.filter(call => call.type === 'locate');
  assert.equal(locations.length, 2);
  assert.equal(locations[1].documentId, 'destination-doc');
  assert.equal(locations[1].payload.navigationIntentId, handle.id);
  assert.equal(locations[1].payload.deadlineAt, source.payload.deadlineAt);
  assert.equal(locations[1].payload.loadDeadlineAt, source.payload.loadDeadlineAt);
  assert.equal(h.calls.filter(call => call.type === 'update').length, 1);
});

test('bookmark completion requires exact identity/target and remains cancellable after its sole terminal receipt', async t => {
  const h = await harness(t);
  const envelope = h.request('bookmark', { bookmarkId: 'destination::message' }, h.protocol.Type.BOOKMARKS_OPEN);
  const handle = h.owner.begin(envelope, {}), context = h.context(handle);
  await h.owner.prepare(handle, context.tab, context.identity);
  await h.owner.selectBookmark(handle, { conversationId: 'destination', messageId: 'message' });
  await h.owner.openBookmark(handle, context.tab, '/c/destination');
  const sender = { tab: { id: 31 }, documentId: 'source' };
  const receipt = { navigationIntentId: handle.id, conversationId: 'destination', messageId: 'message',
    pending: false, located: true, highlighted: false, highlightReason: 'keyword-not-present' };
  h.owner.acceptResult(receipt, { ...sender, documentId: 'other' });
  h.owner.acceptResult({ ...receipt, messageId: 'other' }, sender);
  h.setIdentity({ accountKey: '["other","personal"]' });
  h.owner.acceptResult(receipt, sender);
  assert.equal(h.events.filter(event => event.type === 'navigation.result').length, 0);
  h.setIdentity({ accountKey: OWNER });
  h.owner.acceptResult(receipt, sender);
  h.owner.acceptResult(receipt, sender);
  h.owner.fail(handle); // a completed receipt is not a failed OPEN to retire
  h.owner.assertCurrent(handle);
  const receipts = h.events.filter(event => event.type === 'navigation.result');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].payload.located, true);
  assert.equal(receipts[0].payload.highlighted, false);
  assert.equal(h.owner.cancel({ navigationIntentId: handle.id }, {}).cancelled, true);
  assert.throws(() => h.owner.assertCurrent(handle), /newer library navigation/);
});

test('library dispatch owns its in-flight operation without mutating a frozen library lease', async t => {
  const entered = deferred(), held = deferred();
  const h = await harness(t, { send: envelope => {
    if (envelope.type === 'library.navigate') { entered.resolve(); return held.promise; }
    return { accepted: true };
  } });
  const envelope = h.request('favorite', {}, 'favorites.open'), handle = h.owner.begin(envelope, {});
  const context = h.context(handle);
  await h.owner.prepare(handle, context.tab, context.identity);
  const before = structuredClone(context.record);
  const first = h.owner.openLibrary(context, '/c/destination', 'destination');
  await entered.promise;
  const second = h.owner.openLibrary(context, '/c/destination', 'destination');
  held.resolve({ navigated: false, reason: 'native-router-unavailable' });
  assert.equal(await first, 'full-page');
  assert.equal(await second, 'full-page');
  assert.equal(await h.owner.openLibrary(context, '/c/destination', 'destination'), 'full-page');
  assert.equal(h.calls.filter(call => call.type === 'library.navigate').length, 1);
  assert.equal(h.calls.filter(call => call.type === 'update').length, 1);
  assert.deepEqual(context.record, before);
  assert.equal(Object.hasOwn(context.record, 'navigation'), false);
});

test('worker only coordinates handles and events; navigation storage and timers have one source owner', () => {
  const worker = fs.readFileSync('src/app/background/service-worker.js', 'utf8');
  assert.match(worker, /import \{ createWorkerNavigation \} from "\.\.\/\.\.\/platform\/navigation\/background\/worker-navigation.js"/);
  assert.doesNotMatch(worker, /navigationIntents|navigationDocuments|navigationSequence|deadlineTimer|\.record\.navigation/);
  assert.doesNotMatch(worker, /navigationHandle\.[A-Za-z]+\s*=/);
  const owners = {
    'src/app/background/request-router.js': ['begin', 'prepare'],
    'src/app/background/handlers/navigation.js': ['openSearch'],
    'src/app/background/handlers/bookmarks.js': ['selectBookmark', 'openBookmark', 'openLibrary'],
    'src/app/background/handlers/favorites.js': ['openLibrary'],
    'src/app/background/service-worker.js': ['identityChanged', 'resume'],
    'src/app/background/browser-lifecycle.js': ['committed', 'closeTab'],
    'src/app/background/runtime-messages.js': ['acceptResult', 'cancel'],
  };
  for (const [file, operations] of Object.entries(owners)) {
    const module = fs.readFileSync(file, 'utf8');
    for (const operation of operations) assert.ok(module.includes('navigation.' + operation + '('), file + ': ' + operation);
    assert.doesNotMatch(module, /navigationIntents|navigationDocuments|navigationSequence|deadlineTimer|\.record\.navigation/);
    assert.doesNotMatch(module, /navigationHandle\.[A-Za-z]+\s*=/);
    assert.doesNotMatch(module, /navigation\.acceptNative\(/, 'Official history-search URLs must not be nominated for Tidy positioning');
  }
});

test('complete production worker ESM boot routes navigation and library leases without import shims', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { IDBFactory } from 'fake-indexeddb';
    globalThis.indexedDB = new IDBFactory();
    const event = () => ({ addListener(callback) { this.run = callback; } });
    const calls = [];
    const ownerKey = '["esm-user","personal"]';
    const tab = { id: 31, windowId: 1, url: 'https://chatgpt.com/c/origin' };
    globalThis.chrome = {
      runtime: { getURL: path => 'chrome-extension://tidy-test/' + (path.startsWith('/') ? path.slice(1) : path),
        onInstalled: event(), onStartup: event(), onMessage: event(), onConnect: event(),
        sendMessage: async envelope => { calls.push(envelope.type); } },
      tabs: { onUpdated: event(), onActivated: event(), onRemoved: event(),
        get: async id => { assert.equal(id, 31); return tab; }, query: async () => [tab],
        update: async (id, update) => { calls.push({ id, ...update }); },
        sendMessage: async (id, envelope, target) => {
          assert.equal(id, 31); assert.equal(target.documentId, 'source-document');
          if (envelope.type === 'page-session.probe') return TidyProtocol.response(envelope, { ready: true });
          if (envelope.type === 'library.account') {
            calls.push(envelope.type);
            return TidyProtocol.response(envelope, { accountKey: ownerKey, epoch: 1 });
          }
          if (envelope.type === 'library.identity-changed') return;
          if (envelope.type === 'library.navigate') {
            assert.equal(envelope.payload.placement, 'latest');
            assert.equal(envelope.payload.messageId, undefined);
            calls.push(envelope.type);
            return TidyProtocol.response(envelope, { navigated: true, reason: 'native-router' });
          }
          assert.equal(envelope.type, 'navigation.intent');
          calls.push(envelope.type);
          return TidyProtocol.response(envelope, { accepted: true });
        } },
      sidePanel: { setPanelBehavior: async () => {},
        getOptions: async () => ({ enabled: true, path: 'app/sidepanel/index.html?tidyTabId=31' }) },
      webNavigation: { onHistoryStateUpdated: event(), onCommitted: event(),
        getFrame: async () => ({ documentId: 'source-document', documentLifecycle: 'active', url: tab.url }) },
      storage: { onChanged: event() },
    };
    await import('./src/app/background/service-worker.js');
    const envelope = TidyProtocol.request(TidyProtocol.Type.SEARCH_OPEN_RESULT, {
      expectedTabId: 31, navigationIntentId: 'esm-boot-click', conversationId: 'destination',
      resultId: 'date-result', messageId: null, navigationKind: 'conversation',
    });
    const result = await new Promise(resolve => {
      const accepted = chrome.runtime.onMessage.run(envelope,
        { url: 'chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=31' }, resolve);
      assert.equal(accepted, true);
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.payload.navigationIntentId, 'esm-boot-click');
    assert.equal(result.payload.reason, 'loading-conversation');
    assert.equal(result.payload.located, false);
    assert.equal(result.payload.pending, true);
    assert.equal(result.payload.mode, 'same-document');
    assert.deepEqual(calls.filter(call => typeof call === 'object'), []);
    // Exercise actual IPC admission, identity capability and repository checks.
    // Wire DTOs are cloned, as Chrome does; only the internal lease is private.
    const request = (type, payload = {}) => new Promise(resolve => chrome.runtime.onMessage.run(
      TidyProtocol.request(type, { expectedTabId: 31, ...structuredClone(payload) }),
      { url: 'chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=31' }, resolve));
    const account = await request('library.account');
    assert.equal(account.ok, true, JSON.stringify(account));
    const payload = { expectedAccountKey: ownerKey, expectedIdentity: account.payload.identity, name: 'ESM group' };
    const created = await request('favorites.group-create', payload);
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.ok(created.payload.groups.some(group => group.name === 'ESM group'));
    assert.equal(calls.filter(call => call === 'library.account').length, 1);
    chrome.runtime.onMessage.run(TidyProtocol.event('library.identity-changed', {
      epoch: 2, accountKey: '["different-user","personal"]', phase: 'ready',
    }), { tab, frameId: 0, documentId: 'source-document', documentLifecycle: 'active', url: tab.url }, () => {});
    const rejected = await request('favorites.group-create', { ...payload, name: 'Must not write' });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'CONTEXT_MISMATCH');
    const { favoritesRepository } = await import('./src/features/favorites/storage/favorites.js');
    const saved = await favoritesRepository.get(ownerKey);
    assert.ok(saved.groups.some(group => group.name === 'ESM group'));
    assert.ok(saved.groups.every(group => group.name !== 'Must not write'));
    chrome.tabs.onRemoved.run(31);
    console.log('worker-esm-ok');
  `], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /worker-esm-ok/);
});

for (const reason of ['unknown-native-failure', 'context-mismatch', 'route-changed']) test(`bookmark native uncertainty never triggers a second navigation: ${reason}`, async t => {
  const h = await harness(t, {
    locate: () => ({ pending: true, targetPresent: false, reason: 'conversation-mismatch' }),
    send: envelope => envelope.type === 'library.navigate' ? { navigated: false, reason } : { accepted: true },
  });
  const handle = h.owner.begin(h.request('bookmark', { bookmarkId: 'destination::message' }, h.protocol.Type.BOOKMARKS_OPEN), {});
  const context = h.context(handle); await h.owner.prepare(handle, context.tab, context.identity);
  await h.owner.selectBookmark(handle, { conversationId: 'destination', messageId: 'message' });
  await assert.rejects(h.owner.openBookmark(handle, context.tab, '/c/destination'));
  assert.equal(h.calls.filter(c => c.type === 'update').length, 0);
  assert.equal(h.calls.filter(c => c.type === 'locate').length, 1);
});

test('duplicate native bookmark OPEN shares one click and one waiting executor', async t => {
  const h = await harness(t, { locate: payload => ({ pending: true, targetPresent: false,
    reason: payload.waitForTarget ? 'conversation-loading' : 'conversation-mismatch' }) });
  const handle = h.owner.begin(h.request('bookmark', { bookmarkId: 'destination::message' }, h.protocol.Type.BOOKMARKS_OPEN), {});
  const context = h.context(handle); await h.owner.prepare(handle, context.tab, context.identity);
  await h.owner.selectBookmark(handle, { conversationId: 'destination', messageId: 'message' });
  const result = await Promise.all([h.owner.openBookmark(handle, context.tab, '/c/destination'), h.owner.openBookmark(handle, context.tab, '/c/destination')]);
  assert.ok(result.every(r => r.mode === 'same-document'));
  assert.equal(h.calls.filter(c => c.type === 'library.navigate').length, 1);
  const locate = h.calls.filter(c => c.type === 'locate'); assert.equal(locate.length, 2);
  assert.equal(locate[1].payload.waitForConversation, true);
  assert.equal(locate[0].payload.loadDeadlineAt, locate[1].payload.loadDeadlineAt);
  assert.equal(h.calls.some(c => c.type === 'update'), false);
});

const flushNavigation = () => new Promise(resolve => setImmediate(resolve));
async function openNative(h, kind = 'bookmark', pathname = '/c/destination') {
  const type = kind === 'bookmark' ? h.protocol.Type.BOOKMARKS_OPEN
    : kind === 'favorite' ? h.protocol.Type.FAVORITES_OPEN : h.protocol.Type.SEARCH_OPEN_RESULT;
  const request = h.request('native-test', { bookmarkId: 'destination::message',
    messageId: ['date', 'favorite'].includes(kind) ? null : 'message',
    ...(type === h.protocol.Type.SEARCH_OPEN_RESULT ? { navigationKind: kind === 'date' ? 'conversation' : 'keyword', query: kind === 'date' ? '' : 'needle' } : {}) }, type);
  const handle = h.owner.begin(request, {});
  if (type === h.protocol.Type.SEARCH_OPEN_RESULT) await h.owner.openSearch(handle, request.payload, {});
  else {
    const context = h.context(handle); await h.owner.prepare(handle, context.tab, context.identity);
    if (kind === 'bookmark') {
      await h.owner.selectBookmark(handle, { conversationId: 'destination', messageId: 'message' });
      await h.owner.openBookmark(handle, context.tab, pathname);
    } else await h.owner.openLibrary(context, pathname, 'destination');
  }
  return { handle, receipt: { navigationIntentId: handle.id, conversationId: 'destination',
    messageId: ['date', 'favorite'].includes(kind) ? null : 'message',
    ...(['date', 'favorite'].includes(kind) ? { placement: 'latest' } : {}),
    pending: false, located: false, reason: 'native-target-missing' },
    sender: { tab: { id: 31 }, documentId: 'source' } };
}
const absentTarget = payload => ({ located: false, pending: true, targetPresent: false,
  reason: payload.waitForTarget ? 'conversation-loading' : 'conversation-mismatch' });

// Only bookmarks and favorites retain the existing guarded full-page continuation.
for (const kind of ['bookmark', 'favorite']) {
  for (const destination of ['origin', 'destination', 'project']) test(`${kind}: native ${destination} timeout falls back once with unchanged deadline`, async t => {
    const h = await harness(t, { locate: absentTarget });
    const opened = await openNative(h, kind);
    const first = h.calls.find(c => c.type === (['date', 'favorite'].includes(kind) ? 'library.navigate' : 'locate'));
    const url = destination === 'project' ? 'https://chatgpt.com/g/g-p-project/c/destination'
      : `https://chatgpt.com/c/${destination}`;
    h.setDocument('source', url);
    h.owner.observeRoute({ tabId: 31, frameId: 0, documentId: 'source', url });
    h.owner.acceptResult(opened.receipt, opened.sender);
    h.owner.acceptResult(opened.receipt, opened.sender);
    await flushNavigation();
    const updates = h.calls.filter(c => c.type === 'update'); assert.equal(updates.length, 1);
    const target = new URL(updates[0].url);
    assert.equal(target.pathname, destination === 'project' ? '/g/g-p-project/c/destination' : '/c/destination');
    assert.equal(target.searchParams.get('messageId'), ['date', 'favorite'].includes(kind) ? null : 'message');
    assert.equal(target.searchParams.has('historySearchQuery'), false);
    assert.equal(h.events.filter(e => e.type === 'navigation.result').length, 0, 'Fallback is not completion');
    h.owner.acceptResult({ ...opened.receipt, located: true }, opened.sender);
    assert.equal(h.events.filter(e => e.type === 'navigation.result').length, 0, 'Late source success cannot finish a full-page continuation');
    h.owner.committed({ tabId: 31, frameId: 0, documentId: 'new-doc', url: updates[0].url });
    h.setDocument('new-doc', target.origin + target.pathname);
    await h.owner.resume(31); await h.owner.resume(31);
    const last = h.calls.filter(c => c.type === first.type).at(-1);
    assert.equal(last.payload.deadlineAt, first.payload.deadlineAt);
    assert.equal(last.payload.nativeFallbackAt, undefined, 'Full-page continuation cannot request a second fallback');
    h.owner.acceptResult({ ...opened.receipt, located: false, reason: 'landing-timeout' }, { ...opened.sender, documentId: 'new-doc' });
    assert.equal(h.events.filter(e => e.type === 'navigation.result').length, 1);
    assert.equal(h.events.filter(e => e.type === 'navigation.result')[0].payload.reason, 'landing-timeout', 'Fallback failure finishes immediately instead of waiting for the outer timer');
    assert.equal(h.calls.filter(c => c.type === 'update').length, 1);
  });
}

for (const boundary of ['cancel', 'newer', 'owner', 'waiting-owner', 'document', 'route', 'project']) {
  test(`native fallback cannot cross ${boundary}`, async t => {
    const h = await harness(t, { locate: absentTarget });
    const opened = await openNative(h, 'bookmark', boundary === 'project' ? '/g/g-p-intended/c/destination' : '/c/destination');
    if (boundary === 'cancel') h.owner.cancel({ navigationIntentId: opened.handle.id }, {});
    if (boundary === 'newer') h.owner.begin(h.request('newer'), {});
    if (boundary === 'owner') h.setIdentity({ accountKey: '["other","personal"]' });
    if (boundary === 'waiting-owner') h.setIdentity({ phase: 'unavailable', transition: 'workspace-unconfirmed' });
    if (boundary === 'document') h.setDocument('uncommitted-new-doc');
    if (boundary === 'route') h.setDocument('source', 'https://chatgpt.com/c/user-choice');
    if (boundary === 'project') h.setDocument('source', 'https://chatgpt.com/g/g-p-wrong/c/destination');
    h.owner.acceptResult(opened.receipt, opened.sender); await flushNavigation();
    assert.equal(h.calls.filter(c => c.type === 'update').length, 0);
  });
}

// Search never reloads the main document as a fallback: that would remount the
// official sidebar and violate both native presentation and no-flicker behavior.
for (const kind of ['keyword', 'date']) {
  for (const reason of ['native-router-unavailable', 'native-router-failed', 'native-router-timeout', 'native-route-unconfirmed', 'context-mismatch', 'route-changed']) {
    test(`${kind}: failed native dispatch never falls back to a full-page load: ${reason}`, async t => {
      const h = await harness(t, { send: envelope => envelope.type === 'library.navigate'
        ? { navigated: false, reason } : { accepted: true } });
      await assert.rejects(openNative(h, kind), { tidyCode: reason.startsWith('native-') ? 'ADAPTER_UNAVAILABLE' : 'CONTEXT_MISMATCH' });
      assert.equal(h.calls.filter(c => c.type === 'update').length, 0);
      assert.equal(h.calls.filter(c => c.type === 'locate').length, 0);
    });
  }
}

test('keyword delegates the exact query and message to native search, including same-conversation hits', async t => {
  for (const sameConversation of [false, true]) {
    const h = await harness(t);
    if (sameConversation) h.setDocument('source', 'https://chatgpt.com/g/g-p-project-one/c/destination');
    const envelope = h.request('exact-hit', { query: 'C++ 中文 & ? #', projectId: 'project-one' });
    const handle = h.owner.begin(envelope, {});
    const result = await h.owner.openSearch(handle, envelope.payload, {});
    const routes = h.calls.filter(c => c.type === 'library.navigate');
    assert.equal(routes.length, 1);
    assert.equal(routes[0].payload.placement, 'native-search');
    assert.equal(routes[0].payload.messageId, 'message');
    assert.equal(routes[0].payload.query, 'C++ 中文 & ? #');
    assert.equal(routes[0].payload.pathname, sameConversation ? '/g/g-p-project-one/c/destination' : '/c/destination');
    assert.equal(result.presentationOwner, 'native');
    assert.equal(Object.hasOwn(result, 'located'), false);
    assert.equal(h.calls.some(c => c.type === 'locate' || c.type === 'update'), false);
  }
});

test('title-only keyword matches stay native-search rather than becoming date latest navigation', async t => {
  const h = await harness(t);
  const envelope = h.request('title-only', { messageId: null, query: 'needle' });
  const result = await h.owner.openSearch(h.owner.begin(envelope, {}), envelope.payload, {});
  const route = h.calls.find(c => c.type === 'library.navigate');
  assert.equal(route.payload.placement, 'native-search');
  assert.equal(route.payload.messageId, null);
  assert.equal(route.payload.query, 'needle');
  assert.equal(result.presentationOwner, 'native');
  assert.equal(h.calls.some(c => c.type === 'locate' || c.type === 'update'), false);
});

test('search intent requires an explicit navigation kind instead of inferring it from a missing message ID', async t => {
  const h = await harness(t);
  for (const navigationKind of [undefined, null, '', 'date', 'native-search']) {
    assert.throws(() => h.owner.begin(h.request('invalid-' + navigationKind, { navigationKind }), {}),
      'Unknown search semantics must be rejected before any browser action');
  }
  assert.equal(h.calls.length, 0);
});

test('date search still owns latest placement but never arms a native full-page fallback', async t => {
  const h = await harness(t), opened = await openNative(h, 'date');
  const route = h.calls.find(c => c.type === 'library.navigate');
  assert.equal(route.payload.placement, 'latest');
  assert.equal(route.payload.messageId, undefined);
  assert.equal(route.payload.query, undefined);
  assert.equal(route.payload.nativeFallbackAt, undefined);
  assert.equal(h.calls.some(c => c.type === 'locate' || c.type === 'update'), false);
  h.owner.acceptResult({ ...opened.receipt, placement: undefined, located: true }, opened.sender);
  assert.equal(h.events.filter(e => e.type === 'navigation.result').length, 0);
  h.owner.acceptResult({ ...opened.receipt, located: true }, opened.sender);
  assert.equal(h.events.filter(e => e.type === 'navigation.result').length, 1);
});

test('date latest timeout is terminal without silently reloading the official sidebar', async t => {
  const h = await harness(t), opened = await openNative(h, 'date');
  h.owner.acceptResult(opened.receipt, opened.sender);
  await flushNavigation();
  assert.equal(h.calls.some(c => c.type === 'update'), false);
  const receipts = h.events.filter(e => e.type === 'navigation.result');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].payload.located, false);
});

test('native keyword handoff never waits for or publishes a Tidy presentation result or later timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = await harness(t), opened = await openNative(h, 'keyword');
  h.owner.acceptResult({ ...opened.receipt, located: true, highlighted: true }, opened.sender);
  h.owner.acceptResult({ ...opened.receipt, reason: 'target-timeout' }, opened.sender);
  t.mock.timers.tick(120000);
  await flushNavigation();
  assert.equal(h.events.some(e => e.type === 'navigation.result'), false);
  assert.equal(h.calls.some(c => c.type === 'locate' || c.type === 'update'), false);
  assert.equal(typeof h.owner.acceptNative, 'undefined', 'Official URLs are never adopted by a Tidy locator');
});

test('a newer search intent prevents a stale binding response from dispatching native search', async t => {
  const held = deferred(), entered = deferred(); let first = true;
  const h = await harness(t, { bind: async () => {
    if (first) { first = false; entered.resolve(); return held.promise; }
    return { id: 31, url: 'https://chatgpt.com/c/origin' };
  } });
  const oldEnvelope = h.request('old');
  const old = h.owner.openSearch(h.owner.begin(oldEnvelope, {}), oldEnvelope.payload, {});
  // Attach the rejection observer before releasing the asynchronous boundary.
  const retired = assert.rejects(old, { tidyCode: 'CONTEXT_MISMATCH' });
  await entered.promise;
  const nextEnvelope = h.request('new', { messageId: 'new-message', query: 'new query' });
  await h.owner.openSearch(h.owner.begin(nextEnvelope, {}), nextEnvelope.payload, {});
  held.resolve({ id: 31, url: 'https://chatgpt.com/c/origin' });
  await retired;
  assert.deepEqual(h.calls.filter(c => c.type === 'library.navigate').map(c => c.payload.messageId), ['new-message']);
  assert.equal(h.events.some(e => e.type === 'navigation.result'), false);
});


test('a generic navigated acknowledgement cannot falsely claim official keyword presentation', async t => {
  const h = await harness(t, { send: envelope => envelope.type === 'library.navigate'
    ? { navigated: true, reason: 'native-router' } : { accepted: true } });
  const envelope = h.request();
  await assert.rejects(h.owner.openSearch(h.owner.begin(envelope, {}), envelope.payload, {}), {
    tidyCode: 'ADAPTER_UNAVAILABLE', details: { stage: 'native-navigation', reason: 'native-search-not-accepted' },
  });
  assert.equal(h.calls.some(c => c.type === 'locate' || c.type === 'update'), false);
  assert.equal(h.events.some(e => e.type === 'navigation.result'), false);
});

test('a replaced native search cannot complete from its late routing acknowledgement', async t => {
  const held = deferred(), entered = deferred();
  const h = await harness(t, { send: envelope => {
    if (envelope.type === 'library.navigate') {
      if (envelope.payload.navigationIntentId === 'old') { entered.resolve(); return held.promise; }
      return { navigated: true, presentationOwner: 'native' };
    }
    return { accepted: true };
  } });
  const oldEnvelope = h.request('old');
  const old = h.owner.openSearch(h.owner.begin(oldEnvelope, {}), oldEnvelope.payload, {});
  const retired = assert.rejects(old, { tidyCode: 'CONTEXT_MISMATCH' });
  await entered.promise;
  const nextEnvelope = h.request('new', { messageId: 'new-message' });
  const current = await h.owner.openSearch(h.owner.begin(nextEnvelope, {}), nextEnvelope.payload, {});
  held.resolve({ navigated: true, presentationOwner: 'native' });
  await retired;
  assert.equal(current.navigationIntentId, 'new');
  assert.equal(current.presentationOwner, 'native');
  assert.equal(h.calls.some(c => c.type === 'locate' || c.type === 'update'), false);
  assert.equal(h.events.some(e => e.type === 'navigation.result'), false);
});


// Preserve bridge diagnostics: a timeout or missing page adapter is not evidence
// that the user changed conversations, and must never start a reload fallback.
for (const kind of ['keyword', 'date']) {
  for (const code of ['ADAPTER_TIMEOUT', 'ADAPTER_UNAVAILABLE']) {
    test(`${kind}: native IPC preserves ${code} and its diagnostic details`, async t => {
      const details = { stage: 'main-world.library.navigate', reason: 'synthetic-bridge-failure', timeoutMs: 12000 };
      const h = await harness(t, { rawReply: (envelope, protocol) => envelope.type === 'library.navigate'
        ? protocol.failure(envelope, code, 'The native bridge did not complete.', details) : undefined });
      await assert.rejects(openNative(h, kind), {
        tidyCode: code, message: 'The native bridge did not complete.', details,
      });
      assert.equal(h.calls.some(c => c.type === 'locate' || c.type === 'update'), false);
      assert.equal(h.events.some(e => e.type === 'navigation.result'), false);
    });
  }
  test(`${kind}: runtime transport rejection is adapter unavailable rather than a changed conversation`, async t => {
    const cause = new Error('Could not establish connection. Receiving end does not exist.');
    const h = await harness(t, { send: envelope => {
      if (envelope.type === 'library.navigate') throw cause;
      return { accepted: true };
    } });
    await assert.rejects(openNative(h, kind), error => {
      assert.equal(error.tidyCode, 'ADAPTER_UNAVAILABLE');
      assert.deepEqual(error.details, { stage: 'native-navigation.transport', disconnect: 'receiver-missing' });
      assert.equal(error.cause, cause);
      return true;
    });
    assert.equal(h.calls.some(c => c.type === 'locate' || c.type === 'update'), false);
    assert.equal(h.events.some(e => e.type === 'navigation.result'), false);
  });
}

test('keyword native acknowledgement marker cannot turn navigated false into successful presentation handoff', async t => {
  const h = await harness(t, { send: envelope => envelope.type === 'library.navigate'
    ? { navigated: false, presentationOwner: 'native', reason: 'native-route-unconfirmed' } : { accepted: true } });
  await assert.rejects(openNative(h, 'keyword'), { tidyCode: 'ADAPTER_UNAVAILABLE' });
  assert.equal(h.events.some(e => e.type === 'navigation.result'), false);
  assert.equal(h.calls.some(c => c.type === 'locate' || c.type === 'update'), false);
});

test('keyword native routing inherits the original click deadline after a slow tab binding', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const entered = deferred(), held = deferred();
  const h = await harness(t, { bind: () => { entered.resolve(); return held.promise; } });
  const envelope = h.request(), admittedAt = Date.now(), handle = h.owner.begin(envelope, {});
  const pending = h.owner.openSearch(handle, envelope.payload, {});
  await entered.promise;
  t.mock.timers.tick(7000);
  held.resolve({ id: 31, url: 'https://chatgpt.com/c/origin' });
  const result = await pending;
  const route = h.calls.find(c => c.type === 'library.navigate');
  assert.equal(route.payload.placement, 'native-search');
  assert.equal(route.payload.loadDeadlineAt, admittedAt + globalThis.TidyNavigationIdentity.LOAD_WINDOW_MS);
  assert.equal(route.payload.loadDeadlineAt - Date.now(), globalThis.TidyNavigationIdentity.LOAD_WINDOW_MS - 7000,
    'Binding and identity work consume the same absolute budget rather than restarting the native timeout');
  assert.equal(result.presentationOwner, 'native');
  assert.equal(Object.hasOwn(result, 'located'), false);
});


// Single-flight begins before binding/account reads, not just before the final
// native call: a duplicate request must not create a second identity failure.
test('duplicate keyword OPEN shares binding, pending identity and control setup even after completed native handoff', async t => {
  const entered = deferred(), held = deferred();
  let bindings = 0, accountReads = 0, admittedIdentity;
  const h = await harness(t, {
    bind: () => { bindings++; return { id: 31, url: 'https://chatgpt.com/c/origin' }; },
    readAccount: value => { accountReads++; admittedIdentity = value; entered.resolve(); return held.promise; },
  });
  const envelope = h.request(), handle = h.owner.begin(envelope, {});
  const first = h.owner.openSearch(handle, envelope.payload, {});
  await entered.promise;
  const duplicate = h.owner.openSearch(h.owner.begin(envelope, {}), envelope.payload, {});
  await flushNavigation();
  const duringIdentityWait = { bindings, accountReads, controls: h.calls.filter(c => c.type === 'navigation.intent').length,
    nativeCalls: h.calls.filter(c => c.type === 'library.navigate').length };
  held.resolve(admittedIdentity);
  const firstResult = await first;
  assert.deepEqual(await duplicate, firstResult);
  assert.deepEqual(duringIdentityWait, { bindings: 1, accountReads: 1, controls: 0, nativeCalls: 0 });
  assert.equal(firstResult.presentationOwner, 'native');
  assert.deepEqual(await h.owner.openSearch(h.owner.begin(envelope, {}), envelope.payload, {}), firstResult);
  assert.equal(bindings, 1, 'A duplicate completed request cannot rebind the same click');
  assert.equal(accountReads, 1, 'A duplicate completed request cannot overwrite the admitted identity');
  assert.equal(h.calls.filter(c => c.type === 'navigation.intent' && c.payload.phase === 'active').length, 1);
  assert.equal(h.calls.filter(c => c.type === 'library.navigate').length, 1);
  assert.equal(h.calls.some(c => c.type === 'locate' || c.type === 'update'), false);
});

test('duplicate keyword OPEN shares the same identity failure without independently dispatching navigation', async t => {
  const entered = deferred(); let rejectIdentity;
  const held = new Promise((_resolve, reject) => { rejectIdentity = reject; });
  let bindings = 0, accountReads = 0;
  const h = await harness(t, {
    bind: () => { bindings++; return { id: 31, url: 'https://chatgpt.com/c/origin' }; },
    readAccount: () => { accountReads++; entered.resolve(); return held; },
  });
  const envelope = h.request(), handle = h.owner.begin(envelope, {});
  // Match the real service-worker error cleanup for both duplicate IPC callers.
  const handleFailure = error => { h.owner.fail(handle); return error; };
  const first = h.owner.openSearch(handle, envelope.payload, {}).catch(handleFailure);
  await entered.promise;
  const duplicate = h.owner.openSearch(h.owner.begin(envelope, {}), envelope.payload, {}).catch(handleFailure);
  await flushNavigation();
  const failure = Object.assign(new Error('The identity bridge timed out.'), { tidyCode: 'ADAPTER_TIMEOUT' });
  rejectIdentity(failure);
  const results = await Promise.all([first, duplicate]);
  assert.equal(results[0], failure); assert.equal(results[1], failure);
  assert.equal(bindings, 1); assert.equal(accountReads, 1);
  assert.equal(h.calls.some(c => c.type === 'navigation.intent' || c.type === 'library.navigate' || c.type === 'locate' || c.type === 'update'), false);
  assert.equal(h.events.some(e => e.type === 'navigation.result'), false);
});
