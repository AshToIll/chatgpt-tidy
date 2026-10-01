const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { installPageSession } = require("./helpers/page-session.cjs");

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach((value) => this.values.add(value)); }
  remove(...values) { values.forEach((value) => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const next = force === undefined ? !this.values.has(value) : Boolean(force);
    if (next) this.values.add(value); else this.values.delete(value);
    return next;
  }
}

class FakeElement {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attributes };
    this.children = [];
    this.childNodes = this.children;
    this.parentElement = null;
    this.dataset = {};
    this.classList = new FakeClassList();
    this.className = "";
    this.textContent = "";
    this.id = "";
    const properties = new Map();
    this.style = { getPropertyValue: name => properties.get(name) || "",
      setProperty: (name, value) => properties.set(name, String(value)) };
    this.title = "";
    this.disabled = false;
    this.listeners = new Map();
    this.innerHTML = "";
    this.rect = { left: 0, right: 0, top: 0, width: 0, height: 0 };
  }

  get firstElementChild() { return this.children[0] || null; }
  get nextElementSibling() {
    return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null;
  }
  contains(node) { return node === this || descendants(this).includes(node); }
  querySelectorAll(selector) { return descendants(this).filter(node => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  insertBefore(node, reference) {
    if (node === reference) return node;
    if (reference == null) { this.append(node); return node; }
    if (!this.children.includes(reference)) throw new Error("Reference is not a child");
    node.remove(); node.parentElement = this;
    this.children.splice(this.children.indexOf(reference), 0, node);
    return node;
  }
  get lastElementChild() { return this.children.at(-1) || null; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  getBoundingClientRect() { return this.rect; }
  matches(selector) {
    if (selector.includes(",")) return selector.split(",").some(part => this.matches(part.trim()));
    const className = /^\.([\w-]+)$/.exec(selector)?.[1];
    if (className) return this.classList.contains(className) || this.className.split(/\s+/).includes(className);
    const attribute = /^(\w+)?\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attribute) {
      if (attribute[1] && this.tagName !== attribute[1].toUpperCase()) return false;
      const dataKey = attribute[2].startsWith("data-")
        ? attribute[2].slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) : null;
      const value = dataKey && Object.hasOwn(this.dataset, dataKey) ? String(this.dataset[dataKey]) : this.getAttribute(attribute[2]);
      return attribute[3] === undefined ? value !== null : value === attribute[3];
    }
    return this.tagName === selector.toUpperCase();
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node.parentElement) node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }
  insertAdjacentHTML() {}
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((value) => value !== listener));
  }
  dispatch(type) {
    const event = {
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {},
    };
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
  prepend(node) {
    if (node.parentElement) node.remove();
    node.parentElement = this;
    this.children.unshift(node);
  }
  replaceChildren(...nodes) {
    this.children.forEach((node) => { node.parentElement = null; });
    this.children.length = 0;
    this.append(...nodes);
  }
  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }
}

function descendants(root) {
  const result = [];
  for (const child of root.children) {
    result.push(child, ...descendants(child));
  }
  return result;
}

const root = new FakeElement("html");
const head = new FakeElement("head");
const body = new FakeElement("body");
root.append(head, body);
const sidebarLink = new FakeElement("a", { href: "/c/current-conversation" });
sidebarLink.rect = { left: 100, right: 300, top: 0, width: 200, height: 52 };
const sidebarTitle = new FakeElement("span");
sidebarTitle.textContent = "Current";
sidebarTitle.rect = { left: 128, right: 210, top: 4, width: 82, height: 18 };
sidebarLink.append(sidebarTitle);
const message = new FakeElement("div", { "data-message-id": "message-1" });
body.append(sidebarLink, message);

const document = {
  documentElement: root,
  head,
  createElement: (tagName) => new FakeElement(tagName),
  addEventListener() {},
  removeEventListener() {},
  getElementById(id) {
    return [root, ...descendants(root)].find((node) => node.id === id) || null;
  },
  querySelectorAll(selector) {
    const nodes = [root, ...descendants(root)];
    if (selector === "a[href^=\"/c/\"], a[href*=\"/c/\"], a[href^=\"/gg/\"]") return nodes.filter(node => node.tagName === "A" && (/\/c\//.test(node.getAttribute("href") || "") || (node.getAttribute("href") || "").startsWith("/gg/")));
    if (selector === "a[href]") return nodes.filter((node) => node.tagName === "A" && node.getAttribute("href"));
    if (selector === "div[data-message-id]") return nodes.filter((node) => node.matches(selector));
    const owner = selector.match(/^\[data-tidy-owned="([^"]+)"\]$/)?.[1];
    if (owner) return nodes.filter((node) => node.dataset.tidyOwned === owner);
    return [];
  },
};

function sourced(value, source = null, status = value == null ? "missing" : "available") {
  return { value, source: value == null ? null : source, status };
}

function makeSnapshot({ bindingStatus = "bound", messages = null } = {}) {
  return {
    schemaVersion: "chatgpt-tidy.snapshot.v1",
    capturedAt: "2026-08-18T03:00:00.000Z",
    appearance: { colorScheme: "dark", source: "test", status: "available", surface: sourced("rgb(0, 0, 0)", "test") },
    route: { pathname: "/c/current-conversation" },
    conversation: {
      conversationId: "current-conversation",
      draftId: null,
      identityStatus: "stable",
      bindingStatus,
      title: sourced(bindingStatus === "bound" ? "Current" : null, "test"),
      createdAt: sourced(bindingStatus === "bound" ? "2026-08-18T01:12:34.000Z" : null, "test"),
      updatedAt: sourced(bindingStatus === "bound" ? "2026-08-18T02:36:58.000Z" : null, "test"),
    },
    sidebarConversations: [{
      conversationId: "current-conversation",
      identityStatus: "stable",
      bindingStatus: "bound",
      kind: "conversation",
      title: sourced("Current", "test"),
      createdAt: sourced("2026-08-18T01:12:34.000Z", "test"),
      updatedAt: sourced("2026-08-18T02:36:58.000Z", "test"),
      locator: { strategy: "href", value: "/c/current-conversation" },
    }],
    messages: messages ?? (bindingStatus === "bound" ? [{
      messageId: "message-1",
      idStatus: "stable",
      presentationStatus: "formal",
      role: "user",
      timestamp: sourced("2026-08-18T01:20:30.000Z", "test"),
      excerpt: sourced("Hello", "test"),
      order: { index: 0, displayNumber: 7 },
      locator: { strategy: "data-message-id", value: "message-1" },
    }] : []),
  };
}

const preferences = {
  language: "zh-CN",
  timeZone: "Asia/Singapore",
  dateFormat: "slash",
  conversationTimeMode: "range",
  conversationTimePrecision: "minute",
  messageTimePrecision: "second",
  messageTimePosition: "after",
  timeDisplayEnabled: true,
  messageNumbersEnabled: true,
};
const snapshotListeners = [];
const runtimeListeners = [];
const initialSnapshot = makeSnapshot();
let bookmarkToggleCount = 0;
let bookmarkState = {
  accountKey: "library-one", revision: 1, groups: [],
  items: {
    "current-conversation::message-1": {
      conversationId: "current-conversation",
      messageId: "message-1",
    },
  },
};

const context = vm.createContext({
  URL,
  Date,
  Math,
  Object,
  Array,
  String,
  Number,
  Boolean,
  JSON,
  Intl,
  Promise,
  Node: { ELEMENT_NODE: 1 },
  document,
  location: { pathname: "/c/current-conversation" },
  addEventListener() {},
  removeEventListener() {},
  navigator: { language: "en-US" },
  setTimeout(callback) { callback(); return 1; },
  clearTimeout() {},
  MutationObserver: class { observe() {} disconnect() {} },
  chrome: {
    runtime: {
      id: "test-extension",
      sendMessage(envelope) {
        if (envelope.type === context.TidyProtocol.Type.PREFERENCES_GET) {
          return Promise.resolve(context.TidyProtocol.response(envelope, preferences));
        }
        if (envelope.type === context.TidyProtocol.Type.LIBRARY_GET) {
          return Promise.resolve(context.TidyProtocol.response(envelope, { accountKey: "library-one", bookmarks: bookmarkState,
            identity: { documentId: "document-one", epoch: 1 },
            favorites: { accountKey: "library-one", revision: 1, groups: [], items: {} } }));
        }
        if (envelope.type === context.TidyProtocol.Type.BOOKMARKS_TOGGLE_CURRENT) {
          bookmarkToggleCount += 1;
          assert.equal(envelope.payload.expectedAccountKey, "library-one");
          bookmarkState = { accountKey: "library-one", revision: 2, groups: [], items: {} };
          return Promise.resolve(context.TidyProtocol.response(envelope, bookmarkState));
        }
        throw new Error(`Unexpected runtime request: ${envelope.type}`);
      },
      onMessage: {
        addListener(listener) { runtimeListeners.push(listener); },
        removeListener(listener) {
          const index = runtimeListeners.indexOf(listener);
          if (index >= 0) runtimeListeners.splice(index, 1);
        },
      },
    },
  },
  TidyContentBridge: {
    requestMain: () => Promise.resolve(initialSnapshot),
    onSnapshot(listener) {
      snapshotListeners.push(listener);
      return () => {
        const index = snapshotListeners.indexOf(listener);
        if (index >= 0) snapshotListeners.splice(index, 1);
      };
    },
  },
});

for (const file of [
  "src/messages/notice-lifecycle.js", "src/messages/page-runtime.js", "src/platform/protocol.js", "src/platform/theme/theme.js",
  "src/platform/library/library-hydration.js",
  "src/platform/snapshot.js",
  "src/platform/time-format.js",
  "src/platform/ui/dom-ownership.js",
  "src/platform/library/content/library-client.js",
  "src/platform/chatgpt/sidebar-dom.js", "src/platform/chatgpt/message-dom.js",
  "src/features/time/chatgpt/time-presentation.js",
  "src/features/bookmarks/chatgpt/bookmarks-presentation.js",
]) {
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  if (file === "src/platform/protocol.js") installPageSession(context, { runtime: true });
}

async function flush() {
  // Presentation startup intentionally wraps runtime calls so synchronous
  // Extension-context-invalidated throws become ordinary rejected promises.
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function emitRuntime(envelope) {
  for (const listener of runtimeListeners) listener(envelope);
}

function emitSnapshot(snapshot, reason) {
  for (const listener of snapshotListeners) listener(snapshot, reason);
}

// A separate time-only harness keeps lifecycle races independent of bookmark
// rendering, while using the same real page-session contract as production.
function createLifecycleHarness({ delayedStartup = false, ready = true, runtimeFailure = false } = {}) {
  const root = new FakeElement("html"), head = new FakeElement("head"), body = new FakeElement("body");
  const sidebar = new FakeElement("a", { href: "/c/current-conversation" });
  const message = new FakeElement("div", { "data-message-id": "message-1" });
  root.append(head, body);
  body.append(sidebar, message);
  const timers = new Map(), runtimeListeners = new Set(), snapshots = new Set(), readyListeners = new Set();
  const observers = [];
  let timerId = 0, resolvePreferences, resolveSnapshot, snapshotRequests = 0;
  const initialPreferences = new Promise(resolve => { resolvePreferences = resolve; });
  const initialSnapshot = new Promise(resolve => { resolveSnapshot = resolve; });
  const document = {
    documentElement: ready ? root : null, head,
    createElement: tag => new FakeElement(tag),
    addEventListener(type, listener) { if (type === "DOMContentLoaded") readyListeners.add(listener); },
    removeEventListener(type, listener) { if (type === "DOMContentLoaded") readyListeners.delete(listener); },
    getElementById(id) { return [root, ...descendants(root)].find(node => node.id === id) || null; },
    querySelectorAll(selector) {
      const nodes = [root, ...descendants(root)];
      if (selector === "a[href^=\"/c/\"], a[href*=\"/c/\"], a[href^=\"/gg/\"]") return nodes.filter(node => node.tagName === "A" && (/\/c\//.test(node.getAttribute("href") || "") || (node.getAttribute("href") || "").startsWith("/gg/")));
      if (selector === "a[href]") return nodes.filter(node => node.tagName === "A" && node.getAttribute("href"));
      if (selector === "div[data-message-id]") return nodes.filter(node => node.matches(selector));
      const owner = selector.match(/^\[data-tidy-owned="([^"]+)"\]$/)?.[1];
      return owner ? nodes.filter(node => node.dataset.tidyOwned === owner) : [];
    },
  };
  const context = vm.createContext({
    URL, Intl, document, navigator: { language: "en-US" }, Node: { ELEMENT_NODE: 1 },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.connected = false; observers.push(this); }
      observe(_target, options) { this.connected = true; this.options = options; }
      disconnect() { this.connected = false; }
    },
    chrome: { runtime: {
      id: "test-extension",
      sendMessage(envelope) {
        if (runtimeFailure) throw new Error("Extension context invalidated.");
        return (delayedStartup ? initialPreferences : Promise.resolve(preferences))
          .then(value => context.TidyProtocol.response(envelope, value));
      },
      onMessage: {
        addListener(listener) { runtimeListeners.add(listener); },
        removeListener(listener) { runtimeListeners.delete(listener); },
      },
    } },
    TidyContentBridge: {
      requestMain() {
        snapshotRequests += 1;
        return delayedStartup ? initialSnapshot : Promise.resolve(makeSnapshot());
      },
      onSnapshot(listener) { snapshots.add(listener); return () => snapshots.delete(listener); },
    },
  });
  for (const file of ["src/messages/page-runtime.js", "src/platform/protocol.js", "src/platform/snapshot.js", "src/platform/time-format.js",
    "src/platform/ui/dom-ownership.js", "src/platform/chatgpt/sidebar-dom.js", "src/platform/chatgpt/message-dom.js", "src/features/time/chatgpt/time-presentation.js"]) {
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
    if (file === "src/platform/protocol.js") installPageSession(context, { runtime: true });
  }
  return { context, root, document, sidebar, message, timers, runtimeListeners, snapshots, observers, readyListeners,
    get snapshotRequests() { return snapshotRequests; },
    resolveStartup() { resolvePreferences(preferences); resolveSnapshot(makeSnapshot()); },
    async flush() {
      await flush();
      for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
      await flush();
    },
  };
}

(async () => {
  await flush();
  let sidebarTime = sidebarLink.children.find((node) => node.dataset.tidyOwned === "sidebar-time");
  assert.equal(sidebarTime.textContent, "2026/08/18 09:12\u2009~\u200910:36");
  assert.equal(sidebarTime.style.insetInlineStart, "28px", "sidebar time aligns to the native title start");
  // Native composed rows already indent their anchor. Do not add a second inset.
  sidebarTitle.rect.left = sidebarLink.rect.left;
  emitSnapshot(makeSnapshot(), "native-zero-title-inset");
  assert.equal(sidebarTime.style.insetInlineStart, "0px", "zero native title inset must stay zero");
  sidebarTitle.rect.left = 128;
  emitSnapshot(makeSnapshot(), "native-indented-title-restored");
  assert.equal(sidebarTime.title, "2026/08/18 09:12\u2009~\u200910:36");
  const messageMeta = message.children.find((node) => node.dataset.tidyOwned === "message-meta");
  let messageTime = messageMeta.children.find((node) => node.dataset.tidyOwned === "message-time");
  const bookmarkButton = messageMeta.children.find((node) => node.dataset.tidyOwned === "message-bookmark");
  assert.deepEqual(messageTime.children.map((node) => node.textContent), ["#7", "2026/08/18 09:20:30"]);
  assert.ok(bookmarkButton?.classList.contains("is-bookmarked"));
  assert.deepEqual(
    messageMeta.children.map((node) => node.dataset.tidyOwned),
    ["message-bookmark", "message-time"],
    "user bookmark stays on the page-center side without moving the time anchor",
  );
  assert.equal(message.lastElementChild, messageMeta);

  // 新版用户气泡与原生动作栏嵌套在一层容器内：两个 presenter 应复用同一
  // metadata 并把它放在动作栏前，而不是继续把日期追加到整个消息末尾。
  const userLayout = new FakeElement("div");
  const userBubble = new FakeElement("div", { "data-user-message-bubble": "" });
  const userActions = new FakeElement("div");
  userActions.className = "turn-action-controls";
  userBubble.textContent = "Hello";
  userLayout.append(userBubble, userActions); message.append(userLayout);
  emitSnapshot(makeSnapshot(), "native-user-action-layout");
  assert.equal(messageMeta.parentElement, userLayout);
  assert.deepEqual(userLayout.children, [userBubble, messageMeta, userActions]);
  assert.equal(messageMeta.children.find(node => node.dataset.tidyOwned === "message-bookmark"), bookmarkButton);
  assert.equal(messageMeta.children.find(node => node.dataset.tidyOwned === "message-time"), messageTime);

  // 时间关闭后，书签自己负责共享行的位置；再次开启不能复制共享行/按钮。
  emitRuntime(context.TidyProtocol.event(context.TidyProtocol.Type.PREFERENCES_UPDATED, {
    ...preferences, timeDisplayEnabled: false, messageNumbersEnabled: false,
  }));
  assert.deepEqual(userLayout.children, [userBubble, messageMeta, userActions]);
  assert.equal(messageMeta.children.length, 1);
  assert.equal(messageMeta.firstElementChild, bookmarkButton);
  emitRuntime(context.TidyProtocol.event(context.TidyProtocol.Type.PREFERENCES_UPDATED, {
    ...preferences, timeDisplayEnabled: false, messageNumbersEnabled: false, messageTimePosition: "before",
  }));
  assert.equal(message.firstElementChild, messageMeta, "bookmark-only responds to before without time renderer");
  emitRuntime(context.TidyProtocol.event(context.TidyProtocol.Type.PREFERENCES_UPDATED, {
    ...preferences, timeDisplayEnabled: false, messageNumbersEnabled: false,
  }));
  assert.deepEqual(userLayout.children, [userBubble, messageMeta, userActions]);
  assert.equal(messageMeta.firstElementChild, bookmarkButton);

  // 回到旧版简化结构，后续原有编号/生命周期测试继续覆盖其保守末尾定位。
  userLayout.remove(); message.append(messageMeta);
  emitRuntime(context.TidyProtocol.event(context.TidyProtocol.Type.PREFERENCES_UPDATED, preferences));
  messageTime = messageMeta.children.find(node => node.dataset.tidyOwned === "message-time");
  assert.ok(messageTime);
  sidebarTime = sidebarLink.children.find(node => node.dataset.tidyOwned === "sidebar-time");

  // A virtualized message may retain a local position but lose its explicit
  // global turn index. Remove only that number, not the time or bookmark.
  const withoutNumber = makeSnapshot();
  withoutNumber.messages[0].order = { index: 5, displayNumber: null };
  emitSnapshot(withoutNumber, "virtualized-without-number");
  assert.deepEqual(messageTime.children.map((node) => node.textContent), ["2026/08/18 09:20:30"]);
  assert.equal(messageMeta.children.find((node) => node.dataset.tidyOwned === "message-bookmark"), bookmarkButton);
  emitSnapshot(makeSnapshot(), "number-source-restored");
  assert.deepEqual(messageTime.children.map((node) => node.textContent), ["#7", "2026/08/18 09:20:30"]);

  // A preference event re-renders the already-open page immediately; no new
  // snapshot and no F5 are required.
  emitRuntime(context.TidyProtocol.event(context.TidyProtocol.Type.PREFERENCES_UPDATED, {
    ...preferences,
    dateFormat: "dot",
    conversationTimeMode: "created",
    messageTimePosition: "before",
  }));
  assert.equal(sidebarTime.textContent, "创建 2026.08.18 09:12");
  assert.deepEqual(messageTime.children.map((node) => node.textContent), ["#7", "2026.08.18 09:20:30"]);
  assert.equal(message.firstElementChild, messageMeta);

  // Turning message time/numbering off removes only time's child. The existing
  // bookmark remains the same live, clickable control in the shared row.
  emitRuntime(context.TidyProtocol.event(context.TidyProtocol.Type.PREFERENCES_UPDATED, {
    ...preferences,
    timeDisplayEnabled: false,
    messageNumbersEnabled: false,
  }));
  assert.equal(messageMeta.children.some((node) => node.dataset.tidyOwned === "message-time"), false);
  assert.equal(messageMeta.children.filter((node) => node.dataset.tidyOwned === "message-bookmark").length, 1);
  assert.equal(messageMeta.children.find((node) => node.dataset.tidyOwned === "message-bookmark"), bookmarkButton);
  bookmarkButton.dispatch("click");
  await flush();
  assert.equal(bookmarkToggleCount, 1, "bookmark keeps its click handler while time is disabled");

  // Reopening time and moving before/after never duplicates or replaces the
  // bookmark child.
  emitRuntime(context.TidyProtocol.event(context.TidyProtocol.Type.PREFERENCES_UPDATED, preferences));
  assert.equal(messageMeta.children.filter((node) => node.dataset.tidyOwned === "message-time").length, 1);
  assert.equal(messageMeta.children.filter((node) => node.dataset.tidyOwned === "message-bookmark").length, 1);
  const bookmarkAfterReopen = messageMeta.children.find((node) => node.dataset.tidyOwned === "message-bookmark");
  assert.equal(bookmarkAfterReopen, bookmarkButton);
  emitRuntime(context.TidyProtocol.event(context.TidyProtocol.Type.PREFERENCES_UPDATED, {
    ...preferences,
    messageTimePosition: "before",
  }));
  assert.equal(message.firstElementChild, messageMeta);
  emitRuntime(context.TidyProtocol.event(context.TidyProtocol.Type.PREFERENCES_UPDATED, {
    ...preferences,
    messageTimePosition: "after",
  }));
  assert.equal(message.lastElementChild, messageMeta);
  emitRuntime(context.TidyProtocol.event(context.TidyProtocol.Type.PREFERENCES_UPDATED, {
    ...preferences,
    messageTimePosition: "before",
  }));
  assert.equal(message.firstElementChild, messageMeta);

  emitSnapshot(makeSnapshot(), "new-snapshot");
  assert.equal(messageMeta.children.filter((node) => node.dataset.tidyOwned === "message-bookmark").length, 1);
  assert.equal(messageMeta.children.find((node) => node.dataset.tidyOwned === "message-bookmark"), bookmarkButton);

  const assistantSnapshot = makeSnapshot();
  assistantSnapshot.messages[0].role = "assistant";
  emitSnapshot(assistantSnapshot, "assistant-order");
  assert.deepEqual(
    messageMeta.children.map((node) => node.dataset.tidyOwned),
    ["message-time", "message-bookmark"],
    "assistant bookmark mirrors to the page-center side",
  );

  const transientSnapshot = makeSnapshot();
  transientSnapshot.messages[0].presentationStatus = "transient";
  emitSnapshot(transientSnapshot, "thinking-placeholder");
  assert.equal(message.children.some((node) => node.dataset.tidyOwned === "message-meta"), false, "thinking placeholders own no number, time, or bookmark");

  emitSnapshot(makeSnapshot({ bindingStatus: "route-only", messages: [] }), "spa-route");
  assert.equal(message.children.some((node) => node.dataset.tidyOwned === "message-meta"), false);

  // Range mode is honest about missing canonical metadata. It must not silently
  // render one endpoint as if the user had switched to created/updated mode.
  emitRuntime(context.TidyProtocol.event(context.TidyProtocol.Type.PREFERENCES_UPDATED, preferences));
  const missingRange = makeSnapshot();
  missingRange.sidebarConversations[0].updatedAt = sourced(null);
  emitSnapshot(missingRange, "canonical-time-missing");
  assert.equal(sidebarLink.children.some((node) => node.dataset.tidyOwned === "sidebar-time"), false);

  emitRuntime(context.TidyProtocol.event(context.TidyProtocol.Type.PREFERENCES_UPDATED, {
    ...preferences,
    timeDisplayEnabled: false,
    messageNumbersEnabled: false,
  }));
  assert.equal(sidebarLink.children.some((node) => node.dataset.tidyOwned === "sidebar-time"), false);
  const bookmarkOnlyMeta = message.children.find((node) => node.dataset.tidyOwned === "message-meta");
  assert.ok(bookmarkOnlyMeta, "shared meta remains while bookmark owns a child");
  assert.equal(bookmarkOnlyMeta.children.some((node) => node.dataset.tidyOwned === "message-time"), false);
  assert.equal(bookmarkOnlyMeta.children.filter((node) => node.dataset.tidyOwned === "message-bookmark").length, 1);

  const bookmarkPresentationCss = document.getElementById("tidy-bookmarks-presentation-style").textContent;
  assert.match(bookmarkPresentationCss, /\.tidy-message-meta-host:hover \.tidy-message-bookmark/);
  assert.match(bookmarkPresentationCss, /\.tidy-message-meta-host:focus-within \.tidy-message-bookmark/);
  assert.doesNotMatch(bookmarkPresentationCss, /\.tidy-message-meta:hover \.tidy-message-bookmark/);
  assert.match(bookmarkPresentationCss, /transition: opacity \.12s ease;/);
  assert.doesNotMatch(bookmarkPresentationCss, /transform:/);


  // 任务时钟是同一会话行内的辅助链接：真实 DOM 中它与标题都有
  // data-interactive-row-link，但只有辅助链接自身 aria-hidden=true。
  // 前后顺序都不得改变主标题的日期归属；隐藏祖先下的独立主行仍需日期。
  const taskRows = createLifecycleHarness();
  const taskBody = taskRows.sidebar.parentElement;
  const taskRow = new FakeElement("div", { "data-sidebar-item": "true" });
  const taskHref = "/c/current-conversation";
  const taskAuxBefore = new FakeElement("a", {
    href: taskHref, "data-interactive-row-link": "true", "aria-hidden": "true", tabindex: "-1",
  });
  const taskAuxAfter = new FakeElement("a", {
    href: taskHref, "data-interactive-row-link": "true", "aria-hidden": "true", tabindex: "-1",
  });
  taskRows.sidebar.setAttribute("data-interactive-row-link", "true");
  taskBody.prepend(taskRow);
  taskRow.append(taskAuxBefore, taskRows.sidebar, taskAuxAfter);
  const collapsedProject = new FakeElement("section", { hidden: "", "aria-hidden": "true" });
  const hiddenMain = new FakeElement("a", { href: taskHref, "data-interactive-row-link": "true" });
  collapsedProject.append(hiddenMain);
  taskBody.append(collapsedProject);
  const taskDates = host => host.children.filter(node => node.dataset.tidyOwned === "sidebar-time");
  const publishTaskRows = async () => {
    for (const listener of taskRows.snapshots) listener(makeSnapshot());
    await taskRows.flush();
  };
  await taskRows.flush();
  assert.equal(taskRows.observers[0].options.attributes, true, "native href/aria-hidden changes schedule time cleanup");
  assert.deepEqual(Array.from(taskRows.observers[0].options.attributeFilter), ["href", "aria-hidden"], "attribute observation stays confined to sidebar identity changes");
  assert.equal(taskDates(taskRows.sidebar).length, 1, "task main title keeps exactly one date");
  assert.equal(taskDates(taskAuxBefore).length, 0, "task auxiliary before the title must not receive a date");
  assert.equal(taskDates(taskAuxAfter).length, 0, "task auxiliary after the title must not receive a date");
  assert.equal(taskDates(hiddenMain).length, 1, "ancestor-hidden project main link still receives its date");

  // 清理之前版本已落到辅助链接上的日期；只清理时间自己的节点。
  const staleTaskDate = new FakeElement("div");
  staleTaskDate.dataset.tidyOwned = "sidebar-time";
  staleTaskDate.dataset.tidyKey = "current-conversation";
  const taskOtherOwner = new FakeElement("button");
  taskOtherOwner.dataset.tidyOwned = "sidebar-favorite";
  taskAuxBefore.append(staleTaskDate, taskOtherOwner);
  await publishTaskRows();
  assert.equal(taskDates(taskAuxBefore).length, 0, "previous auxiliary date is removed on the next render");
  assert.ok(taskAuxBefore.children.includes(taskOtherOwner), "time cleanup does not remove another owner's node");

  // React 把一个已装饰的主链接改为辅助入口时，同 href 不能保住旧日期。
  taskRows.sidebar.setAttribute("aria-hidden", "true");
  taskRows.observers[0].callback([{ type: "attributes", attributeName: "aria-hidden", target: taskRows.sidebar }]);
  await taskRows.flush();
  assert.equal(taskDates(taskRows.sidebar).length, 0, "recycled main-to-auxiliary link loses its old date");
  assert.equal(taskDates(hiddenMain).length, 1, "independent hidden main copy is unaffected");
  taskRows.sidebar.setAttribute("aria-hidden", "false");
  taskRows.observers[0].callback([{ type: "attributes", attributeName: "aria-hidden", target: taskRows.sidebar }]);
  await taskRows.flush();
  assert.equal(taskDates(taskRows.sidebar).length, 1, "recycled link regains a date only after becoming a main link");
  for (const next of [
    { ...preferences, conversationTimeMode: "created", dateFormat: "iso" },
    { ...preferences, conversationTimeMode: "range", dateFormat: "slash" },
    { ...preferences, timeDisplayEnabled: false },
    preferences,
  ]) {
    const event = taskRows.context.TidyProtocol.event(taskRows.context.TidyProtocol.Type.PREFERENCES_UPDATED, next);
    for (const listener of taskRows.runtimeListeners) listener(event);
    await taskRows.flush();
    assert.equal(taskDates(taskRows.sidebar).length, next.timeDisplayEnabled ? 1 : 0);
    assert.equal(taskDates(hiddenMain).length, next.timeDisplayEnabled ? 1 : 0);
    assert.equal(taskDates(taskAuxBefore).length, 0, "format and enabled changes never decorate the leading task action");
    assert.equal(taskDates(taskAuxAfter).length, 0, "format and enabled changes never decorate the trailing task action");
  }

  // 原生项目列表和最近会话会同时挂载同一 href。项目副本可以不可见，
  // 但日期必须同时属于两个 DOM 行，不能把“一份会话数据”当成“一个节点”。
  const duplicates = createLifecycleHarness();
  const projectHref = "/g/g-p-synthetic-project/c/current-conversation";
  const duplicateSnapshot = makeSnapshot();
  duplicateSnapshot.sidebarConversations[0].kind = "project-conversation";
  duplicateSnapshot.sidebarConversations[0].locator.value = projectHref;
  duplicates.sidebar.setAttribute("href", projectHref);
  const recentCopy = new FakeElement("a", { href: projectHref });
  recentCopy.rect = { left: 10, right: 210, top: 60, width: 200, height: 52 };
  duplicates.sidebar.parentElement.append(recentCopy);

  // A matching conversation link in chat content is not a sidebar copy.
  const contentHosts = [
    new FakeElement("main"),
    new FakeElement("section", { "data-message-id": "synthetic-source-message" }),
    new FakeElement("section", { "data-chatgpt-search-message-ids": "synthetic-composed-message" }),
    new FakeElement("dialog"),
    new FakeElement("section", { role: "dialog" }),
    new FakeElement("section", { "aria-modal": "true" }),
  ];
  const contentLinks = contentHosts.map(host => {
    const link = new FakeElement("a", { href: projectHref });
    host.append(link);
    duplicates.sidebar.parentElement.append(host);
    return link;
  });
  const otherOwner = new FakeElement("button");
  otherOwner.dataset.tidyOwned = "sidebar-favorite";
  duplicates.sidebar.append(otherOwner);
  const dateNodes = row => row.children.filter(node => node.dataset.tidyOwned === "sidebar-time");
  const publishDuplicate = async snapshot => {
    for (const listener of duplicates.snapshots) listener(snapshot);
    await duplicates.flush();
  };
  const setDuplicatePreferences = async next => {
    const event = duplicates.context.TidyProtocol.event(duplicates.context.TidyProtocol.Type.PREFERENCES_UPDATED, next);
    for (const listener of duplicates.runtimeListeners) listener(event);
    await duplicates.flush();
  };
  await duplicates.flush();
  await publishDuplicate(duplicateSnapshot);
  assert.equal(dateNodes(duplicates.sidebar).length, 1, "hidden project copy receives its date");
  assert.equal(dateNodes(recentCopy).length, 1, "visible recent copy of the same href receives its date");
  assert.equal(dateNodes(recentCopy)[0].textContent, dateNodes(duplicates.sidebar)[0].textContent);
  for (const link of contentLinks) assert.equal(dateNodes(link).length, 0, "same-href message and dialog links must not receive sidebar dates");
  const duplicateDate = dateNodes(recentCopy)[0];
  await publishDuplicate(duplicateSnapshot);
  assert.equal(dateNodes(recentCopy).length, 1, "repeated snapshots do not duplicate the date");
  assert.equal(dateNodes(recentCopy)[0], duplicateDate, "repeated snapshots keep the existing date node");
  await setDuplicatePreferences({ ...preferences, dateFormat: "iso", conversationTimeMode: "created" });
  assert.equal(dateNodes(recentCopy)[0].textContent, dateNodes(duplicates.sidebar)[0].textContent);
  assert.match(dateNodes(recentCopy)[0].textContent, /2026-08-18/);
  await setDuplicatePreferences(preferences);

  // React may recycle just one copy for another conversation while the other
  // copy still represents the old conversation. Cleanup must track live nodes,
  // not keep the recycled row's old date merely because its ID is still active.
  duplicates.sidebar.setAttribute("href", "/c/unrelated-conversation");
  await publishDuplicate(duplicateSnapshot);
  assert.equal(dateNodes(duplicates.sidebar).length, 0, "recycled duplicate loses its stale date");
  assert.equal(dateNodes(recentCopy).length, 1, "the matching copy keeps its date");
  assert.ok(duplicates.sidebar.children.includes(otherOwner), "date cleanup does not remove another owner's decoration");
  duplicates.sidebar.setAttribute("href", projectHref);
  await publishDuplicate(duplicateSnapshot);
  recentCopy.remove();
  const remountedCopy = new FakeElement("a", { href: projectHref });
  duplicates.sidebar.parentElement.append(remountedCopy);
  duplicates.observers[0].callback([{ target: duplicates.root, addedNodes: [remountedCopy], removedNodes: [recentCopy] }]);
  await duplicates.flush();
  assert.equal(dateNodes(remountedCopy).length, 1, "native duplicate remount is decorated without a new data request");

  for (const host of contentHosts) {
    // Native search portals can reuse a mounted link. Existing dates must be
    // removed inside both ordinary message content and every dialog form.
    duplicates.sidebar.parentElement.append(remountedCopy);
    await publishDuplicate(duplicateSnapshot);
    assert.equal(dateNodes(remountedCopy).length, 1);
    host.append(remountedCopy);
    duplicates.observers[0].callback([{ target: host, addedNodes: [remountedCopy], removedNodes: [] }]);
    await duplicates.flush();
    assert.equal(dateNodes(remountedCopy).length, 0, "moving a decorated native node into content or a dialog clears its date");
  }
  duplicates.sidebar.parentElement.append(remountedCopy);
  await publishDuplicate(duplicateSnapshot);
  await setDuplicatePreferences({ ...preferences, timeDisplayEnabled: false });
  assert.equal(duplicates.document.querySelectorAll('[data-tidy-owned="sidebar-time"]').length, 0);
  await setDuplicatePreferences(preferences);
  assert.equal(duplicates.document.querySelectorAll('[data-tidy-owned="sidebar-time"]').length, 2);
  const missingDuplicateRange = structuredClone(duplicateSnapshot);
  missingDuplicateRange.sidebarConversations[0].updatedAt = sourced(null);
  await publishDuplicate(missingDuplicateRange);
  assert.equal(duplicates.document.querySelectorAll('[data-tidy-owned="sidebar-time"]').length, 0, "missing range clears all copies");
  await publishDuplicate(duplicateSnapshot);
  duplicates.context.chrome.runtime.id = undefined;
  assert.equal(duplicates.context.TidyPageSession.check(), false);
  assert.equal(duplicates.document.querySelectorAll('[data-tidy-owned="sidebar-time"]').length, 0, "session disposal clears all copies");

  const active = createLifecycleHarness();
  await active.flush();
  assert.equal(active.document.querySelectorAll('[data-tidy-owned="sidebar-time"]').length, 1);
  assert.equal(active.message.classList.contains("tidy-message-meta-host"), true);
  const lateSnapshot = [...active.snapshots][0], lateRuntime = [...active.runtimeListeners][0];
  active.observers[0].callback([{ target: active.root, addedNodes: [], removedNodes: [] }]);
  assert.equal(active.timers.size, 1, "native changes queue a render before the reload");
  active.context.chrome.runtime.id = undefined;
  lateSnapshot(makeSnapshot());
  assert.equal(active.timers.size, 0, "invalidation cancels queued renders");
  assert.equal(active.observers[0].connected, false);
  assert.equal(active.snapshots.size, 0);
  assert.equal(active.runtimeListeners.size, 0);
  assert.equal(active.document.getElementById("tidy-time-presentation-style"), null);
  assert.equal(active.document.querySelectorAll('[data-tidy-owned="sidebar-time"]').length, 0);
  assert.equal(active.document.querySelectorAll('[data-tidy-owned="message-meta"]').length, 0);
  assert.equal(active.message.classList.contains("tidy-message-meta-host"), false);
  lateSnapshot(makeSnapshot());
  lateRuntime(active.context.TidyProtocol.event(active.context.TidyProtocol.Type.PREFERENCES_UPDATED, preferences));
  active.observers[0].callback([{ target: active.root, addedNodes: [], removedNodes: [] }]);
  await active.flush();
  assert.equal(active.timers.size, 0);
  assert.equal(active.document.getElementById("tidy-time-presentation-style"), null, "late callbacks cannot remount time UI");

  const pending = createLifecycleHarness({ delayedStartup: true });
  await flush();
  pending.context.chrome.runtime.id = undefined;
  assert.equal(pending.context.TidyPageSession.check(), false);
  pending.resolveStartup();
  await pending.flush();
  assert.equal(pending.document.getElementById("tidy-time-presentation-style"), null);
  assert.equal(pending.document.querySelectorAll('[data-tidy-owned="sidebar-time"]').length, 0);
  assert.equal(pending.timers.size, 0, "resolved startup work cannot schedule after disposal");

  const loading = createLifecycleHarness({ ready: false });
  const lateStart = [...loading.readyListeners][0];
  loading.context.chrome.runtime.id = undefined;
  assert.equal(loading.context.TidyPageSession.check(), false);
  assert.equal(loading.readyListeners.size, 0, "disposal removes the pending DOM-ready listener");
  loading.document.documentElement = loading.root;
  lateStart();
  assert.equal(loading.observers[0].connected, false);
  assert.equal(loading.document.getElementById("tidy-time-presentation-style"), null);

  const synchronousFailure = createLifecycleHarness({ runtimeFailure: true });
  await synchronousFailure.flush();
  assert.equal(synchronousFailure.context.TidyPageSession.check(), false);
  assert.equal(synchronousFailure.snapshotRequests, 0, "sync runtime invalidation prevents the following bridge request");
  assert.equal(synchronousFailure.document.getElementById("tidy-time-presentation-style"), null);

  console.log("time-presentation assertions passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
