const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createLibraryViewHarness } = require("./helpers/library-view-harness.cjs");

function stripModuleSyntax(source) {
  return source
    .replace(/^import[\s\S]*?;\r?\n/gm, "")
    .replaceAll("export ", "");
}

function loadDomain() {
  const contractContext = vm.createContext({});
  vm.runInContext(fs.readFileSync("src/platform/snapshot.js", "utf8"), contractContext);
  const routeSource = stripModuleSyntax(fs.readFileSync("src/platform/navigation/conversation-route.js", "utf8"));
  const source = fs.readFileSync("src/features/bookmarks/storage/bookmarks-domain.js", "utf8").replace(/^import .*$/gm, "").replace(/export /g, "");
  const context = vm.createContext({
    URL, Date, Math, Object, Array, String, Number, Boolean, JSON, Set, Map,
    crypto: { randomUUID: () => "fixed" },
    TidySnapshot: {
      ...contractContext.TidySnapshot,
      MAX_MESSAGE_EXCERPT_LENGTH: 320,
      isPersistenceEligible(snapshot) { return snapshot?.conversation?.identityStatus === "stable" && snapshot?.conversation?.bindingStatus === "bound"; },
      persistenceEligibleMessage(snapshot, id) {
        if (!this.isPersistenceEligible(snapshot)) return null;
        const message = snapshot.messages.find((item) => item.messageId === id);
        return message?.idStatus === "stable" && message.presentationStatus === "formal" ? message : null;
      },
    },
  });
vm.runInContext(`${routeSource}\n${source}\nthis.domain={createEmptyBookmarksState,normalizeBookmarksState,addBookmarkFromSnapshot,toggleBookmarkFromSnapshot,moveBookmark,createBookmarkGroup,updateBookmarkGroup,deleteBookmarkGroup,reorderBookmarkGroups,updateBookmarksView,bookmarkGroupCounts,selectBookmarks,resolveBookmarkDestinationGroupId,bookmarkKey};`, context);
  return context.domain;
}
function sourced(value) { return { value, source: value ? "test" : null, status: value ? "available" : "missing" }; }
function snapshot({ bindingStatus = "bound", conversationId = "conversation-a", messages = null } = {}) {
  return {
    route: { pathname: `/c/${conversationId}` },
    conversation: { conversationId, identityStatus: "stable", bindingStatus, title: sourced("Conversation A"), project: { projectId: "g-p-one" } },
    messages: messages || [{ messageId: "message-1", idStatus: "stable", presentationStatus: "formal", role: "assistant", timestamp: sourced("2026-08-18T01:02:03Z"), excerpt: sourced("bounded excerpt", "test"), order: { index: 0, displayNumber: 7 } }],
  };
}
const d = loadDomain();
let state = d.createEmptyBookmarksState();
assert.deepEqual(JSON.parse(JSON.stringify(state.groups.map((g) => g.id))), ["bookmark-quote", "bookmark-insight", "bookmark-todo"], "fresh installs retain frozen preset folders");
const emptyGroups = d.normalizeBookmarksState({ ...state, groups: [] });
assert.equal(emptyGroups.groups.length, 0, "normalization never reinstalls deleted presets");
const afterPresetDeletion = d.normalizeBookmarksState({
  ...state,
  groups: state.groups.filter((group) => group.id !== "bookmark-insight"),
});
assert.equal(afterPresetDeletion.groups.some((group) => group.id === "bookmark-insight"), false, "a deleted preset does not respawn");
assert.throws(() => d.addBookmarkFromSnapshot(state, snapshot({ bindingStatus: "route-only" }), "message-1"), /stable, bound/);
assert.throws(() => d.addBookmarkFromSnapshot(state, snapshot(), "missing"), /stable, bound/);
state = d.addBookmarkFromSnapshot(state, snapshot(), "message-1", { groupId: "bookmark-insight", now: "2026-08-18T02:00:00Z" });
const key = d.bookmarkKey("conversation-a", "message-1");
assert.equal(state.items[key].groupId, "bookmark-insight");
assert.equal(state.items[key].excerpt, "bounded excerpt");
assert.equal(state.items[key].routePath, "/c/conversation-a");
const duplicate = d.addBookmarkFromSnapshot(state, snapshot(), "message-1", { groupId: "bookmark-insight", now: "2026-08-18T03:00:00Z" });
assert.equal(Object.keys(duplicate.items).length, 1, "same stable message cannot duplicate");
// A stored note must survive filing, even without an editing entrypoint.
state.items[key].note = "review this";
state = d.moveBookmark(state, key, null);
assert.equal(state.items[key].note, "review this");
assert.equal(state.items[key].groupId, null);
state = d.createBookmarkGroup(state, "New", { idFactory: () => "new-group", now: "2026-08-18T04:00:00Z" });
state = d.moveBookmark(state, key, "new-group");
state = d.updateBookmarkGroup(state, "new-group", { icon: "highlighter", name: "Marked" });
assert.equal(state.groups.find((g) => g.id === "new-group").icon, "highlighter");
assert.equal(d.resolveBookmarkDestinationGroupId(state, "new-group"), "new-group");
assert.equal(d.resolveBookmarkDestinationGroupId(state, "all"), null, "system browsing views never become filing destinations");
state = d.updateBookmarksView(state, { groupId: "all", query: "Conversation bounded" });
assert.equal(d.selectBookmarks(state, { currentConversationId: "conversation-a" }).length, 1, "multi-term search is AND across title and excerpt");
state = d.deleteBookmarkGroup(state, "new-group");
assert.equal(state.items[key].groupId, null, "deleting a group returns records to ungrouped");
assert.equal(d.bookmarkGroupCounts(state, "conversation-a").current, 1);

const manifest = JSON.parse(fs.readFileSync("src/manifest.json", "utf8"));
assert.ok(manifest.content_scripts[1].js.includes("features/bookmarks/chatgpt/bookmarks-presentation.js"));
const html = fs.readFileSync("src/app/sidepanel/index.html", "utf8");
assert.match(html, /data-route="bookmarks"(?![^>]*disabled)/);
assert.doesNotMatch(html, /id="bookmarks-view"[^>]*>\s*<div class="module-placeholder"/);
const view = fs.readFileSync("src/features/bookmarks/ui/bookmarks-view.js", "utf8");
assert.match(view, /captureScroll\(\)/);
assert.match(view, /resultScrollTopByView/);
assert.match(view, /event\.target\.closest\("button, input, textarea, select, form"\)/, "inner controls do not trigger row keyboard navigation");
assert.match(view, /from\s+["']\.\.\/\.\.\/\.\.\/platform\/ui\/current-context-card\.js["']/, "Bookmarks consumes the shared current-context card primitive");
assert.match(view, /data-bookmark-select-group/);
assert.match(view, /aria-current/);
assert.doesNotMatch(view, /\bbookmark-current-card(?:__\w+)?\b/, "the removed bookmark-only visual component must not return");

// Load the production view and its complete dependency graph, including the
// shared card, editor, menus and stable-list DOM patcher. The algorithm fixture
// supplies linked DOM nodes; containment checks and event targets stay real.
const viewSnapshotContext = vm.createContext({});
vm.runInContext(fs.readFileSync("src/platform/snapshot.js", "utf8"), viewSnapshotContext);
const rendered = createLibraryViewHarness("bookmarks", {
  // These two pre-existing fixture boundaries keep this test focused on card
  // composition and saved-number suppression, not snapshot/format validation.
  TidySnapshot: { ...viewSnapshotContext.TidySnapshot, isPersistenceEligible: value => value?.conversation?.bindingStatus === "bound" && value.conversation.identityStatus === "stable" },
  TidyTimeFormat: { formatDateTime: () => "2026-08-18 01:02" },
});
const renderedRoot = rendered.root;
// Each call replaces the view model; do not carry a previous export-selection
// mode through the shared harness's patch-oriented render convenience method.
const renderedView = { render: model => rendered.render({ exportSelection: null, ...model }) };
const encode = value => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function serializeNode(node) {
  if (node.nodeType === 3) return encode(node.nodeValue);
  const name = node.nodeName.toLowerCase();
  const attributes = node.attributes.map(({ name, value }) => " " + name + (value === "" ? "" : '="' + encode(value) + '"')).join("");
  return "<" + name + attributes + ">" + node.childNodes.map(serializeNode).join("") + "</" + name + ">";
}
// Read the patched tree instead of a stale markup assignment. Original card,
// canonical-number, timestamp and pagination assertions below remain intact.
Object.defineProperty(renderedRoot, "innerHTML", { get: () => renderedRoot.childNodes.map(serializeNode).join("") });
renderedView.render({
  store: d.createEmptyBookmarksState(),
  snapshot: snapshot(),
  preferences: {
    language: "zh-CN",
    timeZone: "system",
    dateFormat: "regional",
    messageTimePrecision: "minute",
  },
  t: (key, values = {}) => `${key}${Object.hasOwn(values, "count") ? `:${values.count}` : ""}`,
});
const renderedClasses = [...renderedRoot.innerHTML.matchAll(/class="([^"]*)"/g)]
  .flatMap((match) => match[1].split(/\s+/).filter(Boolean));
assert.equal(renderedClasses.filter((name) => name === "current-context-card").length, 1, "Bookmarks renders exactly one shared current-context card");
for (const sharedClass of [
  "current-context-card--summary",
  "current-context-card__leading",
  "current-context-card__copy",
  "current-context-card__title",
  "current-context-card__subtitle",
  "current-context-card__trailing",
]) assert.ok(renderedClasses.includes(sharedClass), `Bookmarks renders shared slot ${sharedClass}`);
assert.ok(renderedClasses.includes("is-selected"), "the current Bookmarks view maps aria-current to the shared selected state");
assert.match(renderedRoot.innerHTML, /data-bookmark-select-group="current"/, "the shared card keeps Bookmarks routing semantics");
assert.match(renderedRoot.innerHTML, /aria-current="page"/, "the shared card keeps Bookmarks accessibility state");
assert.doesNotMatch(renderedRoot.innerHTML, /\bbookmark-current-card(?:__\w+)?\b/);
for (const orderNumber of [null, 0, -1, 3, 5, 7, 12, 14, 16]) {
  const saved = d.addBookmarkFromSnapshot(d.createEmptyBookmarksState(), snapshot(), "message-1");
  saved.items[key].orderIndex = 8; saved.items[key].orderNumber = orderNumber;
  saved.items[key].note = "Keep the saved note and identifier";
  const before = JSON.stringify(saved);
  for (const active of [false, true]) {
    renderedView.render({ store: saved, snapshot: snapshot(), preferences: { language: "zh-CN" }, t: key => key,
      exportSelection: { active, draftIds: [], basketBookmarkIds: [] } });
    assert.match(renderedRoot.innerHTML, /bounded excerpt/);
    assert.match(renderedRoot.innerHTML, /2026-08-18 01:02/);
    assert.doesNotMatch(renderedRoot.innerHTML, />#-?\d+<\/span>/,
      "persisted orderNumber has no global-source proof, in either normal or selection rows");
    assert.equal(JSON.stringify(saved), before, "display suppression must not migrate or mutate saved data");
  }
}
// 每页条数只改变显示范围，不能丢书签；旧的 8 和非法值也统一回到默认 6。
let pagedStore = d.createEmptyBookmarksState();
for (let index = 0; index < 23; index++) {
  const message = { ...snapshot().messages[0], messageId: `page-message-${index}` };
  pagedStore = d.addBookmarkFromSnapshot(pagedStore, snapshot({ messages: [message] }), message.messageId);
}
const pagedModel = { store: pagedStore, snapshot: snapshot(), preferences: { language: "zh-CN" }, t: key => key };
renderedView.render(pagedModel);
const rowCount = () => (renderedRoot.innerHTML.match(/data-bookmark-jump=/g) || []).length;
const changeField = (selector, value, expectedDataset = {}) => {
  const target = renderedRoot.querySelector(selector);
  assert.ok(target, "pagination control exists: " + selector);
  assert.equal(renderedRoot.contains(target), true, "changes originate from a mounted production control");
  for (const [key, expected] of Object.entries(expectedDataset)) assert.equal(target.dataset[key], String(expected));
  target.value = String(value);
  rendered.event("change", target);
  rendered.flush();
};
const sizeSelect = renderedRoot.innerHTML.match(/<select data-bookmark-page-size>(.*?)<\/select>/)[1];
assert.deepEqual([...sizeSelect.matchAll(/value="(\d+)"/g)].map(match => Number(match[1])), [6, 10, 15, 20]);
assert.match(sizeSelect, /value="6" selected/);
assert.equal(rowCount(), 6);
for (const size of [10, 15, 20, 6]) {
  changeField("[data-bookmark-page-size]", size);
  const total = Math.ceil(23 / size);
  assert.equal(rowCount(), size);
  assert.match(renderedRoot.innerHTML, new RegExp(`data-bookmark-page-input value="1" data-page-total="${total}"`));
  changeField("[data-bookmark-page-input]", total, { pageTotal: total });
  assert.equal(rowCount(), 23 - (total - 1) * size, "last page retains all remaining bookmarks");
}
for (const invalid of [8, "invalid"]) {
  changeField("[data-bookmark-page-size]", invalid);
  assert.equal(rowCount(), 6);
  assert.match(renderedRoot.innerHTML, /data-bookmark-page-input value="1"/);
}
assert.equal(Object.keys(pagedStore.items).length, 23, "pagination never deletes saved bookmarks");
console.log("bookmarks assertions passed");

