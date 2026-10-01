const assert = require("node:assert/strict");
const test = require("node:test");

test("Bookmarks filing rejects missing accounts and preserves only the exact live owner", async () => {
  const { createBookmarkFilingContextRegistry } = await import("../src/features/bookmarks/background/bookmarks-filing-context.js");
  const registry = createBookmarkFilingContextRegistry();
  const first = {}, second = {};
  registry.update(first, { tabId: 11, accountKey: "account-a", groupId: "bookmark-insight" });
  assert.equal(registry.groupIdForTab(11, "account-a"), "bookmark-insight");
  assert.equal(registry.groupIdForTab(11, "account-b"), null);
  assert.equal(registry.groupIdForTab(11), null);
  registry.update(first, { tabId: 11, accountKey: "account-a", groupId: null });
  assert.equal(registry.groupIdForTab(11, "account-a"), null);
  registry.update(first, { tabId: 11, accountKey: "account-a", groupId: "bookmark-todo" });
  registry.update(second, { tabId: 11, accountKey: "account-b", groupId: "bookmark-quote" });
  registry.clear(first);
  assert.equal(registry.groupIdForTab(11, "account-b"), "bookmark-quote");
  assert.equal(registry.groupIdForTab(11, "account-a"), null);
  registry.update(second, { tabId: 11, accountKey: " ", groupId: "bookmark-quote" });
  assert.equal(registry.groupIdForTab(11, "account-b"), null, "identity uncertainty revokes the stale folder");
  registry.clear(second);
});
