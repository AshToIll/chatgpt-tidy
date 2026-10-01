import { isValidTabId } from "../../../platform/navigation/panel-owner.js";
import { isChatgptUrl } from "../../../platform/session/background/request-binding.js";
import "../../../platform/protocol.js";
import "../../../features/export/model/export.js";

// Current branch, exact batch set and preview each retain their own response checks.
export function createExportGateway({ pageGateway }) {
  const protocol = globalThis.TidyProtocol;
  const exportContract = globalThis.TidyExportContract;
  async function requestCurrentConversationExport(tab, payload) {
    const envelope = protocol.request(protocol.Type.EXPORT_CURRENT_CONVERSATION, payload);
    let result;
    try {
      result = await pageGateway.send(tab.id, envelope);
    } catch (error) {
      throw Object.assign(new Error("Refresh the ChatGPT page before exporting."), {
        tidyCode: protocol.ErrorCode.ADAPTER_UNAVAILABLE,
        stage: "service-worker.export-send-message",
        cause: error,
      });
    }
    if (!protocol.isResponse(result, envelope.requestId) || !result.ok) {
      throw Object.assign(new Error(result?.error?.message || "The current conversation could not be exported."), {
        tidyCode: result?.error?.code || protocol.ErrorCode.EXPORT_UNAVAILABLE,
        stage: result?.error?.details?.stage || "service-worker.export-response",
      });
    }
    const validation = exportContract.validateDocument(result.payload);
    if (!validation.valid) {
      throw Object.assign(new Error(`Invalid export document: ${validation.errors.join(", ")}`), {
        tidyCode: protocol.ErrorCode.EXPORT_UNAVAILABLE,
        stage: "service-worker.export-validation",
      });
    }
    if (result.payload.conversation.id !== payload.expectedConversationId) {
      throw Object.assign(new Error("The exported conversation no longer matches the requested context."), {
        tidyCode: protocol.ErrorCode.CONTEXT_MISMATCH,
        stage: "service-worker.export-identity",
      });
    }
    return result.payload;
  }

  async function requestBatchConversationExport(tab, payload) {
    if (!isValidTabId(tab?.id) || !isChatgptUrl(tab.url)) {
      throw Object.assign(new Error("The active tab is not ChatGPT"), {
        tidyCode: protocol.ErrorCode.UNSUPPORTED_PAGE,
        stage: "service-worker.batch-export-tab",
      });
    }
    const envelope = protocol.request(protocol.Type.EXPORT_CONVERSATIONS, payload);
    let result;
    try {
      result = await pageGateway.send(tab.id, envelope);
    } catch (error) {
      throw Object.assign(new Error("Refresh the ChatGPT page before exporting the selected conversations."), {
        tidyCode: protocol.ErrorCode.ADAPTER_UNAVAILABLE,
        stage: "service-worker.batch-export-send-message",
        cause: error,
      });
    }
    if (!protocol.isResponse(result, envelope.requestId) || !result.ok) {
      throw Object.assign(new Error(result?.error?.message || "The selected conversations could not be exported."), {
        tidyCode: result?.error?.code || protocol.ErrorCode.EXPORT_UNAVAILABLE,
        stage: result?.error?.details?.stage || "service-worker.batch-export-response",
      });
    }
    const validation = exportContract.validateCollection(result.payload);
    if (!validation.valid) {
      throw Object.assign(new Error(`Invalid export collection: ${validation.errors.join(", ")}`), {
        tidyCode: protocol.ErrorCode.EXPORT_UNAVAILABLE,
        stage: "service-worker.batch-export-validation",
      });
    }
    const requested = new Set(payload.conversationIds);
    const received = new Set(result.payload.documents.map((document) => document.conversation.id));
    if (requested.size !== received.size || [...requested].some((id) => !received.has(id))) {
      throw Object.assign(new Error("The selected conversation set changed while export data was loading."), {
        tidyCode: protocol.ErrorCode.CONTEXT_MISMATCH,
        stage: "service-worker.batch-export-identity",
      });
    }
    return result.payload;
  }

  async function requestTabExportPreview(tab, type, payload) {
    const request = protocol.request(type, payload);
    let result;
    try {
      result = await pageGateway.send(tab.id, request);
    } catch (error) {
      throw Object.assign(new Error("Refresh the ChatGPT page before opening the export preview."), {
        tidyCode: protocol.ErrorCode.ADAPTER_UNAVAILABLE,
        stage: "service-worker.export-preview-send-message",
        cause: error,
      });
    }
    if (!protocol.isResponse(result, request.requestId) || !result.ok) {
      throw Object.assign(new Error(result?.error?.message || "The export preview could not be shown."), {
        tidyCode: result?.error?.code || protocol.ErrorCode.EXPORT_UNAVAILABLE,
        stage: result?.error?.details?.stage || "service-worker.export-preview-response",
      });
    }
    return result.payload;
  }

  return Object.freeze({ current: requestCurrentConversationExport, batch: requestBatchConversationExport, preview: requestTabExportPreview });
}
