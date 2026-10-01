import { createFilingContextRegistry } from "../../../platform/library/background/filing-context.js";

/**
 * Ephemeral destination used by one-click message bookmark glyphs.
 *
 * Browsing a bookmark folder is not by itself a filing rule. A custom group
 * only becomes the destination while the Bookmarks panel is visible, the same
 * ChatGPT tab is active, and the panel is not showing filtered search results.
 * Closing or leaving the panel disconnects its Port and clears this state.
 */
export function createBookmarkFilingContextRegistry() {
  return createFilingContextRegistry();
}
