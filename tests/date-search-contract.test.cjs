const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { installPageSession } = require("./helpers/page-session.cjs");

const root = path.resolve(__dirname, "..");

function loadClassic(files, globals = {}) {
  const context = vm.createContext({
    console, Date, Intl, URL, URLSearchParams, Headers, Math, Object, Array,
    String, Number, Boolean, JSON, Set, Map, Promise, encodeURIComponent,
    setTimeout, clearTimeout, AbortController, queueMicrotask,
    ...globals,
  });
  context.globalThis = context;
  installPageSession(context);
  if (context.TidyChatgptApi) {
    const apiStub = context.TidyChatgptApi;
    delete context.TidyChatgptApi;
    vm.runInContext(fs.readFileSync(path.join(root, "src/platform/chatgpt/api.js"), "utf8"), context);
    context.TidyChatgptApi = { ...context.TidyChatgptApi, ...apiStub };
  }
  for (const file of files) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  }
  return context;
}

test("date ranges use TIDY's time zone and an exclusive next-day boundary", () => {
  const { TidyDateSearch } = loadClassic(["src/platform/catalog/date-search.js"]);
  const utc = TidyDateSearch.dateRange({ startDate: "2026-03-08", endDate: "2026-03-08", timeZone: "UTC" });
  assert.equal(new Date(utc.startMs).toISOString(), "2026-03-08T00:00:00.000Z");
  assert.equal(new Date(utc.endMs).toISOString(), "2026-03-09T00:00:00.000Z");
  const newYork = TidyDateSearch.dateRange({ startDate: "2026-03-08", endDate: "2026-03-08", timeZone: "America/New_York" });
  assert.equal(new Date(newYork.startMs).toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal(new Date(newYork.endMs).toISOString(), "2026-03-09T04:00:00.000Z", "DST day is 23 hours");
  assert.throws(
    () => TidyDateSearch.dateRange({ startDate: "2026-03-09", endDate: "2026-03-08", timeZone: "UTC" }),
    /earlier/,
  );
});

function localDateTime(timestamp, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

test("midnight gaps begin at the first real instant and keep the preceding day's last hour", () => {
  const { TidyDateSearch } = loadClassic(["src/platform/catalog/date-search.js"]);
  for (const entry of [
    { timeZone: "Africa/Cairo", date: "2026-04-24", precedingDate: "2026-04-23",
      start: "2026-04-23T22:00:00.000Z", end: "2026-04-24T21:00:00.000Z" },
    { timeZone: "Asia/Beirut", date: "2026-03-29", precedingDate: "2026-03-28",
      start: "2026-03-28T22:00:00.000Z", end: "2026-03-29T21:00:00.000Z" },
  ]) {
    const range = TidyDateSearch.dateRange({ startDate: entry.date, endDate: entry.date, timeZone: entry.timeZone });
    const preceding = TidyDateSearch.dateRange({
      startDate: entry.precedingDate, endDate: entry.precedingDate, timeZone: entry.timeZone,
    });
    assert.equal(new Date(range.startMs).toISOString(), entry.start, entry.timeZone);
    assert.equal(new Date(range.endMs).toISOString(), entry.end, entry.timeZone);
    assert.equal(range.endMs - range.startMs, 23 * 3_600_000);
    assert.equal(preceding.endMs - preceding.startMs, 24 * 3_600_000);
    assert.equal(preceding.endMs, range.startMs, "adjacent days share exactly one exclusive boundary");
    assert.equal(localDateTime(range.startMs, entry.timeZone), `${entry.date} 01:00:00`);
    assert.equal(localDateTime(preceding.endMs - 1, entry.timeZone), `${entry.precedingDate} 23:59:59`);
  }
});

test("midnight folds use the first midnight and include both repeated hours", () => {
  const { TidyDateSearch } = loadClassic(["src/platform/catalog/date-search.js"]);
  const timeZone = "America/Havana";
  const range = TidyDateSearch.dateRange({ startDate: "2026-11-01", endDate: "2026-11-01", timeZone });
  const preceding = TidyDateSearch.dateRange({ startDate: "2026-10-31", endDate: "2026-10-31", timeZone });
  assert.equal(new Date(range.startMs).toISOString(), "2026-11-01T04:00:00.000Z");
  assert.equal(new Date(range.endMs).toISOString(), "2026-11-02T05:00:00.000Z");
  assert.equal(range.endMs - range.startMs, 25 * 3_600_000);
  assert.equal(preceding.endMs, range.startMs);
  assert.equal(localDateTime(range.startMs, timeZone), "2026-11-01 00:00:00");
  assert.equal(localDateTime(range.startMs + 3_600_000, timeZone), "2026-11-01 00:00:00");
  assert.equal(localDateTime(range.startMs - 1, timeZone), "2026-10-31 23:59:59");
});

test("ordinary DST folds and half-hour transitions keep their calendar-day lengths", () => {
  const { TidyDateSearch } = loadClassic(["src/platform/catalog/date-search.js"]);
  for (const entry of [
    { timeZone: "America/New_York", date: "2026-11-01", hours: 25,
      start: "2026-11-01T04:00:00.000Z", end: "2026-11-02T05:00:00.000Z" },
    { timeZone: "Australia/Lord_Howe", date: "2026-04-05", hours: 24.5,
      start: "2026-04-04T13:00:00.000Z", end: "2026-04-05T13:30:00.000Z" },
    { timeZone: "Australia/Lord_Howe", date: "2026-10-04", hours: 23.5,
      start: "2026-10-03T13:30:00.000Z", end: "2026-10-04T13:00:00.000Z" },
  ]) {
    const range = TidyDateSearch.dateRange({ startDate: entry.date, endDate: entry.date, timeZone: entry.timeZone });
    assert.equal(new Date(range.startMs).toISOString(), entry.start);
    assert.equal(new Date(range.endMs).toISOString(), entry.end);
    assert.equal(range.endMs - range.startMs, entry.hours * 3_600_000);
  }
});

test("date boundaries retain cross-year and leap-day rollover", () => {
  const { TidyDateSearch } = loadClassic(["src/platform/catalog/date-search.js"]);
  for (const entry of [
    { startDate: "2026-12-31", endDate: "2027-01-01", timeZone: "Asia/Singapore",
      start: "2026-12-30T16:00:00.000Z", end: "2027-01-01T16:00:00.000Z" },
    { startDate: "2024-02-29", endDate: "2024-02-29", timeZone: "UTC",
      start: "2024-02-29T00:00:00.000Z", end: "2024-03-01T00:00:00.000Z" },
    { startDate: "0100-01-01", endDate: "0100-01-01", timeZone: "UTC",
      start: "0100-01-01T00:00:00.000Z", end: "0100-01-02T00:00:00.000Z" },
    { startDate: "9999-12-31", endDate: "9999-12-31", timeZone: "UTC",
      start: "9999-12-31T00:00:00.000Z", end: "+010000-01-01T00:00:00.000Z" },
  ]) {
    const range = TidyDateSearch.dateRange(entry);
    assert.equal(new Date(range.startMs).toISOString(), entry.start);
    assert.equal(new Date(range.endMs).toISOString(), entry.end);
  }
});

test("whole skipped local days are valid empty intervals without admitting reversed calendar ranges", () => {
  const { TidyDateSearch } = loadClassic(["src/platform/catalog/date-search.js"]);
  for (const entry of [
    { timeZone: "Pacific/Apia", date: "2011-12-30", previous: "2011-12-29", next: "2011-12-31",
      boundary: "2011-12-30T10:00:00.000Z" },
    { timeZone: "Pacific/Kwajalein", date: "1993-08-21", previous: "1993-08-20", next: "1993-08-22",
      boundary: "1993-08-21T12:00:00.000Z" },
  ]) {
    const range = TidyDateSearch.dateRange({ startDate: entry.date, endDate: entry.date, timeZone: entry.timeZone });
    assert.equal(range.hasDate, true);
    assert.equal(range.startMs, range.endMs, entry.timeZone);
    assert.equal(new Date(range.startMs).toISOString(), entry.boundary);
    const previous = TidyDateSearch.dateRange({ startDate: entry.previous, endDate: entry.previous, timeZone: entry.timeZone });
    const next = TidyDateSearch.dateRange({ startDate: entry.next, endDate: entry.next, timeZone: entry.timeZone });
    assert.equal(previous.endMs, range.startMs);
    assert.equal(next.startMs, range.endMs);
    for (const [startDate, endDate] of [[entry.date, entry.previous], [entry.next, entry.date]]) {
      assert.throws(() => TidyDateSearch.dateRange({ startDate, endDate, timeZone: entry.timeZone }), /earlier/,
        "equal timestamps cannot disguise a reversed calendar range");
    }
  }
});

test("product dates span launch through today in the selected TIDY zone, including open ends", () => {
  const { TidyDateSearch: contract } = loadClassic(["src/platform/catalog/date-search.js"]);
  const now = Date.parse("2026-09-07T18:30:00Z");
  assert.equal(contract.MIN_SEARCH_DATE, "2022-11-30");
  assert.equal(contract.searchDateBounds("Asia/Singapore", now).maxDate, "2026-09-08");
  assert.equal(contract.searchDateBounds("America/New_York", now).maxDate, "2026-09-07");
  assert.equal(contract.searchDateBounds("Asia/Singapore", now).minDate, "2022-11-30");
  const all = contract.searchDateRange({ startDate: "2022-11-30", endDate: "2026-09-08", timeZone: "Asia/Singapore" }, now);
  assert.equal(all.hasDate, true);
  assert.equal(new Date(all.startMs).toISOString(), "2022-11-29T16:00:00.000Z");
  assert.equal(new Date(all.endMs).toISOString(), "2026-09-08T16:00:00.000Z");
  const startOnly = contract.searchDateRange({ startDate: "2022-11-30", timeZone: "Asia/Singapore" }, now);
  const endOnly = contract.searchDateRange({ endDate: "2026-09-08", timeZone: "Asia/Singapore" }, now);
  assert.equal(startOnly.endMs, all.endMs);
  assert.equal(endOnly.startMs, all.startMs);
  const empty = contract.searchDateRange({ timeZone: "Asia/Singapore" }, now);
  assert.equal(empty.hasDate, false);
  assert.equal(empty.startMs, all.startMs);
  assert.equal(empty.endMs, all.endMs);
  assert.equal(contract.searchDateRange({ startDate: "2026-09-07", timeZone: "America/New_York" }, now).endMs,
    Date.parse("2026-09-08T04:00:00Z"));
});

test("product contract rejects dates outside its bounds without restricting generic timezone conversion", () => {
  const { TidyDateSearch: contract } = loadClassic(["src/platform/catalog/date-search.js"]);
  const now = Date.parse("2026-09-08T12:00:00Z");
  for (const date of ["2022-11-29", "2026-09-09", "2011-12-30", "1993-08-21"]) {
    for (const field of ["startDate", "endDate"]) {
      assert.throws(() => contract.searchDateRange({ [field]: date, timeZone: "UTC" }, now),
        error => error.code === "SEARCH_DATE_OUT_OF_BOUNDS");
    }
  }
  for (const date of [123, {}, "2026-02-29", "not-a-date"]) {
    assert.throws(() => contract.searchDateRange({ startDate: date }, now), /invalid/);
  }
  assert.throws(() => contract.searchDateRange({ startDate: "2026-09-08", endDate: "2026-09-07" }, now), /earlier/);
  assert.throws(() => contract.searchDateBounds("Not/A_Zone", now), /time zone/i);
  assert.throws(() => contract.searchDateBounds("UTC", NaN), /invalid/);
});

test("date validation and open ends remain unchanged", () => {
  const { TidyDateSearch } = loadClassic(["src/platform/catalog/date-search.js"]);
  for (const date of ["2026-02-29", "2024-02-30", "2026-04-31", "2026-00-01", "2026-13-01",
    "2026-01-00", "2026-1-01", "not-a-date", "0000-01-01", "0099-12-31"]) {
    for (const field of ["startDate", "endDate"]) {
      assert.throws(() => TidyDateSearch.dateRange({ [field]: date }), /invalid/, `${field}: ${date}`);
    }
  }
  assert.throws(() => TidyDateSearch.dateRange({
    startDate: "2026-04-24", endDate: "2026-04-23", timeZone: "Africa/Cairo",
  }), /earlier/);
  assert.throws(() => TidyDateSearch.dateRange({ startDate: "2026-01-01", timeZone: "Not/A_Zone" }), /time zone/i);
  const empty = TidyDateSearch.dateRange({ startDate: " ", endDate: "" });
  assert.equal(empty.hasDate, false);
  assert.equal(empty.startMs, TidyDateSearch.MIN_TIME_MS);
  assert.equal(empty.endMs, TidyDateSearch.MAX_TIME_MS);
  const startOnly = TidyDateSearch.dateRange({ startDate: " 2026-04-24 ", timeZone: "Africa/Cairo" });
  assert.equal(startOnly.hasDate, true);
  assert.equal(new Date(startOnly.startMs).toISOString(), "2026-04-23T22:00:00.000Z");
  assert.equal(startOnly.endMs, TidyDateSearch.MAX_TIME_MS);
  const endOnly = TidyDateSearch.dateRange({ endDate: "2026-04-23", timeZone: "Africa/Cairo" });
  assert.equal(endOnly.startMs, TidyDateSearch.MIN_TIME_MS);
  assert.equal(endOnly.endMs, startOnly.startMs);
  const defaultZone = TidyDateSearch.dateRange({ startDate: "2026-01-01" });
  assert.equal(new Date(defaultZone.startMs).toISOString(), "2026-01-01T00:00:00.000Z");
});

test("one formatter is shared by both date boundaries and every gap probe", () => {
  let formatterCount = 0;
  const { TidyDateSearch } = loadClassic(["src/platform/catalog/date-search.js"], {
    Intl: { DateTimeFormat: function (...args) {
      formatterCount += 1;
      return new Intl.DateTimeFormat(...args);
    } },
  });
  TidyDateSearch.dateRange({ startDate: "2026-04-24", endDate: "2026-04-24", timeZone: "Africa/Cairo" });
  assert.equal(formatterCount, 1);
});

test("ChatGPT date adapter uses confirmed directory endpoints and authenticated GETs", async () => {
  const calls = [];
  const context = loadClassic([
    "src/platform/catalog/date-search.js",
    "src/platform/chatgpt/messages.js",
    "src/platform/catalog/chatgpt/date-index.js",
  ], {
    TidyChatgptApi: {
      loadSession: async () => ({ user: { id: "account-1" }, accessToken: "redacted" }),
      fetchAuthenticated: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ items: [], total: 0 }) };
      },
    },
  });
  assert.equal((await context.TidyChatgptDateIndex.account()).accountKey, "account-1");
  await context.TidyChatgptDateIndex.readSourcePage({ source: "ordinary", cursor: null });
  await context.TidyChatgptDateIndex.readSourcePage({ source: "archived", cursor: "30" });
  assert.equal(calls[0].url, "/backend-api/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false&hide_snorlax=true");
  assert.equal(calls[1].url, "/backend-api/conversations?offset=30&limit=30&order=updated&is_archived=true");
  for (const call of calls) {
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.headers.Accept, "application/json");
    assert.ok(call.options.signal instanceof AbortSignal);
  }
});

test("conversation catalog notices expose failures without message-scanner UI", () => {
  const panel = fs.readFileSync(path.join(root, "src/app/sidepanel/panel.js"), "utf8");
  const view = fs.readFileSync(path.join(root, "src/features/search/ui/search-view.js"), "utf8");
  const presentation = fs.readFileSync(path.join(root, "src/features/search/ui/search-presentation.js"), "utf8");
  const i18n = fs.readFileSync(path.join(root, "src/messages/i18n.js"), "utf8");
  assert.doesNotMatch(panel, /date-search-service\.js|enrichKeywordPage/);
  assert.doesNotMatch(view, /searchDateScanning|searchDateCandidateCount|searchDateRequestCount/);
  assert.doesNotMatch(presentation, /searchDateScanning|searchDateCandidateCount|searchDateRequestCount/);
  assert.match(presentation, /function makeDateError\(\)/);
  assert.match(presentation, /searchReadErrors/);
  assert.match(i18n, /searchDateReadFailed/);
  assert.doesNotMatch(i18n, /searchDirectory|已读取.*会话/);
});

test("retired message-date main branches are absent, not compatibility aliases", () => {
  for (const file of ["src/sidepanel/date-search-service.js", "src/sidepanel/date-progressive-scan.js",
    "src/sidepanel/date-prefilter.js", "src/storage/message-time-index.js"]) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
  const context = loadClassic(["src/platform/catalog/date-search.js", "src/platform/chatgpt/messages.js",
    "src/platform/catalog/chatgpt/date-index.js"], { TidyChatgptApi: {} });
  const adapter = context.TidyChatgptDateIndex;
  assert.equal(adapter.readConversationPage, undefined);
  assert.equal(adapter.normalizeConversationPage, undefined);
  assert.equal(typeof adapter.readSourcePage, "function");
  assert.equal(typeof context.TidyChatgptMessages.readJson, "function", "catalog retains shared authenticated directory GETs");
  assert.equal(context.TidyChatgptMessages.readPage, undefined, "retired history paging has no remaining entrypoint");
  const source = fs.readFileSync(path.join(root, "src/platform/catalog/chatgpt/date-index.js"), "utf8");
  assert.doesNotMatch(source, /messageReader\.(readPage|visibleMessage)/);
});

test("search entry names avoid global-coverage promises in every locale and static HTML", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, "src/messages/i18n.js"), "utf8")
    .replace(/^export /gm, "") + "\nthis.strings = STRINGS;", context);
  const values = Object.values(context.strings);
  assert.ok(values.some(dictionary => dictionary.globalSearch === "搜索"
    && dictionary.searchSubtitle === "关键词与会话搜索"));
  for (const dictionary of values) {
    assert.doesNotMatch(dictionary.globalSearch, /全局|Global|グローバル/i);
    assert.equal(dictionary.searchDateNewestFirst, undefined);
    assert.equal(dictionary.searchDateOldestFirst, undefined);
  }
  const html = fs.readFileSync(path.join(root, "src/app/sidepanel/index.html"), "utf8");
  assert.match(html, /id="search-view"[^>]*aria-label="搜索"/);
  assert.match(html, /data-route="search" aria-label="搜索"/);
});
