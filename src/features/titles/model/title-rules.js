// 标题整理只保存这两个选项；会话内容、日期和写入回执不属于用户设置。
export const TITLE_RULES_KEY = "tidy.titles.rules.v1";
export const TITLE_RULE_FORMATS = Object.freeze(["locale", "iso", "slash", "dot", "compact"]);
export const TITLE_RULE_MODES = Object.freeze(["created", "range"]);

export function normalizeTitleRules(value, preferences) {
  return {
    // 产品默认：标题使用创建日期；与页面的会话时间显示方式独立，已保存选择优先。
    mode: TITLE_RULE_MODES.includes(value?.mode) ? value.mode : "created",
    dateFormat: TITLE_RULE_FORMATS.includes(value?.dateFormat) ? value.dateFormat
      : TITLE_RULE_FORMATS.includes(preferences?.dateFormat) ? preferences.dateFormat : "locale",
  };
}

export function titleRulesPatch(value) {
  return Object.fromEntries([["mode", TITLE_RULE_MODES], ["dateFormat", TITLE_RULE_FORMATS]]
    .filter(([key, choices]) => Object.hasOwn(value || {}, key) && choices.includes(value[key]))
    .map(([key]) => [key, value[key]]));
}
