import * as basketModel from "./export-basket.js";

// 导出篮、来源草稿与短暂反馈只有本控制器可以写。
// 资料协调先 updateSources，再由各栏读取 selectionState；绘制顺序不参与业务。
export function createExportSelection({ noticeText = (key) => key, onChanged = () => {} } = {}) {
  let accountKey = null, verified = false, favorites = null, bookmarks = null;
  let favoriteInput = null, bookmarkInput = null, noticeEpoch = 0, feedbackEpoch = 0;
  const immutableCopy = value => {
    if (!value || typeof value !== "object") return value;
    return Object.freeze(Array.isArray(value) ? value.map(immutableCopy)
      : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, immutableCopy(child)])));
  };
  let basket = basketModel.emptyBasket(), draft = basketModel.emptyDraft(), context = null;
  let candidates = new Map(), candidateAccountKey = null, notice = null;
  let highlightedConversations = [], highlightedBookmarks = [], noticeTimer = null, feedbackTimer = null;
  const listeners = new Set([onChanged]);
  const emit = (reason, details = {}) => listeners.forEach(listener => listener({ reason, ...details }));
  const text = message => noticeText(message.key, { ...message.values,
    ...(message.unitKey ? { unit: noticeText(message.unitKey) } : {}) });
  const clearNotice = () => { noticeEpoch++; clearTimeout(noticeTimer); noticeTimer = null; notice = null; };
  const clearHighlights = () => { feedbackEpoch++; clearTimeout(feedbackTimer); feedbackTimer = null; highlightedConversations = []; highlightedBookmarks = []; };
  function cancelSelection() {
    const previous = context;
    context = null; draft = basketModel.emptyDraft(); candidates = new Map(); candidateAccountKey = null;
    return previous ? { ...previous } : null;
  }
  function sourceReady(source) {
    if (!verified || !accountKey) return false;
    if (source === "search") return true;
    return (source === "favorites" ? favorites : source === "bookmarks" ? bookmarks : null)?.accountKey === accountKey;
  }
  function basketSnapshot() {
    return Object.freeze({ conversations: Object.freeze(basket.conversations.map(record => Object.freeze({
      ...record, sources: Object.freeze([...record.sources]),
      ...(record.searchMetadata ? { searchMetadata: Object.freeze({ ...record.searchMetadata }) } : {}),
    }))), bookmarkIds: Object.freeze([...basket.bookmarkIds]) });
  }
  function snapshot() {
    return Object.freeze({ accountKey, scopeVerified: verified, favorites, bookmarks, basket: basketSnapshot(),
      batchHighlightedConversationIds: Object.freeze([...highlightedConversations]),
      batchHighlightedBookmarkIds: Object.freeze([...highlightedBookmarks]) });
  }
  function updateSources(model = {}) {
    const nextKey = typeof model.accountKey === "string" && model.accountKey && model.accountKey === model.accountKey.trim() ? model.accountKey : null;
    // Unknown identity is not evidence of a different owner. Lock public access
    // but retain the private basket/draft until a fresh verified owner arrives.
    if (!nextKey || !model.verified) {
      if (verified) { verified = false; emit("suspend"); }
      return;
    }
    const accountChanged = nextKey !== accountKey;
    const wasVerified = verified;
    const nextFavorites = Object.hasOwn(model, "favorites") ? nextKey && model.favorites?.accountKey === nextKey ? model.favorites : null : accountChanged ? null : favoriteInput;
    const nextBookmarks = Object.hasOwn(model, "bookmarks") ? nextKey && model.bookmarks?.accountKey === nextKey ? model.bookmarks : null : accountChanged ? null : bookmarkInput;
    const favoritesChanged = nextFavorites !== favoriteInput || nextFavorites?.revision !== favorites?.revision;
    const bookmarksChanged = nextBookmarks !== bookmarkInput || nextBookmarks?.revision !== bookmarks?.revision;
    const sourcesChanged = favoritesChanged || bookmarksChanged;
    accountKey = nextKey; verified = Boolean(nextKey && model.verified);
    if (accountChanged) { basket = basketModel.emptyBasket(); cancelSelection(); clearNotice(); clearHighlights(); }
    favoriteInput = nextFavorites; bookmarkInput = nextBookmarks;
    if (favoritesChanged || accountChanged) favorites = immutableCopy(nextFavorites);
    if (bookmarksChanged || accountChanged) bookmarks = immutableCopy(nextBookmarks);
    if (sourcesChanged) {
      const result = basketModel.reconcile(basket, draft, { favorites, bookmarks });
      basket = result.basket; draft = result.draft;
    }
    if (accountChanged || sourcesChanged || wasVerified !== verified) emit("sources", { accountChanged, sourcesChanged, basketChanged: accountChanged || sourcesChanged });
  }
  function beginSelection(source, returnTarget = "source") {
    if (!["favorites", "bookmarks", "search"].includes(source) || !sourceReady(source)) return false;
    context = { source, returnTarget }; draft = basketModel.emptyDraft(source);
    candidates = new Map(); candidateAccountKey = null; clearNotice(); clearHighlights();
    emit("begin"); return true;
  }
  function selectionState(source) {
    if (!verified) return { active: false, returnTarget: null, accountKey: null, draftIds: [],
      basketConversationSources: {}, basketConversationIds: [], basketBookmarkIds: [], notice: null };
    const active = context?.source === source;
    return { active, returnTarget: active ? context.returnTarget : null,
      accountKey: active && source === "search" ? candidateAccountKey : null,
      draftIds: active ? [...draft[source === "bookmarks" ? "bookmarkIds" : "conversationIds"]] : [],
      basketConversationSources: Object.fromEntries(basket.conversations.map(record => [record.conversationId, [...record.sources]])),
      basketConversationIds: basket.conversations.map(record => record.conversationId), basketBookmarkIds: [...basket.bookmarkIds],
      notice: notice?.source === source ? text(notice.message) : null };
  }
  function registerSearchResults(items) {
    if (!verified || !accountKey || context?.source !== "search" || !Array.isArray(items)) return 0;
    let registered = 0;
    for (const item of items) {
      if (item?.source !== "conversation" || item.matchKind !== "conversation-date" || item.messageId !== null
        || typeof item.conversationId !== "string" || !item.conversationId.trim() || item.conversationId !== item.conversationId.trim()
        || typeof item.title !== "string" || typeof item.accountKey !== "string" || !item.accountKey.trim() || item.accountKey !== item.accountKey.trim()) continue;
      if (![item.conversationCreatedAt, item.conversationUpdatedAt].every(value => value === null || (typeof value === "string" && Number.isFinite(Date.parse(value))))) continue;
      if (candidateAccountKey && item.accountKey !== candidateAccountKey) continue;
      candidateAccountKey = item.accountKey;
      if (!candidates.has(item.conversationId)) registered++;
      candidates.set(item.conversationId, { accountKey: item.accountKey, title: item.title, createdAt: item.conversationCreatedAt, updatedAt: item.conversationUpdatedAt });
    }
    if (registered) emit("candidates"); return registered;
  }
  function toggleSelection(source, id) {
    if (!verified || context?.source !== source || typeof id !== "string" || !id) return false;
    if (source === "search" && !basketModel.searchCandidateSelectable(basket, candidates, id)) return false;
    draft = basketModel.toggleDraft(draft, id); emit("draft"); return true;
  }
  function selectSelectionRange(source, ids) {
    if (!verified || context?.source !== source) return false;
    draft = basketModel.selectDraftRange(basket, draft, ids, candidates); emit("draft"); return true;
  }
  function submitSelection(source) {
    if (!verified || context?.source !== source || !draft[source === "bookmarks" ? "bookmarkIds" : "conversationIds"].length) return null;
    const result = basketModel.submitDraft(basket, draft, { favorites, bookmarks, searchCandidates: candidates });
    basket = result.basket;
    const previous = context, { added, sourceUpdated, addedConversationIds, addedBookmarkIds } = result;
    const message = added ? { key: "exportAddedCount", values: { count: added }, unitKey: source === "bookmarks" ? "bookmarkItemsUnit" : "conversationItemsUnit" }
      : sourceUpdated ? { key: "exportSourceSupplemented", values: { count: sourceUpdated } } : { key: "exportAlreadyAdded" };
    clearNotice();
    if (previous?.returnTarget === "source") {
      notice = { source, message };
      const token = noticeEpoch;
      noticeTimer = setTimeout(() => { if (token !== noticeEpoch) return; notice = null; noticeTimer = null; emit("notice-expired"); }, 2400);
    } else {
      clearHighlights(); highlightedConversations = addedConversationIds; highlightedBookmarks = addedBookmarkIds;
      if (["manage", "batch-main"].includes(previous?.returnTarget) && (addedConversationIds.length || addedBookmarkIds.length)) {
        const token = feedbackEpoch;
        feedbackTimer = setTimeout(() => { if (token !== feedbackEpoch) return; clearHighlights(); emit("highlight-expired"); }, 2400);
      }
    }
    cancelSelection(); emit("submit", { basketChanged: true });
    return { context: { ...previous }, added, sourceUpdated, message: text(message) };
  }
  return Object.freeze({
    updateSources, snapshot, sourceReady, selectionState, registerSearchResults, beginSelection, toggleSelection,
    selectSelectionRange, submitSelection,
    cancelSelection() { const previous = cancelSelection(); if (previous) emit("cancel"); return previous; },
    selectionContext: () => verified && context ? { ...context } : null,
    basketCount: () => verified ? basketModel.count(basket) : 0,
    removeConversation(id) { basket = basketModel.removeConversation(basket, id); emit("remove", { basketChanged: true }); },
    removeBookmarks(ids) { basket = basketModel.removeBookmarks(basket, ids); emit("remove", { basketChanged: true }); },
    suspend() { if (!verified) return; verified = false; emit("suspend"); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { clearNotice(); clearHighlights(); listeners.clear(); },
  });
}
