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
