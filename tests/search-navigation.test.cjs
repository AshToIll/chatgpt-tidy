const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { installPageSession } = require("./helpers/page-session.cjs");
const { loadMainModule, mainSourceFiles } = require("./helpers/main-runtime.cjs");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };

function element(tag, attributes = {}, children = []) {
  const node = {
    nodeType: 1, tagName: tag.toUpperCase(), attributes, children: [], parentElement: null,
    isConnected: true, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    style: { overflowY: "visible", display: "block", visibility: "visible" },
    getAttribute(name) { return this.attributes[name] ?? null; },
    setAttribute(name, value) { this.attributes[name] = value; },
    contains(node) { for (; node; node = node.parentElement) if (node === this) return true; return false; },
    getBoundingClientRect() { return { top: 300, height: 100 }; },
    matches(selector) {
      return selector.split(/,\s*/).some((part) => {
        if (part.startsWith(".")) return (this.attributes.class || "").split(/\s+/).includes(part.slice(1));
        if (part === '[class~="prose"]') return (this.attributes.class || "").split(/\s+/).includes("prose");
        const attr = part.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
        if (attr) return Object.hasOwn(this.attributes, attr[1]) && (attr[2] === undefined || this.attributes[attr[1]] === attr[2]);
        return this.tagName.toLowerCase() === part;
      });
    },
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; },
    querySelector(selector) {
      for (const child of this.children) {
        if (child.nodeType !== 1) continue;
        if (child.matches(selector)) return child;
        const match = child.querySelector(selector);
        if (match) return match;
      }
      return null;
    },
    querySelectorAll(selector) {
      return this.children.filter(child => child.nodeType === 1)
        .flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    },
    append(...nodes) { for (const child of nodes) { child.parentElement = this; this.children.push(child); } },
    scrollCalls: [],
    scrollTo(value) { this.lastScroll = value; this.scrollCalls.push(value); },
  };
  for (const child of children) node.append(typeof child === "string" ? { nodeType: 3, textContent: child } : child);
  return node;
}

function harness({ url = "https://chatgpt.com/c/conversation-1", children = ["a bookmark body here"], session = null,
  isIntentCurrent = () => true, onResolve = null } = {}) {
  let now = 0;
  let mounted = true;
  const timers = new Set();
  const highlights = new Map();
  const head = element("head");
  const root = element("html");
  const body = element("body");
  const content = element("div", { class: "markdown" }, children);
  const message = element("div", { "data-message-id": "message-1", "data-message-author-role": "assistant" }, [content]);
  const other = element("div", { "data-message-id": "other", "data-message-author-role": "assistant" }, ["needle"]);
  const viewport = element("main", {}, [message, other]);
  viewport.scrollHeight = 5000;
  viewport.clientHeight = 500;
  viewport.style.overflowY = "auto";
  const box = (top, height) => ({ top, bottom: top + height, height, left: 0, right: 800, width: 800 });
  viewport.clientWidth = 800; viewport.clientLeft = 0; viewport.clientTop = 0;
  viewport.getBoundingClientRect = () => box(10, 500);
  viewport.scrollTo = value => { viewport.lastScroll = value; viewport.scrollCalls.push(value); viewport.scrollTop = value.top; };
  for (const node of [message, other]) node.getBoundingClientRect = () => box(300 - viewport.scrollTop, 100);
  body.append(viewport);
  root.append(head, body);
  const calls = [];
  const document = {
    head, body, documentElement: root, readyState: 'complete',
    addEventListener() {}, removeEventListener() {},
    createElement: (tag) => element(tag),
    createTreeWalker(target) {
      const nodes = [];
      function visit(node) { if (node.nodeType === 3) nodes.push(node); else node.children.forEach(visit); }
      visit(target);
      let index = 0;
      return { nextNode: () => nodes[index++] || null };
    },
    createRange() { throw Error("Bookmark navigation must not create keyword ranges"); },
  };
  const listeners = new Map();
  let sessionReads = 0;
  const context = vm.createContext({
    URL, document, innerHeight: 900, innerWidth: 1000, location: { href: url, origin: "https://chatgpt.com" },
    Date: { now: () => now },
    CSS: { highlights },
    Highlight: class { constructor() { throw Error("Tidy must never create a keyword highlight"); } },
    getComputedStyle: (node) => node.style,
    setTimeout(callback, delay) { const timer = { callback, at: now + delay }; timers.add(timer); return timer; },
    clearTimeout: (timer) => timers.delete(timer),
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    ...(session ? { fetch: async () => {
      sessionReads++;
      const value = await session();
      return { ok: true, status: 200, json: async () => value, clone: () => ({ json: async () => value }) };
    } } : {}),
  });
  // The API fixture shares the real document lifetime used by MAIN.
  installPageSession(context);
  vm.runInContext(read("src/platform/navigation/navigation-identity.js") + read("src/platform/navigation/chatgpt/navigation-intent.js"), context);
  if (session) vm.runInContext(read("src/platform/chatgpt/api.js"), context);
  for (const file of ["src/platform/snapshot.js", "src/platform/chatgpt/route.js", "src/platform/chatgpt/message-dom.js", "src/platform/navigation/chatgpt/message-location.js", "src/platform/navigation/chatgpt/message-navigation.js"]) {
    vm.runInContext(read(file), context, { filename: file });
  }
  let navigation;
  // Exercise the real page gate. Identity lifetime no longer belongs to the
  // bookmark adapter, so the fixture wires the same API -> gate path as MAIN.
  const pageGate = context.TidyChatgptNavigationIntent.create({
    parseRoute: () => context.TidyChatgptRoute.parse(),
    readIdentity: () => context.TidyChatgptApi?.checkLibraryIdentity() || { phase: "ready", accountKey: "fixture-owner", epoch: 1 },
    onRevoked: ({navigationIntentId, reason}) => navigation?.cancelId(navigationIntentId, reason),
  });
  context.TidyChatgptApi?.onLibraryIdentityChanged(identity => pageGate.observeIdentity(identity));
  pageGate.observe({ navigationIntentId: "fixture-bookmark", workerEpoch: 1, sequence: 1, phase: "active", conversationId: context.TidyChatgptRoute.parse().conversationId, ownerAccountKey: null });
  const resolveTarget = target => {
      calls.push(plain(target));
      const override = onResolve?.(target, { navigation, message, other, viewport });
      if (override !== undefined) return override;
      return mounted && target.messageId === "message-1" ? { element: message,
        contentReady: context.TidyChatgptMessageNavigation.hasRenderedContent(message, document) } : { reason: "message-not-present" };
    };
  const location = context.TidyChatgptMessageLocation.create({ document, resolveTarget,
    assertCurrent: payload => { if (!isIntentCurrent(payload.navigationIntentId) || !pageGate.isCurrent('fixture-bookmark')) throw Error('revoked'); return pageGate.canPresent('fixture-bookmark'); },
    onCancelled: (payload, reason) => navigation?.cancelId(payload.navigationIntentId, reason),
  });
  navigation = context.TidyChatgptMessageNavigation.create({ document, isIntentCurrent: id => isIntentCurrent(id) && pageGate.isCurrent("fixture-bookmark"),
    canPresent: () => pageGate.canPresent("fixture-bookmark"), resolveTarget,
    locate: payload => location.start(payload), cancelLocation: (id, reason) => location.cancelId(id, reason),
  });
  return { context, navigation, highlights, head, message, content, other, viewport, calls, timers,
    payload: { conversationId: "conversation-1", messageId: "message-1", navigationIntentId: "fixture-bookmark", waitForTarget: true },
    setMounted(value) { mounted = value; },
    get sessionReads() { return sessionReads; },
    emit(type) { for (const listener of listeners.get(type) || []) listener({ type }); },
    async observeSession() { await context.fetch("/api/auth/session"); for (let n = 0; n < 8; n++) await Promise.resolve(); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const timer = [...timers].sort((left, right) => left.at - right.at)[0];
        if (!timer || timer.at > end) break;
        now = timer.at;
        timers.delete(timer);
        timer.callback();
        await flush();
      }
      now = end;
    },
    route(url) { context.location.href = url; pageGate.routeChanged(); return navigation.getStatus(); },
  };
}

// Search result handoff is covered through the native navigation worker tests.
// This suite keeps the independent bookmark executor honest: native URLs alone
// cannot start it, while explicit bookmarks retain real geometry and readiness.
test("native history-search URL never starts Tidy message positioning or highlighting", async () => {
  const url = "https://chatgpt.com/c/conversation-1?src=history_search&messageId=message-1&historySearchQuery=needle";
  const h = harness({ url });
  const nativeHighlight = {};
  h.highlights.set("native-search", nativeHighlight);
  await h.advance(15000);
  h.route(url.replace("needle", "another"));
  h.route("https://chatgpt.com/c/conversation-1");
  await h.advance(15000);
  assert.equal(h.navigation.routeChanged, undefined, "There is no URL nomination API to restart the locator");
  assert.equal(h.calls.length, 0);
  assert.equal(h.viewport.scrollCalls.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.navigation.getStatus().reason, "idle");
  assert.equal(h.highlights.get("native-search"), nativeHighlight);
  const main = mainSourceFiles().map(read).join("\n");
  assert.doesNotMatch(main, /messageNavigation\??\.routeChanged\s*\(/);
  assert.doesNotMatch(main, /requestNavigation\s*:/);
  assert.doesNotMatch(main, /TidyChatgptMessageNavigation\.prepare\s*\(/);
});

test("bookmark adapter has no keyword paint API and does not pass query to the locator", async () => {
  const h = harness();
  assert.deepEqual(Object.keys(h.context.TidyChatgptMessageNavigation).sort(), ["create", "hasRenderedContent"]);
  const nativeHighlight = {};
  h.highlights.set("native-search", nativeHighlight);
  h.navigation.start({ ...h.payload, query: "unused legacy keyword" });
  await h.advance(1500);
  assert.equal(h.navigation.getStatus().located, true);
  assert.equal(h.navigation.getStatus().highlighted, false);
  assert.ok(h.calls.every(call => !Object.hasOwn(call, "query")));
  h.navigation.clear(); h.navigation.dispose();
  assert.equal(h.highlights.size, 1);
  assert.equal(h.highlights.get("native-search"), nativeHighlight);
  assert.equal(h.head.children.length, 0, "No Tidy keyword stylesheet is installed");
});

test("a same-workspace user change cancels bookmark retries without scrolling the next owner's DOM", async () => {
  let user = "user-a";
  const h = harness({ session: () => ({ user: { id: user }, accessToken: "fixture-token" }) });
  await h.context.TidyChatgptApi.readLibraryAccount();
  h.setMounted(false); h.navigation.start(h.payload);
  assert.equal(h.timers.size, 1);
  user = "user-b"; await h.observeSession();
  assert.equal(h.timers.size, 0);
  assert.equal(h.navigation.getStatus().reason, "identity-changed");
  const calls = h.calls.length;
  h.setMounted(true); await h.advance(15000);
  assert.equal(h.calls.length, calls); assert.equal(h.viewport.scrollCalls.length, 0);
  assert.equal(h.sessionReads, 2, "Only explicit fixture proofs request sessions");
});

test("owner, workspace and pagehide boundaries retire completed bookmarks without clearing native highlights", async () => {
  for (const boundary of ["owner", "workspace", "pagehide"]) {
    let user = "user-a";
    const h = harness({ session: () => ({ user: { id: user }, accessToken: "fixture-token" }) });
    const nativeHighlight = {}; h.highlights.set("native-search", nativeHighlight);
    await h.context.TidyChatgptApi.readLibraryAccount(); h.navigation.start(h.payload); await h.advance(1500);
    assert.equal(h.navigation.getStatus().located, true);
    if (boundary === "owner") { user = "user-b"; await h.observeSession(); }
    else if (boundary === "workspace") { h.context.document.cookie = "_account=other"; h.context.TidyChatgptApi.checkLibraryIdentity(); }
    else h.emit("pagehide");
    assert.equal(h.highlights.get("native-search"), nativeHighlight, boundary);
    assert.equal(h.navigation.getStatus().pending, false);
    assert.equal(h.navigation.getStatus().reason, boundary === "pagehide" ? "page-hidden" : "identity-changed");
    await h.advance(15000); assert.equal(h.viewport.scrollCalls.length, 1, "No boundary-driven re-scroll");
  }
});

test("initial and renewed same-owner proofs preserve an explicit pending bookmark without extra authentication", async () => {
  const h = harness({ session: () => ({ user: { id: "user-a" }, accessToken: "fixture-token" }) });
  h.setMounted(false); h.navigation.start(h.payload);
  assert.equal(h.sessionReads, 0);
  await h.context.TidyChatgptApi.readLibraryAccount();
  assert.equal(h.timers.size, 1);
  await h.observeSession(); assert.equal(h.timers.size, 1);
  h.setMounted(true); await h.advance(1500);
  assert.equal(h.navigation.getStatus().located, true);
  const scrolls = h.viewport.scrollCalls.length;
  await h.observeSession();
  assert.equal(h.viewport.scrollCalls.length, scrolls);
  assert.equal(h.sessionReads, 3);
});

test("mounted bookmark uses the common physical executor without changing native text", async () => {
  const h = harness(), text = h.content.children[0];
  h.navigation.start(h.payload); await h.advance(1500);
  assert.deepEqual(plain(h.navigation.getStatus()), {
    located: true, highlighted: false, highlightReason: null, reason: null, pending: false, scrolls: 1, loads: 0,
  });
  assert.equal(h.viewport.scrollCalls.length, 1);
  assert.equal(h.content.children[0], text);
  assert.equal(text.textContent, "a bookmark body here");
  assert.equal(h.highlights.size, 0);
  assert.equal(h.timers.size, 0);
});

test("a new missing bookmark replaces the previous target without another scroll", async () => {
  const h = harness();
  h.navigation.start(h.payload); await h.advance(1500);
  const result = h.navigation.start({ ...h.payload, messageId: "unmounted", waitForTarget: false });
  assert.equal(result.located, false); assert.equal(result.pending, true);
  assert.equal(result.targetPresent, false); assert.equal(result.reason, "message-not-present");
  assert.equal(h.viewport.scrollCalls.length, 1); assert.equal(h.timers.size, 0);
});

test("an explicit bookmark waits for its exact late-mounted target without a second navigation", async () => {
  const h = harness(); h.setMounted(false);
  h.navigation.start({ ...h.payload, loadDeadlineAt: 12000, deadlineAt: 14400 });
  await h.advance(4000);
  assert.equal(h.navigation.getStatus().pending, true); assert.equal(h.viewport.scrollCalls.length, 0);
  h.setMounted(true); await h.advance(1500);
  assert.equal(h.navigation.getStatus().located, true); assert.equal(h.timers.size, 0);
  assert.ok(h.calls.every(call => call.messageId === "message-1"));
});

test("a missing explicit bookmark times out once and a route event cannot revive it", async () => {
  const h = harness(); h.setMounted(false);
  h.navigation.start({ ...h.payload, loadDeadlineAt: 5000, deadlineAt: 7400 });
  await h.advance(8000);
  assert.equal(h.navigation.getStatus().located, false);
  assert.equal(h.navigation.getStatus().reason, "target-timeout");
  assert.equal(h.context.TidyChatgptMessageLocation.getLastDiagnostic().targetReason, "message-not-present");
  const calls = h.calls.length;
  h.setMounted(true); h.route("https://chatgpt.com/c/conversation-1"); await h.advance(15000);
  assert.equal(h.calls.length, calls); assert.equal(h.viewport.scrollCalls.length, 0); assert.equal(h.timers.size, 0);
});

test("leaving a conversation cancels pending bookmark work and returning cannot revive it", async () => {
  const h = harness(); h.setMounted(false); h.navigation.start(h.payload);
  h.route("https://chatgpt.com/c/another");
  assert.equal(h.navigation.getStatus().reason, "route-changed"); assert.equal(h.timers.size, 0);
  const calls = h.calls.length;
  h.setMounted(true); h.route("https://chatgpt.com/c/conversation-1"); await h.advance(15000);
  assert.equal(h.calls.length, calls); assert.equal(h.viewport.scrollCalls.length, 0);
});

test("an empty native bookmark shell waits for actual body hydration before settlement", async () => {
  const h = harness({ children: [] });
  h.content.append(element("button", {}, ["Expand"]), element("span", { "data-tidy-owned": "time" }, ["#1"]));
  h.navigation.start({ ...h.payload, loadDeadlineAt: 12000, deadlineAt: 14400 });
  await h.advance(4000);
  assert.equal(h.navigation.getStatus().pending, true); assert.equal(h.viewport.scrollCalls.length, 0);
  h.content.append(element("p", {}, ["Actual native bookmark message"]));
  await h.advance(1500);
  assert.equal(h.navigation.getStatus().located, true); assert.equal(h.viewport.scrollCalls.length, 1);
  assert.equal(h.timers.size, 0);
});

test("a never hydrated bookmark shell consumes only the original load deadline", async () => {
  const h = harness({ children: [] });
  h.navigation.start({ ...h.payload, loadDeadlineAt: 5000, deadlineAt: 7400 });
  await h.advance(8000);
  assert.equal(h.navigation.getStatus().located, false);
  assert.equal(h.navigation.getStatus().reason, "target-timeout");
  assert.equal(h.viewport.scrollCalls.length, 0); assert.equal(h.timers.size, 0);
  h.content.append(element("p", {}, ["Late body"])); await h.advance(15000);
  assert.equal(h.viewport.scrollCalls.length, 0, "Late content cannot create a fresh landing window");
});

test("MAIN message command returns the real pending bookmark acknowledgement", () => {
  const calls = [], responses = [];
  const context = vm.createContext({ URL, location: { href: "https://chatgpt.com/c/c", origin: "https://chatgpt.com" },
    crypto: { randomUUID: () => "bookmark-router-request" } });
  installPageSession(context);
  loadMainModule(context, "src/platform/protocol.js");
  loadMainModule(context, "src/app/page/request-router.js");
  context.router = context.TidyPageRequestRouter.create({
    navigation: { locateMessage(payload) { calls.push(payload); return { located: false, pending: true }; } },
    postEnvelope: envelope => responses.push(plain(envelope.payload)),
  });
  // Invoke the genuine source/origin/channel boundary, not an extracted branch.
  vm.runInContext(`router.handleMessage({ source: globalThis, origin: location.origin,
    data: { channel: TidyProtocol.WINDOW_CHANNEL, source: "chatgpt-isolated",
      envelope: TidyProtocol.request(TidyProtocol.Type.LOCATE_MESSAGE,
        { conversationId: "c", messageId: "m", navigationIntentId: "bookmark" }, "test") } });`, context);
  assert.equal(calls.length, 1); assert.deepEqual(responses, [{ located: false, pending: true }]);
});

test("a delayed obsolete bookmark START cannot retire the newer landing or create another scroll", async () => {
  const h = harness({ isIntentCurrent: id => id === "new" });
  h.navigation.start({ ...h.payload, navigationIntentId: "new" }); await h.advance(1500);
  const previous = h.navigation.getStatus();
  const result = h.navigation.start({ ...h.payload, navigationIntentId: "old" });
  assert.equal(result.reason, "superseded"); assert.deepEqual(h.navigation.getStatus(), previous);
  assert.equal(h.viewport.scrollCalls.length, 1); assert.equal(h.timers.size, 0);
});

test("a pending bookmark loses its worker gate without resolving or scrolling any more messages", async () => {
  let current = true;
  const h = harness({ isIntentCurrent: () => current });
  h.setMounted(false); h.navigation.start(h.payload); const before = h.calls.length;
  current = false; h.setMounted(true); await h.advance(250);
  assert.equal(h.calls.length, before); assert.equal(h.viewport.scrollCalls.length, 0);
  assert.equal(h.navigation.getStatus().reason, "context-changed"); assert.equal(h.timers.size, 0);
});

test("cancelId retires only its own pending or completed bookmark", async () => {
  for (const mounted of [false, true]) {
    const h = harness(); h.setMounted(mounted); h.navigation.start(h.payload);
    if (mounted) await h.advance(1500);
    const before = h.navigation.getStatus(), timers = h.timers.size;
    h.navigation.cancelId("another-intent", "user-cancelled");
    assert.deepEqual(h.navigation.getStatus(), before); assert.equal(h.timers.size, timers);
    h.navigation.cancelId(h.payload.navigationIntentId, "user-cancelled");
    const calls = h.calls.length, scrolls = h.viewport.scrollCalls.length;
    h.setMounted(true); await h.advance(15000);
    assert.equal(h.navigation.getStatus().reason, "user-cancelled"); assert.equal(h.calls.length, calls);
    assert.equal(h.viewport.scrollCalls.length, scrolls); assert.equal(h.timers.size, 0);
  }
});

test("a missing worker grant cannot run an explicit bookmark command", async () => {
  const h = harness();
  const standalone = h.context.TidyChatgptMessageNavigation.create({
    resolveTarget: () => { throw Error("An unowned adapter must not resolve a target"); },
    locate: () => { throw Error("An unowned adapter must not scroll"); },
  });
  assert.equal(standalone.start(h.payload).reason, "superseded");
  assert.equal(h.viewport.scrollCalls.length, 0); assert.equal(h.timers.size, 0);
});

test("reentrant bookmark resolution cannot use a newer grant to scroll the obsolete element", async () => {
  let currentId = "old", reentered = false;
  const resolved = [];
  const h = harness({ isIntentCurrent: id => id === currentId,
    onResolve(target, { navigation, message, other }) {
      resolved.push(target.navigationIntentId);
      if (target.navigationIntentId === "old" && !reentered) {
        reentered = true; currentId = "new";
        navigation.start({ conversationId: "conversation-1", messageId: "other", navigationIntentId: "new" });
        return { element: message };
      }
      return { element: other };
    },
  });
  h.navigation.start({ ...h.payload, navigationIntentId: "old" }); await h.advance(1500);
  assert.equal(h.viewport.scrollCalls.length, 1, "Only the nested new target may physically scroll");
  assert.equal(resolved.filter(id => id === "old").length, 1);
  assert.equal(h.navigation.getStatus().located, true); assert.equal(h.timers.size, 0);
});

test("exact target resolution requires route, message ID, role and Fiber conversation agreement", async () => {
  const selectors = [];
  let record = { id: "m", author: { role: "assistant" } };
  let thread = { id: "conversation-1" };
  const message = { isConnected: true, getClientRects: () => [{}],
    getAttribute: name => name === "data-message-id" ? "m" : null };
  let candidates = [message];
  const context = vm.createContext({ URL,
    location: { href: "https://chatgpt.com/c/conversation-1", origin: "https://chatgpt.com" },
    CSS: { escape: (value) => value },
    document: {
      createTreeWalker: () => ({ nextNode: () => null }),
      querySelector: () => { throw new Error("The first duplicate is not proof of the live target"); },
      querySelectorAll: selector => {
        if (selector === '[data-chatgpt-search-message-ids~="m"]') return [];
        assert.equal(selector, 'div[data-message-id="m"]'); selectors.push(selector); return candidates;
      },
    },
    findMessageRecord: () => record,
    walkFiber: () => thread,
    recordId: (value) => value?.id,
    normalizeRole: (value) => value?.author?.role,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  });
  context.global = context;
  for (const file of ["src/platform/snapshot.js", "src/platform/chatgpt/route.js", "src/platform/chatgpt/binding.js", "src/platform/chatgpt/message-dom.js", "src/platform/navigation/chatgpt/message-navigation.js"]) {
    vm.runInContext(read(file), context);
  }
  context.bindingAdapter = context.TidyChatgptBinding;
  context.messageDom = context.TidyChatgptMessageDom;
  context.routeAdapter = context.TidyChatgptRoute;
  context.resolveRouteIdentity = (route, value) => context.bindingAdapter.resolve(route,
    { clientId: value?.id || null, serverId: null }, new Map(), context.routeAdapter.isDraftId);
  let resolveMessageTarget;
  const messageNavigation = context.TidyChatgptMessageNavigation;
  context.TidyChatgptMessageNavigation = { ...messageNavigation,
    create(options) { resolveMessageTarget = options.resolveTarget; return messageNavigation.create(options); } };
  loadMainModule(context, "src/platform/chatgpt/page-navigation-runtime.js");
  context.TidyChatgptPageNavigationRuntime.create({ reader: {
    findMessageRecord: context.findMessageRecord, walkFiber: context.walkFiber,
    recordId: context.recordId, normalizeRole: context.normalizeRole,
    resolveRouteIdentity: context.resolveRouteIdentity,
  }, postEnvelope() {} });
  const target = { conversationId: "conversation-1", messageId: "m" };
  assert.equal(resolveMessageTarget(target).element, message, "untimed messages remain valid bookmark targets");
  assert.equal(resolveMessageTarget(target).contentReady, false, "An exact identity alone does not prove rendered body content");
  assert.deepEqual(selectors, ['div[data-message-id="m"]', 'div[data-message-id="m"]']);
  record = { ...record, id: "different" };
  assert.equal(resolveMessageTarget(target).reason, "message-not-bound");
  record = { id: "m", author: { role: "tool" } };
  assert.equal(resolveMessageTarget(target).reason, "message-not-bound");
  record = { id: "m", author: { role: "assistant" }, conversation_id: "another" };
  assert.equal(resolveMessageTarget(target).reason, "message-not-bound");
  record = { ...record, conversation_id: "conversation-1" };
  thread = { id: "another" };
  assert.equal(resolveMessageTarget(target).reason, "message-not-bound");
  thread = null;
  assert.equal(resolveMessageTarget(target).element, message, "exact message conversation metadata binds without a thread signal");
  const oldTree = { ...message, parentElement: { hidden: true } };
  candidates = [oldTree, message];
  assert.equal(resolveMessageTarget(target).element, message, "a hidden duplicate preceding the live target cannot own scrolling");
  oldTree.parentElement.hidden = false;
  assert.equal(resolveMessageTarget(target).reason, "message-not-bound", "two plausible live exact records are ambiguous");
  oldTree.isConnected = false;
  assert.equal(resolveMessageTarget(target).element, message, "a retired duplicate cannot hide the live target");
  candidates = [{ ...message, getClientRects: () => [] }];
  assert.equal(resolveMessageTarget(target).reason, "message-not-bound", "an unrendered loading tree is not a landing target");
  context.location.href = "https://chatgpt.com/c/another";
  const count = selectors.length;
  assert.equal(resolveMessageTarget(target).reason, "conversation-mismatch");
  assert.equal(selectors.length, count, "wrong routes do not inspect a message at all");
});

test('rendered message content excludes empty shells, controls, hidden text and TIDY metadata', () => {
  const h = harness({ children: [] });
  const has = () => h.context.TidyChatgptMessageNavigation.hasRenderedContent(h.message);
  assert.equal(has(), false);
  h.content.append(element('button', {}, ['Expand']), element('span', { 'data-tidy-owned': 'meta' }, ['#117 2026/09/16']));
  const hidden = element('div', {}, ['not painted']); hidden.style.display = 'none'; h.content.append(hidden);
  assert.equal(has(), false);
  h.content.append(element('p', {}, ['Actual native message']));
  assert.equal(has(), true);
});

test('visible native image/audio content is a body even inside a preview button, but not TIDY or a foreign message', () => {
  for (const tag of ['img', 'audio', 'video', 'canvas']) {
    const h = harness({ children: [] });
    const media = element(tag); media.getBoundingClientRect = () => ({ width: 200, height: 100 });
    const preview = element('button', {}, [media]); h.content.append(preview);
    const has = () => h.context.TidyChatgptMessageNavigation.hasRenderedContent(h.message);
    assert.equal(has(), true, tag);
    preview.attributes['data-tidy-owned'] = 'meta'; assert.equal(has(), false);
    delete preview.attributes['data-tidy-owned']; preview.attributes['data-message-id'] = 'other'; assert.equal(has(), false);
    delete preview.attributes['data-message-id']; media.style.visibility = 'hidden'; assert.equal(has(), false);
  }
});
