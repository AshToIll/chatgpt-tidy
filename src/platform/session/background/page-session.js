import "../../protocol.js";

// 页面准入只证明“这个浏览器文档里的完整扩展桥仍然有效”，不读取账号或聊天内容。
// 不缓存成功：每次业务命令先做一次本机 IPC 握手，Worker 休眠不改变页面资格。
export function createPageSession({ chrome, isChatgptUrl }) {
  const protocol = globalThis.TidyProtocol;
  const stage = "service-worker.page-session";
  const unavailable = (details, cause) => Object.assign(new Error("The ChatGPT page is not connected to this extension."), {
    tidyCode: protocol.ErrorCode.ADAPTER_UNAVAILABLE, details: { stage, ...details }, ...(cause ? { cause } : {}),
  });
  const connecting = cause => unavailable({ phase: "connecting" }, cause);
  const activeFrame = frame => Boolean(frame?.documentId && frame.documentLifecycle === "active" && isChatgptUrl(frame.url));

  async function disconnected(tab, before, disconnect, cause) {
    // 调用方传来的 tab.status 是先前快照。失败后重新读取浏览器状态，避免把
    // 刚开始刷新/刚提交的新文档误当成“安装扩展前就存在的旧页面”。
    let currentTab, currentFrame;
    try {
      [currentTab, currentFrame] = await Promise.all([
        chrome.tabs.get(tab.id), chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 }),
      ]);
    } catch (error) { return connecting(error); }
    if (currentTab?.id !== tab.id || !isChatgptUrl(currentTab.url) || currentTab.status !== "complete"
      || !activeFrame(currentFrame) || currentFrame.documentId !== before.documentId) return connecting(cause);
    return unavailable({ disconnect, phase: "refresh-required", documentId: before.documentId }, cause);
  }

  async function assert(tab, { expectedDocumentId = null } = {}) {
    if (!Number.isSafeInteger(tab?.id) || tab.id < 0 || !isChatgptUrl(tab.url)) {
      throw Object.assign(new Error("Open the bound ChatGPT page."), { tidyCode: protocol.ErrorCode.UNSUPPORTED_PAGE });
    }
    let before;
    try { before = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 }); }
    catch (error) { throw connecting(error); }
    if (!activeFrame(before)) throw connecting();
    if (expectedDocumentId && expectedDocumentId !== before.documentId) {
      throw Object.assign(new Error("The requesting ChatGPT document changed."), { tidyCode: protocol.ErrorCode.CONTEXT_MISMATCH });
    }
    const envelope = protocol.request(protocol.Type.PAGE_SESSION_PROBE);
    let result;
    try { result = await chrome.tabs.sendMessage(tab.id, envelope, { documentId: before.documentId }); }
    catch (error) {
      const disconnect = protocol.runtimeDisconnectReason(error);
      // 新文档在 document_start 安装脚本前也可能没有接收器；它是等待态，不是旧页。
      // 只有已完成页面的接收器确实缺失才要求刷新，普通关闭通道可在下一次握手恢复。
      if (["receiver-missing", "context-invalidated"].includes(disconnect)) {
        throw await disconnected(tab, before, disconnect, error);
      }
      throw connecting(error);
    }
    if (!protocol.isResponse(result, envelope.requestId) || result.type !== envelope.type) throw connecting();
    if (!result.ok) {
      if (result.error?.code === protocol.ErrorCode.ADAPTER_UNAVAILABLE
        && result.error?.details?.stage === "page-session"
        && result.error.details.disconnect === "context-invalidated") {
        throw await disconnected(tab, before, "context-invalidated");
      }
      // MAIN 尚未安装或正在切换文档时不能放行；网络/账号失败不被伪装成 F5。
      throw connecting();
    }
    if (result.payload?.ready !== true) throw connecting();
    let after;
    try { after = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 }); }
    catch (error) { throw connecting(error); }
    if (!activeFrame(after) || after.documentId !== before.documentId) throw connecting();
    return Object.freeze({ ready: true, documentId: before.documentId });
  }
  return Object.freeze({ assert });
}

// 明确列出初始化和退役操作；未知协议默认不能取得业务权限。
// 这些例外不读取网页数据、不改资料，也不会重放用户的业务命令。
export function pageSessionRequestPolicy(type) {
  const T = globalThis.TidyProtocol.Type;
  if (type === T.PAGE_SESSION_PROBE) return "probe";
  if ([T.PREFERENCES_GET, T.TITLE_RULES_GET, T.NAVIGATION_CANCELLED, T.EXPORT_PREVIEW_CLOSE,
    T.EXPORT_JOB_CANCEL, T.EXPORT_JOB_DISMISS].includes(type)) return "control";
  if ([T.GET_ACTIVE_CONTEXT, T.PREFERENCES_UPDATE, T.TITLE_RULES_UPDATE, T.LIBRARY_ACCOUNT, T.LIBRARY_GET,
    T.LIBRARY_BACKUP_EXPORT, T.LIBRARY_BACKUP_PREVIEW, T.LIBRARY_BACKUP_RESTORE, T.LIBRARY_BACKUP_DISCARD,
    T.FAVORITES_GET, T.FAVORITES_TOGGLE_CURRENT, T.FAVORITES_TOGGLE_SIDEBAR, T.FAVORITES_REMOVE, T.FAVORITES_MOVE,
    T.FAVORITES_GROUP_CREATE, T.FAVORITES_GROUP_UPDATE, T.FAVORITES_GROUP_DELETE, T.FAVORITES_GROUP_REORDER,
    T.FAVORITES_VIEW_UPDATE, T.FAVORITES_OPEN, T.BOOKMARKS_GET, T.BOOKMARKS_TOGGLE_CURRENT, T.BOOKMARKS_REMOVE,
    T.BOOKMARKS_MOVE, T.BOOKMARKS_GROUP_CREATE, T.BOOKMARKS_GROUP_UPDATE, T.BOOKMARKS_GROUP_DELETE,
    T.BOOKMARKS_GROUP_REORDER, T.BOOKMARKS_VIEW_UPDATE, T.BOOKMARKS_OPEN, T.BOOKMARKS_OPEN_CONVERSATION_VIEW,
    T.SEARCH_MESSAGES, T.SEARCH_OPEN_RESULT, T.DATE_INDEX_ACCOUNT, T.DATE_INDEX_SOURCE_PAGE,
    T.EXPORT_CURRENT_CONVERSATION, T.EXPORT_CONVERSATIONS, T.EXPORT_IMAGE_RESOURCE, T.EXPORT_PREVIEW_OPEN,
    T.EXPORT_JOB_START, T.EXPORT_JOB_STATUS, T.TITLE_PREVIEW, T.TITLE_REPLAN, T.TITLE_APPLY, T.TITLE_STATUS,
    T.TITLE_RECONCILE, T.TITLE_BATCH_PREVIEW, T.TITLE_BATCH_RETRY_PREVIEW, T.TITLE_BATCH_REPLAN,
    T.TITLE_BATCH_APPLY, T.TITLE_BATCH_STEP, T.TITLE_BATCH_STATUS, T.TITLE_BATCH_RECONCILE, T.TITLE_RETURN_OWNER,
  ].includes(type)) return "business";
  return null;
}
