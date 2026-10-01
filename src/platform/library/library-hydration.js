(function initLibraryHydration(global) {
  "use strict";

  // Both library consumers use the same narrow recovery policy. A ready
  // notification is positive evidence, not permission to retry arbitrary errors.
  const same = (a, b) => Boolean(a && b && a.documentId === b.documentId
    && a.epoch === b.epoch && a.accountKey === b.accountKey && b.phase === "ready");
  function isDisconnected(error) {
    return (error?.code || error?.tidyCode) === "ADAPTER_UNAVAILABLE"
      && error.details?.status == null
      && ["sidepanel.runtime-send-message", "content.library-runtime-send-message",
        "service-worker.library-account-transport"].includes(error.details?.stage)
      && ["context-invalidated", "receiver-missing", "connection-closed"].includes(error.details?.disconnect);
  }
  function recoveryReady(error, ready, observed) {
    return isDisconnected(error) && ready?.phase === "ready" && same(ready, observed) ? ready : null;
  }
  // Transport exceptions carry details; local search/catalog state stores one
  // flat DTO. Normalize at that boundary rather than dropping recovery facts.
  // null retryability means unknown, not an explicit prohibition on retrying.
  function normalizeError(error, { fallbackCode = "INTERNAL_ERROR", stage = null } = {}) {
    const details = error?.details || {};
    return {
      // 仅保留已知的请求编号用于提示归因；没有编号时不改变原 DTO 形状。
      ...(typeof error?.requestId === "string" && error.requestId ? { requestId: error.requestId } : {}),
      code: error?.code || error?.tidyCode || fallbackCode,
      stage: typeof details.stage === "string" ? details.stage
        : typeof error?.stage === "string" ? error.stage : stage,
      disconnect: details.disconnect || error?.disconnect || null,
      status: Number.isInteger(details.status) ? details.status : Number.isInteger(error?.status) ? error.status : null,
      retryable: typeof details.retryable === "boolean" ? details.retryable
        : typeof error?.retryable === "boolean" ? error.retryable : null,
    };
  }
  function diagnostic(error) {
    // No account IDs, message content, tokens, or arbitrary exception text.
    return error ? { code: error.code || error.tidyCode || "INTERNAL_ERROR",
      stage: typeof error.details?.stage === "string" ? error.details.stage : null,
      disconnect: error.details?.disconnect || null,
      status: Number.isInteger(error.details?.status) ? error.details.status : null } : null;
  }
  function errorPresentation(error, fallbackKey = "actionFailed") {
    const { code, stage, disconnect, status, retryable } = normalizeError(error);
    if (code === "ADAPTER_UNAVAILABLE" && status == null) {
      // A missing PAGE receiver cannot be installed by rereading panel state.
      // A closed channel alone is transient and is not proof of a stale page.
      const missingPage = ["service-worker.page-session", "service-worker.snapshot-send-message", "service-worker.library-account-transport"].includes(stage)
        && disconnect === "receiver-missing";
      const invalidPage = ["page-session", "service-worker.page-session", "content.library-runtime-send-message"].includes(stage)
        && disconnect === "context-invalidated";
      if (missingPage || invalidPage) return { messageKey: "refreshChatgptPage", retryable: false };
      // F5 refreshes ChatGPT, not an invalidated extension side panel document.
      if (stage === "sidepanel.runtime-send-message" && disconnect === "context-invalidated") {
        return { messageKey: "reopenTidyPanel", retryable: false };
      }
    }
    return { messageKey: fallbackKey, retryable: retryable !== false };
  }
  function createDiagnostic() {
    const events = [];
    return Object.freeze({
      record(event, error = null, identity = null) {
        events.push({ event, at: Date.now(), error: diagnostic(error),
          identity: identity ? { documentId: identity.documentId, epoch: identity.epoch, phase: identity.phase } : null });
        if (events.length > 24) events.shift();
      },
      get: () => JSON.parse(JSON.stringify(events)),
    });
  }
  global.TidyLibraryHydration = Object.freeze({ recoveryReady, normalizeError, diagnostic, errorPresentation, createDiagnostic,
    INITIAL_DEADLINE_MS: 6000 });
})(globalThis);
