'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
const flush = () => new Promise(setImmediate);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const receipt = (id, state = 'generating', revision = 1, extra = {}) => ({ id, state, revision, ...extra });

function harness(request, { onChanged = () => {} } = {}) {
  let now = 0, timerId = 0, changes = 0;
  const pending = new Map(), calls = [], failures = [];
  const timers = {
    setTimeout(callback, delay) { pending.set(++timerId, { callback, at: now + delay }); return timerId; },
    clearTimeout(id) { pending.delete(id); },
  };
  const context = vm.createContext({
    ChatGPTTidyDiagnostics: { cause: error => ({ reasonCode: error.code || 'TEST_FAILURE' }) },
  });
  vm.runInContext(fs.readFileSync(path.join(project, 'src/messages/notice-lifecycle.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(project, 'src/features/export/model/export-job.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(project, 'src/features/export/ui/export-job-controller.js'), 'utf8')
    .replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, ''), context);
  const controller = context.createExportJobController({
    timers, onChanged: () => { changes++; onChanged(controller); }, onAcceptedFailure: key => failures.push(key),
    jobRequest(action, payload) {
      calls.push({ action, payload });
      return request(action, payload);
    },
  });
  controller.updateOwner({ accountKey: 'owner-a', verified: true });
  const start = (id = 'a', options) => controller.submit({ id, spec: { options: { name: 'original' } } }, options);
  function advance(ms) {
    const until = now + ms;
    for (;;) {
      const next = [...pending].filter(([, item]) => item.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      pending.delete(next[0]); now = next[1].at; next[1].callback();
    }
    now = until;
  }
  return { controller, calls, failures, pending, start, advance, changes: () => changes };
}

test('controller snapshots and transport copies cannot mutate private job ownership', async () => {
  const reply = receipt('a', 'completed', 4, { warnings: ['read me'], progress: { done: 1 } });
  let submitted;
  const h = harness(async (action, payload) => { submitted = payload; return reply; });
  const payload = { id: 'a', spec: { options: { name: 'original' } } };
  await h.controller.submit(payload);
  payload.spec.options.name = 'edited';
  assert.equal(submitted.spec.options.name, 'original');
  reply.progress.done = 99;
  const snapshot = h.controller.snapshot();
  assert.equal(snapshot.job.progress.done, 1);
  assert.throws(() => { snapshot.job.progress.done = 88; }, TypeError);
  assert.throws(() => { snapshot.job.warnings.push('edit'); }, { name: 'TypeError' });
  assert.equal(h.controller.snapshot().job.progress.done, 1);
  assert.equal(h.controller.busy(), false);
});

for (const settle of ['success', 'failure']) test('late cancellation A cannot affect newer B: ' + settle, async () => {
  const cancelling = deferred();
  let status = receipt('a');
  const h = harness((action, payload) => action === 'start' ? Promise.resolve(receipt(payload.id))
    : action === 'cancel' ? cancelling.promise : Promise.resolve(status));
  await h.start();
  const oldCancel = h.controller.cancel();
  assert.equal(h.controller.snapshot().job.state, 'cancelling');
  status = receipt('b', 'saving', 2);
  await h.controller.refresh();
  const changeCount = h.changes();
  if (settle === 'success') cancelling.resolve(receipt('a', 'cancelled', 8));
  else cancelling.reject(Error('old cancellation failed'));
  await oldCancel;
  assert.equal(h.controller.snapshot().job.id, 'b');
  assert.equal(h.controller.snapshot().job.state, 'saving');
  assert.equal(h.controller.snapshot().unknown, false);
  assert.equal(h.changes(), changeCount, 'stale operations cannot redraw or mutate B');
});

test('a mismatched write receipt is reconciled by status, never accepted as the submitted job', async () => {
  const status = deferred();
  const h = harness(action => action === 'start' ? Promise.resolve(receipt('wrong-id')) : status.promise);
  await h.start();
  assert.equal(h.controller.snapshot().unknown, true);
  assert.equal(h.controller.snapshot().job, null);
  assert.equal(h.controller.snapshot().admissionId, 'a');
  assert.deepEqual(h.calls.map(call => call.action), ['start', 'status']);
  status.resolve(receipt('a', 'saving', 3)); await flush();
  assert.equal(h.controller.snapshot().job.id, 'a');
  assert.equal(h.controller.snapshot().unknown, false);
});

test('a lost admission response reconciles once without replaying start', async () => {
  const h = harness(async action => {
    if (action === 'start') throw Error('reply lost');
    return receipt('a', 'saving', 3);
  });
  await h.start(); await flush();
  assert.deepEqual(h.calls.map(call => call.action), ['start', 'status']);
  assert.equal(h.controller.snapshot().job.state, 'saving');
  assert.equal(await h.start('duplicate'), false);
  assert.equal(h.calls.filter(call => call.action === 'start').length, 1);
});

test('failed admission reports NotStarted only after authoritative status and allows explicit retry', async () => {
  const h = harness(async action => { if (action === 'start') throw Error('not admitted'); return null; });
  await h.start(); await flush();
  assert.deepEqual(h.failures, ['exportJobNotStarted']);
  assert.equal(h.controller.snapshot().admissionId, null);
  assert.equal(h.controller.snapshot().unknown, false);
  assert.equal(h.controller.busy(), false);
  assert.equal(h.calls.filter(call => call.action === 'start').length, 1);
  await h.start('explicit-retry'); await flush();
  assert.equal(h.calls.filter(call => call.action === 'start').length, 2);
});

test('anonymous global busy receipt remains locked without reporting rejected admission', async () => {
  const h = harness(async () => ({ state: 'busy' }));
  await h.start();
  assert.equal(h.controller.busy(), true);
  assert.equal(h.controller.snapshot().unknown, false);
  assert.deepEqual(h.failures, []);
  h.advance(2000); await flush();
  assert.deepEqual(h.calls.map(call => call.action), ['start', 'status']);
});

test('polling is single-flight, exactly two seconds, and stops after three failed reads', async () => {
  let healthy = false;
  const h = harness(async () => { if (!healthy) throw Error('private transport text'); return null; });
  await h.controller.refresh();
  assert.equal(h.controller.snapshot().readFailures, 1);
  assert.equal(h.controller.snapshot().observedFailure.reasonCode, 'TEST_FAILURE');
  h.advance(1999); assert.equal(h.calls.length, 1);
  h.advance(1); await flush(); assert.equal(h.calls.length, 2);
  h.advance(2000); await flush(); assert.equal(h.calls.length, 3);
  assert.equal(h.controller.snapshot().readFailures, 3);
  h.advance(100000); await flush(); assert.equal(h.calls.length, 3);
  assert.equal(h.controller.busy(), true);
  healthy = true; await h.controller.refresh();
  assert.equal(h.controller.busy(), false);
  assert.equal(h.controller.snapshot().readFailures, 0);
  assert.ok(h.calls.every(call => call.action === 'status'));
});

test('concurrent refreshes share a single pending read', async () => {
  const response = deferred();
  const h = harness(() => response.promise);
  const reading = h.controller.refresh();
  await h.controller.refresh(); await h.controller.refresh();
  assert.equal(h.calls.length, 1);
  response.resolve(null); await reading;
  assert.equal(h.controller.busy(), false);
});

test('status started before submit cannot overwrite the accepted job', async () => {
  const oldStatus = deferred();
  const h = harness((action, payload) => action === 'status' ? oldStatus.promise : Promise.resolve(receipt(payload.id)));
  const reading = h.controller.refresh();
  await h.start();
  oldStatus.resolve(null); await reading;
  assert.equal(h.controller.snapshot().job.id, 'a');
  assert.equal(h.controller.busy(), true);
});

test('same-id lower revisions cannot regress a receipt', async () => {
  let current = receipt('a', 'saving', 5);
  const h = harness(async () => current);
  await h.controller.refresh();
  current = receipt('a', 'generating', 2);
  await h.controller.refresh();
  assert.equal(h.controller.snapshot().job.revision, 5);
  assert.equal(h.controller.snapshot().job.state, 'saving');
});

for (const boundary of ['account', 'suspend-and-return']) test('late writes and reads cannot cross ' + boundary, async () => {
  const response = deferred();
  const h = harness(() => response.promise);
  const writing = h.start();
  if (boundary === 'account') h.controller.updateOwner({ accountKey: 'owner-b', verified: true });
  else {
    h.controller.updateOwner({ accountKey: 'owner-a', verified: false });
    assert.equal(h.controller.snapshot().job, null);
    assert.equal(h.controller.busy(), false);
    h.controller.updateOwner({ accountKey: 'owner-a', verified: true });
  }
  response.resolve(receipt('a', 'completed', 10, { outputName: 'OLD PRIVATE TITLE' }));
  await writing;
  assert.equal(h.controller.snapshot().job, null);
  assert.equal(h.calls.length, 1, 'stale finalizers cannot start new polling or replay writes');
  h.advance(60000); assert.equal(h.calls.length, 1);
});

test('suspension hides old receipts and clears polling; reverification uses a fresh explicit read', async () => {
  let status = receipt('a');
  const h = harness(async () => status);
  await h.controller.refresh();
  h.controller.updateOwner({ accountKey: 'owner-a', verified: false });
  assert.equal(h.controller.snapshot().job, null);
  h.advance(10000); assert.equal(h.calls.length, 1);
  h.controller.updateOwner({ accountKey: 'owner-a', verified: true });
  status = receipt('a', 'completed', 3); await h.controller.refresh();
  assert.equal(h.controller.snapshot().job.state, 'completed');
});

test('successful notice lasts six seconds and ordinary presentation updates do not reset its deadline', async () => {
  let job = receipt('a', 'completed', 3);
  const h = harness(async action => action === 'dismiss' ? job = { ...job, dismissedAt: 1, revision: 4 } : job);
  h.controller.setPresentation({ active: true });
  await h.controller.refresh();
  h.advance(3000); h.controller.setPresentation({ active: true }); h.controller.snapshot();
  h.advance(2999); assert.equal(h.controller.noticeHidden(), false);
  h.advance(1); await flush(); assert.equal(h.controller.noticeHidden(), true);
  await h.controller.refresh();
  h.controller.setPresentation({ active: false });
  h.controller.setPresentation({ active: true });
  h.advance(12000);
  assert.equal(h.calls.filter(call => call.action === 'dismiss').length, 1);
});

for (const pause of ['warningsOpen', 'pointerInside', 'focusInside', 'documentHidden', 'inactive']) {
  test('warning notice pauses for ' + pause + ' and resumes with a fresh twelve seconds', async () => {
    let job = receipt('a', 'completed', 3, { warnings: ['check content'] });
    const h = harness(async action => action === 'dismiss' ? job = { ...job, dismissedAt: 1 } : job);
    h.controller.setPresentation({ active: true });
    await h.controller.refresh();
    h.advance(6000);
    h.controller.setPresentation(pause === 'inactive' ? { active: false } : { [pause]: true });
    h.advance(60000);
    assert.equal(h.calls.filter(call => call.action === 'dismiss').length, 0);
    h.controller.setPresentation(pause === 'inactive' ? { active: true } : { [pause]: false });
    h.advance(11999); assert.equal(h.controller.noticeHidden(), false);
    h.advance(1); await flush(); assert.equal(h.controller.noticeHidden(), true);
  });
}

test('failed notices never auto-dismiss, and dismiss failures do not unlock or replay a download', async () => {
  const h = harness(async action => { if (action === 'dismiss') throw Error('dismiss failed'); return receipt('a', 'failed', 2); });
  h.controller.setPresentation({ active: true });
  await h.controller.refresh(); h.advance(60000);
  assert.equal(h.calls.length, 1);
  await h.controller.dismiss();
  assert.equal(h.controller.noticeHidden(), false);
  assert.equal(h.controller.snapshot().unknown, false);
  assert.equal(h.controller.snapshot().job.state, 'failed');
  assert.deepEqual(h.failures, ['exportJobDismissFailed']);
  assert.ok(h.calls.every(call => call.action !== 'start' && call.action !== 'cancel'));
});

for (const settle of ['success', 'failure']) test('late dismiss A cannot hide B or show a stale failure: ' + settle, async () => {
  const oldDismiss = deferred();
  let job = receipt('a', 'completed', 2);
  const h = harness(action => action === 'dismiss' ? oldDismiss.promise : Promise.resolve(job));
  await h.controller.refresh();
  const dismissing = h.controller.dismiss();
  job = receipt('b', 'completed', 3); await h.controller.refresh();
  if (settle === 'success') oldDismiss.resolve(receipt('a', 'completed', 3, { dismissedAt: 1 }));
  else oldDismiss.reject(Error('old dismissal failed'));
  await dismissing;
  assert.equal(h.controller.snapshot().job.id, 'b');
  assert.equal(h.controller.noticeHidden(), false);
  assert.deepEqual(h.failures, []);
});

test('unverified and foreign-owner submissions never dispatch a write', async () => {
  const h = harness(async () => null);
  assert.equal(await h.controller.submit({ id: 'a', expectedAccountKey: 'wrong-owner' }), false);
  h.controller.updateOwner({ accountKey: 'owner-a', verified: false });
  assert.equal(await h.start(), false);
  await h.controller.refresh(); await h.controller.cancel(); await h.controller.dismiss();
  assert.equal(h.calls.length, 0);
});

test('a failed auto-dismiss never automatically replays the dismiss write', async () => {
  const h = harness(async action => { if (action === 'dismiss') throw Error('dismiss unavailable'); return receipt('a', 'completed', 2); });
  h.controller.setPresentation({ active: true });
  await h.controller.refresh();
  h.advance(6000); await flush();
  assert.equal(h.controller.noticeHidden(), false);
  assert.deepEqual(h.calls.map(call => call.action), ['status', 'dismiss']);
  h.advance(120000); await flush();
  h.controller.setPresentation({ pointerInside: true });
  h.controller.setPresentation({ pointerInside: false });
  h.advance(120000); await flush();
  assert.equal(h.calls.filter(call => call.action === 'dismiss').length, 1);
  await h.controller.dismiss();
  assert.equal(h.calls.filter(call => call.action === 'dismiss').length, 2, 'explicit retry remains available');
});

test('same-revision generating status cannot unlock a pending cancellation', async () => {
  const oldCancel = deferred();
  const h = harness(action => action === 'cancel' ? oldCancel.promise : Promise.resolve(receipt('a', 'generating', 3)));
  await h.controller.refresh();
  const cancelling = h.controller.cancel();
  await h.controller.refresh();
  assert.equal(h.controller.snapshot().job.state, 'cancelling');
  assert.equal(await h.controller.cancel(), false);
  oldCancel.resolve(receipt('a', 'cancelled', 4)); await cancelling;
  assert.equal(h.controller.snapshot().job.state, 'cancelled');
  assert.equal(h.calls.filter(call => call.action === 'cancel').length, 1);
});

for (const settle of ['success', 'failure']) test('A cancel finishing after an explicit new submission B is inert: ' + settle, async () => {
  const oldCancel = deferred();
  let job = receipt('a');
  const h = harness((action, payload) => {
    if (action === 'cancel') return oldCancel.promise;
    if (action === 'start') return Promise.resolve(job = receipt(payload.id));
    return Promise.resolve(job);
  });
  await h.start();
  const cancelling = h.controller.cancel();
  job = receipt('a', 'completed', 5); await h.controller.refresh();
  await h.start('b');
  if (settle === 'success') oldCancel.resolve(receipt('a', 'cancelled', 7));
  else oldCancel.reject(Error('stale'));
  await cancelling;
  assert.equal(h.controller.snapshot().job.id, 'b');
  assert.equal(h.controller.snapshot().unknown, false);
  assert.equal(h.controller.snapshot().observedFailure, null);
  h.advance(2000); await flush();
  assert.equal(h.calls.at(-1).action, 'status');
});

test('an old dismiss rejection cannot clear a newer optimistic dismissal', async () => {
  const a = deferred(), b = deferred();
  let job = receipt('a', 'completed', 2);
  const h = harness((action, payload) => action === 'dismiss'
    ? (payload.id === 'a' ? a.promise : b.promise) : Promise.resolve(job));
  await h.controller.refresh(); const first = h.controller.dismiss();
  job = receipt('b', 'completed', 4); await h.controller.refresh();
  const second = h.controller.dismiss();
  a.reject(Error('old failure')); await first;
  assert.equal(h.controller.snapshot().dismissedId, 'b');
  assert.equal(h.controller.noticeHidden(), true);
  assert.deepEqual(h.failures, []);
  b.resolve({ ...job, dismissedAt: 1 }); await second;
});

test('old status failure and finally cannot clear a new owner read or change its failure count', async () => {
  const a = deferred(), b = deferred();
  const h = harness((action, payload) => payload.expectedAccountKey === 'owner-a' ? a.promise : b.promise);
  const oldRead = h.controller.refresh();
  h.controller.updateOwner({ accountKey: 'owner-b', verified: true });
  const newRead = h.controller.refresh();
  a.reject(Error('old owner failure')); await oldRead;
  assert.equal(h.controller.snapshot().unknown, false);
  assert.equal(h.controller.snapshot().readFailures, 0);
  await h.controller.refresh();
  assert.equal(h.calls.length, 2, 'old finalizer did not release the new read lock');
  b.resolve(receipt('b', 'saving')); await newRead;
  h.advance(2000); await flush();
  assert.equal(h.calls.length, 3);
});

test('unknown recovery accepts an identical known receipt and clears read failures', async () => {
  let fail = false;
  const job = receipt('a', 'saving', 3);
  const h = harness(async () => { if (fail) throw Error('status lost'); return job; });
  await h.controller.refresh(); fail = true; await h.controller.refresh();
  assert.equal(h.controller.snapshot().unknown, true);
  fail = false; await h.controller.refresh();
  assert.equal(h.controller.snapshot().unknown, false);
  assert.equal(h.controller.snapshot().readFailures, 0);
  assert.equal(h.controller.snapshot().observedFailure, null);
});

test('dispose revokes delayed callbacks, polling and all future submissions', async () => {
  const response = deferred();
  const h = harness(() => response.promise);
  const writing = h.start();
  h.controller.dispose();
  response.resolve(receipt('a', 'completed', 8)); await writing;
  assert.equal(h.controller.snapshot().job, null);
  assert.equal(h.controller.updateOwner({ accountKey: 'owner-b', verified: true }), false);
  assert.equal(await h.start('b'), false);
  h.advance(60000); assert.equal(h.calls.length, 1);
});

test('a pending admission stays locked across same-account suspension until status reconciles it', async () => {
  const startReply = deferred(), statusReply = deferred();
  const h = harness(action => action === 'start' ? startReply.promise : statusReply.promise);
  const firstStart = h.start('a');
  h.controller.updateOwner({ accountKey: 'owner-a', verified: false });
  h.controller.updateOwner({ accountKey: 'owner-a', verified: true });
  assert.equal(h.controller.busy(), true);
  assert.equal(h.controller.snapshot().unknown, true);
  const reading = h.controller.refresh();
  assert.equal(await h.start('b'), false);
  startReply.resolve(receipt('a', 'saving')); await firstStart;
  assert.equal(h.controller.snapshot().job, null, 'the pre-suspension write receipt remains stale');
  statusReply.resolve(receipt('a', 'saving', 4)); await reading;
  assert.equal(h.controller.snapshot().job.id, 'a');
  assert.equal(h.controller.snapshot().unknown, false);
  assert.equal(h.calls.filter(call => call.action === 'start').length, 1);
});


const responsePendingError = () => Object.assign(Error('response has not finished'), { code: 'EXPORT_RESPONSE_PENDING' });

test('response-pending admission unlocks without unknown, status polling, or automatic replay', async () => {
  const firstReply = deferred(), pendingRequests = [];
  const h = harness((action, payload) => action === 'start' && payload.id === 'a'
    ? firstReply.promise : Promise.resolve(receipt(payload.id, 'completed', 1)));
  const payload = { id: 'a', expectedConversationId: 'conversation-a',
    spec: { plan: { mode: 'current', conversationId: 'conversation-a', options: { format: 'md' } } } };
  const writing = h.controller.submit(payload, { onResponsePending: request => pendingRequests.push(request) });
  payload.expectedConversationId = 'edited-conversation';
  payload.spec.plan.options.format = 'edited-format';
  firstReply.reject(responsePendingError());
  assert.equal(await writing, false);
  assert.equal(pendingRequests.length, 1);
  assert.equal(pendingRequests[0], h.calls[0].payload, 'callback receives the submitted transport copy');
  assert.equal(pendingRequests[0].expectedAccountKey, 'owner-a');
  assert.equal(pendingRequests[0].expectedConversationId, 'conversation-a');
  assert.equal(pendingRequests[0].spec.plan.options.format, 'md');
  const snapshot = h.controller.snapshot();
  assert.equal(snapshot.submission, false);
  assert.equal(snapshot.admissionId, null);
  assert.equal(snapshot.unknown, false);
  assert.equal(snapshot.readFailures, 0);
  assert.equal(snapshot.observedFailure, null);
  assert.equal(h.controller.busy(), false);
  assert.deepEqual(h.failures, []);
  h.advance(120000); await flush();
  assert.deepEqual(h.calls.map(call => call.action), ['start']);
  assert.equal(await h.start('explicit-retry'), true);
  assert.deepEqual(h.calls.map(call => call.action), ['start', 'start']);
});

test('response-pending callback observes an already-unlocked admission', async () => {
  const h = harness(async () => { throw responsePendingError(); });
  let callbackState;
  await h.start('a', { onResponsePending: () => { callbackState = h.controller.snapshot(); } });
  assert.ok(callbackState, 'the per-submit callback is delivered');
  assert.equal(callbackState.submission, false);
  assert.equal(callbackState.admissionId, null);
  assert.equal(callbackState.unknown, false);
  assert.equal(h.controller.busy(), false);
});

test('response-pending hides the previous completed receipt locally and rerenders never revive it', async () => {
  const previous = receipt('previous', 'completed', 8, { outputName: 'previous-result.md' });
  const h = harness(async action => {
    if (action === 'start') throw responsePendingError();
    return previous;
  });
  h.controller.setPresentation({ active: true });
  await h.controller.refresh();
  assert.equal(h.controller.noticeHidden(), false);
  await h.start('new');
  assert.equal(h.controller.snapshot().job.id, 'previous', 'do not falsify or discard the confirmed receipt');
  assert.equal(h.controller.noticeHidden(), true, 'the previous success cannot stand in for this rejected admission');
  assert.equal(h.controller.snapshot().dismissedId, 'previous');
  for (const active of [false, true, true]) {
    h.controller.setPresentation({ active });
    assert.equal(h.controller.noticeHidden(), true);
  }
  h.advance(120000); await flush();
  assert.deepEqual(h.calls.map(call => call.action), ['status', 'start'], 'no worker dismissal or status poll is needed');
  await h.controller.refresh();
  assert.equal(h.controller.noticeHidden(), true, 'an identical explicit status does not reopen the previous success');
});

for (const boundary of ['suspended', 'suspend-and-return', 'account-aba', 'disposed']) {
  test('late response-pending cannot clear state or invoke the callback after ' + boundary, async () => {
    const reply = deferred(), pendingRequests = [];
    const h = harness(() => reply.promise);
    const writing = h.start('a', { onResponsePending: request => pendingRequests.push(request) });
    if (boundary === 'disposed') h.controller.dispose();
    else if (boundary === 'account-aba') {
      h.controller.updateOwner({ accountKey: 'owner-b', verified: true });
      h.controller.updateOwner({ accountKey: 'owner-a', verified: true });
    } else {
      h.controller.updateOwner({ accountKey: 'owner-a', verified: false });
      if (boundary === 'suspend-and-return') h.controller.updateOwner({ accountKey: 'owner-a', verified: true });
    }
    const before = h.controller.snapshot(), changes = h.changes();
    reply.reject(responsePendingError()); await writing;
    assert.deepEqual(h.controller.snapshot(), before);
    assert.equal(h.changes(), changes);
    assert.deepEqual(pendingRequests, []);
    h.advance(120000); await flush();
    assert.deepEqual(h.calls.map(call => call.action), ['start']);
  });
}

test('response-pending revokes a status read belonging to the now-rejected admission', async () => {
  const startReply = deferred(), statusReply = deferred(), pendingRequests = [];
  const h = harness(action => action === 'start' ? startReply.promise : statusReply.promise);
  const writing = h.start('a', { onResponsePending: request => pendingRequests.push(request) });
  const reading = h.controller.refresh();
  startReply.reject(responsePendingError()); await writing;
  const changes = h.changes();
  statusReply.resolve(receipt('a', 'completed', 2)); await reading;
  assert.equal(pendingRequests.length, 1);
  assert.equal(h.controller.snapshot().job, null);
  assert.equal(h.controller.snapshot().unknown, false);
  assert.equal(h.controller.snapshot().readFailures, 0);
  assert.equal(h.changes(), changes);
  h.advance(120000); await flush();
  assert.deepEqual(h.calls.map(call => call.action), ['start', 'status']);
});

test('response-pending clears admission read failures and cancels their scheduled poll', async () => {
  const startReply = deferred(), pendingRequests = [];
  const h = harness(action => {
    if (action === 'start') return startReply.promise;
    return Promise.reject(Error('status temporarily unavailable'));
  });
  const writing = h.start('a', { onResponsePending: request => pendingRequests.push(request) });
  await h.controller.refresh();
  assert.equal(h.controller.snapshot().unknown, true);
  assert.equal(h.controller.snapshot().readFailures, 1);
  startReply.reject(responsePendingError()); await writing;
  assert.equal(pendingRequests.length, 1);
  assert.equal(h.controller.snapshot().unknown, false);
  assert.equal(h.controller.snapshot().readFailures, 0);
  assert.equal(h.controller.snapshot().observedFailure, null);
  h.advance(120000); await flush();
  assert.deepEqual(h.calls.map(call => call.action), ['start', 'status']);
});

test('non-whitelisted start rejection remains unknown and reconciles by status without pending callback', async () => {
  const statusReply = deferred(), pendingRequests = [];
  const h = harness(action => {
    if (action === 'start') return Promise.reject(Object.assign(Error('reply lost'), { code: 'TRANSPORT_ERROR' }));
    return statusReply.promise;
  });
  await h.start('a', { onResponsePending: request => pendingRequests.push(request) });
  assert.equal(h.controller.snapshot().unknown, true);
  assert.equal(h.controller.snapshot().admissionId, 'a');
  assert.equal(h.controller.snapshot().observedFailure.reasonCode, 'TRANSPORT_ERROR');
  assert.deepEqual(h.calls.map(call => call.action), ['start', 'status']);
  assert.deepEqual(pendingRequests, []);
  statusReply.resolve(null); await flush();
  assert.deepEqual(h.failures, ['exportJobNotStarted']);
});

test('response-pending code on cancel is still an unknown cancellation and keeps the status poll', async () => {
  const pendingRequests = [];
  const h = harness(async action => {
    if (action === 'cancel') throw responsePendingError();
    return receipt('a', 'generating', 1);
  });
  await h.start('a', { onResponsePending: request => pendingRequests.push(request) });
  assert.equal(await h.controller.cancel(), false);
  assert.equal(h.controller.snapshot().job.state, 'cancelling');
  assert.equal(h.controller.snapshot().unknown, true);
  assert.equal(h.controller.snapshot().observedFailure.reasonCode, 'EXPORT_RESPONSE_PENDING');
  assert.equal(h.controller.busy(), true);
  assert.deepEqual(h.calls.map(call => call.action), ['start', 'cancel']);
  assert.deepEqual(pendingRequests, []);
  h.advance(2000); await flush();
  assert.deepEqual(h.calls.map(call => call.action), ['start', 'cancel', 'status']);
});

test('response-pending code on status is still an unknown read failure and retries by status only', async () => {
  const h = harness(async () => { throw responsePendingError(); });
  assert.equal(await h.controller.refresh(), false);
  assert.equal(h.controller.snapshot().unknown, true);
  assert.equal(h.controller.snapshot().readFailures, 1);
  assert.equal(h.controller.snapshot().observedFailure.reasonCode, 'EXPORT_RESPONSE_PENDING');
  assert.equal(h.controller.busy(), true);
  h.advance(2000); await flush();
  assert.equal(h.controller.snapshot().readFailures, 2);
  assert.deepEqual(h.calls.map(call => call.action), ['status', 'status']);
});


for (const boundary of ['account', 'account-aba', 'disposed', 'new-submit']) {
  test('response-pending callback is fenced against synchronous onChanged reentry: ' + boundary, async () => {
    let reenter = true;
    const pendingRequests = [];
    const h = harness(async (action, payload) => {
      if (payload.id === 'a') throw responsePendingError();
      return receipt(payload.id, 'completed', 1);
    }, {
      onChanged(controller) {
        if (!reenter || controller.snapshot().submission) return;
        reenter = false;
        if (boundary === 'disposed') controller.dispose();
        else if (boundary === 'new-submit') void controller.submit({ id: 'new', spec: {} });
        else {
          controller.updateOwner({ accountKey: 'owner-b', verified: true });
          if (boundary === 'account-aba') controller.updateOwner({ accountKey: 'owner-a', verified: true });
        }
      },
    });
    await h.start('a', { onResponsePending: request => pendingRequests.push(request) });
    await flush();
    assert.deepEqual(pendingRequests, [], 'a redrawn/replaced owner cannot receive the old pending callback');
    if (boundary === 'new-submit') assert.equal(h.controller.snapshot().job.id, 'new');
    else assert.equal(h.controller.snapshot().job, null);
    h.advance(120000); await flush();
    assert.ok(h.calls.every(call => call.action === 'start'), 'reentry cannot restart the rejected admission poll');
  });
}
