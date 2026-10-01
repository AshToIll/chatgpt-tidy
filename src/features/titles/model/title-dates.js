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
