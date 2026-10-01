import { SETTINGS_VIEW_TEMPLATE } from "./settings-template.js";
import { THEME_NAMES } from "../../../messages/i18n.js";

// 设置栏拥有语言、时区与主题控件；备份视图仍由装配层接入同一账号资料生命周期。
// update 只更新现有控件；不会重建备份 DOM，也不会重启备份任务。
export function createSettingsView({ root, themes, savePreference }) {
  root.innerHTML = SETTINGS_VIEW_TEMPLATE;
  const elements = {
    language: root.querySelector("#language-select"),
    timeZone: root.querySelector("#timezone-select"),
    themes: root.querySelector("#theme-grid"),
  };
  let preferences, t, appearance, themeGridKey = null;

  function timeZoneList() {
    const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const fallback = [
      "UTC", "Asia/Shanghai", "Asia/Tokyo", "Asia/Singapore", "Asia/Kolkata", "Europe/London",
      "Europe/Paris", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
      "America/Sao_Paulo", "Australia/Sydney", "Pacific/Auckland",
    ];
    const supported = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : fallback;
    return { systemZone, supported: [...new Set(["UTC", ...supported])] };
  }

  function renderTimeZones() {
    const { systemZone, supported } = timeZoneList();
    elements.timeZone.innerHTML = [
      `<option value="system">${t("followSystem")} · ${systemZone}</option>`,
      ...supported.map((zone) => `<option value="${zone}">${zone}</option>`),
    ].join("");
    elements.timeZone.value = preferences.timeZone;
  }

  function renderThemeGrid() {
    const names = THEME_NAMES[preferences.language] || THEME_NAMES.en;
    const key = `${preferences.language}:${appearance}`;
    // 只换重点色时保留原按钮与键盘焦点；语言或明暗改变才重建色板内容。
    if (themeGridKey !== key) {
      themeGridKey = key;
      elements.themes.innerHTML = Object.entries(themes).map(([id, themeSet]) => {
        const theme = themeSet[appearance];
        return `
        <label class="settings-theme-choice${id === preferences.theme ? " is-selected" : ""}">
          <input type="radio" name="settings-theme" value="${id}"${id === preferences.theme ? " checked" : ""} />
          <span class="settings-theme-choice__swatches" aria-hidden="true"><i style="--swatch:${theme.accent}"></i><i style="--swatch:${theme.accentSoft}"></i></span>
          <strong>${names[id]}</strong>
        </label>`;
      }).join("");
    }
    for (const input of elements.themes.querySelectorAll('input[name="settings-theme"]')) {
      const selected = input.value === preferences.theme;
      input.checked = selected;
      input.closest(".settings-theme-choice").classList.toggle("is-selected", selected);
    }
  }

  function changeLanguage() { savePreference({ language: elements.language.value }); }
  function changeTimeZone() { savePreference({ timeZone: elements.timeZone.value }); }
  function changeTheme(event) {
    if (event.target.matches('input[name="settings-theme"]')) savePreference({ theme: event.target.value });
  }
  elements.language.addEventListener("change", changeLanguage);
  elements.timeZone.addEventListener("change", changeTimeZone);
  elements.themes.addEventListener("change", changeTheme);

  return Object.freeze({
    update({ preferences: nextPreferences, translator, appearance: nextAppearance }) {
      preferences = nextPreferences; t = translator; appearance = nextAppearance;
      renderTimeZones(); renderThemeGrid();
      // 四种语言使用各自自称；可见文字统一从文案目录取得。
      const languageNames = { "zh-CN": "languageNameZhCn", "zh-TW": "languageNameZhTw", en: "languageNameEn", ja: "languageNameJa" };
      for (const option of elements.language.options) option.textContent = t(languageNames[option.value]);
      elements.language.value = preferences.language;
    },
    updateTheme({ preferences: nextPreferences, appearance: nextAppearance }) {
      preferences = nextPreferences; appearance = nextAppearance; renderThemeGrid();
    },
    dispose() {
      elements.language.removeEventListener("change", changeLanguage);
      elements.timeZone.removeEventListener("change", changeTimeZone);
      elements.themes.removeEventListener("change", changeTheme);
    },
  });
}
