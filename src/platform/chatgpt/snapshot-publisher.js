// 快照发布唯一所有者：指纹去重、有界事件合并、最多六轮绑定重试；不读取原生证据。
(function initTidyChatgptSnapshotPublisher(global) {
  "use strict";
  if (global.TidyChatgptSnapshotPublisher) return;
  function create({ readSnapshot: buildSnapshot, postEnvelope }) {
    const protocol = global.TidyProtocol;
    const session = global.TidyPageSession;
    let lastFingerprint = "";
    let refreshTimer = null;
    let pendingRefresh = null;
    let retryTimer = null;
    let retryAttempt = 0;
    let disposed = false;
    function fingerprint(snapshot) {
      return JSON.stringify({
        path: snapshot.route.pathname,
        appearance: snapshot.appearance.colorScheme,
        surface: snapshot.appearance.surface.value,
        id: snapshot.conversation.conversationId,
        draft: snapshot.conversation.draftId,
        status: snapshot.conversation.identityStatus,
        binding: snapshot.conversation.bindingStatus,
        title: snapshot.conversation.title.value,
        project: snapshot.conversation.project?.projectId,
        created: snapshot.conversation.createdAt.value,
        updated: snapshot.conversation.updatedAt.value,
        responseInProgress: snapshot.adapter.responseInProgress,
        sidebar: snapshot.sidebarConversations.map((conversation) => [
          conversation.conversationId,
          conversation.bindingStatus,
          conversation.createdAt.value,
          conversation.updatedAt.value,
          conversation.locator.value,
        ]),
        messages: snapshot.messages.map((message) => [
          message.messageId,
          message.idStatus,
          message.presentationStatus,
          message.timestamp.value,
          message.order.displayNumber,
          message.excerpt.value,
        ]),
      });
    }

    function cancelRefresh() {
      clearTimeout(refreshTimer);
      refreshTimer = null;
      pendingRefresh = null;
    }

    function publishSnapshot(reason) {
      // 显式读取和绑定重试都会获取此刻的完整快照，已覆盖待发窗口，
      // 因此不应再留下一个重复读取，也不能让已排队的旧回调抢先发布。
      cancelRefresh();
      if (disposed || !session.check()) return;
      const snapshot = buildSnapshot();
      const nextFingerprint = fingerprint(snapshot);
      if (nextFingerprint !== lastFingerprint) {
        lastFingerprint = nextFingerprint;
        postEnvelope(protocol.event(protocol.Type.SNAPSHOT_UPDATED, { reason, snapshot }));
      }

      clearTimeout(retryTimer);
      if (snapshot.adapter.retryable && retryAttempt < 6) {
        const delay = Math.min(350 * 2 ** retryAttempt, 4_000);
        retryAttempt += 1;
        retryTimer = setTimeout(() => publishSnapshot("bounded-retry"), delay);
      } else if (!snapshot.adapter.retryable) {
        retryAttempt = 0;
      }
    }

    function scheduleRefresh(reason, delay = 120) {
      if (disposed || !session.check()) return;
      // A cheap cookie comparison detects workspace changes without turning
      // ordinary DOM updates or SPA navigation into authentication requests.
      global.TidyChatgptApi.checkLibraryIdentity();
      // 产品参数：普通 DOM 变化在首个事件后最多等 120ms，而不是每次
      // 变化都重新等 120ms；持续输出不能饿死“正在回复”状态通知。
      // 0/30ms 的元数据、路由等请求可提前发布，但任何后来事件都不能
      // 后推已有期限。reason 记录决定该期限的请求，快照读取全部最新状态。
      const deadline = Date.now() + delay;
      if (pendingRefresh && pendingRefresh.deadline <= deadline) return;
      cancelRefresh();
      const request = { reason, deadline };
      pendingRefresh = request;
      refreshTimer = setTimeout(() => {
        if (pendingRefresh !== request) return;
        publishSnapshot(request.reason);
      }, delay);
    }


    function dispose() {
      disposed = true;
      cancelRefresh(); clearTimeout(retryTimer);
      retryTimer = null; lastFingerprint = "";
    }
    return Object.freeze({ publish: publishSnapshot, schedule: scheduleRefresh,
      resetRetry: () => { retryAttempt = 0; }, dispose });
  }
  global.TidyChatgptSnapshotPublisher = Object.freeze({ create });
})(globalThis);
