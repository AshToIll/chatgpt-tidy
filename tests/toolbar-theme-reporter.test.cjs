const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('src/platform/theme/shared/toolbar-theme.js', 'utf8');
const CHANNEL = 'tidy.toolbar-theme.v1';
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
function events(target = {}) {
  const listeners = new Map();
  return Object.assign(target, {
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    fire(type, event = {}) { for (const fn of [...listeners.get(type) || []]) fn(event); },
    count() { return [...listeners.values()].reduce((sum, entries) => sum + entries.size, 0); },
  });
}
function harness({ withSession = false, addFails = false, removeFails = false } = {}) {
  const media = events({ matches: false }), document = events({ visibilityState: 'visible' });
  const messages = [], listeners = new Set(), disposers = [];
  let valid = true, fail = false, ok = true;
  const runtime = { get id() { return valid ? 'test' : undefined; }, getURL: p => `chrome-extension://test/${p}`,
    sendMessage: async m => { if (fail) throw Error('Worker disconnected'); messages.push(m); return { ok }; },
    onMessage: { addListener: fn => { if (addFails) throw Error('Extension context invalidated'); listeners.add(fn); },
      removeListener: fn => { listeners.delete(fn); if (removeFails) throw Error('Extension context invalidated'); } } };
  let sessionRequests = 0;
  const session = withSession ? { check: () => valid, onDispose: fn => disposers.push(fn),
    runtimeRequest: m => { sessionRequests++; return runtime.sendMessage(m); } } : null;
  const global = events({ document, chrome: { runtime }, matchMedia: query => {
    assert.equal(query, '(prefers-color-scheme: dark)'); return media;
  } });
  const context = vm.createContext(global);
  vm.runInContext(source, context);
  const reporter = context.TidyToolbarTheme.start({ runtime, session });
  const sender = { id: 'test', url: runtime.getURL('app/background/service-worker.js') };
  const sync = from => new Promise(resolve => {
    for (const listener of listeners) {
      if (listener({ channel: CHANNEL, target: 'reporter', type: 'sync' }, from, resolve) === true) return;
    }
    resolve('rejected');
  });
  return { global, media, document, messages, reporter, listeners, sync, sender,
    fail: value => { fail = value; }, ok: value => { ok = value; }, sessionRequests: () => sessionRequests,
    invalidate: () => { valid = false; }, disposeSession: () => disposers.forEach(fn => fn()) };
}
test('window reporter publishes raw browser preference, not DOM theme, with no timers or storage', async () => {
  const h = harness(); await flush();
  assert.equal(h.messages.length, 1); assert.equal(h.messages[0].dark, false);
  h.document.className = 'dark'; h.document.background = '#000000';
  h.global.fire('focus'); await flush(); assert.equal(h.messages.at(-1).dark, false);
  h.media.matches = true; h.media.fire('change'); await flush();
  assert.equal(h.messages.at(-1).dark, true);
  assert.equal(Object.hasOwn(h.messages.at(-1), 'tabId'), false);
  assert.doesNotMatch(source, /setInterval|setTimeout|storage\./);
});
test('hidden-tab changes are re-read on visibility, focus and BFCache pageshow', async () => {
  const h = harness(); await flush();
  h.document.visibilityState = 'hidden'; h.media.matches = true;
  h.document.fire('visibilitychange'); await flush(); assert.equal(h.messages.length, 1);
  h.document.visibilityState = 'visible'; h.document.fire('visibilitychange'); await flush();
  assert.equal(h.messages.at(-1).dark, true);
  h.global.fire('pagehide', { persisted: true });
  h.media.matches = false; h.global.fire('pageshow', { persisted: true }); await flush();
  assert.equal(h.messages.at(-1).dark, false);
});
test('only the worker may sync; ack reflects real success and recovers without a retry timer', async () => {
  const h = harness(); await flush();
  for (const sender of [{ ...h.sender, id: 'foreign' }, { ...h.sender, tab: { id: 5 } },
    { ...h.sender, url: 'https://chatgpt.com/' }, { ...h.sender, url: h.sender.url + '?fake' }]) {
    assert.equal(await h.sync(sender), 'rejected');
  }
  h.ok(false); assert.equal((await h.sync(h.sender)).ok, false);
  h.fail(true); assert.equal((await h.sync(h.sender)).ok, false);
  h.fail(false); h.ok(true); h.media.matches = true;
  assert.equal((await h.sync(h.sender)).ok, true); assert.equal(h.messages.at(-1).dark, true);
});
test('content reports use the existing page-session gate and never revive after invalidation', async () => {
  const h = harness({ withSession: true }); await flush();
  assert.equal(h.sessionRequests(), 1);
  h.media.matches = true; h.media.fire('change'); h.invalidate(); await flush();
  assert.equal(h.messages.length, 1, 'queued callback rechecks session before dispatch');
  assert.equal(h.media.count(), 0); assert.equal(h.document.count(), 0);
  assert.equal(h.global.count(), 0); assert.equal(h.listeners.size, 0);
  h.global.fire('focus'); h.media.fire('change'); await flush(); assert.equal(h.messages.length, 1);
});
test('session disposal and panel pagehide remove all observers; repeated dispose is safe', async () => {
  for (const withSession of [true, false]) {
    const h = harness({ withSession }); await flush();
    if (withSession) h.disposeSession(); else h.global.fire('pagehide', { persisted: false });
    h.reporter.dispose(); h.media.fire('change'); await flush();
    assert.equal(h.messages.length, 1); assert.equal(h.listeners.size, 0);
    assert.equal(h.media.count() + h.document.count() + h.global.count(), 0);
  }
});
test('production wires reporters only into normal content and panel documents, never offscreen', () => {
  const manifest = JSON.parse(fs.readFileSync('src/manifest.json'));
  const isolated = manifest.content_scripts.find(s => s.js.includes('platform/session/content/page-session.js')).js;
  assert.ok(isolated.indexOf('platform/session/content/page-session.js') < isolated.indexOf('platform/theme/shared/toolbar-theme.js'));
  assert.ok(isolated.indexOf('platform/theme/shared/toolbar-theme.js') < isolated.indexOf('platform/theme/content/toolbar-theme.js'));
  assert.match(fs.readFileSync('src/platform/theme/content/toolbar-theme.js', 'utf8'), /session: globalThis.TidyPageSession/);
  assert.match(fs.readFileSync('src/app/sidepanel/index.html', 'utf8'), /type="module" src="\.\.\/\.\.\/platform\/theme\/ui\/toolbar-theme.js"/);
  assert.doesNotMatch(fs.readFileSync('src/features/export/engine/offscreen.html', 'utf8'), /toolbar-theme/);
  assert.equal(fs.existsSync('src/features/export/engine/toolbar-theme.js'), false);
  assert.doesNotMatch(fs.readFileSync('src/features/export/background/offscreen-host.js', 'utf8'), /MATCH_MEDIA/);
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*']);
});

test('reload during listener registration or removal cleans up without leaking API exceptions', async () => {
  const failedStart = harness({ addFails: true, removeFails: true }); await flush();
  assert.equal(failedStart.messages.length, 0);
  assert.equal(failedStart.media.count() + failedStart.document.count() + failedStart.global.count(), 0);
  const h = harness({ removeFails: true }); await flush();
  h.invalidate(); assert.doesNotThrow(() => h.global.fire('focus')); await flush();
  assert.equal(h.media.count() + h.document.count() + h.global.count(), 0);
  assert.equal(h.listeners.size, 0);
});

test('a closed response channel during reload does not cause an unhandled rejection', async () => {
  const h = harness(); await flush();
  const listener = [...h.listeners][0];
  assert.equal(listener({ channel: CHANNEL, target: 'reporter', type: 'sync' }, h.sender,
    () => { throw Error('Extension context invalidated'); }), true);
  await flush();
});
