const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const moduleAt = name => import(pathToFileURL(path.resolve(__dirname, "../src", name)));
const loaded = Promise.all([
  moduleAt("platform/navigation/ui/navigation-owner.js"),
  moduleAt("app/sidepanel/navigation-coordinator.js"),
  moduleAt("app/sidepanel/context-controller.js"),
  moduleAt("app/sidepanel/request-client.js"),
  moduleAt("app/sidepanel/feature-clients.js"),
  moduleAt("app/sidepanel/search-actions.js"),
  moduleAt("app/sidepanel/export-workflow.js"),
  moduleAt("features/export/ui/export-selection.js"),
]).then(modules => Object.assign({}, ...modules));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

async function navigationHarness(route = "bookmarks", target = { conversationId: "c", messageId: "m" }) {
  const { createPanelNavigationOwner, createPanelNavigationCoordinator } = await loaded;
  let serial = 0, phase = "ready", accepts = true;
  const cancelled = [], consumed = [], completed = [], notified = [];
  const owner = createPanelNavigationOwner({ createId: () => "n" + ++serial, cancel: (...args) => cancelled.push(args) });
  const id = owner.begin(route, target);
  const coordinator = createPanelNavigationCoordinator({ ownerTabId: 7, owner, phase: () => phase,
    consumers: Object.fromEntries(["bookmarks", "search", "favorites"].map(kind => [kind, payload => { consumed.push(payload); return accepts; }])),
    onCompleted: (...args) => completed.push(args), onCancelled: value => notified.push(value) });
  const receipt = extra => ({ tabId: 7, navigationIntentId: id, conversationId: "c", messageId: "m", located: true, ...extra });
  return { owner, coordinator, id, receipt, cancelled, consumed, completed, notified,
    setPhase: value => phase = value, setAccepts: value => accepts = value };
}

test("wrong navigation target is not consumed and the later exact receipt completes once", async () => {
  const h = await navigationHarness();
  assert.equal(h.coordinator.receive(h.receipt({ messageId: "other" })), false);
  assert.equal(h.owner.isCompleted(h.id), false); assert.equal(h.consumed.length, 0);
  assert.equal(h.coordinator.receive(h.receipt()), true);
  assert.equal(h.coordinator.receive(h.receipt()), false);
  assert.equal(h.completed.length, 1); assert.equal(h.owner.isCurrent(h.id), true);
});
test("cross-tab, wrong intent, wrong conversation, missing located and wrong message are rejected", async () => {
  const h = await navigationHarness();
  for (const patch of [{ tabId: 8 }, { navigationIntentId: "other" }, { conversationId: "other" },
    { located: undefined }, { messageId: null }]) assert.equal(h.coordinator.receive(h.receipt(patch)), false);
  assert.equal(h.consumed.length, 0); assert.equal(h.owner.isCompleted(h.id), false);
});
test("feature rejection does not prematurely consume a validated common target", async () => {
  const h = await navigationHarness(); h.setAccepts(false);
  assert.equal(h.coordinator.receive(h.receipt()), false); assert.equal(h.owner.isCompleted(h.id), false);
  h.setAccepts(true); assert.equal(h.coordinator.receive(h.receipt()), true);
});
test("queued correct receipt survives wrong-target and duplicate arrivals until ready", async () => {
  const h = await navigationHarness(); h.setPhase("connecting");
  assert.equal(h.coordinator.receive(h.receipt()), true);
  assert.equal(h.coordinator.receive(h.receipt({ conversationId: "wrong" })), false);
  assert.equal(h.coordinator.receive(h.receipt({ located: false })), true);
  assert.equal(h.consumed.length, 0);
  h.setPhase("ready"); assert.equal(h.coordinator.flush(), true);
  assert.equal(h.completed[0][0].located, true); assert.equal(h.coordinator.flush(), false);
});
test("stalled handshake retains one exact receipt without authorizing business execution", async () => {
  const h = await navigationHarness(); h.setPhase("stalled");
  assert.equal(h.coordinator.receive(h.receipt()), true); assert.equal(h.consumed.length, 0);
  h.setPhase("ready"); assert.equal(h.coordinator.flush(), true);
});
test("cancel revokes pending exact receipt and cannot revoke another tab or newer intent", async () => {
  const h = await navigationHarness(); h.setPhase("connecting"); h.coordinator.receive(h.receipt());
  assert.equal(h.coordinator.cancelled({ tabId: 8, navigationIntentId: h.id }), false);
  assert.equal(h.owner.isCurrent(h.id), true);
  assert.equal(h.coordinator.cancelled({ tabId: 7, navigationIntentId: h.id }), true);
  h.setPhase("ready"); assert.equal(h.coordinator.flush(), false);
  const newer = h.owner.begin("search", { conversationId: "new" });
  assert.equal(h.coordinator.cancelled({ tabId: 7, navigationIntentId: h.id }), false);
  assert.equal(h.owner.isCurrent(newer), true); assert.equal(h.notified.length, 1);
});
test("favorites require exact conversation, latest placement and null message target", async () => {
  const h = await navigationHarness("favorites", { conversationId: "c", placement: "latest" });
  for (const patch of [{ messageId: "m" }, { placement: "other" }, { conversationId: "other" }]) {
    assert.equal(h.coordinator.receive(h.receipt({ messageId: null, placement: "latest", ...patch })), false);
  }
  assert.equal(h.coordinator.receive(h.receipt({ messageId: null, placement: "latest" })), true);
});
test("navigation target is immutable and leaving cancels even an already completed owner", async () => {
  const h = await navigationHarness();
  assert.equal(h.owner.setTarget(h.id, { conversationId: "different", messageId: "m" }), false);
  assert.equal(h.coordinator.receive(h.receipt()), true);
  h.owner.leave("search"); assert.deepEqual(h.cancelled, [[h.id, "module-left"]]); assert.equal(h.owner.get(), null);
});
test("late queued result cannot replace a superseding navigation", async () => {
  const h = await navigationHarness(); h.setPhase("connecting"); h.coordinator.receive(h.receipt());
  const next = h.owner.begin("favorites", { conversationId: "next", placement: "latest" });
  h.setPhase("ready"); assert.equal(h.coordinator.flush(), false); assert.equal(h.owner.isCurrent(next), true);
});

function protocolFixture() {
  let id = 0;
  return { Type: { GET: "get" }, ErrorCode: { ADAPTER_UNAVAILABLE: "ADAPTER_UNAVAILABLE",
    INVALID_ENVELOPE: "INVALID_ENVELOPE", INTERNAL_ERROR: "INTERNAL_ERROR" },
    request: (type, payload) => ({ type, payload, requestId: "req-" + ++id }),
    isResponse: (value, requestId) => Boolean(value && value.requestId === requestId && typeof value.ok === "boolean"),
    runtimeDisconnectReason: () => "connection-closed" };
}
test("request client has a single admission gate while raw probe transport is explicit", async () => {
  const { createPanelRequestClient } = await loaded; const protocol = protocolFixture(); const sent = [], gates = [];
  const client = createPanelRequestClient({ protocol,
    runtime: { sendMessage: async envelope => { sent.push(envelope); return { ok: true, requestId: envelope.requestId, payload: { value: 1 } }; } },
    run: async (type, operation) => { gates.push(type); return operation(); } });
  assert.deepEqual(await client.send("get", { expectedTabId: 7 }), { value: 1 });
  await client.transmit("probe");
  assert.deepEqual(gates, ["get"]); assert.equal(sent[0].payload.expectedTabId, 7);
});
test("request client preserves current request attribution for transport, invalid envelope and worker failures", async () => {
  const { createPanelRequestClient } = await loaded;
  for (const mode of ["disconnect", "invalid", "worker"]) {
    const protocol = protocolFixture(); const client = createPanelRequestClient({ protocol, run: (_type, fn) => fn(),
      runtime: { sendMessage: async envelope => {
        if (mode === "disconnect") throw new Error("private");
        return mode === "invalid" ? { ok: true, requestId: "other" } : { ok: false, requestId: envelope.requestId,
          error: { code: "CONTEXT_MISMATCH", message: "changed", details: { stage: "validate" } } };
      } } });
    await assert.rejects(client.send("get"), error => error.requestId === "req-1"
      && error.code === ({ disconnect: "ADAPTER_UNAVAILABLE", invalid: "INVALID_ENVELOPE", worker: "CONTEXT_MISMATCH" })[mode]);
  }
});
test("context owner ignores obsolete reads and rejects a different bound tab", async () => {
  const { createPanelContextController } = await loaded; const calls = [];
  const context = createPanelContextController({ ownerTabId: 7, isReady: () => true, isValidTabId: Number.isInteger,
    routeKey: (id, value) => id + ":" + value.id, contextType: "context", errorCodes: protocolFixture().ErrorCode,
    request: () => { const task = deferred(); calls.push(task); return task.promise; } });
  const old = context.refresh(), newer = context.refresh();
  calls[1].resolve({ tab: { id: 7 }, snapshot: { id: "new" } }); await newer;
  calls[0].resolve({ tab: { id: 7 }, snapshot: { id: "old" } }); await old;
  assert.equal(context.get().snapshot.id, "new");
  const wrong = context.refresh(); calls[2].resolve({ tab: { id: 9 }, snapshot: { id: "wrong" } }); await wrong;
  assert.equal(context.get().snapshot, null);
});
test("context invalidation and unsolicited snapshot share the same generation owner", async () => {
  const { createPanelContextController } = await loaded; const pending = deferred();
  const context = createPanelContextController({ ownerTabId: 7, isReady: () => true, isValidTabId: Number.isInteger,
    routeKey: (_id, value) => typeof value === "string" ? value : value.id, contextType: "context",
    errorCodes: protocolFixture().ErrorCode, request: () => pending.promise });
  const read = context.refresh(); context.invalidate({ url: "new" });
  assert.equal(context.acceptSnapshot({ tabId: 7, snapshot: { id: "old" } }), false);
  assert.equal(context.acceptSnapshot({ tabId: 7, snapshot: { id: "new" } }), true);
  pending.resolve({ tab: { id: 7 }, snapshot: { id: "old" } }); await read;
  assert.equal(context.get().snapshot.id, "new");
});
test("feature clients stamp fixed tab after payload and preserve frozen title target and identity", async () => {
  const { createFeatureClients } = await loaded;
  const calls = []; const clients = createFeatureClients({ ownerTabId: 7,
    protocol: { Type: { TITLE_APPLY: "apply", EXPORT_PREVIEW_CLOSE: "close" } },
    request: (type, payload) => { calls.push({ type, payload }); return payload; } });
  const identity = { documentId: "doc" };
  clients.titles("apply", { expectedTabId: 9, expectedConversationId: "original", expectedIdentity: identity });
  assert.deepEqual(calls[0], { type: "apply", payload: { expectedTabId: 7, expectedConversationId: "original", expectedIdentity: identity } });
  assert.throws(() => clients.titles("unknown", {}), /Unsupported/);
  assert.throws(() => clients.titles("toString", {}), /Unsupported/);
});
test("search actions register exact date target before OPEN and suppress rejected OPEN after valid completion", async () => {
  const { createSearchActions, createPanelNavigationOwner } = await loaded;
  const pending = deferred(), events = [];
  const owner = createPanelNavigationOwner({ createId: () => "nav", cancel() {} }); owner.begin("search");
  const actions = createSearchActions({ ownerTabId: 7, protocol: { Type: { SEARCH_OPEN_RESULT: "open" }, ErrorCode: {} },
    isReady: () => true, request: () => { events.push(owner.get()); return pending.promise; }, dateSearch: {},
    pauseTitleCatalog() {}, navigation: owner, notice: { beginSearchNotice() {}, finishSearchNotice() {}, showSearchToast: () => events.push("toast") } });
  const opening = actions.handle("open", { navigationIntentId: "nav", conversationId: "c", messageId: null, navigationKind: "conversation" });
  assert.deepEqual(events[0].target, { conversationId: "c", messageId: null, placement: "latest" });
  owner.complete({ navigationIntentId: "nav", conversationId: "c", messageId: null, placement: "latest", located: true });
  pending.reject(new Error("late"));
  await assert.rejects(opening, /late/); assert.equal(events.includes("toast"), false);
});
test("export workflow keeps submitted basket but drops only an unsubmitted source draft", async () => {
  const { createExportWorkflow, createExportSelection } = await loaded;
  const selection = createExportSelection(); let route = "export"; const destinations = [];
  selection.updateSources({ accountKey: "owner", verified: true,
    favorites: { accountKey: "owner", items: { c: { conversationId: "c", title: "C" } } },
    bookmarks: { accountKey: "owner", items: {} } });
  const workflow = createExportWorkflow({ selection, isReady: () => true, readRoute: () => route,
    navigate: next => { route = next; }, prepareDateExport() {}, readSearchItems: () => [],
    showSearchToast() {}, ensureSource() {}, setDestination: value => destinations.push(value) });
  assert.equal(workflow.begin("favorites", "batch-main"), true); assert.equal(route, "favorites");
  assert.equal(workflow.handle("toggle", { source: "favorites", id: "c" }), true);
  assert.equal(workflow.handle("submit", { source: "favorites" }).added, 1);
  assert.equal(route, "export"); assert.equal(selection.basketCount(), 1);
  workflow.begin("favorites", "batch-main"); workflow.handle("toggle", { source: "favorites", id: "c" });
  workflow.leave("settings");
  assert.equal(selection.selectionContext(), null); assert.equal(selection.basketCount(), 1);
  assert.deepEqual(destinations, [{ mode: "batch", settings: null }]); selection.dispose();
});
test("export workflow validates current date rows before accepting range or detecting account switch", async () => {
  const { createExportWorkflow } = await loaded; let items = [{ conversationId: "current", accountKey: "new" }];
  const actions = [], selection = {
    selectionContext: () => ({ source: "search", returnTarget: "batch-main" }),
    selectionState: () => ({ accountKey: "old" }), cancelSelection: () => actions.push("cancel"),
    registerSearchResults: value => actions.push(value), selectSelectionRange: () => { throw new Error("must not select"); },
  };
  const flow = createExportWorkflow({ selection, isReady: () => true, readRoute: () => "search",
    navigate: value => actions.push(value), prepareDateExport() {}, readSearchItems: () => items,
    showSearchToast: key => actions.push(key), ensureSource() {}, setDestination() {} });
  assert.equal(flow.handle("select-current", { source: "search", ids: ["current", "foreign"] }), false);
  assert.deepEqual(actions, ["cancel", "export", "searchExportAccountChanged"]);
});

test("real bookmark OPEN rejection revokes execution before terminal feedback and its own repeated cancel cannot swallow it", async () => {
  const { createPanelNavigationOwner, createPanelNavigationCoordinator } = await loaded;
  const { createBookmarkNavigation } = await moduleAt("features/bookmarks/ui/bookmark-navigation.js");
  const events = []; let visible = false;
  const owner = createPanelNavigationOwner({ createId: () => "bookmark-open", cancel: () => events.push("worker-cancel"),
    onChanged: () => { visible = false; events.push("owner-changed"); } });
  let coordinator;
  const bookmarks = createBookmarkNavigation({
    isActive: () => true, isOwnerCurrent: () => true, isIntentCurrent: owner.isCurrent,
    createIntentId: () => owner.begin("bookmarks"),
    getBookmark: () => ({ conversationId: "c", messageId: "m" }),
    open: async target => {
      owner.setTarget(target.navigationIntentId, target);
      throw Object.assign(new Error("missing receipt"), { code: "ADAPTER_UNAVAILABLE" });
    },
    onCancel: (target, reason) => owner.cancel(target.navigationIntentId, reason),
    onResult: result => coordinator.openFailed({ ...result, navigationIntentId: owner.get()?.id }),
  });
  coordinator = createPanelNavigationCoordinator({ ownerTabId: 7, owner, phase: () => "ready", consumers: {},
    onOpenFailed: (payload, route) => {
      assert.equal(owner.get(), null); assert.equal(route, "bookmarks");
      assert.equal(payload.error.code, "ADAPTER_UNAVAILABLE");
      visible = true; events.push("terminal-feedback");
    } });
  assert.equal(await bookmarks.start({ bookmarkId: "b", owner: { accountKey: "a", identity: { documentId: "d" } } }), false);
  assert.equal(visible, true);
  assert.deepEqual(events, ["owner-changed", "owner-changed", "owner-changed", "worker-cancel", "terminal-feedback"]);
  assert.equal(coordinator.openFailed({ navigationIntentId: "bookmark-open" }), false);
});
