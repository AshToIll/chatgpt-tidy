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
