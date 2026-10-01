import { openTidyDatabase, storageError } from "../../storage/database.js";
import { STORAGE_BOUNDARIES } from "../../storage/schema.js";

const STORE = STORAGE_BOUNDARIES.indexedDb.stores.moduleState;
const KEY = "navigation:worker-epoch";

/**
 * One monotonic control generation per worker lifetime, not per click.
 * An atomic counter lets a still-open MAIN world reject delayed controls from
 * an older worker without relying on wall-clock time or retaining user data.
 */
export function createNavigationEpochAllocator({ openDatabase = openTidyDatabase } = {}) {
  let pending = null;
  return function allocateNavigationEpoch() {
    if (pending) return pending;
    pending = Promise.resolve().then(openDatabase).then((database) => new Promise((resolve, reject) => {
      let transaction, epoch, failure = null;
      try {
        transaction = database.transaction(STORE, "readwrite");
        const store = transaction.objectStore(STORE);
        const request = store.get(KEY);
        request.onsuccess = () => {
          const previous = request.result === undefined ? 0 : request.result.epoch;
          if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) {
            failure = storageError("The navigation control generation is unavailable.");
            transaction.abort();
            return;
          }
          epoch = previous + 1;
          store.put({ key: KEY, epoch });
        };
        transaction.oncomplete = () => resolve(epoch);
        transaction.onabort = transaction.onerror = () => reject(failure || transaction.error
          || storageError("The navigation control generation could not be saved."));
      } catch (error) { reject(error); }
    }));
    // A failed allocation authorizes no physical navigation. Retain its
    // rejection for this worker instead of repeatedly touching storage per click.
    return pending;
  };
}
