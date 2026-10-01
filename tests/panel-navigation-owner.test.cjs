const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync('src/platform/navigation/ui/navigation-owner.js', 'utf8').replace(/^export /gm, ''), ctx);
function fixture() {
  let seq = 0; const calls = [];
  return { owner: ctx.createPanelNavigationOwner({ createId: () => `intent-${++seq}`, cancel: (id, reason) => calls.push({ id, reason }) }), calls };
}
test('favorites, bookmarks and search share the same panel cancellation handle before any receipt', () => {
  const { owner, calls } = fixture();
  const favorite = owner.begin('favorites'), bookmark = owner.begin('bookmarks'), search = owner.begin('search');
  assert.deepEqual(calls.map(x => x.id), [favorite, bookmark]);
  assert.equal(owner.isCurrent(search), true); assert.equal(owner.cancel(bookmark), false);
  owner.leave('settings'); assert.equal(calls.at(-1).id, search); assert.equal(owner.isCurrent(search), false);
});
test('same-module render and a stale remote cancellation never revoke the current click', () => {
  const { owner, calls } = fixture(); const id = owner.begin('bookmarks');
  for (let i = 0; i < 20; i++) owner.leave('bookmarks');
  owner.revoked('old'); assert.equal(calls.length, 0); assert.equal(owner.isCurrent(id), true);
  owner.revoked(id); assert.equal(calls.length, 0); assert.equal(owner.isCurrent(id), false);
});
test('hidden and close terminate once, without creating a new navigation or an IPC echo loop', () => {
  const { owner, calls } = fixture(); const id = owner.begin('favorites');
  owner.close(); owner.close(); owner.cancel(id); owner.revoked(id);
  assert.equal(calls.length, 1); assert.equal(calls[0].id, id);
});
