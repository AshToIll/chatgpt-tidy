const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync('src/platform/navigation/navigation-identity.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('src/platform/navigation/chatgpt/navigation-intent.js', 'utf8'), context);
const make = context.TidyChatgptNavigationIntent.create;
const control = (sequence, extra = {}) => ({ navigationIntentId: `click-${sequence}`, workerEpoch: 1, sequence,
  phase: 'active', conversationId: 'destination', ...extra });

test('only the greatest worker epoch/ingress sequence may own page execution', () => {
  const revoked = []; const gate = make({ parseRoute: () => ({ conversationId: 'origin' }), onRevoked: x => revoked.push(x) });
  assert.equal(gate.observe(control(2)).accepted, true); assert.equal(gate.observe(control(1)).accepted, false);
  assert.equal(gate.isCurrent('click-2'), true); assert.equal(revoked.length, 0);
  assert.equal(gate.observe(control(1, { workerEpoch: 2 })).accepted, true); assert.equal(revoked.length, 1);
  assert.equal(gate.observe(control(99)).accepted, false); assert.equal(gate.isCurrent('click-1'), true);
});

test('same-stamp cancellation is a tombstone, not permission to revive a late active packet', () => {
  const gate = make({ parseRoute: () => ({ conversationId: 'origin' }) });
  gate.observe(control(1)); gate.observe(control(1, { phase: 'cancelled' }));
  assert.equal(gate.observe(control(1)).accepted, false); assert.equal(gate.isCurrent('click-1'), false);
  assert.equal(gate.observe(control(1, { navigationIntentId: 'forged' })).accepted, false);
});

test('pending saved-item metadata fills only once and does not revoke or restart execution', () => {
  const revoked = []; const gate = make({ parseRoute: () => ({ conversationId: 'origin' }), onRevoked: x => revoked.push(x) });
  gate.observe(control(1, { conversationId: null })); assert.equal(gate.observe(control(1)).accepted, true);
  assert.equal(gate.observe(control(1, { conversationId: 'other' })).accepted, false); assert.equal(revoked.length, 0);
  assert.equal(gate.observe(control(1, { phase: 'cancelled', conversationId: null })).accepted, true);
});

test('own destination is allowed, native departure cancels once and cannot resurrect on return', () => {
  let conversationId = 'origin'; const revoked = []; const gate = make({ parseRoute: () => ({ conversationId }), onRevoked: x => revoked.push(x) });
  gate.observe(control(1)); gate.routeChanged(); assert.equal(revoked.length, 0);
  conversationId = 'destination'; gate.routeChanged(); assert.equal(revoked.length, 0);
  conversationId = 'origin'; gate.routeChanged(); assert.equal(revoked[0].reason, 'route-changed');
  conversationId = 'destination'; gate.routeChanged(); assert.equal(gate.isCurrent('click-1'), false); assert.equal(revoked.length, 1);
});

test('reentrant cancellation notifications cannot overwrite a newer control', () => {
  let gate; gate = make({ parseRoute: () => ({ conversationId: 'origin' }),
    onRevoked: x => { if (x.navigationIntentId === 'click-1') gate.observe(control(3)); } });
  gate.observe(control(1)); assert.equal(gate.observe(control(2)).accepted, false);
  assert.equal(gate.getCurrent().sequence, 3); assert.equal(gate.isCurrent('click-3'), true);
});
