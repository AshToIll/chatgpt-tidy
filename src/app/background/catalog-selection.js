import "../../platform/protocol.js";

// Title batches and date export share catalog membership, never write authority.
export function createCatalogSelection({ repository, search }) {
  const protocol = globalThis.TidyProtocol;
  const conversationCatalogRepository = repository;
  const requestBoundHistoryRead = search.readHistory;
  async function validateCatalogSelection(expectedTabId, selection, sender) {
    // Search export and title batches share candidate membership, not write
    // authority. Prove the current catalog account and exact persisted rows.
    const account = await requestBoundHistoryRead(expectedTabId, protocol.Type.DATE_INDEX_ACCOUNT, {}, sender);
    if (account.accountKey !== selection.accountKey) {
      throw Object.assign(new Error("The date search selection belongs to a different ChatGPT account."), {
        tidyCode: protocol.ErrorCode.CONTEXT_MISMATCH,
        stage: "service-worker.search-export-account",
      });
    }
    return readCatalogSelection(selection);
  }

  // Membership validation is local and identical for both consumers. Each
  // caller must first prove its catalog account through its own live adapter.
  async function readCatalogSelection(selection) {
    const snapshot = await conversationCatalogRepository.getSnapshot(selection.accountKey);
    if (!Array.isArray(snapshot?.rows)
      || (snapshot.state?.accountKey != null && snapshot.state.accountKey !== selection.accountKey)) {
      throw Object.assign(new Error("The account conversation directory is unavailable."), {
        tidyCode: protocol.ErrorCode.EXPORT_UNAVAILABLE,
        stage: "service-worker.search-export-catalog",
      });
    }
    const selectedIds = new Set(selection.conversationIds);
    const rows = new Map(snapshot.rows.filter((row) => row && selectedIds.has(row.conversationId)
      && typeof row.title === "string"
      && (row.accountKey == null || row.accountKey === selection.accountKey))
      .map((row) => [row.conversationId, row]));
    if (selection.conversationIds.some((id) => !rows.has(id))) {
      throw Object.assign(new Error("One or more selected conversations are no longer in this account's date search directory."), {
        tidyCode: protocol.ErrorCode.NOT_FOUND,
        stage: "service-worker.search-export-membership",
      });
    }
    return rows;
  }

  return Object.freeze({ read: readCatalogSelection, validate: validateCatalogSelection, getRow: (accountKey, id) => repository.getRow(accountKey, id),
    observeTitles: (...args) => repository.observeTitles(...args), acceptTitles: (...args) => repository.acceptTitles(...args) });
}
