const assert = require("node:assert/strict");
const test = require("node:test");

const panelModule = import("../src/platform/navigation/background/panel-host.js");
const ownerModule = import("../src/platform/navigation/panel-owner.js");
const protocolModule = import("../src/platform/protocol.js");
const BASE = "chrome-extension://tidy-test/app/sidepanel/index.html";
const panelSender = tabId => ({ url: BASE + "?tidyTabId=" + tabId });

async function harness(overrides = {}) {
  const [{ createPanelHost }, { parsePanelOwnerTabId }] = await Promise.all([
    panelModule, ownerModule, protocolModule,
  ]);
  const protocol = globalThis.TidyProtocol;
  const options = [], messages = [], behavior = [], opened = [], queries = [];
  const favorites = { updates: [], clears: [],
    update(port, payload) { this.updates.push({ port, payload }); },
    clear(port) { this.clears.push(port); } };
  const bookmarks = { updates: [], clears: [],
    update(port, payload) { this.updates.push({ port, payload }); },
    clear(port) { this.clears.push(port); } };
  // No browser event surfaces exist in this fixture: construction must be inert.
  const chrome = {
    sidePanel: {
      setOptions: async value => { options.push(value); await overrides.configure?.(value); },
      setPanelBehavior: async value => { behavior.push(value); await overrides.behavior?.(value); },
      open: value => { opened.push(value); return overrides.open?.(value) || Promise.resolve(); },
    },
    tabs: { query: async value => { queries.push(value); return overrides.tabs || []; } },
    runtime: { sendMessage: async envelope => { messages.push(envelope); await overrides.send?.(envelope); } },
  };
  const binding = {
    isChatgptUrl: value => { try { return new URL(value).hostname === "chatgpt.com"; } catch { return false; } },
    isSidePanelDocumentUrl: value => {
      try {
        const url = new URL(value), expected = new URL(BASE);
        return url.protocol === expected.protocol && url.host === expected.host && url.pathname === expected.pathname;
      } catch { return false; }
    },
    panelOwnerTabId: value => parsePanelOwnerTabId(value, BASE),
  };
  const host = createPanelHost({ chrome, protocol, binding,
    favoriteFilingContexts: favorites, bookmarkFilingContexts: bookmarks });
  return { host, protocol, options, messages, behavior, opened, queries, favorites, bookmarks };
}

function createPort(name, sender) {
  const messages = [], disconnections = [];
  return { name, sender, disconnected: false,
    onMessage: { addListener: callback => messages.push(callback) },
    onDisconnect: { addListener: callback => disconnections.push(callback) },
    disconnect() { this.disconnected = true; },
    emit(envelope) { for (const callback of messages) callback(envelope); },
    close() { for (const callback of disconnections) callback(); },
    messages, disconnections };
}

test("panel host is inert until the composition root invokes its methods", async () => {
  const h = await harness();
  assert.deepEqual(Object.keys(h.host).sort(), [
    "acceptPort", "closeTab", "configure", "initialize", "open", "publishContext",
    "reportError", "requestRoute", "startBehavior", "takeRoute",
  ]);
  assert.deepEqual([h.options, h.messages, h.behavior, h.opened, h.queries], [[], [], [], [], []]);
});

test("configuration retains strict owners and disables non-ChatGPT tabs", async () => {
  const h = await harness();
  await h.host.configure(0, "https://chatgpt.com/c/test");
  await h.host.configure(51, "https://example.com/");
  for (const invalid of [-1, -0, 1.5, "51", null, NaN]) await h.host.configure(invalid, "https://chatgpt.com/");
  assert.deepEqual(h.options, [
    { tabId: 0, path: "app/sidepanel/index.html?tidyTabId=0", enabled: true },
    { tabId: 51, path: "app/sidepanel/index.html?tidyTabId=51", enabled: false },
  ]);
});

test("initialization configures existing ChatGPT tabs and reports independent failures", async t => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const h = await harness({ tabs: [{ id: 1, url: "https://chatgpt.com/" }, { id: 2, url: "https://chatgpt.com/" }],
    configure: value => { if (value.tabId === 1) throw new Error("permission denied"); } });
  await h.host.initialize();
  assert.deepEqual(h.behavior, [{ openPanelOnActionClick: true }]);
  assert.deepEqual(h.queries, [{ url: ["https://chatgpt.com/*"] }]);
  assert.equal(h.options.length, 2);
  assert.deepEqual(errors, [["TIDY side panel setup failed",
    { operation: "configure", tabId: 1, message: "permission denied" }]]);
});

test("behavior and initialization failures remain visible without rejecting browser listeners", async t => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const h = await harness({ behavior: () => { throw new Error("configuration unavailable"); } });
  await h.host.startBehavior();
  await h.host.initialize();
  assert.deepEqual(errors.map(args => args[1].operation), ["behavior", "initialize"]);
  assert.deepEqual(h.queries, []);
});

test("only the exact matching gone-tab error is ignored", async t => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const { host } = await harness();
  host.reportError(new Error("No tab with id: 5."), "updated", 5);
  host.reportError(new Error("No tab with id: 6."), "updated", 5);
  host.reportError(new Error("No tab with id: 5."), "initialize");
  host.reportError(new Error("permission denied"), "updated", 5);
  assert.equal(errors.length, 3);
});

test("open invokes the browser immediately and returns its original promise", async () => {
  const original = Promise.resolve("opened");
  const h = await harness({ open: () => original });
  const returned = h.host.open(6);
  assert.deepEqual(h.opened, [{ tabId: 6 }]);
  assert.equal(returned, original);
});

test("context publication filters URLs, preserves optional document ownership and tolerates closed panels", async () => {
  const h = await harness({ send: () => { throw new Error("no receiver"); } });
  h.host.publishContext({ tabId: 6, url: "https://example.com/", documentId: "wrong" }, "ignored");
  h.host.publishContext({ tabId: 6, url: "https://chatgpt.com/c/a", documentId: "doc" }, "spa-route");
  h.host.publishContext({ tabId: 6, url: "https://chatgpt.com/c/b", documentId: 5 }, "document-committed");
  await Promise.resolve();
  assert.deepEqual(h.messages.map(message => ({ type: message.type, payload: message.payload })), [
    { type: h.protocol.Type.CONTEXT_CHANGED,
      payload: { reason: "spa-route", tabId: 6, url: "https://chatgpt.com/c/a", documentId: "doc" } },
    { type: h.protocol.Type.CONTEXT_CHANGED,
      payload: { reason: "document-committed", tabId: 6, url: "https://chatgpt.com/c/b" } },
  ]);
});

test("routes remain tab-scoped, replace older requests and are consumed only by panels", async t => {
  t.mock.method(Date, "now", () => 10_000);
  const h = await harness({ send: () => { throw new Error("no receiver"); } });
  const old = { route: "bookmarks", createdAt: 5_000, tabId: 6 };
  const route = { route: "bookmarks", createdAt: 9_000, tabId: 6, accountKey: "account", conversationId: "new" };
  h.host.requestRoute(old);
  h.host.requestRoute(route);
  assert.equal(h.messages.at(-1).type, h.protocol.Type.PANEL_ROUTE_REQUESTED);
  assert.equal(h.messages.at(-1).payload, route);
  assert.equal(h.host.takeRoute(7, panelSender(7)), null);
  assert.equal(h.host.takeRoute(6, { url: "https://chatgpt.com/c/new" }), route);
  assert.equal(h.host.takeRoute(6, undefined), route);
  assert.equal(h.host.takeRoute(6, panelSender(6)), route);
  assert.equal(h.host.takeRoute(6, panelSender(6)), null);
  await Promise.resolve();
});

test("the route lifetime is strictly less than 60 seconds and tab closure revokes it", async t => {
  let now = 60_999;
  t.mock.method(Date, "now", () => now);
  const { host } = await harness();
  const route = { route: "bookmarks", createdAt: 1_000, tabId: 6 };
  host.requestRoute(route);
  assert.equal(host.takeRoute(6, {}), route);
  now = 61_000;
  assert.equal(host.takeRoute(6, panelSender(6)), null);
  host.requestRoute({ ...route, createdAt: now });
  host.closeTab(6);
  assert.equal(host.takeRoute(6, panelSender(6)), null);
});

test("only recognized filing ports with a strict Side Panel owner are accepted", async () => {
  const h = await harness();
  const unrelated = createPort("other", { url: "https://chatgpt.com/" });
  h.host.acceptPort(unrelated);
  assert.equal(unrelated.disconnected, false);
  assert.equal(unrelated.messages.length, 0);
  for (const sender of [
    undefined, { url: "https://chatgpt.com/" }, { url: BASE }, { url: BASE + "?tidyTabId=01" },
    { url: BASE + "?tidyTabId=6&tidyTabId=7" },
  ]) {
    const port = createPort(h.protocol.FAVORITES_FILING_PORT, sender);
    h.host.acceptPort(port);
    assert.equal(port.disconnected, true);
    assert.equal(port.messages.length, 0);
  }
});

for (const kind of ["FAVORITES", "BOOKMARKS"]) {
  test(kind + " filing ports enforce owner, envelope kind, feature type and disconnect lifetime", async () => {
    const h = await harness();
    const own = kind === "FAVORITES" ? h.favorites : h.bookmarks;
    const other = kind === "FAVORITES" ? h.bookmarks : h.favorites;
    const ownType = h.protocol.Type[kind + "_FILING_CONTEXT"];
    const otherType = h.protocol.Type[(kind === "FAVORITES" ? "BOOKMARKS" : "FAVORITES") + "_FILING_CONTEXT"];
    const port = createPort(h.protocol[kind + "_FILING_PORT"], panelSender(6));
    h.host.acceptPort(port);
    assert.equal(port.disconnected, false);
    const payload = { tabId: 6, accountKey: "account", groupId: "group" };
    port.emit(h.protocol.event(ownType, payload));
    assert.deepEqual(own.updates, [{ port, payload }]);
    port.emit(h.protocol.event(otherType, payload));
    port.emit(h.protocol.request(ownType, payload));
    port.emit({ payload, type: ownType, kind: "event" });
    assert.equal(own.updates.length, 1);
    assert.equal(other.updates.length, 0);
    port.emit(h.protocol.event(ownType, { ...payload, tabId: 7 }));
    assert.deepEqual(h.favorites.clears, [port]);
    assert.deepEqual(h.bookmarks.clears, [port]);
    port.close();
    assert.deepEqual(own.clears, [port, port]);
    assert.deepEqual(other.clears, [port]);
  });
}
