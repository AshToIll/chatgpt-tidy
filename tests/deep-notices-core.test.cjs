const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const generatedBuild = require("../tools/build-message-index.cjs").buildOutputs().get("src/messages/build-info.js");
function runtime() {
  const context = vm.createContext({});
  for (const name of ["build-info.js", "notice-lifecycle.js", "notice-registry.js", "diagnostics.js"])
    vm.runInContext(name === "build-info.js" ? generatedBuild : fs.readFileSync(path.join(root, "src/messages", name), "utf8"), context, { filename: name });
  return context;
}
function clock() {
  let now = 0, serial = 0; const pending = new Map(), history = [];
  return { now: () => now, setTimer(fn, delay) { const id = ++serial; const entry = { fn, at: now + delay };
    pending.set(id, entry); history.push(entry); return id; },
    clearTimer(id) { pending.delete(id); }, history,
    advance(ms) { now += ms; for (const [id, entry] of [...pending]) if (entry.at <= now) { pending.delete(id); entry.fn(); } } };
}
test("owner tokens are opaque, superseded, revoked and permanently disposed", () => {
  const api = runtime().ChatGPTTidyNoticeLifecycle, owner = api.createOwner();
  const a = owner.begin(); assert.equal(owner.owns(a), true);
  assert.equal(owner.owns({ epoch: a.epoch }), false);
  const b = owner.begin(); assert.equal(owner.owns(a), false); assert.equal(owner.owns(b), true);
  owner.revoke(); assert.equal(owner.owns(b), false); owner.dispose();
  assert.equal(owner.begin(), null); assert.equal(owner.owns(null), false);
});
test("short notice expires without a render and an old queued timer cannot clear a newer notice", () => {
  const api = runtime().ChatGPTTidyNoticeLifecycle, timer = clock(), changes = [];
  const slot = api.createSlot({ ...timer, onChange: (value, change) => changes.push({ value, change }) });
  const a = slot.replace({ kind: "transient", messageKey: "searchDateReadFailed" }, { ttlMs: 5000 });
  const stale = timer.history[0].fn; timer.advance(1000);
  const b = slot.replace({ kind: "transient", messageKey: "searchKeywordIncomplete" }, { ttlMs: 5000 });
  stale(); assert.equal(slot.current(), b); assert.equal(slot.clear(a), false);
  timer.advance(5000); assert.equal(slot.current(), null); assert.equal(changes.at(-1).change.reason, "NOTICE_EXPIRED");
});
test("render reads never restart the timer; pausing retains remaining visible time", () => {
  const api = runtime().ChatGPTTidyNoticeLifecycle, timer = clock(), slot = api.createSlot(timer);
  const notice = slot.replace({ kind: "transient", messageKey: "ready" }, { ttlMs: 5000 });
  timer.advance(2000); for (let i = 0; i < 20; i++) assert.equal(slot.current(), notice);
  slot.setPaused(true); timer.advance(10000); assert.equal(slot.current(), notice);
  slot.setPaused(false); timer.advance(2999); assert.equal(slot.current(), notice);
  timer.advance(1); assert.equal(slot.current(), null);
});
test("conditions and unknown operations never acquire an expiry timer", () => {
  const api = runtime().ChatGPTTidyNoticeLifecycle, timer = clock(), slot = api.createSlot(timer);
  for (const kind of ["condition", "operation"]) {
    assert.throws(() => slot.replace({ kind }, { ttlMs: 5000 }), /transient/);
    const notice = slot.replace({ kind, messageKey: "libraryChangeUnknown" });
    timer.advance(1000000); assert.equal(slot.current(), notice);
  }
  assert.equal(timer.history.length, 0);
});
test("old or disposed owners cannot publish, including after a newer slot was cleared", () => {
  const api = runtime().ChatGPTTidyNoticeLifecycle, owner = api.createOwner(), slot = api.createSlot();
  const old = owner.begin(), latest = owner.begin();
  assert.equal(slot.replace({ kind: "transient" }, { owner, token: old }), null);
  const notice = slot.replace({ kind: "condition" }, { owner, token: latest });
  assert.ok(notice); slot.clear(notice); owner.revoke();
  assert.equal(slot.replace({ kind: "transient" }, { owner, token: latest }), null);
  slot.dispose(); assert.equal(slot.replace({ kind: "condition" }), null);
});
test("typed cause accepts real export descriptors and keeps safe correlation only", () => {
  const context = runtime(), api = context.ChatGPTTidyNoticeLifecycle;
  const req = "req-00000000-0000-4000-8000-000000000001";
  const actual = api.cause({ exportMessageKey: "exportInvalidDocument", requestId: req, message: "private" });
  assert.equal(actual.reasonCode, "exportInvalidDocument"); assert.equal(actual.requestId, req);
  assert.equal(api.cause({ reasonCode: "TITLE_CONFLICT" }).reasonCode, "TITLE_CONFLICT");
  assert.equal(api.cause({ code: "private", requestId: "account-secret" }).requestId, null);
  assert.equal(context.ChatGPTTidyDiagnostics.cause, api.cause, "one sanitizer implementation");
});
test("diagnostic sink sees sanitized records, isolates failure and has exact detach ownership", () => {
  const context = runtime(), diagnostics = context.ChatGPTTidyDiagnostics, received = [];
  const input = { event: "show", surface: "search.error", source: "src/features/search/ui/search-view.js", messageKey: "searchDateReadFailed", reasonCode: "SEARCH_UNAVAILABLE" };
  const staleDetach = diagnostics.setSink(() => { throw Error("sink must not break UI"); });
  assert.doesNotThrow(() => diagnostics.notice(input));
  const detach = diagnostics.setSink(event => received.push(event)); staleDetach();
  diagnostics.notice({ ...input, messageKey: "searchKeywordIncomplete" });
  assert.equal(received.length, 2); assert.equal(Object.isFrozen(received[0]), true);
  detach(); diagnostics.notice({ event: "clear", surface: "search.error" });
  assert.equal(received.length, 2); assert.equal(diagnostics.snapshot().activeCount, 0);
});

test("a timer queued before pause cannot expire the same notice after resume", () => {
  const api = runtime().ChatGPTTidyNoticeLifecycle, timer = clock(), slot = api.createSlot(timer);
  const notice = slot.replace({ kind: "transient", messageKey: "ready" }, { ttlMs: 5000 });
  const beforePause = timer.history[0].fn;
  timer.advance(1000); slot.setPaused(true); timer.advance(10000); slot.setPaused(false);
  beforePause(); assert.equal(slot.current(), notice, "old timer must not consume the resumed lifetime");
  timer.advance(4000); assert.equal(slot.current(), null);
});
test("real protocol failure retains safe recovery evidence without leaking details", () => {
  const context = runtime();
  vm.runInContext(fs.readFileSync(path.join(root, "src/platform/protocol.js"), "utf8"), context);
  const p = context.TidyProtocol, request = p.request(p.Type.GET_ACTIVE_CONTEXT);
  const response = p.failure(request, p.ErrorCode.ADAPTER_UNAVAILABLE, "private response", {
    stage: "sidepanel.runtime-send-message", disconnect: p.runtimeDisconnectReason(Error("Extension context invalidated")),
    status: 503, retryable: false, authorization: "private token", accountKey: "private account",
  });
  const cause = context.ChatGPTTidyNoticeLifecycle.cause({ ...response.error, requestId: response.requestId });
  assert.equal(cause.stage, "sidepanel.runtime-send-message"); assert.equal(cause.disconnect, "context-invalidated");
  assert.equal(cause.status, 503); assert.equal(cause.retryable, false);
  assert.deepEqual(JSON.parse(JSON.stringify(context.ChatGPTTidyNoticeLifecycle.cause(cause))), JSON.parse(JSON.stringify(cause)));
  context.ChatGPTTidyDiagnostics.notice({ event: "show", surface: "shell.context",
    source: "src/app/sidepanel/panel.js", messageKey: "unavailable", ...cause });
  const event = context.ChatGPTTidyDiagnostics.snapshot().events[0];
  assert.equal(event.stage, cause.stage); assert.equal(event.status, 503);
  assert.equal(JSON.stringify(event).includes("private"), false);
  const invalid = context.ChatGPTTidyNoticeLifecycle.cause({ stage: "https://private", disconnect: "private", status: 99, retryable: "private" });
  for (const key of ["stage", "disconnect", "status", "retryable"]) assert.equal(invalid[key], null);
});

test("old sink detach cannot remove a new registration of the same callback", () => {
  const diagnostics = runtime().ChatGPTTidyDiagnostics, events = [], sink = event => events.push(event);
  const detachOld = diagnostics.setSink(sink), detachNew = diagnostics.setSink(sink);
  detachOld(); diagnostics.notice({ event: "show", surface: "search.error", source: "src/features/search/ui/search-view.js",
    messageKey: "searchDateReadFailed", reasonCode: "SEARCH_UNAVAILABLE" });
  assert.equal(events.length, 1); detachNew(); diagnostics.notice({ event: "clear", surface: "search.error" });
  assert.equal(events.length, 1);
});
test("stage vocabulary includes assigned stage values, not equality or typeof comparisons", () => {
  const stages = runtime().ChatGPTTidyBuildInfo.stageCodes;
  assert.ok(stages.includes("service-worker.page-session"));
  assert.ok(stages.includes("service-worker.export-response"));
  assert.ok(stages.includes("status-publish"), "structured helper stages remain diagnosable");
  assert.equal(stages.includes("string"), false);
  assert.equal(stages.includes("context-invalidated"), false);
});
