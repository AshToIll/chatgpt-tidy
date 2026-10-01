const test = require('node:test'), assert = require('node:assert/strict');
const serviceModule = import('../src/features/export/background/export-job-service.js');
const KEY = 'tidy.export-job.v1', CHANNEL = 'tidy.export-host.v1';
const owner = { tabId: 1, accountKey: 'owner-a', documentId: 'doc-a', epoch: 1 };
const plain = x => structuredClone(x);
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
const spec = () => ({ plan: { format: 'txt', outputName: 'private-name.txt', messages: {}, files: [{ kind: 'conversation', path: 'one.txt', conversations: [{ messages: [{ text: 'private-body' }], resources: [] }] }] }, context: {}, warnings: [] });
async function harness() {
  const { createExportJobService } = await serviceModule;
  const data = {}, items = [], calls = [], notifications = [];
  let running = null, exists = false, valid = true, downloadHook = null, createHook = null, stopError = false;
  const chrome = {
    runtime: { id: 'test', getURL: p => `chrome-extension://test/${p}`, getContexts: async () => exists ? [{}] : [],
      sendMessage: async m => {
        calls.push(plain(m));
        if (m.type === 'stop' && stopError) throw Error('stop unconfirmed');
        if (m.type === 'run') running = { id: m.id, state: 'generating' };
        if (m.type === 'stop' && m.id === running?.id) running = null;
        return { ok: true, job: plain(running) };
      } },
    storage: { session: { get: async k => plain({ [k]: data[k] }), set: async value => Object.assign(data, plain(value)) } },
    offscreen: { createDocument: async options => { calls.push({ type: 'create-host', ...options }); if (createHook) await createHook(); exists = true; },
      closeDocument: async () => { calls.push({ type: 'close-host' }); exists = false; } },
    downloads: {
      download: async p => { calls.push({ type: 'download', ...p }); if (downloadHook) return downloadHook(p); const id = items.length + 1; items.push({ id, url: p.url, byExtensionId: 'test', state: 'in_progress' }); return id; },
      search: async q => plain(items.filter(i => q.id != null ? i.id === q.id : i.url === q.url)),
      cancel: async id => { calls.push({ type: 'cancel', id }); const item = items.find(i => i.id === id); if (item) { item.state = 'interrupted'; item.error = 'USER_CANCELED'; } },
    },
  };
  const make = () => createExportJobService({ chrome, verifyOwner: async () => { if (!valid) throw Error('Owner changed'); }, notify: n => notifications.push(n) });
  const service = make(), sender = { id: 'test', url: chrome.runtime.getURL('features/export/engine/offscreen.html') };
  const hostMessage = (type, extra = {}, from = sender, use = service) => use.acceptHost({ channel: CHANNEL, target: 'service', id: data[KEY]?.id, type, ...extra }, from);
  const ready = async (use = service) => { running = { id: data[KEY].id, state: 'ready', blobUrl: `blob:chrome-extension://test/${data[KEY].id}`, warnings: [] }; await hostMessage('ready', running, sender, use); await flush(); };
  return { service, make, chrome, data, items, calls, notifications, hostMessage, ready,
    start: (id = 'job-a', use = service, input = spec()) => use.start(owner, { id, spec: input }),
    loseOwner: () => { valid = false; }, restoreOwner: () => { valid = true; },
    hostExists: () => exists, failStop: value => { stopError = value; },
    setHost: value => { running = value; }, setDownload: hook => { downloadHook = hook; }, setCreate: hook => { createHook = hook; } };
}

test('contract rejects unsafe destinations and invalid files; receipt never exposes body or URLs', async () => {
  await serviceModule; const c = globalThis.TidyExportJobs;
  assert.equal(c.validSpec(spec()), true);
  for (const change of [p => p.plan.outputName = '../x', p => p.plan.files = [null], p => p.plan.files[0].path = '../x', p => p.plan.files[0].conversations = null]) {
    const p = spec(); change(p); assert.equal(c.validSpec(p), false);
  }
  const record = { id: 'a', state: 'generating', owner, outputName: 'private', blobUrl: 'private-url', plan: spec().plan };
  assert.deepEqual(c.receipt(record, { ...owner, tabId: 2 }), { state: 'busy' });
  assert.equal(c.receipt({ ...record, state: 'completed' }, { ...owner, accountKey: 'other' }), null);
  assert.doesNotMatch(JSON.stringify(c.receipt(record, owner)), /private-url|private-body|accountKey|documentId/);
});

test('concurrent starts have one admission, no queue, and unchanged status causes no event loop', async () => {
  const h = await harness(); const [a, b] = await Promise.all([h.start(), h.start('job-b')]);
  assert.equal(a.id, b.id); assert.equal(h.calls.filter(c => c.type === 'run').length, 1);
  const count = h.notifications.length;
  await h.service.status(owner); await h.service.status(owner);
  assert.equal(h.notifications.length, count);
  assert.doesNotMatch(JSON.stringify(h.data), /private-body|conversations|resources/);
  assert.deepEqual(await h.service.status({ ...owner, tabId: 2 }), { state: 'busy' });
});

test('pending selected images cannot enter the background job, but unrelated bookmark images do not block it', async () => {
  await serviceModule; const c = globalThis.TidyExportJobs, p = spec();
  const conversation = { resources: [{ id: 'image', pending: true }], messages: [{ segments: [{ blocks: [{ type: 'image', resourceId: 'image' }] }] }] };
  p.plan.files[0].conversations = [conversation];
  for (const format of ['markdown', 'txt']) { p.plan.format = format; assert.equal(c.validSpec(p), true, format + ' does not resolve images'); }
  for (const format of ['pdf', 'json']) { p.plan.format = format; assert.equal(c.validSpec(p), false, format + ' requires complete image resources'); }
  p.plan.files[0] = { path: 'excerpt.txt', kind: 'bookmark-excerpt', bookmarkEntries: [{ conversation, message: { segments: [{ blocks: [] }] } }] };
  assert.equal(c.validSpec(p), true);
  p.plan.files[0].bookmarkEntries[0].message = conversation.messages[0];
  assert.equal(c.validSpec(p), false);
});

test('dismissing a terminal notice persists across workers and cannot affect an active or foreign job', async () => {
  const h = await harness(); await h.start();
  await assert.rejects(h.service.dismiss(owner, 'job-a'));
  await h.ready(); h.items[0].state = 'complete'; await h.service.downloadChanged(1);
  await assert.rejects(h.service.dismiss({ ...owner, tabId: 2 }, 'job-a'));
  await assert.rejects(h.service.dismiss({ ...owner, accountKey: 'other' }, 'job-a'));
  await assert.rejects(h.service.dismiss(owner, 'wrong-id'));
  const actions = h.calls.length;
  const saved = await h.service.dismiss(owner, 'job-a');
  assert.equal(saved.state, 'completed'); assert.ok(saved.dismissedAt);
  assert.equal(h.calls.length, actions, 'dismiss is not a host or download action');
  const restarted = h.make();
  assert.deepEqual(await restarted.status(owner), saved);
  assert.deepEqual(await restarted.dismiss(owner, 'job-a'), saved, 'repeated dismiss is idempotent');
  await h.start('job-b', restarted);
  assert.equal((await restarted.status(owner)).dismissedAt, null);
});

test('progress, ready and failure require exact offscreen sender and task id', async () => {
  const h = await harness(); await h.start();
  for (const sender of [{ id: 'other', url: 'chrome-extension://test/features/export/engine/offscreen.html' },
    { id: 'test', url: 'chrome-extension://test/app/sidepanel/index.html' }, { id: 'test', url: 'chrome-extension://test/features/export/engine/offscreen.html', tab: { id: 1 } }]) {
    assert.equal(await h.hostMessage('failed', {}, sender), false);
  }
  await h.hostMessage('failed', { id: 'old-id' }); assert.equal(h.data[KEY].state, 'generating');
  await h.hostMessage('progress', { progress: { phase: 'resources', done: 2, total: null } });
  assert.equal((await h.service.status(owner)).progress.done, 2);
  await h.hostMessage('failed', { errorCode: 'https://private-token/' });
  assert.equal(h.data[KEY].errorCode, 'exportJobFailed');
  assert.equal(h.calls.at(-1).type, 'stop');
});

test('cancel stops the host and late ready cannot start a download; new id can run', async () => {
  const h = await harness(); await h.start();
  assert.equal((await h.service.cancel(owner, 'job-a')).state, 'cancelled');
  await h.ready(); assert.equal(h.calls.filter(c => c.type === 'download').length, 0);
  assert.equal((await h.start('job-b')).id, 'job-b');
  assert.equal((await h.start('job-b')).id, 'job-b');
  assert.equal(h.calls.filter(c => c.type === 'run').length, 2);
});

// Cancellation intent must survive a failed stop acknowledgement. It revokes
// download authorization immediately, but does not claim the worker is stopped.
test('unconfirmed generation cancellation keeps its intent and ignores late host events', async () => {
  const h = await harness(); await h.start();
  const revision = h.data[KEY].revision;
  h.failStop(true);
  await assert.rejects(h.service.cancel(owner, 'job-a'), /stop unconfirmed/);
  assert.equal(h.data[KEY].state, 'cancelling');
  assert.equal(h.data[KEY].revision, revision + 1);
  assert.equal(globalThis.TidyExportJobs.active(h.data[KEY]), true);
  assert.equal(h.hostExists(), true);
  await h.ready();
  await h.hostMessage('progress', { progress: { phase: 'files', done: 1, total: 1 } });
  await h.hostMessage('failed', { errorCode: 'exportJobFailed' });
  assert.equal(h.data[KEY].state, 'cancelling');
  assert.equal(h.data[KEY].revision, revision + 1);
  assert.equal(h.calls.filter(c => c.type === 'download').length, 0);
  await assert.rejects(h.start('job-b'), /stop unconfirmed/);
  assert.equal(h.data[KEY].id, 'job-a');
  assert.equal(h.calls.filter(c => c.type === 'run').length, 1);
  h.failStop(false);
  assert.equal((await h.service.status(owner)).state, 'cancelled');
  const stopped = h.calls.filter(c => c.type === 'stop').length;
  assert.equal((await h.service.cancel(owner, 'job-a')).state, 'cancelled');
  assert.equal((await h.start()).state, 'cancelled');
  assert.equal(h.calls.filter(c => c.type === 'stop').length, stopped);
  assert.equal((await h.start('job-b')).state, 'generating');
  assert.equal(h.calls.filter(c => c.type === 'run').length, 2);
});

for (const entry of ['status', 'cancel', 'start', 'observeOwner', 'revoke']) {
  test(entry + ': restarted generation cancellation retries cleanup without browser handoff or replay', async () => {
    const h = await harness(); await h.start(); h.failStop(true);
    await assert.rejects(h.service.cancel(owner, 'job-a'), /stop unconfirmed/);
    await h.ready();
    const restarted = h.make();
    // No Blob has been handed to downloads: recovery must not search unrelated
    // browser downloads using an undefined URL, or regenerate the cancelled job.
    h.chrome.downloads.search = async () => { assert.fail('generation cancellation must not query downloads'); };
    const recover = () => ({
      status: () => restarted.status(owner),
      cancel: () => restarted.cancel(owner, 'job-a'),
      start: () => h.start('job-b', restarted),
      observeOwner: () => restarted.observeOwner(owner.tabId, { phase: 'unavailable' }),
      revoke: () => restarted.revoke(owner.tabId),
    })[entry]();
    await assert.rejects(recover(), /stop unconfirmed/);
    assert.equal(h.data[KEY].state, 'cancelling');
    assert.equal(h.data[KEY].id, 'job-a');
    assert.equal(h.calls.filter(c => c.type === 'run').length, 1);
    h.failStop(false);
    await recover();
    assert.equal(h.data[KEY].state, entry === 'start' ? 'generating' : 'cancelled');
    assert.equal(h.data[KEY].id, entry === 'start' ? 'job-b' : 'job-a');
    assert.equal(h.calls.filter(c => c.type === 'download').length, 0);
    assert.equal(h.calls.filter(c => c.type === 'run').length, entry === 'start' ? 2 : 1);
  });
}

test('ready queued before cancellation cannot dispatch after an unconfirmed stop', async () => {
  const h = await harness(); await h.start(); h.failStop(true);
  // acceptHost schedules its dispatch behind the already-queued cancellation.
  const ready = h.hostMessage('ready', { blobUrl: 'blob:chrome-extension://test/job-a', warnings: [] });
  const cancellation = h.service.cancel(owner, 'job-a');
  await ready;
  await assert.rejects(cancellation, /stop unconfirmed/);
  await flush();
  assert.equal(h.data[KEY].state, 'cancelling');
  assert.equal(h.calls.filter(c => c.type === 'download').length, 0);
  h.failStop(false);
  assert.equal((await h.service.status(owner)).state, 'cancelled');
});

test('same task id remains idempotent even after terminal failure', async () => {
  const h = await harness(); h.setCreate(async () => { throw Error('denied'); });
  assert.equal((await h.start()).state, 'failed');
  assert.equal((await h.start()).state, 'failed'); assert.equal(h.calls.filter(c => c.type !== 'create-host').length, 0);
});

test('download accepted is saving, not saved; only actual complete releases the Blob', async () => {
  const h = await harness(); await h.start(); await h.ready();
  assert.equal((await h.service.status(owner)).state, 'saving');
  assert.equal(h.calls.filter(c => c.type === 'stop').length, 0);
  await h.ready(); assert.equal(h.calls.filter(c => c.type === 'download').length, 1);
  h.items[0].state = 'complete'; await h.service.downloadChanged(1);
  assert.equal((await h.service.status(owner)).state, 'completed');
  assert.equal(h.calls.filter(c => c.type === 'stop').length, 1);
});

for (const format of ['markdown', 'json', 'txt', 'pdf', 'zip']) test(`${format} export uses one Save As handoff`, async () => {
  const h = await harness(), input = spec();
  input.plan.format = format === 'zip' ? 'txt' : format;
  input.plan.outputName = `chosen.${format}`;
  if (format === 'zip') input.plan.files.push({ ...input.plan.files[0], path: 'two.txt' });
  await h.start('job-a', h.service, input); await h.ready();
  const calls = h.calls.filter(call => call.type === 'download');
  assert.equal(calls.length, 1); assert.equal(calls[0].saveAs, true);
  assert.equal(calls[0].filename, input.plan.outputName);
});

test('chooser cancel is not a failure and releases the host for the next export', async () => {
  const h = await harness(); h.setDownload(async () => { throw Error('Download canceled'); });
  await h.start(); await h.ready();
  const receipt = await h.service.status(owner);
  assert.equal(receipt.state, 'cancelled'); assert.equal(receipt.errorCode, '');
  assert.equal(h.data['tidy.export-retired-handoffs.v1'], undefined, 'Known cancellation must not retain a revoked handoff');
  assert.equal(h.calls.filter(call => call.type === 'stop').length, 1);
  h.setDownload(null); assert.equal((await h.start('job-b')).state, 'generating');
  await h.ready(); assert.equal((await h.service.status(owner)).state, 'saving');
});

test('chooser failure remains a save error, not a cancellation or saved receipt', async () => {
  const h = await harness(); h.setDownload(async () => { throw Error('File access denied'); });
  await h.start(); await h.ready();
  const receipt = await h.service.status(owner);
  assert.equal(receipt.state, 'failed'); assert.equal(receipt.errorCode, 'exportJobSaveFailed');
  assert.equal(h.data['tidy.export-retired-handoffs.v1'], undefined);
});

test('pending Save As remains responsive and repeated start/status never opens another window', async () => {
  const h = await harness(); let resolve;
  h.setDownload(() => new Promise(yes => { resolve = yes; })); await h.start(); await h.ready();
  for (let i = 0; i < 3; i++) {
    assert.equal((await h.service.status(owner)).state, 'saving');
    assert.equal((await h.start('job-b')).id, 'job-a');
  }
  assert.equal(h.calls.filter(call => call.type === 'download').length, 1);
  h.items.push({ id: 9, url: h.data[KEY].blobUrl, state: 'complete', byExtensionId: 'test' }); resolve(9); await flush();
  assert.equal((await h.service.status(owner)).state, 'completed');
});

test('Save As renaming updates the receipt without retaining a local directory', async () => {
  const h = await harness(); await h.start(); await h.ready();
  h.items[0].filename = 'D:\\Private-folder\\我的备份.txt'; await h.service.downloadChanged(1);
  assert.equal((await h.service.status(owner)).outputName, '我的备份.txt');
  assert.doesNotMatch(JSON.stringify(h.data), /Private-folder/);
  const revision = h.data[KEY].revision; await h.service.status(owner); assert.equal(h.data[KEY].revision, revision);
  h.items[0].filename = '/another-private-folder/new-name.txt'; h.items[0].state = 'complete';
  await h.service.downloadChanged(1);
  assert.equal((await h.service.status(owner)).outputName, 'new-name.txt');
  assert.doesNotMatch(JSON.stringify(h.data), /another-private-folder/);
});

for (const error of ['NETWORK_FAILED', 'USER_CANCELED']) test(`browser interruption ${error} is accurately reported`, async () => {
  const h = await harness(); await h.start(); await h.ready();
  Object.assign(h.items[0], { state: 'interrupted', error }); await h.service.downloadChanged(1);
  assert.equal(h.data[KEY].state, error === 'USER_CANCELED' ? 'cancelled' : 'failed');
});

test('cancel while save chooser pending keeps the gate and cancels the eventual download id', async () => {
  const h = await harness(); let resolve;
  h.setDownload(() => new Promise(r => { resolve = r; })); await h.start(); await h.ready();
  assert.equal((await h.service.cancel(owner, 'job-a')).state, 'cancelling');
  assert.equal((await h.start('job-b')).id, 'job-a');
  h.items.push({ id: 9, url: h.data[KEY].blobUrl, state: 'in_progress', byExtensionId: 'test' }); resolve(9); await flush();
  assert.equal(h.data[KEY].state, 'cancelled'); assert.equal(h.items[0].error, 'USER_CANCELED');
});

test('actual completion wins a cancel race; it is not falsely labelled cancelled', async () => {
  const h = await harness(); await h.start(); await h.ready(); h.items[0].state = 'complete';
  assert.equal((await h.service.cancel(owner, 'job-a')).state, 'completed');
});

test('account or document generation change fails the export, never impersonates a user cancellation', async () => {
  for (const patch of [{ accountKey: 'other' }, { documentId: 'doc-b' }, { epoch: 2 }, { phase: 'unavailable' }]) {
    const h = await harness(); await h.start(); await h.service.observeOwner(1, { ...owner, phase: 'ready', ...patch });
    assert.equal(h.data[KEY].state, 'failed'); assert.equal(h.data[KEY].errorCode, 'exportJobOwnerChanged');
  }
  const h = await harness(); await h.start(); h.loseOwner(); await h.ready();
  assert.equal(h.calls.filter(c => c.type === 'download').length, 0);
});

for (const entry of ['status', 'observeOwner', 'revoke']) test(`${entry}: restarted orphan save with a lost page fails once and admits the next export`, async () => {
  const h = await harness();
  h.setDownload(() => new Promise(() => {})); await h.start(); await h.ready();
  h.loseOwner(); const restarted = h.make();
  if (entry === 'status') await restarted.status(owner);
  else if (entry === 'observeOwner') await restarted.observeOwner(owner.tabId, null);
  else await restarted.revoke(owner.tabId);
  assert.equal(h.data[KEY].state, 'failed');
  assert.equal(h.data[KEY].errorCode, 'exportJobInterrupted');
  const revision = h.data[KEY].revision;
  for (let i = 0; i < 4; i++) assert.equal((await restarted.status(owner)).state, 'failed');
  assert.equal(h.data[KEY].revision, revision, 'terminal queries do not write or notify again');
  assert.equal(h.calls.filter(c => c.type === 'stop').length, 1);
  assert.equal(h.calls.filter(c => c.type === 'download').length, 1, 'recovery never resends the old download');
  assert.equal(await restarted.status({ ...owner, tabId: 2 }), null, 'the orphan no longer blocks other tabs');
  h.restoreOwner(); h.setDownload(null);
  assert.equal((await h.start('job-b', restarted)).state, 'generating');
  await h.ready(restarted); h.items[0].state = 'complete'; await restarted.downloadChanged(h.items[0].id);
  assert.equal((await restarted.status(owner)).state, 'completed');
});

for (const entry of ['status', 'observeOwner', 'revoke']) test(`${entry}: a live save chooser survives page changes and still accepts Save`, async () => {
  const h = await harness(); let resolve;
  h.setDownload(() => new Promise(yes => { resolve = yes; })); await h.start(); await h.ready();
  h.loseOwner();
  if (entry === 'status') await h.service.status(owner);
  else if (entry === 'observeOwner') await h.service.observeOwner(owner.tabId, null);
  else await h.service.revoke(owner.tabId);
  assert.equal(h.data[KEY].state, 'saving');
  assert.equal(h.calls.filter(c => c.type === 'stop' || c.type === 'cancel').length, 0);
  h.items.push({ id: 9, url: h.data[KEY].blobUrl, state: 'in_progress', byExtensionId: 'test' });
  resolve(9); await flush();
  assert.equal(h.data[KEY].state, 'saving');
  h.items[0].state = 'complete'; await h.service.downloadChanged(9);
  assert.equal((await h.service.status(owner)).state, 'completed');
  assert.equal(h.calls.filter(c => c.type === 'cancel').length, 0);
});

for (const state of ['in_progress', 'complete', 'interrupted']) test(`page loss after worker restart respects the browser's ${state} receipt`, async () => {
  const h = await harness(); await h.start(); await h.ready();
  Object.assign(h.items[0], { state, ...(state === 'interrupted' ? { error: 'NETWORK_FAILED' } : {}) });
  h.loseOwner(); const restarted = h.make();
  const job = await restarted.status(owner);
  assert.equal(job.state, { in_progress: 'saving', complete: 'completed', interrupted: 'failed' }[state]);
  assert.equal(h.calls.filter(c => c.type === 'cancel').length, 0);
});

test('a vanished known download fails instead of keeping the export gate forever', async () => {
  const h = await harness(); await h.start(); await h.ready(); h.items.length = 0;
  assert.equal((await h.service.status(owner)).state, 'failed');
  assert.equal((await h.start('job-b')).state, 'generating');
});

test('only explicit cancellation survives as cancelled when a pending handoff is lost on restart', async () => {
  const h = await harness(); h.setDownload(() => new Promise(() => {})); await h.start(); await h.ready();
  assert.equal((await h.service.cancel(owner, 'job-a')).state, 'cancelling');
  const job = await h.make().status(owner);
  assert.equal(job.state, 'cancelled'); assert.equal(job.errorCode, '');
});

test('worker recreation recovers generating or ready host without regenerating or duplicate downloads', async () => {
  const h = await harness(); await h.start(); const restarted = h.make();
  assert.equal((await restarted.status(owner)).state, 'generating');
  h.setHost({ id: 'job-a', state: 'ready', blobUrl: 'blob:chrome-extension://test/job-a', warnings: [] });
  await Promise.all([restarted.status(owner), restarted.status(owner)]); await flush();
  assert.equal(h.calls.filter(c => c.type === 'run').length, 1);
  assert.equal(h.calls.filter(c => c.type === 'download').length, 1);
});

test('worker recreation adopts exact browser receipt, never reissues a save', async () => {
  const h = await harness(); await h.start(); await h.ready(); h.data[KEY].downloadId = null;
  const restarted = h.make(); assert.equal((await restarted.status(owner)).state, 'saving');
  assert.equal(h.data[KEY].downloadId, 1); assert.equal(h.calls.filter(c => c.type === 'download').length, 1);
});

test('unknown save handoff fails honestly and late receipt stays revoked even after a newer task', async () => {
  const h = await harness(); await h.start();
  h.data[KEY].state = 'saving'; h.data[KEY].blobUrl = 'blob:chrome-extension://test/unknown';
  const restarted = h.make(); assert.equal((await restarted.status(owner)).errorCode, 'exportJobInterrupted');
  await h.start('job-b', restarted);
  h.items.push({ id: 99, url: 'blob:chrome-extension://test/unknown', byExtensionId: 'test', state: 'in_progress' });
  await restarted.downloadChanged(99);
  assert.equal(h.items[0].state, 'interrupted'); assert.equal(h.data[KEY].id, 'job-b');
});

test('lost offscreen host has no silent replay; other owner cannot cancel a job', async () => {
  const h = await harness(); await h.start();
  await assert.rejects(h.service.cancel({ ...owner, accountKey: 'other' }, 'job-a'));
  h.setHost(null); assert.equal((await h.service.status(owner)).errorCode, 'exportJobInterrupted');
  assert.equal(h.calls.filter(c => c.type === 'run').length, 1);
});

test('export creates its host on demand; terminal export releases task resources and can reuse the host', async () => {
  const h = await harness();
  assert.equal(h.calls.filter(c => c.type === 'create-host').length, 0);
  await h.start();
  assert.equal(h.calls.filter(c => c.type === 'create-host').length, 1);
  assert.deepEqual(h.calls.find(c => c.type === 'create-host').reasons, ['BLOBS', 'WORKERS']);
  await h.ready(); h.items[0].state = 'complete'; await h.service.downloadChanged(1);
  assert.equal(h.hostExists(), true, 'empty export host can be reused without keeping export contents');
  assert.equal(h.calls.filter(c => c.type === 'close-host').length, 0);
  assert.equal(h.calls.filter(c => c.type === 'stop').length, 1);
  await h.start('job-b'); assert.equal(h.calls.filter(c => c.type === 'create-host').length, 1);
});

test('an unconfirmed export stop cannot report terminal success or close the export host', async () => {
  const h = await harness(); await h.start(); await h.ready();
  h.items[0].state = 'complete'; h.failStop(true);
  await assert.rejects(h.service.downloadChanged(1), /stop unconfirmed/);
  assert.equal(h.data[KEY].state, 'saving'); assert.equal(h.hostExists(), true);
  assert.equal(h.calls.filter(c => c.type === 'close-host').length, 0);
  h.failStop(false);
  assert.equal((await h.service.status(owner)).state, 'completed');
});
