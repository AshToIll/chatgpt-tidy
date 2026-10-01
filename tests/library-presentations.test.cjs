const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { installPageSession } = require("./helpers/page-session.cjs");

// Only document roots are registered; connectivity follows the current parent chain.
// Detached controls must lose ownership just as native DOM nodes do.
const documentRoots = new WeakSet();

class Element {
  constructor(tag, attributes = {}) {
    this.tagName = tag.toUpperCase(); this.attributes = { ...attributes };
    this.children = []; this.parentElement = null; this.dataset = {}; this.listeners = new Map();
    this.textContent = ""; this.innerHTML = ""; this.id = ""; this.disabled = false;
    const properties = new Map();
    this.style = { getPropertyValue: name => properties.get(name) || "",
      setProperty: (name, value) => properties.set(name, String(value)) };
    const classes = new Set(String(attributes.class || "").split(/\s+/).filter(Boolean));
    Object.defineProperty(this, "className", { get: () => [...classes].join(" "),
      set(value) { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(name => classes.add(name)); } });
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle(name, force) { const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name); return on; },
    };
  }
  get isConnected() {
    let root = this;
    while (root.parentElement) root = root.parentElement;
    return documentRoots.has(root);
  }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children.at(-1) || null; }
  get nextElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
  getAttribute(name) {
    if (name === "class") return this.className;
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      if (Object.hasOwn(this.dataset, key)) return this.dataset[key];
    }
    return this.attributes[name] ?? null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  matches(selector) {
    if (selector.includes(",")) return selector.split(",").some(part => this.matches(part.trim()));
    const tag = selector.match(/^[a-z][a-z0-9-]*/i)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    const withoutAttributes = selector.replace(/\[[^\]]+\]/g, "");
    for (const [, name] of withoutAttributes.matchAll(/\.([a-z0-9_-]+)/gi)) {
      if (!this.classList.contains(name)) return false;
    }
    for (const [, name, operation, expected] of selector.matchAll(/\[([^\s~*^=\]]+)(?:([~*^]?=)"([^"]*)")?\]/g)) {
      const actual = this.getAttribute(name);
      if (actual == null) return false;
      if (!operation) continue;
      if (operation === "=" && actual !== expected) return false;
      if (operation === "^=" && !actual.startsWith(expected)) return false;
      if (operation === "*=" && !actual.includes(expected)) return false;
      if (operation === "~=" && !actual.split(/\s+/).includes(expected)) return false;
    }
    return Boolean(tag || /[.\[]/.test(selector));
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) { return descendants(this).filter(node => node.matches(selector)); }
  contains(node) { return node === this || descendants(this).includes(node); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  prepend(node) { node.remove(); node.parentElement = this; this.children.unshift(node); }
  insertBefore(node, reference) {
    if (node === reference) return node;
    if (reference == null) { this.append(node); return node; }
    assert.equal(reference.parentElement, this, "insertBefore reference belongs to the requested parent");
    node.remove(); node.parentElement = this; this.children.splice(this.children.indexOf(reference), 0, node); return node;
  }
  remove() { if (!this.parentElement) return;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
  insertAdjacentHTML(_position, html) { this.innerHTML += html; }
  addEventListener(type, callback, options) {
    if (options?.signal?.aborted) return;
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
    options?.signal?.addEventListener("abort", () => this.removeEventListener(type, callback), { once: true });
  }
  removeEventListener(type, callback) { const listeners = this.listeners.get(type) || [];
    const index = listeners.indexOf(callback); if (index >= 0) listeners.splice(index, 1); }
  click(target = this) {
    const event = { target, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() {} };
    for (const callback of this.listeners.get("click") || []) callback(event);
    assert.equal(event.prevented && event.stopped, true, "content controls must not navigate native hosts");
  }
}

const descendants = (node) => node.children.flatMap((child) => [child, ...descendants(child)]);
const field = (value) => ({ value, source: value == null ? null : "test", status: value == null ? "missing" : "available" });
function snapshotFor() {
  return { schemaVersion: "chatgpt-tidy.snapshot.v1", route: { pathname: "/c/shared" },
    appearance: { colorScheme: "dark", source: "test", status: "available", surface: field("rgb(0, 0, 0)") },
    conversation: { conversationId: "shared", draftId: null, identityStatus: "stable", bindingStatus: "bound",
      title: field("Shared route"), createdAt: field(null), updatedAt: field(null) },
    sidebarConversations: [{ conversationId: "shared", identityStatus: "stable", bindingStatus: "bound", kind: "conversation",
      title: field("Shared route"), createdAt: field(null), updatedAt: field(null), locator: { strategy: "href", value: "/c/shared" } }],
    messages: ["user", "assistant"].map((role, index) => ({ messageId: role, idStatus: "stable", presentationStatus: "formal", role,
      timestamp: field(null), excerpt: field(`${role} text`), order: { index: index + 1 }, locator: { strategy: "data-message-id", value: role } })),
  };
}
function libraryFor(accountKey, { populated = true, revision = 1 } = {}) {
  return { accountKey, identity: { documentId: "document", epoch: accountKey === "owner-b" ? 1 : 0 },
    favorites: { accountKey, revision, groups: [], items: populated ? { shared: { conversationId: "shared" } } : {} },
    bookmarks: { accountKey, revision, groups: [], items: populated ? {
      "shared::user": { bookmarkId: "shared::user", conversationId: "shared", messageId: "user" },
      "shared::assistant": { bookmarkId: "shared::assistant", conversationId: "shared", messageId: "assistant" },
    } : {} },
  };
}

function harness({ sharedTime = true, nestedUserActions = false, messageTimePosition = "after" } = {}) {
  const root = new Element("html"), head = new Element("head"), body = new Element("body");
  documentRoots.add(root);
  const link = new Element("a", { href: "/c/shared" });
  const user = new Element("div", { "data-message-id": "user" }), assistant = new Element("div", { "data-message-id": "assistant" });
  const meta = new Element("div"), time = new Element("span");
  meta.dataset.tidyOwned = "message-meta"; time.dataset.tidyOwned = "message-time"; time.textContent = "09:30";
  const userContent = new Element("div"), userBubbleBranch = new Element("div"), userBubble = new Element("div", { "data-user-message-bubble": "" });
  const userActionBranch = new Element("div"), userActions = new Element("div", { class: "turn-action-controls" });
  if (nestedUserActions) {
    userBubbleBranch.append(userBubble); userActionBranch.append(userActions);
    userContent.append(userBubbleBranch, userActionBranch); user.append(userContent);
  }
  if (sharedTime) { meta.append(time); user.append(meta); }
  body.append(link, user, assistant); root.append(head, body);
  let currentPreferences = { language: "en", messageTimePosition };
  const documentEvents = new Map(), windowEvents = new Map(), runtimeListeners = [], snapshotListeners = [], requests = [];
  const addEvent = (map, name, callback) => { if (!map.has(name)) map.set(name, []); map.get(name).push(callback); };
  const remove = (list, callback) => { const index = list.indexOf(callback); if (index >= 0) list.splice(index, 1); };
  const removeEvent = (map, name, callback) => remove(map.get(name) || [], callback);
  const dispatch = (map, name, event = {}) => { for (const callback of map.get(name) || []) callback(event); };
  const document = { hidden: false, documentElement: root, head,
    createElement: (tag) => new Element(tag), addEventListener: (name, callback) => addEvent(documentEvents, name, callback),
    removeEventListener: (name, callback) => removeEvent(documentEvents, name, callback),
    getElementById: (id) => [root, ...descendants(root)].find((node) => node.id === id) || null,
    querySelectorAll: (selector) => descendants(root).filter((node) => node.matches(selector)),
  };
  const snapshot = snapshotFor();
  const context = vm.createContext({ document, location: { pathname: "/c/shared" },
    Node: { ELEMENT_NODE: 1 }, MutationObserver: class { observe() {} disconnect() {} },
    setTimeout(callback, ms) { if (ms >= 1000) return setTimeout(callback, ms).unref(); callback(); return 1; }, clearTimeout,
    addEventListener: (name, callback) => addEvent(windowEvents, name, callback),
    removeEventListener: (name, callback) => removeEvent(windowEvents, name, callback),
    TidyContentBridge: { requestMain: () => Promise.resolve(snapshot), onSnapshot(callback) {
      snapshotListeners.push(callback); return () => remove(snapshotListeners, callback);
    } },
    chrome: { runtime: { id: "test-extension", onMessage: { addListener: (callback) => runtimeListeners.push(callback),
      removeListener: callback => remove(runtimeListeners, callback) },
      sendMessage(envelope) {
        if (envelope.type === context.TidyProtocol.Type.PREFERENCES_GET) {
          return Promise.resolve(context.TidyProtocol.response(envelope, currentPreferences));
        }
        return new Promise((resolve, reject) => requests.push({ envelope, resolve, reject, resolved: false }));
      },
    } },
  });
  for (const file of ["src/messages/notice-lifecycle.js", "src/messages/page-runtime.js", "src/platform/protocol.js", "src/platform/theme/theme.js", "src/platform/library/library-hydration.js", "src/platform/snapshot.js", "src/platform/ui/dom-ownership.js", "src/platform/library/content/library-client.js",
    "src/platform/chatgpt/sidebar-dom.js", "src/platform/chatgpt/message-dom.js", "src/features/favorites/chatgpt/favorites-presentation.js", "src/features/bookmarks/chatgpt/bookmarks-presentation.js"]) {
    if (file === "src/platform/library/content/library-client.js") installPageSession(context, { runtime: true });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, "..", file), "utf8"), context, { filename: file });
  }
  assert.equal(context.TidySnapshot.validate(snapshot).valid, true);
  function resolve(type, value) {
    const request = requests.find((item) => !item.resolved && item.envelope.type === type);
    assert.ok(request, `pending ${type}`); request.resolved = true;
    request.resolve(context.TidyProtocol.response(request.envelope, value));
  }
  return { requests, resolve, type: context.TidyProtocol.Type, link, user, assistant, meta, time,
    userContent, userBubbleBranch, userBubble, userActionBranch, userActions, messageDom: context.TidyChatgptMessageDom,
    preferences(value) { currentPreferences = { ...currentPreferences, ...value };
      for (const callback of runtimeListeners) callback(context.TidyProtocol.event(
        context.TidyProtocol.Type.PREFERENCES_UPDATED, currentPreferences)); },
    session: context.TidyPageSession, runtime: context.chrome.runtime,
    refresh: () => context.TidyLibraryClient.refresh(),
    identity(accountKey, epoch) {
      for (const callback of runtimeListeners) callback(context.TidyProtocol.event(context.TidyProtocol.Type.LIBRARY_IDENTITY_CHANGED,
        { accountKey, epoch, documentId: "document", phase: accountKey ? "ready" : "unavailable" }));
    },
    owned: (owner) => document.querySelectorAll(`[data-tidy-owned="${owner}"]`),
    visible(value) { document.hidden = !value; dispatch(documentEvents, "visibilitychange"); },
    focus() { dispatch(windowEvents, "focus"); },
    stream() { for (const callback of snapshotListeners) callback(snapshot); },
    appearance(colorScheme) { snapshot.appearance.colorScheme = colorScheme;
      for (const callback of snapshotListeners) callback(snapshot); },
    theme(value) { for (const callback of runtimeListeners) callback(context.TidyProtocol.event(
      context.TidyProtocol.Type.PREFERENCES_UPDATED, { language: "en", theme: value })); },
    language(value) { for (const callback of runtimeListeners) callback(context.TidyProtocol.event(
      context.TidyProtocol.Type.PREFERENCES_UPDATED, { language: value })); },
    themes: context.TidyTheme,
  };
}
const flush = () => new Promise(setImmediate);

const failureCases = [
  ["sidebar-favorite", "FAVORITES_TOGGLE_SIDEBAR", "failed", {
    en: "Result unknown. Check your favorites.", "zh-CN": "结果未明，请查收藏", "zh-TW": "結果未明，請查收藏", ja: "お気に入りの保存結果を確認してください",
  }],
  ["message-bookmark", "BOOKMARKS_TOGGLE_CURRENT", "failed", {
    en: "Result unknown. Check your bookmarks.", "zh-CN": "结果未明，请查书签", "zh-TW": "結果未明，請查書籤", ja: "ブックマークの保存結果を確認してください",
  }],
  ["sidebar-bookmark-count", "BOOKMARKS_OPEN_CONVERSATION_VIEW", "openFailed", {
    en: "Could not open. Try again.", "zh-CN": "未能打开，请再点", "zh-TW": "未能開啟，請再點", ja: "もう一度開いてください",
  }],
];
for (const [owner, type, key, messages] of failureCases) test(`${owner} failure retranslates in place and closing it does not repeat the action`, async () => {
  const h = harness(); await flush();
  h.resolve(h.type.LIBRARY_GET, libraryFor("owner-a")); await flush();
  const button = h.owned(owner)[0]; button.click(); await flush();
  const request = h.requests.find(item => item.envelope.type === h.type[type]);
  request.resolved = true; request.reject(Error("INTERNAL_ERROR private diagnostic")); await flush();
  const notice = button.querySelector("[data-tidy-feedback]");
  assert.ok(notice); assert.equal(notice.getAttribute("role"), "alert");
  assert.equal(notice.dataset.tidyFeedback, key);
  assert.equal(notice.textContent, `${messages.en} ×`);
  h.stream(); await flush();
  assert.equal(button.querySelector("[data-tidy-feedback]"), notice, "ordinary rendering must not erase the error");
  const count = h.requests.length;
  const children = [...button.children];
  const errored = button.classList.contains("is-error");
  for (const language of ["zh-CN", "ja", "zh-TW", "en"]) {
    h.language(language); await flush();
    assert.equal(h.owned(owner)[0], button, "language changes must preserve the button");
    assert.equal(button.querySelector("[data-tidy-feedback]"), notice, "language changes must preserve the feedback node");
    assert.deepEqual(button.children, children, "feedback updates must not rebuild count/icon children");
    assert.equal(notice.textContent, `${messages[language]} ×`);
    assert.equal(notice.getAttribute("role"), "alert");
    assert.equal(button.classList.contains("is-error"), errored, "language changes must not clear the error state");
    assert.equal(h.requests.length, count, "translation must not dispatch another request");
  }
  button.click(notice); await flush(); // Parent's capture handler runs before the clicked child.
  assert.equal(button.querySelector("[data-tidy-feedback]"), null);
  assert.equal(button.classList.contains("is-error"), false);
  assert.equal(h.requests.length, count, "dismissal must not toggle saved data or reopen the panel");
  h.language("zh-CN"); h.stream(); await flush();
  assert.equal(button.querySelector("[data-tidy-feedback]"), null, "dismissed errors must stay dismissed after translation");
});

for (const [owner, type] of failureCases) test(`${owner} successful retry keeps old feedback dismissed across language changes`, async () => {
  const h = harness(); await flush();
  h.resolve(h.type.LIBRARY_GET, libraryFor("owner-a")); await flush();
  const button = h.owned(owner)[0]; button.click(); await flush();
  const request = h.requests.find(item => item.envelope.type === h.type[type]);
  request.resolved = true; request.reject(Error("INTERNAL_ERROR")); await flush();
  assert.ok(button.querySelector("[data-tidy-feedback]"));
  button.click(); await flush();
  assert.equal(button.querySelector("[data-tidy-feedback]"), null, "retry removes the previous error immediately");
  h.language("ja");
  const next = libraryFor("owner-a", { revision: 2 });
  h.resolve(h.type[type], type === "FAVORITES_TOGGLE_SIDEBAR" ? next.favorites
    : type === "BOOKMARKS_TOGGLE_CURRENT" ? next.bookmarks : { opened: true });
  await flush(); h.language("zh-TW"); h.stream(); await flush();
  assert.equal(h.owned(owner)[0], button);
  assert.equal(button.querySelector("[data-tidy-feedback]"), null, "successful retry must not retain an error translation key");
});

for (const [owner, type] of failureCases) test(`${owner} language events cannot restore feedback after page retirement`, async () => {
  const h = harness(); await flush();
  h.resolve(h.type.LIBRARY_GET, libraryFor("owner-a")); await flush();
  const button = h.owned(owner)[0]; button.click(); await flush();
  const request = h.requests.find(item => item.envelope.type === h.type[type]);
  request.resolved = true; request.reject(Error("INTERNAL_ERROR")); await flush();
  const notice = button.querySelector("[data-tidy-feedback]");
  assert.ok(notice);
  const oldText = notice.textContent, before = h.requests.length;
  h.runtime.id = undefined; h.session.check();
  h.runtime.id = "test-extension"; h.language("ja"); h.stream(); h.identity("owner-a", 0);
  h.focus(); await h.refresh(); await flush();
  for (const kind of ["sidebar-favorite", "message-bookmark", "sidebar-bookmark-count"]) {
    assert.equal(h.owned(kind).length, 0, "language events must not remount retired controls");
  }
  assert.equal(notice.textContent, oldText, "retired feedback must not be translated off-page");
  assert.equal(h.requests.length, before, "retirement must not restart the library or action");
});

for (const [owner, type] of failureCases) test(`${owner} late failure cannot create translated feedback after page retirement`, async () => {
  const h = harness(); await flush();
  h.resolve(h.type.LIBRARY_GET, libraryFor("owner-a")); await flush();
  const button = h.owned(owner)[0]; button.click(); await flush();
  const request = h.requests.find(item => item.envelope.type === h.type[type]);
  h.runtime.id = undefined; h.session.check();
  request.resolved = true; request.reject(Error("INTERNAL_ERROR")); await flush();
  h.runtime.id = "test-extension"; h.language("zh-CN"); h.stream(); await flush();
  assert.equal(h.owned(owner).length, 0);
  assert.equal(button.querySelector("[data-tidy-feedback]"), null, "late rejection must not append feedback to the retired button");
});

test("message bookmark accent follows all themes and appearance without recoloring stars or counts", async () => {
  const h = harness(); await flush();
  h.resolve(h.type.LIBRARY_GET, libraryFor("owner-a")); await flush();
  for (const appearance of ["light", "dark", "light"]) {
    h.appearance(appearance);
    for (const name of Object.keys(h.themes.THEMES)) {
      h.theme(name);
      for (const button of h.owned("message-bookmark")) {
        assert.equal(button.style.getPropertyValue("--tidy-bookmark-accent"), h.themes.THEMES[name][appearance].accent);
      }
      for (const owner of ["sidebar-favorite", "sidebar-bookmark-count"]) {
        assert.equal(h.owned(owner)[0].style.getPropertyValue("--tidy-bookmark-accent"), "");
      }
    }
  }
  assert.equal(h.requests.length, 1, "color changes do not re-read the account or saved library");
  h.theme("invalid-theme");
  assert.equal(h.owned("message-bookmark")[0].style.getPropertyValue("--tidy-bookmark-accent"), h.themes.THEMES[h.themes.DEFAULT_THEME].light.accent);
});

test("both presenters share initial verification and synchronously remove private markers without deleting shared times", async () => {
  const h = harness(); await flush();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].envelope.type, h.type.LIBRARY_GET);
  assert.equal(h.owned("sidebar-favorite").length, 0);
  h.resolve(h.type.LIBRARY_GET, libraryFor("owner-a")); await flush();
  assert.equal(h.owned("sidebar-favorite")[0].classList.contains("is-starred"), true);
  assert.equal(h.owned("message-bookmark").length, 2);
  assert.equal(h.owned("sidebar-bookmark-count")[0].title, "2");
  assert.equal(h.meta.firstElementChild.dataset.tidyOwned, "message-bookmark");
  assert.equal(h.meta.lastElementChild, h.time);
  for (let i = 0; i < 100; i++) h.stream();
  await flush(); assert.equal(h.requests.length, 1, "same-route token snapshots do not re-read account/session data");
  h.visible(false); h.visible(true); h.focus(); await flush();
  assert.equal(h.requests.length, 1, "ordinary visibility and focus preserve the verified local owner");
  assert.equal(h.owned("sidebar-favorite")[0].classList.contains("is-starred"), true);
  h.identity(null, 1);
  for (const owner of ["sidebar-favorite", "message-bookmark", "sidebar-bookmark-count"]) assert.equal(h.owned(owner).length, 0);
  assert.equal(h.time.parentElement, h.meta); assert.equal(h.meta.parentElement, h.user);
  assert.equal(h.assistant.children.length, 0, "bookmark-only metadata rows disappear when ownership is lost");
  assert.equal(h.link.classList.contains("tidy-sidebar-favorite-host"), false);
  assert.equal(h.link.classList.contains("tidy-sidebar-bookmark-host"), false);
  assert.equal(h.link.dataset.tidyBookmarkCountSize, undefined);
  h.identity("owner-b", 1); await flush();
  assert.equal(h.requests.length, 2);
  h.resolve(h.type.LIBRARY_GET, libraryFor("owner-b", { populated: false })); await flush();
  assert.equal(h.owned("sidebar-favorite")[0].classList.contains("is-starred"), false);
  assert.equal(h.owned("message-bookmark").every((button) => !button.classList.contains("is-bookmarked")), true);
  assert.equal(h.owned("sidebar-bookmark-count").length, 0);
});

test("late old-owner favorites and bookmarks writes cannot revive markers or block the new owner's controls", async () => {
  const h = harness(); await flush();
  h.resolve(h.type.LIBRARY_GET, libraryFor("owner-a", { populated: false })); await flush();
  h.owned("sidebar-favorite")[0].click(); h.owned("message-bookmark")[0].click(); await flush();
  const mutations = h.requests.filter((item) => item.envelope.type !== h.type.LIBRARY_GET);
  assert.equal(mutations.length, 2);
  assert.equal(mutations.every((item) => item.envelope.payload.expectedAccountKey === "owner-a"), true);
  assert.equal(mutations.every((item) => item.envelope.payload.expectedIdentity.documentId === "document"
    && item.envelope.payload.expectedIdentity.epoch === 0), true);
  h.identity(null, 1); h.identity("owner-b", 1); await flush();
  h.resolve(h.type.LIBRARY_GET, libraryFor("owner-b", { populated: false })); await flush();
  h.resolve(h.type.FAVORITES_TOGGLE_SIDEBAR, libraryFor("owner-a", { revision: 2 }).favorites);
  h.resolve(h.type.BOOKMARKS_TOGGLE_CURRENT, libraryFor("owner-a", { revision: 2 }).bookmarks); await flush();
  assert.equal(h.owned("sidebar-favorite")[0].classList.contains("is-starred"), false);
  assert.equal(h.owned("message-bookmark").every((button) => !button.classList.contains("is-bookmarked") && !button.disabled), true);
  assert.equal(h.owned("sidebar-bookmark-count").length, 0);
  const star = h.owned("sidebar-favorite")[0]; star.click(); await flush();
  assert.equal(h.requests.at(-1).envelope.payload.expectedAccountKey, "owner-b");
  h.resolve(h.type.FAVORITES_TOGGLE_SIDEBAR, libraryFor("owner-b", { revision: 2 }).favorites); await flush();
  assert.equal(star.classList.contains("is-starred"), true); assert.equal(star.disabled, false);
});

test("one unavailable module does not suppress the healthy presenter", async () => {
  const h = harness(); await flush();
  h.resolve(h.type.LIBRARY_GET, { ...libraryFor("owner-a"), bookmarks: null }); await flush();
  assert.equal(h.owned("sidebar-favorite")[0].classList.contains("is-starred"), true);
  assert.equal(h.owned("message-bookmark").length, 0); assert.equal(h.owned("sidebar-bookmark-count").length, 0);
  h.refresh(); await flush();
  h.resolve(h.type.LIBRARY_GET, { ...libraryFor("owner-a"), favorites: null }); await flush();
  assert.equal(h.owned("sidebar-favorite").length, 0);
  assert.equal(h.owned("message-bookmark").length, 2); assert.equal(h.owned("sidebar-bookmark-count")[0].title, "2");
});

test("content rehydration restores both native presenters without manual refresh", async () => {
  const h = harness(); await flush(); h.identity("owner-a", 0);
  h.requests[0].resolved = true; h.requests[0].reject(Error("The message port closed before a response was received.")); await flush();
  assert.equal(h.requests.length, 2);
  h.resolve(h.type.LIBRARY_GET, libraryFor("owner-a")); await flush();
  assert.equal(h.owned("sidebar-favorite").length, 1);
  assert.equal(h.owned("sidebar-favorite")[0].classList.contains("is-starred"), true);
  assert.equal(h.owned("message-bookmark").length, 2);
  for (let i = 0; i < 30; i++) { h.stream(); h.focus(); h.identity("owner-a", 0); }
  await flush(); assert.equal(h.requests.length, 2);
});

for (const owner of ["sidebar-favorite", "message-bookmark", "sidebar-bookmark-count"]) {
  test(`${owner} click after extension reload retires old controls instead of dispatching an action`, async () => {
    const h = harness(); await flush(); h.resolve(h.type.LIBRARY_GET, libraryFor("owner-a")); await flush();
    const button = h.owned(owner)[0], before = h.requests.length;
    h.runtime.id = undefined;
    button.click(); await flush();
    assert.equal(h.session.check(), false);
    assert.equal(h.requests.length, before, "the first old-page click must not send a write or panel-open request");
    for (const kind of ["sidebar-favorite", "message-bookmark", "sidebar-bookmark-count"]) {
      assert.equal(h.owned(kind).length, 0, `${kind} is removed synchronously`);
    }
    assert.equal(h.link.classList.contains("tidy-sidebar-favorite-host"), false);
    assert.equal(h.link.classList.contains("tidy-sidebar-bookmark-host"), false);
    // These presenters own only their marks; another presenter's shared time is untouched.
    assert.equal(h.time.parentElement, h.meta);
    h.runtime.id = "test-extension"; h.stream(); h.theme("default"); h.identity("owner-a", 0);
    h.focus(); await h.refresh(); await flush();
    assert.equal(h.requests.length, before); assert.equal(h.owned("sidebar-favorite").length, 0);
    assert.equal(h.owned("message-bookmark").length, 0); assert.equal(h.owned("sidebar-bookmark-count").length, 0);
  });
}

test("retirement during optimistic favorites and bookmarks writes rejects late UI restoration", async () => {
  const h = harness(); await flush();
  h.resolve(h.type.LIBRARY_GET, libraryFor("owner-a", { populated: false })); await flush();
  h.owned("sidebar-favorite")[0].click(); h.owned("message-bookmark")[0].click(); await flush();
  assert.equal(h.requests.filter(item => item.envelope.type !== h.type.LIBRARY_GET).length, 2);
  h.runtime.id = undefined; h.session.check();
  h.resolve(h.type.FAVORITES_TOGGLE_SIDEBAR, libraryFor("owner-a", { revision: 2 }).favorites);
  h.resolve(h.type.BOOKMARKS_TOGGLE_CURRENT, libraryFor("owner-a", { revision: 2 }).bookmarks);
  await flush(); h.stream(); await flush();
  for (const owner of ["sidebar-favorite", "message-bookmark", "sidebar-bookmark-count"]) {
    assert.equal(h.owned(owner).length, 0);
  }
  assert.equal(h.link.children.length, 0);
  assert.equal(h.meta.children.length, 1); assert.equal(h.meta.firstElementChild, h.time);
});


// The time presenter is deliberately absent from this harness. Bookmarks must
// place and retire their shared metadata correctly even when time/numbering are off.
test("bookmark-only metadata follows before and after preferences without the time presenter", async () => {
  const h = harness({ sharedTime: false }); await flush();
  h.resolve(h.type.LIBRARY_GET, libraryFor("owner-a")); await flush();
  const userMeta = h.messageDom.metadata(h.user), assistantMeta = h.messageDom.metadata(h.assistant);
  const userBody = new Element("p"), assistantBody = new Element("p");
  h.user.prepend(userBody); h.assistant.prepend(assistantBody);
  for (const position of ["before", "after", "before", "after"]) {
    h.preferences({ messageTimePosition: position, timeDisplayEnabled: false, messageNumbersEnabled: false }); await flush();
    for (const [host, meta, role] of [[h.user, userMeta, "user"], [h.assistant, assistantMeta, "assistant"]]) {
      assert.equal(h.messageDom.metadata(host), meta, "changing position reuses the metadata node");
      assert.equal(meta.dataset.position, position);
      assert.equal(meta.dataset.tidyKey, "shared:" + role);
      assert.equal(host[position === "before" ? "firstElementChild" : "lastElementChild"], meta);
      assert.equal(meta.children.length, 1, "bookmark-only mode does not invent a time or number");
    }
  }
  assert.equal(h.requests.length, 1, "position changes do not fetch or write library data");
});

test("bookmark-only nested user metadata sits before the action branch and clears the exact host on retirement", async () => {
  const h = harness({ sharedTime: false, nestedUserActions: true }); await flush();
  h.resolve(h.type.LIBRARY_GET, libraryFor("owner-a")); await flush();
  const meta = h.messageDom.metadata(h.user);
  assert.deepEqual(h.userContent.children, [h.userBubbleBranch, meta, h.userActionBranch]);
  assert.equal(meta.parentElement, h.userContent, "metadata belongs between native branches, not after the hover toolbar");
  assert.equal(h.user.classList.contains("tidy-message-meta-host"), true);
  h.preferences({ messageTimePosition: "before" }); await flush();
  assert.equal(h.user.firstElementChild, meta);
  assert.deepEqual(h.userContent.children, [h.userBubbleBranch, h.userActionBranch]);
  h.preferences({ messageTimePosition: "after" }); await flush();
  assert.deepEqual(h.userContent.children, [h.userBubbleBranch, meta, h.userActionBranch]);
  for (let index = 0; index < 10; index++) h.stream();
  assert.equal(h.owned("message-meta").filter(node => node.closest("[data-message-id]") === h.user).length, 1);
  h.identity(null, 1);
  assert.equal(h.owned("message-meta").length, 0);
  assert.equal(h.user.classList.contains("tidy-message-meta-host"), false, "nested row cleanup clears the actual message host");
  assert.deepEqual(h.user.children, [h.userContent]);
  assert.deepEqual(h.userContent.children, [h.userBubbleBranch, h.userActionBranch], "native layout survives retirement unchanged");
  assert.equal(h.userActions.parentElement, h.userActionBranch);
  assert.equal(h.userBubble.parentElement, h.userBubbleBranch);
});

test("nested shared metadata preserves time when bookmarks retire and cleans the host after the last owner leaves", async () => {
  const h = harness({ nestedUserActions: true }); await flush();
  h.resolve(h.type.LIBRARY_GET, libraryFor("owner-a")); await flush();
  assert.equal(h.messageDom.metadata(h.user), h.meta, "an existing direct shared row is moved, not copied");
  assert.deepEqual(h.userContent.children, [h.userBubbleBranch, h.meta, h.userActionBranch]);
  h.identity(null, 1);
  assert.deepEqual(h.meta.children, [h.time]);
  assert.equal(h.meta.parentElement, h.userContent);
  assert.equal(h.user.classList.contains("tidy-message-meta-host"), true, "one presenter's retirement must not remove another's live host class");
  h.time.remove(); h.messageDom.removeEmptyMetadata(h.meta);
  assert.equal(h.meta.parentElement, null);
  assert.equal(h.user.classList.contains("tidy-message-meta-host"), false);
  assert.deepEqual(h.userContent.children, [h.userBubbleBranch, h.userActionBranch]);
});

test("nested shared metadata protects a live bookmark when time leaves first", async () => {
  const h = harness({ nestedUserActions: true }); await flush();
  h.resolve(h.type.LIBRARY_GET, libraryFor("owner-a")); await flush();
  const bookmark = h.meta.querySelector('[data-tidy-owned="message-bookmark"]');
  h.time.remove(); h.messageDom.removeEmptyMetadata(h.meta);
  assert.equal(h.meta.parentElement, h.userContent);
  assert.deepEqual(h.meta.children, [bookmark]);
  assert.equal(h.user.classList.contains("tidy-message-meta-host"), true);
  h.preferences({ messageTimePosition: "before" }); await flush();
  assert.equal(h.user.firstElementChild, h.meta, "the remaining bookmark still responds to placement changes");
  h.identity(null, 1);
  assert.equal(h.meta.parentElement, null);
  assert.equal(h.user.classList.contains("tidy-message-meta-host"), false);
});
