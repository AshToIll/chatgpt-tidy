const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const vm = require("node:vm");
const test = require("node:test");

// Reuse the production-backed harness without registering or changing its tests.
const fixturePath = path.resolve(__dirname, "title-view.test.cjs");
const fixture = new Module(fixturePath, module);
fixture.filename = fixturePath;
fixture.paths = Module._nodeModulePaths(path.dirname(fixturePath));
fixture._compile(fs.readFileSync(fixturePath, "utf8")
  .replace('const test = require("node:test");', 'const test = () => {};')
  .replace('const controller = rulesController || context.getTitleRulesController();',
    'vm.runInContext(source("src/messages/notice-lifecycle.js"), context); const controller = rulesController || context.getTitleRulesController();')
  + '\nmodule.exports = { harness, flush, snapshot, plan, result, receipt, deferred };', fixturePath);
const { harness, flush, snapshot, plan, result, receipt, deferred } = fixture.exports;
const requestId = "req-11111111-1111-4111-8111-111111111111";
const failure = () => Object.assign(new Error("private server text"), { code: "NETWORK", requestId });
function notices(h) {
  // Real registry and sanitizer prove these causes reach production diagnostics,
  // not just a test spy that would accept an unregistered surface.
  for (const file of ["build-info.js", "notice-registry.js", "diagnostics.js"])
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../src/messages", file), "utf8"), h.context);
  const events = [], diagnostics = h.context.ChatGPTTidyDiagnostics;
  h.context.ChatGPTTidyDiagnostics = Object.freeze({ ...diagnostics,
    notice(input) { const event = diagnostics.notice(input); if (event) events.push(event); return event; },
  });
  return events;
}
const latestShown = events => events.filter(event => event.event === "show").at(-1);

test("unknown write keeps submitted title and primary warning after hide and failed status", async () => {
  const h = harness({ request: action => {
    if (["apply", "status"].includes(action)) throw failure();
    return result({ plan: plan() });
  } });
  h.update(); await flush(); h.click("apply"); await flush();
  assert.match(h.root.innerHTML, /data-title-recovery/);
  h.update({ active: false }); h.update({ active: true }); await flush();
  assert.equal(h.view.state.recoveryNeeded, true);
  assert.match(h.root.innerHTML, /data-title-recovery/);
  assert.match(h.root.innerHTML, /\[2026-08-01\] Original/);
  assert.match(h.root.innerHTML, new RegExp(h.context.createTranslator("zh-CN")("titlesUncertain")));
  assert.match(h.root.innerHTML, new RegExp(h.context.createTranslator("zh-CN")("titlesReadFailed")));
  assert.match(h.root.innerHTML, /data-title-action="reconcile"/);
  assert.doesNotMatch(h.root.innerHTML, /data-title-action="apply"|data-title-action="preview"/);
  assert.deepEqual(h.calls.map(call => call.action), ["preview", "apply", "status"]);
});

test("visible read failure retains its original cause across metadata-only updates", async () => {
  const h = harness({ request: () => { throw failure(); } });
  const events = notices(h);
  h.update(); await flush();
  assert.equal(latestShown(events).requestId, requestId);
  h.update({ snapshot: snapshot("one", "Different title") }); await flush();
  assert.equal(latestShown(events).messageKey, "titlesReadFailed");
  assert.equal(latestShown(events).reasonCode, "NETWORK");
  assert.equal(latestShown(events).requestId, requestId);
  assert.deepEqual(h.calls.map(call => call.action), ["preview"]);
});

test("a structured conflict receipt exposes its typed cause, not an unspecified failure", async () => {
  const h = harness({ request: action => action === "preview" ? result({ plan: plan() })
    : result({ operation: receipt("conflict", { messageCode: "dates_changed" }) }) });
  const events = notices(h);
  h.update(); await flush(); h.click("apply"); await flush();
  assert.equal(latestShown(events).messageKey, "titlesDatesChanged");
  assert.equal(latestShown(events).reasonCode, "dates_changed");
  assert.equal(h.calls.filter(call => call.action === "apply").length, 1);
});


test("readonly recovery retains the current write cause and reports its own failure separately", async () => {
  const checking = deferred();
  const readRequestId = "req-22222222-2222-4222-8222-222222222222";
  let applyCount = 0;
  const h = harness({ request: action => {
    if (action === "preview") return result({ plan: plan() });
    if (action === "apply" && ++applyCount === 1) return result({
      current: { conversationId: "one", title: "First saved", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
      plan: plan({ id: "plan-2", before: "First saved", after: "Second target", hasDateHead: false }),
      operation: receipt("verified", { messageCode: "title_verified" }),
    });
    if (action === "apply") throw failure();
    if (action === "reconcile") return checking.promise;
    throw new Error("Unexpected request");
  } });
  const events = notices(h);
  const main = () => events.filter(event => event.event === "show" && event.surface === "titles.current.notice").at(-1);
  h.update(); await flush(); h.click("apply"); await flush(); h.click("apply"); await flush();
  assert.equal(main().requestId, requestId);
  h.click("reconcile"); await flush();
  assert.equal(main().reasonCode, "NETWORK");
  assert.equal(main().requestId, requestId, "starting a read cannot substitute an older verified receipt");
  checking.reject(Object.assign(new Error("private read error"), { code: "ADAPTER_UNAVAILABLE", requestId: readRequestId }));
  await flush();
  assert.equal(main().requestId, requestId, "the unresolved write keeps its originating correlation");
  const recovery = events.filter(event => event.event === "show" && event.surface === "titles.current.recovery").at(-1);
  assert.equal(recovery?.requestId, readRequestId);
  assert.equal(recovery?.reasonCode, "ADAPTER_UNAVAILABLE");
  assert.match(h.root.innerHTML, /Second target/);
  assert.equal(applyCount, 2, "checking never resends either write");
});
