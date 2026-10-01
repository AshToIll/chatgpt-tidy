const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const load = file => import(pathToFileURL(path.resolve(__dirname, "../src/app/sidepanel", file)));

test("one log footer belongs only to settings, outside its page-dependent form", async () => {
  const { SETTINGS_VIEW_TEMPLATE } = await import("../src/features/settings/ui/settings-template.js");
  const formEnd = SETTINGS_VIEW_TEMPLATE.indexOf("</form>");
  const footer = SETTINGS_VIEW_TEMPLATE.indexOf('id="settings-diagnostics"');
  assert.ok(formEnd >= 0 && footer > formEnd, "The log footer must not inherit the settings form gate");
  assert.equal(SETTINGS_VIEW_TEMPLATE.split('id="settings-diagnostics"').length, 2);
  const html = fs.readFileSync("src/app/sidepanel/index.html", "utf8");
  const panel = fs.readFileSync("src/app/sidepanel/panel.js", "utf8");
  assert.doesNotMatch(html, /connection-diagnostics/);
  assert.doesNotMatch(panel, /createDiagnosticsPlacement|diagnosticsPlacement/);
  assert.equal(fs.existsSync("src/app/sidepanel/diagnostics-placement.js"), false,
    "No retired movement owner or old-path compatibility wrapper remains");
  assert.match(panel, /elements\.settingsForm = document\.getElementById\("settings-form"\)/);
});

async function guardHarness() {
  const { installPanelLifecycle } = await load("panel-lifecycle.js");
  const handlers = new Map();
  const target = { hidden: false, addEventListener(type, fn) { handlers.set(type, fn); }, removeEventListener() {} };
  const noop = () => {};
  let route = "settings", ready = false;
  installPanelLifecycle({ document: target, window: { addEventListener: noop, removeEventListener: noop },
    isReady: () => ready, getRoute: () => route, getContextError: () => null, refreshContext: noop, dismissNotice: noop,
    session: { check: noop, dispose: noop }, navigation: { close: noop }, bookmarks: { cancel: noop, dispose: noop },
    search: { setVisible: noop }, library: { setVisible: noop, dispose: noop },
    titles: { render: noop, isBusy: () => false, suspend: noop, pauseCatalog: noop },
    preferences: { dispose: noop }, titleRules: { dispose: noop }, time: { becameVisible: noop, dispose: noop },
    settings: { dispose: noop }, backup: { dispose: noop },
    filing: { syncFavorites: noop, syncBookmarks: noop, closeFavorites: noop, closeBookmarks: noop },
  });
  return {
    route: value => { route = value; }, ready: value => { ready = value; },
    dispatch(type, { inside = true, log = false } = {}) {
      let prevented = 0, stopped = 0;
      const event = { target: { closest(selector) {
        if (selector === "[data-view], #time-display-control") return inside ? {} : null;
        if (selector === "#settings-view > #settings-diagnostics") return log ? {} : null;
        assert.fail("Unexpected guard selector: " + selector);
      } }, preventDefault() { prevented++; }, stopImmediatePropagation() { stopped++; } };
      handlers.get(type)(event);
      return { prevented, stopped };
    },
  };
}

test("disconnected settings log controls are exempt without admitting preferences or backup", async () => {
  const h = await guardHarness();
  for (const type of ["click", "change", "input", "keydown", "submit", "pointerdown"]) {
    assert.deepEqual(h.dispatch(type, { log: true }), { prevented: 0, stopped: 0 }, type + " on local log footer");
    assert.deepEqual(h.dispatch(type), { prevented: 1, stopped: 1 }, type + " on settings form or other business controls");
    assert.deepEqual(h.dispatch(type, { inside: false }), { prevented: 0, stopped: 0 }, type + " on navigation");
  }
});

test("only the currently selected settings footer receives the disconnect exception", async () => {
  const h = await guardHarness();
  for (const route of ["time", "titles", "favorites", "bookmarks", "search", "export"]) {
    h.route(route);
    assert.deepEqual(h.dispatch("click", { log: true }), { prevented: 1, stopped: 1 }, route);
  }
  h.route("settings");
  assert.deepEqual(h.dispatch("click", { log: false }), { prevented: 1, stopped: 1 },
    "A misplaced or unrelated element cannot borrow the footer exception");
  h.ready(true);
  assert.deepEqual(h.dispatch("change"), { prevented: 0, stopped: 0 }, "Ready business controls remain unchanged");
});
