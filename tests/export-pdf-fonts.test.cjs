const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { exportMessages } = require('./helpers/export-i18n.cjs');
const root = path.resolve(__dirname, '..');
const context = vm.createContext({ URL, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, setTimeout, clearTimeout, setImmediate });
for (const file of ['vendor/pdf-lib-1.17.1.min.js', 'vendor/regenerator-runtime-0.14.1.js', 'vendor/fontkit-1.1.1.min.js',
  'features/export/engine/i18n.js', 'features/export/engine/assets.js', 'features/export/engine/normalize.js', 'features/export/engine/plan.js',
  'features/export/engine/inline-content.js', 'features/export/engine/serializers.js', 'features/export/engine/pdf.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'src', file), 'utf8'), context, { filename: file });
}
const api = context.TidyExport;
const messages = exportMessages('en');
const options = { timestamps: false, messageNumbers: false };
const assetLoader = async source => new Uint8Array(fs.readFileSync(path.join(root, 'src/assets/fonts', source.slice('./vendor/fonts/'.length))));
function fileFor(block) {
  const data = api.normalizeExportData({ conversations: [{
    id: 'pagination', title: 'Pagination', createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z',
    resources: [], messages: [{ id: 'answer', role: 'assistant', timestamp: null, messageNumber: 1, segments: [
      { type: 'content', sourceMessageId: 'answer', timestamp: null, blocks: [block] },
    ] }],
  }], bookmarks: [] });
  return api.buildExportPlan({ messages, options, data, mode: 'current', format: 'pdf', currentConversationId: 'pagination' }).files[0];
}

async function render(block, extra = {}) {
  const loaded = [];
  const result = await api.serializePdf(fileFor(block), { messages, options, ...extra, assetLoader: async source => {
    loaded.push(source);
    return assetLoader(source);
  } });
  assert.deepEqual(Array.from(result.warnings), []);
  return { result, loaded };
}
test('CJK body covered by primary regular shards does not load redundant Japanese/Korean fallback fonts', async () => {
  const { loaded } = await render({ type: 'paragraph', text: '抽取骨架绘制图片，中文字体不能丢失。' });
  assert.deepEqual(loaded.filter(source => /fallback\/.*\.ttf$/.test(source)), []);
});
test('regular-only Arabic text loads only its regular fallback weight', async () => {
  const { loaded } = await render({ type: 'paragraph', text: 'مرحبا بالعالم' });
  assert.ok(loaded.some(source => /fallback\/.*regular/.test(source)));
  assert.ok(!loaded.some(source => /fallback\/.*medium/.test(source)), loaded.join('\n'));
});
test('Arabic headings retain the required medium fallback weight', async () => {
  const { loaded } = await render({ type: 'heading', level: 2, text: 'مرحبا بالعالم' });
  assert.ok(loaded.some(source => /fallback\/.*medium/.test(source)), loaded.join('\n'));
});
