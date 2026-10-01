/**
 * Bookmark view adapter: one explicit OPEN, one worker completion receipt.
 * The worker owns navigation/loading/document handoff; this view owns selection
 * and cancellation only. No LOCATE pump, identity renewal or snapshot timer.
 */
export function createBookmarkNavigation({ isActive, isOwnerCurrent, isIntentCurrent,
  getBookmark, open, createIntentId, onCancel = () => {}, onSelected = () => {}, onResult = () => {} }) {
  let current = null, disposed = false;
  function cancel(reason = "cancelled") {
    const previous = current;
    current = null;
    if (previous) onCancel(previous.target, reason);
  }
  function valid(intent) {
    return current === intent && !disposed && isActive() && isIntentCurrent(intent.target.navigationIntentId);
  }
  function complete(result) {
    const intent = current;
    if (!intent || !valid(intent) || intent.completed || result?.navigationIntentId !== intent.target.navigationIntentId
      || result.conversationId !== intent.target.conversationId || result.messageId !== intent.target.messageId
      || typeof result.located !== "boolean") return false;
    intent.completed = true;
    onResult(result);
    return true;
  }
  async function start({ bookmarkId, owner, sourceConversationId = null }) {
    cancel("superseded");
    const item = getBookmark(bookmarkId);
    if (disposed || !isActive() || !isOwnerCurrent(owner) || !owner?.accountKey || !owner.identity?.documentId
      || !item?.conversationId || !item?.messageId) return false;
    const target = Object.freeze({ bookmarkId, conversationId: item.conversationId, messageId: item.messageId,
      navigationIntentId: createIntentId() });
    // 是否跨会话在点击时确定，不能随中途快照改变。新页面可能先报账号就绪，
    // 随后重新确认工作区；这段过程仍属于同一次打开，不是两次独立的加载。
    const intent = { target, completed: false, crossConversation: target.conversationId !== sourceConversationId };
    current = intent;
    onSelected(bookmarkId);
    try {
      const result = await open(target, owner);
      if (!valid(intent)) return false;
      if (result?.bookmarkId !== bookmarkId || result.conversationId !== target.conversationId
        || result.messageId !== target.messageId || result.navigationIntentId !== target.navigationIntentId) {
        throw new Error("The bookmark OPEN receipt does not match its command.");
      }
      return true; // pending/settling is not a successful location
    } catch (error) {
      if (valid(intent) && !intent.completed) {
        onResult({ located: false, reason: "open-failed", error });
        cancel("open-failed");
      }
      return false;
    }
  }
  return Object.freeze({ start, complete, cancel,
    // 这里只控制行内进度/必要时的等待画面，不保留旧账号权限。
    pendingBookmarkId: () => current && valid(current) && !current.completed ? current.target.bookmarkId : null,
    pendingConversationId: () => current && valid(current) && !current.completed && current.crossConversation
      ? current.target.conversationId : null,
    acceptsSnapshot: snapshot => Boolean(current && valid(current)
      && snapshot?.conversation?.conversationId === current.target.conversationId),
    cancelId(id, reason = "cancelled") { if (current?.target.navigationIntentId === id) cancel(reason); },
    dispose() { disposed = true; cancel(); } });
}
