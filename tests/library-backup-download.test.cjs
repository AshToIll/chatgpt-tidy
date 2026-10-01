const test = require('node:test'), assert = require('node:assert/strict');
const modulePromise = import('../src/features/settings/ui/library-backup-view.js');
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(setImmediate); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function harness() {
  const { downloadLibraryBackup } = await modulePromise;
  const calls = [], revoked = [], listeners = new Set(), chooser = deferred();
  let state = 'in_progress', searchFails = false, blob;
  const downloads = {
    download: async options => { calls.push(options); return chooser.promise; },
    search: async () => { if (searchFails) throw Error('Unavailable'); return [{ id: 17, state }]; },
    onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
  };
  const urls = { createObjectURL: value => { blob = value; return 'blob:backup'; }, revokeObjectURL: url => revoked.push(url) };
  return { calls, revoked, listeners, chooser, blob: () => blob,
    download: () => downloadLibraryBackup({ text: '{"sample":true}', filename: 'TIDY-library.json' }, { downloads, urls }),
    state: value => { state = value; }, failSearch: () => { searchFails = true; },
    emit: (id, state) => { for (const fn of listeners) fn({ id, state: { current: state } }); },
  };
}

test('backup always asks for a save location and retains its Blob throughout the chooser', async () => {
  const h = await harness(), pending = h.download();
  assert.deepEqual(h.calls, [{ url: 'blob:backup', filename: 'TIDY-library.json', saveAs: true, conflictAction: 'uniquify' }]);
  assert.equal(await h.blob().text(), '{"sample":true}');
  assert.equal(h.blob().type, 'application/json;charset=utf-8');
  await flush(); assert.equal(h.revoked.length, 0);
  h.chooser.resolve(17); assert.equal(await pending, true);
  assert.equal(h.revoked.length, 0, 'Browser receipt is not file completion');
  h.emit(18, 'complete'); assert.equal(h.revoked.length, 0, 'Another download cannot release this file');
  h.emit(17, 'complete'); h.emit(17, 'complete');
  assert.deepEqual(h.revoked, ['blob:backup']); assert.equal(h.listeners.size, 0);
});

for (const message of ['Download canceled', 'Download cancelled']) test(`save chooser cancellation is quiet: ${message}`, async () => {
  const h = await harness(), pending = h.download(); h.chooser.reject(Error(message));
  assert.equal(await pending, false); assert.deepEqual(h.revoked, ['blob:backup']); assert.equal(h.listeners.size, 0);
});

test('real download errors are propagated, with no retained Blob or listener', async () => {
  const h = await harness(), pending = h.download(); h.chooser.reject(Error('File access denied'));
  await assert.rejects(pending, /access denied/); assert.deepEqual(h.revoked, ['blob:backup']); assert.equal(h.listeners.size, 0);
});

test('missing download receipt cannot claim a successful handoff', async () => {
  const h = await harness(), pending = h.download(); h.chooser.resolve(undefined);
  await assert.rejects(pending, /Missing backup download receipt/); assert.deepEqual(h.revoked, ['blob:backup']);
});

for (const state of ['complete', 'interrupted']) test(`already ${state} download closes the receipt/listener race`, async () => {
  const h = await harness(), pending = h.download(); h.state(state); h.chooser.resolve(17);
  assert.equal(await pending, true); assert.deepEqual(h.revoked, ['blob:backup']); assert.equal(h.listeners.size, 0);
});

test('interruption releases the exact backup even if initial status query fails', async () => {
  const h = await harness(), pending = h.download(); h.failSearch(); h.chooser.resolve(17);
  assert.equal(await pending, true); assert.equal(h.revoked.length, 0);
  h.emit(17, 'interrupted'); assert.deepEqual(h.revoked, ['blob:backup']); assert.equal(h.listeners.size, 0);
});
