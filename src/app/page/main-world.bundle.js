// GENERATED FILE. Do not edit by hand.
// Run `node tools/build-main-world.cjs` after changing protocol, snapshot, route, or adapter sources.
// Source: src/platform/protocol.js
(function initTidyProtocol(global) {
  "use strict";

  if (global.TidyProtocol) return;

  const VERSION = "tidy.protocol.v1";
  const WINDOW_CHANNEL = "chatgpt-tidy.window.v1";
  const FAVORITES_FILING_PORT = "chatgpt-tidy.favorites-filing.v1";
  const BOOKMARKS_FILING_PORT = "chatgpt-tidy.bookmarks-filing.v1";
  const DEFAULT_TIMEOUT_MS = 4_000;

  const Kind = Object.freeze({
    REQUEST: "request",
    RESPONSE: "response",
    EVENT: "event",
  });

  const Type = Object.freeze({
    // 无账号、无网络副作用的当前文档完整桥握手。不是缓存快照，也不授予身份权限。
    PAGE_SESSION_PROBE: "page-session.probe",
    GET_ACTIVE_CONTEXT: "snapshot.get-active-context",
    GET_SNAPSHOT: "snapshot.get",
    LOCATE_MESSAGE: "snapshot.message-locate",
    SNAPSHOT_UPDATED: "snapshot.updated",
    CONTEXT_CHANGED: "context.changed",
    // One ordered, tab/document-scoped navigation owner shared by search,
    // favorites, bookmarks and native cancellation. Controls contain no auth.
    NAVIGATION_INTENT: "navigation.intent",
    NAVIGATION_CANCELLED: "navigation.cancelled",
    // Terminal message-location receipt, not OPEN/pending/highlight success.
    NAVIGATION_RESULT: "navigation.result",
    PREFERENCES_GET: "preferences.get",
    PREFERENCES_UPDATE: "preferences.update",
    PREFERENCES_UPDATED: "preferences.updated",
    TITLE_RULES_GET: "title-rules.get",
    TITLE_RULES_UPDATE: "title-rules.update",
    // Local libraries have a user + workspace owner, independently of the
    // directory API's workspace/catalog key. Never infer it from a chat ID.
    LIBRARY_ACCOUNT: "library.account",
    // Identity events carry only an opaque owner/document epoch, never tokens
    // or library contents. Ordinary SPA navigation does not change this lease.
    LIBRARY_IDENTITY_CHANGED: "library.identity-changed",
    LIBRARY_NAVIGATE: "library.navigate",
    LIBRARY_GET: "library.get",
    // 只在扩展侧栏与 Worker 之间流转，不转发给 ChatGPT 页面。
    LIBRARY_BACKUP_EXPORT: "library.backup-export",
    LIBRARY_BACKUP_PREVIEW: "library.backup-preview",
    LIBRARY_BACKUP_RESTORE: "library.backup-restore",
    LIBRARY_BACKUP_DISCARD: "library.backup-discard",
    FAVORITES_GET: "favorites.get",
    FAVORITES_TOGGLE_CURRENT: "favorites.toggle-current",
    FAVORITES_TOGGLE_SIDEBAR: "favorites.toggle-sidebar",
    FAVORITES_REMOVE: "favorites.remove",
    FAVORITES_MOVE: "favorites.move",
    FAVORITES_GROUP_CREATE: "favorites.group-create",
    FAVORITES_GROUP_UPDATE: "favorites.group-update",
    FAVORITES_GROUP_DELETE: "favorites.group-delete",
    FAVORITES_GROUP_REORDER: "favorites.group-reorder",
    FAVORITES_VIEW_UPDATE: "favorites.view-update",
    FAVORITES_OPEN: "favorites.open",
    FAVORITES_UPDATED: "favorites.updated",
    FAVORITES_FILING_CONTEXT: "favorites.filing-context",
    BOOKMARKS_GET: "bookmarks.get",
    BOOKMARKS_TOGGLE_CURRENT: "bookmarks.toggle-current",
    BOOKMARKS_REMOVE: "bookmarks.remove",
    BOOKMARKS_MOVE: "bookmarks.move",
    BOOKMARKS_GROUP_CREATE: "bookmarks.group-create",
    BOOKMARKS_GROUP_UPDATE: "bookmarks.group-update",
    BOOKMARKS_GROUP_DELETE: "bookmarks.group-delete",
    BOOKMARKS_GROUP_REORDER: "bookmarks.group-reorder",
    BOOKMARKS_VIEW_UPDATE: "bookmarks.view-update",
    BOOKMARKS_OPEN: "bookmarks.open",
    BOOKMARKS_UPDATED: "bookmarks.updated",
    BOOKMARKS_FILING_CONTEXT: "bookmarks.filing-context",
    BOOKMARKS_OPEN_CONVERSATION_VIEW: "bookmarks.open-conversation-view",
    SEARCH_MESSAGES: "search.messages",
    SEARCH_OPEN_RESULT: "search.open-result",
    DATE_INDEX_ACCOUNT: "date-index.account",
    DATE_INDEX_SOURCE_PAGE: "date-index.source-page",
    EXPORT_CURRENT_CONVERSATION: "export.current-conversation",
    EXPORT_CONVERSATIONS: "export.conversations",
    EXPORT_IMAGE_RESOURCE: "export.image-resource",
    EXPORT_PREVIEW_OPEN: "export.preview-open",
    EXPORT_PREVIEW_CLOSE: "export.preview-close",
    EXPORT_PREVIEW_CLOSED: "export.preview-closed",
    EXPORT_JOB_START: "export.job-start",
    EXPORT_JOB_STATUS: "export.job-status",
    EXPORT_JOB_CANCEL: "export.job-cancel",
    EXPORT_JOB_DISMISS: "export.job-dismiss",
    EXPORT_JOB_CHANGED: "export.job-changed",
    PANEL_ROUTE_REQUESTED: "panel.route-requested",
    TITLE_PREVIEW: "titles.preview",
    // Worker-local options planning against an authenticated frozen context.
    // This message never crosses the content-script / ChatGPT bridge.
    TITLE_REPLAN: "titles.replan",
    TITLE_APPLY: "titles.apply",
    TITLE_STATUS: "titles.status",
    TITLE_RECONCILE: "titles.reconcile",
    TITLE_BATCH_PREVIEW: "titles.batch.preview",
    TITLE_BATCH_RETRY_PREVIEW: "titles.batch.retry-preview",
    TITLE_BATCH_REPLAN: "titles.batch.replan",
    TITLE_BATCH_APPLY: "titles.batch.apply",
    TITLE_BATCH_STEP: "titles.batch.step",
    TITLE_BATCH_STATUS: "titles.batch.status",
    TITLE_BATCH_RECONCILE: "titles.batch.reconcile",
    TITLE_RETURN_OWNER: "titles.return-owner",
    TITLE_CHANGED: "titles.changed",
    TITLE_CATALOG_CHANGED: "titles.catalog-changed",
    // Internal adapter operations are not accepted as Side Panel commands.
    TITLE_READ_CURRENT: "titles.adapter.read-current",
    TITLE_WRITE_CURRENT: "titles.adapter.write-current",
    TITLE_BATCH_EXECUTION_BEGIN: "titles.adapter.batch-begin",
    TITLE_BATCH_EXECUTION_END: "titles.adapter.batch-end",
  });

  const ErrorCode = Object.freeze({
    INVALID_ENVELOPE: "INVALID_ENVELOPE",
    INVALID_REQUEST: "INVALID_REQUEST",
    UNSUPPORTED_TYPE: "UNSUPPORTED_TYPE",
    UNSUPPORTED_PAGE: "UNSUPPORTED_PAGE",
    TAB_UNAVAILABLE: "TAB_UNAVAILABLE",
    ADAPTER_UNAVAILABLE: "ADAPTER_UNAVAILABLE",
    ADAPTER_TIMEOUT: "ADAPTER_TIMEOUT",
    SEARCH_UNAVAILABLE: "SEARCH_UNAVAILABLE",
    DATE_INDEX_UNAVAILABLE: "DATE_INDEX_UNAVAILABLE",
    EXPORT_UNAVAILABLE: "EXPORT_UNAVAILABLE",
    // 明确观察到当前回复进行中；是可恢复读取状态，不是导出文档的一部分。
    EXPORT_RESPONSE_PENDING: "EXPORT_RESPONSE_PENDING",
    TITLE_UNAVAILABLE: "TITLE_UNAVAILABLE",
    PERSISTENCE_REJECTED: "PERSISTENCE_REJECTED",
    CONTEXT_MISMATCH: "CONTEXT_MISMATCH",
    NOT_FOUND: "NOT_FOUND",
    VALIDATION_ERROR: "VALIDATION_ERROR",
    STORAGE_ERROR: "STORAGE_ERROR",
    INTERNAL_ERROR: "INTERNAL_ERROR",
  });

  function createRequestId(prefix = "req") {
    const uuid = global.crypto?.randomUUID?.();
    return `${prefix}-${uuid || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  }

  function request(type, payload = null, requestId = createRequestId()) {
    return { protocol: VERSION, kind: Kind.REQUEST, type, requestId, payload };
  }

  function response(requestEnvelope, payload = null) {
    return {
      protocol: VERSION,
      kind: Kind.RESPONSE,
      type: requestEnvelope.type,
      requestId: requestEnvelope.requestId,
      ok: true,
      payload,
    };
  }

  function failure(requestEnvelope, code, message, details = null) {
    return {
      protocol: VERSION,
      kind: Kind.RESPONSE,
      type: requestEnvelope?.type || "unknown",
      requestId: requestEnvelope?.requestId || createRequestId("error"),
      ok: false,
      error: { code, message, details },
    };
  }

  function event(type, payload = null) {
    return {
      protocol: VERSION,
      kind: Kind.EVENT,
      type,
      requestId: createRequestId("event"),
      payload,
    };
  }

  function isEnvelope(value) {
    return Boolean(
      value &&
        value.protocol === VERSION &&
        Object.values(Kind).includes(value.kind) &&
        typeof value.type === "string" &&
        typeof value.requestId === "string",
    );
  }

  function isRequest(value, type) {
    return isEnvelope(value) && value.kind === Kind.REQUEST && (!type || value.type === type);
  }

  function isResponse(value, requestId) {
    return (
      isEnvelope(value) &&
      value.kind === Kind.RESPONSE &&
      (!requestId || value.requestId === requestId)
    );
  }

  // Only browser runtime transport rejections belong to this classification.
  // Do not infer a reconnect from HTTP/auth errors, generic timeouts or a
  // CONTEXT_MISMATCH response. Call this at runtime.sendMessage boundaries.
  function runtimeDisconnectReason(error) {
    const message = String(error?.message || "").trim().replace(/\.$/, "");
    if (message === "Extension context invalidated") return "context-invalidated";
    if (message === "Could not establish connection. Receiving end does not exist") return "receiver-missing";
    if (message === "The message port closed before a response was received"
      || message === "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received") return "connection-closed";
    return null;
  }

  global.TidyProtocol = Object.freeze({
    VERSION,
    WINDOW_CHANNEL,
    FAVORITES_FILING_PORT,
    BOOKMARKS_FILING_PORT,
    DEFAULT_TIMEOUT_MS,
    Kind,
    Type,
    ErrorCode,
    createRequestId,
    request,
    response,
    failure,
    event,
    isEnvelope,
    isRequest,
    isResponse,
    runtimeDisconnectReason,
  });
})(globalThis);

// Source: src/platform/session/shared/page-session.js
// 一个网页文档只有一次扩展生命周期。账号切换、SPA 路由和 Worker 休眠不结束它；
// 扩展上下文失效后不可复活，必须由浏览器刷新/新建文档重新加载完整脚本。
(function initPageSessionContract(global) {
  "use strict";

  const ATTRIBUTE = "data-tidy-page-session";
  const RETIRED_EVENT = "chatgpt-tidy:page-session-retired";
  const CHECK_EVENT = "chatgpt-tidy:page-session-check";
  // 只检查本地 runtime.id，不发消息、不唤醒 Worker，不扫描页面 DOM。
  const INVALIDATION_CHECK_MS = 1000;

  function create({ runtime = null, watch = false } = {}) {
    const controller = new AbortController();
    const disposers = new Set();
    let retired = false;
    let interval = null;
    let suppressPointerClick = false;
    const document = global.document;

    function error() {
      return Object.assign(new Error("The extension was reloaded. Refresh the ChatGPT page."), {
        code: "ADAPTER_UNAVAILABLE", tidyCode: "ADAPTER_UNAVAILABLE",
        details: { stage: "page-session", disconnect: "context-invalidated" },
      });
    }

    function stop() {
      if (retired) return;
      // 先关闭总闸，再通知取消和清理。清理触发的 observer/Promise 不能重建 UI。
      retired = true;
      if (interval !== null) global.clearInterval(interval);
      interval = null;
      document?.documentElement?.setAttribute(ATTRIBUTE, "retired");
      document?.removeEventListener?.(RETIRED_EVENT, stop);
      if (runtime) document?.removeEventListener?.(CHECK_EVENT, check);
      // DOM 标记/事件只传播停机状态，绝不是可信账号身份或权限凭据。
      document?.dispatchEvent?.(new Event(RETIRED_EVENT));
      controller.abort(error());
      for (const dispose of [...disposers]) {
        try { dispose(); } catch { /* 一个模块清理失败不能阻止其他模块退役。 */ }
      }
      disposers.clear();
    }

    function check() {
      if (retired) return false;
      // MAIN 无扩展 API。每个副作用/异步续程都同步让 ISOLATED 验 runtime.id，
      // 不能等下一秒 watchdog 才发现重载。此 DOM 事件不发 IPC，也不唤醒 Worker。
      if (!runtime) document?.dispatchEvent?.(new Event(CHECK_EVENT));
      if (retired) return false;
      let runtimeValid = true;
      if (runtime) {
        try { runtimeValid = Boolean(runtime.id); } catch { runtimeValid = false; }
      }
      if (!runtimeValid || document?.documentElement?.getAttribute(ATTRIBUTE) === "retired") {
        stop();
        return false;
      }
      return true;
    }

    function assertActive() { if (!check()) throw error(); }

    function onDispose(dispose) {
      if (retired) { dispose(); return () => {}; }
      disposers.add(dispose);
      return () => disposers.delete(dispose);
    }

    async function runtimeRequest(envelope) {
      assertActive();
      let release;
      try {
        const response = await new Promise((resolve, reject) => {
          const abort = () => reject(error());
          controller.signal.addEventListener("abort", abort, { once: true });
          release = () => controller.signal.removeEventListener("abort", abort);
          // 同步 dispatch，不把写操作排进可能在停机后才执行的微任务。
          try {
            Promise.resolve(runtime.sendMessage(envelope)).then(resolve, reject);
          } catch (cause) {
            // Chrome 可同步抛失效；同一个启动栈中的后续模块也必须立刻看到停机。
            if (/extension context invalidated/i.test(String(cause?.message || cause))) stop();
            reject(cause);
          }
        });
        assertActive();
        return response;
      } catch (cause) {
        // Port/Worker 临时断连不等于扩展重载；仅明确上下文失效才永久停机。
        if (/extension context invalidated/i.test(String(cause?.message || cause))) stop();
        assertActive();
        throw cause;
      } finally {
        release?.();
      }
    }

    function guardInteraction(event) {
      // 必须在 check 的清理移除节点前记录归属，防旧星星点击穿透到原生会话链接。
      const owned = event.composedPath?.().some(node => node?.hasAttribute?.("data-tidy-owned"))
        || Boolean(event.target?.closest?.("[data-tidy-owned]"));
      const active = check();
      // 移除旧按钮可能让随后的 click 重新命中下方原生链接；同一手势仍须取消。
      if (event.type === "pointerdown") suppressPointerClick = !active && owned;
      const blocked = !active && (owned || (event.type === "click" && suppressPointerClick));
      if (event.type === "click") suppressPointerClick = false;
      if (blocked) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }

    document?.addEventListener?.(RETIRED_EVENT, stop);
    if (runtime) document?.addEventListener?.(CHECK_EVENT, check);
    if (check()) document?.documentElement?.setAttribute(ATTRIBUTE, "active");
    if (runtime && watch && check()) {
      const events = ["pointerdown", "mousedown", "click", "keydown"];
      for (const name of events) global.addEventListener(name, guardInteraction, true);
      const verify = () => check();
      global.addEventListener("focus", verify, true);
      global.addEventListener("pageshow", verify, true);
      document.addEventListener("visibilitychange", verify, true);
      interval = global.setInterval(verify, INVALIDATION_CHECK_MS);
      onDispose(() => {
        // 保留交互捕获门禁：已经开始的 pointer 序列和分离节点上的 click 仍须吞掉。
        // document 销毁会一起释放它；原生目标始终透传。
        global.removeEventListener("focus", verify, true);
        global.removeEventListener("pageshow", verify, true);
        document.removeEventListener("visibilitychange", verify, true);
      });
    }
    return Object.freeze({ check, assertActive, onDispose, stop, error,
      runtimeRequest, signal: controller.signal });
  }

  global.TidyPageSessionContract = Object.freeze({ create, ATTRIBUTE, RETIRED_EVENT, CHECK_EVENT, INVALIDATION_CHECK_MS });
})(globalThis);

// Source: src/platform/session/chatgpt/page-session.js
// MAIN 跟随同一文档的 ISOLATED 停机信号，不能靠旧的 ready DOM 标记恢复。
globalThis.TidyPageSession = globalThis.TidyPageSessionContract.create();

// Source: src/platform/navigation/navigation-identity.js
(function initTidyNavigationIdentity(global) {
  "use strict";
  if (global.TidyNavigationIdentity) return;

  const isInitializing = transition => transition === "workspace-unconfirmed" || transition === "workspace-restored";

  /**
   * Pure presentation contract, shared by the worker and its page executor.
   * A data lease is NEVER kept alive here. Waiting retains only the explicit
   * command; no DOM effect or success is allowed until its owner is confirmed.
   * Callers keep cancellation tombstones, so A -> B -> A cannot revive a click.
   */
  function state(identity, ownerAccountKey) {
    if (identity?.phase === "ready" && typeof identity.accountKey === "string" && identity.accountKey) {
      return !ownerAccountKey || ownerAccountKey === identity.accountKey ? "ready" : "revoked";
    }
    if (identity?.phase === "unavailable") {
      // A new, browser-proven document has not observed its first identity yet.
      if (identity.epoch === 0 && !identity.transition) return "waiting";
      if (ownerAccountKey && isInitializing(identity.transition)) return "waiting";
    }
    return "revoked";
  }

  // Product policy: cold native conversation loading is separate from landing.
  // Live long-history loads exceed 12 s; allow at most 30 s to obtain a usable
  // exact target, then the existing 2.4 s geometry window. Worker stamps both
  // absolute deadlines once. Neither ready nor document handoff can renew them.
  global.TidyNavigationIdentity = Object.freeze({ state, isInitializing,
    // 无刷新导航含路由切换和消息/末尾定位，最多尝试 6 秒；失败整页补载一次。
    // 账号等待不会触发补载；成功立即结束。全程仍共用同一份 30 秒加载预算。
    NATIVE_TARGET_WINDOW_MS: 6_000,
    LOAD_WINDOW_MS: 30_000, LANDING_WINDOW_MS: 2_400 });
})(globalThis);

// Source: src/platform/snapshot.js
(function initTidySnapshotContract(global) {
  "use strict";

  if (global.TidySnapshot) return;

  const VERSION = "chatgpt-tidy.snapshot.v1";
  const FIELD_STATUS = Object.freeze(["available", "provisional", "partial", "missing", "unsupported"]);
  const IDENTITY_STATUS = Object.freeze(["stable", "resolving", "draft", "empty", "unavailable"]);
  // unbound：没有会话；route-only：仅网址可确认；bound：数据归属已确认；mismatch：排除错会话数据。
  const BINDING_STATUS = Object.freeze(["unbound", "route-only", "bound", "mismatch"]);
  const MESSAGE_ID_STATUS = Object.freeze(["stable", "provisional"]);
  const MESSAGE_PRESENTATION_STATUS = Object.freeze(["formal", "transient"]);
  const COLOR_SCHEMES = Object.freeze(["light", "dark"]);
  // Keep snapshot events and bookmark storage bounded even when a ChatGPT
  // message contains a very large answer. The Adapter owns excerpt creation;
  // feature modules must never read message bodies from the page again.
  const MAX_MESSAGE_EXCERPT_LENGTH = 320;

  // 项目网址可以在 32 位编号后附加可读名称；名称不是接口中的项目 ID。
  // 只拆已确认的完整编号，不能随意按连字符切短未知格式或相似编号。
  function projectIdFromSegment(value) {
    if (typeof value !== "string" || !/^g-p-[A-Za-z0-9_-]+$/.test(value)) return null;
    return /^(g-p-[a-f0-9]{32})(?:-[A-Za-z0-9_-]+)?$/.exec(value)?.[1] || value;
  }

  // Saved library records and their UI eligibility share this exact grammar.
  // Readable custom-GPT/share/draft pages are not automatically writable chats.
  function parseConversationPath(pathname) {
    if (typeof pathname !== "string") return null;
    const ordinary = /^\/c\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
    const project = /^\/g\/(g-p-[A-Za-z0-9_-]+)\/c\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
    if ((!ordinary && !project) || (ordinary || project)[0] !== pathname) return null;
    return {
      conversationId: ordinary ? ordinary[1] : project[2],
      projectId: project ? projectIdFromSegment(project[1]) : null,
      // 页面归属仍保留真实路径；规范项目 ID 不会改地址或放宽路径检查。
      pathname: pathname.replace(/\/$/, ""),
    };
  }

  // Do not let URL normalization repair credentials, ports or dot segments.
  function canonicalConversationPath(value, conversationId) {
    if (typeof value !== "string" || typeof conversationId !== "string" || !conversationId) return null;
    const path = value.startsWith("https://chatgpt.com/")
      ? value.slice("https://chatgpt.com".length) : value;
    const parsed = parseConversationPath(path.split(/[?#]/, 1)[0]);
    return parsed?.conversationId === conversationId ? parsed.pathname : null;
  }

  function isNullableString(value) {
    return value === null || typeof value === "string";
  }

  function isSourcedField(field) {
    return Boolean(
      field &&
        isNullableString(field.value) &&
        isNullableString(field.source) &&
        FIELD_STATUS.includes(field.status),
    );
  }

  function isSafeRgb(value) {
    if (value === null) return true;
    const match = typeof value === "string" && value.match(/^rgb\((\d{1,3}), (\d{1,3}), (\d{1,3})\)$/);
    return Boolean(match && match.slice(1).every((channel) => Number(channel) <= 255));
  }

  function validateSidebarConversation(conversation, index, errors) {
    const prefix = `sidebarConversations[${index}]`;
    if (typeof conversation?.conversationId !== "string" || !conversation.conversationId) {
      errors.push(`${prefix}.conversationId`);
    }
    if (!IDENTITY_STATUS.includes(conversation?.identityStatus)) {
      errors.push(`${prefix}.identityStatus`);
    }
    if (!BINDING_STATUS.includes(conversation?.bindingStatus)) {
      errors.push(`${prefix}.bindingStatus`);
    }
    if (typeof conversation?.kind !== "string") errors.push(`${prefix}.kind`);
    for (const key of ["title", "createdAt", "updatedAt"]) {
      if (!isSourcedField(conversation?.[key])) errors.push(`${prefix}.${key}`);
    }
    if (
      typeof conversation?.locator?.strategy !== "string" ||
      typeof conversation?.locator?.value !== "string" ||
      !conversation.locator.value
    ) {
      errors.push(`${prefix}.locator`);
    }
    if (conversation?.bindingStatus !== "bound") {
      for (const key of ["createdAt", "updatedAt"]) {
        if (conversation?.[key]?.value !== null) errors.push(`${prefix}.${key}.unboundValue`);
      }
    }
  }

  function validate(snapshot) {
    const errors = [];
    if (!snapshot || snapshot.schemaVersion !== VERSION) errors.push("schemaVersion");
    if (!snapshot?.route || typeof snapshot.route.pathname !== "string") errors.push("route");
    if (
      !snapshot?.appearance ||
      !COLOR_SCHEMES.includes(snapshot.appearance.colorScheme) ||
      typeof snapshot.appearance.source !== "string" ||
      !FIELD_STATUS.includes(snapshot.appearance.status) ||
      !isSourcedField(snapshot.appearance.surface) ||
      !isSafeRgb(snapshot.appearance.surface?.value)
    ) {
      errors.push("appearance");
    }
    if (!snapshot?.conversation || !IDENTITY_STATUS.includes(snapshot.conversation.identityStatus)) {
      errors.push("conversation.identityStatus");
    }
    if (!BINDING_STATUS.includes(snapshot?.conversation?.bindingStatus)) {
      errors.push("conversation.bindingStatus");
    }
    if (!isNullableString(snapshot?.conversation?.conversationId)) errors.push("conversation.conversationId");
    if (!isNullableString(snapshot?.conversation?.draftId)) errors.push("conversation.draftId");
    for (const key of ["title", "createdAt", "updatedAt"]) {
      if (!isSourcedField(snapshot?.conversation?.[key])) errors.push(`conversation.${key}`);
    }
    // Canonical conversation metadata is authoritative: `createdAt` maps to
    // ChatGPT `create_time`, `updatedAt` maps to `update_time`, and Range is
    // derived from those two fields. Per-message time stays in
    // `message.timestamp` and must never overwrite conversation metadata.
    // Sidebar conversations are a bounded projection keyed by their exact
    // href. Feature writes may only consume rows accepted by the dedicated
    // eligibility helper below; route-only and mismatched rows stay read-only.
    if (!Array.isArray(snapshot?.sidebarConversations)) errors.push("sidebarConversations");
    else {
      const seenConversationIds = new Set();
      snapshot.sidebarConversations.forEach((conversation, index) => {
        validateSidebarConversation(conversation, index, errors);
        if (seenConversationIds.has(conversation?.conversationId)) {
          errors.push(`sidebarConversations[${index}].duplicateConversationId`);
        }
        seenConversationIds.add(conversation?.conversationId);
      });
    }
    if (!Array.isArray(snapshot?.messages)) errors.push("messages");
    else {
      snapshot.messages.forEach((message, index) => {
        if (typeof message?.messageId !== "string" || !message.messageId) errors.push(`messages[${index}].messageId`);
        if (!MESSAGE_ID_STATUS.includes(message?.idStatus)) errors.push(`messages[${index}].idStatus`);
        if (!MESSAGE_PRESENTATION_STATUS.includes(message?.presentationStatus)) errors.push(`messages[${index}].presentationStatus`);
        if (typeof message?.role !== "string") errors.push(`messages[${index}].role`);
        if (!isSourcedField(message?.timestamp)) errors.push(`messages[${index}].timestamp`);
        if (!isSourcedField(message?.excerpt)) errors.push(`messages[${index}].excerpt`);
        if (typeof message?.excerpt?.value === "string" && message.excerpt.value.length > MAX_MESSAGE_EXCERPT_LENGTH) {
          errors.push(`messages[${index}].excerpt.length`);
        }
        if (!Number.isInteger(message?.order?.index)) errors.push(`messages[${index}].order.index`);
        if (typeof message?.locator?.strategy !== "string" || typeof message?.locator?.value !== "string") {
          errors.push(`messages[${index}].locator`);
        }
      });
    }
    if (snapshot?.conversation?.bindingStatus !== "bound") {
      for (const key of ["title", "createdAt", "updatedAt"]) {
        if (snapshot?.conversation?.[key]?.value !== null) errors.push(`conversation.${key}.unboundValue`);
      }
      if (Array.isArray(snapshot?.messages) && snapshot.messages.length) errors.push("messages.unboundValues");
    }
    return { valid: errors.length === 0, errors };
  }

  // Future write/persistence features must use this helper rather than testing
  // conversationId alone. A bound draft is readable but is not persistable.
  function isPersistenceEligible(snapshot) {
    return Boolean(
      validate(snapshot).valid &&
        snapshot.conversation.bindingStatus === "bound" &&
        snapshot.conversation.identityStatus === "stable" &&
        canonicalConversationPath(snapshot.route.pathname, snapshot.conversation.conversationId),
    );
  }

  // A sidebar favorite is allowed only when the Adapter proved that the
  // stable route id, exact anchor and its metadata belong to the same row.
  // This deliberately does not make sidebar messages or arbitrary DOM data
  // persistable.
  function isSidebarPersistenceEligible(conversation) {
    const errors = [];
    validateSidebarConversation(conversation, 0, errors);
    return Boolean(
      errors.length === 0 &&
        conversation.identityStatus === "stable" &&
        conversation.bindingStatus === "bound" &&
        canonicalConversationPath(conversation.locator.value, conversation.conversationId),
    );
  }

  // Persistence modules receive the exact canonical message record through
  // this helper. A route-only/mismatch snapshot or a temporary message ID can
  // therefore never become a bookmark by accident.
  function persistenceEligibleMessage(snapshot, messageId) {
    if (!isPersistenceEligible(snapshot) || typeof messageId !== "string" || !messageId) return null;
    const message = snapshot.messages.find((candidate) => candidate.messageId === messageId) || null;
    return message?.idStatus === "stable" && message.presentationStatus === "formal" ? message : null;
  }

  function isPresentableMessage(message) {
    return Boolean(
      message?.messageId &&
      message.idStatus === "stable" &&
      message.presentationStatus === "formal",
    );
  }

  global.TidySnapshot = Object.freeze({
    VERSION,
    FIELD_STATUS,
    IDENTITY_STATUS,
    BINDING_STATUS,
    MESSAGE_ID_STATUS,
    MESSAGE_PRESENTATION_STATUS,
    COLOR_SCHEMES,
    MAX_MESSAGE_EXCERPT_LENGTH,
    projectIdFromSegment,
    parseConversationPath,
    canonicalConversationPath,
    validate,
    isPersistenceEligible,
    isSidebarPersistenceEligible,
    persistenceEligibleMessage,
    isPresentableMessage,
  });
})(globalThis);

// Source: src/features/search/model/search.js
(function initTidySearch(global) {
  "use strict";

  if (global.TidySearch) return;

  const VERSION = "tidy.search.v1";
  const DEFAULT_LIMIT = 10;
  const MAX_LIMIT = 60;
  const MAX_QUERY_LENGTH = 500;
  const PAGE_SIZE_OPTIONS = Object.freeze([7, 15, 30, 60]);

  function nonEmptyString(value) {
    return typeof value === "string" && Boolean(value.trim());
  }

  function normalizeRequest(value) {
    const query = typeof value?.query === "string" ? value.query.trim() : "";
    const cursor = value?.cursor == null ? null : value.cursor;
    const sessionId = typeof value?.sessionId === "string" ? value.sessionId.trim() : "";
    const limit = Number.isInteger(value?.limit) ? value.limit : DEFAULT_LIMIT;
    if (!query || query.length > MAX_QUERY_LENGTH) {
      throw new TypeError("Search query must be between 1 and 500 characters");
    }
    if (!nonEmptyString(sessionId)) throw new TypeError("Search session ID is required");
    if (cursor !== null && !nonEmptyString(cursor)) throw new TypeError("Search cursor is invalid");
    if (limit < 1 || limit > MAX_LIMIT) throw new TypeError("Search limit is invalid");
    return { query, cursor, sessionId, limit };
  }

  function validateResult(value) {
    return Boolean(
      value &&
      nonEmptyString(value.resultId) &&
      value.source === "conversation" &&
      nonEmptyString(value.conversationId) &&
      (value.messageId === null || nonEmptyString(value.messageId)) &&
      typeof value.title === "string" &&
      typeof value.snippet === "string" &&
      (value.messageTimestamp == null || nonEmptyString(value.messageTimestamp)) &&
      (value.conversationUpdatedAt === null || nonEmptyString(value.conversationUpdatedAt)) &&
      (value.matchKind === null || typeof value.matchKind === "string")
    );
  }

  function validatePage(value) {
    const errors = [];
    if (!value || value.schemaVersion !== VERSION) errors.push("schemaVersion");
    if (!nonEmptyString(value?.query)) errors.push("query");
    if (!Array.isArray(value?.items) || !value.items.every(validateResult)) errors.push("items");
    if (value?.cursor !== null && !nonEmptyString(value?.cursor)) errors.push("cursor");
    if (typeof value?.hasMore !== "boolean") errors.push("hasMore");
    if (typeof value?.partialResults !== "boolean") errors.push("partialResults");
    return { valid: errors.length === 0, errors };
  }

  function createSessionId() {
    return global.crypto?.randomUUID?.() || `search-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function queryTerms(query) {
    return [...new Set(String(query || "").trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean))];
  }

  global.TidySearch = Object.freeze({
    VERSION,
    DEFAULT_LIMIT,
    MAX_LIMIT,
    MAX_QUERY_LENGTH,
    PAGE_SIZE_OPTIONS,
    normalizeRequest,
    validateResult,
    validatePage,
    createSessionId,
    queryTerms,
  });
})(globalThis);

// Source: src/platform/catalog/date-search.js
(function initTidyDateSearch(global) {
  "use strict";

  if (global.TidyDateSearch) return;

  const VERSION = "tidy.date-search.v1";
  const SOURCE_TYPES = Object.freeze(["ordinary", "archived", "pins", "projects", "project"]);
  const DIRECTORY_SOURCE_TYPES = Object.freeze(["ordinary", "archived", "pins", "project"]);
  const MIN_TIME_MS = -8_640_000_000_000_000;
  const MAX_TIME_MS = 8_640_000_000_000_000;
  const DAY_MS = 86_400_000;
  // 产品日期下限：日期选择器和查询统一从此日开始，上限由所选时区的“今天”确定。
  // 这不是 JavaScript 日期能力的限制；调整范围不要改动下面的通用时区换算。
  const MIN_SEARCH_DATE = "2022-11-30";

  function nonEmptyString(value) {
    return typeof value === "string" && Boolean(value.trim());
  }

  function dateParts(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
    const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    return check.getUTCFullYear() === parts.year
      && check.getUTCMonth() === parts.month - 1
      && check.getUTCDate() === parts.day ? parts : null;
  }

  function zoneOffsetMs(timestamp, formatter) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp))
      .map((part) => [part.type, part.value]));
    const local = new Date(0);
    // setUTCFullYear avoids Date.UTC's special interpretation of years 0–99
    // when a probe falls just before an otherwise valid year-0100 boundary.
    local.setUTCFullYear(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
    local.setUTCHours(Number(parts.hour), Number(parts.minute), Number(parts.second), 0);
    return local.getTime() - Math.floor(timestamp / 1000) * 1000;
  }

  function zonedDayStart(parts, formatter) {
    const target = Date.UTC(parts.year, parts.month - 1, parts.day);
    // Probe both sides of the local day, not just its UTC midnight. This
    // exposes both offsets of a midnight transition without assuming its size.
    const offsets = new Set([-DAY_MS, 0, DAY_MS]
      .map((delta) => zoneOffsetMs(target + delta, formatter)));
    const candidates = Array.from(offsets, (offset) => target - offset).sort((a, b) => a - b);
    for (const candidate of candidates) {
      // A repeated midnight has two valid candidates: the earliest starts
      // the calendar day and includes both occurrences in the same range.
      if (candidate + zoneOffsetMs(candidate, formatter) === target) return candidate;
    }

    // A missing midnight has no exact candidate. The offsets instead bracket
    // the forward jump; find its first actual instant, not a shifted midnight.
    // Millisecond bisection is bounded by the offset difference (~27 probes
    // even for a whole skipped day), and also handles non-hour transitions.
    let before = candidates[0];
    let after = candidates[candidates.length - 1];
    while (after - before > 1) {
      const middle = before + Math.floor((after - before) / 2);
      if (middle + zoneOffsetMs(middle, formatter) < target) before = middle;
      else after = middle;
    }
    return after;
  }

  function nextDate(parts) {
    const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
    return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
  }

  function dateRange(value = {}) {
    const startText = typeof value.startDate === "string" ? value.startDate.trim() : "";
    const endText = typeof value.endDate === "string" ? value.endDate.trim() : "";
    const timeZone = nonEmptyString(value.timeZone) ? value.timeZone : "UTC";
    const start = startText ? dateParts(startText) : null;
    const end = endText ? dateParts(endText) : null;
    if ((startText && !start) || (endText && !end)) throw new TypeError("Search date is invalid");
    if (start && end && startText > endText) {
      throw new RangeError("Search end date must not be earlier than its start date");
    }
    if (!start && !end) return { hasDate: false, startMs: MIN_TIME_MS, endMs: MAX_TIME_MS };
    // Share one formatter across both boundaries and all transition probes;
    // ranges are also recomputed during UI renders, where construction is costly.
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const startMs = start ? zonedDayStart(start, formatter) : MIN_TIME_MS;
    const endMs = end ? zonedDayStart(nextDate(end), formatter) : MAX_TIME_MS;
    // A whole local day can be skipped by a zone change. Its two boundaries
    // coincide, representing a valid empty interval rather than a reversed day.
    if (startMs > endMs) throw new RangeError("Search end date must not be earlier than its start date");
    return { hasDate: true, startMs, endMs };
  }

  function searchDateBounds(timeZone = "UTC", nowMs = Date.now()) {
    if (!Number.isFinite(nowMs)) throw new TypeError("Search current time is invalid");
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: nonEmptyString(timeZone) ? timeZone : "UTC",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date(nowMs)).map((part) => [part.type, part.value]));
    return { minDate: MIN_SEARCH_DATE, maxDate: `${parts.year}-${parts.month}-${parts.day}` };
  }

  function searchDateRange(value = {}, nowMs = Date.now()) {
    const { minDate, maxDate } = searchDateBounds(value.timeZone, nowMs);
    for (const field of ["startDate", "endDate"]) {
      if (value[field] != null && typeof value[field] !== "string") throw new TypeError("Search date is invalid");
      const text = value[field]?.trim() || "";
      if (text && !dateParts(text)) throw new TypeError("Search date is invalid");
      if (text && (text < minDate || text > maxDate)) {
        throw Object.assign(new RangeError("Search date is outside the supported range"), {
          code: "SEARCH_DATE_OUT_OF_BOUNDS",
        });
      }
    }
    const startDate = value.startDate?.trim() || "";
    const endDate = value.endDate?.trim() || "";
    const range = dateRange({
      ...value, startDate: startDate || minDate, endDate: endDate || maxDate,
    });
    // Empty controls still mean no query; a single open end is bounded to the
    // same product dates as the picker rather than an unbounded timestamp.
    return { ...range, hasDate: Boolean(startDate || endDate) };
  }

  function normalizeSourceRequest(value = {}) {
    const source = SOURCE_TYPES.includes(value.source) ? value.source : "";
    const cursor = value.cursor == null ? null : String(value.cursor).trim();
    const projectId = value.projectId == null ? null : String(value.projectId).trim();
    const accountKey = value.accountKey == null ? null : value.accountKey;
    if (!source) throw new TypeError("Date index source is invalid");
    if (value.cursor != null && !cursor) throw new TypeError("Date index cursor is invalid");
    if (source === "project" && !projectId) throw new TypeError("Project source requires a project ID");
    if (accountKey !== null && !nonEmptyString(accountKey)) throw new TypeError("Source account is invalid");
    return { source, cursor, projectId, accountKey };
  }

  function validateDirectoryBounds(value) {
    const fields = ["createdAt", "updatedAt", "sources"];
    return Boolean(
      value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field))
      && (value.createdAt === null || Number.isFinite(value.createdAt))
      && (value.updatedAt === null || Number.isFinite(value.updatedAt))
      && Array.isArray(value.sources) && value.sources.length > 0
      && value.sources.every((source) => DIRECTORY_SOURCE_TYPES.includes(source))
      && new Set(value.sources).size === value.sources.length,
    );
  }

  function validateCandidate(value) {
    return Boolean(
      value
      && nonEmptyString(value.conversationId)
      && typeof value.title === "string"
      && (value.updatedAt === null || Number.isFinite(value.updatedAt))
      && (value.projectId === undefined || value.projectId === null || nonEmptyString(value.projectId))
      && (value.directoryBounds === undefined || validateDirectoryBounds(value.directoryBounds)),
    );
  }

  function validateSourcePage(value) {
    return Boolean(
      value
      && value.schemaVersion === VERSION
      && SOURCE_TYPES.includes(value.source)
      && Array.isArray(value.conversations)
      && value.conversations.every(validateCandidate)
      && Array.isArray(value.projects)
      && value.projects.every((project) => nonEmptyString(project?.projectId))
      && (value.nextCursor === null || nonEmptyString(value.nextCursor))
      && typeof value.done === "boolean"
      && Array.isArray(value.coverageReasons),
    );
  }

  global.TidyDateSearch = Object.freeze({
    VERSION,
    SOURCE_TYPES,
    DIRECTORY_SOURCE_TYPES,
    MIN_TIME_MS,
    MAX_TIME_MS,
    MIN_SEARCH_DATE,
    dateRange,
    searchDateBounds,
    searchDateRange,
    normalizeSourceRequest,
    validateSourcePage,
    validateDirectoryBounds,
  });
})(globalThis);

// Source: src/features/export/model/export.js
(function initTidyExportContract(global) {
  "use strict";

  if (global.TidyExportContract) return;

  const VERSION = "chatgpt-tidy.export-source.v2";
  const COLLECTION_VERSION = "chatgpt-tidy.export-source-collection.v2";
  const BLOCK_TYPES = Object.freeze([
    "paragraph",
    "heading",
    "ordered-list",
    "unordered-list",
    "blockquote",
    "code",
    "table",
    "image",
    "attachment",
    "link",
  ]);
  const RESOURCE_TYPES = Object.freeze(["image", "attachment"]);
  const SEGMENT_TYPES = Object.freeze(["content", "process", "sources"]);
  const PROCESS_CATEGORIES = Object.freeze(["reasoning", "search", "tool", "generic"]);
  const PROCESS_PHASES = Object.freeze(["summary", "request", "result", "event"]);
  const LEGACY_MESSAGE_FIELDS = Object.freeze([
    "contentBlocks",
    "visibleProcess",
    "webSearches",
    "finalSources",
    "name",
    "displayName",
    "display_name",
  ]);

  function nonEmptyString(value) {
    return typeof value === "string" && Boolean(value.trim());
  }

  function hasOwn(value, key) {
    return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
  }

  function validateSource(source, prefix, errors) {
    if (!source || typeof source !== "object") {
      errors.push(prefix);
      return;
    }
    if (!nonEmptyString(source.title)) errors.push(`${prefix}.title`);
    if (!nonEmptyString(source.url)) errors.push(`${prefix}.url`);
    if (typeof source.domain !== "string") errors.push(`${prefix}.domain`);
  }

  function validateResource(resource, index, errors) {
    const prefix = `conversation.resources[${index}]`;
    if (!resource || typeof resource !== "object") {
      errors.push(prefix);
      return;
    }
    if (!nonEmptyString(resource.id)) errors.push(`${prefix}.id`);
    if (!RESOURCE_TYPES.includes(resource.type)) errors.push(`${prefix}.type`);
    if (!nonEmptyString(resource.name)) errors.push(`${prefix}.name`);
    if (typeof resource.mimeType !== "string") errors.push(`${prefix}.mimeType`);
    if (resource.sizeBytes !== null && (!Number.isInteger(resource.sizeBytes) || resource.sizeBytes < 0)) {
      errors.push(`${prefix}.sizeBytes`);
    }
    if (typeof resource.src !== "string") errors.push(`${prefix}.src`);
    if (hasOwn(resource, "temporaryUrl") && typeof resource.temporaryUrl !== "boolean") errors.push(`${prefix}.temporaryUrl`);
    if (hasOwn(resource, "pending") && typeof resource.pending !== "boolean") errors.push(`${prefix}.pending`);
    if (resource.pending && (resource.type !== "image" || !nonEmptyString(resource.readHandle))) errors.push(`${prefix}.readHandle`);
    if (typeof resource.alt !== "string") errors.push(`${prefix}.alt`);
  }

  function validateBlock(block, prefix, errors, resourcesById) {
    if (!block || !BLOCK_TYPES.includes(block.type)) {
      errors.push(`${prefix}.type`);
      return;
    }
    if (["paragraph", "blockquote"].includes(block.type) && typeof block.text !== "string") {
      errors.push(`${prefix}.text`);
    }
    if (block.type === "heading") {
      if (!Number.isInteger(block.level) || block.level < 1 || block.level > 6) errors.push(`${prefix}.level`);
      if (typeof block.text !== "string") errors.push(`${prefix}.text`);
    }
    if (["ordered-list", "unordered-list"].includes(block.type)) {
      if (!Array.isArray(block.items) || block.items.some((item) => typeof item !== "string")) {
        errors.push(`${prefix}.items`);
      }
    }
    if (block.type === "code" && (typeof block.language !== "string" || typeof block.code !== "string")) {
      errors.push(`${prefix}.code`);
    }
    if (block.type === "table") {
      if (!Array.isArray(block.headers) || block.headers.some((item) => typeof item !== "string")) {
        errors.push(`${prefix}.headers`);
      }
      if (
        !Array.isArray(block.rows)
        || block.rows.some((row) => !Array.isArray(row) || row.some((item) => typeof item !== "string"))
      ) errors.push(`${prefix}.rows`);
    }
    if (block.type === "image") {
      if (!nonEmptyString(block.resourceId) || resourcesById.get(block.resourceId) !== "image") {
        errors.push(`${prefix}.resourceId`);
      }
      if (typeof block.alt !== "string") errors.push(`${prefix}.alt`);
      if (hasOwn(block, "src") || hasOwn(block, "source")) errors.push(`${prefix}.legacyImageSource`);
    }
    if (block.type === "attachment") {
      // 文件名来自资源；label 保留原交付链接的说明，不与文件名混写。
      if (hasOwn(block, "label") && typeof block.label !== "string") errors.push(`${prefix}.label`);
      if (!nonEmptyString(block.resourceId) || resourcesById.get(block.resourceId) !== "attachment") {
        errors.push(`${prefix}.resourceId`);
      }
    }
    if (block.type === "link" && (typeof block.text !== "string" || !nonEmptyString(block.url))) {
      errors.push(`${prefix}.link`);
    }
  }

  function validateSegment(segment, prefix, errors, resourcesById) {
    if (!segment || !SEGMENT_TYPES.includes(segment.type)) {
      errors.push(`${prefix}.type`);
      return;
    }
    if (!nonEmptyString(segment.sourceMessageId)) errors.push(`${prefix}.sourceMessageId`);
    if (segment.timestamp !== null && typeof segment.timestamp !== "string") errors.push(`${prefix}.timestamp`);

    if (segment.type === "content") {
      if (!Array.isArray(segment.blocks) || !segment.blocks.length) {
        errors.push(`${prefix}.blocks`);
      } else {
        segment.blocks.forEach((block, blockIndex) =>
          validateBlock(block, `${prefix}.blocks[${blockIndex}]`, errors, resourcesById));
      }
      return;
    }

    if (segment.type === "sources") {
      if (!Array.isArray(segment.items) || !segment.items.length) {
        errors.push(`${prefix}.items`);
      } else {
        segment.items.forEach((source, sourceIndex) =>
          validateSource(source, `${prefix}.items[${sourceIndex}]`, errors));
      }
      return;
    }

    if (!PROCESS_CATEGORIES.includes(segment.category)) errors.push(`${prefix}.category`);
    if (!PROCESS_PHASES.includes(segment.phase)) errors.push(`${prefix}.phase`);
    if (typeof segment.label !== "string") errors.push(`${prefix}.label`);
    if (!Array.isArray(segment.blocks)) {
      errors.push(`${prefix}.blocks`);
    } else {
      segment.blocks.forEach((block, blockIndex) =>
        validateBlock(block, `${prefix}.blocks[${blockIndex}]`, errors, resourcesById));
    }
    if (!Array.isArray(segment.queries) || segment.queries.some((query) => typeof query !== "string")) {
      errors.push(`${prefix}.queries`);
    }
    if (!Array.isArray(segment.results)) {
      errors.push(`${prefix}.results`);
    } else {
      segment.results.forEach((source, sourceIndex) =>
        validateSource(source, `${prefix}.results[${sourceIndex}]`, errors));
    }
    if (segment.tool !== null) {
      if (!segment.tool || typeof segment.tool !== "object" || !nonEmptyString(segment.tool.name)) {
        errors.push(`${prefix}.tool.name`);
      } else if (typeof segment.tool.callId !== "string") {
        errors.push(`${prefix}.tool.callId`);
      }
    }
    const readable = Boolean(
      segment.label?.trim()
      || segment.blocks?.length
      || segment.queries?.length
      || segment.results?.length
      || segment.tool?.name,
    );
    if (!readable) errors.push(`${prefix}.emptyProcess`);
    if (segment.category === "tool" && !segment.tool?.name) errors.push(`${prefix}.tool`);
  }

  function validateMessage(message, index, errors, resourcesById) {
    const prefix = `conversation.messages[${index}]`;
    if (!nonEmptyString(message?.id)) errors.push(`${prefix}.id`);
    if (message?.messageNumber !== index + 1) errors.push(`${prefix}.messageNumber`);
    if (!["user", "assistant"].includes(message?.role)) errors.push(`${prefix}.role`);
    if (message?.timestamp !== null && typeof message?.timestamp !== "string") errors.push(`${prefix}.timestamp`);
    const legacyFields = LEGACY_MESSAGE_FIELDS.filter((field) => hasOwn(message, field));
    if (legacyFields.length) errors.push(`${prefix}.legacyFields`);
    if (!Array.isArray(message?.segments) || !message.segments.length) {
      errors.push(`${prefix}.segments`);
      return;
    }
    message.segments.forEach((segment, segmentIndex) =>
      validateSegment(segment, `${prefix}.segments[${segmentIndex}]`, errors, resourcesById));
    if (message.role === "user" && message.segments.some((segment) => segment?.type !== "content")) {
      errors.push(`${prefix}.userSegments`);
    }
  }

  function validateDocument(value) {
    const errors = [];
    if (!value || value.schemaVersion !== VERSION) errors.push("schemaVersion");
    const conversation = value?.conversation;
    if (!nonEmptyString(conversation?.id)) errors.push("conversation.id");
    if (typeof conversation?.title !== "string") errors.push("conversation.title");
    if (typeof conversation?.createdAt !== "string") errors.push("conversation.createdAt");
    if (typeof conversation?.updatedAt !== "string") errors.push("conversation.updatedAt");
    if (conversation?.sourceUrl != null && typeof conversation.sourceUrl !== "string") {
      errors.push("conversation.sourceUrl");
    }

    const resourcesById = new Map();
    if (!Array.isArray(conversation?.resources)) {
      errors.push("conversation.resources");
    } else {
      conversation.resources.forEach((resource, index) => {
        validateResource(resource, index, errors);
        if (resourcesById.has(resource?.id)) errors.push(`conversation.resources[${index}].duplicateId`);
        resourcesById.set(resource?.id, resource?.type);
      });
    }

    if (!Array.isArray(conversation?.messages) || !conversation.messages.length) {
      errors.push("conversation.messages");
    } else {
      const seen = new Set();
      conversation.messages.forEach((message, index) => {
        validateMessage(message, index, errors, resourcesById);
        if (seen.has(message?.id)) errors.push(`conversation.messages[${index}].duplicateId`);
        seen.add(message?.id);
      });
    }
    // Warning codes, never translated prose: panel language can change while
    // this source document remains cached.
    if (!Array.isArray(value?.warnings) || value.warnings.some((warning) => warning !== "IMAGE_UNAVAILABLE")) {
      errors.push("warnings");
    }
    return { valid: errors.length === 0, errors };
  }

  /**
   * A batch read is one all-or-nothing collection. Keeping the collection
   * contract beside the single-document contract lets every bridge layer reject
   * partial, duplicated, or shape-shifted ChatGPT responses in the same way.
   */
  function validateCollection(value) {
    const errors = [];
    if (!value || value.schemaVersion !== COLLECTION_VERSION) errors.push("schemaVersion");
    if (!Array.isArray(value?.documents) || !value.documents.length) {
      errors.push("documents");
      return { valid: false, errors };
    }
    const seen = new Set();
    value.documents.forEach((document, index) => {
      const validation = validateDocument(document);
      validation.errors.forEach((error) => errors.push(`documents[${index}].${error}`));
      const conversationId = document?.conversation?.id;
      if (seen.has(conversationId)) errors.push(`documents[${index}].duplicateConversationId`);
      seen.add(conversationId);
    });
    return { valid: errors.length === 0, errors };
  }

  global.TidyExportContract = Object.freeze({
    VERSION,
    COLLECTION_VERSION,
    BLOCK_TYPES,
    RESOURCE_TYPES,
    SEGMENT_TYPES,
    PROCESS_CATEGORIES,
    PROCESS_PHASES,
    validateDocument,
    validateCollection,
    validResource(resource) { const errors = []; validateResource(resource, 0, errors); return errors.length === 0; },
  });
})(globalThis);

// Source: src/platform/ui/dom-ownership.js
(function initTidyDomOwnership(global) {
  "use strict";

  if (global.TidyDomOwnership) return;

  const OWNED_SELECTOR = "[data-tidy-owned]";

  function asElement(node) {
    if (!node) return null;
    if (node.nodeType === Node.ELEMENT_NODE) return node;
    return node.parentElement || null;
  }

  function isOwnedNode(node) {
    return Boolean(asElement(node)?.closest?.(OWNED_SELECTOR));
  }

  /**
   * A MutationRecord belongs to TIDY only when its target is inside an
   * explicitly owned subtree, or every added/removed root is explicitly
   * owned. Native ChatGPT elements never become owned merely because TIDY
   * adds a helper class or data attribute to them.
   */
  function isTidyOwnedMutation(mutation) {
    if (!mutation) return false;
    if (isOwnedNode(mutation.target)) return true;

    const changedNodes = [
      ...(mutation.addedNodes || []),
      ...(mutation.removedNodes || []),
    ];
    return changedNodes.length > 0 && changedNodes.every(isOwnedNode);
  }

  function areOnlyTidyOwnedMutations(mutations) {
    return Boolean(mutations?.length) && [...mutations].every(isTidyOwnedMutation);
  }

  global.TidyDomOwnership = Object.freeze({
    OWNED_SELECTOR,
    isOwnedNode,
    isTidyOwnedMutation,
    areOnlyTidyOwnedMutations,
  });
})(globalThis);

// Source: src/platform/time-format.js
(function initTidyTimeFormat(global) {
  "use strict";

  if (global.TidyTimeFormat) return;

  const DATE_FORMATS = Object.freeze(["locale", "iso", "slash", "dot", "compact"]);
  const TIME_MODES = Object.freeze(["range", "created", "updated"]);
  // 时间范围用细空格分隔，保留阅读间距，又给窄侧栏的标题和按钮留出空间。
  const RANGE_SEPARATOR = "\u2009~\u2009";
  // Reusing an Intl formatter avoids reconstructing ICU state for every row
  // and every endpoint of a range. Only explicit format options are retained;
  // no timestamps, conversation data or implicit system defaults are cached.
  const formatters = new Map();
  const FORMATTER_CACHE_LIMIT = 32;
  function dateFormatter(locale, options) {
    const key = JSON.stringify([locale, options]);
    let formatter = formatters.get(key);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(locale, options);
      formatters.set(key, formatter);
      if (formatters.size > FORMATTER_CACHE_LIMIT) formatters.delete(formatters.keys().next().value);
    }
    return formatter;
  }

  function toDate(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function zonedParts(value, timeZone) {
    const date = toDate(value);
    if (!date) return null;
    const formatter = dateFormatter("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(date).map((part) => [part.type, part.value]),
    );
    return {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour,
      minute: parts.minute,
      second: parts.second,
    };
  }

  function formatDate(value, options = {}) {
    const date = toDate(value);
    if (!date) return null;
    const timeZone = options.timeZone || "UTC";
    const format = DATE_FORMATS.includes(options.dateFormat) ? options.dateFormat : "locale";
    const includeYear = options.includeYear !== false;
    const parts = zonedParts(date, timeZone);
    const dateParts = includeYear
      ? [parts.year, parts.month, parts.day]
      : [parts.month, parts.day];

    if (format === "iso") return dateParts.join("-");
    if (format === "slash") return dateParts.join("/");
    if (format === "dot") return dateParts.join(".");
    if (format === "compact") return dateParts.join("");

    // Regional formatting follows the browser locale, not the Tidy UI language.
    return dateFormatter(options.locale || global.navigator?.language || "en-US", {
      ...(includeYear ? { year: "numeric" } : {}),
      month: "2-digit",
      day: "2-digit",
      timeZone,
    }).format(date);
  }

  function formatTime(value, options = {}) {
    const parts = zonedParts(value, options.timeZone || "UTC");
    if (!parts) return null;
    if (options.precision === "date") return null;
    if (options.precision === "hour") return `${parts.hour}:00`;
    const base = `${parts.hour}:${parts.minute}`;
    return options.precision === "second" ? `${base}:${parts.second}` : base;
  }

  // 日期格式选项统一展示已选时区下的“今天”，四种写法使用同一时刻。
  // 只在界面需要展示时计算，不设跨日定时器，也不参与消息或标题的真实日期计算。
  function dateFormatLabels(timeZone, now = new Date()) {
    return Object.fromEntries(DATE_FORMATS.filter(format => format !== "locale").map(dateFormat =>
      [dateFormat, formatDate(now, { timeZone, dateFormat })]));
  }

  function formatDateTime(value, options = {}) {
    const date = formatDate(value, options);
    if (options.precision === "date") return date;
    const time = formatTime(value, options);
    return date && time ? `${date} ${time}` : null;
  }

  function formatRange(startValue, endValue, options = {}) {
    const start = zonedParts(startValue, options.timeZone || "UTC");
    const end = zonedParts(endValue, options.timeZone || "UTC");
    if (!start || !end) return null;

    const startText = formatDateTime(startValue, options);
    const sameDate = start.year === end.year && start.month === end.month && start.day === end.day;
    const sameYear = start.year === end.year;
    if (options.precision === "date") {
      if (sameDate) return startText;
      if (sameYear) {
        return `${startText}${RANGE_SEPARATOR}${formatDate(endValue, { ...options, includeYear: false })}`;
      }
      return `${startText}${RANGE_SEPARATOR}${formatDate(endValue, options)}`;
    }
    if (sameDate) {
      const startTime = formatTime(startValue, options);
      const endTime = formatTime(endValue, options);
      // When both message boundaries collapse to the same selected precision,
      // a duplicated "09:12 ~ 09:12" adds no information.
      return startTime === endTime ? startText : `${startText}${RANGE_SEPARATOR}${endTime}`;
    }
    if (sameYear) {
      return `${startText}${RANGE_SEPARATOR}${formatDate(endValue, { ...options, includeYear: false })} ${formatTime(endValue, options)}`;
    }
    // A cross-year row must show both years. To keep the sidebar readable,
    // the less useful start clock is omitted while the latest clock remains.
    return `${formatDate(startValue, options)}${RANGE_SEPARATOR}${formatDateTime(endValue, options)}`;
  }

  function formatConversation(conversation, options = {}) {
    const mode = TIME_MODES.includes(options.mode) ? options.mode : "range";
    if (mode === "created") return formatDateTime(conversation?.createdAt?.value, options);
    if (mode === "updated") return formatDateTime(conversation?.updatedAt?.value, options);
    return formatRange(
      conversation?.createdAt?.value,
      conversation?.updatedAt?.value,
      options,
    );
  }

  global.TidyTimeFormat = Object.freeze({
    DATE_FORMATS,
    TIME_MODES,
    formatDate,
    dateFormatLabels,
    formatTime,
    formatDateTime,
    formatRange,
    formatConversation,
  });
})(globalThis);

// Source: src/features/titles/model/title-dates.js
/*
 * 标题日期纯模型：只产出预览，不读取网络、存储或修改真实会话。
 * A plan preserves the exact source title. Only a continuous, valid date head
 * may be peeled; dates inside ordinary prose are never rewritten or removed.
 */
(function initTitleDates(root, factory) {
  // Node tools and browser entrypoints use the SAME pure formatter. Browser
  // scripts declare load order; CommonJS tools declare their dependency here.
  if (typeof module === "object" && module.exports) require("../../../platform/time-format.js");
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TidyTitleDates = api;
})(globalThis, function titleDatesFactory(root) {
  "use strict";

  if (!root.TidyTimeFormat) throw new Error("Title dates require the shared time formatter.");

  const DATE_FORMATS = Object.freeze(["locale", "iso", "slash", "dot", "compact"]);
  const RANGE_SEPARATOR = "\u2009~\u2009";
  const TITLE_SEPARATOR = "｜";
  const localeProfiles = new Map();
  // Cache immutable Intl machinery, never a conversation, date observation or
  // write plan. Explicit locale/zone keys isolate option changes immediately.
  const formatters = new Map(), localeNames = new Map(), zoneNames = new Map();
  const INTL_CACHE_LIMIT = 32;
  function remember(cache, key, value) {
    cache.set(key, value);
    if (cache.size > INTL_CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return value;
  }
  function formatter(locale, options) {
    const key = JSON.stringify([locale, options]);
    return formatters.get(key) || remember(formatters, key, new Intl.DateTimeFormat(locale, options));
  }

  function validLocale(value) {
    try {
      if (typeof value !== "string" || !value) return null;
      if (localeNames.has(value)) return localeNames.get(value);
      const locale = Intl.getCanonicalLocales(value)[0];
      return remember(localeNames, value, Intl.DateTimeFormat.supportedLocalesOf([locale]).length ? locale : null);
    } catch { return null; }
  }

  function validTimeZone(value) {
    try {
      if (typeof value !== "string" || !value) return null;
      // resolvedOptions also canonicalizes aliases; reject offset-only zones.
      if (/^[+-]/.test(value)) return null;
      if (zoneNames.has(value)) return zoneNames.get(value);
      return remember(zoneNames, value, formatter("en-US", { timeZone: value }).resolvedOptions().timeZone);
    } catch { return null; }
  }

  function normalizeRules(input = {}) {
    const source = input && typeof input === "object" ? input : {};
    let timeZone = validTimeZone(source.timeZone);
    let locale = validLocale(source.locale) || validLocale(root.navigator?.language);
    if (!timeZone || !locale) {
      // Defaults may change with the OS/browser while a panel remains open.
      // Resolve them live only when missing, never cache an implicit timezone.
      const defaults = new Intl.DateTimeFormat().resolvedOptions();
      timeZone ||= validTimeZone(defaults.timeZone) || "UTC";
      locale ||= validLocale(defaults.locale) || "en-US";
    }
    return {
      mode: source.mode === "range" ? "range" : "created",
      dateFormat: DATE_FORMATS.includes(source.dateFormat) ? source.dateFormat : "locale",
      timeZone,
      // UI language deliberately does not participate in regional formatting.
      locale,
    };
  }

  function utcDate(year, month, day) {
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(0, 0, 0, 0);
    return date;
  }

  function validParts(year, month, day) {
    if (![year, month, day].every(Number.isInteger) || year < 1 || year > 9999) return false;
    const date = utcDate(year, month, day);
    return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
  }

  function dateParts(year, month, day) {
    return validParts(year, month, day) ? { year, month, day } : null;
  }

  function compareDates(left, right) {
    return (left.year * 10000 + left.month * 100 + left.day) - (right.year * 10000 + right.month * 100 + right.day);
  }

  function parseTimestamp(value) {
    if (typeof value !== "string") return null;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/i);
    if (!match || !validParts(+match[1], +match[2], +match[3])) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function zonedParts(date, timeZone) {
    const parts = Object.fromEntries(formatter("en-US", {
      calendar: "gregory", numberingSystem: "latn", timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(date).map((part) => [part.type, part.value]));
    return { year: +parts.year, month: +parts.month, day: +parts.day };
  }

  function formatDate(date, rules, includeYear = true) {
    return root.TidyTimeFormat.formatDate(date, { ...rules, includeYear });
  }

  function buildTarget(metadata, rules) {
    const created = parseTimestamp(metadata.createdAt);
    if (!created) return { reason: "missing_created_time", targetLayer: "" };
    const start = zonedParts(created, rules.timeZone);
    const first = formatDate(created, rules);
    if (rules.mode === "created") return { reason: "", targetLayer: first, start, end: null };
    const updated = parseTimestamp(metadata.updatedAt);
    if (!updated) return { reason: "missing_updated_time", targetLayer: "" };
    if (updated < created) return { reason: "invalid_date_range", targetLayer: "" };
    const end = zonedParts(updated, rules.timeZone);
    const sameDate = compareDates(start, end) === 0;
    // 范围日期统一智能省略：同日合并，同年省略结束年份，跨年保留两端年份。
    const includeYear = start.year !== end.year;
    return { reason: "", start, end: sameDate ? null : end,
      targetLayer: sameDate ? first : `${first}${RANGE_SEPARATOR}${formatDate(updated, rules, includeYear)}` };
  }

  function escapePattern(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function getLocaleProfile(locale) {
    if (localeProfiles.has(locale)) return localeProfiles.get(locale);
    const formatter = new Intl.DateTimeFormat(locale, {
      timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit",
    });
    const options = formatter.resolvedOptions();
    const numberFormat = new Intl.NumberFormat(locale, { useGrouping: false, numberingSystem: options.numberingSystem });
    const digits = Array.from({ length: 10 }, (_, index) => numberFormat.format(index));
    const digitSource = `(?:${digits.map(escapePattern).join("|")})`;
    function number(value) {
      let normalized = value;
      digits.forEach((digit, index) => { normalized = normalized.split(digit).join(String(index)); });
      return /^\d+$/.test(normalized) ? Number(normalized) : NaN;
    }
    function parts(date) {
      const fields = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
      return { year: number(fields.year || fields.relatedYear || ""), month: number(fields.month || ""), day: number(fields.day || "") };
    }
    function pattern(includeYear) {
      const sampleFormatter = includeYear ? formatter : new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "2-digit", day: "2-digit" });
      const fields = [];
      let supported = true;
      const source = sampleFormatter.formatToParts(utcDate(2006, 11, 22)).map((part) => {
        const type = part.type === "relatedYear" ? "year" : part.type;
        if (["year", "month", "day"].includes(type)) {
          if (!Number.isFinite(number(part.value))) supported = false;
          fields.push(type);
          return `(${digitSource}{1,${type === "year" ? 6 : 2}})`;
        }
        return escapePattern(part.value);
      }).join("");
      return supported ? { regex: new RegExp(`^${source}(?!${digitSource})`, "u"), fields } : null;
    }
    const profile = { formatter, calendar: options.calendar, digits, number, parts, full: pattern(true), short: pattern(false), dates: new Map() };
    localeProfiles.set(locale, profile);
    // Browser locale changes are rare; do not retain an unbounded parser cache.
    if (localeProfiles.size > 16) localeProfiles.delete(localeProfiles.keys().next().value);
    return profile;
  }

  function calendarDate(profile, fields) {
    if (![fields.year, fields.month, fields.day].every(Number.isInteger) || fields.year < 1 || fields.month < 1 || fields.day < 1) return null;
    if (["gregory", "iso8601"].includes(profile.calendar)) return dateParts(fields.year, fields.month, fields.day);
    if (profile.calendar === "buddhist") return dateParts(fields.year - 543, fields.month, fields.day);
    const key = `${fields.year}/${fields.month}/${fields.day}`;
    if (profile.dates.has(key)) return profile.dates.get(key);
    // Numeric non-Gregorian calendars (e.g. Persian/Islamic) are validated by
    // Intl itself, not by assuming Gregorian leap-year or month-length rules.
    // A bounded binary search covers modern conversation dates. Exotic eras
    // outside that window fail closed rather than stripping an uncertain head.
    const reference = profile.parts(utcDate(2026, 1, 1));
    const estimatedYear = 2026 + fields.year - reference.year;
    let low = Math.floor(utcDate(estimatedYear - 3, 1, 1).getTime() / 86400000);
    let high = Math.floor(utcDate(estimatedYear + 4, 1, 1).getTime() / 86400000);
    let found = null;
    while (low <= high) {
      const day = Math.floor((low + high) / 2);
      const candidate = new Date(day * 86400000);
      const rendered = profile.parts(candidate);
      const comparison = compareDates(rendered, fields);
      if (!Number.isFinite(comparison)) break;
      if (comparison === 0) {
        found = dateParts(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, candidate.getUTCDate());
        break;
      }
      if (comparison < 0) low = day + 1; else high = day - 1;
    }
    profile.dates.set(key, found);
    if (profile.dates.size > 256) profile.dates.delete(profile.dates.keys().next().value);
    return found;
  }

  function localeDateAtStart(source, rules, start = null) {
    const profile = getLocaleProfile(rules.locale);
    const template = start ? profile.short : profile.full;
    if (!template) return null;
    const match = source.match(template.regex);
    if (!match) return null;
    const fields = start ? { year: profile.parts(utcDate(start.year, start.month, start.day)).year } : {};
    template.fields.forEach((field, index) => { fields[field] = profile.number(match[index + 1]); });
    const parts = calendarDate(profile, fields);
    return { text: match[0], length: match[0].length, parts, origin: "locale" };
  }

  function numericDateAtStart(source, start = null) {
    let match;
    let parts;
    if (start) {
      match = source.match(/^(\d{1,2})月(\d{1,2})日(?!\d)/) || source.match(/^(\d{1,2})[-/._](\d{1,2})(?!\d)/) || source.match(/^(\d{2})(\d{2})(?!\d)/);
      if (match) parts = dateParts(start.year, +match[1], +match[2]);
    } else {
      match = source.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日(?!\d)/) || source.match(/^(\d{4})[-/._](\d{1,2})[-/._](\d{1,2})(?!\d)/) || source.match(/^(\d{4})(\d{2})(\d{2})(?!\d)/);
      if (match) parts = dateParts(+match[1], +match[2], +match[3]);
    }
    return match ? { text: match[0], length: match[0].length, parts, origin: "numeric" } : null;
  }

  function dateAtStart(source, rules, start = null, preferLocale = false) {
    const candidates = [numericDateAtStart(source, start), localeDateAtStart(source, rules, start)].filter(Boolean);
    // Prefer the widest token, including invalid candidates: never remove a
    // valid-looking substring from a longer malformed/ambiguous date.
    candidates.sort((left, right) => right.length - left.length || (preferLocale ? Number(right.origin === "locale") - Number(left.origin === "locale") : 0));
    return candidates[0] || null;
  }

  function layerAtStart(source, rules, target) {
    // Exact generated heads also cover locale calendars with textual months.
    // Requiring our separator here avoids treating arbitrary prose as a date.
    if (target?.targetLayer && (source === target.targetLayer || source.startsWith(target.targetLayer + TITLE_SEPARATOR))) {
      return { raw: target.targetLayer, length: target.targetLayer.length, start: target.start, end: target.end };
    }
    const first = dateAtStart(source, rules);
    if (!first?.parts) return null;
    const rest = source.slice(first.length);
    const separator = rest.match(/^\s*(~|→|至|到|–|—|-)\s*/);
    if (separator) {
      const endpoint = rest.slice(separator[0].length);
      const end = dateAtStart(endpoint, rules) || dateAtStart(endpoint, rules, first.parts, first.origin === "locale");
      if (end) {
        if (!end.parts || compareDates(end.parts, first.parts) < 0) return null;
        const length = first.length + separator[0].length + end.length;
        return { raw: source.slice(0, length), length, start: first.parts, end: end.parts };
      }
      // A malformed explicit range must not be partially peeled as a date.
      if (/[~→至到]/.test(separator[1]) || /^[\d\p{Nd}]/u.test(endpoint)) return null;
    }
    return { raw: first.text, length: first.length, start: first.parts, end: null };
  }

  function analyzeTitle(title, rules, target) {
    let cursor = 0;
    const layers = [];
    while (cursor < title.length) {
      const layer = layerAtStart(title.slice(cursor), rules, target);
      if (!layer) break;
      layers.push(layer);
      cursor += layer.length;
      const tail = title.slice(cursor);
      // Do not trim the body after an explicit separator. This makes adding
      // and removing a generated head preserve a title's own leading spaces.
      const delimiter = tail.match(/^\s*(?:｜|\||--|:|：|—|–|-)/) || tail.match(/^\s+/);
      if (delimiter) cursor += delimiter[0].length;
      const between = title.slice(cursor).match(/^\s+/)?.[0] || "";
      if (between && layerAtStart(title.slice(cursor + between.length), rules, target)) cursor += between.length;
      if (!layerAtStart(title.slice(cursor), rules, target)) break;
    }
    const baseTitle = title.slice(cursor);
    const hasDateHead = layers.length > 0;
    const exact = hasDateHead && layers[0].raw === target?.targetLayer;
    const dateOnly = hasDateHead && !baseTitle.trim();
    return { state: exact ? "matches_target" : dateOnly ? "date_only" : layers.length > 1 ? "multiple_heads" : hasDateHead ? "existing_date_head" : "no_date_head",
      baseTitle, layers, detectedPrefix: title.slice(0, cursor), hasDateHead, exact, dateOnly };
  }

  function plan(metadata = {}, inputRules = {}, options = {}) {
    const source = metadata && typeof metadata === "object" ? metadata : {};
    const rules = normalizeRules(inputRules);
    const operation = options.operation === "remove" ? "remove" : "assign";
    const before = typeof source.title === "string" ? source.title : "";
    const target = buildTarget(source, rules);
    const analysis = analyzeTitle(before, rules, target);
    const targetLayer = target.targetLayer;
    const base = analysis.baseTitle;
    const replacement = targetLayer + (base ? TITLE_SEPARATOR + base : "");
    let action = "add";
    let after = targetLayer + TITLE_SEPARATOR + before;
    let reason = "";
    let needsDecision = false;
    let selectedDecision = "";
    let wouldEmpty = false;
    let choices = [];

    if (operation === "remove") {
      action = "remove";
      after = analysis.hasDateHead ? base : before;
      wouldEmpty = analysis.hasDateHead && !base.trim();
      if (!analysis.hasDateHead) reason = "no_date_head";
      if (wouldEmpty) reason = "would_empty_title";
    } else if (!before.trim() || target.reason) {
      action = "blocked";
      after = before;
      reason = !before.trim() ? "empty_title" : target.reason;
    } else if (analysis.exact) {
      action = "noop";
      after = before;
    } else if (analysis.hasDateHead) {
      needsDecision = true;
      choices = [
        { id: "skip", action: "skip", after: before },
        { id: "replace", action: "replace", after: replacement },
        { id: "stack", action: "stack", after: targetLayer + TITLE_SEPARATOR + before },
      ];
      const choice = choices.find((item) => item.id === options.decision) || choices[0];
      selectedDecision = choice.id;
      action = choice.action;
      after = choice.after;
      if (action === "skip") reason = "date_conflict";
    }

    const noOp = action === "noop" || (operation === "remove" && !analysis.hasDateHead);
    const canApply = !reason && !noOp && after !== before;
    return {
      conversationId: typeof source.conversationId === "string" ? source.conversationId : "",
      operation, rules, before, after, action, reason, canApply, noOp,
      needsDecision, selectedDecision, decisionResolved: !needsDecision || selectedDecision !== "skip",
      hasDateHead: analysis.hasDateHead, wouldEmpty, targetLayer,
      targetPrefix: targetLayer ? targetLayer + TITLE_SEPARATOR : "",
      detectedPrefix: analysis.detectedPrefix, baseTitle: base, analysis, choices,
      // Fingerprints capture locale as well as timezone; UI language is absent.
      ruleFingerprint: JSON.stringify({ ...rules, operation, targetLayer }),
    };
  }

  return Object.freeze({ DATE_FORMATS, normalizeRules, plan });
});

// Source: src/platform/chatgpt/route.js
(function initTidyChatgptRoute(global) {
  "use strict";

  if (global.TidyChatgptRoute) return;
  const snapshotContract = global.TidySnapshot;
  if (!snapshotContract) return;

  const DRAFT_PREFIX = "WEB:";

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function isDraftId(value) {
    return typeof value === "string" && value.startsWith(DRAFT_PREFIX);
  }

  function parse(input = global.location.href) {
    let url;
    try {
      url = new URL(input, global.location.origin);
    } catch {
      return {
        supported: false,
        href: String(input || ""),
        pathname: "",
        kind: "unsupported",
        conversationId: null,
        projectId: null,
        identityStatus: "unavailable",
      };
    }

    const supported = url.hostname === "chatgpt.com";
    const segments = url.pathname.split("/").filter(Boolean).map(safeDecode);
    const projectIndex = segments.findIndex((segment) => /^g-p-[A-Za-z0-9_-]+$/.test(segment));
    const conversationIndex = segments.lastIndexOf("c");
    const groupIndex = segments.indexOf("gg");
    let conversationId = null;
    let kind = "home";

    if (groupIndex >= 0 && segments[groupIndex + 1]) {
      conversationId = segments[groupIndex + 1];
      kind = "group";
    } else if (conversationIndex >= 0 && segments[conversationIndex + 1]) {
      conversationId = segments[conversationIndex + 1];
      kind = projectIndex >= 0 ? "project-conversation" : "conversation";
    } else if (projectIndex >= 0) {
      kind = "project";
    }

    return {
      supported,
      href: url.href,
      pathname: url.pathname,
      kind,
      conversationId,
      projectId: projectIndex >= 0 ? snapshotContract.projectIdFromSegment(segments[projectIndex]) : null,
      identityStatus: conversationId
        ? isDraftId(conversationId)
          ? "draft"
          : "stable"
        : kind === "home" || kind === "project"
          ? "empty"
          : "unavailable",
    };
  }

  global.TidyChatgptRoute = Object.freeze({ DRAFT_PREFIX, isDraftId, parse });
})(globalThis);

// Source: src/platform/chatgpt/binding.js
(function initTidyChatgptBinding(global) {
  "use strict";

  if (global.TidyChatgptBinding) return;

  const BindingStatus = Object.freeze({
    UNBOUND: "unbound",
    ROUTE_ONLY: "route-only",
    BOUND: "bound",
    MISMATCH: "mismatch",
  });

  function normalizedId(value) {
    return typeof value === "string" && value ? value : null;
  }

  function isFormalId(value, isDraftId) {
    return Boolean(normalizedId(value) && !isDraftId(value));
  }

  // The route owns identity. Fiber may prove that the visible DOM belongs to
  // that route, but a stale Fiber ID is never allowed to replace the route ID.
  function resolve(route, threadEvidence, draftIdMap, isDraftId) {
    const routeId = normalizedId(route?.conversationId);
    const threadId = normalizedId(threadEvidence?.clientId);
    const serverId = normalizedId(threadEvidence?.serverId);

    if (!routeId) {
      return {
        conversationId: null,
        draftId: null,
        status: route?.identityStatus || "unavailable",
        bindingStatus: BindingStatus.UNBOUND,
        threadBound: false,
      };
    }

    if (isDraftId(routeId)) {
      const mappedId = normalizedId(draftIdMap.get(routeId));
      const formalId = isFormalId(serverId, isDraftId)
        ? serverId
        : isFormalId(mappedId, isDraftId)
          ? mappedId
          : null;

      if (threadId && threadId !== routeId) {
        return {
          conversationId: formalId,
          draftId: routeId,
          status: formalId ? "stable" : "resolving",
          bindingStatus: BindingStatus.MISMATCH,
          threadBound: false,
        };
      }

      if (threadId === routeId) {
        if (formalId) draftIdMap.set(routeId, formalId);
        return {
          conversationId: formalId,
          draftId: routeId,
          status: formalId ? "stable" : "resolving",
          bindingStatus: BindingStatus.BOUND,
          threadBound: true,
        };
      }

      return {
        conversationId: formalId,
        draftId: routeId,
        status: formalId ? "stable" : "resolving",
        bindingStatus: BindingStatus.ROUTE_ONLY,
        threadBound: false,
      };
    }

    const identity = {
      conversationId: routeId,
      draftId: null,
      status: "stable",
      bindingStatus: BindingStatus.ROUTE_ONLY,
      threadBound: false,
    };

    if (!threadId) return identity;
    if (threadId === routeId) {
      return { ...identity, bindingStatus: BindingStatus.BOUND, threadBound: true };
    }

    if (isDraftId(threadId)) {
      const mappedId = isFormalId(serverId, isDraftId)
        ? serverId
        : normalizedId(draftIdMap.get(threadId));
      if (mappedId === routeId) {
        draftIdMap.set(threadId, routeId);
        return {
          ...identity,
          draftId: threadId,
          bindingStatus: BindingStatus.BOUND,
          threadBound: true,
        };
      }
      if (!mappedId) return identity;
    }

    return { ...identity, bindingStatus: BindingStatus.MISMATCH };
  }

  function acceptedIds(identity) {
    return [identity?.conversationId, identity?.draftId].filter(Boolean);
  }

  function withExactMetadata(identity, hasExactMetadata) {
    if (
      identity.bindingStatus === BindingStatus.UNBOUND ||
      identity.bindingStatus === BindingStatus.MISMATCH
    ) {
      return identity;
    }
    if (identity.threadBound || hasExactMetadata) {
      return { ...identity, bindingStatus: BindingStatus.BOUND };
    }
    return { ...identity, bindingStatus: BindingStatus.ROUTE_ONLY };
  }

  function recordConversationId(record) {
    return normalizedId(
      record?.conversation_id ??
        record?.conversationId ??
        record?.message?.conversation_id ??
        record?.message?.conversationId,
    );
  }

  function messageMatchesIdentity(record, identity) {
    if (identity?.bindingStatus !== BindingStatus.BOUND) return false;
    const recordId = recordConversationId(record);
    if (recordId) return acceptedIds(identity).includes(recordId);
    return identity.threadBound === true;
  }

  function stableMessageId(domId, fiberId) {
    const dom = normalizedId(domId);
    const fiber = normalizedId(fiberId);
    const value = dom || fiber;
    if (!value || (dom && fiber && dom !== fiber)) return null;
    // ChatGPT can temporarily expose optimistic placeholders while a send is
    // being promoted to its server identity. Those IDs remain readable but
    // are explicitly barred from persistence.
    if (/^(?:temp|temporary|draft|pending|placeholder|streaming)(?:[-_:]|$)/i.test(value)) return null;
    return value;
  }

  global.TidyChatgptBinding = Object.freeze({
    BindingStatus,
    resolve,
    acceptedIds,
    withExactMetadata,
    recordConversationId,
    messageMatchesIdentity,
    stableMessageId,
  });
})(globalThis);

// Source: src/platform/chatgpt/message-dom.js
(function initTidyChatgptMessageDom(global) {
  "use strict";
  if (global.TidyChatgptMessageDom) return;

  // 页面结构的唯一入口：MAIN 的身份核对、时间/书签展示和精确定位共用。
  // 原生两种消息容器可能随账号分批上线；不向页面伪造 data-message-id。
  const CLASSIC = "div[data-message-id]";
  const COMPOSED = "[data-chatgpt-search-message-ids]";
  function id(element) {
    const direct = element?.getAttribute?.("data-message-id");
    if (direct) return direct;
    const ids = [...new Set(String(element?.getAttribute?.("data-chatgpt-search-message-ids") || "").trim().split(/\s+/).filter(Boolean))];
    // 同一 ID 可重复出现；多个不同 ID 的聚合块不能冒充一条精确消息。
    return ids.length === 1 ? ids[0] : null;
  }
  function candidates(root = global.document) {
    const classic = [...root.querySelectorAll(CLASSIC)], composed = [...root.querySelectorAll(COMPOSED)];
    const elements = [...new Set([...classic, ...composed])].filter(element => !closest(element.parentElement));
    // 分批渲染时两种容器可以共存；最新消息仍按页面顺序判断，不能按选择器分组。
    return classic.length && composed.length
      ? elements.sort((a, b) => a.compareDocumentPosition(b) & 2 ? 1 : -1) : elements;
  }
  function targets(messageId, root = global.document) {
    const escaped = global.CSS.escape(messageId);
    return [...new Set([...root.querySelectorAll(`div[data-message-id="${escaped}"]`),
      ...root.querySelectorAll(`[data-chatgpt-search-message-ids~="${escaped}"]`)])]
      .filter(element => id(element) === messageId && !closest(element.parentElement));
  }
  function locator(element) {
    return { strategy: element.getAttribute("data-message-id") ? "data-message-id" : "data-chatgpt-search-message-ids", value: id(element) };
  }
  function find(value) {
    if (!["data-message-id", "data-chatgpt-search-message-ids"].includes(value?.strategy)) return null;
    return candidates().find(element => id(element) === value.value && locator(element).strategy === value.strategy) || null;
  }
  function closest(element) { return element?.closest?.(`[data-message-id], ${COMPOSED}`) || null; }
  function contentRoot(element) {
    const role = element?.matches?.("[data-message-author-role]") ? element : element?.querySelector?.("[data-message-author-role]");
    return role?.querySelector?.('[data-testid="message-content"], .markdown, [class~="prose"]') || role
      || element?.querySelector?.('[data-markdown-text-style="assistant-message"], [data-user-message-bubble]') || null;
  }
  const META_OWNER = "message-meta";
  function metadata(host) {
    // 时间与书签共用一行；它可在原生正文列内，但不能认领嵌套的另一条消息。
    return [...(host?.querySelectorAll?.('[data-tidy-owned="message-meta"]') || [])]
      .find(node => closest(node.parentElement) === host) || null;
  }
  function userActionBoundary(host) {
    const owned = selector => [...(host.querySelectorAll?.(selector) || [])]
      .filter(node => closest(node) === host && !node.closest('[data-tidy-owned]'));
    const bubbles = owned('[data-user-message-bubble]');
    const controls = owned('.turn-action-controls');
    if (bubbles.length !== 1 || controls.length !== 1) return null;
    // 只依赖已核对的正文/动作语义标记，不依赖按钮语言、Tailwind 层数或 hover 状态。
    // 找最近共同父下的动作分支，附件等其他正文节点仍留在它原来的顺序中。
    let bodyBranch = bubbles[0];
    for (let parent = bodyBranch.parentElement; parent; bodyBranch = parent, parent = parent.parentElement) {
      let actionBranch = controls[0];
      while (actionBranch.parentElement && actionBranch.parentElement !== parent) actionBranch = actionBranch.parentElement;
      if (actionBranch.parentElement === parent) {
        const children = [...parent.children];
        return bodyBranch !== actionBranch && children.indexOf(bodyBranch) < children.indexOf(actionBranch)
          ? { parent, before: actionBranch } : null;
      }
      if (parent === host) break;
    }
    return null;
  }
  function ensureMetadata(host, { role, key, position = "after" }) {
    let meta = metadata(host);
    if (!meta) { meta = global.document.createElement("div"); meta.dataset.tidyOwned = META_OWNER; }
    meta.dataset.tidyKey = key;
    meta.className = `tidy-message-meta tidy-message-meta--${role}`;
    meta.dataset.position = position;
    host.classList.add("tidy-message-meta-host");
    const boundary = position === "after" && role === "user" ? userActionBoundary(host) : null;
    if (position === "before") {
      if (host.firstElementChild !== meta) host.prepend(meta);
    } else if (boundary) {
      if (meta.parentElement !== boundary.parent || meta.nextElementSibling !== boundary.before) {
        boundary.parent.insertBefore(meta, boundary.before);
      }
    } else if (host.lastElementChild !== meta) {
      // 未知原生结构（含临时编辑态）不猜测，不移动原生节点；保持消息内安全位置。
      host.append(meta);
    }
    return meta;
  }
  function removeEmptyMetadata(meta) {
    if (meta?.dataset?.tidyOwned !== META_OWNER || meta.children.length) return;
    const host = closest(meta.parentElement);
    meta.remove();
    if (host && !metadata(host)) host.classList.remove("tidy-message-meta-host");
  }
  global.TidyChatgptMessageDom = Object.freeze({ candidates, targets, id, locator, find, closest, contentRoot,
    metadata, ensureMetadata, removeEmptyMetadata });
})(globalThis);

// Source: src/platform/chatgpt/sidebar-dom.js
(function initTidyChatgptSidebarDom(global) {
  "use strict";
  if (global.TidyChatgptSidebarDom) return;

  // 主会话链接的统一边界：快照、日期、收藏和书签共用；不读取时间或修改原生 DOM。
  // 保留已支持的项目懒挂载路径，不依赖暂未出现的 data-sidebar-item 属性。
  const CANDIDATES = 'a[href^="/c/"], a[href*="/c/"], a[href^="/gg/"]';
  const CONTENT = 'main, [data-message-id], [data-chatgpt-search-message-ids], dialog, [role="dialog"], [aria-modal="true"]';

  function candidates(root = global.document) {
    return [...root.querySelectorAll(CANDIDATES)].filter((link) =>
      // 原生任务时钟也有相同 href 和 interactive-row-link，但自身 aria-hidden=true。
      // 只判断链接自身，不排除隐藏祖先：折叠项目里的真实会话副本仍须保留。
      String(link.getAttribute("aria-hidden")).toLowerCase() !== "true" && !link.closest(CONTENT),
    );
  }

  function findAll(locator, root = global.document) {
    if (locator?.strategy !== "href") return [];
    // 不去掉查询参数，也不按会话 ID 合并独立 DOM 行；维持精确 href 的展示绑定。
    return candidates(root).filter((link) => link.getAttribute("href") === locator.value);
  }

  function find(locator, root = global.document) {
    return findAll(locator, root)[0] || null;
  }

  global.TidyChatgptSidebarDom = Object.freeze({ candidates, findAll, find });
})(globalThis);

// Source: src/platform/chatgpt/active-branch.js
// 严格验证活动分支：缺祖先与循环都失败，绝不把局部分支重新编号为第一条。
(function initTidyChatgptActiveBranch(global) {
  "use strict";
  if (global.TidyChatgptActiveBranch) return;
  function activeBranch(payload) {
    const mapping = payload?.mapping;
    const currentNode = payload?.current_node || payload?.currentNode;
    if (!mapping || typeof mapping !== "object" || !currentNode || !mapping[currentNode]) {
      throw new Error("The current conversation response has no active message branch.");
    }
    const branch = [];
    const seen = new Set();
    let nodeId = currentNode;
    while (nodeId) {
      const node = mapping[nodeId];
      // A broken chain is not a complete conversation starting at message 1.
      // Export numbering requires a verified path all the way to a root;
      // missing ancestors and cycles must fail, not silently truncate it.
      if (!node || typeof node !== "object" || seen.has(nodeId)
        || !Object.hasOwn(node, "parent")
        || (node.parent !== null && (typeof node.parent !== "string" || !node.parent))) {
        throw new Error("The current conversation's active message branch is incomplete or cyclic.");
      }
      seen.add(nodeId);
      branch.push(node);
      nodeId = node.parent;
    }
    return branch.reverse();
  }

  function responseConversationId(payload) {
    return payload?.conversation_id || payload?.conversationId || payload?.id || null;
  }


  global.TidyChatgptActiveBranch = Object.freeze({ activeBranch, responseConversationId });
})(globalThis);

// Source: src/platform/chatgpt/native-message-references.js
// ChatGPT 原生引用只在此解码。下游导出器只接收普通链接与图片块，不能猜内部编号。
(function initTidyChatgptNativeMessageReferences(global) {
  "use strict";
  if (global.TidyChatgptNativeMessageReferences) return;
  const TOKEN_START = "\uE200", TOKEN_END = "\uE201", TOKEN_SEPARATOR = "\uE202";
  const object = value => value && typeof value === "object" && !Array.isArray(value);
  const string = value => typeof value === "string" ? value.trim() : "";
  function publicUrl(value) {
    try {
      const url = new URL(string(value));
      // 凭据不是公开来源的一部分；只允许可独立访问的 HTTP(S) 地址。
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
    } catch { return ""; }
  }
  const imageType = value => /image/i.test(String(value?.type || value?.content_type || ""));
  const titleOf = value => string(value?.title) || string(value?.attribution) || string(value?.name);
  function nodes(reference, inheritedImage = false) {
    if (!object(reference)) return [];
    const image = inheritedImage || imageType(reference);
    return [{ value: reference, image },
      ...nodes(reference.metadata, image),
      ...(Array.isArray(reference.items) ? reference.items.flatMap(item => nodes(item, image)) : [])];
  }
  function sourceCandidates(reference) {
    const candidates = [];
    for (const { value, image } of nodes(reference)) {
      if (image) continue;
      // 标题和地址必须来自同一个对象；绝不把 safe_urls[n] 与 items[n] 拼接。
      const url = publicUrl(value.url) || publicUrl(value.href) || publicUrl(value.link);
      const title = titleOf(value);
      if (url) candidates.push({ title: title || url, url, domain: new URL(url).hostname, named: Boolean(title) });
      for (const raw of Array.isArray(value.safe_urls) ? value.safe_urls : []) {
        const safe = publicUrl(raw);
        if (safe) candidates.push({ title: safe, url: safe, domain: new URL(safe).hostname, named: false });
      }
    }
    return candidates;
  }
  function preferredSources(candidates, namedFirst = true) {
    const byUrl = new Map();
    for (const candidate of namedFirst ? [...candidates.filter(value => value.named), ...candidates.filter(value => !value.named)] : candidates) {
      const previous = byUrl.get(candidate.url);
      if (!previous || (!previous.named && candidate.named)) byUrl.set(candidate.url, candidate);
    }
    return [...byUrl.values()].map(({ title, url, domain }) => ({ title, url, domain }));
  }
  const sourcesFromReference = reference => preferredSources(sourceCandidates(reference));
  const dedupeSources = sources => preferredSources(sources.filter(Boolean).map(source => ({
    ...source, named: Boolean(source.title && source.title !== source.url),
  })), false);
  function references(message) {
    const metadata = message?.metadata || {};
    return [...(Array.isArray(metadata.citations) ? metadata.citations : []),
      ...(Array.isArray(metadata.content_references) ? metadata.content_references : [])];
  }
  const finalSources = message => preferredSources(references(message).flatMap(sourceCandidates));
  function identities(value) {
    const result = new Set();
    const add = raw => { const id = string(raw); if (id && id.length <= 256) result.add(id); };
    for (const key of ["id", "ref_id", "reference_id", "citation_id", "file_id"]) add(value?.[key]);
    for (const ref of [...(Array.isArray(value?.refs) ? value.refs : []), value?.ref].filter(Boolean)) {
      if (typeof ref === "string") { add(ref); continue; }
      for (const key of ["id", "ref_id", "reference_id"]) add(ref?.[key]);
      if (/^\d+$/.test(String(ref?.turn_index)) && /^[a-z]+$/i.test(String(ref?.ref_type))
        && /^\d+$/.test(String(ref?.ref_index))) add(
          `turn${ref.turn_index}${ref.ref_type}${ref.ref_index}`,
        );
    }
    return [...result];
  }
  // 检索图片有时把缩略图和来源装进 caption，而不是独立 image_url。
  // 只解析完整、明确的 Markdown 图片结构；普通说明中的 URL 不能被猜成图片。
  function metadataMarkdownImage(value) {
    const source = string(value), budget = { remaining: Math.max(4096, source.length * 8) };
    const wrapped = source.startsWith("[") ? markdownImage(source, 1, budget) : null;
    const outer = wrapped && source[wrapped.end] === "]"
      ? markdownDestination(source, wrapped.end + 1, budget) : null;
    if (wrapped && outer && outer.end === source.length) return { image: wrapped.image, sourceUrl: outer.url };
    const image = markdownImage(source, 0, budget);
    return image && image.end === source.length ? { image: image.image, sourceUrl: "" } : null;
  }

  // 引用 metadata 与显式 image 内容块共享这一个描述规则，输出只剩普通资源字段。
  function imageDescription(value, typedImage = imageType(value)) {
    const explicitSrc = publicUrl(value.image_url) || publicUrl(value.image?.url)
      || (typedImage ? publicUrl(value.url) || publicUrl(value.src) : "");
    if (!explicitSrc && !typedImage && !value.image_url && !value.image) return null;
    const descriptions = [value.alt, value.caption, value.image?.alt, value.name].map(string).filter(Boolean);
    const parsed = descriptions.map(metadataMarkdownImage).find(Boolean);
    const readable = raw => {
      const image = metadataMarkdownImage(raw);
      return image ? image.image.alt : raw;
    };
    const alt = descriptions.length ? readable(descriptions[0]) : "";
    const name = string(value.name) ? readable(string(value.name)) : alt;
    return {
      src: explicitSrc || parsed?.image.src || "", alt, name, mimeType: string(value.mime_type),
      ...(parsed?.sourceUrl ? { sourceLink: link({ title: alt || parsed.sourceUrl, url: parsed.sourceUrl }) } : {}),
    };
  }

  function imageDescriptors(reference) {
    const result = [];
    for (const { value, image } of nodes(reference)) {
      const descriptor = imageDescription(value, image);
      if (!descriptor) continue;
      if (!descriptor.src && (object(value.metadata) || (Array.isArray(value.items) && value.items.length))) continue;
      result.push(descriptor);
    }
    const seen = new Set();
    return result.filter(item => { const key = JSON.stringify(item); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  function fileNames(reference) {
    return [...new Set(nodes(reference).map(({ value }) => string(value.file_name) || string(value.filename)
      || titleOf(value)).filter(Boolean))];
  }
  function binding(reference) {
    return { sources: sourcesFromReference(reference), images: imageDescriptors(reference), names: fileNames(reference) };
  }
  const sameValues = (left, right) => JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
  function addBinding(map, key, value) {
    if (!key || !(value.sources.length || value.images.length || value.names.length)) return;
    if (!map.has(key)) { map.set(key, value); return; }
    const previous = map.get(key);
    if (!previous) return;
    const sourceUrls = entry => entry.sources.map(source => source.url);
    const imageUrls = entry => entry.images.map(image => image.src).filter(Boolean);
    const conflicts = (left, right) => left.length && right.length && !sameValues(left, right);
    const knownImages = imageUrls(previous).length || imageUrls(value).length;
    // 不同载荷各自判断冲突：文件名差异不能遮蔽同一编号已经明确的网页 URL。
    const ambiguousSources = previous.ambiguousSources || value.ambiguousSources
      || Boolean(conflicts(sourceUrls(previous), sourceUrls(value)));
    const ambiguousImages = previous.ambiguousImages || value.ambiguousImages
      || Boolean(conflicts(imageUrls(previous), imageUrls(value)));
    const ambiguousNames = previous.ambiguousNames || value.ambiguousNames
      || Boolean(conflicts(previous.names, value.names));
    const images = [...previous.images, ...value.images];
    const seenImages = new Set();
    map.set(key, {
      sources: ambiguousSources ? [] : dedupeSources([...previous.sources, ...value.sources]),
      images: ambiguousImages ? [] : images.filter(image => !knownImages || image.src).filter(image => {
        const identity = image.src || image.alt;
        if (seenImages.has(identity)) return false; seenImages.add(identity); return true;
      }),
      names: ambiguousNames ? [] : [...new Set([...previous.names, ...value.names])],
      ambiguousSources, ambiguousImages, ambiguousNames,
    });
  }
  function escapeLabel(value) {
    return String(value).replace(/[\r\n]+/g, " ").replace(/([\\\[\]`*_~|<>&])/g, "\\$1");
  }
  function link(source) {
    const destination = source.url.replace(/([()|&\\])/g, "\\$1").replace(/[<>]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return `[${escapeLabel(source.title)}](${destination})`;
  }
  function inlineCodeEnd(source, index, budget = null) {
    if (source[index] !== "`") return -1;
    const ticks = /^`+/.exec(source.slice(index))[0];
    let end = index + ticks.length;
    while ((end = source.indexOf(ticks, end)) >= 0) {
      if (budget && --budget.remaining < 0) return -1;
      if (source[end - 1] !== "`" && source[end + ticks.length] !== "`") return end + ticks.length;
      end += ticks.length;
    }
    return -1;
  }
  function decodeMarkdownValue(value) {
    const entities = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
    // Markdown 转义优先于字符实体；不把显式 \\&amp; 当作待解码的实体。
    return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])|&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
      (raw, escaped, entity) => {
        if (escaped) return escaped;
        if (entity[0] !== "#") return entities[entity.toLowerCase()] || raw;
        const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : raw;
      });
  }
  function markdownDestination(source, opening, budget) {
    if (source[opening] !== "(") return null;
    let depth = 1, angle = false, quote = "", index = opening + 1;
    for (; index < source.length; index += 1) {
      if (--budget.remaining < 0) return null;
      const character = source[index];
      if (character === "\\") { index += 1; continue; }
      if (quote) { if (character === quote) quote = ""; continue; }
      if (angle) { if (character === ">") angle = false; continue; }
      if (character === "<") { angle = true; continue; }
      if ((character === "\"" || character === "'") && /\s/.test(source[index - 1])) { quote = character; continue; }
      if (character === "(") depth += 1;
      else if (character === ")" && --depth === 0) break;
    }
    if (depth !== 0) return null;
    let raw = source.slice(opening + 1, index).trim();
    if (raw.startsWith("<")) {
      const end = raw.indexOf(">");
      if (end < 0) return null;
      raw = raw.slice(1, end);
    } else raw = raw.replace(/\s+(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\([^()]*\))\s*$/, "");
    return { end: index + 1, url: publicUrl(decodeMarkdownValue(raw)) };
  }
  function markdownImage(source, opening, budget) {
    if (source.slice(opening, opening + 2) !== "![") return null;
    let depth = 1, index = opening + 2;
    for (; index < source.length; index += 1) {
      if (--budget.remaining < 0) return null;
      if (source[index] === "\\") { index += 1; continue; }
      if (source[index] === "[") depth += 1;
      else if (source[index] === "]" && --depth === 0) break;
    }
    if (depth !== 0) return null;
    const destination = markdownDestination(source, index + 1, budget);
    if (!destination) return null;
    const alt = decodeMarkdownValue(source.slice(opening + 2, index));
    return { end: destination.end, image: { src: destination.url, alt, name: alt, mimeType: "" } };
  }
  function createResolver(message) {
    const byId = new Map(), byText = new Map();
    const all = [...references(message), ...(Array.isArray(message?.metadata?.search_result_groups)
      ? message.metadata.search_result_groups.flatMap(group => Array.isArray(group?.entries) ? group.entries : []) : [])];
    for (const reference of all) {
      for (const { value } of nodes(reference)) {
        const entry = binding(value);
        for (const id of identities(value)) addBinding(byId, id, entry);
        if (typeof value.matched_text === "string" && value.matched_text.includes(TOKEN_START)) {
          addBinding(byText, value.matched_text, entry);
        }
      }
    }
    function resolveToken(token, appendImage) {
      const parts = token.slice(1, -1).split(TOKEN_SEPARATOR), kind = parts.shift();
      if (kind === "url") {
        const url = publicUrl(parts[1]);
        return url ? link({ title: parts[0] || url, url }) : "";
      }
      if (!["cite", "filecite", "i", "image"].includes(kind)) return token;
      const exact = byText.get(token);
      const imageToken = kind === "i" || kind === "image";
      const applicable = entry => entry && (imageToken ? entry.images.length || entry.ambiguousImages
        : kind === "cite" ? entry.sources.length || entry.ambiguousSources
          : entry.sources.length || entry.names.length || entry.ambiguousSources || entry.ambiguousNames);
      const ambiguous = entry => imageToken ? entry.ambiguousImages
        : entry.ambiguousSources || (kind === "filecite" && !entry.sources.length && entry.ambiguousNames);
      // matched_text 必须包含当前 token 类型的有效资料；泛化标题不是网页引用映射。
      // 真实目标冲突不回退猜测，只有缺少该类型资料时才查精确编号。
      const identities = parts.map(id => byId.get(id));
      let selected = applicable(exact) ? [exact] : identities;
      // 图片说明仍是有效占位，但不能遮蔽精确编号上已知的图片地址。
      // 若双方均无地址则保留说明；实际地址冲突仍保持未解析状态。
      if (imageToken && exact && !exact.ambiguousImages && !exact.images.some(image => image.src)
        && identities.some(entry => entry && (entry.ambiguousImages || entry.images.some(image => image.src)))) {
        selected = identities;
      }
      const entries = selected.filter(applicable).filter(entry => !ambiguous(entry));
      if (kind === "i" || kind === "image") {
        const images = entries.flatMap(entry => entry.images);
        // 不暴露内部编号；缺少地址时仍生成既有图片占位，媒体开关可正常过滤它。
        return (images.length ? images : [{ src: "", alt: "", name: "", mimeType: "" }]).map(image => appendImage(image) + (image.sourceLink || "")).join("");
      }
      const sources = dedupeSources(entries.flatMap(entry => entry.sources));
      if (sources.length) return sources.map(link).join(" ");
      return kind === "filecite" ? [...new Set(entries.flatMap(entry => entry.names))].map(escapeLabel).join(", ") : "";
    }
    // 按 Markdown 字面量边界扫描：代码块和行内代码里的 token 是用户资料，不是引用。
    function replace(value, appendImage) {
      const source = String(value || "");
      let output = "", index = 0;
      // 畸形长 Markdown 只做有界扫描，不能让单条消息卡住页面 MAIN 世界。
      const budget = { remaining: Math.max(4096, source.length * 8) };
      while (index < source.length) {
        if (budget.remaining < 0) { output += source.slice(index); break; }
        if (index === 0 || source[index - 1] === "\n") {
          const fence = /^\s{0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(source.slice(index));
          if (fence) {
            const endPattern = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*(?:\\n|$)`, "gm");
            endPattern.lastIndex = index + fence[0].length;
            const end = endPattern.exec(source);
            const until = end ? end.index + end[0].length : source.length;
            output += source.slice(index, until); index = until; continue;
          }
        }
        if (source[index] === "\\") { output += source.slice(index, index + 2); index += 2; continue; }
        const codeEnd = inlineCodeEnd(source, index, budget);
        if (codeEnd > index) { output += source.slice(index, codeEnd); index = codeEnd; continue; }
        // 真正 Markdown 图片与原生图片走同一媒体模型；代码示例不进入此分支。
        const wrappedImage = source[index] === "[" ? markdownImage(source, index + 1, budget) : null;
        const outerLink = wrappedImage && source[wrappedImage.end] === "]"
          ? markdownDestination(source, wrappedImage.end + 1, budget) : null;
        if (wrappedImage && outerLink) {
          output += appendImage(wrappedImage.image);
          if (outerLink.url) output += link({ title: wrappedImage.image.alt || outerLink.url, url: outerLink.url });
          index = outerLink.end; continue;
        }
        const image = markdownImage(source, index, budget);
        if (image) { output += appendImage(image.image); index = image.end; continue; }
        if (source[index] === TOKEN_START) {
          const end = source.indexOf(TOKEN_END, index + 1);
          if (end >= 0) { output += resolveToken(source.slice(index, end + 1), appendImage); index = end + 1; continue; }
          output += source.slice(index); break;
        }
        output += source[index++];
      }
      return output;
    }
    return Object.freeze({ replace });
  }
  global.TidyChatgptNativeMessageReferences = Object.freeze({ publicUrl, imageDescription, sourcesFromReference, finalSources, dedupeSources, createResolver, inlineCodeEnd });
})(globalThis);

// Source: src/platform/chatgpt/native-message-content.js
// 原生消息正文的纯解码：不读取页面、不请求网络、不拥有导出状态。
(function initTidyChatgptNativeMessageContent(global) {
  "use strict";
  if (global.TidyChatgptNativeMessageContent) return;
  const { publicUrl, imageDescription, createResolver, inlineCodeEnd } = global.TidyChatgptNativeMessageReferences;
  function toIso(value) {
    if (value == null || value === "") return null;
    let number = Number(value);
    if (Number.isFinite(number) && Math.abs(number) < 100_000_000_000) number *= 1000;
    const date = Number.isFinite(number) ? new Date(number) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function textValue(value) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    return typeof value.text === "string" ? value.text
      : typeof value.content === "string" ? value.content
        : "";
  }

  function cleanInlineStyles(value) {
    return String(value || "")
      .replace(/(\*\*|__|~~)([^\n]+?)\1/g, "$2")
      .replace(/(^|[\s(])([*_])([^*_\n]+)\2(?=$|[\s).,!?:;])/g, "$1$3")
      .replace(/`([^`]+)`/g, "$1");
  }

  // 链接包含正文资料，不是可丢弃的样式。只识别片段边界，完整保留其原始
  // Markdown（目标、标题、括号及转义）；不执行 HTML，也不改写目标地址。
  // 顺序扫描避免用一个大正则处理嵌套括号；不完整的候选同样保留原文。
  function inlineLinkEnd(source, opening, budget = null) {
    let depth = 1, quote = "", angle = false, destinationStart = true;
    for (let index = opening + 1; index < source.length; index += 1) {
      if (budget && --budget.remaining < 0) return source.length;
      const character = source[index];
      if (character === "\\") { index += 1; continue; }
      if (quote) { if (character === quote) quote = ""; continue; }
      if (angle) { if (character === ">") angle = false; continue; }
      if (destinationStart && /\s/.test(character)) continue;
      if (destinationStart && character === "<") { destinationStart = false; angle = true; continue; }
      destinationStart = false;
      if ((character === '"' || character === "'") && /\s/.test(source[index - 1])) { quote = character; continue; }
      if (character === "(") depth += 1;
      else if (character === ")" && --depth === 0) return index + 1;
    }
    return source.length;
  }

  function cleanInlineMarkdown(value) {
    const source = String(value || ""), labels = [];
    let output = "", plainStart = 0;
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] === "\\") { index += 1; continue; }
      const codeEnd = inlineCodeEnd(source, index);
      if (codeEnd > index) {
        output += cleanInlineStyles(source.slice(plainStart, index)) + source.slice(index, codeEnd);
        plainStart = codeEnd; index = codeEnd - 1; labels.length = 0; continue;
      }
      if (source[index] === "[") labels.push(index);
      else if (source[index] === "]" && labels.length) {
        const start = labels.pop();
        if (source[index + 1] !== "(") continue;
        const end = inlineLinkEnd(source, index + 1);
        output += cleanInlineStyles(source.slice(plainStart, start)) + source.slice(start, end);
        plainStart = end;
        index = end - 1;
        labels.length = 0;
      }
    }
    return (output + cleanInlineStyles(source.slice(plainStart))).trim();
  }


  // 只处理最终助手明确交付的 sandbox Markdown 链接；路径不成为下载地址，
  // 也不按扩展名猜 MIME。工具路径、裸路径和代码示例都不是附件交付证据。
  function attachmentMarkdownValue(value) {
    const entities = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
    return String(value).replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_\x60{|}~])|&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
      (raw, escaped, entity) => {
        if (escaped) return escaped;
        if (entity[0] !== "#") return entities[entity.toLowerCase()] || raw;
        const point = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : raw;
      });
  }

  function sandboxAttachmentLink(source, start, closing, budget) {
    let index = closing + 2;
    while (/\s/.test(source[index] || "")) index += 1;
    const angle = source[index] === "<";
    if (angle) index += 1;
    // 先确认精确协议/根目录，普通公网链接不进入附件路径解析。
    if (!source.startsWith("sandbox:/mnt/data/", index)) return null;
    const opening = index;
    let depth = 0;
    for (; index < source.length; index += 1) {
      if (--budget.remaining < 0) return null;
      const character = source[index];
      if (character === "\\") { index += 1; continue; }
      if (angle) {
        if (character === ">") break;
        if (character === "\n" || character === "<") return null;
      } else {
        if (character === "(") depth += 1;
        else if (character === ")") { if (!depth) break; depth -= 1; }
        else if (/\s/.test(character)) { if (depth) return null; break; }
      }
    }
    if (depth || (angle && source[index] !== ">")) return null;
    const raw = source.slice(opening, index);
    if (angle) index += 1;
    const spacing = index;
    while (/\s/.test(source[index] || "")) index += 1;
    if (source[index] !== ")") {
      const opener = source[index], closer = opener === "(" ? ")" : opener;
      if (index === spacing || !["\"", "'", "("].includes(opener)) return null;
      index += 1;
      for (; index < source.length && source[index] !== closer; index += 1) {
        if (--budget.remaining < 0) return null;
        if (source[index] === "\\") index += 1;
      }
      if (source[index] !== closer) return null;
      index += 1;
      while (/\s/.test(source[index] || "")) index += 1;
      if (source[index] !== ")") return null;
    }
    const destination = attachmentMarkdownValue(raw);
    if (!destination.startsWith("sandbox:/mnt/data/") || /[?#\u0000-\u001f\u007f]/.test(destination)) return null;
    let segments;
    try { segments = destination.slice("sandbox:/mnt/data/".length).split("/").map(decodeURIComponent); } catch { return null; }
    // 非文件、越界和编码的目录分隔符不被包装成看似可靠的附件。
    if (segments.some(part => !part || part === "." || part === ".." || /[\\/\u0000-\u001f\u007f]/.test(part))
      || !segments[segments.length - 1].trim()) return null;
    return { end: index + 1, attachment: {
      name: segments[segments.length - 1],
      label: cleanInlineStyles(attachmentMarkdownValue(source.slice(start + 1, closing))).trim(),
    } };
  }

  // HTML 标签属性、注释和原样代码容器不是可见的文件交付。
  // closing 跨段落保留，避免含空行的 <pre> / 注释中途恢复附件识别。
  function attachmentMarkupEnd(source, start, budget, state) {
    const consumeClosing = from => {
      const match = new RegExp(state.closing, "i").exec(source.slice(from));
      if (!match) return source.length;
      state.closing = "";
      return from + match.index + match[0].length;
    };
    if (state.closing) return consumeClosing(start);
    if (source.startsWith("<!--", start)) {
      state.closing = "-->";
      return consumeClosing(start + 4);
    }
    const tag = /^<(\/?)([a-z][\w-]*)(?=[\s/>])/i.exec(source.slice(start));
    const autolink = /^<(?:https?:\/\/|mailto:|sandbox:)/i.test(source.slice(start));
    if (!tag && !autolink) return -1;
    let quote = "", index = start + 1;
    for (; index < source.length; index += 1) {
      if (--budget.remaining < 0) return source.length;
      const character = source[index];
      if (quote) { if (character === quote) quote = ""; continue; }
      if (character === "\"" || character === "'") { quote = character; continue; }
      if (character === ">") break;
    }
    if (index >= source.length) return source.length;
    if (tag && !tag[1] && /^(?:code|pre|script|style|textarea)$/i.test(tag[2])
      && source[index - 1] !== "/") {
      state.closing = "</" + tag[2] + "\\s*>";
      return consumeClosing(index + 1);
    }
    return index + 1;
  }

  function replaceFinalAttachments(value, appendAttachment, state) {
    const source = String(value || ""), labels = [];
    const budget = { remaining: Math.max(4096, source.length * 8) };
    let output = "", plainStart = 0;
    for (let index = 0; index < source.length && budget.remaining >= 0; index += 1) {
      if (state.closing || source[index] === "<") {
        const end = attachmentMarkupEnd(source, index, budget, state);
        if (end > index) { index = end - 1; labels.length = 0; continue; }
      }
      if (source[index] === "\\") { index += 1; continue; }
      const codeEnd = inlineCodeEnd(source, index, budget);
      // 跳过代码内部，但保留外层链接标签；[Read code](file) 的标签允许含代码 span。
      if (codeEnd > index) { index = codeEnd - 1; continue; }
      if (source[index] === "[") labels.push(index);
      else if (source[index] === "]" && labels.length) {
        const start = labels.pop();
        if (source[index + 1] !== "(") continue;
        let escapes = 0;
        for (let before = start - 2; before >= 0 && source[before] === "\\"; before -= 1) escapes += 1;
        const image = source[start - 1] === "!" && escapes % 2 === 0;
        const link = image ? null : sandboxAttachmentLink(source, start, index, budget);
        if (!link) {
          // 非附件链接整体保留，不能深入其 URL/title，把里面的文本误当附件。
          index = inlineLinkEnd(source, index + 1, budget) - 1; labels.length = 0; continue;
        }
        output += source.slice(plainStart, start) + appendAttachment(link.attachment);
        plainStart = link.end; index = link.end - 1; labels.length = 0;
      }
    }
    return output + source.slice(plainStart);
  }

  function splitTableRow(line) {
    return line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
  }

  // 从接口返回的 Markdown 正文拆出段落、代码、列表等内容块。
  // 导出使用完整源内容，不拿界面截短后的摘要代替正文。
  function markdownToBlocks(value, resolver = null, appendImage = null, appendAttachment = null) {
    const original = String(value || "");
    let mediaPrefix = "\u0000tidy-media:";
    while (original.includes(mediaPrefix)) mediaPrefix += ":";
    const media = [], attachmentState = {};
    const mark = item => mediaPrefix + (media.push(item) - 1) + "\u0000";
    const appendMedia = item => item.type === "attachment" ? appendAttachment(item.value) : appendImage(item.value);
    const resolve = text => {
      const imagesResolved = resolver ? resolver.replace(text, image => mark({ type: "image", value: image })) : text;
      return appendAttachment
        ? replaceFinalAttachments(imagesResolved, attachment => mark({ type: "attachment", value: attachment }), attachmentState)
        : imagesResolved;
    };
    const lines = original.replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index += 1; continue; }

      // 只有新块开头的四空格/制表符属于缩进代码；段落续行仍由段落消费。
      if (/^(?: {4}|\t)/.test(line)) {
        const code = [];
        while (index < lines.length && (/^(?: {4}|\t)/.test(lines[index]) || !lines[index].trim())) {
          code.push(lines[index].replace(/^(?: {4}|\t)/, "")); index += 1;
        }
        while (code.length && !code[code.length - 1]) code.pop();
        blocks.push({ type: "code", language: "", code: code.join("\n") });
        continue;
      }
      const fence = line.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)$/);
      if (fence) {
        const marker = fence[1][0];
        const length = fence[1].length;
        const code = [];
        index += 1;
        while (index < lines.length && !new RegExp(`^\\s*${marker}{${length},}\\s*$`).test(lines[index])) {
          code.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        blocks.push({ type: "code", language: fence[2].trim().split(/\s+/)[0] || "", code: code.join("\n") });
        continue;
      }

      const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
      if (heading) {
        blocks.push({ type: "heading", level: heading[1].length, text: cleanInlineMarkdown(heading[2]) });
        index += 1;
        continue;
      }

      if (
        index + 1 < lines.length
        && line.includes("|")
        && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])
      ) {
        const headers = splitTableRow(line).map(cleanInlineMarkdown);
        const rows = [];
        index += 2;
        while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
          rows.push(splitTableRow(lines[index]).map(cleanInlineMarkdown));
          index += 1;
        }
        blocks.push({ type: "table", headers, rows });
        continue;
      }

      const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        const type = unordered ? "unordered-list" : "ordered-list";
        const items = [];
        while (index < lines.length) {
          const match = type === "unordered-list"
            ? lines[index].match(/^\s*[-+*]\s+(.+)$/)
            : lines[index].match(/^\s*\d+[.)]\s+(.+)$/);
          if (!match) break;
          items.push(cleanInlineMarkdown(match[1]));
          index += 1;
        }
        blocks.push({ type, items });
        continue;
      }

      if (/^\s*>/.test(line)) {
        const quote = [];
        while (index < lines.length && /^\s*>/.test(lines[index])) {
          quote.push(lines[index].replace(/^\s*>\s?/, ""));
          index += 1;
        }
        blocks.push({ type: "blockquote", text: cleanInlineMarkdown(quote.join("\n")) });
        continue;
      }

      const paragraph = [line];
      index += 1;
      while (index < lines.length && lines[index].trim()) {
        if (/^\s*(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|>|`{3,}|~{3,})/.test(lines[index])) break;
        paragraph.push(lines[index]);
        index += 1;
      }
      blocks.push({ type: "paragraph", text: paragraph.join("\n").trim() });
    }
    // 段落媒体按原顺序成为独立块；表格/列表的图片和附件放在宿主块之后，不破坏其结构。
    const expanded = [];
    const marker = new RegExp(mediaPrefix + "(\\d+)\\u0000", "g");
    for (const block of blocks) {
      // 先识别 Markdown 结构，再只解码非代码块；引用不能改变块边界或改写代码资料。
      if (block.type === "code") { expanded.push(block); continue; }
      if (typeof block.text === "string") block.text = resolve(block.text);
      if (block.items) block.items = block.items.map(resolve);
      if (block.headers) block.headers = block.headers.map(resolve);
      if (block.rows) block.rows = block.rows.map(row => row.map(resolve));
      if (!media.length) { expanded.push(block); continue; }
      const trailing = [];
      const extract = text => String(text).replace(marker, (_, index) => {
        trailing.push(appendMedia(media[Number(index)])); return "";
      });
      if (block.type === "paragraph") {
        let start = 0;
        for (const match of block.text.matchAll(marker)) {
          const text = block.text.slice(start, match.index).trim();
          if (text) expanded.push({ type: "paragraph", text });
          expanded.push(appendMedia(media[Number(match[1])]));
          start = match.index + match[0].length;
        }
        const text = block.text.slice(start).trim();
        if (text) expanded.push({ type: "paragraph", text });
        continue;
      }
      if (typeof block.text === "string") block.text = extract(block.text).trim();
      if (block.items) block.items = block.items.map(item => {
        const delivered = [...String(item).matchAll(marker)].some(match => media[Number(match[1])].type === "attachment");
        const value = extract(item);
        // 纯附件列表项已由独立附件块承接，不留下空 bullet；原本内容和图片规则不变。
        return delivered && !value.trim() ? null : value;
      }).filter(item => item !== null);
      if (block.headers) block.headers = block.headers.map(extract);
      if (block.rows) block.rows = block.rows.map(row => row.map(extract));
      expanded.push(block, ...trailing);
    }
    return expanded.filter((block) => {
      if (["paragraph", "heading", "blockquote"].includes(block.type)) return Boolean(block.text.trim());
      if (["ordered-list", "unordered-list"].includes(block.type)) return block.items.length > 0;
      if (block.type === "code") return Boolean(block.code || block.language);
      if (block.type === "table") return block.headers.length > 0;
      return true;
    });
  }

  const imageResourceId = (sourceMessageId, partIndex) => `${sourceMessageId}:image:${partIndex + 1}`;

  function contentBlocks(message, warnings, resources, sourceMessageId, imageReferences, options = {}) {
    const content = message?.content || {};
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const blocks = [];
    const resolver = createResolver(message);
    let inlineImageIndex = 0, attachmentIndex = 0;
    const resourceIds = new Set(resources.map(resource => resource.id));
    const appendImage = image => {
      let resourceId;
      do { resourceId = sourceMessageId + ":inline-image:" + (++inlineImageIndex); } while (resourceIds.has(resourceId));
      resourceIds.add(resourceId);
      resources.push({ id: resourceId, type: "image", name: image.name || "image-" + inlineImageIndex,
        mimeType: image.mimeType || "", sizeBytes: null, src: image.src || "", alt: image.alt || "" });
      return { type: "image", resourceId, alt: image.alt || "" };
    };
    // 是否为最终回复由会话投影的既有 classifier 决定；这里仍要求明确的最终频道，
    // 防止工具/推理解码意外启用文件提升。最终交付说明与真实 basename 分开保留。
    const appendAttachment = options.finalAttachments === true
      && message?.author?.role === "assistant" && message?.recipient === "all" && message?.channel === "final"
      ? attachment => {
        let resourceId;
        do { resourceId = sourceMessageId + ":attachment:" + (++attachmentIndex); } while (resourceIds.has(resourceId));
        resourceIds.add(resourceId);
        resources.push({ id: resourceId, type: "attachment", name: attachment.name,
          mimeType: "", sizeBytes: null, src: "", alt: "" });
        return { type: "attachment", resourceId, label: attachment.label };
      } : null;
    const contentType = String(content.content_type || "text");
    if (contentType === "code") {
      const code = parts.map(textValue).filter(Boolean).join("\n") || textValue(content.text);
      if (code) blocks.push({ type: "code", language: String(content.language || ""), code });
    } else {
      for (const [partIndex, part] of parts.entries()) {
        const text = textValue(part);
        if (text) blocks.push(...markdownToBlocks(text, resolver, appendImage, appendAttachment));
        if (!part || typeof part !== "object") continue;
        const partType = String(part.content_type || part.type || "");
        if (/image/i.test(partType)) {
          const descriptor = imageDescription(part);
          const { src, alt } = descriptor;
          const resourceId = imageResourceId(sourceMessageId, partIndex);
          resources.push({
            id: resourceId,
            type: "image",
            name: descriptor.name || `image-${partIndex + 1}`,
            mimeType: descriptor.mimeType,
            sizeBytes: null,
            src,
            alt,
          });
          blocks.push({
            type: "image",
            resourceId,
            alt,
          });
          if (descriptor.sourceLink) blocks.push({ type: "paragraph", text: descriptor.sourceLink });
          // 上传图片返回文件引用，不是公开 URL。先登记，用户实际选择它时再查地址。
          const fileId = /^sediment:\/\/(file_[a-f0-9]{32})$/i.exec(String(part.asset_pointer || ""))?.[1];
          if (!src && fileId && imageReferences) imageReferences.set(resourceId, fileId);
          else if (!src) warnings.add("IMAGE_UNAVAILABLE");
        }
      }
    }
    if (!blocks.length) {
      const fallback = textValue(content.text || content.result || message?.text);
      if (fallback) blocks.push(...markdownToBlocks(fallback, resolver, appendImage, appendAttachment));
    }
    return blocks;
  }


  global.TidyChatgptNativeMessageContent = Object.freeze({ toIso, textValue, imageResourceId, cleanInlineMarkdown, markdownToBlocks, publicUrl, contentBlocks });
})(globalThis);

// Source: src/platform/chatgpt/native-message-process.js
// 原生推理、工具与来源记录的纯投影；正文解码与过程分组各自只有一份规则。
(function initTidyChatgptNativeMessageProcess(global) {
  "use strict";
  if (global.TidyChatgptNativeMessageProcess) return;
  const { toIso, textValue, contentBlocks, imageResourceId } = global.TidyChatgptNativeMessageContent;
  const { sourcesFromReference, finalSources, dedupeSources } = global.TidyChatgptNativeMessageReferences;

  function isHiddenMessage(message) {
    const contentType = String(message?.content?.content_type || "");
    return message?.metadata?.is_visually_hidden_from_conversation === true
      || ["model_editable_context", "user_editable_context"].includes(contentType);
  }

  function isFinalAssistantMessage(message) {
    if (message?.author?.role !== "assistant" || isHiddenMessage(message)) return false;
    const contentType = String(message?.content?.content_type || "text");
    const recipient = message?.recipient;
    return !["thoughts", "reasoning_recap"].includes(contentType)
      && message?.metadata?.reasoning_status !== "is_reasoning"
      && message?.metadata?.is_thinking_preamble_message !== true
      && (recipient == null || recipient === "all");
  }

  // 生成结果本身是用户可见内容，不等于“工具过程”。工具名可能是每次不同的
  // 内部别名，因此优先认图片 part 自身的生成身份，而不是猜别名或匹配标题。
  // 只有结构化图片可以提升；普通工具图片、过程文字和 Markdown 图片仍归过程。
  const IMAGE_GENERATION_TOOLS = new Set(["image_gen", "image_gen.text2im", "dalle", "dalle.text2im"]);
  function hasImageGenerationIdentity(part) {
    return [part?.metadata?.generation?.gen_id, part?.metadata?.dalle?.gen_id]
      .some(id => typeof id === "string" && Boolean(id.trim()));
  }

  function visibleGeneratedImageResourceIds(message, sourceMessageId) {
    if (message?.author?.role !== "tool" || isHiddenMessage(message)
      || message?.metadata?.reasoning_status === "is_reasoning"
      || message?.metadata?.is_thinking_preamble_message === true
      || (message?.recipient != null && message.recipient !== "all")) return new Set();
    const name = String(message?.author?.name || message?.metadata?.tool_name || "").trim();
    const explicitImageTool = IMAGE_GENERATION_TOOLS.has(name);
    const parts = Array.isArray(message?.content?.parts) ? message.content.parts : [];
    return new Set(parts.flatMap((part, index) => (
      part && ["image_asset_pointer", "image"].includes(String(part.content_type || part.type || ""))
        && (hasImageGenerationIdentity(part) || explicitImageTool)
        ? [imageResourceId(sourceMessageId, index)] : []
    )));
  }

  function thoughtProcessBlocks(message, warnings, resources, sourceMessageId, imageReferences) {
    if (!message || isHiddenMessage(message)) return [];
    const content = message.content || {};
    const contentType = String(content.content_type || "");
    const blocks = [];
    const decode = text => contentBlocks({ ...message, content: { content_type: "text", parts: [text] } },
      warnings, resources, sourceMessageId, imageReferences);

    if (contentType === "thoughts" && Array.isArray(content.thoughts)) {
      for (const thought of content.thoughts) {
        const summary = textValue(thought?.summary).trim();
        const detail = textValue(thought?.content).trim();
        if (summary) blocks.push(...decode("#### " + summary));
        if (detail) blocks.push(...decode(detail));
      }
    }

    if (contentType === "reasoning_recap") {
      const recap = textValue(content.content || content.text || content.parts?.[0]).trim();
      if (recap) blocks.push(...decode(recap.split("\n").map(line => "> " + line).join("\n")));
    }

    if (message?.metadata?.is_thinking_preamble_message === true) {
      const preamble = (Array.isArray(content.parts) ? content.parts : [])
        .map(textValue)
        .filter(Boolean)
        .join("\n")
        .trim();
      if (preamble) blocks.push(...decode(preamble));
    }

    return blocks;
  }

  function sourceFromSearchEntry(entry) {
    return sourcesFromReference({
      url: entry?.url || entry?.link,
      title: entry?.title || entry?.name,
    })[0] || null;
  }

  function searchResults(message) {
    const groups = message?.metadata?.search_result_groups;
    if (!Array.isArray(groups)) return [];
    const seen = new Set();
    return groups.flatMap((group) => Array.isArray(group?.entries) ? group.entries : [])
      .map(sourceFromSearchEntry)
      .filter((source) => {
        if (!source || seen.has(source.url)) return false;
        seen.add(source.url);
        return true;
      });
  }

  function reasoningQueries(message) {
    if (message?.metadata?.reasoning_status !== "is_reasoning") return [];
    const rawQueries = Array.isArray(message.metadata.search_queries)
      ? message.metadata.search_queries
      : [];
    const queries = rawQueries.map((query) => {
      if (typeof query === "string") return query.trim();
      return String(query?.query || query?.q || query?.text || "").trim();
    }).filter(Boolean);
    return queries;
  }

  function explicitTool(message) {
    const name = String(
      (message?.recipient != null && message.recipient !== "all" ? message.recipient : "")
      || message?.author?.name
      || message?.metadata?.tool_name
      || "",
    ).trim();
    if (!name) return null;
    const callId = String(message?.metadata?.tool_call_id || message?.metadata?.call_id || "");
    return { name, callId };
  }

  function processSegment(message, sourceMessageId, warnings, resources, imageReferences) {
    const timestamp = toIso(message.create_time);
    const contentType = String(message?.content?.content_type || "");
    const reasoningBlocks = thoughtProcessBlocks(message, warnings, resources, sourceMessageId, imageReferences);
    const queries = reasoningQueries(message);
    const results = searchResults(message);
    const tool = explicitTool(message);
    const label = String(message?.metadata?.reasoning_title || message?.metadata?.title || "");
    const hasSearchStructure = queries.length > 0
      || results.length > 0
      || tool?.name === "web.run";

    if (hasSearchStructure) {
      return {
        type: "process",
        sourceMessageId,
        timestamp,
        category: "search",
        phase: results.length > 0 ? "result" : "request",
        label,
        blocks: reasoningBlocks,
        queries,
        results,
        tool,
      };
    }

    if (reasoningBlocks.length) {
      return {
        type: "process",
        sourceMessageId,
        timestamp,
        category: "reasoning",
        phase: ["thoughts", "reasoning_recap"].includes(contentType) ? "summary" : "event",
        label,
        blocks: reasoningBlocks,
        queries: [],
        results: [],
        tool: null,
      };
    }

    if (tool || message?.author?.role === "tool") {
      const readableBlocks = contentBlocks(message, warnings, resources, sourceMessageId, imageReferences);
      return {
        type: "process",
        sourceMessageId,
        timestamp,
        category: "tool",
        phase: message?.author?.role === "tool" ? "result" : "request",
        label,
        blocks: readableBlocks,
        queries: [],
        results: [],
        tool: tool || { name: "tool", callId: "" },
      };
    }

    const readableBlocks = contentBlocks(message, warnings, resources, sourceMessageId, imageReferences);
    if (!readableBlocks.length && !label) return null;
    return {
      type: "process",
      sourceMessageId,
      timestamp,
      category: "generic",
      phase: "event",
      label,
      blocks: readableBlocks,
      queries: [],
      results: [],
      tool: null,
    };
  }


  global.TidyChatgptNativeMessageProcess = Object.freeze({ isHiddenMessage, isFinalAssistantMessage, visibleGeneratedImageResourceIds, finalSources, dedupeSources, processSegment });
})(globalThis);

// Source: src/platform/chatgpt/conversation-projection.js
// 活动分支的唯一逻辑消息分组：快照编号与导出内容共用，既不依赖功能模块也不保留原始正文。
(function initTidyChatgptConversationProjection(global) {
  "use strict";
  if (global.TidyChatgptConversationProjection) return;
  const { toIso, contentBlocks } = global.TidyChatgptNativeMessageContent;
  const { isHiddenMessage, isFinalAssistantMessage, visibleGeneratedImageResourceIds, finalSources, dedupeSources, processSegment } = global.TidyChatgptNativeMessageProcess;
  const { activeBranch, responseConversationId } = global.TidyChatgptActiveBranch;
  // 这些是原生投影本身的不变量，不借用导出文件格式契约。否则损坏的
  // 同一响应可能被导出拒绝，却被快照编号接受成 stableIdentity。
  function assertProjection(document) {
    const errors = [];
    const nonEmpty = value => typeof value === "string" && Boolean(value.trim());
    if (!nonEmpty(document.conversation.id)) errors.push("conversation.id");
    const resources = new Set();
    for (const [index, resource] of document.conversation.resources.entries()) {
      const prefix = `conversation.resources[${index}]`;
      if (!nonEmpty(resource.name)) errors.push(`${prefix}.name`);
      if (resources.has(resource.id)) errors.push(`${prefix}.duplicateId`);
      resources.add(resource.id);
    }
    const messages = new Set();
    for (const [index, message] of document.conversation.messages.entries()) {
      const prefix = `conversation.messages[${index}]`;
      if (!nonEmpty(message.id)) errors.push(`${prefix}.id`);
      if (messages.has(message.id)) errors.push(`${prefix}.duplicateId`);
      messages.add(message.id);
      for (const [segmentIndex, segment] of message.segments.entries()) {
        const segmentPrefix = `${prefix}.segments[${segmentIndex}]`;
        if (!nonEmpty(segment.sourceMessageId)) errors.push(`${segmentPrefix}.sourceMessageId`);
        if (segment.type === "process" && !(segment.label.trim() || segment.blocks.length
          || segment.queries.length || segment.results.length || segment.tool?.name)) {
          errors.push(`${segmentPrefix}.emptyProcess`);
        }
        const sources = segment.type === "sources" ? segment.items
          : segment.type === "process" ? segment.results : [];
        for (const [sourceIndex, source] of sources.entries()) {
          if (!nonEmpty(source.title)) errors.push(`${segmentPrefix}.sources[${sourceIndex}].title`);
        }
      }
    }
    if (errors.length) throw new Error(`Invalid canonical conversation projection: ${errors.join(", ")}`);
  }

  function projectConversation(payload, expectedConversationId, value = {}, sourceUrl = "", imageReferences = null) {
    const warnings = new Set();
    const messages = [];
    const resources = [];
    let assistantSegments = [];

    function flushAssistantMessage() {
      if (!assistantSegments.length) return;
      const primary = [...assistantSegments].reverse().find((segment) => segment.type === "content")
        || assistantSegments[assistantSegments.length - 1];
      messages.push({
        id: primary.sourceMessageId,
        messageNumber: messages.length + 1,
        role: "assistant",
        timestamp: primary.timestamp,
        segments: assistantSegments,
      });
      assistantSegments = [];
    }

    for (const node of activeBranch(payload)) {
      const message = node?.message;
      const role = message?.author?.role;
      if (!message || isHiddenMessage(message)) continue;
      const sourceMessageId = String(message.id || node.id || `source-${messages.length + assistantSegments.length + 1}`);
      const timestamp = toIso(message.create_time);

      if (role === "user") {
        flushAssistantMessage();
        const blocks = contentBlocks(message, warnings, resources, sourceMessageId, imageReferences);
        if (!blocks.length) continue;
        messages.push({
          id: sourceMessageId,
          messageNumber: messages.length + 1,
          role: "user",
          timestamp,
          segments: [{ type: "content", sourceMessageId, timestamp, blocks }],
        });
        continue;
      }

      if (role === "assistant" && isFinalAssistantMessage(message)) {
        // 只有已确认的最终回复允许把显式文件交付转为附件；过程解码不启用。
        const blocks = contentBlocks(message, warnings, resources, sourceMessageId, imageReferences, { finalAttachments: true });
        if (blocks.length) {
          assistantSegments.push({ type: "content", sourceMessageId, timestamp, blocks });
        }
        const sources = dedupeSources(finalSources(message));
        if (sources.length) {
          assistantSegments.push({ type: "sources", sourceMessageId, timestamp, items: sources });
        }
        continue;
      }

      if (!["assistant", "tool"].includes(role)) continue;
      const process = processSegment(message, sourceMessageId, warnings, resources, imageReferences);
      if (process) {
        const visibleImages = process.category === "tool" ? visibleGeneratedImageResourceIds(message, sourceMessageId) : new Set();
        if (!visibleImages.size) { assistantSegments.push(process); continue; }
        // 解码只做一次，资源句柄不复制。图片和工具文字按原有顺序分别归属；
        // 关闭工具过程只隐藏过程文字，关闭图片才隐藏最终生成图。
        let current = null;
        for (const block of process.blocks) {
          const type = block.type === "image" && visibleImages.has(block.resourceId) ? "content" : "process";
          if (!current || current.type !== type) {
            current = type === "content"
              ? { type, sourceMessageId, timestamp, blocks: [] }
              : { ...process, blocks: [] };
            assistantSegments.push(current);
          }
          current.blocks.push(block);
        }
        if (!process.blocks.length) assistantSegments.push(process);
      }
    }
    flushAssistantMessage();
    if (!messages.length) throw new Error("The current conversation has no exportable messages.");

    const createdAt = toIso(payload.create_time) || messages.find((message) => message.timestamp)?.timestamp || "";
    const updatedAt = toIso(payload.update_time) || [...messages].reverse().find((message) => message.timestamp)?.timestamp || createdAt;
    const document = {
      conversation: {
        id: expectedConversationId,
        title: String(payload.title || value.fallbackTitle || ""),
        createdAt,
        updatedAt,
        sourceUrl,
        resources,
        messages,
      },
      warnings: [...warnings],
    };
    assertProjection(document);
    return document;
  }

  function messageNumbersFromPayload(payload, conversationId) {
    const responseId = responseConversationId(payload);
    if (responseId && responseId !== conversationId) throw new Error("The numbered conversation changed.");
    const document = projectConversation(payload, conversationId);
    const exactIds = new Set(activeBranch(payload).map(node => node.message?.id).filter(id => typeof id === "string" && id));
    const numbers = Object.create(null);
    for (const message of document.conversation.messages) {
      for (const id of [message.id, ...message.segments.map(segment => segment.sourceMessageId)]) {
        if (exactIds.has(id)) numbers[id] = message.messageNumber;
      }
    }
    return numbers;
  }


  global.TidyChatgptConversationProjection = Object.freeze({ projectConversation, messageNumbersFromPayload });
})(globalThis);

// Source: src/platform/chatgpt/api.js
// ChatGPT 会话与鉴权入口：凭据只留在页面内存中，向扩展提供最小身份信息。
// 页面、账号或工作区变化会使旧请求失效，不能把晚到响应当作新账号的数据。
(function initTidyChatgptApi(global) {
  "use strict";

  if (global.TidyChatgptApi) return;

  // Extension replacement retires this instance permanently. This boundary is
  // separate from pagehide/BFCache, which can resume the same live extension.
  const pageSession = global.TidyPageSession;

  const SESSION_ENDPOINT = "/api/auth/session";
  let cachedSession = null;
  let cachedAccessToken = "";
  let sessionRequest = null;
  // Library ownership is a page-session lease, not a network check per action.
  // Only an observed identity/workspace/document boundary advances this epoch.
  let libraryIdentity = { accountKey: null, epoch: 0, phase: "unavailable" };
  let libraryWorkspace;
  // Provenance only: these fields classify a local invalidation; they never
  // keep a lease/token alive or authorize accepting a stale session ticket.
  let lastReadyWorkspace;
  let workspaceUnconfirmed = false;
  let hardBoundarySinceReady = false;
  let libraryAttempted = false;
  let libraryPending = null;
  let libraryFailure = null;
  let documentActive = true;
  // Unlike the public epoch, this fence advances only when existing requests
  // lose authority. Accepting an earlier valid proof must not discard a later
  // request from the same unchanged document/workspace boundary.
  let identityBoundary = 0;
  let sessionSequence = 0;
  let acceptedSessionSequence = 0;
  let observedSessionPending = null;
  const identityListeners = new Set();
  const responseTickets = new WeakMap();
  const titleListeners = new Set();
  const ownTitleRequests = new WeakSet();
  // 仅登记正在发生的改名，不保存所有会话 ID，也不轮询目录。
  const pendingRenames = new Map();

  function workspaceSelection() {
    // ChatGPT's selected workspace comes from _account. An absent/empty cookie
    // means personal; a malformed selection must never silently become personal.
    // All title and library consumers share this parser, not separate fallbacks.
    const pair = String(global.document?.cookie || "").split(";")
      .map(part => part.trim()).find(part => part.startsWith("_account="));
    try {
      const selected = pair ? decodeURIComponent(pair.slice(9)) : "";
      return { workspace: selected || "personal", explicit: Boolean(selected) };
    }
    catch { throw Object.assign(new Error("The active workspace is unavailable."), { tidyCode: "CONTEXT_MISMATCH" }); }
  }

  function activeWorkspace() { pageSession.assertActive(); return workspaceSelection().workspace; }

  function identityError(message = "The signed-in library owner is unavailable.", code = "LIBRARY_ACCOUNT_UNAVAILABLE") {
    return Object.assign(new Error(message), { tidyCode: code });
  }

  function publishIdentity() {
    if (!pageSession.check()) return;
    for (const listener of identityListeners) {
      if (!pageSession.check()) return;
      try { listener({ ...libraryIdentity }); } catch { /* One view cannot interrupt the identity boundary. */ }
    }
  }

  function invalidateIdentity(error, { initialize = false, force = false, transition = "session-revoked" } = {}) {
    const changed = force || libraryIdentity.phase === "ready";
    const hard = ["context-changed", "session-revoked", "document-hidden"].includes(transition);
    const escalated = hard && ["workspace-unconfirmed", "workspace-restored"].includes(libraryIdentity.transition);
    if (hard) { workspaceUnconfirmed = false; hardBoundarySinceReady = true; }
    if (changed) identityBoundary++;
    libraryIdentity = { accountKey: null, epoch: libraryIdentity.epoch + Number(changed), phase: "unavailable", transition };
    libraryAttempted = !initialize;
    libraryPending = null;
    libraryFailure = error;
    cachedSession = null;
    cachedAccessToken = "";
    sessionRequest = null;
    pendingRenames.clear();
    // A soft-to-hard cause upgrade is observable even if the lease is already
    // invalid. Keep its original epoch/ticket rules and publish that escalation
    // once; repeated hard failures remain silent, as before.
    if (changed || escalated) publishIdentity();
  }

  function checkLibraryIdentity() {
    if (!pageSession.check()) return { ...libraryIdentity };
    if (!documentActive) return { ...libraryIdentity };
    let selection;
    try { selection = workspaceSelection(); }
    catch (error) {
      if (libraryWorkspace !== null) {
        libraryWorkspace = null;
        invalidateIdentity(error, { force: true, transition: "context-changed" });
      }
      return { ...libraryIdentity };
    }
    const workspace = selection.workspace;
    if (libraryWorkspace === undefined) libraryWorkspace = workspace;
    else if (libraryWorkspace !== workspace) {
      let transition = "context-changed";
      if (!hardBoundarySinceReady && !selection.explicit && lastReadyWorkspace !== undefined
        && lastReadyWorkspace !== "personal" && libraryWorkspace === lastReadyWorkspace) {
        transition = "workspace-unconfirmed";
        workspaceUnconfirmed = true;
      } else if (!hardBoundarySinceReady && workspaceUnconfirmed && selection.explicit && workspace === lastReadyWorkspace) {
        transition = "workspace-restored";
        workspaceUnconfirmed = false;
      }
      libraryWorkspace = workspace;
      invalidateIdentity(identityError("The selected workspace changed.", "CONTEXT_MISMATCH"), {
        initialize: true, force: true, transition,
      });
    }
    return { ...libraryIdentity };
  }

  function onLibraryIdentityChanged(listener) {
    if (!pageSession.check() || typeof listener !== "function") return () => {};
    identityListeners.add(listener);
    return () => identityListeners.delete(listener);
  }

  function sessionOwner(session, workspace) {
    const userId = session?.user?.id;
    return typeof userId === "string" && userId.trim() && userId === userId.trim()
      ? JSON.stringify([userId, workspace]) : null;
  }

  function sessionTicket() {
    checkLibraryIdentity();
    return { sequence: ++sessionSequence, boundary: identityBoundary, workspace: libraryWorkspace };
  }

  function currentSessionTicket(ticket) {
    if (!pageSession.check()) return false;
    checkLibraryIdentity();
    return documentActive && ticket && typeof ticket.workspace === "string"
      && ticket.workspace === libraryWorkspace && ticket.boundary === identityBoundary
      && ticket.sequence >= acceptedSessionSequence;
  }

  function acceptSession(session, ticket) {
    if (!currentSessionTicket(ticket)) return false;
    acceptedSessionSequence = ticket.sequence;
    const accountKey = sessionOwner(session, libraryWorkspace);
    if (!accountKey) {
      // A successful session response without a usable owner revokes authority;
      // do not label malformed data as a specific user's logout.
      invalidateIdentity(identityError());
      return false;
    }
    // This independently accepted proof becomes the comparison point for later
    // cause labels only. A prior explicit B boundary stays hard until such a
    // proof; returning its cookie to A alone never softens that boundary.
    lastReadyWorkspace = libraryWorkspace;
    workspaceUnconfirmed = false;
    hardBoundarySinceReady = false;
    if (libraryIdentity.accountKey !== accountKey || libraryIdentity.phase !== "ready") {
      // Identity and credential caches must move together. A valid new user
      // projection without a token must never inherit the old user's token or
      // join the old user's still-pending authenticated session request.
      cachedSession = null;
      cachedAccessToken = "";
      sessionRequest = null;
      libraryIdentity = { accountKey, epoch: libraryIdentity.epoch + 1, phase: "ready" };
      publishIdentity();
    }
    // A subscriber may synchronously retire the page while the ready identity
    // is published. Never restore credentials after the disposal callback ran.
    if (!pageSession.check()) return false;
    libraryAttempted = true;
    libraryFailure = null;
    const token = session?.accessToken || session?.access_token;
    if (typeof token === "string" && token.trim()) {
      cachedSession = session;
      cachedAccessToken = token;
    }
    return true;
  }

  function sessionEndpoint(input) {
    const url = typeof input === "string" ? input : input?.url
      || (typeof global.URL === "function" && input instanceof global.URL ? input.href : null);
    if (typeof url !== "string") return false;
    if (url === SESSION_ENDPOINT) return true;
    try {
      const parsed = new global.URL(url, global.location?.href);
      return parsed.origin === global.location?.origin && parsed.pathname === SESSION_ENDPOINT
        && !parsed.search && !parsed.hash;
    } catch { return false; }
  }

  function renameTicket(input, init) {
    try {
      const url = new global.URL(typeof input === "string" ? input : input?.url || input?.href, global.location.href);
      const match = /^\/backend-api\/conversation\/id\/([A-Za-z0-9_-]+)\/rename$/.exec(url.pathname);
      if (url.origin !== "https://chatgpt.com" || url.origin !== global.location.origin || url.search || url.hash
        || !match || String(init?.method || input?.method || "GET").toUpperCase() !== "POST") return null;
      const identity = checkLibraryIdentity();
      const catalogAccountKey = catalogIdentity(cachedSession).accountKey;
      if (identity.phase !== "ready" || !catalogAccountKey) return null;
      const ticket = { ...identity, catalogAccountKey, conversationId: match[1],
        startedAt: global.performance?.timeOrigin + global.performance?.now() || Date.now(),
        own: Boolean(init && ownTitleRequests.has(init)) };
      const readTitle = (body) => {
        if (typeof body !== "string" || body.length > 16_384) return null;
        const value = JSON.parse(body)?.title;
        return typeof value === "string" && value.trim() && value.length <= 4096 ? value : null;
      };
      // 只读取精确改名接口的请求体；不读取认证头、聊天正文或响应正文。
      ticket.title = Promise.resolve(init?.body !== undefined ? init.body
        : typeof input?.clone === "function" ? input.clone().text() : null).then(readTitle).catch(() => null);
      pendingRenames.set(ticket.conversationId, ticket);
      return ticket;
    } catch { return null; }
  }

  async function observeRename(ticket, response) {
    if (!ticket || !pageSession.check()) return;
    try {
      const title = await ticket.title;
      if (!pageSession.check()) return;
      const identity = checkLibraryIdentity();
      if (!response?.ok || response.redirected || !title || ticket.own
        || pendingRenames.get(ticket.conversationId) !== ticket || !documentActive
        || identity.phase !== "ready" || identity.epoch !== ticket.epoch || identity.accountKey !== ticket.accountKey
        || catalogIdentity(cachedSession).accountKey !== ticket.catalogAccountKey) return;
      const change = { ownerAccountKey: ticket.accountKey, epoch: ticket.epoch,
        catalogAccountKey: ticket.catalogAccountKey, conversationId: ticket.conversationId, title, startedAt: ticket.startedAt };
      for (const listener of titleListeners) {
        if (!pageSession.check()) return;
        try { listener(change); } catch { /* 一个订阅者不能影响官方改名。 */ }
      }
    } finally {
      if (pendingRenames.get(ticket.conversationId) === ticket) pendingRenames.delete(ticket.conversationId);
    }
  }

  function onTitleChanged(listener) {
    if (!pageSession.check() || typeof listener !== "function") return () => {};
    titleListeners.add(listener);
    return () => titleListeners.delete(listener);
  }

  // TIDY 写入走原有回执链路，不把自己的请求再当成“外部改名”。标记只在内存中。
  function fetchTitleRequest(input, init) {
    pageSession.assertActive();
    const requestInit = tidyRequestInit(init);
    ownTitleRequests.add(requestInit);
    return global.fetch(input, requestInit);
  }

  // Only requests explicitly initiated by TIDY receive this signal. Combining
  // signals preserves caller deadlines and keeps response-body reads abortable.
  // The global fetch observer never adds a signal to the website's own requests.
  function tidyRequestInit(init = {}) {
    pageSession.assertActive();
    return { ...init, signal: init.signal
      ? global.AbortSignal.any([init.signal, pageSession.signal]) : pageSession.signal };
  }

  // Observe the site's existing session reads (including title freshAuth)
  // without changing their arguments, Response, errors, or request count.
  // Never clone conversation bodies or publish credentials over the bridge.
  const originalFetch = global.fetch;
  let tidyIdentityFetch = null;
  if (typeof originalFetch === "function") {
    tidyIdentityFetch = function tidyIdentityFetch(...args) {
      // A later third-party wrapper may retain us in its chain. Stay a pure
      // passthrough after disposal without changing Promise or error identity.
      if (!pageSession.check()) return originalFetch.apply(this, args);
      if (!sessionEndpoint(args[0])) {
        const ticket = renameTicket(args[0], args[1]);
        let request;
        try { request = originalFetch.apply(this, args); }
        catch (error) { void observeRename(ticket, null).catch(() => {}); throw error; }
        if (ticket) void Promise.resolve(request).then(response => observeRename(ticket, response),
          () => observeRename(ticket, null)).catch(() => {});
        return request;
      }
      const ticket = sessionTicket();
      const request = originalFetch.apply(this, args);
      const observed = Promise.resolve(request).then(async response => {
        if (!pageSession.check()) return;
        if (response && typeof response === "object") responseTickets.set(response, ticket);
        if (!response?.ok) {
          if ([401, 403].includes(response?.status) && currentSessionTicket(ticket)) {
            acceptedSessionSequence = ticket.sequence;
            invalidateIdentity(identityError());
          }
          return;
        }
        // Real Fetch Responses are cloneable. Lightweight adapter mocks can
        // still feed the same acceptance path through loadSession below.
        if (typeof response.clone === "function") {
          const session = await response.clone().json();
          if (pageSession.check()) acceptSession(session, ticket);
        }
      }).catch(() => {
        // A network/JSON failure is not evidence that the owner changed.
      }).finally(() => {
        if (observedSessionPending?.promise === observed) observedSessionPending = null;
      });
      if (pageSession.check()) observedSessionPending = { promise: observed, ticket };
      return request;
    };
    global.fetch = tidyIdentityFetch;
  }

  async function readLibraryAccount({ retry = false } = {}) {
    pageSession.assertActive();
    checkLibraryIdentity();
    if (libraryIdentity.phase === "ready") return { accountKey: libraryIdentity.accountKey, epoch: libraryIdentity.epoch };
    if (!documentActive || libraryWorkspace === null) throw libraryFailure || identityError();
    if (libraryPending) return libraryPending;
    // Only an explicit user retry may re-arm a failed initialization. Ordinary
    // route/focus/library requests remain network-free after that one failure.
    if (retry === true) { libraryAttempted = false; libraryFailure = null; }
    if (libraryAttempted) throw libraryFailure || identityError();
    libraryAttempted = true;
    const boundary = identityBoundary;
    const workspace = libraryWorkspace;
    const observed = observedSessionPending?.ticket.boundary === boundary ? observedSessionPending.promise : null;
    const pending = (async () => {
      let session;
      try {
        if (observed) await observed;
        else session = await loadSession({ refresh: true });
        pageSession.assertActive();
        checkLibraryIdentity();
        if (!documentActive || libraryWorkspace !== workspace || identityBoundary !== boundary) {
          throw (libraryIdentity.phase === "unavailable" && libraryFailure)
            || identityError("The page identity changed while reading library ownership.", "CONTEXT_MISMATCH");
        }
        if (session && libraryIdentity.phase === "ready" && sessionOwner(session, workspace) !== libraryIdentity.accountKey) {
          throw identityError("A newer library owner replaced this session response.", "CONTEXT_MISMATCH");
        }
        if (libraryIdentity.phase !== "ready") {
          throw libraryFailure || identityError();
        }
        return { accountKey: libraryIdentity.accountKey, epoch: libraryIdentity.epoch };
      } catch (error) {
        pageSession.assertActive();
        if (identityBoundary === boundary && libraryIdentity.phase !== "ready") libraryFailure = error;
        throw error;
      } finally {
        if (libraryPending === pending) libraryPending = null;
      }
    })();
    libraryPending = pending;
    return pending;
  }

  function catalogIdentity(session) {
    // One pure projection for directory/cache identity. It intentionally does
    // not fetch a session or equate the catalog key with a title user ID or
    // workspace cookie. Callers keep their own missing-identity error type.
    const string = (value) => typeof value === "string" ? value.trim() : "";
    const accountId = string(session?.activeAccountId)
      || string(session?.active_account_id) || string(session?.account?.id);
    return { accountKey: accountId || string(session?.user?.id), accountId: accountId || null };
  }

  function requestHeaders(initHeaders, accessToken) {
    const headers = new global.Headers(initHeaders || {});
    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${accessToken}`);
    return headers;
  }

  async function loadSession({ refresh = false } = {}) {
    pageSession.assertActive();
    if (!refresh && cachedSession) return cachedSession;
    if (!refresh && sessionRequest) return sessionRequest;
    const request = (async () => {
      const response = await global.fetch(SESSION_ENDPOINT, tidyRequestInit({
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
      }));
      pageSession.assertActive();
      if (!response.ok) {
        // Preserve the status without copying the session/error body. Consumers
        // must not turn a real 429/5xx into an alleged login/account change.
        throw Object.assign(new Error(`ChatGPT session could not be read (${response.status}).`), {
          status: response.status,
        });
      }
      const session = await response.json();
      pageSession.assertActive();
      if (!session || typeof session !== "object") {
        throw new Error("ChatGPT session response is invalid.");
      }
      const accessToken = session?.accessToken || session?.access_token || "";
      if (typeof accessToken !== "string" || !accessToken.trim()) {
        throw new Error("ChatGPT session did not provide an access token.");
      }
      const ticket = responseTickets.get(response);
      if (ticket) acceptSession(session, ticket);
      // A response begun before an identity boundary must not restore an old
      // token cache after a newer session/workspace has already been observed.
      if (!ticket || currentSessionTicket(ticket)) {
        cachedSession = session;
        cachedAccessToken = accessToken;
      }
      return session;
    })();

    sessionRequest = request;
    try {
      const session = await request;
      pageSession.assertActive();
      return session;
    } finally {
      if (sessionRequest === request) sessionRequest = null;
    }
  }

  async function loadAccessToken({ refresh = false } = {}) {
    pageSession.assertActive();
    if (!refresh && cachedAccessToken) return cachedAccessToken;
    const session = await loadSession({ refresh });
    pageSession.assertActive();
    return session.accessToken || session.access_token;
  }

  async function fetchAuthenticated(input, init = {}) {
    pageSession.assertActive();
    async function send(refresh) {
      pageSession.assertActive();
      const accessToken = await loadAccessToken({ refresh });
      pageSession.assertActive();
      return global.fetch(input, tidyRequestInit({
        ...init,
        credentials: "include",
        headers: requestHeaders(init.headers, accessToken),
      }));
    }

    let response = await send(false);
    pageSession.assertActive();
    if (response.status === 401) {
      cachedSession = null;
      cachedAccessToken = "";
      response = await send(true);
      pageSession.assertActive();
    }
    return response;
  }

  function onPageHide() {
    if (!pageSession.check()) return;
    documentActive = false;
    invalidateIdentity(identityError("The page document is no longer active.", "CONTEXT_MISMATCH"), { force: true, transition: "document-hidden" });
  }
  function onPageShow() {
    if (!pageSession.check()) return;
    if (documentActive) return;
    documentActive = true;
    libraryWorkspace = undefined;
    libraryAttempted = false;
    libraryFailure = null;
    checkLibraryIdentity();
    // The pagehide event may have been dropped after Chrome marked this
    // document cached. Re-announce the revoked lease from the active document;
    // BFCache restoration must not leave the worker holding its old ready epoch.
    publishIdentity();
  }
  function onPrerenderingChange() {
    if (!pageSession.check()) return;
    if (checkLibraryIdentity().phase === "ready") publishIdentity();
    else void readLibraryAccount({ retry: true }).catch(() => {});
  }
  global.addEventListener?.("pagehide", onPageHide);
  global.addEventListener?.("pageshow", onPageShow);
  if (global.document?.prerendering) {
    // Prerender activation is a real document boundary, not ordinary focus.
    // Its earlier events may have been rejected by the active-document worker
    // guard, so republish the ready identity (or initialize it once) on entry.
    global.document.addEventListener("prerenderingchange", onPrerenderingChange, { once: true });
  }

  pageSession.onDispose(() => {
    documentActive = false;
    invalidateIdentity(pageSession.error(), { force: true, transition: "document-hidden" });
    observedSessionPending = null;
    identityListeners.clear();
    titleListeners.clear();
    global.removeEventListener?.("pagehide", onPageHide);
    global.removeEventListener?.("pageshow", onPageShow);
    global.document?.removeEventListener?.("prerenderingchange", onPrerenderingChange);
    // Never overwrite somebody else's wrapper or abort a site-owned request.
    if (global.fetch === tidyIdentityFetch) global.fetch = originalFetch;
  });

  global.TidyChatgptApi = Object.freeze({ activeWorkspace, readLibraryAccount, checkLibraryIdentity,
    onLibraryIdentityChanged, onTitleChanged, fetchTitleRequest, catalogIdentity, loadSession, loadAccessToken, fetchAuthenticated });
})(globalThis);

// Source: src/platform/chatgpt/messages.js
(function initTidyChatgptMessages(global) {
  "use strict";

  if (global.TidyChatgptMessages) return;
  const api = global.TidyChatgptApi;
  const pageSession = global.TidyPageSession;
  if (!api || !pageSession) return;

  // 目录读取的整体期限，包含认证、请求和 JSON 解析；超时后不自动重试。
  const PAGE_TIMEOUT_MS = 20_000;

  class MessageReadError extends Error {
    constructor(code, message, { status = null, retryable = false, serverCode = null } = {}) {
      super(message);
      this.name = "MessageReadError";
      this.code = code;
      this.category = code;
      this.status = status;
      this.retryable = retryable;
      this.serverCode = serverCode;
    }
  }

  function string(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  async function account({ refresh = false } = {}) {
    pageSession.assertActive();
    let session;
    try { session = await api.loadSession({ refresh }); } catch (error) {
      // A retired extension session is terminal, never an auth retry.
      pageSession.assertActive();
      // Keep HTTP evidence from the session reader; never parse error text or
      // convert rate limiting/server failure into an authentication category.
      if (Number.isInteger(error?.status)) {
        const status = error.status, auth = status === 401 || status === 403;
        throw new MessageReadError(auth ? "AUTH" : "HTTP", "ChatGPT authentication session could not be read", {
          status, retryable: auth || [408, 425, 429].includes(status) || status >= 500,
        });
      }
      throw new MessageReadError("AUTH", "ChatGPT authentication session could not be read", { retryable: true });
    }
    pageSession.assertActive();
    const identity = api.catalogIdentity(session);
    if (!identity.accountKey) {
      throw new MessageReadError("SCHEMA", "ChatGPT session has no stable account identity");
    }
    // A user ID can isolate local cache entries, but is NOT an account header.
    return identity;
  }

  function assertAccount(identity, expectedAccountKey) {
    if (expectedAccountKey !== null && identity.accountKey !== expectedAccountKey) {
      throw new MessageReadError("ACCOUNT_MISMATCH", "ChatGPT account changed while reading messages");
    }
  }

  function textValue(value) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    return typeof value.text === "string" ? value.text
      : typeof value.content === "string" ? value.content : "";
  }

  // 已挂载原生消息的只读投影，供 MAIN 提取定位文字；不请求历史消息分页。
  function visibleMessage(message) {
    const content = message?.content || {};
    const type = String(content.content_type || "");
    const role = message?.author?.role;
    if (!message || message.metadata?.is_visually_hidden_from_conversation === true
      || ["model_editable_context", "user_editable_context"].includes(type)
      || !["user", "assistant"].includes(role)) return null;
    if (role === "assistant" && (["thoughts", "reasoning_recap"].includes(type)
      || message.metadata?.reasoning_status === "is_reasoning"
      || message.metadata?.is_thinking_preamble_message === true
      || (message.recipient != null && message.recipient !== "all")
      || (message.channel != null && message.channel !== "final"))) return null;
    const messageId = string(message.id);
    const time = typeof message.create_time === "number" ? message.create_time * 1000 : null;
    const parts = Array.isArray(content.parts) ? content.parts : [];
    return messageId ? { messageId,
      timestampMs: Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? time : null,
      text: parts.map(textValue).filter(Boolean).join("\n")
        || textValue(content.text) || textValue(content.result) || textValue(message.text),
    } : null;
  }

  async function responseError(response) {
    pageSession.assertActive();
    let detail = null;
    try {
      const body = await response.json();
      pageSession.assertActive();
      detail = body?.detail && typeof body.detail === "object" ? body.detail : body;
    } catch (_) {
      pageSession.assertActive();
      // HTTP status remains meaningful even for an HTML or empty error body.
    }
    const status = response.status;
    const serverCode = string(detail?.code) || null;
    const inaccessible = [401, 403, 404].includes(status) || serverCode === "conversation_inaccessible";
    const retryable = typeof detail?.can_retry === "boolean" ? detail.can_retry
      : status === 408 || status === 425 || status === 429 || status >= 500;
    return new MessageReadError(inaccessible ? "INACCESSIBLE" : "HTTP",
      inaccessible ? `ChatGPT conversation is inaccessible (${status})` : `ChatGPT message page failed (${status})`,
      { status, serverCode, retryable });
  }

  // 只承担目录适配器的受认证 GET；响应结构由调用方校验，不再保留历史消息分页入口。
  async function readJson(input, query = {}) {
    pageSession.assertActive();
    if (typeof input !== "string" || !input.startsWith("/backend-api/")) {
      throw new MessageReadError("SCHEMA", "Invalid ChatGPT backend path");
    }
    query = { accountKey: null, projectId: null, ...query };
    const controller = typeof global.AbortController === "function" ? new global.AbortController() : null;
    let expired = false;
    let timer = null;
    const checkpoint = () => {
      pageSession.assertActive();
      if (expired) throw new MessageReadError("TIMEOUT", "ChatGPT message page timed out", { retryable: true });
    };
    const operation = async () => {
      const identity = await account();
      checkpoint();
      assertAccount(identity, query.accountKey);
      const headers = { Accept: "application/json" };
      if (identity.accountId) headers["chatgpt-account-id"] = identity.accountId;
      if (query.projectId) headers["chatgpt-project-id"] = query.projectId;
      const response = await api.fetchAuthenticated(input, {
        method: "GET", headers, ...(controller ? { signal: controller.signal } : {}),
      });
      checkpoint();
      // The auth helper may refresh a 401 session. Reject cross-account results
      // rather than writing them into the previous account's local index.
      const responseIdentity = await account();
      checkpoint();
      assertAccount(responseIdentity, query.accountKey || identity.accountKey);
      if (!response.ok) {
        const error = await responseError(response);
        checkpoint();
        throw error;
      }
      let raw;
      try { raw = await response.json(); } catch (_) {
        checkpoint();
        throw new MessageReadError("SCHEMA", "ChatGPT message page is not valid JSON");
      }
      checkpoint();
      const finalIdentity = await account();
      checkpoint();
      assertAccount(finalIdentity, query.accountKey || identity.accountKey);
      return raw;
    };
    // Abort fetch and reject the whole read, including a body/session promise
    // which ignores AbortSignal. Late continuations still hit checkpoints.
    let unsubscribe = () => {};
    const stopped = new Promise((_, reject) => {
      unsubscribe = pageSession.onDispose(() => {
        controller?.abort();
        reject(pageSession.error());
      });
    });
    // A fetch abort alone does not bound loadSession() or a stalled JSON body.
    // Race the entire authenticated read and abort any in-flight fetch as well.
    const timeout = new Promise((_, reject) => {
      timer = global.setTimeout(() => {
        expired = true;
        controller?.abort();
        reject(new MessageReadError("TIMEOUT", "ChatGPT message page timed out", { retryable: true }));
      }, PAGE_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([operation(), timeout, stopped]);
      checkpoint();
      return result;
    } catch (error) {
      pageSession.assertActive();
      if (expired) throw new MessageReadError("TIMEOUT", "ChatGPT message page timed out", { retryable: true });
      if (error instanceof MessageReadError) throw error;
      const category = ["TypeError", "AbortError"].includes(error?.name) ? "NETWORK" : "UNKNOWN";
      throw new MessageReadError(category, "ChatGPT message page could not be read", { retryable: true });
    } finally {
      unsubscribe();
      if (timer !== null) global.clearTimeout(timer);
    }
  }

  global.TidyChatgptMessages = Object.freeze({
    PAGE_TIMEOUT_MS, MessageReadError, account, readJson, visibleMessage,
  });
})(globalThis);

// Source: src/features/search/chatgpt/search.js
(function initTidyChatgptSearch(global) {
  "use strict";

  if (global.TidyChatgptSearch) return;

  const searchContract = global.TidySearch;
  const chatgptApi = global.TidyChatgptApi;
  const pageSession = global.TidyPageSession;
  if (!searchContract || !chatgptApi || !pageSession) return;

  const ENDPOINT = "/backend-api/global/search";
  const ENTRYPOINT = "global_search";
  // Search stays conversation-only. Project, file and connector results have
  // different identity semantics and must never leak into the message DTO.
  const CONVERSATION_SOURCE_REQUEST = Object.freeze({
    type: "conversation",
  });

  let activeFirstPage = null;

  function toIso(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return null;
    const date = new Date(seconds * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function buildRequestBody(value) {
    const request = searchContract.normalizeRequest(value);
    const body = {
      query: request.query,
      limit: request.limit,
      query_id: request.sessionId,
      entrypoint: ENTRYPOINT,
      source_requests: [{ ...CONVERSATION_SOURCE_REQUEST }],
    };
    // The service treats this token as opaque. Never decode or derive an
    // offset from it: the official backend owns every per-source cursor.
    if (request.cursor) body.cursor = request.cursor;
    return body;
  }

  function normalizeConversationItem(item) {
    if (item?.source_type !== "conversation" || item?.source_key !== "conversation") return null;
    const payload = item.payload;
    if (
      payload?.kind !== "conversation" ||
      typeof item.id !== "string" || !item.id ||
      typeof payload.conversation_id !== "string" || !payload.conversation_id ||
      typeof item.title !== "string" ||
      typeof item.snippet !== "string"
    ) {
      throw new TypeError("Official conversation search result schema changed");
    }
    return {
      resultId: item.id,
      source: "conversation",
      conversationId: payload.conversation_id,
      // Title-level matches legitimately omit message_id. Preserve that fact
      // so navigation can fall back to the conversation without inventing an
      // exact message target.
      messageId: typeof payload.message_id === "string" && payload.message_id
        ? payload.message_id
        : null,
      title: item.title,
      snippet: item.snippet,
      // update_time is the conversation result's update time, not the matched
      // message timestamp. The DTO name keeps that distinction explicit.
      conversationUpdatedAt: toIso(item.update_time),
      matchKind: typeof item.match_kind === "string" ? item.match_kind : null,
    };
  }

  function conversationSourceStatus(statuses) {
    if (!Array.isArray(statuses)) return null;
    return statuses.find((status) =>
      status?.source === "conversation" ||
      status?.source_type === "conversation" ||
      status?.source_key === "conversation"
    ) || (statuses.length === 1 ? statuses[0] : null);
  }

  function normalizeResponse(raw, query) {
    if (!raw || !Array.isArray(raw.items)) {
      throw new TypeError("Official global search response schema changed");
    }
    if (raw.cursor != null && (typeof raw.cursor !== "string" || !raw.cursor)) {
      throw new TypeError("Official global search cursor schema changed");
    }
    if (typeof raw.partial_results !== "boolean") {
      throw new TypeError("Official global search partial_results schema changed");
    }

    const items = raw.items
      .map(normalizeConversationItem)
      // The server owns match qualification. Re-filtering a truncated snippet
      // can incorrectly discard a valid result whose match is outside the
      // returned preview text.
      .filter(Boolean);
    const status = conversationSourceStatus(raw.source_statuses);
    if (status && status.status !== "ok") {
      throw new TypeError("Official conversation search source is unavailable");
    }
    const cursor = raw.cursor || null;
    const page = {
      schemaVersion: searchContract.VERSION,
      query,
      items,
      cursor,
      hasMore: typeof status?.has_more === "boolean" ? status.has_more : Boolean(cursor),
      partialResults: raw.partial_results,
      sourceStatus: status ? {
        status: status.status,
        hasMore: typeof status.has_more === "boolean" ? status.has_more : Boolean(cursor),
        durationMs: Number.isFinite(Number(status.duration_ms)) ? Number(status.duration_ms) : null,
      } : null,
    };
    const validation = searchContract.validatePage(page);
    if (!validation.valid) {
      throw new TypeError(`Invalid standardized search page: ${validation.errors.join(", ")}`);
    }
    return page;
  }

  async function search(value) {
    pageSession.assertActive();
    const request = searchContract.normalizeRequest(value);
    if (typeof chatgptApi.fetchAuthenticated !== "function") {
      throw new TypeError("Authenticated search fetch is unavailable");
    }

    // A new first page supersedes the prior query. Page requests are already
    // serialized by the Side Panel and therefore do not cancel each other.
    if (!request.cursor) {
      activeFirstPage?.abort();
      activeFirstPage = new AbortController();
    }
    const controller = request.cursor ? new AbortController() : activeFirstPage;
    // Every page owns disposal, not only the first-page supersession slot.
    // The race also releases callers when a stalled JSON body ignores abort.
    let unsubscribe = () => {};
    const stopped = new Promise((_, reject) => {
      unsubscribe = pageSession.onDispose(() => {
        controller.abort();
        reject(pageSession.error());
      });
    });
    try {
      const response = await Promise.race([chatgptApi.fetchAuthenticated(ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(buildRequestBody(request)),
        signal: controller.signal,
      }), stopped]);
      pageSession.assertActive();
      if (!response.ok) throw new TypeError(`Official global search failed (${response.status})`);
      const raw = await Promise.race([response.json(), stopped]);
      pageSession.assertActive();
      return normalizeResponse(raw, request.query);
    } catch (error) {
      pageSession.assertActive();
      throw error;
    } finally {
      unsubscribe();
      if (!request.cursor && activeFirstPage === controller) activeFirstPage = null;
    }
  }

  global.TidyChatgptSearch = Object.freeze({
    ENDPOINT,
    buildRequestBody,
    normalizeResponse,
    search,
  });
})(globalThis);

// Source: src/platform/navigation/chatgpt/navigation-intent.js
(function initTidyChatgptNavigationIntent(global) {
  "use strict";
  if (global.TidyChatgptNavigationIntent) return;

  /**
   * The worker owns the one latest navigation per tab. This is only its page
   * execution fence, shared by search, saved-conversation opens and bookmarks.
   * A worker-lifetime epoch + ingress sequence also rejects delayed IPC from a
   * retired worker. Cancellation keeps a tombstone; the same intent cannot be
   * reinstalled by a late active packet.
   */
  function create({ parseRoute, readIdentity = null, onRevoked = () => {} }) {
    let current = null;
    function revoke(reason, notify) {
      if (!current || current.phase !== "active") return false;
      current.phase = "cancelled";
      onRevoked({ navigationIntentId: current.navigationIntentId, reason, notify });
      return true;
    }
    function observe(value) {
      if (typeof value?.navigationIntentId !== "string" || !value.navigationIntentId || value.navigationIntentId.length > 200
        || !Number.isSafeInteger(value.workerEpoch) || value.workerEpoch < 1
        || !Number.isSafeInteger(value.sequence) || value.sequence < 1
        || !["active", "cancelled"].includes(value.phase)
        || (value.ownerAccountKey != null && (typeof value.ownerAccountKey !== "string" || !value.ownerAccountKey))
        || (value.conversationId != null && (typeof value.conversationId !== "string" || !value.conversationId))) return { accepted: false };
      const comparison = !current ? 1 : value.workerEpoch !== current.workerEpoch
        ? Math.sign(value.workerEpoch - current.workerEpoch) : Math.sign(value.sequence - current.sequence);
      if (comparison < 0) return { accepted: false };
      if (comparison === 0) {
        const observed = current;
        if (value.navigationIntentId !== current.navigationIntentId) return { accepted: false };
        if (value.phase === "cancelled") revoke("cancelled", false);
        else if (current.phase === "active" && value.conversationId !== current.conversationId) {
          // The ingress packet can arrive before the saved item is read. Only
          // its first verified destination may fill that blank; no target swap.
          if (current.conversationId != null || !value.conversationId) return { accepted: false };
          current.conversationId = value.conversationId;
          current.sawDestination = parseRoute()?.conversationId === value.conversationId;
        }
        // OPEN's source gate can later become the exact same command's LOCATE
        // gate in a same-document jump. This only attaches its admitted owner.
        if (value.ownerAccountKey && current.phase === "active") {
          if (current.ownerAccountKey && current.ownerAccountKey !== value.ownerAccountKey) return { accepted: false };
          current.ownerAccountKey = value.ownerAccountKey;
        }
        if (readIdentity && current.phase === "active") refreshIdentity();
        return { accepted: current === observed && value.phase === current.phase };
      }
      const previous = current;
      const originConversationId = parseRoute()?.conversationId || null;
      const installed = { ...value, originConversationId, sawDestination: value.conversationId === originConversationId };
      current = installed;
      // Install before notifying cancellation: a synchronous callback may
      // deliver an even newer control packet. Never overwrite that newer one.
      if (previous?.phase === "active") onRevoked({ navigationIntentId: previous.navigationIntentId, reason: "superseded", notify: false });
      if (current === installed && readIdentity && current.phase === "active") refreshIdentity();
      return { accepted: current === installed && current.phase === value.phase };
    }
    function isCurrent(navigationIntentId) {
      return Boolean(current?.phase === "active" && navigationIntentId === current.navigationIntentId);
    }
    // Sole page-side identity lifetime for ALL navigation effects. Search and
    // bookmark renderers may ask whether presentation is ready; they cannot
    // create their own identity subscriptions or revive a cancelled command.
    function observeIdentity(identity) {
      if (current?.phase !== "active") return;
      const owned = Object.hasOwn(current, "ownerAccountKey");
      const state = global.TidyNavigationIdentity.state(identity, current.ownerAccountKey);
      if (state === "revoked" || (!owned && identity.phase !== "ready")) {
        revoke(identity.transition === "document-hidden" ? "page-hidden" : "identity-changed", true);
        return;
      }
      if (owned && state === "ready") current.ownerAccountKey ??= identity.accountKey;
      current.identityReady = state === "ready";
    }
    function refreshIdentity() {
      const before = current;
      const identity = readIdentity(); // may synchronously revoke/replace current
      if (current === before) observeIdentity(identity);
    }
    function canPresent(id) {
      const before = current;
      if (!isCurrent(id)) return false;
      if (readIdentity) refreshIdentity();
      return current === before && isCurrent(id) && current.identityReady === true;
    }
    function routeChanged() {
      if (current?.phase !== "active") return;
      const conversationId = parseRoute()?.conversationId || null;
      if (conversationId === current.conversationId) { current.sawDestination = true; return; }
      if (!current.sawDestination && conversationId === current.originConversationId) return;
      revoke("route-changed", true);
    }
    return Object.freeze({ observe, isCurrent, canPresent, observeIdentity, routeChanged,
      cancel: (reason = "cancelled") => revoke(reason, true),
      getCurrent: () => current ? { ...current } : null });
  }
  global.TidyChatgptNavigationIntent = Object.freeze({ create });
})(globalThis);

// Source: src/platform/navigation/chatgpt/virtual-message-target.js
(function initTidyChatgptVirtualMessageTarget(global) {
  "use strict";
  if (global.TidyChatgptVirtualMessageTarget) return;

  /**
   * ChatGPT keeps a native turn container while its message DOM is virtualized.
   * Its current Fiber owns the conversation/turn ID and a read-only turn snapshot.
   * Prove the exact message there before revealing that container. A turn ID is
   * NOT necessarily a message ID (one assistant turn can contain several).
   *
   * No hook index, minified function name, alternate tree, native setter or
   * module import is a contract. Unknown native shapes simply supply no target.
   * This proof permits loading only; the mounted DOM resolver still owns success.
   */
  function read(element, turnId, conversationId, messageId) {
    if (!element || !turnId || !conversationId || !messageId) return null;
    const key = Object.keys(element).find(name => name.startsWith("__reactFiber$"));
    let fiber = key ? element[key] : null;
    const seen = new Set();
    for (let depth = 0; fiber && depth < 40 && !seen.has(fiber); depth++, fiber = fiber.return) {
      seen.add(fiber);
      const props = fiber.memoizedProps;
      if (!props?.turnId) continue;
      if (props.turnId !== turnId || props.conversation?.id !== conversationId) return null;
      const hooks = new Set(), records = new Set();
      for (let hook = fiber.memoizedState, count = 0; hook && count < 60 && !hooks.has(hook); hook = hook.next, count++) {
        hooks.add(hook);
        // Native useSyncExternalStore caches [currentTurn, previousTurn]. Read
        // only that shallow value, not arbitrary children or a getter callback.
        if (!Array.isArray(hook.memoizedState) || hook.memoizedState.length > 4) continue;
        for (const turn of hook.memoizedState) {
          if (turn?.id !== turnId || !Array.isArray(turn.messages)) continue;
          const matches = turn.messages.filter(message => message?.id === messageId);
          if (matches.length > 1) return null;
          for (const message of matches) {
            const owner = message.conversation_id ?? message.conversationId;
            if ((owner != null && owner !== conversationId) || !["user", "assistant"].includes(message.author?.role)) return null;
            records.add(message);
          }
        }
      }
      return records.size === 1 ? [...records][0] : null;
    }
    return null;
  }
  global.TidyChatgptVirtualMessageTarget = Object.freeze({ read });
})(globalThis);

// Source: src/platform/navigation/chatgpt/message-location.js
(function initTidyChatgptMessageLocation(global) {
  "use strict";
  if (global.TidyChatgptMessageLocation) return;

  // Product tuning: scroll immediately, but acknowledge only a stable landing.
  // One executor for explicit search/bookmark commands. Waiting for a target
  // consumes the worker's original deadline; landing has its own smaller cap.
  // Neither phase starts from a snapshot, focus or background heartbeat.
  const SAMPLE_MS = 60;
  const QUIET_MS = 180;
  const SMOOTH_GRACE_MS = 600;
  const STABLE_MS = 360;
  const OBSERVE_MS = 1_200;
  const WINDOW_MS = 2_400;
  const MAX_SCROLLS = 3; // exact-message initial move + at most two corrections
  const MAX_LOAD_SCROLLS = 2; // reveal + one measured native anchor-restoration correction
  const TOLERANCE_PX = 6;
  const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
  // Passive, bounded local evidence for the last click. No account, message
  // ID/text, network, storage or background sampler is involved. A live recheck
  // can distinguish an unstarted/cancelled verifier from a false landing.
  let lastDiagnostic = null;

  function create({ resolveTarget, assertCurrent, resolveLoadTarget = () => null, prepareAnchor = () => null, onCancelled = () => {}, document = global.document,
    now = () => Date.now(), setTimer = (fn, ms) => global.setTimeout(fn, ms), clearTimer = id => global.clearTimeout(id) }) {
    let active = null;
    function record(intent, phase, found = null, movement = null) {
      const diagnostic = intent.diagnostic;
      diagnostic.phase = phase;
      diagnostic.elapsedMs = now() - intent.startedAt;
      diagnostic.scrolls = intent.scrolls;
      diagnostic.loads = intent.loads;
      if (found) diagnostic.geometry = { targetTop: found.targetTop, visibleTop: found.visibleTop,
        visibleBottom: found.visibleBottom, visible: found.visible, aligned: found.aligned,
        documentReady: found.ready, ports: found.portMetrics };
      if (phase !== "sample") {
        diagnostic.events.push({ phase, elapsedMs: diagnostic.elapsedMs, scrolls: diagnostic.scrolls,
          geometry: diagnostic.geometry || null, ...(movement ? { movement } : {}) });
        if (diagnostic.events.length > 32) diagnostic.events.shift();
      }
    }
    function stopMotion(intent) {
      // Stop an in-progress native smooth animation at its CURRENT position;
      // this is not another attempt to pull the user back to the bookmark.
      for (const viewport of intent.touched) {
        // A native-wrapper callback can synchronously start a new intent.
        // Never let the old multi-port cleanup stop that newer animation.
        if (active) break;
        try { viewport.scrollTo({ top: viewport.scrollTop, left: viewport.scrollLeft || 0, behavior: "instant" }); }
        catch { /* A retired scrollport must not prevent stopping the others. */ }
      }
    }
    function finish(intent, result, stop = false) {
      if (active !== intent) return;
      active = null;
      if (intent.timer !== null) clearTimer(intent.timer);
      if (stop) stopMotion(intent);
      record(intent, "finished");
      Object.assign(intent.diagnostic, { pending: false, located: result.located, reason: result.reason });
      intent.resolve({ ...result, scrolls: intent.scrolls, loads: intent.loads });
    }
    function cancel(reason = "cancelled", notify = false) {
      const intent = active;
      if (!intent) return;
      finish(intent, { located: false, reason }, true);
      if (notify) onCancelled(intent.payload, reason);
    }
    const clipsAxis = value => /^(auto|scroll|overlay|hidden|clip)$/.test(value);
    const scrollsAxis = value => /^(auto|scroll|overlay|hidden)$/.test(value);
    function intersect(box, clip, x = true, y = true) {
      return { left: x ? Math.max(box.left, clip.left) : box.left, right: x ? Math.min(box.right, clip.right) : box.right,
        top: y ? Math.max(box.top, clip.top) : box.top, bottom: y ? Math.min(box.bottom, clip.bottom) : box.bottom };
    }
    const hasArea = box => box.right > box.left && box.bottom > box.top;
    function containsAnchor(rect, box) {
      // Short messages must be fully visible, not merely intersect by one
      // pixel. For long messages the beginning must remain in the real view.
      return hasArea(box) && rect.left < box.right && rect.right > box.left
        && rect.top >= box.top - TOLERANCE_PX
        && rect.top + Math.min(rect.height, box.bottom - box.top) <= box.bottom + TOLERANCE_PX;
    }
    function geometry(element, anchor = null, placement = null) {
      if (element.isConnected !== true) return null;
      // Search may anchor a range INSIDE the exact message, never another node.
      if (anchor && (!element.contains?.(anchor.startContainer) || !element.contains?.(anchor.endContainer))) return null;
      const rect = anchor?.getBoundingClientRect() || element.getBoundingClientRect();
      const visual = global.visualViewport;
      const width = visual?.width || global.innerWidth || document.documentElement.clientWidth;
      const height = visual?.height || global.innerHeight || document.documentElement.clientHeight;
      const screen = { left: visual?.offsetLeft || 0, top: visual?.offsetTop || 0,
        right: (visual?.offsetLeft || 0) + width, bottom: (visual?.offsetTop || 0) + height };
      if (!hasArea(screen) || !(rect.width > 0) || !(rect.height > 0)) return null;
      const clips = [], ports = [], nodes = [element], seen = new Set();
      let viewportFixed = false;
      // A local scrollport can itself sit outside another clipping ancestor.
      // Read the entire bounded ancestor chain and the browser visual viewport;
      // being centered inside the nearest overflow:auto is NOT a landing.
      for (let node = element, depth = 0; node; node = node.parentElement, depth++) {
        if (depth >= 100 || seen.has(node)) return null;
        seen.add(node);
        const style = global.getComputedStyle(node);
        if (style.display === "none" || /^(hidden|collapse)$/.test(style.visibility)
          || node.hidden || node.getAttribute?.("aria-hidden") === "true" || node.hasAttribute?.("inert")) return null;
        // A viewport-fixed subtree is not moved or clipped by DOM ancestors
        // above its fixed boundary. offsetParent supplies the browser's actual
        // containing-block proof: transformed fixed descendants have a non-null
        // containing block, so we must NOT stop at those. Still check hidden
        // DOM ancestors even after the geometric chain has ended.
        if (viewportFixed) continue;
        if (style.position === "fixed" && node.offsetParent === null) {
          viewportFixed = true;
          if (!nodes.includes(node)) nodes.push(node);
        }
        if (!depth) continue;
        const root = node === document.scrollingElement;
        const border = root ? null : node.getBoundingClientRect();
        const box = root ? { ...screen } : { top: border.top + node.clientTop, left: border.left + node.clientLeft,
          bottom: border.top + node.clientTop + node.clientHeight, right: border.left + node.clientLeft + node.clientWidth };
        const x = root || clipsAxis(style.overflowX), y = root || clipsAxis(style.overflowY);
        if (x || y) { clips.push({ node, box, x, y, depth }); nodes.push(node); }
        if ((root || scrollsAxis(style.overflowY)) && node.scrollHeight > node.clientHeight + 1) {
          // column-reverse uses a bottom-origin scroll range: latest is 0,
          // and older content has negative scrollTop. Keep real per-port bounds
          // for both latest placement and exact bookmark/placeholder geometry.
          const extent = Math.max(0, node.scrollHeight - node.clientHeight);
          const reversed = /^(inline-)?flex$/.test(style.display) && style.flexDirection === "column-reverse";
          ports.push({ viewport: node, box, depth, minTop: reversed ? -extent : 0, maxTop: reversed ? 0 : extent });
          if (!nodes.includes(node)) nodes.push(node);
        }
      }
      if (!ports.length && placement !== "latest") return null;
      if (placement === "latest") {
        // 收藏会话的目标是正文滚动区域的末尾，不是当前可见/被收藏的某条消息。
        // 复用同一个有截止时间、可被用户打断的落稳器，避免两套滚动逻辑抢位置。
        for (const port of ports) {
          let usable = screen;
          for (const clip of clips) if (clip.depth >= port.depth) usable = intersect(usable, clip.box, clip.x, clip.y);
          port.top = port.maxTop;
          port.canMove = hasArea(usable) && Math.abs(port.viewport.scrollTop - port.top) > TOLERANCE_PX;
        }
        let visibleBox = screen;
        for (const clip of clips) visibleBox = intersect(visibleBox, clip.box, clip.x, clip.y);
        const move = ports.find(port => port.canMove) || null;
        const visible = hasArea(visibleBox), aligned = visible && ports.every(port => Math.abs(port.viewport.scrollTop - port.top) <= TOLERANCE_PX);
        return { element, viewport: ports.at(-1)?.viewport || null, move, visible, aligned,
          ready: document.readyState === "complete", nodes,
          targetTop: visibleBox.bottom, visibleTop: visibleBox.top, visibleBottom: visibleBox.bottom,
          portMetrics: ports.map(port => ({ top: port.box.top, bottom: port.box.bottom, scrollTop: port.viewport.scrollTop,
            root: port.viewport === document.scrollingElement })),
          values: [visibleBox.top, visibleBox.bottom, document.readyState === "complete" ? 1 : 0,
            ...ports.flatMap(port => [port.top - port.viewport.scrollTop, port.viewport.scrollHeight, port.box.top, port.box.bottom])] };
      }
      let visibleBox = screen;
      for (const clip of clips) visibleBox = intersect(visibleBox, clip.box, clip.x, clip.y);
      for (const port of ports) {
        let usable = screen;
        // A scroller cannot move its own box. If that box is off screen, an
        // outer scroller has to move first; never scroll its hidden contents.
        for (const clip of clips) if (clip.depth >= port.depth) usable = intersect(usable, clip.box, clip.x, clip.y);
        port.usable = usable;
        const anchorHeight = Math.min(rect.height, usable.bottom - usable.top);
        const wanted = port.viewport.scrollTop + rect.top - usable.top - (usable.bottom - usable.top - anchorHeight) / 2;
        port.top = Math.max(port.minTop, Math.min(wanted, port.maxTop));
        port.canMove = hasArea(usable) && Math.abs(port.viewport.scrollTop - port.top) > TOLERANCE_PX;
      }
      const primary = ports.at(-1);
      // Unclip the innermost blocker before centering in the outer live view.
      // Each actual command still consumes its loading or placement budget.
      const move = ports.find(port => !containsAnchor(rect, port.box) && port.canMove)
        || (primary.canMove ? primary : null);
      const visible = containsAnchor(rect, visibleBox);
      return { element, viewport: primary.viewport, move, visible,
        aligned: visible && !primary.canMove, ready: document.readyState === "complete", nodes,
        targetTop: rect.top, visibleTop: visibleBox.top, visibleBottom: visibleBox.bottom,
        portMetrics: ports.map(port => ({ top: port.box.top, bottom: port.box.bottom,
          scrollTop: port.viewport.scrollTop, root: port.viewport === document.scrollingElement })),
        values: [rect.top, rect.height, rect.left, rect.width, visibleBox.top, visibleBox.bottom, visibleBox.left, visibleBox.right,
          // Native virtualization can rebase scrollTop and content coordinates
          // together while the visible message stays still. Compare viewport
          // geometry and correction DELTA, not that invisible absolute origin.
          document.readyState === "complete" ? 1 : 0, ...ports.flatMap(port => [port.top - port.viewport.scrollTop,
            port.box.top, port.box.bottom, port.box.left, port.box.right])] };
    }
    function waitForIdentity(intent) {
      if (active !== intent) return;
      // A suspended command retains its original deadline and scroll budget.
      // Geometry observed before suspension cannot count toward a new receipt.
      intent.geometry = null; intent.stableAt = null; intent.changedAt = now();
      if (intent.diagnostic.phase !== "waiting-identity") record(intent, "waiting-identity");
      intent.timer = setTimer(() => sample(intent), Math.min(SAMPLE_MS, Math.max(0, intent.deadline - now())));
    }
    function sample(intent) {
      if (active !== intent) return;
      intent.timer = null;
      let ready;
      try { ready = assertCurrent(intent.payload) !== false; }
      catch { if (active === intent) cancel("context-changed", true); return; }
      if (active !== intent) return; // the local identity check may revoke it
      if (now() >= intent.deadline || (intent.landingAt === null && now() >= intent.loadDeadline)) {
        finish(intent, { located: false, reason: intent.landingAt === null ? "target-timeout" : "landing-timeout" }, true); return;
      }
      if (!ready) {
        waitForIdentity(intent);
        return;
      }
      // 无刷新尝试最多占用 6 秒（由后台传入绝对时间）。无动作、消息缺失、
      // 懒加载未完成都必须退出等待，让后台核对归属后整页补载一次。
      // 用户取消/离开和账号未确认已在上面拦截；补载不延长总预算。
      if (Number.isFinite(intent.payload.nativeFallbackAt) && now() >= intent.payload.nativeFallbackAt) {
        finish(intent, { located: false, reason: "native-target-missing" }, true); return;
      }
      let resolved, found, loading = false;
      try {
        resolved = resolveTarget(intent.payload);
        if (active !== intent) return;
        intent.diagnostic.targetReason = resolved?.reason || null;
        const contentReady = resolved?.contentReady !== false;
        const anchor = resolved?.element && contentReady ? prepareAnchor(resolved.element, intent.payload) : null;
        if (active !== intent) return;
        found = resolved?.element && contentReady ? geometry(resolved.element, anchor, intent.payload.placement) : null;
        // Native data hydration may restore its previous scroll anchor AFTER
        // the first reveal. A virtual target therefore uses the SAME geometry
        // controller and correction budget, not a fire-and-forget scroll or a
        // second loading retry loop. Only exact message geometry can finish.
        if (!found && intent.landingAt === null && resolved?.reason !== "conversation-mismatch") {
          const candidate = resolved?.element && !contentReady ? resolved : resolveLoadTarget(intent.payload);
          if (active !== intent) return;
          const virtual = candidate?.element ? geometry(candidate.element) : null;
          if (virtual?.ready) { found = virtual; loading = true; }
        }
      } catch { if (active === intent) cancel("target-unavailable", true); return; }
      if (active !== intent) return; // geometry may synchronously revoke/replace
      if (found) {
        if (!loading) intent.targetAt ??= now();
        // Loading includes native hydration and physical placement. An issued
        // scroll cannot start a verification window before the first visible,
        // aligned observation (cold native renders can block that next frame).
        // This boundary is crossed once; later drift/identity never renews it.
        if (!loading && found.aligned && found.ready && intent.landingAt === null) {
          intent.landingAt = now();
          intent.deadline = Math.min(intent.deadline, now() + WINDOW_MS);
          intent.observeMs = Math.min(OBSERVE_MS, Math.max(0, intent.deadline - now() - SAMPLE_MS));
        }
        // Evidence only: distinguish DOM replacement from actual numeric
        // motion. Both still invalidate stability; do not change settling
        // semantics until a live failure proves which one prevented landing.
        const initial = !intent.geometry;
        const nodesChanged = !initial && (found.nodes.length !== intent.nodes.length
          || found.nodes.some((node, index) => node !== intent.nodes[index]));
        const valuesChanged = !initial && (found.values.length !== intent.geometry.length
          || found.values.some((value, i) => Math.abs(value - intent.geometry[i]) > 1));
        const moved = initial || nodesChanged || valuesChanged;
        if (nodesChanged) intent.diagnostic.nodeReplacements++;
        if (valuesChanged) intent.diagnostic.geometryMoves++;
        if (moved) { intent.changedAt = now(); intent.stableAt = null; }
        intent.geometry = found.values;
        intent.nodes = found.nodes;
        intent.viewport = found.viewport;
        record(intent, moved ? "geometry-changed" : "sample", found,
          moved ? { initial, nodesChanged, valuesChanged } : null);
        // A smooth command is not a success receipt. Let its animation stop;
        // only correct a quiet but wrong position, not every intermediate frame.
        if ((loading ? !found.visible : !found.aligned) && found.move && (!intent.scrolls || (now() - intent.changedAt >= QUIET_MS
          && (intent.scrolls !== 1 || now() - intent.lastScrollAt >= SMOOTH_GRACE_MS)))) {
          if (loading ? intent.loads >= MAX_LOAD_SCROLLS : intent.scrolls - intent.loads >= MAX_SCROLLS) {
            finish(intent, { located: false, reason: loading ? "loading-unstable" : "landing-unstable" }, true); return;
          }
          try { ready = assertCurrent(intent.payload) !== false; }
          catch { if (active === intent) cancel("context-changed", true); return; }
          if (active !== intent) return;
          if (!ready) { waitForIdentity(intent); return; }
          intent.touched.add(found.move.viewport);
          found.move.viewport.scrollTo({ top: found.move.top, behavior: loading || intent.scrolls ? "instant" : "smooth" });
          if (active !== intent) return;
          intent.scrolls++;
          if (loading) intent.loads++;
          record(intent, loading ? "target-load" : "scroll", found);
          intent.lastScrollAt = now();
          intent.changedAt = now(); intent.stableAt = null;
        } else if (!loading && found.aligned && found.visible && found.ready && !moved) {
          intent.stableAt ??= now();
          if (now() - intent.stableAt >= STABLE_MS && now() - intent.targetAt >= intent.observeMs) {
            // Re-read exact DOM/Fiber + owner immediately before receipt; no
            // full message scan or authentication is necessary for this read.
            try { ready = assertCurrent(intent.payload) !== false; }
            catch { if (active === intent) cancel("context-changed", true); return; }
            if (active !== intent) return;
            if (!ready) { waitForIdentity(intent); return; }
            let presentation = {};
            const allowed = () => active === intent && now() < intent.deadline && assertCurrent(intent.payload) !== false && active === intent;
            try { if (intent.present) presentation = intent.present(found.element, allowed); }
            catch { if (active === intent) finish(intent, { located: false, reason: "presentation-failed" }, true); return; }
            if (active !== intent) return;
            try { ready = allowed(); }
            catch { if (active === intent) cancel("context-changed", true); return; }
            if (active !== intent) return;
            if (!ready) { waitForIdentity(intent); return; }
            if (intent.payload.placement !== "latest") found.element.animate?.([
              { outline: "2px solid color-mix(in srgb, currentColor 30%, transparent)", outlineOffset: "5px" },
              { outline: "2px solid transparent", outlineOffset: "12px" },
            ], { duration: 1400, easing: "ease-out" });
            finish(intent, { ...presentation, located: true, reason: null });
            return;
          }
        }
      } else {
        intent.geometry = null; intent.stableAt = null; intent.changedAt = now();
        if (intent.diagnostic.phase !== "waiting-target") record(intent, "waiting-target");
        // A DOM node can mount before its exact Fiber record. Missing binding
        // is a definite no-scroll state, not permission to guess its owner.
        // Wait within this same budget; an actual route/owner change cancels.
        if (resolved?.reason === "conversation-mismatch") {
          cancel(resolved.reason, true); return;
        }
      }
      intent.timer = setTimer(() => sample(intent), Math.min(SAMPLE_MS, Math.max(0, intent.deadline - now())));
    }
    function start(payload, { present = null } = {}) {
      // A delayed old START is not allowed to cancel a newer animation.
      try { assertCurrent(payload); }
      catch { return Promise.resolve({ located: false, reason: "context-changed", scrolls: 0 }); }
      cancel("superseded");
      const policy = global.TidyNavigationIdentity;
      const windowMs = Number.isFinite(payload?.deadlineAt) ? policy.LOAD_WINDOW_MS + policy.LANDING_WINDOW_MS : WINDOW_MS;
      const duration = Math.min(windowMs,
        Number.isFinite(payload?.deadlineAt) ? Math.max(0, payload.deadlineAt - now()) : windowMs);
      return new Promise(resolve => {
        const intent = { payload, present, resolve, startedAt: now(), targetAt: null, landingAt: null, deadline: now() + duration,
          loadDeadline: Number.isFinite(payload?.loadDeadlineAt) ? Math.min(payload.loadDeadlineAt, now() + duration) : now() + duration,
          observeMs: Math.min(OBSERVE_MS, Math.max(0, duration - SAMPLE_MS)), changedAt: now(), stableAt: null,
          timer: null, geometry: null, nodes: [], touched: new Set(), viewport: null, loads: 0, scrolls: 0, lastScrollAt: null,
          diagnostic: { navigationIntentId: payload.navigationIntentId, startedAt: now(), pending: true,
            nodeReplacements: 0, geometryMoves: 0, events: [] } };
        active = intent;
        lastDiagnostic = intent.diagnostic;
        record(intent, "started");
        sample(intent);
      });
    }
    function manual(event) {
      if (!active) return;
      if (event.type === "keydown") {
        if (!SCROLL_KEYS.has(event.key) || event.target?.closest?.('input,textarea,select,[contenteditable="true"],[role="textbox"]')) return;
      } else if (active.viewport && event.target !== active.viewport && !active.viewport.contains?.(event.target)) return;
      cancel("user-cancelled", true);
    }
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) document.addEventListener?.(type, manual, { capture: true, passive: true });
    return Object.freeze({ start, cancel,
      cancelId(id, reason = "cancelled") { if (active?.payload.navigationIntentId === id) cancel(reason); },
      dispose() {
        cancel("page-hidden", true);
        for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) document.removeEventListener?.(type, manual, { capture: true });
      } });
  }
  global.TidyChatgptMessageLocation = Object.freeze({ create, WINDOW_MS, MAX_SCROLLS, STABLE_MS, OBSERVE_MS,
    getLastDiagnostic: () => lastDiagnostic ? JSON.parse(JSON.stringify(lastDiagnostic)) : null });
})(globalThis);

// Source: src/platform/navigation/chatgpt/message-navigation.js
(function initTidyChatgptMessageNavigation(global) {
  "use strict";

  if (global.TidyChatgptMessageNavigation) return;

  // Only bookmark message commands enter this adapter. Native history search
  // owns its own route, scroll and highlight; observing its URL is not a command.
  const EXCLUDED = 'button, [role="button"], input, textarea, select, script, style, svg, [hidden], [aria-hidden="true"], [data-tidy-owned]';

  function create({ resolveTarget, resolveLoadTarget = () => null, onStatus = () => {},
    isIntentCurrent = () => false, canPresent = () => false, locate = null, cancelLocation = () => {} }) {
    let target = null;
    let status = { located: false, highlighted: false, pending: false, reason: "idle" };
    function report(next) { status = { ...next }; onStatus(status, target); return status; }
    function clear(reason = "cancelled") {
      const previous = target;
      target = null;
      if (previous) cancelLocation(previous.navigationIntentId, reason);
      return report({ located: false, highlighted: false, pending: false, reason });
    }
    function start(payload) {
      if (!isIntentCurrent(payload?.navigationIntentId) || !locate) return { located: false, highlighted: false, pending: false, reason: "superseded" };
      clear("superseded");
      if (!isIntentCurrent(payload.navigationIntentId)) return status;
      if (!payload.conversationId || !payload.messageId) return report({ located: false, highlighted: false, pending: false, reason: "no-message-target" });
      // Query is deliberately not forwarded to the message locator. Search
      // results have a separate native navigation lane, not a bookmark variant.
      const { query: _unusedQuery, ...admitted } = payload;
      target = admitted;
      const current = () => target === admitted && isIntentCurrent(admitted.navigationIntentId);
      const ready = canPresent(admitted.navigationIntentId);
      if (!current()) return status;
      const initial = ready ? resolveTarget(admitted) : { reason: "identity-pending" };
      if (!current()) return status;
      const loadable = ready && !initial.element ? resolveLoadTarget(admitted) : null;
      if (!current()) return status;
      // Presence selects source-page settlement versus native target loading;
      // it is NOT a successful location receipt. Only the common executor can
      // acknowledge geometry. This view owns no timer or second scroll loop.
      report({ located: false, highlighted: false, pending: true, targetPresent: !!(initial.element || loadable?.element),
        reason: initial.element ? "settling" : loadable?.element ? "loading-target" : initial.reason || "message-not-present" });
      if (!current()) return status;
      if (!initial.element && !loadable?.element && payload.waitForTarget !== true) return status;
      Promise.resolve(locate(admitted)).then(result => {
        if (!current()) return;
        report({ highlighted: false, highlightReason: null, ...result, pending: false });
      }).catch(() => {
        if (current()) report({ located: false, highlighted: false, pending: false, reason: "location-failed" });
      });
      return status;
    }
    return Object.freeze({ start, clear,
      dispose() { clear("extension-reloaded"); },
      cancelId: (id, reason = "cancelled") => target?.navigationIntentId === id ? clear(reason) : status,
      getStatus: () => ({ ...status }) });
  }
  // A native message-ID wrapper mounts before its lazy body. Expand/collapse
  // controls and our timestamp already have geometry at that point, but none
  // is message content. Keep that shell in the existing loading phase; do not
  // consume the landing window or report success for an empty bubble.
  function hasRenderedContent(element, document = global.document) {
    const visible = node => {
      for (let parent = node; parent; parent = parent.parentElement) {
        const style = global.getComputedStyle(parent);
        if (style.display === "none" || /^(hidden|collapse)$/.test(style.visibility)) return false;
        if (parent === element) return true;
      }
      return false;
    };
    const walker = document.createTreeWalker(element, 4);
    for (let node = walker.nextNode(), count = 0; node && count < 1_000; node = walker.nextNode(), count++) {
      const parent = node.parentElement;
      if (String(node.textContent || "").trim() && parent && !parent.closest(EXCLUDED)
        && global.TidyChatgptMessageDom.closest(parent) === element && visible(parent)) return true;
    }
    // Image-only/audio messages are content too. Their preview may itself be
    // a button, unlike the shell's text controls; do not require a text query.
    for (const media of element.querySelectorAll?.('img, video, audio, canvas') || []) {
      if (global.TidyChatgptMessageDom.closest(media) !== element
        || media.closest('[hidden], [aria-hidden="true"], [data-tidy-owned]') || !visible(media)) continue;
      const rect = media.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
    }
    return false;
  }
  global.TidyChatgptMessageNavigation = Object.freeze({ create, hasRenderedContent });
})(globalThis);

// Source: src/platform/catalog/chatgpt/date-index.js
(function initTidyChatgptDateIndex(global) {
  "use strict";

  if (global.TidyChatgptDateIndex) return;

  const contract = global.TidyDateSearch;
  const chatgptApi = global.TidyChatgptApi;
  const messageReader = global.TidyChatgptMessages;
  const pageSession = global.TidyPageSession;
  if (!contract || !chatgptApi || !messageReader || !pageSession) return;

  const ENDPOINTS = Object.freeze({
    conversations: "/backend-api/conversations",
    pins: "/backend-api/pins",
    projects: "/backend-api/gizmos/snorlax/sidebar",
    project: "/backend-api/gizmos",
  });

  function sourceSchemaError(message) {
    return new messageReader.MessageReadError("SCHEMA", message);
  }

  function responseItems(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.items)) {
      throw sourceSchemaError("ChatGPT history collection has no native items array");
    }
    return raw.items;
  }

  function identifier(value, kind) {
    if (typeof value !== "string" || !value.trim()) {
      throw sourceSchemaError(`ChatGPT ${kind} has no native identifier`);
    }
    return value.trim();
  }

  function directoryTime(value) {
    // Native directory fields are ISO strings or Unix seconds. Do not coerce
    // booleans, empty strings, or arbitrary date-like text into range evidence.
    const time = typeof value === "number" && Number.isFinite(value) ? value * 1000
      : typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : null;
    return Number.isFinite(time) && Math.abs(time) <= contract.MAX_TIME_MS ? time : null;
  }

  function directoryBounds(item, source) {
    const createdAt = directoryTime(item.create_time);
    const updatedAt = directoryTime(item.update_time);
    // 创建时间和更新时间分别属于会话目录，不能用来推断会话内每条消息的时间范围。
    return { createdAt, updatedAt, sources: [source] };
  }

  function conversationCandidate(item, source, projectId = null) {
    const conversationId = identifier(item?.id, "conversation directory item");
    const bounds = directoryBounds(item, source);
    return {
      conversationId,
      title: typeof item.title === "string" ? item.title : "",
      updatedAt: bounds.updatedAt,
      // Only a native project wrapper or project endpoint supplies this header
      // context. A generic gizmo_id can instead refer to a custom GPT.
      projectId,
      directoryBounds: bounds,
    };
  }

  function projectCandidate(gizmo) {
    if (gizmo?.gizmo_type !== "snorlax") throw sourceSchemaError("ChatGPT project has an unexpected native gizmo type");
    return { projectId: identifier(gizmo.id, "project") };
  }

  function nextCursor(raw, currentCursor, pageSize, itemCount) {
    const cursorField = Object.hasOwn(raw, "next_cursor") ? "next_cursor"
      : Object.hasOwn(raw, "cursor") ? "cursor" : null;
    if (cursorField) {
      const explicit = raw[cursorField];
      // Native project pages use cursor: null as the authoritative end marker,
      // including a full final page. It is not an absent offset-pagination hint.
      // next_cursor, when present, likewise takes precedence over cursor.
      if (explicit === null) return null;
      if (String(explicit) !== String(currentCursor ?? "")) return String(explicit);
      if (raw.has_more === false) return null;
      throw new TypeError("ChatGPT history cursor repeated");
    }
    // Only responses without a cursor field may use their offset/total flags.
    // Ordinary and archived directories use this separate native contract.
    if (raw?.has_more === true && itemCount === 0) {
      throw new TypeError("ChatGPT history source reported more data without a continuation item");
    }
    if (raw?.has_more === true && /^\d+$/.test(String(currentCursor ?? "0"))) {
      return String(Number(currentCursor || 0) + itemCount);
    }
    if (Number.isFinite(Number(raw?.total)) && /^\d+$/.test(String(currentCursor ?? "0"))) {
      const offset = Number(currentCursor || 0) + itemCount;
      return offset < Number(raw.total) ? String(offset) : null;
    }
    // 接口没有明确的结束标记时，满页继续读取，空页或不足一页才结束。
    // 这是当前 offset 分页的结束判定，不是对旧数据格式的兼容。
    return itemCount === pageSize && /^\d+$/.test(String(currentCursor ?? "0"))
      ? String(Number(currentCursor || 0) + itemCount) : null;
  }

  function sourceUrl(request) {
    if (request.source === "pins") return ENDPOINTS.pins;
    if (request.source === "ordinary" || request.source === "archived") {
      const limit = request.source === "ordinary" ? 28 : 30;
      const params = new URLSearchParams({
        offset: request.cursor || "0",
        limit: String(limit),
        order: "updated",
        is_archived: String(request.source === "archived"),
      });
      if (request.source === "ordinary") {
        params.set("is_starred", "false");
        params.set("hide_snorlax", "true");
      }
      return `${ENDPOINTS.conversations}?${params}`;
    }
    if (request.source === "projects") {
      const params = new URLSearchParams({ owned_only: "true", conversations_per_gizmo: "5", limit: "20" });
      if (request.cursor) params.set("cursor", request.cursor);
      return `${ENDPOINTS.projects}?${params}`;
    }
    const params = new URLSearchParams({ cursor: request.cursor || "0", limit: "5", owned_only: "true" });
    return `${ENDPOINTS.project}/${global.encodeURIComponent(request.projectId)}/conversations?${params}`;
  }

  function normalizeSourceResponse(raw, request) {
    let conversations = [];
    let projects = [];
    let next = null;
    const coverageReasons = [];
    if (request.source === "ordinary" || request.source === "archived") {
      const limit = request.source === "ordinary" ? 28 : 30;
      const items = responseItems(raw);
      conversations = items.map((item) => conversationCandidate(item, request.source));
      next = nextCursor(raw, request.cursor, limit, items.length);
    } else if (request.source === "pins") {
      if (!Array.isArray(raw)) throw sourceSchemaError("ChatGPT pins response is not a native array");
      for (const pin of raw) {
        if (!pin || typeof pin.item_type !== "string" || !pin.item || typeof pin.item !== "object") {
          throw sourceSchemaError("ChatGPT pin has no native item_type and item");
        }
        if (pin.item_type === "conversation") conversations.push(conversationCandidate(pin.item, "pins"));
        else if (pin.item_type === "project") projects.push(projectCandidate(pin.item.gizmo));
      }
    } else if (request.source === "projects") {
      const items = responseItems(raw);
      for (const entry of items) {
        const project = projectCandidate(entry?.gizmo?.gizmo);
        projects.push(project);
        conversations.push(...responseItems(entry.conversations)
          .map((item) => conversationCandidate(item, "project", project.projectId)));
      }
      next = nextCursor(raw, request.cursor, 20, items.length);
      coverageReasons.push("shared-projects-unverified", "project-catalog-pagination-unverified");
    } else {
      const items = responseItems(raw);
      const projectId = identifier(request.projectId, "project source request");
      conversations = items.map((item) => conversationCandidate(item, "project", projectId));
      next = nextCursor(raw, request.cursor, 5, items.length);
    }
    const page = {
      schemaVersion: contract.VERSION,
      source: request.source,
      conversations,
      projects,
      nextCursor: next,
      done: next === null,
      coverageReasons,
    };
    if (!contract.validateSourcePage(page)) throw new TypeError("Invalid standardized date-index source page");
    return page;
  }

  async function account() {
    pageSession.assertActive();
    // Explicit catalog queries resolve the current
    // session. Page continuations still share the bounded authenticated reader.
    const identity = await messageReader.account({ refresh: true });
    pageSession.assertActive();
    return { schemaVersion: contract.VERSION, accountKey: identity.accountKey };
  }

  async function readSourcePage(value) {
    pageSession.assertActive();
    const request = contract.normalizeSourceRequest(value);
    const raw = await messageReader.readJson(sourceUrl(request), request);
    pageSession.assertActive();
    return normalizeSourceResponse(raw, request);
  }

  // Date search is directory-only. The shared reader supplies authentication
  // and bounded JSON requests here, never conversation/message history pages.
  global.TidyChatgptDateIndex = Object.freeze({
    ENDPOINTS,
    sourceUrl,
    normalizeSourceResponse,
    account,
    readSourcePage,
  });
})(globalThis);

// Source: src/features/export/chatgpt/export.js
(function initTidyChatgptExport(global) {
  "use strict";

  if (global.TidyChatgptExport) return;

  const contract = global.TidyExportContract;
  const projection = global.TidyChatgptConversationProjection;
  const { markdownToBlocks } = global.TidyChatgptNativeMessageContent;
  const { activeBranch, responseConversationId } = global.TidyChatgptActiveBranch;
  const routeAdapter = global.TidyChatgptRoute;
  const chatgptApi = global.TidyChatgptApi;
  const pageSession = global.TidyPageSession;
  if (!projection || !contract || !routeAdapter || !chatgptApi || !pageSession) return;

  // 正文先返回。图片只保留页内读取句柄，不把文件编号/凭据交给侧栏。
  // 最多保留 5000 个轻量资源引用；切账号立即清空，旧句柄只能报错，不能串账号。
  const imageReads = new Map();
  const imageRequests = new Map();
  let imageSequence = 0;
  const unsubscribeIdentity = chatgptApi.onLibraryIdentityChanged?.(() => imageReads.clear());
  // 退休页面不能继续持有签名地址、图片句柄或超时器；中止只清理，绝不重试。
  pageSession.onDispose(() => {
    unsubscribeIdentity?.();
    for (const entry of imageReads.values()) entry.resolvedFiles.clear();
    imageReads.clear();
    for (const [controller, timer] of imageRequests) {
      clearTimeout(timer);
      controller.abort(pageSession.error());
    }
    imageRequests.clear();
  });

  function routeOwnsConversation(conversationId, context = {}) {
    if (typeof context.routeOwnsConversation === "function") {
      return context.routeOwnsConversation(conversationId) === true;
    }
    return routeAdapter.parse().conversationId === conversationId;
  }

  function conversationSourceUrl(conversationId) {
    return new URL(`/c/${global.encodeURIComponent(conversationId)}`, global.location.origin).href;
  }

  // 只拦截当前活动回合尾端的明确进行中状态，不把缺字段或工具的 end_turn:false
  // 猜成未完成。历史/废分支的流式标记不应锁死整份会话；本检查也不宣称能
  // 证明 API 已追上页面，或能判断一个已停止记录之后是否还会继续工具调用。
  function assertResponseNotInProgress(payload) {
    const branch = activeBranch(payload);
    for (let index = branch.length - 1; index >= 0; index--) {
      const message = branch[index]?.message;
      const role = message?.author?.role;
      if (role === "user") return;
      if (!["assistant", "tool"].includes(role)) continue;
      if (message.status === "in_progress") {
        throw Object.assign(new Error("The current response is still in progress."), {
          tidyCode: global.TidyProtocol.ErrorCode.EXPORT_RESPONSE_PENDING,
        });
      }
      return;
    }
  }

  // Convert one canonical ChatGPT response into the shared export document.
  // Batch reads and the current-tab read deliberately use this same parser so
  // visible reasoning, web searches, citations, and active-branch filtering
  // cannot drift between export entry points. messageNumber is the logical
  // message sequence in this complete export, never a mounted DOM fallback.
  function documentFromPayload(payload, expectedConversationId, value = {}, sourceUrl = "", imageReferences = null) {
    // 流中的记录仍可用于原生编号，但不能成为可导出的文档/图片读取句柄。
    assertResponseNotInProgress(payload);
    // 原生投影只负责语义；导出契约与有效性校验由导出适配器拥有。
    const projected = projection.projectConversation(payload, expectedConversationId, value,
      sourceUrl || conversationSourceUrl(expectedConversationId), imageReferences);
    const document = { schemaVersion: contract.VERSION, ...projected };
    const validation = contract.validateDocument(document);
    if (!validation.valid) throw new Error(`Invalid current export document: ${validation.errors.join(", ")}`);
    return document;
  }

  async function resourceReadGuard(checkRoute = () => true) {
    pageSession.assertActive();
    // 先确认账号，再记住本次读取归属；首次正常登录不能被误判成中途切换账号。
    await chatgptApi.readLibraryAccount();
    pageSession.assertActive();
    const stamp = () => {
      const identity = chatgptApi.checkLibraryIdentity();
      return JSON.stringify([chatgptApi.activeWorkspace(), identity.accountKey, identity.epoch, identity.phase]);
    };
    const owner = stamp();
    return () => {
      pageSession.assertActive();
      if (!checkRoute() || stamp() !== owner) throw new Error("The export owner changed while image addresses were loading.");
    };
  }

  function registerImageResources(document, references, guard, gizmoId) {
    guard();
    const resolvedFiles = new Map();
    for (const resource of document.conversation.resources) {
      pageSession.assertActive();
      const fileId = references.get(resource.id);
      if (!fileId) continue;
      const readHandle = `image-${++imageSequence}-${Math.random().toString(36).slice(2)}`;
      resource.pending = true;
      resource.readHandle = readHandle;
      imageReads.set(readHandle, { resource: { ...resource }, fileId, guard, gizmoId, resolvedFiles });
      while (imageReads.size > 5000) imageReads.delete(imageReads.keys().next().value);
    }
    return document;
  }

  async function fetchImageAddress(fileId, gizmoId) {
    pageSession.assertActive();
    // 单张地址最多等 20 秒；项目图片沿用来源会话的项目，不借当前打开的其他项目。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    imageRequests.set(controller, timer);
    try {
      const projectQuery = typeof gizmoId === "string" && /^g-[a-z0-9-]+$/i.test(gizmoId)
        ? `&gizmo_id=${global.encodeURIComponent(gizmoId)}` : "";
      const response = await chatgptApi.fetchAuthenticated(
        `/backend-api/files/download/${global.encodeURIComponent(fileId)}?inline=false&download_intent=false${projectQuery}`,
        { headers: { Accept: "application/json" }, signal: controller.signal },
      );
      pageSession.assertActive();
      if (!response.ok) throw new Error("Image address unavailable");
      const data = await response.json();
      pageSession.assertActive();
      const url = new URL(data.download_url);
      // 只接受对应文件的原生签名地址，不转发 Bearer 到任意资源服务器。
      if (url.origin !== "https://chatgpt.com" || url.pathname !== "/backend-api/estuary/content"
        || url.username || url.password || url.searchParams.get("id") !== fileId) throw new Error("Invalid image address");
      return data;
    } finally {
      clearTimeout(timer);
      imageRequests.delete(controller);
    }
  }

  async function readImageResource({ readHandle } = {}) {
    pageSession.assertActive();
    const entry = imageReads.get(readHandle);
    if (!entry) throw new Error("The export image read expired. Refresh the content.");
    const { fileId, guard, gizmoId, resolvedFiles } = entry;
    guard();
    const resource = { ...entry.resource, pending: false };
    delete resource.readHandle;
    try {
      // 同一图片出现多次共用进行中的请求；签名地址仅存在本次导出内存中。
      if (!resolvedFiles.has(fileId)) resolvedFiles.set(fileId, fetchImageAddress(fileId, gizmoId).catch(() => {
        pageSession.assertActive();
        return null;
      }));
      const data = await resolvedFiles.get(fileId);
      pageSession.assertActive();
      if (!data) throw new Error("Image address unavailable");
      resource.src = data.download_url;
      resource.temporaryUrl = true;
      if (typeof data.file_name === "string" && data.file_name) resource.name = data.file_name;
      if (typeof data.mime_type === "string") resource.mimeType = data.mime_type;
      if (Number.isInteger(data.file_size_bytes) && data.file_size_bytes >= 0) resource.sizeBytes = data.file_size_bytes;
    } catch {
      // 只有单图故障可降级；页面停止必须向上失败，不能变成成功的空图片。
      pageSession.assertActive();
    }
    // 归属变化不是单图失败，不能吞掉；句柄淘汰也不能让迟到结果恢复旧资料。
    guard();
    if (imageReads.get(readHandle) !== entry) throw new Error("The export image read expired.");
    return { readHandle, resource };
  }

  async function fetchConversationDocument(expectedConversationId, value = {}, guard) {
    pageSession.assertActive();
    guard();
    const response = await chatgptApi.fetchAuthenticated(
      `/backend-api/conversation/${global.encodeURIComponent(expectedConversationId)}`,
      { headers: { Accept: "application/json" }, signal: pageSession.signal },
    );
    guard();
    if (!response.ok) throw new Error(`Conversation export failed (${response.status}) for ${expectedConversationId}.`);
    const payload = await response.json();
    guard();
    const responseId = responseConversationId(payload);
    if (responseId && responseId !== expectedConversationId) {
      throw new Error(`Conversation export identity changed for ${expectedConversationId}.`);
    }
    guard();
    const references = new Map();
    return registerImageResources(documentFromPayload(payload, expectedConversationId, value, "", references), references, guard, payload.gizmo_id);
  }

  // One conversation order for page, bookmarks and export. An assistant's
  // thinking/tool/final records belong to one logical reply, so every exact
  // source record in that reply receives the SAME number. Never number a
  // virtualized DOM slice or the native Fiber's local turnIndex.
  async function readCurrentConversation(value = {}, context = {}) {
    pageSession.assertActive();
    const expectedConversationId = value.expectedConversationId;
    const route = routeAdapter.parse();
    if (!expectedConversationId || !routeOwnsConversation(expectedConversationId, context)) {
      throw new Error("The current conversation changed before export started.");
    }
    const guard = await resourceReadGuard(() => routeOwnsConversation(expectedConversationId, context));
    guard();
    const response = await chatgptApi.fetchAuthenticated(
      `/backend-api/conversation/${global.encodeURIComponent(expectedConversationId)}`,
      { headers: { Accept: "application/json" }, signal: pageSession.signal },
    );
    pageSession.assertActive();
    if (!response.ok) throw new Error(`Current conversation export failed (${response.status}).`);
    const payload = await response.json();
    pageSession.assertActive();
    const responseId = responseConversationId(payload);
    if (responseId && responseId !== expectedConversationId) {
      throw new Error("The current conversation export identity changed.");
    }
    if (!routeOwnsConversation(expectedConversationId, context)) {
      throw new Error("The current conversation changed while export data was loading.");
    }
    guard();
    const references = new Map();
    return registerImageResources(documentFromPayload(payload, expectedConversationId, value, route.href, references), references, guard, payload.gizmo_id);
  }

  async function readConversations(value = {}) {
    pageSession.assertActive();
    const ids = [...new Set((Array.isArray(value.conversationIds) ? value.conversationIds : [])
      .filter((id) => typeof id === "string" && id.trim())
      .map((id) => id.trim()))];
    if (!ids.length) throw new Error("Batch export requires at least one conversation.");
    const fallbackTitles = value.fallbackTitles && typeof value.fallbackTitles === "object"
      ? value.fallbackTitles : {};
    const documents = [];
    const guard = await resourceReadGuard();
    guard();
    // Keep the request bounded and predictable. The API token is shared by the
    // adapter, while sequential reads avoid a burst when a large favorites
    // catalogue is selected.
    for (const conversationId of ids) {
      guard();
      const document = await fetchConversationDocument(conversationId, {
        fallbackTitle: fallbackTitles[conversationId],
      }, guard);
      guard();
      documents.push(document);
    }
    guard();
    return {
      schemaVersion: contract.COLLECTION_VERSION,
      documents,
    };
  }

  global.TidyChatgptExport = Object.freeze({
    markdownToBlocks,
    routeOwnsConversation,
    readCurrentConversation,
    readConversations,
    readImageResource,
  });
})(globalThis);

// Source: src/features/titles/chatgpt/titles.js
(function initTidyChatgptTitles(global) {
  "use strict";

  if (global.TidyChatgptTitles) return;

  const pageSession = global.TidyPageSession;

  // These are operation deadlines, not a retry interval. A timed-out write
  // must be reconciled by reading; neither 401 nor 5xx ever repeats the POST.
  const READ_TIMEOUT_MS = 20_000;
  const WRITE_TIMEOUT_MS = 55_000;
  const REQUEST_TIMEOUT_MS = 12_000;
  const BATCH_EXECUTION_TTL_MS = 10 * 60_000;
  const writing = new Set();
  // One page owns at most one explicitly confirmed batch. Credentials stay in
  // page memory only; a reload drops them and the worker pauses the durable job.
  const batchExecutions = new Map();
  pageSession.onDispose(() => {
    // A stopped page can never reuse a confirmed batch or its bearer headers.
    writing.clear();
    batchExecutions.clear();
  });

  function fault(code, message, httpStatus = null) {
    return Object.assign(new Error(message), { tidyCode: code, httpStatus });
  }

  function workspace() {
    pageSession.assertActive();
    try { return global.TidyChatgptApi.activeWorkspace(); }
    catch {
      throw fault("TITLE_ACCOUNT_CHANGED", "The active workspace is unavailable.");
    }
  }

  const isConversationId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
  const isProjectId = (value) => typeof value === "string" && /^g-p-[A-Za-z0-9_-]+$/.test(value);

  function canonicalRoute() {
    pageSession.assertActive();
    let url;
    try { url = new URL(global.location.href); } catch { /* Rejected below. */ }
    // The general snapshot parser intentionally tolerates more routes. A write
    // owner is narrower: one saved ordinary/project conversation, not a share,
    // custom GPT, draft, group, suffix route, or an insecure/lookalike origin.
    const route = global.TidySnapshot.parseConversationPath(url?.pathname);
    if (url?.origin !== "https://chatgpt.com" || !route) {
      throw fault("CONTEXT_MISMATCH", "Open the same saved conversation before continuing.");
    }
    // Match the worker's canonical owner path. A native trailing slash is the
    // same saved page, not a new owner, but arbitrary suffix routes stay banned.
    return route;
  }

  function operationContext(input) {
    const route = canonicalRoute();
    const conversationId = input.conversationId;
    const requestedOwner = input.ownerContext;
    if (!isConversationId(conversationId)
      || (requestedOwner !== undefined && (!requestedOwner || typeof requestedOwner !== "object"
        || requestedOwner.conversationId !== route.conversationId || requestedOwner.pathname !== route.pathname
        || requestedOwner.projectId !== route.projectId))
      || (requestedOwner === undefined && conversationId !== route.conversationId)) {
      throw fault("CONTEXT_MISMATCH", "The title operation no longer belongs to this page.");
    }
    // An off-current batch target is authorized by the worker's frozen catalog,
    // not by navigating the user's tab. Never inherit the owner's project for
    // another target; each target has its own proven project association.
    const projectId = input.targetProjectId === undefined
      ? conversationId === route.conversationId ? route.projectId : null : input.targetProjectId;
    if ((projectId !== null && !isProjectId(projectId))
      || (conversationId === route.conversationId && projectId !== route.projectId)) {
      throw fault("CONTEXT_MISMATCH", "The target project does not match its confirmed context.");
    }
    return Object.freeze({ conversationId, projectId, owner: Object.freeze({ ...route }) });
  }

  function assertRoute(context) {
    const route = canonicalRoute();
    if (route.conversationId !== context.owner.conversationId || route.pathname !== context.owner.pathname
      || route.projectId !== context.owner.projectId) {
      throw fault("CONTEXT_MISMATCH", "The title operation no longer belongs to this page.");
    }
  }

  function sameIdentity(left, right) {
    return Boolean(left && right && left.accountKey === right.accountKey
      && left.workspaceKey === right.workspaceKey);
  }

  function assertContext(context, workspaceKey) {
    assertRoute(context);
    if (workspaceKey !== workspace()) {
      throw fault("TITLE_ACCOUNT_CHANGED", "The active workspace changed.");
    }
  }

  async function boundedRequest(url, init, deadline, json = true) {
    pageSession.assertActive();
    const remaining = Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now());
    if (remaining <= 0) throw fault("ADAPTER_TIMEOUT", "The title request timed out.");
    const controller = new global.AbortController();
    let timer;
    let unsubscribe = () => {};
    let expired = false;
    const assertRequest = () => {
      // Fetch/body readers may ignore abort (including mocks and cached bodies).
      // Their late continuation must not begin the next operation after timeout.
      pageSession.assertActive();
      if (expired) throw fault("ADAPTER_TIMEOUT", "The title request timed out.");
    };
    try {
      const stopped = new Promise((_, reject) => {
        unsubscribe = pageSession.onDispose(() => {
          global.clearTimeout(timer);
          controller.abort();
          reject(pageSession.error());
        });
      });
      const result = await Promise.race([
        (async () => {
          assertRequest();
          const response = await global.TidyChatgptApi.fetchTitleRequest(url, {
            ...init, credentials: "include", cache: "no-store", signal: controller.signal,
          });
          assertRequest();
          // Never forward server bodies (which can contain account information)
          // or credentials over the page bridge.
          const body = json && response.ok ? await response.json() : null;
          assertRequest();
          return { ok: response.ok, status: response.status, body };
        })(),
        new Promise((_, reject) => {
          timer = global.setTimeout(() => {
            expired = true;
            controller.abort();
            reject(fault("ADAPTER_TIMEOUT", "The title request timed out."));
          }, remaining);
        }),
        stopped,
      ]);
      assertRequest();
      return result;
    } finally {
      global.clearTimeout(timer);
      unsubscribe();
    }
  }

  async function readSession(context, deadline) {
    assertRoute(context);
    const response = await boundedRequest("/api/auth/session", {
      method: "GET", headers: { Accept: "application/json" },
    }, deadline);
    assertRoute(context);
    if (response.status === 429) throw fault("TITLE_RATE_LIMITED", "ChatGPT is limiting title requests.", 429);
    const session = response.body;
    if (!response.ok || typeof session?.accessToken !== "string" || !session.accessToken
      || typeof session?.user?.id !== "string" || !session.user.id) {
      throw fault("TITLE_AUTH_REQUIRED", "Sign in again before organizing titles.", response.status);
    }
    return session;
  }

  function sessionAuth(session, workspaceKey) {
    pageSession.assertActive();
    const identity = { accountKey: session.user.id, workspaceKey };
    const headers = { Accept: "application/json", Authorization: `Bearer ${session.accessToken}` };
    // Native ChatGPT derives the workspace header from _account, not user.id
    // or session.activeAccountId. Personal workspace intentionally omits it.
    if (workspaceKey !== "personal") headers["ChatGPT-Account-ID"] = encodeURIComponent(workspaceKey);
    // Project the directory identity from this very session, not a second
    // request or a guess based on the rename adapter's different identity.
    const { accountKey: catalogAccountKey } = global.TidyChatgptApi.catalogIdentity(session);
    return { identity, headers, catalogAccountKey };
  }

  async function acquirePreviewAuth(context, deadline) {
    // A first read-only preview has no accepted workspace to compare against.
    // ChatGPT may initialize _account while its startup session is loading:
    // bind AFTER that request, rather than calling initialization an account
    // switch. Metadata and the final session still verify this exact identity.
    // This is acquisition, not a retry and never authority for an existing plan.
    const session = await readSession(context, deadline);
    pageSession.assertActive();
    return sessionAuth(session, workspace());
  }

  async function freshAuth(context, deadline, expectedIdentity = null) {
    // Already-bound reads, apply lookups, writes and readback keep the strict
    // before/after workspace check. They may never adopt a new workspace.
    const workspaceKey = workspace();
    const session = await readSession(context, deadline);
    assertContext(context, workspaceKey);
    const auth = sessionAuth(session, workspaceKey);
    if (expectedIdentity && !sameIdentity(auth.identity, expectedIdentity)) {
      throw fault("TITLE_ACCOUNT_CHANGED", "The signed-in account changed.");
    }
    return auth;
  }

  function catalogProjection(before, after = before) {
    pageSession.assertActive();
    // Directory synchronization is optional evidence, never write authority.
    // If only the catalog key changes, retain the independently verified title
    // result but do not attach an ambiguous account for cache projection.
    return before.catalogAccountKey && before.catalogAccountKey === after.catalogAccountKey
      ? { catalogAccountKey: before.catalogAccountKey } : {};
  }

  function batchScope(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
  }

  async function beginBatchExecution(input = {}) {
    const context = operationContext(input);
    const scopeId = batchScope(input.batchScopeId);
    if (!scopeId || typeof input.expectedCatalogAccountKey !== "string" || !input.expectedCatalogAccountKey
      || (input.identity != null && (typeof input.identity?.accountKey !== "string" || typeof input.identity.workspaceKey !== "string"))) {
      throw fault("TITLE_INVALID_PLAN", "The title batch execution context is invalid.");
    }
    const deadline = Date.now() + READ_TIMEOUT_MS;
    const auth = await freshAuth(context, deadline, input.identity || null);
    pageSession.assertActive();
    if (auth.catalogAccountKey !== input.expectedCatalogAccountKey) {
      throw fault("TITLE_ACCOUNT_CHANGED", "The conversation directory account changed.");
    }
    batchExecutions.clear();
    batchExecutions.set(scopeId, {
      identity: auth.identity, headers: auth.headers, catalogAccountKey: auth.catalogAccountKey,
      owner: context.owner, expiresAt: Date.now() + BATCH_EXECUTION_TTL_MS,
    });
    return { identity: auth.identity, catalogAccountKey: auth.catalogAccountKey };
  }

  function batchAuth(input, context) {
    pageSession.assertActive();
    const scopeId = batchScope(input.batchScopeId);
    const execution = scopeId ? batchExecutions.get(scopeId) : null;
    if (!execution || execution.expiresAt < Date.now() || !sameIdentity(execution.identity, input.identity)
      || execution.owner.conversationId !== context.owner.conversationId
      || execution.owner.pathname !== context.owner.pathname || execution.owner.projectId !== context.owner.projectId) {
      if (scopeId) batchExecutions.delete(scopeId);
      throw fault("TITLE_AUTH_EXPIRED", "Confirm this batch again before continuing.");
    }
    assertContext(context, execution.identity.workspaceKey);
    return execution;
  }

  function endBatchExecution(input = {}) {
    const context = operationContext(input);
    const scopeId = batchScope(input.batchScopeId);
    if (!scopeId) throw fault("TITLE_INVALID_PLAN", "The title batch execution context is invalid.");
    const execution = batchExecutions.get(scopeId);
    if (execution) {
      if (execution.owner.conversationId !== context.owner.conversationId
        || execution.owner.pathname !== context.owner.pathname || execution.owner.projectId !== context.owner.projectId) {
        throw fault("CONTEXT_MISMATCH", "The title batch belongs to another page.");
      }
      batchExecutions.delete(scopeId);
    }
    return { ended: true };
  }

  function iso(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const date = new Date(value * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  async function readMetadata(context, auth, deadline) {
    const { conversationId, projectId } = context;
    assertContext(context, auth.identity.workspaceKey);
    // Native project reads add this header (HAR project sample + native Ky).
    // Rename itself uses the generic endpoint without a project header. Shared
    // project owner headers are deliberately not guessed or copied from a UI.
    const headers = { ...auth.headers, ...(projectId ? { "chatgpt-project-id": projectId } : {}) };
    const response = await boundedRequest(
      `/backend-api/conversations/${encodeURIComponent(conversationId)}?include_has_versions=true&num_turns=10`,
      { method: "GET", headers }, deadline,
    );
    assertContext(context, auth.identity.workspaceKey);
    if (!response.ok) {
      throw fault(response.status === 429 ? "TITLE_RATE_LIMITED" : response.status === 401 ? "TITLE_AUTH_REQUIRED" : "TITLE_UNAVAILABLE",
        "The current title could not be read.", response.status);
    }
    const body = response.body;
    if (body?.conversation_id !== conversationId || typeof body.title !== "string") {
      throw fault("TITLE_UNAVAILABLE", "The title response did not match this conversation.");
    }
    const nativeProjectId = body.gizmo_type === "snorlax" && isProjectId(body.gizmo_id) ? body.gizmo_id : null;
    if (nativeProjectId !== projectId || (body.gizmo_type === "snorlax" && !nativeProjectId)) {
      // A stale directory target is not an owner-tab/account change. The
      // batch may reject this one item and keep preparing unrelated titles;
      // it must never borrow the newly observed project and silently write.
      throw fault("TITLE_TARGET_CHANGED", "The conversation's project changed.");
    }
    if (body.is_read_only === true || body.is_temporary_chat === true
      || (body.owner != null && (typeof body.owner.user_id !== "string"
        || body.owner.user_id !== auth.identity.accountKey))) {
      throw fault("TITLE_UNAVAILABLE", "This conversation is not an editable owned conversation.");
    }
    return {
      conversationId, title: body.title,
      createdAt: iso(body.create_time), updatedAt: iso(body.update_time),
    };
  }

  async function readCurrent(input = {}) {
    const context = operationContext(input);
    const { identity: expectedIdentity, identityOnly = false } = input;
    const deadline = Date.now() + READ_TIMEOUT_MS;
    const auth = !expectedIdentity && identityOnly !== true
      ? await acquirePreviewAuth(context, deadline)
      : await freshAuth(context, deadline, expectedIdentity);
    pageSession.assertActive();
    // Apply only needs the identity to locate its durable plan. Its writer
    // performs the authoritative metadata preflight immediately before POST.
    if (identityOnly === true) return { identity: auth.identity, ...catalogProjection(auth) };
    const current = await readMetadata(context, auth, deadline);
    pageSession.assertActive();
    // Detect logout/account changes that occurred during the metadata request.
    const finalAuth = await freshAuth(context, deadline, auth.identity);
    pageSession.assertActive();
    return { identity: auth.identity, current, ...catalogProjection(auth, finalAuth) };
  }

  async function writeCurrent(input = {}) {
    const { conversationId, identity, before, after } = input;
    const context = operationContext(input);
    if (typeof identity?.accountKey !== "string" || !identity.accountKey || typeof identity.workspaceKey !== "string" || !identity.workspaceKey
      || typeof before !== "string" || typeof after !== "string" || !after.trim() || before === after) {
      throw fault("TITLE_INVALID_PLAN", "The confirmed title plan is invalid.");
    }
    // Explicit provenance is mandatory. Never compare directory timestamps to
    // detail timestamps as if they were a shared version number, and never
    // infer the source of an older/incomplete executable plan.
    if (!["catalog", "detail"].includes(input.metadataSource)
      || !Object.hasOwn(input, "expectedCreatedAt") || !Object.hasOwn(input, "expectedUpdatedAt")
      || (input.metadataSource === "catalog" && (!input.catalogIntent?.rules
        || !["assign", "remove"].includes(input.catalogIntent.operation)))
      || (input.metadataSource === "detail" && Object.hasOwn(input, "catalogIntent"))) {
      throw fault("TITLE_INVALID_PLAN", "The title plan requires an explicit date validation source.");
    }
    if (writing.has(conversationId)) throw fault("TITLE_BUSY", "A title write is already running.");
    writing.add(conversationId);
    const deadline = Date.now() + WRITE_TIMEOUT_MS;
    let dispatched = false;
    let current = null;
    let httpStatus = null;
    try {
      const batchExecution = batchScope(input.batchScopeId);
      let auth = batchExecution ? batchAuth(input, context) : await freshAuth(context, deadline, identity);
      pageSession.assertActive();
      current = await readMetadata(context, auth, deadline);
      pageSession.assertActive();
      if (current.title !== before) return { status: "conflict", current, messageCode: "title_conflict" };
      if (input.metadataSource === "catalog") {
        // Reuse this live preflight and the same pure date model as the preview.
        // Only the EXACT confirmed output may be sent, with the original rules
        // and conflict decision. No tolerance, new recipe, extra GET or retry.
        const planned = global.TidyTitleDates.plan(current, input.catalogIntent.rules, {
          operation: input.catalogIntent.operation, decision: input.catalogIntent.decision,
        });
        if (planned.before !== before || planned.after !== after || !planned.canApply || planned.noOp || planned.wouldEmpty) {
          return { status: "conflict", current, messageCode: "dates_changed" };
        }
      } else {
        // A detail preview already has a same-source baseline. Preserve exact
        // comparison of BOTH timestamps, including a one-millisecond change.
        for (const [expected, field] of [["expectedCreatedAt", "createdAt"], ["expectedUpdatedAt", "updatedAt"]]) {
          if (input[expected] !== current[field]) return { status: "conflict", current, messageCode: "dates_changed" };
        }
      }
      // A lease proves the original confirmation, not the browser's current
      // user. Another tab can switch users without changing the personal
      // workspace cookie or reloading this page. Revalidate once, at the last
      // asynchronous boundary before POST; metadata already passed preflight.
      // Batch 2xx still needs no detail readback or second session request.
      auth = await freshAuth(context, deadline, identity);
      pageSession.assertActive();
      if (batchExecution && auth.catalogAccountKey !== batchAuth(input, context).catalogAccountKey) {
        throw fault("TITLE_ACCOUNT_CHANGED", "The conversation directory account changed.");
      }
      dispatched = true;
      let outcome;
      try {
        // One modern native rename endpoint, verified in the website's public
        // client. Do not fall back to PATCH or replay when the result is unclear.
        outcome = await boundedRequest(
          `/backend-api/conversation/id/${encodeURIComponent(conversationId)}/rename`,
          { method: "POST", headers: { ...auth.headers, "Content-Type": "application/json" },
            body: JSON.stringify({ title: after }) }, deadline, false,
        );
        pageSession.assertActive();
        httpStatus = outcome.status;
      } catch {
        // A lost response permits a readback only while this page still owns
        // the operation. Disposal is terminal, not a retry/reconcile trigger.
        pageSession.assertActive();
        // Dispatch may have reached the server. A readback is safe; resend isn't.
      }
      pageSession.assertActive();
      if (outcome && !outcome.ok && outcome.status >= 400 && outcome.status < 500 && outcome.status !== 408) {
        return { status: "failed", current, httpStatus, messageCode: "http_error" };
      }
      if (batchExecution && outcome?.ok) {
        // ChatGPT's native client treats a successful rename response as the
        // mutation boundary and refreshes its directory later. Record that
        // narrower fact truthfully: accepted is not a metadata readback.
        return { status: "accepted", accepted: { ...current, title: after }, httpStatus,
          ...catalogProjection(auth) };
      }
      try {
        // Keep this operation's already checked credentials for the readback.
        // Route/workspace checks bracket the request, and the final fresh
        // session check still rejects an account switch during POST/readback.
        const observed = await readMetadata(context, auth, deadline);
        pageSession.assertActive();
        const finalAuth = batchExecution ? (assertContext(context, identity.workspaceKey), auth)
          : await freshAuth(context, deadline, identity);
        pageSession.assertActive();
        if (observed.title === after) return { status: "verified", current: observed, httpStatus,
          ...catalogProjection(auth, finalAuth) };
        if (observed.title !== before) {
          return { status: "conflict", current: observed, httpStatus, messageCode: "title_conflict" };
        }
        return { status: "uncertain", current: observed, httpStatus, messageCode: "write_uncertain" };
      } catch {
        pageSession.assertActive();
        return { status: "uncertain", current: null, httpStatus, messageCode: "readback_unavailable" };
      }
    } catch (error) {
      // An undispatched operation retains the canonical lifecycle error. A
      // dispatched POST may have reached the server, so keep only uncertainty:
      // no readback, accepted/verified result, or catalog projection survives.
      if (!pageSession.check()) {
        if (!dispatched) throw pageSession.error();
        return { status: "uncertain", current: null, httpStatus, messageCode: "write_uncertain" };
      }
      // A failed identity check must also disarm the old page-memory lease.
      // A later explicit confirmation can acquire a new one; a queued step
      // cannot recover by reusing credentials from the previous signed-in user.
      if (["TITLE_ACCOUNT_CHANGED", "TITLE_AUTH_REQUIRED", "TITLE_AUTH_EXPIRED", "CONTEXT_MISMATCH"].includes(error.tidyCode)) {
        batchExecutions.delete(batchScope(input.batchScopeId));
      }
      return {
        status: dispatched ? "uncertain" : "failed", current: null, httpStatus: error.httpStatus || httpStatus,
        messageCode: dispatched ? "write_uncertain"
          : ["TITLE_ACCOUNT_CHANGED", "TITLE_AUTH_REQUIRED", "TITLE_AUTH_EXPIRED"].includes(error.tidyCode) ? "account_changed"
          : error.tidyCode === "TITLE_RATE_LIMITED" ? "title_rate_limited"
          : error.tidyCode === "TITLE_TARGET_CHANGED" ? "target_changed"
          : error.tidyCode === "CONTEXT_MISMATCH" ? "context_changed" : "readback_unavailable",
      };
    } finally {
      writing.delete(conversationId);
    }
  }

  global.TidyChatgptTitles = Object.freeze({ readCurrent, writeCurrent, beginBatchExecution, endBatchExecution });
})(globalThis);

// Source: src/features/titles/chatgpt/title-sync.js
(function initTidyChatgptTitleSync(global) {
  "use strict";

  if (global.TidyChatgptTitleSync) return;
  const pageSession = global.TidyPageSession;
  const HISTORY_KEYS = [["conversationHistory"], ["conversationHistory", { hideProjectChats: true }]];
  // Page-lifetime observations cover SPA navigation, but never survive reload
  // or an observed account/workspace switch. This is not a title history store.
  const observations = new Map();
  const MAX_OBSERVATIONS = 16;
  let accountKey = null;
  let observedWorkspace = null;

  function workspace() {
    try { return global.TidyChatgptApi.activeWorkspace(); }
    catch { return null; }
  }

  function revoke() {
    observations.clear();
    accountKey = null;
    observedWorkspace = null;
  }

  function matchesIdentity(identity, owner = accountKey, selectedWorkspace = observedWorkspace) {
    return identity?.phase === "ready"
      && identity.accountKey === JSON.stringify([owner, selectedWorkspace]);
  }

  // Title receipts use the raw user/workspace pair; IdentitySession exposes its
  // opaque compound key. Revoke presentation and delayed QueryClient callbacks
  // together, including a same-workspace user switch and document suspension.
  const unsubscribeIdentity = global.TidyChatgptApi.onLibraryIdentityChanged((identity) => {
    if (!pageSession.check()) return;
    if (identity.phase !== "ready" || (accountKey && !matchesIdentity(identity))) revoke();
  });
  // 官方已保存的新标题接管展示；旧回执和延迟 QueryClient 回调不能再把它改回去。
  const unsubscribeTitle = global.TidyChatgptApi.onTitleChanged(({ conversationId }) => {
    if (pageSession.check()) observations.delete(conversationId);
  });
  // Retiring this page instance only releases TIDY-owned state/listeners. Native
  // queries must not be cancelled or invalidated as part of teardown.
  pageSession.onDispose(() => {
    revoke();
    unsubscribeIdentity();
    unsubscribeTitle();
  });

  function active(conversationId) {
    if (!pageSession.check()) return undefined;
    global.TidyChatgptApi.checkLibraryIdentity();
    if (!pageSession.check()) return undefined;
    if (observedWorkspace !== workspace()) revoke();
    return pageSession.check() ? observations.get(conversationId) : undefined;
  }

  function fiber(element, visit, maxDepth = 160) {
    const key = Object.keys(element || {}).find((name) => name.startsWith("__reactFiber$"));
    let value = element?.[key];
    for (let depth = 0; value && depth < maxDepth; depth++, value = value.return) {
      const found = visit(value.memoizedProps || {});
      if (found) return found;
    }
    return null;
  }

  function links(conversationId) {
    return [...global.document.querySelectorAll('a[data-sidebar-item="true"][href]')].filter((link) => {
      if (link.getAttribute("data-sidebar-item") !== "true" || link.closest("main, [data-message-id]")) return false;
      const route = savedRoute(new URL(link.getAttribute("href"), global.location.origin).href);
      if (!route || route.conversationId !== conversationId) return false;
      const row = rowMetadata(link);
      // Mutation requires an exact native row identity, not just a matching URL.
      return (row?.id || row?.conversation_id) === conversationId;
    });
  }

  function savedRoute(href = global.location.href) {
    let url;
    try { url = new URL(href); } catch { return null; }
    const route = global.TidyChatgptRoute.parse(href);
    const saved = global.TidySnapshot.parseConversationPath(url.pathname);
    // 与面板、后台、标题读写共用精确路径边界；名称后缀不参与项目身份。
    return url.origin === "https://chatgpt.com" && saved ? { ...route, ...saved } : null;
  }

  function acceptScope(current, scope) {
    const route = savedRoute();
    if (!route) return null;
    const owner = scope.ownerContext;
    if (owner !== undefined && (!owner || owner.conversationId !== route.conversationId
      || owner.pathname !== route.pathname || owner.projectId !== (route.projectId || null))) return null;
    if (owner === undefined && route.conversationId !== current.conversationId) return null;
    const projectId = scope.targetProjectId === undefined
      ? route.conversationId === current.conversationId ? route.projectId || null : null : scope.targetProjectId;
    if ((projectId !== null && (typeof projectId !== "string" || !/^g-p-[A-Za-z0-9_-]+$/.test(projectId)))
      || (route.conversationId === current.conversationId && projectId !== (route.projectId || null))) return null;
    return { projectId, isCurrent: route.conversationId === current.conversationId };
  }

  function rowMetadata(link) {
    return fiber(link, (props) => props.historyItem, 40);
  }

  function newer(value, than) {
    return Number.isFinite(Date.parse(value)) && (!Number.isFinite(Date.parse(than)) || Date.parse(value) > Date.parse(than));
  }

  function superseded(item, current) {
    return item?.title !== current.title && newer(item?.update_time, current.updatedAt);
  }

  function supersededObservation(item, record) {
    if (!record.titleOnly) return superseded(item, record.current);
    // Accepted renames have no post-write timestamp. Compare later native
    // observations only to the native baseline captured at acceptance, never
    // compare directory timestamps with the detail preflight's timestamp.
    return (typeof item?.title === "string" && !record.titles.has(item.title))
      || (record.nativeUpdatedAt && item?.title !== record.current.title && newer(item?.update_time, record.nativeUpdatedAt));
  }

  function titleNode(element) {
    for (const child of element?.childNodes || []) {
      if (child.nodeType === 3 && child.textContent.trim()) return child;
      if (child.nodeType !== 1 || child.matches?.('[data-tidy-owned], button, svg, [aria-hidden="true"]')) continue;
      const found = titleNode(child);
      if (found) return found;
    }
    return null;
  }

  function queryClient(rows) {
    const roots = [...rows, global.document.querySelector("div[data-message-id]"), global.document.querySelector("main")];
    for (const root of roots.filter(Boolean)) {
      const client = fiber(root, (props) => {
        const candidate = props.client;
        return candidate && ["getQueryCache", "setQueriesData", "cancelQueries", "invalidateQueries"]
          .every((name) => typeof candidate[name] === "function") ? candidate : null;
      });
      if (client) return client;
    }
    return null;
  }

  function patchHistory(data, record) {
    const current = record.current;
    // QueryClient may retain this updater and invoke it after cancellation has
    // settled. Guard the updater itself, not just the call that supplied it.
    if (active(current.conversationId) !== record) return data;
    // Match the native infinite-query shape. Preserve all pagination and row
    // fields; never create a directory row or reorder conversations ourselves.
    if (!Array.isArray(data?.pages) || data.pages.some((page) => !Array.isArray(page?.items))) return data;
    if (data.pages.some((page) => page.items.some((item) => item?.id === current.conversationId && supersededObservation(item, record)))) {
      observations.delete(current.conversationId);
      return data;
    }
    let changed = false;
    const pages = data.pages.map((page) => {
      let pageChanged = false;
      const items = page.items.map((item) => {
        if (item?.id !== current.conversationId) return item;
        if (record.titleOnly) {
          if (item.title === current.title) return item;
          changed = pageChanged = true;
          return { ...item, title: current.title };
        }
        if (newer(item.update_time, current.updatedAt)) return item;
        if (item.title === current.title && item.update_time === current.updatedAt) return item;
        changed = pageChanged = true;
        return { ...item, title: current.title,
          ...(current.createdAt ? { create_time: current.createdAt } : {}),
          ...(current.updatedAt ? { update_time: current.updatedAt } : {}),
        };
      });
      return pageChanged ? { ...page, items } : page;
    });
    return changed && active(current.conversationId) === record ? { ...data, pages } : data;
  }

  function refresh() {
    if (!pageSession.check()) return;
    global.TidyChatgptApi.checkLibraryIdentity();
    if (!pageSession.check()) return;
    if (observedWorkspace !== workspace()) revoke();
    for (const record of observations.values()) refreshRecord(record);
  }

  function refreshRecord(record) {
    if (active(record.current.conversationId) !== record) return;
    const route = savedRoute();
    // A move into/out of a project changes the metadata scope. Retire the old
    // observation rather than carrying it across the newly bound native page.
    if (route?.conversationId === record.current.conversationId
      && (route.projectId || null) !== record.projectId) {
      observations.delete(record.current.conversationId);
      return;
    }
    const rows = links(record.current.conversationId);
    // A third native title is a newer external observation. Relinquish our
    // presentation instead of fighting another tab or the native rename UI.
    const nodes = rows.map(titleNode).filter(Boolean);
    if (nodes.some((node) => !record.titles.has(node.textContent.trim()))
      || rows.some((row) => supersededObservation(rowMetadata(row), record))) {
      observations.delete(record.current.conversationId);
      return;
    }
    for (const node of nodes) {
      if (node.textContent !== record.current.title) {
        if (active(record.current.conversationId) !== record) return;
        node.textContent = record.current.title;
      }
    }
    for (const row of rows) {
      const label = row.getAttribute("aria-label");
      // Preserve native qualifiers such as pinned/unread; change only the
      // known title prefix so screen readers agree with the visible label.
      const prefix = [...record.titles].filter(Boolean).sort((a, b) => b.length - a.length)
        .find((title) => label?.startsWith(title));
      if (prefix && prefix !== record.current.title) {
        if (active(record.current.conversationId) !== record) return;
        row.setAttribute("aria-label", record.current.title + label.slice(prefix.length));
      }
    }
    if (route?.conversationId === record.current.conversationId
      && global.document.title !== record.current.title && record.documentTitles.has(global.document.title)) {
      if (active(record.current.conversationId) !== record) return;
      global.document.title = record.current.title;
    }
  }

  function acceptObservation(current, identity, before, nativeCurrent, scope, titleOnly) {
    if (!pageSession.check()) return false;
    if (!current || typeof current.title !== "string" || !identity?.accountKey || identity.workspaceKey !== workspace()
      || !/^[A-Za-z0-9_-]+$/.test(current.conversationId || "")) return false;
    const pageIdentity = global.TidyChatgptApi.checkLibraryIdentity();
    if (!pageSession.check()) return false;
    // A verified receipt can precede the first session observation. Once any
    // page identity boundary is known, however, a late old receipt cannot
    // recreate a revoked record, even after BFCache restores the same page.
    if (!(pageIdentity.phase === "unavailable" && pageIdentity.epoch === 0)
      && !matchesIdentity(pageIdentity, identity.accountKey, identity.workspaceKey)) return false;
    const target = acceptScope(current, scope);
    if (!target) return false;
    // A batch result belongs to its target, never the currently open owner's
    // title/store. It may update that target's existing sidebar row and cache.
    if (nativeCurrent?.conversationId !== current.conversationId) nativeCurrent = null;
    if (titleOnly && nativeCurrent?.title?.value && ![before, current.title].includes(nativeCurrent.title.value)) return false;
    if (accountKey !== identity.accountKey || observedWorkspace !== workspace()) observations.clear();
    accountKey = identity.accountKey;
    observedWorkspace = workspace();
    const rows = links(current.conversationId);
    const changed = nativeCurrent?.title?.value !== current.title
      || newer(current.updatedAt, nativeCurrent?.updatedAt?.value)
      || rows.some((row) => titleNode(row)?.textContent.trim() !== current.title);
    const record = {
      // A 2xx is title acceptance, not a verified metadata readback. Keep its
      // observation title-only even if an adapter supplied preflight dates.
      current: titleOnly ? { conversationId: current.conversationId, title: current.title } : { ...current },
      titleOnly,
      nativeUpdatedAt: titleOnly ? [nativeCurrent?.updatedAt?.value, ...rows.map(row => rowMetadata(row)?.update_time)]
        .filter(value => Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null : null,
      projectId: target.projectId,
      titles: new Set([before, current.title, nativeCurrent?.title?.value,
        ...rows.map((row) => titleNode(row)?.textContent.trim())].filter((value) => typeof value === "string"
          && (!titleOnly || value === before || value === current.title))),
      documentTitles: new Set([...(target.isCurrent ? [global.document.title] : []), current.title,
        before, nativeCurrent?.title?.value].filter((value) => typeof value === "string"
          && (!titleOnly || value === before || value === current.title))),
    };
    if (!pageSession.check()) return false;
    observations.delete(current.conversationId);
    observations.set(current.conversationId, record);
    while (observations.size > MAX_OBSERVATIONS) observations.delete(observations.keys().next().value);
    refresh();
    if (!pageSession.check()) return false;
    // ChatGPT's history cache uses the public QueryClient API. Its separate
    // thread-title store has no exposed setter, so a verified, page-scoped text
    // projection also covers that stale label without mutating React state.
    const client = changed ? queryClient(rows) : null;
    if (client) {
      try {
        // These are the native public directory query keys. A project has
        // several paged variants under this prefix; do not invalidate messages
        // or every project merely because one title changed.
        const projectKey = record.projectId ? ["snorlaxConversations", { gizmoId: record.projectId }] : null;
        if (active(current.conversationId) !== record) return false;
        const historyCancelled = client.cancelQueries({ queryKey: ["conversationHistory"] }, { silent: true });
        // A native callback can retire the page synchronously. Do not dispatch
        // the second query operation merely because the first was authorized.
        if (active(current.conversationId) !== record) {
          void Promise.resolve(historyCancelled).catch(() => {});
          return false;
        }
        const cancelled = projectKey ? Promise.all([historyCancelled,
          client.cancelQueries({ queryKey: projectKey }, { silent: true })]) : historyCancelled;
        void Promise.resolve(cancelled).then(() => {
          if (active(current.conversationId) !== record) return;
          for (const queryKey of HISTORY_KEYS) {
            if (active(current.conversationId) !== record) return;
            client.setQueriesData({ queryKey, exact: true }, (data) => patchHistory(data, record));
          }
          if (projectKey && active(current.conversationId) === record) {
            client.setQueriesData({ queryKey: projectKey }, (data) => patchHistory(data, record));
          }
          // Refetch only the directory. Never invalidate the active message
          // tree, change navigation, replay rename, or reload the document.
          if (typeof before === "string" && before !== current.title && active(current.conversationId) === record) {
            const historyRefresh = client.invalidateQueries({ queryKey: ["conversationHistory"], refetchType: "active" });
            if (!projectKey || active(current.conversationId) !== record) return historyRefresh;
            return Promise.all([historyRefresh, client.invalidateQueries({ queryKey: projectKey, refetchType: "active" })]);
          }
        }).catch(() => {});
      } catch { /* Display synchronization must not change a verified save receipt. */ }
    }
    return pageSession.check();
  }

  function accept(current, identity, before = null, nativeCurrent = null, scope = {}) {
    return acceptObservation(current, identity, before, nativeCurrent, scope, false);
  }

  function acceptTitle(current, identity, before, nativeCurrent = null, scope = {}) {
    if (typeof before !== "string" || current?.title === before) return false;
    return acceptObservation(current, identity, before, nativeCurrent, scope, true);
  }

  function project(conversation) {
    if (!pageSession.check()) return conversation;
    const record = active(conversation?.conversationId);
    if (!record
      || conversation.bindingStatus !== "bound") return conversation;
    const route = savedRoute();
    if (route?.conversationId === record.current.conversationId
      && (route.projectId || null) !== record.projectId) {
      observations.delete(record.current.conversationId);
      return conversation;
    }
    const nativeTitle = conversation.title?.value;
    if ((nativeTitle && !record.titles.has(nativeTitle)) || (record.titleOnly
      && supersededObservation({ title: nativeTitle, update_time: conversation.updatedAt?.value }, record))) {
      observations.delete(record.current.conversationId);
      return conversation;
    }
    const sourced = (value) => ({ value, source: record.titleOnly ? "chatgpt-api.title-accepted" : "chatgpt-api.title-readback", status: "available" });
    if (record.titleOnly) return pageSession.check() ? { ...conversation, title: sourced(record.current.title) } : conversation;
    // A subsequent message can advance the update time without changing the
    // title. Keep that newer native timestamp; dates are never guessed.
    const updatedAt = Date.parse(conversation.updatedAt?.value) > Date.parse(record.current.updatedAt)
      ? conversation.updatedAt : record.current.updatedAt ? sourced(record.current.updatedAt) : conversation.updatedAt;
    if (!pageSession.check()) return conversation;
    return { ...conversation, title: sourced(record.current.title), updatedAt,
      createdAt: record.current.createdAt ? sourced(record.current.createdAt) : conversation.createdAt,
    };
  }

  global.TidyChatgptTitleSync = Object.freeze({ accept, acceptTitle, project, refresh });
})(globalThis);

// Source: src/platform/navigation/chatgpt/library-navigation.js
(function initTidyChatgptLibraryNavigation(global) {
  "use strict";

  if (global.TidyChatgptLibraryNavigation) return;

  const ORIGIN = "https://chatgpt.com";
  // 同一目标在 1.5 秒内的连续点击只发起一次原生路由切换；不是重试计时。
  const DUPLICATE_WINDOW_MS = 1500;
  // 这里只等待站点接收路由，不接管官方搜索的消息定位/高亮。
  const NATIVE_SEARCH_WINDOW_MS = 30_000;

  function targetFor(payload, location) {
    if (typeof payload?.conversationId !== "string" || !/^[A-Za-z0-9_-]+$/.test(payload.conversationId)
      || typeof payload.pathname !== "string"
      || typeof payload.expectedAccountKey !== "string" || !payload.expectedAccountKey
      || payload.expectedAccountKey.trim() !== payload.expectedAccountKey
      || !Number.isSafeInteger(payload.expectedEpoch) || payload.expectedEpoch < 0) return null;

    // 导航边界比只读解析严格：不自动修补路径，不接受查询/锚点、编码分隔符、
    // 草稿、自定义 GPT、分享和群组路径，避免把其他页面误当作普通会话打开。
    const ordinary = /^\/c\/([A-Za-z0-9_-]+)$/.exec(payload.pathname);
    const project = /^\/g\/(g-p-[A-Za-z0-9_-]+)\/c\/([A-Za-z0-9_-]+)$/.exec(payload.pathname);
    if ((!ordinary && !project) || (ordinary ? ordinary[1] : project[2]) !== payload.conversationId) return null;
    const nativeSearch = payload.placement === "native-search";
    if (payload.placement != null && !["latest", "native-search"].includes(payload.placement)) return null;
    if (nativeSearch && (typeof payload.query !== "string" || !payload.query.trim() || payload.query.length > 500
      || (payload.messageId != null && (typeof payload.messageId !== "string" || !payload.messageId.trim()
        || payload.messageId.length > 256 || /[\u0000-\u001f\u007f]/.test(payload.messageId))))) return null;
    try {
      const current = new URL(location.href);
      if (current.origin !== ORIGIN || location.origin !== ORIGIN) return null;
      const destination = new URL(payload.pathname, ORIGIN);
      if (nativeSearch) {
        // 与官方搜索结果链接一致：标题命中可无消息 ID，不能据此改走日期 latest。
        destination.searchParams.set("src", "history_search");
        if (payload.messageId) destination.searchParams.set("messageId", payload.messageId);
        destination.searchParams.set("historySearchQuery", payload.query.trim());
      }
      const routeUrl = destination.pathname + destination.search;
      return { pathname: payload.pathname, fromHref: current.href,
        routeUrl,
        conversationId: payload.conversationId, placement: payload.placement,
        loadDeadlineAt: payload.loadDeadlineAt, deadlineAt: payload.deadlineAt,
        nativeFallbackAt: payload.nativeFallbackAt,
        navigationIntentId: payload.navigationIntentId,
        accountKey: payload.expectedAccountKey, epoch: payload.expectedEpoch,
        key: JSON.stringify([payload.expectedAccountKey, payload.expectedEpoch, routeUrl]) };
    } catch { return null; }
  }

  function owns(identity, target, requireReady = false) {
    return identity?.accountKey === target.accountKey && identity.epoch === target.epoch
      && (!requireReady || identity.phase === "ready");
  }

  function create({
    readAccount = () => global.TidyChatgptApi.readLibraryAccount(),
    checkIdentity = () => global.TidyChatgptApi.checkLibraryIdentity(),
    location = global.location,
    // 由站点路由更新原生左栏选中态；不手动染色、不伪造 history、不点击左栏。
    getRouter = () => global.__reactRouterDataRouter,
    now = () => Date.now(),
    isIntentCurrent = () => false,
    revealLatest = () => {},
    setTimer = (fn, delay) => global.setTimeout(fn, delay),
    clearTimer = timer => global.clearTimeout(timer),
  } = {}) {
    let inFlight = null;
    let lastDispatch = null;
    let latestIntentId = null;
    const result = (navigated, reason) => ({ navigated, reason });

    async function nativeAcknowledgement(target, dispatch) {
      const outcome = await dispatch.promise;
      if (!isIntentCurrent(target.navigationIntentId)) return result(false, "superseded");
      // 派发前严格核验 epoch；派发后的只读回执使用持续存活的意图归属。
      // 同账号暂时失联再恢复会推进 epoch，不应因此把已完成的官方跳转报错。
      const identity = checkIdentity();
      if (!isIntentCurrent(target.navigationIntentId)) return result(false, "superseded");
      // 回执仅确认官方已接收导航，不宣称消息已定位。合法的身份恢复等待
      // 不会撤销已授权命令；真实账号切换仍由共享 gate 永久撤销，不能复活。
      if (global.TidyNavigationIdentity.state(identity, target.accountKey) === "revoked") return result(false, "context-mismatch");
      if (!outcome) return result(false, "native-router-failed");
      const current = new URL(location.href);
      // 官方可能清掉一次性搜索参数，也可能把普通路径规范化为项目会话路径。
      const canonicalProject = /^\/g\/g-p-[A-Za-z0-9_-]+\/c\/([A-Za-z0-9_-]+)$/.exec(current.pathname);
      const atTarget = current.origin === ORIGIN && (current.pathname === target.pathname
        || (/^\/c\//.test(target.pathname) && canonicalProject?.[1] === target.conversationId));
      if (!atTarget) return result(false, "native-route-unconfirmed");
      const requested = new URL(target.routeUrl, ORIGIN);
      for (const parameter of ["messageId", "historySearchQuery"]) {
        if (current.searchParams.has(parameter)
          && current.searchParams.get(parameter) !== requested.searchParams.get(parameter)) return result(false, "native-route-unconfirmed");
      }
      return { navigated: true, reason: "native-router", presentationOwner: "native" };
    }

    function reveal(target) {
      if (target.placement !== "latest" || latestIntentId === target.navigationIntentId || !isIntentCurrent(target.navigationIntentId)) return;
      latestIntentId = target.navigationIntentId;
      revealLatest(target);
    }

    function unchanged(target) {
      return location.origin === ORIGIN && location.href === target.fromHref;
    }

    async function perform(target) {
      // 复用本地身份状态，不因每次跳转重新请求认证；等待后再次核对归属。
      if (!isIntentCurrent(target.navigationIntentId)) return result(false, "superseded");
      if (target.placement === "native-search" && Number.isFinite(target.loadDeadlineAt)
        && now() >= target.loadDeadlineAt) return result(false, "native-router-timeout");
      const identity = await readAccount();
      if (!isIntentCurrent(target.navigationIntentId)) return result(false, "superseded");
      if (!owns(identity, target) || !owns(checkIdentity(), target, true)) return result(false, "context-mismatch");
      if (!unchanged(target)) return result(false, "route-changed");
      const currentUrl = new URL(location.href);
      const needsCleanUrl = target.placement === "latest" && currentUrl.pathname === target.pathname && Boolean(currentUrl.search || currentUrl.hash);
      if (target.placement !== "native-search" && currentUrl.pathname === target.pathname && !needsCleanUrl) {
        // 路由相同不代表位置正确；收藏仍要滚到最新内容。
        reveal(target);
        return result(true, "already-current");
      }
      if (lastDispatch?.key === target.key && lastDispatch.fromHref === target.fromHref
        && now() - lastDispatch.at < DUPLICATE_WINDOW_MS) {
        if (lastDispatch.failed) return result(false, "native-router-failed");
        if (target.placement === "native-search") return nativeAcknowledgement(target, lastDispatch);
        // 新点击可以接管正在切换的会话，但旧点击的定位效果不会一起继承。
        reveal(target);
        return result(true, "navigation-pending");
      }

      let router, navigate;
      try { router = getRouter(); navigate = router?.navigate; } catch { /* 按能力缺失处理，仍须完成下面的归属检查。 */ }
      // 获取站点对象后再封口：任何旧账号、旧点击或用户手动离开都不能触发导航。
      if (!owns(checkIdentity(), target, true)) return result(false, "context-mismatch");
      if (!unchanged(target)) return result(false, "route-changed");
      if (!isIntentCurrent(target.navigationIntentId)) return result(false, "superseded");
      if (typeof navigate !== "function") return result(false, "native-router-unavailable");

      const remaining = Number.isFinite(target.loadDeadlineAt)
        ? Math.min(NATIVE_SEARCH_WINDOW_MS, target.loadDeadlineAt - now()) : NATIVE_SEARCH_WINDOW_MS;
      if (target.placement === "native-search" && remaining <= 0) return result(false, "native-router-timeout");

      const dispatch = lastDispatch = { key: target.key, fromHref: target.fromHref, at: now() };
      try {
        if (target.placement === "native-search") {
          // 搜索只委托一次官方路由，不运行 Tidy 定位器，也不进行整页补载。
          let timer;
          dispatch.promise = Promise.race([
            Promise.resolve(navigate.call(router, target.routeUrl)).then(() => true, () => false),
            new Promise(resolve => { timer = setTimer(() => resolve(false), remaining); }),
          ]).then(accepted => { dispatch.failed = !accepted; return accepted; }).finally(() => clearTimer(timer));
          return nativeAcknowledgement(target, dispatch);
        }
        // 日期/收藏仍使用已有 latest 定位；书签仍使用既有消息定位器。
        // 不等待站点 Promise（它可能永不结束）；定位器在有限时间内确认落点，
        // 搜索禁止整页补载；其它模块是否允许由后台各自的导航合同决定。
        // 异步拒绝须接住，不能成为未处理异常。
        Promise.resolve(navigate.call(router, target.pathname)).catch(() => { dispatch.failed = true; });
        reveal(target);
        return result(true, "native-router");
      } catch {
        // 同步抛错也可能已经改变 URL。后台必须重新核对当前文档、账号和路由，
        // 不能直接把失败当作再次打开任意页面的许可。
        dispatch.failed = true;
        return result(false, "native-router-failed");
      }
    }

    function navigate(payload) {
      const target = targetFor(payload, location);
      if (!target) return Promise.resolve(result(false, "invalid-target"));
      if (!isIntentCurrent(target.navigationIntentId)) return Promise.resolve(result(false, "superseded"));
      // 只有同一点击才共用 Promise；新点击不能加入已经过期的旧操作。
      if (inFlight && inFlight.id === target.navigationIntentId) return inFlight.key === target.key
        ? inFlight.promise : Promise.resolve(result(false, "navigation-in-progress"));
      const request = { key: target.key, id: target.navigationIntentId, promise: null };
      // 先登记再调用依赖，防止原生回调重入造成重复派发。
      request.promise = Promise.resolve().then(() => perform(target)).finally(() => {
        if (inFlight === request) inFlight = null;
      });
      inFlight = request;
      return request.promise;
    }

    return Object.freeze({ navigate });
  }

  global.TidyChatgptLibraryNavigation = Object.freeze({ create, DUPLICATE_WINDOW_MS, NATIVE_SEARCH_WINDOW_MS });
})(globalThis);

// Source: src/platform/chatgpt/native-appearance.js
// 只读原生主题与画布颜色；不写 DOM，也不拥有快照发布。
(function initTidyChatgptNativeAppearance(global) {
  "use strict";
  if (global.TidyChatgptNativeAppearance) return;
  const document = global.document;
  function parsedBackgroundColor(value) {
    const match = String(value || "").match(/rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)(?:\D+([\d.]+))?/i);
    // Semi-transparent layers are not a native surface by themselves; using
    // their uncomposited RGB would make the Side Panel visibly wrong.
    if (!match || Number(match[4] ?? 1) < 0.98) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  }

  function isDarkRgb([red, green, blue]) {
    // Perceptual luminance is sufficient here; this is appearance metadata,
    // not a color transformation or user-content decision.
    return (0.2126 * red + 0.7152 * green + 0.0722 * blue) < 128;
  }

  function cssRgb([red, green, blue]) {
    return `rgb(${red}, ${green}, ${blue})`;
  }

  function readAppearance() {
    const root = document.documentElement;
    const body = document.body;
    const classScheme = root?.classList?.contains("dark") || body?.classList?.contains("dark")
      ? "dark" : null;
    let declaredScheme = null;
    let computedScheme = null;
    let nativeSurface = null;
    let surfaceSource = null;
    if (typeof global.getComputedStyle === "function") {
      // Prefer the actual conversation canvas, then fall back to body/root.
      // Computed colors are parsed into an opaque rgb value before crossing
      // the Adapter boundary, so arbitrary CSS can never reach the panel.
      const candidates = [
        document.querySelector?.("main"),
        document.querySelector?.('[role="main"]'),
        body,
        root,
      ].filter(Boolean);
      for (const element of [...new Set(candidates)]) {
        if (!element) continue;
        const style = global.getComputedStyle(element);
        const candidateScheme = String(style?.colorScheme || "").toLowerCase();
        if (!declaredScheme && ["dark", "only dark"].includes(candidateScheme)) {
          declaredScheme = "dark";
        }
        if (!declaredScheme && ["light", "only light"].includes(candidateScheme)) {
          declaredScheme = "light";
        }
        const background = parsedBackgroundColor(style?.backgroundColor);
        if (!nativeSurface && background) {
          nativeSurface = cssRgb(background);
          surfaceSource = element === body
            ? "computed-style.body.background"
            : element === root
              ? "computed-style.root.background"
              : "computed-style.main.background";
          computedScheme = isDarkRgb(background) ? "dark" : "light";
        }
      }
    }
    const colorScheme = classScheme || declaredScheme || computedScheme
      || (global.matchMedia?.("(prefers-color-scheme: dark)")?.matches === true ? "dark" : "light");
    const source = classScheme ? "document.class"
      : declaredScheme ? "computed-style.color-scheme"
        : computedScheme ? "computed-style.background" : "system-color-scheme";
    const surfaceMatchesScheme = nativeSurface && computedScheme === colorScheme;
    return {
      colorScheme,
      source,
      status: source === "system-color-scheme" ? "partial" : "available",
      surface: {
        value: surfaceMatchesScheme ? nativeSurface : null,
        source: surfaceMatchesScheme ? surfaceSource : null,
        status: surfaceMatchesScheme ? "available" : "missing",
      },
    };
  }


  global.TidyChatgptNativeAppearance = Object.freeze({ readAppearance });
})(globalThis);

// Source: src/platform/chatgpt/native-snapshot-reader.js
// 只读原生 DOM/Fiber 的证据与字段。唯一可写状态是当前文档草稿 ID 对应关系。
(function initTidyChatgptNativeSnapshotReader(global) {
  "use strict";
  if (global.TidyChatgptNativeSnapshotReader) return;
  function create({ readMessageNumbers = () => null } = {}) {
    const snapshotContract = global.TidySnapshot;
    const routeAdapter = global.TidyChatgptRoute;
    const bindingAdapter = global.TidyChatgptBinding;
    const messageDom = global.TidyChatgptMessageDom;
    const sidebarDom = global.TidyChatgptSidebarDom;
    const document = global.document;
    const draftIdMap = new Map();
    function readSignal(object, key) {
      const getter = object?.[key];
      if (typeof getter !== "function") return null;
      try {
        return getter.call(object);
      } catch {
        return null;
      }
    }

    function fiberFrom(element) {
      if (!element) return null;
      const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactFiber$"));
      return key ? element[key] : null;
    }

    function walkFiber(element, visitor, maxDepth = 160) {
      let fiber = fiberFrom(element);
      let depth = 0;
      while (fiber && depth < maxDepth) {
        const result = visitor(fiber.memoizedProps || {}, fiber);
        if (result !== undefined && result !== null) return result;
        fiber = fiber.return;
        depth += 1;
      }
      return null;
    }

    function toIso(value) {
      if (value == null || value === "") return null;
      let number = Number(value);
      if (Number.isFinite(number) && Math.abs(number) < 100_000_000_000) number *= 1000;
      const date = Number.isFinite(number) ? new Date(number) : new Date(value);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    function firstText(element) {
      if (!element) return null;
      for (const node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) return node.textContent.trim();
        if (node.nodeType === Node.ELEMENT_NODE) {
          // Presentation nodes are rendered by Tidy from this DTO. Never feed
          // their formatted text back into the ChatGPT Adapter as source data.
          if (node.matches?.("[data-tidy-owned]")) continue;
          const text = firstText(node);
          if (text) return text;
        }
      }
      return null;
    }

    function findThreadConversation() {
      const messageElement = messageDom.candidates()[0];
      return walkFiber(messageElement, (props) => {
        const candidate = props.conversation;
        return typeof candidate?.id === "string" ? candidate : null;
      }, 40);
    }

    function fiberConversationCandidates(element, maxDepth = 160) {
      const candidates = [];
      const seen = new Set();
      let fiber = fiberFrom(element);
      let depth = 0;
      while (fiber && depth < maxDepth) {
        const props = fiber.memoizedProps || {};
        for (const candidate of [props.conversation, props.historyItem]) {
          if (!candidate || typeof candidate !== "object" || seen.has(candidate)) continue;
          seen.add(candidate);
          candidates.push(candidate);
        }
        fiber = fiber.return;
        depth += 1;
      }
      return candidates;
    }

    function candidateConversationIds(candidate) {
      return [
        candidate?.id,
        candidate?.conversation_id,
        candidate?.conversationId,
        readSignal(candidate, "serverId$"),
      ].filter((value) => typeof value === "string" && value);
    }

    function findCurrentPageMeta(identity) {
      const accepted = new Set(bindingAdapter.acceptedIds(identity));
      if (!accepted.size) return null;
      const roots = [
        messageDom.candidates()[0],
        document.querySelector("main"),
        document.querySelector("header"),
      ].filter(Boolean);
      const seenRoots = new Set();
      for (const root of roots) {
        if (seenRoots.has(root)) continue;
        seenRoots.add(root);
        for (const candidate of fiberConversationCandidates(root)) {
          const ids = candidateConversationIds(candidate);
          if (!ids.some((id) => accepted.has(id))) continue;
          if (candidate.create_time == null && candidate.update_time == null) continue;
          return {
            kind: "conversation",
            value: candidate,
            link: null,
            boundId: ids.find((id) => accepted.has(id)) || null,
            source: "react-fiber.current-conversation",
          };
        }
      }
      return null;
    }

    function hasCurrentPageIdentityEvidence(identity) {
      const accepted = new Set(bindingAdapter.acceptedIds(identity));
      if (!accepted.size) return false;
      for (const element of messageDom.candidates()) {
        const record = findMessageRecord(element, messageDom.id(element));
        const conversationId = bindingAdapter.recordConversationId(record);
        if (conversationId && accepted.has(conversationId)) return true;
      }
      return false;
    }

    function resolveRouteIdentity(route, threadConversation) {
      return bindingAdapter.resolve(
        route,
        {
          clientId: threadConversation?.id || null,
          serverId: readSignal(threadConversation, "serverId$"),
        },
        draftIdMap,
        routeAdapter.isDraftId,
      );
    }

    function routeIdFromHref(href) {
      return routeAdapter.parse(new URL(href || "", global.location.origin).href).conversationId;
    }

    function sidebarMetaForLink(link) {
      return walkFiber(link, (props) => {
        const candidate = props.conversation || props.historyItem;
        if (candidate && (candidate.id || candidate.create_time || candidate.update_time)) {
          return { kind: "conversation", value: candidate };
        }
        if (props.room?.id) return { kind: "group", value: props.room };
        return null;
      }, 40);
    }

    function findConversationMeta(identity) {
      const accepted = new Set(bindingAdapter.acceptedIds(identity));
      if (!accepted.size) return null;

      for (const link of sidebarDom.candidates()) {
        const linkId = routeIdFromHref(link.getAttribute("href"));
        if (!accepted.has(linkId)) continue;
        const result = sidebarMetaForLink(link);
        if (!result) continue;

        const candidateId = result.value?.id || result.value?.conversation_id || null;
        if (candidateId && !accepted.has(candidateId)) continue;
        return { ...result, link, boundId: linkId, source: "react-fiber.history-item" };
      }
      return null;
    }

    function threadConversationMatches(identity, threadConversation) {
      const threadId = threadConversation?.id || null;
      const serverId = readSignal(threadConversation, "serverId$");
      return bindingAdapter.acceptedIds(identity).some((id) => id === threadId || id === serverId);
    }

    function currentConversationMeta(identity, sidebarMeta, pageMeta, cachedMeta, threadConversation) {
      // The current page is the primary source. The native sidebar is merely a
      // second exact source and may be absent in responsive/narrow layouts.
      const candidates = [pageMeta, sidebarMeta, cachedMeta].filter(Boolean);
      const complete = candidates.find((meta) =>
        meta.value?.create_time != null && meta.value?.update_time != null,
      );
      if (complete) return complete;
      if (candidates.length) return candidates[0];
      if (!identity.threadBound || !threadConversationMatches(identity, threadConversation)) return null;
      if (threadConversation?.create_time == null && threadConversation?.update_time == null) return null;
      return {
        kind: "conversation",
        value: threadConversation,
        link: null,
        boundId: identity.conversationId,
        source: "react-fiber.thread-conversation",
      };
    }

    function sourced(value, source, status = "available") {
      return {
        value: value ?? null,
        source: value == null ? null : source,
        status: value == null ? "missing" : status,
      };
    }

    function groupRoomCreatedAt(room) {
      // A room object's own createdAt can be its client-side instantiation time.
      // Only the earliest room message is authoritative, and only after ChatGPT
      // confirms that the beginning of history has been fetched.
      if (readSignal(room, "hasFetchedBeginning$") !== true) return null;
      const messages = readSignal(room, "messages$");
      const first = Array.isArray(messages) ? messages[0] : null;
      return toIso(first?.createdAt ?? first?.create_time);
    }

    function readSidebarConversations() {
      const items = [];
      const seen = new Set();

      for (const link of sidebarDom.candidates()) {
        const href = link.getAttribute("href");
        if (!href) continue;
        const itemRoute = routeAdapter.parse(new URL(href, global.location.origin).href);
        const conversationId = itemRoute.conversationId;
        if (!conversationId || routeAdapter.isDraftId(conversationId) || seen.has(conversationId)) continue;
        seen.add(conversationId);

        const meta = sidebarMetaForLink(link);
        const value = meta?.value || null;
        const candidateId = value?.id || value?.conversation_id || null;
        const mismatched = Boolean(candidateId && candidateId !== conversationId);

        // `historyItem` is read only from the Fiber attached to this exact href.
        // A matching candidate id is strongest proof. Some ChatGPT sidebar
        // builds omit the id from `historyItem`; direct Fiber ownership by the
        // exact conversation anchor remains sufficient for read-only display.
        // We never search another row or fall back to the first history item.
        const bindingStatus = mismatched
          ? bindingAdapter.BindingStatus.MISMATCH
          : meta
            ? bindingAdapter.BindingStatus.BOUND
            : bindingAdapter.BindingStatus.ROUTE_ONLY;
        const canReadMetadata = bindingStatus === bindingAdapter.BindingStatus.BOUND;
        const isGroup = meta?.kind === "group";
        const titleValue = firstText(link);
        // Frozen DTO contract: canonical conversation metadata is the only
        // source for createdAt/updatedAt. Message timestamps never overwrite
        // these fields. Group-room signals remain their separate adapter path.
        const createdAt = canReadMetadata
          ? isGroup
            ? groupRoomCreatedAt(value)
            : toIso(value?.create_time)
          : null;
        const updatedAt = canReadMetadata
          ? toIso(isGroup ? readSignal(value, "updatedAt$") : value?.update_time)
          : null;
        const timeSource = isGroup ? "react-fiber.group-room" : "react-fiber.history-item";

        items.push({
          conversationId,
          identityStatus: "stable",
          bindingStatus,
          kind: itemRoute.kind,
          title: sourced(titleValue, "sidebar-dom"),
          createdAt: sourced(createdAt, timeSource),
          updatedAt: sourced(updatedAt, timeSource),
          project: itemRoute.projectId
            ? { projectId: itemRoute.projectId, title: null, source: "route", status: "partial" }
            : null,
          locator: {
            strategy: "href",
            value: href,
          },
        });
      }

      return items;
    }

    function readProject(route, meta) {
      if (!route.projectId) return null;
      let title = null;
      const projectLink = [...document.querySelectorAll('a[href$="/project"]')].find(link => {
        const candidate = routeAdapter.parse(link.getAttribute("href"));
        return candidate.supported && candidate.kind === "project" && candidate.projectId === route.projectId;
      });
      if (projectLink) title = firstText(projectLink);
      return {
        projectId: route.projectId,
        title,
        source: title ? "sidebar-dom" : meta ? "route+fiber" : "route",
        status: title ? "available" : "partial",
      };
    }

    function readConversationFields(route, identity, meta) {
      const value = meta?.value;
      const isGroup = meta?.kind === "group";
      const fiberTitle = isGroup ? readSignal(value, "name$") : value?.title;
      const domTitle = firstText(meta?.link);
      const title = [domTitle, fiberTitle]
        .find((candidate) => typeof candidate === "string" && candidate.trim() && candidate !== "ChatGPT") || null;

      const createdAt = meta
        ? isGroup
          ? groupRoomCreatedAt(value)
          : toIso(value?.create_time)
        : null;
      const updatedAt = meta
        ? toIso(isGroup ? readSignal(value, "updatedAt$") : value?.update_time)
        : null;
      const timeSource = isGroup
        ? "react-fiber.group-room"
        : meta?.source || "react-fiber.history-item";

      return {
        conversationId: identity.conversationId,
        draftId: identity.draftId,
        identityStatus: identity.status,
        bindingStatus: identity.bindingStatus,
        kind: route.kind,
        title: {
          value: title,
          source: title
            ? title === domTitle
              ? "sidebar-dom"
              : title === fiberTitle
                ? meta?.source || "react-fiber"
                : null
            : null,
          status: title ? (identity.status === "stable" ? "available" : "provisional") : "missing",
        },
        project: readProject(route, meta),
        createdAt: sourced(createdAt, timeSource),
        updatedAt: sourced(updatedAt, timeSource),
      };
    }

    function normalizeRole(value) {
      const role = value?.author?.role || value?.role || value?.message?.author?.role;
      return ["user", "assistant", "system", "tool"].includes(role) ? role : "unknown";
    }

    function recordId(record) {
      return record?.id || record?.message?.id || null;
    }

    function findMessageRecord(element, domId) {
      const currentMessageNumbers = readMessageNumbers();
      return walkFiber(element, (props) => {
        // 新原生会话块：消息 ID、类型、会话归属必须来自同一个展示项。
        // 不能借用祖先的其他消息，更不能从正文或当前时钟猜日期。
        const item = props.item;
        if (element.getAttribute("data-chatgpt-search-message-ids") && domId
          && item?.messageId === domId && ["user-message", "assistant-message"].includes(item.type)
          && typeof props.conversationId === "string" && props.conversationId) {
          const role = item.type === "user-message" ? "user" : "assistant";
          const canonical = currentMessageNumbers?.conversationId === props.conversationId
            ? currentMessageNumbers.records?.[domId] : null;
          if (canonical && canonical.author.role !== role) return null;
          const nativeTime = typeof item.sentAtMs === "number" && Number.isFinite(item.sentAtMs) ? new Date(item.sentAtMs) : null;
          const hasNativeTime = nativeTime && Number.isFinite(nativeTime.getTime());
          const timestamp = hasNativeTime ? nativeTime.toISOString() : canonical?.create_time ?? null;
          return { id: domId, conversation_id: props.conversationId, author: { role }, create_time: timestamp,
            status: item.completed === false ? "in_progress" : canonical?.status || "finished_successfully",
            timestampSource: hasNativeTime ? "react-fiber.message-item" : "chatgpt-api.canonical-active-branch" };
        }
        const direct = props.message || props.calpicoMessage;
        if (direct && typeof direct === "object" && (!domId || recordId(direct) === domId)) return direct;
        if (Array.isArray(props.messages)) {
          const exact = props.messages.find((candidate) => recordId(candidate) === domId);
          if (exact) return exact;
          if (!domId && props.messages.length === 1) return props.messages[0];
        }
        return null;
      });
    }

    function roleFromDom(element) {
      const roleElement = element.matches?.("[data-message-author-role]")
        ? element
        : element.querySelector?.("[data-message-author-role]");
      const role = roleElement?.getAttribute("data-message-author-role");
      return ["user", "assistant", "system", "tool"].includes(role) ? role : null;
    }

    function normalizeExcerpt(value) {
      if (typeof value !== "string") return null;
      const normalized = value.replace(/\s+/g, " ").trim();
      if (!normalized) return null;
      const limit = snapshotContract.MAX_MESSAGE_EXCERPT_LENGTH;
      return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1).trimEnd()}…`;
    }

    function contentPartText(part) {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return null;
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return null;
    }

    function readExcerpt(record, element) {
      const content = record?.content || record?.message?.content;
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      const fiberText = normalizeExcerpt(parts.map(contentPartText).filter(Boolean).join(" "));
      if (fiberText) {
        return { value: fiberText, source: "react-fiber.message.content", status: "available" };
      }

      // Semantic DOM is only a bounded fallback inside the ChatGPT Adapter. No
      // feature module is allowed to establish a second message-reading path.
      const contentRoot = messageDom.contentRoot(element);
      const domText = normalizeExcerpt(contentRoot?.innerText || contentRoot?.textContent || "");
      return {
        value: domText,
        source: domText ? "semantic-dom.message-content" : null,
        status: domText ? "partial" : "missing",
      };
    }

    function readMessages(identity, unnumbered, activity) {
      const currentMessageNumbers = readMessageNumbers();
      const seen = new Set();
      const messages = [];
      for (const element of messageDom.candidates()) {
        const domId = messageDom.id(element);
        if (!domId) continue;
        const record = findMessageRecord(element, domId);
        if (!bindingAdapter.messageMatchesIdentity(record, identity)) continue;
        // 只报告已绑定会话的原生进行中信号；思考外壳也可能先于正式正文出现。
        // false 仅表示未观察到进行中，不能作为全文已读齐的证明。
        if ((record?.status || record?.message?.status) === "in_progress") activity.responseInProgress = true;
        const fiberId = recordId(record);
        const messageId = domId || fiberId;
        if (!messageId || seen.has(messageId)) continue;
        seen.add(messageId);

        const timestamp = toIso(record?.create_time ?? record?.createdAt ?? record?.message?.create_time);
        const stableId = bindingAdapter.stableMessageId(domId, fiberId);
        const recordRole = normalizeRole(record);
        // A ChatGPT thinking/generating shell can temporarily own a DOM
        // data-message-id without a complete canonical message record. Only an
        // exact Fiber record with author role and timestamp is a formal message.
        // Normal streaming messages remain eligible because ChatGPT assigns
        // those canonical fields before the response has finished rendering.
        const hasExactRecord = Boolean(
          stableId === messageId &&
          fiberId === messageId &&
          recordRole !== "unknown",
        );
        if (!hasExactRecord) continue;
        const displayNumber = currentMessageNumbers?.conversationId === identity.conversationId
          ? currentMessageNumbers.numbers[messageId] ?? null : null;
        if (displayNumber == null || !timestamp) unnumbered.push({ id: messageId, status: record.status || record.message?.status || "unknown" });
        if (!timestamp) continue;
        messages.push({
          messageId,
          idSource: `dom.${messageDom.locator(element).strategy}`,
          idStatus: stableId === messageId ? "stable" : "provisional",
          presentationStatus: "formal",
          role: roleFromDom(element) || recordRole,
          timestamp: {
            value: timestamp,
            source: timestamp ? record.timestampSource || "react-fiber.message" : null,
            status: timestamp ? "available" : "missing",
          },
          order: {
            // Local position only: virtualization can restart it at zero. Never
            // promote this sorting index into a user-facing conversation number.
            index: messages.length,
            displayNumber,
            source: displayNumber == null ? null : "chatgpt-api.canonical-active-branch",
            stableIdentity: displayNumber != null,
          },
          excerpt: readExcerpt(record, element),
          locator: messageDom.locator(element),
        });
      }
      return messages;
    }

    function routeStillOwnsConversation(conversationId) {
      const liveRouteId = routeAdapter.parse().conversationId;
      return liveRouteId === conversationId || draftIdMap.get(liveRouteId) === conversationId;
    }

    return Object.freeze({ findThreadConversation, resolveRouteIdentity, findConversationMeta,
      findCurrentPageMeta, hasCurrentPageIdentityEvidence, currentConversationMeta, readMessages,
      readConversationFields, readSidebarConversations, routeStillOwnsConversation,
      findMessageRecord, walkFiber, recordId, normalizeRole, dispose: () => draftIdMap.clear() });
  }
  global.TidyChatgptNativeSnapshotReader = Object.freeze({ create });
})(globalThis);

// Source: src/platform/chatgpt/snapshot-metadata.js
// 当前会话元数据投影唯一所有者：有界缓存、单次scope请求与轻量编号；不保存正文。
(function initTidyChatgptSnapshotMetadata(global) {
  "use strict";
  if (global.TidyChatgptSnapshotMetadata) return;
  function create({ routeStillOwnsConversation, onChanged }) {
    const routeAdapter = global.TidyChatgptRoute;
    const bindingAdapter = global.TidyChatgptBinding;
    const session = global.TidyPageSession;
    const document = global.document;
    const currentMetadataCache = new Map();
    const currentMetadataRequests = new Map();
    let currentMetadataScope = { key: null, workspace: null, failed: false, numberAttempts: new Set() };
    let currentMessageNumbers = null;
    let disposed = false;
    // 产品参数：只保留 8 个会话的 30 秒日期投影；失败不靠 DOM 变化重试。
    const CURRENT_METADATA_SUCCESS_TTL_MS = 30 * 1000;
    const MAX_CURRENT_METADATA_CACHE_ENTRIES = 8;
    function cachedCurrentConversationMeta(conversationId) {
      const cached = currentMetadataCache.get(conversationId);
      if (!cached || cached.expiresAt <= Date.now()) {
        currentMetadataCache.delete(conversationId);
        return null;
      }
      if (cached.meta?.messageNumbers) {
        currentMessageNumbers = { conversationId, numbers: cached.meta.messageNumbers, records: cached.meta.messageRecords };
      }
      return cached.meta;
    }

    function cacheCurrentConversationMeta(conversationId, meta, ttl) {
      currentMetadataCache.delete(conversationId);
      currentMetadataCache.set(conversationId, { meta, expiresAt: Date.now() + ttl });
      while (currentMetadataCache.size > MAX_CURRENT_METADATA_CACHE_ENTRIES) {
        currentMetadataCache.delete(currentMetadataCache.keys().next().value);
      }
    }

    function payloadConversationId(payload) {
      return payload?.conversation_id || payload?.conversationId || payload?.id || null;
    }

    function syncCurrentMetadataScope(route) {
      // Page mutations and GET_SNAPSHOT are observations, not permission to retry
      // a failed optional read. A different route/workspace (or document reload)
      // creates a new attempt scope. Never use a cooldown/self-polling retry here.
      const workspace = String(document.cookie || "").split(";").map(part => part.trim())
        .find(part => part.startsWith("_account=")) || "";
      const key = JSON.stringify([route.kind, route.conversationId, route.projectId || null, workspace]);
      if (key !== currentMetadataScope.key) {
        if (workspace !== currentMetadataScope.workspace) currentMetadataCache.clear();
        currentMetadataScope = { key, workspace, failed: false, numberAttempts: new Set() };
        currentMessageNumbers = null;
      }
    }

    function ensureCurrentConversationMeta(identity, route, unnumbered = []) {
      if (disposed) return;
      const conversationId = identity?.conversationId;
      const scope = currentMetadataScope;
      // Re-read on a new canonical message or its completion, not each streaming
      // token/DOM mutation. Virtualizing already-known history needs no request.
      const numberKeys = unnumbered.map(item => JSON.stringify([item.id, item.status]));
      const needsNumbers = numberKeys.some(key => !scope.numberAttempts.has(key));
      if (
        !conversationId ||
        identity.bindingStatus !== bindingAdapter.BindingStatus.BOUND ||
        !["conversation", "project-conversation"].includes(route.kind) ||
        routeAdapter.isDraftId(conversationId) ||
        currentMetadataRequests.has(conversationId) ||
        (currentMetadataCache.has(conversationId) && !needsNumbers) ||
        (scope.metadataOnlyFailed && !needsNumbers) ||
        scope.failed ||
        typeof global.fetch !== "function"
      ) return;
      for (const key of numberKeys) scope.numberAttempts.add(key);

      const request = Promise.resolve().then(() => global.TidyChatgptApi.fetchAuthenticated(
        `/backend-api/conversation/${global.encodeURIComponent(conversationId)}`,
        { headers: { Accept: "application/json" } },
      )).then(async (response) => {
        session.assertActive();
        if (!response.ok) throw new Error(`Current conversation metadata request failed (${response.status})`);
        const payload = await response.json();
        session.assertActive();
        const responseConversationId = payloadConversationId(payload);
        // ChatGPT's current-conversation response is addressed by the canonical
        // conversation ID in the request URL, but some live response shapes omit
        // that ID from the JSON body. An explicit body ID is extra evidence and
        // must match; when absent, the exact requested URL plus an unchanged
        // route is the identity proof. Never accept a conflicting body ID.
        if (responseConversationId && responseConversationId !== conversationId) {
          throw new Error("Current conversation metadata identity mismatch");
        }
        syncCurrentMetadataScope(routeAdapter.parse());
        if (scope !== currentMetadataScope || !routeStillOwnsConversation(conversationId)) return;
        if (payload.mapping && (payload.current_node || payload.currentNode)) {
          // Numbering and dates are independent projections of the SAME read.
          // A broken branch must not remove otherwise valid conversation dates.
          try {
            currentMessageNumbers = { conversationId, numbers: global.TidyChatgptConversationProjection.messageNumbersFromPayload(payload, conversationId) };
            // 新版原生展示项可能省略时间。复用编号已有的同一次读取，只留
            // 当前分支的 ID/角色/时间，不缓存正文，也不另建请求或轮询链路。
            const records = Object.create(null);
            for (const node of Object.values(payload.mapping)) {
              const message = node?.message;
              if (!message?.id || !Object.hasOwn(currentMessageNumbers.numbers, message.id)) continue;
              records[message.id] = { id: message.id, conversation_id: conversationId,
                author: { role: message.author?.role }, create_time: message.create_time, status: message.status };
            }
            currentMessageNumbers.records = records;
          } catch { /* No fabricated number for an incomplete canonical branch. */ }
        }
        const value = {
          id: conversationId,
          title: typeof payload.title === "string" ? payload.title : null,
          create_time: payload.create_time ?? null,
          update_time: payload.update_time ?? null,
        };
        // A range is atomic for the current-conversation fallback. Caching only
        // one endpoint would make the UI look authoritative while still unable
        // to render the requested create/update range.
        const hasCanonicalRange = value.create_time != null && value.update_time != null;
        if (!hasCanonicalRange) {
          // A valid message sequence does not invent missing conversation dates.
          // Publish the numbers independently and stop this one metadata attempt.
          if (!currentMessageNumbers) throw new Error("Current conversation response omitted canonical range");
          scope.metadataOnlyFailed = true;
          onChanged("current-conversation-numbers", 0);
          return;
        }
        cacheCurrentConversationMeta(
          conversationId,
          {
            kind: "conversation",
            value,
            link: null,
            boundId: conversationId,
            source: "chatgpt-api.current-conversation-metadata",
            messageNumbers: currentMessageNumbers?.numbers || null,
            messageRecords: currentMessageNumbers?.records || null,
          },
          CURRENT_METADATA_SUCCESS_TTL_MS,
        );
        // Publish only after accepted canonical data changes the snapshot.
        onChanged("current-conversation-metadata", 0);
      }).catch(() => {
        // All failed optional reads stop this scope, including 429 and explicit
        // can_retry:false. Clearing pending alone would refetch on every DOM event.
        // An old response can only mark its own, possibly retired, scope.
        scope.failed = true;
      }).finally(() => {
        currentMetadataRequests.delete(conversationId);
      });
      currentMetadataRequests.set(conversationId, request);
    }


    function dispose() {
      disposed = true;
      currentMetadataCache.clear();
      currentMetadataRequests.clear();
      currentMetadataScope = { key: null, workspace: null, failed: true, numberAttempts: new Set() };
      currentMessageNumbers = null;
    }
    return Object.freeze({ syncScope: syncCurrentMetadataScope, cached: cachedCurrentConversationMeta,
      ensure: ensureCurrentConversationMeta, messageNumbers: () => currentMessageNumbers, dispose });
  }
  global.TidyChatgptSnapshotMetadata = Object.freeze({ create });
})(globalThis);

// Source: src/platform/chatgpt/snapshot-projection.js
// 快照装配：原生证据、可选缓存和标题展示投影在这里合成；不拥有缓存或定时器。
(function initTidyChatgptSnapshotProjection(global) {
  "use strict";
  if (global.TidyChatgptSnapshotProjection) return;
  function create({ reader, metadata, titleProjection = null }) {
    const snapshotContract = global.TidySnapshot;
    const routeAdapter = global.TidyChatgptRoute;
    const bindingAdapter = global.TidyChatgptBinding;
    const session = global.TidyPageSession;
    const titleSync = titleProjection;
    const { readAppearance } = global.TidyChatgptNativeAppearance;
    const { findThreadConversation, resolveRouteIdentity, findConversationMeta, findCurrentPageMeta,
      hasCurrentPageIdentityEvidence, currentConversationMeta, readMessages, readConversationFields,
      readSidebarConversations } = reader;
    const { syncScope: syncCurrentMetadataScope, cached: cachedCurrentConversationMeta,
      ensure: ensureCurrentConversationMeta } = metadata;
    function buildSnapshot({ nativeTitles = false, titleOwnerOnly = false } = {}) {
      session.assertActive();
      if (!nativeTitles) titleSync?.refresh();
      const route = routeAdapter.parse();
      syncCurrentMetadataScope(route);
      const threadConversation = findThreadConversation();
      let identity = resolveRouteIdentity(route, threadConversation);
      const sidebarMeta = findConversationMeta(identity);
      const pageMeta = findCurrentPageMeta(identity);
      const cachedMeta = identity.conversationId
        ? cachedCurrentConversationMeta(identity.conversationId)
        : null;
      const currentMessageNumbers = metadata.messageNumbers();
      const pageIdentityBound = hasCurrentPageIdentityEvidence(identity);
      identity = bindingAdapter.withExactMetadata(
        identity,
        Boolean(sidebarMeta || pageMeta || cachedMeta || pageIdentityBound),
      );

      // Mismatch/route-only snapshots expose route identity only. Canonical
      // conversation fields and messages remain empty until binding is proven.
      // In narrow layouts a matching current-page message record is valid exact
      // identity evidence even though the native sidebar row is not mounted.
      const boundMeta = identity.bindingStatus === bindingAdapter.BindingStatus.BOUND
        ? currentConversationMeta(
            identity,
            sidebarMeta,
            pageMeta,
            cachedMeta,
            threadConversation,
          )
        : null;
      const unnumbered = [];
      const activity = { responseInProgress: false };
      const messages = titleOwnerOnly ? [] : readMessages(identity, unnumbered, activity);
      if (
        !titleOwnerOnly && identity.bindingStatus === bindingAdapter.BindingStatus.BOUND &&
        (boundMeta?.value?.create_time == null || boundMeta?.value?.update_time == null || !currentMessageNumbers || unnumbered.length)
      ) {
        ensureCurrentConversationMeta(identity, route, unnumbered);
      }
      // Title ownership needs the exact SAME route/Fiber/metadata binding proof
      // above, not thousands of message excerpts or unrelated sidebar DTOs. Its
      // own authenticated adapter reads dates; do not launch another background
      // metadata fetch just to establish the owner of that imminent request.
      const nativeConversation = readConversationFields(route, identity, boundMeta);
      const conversation = !nativeTitles && titleSync?.project(nativeConversation) || nativeConversation;
      const sidebarConversations = titleOwnerOnly ? []
        : readSidebarConversations().map((item) => !nativeTitles && titleSync?.project(item) || item);
      const isConversationRoute = Boolean(route.conversationId);

      return {
        schemaVersion: snapshotContract.VERSION,
        capturedAt: new Date().toISOString(),
        appearance: readAppearance(),
        route: {
          href: route.href,
          pathname: route.pathname,
          kind: route.kind,
          source: "location",
          status: route.supported ? "available" : "unsupported",
        },
        conversation,
        sidebarConversations,
        messages,
        adapter: {
          responseInProgress: activity.responseInProgress,
          status: !route.supported
            ? "unsupported"
            : !isConversationRoute
              ? "empty"
              : identity.status === "stable" &&
                  identity.bindingStatus === bindingAdapter.BindingStatus.BOUND &&
                  messages.length
                ? "ready"
                : "partial",
          retryable:
            route.supported &&
            isConversationRoute &&
            (identity.bindingStatus !== bindingAdapter.BindingStatus.BOUND ||
              identity.status !== "stable" ||
              !messages.length ||
              !conversation.title.value),
          sources: ["location", "semantic-dom", "react-fiber"],
        },
      };
    }


    return Object.freeze({ read: buildSnapshot });
  }
  global.TidyChatgptSnapshotProjection = Object.freeze({ create });
})(globalThis);

// Source: src/platform/chatgpt/snapshot-publisher.js
// 快照发布唯一所有者：指纹去重、有界事件合并、最多六轮绑定重试；不读取原生证据。
(function initTidyChatgptSnapshotPublisher(global) {
  "use strict";
  if (global.TidyChatgptSnapshotPublisher) return;
  function create({ readSnapshot: buildSnapshot, postEnvelope }) {
    const protocol = global.TidyProtocol;
    const session = global.TidyPageSession;
    let lastFingerprint = "";
    let refreshTimer = null;
    let pendingRefresh = null;
    let retryTimer = null;
    let retryAttempt = 0;
    let disposed = false;
    function fingerprint(snapshot) {
      return JSON.stringify({
        path: snapshot.route.pathname,
        appearance: snapshot.appearance.colorScheme,
        surface: snapshot.appearance.surface.value,
        id: snapshot.conversation.conversationId,
        draft: snapshot.conversation.draftId,
        status: snapshot.conversation.identityStatus,
        binding: snapshot.conversation.bindingStatus,
        title: snapshot.conversation.title.value,
        project: snapshot.conversation.project?.projectId,
        created: snapshot.conversation.createdAt.value,
        updated: snapshot.conversation.updatedAt.value,
        responseInProgress: snapshot.adapter.responseInProgress,
        sidebar: snapshot.sidebarConversations.map((conversation) => [
          conversation.conversationId,
          conversation.bindingStatus,
          conversation.createdAt.value,
          conversation.updatedAt.value,
          conversation.locator.value,
        ]),
        messages: snapshot.messages.map((message) => [
          message.messageId,
          message.idStatus,
          message.presentationStatus,
          message.timestamp.value,
          message.order.displayNumber,
          message.excerpt.value,
        ]),
      });
    }

    function cancelRefresh() {
      clearTimeout(refreshTimer);
      refreshTimer = null;
      pendingRefresh = null;
    }

    function publishSnapshot(reason) {
      // 显式读取和绑定重试都会获取此刻的完整快照，已覆盖待发窗口，
      // 因此不应再留下一个重复读取，也不能让已排队的旧回调抢先发布。
      cancelRefresh();
      if (disposed || !session.check()) return;
      const snapshot = buildSnapshot();
      const nextFingerprint = fingerprint(snapshot);
      if (nextFingerprint !== lastFingerprint) {
        lastFingerprint = nextFingerprint;
        postEnvelope(protocol.event(protocol.Type.SNAPSHOT_UPDATED, { reason, snapshot }));
      }

      clearTimeout(retryTimer);
      if (snapshot.adapter.retryable && retryAttempt < 6) {
        const delay = Math.min(350 * 2 ** retryAttempt, 4_000);
        retryAttempt += 1;
        retryTimer = setTimeout(() => publishSnapshot("bounded-retry"), delay);
      } else if (!snapshot.adapter.retryable) {
        retryAttempt = 0;
      }
    }

    function scheduleRefresh(reason, delay = 120) {
      if (disposed || !session.check()) return;
      // A cheap cookie comparison detects workspace changes without turning
      // ordinary DOM updates or SPA navigation into authentication requests.
      global.TidyChatgptApi.checkLibraryIdentity();
      // 产品参数：普通 DOM 变化在首个事件后最多等 120ms，而不是每次
      // 变化都重新等 120ms；持续输出不能饿死“正在回复”状态通知。
      // 0/30ms 的元数据、路由等请求可提前发布，但任何后来事件都不能
      // 后推已有期限。reason 记录决定该期限的请求，快照读取全部最新状态。
      const deadline = Date.now() + delay;
      if (pendingRefresh && pendingRefresh.deadline <= deadline) return;
      cancelRefresh();
      const request = { reason, deadline };
      pendingRefresh = request;
      refreshTimer = setTimeout(() => {
        if (pendingRefresh !== request) return;
        publishSnapshot(request.reason);
      }, delay);
    }


    function dispose() {
      disposed = true;
      cancelRefresh(); clearTimeout(retryTimer);
      retryTimer = null; lastFingerprint = "";
    }
    return Object.freeze({ publish: publishSnapshot, schedule: scheduleRefresh,
      resetRetry: () => { retryAttempt = 0; }, dispose });
  }
  global.TidyChatgptSnapshotPublisher = Object.freeze({ create });
})(globalThis);

// Source: src/platform/chatgpt/page-navigation-runtime.js
// 页面导航装配与精确目标证明：共用只读证据，不扫描完整快照，不放宽worker凭证。
(function initTidyChatgptPageNavigationRuntime(global) {
  "use strict";
  if (global.TidyChatgptPageNavigationRuntime) return;
  function create({ reader, postEnvelope }) {
    const protocol = global.TidyProtocol;
    const session = global.TidyPageSession;
    const routeAdapter = global.TidyChatgptRoute;
    const bindingAdapter = global.TidyChatgptBinding;
    const messageDom = global.TidyChatgptMessageDom;
    const document = global.document;
    const { findMessageRecord, walkFiber, resolveRouteIdentity, recordId, normalizeRole } = reader;
    function locateMessage(payload) {
      session.assertActive();
      const control = payload?.navigationControl;
      if (typeof control?.ownerAccountKey !== "string" || !control.ownerAccountKey
        || control.navigationIntentId !== payload.navigationIntentId || control.conversationId !== payload.conversationId
        || control.phase !== "active" || pageNavigation?.observe(control)?.accepted !== true) {
        throw Object.assign(new Error("The message command was not admitted by its worker."), { tidyCode: protocol.ErrorCode.CONTEXT_MISMATCH });
      }
      assertNavigationOwner(control.ownerAccountKey);
      assertNavigationCurrent(payload);
      return messageNavigation.start(payload);
    }

    function assertNavigationOwner(accountKey) {
      const identity = global.TidyChatgptApi.checkLibraryIdentity();
      const state = global.TidyNavigationIdentity.state(identity, accountKey);
      if (state === "revoked") {
        throw Object.assign(new Error("The navigation owner changed."), { tidyCode: protocol.ErrorCode.CONTEXT_MISMATCH });
      }
      return state === "ready";
    }

    function usableNavigationElement(element) {
      if (element.isConnected !== true || !element.getClientRects().length) return false;
      for (let node = element; node; node = node.parentElement) {
        const style = global.getComputedStyle(node);
        if (node.hidden || node.getAttribute?.("aria-hidden") === "true" || node.hasAttribute?.("inert")
          || style.display === "none" || /^(hidden|collapse)$/.test(style.visibility)) return false;
      }
      return true;
    }

    // The native placeholder has a different ID from some messages in its turn.
    // Exact read-only Fiber evidence may authorize revealing it, NEVER a receipt.
    function resolveMessageLoadTarget(payload) {
      const route = routeAdapter.parse();
      if (!route.supported || route.conversationId !== payload.conversationId) return null;
      let target = null;
      for (const element of document.querySelectorAll("main [data-turn-id-container]")) {
        if (!usableNavigationElement(element) || element.closest('[data-tidy-owned]')) continue;
        const turnId = element.getAttribute("data-turn-id-container");
        if (!global.TidyChatgptVirtualMessageTarget?.read(element, turnId, payload.conversationId, payload.messageId)) continue;
        if (target) return null; // equally plausible live trees are not a target
        target = element;
      }
      return target ? { element: target } : null;
    }

    // Narrow target proof for bookmarks and latest-message navigation. Re-running the full
    // snapshot here would scan every mounted message on each landing sample.
    function resolveMessageTarget(payload) {
      const route = routeAdapter.parse();
      if (!route.supported || route.conversationId !== payload.conversationId) {
        return { element: null, reason: payload.waitForConversation ? "conversation-loading" : "conversation-mismatch" };
      }
      // Transition/virtualization trees can temporarily retain the same exact
      // message ID twice. Never choose the first hidden old tree just because its
      // Fiber record still matches; equally plausible live targets fail closed.
      const candidates = messageDom.targets(payload.messageId);
      if (!candidates.length) return { element: null, reason: "message-not-present" };
      let target = null;
      for (const element of candidates) {
        if (!usableNavigationElement(element)) continue;
        const record = findMessageRecord(element, payload.messageId);
        const thread = walkFiber(element, (props) => typeof props.conversation?.id === "string" ? props.conversation : null, 40);
        let identity = resolveRouteIdentity(route, thread);
        identity = bindingAdapter.withExactMetadata(identity,
          bindingAdapter.recordConversationId(record) === payload.conversationId);
        if (!bindingAdapter.messageMatchesIdentity(record, identity)
          || recordId(record) !== payload.messageId
          || bindingAdapter.stableMessageId(messageDom.id(element), recordId(record)) !== payload.messageId
          || !["user", "assistant"].includes(normalizeRole(record))) continue;
        if (target) return { element: null, reason: "message-not-bound" };
        target = element;
      }
      return { element: target, contentReady: target ? global.TidyChatgptMessageNavigation.hasRenderedContent(target, document) : false,
        reason: target ? null : "message-not-bound" };
    }

    function resolveLatestConversation(payload) {
      // 原生路由尚在切换时等待；真正离开目标由统一导航凭证撤销，不能滚动旧会话。
      if (routeAdapter.parse().conversationId !== payload.conversationId) return { reason: "conversation-loading" };
      const candidates = messageDom.candidates(document.querySelector("main") || document);
      for (const element of candidates.reverse()) {
        const messageId = messageDom.id(element);
        const resolved = resolveMessageTarget({ ...payload, messageId });
        if (resolved.element === element && resolved.contentReady) return resolved;
      }
      return { reason: "conversation-loading" };
    }

    const pageNavigation = global.TidyChatgptNavigationIntent?.create({
      readIdentity: () => global.TidyChatgptApi.checkLibraryIdentity(),
      parseRoute: () => routeAdapter.parse(),
      onRevoked: ({ navigationIntentId, reason, notify }) => {
        messageLocation?.cancelId(navigationIntentId, reason);
        messageNavigation?.cancelId(navigationIntentId, reason);
        if (notify) postEnvelope(protocol.event(protocol.Type.NAVIGATION_CANCELLED, { navigationIntentId, reason }));
      },
    });
    function assertNavigationCurrent(payload) {
      session.assertActive();
      if (!pageNavigation?.isCurrent(payload?.navigationIntentId)) throw Object.assign(new Error("The navigation was superseded."), {
        tidyCode: protocol.ErrorCode.CONTEXT_MISMATCH,
      });
    }
    const messageLocation = global.TidyChatgptMessageLocation?.create({
      resolveTarget: payload => payload.placement === "latest" ? resolveLatestConversation(payload) : resolveMessageTarget(payload),
      resolveLoadTarget: payload => payload.placement === "latest" ? null : resolveMessageLoadTarget(payload),
      assertCurrent: payload => { assertNavigationCurrent(payload);
        return pageNavigation.canPresent(payload.navigationIntentId); },
      onCancelled: (_payload, reason) => pageNavigation.cancel(reason),
    });
    const messageNavigation = global.TidyChatgptMessageNavigation?.create({
      resolveTarget: resolveMessageTarget,
      resolveLoadTarget: resolveMessageLoadTarget,
      isIntentCurrent: id => session.check() && pageNavigation?.isCurrent(id) === true,
      canPresent: id => session.check() && pageNavigation?.canPresent(id) === true,
      locate: payload => messageLocation.start(payload),
      cancelLocation: (id, reason) => messageLocation.cancelId(id, reason),
      onStatus: (result, target) => {
        if (target && !result.pending && pageNavigation.isCurrent(target.navigationIntentId)) {
          postEnvelope(protocol.event(protocol.Type.NAVIGATION_RESULT, {
            navigationIntentId: target.navigationIntentId, conversationId: target.conversationId,
            messageId: target.messageId, ...result,
          }));
        }
      },
    });
    const libraryNavigation = global.TidyChatgptLibraryNavigation?.create({
      // 无刷新入口与原生左栏的展开、加载范围无关；模块内部探测站点路由器。
      isIntentCurrent: id => session.check() && pageNavigation?.isCurrent(id) === true,
      revealLatest: target => {
        const payload = { ...target, placement: "latest" };
        void messageLocation.start(payload).then(result => {
          if (pageNavigation.isCurrent(target.navigationIntentId)) postEnvelope(protocol.event(protocol.Type.NAVIGATION_RESULT, {
            navigationIntentId: target.navigationIntentId, conversationId: target.conversationId, messageId: null,
            placement: "latest", pending: false, ...result,
          }));
        });
      },
    });


    function navigate(payload) {
      if (!libraryNavigation) throw Object.assign(new Error("The native library navigation adapter is unavailable."), {
        tidyCode: protocol.ErrorCode.ADAPTER_UNAVAILABLE,
      });
      assertNavigationCurrent(payload);
      return libraryNavigation.navigate(payload);
    }
    function hidden() {
      pageNavigation?.cancel("page-hidden"); messageLocation?.cancel("page-hidden"); messageNavigation?.clear("page-hidden");
    }
    function dispose() {
      pageNavigation?.cancel("extension-reloaded"); messageNavigation?.dispose(); messageLocation?.dispose();
    }
    return Object.freeze({ locateMessage, navigate, hidden, dispose,
      observe: payload => pageNavigation?.observe(payload) || { accepted: false },
      observeIdentity: identity => pageNavigation?.observeIdentity(identity),
      routeChanged: () => pageNavigation?.routeChanged() });
  }
  global.TidyChatgptPageNavigationRuntime = Object.freeze({ create });
})(globalThis);

// Source: src/app/page/request-router.js
// MAIN bridge 入站准入及请求分派：先同步验文档/source/origin/channel，再执行专属适配器。
(function initTidyPageRequestRouter(global) {
  "use strict";
  if (global.TidyPageRequestRouter) return;
  function create({ readSnapshot: buildSnapshot, publishSnapshot, postEnvelope, navigation,
    routeStillOwnsConversation, searchAdapter, dateIndexAdapter, exportAdapter, titleAdapter, titleProjection: titleSync }) {
    const protocol = global.TidyProtocol;
    const session = global.TidyPageSession;
    function assertSnapshotLibraryIdentity(expected) {
      const identity = global.TidyChatgptApi.checkLibraryIdentity();
      if (!expected || typeof expected.accountKey !== "string" || !expected.accountKey
        || !Number.isSafeInteger(expected.epoch) || expected.epoch < 0
        || identity.phase !== "ready" || identity.accountKey !== expected.accountKey || identity.epoch !== expected.epoch) {
        throw Object.assign(new Error("The snapshot no longer belongs to the expected library identity."), {
          tidyCode: protocol.ErrorCode.CONTEXT_MISMATCH,
        });
      }
    }

    function handleMessage(event) {
      if (!session.check()) return;
      if (event.source !== global || event.origin !== global.location.origin) return;
      const data = event.data;
      if (data?.channel !== protocol.WINDOW_CHANNEL || data?.source !== "chatgpt-isolated") return;
      const envelope = data.envelope;
      if (!protocol.isRequest(envelope)) return;
      try {
        if (envelope.type === protocol.Type.PAGE_SESSION_PROBE) {
          postEnvelope(protocol.response(envelope, { ready: true }));
        } else if (envelope.type === protocol.Type.GET_SNAPSHOT) {
          // This narrow projection is requested only by title preflight. Ordinary
          // snapshots, broadcasts, search and export retain their full payload.
          const titleOwnerOnly = envelope.payload?.scope === "title-owner";
          const libraryStamped = Object.prototype.hasOwnProperty.call(envelope.payload || {}, "expectedLibraryIdentity");
          if (libraryStamped) assertSnapshotLibraryIdentity(envelope.payload.expectedLibraryIdentity);
          const snapshot = buildSnapshot({ titleOwnerOnly, nativeTitles: titleOwnerOnly });
          if (libraryStamped) assertSnapshotLibraryIdentity(envelope.payload.expectedLibraryIdentity);
          postEnvelope(protocol.response(envelope, snapshot));
        } else if (envelope.type === protocol.Type.NAVIGATION_INTENT) {
          postEnvelope(protocol.response(envelope, navigation.observe(envelope.payload)));
        } else if (envelope.type === protocol.Type.LOCATE_MESSAGE) {
          const result = navigation.locateMessage(envelope.payload);
          postEnvelope(protocol.response(envelope, result));
        } else if (envelope.type === protocol.Type.SEARCH_MESSAGES) {
          searchAdapter.search(envelope.payload)
            .then((page) => postEnvelope(protocol.response(envelope, page)))
            .catch((error) => {
              postEnvelope(protocol.failure(
                envelope,
                protocol.ErrorCode.SEARCH_UNAVAILABLE,
                error?.name === "AbortError"
                  ? "The search request was superseded"
                  : "The official ChatGPT search interface is unavailable",
                { stage: "main-world.search-adapter" },
              ));
            });
        } else if (envelope.type === protocol.Type.LIBRARY_NAVIGATE) {
          Promise.resolve().then(() => {
            session.assertActive();
            return navigation.navigate(envelope.payload);
          }).then(result => postEnvelope(protocol.response(envelope, result)))
            .catch(error => postEnvelope(protocol.failure(envelope,
              error?.tidyCode || protocol.ErrorCode.CONTEXT_MISMATCH,
              "The saved conversation could not be opened in this page.")));
        } else if (envelope.type === protocol.Type.LIBRARY_ACCOUNT) {
          Promise.resolve().then(() => global.TidyChatgptApi.readLibraryAccount({ retry: envelope.payload?.retry === true }))
            .then(account => postEnvelope(protocol.response(envelope, account)))
            .catch(error => postEnvelope(protocol.failure(
              envelope, error?.tidyCode || "LIBRARY_ACCOUNT_UNAVAILABLE",
              "The signed-in library owner could not be verified.",
              { status: Number.isInteger(error?.status) ? error.status : null },
            )));
        } else if ([
          protocol.Type.DATE_INDEX_ACCOUNT,
          protocol.Type.DATE_INDEX_SOURCE_PAGE,
        ].includes(envelope.type)) {
          const operation = envelope.type === protocol.Type.DATE_INDEX_ACCOUNT
            ? dateIndexAdapter.account()
            : dateIndexAdapter.readSourcePage(envelope.payload);
          operation
            .then((payload) => postEnvelope(protocol.response(envelope, payload)))
            .catch((error) => postEnvelope(protocol.failure(
              envelope,
              protocol.ErrorCode.DATE_INDEX_UNAVAILABLE,
              error?.message || "The message date index could not be read",
              {
                stage: "main-world.date-index-adapter",
                code: error?.code || "SCHEMA",
                category: error?.category || "SCHEMA",
                status: error?.status ?? null,
                retryable: error?.retryable === true,
                serverCode: error?.serverCode || null,
              },
            )));
        } else if ([protocol.Type.TITLE_READ_CURRENT, protocol.Type.TITLE_WRITE_CURRENT,
          protocol.Type.TITLE_BATCH_EXECUTION_BEGIN, protocol.Type.TITLE_BATCH_EXECUTION_END].includes(envelope.type)) {
          const operation = {
            [protocol.Type.TITLE_READ_CURRENT]: "readCurrent",
            [protocol.Type.TITLE_WRITE_CURRENT]: "writeCurrent",
            [protocol.Type.TITLE_BATCH_EXECUTION_BEGIN]: "beginBatchExecution",
            [protocol.Type.TITLE_BATCH_EXECUTION_END]: "endBatchExecution",
          }[envelope.type];
          Promise.resolve().then(() => {
            session.assertActive();
            if (!titleAdapter) throw new Error("The title adapter is unavailable.");
            return titleAdapter[operation](envelope.payload);
          })
            .then((result) => {
              session.assertActive();
              // Accepted batch writes update only the exact confirmed title;
              // preflight timestamps must not masquerade as post-write metadata.
              // Unknown outcomes never project a title or trigger a refetch.
              const accepted = operation === "writeCurrent" && result.status === "accepted"
                && result.accepted?.conversationId === envelope.payload.conversationId
                && result.accepted.title === envelope.payload.after;
              const observed = accepted ? result.accepted
                : result.current && (operation === "readCurrent" || result.status === "verified") ? result.current : null;
              if (observed) {
                try {
                  const native = buildSnapshot({ nativeTitles: true, titleOwnerOnly: true }).conversation;
                  const synchronize = accepted ? titleSync?.acceptTitle : titleSync?.accept;
                  if (synchronize?.(observed, result.identity || envelope.payload.identity,
                    envelope.payload.before, native?.conversationId === observed.conversationId ? native : null,
                    { ownerContext: envelope.payload.ownerContext, targetProjectId: envelope.payload.targetProjectId })) {
                    publishSnapshot(accepted ? "title-accepted" : "title-readback");
                  }
                } catch { /* A presentation failure must not turn success into an unknown write. */ }
              }
              postEnvelope(protocol.response(envelope, result));
            })
            .catch((error) => postEnvelope(protocol.failure(
              envelope, error.tidyCode || protocol.ErrorCode.TITLE_UNAVAILABLE,
              "The title operation could not be completed.",
              { httpStatus: error.httpStatus || null },
            )));
        } else if (envelope.type === protocol.Type.EXPORT_CURRENT_CONVERSATION) {
          exportAdapter.readCurrentConversation(envelope.payload, {
            routeOwnsConversation: routeStillOwnsConversation,
          })
            .then((document) => postEnvelope(protocol.response(envelope, document)))
            .catch((error) => {
              postEnvelope(protocol.failure(
                envelope,
                error?.tidyCode === protocol.ErrorCode.EXPORT_RESPONSE_PENDING
                  ? protocol.ErrorCode.EXPORT_RESPONSE_PENDING : protocol.ErrorCode.EXPORT_UNAVAILABLE,
                error?.message || "The current conversation could not be exported",
                { stage: "main-world.export-adapter" },
              ));
            });
        } else if (envelope.type === protocol.Type.EXPORT_IMAGE_RESOURCE) {
          exportAdapter.readImageResource(envelope.payload)
            .then((resource) => postEnvelope(protocol.response(envelope, resource)))
            .catch(() => postEnvelope(protocol.failure(envelope, protocol.ErrorCode.EXPORT_UNAVAILABLE,
              "The export image is no longer available.")));
        } else if (envelope.type === protocol.Type.EXPORT_CONVERSATIONS) {
          exportAdapter.readConversations(envelope.payload)
            .then((collection) => postEnvelope(protocol.response(envelope, collection)))
            .catch((error) => {
              postEnvelope(protocol.failure(
                envelope,
                error?.tidyCode === protocol.ErrorCode.EXPORT_RESPONSE_PENDING
                  ? protocol.ErrorCode.EXPORT_RESPONSE_PENDING : protocol.ErrorCode.EXPORT_UNAVAILABLE,
                error?.message || "The selected conversations could not be exported",
                { stage: "main-world.export-batch-adapter" },
              ));
            });
        }
      } catch (error) {
        postEnvelope(protocol.failure(envelope, error?.tidyCode || protocol.ErrorCode.INTERNAL_ERROR, error.message));
      }
    }


    return Object.freeze({ handleMessage });
  }
  global.TidyPageRequestRouter = Object.freeze({ create });
})(globalThis);

// Source: src/platform/chatgpt/native-observer.js
// 原生观察生命周期唯一所有者：DOM、history、交互settle与监听解绑；BFCache只暂停导航。
(function initTidyChatgptNativeObserver(global) {
  "use strict";
  if (global.TidyChatgptNativeObserver) return;
  function create({ onRefresh: scheduleRefresh, onRoute, onHidden, onMessage }) {
    const session = global.TidyPageSession;
    const domOwnership = global.TidyDomOwnership;
    const document = global.document;
    const listeners = [];
    const historyHooks = [];
    const settleTimers = new Set();
    let observer = null;
    let appearanceObserver = null;
    let disposed = false;
    function listen(target, type, listener, options) {
      target.addEventListener(type, listener, options);
      listeners.push(() => target.removeEventListener(type, listener, options));
    }

    listen(global, "message", onMessage);
    const notifyRoute = () => {
      if (disposed || !session.check()) return;
      global.TidyChatgptApi.checkLibraryIdentity();
      onRoute();
      scheduleRefresh("spa-route", 30);
    };
    for (const method of ["pushState", "replaceState"]) {
      const original = global.history[method];
      const wrapped = function tidyHistoryMethod(...args) {
        const result = original.apply(this, args);
        if (!disposed && session.check()) queueMicrotask(notifyRoute);
        return result;
      };
      global.history[method] = wrapped;
      historyHooks.push({ method, original, wrapped });
    }
    listen(global, "popstate", notifyRoute);
    listen(global, "hashchange", notifyRoute);
    listen(global, "focus", () => { if (!disposed && session.check()) global.TidyChatgptApi.checkLibraryIdentity(); });
    listen(document, "visibilitychange", () => { if (!disposed && session.check()) global.TidyChatgptApi.checkLibraryIdentity(); });
    // BFCache is a reversible document pause, not retirement. Keep the location
    // controller's listeners installed so restored documents can navigate again.
    listen(global, "pagehide", onHidden);

    // Expanding a project is not necessarily an SPA navigation: ChatGPT may
    // reveal an already-mounted lazy subtree without changing the URL. Sample
    // immediately and once after the small open animation/data settle window.
    // This is interaction-bounded and replaces neither MutationObserver nor a
    // forbidden page-wide polling loop.
    listen(global, "click", (event) => {
      if (disposed || !session.check()) return;
      const target = event.target?.closest?.(
        'a[href$="/project"], a[href*="/g/g-p-"], [aria-expanded]',
      );
      if (!target) return;
      scheduleRefresh("project-interaction", 30);
      const timer = setTimeout(() => {
        settleTimers.delete(timer);
        if (disposed || !session.check()) return;
        scheduleRefresh("project-interaction-settled", 0);
      }, 420);
      settleTimers.add(timer);
    }, true);

    const startObserver = () => {
      if (disposed || !session.check()) return;
      observer = new global.MutationObserver((mutations) => {
        if (disposed || !session.check()) return;
        if (!domOwnership.areOnlyTidyOwnedMutations(mutations)) {
          scheduleRefresh("dom-mutation");
        }
      });
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["href", "data-message-id", "data-chatgpt-search-message-ids", "data-sidebar-item", "aria-expanded", "hidden", "aria-hidden"],
      });
      appearanceObserver = new global.MutationObserver((mutations) => {
        if (disposed || !session.check()) return;
        if (!domOwnership.areOnlyTidyOwnedMutations(mutations)) {
          scheduleRefresh("appearance-change", 30);
        }
      });
      appearanceObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme", "data-color-scheme"],
      });
      scheduleRefresh("initial", 0);
    };


    function dispose() {
      disposed = true;
      for (const timer of settleTimers) clearTimeout(timer);
      settleTimers.clear(); observer?.disconnect(); appearanceObserver?.disconnect();
      for (const remove of listeners) remove();
      for (const { method, original, wrapped } of historyHooks) {
        if (global.history[method] === wrapped) global.history[method] = original;
      }
    }
    if (document.documentElement) startObserver();
    else listen(document, "DOMContentLoaded", startObserver, { once: true });
    return Object.freeze({ dispose });
  }
  global.TidyChatgptNativeObserver = Object.freeze({ create });
})(globalThis);

// Source: src/app/page/main-world.js
// MAIN 组合根：只接线工厂、消息出口和文档生命周期；具体读取/请求/观察均有单一所有者。
(function initTidyChatgptMainWorld(global) {
  "use strict";
  const protocol = global.TidyProtocol;
  const session = global.TidyPageSession;
  const api = global.TidyChatgptApi;
  const titleProjection = global.TidyChatgptTitleSync;
  if (!protocol || !session || !api || !global.TidySnapshot || !global.TidyDomOwnership
    || !global.TidyChatgptRoute || !global.TidyChatgptBinding || !global.TidyChatgptMessageDom
    || !global.TidyChatgptNativeAppearance || !global.TidyChatgptConversationProjection
    || !global.TidyChatgptSearch || !global.TidyChatgptDateIndex
    || !global.TidyChatgptExport || !global.TidyChatgptNativeSnapshotReader
    || !global.TidyChatgptSnapshotMetadata || !global.TidyChatgptSnapshotProjection
    || !global.TidyChatgptSnapshotPublisher || !global.TidyChatgptPageNavigationRuntime
    || !global.TidyPageRequestRouter || !global.TidyChatgptNativeObserver
    || global.__tidyMainWorldStarted) return;
  global.__tidyMainWorldStarted = true;
  session.assertActive();
  global.document.documentElement.dataset.tidyMainWorld = "ready";

  function postEnvelope(envelope) {
    if (!session.check()) return;
    global.postMessage({ channel: protocol.WINDOW_CHANNEL, source: "chatgpt-main-world", envelope }, global.location.origin);
  }
  // 回调只在装配结束后执行；无需向模块泄露可写共享 state。
  const metadata = global.TidyChatgptSnapshotMetadata.create({
    routeStillOwnsConversation: id => reader.routeStillOwnsConversation(id),
    onChanged: (reason, delay) => publisher.schedule(reason, delay),
  });
  const reader = global.TidyChatgptNativeSnapshotReader.create({ readMessageNumbers: metadata.messageNumbers });
  const snapshot = global.TidyChatgptSnapshotProjection.create({ reader, metadata, titleProjection });
  const publisher = global.TidyChatgptSnapshotPublisher.create({ readSnapshot: snapshot.read, postEnvelope });
  const navigation = global.TidyChatgptPageNavigationRuntime.create({ reader, postEnvelope });
  const router = global.TidyPageRequestRouter.create({
    readSnapshot: snapshot.read, publishSnapshot: publisher.publish, postEnvelope, navigation,
    routeStillOwnsConversation: reader.routeStillOwnsConversation,
    searchAdapter: global.TidyChatgptSearch, dateIndexAdapter: global.TidyChatgptDateIndex,
    exportAdapter: global.TidyChatgptExport, titleAdapter: global.TidyChatgptTitles, titleProjection,
  });
  const unsubscribeIdentity = api.onLibraryIdentityChanged(identity => {
    if (!session.check()) return;
    navigation.observeIdentity(identity);
    postEnvelope(protocol.event(protocol.Type.LIBRARY_IDENTITY_CHANGED, identity));
  });
  const unsubscribeTitle = api.onTitleChanged(change => {
    postEnvelope(protocol.event(protocol.Type.TITLE_CHANGED, change));
  });
  const observer = global.TidyChatgptNativeObserver.create({
    onRefresh: publisher.schedule, onHidden: navigation.hidden, onMessage: router.handleMessage,
    onRoute: () => { navigation.routeChanged(); titleProjection?.refresh(); publisher.resetRetry(); },
  });
  session.onDispose(() => {
    // 先停触发器，再清理投影；已排队回调仍由同步 page-session 闸门拒绝。
    observer.dispose(); publisher.dispose(); unsubscribeIdentity(); unsubscribeTitle();
    navigation.dispose(); reader.dispose(); metadata.dispose();
    delete global.document.documentElement.dataset.tidyMainWorld;
  });
})(globalThis);
