import "../../../platform/snapshot.js";
import { canonicalConversationPath } from "../../../platform/navigation/conversation-route.js";

export const FAVORITES_SCHEMA_VERSION = 1;
export const MAX_GROUP_NAME_LENGTH = 24;
export const MAX_NOTE_LENGTH = 2000;
export const SYSTEM_GROUP_IDS = Object.freeze(["all", "ungrouped"]);
export const GROUP_ICONS = Object.freeze([
  "folder", "archive", "book", "briefcase", "bulb", "sparkle", "heart", "box",
]);
export const DEFAULT_FAVORITE_GROUPS = Object.freeze([
  Object.freeze({ id: "keepsake", preset: "keepsake", name: "留念", icon: "heart" }),
  Object.freeze({ id: "inspiration", preset: "inspiration", name: "灵感", icon: "sparkle" }),
  Object.freeze({ id: "study", preset: "study", name: "学习", icon: "book" }),
  Object.freeze({ id: "work", preset: "work", name: "工作", icon: "briefcase" }),
]);
export const FAVORITE_SORT_FIELDS = Object.freeze(["savedAt", "createdAt", "updatedAt"]);
export const SORT_DIRECTIONS = Object.freeze(["asc", "desc"]);

const DEFAULT_GROUP_PRESETS = new Set(DEFAULT_FAVORITE_GROUPS.map((group) => group.preset));

function favoriteError(code, message) {
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
  if (typeof value !== "string") return null;
  return value.slice(0, maxLength);
}

function cleanInstant(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function nowIso(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function normalizeGroup(value, index) {
  const id = cleanString(value?.id, 96);
  const name = cleanString(value?.name, MAX_GROUP_NAME_LENGTH);
  if (!id || !name || SYSTEM_GROUP_IDS.includes(id)) return null;
  return {
    id,
    name,
    icon: GROUP_ICONS.includes(value.icon) ? value.icon : "folder",
    preset: value?.preset === id && DEFAULT_GROUP_PRESETS.has(value.preset) ? value.preset : null,
    order: index,
    createdAt: cleanInstant(value.createdAt),
    updatedAt: cleanInstant(value.updatedAt),
  };
}

function normalizeFavorite(value, validGroupIds) {
  const conversationId = cleanString(value?.conversationId, 256);
  if (!conversationId || conversationId !== value.conversationId) return null;
  const routePath = canonicalConversationPath(value?.routePath, conversationId);
  // A stored record without a current, exact route is not a usable favorite.
  if (!routePath) return null;
  const groupId = validGroupIds.has(value?.groupId) ? value.groupId : null;
  return {
    conversationId,
    title: cleanNullableString(value?.title, 512),
    projectId: cleanNullableString(value?.projectId, 256),
    projectTitle: cleanNullableString(value?.projectTitle, 256),
    routePath,
    createdAt: cleanInstant(value?.createdAt),
    updatedAt: cleanInstant(value?.updatedAt),
    savedAt: cleanInstant(value?.savedAt) || new Date(0).toISOString(),
    metadataRefreshedAt: cleanInstant(value?.metadataRefreshedAt),
    groupId,
    // 备注无编辑入口，但已存资料和备份中的备注仍需原样保留。
    note: cleanNullableString(value?.note, MAX_NOTE_LENGTH) || "",
  };
}

export function createEmptyFavoritesState() {
  return {
    schemaVersion: FAVORITES_SCHEMA_VERSION,
    revision: 0,
    updatedAt: null,
    groups: DEFAULT_FAVORITE_GROUPS.map((group, order) => ({
      ...group,
      order,
      createdAt: null,
      updatedAt: null,
    })),
    items: {},
    view: { groupId: "all", sortField: "savedAt", sortDirection: "desc" },
  };
}

export function normalizeFavoritesState(value) {
  const source = value && typeof value === "object" ? value : createEmptyFavoritesState();
  const seenGroups = new Set();
  const groups = [];
  // Normalization preserves current groups; only account initialization seeds.
  const storedGroups = Array.isArray(source.groups) ? source.groups : [];
  for (const candidate of storedGroups) {
    const group = normalizeGroup(candidate, groups.length);
    if (!group || seenGroups.has(group.id)) continue;
    seenGroups.add(group.id);
    groups.push(group);
  }
  const validGroupIds = new Set(groups.map((group) => group.id));
  const items = {};
  for (const candidate of Object.values(source.items && typeof source.items === "object" ? source.items : {})) {
    const item = normalizeFavorite(candidate, validGroupIds);
    if (item) items[item.conversationId] = item;
  }
  const requestedGroupId = source.view?.groupId;
  const groupId = SYSTEM_GROUP_IDS.includes(requestedGroupId) || validGroupIds.has(requestedGroupId)
    ? requestedGroupId
    : "all";
  return {
    schemaVersion: FAVORITES_SCHEMA_VERSION,
    revision: Number.isInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
    updatedAt: cleanInstant(source.updatedAt),
    groups: groups.map((group, index) => ({ ...group, order: index })),
    items,
    view: {
      groupId,
      sortField: FAVORITE_SORT_FIELDS.includes(source.view?.sortField) ? source.view.sortField : "savedAt",
      sortDirection: SORT_DIRECTIONS.includes(source.view?.sortDirection) ? source.view.sortDirection : "desc",
    },
  };
}

function commit(state, mutate, now) {
  const next = clone(normalizeFavoritesState(state));
  mutate(next);
  next.revision += 1;
  next.updatedAt = nowIso(now);
  return normalizeFavoritesState(next);
}

function requireFavorite(state, conversationId) {
  const item = state.items[conversationId];
  if (!item) throw favoriteError("NOT_FOUND", `Favorite not found: ${conversationId}`);
  return item;
}

function normalizedTargetGroup(state, groupId) {
  if (!groupId || groupId === "ungrouped") return null;
  if (!state.groups.some((group) => group.id === groupId)) {
    throw favoriteError("VALIDATION_ERROR", `Favorite group not found: ${groupId}`);
  }
  return groupId;
}

/**
 * Accept an explicit, currently visible filing destination when it still
 * exists. Missing/system/stale destinations deliberately become Ungrouped.
 */
export function resolveFavoriteDestinationGroupId(state, requestedGroupId) {
  const current = normalizeFavoritesState(state);
  return current.groups.some((group) => group.id === requestedGroupId)
    ? requestedGroupId
    : null;
}

function snapshotRecord(snapshot, existing, groupId, timestamp) {
  const conversation = snapshot.conversation;
  const conversationId = conversation.conversationId;
  const routePath = canonicalConversationPath(snapshot.route?.pathname, conversationId);
  if (!routePath) throw favoriteError("VALIDATION_ERROR", "Favorite route must match its conversation.");
  return {
    conversationId,
    title: conversation.title?.value || existing?.title || null,
    projectId: conversation.project?.projectId || null,
    projectTitle: conversation.project?.title || null,
    routePath,
    createdAt: cleanInstant(conversation.createdAt?.value) || existing?.createdAt || null,
    updatedAt: cleanInstant(conversation.updatedAt?.value) || existing?.updatedAt || null,
    savedAt: existing?.savedAt || timestamp,
    metadataRefreshedAt: timestamp,
    groupId,
    note: existing?.note || "",
  };
}

function sidebarRecord(conversation, existing, groupId, timestamp) {
  const routePath = canonicalConversationPath(conversation.locator?.value, conversation.conversationId);
  if (!routePath) throw favoriteError("VALIDATION_ERROR", "Favorite route must match its conversation.");
  return {
    conversationId: conversation.conversationId,
    title: conversation.title?.value || existing?.title || null,
    projectId: conversation.project?.projectId || null,
    projectTitle: conversation.project?.title || null,
    routePath,
    createdAt: cleanInstant(conversation.createdAt?.value) || existing?.createdAt || null,
    updatedAt: cleanInstant(conversation.updatedAt?.value) || existing?.updatedAt || null,
    savedAt: existing?.savedAt || timestamp,
    metadataRefreshedAt: timestamp,
    groupId,
    note: existing?.note || "",
  };
}

export function upsertFavoriteFromSnapshot(state, snapshot, options = {}) {
  const snapshotContract = globalThis.TidySnapshot;
  if (!snapshotContract?.isPersistenceEligible(snapshot)) {
    throw favoriteError("PERSISTENCE_REJECTED", "Only stable, bound conversations can be favorited.");
  }
  const current = normalizeFavoritesState(state);
  const conversationId = snapshot.conversation.conversationId;
  const existing = current.items[conversationId] || null;
  const hasGroupOverride = Object.hasOwn(options, "groupId");
  const groupId = hasGroupOverride
    ? normalizedTargetGroup(current, options.groupId)
    : existing?.groupId || null;
  const timestamp = nowIso(options.now);
  const record = snapshotRecord(snapshot, existing, groupId, timestamp);

  if (existing) {
    const comparable = { ...record, metadataRefreshedAt: existing.metadataRefreshedAt };
    if (JSON.stringify(existing) === JSON.stringify(comparable)) return current;
  }
  return commit(current, (next) => {
    next.items[conversationId] = record;
  }, timestamp);
}

export function upsertFavoriteFromSidebarConversation(state, conversation, options = {}) {
  const snapshotContract = globalThis.TidySnapshot;
  if (!snapshotContract?.isSidebarPersistenceEligible(conversation)) {
    throw favoriteError("PERSISTENCE_REJECTED", "Only stable, bound sidebar conversations can be favorited.");
  }
  const current = normalizeFavoritesState(state);
  const conversationId = conversation.conversationId;
  const existing = current.items[conversationId] || null;
  const hasGroupOverride = Object.hasOwn(options, "groupId");
  const groupId = hasGroupOverride
    ? normalizedTargetGroup(current, options.groupId)
    : existing?.groupId || null;
  const timestamp = nowIso(options.now);
  const record = sidebarRecord(conversation, existing, groupId, timestamp);
  if (existing) {
    const comparable = { ...record, metadataRefreshedAt: existing.metadataRefreshedAt };
    if (JSON.stringify(existing) === JSON.stringify(comparable)) return current;
  }
  return commit(current, (next) => {
    next.items[conversationId] = record;
  }, timestamp);
}

export function refreshFavoriteFromSnapshot(state, snapshot, options = {}) {
  const current = normalizeFavoritesState(state);
  const conversationId = snapshot?.conversation?.conversationId;
  if (!conversationId || !current.items[conversationId]) return current;
  try {
    return upsertFavoriteFromSnapshot(current, snapshot, options);
  } catch (error) {
    if (error.code === "PERSISTENCE_REJECTED") return current;
    throw error;
  }
}

export function removeFavorite(state, conversationId, options = {}) {
  const current = normalizeFavoritesState(state);
  requireFavorite(current, conversationId);
  return commit(current, (next) => {
    delete next.items[conversationId];
  }, options.now);
}

export function moveFavorite(state, conversationId, groupId, options = {}) {
  const current = normalizeFavoritesState(state);
  requireFavorite(current, conversationId);
  const target = normalizedTargetGroup(current, groupId);
  if (current.items[conversationId].groupId === target) return current;
  return commit(current, (next) => {
    next.items[conversationId].groupId = target;
  }, options.now);
}

export function createFavoriteGroup(state, name, options = {}) {
  const current = normalizeFavoritesState(state);
  const cleanName = cleanString(name, MAX_GROUP_NAME_LENGTH);
  if (!cleanName) throw favoriteError("VALIDATION_ERROR", "Favorite group name is required.");
  const idFactory = options.idFactory || (() => `group-${crypto.randomUUID()}`);
  const id = cleanString(idFactory(), 96);
  if (!id || SYSTEM_GROUP_IDS.includes(id) || current.groups.some((group) => group.id === id)) {
    throw favoriteError("VALIDATION_ERROR", "Favorite group id is invalid or already exists.");
  }
  const timestamp = nowIso(options.now);
  return commit(current, (next) => {
    next.groups.push({ id, name: cleanName, icon: "folder", preset: null, order: next.groups.length, createdAt: timestamp, updatedAt: timestamp });
    next.view.groupId = id;
  }, timestamp);
}

export function updateFavoriteGroup(state, groupId, patch, options = {}) {
  const current = normalizeFavoritesState(state);
  const group = current.groups.find((candidate) => candidate.id === groupId);
  if (!group) throw favoriteError("NOT_FOUND", `Favorite group not found: ${groupId}`);
  const name = Object.hasOwn(patch || {}, "name") ? cleanString(patch.name, MAX_GROUP_NAME_LENGTH) : group.name;
  const icon = Object.hasOwn(patch || {}, "icon") ? patch.icon : group.icon;
  if (!name) throw favoriteError("VALIDATION_ERROR", "Favorite group name is required.");
  if (!GROUP_ICONS.includes(icon)) throw favoriteError("VALIDATION_ERROR", `Unsupported favorite group icon: ${icon}`);
  if (name === group.name && icon === group.icon) return current;
  return commit(current, (next) => {
    const target = next.groups.find((candidate) => candidate.id === groupId);
    target.name = name;
    target.icon = icon;
    if (Object.hasOwn(patch || {}, "name") && name !== group.name) target.preset = null;
    target.updatedAt = nowIso(options.now);
  }, options.now);
}

export function deleteFavoriteGroup(state, groupId, options = {}) {
  const current = normalizeFavoritesState(state);
  if (!current.groups.some((group) => group.id === groupId)) {
    throw favoriteError("NOT_FOUND", `Favorite group not found: ${groupId}`);
  }
  return commit(current, (next) => {
    next.groups = next.groups.filter((group) => group.id !== groupId);
    Object.values(next.items).forEach((item) => {
      if (item.groupId === groupId) item.groupId = null;
    });
    if (next.view.groupId === groupId) next.view.groupId = "ungrouped";
  }, options.now);
}

export function reorderFavoriteGroups(state, orderedGroupIds, options = {}) {
  const current = normalizeFavoritesState(state);
  const expected = current.groups.map((group) => group.id);
  const requested = Array.isArray(orderedGroupIds) ? orderedGroupIds.map(String) : [];
  if (requested.length !== expected.length || new Set(requested).size !== expected.length || expected.some((id) => !requested.includes(id))) {
    throw favoriteError("VALIDATION_ERROR", "Favorite group order must contain every custom group exactly once.");
  }
  if (requested.every((id, index) => id === expected[index])) return current;
  return commit(current, (next) => {
    const byId = new Map(next.groups.map((group) => [group.id, group]));
    next.groups = requested.map((id, index) => ({ ...byId.get(id), order: index }));
  }, options.now);
}

export function updateFavoritesView(state, patch, options = {}) {
  const current = normalizeFavoritesState(state);
  const groupId = Object.hasOwn(patch || {}, "groupId")
    ? (SYSTEM_GROUP_IDS.includes(patch.groupId) || current.groups.some((group) => group.id === patch.groupId) ? patch.groupId : "all")
    : current.view.groupId;
  const sortField = FAVORITE_SORT_FIELDS.includes(patch?.sortField) ? patch.sortField : current.view.sortField;
  const sortDirection = SORT_DIRECTIONS.includes(patch?.sortDirection) ? patch.sortDirection : current.view.sortDirection;
  if (groupId === current.view.groupId && sortField === current.view.sortField && sortDirection === current.view.sortDirection) return current;
  return commit(current, (next) => {
    next.view = { groupId, sortField, sortDirection };
  }, options.now);
}

export function favoriteGroupCounts(state) {
  const current = normalizeFavoritesState(state);
  const counts = { all: Object.keys(current.items).length, ungrouped: 0 };
  current.groups.forEach((group) => { counts[group.id] = 0; });
  Object.values(current.items).forEach((item) => {
    if (item.groupId && Object.hasOwn(counts, item.groupId)) counts[item.groupId] += 1;
    else counts.ungrouped += 1;
  });
  return counts;
}

export function selectFavorites(state, view = {}) {
  const current = normalizeFavoritesState(state);
  const groupId = view.groupId || current.view.groupId;
  const sortField = FAVORITE_SORT_FIELDS.includes(view.sortField) ? view.sortField : current.view.sortField;
  const sortDirection = SORT_DIRECTIONS.includes(view.sortDirection) ? view.sortDirection : current.view.sortDirection;
  const items = Object.values(current.items).filter((item) => {
    if (groupId === "all") return true;
    if (groupId === "ungrouped") return item.groupId === null;
    return item.groupId === groupId;
  });
  const value = (item) => Date.parse(item[sortField] || "") || 0;
  return items.sort((left, right) => {
    const difference = value(left) - value(right);
    if (difference) return sortDirection === "asc" ? difference : -difference;
    return left.conversationId.localeCompare(right.conversationId);
  });
}
