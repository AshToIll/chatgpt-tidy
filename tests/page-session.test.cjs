const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.resolve(__dirname, "../src/platform/session/shared/page-session.js"), "utf8");

function harness({ document = null, runtime = { id: "current-extension", sendMessage: async () => ({ ok: true }) }, watch = false } = {}) {
  const attributes = new Map();
  document ||= Object.assign(new EventTarget(), { documentElement: {
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: name => attributes.get(name) ?? null,
  } });
  const events = new EventTarget();
  const timers = new Set();
  const context = vm.createContext({ document, Event, AbortController,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    setInterval(fn) { timers.add(fn); return fn; },
    clearInterval(fn) { timers.delete(fn); },
  });
  vm.runInContext(source, context);
  const session = context.TidyPageSessionContract.create({ runtime, watch });
  const fire = (type, owned = false) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, "composedPath", { value: () => [{ hasAttribute: name => owned && name === "data-tidy-owned" }] });
    events.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { session, context, runtime, document, timers, fire };
}

test("runtime invalidation retires both realms synchronously and only once", () => {
  const isolated = harness();
  const main = harness({ document: isolated.document, runtime: null });
  const order = [];
  isolated.session.onDispose(() => { order.push("isolated"); assert.equal(isolated.session.check(), false); });
  main.session.onDispose(() => order.push("main"));
  isolated.runtime.id = undefined;
  assert.equal(isolated.session.check(), false);
  assert.equal(main.session.check(), false);
  assert.equal(main.session.signal.aborted, true);
  isolated.session.stop(); main.session.stop();
  assert.deepEqual(order, ["main", "isolated"]);
  assert.throws(() => isolated.session.assertActive(), error => error.details.disconnect === "context-invalidated");
});

test("a retired document cannot be reactivated by an old marker, callback or runtime id", () => {
  const h = harness(); h.session.stop();
  h.document.documentElement.setAttribute("data-tidy-page-session", "active");
  assert.equal(h.session.check(), false);
  let cleaned = 0; h.session.onDispose(() => cleaned++);
  assert.equal(cleaned, 1);
  const fresh = harness(); assert.equal(fresh.session.check(), true);
});

test("MAIN checks runtime synchronously before a continuation, without waiting for the watchdog", () => {
  const main = harness({ runtime: null });
  const isolated = harness({ document: main.document, watch: true });
  isolated.runtime.id = null;
  // No timer, pointer/focus event or explicit stop has run since invalidation.
  assert.throws(() => main.session.assertActive(), error => error.details.disconnect === "context-invalidated");
  assert.equal(isolated.session.signal.aborted, true);
  assert.equal(main.session.signal.aborted, true);
  assert.equal(isolated.timers.size, 0);
});

test("pending runtime request rejects on retirement and a late reply never revives it", async () => {
  let resolve, calls = 0;
  const h = harness({ runtime: { id: "extension", sendMessage() { calls++; return new Promise(done => { resolve = done; }); } } });
  const result = h.session.runtimeRequest({ type: "write" });
  h.session.stop();
  await assert.rejects(result, error => error.details.stage === "page-session");
  resolve({ ok: true });
  await assert.rejects(h.session.runtimeRequest({ type: "write-again" }));
  assert.equal(calls, 1);
});

test("ordinary worker connection errors are not terminal, explicit invalidation is", async () => {
  const h = harness();
  h.runtime.sendMessage = async () => { throw new Error("The message port closed before a response was received."); };
  await assert.rejects(h.session.runtimeRequest({}), /message port closed/);
  assert.equal(h.session.check(), true);
  h.runtime.sendMessage = () => { throw new Error("Extension context invalidated."); };
  await assert.rejects(h.session.runtimeRequest({}), error => error.details.disconnect === "context-invalidated");
  assert.equal(h.session.check(), false);
});

test("local invalidation watch never messages the worker and is cancelled on disposal", () => {
  let calls = 0;
  const h = harness({ runtime: { id: "extension", sendMessage() { calls++; } }, watch: true });
  assert.equal(h.timers.size, 1);
  [...h.timers][0](); assert.equal(calls, 0);
  h.runtime.id = null; [...h.timers][0]();
  assert.equal(h.timers.size, 0); assert.equal(calls, 0);
});

test("stale owned pointer/click is swallowed before removal; native interactions remain native", () => {
  const h = harness({ watch: true });
  assert.equal(h.fire("click", true), false);
  h.runtime.id = null;
  assert.equal(h.fire("pointerdown", true), true);
  assert.equal(h.fire("click", false), true, "same gesture cannot fall through after button removal");
  assert.equal(h.fire("pointerdown", false), false);
  assert.equal(h.fire("click", false), false);
  assert.equal(h.fire("keydown", true), true);
  assert.equal(h.fire("click", true), true);
});

test("one failing cleanup does not prevent other modules retiring", () => {
  const h = harness(); let cleaned = false;
  h.session.onDispose(() => { throw new Error("module failure"); });
  h.session.onDispose(() => { cleaned = true; });
  h.session.stop(); assert.equal(cleaned, true);
});
