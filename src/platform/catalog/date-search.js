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
