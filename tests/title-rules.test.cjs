const assert = require("node:assert/strict");
const vm = require("node:vm");
const test = require("node:test");
const { loadRulesModules, installRulesRuntime } = require("./helpers/title-rules.cjs");
const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const key = "tidy.titles.rules.v1";
const initial = { mode: "range", dateFormat: "iso" };
function moduleContext() { return loadRulesModules(vm.createContext({})); }
function harness({ stored = initial, read, write } = {}) {
  const module = moduleContext(), observers = new Set(), patches = [], commits = [];
  let value = stored && { ...stored };
  const store = module.createTitleRulesStore({ defaults: async () => ({ dateFormat: "iso" }), storage: {
    get: async received => { assert.equal(received, key); if (read) await read(); return { [key]: value && { ...value } }; },
    set: async entries => {
      if (write) await write(entries[key]);
      value = plain(entries[key]); commits.push(value);
      for (const listener of observers) listener({ ...value });
    },
  } });
  function panel(options = {}) {
    return module.createTitleRulesController({ read: store.read,
      write: patch => { patches.push(plain(patch)); return store.update(patch); },
      listen: listener => { observers.add(listener); return () => observers.delete(listener); }, ...options });
  }
  return { module, store, panel, observers, patches, commits, value: () => value };
}

test("default controller uses worker protocol, and missing Chrome cannot pretend persistence succeeded", async () => {
  const m = moduleContext(), controller = m.getTitleRulesController();
  assert.equal(controller, m.getTitleRulesController());
  assert.deepEqual(plain(controller.snapshot()), { rules: { mode: "created", dateFormat: "locale" }, ready: false, revision: 0, error: null, saving: false });
  await controller.initialize();
  assert.equal(controller.snapshot().error, "load"); assert.equal(await controller.whenSaved(), false);
  controller.update({ dateFormat: "dot" });
  assert.equal(controller.snapshot().rules.dateFormat, "dot", "immediate local preview still works");
  assert.equal(await controller.whenSaved(), false);
  assert.equal(controller.snapshot().error, "unconfirmed"); assert.equal(controller.snapshot().rules.dateFormat, "locale");

  const live = vm.createContext({}); installRulesRuntime(live, { dateFormat: "iso" });
  const client = live.getTitleRulesController(); await client.initialize();
  client.update({ dateFormat: "dot" }); assert.equal(await client.whenSaved(), true);
  assert.equal(client.snapshot().rules.dateFormat, "dot");
});

test("shared normalization is pure and excludes titles, IDs and dates", () => {
  const m = moduleContext(), input = { mode: "created", dateFormat: "slash", title: "private", conversationId: "id", rangeStyle: "full" };
  assert.deepEqual(plain(m.normalizeTitleRules(input)), { mode: "created", dateFormat: "slash" });
  assert.equal(input.title, "private");
  assert.deepEqual(plain(m.normalizeTitleRules({ mode: "bad", dateFormat: "bad" }, { conversationTimeMode: "created", dateFormat: "compact" })), { mode: "created", dateFormat: "compact" });
  assert.deepEqual(plain(m.titleRulesPatch({ mode: "bad", dateFormat: "dot", title: "private" })), { dateFormat: "dot" });
});

test("title mode defaults to creation independently of display settings and keeps saved choices", () => {
  const m = moduleContext();
  for (const conversationTimeMode of [undefined, "created", "updated", "range", "invalid"]) {
    const preferences = { conversationTimeMode, dateFormat: "dot" };
    for (const value of [undefined, null, {}, { mode: "bad" }, { dateFormat: "slash" }]) {
      assert.deepEqual(plain(m.normalizeTitleRules(value, preferences)), {
        mode: "created", dateFormat: value?.dateFormat || "dot",
      });
    }
    for (const mode of ["created", "range"]) {
      assert.deepEqual(plain(m.normalizeTitleRules({ mode, dateFormat: "compact" }, preferences)), { mode, dateFormat: "compact" });
    }
  }
  assert.deepEqual(plain(m.normalizeTitleRules(null)), { mode: "created", dateFormat: "locale" });
});

test("a fresh controller and worker agree on creation without persisting defaults", async () => {
  const h = harness({ stored: null }), c = h.panel();
  assert.equal(c.snapshot().rules.mode, "created");
  const loading = c.initialize({ conversationTimeMode: "range", dateFormat: "iso" });
  assert.equal(c.snapshot().rules.mode, "created", "initial paint must not briefly inherit range");
  await loading;
  assert.deepEqual(plain(c.snapshot().rules), { mode: "created", dateFormat: "iso" });
  assert.deepEqual(h.commits, []); assert.deepEqual(h.patches, []);
  c.update({ mode: "range" }); await c.whenSaved();
  const reopened = h.panel(); await reopened.initialize({ conversationTimeMode: "created" });
  assert.equal(reopened.snapshot().rules.mode, "range", "explicit saved choice survives reopening");
  c.dispose(); reopened.dispose();
});

test("initial load is shared; later global defaults do not replace saved title preferences", async () => {
  const d = deferred(); let reads = 0;
  const h = harness(), c = h.panel({ read: async () => { reads++; return d.promise; } });
  const first = c.initialize({ dateFormat: "dot" });
  assert.equal(c.initialize({ dateFormat: "compact" }), first);
  await flush(); assert.equal(reads, 1);
  d.resolve({ mode: "created", dateFormat: "slash" }); await first;
  await c.initialize({ dateFormat: "dot" }); assert.equal(reads, 1);
  assert.equal(c.snapshot().rules.dateFormat, "slash");
  c.update({ dateFormat: "compact" });
  const later = await c.initialize(); assert.equal(later, c.snapshot());
  assert.equal(later.rules.dateFormat, "compact"); await c.whenSaved();
});

test("immutable synchronous publication keeps no-op, duplicate notifications and released listeners quiet", async () => {
  const h = harness(), c = h.panel(); await c.initialize();
  const seen = [], before = c.snapshot();
  c.subscribe(() => { throw new Error("released child"); });
  const unsubscribe = c.subscribe(next => seen.push(next));
  c.update({ dateFormat: "dot", title: "never store" });
  assert.equal(seen.length, 1); assert.equal(seen[0], c.snapshot());
  assert.ok(Object.isFrozen(seen[0]) && Object.isFrozen(seen[0].rules));
  assert.equal(before.rules.dateFormat, "iso"); assert.equal(seen[0].rules.dateFormat, "dot");
  c.update({ mode: "invalid", dateFormat: "dot" }); assert.equal(seen.length, 1);
  await c.whenSaved();
  const count = seen.length;
  for (const listener of h.observers) listener(h.value());
  assert.equal(seen.length, count);
  unsubscribe(); unsubscribe(); c.update({ mode: "created" }); await c.whenSaved();
  assert.equal(seen.length, count);
});

test("late read fills only untouched fields; UI writes a patch, not the merged snapshot", async () => {
  const d = deferred(), h = harness({ stored: { mode: "created", dateFormat: "slash" } });
  const c = h.panel({ read: () => d.promise }), loading = c.initialize({ dateFormat: "iso" });
  c.update({ dateFormat: "dot" }); await flush(); assert.deepEqual(h.patches, []);
  d.resolve({ mode: "created", dateFormat: "slash" }); await loading; await c.whenSaved();
  assert.deepEqual(h.patches, [{ dateFormat: "dot" }]);
  assert.deepEqual(plain(c.snapshot().rules), { mode: "created", dateFormat: "dot" });
});

test("an explicit same-as-seed edit and a reentrant first edit survive initialization", async () => {
  const h = harness({ stored: { mode: "created", dateFormat: "slash" } }), c = h.panel();
  c.subscribe(next => { if (!next.ready && next.rules.dateFormat === "iso") c.update({ mode: "range", dateFormat: "dot" }); });
  await c.initialize({ dateFormat: "iso" }); await c.whenSaved();
  assert.deepEqual(h.value(), { mode: "range", dateFormat: "dot" });
  assert.equal(h.patches.length, 1);
});

test("F1: two stale panels edit different fields concurrently without overwriting each other", async () => {
  const held = deferred(); let writes = 0;
  const h = harness({ write: async () => { if (++writes === 1) await held.promise; } });
  const a = h.panel(), b = h.panel(); await Promise.all([a.initialize(), b.initialize()]);
  a.update({ dateFormat: "dot" }); b.update({ mode: "created" });
  assert.equal(a.snapshot().rules.dateFormat, "dot"); assert.equal(b.snapshot().rules.mode, "created");
  await flush(); held.resolve(); await Promise.all([a.whenSaved(), b.whenSaved()]);
  const expected = { mode: "created", dateFormat: "dot" };
  assert.deepEqual(h.value(), expected); assert.deepEqual(plain(a.snapshot().rules), expected); assert.deepEqual(plain(b.snapshot().rules), expected);
  assert.deepEqual(h.patches, [{ dateFormat: "dot" }, { mode: "created" }]);
  const c = h.panel(); await c.initialize(); assert.deepEqual(plain(c.snapshot().rules), expected);
});

test("same-field updates follow worker arrival order; an old receipt cannot undo a newer notification", async () => {
  const h = harness(), delay = deferred();
  const a = h.panel({ write: async patch => { const old = await h.store.update(patch); await delay.promise; return old; } }), b = h.panel();
  await Promise.all([a.initialize(), b.initialize()]);
  a.update({ dateFormat: "dot" }); await flush();
  b.update({ dateFormat: "compact" }); await b.whenSaved();
  delay.resolve(); await a.whenSaved();
  assert.equal(a.snapshot().rules.dateFormat, "compact"); assert.equal(b.snapshot().rules.dateFormat, "compact");
});

test("late initial reads cannot overwrite a more recent storage notification", async () => {
  const h = harness(), delay = deferred(), c = h.panel({ read: () => delay.promise });
  const loading = c.initialize(); await h.store.update({ dateFormat: "compact" });
  delay.resolve(initial); await loading;
  assert.equal(c.snapshot().rules.dateFormat, "compact");
});

test("F2: failed save rolls back only that choice, preserves later edits, and reports failure", async () => {
  const fail = deferred(); let writes = 0;
  const h = harness({ write: async () => { if (++writes === 1) await fail.promise; } }), c = h.panel();
  await c.initialize(); c.update({ dateFormat: "dot" }); c.update({ mode: "created" });
  await flush(); fail.reject(new Error("quota"));
  assert.equal(await c.whenSaved(), false);
  assert.deepEqual(h.value(), { mode: "created", dateFormat: "iso" });
  assert.deepEqual(plain(c.snapshot().rules), h.value()); assert.equal(c.snapshot().error, "save");
  c.update({ dateFormat: "dot" }); assert.equal(await c.whenSaved(), true);
  assert.deepEqual(h.value(), { mode: "created", dateFormat: "dot" }); assert.equal(c.snapshot().error, null);
});

test("failure readback preserves other windows' confirmed changes and local newer choices", async () => {
  const h = harness(), held = deferred(); let attempts = 0;
  const a = h.panel({ write: async patch => { if (++attempts === 1) return held.promise; return h.store.update(patch); } }), b = h.panel();
  await Promise.all([a.initialize(), b.initialize()]);
  a.update({ dateFormat: "dot" }); a.update({ dateFormat: "slash" });
  b.update({ mode: "created" }); await b.whenSaved(); held.reject(new Error("unavailable")); await a.whenSaved();
  assert.deepEqual(plain(a.snapshot().rules), { mode: "created", dateFormat: "slash" });
  assert.deepEqual(h.value(), plain(a.snapshot().rules));
});

test("a lost write receipt confirmed by readback is not reported as a failed save or replayed", async () => {
  const h = harness(), c = h.panel({ write: async patch => { await h.store.update(patch); throw new Error("Lost response"); } });
  await c.initialize(); c.update({ dateFormat: "compact" });
  assert.equal(await c.whenSaved(), true); assert.equal(c.snapshot().error, null);
  assert.equal(c.snapshot().rules.dateFormat, "compact"); assert.equal(h.commits.length, 1);
});

test("write and readback failure remains unconfirmed until explicit read-only retry", async () => {
  const h = harness(); let failRead = false;
  const c = h.panel({ read: async () => { if (failRead) throw new Error("Read failed"); return h.store.read(); },
    write: async () => { failRead = true; throw new Error("Disconnected"); } });
  await c.initialize(); c.update({ dateFormat: "compact" });
  assert.equal(await c.whenSaved(), false); assert.equal(c.snapshot().error, "unconfirmed");
  assert.equal(c.snapshot().rules.dateFormat, "iso");
  failRead = false; await c.retry(); assert.equal(c.snapshot().error, null); assert.deepEqual(h.commits, []);
});

test("read failure is visible, never auto-saves defaults or loops; explicit retry recovers", async () => {
  let broken = true, reads = 0;
  const h = harness({ stored: { mode: "created", dateFormat: "compact" }, read: async () => { reads++; if (broken) throw new Error("locked"); } }), c = h.panel();
  await c.initialize({ dateFormat: "dot" });
  assert.equal(c.snapshot().ready, true); assert.equal(c.snapshot().error, "load");
  assert.equal(await c.whenSaved(), false); assert.deepEqual(h.commits, []);
  await c.initialize(); await c.initialize(); assert.equal(reads, 1, "render updates are not retries");
  broken = false; await c.retry();
  assert.deepEqual(plain(c.snapshot().rules), { mode: "created", dateFormat: "compact" }); assert.equal(c.snapshot().error, null);
});

test("worker aborts on failed baseline read and remains usable after storage failures", async () => {
  let broken = true;
  const h = harness({ read: async () => { if (broken) throw new Error("failed read"); } });
  await assert.rejects(h.store.update({ mode: "created" }), /failed read/); assert.deepEqual(h.commits, []);
  broken = false; await h.store.update({ mode: "created" }); assert.deepEqual(h.value(), { mode: "created", dateFormat: "iso" });
});

test("a delayed retry response cannot erase a newer save failure", async () => {
  const h = harness(), delayed = deferred(); let reads = 0;
  const c = h.panel({ read: async () => {
    if (++reads === 1) throw new Error("Initial read failed");
    if (reads === 2) return delayed.promise;
    return h.store.read();
  }, write: async () => { throw new Error("Save failed"); } });
  await c.initialize({ dateFormat: "iso" });
  const retry = c.retry(); await flush();
  c.update({ dateFormat: "dot" }); await flush();
  assert.equal(c.snapshot().error, "save");
  delayed.resolve({ mode: "range", dateFormat: "slash" }); await retry;
  assert.equal(c.snapshot().error, "save"); assert.equal(c.snapshot().rules.dateFormat, "iso");
  assert.equal(await c.whenSaved(), false);
});

test("worker rejects invalid, empty and private-content patches before touching storage", async () => {
  let reads = 0;
  const h = harness({ read: async () => { reads++; } });
  for (const patch of [null, {}, [], { mode: "bad" }, { dateFormat: "dot", title: "private" }, { mode: "created", dateFormat: null }]) {
    await assert.rejects(h.store.update(patch), error => error.tidyCode === "VALIDATION_ERROR");
  }
  assert.equal(reads, 0); assert.deepEqual(h.commits, []);
});

test("store reads current global defaults only for missing title settings, not for saved choices", async () => {
  const m = moduleContext(); let defaults = 0;
  const store = m.createTitleRulesStore({ storage: { get: async () => ({ [key]: initial }) }, defaults: async () => { defaults++; throw new Error("unavailable"); } });
  assert.deepEqual(plain(await store.read()), initial); assert.equal(defaults, 0);
  const missing = m.createTitleRulesStore({ storage: { get: async () => ({}) }, defaults: async () => ({ conversationTimeMode: "range", dateFormat: "compact" }) });
  assert.deepEqual(plain(await missing.read()), { mode: "created", dateFormat: "compact" });
});

test("dispose releases the sole storage subscription and ignores late replies", async () => {
  const h = harness(), d = deferred(), c = h.panel({ read: () => d.promise });
  const loading = c.initialize(); c.dispose(); assert.equal(h.observers.size, 0);
  const before = c.snapshot(); d.resolve({ mode: "created", dateFormat: "dot" }); await loading;
  assert.equal(c.snapshot(), before); c.update({ mode: "created" }); assert.deepEqual(h.patches, []);
});

test("suspended startup is read/write silent and resume reads once without replaying edits", async () => {
  const h = harness(); let reads = 0;
  const c = h.panel({ read: async () => { reads++; return h.store.read(); } });
  c.suspend(); c.suspend();
  await c.initialize({ dateFormat: "dot" }); await c.retry();
  c.update({ mode: "created", dateFormat: "compact" });
  assert.equal(await c.whenSaved(), false);
  assert.equal(reads, 0); assert.deepEqual(h.patches, []);
  await Promise.all([c.resume(), c.resume()]);
  assert.equal(reads, 1); assert.deepEqual(h.patches, []);
  assert.deepEqual(plain(c.snapshot().rules), initial); assert.equal(c.snapshot().ready, true);
  c.dispose();
});

test("suspend cancels queued initialization work before its first read or write", async () => {
  const h = harness(); let reads = 0;
  const c = h.panel({ read: async () => { reads++; return h.store.read(); } });
  c.update({ dateFormat: "dot" }); c.update({ mode: "created" });
  c.suspend(); await flush();
  assert.equal(reads, 0); assert.deepEqual(h.patches, []);
  assert.equal(c.snapshot().saving, false); assert.equal(c.snapshot().ready, false);
  await c.resume();
  assert.equal(reads, 1); assert.deepEqual(h.patches, []);
  assert.deepEqual(plain(c.snapshot().rules), initial);
  c.dispose();
});

test("suspend preserves confirmed rules and ignores late initialization and storage notifications", async () => {
  const h = harness(), old = deferred(); let reads = 0;
  const c = h.panel({ read: () => ++reads === 2 ? old.promise : h.store.read() });
  await c.initialize(); const retry = c.retry(); await flush();
  c.suspend(); const stopped = c.snapshot();
  for (const listener of h.observers) listener({ mode: "created", dateFormat: "compact" });
  old.resolve({ mode: "created", dateFormat: "dot" }); await retry;
  assert.equal(c.snapshot(), stopped); assert.deepEqual(plain(stopped.rules), initial);
  const resuming = c.resume();
  assert.deepEqual(plain(c.snapshot().rules), initial, "resume must not flash default settings");
  await resuming; assert.deepEqual(plain(c.snapshot().rules), initial);
  c.dispose();
});

test("late successful save cannot shift a new session's queue or overwrite its confirmed values", async () => {
  const h = harness(), old = deferred(), fresh = deferred(); let attempts = 0, reads = 0;
  const c = h.panel({ read: async () => { reads++; return h.store.read(); },
    write: () => ++attempts === 1 ? old.promise : fresh.promise });
  await c.initialize();
  c.update({ dateFormat: "dot" }); c.update({ mode: "created" });
  const oldSaving = c.whenSaved();
  c.suspend();
  assert.equal(c.snapshot().saving, false); assert.deepEqual(plain(c.snapshot().rules), initial);
  await c.resume();
  c.update({ dateFormat: "slash" });
  old.resolve({ mode: "range", dateFormat: "dot" }); await flush();
  assert.equal(attempts, 2, "old queued mode update was discarded rather than replayed");
  assert.equal(reads, 2, "old receipt cannot initiate readback");
  assert.equal(c.snapshot().saving, true); assert.equal(c.snapshot().rules.dateFormat, "slash");
  assert.equal(await oldSaving, false);
  fresh.resolve({ mode: "range", dateFormat: "slash" });
  assert.equal(await c.whenSaved(), true); assert.equal(c.snapshot().saving, false);
  assert.deepEqual(plain(c.snapshot().rules), { mode: "range", dateFormat: "slash" });
  c.dispose();
});

for (const resumeBeforeFailure of [false, true]) test(`late save failure cannot retry readback after suspend (resumed=${resumeBeforeFailure})`, async () => {
  const h = harness(), old = deferred(); let reads = 0, writes = 0;
  const c = h.panel({ read: async () => { reads++; return h.store.read(); },
    write: () => { writes++; return old.promise; } });
  await c.initialize(); c.update({ dateFormat: "dot" }); c.update({ mode: "created" });
  c.suspend(); if (resumeBeforeFailure) await c.resume();
  const before = c.snapshot(), readsBefore = reads;
  old.reject(new Error("Page retired")); await flush();
  assert.equal(c.snapshot(), before); assert.equal(reads, readsBefore); assert.equal(writes, 1);
  assert.deepEqual(plain(c.snapshot().rules), initial); assert.equal(c.snapshot().error, null);
  c.dispose();
});

test("suspend invalidates a failure readback already in flight", async () => {
  const h = harness(), readback = deferred(); let reads = 0;
  const c = h.panel({ read: () => ++reads === 2 ? readback.promise : h.store.read(),
    write: async () => { throw new Error("Lost receipt"); } });
  await c.initialize(); c.update({ dateFormat: "dot" }); await flush();
  assert.equal(reads, 2);
  c.suspend(); await c.resume(); const resumed = c.snapshot();
  readback.reject(new Error("Old readback disconnected")); await flush();
  assert.equal(c.snapshot(), resumed); assert.equal(c.snapshot().error, null);
  assert.deepEqual(plain(c.snapshot().rules), initial);
  c.dispose();
});

test("dispose blocks initialize, retry, resume, queued writes and late failure recovery", async () => {
  const h = harness(), old = deferred(); let reads = 0, writes = 0;
  const c = h.panel({ read: async () => { reads++; return h.store.read(); },
    write: () => { writes++; return old.promise; } });
  await c.initialize(); c.update({ dateFormat: "dot" }); c.update({ mode: "created" });
  c.dispose(); c.dispose(); const before = c.snapshot();
  await c.initialize(); await c.retry(); await c.resume(); c.suspend(); c.update({ dateFormat: "slash" });
  old.reject(new Error("Disposed receiver")); await flush();
  assert.equal(reads, 1); assert.equal(writes, 1); assert.equal(h.observers.size, 0);
  assert.equal(c.snapshot(), before); assert.equal(await c.whenSaved(), false);
});

test("title rules transport retains worker failure code and details", async () => {
  const fs = require("node:fs"), path = require("node:path"), context = moduleContext();
  // Expose only this private transport in the fixture; production views receive
  // the panel's single guarded transport rather than bypassing page admission.
  const source = fs.readFileSync(path.join(__dirname, "../src/features/titles/ui/title-rules.js"), "utf8")
    .replace(/^import[^\n]+\n/gm, "").replace(/^export /gm, "");
  vm.runInContext(`(() => { ${source}\nglobalThis.requestTitleRules = requestRules; })();`, context);
  const details = { stage: "page-admission", status: "refresh-required" };
  context.chrome = { runtime: { sendMessage: async envelope => context.TidyProtocol.failure(envelope,
    "PAGE_REFRESH_REQUIRED", "Refresh this page", details) } };
  await assert.rejects(context.requestTitleRules(context.TidyProtocol.Type.TITLE_RULES_GET), error => {
    assert.equal(error.message, "Refresh this page"); assert.equal(error.tidyCode, "PAGE_REFRESH_REQUIRED");
    assert.equal(error.code, "PAGE_REFRESH_REQUIRED");
    assert.deepEqual(plain(error.details), details); return true;
  });
});
