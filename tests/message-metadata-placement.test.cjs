const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");

// 这个最小 DOM 只模拟定位算法用到的原生 API；布局/悬停由真实浏览器回归负责。
class Element {
  constructor(tag = "div", attributes = {}) {
    this.tagName = tag.toUpperCase(); this.attributes = { ...attributes };
    this.dataset = {}; this.children = []; this.parentElement = null; this.moves = 0;
    this.className = attributes.class || "";
    this.textContent = "";
    this.classList = {
      contains: value => this.className.split(/\s+/).includes(value),
      add: value => { if (!this.classList.contains(value)) this.className = (this.className + " " + value).trim(); },
      remove: value => { this.className = this.className.split(/\s+/).filter(part => part !== value).join(" "); },
    };
  }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children.at(-1) || null; }
  get nextElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
  getAttribute(name) {
    if (name === "class") return this.className;
    const key = name.startsWith("data-") ? name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) : null;
    return key && Object.hasOwn(this.dataset, key) ? String(this.dataset[key]) : this.attributes[name] ?? null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  matches(selector) {
    if (selector.includes(",")) return selector.split(",").some(part => this.matches(part.trim()));
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    const attr = /^(\w+)?\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attr) return (!attr[1] || this.tagName === attr[1].toUpperCase())
      && (attr[3] === undefined ? this.getAttribute(attr[2]) !== null : this.getAttribute(attr[2]) === attr[3]);
    return this.tagName === selector.toUpperCase();
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll(selector) { return this.descendants().filter(node => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(node) { return node === this || this.descendants().includes(node); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); this.moves++; } }
  prepend(node) { node.remove(); node.parentElement = this; this.children.unshift(node); this.moves++; }
  insertBefore(node, reference) {
    if (node === reference) return node;
    if (reference == null) { this.append(node); return node; }
    assert.ok(this.children.includes(reference));
    node.remove(); node.parentElement = this; this.children.splice(this.children.indexOf(reference), 0, node); this.moves++;
    return node;
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement.moves++; this.parentElement = null;
  }
}

function harness({ composed = true, nestedActions = true } = {}) {
  const host = new Element("div", composed ? { "data-chatgpt-search-message-ids": "user-1" } : { "data-message-id": "user-1" });
  const column = new Element(), bubble = new Element("div", { "data-user-message-bubble": "" });
  const body = new Element(), actionBranch = new Element(), actions = new Element("div", { class: "turn-action-controls" });
  body.append(bubble);
  if (nestedActions) actionBranch.append(actions);
  else actions.classList.add("flat-actions");
  column.append(body, nestedActions ? actionBranch : actions); host.append(column);
  const context = vm.createContext({ document: { createElement: tag => new Element(tag) } });
  vm.runInContext(fs.readFileSync("src/platform/chatgpt/message-dom.js", "utf8"), context);
  return { api: context.TidyChatgptMessageDom, host, column, bubble, body, actions, actionBranch: nestedActions ? actionBranch : actions };
}
const settings = { role: "user", key: "conversation:user-1", position: "after" };
const owns = (kind) => { const node = new Element(); node.dataset.tidyOwned = kind; return node; };

for (const composed of [false, true]) test("metadata before user actions preserves exact " + (composed ? "composed" : "classic") + " message identity", () => {
  const h = harness({ composed }), nativeAttrs = JSON.stringify(h.host.attributes);
  const originalContent = h.api.contentRoot(h.host);
  const meta = h.api.ensureMetadata(h.host, settings);
  assert.deepEqual(h.column.children, [h.body, meta, h.actionBranch]);
  assert.equal(h.api.metadata(h.host), meta);
  assert.equal(meta.dataset.position, "after");
  assert.equal(meta.dataset.tidyKey, settings.key);
  assert.equal(meta.className, "tidy-message-meta tidy-message-meta--user");
  assert.ok(h.host.classList.contains("tidy-message-meta-host"));
  assert.equal(h.api.contentRoot(h.host), originalContent, "display insertion must not redefine source content");
  assert.equal(JSON.stringify(h.host.attributes), nativeAttrs, "never synthesize a legacy message ID");
  assert.equal(h.bubble.parentElement, h.body);
  assert.equal(h.actions.parentElement, h.actionBranch);
});

test("already correctly placed metadata is idempotent and native controls retain identity", () => {
  const h = harness(), meta = h.api.ensureMetadata(h.host, settings);
  const time = owns("message-time"), bookmark = owns("message-bookmark");
  meta.append(time, bookmark);
  const moves = [h.host.moves, h.column.moves, h.body.moves, h.actionBranch.moves, meta.moves];
  for (let index = 0; index < 5; index++) assert.equal(h.api.ensureMetadata(h.host, settings), meta);
  assert.deepEqual([h.host.moves, h.column.moves, h.body.moves, h.actionBranch.moves, meta.moves], moves);
  assert.deepEqual(meta.children, [time, bookmark]);
  assert.equal(h.actions.parentElement, h.actionBranch);
});

test("before and after relocate only metadata, retaining both owners and native sibling order", () => {
  const h = harness(), meta = h.api.ensureMetadata(h.host, settings);
  const time = owns("message-time"), bookmark = owns("message-bookmark"); meta.append(time, bookmark);
  h.api.ensureMetadata(h.host, { ...settings, position: "before" });
  assert.equal(h.host.firstElementChild, meta);
  assert.deepEqual(h.column.children, [h.body, h.actionBranch]);
  assert.equal(meta.dataset.position, "before");
  h.api.ensureMetadata(h.host, settings);
  assert.deepEqual(h.column.children, [h.body, meta, h.actionBranch]);
  assert.deepEqual(meta.children, [time, bookmark]);
  assert.equal(h.api.metadata(h.host), meta);
});

test("assistant keeps safe host-end placement, regardless of embedded user-like quoted content", () => {
  const h = harness();
  const meta = h.api.ensureMetadata(h.host, { ...settings, role: "assistant" });
  assert.equal(h.host.lastElementChild, meta);
  assert.deepEqual(h.column.children, [h.body, h.actionBranch]);
  assert.equal(meta.className, "tidy-message-meta tidy-message-meta--assistant");
});

test("flat native actions are also supported without wrapping or moving them", () => {
  const h = harness({ nestedActions: false }), meta = h.api.ensureMetadata(h.host, settings);
  assert.deepEqual(h.column.children, [h.body, meta, h.actions]);
  assert.equal(h.actions.parentElement, h.column);
});

test("picture-only user content and attachment branches remain ahead of the metadata row", () => {
  const h = harness(), image = new Element("img", { src: "fixture.png" }), attachment = new Element("a", { href: "fixture.pdf" });
  h.bubble.append(image); h.column.insertBefore(attachment, h.actionBranch);
  const meta = h.api.ensureMetadata(h.host, settings);
  assert.deepEqual(h.column.children, [h.body, attachment, meta, h.actionBranch]);
  assert.equal(h.bubble.textContent, "");
  assert.equal(image.parentElement, h.bubble);
  assert.equal(attachment.parentElement, h.column);
});

test("foreign nested messages cannot lend their metadata, bubble or action branch to their parent", () => {
  const h = harness(), foreign = new Element("div", { "data-message-id": "foreign" }), foreignBubble = new Element("div", { "data-user-message-bubble": "" });
  const foreignActions = new Element("div", { class: "turn-action-controls" }), foreignMeta = owns("message-meta");
  foreign.append(foreignBubble, foreignMeta, foreignActions); h.column.prepend(foreign);
  assert.equal(h.api.metadata(h.host), null);
  const meta = h.api.ensureMetadata(h.host, settings);
  assert.equal(h.api.metadata(h.host), meta);
  assert.equal(h.api.metadata(foreign), foreignMeta);
  assert.deepEqual(h.column.children, [foreign, h.body, meta, h.actionBranch]);
  assert.deepEqual(foreign.children, [foreignBubble, foreignMeta, foreignActions]);
});

test("TIDY-owned lookalike bubbles/actions do not enter the native placement boundary", () => {
  const h = harness(), owned = owns("fixture-widget");
  owned.append(new Element("div", { "data-user-message-bubble": "" }), new Element("div", { class: "turn-action-controls" }));
  h.column.prepend(owned);
  const meta = h.api.ensureMetadata(h.host, settings);
  assert.deepEqual(h.column.children, [owned, h.body, meta, h.actionBranch]);
});

for (const scenario of ["missing-bubble", "missing-actions", "two-bubbles", "two-actions", "reverse-order", "actions-inside-bubble"]) {
  test("ambiguous or editing-like native layout safely falls back: " + scenario, () => {
    const h = harness();
    if (scenario === "missing-bubble") h.bubble.removeAttribute("data-user-message-bubble");
    if (scenario === "missing-actions") h.actions.className = "editing-buttons";
    if (scenario === "two-bubbles") h.body.append(new Element("div", { "data-user-message-bubble": "" }));
    if (scenario === "two-actions") h.actionBranch.append(new Element("div", { class: "turn-action-controls" }));
    if (scenario === "reverse-order") h.column.prepend(h.actionBranch);
    if (scenario === "actions-inside-bubble") h.bubble.append(h.actions);
    const original = [...h.column.children], meta = h.api.ensureMetadata(h.host, settings);
    assert.equal(h.host.lastElementChild, meta);
    assert.deepEqual(h.column.children, original);
  });
}

test("React replacing action branch repositions one existing row; removing it uses safe fallback", () => {
  const h = harness(), meta = h.api.ensureMetadata(h.host, settings);
  const bookmark = owns("message-bookmark"); meta.append(bookmark);
  h.actionBranch.remove();
  assert.equal(h.api.ensureMetadata(h.host, settings), meta);
  assert.equal(h.host.lastElementChild, meta);
  const newBranch = new Element(), newActions = new Element("div", { class: "turn-action-controls" });
  newBranch.append(newActions); h.column.append(newBranch);
  assert.equal(h.api.ensureMetadata(h.host, settings), meta);
  assert.deepEqual(h.column.children, [h.body, meta, newBranch]);
  assert.equal(meta.firstElementChild, bookmark);
});

test("React replacing a complete body branch creates only one reachable new metadata row", () => {
  const h = harness(), oldMeta = h.api.ensureMetadata(h.host, settings);
  h.column.remove();
  const replacement = new Element(), bubble = new Element("div", { "data-user-message-bubble": "" }), actions = new Element("div", { class: "turn-action-controls" });
  replacement.append(bubble, actions); h.host.append(replacement);
  const nextMeta = h.api.ensureMetadata(h.host, settings);
  assert.notEqual(nextMeta, oldMeta);
  assert.equal(h.api.metadata(h.host), nextMeta);
  assert.deepEqual(replacement.children, [bubble, nextMeta, actions]);
  assert.equal(oldMeta.parentElement, h.column, "do not revive a detached native subtree");
});

for (const first of ["message-time", "message-bookmark"]) test("shared row survives " + first + " retirement until both owners leave", () => {
  const h = harness(), meta = h.api.ensureMetadata(h.host, settings);
  const time = owns("message-time"), bookmark = owns("message-bookmark"); meta.append(time, bookmark);
  (first === "message-time" ? time : bookmark).remove();
  h.api.removeEmptyMetadata(meta);
  assert.equal(h.api.metadata(h.host), meta);
  assert.ok(h.host.classList.contains("tidy-message-meta-host"));
  (first === "message-time" ? bookmark : time).remove();
  h.api.removeEmptyMetadata(meta);
  assert.equal(meta.parentElement, null);
  assert.equal(h.api.metadata(h.host), null);
  assert.equal(h.host.classList.contains("tidy-message-meta-host"), false, "cleanup targets exact host, not nested layout column");
  assert.deepEqual(h.column.children, [h.body, h.actionBranch]);
});

test("empty-row cleanup never removes native nodes or the parent class while another shared row exists", () => {
  const h = harness(), meta = h.api.ensureMetadata(h.host, settings), second = owns("message-meta");
  second.append(owns("message-bookmark")); h.host.append(second);
  h.api.removeEmptyMetadata(h.bubble);
  assert.equal(h.bubble.parentElement, h.body);
  h.api.removeEmptyMetadata(meta);
  assert.equal(h.api.metadata(h.host), second);
  assert.ok(h.host.classList.contains("tidy-message-meta-host"));
});
