const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ownerModule = import('../src/platform/library/background/library-identity.js');
const OWNER = '["library-user","personal"]';
const OTHER = '["other-user","personal"]';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const mismatch = error => error.tidyCode === 'CONTEXT_MISMATCH';

// Load the real ESM graph. Only browser transport is synthetic; private maps
// are neither exposed nor injected. Tests observe leases, events and calls.
async function harness({ frame, account } = {}) {
  const { createLibraryIdentity } = await ownerModule;
  const protocol = globalThis.TidyProtocol;
  const tab = { id: 31, url: 'https://chatgpt.com/c/example' };
  const sender = { tab, frameId: 0, documentId: 'doc-a', documentLifecycle: 'active', url: tab.url };
  const calls = [], order = [];
  const owner = createLibraryIdentity({
    chrome: {
      webNavigation: { getFrame: async target => {
        calls.push({ kind: 'frame', target });
        return frame ? await frame(target) : { documentId: 'doc-a', documentLifecycle: 'active', url: tab.url };
      } },
      runtime: { sendMessage: async envelope => { order.push(['broadcast', envelope.payload]); } },
      tabs: { sendMessage: async (id, envelope, target) => {
        calls.push({ kind: envelope.type, id, envelope, target });
        if (envelope.type !== protocol.Type.LIBRARY_ACCOUNT) return;
        return account ? await account(envelope, target)
          : protocol.response(envelope, { accountKey: OWNER, epoch: 1 });
      } },
    },
    isChatgptUrl: url => { try { return new URL(url).origin === 'https://chatgpt.com'; } catch { return false; } },
    beforeIdentityChange: (_, __, epoch) => order.push(['before', owner.peek(tab.id), epoch]),
    afterIdentityChange: id => order.push(['after', owner.peek(id)]),
  });
  return { owner, protocol, tab, sender, calls, order,
    event: (epoch, accountKey = OWNER, transition = null, from = sender) => owner.acceptEvent({
      epoch, accountKey, phase: accountKey ? 'ready' : 'unavailable', transition,
    }, from),
    context: result => ({ tab, ...result }),
    commit: (documentId = 'doc-b') => owner.committed({ tabId: tab.id, documentId }),
  };
}

test('library ESM owner returns frozen snapshots and private leases, never mutable records', async () => {
  const h = await harness(), other = await harness();
  const result = await h.owner.readAccount(h.tab), context = h.context(result);
  assert.ok(Object.isFrozen(h.owner));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.identity));
  assert.deepEqual(Object.keys(result).sort(), ['accountKey', 'identity']);
  const snapshot = h.owner.peek(h.tab.id);
  assert.ok(Object.isFrozen(snapshot));
  assert.deepEqual(Object.keys(snapshot).sort(), ['accountKey', 'documentId', 'epoch', 'phase']);
  assert.equal(Reflect.set(snapshot, 'epoch', 90), false);
  h.owner.assertCurrent(context);
  for (const identity of [{ ...result.identity }, snapshot]) {
    assert.throws(() => h.owner.assertCurrent({ ...context, identity }), mismatch);
  }
  assert.throws(() => other.owner.assertCurrent(context), mismatch);
  assert.throws(() => h.owner.assertCurrent({ ...context, tab: { ...h.tab, id: 32 } }), mismatch);
  h.commit();
  assert.equal(snapshot.documentId, 'doc-a', 'old snapshots never change underneath a reader');
  assert.throws(() => h.owner.assertCurrent(context), mismatch);
});

test('concurrent account initialization is single-flight and ready reads do not poll authentication', async () => {
  const gate = deferred(), entered = deferred();
  const h = await harness({ account: async envelope => {
    entered.resolve(); await gate.promise;
    return h.protocol.response(envelope, { accountKey: OWNER, epoch: 1 });
  } });
  const reads = Array.from({ length: 20 }, () => h.owner.readAccount(h.tab));
  await entered.promise; gate.resolve();
  for (const result of await Promise.all(reads)) h.owner.assertCurrent(h.context(result));
  for (let n = 0; n < 5; n++) await h.owner.readAccount(h.tab, { retry: true });
  assert.equal(h.calls.filter(call => call.kind === 'library.account').length, 1);
  assert.deepEqual(h.calls.find(call => call.kind === 'library.account').target, { documentId: 'doc-a' });
});

test('identity transition retires navigation before mutation, broadcasts once, then resumes with the new owner', async () => {
  const h = await harness();
  const old = h.context(await h.owner.readAccount(h.tab));
  await h.event(2, null, 'workspace-unconfirmed');
  assert.deepEqual(h.order.map(item => item[0]), ['before', 'broadcast', 'after']);
  assert.equal(h.order[0][1].phase, 'ready');
  assert.equal(h.order[2][1].phase, 'unavailable');
  assert.throws(() => h.owner.assertCurrent(old), mismatch);
  await h.event(2, null, 'workspace-unconfirmed');
  assert.equal(h.order.length, 3, 'duplicate event is silent');
  await h.event(3);
  assert.throws(() => h.owner.assertCurrent(old), mismatch, 'soft recovery cannot renew an admitted operation');
  h.owner.assertCurrent(h.context(await h.owner.readAccount(h.tab)));
});

for (const ingress of ['document', 'event']) test(`late ${ingress} browser lookup cannot resurrect a closed tab`, async () => {
  const gate = deferred(), entered = deferred();
  const h = await harness({ frame: async () => {
    entered.resolve(); return await gate.promise;
  } });
  const pending = ingress === 'document' ? h.owner.readAccount(h.tab) : h.event(1);
  // Observe either result immediately so a deliberate rejection is handled.
  const settled = pending.then(value => ({ value }), error => ({ error }));
  await entered.promise;
  h.owner.closeTab(h.tab.id);
  gate.resolve({ documentId: 'doc-a', documentLifecycle: 'active', url: h.tab.url });
  const result = await settled;
  assert.equal(h.owner.peek(h.tab.id), null);
  if (ingress === 'document') assert.ok(mismatch(result.error));
  assert.equal(h.calls.filter(call => call.kind === 'library.account').length, 0);
  assert.equal(h.order.length, 0, 'closed document must not publish ready or resume navigation');
});

test('late frame discovery cannot replace a committed document', async () => {
  const gate = deferred(), entered = deferred();
  const h = await harness({ frame: async () => { entered.resolve(); return await gate.promise; } });
  const pending = h.owner.document(h.tab);
  await entered.promise; h.commit();
  gate.resolve({ documentId: 'doc-a', documentLifecycle: 'active', url: h.tab.url });
  assert.equal((await pending).documentId, 'doc-b');
  assert.equal(h.owner.peek(h.tab.id).documentId, 'doc-b');
});

for (const boundary of ['close', 'commit']) test(`late account reply cannot cross ${boundary} or clear a newer single-flight`, async () => {
  const gates = [deferred(), deferred()], entered = [deferred(), deferred()];
  let index = 0;
  const h = await harness({ account: async envelope => {
    const n = index++; entered[n].resolve(); await gates[n].promise;
    return h.protocol.response(envelope, { accountKey: OWNER, epoch: 1 });
  } });
  const old = h.owner.readAccount(h.tab);
  const rejected = assert.rejects(old, mismatch);
  await entered[0].promise;
  if (boundary === 'close') h.owner.closeTab(h.tab.id);
  else h.commit();
  const fresh = h.owner.readAccount(h.tab);
  await entered[1].promise; gates[0].resolve(); await rejected;
  const joined = h.owner.readAccount(h.tab);
  gates[1].resolve();
  for (const result of await Promise.all([fresh, joined])) h.owner.assertCurrent(h.context(result));
  assert.equal(index, 2, 'old finally must not delete a newer initialization');
});

test('same-epoch hard revocation invalidates a pending account reply, not just ready convergence', async () => {
  const gate = deferred(), entered = deferred();
  const h = await harness({ account: async envelope => {
    entered.resolve(); await gate.promise;
    return h.protocol.response(envelope, { accountKey: OWNER, epoch: 2 });
  } });
  await h.event(1); await h.event(2, null, 'workspace-unconfirmed');
  const pending = h.owner.readAccount(h.tab);
  const rejected = assert.rejects(pending, mismatch);
  await entered.promise;
  await h.event(2, null, 'session-revoked');
  gate.resolve(); await rejected;
  assert.equal(h.owner.peek(h.tab.id).phase, 'unavailable');
  assert.equal(h.owner.peek(h.tab.id).transition, 'session-revoked');
});

test('a restarted worker accepts a reply matching the already-ready page even when its first epoch is high', async () => {
  const gate = deferred(), entered = deferred();
  const h = await harness({ account: async envelope => {
    entered.resolve(); await gate.promise;
    return h.protocol.response(envelope, { accountKey: OWNER, epoch: 21 });
  } });
  const pending = h.owner.readAccount(h.tab);
  await entered.promise; await h.event(21); gate.resolve();
  const result = await pending;
  assert.equal(result.identity.epoch, 21);
  h.owner.assertCurrent(h.context(result));
  assert.equal(h.calls.filter(call => call.kind === 'library.account').length, 1);
});

test('only a complete same-owner soft chain permits newer-ready convergence; A-B-A is not continuity', async () => {
  for (const hard of [false, true]) {
    const gate = deferred(), entered = deferred();
    const h = await harness({ account: async envelope => {
      entered.resolve(); await gate.promise;
      return h.protocol.response(envelope, { accountKey: OWNER, epoch: 1 });
    } });
    const pending = h.owner.readAccount(h.tab);
    const result = pending.then(value => ({ value }), error => ({ error }));
    await entered.promise; await h.event(1);
    await h.event(2, null, 'workspace-unconfirmed');
    if (hard) await h.event(3, OTHER);
    else await h.event(3, null, 'workspace-restored');
    await h.event(4); gate.resolve();
    const settled = await result;
    if (hard) assert.ok(mismatch(settled.error));
    else { assert.equal(settled.value.identity.epoch, 4); h.owner.assertCurrent(h.context(settled.value)); }
    assert.equal(h.calls.filter(call => call.kind === 'library.account').length, 1);
  }
});

test('worker keeps ingress policy and repositories, not identity maps, records or lease validation', () => {
  const worker = fs.readFileSync('src/app/background/service-worker.js', 'utf8');
  assert.match(worker, /createLibraryIdentity\(/);
  const policy = fs.readFileSync('src/app/background/request-policy.js', 'utf8');
  const lifecycle = fs.readFileSync('src/app/background/browser-lifecycle.js', 'utf8');
  const messages = fs.readFileSync('src/app/background/runtime-messages.js', 'utf8');
  assert.match(policy, /const LIBRARY_ACTION_TYPES = new Set/);
  assert.doesNotMatch(worker, /libraryDocuments|libraryAccountReads|context\.record|hardBoundary/);
  assert.match(lifecycle, /identity\.committed\(details\)/);
  assert.match(lifecycle, /identity\.closeTab\(tabId\)/);
  assert.match(messages, /identity\.acceptEvent\(envelope\.payload, sender\)/);
  for (const module of [policy, lifecycle, messages]) assert.doesNotMatch(module, /libraryDocuments|libraryAccountReads|context\.record|hardBoundary/);
  assert.match(worker, /createBrowserLifecycle\(/);
  assert.match(worker, /createWorkerMessageListener\(/);
});
