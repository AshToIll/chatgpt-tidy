const assert = require("node:assert/strict");
const { createPanelRuntime } = require("./panel-runtime.cjs");
const { createFixture } = require("./title-performance-dom.cjs");

// Algorithm-only DOM: retain the production stable-list patcher and event flow.
// Real focus geometry and CSS are checked by the library-lifecycle browser test.
// Compare DOM identities as booleans: failed assertions must not dump the entire
// linked fixture tree (parent/sibling cycles can produce enormous diagnostic output).
function createLibraryViewHarness(kind = "favorites", runtimeGlobals = {}) {
  const stats = new Proxy({}, { get: (target, key) => target[key] || 0 });
  const fixture = createFixture(stats), { root, document } = fixture;
  const frames = [], actions = [], docEvents = new Map(), rootEvents = new Map();
  const enhanced = new WeakSet();
  function all(node) { return node.childNodes.flatMap(child => [child, ...all(child)]); }
  function simple(node, selector) {
    if (node.nodeType !== 1) return false;
    const tag = selector.match(/^[a-zA-Z]+/);
    if (tag && node.nodeName !== tag[0].toUpperCase()) return false;
    for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) {
      if (!String(node.getAttribute("class") || "").split(/\s+/).includes(name)) return false;
    }
    for (const [, name, quoted, bare] of selector.matchAll(/\[([^\]=]+)(?:=(?:"([^"]*)"|([^\]]+)))?\]/g)) {
      if (!node.hasAttribute(name)) return false;
      if ((quoted ?? bare) !== undefined && node.getAttribute(name) !== (quoted ?? bare)) return false;
    }
    return true;
  }
  function matches(node, selector) {
    return selector.split(",").some(part => {
      const steps = part.trim().split(/\s+(?![^\[]*\])/);
      if (!simple(node, steps.pop())) return false;
      let parent = node.parentNode;
      while (steps.length) {
        const step = steps.pop();
        while (parent && !simple(parent, step)) parent = parent.parentNode;
        if (!parent) return false;
        parent = parent.parentNode;
      }
      return true;
    });
  }
  function enhance(node) {
    if (!node || enhanced.has(node)) return node;
    enhanced.add(node);
    node.matches = selector => matches(node, selector);
    node.closest = selector => { for (let next = node; next; next = next.parentNode) if (matches(next, selector)) return enhance(next); return null; };
    node.querySelectorAll = selector => all(node).filter(child => matches(child, selector)).map(enhance);
    node.querySelector = selector => node.querySelectorAll(selector)[0] || null;
    node.getBoundingClientRect = () => ({ top: 20, bottom: 51, right: 280, left: 0, width: 280 });
    node.focus = () => { document.activeElement = node; };
    node.select = () => { node.focus(); node.selectionStart = 0; node.selectionEnd = node.value.length; };
    node.blur = () => { if (document.activeElement === node) document.activeElement = null; };
    node.replaceChildren = (...children) => { for (const child of [...node.childNodes]) child.remove(); for (const child of children) node.append(child); };
    Object.defineProperty(node, "firstElementChild", { get: () => enhance(node.childNodes.find(child => child.nodeType === 1)) || null });
    node.classList = {
      contains: name => String(node.getAttribute("class") || "").split(/\s+/).includes(name),
      remove: (...names) => node.setAttribute("class", String(node.getAttribute("class") || "").split(/\s+/).filter(name => !names.includes(name)).join(" ")),
      add: (...names) => node.setAttribute("class", [...new Set([...String(node.getAttribute("class") || "").split(/\s+/), ...names])].join(" ")),
    };
    Object.defineProperty(node, "isConnected", { get: () => node === root || root.contains(node) });
    node.clientHeight = 220; node.scrollHeight = 440;
    node.style = {};
    node.offsetHeight = 90; node.offsetWidth = 112;
    return node;
  }
  enhance(root);
  // Dispatch capture before the view's handler, then bubble: both shared
  // dismissal listeners must run instead of one overwriting the other.
  const add = (events, name, callback, options) => {
    const entries = events.get(name) || [];
    entries.push({ callback, capture: options === true || options?.capture === true }); events.set(name, entries);
  };
  const remove = (events, name, callback) => events.set(name, (events.get(name) || []).filter(entry => entry.callback !== callback));
  root.addEventListener = (name, callback, options) => add(rootEvents, name, callback, options);
  root.removeEventListener = (name, callback) => remove(rootEvents, name, callback);
  document.addEventListener = (name, callback, options) => add(docEvents, name, callback, options);
  document.removeEventListener = (name, callback) => remove(docEvents, name, callback);
  // Optional format/snapshot boundaries for legacy rendering assertions. The
  // production module graph and fixture DOM/event ownership remain unchanged.
  const runtime = createPanelRuntime({
    ...runtimeGlobals,
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    window: { addEventListener() {}, removeEventListener() {} }, document,
    FormData: class { constructor(form) { this.form = form; } get(name) { return this.form.querySelector(`[name="${name}"]`)?.value; } },
    Event: class { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } },
  });
  // Read the actual diagnostics allowlists/adapter, not a recorder stub: clear
  // events consume reasonCode and export it as clearReasonCode.
  for (const file of ["src/messages/build-info.js", "src/messages/notice-registry.js", "src/messages/notice-lifecycle.js", "src/messages/diagnostics.js"]) runtime.load(file);
  const domain = runtime.load("src/features/" + kind + "/storage/" + kind + "-domain.js");
  const factory = runtime.load("src/features/" + kind + "/ui/" + kind + "-view.js");
  const isBookmarks = kind === "bookmarks";
  let model = { store: isBookmarks ? domain.createEmptyBookmarksState() : domain.createEmptyFavoritesState(), preferences: { timeDisplayEnabled: false }, snapshot: null, t: key => key };
  const confirmations = [];
  let activeConfirmation = null;
  const confirmation = {
    ask(options) { confirmations.push(options); return new Promise(resolve => { activeConfirmation = { options, resolve }; }); },
    cancel({ owner } = {}) { if (activeConfirmation && (!owner || owner === activeConfirmation.options.owner)) { activeConfirmation.resolve(false); activeConfirmation = null; } },
  };
  function answerConfirmation(answer) { const active = activeConfirmation; activeConfirmation = null; active?.resolve(answer); }
  const view = (isBookmarks ? factory.createBookmarksView : factory.createFavoritesView)({ root, confirmation, onAction: (type, payload) => { actions.push({ type, payload }); return new Promise(() => {}); } });
  function flush() { while (frames.length) frames.shift()(); }
  function render(patch = {}) { model = { ...model, ...patch }; view.render(model); flush(); }
  function event(name, target, options = {}) {
    const e = { target: enhance(target), preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...options };
    for (const entry of docEvents.get(name) || []) if (entry.capture && !e.stopped) entry.callback(e);
    for (const entry of rootEvents.get(name) || []) if (!e.stopped) entry.callback(e);
    for (const entry of docEvents.get(name) || []) if (!entry.capture && !e.stopped) entry.callback(e);
    return e;
  }
  function click(selector) { const target = root.querySelector(selector); assert.ok(target, `click target ${selector}`); event("click", target); flush(); }
  function input(value) { const target = root.querySelector('[name="name"]'); target.value = value; event("input", target); return target; }
  function submit() { const form = root.querySelector(isBookmarks ? "[data-bookmark-new-group], [data-bookmark-group-rename]" : "[data-new-group], [data-group-rename]"); event("submit", form); flush(); }
  function openRename() { click(isBookmarks ? '[data-bookmark-group-menu="bookmark-quote"]' : '[data-group-menu="study"]'); click(isBookmarks ? '[data-bookmark-group-action="rename"]' : '[data-group-action="rename"]'); }
  function seedFavorites() {
    const now = "2026-10-01T00:00:00.000Z";
    const item = id => ({ conversationId: id, title: id, routePath: "/c/" + id,
      groupId: "study", savedAt: now, createdAt: now, updatedAt: now, metadataRefreshedAt: now, note: "keep note" });
    render({ store: { ...model.store, items: { "favorite-a": item("favorite-a"), "favorite-b": item("favorite-b") } }, bookmarkCounts: { "favorite-a": 2 } });
  }
  function seedBookmarks() {
    const item = id => ({ bookmarkId: id, conversationId: "conversation-a", messageId: id, conversationTitle: "Test", excerpt: "saved excerpt", role: "assistant", groupId: "bookmark-quote", bookmarkedAt: "2026-10-01T00:00:00.000Z" });
    render({ store: { ...model.store, view: { ...model.store.view, groupId: "all" }, items: { "bookmark-a": item("bookmark-a"), "bookmark-b": item("bookmark-b") } } });
  }
  render();
  return { root, document, view, actions, seedFavorites, seedBookmarks, confirmations, answerConfirmation, get notices() { return runtime.context.ChatGPTTidyDiagnostics.snapshot().events; }, render, event, click, input, submit, openRename, flush, get model() { return model; } };
}

module.exports = { createLibraryViewHarness };
