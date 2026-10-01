const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { loadRulesModules } = require("./helpers/title-rules.cjs");

const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const initial = { mode: "range", dateFormat: "iso" };
const requestId = "req-1234567890123-abc";
const failure = (code = "STORAGE_ERROR", id = requestId) => Object.assign(new Error("private title content"), {
  code, requestId: id, details: { title: "private title content", conversationId: "private-conversation" },
});
function harness({ read, write, diagnostics = true } = {}) {
  const context = vm.createContext({});
  if (diagnostics) {
    context.ChatGPTTidyBuildInfo = { reasonCodes: ["STORAGE_ERROR", "NETWORK", "TITLE_INVALID_RESPONSE", "OBSERVATION_ONLY_UNSPECIFIED"] };
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/messages/notice-lifecycle.js"), "utf8"), context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/messages/diagnostics.js"), "utf8"), context);
  }
  loadRulesModules(context);
  let stored = { ...initial }, reads = 0;
  const patches = [];
  const controller = context.createTitleRulesController({
    listen: () => () => {},
    read: async () => { reads++; if (read) await read(reads); return { ...stored }; },
    write: async patch => {
      patches.push(plain(patch));
      if (write) await write(patches.length);
      stored = { ...stored, ...patch };
      return { ...stored };
    },
  });
  return { controller, context, patches, value: () => stored, reads: () => reads };
}

test("a later confirmed same-field save clears an earlier queued failure", async () => {
  const first = deferred(), h = harness({ write: async attempt => { if (attempt === 1) await first.promise; } });
  const c = h.controller; await c.initialize();
  c.update({ dateFormat: "dot" }); c.update({ dateFormat: "compact" });
  first.reject(failure());
  assert.equal(await c.whenSaved(), true);
  assert.deepEqual(h.value(), { mode: "range", dateFormat: "compact" });
  assert.deepEqual(plain(c.snapshot().rules), h.value());
  assert.equal(c.snapshot().error, null); assert.equal(c.snapshot().saving, false);
  assert.deepEqual(h.patches, [{ dateFormat: "dot" }, { dateFormat: "compact" }]);
});

test("a new edit and success on a different field do not dismiss a failed field", async () => {
  const next = deferred(), h = harness({ write: async attempt => {
    if (attempt === 1) throw failure();
    if (attempt === 2) await next.promise;
  } });
  const c = h.controller; await c.initialize();
  c.update({ dateFormat: "dot" }); assert.equal(await c.whenSaved(), false);
  const failed = c.snapshot().errorCause;
  c.update({ mode: "created" });
  assert.equal(c.snapshot().error, "save", "starting another field is not confirmation");
  next.resolve(); assert.equal(await c.whenSaved(), false);
  assert.equal(c.snapshot().error, "save"); assert.deepEqual(c.snapshot().errorCause, failed);
  c.update({ dateFormat: "compact" }); assert.equal(await c.whenSaved(), true);
  assert.equal(c.snapshot().error, null);
});

test("partially replacing a failed multi-field operation preserves its other failed field", async () => {
  const h = harness({ write: async attempt => { if (attempt === 1) throw failure(); } });
  const c = h.controller; await c.initialize();
  c.update({ mode: "created", dateFormat: "dot" }); assert.equal(await c.whenSaved(), false);
  c.update({ dateFormat: "compact" }); assert.equal(await c.whenSaved(), false);
  assert.equal(c.snapshot().error, "save");
  assert.deepEqual(h.value(), { mode: "range", dateFormat: "compact" });
  c.update({ mode: "created" }); assert.equal(await c.whenSaved(), true);
  assert.equal(c.snapshot().error, null);
});

test("an unknown save survives later same-field success until explicit read-only checking", async () => {
  let unreadable = false;
  const h = harness({ read: async () => { if (unreadable) throw failure("NETWORK", "req-1234567890124-def"); },
    write: async attempt => { if (attempt === 1) { unreadable = true; throw failure(); } } });
  const c = h.controller; await c.initialize();
  c.update({ dateFormat: "dot" }); assert.equal(await c.whenSaved(), false);
  assert.equal(c.snapshot().error, "unconfirmed");
  unreadable = false; c.update({ dateFormat: "compact" });
  assert.equal(c.snapshot().error, "unconfirmed", "an edit cannot assert that the old write was settled");
  assert.equal(await c.whenSaved(), false);
  assert.equal(c.snapshot().error, "unconfirmed");
  assert.deepEqual(h.patches, [{ dateFormat: "dot" }, { dateFormat: "compact" }], "unknown writes are never replayed");
  await c.retry(); assert.equal(c.snapshot().error, null);
  assert.equal(await c.whenSaved(), true); assert.equal(h.patches.length, 2);
});

test("read and save notices retain only allowlisted structured causes", async () => {
  let unavailable = true;
  const h = harness({ read: async () => { if (unavailable) throw failure("NETWORK"); },
    write: async () => { throw failure(); } });
  const c = h.controller; await c.initialize();
  assert.equal(c.snapshot().error, "load");
  assert.equal(c.snapshot().errorCause.reasonCode, "NETWORK");
  assert.equal(c.snapshot().errorCause.requestId, requestId);
  assert.ok(Object.isFrozen(c.snapshot().errorCause));
  assert.equal(JSON.stringify(c.snapshot()).includes("private"), false);
  unavailable = false; await c.retry();
  c.update({ dateFormat: "dot" }); await c.whenSaved();
  assert.equal(c.snapshot().error, "save");
  assert.equal(c.snapshot().errorCause.reasonCode, "STORAGE_ERROR");
  assert.equal(c.snapshot().errorCause.requestId, requestId);
  assert.equal(JSON.stringify(c.snapshot()).includes("private"), false);
});

test("worker transport attaches its generated request id to safe notice causes", async () => {
  const h = harness(), { context } = h;
  let sent;
  context.chrome = { runtime: { sendMessage: async envelope => {
    sent = envelope;
    return context.TidyProtocol.failure(envelope, "STORAGE_ERROR", "private title content", { title: "private title content" });
  } } };
  const c = context.createTitleRulesController({ listen: () => () => {} });
  await c.initialize();
  assert.equal(c.snapshot().error, "load");
  assert.equal(c.snapshot().errorCause.reasonCode, "STORAGE_ERROR");
  assert.equal(c.snapshot().errorCause.requestId, sent.requestId);
  assert.equal(JSON.stringify(c.snapshot()).includes("private"), false);
});

test("failed explicit checking updates the recovery cause without replacing the unknown write cause", async () => {
  const firstReadId = "req-1234567890124-abc", retryReadId = "req-1234567890125-def";
  const h = harness({
    read: async attempt => {
      if (attempt === 2) throw failure("NETWORK", firstReadId);
      if (attempt === 3) throw failure("STORAGE_ERROR", retryReadId);
    },
    write: async () => { throw failure("NETWORK"); },
  });
  const c = h.controller; await c.initialize();
  c.update({ dateFormat: "dot" }); assert.equal(await c.whenSaved(), false);
  const originalCause = c.snapshot().errorCause;
  assert.equal(originalCause.requestId, requestId);
  assert.equal(c.snapshot().errorRecoveryCause.requestId, firstReadId);
  await c.retry();
  assert.equal(c.snapshot().error, "unconfirmed");
  assert.equal(c.snapshot().errorCause, originalCause, "checking must retain the original write cause");
  assert.equal(c.snapshot().errorRecoveryCause.requestId, retryReadId);
  assert.equal(c.snapshot().errorRecoveryCause.reasonCode, "STORAGE_ERROR");
  assert.equal(await c.whenSaved(), false);
  assert.equal(JSON.stringify(c.snapshot()).includes("private"), false);
  assert.equal(h.patches.length, 1, "checking must not replay the unknown write");
});

function organizationHarness(h) {
  const sourceFile = "src/features/titles/ui/title-organization-view.js", surface = "titles.rules.status";
  const { context, controller } = h, handlers = {};
  const containers = Object.fromEntries(["current", "batch", "notice", "error", "retry"]
    .map(key => [key, { isConnected: true, hidden: false }]));
  const buttons = ["current", "batch"].map(mode => ({
    dataset: { titlesMode: mode }, attributes: {}, disabled: false,
    setAttribute(name, value) { this.attributes[name] = value; },
  }));
  const root = {
    innerHTML: "", querySelector: selector => containers[selector.includes("rules-")
      ? selector.match(/rules-(\w+)/)[1] : selector.includes("current") ? "current" : "batch"],
    querySelectorAll: () => buttons, addEventListener: (name, listener) => { handlers[name] = listener; },
    removeEventListener: name => { delete handlers[name]; }, contains: () => true,
  };
  Object.assign(context.ChatGPTTidyBuildInfo, {
    messageKeys: ["titlesSettingsSaveFailed", "titlesSettingsUnconfirmed", "titlesSettingsReadFailed"],
    sources: [sourceFile],
    reasonCodes: [...context.ChatGPTTidyBuildInfo.reasonCodes, "NOTICE_HIDDEN", "VIEW_DISPOSED", "NOTICE_REPLACED"],
  });
  context.ChatGPTTidyNoticeRegistry = { surfaces: [{ surface }] };
  context.createTitleView = context.createTitleBatchView = () => ({
    update() {}, canLeave: () => true, dispose() {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", sourceFile), "utf8")
    .replace(/^import[^\n]+\n/gm, "").replace(/^export /gm, ""), context, { filename: sourceFile });
  const view = context.createTitleOrganizationView({
    root, rulesController: controller, request: async () => {}, loadCatalog: async () => ({}),
  });
  return {
    view, containers,
    update: (active = true, translator = key => key) => view.update({ active, translator }),
    observed: () => context.ChatGPTTidyDiagnostics.snapshot().events.filter(event => event.surface === surface),
    activeCount: () => context.ChatGPTTidyDiagnostics.snapshot().activeCount,
  };
}

test("real rules save warning observes only visible presentation and clears on hide or resolution", async () => {
  const h = harness({ write: async attempt => { if (attempt === 1) throw failure(); } }), ui = organizationHarness(h);
  const c = h.controller; ui.update(false); await c.initialize();
  c.update({ dateFormat: "dot" }); await c.whenSaved();
  assert.equal(c.snapshot().error, "save"); assert.deepEqual(plain(ui.observed()), []);
  ui.update();
  const shown = ui.observed().at(-1);
  assert.ok(shown, "the actual rendered rules warning must be observed");
  assert.equal(ui.containers.notice.hidden, false);
  assert.equal(ui.containers.error.textContent, "titlesSettingsSaveFailed");
  assert.equal(shown.event, "show"); assert.equal(shown.messageKey, "titlesSettingsSaveFailed");
  assert.equal(shown.source, "src/features/titles/ui/title-organization-view.js");
  assert.equal(shown.reasonCode, "STORAGE_ERROR"); assert.equal(shown.requestId, requestId);
  ui.update(true, key => "translated:" + key);
  assert.equal(ui.observed().length, 1, "a language repaint is not a second presentation");
  ui.update(false);
  assert.equal(ui.containers.notice.hidden, true); assert.equal(ui.activeCount(), 0);
  assert.equal(ui.observed().at(-1).clearReasonCode, "NOTICE_HIDDEN");
  c.update({ dateFormat: "compact" }); await c.whenSaved();
  ui.update(); assert.equal(ui.observed().length, 2, "resolved hidden errors cannot reappear");
  assert.equal(ui.containers.notice.hidden, true);
});

test("real unknown rules warning reports only its visible primary cause and clears on disposal", async () => {
  const h = harness({
    read: async attempt => { if (attempt > 1) throw failure("STORAGE_ERROR", "req-1234567890125-def"); },
    write: async () => { throw failure("NETWORK"); },
  }), ui = organizationHarness(h);
  const c = h.controller; await c.initialize(); ui.update();
  c.update({ dateFormat: "dot" }); await c.whenSaved();
  const shown = ui.observed().at(-1);
  assert.ok(shown, "the visible unknown-write warning must be observed");
  assert.equal(shown.messageKey, "titlesSettingsUnconfirmed");
  assert.equal(shown.reasonCode, "NETWORK"); assert.equal(shown.requestId, requestId);
  assert.notEqual(shown.requestId, c.snapshot().errorRecoveryCause.requestId);
  await c.retry();
  assert.equal(ui.observed().length, 1, "a non-visible secondary read failure must not create another show");
  assert.equal(JSON.stringify(ui.observed()).includes("private"), false);
  ui.view.dispose();
  assert.equal(ui.activeCount(), 0); assert.equal(ui.observed().at(-1).clearReasonCode, "VIEW_DISPOSED");
  const disposedCount = ui.observed().length;
  await c.retry(); ui.update(); ui.view.dispose();
  assert.equal(ui.observed().length, disposedCount, "a disposed view has no late show or duplicate clear");
});

test("real rules load warning clears when the visible read-only retry succeeds", async () => {
  let broken = true;
  const h = harness({ read: async () => { if (broken) throw failure("NETWORK"); } }), ui = organizationHarness(h);
  const c = h.controller; ui.update(); await c.initialize();
  const shown = ui.observed().at(-1);
  assert.ok(shown, "the visible load warning must be observed");
  assert.equal(shown.messageKey, "titlesSettingsReadFailed");
  assert.equal(shown.reasonCode, "NETWORK"); assert.equal(shown.requestId, requestId);
  broken = false; await c.retry();
  assert.equal(ui.containers.notice.hidden, true); assert.equal(ui.activeCount(), 0);
  assert.equal(ui.observed().at(-1).event, "clear");
  assert.equal(ui.observed().at(-1).clearReasonCode, "NOTICE_HIDDEN");
  assert.equal(h.patches.length, 0);
});

test("a no-op save confirmation cannot invalidate a successful explicit unknown-write recovery read", async () => {
  const context = loadRulesModules(vm.createContext({})), writeGate = deferred(), readGate = deferred(), readStarted = deferred();
  let reads = 0, writes = 0, listener, stored = { ...initial };
  const c = context.createTitleRulesController({
    listen: value => { listener = value; return () => {}; },
    read: async () => {
      reads++;
      if (reads === 2) throw failure("NETWORK");
      if (reads === 3) { readStarted.resolve(); await readGate.promise; }
      return { ...stored };
    },
    write: async patch => {
      writes++;
      if (writes === 1) throw failure();
      stored = { ...stored, ...patch };
      listener({ ...stored }); // Storage reports the committed second edit before its transport reply.
      await writeGate.promise;
      return { ...stored };
    },
  });
  await c.initialize();
  c.update({ dateFormat: "dot" }); assert.equal(await c.whenSaved(), false);
  assert.equal(c.snapshot().error, "unconfirmed");
  c.update({ mode: "created" });
  const recovering = c.retry(); await readStarted.promise;
  writeGate.resolve();
  for (let tick = 0; tick < 3; tick++) await new Promise(setImmediate);
  assert.equal(c.snapshot().saving, false);
  assert.equal(c.snapshot().error, "unconfirmed", "the unrelated success does not itself settle the unknown write");
  readGate.resolve(); await recovering;
  assert.equal(c.snapshot().error, null, "a current successful explicit read must retain its recovery authority");
  assert.equal(await c.whenSaved(), true);
  assert.deepEqual(plain(c.snapshot().rules), stored);
  assert.equal(reads, 3); assert.equal(writes, 2, "recovery neither writes nor replays the unknown edit");
});

test("an older recovery read cannot clear a new field failure hidden behind an unknown write", async () => {
  const context = loadRulesModules(vm.createContext({})), readGate = deferred(), readStarted = deferred();
  let reads = 0, writes = 0;
  const c = context.createTitleRulesController({
    listen: () => () => {},
    read: async () => {
      reads++;
      if (reads === 2) throw failure("NETWORK");
      if (reads === 3) { readStarted.resolve(); await readGate.promise; }
      return { ...initial };
    },
    write: async () => { writes++; throw failure("STORAGE_ERROR", "req-123456789012" + writes + "-abc"); },
  });
  await c.initialize();
  c.update({ dateFormat: "dot" }); assert.equal(await c.whenSaved(), false);
  const unknownCause = c.snapshot().errorCause;
  const recovering = c.retry(); await readStarted.promise;
  c.update({ mode: "created" });
  for (let tick = 0; tick < 3; tick++) await new Promise(setImmediate);
  assert.equal(reads, 4); assert.equal(c.snapshot().saving, false);
  assert.equal(c.snapshot().error, "unconfirmed");
  assert.equal(c.snapshot().errorCause, unknownCause, "the new field failure is not the priority visible failure");
  readGate.resolve(); await recovering;
  assert.equal(c.snapshot().error, "unconfirmed", "the older recovery cannot erase newer failure evidence");
  assert.equal(await c.whenSaved(), false);
  assert.equal(reads, 4); assert.equal(writes, 2);
});
