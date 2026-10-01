import { STORAGE_BOUNDARIES } from "../../storage/schema.js";
import { openTidyDatabase, storageError, assertAccountKey } from "../../storage/database.js";

const STORES = STORAGE_BOUNDARIES.indexedDb.stores;
const stateKey = (accountKey) => `conversation-catalog:${accountKey}`;
const timeValue = (value) => Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? value : null;
const CATALOG_VERSION = 2;
const versionError = (version) => Object.assign(new TypeError("Unsupported conversation catalog checkpoint version"), {
  code: "CATALOG_VERSION_UNSUPPORTED", category: "SCHEMA", retryable: false,
  expectedCatalogVersion: CATALOG_VERSION, observedCatalogVersion: typeof version === "number" && Number.isFinite(version) ? version : null,
});
const requireVersion = (state) => {
  if (state?.catalogVersion !== CATALOG_VERSION) throw versionError(state?.catalogVersion);
};

function catalogStorageError(error, fallback) {
  if (["STORAGE_ERROR", "CATALOG_SUPERSEDED", "ACCOUNT_REQUIRED", "CATALOG_VERSION_UNSUPPORTED", "SCHEMA"].includes(error?.code)) return error;
  return Object.assign(storageError(error?.message || fallback), {
    // Keep native IndexedDB exception names for internal diagnosis. The UI
    // consumes only a fixed classification; it never displays backend content.
    name: error?.name || "StorageError", category: "STORAGE", cause: error,
  });
}

function supersededError(expected, observed) {
  return Object.assign(new Error("Catalog checkpoint was superseded by a newer directory scan"), {
    name: "CatalogSupersededError", code: "CATALOG_SUPERSEDED", category: "CONCURRENCY", retryable: false,
    expectedGeneration: expected.generation ?? 0, expectedRevision: expected.revision ?? 0,
    observedGeneration: observed.generation ?? 0, observedRevision: observed.revision ?? 0,
  });
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(catalogStorageError(request.error, "Catalog request failed"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(catalogStorageError(transaction.error, "Catalog transaction aborted"));
    transaction.onerror = () => reject(catalogStorageError(transaction.error, "Catalog transaction failed"));
  });
}

function catalogRow(row) {
  // Runtime reads have exactly one schema: missing metadata stays missing,
  // never a second fallback model.
  const metadata = row.catalogMetadata || {};
  return {
    conversationId: row.conversationId,
    title: typeof metadata.title === "string" ? metadata.title : "",
    projectId: metadata.projectId || null,
    createdAt: timeValue(metadata.createdAt),
    updatedAt: timeValue(metadata.updatedAt),
    observedAt: timeValue(metadata.observedAt),
    catalogGeneration: metadata.catalogGeneration ?? null,
    ...(metadata.titleChangeStartedAt != null ? { titleChangeStartedAt: metadata.titleChangeStartedAt } : {}),
  };
}

export function createConversationCatalogRepository(options = {}) {
  const openDatabase = options.openDatabase || (() => openTidyDatabase(options.indexedDbFactory));
  const now = options.now || (() => Date.now());
  let databasePromise;
  let writes = Promise.resolve();
  const database = () => databasePromise ||= openDatabase().catch((error) => {
    databasePromise = null;
    throw error;
  });

  async function getSnapshot(accountKey) {
    assertAccountKey(accountKey);
    let done;
    try {
      const db = await database();
      const transaction = db.transaction([STORES.conversationIndex, STORES.moduleState], "readonly");
      done = transactionDone(transaction);
      // Conversation IDs are strings. An array upper key includes every string
      // ID for this account without reading another account's directory.
      const rowsRequest = transaction.objectStore(STORES.conversationIndex).getAll(
        IDBKeyRange.bound([accountKey], [accountKey, []]),
      );
      const stateRequest = transaction.objectStore(STORES.moduleState).get(stateKey(accountKey));
      const [rows, state] = await Promise.all([requestValue(rowsRequest), requestValue(stateRequest)]);
      await done;
      return { rows: rows.map(catalogRow), state: state || null };
    } catch (error) {
      await done?.catch(() => {});
      throw catalogStorageError(error, "Catalog snapshot could not be read");
    }
  }

  // 改名通知只按主键读取一条记录，不读目录快照，不触发任何网页请求。
  async function getRow(accountKey, conversationId) {
    assertAccountKey(accountKey);
    const db = await database();
    const transaction = db.transaction(STORES.conversationIndex, "readonly");
    const done = transactionDone(transaction);
    try {
      const row = await requestValue(transaction.objectStore(STORES.conversationIndex).get([accountKey, conversationId]));
      await done;
      return row?.catalogMetadata ? catalogRow(row) : null;
    } catch (error) { await done.catch(() => {}); throw catalogStorageError(error, "Title row could not be read"); }
  }

  async function acceptTitleChange(accountKey, change, isCurrent = () => true) {
    assertAccountKey(accountKey);
    if (typeof change?.conversationId !== "string" || !change.conversationId
      || typeof change.title !== "string" || !change.title.trim() || change.title.length > 4096
      || !Number.isFinite(change.startedAt) || change.startedAt < 0) return false;
    const pending = writes.then(async () => {
      const db = await database();
      const transaction = db.transaction(STORES.conversationIndex, "readwrite");
      const done = transactionDone(transaction);
      try {
        const store = transaction.objectStore(STORES.conversationIndex);
        const row = await requestValue(store.get([accountKey, change.conversationId]));
        const previous = row?.catalogMetadata;
        // 身份在真正提交前再封口；迟到事件、重复事件和较新的 TIDY 写入不能被覆盖。
        if (!isCurrent() || !previous
          || change.startedAt <= Math.max(previous.titleChangeStartedAt ?? -Infinity,
            previous.titleReadbackAt ?? -Infinity, previous.titleAcceptedAt ?? -Infinity)) {
          await done; return false;
        }
        // 请求起点用于改名事件排序，落库时间用于挡住旧扫描；不能混用，
        // 否则 Worker 延迟落库会误丢已经开始的下一次正常改名。
        const observedAt = now();
        store.put({ ...row, catalogMetadata: { ...previous, title: change.title,
          titleChangeStartedAt: change.startedAt, titleChangedAt: observedAt, observedAt } });
        await done;
        return true;
      } catch (error) {
        try { transaction.abort(); } catch { /* Already completed. */ }
        await done.catch(() => {}); throw catalogStorageError(error, "Title change could not be saved");
      }
    });
    writes = pending.catch(() => {});
    return pending;
  }

  function write(accountKey, state, page = null) {
    assertAccountKey(accountKey);
    const pending = writes.then(async () => {
      let transaction, done;
      try {
        requireVersion(state);
        const db = await database();
        transaction = db.transaction([STORES.conversationIndex, STORES.moduleState], "readwrite");
        done = transactionDone(transaction);
        // Search and Titles can live in different panel instances. Their local
        // queues cannot protect each other, so compare the durable checkpoint
        // inside this same transaction before touching either rows or state.
        const states = transaction.objectStore(STORES.moduleState);
        const persisted = await requestValue(states.get(stateKey(accountKey)));
        if (persisted) requireVersion(persisted);
        if (persisted && ((persisted.generation ?? 0) > (state.generation ?? 0)
          || (persisted.generation === state.generation && (persisted.revision ?? 0) > (state.revision ?? 0)))) {
          // A competing directory owner is not a database outage. Keep the
          // fence strict, but let its caller stop rather than report/retry I/O.
          throw supersededError(state, persisted);
        }
        const store = transaction.objectStore(STORES.conversationIndex);
        for (const candidate of page?.conversations || []) {
          const current = await requestValue(store.get([accountKey, candidate.conversationId]));
          const previous = current ? catalogRow(current) : {};
          const sameSnapshot = current?.catalogMetadata?.catalogGeneration === state.generation;
          const retained = sameSnapshot ? previous : {};
          const createdAt = timeValue(candidate.directoryBounds?.createdAt);
          const updatedAt = timeValue(candidate.updatedAt);
          const readbackAt = timeValue(current?.catalogMetadata?.titleReadbackAt);
          const acceptedAt = timeValue(current?.catalogMetadata?.titleAcceptedAt);
          const changedAt = timeValue(current?.catalogMetadata?.titleChangedAt);
          const projectionAt = Math.max(readbackAt ?? -Infinity, acceptedAt ?? -Infinity, changedAt ?? -Infinity);
          // A page started before a verified readback or accepted rename can arrive afterward,
          // including from a different repository instance in the worker.
          // Keep title + update time together; never stamp old text with a
          // newer timestamp. A later fresh snapshot can correct earlier/null/
          // equal times instead of making the verified projection permanent.
          const protectsProjection = projectionAt > -Infinity
            && (timeValue(state.snapshotStartedAt) ?? -Infinity) <= projectionAt;
          const keepExternalTitle = current?.catalogMetadata?.titleChangeStartedAt != null && protectsProjection;
          const keepTitle = keepExternalTitle || previous.updatedAt != null && (
            (updatedAt !== null && previous.updatedAt > updatedAt && (sameSnapshot || protectsProjection))
            || (updatedAt === null && (sameSnapshot || protectsProjection))
            || (updatedAt === previous.updatedAt && protectsProjection));
          const metadata = {
            title: keepTitle ? previous.title : (candidate.title || retained.title || ""),
            // Sources in one snapshot may omit membership, but a new snapshot
            // must permit a conversation to move out of its previous project.
            projectId: candidate.projectId || retained.projectId || null,
            // Other sources in this snapshot may omit an already-observed
            // field. A new snapshot must accept corrections, including null.
            createdAt: createdAt ?? retained.createdAt ?? null,
            updatedAt: keepTitle ? previous.updatedAt : updatedAt,
            titleReadbackAt: keepTitle ? readbackAt : null,
            titleAcceptedAt: keepTitle ? acceptedAt : null,
            ...(current?.catalogMetadata?.titleChangeStartedAt != null
              ? { titleChangeStartedAt: current.catalogMetadata.titleChangeStartedAt,
                titleChangedAt: keepTitle ? changedAt : null } : {}),
            observedAt: now(),
            catalogGeneration: state.generation,
          };
          store.put({ accountKey, conversationId: candidate.conversationId, catalogMetadata: metadata });
        }
        states.put({ ...state, key: stateKey(accountKey), accountKey });
        await done;
      } catch (error) {
        try { transaction?.abort(); } catch (_) { /* Already aborted or completed. */ }
        await done?.catch(() => {});
        throw catalogStorageError(error, "Catalog checkpoint could not be written");
      }
    });
    writes = pending.catch(() => {});
    return pending;
  }

  function observeTitles(accountKey, observations) {
    assertAccountKey(accountKey);
    // A verified title readback updates existing directory projections only.
    // Preserve project membership, coverage, pagination and generation; a
    // title write is not evidence that a new directory row should be invented.
    const pending = writes.then(async () => {
      const db = await database();
      const transaction = db.transaction(STORES.conversationIndex, "readwrite");
      const done = transactionDone(transaction);
      try {
        const store = transaction.objectStore(STORES.conversationIndex);
        for (const observation of observations || []) {
          if (!observation || typeof observation.conversationId !== "string" || typeof observation.title !== "string") continue;
          const current = await requestValue(store.get([accountKey, observation.conversationId]));
          if (!current?.catalogMetadata) continue;
          const updatedAt = Date.parse(observation.updatedAt);
          if (!Number.isFinite(updatedAt) || (current.catalogMetadata.updatedAt ?? -Infinity) > updatedAt) continue;
          const createdAt = Date.parse(observation.createdAt);
          store.put({ accountKey, conversationId: current.conversationId, catalogMetadata: { ...current.catalogMetadata,
            title: observation.title, updatedAt, observedAt: now(), titleReadbackAt: now(),
            ...(Number.isFinite(createdAt) ? { createdAt } : {}),
          } });
        }
        await done;
      } catch (error) {
        try { transaction.abort(); } catch { /* Already completed. */ }
        await done.catch(() => {}); throw error;
      }
    });
    writes = pending.catch(() => {});
    return pending;
  }

  function acceptTitles(accountKey, intents) {
    assertAccountKey(accountKey);
    // A successful 2xx rename is accepted by ChatGPT but is not a metadata
    // readback. Project only its exact title onto an existing catalog row and
    // preserve the last observed timestamps; the next fresh scan corrects it.
    const pending = writes.then(async () => {
      const db = await database();
      const transaction = db.transaction(STORES.conversationIndex, "readwrite");
      const done = transactionDone(transaction);
      try {
        const store = transaction.objectStore(STORES.conversationIndex);
        for (const intent of intents || []) {
          if (!intent || typeof intent.conversationId !== "string" || typeof intent.title !== "string") continue;
          const current = await requestValue(store.get([accountKey, intent.conversationId]));
          if (!current?.catalogMetadata) continue;
          store.put({ accountKey, conversationId: current.conversationId, catalogMetadata: { ...current.catalogMetadata,
            title: intent.title, observedAt: now(), titleAcceptedAt: now(),
          } });
        }
        await done;
      } catch (error) {
        try { transaction.abort(); } catch { /* Already completed. */ }
        await done.catch(() => {}); throw error;
      }
    });
    writes = pending.catch(() => {});
    return pending;
  }

  return Object.freeze({
    getSnapshot,
    observeTitles,
    acceptTitles,
    getRow,
    acceptTitleChange,
    putState: (accountKey, state) => write(accountKey, state),
    commitPage: (accountKey, page, state) => write(accountKey, state, page),
  });
}
