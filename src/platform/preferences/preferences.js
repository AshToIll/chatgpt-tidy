// 全局设置入口：界面语言、时间显示、时区和主题；标题整理的两个选项由 title-rules.js 单独管理。
import "../theme/theme.js";
import { STORAGE_BOUNDARIES } from "../storage/schema.js";
const { THEMES, DEFAULT_THEME } = globalThis.TidyTheme;

export const PREFERENCES_KEY = STORAGE_BOUNDARIES.sync.preferences;

export const SUPPORTED_LANGUAGES = Object.freeze(["zh-CN", "zh-TW", "en", "ja"]);

// 首次使用按浏览器界面语言选择；不支持的语言统一用英文。
// 中文优先识别文字体系，再看地区，避免把 zh-Hans-HK 误判为繁体。
export function resolveBrowserLanguage(language) {
  try {
    const locale = new Intl.Locale(language);
    if (locale.language === "zh") {
      if (locale.script === "Hant") return "zh-TW";
      if (locale.script === "Hans") return "zh-CN";
      return ["TW", "HK", "MO"].includes(locale.region) ? "zh-TW" : "zh-CN";
    }
    return locale.language === "ja" ? "ja" : "en";
  } catch { return "en"; }
}

function browserLanguage() {
  return resolveBrowserLanguage(globalThis.chrome?.i18n?.getUILanguage?.() || globalThis.navigator?.language || "en");
}

export const DATE_FORMATS = Object.freeze(["locale", "iso", "slash", "dot", "compact"]);
export const CONVERSATION_TIME_MODES = Object.freeze(["range", "created", "updated"]);
export const CONVERSATION_TIME_PRECISIONS = Object.freeze(["date", "hour", "minute"]);
export const MESSAGE_TIME_PRECISIONS = Object.freeze(["minute", "second"]);
export const MESSAGE_POSITIONS = Object.freeze(["before", "after"]);

// 产品默认值：首次使用及无效设置回退时采用；修改这里不会覆盖用户已保存的有效选择。
export const DEFAULT_PREFERENCES = Object.freeze({
  schemaVersion: 1,
  language: browserLanguage(),
  timeZone: "system",
  theme: DEFAULT_THEME,
  dateFormat: "locale",
  conversationTimeMode: "range",
  conversationTimePrecision: "minute",
  messageTimePrecision: "second",
  messageTimePosition: "after",
  timeDisplayEnabled: true,
  messageNumbersEnabled: true,
});

function normalizeEnum(value, supported, fallback) {
  return supported.includes(value) ? value : fallback;
}

function normalizeTimeZone(value) {
  if (!value || value === "system") return "system";
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return "system";
  }
}

export function normalizePreferences(value = {}) {
  return {
    schemaVersion: 1,
    language: SUPPORTED_LANGUAGES.includes(value.language)
      ? value.language
      : browserLanguage(),
    timeZone: normalizeTimeZone(value.timeZone),
    theme: Object.hasOwn(THEMES, value.theme) ? value.theme : DEFAULT_PREFERENCES.theme,
    dateFormat: normalizeEnum(value.dateFormat, DATE_FORMATS, DEFAULT_PREFERENCES.dateFormat),
    conversationTimeMode: normalizeEnum(
      value.conversationTimeMode,
      CONVERSATION_TIME_MODES,
      DEFAULT_PREFERENCES.conversationTimeMode,
    ),
    conversationTimePrecision: normalizeEnum(
      value.conversationTimePrecision,
      CONVERSATION_TIME_PRECISIONS,
      DEFAULT_PREFERENCES.conversationTimePrecision,
    ),
    messageTimePrecision: normalizeEnum(
      value.messageTimePrecision,
      MESSAGE_TIME_PRECISIONS,
      DEFAULT_PREFERENCES.messageTimePrecision,
    ),
    messageTimePosition: normalizeEnum(
      value.messageTimePosition,
      MESSAGE_POSITIONS,
      DEFAULT_PREFERENCES.messageTimePosition,
    ),
    timeDisplayEnabled: value.timeDisplayEnabled !== false,
    messageNumbersEnabled: value.messageNumbersEnabled !== false,
  };
}

export function getPreferences() {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(PREFERENCES_KEY, (result) => {
      // Chrome 的回调在 Promise 构造之后执行；解析异常必须在回调内接住，
      // 否则读取会一直等待，也会堵住后续设置保存和标题写入前的设置核对。
      try {
        if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
        const value = result?.[PREFERENCES_KEY];
        // 未保存过可以读默认值；整条记录损坏不能冒充默认值再覆盖回存储。
        if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
          throw Object.assign(new Error("Invalid preferences record."), { code: "PREFERENCES_INVALID" });
        }
        resolve(normalizePreferences(value));
      } catch (error) { reject(error); }
    });
  });
}

// All panels send patches to the same worker module. Queue at that shared
// write boundary, not only within each panel, so simultaneous different-field
// updates never replace each other with stale full preference snapshots.
let preferenceWrites = Promise.resolve();
export function updatePreferences(patch) {
  const update = { ...patch };
  const operation = preferenceWrites.then(async () => {
    const current = await getPreferences();
    const next = normalizePreferences({ ...current, ...update });
    if (JSON.stringify(next) === JSON.stringify(current)) return next;
    await new Promise((resolve, reject) => {
      chrome.storage.sync.set({ [PREFERENCES_KEY]: next }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    return next;
  });
  preferenceWrites = operation.catch(() => {});
  return operation;
}

export function effectiveTimeZone(preferences) {
  return preferences.timeZone === "system"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    : preferences.timeZone;
}
