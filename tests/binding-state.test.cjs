const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function classicContext(files, overrides = {}) {
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
    Map,
    location: { href: "https://chatgpt.com/", origin: "https://chatgpt.com" },
    ...overrides,
  });
  for (const file of files) {
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  }
  return context;
}

const adapterContext = classicContext([
  "src/platform/snapshot.js",
  "src/platform/chatgpt/route.js",
  "src/platform/chatgpt/binding.js",
]);
const route = adapterContext.TidyChatgptRoute;
const binding = adapterContext.TidyChatgptBinding;

function resolve(url, threadEvidence = {}, draftIdMap = new Map()) {
  return binding.resolve(route.parse(url), threadEvidence, draftIdMap, route.isDraftId);
}

// Existing conversation -> blank new chat: stale Fiber is ignored completely.
const blankAfterConversation = resolve("https://chatgpt.com/", { clientId: "old-conversation" });
assert.equal(blankAfterConversation.conversationId, null);
assert.equal(blankAfterConversation.draftId, null);
assert.equal(blankAfterConversation.status, "empty");
assert.equal(blankAfterConversation.bindingStatus, "unbound");
assert.equal(binding.acceptedIds(blankAfterConversation).join(","), "");
assert.equal(binding.withExactMetadata(blankAfterConversation, true).bindingStatus, "unbound");

// Project conversation -> blank new chat follows the same fail-closed rule.
const blankAfterProject = resolve("https://chatgpt.com/", { clientId: "project-conversation" });
assert.equal(blankAfterProject.bindingStatus, "unbound");
assert.equal(blankAfterProject.conversationId, null);

// SPA fast-switch keeps the new route ID and exposes the old DOM as mismatch.
const switched = resolve("https://chatgpt.com/c/new-conversation", {
  clientId: "old-conversation",
});
assert.equal(switched.conversationId, "new-conversation");
assert.equal(switched.bindingStatus, "mismatch");
assert.equal(binding.acceptedIds(switched).join(","), "new-conversation");

const switchedProject = resolve(
  "https://chatgpt.com/g/g-p-project/c/new-project-conversation",
  { clientId: "old-project-conversation" },
);
assert.equal(switchedProject.conversationId, "new-project-conversation");
assert.equal(switchedProject.bindingStatus, "mismatch");

// Exact sidebar metadata may upgrade route-only identity, never mismatch.
const routeOnly = resolve("https://chatgpt.com/c/current-conversation");
assert.equal(routeOnly.bindingStatus, "route-only");
assert.equal(binding.withExactMetadata(routeOnly, true).bindingStatus, "bound");
assert.equal(binding.withExactMetadata(switched, true).bindingStatus, "mismatch");

// A stale stable Fiber cannot replace the draft route identity.
const draftMismatch = resolve("https://chatgpt.com/c/WEB%3Adraft-1", {
  clientId: "old-conversation",
});
assert.equal(draftMismatch.conversationId, null);
assert.equal(draftMismatch.draftId, "WEB:draft-1");
assert.equal(draftMismatch.bindingStatus, "mismatch");

// Draft -> formal ID is accepted only when the draft client ID proves the map.
const draftMap = new Map();
const resolvedDraft = resolve(
  "https://chatgpt.com/c/WEB%3Adraft-1",
  { clientId: "WEB:draft-1", serverId: "formal-conversation" },
  draftMap,
);
assert.equal(resolvedDraft.conversationId, "formal-conversation");
assert.equal(resolvedDraft.draftId, "WEB:draft-1");
assert.equal(resolvedDraft.status, "stable");
assert.equal(resolvedDraft.bindingStatus, "bound");

const formalRoute = resolve(
  "https://chatgpt.com/c/formal-conversation",
  { clientId: "WEB:draft-1", serverId: "formal-conversation" },
  draftMap,
);
assert.equal(formalRoute.conversationId, "formal-conversation");
assert.equal(formalRoute.draftId, "WEB:draft-1");
assert.equal(formalRoute.bindingStatus, "bound");

assert.equal(binding.messageMatchesIdentity(null, formalRoute), true);
assert.equal(
  binding.messageMatchesIdentity({ conversation_id: "other-conversation" }, formalRoute),
  false,
);

const snapshotContext = classicContext(["src/platform/snapshot.js"]);
const snapshot = snapshotContext.TidySnapshot;

function sourced(value = null, source = null, status = "missing") {
  return { value, source, status };
}

function makeSnapshot({
  conversationId = null,
  draftId = null,
  identityStatus = "empty",
  bindingStatus = "unbound",
  title = sourced(),
  createdAt = sourced(),
  updatedAt = sourced(),
  messages = [],
} = {}) {
  return {
    schemaVersion: snapshot.VERSION,
    capturedAt: new Date().toISOString(),
    appearance: { colorScheme: "light", source: "test", status: "available", surface: sourced("rgb(255, 255, 255)", "test", "available") },
    route: { pathname: conversationId ? `/c/${conversationId}` : "/" },
    conversation: {
      conversationId,
      draftId,
      identityStatus,
      bindingStatus,
      title,
      createdAt,
      updatedAt,
    },
    sidebarConversations: [],
    messages,
  };
}

const message = {
  messageId: "message-1",
  idStatus: "stable",
  presentationStatus: "formal",
  role: "user",
  timestamp: sourced(),
  excerpt: sourced("Hello", "test", "available"),
  order: { index: 0 },
  locator: { strategy: "data-message-id", value: "message-1" },
};

const safeEmpty = makeSnapshot();
assert.equal(snapshot.validate(safeEmpty).valid, true);
assert.equal(snapshot.isPersistenceEligible(safeEmpty), false);

const pollutedEmpty = makeSnapshot({
  title: sourced("Old title", "sidebar-dom", "provisional"),
  createdAt: sourced("2026-01-01T00:00:00.000Z", "react-fiber.history-item", "available"),
  updatedAt: sourced("2026-01-02T00:00:00.000Z", "react-fiber.history-item", "available"),
  messages: [message],
});
const pollutedErrors = snapshot.validate(pollutedEmpty).errors;
assert.ok(pollutedErrors.includes("conversation.title.unboundValue"));
assert.ok(pollutedErrors.includes("conversation.createdAt.unboundValue"));
assert.ok(pollutedErrors.includes("conversation.updatedAt.unboundValue"));
assert.ok(pollutedErrors.includes("messages.unboundValues"));

const safeBound = makeSnapshot({
  conversationId: "formal-conversation",
  identityStatus: "stable",
  bindingStatus: "bound",
  title: sourced("Current title", "sidebar-dom", "available"),
  messages: [message],
});
assert.equal(snapshot.validate(safeBound).valid, true);
assert.equal(snapshot.isPersistenceEligible(safeBound), true);

const boundDraft = makeSnapshot({
  draftId: "WEB:draft-1",
  identityStatus: "resolving",
  bindingStatus: "bound",
  messages: [message],
});
assert.equal(snapshot.validate(boundDraft).valid, true);
assert.equal(snapshot.isPersistenceEligible(boundDraft), false);

const panelContext = classicContext(["src/platform/ui/context-state.js"]).TidyPanelContext;
const gate = panelContext.createRequestGate();
const oldRequest = gate.next();
gate.invalidate();
const newRequest = gate.next();
assert.equal(gate.isCurrent(oldRequest), false);
assert.equal(gate.isCurrent(newRequest), true);

const oldRouteKey = panelContext.routeKey(7, "https://chatgpt.com/c/old-conversation");
const blankRouteKey = panelContext.routeKey(7, "https://chatgpt.com/");
const projectRouteKey = panelContext.routeKey(
  7,
  "https://chatgpt.com/g/g-p-project/c/project-conversation",
);
assert.notEqual(oldRouteKey, blankRouteKey);
assert.notEqual(projectRouteKey, blankRouteKey);
assert.equal(panelContext.routeKey(7, safeBound), "7|/c/formal-conversation");

const { test } = require("node:test");
const contextControllerModule = import("../src/app/sidepanel/context-controller.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function conversationSnapshot(conversationId) {
  return makeSnapshot({ conversationId, identityStatus: "stable", bindingStatus: "bound" });
}

async function controllerHarness(overrides = {}) {
  const { createPanelContextController } = await contextControllerModule;
  const requests = [];
  const changes = [];
  const requestedRoutes = [];
  const pending = [];
  const acceptedCandidates = [];
  const state = { ready: true, allowTransition: false };
  const controller = createPanelContextController({
    ownerTabId: 7,
    isReady: () => state.ready,
    isValidTabId: value => Number.isInteger(value) && value >= 0,
    routeKey: panelContext.routeKey,
    request: (type, payload) => {
      requests.push({ type, payload });
      const next = pending.shift();
      assert.ok(next, "Every context read must have an explicit deferred response");
      return next.promise;
    },
    contextType: "GET_CONTEXT",
    errorCodes: { TAB_UNAVAILABLE: "TAB_UNAVAILABLE", INTERNAL_ERROR: "INTERNAL_ERROR" },
    acceptsSnapshot: candidate => {
      acceptedCandidates.push(candidate);
      return state.allowTransition;
    },
    onRequestedRoute: value => requestedRoutes.push({ value, snapshot: controller.get().snapshot }),
    onChanged: (model, reason) => changes.push({ model, reason }),
    ...overrides,
  });
  return { controller, requests, changes, requestedRoutes, pending, acceptedCandidates, state };
}

function contextResponse(snapshot, requestedRoute = null) {
  return { tab: { id: 7 }, snapshot, requestedRoute };
}

test("panel context controller rejects the older read when a newer read settles first", async () => {
  const h = await controllerHarness();
  const older = deferred();
  const newer = deferred();
  const oldSnapshot = conversationSnapshot("old-conversation");
  const newSnapshot = conversationSnapshot("new-conversation");
  h.pending.push(older, newer);

  const first = h.controller.refresh();
  const second = h.controller.refresh();
  assert.deepEqual(h.requests, [
    { type: "GET_CONTEXT", payload: { expectedTabId: 7 } },
    { type: "GET_CONTEXT", payload: { expectedTabId: 7 } },
  ]);
  newer.resolve(contextResponse(newSnapshot, { view: "bookmarks" }));
  assert.equal(await second, true);
  const committed = h.controller.get();
  assert.equal(committed.snapshot, newSnapshot);
  assert.equal(committed.routeKey, "7|/c/new-conversation");
  assert.ok(Object.isFrozen(committed));
  assert.deepEqual(h.requestedRoutes, [{ value: { view: "bookmarks" }, snapshot: newSnapshot }]);
  const settledCount = h.changes.filter(change => change.reason === "settled").length;

  older.resolve(contextResponse(oldSnapshot, { view: "favorites" }));
  assert.equal(await first, false);
  assert.equal(h.controller.get(), committed, "A stale result cannot replace the newer model");
  assert.equal(h.requestedRoutes.length, 1, "A stale result cannot route the panel");
  assert.equal(h.changes.filter(change => change.reason === "settled").length, settledCount);
});

test("invalidating the panel route cancels an already pending context read", async () => {
  const h = await controllerHarness();
  const seed = conversationSnapshot("old-conversation");
  assert.equal(h.controller.acceptSnapshot({ tabId: 7, snapshot: seed }), true);
  const oldRead = deferred();
  h.pending.push(oldRead);
  const refreshing = h.controller.refresh();
  h.controller.invalidate({ url: "https://chatgpt.com/" });
  const invalidated = h.controller.get();
  assert.equal(invalidated.snapshot, null);
  assert.equal(invalidated.routeKey, blankRouteKey);
  assert.equal(invalidated.error, null);

  oldRead.resolve(contextResponse(seed, { view: "favorites" }));
  assert.equal(await refreshing, false);
  assert.equal(h.controller.get(), invalidated);
  assert.deepEqual(h.requestedRoutes, []);
});

test("expected route mismatch and denied snapshot transition preserve the current model", async () => {
  const h = await controllerHarness();
  const current = conversationSnapshot("current-conversation");
  const other = conversationSnapshot("other-conversation");
  assert.equal(h.controller.acceptSnapshot({ tabId: 7, snapshot: current }), true);
  const read = deferred();
  h.pending.push(read);
  const refreshing = h.controller.refresh({ expectedRouteKey: "7|/c/current-conversation" });
  read.resolve(contextResponse(other, { view: "favorites" }));
  assert.equal(await refreshing, false);
  assert.equal(h.controller.get().snapshot, current);
  assert.equal(h.controller.get().routeKey, "7|/c/current-conversation");
  assert.equal(h.controller.get().error, null);
  assert.deepEqual(h.acceptedCandidates, [other]);
  assert.deepEqual(h.requestedRoutes, []);

  const committed = h.controller.get();
  assert.equal(h.controller.acceptSnapshot({ tabId: 7, snapshot: other }), false);
  assert.equal(h.controller.get(), committed);
  assert.deepEqual(h.acceptedCandidates, [other, other]);
  assert.equal(h.controller.acceptSnapshot({ tabId: 99, snapshot: current }), false);
  assert.equal(h.controller.acceptSnapshot({ tabId: 7 }), false);
  assert.equal(h.controller.get(), committed);
});

test("authorized route transitions and same-route snapshot updates use the actual context owner", async () => {
  const h = await controllerHarness();
  const current = conversationSnapshot("current-conversation");
  const replacement = conversationSnapshot("next-conversation");
  h.controller.invalidate({ url: "https://chatgpt.com/c/current-conversation" });
  assert.equal(h.controller.acceptSnapshot({ tabId: 7, snapshot: current }), true);
  assert.deepEqual(h.acceptedCandidates, [], "Matching routes do not need a navigation exception");

  h.state.allowTransition = true;
  const read = deferred();
  h.pending.push(read);
  const refreshing = h.controller.refresh({ expectedRouteKey: "7|/c/current-conversation" });
  read.resolve(contextResponse(replacement));
  assert.equal(await refreshing, true);
  assert.equal(h.controller.get().snapshot, replacement);
  assert.equal(h.controller.get().routeKey, "7|/c/next-conversation");

  const pending = deferred();
  h.pending.push(pending);
  const stale = h.controller.refresh();
  const newest = conversationSnapshot("newest-conversation");
  assert.equal(h.controller.acceptSnapshot({ tabId: 7, snapshot: newest }), true);
  const committed = h.controller.get();
  pending.resolve(contextResponse(replacement));
  assert.equal(await stale, false);
  assert.equal(h.controller.get(), committed, "A push snapshot supersedes pending reads");
});

test("panel context readiness and exact owner validation fail closed", async () => {
  const h = await controllerHarness();
  h.state.ready = false;
  assert.equal(await h.controller.refresh(), false);
  assert.deepEqual(h.requests, []);
  h.state.ready = true;
  const read = deferred();
  h.pending.push(read);
  const refreshing = h.controller.refresh();
  read.resolve({ tab: { id: 8 }, snapshot: conversationSnapshot("wrong-tab") });
  assert.equal(await refreshing, false);
  assert.equal(h.controller.get().snapshot, null);
  assert.equal(h.controller.get().error.code, "TAB_UNAVAILABLE");

  const invalid = await controllerHarness({ ownerTabId: null });
  assert.equal(await invalid.controller.refresh(), false);
  assert.deepEqual(invalid.requests, []);
  assert.equal(invalid.controller.get().error.code, "TAB_UNAVAILABLE");
});

test("suspend, fail, and dispose all invalidate outstanding context work", async () => {
  for (const command of ["suspend", "fail", "dispose"]) {
    const h = await controllerHarness();
    const current = conversationSnapshot("current-conversation");
    assert.equal(h.controller.acceptSnapshot({ tabId: 7, snapshot: current }), true);
    const read = deferred();
    h.pending.push(read);
    const refreshing = h.controller.refresh();
    if (command === "fail") {
      h.controller.fail({ code: "CONTEXT_MISMATCH", message: "Changed document", requestId: "request-1" });
    } else {
      h.controller[command]();
    }
    const committed = h.controller.get();
    if (command !== "dispose") assert.equal(committed.snapshot, null);
    if (command === "fail") {
      assert.deepEqual(committed.error, {
        code: "CONTEXT_MISMATCH", message: "Changed document", requestId: "request-1",
      });
    }
    read.resolve(contextResponse(conversationSnapshot("stale-conversation")));
    assert.equal(await refreshing, false);
    assert.equal(h.controller.get(), committed, command + " must prevent stale publication");
  }
});


function readerHarness() {
  const fixture = { links: [], elements: [], roots: {}, queries: [], titleReads: 0 };
  const document = {
    get title() {
      fixture.titleReads += 1;
      throw new Error("The document title is not conversation-owned evidence");
    },
    querySelector: selector => {
      fixture.queries.push(selector);
      return fixture.roots[selector] || null;
    },
    querySelectorAll: selector => {
      fixture.queries.push(selector);
      return selector.includes("/project") ? [] : fixture.links;
    },
  };
  const context = classicContext([
    "src/platform/snapshot.js",
    "src/platform/chatgpt/route.js",
    "src/platform/chatgpt/binding.js",
    "src/platform/chatgpt/sidebar-dom.js",
    "src/platform/chatgpt/native-snapshot-reader.js",
  ], {
    document,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    TidyChatgptMessageDom: {
      candidates: () => fixture.elements,
      id: element => element.messageId,
      locator: element => ({ strategy: "data-message-id", value: element.messageId }),
      contentRoot: element => element,
    },
  });
  return { fixture, reader: context.TidyChatgptNativeSnapshotReader.create() };
}

function nativeLink(href, conversation, title = "Native conversation title") {
  return {
    getAttribute: name => name === "href" ? href : null,
    closest: () => null,
    childNodes: [{ nodeType: 3, textContent: title }],
    __reactFiber$bindingTest: { memoizedProps: { conversation } },
  };
}

function nativeMessage(id, conversationId, status = "finished_successfully") {
  const record = { id, conversation_id: conversationId, author: { role: "user" },
    create_time: 1767225600, content: { parts: ["A message in " + conversationId] }, status };
  return {
    messageId: id,
    getAttribute: () => null,
    matches: () => false,
    querySelector: () => null,
    __reactFiber$bindingTest: { memoizedProps: { message: record } },
  };
}

test("native reader ignores all stale metadata when route identity has no accepted IDs", () => {
  const h = readerHarness();
  const oldConversation = { id: "old-conversation", title: "Old title", create_time: 1, update_time: 2 };
  h.fixture.links.push(nativeLink("/c/old-conversation", oldConversation));
  h.fixture.elements.push(nativeMessage("old-message", "old-conversation"));
  h.fixture.roots.main = { __reactFiber$bindingTest: { memoizedProps: { conversation: oldConversation } } };

  assert.equal(h.reader.findConversationMeta(blankAfterConversation), null);
  assert.equal(h.reader.findCurrentPageMeta(blankAfterConversation), null);
  assert.equal(h.reader.hasCurrentPageIdentityEvidence(blankAfterConversation), false);
  assert.deepEqual(h.fixture.queries, [], "An empty identity must stop before scanning stale DOM metadata");
  const emptyFields = h.reader.readConversationFields(route.parse("https://chatgpt.com/"), blankAfterConversation, null);
  assert.equal(emptyFields.conversationId, null);
  assert.equal(emptyFields.title.value, null);
  assert.equal(emptyFields.createdAt.value, null);
  assert.equal(emptyFields.updatedAt.value, null);
  assert.equal(h.fixture.titleReads, 0);
});

test("native reader requires exact route and Fiber ownership for conversation metadata", () => {
  const h = readerHarness();
  const identity = resolve("https://chatgpt.com/c/current-conversation", { clientId: "current-conversation" });
  const staleConversation = { id: "old-conversation", title: "Stale", create_time: 1, update_time: 2 };
  const matchingConversation = { id: "current-conversation", title: "Current Fiber title", create_time: 3, update_time: 4 };
  h.fixture.links.push(
    nativeLink("/c/old-conversation", staleConversation),
    nativeLink("/c/current-conversation", staleConversation),
  );
  h.fixture.roots.main = { __reactFiber$bindingTest: { memoizedProps: { conversation: staleConversation } } };
  assert.equal(h.reader.findConversationMeta(identity), null);
  assert.equal(h.reader.findCurrentPageMeta(identity), null);

  const currentLink = nativeLink("/c/current-conversation", matchingConversation, "Current sidebar title");
  h.fixture.links.push(currentLink);
  const sidebarMeta = h.reader.findConversationMeta(identity);
  assert.equal(sidebarMeta.value, matchingConversation);
  assert.equal(sidebarMeta.link, currentLink);
  assert.equal(sidebarMeta.boundId, "current-conversation");
  assert.equal(sidebarMeta.source, "react-fiber.history-item");

  h.fixture.roots.main.__reactFiber$bindingTest.return = { memoizedProps: { conversation: matchingConversation } };
  const pageMeta = h.reader.findCurrentPageMeta(identity);
  assert.equal(pageMeta.value, matchingConversation);
  assert.equal(pageMeta.boundId, "current-conversation");
  assert.equal(pageMeta.source, "react-fiber.current-conversation");
});

test("native reader filters messages by conversation identity before reading activity or metadata", () => {
  const h = readerHarness();
  const identity = resolve("https://chatgpt.com/c/current-conversation", { clientId: "current-conversation" });
  h.fixture.elements.push(
    nativeMessage("old-message", "old-conversation", "in_progress"),
    nativeMessage("current-message", "current-conversation"),
  );
  const unnumbered = [];
  const activity = { responseInProgress: false };
  const messages = h.reader.readMessages(identity, unnumbered, activity);
  assert.deepEqual(Array.from(messages, value => value.messageId), ["current-message"]);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].timestamp.value, "2026-01-01T00:00:00.000Z");
  assert.equal(messages[0].excerpt.value, "A message in current-conversation");
  assert.deepEqual(Array.from(unnumbered, value => value.id), ["current-message"]);
  assert.equal(activity.responseInProgress, false, "A stale conversation cannot supply streaming state");
  assert.equal(h.reader.hasCurrentPageIdentityEvidence(identity), true);
  h.fixture.elements.pop();
  assert.equal(h.reader.hasCurrentPageIdentityEvidence(identity), false);
  for (const rejectedIdentity of [blankAfterConversation, switched, routeOnly]) {
    assert.equal(h.reader.readMessages(rejectedIdentity, [], { responseInProgress: false }).length, 0);
  }
});

test("native reader never substitutes document title for exact conversation fields", () => {
  const h = readerHarness();
  const currentRoute = route.parse("https://chatgpt.com/c/current-conversation");
  const identity = resolve(currentRoute.href, { clientId: "current-conversation" });
  const missing = h.reader.readConversationFields(currentRoute, identity, null);
  assert.equal(missing.title.value, null);
  assert.equal(missing.title.source, null);
  assert.equal(missing.title.status, "missing");

  const generic = h.reader.readConversationFields(currentRoute, identity,
    { value: { title: "ChatGPT" }, source: "react-fiber.current-conversation" });
  assert.equal(generic.title.value, null);
  const exact = h.reader.readConversationFields(currentRoute, identity,
    { value: { title: "Exact Fiber title" }, source: "react-fiber.current-conversation" });
  assert.equal(exact.title.value, "Exact Fiber title");
  assert.equal(exact.title.source, "react-fiber.current-conversation");
  assert.equal(exact.title.status, "available");
  assert.equal(h.fixture.titleReads, 0, "Document-global title is forbidden even as a missing-title fallback");
});
