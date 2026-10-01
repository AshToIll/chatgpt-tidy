import { createFilingContextRegistry } from "../../../platform/library/background/filing-context.js";

/**
 * Ephemeral filing destinations for one-click sidebar favorites.
 *
 * This state intentionally lives only in the service worker and is owned by a
 * Side Panel Port. Closing the panel, leaving Favorites, changing tabs, or a
 * service-worker restart removes the destination automatically. The persisted
 * Favorites view may still remember the last browsed folder without silently
 * affecting future stars.
 */
export function createFavoriteFilingContextRegistry() {
  return createFilingContextRegistry();
}
