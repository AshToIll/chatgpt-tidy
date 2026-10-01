const assert = require('node:assert/strict');
const test = require('node:test');
const { snapshotHarness } = require('./helpers/adapter-snapshot.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));
const conversation = 'composed-chat', timestamp = 1900000000;
const native = (id, role = 'assistant', options = {}) => ({ id, conversationId:conversation,
  text:'Synthetic text, not a timestamp', item:{ type:`${role}-message`, messageId:id, sentAtMs:null, completed:true }, ...options });
function payload() {
  const record = (id, role, parent) => ({ id, parent, children:[], message:{ id, author:{role}, status:'finished_successfully',
    create_time:timestamp, content:{content_type:'text', parts:['Synthetic canonical message']} } });
  return { conversation_id:conversation, title:'Fixture', create_time:timestamp, update_time:timestamp+1, current_node:'answer',
    mapping:{ question:record('question','user',null), answer:record('answer','assistant','question'), abandoned:record('abandoned','assistant','question') } };
}
function harness(messages, fetch, options={}) {
  return snapshotHarness({ url:`https://chatgpt.com/c/${conversation}`, returnSession:true, messages, fetch,
    sessionFixture:{user:{id:'fixture'},accessToken:'fixture-token'}, ...options });
}
test('composed messages use their exact native timestamp without needing a DOM legacy ID', () => {
  const message=native('answer');message.item.sentAtMs=timestamp*1000;
  const h=harness([message]);const snapshot=h.readSnapshot();
  assert.equal(snapshot.conversation.bindingStatus,'bound');
  assert.equal(snapshot.messages.length,1);
  assert.equal(snapshot.messages[0].timestamp.value,new Date(timestamp*1000).toISOString());
  assert.equal(snapshot.messages[0].timestamp.source,'react-fiber.message-item');
  assert.deepEqual(snapshot.messages[0].locator,{strategy:'data-chatgpt-search-message-ids',value:'answer'});
});
test('missing composed timestamps and message numbers share one current-conversation read', async () => {
  let calls=0;const h=harness([native('question','user'),native('answer','assistant',{domIds:'answer answer'})],async()=>{
    calls++;return {ok:true,status:200,json:async()=>payload()};
  });
  assert.equal(h.readSnapshot().messages.length,0);await flush();
  const snapshot=h.readSnapshot();assert.equal(calls,1);assert.equal(snapshot.messages.length,2);
  assert.deepEqual(snapshot.messages.map(m=>m.order.displayNumber),[1,2]);
  assert.ok(snapshot.messages.every(m=>m.timestamp.value===new Date(timestamp*1000).toISOString()));
  assert.ok(snapshot.messages.every(m=>m.timestamp.source==='chatgpt-api.canonical-active-branch'));
  for(let i=0;i<10;i++){h.setMessages([native(i%2?'answer':'question',i%2?'assistant':'user')]);h.readSnapshot();await flush();}
  assert.equal(calls,1,'virtualized known messages do not refetch');
});
test('composed timestamps remain independent of missing conversation dates', async()=>{
  const body=payload();delete body.create_time;delete body.update_time;
  let calls=0;const h=harness([native('answer')],async()=>{calls++;return {ok:true,status:200,json:async()=>body};});
  h.readSnapshot();await flush();const snapshot=h.readSnapshot();
  assert.equal(snapshot.messages.length,1);assert.equal(snapshot.conversation.createdAt.value,null);
  for(let i=0;i<6;i++){h.readSnapshot();await flush();}assert.equal(calls,1);
});
test('composed metadata errors do not poll or manufacture a time from the visible text',async()=>{
  let calls=0;const h=harness([native('answer','assistant',{text:'[2026-09-26 15:09]'})],async()=>{calls++;return {ok:false,status:429};});
  for(let i=0;i<10;i++){assert.equal(h.readSnapshot().messages.length,0);await flush();}
  assert.equal(calls,1);
});
test('wrong conversation, mismatched ID and multi-message aggregates do not enter snapshots',()=>{
  for(const message of [native('answer','assistant',{conversationId:'other'}),
    native('answer','assistant',{domIds:'different'}),native('answer','assistant',{domIds:'answer different'})]){
    message.item.sentAtMs=timestamp*1000;const h=harness([message]);assert.equal(h.readSnapshot().messages.length,0);
  }
});
test('abandoned-branch records and role mismatches cannot lend canonical dates to a composed item',async()=>{
  for(const message of [native('abandoned'),native('question')]){
    const h=harness([message],async()=>({ok:true,status:200,json:async()=>payload()}));h.readSnapshot();await flush();
    assert.equal(h.readSnapshot().messages.length,0);
  }
});
test('a late composed timestamp reply cannot follow the user into another workspace or route',async()=>{
  for(const change of ['workspace','route']){
    let release;const waiting=new Promise(resolve=>release=resolve);
    const h=harness([native('answer')],async()=>waiting);h.readSnapshot();await flush();
    if(change==='workspace')h.setCookie('_account=other-workspace');else h.setLocation('https://chatgpt.com/c/other');
    h.readSnapshot();release({ok:true,status:200,json:async()=>payload()});await flush();
    assert.equal(h.readSnapshot().messages.length,0,change);
  }
});
