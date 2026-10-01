const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { loadExportModule } = require("./helpers/export-runtime.cjs");
const plain = value => JSON.parse(JSON.stringify(value));
function harness() {
  const timers = new Map(), archivedTimers = new Map(); let serial = 0, language = "one";
  const events = [];
  const context = vm.createContext({ setTimeout(callback) { const id = ++serial; timers.set(id, callback); archivedTimers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); } });
  const { createExportSelection } = loadExportModule(context, "src/features/export/ui/export-selection.js");
  const owner = createExportSelection({ noticeText: (key, values) => language + ":" + key + ":" + JSON.stringify(values || {}),
    onChanged: event => events.push(event) });
  const favorites = { accountKey: "a", revision: 1, items: { x: { title: "X" }, y: { title: "Y" } } };
  const bookmarks = { accountKey: "a", revision: 1, items: { mark: { bookmarkId: "mark", conversationId: "x" } }, groups: [] };
  const update = patch => owner.updateSources({ accountKey: "a", verified: true, favorites, bookmarks, ...patch });
  update();
  return { owner, events, favorites, bookmarks, update, timers, archivedTimers, language: value => { language = value; } };
}
const date = (id, accountKey = "catalog-a") => ({ source: "conversation", matchKind: "conversation-date", messageId: null,
  conversationId: id, title: id, accountKey, conversationCreatedAt: null, conversationUpdatedAt: null });
function add(h, source, ids, destination = "source") {
  assert.equal(h.owner.beginSelection(source, destination), true);
  h.owner.selectSelectionRange(source, ids); return h.owner.submitSelection(source);
}

test("selection can initialize and select before any view exists", () => {
  const h = harness(); add(h, "favorites", ["x"]);
  assert.equal(h.owner.basketCount(), 1);
  assert.deepEqual(plain(h.owner.selectionState("favorites").basketConversationIds), ["x"]);
  h.owner.dispose();
});

test("selection snapshots deeply isolate basket and repository metadata from callers", () => {
  const h = harness(); add(h, "favorites", ["x"]);
  const snapshot = h.owner.snapshot();
  assert.ok(Object.isFrozen(snapshot.basket.conversations[0].sources));
  assert.ok(Object.isFrozen(snapshot.favorites.items.x));
  assert.throws(() => snapshot.basket.conversations.push({ conversationId: "evil" }));
  snapshot.favorites.items.x.title = "not accepted";
  h.favorites.items.x.title = "outside mutation";
  assert.equal(h.owner.snapshot().favorites.items.x.title, "X");
  assert.equal(h.owner.basketCount(), 1);
  h.owner.dispose();
});

test("read-only source projection returns detached nested selections and context", () => {
  const h = harness(); add(h, "favorites", ["x"]); h.owner.beginSelection("favorites", "manage");
  h.owner.toggleSelection("favorites", "y");
  const projection = h.owner.selectionState("favorites"), context = h.owner.selectionContext();
  projection.draftIds.push("evil"); projection.basketConversationSources.x.push("search");
  projection.basketConversationIds.length = 0; context.source = "bookmarks";
  assert.deepEqual(plain(h.owner.selectionState("favorites").draftIds), ["y"]);
  assert.deepEqual(plain(h.owner.selectionState("favorites").basketConversationSources.x), ["favorites"]);
  assert.equal(h.owner.selectionContext().source, "favorites");
  h.owner.dispose();
});

test("draft cancellation and picker replacement never discard submitted basket", () => {
  const h = harness(); add(h, "favorites", ["x"]); h.owner.beginSelection("favorites");
  h.owner.toggleSelection("favorites", "y"); h.owner.cancelSelection();
  assert.equal(h.owner.basketCount(), 1);
  h.owner.beginSelection("favorites"); assert.deepEqual(plain(h.owner.selectionState("favorites").draftIds), []);
  h.owner.toggleSelection("favorites", "y"); h.owner.beginSelection("bookmarks");
  assert.deepEqual(plain(h.owner.selectionState("bookmarks").draftIds), []);
  assert.equal(h.owner.basketCount(), 1); h.owner.dispose();
});

test("date pagination retains private draft and candidates; invalid DTOs and foreign catalog owners are excluded", () => {
  const h = harness(); h.owner.beginSelection("search");
  assert.equal(h.owner.registerSearchResults([date("page1"), { ...date("keyword"), matchKind: "keyword", messageId: "m1" }]), 1);
  h.owner.selectSelectionRange("search", ["page1", "unknown"]);
  h.owner.registerSearchResults([date("page2"), date("foreign", "other")]);
  h.owner.selectSelectionRange("search", ["page2", "foreign"]);
  assert.deepEqual(plain(h.owner.selectionState("search").draftIds), ["page1", "page2"]);
  h.owner.submitSelection("search");
  assert.equal(h.owner.basketCount(), 2);
  h.owner.beginSelection("search");
  assert.equal(h.owner.toggleSelection("search", "page1"), false);
  assert.equal(h.owner.snapshot().basket.conversations[0].searchMetadata.accountKey, "catalog-a");
  h.owner.dispose();
});

test("reconciliation removes only proven missing membership and preserves independently submitted source metadata", () => {
  const h = harness(); add(h, "favorites", ["x"]); h.owner.beginSelection("search");
  h.owner.registerSearchResults([date("x")]); h.owner.toggleSelection("search", "x"); h.owner.submitSelection("search");
  h.update({ favorites: null });
  assert.deepEqual(plain(h.owner.snapshot().basket.conversations[0].sources), ["favorites", "search"]);
  h.update({ favorites: { accountKey: "a", revision: 2, items: {} } });
  assert.deepEqual(plain(h.owner.snapshot().basket.conversations[0].sources), ["search"]);
  h.owner.dispose();
});

test("suspension hides public selection while revalidation retains draft and account change clears both", () => {
  const h = harness(); add(h, "favorites", ["x"]); h.owner.beginSelection("favorites"); h.owner.toggleSelection("favorites", "y");
  h.owner.suspend(); assert.equal(h.owner.basketCount(), 0);
  assert.equal(h.owner.selectionContext(), null);
  assert.deepEqual(plain(h.owner.selectionState("favorites").draftIds), []);
  h.update(); assert.equal(h.owner.basketCount(), 1);
  assert.deepEqual(plain(h.owner.selectionState("favorites").draftIds), ["y"]);
  h.owner.updateSources({ accountKey: "b", verified: true });
  assert.equal(h.owner.basketCount(), 0); assert.equal(h.owner.snapshot().favorites, null);
  assert.equal(h.owner.selectionContext(), null); h.owner.dispose();
});

test("ordinary reads, localization, and stable source input emit no mutations and retain timer lifetime", () => {
  const h = harness(); add(h, "favorites", ["x"]); const events = h.events.length, timers = [...h.timers.keys()];
  h.language("two");
  for (let i = 0; i < 20; i++) { h.owner.snapshot(); h.owner.selectionState("favorites"); h.update(); }
  assert.equal(h.events.length, events);
  assert.deepEqual([...h.timers.keys()], timers);
  assert.match(h.owner.selectionState("favorites").notice, /^two:/); h.owner.dispose();
});

test("cancelled notice and highlight callbacks cannot erase a newer feedback owner", () => {
  const h = harness(); add(h, "favorites", ["x"]); const oldNotice = [...h.timers.keys()][0];
  add(h, "favorites", ["y"]); h.archivedTimers.get(oldNotice)();
  assert.ok(h.owner.selectionState("favorites").notice);
  h.owner.removeConversation("x"); add(h, "favorites", ["x"], "manage");
  const oldHighlight = [...h.timers.keys()][0];
  h.owner.removeConversation("y"); add(h, "favorites", ["y"], "manage");
  h.archivedTimers.get(oldHighlight)();
  assert.deepEqual(plain(h.owner.snapshot().batchHighlightedConversationIds), ["y"]); h.owner.dispose();
});

test("unknown identity input suspends rather than clearing basket; only a fresh verified different owner replaces it", () => {
  const h = harness(); add(h, "favorites", ["x"]); h.owner.beginSelection("favorites"); h.owner.toggleSelection("favorites", "y");
  h.owner.updateSources({ accountKey: null, verified: false, favorites: null, bookmarks: null });
  assert.equal(h.owner.basketCount(), 0);
  assert.equal(h.owner.selectionState("favorites").active, false);
  assert.equal(h.owner.snapshot().basket.conversations.length, 1);
  h.update();
  assert.equal(h.owner.basketCount(), 1);
  assert.deepEqual(plain(h.owner.selectionState("favorites").draftIds), ["y"]);
  h.owner.updateSources({ accountKey: "b", verified: false });
  assert.equal(h.owner.basketCount(), 0);
  h.update(); assert.equal(h.owner.basketCount(), 1);
  h.owner.updateSources({ accountKey: "b", verified: true });
  assert.equal(h.owner.basketCount(), 0);
  assert.equal(h.owner.snapshot().basket.conversations.length, 0);
  h.owner.dispose();
});
