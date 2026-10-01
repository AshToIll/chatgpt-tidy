/**
 * 每个侧栏只有一个导航意图。worker 是执行权威；这里保存取消权与精确回执目标。
 * 完成不会撤销取消权：离开栏目仍须通知 worker 停止后续落稳/官方路由观察。
 */
export function createPanelNavigationOwner({ createId, cancel, onChanged = () => {} }) {
  let current = null;
  function changed() { onChanged(current ? Object.freeze({ ...current }) : null); }
  function revoke(id, reason, notify = true) {
    if (!current || current.id !== id) return false;
    current = null;
    changed();
    if (notify) cancel(id, reason);
    return true;
  }
  function normalizeTarget(target) {
    if (!target || typeof target.conversationId !== "string" || !target.conversationId) return null;
    return Object.freeze({
      conversationId: target.conversationId,
      messageId: typeof target.messageId === "string" && target.messageId ? target.messageId : null,
      ...(typeof target.placement === "string" ? { placement: target.placement } : {}),
    });
  }
  function matches(result) {
    const target = current?.target;
    return Boolean(current && target && result?.navigationIntentId === current.id
      && typeof result.located === "boolean" && result.conversationId === target.conversationId
      && ((result.messageId ?? null) === target.messageId)
      && (!target.placement || result.placement === target.placement));
  }
  return Object.freeze({
    begin(route, target = null) {
      const previous = current;
      const next = { id: createId(), route, target: normalizeTarget(target), completed: false };
      current = next;
      changed();
      if (previous) cancel(previous.id, "superseded");
      return next.id;
    },
    setTarget(id, target) {
      if (!current || current.id !== id || current.completed) return false;
      const normalized = normalizeTarget(target);
      if (!normalized) return false;
      // 目标只能登记一次。同一 id 不能被后来的快照/点击改写成另一段会话。
      if (current.target) return JSON.stringify(current.target) === JSON.stringify(normalized);
      current = { ...current, target: normalized };
      changed();
      return true;
    },
    get: () => current ? Object.freeze({ ...current }) : null,
    matches,
    complete(result) {
      if (!matches(result) || current.completed) return false;
      current = { ...current, completed: true };
      changed();
      return true;
    },
    isCompleted: id => Boolean(current && current.id === id && current.completed),
    isCurrent: id => Boolean(current && current.id === id),
    cancel: (id, reason = "cancelled") => revoke(id, reason),
    revoked: id => revoke(id, "cancelled", false),
    leave(route) { if (current && current.route !== route) revoke(current.id, "module-left"); },
    close(reason = "panel-hidden") { if (current) revoke(current.id, reason); },
  });
}
