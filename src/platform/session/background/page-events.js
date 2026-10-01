import { isValidTabId } from "../../navigation/panel-owner.js";
import { isChatgptUrl } from "./request-binding.js";
import "../../protocol.js";
import "../../snapshot.js";

// Page observations reuse the identity owner's document cache, never an account/network probe.
export function createPageEvents({ chrome, identity }) {
  const protocol = globalThis.TidyProtocol;
  const snapshotContract = globalThis.TidySnapshot;
  const libraryDocument = identity.document;
  const libraryIdentity = identity;
  function snapshot(envelope, sender) {
        const snapshot = envelope.payload?.snapshot;
        if (!isValidTabId(sender.tab?.id) || sender.frameId !== 0 || !sender.documentId
          || sender.documentLifecycle !== "active" || !isChatgptUrl(sender.url)
          || !sender.url.startsWith("https://chatgpt.com/") || !snapshotContract.validate(snapshot).valid) return false;
        // 复用身份所有者已有的文档缓存；Worker 冷启动仅查询本机 getFrame，
        // 不读取账号、不发 HTTP，也不为每条流式快照重新探测浏览器文档。
        void libraryDocument(sender.tab).then(document => {
          if (document?.documentId !== sender.documentId
            || libraryIdentity.peek(sender.tab.id)?.documentId !== sender.documentId) return;
          return chrome.runtime.sendMessage(protocol.event(protocol.Type.SNAPSHOT_UPDATED, {
            tabId: sender.tab.id,
            snapshot,
            reason: typeof envelope.payload?.reason === "string" ? envelope.payload.reason : "adapter-event",
          }));
        }).catch(() => {});
    return false;
  }
  function previewClosed(envelope, sender) {
    if (!isValidTabId(sender.tab?.id)) return;
    // Content reports only an opaque session; the browser sender provides tab ownership.
    chrome.runtime.sendMessage(protocol.event(protocol.Type.EXPORT_PREVIEW_CLOSED, {
      tabId: sender.tab.id, sessionId: envelope.payload?.sessionId || null,
    })).catch(() => {});
  }

  return Object.freeze({ snapshot, previewClosed });
}
