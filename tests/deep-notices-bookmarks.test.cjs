const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { installPageSession } = require("./helpers/page-session.cjs");

// This fixture models native node ownership and deferred opens, not a second
// copy of the production bookmark lifecycle. Every assertion runs the presenter.
class Element {
  constructor(tag, attributes = {}) {
    this.tagName = tag.toUpperCase(); this.nodeType = 1; this.attributes = { ...attributes };
    this.children = []; this.parentElement = null; this.dataset = {}; this.listeners = new Map();
    this.textContent = ""; this.innerHTML = ""; this.id = ""; this.disabled = false;
    const classes = new Set(), properties = new Map();
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle(name, force) { const next = force ?? !classes.has(name); if (next) classes.add(name); else classes.delete(name); return next; },
    };
    this.style = { getPropertyValue: name => properties.get(name) || "", setProperty: (name, value) => properties.set(name, value) };
  }
  get isConnected() { return this.tagName === "HTML" || Boolean(this.parentElement?.isConnected); }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children.at(-1) || null; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  matches(selector) {
    if (selector.includes(",")) return selector.split(",").some(part => this.matches(part.trim()));
    const hrefMatch = /^a\[href([*^]?)="([^"]+)"\]$/.exec(selector);
    if (hrefMatch) {
      const href = this.getAttribute("href") || "";
      return this.tagName === "A" && (hrefMatch[1] === "^" ? href.startsWith(hrefMatch[2]) : hrefMatch[1] === "*" ? href.includes(hrefMatch[2]) : href === hrefMatch[2]);
    }
    if (selector === "[data-tidy-feedback]") return Object.hasOwn(this.dataset, "tidyFeedback");
    if (selector === "[data-tidy-owned]") return Boolean(this.dataset.tidyOwned);
    if (selector === "a[href]") return this.tagName === "A" && Boolean(this.getAttribute("href"));
    const owner = selector.match(/^\[data-tidy-owned="([^"]+)"\]$/)?.[1];
    return Boolean(owner && this.dataset.tidyOwned === owner);
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelector(selector) { return descendants(this).find(node => node.matches(selector)) || null; }
  contains(node) { return node === this || descendants(this).includes(node); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  remove() { if (!this.parentElement) return; this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
  insertAdjacentHTML(_position, html) { this.innerHTML += html; }
  addEventListener(name, callback, options) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
    options?.signal?.addEventListener("abort", () => this.listeners.set(name, this.listeners.get(name).filter(item => item !== callback)), { once: true });
  }
  click(target = this) {
    const event = { target, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} };
    for (const callback of this.listeners.get("click") || []) callback(event);
  }
}
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const field = value => ({ value, source: value == null ? null : "test", status: value == null ? "missing" : "available" });
const flush = () => new Promise(setImmediate);

async function harness() {
  const root = new Element("html"), head = new Element("head"), body = new Element("body");
  const links = ["a", "b"].map(id => new Element("a", { href: "/c/" + id }));
  body.append(...links); root.append(head, body);
  const requests = [], runtimeListeners = [], snapshotListeners = [], libraryListeners = [], mutationObservers = [], notices = [];
  const lease = { generation: 1 }, abort = new AbortController();
  let stopped = false;
  const snapshot = {
    schemaVersion: "chatgpt-tidy.snapshot.v1", route: { pathname: "/c/a" },
    appearance: { colorScheme: "dark", source: "test", status: "available", surface: field(null) },
    conversation: { conversationId: "a", draftId: null, identityStatus: "stable", bindingStatus: "bound", title: field("A"), createdAt: field(null), updatedAt: field(null) },
    messages: [],
    sidebarConversations: ["a", "b"].map(id => ({ conversationId: id, identityStatus: "stable", bindingStatus: "bound", kind: "conversation",
      title: field(id), createdAt: field(null), updatedAt: field(null), locator: { strategy: "href", value: "/c/" + id } })),
  };
  let library = { bookmarks: { accountKey: "owner", revision: 1, groups: [], items: {
    "a::m": { conversationId: "a", messageId: "m" }, "b::m": { conversationId: "b", messageId: "m" },
  } } };
  const document = { documentElement: root, head, hidden: false, createElement: tag => new Element(tag),
    getElementById: id => descendants(root).find(node => node.id === id) || null,
    querySelectorAll: selector => descendants(root).filter(node => node.matches(selector)),
    addEventListener() {}, removeEventListener() {},
  };
  const context = vm.createContext({
    document, location: { pathname: "/c/a" }, Node: { ELEMENT_NODE: 1 }, AbortController, AbortSignal, Event,
    setTimeout(callback) { callback(); return 1; }, clearTimeout() {}, addEventListener() {}, removeEventListener() {},
    MutationObserver: class { constructor(callback) { this.callback = callback; mutationObservers.push(this); } observe() {} disconnect() {} },
    TidyContentBridge: { requestMain: () => Promise.resolve(snapshot), onSnapshot(callback) { snapshotListeners.push(callback); return () => {}; } },
    TidyLibraryClient: {
      capture: () => lease, owns: value => !stopped && value === lease,
      request(type, payload) { return new Promise((resolve, reject) => requests.push({ type, payload, resolve, reject })); },
      subscribe(callback) { libraryListeners.push(callback); callback(library); return () => {}; },
    },
    ChatGPTTidyDiagnostics: { notice: value => notices.push(value), slot: () => "node-1", cause: error => ({ reasonCode: error?.code || null }) },
    chrome: { runtime: { id: "test-extension", onMessage: { addListener: callback => runtimeListeners.push(callback), removeListener() {} },
      sendMessage: envelope => Promise.resolve(context.TidyProtocol.response(envelope, { language: "en" })),
    } },
  });
  for (const file of ["src/messages/page-runtime.js", "src/messages/notice-lifecycle.js", "src/platform/protocol.js", "src/platform/theme/theme.js",
    "src/platform/snapshot.js", "src/platform/ui/dom-ownership.js", "src/platform/chatgpt/message-dom.js", "src/platform/chatgpt/sidebar-dom.js"]) {
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, "..", file), "utf8"), context, { filename: file });
  }
  installPageSession(context, { runtime: true });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../src/features/bookmarks/chatgpt/bookmarks-presentation.js"), "utf8"), context);
  await flush();
  const button = index => links[index].querySelector('[data-tidy-owned="sidebar-bookmark-count"]');
  assert.ok(button(0)); assert.ok(button(1));
  return {
    requests, notices, links, button, feedback: node => node.querySelector("[data-tidy-feedback]"),
    redraw() { snapshotListeners.forEach(callback => callback(snapshot)); },
    language(language) { runtimeListeners.forEach(callback => callback(context.TidyProtocol.event(context.TidyProtocol.Type.PREFERENCES_UPDATED, { language }))); },
    hideCount(index) { const id = index === 0 ? "a" : "b"; delete library.bookmarks.items[id + "::m"]; libraryListeners.forEach(callback => callback(library)); },
    restoreCount(index) { const id = index === 0 ? "a" : "b"; library.bookmarks.items[id + "::m"] = { conversationId: id, messageId: "m" }; libraryListeners.forEach(callback => callback(library)); },
    detachNative(index, { reattach = false } = {}) {
      const link = links[index]; link.remove();
      if (reattach) body.append(link);
      mutationObservers.forEach(observer => observer.callback([{ target: body, removedNodes: [link], addedNodes: reattach ? [link] : [] }]));
    },
    dispose() { stopped = true; context.chrome.runtime.id = undefined; context.TidyPageSession.check(); abort.abort(); },
  };
}

for (const distinctButtons of [false, true]) test("latest count open owns feedback across " + (distinctButtons ? "different buttons" : "the same button"), async () => {
  const h = await harness(), first = h.button(0), second = h.button(distinctButtons ? 1 : 0);
  first.click(); second.click();
  h.requests[1].resolve({ opened: true }); await flush();
  h.requests[0].reject(Error("old failure")); await flush();
  assert.equal(h.feedback(first), null);
  assert.equal(h.feedback(second), null);
  assert.equal(h.notices.filter(item => item.event === "show").length, 0);
});

test("closing latest failure prevents an older in-flight failure from resurrecting", async () => {
  const h = await harness(), button = h.button(0);
  button.click(); button.click();
  h.requests[1].reject(Error("latest failure")); await flush();
  const notice = h.feedback(button); assert.ok(notice);
  button.click(notice); assert.equal(h.requests.length, 2);
  h.requests[0].reject(Error("old failure")); await flush();
  assert.equal(h.feedback(button), null);
  assert.equal(h.notices.filter(item => item.event === "show").length, 1);
});

test("renderer cleanup revokes a removed count button before its late failure", async () => {
  const h = await harness(), old = h.button(0); old.click();
  h.hideCount(0); assert.equal(old.isConnected, false);
  h.restoreCount(0); const current = h.button(0); assert.notEqual(current, old);
  h.requests[0].reject(Error("removed failure")); await flush();
  assert.equal(h.feedback(old), null);
  assert.equal(h.feedback(current), null);
});

for (const reattach of [false, true]) test("native removal revokes feedback ownership" + (reattach ? " even after reattachment" : ""), async () => {
  const h = await harness(), button = h.button(0); button.click();
  h.detachNative(0, { reattach });
  h.requests[0].reject(Error("detached failure")); await flush();
  assert.equal(h.feedback(button), null);
  assert.equal(h.notices.filter(item => item.event === "show").length, 0);
});

test("closing another button's earlier notice does not revoke the latest open", async () => {
  const h = await harness(), first = h.button(0), second = h.button(1);
  first.click(); h.requests[0].reject(Error("first failure")); await flush();
  const oldNotice = h.feedback(first); assert.ok(oldNotice);
  second.click(); first.click(oldNotice);
  h.requests[1].reject(Error("latest failure")); await flush();
  assert.equal(h.feedback(first), null);
  assert.ok(h.feedback(second));
  assert.equal(h.requests.length, 2);
});

test("current failure stays readable across redraw and translation but not disposal", async () => {
  const h = await harness(), button = h.button(0);
  button.click(); h.requests[0].reject(Error("current failure")); await flush();
  const notice = h.feedback(button); assert.ok(notice);
  h.redraw(); h.language("zh-CN");
  assert.equal(h.feedback(button), notice);
  assert.equal(notice.textContent, "未能打开，请再点 ×");
  button.click(notice); button.click(); h.dispose();
  h.requests[1].reject(Error("retired failure")); await flush();
  assert.equal(h.feedback(button), null);
});
