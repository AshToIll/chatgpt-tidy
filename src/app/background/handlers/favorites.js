import { assertExpectedConversationContext } from "../../../platform/context-guard.js";
import { isChatgptUrl } from "../../../platform/session/background/request-binding.js";
import "../../../platform/protocol.js";
import "../../../platform/snapshot.js";

import {
  upsertFavoriteFromSnapshot,
  upsertFavoriteFromSidebarConversation,
  removeFavorite,
  moveFavorite,
  createFavoriteGroup,
  updateFavoriteGroup,
  deleteFavoriteGroup,
  reorderFavoriteGroups,
  updateFavoritesView,
  resolveFavoriteDestinationGroupId,
} from "../../../features/favorites/storage/favorites-domain.js";

// Favorite protocol actions use the shared library transaction and existing domain functions.
export function createFavoritesHandler({ binding, library, navigation, filingContexts }) {
  const protocol = globalThis.TidyProtocol;
  const snapshotContract = globalThis.TidySnapshot;
  const getBoundTab = binding.getBoundTab;
  const requestLibrarySnapshot = library.snapshot;
  const transactFavorites = library.transactFavorites;
  const readLibrary = library.read;
  const favoriteFilingContexts = filingContexts;
  function assertLibraryNavigation(context) {
    library.assertCurrent(context);
    navigation.assertCurrent(context.navigationHandle);
  }
  async function handle({ envelope, sender, libraryOwner, navigationHandle }) {
    if (envelope.type === protocol.Type.FAVORITES_GET) {
      return readLibrary("favorites", libraryOwner);
    }
    if (envelope.type === protocol.Type.FAVORITES_TOGGLE_CURRENT) {
      const payload = envelope.payload || {};
      const tab = await getBoundTab(payload.expectedTabId, sender);
      const { snapshot } = await requestLibrarySnapshot(libraryOwner);
      assertExpectedConversationContext(tab, snapshot, {
        tabId: payload.expectedTabId,
        conversationId: payload.expectedConversationId,
      });
      return transactFavorites(libraryOwner, (state) => {
        const conversationId = snapshot.conversation.conversationId;
        return state.items[conversationId]
          ? removeFavorite(state, conversationId)
          : upsertFavoriteFromSnapshot(state, snapshot, { groupId: payload.groupId });
      });
    }
    if (envelope.type === protocol.Type.FAVORITES_TOGGLE_SIDEBAR) {
      const payload = envelope.payload || {};
      const tab = sender?.tab;
      const { snapshot } = await requestLibrarySnapshot(libraryOwner);
      const conversation = snapshot.sidebarConversations.find(
        (candidate) => candidate.conversationId === payload.conversationId,
      );
      if (!conversation || (payload.locator && conversation.locator?.value !== payload.locator)) {
        throw Object.assign(new Error("The sidebar conversation changed before the favorite action completed."), {
          tidyCode: protocol.ErrorCode.CONTEXT_MISMATCH,
        });
      }
      if (!snapshotContract.isSidebarPersistenceEligible(conversation)) {
        throw Object.assign(new Error("The sidebar conversation is not stably bound."), {
          tidyCode: protocol.ErrorCode.PERSISTENCE_REJECTED,
        });
      }
      return transactFavorites(libraryOwner, (state) => {
        if (state.items[conversation.conversationId]) {
          return removeFavorite(state, conversation.conversationId);
        }
        // Browsing a folder and filing into a folder are separate states. Only a
        // currently visible Favorites panel can own this ephemeral destination.
        const selectedGroupId = resolveFavoriteDestinationGroupId(
          state,
          favoriteFilingContexts.groupIdForTab(tab?.id, libraryOwner.accountKey),
        );
        return upsertFavoriteFromSidebarConversation(state, conversation, { groupId: selectedGroupId });
      });
    }
    if (envelope.type === protocol.Type.FAVORITES_REMOVE) {
      return transactFavorites(libraryOwner, (state) => removeFavorite(state, envelope.payload?.conversationId));
    }
    if (envelope.type === protocol.Type.FAVORITES_MOVE) {
      return transactFavorites(libraryOwner, (state) => moveFavorite(
        state,
        envelope.payload?.conversationId,
        envelope.payload?.groupId,
      ));
    }
    if (envelope.type === protocol.Type.FAVORITES_GROUP_CREATE) {
      return transactFavorites(libraryOwner, (state) => createFavoriteGroup(state, envelope.payload?.name));
    }
    if (envelope.type === protocol.Type.FAVORITES_GROUP_UPDATE) {
      return transactFavorites(libraryOwner, (state) => updateFavoriteGroup(
        state,
        envelope.payload?.groupId,
        envelope.payload?.patch || {},
      ));
    }
    if (envelope.type === protocol.Type.FAVORITES_GROUP_DELETE) {
      return transactFavorites(libraryOwner, (state) => deleteFavoriteGroup(state, envelope.payload?.groupId));
    }
    if (envelope.type === protocol.Type.FAVORITES_GROUP_REORDER) {
      return transactFavorites(libraryOwner, (state) => reorderFavoriteGroups(
        state,
        envelope.payload?.orderedGroupIds,
      ));
    }
    if (envelope.type === protocol.Type.FAVORITES_VIEW_UPDATE) {
      return transactFavorites(libraryOwner, (state) => updateFavoritesView(state, envelope.payload || {}));
    }
    if (envelope.type === protocol.Type.FAVORITES_OPEN) {
      const payload = envelope.payload || {};
      const state = await readLibrary("favorites", libraryOwner);
      navigation.assertCurrent(navigationHandle);
      const favorite = state.items[payload.conversationId];
      if (!favorite) {
        throw Object.assign(new Error(`Favorite not found: ${payload.conversationId}`), {
          tidyCode: protocol.ErrorCode.NOT_FOUND,
        });
      }
      const tab = await getBoundTab(payload.expectedTabId, sender);
      assertExpectedConversationContext(tab, null, { tabId: payload.expectedTabId });
      if (!isChatgptUrl(tab?.url)) {
        throw Object.assign(new Error("The active tab is not ChatGPT"), {
          tidyCode: protocol.ErrorCode.UNSUPPORTED_PAGE,
        });
      }
      assertLibraryNavigation(libraryOwner);
      await navigation.openLibrary(libraryOwner, favorite.routePath, favorite.conversationId);
      navigation.assertCurrent(navigationHandle);
      return { conversationId: favorite.conversationId, routePath: favorite.routePath };
    }
  }

  return Object.freeze({ types: Object.freeze([protocol.Type.FAVORITES_GET, protocol.Type.FAVORITES_TOGGLE_CURRENT, protocol.Type.FAVORITES_TOGGLE_SIDEBAR, protocol.Type.FAVORITES_REMOVE, protocol.Type.FAVORITES_MOVE, protocol.Type.FAVORITES_GROUP_CREATE, protocol.Type.FAVORITES_GROUP_UPDATE, protocol.Type.FAVORITES_GROUP_DELETE, protocol.Type.FAVORITES_GROUP_REORDER, protocol.Type.FAVORITES_VIEW_UPDATE, protocol.Type.FAVORITES_OPEN]), handle });
}
