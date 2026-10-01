/* Shared notice lifecycle for the side panel and ordinary content scripts.
 * This is not a retry engine: business owners decide whether an operation is
 * current and what evidence resolves it. Rendering only reads current().
 * Product timing belongs at each transient caller; unknown writes never get TTL.
 */
(function installNoticeLifecycle(global) {
  "use strict";
  if (global.ChatGPTTidyNoticeLifecycle) return;
  const KINDS = Object.freeze(["transient", "condition", "operation"]);
  const UNSPECIFIED = "OBSERVATION_ONLY_UNSPECIFIED";
  const DISCONNECTS = Object.freeze(["context-invalidated", "receiver-missing", "connection-closed"]);
  let serial = 0;

  // Opaque object identity prevents a stale callback from recreating ownership
  // merely by copying an integer. Revocation does not cancel or replay a write.
  function createOwner() {
    let epoch = 0, current = null, disposed = false;
    return Object.freeze({
      begin() { if (disposed) return null; current = Object.freeze({ epoch: ++epoch }); return current; },
      owns(token) { return !disposed && token !== null && token === current; },
      revoke() { current = null; epoch++; },
      dispose() { disposed = true; current = null; epoch++; },
    });
  }

  // One canonical sanitizer, also exported by diagnostics.cause. Correlation IDs
  // are generated locally; account IDs, conversation IDs and free text are not IDs.
  function correlation(value, field = "") {
    if (field === "jobId" && typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) return value;
    return typeof value === "string" && value.length <= 100 &&
      /^(?:req|error|event|navigation|export|job|export-job)-(?:(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})|(?:\d{10,16}-[a-f0-9]{1,20}))$/i.test(value) ? value : null;
  }
  function cause(error) {
    try {
      const nested = error?.cause;
      const value = error?.reasonCode || error?.code || error?.tidyCode || error?.exportMessageKey
        || nested?.reasonCode || nested?.code || nested?.tidyCode || nested?.exportMessageKey;
      const reasons = global.ChatGPTTidyBuildInfo?.reasonCodes;
      const stages = global.ChatGPTTidyBuildInfo?.stageCodes;
      const details = error?.details || {}, nestedDetails = nested?.details || {};
      const stage = details.stage ?? error?.stage ?? nestedDetails.stage ?? nested?.stage;
      const disconnect = details.disconnect ?? error?.disconnect ?? nestedDetails.disconnect ?? nested?.disconnect;
      const status = details.status ?? error?.status ?? nestedDetails.status ?? nested?.status;
      const retryable = details.retryable ?? error?.retryable ?? nestedDetails.retryable ?? nested?.retryable;
      return Object.freeze({
        reasonCode: typeof value === "string" && Array.isArray(reasons) && reasons.includes(value) ? value : UNSPECIFIED,
        requestId: correlation(error?.requestId || nested?.requestId),
        navigationIntentId: correlation(error?.navigationIntentId || nested?.navigationIntentId),
        jobId: correlation(error?.jobId || nested?.jobId, "jobId"),
        stage: typeof stage === "string" && Array.isArray(stages) && stages.includes(stage) ? stage : null,
        disconnect: DISCONNECTS.includes(disconnect) ? disconnect : null,
        status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
        retryable: typeof retryable === "boolean" ? retryable : null,
      });
    } catch {
      return Object.freeze({ reasonCode: UNSPECIFIED, requestId: null, navigationIntentId: null, jobId: null,
        stage: null, disconnect: null, status: null, retryable: null });
    }
  }

  function createSlot({ onChange = () => {}, now = () => Date.now(),
    setTimer = global.setTimeout?.bind(global), clearTimer = global.clearTimeout?.bind(global) } = {}) {
    let current = null, timer = null, timerEpoch = 0, remaining = null, dueAt = null, paused = false, disposed = false;
    function stopTimer() {
      timerEpoch++; // Pause/resume also retires queued callbacks for the same notice.
      if (timer !== null && typeof clearTimer === "function") clearTimer(timer);
      timer = null; dueAt = null;
    }
    function notify(value, change) { onChange(value, Object.freeze(change)); }
    function clear(expected = current, reason = "NOTICE_CLEARED_BY_OWNER") {
      if (!current || current !== expected) return false;
      const previous = current;
      stopTimer(); current = null; remaining = null;
      notify(null, { event: "clear", reason, previous });
      return true;
    }
    function schedule() {
      if (!current || paused || remaining === null || disposed) return;
      const expected = current, epoch = ++timerEpoch;
      dueAt = now() + remaining;
      timer = setTimer(() => {
        // A queued callback can run even after clearTimeout. It only owns the
        // exact notice it was created for, never its replacement.
        if (current !== expected || epoch !== timerEpoch || paused || disposed) return;
        timer = null; dueAt = null;
        clear(expected, "NOTICE_EXPIRED");
      }, remaining);
    }
    function replace(input, { owner = null, token = null, ttlMs = null } = {}) {
      if (disposed || owner && !owner.owns(token)) return null;
      if (!input || !KINDS.includes(input.kind)) throw new TypeError("Notice kind must be transient, condition or operation");
      if (ttlMs !== null && (input.kind !== "transient" || !Number.isFinite(ttlMs) || ttlMs <= 0)) {
        throw new TypeError("Only a transient notice can have a positive finite ttlMs");
      }
      if (ttlMs !== null && (typeof setTimer !== "function" || typeof clearTimer !== "function")) {
        throw new TypeError("Transient timing requires setTimer and clearTimer");
      }
      const previous = current;
      stopTimer();
      current = Object.freeze({ ...input, ...(input.cause ? { cause: cause(input.cause) } : {}), id: ++serial });
      remaining = ttlMs;
      const notice = current;
      schedule();
      // Replacement is a single presentation change. Diagnostics pairs its own
      // clear/show records; the DOM need not be torn down between these events.
      notify(notice, { event: "show", reason: previous ? "NOTICE_REPLACED" : "NOTICE_SHOWN", previous });
      return notice;
    }
    function setPaused(value) {
      const next = Boolean(value);
      if (disposed || paused === next) return;
      if (next && dueAt !== null) remaining = Math.max(0, dueAt - now());
      paused = next; stopTimer();
      if (!paused) schedule();
    }
    return Object.freeze({
      current: () => current, replace, clear, setPaused,
      dispose() { if (disposed) return; disposed = true; clear(current, "VIEW_DISPOSED"); stopTimer(); },
    });
  }

  global.ChatGPTTidyNoticeLifecycle = Object.freeze({ KINDS, createOwner, createSlot, cause });
})(globalThis);
