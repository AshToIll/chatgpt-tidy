const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function fixture() {
  let constructions = 0, defaultZone = "UTC";
  const DateTimeFormat = new Proxy(Intl.DateTimeFormat, {
    construct(target, args) {
      constructions++;
      return Reflect.construct(target, args.length ? args : ["en-US", { timeZone: defaultZone }]);
    },
  });
  const intl = Object.create(Intl); intl.DateTimeFormat = DateTimeFormat;
  const context = vm.createContext({ Intl: intl, Date, navigator: { language: "en-US" } });
  for (const file of ["platform/time-format", "features/titles/model/title-dates"]) vm.runInContext(
    fs.readFileSync(path.join(__dirname, `../src/${file}.js`), "utf8"), context);
  return { ...context, count: () => constructions, zone: value => { defaultZone = value; } };
}

test("title loops reuse a bounded set of formatters instead of rebuilding Intl per row", () => {
  const h = fixture();
  const rules = { mode: "range", dateFormat: "iso", timeZone: "Asia/Singapore", locale: "en-US" };
  for (let index = 0; index < 1000; index++) {
    const row = { conversationId: `row-${index}`, title: `Title ${index}`,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z" };
    const plan = h.TidyTitleDates.plan(row, rules);
    assert.equal(plan.targetLayer, "2026-01-01\u2009~\u200901-03");
    assert.equal(h.TidyTimeFormat.formatRange(row.createdAt, row.updatedAt, { ...rules, precision: "date" }), plan.targetLayer);
  }
  assert.ok(h.count() <= 6, `constructed ${h.count()} DateTimeFormat instances`);
});

test("formatter reuse does not freeze implicit OS timezone or browser regional language", () => {
  const h = fixture();
  assert.equal(h.TidyTitleDates.normalizeRules({}).timeZone, "UTC");
  h.zone("Asia/Tokyo");
  h.navigator.language = "ja-JP";
  const next = h.TidyTitleDates.normalizeRules({});
  assert.equal(next.timeZone, "Asia/Tokyo");
  assert.equal(next.locale, "ja-JP");
  assert.equal(h.TidyTitleDates.normalizeRules({ timeZone: "UTC", locale: "en-US" }).timeZone, "UTC");
});

test("formatter keys keep timezone, locale and short/full year output isolated", () => {
  const h = fixture(), date = "2026-01-01T00:30:00Z";
  for (const timeZone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
    for (const locale of ["en-US", "ja-JP", "fa-IR"]) for (const includeYear of [true, false]) {
      const options = { timeZone, locale, includeYear, dateFormat: "locale" };
      const expected = new Intl.DateTimeFormat(locale, { timeZone, ...(includeYear ? { year: "numeric" } : {}),
        month: "2-digit", day: "2-digit" }).format(new Date(date));
      assert.equal(h.TidyTimeFormat.formatDate(date, options), expected);
    }
  }
});

test("formatter reuse is bounded rather than retaining every historical preference", () => {
  const h = fixture(), date = "2026-01-01T00:00:00Z";
  const format = locale => h.TidyTimeFormat.formatDate(date, { locale, timeZone: "UTC", dateFormat: "locale" });
  for (let index = 0; index < 40; index++) format(`en-US-x-case-${String(index).padStart(3, "0")}`);
  const before = h.count();
  format("en-US-x-case-000");
  assert.equal(h.count(), before + 1, "an evicted locale is reconstructed; cache capacity is finite");
});
