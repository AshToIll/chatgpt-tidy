// Regression coverage for client isolation, bounded delivery, and user-only diagnostics controls.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), test = require("node:test");
const ROOT = path.resolve(__dirname, ".."), read = relative => fs.readFileSync(path.join(ROOT, relative), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function environment() {
  const context = vm.createContext({ Uint8Array, crypto: { getRandomValues: bytes => bytes.fill(7) } });
  for (const file of ["messages/build-info.js", "messages/notice-registry.js", "messages/notice-lifecycle.js",
    "messages/diagnostics.js", "platform/diagnostics/wire.js", "platform/diagnostics/client.js"]) {
    vm.runInContext(read("src/" + file), context, { filename: file });
  }
  const base = { event: "show", eventId: 1, at: 123, surface: "search.error", instanceId: null,
    messageKey: "searchKeywordIncomplete", reasonCode: "SEARCH_UNAVAILABLE", source: "src/features/search/ui/search-view.js",
    requestId: "req-00000000-0000-4000-8000-000000000001", navigationIntentId: null, jobId: null,
    version: context.ChatGPTTidyBuildInfo.version, buildFingerprint: context.ChatGPTTidyBuildInfo.fingerprint };
  function observer(initial = []) {
    let sink, clears = 0, attachments = 0;
    return { cause: context.ChatGPTTidyDiagnostics.cause,
      setSink(next) { attachments++; sink = next; return () => { if (sink === next) sink = null; }; },
      snapshot: () => ({ events: initial }), clear: () => { clears++; },
      emit: value => sink?.(value), stats: () => ({ clears, attachments }) };
  }
  function snapshot(events = [], generation = "a".repeat(32)) {
    return { schema: 1, version: base.version, buildFingerprint: base.buildFingerprint, lifetime: "browser-session",
      limit: 512, byteLimit: 262144, storedBytes: 400, generation, revision: 1, persisted: true,
      dropped: { capacity: 0, duplicateOrOutOfOrder: 0, staleGeneration: 0 }, storageFailures: 0, queueRejectedOperations: 0, queueDroppedEvents: 0, events };
  }
  return { context, base, observer, snapshot };
}
test("attach handshakes once, batches at 16 and limits the waiting queue to 64 without timers", async () => {
  const { context, base, observer } = environment(), source = observer(), calls = [], pending = [];
  const runtime = { sendMessage(message) { calls.push(plain(message)); const wait = deferred(); pending.push(wait); return wait.promise; } };
  const client = context.TidyDiagnosticsTransport.createClient({ runtime });
  client.attach(source); client.attach(source);
  for (let sequence = 1; sequence <= 100; sequence++) source.emit({ ...base, eventId: sequence });
  await turn();
  assert.equal(calls.length, 1); assert.equal(calls[0].generation, null); assert.deepEqual(calls[0].events, []);
  assert.equal(source.stats().attachments, 1); assert.equal(client.status().pending, 64); assert.equal(client.status().overflow, 36);
  pending[0].resolve({ ok: true, persisted: true, accepted: 0, generation: "a".repeat(32) });
  await turn();
  assert.equal(calls.length, 2); assert.equal(calls[1].events.length, 16);
  assert.equal(calls[1].events[0].sequence, 37); assert.equal(client.status().pending, 48);
  assert.equal(context.setTimeout, undefined); assert.equal(context.setInterval, undefined);
  client.dispose(); pending[1].resolve({ ok: true, persisted: true, accepted: 16, generation: "a".repeat(32) }); await turn();
  assert.equal(calls.length, 2);
});
test("projected delivery preserves safe causes but never includes raw content or Error details", async () => {
  const { context, base, observer } = environment(), source = observer(), calls = [];
  const client = context.TidyDiagnosticsTransport.createClient({ runtime: { async sendMessage(message) {
    calls.push(plain(message)); return { ok: true, persisted: true, accepted: message.events.length, generation: "a".repeat(32) };
  } } });
  client.attach(source); await turn();
  source.emit({ ...base, message: "PRIVATE", details: { body: "PRIVATE" }, accountKey: "PRIVATE", conversationId: "PRIVATE",
    messageId: "PRIVATE", url: "PRIVATE", navigationIntentId: "navigation-00000000-0000-4000-8000-000000000002",
    jobId: "00000000-0000-4000-8000-000000000003", disconnect: "receiver-missing", status: 503, retryable: true });
  await turn();
  const event = calls[1].events[0];
  assert.ok(!JSON.stringify(calls).includes("PRIVATE")); assert.equal(event.requestId, base.requestId);
  assert.equal(event.disconnect, "receiver-missing"); assert.equal(event.status, 503); assert.equal(event.retryable, true);
  assert.equal(event.jobId, "00000000-0000-4000-8000-000000000003");
});
test("transport failure drops bounded pending events and never automatically retries", async () => {
  const { context, base, observer } = environment(), source = observer(); let count = 0;
  const wait = deferred();
  const client = context.TidyDiagnosticsTransport.createClient({ runtime: { sendMessage() { count++; return wait.promise; } } });
  client.attach(source); source.emit(base); await turn(); wait.reject(new Error("PRIVATE")); await turn(); await turn();
  source.emit({ ...base, eventId: 2 }); await turn();
  assert.equal(count, 1); assert.equal(client.status().transportFailures, 1);
  assert.equal(client.status().transport, 2); assert.equal(client.status().recording, false);
  assert.ok(!JSON.stringify(client.status()).includes("PRIVATE"));
});
test("stale generation discards old queue without retry, while later observations use new generation", async () => {
  const { context, base, observer } = environment(), source = observer(), calls = [];
  const wait = deferred();
  const client = context.TidyDiagnosticsTransport.createClient({ runtime: { sendMessage(message) {
    calls.push(plain(message));
    if (calls.length === 1) return Promise.resolve({ ok: true, persisted: true, accepted: 0, generation: "a".repeat(32) });
    if (calls.length === 2) return wait.promise;
    return Promise.resolve({ ok: true, persisted: true, accepted: message.events.length, generation: "b".repeat(32) });
  } } });
  client.attach(source); await turn(); source.emit(base); source.emit({ ...base, eventId: 2 }); await turn();
  wait.resolve({ ok: false, code: "DIAGNOSTICS_STALE_GENERATION", generation: "b".repeat(32) }); await turn();
  assert.equal(calls.length, 2); assert.equal(client.status().staleGeneration, 2);
  source.emit({ ...base, eventId: 3 }); await turn();
  assert.equal(calls[2].generation, "b".repeat(32)); assert.deepEqual(calls[2].events.map(event => event.sequence), [3]);
});
test("clear retires old inflight ACK without freezing new-generation delivery", async () => {
  const { context, base, observer, snapshot } = environment(), source = observer(), calls = [], old = deferred();
  const client = context.TidyDiagnosticsTransport.createClient({ runtime: { sendMessage(message) {
    calls.push(plain(message));
    if (message.operation === "clear") return Promise.resolve({ ok: true, snapshot: snapshot([], "b".repeat(32)) });
    if (calls.length === 1) return Promise.resolve({ ok: true, persisted: true, accepted: 0, generation: "a".repeat(32) });
    if (calls.length === 2) return old.promise;
    return Promise.resolve({ ok: true, persisted: true, accepted: message.events.length, generation: message.generation });
  } } });
  client.attach(source); await turn(); source.emit(base); await turn();
  await client.clear(); source.emit({ ...base, eventId: 2 });
  old.resolve({ ok: true, persisted: true, accepted: 1, generation: "a".repeat(32) }); await turn();
  assert.equal(source.stats().clears, 1); assert.equal(calls.length, 4);
  assert.equal(calls[3].generation, "b".repeat(32)); assert.deepEqual(calls[3].events.map(event => event.sequence), [2]);
  assert.equal(client.status().cleared, 1);
});
test("clear before the scheduled send cannot relabel an old record with the new generation", async () => {
  const { context, base, observer, snapshot } = environment(), source = observer(), calls = [];
  const client = context.TidyDiagnosticsTransport.createClient({ runtime: { async sendMessage(message) {
    calls.push(plain(message));
    return message.operation === "clear" ? { ok: true, snapshot: snapshot([], "b".repeat(32)) }
      : { ok: true, persisted: true, accepted: message.events.length, generation: message.generation || "a".repeat(32) };
  } } });
  client.attach(source); await turn(); source.emit(base); await client.clear(); await turn();
  const old = calls.find(message => message.events?.length);
  assert.equal(old.generation, "a".repeat(32));
});
test("read/export reject unexpected snapshot fields and preserve storage failure accounting", async () => {
  const { context, snapshot } = environment(); let response = { ok: true, snapshot: { ...snapshot(), accountKey: "PRIVATE" } };
  const client = context.TidyDiagnosticsTransport.createClient({ runtime: { async sendMessage() { return response; } } });
  await assert.rejects(client.exportText(), { code: "DIAGNOSTICS_READ_FAILED" });
  response = { ok: false, code: "DIAGNOSTICS_STORAGE_FAILED", message: "PRIVATE" };
  await assert.rejects(client.read(), { code: "DIAGNOSTICS_READ_FAILED" }); assert.equal(client.status().storageFailures, 1);
  response = { ok: true, snapshot: snapshot() };
  const exported = JSON.parse((await client.exportText()).text);
  assert.equal(exported.client.storageFailures, 1); assert.ok(!JSON.stringify(exported).includes("PRIVATE"));
});
test("storage failure during clear is visible and never reports cleared or replays writes", async () => {
  const { context, observer } = environment(), source = observer(); let count = 0;
  const client = context.TidyDiagnosticsTransport.createClient({ runtime: { async sendMessage(message) {
    count++; return message.operation === "clear" ? { ok: false, code: "DIAGNOSTICS_STORAGE_FAILED" }
      : { ok: true, persisted: true, accepted: 0, generation: "a".repeat(32) };
  } } });
  client.attach(source); await turn(); await assert.rejects(client.clear(), { code: "DIAGNOSTICS_CLEAR_FAILED" }); await turn();
  assert.equal(count, 2); assert.equal(source.stats().clears, 0); assert.equal(client.status().storageFailures, 1);
});
test("bootstrap is one-shot and ignores unavailable Chrome without touching business state", async () => {
  const { context } = environment(); let count = 0;
  context.chrome = { runtime: { id: "test", async sendMessage() { count++; return { ok: true, persisted: true, accepted: 0, generation: "a".repeat(32) }; } } };
  const script = read("src/platform/diagnostics/runtime.js");
  vm.runInContext(script, context); const first = context.TidyDiagnosticsClient; vm.runInContext(script, context); await turn();
  assert.equal(context.TidyDiagnosticsClient, first); assert.equal(count, 1); assert.equal(context.TidyDiagnosticsBootstrap.failures, 0);
  const unavailable = environment().context;
  assert.doesNotThrow(() => vm.runInContext(script, unavailable)); assert.equal(unavailable.TidyDiagnosticsClient, undefined);
});
function viewHarness(client, writeClipboard = async () => {}) {
  const nodes = new Map(), timers = new Map(), scheduled = [];
  let now = 0, timerId = 0;
  const document = { activeElement: null };
  function node() { return { textContent: "", disabled: false, hidden: false, handlers: new Map(), attributes: new Map(),
    addEventListener(name, fn) { this.handlers.set(name, fn); }, removeEventListener(name, fn) { if (this.handlers.get(name) === fn) this.handlers.delete(name); },
    setAttribute(name, value) { this.attributes.set(name, value); },
    focus() { document.activeElement = this; },
    click() { if (!this.disabled) this.handlers.get("click")?.(); } }; }
  const root = Object.assign(node(), { ownerDocument: document, classList: { add() {} }, innerHTML: "",
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); } });
  const source = read("src/features/settings/ui/diagnostics-view.js").replace("export function createDiagnosticsView", "function createDiagnosticsView");
  const context = vm.createContext({}); vm.runInContext(source + "\nglobalThis.factory = createDiagnosticsView;", context);
  const view = context.factory({ root, client, writeClipboard,
    setTimer(callback, delay) { const id = ++timerId, timer = { callback, at: now + delay }; timers.set(id, timer); scheduled.push(timer); return id; },
    clearTimer(id) { timers.delete(id); } });
  view.update({ translator: key => key });
  const ui = { view, root, document, timers, scheduled,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers].sort(([, a], [, b]) => a.at - b.at).find(([, timer]) => timer.at <= target);
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback();
      }
      now = target;
    },
    escape() { let prevented = false; root.handlers.get("keydown")?.({ key: "Escape", preventDefault() { prevented = true; } }); return prevented; },
  };
  for (const [key, name] of Object.entries({ copy: "copy", clear: "clear", status: "status", actions: "actions", confirmation: "confirmation",
    confirmMessage: "confirm-message", confirmClear: "confirm-clear", cancelClear: "cancel-clear" })) ui[key] = root.querySelector("[data-diagnostics-" + name + "]");
  return ui;
}
test("settings logs start quietly and require explicit confirmation to clear, with no render I/O", async () => {
  let reads = 0, clears = 0, copied = "";
  const ui = viewHarness({ async exportText() { reads++; return { eventCount: 1, text: "{}" }; }, async clear() { clears++; } },
    async text => { copied = text; });
  assert.equal(ui.status.textContent, ""); assert.equal(ui.status.hidden, true); assert.equal(ui.confirmation.hidden, true);
  assert.doesNotMatch(ui.root.innerHTML, /diagnosticsUnread/);
  assert.equal((ui.root.innerHTML.match(/type="button"/g) || []).length, 4, "all controls stay non-submitting inside settings");
  ui.view.update({ translator: key => "x:" + key });
  assert.equal(reads, 0); assert.equal(clears, 0);
  ui.copy.click(); await turn(); assert.equal(reads, 1); assert.equal(copied, "{}"); assert.equal(ui.status.textContent, "x:diagnosticsCopied");
  ui.clear.click(); await turn();
  assert.equal(clears, 0); assert.equal(ui.confirmation.hidden, false); assert.equal(ui.actions.hidden, true);
  assert.equal(ui.status.hidden, true); assert.equal(ui.confirmMessage.textContent, "x:diagnosticsClearConfirm");
  assert.equal(ui.document.activeElement, ui.cancelClear, "destructive action is not the default focus");
  assert.equal(ui.cancelClear.attributes.get("aria-describedby"), ui.confirmMessage.id);
  assert.equal(ui.confirmClear.attributes.get("aria-describedby"), ui.confirmMessage.id);
  assert.equal(ui.confirmation.attributes.get("aria-label"), "x:diagnosticsClear");
  ui.confirmClear.focus(); ui.confirmClear.click(); await turn();
  assert.equal(clears, 1); assert.equal(ui.status.textContent, "x:diagnosticsCleared");
  assert.equal(ui.confirmation.hidden, true); assert.equal(ui.actions.hidden, false); assert.equal(ui.document.activeElement, ui.clear);
});
test("clearing can be cancelled by its button or Escape without reading or deleting logs", async () => {
  let clears = 0, reads = 0;
  const ui = viewHarness({ async clear() { clears++; }, async exportText() { reads++; } });
  ui.confirmClear.click(); await turn(); assert.equal(clears, 0, "hidden confirmation cannot authorize deletion");
  ui.clear.click(); ui.cancelClear.click();
  assert.equal(ui.confirmation.hidden, true); assert.equal(ui.document.activeElement, ui.clear);
  ui.clear.click(); ui.copy.click(); await turn();
  assert.equal(reads, 0, "hidden copy is ignored while asking to clear");
  assert.equal(ui.escape(), true); assert.equal(ui.confirmation.hidden, true); assert.equal(ui.escape(), false);
  assert.equal(clears, 0); assert.equal(ui.status.hidden, true);
});
test("settings copies empty logs, distinguishes read/copy/clear errors and holds the busy gate", async () => {
  let count = 0, next = deferred();
  const ui = viewHarness({ exportText() { count++; return next.promise; }, async clear() { throw new Error("PRIVATE"); } });
  ui.copy.click(); ui.copy.click(); ui.clear.click(); assert.equal(count, 1); assert.equal(ui.copy.disabled, true);
  assert.equal(ui.confirmation.hidden, true);
  next.resolve({ text: "{}", eventCount: 0 }); await turn(); assert.equal(ui.status.textContent, "diagnosticsCopied");
  next = deferred(); ui.copy.click(); next.reject(new Error("PRIVATE")); await turn(); assert.equal(ui.status.textContent, "diagnosticsReadFailed");
  assert.equal(ui.timers.size, 0); ui.advance(30000); assert.equal(ui.status.textContent, "diagnosticsReadFailed", "failure stays available for retry");
  ui.clear.click(); ui.confirmClear.click(); await turn(); assert.equal(ui.status.textContent, "diagnosticsClearFailed");
  const copyFail = viewHarness({ async exportText() { return { text: "{}", eventCount: 2 }; } }, async () => { throw new Error("PRIVATE"); });
  copyFail.copy.click(); await turn(); assert.equal(copyFail.status.textContent, "diagnosticsCopyFailed");
  assert.ok(!ui.status.textContent.includes("PRIVATE")); assert.equal(ui.copy.disabled, false);
});
test("success feedback clears after three seconds without clearing logs or restarting on translation", async () => {
  let clears = 0, reads = 0;
  const ui = viewHarness({ async exportText() { reads++; return { eventCount: 1, text: "{}" }; }, async clear() { clears++; } });
  ui.copy.click(); await turn(); assert.equal(ui.timers.size, 1);
  ui.advance(2000); ui.view.update({ translator: key => "new:" + key });
  assert.equal(ui.status.textContent, "new:diagnosticsCopied"); assert.equal(ui.timers.size, 1);
  ui.advance(999); assert.equal(ui.status.hidden, false); ui.advance(1);
  assert.equal(ui.status.hidden, true); assert.equal(ui.status.textContent, ""); assert.equal(reads, 1); assert.equal(clears, 0);
  ui.clear.click(); ui.confirmClear.click(); await turn(); ui.advance(3000);
  assert.equal(clears, 1); assert.equal(ui.status.hidden, true);
});
test("retired success timers cannot erase a newer request, confirmation or failure", async () => {
  let result = { eventCount: 1, text: "{}" };
  const ui = viewHarness({ async exportText() { if (result instanceof Error) throw result; return result; }, async clear() {} });
  ui.copy.click(); await turn(); const stale = ui.scheduled.at(-1).callback;
  ui.clear.click(); stale(); assert.equal(ui.confirmation.hidden, false); assert.equal(ui.status.hidden, true);
  ui.cancelClear.click(); result = new Error("PRIVATE"); ui.copy.click(); await turn(); stale();
  assert.equal(ui.status.textContent, "diagnosticsReadFailed"); assert.equal(ui.timers.size, 0);
});
test("confirmation and busy state survive translation without duplicate clear or focus theft", async () => {
  const pending = deferred(); let clears = 0;
  const ui = viewHarness({ clear() { clears++; return pending.promise; } });
  ui.clear.click(); ui.view.update({ translator: key => "new:" + key });
  assert.equal(ui.confirmation.hidden, false); assert.equal(ui.confirmMessage.textContent, "new:diagnosticsClearConfirm");
  assert.equal(ui.document.activeElement, ui.cancelClear);
  ui.confirmClear.focus(); ui.confirmClear.click(); ui.confirmClear.click(); ui.clear.click(); ui.cancelClear.click();
  assert.equal(clears, 1); assert.equal(ui.confirmClear.attributes.get("aria-disabled"), "true"); assert.equal(ui.escape(), false);
  ui.view.update({ translator: key => "latest:" + key }); assert.equal(clears, 1); assert.equal(ui.status.textContent, "latest:diagnosticsBusy");
  const otherControl = {}; ui.document.activeElement = otherControl; pending.resolve(); await turn();
  assert.equal(ui.status.textContent, "latest:diagnosticsCleared"); assert.equal(ui.document.activeElement, otherControl);
});
test("disposed settings view ignores late reads and never copies stale results", async () => {
  const pending = deferred(); let copies = 0;
  const ui = viewHarness({ exportText: () => pending.promise }, async () => { copies++; });
  ui.copy.click(); ui.view.dispose(); pending.resolve({ text: "{}", eventCount: 1 }); await turn();
  assert.equal(copies, 0);
  for (const node of [ui.copy, ui.clear, ui.confirmClear, ui.cancelClear, ui.root]) assert.equal(node.handlers.size, 0);
  assert.equal(ui.timers.size, 0); ui.view.dispose();
});
test("dispose cancels feedback and ignores clear or clipboard results already in flight", async () => {
  const pending = deferred(), copied = deferred();
  const clearing = viewHarness({ clear: () => pending.promise });
  clearing.clear.click(); clearing.confirmClear.click(); clearing.view.dispose(); pending.resolve(); await turn();
  assert.equal(clearing.timers.size, 0); assert.equal(clearing.status.textContent, "diagnosticsBusy");
  const copying = viewHarness({ async exportText() { return { text: "{}", eventCount: 1 }; } }, () => copied.promise);
  copying.copy.click(); await turn(); copying.view.dispose(); copied.resolve(); await turn();
  assert.equal(copying.timers.size, 0); assert.equal(copying.status.textContent, "diagnosticsBusy");
  const done = viewHarness({ async exportText() { return { text: "{}", eventCount: 1 }; } });
  done.copy.click(); await turn(); const stale = done.scheduled.at(-1).callback;
  done.view.dispose(); stale(); assert.equal(done.timers.size, 0); assert.equal(done.status.textContent, "diagnosticsCopied");
});

test("stale client detach cannot remove a later attachment of the same observer", async () => {
  const { context, base, observer } = environment(), source = observer(), calls = [];
  const client = context.TidyDiagnosticsTransport.createClient({ runtime: { async sendMessage(message) {
    calls.push(plain(message)); return { ok: true, persisted: true, accepted: message.events.length, generation: "a".repeat(32) };
  } } });
  const oldDetach = client.attach(source); await turn(); oldDetach();
  client.attach(source); oldDetach(); source.emit(base); await turn();
  assert.equal(calls.filter(message => message.events.length).length, 1);
});


test("copy during a slow diagnostics send reports incomplete instead of a false empty result", async () => {
  const { context, base, observer, snapshot } = environment(), source = observer(), slow = deferred();
  const client = context.TidyDiagnosticsTransport.createClient({ runtime: { sendMessage(message) {
    return message.operation === "read" ? Promise.resolve({ ok: true, snapshot: snapshot() }) : slow.promise;
  } } });
  client.attach(source); source.emit(base); await turn();
  const report = await client.exportText();
  assert.equal(report.eventCount, 0); assert.equal(report.incomplete, true);
  assert.equal(JSON.parse(report.text).client.pending, 1);
  let copied = "";
  const ui = viewHarness(client, async text => { copied = text; });
  ui.copy.click(); await turn();
  assert.equal(ui.status.textContent, "diagnosticsCopied · diagnosticsIncomplete");
  assert.equal(JSON.parse(copied).incomplete, true);
  client.dispose(); slow.resolve({ ok: true, persisted: true, accepted: 0, generation: "a".repeat(32) }); await turn();
});
test("capacity and transport-loss evidence mark exports incomplete; intentional clears do not imply loss", async () => {
  const { context, snapshot } = environment();
  let saved = snapshot(); saved.dropped.capacity = 1;
  const client = context.TidyDiagnosticsTransport.createClient({ runtime: { async sendMessage() { return { ok: true, snapshot: saved }; } } });
  assert.equal((await client.exportText()).incomplete, true);
  saved = snapshot(); saved.queueDroppedEvents = 1;
  assert.equal((await client.exportText()).incomplete, true);
  saved = snapshot(); saved.dropped.staleGeneration = 5;
  assert.equal((await client.exportText()).incomplete, false);
});


test("attaching captures history before a snapshot-triggered clear without skipping older events", async () => {
  const { context, base } = environment(), calls = []; let sink;
  const latest = { ...base, eventId: 2, event: "clear", clearReasonCode: "OWNER_NODE_DETACHED" };
  const source = { setSink(next) { sink = next; return () => { sink = null; }; },
    snapshot() { sink(latest); return { events: [base, latest] }; } };
  const client = context.TidyDiagnosticsTransport.createClient({ runtime: { async sendMessage(message) {
    calls.push(plain(message)); return { ok: true, persisted: true, accepted: message.events.length, generation: "a".repeat(32) };
  } } });
  client.attach(source); await turn();
  assert.deepEqual(calls.flatMap(message => message.events.map(event => event.sequence)), [1, 2]);
});
