import { assertExpectedConversationContext } from "../../../platform/context-guard.js";
import { isValidTabId } from "../../../platform/navigation/panel-owner.js";
import { isChatgptUrl, libraryError } from "../../../platform/session/background/request-binding.js";
import "../../../platform/protocol.js";
import "../../../platform/snapshot.js";

import {
  toggleBookmarkFromSnapshot,
  removeBookmark,
  moveBookmark,
  createBookmarkGroup,
  updateBookmarkGroup,
  deleteBookmarkGroup,
  reorderBookmarkGroups,
  updateBookmarksView,
  resolveBookmarkDestinationGroupId,
} from "../../../features/bookmarks/storage/bookmarks-domain.js";
import { parseConversationRoute } from "../../../platform/navigation/conversation-route.js";

// Bookmark operations own no tab or account cache; navigation retains its exact intent handle.
export function createBookmarksHandler({ binding, library, navigation, filingContexts, panelHost }) {
  const protocol = globalThis.TidyProtocol;
  const snapshotContract = globalThis.TidySnapshot;
  const getBoundTab = binding.getBoundTab;
  const requestLibrarySnapshot = library.snapshot;
  const transactBookmarks = library.transactBookmarks;
  const readLibrary = library.read;
  const bookmarkFilingContexts = filingContexts;
  function assertLibraryNavigation(context) {
    library.assertCurrent(context);
    navigation.assertCurrent(context.navigationHandle);
  }
  async function handle({ envelope, sender, libraryOwner, navigationHandle }) {
    if (envelope.type === protocol.Type.BOOKMARKS_GET) {
      return readLibrary("bookmarks", libraryOwner);
    }
    if (envelope.type === protocol.Type.BOOKMARKS_TOGGLE_CURRENT) {
      const payload = envelope.payload || {};
      // Inline glyphs resolve from their content-script sender. A future panel
      // caller must carry the same explicit owner used by every panel action.
      const tab = await getBoundTab(payload.expectedTabId, sender);
      const { snapshot } = await requestLibrarySnapshot(libraryOwner);
      assertExpectedConversationContext(tab, snapshot, {
        tabId: payload.expectedTabId,
        conversationId: payload.expectedConversationId,
      });
      return transactBookmarks(libraryOwner, (state) => {
        const groupId = Object.hasOwn(payload, "groupId")
          ? resolveBookmarkDestinationGroupId(state, payload.groupId)
          : resolveBookmarkDestinationGroupId(state, bookmarkFilingContexts.groupIdForTab(tab?.id, libraryOwner.accountKey));
        return toggleBookmarkFromSnapshot(state, snapshot, payload.messageId, { groupId });
      });
    }
    if (envelope.type === protocol.Type.BOOKMARKS_REMOVE) {
      return transactBookmarks(libraryOwner, (state) => removeBookmark(state, envelope.payload?.bookmarkId));
    }
    if (envelope.type === protocol.Type.BOOKMARKS_MOVE) {
      return transactBookmarks(libraryOwner, (state) => moveBookmark(
        state,
        envelope.payload?.bookmarkId,
        envelope.payload?.groupId,
      ));
    }
    if (envelope.type === protocol.Type.BOOKMARKS_GROUP_CREATE) {
      return transactBookmarks(libraryOwner, (state) => createBookmarkGroup(state, envelope.payload?.name));
    }
    if (envelope.type === protocol.Type.BOOKMARKS_GROUP_UPDATE) {
      return transactBookmarks(libraryOwner, (state) => updateBookmarkGroup(
        state,
        envelope.payload?.groupId,
        envelope.payload?.patch || {},
      ));
    }
    if (envelope.type === protocol.Type.BOOKMARKS_GROUP_DELETE) {
      return transactBookmarks(libraryOwner, (state) => deleteBookmarkGroup(state, envelope.payload?.groupId));
    }
    if (envelope.type === protocol.Type.BOOKMARKS_GROUP_REORDER) {
      return transactBookmarks(libraryOwner, (state) => reorderBookmarkGroups(state, envelope.payload?.orderedGroupIds));
    }
    if (envelope.type === protocol.Type.BOOKMARKS_VIEW_UPDATE) {
      return transactBookmarks(libraryOwner, (state) => updateBookmarksView(state, envelope.payload || {}));
    }
    if (envelope.type === protocol.Type.BOOKMARKS_OPEN) {
      const payload = envelope.payload || {};
      const state = await readLibrary("bookmarks", libraryOwner);
      navigation.assertCurrent(navigationHandle);
      const bookmark = state.items[payload.bookmarkId];
      if (!bookmark) {
        throw Object.assign(new Error(`Bookmark not found: ${payload.bookmarkId}`), {
          tidyCode: protocol.ErrorCode.NOT_FOUND,
        });
      }
      await navigation.selectBookmark(navigationHandle, bookmark);
      const tab = await getBoundTab(payload.expectedTabId, sender);
      assertExpectedConversationContext(tab, null, { tabId: payload.expectedTabId });
      if (!isChatgptUrl(tab?.url)) {
        throw Object.assign(new Error("The active tab is not ChatGPT"), {
          tidyCode: protocol.ErrorCode.UNSUPPORTED_PAGE,
        });
      }
      assertLibraryNavigation(libraryOwner);
      const result = await navigation.openBookmark(navigationHandle, tab, bookmark.routePath);
      return { ...result, bookmarkId: bookmark.bookmarkId, conversationId: bookmark.conversationId,
        messageId: bookmark.messageId, routePath: bookmark.routePath };
    }
    if (envelope.type === protocol.Type.BOOKMARKS_OPEN_CONVERSATION_VIEW) {
      const payload = envelope.payload || {};
      const tab = sender?.tab;
      if (!isValidTabId(tab?.id) || !isChatgptUrl(tab.url)) {
        throw Object.assign(new Error("The bookmark count did not originate from ChatGPT."), {
          tidyCode: protocol.ErrorCode.UNSUPPORTED_PAGE,
        });
      }
      const { snapshot } = await requestLibrarySnapshot(libraryOwner);
      navigation.assertCurrent(navigationHandle);
      const conversation = snapshot.sidebarConversations.find(
        (item) => item.conversationId === payload.conversationId,
      );
      if (!conversation || !snapshotContract.isSidebarPersistenceEligible(conversation)) {
        throw Object.assign(new Error("The sidebar bookmark count is no longer bound to this conversation."), {
          tidyCode: protocol.ErrorCode.CONTEXT_MISMATCH,
        });
      }
      const target = parseConversationRoute(conversation.locator?.value);
      if (!target || target.conversationId !== payload.conversationId) throw libraryError("The bookmark count target route changed.");
      const state = await transactBookmarks(libraryOwner, (current) => {
        navigation.assertCurrent(navigationHandle);
        return updateBookmarksView(current, { groupId: "current", query: "" });
      });
      // "Current" is intentionally the bound native conversation. Make B the
      // current page before requesting its view, instead of silently showing A.
      assertLibraryNavigation(libraryOwner);
      if (new URL(tab.url).pathname !== target.pathname) await navigation.openLibrary(libraryOwner, target.pathname, target.conversationId);
      navigation.assertCurrent(navigationHandle);
      const requestedRoute = {
        route: "bookmarks",
        createdAt: Date.now(),
        tabId: tab.id,
        accountKey: libraryOwner.accountKey,
        conversationId: target.conversationId,
      };
      panelHost.requestRoute(requestedRoute);
      return state;
    }
  }

  return Object.freeze({ types: Object.freeze([protocol.Type.BOOKMARKS_GET, protocol.Type.BOOKMARKS_TOGGLE_CURRENT, protocol.Type.BOOKMARKS_REMOVE, protocol.Type.BOOKMARKS_MOVE, protocol.Type.BOOKMARKS_GROUP_CREATE, protocol.Type.BOOKMARKS_GROUP_UPDATE, protocol.Type.BOOKMARKS_GROUP_DELETE, protocol.Type.BOOKMARKS_GROUP_REORDER, protocol.Type.BOOKMARKS_VIEW_UPDATE, protocol.Type.BOOKMARKS_OPEN, protocol.Type.BOOKMARKS_OPEN_CONVERSATION_VIEW]), handle });
}
