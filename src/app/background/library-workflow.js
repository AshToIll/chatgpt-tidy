import { favoritesRepository } from "../../features/favorites/storage/favorites.js";
import { bookmarksRepository } from "../../features/bookmarks/storage/bookmarks.js";
import { refreshFavoriteFromSnapshot } from "../../features/favorites/storage/favorites-domain.js";
import { refreshBookmarksFromSnapshot } from "../../features/bookmarks/storage/bookmarks-domain.js";
import { libraryError } from "../../platform/session/background/request-binding.js";
import "../../platform/protocol.js";
import "../../platform/snapshot.js";

// One existing identity lease, two independently failing storage domains.
// Only explicit load refreshes metadata; queued writes recheck the lease inside the mutator.
export function createLibraryWorkflow({ chrome, identity, pageGateway }) {
  const protocol = globalThis.TidyProtocol;
  const snapshotContract = globalThis.TidySnapshot;
  const assertLibraryContext = identity.assertCurrent;
  const requestTabSnapshot = pageGateway.snapshot;
  const broadcastToChatgptTabs = pageGateway.broadcast;
  function requestLibrarySnapshot(context, { titleOwnerOnly = false } = {}) {
    assertLibraryContext(context);
    // Reuse the snapshot IPC already needed by this action. The page checks its
    // local epoch before/after reading DOM, without any session/network request.
    return requestTabSnapshot(context.tab, { ...(titleOwnerOnly ? { scope: "title-owner" } : {}), expectedLibraryIdentity: {
      accountKey: context.accountKey, epoch: context.identity.epoch,
    } }, context.identity.documentId);
  }

  function checkedLibraryState(state, accountKey) {
    if (!state || state.accountKey !== accountKey) throw libraryError("The stored library owner does not match this request.");
    return state;
  }

  function invalidateLibrary(kind, state) {
    // Broadcast only an invalidation token. Never deliver another account's
    // excerpts/notes to all content scripts; each visible consumer revalidates
    // its own tab before reading a fresh scoped library.
    const envelope = protocol.event(kind === "favorites" ? protocol.Type.FAVORITES_UPDATED : protocol.Type.BOOKMARKS_UPDATED,
      { accountKey: state.accountKey, revision: state.revision });
    chrome.runtime.sendMessage(envelope).catch(() => {});
    void broadcastToChatgptTabs(envelope);
  }

  async function transactLibrary(kind, context, mutator) {
    await assertLibraryContext(context);
    const repository = kind === "favorites" ? favoritesRepository : bookmarksRepository;
    let changed = false;
    const state = checkedLibraryState(await repository.transact(context.accountKey, (current) => {
      // IndexedDB may queue this transaction behind another write. Recheck the
      // local lease inside the synchronous mutator, not just before its await.
      assertLibraryContext(context);
      const next = mutator(current);
      changed = next.revision !== current.revision;
      return next;
    }), context.accountKey);
    if (changed) invalidateLibrary(kind, state);
    await assertLibraryContext(context);
    return state;
  }

  const transactFavorites = (context, mutator) => transactLibrary("favorites", context, mutator);
  const transactBookmarks = (context, mutator) => transactLibrary("bookmarks", context, mutator);

  async function readLibraryState(kind, context, snapshot = null) {
    const repository = kind === "favorites" ? favoritesRepository : bookmarksRepository;
    let changed = false;
    const state = checkedLibraryState(snapshot ? await repository.transact(context.accountKey, (current) => {
      assertLibraryContext(context);
      const next = kind === "favorites" ? refreshFavoriteFromSnapshot(current, snapshot) : refreshBookmarksFromSnapshot(current, snapshot);
      changed = next.revision !== current.revision;
      return next;
    }) : await repository.get(context.accountKey), context.accountKey);
    if (changed) invalidateLibrary(kind, state);
    return state;
  }

  async function readLibrary(kind, context) {
    const state = await readLibraryState(kind, context);
    await assertLibraryContext(context);
    return state;
  }

  async function load(libraryOwner, requestId = null) {
    let snapshot = null;
    try {
      const result = await requestLibrarySnapshot(libraryOwner);
      if (snapshotContract.isPersistenceEligible(result.snapshot)) snapshot = result.snapshot;
    } catch (error) {
      if (error.tidyCode === protocol.ErrorCode.CONTEXT_MISMATCH) throw error;
      /* A missing page snapshot must not hide the saved account library. */
    }
    // Only this explicit library read refreshes current metadata, at most one
    // snapshot per request. It never runs on streaming snapshot events or on
    // getActiveContext, and unchanged domain revisions emit no invalidation.
    if (snapshot) await assertLibraryContext(libraryOwner);
    const [favorites, bookmarks] = await Promise.allSettled([
      readLibraryState("favorites", libraryOwner, snapshot), readLibraryState("bookmarks", libraryOwner, snapshot),
    ]);
    await assertLibraryContext(libraryOwner);
    // Account verification is shared; storage availability is not. A failed
    // bookmark migration must not hide valid favorites or block current export.
    const value = (result) => result.status === "fulfilled" ? result.value : null;
    const error = (result) => result.status === "rejected" ? {
      code: result.reason?.tidyCode || result.reason?.code || protocol.ErrorCode.STORAGE_ERROR,
      message: "This local library is unavailable.",
      // Preserve only the known outer request identity; do not expose repository error text.
      ...(requestId ? { requestId } : {}),
      details: { stage: "service-worker.library-storage" },
    } : null;
    return { accountKey: libraryOwner.accountKey, identity: libraryOwner.identity, favorites: value(favorites), bookmarks: value(bookmarks),
      errors: { favorites: error(favorites), bookmarks: error(bookmarks) } };
  }

  return Object.freeze({ load, read: readLibrary, readState: readLibraryState, snapshot: requestLibrarySnapshot,
    transactFavorites, transactBookmarks, assertCurrent: assertLibraryContext, invalidate: invalidateLibrary });
}
