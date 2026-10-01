/**
 * 回执接收与连接等待队列。先校验 tab/id/目标，再允许栏目消费，最后记完成。
 * 错目标、重复、取消后回执不会触发提示，也不能覆盖连接期间保存的合法回执。
 */
export function createPanelNavigationCoordinator({ ownerTabId, owner, phase, consumers, onCompleted = () => {}, onCancelled = () => {}, onOpenFailed = () => {} }) {
  let pending = null;
  let consuming = null;
  function admissible(payload) {
    return payload?.tabId === ownerTabId && owner.matches(payload) && !owner.isCompleted(payload.navigationIntentId);
  }
  function receive(payload) {
    if (!admissible(payload) || consuming === payload.navigationIntentId) return false;
    if (phase() !== "ready") {
      if (!["connecting", "stalled"].includes(phase())) return false;
      if (!pending || pending.navigationIntentId !== payload.navigationIntentId) pending = { ...payload };
      return true;
    }
    const intent = owner.get();
    const consume = consumers[intent.route];
    if (typeof consume !== "function") return false;
    consuming = payload.navigationIntentId;
    try {
      if (consume(payload) !== true || !owner.complete(payload)) return false;
      pending = null;
      onCompleted(payload, intent.route);
      return true;
    } finally { consuming = null; }
  }
  function flush() {
    const result = pending; pending = null;
    return result ? receive(result) : false;
  }
  return Object.freeze({
    receive, flush, clear: () => { pending = null; },
    openFailed(payload) {
      const intent = owner.get();
      if (!intent || payload?.navigationIntentId !== intent.id || intent.completed) return false;
      pending = null;
      // OPEN 失败先撤销执行权，再显示终态反馈；后续重复 cancel 不能吞掉该反馈。
      owner.cancel(intent.id, "open-failed");
      onOpenFailed(payload, intent.route);
      return true;
    },
    cancelled(payload) {
      if (payload?.tabId !== ownerTabId || !owner.isCurrent(payload.navigationIntentId)) return false;
      if (pending?.navigationIntentId === payload.navigationIntentId) pending = null;
      owner.revoked(payload.navigationIntentId);
      onCancelled(payload);
      return true;
    },
  });
}
