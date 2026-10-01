import { normalizeFavoritesState, createEmptyFavoritesState } from "./favorites-domain.js";
import { createAccountLibraryRepository } from "../../../platform/library/storage/account-library.js";

// Both libraries use the same account/workspace-scoped transaction boundary.
export function createFavoritesRepository(options = {}) {
  return createAccountLibraryRepository({ ...options, kind: "favorites",
    normalizeState: normalizeFavoritesState, createEmptyState: createEmptyFavoritesState });
}

export const favoritesRepository = createFavoritesRepository();
