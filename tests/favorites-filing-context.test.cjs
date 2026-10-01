const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

test("Favorites filing requires exact account and tab, and stale ports cannot clear a replacement", async () => {
  const { createFavoriteFilingContextRegistry } = await import("../src/features/favorites/background/favorites-filing-context.js");
  const registry = createFavoriteFilingContextRegistry();
  const firstPanel = {}, secondPanel = {};
  assert.equal(registry.groupIdForTab(11, "account-a"), null);
  registry.update(firstPanel, { tabId: 11, accountKey: "account-a", groupId: "inspiration" });
  assert.equal(registry.groupIdForTab(11, "account-a"), "inspiration");
  assert.equal(registry.groupIdForTab(11, "account-b"), null, "the same tab under another account cannot borrow its old folder");
  assert.equal(registry.groupIdForTab(11), null, "no legacy account-less lookup is allowed");
  registry.update(firstPanel, { tabId: 11, accountKey: "account-a", groupId: null });
  assert.equal(registry.groupIdForTab(11, "account-a"), null);
  registry.update(firstPanel, { tabId: 11, accountKey: "account-a", groupId: "study" });
  registry.update(firstPanel, { tabId: 12, accountKey: "account-b", groupId: "study" });
  assert.equal(registry.groupIdForTab(11, "account-a"), null);
  assert.equal(registry.groupIdForTab(12, "account-a"), null);
  assert.equal(registry.groupIdForTab(12, "account-b"), "study");
  registry.update(secondPanel, { tabId: 12, accountKey: "account-b", groupId: "work" });
  registry.clear(firstPanel);
  assert.equal(registry.groupIdForTab(12, "account-b"), "work");
  registry.update(secondPanel, { tabId: 12, groupId: "work" });
  assert.equal(registry.groupIdForTab(12, "account-b"), null, "missing identity clears an existing destination");
  registry.update(secondPanel, { tabId: -1, accountKey: "account-a", groupId: "work" });
  assert.equal(registry.groupIdForTab(-1, "account-a"), null);
  registry.clear(secondPanel);
});

test("panel closure and invalidated content contexts retain their clean lifecycle boundary", () => {
  const panelSource = fs.readFileSync("src/app/sidepanel/panel.js", "utf8");
  assert.match(panelSource, /for \(const kind of \["favorites", "bookmarks"\]\)/);
  assert.match(panelSource, /isReady\(\) && state\.route === kind && !document\.hidden/);
  const lifecycle = fs.readFileSync("src/app/sidepanel/panel-lifecycle.js", "utf8");
  assert.match(lifecycle, /filing\.closeFavorites\(\);\s+filing\.closeBookmarks\(\);/);
  assert.match(lifecycle, /listen\(window, "pagehide", dispose, \{ once: true \}\)/);
  assert.match(panelSource, /void init\(\)\.catch/);
  for (const presentation of ["favorites-presentation.js", "time-presentation.js", "bookmarks-presentation.js"]) {
    const source = fs.readFileSync(`src/features/${presentation.split("-")[0]}/chatgpt/${presentation}`, "utf8");
    assert.match(source, /(?:pageSession|session)\.runtimeRequest/);
    assert.match(source, /(?:pageSession|session)\.onDispose/);
  }
});
