"use strict";
// Reuse the established protocol/DOM harness without registering or changing its tests.
// New regressions stay independently runnable while exercising the real view source.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const assert = require("node:assert/strict");
const fixture = path.join(__dirname, "title-batch-view.test.cjs");
const fixtureSource = fs.readFileSync(fixture, "utf8");
const start = fixtureSource.indexOf('test("external rename');
assert.ok(start > 0, "The shared batch harness boundary must remain explicit.");
const imported = new Module(fixture, module);
imported.filename = fixture;
imported.paths = module.paths;
imported._compile(fixtureSource.slice(0, start) +
  "\nmodule.exports = { harness, review, actions, button, deferred, flush, snapshot, rows, plain };", fixture);
const { harness, review, actions, button, deferred, flush, snapshot, rows, plain } = imported.exports;
function diagnostics(h) {
  const records = [];
  h.context.ChatGPTTidyDiagnostics = {
    cause: error => ({ reasonCode: error?.code || "UNKNOWN", requestId: error?.requestId || undefined }),
    notice: record => records.push(plain(record)),
  };
  return { records, latest: () => records.findLast(record => record.surface === "titles.batch.notice" && record.event === "show") };
}

test("account changes revoke even an empty pending status receipt and expose a read-only recheck", async () => {
  const old = deferred();
  let accountKey = "account-1", statusCount = 0;
  const h = harness({
    loadCatalog: options => options.onUpdate({ accountKey, rows, loading: false }),
    intercept: (action, payload, server) => action === "batch-status" && ++statusCount === 1
      ? old.promise : server.respond(action, payload),
  });
  h.update(); await flush();
  assert.equal(h.calls[0].payload.catalogAccountKey, "account-1");
  accountKey = "account-2";
  h.catalog({ accountKey, rows, loading: false });
  h.select("one");
  old.resolve({ batchId: null }); await flush();
  assert.equal(h.view.state.accountKey, "account-2");
  assert.equal(h.view.state.receiptStatusReady, false, "account-1 cannot authorize account-2");
  assert.match(button(h, "preview"), /disabled/);
  assert.doesNotMatch(button(h, "recheck-status"), /disabled/);
  h.click("recheck-status"); await flush();
  assert.equal(h.calls.at(-1).payload.catalogAccountKey, "account-2");
  assert.equal(h.view.state.receiptStatusReady, true);
  assert.deepEqual(actions(h), ["batch-status", "batch-status"]);
});

test("return-owner rejection cannot revive a notice after a successful return and receipt read", async () => {
  const navigation = deferred();
  const h = harness({ intercept: (action, payload, server) => action === "return-owner"
    ? navigation.promise : server.respond(action, payload) });
  await review(h, ["one"]);
  h.view.state.batch.items[0].status = "uncertain";
  h.update({ snapshot: snapshot("other") }); await flush();
  h.click("return-owner");
  h.update({ snapshot: snapshot("owner") }); await flush();
  assert.equal(h.view.state.error, "");
  const before = actions(h);
  navigation.reject(Object.assign(new Error("late navigation failure"), { code: "TITLE_CONFLICT" }));
  await flush();
  assert.equal(h.view.state.error, "");
  assert.deepEqual(actions(h), before, "stale navigation never dispatches recovery or writes");
});

for (const boundary of ["hidden", "disposed"]) {
  test("return-owner rejection cannot mutate a " + boundary + " view", async () => {
    const navigation = deferred();
    const h = harness({ intercept: (action, payload, server) => action === "return-owner"
      ? navigation.promise : server.respond(action, payload) });
    const log = diagnostics(h);
    await review(h, ["one"]);
    h.view.state.batch.items[0].status = "uncertain";
    h.update({ snapshot: snapshot("other") }); await flush();
    h.click("return-owner");
    if (boundary === "hidden") h.update({ active: false }); else h.view.dispose();
    const previousError = h.view.state.error, previousRecords = log.records.length;
    let lateWrites = 0;
    Object.defineProperty(h.view.state, "error", { configurable: true, get: () => previousError, set: () => { lateWrites++; } });
    navigation.reject(Object.assign(new Error("late"), { code: "TITLE_NETWORK", requestId: "hidden-request" }));
    await flush();
    assert.equal(h.view.state.error, previousError);
    assert.equal(log.records.length, previousRecords);
    assert.equal(lateWrites, 0, "a hidden or disposed interaction cannot mutate state");
  });
}

test("the latest return-owner request owns its result even without a route change", async () => {
  const first = deferred(), second = deferred(); let count = 0;
  const h = harness({ intercept: (action, payload, server) => action === "return-owner"
    ? (++count === 1 ? first.promise : second.promise) : server.respond(action, payload) });
  await review(h, ["one"]);
  h.view.state.batch.items[0].status = "uncertain";
  h.update({ snapshot: snapshot("other") }); await flush();
  h.click("return-owner"); h.click("return-owner");
  second.resolve({ navigated: true }); await flush();
  // A completed navigation interaction has no pending failure to report.
  h.view.state.error = "";
  first.reject(Object.assign(new Error("older failure"), { code: "TITLE_CONFLICT" })); await flush();
  assert.equal(h.view.state.error, "");
});

test("an explicit pre-step plan expiry offers only a fresh read-only review and keeps its cause", async () => {
  const h = harness({ intercept: (action, payload, server) => {
    if (action === "batch-apply") throw Object.assign(new Error("expired"), { code: "TITLE_PLAN_EXPIRED", requestId: "expiry-request" });
    return server.respond(action, payload);
  } });
  const log = diagnostics(h);
  await review(h, ["one"]); h.click("apply"); await flush();
  assert.equal(h.view.state.error, "titlesPlanExpired");
  assert.equal(h.view.state.recovery, false, "a positively rejected start is not an unknown write");
  assert.equal(log.latest().reasonCode, "TITLE_PLAN_EXPIRED");
  assert.equal(log.latest().requestId, "expiry-request");
  assert.match(button(h, "apply"), /disabled/);
  assert.doesNotMatch(button(h, "refresh-preview"), /disabled/);
  assert.equal(actions(h).includes("batch-step"), false);
  const applyCount = actions(h).filter(action => action === "batch-apply").length;
  h.click("refresh-preview"); await flush();
  assert.equal(h.view.state.error, "");
  assert.equal(actions(h).at(-1), "batch-retry-preview");
  assert.equal(actions(h).filter(action => action === "batch-apply").length, applyCount);
});

test("the same expiry code after dispatching a step remains unknown with a read-only check", async () => {
  const h = harness({ intercept: (action, payload, server) => {
    if (action === "batch-step") throw Object.assign(new Error("response lost"), { code: "TITLE_PLAN_EXPIRED", requestId: "step-request" });
    return server.respond(action, payload);
  } });
  const log = diagnostics(h);
  await review(h, ["one"]); h.click("apply"); await flush();
  assert.equal(h.view.state.error, "titlesReceiptMissing");
  assert.equal(h.view.state.recovery, true);
  assert.equal(log.latest().reasonCode, "TITLE_PLAN_EXPIRED");
  assert.equal(log.latest().requestId, "step-request");
  assert.ok(button(h, "reconcile"));
  assert.equal(button(h, "retry-preview"), undefined);
  const before = actions(h); h.dispatch({ batchAction: "retry-preview" }); await flush();
  assert.deepEqual(actions(h), before);
});

test("a receipt failure retains its exact cause while a hidden view reopens into a pending recheck", async () => {
  const pending = deferred(); let count = 0;
  const h = harness({ intercept: (action, payload, server) => {
    if (action === "batch-status") {
      if (++count === 1) throw Object.assign(new Error("not retained"), { code: "TITLE_NETWORK", requestId: "status-request" });
      return pending.promise;
    }
    return server.respond(action, payload);
  } });
  const log = diagnostics(h);
  h.update(); await flush();
  assert.equal(log.latest().reasonCode, "TITLE_NETWORK");
  h.update({ active: false }); h.update({ active: true }); await flush();
  assert.equal(h.view.state.receiptChecking, true);
  assert.equal(log.latest().reasonCode, "TITLE_NETWORK");
  assert.equal(log.latest().requestId, "status-request");
  pending.resolve({ batchId: null }); await flush();
  assert.equal(h.view.state.error, "");
  assert.equal(h.view.state.receiptStatusReady, true);
});

test("a receipt failure recovers its own cause after a separate navigation conflict", async () => {
  const pending = deferred(); let statusCount = 0;
  const h = harness({ intercept: (action, payload, server) => {
    if (action === "batch-step") throw Object.assign(new Error("step transport failed"), { code: "TITLE_NETWORK", requestId: "write-request" });
    if (action === "batch-status") {
      statusCount++;
      if (statusCount === 2) throw Object.assign(new Error("status unavailable"), { code: "TITLE_NETWORK", requestId: "receipt-owner-request" });
      if (statusCount === 3) return pending.promise;
    }
    return server.respond(action, payload);
  } });
  const log = diagnostics(h);
  await review(h, ["one"]); h.click("apply"); await flush();
  h.update({ active: false }); h.update({ active: true }); await flush();
  assert.equal(h.view.state.receiptStatusError, "titlesReadFailed");
  assert.equal(log.latest().requestId, "receipt-owner-request");
  h.update({ snapshot: snapshot("other") }); await flush();
  h.update({ snapshot: snapshot("owner") }); await flush();
  assert.equal(h.view.state.receiptChecking, true);
  assert.equal(log.latest().reasonCode, "TITLE_NETWORK");
  assert.equal(log.latest().requestId, "receipt-owner-request");
  pending.resolve(plain(h.server.job)); await flush();
  assert.equal(actions(h).filter(action => action === "batch-step").length, 1);
});
