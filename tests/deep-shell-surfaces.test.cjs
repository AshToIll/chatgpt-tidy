const test = require("node:test");
const assert = require("node:assert/strict");
require("../src/messages/build-info.js");

const modules = Promise.all([
  import("../src/app/sidepanel/notice-controller.js"),
  import("../src/app/sidepanel/filing-context-client.js"),
  import("../src/app/sidepanel/shell-presentation.js"),
  import("../src/messages/i18n.js"),
]);

function node(tagName = "div") {
  const element = {
    tagName, hidden: true, textContent: "", children: [], attributes: {}, listeners: {}, dataset: {}, className: "",
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    removeEventListener(name, callback) { if (this.listeners[name] === callback) delete this.listeners[name]; },
    contains(other) { return this === other || this.children.some(child => child.contains(other)); },
    get firstElementChild() { return this.children[0] || null; },
    get childElementCount() { return this.children.length; },
  };
  element.classList = {
    contains(name) { return element.className.split(" ").includes(name); },
    toggle(name, active) {
      const classes = new Set(element.className.split(" ").filter(Boolean));
      if (active) classes.add(name); else classes.delete(name);
      element.className = [...classes].join(" ");
    },
  };
  return element;
}

function clock() {
  const timers = new Map();
  let now = 0, sequence = 0, starts = 0;
  return {
    timers,
    now: () => now,
    get starts() { return starts; },
    setTimer(callback, delay) { starts++; timers.set(++sequence, { at: now + delay, callback }); return sequence; },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) {
        timers.delete(id); timer.callback();
      }
    },
  };
}

async function noticeHarness() {
  const [{ createNoticeController }, , , { createTranslator }] = await modules;
  const root = node(), time = clock(), events = [];
  const document = { ...node("document"), hidden: false, activeElement: null, createElement: node };
  let ready = true, current = "n1", language = "zh-CN";
  const controller = createNoticeController({
    root, document, now: time.now,
    translate: (key, values) => createTranslator(language)(key, values),
    isReady: () => ready, isCurrentNavigation: id => current === id,
    diagnostics: { notice: event => events.push(event), cause: globalThis.ChatGPTTidyNoticeLifecycle.cause },
    setTimer: time.setTimer, clearTimer: time.clearTimer,
  });
  return {
    controller, root, time, events, createTranslator, document,
    language(value) { language = value; controller.renderToast(); },
    ready(value) { ready = value; },
    current(value) { current = value; },
  };
}

test("real notice factory keeps persistent unknown-write nodes and close focus across all four languages", async () => {
  const h = await noticeHarness();
  h.controller.showToast("libraryChangeUnknown", true);
  const [label, close] = h.root.children;
  for (const language of ["en", "zh-TW", "ja", "zh-CN"]) {
    h.language(language);
    const t = h.createTranslator(language);
    assert.equal(h.root.children[0], label);
    assert.equal(h.root.children[1], close);
    assert.equal(label.textContent, t("libraryChangeUnknown"));
    assert.equal(close.attributes["aria-label"], t("exportJobDismiss"));
  }
  assert.equal(h.time.starts, 0);
  close.listeners.click();
  h.language("en");
  assert.equal(h.root.hidden, true);
  assert.equal(h.root.childElementCount, 0);
});

test("real notice factory preserves parameter copies, original expiry and old-timer isolation", async () => {
  const h = await noticeHarness(), values = { count: 3 };
  h.controller.showToast("messagesCount", false, values);
  const oldTimer = [...h.time.timers.values()][0].callback;
  values.count = 99;
  h.time.advance(1700); h.language("en");
  assert.equal(h.root.children[0].textContent, h.createTranslator("en")("messagesCount", { count: 3 }));
  assert.equal(h.time.starts, 1);
  h.time.advance(699); assert.equal(h.root.hidden, false);
  h.time.advance(1); assert.equal(h.root.hidden, true);
  h.controller.showToast("libraryChangeUnknown", true);
  oldTimer();
  assert.equal(h.root.hidden, false, "a queued stale callback cannot dismiss a replacement");
});

test("search notice is intent-owned, five seconds, cause-preserving, and revoked by new interaction", async () => {
  const h = await noticeHarness();
  assert.equal(h.controller.beginSearchNotice("old"), false);
  h.controller.beginSearchNotice("n1");
  assert.equal(h.controller.showSearchToast("searchUnavailable", "old"), false);
  h.controller.showSearchToast("searchUnavailable", "n1", { code: "TIMEOUT" });
  assert.equal(h.root.childElementCount, 1, "search errors have no persistent close button");
  assert.equal(h.events.at(-1).reasonCode, "TIMEOUT");
  assert.equal(h.events.at(-1).navigationIntentId, "n1");
  h.time.advance(4999); assert.equal(h.root.hidden, false);
  h.time.advance(1); assert.equal(h.root.hidden, true);
  h.controller.showSearchToast("searchUnavailable", "n1");
  h.controller.dismissSearchToast();
  assert.equal(h.controller.showSearchToast("searchUnavailable", "n1"), false);
  h.controller.showToast("libraryChangeUnknown", true);
  h.controller.dismissSearchToast();
  assert.equal(h.root.hidden, false, "search cleanup must not close another owner's unknown write");
});

test("session retirement and notice disposal reject late asynchronous feedback", async () => {
  const h = await noticeHarness();
  h.controller.showToast("libraryChangeUnknown", true);
  h.ready(false); h.language("ja");
  assert.equal(h.root.hidden, true);
  assert.equal(h.controller.showToast("favoriteAdded"), false);
  h.ready(true); h.controller.dispose();
  assert.equal(h.controller.showToast("favoriteAdded"), false);
  assert.equal(h.controller.beginSearchNotice("n1"), false);
  assert.equal(h.time.timers.size, 0);
});

async function filingHarness() {
  const [, { createFilingContextClient }] = await modules;
  const time = clock(), ports = [], connections = [];
  let context = { accountKey: "account-a", groupId: "group-a" };
  const runtime = {
    id: "extension",
    connect(options) {
      connections.push(options);
      const port = { messages: [], disconnected: 0,
        postMessage(message) { this.messages.push(message); },
        onDisconnect: { addListener(callback) { port.listener = callback; } },
        disconnect() { this.disconnected++; this.listener(); },
      };
      ports.push(port); return port;
    },
  };
  const client = createFilingContextClient({
    runtime, protocol: { event: (type, payload) => ({ type, payload }) },
    ownerTabId: 17, type: "FILING", name: "filing-port", getContext: () => context,
    setTimer: time.setTimer, clearTimer: time.clearTimer,
  });
  return { client, ports, connections, runtime, time, context(value) { context = value; } };
}

test("filing client sends explicit owner and latest context, reconnecting once after 250ms", async () => {
  const h = await filingHarness();
  h.client.connect(); h.client.connect();
  assert.equal(h.connections.length, 1);
  assert.deepEqual(h.connections[0], { name: "filing-port" });
  assert.deepEqual(h.ports[0].messages[0], {
    type: "FILING", payload: { tabId: 17, accountKey: "account-a", groupId: "group-a" },
  });
  h.context({ accountKey: "account-b", groupId: null }); h.client.sync();
  assert.equal(h.ports[0].messages.at(-1).payload.accountKey, "account-b");
  const previous = h.ports[0];
  previous.listener(); previous.listener();
  h.time.advance(249); assert.equal(h.ports.length, 1);
  h.time.advance(1); assert.equal(h.ports.length, 2);
  previous.listener(); assert.equal(h.time.timers.size, 0, "stale disconnect must not affect the new port");
});

test("filing close clears group before disconnect and cannot revive through queued reconnect", async () => {
  const h = await filingHarness(); h.client.connect();
  const previous = h.ports[0];
  previous.listener();
  const queued = [...h.time.timers.values()][0].callback;
  h.client.connect();
  const current = h.ports[1];
  h.client.close(); h.client.close();
  assert.deepEqual(current.messages.at(-1).payload, { tabId: 17, accountKey: "account-a", groupId: null });
  assert.equal(current.disconnected, 1);
  assert.equal(h.time.timers.size, 0);
  queued(); h.client.connect(); h.client.sync();
  assert.equal(h.ports.length, 2);
});

test("filing client never reconnects a retired extension context", async () => {
  const h = await filingHarness(); h.client.connect();
  h.runtime.id = null; h.ports[0].listener();
  assert.equal(h.time.timers.size, 0);
  h.client.connect();
  assert.equal(h.ports.length, 1);
});

async function shellHarness() {
  const [, , { createShellPresentation }, { createTranslator }] = await modules;
  let language = "zh-CN", dark = false;
  const styles = {}, events = [], preferences = node(), text = node(), aria = node();
  text.dataset.i18n = "retry"; aria.dataset.i18nAria = "close";
  const elements = {
    routes: ["time", "favorites", "bookmarks", "search", "export", "settings"].map(route => {
      const button = node("button"); button.dataset.route = route; return button;
    }),
    views: ["time", "favorites", "bookmarks", "search", "export", "settings"].map(route => {
      const view = node(); view.dataset.view = route; return view;
    }),
    close: node("button"), title: node(), subtitle: node(), body: node(), timeControl: node(),
    pageRefresh: node(), status: node(), exportBadge: node(),
  };
  const document = {
    documentElement: { dataset: {}, style: { setProperty(key, value) { styles[key] = value; } } },
    createElement: node,
    querySelectorAll(selector) { return selector === "[data-i18n]" ? [text] : selector === "[data-i18n-aria]" ? [aria] : []; },
    getElementById(id) { return id === "preferences-notice" ? preferences : null; },
  };
  const tokens = name => ({
    surface: name + "-surface", textPrimary: name + "-primary", textSecondary: name + "-secondary",
    textTertiary: name + "-tertiary", surfaceSubtle: name + "-subtle", border: name + "-border", borderSubtle: name + "-border-subtle",
  });
  const shell = createShellPresentation({
    document, elements, window: { matchMedia: () => ({ matches: dark }) },
    translate: (key, values) => createTranslator(language)(key, values),
    theme: {
      NATIVE_APPEARANCE_TOKENS: { dark: tokens("dark"), light: tokens("light") },
      resolve: () => ({ accent: "#123456", accentForeground: "white", accentInk: "ink",
        accentSoft: "soft", selectedSurface: "selected", hoverSurface: "hover" }),
    },
    diagnostics: { notice: event => events.push(event), cause: error => ({ reasonCode: error?.code }) },
    hydration: { errorPresentation: (error, fallback) => ({ messageKey: error?.messageKey || fallback, retryable: error?.retryable !== false }) },
    errorCode: { TAB_UNAVAILABLE: "TAB_UNAVAILABLE", UNSUPPORTED_PAGE: "UNSUPPORTED_PAGE" },
  });
  return { shell, elements, preferences, document, styles, text, aria, events, createTranslator,
    language(value) { language = value; shell.localize(value); },
    dark(value) { dark = value; },
  };
}

test("shell localizes static labels in all four languages and keeps source selection dock on export", async () => {
  const h = await shellHarness();
  for (const language of ["zh-CN", "zh-TW", "en", "ja"]) {
    h.language(language);
    const t = h.createTranslator(language);
    assert.equal(h.text.textContent, t("retry"));
    assert.equal(h.aria.attributes["aria-label"], t("close"));
    assert.equal(h.document.documentElement.lang, language);
    assert.equal(h.elements.close.title, t("close"));
  }
  h.shell.renderModuleChrome({ route: "favorites", ready: true, selection: { source: "favorites", returnTarget: "batch-main" } });
  assert.equal(h.elements.subtitle.hidden, true);
  assert.equal(h.elements.routes.find(button => button.dataset.route === "export").attributes["aria-current"], "page");
  assert.equal(h.elements.views.find(view => view.dataset.view === "favorites").classList.contains("is-active"), true);
  h.shell.renderModuleChrome({ route: "time", ready: false, selection: null });
  assert.equal(h.elements.timeControl.hidden, true);
});

test("shell theme uses validated native surface and semantic neutrals, with OS fallback", async () => {
  const h = await shellHarness();
  h.shell.applyTheme({ themeName: "blue", appearance: { colorScheme: "dark", surface: { status: "available", value: "rgb(1, 2, 3)" } } });
  assert.equal(h.styles["--surface"], "rgb(1, 2, 3)");
  assert.equal(h.styles["--accent-rgb"], "18, 52, 86");
  assert.equal(h.styles["--text-primary"], "dark-primary");
  h.shell.applyTheme({ themeName: "blue", appearance: { colorScheme: "light", surface: { status: "available", value: "url(untrusted)" } } });
  assert.equal(h.styles["--surface"], "light-surface");
  h.dark(true);
  assert.equal(h.shell.currentAppearance(null), "dark");
});

test("shell waiting reuses its node, localizes in place and reports explicit ownership", async () => {
  const h = await shellHarness(), root = node();
  const render = visible => h.shell.renderLibraryWaiting({ root, owner: "bookmarks", key: "libraryVerifyingAccount", visible });
  assert.equal(h.shell.hasLibraryWaiting(root), false);
  render(true); const status = root.firstElementChild;
  assert.equal(h.shell.hasLibraryWaiting(root), true);
  h.language("ja"); render(true);
  assert.equal(root.firstElementChild, status);
  assert.equal(status.textContent, h.createTranslator("ja")("libraryVerifyingAccount"));
  assert.equal(h.events.at(-1).surface, "bookmarks.library-status");
  render(false); assert.equal(h.events.at(-1).event, "clear");
});

test("shell recovery honors unrepeatable errors and preserves diagnostic causes", async () => {
  const h = await shellHarness(), root = node();
  h.shell.renderContextStatus({ route: "time", error: { code: "TAB_UNAVAILABLE" }, hasSnapshot: false, refreshRequired: false });
  assert.equal(h.elements.status.childElementCount, 1);
  assert.equal(h.events.at(-1).reasonCode, "TAB_UNAVAILABLE");
  h.shell.renderContextStatus({ route: "time", error: { code: "UNSUPPORTED_PAGE" }, hasSnapshot: false, refreshRequired: false });
  assert.equal(h.elements.status.children[1].dataset.retryContext, "");
  h.shell.renderContextStatus({ route: "time", error: { code: "UNSUPPORTED_PAGE" }, hasSnapshot: false, refreshRequired: true });
  assert.equal(h.elements.status.hidden, true);
  h.shell.renderModuleError({ root, owner: "favorites", className: "library-state", error: { code: "FAIL", retryable: false }, visible: true });
  assert.equal(root.childElementCount, 1);
  assert.equal(h.events.at(-1).reasonCode, "FAIL");
});

test("shell preference retry disables only while pending and export badge uses explicit projection", async () => {
  const h = await shellHarness();
  let release;
  h.shell.renderPreferenceNotice({ error: { messageKey: "preferenceReadFailed" }, onRetry: () => new Promise(resolve => { release = resolve; }) });
  const retry = h.preferences.children[1];
  const pending = retry.listeners.click();
  assert.equal(retry.disabled, true);
  release(); await pending; assert.equal(retry.disabled, false);
  h.shell.renderPreferenceNotice({ error: { messageKey: "reopenTidyPanel", retryable: false } });
  assert.equal(h.preferences.childElementCount, 1);
  h.shell.renderExportDockBadge({ count: 101, busy: false });
  assert.equal(h.elements.exportBadge.textContent, "99+");
  h.shell.renderExportDockBadge({ count: 0, busy: true });
  assert.equal(h.elements.exportBadge.textContent, "…");
  h.shell.renderExportDockBadge({ count: 0, busy: false });
  assert.equal(h.elements.exportBadge.hidden, true);
});

test("favorite navigation read errors expire and only their matching owner or intent may clear them", async () => {
  const h = await noticeHarness();
  h.controller.showToast("favoriteLatestUnavailable", true, {}, {
    owner: "favorites", navigationIntentId: "n1", durationMs: 5000, cause: { code: "LATEST_UNAVAILABLE" },
  });
  assert.equal(h.root.childElementCount, 1);
  assert.equal(h.controller.dismissOwnedToast("bookmarks"), false);
  assert.equal(h.controller.dismissOwnedToast("favorites", "stale"), false);
  assert.equal(h.controller.reconcileNavigationNotice("n1"), false);
  h.time.advance(4999); assert.equal(h.root.hidden, false);
  h.time.advance(1); assert.equal(h.root.hidden, true);
  h.controller.showToast("favoriteLatestUnavailable", true, {}, {
    owner: "favorites", navigationIntentId: "n1", durationMs: 5000,
  });
  h.current("n2");
  assert.equal(h.controller.reconcileNavigationNotice("n2"), true);
  assert.equal(h.root.hidden, true);
  assert.equal(h.controller.showToast("favoriteLatestUnavailable", true, {}, {
    owner: "favorites", navigationIntentId: "n1", durationMs: 5000,
  }), false, "late errors cannot reacquire retired navigation ownership");
});

test("navigation reconciliation preserves unknown writes without navigation intents", async () => {
  const h = await noticeHarness();
  h.controller.showToast("libraryChangeUnknown", true, {}, { owner: "favorites" });
  h.controller.reconcileNavigationNotice(null);
  assert.equal(h.root.hidden, false);
  assert.equal(h.time.timers.size, 0);
  h.controller.dismissOwnedToast("favorites");
  assert.equal(h.root.hidden, true);
});

test("accepted terminal navigation feedback survives repeated null, but a new intent or owner leave revokes it", async () => {
  const h = await noticeHarness();
  h.current(null); // coordinator has already cancelled the accepted failed intent.
  assert.equal(h.controller.showToast("bookmarkOpenFailed", true, {}, {
    owner: "bookmarks", terminalNavigationIntentId: "n1", durationMs: 5000, cause: { code: "TIMEOUT" },
  }), true);
  assert.equal(h.events.at(-1).navigationIntentId, "n1", "terminal id is diagnostic correlation, not execution permission");
  assert.equal(h.controller.reconcileNavigationNotice(null), false);
  assert.equal(h.controller.reconcileNavigationNotice(null), false);
  assert.equal(h.root.hidden, false);
  h.time.advance(1200);
  assert.equal(h.controller.reconcileNavigationNotice(null), false);
  h.time.advance(3799); assert.equal(h.root.hidden, false);
  h.time.advance(1); assert.equal(h.root.hidden, true, "null reconciliation never restarts terminal TTL");
  h.controller.showToast("bookmarkOpenFailed", true, {}, {
    owner: "bookmarks", terminalNavigationIntentId: "n1", durationMs: 5000,
  });
  h.current("n2"); assert.equal(h.controller.reconcileNavigationNotice("n2"), true);
  h.controller.showToast("bookmarkOpenFailed", true, {}, {
    owner: "bookmarks", terminalNavigationIntentId: "n2", durationMs: 5000,
  });
  assert.equal(h.controller.dismissOwnedToast("bookmarks", "n1"), false);
  assert.equal(h.controller.dismissOwnedToast("bookmarks", "n2"), true);
  assert.equal(h.controller.showToast("bookmarkOpenFailed", true, {}, {
    owner: "bookmarks", navigationIntentId: "n1", durationMs: 5000,
  }), false, "ordinary stale execution intents still fail admission");
  assert.throws(() => h.controller.showToast("bookmarkOpenFailed", true, {}, {
    navigationIntentId: "n2", terminalNavigationIntentId: "n2", durationMs: 5000,
  }), /mutually exclusive/);
});

test("hover and focus pause the remaining TTL together, and a queued pre-pause timer cannot expire resumed content", async () => {
  const h = await noticeHarness();
  h.controller.showToast("favoriteLatestUnavailable", true, {}, {
    owner: "favorites", navigationIntentId: "n1", durationMs: 5000,
  });
  h.time.advance(1200);
  const queued = [...h.time.timers.values()][0].callback;
  h.root.listeners.pointerover({ relatedTarget: null });
  assert.equal(h.time.timers.size, 0);
  h.time.advance(20000);
  h.root.listeners.pointerout({ relatedTarget: h.root.firstElementChild });
  assert.equal(h.time.timers.size, 0, "movement within the root is not pointer leave");
  h.document.activeElement = h.root.firstElementChild;
  h.root.listeners.focusin({ relatedTarget: null });
  h.root.listeners.pointerout({ relatedTarget: null });
  assert.equal(h.time.timers.size, 0, "focused content remains paused after pointer leave");
  h.language("ja");
  h.time.advance(5000);
  h.root.listeners.focusout({ relatedTarget: null });
  queued();
  assert.equal(h.root.hidden, false, "pre-pause callback is invalid even after the same notice resumes");
  h.time.advance(3799); assert.equal(h.root.hidden, false);
  h.time.advance(1); assert.equal(h.root.hidden, true);
});

test("hidden documents pause first-show and replacement notices, retaining focus as another pause owner", async () => {
  const h = await noticeHarness();
  h.document.hidden = true;
  h.document.listeners.visibilitychange();
  h.controller.showToast("favoriteAdded");
  assert.equal(h.time.timers.size, 0);
  h.time.advance(6000);
  h.controller.showToast("favoriteRemoved");
  assert.equal(h.time.timers.size, 0);
  h.document.activeElement = h.root.firstElementChild;
  h.root.listeners.focusin({ relatedTarget: null });
  h.document.hidden = false;
  h.document.listeners.visibilitychange();
  assert.equal(h.time.timers.size, 0);
  h.root.listeners.focusout({ relatedTarget: null });
  h.time.advance(2399); assert.equal(h.root.hidden, false);
  h.time.advance(1); assert.equal(h.root.hidden, true);
});

test("replacement keeps actual hover but drops focus held by a removed node, without trusting old timer or close callbacks", async () => {
  const h = await noticeHarness();
  h.controller.showToast("libraryChangeUnknown", true);
  const close = h.root.children[1];
  h.document.activeElement = close;
  h.root.listeners.focusin({ relatedTarget: null });
  h.controller.showToast("favoriteAdded");
  assert.equal(h.time.timers.size, 1, "removed close-button focus must not permanently pause its replacement");
  close.listeners.click();
  assert.equal(h.root.hidden, false, "detached close button only owns its old notice");
  const oldTimer = [...h.time.timers.values()][0].callback;
  h.root.matches = selector => selector === ":hover";
  h.root.listeners.pointerover({ relatedTarget: null });
  h.controller.showToast("favoriteRemoved");
  assert.equal(h.time.timers.size, 0, "pointer did not move when the root content changed");
  oldTimer(); h.time.advance(10000);
  assert.equal(h.root.hidden, false);
  h.root.matches = () => false;
  h.root.listeners.pointerout({ relatedTarget: null });
  oldTimer();
  h.time.advance(2400);
  assert.equal(h.root.hidden, true);
});

test("notice disposal removes every interaction listener and late captured listeners cannot restart a timer", async () => {
  const h = await noticeHarness();
  h.controller.showToast("favoriteAdded");
  const queued = [...h.time.timers.values()][0].callback;
  const pointerOver = h.root.listeners.pointerover;
  const visibility = h.document.listeners.visibilitychange;
  assert.equal(Object.keys(h.root.listeners).length, 4);
  h.controller.dispose(); h.controller.dispose();
  assert.deepEqual(Object.keys(h.root.listeners), []);
  assert.deepEqual(Object.keys(h.document.listeners), []);
  assert.equal(h.time.timers.size, 0);
  pointerOver({ relatedTarget: null }); visibility(); queued();
  assert.equal(h.time.timers.size, 0);
  assert.equal(h.controller.showToast("favoriteAdded"), false);
  assert.equal(h.root.hidden, true);
});
