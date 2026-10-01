/**
 * 收藏/书签的侧栏绑定：只拥有视觉选择和“打开书签页”的目标 gate。
 * 资料始终读取 library.getState；这里不签发身份、不保存第二份账户资料。
 */
export function createLibraryPanelController({ ownerTabId, readLibrary, readPresentation, readRoute, isReady,
  views, navigation, presentation, selectionState, filing, refreshLibrary, navigate, onChanged = () => {} }) {
  let previousOwner = { accountKey: null, documentId: null, epoch: null };
  let activeBookmarkId = null;
  let pendingTarget = null;
  let counts = {};
  function get() {
    const model = readLibrary();
    return { accountKey: model.accountKey, favorites: model.favorites, bookmarks: model.bookmarks,
      errors: model.errors, bookmarkCounts: counts, activeBookmarkId,
      pendingTarget: pendingTarget ? { ...pendingTarget } : null };
  }
  function reconcileContext() {
    const model = readLibrary();
    if (pendingTarget && model.accountKey && model.accountKey !== pendingTarget.accountKey) pendingTarget = null;
    if (pendingTarget && model.bookmarks
      && readPresentation().snapshot?.conversation?.conversationId === pendingTarget.conversationId) pendingTarget = null;
  }
  function onLibraryChanged(model) {
    // 同账号也可能换文档或身份代际；旧界面授权不能跨过这条边界。
    // 只记录公开身份字段，不按资料对象/修订判定，普通刷新不会清掉输入与确认。
    const owner = { accountKey: model.accountKey, documentId: model.identity?.documentId ?? null,
      epoch: model.identity?.epoch ?? null };
    const ownerChanged = previousOwner.accountKey !== owner.accountKey
      || previousOwner.documentId !== owner.documentId || previousOwner.epoch !== owner.epoch;
    previousOwner = owner;
    counts = Object.values(model.bookmarks?.items || {}).reduce((result, item) => {
      result[item.conversationId] = (result[item.conversationId] || 0) + 1; return result;
    }, {});
    if (ownerChanged) {
      activeBookmarkId = null;
      for (const kind of ["favorites", "bookmarks"]) {
        if (!presentation.hasLibraryWaiting(views[kind].root)) views[kind].reset();
      }
    }
    if (activeBookmarkId && !model.bookmarks?.items?.[activeBookmarkId]) activeBookmarkId = null;
    reconcileContext();
    onChanged();
  }
  function waiting(kind, key) {
    const view = views[kind];
    if (!presentation.hasLibraryWaiting(view.root)) view.reset();
    presentation.renderLibraryWaiting({ root: view.root, owner: kind, key,
      visible: readRoute() === kind && isReady() });
    filing[kind]();
  }
  function error(kind, value) {
    const view = views[kind];
    view.reset();
    presentation.renderModuleError({ root: view.root, owner: kind,
      className: kind === "favorites" ? "favorite-empty" : "bookmark-empty", error: value,
      visible: readRoute() === kind && isReady() });
    filing[kind]();
  }
  function renderFavorites() {
    const model = get();
    if (model.errors.favorites) { error("favorites", model.errors.favorites); return; }
    if (!model.favorites) { waiting("favorites", "libraryVerifyingAccount"); return; }
    delete views.favorites.root.dataset.moduleState;
    presentation.clearLibraryNotice("favorites");
    views.favorites.render({ ...readPresentation(), store: model.favorites, bookmarkCounts: counts,
      exportSelection: selectionState("favorites") });
    filing.favorites();
  }
  function renderBookmarks() {
    const model = get();
    if (model.errors.bookmarks) { error("bookmarks", model.errors.bookmarks); return; }
    if (navigation.pendingConversationId() && (!model.bookmarks || presentation.hasLibraryWaiting(views.bookmarks.root))) {
      waiting("bookmarks", "bookmarkOpeningConversation"); return;
    }
    if (!model.bookmarks || (pendingTarget
      && readPresentation().snapshot?.conversation?.conversationId !== pendingTarget.conversationId)) {
      waiting("bookmarks", model.accountKey ? "readingConversation" : "libraryVerifyingAccount"); return;
    }
    delete views.bookmarks.root.dataset.moduleState;
    presentation.clearLibraryNotice("bookmarks");
    views.bookmarks.render({ ...readPresentation(), store: model.bookmarks, activeBookmarkId,
      pendingBookmarkId: navigation.pendingBookmarkId(), pendingConversationId: navigation.pendingConversationId(),
      exportSelection: selectionState("bookmarks") });
    filing.bookmarks();
  }
  function requestRoute(payload) {
    if (!isReady() || payload?.tabId !== ownerTabId || payload.route !== "bookmarks" || !payload.conversationId
      || typeof payload.accountKey !== "string" || !payload.accountKey) return false;
    const accountKey = readLibrary().accountKey;
    if (accountKey && payload.accountKey !== accountKey) return false;
    navigation.cancel();
    pendingTarget = { conversationId: payload.conversationId, accountKey: payload.accountKey };
    // 新会话 B 的 current-only 请求必须取代 A 的旧读取，之后才允许绘制 B。
    void refreshLibrary({ supersede: true });
    navigate("bookmarks");
    renderBookmarks();
    return true;
  }
  return Object.freeze({ get, onLibraryChanged, reconcileContext, renderFavorites, renderBookmarks, requestRoute,
    selected(id) { activeBookmarkId = id; renderBookmarks(); } });
}
