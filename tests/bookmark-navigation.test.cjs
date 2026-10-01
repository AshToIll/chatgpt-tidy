const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync('src/features/bookmarks/ui/bookmark-navigation.js', 'utf8').replace(/^export /gm, ''), context);
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
function harness() {
  let active=true, owner={accountKey:'owner',identity:{documentId:'source'}}, id=null, sequence=0;
  const calls=[], selected=[], results=[], cancellations=[];
  const items={a:{conversationId:'chat',messageId:'first'},b:{conversationId:'other',messageId:'second'}};
  let reply = target => ({...target,pending:true});
  const navigation=context.createBookmarkNavigation({isActive:()=>active,isOwnerCurrent:value=>value===owner,
    isIntentCurrent:value=>value===id,getBookmark:key=>items[key],createIntentId:()=>id=`navigation-${++sequence}`,
    open:(target,lease)=>{calls.push({target,lease});return reply(target);},onSelected:value=>selected.push(value),
    onResult:value=>results.push(value),onCancel:(target,reason)=>{cancellations.push({target,reason});if(id===target.navigationIntentId)id=null;}});
  return {navigation,calls,selected,results,cancellations,items,
    start:(key,sourceConversationId='chat')=>navigation.start({bookmarkId:key,owner,sourceConversationId}),reply:value=>reply=value,
    active:value=>active=value,clearOwner:()=>owner=null,revoke:()=>id=null,
    complete:(patch={})=>navigation.complete({...calls.at(-1).target,located:true,...patch})};
}
test('one explicit OPEN and one exact completion, with no view timer or locator', async()=>{
  const h=harness(); assert.equal(await h.start('a'),true);
  assert.equal(h.calls.length,1); assert.deepEqual(h.selected,['a']); assert.equal(h.results.length,0);
  for(let i=0;i<50;i++) assert.equal(h.navigation.acceptsSnapshot({conversation:{conversationId:'chat'}}),true);
  assert.equal(h.complete(),true); assert.equal(h.complete(),false); assert.equal(h.results.length,1);
  assert.equal(h.calls.length,1);
});
for(const patch of [{navigationIntentId:'old'},{conversationId:'wrong'},{messageId:'wrong'},{located:undefined}])
  test(`completion rejects a foreign or malformed receipt: ${JSON.stringify(patch)}`,async()=>{
    const h=harness();await h.start('a');assert.equal(h.complete(patch),false);assert.equal(h.results.length,0);assert.equal(h.complete(),true);
  });
test('library lease expiry after admission does not erase a worker-owned command',async()=>{
  const h=harness(),wait=deferred();h.reply(()=>wait.promise);const opening=h.start('a');h.clearOwner();
  assert.equal(h.complete(),true);wait.resolve({...h.calls[0].target,pending:true});assert.equal(await opening,true);
  assert.equal(h.results.length,1);
});
test('a completion can precede OPEN and its late transport error cannot overwrite success',async()=>{
  const h=harness(),wait=deferred();h.reply(()=>wait.promise);const opening=h.start('a');
  h.complete();wait.reject(Error('late transport failure'));await opening;assert.equal(h.results.length,1);assert.equal(h.results[0].located,true);
});
test('supersession rejects the old OPEN and completion and selects only explicit clicks',async()=>{
  const h=harness(),wait=deferred();h.reply(target=>target.bookmarkId==='a'?wait.promise:{...target});
  const first=h.start('a');const old=h.calls[0].target;await h.start('b');
  assert.equal(h.navigation.complete({...old,located:true}),false);wait.resolve({...old});assert.equal(await first,false);
  assert.deepEqual(h.selected,['a','b']);assert.equal(h.complete(),true);assert.equal(h.results.length,1);
  h.navigation.cancelId(old.navigationIntentId);assert.equal(h.cancellations.length,1);
});
for(const reason of ['inactive','revoked','cancel','dispose'])test(`${reason} makes a pending OPEN and result inert`,async()=>{
  const h=harness(),wait=deferred();h.reply(()=>wait.promise);const opening=h.start('a');
  if(reason==='inactive')h.active(false);if(reason==='revoked')h.revoke();
  if(reason==='cancel')h.navigation.cancel();if(reason==='dispose')h.navigation.dispose();
  assert.equal(h.complete(),false);wait.resolve({...h.calls[0].target});assert.equal(await opening,false);assert.equal(h.results.length,0);
});
for(const patch of [{bookmarkId:'wrong'},{navigationIntentId:'wrong'},{conversationId:'wrong'},{messageId:'wrong'}])
  test(`mismatched OPEN is a terminal failure without automatic reads: ${JSON.stringify(patch)}`,async()=>{
    const h=harness();h.reply(target=>({...target,...patch}));assert.equal(await h.start('a'),false);
    assert.equal(h.results.length,1);assert.equal(h.results[0].reason,'open-failed');assert.equal(h.cancellations.length,1);
    assert.equal(h.complete(),false);assert.equal(h.calls.length,1);
  });
test('OPEN rejection reports its original error once',async()=>{
  const h=harness(),error=Object.assign(Error('offline'),{code:'ADAPTER_UNAVAILABLE'});h.reply(()=>Promise.reject(error));
  await h.start('a');assert.equal(h.results[0].error,error);assert.equal(h.results.length,1);assert.equal(h.calls.length,1);
});
test('invalid owner, missing bookmark, inactive and disposed view cannot admit a command',async()=>{
  for(const setup of [h=>h.clearOwner(),h=>delete h.items.a,h=>h.active(false),h=>h.navigation.dispose()]){
    const h=harness();setup(h);assert.equal(await h.start('a'),false);assert.equal(h.calls.length,0);assert.equal(h.selected.length,0);
  }
});
test('snapshot allowance belongs only to the selected current target',async()=>{
  const h=harness();await h.start('a');assert.equal(h.navigation.acceptsSnapshot({conversation:{conversationId:'other'}}),false);
  h.navigation.cancel();assert.equal(h.navigation.acceptsSnapshot({conversation:{conversationId:'chat'}}),false);
});

test('cross-conversation waiting belongs to the command, not early target snapshots or library leases',async()=>{
  const h=harness(); await h.start('b');
  assert.equal(h.navigation.pendingConversationId(),'other');
  h.clearOwner();
  for(const bindingStatus of ['route-only','bound']) {
    assert.equal(h.navigation.acceptsSnapshot({conversation:{conversationId:'other',bindingStatus}}),true);
    assert.equal(h.navigation.pendingConversationId(),'other');
  }
  assert.equal(h.complete({messageId:'foreign'}),false);
  assert.equal(h.navigation.pendingConversationId(),'other');
  assert.equal(h.complete(),true);
  assert.equal(h.navigation.pendingConversationId(),null);
});

test('same-conversation opens do not introduce a loading screen',async()=>{
  const h=harness(); await h.start('a'); assert.equal(h.navigation.pendingConversationId(),null);
});

for(const exit of ['fallback','open-failed','cancel','dispose','revoked','inactive','superseded'])
  test(`cross-conversation waiting exits on ${exit}`,async()=>{
    const h=harness();
    if(exit==='open-failed')h.reply(()=>Promise.reject(Error('offline')));
    await h.start('b');
    if(exit==='fallback')h.complete({located:false,reason:'timeout'});
    if(exit==='cancel')h.navigation.cancel();
    if(exit==='dispose')h.navigation.dispose();
    if(exit==='revoked')h.revoke();
    if(exit==='inactive')h.active(false);
    if(exit==='superseded')await h.start('a');
    assert.equal(h.navigation.pendingConversationId(),null);
  });
