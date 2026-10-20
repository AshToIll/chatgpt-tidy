import { STORAGE_BOUNDARIES } from "./schema.js";
import { openTidyDatabase, assertAccountKey, storageError } from "./database.js";

const STORES = STORAGE_BOUNDARIES.indexedDb.stores;
const keyFor = (accountKey, id) => `conversation-availability:${JSON.stringify([accountKey, id])}`;
const read = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(storageError("Conversation availability could not be read."));
});

export const isConversationUnavailable = row => ["deleted", "unavailable"].includes(row?.availability?.status);

// 状态不写进收藏/书签内容，也不混入用户备份。它是当前账号的服务端观察结果。
export async function projectConversationAvailability(transaction, accountKey, state) {
  const ids = [...new Set(Object.values(state.items).map(item => item.conversationId))];
  const rows = await Promise.all(ids.map(id => read(transaction.objectStore(STORES.moduleState).get(keyFor(accountKey, id)))));
  const availability = Object.fromEntries(rows.filter(row => row && row.status !== "available")
    .map(row => [row.conversationId, row.status]));
  return Object.keys(availability).length ? { ...state, conversationAvailability: availability } : state;
}

/** 一次短事务更新一条会话及相关库版本；不遍历会话目录、不改用户资料、不碰写入回执。 */
export function createConversationAvailabilityRepository(options = {}) {
  let databasePromise;
  const database = () => databasePromise ||= (options.openDatabase?.() || openTidyDatabase(options.indexedDbFactory))
    .catch(error => { databasePromise = null; throw error; });

  async function accept(change, isCurrent = () => true) {
    const { ownerAccountKey, catalogAccountKey, conversationId, status, startedAt } = change;
    assertAccountKey(ownerAccountKey); assertAccountKey(catalogAccountKey);
    if (!/^[A-Za-z0-9_-]+$/.test(conversationId || "") || !["deleted", "unavailable", "available"].includes(status)
      || !Number.isFinite(startedAt) || startedAt < 0) return null;
    const db = await database();
    const tx = db.transaction([STORES.moduleState, STORES.conversationIndex, STORES.favorites, STORES.bookmarks], "readwrite");
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(storageError("Conversation availability transaction failed."));
    });
    try {
      const states = tx.objectStore(STORES.moduleState), catalog = tx.objectStore(STORES.conversationIndex);
      const key = keyFor(ownerAccountKey, conversationId);
      const previous = await read(states.get(key));
      // 删除不可逆；普通详情成功只恢复“不可用”。旧 GET、重复通知都不能覆盖新状态。
      if (!isCurrent() || previous?.status === "deleted" || (status !== "deleted" && previous?.startedAt >= startedAt)
        || (!previous && status === "available")) { await done; return null; }
      const row = await read(catalog.get([catalogAccountKey, conversationId]));
      if (row?.availability?.status === "deleted" && status !== "deleted") { await done; return null; }
      // 重复 404 只推进排序水位，不反复刷新所有可见库。
      if (previous?.status === status) {
        if (isCurrent()) {
          states.put({ ...previous, startedAt });
          if (row) catalog.put({ ...row, availability: { status, startedAt } });
        }
        await done; return null;
      }
      const libraries = {};
      const checkpointKey = `conversation-catalog:${catalogAccountKey}`;
      const checkpoint = await read(states.get(checkpointKey));
      const favorite = await read(tx.objectStore(STORES.favorites).get([ownerAccountKey, conversationId]));
      const bookmarks = await read(tx.objectStore(STORES.bookmarks).index("message").getAll(
        IDBKeyRange.bound([ownerAccountKey, conversationId], [ownerAccountKey, conversationId, []])));
      for (const kind of ["favorites", "bookmarks"]) {
        if (!(kind === "favorites" ? favorite : bookmarks.length)) continue;
        const libraryKey = `library:${kind}:${ownerAccountKey}`;
        const metadata = await read(states.get(libraryKey));
        libraries[kind] = { ...metadata, key: libraryKey, accountKey: ownerAccountKey,
          schemaVersion: 2, revision: (metadata?.revision || 0) + 1 };
      }
      if (!isCurrent()) { await done; return null; }
      states.put({ key, accountKey: ownerAccountKey, conversationId, status, startedAt });
      // 保留最小墓碑，哪怕删除时目录尚未枚举到它，迟到页面也不能复活该会话。
      catalog.put({ ...row, accountKey: catalogAccountKey, conversationId,
        availability: { status, startedAt } });
      // 内容分页有自己的失效版本；不能推进扫描 revision，否则每次删除都会中断在途扫描。
      if (checkpoint) states.put({ ...checkpoint, availabilityRevision: (checkpoint.availabilityRevision || 0) + 1 });
      for (const metadata of Object.values(libraries)) states.put(metadata);
      await done;
      return { accountKey: catalogAccountKey, conversationId,
        libraries: Object.fromEntries(Object.entries(libraries).map(([kind, metadata]) => [kind, {
          accountKey: ownerAccountKey, revision: metadata.revision,
        }])) };
    } catch (error) {
      try { tx.abort(); } catch { /* 已完成的事务无须回滚。 */ }
      await done.catch(() => {}); throw error;
    }
  }
  return Object.freeze({ accept });
}
