(function initTidySnapshotContract(global) {
  "use strict";

  if (global.TidySnapshot) return;

  const VERSION = "chatgpt-tidy.snapshot.v1";
  const FIELD_STATUS = Object.freeze(["available", "provisional", "partial", "missing", "unsupported"]);
  const IDENTITY_STATUS = Object.freeze(["stable", "resolving", "draft", "empty", "unavailable"]);
  // unbound：没有会话；route-only：仅网址可确认；bound：数据归属已确认；mismatch：排除错会话数据。
  const BINDING_STATUS = Object.freeze(["unbound", "route-only", "bound", "mismatch"]);
  const MESSAGE_ID_STATUS = Object.freeze(["stable", "provisional"]);
  const MESSAGE_PRESENTATION_STATUS = Object.freeze(["formal", "transient"]);
  const COLOR_SCHEMES = Object.freeze(["light", "dark"]);
  // Keep snapshot events and bookmark storage bounded even when a ChatGPT
  // message contains a very large answer. The Adapter owns excerpt creation;
  // feature modules must never read message bodies from the page again.
  const MAX_MESSAGE_EXCERPT_LENGTH = 320;

  // 项目网址可以在 32 位编号后附加可读名称；名称不是接口中的项目 ID。
  // 只拆已确认的完整编号，不能随意按连字符切短未知格式或相似编号。
  function projectIdFromSegment(value) {
    if (typeof value !== "string" || !/^g-p-[A-Za-z0-9_-]+$/.test(value)) return null;
    return /^(g-p-[a-f0-9]{32})(?:-[A-Za-z0-9_-]+)?$/.exec(value)?.[1] || value;
  }

  // Saved library records and their UI eligibility share this exact grammar.
  // Readable custom-GPT/share/draft pages are not automatically writable chats.
  function parseConversationPath(pathname) {
    if (typeof pathname !== "string") return null;
    const ordinary = /^\/c\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
    const project = /^\/g\/(g-p-[A-Za-z0-9_-]+)\/c\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
    if ((!ordinary && !project) || (ordinary || project)[0] !== pathname) return null;
    return {
      conversationId: ordinary ? ordinary[1] : project[2],
      projectId: project ? projectIdFromSegment(project[1]) : null,
      // 页面归属仍保留真实路径；规范项目 ID 不会改地址或放宽路径检查。
      pathname: pathname.replace(/\/$/, ""),
    };
  }

  // Do not let URL normalization repair credentials, ports or dot segments.
  function canonicalConversationPath(value, conversationId) {
    if (typeof value !== "string" || typeof conversationId !== "string" || !conversationId) return null;
    const path = value.startsWith("https://chatgpt.com/")
      ? value.slice("https://chatgpt.com".length) : value;
    const parsed = parseConversationPath(path.split(/[?#]/, 1)[0]);
    return parsed?.conversationId === conversationId ? parsed.pathname : null;
  }

  function isNullableString(value) {
    return value === null || typeof value === "string";
  }

  function isSourcedField(field) {
    return Boolean(
      field &&
        isNullableString(field.value) &&
        isNullableString(field.source) &&
        FIELD_STATUS.includes(field.status),
    );
  }

  function isSafeRgb(value) {
    if (value === null) return true;
    const match = typeof value === "string" && value.match(/^rgb\((\d{1,3}), (\d{1,3}), (\d{1,3})\)$/);
    return Boolean(match && match.slice(1).every((channel) => Number(channel) <= 255));
  }

  function validateSidebarConversation(conversation, index, errors) {
    const prefix = `sidebarConversations[${index}]`;
    if (typeof conversation?.conversationId !== "string" || !conversation.conversationId) {
      errors.push(`${prefix}.conversationId`);
    }
    if (!IDENTITY_STATUS.includes(conversation?.identityStatus)) {
      errors.push(`${prefix}.identityStatus`);
    }
    if (!BINDING_STATUS.includes(conversation?.bindingStatus)) {
      errors.push(`${prefix}.bindingStatus`);
    }
    if (typeof conversation?.kind !== "string") errors.push(`${prefix}.kind`);
    for (const key of ["title", "createdAt", "updatedAt"]) {
      if (!isSourcedField(conversation?.[key])) errors.push(`${prefix}.${key}`);
    }
    if (
      typeof conversation?.locator?.strategy !== "string" ||
      typeof conversation?.locator?.value !== "string" ||
      !conversation.locator.value
    ) {
      errors.push(`${prefix}.locator`);
    }
    if (conversation?.bindingStatus !== "bound") {
      for (const key of ["createdAt", "updatedAt"]) {
        if (conversation?.[key]?.value !== null) errors.push(`${prefix}.${key}.unboundValue`);
      }
    }
  }

  function validate(snapshot) {
    const errors = [];
    if (!snapshot || snapshot.schemaVersion !== VERSION) errors.push("schemaVersion");
    if (!snapshot?.route || typeof snapshot.route.pathname !== "string") errors.push("route");
    if (
      !snapshot?.appearance ||
      !COLOR_SCHEMES.includes(snapshot.appearance.colorScheme) ||
      typeof snapshot.appearance.source !== "string" ||
      !FIELD_STATUS.includes(snapshot.appearance.status) ||
      !isSourcedField(snapshot.appearance.surface) ||
      !isSafeRgb(snapshot.appearance.surface?.value)
    ) {
      errors.push("appearance");
    }
    if (!snapshot?.conversation || !IDENTITY_STATUS.includes(snapshot.conversation.identityStatus)) {
      errors.push("conversation.identityStatus");
    }
    if (!BINDING_STATUS.includes(snapshot?.conversation?.bindingStatus)) {
      errors.push("conversation.bindingStatus");
    }
    if (!isNullableString(snapshot?.conversation?.conversationId)) errors.push("conversation.conversationId");
    if (!isNullableString(snapshot?.conversation?.draftId)) errors.push("conversation.draftId");
    for (const key of ["title", "createdAt", "updatedAt"]) {
      if (!isSourcedField(snapshot?.conversation?.[key])) errors.push(`conversation.${key}`);
    }
    // Canonical conversation metadata is authoritative: `createdAt` maps to
    // ChatGPT `create_time`, `updatedAt` maps to `update_time`, and Range is
    // derived from those two fields. Per-message time stays in
    // `message.timestamp` and must never overwrite conversation metadata.
    // Sidebar conversations are a bounded projection keyed by their exact
    // href. Feature writes may only consume rows accepted by the dedicated
    // eligibility helper below; route-only and mismatched rows stay read-only.
    if (!Array.isArray(snapshot?.sidebarConversations)) errors.push("sidebarConversations");
    else {
      const seenConversationIds = new Set();
      snapshot.sidebarConversations.forEach((conversation, index) => {
        validateSidebarConversation(conversation, index, errors);
        if (seenConversationIds.has(conversation?.conversationId)) {
          errors.push(`sidebarConversations[${index}].duplicateConversationId`);
        }
        seenConversationIds.add(conversation?.conversationId);
      });
    }
    if (!Array.isArray(snapshot?.messages)) errors.push("messages");
    else {
      snapshot.messages.forEach((message, index) => {
        if (typeof message?.messageId !== "string" || !message.messageId) errors.push(`messages[${index}].messageId`);
        if (!MESSAGE_ID_STATUS.includes(message?.idStatus)) errors.push(`messages[${index}].idStatus`);
        if (!MESSAGE_PRESENTATION_STATUS.includes(message?.presentationStatus)) errors.push(`messages[${index}].presentationStatus`);
        if (typeof message?.role !== "string") errors.push(`messages[${index}].role`);
        if (!isSourcedField(message?.timestamp)) errors.push(`messages[${index}].timestamp`);
        if (!isSourcedField(message?.excerpt)) errors.push(`messages[${index}].excerpt`);
        if (typeof message?.excerpt?.value === "string" && message.excerpt.value.length > MAX_MESSAGE_EXCERPT_LENGTH) {
          errors.push(`messages[${index}].excerpt.length`);
        }
        if (!Number.isInteger(message?.order?.index)) errors.push(`messages[${index}].order.index`);
        if (typeof message?.locator?.strategy !== "string" || typeof message?.locator?.value !== "string") {
          errors.push(`messages[${index}].locator`);
        }
      });
    }
    if (snapshot?.conversation?.bindingStatus !== "bound") {
      for (const key of ["title", "createdAt", "updatedAt"]) {
        if (snapshot?.conversation?.[key]?.value !== null) errors.push(`conversation.${key}.unboundValue`);
      }
      if (Array.isArray(snapshot?.messages) && snapshot.messages.length) errors.push("messages.unboundValues");
    }
    return { valid: errors.length === 0, errors };
  }

  // Future write/persistence features must use this helper rather than testing
  // conversationId alone. A bound draft is readable but is not persistable.
  function isPersistenceEligible(snapshot) {
    return Boolean(
      validate(snapshot).valid &&
        snapshot.conversation.bindingStatus === "bound" &&
        snapshot.conversation.identityStatus === "stable" &&
        canonicalConversationPath(snapshot.route.pathname, snapshot.conversation.conversationId),
    );
  }

  // A sidebar favorite is allowed only when the Adapter proved that the
  // stable route id, exact anchor and its metadata belong to the same row.
  // This deliberately does not make sidebar messages or arbitrary DOM data
  // persistable.
  function isSidebarPersistenceEligible(conversation) {
    const errors = [];
    validateSidebarConversation(conversation, 0, errors);
    return Boolean(
      errors.length === 0 &&
        conversation.identityStatus === "stable" &&
        conversation.bindingStatus === "bound" &&
        canonicalConversationPath(conversation.locator.value, conversation.conversationId),
    );
  }

  // Persistence modules receive the exact canonical message record through
  // this helper. A route-only/mismatch snapshot or a temporary message ID can
  // therefore never become a bookmark by accident.
  function persistenceEligibleMessage(snapshot, messageId) {
    if (!isPersistenceEligible(snapshot) || typeof messageId !== "string" || !messageId) return null;
    const message = snapshot.messages.find((candidate) => candidate.messageId === messageId) || null;
    return message?.idStatus === "stable" && message.presentationStatus === "formal" ? message : null;
  }

  function isPresentableMessage(message) {
    return Boolean(
      message?.messageId &&
      message.idStatus === "stable" &&
      message.presentationStatus === "formal",
    );
  }

  global.TidySnapshot = Object.freeze({
    VERSION,
    FIELD_STATUS,
    IDENTITY_STATUS,
    BINDING_STATUS,
    MESSAGE_ID_STATUS,
    MESSAGE_PRESENTATION_STATUS,
    COLOR_SCHEMES,
    MAX_MESSAGE_EXCERPT_LENGTH,
    projectIdFromSegment,
    parseConversationPath,
    canonicalConversationPath,
    validate,
    isPersistenceEligible,
    isSidebarPersistenceEligible,
    persistenceEligibleMessage,
    isPresentableMessage,
  });
})(globalThis);
