import { isValidTabId } from "../../navigation/panel-owner.js";
import { isChatgptUrl } from "./request-binding.js";
import "../../protocol.js";
import "../../snapshot.js";

const CHATGPT_URLS = ["https://chatgpt.com/*"];

/**
 * 后台与指定页面文档之间的传输边界。send 不判断业务权限或响应格式；
 * snapshot/locate 各自保留原错误契约，功能服务继续验证自己的回复。
 */
export function createPageGateway({ chrome }) {
  const protocol = globalThis.TidyProtocol;
  const snapshotContract = globalThis.TidySnapshot;

  function send(tabId, envelope, documentId = null) {
    return documentId == null ? chrome.tabs.sendMessage(tabId, envelope)
      : chrome.tabs.sendMessage(tabId, envelope, { documentId });
  }

  async function snapshot(tab, payload = null, documentId = null) {
    if (!isValidTabId(tab?.id) || !isChatgptUrl(tab.url)) {
      throw Object.assign(new Error("The active tab is not ChatGPT"), {
        tidyCode: protocol.ErrorCode.UNSUPPORTED_PAGE,
      });
    }
    const envelope = protocol.request(protocol.Type.GET_SNAPSHOT, payload);
    let result;
    try {
      result = await send(tab.id, envelope, documentId || null);
    } catch (error) {
      // Preserve transport evidence so UI distinguishes a missing page receiver
      // (F5) from a transient closed channel (local retry).
      throw Object.assign(new Error("The ChatGPT page connection is unavailable."), {
        tidyCode: protocol.ErrorCode.ADAPTER_UNAVAILABLE,
        details: { stage: "service-worker.snapshot-send-message", disconnect: protocol.runtimeDisconnectReason(error) },
        cause: error,
      });
    }
    if (!protocol.isResponse(result, envelope.requestId)) {
      throw Object.assign(new Error("The ChatGPT adapter returned an invalid response"), {
        tidyCode: protocol.ErrorCode.INVALID_ENVELOPE,
      });
    }
    if (!result.ok) {
      throw Object.assign(new Error(result.error?.message || "The ChatGPT adapter failed"), {
        tidyCode: result.error?.code || protocol.ErrorCode.ADAPTER_UNAVAILABLE,
        details: result.error?.details || null,
      });
    }
    const validation = snapshotContract.validate(result.payload);
    if (!validation.valid) {
      throw Object.assign(new Error(`Invalid snapshot: ${validation.errors.join(", ")}`), {
        tidyCode: protocol.ErrorCode.INVALID_ENVELOPE,
      });
    }
    return { tab, snapshot: result.payload };
  }

  async function locate(tab, payload, documentId = null) {
    const envelope = protocol.request(protocol.Type.LOCATE_MESSAGE, payload);
    const result = await send(tab.id, envelope, documentId);
    if (!protocol.isResponse(result, envelope.requestId) || !result.ok) {
      throw Object.assign(new Error(result?.error?.message || "The ChatGPT adapter could not locate the message"), {
        tidyCode: result?.error?.code || protocol.ErrorCode.ADAPTER_UNAVAILABLE,
      });
    }
    return result.payload;
  }

  async function broadcast(envelope) {
    const tabs = await chrome.tabs.query({ url: CHATGPT_URLS });
    await Promise.allSettled(
      tabs
        .filter((tab) => isValidTabId(tab.id))
        .map((tab) => send(tab.id, envelope)),
    );
  }

  return Object.freeze({ send, snapshot, locate, broadcast });
}
