/**
 * 当前网页快照的唯一 owner。只暴露只读模型和命令；任何过期读回都不能覆盖新路由。
 * 资料库身份、栏目路由、页面准入分别由其他 owner 持有，不复制进这里。
 */
export function createPanelContextController({ ownerTabId, isReady, isValidTabId, routeKey, request,
  contextType, errorCodes, acceptsSnapshot = () => false, onRequestedRoute = () => {}, onChanged = () => {} }) {
  let generation = 0;
  let model = Object.freeze({ snapshot: null, routeKey: null, error: null });
  const publish = (patch, reason) => { model = Object.freeze({ ...model, ...patch }); onChanged(model, reason); };
  async function refresh({ expectedRouteKey = null } = {}) {
    if (!isReady()) return false;
    const operation = ++generation;
    publish({ error: null }, "loading");
    try {
      if (!isValidTabId(ownerTabId)) throw Object.assign(new Error("The Side Panel owner is invalid."), { code: errorCodes.TAB_UNAVAILABLE });
      const context = await request(contextType, { expectedTabId: ownerTabId });
      if (operation !== generation) return false;
      if (!isValidTabId(context?.tab?.id) || context.tab.id !== ownerTabId) {
        throw Object.assign(new Error("The Side Panel tab binding changed."), { code: errorCodes.TAB_UNAVAILABLE });
      }
      const nextRouteKey = routeKey(ownerTabId, context.snapshot);
      if (expectedRouteKey && nextRouteKey !== expectedRouteKey && !acceptsSnapshot(context.snapshot)) return false;
      // 先提交模型，再处理用户请求的栏目；栏目看不到上一个会话的快照。
      model = Object.freeze({ snapshot: context.snapshot, routeKey: nextRouteKey, error: null });
      if (context.requestedRoute) onRequestedRoute(context.requestedRoute);
      return true;
    } catch (error) {
      if (operation !== generation) return false;
      model = Object.freeze({ snapshot: null, routeKey: null, error: {
        code: error.code, message: error.message, details: error.details || null,
        ...(error.requestId ? { requestId: error.requestId } : {}),
      } });
      return false;
    } finally {
      if (operation === generation) onChanged(model, "settled");
    }
  }
  function acceptSnapshot(payload) {
    if (payload?.tabId !== ownerTabId || !payload.snapshot) return false;
    const nextRouteKey = routeKey(ownerTabId, payload.snapshot);
    if (model.routeKey && nextRouteKey !== model.routeKey && !acceptsSnapshot(payload.snapshot)) return false;
    generation += 1;
    publish({ snapshot: payload.snapshot, routeKey: nextRouteKey, error: null }, "snapshot");
    return true;
  }
  return Object.freeze({
    get: () => model, refresh, acceptSnapshot,
    invalidate(payload) {
      generation += 1;
      publish({ snapshot: null, routeKey: payload?.url ? routeKey(ownerTabId, payload.url) : null, error: null }, "invalidated");
    },
    suspend() { generation += 1; publish({ snapshot: null }, "suspended"); },
    fail(error) {
      generation += 1;
      publish({ snapshot: null, error: { code: error?.code || errorCodes.INTERNAL_ERROR, message: error?.message || "",
        ...(error?.requestId ? { requestId: error.requestId } : {}) } }, "failed");
    },
    dispose() { generation += 1; },
  });
}
