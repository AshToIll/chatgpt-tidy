const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const load = relative => import(pathToFileURL(path.join(root, relative)).href);
const factories = Promise.all([
  load("src/features/favorites/ui/favorites-actions.js"),
  load("src/features/bookmarks/ui/bookmarks-actions.js"),
]);

async function harness(kind) {
  const [favorites, bookmarks] = await factories;
  const h = {
    kind, ready: true, current: true, accepted: true, navigationCurrent: true, completed: false,
    owner: { accountKey: "account-a", identity: { documentId: "doc-a", epoch: 4 } },
    conversation: { conversationId: "conversation-a", isFavorite: false },
    calls: { captures: 0, requests: [], mutations: [], toasts: [], refreshes: 0, starts: [], begins: [] },
    requestResult: { revision: 2 },
  };
  const options = {
    ownerTabId: 7,
    isReady: () => h.ready,
    captureOwner: () => { h.calls.captures++; return h.owner; },
    isOwnerCurrent: owner => { assert.equal(owner, h.owner); return h.current; },
    acceptMutation: (owner, result) => { h.calls.mutations.push({ owner, result }); return h.accepted; },
    refresh: async () => { h.calls.refreshes++; },
    request: async (type, payload) => {
      h.calls.requests.push({ type, payload });
      if (h.error) throw h.error;
      return h.requestResult;
    },
    toast: (...args) => h.calls.toasts.push(args),
    readCurrentConversation: () => ({ ...h.conversation }),
    beginNavigation: target => { h.calls.begins.push(target); return "nav-1"; },
    isNavigationCurrent: id => { assert.equal(id, "nav-1"); return h.navigationCurrent; },
    isNavigationCompleted: id => { assert.equal(id, "nav-1"); return h.completed; },
    readCurrentConversationId: () => h.conversation.conversationId,
    startNavigation: async target => {
      h.calls.starts.push(target);
      if (h.navigationError) throw h.navigationError;
    },
  };
  h.actions = kind === "favorites"
    ? favorites.createFavoritesActions(options) : bookmarks.createBookmarksActions(options);
  return h;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const mutationCases = {
  favorites: [
    ["toggle-current", "FAVORITES_TOGGLE_CURRENT", "favoriteAdded"],
    ["remove", "FAVORITES_REMOVE", "favoriteRemoved"],
    ["move", "FAVORITES_MOVE", "favoriteMoved"],
    ["group-create", "FAVORITES_GROUP_CREATE", "groupCreated"],
    ["group-update", "FAVORITES_GROUP_UPDATE", "groupUpdated"],
    ["group-delete", "FAVORITES_GROUP_DELETE", "groupDeleted"],
    ["group-reorder", "FAVORITES_GROUP_REORDER", "groupUpdated"],
    ["view-update", "FAVORITES_VIEW_UPDATE", null],
  ],
  bookmarks: [
    ["remove", "BOOKMARKS_REMOVE", "bookmarkRemoved"],
    ["move", "BOOKMARKS_MOVE", "bookmarkMoved"],
    ["group-create", "BOOKMARKS_GROUP_CREATE", "groupCreated"],
    ["group-update", "BOOKMARKS_GROUP_UPDATE", "groupUpdated"],
    ["group-delete", "BOOKMARKS_GROUP_DELETE", "bookmarkGroupDeleted"],
    ["group-reorder", "BOOKMARKS_GROUP_REORDER", "groupUpdated"],
    ["view-update", "BOOKMARKS_VIEW_UPDATE", null],
  ],
};

for (const kind of ["favorites", "bookmarks"]) {
  test(kind + " actions retain every mutation and stamp the captured owner", async () => {
    for (const [action, type, toast] of mutationCases[kind]) {
      const h = await harness(kind);
      const payload = { groupId: "group-1", bookmarkId: "bookmark-1", expectedTabId: 999,
        expectedAccountKey: "forged", expectedIdentity: { epoch: 999 }, expectedConversationId: "forged" };
      await h.actions.handle(action, payload);
      assert.equal(h.calls.captures, 1);
      assert.equal(h.calls.requests[0].type, globalThis.TidyProtocol.Type[type]);
      const sent = h.calls.requests[0].payload;
      assert.equal(sent.expectedTabId, 7);
      assert.equal(sent.expectedAccountKey, "account-a");
      assert.equal(sent.expectedIdentity, h.owner.identity);
      assert.equal(sent.groupId, "group-1");
      if (action === "toggle-current") assert.equal(sent.expectedConversationId, "conversation-a");
      assert.equal(payload.expectedTabId, 999, "caller payload is not mutated");
      assert.deepEqual(h.calls.mutations, [{ owner: h.owner, result: h.requestResult }]);
      assert.deepEqual(h.calls.toasts, toast ? [[toast]] : []);
      assert.equal(h.calls.refreshes, 0);
    }
  });

  test(kind + " readiness and unknown actions do not acquire library ownership", async () => {
    const h = await harness(kind);
    h.ready = false;
    await h.actions.handle("remove");
    await h.actions.handle("open");
    h.ready = true;
    await h.actions.handle("unknown");
    await h.actions.handle("toString");
    assert.equal(h.calls.captures, 0);
    assert.equal(h.calls.requests.length, 0);
    assert.equal(h.calls.starts.length, 0);
  });

  test(kind + " missing owner refreshes without issuing the action", async () => {
    for (const action of ["remove", "open"]) {
      const h = await harness(kind);
      h.owner.accountKey = null;
      await h.actions.handle(action);
      assert.equal(h.calls.refreshes, 1);
      assert.equal(h.calls.requests.length, 0);
      assert.equal(h.calls.starts.length, 0);
      assert.equal(h.calls.begins.length, 0);
    }
  });

  test(kind + " stale mutation success or failure cannot mutate, toast or refresh", async () => {
    for (const failed of [false, true]) {
      const h = await harness(kind), gate = deferred();
      h.requestResult = gate.promise;
      const work = h.actions.handle("remove");
      h.current = false;
      if (failed) gate.reject(new Error("late failure")); else gate.resolve({ revision: 3 });
      await work;
      assert.deepEqual(h.calls.mutations, []);
      assert.deepEqual(h.calls.toasts, []);
      assert.equal(h.calls.refreshes, 0);
    }
  });

  test(kind + " rejected mutation acceptance does not publish a success toast", async () => {
    const h = await harness(kind);
    h.accepted = false;
    await h.actions.handle("remove");
    assert.equal(h.calls.mutations.length, 1);
    assert.deepEqual(h.calls.toasts, []);
  });

  test(kind + " mutation failures preserve diagnostic cause and refresh only current ownership", async () => {
    for (const code of ["CONTEXT_MISMATCH", "PERSISTENCE_REJECTED", "OTHER"]) {
      const h = await harness(kind);
      h.error = Object.assign(new Error("failure"), { code });
      await h.actions.handle("remove");
      const expected = code === "CONTEXT_MISMATCH" ? "contextChanged"
        : kind === "favorites" && code === "PERSISTENCE_REJECTED" ? "favoriteUnavailable" : "libraryChangeUnknown";
      assert.equal(h.calls.toasts[0][0], expected);
      assert.equal(h.calls.toasts[0][1], true);
      assert.deepEqual(h.calls.toasts[0][2], {});
      assert.deepEqual(h.calls.toasts[0][3], kind === "favorites"
        ? { cause: h.error, navigationIntentId: undefined } : { cause: h.error },
      "mutations retain their persistent lifecycle without a navigation owner or timeout");
      assert.equal(h.calls.refreshes, 1);
    }
  });
}

test("favorite toggle freezes the current target and added/removed feedback at click time", async () => {
  const h = await harness("favorites"), gate = deferred();
  h.conversation.isFavorite = true;
  h.requestResult = gate.promise;
  const work = h.actions.handle("toggle-current");
  h.conversation = { conversationId: "conversation-b", isFavorite: false };
  gate.resolve({ revision: 3 });
  await work;
  assert.equal(h.calls.requests[0].payload.expectedConversationId, "conversation-a");
  assert.deepEqual(h.calls.toasts, [["favoriteRemoved"]]);
});

test("favorite open registers its exact target and never accepts a library mutation", async () => {
  const h = await harness("favorites");
  await h.actions.handle("open", { conversationId: "destination", navigationIntentId: "forged" });
  assert.deepEqual(h.calls.begins, [{ conversationId: "destination", placement: "latest" }]);
  assert.equal(h.calls.requests[0].type, globalThis.TidyProtocol.Type.FAVORITES_OPEN);
  assert.equal(h.calls.requests[0].payload.navigationIntentId, "nav-1");
  assert.deepEqual(h.calls.mutations, []);
  assert.deepEqual(h.calls.toasts, []);
});

test("favorite open failure retains navigation cause while completed or superseded receipts stay quiet", async () => {
  for (const state of ["current", "completed", "superseded"]) {
    const h = await harness("favorites"), gate = deferred();
    h.requestResult = gate.promise;
    const work = h.actions.handle("open", { conversationId: "destination" });
    h.completed = state === "completed";
    h.navigationCurrent = state !== "superseded";
    const cause = new Error("late OPEN rejection");
    gate.reject(cause);
    await work;
    if (state === "current") {
      assert.deepEqual(h.calls.toasts, [["bookmarkOpenFailed", true, {}, {
        owner: "favorites", navigationIntentId: "nav-1", durationMs: 5000, cause,
      }]]);
      assert.equal(h.calls.refreshes, 1);
    } else {
      assert.deepEqual(h.calls.toasts, []);
      assert.equal(h.calls.refreshes, 0);
    }
  }
});

test("bookmark open delegates exactly once with captured owner and source conversation", async () => {
  const h = await harness("bookmarks");
  await h.actions.handle("open", { bookmarkId: "bookmark-1" });
  assert.deepEqual(h.calls.starts, [{
    bookmarkId: "bookmark-1", owner: h.owner, sourceConversationId: "conversation-a",
  }]);
  assert.deepEqual(h.calls.requests, []);
  assert.deepEqual(h.calls.mutations, []);
  assert.deepEqual(h.calls.toasts, []);
});

test("bookmark navigation errors remain owned by its navigation controller", async () => {
  const h = await harness("bookmarks");
  h.navigationError = new Error("navigation controller failure");
  await assert.rejects(h.actions.handle("open", { bookmarkId: "bookmark-1" }), error => error === h.navigationError);
  assert.deepEqual(h.calls.toasts, []);
  assert.equal(h.calls.refreshes, 0);
});

test("favorite validation rejection is definite and transient, not an unknown write", async () => {
  // VALIDATION_ERROR can describe a name, icon, id or ordering failure; do not
  // mislabel every deterministic rejection as an empty-name error.
  for (const [action, payload] of [
    ["group-create", { name: "   " }],
    ["group-update", { groupId: "group-1", patch: { name: "　" } }],
    ["group-update", { groupId: "group-1", patch: { icon: "invalid" } }],
    ["group-reorder", { orderedGroupIds: [] }],
  ]) {
    const h = await harness("favorites");
    h.error = Object.assign(new Error("private validation detail"), { code: "VALIDATION_ERROR" });
    await h.actions.handle(action, payload);
    assert.equal(h.calls.toasts.length, 1);
    const [key, error, values, lifecycle] = h.calls.toasts[0];
    assert.equal(key, "actionFailed");
    assert.equal(error, true);
    assert.deepEqual(values, {});
    assert.equal(lifecycle.durationMs, 5000);
    assert.equal(lifecycle.owner, "favorites");
    assert.equal(lifecycle.cause, h.error);
    assert.equal(h.calls.mutations.length, 0);
    assert.equal(h.calls.refreshes, 1);
  }
});

test("late favorite validation failure remains fenced by account ownership", async () => {
  const h = await harness("favorites"), gate = deferred();
  h.requestResult = gate.promise;
  const work = h.actions.handle("group-create", { name: "Example" });
  h.current = false;
  gate.reject(Object.assign(new Error("invalid"), { code: "VALIDATION_ERROR" }));
  await work;
  assert.deepEqual(h.calls.toasts, []);
  assert.equal(h.calls.refreshes, 0);
});
