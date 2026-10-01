const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), test = require('node:test');
const files = ['pdf-lib-1.17.1.min.js', 'regenerator-runtime-0.14.1.js', 'fontkit-1.1.1.min.js', 'jszip-3.10.1.min.js'];
function runtime() {
  const requested = [];
  const context = vm.createContext({ TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, setTimeout, clearTimeout, setImmediate });
  const run = path => vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
  context.importScripts = path => {
    assert.ok(files.some(file => path === '../../../vendor/' + file), 'only fixed packaged files');
    requested.push(path.split('/').pop()); run('src/vendor/' + path.split('/').pop());
  };
  run('src/features/export/engine/i18n.js'); run('src/features/export/engine/dependencies.js');
  return { context, requested, run, api: context.TidyExport };
}
test('plain formats need no large libraries; PDF and ZIP load only their own dependencies', async () => {
  const h = runtime();
  for (const format of ['markdown', 'json', 'txt']) await h.api.ensureExportDependencies({ format });
  assert.deepEqual(h.requested, []);
  await h.api.ensureExportDependencies({ zipped: true }); assert.deepEqual(h.requested, [files[3]]);
  await h.api.ensureExportDependencies({ format: 'pdf' }); assert.deepEqual(h.requested, [files[3], ...files.slice(0, 3)]);
});
test('repeated and concurrent calls initialize packaged libraries once', async () => {
  const h = runtime(), plan = { format: 'pdf', zipped: true };
  await Promise.all([h.api.ensureExportDependencies(plan), h.api.ensureExportDependencies(plan)]);
  assert.deepEqual(h.requested, files);
  const pdf = await h.context.PDFLib.PDFDocument.create(); pdf.addPage();
  const bytes = await pdf.save(); assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), '%PDF');
  const zip = new h.context.JSZip(); zip.file('test.pdf', bytes);
  assert.deepEqual(Array.from((await zip.generateAsync({ type: 'uint8array' })).slice(0, 2)), [80, 75]);
});
test('failed or missing library export fails explicitly, without a DOM injection fallback', async () => {
  const h = runtime(); const load = h.context.importScripts;
  h.context.importScripts = () => { throw Error('missing file'); };
  await assert.rejects(h.api.ensureExportDependencies({ zipped: true }), /exportDependencyFailed/);
  h.context.importScripts = () => {};
  await assert.rejects(h.api.ensureExportDependencies({ zipped: true }), /exportDependencyNotReady/);
  delete h.context.importScripts;
  await assert.rejects(h.api.ensureExportDependencies({ zipped: true }), /exportDependencyEnvironment/);
  h.context.importScripts = load; await h.api.ensureExportDependencies({ zipped: true });
});
test('generation cannot fetch images or serialize before dependencies are available', async () => {
  const h = runtime(); h.run('src/features/export/engine/assets.js'); h.run('src/features/export/engine/download.js'); delete h.context.importScripts;
  let touched = 0; h.api.serializePdf = async () => { touched++; };
  await assert.rejects(h.api.generateExport({ format: 'pdf', files: [{ path: 'one.pdf' }] }, { assetLoader: async () => { touched++; } }), /exportDependencyEnvironment/);
  assert.equal(touched, 0);
});
