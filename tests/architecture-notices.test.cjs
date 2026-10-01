const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), test = require("node:test");
const ROOT = path.resolve(__dirname, ".."), read = file => fs.readFileSync(path.join(ROOT,file),"utf8");
const plain = value => JSON.parse(JSON.stringify(value));
function runtime() {
  const context = vm.createContext({});
  for (const file of ["build-info.js","notice-registry.js","notice-lifecycle.js","diagnostics.js"])
    vm.runInContext(read("src/messages/"+file), context, { filename: file });
  return context;
}
function input(extra={}) {
  return { event:"show", surface:"search.error", source:"src/features/search/ui/search-view.js",
    messageKey:"searchKeywordIncomplete", reasonCode:"SEARCH_UNAVAILABLE",
    requestId:"req-00000000-0000-4000-8000-000000000001", ...extra };
}
test("notice observer retains key/cause/source/build and pairs actual clear with original event",()=>{
  const context=runtime(),api=context.ChatGPTTidyDiagnostics;
  api.notice(input()); api.notice({event:"clear",surface:"search.error",reasonCode:"NOTICE_CLEARED_BY_OWNER"});
  const events=plain(api.snapshot().events);
  assert.deepEqual(events.map(e=>e.event),["show","clear"]);
  for(const event of events) {
    assert.equal(event.messageKey,"searchKeywordIncomplete");assert.equal(event.reasonCode,"SEARCH_UNAVAILABLE");
    assert.equal(event.source,"src/features/search/ui/search-view.js");assert.equal(event.requestId,input().requestId);
    assert.match(event.buildFingerprint,/^[a-f0-9]{24}$/);assert.equal(event.version,context.ChatGPTTidyBuildInfo.version);
  }
});
test("rendering the same notice does not produce new events or timers",()=>{
  const context=runtime(),api=context.ChatGPTTidyDiagnostics;
  for(let i=0;i<50;i++)api.notice(input());
  assert.equal(api.snapshot().events.length,1);
  assert.equal(context.setTimeout,undefined);
  api.notice(input({messageKey:"titlesRateLimited",reasonCode:"TITLE_RATE_LIMITED"}));
  assert.deepEqual(plain(api.snapshot().events).map(e=>e.event),["show","clear","show"]);
  assert.equal(api.snapshot().events[1].clearReasonCode,"NOTICE_REPLACED");
});
test("arbitrary remote text, account IDs, URLs and unknown keys are not recorded",()=>{
  const api=runtime().ChatGPTTidyDiagnostics;
  const secret="private@example.com session-token-secret https://example.com/private";
  const cause=api.cause({code:secret,message:secret,details:{token:secret},requestId:secret,navigationIntentId:secret,jobId:secret});
  api.notice(input({...cause,source:secret,details:secret,message:secret}));
  api.notice(input({messageKey:secret}));
  const events=plain(api.snapshot().events);
  assert.equal(events.length,1);assert.equal(events[0].reasonCode,"OBSERVATION_ONLY_UNSPECIFIED");
  assert.equal(events[0].source,"SOURCE_NOT_REGISTERED");assert.equal(events[0].requestId,null);
  assert.ok(!api.exportText().includes(secret));
});
test("typed cause is copied without error.message/details and no caller mutation",()=>{
  const api=runtime().ChatGPTTidyDiagnostics,error={code:"TITLE_RATE_LIMITED",requestId:input().requestId,message:"SECRET",details:{body:"SECRET"}};
  assert.deepEqual(plain(api.cause(error)),{reasonCode:"TITLE_RATE_LIMITED",requestId:input().requestId,navigationIntentId:null,jobId:null,stage:null,disconnect:null,status:null,retryable:null});
  assert.equal(error.message,"SECRET");assert.equal(Object.keys(error).length,4);
  assert.equal(api.cause({get code(){throw new Error("secret");}}).reasonCode,"OBSERVATION_ONLY_UNSPECIFIED");
});
test("unknown or broken observer inputs cannot throw into business logic",()=>{
  const api=runtime().ChatGPTTidyDiagnostics;
  for(const value of [null,undefined,{},1,"secret",{event:"show",surface:"not-registered"},{get surface(){throw Error("boom");}}])
    assert.doesNotThrow(()=>api.notice(value));
  assert.equal(api.snapshot().events.length,0);
});
test("bounded local history and snapshots cannot mutate internal records",()=>{
  const api=runtime().ChatGPTTidyDiagnostics;
  for(let i=0;i<300;i++){api.notice(input());api.notice({event:"clear",surface:"search.error"});}
  const snapshot=api.snapshot();assert.equal(snapshot.events.length,256);assert.equal(snapshot.lifetime,"current-document");
  snapshot.events[0].messageKey="poison";snapshot.events.pop();
  assert.equal(api.snapshot().events.length,256);assert.notEqual(api.snapshot().events[0].messageKey,"poison");
  api.clear();assert.equal(api.snapshot().events.length,0);
});
test("multiple webpage nodes remain independent without recording target identities",()=>{
  const api=runtime().ChatGPTTidyDiagnostics,a={},b={};
  assert.equal(api.slot(a),api.slot(a));assert.notEqual(api.slot(a),api.slot(b));assert.equal(api.slot(null),null);
  for(const node of [a,b])api.notice(input({surface:"page.favorite.error",source:"src/features/favorites/chatgpt/favorites-presentation.js",messageKey:"pageFavoriteFailed",instanceId:api.slot(node)}));
  assert.deepEqual(plain(api.snapshot().events).map(e=>e.event),["show","show"]);
  api.notice({event:"clear",surface:"page.favorite.error",instanceId:api.slot(a)});
  assert.equal(api.snapshot().events[2].instanceId,api.slot(a));
});
test("only known generated correlation formats are accepted, including export job UUID",()=>{
  const api=runtime().ChatGPTTidyDiagnostics,jobId="00000000-0000-4000-8000-000000000002";
  api.notice(input({jobId,navigationIntentId:"navigation-1700000000000-abcdef"}));
  const event=api.snapshot().events[0];assert.equal(event.jobId,jobId);assert.equal(event.navigationIntentId,"navigation-1700000000000-abcdef");
  assert.equal(api.cause({requestId:jobId}).requestId,null);
});
test("surface registry has unique owners, actual source files, and explicit lifecycle policy",()=>{
  const registry=runtime().ChatGPTTidyNoticeRegistry;
  assert.equal(new Set(registry.surfaces.map(s=>s.surface)).size,registry.surfaces.length);
  for(const entry of registry.surfaces){
    assert.ok(fs.existsSync(path.join(ROOT,entry.source)),entry.source);
    for(const field of ["owner","trigger","recovery","clear"])assert.ok(entry[field]?.length,entry.surface+" "+field);
  }
});
test("PM index uses source catalogs and exact current source references, without declaring dynamic keys unused",()=>{
  const {buildOutputs}=require("../tools/build-message-index.cjs");
  const outputs=buildOutputs(),index=JSON.parse(outputs.get("docs/current/MESSAGE_INDEX.json"));
  assert.equal(index.messages.length,runtime().ChatGPTTidyBuildInfo.messageKeys.length);
  assert.ok(index.dynamicCalls.length>0);assert.equal(index.unknownLiteralCalls.length,0);
  for(const entry of index.messages){
    const definition=read(entry.definition.source).split(/\r?\n/)[entry.definition.line-1];
    assert.ok(definition.includes('"'+entry.key+'"'),entry.key+" definition");
    for(const reference of entry.references){
      const line=read(reference.source).split(/\r?\n/)[reference.line-1];
      assert.ok(line.includes(entry.key),entry.key+" "+reference.source+":"+reference.line);
    }
  }
});
test("page refresh observability preserves the original blocked/hidden behavior",()=>{
  const context=runtime();
  vm.runInContext(read("src/platform/session/ui/page-refresh-notice.js").replace(/^import .+;$/gm, "").replace(/^export /gm, ""),context);
  const root={hidden:false,textContent:""},views=[{hidden:false,inert:false}];
  assert.equal(context.renderPageRefreshNotice({root,views,model:{pageSession:{phase:"refresh-required"}},translate:key=>key}),true);
  assert.equal(root.textContent,"refreshChatgptPage");assert.equal(views[0].inert,true);
  assert.equal(context.renderPageRefreshNotice({root,views,model:{pageSession:{phase:"ready"}},translate:key=>key}),false);
  assert.equal(root.hidden,true);assert.equal(views[0].inert,false);
  assert.deepEqual(plain(context.ChatGPTTidyDiagnostics.snapshot().events).map(e=>e.event),["show","clear"]);
});
test("generated build info excludes raw user/server text and observer performs no storage/network work",()=>{
  const source=read("src/messages/diagnostics.js");
  assert.doesNotMatch(source,/\b(?:fetch|XMLHttpRequest|localStorage|sessionStorage|setTimeout|setInterval)\s*\(/);
  assert.doesNotMatch(source,/chrome\.storage|error\?\.message|error\?\.details/);
});

test("typed camelCase export errors remain known instead of collapsing to unknown",()=>{
  const api=runtime().ChatGPTTidyDiagnostics;
  for(const code of ["exportJobTimeout","exportDependencyFailed","exportInvalidDocument"]){
    assert.equal(api.cause({code}).reasonCode,code);
  }
});
test("native DOM removal is observed via weak node ownership without mutating DOM",()=>{
  const api=runtime().ChatGPTTidyDiagnostics,node={isConnected:true};
  api.notice(input({surface:"page.favorite.error",source:"src/features/favorites/chatgpt/favorites-presentation.js",
    messageKey:"pageFavoriteFailed",instanceId:api.slot(node),ownerNode:node}));
  node.isConnected=false;
  const snapshot=api.snapshot();
  assert.deepEqual(plain(snapshot.events).map(e=>e.event),["show","clear"]);
  assert.equal(snapshot.events[1].clearReasonCode,"OWNER_NODE_DETACHED");
  assert.equal(snapshot.activeCount,0);assert.deepEqual(Object.keys(node),["isConnected"]);
  assert.ok(!api.exportText().includes("ownerNode"));
  api.notice(input({ownerNode:node}));
  assert.equal(api.snapshot().events.length,2);
});
test("active correlation table is bounded and eviction never pretends the UI was cleared",()=>{
  const api=runtime().ChatGPTTidyDiagnostics;
  for(let i=0;i<300;i++)api.notice(input({instanceId:"node-"+i}));
  const snapshot=api.snapshot();
  assert.equal(snapshot.activeCount,256);assert.equal(snapshot.evictedActiveCount,44);
  assert.ok(snapshot.events.every(event=>event.event==="show"));
});
