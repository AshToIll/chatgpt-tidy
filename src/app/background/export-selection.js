import { isValidTabId } from "../../platform/navigation/panel-owner.js";
import "../../platform/protocol.js";
const protocol = globalThis.TidyProtocol;

// Pure input checks precede account, catalog and network reads.
function normalizeSearchExportSelection(payload, conversationIds) {
  if (!Object.hasOwn(payload, "searchSelection")) return null;
  const selection = payload.searchSelection;
  if (!selection || typeof selection !== "object" || Array.isArray(selection)
    || typeof selection.accountKey !== "string" || !selection.accountKey.trim()
    || selection.accountKey !== selection.accountKey.trim()
    || !Array.isArray(selection.conversationIds) || !selection.conversationIds.length
    || selection.conversationIds.length > 100
    || selection.conversationIds.some((id) => typeof id !== "string" || !id.trim()
      || id !== id.trim() || !conversationIds.includes(id))) {
    throw Object.assign(new Error("Date search export requires an account-bound subset of the selected conversations."), {
      tidyCode: protocol.ErrorCode.INVALID_REQUEST,
      stage: "service-worker.search-export-selection",
    });
  }
  return { accountKey: selection.accountKey, conversationIds: [...new Set(selection.conversationIds)] };
}

export function normalizeBatchExportSelection(payload = {}) {
  const conversationIds = [...new Set((Array.isArray(payload.conversationIds) ? payload.conversationIds : [])
    .filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))];
  const bookmarkIds = [...new Set((Array.isArray(payload.bookmarkIds) ? payload.bookmarkIds : [])
    .filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))];
  if (!isValidTabId(payload.expectedTabId) || !conversationIds.length || conversationIds.length > 100 || bookmarkIds.length > 500) {
    throw Object.assign(new Error("Batch export requires a bounded conversation selection and exact tab."), {
      tidyCode: protocol.ErrorCode.INVALID_REQUEST,
    });
  }
  return { conversationIds, bookmarkIds, searchSelection: normalizeSearchExportSelection(payload, conversationIds) };
}
