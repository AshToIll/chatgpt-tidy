import { escapeHtml } from "../../../platform/ui/html.js";

export const FORMAT_META = Object.freeze({
  markdown: { label: "Markdown", extension: ".md" },
  json: { label: "JSON", extension: ".json" },
  txt: { label: "TXT", extension: ".txt" },
  pdf: { label: "PDF", extension: ".pdf" },
});

export const CONTENT_OPTION_KEYS = Object.freeze([
  ["timestamps", "exportMessageTimes"],
  ["messageNumbers", "messageNumbers"],
  ["visibleProcess", "exportVisibleProcess"],
  ["toolProcess", "exportToolProcess"],
  ["webProcess", "exportWebProcess"],
  ["finalSources", "exportFinalSources"],
  ["mediaAttachments", "exportMediaAttachments"],
]);

/**
 * Pure HTML renderer. The owner derives this presentation DTO before rendering;
 * this module never reads owner state, DOM nodes, repositories, or live job services.
 * All arguments are read-only: settings normalization and disclosure tracking
 * belong to the owner, not to a template or a callback hidden behind a getter.
 *
 * Required display fields copied into model:
 * - mode, format, content, roleNames, pdf, preferences, filename, settingsView;
 * - accountKey, scopeVerified, loading, documentStale, loadError, exportError;
 * - batchLoading, batchLoadError, batchRetryable, batchFailedTitles, batchPlanError;
 * - batchOrganizationOpen, conversationOrganization, bookmarkOrganization,
 *   batchFilename, batchSingleFilename, showAllConversations, showAllBookmarkGroups;
 * - job, jobSubmission, jobUnknown, jobWarningsOpen.
 *
 * Required derived fields:
 * - plan (selected mode only), currentTitle, messageCount, currentReady, batchReady;
 * - responseInProgress, boundSnapshot, batchSourcesReady, batchStaleCount;
 * - conversationCount, bookmarkCount, conversationRecords, bookmarkGroups, bookmarkItems;
 * - pendingImages (count), missingImages (array), warningsOpen, selectionErrorOpen;
 * - currentPreviewText (2600-character serializer excerpt), currentPdfParts (same limit);
 * - selectionMissingLabels (in batchPlanError.missingBookmarks order);
 * - jobHidden, jobBusy, jobCancellable, jobTerminal.
 *
 * conversationRecords entries: { conversation, sources, messageTotal, highlighted }.
 * bookmarkGroups entries: { conversation, bookmarks, overlap, highlighted, expanded }.
 * Each bookmark carries bookmarkId/groupId plus { text, role, timestamp,
 * messageNumber, groupLabel, highlighted }. Omit messageNumber if no message exists.
 * bookmarkItems need only groupId; user-provided group names remain plain text.
 *
 * Pure presentation ports only: exportApi.resolveRoleNames/exportErrorText,
 * preview.styles/markup, optional formatTimestamp, and the translator argument.
 * No data-loading, mutable owner-state, or DOM callbacks are accepted.
 */
export function renderExportMarkup(model, translate) {
  const { exportApi, formatTimestamp } = model;
  const previewRuntime = model.preview;
  const exportPlan = () => model.plan;
  const batchPlan = () => model.plan;
  const currentPlanReady = () => model.currentReady;
  const batchPlanReady = () => model.batchReady;
  const responseInProgress = () => model.responseInProgress;
  const currentSyncLabel = () => translate(model.responseInProgress ? "exportWaitingForResponse" : "exportSyncing");
  const isBoundSnapshot = () => model.boundSnapshot;
  const batchSourcesReady = () => model.batchSourcesReady;
  const pendingImageCount = () => model.pendingImages;
  const messageCount = () => model.messageCount;
  const basketCount = () => model.conversationCount + model.bookmarkCount;
  const basketConversationRecords = () => model.conversationRecords;
  const basketBookmarkItems = () => model.bookmarkItems;
  const basketBookmarkGroups = () => model.bookmarkGroups;
  const resolvedRoleNames = () => exportApi.resolveRoleNames(model.roleNames);
  const jobBusy = () => model.jobBusy;
  function noticeText(notice) {
    return translate(notice.key, { ...notice.values,
      ...(notice.unitKey ? { unit: translate(notice.unitKey) } : {}) });
  }

  function exportSourceLabel(sources) {
    return [...new Set(sources || [])]
      .map((source) => source === "favorites"
        ? translate("favorites")
        : source === "bookmarks"
          ? translate("bookmarks")
          : source === "search"
            ? translate("globalSearch")
            : "")
      .filter(Boolean)
      .join(translate("exportSummarySeparator"));
  }

  function exportContentSummary() {
    const labels = {
      timestamps: translate("exportTimeShort"),
      messageNumbers: translate("exportNumberShort"),
      visibleProcess: translate("exportProcessShort"),
      toolProcess: translate("exportToolShort"),
      webProcess: translate("exportSearchShort"),
      finalSources: translate("exportSourcesShort"),
      mediaAttachments: translate("exportMediaShort"),
    };
    const selected = Object.entries(model.content)
      .filter(([, enabled]) => enabled)
      .map(([key]) => labels[key]);
    return selected.length ? selected.join(translate("exportSummarySeparator")) : translate("exportBodyOnly");
  }

  function pdfSummary() {
    return [
      model.pdf.pageSize,
      translate(model.pdf.orientation === "landscape" ? "exportLandscape" : "exportPortrait"),
    ].join(" · ");
  }

  // 顶部范围和底部按钮共用数量摘要；数量为零的类别不显示，避免出现“0 条书签”等干扰。

  function countLabel(count, unitKey) {
    const language = model.preferences?.language;
    if (language === "en") {
      const singular = unitKey === "conversationItemsUnit" ? "conversation" : "bookmark";
      return `${count} ${singular}${count === 1 ? "" : "s"}`;
    }
    return `${count} ${translate(unitKey)}`;
  }

  function batchCountSummary() {
    const parts = [];
    if (model.conversationCount) {
      parts.push(countLabel(model.conversationCount, "conversationItemsUnit"));
    }
    if (model.bookmarkCount) {
      parts.push(countLabel(model.bookmarkCount, "bookmarkItemsUnit"));
    }
    return parts.join(" + ");
  }

  function footerSummary() {
    if (model.mode === "batch") {
      const conversations = model.conversationCount;
      const bookmarks = model.bookmarkCount;
      const summary = conversations || bookmarks ? batchCountSummary() : translate("exportList");
      return `${summary} · ${FORMAT_META[model.format].label}`;
    }
    return `${translate("currentConversation")} · ${FORMAT_META[model.format].label}`;
  }

  function warningsMarkup() {
    const missing = model.missingImages;
    if (!missing.length) return "";
    const warnings = [translate("exportImageUnavailable")];
    const open = model.warningsOpen ? " open" : "";
    const title = translate("exportContentWarnings", { count: warnings.length });
    return `<details data-list-key="warnings" class="export-warning" data-export-warnings${open}><summary>${escapeHtml(title)}</summary><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></details>`;
  }

  function batchPreviewMarkup() {
    if (!model.accountKey) return `<div class="export-preview-state">${escapeHtml(translate("exportAccountRequired"))}</div>`;
    if (model.batchStaleCount) return `<div class="export-preview-state">${escapeHtml(translate("exportContentChanged"))}</div>`;
    if (model.batchLoading) return `<div class="export-preview-state">${escapeHtml(translate("exportBatchReading"))}</div>`;
    if (model.batchLoadError) return `<div class="export-preview-state export-preview-state--error"><span>${escapeHtml(noticeText(model.batchLoadError))}</span>${model.batchRetryable ? `<button type="button" data-export-batch-retry>${escapeHtml(translate("retry"))}</button>` : ""}${model.batchFailedTitles.length ? `<p>${escapeHtml(translate("exportFailedSelection"))}</p><ul>${model.batchFailedTitles.map(title => `<li>${escapeHtml(title || translate("untitled"))}</li>`).join("")}</ul>` : ""}</div>`;
    const plan = batchPlan();
    if (model.batchPlanError) return `<div class="export-preview-state export-preview-state--error">${escapeHtml(translate("exportSelectionIncomplete"))}</div>`;
    if (!plan) return `<div class="export-preview-state">${escapeHtml(translate("exportBatchNeedsSelection"))}</div>`;
    const fileList = (items, limit = 4) => {
      const visible = items.slice(0, limit).map((file) => {
        const count = file.kind === "conversation"
          ? `${file.conversations.length} ${translate("conversationItemsUnit")}`
          : file.kind === "bookmark-excerpt"
            ? `${file.bookmarkEntries.length} ${translate("bookmarkItemsUnit")}`
            : "";
        return `<li>${escapeHtml(file.path || file.archivePath || "")}${count ? `<small>${escapeHtml(count)}</small>` : ""}</li>`;
      }).join("");
      const more = items.length > limit ? `<li>${escapeHtml(translate("exportMoreItems", { count: items.length - limit }))}</li>` : "";
      return `<ul>${visible}${more}</ul>`;
    };
    const conversationFiles = plan.files.filter((file) => file.kind === "conversation");
    const bookmarkFiles = plan.files.filter((file) => file.kind === "bookmark-excerpt");
    const mixed = conversationFiles.length > 0 && bookmarkFiles.length > 0;
    let body = !plan.zipped
      ? `<p>${escapeHtml(plan.files[0].kind === "conversation" ? `${plan.files[0].conversations.length} ${translate("conversationItemsUnit")}` : `${plan.files[0].bookmarkEntries.length} ${translate("bookmarkItemsUnit")}`)}</p>`
      : mixed
        ? `<div class="export-preview-tree"><section><span>${escapeHtml(translate("exportConversationSection"))}</span>${fileList(conversationFiles, 3)}</section><section><span>${escapeHtml(translate("exportBookmarkSection"))}</span>${fileList(bookmarkFiles, 3)}</section></div>`
        : fileList(plan.files);
    return `<div class="export-batch-preview"><strong>${escapeHtml(plan.outputName)}</strong>${body}</div>`;
  }

  function currentPreviewMarkup() {
    if (!model.accountKey) return `<div class="export-preview-state">${escapeHtml(translate("exportAccountRequired"))}</div>`;
    if (responseInProgress() || model.currentResponsePending || model.documentStale) return `<div class="export-preview-state" role="status">${escapeHtml(currentSyncLabel())}</div>`;
    if (model.loading) return `<div class="export-preview-state">${escapeHtml(translate("exportReading"))}</div>`;
    if (model.loadError) {
      return `<div class="export-preview-state export-preview-state--error"><span>${escapeHtml(noticeText(model.loadError))}</span><button type="button" data-export-retry>${escapeHtml(translate("retry"))}</button></div>`;
    }
    if (!exportPlan()) return `<div class="export-preview-state">${escapeHtml(translate("exportNeedsConversation"))}</div>`;
    const pdfClasses = model.format === "pdf"
      ? ` export-preview__document--light export-preview__document--${model.pdf.fontSize} export-preview__document--${model.pdf.orientation.toLowerCase()} export-preview__document--${model.pdf.pageSize.toLowerCase()}`
      : "";
    if (model.format === "pdf") {
      const parts = model.currentPdfParts;
      return `<style>${previewRuntime.styles}</style><div class="export-preview__document export-preview__document--pdf${pdfClasses}">${previewRuntime.markup(parts)}</div>`;
    }
    const serialized = model.currentPreviewText;
    const clipped = serialized.slice(0, 2600);
    const ellipsis = serialized.length > clipped.length ? "\n…" : "";
    return `<div class="export-preview__document export-preview__document--${model.format}${pdfClasses}"><pre class="export-preview__code">${escapeHtml(clipped)}${ellipsis}</pre></div>`;
  }

  function settingsLink(view, labelKey, summary, target = view) {
    return `<button type="button" class="export-settings-link" data-export-settings-view="${view}" data-export-settings-target="${target}"><span>${escapeHtml(translate(labelKey))}</span><small>${escapeHtml(summary)}</small><span aria-hidden="true">›</span></button>`;
  }

  function toggleRow(key, labelKey, checked, group = "content") {
    return `<label data-list-key="toggle:${group}:${key}" class="export-option-row"><span>${escapeHtml(translate(labelKey))}</span><span class="export-switch"><input type="checkbox" data-export-toggle="${key}" data-export-toggle-group="${group}" role="switch" aria-label="${escapeHtml(translate(labelKey))}" aria-checked="${checked}"${checked ? " checked" : ""}><span aria-hidden="true"></span></span></label>`;
  }

  function choiceRow(labelKey, setting, choices, value) {
    const buttons = choices.map(([choice, labelKeyOrText, raw = false]) => {
      const label = raw ? labelKeyOrText : translate(labelKeyOrText);
      return `<button type="button" data-export-pdf-setting="${setting}" data-value="${choice}" class="${value === choice ? "is-active" : ""}" aria-pressed="${value === choice}">${escapeHtml(label)}</button>`;
    }).join("");
    return `<div data-list-key="pdf:${setting}" class="export-choice-row"><span>${escapeHtml(translate(labelKey))}</span><div class="export-mini-segment" role="group" aria-label="${escapeHtml(translate(labelKey))}">${buttons}</div></div>`;
  }

  function secondaryHeader(titleKey, formatControl = false) {
    const trailing = formatControl
      ? `<label class="export-secondary-format"><select data-export-secondary-format aria-label="${escapeHtml(translate("exportFormat"))}">${Object.entries(FORMAT_META).map(([value, meta]) => `<option value="${value}"${model.format === value ? " selected" : ""}>${meta.label}</option>`).join("")}</select><span aria-hidden="true">⌄</span></label>`
      : `<small>${FORMAT_META[model.format].label}</small>`;
    return `<header data-list-key="secondary-header" class="export-secondary-header"><button type="button" data-export-settings-back aria-label="${escapeHtml(translate("exportBackToSettings"))}">‹</button><strong>${escapeHtml(translate(titleKey))}</strong>${trailing}</header>`;
  }

  function pdfMiniPreviewMarkup() {
    const landscape = model.pdf.orientation === "landscape";
    const sizeKey = model.pdf.fontSize === "small" ? "exportSmallFont" : model.pdf.fontSize === "large" ? "exportLargeFont" : "exportStandardFont";
    return `<div class="export-pdf-mini-wrap"><div class="export-pdf-mini export-pdf-mini--${landscape ? "landscape" : "portrait"} export-pdf-mini--${model.pdf.pageSize.toLowerCase()} export-pdf-mini--${model.pdf.fontSize}"><span></span><i></i><i></i><i></i><b></b></div><small>${escapeHtml(pdfSummary())} · ${escapeHtml(translate(sizeKey))}</small></div>`;
  }

  function secondaryMarkup() {
    if (model.settingsView === "shared") {
      const commonRows = CONTENT_OPTION_KEYS.map(([key, labelKey]) => toggleRow(key, labelKey, model.content[key])).join("");
      // 默认值是未填写时的提示，不是输入内容；删除、失焦、刷新都不能替用户填字。
      const defaultRoleNames = exportApi.resolveRoleNames();
      const roleRows = `<label class="export-text-field"><span>${escapeHtml(translate("user"))}</span><input type="text" data-export-role="user" value="${escapeHtml(model.roleNames.user)}" placeholder="${escapeHtml(defaultRoleNames.user)}" aria-label="${escapeHtml(translate("user"))} ${escapeHtml(translate("exportDisplayName"))}"></label><label class="export-text-field"><span>${escapeHtml(translate("assistant"))}</span><input type="text" data-export-role="assistant" value="${escapeHtml(model.roleNames.assistant)}" placeholder="${escapeHtml(defaultRoleNames.assistant)}" aria-label="${escapeHtml(translate("assistant"))} ${escapeHtml(translate("exportDisplayName"))}"></label>`;
      return `${secondaryHeader("exportContentAndRoles", true)}<div data-list-key="secondary-scroll" class="export-secondary-scroll"><section class="export-secondary-section" data-export-settings-anchor="content"><h3>${escapeHtml(translate("exportContentOptions"))}</h3><div class="export-secondary-group"><span>${escapeHtml(translate("general"))}</span>${commonRows}</div></section><section class="export-secondary-section" data-export-settings-anchor="roles"><h3>${escapeHtml(translate("exportRoleNames"))}</h3><div class="export-secondary-group">${roleRows}</div></section></div>`;
    }
    if (model.settingsView === "pdf") {
      const body = [
        choiceRow("exportPaper", "pageSize", [["A4", "A4", true], ["Letter", "Letter", true]], model.pdf.pageSize),
        choiceRow("exportOrientation", "orientation", [["portrait", "exportPortrait"], ["landscape", "exportLandscape"]], model.pdf.orientation),
        choiceRow("exportFontSize", "fontSize", [["small", "exportSmall"], ["standard", "exportStandard"], ["large", "exportLarge"]], model.pdf.fontSize),
        toggleRow("pageNumbers", "exportPageNumbers", model.pdf.pageNumbers, "pdf"),
      ].join("");
      return `${secondaryHeader("exportPdfAppearance")}<div data-list-key="secondary-scroll" class="export-secondary-scroll"><div class="export-secondary-group"><span>${escapeHtml(translate("exportLayout"))}</span>${body}</div><section class="export-secondary-preview"><span>${escapeHtml(translate("exportPaperPreview"))}</span>${pdfMiniPreviewMarkup()}</section></div>`;
    }
    return "";
  }

  function batchListMarkup() {
    const conversations = basketConversationRecords();
    const groups = basketBookmarkGroups();
    if (!conversations.length && !groups.length) {
      return `<section class="export-basket-empty"><strong>${escapeHtml(translate("exportBatchEmpty"))}</strong><div><button type="button" data-export-source="favorites">${escapeHtml(translate("addFromFavorites"))}</button><button type="button" data-export-source="bookmarks">${escapeHtml(translate("addFromBookmarks"))}</button><button type="button" data-export-source="search">${escapeHtml(translate("addFromSearchResults"))}</button></div></section>`;
    }
    const visibleConversations = model.showAllConversations ? conversations : conversations.slice(0, 3);
    const conversationRows = visibleConversations.map(({ conversation, sources, messageTotal, highlighted }) => {
      const details = [
         formatTimestamp?.(conversation.createdAt, model.preferences),
         Number.isInteger(messageTotal) ? translate("messagesCount", { count: messageTotal }) : "",
        sources.length ? translate("exportFromSource", { source: exportSourceLabel(sources) }) : "",
      ].filter(Boolean).join(" · ");
      return `<div data-list-key="conversation:${escapeHtml(conversation.id)}" class="export-basket-conversation${highlighted ? " is-new" : ""}"><span><strong>${escapeHtml(conversation.title)}</strong><small>${escapeHtml(details)}</small></span><button type="button" data-export-remove-conversation="${escapeHtml(conversation.id)}" aria-label="${escapeHtml(translate("exportRemoveItem"))}">${escapeHtml(translate("exportRemoveItem"))}</button></div>`;
    }).join("");
    const moreConversations = !model.showAllConversations && conversations.length > 3 ? `<button class="export-basket-more" type="button" data-export-show-all-conversations>${escapeHtml(translate("exportMoreItems", { count: conversations.length - 3 }))} · ${escapeHtml(translate("exportShowAll"))}</button>` : "";
    const conversationSection = conversations.length ? `<section class="export-basket-section"><header><span>${escapeHtml(translate("exportConversationSection"))} · ${conversations.length}</span></header>${conversationRows}${moreConversations}</section>` : "";
    const visibleGroups = model.showAllBookmarkGroups ? groups : groups.slice(0, 3);
    const bookmarkSections = visibleGroups.map(({ conversation, bookmarks, overlap, highlighted: groupHighlighted, expanded }) => {
      const rows = bookmarks.map((bookmark) => {
        const text = bookmark.text;
        const role = translate(bookmark.role === "assistant" ? "assistant" : "user");
        const groupLabel = bookmark.groupLabel || translate("ungrouped");
        const meta = [
          bookmark.messageNumber !== undefined ? `#${bookmark.messageNumber}` : "",
          formatTimestamp?.(bookmark.timestamp, model.preferences),
          role,
        ].filter(Boolean).join(" · ");
        const highlighted = bookmark.highlighted;
        return `<article data-list-key="bookmark:${escapeHtml(bookmark.bookmarkId)}" class="export-basket-bookmark${highlighted ? " is-new" : ""}"><span><small>${escapeHtml(meta)}</small><strong>${escapeHtml(text)}</strong><em>${escapeHtml(translate("bookmarkFromGroup", { group: groupLabel }))}</em>${overlap ? `<em>${escapeHtml(translate("exportBookmarkAlsoInConversation"))}</em>` : ""}</span><button type="button" data-export-remove-bookmark="${escapeHtml(bookmark.bookmarkId)}" aria-label="${escapeHtml(translate("exportRemoveItem"))}">${escapeHtml(translate("exportRemoveItem"))}</button></article>`;
      }).join("");
      return `<section data-list-key="bookmark-group:${escapeHtml(conversation.id)}" class="export-basket-bookmark-group${groupHighlighted ? " is-new" : ""}"><header><button type="button" data-export-expand-bookmark-group="${escapeHtml(conversation.id)}" aria-expanded="${expanded}"><span class="export-disclosure__triangle">›</span>${escapeHtml(conversation.title)} · ${bookmarks.length}</button><button type="button" data-export-remove-bookmark-group="${escapeHtml(conversation.id)}">${escapeHtml(translate("exportRemoveBookmarkGroup"))}</button></header>${rows ? `<div data-export-bookmark-rows="${escapeHtml(conversation.id)}"${expanded ? "" : " hidden"}>${rows}</div>` : ""}</section>`;
    }).join("");
    const moreGroups = !model.showAllBookmarkGroups && groups.length > 3 ? `<button class="export-basket-more" type="button" data-export-show-all-bookmark-groups>${escapeHtml(translate("exportMoreItems", { count: groups.length - 3 }))} · ${escapeHtml(translate("exportShowAll"))}</button>` : "";
    const bookmarkSection = groups.length ? `<section class="export-basket-section"><header><span>${escapeHtml(translate("exportBookmarkSection"))} · ${model.bookmarkCount}</span></header>${bookmarkSections}${moreGroups}</section>` : "";
    return `${conversationSection}${bookmarkSection}`;
  }

  function batchOrganizationMarkup() {
    if (model.mode !== "batch" || !basketCount()) return "";
    const conversations = basketConversationRecords();
    const bookmarks = basketBookmarkItems();
    const bookmarkGroups = basketBookmarkGroups();
    const conversationOptions = conversations.length > 1
      ? [["per-conversation", translate("exportPerConversation")], ["all-conversations", translate("exportAllConversations")]] : [];
    const bookmarkOptions = bookmarks.length > 1
      ? [
          ...(bookmarkGroups.length >= 2 ? [["per-conversation", translate("exportPerConversation")]] : []),
          ...((new Set(bookmarks.map((item) => item.groupId || "ungrouped")).size >= 2) ? [["per-bookmark-group", translate("exportPerBookmarkGroup")]] : []),
          ["all-bookmarks", translate("exportAllBookmarks")],
        ] : [];
    // 只有一种文件组织方式时直接展示结果，不弹出只有一个选项的菜单。
    const meaningfulBookmarkOptions = bookmarkOptions.length > 1 ? bookmarkOptions : [];
    // Render a safe selection without mutating settings. The owner normalizes
    // organization settings before constructing the file plan and this DTO.
    const conversationOrganization = conversationOptions.some(([value]) => value === model.conversationOrganization)
      ? model.conversationOrganization : "per-conversation";
    const bookmarkOrganization = meaningfulBookmarkOptions.some(([value]) => value === model.bookmarkOrganization)
      ? model.bookmarkOrganization : "all-bookmarks";
    const row = (kind, label, options, selected) => {
      if (!options.length) {
        const summary = kind === "conversations"
          ? translate("exportOneFile")
          : bookmarks.length === 1 ? translate("exportOneFile") : translate("exportMergedOneFile");
        return `<div class="export-settings-link is-readonly"><span>${escapeHtml(label)}</span><small>${escapeHtml(summary)}</small><span aria-hidden="true"></span></div>`;
      }
      const open = model.batchOrganizationOpen === kind;
      const summary = options.find(([value]) => value === selected)?.[1] || options[0][1];
      const choices = options.map(([value, text]) => `<button type="button" role="radio" aria-checked="${value === selected}" data-export-organization="${kind}" data-value="${value}" class="${value === selected ? "is-active" : ""}"><span class="export-organization-radio" aria-hidden="true"></span><span>${escapeHtml(text)}</span></button>`).join("");
      return `<button type="button" data-list-key="organization:${kind}" class="export-settings-link export-organization-summary" data-export-organization-toggle="${kind}" aria-expanded="${open}"><span>${escapeHtml(label)}</span><small>${escapeHtml(summary)}</small><span aria-hidden="true">›</span></button>${open ? `<div data-list-key="organization-choices:${kind}" class="export-organization-options" role="radiogroup" aria-label="${escapeHtml(label)}">${choices}</div>` : ""}`;
    };
    return `<section data-list-key="organization" class="export-block export-organization"><div class="export-block__heading"><span>${escapeHtml(translate("exportOrganization"))}</span></div><div class="export-settings-links export-organization-links">${conversations.length ? row("conversations", translate("exportConversationSection"), conversationOptions, conversationOrganization) : ""}${bookmarks.length ? row("bookmarks", translate("exportBookmarkSection"), meaningfulBookmarkOptions, bookmarkOrganization) : ""}</div></section>`;
  }

  function batchFilenameMarkup() {
    const plan = batchPlan();
    if (!plan) return "";
    const zipped = Boolean(plan.zipped);
    const value = zipped ? model.batchFilename || translate("exportDefaultName") : model.batchSingleFilename || plan.files[0].baseName;
    const label = zipped ? translate("exportPackageName") : translate("exportFilename");
    const aria = zipped ? translate("exportPackageName") : translate("exportFilename");
    return `<section data-list-key="filename" class="export-block export-filenames"><div class="export-block__heading"><span>${escapeHtml(label)}</span></div><label class="export-file-field is-unlabeled"><span><input type="text" data-export-filename="${zipped ? "batch" : "batch-single"}" value="${escapeHtml(value)}" aria-label="${escapeHtml(aria)}"><i>${zipped ? ".zip" : FORMAT_META[model.format].extension}</i></span></label></section>`;
  }

  function batchFixedScopeMarkup() {
    if (!basketCount()) return "";
    const summary = batchCountSummary();
    return `<div class="export-fixed-scope export-fixed-scope--batch"><span>${escapeHtml(translate("exportScope"))}</span><strong>${escapeHtml(summary)}</strong><button type="button" data-export-settings-view="manage"><span>${escapeHtml(translate("exportList"))}</span><span aria-hidden="true">›</span></button></div>`;
  }

  function batchManageMarkup(actionBar) {
    const searchLabel = escapeHtml(translate("chooseFromSearch"));
    return `<header data-list-key="secondary-header" class="export-secondary-header"><button type="button" data-export-settings-back aria-label="${escapeHtml(translate("exportBackToSettings"))}">‹</button><strong>${escapeHtml(translate("exportList"))}</strong></header><div data-list-key="secondary-scroll" class="export-secondary-scroll export-secondary-scroll--manage"><div class="export-manage-toolbar"><span>${escapeHtml(footerSummary().replace(` · ${FORMAT_META[model.format].label}`, ""))}</span><button type="button" data-export-add-toggle aria-haspopup="menu" aria-expanded="false">＋ ${escapeHtml(translate("addExportContent"))}</button><div class="export-add-menu" role="menu" aria-label="${escapeHtml(translate("exportBatchEmpty"))}" hidden><button type="button" role="menuitem" data-export-source="favorites">${escapeHtml(translate("chooseFromFavorites"))}</button><button type="button" role="menuitem" data-export-source="bookmarks">${escapeHtml(translate("chooseFromBookmarks"))}</button><button type="button" role="menuitem" data-export-source="search">${searchLabel}</button></div></div><div class="export-basket export-basket--manage">${batchListMarkup()}</div></div>${actionBar}`;
  }

  function selectionErrorMarkup() {
    const error = model.batchPlanError;
    if (!error) return "";
    if (error.code !== "EXPORT_SELECTION_INCOMPLETE") {
      return `<div data-list-key="error" class="export-error" role="alert"><strong>${escapeHtml(translate("exportBatchUnavailable"))}</strong><span>${escapeHtml(exportApi.exportErrorText(error, translate))}</span></div>`;
    }
    const missing = error.missingBookmarks || [];
    const filteredOnly = missing.length > 0 && missing.every((item) => item.reason === "content-excluded");
    const title = translate(filteredOnly ? "exportSelectionFiltered" : "exportSelectionIncomplete", { count: missing.length });
    const items = missing.map((item, index) => {
      const label = model.selectionMissingLabels[index] || translate("untitled");
      return `<li>${escapeHtml(label)}</li>`;
    }).join("");
    const open = model.selectionErrorOpen ? " open" : "";
    return `<details data-list-key="selection-error" class="export-selection-error" role="alert" data-export-selection-error${open}><summary>${escapeHtml(title)}</summary><span>${escapeHtml(translate(filteredOnly ? "exportSelectionFilteredRecovery" : "exportSelectionRecovery"))}</span>${items ? `<ul>${items}</ul>` : ""}</details>`;
  }

  function jobMarkup() {
    if (!model.scopeVerified || (!model.job && !model.jobSubmission && !model.jobUnknown)) return "";
    if (model.jobHidden) return "";
    const job = model.job;
    // 失败原因留在后台回执中；用户只需要知道失败了，以及可以重新导出。
    const key = model.jobUnknown ? "exportJobUnknown" : model.jobSubmission ? "exportJobStarting"
      : { busy: "exportJobBusy", starting: "exportJobStarting", generating: "exportJobGenerating",
        saving: "exportJobSaving", cancelling: "exportJobCancelling", completed: "exportJobCompleted",
        failed: "exportJobFailed", cancelled: "exportJobCancelled" }[job?.state];
    const progress = job?.progress;
    // 字体分片等内部资源数不是用户进度。只在确有文件总数时显示进度，不编造百分比。
    const detail = job?.state === "generating" && progress?.phase === "files" && progress.total > 1
      ? translate("exportJobFiles", { done: progress.done, total: progress.total }) : "";
    const warnings = job?.warnings || [];
    const warningHtml = warnings.length ? '<details class="export-warning" data-export-job-warnings' + (model.jobWarningsOpen ? ' open' : '') + '><summary>' + escapeHtml(translate("exportContentWarnings"))
      + '</summary><ul>' + warnings.map(w => '<li>' + escapeHtml(w) + '</li>').join("") + '</ul></details>' : "";
    const cancellable = model.jobCancellable;
    const spinner = key === "exportJobGenerating" ? '<span class="export-job__spinner" aria-hidden="true"></span>' : "";
    return '<section class="export-job" data-list-key="job" data-export-job tabindex="-1" aria-label="' + escapeHtml(translate("exportJobTitle")) + '">'
      + '<div class="export-job__heading"><strong role="status" aria-live="polite">' + spinner + escapeHtml(translate(key)) + '</strong>'
      + (cancellable ? '<button type="button" data-export-job-cancel>' + escapeHtml(translate("exportJobCancel")) + '</button>' : "")
      + (!jobBusy() && model.jobTerminal ? '<button type="button" data-export-job-dismiss aria-label="'
        + escapeHtml(translate("exportJobDismiss")) + '" title="' + escapeHtml(translate("exportJobDismiss")) + '">×</button>' : "") + '</div>'
      + (job?.outputName ? '<div class="export-job__name">' + escapeHtml(job.outputName) + '</div>' : "")
      + (detail ? '<div class="export-job__detail">' + escapeHtml(detail) + '</div>' : "")
      + (model.jobUnknown ? '<div class="export-job__actions"><button type="button" data-export-job-check>' + escapeHtml(translate("checkResult")) + '</button>'
        + '<button type="button" data-export-downloads>' + escapeHtml(translate("viewDownloads")) + '</button></div>' : "")
      + warningHtml + '</section>';
  }

  if (!model.scopeVerified) {
    return `<div class="export-preview-state" data-list-key="account-required" role="status"><span>${escapeHtml(translate("exportAccountRequired"))}</span><button type="button" data-retry-library>${escapeHtml(translate("retry"))}</button></div>`;
  }

  const title = model.currentTitle;
  const isBatch = model.mode === "batch";
  const currentSyncing = !isBatch && (model.loading || model.documentStale || model.currentResponsePending || responseInProgress());
  const refreshDisabled = !model.accountKey || model.loading || model.batchLoading || currentSyncing
    || (isBatch ? !basketCount() || !batchSourcesReady() : !isBoundSnapshot());
  const refreshLabel = currentSyncing ? (responseInProgress() ? "exportWaiting" : "exportRefreshing") : "exportRefresh";
  const refreshButton = `<button type="button" data-export-refresh${refreshDisabled ? " disabled" : ""}>${escapeHtml(translate(refreshLabel))}</button>`;
  const formatButtons = Object.entries(FORMAT_META).map(([key, meta]) => `<button type="button" data-export-format="${key}" class="${model.format === key ? "is-active" : ""}" aria-pressed="${model.format === key}">${meta.label}</button>`).join("");
  const modeTabs = `<div class="export-mode-tabs" role="tablist" aria-label="${escapeHtml(translate("exportMode"))}"><button type="button" role="tab" data-export-mode="current" class="${!isBatch ? "is-active" : ""}" aria-selected="${!isBatch}">${escapeHtml(translate("currentConversation"))}</button><button type="button" role="tab" data-export-mode="batch" class="${isBatch ? "is-active" : ""}" aria-selected="${isBatch}">${escapeHtml(translate("exportBatch"))}${basketCount() ? `<span>${basketCount() > 99 ? "99+" : basketCount()}</span>` : ""}</button></div>`;
  const fixedScope = isBatch
    ? batchFixedScopeMarkup()
    : `<div class="export-fixed-scope export-fixed-scope--current"><span>${escapeHtml(translate("exportScope"))}</span><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(translate("messagesCount", { count: messageCount() }))}</small></div></div>`;
  const sharedSettings = `<section data-list-key="format" class="export-block export-format"><div class="export-block__heading"><span>${escapeHtml(translate("exportFormat"))}</span></div><div class="export-format__buttons" role="group" aria-label="${escapeHtml(translate("exportFormat"))}">${formatButtons}</div></section><section data-list-key="settings-links" class="export-settings-links">${settingsLink("shared", "exportContentOptions", exportContentSummary(), "content")}${settingsLink("shared", "exportRoleNames", `${resolvedRoleNames().user} / ${resolvedRoleNames().assistant}`, "roles")}${model.format === "pdf" ? settingsLink("pdf", "exportPdfAppearance", pdfSummary()) : ""}</section>`;
  const extension = FORMAT_META[model.format].extension;
  const filename = `<section data-list-key="filename" class="export-block export-filenames"><div class="export-block__heading"><span>${escapeHtml(translate("exportFilename"))}</span></div><label class="export-file-field is-unlabeled"><span><input type="text" data-export-filename="current" value="${escapeHtml(model.filename)}" aria-label="${escapeHtml(translate("exportFilename"))}"><i>${extension}</i></span></label></section>`;
  // 只让预览内容和就绪条件区分模式，外框、入口与留白共用，避免两套模板再次分叉。
  const preview = model.settingsView ? "" : `<section data-list-key="preview" class="export-block export-preview-block export-preview-block--${model.format}"><div class="export-block__heading"><span>${escapeHtml(translate("exportPreview"))}</span>${refreshButton}</div><div class="export-preview__clip"><div class="export-preview__canvas" data-export-preview-body>${isBatch ? batchPreviewMarkup() : currentPreviewMarkup()}</div><span class="export-preview__fade" aria-hidden="true"></span></div><button class="export-preview__open" type="button" data-export-full-preview${((isBatch ? batchPlanReady() : currentPlanReady()) && !pendingImageCount()) ? "" : " disabled"}>${escapeHtml(translate("exportViewFullPreview"))}</button></section>`;
  const errorStatus = model.exportError
    ? `<div data-list-key="error" class="export-error" role="alert"><strong>${escapeHtml(translate("exportGenerationFailed"))}</strong><span>${escapeHtml(noticeText(model.exportError))}</span></div>`
    : isBatch ? selectionErrorMarkup() : "";
  const imagesPending = pendingImageCount();
  const canExport = (isBatch ? batchPlanReady() : currentPlanReady()) && !imagesPending;
  const actionDisabled = Boolean(model.jobSubmission) || (!jobBusy() && (!canExport || model.loading || model.batchLoading));
  const actionLabel = jobBusy() ? translate("exportJobShowProgress") : imagesPending ? translate("exportImagesPreparing", { count: imagesPending }) : `${translate("exportAction")} ${FORMAT_META[model.format].label}`;
  const batchEmpty = isBatch && !basketCount();
  const settingsPreview = ["shared", "pdf"].includes(model.settingsView);
  const previewDisabled = !canExport;
  const previewAction = settingsPreview
    ? `<button type="button" class="export-action-bar__preview" data-export-full-preview${previewDisabled ? " disabled" : ""}>${escapeHtml(translate("exportPreviewAction"))}</button>`
    : "";
  const actionBar = batchEmpty
    ? jobMarkup()
    : `<footer data-list-key="actions" class="export-action-bar">${jobMarkup()}${errorStatus}${warningsMarkup()}${model.settingsView && (isBatch ? model.batchStaleCount : currentSyncing) ? `<div data-list-key="refresh-notice" class="export-refresh-notice" role="status"><span>${escapeHtml(isBatch ? translate("exportContentChanged") : currentSyncLabel())}</span>${refreshButton}</div>` : ""}<div data-list-key="action-buttons" class="export-action-bar__main${settingsPreview ? " has-preview" : " is-button-only"}">${previewAction}<button type="button" data-export-action ${actionDisabled ? "disabled" : ""}>${escapeHtml(actionLabel)}</button></div></footer>`;
  const fixedTop = `<div data-list-key="fixed-top" class="export-fixed-top">${modeTabs}${fixedScope}</div>`;
  const batchBody = !isBatch || model.settingsView ? "" : batchEmpty
    ? `<div class="export-basket">${batchListMarkup()}</div>`
    : `<div data-list-key="settings" class="export-current-settings">${batchOrganizationMarkup()}<div data-list-key="shared-heading" class="export-shared-heading">${escapeHtml(translate("exportUnifiedSettings"))}</div>${sharedSettings}${batchFilenameMarkup()}</div>${preview}<div class="export-scroll__end" aria-hidden="true"></div>`;
  const secondaryBody = !model.settingsView ? "" : model.settingsView === "manage"
    ? batchManageMarkup(actionBar)
    : `${secondaryMarkup()}${actionBar}`;
  // 复用已有的增量 DOM 更新器。稳定分区和条目使用 key，预览/任务进度更新
  // 不再拆掉开关、下拉框及输入框，也不需要为每种控件逐个“抢回焦点”。
  return model.settingsView
    ? `<div data-list-key="panel:${model.mode}:${model.settingsView || "main"}" class="export-panel export-panel--${isBatch ? "batch" : "current"} is-secondary">${secondaryBody}</div>`
    : `<div data-list-key="panel:${model.mode}:${model.settingsView || "main"}" class="export-panel export-panel--${isBatch ? "batch" : "current"}${batchEmpty ? " is-empty" : ""}">${fixedTop}<div data-list-key="settings-scroll" class="export-scroll export-scroll--${isBatch ? "batch" : "current"}" data-export-scroll>${isBatch ? batchBody : `<div data-list-key="settings" class="export-current-settings">${sharedSettings}${filename}</div><div data-list-key="spacer" class="export-current-spacer" aria-hidden="true"></div>${preview}`}</div>${actionBar}</div>`;
}
