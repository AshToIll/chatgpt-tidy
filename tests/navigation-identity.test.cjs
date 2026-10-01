const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const context = vm.createContext({});
for (const file of ['src/platform/navigation/navigation-identity.js', 'src/platform/navigation/chatgpt/navigation-intent.js']) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
}
const contract = context.TidyNavigationIdentity;
const ready = { phase: 'ready', epoch: 1, accountKey: 'owner-a' };

test('presentation contract distinguishes first proof, soft initialization and permanent revocation', () => {
  assert.equal(contract.state({ phase: 'unavailable', epoch: 0 }, 'owner-a'), 'waiting');
  assert.equal(contract.state(ready, 'owner-a'), 'ready');
  assert.equal(contract.state(ready, 'owner-b'), 'revoked');
  for (const transition of ['workspace-unconfirmed', 'workspace-restored']) {
    assert.equal(contract.state({ phase: 'unavailable', epoch: 2, transition }, 'owner-a'), 'waiting');
    assert.equal(contract.state({ phase: 'unavailable', epoch: 2, transition }, null), 'revoked');
  }
  for (const transition of [undefined, 'context-changed', 'session-revoked', 'document-hidden', 'unknown']) {
    assert.equal(contract.state({ phase: 'unavailable', epoch: 2, transition }, 'owner-a'), 'revoked');
  }
});

test('one page gate suspends effects without replacing the intent and rejects A to B to A', () => {
  let identity = ready;
  const revoked = [];
  const gate = context.TidyChatgptNavigationIntent.create({ parseRoute: () => ({ conversationId: 'chat' }),
    readIdentity: () => identity, onRevoked: x => revoked.push(x) });
  const control = { navigationIntentId: 'click', workerEpoch: 1, sequence: 1,
    conversationId: 'chat', phase: 'active', ownerAccountKey: 'owner-a' };
  assert.equal(gate.observe(control).accepted, true);
  assert.equal(gate.canPresent('click'), true);
  identity = { phase: 'unavailable', epoch: 2, transition: 'workspace-unconfirmed' };
  assert.equal(gate.canPresent('click'), false); assert.equal(gate.isCurrent('click'), true);
  identity = { ...ready, epoch: 4 };
  assert.equal(gate.canPresent('click'), true); assert.equal(revoked.length, 0);
  identity = { ...ready, epoch: 5, accountKey: 'owner-b' };
  assert.equal(gate.canPresent('click'), false);
  identity = { ...ready, epoch: 6 };
  assert.equal(gate.observe(control).accepted, false);
  assert.equal(gate.canPresent('click'), false); assert.equal(revoked.length, 1);
});

test('same-epoch hard escalation is a tombstone; late owner attachment cannot change a pinned owner', () => {
  let identity = ready;
  const gate = context.TidyChatgptNavigationIntent.create({ parseRoute: () => ({ conversationId: 'chat' }), readIdentity: () => identity });
  const control = { navigationIntentId: 'click', workerEpoch: 1, sequence: 1, conversationId: 'chat', phase: 'active', ownerAccountKey: null };
  gate.observe(control);
  assert.equal(gate.getCurrent().ownerAccountKey, 'owner-a');
  assert.equal(gate.observe({ ...control, ownerAccountKey: 'owner-b' }).accepted, false);
  identity = { phase: 'unavailable', epoch: 2, transition: 'workspace-unconfirmed' };
  gate.observeIdentity(identity); assert.equal(gate.isCurrent('click'), true);
  gate.observeIdentity({ ...identity, transition: 'session-revoked' });
  identity = { ...ready, epoch: 4 };
  assert.equal(gate.observe(control).accepted, false);
});
