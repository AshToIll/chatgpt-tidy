// 侧栏装配入口。状态由 context/library/navigation/export/preferences 各自 owner 持有；
// 这里仅连接窄能力、栏目路由与跨模块生命周期，不再实现通信或业务动作。
import "../../messages/build-info.js";
import "../../messages/notice-registry.js";
import "../../messages/notice-lifecycle.js";
import "../../messages/diagnostics.js";
import { DEFAULT_PREFERENCES, PREFERENCES_KEY, effectiveTimeZone } from "../../platform/preferences/preferences.js";
import { createTimeView } from "../../features/time/ui/time-view.js";
import { createSettingsView } from "../../features/settings/ui/settings-view.js";
import { createTranslator } from "../../messages/i18n.js";
import { isValidTabId, parsePanelOwnerTabId } from "../../platform/navigation/panel-owner.js";
import { createLibraryController } from "../../platform/library/ui/library-controller.js";
import { createLibraryBackupView } from "../../features/settings/ui/library-backup-view.js";
import { createPreferenceController } from "../../platform/preferences/preference-controller.js";
import { pageRefreshRequired } from "../../platform/session/ui/page-refresh-notice.js";
import { createPageSessionController } from "../../platform/session/ui/page-session-controller.js";
import { createFavoritesView } from "../../features/favorites/ui/favorites-view.js";
import { createBookmarksView } from "../../features/bookmarks/ui/bookmarks-view.js";
import { createPanelConfirmation } from "../../platform/ui/panel-confirmation.js";
import { createFavoritesActions } from "../../features/favorites/ui/favorites-actions.js";
import { createBookmarksActions } from "../../features/bookmarks/ui/bookmarks-actions.js";
import { createBookmarkNavigation } from "../../features/bookmarks/ui/bookmark-navigation.js";
import { createPanelNavigationOwner } from "../../platform/navigation/ui/navigation-owner.js";
import { createSearchView } from "../../features/search/ui/search-view.js";
import { createConversationDateSearch } from "../../features/search/ui/conversation-date-search.js";
import { createConversationCatalogRepository } from "../../platform/catalog/storage/conversation-catalog.js";
import { createExportView } from "../../features/export/ui/export-view.js";
import { createExportSelection } from "../../features/export/ui/export-selection.js";
import { createTitleOrganizationView } from "../../features/titles/ui/title-organization-view.js";
import { createTitleCatalog } from "../../features/titles/ui/title-catalog.js";
import { createTitleRulesController } from "../../features/titles/ui/title-rules.js";
import "../../platform/theme/theme.js";
import { createPanelRequestClient } from "./request-client.js";
import { createFeatureClients } from "./feature-clients.js";
import { createPanelContextController } from "./context-controller.js";
import { createPanelNavigationCoordinator } from "./navigation-coordinator.js";
import { createLibraryPanelController } from "./library-panel-controller.js";
import { createNoticeController } from "./notice-controller.js";
import { createShellPresentation, PANEL_ROUTES, LANGUAGE_LOCALES } from "./shell-presentation.js";
import { createFilingContextClient } from "./filing-context-client.js";
import { createSearchActions } from "./search-actions.js";
import { createExportWorkflow } from "./export-workflow.js";
import { installPanelLifecycle } from "./panel-lifecycle.js";

const protocol = globalThis.TidyProtocol;
const timeFormat = globalThis.TidyTimeFormat;
const panelContext = globalThis.TidyPanelContext;
const panelOwnerTabId = parsePanelOwnerTabId(globalThis.location?.href, chrome.runtime.getURL("app/sidepanel/index.html"));
const state = {
  route: "time",
  preferences: { ...DEFAULT_PREFERENCES },
  pageSession: { phase: "connecting", generation: 0, documentId: null },
};
let preferenceError = null;
let t = createTranslator(state.preferences.language);
let mounted = false;
let disposed = false;
let diagnosticsView = null;

const elements = {
  body: document.querySelector(".time-panel__body"),
  title: document.getElementById("panel-title"), subtitle: document.getElementById("panel-subtitle"),
  timeControl: document.getElementById("time-display-control"),
  views: [...document.querySelectorAll("[data-view]")], routes: [...document.querySelectorAll("[data-route]")],
  status: document.getElementById("status-card"), pageRefresh: document.getElementById("page-refresh-notice"),
  close: document.getElementById("close-button"), favoritesRoot: document.getElementById("favorites-view"),
  bookmarksRoot: document.getElementById("bookmarks-view"), searchRoot: document.getElementById("search-view"),
  exportRoot: document.getElementById("export-view"), titlesRoot: document.getElementById("titles-view"),
  exportBadge: document.querySelector("[data-export-badge]"), toast: document.getElementById("toast"),
};
const isReady = () => pageSession.isReady();
const readSnapshot = () => context.get().snapshot;
const readLibrary = () => library.getState();
const translate = (...args) => t(...args);
const client = createPanelRequestClient({ runtime: chrome.runtime, protocol,
  run: (type, operation) => pageSession.run(type, operation) });
const sendRequest = client.send;
const featureClients = createFeatureClients({ request: sendRequest, ownerTabId: panelOwnerTabId, protocol });
const shell = createShellPresentation({ elements, translate });
const panelNavigation = createPanelNavigationOwner({
  createId: () => protocol.createRequestId("navigation"),
  cancel: (navigationIntentId, reason) => {
    void sendRequest(protocol.Type.NAVIGATION_CANCELLED, { expectedTabId: panelOwnerTabId, navigationIntentId, reason }).catch(() => {});
  },
  onChanged: intent => { if (mounted) notice.reconcileNavigationNotice(intent?.id || null); },
});
const notice = createNoticeController({ root: elements.toast, translate, isReady,
  isCurrentNavigation: panelNavigation.isCurrent });
const { showToast, dismissToast, renderToast, dismissSearchToast, beginSearchNotice, finishSearchNotice, showSearchToast } = notice;

const preferenceController = createPreferenceController({
  read: () => sendRequest(protocol.Type.PREFERENCES_GET),
  write: patch => sendRequest(protocol.Type.PREFERENCES_UPDATE, patch),
  onChanged: applyPreferences,
  onError: (error, action) => {
    const messageKey = action === "save" ? "preferenceSaveUnknown" : "preferenceReadFailed";
    preferenceError = { ...moduleError(error), ...globalThis.TidyLibraryHydration.errorPresentation(error, messageKey) };
    renderPreferenceNotice();
  },
  onLoaded: () => { preferenceError = null; renderPreferenceNotice(); },
});
preferenceController.suspend();
const titleRulesController = createTitleRulesController({
  read: () => sendRequest(protocol.Type.TITLE_RULES_GET),
  write: patch => sendRequest(protocol.Type.TITLE_RULES_UPDATE, patch),
});
titleRulesController.suspend();

const timeView = createTimeView({
  root: document.getElementById("time-view"), body: elements.body,
  toggle: document.getElementById("time-enabled"), timeFormat, effectiveTimeZone,
  localeForLanguage: language => LANGUAGE_LOCALES[language] || "en-US", savePreference,
});
// 时间视图挂载自己的模板后才存在当前会话状态槽。
elements.status = document.getElementById("status-card");
const settingsView = createSettingsView({ root: document.getElementById("settings-view"),
  themes: globalThis.TidyTheme.THEMES, savePreference });
// 设置表单依赖页面会话；底部排查日志不依赖网页连接，始终留在设置内。
elements.settingsForm = document.getElementById("settings-form");
// 一个侧栏只保留一个确认框；具体删除目标和异步归属仍由各栏目负责。
const libraryConfirmation = createPanelConfirmation({ document });
const favoritesView = createFavoritesView({ root: elements.favoritesRoot, confirmation: libraryConfirmation,
  onAction: (action, payload) => favoritesActions.handle(action, payload),
  onExportAction: (action, payload) => exportWorkflow.handle(action, payload) });
const bookmarksView = createBookmarksView({ root: elements.bookmarksRoot, confirmation: libraryConfirmation,
  onAction: (action, payload) => bookmarksActions.handle(action, payload),
  onExportAction: (action, payload) => exportWorkflow.handle(action, payload) });
const libraryViews = { favorites: favoritesView, bookmarks: bookmarksView };
let searchView = null;
const conversationCatalog = createConversationCatalogRepository();
const conversationDateSearch = createConversationDateSearch({
  repository: conversationCatalog, requestAdapter: featureClients.dateCatalog,
  onStatus: status => searchView?.setIndexStatus(status),
});
const titleCatalog = createTitleCatalog({ repository: conversationCatalog,
  beforeLoad: () => conversationDateSearch.pause(), requestAdapter: featureClients.dateCatalog });
const titleView = createTitleOrganizationView({
  root: elements.titlesRoot, ownerTabId: panelOwnerTabId, rulesController: titleRulesController,
  request: featureClients.titles, onChanged: () => context.refresh(),
  loadCatalog: options => titleCatalog.load(options), pauseCatalog: () => titleCatalog.pause(),
  onBusyChange: busy => {
    elements.body.closest?.(".time-panel")?.classList.toggle("is-title-batch-busy", busy);
    elements.close.disabled = busy;
  },
});
const exportSelection = createExportSelection({ noticeText: translate });
exportSelection.subscribe(() => { if (mounted) renderSourceViews(); });
searchView = createSearchView({
  root: elements.searchRoot, createIntentId: () => panelNavigation.begin("search"),
  onAction: (action, payload) => searchActions.handle(action, payload),
  onInteraction: dismissSearchToast,
  onExportAction: (action, payload) => exportWorkflow.handle(action, payload),
  // 结果变化是来源登记的事件；renderSearch 从来不修改导出篮。
  onExportSourcesChange: items => exportSelection.registerSearchResults(items),
});
const exportView = createExportView({
  root: elements.exportRoot, selection: exportSelection,
  requestResource: featureClients.exportResource, jobRequest: featureClients.exportJob,
  requestDocument: featureClients.exportDocument, requestDocuments: featureClients.exportDocuments,
  presentFullPreview: featureClients.presentPreview, dismissFullPreview: featureClients.dismissPreview,
  formatTimestamp, onToast: (key, error, values, cause) => showToast(key, error, values, { cause }),
  onSourceRequest: (source, target) => exportWorkflow.begin(source, target),
  reloadSources: () => library.refresh({ retryIdentity: true }),
  openDownloads: () => chrome.tabs.create({ url: "chrome://downloads/" }),
  // 任务进度只更新角标；来源列表仅订阅 selection 的实际模型变化。
  onStateChange: () => { if (mounted) renderExportDockBadge(); },
});

const library = createLibraryController({
  visible: false, request: featureClients.library,
  onChanged: model => { if (mounted) libraryPanel.onLibraryChanged(model); },
});
globalThis.TidyLibraryDiagnostics = Object.freeze({ get: library.getDiagnostic });
const backupView = createLibraryBackupView({
  root: document.getElementById("library-backup"),
  captureOwner: library.capture, isCurrent: library.isCurrent, translate, toast: showToast,
  connection: () => ({ error: readLibrary().errors.favorites || readLibrary().errors.bookmarks,
    noticeShown: pageRefreshRequired(state) }),
  reconnect: () => library.refresh({ retryIdentity: true }),
  checkLibrary: () => { setRoute("favorites"); void library.refresh(); },
  request: featureClients.backup,
  onRestored: (owner, result) => {
    library.acceptMutation(owner, "favorites", result.favorites);
    library.acceptMutation(owner, "bookmarks", result.bookmarks);
  },
});
const bookmarkNavigation = createBookmarkNavigation({
  createIntentId: () => panelNavigation.begin("bookmarks"),
  isActive: () => state.route === "bookmarks" && !document.hidden && isValidTabId(panelOwnerTabId),
  isOwnerCurrent: library.isCurrent, isIntentCurrent: panelNavigation.isCurrent,
  getBookmark: bookmarkId => readLibrary().bookmarks?.items?.[bookmarkId],
  open: (target, owner) => {
    panelNavigation.setTarget(target.navigationIntentId, { conversationId: target.conversationId, messageId: target.messageId });
    return featureClients.bookmarkOpen(target, owner);
  },
  onCancel: (target, reason) => { panelNavigation.cancel(target.navigationIntentId, reason); libraryPanel.renderBookmarks(); },
  onSelected: bookmarkId => libraryPanel.selected(bookmarkId),
  onResult: result => {
    libraryPanel.renderBookmarks();
    if (result.reason === "open-failed") {
      navigationResults.openFailed({ ...result, navigationIntentId: panelNavigation.get()?.id });
      return;
    }
    showToast(result.located ? "bookmarkLocated"
      : result.error?.code === protocol.ErrorCode.CONTEXT_MISMATCH ? "contextChanged"
        : result.reason === "open-failed" ? "bookmarkOpenFailed" : "bookmarkLocateFallback", !result.located,
    {}, { owner: "bookmarks", navigationIntentId: result.navigationIntentId || panelNavigation.get()?.id,
      durationMs: result.located ? 2400 : 5000, cause: result.error });
  },
});
const filing = {};
for (const kind of ["favorites", "bookmarks"]) {
  filing[kind] = createFilingContextClient({
    runtime: chrome.runtime, protocol, ownerTabId: panelOwnerTabId,
    type: kind === "favorites" ? protocol.Type.FAVORITES_FILING_CONTEXT : protocol.Type.BOOKMARKS_FILING_CONTEXT,
    name: kind === "favorites" ? protocol.FAVORITES_FILING_PORT : protocol.BOOKMARKS_FILING_PORT,
    getContext: () => {
      const model = readLibrary(); const store = model[kind];
      const candidate = store?.view?.groupId;
      const active = isReady() && state.route === kind && !document.hidden && store
        && !(kind === "bookmarks" && store.view?.query?.trim());
      return { accountKey: model.accountKey,
        groupId: active && store.groups?.some(group => group.id === candidate) ? candidate : null };
    },
  });
}
const libraryPanel = createLibraryPanelController({
  ownerTabId: panelOwnerTabId, readLibrary, readRoute: () => state.route, isReady,
  readPresentation: () => ({ snapshot: readSnapshot(), preferences: state.preferences, t }),
  views: {
    favorites: { root: elements.favoritesRoot, reset: favoritesView.reset, render: favoritesView.render },
    bookmarks: { root: elements.bookmarksRoot, reset: bookmarksView.reset, render: bookmarksView.render },
  },
  navigation: { cancel: bookmarkNavigation.cancel, pendingConversationId: bookmarkNavigation.pendingConversationId,
    pendingBookmarkId: bookmarkNavigation.pendingBookmarkId },
  presentation: shell, selectionState: exportSelection.selectionState,
  filing: { favorites: () => filing.favorites.sync(), bookmarks: () => filing.bookmarks.sync() },
  refreshLibrary: library.refresh, navigate: setRoute,
  onChanged: () => { syncExportContext(); renderPageConnection(); renderExport(); renderLibraryViews(); backupView.update(); },
});
const favoritesActions = createFavoritesActions({
  ownerTabId: panelOwnerTabId, isReady, captureOwner: library.capture, isOwnerCurrent: library.isCurrent,
  acceptMutation: (owner, result) => library.acceptMutation(owner, "favorites", result),
  refresh: library.refresh, request: sendRequest, toast: showToast,
  readCurrentConversation: () => {
    const conversationId = readSnapshot()?.conversation?.conversationId || null;
    return { conversationId, isFavorite: Boolean(conversationId && readLibrary().favorites?.items?.[conversationId]) };
  },
  beginNavigation: target => panelNavigation.begin("favorites", target),
  isNavigationCurrent: panelNavigation.isCurrent, isNavigationCompleted: panelNavigation.isCompleted,
});
const bookmarksActions = createBookmarksActions({
  ownerTabId: panelOwnerTabId, isReady, captureOwner: library.capture, isOwnerCurrent: library.isCurrent,
  acceptMutation: (owner, result) => library.acceptMutation(owner, "bookmarks", result),
  refresh: library.refresh, request: sendRequest, toast: showToast,
  readCurrentConversationId: () => readSnapshot()?.conversation?.conversationId,
  startNavigation: bookmarkNavigation.start,
});
const searchActions = createSearchActions({
  ownerTabId: panelOwnerTabId, protocol, isReady, request: sendRequest,
  dateSearch: conversationDateSearch, pauseTitleCatalog: () => titleCatalog.pause(), navigation: panelNavigation, notice,
});
const exportWorkflow = createExportWorkflow({
  selection: exportSelection, isReady, readRoute: () => state.route, navigate: setRoute,
  prepareDateExport: () => searchView.prepareDateExport(), readSearchItems: () => searchView.exportItems(),
  showSearchToast,
  ensureSource: source => { if (["favorites", "bookmarks"].includes(source) && !readLibrary()[source]) void library.refresh(); },
  setDestination: ({ mode, settings }) => { exportView.setMode(mode); exportView.setSettingsView(settings); },
  onChanged: renderAll,
});
const navigationResults = createPanelNavigationCoordinator({
  ownerTabId: panelOwnerTabId, owner: panelNavigation, phase: () => state.pageSession.phase,
  consumers: { bookmarks: bookmarkNavigation.complete, search: payload => searchView.completeNavigation(payload), favorites: () => true },
  onOpenFailed: (payload, route) => {
    showToast(payload.error?.code === protocol.ErrorCode.CONTEXT_MISMATCH ? "contextChanged" : "bookmarkOpenFailed", true, {},
      { owner: route, terminalNavigationIntentId: payload.navigationIntentId, durationMs: 5000, cause: payload.error });
  },
  onCancelled: ({ navigationIntentId, reason }) => {
    bookmarkNavigation.cancelId(navigationIntentId, reason); searchView.cancelId(navigationIntentId);
  },
  onCompleted: (payload, route) => {
    if (payload.located || ["user-cancelled", "cancelled", "superseded"].includes(payload.reason)) {
      if (route === "search") finishSearchNotice(payload.navigationIntentId);
      return;
    }
    if (route === "search") showSearchToast(payload.placement === "latest" ? "favoriteLatestUnavailable" : "actionFailed", payload.navigationIntentId);
    else if (route === "favorites") showToast("favoriteLatestUnavailable", true, {},
      { owner: "favorites", navigationIntentId: payload.navigationIntentId, durationMs: 5000 });
  },
});
const context = createPanelContextController({
  ownerTabId: panelOwnerTabId, isReady, isValidTabId, routeKey: panelContext.routeKey, request: sendRequest,
  contextType: protocol.Type.GET_ACTIVE_CONTEXT, errorCodes: protocol.ErrorCode,
  acceptsSnapshot: bookmarkNavigation.acceptsSnapshot, onRequestedRoute: payload => libraryPanel.requestRoute(payload),
  onChanged: (_model, reason) => {
    if (!mounted) return;
    renderPreview();
    if (reason === "loading" || reason === "suspended") return;
    libraryPanel.reconcileContext();
    searchView.setConversationId(readSnapshot()?.conversation?.conversationId || null);
    syncExportContext(); renderExport(); renderTitles(); renderLibraryViews();
  },
});
const pageSession = createPageSessionController({
  probe: () => client.transmit(protocol.Type.PAGE_SESSION_PROBE, { expectedTabId: panelOwnerTabId }),
  onChanged: handlePageSession,
});

// 只有生命周期转换协调模块启停。显示函数不会启动请求或修改跨栏导出选择。
function handlePageSession(next) {
  const wasReady = state.pageSession.phase === "ready";
  state.pageSession = next;
  if (next.phase !== "ready") {
    preferenceController.suspend(); titleRulesController.suspend(); context.suspend(); dismissToast();
    timeView.setAvailable(false); elements.close.disabled = false;
    if (next.phase === "refresh-required") {
      navigationResults.clear(); panelNavigation.close("page-session-unavailable");
      bookmarkNavigation.cancel("page-session-unavailable"); searchView.setTabId(null, { renderNow: false });
    }
    if (wasReady) {
      library.invalidate(); library.setVisible(false);
      searchView.setActive(false, { preserveNavigation: next.phase === "connecting", invalidateReads: true });
      if (next.phase === "refresh-required") searchView.setTabId(null, { renderNow: false });
      backupView.setActive(false);
      void titleCatalog.pause(); void conversationDateSearch.pause("page-session-unavailable");
      titleView.update({ snapshot: null, preferences: state.preferences, translator: t, active: false });
      syncExportContext(); filing.favorites.sync(); filing.bookmarks.sync();
    }
    renderPageConnection(); return;
  }
  if (!wasReady) {
    preferenceController.resume(); void titleRulesController.resume();
    timeView.setAvailable(true); library.setVisible(!document.hidden);
    searchView.setTabId(panelOwnerTabId, { renderNow: false }); searchView.setVisible(!document.hidden);
    syncRouteActivity(); syncExportContext(); renderAll();
    void context.refresh(); void library.refresh(); navigationResults.flush();
  }
}
function syncRouteActivity() {
  if (state.route !== "search") dismissSearchToast();
  for (const route of ["favorites", "bookmarks"]) if (state.route !== route) notice.dismissOwnedToast(route);
  backupView.setActive(isReady() && state.route === "settings");
  panelNavigation.leave(state.route);
  searchView.setActive(isReady() && state.route === "search");
  filing.favorites.sync(); filing.bookmarks.sync();
}
function syncExportContext() {
  const model = readLibrary();
  if (!isReady() || !model.accountKey) {
    // 身份待确认只是锁定，不是新账号。保留已提交篮，fresh不同owner才清空。
    exportView.suspend({ translator: t, preferences: state.preferences, active: isReady() && state.route === "export" });
    return;
  }
  exportSelection.updateSources({ accountKey: model.accountKey, verified: true,
    favorites: model.favorites, bookmarks: model.bookmarks });
  exportView.updateContext({ accountKey: model.accountKey, snapshot: readSnapshot(), preferences: state.preferences,
    translator: t, active: state.route === "export", favorites: model.favorites, bookmarks: model.bookmarks });
}
function setRoute(route) {
  const button = elements.routes.find(candidate => candidate.dataset.route === route);
  if (!PANEL_ROUTES[route] || button?.disabled) return;
  if (isReady() && state.route === "titles" && route !== "titles" && !titleView.canLeave()) return;
  // 菜单和删除确认只属于当前栏目；离开时两栏共用收起规则，但保留输入草稿。
  if (state.route !== route) libraryViews[state.route]?.dismissTransientUi();
  if (route !== "titles") void titleCatalog.pause();
  exportWorkflow.leave(route);
  state.route = route;
  if (route !== "bookmarks") bookmarkNavigation.cancel();
  if (route === "time") timeView.renderDateFormatLabels(state.preferences);
  syncRouteActivity(); syncExportContext(); renderAll();
}
function formatTimestamp(value, preferences = state.preferences) {
  return timeFormat.formatDateTime(value, { timeZone: effectiveTimeZone(preferences),
    locale: LANGUAGE_LOCALES[preferences?.language] || "en-US", dateFormat: preferences?.dateFormat || "locale",
    precision: preferences?.messageTimePrecision || "second" });
}
function renderPageConnection() {
  const refreshRequired = shell.renderPageConnection({ pageSession: state.pageSession, route: state.route,
    onReconnect: () => { void pageSession.check(); } });
  shell.renderContextStatus({ route: state.route, error: context.get().error,
    hasSnapshot: Boolean(readSnapshot()), refreshRequired });
  return refreshRequired;
}
function renderPreview() {
  renderPageConnection(); backupView.update();
  shell.applyTheme({ themeName: state.preferences.theme, appearance: readSnapshot()?.appearance });
  settingsView.updateTheme({ preferences: state.preferences, appearance: shell.currentAppearance(readSnapshot()?.appearance) });
  timeView.renderPreview({ snapshot: readSnapshot(), preferences: state.preferences, translator: t });
}
function renderSearch() {
  searchView.render({ translator: t, exportSelection: exportSelection.selectionState("search"),
    timeZone: effectiveTimeZone(state.preferences), formatTimestamp: value => formatTimestamp(value) });
}
function renderExport() { exportView.render(); renderExportDockBadge(); }
function renderExportDockBadge() { shell.renderExportDockBadge({ count: exportSelection.basketCount(), busy: exportView.hasActiveJob() }); }
function renderTitles() { titleView.update({ snapshot: readSnapshot(), preferences: state.preferences,
  translator: t, active: isReady() && state.route === "titles" && !document.hidden }); }
function renderLibraryViews() { libraryPanel.renderFavorites(); libraryPanel.renderBookmarks(); renderExportDockBadge(); }
function renderSourceViews() { renderLibraryViews(); renderSearch(); }
function renderPreferenceNotice() { shell.renderPreferenceNotice({ error: preferenceError, onRetry: () => preferenceController.load() }); }
function renderAll() {
  shell.localize(state.preferences.language); renderToast(); backupView.update();
  shell.applyTheme({ themeName: state.preferences.theme, appearance: readSnapshot()?.appearance });
  shell.renderModuleChrome({ route: state.route, ready: isReady(), selection: exportSelection.selectionContext() });
  settingsView.update({ preferences: state.preferences, translator: t, appearance: shell.currentAppearance(readSnapshot()?.appearance) });
  renderDiagnostics();
  timeView.renderControls({ preferences: state.preferences, translator: t });
  renderPreview(); renderTitles(); renderSourceViews(); renderExport(); renderPreferenceNotice(); renderPageConnection();
}
function applyPreferences(preferences, changed) {
  state.preferences = preferences; t = createTranslator(preferences.language);
  if (!mounted) return;
  if (changed.length === 1 && changed[0] === "theme") {
    shell.applyTheme({ themeName: preferences.theme, appearance: readSnapshot()?.appearance });
    settingsView.updateTheme({ preferences, appearance: shell.currentAppearance(readSnapshot()?.appearance) });
  } else { syncExportContext(); renderAll(); }
}
function savePreference(patch) { return isReady() ? preferenceController.save(patch) : Promise.resolve(null); }
function moduleError(error) { return { code: error?.code || protocol.ErrorCode.INTERNAL_ERROR, message: error?.message || "",
  ...(error?.requestId ? { requestId: error.requestId } : {}) }; }
function invalidateContext(payload) {
  context.invalidate(payload);
  if (isReady() && payload?.documentId === state.pageSession.documentId) void context.refresh({ expectedRouteKey: context.get().routeKey });
  else void pageSession.check({ contextChanged: true });
}

const lifecycle = installPanelLifecycle({
  document, window, isReady, getRoute: () => state.route, getContextError: () => context.get().error,
  refreshContext: context.refresh, dismissNotice: dismissToast,
  session: { check: pageSession.check, dispose: () => {
    disposed = true; pageSession.dispose(); context.dispose(); disposeDiagnostics(); notice.dispose();
    favoritesView.dispose(); bookmarksView.dispose(); libraryConfirmation.dispose();
  } },
  navigation: { close: reason => {
    panelNavigation.close(reason);
    notice.dismissOwnedToast("favorites"); notice.dismissOwnedToast("bookmarks");
  } }, bookmarks: bookmarkNavigation,
  search: { setVisible: value => searchView.setVisible(value) }, library,
  titles: { render: renderTitles, isBusy: () => !titleView.canLeave(),
    suspend: () => titleView.update({ snapshot: readSnapshot(), preferences: state.preferences, translator: t, active: false }),
    pauseCatalog: () => titleCatalog.pause() },
  preferences: preferenceController, titleRules: titleRulesController,
  time: { dispose: timeView.dispose, becameVisible: () => timeView.renderDateFormatLabels(state.preferences) },
  settings: settingsView, backup: backupView,
  filing: { syncFavorites: () => filing.favorites.sync(), syncBookmarks: () => filing.bookmarks.sync(),
    closeFavorites: () => filing.favorites.close(), closeBookmarks: () => filing.bookmarks.close() },
});
elements.routes.forEach(button => button.addEventListener("click", () => setRoute(button.dataset.route)));
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !event.defaultPrevented && exportWorkflow.back()) event.preventDefault();
});
elements.close.addEventListener("click", async () => {
  if (isReady() && state.route === "titles" && !titleView.canLeave()) return;
  if (exportWorkflow.back()) return;
  bookmarkNavigation.cancel(); panelNavigation.close(); searchView.setVisible(false);
  filing.favorites.close(); filing.bookmarks.close();
  try {
    if (typeof chrome.sidePanel?.close === "function") {
      await chrome.sidePanel.close(isValidTabId(panelOwnerTabId) ? { tabId: panelOwnerTabId } : {}); return;
    }
  } catch { /* Browser window fallback if close is unavailable. */ }
  window.close();
});
document.addEventListener("click", event => {
  if (event.target.closest("[data-retry-library]")) {
    if (isReady() && !document.hidden) void library.refresh({ retryIdentity: true });
  } else if (event.target.closest("[data-retry-context]")) void context.refresh();
});
chrome.runtime.onMessage.addListener(envelope => {
  if (disposed || !protocol.isEnvelope(envelope) || envelope.kind !== protocol.Kind.EVENT) return;
  const payload = envelope.payload;
  if (!isReady()) {
    if (envelope.type === protocol.Type.NAVIGATION_CANCELLED) navigationResults.cancelled(payload);
    else if (envelope.type === protocol.Type.NAVIGATION_RESULT) navigationResults.receive(payload);
    else if (envelope.type === protocol.Type.CONTEXT_CHANGED && payload?.tabId === panelOwnerTabId) invalidateContext(payload);
    else if (envelope.type === protocol.Type.SNAPSHOT_UPDATED && payload?.tabId === panelOwnerTabId) void pageSession.check();
    return;
  }
  if (envelope.type === protocol.Type.TITLE_CATALOG_CHANGED) void titleCatalog.changed(payload).catch(() => {});
  else if (envelope.type === protocol.Type.NAVIGATION_CANCELLED) navigationResults.cancelled(payload);
  else if (envelope.type === protocol.Type.NAVIGATION_RESULT) navigationResults.receive(payload);
  else if (envelope.type === protocol.Type.LIBRARY_IDENTITY_CHANGED) {
    if (payload?.tabId === panelOwnerTabId) library.observeIdentity(payload);
  } else if (envelope.type === protocol.Type.CONTEXT_CHANGED) {
    if (!isValidTabId(panelOwnerTabId) || payload?.tabId !== panelOwnerTabId) return;
    if (payload.reason === "document-load-complete" && payload.documentId === state.pageSession.documentId) return;
    invalidateContext(payload);
  } else if (envelope.type === protocol.Type.SNAPSHOT_UPDATED) context.acceptSnapshot(payload);
  else if ([protocol.Type.FAVORITES_UPDATED, protocol.Type.BOOKMARKS_UPDATED].includes(envelope.type)) {
    library.observeRevision(envelope.type === protocol.Type.FAVORITES_UPDATED ? "favorites" : "bookmarks", payload);
  } else if (envelope.type === protocol.Type.PANEL_ROUTE_REQUESTED) libraryPanel.requestRoute(payload);
  else if (envelope.type === protocol.Type.EXPORT_JOB_CHANGED) {
    if (payload?.tabId === panelOwnerTabId) void exportView.refreshJob();
  } else if (envelope.type === protocol.Type.EXPORT_PREVIEW_CLOSED && payload?.tabId === panelOwnerTabId) {
    exportView.handleFullPreviewClosed(payload?.sessionId);
  }
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (!disposed && areaName === "sync" && changes[PREFERENCES_KEY]) preferenceController.observe(changes[PREFERENCES_KEY].newValue);
});

function renderDiagnostics() {
  try { diagnosticsView?.update({ translator: t }); } catch { /* 只读旁路失败不阻塞业务呈现。 */ }
}
function disposeDiagnostics() {
  try { diagnosticsView?.dispose(); } catch { /* 继续清理其他模块。 */ }
}

// 诊断是旁路能力。缺失/拒绝不能阻塞设置页、备份或任何业务生命周期。
async function mountDiagnostics() {
  try {
    await import("../../platform/diagnostics/wire.js");
    await import("../../platform/diagnostics/client.js");
    await import("../../platform/diagnostics/runtime.js");
    const { createDiagnosticsView } = await import("../../features/settings/ui/diagnostics-view.js");
    if (disposed) return;
    const root = document.getElementById("settings-diagnostics");
    if (!root || !globalThis.TidyDiagnosticsClient) return;
    diagnosticsView = createDiagnosticsView({ root, client: globalThis.TidyDiagnosticsClient,
      writeClipboard: text => navigator.clipboard.writeText(text) });
    diagnosticsView.update({ translator: t });
  } catch { /* Optional diagnostics must never stop a functional panel. */ }
}
async function init() {
  mounted = true;
  syncExportContext(); renderAll();
  searchView.setTabId(panelOwnerTabId, { renderNow: false });
  filing.favorites.connect(); filing.bookmarks.connect();
  void preferenceController.load(); void mountDiagnostics();
  await pageSession.check();
}
void init().catch(error => {
  filing.favorites.close(); filing.bookmarks.close(); context.fail(error);
});
