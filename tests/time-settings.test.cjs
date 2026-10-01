const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const { readPanelCss } = require("./helpers/read-panel-css.cjs");
const { readPanelHtml } = require("./helpers/read-panel-html.cjs");

function loadClassic(path, globals = {}) {
  const context = vm.createContext({ Date, Intl, Object, Array, String, Number, Boolean, ...globals });
  vm.runInContext(fs.readFileSync(path, "utf8"), context, { filename: path });
  return context;
}

// ESM 直接走 Node 模块加载，不删 import 或注入旧存储结构；注释位置不应影响测试结果。
test("time display and settings use the production formatters, preferences and translations", async () => {
const time = loadClassic("src/platform/time-format.js").TidyTimeFormat;
const baseOptions = { timeZone: "Asia/Singapore", dateFormat: "slash", precision: "minute" };
const start = "2026-08-18T01:12:34.000Z";
const end = "2026-08-18T02:36:58.000Z";

assert.equal(time.formatDate(start, { ...baseOptions, dateFormat: "iso" }), "2026-08-18");
assert.equal(time.formatDate(start, { ...baseOptions, dateFormat: "slash" }), "2026/08/18");
assert.equal(time.formatDate(start, { ...baseOptions, dateFormat: "dot" }), "2026.08.18");
assert.equal(time.formatDate(start, { ...baseOptions, dateFormat: "compact" }), "20260818");
assert.equal(time.formatDate("2026-08-18T01:00:00.000Z", { ...baseOptions, timeZone: "America/New_York", dateFormat: "iso" }), "2026-08-17");
assert.equal(time.formatDateTime(start, baseOptions), "2026/08/18 09:12");
assert.equal(time.formatDateTime(start, { ...baseOptions, precision: "second" }), "2026/08/18 09:12:34");
assert.equal(time.formatDateTime(start, { ...baseOptions, precision: "date" }), "2026/08/18");
assert.equal(time.formatDateTime(start, { ...baseOptions, precision: "hour" }), "2026/08/18 09:00");
assert.equal(time.formatRange(start, end, baseOptions), "2026/08/18 09:12\u2009~\u200910:36");
assert.equal(
  time.formatRange(start, "2026-08-18T01:12:59.000Z", baseOptions),
  "2026/08/18 09:12",
  "a range inside one selected minute is shown once",
);
assert.equal(time.formatRange(start, end, { ...baseOptions, precision: "date" }), "2026/08/18");
assert.equal(time.formatRange(start, end, { ...baseOptions, precision: "hour" }), "2026/08/18 09:00\u2009~\u200910:00");
assert.equal(time.formatRange(start, "2026-08-19T02:36:00.000Z", baseOptions), "2026/08/18 09:12\u2009~\u200908/19 10:36");
assert.equal(time.formatRange(start, "2026-08-19T02:36:00.000Z", { ...baseOptions, precision: "date" }), "2026/08/18\u2009~\u200908/19");
assert.equal(
  time.formatRange("2025-12-31T15:50:00.000Z", "2025-12-31T17:40:00.000Z", baseOptions),
  "2025/12/31\u2009~\u20092026/01/01 01:40",
  "cross-year ranges keep both years and only the useful ending clock",
);
assert.equal(time.formatRange(null, end, baseOptions), null);

const conversation = {
  createdAt: { value: start },
  updatedAt: { value: end },
};
assert.equal(time.formatConversation(conversation, { ...baseOptions, mode: "created" }), "2026/08/18 09:12");
assert.equal(time.formatConversation(conversation, { ...baseOptions, mode: "updated" }), "2026/08/18 10:36");
assert.equal(time.formatConversation(conversation, { ...baseOptions, mode: "range" }), "2026/08/18 09:12\u2009~\u200910:36");

const preferenceExports = await import("../src/platform/preferences/preferences.js");
const themeTokens = loadClassic("src/platform/theme/theme.js").TidyTheme;
const defaults = JSON.parse(JSON.stringify(preferenceExports.DEFAULT_PREFERENCES));
assert.deepEqual(defaults, {
  schemaVersion: 1,
  language: preferenceExports.resolveBrowserLanguage(globalThis.navigator?.language || "en"),
  timeZone: "system",
  theme: "mist-indigo",
  dateFormat: "locale",
  conversationTimeMode: "range",
  conversationTimePrecision: "minute",
  messageTimePrecision: "second",
  messageTimePosition: "after",
  timeDisplayEnabled: true,
  messageNumbersEnabled: true,
});
const normalized = JSON.parse(JSON.stringify(preferenceExports.normalizePreferences({
  language: "bad",
  timeZone: "Not/AZone",
  dateFormat: "bad",
  conversationTimeMode: "bad",
  conversationTimePrecision: "bad",
  messageTimePrecision: "bad",
  messageTimePosition: "bad",
  timeDisplayEnabled: false,
  messageNumbersEnabled: false,
})));
assert.equal(normalized.language, defaults.language);
assert.equal(normalized.timeZone, "system");
assert.equal(normalized.dateFormat, "locale");
assert.equal(normalized.conversationTimeMode, "range");
assert.equal(normalized.conversationTimePrecision, "minute");
assert.equal(normalized.messageTimePrecision, "second");
assert.equal(normalized.messageTimePosition, "after");
assert.equal(normalized.timeDisplayEnabled, false);
assert.equal(normalized.messageNumbersEnabled, false);
assert.equal(Object.keys(themeTokens.THEMES).length, 8);
const semanticThemeKeys = [
  "accent", "accentForeground", "accentInk", "accentSoft",
  "selectedSurface", "hoverSurface",
];
for (const [themeId, theme] of Object.entries(themeTokens.THEMES)) {
  assert.deepEqual(Object.keys(theme).sort(), ["dark", "light"], `${themeId} must define both appearances`);
  for (const appearance of ["light", "dark"]) {
    assert.deepEqual(Object.keys(theme[appearance]).sort(), [...semanticThemeKeys].sort(), `${themeId}.${appearance} must contain accent tokens only`);
    for (const key of semanticThemeKeys) assert.match(theme[appearance][key], /^#[0-9a-f]{6}$/i, `${themeId}.${appearance}.${key}`);
  }
  assert.notDeepEqual(theme.light, theme.dark, `${themeId} must tune accent readability for both appearances`);
}
const nativeNeutralKeys = ["textPrimary", "textSecondary", "textTertiary", "surface", "surfaceSubtle", "border", "borderSubtle"];
assert.deepEqual(Object.keys(themeTokens.NATIVE_APPEARANCE_TOKENS).sort(), ["dark", "light"]);
for (const appearance of ["light", "dark"]) {
  assert.deepEqual(Object.keys(themeTokens.NATIVE_APPEARANCE_TOKENS[appearance]).sort(), [...nativeNeutralKeys].sort());
}
const datePrecision = JSON.parse(JSON.stringify(preferenceExports.normalizePreferences({
  conversationTimePrecision: "date",
  messageTimePrecision: "date",
})));
assert.equal(datePrecision.conversationTimePrecision, "date");
assert.equal(datePrecision.messageTimePrecision, "second");
const removedConversationOptions = JSON.parse(JSON.stringify(preferenceExports.normalizePreferences({
  rangeStyle: "full",
  conversationTimePrecision: "second",
})));
assert.equal(Object.hasOwn(removedConversationOptions, "rangeStyle"), false, "the removed F preference is not persisted");
assert.equal(removedConversationOptions.conversationTimePrecision, "minute", "old second precision migrates to minute");

const i18n = await import("../src/messages/i18n.js");
const languageKeys = Object.keys(i18n.STRINGS["zh-CN"]);
assert.deepEqual(Object.keys(i18n.STRINGS["zh-TW"]).sort(), [...languageKeys].sort());
assert.deepEqual(Object.keys(i18n.STRINGS.en).sort(), [...languageKeys].sort());
assert.deepEqual(Object.keys(i18n.STRINGS.ja).sort(), [...languageKeys].sort());
assert.equal(i18n.createTranslator("en")("messagesCount", { count: 4 }), "4 messages");
assert.equal(i18n.createTranslator("ja")("settings"), "設定");

const manifest = JSON.parse(fs.readFileSync("src/manifest.json", "utf8"));
for (const size of [16, 32, 48, 128]) {
  const relativePath = manifest.icons[String(size)];
  assert.equal(relativePath, `assets/icons/tidy-outlined-${size}.png`);
  const png = fs.readFileSync(`src/${relativePath}`);
  assert.equal(png.toString("ascii", 1, 4), "PNG");
  assert.equal(png.readUInt32BE(16), size);
  assert.equal(png.readUInt32BE(20), size);
  assert.equal(png[25], 6, `tidy-outlined-${size}.png must be RGBA`);
}

const panelHtml = readPanelHtml();
const timeViewSource = fs.readFileSync("src/features/time/ui/time-view.js", "utf8");
const panelSource = fs.readFileSync("src/app/sidepanel/panel.js", "utf8");
assert.match(panelHtml, /platform\/time-format\.js/);
assert.match(panelHtml, /class="time-dock"/);
assert.match(panelHtml, /data-route="time"/);
assert.match(panelHtml, /data-route="titles"/);
assert.match(panelHtml, /data-route="favorites"/);
assert.match(panelHtml, /data-route="bookmarks"/);
assert.match(panelHtml, /data-route="search"/);
assert.match(panelHtml, /data-route="export"/);
assert.match(panelHtml, /data-route="settings"/);
assert.match(panelHtml, /id="time-display-control"/);
assert.match(panelHtml, /id="conversation-list-panel"/);
assert.match(panelHtml, /id="message-time-panel"/);
assert.deepEqual(
  [...panelHtml.matchAll(/data-preference="conversationTimePrecision" data-value="([^"]+)"/g)].map((match) => match[1]),
  ["date", "hour", "minute"],
);
assert.match(panelHtml, /data-i18n="timeRange"/);
assert.match(panelHtml, /data-i18n="createdTime"/);
assert.match(panelHtml, /data-i18n="updatedTime"/);
assert.doesNotMatch(panelHtml, /data-preference="rangeStyle"|time-range-subsection|>S<|>F</);
assert.doesNotMatch(panelHtml, /preview-context-label|class="preview-context"/);
const settingsMarkup = panelHtml.slice(panelHtml.indexOf('id="settings-view"'), panelHtml.indexOf("</form>", panelHtml.indexOf('id="settings-view"')));
const timeViewStart = panelHtml.indexOf('id="time-view"');
const titlesViewStart = panelHtml.indexOf('id="titles-view"');
assert.ok(timeViewStart >= 0 && titlesViewStart > timeViewStart, "Time controls end at the distinct title-organization view");
const timeMarkup = panelHtml.slice(timeViewStart, titlesViewStart);
assert.doesNotMatch(settingsMarkup, /dateFormat|conversationTimeMode|messageTimePosition/);
assert.doesNotMatch(timeMarkup, /time-zone-shortcut|time-zone-shortcut-value|data-i18n="timeZone"/);
assert.match(settingsMarkup, /id="timezone-select"/);
assert.doesNotMatch(panelHtml, /当前快照|Current snapshot/);
assert.match(timeViewSource, /timeFormat\.formatConversation/);
assert.doesNotMatch(panelSource, /querySelectorAll\([^)]*data-message-id/);

const presentationSource = fs.readFileSync("src/features/time/chatgpt/time-presentation.js", "utf8");
const workerSource = fs.readFileSync("src/app/background/service-worker.js", "utf8");
const browserLifecycleSource = fs.readFileSync("src/app/background/browser-lifecycle.js", "utf8");
const pageGatewaySource = fs.readFileSync("src/platform/session/background/page-gateway.js", "utf8");
const shellPresentationSource = fs.readFileSync("src/app/sidepanel/shell-presentation.js", "utf8");
const panelCss = readPanelCss();
assert.match(presentationSource, /snapshot\.sidebarConversations/);
assert.match(presentationSource, /snapshot\.messages/);
assert.match(presentationSource, /item\.bindingStatus !== "bound"/);
assert.match(presentationSource, /snapshot\.conversation\.bindingStatus !== "bound"/);
assert.doesNotMatch(presentationSource, /__reactFiber|historyItem|create_time|update_time/);
assert.doesNotMatch(presentationSource, /setInterval/);
assert.match(workerSource, /createPageGateway\(/, "worker composes the production page transport owner");
assert.match(workerSource, /chrome\.storage\.onChanged\.addListener\(lifecycle\.storageChanged\)/);
assert.match(browserLifecycleSource, /protocol\.Type\.PREFERENCES_UPDATED|TidyProtocol\.Type\.PREFERENCES_UPDATED/);
assert.match(browserLifecycleSource, /pageGateway\.broadcast\(envelope\)/);
assert.match(pageGatewaySource, /async function broadcast\(envelope\)/);
assert.match(pageGatewaySource, /\.map\(\(tab\) => send\(tab\.id, envelope\)\)/);
assert.match(pageGatewaySource, /chrome\.tabs\.sendMessage\(tabId, envelope\)/);
assert.match(presentationSource, /PREFERENCES_UPDATED/);
assert.doesNotMatch(presentationSource, /location\.reload|window\.location\.reload/);
assert.match(panelSource, /createShellPresentation\(/, "panel composes the production theme presentation owner");
assert.match(panelSource, /const readSnapshot = \(\) => context\.get\(\)\.snapshot/);
assert.match(panelSource, /shell\.applyTheme\(\{[^}]*appearance: readSnapshot\(\)\?\.appearance/);
assert.match(shellPresentationSource, /appearance\?\.colorScheme/);
assert.match(panelCss, /data-native-color-scheme="dark"/);
assert.match(panelCss, /--text-primary:/);
assert.match(panelCss, /--surface-selected:/);
assert.match(shellPresentationSource, /native\.textPrimary/);
assert.doesNotMatch(shellPresentationSource, /(?:theme|resolved)\.(?:textPrimary|surface|border)\b/);
assert.match(shellPresentationSource, /appearance\?\.surface/);
assert.match(shellPresentationSource, /root\.setProperty\("--surface", nativeSurface\)/);
assert.match(shellPresentationSource, /resolved\.selectedSurface/);
assert.doesNotMatch(panelCss, /range-mode-button|range-mode-switch/);
assert.match(presentationSource, /padding-inline: 0/);
assert.match(presentationSource, /sidebarTitleInset\(host, item, node\.offsetParent \|\| host\)/);
assert.doesNotMatch(presentationSource, /--tidy-sidebar-bookmark-slot/);

// MAIN is now a composition root. Keep each original read/request invariant on
// its actual owner instead of reassembling extracted modules into the old entry.
const mainWorldSource = fs.readFileSync("src/app/page/main-world.js", "utf8");
const nativeReaderSource = fs.readFileSync("src/platform/chatgpt/native-snapshot-reader.js", "utf8");
const sidebarDomSource = fs.readFileSync("src/platform/chatgpt/sidebar-dom.js", "utf8");
const nativeObserverSource = fs.readFileSync("src/platform/chatgpt/native-observer.js", "utf8");
const metadataSource = fs.readFileSync("src/platform/chatgpt/snapshot-metadata.js", "utf8");
assert.match(mainWorldSource, /TidyChatgptNativeSnapshotReader\.create/);
assert.match(mainWorldSource, /TidyChatgptNativeObserver\.create/);
assert.match(mainWorldSource, /TidyChatgptSnapshotMetadata\.create/);
assert.match(nativeObserverSource, /project-interaction-settled/);
assert.match(sidebarDomSource, /a\[href\*="\/c\/"\]/);
assert.match(nativeReaderSource, /TidyChatgptSidebarDom/);
assert.match(nativeReaderSource, /sidebarDom\.candidates\(\)/);
assert.match(nativeReaderSource, /value\?\.create_time/);
assert.match(nativeReaderSource, /value\?\.update_time/);
assert.match(nativeReaderSource, /react-fiber\.history-item/);
for (const [owner, ownerSource] of [
  ["main-world", mainWorldSource], ["native reader", nativeReaderSource],
  ["native observer", nativeObserverSource], ["metadata", metadataSource],
]) {
  assert.doesNotMatch(ownerSource, /conversationRange|ENSURE_CONVERSATION_RANGES|queueConversationRanges/, owner);
  assert.doesNotMatch(ownerSource, /CURRENT_METADATA_FAILURE_TTL_MS/, owner);
}
assert.doesNotMatch(mainWorldSource, /function ensureCurrentConversationMeta|react-fiber\.history-item/);
assert.match(metadataSource, /function ensureCurrentConversationMeta/);
assert.match(metadataSource, /backend-api\/conversation\/\$\{global\.encodeURIComponent\(conversationId\)\}/);
assert.match(metadataSource, /if \(responseConversationId && responseConversationId !== conversationId\)/);
assert.doesNotMatch(presentationSource, /ENSURE_CONVERSATION_RANGES|needsExactRangeHydration|scheduleRangeHydration/);
assert.doesNotMatch(
  presentationSource,
  /item\.createdAt\?\.value \|\| item\.updatedAt\?\.value/,
  "range mode must not silently degrade into a single timestamp",
);

console.log("time-settings assertions passed");
});

test('date format labels use the selected zone across midnight, leap day and year boundaries', () => {
  const time = loadClassic('src/platform/time-format.js').TidyTimeFormat;
  for (const [instant, zone, expected] of [
    ['2026-09-17T20:00:00Z', 'Asia/Singapore', '2026-09-18'],
    ['2026-09-17T20:00:00Z', 'America/Los_Angeles', '2026-09-17'],
    ['2026-12-31T23:30:00Z', 'Asia/Kathmandu', '2027-01-01'],
    ['2028-03-01T00:30:00Z', 'America/Los_Angeles', '2028-02-29'],
  ]) {
    assert.deepEqual(JSON.parse(JSON.stringify(time.dateFormatLabels(zone, new Date(instant)))), {
      iso: expected, slash: expected.replaceAll('-', '/'), dot: expected.replaceAll('-', '.'), compact: expected.replaceAll('-', ''),
    });
  }
  assert.equal(time.formatDate('2020-01-02T00:00:00Z', { dateFormat: 'iso', timeZone: 'UTC' }), '2020-01-02',
    'real message/title dates never use the current day');
});

test('date format labels read the clock once per display and do not cache yesterday', () => {
  let now = Date.parse('2026-09-17T15:59:59Z'), reads = 0;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); if (!args.length) reads++; }
  }
  const time = loadClassic('src/platform/time-format.js', { Date: ClockDate }).TidyTimeFormat;
  assert.equal(time.dateFormatLabels('Asia/Singapore').iso, '2026-09-17');
  assert.equal(reads, 1, 'all four options share one instant');
  now = Date.parse('2026-09-17T16:00:00Z');
  assert.equal(time.dateFormatLabels('Asia/Singapore').iso, '2026-09-18');
  assert.equal(reads, 2);
});

test('time panel updates only date label text and preserves the regional option and button nodes', async () => {
  const { effectiveTimeZone } = await import('../src/platform/preferences/preferences.js');
  const { createTimeView } = await import('../src/features/time/ui/time-view.js');
  const { TIME_VIEW_TEMPLATE } = await import('../src/features/time/ui/time-template.js');
  let now = Date.parse('2026-09-17T20:00:00Z'), writes = 0, mounts = 0;
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } }
  const timeFormat = loadClassic('src/platform/time-format.js', { Date: ClockDate }).TidyTimeFormat;
  const buttons = ['locale', 'iso', 'slash', 'dot', 'compact'].map(value => ({ dataset: { value },
    value: value === 'locale' ? 'Follow regional format · Default' : '',
    get textContent() { return this.value; }, set textContent(value) { writes++; this.value = value; },
  }));
  // Exercise the public factory with only its DOM boundary stubbed. No private
  // function slicing: imports, template mount and lifecycle all run in production.
  const eventTarget = () => {
    const listeners = new Map();
    return {
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
      listenerCount: () => listeners.size,
    };
  };
  const children = new Map(['message-numbers', 'conversation-preview', 'message-preview',
    'conversation-list-summary', 'message-time-summary'].map(id => [id, eventTarget()]));
  const root = { ...eventTarget(),
    set innerHTML(value) { mounts++; assert.equal(value, TIME_VIEW_TEMPLATE); },
    querySelector(selector) { assert.ok(children.has(selector.slice(1))); return children.get(selector.slice(1)); },
    querySelectorAll(selector) {
      assert.equal(selector, 'button[data-preference="dateFormat"]');
      return buttons;
    },
  };
  const toggle = eventTarget();
  const view = createTimeView({
    root, body: {}, toggle, timeFormat, effectiveTimeZone,
    localeForLanguage: () => 'en-US',
    savePreference: () => assert.fail('date-label refresh must not write preferences'),
  });
  const preferences = { timeZone: 'Asia/Singapore' };
  const originalButtons = [...buttons];
  view.renderDateFormatLabels(preferences);
  assert.equal(buttons[1].textContent, '2026-09-18'); assert.equal(writes, 4);
  view.renderDateFormatLabels(preferences); assert.equal(writes, 4, 'unchanged labels do not mutate DOM');
  preferences.timeZone = 'America/Los_Angeles';
  view.renderDateFormatLabels(preferences); assert.equal(buttons[1].textContent, '2026-09-17');
  now = Date.parse('2026-09-18T20:00:00Z');
  view.renderDateFormatLabels(preferences); assert.equal(buttons[1].textContent, '2026-09-18');
  preferences.timeZone = 'system'; view.renderDateFormatLabels(preferences);
  assert.equal(buttons[1].textContent, timeFormat.formatDate(new ClockDate(), { timeZone: effectiveTimeZone({ timeZone: 'system' }), dateFormat: 'iso' }));
  assert.equal(buttons[0].textContent, 'Follow regional format · Default');
  assert.equal(mounts, 1, 'refreshing labels never remounts the time template');
  buttons.forEach((button, index) => assert.equal(button, originalButtons[index], 'button identity is preserved'));
  view.dispose();
  assert.equal(root.listenerCount() + toggle.listenerCount() + children.get('message-numbers').listenerCount(), 0);
});
