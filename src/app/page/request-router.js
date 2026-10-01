// MAIN bridge 入站准入及请求分派：先同步验文档/source/origin/channel，再执行专属适配器。
(function initTidyPageRequestRouter(global) {
  "use strict";
  if (global.TidyPageRequestRouter) return;
  // 标题失败只透传固定检查点和 HTTP 状态；绝不把服务器文本、账号或正文带出网页。
  // stage 字面量同时供诊断构建索引采集，白名单只在此处维护。
  const TITLE_FAILURE_STAGES = new Set([
    { stage: "main-world.title.metadata.http" },
    { stage: "main-world.title.metadata.conversation-id" },
    { stage: "main-world.title.metadata.title-shape" },
    { stage: "main-world.title.metadata.project-match" },
    { stage: "main-world.title.metadata.read-only" },
    { stage: "main-world.title.metadata.temporary" },
    { stage: "main-world.title.metadata.owner-shape" },
    { stage: "main-world.title.metadata.owner-match" },
  ].map(({ stage }) => stage));
  function titleFailureDetails(error) {
    const status = error?.httpStatus;
    return {
      status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
      stage: TITLE_FAILURE_STAGES.has(error?.stage) ? error.stage : null,
    };
  }
  function create({ readSnapshot: buildSnapshot, publishSnapshot, postEnvelope, navigation,
    routeStillOwnsConversation, searchAdapter, dateIndexAdapter, exportAdapter, titleAdapter, titleProjection: titleSync }) {
    const protocol = global.TidyProtocol;
    const session = global.TidyPageSession;
    function assertSnapshotLibraryIdentity(expected) {
      const identity = global.TidyChatgptApi.checkLibraryIdentity();
      if (!expected || typeof expected.accountKey !== "string" || !expected.accountKey
        || !Number.isSafeInteger(expected.epoch) || expected.epoch < 0
        || identity.phase !== "ready" || identity.accountKey !== expected.accountKey || identity.epoch !== expected.epoch) {
        throw Object.assign(new Error("The snapshot no longer belongs to the expected library identity."), {
          tidyCode: protocol.ErrorCode.CONTEXT_MISMATCH,
        });
      }
    }

    function handleMessage(event) {
      if (!session.check()) return;
      if (event.source !== global || event.origin !== global.location.origin) return;
      const data = event.data;
      if (data?.channel !== protocol.WINDOW_CHANNEL || data?.source !== "chatgpt-isolated") return;
      const envelope = data.envelope;
      if (!protocol.isRequest(envelope)) return;
      try {
        if (envelope.type === protocol.Type.PAGE_SESSION_PROBE) {
          postEnvelope(protocol.response(envelope, { ready: true }));
        } else if (envelope.type === protocol.Type.GET_SNAPSHOT) {
          // This narrow projection is requested only by title preflight. Ordinary
          // snapshots, broadcasts, search and export retain their full payload.
          const titleOwnerOnly = envelope.payload?.scope === "title-owner";
          const libraryStamped = Object.prototype.hasOwnProperty.call(envelope.payload || {}, "expectedLibraryIdentity");
          if (libraryStamped) assertSnapshotLibraryIdentity(envelope.payload.expectedLibraryIdentity);
          const snapshot = buildSnapshot({ titleOwnerOnly, nativeTitles: titleOwnerOnly });
          if (libraryStamped) assertSnapshotLibraryIdentity(envelope.payload.expectedLibraryIdentity);
          postEnvelope(protocol.response(envelope, snapshot));
        } else if (envelope.type === protocol.Type.NAVIGATION_INTENT) {
          postEnvelope(protocol.response(envelope, navigation.observe(envelope.payload)));
        } else if (envelope.type === protocol.Type.LOCATE_MESSAGE) {
          const result = navigation.locateMessage(envelope.payload);
          postEnvelope(protocol.response(envelope, result));
        } else if (envelope.type === protocol.Type.SEARCH_MESSAGES) {
          searchAdapter.search(envelope.payload)
            .then((page) => postEnvelope(protocol.response(envelope, page)))
            .catch((error) => {
              postEnvelope(protocol.failure(
                envelope,
                protocol.ErrorCode.SEARCH_UNAVAILABLE,
                error?.name === "AbortError"
                  ? "The search request was superseded"
                  : "The official ChatGPT search interface is unavailable",
                { stage: "main-world.search-adapter" },
              ));
            });
        } else if (envelope.type === protocol.Type.LIBRARY_NAVIGATE) {
          Promise.resolve().then(() => {
            session.assertActive();
            return navigation.navigate(envelope.payload);
          }).then(result => postEnvelope(protocol.response(envelope, result)))
            .catch(error => postEnvelope(protocol.failure(envelope,
              error?.tidyCode || protocol.ErrorCode.CONTEXT_MISMATCH,
              "The saved conversation could not be opened in this page.")));
        } else if (envelope.type === protocol.Type.LIBRARY_ACCOUNT) {
          Promise.resolve().then(() => global.TidyChatgptApi.readLibraryAccount({ retry: envelope.payload?.retry === true }))
            .then(account => postEnvelope(protocol.response(envelope, account)))
            .catch(error => postEnvelope(protocol.failure(
              envelope, error?.tidyCode || "LIBRARY_ACCOUNT_UNAVAILABLE",
              "The signed-in library owner could not be verified.",
              { status: Number.isInteger(error?.status) ? error.status : null },
            )));
        } else if ([
          protocol.Type.DATE_INDEX_ACCOUNT,
          protocol.Type.DATE_INDEX_SOURCE_PAGE,
        ].includes(envelope.type)) {
          const operation = envelope.type === protocol.Type.DATE_INDEX_ACCOUNT
            ? dateIndexAdapter.account()
            : dateIndexAdapter.readSourcePage(envelope.payload);
          operation
            .then((payload) => postEnvelope(protocol.response(envelope, payload)))
            .catch((error) => postEnvelope(protocol.failure(
              envelope,
              protocol.ErrorCode.DATE_INDEX_UNAVAILABLE,
              error?.message || "The message date index could not be read",
              {
                stage: "main-world.date-index-adapter",
                code: error?.code || "SCHEMA",
                category: error?.category || "SCHEMA",
                status: error?.status ?? null,
                retryable: error?.retryable === true,
                serverCode: error?.serverCode || null,
              },
            )));
        } else if ([protocol.Type.TITLE_READ_CURRENT, protocol.Type.TITLE_WRITE_CURRENT,
          protocol.Type.TITLE_BATCH_EXECUTION_BEGIN, protocol.Type.TITLE_BATCH_EXECUTION_END].includes(envelope.type)) {
          const operation = {
            [protocol.Type.TITLE_READ_CURRENT]: "readCurrent",
            [protocol.Type.TITLE_WRITE_CURRENT]: "writeCurrent",
            [protocol.Type.TITLE_BATCH_EXECUTION_BEGIN]: "beginBatchExecution",
            [protocol.Type.TITLE_BATCH_EXECUTION_END]: "endBatchExecution",
          }[envelope.type];
          Promise.resolve().then(() => {
            session.assertActive();
            if (!titleAdapter) throw new Error("The title adapter is unavailable.");
            return titleAdapter[operation](envelope.payload);
          })
            .then((result) => {
              session.assertActive();
              // Accepted batch writes update only the exact confirmed title;
              // preflight timestamps must not masquerade as post-write metadata.
              // Unknown outcomes never project a title or trigger a refetch.
              const accepted = operation === "writeCurrent" && result.status === "accepted"
                && result.accepted?.conversationId === envelope.payload.conversationId
                && result.accepted.title === envelope.payload.after;
              const observed = accepted ? result.accepted
                : result.current && (operation === "readCurrent" || result.status === "verified") ? result.current : null;
              if (observed) {
                try {
                  const native = buildSnapshot({ nativeTitles: true, titleOwnerOnly: true }).conversation;
                  const synchronize = accepted ? titleSync?.acceptTitle : titleSync?.accept;
                  if (synchronize?.(observed, result.identity || envelope.payload.identity,
                    envelope.payload.before, native?.conversationId === observed.conversationId ? native : null,
                    { ownerContext: envelope.payload.ownerContext, targetProjectId: envelope.payload.targetProjectId })) {
                    publishSnapshot(accepted ? "title-accepted" : "title-readback");
                  }
                } catch { /* A presentation failure must not turn success into an unknown write. */ }
              }
              postEnvelope(protocol.response(envelope, result));
            })
            .catch((error) => postEnvelope(protocol.failure(
              envelope, error?.tidyCode || protocol.ErrorCode.TITLE_UNAVAILABLE,
              "The title operation could not be completed.",
              titleFailureDetails(error),
            )));
        } else if (envelope.type === protocol.Type.EXPORT_CURRENT_CONVERSATION) {
          exportAdapter.readCurrentConversation(envelope.payload, {
            routeOwnsConversation: routeStillOwnsConversation,
          })
            .then((document) => postEnvelope(protocol.response(envelope, document)))
            .catch((error) => {
              postEnvelope(protocol.failure(
                envelope,
                error?.tidyCode === protocol.ErrorCode.EXPORT_RESPONSE_PENDING
                  ? protocol.ErrorCode.EXPORT_RESPONSE_PENDING : protocol.ErrorCode.EXPORT_UNAVAILABLE,
                error?.message || "The current conversation could not be exported",
                { stage: "main-world.export-adapter" },
              ));
            });
        } else if (envelope.type === protocol.Type.EXPORT_IMAGE_RESOURCE) {
          exportAdapter.readImageResource(envelope.payload)
            .then((resource) => postEnvelope(protocol.response(envelope, resource)))
            .catch(() => postEnvelope(protocol.failure(envelope, protocol.ErrorCode.EXPORT_UNAVAILABLE,
              "The export image is no longer available.")));
        } else if (envelope.type === protocol.Type.EXPORT_CONVERSATIONS) {
          exportAdapter.readConversations(envelope.payload)
            .then((collection) => postEnvelope(protocol.response(envelope, collection)))
            .catch((error) => {
              postEnvelope(protocol.failure(
                envelope,
                error?.tidyCode === protocol.ErrorCode.EXPORT_RESPONSE_PENDING
                  ? protocol.ErrorCode.EXPORT_RESPONSE_PENDING : protocol.ErrorCode.EXPORT_UNAVAILABLE,
                error?.message || "The selected conversations could not be exported",
                { stage: "main-world.export-batch-adapter" },
              ));
            });
        }
      } catch (error) {
        postEnvelope(protocol.failure(envelope, error?.tidyCode || protocol.ErrorCode.INTERNAL_ERROR, error.message));
      }
    }


    return Object.freeze({ handleMessage });
  }
  global.TidyPageRequestRouter = Object.freeze({ create });
})(globalThis);
