const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createPanelRuntime } = require("./helpers/panel-runtime.cjs");
const { createFixture } = require("./helpers/title-performance-dom.cjs");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function snapshot({
  conversationId = "conversation-a",
  title = "Original title",
  bindingStatus = "bound",
  identityStatus = "stable",
  routePath = `/c/${conversationId}`,
  createdAt = "2026-08-18T01:00:00.000Z",
  updatedAt = "2026-08-18T02:00:00.000Z",
  projectId = null,
} = {}) {
  const available = (value, source = "fixture") => ({
    value,
    source: value === null ? null : source,
    status: value === null ? "missing" : "available",
  });
  return {
    schemaVersion: "chatgpt-tidy.snapshot.v1",
    capturedAt: "2026-08-18T03:00:00.000Z",
    appearance: { colorScheme: "light", source: "test", status: "available", surface: { value: "rgb(255, 255, 255)", source: "test", status: "available" } },
    route: { pathname: routePath },
    conversation: {
      conversationId,
      draftId: null,
      identityStatus,
      bindingStatus,
      title: available(bindingStatus === "bound" ? title : null),
      createdAt: available(bindingStatus === "bound" ? createdAt : null),
      updatedAt: available(bindingStatus === "bound" ? updatedAt : null),
      project: projectId ? { projectId, title: "Project A", status: "available", source: "route" } : null,
    },
    sidebarConversations: [],
    messages: [],
  };
}

const domainRuntime = createPanelRuntime();
const domain = domainRuntime.load("src/features/favorites/storage/favorites-domain.js");
const TidySnapshot = domainRuntime.context.TidySnapshot;

const t1 = "2026-08-18T04:00:00.000Z";
const t2 = "2026-08-18T05:00:00.000Z";
const t3 = "2026-08-18T06:00:00.000Z";
let state = domain.createEmptyFavoritesState();
const presetGroupIds = ["keepsake", "inspiration", "study", "work"];
assert.deepEqual(plain(state.groups.map((group) => group.id)), presetGroupIds, "new repositories expose the frozen preset folders");
assert.deepEqual(plain(state.groups.map((group) => group.preset)), presetGroupIds);

for (const unsafeSnapshot of [
  snapshot({ bindingStatus: "route-only" }),
  snapshot({ bindingStatus: "mismatch" }),
  snapshot({ bindingStatus: "unbound", identityStatus: "empty" }),
  snapshot({ bindingStatus: "bound", identityStatus: "draft" }),
]) {
  assert.throws(
    () => domain.upsertFavoriteFromSnapshot(state, unsafeSnapshot, { now: t1 }),
    (error) => error.code === "PERSISTENCE_REJECTED",
  );
}

state = domain.createFavoriteGroup(state, "Work", { idFactory: () => "group-work", now: t1 });
state = domain.createFavoriteGroup(state, "Study", { idFactory: () => "group-study", now: t2 });
assert.deepEqual(plain(state.groups.map((group) => group.id)), [...presetGroupIds, "group-work", "group-study"]);
state = domain.updateFavoritesView(state, { groupId: "all" }, { now: t2 });
assert.equal(domain.resolveFavoriteDestinationGroupId(state, null), null, "no visible filing context means Ungrouped");
state = domain.updateFavoritesView(state, { groupId: "inspiration" }, { now: t2 });
assert.equal(
  domain.resolveFavoriteDestinationGroupId(state, null),
  null,
  "a remembered browsing folder alone must not become a hidden filing destination",
);
assert.equal(domain.resolveFavoriteDestinationGroupId(state, "inspiration"), "inspiration", "a visible custom folder is accepted");
state = domain.updateFavoritesView(state, { groupId: "ungrouped" }, { now: t2 });
assert.equal(domain.resolveFavoriteDestinationGroupId(state, "all"), null, "system views remain ungrouped destinations");
assert.equal(domain.resolveFavoriteDestinationGroupId(state, "deleted-group"), null, "a stale filing context safely falls back to Ungrouped");

state = domain.upsertFavoriteFromSnapshot(state, snapshot({
  routePath: "/g/g-p-alpha/c/conversation-a",
  projectId: "g-p-alpha",
}), { groupId: "group-work", now: t1 });
assert.equal(Object.keys(state.items).length, 1);
assert.equal(state.items["conversation-a"].groupId, "group-work");
assert.equal(state.items["conversation-a"].savedAt, t1);
assert.equal(state.items["conversation-a"].projectId, "g-p-alpha");
assert.equal(state.items["conversation-a"].routePath, "/g/g-p-alpha/c/conversation-a");

// Seed an already-saved note; there is deliberately no note-editing API.
state.items["conversation-a"].note = "Keep this context";
state = domain.upsertFavoriteFromSnapshot(state, snapshot({
  title: "Renamed title",
  updatedAt: "2026-08-18T07:00:00.000Z",
}), { now: t3 });
assert.equal(Object.keys(state.items).length, 1, "duplicate favorite must remain one entity");
assert.equal(state.items["conversation-a"].title, "Renamed title");
assert.equal(state.items["conversation-a"].savedAt, t1, "metadata refresh must preserve savedAt");
assert.equal(state.items["conversation-a"].groupId, "group-work");
assert.equal(state.items["conversation-a"].note, "Keep this context");

const sameState = domain.refreshFavoriteFromSnapshot(state, snapshot({
  title: "Renamed title",
  updatedAt: "2026-08-18T07:00:00.000Z",
}), { now: "2026-08-18T08:00:00.000Z" });
assert.equal(sameState.revision, state.revision, "unchanged metadata must not produce a storage write");

const beforeMove = plain(state.items["conversation-a"]);
state = domain.moveFavorite(state, "conversation-a", "group-study", { now: t3 });
assert.deepEqual(plain(state.items["conversation-a"]), { ...beforeMove, groupId: "group-study" }, "moving only changes filing, not savedAt, route, title, note, or other metadata");
assert.equal(state.items["conversation-a"].groupId, "group-study");
state = domain.updateFavoriteGroup(state, "group-study", { icon: "heart", name: "Reference" }, { now: t3 });
assert.equal(state.groups.find((group) => group.id === "group-study").icon, "heart");
assert.equal(state.groups.find((group) => group.id === "group-study").name, "Reference");

const reorderedGroupIds = ["group-study", ...presetGroupIds, "group-work"];
state = domain.reorderFavoriteGroups(state, reorderedGroupIds, { now: t3 });
assert.deepEqual(plain(state.groups.map((group) => group.id)), reorderedGroupIds);
assert.throws(
  () => domain.reorderFavoriteGroups(state, ["group-study"], { now: t3 }),
  (error) => error.code === "VALIDATION_ERROR",
);

state = domain.updateFavoritesView(state, { groupId: "group-study", sortField: "createdAt", sortDirection: "asc" }, { now: t3 });
state = domain.deleteFavoriteGroup(state, "group-study", { now: t3 });
assert.equal(state.items["conversation-a"].groupId, null, "deleted group favorites return to ungrouped");
assert.equal(state.view.groupId, "ungrouped");
assert.equal(domain.favoriteGroupCounts(state).ungrouped, 1);

const sidebarConversation = {
  conversationId: "sidebar-conversation",
  identityStatus: "stable",
  bindingStatus: "bound",
  kind: "project-conversation",
  title: { value: "Sidebar title", source: "sidebar-dom", status: "available" },
  createdAt: { value: "2026-08-17T01:00:00.000Z", source: "react-fiber.history-item", status: "available" },
  updatedAt: { value: "2026-08-17T02:00:00.000Z", source: "react-fiber.history-item", status: "available" },
  project: { projectId: "g-p-sidebar", title: null, source: "route", status: "partial" },
  locator: { strategy: "href", value: "https://chatgpt.com/g/g-p-sidebar/c/sidebar-conversation" },
};
assert.equal(TidySnapshot.isSidebarPersistenceEligible(sidebarConversation), true);
state = domain.upsertFavoriteFromSidebarConversation(state, sidebarConversation, { now: t2 });
assert.equal(state.items["sidebar-conversation"].routePath, "/g/g-p-sidebar/c/sidebar-conversation");
assert.equal(state.items["sidebar-conversation"].groupId, null);
state = domain.upsertFavoriteFromSidebarConversation(state, sidebarConversation, { groupId: "inspiration", now: t3 });
assert.equal(state.items["sidebar-conversation"].groupId, "inspiration", "the active custom folder is the sidebar-star destination");
assert.throws(
  () => domain.upsertFavoriteFromSidebarConversation(state, { ...sidebarConversation, bindingStatus: "mismatch" }),
  (error) => error.code === "PERSISTENCE_REJECTED",
);

state = domain.upsertFavoriteFromSnapshot(state, snapshot({
  conversationId: "conversation-b",
  title: "Older conversation",
  createdAt: "2026-08-17T01:00:00.000Z",
  updatedAt: "2026-08-17T02:00:00.000Z",
}), { now: "2026-08-19T01:00:00.000Z" });
state = domain.updateFavoritesView(state, { groupId: "all", sortField: "createdAt", sortDirection: "asc" }, { now: t3 });
assert.deepEqual(
  plain(domain.selectFavorites(state).map((item) => item.conversationId)),
  ["conversation-b", "sidebar-conversation", "conversation-a"],
);

state = domain.removeFavorite(state, "conversation-a", { now: t3 });
assert.equal(state.items["conversation-a"], undefined);
assert.throws(() => domain.removeFavorite(state, "conversation-a"), (error) => error.code === "NOT_FOUND");

const guard = domainRuntime.load("src/platform/context-guard.js");
assert.equal(guard.assertExpectedConversationContext({ id: 11 }, snapshot(), { tabId: 11, conversationId: "conversation-a" }), true);
assert.throws(
  () => guard.assertExpectedConversationContext({ id: 12 }, snapshot(), { tabId: 11 }),
  (error) => error.code === "CONTEXT_MISMATCH",
);
assert.throws(
  () => guard.assertExpectedConversationContext({ id: 11 }, snapshot({ conversationId: "conversation-b" }), { tabId: 11, conversationId: "conversation-a" }),
  (error) => error.code === "CONTEXT_MISMATCH",
);

(async () => {
  const repositoryModule = await import("../src/features/favorites/storage/favorites.js");
  const { openTidyDatabase } = await import("../src/platform/storage/database.js");
  const { IDBFactory } = require("fake-indexeddb");
  const database = await openTidyDatabase(new IDBFactory());
  const options = { openDatabase: async () => database };
  const repository = repositoryModule.createFavoritesRepository(options);
  const first = repository.transact("account-one", (current) => domain.createFavoriteGroup(current, "One", { idFactory: () => "one", now: t1 }));
  const second = repository.transact("account-one", (current) => domain.createFavoriteGroup(current, "Two", { idFactory: () => "two", now: t2 }));
  await Promise.all([first, second]);
  const reopened = repositoryModule.createFavoritesRepository(options);
  const persisted = await reopened.get("account-one");
  assert.deepEqual(plain(persisted.groups.map((group) => group.id)), [...presetGroupIds, "one", "two"], "serialized writes survive repository recreation");
  assert.equal((await reopened.get("account-two")).groups.length, presetGroupIds.length, "another account has its own groups");
  database.close();

  const workerSource = fs.readFileSync("src/app/background/service-worker.js", "utf8");
  const favoriteHandler = fs.readFileSync("src/app/background/handlers/favorites.js", "utf8");
  const libraryWorkflow = fs.readFileSync("src/app/background/library-workflow.js", "utf8");
  const panelHost = fs.readFileSync("src/platform/navigation/background/panel-host.js", "utf8");
  assert.match(workerSource, /import \{ createFavoritesHandler \} from "\.\/handlers\/favorites\.js"/);
  assert.match(workerSource, /createRequestRouter\([\s\S]{0,350}createFavoritesHandler\(\{ binding, library, navigation, filingContexts: favoriteFilingContexts \}\)/);
  assert.match(workerSource, /createLibraryWorkflow\(\{ chrome, identity: libraryIdentity, pageGateway \}\)/);
  assert.match(workerSource, /createPanelHost\(\{ chrome, protocol, binding, favoriteFilingContexts, bookmarkFilingContexts \}\)/);
  assert.match(workerSource, /chrome\.runtime\.onConnect\.addListener\(panelHost\.acceptPort\)/);
  assert.match(favoriteHandler, /assertExpectedConversationContext\(tab, snapshot/);
  assert.match(favoriteHandler, /expectedTabId/);
  assert.match(libraryWorkflow, /refreshFavoriteFromSnapshot/);
  assert.match(favoriteHandler, /FAVORITES_TOGGLE_SIDEBAR/);
  assert.match(favoriteHandler, /isSidebarPersistenceEligible/);
  assert.match(favoriteHandler, /favoriteFilingContexts\.groupIdForTab\(tab\?\.id,\s*libraryOwner\.accountKey\)/, "the favorite owner consumes only the current account's active Side Panel filing context");
  assert.match(panelHost, /port\.onDisconnect\.addListener/, "closing the Side Panel clears the ephemeral filing context");
  assert.doesNotMatch(fs.readFileSync("src/features/favorites/storage/favorites.js", "utf8"), /bookmark:/);

  // 收藏页使用共享的当前会话卡；卡片状态来自真实仓库，而不是设计演示中的预填数据。
  const favoritesViewSource = fs.readFileSync("src/features/favorites/ui/favorites-view.js", "utf8");
  assert.match(
    favoritesViewSource,
    /from\s+["']\.\.\/\.\.\/\.\.\/platform\/ui\/current-context-card\.js["']/,
    "Favorites consumes the shared current-context card primitive",
  );
  // Load real ESM dependencies, including stable-list-dom, rather than injecting
  // replacements for the production view imports.
  const viewRuntime = createPanelRuntime({
    TidyTimeFormat: {
      formatDateTime: () => "2026-08-18 04:00",
      formatConversation: () => "2026-08-18 04:00 ~ 05:00",
    },
    requestAnimationFrame: (callback) => { callback(); return 1; },
    window: { addEventListener() {} },
    FormData: class {},
    confirm: () => true,
  });
  const viewModule = viewRuntime.load("src/features/favorites/ui/favorites-view.js");
  const viewState = domain.createEmptyFavoritesState();
  for (let index = 0; index < 8; index += 1) {
    const id = `view-conversation-${index}`;
    const next = domain.upsertFavoriteFromSnapshot(viewState, snapshot({ conversationId: id, title: `View ${index}` }), {
      now: `2026-08-1${index + 1}T04:00:00.000Z`,
    });
    Object.assign(viewState, next);
  }
  const stats = new Proxy({}, { get: (target, key) => target[key] || 0 });
  const { root } = createFixture(stats);
  const encode = value => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  function serializeNode(node) {
    if (node.nodeType === 3) return encode(node.nodeValue);
    const name = node.nodeName.toLowerCase();
    const attributes = node.attributes.map(({ name, value }) => " " + name + '="' + encode(value) + '"').join("");
    return "<" + name + attributes + ">" + node.childNodes.map(serializeNode).join("") + "</" + name + ">";
  }
  // Serialize the patched tree for the original markup assertions. The real
  // patcher now also has to preserve the actual scroll-container nodes.
  Object.defineProperties(root, {
    innerHTML: { get: () => root.childNodes.map(serializeNode).join("") },
    groupList: { get: () => root.querySelector("[data-group-list]") },
    results: { get: () => root.querySelector('[data-results-viewport="favorites"]') },
  });
  const translate = (key, values = {}) => `${key}${Object.hasOwn(values, "count") ? `:${values.count}` : ""}`;
  const preferences = {
    language: "zh-CN", timeDisplayEnabled: true, timeZone: "system", dateFormat: "regional",
    conversationTimePrecision: "minute", conversationTimeMode: "range",
  };
  let viewModel = {
    store: viewState,
    snapshot: snapshot(),
    preferences,
    bookmarkCounts: {},
    t: translate,
  };
  let view = null;
  view = viewModule.createFavoritesView({
    root,
    onAction: async (type, payload) => {
      if (type !== "view-update") return;
      viewModel = { ...viewModel, store: domain.updateFavoritesView(viewModel.store, payload, { now: t3 }) };
      view.render(viewModel);
    },
  });
  view.render(viewModel);
  const renderedClasses = [...root.innerHTML.matchAll(/class="([^"]*)"/g)]
    .flatMap((match) => match[1].split(/\s+/).filter(Boolean));
  for (const frozenClass of [
    "favorites-panel", "current-context-card", "current-context-card--centered",
    "current-context-card__leading", "current-context-card__copy", "current-context-card__title",
    "current-context-card__subtitle", "current-context-card__trailing", "favorite-group-list",
    "favorite-sort-section", "favorite-conversation-list", "result-pagination",
  ]) assert.ok(renderedClasses.includes(frozenClass), `Favorites renders class ${frozenClass}`);
  assert.equal(renderedClasses.filter((name) => name === "current-context-card").length, 1, "Favorites renders exactly one shared current-context card");
  assert.equal(renderedClasses.includes("current-context-card--summary"), false, "Favorites selects only its centered composition variant");
  assert.equal(renderedClasses.includes("is-selected"), false, "an unsaved current conversation is not styled as selected");
  assert.match(root.innerHTML, /data-toggle-current/);
  assert.match(root.innerHTML, /aria-pressed="false"/);
  assert.doesNotMatch(
    root.innerHTML,
    /\b(?:favorite-current-action|favorite-current-copy|favorite-current-star(?:--(?:large|right))?|favorite-current-confirmation)\b/,
    "the removed Favorites-only visual component must not return",
  );
  assert.match(root.innerHTML, /favorite-export-entry/);
  assert.equal((root.innerHTML.match(/data-open-favorite=/g) || []).length, 7, "first favorites page follows the frozen seven-row density");
  assert.equal((root.innerHTML.match(/data-favorite-menu=/g) || []).length, 7, "each normal row exposes its own keyboard-reachable management trigger");
  assert.doesNotMatch(root.innerHTML, /favorite-note/, "this filing addition does not introduce note editing");
  assert.doesNotMatch(root.innerHTML, /<button[^>]*data-open-favorite[^>]*>(?:(?!<\/button>)[\s\S])*<button/, "navigation never nests the management button");

  const selectedStore = domain.upsertFavoriteFromSnapshot(viewModel.store, snapshot(), { now: t3 });
  view.render({ ...viewModel, store: selectedStore });
  assert.match(root.innerHTML, /class="[^"]*current-context-card[^"]*is-selected[^"]*"/, "the shared state class follows the saved current conversation");
  assert.match(root.innerHTML, /data-toggle-current(?:="")?/, "the shared primitive preserves the Favorites toggle action");
  assert.match(root.innerHTML, /aria-pressed="true"/, "the shared primitive preserves the Favorites pressed state");
  view.render(viewModel);

  // 切换分组会更新结果，但独立滚动的分组目录不能因此跳回顶部。
  root.groupList.scrollTop = 83;
  root.results.scrollTop = 41;
  const groupButton = {
    dataset: { selectGroup: "ungrouped" },
    matches(selector) { return selector === "[data-select-group]"; },
  };
  root.dispatch("click", { owner: root, closest(selector) { return selector === "button" ? groupButton : null; } });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(viewModel.store.view.groupId, "ungrouped");
  assert.equal(root.groupList.scrollTop, 83, "group selection preserves the group-list scrollbar");
  assert.equal(root.results.scrollTop, 0, "the newly selected group's result viewport starts cleanly");

  root.groupList.scrollTop = 29;
  root.results.scrollTop = 67;
  view.render(viewModel);
  assert.equal(root.groupList.scrollTop, 29, "ordinary clicks and store refreshes do not rewind the group catalog");
  assert.equal(root.results.scrollTop, 67, "ordinary clicks and store refreshes do not rewind the active result list");

  console.log("favorites assertions passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
