import { createKeywordSearch } from "./keyword-search.js";
import { createSearchErrorSlot } from "./search-error-slot.js";

const searchContract = globalThis.TidySearch;
const dateContract = globalThis.TidyDateSearch;
// Product parameters: network batch size is deliberately independent of UI size.
const KEYWORD_PAGE_SIZES = Object.freeze([10, 15, 20, 30, 60]);
const KEYWORD_DEFAULT_CAPACITY = 10;

// The only writer of search criteria, pages and asynchronous read ownership.
// DOM events send intentions; the view receives snapshots, never this object.
export function createSearchQueryController({ onAction, onChange = () => {}, onInteraction = () => {},
  onNoticeClear = () => {}, cancelNavigation = () => {}, onCalendarClose = () => {},
  onExportSourcesChange = () => {}, initiallyVisible = true }) {
  const state = {
    mode: "keyword", dateField: "createdAt", sortField: "createdAt",
    query: "", startDate: "", endDate: "", dateError: false,
    sortDirection: "desc", sessionId: null, pages: [], page: 1, pageSize: KEYWORD_DEFAULT_CAPACITY,
    cursor: null, hasMore: false, loading: false, searched: false, error: false,
    generation: 0, activeResultId: null, scrollTop: 0, tabId: null, conversationId: null,
    timeZone: "UTC", indexStatus: null, resultStatus: null,
    active: false, visible: initiallyVisible,
    catalogRefreshing: false, keywordRefreshing: false, keywordStatus: null,
    keywordPageSize: "auto", keywordAutoSize: KEYWORD_DEFAULT_CAPACITY,
    datePageSize: searchContract.PAGE_SIZE_OPTIONS[0], dateAccountKey: null,
  };

  let debounceTimer = null;
  let refreshPending = false;
  let refreshQueued = false;
  let dateRefreshOperation = null;
  let catalogRefreshOperation = null;
  let statusRenderQueued = false;
  let composing = false;
  let keywordReadEpoch = 0;
  let catalogFailureSeen = 0;
  let sourceFingerprint = "";
  const notices = createSearchErrorSlot({ readContext: () => ({ mode: state.mode, active: state.active, visible: state.visible }), onClear: onNoticeClear });
  const currentItems = () => state.pages[state.page - 1] || [];

  // Event/calendar/layout readers never clone accumulated results. Only paint
  // asks for the complete detached projection; individual clicks read one row.
  function readContext() {
    return Object.freeze({ mode: state.mode, active: state.active, visible: state.visible,
      query: state.query, composing, page: state.page, scrollTop: state.scrollTop, sortDirection: state.sortDirection,
      keywordAutoSize: state.keywordAutoSize, keywordComplete: state.keywordStatus?.complete === true });
  }
  function readDateSelection() {
    return Object.freeze({ startDate: state.startDate, endDate: state.endDate, timeZone: state.timeZone });
  }
  function findResult({ resultId, conversationId } = {}) {
    const items = state.mode === "keyword" ? state.keywordStatus?.items || [] : state.pages.flat();
    const item = items.find(candidate => resultId ? candidate.resultId === resultId : candidate.conversationId === conversationId);
    return item ? Object.freeze({ ...item }) : null;
  }
  function snapshot() {
    // Structured cloning protects every nested page/status from consumers.
    // Error notice identity remains private to the slot; consumers only read it.
    return Object.freeze({ ...structuredClone(state), composing,
      range: criteria(), pageOptions: keywordPageOptions(), errorNotice: notices.current() });
  }
  function publish() { publishSources(); onChange(); }
  function publishSources() {
    const items = exportItems();
    const fingerprint = JSON.stringify(items);
    if (fingerprint === sourceFingerprint) return;
    sourceFingerprint = fingerprint;
    onExportSourcesChange(items);
  }
  function beginInteraction() { notices.invalidate(); onInteraction(); }
  function synchronizePageSize() {
    state.pageSize = state.mode === "date" ? state.datePageSize
      : state.keywordPageSize === "auto" ? state.keywordAutoSize : state.keywordPageSize;
  }
  const keywordSearch = createKeywordSearch({
    fetchPage: (payload) => {
      // 绑定真实读请求，不绑定 loading 外观；隐藏后恢复仍可能等待同一旧请求。
      keywordReadEpoch = notices.epoch();
      return onAction("query", payload);
    },
    createSessionId: () => searchContract.createSessionId(),
    onChange: acceptKeywordSnapshot,
  });


  function exportItems() {
    // Only current, readable directory rows can enter the picker. Raw keyword
    // hits and detached controls from a superseded date query are never sources.
    const range = criteria();
    if (state.mode !== "date" || state.loading || state.error || !range.valid || !range.hasDate
      || !state.dateAccountKey) return [];
    return currentItems().filter((item) => item.source === "conversation"
      && item.matchKind === "conversation-date" && item.messageId === null
      && typeof item.conversationId === "string" && item.conversationId.trim()
      && item.conversationId === item.conversationId.trim())
      .map((item) => ({ ...item, accountKey: state.dateAccountKey }));
  }

  function criteria() {
    try {
      const range = dateContract.searchDateRange({
        startDate: state.startDate,
        endDate: state.endDate,
        timeZone: state.timeZone,
      });
      return { ...range, valid: true };
    } catch (error) {
      return { hasDate: Boolean(state.startDate || state.endDate), valid: false,
        errorKey: error?.code === "SEARCH_DATE_OUT_OF_BOUNDS" ? "searchDateBoundsError" : "searchDateRangeError" };
    }
  }

  function activeDateOnly() {
    const range = criteria();
    return state.mode === "date" && state.active && state.visible && range.valid
      && range.hasDate && state.searched && Boolean(state.sessionId);
  }

  function pause(reason, { preserveNavigation = false, invalidateReads = false } = {}) {
    if (!preserveNavigation) cancelNavigation(reason);
    // Pause stops dispatch synchronously; draining already-started reads is
    // owned by the service and must not block typing or navigation.
    keywordSearch.pause({ invalidateInFlight: invalidateReads });
    void Promise.resolve(onAction("pause", { reason })).catch(() => {});
  }

  function invalidateCriteria(reason) {
    beginInteraction();
    // Reset before pausing: publishing the old run's paused snapshot here
    // would replace the input DOM in the middle of an IME composition.
    keywordSearch.reset();
    pause(reason);
    clearTimeout(debounceTimer);
    state.generation += 1;
    // Each mode has an independent query contract. Never render results from
    // an earlier mode or criteria while the next debounced request is pending.
    Object.assign(state, {
      sessionId: null, pages: [], page: 1, cursor: null, hasMore: false,
      loading: false, searched: false, error: false, dateError: false,
      activeResultId: null, scrollTop: 0,
      indexStatus: null, resultStatus: null,
      keywordStatus: null, catalogRefreshing: false, keywordRefreshing: false, dateAccountKey: null,
    });
    refreshPending = false;
    publishSources();
  }

  function resumeDateOnly() {
    if (!activeDateOnly()) return;
    void Promise.resolve(onAction("resume")).catch(() => {});
    queueDateRefresh();
  }

  function paginateKeywordItems(items) {
    state.pages = [];
    for (let index = 0; index < items.length; index += state.pageSize) state.pages.push(items.slice(index, index + state.pageSize));
    if (!state.pages.length) state.pages = [[]];
    state.page = Math.max(1, Math.min(state.page, state.pages.length));
  }

  function acceptKeywordSnapshot(snapshot) {
    if (state.mode !== "keyword" || !snapshot.sessionId || snapshot.query !== state.query.trim()) return;
    if (state.sessionId !== snapshot.sessionId) {
      state.page = 1;
      state.scrollTop = 0;
      state.activeResultId = null;
    }
    const previous = state.keywordStatus;
    if (snapshot.error) {
      // 一个失败快照可因暂停/布局再次发布；只有新的失败过程才拥有一次提醒。
      if (!previous?.error || previous.sessionId !== snapshot.sessionId) {
        notices.show(snapshot.error, "keyword", keywordReadEpoch);
      }
    } else notices.clear("keyword");
    state.keywordStatus = snapshot;
    state.sessionId = snapshot.sessionId;
    state.loading = snapshot.phase === "loading";
    if (snapshot.phase === "complete" || snapshot.phase === "error") state.keywordRefreshing = false;
    state.searched = true;
    state.error = snapshot.error;
    state.cursor = snapshot.cursor;
    state.hasMore = snapshot.hasMore;
    state.resultStatus = { total: snapshot.total, resultStable: snapshot.complete,
      coverageState: snapshot.complete ? "complete" : "partial" };
    paginateKeywordItems(snapshot.items);
    if (state.active && state.visible) publish();
  }

  function keywordPageOptions() {
    return [...new Set([state.keywordAutoSize, ...KEYWORD_PAGE_SIZES.filter((size) => size > state.keywordAutoSize),
      ...(state.keywordPageSize === "auto" ? [] : [state.keywordPageSize])])].sort((a, b) => a - b);
  }

  function queryPayload(cursor) {
    // Only the date view uses this payload. Keyword requests belong to their
    // own session and never inherit date predicates or display page sizes.
    const common = { mode: state.mode, cursor, sessionId: state.sessionId, limit: state.pageSize };
    const range = criteria();
    return {
      ...common,
      query: "",
      dateField: state.dateField,
      sortField: state.sortField,
      startMs: range.startMs,
      endMs: range.endMs,
      hasDate: range.hasDate,
      direction: state.sortDirection,
      timeZone: state.timeZone,
    };
  }

  function acceptDateResultStatus(page) {
    // Date refreshes replace one catalog snapshot; they never accumulate
    // native keyword pagination state or carry errors from an older snapshot.
    const readErrors = page.readErrors || [];
    const partial = page.partialResults || page.coverageState === "partial";
    state.dateAccountKey = typeof page.accountKey === "string" && page.accountKey.trim() ? page.accountKey : null;
    state.resultStatus = {
      phase: page.catalogPhase, revision: page.catalogRevision, resultStable: page.resultStable === true,
      coverageState: partial || readErrors.length ? "partial" : "complete",
      total: Number.isInteger(page.total) && page.total >= 0 ? page.total : null,
      progress: { discovered: page.total ?? page.items.length, failed: readErrors.length }, readErrors,
    };
  }

  async function loadFirstPage({ manualRefresh = false } = {}) {
    if (!state.active || !state.visible) return;
    clearTimeout(debounceTimer);
    synchronizePageSize();
    const query = state.query.trim();
    const range = state.mode === "date" ? criteria() : { valid: true, hasDate: false };
    const generation = ++state.generation;
    const noticeEpoch = notices.epoch();
    const priorNotice = notices.current();
    keywordSearch.reset();
    state.dateError = !range.valid;
    if ((state.mode === "keyword" ? !query : !range.hasDate) || !range.valid) {
      Object.assign(state, { sessionId: null, pages: [], page: 1, cursor: null, hasMore: false,
        searched: false, loading: false, error: false, keywordStatus: null, keywordRefreshing: false });
      publish();
      return;
    }
    Object.assign(state, {
      sessionId: searchContract.createSessionId(), pages: [], page: 1, cursor: null,
      hasMore: false, loading: true, searched: true, error: false, scrollTop: 0, resultStatus: null,
      keywordStatus: null, catalogRefreshing: false, keywordRefreshing: state.mode === "keyword" && manualRefresh,
    });
    if (state.mode === "date") state.indexStatus = null;
    else state.activeResultId = null;
    publish();
    if (state.mode === "keyword") {
      try {
        return await keywordSearch.start(query);
      } catch (error) {
        // Validate programmatic input as well as the input's maxLength. A
        // rejected start must not strand the refresh control in a busy state.
        if (generation !== state.generation) return;
        state.error = globalThis.TidyLibraryHydration.normalizeError(error, { fallbackCode: "SEARCH_QUERY_INVALID" });
        state.loading = false;
        state.keywordRefreshing = false;
        notices.show(state.error, "keyword", noticeEpoch);
        publish();
        return;
      }
    }
    try {
      const page = await onAction("query", queryPayload(null));
      if (generation !== state.generation) return;
      state.pages = [page.items];
      notices.clear("date-query", priorNotice);
      acceptDateResultStatus(page);
      state.cursor = page.cursor;
      state.hasMore = page.hasMore;
    } catch (error) {
      // Route/visibility cancellation is not a read failure. The service stops
      // before starting another directory read; finally still clears loading.
      if (generation !== state.generation || error?.code === "CANCELLED") return;
      state.error = globalThis.TidyLibraryHydration.normalizeError(error, { fallbackCode: "SEARCH_UNAVAILABLE" });
      state.pages = [];
      notices.show(state.error, "date-query", noticeEpoch);
    } finally {
      if (generation !== state.generation) return;
      state.loading = false;
      publish();
      if (refreshPending) queueDateRefresh();
    }
  }

  async function loadNextPage() {
    if (!state.active || !state.visible || (state.mode === "date" && state.loading)) return;
    if (state.page < state.pages.length) {
      state.page += 1;
      state.scrollTop = 0;
      publish();
      return;
    }
    // Native fetching runs independently. Reading a page never initiates or
    // waits on network work, including while the total is still increasing.
    if (state.mode === "keyword") return;
    if (!state.hasMore || !state.cursor) return;
    if (activeDateOnly()) {
      // Date offsets belong to one cache snapshot. Read a larger prefix for a
      // next page instead of appending rows from a newer snapshot to old pages.
      state.page += 1;
      state.generation += 1;
      queueDateRefresh();
      return;
    }
  }

  async function refreshDateResults() {
    if (!activeDateOnly() || state.loading || dateRefreshOperation) return;
    const generation = state.generation;
    const limit = Math.max(state.page, state.pages.length, 1) * state.pageSize;
    const operation = {};
    const noticeEpoch = notices.epoch();
    const priorNotice = notices.current();
    dateRefreshOperation = operation;
    refreshPending = false;
    try {
      const page = await onAction("query", { ...queryPayload(null), refresh: true, limit });
      if (generation !== state.generation || !activeDateOnly()) return;
      // Refresh a single cache prefix, then re-slice it. Appending old offset
      // pages would mix snapshots as newer matches move through the sort order.
      state.pages = [];
      for (let index = 0; index < page.items.length; index += state.pageSize) {
        state.pages.push(page.items.slice(index, index + state.pageSize));
      }
      if (!state.pages.length) state.pages = [[]];
      state.page = Math.min(state.page, state.pages.length);
      state.cursor = page.cursor;
      state.hasMore = page.hasMore;
      state.error = false;
      notices.clear("date-query", priorNotice);
      acceptDateResultStatus(page);
      publish();
    } catch (error) {
      if (generation === state.generation && error?.code !== "CANCELLED") {
        // A cache-refresh failure cannot discard still-clickable prior results.
        state.error = globalThis.TidyLibraryHydration.normalizeError(error, { fallbackCode: "SEARCH_UNAVAILABLE" });
        notices.show(state.error, "date-query", noticeEpoch);
        publish();
      }
    } finally {
      // 文档切换可启动新读；旧 finally 只能释放自己，不能解除新读的单飞锁。
      if (dateRefreshOperation === operation) {
        dateRefreshOperation = null;
        if (refreshPending) queueDateRefresh();
      }
    }
  }

  function queueDateRefresh() {
    refreshPending = true;
    if (!activeDateOnly() || state.loading || dateRefreshOperation || refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      if (refreshPending && activeDateOnly() && !state.loading && !dateRefreshOperation) void refreshDateResults();
    });
  }

  function scheduleSearch(delay = 350) {
    if (composing || !state.active || !state.visible) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void loadFirstPage(), delay);
  }

  async function refreshCatalog() {
    if (state.mode !== "date" || !state.sessionId || state.catalogRefreshing || !state.active || !state.visible) return;
    // Sorting/paging may change the view generation while this refresh keeps
    // running. Only a new search session can supersede its busy indicator.
    const sessionId = state.sessionId;
    const operation = {};
    const noticeEpoch = notices.epoch();
    catalogRefreshOperation = operation;
    state.catalogRefreshing = true;
    state.error = false;
    publish();
    try {
      // Only this explicit command refreshes a settled directory. Date-field,
      // range and sort changes continue querying the shared local catalog.
      await onAction("refresh-catalog");
    } catch (error) {
      if (catalogRefreshOperation === operation && sessionId === state.sessionId && error?.code !== "CANCELLED") {
        state.error = globalThis.TidyLibraryHydration.normalizeError(error, { fallbackCode: "SEARCH_UNAVAILABLE" });
        // 随后的本地缓存查询成功，不等于刚刚失败的目录刷新已经恢复。
        notices.show(state.error, "date-refresh", noticeEpoch);
      }
    } finally {
      if (catalogRefreshOperation === operation) {
        catalogRefreshOperation = null;
        if (sessionId === state.sessionId) { state.catalogRefreshing = false; queueDateRefresh(); publish(); }
      }
    }
  }

  function setIndexStatus(status) {
    if (state.mode !== "date" || !state.sessionId) return;
    if (status?.sessionId && state.sessionId && status.sessionId !== state.sessionId) return;
    const revisionBefore = state.indexStatus?.revision;
    const phaseBefore = state.indexStatus?.phase || null;
    state.indexStatus = status;
    const failure = status?.failureNotice;
    if (Number.isSafeInteger(failure?.id) && failure.id > catalogFailureSeen) {
      catalogFailureSeen = failure.id;
      notices.show(failure.error, "date-catalog", notices.epoch(),
        { revision: status.revision, accountKey: status.accountKey });
    } else if (notices.current()?.channel === "date-catalog" && status?.resultStable === true
      && status.phase === "settled" && !status.readErrors?.length
      && status.accountKey === notices.current().evidence?.accountKey
      && status.revision > notices.current().evidence?.revision) {
      // 只有同账号、更新检查点的完整成功才能清除本次目录提醒；旧缓存不是恢复证明。
      notices.clear("date-catalog");
    }
    if (state.active && state.visible && !statusRenderQueued) {
      statusRenderQueued = true;
      queueMicrotask(() => {
        statusRenderQueued = false;
        if (state.active && state.visible) publish();
      });
    }
    if (!activeDateOnly()) return;
    const changed = status?.revision !== revisionBefore || status?.phase !== phaseBefore;
    if (changed) queueDateRefresh();
  }

  function setActive(active, { preserveNavigation = false, invalidateReads = false } = {}) {
    const next = Boolean(active);
    if (!next && invalidateReads) {
      // 浏览器已更换文档，旧读失去 UI 所有权；结果/条件不清空，新文档从原位置接续。
      dateRefreshOperation = null;
      catalogRefreshOperation = null;
      state.catalogRefreshing = false;
    }
    if (state.active === next) {
      // 文档可能在搜索已隐藏时被替换；仍须撤销旧桥接读，普通隐藏则不丢成功页。
      if (!next && invalidateReads) keywordSearch.pause({ invalidateInFlight: true });
      return;
    }
    state.active = next;
    if (!next) {
      if (preserveNavigation) {
        // 文档重握手不是用户另开操作：撤销旧读取提醒，保留已授权 OPEN 的回执权限。
        notices.invalidate();
      } else beginInteraction();
      clearTimeout(debounceTimer);
      state.generation += 1;
      // 已撤销的首屏请求不能继续占用 busy；恢复时按原查询读取，不等待旧文档。
      state.loading = false;
      // A full page navigation pauses search reads, but its already-authorized
      // OPEN stays owned by the worker's exact intent until the new page is ready.
      pause("route-away", { preserveNavigation, invalidateReads });
    } else {
      resumeDateOnly();
      resumeKeyword();
    }
  }

  function setVisible(visible) {
    const next = Boolean(visible);
    if (state.visible === next) return;
    state.visible = next;
    if (!next) {
      beginInteraction();
      clearTimeout(debounceTimer);
      pause("hidden");
    } else {
      resumeDateOnly();
      resumeKeyword();
    }
  }

  function resumeKeyword() {
    if (state.mode !== "keyword" || !state.active || !state.visible) return;
    if (state.keywordStatus?.sessionId) keywordSearch.resume();
    else if (state.query.trim()) scheduleSearch(0);
    publish();
  }

  function setTabId(tabId, { renderNow = true } = {}) {
    const nextTabId = Number.isInteger(tabId) && tabId >= 0 ? tabId : null;
    if (state.tabId === nextTabId) return;
    beginInteraction();
    keywordSearch.reset();
    pause("tab-changed");
    state.tabId = nextTabId;
    state.generation += 1;
    clearTimeout(debounceTimer);
    refreshPending = false;
    Object.assign(state, {
      sessionId: null, pages: [], page: 1, cursor: null, hasMore: false, loading: false,
      searched: false, error: false, activeResultId: null, conversationId: null, scrollTop: 0, resultStatus: null,
      indexStatus: null,
      keywordStatus: null, catalogRefreshing: false, keywordRefreshing: false, dateAccountKey: null,
    });
    onCalendarClose();
    publishSources();
    if (renderNow) publish();
  }

  function changeQuery(value) {
    if (state.mode !== "keyword") return;
    invalidateCriteria("keyword-input");
    state.query = value;
    publishSources();
    scheduleSearch();
  }
  function setComposing(value) {
    composing = Boolean(value);
    if (composing && state.mode === "keyword") invalidateCriteria("keyword-input");
    else scheduleSearch();
  }
  function changeMode(mode) {
    if (!["keyword", "date"].includes(mode) || mode === state.mode) return;
    invalidateCriteria("mode-changed");
    state.mode = mode;
    synchronizePageSize();
    onCalendarClose();
    publish();
    scheduleSearch(0);
  }
  function changeDateRange(range) {
    invalidateCriteria("date-changed");
    state.startDate = range.startDate;
    state.endDate = range.endDate;
    publishSources();
    scheduleSearch(0);
  }
  function changeDateField(field) {
    if (state.mode !== "date" || !["createdAt", "updatedAt"].includes(field) || field === state.dateField) return;
    invalidateCriteria("date-field-changed");
    state.dateField = field;
    publish();
    scheduleSearch(0);
  }
  function changeSort({ field = state.sortField, direction = state.sortDirection }) {
    if (state.mode !== "date" || !["createdAt", "updatedAt"].includes(field) || !["asc", "desc"].includes(direction)
      || (field === state.sortField && direction === state.sortDirection)) return;
    beginInteraction();
    state.sortField = field;
    state.sortDirection = direction;
    if (activeDateOnly()) { state.generation += 1; state.page = 1; state.scrollTop = 0; queueDateRefresh(); }
    publish();
  }
  function resizeKeywordPage(size, { scrollTop = state.scrollTop, rowHeight = 94 } = {}) {
    const offset = Math.floor(scrollTop / rowHeight);
    const anchorIndex = (state.page - 1) * state.pageSize + offset;
    const withinRow = scrollTop % rowHeight;
    state.pageSize = size;
    state.page = Math.floor(anchorIndex / size) + 1;
    state.scrollTop = (anchorIndex % size) * rowHeight + withinRow;
    paginateKeywordItems(state.keywordStatus?.items || []);
  }
  function setKeywordCapacity(size, anchor) {
    if (state.mode !== "keyword" || !state.active || !state.visible || size === state.keywordAutoSize) return;
    state.keywordAutoSize = size;
    if (state.keywordPageSize === "auto") resizeKeywordPage(size, anchor);
    publish();
  }
  function changePageSize(value, anchor) {
    if (state.mode === "keyword") {
      if (value !== "auto" && !keywordPageOptions().includes(value)) return;
      beginInteraction();
      state.keywordPageSize = value;
      resizeKeywordPage(value === "auto" ? state.keywordAutoSize : value, anchor);
      publish();
      return;
    }
    if (!searchContract.PAGE_SIZE_OPTIONS.includes(value)) return;
    beginInteraction();
    state.datePageSize = value;
    synchronizePageSize();
    if (activeDateOnly()) { state.generation += 1; state.page = 1; queueDateRefresh(); }
    else void loadFirstPage();
  }
  function previousPage() {
    if (state.page <= 1) return;
    beginInteraction(); state.page -= 1; state.scrollTop = 0; publish();
  }
  function nextPage() { beginInteraction(); return loadNextPage(); }
  function goToPage(page) {
    if (state.mode !== "keyword" || !state.keywordStatus?.complete) return;
    if (Number.isInteger(page) && page >= 1 && page <= state.pages.length) {
      beginInteraction(); state.page = page; state.scrollTop = 0;
    }
    publish();
  }
  function retry() {
    if (state.mode !== "keyword" || !state.active || !state.visible) return;
    beginInteraction();
    return state.keywordStatus ? keywordSearch.retry() : loadFirstPage();
  }
  function refreshKeyword() {
    if (state.mode !== "keyword" || state.loading || composing || !state.query.trim()) return;
    beginInteraction(); return loadFirstPage({ manualRefresh: true });
  }
  function refreshDirectory() { beginInteraction(); return refreshCatalog(); }
  function prepareDateExport() {
    if (state.mode !== "date") { invalidateCriteria("date-export"); state.mode = "date"; synchronizePageSize(); scheduleSearch(0); }
    onCalendarClose(); publish();
  }
  function setTimeZone(timeZone) {
    if (!timeZone || timeZone === state.timeZone) return;
    state.timeZone = timeZone;
    if (state.mode === "date" && state.searched && criteria().hasDate) {
      invalidateCriteria("time-zone-changed"); scheduleSearch(0); publishSources();
    }
  }
  function selectResult(id) { state.activeResultId = id; }
  function setScrollTop(value) { state.scrollTop = value; }
  function setConversationId(conversationId, { preserveInteraction = false } = {}) {
    const next = typeof conversationId === "string" && conversationId ? conversationId : null;
    if (state.conversationId === next) return state.activeResultId;
    if (!preserveInteraction) beginInteraction();
    state.conversationId = next;
    const items = state.mode === "keyword" ? state.keywordStatus?.items || [] : state.pages.flat();
    const selected = items.find(item => item.resultId === state.activeResultId && item.conversationId === next)
      || items.find(item => item.conversationId === next);
    state.activeResultId = selected?.resultId || null;
    return state.activeResultId;
  }
  return Object.freeze({ snapshot, readContext, readDateSelection, findResult, criteria, exportItems, setIndexStatus, setActive, setVisible, setTabId,
    changeQuery, setComposing, changeMode, changeDateRange, changeDateField, changeSort, changePageSize,
    setKeywordCapacity, previousPage, nextPage, goToPage, retry, refreshKeyword, refreshDirectory,
    prepareDateExport, setTimeZone, selectResult, setScrollTop, setConversationId, beginInteraction });
}
