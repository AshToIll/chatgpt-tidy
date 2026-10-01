const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const { installPageSession } = require('./helpers/page-session.cjs');
const { createWorkerModuleLoader } = require('./helpers/worker-runtime.cjs');

const source = file => fs.readFileSync(file, 'utf8');
const flush = () => new Promise(setImmediate);
const plain = value => JSON.parse(JSON.stringify(value));
const sender = {
  tab: { id: 31, url: 'https://chatgpt.com/c/shared' },
  frameId: 0, documentId: 'document-a', documentLifecycle: 'active',
  url: 'https://chatgpt.com/c/shared',
};

function snapshot(contract) {
  const field = value => ({ value, source: 'fixture', status: 'available' });
  return {
    schemaVersion: contract.VERSION,
    route: { pathname: '/c/shared', kind: 'conversation', status: 'available' },
    appearance: { colorScheme: 'light', source: 'fixture', status: 'available', surface: field('rgb(255, 255, 255)') },
    conversation: { conversationId: 'shared', draftId: null, kind: 'conversation',
      identityStatus: 'stable', bindingStatus: 'bound', title: field('Synthetic title'),
      createdAt: field('2026-09-27T00:00:00.000Z'), updatedAt: field('2026-09-27T00:00:00.000Z') },
    sidebarConversations: [], messages: [],
  };
}

function workerHarness({ getFrame } = {}) {
  const broadcasts = [];
  let receive, frameReads = 0;
  const chrome = {
    runtime: {
      getURL: file => `chrome-extension://snapshot-test/${file}`,
      onMessage: { addListener(fn) { receive = fn; } },
      sendMessage: async envelope => { broadcasts.push(plain(envelope)); },
    },
    tabs: { sendMessage: async () => {} },
    webNavigation: { getFrame: async input => {
      frameReads++;
      return getFrame ? getFrame(input) : { documentId: 'document-a', documentLifecycle: 'active', url: sender.url };
    } },
  };
  const context = vm.createContext({ chrome, URL });
  const modules = createWorkerModuleLoader(context);
  const { isChatgptUrl } = modules.load('src/platform/session/background/request-binding.js');
  const { createLibraryIdentity } = modules.load('src/platform/library/background/library-identity.js');
  const { createPageEvents } = modules.load('src/platform/session/background/page-events.js');
  const { createWorkerMessageListener } = modules.load('src/app/background/runtime-messages.js');
  // Exercise the real event admission and shared document owner. No entrypoint
  // slices or copied branch logic can hide a change in the production modules.
  const identity = createLibraryIdentity({
    chrome, isChatgptUrl, beforeIdentityChange() {}, afterIdentityChange() {},
  });
  const unexpected = () => assert.fail('Snapshot observations must not invoke unrelated handlers');
  chrome.runtime.onMessage.addListener(createWorkerMessageListener({
    identity,
    pageEvents: createPageEvents({ chrome, identity }),
    diagnostics: { matches: () => false },
    toolbarTheme: { acceptReport: unexpected },
    exportJobs: { acceptHost: unexpected },
    titleCatalog: { accept: unexpected },
    navigation: { cancel: unexpected, acceptResult: unexpected },
    requests: { handle: unexpected },
  }));
  return {
    context, frameReads: () => frameReads,
    notices: () => broadcasts.filter(envelope => envelope.type === context.TidyProtocol.Type.SNAPSHOT_UPDATED),
    receive: (payload, from = sender) => receive(context.TidyProtocol.event(context.TidyProtocol.Type.SNAPSHOT_UPDATED, payload), from, () => {}),
    async emit(payload, from = sender) { this.receive(payload, from); await flush(); },
    commit(documentId) { identity.committed({ tabId: 31, documentId }); },
    close() { identity.closeTab(31); },
  };
}

test('snapshot event cannot override browser tab identity and only broadcasts allowed fields', async () => {
  const h = workerHarness(), current = snapshot(h.context.TidySnapshot);
  await h.emit({ tabId: 32, documentId: 'foreign-document', snapshot: current, reason: 'stream', injected: 'drop me' });
  assert.equal(h.notices().length, 1);
  assert.deepEqual(h.notices()[0].payload, { tabId: 31, snapshot: current, reason: 'stream' });
});

test('snapshot event requires a live top-level HTTPS ChatGPT sender before browser discovery', async () => {
  const h = workerHarness(), payload = { snapshot: snapshot(h.context.TidySnapshot) };
  for (const from of [
    { ...sender, tab: undefined }, { ...sender, frameId: 1 }, { ...sender, documentId: '' },
    { ...sender, documentLifecycle: 'cached' }, { ...sender, documentLifecycle: 'prerender' },
    { ...sender, documentLifecycle: undefined }, { ...sender, url: 'https://example.com/' },
    { ...sender, url: 'http://chatgpt.com/c/shared' }, { ...sender, url: 'https://chatgpt.com:444/c/shared' },
  ]) await h.emit(payload, from);
  assert.equal(h.notices().length, 0);
  assert.equal(h.frameReads(), 0);
});

test('invalid snapshot events are discarded before browser discovery or panel notification', async () => {
  const h = workerHarness(), valid = snapshot(h.context.TidySnapshot);
  for (const invalid of [null, {}, { ...valid, schemaVersion: 'wrong' }, { ...valid, messages: [{}] },
    { ...valid, appearance: { ...valid.appearance, surface: { value: 'url(unsafe)' } } }]) {
    await h.emit({ snapshot: invalid });
  }
  assert.equal(h.notices().length, 0);
  assert.equal(h.frameReads(), 0);
});

test('cold worker accepts only the browser-proven current document and then reuses its cache', async () => {
  const h = workerHarness(), current = snapshot(h.context.TidySnapshot);
  await h.emit({ snapshot: current }, { ...sender, documentId: 'old-document' });
  assert.equal(h.notices().length, 0);
  for (let i = 0; i < 20; i++) await h.emit({ snapshot: current });
  assert.equal(h.notices().length, 20);
  assert.equal(h.frameReads(), 1, 'Streaming must not add repeated getFrame or account reads');
  assert.equal(h.notices()[0].payload.reason, 'adapter-event');
});

test('a committed replacement document rejects old snapshots without another browser lookup', async () => {
  const h = workerHarness(), payload = { snapshot: snapshot(h.context.TidySnapshot) };
  h.commit('document-b');
  await h.emit(payload);
  assert.equal(h.notices().length, 0);
  await h.emit(payload, { ...sender, documentId: 'document-b' });
  assert.equal(h.notices().length, 1);
  assert.equal(h.frameReads(), 0);
});

test('a cold snapshot lookup cannot publish after commit or tab closure', async () => {
  for (const change of ['commit', 'close']) {
    let resolveFrame;
    const h = workerHarness({ getFrame: () => new Promise(resolve => { resolveFrame = resolve; }) });
    h.receive({ snapshot: snapshot(h.context.TidySnapshot) });
    if (change === 'commit') h.commit('document-b'); else h.close();
    resolveFrame({ documentId: 'document-a', documentLifecycle: 'active', url: sender.url });
    await flush();
    assert.equal(h.notices().length, 0, change);
  }
});

test('isolated bridge validates snapshots before local rendering and strips page-supplied identities', async () => {
  let receivePage;
  const forwarded = [], rendered = [];
  const context = vm.createContext({
    document: { documentElement: { dataset: {} } }, setTimeout, clearTimeout,
    chrome: { runtime: { id: 'tidy-test', onMessage: { addListener() {} }, sendMessage: async envelope => { forwarded.push(plain(envelope)); } } },
  });
  context.window = context;
  context.location = { origin: 'https://chatgpt.com' };
  context.addEventListener = (type, listener) => { if (type === 'message') receivePage = listener; };
  for (const file of ['src/platform/protocol.js', 'src/platform/snapshot.js', 'src/features/search/model/search.js', 'src/platform/catalog/date-search.js', 'src/features/export/model/export.js']) {
    vm.runInContext(source(file), context);
  }
  installPageSession(context, { runtime: true });
  vm.runInContext(source('src/app/page/isolated.js'), context);
  context.TidyContentBridge.onSnapshot((value, reason) => rendered.push({ snapshot: plain(value), reason }));
  context.receivePage = receivePage;
  const emit = async payload => {
    context.testPayload = payload;
    vm.runInContext(`receivePage({ source: window, origin: location.origin, data: {
      channel: TidyProtocol.WINDOW_CHANNEL, source: 'chatgpt-main-world',
      envelope: TidyProtocol.event(TidyProtocol.Type.SNAPSHOT_UPDATED, testPayload),
    } })`, context);
    await flush();
  };
  await emit({ snapshot: {} });
  assert.equal(forwarded.length, 0); assert.equal(rendered.length, 0);
  const current = snapshot(context.TidySnapshot);
  await emit({ snapshot: current, tabId: 32, documentId: 'foreign-document', reason: 'stream' });
  assert.deepEqual(rendered, [{ snapshot: current, reason: 'stream' }]);
  assert.deepEqual(forwarded[0].payload, { snapshot: current, reason: 'stream' });
});
