const test = require('node:test');
const assert = require('node:assert/strict');
const CHANNEL = 'tidy.toolbar-theme.v1';
const SYNC = { channel: CHANNEL, target: 'reporter', type: 'sync' };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const report = dark => ({ channel: CHANNEL, target: 'service', type: 'changed', dark });

function event() {
  const listeners = [];
  return { listeners, addListener: listener => listeners.push(listener),
    emit: (...args) => { for (const listener of listeners) listener(...args); } };
}

function browser() {
  const calls = [], tabs = new Map(), frames = new Map(), panels = new Map(), contexts = [];
  const h = { calls, tabs, frames, panels, contexts, onTabSync: null, onPanelSync: null };
  const chrome = {
    runtime: { id: 'test', getURL: p => `chrome-extension://test/${p}`,
      getContexts: async query => { calls.push(['contexts', query]); return contexts; },
      sendMessage: async message => {
        calls.push(['panel-sync', message]);
        return h.onPanelSync ? h.onPanelSync(message) : { ok: false };
      },
    },
    tabs: {
      onActivated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event(),
      query: async query => { calls.push(['query', query]); return [...tabs.values()]; },
      get: async tabId => {
        calls.push(['get-tab', tabId]);
        if (!tabs.has(tabId)) throw Error('No such tab');
        return { ...tabs.get(tabId) };
      },
      sendMessage: async (tabId, message, options) => {
        calls.push(['tab-sync', tabId, message, options]);
        return h.onTabSync ? h.onTabSync(tabId, message, options) : { ok: false };
      },
    },
    webNavigation: { onCommitted: event(), getFrame: async options => {
      calls.push(['frame', options]);
      return frames.has(options.tabId) ? { ...frames.get(options.tabId) } : null;
    } },
    sidePanel: { getOptions: async ({ tabId }) => panels.get(tabId) || { enabled: false } },
    action: { setIcon: async options => { calls.push(['icon', options]); } },
  };
  h.chrome = chrome;
  h.addTab = (tabId, url = 'https://chatgpt.com/c/test', documentId = `doc-${tabId}`) => {
    tabs.set(tabId, { id: tabId, url, windowId: 10 });
    frames.set(tabId, { documentId, documentLifecycle: 'active', url });
  };
  h.sender = tabId => ({ id: 'test', frameId: 0, documentLifecycle: 'active',
    documentId: frames.get(tabId)?.documentId, url: tabs.get(tabId)?.url, tab: { id: tabId } });
  h.panel = tabId => {
    const url = chrome.runtime.getURL(`app/sidepanel/index.html?tidyTabId=${tabId}`);
    const documentId = `panel-${tabId}`;
    panels.set(tabId, { enabled: true, path: `app/sidepanel/index.html?tidyTabId=${tabId}` });
    contexts.push({ contextType: 'SIDE_PANEL', documentId, documentUrl: url, windowId: -1, tabId: -1 });
    // Chrome 153 实测的真实侧栏 sender 仅含 id/url；不可用 content 字段代替它。
    return { id: 'test', url };
  };
  h.icons = tabId => calls.filter(c => c[0] === 'icon' && (tabId === undefined || c[1].tabId === tabId)).map(c => c[1]);
  h.prefix = tabId => h.icons(tabId).at(-1)?.path[16].split('/').at(-1);
  return h;
}

async function setup() {
  const { createToolbarTheme } = await import('../src/platform/theme/background/toolbar-theme.js');
  const h = browser(), theme = createToolbarTheme(h.chrome);
  return { ...h, theme };
}

test('construction registers lifecycle listeners synchronously without creating a host or changing icons', async () => {
  const h = await setup();
  for (const e of [h.chrome.tabs.onActivated, h.chrome.tabs.onUpdated, h.chrome.tabs.onRemoved,
    h.chrome.tabs.onReplaced, h.chrome.webNavigation.onCommitted]) assert.equal(e.listeners.length, 1);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(Object.keys(h.theme).sort(), ['acceptReport', 'start']);
});

test('startup uses visible global fallback, resets existing tabs, and requests only supported current documents', async () => {
  const h = await setup();
  h.addTab(1); h.addTab(2, 'chrome://settings/appearance');
  await h.theme.start();
  assert.equal(h.icons()[0].tabId, undefined);
  assert.equal(h.icons()[0].path[16], 'chrome-extension://test/assets/icons/tidy-outlined-16.png');
  assert.equal(h.prefix(1), 'tidy-outlined-16.png');
  assert.equal(h.prefix(2), 'tidy-outlined-16.png');
  assert.deepEqual(h.calls.filter(c => c[0] === 'tab-sync'), [['tab-sync', 1, SYNC, { documentId: 'doc-1' }]]);
  assert.deepEqual(h.calls.filter(c => c[0] === 'panel-sync'), [['panel-sync', SYNC]]);
  const count = h.calls.length;
  await h.theme.start();
  assert.equal(h.calls.length, count, 'one startup per Worker instance');
});

test('missing tab reporters and absent panels leave a safe fallback instead of rejecting startup', async () => {
  const h = await setup();
  h.addTab(1);
  h.chrome.tabs.sendMessage = async () => { throw Error('Receiving end does not exist'); };
  h.chrome.runtime.sendMessage = async () => { throw Error('No panels'); };
  await h.theme.start();
  assert.equal(h.prefix(1), 'tidy-outlined-16.png');
});

test('current top-level content reports affect only their sender tab and duplicate colors are no-ops', async () => {
  const h = await setup();
  h.addTab(1); h.addTab(2);
  assert.equal(await h.theme.acceptReport({ ...report(true), tabId: 2 }, h.sender(1)), true);
  assert.equal(await h.theme.acceptReport(report(true), h.sender(1)), true);
  assert.equal(await h.theme.acceptReport(report(false), h.sender(1)), true);
  assert.equal(await h.theme.acceptReport(report(true), h.sender(2)), true);
  assert.equal(h.icons(1).length, 2);
  assert.equal(h.prefix(1), 'tidy-outlined-16.png');
  assert.equal(h.prefix(2), 'tidy-white-16.png');
  assert.equal(h.icons().every(icon => Number.isInteger(icon.tabId)), true);
  assert.deepEqual(Object.keys(h.icons(2)[0].path), ['16', '32', '48', '128']);
});

test('malformed messages and untrusted content senders cannot change icons', async () => {
  const h = await setup(); h.addTab(1);
  const sender = h.sender(1);
  for (const message of [null, {}, { ...report(true), channel: 'other' }, { ...report(true), target: 'host' },
    { ...report(true), type: 'sync' }, { ...report(true), dark: 'true' }]) {
    assert.equal(await h.theme.acceptReport(message, sender), false);
  }
  for (const invalid of [null, {}, { ...sender, id: 'other' }, { ...sender, frameId: 1 },
    { ...sender, documentId: '' }, { ...sender, documentId: 'old' }, { ...sender, documentLifecycle: 'cached' },
    { ...sender, tab: { id: -1 } }, { ...sender, tab: { id: '1' } }, { ...sender, tab: { id: -0 } },
    { ...sender, url: 'https://chatgpt.com.evil.test/' }, { ...sender, url: 'http://chatgpt.com/' },
    { ...sender, url: 'https://user@chatgpt.com/' }, { ...sender, url: 'https://chatgpt.com:444/' }]) {
    assert.equal(await h.theme.acceptReport(report(true), invalid), false);
  }
  assert.equal(h.icons().length, 0);
});

test('current frame must stay active and supported, and missing frame APIs fail closed', async () => {
  const h = await setup(); h.addTab(1);
  const sender = h.sender(1);
  for (const frame of [null, { documentId: 'doc-1', documentLifecycle: 'cached', url: sender.url },
    { documentId: 'doc-1', documentLifecycle: 'active', url: 'https://example.com/' }]) {
    h.chrome.webNavigation.getFrame = async () => frame;
    assert.equal(await h.theme.acceptReport(report(true), sender), false);
  }
  delete h.chrome.webNavigation.getFrame;
  assert.equal(await h.theme.acceptReport(report(true), sender), false);
  assert.equal(h.icons().length, 0);
});

test('only a genuine configured SIDE_PANEL document may report for its immutable owner', async () => {
  const h = await setup(); h.addTab(1); h.addTab(2);
  const sender = h.panel(1);
  assert.equal(await h.theme.acceptReport({ ...report(true), tabId: 2 }, sender), true);
  assert.equal(h.prefix(1), 'tidy-white-16.png');
  assert.equal(h.icons(2).length, 0);
  assert.deepEqual(h.calls.find(c => c[0] === 'contexts')[1],
    { contextTypes: ['SIDE_PANEL'], documentUrls: [sender.url] });
});

test('offscreen and extension tabs cannot impersonate the genuine side panel', async () => {
  const h = await setup(); h.addTab(1);
  const sender = h.panel(1);
  for (const invalid of [{ ...sender, url: h.chrome.runtime.getURL('features/export/engine/offscreen.html') },
    { ...sender, tab: { id: 1 } }, { ...sender, url: sender.url + '&x=1' },
    { ...sender, url: sender.url + '#hash' }, { ...sender, url: sender.url.replace('=1', '=01') },
    { ...sender, url: sender.url.replace('test/', 'other/') },
    { ...sender, documentId: 'invented' }]) {
    assert.equal(await h.theme.acceptReport(report(true), invalid), false);
  }
  h.contexts[0].contextType = 'TAB';
  assert.equal(await h.theme.acceptReport(report(true), sender), false);
  h.contexts[0].contextType = 'SIDE_PANEL'; h.contexts[0].documentUrl += '&fake=1';
  assert.equal(await h.theme.acceptReport(report(true), sender), false);
  assert.equal(h.icons().length, 0);
});

test('side panel requires live supported owner, enabled exact path, and context APIs', async () => {
  const h = await setup(); h.addTab(1);
  const sender = h.panel(1);
  for (const options of [{ enabled: false, path: 'app/sidepanel/index.html?tidyTabId=1' },
    { enabled: true, path: 'app/sidepanel/index.html?tidyTabId=2' }, { enabled: true }]) {
    h.panels.set(1, options);
    assert.equal(await h.theme.acceptReport(report(true), sender), false);
  }
  h.panels.set(1, { enabled: true, path: 'app/sidepanel/index.html?tidyTabId=1' });
  h.tabs.get(1).url = 'chrome://settings/';
  assert.equal(await h.theme.acceptReport(report(true), sender), false);
  h.tabs.get(1).url = 'https://chatgpt.com/';
  delete h.chrome.runtime.getContexts;
  assert.equal(await h.theme.acceptReport(report(true), sender), false);
  assert.equal(h.icons().length, 0);
});

test('side panel requires one unambiguous real document, and supplied documentId must match', async () => {
  const h = await setup(); h.addTab(1);
  const sender = h.panel(1), context = h.contexts[0];
  for (const documentId of [undefined, '', null, 12]) {
    context.documentId = documentId;
    assert.equal(await h.theme.acceptReport(report(true), sender), false);
  }
  context.documentId = 'panel-1';
  h.contexts.push({ ...context, documentId: 'another-panel' });
  assert.equal(await h.theme.acceptReport(report(true), sender), false);
  h.contexts.pop();
  for (const documentId of ['', null, 12, 'wrong-document']) {
    assert.equal(await h.theme.acceptReport(report(true), { ...sender, documentId }), false);
  }
  assert.equal(await h.theme.acceptReport(report(true), { ...sender, documentId: 'panel-1' }), true);
  assert.equal(await h.theme.acceptReport(report(false), sender), true);
  assert.equal(h.prefix(1), 'tidy-outlined-16.png');
});

test('one tab serializes icon writes, while another tab is not blocked', async () => {
  const h = await setup(); h.addTab(1); h.addTab(2);
  const gate = deferred(); let active = 0, max = 0, first = true;
  h.chrome.action.setIcon = async options => {
    if (options.tabId === 1) {
      active++; max = Math.max(max, active);
      if (first) { first = false; await gate.promise; }
      active--;
    }
    h.calls.push(['icon', options]);
  };
  const a = h.theme.acceptReport(report(true), h.sender(1));
  const b = h.theme.acceptReport(report(false), h.sender(1));
  await flush();
  assert.equal(await h.theme.acceptReport(report(true), h.sender(2)), true);
  gate.resolve();
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(max, 1);
  assert.equal(h.prefix(1), 'tidy-outlined-16.png');
});

test('failed setIcon is acknowledged as failure and the next report can retry', async () => {
  const h = await setup(); h.addTab(1);
  let fail = true;
  h.chrome.action.setIcon = async options => {
    if (fail) { fail = false; throw Error('setIcon failed'); }
    h.calls.push(['icon', options]);
  };
  await assert.rejects(h.theme.acceptReport(report(true), h.sender(1)), /setIcon failed/);
  assert.equal(await h.theme.acceptReport(report(true), h.sender(1)), true);
  assert.equal(h.prefix(1), 'tidy-white-16.png');
});

test('report-back sync does not deadlock the icon queue', { timeout: 2000 }, async () => {
  const h = await setup(); h.addTab(1);
  h.chrome.tabs.sendMessage = async (tabId, message, options) => {
    assert.deepEqual(message, SYNC);
    assert.deepEqual(options, { documentId: 'doc-1' });
    return { ok: await h.theme.acceptReport(report(true), h.sender(tabId)) };
  };
  await h.theme.start();
  assert.equal(h.prefix(1), 'tidy-white-16.png');
});

test('startup panel broadcast may await its report without deadlocking', { timeout: 2000 }, async () => {
  const h = await setup(); h.addTab(1);
  const sender = h.panel(1);
  h.chrome.runtime.sendMessage = async message => {
    assert.deepEqual(message, SYNC);
    return { ok: await h.theme.acceptReport(report(true), sender) };
  };
  await h.theme.start();
  assert.equal(h.prefix(1), 'tidy-white-16.png');
});

test('navigation invalidates a report that is still validating the previous document', async () => {
  const h = await setup(); h.addTab(1);
  const old = h.sender(1), gate = deferred(), getFrame = h.chrome.webNavigation.getFrame;
  let first = true;
  h.chrome.webNavigation.getFrame = options => {
    if (first) { first = false; return gate.promise; }
    return getFrame(options);
  };
  const pending = h.theme.acceptReport(report(true), old);
  await flush();
  h.addTab(1, 'https://example.com/', 'new-document');
  h.chrome.webNavigation.onCommitted.emit({ tabId: 1, frameId: 0, documentLifecycle: 'active' });
  gate.resolve({ documentId: old.documentId, documentLifecycle: 'active', url: old.url });
  assert.equal(await pending, false);
  await flush();
  assert.equal(h.icons(1).length, 1);
  assert.equal(h.prefix(1), 'tidy-outlined-16.png');
});

test('navigation fallback is applied after an already-running icon write finishes', async () => {
  const h = await setup(); h.addTab(1);
  const gate = deferred(); let first = true;
  h.chrome.action.setIcon = async options => {
    if (first) { first = false; await gate.promise; }
    h.calls.push(['icon', options]);
  };
  const pending = h.theme.acceptReport(report(true), h.sender(1));
  await flush();
  h.addTab(1, 'chrome://settings/appearance', 'settings');
  h.chrome.tabs.onUpdated.emit(1, { url: 'chrome://settings/appearance' });
  gate.resolve();
  assert.equal(await pending, false);
  await flush();
  assert.equal(h.prefix(1), 'tidy-outlined-16.png');
  assert.equal(h.calls.filter(c => c[0] === 'tab-sync').length, 0);
});

test('late old-document reports and subframe commits cannot take ownership', async () => {
  const h = await setup(); h.addTab(1);
  const old = h.sender(1);
  h.addTab(1, 'https://chatgpt.com/c/new', 'doc-new');
  h.chrome.webNavigation.onCommitted.emit({ tabId: 1, frameId: 0, documentLifecycle: 'active' });
  await flush();
  assert.equal(await h.theme.acceptReport(report(true), old), false);
  assert.equal(await h.theme.acceptReport(report(true), h.sender(1)), true);
  const count = h.icons(1).length;
  h.chrome.webNavigation.onCommitted.emit({ tabId: 1, frameId: 3, documentLifecycle: 'active' });
  h.chrome.webNavigation.onCommitted.emit({ tabId: 1, frameId: 0, documentLifecycle: 'prerender' });
  await flush();
  assert.equal(h.icons(1).length, count);
});

test('activation and document completion refresh exact tab and document, not an active-tab guess', async () => {
  const h = await setup(); h.addTab(1); h.addTab(2);
  h.chrome.tabs.onActivated.emit({ tabId: 2 });
  await flush();
  assert.deepEqual(h.calls.filter(c => c[0] === 'tab-sync'), [['tab-sync', 2, SYNC, { documentId: 'doc-2' }]]);
  h.chrome.tabs.onUpdated.emit(1, { status: 'complete' });
  await flush();
  assert.deepEqual(h.calls.filter(c => c[0] === 'tab-sync').at(-1), ['tab-sync', 1, SYNC, { documentId: 'doc-1' }]);
  const count = h.calls.length;
  h.chrome.tabs.onUpdated.emit(1, { title: 'new title' });
  await flush();
  assert.equal(h.calls.length, count);
});

test('closing tab cancels pending report and leaves no state that poisons a later tab', async () => {
  const h = await setup(); h.addTab(1);
  const gate = deferred(), getFrame = h.chrome.webNavigation.getFrame;
  h.chrome.webNavigation.getFrame = () => gate.promise;
  const pending = h.theme.acceptReport(report(true), h.sender(1));
  await flush();
  h.chrome.tabs.onRemoved.emit(1);
  gate.resolve({ documentId: 'doc-1', documentLifecycle: 'active', url: 'https://chatgpt.com/' });
  assert.equal(await pending, false);
  h.chrome.webNavigation.getFrame = getFrame;
  h.addTab(1, 'https://chatgpt.com/c/new', 'replacement');
  assert.equal(await h.theme.acceptReport(report(true), h.sender(1)), true);
  assert.equal(h.icons(1).length, 1);
});

test('tab replacement clears removed ownership and requests added document', async () => {
  const h = await setup(); h.addTab(1); h.addTab(2);
  await h.theme.acceptReport(report(true), h.sender(1));
  h.chrome.tabs.onReplaced.emit(2, 1);
  await flush();
  assert.equal(h.prefix(2), 'tidy-outlined-16.png');
  assert.deepEqual(h.calls.filter(c => c[0] === 'tab-sync').at(-1), ['tab-sync', 2, SYNC, { documentId: 'doc-2' }]);
});

test('worker recreation resets retained tab icons and obtains new current preference', async () => {
  const { createToolbarTheme } = await import('../src/platform/theme/background/toolbar-theme.js');
  const h = await setup(); h.addTab(1);
  await h.theme.acceptReport(report(true), h.sender(1));
  const fresh = createToolbarTheme(h.chrome);
  h.chrome.tabs.sendMessage = async tabId => ({ ok: await fresh.acceptReport(report(false), h.sender(tabId)) });
  await fresh.start();
  assert.equal(h.prefix(1), 'tidy-outlined-16.png');
});

test('lifecycle API failures are caught and do not prevent future reports', async () => {
  const h = await setup(); h.addTab(1);
  const getTab = h.chrome.tabs.get;
  h.chrome.tabs.get = async () => { throw Error('tab closed'); };
  h.chrome.runtime.sendMessage = () => { throw Error('no panels'); };
  assert.doesNotThrow(() => h.chrome.tabs.onActivated.emit({ tabId: 1 }));
  await flush();
  h.chrome.tabs.get = getTab;
  assert.equal(await h.theme.acceptReport(report(true), h.sender(1)), true);
  assert.equal(h.prefix(1), 'tidy-white-16.png');
});

test('construction tolerates absent event APIs, but sender validation remains fail closed', async () => {
  const { createToolbarTheme } = await import('../src/platform/theme/background/toolbar-theme.js');
  const chrome = { runtime: { id: 'test', getURL: p => `chrome-extension://test/${p}` },
    action: { setIcon: async () => { throw Error('must not run'); } } };
  const theme = createToolbarTheme(chrome);
  assert.equal(await theme.acceptReport(report(true), { id: 'test', tab: { id: 1 }, frameId: 0,
    documentId: 'doc', documentLifecycle: 'active', url: 'https://chatgpt.com/' }), false);
});

