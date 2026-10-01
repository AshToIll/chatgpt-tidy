import "../../../platform/snapshot.js";
import { canonicalConversationPath } from "../../../platform/navigation/conversation-route.js";

export const BOOKMARKS_SCHEMA_VERSION = 1;
export const MAX_BOOKMARK_GROUP_NAME_LENGTH = 24;
export const MAX_BOOKMARK_NOTE_LENGTH = 2000;
export const BOOKMARK_SYSTEM_GROUP_IDS = Object.freeze(["current", "all", "ungrouped"]);
export const BOOKMARK_GROUP_ICONS = Object.freeze([
  "quote", "pin", "highlighter", "note", "flag", "chat-bubble", "text-mark", "sparkle",
]);
// 新资料库只创建一次这三个默认书签分组；用户删除后不会自动补回。
// 名称和图标用于初始展示，已保存的分组由用户自行管理。
export const DEFAULT_BOOKMARK_GROUPS = Object.freeze([
  Object.freeze({ id: "bookmark-quote", preset: "bookmark-quote", name: "摘录", icon: "quote" }),
  Object.freeze({ id: "bookmark-insight", preset: "bookmark-insight", name: "灵感", icon: "sparkle" }),
  Object.freeze({ id: "bookmark-todo", preset: "bookmark-todo", name: "待回看", icon: "pin" }),
]);
export const BOOKMARK_SORT_FIELDS = Object.freeze(["bookmarkedAt", "messageTimestamp"]);
export const BOOKMARK_SORT_DIRECTIONS = Object.freeze(["asc", "desc"]);

const DEFAULT_GROUP_PRESETS = new Set(DEFAULT_BOOKMARK_GROUPS.map((group) => group.preset));

function bookmarkError(code, message) {
  return Object.assign(new Error(message), { code, tidyCode: code });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanString(value, maxLength) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function cleanNullableString(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : null;
}

function cleanInstant(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function nowIso(now) {
  const candidate = typeof now === "function" ? now() : now;
  const date = candidate ? new Date(candidate) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export function bookmarkKey(conversationId, messageId) {
  return `${encodeURIComponent(conversationId)}::${encodeURIComponent(messageId)}`;
}

function normalizeGroup(value, index) {
  const id = cleanString(value?.id, 96);
  const name = cleanString(value?.name, MAX_BOOKMARK_GROUP_NAME_LENGTH);
  if (!id || !name || BOOKMARK_SYSTEM_GROUP_IDS.includes(id)) return null;
  return {
    id,
    name,
    icon: BOOKMARK_GROUP_ICONS.includes(value.icon) ? value.icon : "quote",
    preset: value?.preset === id && DEFAULT_GROUP_PRESETS.has(value.preset) ? value.preset : null,
    order: index,
    createdAt: cleanInstant(value.createdAt),
    updatedAt: cleanInstant(value.updatedAt),
  };
}

function normalizeBookmark(value, fallbackId, validGroupIds) {
  const conversationId = cleanString(value?.conversationId, 256);
  const messageId = cleanString(value?.messageId, 256);
  if (!conversationId || conversationId !== value.conversationId || !messageId) return null;
  const routePath = canonicalConversationPath(value?.routePath, conversationId);
  // Never manufacture a navigation address when a stored bookmark is invalid.
  if (!routePath) return null;
  const bookmarkId = bookmarkKey(conversationId, messageId);
  if (fallbackId && fallbackId !== bookmarkId && value?.bookmarkId !== bookmarkId) return null;
  const groupId = validGroupIds.has(value?.groupId) ? value.groupId : null;
  const excerptLimit = globalThis.TidySnapshot?.MAX_MESSAGE_EXCERPT_LENGTH || 320;
  return {
    bookmarkId,
    conversationId,
    messageId,
    role: ["user", "assistant", "system", "tool", "unknown"].includes(value?.role) ? value.role : "unknown",
    messageTimestamp: cleanInstant(value?.messageTimestamp),
    orderIndex: Number.isInteger(value?.orderIndex) && value.orderIndex >= 0 ? value.orderIndex : null,
    orderNumber: Number.isSafeInteger(value?.orderNumber) && value.orderNumber > 0 ? value.orderNumber : null,
    orderNumberSource: value?.orderNumberSource === "chatgpt-api.canonical-active-branch" ? value.orderNumberSource : null,
    excerpt: cleanNullableString(value?.excerpt, excerptLimit) || "",
    locator: { strategy: "data-message-id", value: messageId },
    conversationTitle: cleanNullableString(value?.conversationTitle, 512),
    projectId: cleanNullableString(value?.projectId, 256),
    projectTitle: cleanNullableString(value?.projectTitle, 256),
    routePath,
    bookmarkedAt: cleanInstant(value?.bookmarkedAt) || new Date(0).toISOString(),
    metadataRefreshedAt: cleanInstant(value?.metadataRefreshedAt),
    groupId,
    // 删除编辑入口不删除已存备注；查询和备份仍使用这个字段。
    note: cleanNullableString(value?.note, MAX_BOOKMARK_NOTE_LENGTH) || "",
  };
}

export function createEmptyBookmarksState() {
  return {
    schemaVersion: BOOKMARKS_SCHEMA_VERSION,
    revision: 0,
    updatedAt: null,
    groups: DEFAULT_BOOKMARK_GROUPS.map((group, order) => ({
      ...group,
      order,
      createdAt: null,
      updatedAt: null,
    })),
    items: {},
    view: { groupId: "current", sortField: "bookmarkedAt", sortDirection: "desc", query: "" },
  };
}

export function normalizeBookmarksState(value) {
  const source = value && typeof value === "object" ? value : createEmptyBookmarksState();
  const groups = [];
  const seenGroups = new Set();
  const storedGroups = Array.isArray(source.groups) ? source.groups : [];
  // Normalization preserves current groups; only account initialization seeds.
  for (const candidate of storedGroups) {
    const group = normalizeGroup(candidate, groups.length);
    if (!group || seenGroups.has(group.id)) continue;
    seenGroups.add(group.id);
    groups.push(group);
  }
  const validGroupIds = new Set(groups.map((group) => group.id));
  const items = {};
  for (const [id, candidate] of Object.entries(source.items && typeof source.items === "object" ? source.items : {})) {
    const item = normalizeBookmark(candidate, id, validGroupIds);
    if (item) items[item.bookmarkId] = item;
  }
  const requestedGroupId = source.view?.groupId;
  const groupId = BOOKMARK_SYSTEM_GROUP_IDS.includes(requestedGroupId) || validGroupIds.has(requestedGroupId)
    ? requestedGroupId
    : "current";
  return {
    schemaVersion: BOOKMARKS_SCHEMA_VERSION,
    revision: Number.isInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
    updatedAt: cleanInstant(source.updatedAt),
    groups: groups.map((group, index) => ({ ...group, order: index })),
    items,
    view: {
      groupId,
      sortField: BOOKMARK_SORT_FIELDS.includes(source.view?.sortField) ? source.view.sortField : "bookmarkedAt",
      sortDirection: BOOKMARK_SORT_DIRECTIONS.includes(source.view?.sortDirection) ? source.view.sortDirection : "desc",
      query: cleanNullableString(source.view?.query, 160) || "",
    },
  };
}

function commit(state, mutate, now) {
  const next = clone(normalizeBookmarksState(state));
  mutate(next);
  next.revision += 1;
  next.updatedAt = nowIso(now);
  return normalizeBookmarksState(next);
}

function requireBookmark(state, bookmarkId) {
  const bookmark = state.items[bookmarkId];
  if (!bookmark) throw bookmarkError("NOT_FOUND", `Bookmark not found: ${bookmarkId}`);
  return bookmark;
}

function normalizedTargetGroup(state, groupId) {
  if (!groupId || groupId === "ungrouped") return null;
  if (!state.groups.some((group) => group.id === groupId)) {
    throw bookmarkError("VALIDATION_ERROR", `Bookmark group not found: ${groupId}`);
  }
  return groupId;
}

function recordFromSnapshot(snapshot, message, existing, groupId, timestamp) {
  const conversation = snapshot.conversation;
  const routePath = canonicalConversationPath(snapshot.route?.pathname, conversation.conversationId);
  if (!routePath) throw bookmarkError("VALIDATION_ERROR", "Bookmark route must match its conversation.");
  return {
    bookmarkId: bookmarkKey(conversation.conversationId, message.messageId),
    conversationId: conversation.conversationId,
    messageId: message.messageId,
    role: message.role,
    messageTimestamp: cleanInstant(message.timestamp?.value),
    // Preserve local sorting metadata separately; it must never stand in for
    // a missing conversation-wide number in saved bookmarks or exports.
    orderIndex: message.order?.index,
    orderNumber: message.order?.displayNumber,
    orderNumberSource: message.order?.source,
    excerpt: message.excerpt?.value || "",
    locator: { strategy: "data-message-id", value: message.messageId },
    conversationTitle: conversation.title?.value || existing?.conversationTitle || null,
    projectId: conversation.project?.projectId || null,
    projectTitle: conversation.project?.title || existing?.projectTitle || null,
    routePath,
    bookmarkedAt: existing?.bookmarkedAt || timestamp,
    metadataRefreshedAt: timestamp,
    groupId,
    note: existing?.note || "",
  };
}

export function addBookmarkFromSnapshot(state, snapshot, messageId, options = {}) {
  const snapshotContract = globalThis.TidySnapshot;
  const message = snapshotContract?.persistenceEligibleMessage(snapshot, messageId);
  if (!message) {
    throw bookmarkError("PERSISTENCE_REJECTED", "Only stable messages from a stable, bound conversation can be bookmarked.");
  }
  const current = normalizeBookmarksState(state);
  const id = bookmarkKey(snapshot.conversation.conversationId, message.messageId);
  const existing = current.items[id] || null;
  const hasGroupOverride = Object.hasOwn(options, "groupId");
  const groupId = hasGroupOverride
    ? normalizedTargetGroup(current, options.groupId)
    : existing?.groupId || null;
  const timestamp = nowIso(options.now);
  const record = recordFromSnapshot(snapshot, message, existing, groupId, timestamp);
  if (existing) {
    const comparable = { ...record, metadataRefreshedAt: existing.metadataRefreshedAt };
    if (JSON.stringify(existing) === JSON.stringify(comparable)) return current;
  }
  return commit(current, (next) => { next.items[id] = record; }, timestamp);
}

export function toggleBookmarkFromSnapshot(state, snapshot, messageId, options = {}) {
  const conversationId = snapshot?.conversation?.conversationId;
  const id = conversationId && messageId ? bookmarkKey(conversationId, messageId) : null;
  const current = normalizeBookmarksState(state);
  if (id && current.items[id]) return removeBookmark(current, id, options);
  return addBookmarkFromSnapshot(current, snapshot, messageId, options);
}

export function refreshBookmarksFromSnapshot(state, snapshot, options = {}) {
  const contract = globalThis.TidySnapshot;
  if (!contract?.isPersistenceEligible(snapshot)) return normalizeBookmarksState(state);
  const current = normalizeBookmarksState(state);
  const conversationId = snapshot.conversation.conversationId;
  const targets = Object.values(current.items).filter((item) => item.conversationId === conversationId);
  if (!targets.length) return current;
  // Title-only refreshes for unmounted messages still require an exact route.
  if (!canonicalConversationPath(snapshot.route?.pathname, conversationId)) {
    throw bookmarkError("VALIDATION_ERROR", "Bookmark route must match its conversation.");
  }
  const timestamp = nowIso(options.now);
  let changed = false;
  const records = targets.map((existing) => {
    const message = contract.persistenceEligibleMessage(snapshot, existing.messageId);
    // A title belongs to the bound conversation, not to the mounted message
    // window. Title changes must also reach bookmarks from older turns without
    // replacing their saved excerpts, message times, ordering or user filing.
    const record = message ? recordFromSnapshot(snapshot, message, existing, existing.groupId, timestamp) : {
      ...existing,
      conversationTitle: cleanNullableString(snapshot.conversation.title?.value, 512) || existing.conversationTitle,
      metadataRefreshedAt: timestamp,
    };
    const comparable = { ...record, metadataRefreshedAt: existing.metadataRefreshedAt };
    if (JSON.stringify(existing) === JSON.stringify(comparable)) return existing;
    changed = true;
    return record;
  });
  if (!changed) return current;
  return commit(current, (next) => records.forEach((record) => { next.items[record.bookmarkId] = record; }), timestamp);
}

export function removeBookmark(state, bookmarkId, options = {}) {
  const current = normalizeBookmarksState(state);
  requireBookmark(current, bookmarkId);
  return commit(current, (next) => { delete next.items[bookmarkId]; }, options.now);
}

export function moveBookmark(state, bookmarkId, groupId, options = {}) {
  const current = normalizeBookmarksState(state);
  const bookmark = requireBookmark(current, bookmarkId);
  const target = normalizedTargetGroup(current, groupId);
  if (bookmark.groupId === target) return current;
  return commit(current, (next) => { next.items[bookmarkId].groupId = target; }, options.now);
}

export function resolveBookmarkDestinationGroupId(state, requestedGroupId) {
  const current = normalizeBookmarksState(state);
  return current.groups.some((group) => group.id === requestedGroupId) ? requestedGroupId : null;
}

export function createBookmarkGroup(state, name, options = {}) {
  const current = normalizeBookmarksState(state);
  const cleanName = cleanString(name, MAX_BOOKMARK_GROUP_NAME_LENGTH);
  if (!cleanName) throw bookmarkError("VALIDATION_ERROR", "Bookmark group name is required.");
  const idFactory = options.idFactory || (() => `bookmark-group-${crypto.randomUUID()}`);
  const id = cleanString(idFactory(), 96);
  if (!id || BOOKMARK_SYSTEM_GROUP_IDS.includes(id) || current.groups.some((group) => group.id === id)) {
    throw bookmarkError("VALIDATION_ERROR", "Bookmark group id is invalid or already exists.");
  }
  const timestamp = nowIso(options.now);
  return commit(current, (next) => {
    next.groups.push({ id, name: cleanName, icon: "quote", preset: null, order: next.groups.length, createdAt: timestamp, updatedAt: timestamp });
    next.view.groupId = id;
  }, timestamp);
}

export function updateBookmarkGroup(state, groupId, patch, options = {}) {
  const current = normalizeBookmarksState(state);
  const group = current.groups.find((candidate) => candidate.id === groupId);
  if (!group) throw bookmarkError("NOT_FOUND", `Bookmark group not found: ${groupId}`);
  const name = Object.hasOwn(patch || {}, "name") ? cleanString(patch.name, MAX_BOOKMARK_GROUP_NAME_LENGTH) : group.name;
  const icon = Object.hasOwn(patch || {}, "icon") ? patch.icon : group.icon;
  if (!name) throw bookmarkError("VALIDATION_ERROR", "Bookmark group name is required.");
  if (!BOOKMARK_GROUP_ICONS.includes(icon)) throw bookmarkError("VALIDATION_ERROR", `Unsupported bookmark group icon: ${icon}`);
  if (name === group.name && icon === group.icon) return current;
  return commit(current, (next) => {
    const target = next.groups.find((candidate) => candidate.id === groupId);
    target.name = name;
    target.icon = icon;
    if (Object.hasOwn(patch || {}, "name") && name !== group.name) target.preset = null;
    target.updatedAt = nowIso(options.now);
  }, options.now);
}

export function deleteBookmarkGroup(state, groupId, options = {}) {
  const current = normalizeBookmarksState(state);
  if (!current.groups.some((group) => group.id === groupId)) {
    throw bookmarkError("NOT_FOUND", `Bookmark group not found: ${groupId}`);
  }
  return commit(current, (next) => {
    next.groups = next.groups.filter((group) => group.id !== groupId);
    Object.values(next.items).forEach((item) => { if (item.groupId === groupId) item.groupId = null; });
    if (next.view.groupId === groupId) next.view.groupId = "ungrouped";
  }, options.now);
}

export function reorderBookmarkGroups(state, orderedGroupIds, options = {}) {
  const current = normalizeBookmarksState(state);
  const expected = current.groups.map((group) => group.id);
  const requested = Array.isArray(orderedGroupIds) ? orderedGroupIds.map(String) : [];
  if (requested.length !== expected.length || new Set(requested).size !== expected.length || expected.some((id) => !requested.includes(id))) {
    throw bookmarkError("VALIDATION_ERROR", "Bookmark group order must contain every custom group exactly once.");
  }
  if (requested.every((id, index) => id === expected[index])) return current;
  return commit(current, (next) => {
    const byId = new Map(next.groups.map((group) => [group.id, group]));
    next.groups = requested.map((id, index) => ({ ...byId.get(id), order: index }));
  }, options.now);
}

export function updateBookmarksView(state, patch, options = {}) {
  const current = normalizeBookmarksState(state);
  const groupId = Object.hasOwn(patch || {}, "groupId")
    ? (BOOKMARK_SYSTEM_GROUP_IDS.includes(patch.groupId) || current.groups.some((group) => group.id === patch.groupId) ? patch.groupId : "current")
    : current.view.groupId;
  const sortField = BOOKMARK_SORT_FIELDS.includes(patch?.sortField) ? patch.sortField : current.view.sortField;
  const sortDirection = BOOKMARK_SORT_DIRECTIONS.includes(patch?.sortDirection) ? patch.sortDirection : current.view.sortDirection;
  const query = Object.hasOwn(patch || {}, "query") ? String(patch.query || "").slice(0, 160) : current.view.query;
  if (groupId === current.view.groupId && sortField === current.view.sortField && sortDirection === current.view.sortDirection && query === current.view.query) return current;
  return commit(current, (next) => { next.view = { groupId, sortField, sortDirection, query }; }, options.now);
}

export function bookmarkGroupCounts(state, currentConversationId = null) {
  const current = normalizeBookmarksState(state);
  const counts = { current: 0, all: Object.keys(current.items).length, ungrouped: 0 };
  current.groups.forEach((group) => { counts[group.id] = 0; });
  Object.values(current.items).forEach((item) => {
    if (item.conversationId === currentConversationId) counts.current += 1;
    if (item.groupId && Object.hasOwn(counts, item.groupId)) counts[item.groupId] += 1;
    else counts.ungrouped += 1;
  });
  return counts;
}

export function selectBookmarks(state, { currentConversationId = null, ...view } = {}) {
  const current = normalizeBookmarksState(state);
  const groupId = view.groupId || current.view.groupId;
  const sortField = BOOKMARK_SORT_FIELDS.includes(view.sortField) ? view.sortField : current.view.sortField;
  const sortDirection = BOOKMARK_SORT_DIRECTIONS.includes(view.sortDirection) ? view.sortDirection : current.view.sortDirection;
  const terms = String(Object.hasOwn(view, "query") ? view.query : current.view.query)
    .trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const items = Object.values(current.items).filter((item) => {
    if (groupId === "current" && item.conversationId !== currentConversationId) return false;
    if (groupId === "ungrouped" && item.groupId !== null) return false;
    if (!BOOKMARK_SYSTEM_GROUP_IDS.includes(groupId) && item.groupId !== groupId) return false;
    if (!terms.length) return true;
    const searchable = `${item.excerpt} ${item.conversationTitle || ""} ${item.note}`.toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
  const timestamp = (item) => Date.parse(item[sortField] || "") || 0;
  return items.sort((left, right) => {
    const difference = timestamp(left) - timestamp(right);
    if (difference) return sortDirection === "asc" ? difference : -difference;
    return left.bookmarkId.localeCompare(right.bookmarkId);
  });
}
