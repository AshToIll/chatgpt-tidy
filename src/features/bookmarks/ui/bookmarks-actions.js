import "../../../platform/protocol.js";

const protocol = globalThis.TidyProtocol;
const TYPES = Object.freeze({
  remove: protocol.Type.BOOKMARKS_REMOVE,
  move: protocol.Type.BOOKMARKS_MOVE,
  "group-create": protocol.Type.BOOKMARKS_GROUP_CREATE,
  "group-update": protocol.Type.BOOKMARKS_GROUP_UPDATE,
  "group-delete": protocol.Type.BOOKMARKS_GROUP_DELETE,
  "group-reorder": protocol.Type.BOOKMARKS_GROUP_REORDER,
  "view-update": protocol.Type.BOOKMARKS_VIEW_UPDATE,
});

/**
 * 书签操作不读取整个面板状态：只捕获本次资料归属和当前会话 ID。
 * acceptMutation 已固定为 bookmarks；打开流程交给唯一的书签导航所有者，
 * 不在这里复制导航选中、取消、完成回执或错误提示状态。
 */
export function createBookmarksActions({
  ownerTabId, isReady, captureOwner, isOwnerCurrent, acceptMutation, refresh,
  request, toast, readCurrentConversationId, startNavigation,
}) {
  async function handle(action, payload = {}) {
    if (!isReady()) return;
    if (action === "open") {
      const owner = captureOwner();
      if (!owner.accountKey) { await refresh(); return; }
      await startNavigation({
        bookmarkId: payload.bookmarkId, owner,
        sourceConversationId: readCurrentConversationId(),
      });
      return;
    }
    if (!Object.hasOwn(TYPES, action)) return;
    const owner = captureOwner();
    if (!owner.accountKey) { await refresh(); return; }
    const requestPayload = {
      ...payload,
      expectedTabId: ownerTabId,
      expectedAccountKey: owner.accountKey,
      expectedIdentity: owner.identity,
    };
    try {
      const result = await request(TYPES[action], requestPayload);
      if (!isOwnerCurrent(owner)) return;
      if (!acceptMutation(owner, result)) return;
      const key = {
        remove: "bookmarkRemoved", move: "bookmarkMoved",
        "group-create": "groupCreated", "group-update": "groupUpdated",
        "group-delete": "bookmarkGroupDeleted", "group-reorder": "groupUpdated",
      }[action];
      if (key) toast(key);
    } catch (error) {
      if (!isOwnerCurrent(owner)) return;
      // 后端在落库前明确拒绝的非法值，不应被描述成保存结果未知。
      // 空名称已在表单就近拦截；其他校验错误保留通用的短暂反馈。
      const rejected = error.code === protocol.ErrorCode.VALIDATION_ERROR;
      toast(error.code === protocol.ErrorCode.CONTEXT_MISMATCH ? "contextChanged"
        : rejected ? "actionFailed" : "libraryChangeUnknown", true, {}, {
        cause: error, ...(rejected ? { owner: "bookmarks", durationMs: 5000 } : {}),
      });
      await refresh();
    }
  }
  return Object.freeze({ handle });
}
