// 只读原生 DOM/Fiber 的证据与字段。唯一可写状态是当前文档草稿 ID 对应关系。
(function initTidyChatgptNativeSnapshotReader(global) {
  "use strict";
  if (global.TidyChatgptNativeSnapshotReader) return;
  function create({ readMessageNumbers = () => null } = {}) {
    const snapshotContract = global.TidySnapshot;
    const routeAdapter = global.TidyChatgptRoute;
    const bindingAdapter = global.TidyChatgptBinding;
    const messageDom = global.TidyChatgptMessageDom;
    const sidebarDom = global.TidyChatgptSidebarDom;
    const document = global.document;
    const draftIdMap = new Map();
    function readSignal(object, key) {
      const getter = object?.[key];
      if (typeof getter !== "function") return null;
      try {
        return getter.call(object);
      } catch {
        return null;
      }
    }

    function fiberFrom(element) {
      if (!element) return null;
      const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactFiber$"));
      return key ? element[key] : null;
    }

    function walkFiber(element, visitor, maxDepth = 160) {
      let fiber = fiberFrom(element);
      let depth = 0;
      while (fiber && depth < maxDepth) {
        const result = visitor(fiber.memoizedProps || {}, fiber);
        if (result !== undefined && result !== null) return result;
        fiber = fiber.return;
        depth += 1;
      }
      return null;
    }

    function toIso(value) {
      if (value == null || value === "") return null;
      let number = Number(value);
      if (Number.isFinite(number) && Math.abs(number) < 100_000_000_000) number *= 1000;
      const date = Number.isFinite(number) ? new Date(number) : new Date(value);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    function firstText(element) {
      if (!element) return null;
      for (const node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) return node.textContent.trim();
        if (node.nodeType === Node.ELEMENT_NODE) {
          // Presentation nodes are rendered by Tidy from this DTO. Never feed
          // their formatted text back into the ChatGPT Adapter as source data.
          if (node.matches?.("[data-tidy-owned]")) continue;
          const text = firstText(node);
          if (text) return text;
        }
      }
      return null;
    }

    function findThreadConversation() {
      const messageElement = messageDom.candidates()[0];
      return walkFiber(messageElement, (props) => {
        const candidate = props.conversation;
        return typeof candidate?.id === "string" ? candidate : null;
      }, 40);
    }

    function fiberConversationCandidates(element, maxDepth = 160) {
      const candidates = [];
      const seen = new Set();
      let fiber = fiberFrom(element);
      let depth = 0;
      while (fiber && depth < maxDepth) {
        const props = fiber.memoizedProps || {};
        for (const candidate of [props.conversation, props.historyItem]) {
          if (!candidate || typeof candidate !== "object" || seen.has(candidate)) continue;
          seen.add(candidate);
          candidates.push(candidate);
        }
        fiber = fiber.return;
        depth += 1;
      }
      return candidates;
    }

    function candidateConversationIds(candidate) {
      return [
        candidate?.id,
        candidate?.conversation_id,
        candidate?.conversationId,
        readSignal(candidate, "serverId$"),
      ].filter((value) => typeof value === "string" && value);
    }

    function findCurrentPageMeta(identity) {
      const accepted = new Set(bindingAdapter.acceptedIds(identity));
      if (!accepted.size) return null;
      const roots = [
        messageDom.candidates()[0],
        document.querySelector("main"),
        document.querySelector("header"),
      ].filter(Boolean);
      const seenRoots = new Set();
      for (const root of roots) {
        if (seenRoots.has(root)) continue;
        seenRoots.add(root);
        for (const candidate of fiberConversationCandidates(root)) {
          const ids = candidateConversationIds(candidate);
          if (!ids.some((id) => accepted.has(id))) continue;
          if (candidate.create_time == null && candidate.update_time == null) continue;
          return {
            kind: "conversation",
            value: candidate,
            link: null,
            boundId: ids.find((id) => accepted.has(id)) || null,
            source: "react-fiber.current-conversation",
          };
        }
      }
      return null;
    }

    function hasCurrentPageIdentityEvidence(identity) {
      const accepted = new Set(bindingAdapter.acceptedIds(identity));
      if (!accepted.size) return false;
      for (const element of messageDom.candidates()) {
        const record = findMessageRecord(element, messageDom.id(element));
        const conversationId = bindingAdapter.recordConversationId(record);
        if (conversationId && accepted.has(conversationId)) return true;
      }
      return false;
    }

    function resolveRouteIdentity(route, threadConversation) {
      return bindingAdapter.resolve(
        route,
        {
          clientId: threadConversation?.id || null,
          serverId: readSignal(threadConversation, "serverId$"),
        },
        draftIdMap,
        routeAdapter.isDraftId,
      );
    }

    function routeIdFromHref(href) {
      return routeAdapter.parse(new URL(href || "", global.location.origin).href).conversationId;
    }

    function sidebarMetaForLink(link) {
      return walkFiber(link, (props) => {
        const candidate = props.conversation || props.historyItem;
        if (candidate && (candidate.id || candidate.create_time || candidate.update_time)) {
          return { kind: "conversation", value: candidate };
        }
        if (props.room?.id) return { kind: "group", value: props.room };
        return null;
      }, 40);
    }

    function findConversationMeta(identity) {
      const accepted = new Set(bindingAdapter.acceptedIds(identity));
      if (!accepted.size) return null;

      for (const link of sidebarDom.candidates()) {
        const linkId = routeIdFromHref(link.getAttribute("href"));
        if (!accepted.has(linkId)) continue;
        const result = sidebarMetaForLink(link);
        if (!result) continue;

        const candidateId = result.value?.id || result.value?.conversation_id || null;
        if (candidateId && !accepted.has(candidateId)) continue;
        return { ...result, link, boundId: linkId, source: "react-fiber.history-item" };
      }
      return null;
    }

    function threadConversationMatches(identity, threadConversation) {
      const threadId = threadConversation?.id || null;
      const serverId = readSignal(threadConversation, "serverId$");
      return bindingAdapter.acceptedIds(identity).some((id) => id === threadId || id === serverId);
    }

    function currentConversationMeta(identity, sidebarMeta, pageMeta, cachedMeta, threadConversation) {
      // The current page is the primary source. The native sidebar is merely a
      // second exact source and may be absent in responsive/narrow layouts.
      const candidates = [pageMeta, sidebarMeta, cachedMeta].filter(Boolean);
      const complete = candidates.find((meta) =>
        meta.value?.create_time != null && meta.value?.update_time != null,
      );
      if (complete) return complete;
      if (candidates.length) return candidates[0];
      if (!identity.threadBound || !threadConversationMatches(identity, threadConversation)) return null;
      if (threadConversation?.create_time == null && threadConversation?.update_time == null) return null;
      return {
        kind: "conversation",
        value: threadConversation,
        link: null,
        boundId: identity.conversationId,
        source: "react-fiber.thread-conversation",
      };
    }

    function sourced(value, source, status = "available") {
      return {
        value: value ?? null,
        source: value == null ? null : source,
        status: value == null ? "missing" : status,
      };
    }

    function groupRoomCreatedAt(room) {
      // A room object's own createdAt can be its client-side instantiation time.
      // Only the earliest room message is authoritative, and only after ChatGPT
      // confirms that the beginning of history has been fetched.
      if (readSignal(room, "hasFetchedBeginning$") !== true) return null;
      const messages = readSignal(room, "messages$");
      const first = Array.isArray(messages) ? messages[0] : null;
      return toIso(first?.createdAt ?? first?.create_time);
    }

    function readSidebarConversations() {
      const items = [];
      const seen = new Set();

      for (const link of sidebarDom.candidates()) {
        const href = link.getAttribute("href");
        if (!href) continue;
        const itemRoute = routeAdapter.parse(new URL(href, global.location.origin).href);
        const conversationId = itemRoute.conversationId;
        if (!conversationId || routeAdapter.isDraftId(conversationId) || seen.has(conversationId)) continue;
        seen.add(conversationId);

        const meta = sidebarMetaForLink(link);
        const value = meta?.value || null;
        const candidateId = value?.id || value?.conversation_id || null;
        const mismatched = Boolean(candidateId && candidateId !== conversationId);

        // `historyItem` is read only from the Fiber attached to this exact href.
        // A matching candidate id is strongest proof. Some ChatGPT sidebar
        // builds omit the id from `historyItem`; direct Fiber ownership by the
        // exact conversation anchor remains sufficient for read-only display.
        // We never search another row or fall back to the first history item.
        const bindingStatus = mismatched
          ? bindingAdapter.BindingStatus.MISMATCH
          : meta
            ? bindingAdapter.BindingStatus.BOUND
            : bindingAdapter.BindingStatus.ROUTE_ONLY;
        const canReadMetadata = bindingStatus === bindingAdapter.BindingStatus.BOUND;
        const isGroup = meta?.kind === "group";
        const titleValue = firstText(link);
        // Frozen DTO contract: canonical conversation metadata is the only
        // source for createdAt/updatedAt. Message timestamps never overwrite
        // these fields. Group-room signals remain their separate adapter path.
        const createdAt = canReadMetadata
          ? isGroup
            ? groupRoomCreatedAt(value)
            : toIso(value?.create_time)
          : null;
        const updatedAt = canReadMetadata
          ? toIso(isGroup ? readSignal(value, "updatedAt$") : value?.update_time)
          : null;
        const timeSource = isGroup ? "react-fiber.group-room" : "react-fiber.history-item";

        items.push({
          conversationId,
          identityStatus: "stable",
          bindingStatus,
          kind: itemRoute.kind,
          title: sourced(titleValue, "sidebar-dom"),
          createdAt: sourced(createdAt, timeSource),
          updatedAt: sourced(updatedAt, timeSource),
          project: itemRoute.projectId
            ? { projectId: itemRoute.projectId, title: null, source: "route", status: "partial" }
            : null,
          locator: {
            strategy: "href",
            value: href,
          },
        });
      }

      return items;
    }

    function readProject(route, meta) {
      if (!route.projectId) return null;
      let title = null;
      const projectLink = [...document.querySelectorAll('a[href$="/project"]')].find(link => {
        const candidate = routeAdapter.parse(link.getAttribute("href"));
        return candidate.supported && candidate.kind === "project" && candidate.projectId === route.projectId;
      });
      if (projectLink) title = firstText(projectLink);
      return {
        projectId: route.projectId,
        title,
        source: title ? "sidebar-dom" : meta ? "route+fiber" : "route",
        status: title ? "available" : "partial",
      };
    }

    function readConversationFields(route, identity, meta) {
      const value = meta?.value;
      const isGroup = meta?.kind === "group";
      const fiberTitle = isGroup ? readSignal(value, "name$") : value?.title;
      const domTitle = firstText(meta?.link);
      const title = [domTitle, fiberTitle]
        .find((candidate) => typeof candidate === "string" && candidate.trim() && candidate !== "ChatGPT") || null;

      const createdAt = meta
        ? isGroup
          ? groupRoomCreatedAt(value)
          : toIso(value?.create_time)
        : null;
      const updatedAt = meta
        ? toIso(isGroup ? readSignal(value, "updatedAt$") : value?.update_time)
        : null;
      const timeSource = isGroup
        ? "react-fiber.group-room"
        : meta?.source || "react-fiber.history-item";

      return {
        conversationId: identity.conversationId,
        draftId: identity.draftId,
        identityStatus: identity.status,
        bindingStatus: identity.bindingStatus,
        kind: route.kind,
        title: {
          value: title,
          source: title
            ? title === domTitle
              ? "sidebar-dom"
              : title === fiberTitle
                ? meta?.source || "react-fiber"
                : null
            : null,
          status: title ? (identity.status === "stable" ? "available" : "provisional") : "missing",
        },
        project: readProject(route, meta),
        createdAt: sourced(createdAt, timeSource),
        updatedAt: sourced(updatedAt, timeSource),
      };
    }

    function normalizeRole(value) {
      const role = value?.author?.role || value?.role || value?.message?.author?.role;
      return ["user", "assistant", "system", "tool"].includes(role) ? role : "unknown";
    }

    function recordId(record) {
      return record?.id || record?.message?.id || null;
    }

    function findMessageRecord(element, domId) {
      const currentMessageNumbers = readMessageNumbers();
      return walkFiber(element, (props) => {
        // 新原生会话块：消息 ID、类型、会话归属必须来自同一个展示项。
        // 不能借用祖先的其他消息，更不能从正文或当前时钟猜日期。
        const item = props.item;
        if (element.getAttribute("data-chatgpt-search-message-ids") && domId
          && item?.messageId === domId && ["user-message", "assistant-message"].includes(item.type)
          && typeof props.conversationId === "string" && props.conversationId) {
          const role = item.type === "user-message" ? "user" : "assistant";
          const canonical = currentMessageNumbers?.conversationId === props.conversationId
            ? currentMessageNumbers.records?.[domId] : null;
          if (canonical && canonical.author.role !== role) return null;
          const nativeTime = typeof item.sentAtMs === "number" && Number.isFinite(item.sentAtMs) ? new Date(item.sentAtMs) : null;
          const hasNativeTime = nativeTime && Number.isFinite(nativeTime.getTime());
          const timestamp = hasNativeTime ? nativeTime.toISOString() : canonical?.create_time ?? null;
          return { id: domId, conversation_id: props.conversationId, author: { role }, create_time: timestamp,
            status: item.completed === false ? "in_progress" : canonical?.status || "finished_successfully",
            timestampSource: hasNativeTime ? "react-fiber.message-item" : "chatgpt-api.canonical-active-branch" };
        }
        const direct = props.message || props.calpicoMessage;
        if (direct && typeof direct === "object" && (!domId || recordId(direct) === domId)) return direct;
        if (Array.isArray(props.messages)) {
          const exact = props.messages.find((candidate) => recordId(candidate) === domId);
          if (exact) return exact;
          if (!domId && props.messages.length === 1) return props.messages[0];
        }
        return null;
      });
    }

    function roleFromDom(element) {
      const roleElement = element.matches?.("[data-message-author-role]")
        ? element
        : element.querySelector?.("[data-message-author-role]");
      const role = roleElement?.getAttribute("data-message-author-role");
      return ["user", "assistant", "system", "tool"].includes(role) ? role : null;
    }

    function normalizeExcerpt(value) {
      if (typeof value !== "string") return null;
      const normalized = value.replace(/\s+/g, " ").trim();
      if (!normalized) return null;
      const limit = snapshotContract.MAX_MESSAGE_EXCERPT_LENGTH;
      return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1).trimEnd()}…`;
    }

    function contentPartText(part) {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return null;
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return null;
    }

    function readExcerpt(record, element) {
      const content = record?.content || record?.message?.content;
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      const fiberText = normalizeExcerpt(parts.map(contentPartText).filter(Boolean).join(" "));
      if (fiberText) {
        return { value: fiberText, source: "react-fiber.message.content", status: "available" };
      }

      // Semantic DOM is only a bounded fallback inside the ChatGPT Adapter. No
      // feature module is allowed to establish a second message-reading path.
      const contentRoot = messageDom.contentRoot(element);
      const domText = normalizeExcerpt(contentRoot?.innerText || contentRoot?.textContent || "");
      return {
        value: domText,
        source: domText ? "semantic-dom.message-content" : null,
        status: domText ? "partial" : "missing",
      };
    }

    function readMessages(identity, unnumbered, activity) {
      const currentMessageNumbers = readMessageNumbers();
      const seen = new Set();
      const messages = [];
      for (const element of messageDom.candidates()) {
        const domId = messageDom.id(element);
        if (!domId) continue;
        const record = findMessageRecord(element, domId);
        if (!bindingAdapter.messageMatchesIdentity(record, identity)) continue;
        // 只报告已绑定会话的原生进行中信号；思考外壳也可能先于正式正文出现。
        // false 仅表示未观察到进行中，不能作为全文已读齐的证明。
        if ((record?.status || record?.message?.status) === "in_progress") activity.responseInProgress = true;
        const fiberId = recordId(record);
        const messageId = domId || fiberId;
        if (!messageId || seen.has(messageId)) continue;
        seen.add(messageId);

        const timestamp = toIso(record?.create_time ?? record?.createdAt ?? record?.message?.create_time);
        const stableId = bindingAdapter.stableMessageId(domId, fiberId);
        const recordRole = normalizeRole(record);
        // A ChatGPT thinking/generating shell can temporarily own a DOM
        // data-message-id without a complete canonical message record. Only an
        // exact Fiber record with author role and timestamp is a formal message.
        // Normal streaming messages remain eligible because ChatGPT assigns
        // those canonical fields before the response has finished rendering.
        const hasExactRecord = Boolean(
          stableId === messageId &&
          fiberId === messageId &&
          recordRole !== "unknown",
        );
        if (!hasExactRecord) continue;
        const displayNumber = currentMessageNumbers?.conversationId === identity.conversationId
          ? currentMessageNumbers.numbers[messageId] ?? null : null;
        if (displayNumber == null || !timestamp) unnumbered.push({ id: messageId, status: record.status || record.message?.status || "unknown" });
        if (!timestamp) continue;
        messages.push({
          messageId,
          idSource: `dom.${messageDom.locator(element).strategy}`,
          idStatus: stableId === messageId ? "stable" : "provisional",
          presentationStatus: "formal",
          role: roleFromDom(element) || recordRole,
          timestamp: {
            value: timestamp,
            source: timestamp ? record.timestampSource || "react-fiber.message" : null,
            status: timestamp ? "available" : "missing",
          },
          order: {
            // Local position only: virtualization can restart it at zero. Never
            // promote this sorting index into a user-facing conversation number.
            index: messages.length,
            displayNumber,
            source: displayNumber == null ? null : "chatgpt-api.canonical-active-branch",
            stableIdentity: displayNumber != null,
          },
          excerpt: readExcerpt(record, element),
          locator: messageDom.locator(element),
        });
      }
      return messages;
    }

    function routeStillOwnsConversation(conversationId) {
      const liveRouteId = routeAdapter.parse().conversationId;
      return liveRouteId === conversationId || draftIdMap.get(liveRouteId) === conversationId;
    }

    return Object.freeze({ findThreadConversation, resolveRouteIdentity, findConversationMeta,
      findCurrentPageMeta, hasCurrentPageIdentityEvidence, currentConversationMeta, readMessages,
      readConversationFields, readSidebarConversations, routeStillOwnsConversation,
      findMessageRecord, walkFiber, recordId, normalizeRole, dispose: () => draftIdMap.clear() });
  }
  global.TidyChatgptNativeSnapshotReader = Object.freeze({ create });
})(globalThis);
