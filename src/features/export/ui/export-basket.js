// 导出篮只做内存状态转换：勾选、合并来源、去重和删除，不读网络或持久化。
// 账号校验、异步结果是否过期以及界面刷新由 export-view 负责。
// 不修改调用方传入的对象；未变化的条目可以在新旧状态间共用。
export function emptyBasket() {
  return { conversations: [], bookmarkIds: [] };
}

export function emptyDraft(source = null) {
  return { source, conversationIds: [], bookmarkIds: [] };
}

const draftKey = source => source === "bookmarks" ? "bookmarkIds" : "conversationIds";

export function count(basket) {
  return basket.conversations.length + basket.bookmarkIds.length;
}

export function searchCandidateSelectable(basket, searchCandidates, id) {
  return searchCandidates.has(id)
    && !basket.conversations.some(record => record.conversationId === id && record.sources.includes("search"));
}

export function toggleDraft(draft, id) {
  const key = draftKey(draft.source), values = draft[key];
  return { ...draft, [key]: values.includes(id) ? values.filter(value => value !== id) : [...values, id] };
}

export function selectDraftRange(basket, draft, ids, searchCandidates) {
  const source = draft.source, key = draftKey(source), existing = draft[key];
  const included = source === "bookmarks" ? new Set(basket.bookmarkIds)
    : new Set(basket.conversations.filter(record => record.sources.includes(source)).map(record => record.conversationId));
  const selectable = [...new Set((Array.isArray(ids) ? ids : [])
    .filter(id => typeof id === "string" && id && !included.has(id)
      && (source !== "search" || searchCandidates.has(id))))];
  const allSelected = selectable.length > 0 && selectable.every(id => existing.includes(id));
  return { ...draft, [key]: allSelected
    ? existing.filter(id => !selectable.includes(id))
    : [...new Set([...existing, ...selectable])] };
}

export function submitDraft(basket, draft, { favorites, bookmarks, searchCandidates }) {
  const source = draft.source, selected = draft[draftKey(source)];
  const conversations = [...basket.conversations], bookmarkIds = [...basket.bookmarkIds];
  const addedConversationIds = [], addedBookmarkIds = [];
  let sourceUpdated = 0;
  if (source === "bookmarks") {
    for (const id of selected) {
      if (bookmarkIds.includes(id) || !bookmarks?.items?.[id]) continue;
      bookmarkIds.push(id);
      addedBookmarkIds.push(id);
    }
  } else {
    for (const id of selected) {
      const searchMetadata = source === "search" ? searchCandidates.get(id) : null;
      if (source === "search" ? !searchMetadata : !favorites?.items?.[id]) continue;
      const index = conversations.findIndex(record => record.conversationId === id);
      if (index !== -1) {
        const existing = conversations[index];
        const newSource = !existing.sources.includes(source);
        if (newSource) sourceUpdated += 1;
        conversations[index] = { ...existing,
          sources: newSource ? [...existing.sources, source] : existing.sources,
          ...(searchMetadata ? { searchMetadata: { ...searchMetadata } } : {}),
        };
      } else {
        conversations.push({ conversationId: id, sources: [source],
          // Candidate lifetime ends with its picker. Keep only its validated
          // metadata values, never the candidate object itself.
          ...(searchMetadata ? { searchMetadata: { ...searchMetadata } } : {}),
        });
        addedConversationIds.push(id);
      }
    }
  }
  return { basket: { conversations, bookmarkIds },
    added: addedConversationIds.length + addedBookmarkIds.length,
    sourceUpdated, addedConversationIds, addedBookmarkIds };
}

export function reconcile(basket, draft, { favorites, bookmarks }) {
  // null is a failed/unavailable source, not an empty successful snapshot.
  // Remove only proven missing membership; another source can retain the same
  // conversation. Cached documents and request invalidation stay in the view.
  const favoriteIds = favorites ? new Set(Object.keys(favorites.items || {})) : null;
  const bookmarkIds = bookmarks ? new Set(Object.keys(bookmarks.items || {})) : null;
  let nextBasket = basket, nextDraft = draft;
  if (favoriteIds) {
    nextBasket = { ...nextBasket, conversations: basket.conversations
      .map(record => ({ ...record, sources: record.sources.filter(source => source !== "favorites" || favoriteIds.has(record.conversationId)) }))
      .filter(record => record.sources.length) };
    if (draft.source === "favorites") nextDraft = { ...nextDraft,
      conversationIds: draft.conversationIds.filter(id => favoriteIds.has(id)) };
  }
  if (bookmarkIds) {
    nextBasket = { ...nextBasket, bookmarkIds: basket.bookmarkIds.filter(id => bookmarkIds.has(id)) };
    nextDraft = { ...nextDraft, bookmarkIds: draft.bookmarkIds.filter(id => bookmarkIds.has(id)) };
  }
  return { basket: nextBasket, draft: nextDraft };
}

export function removeConversation(basket, conversationId) {
  return { ...basket, conversations: basket.conversations.filter(record => record.conversationId !== conversationId) };
}

export function removeBookmarks(basket, ids) {
  const removed = new Set(ids);
  return { ...basket, bookmarkIds: basket.bookmarkIds.filter(id => !removed.has(id)) };
}
