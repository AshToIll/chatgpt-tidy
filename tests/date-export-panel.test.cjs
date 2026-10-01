const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createPanelRuntime } = require("./helpers/panel-runtime.cjs");

const panelSource = fs.readFileSync(path.resolve(__dirname, "../src/app/sidepanel/panel.js"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadPanel() {
  const calls = [];
  let selection = null;
  let selectedAccountKey = null;
  const rows = [{ conversationId: "date-a", matchKind: "conversation-date", accountKey: "workspace-a" }];
  const state = { route: "search", favorites: {}, bookmarks: {} };
  const record = (type, payload) => { calls.push({ type, payload }); };
  const context = vm.createContext({
    console, state,
    // Source-selection routing is tested after the independent page handshake.
    pageSession: { isReady: () => true },
    t: (key) => key,
    showToast: (message, error) => record("toast", { message, error }),
    showSearchToast: (message) => record("toast", { message, error: true }),
    renderAll: () => record("render"),
    refreshFavorites: () => record("favorites"),
    refreshBookmarks: () => record("bookmarks"),
    searchView: {
      prepareDateExport: () => { record("prepare-date"); return true; },
      exportItems: () => { record("export-items"); return rows; },
      setVisible: (visible) => record("visible", visible),
    },
    exportView: {
      beginSelection(source, returnTarget) {
        record("begin", { source, returnTarget });
        selection = { source, returnTarget }; selectedAccountKey = null; return true;
      },
      registerSearchResults(items) { record("register", plain(items)); selectedAccountKey ||= items[0]?.accountKey; return true; },
      selectionContext: () => selection,
      selectionState: () => ({ active: Boolean(selection), accountKey: selectedAccountKey }),
      cancelSelection: () => { record("cancel"); selection = null; selectedAccountKey = null; },
      toggleSelection: (source, id) => { record("toggle", { source, id }); return true; },
      selectSelectionRange: (source, ids) => { record("range", { source, ids }); return true; },
      submitSelection: (source) => { record("submit", source); return { context: selection }; },
      setMode: (mode) => record("mode", mode),
      setSettingsView: (view) => record("settings", view),
    },
  });
  const runtime = createPanelRuntime();
  const { createExportWorkflow } = runtime.load("src/app/sidepanel/export-workflow.js");
  assert.equal(typeof createExportWorkflow, "function", "load the real source-selection routing boundary");
  const workflow = createExportWorkflow({
    selection: context.exportView, isReady: () => true, readRoute: () => state.route,
    navigate(route) { state.route = route; },
    prepareDateExport: context.searchView.prepareDateExport, readSearchItems: context.searchView.exportItems,
    showSearchToast: context.showSearchToast,
    ensureSource(source) { if (source === "favorites") context.refreshFavorites(); if (source === "bookmarks") context.refreshBookmarks(); },
    setDestination({ mode, settings }) { context.exportView.setMode(mode); context.exportView.setSettingsView(settings); },
    onChanged: context.renderAll,
  });
  context.exportSourceRoute = workflow.sourceRoute;
  context.beginExportSource = workflow.begin;
  context.handleExportAction = workflow.handle;
  context.exportWorkflow = workflow;
  return { context, state, calls, rows };
}

function loadCloseAction(context, calls, nativeClose = true) {
  let close;
  Object.assign(context, {
    elements: { close: { addEventListener: (_event, handler) => { close = handler; } } },
    isReady: () => true,
    filing: { favorites: { close: () => calls.push({ type: "favorite-close" }) },
      bookmarks: { close: () => calls.push({ type: "bookmark-close" }) } },
    bookmarkNavigation: { cancel: () => calls.push({ type: "bookmark-navigation-cancel" }) },
    panelNavigation: { close() {} },
    chrome: { sidePanel: nativeClose ? { close: async (payload) => calls.push({ type: "native-close", payload }) } : {} },
    window: { close: () => calls.push({ type: "window-close" }), addEventListener() {} },
    panelOwnerTabId: 31,
    isValidTabId: (id) => id === 31,
  });
  const start = panelSource.indexOf('elements.close.addEventListener("click"');
  const end = panelSource.indexOf('document.addEventListener("click"', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(panelSource.slice(start, end), context);
  return close;
}

test("search export opens the date picker and rejects unknown source routing", () => {
  const { context, state, calls } = loadPanel();
  assert.equal(context.exportSourceRoute("search"), "search");
  assert.equal(context.exportSourceRoute("favorites"), "favorites");
  assert.equal(context.exportSourceRoute("bookmarks"), "bookmarks");
  assert.ok(!context.exportSourceRoute("unknown"), "unknown sources cannot silently target favorites");
  assert.equal(context.beginExportSource("search", "manage"), true);
  assert.equal(state.route, "search");
  assert.ok(calls.some((entry) => entry.type === "prepare-date"));
  assert.deepEqual(calls.find((entry) => entry.type === "begin").payload, { source: "search", returnTarget: "manage" });
  assert.equal(calls.some((entry) => ["toast", "favorites", "bookmarks"].includes(entry.type)), false);
  calls.length = 0;
  assert.equal(context.beginExportSource("unknown"), false);
  assert.equal(calls.some((entry) => entry.type === "begin"), false);
  context.handleExportAction("start", { source: "search" });
  assert.deepEqual(calls.find((entry) => entry.type === "begin").payload, { source: "search", returnTarget: "source" },
    "a normal date-search entry defaults to returning to date search");
});

test("panel renders the shared search selection model without changing search transport", () => {
  const selection = { active: true, draftIds: ["date-a"], returnTarget: "manage" };
  let rendered;
  const context = vm.createContext({
    state: { preferences: { language: "en", dateFormat: "iso", messageTimePrecision: "minute" } },
    searchView: { render: (model) => { rendered = model; } },
    exportSelection: { selectionState: (source) => { assert.equal(source, "search"); return selection; } },
    formatTimestamp: value => value,
    t: (key) => key,
    effectiveTimeZone: () => "UTC",
    timeFormat: { formatDateTime: (value) => value },
    LOCALES: { en: "en-US" },
  });
  const start = panelSource.indexOf("function renderSearch()");
  const end = panelSource.indexOf("function renderExport()", start);
  vm.runInContext(panelSource.slice(start, end), context);
  context.renderSearch();
  assert.equal(rendered.exportSelection, selection);
  assert.equal(rendered.timeZone, "UTC");
  assert.match(panelSource, /createSearchView\(\{[\s\S]*?onExportAction:\s*\(action, payload\) => exportWorkflow\.handle\(action, payload\)[\s\S]*?\}\)/);
});

test("search export registers the current rows before each draft operation", () => {
  const { context, calls, rows } = loadPanel();
  context.beginExportSource("search", "source");
  for (const [action, type, payload] of [
    ["toggle", "toggle", { id: "date-a" }],
    ["select-current", "range", { ids: ["date-a"] }],
    ["submit", "submit", {}],
  ]) {
    calls.length = 0;
    context.handleExportAction(action, { source: "search", ...payload });
    const register = calls.findIndex((entry) => entry.type === "register");
    assert.ok(register >= 0, `${action} registers date rows`);
    assert.ok(register < calls.findIndex((entry) => entry.type === type));
    assert.deepEqual(calls[register].payload, rows);
  }
  calls.length = 0;
  context.handleExportAction("toggle", { source: "favorites", id: "favorite-a" });
  assert.equal(calls.some((entry) => entry.type === "export-items" || entry.type === "register"), false,
    "existing source flows do not depend on search state");
});

test("search selection returns to the exact source, batch main, or manage origin", () => {
  for (const target of ["source", "batch-main", "manage"]) {
    for (const action of ["selection-back", "submit"]) {
      const { context, state, calls } = loadPanel();
      context.beginExportSource("search", target);
      calls.length = 0;
      context.handleExportAction(action, { source: "search" });
      assert.equal(state.route, target === "source" ? "search" : "export", `${target}: ${action}`);
      assert.equal(calls.find((entry) => entry.type === "settings").payload, target === "manage" ? "manage" : null);
      assert.equal(calls.some((entry) => entry.type === "submit"), action === "submit");
    }
  }
});

test("a search account change cancels the old draft and returns to its origin with feedback", () => {
  for (const target of ["source", "batch-main", "manage"]) {
    for (const action of ["toggle", "select-current", "submit"]) {
      const { context, state, calls, rows } = loadPanel();
      context.beginExportSource("search", target);
      context.handleExportAction("toggle", { source: "search", id: "date-a" });
      rows[0] = { ...rows[0], conversationId: "date-b", accountKey: "workspace-b" };
      calls.length = 0;
      assert.equal(context.handleExportAction(action, { source: "search", id: "date-b", ids: ["date-b"] }), false);
      assert.equal(state.route, target === "source" ? "search" : "export");
      assert.equal(context.exportView.selectionContext(), null);
      assert.equal(calls.some((entry) => ["register", "toggle", "range", "submit"].includes(entry.type)), false);
      assert.deepEqual(calls.find((entry) => entry.type === "toast").payload,
        { message: "searchExportAccountChanged", error: true });
      assert.equal(calls.find((entry) => entry.type === "settings").payload, target === "manage" ? "manage" : null);
    }
  }
});

test("closing a source picker cancels selection instead of closing the side panel", async () => {
  for (const source of ["search", "favorites", "bookmarks"]) {
    for (const target of ["source", "batch-main", "manage"]) {
      const { context, state, calls } = loadPanel();
      context.beginExportSource(source, target);
      const close = loadCloseAction(context, calls);
      calls.length = 0;
      await close();
      assert.equal(state.route, target === "source" ? source : "export");
      assert.equal(context.exportView.selectionContext(), null);
      assert.equal(calls.some((entry) => ["visible", "native-close", "window-close", "submit"].includes(entry.type)), false);
    }
  }
});

test("normal panel closing retains native closing and the existing window fallback", async () => {
  for (const nativeClose of [true, false]) {
    const { context, calls } = loadPanel();
    const close = loadCloseAction(context, calls, nativeClose);
    await close();
    assert.deepEqual(calls.find((entry) => entry.type === "visible").payload, false);
    assert.ok(calls.some((entry) => entry.type === "favorite-close"));
    assert.ok(calls.some((entry) => entry.type === "bookmark-close"));
    assert.ok(calls.some((entry) => entry.type === "bookmark-navigation-cancel"));
    assert.equal(calls.some((entry) => entry.type === "native-close"), nativeClose);
    assert.equal(calls.some((entry) => entry.type === "window-close"), !nativeClose);
  }
});
