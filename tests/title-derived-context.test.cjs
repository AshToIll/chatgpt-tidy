const assert = require("node:assert/strict");
const test = require("node:test");

const plain = (value) => JSON.parse(JSON.stringify(value));
const firstTime = "2026-09-08T01:00:00.000Z";
const nextTime = "2026-09-09T01:00:00.000Z";

// Load production storage domains with their real platform route and snapshot dependencies.
const domainModules = Promise.all([
  import("../src/features/bookmarks/storage/bookmarks-domain.js"),
  import("../src/features/favorites/storage/favorites-domain.js"),
]);
let bookmarks;
let favorites;
test.before(async () => { [bookmarks, favorites] = await domainModules; });
const sourced = (value) => ({ value, source: value === null ? null : "fixture", status: value === null ? "missing" : "available" });

function snapshot({ id = "conversation-a", title = "Original", messageIds = ["message-1"], bindingStatus = "bound", identityStatus = "stable" } = {}) {
  return {
    schemaVersion: "chatgpt-tidy.snapshot.v1",
    capturedAt: nextTime,
    route: { pathname: `/c/${id}` },
    appearance: { colorScheme: "light", source: "fixture", status: "available", surface: sourced("rgb(255, 255, 255)") },
    conversation: {
      conversationId: id, draftId: null, identityStatus, bindingStatus,
      title: sourced(title), createdAt: sourced(firstTime), updatedAt: sourced(nextTime), project: null,
    },
    sidebarConversations: [],
    messages: messageIds.map((messageId, index) => ({
      messageId, idStatus: "stable", presentationStatus: "formal", role: "assistant",
      timestamp: sourced(firstTime), excerpt: sourced(`Saved excerpt ${messageId}`),
      order: { index, displayNumber: index + 1 }, locator: { strategy: "data-message-id", value: messageId },
    })),
  };
}

function savedBookmarks() {
  const initial = snapshot({ messageIds: ["message-1", "message-2"] });
  let state = bookmarks.createEmptyBookmarksState();
  for (const message of initial.messages) {
    state = bookmarks.addBookmarkFromSnapshot(state, initial, message.messageId, { groupId: "bookmark-insight", now: firstTime });
    state.items[bookmarks.bookmarkKey("conversation-a", message.messageId)].note = `Note ${message.messageId}`;
  }
  return bookmarks.addBookmarkFromSnapshot(state, snapshot({ id: "conversation-b" }), "message-1", { now: firstTime });
}

test("bound title refresh reaches every existing bookmark even when no messages are mounted", () => {
  const before = savedBookmarks();
  const title = "2026/09/08 | Original";
  const after = bookmarks.refreshBookmarksFromSnapshot(before, snapshot({ title, messageIds: [] }), { now: nextTime });
  assert.equal(after.revision, before.revision + 1, "all title changes share one storage revision");
  assert.deepEqual(Object.keys(after.items), Object.keys(before.items), "refresh does not add, remove or reorder bookmarks");
  for (const [id, item] of Object.entries(before.items)) {
    assert.deepEqual(plain(after.items[id]), plain(item.conversationId === "conversation-a"
      ? { ...item, conversationTitle: title, metadataRefreshedAt: nextTime } : item));
  }
  assert.deepEqual(plain(after.groups), plain(before.groups));
  assert.deepEqual(plain(after.view), plain(before.view));
});

test("mounted messages retain their normal metadata refresh while unmounted bookmarks retain saved message data", () => {
  const before = savedBookmarks();
  const current = snapshot({ title: "New title", messageIds: ["message-2"] });
  current.messages[0].excerpt = sourced("New visible excerpt");
  current.messages[0].order = { index: 7, displayNumber: 8 };
  const after = bookmarks.refreshBookmarksFromSnapshot(before, current, { now: nextTime });
  const hiddenId = bookmarks.bookmarkKey("conversation-a", "message-1");
  const visibleId = bookmarks.bookmarkKey("conversation-a", "message-2");
  assert.deepEqual(plain(after.items[hiddenId]), plain({ ...before.items[hiddenId], conversationTitle: "New title", metadataRefreshedAt: nextTime }));
  assert.equal(after.items[visibleId].conversationTitle, "New title");
  assert.equal(after.items[visibleId].excerpt, "New visible excerpt");
  assert.equal(after.items[visibleId].orderIndex, 7);
  assert.equal(after.items[visibleId].note, before.items[visibleId].note);
  assert.equal(after.items[visibleId].groupId, before.items[visibleId].groupId);
  assert.equal(after.items[visibleId].bookmarkedAt, firstTime);
});

test("transient message content cannot replace a saved bookmark but its bound conversation title can refresh", () => {
  const before = savedBookmarks();
  const current = snapshot({ title: "Confirmed title" });
  current.messages[0].presentationStatus = "transient";
  current.messages[0].excerpt = sourced("Unfinished draft text");
  const after = bookmarks.refreshBookmarksFromSnapshot(before, current, { now: nextTime });
  const key = bookmarks.bookmarkKey("conversation-a", "message-1");
  assert.deepEqual(plain(after.items[key]), plain({ ...before.items[key], conversationTitle: "Confirmed title", metadataRefreshedAt: nextTime }));
});

test("date removal updates unmounted bookmark titles and a repeated snapshot produces no further write", () => {
  const original = savedBookmarks();
  const renamed = bookmarks.refreshBookmarksFromSnapshot(original, snapshot({ title: "Dated", messageIds: [] }), { now: nextTime });
  const restored = bookmarks.refreshBookmarksFromSnapshot(renamed, snapshot({ title: "Original", messageIds: [] }), { now: nextTime });
  const repeated = bookmarks.refreshBookmarksFromSnapshot(restored, snapshot({ title: "Original", messageIds: [] }), { now: "2026-09-09T02:00:00.000Z" });
  assert.equal(restored.revision, renamed.revision + 1);
  assert.deepEqual(plain(repeated), plain(restored));
  for (const item of Object.values(restored.items)) assert.equal(item.conversationTitle, "Original");
});

test("missing titles, other conversations, drafts and unbound snapshots cannot rewrite saved titles", () => {
  const before = savedBookmarks();
  for (const current of [
    snapshot({ title: null, messageIds: [] }),
    snapshot({ id: "unknown-conversation", title: "Wrong", messageIds: [] }),
    snapshot({ bindingStatus: "route-only", title: "Wrong", messageIds: [] }),
    snapshot({ bindingStatus: "mismatch", title: "Wrong", messageIds: [] }),
    snapshot({ identityStatus: "draft", title: "Wrong", messageIds: [] }),
  ]) assert.deepEqual(plain(bookmarks.refreshBookmarksFromSnapshot(before, current, { now: nextTime })), plain(before));
});

test("bounded unmounted titles do not create a repeated normalization write loop", () => {
  const before = savedBookmarks();
  const current = snapshot({ title: "x".repeat(600), messageIds: [] });
  const after = bookmarks.refreshBookmarksFromSnapshot(before, current, { now: nextTime });
  const repeated = bookmarks.refreshBookmarksFromSnapshot(after, current, { now: nextTime });
  assert.equal(after.items[bookmarks.bookmarkKey("conversation-a", "message-1")].conversationTitle.length, 512);
  assert.deepEqual(plain(repeated), plain(after));
});

test("existing favorite title propagation preserves user filing when dates are removed", () => {
  const before = favorites.upsertFavoriteFromSnapshot(favorites.createEmptyFavoritesState(), snapshot(), { groupId: "inspiration", now: firstTime });
  before.items["conversation-a"].note = "Keep my note";
  const after = favorites.refreshFavoriteFromSnapshot(before, snapshot({ title: "Dated", messageIds: [] }), { now: nextTime });
  assert.deepEqual(plain(after.items["conversation-a"]), plain({ ...before.items["conversation-a"], title: "Dated", metadataRefreshedAt: nextTime }));
  assert.deepEqual(plain(favorites.refreshFavoriteFromSnapshot(after, snapshot({ title: "Dated", messageIds: [] }), { now: nextTime })), plain(after));
  const restored = favorites.refreshFavoriteFromSnapshot(after, snapshot({ title: "Original", messageIds: [] }), { now: nextTime });
  assert.equal(restored.items["conversation-a"].title, "Original");
  assert.equal(restored.items["conversation-a"].note, "Keep my note");
  assert.equal(restored.items["conversation-a"].savedAt, firstTime);
  assert.equal(restored.items["conversation-a"].groupId, "inspiration");
});
