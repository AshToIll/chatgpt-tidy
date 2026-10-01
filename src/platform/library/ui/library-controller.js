/**
 * Account-owned library lifecycle. This is separate from DOM snapshots so a
 * streaming answer never causes authentication reads or blocks Time/Search.
 * Only an identity/document boundary invalidates ownership. Ordinary route,
 * focus and visibility changes do not turn a verified library into null.
 */
export function createLibraryController({ request, onChanged = () => {}, visible = true,
  now = () => Date.now(), setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout,
  // Give a replacement document time to install its content script, then make
  // at most one ordinary read. Neither number is an authentication cache TTL.
  identityRecoveryDelayMs = 800, identityDeadlineMs = globalThis.TidyLibraryHydration.INITIAL_DEADLINE_MS }) {
  const hydration = globalThis.TidyLibraryHydration;
  const diagnostic = hydration.createDiagnostic();
  const identityOf = (value) => value && typeof value.documentId === "string" && value.documentId.trim() === value.documentId
    && value.documentId && Number.isInteger(value.epoch) && value.epoch >= 0
    ? Object.freeze({ documentId: value.documentId, epoch: value.epoch }) : null;
  const sameIdentity = (left, right) => Boolean(left && right && left.documentId === right.documentId && left.epoch === right.epoch);
  const identityError = () => Object.assign(new Error("The library identity changed."), { code: "CONTEXT_MISMATCH" });
  const empty = () => ({ accountKey: null, identity: null, favorites: null, bookmarks: null,
    errors: { favorites: null, bookmarks: null } });
  let model = empty();
  let generation = 0;
  let pending = null;
  let observedIdentity = null;
  let resolution = null;
  let failedInitial = null;
  let disposed = false;
  // Notifications contain revisions, not identity proof. Keep unknown-owner
  // hints only during a pending read, under its existing identity deadline.
  const revisionTargets = new Map();
  let scheduledRevisionRead = null;
  // Chromium may construct the side panel hidden and show it after init().
  // Never-started initialization is not an interrupted/failed verification.
  // Once started, visibility alone can never retry it or renew its deadline.
  let initialRead = "not-requested";
  const publish = () => onChanged(model);
  function deferInitialRead() {
    if (initialRead !== "waiting-visibility") diagnostic.record("waiting-visibility", null, observedIdentity);
    initialRead = "waiting-visibility";
  }
  function stopResolution() {
    if (resolution?.timer != null) clearTimer(resolution.timer);
    resolution = null;
  }
  function cancelRead() {
    const operation = pending;
    pending = null;
    // Resolve local waiters as well as revoking the late IPC reply. Cancelling
    // this promise does not pretend the background request itself was aborted.
    operation?.cancel(null);
  }
  function invalidate() {
    failedInitial = null;
    stopResolution();
    generation += 1;
    cancelRead();
    revisionTargets.clear();
    scheduledRevisionRead = null;
    model = empty();
    publish();
  }
  function failUnknown(error) {
    failedInitial = { error, deadline: resolution?.deadline ?? now(), used: Boolean(pending?.reconnectReady) };
    stopResolution();
    generation += 1;
    cancelRead();
    revisionTargets.clear();
    scheduledRevisionRead = null;
    model = { ...empty(), errors: { favorites: error, bookmarks: error } };
    publish();
  }
  function visibilityError() {
    return Object.assign(new Error("Library identity verification was interrupted. Retry when the panel is visible."), { code: "ADAPTER_UNAVAILABLE" });
  }
  function armResolution(cycle) {
    if (cycle.timer != null) clearTimer(cycle.timer);
    const nextAt = cycle.recoverAt ?? cycle.deadline;
    cycle.timer = setTimer(() => {
      cycle.timer = null;
      if (resolution !== cycle || cycle.generation !== generation || !visible || disposed) return;
      if (now() >= cycle.deadline) {
        failUnknown(Object.assign(new Error("Library identity verification timed out. Retry to verify the current account."), { code: "ADAPTER_TIMEOUT" }));
        return;
      }
      if (cycle.recoverAt == null || now() < cycle.recoverAt) {
        armResolution(cycle);
        return;
      }
      // This is one read under the current document fence, not a forced auth
      // retry. Its completion still needs the full document/epoch/owner proof.
      cycle.recoverAt = null;
      void refresh();
    }, Math.max(0, nextAt - now()));
  }
  function beginResolution({ recover = false, deadline = null } = {}) {
    if (!visible || disposed) return;
    if (!resolution) {
      const startedAt = now();
      resolution = { generation, deadline: deadline ?? startedAt + identityDeadlineMs,
        recoverAt: recover ? startedAt + Math.min(identityRecoveryDelayMs, identityDeadlineMs) : null, timer: null };
    } else if (!recover) resolution.recoverAt = null;
    armResolution(resolution);
  }
  function capture() { return { generation, accountKey: model.accountKey, identity: model.identity }; }
  function isCurrent(token) {
    return Boolean(token?.accountKey && token.generation === generation && token.accountKey === model.accountKey
      && sameIdentity(token.identity, model.identity));
  }
  function needsRevisionRead() {
    const targets = revisionTargets.get(model.accountKey);
    return Boolean(targets && Object.entries(targets).some(([kind, target]) =>
      target.revision > Math.max(model[kind]?.revision ?? -1, target.requested)));
  }
  function scheduleRevisionRead() {
    if (disposed || !visible || !model.accountKey || scheduledRevisionRead || !needsRevisionRead()) return;
    const owner = capture();
    scheduledRevisionRead = owner;
    // Merge sibling notifications and let an already-arriving mutation receipt
    // satisfy the target before dispatch. There is no timer or polling loop.
    void Promise.resolve().then(() => {
      if (scheduledRevisionRead !== owner) return;
      scheduledRevisionRead = null;
      if (visible && isCurrent(owner) && needsRevisionRead()) void refresh({ supersede: true });
    });
  }
  function observeRevision(kind, token) {
    const accountKey = token?.accountKey;
    if (disposed || !["favorites", "bookmarks"].includes(kind)
      || typeof accountKey !== "string" || !accountKey || accountKey.length > 512
      || accountKey.trim() !== accountKey || /[\u0000-\u001f\u007f]/.test(accountKey)
      || !Number.isSafeInteger(token.revision) || token.revision < 0
      || (model.accountKey && model.accountKey !== accountKey)
      // Without an in-flight read, the next user/identity-owned read will start
      // after this commit. There is no stale response to repair or hint to keep.
      || (!model.accountKey && !pending)) return;
    const targets = revisionTargets.get(accountKey) || {};
    const previous = targets[kind];
    if (token.revision <= Math.max(previous?.revision ?? -1,
      model.accountKey === accountKey ? model[kind]?.revision ?? -1 : -1)) return;
    targets[kind] = { revision: token.revision, requested: previous?.requested ?? -1 };
    revisionTargets.set(accountKey, targets);
    scheduleRevisionRead();
  }
  function acceptMutation(token, kind, value) {
    if (!isCurrent(token) || !["favorites", "bookmarks"].includes(kind) || value?.accountKey !== token.accountKey) return false;
    if ((value.revision || 0) < (model[kind]?.revision || 0)) return false;
    model = { ...model, [kind]: value, errors: { ...model.errors, [kind]: null } };
    publish();
    return true;
  }
  function refresh({ supersede = false, retryIdentity = false, reconnectReady = null, initialDeadline = null } = {}) {
    if (disposed) return Promise.resolve(null);
    if (!visible) {
      if (initialRead !== "started") { deferInitialRead(); return Promise.resolve(null); }
      if (!model.accountKey && !model.errors.favorites) failUnknown(visibilityError());
      return Promise.resolve(null);
    }
    if (pending && !supersede) return pending.promise;
    // One ordinary read consumes each known revision target. A failed/stale
    // reply, duplicate notification or visibility toggle cannot replay it.
    for (const target of Object.values(revisionTargets.get(model.accountKey) || {})) target.requested = target.revision;
    initialRead = "started";
    failedInitial = null;
    // A current-only view read may supersede an old all-view read without
    // invalidating the account, mutation leases, scroll state or export basket.
    cancelRead();
    const operation = { generation, documentId: (observedIdentity || model.identity)?.documentId || null,
      readyDuringRead: null, reconnectReady, promise: null, cancel: null };
    const cancelled = new Promise(resolve => { operation.cancel = resolve; });
    pending = operation;
    diagnostic.record(reconnectReady ? "recovery-read" : "read", null, observedIdentity);
    const ownsRead = () => pending === operation && operation.generation === generation;
    if (!model.accountKey) beginResolution({ deadline: initialDeadline });
    const reply = Promise.resolve().then(() => ownsRead() ? request({ retryIdentity: retryIdentity === true,
      ...(reconnectReady ? { expectedAccountKey: reconnectReady.accountKey, expectedIdentity: identityOf(reconnectReady) } : {}) }) : null);
    operation.promise = Promise.race([reply, cancelled]).then((result) => {
      if (!ownsRead()) return null;
      const identity = identityOf(result?.identity);
      if (!identity || typeof result?.accountKey !== "string" || !result.accountKey) throw identityError();
      if (operation.reconnectReady && (!sameIdentity(operation.reconnectReady, identity)
        || operation.reconnectReady.accountKey !== result.accountKey)) throw identityError();
      if (observedIdentity && (observedIdentity.documentId !== identity.documentId
        || observedIdentity.epoch > identity.epoch
        || (sameIdentity(observedIdentity, identity) && observedIdentity.phase === "ready"
          && observedIdentity.accountKey !== result.accountKey))) throw identityError();
      const sameOwner = model.accountKey === result.accountKey && sameIdentity(model.identity, identity);
      if (model.accountKey && !sameOwner) generation += 1;
      const next = { ...empty(), accountKey: result.accountKey, identity,
        errors: result.errors || {} };
      for (const kind of ["favorites", "bookmarks"]) {
        if (next.errors[kind]) diagnostic.record(`${kind}-failed`, next.errors[kind], identity);
        const value = result[kind];
        next[kind] = value?.accountKey === result.accountKey ? value : null;
        // Do not roll back a newer mutation while an earlier library read was pending.
        if (sameOwner && next[kind] && model[kind]
          && (model[kind].revision || 0) >= (next[kind].revision || 0)) next[kind] = model[kind];
        // A failed same-owner storage refresh is not an empty library. Keep the
        // last committed rows; initial failures still expose their error state.
        if (sameOwner && !next[kind] && next.errors[kind] && model[kind]) {
          next[kind] = model[kind]; next.errors = { ...next.errors, [kind]: null };
        }
      }
      observedIdentity = { ...identity, phase: "ready", accountKey: result.accountKey };
      for (const accountKey of revisionTargets.keys()) if (accountKey !== result.accountKey) revisionTargets.delete(accountKey);
      diagnostic.record("hydrated", null, observedIdentity);
      stopResolution();
      const unchanged = sameOwner && next.favorites === model.favorites && next.bookmarks === model.bookmarks
        && JSON.stringify(next.errors) === JSON.stringify(model.errors);
      if (unchanged) return model;
      model = next;
      publish();
      return model;
    }).catch((error) => {
      if (!ownsRead()) return null;
      diagnostic.record("read-failed", error, observedIdentity);
      const ready = hydration.recoveryReady(error, operation.readyDuringRead, observedIdentity);
      if (!model.accountKey && !operation.reconnectReady && ready && resolution && now() < resolution.deadline) {
        // A ready event arrived while the OLD read still owned pending. Do not
        // lose that event when its port rejects later. Consume it exactly once
        // with an ordinary library read, under the ORIGINAL deadline. Never
        // rebind mutations/navigation or force a new authentication attempt.
        pending = null;
        return refresh({ reconnectReady: ready });
      }
      // Once ownership is known, ordinary local/transport failures do not
      // manufacture an account transition or blank a healthy cached list.
      if (model.accountKey && error?.code !== "CONTEXT_MISMATCH") return null;
      failUnknown(error);
      return null;
    }).finally(() => {
      if (pending !== operation) return;
      pending = null;
      // Initial hydration may have started before its owner's revision event.
      // Only now can that hint authorize a bounded, same-owner local reread.
      scheduleRevisionRead();
    });
    return operation.promise;
  }

  function observeIdentity(event) {
    if (disposed) return;
    const identity = identityOf(event);
    if (!identity || !["ready", "unavailable"].includes(event.phase)
      || (event.phase === "ready" && (typeof event.accountKey !== "string" || !event.accountKey))) return;
    const previous = observedIdentity;
    if (previous?.documentId === identity.documentId && previous.epoch > identity.epoch) return;
    const accountKey = event.phase === "ready" ? event.accountKey : null;
    const transition = event.phase === "unavailable" ? event.transition || null : null;
    const duplicate = sameIdentity(previous, identity) && previous.phase === event.phase && previous.accountKey === accountKey
      && (previous.transition || null) === transition;
    observedIdentity = { ...identity, phase: event.phase, accountKey, transition };
    if (duplicate) return;
    diagnostic.record("identity", null, observedIdentity);
    // Preserve the latest fence without authenticating an invisible document.
    // The first visible read still has to prove this exact document and owner.
    if (!visible && initialRead !== "started") { deferInitialRead(); return; }
    const sameInitialization = !previous || (previous.documentId === identity.documentId
      && (previous.phase !== "ready" || previous.accountKey === event.accountKey));
    if (event.phase === "ready" && !model.accountKey && !pending && failedInitial && sameInitialization) {
      const failed = failedInitial;
      const ready = hydration.recoveryReady(failed.error, observedIdentity, observedIdentity);
      if (!failed.used && ready && visible && now() < failed.deadline) {
        void refresh({ reconnectReady: ready, initialDeadline: failed.deadline });
      }
      // A ready received after an auth/network error does not silently dismiss
      // that error. Explicit retry or a genuine new boundary owns the next read.
      return;
    }
    if (event.phase === "ready" && model.accountKey === event.accountKey && sameIdentity(model.identity, identity)) return;
    if (event.phase === "unavailable") {
      if (transition === "document-hidden") {
        // 旧页面正在离场：立即撤销资料与点击权限，但不再向它读一次账号。
        // 接下来的新文档/ready 事件负责恢复；如果没有接续，原有有限等待给出错误。
        invalidate();
        if (!visible) failUnknown(visibilityError());
        else beginResolution();
        return;
      }
      // Only the very first unowned read can discover the new document. Once
      // any ready/unavailable event fixed an earlier document, never retain it.
      if (!model.accountKey && pending && !pending.documentId && !previous) {
        pending.documentId = identity.documentId;
        return;
      }
      const sameDocument = (model.identity || previous)?.documentId === identity.documentId;
      invalidate();
      if (!visible) { failUnknown(visibilityError()); return; }
      // A new document normally initializes itself. If its ready event is lost,
      // one delayed local read provides an exit, followed by a fixed deadline.
      if (sameDocument) void refresh(); else beginResolution({ recover: true });
      return;
    }
    // Initial ready can arrive before the initial LIBRARY_GET reply. Preserve
    // that shared read; its reply is checked against the newly observed fence.
    const firstOrSameReady = previous?.phase !== "ready"
      || (sameIdentity(previous, identity) && previous.accountKey === event.accountKey);
    if (!model.accountKey && pending && (!pending.documentId || pending.documentId === identity.documentId) && firstOrSameReady) {
      pending.readyDuringRead = observedIdentity;
      return;
    }
    if (pending) invalidate();
    if (model.accountKey) invalidate();
    if (!visible) { failUnknown(visibilityError()); return; }
    void refresh();
  }
  function setVisible(value) {
    if (disposed || visible === Boolean(value)) return;
    visible = Boolean(value);
    if (!visible) {
      if (!model.accountKey && (resolution || pending)) failUnknown(visibilityError());
      else stopResolution();
    } else if (initialRead === "waiting-visibility") void refresh();
    else scheduleRevisionRead();
    // Unknown interrupted state still needs explicit retry. Known ownership
    // stays intact; only an unconsumed revision notification prompts a reread.
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    visible = false;
    invalidate();
  }
  return Object.freeze({ refresh, invalidate, observeIdentity, observeRevision, capture, isCurrent, acceptMutation,
    setVisible, dispose, getState: () => model, getDiagnostic: diagnostic.get });
}
