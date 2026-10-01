// One admission boundary for the whole panel. Account/library hydration is a
// different lifecycle: only a successful page bridge handshake admits business.
export function isPageSessionError(error) {
  const details = error?.details;
  return error?.code === "ADAPTER_UNAVAILABLE" && (
    ["service-worker.page-session", "page-session"].includes(details?.stage)
    || details?.stage === "sidepanel.runtime-send-message" && details.disconnect === "context-invalidated");
}

// Both probe failures and command rejection must use the same evidence rule.
// A stopped retry budget alone never means that the ChatGPT page is obsolete.
function requiresPageRefresh(error) {
  return isPageSessionError(error) && (error.details.phase === "refresh-required"
    || ["receiver-missing", "context-invalidated"].includes(error.details.disconnect));
}

// Closing/cancelling is always safe; everything not explicitly listed is a
// business command, including local preference writes and backup operations.
export function pageCommandCapability(type) {
  if (["page-session.probe", "snapshot.get-active-context", "preferences.get"].includes(type)) return "bootstrap";
  if (["navigation.cancelled", "export.job-cancel", "export.preview-close", "library.backup-discard"].includes(type)) return "cancel";
  // OPEN intentionally crosses documents. Its accepted receipt is checked by
  // the exact navigation intent owner; the new page still needs its own probe.
  if (["bookmarks.open", "favorites.open", "search.open-result"].includes(type)) return "navigation";
  return "business";
}

export function createPageSessionController({ probe, onChanged = () => {},
  setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout, retryMs = 250, maxAttempts = 20 }) {
  let state = Object.freeze({ phase: "connecting", generation: 0, documentId: null, error: null });
  let disposed = false, timer = null, pending = null, blockedDocumentId = null, attempts = 0;
  const publish = (next) => { state = Object.freeze({ ...state, ...next }); onChanged(state); };
  const clearRetry = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const blockedError = (phase = state.phase) => Object.assign(new Error("The page session is not ready."), {
    code: "ADAPTER_UNAVAILABLE",
    details: { stage: "page-session", phase, documentId: state.documentId },
  });

  function reject(error) {
    if (disposed || !isPageSessionError(error)) return false;
    // A local admission error in stalled phase is not proof of an invalid
    // document. Only a confirmed disconnect may tell the user to refresh.
    const refreshRequired = requiresPageRefresh(error);
    const phase = refreshRequired ? "refresh-required"
      : error.details.phase === "stalled" ? "stalled" : "connecting";
    // A transient bootstrap observation cannot unlock a terminal old document.
    if (state.phase === "refresh-required" && phase !== "refresh-required") return true;
    clearRetry(); pending = null;
    if (phase === "refresh-required") blockedDocumentId = error.details.documentId || state.documentId;
    publish({ phase, generation: state.generation + 1, error,
      documentId: error.details.documentId || state.documentId });
    if (phase === "connecting") timer = setTimer(() => { timer = null; void check(); }, retryMs);
    return true;
  }

  function check({ contextChanged = false, retry = false } = {}) {
    if (disposed) return Promise.resolve(false);
    if (pending && !contextChanged) return pending;
    clearRetry();
    if (!retry) attempts = 0;
    attempts += 1;
    const generation = state.generation + 1;
    // Keep the red notice until a new document proves readiness. Ordinary
    // snapshots, accounts and routes never clear this terminal state.
    publish({ generation, phase: state.phase === "refresh-required" ? state.phase : "connecting", error: state.error });
    const operation = Promise.resolve().then(probe).then(result => {
      if (disposed || generation !== state.generation) return false;
      // Invalid read-only probe data is transient evidence, even while an old
      // document stays refresh-required. Do not manufacture a new terminal cause.
      if (result?.ready !== true || typeof result.documentId !== "string" || !result.documentId) throw blockedError("connecting");
      if (state.phase === "refresh-required" && blockedDocumentId && result.documentId === blockedDocumentId) return false;
      blockedDocumentId = null;
      publish({ phase: "ready", documentId: result.documentId, error: null });
      return true;
    }).catch(error => {
      if (disposed || generation !== state.generation) return false;
      // Only explicit document disconnect evidence asks for F5. A worker
      // waking up or a bridge still mounting remains a read-only connection.
      if (requiresPageRefresh(error)) reject(error);
      else {
        // Failed read-only checks must not replace confirmed disconnect
        // evidence. That condition ends only after a new document is ready.
        if (state.phase === "refresh-required") return false;
        const exhausted = attempts >= maxAttempts;
        publish({ error, phase: exhausted ? "stalled" : "connecting" });
        // A bounded bootstrap window, not a permanent poll. Later native
        // document/snapshot/visibility signals can start a fresh read-only try.
        if (!exhausted) {
          timer = setTimer(() => { timer = null; void check({ retry: true }); }, retryMs);
        }
      }
      return false;
    }).finally(() => { if (pending === operation) pending = null; });
    pending = operation;
    return operation;
  }

  async function run(type, request) {
    const capability = pageCommandCapability(type);
    const business = capability === "business" || capability === "navigation";
    if (disposed && capability !== "cancel" || business && state.phase !== "ready") throw blockedError();
    const generation = state.generation;
    try {
      const value = await request();
      if (business && (state.phase === "refresh-required" || disposed
        || capability !== "navigation" && (state.phase !== "ready" || state.generation !== generation))) throw blockedError();
      return value;
    } catch (error) {
      // A late failure from a retired request cannot lock a replacement page.
      if (generation === state.generation) reject(error);
      throw error;
    }
  }

  return Object.freeze({ check, run, reject, getState: () => state, isReady: () => !disposed && state.phase === "ready",
    dispose() { disposed = true; clearRetry(); pending = null;
      state = Object.freeze({ ...state, phase: "connecting", generation: state.generation + 1 }); },
  });
}
