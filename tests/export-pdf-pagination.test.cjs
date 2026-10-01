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
function fileFor(table) {
  const data = api.normalizeExportData({ conversations: [{
    id: 'pagination', title: 'Pagination', createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z',
    resources: [], messages: [{ id: 'answer', role: 'assistant', timestamp: null, messageNumber: 1, segments: [
      { type: 'content', sourceMessageId: 'answer', timestamp: null, blocks: [table] },
    ] }],
  }], bookmarks: [] });
  return api.buildExportPlan({ messages, options, data, mode: 'current', format: 'pdf', currentConversationId: 'pagination' }).files[0];
}
// Inspect saved PDF streams and per-page font maps. An input/string mock cannot prove pagination.
async function pageTexts(bytes) {
  const P = context.PDFLib, document = await P.PDFDocument.load(bytes);
  const unpack = stream => Buffer.from(P.decodePDFRawStream(stream).decode()).toString('latin1');
  return document.getPages().map(page => {
    const maps = new Map(), output = [];
    for (const [name, ref] of page.node.Resources().lookup(P.PDFName.of('Font')).entries()) {
      const cmap = unpack(document.context.lookup(ref).lookup(P.PDFName.of('ToUnicode'))), glyphs = new Map();
      for (const section of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const pair of section[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>/gi))
          glyphs.set(pair[1].toUpperCase(), new TextDecoder('utf-16be').decode(Buffer.from(pair[2], 'hex')));
      }
      maps.set(name.toString().slice(1), glyphs);
    }
    const contents = page.node.Contents(), streams = contents instanceof P.PDFArray
      ? Array.from({ length: contents.size() }, (_, index) => contents.lookup(index)) : [contents];
    let font;
    for (const stream of streams) for (const token of unpack(stream).matchAll(/\/([A-Za-z0-9_-]+)\s+[-+.\d]+\s+Tf|<([\da-f]+)>\s*Tj/gi)) {
      if (token[1]) { font = maps.get(token[1]); assert.ok(font); continue; }
      for (const code of token[2].match(/.{4}/g)) { assert.ok(font.has(code.toUpperCase())); output.push(font.get(code.toUpperCase())); }
    }
    return output.join('');
  });
}
const configurations = ['A4', 'Letter'].flatMap(pageSize => ['portrait', 'landscape'].flatMap(orientation =>
  ['small', 'standard', 'large'].map(fontSize => ({ pageSize, orientation, fontSize }))));
for (const pdf of configurations) test('PDF moves complete table rows together: ' + Object.values(pdf).join('/'), async () => {
  const rowIds = Array.from({ length: 11 }, (_, i) => 'R' + String(i).padStart(2, '0'));
  const file = fileFor({ type: 'table', headers: ['Identity', 'Detail'], rows: rowIds.map(id =>
    [id + '-NAME', Array.from({ length: 7 }, (_, i) => id + '-L' + i + '-END').join('\n')]) });
  const result = await api.serializePdf(file, { messages, options, pdf, assetLoader });
  assert.deepEqual(Array.from(result.warnings), []);
  const pages = await pageTexts(result.bytes);
  assert.ok(pages.length > 1);
  for (const id of rowIds) {
    const owners = pages.filter(text => text.includes(id + '-'));
    assert.equal(owners.length, 1, id + ' was split across pages');
    assert.ok(owners[0].includes(id + '-NAME'));
    for (let i = 0; i < 7; i++) assert.ok(owners[0].includes(id + '-L' + i + '-END'));
  }
  for (const page of pages.filter(text => /R\d\d-/.test(text))) assert.ok(page.includes('Identity') && page.includes('Detail'));
});
test('oversized table rows split without missing text and repeat normal headers', { timeout: 30000 }, async () => {
  const lines = Array.from({ length: 130 }, (_, i) => 'CELL-' + String(i).padStart(3, '0') + '-END');
  const file = fileFor({ type: 'table', headers: ['Identity', 'Detail'], rows: [['Tall row', lines.join('\n')], ['Tail name', 'TAIL-END']] });
  const result = await api.serializePdf(file, { messages, options, pdf: { orientation: 'landscape', fontSize: 'large' }, assetLoader });
  const pages = await pageTexts(result.bytes), text = pages.join('');
  assert.ok(pages.length >= 3 && pages.length < 15);
  for (const line of lines) assert.equal(text.split(line).length - 1, 1, line);
  assert.equal(text.split('TAIL-END').length - 1, 1);
  for (const page of pages.filter(text => text.includes('CELL-'))) assert.ok(page.includes('Identity') && page.includes('Detail'));
});
test('oversized table headers retain every line and leave body rows forward progress', { timeout: 30000 }, async () => {
  const labels = Array.from({ length: 105 }, (_, i) => 'HEADER-' + String(i).padStart(3, '0') + '-END');
  const file = fileFor({ type: 'table', headers: [labels.join('\n')], rows: [['BODY-ONE'], ['BODY-TWO']] });
  const result = await api.serializePdf(file, { messages, options, pdf: { orientation: 'landscape', fontSize: 'large' }, assetLoader });
  const pages = await pageTexts(result.bytes), text = pages.join('');
  assert.ok(pages.length >= 3 && pages.length < 12);
  for (const line of labels) assert.equal(text.split(line).length - 1, 1, line);
  assert.equal(text.split('BODY-ONE').length - 1, 1);
  assert.equal(text.split('BODY-TWO').length - 1, 1);
});
