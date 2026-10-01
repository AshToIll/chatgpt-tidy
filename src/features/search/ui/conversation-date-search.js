import { createConversationCatalogReader } from "../../../platform/catalog/ui/conversation-catalog-reader.js";

const contract = globalThis.TidyDateSearch;
const schemaError = (message) => Object.assign(new TypeError(message), {
  code: "SCHEMA", category: "SCHEMA", retryable: false,
});

function normalizeCriteria(value) {
  if (!Number.isFinite(value.startMs) || !Number.isFinite(value.endMs) || value.startMs > value.endMs
    || !["createdAt", "updatedAt"].includes(value.dateField)) throw schemaError("Invalid conversation date criteria");
  const direction = value.direction ?? "desc";
  const sortField = value.sortField ?? "createdAt";
  const limit = value.limit ?? 8;
  if (!["createdAt", "updatedAt"].includes(sortField)
    || !["asc", "desc"].includes(direction) || !Number.isInteger(limit) || limit <= 0) {
    throw schemaError("Invalid conversation date pagination");
  }
  return { ...value, sortField, direction, limit };
}

function resultPage(snapshot, criteria, status) {
  const { dateField, sortField, startMs, endMs, direction, limit } = criteria;
  const revision = snapshot.state?.revision || 0;
  const identity = { dateField, sortField, startMs, endMs, direction, revision };
  let offset = 0;
  if (criteria.cursor != null) {
    let cursor;
    try {
      if (!criteria.cursor.startsWith("catalog:")) throw new Error();
      cursor = JSON.parse(decodeURIComponent(criteria.cursor.slice(8)));
    } catch (_) { throw schemaError("Invalid conversation catalog cursor"); }
    if (!Number.isInteger(cursor.offset) || cursor.offset < 0
      || Object.entries(identity).some(([key, value]) => cursor[key] !== value)) {
      throw Object.assign(new Error("Conversation catalog cursor belongs to a different snapshot"), {
        code: "CURSOR_STALE", category: "CURSOR_STALE", retryable: true,
      });
    }
    offset = cursor.offset;
  }
  const sorted = snapshot.rows.filter((row) => Number.isFinite(row[dateField])
    && row[dateField] >= startMs && row[dateField] < endMs)
    .sort((left, right) => {
      // Filtering and ordering are independent. A missing sort timestamp stays
      // at the end in either direction; it must not remove a valid date match.
      const leftKnown = Number.isFinite(left[sortField]);
      const rightKnown = Number.isFinite(right[sortField]);
      if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
      return (leftKnown ? (left[sortField] - right[sortField]) * (direction === "asc" ? 1 : -1) : 0)
        || (left.conversationId < right.conversationId ? -1 : left.conversationId > right.conversationId ? 1 : 0);
    });
  const items = sorted.slice(offset, offset + limit).map((row) => ({
    resultId: `conversation-date:${row.conversationId}`, source: "conversation",
    conversationId: row.conversationId, messageId: null, title: row.title, snippet: "",
    conversationCreatedAt: Number.isFinite(row.createdAt) ? new Date(row.createdAt).toISOString() : null,
    conversationUpdatedAt: Number.isFinite(row.updatedAt) ? new Date(row.updatedAt).toISOString() : null,
    matchKind: "conversation-date", dateField,
  }));
  const hasMore = offset + items.length < sorted.length;
  return {
    schemaVersion: "tidy.search.v1", query: "date", items, hasMore, total: sorted.length,
    catalogPhase: status.phase, catalogRevision: revision, resultStable: status.resultStable,
    cursor: hasMore ? `catalog:${encodeURIComponent(JSON.stringify({ ...identity, offset: offset + items.length }))}` : null,
    partialResults: status.coverageState !== "complete", coverageState: status.coverageState,
    coverageReasons: status.coverageReasons, readErrors: status.readErrors, sourceStatus: null,
  };
}

// Date criteria and result pagination belong here, not in the shared reader.
export function createConversationDateSearch(options) {
  const reader = createConversationCatalogReader(options);
  const project = (value) => value?.snapshot
    ? { ...resultPage(value.snapshot, value.criteria, value.status), accountKey: value.accountKey } : value;
  async function queryDate(value, options) {
    const criteria = normalizeCriteria(value);
    try {
      const { minDate, maxDate } = contract.searchDateBounds(criteria.timeZone, optionsNow());
      const bounds = contract.dateRange({ startDate: minDate, endDate: maxDate, timeZone: criteria.timeZone });
      if (criteria.startMs < bounds.startMs || criteria.startMs >= bounds.endMs || criteria.endMs > bounds.endMs) {
        throw new RangeError("Conversation dates are outside the supported range");
      }
    } catch { throw schemaError("Conversation dates are outside the supported range"); }
    return project(await reader.read({ ...criteria, empty: criteria.startMs === criteria.endMs }, options));
  }
  const optionsNow = options.now || (() => Date.now());
  return Object.freeze({ queryDate, pause: reader.pause, resume: async () => project(await reader.resume()),
    refreshCatalog: reader.refreshCatalog, status: reader.status, whenIdle: reader.whenIdle });
}
