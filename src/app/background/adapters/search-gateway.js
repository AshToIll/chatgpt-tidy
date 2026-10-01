import { assertExpectedConversationContext } from "../../../platform/context-guard.js";
import { isValidTabId } from "../../../platform/navigation/panel-owner.js";
import { isChatgptUrl } from "../../../platform/session/background/request-binding.js";
import "../../../platform/protocol.js";
import "../../../features/search/model/search.js";
import "../../../platform/catalog/date-search.js";

// Search response validation is distinct from page admission and catalog membership.
export function createSearchGateway({ binding, pageGateway }) {
  const protocol = globalThis.TidyProtocol;
  const searchContract = globalThis.TidySearch;
  const dateSearchContract = globalThis.TidyDateSearch;
  const getBoundTab = binding.getBoundTab;
  async function requestTabSearch(tab, payload) {
    if (!isValidTabId(tab?.id) || !isChatgptUrl(tab.url)) {
      throw Object.assign(new Error("The active tab is not ChatGPT"), {
        tidyCode: protocol.ErrorCode.UNSUPPORTED_PAGE,
        stage: "service-worker.request-tab-search",
      });
    }
    const envelope = protocol.request(protocol.Type.SEARCH_MESSAGES, payload);
    let result;
    try {
      result = await pageGateway.send(tab.id, envelope);
    } catch (error) {
      throw Object.assign(new Error("The ChatGPT content bridge is unavailable."), {
        tidyCode: protocol.ErrorCode.ADAPTER_UNAVAILABLE,
        stage: "service-worker.tabs-send-message",
        cause: error,
      });
    }
    if (!protocol.isResponse(result, envelope.requestId) || !result.ok) {
      throw Object.assign(new Error(result?.error?.message || "The official ChatGPT search interface is unavailable"), {
        tidyCode: protocol.ErrorCode.SEARCH_UNAVAILABLE,
        stage: result?.error?.details?.stage || "service-worker.content-response",
      });
    }
    const validation = searchContract.validatePage(result.payload);
    if (!validation.valid) {
      throw Object.assign(new Error("The official ChatGPT search response changed"), {
        tidyCode: protocol.ErrorCode.SEARCH_UNAVAILABLE,
      });
    }
    return result.payload;
  }

  async function requestBoundSearch(expectedTabId, payload, sender = null) {
    // Resolve the tab and dispatch from the same helper so no later refactor can
    // accidentally reintroduce a focus-dependent active-tab lookup in between.
    try {
      const tab = await getBoundTab(expectedTabId, sender);
      assertExpectedConversationContext(tab, null, {
        tabId: isValidTabId(expectedTabId) ? expectedTabId : tab.id,
      });
      return await requestTabSearch(tab, payload);
    } catch (error) {
      if (!error.stage) error.stage = "service-worker.bound-search";
      throw error;
    }
  }

  async function requestBoundHistoryRead(expectedTabId, type, payload, sender = null) {
    const tab = await getBoundTab(expectedTabId, sender);
    assertExpectedConversationContext(tab, null, { tabId: expectedTabId });
    const unavailableCode = protocol.ErrorCode.DATE_INDEX_UNAVAILABLE;
    const envelope = protocol.request(type, payload);
    let result;
    try {
      result = await pageGateway.send(tab.id, envelope);
    } catch (error) {
      throw Object.assign(new Error("The ChatGPT history-read bridge is unavailable."), {
        tidyCode: protocol.ErrorCode.ADAPTER_UNAVAILABLE,
        stage: "service-worker.history-read-send-message",
        cause: error,
      });
    }
    if (!protocol.isResponse(result, envelope.requestId) || !result.ok) {
      throw Object.assign(new Error(result?.error?.message || "The requested history page is unavailable"), {
        tidyCode: result?.error?.code || unavailableCode,
        stage: result?.error?.details?.stage || "service-worker.history-read-response",
        details: result?.error?.details || null,
      });
    }
    if (
      result.type !== type
      || (type === protocol.Type.DATE_INDEX_ACCOUNT
        && (result.payload?.schemaVersion !== dateSearchContract.VERSION || typeof result.payload?.accountKey !== "string"))
      || (type === protocol.Type.DATE_INDEX_SOURCE_PAGE && !dateSearchContract.validateSourcePage(result.payload))
    ) {
      throw Object.assign(new Error("The requested history page response changed"), {
        tidyCode: unavailableCode,
        stage: "service-worker.history-read-validation",
      });
    }
    return result.payload;
  }

  return Object.freeze({ search: requestBoundSearch, readHistory: requestBoundHistoryRead });
}
