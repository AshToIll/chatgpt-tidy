// 只持有读取上下文与文档缓存；设置、文件名、预览会话和后台任务属于各自的控制器。
// 调整通知合并时间与传输上限只需改下面的常量，不会改变用户的导出篮容量。
const CURRENT_REFRESH_SETTLE_MS = 400;
// 原生停止按钮可能先于 API 正文就绪；仅明确 pending 才按下面毫秒间隔补读。
// 列表长度就是最多补读次数（不含首次读取）；耗尽后等待手动刷新，不无限轮询。
const RESPONSE_PENDING_RETRY_MS = Object.freeze([400, 1_000, 2_000]);
const RESPONSE_PENDING_CODE = "EXPORT_RESPONSE_PENDING";
const CONVERSATION_READ_BATCH_SIZE = 100;
const BOOKMARK_READ_BATCH_LIMIT = 500;

function conversationId(snapshot) {
  return typeof snapshot?.conversation?.conversationId === "string" ? snapshot.conversation.conversationId : null;
}

function bound(snapshot) {
  return Boolean(conversationId(snapshot) && snapshot?.conversation?.bindingStatus === "bound"
    && snapshot?.conversation?.identityStatus === "stable");
}

function contextKey(snapshot, accountKey) {
  return JSON.stringify([accountKey, conversationId(snapshot), snapshot?.conversation?.identityStatus || "",
    snapshot?.conversation?.bindingStatus || "", snapshot?.route?.pathname || ""]);
}

// 快照只通知全文失效；正文仍通过经过账号校验的读取接口获取。
function contentKey(snapshot) {
  return JSON.stringify([snapshot?.adapter?.responseInProgress === true,
    snapshot?.conversation?.title?.value || "", snapshot?.conversation?.createdAt?.value || "",
    snapshot?.conversation?.updatedAt?.value || "", (snapshot?.messages || []).map(message => [
      message.messageId, message.timestamp?.value || "", message.excerpt?.value || "",
    ])]);
}

function accountKey(value) {
  return typeof value === "string" && value && value === value.trim() ? value : null;
}

// 读取结果在进入控制器时复制并深冻结；不冻结请求方对象，也不把可写正文借给视图。
function ownedFrozen(value) {
  if (value === null || typeof value !== "object") return value;
  const copy = Array.isArray(value) ? value.map(ownedFrozen)
    : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, ownedFrozen(child)]));
  return Object.freeze(copy);
}

/**
 * update 仅提交输入并同步失效边界，不隐式发起读取。宿主在提交选择、设置等输入后，
 * 显式调用 ensureCurrent / ensureBatch，避免 render 回调形成隐式网络循环。
 */
export function createExportContextController({
  requestDocument, requestDocuments, exportApi, exportContract,
  onChanged = () => {}, onInvalidated = () => {},
  rememberCause = notice => notice, translate = key => key,
}) {
  const state = {
    snapshot: null, accountKey: null, scopeVerified: false, active: false, mode: "current",
    contextKey: "", contentKey: "", conversationId: null,
    document: null, documentStale: false, loading: false, loadError: null, currentResponsePending: false,
    batchDocuments: new Map(), batchLoading: false, batchLoadError: null,
    batchRetryable: true, batchFailedTitles: [], batchStaleConversationIds: new Set(),
  };
  let favorites = null, bookmarks = null, basket = { conversations: [], bookmarkIds: [] };
  let sourceKey = "", selectionKey = "", requestKey = "";
  let currentEpoch = 0, batchEpoch = 0, refreshTimer = null;
  // The budget belongs to one response cycle, not to snapshot/render revisions.
  // Hiding, suspension and mode changes revoke work without replenishing it.
  let pendingCycle = null;
  // 保留所有仍在途的上下文，包括 A -> B -> A，确保同一上下文永不叠加全文请求。
  const currentReads = new Map();

  function snapshot() {
    return Object.freeze({ ...state, batchDocuments: new Map(state.batchDocuments),
      batchFailedTitles: [...state.batchFailedTitles],
      batchStaleConversationIds: new Set(state.batchStaleConversationIds) });
  }

  function applyResource({ accountKey: owner, readHandle, resource } = {}) {
    if (!state.scopeVerified || !state.accountKey || owner !== state.accountKey
      || typeof readHandle !== "string" || !readHandle || resource?.type !== "image"
      || resource.pending || !exportContract.validResource(resource)) return false;
    // 只有现存待处理句柄能够被完成。旧账号/旧文档/已经完成的回包不能重新写入。
    const resolved = { ...resource, pending: false };
    delete resolved.readHandle;
    const replacement = ownedFrozen(resolved);
    function replaceResource(document) {
      const resources = document?.conversation?.resources;
      if (!resources?.some(item => item.pending && item.type === "image"
        && item.readHandle === readHandle && item.id === resource.id)) return document;
      // 未变化的图片保留身份，其他并发图片请求不会因为本次更新被无效取消。
      return Object.freeze({ ...document, conversation: Object.freeze({ ...document.conversation,
        resources: Object.freeze(resources.map(item => item.pending && item.type === "image"
          && item.readHandle === readHandle && item.id === resource.id ? replacement : item)),
      }) });
    }
    let changed = false;
    const nextDocument = replaceResource(state.document);
    if (nextDocument !== state.document) { state.document = nextDocument; changed = true; }
    for (const [id, document] of state.batchDocuments) {
      const nextDocument = replaceResource(document);
      if (nextDocument !== document) { state.batchDocuments.set(id, nextDocument); changed = true; }
    }
    if (changed) onChanged();
    return changed;
  }

  function clearRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  function retireCurrent({ clearDocument = false, stale = false, clearError = true } = {}) {
    clearRefresh();
    currentEpoch++;
    state.loading = false;
    if (clearError) state.loadError = null;
    if (clearDocument) state.document = null;
    state.documentStale = stale;
  }

  function retireBatch({ clearDocuments = false, clearError = true } = {}) {
    batchEpoch++;
    state.batchLoading = false;
    if (clearError) {
      state.batchLoadError = null;
      state.batchRetryable = true;
      state.batchFailedTitles = [];
    }
    requestKey = "";
    if (clearDocuments) {
      state.batchDocuments.clear();
      state.batchStaleConversationIds.clear();
    }
  }

  function invalidateBatch({ clearDocuments = false, clearError = false } = {}) {
    retireBatch({ clearDocuments, clearError });
    onInvalidated();
    onChanged();
  }

  function bookmarkItems() {
    return basket.bookmarkIds.map(id => bookmarks?.items?.[id]).filter(Boolean).sort((left, right) => {
      const time = item => Date.parse(item.messageTimestamp || item.bookmarkedAt || "") || 0;
      return time(left) - time(right);
    });
  }

  function selectedConversationIds() {
    return [...new Set([...basket.conversations.map(record => record.conversationId),
      ...bookmarkItems().map(item => item.conversationId)])];
  }

  function batchSourcesReady() {
    return Boolean(state.scopeVerified && state.accountKey
      && basket.conversations.every(record => record.sources.some(source => source === "search"
        ? Boolean(record.searchMetadata?.accountKey)
        : source === "favorites" && favorites?.accountKey === state.accountKey
          && Boolean(favorites?.items?.[record.conversationId])))
      && (!basket.bookmarkIds.length || bookmarks?.accountKey === state.accountKey
        && basket.bookmarkIds.every(id => Boolean(bookmarks?.items?.[id]))));
  }

  function currentReady() {
    return Boolean(state.scopeVerified && state.accountKey && state.document
      && !state.documentStale && !state.loading && !state.currentResponsePending && !state.snapshot?.adapter?.responseInProgress
      && bound(state.snapshot) && state.document.conversation.id === state.conversationId);
  }

  function canReadCurrent() {
    return state.mode === "current" && state.active && state.scopeVerified && state.accountKey
      && bound(state.snapshot) && !state.snapshot?.adapter?.responseInProgress;
  }

  function clearPendingCycle() {
    pendingCycle = null;
    state.currentResponsePending = false;
  }

  function exhaustPendingCycle() {
    pendingCycle.exhausted = true;
    state.currentResponsePending = false;
    state.documentStale = false;
    state.loadError = rememberCause(Object.freeze({ key: "exportInvalidDocument" }), pendingCycle.cause);
  }

  function markResponsePending(error) {
    pendingCycle ||= { attempts: 0, exhausted: false, cause: error };
    state.document = null;
    state.documentStale = false;
    state.loadError = null;
    state.currentResponsePending = !pendingCycle.exhausted;
    onInvalidated();
  }

  function scheduleRefresh() {
    if (refreshTimer !== null) return;
    const epoch = currentEpoch;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (epoch === currentEpoch) void readCurrent({ replace: true });
    }, CURRENT_REFRESH_SETTLE_MS);
  }

  function schedulePendingRead() {
    if (!pendingCycle || !canReadCurrent() || state.loading || currentReads.has(state.contextKey)) return;
    if (pendingCycle.exhausted || pendingCycle.attempts >= RESPONSE_PENDING_RETRY_MS.length) {
      exhaustPendingCycle();
      onChanged();
      return;
    }
    if (refreshTimer !== null) return;
    const epoch = currentEpoch;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (epoch === currentEpoch) void readCurrent({ pendingRetry: true });
    }, RESPONSE_PENDING_RETRY_MS[pendingCycle.attempts]);
  }

  async function ensureCurrent({ force = false } = {}) {
    if (!canReadCurrent() || state.loading || currentReads.has(state.contextKey)) return;
    // Only an explicit user refresh restarts this budget. Timers call readCurrent,
    // never force=true, so continuous DOM/language/layout changes cannot loop it.
    if (force) {
      clearPendingCycle();
      return readCurrent({ replace: true });
    }
    if (state.loadError) return;
    if (pendingCycle) { schedulePendingRead(); return; }
    if (state.documentStale) { scheduleRefresh(); return; }
    if (state.document?.conversation?.id === state.conversationId) return;
    return readCurrent();
  }

  async function readCurrent({ replace = false, pendingRetry = false } = {}) {
    if (!canReadCurrent() || state.loading || currentReads.has(state.contextKey)) return;
    if (pendingRetry) {
      if (!pendingCycle || pendingCycle.exhausted || pendingCycle.attempts >= RESPONSE_PENDING_RETRY_MS.length) return;
      // Charge dispatch, not scheduling: stale in-flight responses cannot grant
      // extra attempts and cancelled timers do not consume network budget.
      pendingCycle.attempts++;
    }
    clearRefresh();
    const ticket = { epoch: ++currentEpoch, contextKey: state.contextKey, contentKey: state.contentKey,
      conversationId: state.conversationId, accountKey: state.accountKey };
    currentReads.set(ticket.contextKey, ticket);
    state.loading = true;
    state.loadError = null;
    if (replace) {
      state.document = null;
      state.documentStale = false;
      onInvalidated();
    }
    const owns = () => currentEpoch === ticket.epoch && canReadCurrent()
      && state.contextKey === ticket.contextKey && state.contentKey === ticket.contentKey;
    onChanged();
    try {
      const document = await requestDocument({
        expectedConversationId: ticket.conversationId, expectedAccountKey: ticket.accountKey,
      });
      if (!owns()) return;
      if (!exportContract.validateDocument(document).valid) throw exportApi.exportError("exportInvalidDocument");
      if (document.conversation.id !== ticket.conversationId) {
        throw Object.assign(new Error(translate("contextChanged")), { code: "CONTEXT_MISMATCH" });
      }
      clearPendingCycle();
      state.document = ownedFrozen(document);
      state.documentStale = false;
    } catch (error) {
      if (!owns()) return;
      if (error?.code === RESPONSE_PENDING_CODE) {
        markResponsePending(error);
      } else {
        clearPendingCycle();
        state.document = null;
        state.documentStale = false;
        state.loadError = rememberCause(ownedFrozen(error?.code === "CONTEXT_MISMATCH" ? { key: "contextChanged" }
          : exportApi.exportErrorDescriptor(error, translate, "exportUnavailable")), error);
      }
    } finally {
      if (currentReads.get(ticket.contextKey) === ticket) currentReads.delete(ticket.contextKey);
      if (owns()) {
        state.loading = false;
        if (pendingCycle) schedulePendingRead();
        onChanged();
      } else if (state.contextKey === ticket.contextKey) {
        // A superseded same-context read must settle before its replacement;
        // pending recovery still owns its original finite budget.
        void ensureCurrent();
      }
    }
  }

  // Capture the read owner's fence before JOB_START. A definitely unadmitted
  // write can invalidate only the preview that produced it, never a new route,
  // account, mode, or a same-account suspension/route A-B-A replacement.
  function captureResponsePending() {
    const ticket = { currentEpoch, batchEpoch, contextKey: state.contextKey, contentKey: state.contentKey,
      accountKey: state.accountKey, mode: state.mode };
    return () => {
      if (!state.active || !state.scopeVerified || state.accountKey !== ticket.accountKey
        || state.mode !== ticket.mode || currentEpoch !== ticket.currentEpoch
        || state.contextKey !== ticket.contextKey || state.contentKey !== ticket.contentKey
        || (state.mode === "batch" && batchEpoch !== ticket.batchEpoch)) return false;
      if (state.mode === "batch") {
        retireBatch({ clearDocuments: true });
        state.batchLoadError = Object.freeze({ key: "exportInvalidDocument" });
        state.batchRetryable = true;
        onInvalidated();
      } else {
        retireCurrent({ clearDocument: true });
        markResponsePending();
        schedulePendingRead();
      }
      onChanged();
      return true;
    };
  }

  async function ensureBatch({ force = false } = {}) {
    if (state.mode !== "batch" || !state.active || !state.scopeVerified || !state.accountKey || state.batchLoading) return;
    if (!force && (state.batchLoadError || state.batchStaleConversationIds.size)) return;
    const ids = selectedConversationIds();
    if (!ids.length) { state.batchLoadError = null; requestKey = ""; onChanged(); return; }
    if (!batchSourcesReady()) {
      state.batchLoadError = Object.freeze({ key: "exportSourcesUnavailable" });
      state.batchRetryable = true;
      onChanged();
      return;
    }
    const expectedAccountKey = state.accountKey;
    const nextRequestKey = JSON.stringify([expectedAccountKey, sourceKey, selectionKey]);
    if (!force && requestKey === nextRequestKey && ids.every(id => state.batchDocuments.has(id))) return;
    const epoch = ++batchEpoch;
    state.batchLoading = true;
    state.batchLoadError = null;
    state.batchRetryable = true;
    state.batchFailedTitles = [];
    if (force) {
      state.batchStaleConversationIds.clear();
      for (const id of ids) state.batchDocuments.delete(id);
      onInvalidated();
    }
    const owns = () => epoch === batchEpoch && state.mode === "batch" && state.active
      && state.scopeVerified && state.accountKey === expectedAccountKey;
    onChanged();
    try {
      const searchRecords = basket.conversations.filter(record => record.sources.includes("search"));
      const searchOwners = new Set(searchRecords.map(record => record.searchMetadata?.accountKey));
      if (searchRecords.length && (searchOwners.size !== 1 || ![...searchOwners][0])) {
        throw new Error(translate("exportBatchUnavailable"));
      }
      const items = bookmarkItems();
      const titles = Object.fromEntries(ids.map(id => [id, favorites?.items?.[id]?.title
        || basket.conversations.find(record => record.conversationId === id)?.searchMetadata?.title
        || items.find(item => item.conversationId === id)?.conversationTitle || ""]));
      const batches = [], missingIds = ids.filter(id => !state.batchDocuments.has(id));
      for (let offset = 0; offset < missingIds.length; offset += CONVERSATION_READ_BATCH_SIZE) {
        const conversationIds = missingIds.slice(offset, offset + CONVERSATION_READ_BATCH_SIZE);
        const members = new Set(conversationIds);
        const bookmarkIds = basket.bookmarkIds.filter(id => members.has(bookmarks?.items?.[id]?.conversationId));
        if (bookmarkIds.length > BOOKMARK_READ_BATCH_LIMIT) throw exportApi.exportError("exportTooManyBookmarks");
        const searchIds = searchRecords.map(record => record.conversationId).filter(id => members.has(id));
        batches.push({ expectedTabId: null, expectedAccountKey, conversationIds, bookmarkIds,
          fallbackTitles: Object.fromEntries(conversationIds.map(id => [id, titles[id]])),
          // UI 元数据不是授权；worker 仍要校验账号范围内的搜索目录。
          ...(searchIds.length ? { searchSelection: {
            accountKey: [...searchOwners][0], conversationIds: searchIds,
          } } : {}),
        });
      }
      // 所有分块先写入临时集合：失败/取消不发布部分文档，也不派发下一个分块。
      const received = new Map();
      for (const batch of batches) {
        if (!owns()) return;
        state.batchFailedTitles = batch.conversationIds.map(id => titles[id]);
        const collection = await requestDocuments(batch);
        if (!owns()) return;
        if (!exportContract.validateCollection(collection).valid) throw exportApi.exportError("exportInvalidDocument");
        const documents = new Map(collection.documents.map(document => [document.conversation.id, document]));
        if (documents.size !== batch.conversationIds.length || batch.conversationIds.some(id => !documents.has(id))) {
          throw new Error(translate("exportBatchUnavailable"));
        }
        for (const [id, document] of documents) received.set(id, ownedFrozen(document));
      }
      if (!owns()) return;
      for (const [id, document] of received) state.batchDocuments.set(id, document);
      requestKey = nextRequestKey;
      state.batchFailedTitles = [];
    } catch (error) {
      if (!owns()) return;
      if (error?.code === RESPONSE_PENDING_CODE) {
        // Never keep a partial/cached export selection after a positive pending
        // response. Batch recovery is intentionally explicit, not a timer loop.
        state.batchDocuments.clear();
        state.batchStaleConversationIds.clear();
        requestKey = "";
        onInvalidated();
      }
      state.batchLoadError = rememberCause(ownedFrozen(error?.code === RESPONSE_PENDING_CODE
        ? { key: "exportInvalidDocument" } : exportApi.exportErrorDescriptor(error, translate, "exportBatchUnavailable")), error);
      state.batchRetryable = error?.exportMessageKey !== "exportTooManyBookmarks";
    } finally {
      if (owns()) { state.batchLoading = false; onChanged(); }
    }
  }

  function update({ snapshot: nextSnapshot = null, accountKey: owner, verified = true,
    active = false, mode = "current", sources = {} } = {}) {
    const nextAccount = accountKey(owner);
    const accountChanged = nextAccount !== state.accountKey;
    const nextVerified = Boolean(verified && nextAccount);
    const suspended = state.scopeVerified && !nextVerified;
    const hidden = state.active && !active;
    const modeChanged = state.mode !== mode;
    const nextContext = contextKey(nextSnapshot, nextAccount);
    const nextContent = contentKey(nextSnapshot);
    const contextChanged = nextContext !== state.contextKey;
    const contentChanged = !contextChanged && nextContent !== state.contentKey;
    const responseSettled = !contextChanged && state.snapshot?.adapter?.responseInProgress === true
      && nextSnapshot?.adapter?.responseInProgress === false;
    const nextFavorites = sources.favorites?.accountKey === nextAccount ? sources.favorites : null;
    const nextBookmarks = sources.bookmarks?.accountKey === nextAccount ? sources.bookmarks : null;
    // 仓储发布修订号；未提供修订号的快照以内容比较，避免 DTO 新对象造成无效取消。
    const repositoryKey = repository => repository
      ? [repository.accountKey, repository.revision ?? repository.items] : null;
    const nextSourceKey = JSON.stringify([repositoryKey(nextFavorites), repositoryKey(nextBookmarks)]);
    const nextBasket = sources.basket || { conversations: [], bookmarkIds: [] };
    const nextSelectionKey = JSON.stringify(nextBasket);
    const sourcesChanged = nextSourceKey !== sourceKey;
    const selectionChanged = nextSelectionKey !== selectionKey;

    Object.assign(state, { snapshot: ownedFrozen(nextSnapshot), accountKey: nextAccount, scopeVerified: nextVerified,
      active: Boolean(active), mode, contextKey: nextContext, contentKey: nextContent,
      conversationId: conversationId(nextSnapshot) });
    favorites = nextFavorites;
    bookmarks = nextBookmarks;
    // 选择属于 selection controller；此处只持有其值快照，不能反向修改导出篮。
    basket = { conversations: nextBasket.conversations.map(record => ({ ...record, sources: [...record.sources],
      ...(record.searchMetadata ? { searchMetadata: { ...record.searchMetadata } } : {}) })),
    bookmarkIds: [...nextBasket.bookmarkIds] };
    sourceKey = nextSourceKey;
    selectionKey = nextSelectionKey;

    let invalidated = false;
    if (accountChanged || sourcesChanged || suspended) {
      retireBatch({ clearDocuments: true });
      invalidated = true;
    } else if (selectionChanged || modeChanged || hidden) {
      // 隐藏/返回只是可见性变化，不能抹掉已确认失败并偷偷重试。
      retireBatch({ clearError: selectionChanged || modeChanged });
      invalidated = true;
    }
    const selected = new Set(selectedConversationIds());
    for (const id of state.batchDocuments.keys()) if (!selected.has(id)) state.batchDocuments.delete(id);
    for (const id of state.batchStaleConversationIds) if (!selected.has(id)) state.batchStaleConversationIds.delete(id);
    if (contextChanged) {
      clearPendingCycle();
      retireCurrent({ clearDocument: true });
      invalidated = true;
    } else if (contentChanged) {
      // Keep an already scheduled pending deadline through DOM-content churn.
      // The timer reads the newest snapshot at dispatch; the resulting request
      // still receives its own content fence. Native busy cancels that timer.
      if (!pendingCycle || state.snapshot?.adapter?.responseInProgress) clearRefresh();
      if (state.document || state.loading || state.documentStale) {
        retireCurrent({ clearDocument: true, stale: !pendingCycle, clearError: !pendingCycle });
      }
      if (selected.has(state.conversationId)
        && (state.batchDocuments.has(state.conversationId) || state.batchLoading)) {
        state.batchStaleConversationIds.add(state.conversationId);
        retireBatch();
      }
      invalidated = true;
    }
    if (responseSettled) {
      const stale = Boolean(pendingCycle || state.documentStale || state.document || state.loading);
      clearPendingCycle();
      retireCurrent({ clearDocument: true, stale });
      invalidated = true;
    }
    if (suspended || hidden || modeChanged) {
      const stale = state.documentStale || state.loading || (suspended && Boolean(state.document));
      retireCurrent({ clearDocument: suspended, stale: pendingCycle ? false : stale, clearError: !pendingCycle && (suspended || modeChanged) });
      invalidated = true;
    }
    if (invalidated) onInvalidated();
    onChanged();
  }

  function suspend() {
    if (state.scopeVerified) {
      state.scopeVerified = false;
      retireCurrent({ clearDocument: true, stale: !pendingCycle && Boolean(state.document || state.loading || state.documentStale), clearError: !pendingCycle });
      retireBatch({ clearDocuments: true });
      onInvalidated();
    }
    onChanged();
  }

  return Object.freeze({ update, snapshot, suspend, invalidateBatch, ensureCurrent, ensureBatch,
    currentReady, batchSourcesReady, selectedConversationIds, applyResource, captureResponsePending });
}
