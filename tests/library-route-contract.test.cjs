const assert = require("node:assert/strict");
const test = require("node:test");
const { snapshotHarness } = require("./helpers/adapter-snapshot.cjs");

const modules = Promise.all([
  import("../src/features/favorites/storage/favorites-domain.js"),
  import("../src/features/bookmarks/storage/bookmarks-domain.js"),
]);
const id = "route-contract-chat";
const messageId = "route-contract-message";
const ordinary = `/c/${id}`;
const project = `/g/g-p-route-contract/c/${id}`;
const valid = [ordinary, project].flatMap((path) => [
  [path, path], [path + "/", path], [path + "?q=one#message", path],
  [path + "/?q=one#message", path], ["https://chatgpt.com" + path, path],
  ["https://chatgpt.com" + path + "/?q=one#message", path],
]);
const invalid = [
  null, undefined, "", `/c/${id}-other`, "/c/other", "/", "/c/", ordinary + "/extra",
  `/g/g-custom/c/${id}`, `/g/g-p-route-contract`, `/share/${id}`, `/gg/${id}`, `/draft/${id}`,
  "https://evil.test" + ordinary, "http://chatgpt.com" + ordinary,
  "https://chatgpt.com:443" + ordinary, "https://chatgpt.com:8443" + ordinary,
  "https://user@chatgpt.com" + ordinary, "//chatgpt.com" + ordinary,
  "https://chatgpt.com.evil.test" + ordinary, `c/${id}`, `/discard/..${ordinary}`,
  ordinary + "/../" + id, ordinary + "\n", ordinary.replace("/c/", "\\c\\"),
];

function snapshot(path) {
  if (arguments.length === 0) path = ordinary;
  const route = path?.includes("/g/g-p-") ? project : ordinary;
  const result = snapshotHarness({
    url: "https://chatgpt.com" + route,
    sidebar: [{ href: route, title: "Route contract", record: {
      id, title: "Route contract", create_time: 1700000000, update_time: 1700000001,
    } }],
    messages: [{ id: messageId, role: "assistant", record: {
      id: messageId, conversation_id: id, author: { role: "assistant" }, create_time: 1700000002,
      content: { content_type: "text", parts: ["Route contract message"] },
    } }],
  });
  result.route.pathname = path;
  return result;
}

for (const kind of ["favorites", "bookmarks"]) {
  test(`${kind}: current writes and stored reads use the same canonical route contract`, async () => {
    const [f, b] = await modules;
    const empty = () => kind === "favorites" ? f.createEmptyFavoritesState() : b.createEmptyBookmarksState();
    const save = (state, input) => kind === "favorites"
      ? f.upsertFavoriteFromSnapshot(state, input)
      : b.addBookmarkFromSnapshot(state, input, messageId);
    const normalize = kind === "favorites" ? f.normalizeFavoritesState : b.normalizeBookmarksState;
    const refresh = kind === "favorites" ? f.refreshFavoriteFromSnapshot : b.refreshBookmarksFromSnapshot;
    const key = kind === "favorites" ? id : b.bookmarkKey(id, messageId);
    const initial = save(empty(), snapshot());
    assert.ok(initial.items[key], "fixture is eligible under the real snapshot contract");
    for (const [input, expected] of valid) {
      assert.equal(globalThis.TidySnapshot.isPersistenceEligible(snapshot(input)), true, `UI accepts ${input}`);
      assert.equal(save(empty(), snapshot(input)).items[key].routePath, expected, input);
      assert.equal(save(initial, snapshot(input)).items[key].routePath, expected, `update ${input}`);
      const stored = structuredClone(initial);
      stored.items[key].routePath = input;
      assert.equal(normalize(stored).items[key].routePath, expected, `read ${input}`);
    }
    for (const input of invalid) {
      const before = structuredClone(initial);
      const candidate = snapshot(input);
      assert.equal(globalThis.TidySnapshot.isPersistenceEligible(candidate), false, `UI must reject the same route as storage: ${input}`);
      for (const state of [empty(), initial]) {
        assert.throws(() => save(state, candidate), { code: "PERSISTENCE_REJECTED" }, String(input));
      }
      assert.deepEqual(refresh(initial, candidate), initial, "ineligible metadata cannot overwrite a valid record");
      assert.deepEqual(initial, before, "a rejected write must not mutate current data");
      const stored = structuredClone(initial);
      stored.items[key].routePath = input;
      assert.deepEqual(normalize(stored).items, {}, `discard invalid persisted route: ${input}`);
    }
    for (const badId of [null, undefined, "", ` ${id}`, `${id} `]) {
      const stored = structuredClone(initial);
      stored.items[key].conversationId = badId;
      assert.deepEqual(normalize(stored).items, {}, "do not repair an ID to make its route match");
    }
    const mixed = structuredClone(initial);
    mixed.items.invalid = { ...mixed.items[key], conversationId: "other", routePath: ordinary };
    assert.deepEqual(normalize(mixed), initial, "discard only the invalid record, preserving valid data");
  });
}

test("sidebar favorites use the same contract for creates and updates", async () => {
  const [f] = await modules;
  const row = snapshot().sidebarConversations[0];
  assert.ok(globalThis.TidySnapshot.isSidebarPersistenceEligible(row));
  const initial = f.upsertFavoriteFromSidebarConversation(f.createEmptyFavoritesState(), row);
  for (const [input, expected] of valid) {
    const candidate = { ...row, locator: { ...row.locator, value: input } };
    for (const state of [f.createEmptyFavoritesState(), initial]) {
      assert.equal(f.upsertFavoriteFromSidebarConversation(state, candidate).items[id].routePath, expected);
    }
  }
  for (const input of invalid.filter((value) => typeof value === "string" && value)) {
    const candidate = { ...row, locator: { ...row.locator, value: input } };
    assert.equal(globalThis.TidySnapshot.isSidebarPersistenceEligible(candidate), false, `UI rejects ${input}`);
    assert.throws(() => f.upsertFavoriteFromSidebarConversation(initial, candidate), { code: "PERSISTENCE_REJECTED" }, input);
  }
});

test("the shared library contract delegates current route grammar and compares exact IDs", async () => {
  const { canonicalConversationPath, parseConversationRoute } = await import("../src/platform/navigation/conversation-route.js");
  for (const [input, expected] of valid) {
    assert.equal(canonicalConversationPath(input, id), expected);
    assert.equal(expected, parseConversationRoute(input).pathname);
    assert.equal(canonicalConversationPath(input, id.slice(0, -1)), null);
  }
  for (const input of [...invalid, {}, 12, true]) assert.equal(canonicalConversationPath(input, id), null);
  for (const badId of [null, undefined, "", {}, ` ${id}`, `${id} `]) {
    assert.equal(canonicalConversationPath(ordinary, badId), null);
  }
});

test("bookmark metadata refresh rejects an invalid route even when its message is unmounted", async () => {
  const [, b] = await modules;
  const initial = b.addBookmarkFromSnapshot(b.createEmptyBookmarksState(), snapshot(), messageId);
  const input = snapshot("/c/other");
  input.messages = [];
  input.conversation.title.value = "Changed title";
  assert.equal(globalThis.TidySnapshot.isPersistenceEligible(input), false);
  assert.deepEqual(b.refreshBookmarksFromSnapshot(initial, input), initial, "ineligible metadata cannot overwrite title or route");
});
