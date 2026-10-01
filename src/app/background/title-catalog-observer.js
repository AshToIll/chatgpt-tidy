import { isValidTabId } from "../../platform/navigation/panel-owner.js";
import { isChatgptUrl } from "../../platform/session/background/request-binding.js";
import "../../platform/protocol.js";

/**
 * 外部改名只投影已经完成的一条结果；不创建计划、不刷新目录、不缓存第二份账号。
 * 身份判断复用唯一 identity 所有者，并在存储提交及广播前持续核验原文档。
 */
export function createTitleCatalogObserver({ chrome, identity, repository }) {
  const protocol = globalThis.TidyProtocol;
  async function accept(change, sender) {
    if (!isValidTabId(sender?.tab?.id) || sender.frameId !== 0 || !sender.documentId
      || sender.documentLifecycle !== "active" || !isChatgptUrl(sender.url)
      || typeof change?.conversationId !== "string" || !/^[A-Za-z0-9_-]+$/.test(change.conversationId)
      || typeof change?.title !== "string" || !change.title.trim() || change.title.length > 4096
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
    const saved = await repository.acceptTitleChange(change.catalogAccountKey,
      { conversationId: change.conversationId, title: change.title, startedAt: change.startedAt }, isCurrent);
    if (saved && isCurrent()) {
      // 广播仅含定位键；各侧栏按自己的目录账号读取该条，不广播用户标题。
      await chrome.runtime.sendMessage(protocol.event(protocol.Type.TITLE_CATALOG_CHANGED, {
        accountKey: change.catalogAccountKey, conversationId: change.conversationId,
      })).catch(() => {});
    }
    return saved;
  }

  return Object.freeze({ accept });
}
