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
