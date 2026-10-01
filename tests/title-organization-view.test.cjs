const { installRulesRuntime } = require("./helpers/title-rules.cjs");
const { createPanelRuntime } = require("./helpers/panel-runtime.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
function harness({ rulesController } = {}) {
  const handlers = {}, containers = { current: {}, batch: {}, notice: {}, error: {}, retry: {} }, children = {}, options = {};
  const buttons = ["current", "batch"].map((mode) => ({ dataset: { titlesMode: mode }, disabled: false,
    attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, closest() { return this; } }));
  const root = { innerHTML: "", querySelector: (selector) => containers[selector.includes("rules-") ? selector.match(/rules-(\w+)/)[1] : selector.includes("current") ? "current" : "batch"],
    querySelectorAll: () => buttons, addEventListener: (name, handler) => { handlers[name] = handler; },
    removeEventListener: (name) => { delete handlers[name]; }, contains: (element) => buttons.includes(element) };
  const factory = (name) => (input) => {
    options[name] = input;
    children[name] = { busy: false, updates: [], disposed: false,
      update(next) { this.updates.push(next); }, canLeave() { return !this.busy; }, dispose() { this.disposed = true; } };
    return children[name];
  };
  const context = vm.createContext({ createTitleView: factory("current"), createTitleBatchView: factory("batch") });
  installRulesRuntime(context);
  vm.runInContext(fs.readFileSync("src/features/titles/ui/title-organization-view.js", "utf8").replace(/^import[^\n]+\n/gm, "").replace(/^export /gm, ""), context);
  const requests = [];
  const view = context.createTitleOrganizationView({ root, ownerTabId: 31, rulesController, loadCatalog: async () => ({}),
    request: async (action, payload) => { requests.push({ action, payload }); } });
  const update = (patch = {}) => view.update({ active: true, snapshot: { conversation: { conversationId: "owner" } }, translator: (key) => key, ...patch });
  const click = (mode) => handlers.click({ target: buttons.find((button) => button.dataset.titlesMode === mode) });
  return { view, update, click, children, options, requests, buttons, containers };
}

test("current and batch modes keep separate mounted views and exact owner-bound requests", async () => {
  const h = harness(); h.update();
  assert.equal(Object.hasOwn(h.options.current, "showTabs"), false, "no obsolete child tab option");
  assert.equal(h.children.current.updates.at(-1).active, true);
  h.click("batch");
  assert.equal(h.children.batch.updates.at(-1).active, true);
  assert.equal(h.children.current.updates.at(-1).active, false);
  await h.options.batch.request("batch-preview", { conversationIds: ["target"] });
  assert.equal(h.requests[0].payload.expectedConversationId, "owner");
  assert.equal(h.requests[0].payload.expectedTabId, 31);
  h.update({ snapshot: { conversation: { conversationId: "new-owner" } } });
  await h.options.batch.request("batch-step", { batchId: "old", expectedConversationId: "owner" });
  assert.equal(h.requests[1].payload.expectedConversationId, "owner", "never reroute an earlier operation to a newer snapshot");
  h.click("current"); h.click("batch");
  assert.equal(h.children.batch.disposed, false, "switching does not erase a retained receipt");
});

test("both mounted modes receive the same shared rules controller, including an explicit owner", () => {
  const defaultView = harness();
  assert.equal(defaultView.options.current.rulesController, defaultView.options.batch.rulesController);
  assert.equal(typeof defaultView.options.current.rulesController.initialize, "function");
  const rulesController = defaultView.options.current.rulesController;
  const injected = harness({ rulesController });
  assert.equal(injected.options.current.rulesController, rulesController);
  assert.equal(injected.options.batch.rulesController, rulesController);
  injected.update(); injected.click("batch"); injected.click("current");
  assert.equal(injected.options.current.rulesController, rulesController, "switching never replaces the preference owner");
});

test("batch write locks navigation then unlocks as soon as execution ends, without requiring a snapshot", () => {
  const h = harness(); h.update(); h.click("batch");
  h.children.batch.busy = true; h.options.batch.onBusyChange(true);
  assert.equal(h.buttons[0].disabled, true); assert.equal(h.view.canLeave(), false);
  h.click("current"); assert.equal(h.containers.current.hidden, true);
  h.children.batch.busy = false; h.options.batch.onBusyChange(false);
  assert.equal(h.buttons[0].disabled, false); h.click("current");
  assert.equal(h.containers.current.hidden, false);
  h.view.dispose(); assert.equal(h.children.batch.disposed, true);
});

test("production panel visibility deactivates Titles and wakes one readonly recovery on return", async () => {
  const panelSource = fs.readFileSync("src/app/sidepanel/panel.js", "utf8");
  // Only this stateless shell adapter is extracted. All event ordering,
  // readiness and teardown behavior executes the complete lifecycle module.
  const renderTitles = panelSource.match(/^function renderTitles\(\) \{[\s\S]*?(?=\r?\nfunction )/m);
  assert.ok(renderTitles, "panel.js must expose the actual renderTitles composition adapter");
  async function lifecycleHarness() {
    const handlers = {}, registrations = [], updates = [];
    const counts = { paused: 0, favoritesClosed: 0, bookmarksClosed: 0,
      libraryRevalidated: 0, libraryRevoked: 0, noticesDismissed: 0 };
    const target = () => ({
      addEventListener(name, fn, options) { handlers[name] = fn; registrations.push({ name, options }); },
      removeEventListener(name, fn) { if (handlers[name] === fn) delete handlers[name]; },
    });
    const runtime = createPanelRuntime({
      state: { route: "titles", snapshot: {}, preferences: {}, error: null }, t: key => key,
      titleView: { update: value => updates.push(value) },
      document: { hidden: false, ...target() }, window: target(),
    });
    const context = runtime.context;
    context.pageSession = runtime.load("src/platform/session/ui/page-session-controller.js").createPageSessionController({
      probe: async () => ({ ready: true, documentId: "document-a" }),
    });
    await context.pageSession.check();
    context.isReady = () => context.pageSession.isReady();
    context.readSnapshot = () => context.state.snapshot;
    vm.runInContext(renderTitles[0], context, { filename: "src/app/sidepanel/panel.js:renderTitles" });
    const lifecycle = runtime.load("src/app/sidepanel/panel-lifecycle.js").installPanelLifecycle({
      document: context.document, window: context.window,
      isReady: () => context.pageSession.isReady(), getRoute: () => context.state.route,
      getContextError: () => context.state.error, refreshContext() {},
      dismissNotice() { counts.noticesDismissed++; }, session: context.pageSession,
      navigation: { close() {} }, bookmarks: { cancel() {}, dispose() {} }, search: { setVisible() {} },
      library: { setVisible() {}, refresh() { counts.libraryRevalidated++; }, dispose() { counts.libraryRevoked++; } },
      titles: {
        render: context.renderTitles, isBusy: () => false,
        suspend: () => context.titleView.update({ snapshot: context.state.snapshot,
          preferences: context.state.preferences, translator: context.t, active: false }),
        pauseCatalog() { counts.paused++; },
      },
      preferences: { dispose() {} }, titleRules: { dispose() {} }, backup: { dispose() {} },
      time: { becameVisible() {}, dispose() {} }, settings: { dispose() {} },
      filing: { syncFavorites() {}, syncBookmarks() {},
        closeFavorites() { counts.favoritesClosed++; }, closeBookmarks() { counts.bookmarksClosed++; } },
    });
    return { handlers, registrations, updates, counts, context, lifecycle };
  }
  const h = await lifecycleHarness();
  h.context.document.hidden = true; h.handlers.visibilitychange();
  assert.equal(h.updates.at(-1).active, false);
  h.context.document.hidden = false; h.handlers.visibilitychange();
  assert.equal(h.updates.at(-1).active, true);
  assert.equal(h.updates.length, 2);
  assert.equal(h.counts.libraryRevalidated, 0, "visibility preserves the unchanged library identity without revalidation");
  h.context.state.route = "search"; h.handlers.visibilitychange();
  assert.equal(h.updates.at(-1).active, false, "visibility does not enter an unrelated module");
  const pagehide = h.handlers.pagehide;
  pagehide(); assert.equal(h.updates.at(-1).active, false); assert.equal(h.counts.paused, 1);
  assert.equal(h.counts.libraryRevoked, 1);
  assert.equal(h.counts.noticesDismissed, 1, "pagehide clears the notice and its expiry timer through the toast owner");
  assert.equal(h.counts.favoritesClosed, 1); assert.equal(h.counts.bookmarksClosed, 1);
  assert.equal(h.registrations.filter(value => value.name === "pagehide").length, 1, "one panel teardown boundary");
  assert.equal(h.registrations.find(value => value.name === "pagehide").options.once, true);
  pagehide(); h.lifecycle.dispose();
  assert.equal(h.counts.noticesDismissed, 1, "repeated teardown is idempotent");
  assert.equal(h.counts.favoritesClosed, 1); assert.equal(h.counts.bookmarksClosed, 1);
  assert.equal(h.handlers.visibilitychange, undefined, "disposed lifecycle releases its listeners");

  // A fresh owner proves exceptional teardown still releases filing leases;
  // invoking an already disposed owner cannot exercise this failure boundary.
  const failing = await lifecycleHarness();
  failing.context.titleView.update = () => { throw new Error("view teardown failed"); };
  assert.throws(() => failing.handlers.pagehide(), /view teardown failed/);
  assert.equal(failing.counts.favoritesClosed, 1); assert.equal(failing.counts.bookmarksClosed, 1);
  assert.equal(failing.counts.noticesDismissed, 1, "notice teardown still runs before a downstream view teardown fails");
});
