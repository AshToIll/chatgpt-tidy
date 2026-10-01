(function initTidyTheme(global) {
  "use strict";
  if (global.TidyTheme) return;

  // 侧栏与页面书签共用唯一配色表；改颜色只改这里，不在展示层另存一份。
  const DEFAULT_THEME = "mist-indigo";
  // 调浅色/深色底色和文字灰阶改这里；这些中性色跟随页面明暗，不随强调色主题变化。
  const NATIVE_APPEARANCE_TOKENS = Object.freeze({
    light: Object.freeze({
      textPrimary: "#2c2d31", textSecondary: "#56585f", textTertiary: "#76787f",
      surface: "#ffffff", surfaceSubtle: "#f7f7f8", border: "#dedfe3", borderSubtle: "#ececef",
    }),
    dark: Object.freeze({
      textPrimary: "#f2f2f2", textSecondary: "#d0d0d4", textTertiary: "#a7a7ad",
      surface: "#212121", surfaceSubtle: "#2a2a2a", border: "#44444a", borderSubtle: "#343439",
    }),
  });

  // 调主题强调色改这里：light/dark 分别用于浅色/深色环境。
  // 主题只影响重点文字、选中和悬停区域，不给整个面板染色。
  const THEMES = Object.freeze({
    "mist-indigo": {
      light: { accent: "#596274", accentForeground: "#ffffff", accentInk: "#41495a", accentSoft: "#e7eaf0", selectedSurface: "#e7eaf0", hoverSurface: "#f0f2f6" },
      dark: { accent: "#aeb8cc", accentForeground: "#1d222c", accentInk: "#e4e9f2", accentSoft: "#343b49", selectedSurface: "#343b49", hoverSurface: "#2e333d" },
    },
    sage: {
      light: { accent: "#647566", accentForeground: "#ffffff", accentInk: "#455648", accentSoft: "#e8efe9", selectedSurface: "#e8efe9", hoverSurface: "#f0f4f1" },
      dark: { accent: "#afc4b1", accentForeground: "#1c271f", accentInk: "#e0ebe2", accentSoft: "#324138", selectedSurface: "#324138", hoverSurface: "#2d3831" },
    },
    wineberry: {
      light: { accent: "#875d6b", accentForeground: "#ffffff", accentInk: "#694753", accentSoft: "#f1e5ea", selectedSurface: "#f1e5ea", hoverSurface: "#f7eef2" },
      dark: { accent: "#d5a7b6", accentForeground: "#301f25", accentInk: "#f3e2e8", accentSoft: "#49323b", selectedSurface: "#49323b", hoverSurface: "#3d2e34" },
    },
    "smoke-purple": {
      light: { accent: "#74677f", accentForeground: "#ffffff", accentInk: "#584e61", accentSoft: "#ece7f0", selectedSurface: "#ece7f0", hoverSurface: "#f3eff6" },
      dark: { accent: "#c3b2cf", accentForeground: "#281f2e", accentInk: "#ece4f1", accentSoft: "#403548", selectedSurface: "#403548", hoverSurface: "#37303c" },
    },
    amber: {
      light: { accent: "#8a642f", accentForeground: "#ffffff", accentInk: "#674a24", accentSoft: "#f3e9d8", selectedSurface: "#f3e9d8", hoverSurface: "#f8f1e6" },
      dark: { accent: "#d7b77e", accentForeground: "#2e2314", accentInk: "#f2e6cf", accentSoft: "#493c29", selectedSurface: "#493c29", hoverSurface: "#393126" },
    },
    terracotta: {
      light: { accent: "#955b46", accentForeground: "#ffffff", accentInk: "#724432", accentSoft: "#f4e5de", selectedSurface: "#f4e5de", hoverSurface: "#f8eee9" },
      dark: { accent: "#dda78f", accentForeground: "#321f18", accentInk: "#f6e3db", accentSoft: "#4c352d", selectedSurface: "#4c352d", hoverSurface: "#3c2e29" },
    },
    "mist-cyan": {
      light: { accent: "#557779", accentForeground: "#ffffff", accentInk: "#405d5f", accentSoft: "#e5eeee", selectedSurface: "#e5eeee", hoverSurface: "#eef4f4" },
      dark: { accent: "#a8c5c7", accentForeground: "#192729", accentInk: "#dfecee", accentSoft: "#304246", selectedSurface: "#304246", hoverSurface: "#2b383b" },
    },
    graphite: {
      light: { accent: "#62666d", accentForeground: "#ffffff", accentInk: "#464a50", accentSoft: "#e7e9ec", selectedSurface: "#e7e9ec", hoverSurface: "#f0f1f3" },
      dark: { accent: "#b7bcc5", accentForeground: "#202328", accentInk: "#e6e8ec", accentSoft: "#383c43", selectedSurface: "#383c43", hoverSurface: "#30343a" },
    },
  });

  function resolve(themeId, colorScheme) {
    const theme = Object.hasOwn(THEMES, themeId) ? THEMES[themeId] : THEMES[DEFAULT_THEME];
    return theme[colorScheme === "dark" ? "dark" : "light"];
  }

  global.TidyTheme = Object.freeze({ DEFAULT_THEME, THEMES, NATIVE_APPEARANCE_TOKENS, resolve });
})(globalThis);
