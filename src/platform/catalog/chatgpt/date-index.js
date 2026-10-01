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
