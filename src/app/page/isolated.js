// 页面与扩展之间的消息桥：检查协议并转发请求/结果，不在这里决定产品规则。
// MAIN 与网页共享环境；带 channel 的消息只是路由标记，不能代替后台的身份与权限校验。
(function initTidyIsolatedBridge() {
  "use strict";

  const protocol = globalThis.TidyProtocol;
  const session = globalThis.TidyPageSession;
  const snapshotContract = globalThis.TidySnapshot;
  const searchContract = globalThis.TidySearch;
  const dateSearchContract = globalThis.TidyDateSearch;
  const exportContract = globalThis.TidyExportContract;
  if (
    !protocol
    || !snapshotContract
    || !searchContract
    || !dateSearchContract
    || !exportContract
    || globalThis.__tidyIsolatedStarted
  ) return;
  globalThis.__tidyIsolatedStarted = true;

  const SOURCE = "chatgpt-isolated";
  document.documentElement.dataset.tidyIsolated = "ready";
  const pending = new Map();
  const snapshotListeners = new Set();
  const libraryIdentityListeners = new Set();

  function postToMain(envelope) {
    session.assertActive();
    window.postMessage(
      { channel: protocol.WINDOW_CHANNEL, source: SOURCE, envelope },
      window.location.origin,
    );
  }

  function requestMain(type, payload = null, timeoutMs = protocol.DEFAULT_TIMEOUT_MS) {
    if (!session.check()) return Promise.reject(session.error());
    const envelope = protocol.request(type, payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(envelope.requestId);
        reject(Object.assign(new Error("ChatGPT adapter timed out"), {
          tidyCode: protocol.ErrorCode.ADAPTER_TIMEOUT,
          stage: "content.isolated.request-main-timeout",
        }));
      }, timeoutMs);
      pending.set(envelope.requestId, { resolve, reject, timer });
      try {
        postToMain(envelope);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(envelope.requestId);
        reject(Object.assign(new Error("The ChatGPT page bridge is unavailable"), {
          tidyCode: protocol.ErrorCode.ADAPTER_UNAVAILABLE,
          stage: "content.isolated.post-main",
          cause: error,
        }));
      }
    });
  }

  function onWindowMessage(event) {
    if (!session.check()) return;
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (data?.channel !== protocol.WINDOW_CHANNEL || data?.source !== "chatgpt-main-world") return;
    const envelope = data.envelope;
    if (!protocol.isEnvelope(envelope)) return;

    if (envelope.kind === protocol.Kind.RESPONSE) {
      const waiting = pending.get(envelope.requestId);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      pending.delete(envelope.requestId);
      if (envelope.ok && envelope.type === protocol.Type.GET_SNAPSHOT) {
        const validation = snapshotContract.validate(envelope.payload);
        if (validation.valid) waiting.resolve(envelope.payload);
        else waiting.reject(new Error(`Invalid snapshot: ${validation.errors.join(", ")}`));
      } else if (envelope.ok && envelope.type === protocol.Type.SEARCH_MESSAGES) {
        const validation = searchContract.validatePage(envelope.payload);
        if (validation.valid) waiting.resolve(envelope.payload);
        else waiting.reject(Object.assign(new Error(`Invalid search page: ${validation.errors.join(", ")}`), {
          tidyCode: protocol.ErrorCode.SEARCH_UNAVAILABLE,
        }));
      } else if (envelope.ok && envelope.type === protocol.Type.DATE_INDEX_SOURCE_PAGE) {
        if (dateSearchContract.validateSourcePage(envelope.payload)) waiting.resolve(envelope.payload);
        else waiting.reject(Object.assign(new Error("Invalid date-index source page"), {
          tidyCode: protocol.ErrorCode.DATE_INDEX_UNAVAILABLE,
        }));
      } else if (envelope.ok && envelope.type === protocol.Type.EXPORT_CURRENT_CONVERSATION) {
        const validation = exportContract.validateDocument(envelope.payload);
        if (validation.valid) waiting.resolve(envelope.payload);
        else waiting.reject(Object.assign(new Error(`Invalid export document: ${validation.errors.join(", ")}`), {
          tidyCode: protocol.ErrorCode.EXPORT_UNAVAILABLE,
        }));
      } else if (envelope.ok && envelope.type === protocol.Type.EXPORT_CONVERSATIONS) {
        const validation = exportContract.validateCollection(envelope.payload);
        if (validation.valid) waiting.resolve(envelope.payload);
        else waiting.reject(Object.assign(new Error(`Invalid export collection: ${validation.errors.join(", ")}`), {
          tidyCode: protocol.ErrorCode.EXPORT_UNAVAILABLE,
        }));
      } else if (envelope.ok) waiting.resolve(envelope.payload);
      else waiting.reject(Object.assign(new Error(envelope.error?.message || "Adapter request failed"), {
        tidyCode: envelope.error?.code,
        details: envelope.error?.details || null,
      }));
      return;
    }

    if (envelope.kind === protocol.Kind.EVENT && envelope.type === protocol.Type.LIBRARY_IDENTITY_CHANGED) {
      // Quarantine old page decorations immediately; the worker adds trusted
      // tab/document ownership before sending the reload signal back to us.
      for (const listener of libraryIdentityListeners) {
        try { listener(envelope.payload); } catch { /* Independent presenter. */ }
      }
      session.runtimeRequest(envelope).catch(() => {});
      return;
    }
    if (envelope.kind === protocol.Kind.EVENT && [protocol.Type.TITLE_CHANGED, protocol.Type.NAVIGATION_CANCELLED, protocol.Type.NAVIGATION_RESULT].includes(envelope.type)) {
      // Worker 以浏览器提供的标签页/文档身份核验单条改名或导航事件；
      // 页面只传目标及结果，不能指定可信的发送者身份。
      session.runtimeRequest(envelope).catch(() => {});
      return;
    }
    if (envelope.kind === protocol.Kind.EVENT && envelope.type === protocol.Type.SNAPSHOT_UPDATED) {
      // 页面事件与请求回包使用同一快照合同；坏数据不能先污染本地呈现器。
      const snapshot = envelope.payload?.snapshot;
      if (!snapshotContract.validate(snapshot).valid) return;
      const reason = typeof envelope.payload?.reason === "string" ? envelope.payload.reason : "adapter-event";
      for (const listener of snapshotListeners) {
        try {
          listener(snapshot, reason);
        } catch {
          // One presentation subscriber must not break the adapter relay.
        }
      }
      // 只转发业务字段，不把页面声明的 tabId/documentId 当作发送者身份。
      session.runtimeRequest(protocol.event(protocol.Type.SNAPSHOT_UPDATED, {
        snapshot, reason,
      })).catch(() => {
        // The service worker may be asleep between mutations; a later panel
        // request always asks this exact tab for a fresh snapshot.
      });
    }
  }
  window.addEventListener("message", onWindowMessage);

  function onRuntimeMessage(envelope, _sender, sendResponse) {
    if (!session.check()) return false;
    if (
      !protocol.isRequest(envelope) ||
      ![
        protocol.Type.PAGE_SESSION_PROBE,
        protocol.Type.GET_SNAPSHOT,
        protocol.Type.LOCATE_MESSAGE,
        protocol.Type.NAVIGATION_INTENT,
        protocol.Type.SEARCH_MESSAGES,
        protocol.Type.DATE_INDEX_ACCOUNT,
        protocol.Type.LIBRARY_ACCOUNT,
        protocol.Type.LIBRARY_NAVIGATE,
        protocol.Type.DATE_INDEX_SOURCE_PAGE,
        protocol.Type.EXPORT_CURRENT_CONVERSATION,
        protocol.Type.EXPORT_CONVERSATIONS,
        protocol.Type.EXPORT_IMAGE_RESOURCE,
        protocol.Type.TITLE_READ_CURRENT,
        protocol.Type.TITLE_WRITE_CURRENT,
        protocol.Type.TITLE_BATCH_EXECUTION_BEGIN,
        protocol.Type.TITLE_BATCH_EXECUTION_END,
      ].includes(envelope.type)
    ) return false;
    // 关键词交接会等待官方路由确认，不能被普通 4 秒 IPC 计时器抢先判失败。
    // Worker 提供点击时冻结的绝对加载截止；桥只追加回包宽限，不重置业务预算。
    const nativeSearch = envelope.type === protocol.Type.LIBRARY_NAVIGATE && envelope.payload?.placement === "native-search";
    const remainingNavigationMs = Number.isFinite(envelope.payload?.loadDeadlineAt)
      ? Math.max(0, Math.min(60_000, envelope.payload.loadDeadlineAt - Date.now())) : 0;
    const timeoutMs = nativeSearch ? remainingNavigationMs + protocol.DEFAULT_TIMEOUT_MS
      : envelope.type === protocol.Type.EXPORT_CONVERSATIONS
      ? 120_000
      : [
          protocol.Type.SEARCH_MESSAGES,
          protocol.Type.DATE_INDEX_SOURCE_PAGE,
          protocol.Type.LIBRARY_ACCOUNT,
          protocol.Type.EXPORT_CURRENT_CONVERSATION,
          protocol.Type.EXPORT_IMAGE_RESOURCE,
          protocol.Type.TITLE_READ_CURRENT,
          protocol.Type.TITLE_WRITE_CURRENT,
          protocol.Type.TITLE_BATCH_EXECUTION_BEGIN,
          protocol.Type.TITLE_BATCH_EXECUTION_END,
        ].includes(envelope.type) ? 60_000 : protocol.DEFAULT_TIMEOUT_MS;
    requestMain(envelope.type, envelope.payload, timeoutMs)
      .then((payload) => {
        session.assertActive();
        sendResponse(protocol.response(envelope, payload));
      })
      .catch((error) => {
        if (!session.check()) return;
        sendResponse(
          protocol.failure(
            envelope,
            error.tidyCode || (
              envelope.type === protocol.Type.SEARCH_MESSAGES
                ? protocol.ErrorCode.SEARCH_UNAVAILABLE
              : [protocol.Type.DATE_INDEX_ACCOUNT, protocol.Type.DATE_INDEX_SOURCE_PAGE].includes(envelope.type)
                ? protocol.ErrorCode.DATE_INDEX_UNAVAILABLE
              : [protocol.Type.EXPORT_CURRENT_CONVERSATION, protocol.Type.EXPORT_CONVERSATIONS, protocol.Type.EXPORT_IMAGE_RESOURCE].includes(envelope.type)
                  ? protocol.ErrorCode.EXPORT_UNAVAILABLE
                : protocol.ErrorCode.ADAPTER_TIMEOUT
            ),
            error.message || "ChatGPT adapter timed out",
            error.details || (error.stage ? { stage: error.stage } : null),
          ),
        );
      });
    return true;
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  session.onDispose(() => {
    window.removeEventListener("message", onWindowMessage);
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* Context already invalidated. */ }
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(session.error());
    }
    pending.clear();
    snapshotListeners.clear();
    libraryIdentityListeners.clear();
    document.documentElement.dataset.tidyIsolated = "retired";
  });

  // Read-only page presentation modules share this one adapter request path.
  // They may locate DOM nodes from DTO locators, but must not establish a
  // second Fiber/data-reading pipeline.
  globalThis.TidyContentBridge = Object.freeze({
    requestMain,
    onLibraryIdentityChanged(listener) {
      if (!session.check()) return () => {};
      if (typeof listener !== "function") return () => {};
      libraryIdentityListeners.add(listener);
      return () => libraryIdentityListeners.delete(listener);
    },
    onSnapshot(listener) {
      if (!session.check()) return () => {};
      if (typeof listener !== "function") return () => {};
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
  });
})();
