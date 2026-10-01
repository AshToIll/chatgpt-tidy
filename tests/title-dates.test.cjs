const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const modelSource = fs.readFileSync(path.join(__dirname, "../src/features/titles/model/title-dates.js"), "utf8");
const timeSource = fs.readFileSync(path.join(__dirname, "../src/platform/time-format.js"), "utf8");
function load({ language = "en-US" } = {}) {
  const context = vm.createContext({ Intl, Date, navigator: { language } });
  vm.runInContext(timeSource, context);
  vm.runInContext(modelSource, context);
  return context;
}
const model = load().TidyTitleDates;
const RULES = { mode: "created", dateFormat: "iso", timeZone: "UTC", locale: "en-US" };
const BASE = { conversationId: "test-conversation", title: "研究计划", createdAt: "2026-04-24T02:00:00Z", updatedAt: "2026-04-26T09:12:34Z" };
function plan(title = BASE.title, options = {}, rules = {}, metadata = {}) {
  return model.plan({ ...BASE, ...metadata, title }, { ...RULES, ...rules }, options);
}
function simple(value) { return JSON.parse(JSON.stringify(value)); }

test("normalizes rules and exports a browser/CommonJS pure API", () => {
  assert.deepEqual(simple(model.normalizeRules(RULES)), RULES);
  const normalized = model.normalizeRules({ mode: "updated", dateFormat: "bad", locale: "bad_%%", timeZone: "Moon/Base" });
  assert.equal(normalized.mode, "created");
  assert.equal(normalized.dateFormat, "locale");
  assert.equal(normalized.locale, "en-US");
  assert.doesNotThrow(() => new Intl.DateTimeFormat(normalized.locale, { timeZone: normalized.timeZone }));
  assert.equal(model.normalizeRules({ locale: "EN-us" }).locale, "en-US");
  assert.doesNotThrow(() => model.normalizeRules(null));
});

test("assign preserves exact source title and all body whitespace", () => {
  const title = "  研究  计划\n2025.1.2 内容  ";
  const result = plan(title);
  assert.equal(result.before, title);
  assert.equal(result.after, `2026-04-24｜${title}`);
  assert.equal(result.baseTitle, title);
  assert.equal(result.action, "add");
  assert.equal(result.canApply, true);
  assert.equal(result.hasDateHead, false);
  assert.equal(plan(result.after, { operation: "remove" }).after, title);
});

test("range uses updatedAt, not latest-message or current clock", () => {
  const result = plan(BASE.title, {}, { mode: "range" }, { lastMessageAt: "2026-09-08T12:00:00Z" });
  assert.equal(result.targetLayer, "2026-04-24\u2009~\u200904-26");
  assert.equal(result.after, "2026-04-24\u2009~\u200904-26｜研究计划");
});

test("range omits same-year endpoint year and keeps both years across years", () => {
  assert.equal(plan(BASE.title, {}, { mode: "range" }).targetLayer, "2026-04-24\u2009~\u200904-26");
  assert.equal(plan(BASE.title, {}, { mode: "range" }, { updatedAt: "2027-01-02T00:00:00Z" }).targetLayer, "2026-04-24\u2009~\u20092027-01-02");
});

test("range collapses same-day timestamps to one date", () => {
  const result = plan(BASE.title, {}, { mode: "range" }, { updatedAt: "2026-04-24T23:59:59Z" });
  assert.equal(result.targetLayer, "2026-04-24");
});

test("removed rangeStyle input cannot change normalized rules, output, or fingerprints", () => {
  const result = plan(BASE.title, {}, { mode: "range" });
  for (const rangeStyle of ["full", "smart", "nonsense"]) {
    const withExtraInput = plan(BASE.title, {}, { mode: "range", rangeStyle });
    assert.equal(Object.hasOwn(withExtraInput.rules, "rangeStyle"), false);
    assert.deepEqual(simple(withExtraInput.rules), simple(result.rules));
    assert.equal(withExtraInput.after, result.after);
    assert.equal(withExtraInput.ruleFingerprint, result.ruleFingerprint);
  }
});

test("dates use the selected global timezone, including day/year boundaries", () => {
  const metadata = { createdAt: "2026-01-01T01:00:00Z", updatedAt: "2026-01-01T23:00:00Z" };
  assert.equal(plan(BASE.title, {}, { mode: "range", timeZone: "America/Los_Angeles" }, metadata).targetLayer, "2025-12-31\u2009~\u20092026-01-01");
  assert.equal(plan(BASE.title, {}, { mode: "range", timeZone: "Asia/Tokyo" }, metadata).targetLayer, "2026-01-01\u2009~\u200901-02");
});

test("all explicit date formats share date-only range behavior", () => {
  for (const [dateFormat, expected] of Object.entries({ iso: "2026-04-24\u2009~\u200904-26", slash: "2026/04/24\u2009~\u200904/26", dot: "2026.04.24\u2009~\u200904.26", compact: "20260424\u2009~\u20090426" })) {
    const result = plan(BASE.title, {}, { dateFormat, mode: "range", precision: "second" });
    assert.equal(result.targetLayer, expected);
    assert.equal(plan(result.after, {}, { dateFormat, mode: "range" }).noOp, true);
  }
});

test("invalid/missing required metadata blocks assignment with a reason code", () => {
  for (const createdAt of [null, "", "not-a-date", "2026-02-30T00:00:00Z", 1777000000]) {
    const result = plan(BASE.title, {}, {}, { createdAt });
    assert.equal(result.canApply, false);
    assert.equal(result.after, result.before);
    assert.equal(result.reason, "missing_created_time");
  }
  assert.equal(plan(BASE.title, {}, { mode: "range" }, { updatedAt: null }).reason, "missing_updated_time");
  assert.equal(plan(BASE.title, {}, { mode: "range" }, { updatedAt: "2026-04-23T00:00:00Z" }).reason, "invalid_date_range");
  assert.equal(plan(BASE.title, {}, {}, { updatedAt: null }).canApply, true);
});

test("empty/whitespace-only source titles never become accidental new titles", () => {
  for (const title of ["", " \n\t", null]) {
    const result = plan(title);
    assert.equal(result.canApply, false);
    assert.equal(result.reason, "empty_title");
  }
});

test("body dates and year-only titles remain ordinary prose", () => {
  for (const title of ["参考项目2025.1.2拆分记录", "2026 年度总结", " 2026-04-23 是正文", "202604240 项目编号", "版本 20260424"]) {
    const result = plan(title);
    assert.equal(result.hasDateHead, false, title);
    assert.equal(result.after, `2026-04-24｜${title}`);
    assert.equal(plan(title, { operation: "remove" }).after, title);
  }
});

test("supported leading dates trigger a conflict independently of their delimiter", () => {
  for (const date of ["2025-01-02", "2025/1/2", "2025.1.2", "2025_01_02", "20250102", "2025年1月2日"]) {
    for (const delimiter of ["｜", " ", "-", "：", ""]) {
      const title = `${date}${delimiter}本周产品需求整理`;
      const result = plan(title);
      assert.equal(result.hasDateHead, true, title);
      assert.equal(result.needsDecision, true, title);
      assert.equal(result.selectedDecision, "skip");
      assert.equal(result.after, title);
      assert.equal(result.canApply, false);
      assert.equal(plan(title, { decision: "replace" }).after, "2026-04-24｜本周产品需求整理");
    }
  }
});

test("invalid Gregorian dates are not partially stripped", () => {
  for (const title of ["2025-02-29｜计划", "2026-13-01｜计划", "2026-04-31｜计划", "2026-04-240｜计划", "20260230计划"]) {
    assert.equal(plan(title).hasDateHead, false, title);
    assert.equal(plan(title, { operation: "remove" }).canApply, false, title);
  }
  assert.equal(plan("2024-02-29｜计划").hasDateHead, true);
});

test("all supported range separators and compact/short endpoints are peeled together", () => {
  const ranges = ["2026.04.24-04.26", "20260424-0426", "2026-04-24~04-26", "2026/04/24 至 2026/04/26", "2026年4月24日到4月26日"];
  for (const separator of ["~", "→", "至", "到", "-", "–", "—"]) ranges.push(`2026-04-24 ${separator} 2026-04-26`);
  for (const range of ranges) {
    const result = plan(`${range}｜正文 2025-01-01`, { operation: "remove" });
    assert.equal(result.after, "正文 2025-01-01", range);
    assert.equal(result.canApply, true, range);
    assert.equal(result.analysis.layers.length, 1, range);
  }
});

test("backward, ambiguous cross-year, or malformed ranges are not partially removed", () => {
  for (const range of ["2026-04-26~04-24", "2026-12-30~01-02", "2026-04-24~2026-02-30", "2026-04-24~99-99", "2026-04-24~04-266", "2026-04-24→未定"]) {
    const result = plan(`${range}｜正文`, { operation: "remove" });
    assert.equal(result.hasDateHead, false, range);
    assert.equal(result.canApply, false, range);
    assert.equal(result.after, `${range}｜正文`, range);
  }
  assert.equal(plan("2026-12-30~2027-01-02｜正文", { operation: "remove" }).after, "正文");
});

test("replacement collapses all continuous layers and preserves the remaining body", () => {
  const title = "2025-01-01｜2025.02.01 ~ 02.03 :  完整  正文 2024-01-01  ";
  const result = plan(title, { decision: "replace" });
  assert.equal(result.analysis.state, "multiple_heads");
  assert.equal(result.analysis.layers.length, 2);
  assert.equal(result.baseTitle, "  完整  正文 2024-01-01  ");
  assert.equal(result.after, "2026-04-24｜  完整  正文 2024-01-01  ");
});

test("an exact outer head is a no-op even when deliberately stacked", () => {
  const before = "2025-01-01｜原  标题 ";
  const stacked = plan(before, { decision: "stack" });
  assert.equal(stacked.action, "stack");
  assert.equal(stacked.after, `2026-04-24｜${before}`);
  for (const decision of [undefined, "stack", "replace"]) {
    const next = plan(stacked.after, { decision });
    assert.equal(next.after, stacked.after);
    assert.equal(next.noOp, true);
    assert.equal(next.canApply, false);
    assert.equal(next.needsDecision, false);
  }
});

test("identical heads never normalize someone else's existing presentation", () => {
  for (const title of ["2026-04-24正文", "2026-04-24 :  正文  ", "2026-04-24｜正文", "2026-04-24"]) {
    const result = plan(title);
    assert.equal(result.after, title);
    assert.equal(result.action, "noop");
    assert.equal(result.canApply, false);
  }
});

test("a different spelling is a previewed conflict, not a silent rewrite", () => {
  const result = plan("2026/04/24｜标题");
  assert.equal(result.action, "skip");
  assert.equal(result.reason, "date_conflict");
  assert.equal(result.noOp, false);
  assert.equal(result.decisionResolved, false);
  assert.deepEqual(simple(result.choices.map((choice) => choice.id)), ["skip", "replace", "stack"]);
  assert.equal(plan(result.before, { decision: "unsupported" }).selectedDecision, "skip");
});

test("date-only titles may be replaced/stacked, but removal cannot empty them", () => {
  for (const title of ["2025-01-01", "2025-01-01｜", "2025-01-01｜   ", "2025-01-01｜2025-01-02"]) {
    const removal = plan(title, { operation: "remove" });
    assert.equal(removal.canApply, false, title);
    assert.equal(removal.wouldEmpty, true, title);
    assert.equal(removal.reason, "would_empty_title");
    assert.equal(plan(title, { decision: "replace" }).canApply, true, title);
    assert.equal(plan(title, { decision: "stack" }).canApply, true, title);
  }
});

test("removal does not need timestamp metadata and has an explicit absent-head no-op", () => {
  const removed = plan("2025-01-01｜正文", { operation: "remove" }, {}, { createdAt: null, updatedAt: null });
  assert.equal(removed.after, "正文");
  assert.equal(removed.canApply, true);
  const absent = plan("正文", { operation: "remove" });
  assert.equal(absent.noOp, true);
  assert.equal(absent.reason, "no_date_head");
  assert.equal(absent.wouldEmpty, false);
});

for (const locale of ["en-US", "en-GB", "de-DE", "zh-CN", "ja-JP", "ar-EG", "fa-IR", "th-TH", "bn-BD"]) {
  test(`regional ${locale} generated dates can be assigned, repeated, replaced, and removed`, () => {
    for (const mode of ["created", "range"]) {
      for (const updatedAt of [BASE.updatedAt, "2027-01-02T00:00:00Z"]) {
        const rules = { mode, dateFormat: "locale", locale };
        const metadata = { updatedAt };
        const assigned = plan("  原标题  ", {}, rules, metadata);
        assert.equal(assigned.canApply, true);
        const repeated = plan(assigned.after, {}, rules, metadata);
        assert.equal(repeated.noOp, true, assigned.after);
        assert.equal(repeated.after, assigned.after);
        const removed = plan(assigned.after, { operation: "remove" }, { ...rules, dateFormat: "iso" }, metadata);
        assert.equal(removed.after, "  原标题  ", assigned.after);
        assert.equal(removed.canApply, true, assigned.after);
        const changed = plan(assigned.after, { decision: "replace" }, { ...rules, dateFormat: "iso" }, metadata);
        assert.equal(changed.hasDateHead, true, assigned.after);
        assert.equal(changed.after.includes("原标题"), true);
      }
    }
  });
  test(`regional ${locale} existing full-year range heads remain recognizable content`, () => {
    const formatter = new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" });
    const title = `${formatter.format(new Date(BASE.createdAt))}\u2009~\u2009${formatter.format(new Date(BASE.updatedAt))}｜原  标题`;
    const result = plan(title, { operation: "remove" }, { locale });
    assert.equal(result.after, "原  标题", title);
    assert.equal(result.canApply, true, title);
    assert.equal(result.analysis.layers.length, 1, title);
  });
}

test("regional smart ranges use locale date order, not unconditional MM/DD", () => {
  const title = "01/09/2026\u2009~\u200908/09｜计划";
  const result = plan(title, { operation: "remove" }, { locale: "en-GB" });
  assert.equal(result.after, "计划");
  assert.equal(result.canApply, true);
});

test("browser locale drives default region; changing UI language does not change plans", () => {
  const japanese = load({ language: "ja-JP" }).TidyTitleDates;
  const first = japanese.plan(BASE, { ...RULES, dateFormat: "locale", locale: undefined, uiLanguage: "zh-CN" });
  const second = japanese.plan(BASE, { ...RULES, dateFormat: "locale", locale: undefined, uiLanguage: "en" });
  assert.equal(first.rules.locale, "ja-JP");
  assert.equal(first.after, second.after);
  assert.equal(first.ruleFingerprint, second.ruleFingerprint);
  assert.notEqual(plan(BASE.title, {}, { dateFormat: "locale", locale: "en-US" }).targetLayer,
    plan(BASE.title, {}, { dateFormat: "locale", locale: "en-GB" }).targetLayer);
});

test("browser and CommonJS models use the same shared formatter", () => {
  const context = load();
  const nodeModel = require("../src/features/titles/model/title-dates.js");
  let calls = 0;
  const original = context.TidyTimeFormat;
  context.TidyTimeFormat = { ...original, formatDate(...args) { calls += 1; return original.formatDate(...args); } };
  for (const dateFormat of ["locale", "iso", "slash", "dot", "compact"]) {
    for (const locale of ["en-US", "zh-CN", "ar-EG"]) {
      const rules = { ...RULES, dateFormat, locale, mode: "range", timeZone: "Asia/Tokyo" };
      assert.equal(context.TidyTitleDates.plan(BASE, rules).after, nodeModel.plan(BASE, rules).after);
    }
  }
  assert.equal(calls, 30);
});

test("rules and metadata are not mutated; plans have stable review fingerprints", () => {
  const metadata = Object.freeze({ ...BASE });
  const rules = Object.freeze({ ...RULES });
  const options = Object.freeze({ operation: "assign", decision: "skip" });
  const first = model.plan(metadata, rules, options);
  const second = model.plan(metadata, rules, options);
  assert.deepEqual(simple(first), simple(second));
  assert.notEqual(first.ruleFingerprint, plan(BASE.title, {}, { timeZone: "Asia/Tokyo" }).ruleFingerprint);
  assert.notEqual(first.ruleFingerprint, plan(BASE.title, {}, { mode: "range" }).ruleFingerprint);
  assert.equal(first.conversationId, BASE.conversationId);
});

test("there is no invented backend title-length limit", () => {
  const title = "标题".repeat(2000);
  const result = plan(title);
  assert.equal(result.canApply, true);
  assert.equal(result.after, `2026-04-24｜${title}`);
});
