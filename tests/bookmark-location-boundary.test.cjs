const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');
const { snapshotHarness } = require('./helpers/adapter-snapshot.cjs');
const { installPageSession } = require('./helpers/page-session.cjs');
const { loadMainModule } = require('./helpers/main-runtime.cjs');

test('real main-world bookmark bridge requires an admitted owner without per-action authentication', async () => {
  let reads = 0;
  const h = snapshotHarness({ url: 'https://chatgpt.com/c/chat', returnSession: true,
    sidebar: [{ href: '/c/chat', title: 'Synthetic chat', record: { id: 'chat', title: 'Synthetic chat' } }],
    fetch: async url => {
      assert.equal(url, '/api/auth/session'); reads++;
      return { ok: true, status: 200, json: async () => ({ user: { id: 'owner' }, accessToken: 'fixture-only' }) };
    },
  });
  const ready = await h.requestTitle('LIBRARY_ACCOUNT', {});
  assert.equal(ready.ok, true);
  const navigationIntentId = 'bookmark-current';
  const navigationControl = { navigationIntentId, workerEpoch: 1, sequence: 1, phase: 'active', conversationId: 'chat', ownerAccountKey: ready.payload.accountKey };
  const control = await h.requestTitle('NAVIGATION_INTENT', navigationControl);
  assert.equal(control.payload.accepted, true);
  for (const stamp of [undefined, { ...navigationControl, ownerAccountKey: null },
    { ...navigationControl, ownerAccountKey: '["someone-else","personal"]' }]) {
    const response = await h.requestTitle('LOCATE_MESSAGE', { conversationId: 'chat', messageId: 'missing', navigationIntentId, navigationControl: stamp });
    assert.equal(response.ok, false); assert.equal(response.error.code, 'CONTEXT_MISMATCH');
  }
  for (let index = 0; index < 20; index++) {
    const response = await h.requestTitle('LOCATE_MESSAGE', { conversationId: 'chat', messageId: 'missing', navigationIntentId, navigationControl });
    assert.equal(response.ok, true); assert.equal(response.payload.located, false);
  }
  assert.equal(reads, 1, 'The final bookmark fence is local, not a per-action session probe');
  h.setCookie('_account=different-workspace');
  const changed = await h.requestTitle('LOCATE_MESSAGE', { conversationId: 'chat', messageId: 'missing', navigationIntentId, navigationControl });
  assert.equal(changed.ok, false); assert.equal(changed.error.code, 'CONTEXT_MISMATCH');
  assert.equal(reads, 1, 'The stale bookmark fails closed without starting identity initialization');
});


// Admission is shared; physical revalidation belongs to message-location and
// is covered by the reentrant resolver tests and real handoff integrations.
function locatorHarness(revoked) {
  let executions=0;
  const context=vm.createContext({
    TidyProtocol:{ErrorCode:{CONTEXT_MISMATCH:'CONTEXT_MISMATCH'}},
    TidyChatgptNavigationIntent:{create:()=>({
      observe:()=>({accepted:revoked!=='control'}), isCurrent:()=>revoked!=='navigation',
    })},
    TidyChatgptApi:{checkLibraryIdentity:()=>({phase:'ready',accountKey:revoked==='identity'?'different':'owner'})},
    TidyChatgptMessageNavigation:{create:()=>({start(){executions++;return {located:false,pending:true,reason:'settling'};}})},
  });
  installPageSession(context);
  loadMainModule(context, 'src/platform/navigation/navigation-identity.js');
  loadMainModule(context, 'src/platform/chatgpt/page-navigation-runtime.js');
  const navigation = context.TidyChatgptPageNavigationRuntime.create({reader:{},postEnvelope:()=>{}});
  return {run:query=>navigation.locateMessage({conversationId:'chat',messageId:'message',query,navigationIntentId:'admitted',
    navigationControl:{navigationIntentId:'admitted',conversationId:'chat',phase:'active',ownerAccountKey:'owner'}}),
    executions:()=>executions};
}
for(const reason of ['control','identity','navigation'])test('shared message admission rejects '+reason,()=>{
  const h=locatorHarness(reason);assert.throws(()=>h.run(),e=>e.tidyCode==='CONTEXT_MISMATCH');assert.equal(h.executions(),0);
});
test('bookmarks and search receive the same pending execution acknowledgement, not landing success',()=>{
  const h=locatorHarness();for(const query of [undefined,'needle']){const result=h.run(query);assert.equal(result.located,false);assert.equal(result.pending,true);}
  assert.equal(h.executions(),2);
});
