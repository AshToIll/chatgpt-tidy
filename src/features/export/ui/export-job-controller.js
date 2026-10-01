import "../model/export-job.js";
import "../../../messages/notice-lifecycle.js";

// Status is read-only. Two-second polling is a fallback to explicit worker events;
// three consecutive failed reads stop polling without unlocking another download.
const STATUS_POLL_MS = 2_000;
const MAX_READ_FAILURES = 3;

const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
function immutableCopy(value) {
  const result = copy(value);
  const freeze = object => {
    if (!object || typeof object !== "object") return object;
    for (const child of Object.values(object)) freeze(child);
    return Object.freeze(object);
  };
  return freeze(result);
}
function normalizedAccountKey(value) {
  return typeof value === "string" && value && value === value.trim() ? value : null;
}

/**
 * Owns the export receipt, pending admission and notice lifetime, not DOM or plans.
 * The view freezes its export plan before submit(); this controller also takes a
 * transport copy so later caller edits cannot change an already admitted write.
 *
 * Configuration calls updateOwner()/setPresentation() do not emit onChanged:
 * they are safe inside a view update/render. Async transitions notify the view.
 * onAcceptedFailure receives a message key only, never server text.
 */
export function createExportJobController({
  jobRequest,
  onChanged = () => {},
  onAcceptedFailure = () => {},
  timers = globalThis,
} = {}) {
  const contract = globalThis.TidyExportJobs;
  if (!contract) throw new Error("Export job contract is unavailable");
  const ownership = globalThis.ChatGPTTidyNoticeLifecycle.createOwner();
  let ownershipToken = ownership.begin();
  const state = {
    disposed: false,
    accountKey: null, verified: false, epoch: 0, ownershipSerial: 0,
    job: null, submission: null, reading: null, unknown: false,
    readFailures: 0, admissionId: null, observedFailure: null,
    pollTimer: null, noticeTimer: null, noticeId: null, dismissedId: null, noticeAutoDismissBlocked: false,
    active: false, warningsOpen: false, pointerInside: false,
    focusInside: false, documentHidden: false,
  };

  function busy() {
    return Boolean(state.verified && (state.submission || state.admissionId || state.unknown
      || contract.active(state.job) || state.job?.state === "busy"));
  }
  function noticeHidden() {
    return Boolean(!busy() && (state.job?.dismissedAt || state.job?.id === state.dismissedId));
  }
  function snapshot() {
    // Suspension retains recovery state privately, never an old account's public
    // receipt. Reverification can reconcile the retained admission via status.
    return immutableCopy({
      verified: state.verified,
      job: state.verified ? state.job : null,
      submission: state.verified && Boolean(state.submission),
      unknown: state.verified && state.unknown,
      readFailures: state.verified ? state.readFailures : 0,
      admissionId: state.verified ? state.admissionId : null,
      observedFailure: state.verified ? state.observedFailure : null,
      warningsOpen: state.verified && state.warningsOpen,
      pointerInside: state.verified && state.pointerInside,
      focusInside: state.verified && state.focusInside,
      dismissedId: state.verified ? state.dismissedId : null,
    });
  }
  function clearPoll() {
    if (state.pollTimer !== null) timers.clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  function clearNotice() {
    if (state.noticeTimer !== null) timers.clearTimeout(state.noticeTimer);
    state.noticeTimer = null;
  }
  function currentIdentity() { return state.admissionId || state.job?.id || null; }
  function operation(expectedId = currentIdentity()) {
    return { ownerToken: ownershipToken, epoch: state.epoch, serial: state.ownershipSerial,
      accountKey: state.accountKey, expectedId };
  }
  function owns(token) {
    return ownership.owns(token.ownerToken) && state.verified && token.epoch === state.epoch
      && token.serial === state.ownershipSerial && token.accountKey === state.accountKey
      && token.expectedId === currentIdentity();
  }
  function replaceOwnership() {
    // Shared lifecycle ownership is opaque. Account/job identity and the serial
    // remain explicit domain guards; presentation updates never replace a token.
    ownership.revoke();
    ownershipToken = ownership.begin();
    state.ownershipSerial++;
  }
  function supersedeReads() {
    replaceOwnership();
    state.reading = null;
    clearPoll();
  }
  function syncNotice() {
    const job = state.job;
    if (state.noticeId !== (job?.id || null)) {
      clearNotice();
      state.noticeId = job?.id || null;
      state.noticeAutoDismissBlocked = false;
      state.warningsOpen = false;
      state.pointerInside = false;
      state.focusInside = false;
    }
    const paused = !state.active || !state.verified || state.documentHidden || busy()
      || !contract.terminal(job) || noticeHidden() || job.state === "failed" || state.noticeAutoDismissBlocked
      || state.warningsOpen || state.pointerInside || state.focusInside;
    if (paused) { clearNotice(); return; }
    if (state.noticeTimer !== null) return;
    // Ordinary snapshots/rerenders keep the deadline. Leaving a paused reading
    // state grants the full six/twelve seconds again, not the remaining fraction.
    const token = operation(job.id);
    state.noticeTimer = timers.setTimeout(() => {
      state.noticeTimer = null;
      if (owns(token)) void dismiss();
    }, job.warnings?.length ? contract.WARNING_NOTICE_MS : contract.NOTICE_MS);
  }
  function changed() {
    syncNotice();
    onChanged();
  }
  function observedCause(error) {
    try { return globalThis.ChatGPTTidyDiagnostics?.cause(error) || null; }
    catch { return null; } // Diagnostics cannot change the export state machine.
  }
  function markUnknown(error, { readFailure = false } = {}) {
    state.observedFailure = observedCause(error);
    state.unknown = true;
    if (readFailure) state.readFailures++;
    changed();
  }
  function acceptJob(job) {
    if (job?.id === state.job?.id && job?.revision < state.job?.revision) return false;
    if (!state.unknown && JSON.stringify(job) === JSON.stringify(state.job)) return true;
    // Replacing A with B invalidates A's still-pending cancel/dismiss callbacks.
    if ((job?.id || null) !== (state.job?.id || null)) replaceOwnership();
    state.observedFailure = null;
    // A same-revision status can have been read just before cancel was applied.
    // Keep its optimistic lock until the worker publishes a newer revision.
    const awaitingCancellation = state.job?.state === "cancelling" && job?.id === state.job.id
      && contract.active(job) && job.state !== "cancelling" && job.revision <= state.job.revision;
    state.job = copy(awaitingCancellation ? { ...job, state: "cancelling" } : job);
    state.unknown = false;
    state.readFailures = 0;
    changed();
    return true;
  }
  function scheduleRefresh() {
    clearPoll();
    if (typeof jobRequest === "function" && busy() && state.readFailures < MAX_READ_FAILURES) {
      state.pollTimer = timers.setTimeout(() => {
        state.pollTimer = null;
        void refresh();
      }, STATUS_POLL_MS);
    }
  }
  function updateOwner({ accountKey, verified } = {}) {
    if (state.disposed) return false;
    const nextKey = normalizedAccountKey(accountKey);
    const nextVerified = Boolean(nextKey && verified);
    const accountChanged = nextKey !== state.accountKey;
    if (!accountChanged && nextVerified === state.verified) return false;
    state.epoch++;
    supersedeReads();
    clearNotice();
    state.submission = null;
    if (!accountChanged && state.admissionId) {
      // Suspension can hide a sent start(), not unsend it. Reverification must
      // reconcile that admission before the user can submit another export.
      state.unknown = true;
    }
    if (accountChanged) {
      state.job = null;
      state.unknown = false;
      state.readFailures = 0;
      state.admissionId = null;
      state.observedFailure = null;
      state.noticeId = null;
      state.noticeAutoDismissBlocked = false;
      state.dismissedId = null;
      state.warningsOpen = false;
      state.pointerInside = false;
      state.focusInside = false;
    }
    state.accountKey = nextKey;
    state.verified = nextVerified;
    syncNotice();
    return true;
  }
  function setPresentation(presentation = {}) {
    const wasActive = state.active;
    for (const key of ["active", "warningsOpen", "pointerInside", "focusInside", "documentHidden"]) {
      if (Object.hasOwn(presentation, key)) state[key] = Boolean(presentation[key]);
    }
    if (wasActive && !state.active) {
      state.pointerInside = false;
      state.focusInside = false;
    }
    syncNotice();
  }

  async function refresh() {
    if (typeof jobRequest !== "function" || !state.verified || state.reading) return false;
    const token = operation(), reading = {};
    state.reading = reading;
    clearPoll();
    try {
      const job = await jobRequest("status", { expectedAccountKey: token.accountKey });
      if (!owns(token) || state.submission) return false;
      if (state.admissionId && job?.id !== state.admissionId && job?.state !== "busy") {
        onAcceptedFailure("exportJobNotStarted");
      }
      state.admissionId = null;
      return acceptJob(job);
    } catch (error) {
      if (owns(token)) markUnknown(error, { readFailure: true });
      return false;
    } finally {
      if (state.reading === reading) {
        state.reading = null;
        scheduleRefresh();
      }
    }
  }

  // A per-attempt callback lets the view capture its context fence before I/O.
  // Only an owned, definitely-not-admitted response may invoke it.
  async function submit(payload, { onResponsePending = () => {} } = {}) {
    if (typeof jobRequest !== "function" || !state.verified || busy()) return false;
    if (!payload?.id || (payload.expectedAccountKey && payload.expectedAccountKey !== state.accountKey)) return false;
    const request = copy({ ...payload, expectedAccountKey: state.accountKey });
    supersedeReads();
    state.observedFailure = null;
    state.admissionId = request.id;
    const token = operation(request.id), submission = {};
    state.submission = submission;
    changed();
    try {
      if (!owns(token)) return false;
      const job = await jobRequest("start", request);
      if (!owns(token)) return false;
      // Only status may discover another task. A mismatched write receipt is
      // unconfirmed, not permission to replace the admitted task or replay it.
      if (job?.id !== token.expectedId && job?.state !== "busy") {
        markUnknown(new Error("Export admission receipt identity mismatch"));
        return false;
      }
      state.admissionId = null;
      return acceptJob(job);
    } catch (error) {
      if (!owns(token)) return false;
      if (error?.code === "EXPORT_RESPONSE_PENDING") {
        // This one start rejection authoritatively means no job was admitted.
        // Revoke reads from that admission before unlocking; neither a poll nor
        // the callback may turn a pending response into an automatic replay.
        supersedeReads();
        state.admissionId = null;
        state.submission = null;
        state.unknown = false;
        state.readFailures = 0;
        state.observedFailure = null;
        // Preserve the prior receipt as a fact, but never show its completed
        // notice as the outcome of this rejected attempt. This is local only.
        if (contract.terminal(state.job)) state.dismissedId = state.job.id;
        const pendingOwner = operation();
        changed();
        // Rendering can synchronously replace the owner or start another job.
        // The original write token was revoked above; fence callback delivery
        // against the settled owner as well as the original response owner.
        if (owns(pendingOwner)) onResponsePending(request);
        return false;
      }
      markUnknown(error);
      return false;
    } finally {
      if (state.submission === submission) {
        state.submission = null;
        changed();
        if (state.unknown) void refresh();
        else scheduleRefresh();
      }
    }
  }

  async function cancel() {
    if (typeof jobRequest !== "function" || !state.verified || !contract.active(state.job)
      || state.job.state === "cancelling" || state.submission) return false;
    supersedeReads();
    const token = operation(state.job.id);
    state.job = { ...state.job, state: "cancelling" };
    changed();
    try {
      if (!owns(token)) return false;
      const job = await jobRequest("cancel", { id: token.expectedId, expectedAccountKey: token.accountKey });
      if (!owns(token)) return false;
      if (job?.id !== token.expectedId) {
        markUnknown(new Error("Export cancellation receipt identity mismatch"));
        return false;
      }
      return acceptJob(job);
    } catch (error) {
      if (owns(token)) markUnknown(error);
      return false;
    } finally {
      if (owns(token)) {
        changed();
        scheduleRefresh();
      }
    }
  }

  async function dismiss() {
    if (typeof jobRequest !== "function" || !state.verified || busy() || !contract.terminal(state.job)
      || noticeHidden()) return false;
    supersedeReads();
    const token = operation(state.job.id);
    state.dismissedId = token.expectedId;
    clearNotice();
    changed();
    try {
      if (!owns(token)) return false;
      const job = await jobRequest("dismiss", { id: token.expectedId, expectedAccountKey: token.accountKey });
      if (!owns(token)) return false;
      if (job?.id !== token.expectedId) throw new Error("Export dismissal receipt identity mismatch");
      return acceptJob(job);
    } catch (error) {
      // Dismissing an already-confirmed download cannot turn it into an unknown
      // task or trigger another download; only the locally hidden notice reopens.
      if (owns(token)) {
        state.dismissedId = null;
        // Failed writes are never replayed by a timer. The user may explicitly
        // dismiss again; a genuinely new job receives its normal notice timer.
        state.noticeAutoDismissBlocked = true;
        changed();
        onAcceptedFailure("exportJobDismissFailed", observedCause(error));
      }
      return false;
    }
  }

  function dispose() {
    state.disposed = true;
    state.verified = false;
    state.submission = null;
    state.reading = null;
    clearPoll();
    clearNotice();
    ownership.dispose();
  }

  return Object.freeze({ updateOwner, snapshot, busy, submit, refresh, cancel, dismiss, setPresentation, noticeHidden, dispose });
}
