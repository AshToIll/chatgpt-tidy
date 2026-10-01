const vm = require("node:vm");
const { loadMainRuntime } = require("./main-runtime.cjs");

function fiberElement({ props, ancestors = [], text = "", href = null, messageId = null, composedIds = null, role = null, sidebarItem = false, ariaLabel = null, attributes: extraAttributes = {} }) {
  const attributes = { "data-sidebar-item": sidebarItem ? "true" : null, "aria-label": ariaLabel, ...extraAttributes };
  const element = {
    childNodes: text ? [{ nodeType: 3, textContent: text }] : [],
    parentElement: { closest: () => null },
    getAttribute(name) {
      if (name === "href") return href;
      if (name === "data-message-id") return messageId;
      if (name === "data-chatgpt-search-message-ids") return composedIds;
      if (name === "data-message-author-role") return role;
      return attributes[name] ?? null;
    },
    setAttribute(name, value) { attributes[name] = value; },
    closest() { return null; },
    matches(selector) {
      return selector === "[data-message-author-role]" && Boolean(role);
    },
    querySelector(selector) {
      if (composedIds && selector.includes('data-markdown-text-style')) return { innerText: text };
      return null;
    },
  };
  element.__reactFiber$test = { memoizedProps: props, return: null };
  let fiber = element.__reactFiber$test;
  for (const ancestor of ancestors) { fiber.return = { memoizedProps: ancestor, return: null }; fiber = fiber.return; }
  return element;
}

function snapshotHarness({
  url,
  documentTitle = "ChatGPT",
  thread = null,
  sidebar = [],
  messages = [],
  backgroundColor = null,
  fetch = null,
  sessionFixture = null,
  titleAdapter = null,
  returnSession = false,
}) {
  const mountMessage = (message) =>
    fiberElement({
      messageId: message.item ? null : message.id,
      composedIds: message.item ? message.domIds ?? message.id : null,
      text: message.text || "",
      role: message.role,
      ancestors: message.ancestorProps,
      props: {
        conversation: thread,
        conversationId: message.conversationId,
        item: message.item,
        message: message.record,
        // A test's mounted position is never evidence of the global turn.
        // Missing numbering must remain missing just as on a virtualized page.
        turnIndex: message.turnIndex,
      },
    });
  const messageElements = messages.map(mountMessage);
  const sidebarElements = sidebar.map((item) =>
    fiberElement({
      href: item.href,
      text: item.title,
      sidebarItem: item.sidebarItem === true,
      ariaLabel: item.ariaLabel || null,
      attributes: item.attributes,
      props: item.room ? { room: item.room } : { historyItem: item.record },
    }),
  );
  const listeners = new Map();
  const documentListeners = new Map();
  const timers = new Map();
  const observers = [];
  const posted = [];
  const rootAttributes = new Map();
  const responseWaiters = new Map();
  let timerId = 0;

  const globals = {
    URL,
    Date,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    JSON,
    Map,
    Headers, AbortController, AbortSignal, Event,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    CSS: { escape: (value) => String(value) },
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
    location: { href: url, origin: new URL(url).origin },
    history: {
      pushState() {},
      replaceState() {},
    },
    queueMicrotask() {},
    setTimeout(callback) {
      timerId += 1;
      timers.set(timerId, callback);
      return timerId;
    },
    clearTimeout(id) { timers.delete(id); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.connected = false; observers.push(this); }
      observe() { this.connected = true; }
      disconnect() { this.connected = false; }
    },
    getComputedStyle() {
      return {
        colorScheme: "",
        backgroundColor: backgroundColor || "rgba(0, 0, 0, 0)",
      };
    },
    document: {
      title: documentTitle,
      cookie: "",
      documentElement: { dataset: {}, classList: { contains: () => false },
        setAttribute: (name, value) => rootAttributes.set(name, String(value)),
        getAttribute: name => rootAttributes.get(name) ?? null },
      body: null,
      querySelector(selector) {
        if (selector === "div[data-message-id]") return messageElements.find(element => element.getAttribute('data-message-id')) || null;
        return null;
      },
      querySelectorAll(selector) {
        if (selector === "div[data-message-id]") return messageElements.filter(element => element.getAttribute('data-message-id'));
        if (selector === "[data-chatgpt-search-message-ids]") return messageElements.filter(element => element.getAttribute('data-chatgpt-search-message-ids'));
        if (selector.startsWith("a[") || selector.includes("a[href")) return sidebarElements;
        return [];
      },
      addEventListener(type, listener) {
        if (!documentListeners.has(type)) documentListeners.set(type, new Set());
        documentListeners.get(type).add(listener);
      },
      removeEventListener(type, listener) { documentListeners.get(type)?.delete(listener); },
      dispatchEvent(event) { for (const listener of documentListeners.get(event.type) || []) listener(event); return true; },
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event) { for (const listener of listeners.get(event.type) || []) listener(event); return true; },
    postMessage(data) {
      posted.push(data);
      const envelope = data?.envelope;
      if (envelope?.kind === "response" && responseWaiters.has(envelope.requestId)) {
        responseWaiters.get(envelope.requestId)(envelope);
        responseWaiters.delete(envelope.requestId);
      }
    },
  };
  // Transport fixture: the real shared API performs session authentication
  // before the optional conversation read. Never bypass that API in tests.
  if (fetch) globals.fetch = function (url, options) {
    return url === "/api/auth/session" && sessionFixture
      ? Promise.resolve({ ok: true, status: 200, json: async () => sessionFixture })
      : fetch.call(this, url, options);
  };
  if (titleAdapter) globals.TidyChatgptTitles = titleAdapter;
  const context = vm.createContext(globals);
  const nativeHistory = { ...globals.history };
  const nativeFetch = globals.fetch;

  const session = loadMainRuntime(context);

  context.__messageListener = event => { for (const listener of listeners.get("message") || []) listener(event); };
  context.__posted = posted;
  context.__waitForResponse = (requestId) => new Promise((resolve) => responseWaiters.set(requestId, resolve));
  vm.runInContext(
    `globalThis.__readSnapshot = (payload = null) => {
      const request = TidyProtocol.request(TidyProtocol.Type.GET_SNAPSHOT, payload, "adapter-test");
      __messageListener({
        source: globalThis,
        origin: location.origin,
        data: {
          channel: TidyProtocol.WINDOW_CHANNEL,
          source: "chatgpt-isolated",
          envelope: request,
        },
      });
      return __posted.at(-1).envelope.payload;
    };
    globalThis.__requestTitle = (type, payload) => {
      const request = TidyProtocol.request(TidyProtocol.Type[type], payload, "adapter-title-test");
      const response = __waitForResponse(request.requestId);
      __messageListener({
        source: globalThis,
        origin: location.origin,
        data: { channel: TidyProtocol.WINDOW_CHANNEL, source: "chatgpt-isolated", envelope: request },
      });
      return response;
    };`,
    context,
  );

  const readSnapshot = (payload = null) => JSON.parse(JSON.stringify(context.__readSnapshot(payload)));
  return returnSession ? {
    context, session, nativeHistory, nativeFetch, timers, observers,
    emit: (type, event = {}) => { for (const listener of listeners.get(type) || []) listener({ type, ...event }); },
    listenerCount: type => listeners.get(type)?.size || 0,
    readSnapshot,
    requestTitle: async (type, payload) => JSON.parse(JSON.stringify(await context.__requestTitle(type, payload))),
    postedMessages: () => JSON.parse(JSON.stringify(posted)),
    snapshotEvents: () => JSON.parse(JSON.stringify(posted.filter((message) => message.envelope.type === context.TidyProtocol.Type.SNAPSHOT_UPDATED))),
    documentTitle: () => context.document.title,
    setCookie: (cookie) => { context.document.cookie = cookie; },
    setMessages: (next) => { messageElements.splice(0, messageElements.length, ...next.map(mountMessage)); },
    setLocation: (url) => { context.location.href = url; context.location.origin = new URL(url).origin; },
    sidebarText: (index = 0) => sidebarElements[index]?.childNodes[0]?.textContent,
    sidebarLabel: (index = 0) => sidebarElements[index]?.getAttribute("aria-label"),
    rerenderSidebarTitle: (index, title) => { sidebarElements[index].childNodes[0].textContent = title; },
  } : readSnapshot();
}


module.exports = { snapshotHarness };
