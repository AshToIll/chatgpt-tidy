import "../../src/platform/protocol.js";
import "../../src/platform/session/shared/page-session.js";
import "../../src/platform/library/library-hydration.js";
import "../../src/platform/snapshot.js";
import "../../src/platform/time-format.js";
import { createTranslator } from "../../src/messages/i18n.js";
import { createEmptyFavoritesState, upsertFavoriteFromSnapshot, createFavoriteGroup, updateFavoriteGroup, deleteFavoriteGroup, updateFavoritesView, removeFavorite, moveFavorite, favoriteGroupCounts } from "../../src/features/favorites/storage/favorites-domain.js";
import { createEmptyBookmarksState, addBookmarkFromSnapshot, createBookmarkGroup, updateBookmarkGroup, deleteBookmarkGroup, updateBookmarksView, moveBookmark, removeBookmark, bookmarkGroupCounts } from "../../src/features/bookmarks/storage/bookmarks-domain.js";
import { createLibraryController } from "../../src/platform/library/ui/library-controller.js";
import { createFavoritesActions } from "../../src/features/favorites/ui/favorites-actions.js";
import { createFavoritesView } from "../../src/features/favorites/ui/favorites-view.js";
import { createBookmarksActions } from "../../src/features/bookmarks/ui/bookmarks-actions.js";
import { createBookmarksView } from "../../src/features/bookmarks/ui/bookmarks-view.js";

// This fixture intentionally loads the production modules, not a screenshot or
// reimplementation. Only Chrome messaging, identity and saved records are fake.
const checks = [], publications = [], clientPublications = [], runtimeCalls = [];
const runtimeListeners = [], snapshotListeners = [], localIdentityListeners = [];
const protocol = globalThis.TidyProtocol;
const t = createTranslator("en");
const preferences = { language: "en", timeZone: "UTC", dateFormat: "iso", timeDisplayEnabled: false };
const roots = { favorites: document.querySelector("#favorites"), bookmarks: document.querySelector("#bookmarks") };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
const same = (actual, expected, message) => assert(actual === expected, `${message}: ${String(actual)} !== ${String(expected)}`);
const clone = value => JSON.parse(JSON.stringify(value));
const field = value => ({ value, source: "local-fixture", status: "available" });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
let currentSnapshot, backend, gate = null, hidden = false, networkAttempts = 0;

function snapshot(id, owner = "owner-one") {
  return { schemaVersion: TidySnapshot.VERSION, capturedAt: "2026-09-01T00:00:00.000Z",
    route: { pathname: `/c/${id}`, href: `https://chatgpt.com/c/${id}`, kind: "conversation", status: "available" },
    appearance: { colorScheme: "light", source: "fixture", status: "available", surface: field("rgb(255, 255, 255)") },
    conversation: { conversationId: id, draftId: null, kind: "conversation", bindingStatus: "bound", identityStatus: "stable",
      title: field(`${owner} conversation ${id}`), createdAt: field("2026-08-01T00:00:00.000Z"),
      updatedAt: field("2026-09-01T00:00:00.000Z"), project: null },
    sidebarConversations: [], messages: [{ messageId: `message-${id}`, idStatus: "stable", presentationStatus: "formal",
      role: "assistant", timestamp: field("2026-09-01T00:00:00.000Z"), excerpt: field(`${owner} saved excerpt ${id}`),
      order: { index: 1 }, locator: { strategy: "fixture", value: id } }] };
}

function library(owner, epoch) {
  const accountKey = JSON.stringify([owner, "personal"]);
  let favorites = createEmptyFavoritesState(), bookmarks = createEmptyBookmarksState();
  for (let index = 0; index < 36; index++) {
    const id = `${owner}-chat-${String(index).padStart(2, "0")}`, item = snapshot(id, owner);
    favorites = upsertFavoriteFromSnapshot(favorites, item);
    bookmarks = addBookmarkFromSnapshot(bookmarks, item, `message-${id}`);
  }
  favorites.accountKey = accountKey; bookmarks.accountKey = accountKey;
  favorites.view.groupId = "all"; bookmarks.view.groupId = "all";
  return { accountKey, identity: { documentId: "fixture-document", epoch }, favorites, bookmarks,
    errors: { favorites: null, bookmarks: null } };
}

const views = {
  favorites: createFavoritesView({ root: roots.favorites, onAction: async () => {} }),
  bookmarks: createBookmarksView({ root: roots.bookmarks, onAction: async () => {} }),
};

function render(state) {
  for (const kind of ["favorites", "bookmarks"]) {
    if (!state.accountKey || !state[kind]) views[kind].reset();
    else views[kind].render({ store: state[kind], snapshot: currentSnapshot, preferences, bookmarkCounts: {}, activeBookmarkId: null, t });
  }
}

// No browser/account APIs are exposed. Production requests have to pass through
// this strict mock, which accepts only local library reads in this test.
globalThis.chrome = { runtime: {
  id: "synthetic-extension",
  onMessage: { addListener(listener) { runtimeListeners.push(listener); },
    removeListener(listener) { const i = runtimeListeners.indexOf(listener); if (i >= 0) runtimeListeners.splice(i, 1); } },
  async sendMessage(envelope) {
    runtimeCalls.push({ type: envelope.type, payload: clone(envelope.payload) });
    assert(envelope.type === protocol.Type.LIBRARY_GET, `Unexpected runtime action ${envelope.type}`);
    const reply = clone(backend), currentGate = gate;
    if (currentGate) await currentGate.promise;
    return protocol.response(envelope, reply);
  },
} };
globalThis.TidyPageSession = TidyPageSessionContract.create({ runtime: chrome.runtime });
globalThis.TidyContentBridge = {
  onSnapshot(listener) { snapshotListeners.push(listener); return () => {
    const i = snapshotListeners.indexOf(listener); if (i >= 0) snapshotListeners.splice(i, 1);
  }; },
  onLibraryIdentityChanged(listener) { localIdentityListeners.push(listener); return () => {
    const i = localIdentityListeners.indexOf(listener); if (i >= 0) localIdentityListeners.splice(i, 1);
  }; },
};
globalThis.fetch = () => { networkAttempts++; throw new Error("This browser fixture has no network access"); };
Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });

const controller = createLibraryController({
  async request() {
    const envelope = protocol.request(protocol.Type.LIBRARY_GET, { expectedTabId: 31 });
    const response = await chrome.runtime.sendMessage(envelope);
    assert(protocol.isResponse(response, envelope.requestId) && response.ok, "Invalid local worker response");
    return response.payload;
  },
  onChanged(state) { publications.push({ accountKey: state.accountKey, identity: state.identity }); render(state); },
});
runtimeListeners.push(envelope => {
  if (envelope.type === protocol.Type.LIBRARY_IDENTITY_CHANGED) controller.observeIdentity(envelope.payload);
  if ([protocol.Type.FAVORITES_UPDATED, protocol.Type.BOOKMARKS_UPDATED].includes(envelope.type)
    && envelope.payload.accountKey === controller.getState().accountKey) void controller.refresh();
});

function emit(type, payload) {
  const event = protocol.event(type, payload);
  for (const listener of runtimeListeners) listener(event, {}, () => {});
}

function route(id) {
  currentSnapshot = snapshot(id);
  for (const listener of snapshotListeners) listener(currentSnapshot);
  // The panel's current-card render is independent from the library lifecycle.
  render(controller.getState());
}

function viewport(kind) { return roots[kind].querySelector(`[data-results-viewport="${kind}"]`); }
function pageInput(kind) { return roots[kind].querySelector(kind === "favorites" ? "[data-page-input]" : "[data-bookmark-page-input]"); }
function rows(kind) { return [...viewport(kind).children]; }
function observeList(node) {
  const records = [];
  const observer = new MutationObserver(changes => records.push(...changes));
  observer.observe(node, { childList: true, subtree: true });
  return { records, stop() { records.push(...observer.takeRecords()); observer.disconnect(); } };
}
function hasPrivateText(owner) { return Object.values(roots).some(root => root.textContent.includes(owner)); }

async function check(name, work) {
  try { const metrics = await work(); checks.push({ name, ok: true, ...(metrics ? { metrics } : {}) }); }
  catch (error) { checks.push({ name, ok: false, error: error.stack || error.message }); }
}



// 收藏交互的浏览器回归仍使用真实 View / Actions / domain；只替换最末端的
// request（本地合成仓库）。确认框使用真实组件；不会调用用户账号、网络或真实收藏。
let inputSequence = 0, inputDone;
globalThis.completeFixtureInput = id => {
  same(globalThis.fixtureInputRequest?.id, id, "Native input receipt");
  globalThis.fixtureInputRequest = null; inputDone();
};
const nativeInput = request => new Promise(resolve => {
  inputDone = resolve; globalThis.fixtureInputRequest = { id: ++inputSequence, ...request };
});
const nativeEscape = async () => {
  await nativeInput({ kind: "key", key: "Escape", code: "Escape", vk: 27 });
  // 生产浮层回焦明确排在下一动画帧；原生输入回执不等于该帧已经执行。
  // 等待这一个约定帧再断言 exact activeElement，不以任意延时或取消断言掩盖失焦。
  await new Promise(resolve => requestAnimationFrame(resolve));
};
const nativeText = text => nativeInput({ kind: "text", text });
async function nativeClick(node) {
  assert(node, "Native click target missing"); node.scrollIntoView({ block: "nearest" });
  await sleep(20);
  const rect = node.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  assert(rect.width > 0 && rect.height > 0, "Native click target has no geometry");
  await nativeInput({ kind: "pointer", steps: [
    { type: "mouseMoved", x, y },
    { type: "mousePressed", x, y, button: "left", clickCount: 1 },
    { type: "mouseReleased", x, y, button: "left", clickCount: 1 },
  ] });
  await sleep(20);
}
async function replaceName(node, value) {
  node.focus(); node.select();
  if (value) await nativeText(value);
  else await nativeInput({ kind: "key", key: "Backspace", code: "Backspace", vk: 8 });
}

async function runFavoritesInteractionChecks() {
  const root = document.querySelector("#favorites-interactions");
  document.querySelector("#fixtures").hidden = true; root.hidden = false;
  let store, epoch = 1, translator = t, pendingView = null, pendingMutation = null, groupSequence = 0;
  const requests = [], notifications = [], navigation = [];
  let view;
  const ownSnapshot = snapshot("favorites-interaction", "synthetic");
  const owner = () => ({ accountKey: "synthetic-favorites", identity: { documentId: "favorites-ui-fixture", epoch } });
  const owns = token => token.accountKey === owner().accountKey && token.identity.epoch === epoch;
  const redraw = () => view.render({ store, snapshot: ownSnapshot, preferences, bookmarkCounts: {}, t: translator });
  const actions = createFavoritesActions({
    ownerTabId: 31, isReady: () => true, captureOwner: owner, isOwnerCurrent: owns,
    acceptMutation(token, result) { if (!owns(token)) return false; store = result; redraw(); return true; },
    refresh: async () => redraw(), toast: (...args) => notifications.push(args),
    readCurrentConversation: () => ({ conversationId: ownSnapshot.conversation.conversationId,
      isFavorite: Boolean(store.items[ownSnapshot.conversation.conversationId]) }),
    beginNavigation(target) { navigation.push(target); return "synthetic-navigation"; },
    isNavigationCurrent: () => true, isNavigationCompleted: () => false,
    async request(type, payload) {
      requests.push({ type, payload: clone(payload) });
      same(payload.expectedAccountKey, owner().accountKey, "Request uses captured account");
      same(payload.expectedTabId, 31, "Request uses bound tab");
      const options = { now: "2026-10-01T00:00:00.000Z", idFactory: () => "fixture-new-" + ++groupSequence };
      let result;
      if (type === protocol.Type.FAVORITES_VIEW_UPDATE) {
        result = updateFavoritesView(store, payload, options);
        if (pendingView) await pendingView.promise;
      } else if (type === protocol.Type.FAVORITES_GROUP_CREATE) result = createFavoriteGroup(store, payload.name, options);
      else if (type === protocol.Type.FAVORITES_GROUP_UPDATE) result = updateFavoriteGroup(store, payload.groupId, payload.patch, options);
      else if (type === protocol.Type.FAVORITES_GROUP_DELETE) result = deleteFavoriteGroup(store, payload.groupId, options);
      else if (type === protocol.Type.FAVORITES_TOGGLE_CURRENT) result = store.items[ownSnapshot.conversation.conversationId]
        ? removeFavorite(store, ownSnapshot.conversation.conversationId, options)
        : upsertFavoriteFromSnapshot(store, ownSnapshot, { ...options, groupId: payload.groupId });
      else if (type === protocol.Type.FAVORITES_OPEN) return { opened: payload.conversationId };
      else throw new Error("Unexpected synthetic write " + type);
      if (pendingMutation) await pendingMutation.promise;
      return { ...result, accountKey: owner().accountKey };
    },
  });
  view = createFavoritesView({ root, onAction: (action, payload) => actions.handle(action, payload) });
  const $ = selector => root.querySelector(selector);
  const error = () => $("[data-group-name-error]");
  const overlay = () => $("[data-group-overlay]");
  const restore = async () => {
    if (pendingView) { pendingView.resolve(); pendingView = null; await sleep(20); }
    if (pendingMutation) { pendingMutation.resolve(); pendingMutation = null; await sleep(20); }
    hidden = false; epoch++; view.reset(); translator = t;
    store = upsertFavoriteFromSnapshot(createEmptyFavoritesState(), ownSnapshot, { groupId: "keepsake" });
    store.accountKey = owner().accountKey;
    store.view.groupId = "keepsake";
    requests.length = notifications.length = navigation.length = 0;
    redraw(); await sleep(30);
  };
  const openMenu = async groupId => { await nativeClick($('[data-group-menu="' + groupId + '"]'));
    same(overlay()?.dataset.groupOverlay, groupId, "Correct group menu opens"); };
  const openRename = async () => { await openMenu("keepsake");
    await nativeClick($('[data-group-action="rename"]')); await sleep(30); return $('[data-group-rename="keepsake"] input'); };
  const originalConfirm = globalThis.confirm;
  globalThis.confirm = () => { throw new Error("Browser-native confirm must not be used"); };
  try {
    await check("Favorites switching groups closes the old menu before a delayed view reply, without resurrection", async () => {
      await restore(); await openMenu("keepsake"); pendingView = deferred();
      await nativeClick($('[data-select-group="study"]'));
      assert(!overlay(), "Old group menu remains while the new group request is pending");
      redraw(); same(overlay(), null, "An ordinary old-state snapshot resurrected a closed menu");
      pendingView.resolve(); pendingView = null; await sleep(30);
      same(store.view.groupId, "study", "The selected group committed"); same(overlay(), null, "View reply resurrected the old menu");
      return { nativePointer: true, delayedReadback: true };
    });
    await check("Favorites native Escape closes menus and icon picker and restores the owning trigger focus", async () => {
      await restore(); await openMenu("keepsake");
      $('[data-group-action="rename"]').focus();
      // IME 使用 Escape 取消候选时不能被浮层快捷键抢走；普通 Esc 仍由原生输入验收。
      const composingEscape = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true, isComposing: true });
      document.activeElement.dispatchEvent(composingEscape);
      assert(overlay(), "IME candidate Escape closed the menu");
      same(composingEscape.defaultPrevented, false, "Menu intercepted IME candidate Escape");
      await nativeEscape();
      same(overlay(), null, "Escape did not close the menu");
      same(document.activeElement, $('[data-group-menu="keepsake"]'), "Menu focus returned to the wrong group");
      await openMenu("study"); await nativeClick($('[data-group-action="icon"]'));
      assert($(".favorite-icon-picker"), "Icon picker missing");
      $("[data-group-icon]").focus(); await nativeEscape();
      same(overlay(), null, "Escape did not close the icon picker");
      same(document.activeElement, $('[data-group-menu="study"]'), "Picker focus returned to the wrong group");
      same(requests.length, 0, "Dismissal must not write to storage");
      return { nativeEscapeEvents: 2 };
    });
    await check("Favorites outside click dismisses the floating menu without stealing the clicked control focus", async () => {
      await restore(); await openMenu("keepsake");
      const outside = document.querySelector("#favorites-outside");
      await nativeClick(outside); same(overlay(), null, "Outside click left the menu open");
      same(document.activeElement, outside, "Outside click focus was stolen by menu dismissal");
    });
    await check("Favorites leaving its column closes transient UI without resetting the selected group", async () => {
      await restore(); await openMenu("keepsake");
      assert(typeof view.dismissTransientUi === "function", "Favorites view needs its explicit column-lifecycle boundary");
      view.dismissTransientUi(); redraw();
      same(overlay(), null, "Returning to the column revived the old menu");
      same(store.view.groupId, "keepsake", "Leaving the column changed the saved group");
    });

    await check("Favorites document visibility changes dismiss only floating UI and cannot revive it on return", async () => {
      await restore(); await openMenu("keepsake");
      hidden = true; document.dispatchEvent(new Event("visibilitychange"));
      same(overlay(), null, "Hidden document retained the group menu");
      hidden = false; document.dispatchEvent(new Event("visibilitychange")); redraw();
      same(overlay(), null, "Visible document revived the group menu");
      same(store.view.groupId, "keepsake", "Visibility change altered saved selection");
    });

    await check("Favorites account reset clears drafts and overlays before a new account render", async () => {
      await restore(); await openMenu("keepsake");
      await nativeClick($('[data-group-action="icon"]'));
      assert($(".favorite-icon-picker"), "Picker missing before reset");
      epoch++; view.reset(); same(root.children.length, 0, "Account reset kept private DOM");
      redraw(); same(overlay(), null, "New account render revived an old picker");
      await nativeClick($("[data-open-new-group]")); await replaceName($("[data-new-group] input"), "private old draft");
      epoch++; view.reset(); redraw();
      same($("[data-new-group]"), null, "Account reset revived an old draft");
      assert(!root.textContent.includes("private old draft"), "Old draft leaked into new view");
    });
    await check("Favorites blank create names stay in the input with local feedback and zero writes", async () => {
      await restore();
      for (const blank of ["", "   ", "\u3000\u3000"]) {
        if (!$("[data-new-group]")) await nativeClick($("[data-open-new-group]"));
        const name = $("[data-new-group] input"); await replaceName(name, blank);
        await nativeClick($("[data-new-group] button[type=submit]"));
        same($("[data-new-group] input"), name, "Invalid create remounted the input");
        same(name.value, blank, "Invalid create discarded raw draft"); same(document.activeElement, name, "Invalid create lost focus");
        same(name.getAttribute("aria-invalid"), "true", "Create input is not marked invalid");
        assert(error() && name.getAttribute("aria-describedby") === error().id, "Create error is not input-associated");
        same(error().textContent.trim(), translator("groupNameRequired"), "Create error text");
        same(requests.length, 0, "Blank create issued a storage write"); same(notifications.length, 0, "Blank create raised a global notice");
        redraw(); same($("[data-new-group] input"), name, "Snapshot remounted invalid create");
        same(name.value, blank, "Snapshot replaced invalid create draft");
      }
      return { testedWhitespace: ["empty", "ASCII", "full-width"], writes: requests.length, globalNotices: notifications.length };
    });
    await check("Favorites create feedback clears on valid input and successful names are trimmed and committed once", async () => {
      await restore(); await nativeClick($("[data-open-new-group]"));
      let name = $("[data-new-group] input"); await replaceName(name, "   "); await nativeClick($("[data-new-group] button[type=submit]"));
      await replaceName(name, "  Browser group  ");
      same(error(), null, "Create feedback did not clear on valid input");
      assert(name.getAttribute("aria-invalid") !== "true", "Create input stayed invalid");
      await nativeClick($("[data-new-group] button[type=submit]")); await sleep(30);
      same($("[data-new-group]"), null, "Successful create left the form open");
      same(store.groups.find(group => group.id === store.view.groupId)?.name, "Browser group", "Created name normalization");
      same(requests.filter(value => value.type === protocol.Type.FAVORITES_GROUP_CREATE).length, 1, "Create request count");
    });

    await check("Favorites repeated native submit while saving neither navigates nor sends a duplicate write", async () => {
      await restore(); await nativeClick($("[data-open-new-group]"));
      await replaceName($("[data-new-group] input"), "Exactly once");
      pendingMutation = deferred();
      const form = $("[data-new-group]"), submit = form.querySelector("button[type=submit]"), url = document.URL;
      const prevented = [];
      const recordSubmit = event => { if (event.target === form) prevented.push(event.defaultPrevented); };
      root.addEventListener("submit", recordSubmit);
      try {
        await nativeClick(submit); same(requests.length, 1, "Initial submit did not send exactly one request");
        assert(form.isConnected, "Deferred fixture must keep the pending native form mounted");
        await nativeClick(submit);
        same(requests.length, 1, "Repeated submit sent a duplicate write");
        same(prevented.length, 2, "Repeated native button click did not submit the pending form");
        assert(prevented.every(Boolean), "Owned pending form did not prevent default browser navigation");
        same(document.URL, url, "Repeated submit navigated the test document");
        pendingMutation.resolve(); pendingMutation = null; await sleep(30);
        same($("[data-new-group]"), null, "Successful pending form did not close");
        same(store.groups.filter(group => group.name === "Exactly once").length, 1, "Repeated submit duplicated a saved group");
      } finally { root.removeEventListener("submit", recordSubmit); }
      return { nativeSubmits: 2, writes: 1, defaultNavigationPrevented: true };
    });

    await check("Favorites whitespace rename remains editable without writes or global unknown-result notices", async () => {
      await restore(); const name = await openRename();
      await replaceName(name, "\u3000  \u3000"); await nativeClick($('[data-group-rename="keepsake"] button[type=submit]'));
      same($('[data-group-rename="keepsake"] input'), name, "Invalid rename removed the editor");
      same(document.activeElement, name, "Invalid rename did not focus its input");
      same(name.value, "\u3000  \u3000", "Invalid rename lost its draft");
      same(name.getAttribute("aria-invalid"), "true", "Rename input is not marked invalid");
      assert(error() && name.getAttribute("aria-describedby") === error().id, "Rename error is not input-associated");
      same(requests.length, 0, "Blank rename issued a storage write"); same(notifications.length, 0, "Blank rename raised a global notice");
      await replaceName(name, "Renamed group");
      same(error(), null, "Rename feedback did not clear on valid input");
      await nativeClick($('[data-group-rename="keepsake"] button[type=submit]')); await sleep(30);
      same($("[data-group-rename]"), null, "Successful rename kept editor open");
      same(store.groups.find(group => group.id === "keepsake").name, "Renamed group", "Rename did not commit");
      same(requests.filter(value => value.type === protocol.Type.FAVORITES_GROUP_UPDATE).length, 1, "Rename request count");
    });
    await check("Favorites live drafts, caret and focus survive same-owner snapshots and translation changes", async () => {
      await restore(); const name = await openRename(); await replaceName(name, "Draft still editing");
      name.setSelectionRange(3, 8); translator = createTranslator("zh-CN"); redraw();
      same($("[data-group-rename] input"), name, "Translation replaced the native input");
      same(name.value, "Draft still editing", "Translation overwrote the draft with the preset label");
      same(document.activeElement, name, "Translation lost the input focus");
      same(name.selectionStart, 3, "Translation moved the selection start"); same(name.selectionEnd, 8, "Translation moved the selection end");
      store = { ...store, revision: store.revision + 1 }; redraw();
      same(name.value, "Draft still editing", "Background revision overwrote a live draft");
      same(document.activeElement, name, "Background revision lost focus");
      await nativeClick($("[data-cancel-group-edit]")); same(requests.length, 0, "Draft cancellation issued a write");
      assert(store.groups.find(group => group.id === "keepsake").preset === "keepsake", "Draft mutation reached persistent state");
    });

    await check("Favorites native IME name composition survives snapshots and commits without duplication", async () => {
      await restore(); const name = await openRename(), events = [];
      for (const type of ["compositionstart", "compositionupdate", "compositionend", "input"]) {
        name.addEventListener(type, event => events.push({ type, trusted: event.isTrusted, composing: event.isComposing }));
      }
      await replaceName(name, "");
      const compose = value => nativeInput({ kind: "composition", text: value, selectionStart: value.length, selectionEnd: value.length });
      await compose("ming"); const caret = name.selectionStart;
      same(name.value, "ming", "IME candidate draft was replaced");
      translator = createTranslator("zh-CN"); redraw();
      same($("[data-group-rename] input"), name, "IME input remounted during snapshot");
      same(document.activeElement, name, "IME input lost focus");
      same(name.value, "ming", "Translation replaced the IME candidate draft");
      same(name.selectionStart, caret, "Snapshot moved the IME caret");
      await compose("名称"); await nativeText("名称");
      same(name.value, "名称", "IME commit duplicated or prefixed the group name");
      same(name.selectionStart, 2, "IME commit caret is incorrect");
      assert(events.some(event => event.type === "compositionstart" && event.trusted)
        && events.some(event => event.type === "input" && event.trusted && event.composing)
        && events.some(event => event.type === "compositionend"), "IME test did not receive native composition events");
      same(requests.length, 0, "IME editing sent an early write");
      await nativeClick($("[data-cancel-group-edit]"));
      return { nativeComposition: true, committedValue: "名称", earlyWrites: 0 };
    });

    await check("Favorites delete confirmation targets only the currently opened menu group and retains its favorites", async () => {
      await restore(); await openMenu("keepsake");
      await nativeClick($('[data-select-group="study"]')); same(overlay(), null, "Old menu stayed open after selection");
      await openMenu("study"); await nativeClick($('[data-group-action="delete"]'));
      const confirmation = document.querySelector(".library-confirmation[open]");
      assert(confirmation?.open, "Delete must open the real panel confirmation");
      assert(confirmation.textContent.includes(translator("deleteGroupConfirm", { name: $('[data-group-name="study"]').textContent })), "Wrong group in delete confirmation");
      await nativeEscape();
      same(requests.filter(value => value.type === protocol.Type.FAVORITES_GROUP_DELETE).length, 0, "Cancelled deletion still wrote");
      await openMenu("keepsake"); await nativeClick($('[data-group-action="delete"]'));
      await nativeClick(document.querySelector(".library-confirmation[open] [data-panel-confirmation-accept]")); await sleep(30);
      same(Object.keys(store.items).length, 1, "Deleting a group removed a favorite");
      same(store.items[ownSnapshot.conversation.conversationId].groupId, null, "Deleted group's favorite was not ungrouped");
      assert(!store.groups.some(group => group.id === "keepsake") && store.groups.some(group => group.id === "study"), "Deletion affected another group");
    });
    await check("Favorites ordinary toggle, group filing and exact conversation navigation still use production actions", async () => {
      await restore(); await nativeClick($("[data-toggle-current]")); await sleep(30);
      same(Object.keys(store.items).length, 0, "Current favorite did not toggle off");
      await nativeClick($("[data-toggle-current]")); await sleep(30);
      same(store.items[ownSnapshot.conversation.conversationId]?.groupId, "keepsake", "New current favorite lost selected group");
      await nativeClick($("[data-open-favorite]")); await sleep(30);
      same(navigation.length, 1, "Favorite navigation count");
      same(navigation[0].conversationId, ownSnapshot.conversation.conversationId, "Favorite opened a different conversation");
      same(requests.at(-1).type, protocol.Type.FAVORITES_OPEN, "Open did not use the navigation operation");
      assert(notifications.every(args => args[0] !== "libraryChangeUnknown"), "Normal interactions raised unknown-result feedback");
    });

    await check("Favorites inline name feedback fits a 320px column without growing a global notice", async () => {
      await restore(); root.style.width = "320px"; translator = createTranslator("zh-CN"); redraw();
      const name = await openRename(); await replaceName(name, "\u3000");
      await nativeClick($('[data-group-rename="keepsake"] button[type=submit]'));
      const note = error(); assert(note, "Expected visible inline name feedback");
      const bounds = root.getBoundingClientRect(), fieldBounds = name.getBoundingClientRect(), noteBounds = note.getBoundingClientRect();
      assert(noteBounds.top >= fieldBounds.bottom - 1, "Name feedback must sit below its input, not over it");
      assert(noteBounds.left >= bounds.left - 1 && noteBounds.right <= bounds.right + 1, "Inline name feedback overflows a narrow column");
      assert(root.scrollWidth <= root.clientWidth + 1, "Name feedback creates horizontal overflow");
      same(notifications.length, 0, "Inline name feedback also created a global notice");
      return { columnWidth: bounds.width, fieldWidth: fieldBounds.width, noteWidth: noteBounds.width };
    });

  } finally {
    globalThis.confirm = originalConfirm;
    if (pendingView) pendingView.resolve();
    if (pendingMutation) pendingMutation.resolve();
  }
}


// 同一组行为契约逐栏运行，差别只在生产 API / selector；不是复制第二套 UI。
async function runSharedLibraryInteractionChecks() {
  const root = document.querySelector("#shared-library-interactions");
  document.querySelector("#favorites-interactions").hidden = true; root.hidden = false;
  root.style.width = "320px";
  const click = async node => { assert(node, "Click target missing"); node.click(); await sleep(5); };
  const draft = (node, value) => { assert(node, "Name input missing"); node.focus(); node.value = value; node.dispatchEvent(new Event("input", { bubbles: true })); };
  const configs = [
    { kind: "favorites", createView: createFavoritesView, createActions: createFavoritesActions, empty: createEmptyFavoritesState,
      group: "keepsake", second: "study", groupMenu: "data-group-menu", groupOverlay: "data-group-overlay", groupAction: "data-group-action",
      groupRow: "data-group-row", groupList: "data-group-list", selectGroup: "data-select-group", icon: "data-group-icon",
      newGroup: "data-new-group", openNew: "data-open-new-group", rename: "data-group-rename", entryMenu: "data-favorite-menu", entryOverlay: "data-favorite-entry-overlay",
      create: createFavoriteGroup, update: updateFavoriteGroup, removeGroup: deleteFavoriteGroup, updateView: updateFavoritesView,
      move: moveFavorite, remove: removeFavorite, counts: favoriteGroupCounts,
      seed: (state, snap, groupId) => upsertFavoriteFromSnapshot(state, snap, { groupId, now: "2026-09-01T00:00:00.000Z" }) },
    { kind: "bookmarks", createView: createBookmarksView, createActions: createBookmarksActions, empty: createEmptyBookmarksState,
      group: "bookmark-quote", second: "bookmark-insight", groupMenu: "data-bookmark-group-menu", groupOverlay: "data-bookmark-group-overlay", groupAction: "data-bookmark-group-action",
      groupRow: "data-bookmark-group-row", groupList: "data-bookmark-group-list", selectGroup: "data-bookmark-select-group", icon: "data-bookmark-group-icon",
      newGroup: "data-bookmark-new-group", openNew: "data-open-bookmark-new-group", rename: "data-bookmark-group-rename", entryMenu: "data-bookmark-entry-menu", entryOverlay: "data-bookmark-entry-overlay",
      create: createBookmarkGroup, update: updateBookmarkGroup, removeGroup: deleteBookmarkGroup, updateView: updateBookmarksView,
      move: moveBookmark, remove: removeBookmark, counts: bookmarkGroupCounts,
      seed: (state, snap, groupId) => addBookmarkFromSnapshot(state, snap, snap.messages[0].messageId, { groupId, now: "2026-09-01T00:00:00.000Z" }) },
  ];
  const originalConfirm = globalThis.confirm;
  globalThis.confirm = () => { throw new Error("No browser-native confirmation allowed"); };
  try { for (const c of configs) {
    let store, epoch = 0, mutationGate = null, selection = null, view;
    const writes = [], notices = [], navigation = [], snap = snapshot("shared-ui", "synthetic");
    const owner = () => ({ accountKey: "shared-" + c.kind, identity: { documentId: "shared-ui-fixture", epoch } });
    const owns = token => token.accountKey === owner().accountKey && token.identity.epoch === epoch;
    const $ = selector => root.querySelector(selector), sel = (attribute, value) => '[' + attribute + (value ? '="' + value + '"' : '') + ']';
    const redraw = () => view.render({ store, snapshot: snap, preferences, bookmarkCounts: {}, activeBookmarkId: null, exportSelection: selection, t });
    const actions = c.createActions({ ownerTabId: 31, isReady: () => true, captureOwner: owner, isOwnerCurrent: owns,
      acceptMutation(token, result) { if (!owns(token)) return false; store = result; redraw(); return true; },
      refresh: async () => redraw(), toast: (...args) => notices.push(args),
      readCurrentConversation: () => ({ conversationId: snap.conversation.conversationId, isFavorite: true }),
      readCurrentConversationId: () => snap.conversation.conversationId,
      beginNavigation(target) { navigation.push(target); return "shared-ui-navigation"; }, isNavigationCurrent: () => true, isNavigationCompleted: () => false,
      async startNavigation(target) { navigation.push(target); },
      async request(type, payload) {
        writes.push({ type, payload: clone(payload) });
        same(payload.expectedAccountKey, owner().accountKey, "Write captured owner"); same(payload.expectedTabId, 31, "Write bound tab");
        const options = { now: "2026-10-01T00:00:00.000Z", idFactory: () => "created-browser-group" };
        const prefix = c.kind.toUpperCase(); let result;
        if (type === protocol.Type[prefix + "_GROUP_CREATE"]) result = c.create(store, payload.name, options);
        else if (type === protocol.Type[prefix + "_GROUP_UPDATE"]) result = c.update(store, payload.groupId, payload.patch, options);
        else if (type === protocol.Type[prefix + "_GROUP_DELETE"]) result = c.removeGroup(store, payload.groupId, options);
        else if (type === protocol.Type[prefix + "_VIEW_UPDATE"]) result = c.updateView(store, payload, options);
        else if (type === protocol.Type[prefix + "_MOVE"]) result = c.move(store, payload.conversationId || payload.bookmarkId, payload.groupId, options);
        else if (type === protocol.Type[prefix + "_REMOVE"]) result = c.remove(store, payload.conversationId || payload.bookmarkId, options);
        else if (type === protocol.Type.FAVORITES_OPEN) return { opened: payload.conversationId };
        else throw Error("Unexpected shared fixture write: " + type);
        if (mutationGate) await mutationGate.promise;
        return { ...result, accountKey: owner().accountKey };
      },
    });
    view = c.createView({ root, onAction: (action, payload) => actions.handle(action, payload) });
    const restore = async ({ many = false } = {}) => {
      if (mutationGate) { mutationGate.resolve(); mutationGate = null; await sleep(5); }
      view.reset(); epoch++; hidden = false; selection = null;
      store = c.empty();
      if (many) for (let i = 0; i < 24; i++) store = c.create(store, "Long group " + i, { idFactory: () => "long-" + i });
      store = c.seed(store, snap, c.group); store.accountKey = owner().accountKey; store.view.groupId = "all";
      writes.length = notices.length = navigation.length = 0; redraw(); await sleep(10);
    };
    const menu = async id => { await click($(sel(c.groupMenu, id))); assert($(sel(c.groupOverlay, id)), "Group menu missing"); };
    const rename = async id => { await menu(id); await click($(sel(c.groupAction, "rename"))); return $(sel(c.rename, id) + " input"); };
    const askDelete = async id => { await menu(id); await click($(sel(c.groupAction, "delete"))); const dialog = document.querySelector(".library-confirmation[open]"); assert(dialog?.open, "Panel confirmation missing"); return dialog; };
    const entry = () => $(sel(c.entryMenu));
    const absent = () => !$(sel(c.groupOverlay)) && !$(sel(c.entryOverlay));
    await check(c.kind + " shared Esc, outside, switch, visibility and explicit leave dismiss every menu without navigation", async () => {
      await restore();
      for (const kind of ["group", "icon", "entry"]) {
        if (kind === "entry") await click(entry());
        else { await menu(c.group); if (kind === "icon") await click($(sel(c.groupAction, "icon"))); }
        const trigger = kind === "entry" ? entry() : $(sel(c.groupMenu, c.group));
        await nativeEscape(); assert(absent(), "Escape left " + kind + " menu open"); same(document.activeElement, trigger, "Escape did not restore exact owner trigger");
      }
      await click(entry()); await click(document.querySelector("#favorites-outside")); assert(absent(), "Outside click retained entry menu");
      await menu(c.group); await click($(sel(c.selectGroup, c.second))); assert(absent(), "Group switch retained old menu");
      store.view.groupId = "all"; redraw(); await click(entry()); hidden = true; document.dispatchEvent(new Event("visibilitychange")); assert(absent(), "Hidden document retained entry menu");
      hidden = false; document.dispatchEvent(new Event("visibilitychange")); redraw(); assert(absent(), "Visibility revived entry menu");
      await click(entry()); view.dismissTransientUi(); redraw(); assert(absent(), "Leaving column revived menu");
      same(navigation.length, 0, "Menu interaction started navigation");
    });
    await check(c.kind + " choosing a group icon closes its picker before a delayed write and prevents a stale second submit", async () => {
      await restore(); await menu(c.group); await click($(sel(c.groupAction, "icon")));
      const current = store.groups.find(group => group.id === c.group).icon;
      const choice = [...root.querySelectorAll(sel(c.icon))].find(button => button.getAttribute(c.icon) !== current);
      assert(choice, "Alternate group icon missing"); const next = choice.getAttribute(c.icon); mutationGate = deferred();
      await click(choice); assert(absent(), "Icon picker remains interactive while its write is pending");
      choice.click(); same(writes.length, 1, "Detached icon submitted a second pending update");
      mutationGate.resolve(); mutationGate = null; await sleep(10);
      same(store.groups.find(group => group.id === c.group).icon, next, "Selected icon did not commit");
      assert(absent(), "Completed icon update revived the picker");
    });
    await check(c.kind + " empty create/rename use shared local feedback while preserving editable drafts and zero writes", async () => {
      await restore();
      for (const mode of ["create", "rename"]) for (const value of ["", "   ", "\u3000\u3000"]) {
        view.reset(); redraw();
        if (mode === "create") await click($(sel(c.openNew)));
        else await rename(c.group);
        const form = $(sel(mode === "create" ? c.newGroup : c.rename)), input = form.querySelector("[data-group-name-input]");
        assert(form.noValidate, "Browser-native required bubble is still enabled"); draft(input, value);
        await click(form.querySelector('[type="submit"]'));
        const error = $("[data-group-name-error]");
        same(error?.textContent.trim(), t("groupNameRequired"), "Shared name feedback");
        same(input.getAttribute("aria-invalid"), "true", "Input not marked invalid"); same(input.getAttribute("aria-describedby"), error.id, "Input lacks linked feedback");
        await sleep(25); same(document.activeElement, input, "Invalid form did not focus its editable field");
        const probe = document.createElement("span"); probe.style.color = getComputedStyle(input).getPropertyValue("--danger"); document.body.append(probe);
        const danger = getComputedStyle(probe).color; probe.remove();
        same(getComputedStyle(input).borderBottomColor, danger, "Focused invalid field lost its danger border");
        redraw(); same($("[data-group-name-input]"), input, "Snapshot remounted draft"); same(input.value, value, "Snapshot rewrote draft");
        same(writes.length, 0, "Invalid form reached persistence"); same(notices.length, 0, "Invalid form emitted a global notice");
      }
      draft($("[data-group-name-input]"), "  Corrected  "); assert(!$("[data-group-name-error]"), "Valid input did not clear error");
      await click($(sel(c.rename) + ' [type="submit"]'));
      same(store.groups.find(group => group.id === c.group).name, "Corrected", "Valid rename did not trim/save"); same(writes.length, 1, "Corrected form did not save exactly once");
    });
    await check(c.kind + " bottom group validation reveals the whole row and hint within its own 320px scroll area", async () => {
      await restore({ many: true }); const input = await rename("long-23");
      const list = $(sel(c.groupList)), row = $(sel(c.rename, "long-23"));
      list.scrollTop = list.scrollHeight; await sleep(10);
      // 模拟用户正看见最后一行时提交；不用scrollIntoView掩盖生产代码裁切错误。
      draft(input, "\u3000"); const outerScroll = document.documentElement.scrollTop, result = $('[data-results-viewport]'), resultScroll = result.scrollTop;
      row.querySelector('[type="submit"]').click(); await sleep(45);
      const note = $("[data-group-name-error]"), box = list.getBoundingClientRect(), a = row.getBoundingClientRect(), b = note.getBoundingClientRect();
      assert(a.top >= box.top - 1 && b.bottom <= box.bottom + 1, "Bottom name error remains clipped by group scrollport");
      same(document.documentElement.scrollTop, outerScroll, "Validation scrolled the whole page"); same(result.scrollTop, resultScroll, "Validation scrolled result list");
      assert(root.scrollWidth <= root.clientWidth + 1, "320px group error caused horizontal overflow");
      const after = list.scrollTop; draft(input, "New name while editing");
      same(list.scrollTop, Math.min(after, list.scrollHeight - list.clientHeight), "Normal input scrolled groups beyond the natural shorter-content clamp");
      return { width: root.getBoundingClientRect().width, rowBottom: a.bottom, noteBottom: b.bottom, viewportBottom: box.bottom, groupScroll: list.scrollTop };
    });
    await check(c.kind + " panel confirmation displays exact escaped group, defaults to cancel and Escape causes zero writes", async () => {
      await restore(); store = c.update(store, c.group, { name: '<QA "group">' }); redraw();
      let dialog = await askDelete(c.group);
      assert(dialog.textContent.includes('<QA "group">'), "Dialog shows wrong/unescaped group name"); assert(!dialog.querySelector("qa"), "Group name interpreted as HTML");
      same(document.activeElement, dialog.querySelector("[data-panel-confirmation-cancel]"), "Default focus must stay on cancel");
      await nativeInput({ kind: "key", key: "Enter", code: "Enter", vk: 13 });
      assert(!document.querySelector(".library-confirmation[open]"), "Default Enter did not cancel the dialog");
      same(writes.length, 0, "Default Enter deleted a group"); dialog = await askDelete(c.group);
      const escaped = [], captured = [], observeEscape = event => { if (event.key === "Escape") escaped.push(event.defaultPrevented); };
      const captureEscape = event => { if (event.key === "Escape") captured.push(event.isTrusted); };
      document.addEventListener("keydown", captureEscape, true); document.addEventListener("keydown", observeEscape);
      try { await nativeEscape(); } finally { document.removeEventListener("keydown", captureEscape, true); document.removeEventListener("keydown", observeEscape); }
      assert(captured.length === 1 && captured[0] && escaped.every(Boolean), "Dialog Escape leaked to a later global back handler");
      assert(!document.querySelector(".library-confirmation[open]"), "Esc did not close confirmation");
      same(writes.length, 0, "Cancel wrote group deletion"); assert(store.groups.some(group => group.id === c.group), "Cancelled group disappeared");
    });
    await check(c.kind + " pending confirmations are cancelled by leave, reset, hidden and target changes without stale deletes", async () => {
      for (const cause of ["leave", "reset", "hidden", "target-changed"]) {
        await restore(); const dialog = await askDelete(c.group), staleAccept = dialog.querySelector("[data-panel-confirmation-accept]");
        if (cause === "leave") view.dismissTransientUi();
        else if (cause === "reset") { epoch++; view.reset(); }
        else if (cause === "hidden") { hidden = true; document.dispatchEvent(new Event("visibilitychange")); }
        else { store = c.update(store, c.group, { name: "Changed elsewhere" }); redraw(); }
        staleAccept.click(); await sleep(10);
        same(writes.length, 0, "Stale confirmation committed after " + cause);
        assert(!document.querySelector(".library-confirmation[open]"), "Stale confirmation remains open after " + cause);
      }
    });
    await check(c.kind + " repeated delete confirmation writes once and moves records to ungrouped without losing metadata", async () => {
      await restore(); const saved = clone(Object.values(store.items)[0]);
      const dialog = await askDelete(c.group), accept = dialog.querySelector("[data-panel-confirmation-accept]"); mutationGate = deferred();
      accept.click(); accept.click(); await sleep(10); same(writes.length, 1, "Double confirmation replayed delete");
      mutationGate.resolve(); mutationGate = null; await sleep(10);
      const after = Object.values(store.items)[0]; same(JSON.stringify({ ...after, groupId: saved.groupId }), JSON.stringify(saved), "Delete altered saved content beyond filing");
      same(after.groupId, null, "Deleted group contents were not ungrouped"); same(c.counts(store).ungrouped, 1, "Ungrouped count did not update");
      assert(!store.groups.some(group => group.id === c.group), "Confirmed group was not deleted");
    });
    await check(c.kind + " common entry menu moves and ungroups without changing saved metadata, counts, or opening navigation", async () => {
      await restore(); const original = clone(Object.values(store.items)[0]);
      await click(entry()); const move = $('[data-library-move-group="' + c.second + '"]'); mutationGate = deferred();
      move.click(); move.click(); await sleep(10); same(writes.length, 1, "Repeated move click sent duplicate writes");
      mutationGate.resolve(); mutationGate = null; await sleep(10);
      let item = Object.values(store.items)[0]; same(item.groupId, c.second, "Move target not applied");
      same(JSON.stringify({ ...item, groupId: original.groupId }), JSON.stringify(original), "Move changed more than groupId");
      same(c.counts(store)[c.group], 0, "Old group count incorrect"); same(c.counts(store)[c.second], 1, "New group count incorrect");
      same(navigation.length, 0, "Move opened the conversation");
      await click(entry()); await click($('[data-library-move-group="ungrouped"]'));
      item = Object.values(store.items)[0]; same(item.groupId, null, "Ungrouped target not applied"); same(c.counts(store).ungrouped, 1, "Ungrouped count incorrect");
      const open = c.kind === "favorites" ? $("[data-open-favorite]") : $("[data-bookmark-jump]"); await click(open);
      same(navigation.length, 1, "Ordinary entry open stopped working");
      await click(entry()); await click($("[data-library-remove]")); same(Object.keys(store.items).length, 0, "Remove menu did not remove exact saved record");
    });
    await check(c.kind + " export selection has no entry operations and long-group menus stay scrollable within a narrow column", async () => {
      await restore({ many: true }); await click(entry());
      const overlay = $(sel(c.entryOverlay)), menuBox = overlay.getBoundingClientRect(), rootBox = root.getBoundingClientRect();
      assert(menuBox.left >= rootBox.left - 1 && menuBox.right <= rootBox.right + 1 && menuBox.top >= rootBox.top - 1 && menuBox.bottom <= rootBox.bottom + 1, "Long entry menu escapes its panel");
      const scroll = [overlay, ...overlay.querySelectorAll("*")].find(node => node.scrollHeight > node.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(node).overflowY));
      assert(scroll, "Long group menu has no scrollable container"); scroll.scrollTop = scroll.scrollHeight;
      const remove = overlay.querySelector("[data-library-remove]"), removeBox = remove.getBoundingClientRect(), scrollBox = scroll.getBoundingClientRect();
      assert(removeBox.bottom <= menuBox.bottom + 1 && removeBox.top >= menuBox.top - 1, "Remove is inaccessible outside the bounded menu");
      const menuScrollHeight = scroll.scrollHeight;
      selection = { active: true, draftIds: [], basketConversationIds: [], basketBookmarkIds: [] }; redraw();
      assert(!entry() && !$(sel(c.entryOverlay)), "Export selection still exposes entry operations");
      same(writes.length, 0, "Opening/exporting menus wrote data");
      return { width: rootBox.width, menuHeight: menuBox.height, scrollHeight: menuScrollHeight };
    });
    view.reset();
  } } finally { globalThis.confirm = originalConfirm; hidden = false; }
}

try {
  backend = library("owner-one", 1);
  currentSnapshot = snapshot("owner-one-chat-00");
  await import("../../src/platform/library/content/library-client.js");
  const client = globalThis.TidyLibraryClient;
  assert(client, "The production content library client did not initialize");
  client.subscribe(state => clientPublications.push({ accountKey: state?.accountKey || null }));
  await Promise.all([controller.refresh(), client.refresh()]);
  await sleep(50);

  await check("initial account library mounts both real views and the content client", async () => {
    same(controller.getState().accountKey, backend.accountKey, "Controller owner");
    same(client.current()?.accountKey, backend.accountKey, "Content owner");
    same(rows("favorites").length, 7, "Favorites default page size");
    same(rows("bookmarks").length, 6, "Bookmarks default page size");
    assert(hasPrivateText("owner-one"), "Seeded account records are missing");
    return { favorites: Object.keys(backend.favorites.items).length, bookmarks: Object.keys(backend.bookmarks.items).length };
  });

  await check("bookmark page sizes are 6/10/15/20 and do not change Favorites", async () => {
    const selector = "[data-bookmark-page-size]";
    same([...roots.bookmarks.querySelector(selector).options].map(option => option.value).join('/'), '6/10/15/20', 'Bookmark choices');
    for (const size of [10, 15, 20, 6]) {
      const select = roots.bookmarks.querySelector(selector);
      select.value = String(size); select.dispatchEvent(new Event('change', { bubbles: true }));
      same(rows('bookmarks').length, size, 'Visible bookmark count');
      same(pageInput('bookmarks').value, '1', 'Page resets after changing size');
      same(rows('favorites').length, 7, 'Favorites retains its default');
    }
  });

  await check("20 same-document route, focus and visibility cycles preserve DOM, page, scroll and leases", async () => {
    for (const kind of ["favorites", "bookmarks"]) {
      const input = pageInput(kind); input.value = "2"; input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await sleep(30);
    const lists = { favorites: viewport("favorites"), bookmarks: viewport("bookmarks") };
    const firstRows = { favorites: rows("favorites")[0], bookmarks: rows("bookmarks")[0] };
    const observers = { favorites: observeList(lists.favorites), bookmarks: observeList(lists.bookmarks) };
    lists.favorites.scrollTop = 80; lists.bookmarks.scrollTop = 90;
    const scroll = { favorites: lists.favorites.scrollTop, bookmarks: lists.bookmarks.scrollTop };
    assert(scroll.favorites > 0 && scroll.bookmarks > 0, "Fixture lists must actually scroll");
    const token = controller.capture(), lease = client.capture("favorites");
    const publicationCount = publications.length, clientCount = clientPublications.length, requestCount = runtimeCalls.length;
    const focus = roots.bookmarks.querySelector("[data-bookmark-search]"); focus.focus();
    try {
      for (let index = 0; index < 20; index++) {
        route(`route-${index}`);
        window.dispatchEvent(new Event("focus"));
        hidden = true; document.dispatchEvent(new Event("visibilitychange"));
        hidden = false; document.dispatchEvent(new Event("visibilitychange"));
        await sleep(20);
        same(controller.getState().accountKey, backend.accountKey, "Route cleared controller");
        same(client.current()?.accountKey, backend.accountKey, "Route cleared content owner");
        assert(controller.isCurrent(token) && client.owns(lease), "Ordinary lifecycle invalidated a valid lease");
        same(document.activeElement, focus, "Search input lost native focus");
        for (const kind of ["favorites", "bookmarks"]) {
          same(viewport(kind), lists[kind], `${kind} viewport remounted`);
          same(rows(kind)[0], firstRows[kind], `${kind} visible row remounted`);
          same(pageInput(kind).value, "2", `${kind} page reset`);
          same(lists[kind].scrollTop, scroll[kind], `${kind} scroll reset`);
        }
      }
    } finally { observers.favorites.stop(); observers.bookmarks.stop(); hidden = false; }
    same(runtimeCalls.length, requestCount, "Ordinary route/focus/visibility issued library reads");
    same(publications.length, publicationCount, "Ordinary lifecycle republished panel state");
    same(clientPublications.length, clientCount, "Ordinary lifecycle cleared or republished content state");
    same(observers.favorites.records.length + observers.bookmarks.records.length, 0, "Ordinary lifecycle mutated list children");
    return { cycles: 20, extraLibraryReads: runtimeCalls.length - requestCount, listChildMutations: 0, pages: [2, 2], scroll };
  });

  await check("same-owner background revisions retain old lists while pending and patch only committed data", async () => {
    const lists = { favorites: viewport("favorites"), bookmarks: viewport("bookmarks") };
    const firstRows = { favorites: rows("favorites")[0], bookmarks: rows("bookmarks")[0] };
    const scroll = { favorites: lists.favorites.scrollTop, bookmarks: lists.bookmarks.scrollTop };
    const favoriteId = firstRows.favorites.querySelector("[data-open-favorite]")?.dataset.openFavorite || firstRows.favorites.dataset.openFavorite, bookmarkId = firstRows.bookmarks.dataset.bookmarkJump;
    backend.favorites.items[favoriteId].title = "owner-one changed local favorite";
    backend.bookmarks.items[bookmarkId].excerpt = "owner-one changed local bookmark";
    backend.favorites.revision++; backend.bookmarks.revision++;
    const beforePanel = publications.length, beforeClient = clientPublications.length;
    gate = deferred();
    emit(protocol.Type.FAVORITES_UPDATED, { accountKey: backend.accountKey, revision: backend.favorites.revision });
    emit(protocol.Type.BOOKMARKS_UPDATED, { accountKey: backend.accountKey, revision: backend.bookmarks.revision });
    await sleep(25);
    assert(controller.getState().accountKey && client.current(), "Pending local refresh blanked an owner");
    for (const kind of ["favorites", "bookmarks"]) {
      same(viewport(kind), lists[kind], `${kind} pending viewport changed`);
      same(rows(kind)[0], firstRows[kind], `${kind} pending row changed`);
      same(lists[kind].scrollTop, scroll[kind], `${kind} pending scroll changed`);
    }
    gate.resolve(); gate = null;
    await sleep(60);
    same(controller.getState().favorites.revision, backend.favorites.revision, "Favorite revision not committed");
    same(client.current().bookmarks.revision, backend.bookmarks.revision, "Content bookmark revision not committed");
    assert(firstRows.favorites.textContent.includes("changed local favorite"), "Favorite visible text did not patch");
    assert(firstRows.bookmarks.textContent.includes("changed local bookmark"), "Bookmark visible text did not patch");
    for (const kind of ["favorites", "bookmarks"]) {
      same(viewport(kind), lists[kind], `${kind} refreshed viewport remounted`);
      same(rows(kind)[0], firstRows[kind], `${kind} refreshed row remounted`);
      same(pageInput(kind).value, "2", `${kind} background revision reset page`);
      same(lists[kind].scrollTop, scroll[kind], `${kind} background revision reset scroll`);
    }
    assert(publications.slice(beforePanel).every(value => value.accountKey === backend.accountKey), "Background panel refresh published null");
    assert(clientPublications.slice(beforeClient).every(value => value.accountKey === backend.accountKey), "Background content refresh published null");
    return { nullPublications: 0, favoritesRevision: backend.favorites.revision, bookmarksRevision: backend.bookmarks.revision };
  });

  await check("identity change clears old private DOM and leases before the new owner read resolves", async () => {
    const token = controller.capture(), lease = client.capture("favorites"), previousReads = runtimeCalls.length;
    const unavailable = { documentId: "fixture-document", epoch: 2, phase: "unavailable", accountKey: null };
    for (const listener of localIdentityListeners) listener(unavailable);
    same(client.current(), null, "MAIN-world local identity boundary did not clear the content client synchronously");
    assert(!client.owns(lease), "Old content lease survived local identity boundary");
    same(runtimeCalls.length, previousReads, "Local identity boundary issued a premature library read");
    backend = library("owner-two", 3); gate = deferred();
    emit(protocol.Type.LIBRARY_IDENTITY_CHANGED, { tabId: 31, ...unavailable });
    same(controller.getState().accountKey, null, "Worker identity boundary did not clear controller synchronously");
    assert(!controller.isCurrent(token), "Old panel lease survived identity boundary");
    assert(!hasPrivateText("owner-one"), "Old account text remained mounted while the new read was pending");
    emit(protocol.Type.LIBRARY_IDENTITY_CHANGED, { tabId: 31, ...backend.identity, phase: "ready", accountKey: backend.accountKey });
    await sleep(25);
    assert(!hasPrivateText("owner-one") && !hasPrivateText("owner-two"), "A pending owner read displayed unverified rows");
    // The mocked native page now supplies the new account's current context;
    // this is separate from (and never inferred out of) its saved library rows.
    currentSnapshot = snapshot("owner-two-chat-00", "owner-two");
    gate.resolve(); gate = null;
    await sleep(60);
    same(controller.getState().accountKey, backend.accountKey, "New controller owner missing");
    same(client.current()?.accountKey, backend.accountKey, "New content owner missing");
    assert(hasPrivateText("owner-two") && !hasPrivateText("owner-one"), "New account view retained another owner's text");
    same(pageInput("favorites").value, "1", "New account inherited favorite pagination");
    same(pageInput("bookmarks").value, "1", "New account inherited bookmark pagination");
    return { clearedBeforeReadback: true, staleLeasesRejected: true, newAccountPages: [1, 1] };
  });

  await runFavoritesInteractionChecks();
  await runSharedLibraryInteractionChecks();

  await check("fixture isolation: no fetches or non-library operations", async () => {
    same(networkAttempts, 0, "A production module attempted network access");
    assert(runtimeCalls.every(call => call.type === protocol.Type.LIBRARY_GET), "Unexpected worker operation");
    return { networkAttempts, libraryReads: runtimeCalls.length, localIdentitySubscribers: localIdentityListeners.length };
  });
} catch (error) {
  checks.push({ name: "fixture initialization", ok: false, error: error.stack || error.message });
} finally {
  hidden = false;
  if (gate) { gate.resolve(); gate = null; }
  const result = document.querySelector("#results");
  result.textContent = JSON.stringify({ ok: checks.every(check => check.ok),
    scope: "Native Chromium module integration; mock extension messages and account storage; not a live ChatGPT or installed-extension test",
    checks }, null, 2);
  result.dataset.complete = "true";
}
