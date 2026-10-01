import { searchFailure } from "./search-failure-presentation.js";
import { createKeywordMatcher, keywordExcerpt } from "./keyword-excerpt.js";
import { createLoadingFlower } from "../../../platform/ui/loading-flower.js";
const searchContract = globalThis.TidySearch;
const SEARCH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="5.8"></circle><path d="m15.2 15.2 4.4 4.4"></path></svg>';
const REFRESH_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 6A5.4 5.4 0 1 0 13 10M13.2 2.5V6H9.7"></path></svg>';

function appendHighlightedText(parent, value, query) {
  const text = String(value || "");
  const matcher = createKeywordMatcher(query);
  if (!matcher) {
    parent.textContent = text;
    return;
  }
  let cursor = 0;
  for (const match of text.matchAll(matcher)) {
    const index = match.index ?? 0;
    if (index > cursor) parent.append(document.createTextNode(text.slice(cursor, index)));
    const mark = document.createElement("mark");
    mark.textContent = match[0];
    parent.append(mark);
    cursor = index + match[0].length;
  }
  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
}


// Pure DOM construction: no owner mutation, dispatch, timers, or diagnostics.
export function createSearchMarkup({ controls: controlModel, results, pagination, status, selection, calendar: calendarModel }, t) {
  function makeModeTabs() {
    const tabs = document.createElement("div");
    tabs.className = "search-mode-tabs";
    tabs.role = "tablist";
    tabs.setAttribute("aria-label", t("globalSearch"));
    for (const mode of ["keyword", "date"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.role = "tab";
      button.dataset.searchMode = mode;
      button.disabled = selection.active && mode === "keyword";
      button.setAttribute("aria-selected", String(controlModel.mode === mode));
      button.textContent = t(mode === "keyword" ? "searchKeywordMode" : "searchDateMode");
      tabs.append(button);
    }
    return tabs;
  }

  function makeDateBasis() {
    const group = document.createElement("div");
    group.className = "search-date-control-group";
    const label = document.createElement("span");
    label.className = "search-control-caption";
    label.textContent = t("searchDateBasis");
    const controls = document.createElement("div");
    controls.className = "search-date-basis";
    controls.role = "group";
    controls.setAttribute("aria-label", t("searchDateBasis"));
    for (const field of ["createdAt", "updatedAt"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.searchDateField = field;
      button.setAttribute("aria-pressed", String(controlModel.dateField === field));
      button.textContent = t(field === "createdAt" ? "createdTime" : "updatedTime");
      controls.append(button);
    }
    group.append(label, controls);
    return group;
  }

  function formatConversationDate(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return t("noTime");
    // Conversation-date cards always show a calendar date in the selected
    // timezone, independently of message timestamp precision settings.
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: results.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function makeKeywordControl() {
    const label = document.createElement("label");
    label.className = "global-search-input";
    const icon = document.createElement("span");
    icon.className = "global-search-input__icon";
    icon.innerHTML = SEARCH_ICON;
    const input = document.createElement("input");
    input.type = "search";
    input.maxLength = searchContract.MAX_QUERY_LENGTH;
    input.dataset.globalSearch = "";
    input.value = controlModel.query;
    input.placeholder = t("searchMessagesPlaceholder");
    input.setAttribute("aria-label", t("searchMessages"));
    label.append(icon, input);
    return label;
  }

  function makeSortSection() {
    const section = document.createElement("section");
    section.className = "search-sort-section";
    const heading = document.createElement("div");
    heading.className = "search-section-heading";
    const label = document.createElement("span");
    label.textContent = t("sort");
    const control = document.createElement("div");
    control.className = "search-sort-control";
    const field = document.createElement("select");
    field.className = "search-sort-field";
    field.dataset.searchSortField = "";
    field.setAttribute("aria-label", t("searchDateSortField"));
    for (const value of ["createdAt", "updatedAt"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = t(value === "createdAt" ? "createdTime" : "updatedTime");
      option.selected = controlModel.sortField === value;
      field.append(option);
    }
    const direction = document.createElement("button");
    direction.type = "button";
    direction.dataset.searchSortDirection = "";
    // Keep the visual control compact; its accessible name describes both
    // the independent sort field and direction, also exposed in the tooltip.
    direction.textContent = controlModel.sortDirection === "asc" ? "↑" : "↓";
    direction.setAttribute("aria-label", t(controlModel.sortDirection === "asc" ? "sortAscending" : "sortDescending", {
      field: t(controlModel.sortField === "createdAt" ? "createdTime" : "updatedTime"),
    }));
    direction.title = direction.getAttribute?.("aria-label") || t(controlModel.sortDirection === "asc" ? "ascending" : "descending");
    control.append(field, direction);
    heading.append(label, control);
    section.append(heading);
    return section;
  }

  function makeConversationResult(item) {
    if (controlModel.mode === "keyword") return makeKeywordResult(item);
    if (selection.active) return makeExportResult(item);
    const article = document.createElement("article");
    article.className = "search-result search-result--conversation";
    article.dataset.searchConversationCard = item.conversationId;
    article.dataset.searchActiveResult = item.resultId;
    article.classList.toggle("is-active", results.activeResultId === item.resultId);

    const header = document.createElement("div");
    header.className = "search-result__conversation-head";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "search-result__conversation-main";
    open.dataset.searchResultId = item.resultId;
    open.setAttribute("aria-label", `${t("openConversation")}: ${item.title || t("untitled")}`);
    const title = document.createElement("strong");
    title.className = "search-result__source";
    appendHighlightedText(title, item.title || t("untitled"), "");
    open.append(title);
    header.append(open);
    article.append(header);

    article.append(makeConversationDates(item));
    return article;
  }

  function makeConversationDates(item) {
    const summary = document.createElement("div");
    summary.className = "search-result__conversation-summary";
    // These are conversation-directory timestamps, never message times.
    for (const [field, value] of [["createdAt", item.conversationCreatedAt], ["updatedAt", item.conversationUpdatedAt]]) {
      const line = document.createElement("div");
      line.className = "search-result__conversation-time";
      line.dataset.searchConversationTime = field;
      line.classList.toggle("is-selected", controlModel.dateField === field);
      const label = document.createElement("span");
      label.textContent = t(field === "createdAt" ? "created" : "updated");
      const time = document.createElement(value ? "time" : "span");
      if (value) time.dateTime = value;
      time.textContent = formatConversationDate(value);
      line.append(label, time);
      if (field === "updatedAt") {
        const separator = document.createElement("span");
        separator.className = "search-result__time-separator";
        separator.setAttribute("aria-hidden", "true");
        separator.textContent = "·";
        summary.append(separator);
      }
      summary.append(line);
    }
    return summary;
  }

  function makeExportResult(item) {
    const sources = selection.basketConversationSources?.[item.conversationId] || [];
    const added = sources.includes("search");
    const selected = selection.draftIds?.includes(item.conversationId) === true;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "source-export-row search-export-row";
    row.classList.toggle("is-selected", selected);
    row.classList.toggle("is-added", added);
    row.dataset.exportDraftConversation = item.conversationId;
    row.setAttribute("aria-pressed", String(selected));
    row.disabled = added || !selection.items.some((candidate) => candidate.conversationId === item.conversationId);
    const check = document.createElement("span");
    check.className = "source-export-check";
    check.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "source-export-row__copy";
    const title = document.createElement("strong");
    title.textContent = item.title || t("untitled");
    copy.append(title, makeConversationDates(item));
    row.append(check, copy);
    if (added || sources.length) {
      const badge = document.createElement("em");
      badge.textContent = t(added ? "alreadyInExportList" : "supplementExportSource");
      row.append(badge);
    }
    return row;
  }

  function makeExportHeader() {
    const title = t(selection.returnTarget === "manage" ? "exportList"
      : selection.returnTarget === "batch-main" ? "exportBatch" : "cancelExportSelection");
    const header = document.createElement("header");
    header.className = "export-secondary-header";
    const back = document.createElement("button");
    back.type = "button";
    back.dataset.exportSelectionBack = "";
    back.textContent = "‹";
    back.setAttribute("aria-label", t("exportBackToSelection", { title }));
    const label = document.createElement("strong");
    label.textContent = title;
    header.append(back, label);
    return header;
  }

  function makeExportFooter() {
    const footer = document.createElement("footer");
    footer.className = "source-export-select__footer";
    const count = selection.draftIds?.length || 0;
    const label = document.createElement("span");
    label.textContent = t("exportSelectedCount", { count, unit: t("conversationItemsUnit") });
    const add = document.createElement("button");
    add.type = "button";
    add.dataset.exportSelectionSubmit = "search";
    add.textContent = t("addToExportList");
    add.disabled = !count;
    footer.append(label, add);
    return footer;
  }

  function makeExportNotice() {
    if (controlModel.mode !== "date" || !selection.notice || selection.active) return null;
    const notice = document.createElement("div");
    notice.className = "export-source-notice";
    notice.setAttribute("role", "status");
    const label = document.createElement("span");
    label.textContent = selection.notice;
    const view = document.createElement("button");
    view.type = "button";
    view.dataset.exportViewBasket = "";
    view.textContent = t("viewExportList");
    notice.append(label, view);
    return notice;
  }

  function makeKeywordResult(item) {
    const article = document.createElement("article");
    article.className = "search-result search-result--keyword";
    article.dataset.searchKeywordResult = item.resultId;
    article.dataset.searchActiveResult = item.resultId;
    article.classList.toggle("is-active", results.activeResultId === item.resultId);
    const titleButton = document.createElement("button");
    titleButton.type = "button";
    titleButton.className = "search-result__keyword-title";
    titleButton.dataset.searchKeywordTitle = item.resultId;
    titleButton.title = item.title || t("untitled");
    titleButton.setAttribute("aria-label", `${t(item.messageId ? "jumpMessage" : "openConversation")}: ${item.title || t("untitled")}`);
    const title = document.createElement("strong");
    title.className = "search-result__source";
    appendHighlightedText(title, item.title || t("untitled"), controlModel.query);
    titleButton.append(title);
    const message = document.createElement("button");
    message.type = "button";
    message.className = "search-result__keyword-message";
    message.dataset.searchActiveResult = item.resultId;
    message.classList.toggle("is-active", results.activeResultId === item.resultId);
    if (item.messageId) message.dataset.searchMatchId = item.resultId;
    else message.dataset.searchResultId = item.resultId;
    message.setAttribute("aria-label", t(item.messageId ? "jumpMessage" : "openConversation"));
    message.title = t(item.messageId ? "jumpMessage" : "openConversation");
    const snippet = document.createElement("p");
    const preview = keywordExcerpt(item.snippet || item.title || t("untitled"), controlModel.query);
    appendHighlightedText(snippet, preview, controlModel.query);
    message.append(snippet);
    article.append(titleButton, message);
    return article;
  }

  function makePagination() {
    // Use this run's stable matching total, not global coverage or fetched-page
    // count. A newer directory revision must reach the results before showing N.
    const dateTotalKnown = status.resultStatus?.resultStable === true
      && Number.isInteger(status.resultStatus.total) && status.resultStatus.total >= 0
      && (!status.indexStatus || (status.indexStatus.resultStable === true
        && status.indexStatus.phase === "settled"
        && status.indexStatus.revision === status.resultStatus.revision))
      && !status.loading && !status.catalogRefreshing && !status.error;
    const keywordTotalKnown = status.keywordStatus?.complete === true;
    const totalKnown = controlModel.mode === "date" ? dateTotalKnown : keywordTotalKnown;
    const totalPages = totalKnown ? Math.max(1, controlModel.mode === "date"
      ? Math.ceil(status.resultStatus.total / pagination.pageSize) : pagination.pages.length) : null;
    const navigation = document.createElement("nav");
    navigation.className = "result-pagination";
    navigation.setAttribute("aria-label", t("pagination"));
    const sizeLabel = document.createElement("label");
    sizeLabel.className = "result-page-size";
    sizeLabel.title = t("itemsPerPage");
    const sizeWrap = document.createElement("span");
    sizeWrap.className = "result-page-size__select";
    const size = document.createElement("select");
    size.dataset.searchPageSize = "";
    size.setAttribute("aria-label", t("itemsPerPage"));
    if (controlModel.mode === "keyword") {
      const automatic = document.createElement("option");
      automatic.value = "auto";
      automatic.textContent = String(pagination.keywordAutoSize);
      automatic.selected = pagination.keywordPageSize === "auto";
      size.append(automatic);
    }
    const sizes = controlModel.mode === "keyword" ? pagination.options.filter((value) =>
      value !== pagination.keywordAutoSize || pagination.keywordPageSize === value) : searchContract.PAGE_SIZE_OPTIONS;
    for (const value of sizes) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = String(value);
      option.selected = controlModel.mode === "keyword" ? pagination.keywordPageSize === value : pagination.pageSize === value;
      size.append(option);
    }
    sizeWrap.append(size);
    sizeLabel.append(sizeWrap);
    const rail = document.createElement("span");
    rail.className = "result-pagination__rail";
    const previous = document.createElement("button");
    previous.type = "button";
    previous.className = "result-pagination__step result-pagination__step--previous";
    previous.dataset.searchPageDirection = "previous";
    previous.disabled = (controlModel.mode === "date" && status.loading) || pagination.page <= 1;
    previous.setAttribute("aria-label", t("previousPage"));
    const position = document.createElement("span");
    position.className = "result-pagination__position";
    const input = document.createElement("input");
    input.className = "result-pagination__input";
    input.type = "text";
    input.inputMode = "numeric";
    input.value = String(pagination.page);
    input.readOnly = controlModel.mode === "date" || !keywordTotalKnown;
    input.dataset.searchPageInput = "";
    input.setAttribute("aria-label", t("currentPage"));
    const total = document.createElement("span");
    total.className = "result-pagination__total";
    total.textContent = `/ ${totalKnown ? totalPages : "…"}`;
    total.setAttribute("aria-label", totalKnown ? t("totalPages", { count: totalPages }) : t("searchTotalPagesUnknown"));
    position.append(input, total);
    const next = document.createElement("button");
    next.type = "button";
    next.className = "result-pagination__step result-pagination__step--next";
    next.dataset.searchPageDirection = "next";
    next.disabled = controlModel.mode === "keyword" ? pagination.page >= pagination.pages.length
      : status.loading || (pagination.page >= pagination.pages.length && !pagination.hasMore);
    next.setAttribute("aria-label", t("nextPage"));
    rail.append(previous, position, next);
    navigation.append(sizeLabel, rail);
    return navigation;
  }

  function makeSearchStatus() {
    const phase = status.phase;
    const working = phase === "searching" || phase === "refreshing";
    const notice = document.createElement("div");
    notice.className = "search-status";
    notice.role = "status";
    notice.setAttribute("aria-live", "polite");
    notice.setAttribute("aria-atomic", "true");
    notice.dataset.searchStatus = phase;
    if (working) {
      notice.append(createLoadingFlower(status.animationStartedAt));
    }
    const label = document.createElement("span");
    label.className = "search-status__label";
    // Normal states are visual-only, not semantics-free: screen readers still
    // receive searching/refreshing/completion. A pause remains visible to all.
    label.classList.toggle("search-status__label--sr-only", phase !== "paused" || Boolean(status.errorNotice));
    label.textContent = phase === "waiting" ? ""
      : t({ searching: "searchDateSearching", refreshing: "searchDateRefreshing",
        complete: "searchDateComplete", paused: "searchDatePaused" }[phase]);
    notice.append(label);
    return notice;
  }

  function makeDateError() {
    const errors = (status.indexStatus || status.resultStatus)?.readErrors || [];
    if (controlModel.mode !== "date" || status.errorNotice?.mode !== "date") return null;
    const notice = document.createElement("div");
    notice.className = "search-date-error";
    notice.role = "alert";
    const presentation = searchFailure(status.errorNotice.error, "searchDateReadFailed");
    const label = document.createElement("span");
    label.textContent = t(presentation.messageKey); notice.append(label);
    // 日期错误区只说明读取状态，不追加“重新读取”或另一条重扫入口。
    // 已有会话继续可用；主动刷新统一保留在搜索结果工具栏。
    // Keep diagnostics inspectable without putting account counts or internal
    // coverage terminology in normal UI text or tooltips.
    notice.dataset.searchReadErrors = JSON.stringify(errors);
    notice.dataset.searchErrorCode = status.errorNotice.error.code;
    return notice;
  }

  function makeKeywordError() {
    if (controlModel.mode !== "keyword") return null;
    const error = status.errorNotice?.mode === "keyword" ? status.errorNotice.error : null;
    if (!error) return null;
    const notice = document.createElement("div");
    notice.className = "search-keyword-error";
    notice.role = "alert";
    notice.dataset.searchErrorCode = error.code;
    const label = document.createElement("span");
    const presentation = searchFailure(error, "searchKeywordIncomplete");
    label.textContent = t(presentation.messageKey);
    notice.append(label);
    if (!presentation.retryable) return notice;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.dataset.searchKeywordRetry = "";
    retry.title = t("searchKeywordRetry");
    retry.setAttribute("aria-label", t("searchKeywordRetry"));
    retry.textContent = t("searchKeywordRetry");
    notice.append(retry);
    return notice;
  }

  function makeResultsArea() {
    const area = document.createElement("div");
    area.className = "search-results-area";
    area.classList.toggle("search-results-area--keyword", controlModel.mode === "keyword");
    area.classList.toggle("search-results-area--date", controlModel.mode === "date");
    const section = document.createElement("section");
    section.className = "search-list-section";
    const heading = document.createElement("div");
    heading.className = "search-list-heading";
    const label = document.createElement("span");
    label.textContent = t("searchResults");
    heading.append(label);
    {
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.className = "search-directory-refresh";
      const refreshLabel = t(controlModel.mode === "date" ? "searchDateRefresh" : "searchKeywordRefresh");
      if (controlModel.mode === "date") {
        refresh.dataset.searchRefreshCatalog = "";
        refresh.disabled = !status.sessionId || status.loading || status.catalogRefreshing || status.indexStatus?.phase === "loading";
      } else {
        refresh.dataset.searchRefreshKeyword = "";
        refresh.disabled = !controlModel.query.trim() || status.loading || controlModel.composing;
        refresh.setAttribute("aria-busy", String(status.loading && status.keywordRefreshing));
      }
      refresh.title = refreshLabel;
      refresh.setAttribute("aria-label", refreshLabel);
      const icon = document.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = REFRESH_ICON;
      const text = document.createElement("span");
      text.textContent = refreshLabel;
      refresh.append(icon, text);
      heading.append(refresh);
    }
    if (controlModel.mode === "date") {
      const exportButton = document.createElement("button");
      exportButton.className = "source-export-entry";
      exportButton.type = "button";
      const items = selection.items;
      if (selection.active) {
        exportButton.dataset.exportSelectCurrent = "search";
        const selectable = items.filter((item) => !selection.basketConversationSources?.[item.conversationId]?.includes("search"));
        const allSelected = selectable.length && selectable.every((item) => selection.draftIds?.includes(item.conversationId));
        exportButton.textContent = t(allSelected ? "clearCurrentPageSelection" : "selectAllCurrentPage");
        exportButton.disabled = !selectable.length;
      } else {
        exportButton.dataset.exportSelectMode = "search";
        exportButton.textContent = t("selectExport");
        exportButton.disabled = !items.length;
      }
      heading.append(exportButton);
    }
    const count = document.createElement("small");
    if (controlModel.mode === "date") {
      count.textContent = t("searchConversationResultCount", { count: status.resultStatus?.total ?? 0 });
    } else {
      count.textContent = t("searchKeywordResultCount", { count: status.keywordStatus?.total || 0 });
      count.dataset.searchResultCount = "";
      count.setAttribute("aria-busy", String(status.loading));
    }
    if (status.error && controlModel.mode === "date") {
      count.dataset.searchErrorCode = status.error.code;
    }
    heading.append(count);
    const list = document.createElement("div");
    list.className = "search-result-list";
    list.dataset.searchResultList = "";
    const items = results.items;
    if (items.length) {
      for (const item of items) list.append(makeConversationResult(item));
    } else {
      const empty = document.createElement("div");
      empty.className = "search-empty";
      if (status.error || status.keywordStatus?.error || (status.indexStatus || status.resultStatus)?.readErrors?.length) {
        empty.role = "alert";
        // 失败不是“没有结果”。短暂提醒退出后仍保留中性暂停状态，不重复报错。
        empty.hidden = true;
      } else if (results.dateError) {
        empty.role = "alert";
        empty.textContent = t(results.range.errorKey || "searchDateRangeError");
      } else if (status.loading) {
        empty.textContent = t("searchLoading");
      } else if (!results.searched) {
        empty.textContent = t(controlModel.mode === "keyword" ? "searchKeywordEmpty" : "searchDateEmpty");
      } else {
        empty.textContent = t(controlModel.mode === "date" && ["searching", "refreshing"].includes(status.phase)
          ? "searchLoading" : "searchNoResultsConversation");
      }
      list.append(empty);
    }
    section.append(heading, list, makePagination());
    area.append(section);
    return area;
  }
    const panel = document.createElement("div");
    panel.className = "search-panel";
    panel.classList.toggle("search-panel--keyword", controlModel.mode === "keyword");
    panel.classList.toggle("search-panel--export-select", selection.active);
    if (selection.active) panel.append(makeExportHeader());
    const controls = document.createElement("section");
    controls.className = "search-control-section";
    controls.append(makeModeTabs());
    if (controlModel.mode === "keyword") controls.append(makeKeywordControl());
    else controls.append(makeDateBasis(), calendarModel.controls, makeSortSection());
    // Both variants reserve the same status slot immediately above results.
    panel.append(controls, makeSearchStatus());
    const dateError = makeDateError();
    if (dateError) panel.append(dateError);
    const keywordError = makeKeywordError();
    if (keywordError) panel.append(keywordError);
    panel.append(makeResultsArea());
    if (selection.active) panel.append(makeExportFooter());
    const exportNotice = makeExportNotice();
    if (exportNotice) panel.append(exportNotice);
    const overlay = document.createElement("div");
    overlay.className = "search-overlay-layer";
    const calendar = calendarModel.overlay;
    if (calendar) overlay.append(calendar);
    panel.append(overlay);

    return panel;
}
