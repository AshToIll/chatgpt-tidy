const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const { readPanelHtml } = require("./helpers/read-panel-html.cjs");

test("incomplete title lists use short plain copy with a separately named retry action", async () => {
  const { createTranslator } = await import("../src/messages/i18n.js");
  for (const language of ["zh-CN", "zh-TW", "en", "ja"]) {
    const t = createTranslator(language);
    const current = t("titlesBatchCatalogReadFailed");
    assert.equal(t("titlesBatchCatalogPreviousReadFailed"), current);
    assert.notEqual(t("titlesBatchRetryRead"), "titlesBatchRetryRead");
    assert.doesNotMatch(current, /HTTP|SCHEMA|ADAPTER|缓存|限流/);
    assert.doesNotMatch(current, /\{count\}/);
  }
  assert.equal(createTranslator("zh-CN")("titlesBatchCatalogReadFailed"),
    "列表未读全");
});

test("browser language resolution honors Chinese script before region and falls back to English", async () => {
  const { resolveBrowserLanguage } = await import("../src/platform/preferences/preferences.js");
  const cases = {
    "zh": "zh-CN", "zh-CN": "zh-CN", "zh-SG": "zh-CN", "zh-Hans": "zh-CN", "zh-Hans-HK": "zh-CN",
    "zh-TW": "zh-TW", "zh-HK": "zh-TW", "zh-MO": "zh-TW", "zh-Hant": "zh-TW", "zh-Hant-CN": "zh-TW",
    "en": "en", "en-US": "en", "en-GB": "en", "ja": "ja", "ja-JP": "ja",
    "fr-FR": "en", "de-DE": "en", "ko-KR": "en", "ar-SA": "en", "": "en", "not_a_locale": "en",
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(resolveBrowserLanguage(input), expected, input);
  for (const input of [undefined, null, 123]) assert.equal(resolveBrowserLanguage(input), "en");
});

test("initial preferences use browser UI language without writes; existing choices always win", async () => {
  const previousChrome = globalThis.chrome;
  let uiLanguage = "zh-HK", stored, writes = 0;
  globalThis.chrome = { i18n: { getUILanguage: () => uiLanguage }, runtime: {}, storage: { sync: {
    get: (key, callback) => callback({ [key]: stored }),
    set: (patch, callback) => { writes++; stored = structuredClone(Object.values(patch)[0]); callback(); },
  } } };
  try {
    const preferences = await import("../src/platform/preferences/preferences.js?language-test");
    assert.equal(preferences.DEFAULT_PREFERENCES.language, "zh-TW");
    assert.equal((await preferences.getPreferences()).language, "zh-TW");
    for (const [browser, expected] of [["zh-CN", "zh-CN"], ["ja-JP", "ja"], ["en-GB", "en"], ["fr-FR", "en"], ["zh-MO", "zh-TW"]]) {
      uiLanguage = browser;
      assert.equal((await preferences.getPreferences()).language, expected);
      assert.equal(preferences.normalizePreferences({ language: "broken" }).language, expected);
      for (const language of preferences.SUPPORTED_LANGUAGES) {
        stored = { language, timeZone: "Asia/Taipei" };
        assert.equal((await preferences.getPreferences()).language, language, `${browser} must not replace saved ${language}`);
      }
      stored = undefined;
    }
    assert.equal(writes, 0, "reading defaults must not write a sync preference or migrate existing data");
    await preferences.updatePreferences({ language: "ja" });
    uiLanguage = "de-DE";
    await preferences.updatePreferences({ theme: "sage" });
    assert.equal(stored.language, "ja", "an unrelated setting retains the explicit choice");
    await preferences.updatePreferences({ language: "zh-TW" });
    assert.equal((await preferences.getPreferences()).language, "zh-TW");
    assert.equal(stored.theme, "sage");
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome; else globalThis.chrome = previousChrome;
  }
});

test("every selectable language has a complete catalog; unknown languages use English", async () => {
  const { SUPPORTED_LANGUAGES } = await import("../src/platform/preferences/preferences.js");
  const { STRINGS, createTranslator } = await import("../src/messages/i18n.js");
  const html = readPanelHtml();
  const select = /<select id="language-select">([\s\S]*?)<\/select>/.exec(html)[1];
  assert.deepEqual([...select.matchAll(/value="([^"]+)"/g)].map(match => match[1]), [...SUPPORTED_LANGUAGES]);
  assert.deepEqual(Object.keys(STRINGS).sort(), [...SUPPORTED_LANGUAGES].sort());
  for (const language of ["fr-FR", "ko-KR", "constructor", undefined]) {
    assert.equal(createTranslator(language)("settings"), STRINGS.en.settings);
  }
  const t = createTranslator("zh-TW");
  assert.equal(t("settings"), "設定");
  assert.equal(t("export"), "匯出");
  assert.equal(t("messagesCount", { count: 3 }), "3 則訊息");
  const raw = "原文软件 / 軟體 / ソフト / User {name}";
  assert.equal(t("exportImageLabel", { name: raw }), `圖片：${raw}`, "user content is never converted");
});

test("recovery copy keeps workspace scope and distinguishes preview, retry and stack actions", async () => {
  const { STRINGS } = await import("../src/messages/i18n.js");
  // 人工审校后的关键动作合同；缺键测试无法发现“重试”被翻成“搜索”这类语义漂移。
  const scopes = { "zh-CN": "工作区", "zh-TW": "工作區", en: "workspace", ja: "ワークスペース" };
  const previews = { "zh-CN": "预览", "zh-TW": "預覽", en: "Preview", ja: "プレビュー" };
  for (const [language, copy] of Object.entries(STRINGS)) {
    for (const key of ["backupAccountMismatch", "backupOwnerChanged", "titlesAccountChanged", "searchExportAccountChanged"]) {
      assert.ok(copy[key].includes(scopes[language]), `${language}/${key}: workspace changes are not account-only changes`);
    }
    assert.notEqual(copy.titlesConfirmStack, copy.titlesConfirm, `${language}: stacking keeps an existing date`);
    assert.ok(copy.titlesBatchRetryFailed.includes(previews[language]), `${language}: unfinished items need a fresh preview`);
  }
  assert.equal(STRINGS.ja.favoriteLatestUnavailable, "最新のメッセージが見つかりません。もう一度お試しください");
  assert.equal(STRINGS.en.selectAllCurrentConversation, "Select all bookmarks in this conversation");
  assert.equal(STRINGS.en.backupTooLarge, "Too much data for this operation.", "the limit also applies when importing");
});

test("browser extension metadata is present in every selectable language", async () => {
  const { SUPPORTED_LANGUAGES } = await import("../src/platform/preferences/preferences.js");
  const manifest = JSON.parse(fs.readFileSync("src/manifest.json", "utf8"));
  const keys = [manifest.name, manifest.description, manifest.action.default_title]
    .map(value => /^__MSG_(\w+)__$/.exec(value)?.[1]);
  assert.ok(keys.every(Boolean), "browser metadata uses localized messages");
  for (const language of SUPPORTED_LANGUAGES) {
    const messages = JSON.parse(fs.readFileSync(`src/_locales/${language.replace("-", "_")}/messages.json`, "utf8"));
    assert.deepEqual(Object.keys(messages).sort(), [...keys].sort(), language);
    for (const key of keys) assert.ok(messages[key].message.trim(), `${language}/${key}`);
  }
});
