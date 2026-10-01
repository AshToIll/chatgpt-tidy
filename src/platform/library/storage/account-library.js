import { STORAGE_BOUNDARIES } from "../../storage/schema.js";
import { assertAccountKey, openTidyDatabase, storageError } from "../../storage/database.js";

const STORES = STORAGE_BOUNDARIES.indexedDb.stores;

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(storageError(request.error?.message || "Library request failed"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(storageError(transaction.error?.message || "Library transaction aborted"));
    transaction.onerror = () => reject(storageError(transaction.error?.message || "Library transaction failed"));
  });
}

function validationError(message) {
  return Object.assign(new Error(message), { code: "VALIDATION_ERROR", tidyCode: "VALIDATION_ERROR" });
}

const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const withoutOwner = ({ accountKey: _accountKey, ...value }) => value;

// 单库编辑和双库恢复共用事务收尾；任何一笔写入失败都回滚整个事务。
export async function runLibraryTransaction(db, names, mode, operation) {
  const transaction = db.transaction(names, mode);
  const done = transactionDone(transaction);
  try {
    const result = await operation(transaction);
    await done;
    return result;
  } catch (error) {
    try { transaction.abort(); } catch { /* 事务可能已经结束。 */ }
    await done.catch(() => {});
    throw error;
  }
}

// 收藏/书签共用的账号行读写规则。调用方提供事务，普通编辑锁一个库，备份恢复锁两个库。
export function createAccountLibraryAccess({ kind, normalizeState, createEmptyState }) {
  const isBookmark = kind === "bookmarks";
  const itemStoreName = isBookmark ? STORES.bookmarks : STORES.favorites;
  const groupStoreName = isBookmark ? STORES.bookmarkGroups : STORES.favoriteGroups;
  const itemKey = isBookmark ? "bookmarkId" : "conversationId";
  const accountStores = [itemStoreName, groupStoreName, STORES.moduleState];
  const stateKey = (accountKey) => `library:${kind}:${accountKey}`;

  async function readAccount(transaction, accountKey) {
    const [rows, groups, record] = await Promise.all([
      requestValue(transaction.objectStore(itemStoreName).index("accountKey").getAll(accountKey)),
      requestValue(transaction.objectStore(groupStoreName).index("accountKey").getAll(accountKey)),
      requestValue(transaction.objectStore(STORES.moduleState).get(stateKey(accountKey))),
    ]);
    const { key: _key, accountKey: _account, ...metadata } = record || {};
    return {
      // Default folders belong only to a genuinely absent account library.
      // Existing rows/groups without metadata are never treated as a new user.
      empty: record === undefined && rows.length === 0 && groups.length === 0,
      state: {
        ...metadata,
        groups: groups.map(withoutOwner).sort((left, right) => left.order - right.order),
        items: Object.fromEntries(rows.map((item) => [item[itemKey], withoutOwner(item)])),
      },
    };
  }

  function writeAccount(transaction, accountKey, stored, next) {
    const items = transaction.objectStore(itemStoreName);
    for (const id of Object.keys(stored.state.items)) {
      if (!Object.hasOwn(next.items, id)) items.delete([accountKey, id]);
    }
    for (const [id, item] of Object.entries(next.items)) {
      if (!equal(stored.state.items[id], item)) items.put({ ...item, accountKey });
    }
    const groups = transaction.objectStore(groupStoreName);
    const before = new Map(stored.state.groups.map((group) => [group.id, group]));
    const after = new Map(next.groups.map((group) => [group.id, group]));
    for (const id of before.keys()) {
      if (!after.has(id)) groups.delete([accountKey, id]);
    }
    for (const [id, group] of after) {
      if (!equal(before.get(id), group)) groups.put({ ...group, accountKey });
    }
    const { items: _items, groups: _groups, accountKey: _account, ...metadata } = next;
    transaction.objectStore(STORES.moduleState).put({
      ...metadata, key: stateKey(accountKey), accountKey,
    });
  }

  // 只供存储层组合使用；不自行开事务，因此恢复可以同时锁住两种资料。
  return Object.freeze({ stores: accountStores, read: readAccount, write: writeAccount,
    value: stored => stored.empty ? createEmptyState() : normalizeState(stored.state) });
}

export function createAccountLibraryRepository({ kind, normalizeState, createEmptyState, ...options }) {
  const access = createAccountLibraryAccess({ kind, normalizeState, createEmptyState });
  const { stores: accountStores, read: readAccount, write: writeAccount } = access;
  const openDatabase = options.openDatabase || (() => openTidyDatabase(options.indexedDbFactory));
  let databasePromise = null;
  async function runTransaction(names, mode, operation) {
    databasePromise ||= openDatabase().catch(error => { databasePromise = null; throw error; });
    return runLibraryTransaction(await databasePromise, names, mode, operation);
  }

  async function get(accountKey) {
    assertAccountKey(accountKey);
    return runTransaction(accountStores, "readonly", async (transaction) => {
      const stored = await readAccount(transaction, accountKey);
      // Defaults are a pure projection. Merely opening a panel must not write
      // metadata or repeatedly execute an alleged one-time schema migration.
      return { ...(stored.empty ? createEmptyState() : normalizeState(stored.state)), accountKey };
    });
  }

  async function transact(accountKey, mutator) {
    assertAccountKey(accountKey);
    if (typeof mutator !== "function") throw validationError("A library mutation is required.");
    return runTransaction(accountStores, "readwrite", async (transaction) => {
      const stored = await readAccount(transaction, accountKey);
      const current = stored.empty ? createEmptyState() : normalizeState(stored.state);
      const currentValue = JSON.stringify(current);
      const candidate = mutator({ ...current, accountKey });
      if (!candidate || typeof candidate !== "object" || typeof candidate.then === "function") {
        throw validationError("Library mutations must return their new state synchronously.");
      }
      if (Object.hasOwn(candidate, "accountKey") && candidate.accountKey !== accountKey) {
        throw validationError("A library mutation cannot change its account.");
      }
      const next = normalizeState(candidate);
      if (JSON.stringify(next) !== currentValue) writeAccount(transaction, accountKey, stored, next);
      return { ...next, accountKey };
    });
  }

  return Object.freeze({ get, transact });
}
