/**
 * 搜索用例适配器：关键词读网页，日期读目录；不持有视图/账号/结果列表。
 * 原生搜索交接回执只结束提示权限，不谎称完成定位。
 */
export function createSearchActions({ ownerTabId, protocol, isReady, request, dateSearch, pauseTitleCatalog,
  navigation, notice }) {
  async function handle(action, payload = {}) {
    if (action === "cancel-navigation") return navigation.cancel(payload.navigationIntentId, payload.reason);
    if (action === "pause") return dateSearch.pause(payload.reason);
    if (!isReady()) return null;
    if (action === "resume") { await pauseTitleCatalog(); return dateSearch.resume(); }
    if (action === "refresh-catalog") { await pauseTitleCatalog(); return dateSearch.refreshCatalog(); }
    if (action === "query") {
      if (payload.mode === "date") { await pauseTitleCatalog(); return dateSearch.queryDate(payload); }
      if (payload.mode !== "keyword") throw new TypeError("An explicit search mode is required");
      void dateSearch.pause("keyword-query");
      return request(protocol.Type.SEARCH_MESSAGES, {
        query: payload.query, cursor: payload.cursor, sessionId: payload.sessionId,
        limit: payload.limit, expectedTabId: ownerTabId,
      });
    }
    if (action === "open") {
      if (!navigation.setTarget(payload.navigationIntentId, {
        conversationId: payload.conversationId, messageId: payload.messageId,
        ...(payload.navigationKind === "conversation" ? { placement: "latest" } : {}),
      })) return null;
      notice.beginSearchNotice(payload.navigationIntentId);
      try {
        const result = await request(protocol.Type.SEARCH_OPEN_RESULT, {
          navigationIntentId: payload.navigationIntentId, navigationKind: payload.navigationKind,
          resultId: payload.resultId, conversationId: payload.conversationId,
          messageId: payload.messageId, query: payload.query, expectedTabId: ownerTabId,
        });
        if (result?.navigated === true && result.presentationOwner === "native") notice.finishSearchNotice(payload.navigationIntentId);
        return result;
      } catch (error) {
        if (navigation.isCurrent(payload.navigationIntentId) && !navigation.isCompleted(payload.navigationIntentId)) {
          notice.showSearchToast(error.code === protocol.ErrorCode.CONTEXT_MISMATCH ? "contextChanged" : "actionFailed", payload.navigationIntentId, error);
        }
        throw error;
      }
    }
    return null;
  }
  return Object.freeze({ handle });
}
