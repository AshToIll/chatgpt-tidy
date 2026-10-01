const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const root=path.resolve(__dirname,".."),read=p=>JSON.parse(fs.readFileSync(path.join(root,p),"utf8"));
const { LANGUAGES, loadRetiredKeys } = require("../tools/build-messages.cjs");
test("deep notice additions have exact four-language approval without rewriting historical copy",()=>{
  const fixture=read("tests/fixtures/message-copy-amendments.json");
  assert.equal(fixture.schemaVersion,1);
  const catalogNames=["common","time","titles","favorites","bookmarks","search","export","settings"];
  const catalogs=Object.fromEntries(catalogNames.map(name=>[name,read("src/messages/catalogs/"+name+".json").messages]));
  for(const entry of fixture.newKeys){assert.deepEqual(Object.keys(entry.translations).sort(),["en","ja","zh-CN","zh-TW"]);assert.deepEqual(catalogs[entry.catalog][entry.key],entry.translations);}
  for(const key of ["pageSessionStalled","backupRestoreCheckHint","backupRestoreChecked","diagnosticsTitle","diagnosticsScope","diagnosticsCopy","diagnosticsClear","diagnosticsBusy","diagnosticsCopied","diagnosticsCleared","diagnosticsReadFailed","diagnosticsCopyFailed","diagnosticsClearFailed","diagnosticsClearConfirm","diagnosticsConfirmClear"])assert.ok(fixture.newKeys.some(entry=>entry.key===key),key);
  for(const key of ["diagnosticsUnread","diagnosticsEmpty"]) {
    assert.equal(Object.hasOwn(catalogs.settings,key),false,key+" removed UI state");
    assert.equal(fixture.newKeys.some(entry=>entry.key===key),false,key+" removed fixture state");
  }
  const approved=new Map(fixture.amendments.map(entry=>[entry.language+":"+entry.key,entry]));
  const retired=new Map(loadRetiredKeys().map(entry=>[entry.key,entry]));
  const baseline=read("docs/current/BEHAVIOR_BASELINE.json").stringHashes;
  for(const entry of retired.values())for(const language of LANGUAGES){
    assert.equal(entry.beforeHashes[language],baseline[language+":"+entry.key],entry.key+" retirement hash");
    assert.equal(approved.has(language+":"+entry.key),false,entry.key+" retired amendment");
    assert.equal(fixture.newKeys.some(added=>added.key===entry.key),false,entry.key+" retired addition");
  }
  for(const [identity,hash] of Object.entries(baseline)){
    const split=identity.indexOf(":"),language=identity.slice(0,split),key=identity.slice(split+1);
    if(retired.has(key)){
      assert.equal(Object.values(catalogs).some(catalog=>Object.hasOwn(catalog,key)),false,identity+" retired catalog entry");
      continue;
    }
    const value=Object.values(catalogs).find(catalog=>Object.hasOwn(catalog,key))[key][language];
    const amendment=approved.get(identity);
    if(amendment){assert.equal(value,amendment.after);assert.equal(crypto.createHash("sha256").update(amendment.before).digest("hex"),hash);}
    else assert.equal(crypto.createHash("sha256").update(value).digest("hex"),hash,identity);
  }
});
