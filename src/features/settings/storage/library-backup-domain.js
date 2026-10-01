import { normalizeFavoritesState, createEmptyFavoritesState } from "../../favorites/storage/favorites-domain.js";
import { normalizeBookmarksState, createEmptyBookmarksState } from "../../bookmarks/storage/bookmarks-domain.js";
import { assertAccountKey } from "../../../platform/storage/database.js";
import { LIBRARY_BACKUP_FORMAT, LIBRARY_BACKUP_VERSION, LIBRARY_BACKUP_LIMITS, backupError } from "../model/library-backup-format.js";

export const LIBRARY_KINDS = Object.freeze(["favorites", "bookmarks"]);
const domains = {
  favorites: { normalize: normalizeFavoritesState, empty: createEmptyFavoritesState, key: "conversationId" },
  bookmarks: { normalize: normalizeBookmarksState, empty: createEmptyBookmarksState, key: "bookmarkId" },
};
const invalid = () => { throw backupError("BACKUP_INVALID"); };
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const same = (a, b) => {
  if (a === b) return true;
  if (!plain(a) || !plain(b)) return false;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
};

// 正常存储读取可以整理字段；导入则必须逐项无损匹配，不能截断备注或默默丢弃坏记录。
export function validateBackupLibrary(kind, value) {
  if (!exactKeys(value, ["groups", "items"]) || !Array.isArray(value.groups) || !Array.isArray(value.items)) invalid();
  if (value.groups.length > LIBRARY_BACKUP_LIMITS.groups) throw backupError("BACKUP_TOO_LARGE");
  const { normalize, empty, key } = domains[kind];
  const groups = new Set(), ids = new Set();
  for (const group of value.groups) {
    if (!plain(group) || typeof group.id !== "string" || groups.has(group.id)) invalid();
    groups.add(group.id);
  }
  const items = Object.create(null);
  for (const item of value.items) {
    if (!plain(item) || typeof item[key] !== "string" || ids.has(item[key])
      || ["__proto__", "constructor", "prototype"].includes(item[key])) invalid();
    ids.add(item[key]); items[item[key]] = item;
  }
  const normalized = normalize({ ...empty(), groups: value.groups, items });
  if (normalized.groups.length !== value.groups.length || Object.keys(normalized.items).length !== value.items.length
    || value.groups.some((group, index) => !same(group, normalized.groups[index]))
    || value.items.some(item => !same(item, normalized.items[item[key]]))) invalid();
}

export function parseLibraryBackup(text, accountKey) {
  assertAccountKey(accountKey);
  if (typeof text !== "string") invalid();
  if (text.length > LIBRARY_BACKUP_LIMITS.bytes || new TextEncoder().encode(text).byteLength > LIBRARY_BACKUP_LIMITS.bytes) {
    throw backupError("BACKUP_TOO_LARGE");
  }
  let value;
  try {
    value = JSON.parse(text, (key, entry) => {
      if (["__proto__", "constructor", "prototype"].includes(key)) invalid();
      return entry;
    });
  } catch { invalid(); }
  if (!plain(value) || value.format !== LIBRARY_BACKUP_FORMAT) invalid();
  if (value.version !== LIBRARY_BACKUP_VERSION) throw backupError("BACKUP_VERSION");
  if (!exactKeys(value, ["format", "version", "exportedAt", "accountKey", ...LIBRARY_KINDS])) invalid();
  if (typeof value.exportedAt !== "string" || !Number.isFinite(Date.parse(value.exportedAt))
    || new Date(value.exportedAt).toISOString() !== value.exportedAt) invalid();
  try { assertAccountKey(value.accountKey); } catch { invalid(); }
  if (value.accountKey !== accountKey) throw backupError("BACKUP_ACCOUNT_MISMATCH");
  if (LIBRARY_KINDS.some(kind => !Array.isArray(value[kind]?.items))) invalid();
  if (LIBRARY_KINDS.reduce((sum, kind) => sum + value[kind].items.length, 0) > LIBRARY_BACKUP_LIMITS.items) {
    throw backupError("BACKUP_TOO_LARGE");
  }
  for (const kind of LIBRARY_KINDS) validateBackupLibrary(kind, value[kind]);
  return value;
}

export function serializeLibraryBackup(accountKey, libraries, now = new Date().toISOString()) {
  const value = { format: LIBRARY_BACKUP_FORMAT, version: LIBRARY_BACKUP_VERSION, exportedAt: now, accountKey };
  for (const kind of LIBRARY_KINDS) {
    value[kind] = { groups: libraries[kind].groups, items: Object.values(libraries[kind].items) };
  }
  const text = JSON.stringify(value, null, 2);
  // 同一个格式出口也走校验；不生成本插件无法完整读回的备份。
  parseLibraryBackup(text, accountKey);
  return text;
}

const groupContent = group => JSON.stringify([group.name, group.icon, group.preset]);
export async function prepareBackupGroupIds(backup) {
  // 事务外用浏览器自带 SHA-256 生成稳定编号，避免自写短哈希合并不同来源的同名分组。
  // 这只是本地编号，不是备份签名；事务内仍逐字段核对目标编号是否被其他分组占用。
  const result = {};
  for (const kind of LIBRARY_KINDS) {
    const pairs = await Promise.all(backup[kind].groups.map(async group => {
      const bytes = new TextEncoder().encode(JSON.stringify([kind, group.id, groupContent(group)]));
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      return [group.id, `restored-${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`];
    }));
    result[kind] = new Map(pairs);
  }
  return result;
}

export function mergeLibraryBackup(current, backup, now, preparedIds) {
  const result = {}, summary = {};
  for (const kind of LIBRARY_KINDS) {
    const state = current[kind], incoming = backup[kind];
    const groups = state.groups.map(group => ({ ...group }));
    const byId = new Map(groups.map(group => [group.id, group]));
    const groupIds = new Map();
    let addedGroups = 0;
    for (const group of incoming.groups) {
      let id = group.id;
      if (byId.has(id) && groupContent(byId.get(id)) !== groupContent(group)) {
        const base = preparedIds[kind].get(group.id);
        id = base;
        for (let suffix = 2; byId.has(id) && groupContent(byId.get(id)) !== groupContent({ ...group, preset: null }); suffix++) id = `${base}-${suffix}`;
      }
      if (!byId.has(id)) {
        const added = { ...group, id, preset: id === group.id ? group.preset : null, order: groups.length };
        groups.push(added); byId.set(id, added); addedGroups++;
      }
      groupIds.set(group.id, id);
    }
    const items = { ...state.items };
    let added = 0, skipped = 0;
    for (const item of incoming.items) {
      const id = item[domains[kind].key];
      if (Object.hasOwn(items, id)) { skipped++; continue; }
      items[id] = { ...item, groupId: item.groupId === null ? null : groupIds.get(item.groupId) };
      added++;
    }
    const changed = added > 0 || addedGroups > 0;
    result[kind] = changed ? { ...state, groups, items, revision: state.revision + 1, updatedAt: now } : state;
    summary[kind] = { added, skipped, addedGroups };
  }
  return { libraries: result, summary };
}
