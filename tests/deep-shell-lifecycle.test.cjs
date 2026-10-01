const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");
const modulePromise = import(pathToFileURL(path.resolve(__dirname, "../src/app/sidepanel/panel-lifecycle.js")).href);

function surface() {
  const listeners = [];
  return {
    hidden: false, listeners,
    addEventListener(type, handler, options) { listeners.push({ type, handler, options }); },
    removeEventListener(type, handler, options) {
      const index = listeners.findIndex(item => item.type === type && item.handler === handler && item.options === options);
      if (index >= 0) listeners.splice(index, 1);
    },
    emit(type, event = {}) {
      for (const item of [...listeners].filter(item => item.type === type)) {
        if (item.options?.once) this.removeEventListener(item.type, item.handler, item.options);
        item.handler(event);
      }
    },
  };
}

async function harness() {
  const { installPanelLifecycle } = await modulePromise;
  const h = { document: surface(), window: surface(), ready: true, route: "time",
    error: null, busy: false, calls: [], throwAt: null };
  const record = name => (...args) => {
    h.calls.push([name, ...args]);
    if (h.throwAt === name) throw new Error(name);
  };
  h.controller = installPanelLifecycle({
    document: h.document, window: h.window,
    isReady: () => h.ready, getRoute: () => h.route, getContextError: () => h.error,
    refreshContext: record("context.refresh"), dismissNotice: record("notice.dismiss"),
    session: { check: record("session.check"), dispose: record("session.dispose") },
    navigation: { close: record("navigation.close") },
    bookmarks: { cancel: record("bookmarks.cancel"), dispose: record("bookmarks.dispose") },
    search: { setVisible: record("search.visible") },
    library: { setVisible: record("library.visible"), dispose: record("library.dispose") },
    titles: { render: record("titles.render"), isBusy: () => h.busy,
      suspend: record("titles.suspend"), pauseCatalog: record("titles.pauseCatalog") },
    preferences: { dispose: record("preferences.dispose") },
    titleRules: { dispose: record("titleRules.dispose") },
    time: { becameVisible: record("time.visible"), dispose: record("time.dispose") },
    settings: { dispose: record("settings.dispose") },
    backup: { dispose: record("backup.dispose") },
    filing: { syncFavorites: record("filing.syncFavorites"), syncBookmarks: record("filing.syncBookmarks"),
      closeFavorites: record("filing.closeFavorites"), closeBookmarks: record("filing.closeBookmarks") },
  });
  return h;
}

function input(inBusinessControl = true) {
  return {
    prevented: 0, stopped: 0,
    target: { closest(selector) {
      assert.equal(selector, "[data-view], #time-display-control");
      return inBusinessControl ? {} : null;
    } },
    preventDefault() { this.prevented++; },
    stopImmediatePropagation() { this.stopped++; },
  };
}

test("six input guards are capture listeners and block only disconnected business controls", async () => {
  const h = await harness();
  const events = ["click", "change", "input", "keydown", "submit", "pointerdown"];
  assert.deepEqual(h.document.listeners.filter(item => item.options === true).map(item => item.type), events);
  h.ready = false;
  for (const type of events) {
    const blocked = input(); h.document.emit(type, blocked);
    assert.equal(blocked.prevented, 1); assert.equal(blocked.stopped, 1);
    const outside = input(false); h.document.emit(type, outside);
    assert.equal(outside.prevented, 0); assert.equal(outside.stopped, 0);
  }
  h.ready = true;
  const connected = input(); h.document.emit("click", connected);
  assert.equal(connected.prevented, 0); assert.equal(connected.stopped, 0);
  assert.deepEqual(h.calls, [], "guards cannot read, write, or acquire business ownership");
});

test("beforeunload prevents only ready and busy title ownership", async () => {
  const h = await harness();
  for (const [ready, route, busy, blocked] of [
    [true, "titles", true, true], [true, "titles", false, false],
    [false, "titles", true, false], [true, "favorites", true, false],
  ]) {
    h.ready = ready; h.route = route; h.busy = busy;
    const event = input(); h.window.emit("beforeunload", event);
    assert.equal(event.prevented, blocked ? 1 : 0);
    assert.equal(event.returnValue, blocked ? "" : undefined);
  }
  assert.deepEqual(h.calls, []);
});

test("hiding retains the exact navigation, library, bookmarks, search, title, filing order", async () => {
  const h = await harness();
  h.document.hidden = true;
  h.window.hidden = false;
  h.document.emit("visibilitychange");
  assert.deepEqual(h.calls, [
    ["navigation.close"], ["library.visible", false], ["bookmarks.cancel"],
    ["search.visible", false], ["titles.render"],
    ["filing.syncFavorites"], ["filing.syncBookmarks"],
  ]);
});

test("visible disconnected panel probes once after inactive modules and never refreshes business context", async () => {
  const h = await harness();
  h.ready = false; h.error = new Error("stale");
  h.document.emit("visibilitychange");
  assert.deepEqual(h.calls, [
    ["library.visible", false], ["search.visible", false], ["titles.render"],
    ["filing.syncFavorites"], ["filing.syncBookmarks"], ["session.check"],
  ]);
});

test("returning ready time panel refreshes labels before optional context reread", async () => {
  const h = await harness();
  h.error = new Error("stale");
  h.document.emit("visibilitychange");
  assert.deepEqual(h.calls, [
    ["library.visible", true], ["search.visible", true], ["titles.render"],
    ["filing.syncFavorites"], ["filing.syncBookmarks"], ["time.visible"], ["context.refresh"],
  ]);
});

test("returning to titles only renders its read-only recovery boundary, never auto-resumes a batch", async () => {
  const h = await harness();
  h.route = "titles"; h.busy = true;
  h.document.hidden = true; h.document.emit("visibilitychange");
  h.calls.length = 0;
  h.document.hidden = false; h.document.emit("visibilitychange");
  assert.deepEqual(h.calls, [
    ["library.visible", true], ["search.visible", true], ["titles.render"],
    ["filing.syncFavorites"], ["filing.syncBookmarks"],
  ]);
});

const disposedCalls = [
  ["notice.dismiss"], ["session.dispose"], ["preferences.dispose"], ["titleRules.dispose"],
  ["backup.dispose"], ["time.dispose"], ["settings.dispose"], ["navigation.close", "panel-closed"],
  ["bookmarks.dispose"], ["library.dispose"], ["search.visible", false], ["titles.suspend"],
  ["titles.pauseCatalog"], ["filing.closeFavorites"], ["filing.closeBookmarks"],
];

test("pagehide is once, keeps teardown order and removes all owned document listeners", async () => {
  const h = await harness();
  assert.equal(h.window.listeners.find(item => item.type === "pagehide").options.once, true);
  h.window.emit("pagehide");
  assert.deepEqual(h.calls, disposedCalls);
  assert.equal(h.document.listeners.length, 0); assert.equal(h.window.listeners.length, 0);
  h.window.emit("pagehide"); h.document.emit("visibilitychange"); h.controller.dispose();
  assert.deepEqual(h.calls, disposedCalls, "all later lifecycle paths are inert");
});

test("explicit dispose uses the same once-only teardown as pagehide", async () => {
  const h = await harness();
  h.controller.dispose(); h.controller.dispose(); h.window.emit("pagehide");
  assert.deepEqual(h.calls, disposedCalls);
});

test("view teardown failure still closes both filing contexts and cannot repeat destruction", async () => {
  for (const throwAt of ["search.visible", "titles.suspend", "titles.pauseCatalog"]) {
    const h = await harness(); h.throwAt = throwAt;
    assert.throws(() => h.window.emit("pagehide"), new RegExp(throwAt));
    assert.deepEqual(h.calls.slice(-2), [["filing.closeFavorites"], ["filing.closeBookmarks"]]);
    const count = h.calls.length;
    h.controller.dispose(); h.document.emit("visibilitychange");
    assert.equal(h.calls.length, count);
    assert.equal(h.document.listeners.length, 0); assert.equal(h.window.listeners.length, 0);
  }
});
