const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const flush = () => new Promise(setImmediate);
function runtime(generateExport, fetch) {
  const timers = new Map(), messages = [], requests = []; let id = 0;
  const context = vm.createContext({ URL, Uint8Array, ArrayBuffer, AbortController,
    location: { href: 'chrome-extension://test/features/export/engine/job-worker.js' },
    importScripts() {}, TidyExport: { generateExport },
    postMessage: m => messages.push(m),
    setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => { requests.push({ url, options }); return fetch(url, options); },
  });
  vm.runInContext(fs.readFileSync('src/features/export/model/export-job.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/features/export/engine/assets.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/features/export/engine/job-worker.js', 'utf8'), context);
  const run = (sources = ['https://chatgpt.com/test-image']) => context.onmessage({ data: { plan: { messages: {}, files: [{ kind: 'conversation', conversations: [{ resources: sources.map(src => ({ type: 'image', src })) }] }] }, context: {}, warnings: [] } });
  return { context, timers, messages, requests, run };
}
test('real generation worker loads the shared inline renderer before both file renderers', () => {
  const files = [], source = 'src/features/export/engine/job-worker.js';
  const context = vm.createContext({ TidyExport: {}, importScripts: (...paths) => files.push(...paths) });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  const inline = files.indexOf('./inline-content.js');
  assert.ok(inline >= 0, 'generation must load the same inline renderer as the side panel');
  assert.ok(files.indexOf('./i18n.js') < inline);
  for (const renderer of ['./serializers.js', './pdf.js']) assert.ok(files.indexOf(renderer) > inline, renderer);
  for (const file of files) assert.ok(fs.existsSync(require('node:path').resolve(require('node:path').dirname(source), file)), file);
});

test('resource timeout aborts a stalled response body and clears its deadline', async () => {
  let signal;
  const h = runtime(async (_p, c) => { await c.assetLoader('https://chatgpt.com/test-image'); }, async (_url, options) => {
    signal = options.signal; return { ok: true, arrayBuffer: () => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(Error('aborted')))) };
  });
  const running = h.run(); await flush(); assert.equal(h.timers.size, 1);
  [...h.timers.values()][0](); await running;
  assert.equal(signal.aborted, true); assert.equal(h.timers.size, 0);
  assert.equal(h.messages.at(-1).errorCode, 'exportJobFailed');
});
test('worker asset boundary reads only planned images or packaged fonts and deduplicates resource reads', async () => {
  const h = runtime(async (_p, c) => {
    for (const wrong of ['https://evil.example/credential', '../private.json', './vendor/fonts/../secret', 'file:///C:/secret']) {
      await assert.rejects(c.assetLoader(wrong));
    }
    await Promise.all([c.assetLoader('https://chatgpt.com/test-image'), c.assetLoader('https://chatgpt.com/test-image')]);
    await c.assetLoader('./vendor/fonts/noto-sans-sc/shard.woff');
    return { bytes: new Uint8Array([1]), warnings: [] };
  }, async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }));
  await h.run(); assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].url, 'chrome-extension://test/assets/fonts/noto-sans-sc/shard.woff');
  assert.equal(h.requests[0].options.credentials, 'include'); assert.equal(h.requests[1].options.credentials, 'omit');
  assert.equal(h.timers.size, 0); assert.equal(h.messages.at(-1).type, 'ready');
});
// Upload/generated/search are product origins, not network authentication modes.
// A final signed address must reach fetch unchanged, including its query string.
test('worker public images are anonymous; only exact secure ChatGPT origin carries credentials', async () => {
  const sources = [
    'https://chatgpt.com/backend-api/estuary/content?id=test&sig=a%2Fb%2B',
    'https://CHATGPT.COM:443/image.png',
    'https://public.example/search.jpg',
    'https://cdn.example/upload.png?sig=a%2Fb%2B&expires=123',
    'https://chatgpt.com.evil.example/image.png',
    'https://images.chatgpt.com/image.png',
    'https://chatgpt.com:8443/image.png',
    'http://chatgpt.com/image.png',
    'data:image/png;base64,AQID',
  ];
  const h = runtime(async (_p, c) => {
    for (const source of sources) await Promise.all([c.assetLoader(source), c.assetLoader(source)]);
    await c.assetLoader('./vendor/fonts/noto-sans-sc/shard.woff');
    return { bytes: new Uint8Array([1]), warnings: [] };
  }, async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }));
  await h.run(sources);
  assert.equal(h.requests.length, sources.length + 1, 'task cache still makes each source single-flight');
  h.requests.forEach(({ url, options }, index) => {
    assert.equal(options.credentials, index < 2 ? 'include' : 'omit', url);
    assert.ok(options.signal instanceof AbortSignal);
    if (index < sources.length) assert.equal(url, sources[index], 'do not normalize signed source strings');
  });
  assert.equal(h.timers.size, 0);
  assert.equal(h.messages.filter(m => m.progress?.phase === 'resources').length, sources.length + 1);
  assert.equal(h.messages.at(-1).type, 'ready');
});

test('offscreen generation deadline really terminates the worker and reports a safe failure', () => {
  const timers = [], messages = []; let listener, terminated = 0;
  const context = vm.createContext({ URL, Blob, Date, setTimeout: fn => { timers.push(fn); return 1; }, clearTimeout() {},
    Worker: class { postMessage() {} terminate() { terminated++; } },
    chrome: { runtime: { id: 'test', getURL: p => 'chrome-extension://test/' + p,
      sendMessage: async m => messages.push(m), onMessage: { addListener: fn => { listener = fn; } } } },
  });
  vm.runInContext(fs.readFileSync('src/features/export/model/export-job.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/features/export/engine/offscreen.js', 'utf8'), context);
  const m = { channel: 'tidy.export-host.v1', target: 'host', type: 'run', id: 'one', spec: {} };
  listener(m, { id: 'test', url: 'chrome-extension://test/app/sidepanel/index.html' }, () => { throw Error('wrong sender accepted'); });
  assert.equal(timers.length, 0);
  listener(m, { id: 'test', url: 'chrome-extension://test/app/background/service-worker.js' }, () => {});
  timers[0](); assert.equal(terminated, 1); assert.equal(messages.at(-1).errorCode, 'exportJobTimeout');
});

for (const phase of ['generating', 'ready']) test(`offscreen stop in ${phase} clears job, worker and Blob without publishing toolbar state`, async () => {
  const listeners = [], messages = [], revoked = [], timers = new Set();
  let worker, terminated = 0, timerId = 0;
  const context = vm.createContext({ Blob, Date,
    URL: { createObjectURL: () => 'blob:chrome-extension://test/export-one', revokeObjectURL: url => revoked.push(url) },
    setTimeout: () => { timers.add(++timerId); return timerId; }, clearTimeout: id => timers.delete(id),
    Worker: class { constructor() { worker = this; } postMessage() {} terminate() { terminated++; } },
    chrome: { runtime: { id: 'test', getURL: p => `chrome-extension://test/${p}`,
      sendMessage: async message => { messages.push(message); return { ok: true }; }, onMessage: { addListener: listener => listeners.push(listener) } } },
  });
  for (const file of ['src/features/export/model/export-job.js', 'src/features/export/engine/offscreen.js']) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  }
  const sender = { id: 'test', url: 'chrome-extension://test/app/background/service-worker.js' };
  const send = (type, extra = {}) => {
    let response;
    for (const listener of listeners) listener({ channel: 'tidy.export-host.v1', target: 'host', type, id: 'one', ...extra }, sender, value => { response = value; });
    return response;
  };
  assert.equal(send('run', { spec: { privateBody: 'must be released' } }).ok, true);
  assert.equal(send('stop', { id: 'other-job' }).ok, false, 'foreign stop cannot falsely claim cleanup');
  if (phase === 'ready') worker.onmessage({ data: { type: 'ready', result: { bytes: new Uint8Array([1]), mimeType: 'text/plain', warnings: [] } } });
  assert.equal(send('stop').job, null);
  assert.equal(send('inspect').job, null);
  assert.equal(terminated, 1); assert.equal(timers.size, 0);
  assert.deepEqual(revoked, phase === 'ready' ? ['blob:chrome-extension://test/export-one'] : []);
  const themeMessages = messages.filter(m => m.channel === 'tidy.toolbar-theme.v1');
  assert.equal(themeMessages.length, 0);
});

test('a retired worker error or queued timeout cannot stop a newer job in the shared host', () => {
  const workers = [], deadlines = []; let listener, terminated = 0;
  const context = vm.createContext({ URL, Blob, Date, setTimeout: fn => { deadlines.push(fn); return deadlines.length; }, clearTimeout() {},
    Worker: class { constructor() { workers.push(this); } postMessage() {} terminate() { terminated++; } },
    chrome: { runtime: { id: 'test', getURL: p => `chrome-extension://test/${p}`, sendMessage: async () => {},
      onMessage: { addListener: fn => { listener = fn; } } } },
  });
  vm.runInContext(fs.readFileSync('src/features/export/model/export-job.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/features/export/engine/offscreen.js', 'utf8'), context);
  const send = (type, id) => {
    let response;
    listener({ channel: 'tidy.export-host.v1', target: 'host', type, id, spec: {} },
      { id: 'test', url: 'chrome-extension://test/app/background/service-worker.js' }, value => { response = value; });
    return response;
  };
  send('run', 'old'); send('stop', 'old'); send('run', 'new');
  workers[0].onerror(); deadlines[0]();
  assert.equal(send('inspect', 'new').job.id, 'new');
  assert.equal(send('inspect', 'new').job.state, 'generating');
  assert.equal(terminated, 1);
});
