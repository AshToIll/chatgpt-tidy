(function initTidyExportContract(global) {
  "use strict";

  if (global.TidyExportContract) return;

  const VERSION = "chatgpt-tidy.export-source.v2";
  const COLLECTION_VERSION = "chatgpt-tidy.export-source-collection.v2";
  const BLOCK_TYPES = Object.freeze([
    "paragraph",
    "heading",
    "ordered-list",
    "unordered-list",
    "blockquote",
    "code",
    "table",
    "image",
    "attachment",
    "link",
  ]);
  const RESOURCE_TYPES = Object.freeze(["image", "attachment"]);
  const SEGMENT_TYPES = Object.freeze(["content", "process", "sources"]);
  const PROCESS_CATEGORIES = Object.freeze(["reasoning", "search", "tool", "generic"]);
  const PROCESS_PHASES = Object.freeze(["summary", "request", "result", "event"]);
  const LEGACY_MESSAGE_FIELDS = Object.freeze([
    "contentBlocks",
    "visibleProcess",
    "webSearches",
    "finalSources",
    "name",
    "displayName",
    "display_name",
  ]);

  function nonEmptyString(value) {
    return typeof value === "string" && Boolean(value.trim());
  }

  function hasOwn(value, key) {
    return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
  }

  function validateSource(source, prefix, errors) {
    if (!source || typeof source !== "object") {
      errors.push(prefix);
      return;
    }
    if (!nonEmptyString(source.title)) errors.push(`${prefix}.title`);
    if (!nonEmptyString(source.url)) errors.push(`${prefix}.url`);
    if (typeof source.domain !== "string") errors.push(`${prefix}.domain`);
  }

  function validateResource(resource, index, errors) {
    const prefix = `conversation.resources[${index}]`;
    if (!resource || typeof resource !== "object") {
      errors.push(prefix);
      return;
    }
    if (!nonEmptyString(resource.id)) errors.push(`${prefix}.id`);
    if (!RESOURCE_TYPES.includes(resource.type)) errors.push(`${prefix}.type`);
    if (!nonEmptyString(resource.name)) errors.push(`${prefix}.name`);
    if (typeof resource.mimeType !== "string") errors.push(`${prefix}.mimeType`);
    if (resource.sizeBytes !== null && (!Number.isInteger(resource.sizeBytes) || resource.sizeBytes < 0)) {
      errors.push(`${prefix}.sizeBytes`);
    }
    if (typeof resource.src !== "string") errors.push(`${prefix}.src`);
    if (hasOwn(resource, "temporaryUrl") && typeof resource.temporaryUrl !== "boolean") errors.push(`${prefix}.temporaryUrl`);
    if (hasOwn(resource, "pending") && typeof resource.pending !== "boolean") errors.push(`${prefix}.pending`);
    if (resource.pending && (resource.type !== "image" || !nonEmptyString(resource.readHandle))) errors.push(`${prefix}.readHandle`);
    if (typeof resource.alt !== "string") errors.push(`${prefix}.alt`);
  }

  function validateBlock(block, prefix, errors, resourcesById) {
    if (!block || !BLOCK_TYPES.includes(block.type)) {
      errors.push(`${prefix}.type`);
      return;
    }
    if (["paragraph", "blockquote"].includes(block.type) && typeof block.text !== "string") {
      errors.push(`${prefix}.text`);
    }
    if (block.type === "heading") {
      if (!Number.isInteger(block.level) || block.level < 1 || block.level > 6) errors.push(`${prefix}.level`);
      if (typeof block.text !== "string") errors.push(`${prefix}.text`);
    }
    if (["ordered-list", "unordered-list"].includes(block.type)) {
      if (!Array.isArray(block.items) || block.items.some((item) => typeof item !== "string")) {
        errors.push(`${prefix}.items`);
      }
    }
    if (block.type === "code" && (typeof block.language !== "string" || typeof block.code !== "string")) {
      errors.push(`${prefix}.code`);
    }
    if (block.type === "table") {
      if (!Array.isArray(block.headers) || block.headers.some((item) => typeof item !== "string")) {
        errors.push(`${prefix}.headers`);
      }
      if (
        !Array.isArray(block.rows)
        || block.rows.some((row) => !Array.isArray(row) || row.some((item) => typeof item !== "string"))
      ) errors.push(`${prefix}.rows`);
    }
    if (block.type === "image") {
      if (!nonEmptyString(block.resourceId) || resourcesById.get(block.resourceId) !== "image") {
        errors.push(`${prefix}.resourceId`);
      }
      if (typeof block.alt !== "string") errors.push(`${prefix}.alt`);
      if (hasOwn(block, "src") || hasOwn(block, "source")) errors.push(`${prefix}.legacyImageSource`);
    }
    if (block.type === "attachment") {
      // 文件名来自资源；label 保留原交付链接的说明，不与文件名混写。
      if (hasOwn(block, "label") && typeof block.label !== "string") errors.push(`${prefix}.label`);
      if (!nonEmptyString(block.resourceId) || resourcesById.get(block.resourceId) !== "attachment") {
        errors.push(`${prefix}.resourceId`);
      }
    }
    if (block.type === "link" && (typeof block.text !== "string" || !nonEmptyString(block.url))) {
      errors.push(`${prefix}.link`);
    }
  }

  function validateSegment(segment, prefix, errors, resourcesById) {
    if (!segment || !SEGMENT_TYPES.includes(segment.type)) {
      errors.push(`${prefix}.type`);
      return;
    }
    if (!nonEmptyString(segment.sourceMessageId)) errors.push(`${prefix}.sourceMessageId`);
    if (segment.timestamp !== null && typeof segment.timestamp !== "string") errors.push(`${prefix}.timestamp`);

    if (segment.type === "content") {
      if (!Array.isArray(segment.blocks) || !segment.blocks.length) {
        errors.push(`${prefix}.blocks`);
      } else {
        segment.blocks.forEach((block, blockIndex) =>
          validateBlock(block, `${prefix}.blocks[${blockIndex}]`, errors, resourcesById));
      }
      return;
    }

    if (segment.type === "sources") {
      if (!Array.isArray(segment.items) || !segment.items.length) {
        errors.push(`${prefix}.items`);
      } else {
        segment.items.forEach((source, sourceIndex) =>
          validateSource(source, `${prefix}.items[${sourceIndex}]`, errors));
      }
      return;
    }

    if (!PROCESS_CATEGORIES.includes(segment.category)) errors.push(`${prefix}.category`);
    if (!PROCESS_PHASES.includes(segment.phase)) errors.push(`${prefix}.phase`);
    if (typeof segment.label !== "string") errors.push(`${prefix}.label`);
    if (!Array.isArray(segment.blocks)) {
      errors.push(`${prefix}.blocks`);
    } else {
      segment.blocks.forEach((block, blockIndex) =>
        validateBlock(block, `${prefix}.blocks[${blockIndex}]`, errors, resourcesById));
    }
    if (!Array.isArray(segment.queries) || segment.queries.some((query) => typeof query !== "string")) {
      errors.push(`${prefix}.queries`);
    }
    if (!Array.isArray(segment.results)) {
      errors.push(`${prefix}.results`);
    } else {
      segment.results.forEach((source, sourceIndex) =>
        validateSource(source, `${prefix}.results[${sourceIndex}]`, errors));
    }
    if (segment.tool !== null) {
      if (!segment.tool || typeof segment.tool !== "object" || !nonEmptyString(segment.tool.name)) {
        errors.push(`${prefix}.tool.name`);
      } else if (typeof segment.tool.callId !== "string") {
        errors.push(`${prefix}.tool.callId`);
      }
    }
    const readable = Boolean(
      segment.label?.trim()
      || segment.blocks?.length
      || segment.queries?.length
      || segment.results?.length
      || segment.tool?.name,
    );
    if (!readable) errors.push(`${prefix}.emptyProcess`);
    if (segment.category === "tool" && !segment.tool?.name) errors.push(`${prefix}.tool`);
  }

  function validateMessage(message, index, errors, resourcesById) {
    const prefix = `conversation.messages[${index}]`;
    if (!nonEmptyString(message?.id)) errors.push(`${prefix}.id`);
    if (message?.messageNumber !== index + 1) errors.push(`${prefix}.messageNumber`);
    if (!["user", "assistant"].includes(message?.role)) errors.push(`${prefix}.role`);
    if (message?.timestamp !== null && typeof message?.timestamp !== "string") errors.push(`${prefix}.timestamp`);
    const legacyFields = LEGACY_MESSAGE_FIELDS.filter((field) => hasOwn(message, field));
    if (legacyFields.length) errors.push(`${prefix}.legacyFields`);
    if (!Array.isArray(message?.segments) || !message.segments.length) {
      errors.push(`${prefix}.segments`);
      return;
    }
    message.segments.forEach((segment, segmentIndex) =>
      validateSegment(segment, `${prefix}.segments[${segmentIndex}]`, errors, resourcesById));
    if (message.role === "user" && message.segments.some((segment) => segment?.type !== "content")) {
      errors.push(`${prefix}.userSegments`);
    }
  }

  function validateDocument(value) {
    const errors = [];
    if (!value || value.schemaVersion !== VERSION) errors.push("schemaVersion");
    const conversation = value?.conversation;
    if (!nonEmptyString(conversation?.id)) errors.push("conversation.id");
    if (typeof conversation?.title !== "string") errors.push("conversation.title");
    if (typeof conversation?.createdAt !== "string") errors.push("conversation.createdAt");
    if (typeof conversation?.updatedAt !== "string") errors.push("conversation.updatedAt");
    if (conversation?.sourceUrl != null && typeof conversation.sourceUrl !== "string") {
      errors.push("conversation.sourceUrl");
    }

    const resourcesById = new Map();
    if (!Array.isArray(conversation?.resources)) {
      errors.push("conversation.resources");
    } else {
      conversation.resources.forEach((resource, index) => {
        validateResource(resource, index, errors);
        if (resourcesById.has(resource?.id)) errors.push(`conversation.resources[${index}].duplicateId`);
        resourcesById.set(resource?.id, resource?.type);
      });
    }

    if (!Array.isArray(conversation?.messages) || !conversation.messages.length) {
      errors.push("conversation.messages");
    } else {
      const seen = new Set();
      conversation.messages.forEach((message, index) => {
        validateMessage(message, index, errors, resourcesById);
        if (seen.has(message?.id)) errors.push(`conversation.messages[${index}].duplicateId`);
        seen.add(message?.id);
      });
    }
    // Warning codes, never translated prose: panel language can change while
    // this source document remains cached.
    if (!Array.isArray(value?.warnings) || value.warnings.some((warning) => warning !== "IMAGE_UNAVAILABLE")) {
      errors.push("warnings");
    }
    return { valid: errors.length === 0, errors };
  }

  /**
   * A batch read is one all-or-nothing collection. Keeping the collection
   * contract beside the single-document contract lets every bridge layer reject
   * partial, duplicated, or shape-shifted ChatGPT responses in the same way.
   */
  function validateCollection(value) {
    const errors = [];
    if (!value || value.schemaVersion !== COLLECTION_VERSION) errors.push("schemaVersion");
    if (!Array.isArray(value?.documents) || !value.documents.length) {
      errors.push("documents");
      return { valid: false, errors };
    }
    const seen = new Set();
    value.documents.forEach((document, index) => {
      const validation = validateDocument(document);
      validation.errors.forEach((error) => errors.push(`documents[${index}].${error}`));
      const conversationId = document?.conversation?.id;
      if (seen.has(conversationId)) errors.push(`documents[${index}].duplicateConversationId`);
      seen.add(conversationId);
    });
    return { valid: errors.length === 0, errors };
  }

  global.TidyExportContract = Object.freeze({
    VERSION,
    COLLECTION_VERSION,
    BLOCK_TYPES,
    RESOURCE_TYPES,
    SEGMENT_TYPES,
    PROCESS_CATEGORIES,
    PROCESS_PHASES,
    validateDocument,
    validateCollection,
    validResource(resource) { const errors = []; validateResource(resource, 0, errors); return errors.length === 0; },
  });
})(globalThis);
