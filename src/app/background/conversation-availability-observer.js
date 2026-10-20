import { isValidTabId } from "../../platform/navigation/panel-owner.js";
import { isChatgptUrl } from "../../platform/session/background/request-binding.js";
import "../../platform/protocol.js";

// 身份只由现有文档租约管理；通知仅带定位键/版本，不广播标题或摘录。
export function createConversationAvailabilityObserver({ chrome, identity, repository, broadcast }) {
  const protocol = globalThis.TidyProtocol;
  async function accept(change, sender) {
    if (!isValidTabId(sender?.tab?.id) || sender.frameId !== 0 || !sender.documentId
      || sender.documentLifecycle !== "active" || !isChatgptUrl(sender.url)
      || typeof change?.conversationId !== "string" || !/^[A-Za-z0-9_-]+$/.test(change.conversationId)
      || !["deleted", "unavailable", "available"].includes(change.status)
      || typeof change.catalogAccountKey !== "string" || !change.catalogAccountKey.trim()
      || change.catalogAccountKey !== change.catalogAccountKey.trim()
      || !Number.isFinite(change.startedAt) || change.startedAt < 0) return false;
    await identity.acceptEvent({ accountKey: change.ownerAccountKey, epoch: change.epoch, phase: "ready" }, sender);
    const isCurrent = () => {
      const current = identity.peek(sender.tab.id);
      return current?.phase === "ready" && current.documentId === sender.documentId
        && current.accountKey === change.ownerAccountKey && current.epoch === change.epoch;
    };
    if (!isCurrent()) return false;
    const saved = await repository.accept(change, isCurrent);
    if (!saved || !isCurrent()) return false;
    const notifications = [chrome.runtime.sendMessage(protocol.event(protocol.Type.CONVERSATION_CATALOG_CHANGED,
      { accountKey: saved.accountKey, conversationId: saved.conversationId })).catch(() => {})];
    for (const [kind, token] of Object.entries(saved.libraries)) {
      const event = protocol.event(kind === "favorites" ? protocol.Type.FAVORITES_UPDATED : protocol.Type.BOOKMARKS_UPDATED, token);
      notifications.push(chrome.runtime.sendMessage(event).catch(() => {}));
      void broadcast(event);
    }
    // 同批发出两个库的版本通知，便于现有面板调度器合并读取。
    await Promise.all(notifications);
    return true;
  }
  return Object.freeze({ accept });
}
