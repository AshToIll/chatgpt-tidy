// Read-only view projections. Keep the query owner, export owner and DOM apart.
export function searchPhase(state) {
  function dateSearchState() {
    if (!state.searched) return "waiting";
    if ((!state.active || !state.visible) && !state.resultStatus?.resultStable) return "paused";
    if (state.catalogRefreshing) return "refreshing";
    const status = state.indexStatus || state.resultStatus;
    if (state.loading || status?.phase === "loading") return "searching";
    if (state.error || status?.readErrors?.length || status?.phase === "paused") return "paused";
    return state.resultStatus?.resultStable ? "complete" : "searching";
  }

  function searchState() {
    if (state.mode === "date") return dateSearchState();
    const phase = state.keywordStatus?.phase;
    if (state.error || phase === "error" || phase === "paused") return "paused";
    if (state.loading || phase === "loading") return state.keywordRefreshing ? "refreshing" : "searching";
    return phase === "complete" ? "complete" : "waiting";
  }
  return searchState();
}
export function searchViewModel(state, exportSelection, exportItems, animationStartedAt) {
  const selection = { ...exportSelection, active: state.mode === "date" && exportSelection.active === true,
    items: exportItems };
  return {
    controls: { mode: state.mode, query: state.query, composing: state.composing, dateField: state.dateField,
      sortField: state.sortField, sortDirection: state.sortDirection },
    results: { items: state.pages[state.page - 1] || [], timeZone: state.timeZone,
      activeResultId: state.activeResultId, searched: state.searched, dateError: state.dateError, range: state.range },
    pagination: { page: state.page, pageSize: state.pageSize, pages: state.pages, hasMore: state.hasMore,
      options: state.pageOptions, keywordPageSize: state.keywordPageSize, keywordAutoSize: state.keywordAutoSize },
    status: { phase: searchPhase(state), animationStartedAt, errorNotice: state.errorNotice,
      indexStatus: state.indexStatus, resultStatus: state.resultStatus, keywordStatus: state.keywordStatus,
      loading: state.loading, error: state.error, sessionId: state.sessionId,
      catalogRefreshing: state.catalogRefreshing, keywordRefreshing: state.keywordRefreshing },
    selection,
  };
}
