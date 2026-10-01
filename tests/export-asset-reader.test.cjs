const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { exportMessages } = require('./helpers/export-i18n.cjs');
const root = path.resolve(__dirname, '..');
const png = new Uint8Array(fs.readFileSync(path.join(root, 'src/assets/icons/tidy-outlined-32.png')));
const messages = exportMessages('en');
const sources = [
  'https://chatgpt.com/backend-api/estuary/content?id=synthetic&sig=a%2Fb',
  'https://cdn.example/generated.png?sig=a%2Fb%2B&expires=123',
  'https://public.example/reference.png',
];
const load = (context, file) => vm.runInContext(fs.readFileSync(path.join(root, 'src', file), 'utf8'), context, { filename: file });
function reader(fetch) {
  const context = vm.createContext({ URL, Uint8Array, fetch });
  load(context, 'features/export/engine/assets.js');
  return context.TidyExport.readExportAsset;
}

test('one reader selects credentials by parsed exact origin and never rewrites source strings', async () => {
  const entries = [
    [sources[0], 'include'], ['https://CHATGPT.COM:443/image.png', 'include'],
    [sources[1], 'omit'], [sources[2], 'omit'],
    ['https://chatgpt.com.evil.example/image.png', 'omit'], ['https://sub.chatgpt.com/image.png', 'omit'],
    ['http://chatgpt.com/image.png', 'omit'], ['https://chatgpt.com:8443/image.png', 'omit'],
    ['data:image/png;base64,AQID', 'omit'], ['chrome-extension://test/assets/font.ttf', 'omit'],
    ['./vendor/fonts/noto-sans-sc/manifest.json', 'omit'],
  ];
  const calls = [], signal = new AbortController().signal;
  const read = reader(async (url, options) => {
    calls.push({ url, options }); return { ok: true, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
  });
  for (const [source, credentials] of entries) {
    assert.deepEqual(await read(source, { signal }), Uint8Array.from([1, 2, 3]));
    assert.equal(calls.at(-1).url, source);
    assert.equal(calls.at(-1).options.credentials, credentials);
    assert.equal(calls.at(-1).options.signal, signal);
  }
  await assert.rejects(read('https://name:secret@chatgpt.com/image.png'), /Invalid export asset URL/);
  assert.equal(calls.length, entries.length, 'embedded URL credentials never reach fetch');
});

test('reader does not retry failures, replace aborts or invent content for empty bodies', async () => {
  const offline = new TypeError('offline'), aborted = new Error('aborted');
  for (const behavior of [async () => { throw offline; }, async () => ({ ok: false }),
    async () => ({ ok: true, arrayBuffer: async () => { throw aborted; } })]) {
    let calls = 0;
    const read = reader(async () => { calls++; return behavior(); });
    await assert.rejects(read(sources[2])); assert.equal(calls, 1);
  }
  assert.equal((await reader(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }))(sources[2])).length, 0);
});

// Stub only the lowest fetch boundary. PDF executes the shipping shared reader,
// real font bytes, PNG bytes and PDF library; text formats must never read assets.
function runtime({ failure = '' } = {}) {
  const calls = [];
  const context = vm.createContext({ URL, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, setTimeout, clearTimeout, setImmediate,
    fetch: async (source, options) => {
      calls.push({ source, options });
      let bytes;
      if (source.startsWith('./vendor/fonts/')) {
        assert.equal(options.credentials, 'omit', 'packaged fonts are never authenticated');
        bytes = fs.readFileSync(path.join(root, 'src/assets/fonts', source.slice('./vendor/fonts/'.length)));
      } else {
        assert.ok(sources.includes(source), source);
        assert.equal(options.credentials, source === sources[0] ? 'include' : 'omit', source);
        if (source === sources[2]) {
          if (failure === 'rejected') throw new TypeError('public image denied');
          if (failure === 'http') return { ok: false, status: 403 };
          if (failure === 'empty') return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
        }
        bytes = png;
      }
      return { ok: true, arrayBuffer: async () => Uint8Array.from(bytes).buffer };
    },
  });
  for (const file of ['vendor/pdf-lib-1.17.1.min.js', 'vendor/regenerator-runtime-0.14.1.js', 'vendor/fontkit-1.1.1.min.js', 'vendor/jszip-3.10.1.min.js']) load(context, file);
  for (const name of ['i18n', 'assets', 'dependencies', 'normalize', 'plan', 'inline-content', 'serializers', 'pdf', 'download']) load(context, 'features/export/engine/' + name + '.js');
  const api = context.TidyExport;
  const conversation = {
    id: 'asset-reader', title: 'Asset reader', sourceUrl: 'https://chatgpt.com/c/asset-reader',
    createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z',
    resources: sources.map((src, index) => ({ id: 'image-' + index, type: 'image', name: 'image-' + index + '.png',
      src, mimeType: 'image/png', alt: 'image-' + index, sizeBytes: png.length })),
    messages: sources.map((_, index) => ({ id: 'message-' + index, role: index ? 'assistant' : 'user', messageNumber: index + 1, timestamp: null,
      segments: [{ type: 'content', sourceMessageId: 'message-' + index, timestamp: null,
        blocks: [{ type: 'image', resourceId: 'image-' + index, alt: 'image-' + index }] }] })),
  };
  const plan = (format, mediaAttachments = true) => api.buildExportPlan({ messages, mode: 'current', format,
    currentConversationId: conversation.id, options: { timestamps: false, messageNumbers: false, mediaAttachments },
    data: api.normalizeExportData({ conversations: [conversation], bookmarks: [] }) });
  return { context, api, calls, plan };
}
function imageObjects(context, pdf) {
  const images = pdf.context.enumerateIndirectObjects().filter(([, object]) => object.dict?.get(context.PDFLib.PDFName.of('Subtype'))?.toString() === '/Image');
  // Transparent PNGs embed an alpha-mask image too; count displayed images, not their masks.
  const masks = new Set(images.map(([, object]) => object.dict.get(context.PDFLib.PDFName.of('SMask'))?.toString()));
  return images.filter(([reference]) => !masks.has(reference.toString()));
}

test('PDF default reader embeds upload, externally signed generated and public images without injected assetLoader', async () => {
  const h = runtime(), output = await h.api.generateExport(h.plan('pdf'), { messages });
  assert.deepEqual(Array.from(output.warnings), []);
  const pdf = await h.context.PDFLib.PDFDocument.load(output.bytes);
  assert.equal(imageObjects(h.context, pdf).length, 3);
  assert.deepEqual(h.calls.filter(c => sources.includes(c.source)).map(c => c.source), sources);
});

test('Markdown and TXT describe all three sources without reading bytes or emitting image syntax', async () => {
  const h = runtime();
  for (const format of ['markdown', 'txt']) {
    const plan = h.plan(format), output = await h.api.generateExport(plan, { messages });
    assert.equal(plan.zipped, false);
    assert.equal(plan.assets?.length || 0, 0);
    assert.deepEqual(Array.from(output.warnings), []);
    const text = Buffer.from(output.bytes).toString('utf8');
    for (let index = 0; index < sources.length; index++) assert.ok(text.includes('image-' + index));
    assert.ok(text.includes(sources[2]), 'public image address remains a readable link');
    assert.doesNotMatch(text, /!\[|assets\//);
    assert.equal(h.calls.length, 0, 'text formats do not fetch even when media is enabled');
    const off = await h.api.generateExport(h.plan(format, false), { messages });
    assert.equal(h.calls.length, 0);
    assert.doesNotMatch(Buffer.from(off.bytes).toString('utf8'), /image-[012]|public\.example/);
  }
});

for (const failure of ['rejected', 'http', 'empty']) test('unavailable public image retains PDF fallback while Markdown remains network-independent: ' + failure, async () => {
  const h = runtime({ failure });
  const pdfOutput = await h.api.generateExport(h.plan('pdf'), { messages });
  const pdf = await h.context.PDFLib.PDFDocument.load(pdfOutput.bytes);
  assert.equal(imageObjects(h.context, pdf).length, 2, 'failure must not remove other image sources');
  assert.equal(pdfOutput.warnings.length, 1);
  assert.ok(pdfOutput.warnings[0].includes('image-2'));
  const callsBeforeMarkdown = h.calls.length;
  const mdOutput = await h.api.generateExport(h.plan('markdown'), { messages });
  const text = Buffer.from(mdOutput.bytes).toString('utf8');
  assert.ok(text.includes(sources[2]), 'readable public source does not depend on a successful download');
  assert.doesNotMatch(text, /!\[|assets\//);
  assert.equal(mdOutput.warnings.length, 0, 'no image-download warning for a format that does not download images');
  assert.equal(h.calls.length, callsBeforeMarkdown);
  assert.equal(h.calls.filter(c => c.source === sources[2]).length, 1, 'PDF makes one attempt, Markdown makes none');
});

test('PDF media-off never reads images and injected assetLoader remains the explicit override', async () => {
  const h = runtime();
  const off = await h.api.generateExport(h.plan('pdf', false), { messages });
  const pdf = await h.context.PDFLib.PDFDocument.load(off.bytes);
  assert.equal(imageObjects(h.context, pdf).length, 0);
  assert.equal(h.calls.some(call => sources.includes(call.source)), false);
  h.calls.length = 0;
  await h.api.generateExport(h.plan('markdown'), { messages, assetLoader: async () => { assert.fail('Markdown must not invoke an image loader'); } });
  await h.api.generateExport(h.plan('pdf'), { messages, assetLoader: async source => source.startsWith('./vendor/fonts/')
    ? new Uint8Array(fs.readFileSync(path.join(root, 'src/assets/fonts', source.slice('./vendor/fonts/'.length)))) : png });
  assert.equal(h.calls.length, 0, 'a supplied loader is never silently bypassed');
});

test('all default consumers delegate to the one fetch implementation and worker loads it explicitly', () => {
  const read = file => fs.readFileSync(path.join(root, 'src/features/export/engine', file), 'utf8');
  for (const file of ['job-worker.js', 'pdf.js']) {
    assert.match(read(file), /api\.readExportAsset\(/, file);
    assert.doesNotMatch(read(file), /\bfetch\s*\(/, file);
  }
  assert.doesNotMatch(read('download.js'), /\bfetch\s*\(|api\.readExportAsset\(/, 'text and archive writer does not own image loading');
  const scripts = [];
  vm.runInNewContext(read('job-worker.js'), { importScripts: (...names) => scripts.push(...names), TidyExport: {} });
  assert.equal(scripts.filter(name => name === './assets.js').length, 1);
  assert.ok(scripts.indexOf('./assets.js') < scripts.indexOf('./pdf.js'));
  assert.ok(scripts.indexOf('./assets.js') < scripts.indexOf('./download.js'));
});
