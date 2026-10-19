import { STORAGE_BOUNDARIES } from "./schema.js";

const DB = STORAGE_BOUNDARIES.indexedDb;
const STORES = DB.stores;

export function storageError(message) {
  return Object.assign(new Error(message), { code: "STORAGE_ERROR", tidyCode: "STORAGE_ERROR" });
}

// Identity is an opaque, exact value supplied by the authenticated adapter.
// Never trim an invalid value into a different owner or interpret a missing
// owner as a default/global library.
export function assertAccountKey(value) {
  if (typeof value !== "string" || !value || value.length > 512
    || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw Object.assign(new Error("A verified account is required for this library."), {
      code: "ACCOUNT_REQUIRED", tidyCode: "ACCOUNT_REQUIRED",
    });
  }
  return value;
}

function createAccountStores(database, kind) {
  const isBookmark = kind === "bookmarks";
  const itemName = isBookmark ? STORES.bookmarks : STORES.favorites;
  const groupName = isBookmark ? STORES.bookmarkGroups : STORES.favoriteGroups;
  if (!database.objectStoreNames.contains(itemName)) {
    const store = database.createObjectStore(itemName, {
      keyPath: ["accountKey", isBookmark ? "bookmarkId" : "conversationId"],
    });
    store.createIndex("accountKey", "accountKey", { unique: false });
    store.createIndex("group", ["accountKey", "groupId"], { unique: false });
    if (isBookmark) store.createIndex("message", ["accountKey", "conversationId", "messageId"], { unique: true });
  }
  if (!database.objectStoreNames.contains(groupName)) {
    const groups = database.createObjectStore(groupName, { keyPath: ["accountKey", "id"] });
    groups.createIndex("accountKey", "accountKey", { unique: false });
    // Order is presentation, not identity. Swapping rows must not collide with
    // an old row's still-occupied order inside this same transaction.
    groups.createIndex("order", ["accountKey", "order"], { unique: false });
  }
}

export function ensureTidyStores(database) {
  if (!database.objectStoreNames.contains(STORES.moduleState)) {
    database.createObjectStore(STORES.moduleState, { keyPath: "key" });
  }
  createAccountStores(database, "favorites");
  createAccountStores(database, "bookmarks");
  if (!database.objectStoreNames.contains(STORES.conversationIndex)) {
    database.createObjectStore(STORES.conversationIndex, { keyPath: ["accountKey", "conversationId"] });
  }
}

// v2 是一次性落盘清理，不是旧功能兼容：删除所有账号的退役字段，
// 保留收藏、书签摘录、分组和其他资料。失败随版本升级事务整体回滚。
function removeRetiredLibraryFields(transaction) {
  for (const name of [STORES.favorites, STORES.bookmarks]) {
    const request = transaction.objectStore(name).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const record = cursor.value;
      if (Object.hasOwn(record, "note")) {
        delete record.note;
        cursor.update(record);
      }
      cursor.continue();
    };
  }
  const request = transaction.objectStore(STORES.moduleState).openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const record = cursor.value;
    if (["favorites", "bookmarks"].some(kind => record.key === `library:${kind}:${record.accountKey}`)) {
      cursor.update({ ...record, schemaVersion: 2, revision: (record.revision || 0) + 1 });
    }
    cursor.continue();
  };
}

export function openTidyDatabase(indexedDbFactory = globalThis.indexedDB) {
  if (!indexedDbFactory) return Promise.reject(storageError("IndexedDB is unavailable"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDbFactory.open(DB.databaseName, DB.version);
    request.onupgradeneeded = (event) => {
      if (settled) { request.transaction.abort(); return; }
      try {
        ensureTidyStores(request.result);
        if (event.oldVersion > 0 && event.oldVersion < 2) removeRetiredLibraryFields(request.transaction);
      }
      catch { request.transaction.abort(); }
    };
    request.onsuccess = () => {
      const database = request.result;
      // A blocked open may finish after rejecting. Close that unowned handle
      // instead of leaking a connection that blocks subsequent upgrades.
      if (settled) { database.close(); return; }
      settled = true;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => {
      settled = true;
      reject(storageError(request.error?.message || "Unable to open TIDY IndexedDB"));
    };
    request.onblocked = () => {
      settled = true;
      reject(storageError("TIDY IndexedDB upgrade is blocked by another extension page"));
    };
  });
}
