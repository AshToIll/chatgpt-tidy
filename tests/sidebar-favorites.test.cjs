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
    this.parentElement = null;
    this.dataset = {};
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.id = "";
    this.innerHTML = "";
    this.textContent = "";
    this.disabled = false;
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  matches(selector) { return selector === "[data-tidy-owned]" && Boolean(this.dataset.tidyOwned); }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  dispatch(type) {
    const event = {
      prevented: false, stopped: false, immediateStopped: false,
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.immediateStopped = true; },
    };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node.parentElement) node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }
  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }
}

function descendants(root) {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

function sourced(value, source = null, status = value == null ? "missing" : "available") {
  return { value, source: value == null ? null : source, status };
}

function sidebarItem(conversationId, bindingStatus = "bound") {
  const bound = bindingStatus === "bound";
  return {
    conversationId,
    identityStatus: "stable",
    bindingStatus,
    kind: "conversation",
    title: sourced(`Title ${conversationId}`, "sidebar-dom"),
    createdAt: sourced(bound ? "2026-08-18T01:00:00.000Z" : null, "test"),
    updatedAt: sourced(bound ? "2026-08-18T02:00:00.000Z" : null, "test"),
    locator: { strategy: "href", value: `/c/${conversationId}` },
  };
}

const root = new FakeElement("html");
const head = new FakeElement("head");
const body = new FakeElement("body");
const boundLink = new FakeElement("a", { href: "/c/bound" });
const mismatchLink = new FakeElement("a", { href: "/c/mismatch" });
root.append(head, body);
body.append(boundLink, mismatchLink);

const document = {
  hidden: false,
  documentElement: root,
  head,
  createElement: (tagName) => new FakeElement(tagName),
  addEventListener() {},
  removeEventListener() {},
  getElementById(id) { return [root, ...descendants(root)].find((node) => node.id === id) || null; },
  querySelectorAll(selector) {
    const nodes = [root, ...descendants(root)];
    if (selector === "a[href^=\"/c/\"], a[href*=\"/c/\"], a[href^=\"/gg/\"]") return nodes.filter(node => node.tagName === "A" && (/\/c\//.test(node.getAttribute("href") || "") || (node.getAttribute("href") || "").startsWith("/gg/")));
    if (selector === "a[href]") return nodes.filter((node) => node.tagName === "A" && node.getAttribute("href"));
    const owner = selector.match(/^\[data-tidy-owned="([^"]+)"\]$/)?.[1];
    return owner ? nodes.filter((node) => node.dataset.tidyOwned === owner) : [];
  },
};

const snapshot = {
  schemaVersion: "chatgpt-tidy.snapshot.v1",
  capturedAt: "2026-08-18T03:00:00.000Z",
  appearance: { colorScheme: "dark", source: "test", status: "available", surface: sourced("rgb(0, 0, 0)", "test") },
  route: { pathname: "/c/bound" },
  conversation: {
    conversationId: "bound", draftId: null, identityStatus: "stable", bindingStatus: "bound",
    title: sourced("Title bound", "test"), createdAt: sourced(null), updatedAt: sourced(null),
  },
  sidebarConversations: [sidebarItem("bound"), sidebarItem("mismatch", "mismatch")],
  messages: [],
};

const runtimeListeners = [];
let togglePayload = null;
let favorites = {
  accountKey: "library-one", revision: 1,
  groups: [{ id: "inspiration", name: "灵感", icon: "sparkle" }],
  view: { groupId: "inspiration" },
  items: {},
};
const context = vm.createContext({
  URL, Date, Math, Object, Array, String, Number, Boolean, JSON, Intl, Promise,
  Node: { ELEMENT_NODE: 1 },
  document,
  location: { pathname: "/c/bound" },
  addEventListener() {},
  removeEventListener() {},
  setTimeout(callback) { callback(); return 1; },
  clearTimeout() {},
  MutationObserver: class { observe() {} disconnect() {} },
  TidyContentBridge: {
    requestMain: () => Promise.resolve(snapshot),
    onSnapshot() { return () => {}; },
  },
  chrome: {
    runtime: {
      id: "test-extension",
      sendMessage(envelope) {
        const type = envelope.type;
        if (type === context.TidyProtocol.Type.LIBRARY_GET) {
          return Promise.resolve(context.TidyProtocol.response(envelope, { accountKey: "library-one", favorites,
            identity: { documentId: "document-one", epoch: 1 },
            bookmarks: { accountKey: "library-one", revision: 1, items: {}, groups: [] } }));
        }
        if (type === context.TidyProtocol.Type.PREFERENCES_GET) {
          return Promise.resolve(context.TidyProtocol.response(envelope, { language: "zh-CN" }));
        }
        if (type === context.TidyProtocol.Type.FAVORITES_TOGGLE_SIDEBAR) {
          togglePayload = envelope.payload;
          favorites = {
            accountKey: "library-one", revision: 2,
            groups: [{ id: "inspiration", name: "灵感", icon: "sparkle" }],
            view: { groupId: "inspiration" },
            items: { bound: { conversationId: "bound", groupId: "inspiration" } },
          };
          return Promise.resolve(context.TidyProtocol.response(envelope, favorites));
        }
        throw new Error(`Unexpected request: ${type}`);
      },
      onMessage: { addListener(listener) { runtimeListeners.push(listener); }, removeListener(listener) {
        const index = runtimeListeners.indexOf(listener); if (index >= 0) runtimeListeners.splice(index, 1);
      } },
    },
  },
});

for (const file of [
  "src/messages/page-runtime.js",
  "src/platform/protocol.js",
  "src/platform/library/library-hydration.js",
  "src/platform/snapshot.js",
  "src/platform/ui/dom-ownership.js",
  "src/platform/library/content/library-client.js",
  "src/platform/chatgpt/sidebar-dom.js",
  "src/features/favorites/chatgpt/favorites-presentation.js",
]) {
  if (file === "src/platform/library/content/library-client.js") installPageSession(context, { runtime: true });
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
}

async function flush() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

(async () => {
  await flush();
  const star = boundLink.children.find((node) => node.dataset.tidyOwned === "sidebar-favorite");
  assert.ok(star, "a stable bound sidebar row receives a favorite star");
  assert.equal(mismatchLink.children.some((node) => node.dataset.tidyOwned === "sidebar-favorite"), false);
  assert.equal(star.classList.contains("is-starred"), false);

  const click = star.dispatch("click");
  assert.equal(click.prevented && click.stopped && click.immediateStopped, true, "star click must not trigger anchor navigation");
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(togglePayload)), {
    conversationId: "bound",
    locator: "/c/bound",
    expectedAccountKey: "library-one",
    expectedIdentity: { documentId: "document-one", epoch: 1 },
  });
  assert.equal(star.classList.contains("is-starred"), true);

  favorites = { ...favorites, revision: 3, items: {} };
  const invalidation = context.TidyProtocol.event(context.TidyProtocol.Type.FAVORITES_UPDATED, { accountKey: "library-one", revision: 3 });
  runtimeListeners.forEach((listener) => listener(invalidation));
  assert.equal(boundLink.children.some((node) => node.dataset.tidyOwned === "sidebar-favorite"), true, "same-owner revision refresh keeps the existing presentation mounted");
  await flush();
  assert.equal(boundLink.children.find((node) => node.dataset.tidyOwned === "sidebar-favorite").classList.contains("is-starred"), false,
    "cross-context invalidations re-read the scoped library rather than treating metadata as item data");

  const manifest = JSON.parse(fs.readFileSync("src/manifest.json", "utf8"));
  assert.equal(manifest.content_scripts[1].js.includes("features/favorites/chatgpt/favorites-presentation.js"), true);
  const timeSource = fs.readFileSync("src/features/time/chatgpt/time-presentation.js", "utf8");
  assert.doesNotMatch(timeSource, /--tidy-sidebar-bookmark-slot/);
  assert.match(timeSource, /--tidy-sidebar-star-slot/);
  console.log("sidebar-favorites assertions passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
