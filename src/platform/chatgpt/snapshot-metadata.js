// 当前会话元数据投影唯一所有者：有界缓存、单次scope请求与轻量编号；不保存正文。
(function initTidyChatgptSnapshotMetadata(global) {
  "use strict";
  if (global.TidyChatgptSnapshotMetadata) return;
  function create({ routeStillOwnsConversation, onChanged }) {
    const routeAdapter = global.TidyChatgptRoute;
    const bindingAdapter = global.TidyChatgptBinding;
    const session = global.TidyPageSession;
    const document = global.document;
    const currentMetadataCache = new Map();
    const currentMetadataRequests = new Map();
    let currentMetadataScope = { key: null, workspace: null, failed: false, numberAttempts: new Set() };
    let currentMessageNumbers = null;
    let disposed = false;
    // 产品参数：只保留 8 个会话的 30 秒日期投影；失败不靠 DOM 变化重试。
    const CURRENT_METADATA_SUCCESS_TTL_MS = 30 * 1000;
    const MAX_CURRENT_METADATA_CACHE_ENTRIES = 8;
    function cachedCurrentConversationMeta(conversationId) {
      const cached = currentMetadataCache.get(conversationId);
      if (!cached || cached.expiresAt <= Date.now()) {
        currentMetadataCache.delete(conversationId);
        return null;
      }
      if (cached.meta?.messageNumbers) {
        currentMessageNumbers = { conversationId, numbers: cached.meta.messageNumbers, records: cached.meta.messageRecords };
      }
      return cached.meta;
    }

    function cacheCurrentConversationMeta(conversationId, meta, ttl) {
      currentMetadataCache.delete(conversationId);
      currentMetadataCache.set(conversationId, { meta, expiresAt: Date.now() + ttl });
      while (currentMetadataCache.size > MAX_CURRENT_METADATA_CACHE_ENTRIES) {
        currentMetadataCache.delete(currentMetadataCache.keys().next().value);
      }
    }

    function payloadConversationId(payload) {
      return payload?.conversation_id || payload?.conversationId || payload?.id || null;
    }

    function syncCurrentMetadataScope(route) {
      // Page mutations and GET_SNAPSHOT are observations, not permission to retry
      // a failed optional read. A different route/workspace (or document reload)
      // creates a new attempt scope. Never use a cooldown/self-polling retry here.
      const workspace = String(document.cookie || "").split(";").map(part => part.trim())
        .find(part => part.startsWith("_account=")) || "";
      const key = JSON.stringify([route.kind, route.conversationId, route.projectId || null, workspace]);
      if (key !== currentMetadataScope.key) {
        if (workspace !== currentMetadataScope.workspace) currentMetadataCache.clear();
        currentMetadataScope = { key, workspace, failed: false, numberAttempts: new Set() };
        currentMessageNumbers = null;
      }
    }

    function ensureCurrentConversationMeta(identity, route, unnumbered = []) {
      if (disposed) return;
      const conversationId = identity?.conversationId;
      const scope = currentMetadataScope;
      // Re-read on a new canonical message or its completion, not each streaming
      // token/DOM mutation. Virtualizing already-known history needs no request.
      const numberKeys = unnumbered.map(item => JSON.stringify([item.id, item.status]));
      const needsNumbers = numberKeys.some(key => !scope.numberAttempts.has(key));
      if (
        !conversationId ||
        identity.bindingStatus !== bindingAdapter.BindingStatus.BOUND ||
        !["conversation", "project-conversation"].includes(route.kind) ||
        routeAdapter.isDraftId(conversationId) ||
        currentMetadataRequests.has(conversationId) ||
        (currentMetadataCache.has(conversationId) && !needsNumbers) ||
        (scope.metadataOnlyFailed && !needsNumbers) ||
        scope.failed ||
        typeof global.fetch !== "function"
      ) return;
      for (const key of numberKeys) scope.numberAttempts.add(key);

      const request = Promise.resolve().then(() => global.TidyChatgptApi.fetchAuthenticated(
        `/backend-api/conversation/${global.encodeURIComponent(conversationId)}`,
        { headers: { Accept: "application/json" } },
      )).then(async (response) => {
        session.assertActive();
        if (!response.ok) throw new Error(`Current conversation metadata request failed (${response.status})`);
        const payload = await response.json();
        session.assertActive();
        const responseConversationId = payloadConversationId(payload);
        // ChatGPT's current-conversation response is addressed by the canonical
        // conversation ID in the request URL, but some live response shapes omit
        // that ID from the JSON body. An explicit body ID is extra evidence and
        // must match; when absent, the exact requested URL plus an unchanged
        // route is the identity proof. Never accept a conflicting body ID.
        if (responseConversationId && responseConversationId !== conversationId) {
          throw new Error("Current conversation metadata identity mismatch");
        }
        syncCurrentMetadataScope(routeAdapter.parse());
        if (scope !== currentMetadataScope || !routeStillOwnsConversation(conversationId)) return;
        if (payload.mapping && (payload.current_node || payload.currentNode)) {
          // Numbering and dates are independent projections of the SAME read.
          // A broken branch must not remove otherwise valid conversation dates.
          try {
            currentMessageNumbers = { conversationId, numbers: global.TidyChatgptConversationProjection.messageNumbersFromPayload(payload, conversationId) };
            // 新版原生展示项可能省略时间。复用编号已有的同一次读取，只留
            // 当前分支的 ID/角色/时间，不缓存正文，也不另建请求或轮询链路。
            const records = Object.create(null);
            for (const node of Object.values(payload.mapping)) {
              const message = node?.message;
              if (!message?.id || !Object.hasOwn(currentMessageNumbers.numbers, message.id)) continue;
              records[message.id] = { id: message.id, conversation_id: conversationId,
                author: { role: message.author?.role }, create_time: message.create_time, status: message.status };
            }
            currentMessageNumbers.records = records;
          } catch { /* No fabricated number for an incomplete canonical branch. */ }
        }
        const value = {
          id: conversationId,
          title: typeof payload.title === "string" ? payload.title : null,
          create_time: payload.create_time ?? null,
          update_time: payload.update_time ?? null,
        };
        // A range is atomic for the current-conversation fallback. Caching only
        // one endpoint would make the UI look authoritative while still unable
        // to render the requested create/update range.
        const hasCanonicalRange = value.create_time != null && value.update_time != null;
        if (!hasCanonicalRange) {
          // A valid message sequence does not invent missing conversation dates.
          // Publish the numbers independently and stop this one metadata attempt.
          if (!currentMessageNumbers) throw new Error("Current conversation response omitted canonical range");
          scope.metadataOnlyFailed = true;
          onChanged("current-conversation-numbers", 0);
          return;
        }
        cacheCurrentConversationMeta(
          conversationId,
          {
            kind: "conversation",
            value,
            link: null,
            boundId: conversationId,
            source: "chatgpt-api.current-conversation-metadata",
            messageNumbers: currentMessageNumbers?.numbers || null,
            messageRecords: currentMessageNumbers?.records || null,
          },
          CURRENT_METADATA_SUCCESS_TTL_MS,
        );
        // Publish only after accepted canonical data changes the snapshot.
        onChanged("current-conversation-metadata", 0);
      }).catch(() => {
        // All failed optional reads stop this scope, including 429 and explicit
        // can_retry:false. Clearing pending alone would refetch on every DOM event.
        // An old response can only mark its own, possibly retired, scope.
        scope.failed = true;
      }).finally(() => {
        currentMetadataRequests.delete(conversationId);
      });
      currentMetadataRequests.set(conversationId, request);
    }


    function dispose() {
      disposed = true;
      currentMetadataCache.clear();
      currentMetadataRequests.clear();
      currentMetadataScope = { key: null, workspace: null, failed: true, numberAttempts: new Set() };
      currentMessageNumbers = null;
    }
    return Object.freeze({ syncScope: syncCurrentMetadataScope, cached: cachedCurrentConversationMeta,
      ensure: ensureCurrentConversationMeta, messageNumbers: () => currentMessageNumbers, dispose });
  }
  global.TidyChatgptSnapshotMetadata = Object.freeze({ create });
})(globalThis);
