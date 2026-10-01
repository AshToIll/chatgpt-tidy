import { createAccountLibraryAccess, runLibraryTransaction } from "../../../platform/library/storage/account-library.js";
import { normalizeFavoritesState, createEmptyFavoritesState } from "../../favorites/storage/favorites-domain.js";
import { normalizeBookmarksState, createEmptyBookmarksState } from "../../bookmarks/storage/bookmarks-domain.js";
import { assertAccountKey, openTidyDatabase, storageError } from "../../../platform/storage/database.js";
import { validateBackupLibrary } from "./library-backup-domain.js";

// 收藏、书签共用一个数据库：备份取得同一时刻的快照，恢复要么全部成功，要么全部回滚。
export function createLibraryBackupRepository(options = {}) {
  const access = {
    favorites: createAccountLibraryAccess({ kind: "favorites", normalizeState: normalizeFavoritesState, createEmptyState: createEmptyFavoritesState }),
    bookmarks: createAccountLibraryAccess({ kind: "bookmarks", normalizeState: normalizeBookmarksState, createEmptyState: createEmptyBookmarksState }),
  };
  const kinds = Object.keys(access), stores = [...new Set(kinds.flatMap(kind => access[kind].stores))];
  const open = options.openDatabase || (() => openTidyDatabase(options.indexedDbFactory));
  let database;
  async function run(accountKey, mode, assertCurrent, mutate) {
    assertAccountKey(accountKey); assertCurrent();
    database ||= open().catch(error => { database = null; throw error; });
    return runLibraryTransaction(await database, stores, mode, async transaction => {
      const rows = await Promise.all(kinds.map(kind => access[kind].read(transaction, accountKey)));
      // 备份不能沿用普通展示的容错丢弃：已有坏记录时停止，不能生成悄悄缺项的“完整备份”。
      for (const [index, kind] of kinds.entries()) {
        if (!rows[index].empty) {
          try { validateBackupLibrary(kind, { groups: rows[index].state.groups, items: Object.values(rows[index].state.items) }); }
          catch { throw storageError("Stored library records cannot be backed up losslessly."); }
        }
      }
      const current = Object.fromEntries(kinds.map((kind, index) => [kind, { ...access[kind].value(rows[index]), accountKey }]));
      // 事务可能排队；真正写入前重新核对账号和用户确认时看到的数据。
      assertCurrent();
      if (!mutate) return current;
      const next = mutate(current);
      if (!next || typeof next.then === "function") throw new Error("Backup mutations must be synchronous");
      for (const [index, kind] of kinds.entries()) {
        if (next[kind].accountKey !== accountKey) throw new Error("Backup cannot change owner");
        if (next[kind] !== current[kind]) access[kind].write(transaction, accountKey, rows[index], next[kind]);
      }
      return next;
    });
  }
  return Object.freeze({
    read: (accountKey, assertCurrent) => run(accountKey, "readonly", assertCurrent),
    restore: (accountKey, assertCurrent, mutate) => run(accountKey, "readwrite", assertCurrent, mutate),
  });
}
