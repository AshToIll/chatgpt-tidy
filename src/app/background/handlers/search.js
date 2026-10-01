import { isValidTabId } from "../../../platform/navigation/panel-owner.js";
import "../../../platform/protocol.js";
import "../../../features/search/model/search.js";
import "../../../platform/catalog/date-search.js";

export function createSearchHandler({ search }) {
  const protocol = globalThis.TidyProtocol;
  const searchContract = globalThis.TidySearch;
  const dateSearchContract = globalThis.TidyDateSearch;
  const requestBoundSearch = search.search;
  const requestBoundHistoryRead = search.readHistory;
  async function handle({ envelope, sender }) {
    if (envelope.type === protocol.Type.SEARCH_MESSAGES) {
      const payload = envelope.payload || {};
      let request;
      try {
        request = searchContract.normalizeRequest(payload);
      } catch (error) {
        throw Object.assign(error, { tidyCode: protocol.ErrorCode.INVALID_REQUEST });
      }
      return requestBoundSearch(payload.expectedTabId, request, sender);
    }
    if ([
      protocol.Type.DATE_INDEX_ACCOUNT,
      protocol.Type.DATE_INDEX_SOURCE_PAGE,
    ].includes(envelope.type)) {
      const payload = envelope.payload || {};
      if (!isValidTabId(payload.expectedTabId)) {
        throw Object.assign(new Error("History reads require an exact ChatGPT tab."), {
          tidyCode: protocol.ErrorCode.INVALID_REQUEST,
        });
      }
      let request = {};
      try {
        if (envelope.type === protocol.Type.DATE_INDEX_SOURCE_PAGE) {
          request = dateSearchContract.normalizeSourceRequest(payload);
        }
      } catch (error) {
        throw Object.assign(error, { tidyCode: protocol.ErrorCode.INVALID_REQUEST });
      }
      return requestBoundHistoryRead(payload.expectedTabId, envelope.type, request, sender);
    }
  }

  return Object.freeze({ types: Object.freeze([protocol.Type.SEARCH_MESSAGES, protocol.Type.DATE_INDEX_ACCOUNT, protocol.Type.DATE_INDEX_SOURCE_PAGE]), handle });
}
