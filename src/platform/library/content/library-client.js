(function initTidyLibraryClient(global) {
  "use strict";

  const protocol = global.TidyProtocol;
  const bridge = global.TidyContentBridge;
  const hydration = global.TidyLibraryHydration;
  const session = global.TidyPageSession;
  if (!protocol || !bridge || !hydration || !session || global.TidyLibraryClient) return;
  const diagnostic = hydration.createDiagnostic();

  // One document/identity coordinator serves both presenters. A normal SPA
  // route or focus change never clears verified local data or reads auth.
  let generation = 0;
  let library = null;
  let inFlight = null;
  let observedIdentity = null;
  let failedInitial = null;
  let stopped = false;
  let unsubscribeIdentity = null;
  const listeners = new Set();
  const requiredRevisions = new Map();
  const moduleForAction = new Map([
    [protocol.Type.FAVORITES_TOGGLE_SIDEBAR, "favorites"],
    [protocol.Type.BOOKMARKS_TOGGLE_CURRENT, "bookmarks"],
  ]);

  function contextError(message = "The library owner changed. Reload this account's library before continuing.", requestId = null) {
    return Object.assign(new Error(message), { code: "CONTEXT_MISMATCH", tidyCode: "CONTEXT_MISMATCH",
      ...(typeof requestId === "string" && requestId ? { requestId } : {}) });
  }
  function validAccountKey(value) { return typeof value === "string" && value && value === value.trim(); }
  function identityOf(value) {
    return value && typeof value.documentId === "string" && value.documentId && value.documentId.trim() === value.documentId
      && Number.isInteger(value.epoch) && value.epoch >= 0 ? { documentId: value.documentId, epoch: value.epoch } : null;
  }
  function sameIdentity(left, right) {
    return Boolean(left && right && left.documentId === right.documentId && left.epoch === right.epoch);
  }
  function validModule(value, accountKey) {
    return value && value.accountKey === accountKey && Number.isInteger(value.revision) && value.revision >= 0
      && value.items && typeof value.items === "object" && !Array.isArray(value.items) && Array.isArray(value.groups);
  }
  function publish() {
    for (const listener of listeners) notify(listener, library);
  }
  function notify(listener, value) {
    // A broken presenter cannot prevent the other owner from clearing private
    // DOM or make a verified shared read fail. Presenters remain independent.
    try { listener(value); } catch (_) { /* Presentation failure is local. */ }
  }
  function clear() {
    failedInitial = null;
    generation += 1;
    library = null;
    if (inFlight?.timer != null) clearTimeout(inFlight.timer);
    inFlight?.cancel(null);
    inFlight = null;
    // Only a real identity/document boundary removes the previous owner's DOM.
    publish();
  }
  function current() { return session.check() && !stopped ? library : null; }
  function capture(kind = null) {
    if (!current() || (kind && !library[kind])) return null;
    return Object.freeze({ accountKey: library.accountKey, identity: library.identity, generation });
  }
  function owns(lease) {
    return Boolean(session.check() && !stopped && lease && library && lease.generation === generation && lease.accountKey === library.accountKey
      && sameIdentity(lease.identity, library.identity));
  }
  async function runtimeRequest(type, payload, operationCorrelation = null) {
    const envelope = protocol.request(type, payload);
    // 关联当前真正派发的请求；只供调用方验证回包时诊断，不注入业务资料 DTO。
    if (operationCorrelation) operationCorrelation.requestId = envelope.requestId;
    // 关联本次已发出的请求，不从不匹配的响应推断编号；只补充诊断，不参与恢复判断。
    const requestIdentity = typeof envelope.requestId === "string" && envelope.requestId ? { requestId: envelope.requestId } : {};
    let response;
    try { response = await session.runtimeRequest(envelope); }
    catch (error) {
      // Extension reload is terminal for this document, unlike a temporarily
      // missing worker receiver. Keep transient transport recovery separate.
      session.assertActive();
      throw Object.assign(new Error("The library runtime connection was interrupted."), {
        ...requestIdentity,
        code: "ADAPTER_UNAVAILABLE", tidyCode: "ADAPTER_UNAVAILABLE",
        details: { stage: "content.library-runtime-send-message", disconnect: protocol.runtimeDisconnectReason(error) },
      });
    }
    if (!protocol.isResponse(response, envelope.requestId) || response.type !== type) {
      throw Object.assign(contextError("Invalid library response"), requestIdentity);
    }
    if (!response.ok) throw Object.assign(new Error(response.error?.message || "Library request failed"), {
      ...requestIdentity,
      code: response.error?.code || "STORAGE_ERROR", tidyCode: response.error?.code || "STORAGE_ERROR",
      details: response.error?.details || null,
    });
    return response.payload;
  }

  function refresh({ revisionRetry = false, reconnectReady = null, deadline = null } = {}) {
    if (!session.check() || stopped) return Promise.resolve(null);
    if (inFlight) return inFlight.promise;
    failedInitial = null;
    const operation = { generation, documentId: (observedIdentity || library?.identity)?.documentId || null,
      promise: null, needsRevisionRetry: false, readyDuringRead: null, reconnectReady,
      deadline: deadline ?? Date.now() + hydration.INITIAL_DEADLINE_MS, timer: null, cancel: null };
    const cancelled = new Promise(resolve => { operation.cancel = resolve; });
    inFlight = operation;
    diagnostic.record(reconnectReady ? "recovery-read" : "read", null, observedIdentity);
    const ownsRead = () => session.check() && !stopped && generation === operation.generation && inFlight === operation;
    const timeout = new Promise((_, reject) => {
      // Do not shorten the existing account bootstrap transport deadline. Only
      // the extra recovery read spends the remaining initial recovery budget.
      if (reconnectReady && !library) operation.timer = setTimeout(() => reject(Object.assign(Error("Library recovery timed out"), {
        code: "ADAPTER_TIMEOUT", details: { stage: "content.library-initialization" },
      })), Math.max(0, operation.deadline - Date.now()));
    });
    const reply = Promise.resolve().then(() => ownsRead() ? runtimeRequest(protocol.Type.LIBRARY_GET,
      reconnectReady ? { expectedAccountKey: reconnectReady.accountKey, expectedIdentity: identityOf(reconnectReady) } : {}) : null);
    operation.promise = Promise.race([reply, timeout, cancelled]).then((next) => {
      if (!ownsRead()) return null;
      const identity = identityOf(next?.identity);
      if (!validAccountKey(next?.accountKey) || !identity
        || !["favorites", "bookmarks"].every((kind) => next[kind] === null || validModule(next[kind], next.accountKey))) {
        throw contextError("The library response does not belong to one verified account");
      }
      if (observedIdentity && (observedIdentity.documentId !== identity.documentId || observedIdentity.epoch > identity.epoch
        || (sameIdentity(observedIdentity, identity) && observedIdentity.phase === "ready"
          && observedIdentity.accountKey !== next.accountKey))) throw contextError();
      if (reconnectReady && (!sameIdentity(reconnectReady, identity) || reconnectReady.accountKey !== next.accountKey)) throw contextError();
      const minimum = requiredRevisions.get(next.accountKey) || {};
      if (["favorites", "bookmarks"].some((kind) => next[kind] && next[kind].revision < (minimum[kind] || 0))) {
        // A mutation committed while this read was pending. Retry that race at
        // most once; a persistently stale backend stays unavailable, not a loop.
        operation.needsRevisionRetry = !revisionRetry;
        return null;
      }
      const sameOwner = library?.accountKey === next.accountKey && sameIdentity(library.identity, identity);
      const previous = library;
      if (library && !sameOwner) generation += 1;
      const nextLibrary = { ...next, identity: Object.freeze(identity) };
      for (const kind of ["favorites", "bookmarks"]) {
        if (next.errors?.[kind]) diagnostic.record(`${kind}-failed`, next.errors[kind], identity);
        if (sameOwner && previous[kind] && next[kind] && previous[kind].revision >= next[kind].revision) nextLibrary[kind] = previous[kind];
        if (sameOwner && previous[kind] && !next[kind] && next.errors?.[kind]) {
          nextLibrary[kind] = previous[kind]; nextLibrary.errors = { ...nextLibrary.errors, [kind]: null };
        }
      }
      observedIdentity = { ...identity, phase: "ready", accountKey: next.accountKey };
      diagnostic.record("hydrated", null, observedIdentity);
      if (sameOwner && nextLibrary.favorites === previous.favorites && nextLibrary.bookmarks === previous.bookmarks
        && JSON.stringify(nextLibrary.errors) === JSON.stringify(previous.errors)) return library;
      library = nextLibrary;
      publish();
      return library;
    }).catch((error) => {
      if (!ownsRead()) return null;
      diagnostic.record("read-failed", error, observedIdentity);
      const ready = hydration.recoveryReady(error, operation.readyDuringRead, observedIdentity);
      if (!library && !reconnectReady && ready && Date.now() < operation.deadline) {
        // A ready wakeup held behind a failed initial read is consumed ONCE.
        // Keep the original deadline; never force authentication or replay a write.
        if (operation.timer != null) clearTimeout(operation.timer);
        inFlight = null;
        return refresh({ reconnectReady: ready, deadline: operation.deadline });
      }
      if (!library || error?.code === "CONTEXT_MISMATCH") {
        clear();
        failedInitial = { error, deadline: operation.deadline, used: Boolean(reconnectReady) };
      }
      return null;
    }).finally(() => {
      if (operation.timer != null) clearTimeout(operation.timer);
      if (inFlight !== operation) return;
      inFlight = null;
      if (!stopped && session.check() && operation.needsRevisionRetry && generation === operation.generation) {
        void refresh({ revisionRetry: true });
      }
    });
    return operation.promise;
  }

  async function request(type, payload = {}, lease) {
    session.assertActive();
    if (!owns(lease)) throw contextError();
    // Capture the caller's lease before the microtask, then check it again
    // before dispatch. An old click is never silently retargeted to a new owner.
    await Promise.resolve();
    session.assertActive();
    if (!owns(lease)) throw contextError();
    const operationCorrelation = { requestId: null };
    const next = await runtimeRequest(type, { ...payload, expectedAccountKey: lease.accountKey, expectedIdentity: lease.identity }, operationCorrelation);
    session.assertActive();
    if (!owns(lease)) throw contextError(undefined, operationCorrelation.requestId);
    const kind = moduleForAction.get(type);
    if (kind) {
      if (!validModule(next, lease.accountKey)) throw contextError("A mutation returned another account's library", operationCorrelation.requestId);
      // Concurrent writes may complete out of order. An older result may finish
      // its own spinner, but cannot roll the visible module revision backwards.
      if (!library[kind] || next.revision >= library[kind].revision) {
        library = { ...library, [kind]: next };
        publish();
      }
    }
    return next;
  }

  function observeIdentity(event) {
    if (!session.check() || stopped) return;
    const identity = identityOf(event);
    if (!identity || !["ready", "unavailable"].includes(event.phase)
      || (event.phase === "ready" && !validAccountKey(event.accountKey))) return;
    const previous = observedIdentity;
    if (previous?.documentId === identity.documentId && previous.epoch > identity.epoch) return;
    const accountKey = event.phase === "ready" ? event.accountKey : null;
    const transition = event.phase === "unavailable" ? event.transition || null : null;
    const duplicate = sameIdentity(previous, identity) && previous.phase === event.phase && previous.accountKey === accountKey
      && (previous.transition || null) === transition;
    observedIdentity = { ...identity, phase: event.phase, accountKey, transition };
    if (duplicate) return;
    diagnostic.record("identity", null, observedIdentity);
    const sameInitialization = !previous || (previous.documentId === identity.documentId
      && (previous.phase !== "ready" || previous.accountKey === event.accountKey));
    if (event.phase === "ready" && !library && !inFlight && failedInitial && sameInitialization) {
      const failed = failedInitial;
      const ready = hydration.recoveryReady(failed.error, observedIdentity, observedIdentity);
      if (!failed.used && ready && Date.now() < failed.deadline) void refresh({ reconnectReady: ready, deadline: failed.deadline });
      return;
    }
    if (event.phase === "ready" && library?.accountKey === event.accountKey && sameIdentity(library.identity, identity)) return;
    if (event.phase === "unavailable") {
      const sameDocument = (library?.identity || previous)?.documentId === identity.documentId;
      clear();
      // document-hidden 是旧文档离场，不是需要重新初始化的工作区变化。
      // 标记马上清空，下一份文档或 BFCache 的恢复证据再启动读取。
      if (transition === "document-hidden") return;
      // A workspace transition needs one read to initialize its new epoch. A
      // fresh document instead waits for that document's content initialization.
      if (sameDocument) void refresh();
      return;
    }
    const firstOrSameReady = previous?.phase !== "ready"
      || (sameIdentity(previous, identity) && previous.accountKey === event.accountKey);
    if (!library && inFlight && (!inFlight.documentId || inFlight.documentId === identity.documentId) && firstOrSameReady) {
      inFlight.readyDuringRead = observedIdentity;
      return;
    }
    if (library || inFlight) clear();
    void refresh();
  }

  function onRuntimeMessage(envelope) {
    if (!session.check() || stopped) return false;
    if (!protocol.isEnvelope(envelope) || envelope.kind !== protocol.Kind.EVENT) return false;
    if (envelope.type === protocol.Type.LIBRARY_IDENTITY_CHANGED) { observeIdentity(envelope.payload); return false; }
    const kind = envelope.type === protocol.Type.FAVORITES_UPDATED ? "favorites"
      : envelope.type === protocol.Type.BOOKMARKS_UPDATED ? "bookmarks" : null;
    const token = envelope.payload;
    if (!kind || !validAccountKey(token?.accountKey) || !Number.isInteger(token.revision) || token.revision < 0) return false;
    const minimum = requiredRevisions.get(token.accountKey) || {};
    minimum[kind] = Math.max(minimum[kind] || 0, token.revision);
    requiredRevisions.set(token.accountKey, minimum);
    // An event from another tab's account contains no data and is not evidence
    // that this tab switched owners. A same-owner change refreshes only local
    // storage and retains the committed rows while that read is pending.
    if (library?.accountKey === token.accountKey && (!library[kind] || token.revision > library[kind].revision)) {
      void refresh();
    }
    return false;
  }

  function onLocalIdentity(event) {
    if (!session.check() || stopped) return;
    // Main-world detects the boundary before the worker sees it. Revoke old
    // clicks immediately, but let the worker event start the next verified read.
    // The first ready/unavailable notification must not cancel initial loading.
    if (library && (event?.phase === "unavailable" || (event?.phase === "ready"
      && (event.accountKey !== library.accountKey || event.epoch !== library.identity.epoch)))) clear();
  }
  function onPageShow(event) { if (event.persisted) void refresh(); }
  function dispose() {
    if (stopped) return;
    stopped = true;
    // Revoke leases before notifying presenters, and settle/cancel reads so a
    // late worker reply can never restore data or restart a recovery timer.
    clear();
    listeners.clear();
    requiredRevisions.clear();
    observedIdentity = null;
    unsubscribeIdentity?.();
    unsubscribeIdentity = null;
    global.removeEventListener("pagehide", clear);
    global.removeEventListener("pageshow", onPageShow);
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch (_) { /* Old extension context. */ }
  }
  session.onDispose(dispose);
  if (session.check()) {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    unsubscribeIdentity = bridge.onLibraryIdentityChanged?.(onLocalIdentity);
    global.addEventListener("pagehide", clear);
    global.addEventListener("pageshow", onPageShow);
  }

  global.TidyLibraryClient = Object.freeze({
    current, capture, owns, request, refresh, getDiagnostic: diagnostic.get,
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("Library subscriber must be a function");
      if (!session.check() || stopped) { notify(listener, null); return () => {}; }
      listeners.add(listener);
      notify(listener, current());
      return () => listeners.delete(listener);
    },
  });
  void refresh();
})(globalThis);
