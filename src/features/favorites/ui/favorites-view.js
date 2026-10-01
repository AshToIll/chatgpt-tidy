import { clampPage } from "../../../platform/ui/pagination.js";
import { escapeHtml } from "../../../platform/ui/html.js";
import {
  GROUP_ICONS,
  favoriteGroupCounts,
  selectFavorites,
} from "../storage/favorites-domain.js";
import { effectiveTimeZone } from "../../../platform/preferences/preferences.js";
import { currentContextCardMarkup } from "../../../platform/ui/current-context-card.js";
import { renderListMarkup } from "../../../platform/ui/stable-list-dom.js";
import { createLibraryTransientUi } from "../../../platform/ui/library-transient-ui.js";
import { createGroupNameEditor } from "../../../platform/ui/group-name-editor.js";
import { createPanelConfirmation } from "../../../platform/ui/panel-confirmation.js";
import { libraryEntryMenuMarkup } from "../../../platform/ui/library-entry-menu.js";
import { positionLibraryOverlay } from "../../../platform/ui/library-overlay-position.js";

// 收藏页统一使用轻量线条图标；这里只负责展示，收藏和分组由资料仓库提供。
const STAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.78 5.63 6.22.9-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.92 1.06-6.2L3 9.53l6.22-.9L12 3Z"></path></svg>';
const BOOKMARK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.75A1.75 1.75 0 0 1 7.75 3h8.5A1.75 1.75 0 0 1 18 4.75V21l-6-3.5L6 21V4.75Z"></path></svg>';
const GROUP_ICON_MARKUP = Object.freeze({
  all: STAR_ICON,
  ungrouped: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h4l2 2h5A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-10Z"></path></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h4l2 2h5A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-10Z"></path></svg>',
  archive: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v3H4zM6 9.5h12v9H6zM9 13h6"></path></svg>',
  book: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v16H7.5A2.5 2.5 0 0 0 5 21V5.5ZM5 5.5v15M9 7h6"></path></svg>',
  briefcase: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="7" width="16" height="13" rx="2"></rect><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M4 12h16M10 12v2h4v-2"></path></svg>',
  bulb: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 16.5h7M9.5 19h5M8 13.5a5.5 5.5 0 1 1 8 0c-.8.8-1.5 1.6-1.7 3h-4.6c-.2-1.4-.9-2.2-1.7-3Z"></path></svg>',
  sparkle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3ZM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z"></path></svg>',
  heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 8.8c0 4.4-8 9.2-8 9.2S4 13.2 4 8.8A4.2 4.2 0 0 1 12 6a4.2 4.2 0 0 1 8 2.8Z"></path></svg>',
  box: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 7 8-4 8 4v10l-8 4-8-4V7Z"></path><path d="m4 7 8 4 8-4M12 11v10"></path></svg>',
});

const LOCALES = Object.freeze({ "zh-CN": "zh-CN", "zh-TW": "zh-TW", en: "en-US", ja: "ja-JP" });
const PAGE_SIZE_OPTIONS = Object.freeze([7, 10, 15, 20]);

function favoriteTime(item, preferences, sortField, t) {
  if (!preferences.timeDisplayEnabled) return "";
  const options = {
    timeZone: effectiveTimeZone(preferences),
    locale: LOCALES[preferences.language] || "en-US",
    dateFormat: preferences.dateFormat,
    precision: preferences.conversationTimePrecision,
  };
  if (sortField === "createdAt") {
    const value = globalThis.TidyTimeFormat.formatDateTime(item.createdAt, options);
    return value ? `${t("created")} ${value}` : "";
  }
  if (sortField === "updatedAt") {
    const value = globalThis.TidyTimeFormat.formatDateTime(item.updatedAt, options);
    return value ? `${t("updated")} ${value}` : "";
  }
  return globalThis.TidyTimeFormat.formatConversation({
    createdAt: { value: item.createdAt },
    updatedAt: { value: item.updatedAt },
  }, { ...options, mode: preferences.conversationTimeMode }) || "";
}

function iconMarkup(icon) {
  return GROUP_ICON_MARKUP[icon] || GROUP_ICON_MARKUP.folder;
}

function displayGroupName(group, t) {
  const presetKeys = {
    keepsake: "favoritePresetKeepsake",
    inspiration: "favoritePresetInspiration",
    study: "favoritePresetStudy",
    work: "favoritePresetWork",
  };
  return group?.preset && presetKeys[group.preset] ? t(presetKeys[group.preset]) : group?.name || "";
}

export function createFavoritesView({ root, onAction, onExportAction = () => {}, confirmation = null }) {
  const ownsConfirmation = !confirmation;
  confirmation ||= createPanelConfirmation({ document: root.ownerDocument });
  let disposed = false;
  let model = null;
  let visualRevision = 0;
  let lifecycleEpoch = 0;
  let pendingDelete = null;
  let openEntryId = null;
  let openMenuGroupId = null;
  let iconPickerGroupId = null;
  let draggingGroupId = null;
  let pageSize = PAGE_SIZE_OPTIONS[0];
  let page = 1;
  let lastViewSignature = null;
  let renderedResultViewKey = null;
  let groupListScrollTop = 0;
  let resetResultScroll = false;
  const resultScrollTopByView = new Map();

  // 仅临时界面共用机制；分组、收藏移动和账号写入仍由各自领域负责。
  const transient = createLibraryTransientUi({
    root,
    getState() {
      const groupId = iconPickerGroupId || openMenuGroupId;
      const entryId = openEntryId;
      return { open: Boolean(groupId || entryId), findTrigger: () => groupId
        ? [...root.querySelectorAll("[data-group-menu]")].find(button => button.dataset.groupMenu === groupId)
        : [...root.querySelectorAll("[data-favorite-menu]")].find(button => button.dataset.favoriteMenu === entryId) };
    },
    isInside: target => root.contains(target) && Boolean(target.closest?.("[data-group-overlay], [data-group-menu], [data-favorite-entry-overlay], [data-favorite-menu]")),
    close() { openMenuGroupId = null; iconPickerGroupId = null; openEntryId = null; },
    render,
    onHidden: dismissTransientUi,
  });
  const nameEditor = createGroupNameEditor({
    id: "favorite-group-name",
    onValidation(required, clearReasonCode) {
      globalThis.ChatGPTTidyDiagnostics?.notice({
        event: required ? "show" : "clear", surface: "favorites.group-name-validation",
        source: "src/features/favorites/ui/favorites-view.js", messageKey: "groupNameRequired",
        reasonCode: required ? "VALIDATION_ERROR" : clearReasonCode,
      });
    },
  });

  function dismissTransientUi() {
    lifecycleEpoch += 1;
    visualRevision += 1;
    pendingDelete = null;
    confirmation.cancel({ owner: root });
    transient.dismiss();
  }

  function openGroupEditor(groupId = null) {
    const group = groupId && model.store.groups.find(item => item.id === groupId);
    if (groupId && !group) return;
    transient.dismiss({ rerender: false });
    nameEditor.open({ groupId, value: group ? displayGroupName(group, model.t) : model.t("newGroupDefault") });
    render();
    transient.queueFocus(() => root.querySelector("[data-group-name-input]"), { select: true });
  }

  async function deleteGroup(groupId) {
    const group = model?.store.groups.find(item => item.id === groupId);
    if (!group) return;
    const token = { epoch: lifecycleEpoch, groupId, name: group.name, preset: group.preset };
    pendingDelete = token;
    const accepted = await confirmation.ask({
      owner: root, title: model.t("deleteGroup"),
      message: model.t("deleteGroupConfirm", { name: displayGroupName(group, model.t) }),
      confirmLabel: model.t("deleteGroup"), cancelLabel: model.t("cancel"),
      returnFocus: () => [...root.querySelectorAll("[data-group-menu]")].find(button => button.dataset.groupMenu === groupId),
    });
    // 对话框是异步的：栏目/账号失效或分组已被更名删除时，旧确认不能再写入。
    const current = model?.store.groups.find(item => item.id === groupId);
    if (pendingDelete !== token) return;
    pendingDelete = null;
    if (!accepted || token.epoch !== lifecycleEpoch || !current || current.name !== token.name || current.preset !== token.preset) return;
    if (model.store.view.groupId === groupId) resetResultScroll = true;
    void act("group-delete", { groupId });
  }

  function captureScrollPositions() {
    const groupList = root.querySelector("[data-group-list]");
    if (groupList) groupListScrollTop = Math.max(0, Number(groupList.scrollTop) || 0);
    const results = root.querySelector('[data-results-viewport="favorites"]');
    if (results && renderedResultViewKey) {
      resultScrollTopByView.set(renderedResultViewKey, Math.max(0, Number(results.scrollTop) || 0));
    }
  }

  function restoreScrollPositions(resultViewKey) {
    const groupList = root.querySelector("[data-group-list]");
    if (groupList) groupList.scrollTop = groupListScrollTop;
    const results = root.querySelector('[data-results-viewport="favorites"]');
    if (results) {
      results.scrollTop = resetResultScroll ? 0 : resultScrollTopByView.get(resultViewKey) || 0;
    }
    resetResultScroll = false;
  }

  function groupRow(group, count, t) {
    const system = group.system === true;
    const active = model.store.view.groupId === group.id;
    const menuOpen = openMenuGroupId === group.id;
    const pickerOpen = iconPickerGroupId === group.id;
    const editing = !system && nameEditor.state?.groupId === group.id;
    const groupName = displayGroupName(group, t);

    if (editing) {
      return `<form class="favorite-group-row favorite-group-edit is-editing" data-list-key="group:${escapeHtml(group.id)}" data-group-row="${escapeHtml(group.id)}" data-group-rename="${escapeHtml(group.id)}" novalidate>
        <span class="favorite-group-icon">${iconMarkup(group.icon)}</span>
        ${nameEditor.inputMarkup({ label: t("groupName") })}
        <button type="submit" aria-label="${escapeHtml(t("rename"))}">✓</button>
        <button type="button" data-cancel-group-edit aria-label="${escapeHtml(t("cancel"))}">×</button>
        ${nameEditor.errorMarkup({ message: t("groupNameRequired") })}
      </form>`;
    }

    return `<div class="favorite-group-row${active ? " is-active" : ""}${system ? " is-system" : ""}${menuOpen ? " is-menu-open" : ""}${pickerOpen ? " is-picker-open" : ""}" data-list-key="group:${escapeHtml(group.id)}" data-group-row="${escapeHtml(group.id)}" draggable="${!system && !menuOpen && !pickerOpen}">
      <button class="favorite-group-select" type="button" data-select-group="${escapeHtml(group.id)}" aria-current="${active ? "page" : "false"}">
        <span class="favorite-group-icon">${iconMarkup(group.icon)}</span>
        <span class="favorite-group-name" data-group-name="${escapeHtml(group.id)}" title="${system ? "" : escapeHtml(t("doubleClickRename"))}">${escapeHtml(groupName)}</span>
        <span class="favorite-group-count">${count}</span>
      </button>
      ${system ? "" : `<button class="favorite-group-menu-toggle" type="button" data-group-menu="${escapeHtml(group.id)}" aria-label="${escapeHtml(t("manageGroup", { name: groupName }))}" aria-expanded="${menuOpen || pickerOpen}">···</button>`}
    </div>`;
  }

  function groupOverlay(t) {
    const groupId = iconPickerGroupId || openMenuGroupId;
    const group = model.store.groups.find((candidate) => candidate.id === groupId);
    if (!group) return "";
    if (iconPickerGroupId === groupId) {
      const choices = GROUP_ICONS.map((icon) => `<button class="favorite-icon-choice${group.icon === icon ? " is-selected" : ""}" type="button" data-group-icon="${icon}" data-group-id="${escapeHtml(group.id)}" aria-label="${escapeHtml(t(icon))}" title="${escapeHtml(t(icon))}">${iconMarkup(icon)}</button>`).join("");
      return `<div class="favorite-group-overlay favorite-icon-picker" data-group-overlay="${escapeHtml(group.id)}" role="group" aria-label="${escapeHtml(t("chooseIcon"))}">${choices}</div>`;
    }
    return `<div class="favorite-group-overlay favorite-group-menu" data-group-overlay="${escapeHtml(group.id)}" role="menu">
      <button type="button" data-group-action="rename" data-group-id="${escapeHtml(group.id)}">${escapeHtml(t("rename"))}</button>
      <button type="button" data-group-action="icon" data-group-id="${escapeHtml(group.id)}">${escapeHtml(t("changeIcon"))}</button>
      <button class="is-danger" type="button" data-group-action="delete" data-group-id="${escapeHtml(group.id)}">${escapeHtml(t("deleteGroup"))}</button>
    </div>`;
  }

  function entryOverlay(t) {
    const item = model.store.items?.[openEntryId];
    if (!item) return "";
    const groups = [{ id: "ungrouped", label: t("ungrouped"), current: !item.groupId },
      ...model.store.groups.map(group => ({ id: group.id, label: displayGroupName(group, t), current: item.groupId === group.id }))];
    return `<div class="favorite-entry-overlay" data-favorite-entry-overlay="${escapeHtml(item.conversationId)}">${libraryEntryMenuMarkup({ heading: t("moveToGroup"), groups, removeLabel: t("pageFavoriteRemove") })}</div>`;
  }

  function positionOverlays() {
    const layer = root.querySelector("[data-group-overlay-layer]");
    if (!layer) return;
    const groupOverlay = layer.querySelector("[data-group-overlay]");
    const entryOverlay = layer.querySelector("[data-favorite-entry-overlay]");
    const overlay = groupOverlay || entryOverlay;
    const trigger = groupOverlay
      ? [...root.querySelectorAll("[data-group-menu]")].find(node => node.dataset.groupMenu === groupOverlay.dataset.groupOverlay)
      : entryOverlay && [...root.querySelectorAll("[data-favorite-menu]")].find(node => node.dataset.favoriteMenu === entryOverlay.dataset.favoriteEntryOverlay);
    if (overlay && trigger) positionLibraryOverlay({ layer, overlay, anchor: trigger });
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

  function exportSelectionFooter(selection, source, t) {
    if (!selection?.active) return "";
    const count = Number(selection.draftIds?.length) || 0;
    const unit = source === "bookmarks" ? t("bookmarkItemsUnit") : t("conversationItemsUnit");
    return `<footer class="source-export-select__footer" data-list-key="selection-footer"><span>${escapeHtml(t("exportSelectedCount", { count, unit }))}</span><button type="button" data-export-selection-submit="${source}"${count ? "" : " disabled"}>${escapeHtml(t("addToExportList"))}</button></footer>`;
  }

  function exportSourceNotice(selection, t) {
    if (!selection?.notice) return "";
    return `<div class="export-source-notice" data-list-key="selection-notice" role="status"><span>${escapeHtml(selection.notice)}</span><button type="button" data-export-view-basket>${escapeHtml(t("viewExportList"))}</button></div>`;
  }

  function favoriteRow(item, t) {
    const listTime = favoriteTime(item, model.preferences, model.store.view.sortField, t);
    // This count remains read-only until the Bookmarks module supplies real
    // records; the Favorites page never invents bookmark data.
    const bookmarkCount = Number(model.bookmarkCounts?.[item.conversationId]) || 0;
    const bookmark = bookmarkCount > 0
      ? `<span class="favorite-bookmark-stat" title="${escapeHtml(t("bookmarksCount", { count: bookmarkCount }))}">${BOOKMARK_ICON}<span>${bookmarkCount}</span></span>`
      : "";
    const selection = model.exportSelection;
    if (selection?.active) {
      const sources = selection.basketConversationSources?.[item.conversationId] || [];
      const added = sources.includes("favorites");
      const alreadyInBasket = sources.length > 0;
      const selected = selection.draftIds?.includes(item.conversationId);
      return `<button class="favorite-conversation favorite-conversation--export${selected ? " is-selected" : ""}${added ? " is-added" : ""}" type="button" data-list-key="conversation:${escapeHtml(item.conversationId)}" data-export-draft-conversation="${escapeHtml(item.conversationId)}" aria-pressed="${Boolean(selected)}"${added ? " disabled" : ""}><span class="source-export-check" aria-hidden="true"></span><span class="favorite-conversation__export-copy"><strong>${escapeHtml(item.title || t("untitled"))}</strong><span class="favorite-conversation-meta"><span>${escapeHtml(listTime)}</span>${bookmark}</span></span>${added ? `<em>${escapeHtml(t("alreadyInExportList"))}</em>` : alreadyInBasket ? `<em>${escapeHtml(t("supplementExportSource"))}</em>` : ""}</button>`;
    }
    // 导航与管理是相邻原生按钮，不嵌套点击目标；书签计数仍归属会话元信息。
    return `<div class="favorite-conversation-row" data-list-key="conversation:${escapeHtml(item.conversationId)}">
      <button class="favorite-conversation" type="button" data-open-favorite="${escapeHtml(item.conversationId)}">
        <strong>${escapeHtml(item.title || t("untitled"))}</strong>
        <span class="favorite-conversation-meta"><span>${escapeHtml(listTime)}</span>${bookmark}</span>
      </button>
      <button class="favorite-entry-menu-toggle" type="button" data-favorite-menu="${escapeHtml(item.conversationId)}" aria-label="${escapeHtml(t("favoritesActions"))}" aria-haspopup="menu" aria-expanded="${openEntryId === item.conversationId}">···</button>
    </div>`;
  }

  function pagination(total, totalPages, t) {
    const options = PAGE_SIZE_OPTIONS.map((size) => `<option value="${size}"${size === pageSize ? " selected" : ""}>${size}</option>`).join("");
    return `<nav class="result-pagination" aria-label="${escapeHtml(t("pagination"))}">
      <label class="result-page-size" title="${escapeHtml(t("itemsPerPage"))}"><span class="result-page-size__select"><select data-page-size aria-label="${escapeHtml(t("itemsPerPage"))}">${options}</select></span></label>
      <span class="result-pagination__rail">
        <button class="result-pagination__step result-pagination__step--previous" type="button" data-page-direction="previous" aria-label="${escapeHtml(t("previousPage"))}"${page <= 1 ? " disabled" : ""}></button>
        <span class="result-pagination__position"><input class="result-pagination__input" type="text" inputmode="numeric" value="${page}" data-page-input data-page-total="${totalPages}" aria-label="${escapeHtml(t("currentPage"))}" /><span class="result-pagination__total" aria-label="${escapeHtml(t("totalPages", { count: totalPages }))}">/ ${totalPages}</span></span>
        <button class="result-pagination__step result-pagination__step--next" type="button" data-page-direction="next" aria-label="${escapeHtml(t("nextPage"))}"${page >= totalPages || total === 0 ? " disabled" : ""}></button>
      </span>
    </nav>`;
  }

  function render(nextModel = model) {
    if (disposed) return;
    // Stable list nodes survive context changes. Keep explicit scroll handling
    // for genuine view/data changes, not as a substitute for DOM continuity.
    captureScrollPositions();
    visualRevision += 1;
    transient.invalidate();
    // 同一账号的快照/翻译重绘不改用户草稿；外部切组或删除目标则收起旧浮层。
    if (model?.store?.view.groupId !== nextModel?.store?.view.groupId) transient.dismiss({ rerender: false });
    model = nextModel;
    if (!model?.store || !model?.t) return;
    const { store, snapshot, t } = model;
    const overlayGroupId = iconPickerGroupId || openMenuGroupId;
    if (overlayGroupId && !store.groups.some((group) => group.id === overlayGroupId)) transient.dismiss({ rerender: false });
    if (nameEditor.state?.groupId && !store.groups.some((group) => group.id === nameEditor.state.groupId)) nameEditor.close("GROUP_REMOVED");
    if (pendingDelete) {
      const current = store.groups.find(group => group.id === pendingDelete.groupId);
      if (!current || current.name !== pendingDelete.name || current.preset !== pendingDelete.preset) {
        pendingDelete = null;
        confirmation.cancel({ owner: root });
      }
    }
    const selection = model.exportSelection || { active: false };
    if (openEntryId && (!store.items[openEntryId] || selection.active)) transient.dismiss({ rerender: false });
    const viewSignature = `${store.view.groupId}:${store.view.sortField}:${store.view.sortDirection}`;
    if (lastViewSignature !== null && lastViewSignature !== viewSignature) page = 1;
    lastViewSignature = viewSignature;

    const counts = favoriteGroupCounts(store);
    const currentEligible = globalThis.TidySnapshot?.isPersistenceEligible(snapshot) === true;
    const currentId = currentEligible ? snapshot.conversation.conversationId : null;
    const currentFavorite = currentId ? store.items[currentId] : null;
    const selectedCustomGroup = store.groups.some((group) => group.id === store.view.groupId) ? store.view.groupId : null;
    const systemGroups = [
      { id: "all", name: t("allFavorites"), icon: "all", system: true },
      { id: "ungrouped", name: t("ungrouped"), icon: "ungrouped", system: true },
    ];
    const groups = [...systemGroups, ...store.groups]
      .map((group) => groupRow(group, counts[group.id] || 0, t))
      .join("");

    const entries = selectFavorites(store);
    const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
    page = clampPage(page, totalPages);
    const visibleEntries = entries.slice((page - 1) * pageSize, page * pageSize);
    if (openEntryId && !visibleEntries.some(item => item.conversationId === openEntryId)) transient.dismiss({ rerender: false });
    const entryMarkup = visibleEntries.length
      ? visibleEntries.map((item) => favoriteRow(item, t)).join("")
      : `<div class="favorite-empty">${escapeHtml(t(store.view.groupId === "all" ? "emptyFavorites" : "emptyGroup"))}</div>`;
    const newGroup = nameEditor.state && !nameEditor.state.groupId ? `<form class="favorite-group-create" data-list-key="new-group" data-new-group novalidate>${nameEditor.inputMarkup({ label: t("groupName") })}<button type="submit" aria-label="${escapeHtml(t("create"))}">✓</button><button type="button" data-cancel-new-group aria-label="${escapeHtml(t("cancel"))}">×</button>${nameEditor.errorMarkup({ message: t("groupNameRequired") })}</form>` : "";
    const groupName = store.view.groupId === "all"
      ? t("allFavorites")
      : store.view.groupId === "ungrouped"
        ? t("ungrouped")
        : displayGroupName(store.groups.find((group) => group.id === store.view.groupId), t) || t("allFavorites");

    // Favorites supplies toggle semantics, while the shared primitive owns all
    // current-context layout and visual state.
    const currentCard = currentContextCardMarkup({
      variant: "centered",
      selected: Boolean(currentFavorite),
      disabled: !currentEligible,
      attributes: {
        "data-toggle-current": true,
        "aria-pressed": Boolean(currentFavorite),
      },
      leading: STAR_ICON,
      title: currentFavorite
        ? t("favoritedShort")
        : currentEligible
          ? t("favoriteCurrent")
          : t("favoriteUnavailable"),
      subtitle: !currentFavorite && currentEligible
        ? snapshot.conversation.title?.value || t("untitled")
        : "",
      trailing: currentFavorite ? "" : STAR_ICON,
    });

    const selectableIds = entries
      .filter((item) => !(selection.basketConversationSources?.[item.conversationId] || []).includes("favorites"))
      .map((item) => item.conversationId);
    const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selection.draftIds?.includes(id));
    const rangeAction = selection.active
      ? `<button class="source-export-entry favorite-export-entry" type="button" data-export-select-current="favorites"${selectableIds.length ? "" : " disabled"}>${escapeHtml(allSelected ? t("cancelSelectAll") : store.view.groupId === "all" ? t("selectAllCurrentRange") : t("selectAllCurrentGroup"))}</button>`
      : `<button class="source-export-entry favorite-export-entry" type="button" data-export-select-mode="favorites">${escapeHtml(t("selectExport"))}</button>`;
    const currentHero = selection.active ? "" : `<section class="favorite-current" data-list-key="current">${currentCard}</section>`;
    const backRow = exportSelectionHeader(selection, t);
    const notice = selection.active ? "" : exportSourceNotice(selection, t);
    const footer = exportSelectionFooter(selection, "favorites", t);
    renderListMarkup(root, `<div class="favorites-panel${selection.active ? " is-export-select" : ""}">${backRow}
      ${currentHero}
      <section class="favorite-groups-section" data-list-key="groups">
        <div class="favorite-section-heading"><span>${escapeHtml(t("groups"))}</span><button class="favorite-add-group" type="button" data-open-new-group aria-label="${escapeHtml(t("newGroup"))}" data-tooltip="${escapeHtml(t("newGroup"))}">+</button></div>
        ${newGroup}<div class="favorite-group-list" data-list-key="group-list" data-group-list>${groups}</div>
      </section>
      <section class="favorite-sort-section" data-list-key="sort"><div class="favorite-section-heading"><span>${escapeHtml(t("sort"))}</span><div class="favorite-sort-control"><select data-favorite-sort aria-label="${escapeHtml(t("sort"))}"><option value="savedAt"${store.view.sortField === "savedAt" ? " selected" : ""}>${escapeHtml(t("savedAt"))}</option><option value="createdAt"${store.view.sortField === "createdAt" ? " selected" : ""}>${escapeHtml(t("createdTime"))}</option><option value="updatedAt"${store.view.sortField === "updatedAt" ? " selected" : ""}>${escapeHtml(t("updatedTime"))}</option></select><button type="button" data-sort-direction aria-label="${escapeHtml(t(store.view.sortDirection === "asc" ? "ascending" : "descending"))}">${store.view.sortDirection === "asc" ? "↑" : "↓"}</button></div></div></section>
      <section class="favorite-list-section" data-list-key="results">
        <div class="favorite-list-heading"><span>${escapeHtml(groupName)}</span>${rangeAction}<small>${escapeHtml(t("itemsCount", { count: entries.length }))}</small></div>
        <div class="favorite-conversation-list" data-results-viewport="favorites">${entryMarkup}</div>
        ${pagination(entries.length, totalPages, t)}
      </section>${footer}${notice}
      <div class="favorite-group-overlay-layer" data-list-key="group-overlay" data-group-overlay-layer>${groupOverlay(t)}${entryOverlay(t)}</div>
    </div>`);
    root.dataset.targetGroup = selectedCustomGroup || "ungrouped";
    renderedResultViewKey = viewSignature;
    const revision = visualRevision;
    requestAnimationFrame(() => {
      if (!model || revision !== visualRevision) return;
      restoreScrollPositions(viewSignature);
      // 一次空名提交只消费一次定位请求；快照同帧重绘也不会丢失提示或重复抢焦点。
      const viewport = root.querySelector("[data-group-list]");
      nameEditor.revealInvalid({ root, viewport });
      if (viewport) groupListScrollTop = viewport.scrollTop;
      positionOverlays();
    });
  }

  async function act(type, payload = {}) {
    await onAction(type, payload);
  }

  root.addEventListener("submit", (event) => {
    if (!root.contains(event.target)) return;
    const form = event.target.closest("[data-new-group], [data-group-rename]");
    if (!form) return;
    event.preventDefault();
    // 保存回执前旧表单可能还在；重复提交不能触发浏览器默认导航。
    if (!model || !nameEditor.state) return;
    const groupId = form.dataset.groupRename || null;
    if (groupId !== nameEditor.state.groupId) return;
    const name = nameEditor.validate(String(new FormData(form).get("name") || ""));
    // 空名称是可直接修正的字段错误，不送入保存/同步的不确定结果处理。
    if (!name) {
      render();
      return;
    }
    nameEditor.close("FORM_SUBMITTED");
    if (!groupId) {
      page = 1;
      resetResultScroll = true;
      void act("group-create", { name });
    } else void act("group-update", { groupId, patch: { name } });
  });

  root.addEventListener("input", (event) => {
    if (!model || !nameEditor.state || !root.contains(event.target) || !event.target.matches("[data-group-name-input]")) return;
    nameEditor.updateInput(event.target);
  });

  root.addEventListener("change", (event) => {
    if (!model) return;
    if (event.target.matches("[data-favorite-sort]")) {
      page = 1;
      resetResultScroll = true;
      void act("view-update", { sortField: event.target.value });
    }
    if (event.target.matches("[data-page-size]")) {
      pageSize = PAGE_SIZE_OPTIONS.includes(Number(event.target.value)) ? Number(event.target.value) : PAGE_SIZE_OPTIONS[0];
      page = 1;
      resetResultScroll = true;
      render();
    }
    if (event.target.matches("[data-page-input]")) {
      page = clampPage(event.target.value, Number(event.target.dataset.pageTotal) || 1);
      resetResultScroll = true;
      render();
    }
  });

  root.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.matches("[data-page-input]")) {
      event.preventDefault();
      event.target.blur();
    }
  });

  root.addEventListener("dblclick", (event) => {
    if (!model) return;
    const name = event.target.closest("[data-group-name]");
    if (!name) return;
    openGroupEditor(name.dataset.groupName);
  });

  root.addEventListener("click", (event) => {
    if (!model || !root.contains(event.target)) return;
    const button = event.target.closest("button");
    const overlayControl = event.target.closest("[data-group-overlay], [data-group-menu], [data-favorite-entry-overlay], [data-favorite-menu]");
    if (!overlayControl) transient.dismiss();
    if (!button) return;
    if (button.matches("[data-export-select-mode]")) {
      void onExportAction?.("start", {
        source: button.dataset.exportSelectMode,
        returnTarget: "source",
      });
    } else if (button.matches("[data-export-selection-back]")) {
      void onExportAction?.("selection-back", { source: "favorites" });
    } else if (button.matches("[data-export-draft-conversation]")) {
      if (!button.disabled) void onExportAction?.("toggle", { source: "favorites", id: button.dataset.exportDraftConversation });
    } else if (button.matches("[data-export-select-current]")) {
      if (!button.disabled) void onExportAction?.("select-current", {
        source: "favorites",
        ids: selectableIdsForExportSelection(),
      });
    } else if (button.matches("[data-export-selection-submit]")) {
      if (!button.disabled) void onExportAction?.("submit", { source: "favorites" });
    } else if (button.matches("[data-export-view-basket]")) {
      void onExportAction?.("view-basket", { source: "favorites" });
    } else if (button.matches("[data-toggle-current]")) void act("toggle-current", { groupId: root.dataset.targetGroup });
    else if (button.matches("[data-open-new-group]")) {
      openGroupEditor();
    } else if (button.matches("[data-cancel-new-group]")) {
      nameEditor.close("FORM_CANCELLED");
      render();
    } else if (button.matches("[data-select-group]")) {
      page = 1;
      resetResultScroll = true;
      void act("view-update", { groupId: button.dataset.selectGroup });
    } else if (button.matches("[data-sort-direction]")) {
      page = 1;
      resetResultScroll = true;
      void act("view-update", { sortDirection: model.store.view.sortDirection === "asc" ? "desc" : "asc" });
    } else if (button.matches("[data-open-favorite]")) void act("open", { conversationId: button.dataset.openFavorite });
    else if (button.matches("[data-page-direction]")) {
      page += button.dataset.pageDirection === "next" ? 1 : -1;
      resetResultScroll = true;
      render();
    } else if (button.matches("[data-group-menu]")) {
      openMenuGroupId = openMenuGroupId === button.dataset.groupMenu ? null : button.dataset.groupMenu;
      iconPickerGroupId = null;
      openEntryId = null;
      render();
    } else if (button.matches("[data-favorite-menu]")) {
      const id = button.dataset.favoriteMenu;
      if (!model.store.items[id] || model.exportSelection?.active) return;
      openEntryId = openEntryId === id ? null : id;
      openMenuGroupId = null;
      iconPickerGroupId = null;
      render();
      if (openEntryId) transient.queueFocus(() => [...root.querySelectorAll("[data-favorite-entry-overlay] button")].find(control => !control.disabled));
    } else if (button.matches("[data-library-move-group], [data-library-remove]")) {
      const conversationId = openEntryId;
      const item = model.store.items[conversationId];
      if (!item || button.disabled || !button.closest("[data-favorite-entry-overlay]")) return;
      if (button.matches("[data-library-remove]")) {
        transient.dismiss();
        void act("remove", { conversationId });
      } else {
        const groupId = button.dataset.libraryMoveGroup === "ungrouped" ? null : button.dataset.libraryMoveGroup;
        if (item.groupId === groupId || (groupId && !model.store.groups.some(group => group.id === groupId))) return;
        transient.dismiss();
        void act("move", { conversationId, groupId });
      }
    } else if (button.matches("[data-cancel-group-edit]")) {
      nameEditor.close("FORM_CANCELLED");
      render();
    } else if (button.matches("[data-group-icon]")) {
      if (iconPickerGroupId !== button.dataset.groupId) return;
      transient.dismiss();
      void act("group-update", { groupId: button.dataset.groupId, patch: { icon: button.dataset.groupIcon } });
    } else if (button.matches("[data-group-action]")) {
      const groupId = button.dataset.groupId;
      const action = button.dataset.groupAction;
      if (openMenuGroupId !== groupId) return;
      if (action === "rename") {
        openGroupEditor(groupId);
      } else if (action === "icon") {
        iconPickerGroupId = groupId;
        openMenuGroupId = null;
        render();
      } else if (action === "delete") {
        transient.dismiss();
        void deleteGroup(groupId);
      }
    }
  });

  root.addEventListener("dragstart", (event) => {
    const row = event.target.closest("[data-group-row]");
    if (!row || row.classList.contains("is-system") || event.target.closest("input, .favorite-group-menu-toggle")) return;
    draggingGroupId = row.dataset.groupRow;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggingGroupId);
    row.classList.add("is-dragging");
  });
  root.addEventListener("dragover", (event) => {
    const target = event.target.closest("[data-group-row]:not(.is-system)");
    if (draggingGroupId && target) event.preventDefault();
  });
  root.addEventListener("drop", (event) => {
    const target = event.target.closest("[data-group-row]:not(.is-system)")?.dataset.groupRow;
    if (!draggingGroupId || !target || target === draggingGroupId) return;
    event.preventDefault();
    const ids = model.store.groups.map((group) => group.id);
    const sourceIndex = ids.indexOf(draggingGroupId);
    const targetIndex = ids.indexOf(target);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [moved] = ids.splice(sourceIndex, 1);
    ids.splice(targetIndex, 0, moved);
    draggingGroupId = null;
    void act("group-reorder", { orderedGroupIds: ids });
  });
  root.addEventListener("dragend", () => {
    draggingGroupId = null;
    root.querySelectorAll(".is-dragging").forEach((row) => row.classList.remove("is-dragging"));
  });
  window.addEventListener("resize", positionOverlays);

  function selectableIdsForExportSelection() {
    if (!model?.store) return [];
    const selection = model.exportSelection || { basketConversationSources: {} };
    return selectFavorites(model.store)
      .filter((item) => !(selection.basketConversationSources?.[item.conversationId] || []).includes("favorites"))
      .map((item) => item.conversationId);
  }

  // Forget private drafts and cached models at an account/lifecycle boundary.
  // Clearing only the root would allow a later local UI event to revive them.
  function reset() {
    dismissTransientUi();
    nameEditor.close("VIEW_RESET");
    model = null; openMenuGroupId = null;
    iconPickerGroupId = null; draggingGroupId = null;
    page = 1; groupListScrollTop = 0; resetResultScroll = false;
    lastViewSignature = null; renderedResultViewKey = null;
    resultScrollTopByView.clear(); root.replaceChildren();
  }
  function dispose() {
    if (disposed) return;
    reset();
    disposed = true;
    transient.dispose();
    window.removeEventListener("resize", positionOverlays);
    if (ownsConfirmation) confirmation.dispose();
  }
  return Object.freeze({ render, reset, dismissTransientUi, dispose });
}
