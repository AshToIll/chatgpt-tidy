import { normalizeBookmarksState, createEmptyBookmarksState } from "./bookmarks-domain.js";
import { createAccountLibraryRepository } from "../../../platform/library/storage/account-library.js";

export function createBookmarksRepository(options = {}) {
  return createAccountLibraryRepository({ ...options, kind: "bookmarks",
    normalizeState: normalizeBookmarksState, createEmptyState: createEmptyBookmarksState });
}

export const bookmarksRepository = createBookmarksRepository();
