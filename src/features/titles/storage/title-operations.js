import { STORAGE_BOUNDARIES } from "../../../platform/storage/schema.js";
import { openTidyDatabase, storageError } from "../../../platform/storage/database.js";

const STORE = STORAGE_BOUNDARIES.indexedDb.stores.moduleState;
const KEY_PREFIX = "title-operations.v1:";
const BATCH_JOB_PREFIX = `${KEY_PREFIX}title-batch.job:`;
const BATCH_POINTER_PREFIX = `${KEY_PREFIX}title-batch.latest:`;

function hasWriteEvidence(value) {
  return ["runtimeId", "startedAt", "startedAtMs", "operationId", "recoveryOperationId", "nextStepId"]
    .some((field) => value?.[field] != null)
    || (value?.operation != null && typeof value.operation !== "string")
    || (value?.usedStepIds != null && (!Array.isArray(value.usedStepIds) || value.usedStepIds.length > 0));
}

// 只回收能证明无恢复价值的记录；过期本身不能证明一次写入没有发生。
// 结果回执、暂停/执行中、未知版本及矛盾状态都保留，不按年龄擅自丢弃。
function disposableBatch(job, now) {
  if (job?.version !== 1 || typeof job.id !== "string" || !job.id) return false;
  if (typeof job.superseded === "string" && job.superseded && job.superseded !== job.id
    && Object.keys(job).every((key) => ["version", "id", "superseded"].includes(key))) return true;
  return job.phase === "preview" && Number.isFinite(job.createdAt) && Number.isFinite(job.expiresAt)
    && job.createdAt <= job.expiresAt && now > job.expiresAt && !hasWriteEvidence(job)
    && Array.isArray(job.items) && job.items.length > 0 && job.items.every((item) =>
      ["ready", "skipped"].includes(item?.status) && item.settled === false && !hasWriteEvidence(item));
}

async function pruneUnusedBatches(db, now) {
  const transaction = db.transaction(STORE, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(STORE);
  const removed = new Set();
  // 范围游标只访问批次命名空间，不扫描单条标题回执、目录或其他资料。
  function scan(prefix, visit, complete = () => {}) {
    const request = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    request.onsuccess = () => {
      try {
        const cursor = request.result;
        if (!cursor) { complete(); return; }
        visit(cursor);
        cursor.continue();
      } catch { transaction.abort(); }
    };
  }
  try {
    scan(BATCH_JOB_PREFIX, (cursor) => {
      const job = cursor.value?.value;
      if (disposableBatch(job, now) && cursor.key === `${BATCH_JOB_PREFIX}${job.id}`) {
        cursor.delete(); removed.add(job.id);
      }
    }, () => {
      if (!removed.size) return;
      // 同一事务删除仍指向旧 ID 的指针；已指向新计划的指针绝不动。
      scan(BATCH_POINTER_PREFIX, (cursor) => {
        if (removed.has(cursor.value?.value?.batchId)) cursor.delete();
      });
    });
  } catch {
    transaction.abort();
  }
  await done;
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(storageError("Unable to save title operation."));
    transaction.onerror = () => reject(storageError("Unable to save title operation."));
  });
}

// Titles are conversation payloads, not preferences: keep the current preview
// and write-recovery receipt in IndexedDB, never in chrome.storage or a log.
export function createTitleOperationsRepository(options = {}) {
  const openDatabase = options.openDatabase || (() => openTidyDatabase(options.indexedDbFactory));
  let databasePromise;
  function database() {
    databasePromise ||= openDatabase().then(async (db) => {
      // 每个仓库实例首次使用时清理一次，不给每次选项切换增加全库扫描。
      // 清理失败整体回滚，但不阻断当前回执的只读核对；下次 Worker 启动再试。
      await pruneUnusedBatches(db, (options.now || Date.now)()).catch(() => {});
      return db;
    }).catch((error) => {
      databasePromise = null;
      throw error;
    });
    return databasePromise;
  }

  async function get(key) {
    const db = await database();
    const transaction = db.transaction(STORE, "readonly");
    const done = transactionDone(transaction);
    const request = transaction.objectStore(STORE).get(`${KEY_PREFIX}${key}`);
    const record = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(storageError("Unable to read title operation."));
    }).catch(async (error) => {
      await done.catch(() => {});
      throw error;
    });
    await done;
    return record?.value || null;
  }

  async function set(key, value) {
    const db = await database();
    const transaction = db.transaction(STORE, "readwrite");
    const done = transactionDone(transaction);
    try {
      transaction.objectStore(STORE).put({ key: `${KEY_PREFIX}${key}`, value });
    } catch (error) {
      transaction.abort();
      await done.catch(() => {});
      throw storageError("Unable to save title operation.");
    }
    await done;
  }

  // Retired read-only batch receipts are removed together with their latest
  // pointer. One transaction prevents an orphaned pointer from reopening a
  // deleted job, or an unreachable job from lingering after cleanup.
  async function remove(keys) {
    const unique = [...new Set((Array.isArray(keys) ? keys : [keys])
      .filter((key) => typeof key === "string" && key))];
    if (!unique.length) return;
    const db = await database();
    const transaction = db.transaction(STORE, "readwrite");
    const done = transactionDone(transaction);
    try {
      const store = transaction.objectStore(STORE);
      for (const key of unique) store.delete(`${KEY_PREFIX}${key}`);
    } catch (error) {
      transaction.abort();
      await done.catch(() => {});
      throw storageError("Unable to remove title operation.");
    }
    await done;
  }

  return Object.freeze({ get, set, remove });
}

export const titleOperationsRepository = createTitleOperationsRepository();
