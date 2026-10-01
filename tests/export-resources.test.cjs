const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const flush = () => new Promise(setImmediate);
const resource = id => ({ id, type: 'image', name: id, alt: id, mimeType: '', sizeBytes: null, src: '', pending: true, readHandle: 'image-1-' + id });
function harness() {
  const c = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, 'src/features/export/model/export.js'), 'utf8'), c);
  vm.runInContext(fs.readFileSync(path.join(root, 'src/features/export/ui/export-resources.js'), 'utf8').replace(/^export /gm, ''), c);
  const calls = [], resolved = [];
  const reader = c.createExportResources({ validResource: c.TidyExportContract.validResource, onResolved: receipt => resolved.push(receipt),
    request: p => new Promise((resolve, reject) => calls.push({ p, resolve, reject })) });
  const settle = (i, image) => calls[i].resolve({ readHandle: calls[i].p.readHandle, resource: { ...image, pending: false, src: 'https://chatgpt.com/image.png' } });
  return { reader, calls, settle, resolved };
}
test('images are bounded to 3 concurrent reads; completion pumps exactly the next item', async () => {
  const h = harness(), resources = Array.from({ length: 7 }, (_, i) => resource('r' + i));
  h.reader.update({ accountKey: 'a', enabled: true, resources }); await flush();
  assert.equal(h.calls.length, 3);
  h.settle(0, resources[0]); await flush();
  assert.equal(h.calls.length, 4);
  assert.equal(resources[0].pending, true); assert.equal(resources[0].readHandle, 'image-1-r0');
  assert.equal(resources[0].src, '', 'transport must not mutate the document owner');
  assert.equal(h.resolved[0].accountKey, 'a'); assert.equal(h.resolved[0].readHandle, 'image-1-r0');
  assert.equal(h.resolved[0].resource.pending, false);
  assert.equal(h.resolved[0].resource.src, 'https://chatgpt.com/image.png');
  assert.notEqual(h.resolved[0].resource, resources[0]);
  h.reader.update({ accountKey: 'a', enabled: false, resources: [] });
  h.settle(1, resources[1]); h.settle(2, resources[2]); h.settle(3, resources[3]); await flush();
  assert.equal(h.calls.length, 4); assert.equal(h.resolved.length, 1); assert.equal(resources[1].pending, true);
});
for (const boundary of ['disabled', 'account', 'document', 'suspended-return']) test(`late images cannot cross ${boundary}`, async () => {
  const h = harness(), image = resource('one');
  h.reader.update({ accountKey: 'a', enabled: true, resources: [image] }); await flush();
  if (boundary === 'disabled') h.reader.update({ accountKey: 'a', enabled: false, resources: [] });
  if (boundary === 'account') h.reader.update({ accountKey: 'b', enabled: true, resources: [] });
  if (boundary === 'document') h.reader.update({ accountKey: 'a', enabled: true, resources: [resource('new')] });
  if (boundary === 'suspended-return') {
    h.reader.update({ accountKey: 'a', enabled: false, resources: [] });
    h.reader.update({ accountKey: 'a', enabled: true, resources: [] });
  }
  h.settle(0, image); await flush(); assert.equal(image.pending, true); assert.equal(h.resolved.length, 0);
});
test('off before the request microtask dispatches no network work', async () => {
  const h = harness(); h.reader.update({ accountKey: 'a', enabled: true, resources: [resource('x')] });
  h.reader.update({ accountKey: 'a', enabled: false, resources: [] }); await flush(); assert.equal(h.calls.length, 0);
});
test('repeated presentation updates are single-flight and a failed image ends with an explicit missing resource', async () => {
  const h = harness(), image = resource('x');
  for (let i = 0; i < 5; i++) h.reader.update({ accountKey: 'a', enabled: true, resources: [image] });
  await flush(); assert.equal(h.calls.length, 1); h.calls[0].reject(Error('failed')); await flush();
  assert.equal(image.pending, true); assert.equal(image.src, ''); assert.equal(h.resolved.length, 1);
  assert.equal(h.resolved[0].resource.pending, false); assert.equal(h.resolved[0].resource.src, '');
  assert.equal(h.resolved[0].resource.id, 'x'); assert.equal(h.resolved[0].readHandle, image.readHandle);
  for (let i = 0; i < 5; i++) h.reader.update({ accountKey: 'a', enabled: true, resources: [image] });
  await flush(); assert.equal(h.calls.length, 1); assert.equal(h.resolved.length, 1);
});
test('wrong resource identity cannot be substituted into the selected image', async () => {
  const h = harness(), image = resource('x');
  h.reader.update({ accountKey: 'a', enabled: true, resources: [image] }); await flush();
  h.settle(0, resource('other')); await flush();
  assert.equal(image.id, 'x'); assert.equal(image.src, ''); assert.equal(image.pending, true);
  assert.equal(h.resolved.length, 1); assert.equal(h.resolved[0].resource.id, 'x');
  assert.equal(h.resolved[0].resource.src, ''); assert.equal(h.resolved[0].resource.pending, false);
  assert.equal(h.resolved[0].accountKey, 'a'); assert.equal(h.resolved[0].readHandle, image.readHandle);
});
