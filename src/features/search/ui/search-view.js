import { searchFailure } from "./search-failure-presentation.js";
import { createSearchCalendar } from "./search-calendar.js";
import { createSearchQueryController } from "./search-query-controller.js";
import { createSearchResultNavigation } from "./search-result-navigation.js";
import { searchPhase, searchViewModel } from "./search-view-model.js";
import { createSearchMarkup } from "./search-presentation.js";

// Composition root for search: DOM events/focus/layout only. Query and receipt
// owners have no DOM dependencies, and presentation has no business callbacks.
export function createSearchView({ root, onAction, onExportAction = () => {}, onInteraction = () => {},
  onExportSourcesChange = () => {}, createIntentId = () => globalThis.TidyProtocol.createRequestId("navigation") }) {
  let t = key => key;
  let exportSelection = { active: false };
  let capacityQueued = false;
  let statusAnimationStartedAt = null;
  let observedNotice = null;
  const navigation = createSearchResultNavigation({ onAction, createIntentId });
  const controller = createSearchQueryController({ onAction, onInteraction,
    onChange: paint, onNoticeClear: updateNoticePresentation, onExportSourcesChange,
    cancelNavigation: navigation.cancel, onCalendarClose: () => dateCalendar.close(),
    initiallyVisible: document.hidden !== true });
  const dateCalendar = createSearchCalendar({ root, translate: (...args) => t(...args), onRender: options => paint(options),
    readSelection: controller.readDateSelection,
    isRangeValid: () => controller.criteria().valid,
    onChange: (range, target) => { controller.changeDateRange(range); paint({ dateFocus: { key: "searchDate", value: target } }); },
  });
  const exportFocusKeys = ["exportDraftConversation", "exportSelectCurrent", "exportSelectionSubmit", "exportSelectionBack"];
  const selectingExport = () => controller.readContext().mode === "date" && exportSelection.active === true;

  function updateNoticePresentation() {
    for (const element of root.querySelectorAll(".search-date-error, .search-keyword-error")) element.remove();
    root.querySelector(".search-status__label")?.classList.toggle("search-status__label--sr-only", searchPhase(controller.snapshot()) !== "paused");
  }
  function observeNotice(notice) {
    if (!notice || notice === observedNotice) return;
    observedNotice = notice;
    const { messageKey } = searchFailure(notice.error, notice.mode === "date" ? "searchDateReadFailed" : "searchKeywordIncomplete");
    globalThis.ChatGPTTidyDiagnostics?.notice({ event: "show", surface: "search.error",
      source: "src/features/search/ui/search-view.js", messageKey, ...globalThis.ChatGPTTidyDiagnostics?.cause(notice.error) });
  }
  function focusedDateControl(active) {
    if (!active || !root.contains(active)) return null;
    const key = exportFocusKeys.find(name => Object.hasOwn(active.dataset || {}, name));
    return key ? { key, value: active.dataset[key] } : dateCalendar.captureFocus(active);
  }

  function restoreDateControlFocus(request) {
    if (!request || controller.readContext().mode !== "date") return;
    if (!exportFocusKeys.includes(request.key)) { dateCalendar.restoreFocus(request); return; }
    const key = request.key;
    const attribute = key.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase());
    [...root.querySelectorAll("[data-" + attribute + "]")]
      .find(node => node.dataset[key] === request.value && !node.disabled)?.focus({ preventScroll: true });
  }

  // Public render is an input adapter; repeated paint never changes criteria.
  function render(options = {}) {
    t = options.translator || t;
    if (Object.hasOwn(options, "exportSelection")) exportSelection = options.exportSelection || { active: false };
    controller.setTimeZone(options.timeZone);
    paint(options);
  }
  function paint(options = {}) {
    const state = controller.snapshot();
    const working = ["searching", "refreshing"].includes(searchPhase(state));
    statusAnimationStartedAt = working ? statusAnimationStartedAt ?? Date.now() : null;
    observeNotice(state.errorNotice);
    const active = document.activeElement;
    const dateFocus = options.dateFocus || focusedDateControl(active);
    const keywordFocusKey = state.mode === "keyword" && root.contains(active)
      ? ["searchKeywordTitle", "searchMatchId", "searchResultId", "searchPageSize", "searchPageDirection", "searchPageInput",
        "searchRefreshKeyword", "searchKeywordRetry"].find((key) => Object.hasOwn(active?.dataset || {}, key)) : null;
    const keywordFocus = keywordFocusKey ? { key: keywordFocusKey, value: active.dataset[keywordFocusKey] } : null;
    const restoreQueryFocus = active?.matches?.("[data-global-search]");
    const selection = restoreQueryFocus ? [active.selectionStart, active.selectionEnd] : null;
    const model = searchViewModel(state, exportSelection, controller.exportItems(), statusAnimationStartedAt);
    const panel = createSearchMarkup({ ...model, calendar: { controls: state.mode === "date" ? dateCalendar.controls() : null, overlay: state.mode === "date" ? dateCalendar.overlay() : null } }, t);
    root.replaceChildren(panel);
    dateCalendar.position();
    const resultList = root.querySelector("[data-search-result-list]");
    if (resultList) resultList.scrollTop = state.scrollTop;
    if (restoreQueryFocus) queueMicrotask(() => {
      const input = root.querySelector("[data-global-search]");
      input?.focus();
      input?.setSelectionRange?.(selection[0], selection[1]);
    });
    // Synchronous restoration belongs to this render only; queued old renders
    // must not steal focus from a later click on the other endpoint.
    restoreDateControlFocus(dateFocus);
    // Background pages must not steal keyboard focus from a result or pager.
    if (keywordFocus) {
      const attribute = keywordFocus.key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      const target = [...root.querySelectorAll(`[data-${attribute}]`)].find((node) =>
        node.dataset[keywordFocus.key] === keywordFocus.value);
      target?.focus({ preventScroll: true });
    }
    queueKeywordCapacity();

  }
  function keywordAnchor() {
    const list = root.querySelector("[data-search-result-list]");
    const row = root.querySelector("[data-search-keyword-result]");
    return { scrollTop: list?.scrollTop || controller.readContext().scrollTop,
      rowHeight: (row?.getBoundingClientRect?.().height || 92) + 2 };
  }
  function updateKeywordCapacity() {
    const state = controller.readContext();
    if (state.mode !== "keyword" || !state.active || !state.visible) return;
    const list = root.querySelector("[data-search-result-list]");
    const height = list?.getBoundingClientRect?.().height || 0;
    if (height <= 0) return;
    const row = root.querySelector("[data-search-keyword-result]");
    const style = typeof getComputedStyle === "function" ? getComputedStyle(list) : null;
    const rowHeight = row?.getBoundingClientRect?.().height
      || Number.parseFloat(style?.getPropertyValue("--keyword-result-height")) || 92;
    const gap = Number.parseFloat(style?.rowGap) || 2;
    const size = Math.max(1, Math.min(60, Math.floor((height + gap) / (rowHeight + gap))));
    if (size === state.keywordAutoSize) return;
    controller.setKeywordCapacity(size, keywordAnchor());
  }
  function queueKeywordCapacity() {
    if (capacityQueued || controller.readContext().mode !== "keyword") return;
    capacityQueued = true;
    queueMicrotask(() => { capacityQueued = false; updateKeywordCapacity(); });
  }

  function setActiveResult(resultId) {
    controller.selectResult(resultId);
    for (const node of root.querySelectorAll("[data-search-active-result]")) {
      const selected = node.dataset.searchActiveResult === resultId;
      node.classList.toggle("is-active", selected);
      node.setAttribute("aria-current", selected ? "true" : "false");
    }
  }
  function openResult(item, kind) {
    setActiveResult(item.resultId);
    controller.beginInteraction();
    navigation.open({ ...item, navigationKind: kind, ...(kind === "keyword"
      ? { query: controller.readContext().query.trim() } : { messageId: null, query: "" }) });
  }
  function setConversationId(id) {
    const next = typeof id === "string" && id ? id : null;
    const selected = controller.setConversationId(next, { preserveInteraction: navigation.ownsConversationTransition(next) });
    setActiveResult(selected);
  }

  function handleExport(control) {
    if (controller.readContext().mode !== "date" || control.disabled) return;
    controller.beginInteraction();
    const payload = { source: "search" };
    const items = controller.exportItems();
    const owns = key => Object.hasOwn(control.dataset, key);
    if (owns("exportSelectMode")) { if (items.length) void onExportAction("start", payload); }
    else if (owns("exportViewBasket")) void onExportAction("view-basket", payload);
    else if (selectingExport()) {
      if (owns("exportSelectionBack")) void onExportAction("selection-back", payload);
      else if (owns("exportSelectionSubmit")) { if (exportSelection.draftIds?.length) void onExportAction("submit", payload); }
      else if (owns("exportSelectCurrent")) {
        const ids = items.map(item => item.conversationId).filter(id => !exportSelection.basketConversationSources?.[id]?.includes("search"));
        if (ids.length) void onExportAction("select-current", { ...payload, ids });
      } else {
        const id = control.dataset.exportDraftConversation;
        if (items.some(item => item.conversationId === id) && !exportSelection.basketConversationSources?.[id]?.includes("search"))
          void onExportAction("toggle", { ...payload, id });
      }
    }
  }
  root.addEventListener("compositionstart", () => { if (controller.readContext().mode === "keyword") controller.setComposing(true); });
  root.addEventListener("compositionend", event => { if (event.target.matches("[data-global-search]")) controller.setComposing(false); });
  root.addEventListener("input", event => { if (event.target.matches("[data-global-search]")) controller.changeQuery(event.target.value); });
  root.addEventListener("change", event => {
    if (event.target.matches("[data-search-sort-field]")) controller.changeSort({ field: event.target.value });
    else if (event.target.matches("[data-search-page-size]")) controller.changePageSize(event.target.value === "auto" ? "auto" : Number(event.target.value), keywordAnchor());
  });
  root.addEventListener("click", event => {
    const state = controller.readContext();
    const target = event.target;
    const exportControl = target.closest("[data-export-select-mode], [data-export-draft-conversation], [data-export-select-current], [data-export-selection-submit], [data-export-selection-back], [data-export-view-basket]");
    if (exportControl) { handleExport(exportControl); return; }
    if (target.closest("[data-search-keyword-retry]")) { void controller.retry(); return; }
    const keywordRefresh = target.closest("[data-search-refresh-keyword]");
    if (keywordRefresh) { if (!keywordRefresh.disabled) void controller.refreshKeyword(); return; }
    const refresh = target.closest("[data-search-refresh-catalog]");
    if (refresh && !refresh.disabled) { void controller.refreshDirectory(); return; }
    const mode = target.closest("[data-search-mode]");
    if (mode) { if (!selectingExport() && !mode.disabled) controller.changeMode(mode.dataset.searchMode); return; }
    const basis = target.closest("[data-search-date-field]");
    if (basis && state.mode === "date") { controller.changeDateField(basis.dataset.searchDateField); return; }
    const calendarClick = state.mode === "date" ? dateCalendar.click(target) : null;
    if (calendarClick?.handled) return;
    if (state.mode === "date" && target.closest("[data-search-sort-direction]")) {
      controller.changeSort({ direction: state.sortDirection === "asc" ? "desc" : "asc" }); return;
    }
    const page = target.closest("[data-search-page-direction]");
    if (page?.dataset.searchPageDirection === "previous" && state.page > 1) { controller.previousPage(); return; }
    if (page?.dataset.searchPageDirection === "next" && !page.disabled) { void controller.nextPage(); return; }
    if (selectingExport()) return;
    if (state.mode === "keyword") {
      const card = target.closest("[data-search-keyword-result]");
      const item = card ? controller.findResult({ resultId: card.dataset.searchKeywordResult }) : null;
      if (item) openResult(item, "keyword");
      return;
    }
    const result = target.closest("[data-search-result-id]");
    const conversation = target.closest("[data-search-conversation-card]");
    if (!result && !conversation) { if (calendarClick?.closed) paint(); return; }
    const item = controller.findResult(result ? { resultId: result.dataset.searchResultId }
      : { conversationId: conversation.dataset.searchConversationCard });
    if (item) openResult(item, "conversation");
  });
  root.addEventListener("keydown", event => {
    const state = controller.readContext();
    if (event.target.matches("[data-search-page-input]") && event.key === "Enter" && state.mode === "keyword" && state.keywordComplete) {
      event.preventDefault(); controller.goToPage(Number(event.target.value)); return;
    }
    if (dateCalendar.keydown(event)) return;
    if (!event.target.matches("[data-search-result-id]") || !["Enter", " "].includes(event.key)) return;
    event.preventDefault(); event.target.click();
  });
  root.addEventListener("scroll", event => { if (event.target.matches?.("[data-search-result-list]")) controller.setScrollTop(event.target.scrollTop); }, true);
  document.addEventListener("pointerdown", event => dateCalendar.dismissOutside(event.target), true);
  if (typeof ResizeObserver === "function") new ResizeObserver(queueKeywordCapacity).observe(root);
  const { setTabId, setIndexStatus, setActive, setVisible, prepareDateExport, exportItems } = controller;
  const { cancelId, complete: completeNavigation } = navigation;
  return Object.freeze({ render, setTabId, setIndexStatus, setActive, setVisible, prepareDateExport, exportItems, setConversationId, cancelId, completeNavigation });
}
