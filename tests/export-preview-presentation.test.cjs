const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { installPageSession } = require("./helpers/page-session.cjs");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/features/export/chatgpt/export-preview-presentation.js"), "utf8");

class Target {
  listeners = new Map();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event) {
    for (const listener of [...(this.listeners.get(event.type) || [])]) listener(event);
    return !event.defaultPrevented;
  }
  listenerCount() { return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0); }
}

class Element extends Target {
  constructor(tag, document) {
    super();
    this.tagName = tag;
    this.document = document;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.classes = new Set();
    this.classList = { add: (...values) => values.forEach(value => this.classes.add(value)), remove: value => this.classes.delete(value) };
    this.captured = new Set();
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  attachShadow() { this.shadowRoot = new Element("shadow", this.document); this.shadowRoot.parent = this; return this.shadowRoot; }
  get isConnected() { return this === this.document.documentElement || Boolean(this.parent?.isConnected); }
  getBoundingClientRect() { return { left: 50, right: 550, top: 50, bottom: 450, width: 500, height: 400 }; }
  closest(selector) { return this.tagName === selector ? this : null; }
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
  showModal() { this.open = true; this.document.onShow?.(this); }
  close() { this.open = false; }
}

function setup({ session = true, sendMessage } = {}) {
  const window = new Target(), document = new Target(), elements = [];
  document.createElement = tag => { const node = new Element(tag, document); elements.push(node); return node; };
  document.documentElement = document.createElement("html");
  const messages = [], receivers = new Set();
  const runtime = { id: "test-extension", onMessage: {
    addListener: listener => receivers.add(listener), removeListener: listener => receivers.delete(listener),
  }, sendMessage: envelope => { messages.push(envelope); return sendMessage?.(envelope) ?? Promise.resolve({}); } };
  const context = vm.createContext({ document, chrome: { runtime }, innerWidth: 1000, innerHeight: 800,
    addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window),
    TidyExportPreview: { styles: "", valid: () => true },
  });
  vm.runInContext(fs.readFileSync(path.join(root, "src/platform/protocol.js"), "utf8"), context);
  const pageSession = session ? installPageSession(context, { runtime: true }) : null;
  vm.runInContext(source, context);
  const protocol = context.TidyProtocol;
  const receiver = [...receivers][0];
  function request(type, payload) {
    let response;
    receiver(protocol.request(type, payload), {}, value => { response = value; });
    return response;
  }
  function open(sessionId = "preview-test") {
    return request(protocol.Type.EXPORT_PREVIEW_OPEN, {
      sessionId, title: "Preview", closeLabel: "Close", summary: "Test", content: "plain text", format: "txt",
    });
  }
  const last = tag => elements.filter(node => node.tagName === tag).at(-1);
  return { window, document, elements, runtime, messages, receivers, pageSession, protocol, request, open, last };
}

function event(type, target, extra = {}) {
  return { type, target, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("export preview requires the page lifecycle, with no standalone runtime fallback", () => {
  const fixture = setup({ session: false });
  assert.equal(fixture.receivers.size, 0);
  assert.equal(fixture.document.documentElement.children.length, 0);
});

test("user close sends one owned receipt and removes every modal listener", async () => {
  const fixture = setup();
  assert.equal(fixture.open().ok, true);
  const close = fixture.last("button"), dialog = fixture.last("dialog");
  assert.equal(dialog.open, true);
  assert.equal(fixture.window.listenerCount(), 2);
  close.dispatchEvent(event("click", close));
  close.dispatchEvent(event("click", close));
  await settle();
  assert.equal(dialog.open, false);
  assert.equal(fixture.document.documentElement.children.length, 0);
  assert.equal(fixture.window.listenerCount(), 0);
  assert.equal(fixture.elements.reduce((count, node) => count + node.listenerCount(), 0), 0);
  assert.equal(fixture.receivers.size, 1);
  assert.equal(fixture.messages.length, 1);
  assert.equal(fixture.messages[0].type, fixture.protocol.Type.EXPORT_PREVIEW_CLOSED);
  assert.equal(fixture.messages[0].payload.sessionId, "preview-test");
});

test("clicking an old preview after runtime invalidation disposes it silently", async () => {
  const fixture = setup();
  fixture.open();
  const close = fixture.last("button"), dialog = fixture.last("dialog");
  fixture.runtime.id = undefined;
  close.dispatchEvent(event("click", close));
  await settle();
  assert.equal(fixture.pageSession.signal.aborted, true);
  assert.equal(fixture.receivers.size, 0);
  assert.equal(fixture.window.listenerCount(), 0);
  assert.equal(dialog.open, false);
  assert.equal(fixture.document.documentElement.children.length, 0);
  assert.equal(fixture.messages.length, 0);
  assert.equal(fixture.open("late-open"), undefined, "A captured old runtime listener must not reopen UI");
  assert.equal(fixture.document.documentElement.children.length, 0);
});

test("page retirement releases drag capture and removes DOM, keyboard and pointer handlers", () => {
  const fixture = setup();
  fixture.open();
  const header = fixture.last("header"), dialog = fixture.last("dialog");
  header.dispatchEvent(event("pointerdown", header, { button: 0, pointerId: 7, clientX: 80, clientY: 80 }));
  assert.equal(header.hasPointerCapture(7), true);
  fixture.pageSession.stop();
  assert.equal(header.hasPointerCapture(7), false);
  assert.equal(dialog.open, false);
  assert.equal(fixture.receivers.size, 0);
  assert.equal(fixture.window.listenerCount(), 0);
  assert.equal(fixture.elements.reduce((count, node) => count + node.listenerCount(), 0), 0);
  assert.equal(fixture.document.documentElement.children.length, 0);
  assert.equal(fixture.messages.length, 0);
});

test("late worker requests cannot open or acknowledge UI after runtime invalidation", () => {
  const fixture = setup();
  fixture.runtime.id = undefined;
  assert.equal(fixture.open("late-open"), undefined);
  assert.equal(fixture.request(fixture.protocol.Type.EXPORT_PREVIEW_CLOSE, { sessionId: "late-open" }), undefined);
  assert.equal(fixture.receivers.size, 0);
  assert.equal(fixture.document.documentElement.children.length, 0);
  assert.equal(fixture.messages.length, 0);
});

test("invalidation during showModal removes the new modal and suppresses its response", () => {
  const fixture = setup();
  fixture.document.onShow = () => { fixture.runtime.id = undefined; };
  assert.equal(fixture.open(), undefined);
  assert.equal(fixture.last("dialog").open, false);
  assert.equal(fixture.receivers.size, 0);
  assert.equal(fixture.document.documentElement.children.length, 0);
  assert.equal(fixture.messages.length, 0);
});

test("a late close-notification completion cannot revive the retired page", async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const fixture = setup({ sendMessage: () => pending });
  fixture.open();
  fixture.last("button").dispatchEvent(event("click", fixture.last("button")));
  assert.equal(fixture.messages.length, 1);
  fixture.runtime.id = undefined;
  resolve({});
  await settle();
  assert.equal(fixture.pageSession.signal.aborted, true);
  assert.equal(fixture.receivers.size, 0);
  assert.equal(fixture.document.documentElement.children.length, 0);
  assert.equal(fixture.messages.length, 1);
});

test("replacement previews retain ownership and worker close never emits a user receipt", () => {
  const fixture = setup();
  fixture.open("old");
  const oldClose = fixture.last("button");
  fixture.open("new");
  oldClose.dispatchEvent(event("click", oldClose));
  assert.equal(fixture.request(fixture.protocol.Type.EXPORT_PREVIEW_CLOSE, { sessionId: "old" }).payload.closed, false);
  assert.equal(fixture.last("dialog").open, true);
  assert.equal(fixture.request(fixture.protocol.Type.EXPORT_PREVIEW_CLOSE, { sessionId: "new" }).payload.closed, true);
  assert.equal(fixture.document.documentElement.children.length, 0);
  assert.equal(fixture.messages.length, 0);
});
