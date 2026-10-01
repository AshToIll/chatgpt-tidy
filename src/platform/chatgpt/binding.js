(function initTidyChatgptBinding(global) {
  "use strict";

  if (global.TidyChatgptBinding) return;

  const BindingStatus = Object.freeze({
    UNBOUND: "unbound",
    ROUTE_ONLY: "route-only",
    BOUND: "bound",
    MISMATCH: "mismatch",
  });

  function normalizedId(value) {
    return typeof value === "string" && value ? value : null;
  }

  function isFormalId(value, isDraftId) {
    return Boolean(normalizedId(value) && !isDraftId(value));
  }

  // The route owns identity. Fiber may prove that the visible DOM belongs to
  // that route, but a stale Fiber ID is never allowed to replace the route ID.
  function resolve(route, threadEvidence, draftIdMap, isDraftId) {
    const routeId = normalizedId(route?.conversationId);
    const threadId = normalizedId(threadEvidence?.clientId);
    const serverId = normalizedId(threadEvidence?.serverId);

    if (!routeId) {
      return {
        conversationId: null,
        draftId: null,
        status: route?.identityStatus || "unavailable",
        bindingStatus: BindingStatus.UNBOUND,
        threadBound: false,
      };
    }

    if (isDraftId(routeId)) {
      const mappedId = normalizedId(draftIdMap.get(routeId));
      const formalId = isFormalId(serverId, isDraftId)
        ? serverId
        : isFormalId(mappedId, isDraftId)
          ? mappedId
          : null;

      if (threadId && threadId !== routeId) {
        return {
          conversationId: formalId,
          draftId: routeId,
          status: formalId ? "stable" : "resolving",
          bindingStatus: BindingStatus.MISMATCH,
          threadBound: false,
        };
      }

      if (threadId === routeId) {
        if (formalId) draftIdMap.set(routeId, formalId);
        return {
          conversationId: formalId,
          draftId: routeId,
          status: formalId ? "stable" : "resolving",
          bindingStatus: BindingStatus.BOUND,
          threadBound: true,
        };
      }

      return {
        conversationId: formalId,
        draftId: routeId,
        status: formalId ? "stable" : "resolving",
        bindingStatus: BindingStatus.ROUTE_ONLY,
        threadBound: false,
      };
    }

    const identity = {
      conversationId: routeId,
      draftId: null,
      status: "stable",
      bindingStatus: BindingStatus.ROUTE_ONLY,
      threadBound: false,
    };

    if (!threadId) return identity;
    if (threadId === routeId) {
      return { ...identity, bindingStatus: BindingStatus.BOUND, threadBound: true };
    }

    if (isDraftId(threadId)) {
      const mappedId = isFormalId(serverId, isDraftId)
        ? serverId
        : normalizedId(draftIdMap.get(threadId));
      if (mappedId === routeId) {
        draftIdMap.set(threadId, routeId);
        return {
          ...identity,
          draftId: threadId,
          bindingStatus: BindingStatus.BOUND,
          threadBound: true,
        };
      }
      if (!mappedId) return identity;
    }

    return { ...identity, bindingStatus: BindingStatus.MISMATCH };
  }

  function acceptedIds(identity) {
    return [identity?.conversationId, identity?.draftId].filter(Boolean);
  }

  function withExactMetadata(identity, hasExactMetadata) {
    if (
      identity.bindingStatus === BindingStatus.UNBOUND ||
      identity.bindingStatus === BindingStatus.MISMATCH
    ) {
      return identity;
    }
    if (identity.threadBound || hasExactMetadata) {
      return { ...identity, bindingStatus: BindingStatus.BOUND };
    }
    return { ...identity, bindingStatus: BindingStatus.ROUTE_ONLY };
  }

  function recordConversationId(record) {
    return normalizedId(
      record?.conversation_id ??
        record?.conversationId ??
        record?.message?.conversation_id ??
        record?.message?.conversationId,
    );
  }

  function messageMatchesIdentity(record, identity) {
    if (identity?.bindingStatus !== BindingStatus.BOUND) return false;
    const recordId = recordConversationId(record);
    if (recordId) return acceptedIds(identity).includes(recordId);
    return identity.threadBound === true;
  }

  function stableMessageId(domId, fiberId) {
    const dom = normalizedId(domId);
    const fiber = normalizedId(fiberId);
    const value = dom || fiber;
    if (!value || (dom && fiber && dom !== fiber)) return null;
    // ChatGPT can temporarily expose optimistic placeholders while a send is
    // being promoted to its server identity. Those IDs remain readable but
    // are explicitly barred from persistence.
    if (/^(?:temp|temporary|draft|pending|placeholder|streaming)(?:[-_:]|$)/i.test(value)) return null;
    return value;
  }

  global.TidyChatgptBinding = Object.freeze({
    BindingStatus,
    resolve,
    acceptedIds,
    withExactMetadata,
    recordConversationId,
    messageMatchesIdentity,
    stableMessageId,
  });
})(globalThis);
