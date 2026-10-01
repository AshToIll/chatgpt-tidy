import { clampPage } from "../../../platform/ui/pagination.js";
import { escapeHtml } from "../../../platform/ui/html.js";
import {
  BOOKMARK_GROUP_ICONS,
  bookmarkGroupCounts,
  selectBookmarks,
} from "../storage/bookmarks-domain.js";
import { effectiveTimeZone } from "../../../platform/preferences/preferences.js";
import { currentContextCardMarkup } from "../../../platform/ui/current-context-card.js";
import { renderListMarkup } from "../../../platform/ui/stable-list-dom.js";
import { createLibraryTransientUi } from "../../../platform/ui/library-transient-ui.js";
import { createGroupNameEditor } from "../../../platform/ui/group-name-editor.js";
import { createPanelConfirmation } from "../../../platform/ui/panel-confirmation.js";
import { libraryEntryMenuMarkup } from "../../../platform/ui/library-entry-menu.js";
import { positionLibraryOverlay } from "../../../platform/ui/library-overlay-position.js";

const BOOKMARK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.75C7 3.78 7.78 3 8.75 3h6.5C16.22 3 17 3.78 17 4.75v15.1l-5-3.05-5 3.05V4.75Z"></path></svg>';
const GROUP_ICON_MARKUP = Object.freeze({
  quote: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h5v5H7.5A3.5 3.5 0 0 0 11 14.5V18H9a5 5 0 0 1-5-5V8a2 2 0 0 1 2-2ZM18 6h2v5h-3.5a3.5 3.5 0 0 0 3.5 3.5V18h-2a5 5 0 0 1-5-5V8a2 2 0 0 1 5-2Z"></path></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 4 6 6-2.5 2.5-1.7-.3-3 3 1.2 3.8-1 1-3.6-3.6-3.4 3.4-.9-.9 3.4-3.4L5 12l1-1 3.8 1.2 3-3-.3-1.7L14 4Z"></path></svg>',
  highlighter: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16 8.5-8.5 4 4L8 20H4v-4Z"></path><path d="m14 6 2-2 4 4-2 2M4 20h16"></path></svg>',
  note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5z"></path><path d="M8 8h8M8 12h8M8 16h5"></path></svg>',
  flag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4m0 1h11l-2 3 2 3H6"></path></svg>',
  "chat-bubble": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v10H9l-4 4V5Z"></path><path d="M8 9h8M8 12h5"></path></svg>',
  "text-mark": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14M12 5v14M8 19h8"></path><path d="M7 13h10"></path></svg>',
  sparkle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3ZM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z"></path></svg>',
  all: BOOKMARK_ICON,
  ungrouped: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5z"></path><path d="M8 8h8M8 12h8M8 16h5"></path></svg>',
});
const LOCALES = Object.freeze({ "zh-CN": "zh-CN", "zh-TW": "zh-TW", en: "en-US", ja: "ja-JP" });
// 第一项是默认每页条数；书签带正文摘录，比收藏更占高度，因此默认只显示 6 条。
const PAGE_SIZE_OPTIONS = Object.freeze([6, 10, 15, 20]);

function iconMarkup(icon) { return GROUP_ICON_MARKUP[icon] || GROUP_ICON_MARKUP.note; }
function groupName(group, t) {
  const presets = { "bookmark-quote": "bookmarkPresetQuote", "bookmark-insight": "bookmarkPresetInsight", "bookmark-todo": "bookmarkPresetTodo" };
  return group?.preset && presets[group.preset] ? t(presets[group.preset]) : group?.name || "";
}
function formatMessageTime(item, preferences) {
  if (!item.messageTimestamp) return "";
  return globalThis.TidyTimeFormat.formatDateTime(item.messageTimestamp, {
    timeZone: effectiveTimeZone(preferences),
    locale: LOCALES[preferences.language] || "en-US",
    dateFormat: preferences.dateFormat,
    precision: preferences.messageTimePrecision,
  }) || "";
}

export function createBookmarksView({ root, onAction, onExportAction = () => {}, confirmation = null }) {
  const ownsConfirmation = !confirmation;
  confirmation ||= createPanelConfirmation({ document: root.ownerDocument });
  let disposed = false;
  let model = null;
  let visualRevision = 0;
  let lifecycleEpoch = 0;
  let pendingDelete = null;
  let openMenuGroupId = null;
  let iconPickerGroupId = null;
  let openEntryId = null;
  let draggingGroupId = null;
  let pageSize = PAGE_SIZE_OPTIONS[0];
  let page = 1;
  let renderedViewKey = null;
  let groupListScrollTop = 0;
  let resetResultScroll = false;
  let composing = false;
  let nameComposing = false;
  const resultScrollTopByView = new Map();

  const transientUi = createLibraryTransientUi({
    root,
    getState: () => {
      const groupId = iconPickerGroupId || openMenuGroupId, entryId = openEntryId;
      return { open: Boolean(groupId || entryId), findTrigger: () => groupId
        ? [...root.querySelectorAll("[data-bookmark-group-menu]")].find(button => button.dataset.bookmarkGroupMenu === groupId)
        : [...root.querySelectorAll("[data-bookmark-entry-menu]")].find(button => button.dataset.bookmarkEntryMenu === entryId) };
    },
    isInside: target => Boolean(root.contains(target) && target.closest("[data-bookmark-group-overlay], [data-bookmark-entry-overlay], [data-bookmark-group-menu], [data-bookmark-entry-menu]")),
    close: () => { openMenuGroupId = null; iconPickerGroupId = null; openEntryId = null; },
    render: removeRenderedOverlays,
    onHidden: dismissTransientUi,
  });
  const nameEditor = createGroupNameEditor({
    id: "bookmark-group-name",
    onValidation(required, clearReasonCode) {
      globalThis.ChatGPTTidyDiagnostics?.notice({
        event: required ? "show" : "clear", surface: "bookmarks.group-name-validation",
        source: "src/features/bookmarks/ui/bookmarks-view.js", messageKey: "groupNameRequired",
        reasonCode: required ? "VALIDATION_ERROR" : clearReasonCode,
      });
    },
  });

  function dismissTransientUi() {
    lifecycleEpoch += 1;
    visualRevision += 1;
    pendingDelete = null;
    confirmation.cancel({ owner: root });
    transientUi.dismiss();
  }

  function openGroupEditor(groupId = null) {
    const group = groupId && model.store.groups.find(item => item.id === groupId);
    if (groupId && !group) return;
    transientUi.dismiss();
    nameComposing = false;
    nameEditor.open({ groupId, value: group ? groupName(group, model.t) : model.t("newGroupDefault") });
    render();
    transientUi.queueFocus(() => root.querySelector("[data-group-name-input]"), { select: true });
  }

  async function deleteGroup(groupId) {
    const group = model?.store.groups.find(item => item.id === groupId);
    if (!group) return;
    const token = { epoch: lifecycleEpoch, groupId, name: group.name, preset: group.preset };
    pendingDelete = token;
    transientUi.dismiss();
    const accepted = await confirmation.ask({
      owner: root, title: model.t("deleteGroup"),
      message: model.t("deleteBookmarkGroupConfirm", { name: groupName(group, model.t) }),
      confirmLabel: model.t("deleteGroup"), cancelLabel: model.t("cancel"),
      returnFocus: () => [...root.querySelectorAll("[data-bookmark-group-menu]")].find(button => button.dataset.bookmarkGroupMenu === groupId),
    });
    // 异步确认只授权点击当时的目标；离栏或账号重置不能把旧确认带到新界面。
    const current = model?.store.groups.find(item => item.id === groupId);
    if (pendingDelete !== token) return;
    pendingDelete = null;
    if (!accepted || token.epoch !== lifecycleEpoch || !current || current.name !== token.name || current.preset !== token.preset) return;
    if (model.store.view.groupId === groupId) resetResultScroll = true;
    void act("group-delete", { groupId });
  }

  function removeRenderedOverlays() {
    // Search input must keep focus, so close already-rendered overlays without
    // rebuilding the whole view. The next model render reconciles row state.
    root.querySelector("[data-bookmark-group-overlay]")?.remove();
    root.querySelector("[data-bookmark-entry-overlay]")?.remove();
    root.querySelectorAll(".bookmark-group-row.is-menu-open, .bookmark-group-row.is-picker-open")
      .forEach((row) => row.classList.remove("is-menu-open", "is-picker-open"));
    root.querySelectorAll('[data-bookmark-group-menu][aria-expanded="true"], [data-bookmark-entry-menu][aria-expanded="true"]')
      .forEach((button) => button.setAttribute("aria-expanded", "false"));
  }

  function captureScroll() {
    const groups = root.querySelector("[data-bookmark-group-list]");
    if (groups) groupListScrollTop = Math.max(0, Number(groups.scrollTop) || 0);
    const results = root.querySelector('[data-results-viewport="bookmarks"]');
    if (results && renderedViewKey) resultScrollTopByView.set(renderedViewKey, Math.max(0, Number(results.scrollTop) || 0));
  }
  function restoreScroll(viewKey) {
    const groups = root.querySelector("[data-bookmark-group-list]");
    if (groups) groups.scrollTop = groupListScrollTop;
    const results = root.querySelector('[data-results-viewport="bookmarks"]');
    if (results) results.scrollTop = resetResultScroll ? 0 : resultScrollTopByView.get(viewKey) || 0;
    resetResultScroll = false;
  }
  function currentConversationId() {
    return globalThis.TidySnapshot?.isPersistenceEligible(model?.snapshot)
      ? model.snapshot.conversation.conversationId : null;
  }
  function rowForGroup(group, count, t) {
    const system = group.system === true;
    const active = model.store.view.groupId === group.id;
    const menuOpen = openMenuGroupId === group.id;
    const pickerOpen = iconPickerGroupId === group.id;
    const editing = !system && nameEditor.state?.groupId === group.id;
    const name = groupName(group, t);
    if (editing) return `<form class="bookmark-group-row bookmark-group-edit is-editing" data-list-key="group:${escapeHtml(group.id)}" data-bookmark-group-row="${escapeHtml(group.id)}" data-bookmark-group-rename="${escapeHtml(group.id)}" novalidate><span class="bookmark-group-icon">${iconMarkup(group.icon)}</span>${nameEditor.inputMarkup({ label: t("groupName") })}<button type="submit" aria-label="${escapeHtml(t("rename"))}">✓</button><button type="button" data-cancel-group-edit aria-label="${escapeHtml(t("cancel"))}">×</button>${nameEditor.errorMarkup({ message: t("groupNameRequired") })}</form>`;
    return `<div class="bookmark-group-row${active ? " is-active" : ""}${system ? " is-system" : ""}${menuOpen ? " is-menu-open" : ""}${pickerOpen ? " is-picker-open" : ""}" data-list-key="group:${escapeHtml(group.id)}" data-bookmark-group-row="${escapeHtml(group.id)}" draggable="${!system && !menuOpen && !pickerOpen}"><button class="bookmark-group-select" type="button" data-bookmark-select-group="${escapeHtml(group.id)}" aria-current="${active ? "page" : "false"}"><span class="bookmark-group-icon">${iconMarkup(group.icon)}</span><span class="bookmark-group-name" data-bookmark-group-name="${escapeHtml(group.id)}" title="${system ? "" : escapeHtml(t("doubleClickRename"))}">${escapeHtml(name)}</span><span class="bookmark-group-count">${count}</span></button>${system ? "" : `<button class="bookmark-group-menu-toggle" type="button" data-bookmark-group-menu="${escapeHtml(group.id)}" aria-label="${escapeHtml(t("manageGroup", { name }))}" aria-expanded="${menuOpen || pickerOpen}">···</button>`}</div>`;
  }
  function groupOverlay(t) {
    const groupId = iconPickerGroupId || openMenuGroupId;
    const group = model.store.groups.find((item) => item.id === groupId);
    if (!group) return "";
    if (iconPickerGroupId) {
      return `<div class="bookmark-group-overlay bookmark-icon-picker" data-bookmark-group-overlay="${escapeHtml(groupId)}" role="group" aria-label="${escapeHtml(t("chooseIcon"))}">${BOOKMARK_GROUP_ICONS.map((icon) => `<button class="bookmark-icon-choice${group.icon === icon ? " is-selected" : ""}" type="button" data-bookmark-group-icon="${icon}" data-bookmark-group-id="${escapeHtml(groupId)}" aria-label="${escapeHtml(t({ "chat-bubble": "chatBubble", "text-mark": "textMark" }[icon] || icon))}">${iconMarkup(icon)}</button>`).join("")}</div>`;
    }
    return `<div class="bookmark-group-overlay bookmark-group-menu" data-bookmark-group-overlay="${escapeHtml(groupId)}" role="menu"><button type="button" data-bookmark-group-action="rename" data-bookmark-group-id="${escapeHtml(groupId)}">${escapeHtml(t("rename"))}</button><button type="button" data-bookmark-group-action="icon" data-bookmark-group-id="${escapeHtml(groupId)}">${escapeHtml(t("changeIcon"))}</button><button class="is-danger" type="button" data-bookmark-group-action="delete" data-bookmark-group-id="${escapeHtml(groupId)}">${escapeHtml(t("deleteGroup"))}</button></div>`;
  }
  function entryOverlay(t) {
    const item = model.store.items?.[openEntryId];
    if (!item) return "";
    const groups = [{ id: "ungrouped", label: t("ungrouped"), current: !item.groupId },
      ...model.store.groups.map(group => ({ id: group.id, label: groupName(group, t), current: item.groupId === group.id }))];
    return `<div class="bookmark-entry-overlay" data-bookmark-entry-overlay="${escapeHtml(item.bookmarkId)}">${libraryEntryMenuMarkup({ heading: t("moveToGroup"), groups, removeLabel: t("removeBookmark") })}</div>`;
  }
  function positionOverlay(layerSelector, overlaySelector, sourceSelector, sourceAttribute) {
    const layer = root.querySelector(layerSelector);
    const overlay = layer?.querySelector(overlaySelector);
    if (!layer || !overlay) return;
    const id = overlay.dataset[sourceAttribute];
    const source = [...root.querySelectorAll(sourceSelector)].find((node) => (
      sourceAttribute === "bookmarkGroupOverlay"
        ? node.dataset.bookmarkGroupRow === id
        : node.dataset.bookmarkJump === id
    ));
    positionLibraryOverlay({ layer, overlay, anchor: source });
  }
  function positionOverlays() {
    positionOverlay("[data-bookmark-group-overlay-layer]", "[data-bookmark-group-overlay]", "[data-bookmark-group-row]", "bookmarkGroupOverlay");
    positionOverlay("[data-bookmark-entry-overlay-layer]", "[data-bookmark-entry-overlay]", "[data-bookmark-jump]", "bookmarkEntryOverlay");
  }
  function exportSelectionHeader(selection, t) {
    if (!selection?.active) return "";
    const title = selection.returnTarget === "manage"
      ? t("exportList")
      : selection.returnTarget === "batch-main"
        ? t("exportBatch")
        : t("cancelExportSelection");
    return `<header class="export-secondary-header" data-list-key="selection-back"><button type="button" data-export-selection-back aria-label="${escapeHtml(t("exportBackToSelection", { title }))}">‹</button><strong>${escapeHtml(title)}</strong></header>`;
  }

  function exportSelectionFooter(selection, t) {
    if (!selection?.active) return "";
    const count = Number(selection.draftIds?.length) || 0;
    return `<footer class="source-export-select__footer" data-list-key="selection-footer"><span>${escapeHtml(t("exportSelectedCount", { count, unit: t("bookmarkItemsUnit") }))}</span><button type="button" data-export-selection-submit="bookmarks"${count ? "" : " disabled"}>${escapeHtml(t("addToExportList"))}</button></footer>`;
  }

  function exportSourceNotice(selection, t) {
    if (!selection?.notice) return "";
    return `<div class="export-source-notice" data-list-key="selection-notice" role="status"><span>${escapeHtml(selection.notice)}</span><button type="button" data-export-view-basket>${escapeHtml(t("viewExportList"))}</button></div>`;
  }

  function bookmarkRow(item, currentView, t) {
    const time = formatMessageTime(item, model.preferences);
    const source = currentView ? "" : `<span class="bookmark-entry-source">${escapeHtml(item.conversationTitle || t("untitled"))}</span>`;
    const group = model?.store?.groups?.find((candidate) => candidate.id === item.groupId);
    const groupLabel = item.groupId ? (group?.name || t("ungrouped")) : t("ungrouped");
    // Reuse the live canonical number immediately; saved rows retain its
    // source when normal metadata refresh updates them. Old local indices
    // remain absent until that conversation has supplied a complete sequence.
    const live = model.snapshot?.conversation?.conversationId === item.conversationId
      ? model.snapshot.messages?.find(message => message.messageId === item.messageId) : null;
    const number = live?.order?.source === "chatgpt-api.canonical-active-branch" ? live.order.displayNumber
      : item.orderNumberSource === "chatgpt-api.canonical-active-branch" ? item.orderNumber : null;
    const numberMarkup = model.preferences.messageNumbersEnabled && Number.isSafeInteger(number) && number > 0
      ? `<span>#${number}</span>` : "";
    // Bookmark rows use compact machine-role labels because this line is metadata,
    // not conversational UI copy. Keep the localized "You / ChatGPT" wording
    // elsewhere in the product.
    const role = ["user", "assistant", "system", "tool"].includes(item.role)
      ? `${item.role.slice(0, 1).toUpperCase()}${item.role.slice(1)}`
      : "Unknown";
    const selection = model.exportSelection;
    if (selection?.active) {
      const selected = selection.draftIds?.includes(item.bookmarkId);
      const added = Boolean(selection.basketBookmarkIds?.includes(item.bookmarkId));
      return `<button class="bookmark-entry bookmark-entry--export${selected ? " is-selected" : ""}${added ? " is-added" : ""}" type="button" data-list-key="bookmark:${escapeHtml(item.bookmarkId)}" data-export-draft-bookmark="${escapeHtml(item.bookmarkId)}" aria-pressed="${Boolean(selected)}"${added ? " disabled" : ""}><span class="source-export-check" aria-hidden="true"></span><span class="bookmark-entry-main">${source}<span class="bookmark-entry-origin">${escapeHtml(t("bookmarkFromGroup", { group: groupLabel }))}</span><span class="bookmark-entry-meta">${numberMarkup}${time ? `<span>${escapeHtml(time)}</span>` : ""}<span class="bookmark-entry-meta__role">${escapeHtml(role)}</span></span><p>${escapeHtml(item.excerpt || t("messageMissing"))}</p></span>${added ? `<em>${escapeHtml(t("alreadyInExportList"))}</em>` : ""}</button>`;
    }
    const pending = model.pendingBookmarkId === item.bookmarkId;
    const progress = pending ? `<span class="bookmark-entry-progress" role="status">${escapeHtml(t("bookmarkLocating"))}</span>` : "";
    return `<article class="bookmark-entry${model.activeBookmarkId === item.bookmarkId ? " is-active" : ""}" data-list-key="bookmark:${escapeHtml(item.bookmarkId)}" data-bookmark-jump="${escapeHtml(item.bookmarkId)}" tabindex="0" role="button" aria-busy="${pending}" aria-label="${escapeHtml(t("jumpMessage"))}"><div class="bookmark-entry-main">${source}<div class="bookmark-entry-meta">${numberMarkup}${time ? `<span>${escapeHtml(time)}</span>` : ""}<span class="bookmark-entry-meta__role">${escapeHtml(role)}</span>${progress}</div><p>${escapeHtml(item.excerpt || t("messageMissing"))}</p></div><div class="bookmark-entry-actions"><button class="bookmark-entry-menu-toggle" type="button" data-bookmark-entry-menu="${escapeHtml(item.bookmarkId)}" aria-label="${escapeHtml(t("bookmarkActions"))}" aria-expanded="${openEntryId === item.bookmarkId}">···</button></div></article>`;
  }
  function pagination(total, totalPages, t) {
    return `<nav class="result-pagination" aria-label="${escapeHtml(t("pagination"))}"><label class="result-page-size" title="${escapeHtml(t("itemsPerPage"))}"><span class="result-page-size__select"><select data-bookmark-page-size>${PAGE_SIZE_OPTIONS.map((size) => `<option value="${size}"${size === pageSize ? " selected" : ""}>${size}</option>`).join("")}</select></span></label><span class="result-pagination__rail"><button class="result-pagination__step result-pagination__step--previous" type="button" data-bookmark-page="previous"${page <= 1 ? " disabled" : ""}></button><span class="result-pagination__position"><input class="result-pagination__input" data-bookmark-page-input value="${page}" data-page-total="${totalPages}" inputmode="numeric" /><span class="result-pagination__total">/ ${totalPages}</span></span><button class="result-pagination__step result-pagination__step--next" type="button" data-bookmark-page="next"${page >= totalPages || total === 0 ? " disabled" : ""}></button></span></nav>`;
  }

  function render(nextModel = model) {
    if (disposed) return;
    transientUi.invalidate();
    const revision = ++visualRevision;
    captureScroll();
    // 同一已核验账号内切会话时，路由快照会短暂缺失。只保留旧卡片的展示，
    // 不把“新聊天”闪出来；新会话绑定后立即换新卡片。账号失效会 reset 清空。
    if (nextModel?.pendingConversationId && model?.snapshot
      && !globalThis.TidySnapshot?.isPersistenceEligible(nextModel.snapshot)) {
      nextModel = { ...nextModel, snapshot: model.snapshot };
    }
    if (model?.store && nextModel?.store && model.store.view.groupId !== nextModel.store.view.groupId) {
      transientUi.dismiss({ rerender: false });
    }
    model = nextModel;
    if (!model?.store || !model?.t || !model?.preferences) return;
    const { store, snapshot, t } = model;
    const menuGroupId = iconPickerGroupId || openMenuGroupId;
    if (menuGroupId && !store.groups.some(group => group.id === menuGroupId)) transientUi.dismiss({ rerender: false });
    if (pendingDelete) {
      const current = store.groups.find(group => group.id === pendingDelete.groupId);
      if (!current || current.name !== pendingDelete.name || current.preset !== pendingDelete.preset) {
        pendingDelete = null;
        confirmation.cancel({ owner: root });
      }
    }
    if (nameEditor.state?.groupId && !store.groups.some(group => group.id === nameEditor.state.groupId)) {
      nameEditor.close("EDIT_TARGET_REMOVED");
      nameComposing = false;
    }
    const selection = model.exportSelection || { active: false };
    const conversationId = currentConversationId();
    // A stale snapshot must never lend its title to the active tab card. The
    // same persistence boundary that proves the current conversation ID also
    // proves which snapshot may supply the title.
    const activeSnapshot = conversationId && snapshot?.conversation?.conversationId === conversationId
      ? snapshot : null;
    const counts = bookmarkGroupCounts(store, conversationId);
    const currentActive = store.view.groupId === "current";
    const title = activeSnapshot?.conversation?.title?.value || t("newChat");
    const currentCount = counts.current || 0;
    // Bookmarks keeps its view-selection semantics; only presentation is
    // delegated to the same primitive used by Favorites.
    const currentCard = currentContextCardMarkup({
      variant: "summary",
      selected: currentActive,
      attributes: {
        "data-bookmark-select-group": "current",
        "data-list-key": "current",
        "aria-current": currentActive ? "page" : "false",
      },
      title: t("currentConversation"),
      subtitle: title,
      trailing: `${BOOKMARK_ICON}<span>${currentCount}</span>`,
    });
    const systemGroups = [{ id: "all", icon: "all", system: true }, { id: "ungrouped", icon: "ungrouped", system: true }];
    const groups = [...systemGroups, ...store.groups].map((group) => rowForGroup({ ...group, name: group.id === "all" ? t("allBookmarks") : group.id === "ungrouped" ? t("ungrouped") : group.name }, counts[group.id] || 0, t)).join("");
    const entries = selectBookmarks(store, { currentConversationId: conversationId });
    const viewKey = `${store.view.groupId}:${store.view.query.trim() ? "search" : "normal"}:${store.view.sortField}:${store.view.sortDirection}`;
    if (renderedViewKey && renderedViewKey !== viewKey) page = 1;
    const pages = Math.max(1, Math.ceil(entries.length / pageSize));
    page = clampPage(page, pages);
    const visible = entries.slice((page - 1) * pageSize, page * pageSize);
    // 只有当前可见条目才持有菜单。分页、导出选择或资料刷新不能留下失去来源的浮层。
    if (openEntryId && (selection.active || !visible.some(item => item.bookmarkId === openEntryId))) {
      transientUi.dismiss({ rerender: false });
    }
    const rows = visible.length ? visible.map((item) => bookmarkRow(item, currentActive, t)).join("") : `<div class="bookmark-empty">${escapeHtml(t(Object.keys(store.items).length ? "emptyBookmarksView" : "emptyBookmarks"))}</div>`;
    const selectedGroup = store.groups.find((group) => group.id === store.view.groupId);
    const baseLabel = store.view.groupId === "current" ? t("bookmarks") : store.view.groupId === "all" ? t("allBookmarks") : store.view.groupId === "ungrouped" ? t("ungrouped") : groupName(selectedGroup, t);
    const label = store.view.query.trim() ? `${baseLabel} · ${t("searchResults")}` : baseLabel;
    const newGroup = nameEditor.state && !nameEditor.state.groupId ? `<form class="bookmark-group-create" data-list-key="new-group" data-bookmark-new-group novalidate>${nameEditor.inputMarkup({ label: t("groupName") })}<button type="submit" aria-label="${escapeHtml(t("create"))}">✓</button><button type="button" data-cancel-bookmark-new-group aria-label="${escapeHtml(t("cancel"))}">×</button>${nameEditor.errorMarkup({ message: t("groupNameRequired") })}</form>` : "";
    const selectableIds = entries
      .filter((item) => !selection.basketBookmarkIds?.includes(item.bookmarkId))
      .map((item) => item.bookmarkId);
    const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selection.draftIds?.includes(id));
    const rangeAction = selection.active
      ? `<button class="source-export-entry bookmark-export-entry" type="button" data-export-select-current="bookmarks"${selectableIds.length ? "" : " disabled"}>${escapeHtml(allSelected ? t("cancelSelectAll") : store.view.groupId === "all" ? t("selectAllCurrentRange") : store.view.groupId === "current" ? t("selectAllCurrentConversation") : t("selectAllCurrentGroup"))}</button>`
      : `<button class="source-export-entry bookmark-export-entry" type="button" data-export-select-mode="bookmarks">${escapeHtml(t("selectExport"))}</button>`;
    const backRow = exportSelectionHeader(selection, t);
    const currentHero = selection.active ? "" : currentCard;
    const footer = exportSelectionFooter(selection, t);
    const notice = selection.active ? "" : exportSourceNotice(selection, t);
    renderListMarkup(root, `<div class="bookmarks-panel${selection.active ? " is-export-select" : ""}">${backRow}${currentHero}<div class="bookmark-search-row" data-list-key="search"><input class="bookmark-search" type="search" data-bookmark-search value="${escapeHtml(store.view.query)}" placeholder="${escapeHtml(t("searchBookmarks"))}" aria-label="${escapeHtml(t("searchBookmarks"))}" /></div><section class="bookmark-groups-section" data-list-key="groups"><div class="bookmark-section-heading"><span>${escapeHtml(t("groups"))}</span><button class="bookmark-add-group" type="button" data-open-bookmark-new-group data-tooltip="${escapeHtml(t("newGroup"))}">+</button></div>${newGroup}<div class="bookmark-group-list" data-list-key="group-list" data-bookmark-group-list>${groups}</div></section><section class="bookmark-sort-section" data-list-key="sort"><div class="bookmark-section-heading"><span>${escapeHtml(t("sort"))}</span><div class="bookmark-sort-control"><select data-bookmark-sort><option value="bookmarkedAt"${store.view.sortField === "bookmarkedAt" ? " selected" : ""}>${escapeHtml(t("bookmarkSavedAt"))}</option><option value="messageTimestamp"${store.view.sortField === "messageTimestamp" ? " selected" : ""}>${escapeHtml(t("messageTimestamp"))}</option></select><button type="button" data-bookmark-sort-direction>${store.view.sortDirection === "asc" ? "↑" : "↓"}</button></div></div></section><section class="bookmark-list-section" data-list-key="results"><div class="bookmark-list-heading"><span>${escapeHtml(label)}</span>${rangeAction}<small>${escapeHtml(t("itemsCount", { count: entries.length }))}</small></div><div class="bookmark-entry-list" data-results-viewport="bookmarks">${rows}</div>${pagination(entries.length, pages, t)}</section>${footer}${notice}<div class="bookmark-group-overlay-layer" data-list-key="group-overlay" data-bookmark-group-overlay-layer>${groupOverlay(t)}</div><div class="bookmark-entry-overlay-layer" data-list-key="entry-overlay" data-bookmark-entry-overlay-layer>${entryOverlay(t)}</div></div>`);
    root.dataset.targetGroup = !store.view.query.trim() && selectedGroup ? selectedGroup.id : "ungrouped";
    renderedViewKey = viewKey;
    requestAnimationFrame(() => {
      if (!model || revision !== visualRevision) return;
      restoreScroll(viewKey);
      // 一次空名提交只定位一次；快照或翻译重绘不抢占正在编辑的其他控件。
      const viewport = root.querySelector("[data-bookmark-group-list]");
      nameEditor.revealInvalid({ root, viewport });
      if (viewport) groupListScrollTop = viewport.scrollTop;
      positionOverlays();
    });
  }
  async function act(action, payload = {}) { await onAction(action, payload); }

  root.addEventListener("submit", (event) => {
    if (!root.contains(event.target)) return;
    const form = event.target.closest("[data-bookmark-new-group], [data-bookmark-group-rename]");
    if (!form) return;
    event.preventDefault();
    // 等待保存回执时旧 DOM 仍可能存在；只消费当前编辑器的一次有效提交。
    if (!model || !nameEditor.state || nameComposing || event.isComposing) return;
    const groupId = form.dataset.bookmarkGroupRename || null;
    if (groupId !== nameEditor.state.groupId) return;
    const name = nameEditor.validate(new FormData(form).get("name"));
    if (!name) { render(); return; }
    nameEditor.close("FORM_SUBMITTED");
    if (!groupId) { page = 1; resetResultScroll = true; void act("group-create", { name }); }
    else void act("group-update", { groupId, patch: { name } });
  });
  root.addEventListener("input", (event) => {
    if (!model || !root.contains(event.target)) return;
    if (event.target.matches("[data-group-name-input]")) { nameEditor.updateInput(event.target); return; }
    if (!event.target.matches("[data-bookmark-search]") || composing) return;
    const query = event.target.value;
    if (query === model.store.view.query) return;
    transientUi.dismiss();
    resetResultScroll = true;
    void act("view-update", { query });
  });
  root.addEventListener("compositionstart", (event) => {
    if (!root.contains(event.target)) return;
    if (event.target.matches("[data-bookmark-search]")) composing = true;
    if (event.target.matches("[data-group-name-input]")) nameComposing = true;
  });
  root.addEventListener("compositionend", (event) => {
    if (!root.contains(event.target)) return;
    if (event.target.matches("[data-group-name-input]")) { nameComposing = false; nameEditor.updateInput(event.target); }
    if (event.target.matches("[data-bookmark-search]")) { composing = false; event.target.dispatchEvent(new Event("input", { bubbles: true })); }
  });
  root.addEventListener("change", (event) => {
    if (event.target.matches("[data-bookmark-sort]")) { transientUi.dismiss(); resetResultScroll = true; void act("view-update", { sortField: event.target.value }); }
    if (event.target.matches("[data-bookmark-page-size]")) { pageSize = PAGE_SIZE_OPTIONS.includes(Number(event.target.value)) ? Number(event.target.value) : PAGE_SIZE_OPTIONS[0]; page = 1; resetResultScroll = true; render(); }
    if (event.target.matches("[data-bookmark-page-input]")) { page = clampPage(event.target.value, Number(event.target.dataset.pageTotal) || 1); resetResultScroll = true; render(); }
  });
  root.addEventListener("dblclick", (event) => {
    if (!model || !root.contains(event.target)) return;
    const name = event.target.closest("[data-bookmark-group-name]");
    if (!name) return;
    openGroupEditor(name.dataset.bookmarkGroupName);
  });
  root.addEventListener("keydown", (event) => {
    const row = event.target.closest("[data-bookmark-jump]");
    const interactive = event.target.closest("button, input, textarea, select, form");
    if (event.target.matches("[data-bookmark-page-input]") && event.key === "Enter") { event.preventDefault(); event.target.blur(); return; }
    if (row && !interactive && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); void act("open", { bookmarkId: row.dataset.bookmarkJump }); }
  });
  root.addEventListener("click", (event) => {
    if (!model || !root.contains(event.target)) return;
    const button = event.target.closest("button");
    const row = event.target.closest("[data-bookmark-jump]");
    if (!button) {
      const insideOverlay = event.target.closest("[data-bookmark-group-overlay], [data-bookmark-entry-overlay]");
      if (!insideOverlay) transientUi.dismiss();
      if (row && !event.target.closest("input, textarea, select, form")) void act("open", { bookmarkId: row.dataset.bookmarkJump });
      return;
    }
    if (
      !event.target.closest("[data-bookmark-group-overlay], [data-bookmark-entry-overlay]") &&
      !button.matches("[data-bookmark-group-menu], [data-bookmark-entry-menu]")
    ) transientUi.dismiss();
    if (button.matches("[data-export-select-mode]")) {
      void onExportAction?.("start", {
        source: button.dataset.exportSelectMode,
        returnTarget: "source",
      });
    } else if (button.matches("[data-export-selection-back]")) {
      void onExportAction?.("selection-back", { source: "bookmarks" });
    } else if (button.matches("[data-export-draft-bookmark]")) {
      if (!button.disabled) void onExportAction?.("toggle", { source: "bookmarks", id: button.dataset.exportDraftBookmark });
    } else if (button.matches("[data-export-select-current]")) {
      if (!button.disabled) void onExportAction?.("select-current", {
        source: "bookmarks",
        ids: selectableIdsForExportSelection(),
      });
    } else if (button.matches("[data-export-selection-submit]")) {
      if (!button.disabled) void onExportAction?.("submit", { source: "bookmarks" });
    } else if (button.matches("[data-export-view-basket]")) {
      void onExportAction?.("view-basket", { source: "bookmarks" });
    } else if (button.matches("[data-open-bookmark-new-group]")) openGroupEditor();
    else if (button.matches("[data-cancel-bookmark-new-group]")) { nameEditor.close("FORM_CANCELLED"); nameComposing = false; render(); }
    else if (button.matches("[data-bookmark-select-group]")) { transientUi.dismiss(); resetResultScroll = true; void act("view-update", { groupId: button.dataset.bookmarkSelectGroup }); }
    else if (button.matches("[data-bookmark-sort-direction]")) { transientUi.dismiss(); resetResultScroll = true; void act("view-update", { sortDirection: model.store.view.sortDirection === "asc" ? "desc" : "asc" }); }
    else if (button.matches("[data-bookmark-page]")) { page += button.dataset.bookmarkPage === "next" ? 1 : -1; resetResultScroll = true; render(); }
    else if (button.matches("[data-bookmark-group-menu]")) { openEntryId = null; openMenuGroupId = openMenuGroupId === button.dataset.bookmarkGroupMenu ? null : button.dataset.bookmarkGroupMenu; iconPickerGroupId = null; render(); }
    else if (button.matches("[data-cancel-group-edit]")) { nameEditor.close("FORM_CANCELLED"); nameComposing = false; render(); }
    else if (button.matches("[data-bookmark-group-icon]")) {
      const groupId = button.dataset.bookmarkGroupId;
      if (iconPickerGroupId !== groupId) return;
      // 先收起当前选择器，再等待保存；旧按钮不能在回执前重复提交。
      transientUi.dismiss();
      void act("group-update", { groupId, patch: { icon: button.dataset.bookmarkGroupIcon } });
    }
    else if (button.matches("[data-bookmark-group-action]")) {
      const id = button.dataset.bookmarkGroupId; const action = button.dataset.bookmarkGroupAction;
      if (action === "rename") openGroupEditor(id);
      if (action === "icon") { iconPickerGroupId = id; openMenuGroupId = null; render(); }
      if (action === "delete") void deleteGroup(id);
    }
    else if (button.matches("[data-bookmark-entry-menu]")) {
      const id = button.dataset.bookmarkEntryMenu;
      if (!model.store.items?.[id]) return;
      openMenuGroupId = null; iconPickerGroupId = null;
      openEntryId = openEntryId === id ? null : id; render();
      if (openEntryId) transientUi.queueFocus(() => [...root.querySelectorAll("[data-bookmark-entry-overlay] button")].find(control => !control.disabled));
    }
    else if (button.matches("[data-library-move-group], [data-library-remove]")) {
      // 条目归属由当前菜单持有，不能用已移除的旧按钮重新获取写入目标。
      const bookmarkId = openEntryId, item = model.store.items?.[bookmarkId];
      if (!item || button.disabled) return;
      if (button.matches("[data-library-move-group]")) {
        const id = button.dataset.libraryMoveGroup;
        if (id !== "ungrouped" && !model.store.groups.some(group => group.id === id)) return;
        // 未分组在领域资料中是 null；按钮 sentinel 只用于 UI，不传入业务 payload。
        const groupId = id === "ungrouped" ? null : id;
        transientUi.dismiss();
        if ((item.groupId || null) !== groupId) void act("move", { bookmarkId, groupId });
      } else { transientUi.dismiss(); void act("remove", { bookmarkId }); }
    }
    else if (row) { void act("open", { bookmarkId: row.dataset.bookmarkJump }); }
  });
  root.addEventListener("dragstart", (event) => {
    const row = event.target.closest("[data-bookmark-group-row]");
    if (!row || row.classList.contains("is-system") || event.target.closest("input, button, textarea, select")) return;
    draggingGroupId = row.dataset.bookmarkGroupRow; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", draggingGroupId); row.classList.add("is-dragging");
  });
  root.addEventListener("dragover", (event) => { if (draggingGroupId && event.target.closest("[data-bookmark-group-row]:not(.is-system)")) event.preventDefault(); });
  root.addEventListener("drop", (event) => {
    const target = event.target.closest("[data-bookmark-group-row]:not(.is-system)")?.dataset.bookmarkGroupRow;
    if (!draggingGroupId || !target || target === draggingGroupId) return;
    event.preventDefault(); const ids = model.store.groups.map((group) => group.id); const from = ids.indexOf(draggingGroupId); const to = ids.indexOf(target); if (from < 0 || to < 0) return; const [moved] = ids.splice(from, 1); ids.splice(to, 0, moved); draggingGroupId = null; void act("group-reorder", { orderedGroupIds: ids });
  });
  root.addEventListener("dragend", () => { draggingGroupId = null; root.querySelectorAll(".is-dragging").forEach((row) => row.classList.remove("is-dragging")); });
  window.addEventListener("resize", positionOverlays);
  function selectableIdsForExportSelection() {
    if (!model?.store) return [];
    const selection = model.exportSelection || { basketBookmarkIds: [] };
    return selectBookmarks(model.store, { currentConversationId: currentConversationId() })
      .filter((item) => !selection.basketBookmarkIds?.includes(item.bookmarkId))
      .map((item) => item.bookmarkId);
  }

  // Forget private drafts and cached models at an account/lifecycle boundary.
  // Clearing only the root would allow a later local UI event to revive them.
  function reset() {
    lifecycleEpoch += 1;
    visualRevision += 1;
    pendingDelete = null;
    confirmation.cancel({ owner: root });
    transientUi.dismiss({ rerender: false });
    nameEditor.close("VIEW_RESET");
    model = null; openMenuGroupId = null;
    iconPickerGroupId = null; draggingGroupId = null;
    page = 1; groupListScrollTop = 0; resetResultScroll = false;
    renderedViewKey = null; openEntryId = null; composing = false; nameComposing = false;
    resultScrollTopByView.clear(); root.replaceChildren();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    reset();
    transientUi.dispose();
    window.removeEventListener("resize", positionOverlays);
    if (ownsConfirmation) confirmation.dispose();
  }
  return Object.freeze({ render, reset, dismissTransientUi, dispose });
}
