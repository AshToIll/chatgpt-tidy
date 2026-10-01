import "../../../platform/protocol.js";

const protocol = globalThis.TidyProtocol;
const TYPES = Object.freeze({
  "toggle-current": protocol.Type.FAVORITES_TOGGLE_CURRENT,
  remove: protocol.Type.FAVORITES_REMOVE,
  move: protocol.Type.FAVORITES_MOVE,
  "group-create": protocol.Type.FAVORITES_GROUP_CREATE,
  "group-update": protocol.Type.FAVORITES_GROUP_UPDATE,
  "group-delete": protocol.Type.FAVORITES_GROUP_DELETE,
  "group-reorder": protocol.Type.FAVORITES_GROUP_REORDER,
  "view-update": protocol.Type.FAVORITES_VIEW_UPDATE,
  open: protocol.Type.FAVORITES_OPEN,
});

/**
 * 收藏操作只接收所需能力，不拥有面板状态、资料缓存或导航任务。
 * readCurrentConversation 返回同一时刻的 { conversationId, isFavorite }；
 * acceptMutation 已由装配层固定为 favorites，不能写入别的资料模块。
 */
export function createFavoritesActions({
  ownerTabId, isReady, captureOwner, isOwnerCurrent, acceptMutation, refresh,
  request, toast, readCurrentConversation, beginNavigation, isNavigationCurrent,
  isNavigationCompleted,
}) {
  async function handle(action, payload = {}) {
    if (!isReady() || !Object.hasOwn(TYPES, action)) return;
    const owner = captureOwner();
    if (!owner.accountKey) { await refresh(); return; }
    const current = readCurrentConversation();
    const currentId = current.conversationId || null;
    const wasFavorite = Boolean(currentId && current.isFavorite);
    // 点击时冻结目标和归属；后续异步快照不能改写这次操作的地址。
    const requestPayload = {
      ...payload,
      expectedTabId: ownerTabId,
      expectedAccountKey: owner.accountKey,
      expectedIdentity: owner.identity,
      ...(action === "open" ? { navigationIntentId: beginNavigation({
        conversationId: payload.conversationId, placement: "latest",
      }) } : {}),
      ...(action === "toggle-current" ? { expectedConversationId: currentId } : {}),
    };
    try {
      const result = await request(TYPES[action], requestPayload);
      if (action === "open" && !isNavigationCurrent(requestPayload.navigationIntentId)) return;
      if (!isOwnerCurrent(owner)) return;
      if (action !== "open" && !acceptMutation(owner, result)) return;
      const messageKey = {
        "toggle-current": wasFavorite ? "favoriteRemoved" : "favoriteAdded",
        remove: "favoriteRemoved", move: "favoriteMoved",
        "group-create": "groupCreated", "group-update": "groupUpdated",
        "group-delete": "groupDeleted", "group-reorder": "groupUpdated",
      }[action];
      if (messageKey) toast(messageKey);
    } catch (error) {
      // 完成回执可能早于 OPEN 的传输拒绝；已完成/被替换的任务不能再报失败。
      if (action === "open" && (!isNavigationCurrent(requestPayload.navigationIntentId)
        || isNavigationCompleted(requestPayload.navigationIntentId))) return;
      if (!isOwnerCurrent(owner)) return;
      // 校验已在落库前明确拒绝，不是结果未知；名称空白由表单就近拦截，其他非法值不冒充空名。
      const rejected = action !== "open" && error.code === protocol.ErrorCode.VALIDATION_ERROR;
      const key = error.code === protocol.ErrorCode.CONTEXT_MISMATCH
        ? "contextChanged"
        : error.code === protocol.ErrorCode.PERSISTENCE_REJECTED
          ? "favoriteUnavailable"
          : rejected ? "actionFailed" : action === "open" ? "bookmarkOpenFailed" : "libraryChangeUnknown";
      // 导航读取失败和确定性校验拒绝短暂提示；真正写入未知仍保留原有持久提示。
      toast(key, true, {}, { cause: error, navigationIntentId: requestPayload.navigationIntentId,
        ...(action === "open" || rejected ? { owner: "favorites", durationMs: 5000 } : {}) });
      await refresh();
    }
  }
  return Object.freeze({ handle });
}
