// 原生推理、工具与来源记录的纯投影；正文解码与过程分组各自只有一份规则。
(function initTidyChatgptNativeMessageProcess(global) {
  "use strict";
  if (global.TidyChatgptNativeMessageProcess) return;
  const { toIso, textValue, contentBlocks, imageResourceId } = global.TidyChatgptNativeMessageContent;
  const { sourcesFromReference, finalSources, dedupeSources } = global.TidyChatgptNativeMessageReferences;

  function isHiddenMessage(message) {
    const contentType = String(message?.content?.content_type || "");
    return message?.metadata?.is_visually_hidden_from_conversation === true
      || ["model_editable_context", "user_editable_context"].includes(contentType);
  }

  function isFinalAssistantMessage(message) {
    if (message?.author?.role !== "assistant" || isHiddenMessage(message)) return false;
    const contentType = String(message?.content?.content_type || "text");
    const recipient = message?.recipient;
    return !["thoughts", "reasoning_recap"].includes(contentType)
      && message?.metadata?.reasoning_status !== "is_reasoning"
      && message?.metadata?.is_thinking_preamble_message !== true
      && (recipient == null || recipient === "all");
  }

  // 生成结果本身是用户可见内容，不等于“工具过程”。工具名可能是每次不同的
  // 内部别名，因此优先认图片 part 自身的生成身份，而不是猜别名或匹配标题。
  // 只有结构化图片可以提升；普通工具图片、过程文字和 Markdown 图片仍归过程。
  const IMAGE_GENERATION_TOOLS = new Set(["image_gen", "image_gen.text2im", "dalle", "dalle.text2im"]);
  function hasImageGenerationIdentity(part) {
    return [part?.metadata?.generation?.gen_id, part?.metadata?.dalle?.gen_id]
      .some(id => typeof id === "string" && Boolean(id.trim()));
  }

  function visibleGeneratedImageResourceIds(message, sourceMessageId) {
    if (message?.author?.role !== "tool" || isHiddenMessage(message)
      || message?.metadata?.reasoning_status === "is_reasoning"
      || message?.metadata?.is_thinking_preamble_message === true
      || (message?.recipient != null && message.recipient !== "all")) return new Set();
    const name = String(message?.author?.name || message?.metadata?.tool_name || "").trim();
    const explicitImageTool = IMAGE_GENERATION_TOOLS.has(name);
    const parts = Array.isArray(message?.content?.parts) ? message.content.parts : [];
    return new Set(parts.flatMap((part, index) => (
      part && ["image_asset_pointer", "image"].includes(String(part.content_type || part.type || ""))
        && (hasImageGenerationIdentity(part) || explicitImageTool)
        ? [imageResourceId(sourceMessageId, index)] : []
    )));
  }

  function thoughtProcessBlocks(message, warnings, resources, sourceMessageId, imageReferences) {
    if (!message || isHiddenMessage(message)) return [];
    const content = message.content || {};
    const contentType = String(content.content_type || "");
    const blocks = [];
    const decode = text => contentBlocks({ ...message, content: { content_type: "text", parts: [text] } },
      warnings, resources, sourceMessageId, imageReferences);

    if (contentType === "thoughts" && Array.isArray(content.thoughts)) {
      for (const thought of content.thoughts) {
        const summary = textValue(thought?.summary).trim();
        const detail = textValue(thought?.content).trim();
        if (summary) blocks.push(...decode("#### " + summary));
        if (detail) blocks.push(...decode(detail));
      }
    }

    if (contentType === "reasoning_recap") {
      const recap = textValue(content.content || content.text || content.parts?.[0]).trim();
      if (recap) blocks.push(...decode(recap.split("\n").map(line => "> " + line).join("\n")));
    }

    if (message?.metadata?.is_thinking_preamble_message === true) {
      const preamble = (Array.isArray(content.parts) ? content.parts : [])
        .map(textValue)
        .filter(Boolean)
        .join("\n")
        .trim();
      if (preamble) blocks.push(...decode(preamble));
    }

    return blocks;
  }

  function sourceFromSearchEntry(entry) {
    return sourcesFromReference({
      url: entry?.url || entry?.link,
      title: entry?.title || entry?.name,
    })[0] || null;
  }

  function searchResults(message) {
    const groups = message?.metadata?.search_result_groups;
    if (!Array.isArray(groups)) return [];
    const seen = new Set();
    return groups.flatMap((group) => Array.isArray(group?.entries) ? group.entries : [])
      .map(sourceFromSearchEntry)
      .filter((source) => {
        if (!source || seen.has(source.url)) return false;
        seen.add(source.url);
        return true;
      });
  }

  function reasoningQueries(message) {
    if (message?.metadata?.reasoning_status !== "is_reasoning") return [];
    const rawQueries = Array.isArray(message.metadata.search_queries)
      ? message.metadata.search_queries
      : [];
    const queries = rawQueries.map((query) => {
      if (typeof query === "string") return query.trim();
      return String(query?.query || query?.q || query?.text || "").trim();
    }).filter(Boolean);
    return queries;
  }

  function explicitTool(message) {
    const name = String(
      (message?.recipient != null && message.recipient !== "all" ? message.recipient : "")
      || message?.author?.name
      || message?.metadata?.tool_name
      || "",
    ).trim();
    if (!name) return null;
    const callId = String(message?.metadata?.tool_call_id || message?.metadata?.call_id || "");
    return { name, callId };
  }

  function processSegment(message, sourceMessageId, warnings, resources, imageReferences) {
    const timestamp = toIso(message.create_time);
    const contentType = String(message?.content?.content_type || "");
    const reasoningBlocks = thoughtProcessBlocks(message, warnings, resources, sourceMessageId, imageReferences);
    const queries = reasoningQueries(message);
    const results = searchResults(message);
    const tool = explicitTool(message);
    const label = String(message?.metadata?.reasoning_title || message?.metadata?.title || "");
    const hasSearchStructure = queries.length > 0
      || results.length > 0
      || tool?.name === "web.run";

    if (hasSearchStructure) {
      return {
        type: "process",
        sourceMessageId,
        timestamp,
        category: "search",
        phase: results.length > 0 ? "result" : "request",
        label,
        blocks: reasoningBlocks,
        queries,
        results,
        tool,
      };
    }

    if (reasoningBlocks.length) {
      return {
        type: "process",
        sourceMessageId,
        timestamp,
        category: "reasoning",
        phase: ["thoughts", "reasoning_recap"].includes(contentType) ? "summary" : "event",
        label,
        blocks: reasoningBlocks,
        queries: [],
        results: [],
        tool: null,
      };
    }

    if (tool || message?.author?.role === "tool") {
      const readableBlocks = contentBlocks(message, warnings, resources, sourceMessageId, imageReferences);
      return {
        type: "process",
        sourceMessageId,
        timestamp,
        category: "tool",
        phase: message?.author?.role === "tool" ? "result" : "request",
        label,
        blocks: readableBlocks,
        queries: [],
        results: [],
        tool: tool || { name: "tool", callId: "" },
      };
    }

    const readableBlocks = contentBlocks(message, warnings, resources, sourceMessageId, imageReferences);
    if (!readableBlocks.length && !label) return null;
    return {
      type: "process",
      sourceMessageId,
      timestamp,
      category: "generic",
      phase: "event",
      label,
      blocks: readableBlocks,
      queries: [],
      results: [],
      tool: null,
    };
  }


  global.TidyChatgptNativeMessageProcess = Object.freeze({ isHiddenMessage, isFinalAssistantMessage, visibleGeneratedImageResourceIds, finalSources, dedupeSources, processSegment });
})(globalThis);
