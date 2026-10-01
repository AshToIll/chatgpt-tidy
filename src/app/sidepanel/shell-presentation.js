import { renderPageRefreshNotice } from "../../platform/session/ui/page-refresh-notice.js";

// 壳层元数据只决定标题与 Dock，不拥有栏目或导出选择状态。
export const PANEL_ROUTES = Object.freeze({
  time: { title: "timeDisplay", subtitle: "timeSubtitle" },
  titles: { title: "titleOrganization", subtitle: "titleOrganizationSubtitle" },
  favorites: { title: "favorites", subtitle: "favoritesPanelSubtitle" },
  bookmarks: { title: "bookmarks", subtitle: "bookmarksSubtitle" },
  search: { title: "globalSearch", subtitle: "searchSubtitle" },
  export: { title: "export", subtitle: "exportSubtitle" },
  settings: { title: "settings", subtitle: "settingsSubtitle" },
});
export const LANGUAGE_LOCALES = Object.freeze({
  "zh-CN": "zh-CN", "zh-TW": "zh-TW", en: "en-US", ja: "ja-JP",
});

function hexRgb(hex) {
  const value = String(hex || "").replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return "89, 98, 116";
  return [0, 2, 4].map(index => Number.parseInt(value.slice(index, index + 2), 16)).join(", ");
}

// 只接受本次呈现需要的字段；不会调用栏目 active/reset/navigation 等业务生命周期。
// 唯一缓存 appliedThemeKey 只用于去重 DOM 写入，不是另一份偏好或页面状态。
export function createShellPresentation({
  elements,
  translate,
  document = globalThis.document,
  window = globalThis.window,
  theme = globalThis.TidyTheme,
  diagnostics = globalThis.ChatGPTTidyDiagnostics,
  hydration = globalThis.TidyLibraryHydration,
  errorCode = globalThis.TidyProtocol?.ErrorCode,
}) {
  let appliedThemeKey = null;
  const source = "src/app/sidepanel/shell-presentation.js";

  function currentAppearance(appearance) {
    const fallback = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
    return appearance?.colorScheme === "dark" ? "dark"
      : appearance?.colorScheme === "light" ? "light" : fallback;
  }

  function applyTheme({ themeName, appearance }) {
    const colorScheme = currentAppearance(appearance);
    const resolved = theme.resolve(themeName, colorScheme);
    const native = theme.NATIVE_APPEARANCE_TOKENS[colorScheme];
    const capturedSurface = appearance?.surface;
    const nativeSurface = capturedSurface?.status === "available"
      && /^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/.test(capturedSurface.value || "")
      ? capturedSurface.value : native.surface;
    const key = JSON.stringify([themeName, colorScheme, nativeSurface]);
    if (key === appliedThemeKey) return;
    appliedThemeKey = key;
    document.documentElement.dataset.nativeColorScheme = colorScheme;
    const root = document.documentElement.style;
    root.setProperty("--accent", resolved.accent);
    root.setProperty("--accent-rgb", hexRgb(resolved.accent));
    root.setProperty("--accent-foreground", resolved.accentForeground);
    root.setProperty("--accent-ink", resolved.accentInk);
    root.setProperty("--accent-soft", resolved.accentSoft);
    // ChatGPT 外观负责中性色，强调色不得把整个侧栏染成主题色皮肤。
    root.setProperty("--text-primary", native.textPrimary);
    root.setProperty("--text-secondary", native.textSecondary);
    root.setProperty("--text-tertiary", native.textTertiary);
    root.setProperty("--surface", nativeSurface);
    root.setProperty("--surface-subtle", native.surfaceSubtle);
    root.setProperty("--border", native.border);
    root.setProperty("--border-subtle", native.borderSubtle);
    root.setProperty("--surface-selected", resolved.selectedSurface);
    root.setProperty("--surface-hover", resolved.hoverSurface);
  }

  function localize(language) {
    document.documentElement.lang = language;
    document.querySelectorAll("[data-i18n]").forEach(element => {
      element.textContent = translate(element.dataset.i18n);
    });
    document.querySelectorAll("[data-i18n-aria]").forEach(element => {
      element.setAttribute("aria-label", translate(element.dataset.i18nAria));
    });
    elements.routes.forEach(button => {
      button.setAttribute("aria-label", translate(PANEL_ROUTES[button.dataset.route]?.title || "settings"));
    });
    elements.close.setAttribute("aria-label", translate("close"));
    elements.close.title = translate("close");
    document.title = translate("appName");
  }

  function renderModuleChrome({ route, ready, selection }) {
    for (const owner of ["favorites", "bookmarks"]) {
      if (route !== owner || !ready) clearLibraryNotice(owner);
    }
    const meta = PANEL_ROUTES[route] || PANEL_ROUTES.time;
    const selectingSource = Boolean(selection && selection.source === route);
    elements.title.textContent = selectingSource
      ? `${translate(meta.title)} · ${translate("selectExport")}` : translate(meta.title);
    elements.subtitle.textContent = translate(meta.subtitle);
    elements.subtitle.hidden = selectingSource;
    elements.timeControl.hidden = !ready || route !== "time";
    elements.views.forEach(view => view.classList.toggle("is-active", view.dataset.view === route));
    // 从导出进入来源选择仍突出显示导出，来源列表保持自己的布局和滚动规则。
    const dockRoute = selection && ["manage", "batch-main"].includes(selection.returnTarget) ? "export" : route;
    elements.routes.forEach(button => {
      const active = button.dataset.route === dockRoute;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-expanded", String(active));
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    elements.body.dataset.activeRoute = route;
  }

  function clearLibraryNotice(owner) {
    diagnostics?.notice({ event: "clear", surface: owner + ".library-status", reasonCode: "NOTICE_HIDDEN" });
  }

  function renderPageConnection({ pageSession, route, onReconnect }) {
    // 设置壳只负责栏目归属，始终可由 Dock 路由进入；日志固定在它的底部。
    // 页面失联时仍封住原设置表单（偏好与备份），不把整个设置栏当成业务豁免。
    const sessionViews = elements.views.filter(view => {
      if (view.dataset.view !== "settings") return true;
      view.hidden = false; view.inert = false;
      return false;
    });
    if (elements.settingsForm) sessionViews.push(elements.settingsForm);
    const required = renderPageRefreshNotice({
      root: elements.pageRefresh, views: sessionViews,
      model: { pageSession }, translate, onReconnect,
    });
    elements.timeControl.hidden = required || route !== "time";
    if (required) for (const owner of ["favorites", "bookmarks"]) clearLibraryNotice(owner);
    return required;
  }

  function contextErrorPresentation(error) {
    if (error?.code === errorCode?.TAB_UNAVAILABLE) return { messageKey: "reopenTidyPanel", retryable: false };
    if (error?.code === errorCode?.UNSUPPORTED_PAGE) return { messageKey: "unsupported", retryable: true };
    return hydration.errorPresentation(error, "unavailable");
  }

  function renderContextStatus({ route, error, hasSnapshot, refreshRequired }) {
    const showError = Boolean(error && !hasSnapshot && !refreshRequired);
    elements.status.hidden = !showError;
    if (!showError) {
      elements.status.replaceChildren();
      diagnostics?.notice({ event: "clear", surface: "shell.context", reasonCode: "NOTICE_HIDDEN" });
      return;
    }
    const presentation = contextErrorPresentation(error);
    diagnostics?.notice(route === "time"
      ? { event: "show", surface: "shell.context", messageKey: presentation.messageKey,
        source, ...diagnostics?.cause(error) }
      : { event: "clear", surface: "shell.context", reasonCode: "NOTICE_HIDDEN" });
    const message = document.createElement("span");
    message.textContent = translate(presentation.messageKey);
    if (!presentation.retryable) { elements.status.replaceChildren(message); return; }
    const retry = document.createElement("button");
    retry.type = "button";
    retry.dataset.retryContext = "";
    retry.textContent = translate("retry");
    elements.status.replaceChildren(message, retry);
  }

  function renderModuleError({ root, owner, className, error, visible }) {
    const presentation = hydration.errorPresentation(error, owner === "favorites" ? "favoritesReadFailed" : "bookmarksReadFailed");
    const status = document.createElement("div");
    status.className = className;
    status.setAttribute("role", "status");
    status.textContent = translate(presentation.messageKey);
    root.dataset.moduleState = "error";
    diagnostics?.notice(visible
      ? { event: "show", surface: owner + ".library-status", messageKey: presentation.messageKey,
        source, ...diagnostics?.cause(error) }
      : { event: "clear", surface: owner + ".library-status", reasonCode: "NOTICE_HIDDEN" });
    if (!presentation.retryable) { root.replaceChildren(status); return; }
    const retry = document.createElement("button");
    retry.type = "button";
    retry.dataset.retryLibrary = "";
    retry.textContent = translate("retry");
    root.replaceChildren(status, retry);
  }

  function hasLibraryWaiting(root) {
    return Boolean(root.dataset.moduleState === "waiting" && root.childElementCount === 1
      && root.firstElementChild?.classList.contains("library-state"));
  }

  function renderLibraryWaiting({ root, owner, key, visible }) {
    let status = hasLibraryWaiting(root) ? root.firstElementChild : null;
    // 首次进入等待前由栏目协调层 reset；重复等待只重译同一个节点，避免重复朗读。
    if (!status) {
      status = document.createElement("div");
      status.className = "library-state";
      status.setAttribute("role", "status");
      root.replaceChildren(status);
      root.dataset.moduleState = "waiting";
    }
    diagnostics?.notice(visible
      ? { event: "show", surface: owner + ".library-status", messageKey: key, source, reasonCode: "LOADING_LIBRARY" }
      : { event: "clear", surface: owner + ".library-status", reasonCode: "NOTICE_HIDDEN" });
    const text = translate(key);
    if (status.textContent !== text) status.textContent = text;
  }

  function renderPreferenceNotice({ error, onRetry }) {
    const root = document.getElementById("preferences-notice");
    if (!root) return;
    root.hidden = !error;
    diagnostics?.notice(error
      ? { event: "show", surface: "shell.preferences", messageKey: error.messageKey, source, ...diagnostics?.cause(error) }
      : { event: "clear", surface: "shell.preferences", reasonCode: "NOTICE_HIDDEN" });
    if (!error) { root.replaceChildren(); return; }
    const label = document.createElement("span");
    label.textContent = translate(error.messageKey);
    if (error.retryable === false) { root.replaceChildren(label); return; }
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = translate("retry");
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      try { await onRetry(); } finally { retry.disabled = false; }
    });
    root.replaceChildren(label, retry);
  }

  function renderExportDockBadge({ count, busy }) {
    const badge = elements.exportBadge;
    if (!badge) return;
    badge.hidden = count === 0 && !busy;
    badge.textContent = busy ? "…" : count > 99 ? "99+" : String(count);
    badge.setAttribute("aria-label", busy ? translate("exportJobShowProgress") : translate("exportPendingCount", { count }));
  }

  return Object.freeze({
    currentAppearance, applyTheme, localize, renderModuleChrome, renderPageConnection,
    renderContextStatus, renderModuleError, clearLibraryNotice, hasLibraryWaiting, renderLibraryWaiting,
    renderPreferenceNotice, renderExportDockBadge,
  });
}
