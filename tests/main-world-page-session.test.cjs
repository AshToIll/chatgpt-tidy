const assert = require("node:assert/strict");
const test = require("node:test");
const { snapshotHarness } = require("./helpers/adapter-snapshot.cjs");

const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const make = options => snapshotHarness({ url: "https://chatgpt.com/", returnSession: true, ...options });

test("MAIN acknowledges a page session probe only while its complete document adapter is active", async () => {
  const h = make();
  const response = await h.requestTitle("PAGE_SESSION_PROBE", {});
  assert.equal(response.ok, true);
  assert.deepEqual(response.payload, { ready: true });
  assert.equal(h.listenerCount("message"), 1);
  h.session.stop();
  assert.equal(h.listenerCount("message"), 0);
  assert.equal(h.context.document.documentElement.dataset.tidyMainWorld, undefined);
});

test("retirement disconnects observers, cancels every MAIN timer and ignores already queued callbacks", () => {
  const h = make();
  // Project expansion owns a separate bounded settle timer, not just the
  // snapshot debounce. Both must be gone before cleanup mutates owned DOM.
  h.emit("click", { target: { closest: () => ({}) } });
  assert.ok(h.timers.size >= 2);
  const queued = [...h.timers.values()];
  const observed = [...h.observers];
  const posted = h.postedMessages().length;
  h.session.stop();
  assert.equal(h.timers.size, 0);
  assert.ok(observed.every(observer => !observer.connected));
  for (const callback of queued) callback();
  for (const observer of observed) observer.callback([{ target: {}, addedNodes: [], removedNodes: [] }]);
  for (const type of ["popstate", "hashchange", "focus", "click", "pageshow"]) h.emit(type, { persisted: true });
  assert.equal(h.timers.size, 0);
  assert.equal(h.postedMessages().length, posted);
  assert.equal(h.session.check(), false);
});

test("retirement restores only the history wrappers still owned by Tidy", () => {
  const h = make();
  assert.notEqual(h.context.history.pushState, h.nativeHistory.pushState);
  assert.notEqual(h.context.history.replaceState, h.nativeHistory.replaceState);
  h.session.stop();
  assert.equal(h.context.history.pushState, h.nativeHistory.pushState);
  assert.equal(h.context.history.replaceState, h.nativeHistory.replaceState);

  const layered = make();
  const tidyPush = layered.context.history.pushState;
  let nativeCalls = 0;
  const laterWrapper = function (...args) { nativeCalls++; return tidyPush.apply(this, args); };
  layered.context.history.pushState = laterWrapper;
  layered.session.stop();
  assert.equal(layered.context.history.pushState, laterWrapper);
  laterWrapper.call(layered.context.history, {}, "", "/c/ordinary");
  assert.equal(nativeCalls, 1);
  assert.equal(layered.timers.size, 0, "retired inner hook is only a native pass-through");
});

test("a title response arriving after retirement cannot project into native title or publish another snapshot", async () => {
  let resolve;
  const result = new Promise(done => { resolve = done; });
  const h = make({ titleAdapter: { readCurrent: () => result }, documentTitle: "Original - ChatGPT" });
  void h.requestTitle("TITLE_READ_CURRENT", { conversationId: "chat", before: "Original" });
  await flush();
  const posted = h.postedMessages().length;
  h.session.stop();
  resolve({ status: "verified", current: { conversationId: "chat", title: "Late" } });
  await flush();
  assert.equal(h.documentTitle(), "Original - ChatGPT");
  assert.equal(h.postedMessages().length, posted);
  assert.equal(h.timers.size, 0);
});

test("ordinary BFCache pause does not retire the extension session", () => {
  const h = make();
  h.emit("pagehide", { persisted: true });
  assert.equal(h.session.check(), true);
  h.emit("pageshow", { persisted: true });
  assert.equal(h.session.check(), true);
  assert.equal(h.listenerCount("message"), 1);
  h.session.stop();
});
