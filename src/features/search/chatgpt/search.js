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
