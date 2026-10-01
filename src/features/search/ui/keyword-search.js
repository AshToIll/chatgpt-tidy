export function createKeywordSearch({
  fetchPage,
  onChange = () => {},
  createSessionId = globalThis.TidySearch?.createSessionId,
  // Network batches are independent of the panel's visible page size.
  batchSize = 30,
  // Leave a small gap between official requests; failures never auto-retry.
  pageDelayMs = 100,
} = {}) {
  const contract = globalThis.TidySearch;
  if (!contract?.validatePage || !contract?.normalizeRequest) {
    throw new TypeError("The keyword search contract is unavailable");
  }
  if (typeof fetchPage !== "function" || typeof onChange !== "function"
    || typeof createSessionId !== "function") {
    throw new TypeError("Keyword search callbacks must be functions");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > contract.MAX_LIMIT) {
    throw new RangeError(`Keyword search batchSize must be between 1 and ${contract.MAX_LIMIT}`);
  }
  if (!Number.isFinite(pageDelayMs) || pageDelayMs < 0 || pageDelayMs > 60_000) {
    throw new RangeError("Keyword search pageDelayMs must be between 0 and 60000");
  }

  const emptyState = () => ({ query: "", sessionId: null, items: [], total: 0,
    phase: "idle", cursor: null, hasMore: false, error: false, partialResults: false, complete: false });
  let state = emptyState();
  let generation = 0;
  let timer = null;
  let inFlight = null;
  let seenResults = new Set();
  let seenCursors = new Set();
  const idleWaiters = new Set();

  function snapshot() {
    return { ...state, items: state.items.map((item) => ({ ...item })),
      error: state.error ? { ...state.error } : false };
  }

  function publish() {
    onChange(snapshot());
  }

  function clearPageTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function settleIdle() {
    if (inFlight || timer !== null || state.phase === "loading") return;
    const value = snapshot();
    for (const resolve of idleWaiters) resolve(value);
    idleWaiters.clear();
  }

  function whenIdle() {
    if (!inFlight && timer === null && state.phase !== "loading") return Promise.resolve(snapshot());
    return new Promise((resolve) => idleWaiters.add(resolve));
  }

  function fail(code, { message = "", stage = "keyword-pagination", restartRequired = true, cause = null } = {}) {
    state.phase = "error";
    state.complete = false;
    state.partialResults = true;
    // Keep the same recovery DTO used by date errors; rendering must not guess
    // whether a bridge needs a reload or an explicitly forbidden retry.
    state.error = { ...globalThis.TidyLibraryHydration.normalizeError(cause || { code }, { fallbackCode: code, stage }),
      message, restartRequired };
  }

  function acceptPage(page, requestedCursor) {
    const validation = contract.validatePage(page);
    if (!validation.valid) {
      fail("SEARCH_SCHEMA_CHANGED", { message: validation.errors.join(", ") });
      return;
    }
    if (page.query !== state.query) {
      fail("SEARCH_QUERY_MISMATCH");
      return;
    }
    // Keep the first official position and snippet. A conversation may have
    // several distinct message hits; title-only hits remain separate results.
    for (const item of page.items) {
      const resultId = `keyword:${item.conversationId}:${item.messageId || "title"}`;
      if (seenResults.has(resultId)) continue;
      seenResults.add(resultId);
      state.items.push({ ...item, resultId });
    }
    state.total = state.items.length;
    state.cursor = page.cursor;
    state.hasMore = page.hasMore;
    if (page.partialResults || page.coverageState === "partial" || page.readErrors?.length
      || page.error || (page.sourceStatus && page.sourceStatus.status !== "ok")) {
      fail("SEARCH_PARTIAL_RESULTS");
      return;
    }
    if ((page.hasMore && !page.cursor) || (!page.hasMore && page.cursor)) {
      fail("SEARCH_CURSOR_INVALID");
      return;
    }
    if (page.cursor && (page.cursor === requestedCursor || seenCursors.has(page.cursor))) {
      fail("SEARCH_CURSOR_LOOP");
      return;
    }
    if (page.cursor) seenCursors.add(page.cursor);
    state.complete = !page.hasMore;
    if (state.complete) state.phase = "complete";
  }

  function scheduleNextPage(expectedGeneration) {
    if (generation !== expectedGeneration || state.phase !== "loading" || !state.hasMore
      || inFlight || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (generation === expectedGeneration && state.phase === "loading") void requestPage();
      else settleIdle();
    }, pageDelayMs);
  }

  function requestPage() {
    if (inFlight) return inFlight.promise;
    const expectedGeneration = generation;
    const requestedCursor = state.cursor;
    const request = { mode: "keyword", query: state.query, sessionId: state.sessionId,
      cursor: requestedCursor, limit: batchSize };
    const operation = { promise: null };
    inFlight = operation;
    state.phase = "loading";
    state.error = false;
    state.partialResults = false;
    // Start in a microtask so pause/reset from an onChange handler also wins
    // before an official request is dispatched.
    operation.promise = Promise.resolve().then(async () => {
      try {
        if (generation !== expectedGeneration || state.phase !== "loading") return snapshot();
        const page = await fetchPage(request);
        if (generation !== expectedGeneration) return snapshot();
        acceptPage(page, requestedCursor);
        publish();
      } catch (error) {
        if (generation !== expectedGeneration) return snapshot();
        const code = error?.code || error?.tidyCode || "SEARCH_UNAVAILABLE";
        const restartRequired = /SCHEMA|CURSOR|PARTIAL|QUERY_MISMATCH/.test(code)
          || /schema|response changed|invalid standardized search page/i.test(error?.message || "");
        fail(code, { message: error?.message || "", stage: error?.details?.stage || error?.stage || null,
          restartRequired, cause: error });
        publish();
      } finally {
        if (generation === expectedGeneration && inFlight === operation) {
          inFlight = null;
          scheduleNextPage(expectedGeneration);
          settleIdle();
        }
      }
      return snapshot();
    });
    publish();
    return operation.promise;
  }

  function invalidate() {
    clearPageTimer();
    generation += 1;
    // Old bridge reads may finish, but their generation can no longer write
    // state or hold up the new session's idle waiters.
    inFlight = null;
    seenResults = new Set();
    seenCursors = new Set();
  }

  function start(query) {
    const request = contract.normalizeRequest({ query, sessionId: createSessionId(), limit: batchSize });
    invalidate();
    state = { ...emptyState(), query: request.query, sessionId: request.sessionId };
    settleIdle();
    return requestPage();
  }

  function reset() {
    invalidate();
    state = emptyState();
    publish();
    settleIdle();
    return snapshot();
  }

  function pause({ invalidateInFlight = false } = {}) {
    if (state.phase !== "loading" && !(invalidateInFlight && state.phase === "paused")) return snapshot();
    clearPageTimer();
    // Hiding the panel may still accept an already-sent page. Replacing its
    // document is different: that bridge no longer owns this search session.
    // Keep accepted results/cursors, but never let the old read publish a late
    // failure or hold up resume while the new document is ready to serve it.
    if (invalidateInFlight) {
      generation += 1;
      inFlight = null;
    }
    state.phase = "paused";
    publish();
    settleIdle();
    return snapshot();
  }

  function resume() {
    if (state.phase !== "paused") return snapshot();
    state.phase = "loading";
    publish();
    if (state.phase !== "loading") return snapshot();
    if (!inFlight) {
      if (state.hasMore) scheduleNextPage(generation);
      else void requestPage();
    }
    return snapshot();
  }

  function retry() {
    if (state.phase !== "error" || state.error.retryable === false) return Promise.resolve(snapshot());
    if (state.error.restartRequired) return start(state.query);
    return requestPage();
  }

  return Object.freeze({ start, pause, resume, reset, retry, snapshot, whenIdle });
}
