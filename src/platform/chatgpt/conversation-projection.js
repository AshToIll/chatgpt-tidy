// 活动分支的唯一逻辑消息分组：快照编号与导出内容共用，既不依赖功能模块也不保留原始正文。
(function initTidyChatgptConversationProjection(global) {
  "use strict";
  if (global.TidyChatgptConversationProjection) return;
  const { toIso, contentBlocks } = global.TidyChatgptNativeMessageContent;
  const { isHiddenMessage, isFinalAssistantMessage, visibleGeneratedImageResourceIds, finalSources, dedupeSources, processSegment } = global.TidyChatgptNativeMessageProcess;
  const { activeBranch, responseConversationId } = global.TidyChatgptActiveBranch;
  // 这些是原生投影本身的不变量，不借用导出文件格式契约。否则损坏的
  // 同一响应可能被导出拒绝，却被快照编号接受成 stableIdentity。
  function assertProjection(document) {
    const errors = [];
    const nonEmpty = value => typeof value === "string" && Boolean(value.trim());
    if (!nonEmpty(document.conversation.id)) errors.push("conversation.id");
    const resources = new Set();
    for (const [index, resource] of document.conversation.resources.entries()) {
      const prefix = `conversation.resources[${index}]`;
      if (!nonEmpty(resource.name)) errors.push(`${prefix}.name`);
      if (resources.has(resource.id)) errors.push(`${prefix}.duplicateId`);
      resources.add(resource.id);
    }
    const messages = new Set();
    for (const [index, message] of document.conversation.messages.entries()) {
      const prefix = `conversation.messages[${index}]`;
      if (!nonEmpty(message.id)) errors.push(`${prefix}.id`);
      if (messages.has(message.id)) errors.push(`${prefix}.duplicateId`);
      messages.add(message.id);
      for (const [segmentIndex, segment] of message.segments.entries()) {
        const segmentPrefix = `${prefix}.segments[${segmentIndex}]`;
        if (!nonEmpty(segment.sourceMessageId)) errors.push(`${segmentPrefix}.sourceMessageId`);
        if (segment.type === "process" && !(segment.label.trim() || segment.blocks.length
          || segment.queries.length || segment.results.length || segment.tool?.name)) {
          errors.push(`${segmentPrefix}.emptyProcess`);
        }
        const sources = segment.type === "sources" ? segment.items
          : segment.type === "process" ? segment.results : [];
        for (const [sourceIndex, source] of sources.entries()) {
          if (!nonEmpty(source.title)) errors.push(`${segmentPrefix}.sources[${sourceIndex}].title`);
        }
      }
    }
    if (errors.length) throw new Error(`Invalid canonical conversation projection: ${errors.join(", ")}`);
  }

  function projectConversation(payload, expectedConversationId, value = {}, sourceUrl = "", imageReferences = null) {
    const warnings = new Set();
    const messages = [];
    const resources = [];
    let assistantSegments = [];

    function flushAssistantMessage() {
      if (!assistantSegments.length) return;
      const primary = [...assistantSegments].reverse().find((segment) => segment.type === "content")
        || assistantSegments[assistantSegments.length - 1];
      messages.push({
        id: primary.sourceMessageId,
        messageNumber: messages.length + 1,
        role: "assistant",
        timestamp: primary.timestamp,
        segments: assistantSegments,
      });
      assistantSegments = [];
    }

    for (const node of activeBranch(payload)) {
      const message = node?.message;
      const role = message?.author?.role;
      if (!message || isHiddenMessage(message)) continue;
      const sourceMessageId = String(message.id || node.id || `source-${messages.length + assistantSegments.length + 1}`);
      const timestamp = toIso(message.create_time);

      if (role === "user") {
        flushAssistantMessage();
        const blocks = contentBlocks(message, warnings, resources, sourceMessageId, imageReferences);
        if (!blocks.length) continue;
        messages.push({
          id: sourceMessageId,
          messageNumber: messages.length + 1,
          role: "user",
          timestamp,
          segments: [{ type: "content", sourceMessageId, timestamp, blocks }],
        });
        continue;
      }

      if (role === "assistant" && isFinalAssistantMessage(message)) {
        // 只有已确认的最终回复允许把显式文件交付转为附件；过程解码不启用。
        const blocks = contentBlocks(message, warnings, resources, sourceMessageId, imageReferences, { finalAttachments: true });
        if (blocks.length) {
          assistantSegments.push({ type: "content", sourceMessageId, timestamp, blocks });
        }
        const sources = dedupeSources(finalSources(message));
        if (sources.length) {
          assistantSegments.push({ type: "sources", sourceMessageId, timestamp, items: sources });
        }
        continue;
      }

      if (!["assistant", "tool"].includes(role)) continue;
      const process = processSegment(message, sourceMessageId, warnings, resources, imageReferences);
      if (process) {
        const visibleImages = process.category === "tool" ? visibleGeneratedImageResourceIds(message, sourceMessageId) : new Set();
        if (!visibleImages.size) { assistantSegments.push(process); continue; }
        // 解码只做一次，资源句柄不复制。图片和工具文字按原有顺序分别归属；
        // 关闭工具过程只隐藏过程文字，关闭图片才隐藏最终生成图。
        let current = null;
        for (const block of process.blocks) {
          const type = block.type === "image" && visibleImages.has(block.resourceId) ? "content" : "process";
          if (!current || current.type !== type) {
            current = type === "content"
              ? { type, sourceMessageId, timestamp, blocks: [] }
              : { ...process, blocks: [] };
            assistantSegments.push(current);
          }
          current.blocks.push(block);
        }
        if (!process.blocks.length) assistantSegments.push(process);
      }
    }
    flushAssistantMessage();
    if (!messages.length) throw new Error("The current conversation has no exportable messages.");

    const createdAt = toIso(payload.create_time) || messages.find((message) => message.timestamp)?.timestamp || "";
    const updatedAt = toIso(payload.update_time) || [...messages].reverse().find((message) => message.timestamp)?.timestamp || createdAt;
    const document = {
      conversation: {
        id: expectedConversationId,
        title: String(payload.title || value.fallbackTitle || ""),
        createdAt,
        updatedAt,
        sourceUrl,
        resources,
        messages,
      },
      warnings: [...warnings],
    };
    assertProjection(document);
    return document;
  }

  function messageNumbersFromPayload(payload, conversationId) {
    const responseId = responseConversationId(payload);
    if (responseId && responseId !== conversationId) throw new Error("The numbered conversation changed.");
    const document = projectConversation(payload, conversationId);
    const exactIds = new Set(activeBranch(payload).map(node => node.message?.id).filter(id => typeof id === "string" && id));
    const numbers = Object.create(null);
    for (const message of document.conversation.messages) {
      for (const id of [message.id, ...message.segments.map(segment => segment.sourceMessageId)]) {
        if (exactIds.has(id)) numbers[id] = message.messageNumber;
      }
    }
    return numbers;
  }


  global.TidyChatgptConversationProjection = Object.freeze({ projectConversation, messageNumbersFromPayload });
})(globalThis);
