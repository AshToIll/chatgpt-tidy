const test = require("node:test"), assert = require("node:assert/strict");
const controller = import("../src/platform/session/ui/page-session-controller.js");
const renderer = import("../src/platform/session/ui/page-refresh-notice.js");
const settle = () => new Promise(setImmediate);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const sessionError = (phase, documentId = "document-a", disconnect) => Object.assign(new Error("Connection unavailable"), {
  code: "ADAPTER_UNAVAILABLE", details: { stage: "service-worker.page-session", phase, documentId, ...(disconnect ? { disconnect } : {}) },
});

async function harness(probe, maxAttempts = 2) {
  const { createPageSessionController } = await controller;
  const timers = new Map(), states = []; let id = 0;
  const gate = createPageSessionController({ probe, maxAttempts, onChanged: state => states.push(state),
    setTimer(fn) { timers.set(++id, fn); return id; }, clearTimer(key) { timers.delete(key); } });
  return { gate, timers, states, async tick() {
    const next = timers.entries().next().value; assert.ok(next, "expected one bounded retry");
    timers.delete(next[0]); next[1](); await settle();
  } };
}

function element(tagName = "div") {
  const value = { tagName, hidden: false, inert: false, disabled: false, dataset: {}, children: [], listeners: new Map(),
    addEventListener(type, callback) { this.listeners.set(type, callback); },
    setAttribute(name, content) { this[name] = content; },
    replaceChildren(...children) { this.children = children; this.ownText = ""; },
    click() { if (!this.disabled) this.listeners.get("click")?.({ preventDefault() {} }); },
  };
  Object.defineProperty(value, "textContent", {
    get() { return this.ownText || this.children.map(child => child.textContent).join(""); },
    set(text) { this.ownText = text; this.children = []; },
  });
  value.ownerDocument = { createElement: element };
  return value;
}
function buttons(root) { return root.children.filter(child => child.tagName === "button"); }
const translate = key => ({ pageSessionStalled: "Connection paused. Reconnect.",
  reconnect: "Reconnect", libraryVerifyingAccount: "Connecting…", refreshChatgptPage: "Reload ChatGPT." })[key] || key;

test("exhausted probe window becomes stalled with no pending retry, never a false connecting spinner", async () => {
  let calls = 0;
  const h = await harness(async () => { calls++; throw sessionError("connecting"); });
  await h.gate.check(); assert.equal(h.gate.getState().phase, "connecting");
  await h.tick();
  assert.equal(calls, 2); assert.equal(h.timers.size, 0);
  assert.equal(h.gate.getState().phase, "stalled");
  assert.equal(h.gate.isReady(), false);
  assert.equal(h.gate.getState().error.details.phase, "connecting");
  h.gate.dispose();
});

test("explicit reconnect starts a fresh bounded read-only probe and never replays blocked writes", async () => {
  let healthy = false, probes = 0, writes = 0;
  const h = await harness(async () => { probes++; if (!healthy) throw new Error("worker unavailable");
    return { ready: true, documentId: "document-b" }; });
  await h.gate.check(); await h.tick();
  assert.equal(h.gate.getState().phase, "stalled");
  for (const type of ["title.apply", "export.job-start", "preferences.update", "library.backup-restore"]) {
    await assert.rejects(h.gate.run(type, () => { writes++; }), { code: "ADAPTER_UNAVAILABLE" });
  }
  assert.equal(writes, 0);
  healthy = true; assert.equal(await h.gate.check(), true);
  assert.equal(probes, 3); assert.equal(writes, 0); assert.equal(h.gate.getState().phase, "ready");
  h.gate.dispose();
});

test("a local stalled admission error and an unclassified page error never manufacture refresh evidence", async () => {
  const h = await harness(async () => { throw sessionError("connecting"); });
  await h.gate.check(); await h.tick();
  let blocked;
  try { await h.gate.run("title.apply", () => assert.fail("write must not dispatch")); } catch (error) { blocked = error; }
  h.gate.reject(blocked);
  assert.equal(h.gate.getState().phase, "stalled"); assert.equal(h.timers.size, 0);
  h.gate.reject(sessionError(undefined, "document-a", "connection-closed"));
  assert.notEqual(h.gate.getState().phase, "refresh-required");
  h.gate.dispose();
});

test("an explicit old-document disconnect remains refresh-required across failed and same-document probes", async () => {
  let mode = "disconnect";
  const h = await harness(async () => {
    if (mode === "disconnect") throw sessionError("refresh-required", "document-a", "receiver-missing");
    if (mode === "failure") throw new Error("worker unavailable");
    return { ready: true, documentId: mode === "new" ? "document-b" : "document-a" };
  });
  await h.gate.check(); assert.equal(h.gate.getState().phase, "refresh-required");
  mode = "failure"; await h.gate.check(); assert.equal(h.gate.getState().phase, "refresh-required");
  mode = "same"; await h.gate.check(); assert.equal(h.gate.getState().phase, "refresh-required");
  assert.equal(h.timers.size, 0);
  mode = "new"; await h.gate.check({ contextChanged: true }); assert.equal(h.gate.getState().phase, "ready");
  h.gate.dispose();
});

test("a retired exhausted probe cannot stall a replacement document", async () => {
  const old = deferred(); let calls = 0;
  const h = await harness(() => ++calls === 1 ? old.promise : Promise.resolve({ ready: true, documentId: "document-b" }), 1);
  const first = h.gate.check(); await settle();
  await h.gate.check({ contextChanged: true });
  old.reject(sessionError("connecting", "document-a")); await first;
  assert.equal(h.gate.getState().phase, "ready"); assert.equal(h.gate.getState().documentId, "document-b");
  assert.equal(h.timers.size, 0); h.gate.dispose();
});

test("stalled uses one actionable condition card while every supplied business region stays hidden and inert", async () => {
  const { renderPageRefreshNotice } = await renderer;
  const root = element(), views = Array.from({ length: 7 }, () => element());
  const model = { pageSession: { phase: "stalled", generation: 2, error: sessionError("connecting") } };
  let reconnects = 0;
  const render = (t = translate) => renderPageRefreshNotice({ root, views, model, translate: t, onReconnect() { reconnects++; } });
  assert.equal(render(), true);
  assert.equal(root.hidden, false); assert.match(root.textContent, /Connection paused/);
  assert.ok(views.every(view => view.hidden && view.inert));
  const reconnect = buttons(root)[0]; assert.ok(reconnect, "stalled must expose one read-only reconnect action");
  assert.equal(buttons(root).length, 1); reconnect.click(); reconnect.click();
  assert.equal(reconnects, 1, "one displayed action must not dispatch a duplicate reconnect");
  render(key => "translated:" + translate(key));
  reconnect.click(); assert.equal(reconnects, 1, "repaint cannot revive a consumed action");
  model.pageSession = { phase: "ready", generation: 3, error: null };
  render(); assert.equal(root.hidden, true); assert.equal(root.textContent, "");
  assert.ok(views.every(view => !view.hidden && !view.inert));
});

test("connecting and refresh-required never offer the stalled reconnect action; retired buttons cannot act", async () => {
  const { renderPageRefreshNotice } = await renderer;
  const root = element(), model = { pageSession: { phase: "stalled", generation: 1 } };
  let calls = 0; const render = () => renderPageRefreshNotice({ root, views: [], model, translate, onReconnect() { calls++; } });
  render(); const retired = buttons(root)[0]; assert.ok(retired);
  model.pageSession = { phase: "connecting", generation: 2 }; render();
  assert.equal(buttons(root).length, 0); retired.click(); assert.equal(calls, 0);
  model.pageSession = { phase: "refresh-required", generation: 3 }; render();
  assert.equal(root.textContent, "Reload ChatGPT."); assert.equal(buttons(root).length, 0);
});

test("ordinary failures and malformed probe results exhaust exactly once at a one-attempt budget", async () => {
  for (const probe of [async () => { throw new Error("transport unavailable"); }, async () => ({ ready: false }),
    async () => ({ ready: true, documentId: "" })]) {
    const h = await harness(probe, 1);
    assert.equal(await h.gate.check(), false); assert.equal(h.gate.getState().phase, "stalled");
    assert.equal(h.timers.size, 0); h.gate.dispose();
  }
});

test("a retry probe cannot erase the original evidence for a confirmed refresh requirement", async () => {
  const confirmed = sessionError("refresh-required", "document-a", "receiver-missing");
  let failure = confirmed;
  const h = await harness(async () => { throw failure; });
  await h.gate.check(); failure = new Error("temporary probe transport failure");
  await h.gate.check();
  assert.equal(h.gate.getState().phase, "refresh-required");
  assert.equal(h.gate.getState().error, confirmed);
  h.gate.dispose();
});

test("reconnect shares its pending probe and disposal never dispatches another probe or write", async () => {
  let calls = 0, next = null;
  const h = await harness(() => { calls++; return next ? next.promise : Promise.reject(sessionError("connecting")); }, 1);
  await h.gate.check(); next = deferred();
  const first = h.gate.check(), second = h.gate.check();
  assert.equal(first, second); await settle(); assert.equal(calls, 2);
  h.gate.dispose(); next.resolve({ ready: true, documentId: "document-b" });
  assert.equal(await first, false); assert.equal(await h.gate.check(), false); assert.equal(calls, 2);
  await assert.rejects(h.gate.run("title.apply", () => assert.fail("disposed controller dispatched a write")));
});

test("malformed retries cannot replace confirmed old-document disconnect evidence", async () => {
  const confirmed = sessionError("refresh-required", "document-a", "receiver-missing");
  let result = null;
  const h = await harness(async () => { if (result === null) throw confirmed; return result; });
  await h.gate.check();
  for (const malformed of [{ ready: false }, { ready: true, documentId: "" }]) {
    result = malformed; await h.gate.check();
    assert.equal(h.gate.getState().phase, "refresh-required");
    assert.equal(h.gate.getState().error, confirmed);
  }
  h.gate.dispose();
});

test("condition diagnostics keep the known phase without an error and preserve safe cause identity on repaint", async () => {
  const { renderPageRefreshNotice } = await renderer;
  const previousDiagnostics = globalThis.ChatGPTTidyDiagnostics, previousBuild = globalThis.ChatGPTTidyBuildInfo;
  const records = [];
  globalThis.ChatGPTTidyBuildInfo = { reasonCodes: ["ADAPTER_UNAVAILABLE", "PAGE_SESSION_CONNECTING", "PAGE_SESSION_STALLED"] };
  globalThis.ChatGPTTidyDiagnostics = { notice: record => records.push(record), cause: globalThis.ChatGPTTidyNoticeLifecycle.cause };
  try {
    const root = element(), model = { pageSession: { phase: "connecting", generation: 1, error: null } };
    const render = () => renderPageRefreshNotice({ root, views: [], model, translate, onReconnect() {} });
    render(); assert.equal(records[0].reasonCode, "PAGE_SESSION_CONNECTING");
    const cause = Object.assign(sessionError("connecting"), { requestId: "req-00000000-0000-4000-8000-000000000001" });
    model.pageSession = { phase: "stalled", generation: 2, error: cause };
    render(); const record = records.at(-1);
    assert.equal(record.reasonCode, "ADAPTER_UNAVAILABLE"); assert.equal(record.requestId, cause.requestId);
    render(); assert.equal(records.length, 2, "repaint is not a new condition or diagnostics instance");
    assert.equal(JSON.stringify(records).includes("Connection unavailable"), false);
  } finally {
    if (previousDiagnostics === undefined) delete globalThis.ChatGPTTidyDiagnostics; else globalThis.ChatGPTTidyDiagnostics = previousDiagnostics;
    if (previousBuild === undefined) delete globalThis.ChatGPTTidyBuildInfo; else globalThis.ChatGPTTidyBuildInfo = previousBuild;
  }
});
