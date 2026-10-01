// 原生消息正文的纯解码：不读取页面、不请求网络、不拥有导出状态。
(function initTidyChatgptNativeMessageContent(global) {
  "use strict";
  if (global.TidyChatgptNativeMessageContent) return;
  const { publicUrl, imageDescription, createResolver, inlineCodeEnd } = global.TidyChatgptNativeMessageReferences;
  function toIso(value) {
    if (value == null || value === "") return null;
    let number = Number(value);
    if (Number.isFinite(number) && Math.abs(number) < 100_000_000_000) number *= 1000;
    const date = Number.isFinite(number) ? new Date(number) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function textValue(value) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    return typeof value.text === "string" ? value.text
      : typeof value.content === "string" ? value.content
        : "";
  }

  function cleanInlineStyles(value) {
    return String(value || "")
      .replace(/(\*\*|__|~~)([^\n]+?)\1/g, "$2")
      .replace(/(^|[\s(])([*_])([^*_\n]+)\2(?=$|[\s).,!?:;])/g, "$1$3")
      .replace(/`([^`]+)`/g, "$1");
  }

  // 链接包含正文资料，不是可丢弃的样式。只识别片段边界，完整保留其原始
  // Markdown（目标、标题、括号及转义）；不执行 HTML，也不改写目标地址。
  // 顺序扫描避免用一个大正则处理嵌套括号；不完整的候选同样保留原文。
  function inlineLinkEnd(source, opening, budget = null) {
    let depth = 1, quote = "", angle = false, destinationStart = true;
    for (let index = opening + 1; index < source.length; index += 1) {
      if (budget && --budget.remaining < 0) return source.length;
      const character = source[index];
      if (character === "\\") { index += 1; continue; }
      if (quote) { if (character === quote) quote = ""; continue; }
      if (angle) { if (character === ">") angle = false; continue; }
      if (destinationStart && /\s/.test(character)) continue;
      if (destinationStart && character === "<") { destinationStart = false; angle = true; continue; }
      destinationStart = false;
      if ((character === '"' || character === "'") && /\s/.test(source[index - 1])) { quote = character; continue; }
      if (character === "(") depth += 1;
      else if (character === ")" && --depth === 0) return index + 1;
    }
    return source.length;
  }

  function cleanInlineMarkdown(value) {
    const source = String(value || ""), labels = [];
    let output = "", plainStart = 0;
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] === "\\") { index += 1; continue; }
      const codeEnd = inlineCodeEnd(source, index);
      if (codeEnd > index) {
        output += cleanInlineStyles(source.slice(plainStart, index)) + source.slice(index, codeEnd);
        plainStart = codeEnd; index = codeEnd - 1; labels.length = 0; continue;
      }
      if (source[index] === "[") labels.push(index);
      else if (source[index] === "]" && labels.length) {
        const start = labels.pop();
        if (source[index + 1] !== "(") continue;
        const end = inlineLinkEnd(source, index + 1);
        output += cleanInlineStyles(source.slice(plainStart, start)) + source.slice(start, end);
        plainStart = end;
        index = end - 1;
        labels.length = 0;
      }
    }
    return (output + cleanInlineStyles(source.slice(plainStart))).trim();
  }


  // 只处理最终助手明确交付的 sandbox Markdown 链接；路径不成为下载地址，
  // 也不按扩展名猜 MIME。工具路径、裸路径和代码示例都不是附件交付证据。
  function attachmentMarkdownValue(value) {
    const entities = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
    return String(value).replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_\x60{|}~])|&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
      (raw, escaped, entity) => {
        if (escaped) return escaped;
        if (entity[0] !== "#") return entities[entity.toLowerCase()] || raw;
        const point = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : raw;
      });
  }

  function sandboxAttachmentLink(source, start, closing, budget) {
    let index = closing + 2;
    while (/\s/.test(source[index] || "")) index += 1;
    const angle = source[index] === "<";
    if (angle) index += 1;
    // 先确认精确协议/根目录，普通公网链接不进入附件路径解析。
    if (!source.startsWith("sandbox:/mnt/data/", index)) return null;
    const opening = index;
    let depth = 0;
    for (; index < source.length; index += 1) {
      if (--budget.remaining < 0) return null;
      const character = source[index];
      if (character === "\\") { index += 1; continue; }
      if (angle) {
        if (character === ">") break;
        if (character === "\n" || character === "<") return null;
      } else {
        if (character === "(") depth += 1;
        else if (character === ")") { if (!depth) break; depth -= 1; }
        else if (/\s/.test(character)) { if (depth) return null; break; }
      }
    }
    if (depth || (angle && source[index] !== ">")) return null;
    const raw = source.slice(opening, index);
    if (angle) index += 1;
    const spacing = index;
    while (/\s/.test(source[index] || "")) index += 1;
    if (source[index] !== ")") {
      const opener = source[index], closer = opener === "(" ? ")" : opener;
      if (index === spacing || !["\"", "'", "("].includes(opener)) return null;
      index += 1;
      for (; index < source.length && source[index] !== closer; index += 1) {
        if (--budget.remaining < 0) return null;
        if (source[index] === "\\") index += 1;
      }
      if (source[index] !== closer) return null;
      index += 1;
      while (/\s/.test(source[index] || "")) index += 1;
      if (source[index] !== ")") return null;
    }
    const destination = attachmentMarkdownValue(raw);
    if (!destination.startsWith("sandbox:/mnt/data/") || /[?#\u0000-\u001f\u007f]/.test(destination)) return null;
    let segments;
    try { segments = destination.slice("sandbox:/mnt/data/".length).split("/").map(decodeURIComponent); } catch { return null; }
    // 非文件、越界和编码的目录分隔符不被包装成看似可靠的附件。
    if (segments.some(part => !part || part === "." || part === ".." || /[\\/\u0000-\u001f\u007f]/.test(part))
      || !segments[segments.length - 1].trim()) return null;
    return { end: index + 1, attachment: {
      name: segments[segments.length - 1],
      label: cleanInlineStyles(attachmentMarkdownValue(source.slice(start + 1, closing))).trim(),
    } };
  }

  // HTML 标签属性、注释和原样代码容器不是可见的文件交付。
  // closing 跨段落保留，避免含空行的 <pre> / 注释中途恢复附件识别。
  function attachmentMarkupEnd(source, start, budget, state) {
    const consumeClosing = from => {
      const match = new RegExp(state.closing, "i").exec(source.slice(from));
      if (!match) return source.length;
      state.closing = "";
      return from + match.index + match[0].length;
    };
    if (state.closing) return consumeClosing(start);
    if (source.startsWith("<!--", start)) {
      state.closing = "-->";
      return consumeClosing(start + 4);
    }
    const tag = /^<(\/?)([a-z][\w-]*)(?=[\s/>])/i.exec(source.slice(start));
    const autolink = /^<(?:https?:\/\/|mailto:|sandbox:)/i.test(source.slice(start));
    if (!tag && !autolink) return -1;
    let quote = "", index = start + 1;
    for (; index < source.length; index += 1) {
      if (--budget.remaining < 0) return source.length;
      const character = source[index];
      if (quote) { if (character === quote) quote = ""; continue; }
      if (character === "\"" || character === "'") { quote = character; continue; }
      if (character === ">") break;
    }
    if (index >= source.length) return source.length;
    if (tag && !tag[1] && /^(?:code|pre|script|style|textarea)$/i.test(tag[2])
      && source[index - 1] !== "/") {
      state.closing = "</" + tag[2] + "\\s*>";
      return consumeClosing(index + 1);
    }
    return index + 1;
  }

  function replaceFinalAttachments(value, appendAttachment, state) {
    const source = String(value || ""), labels = [];
    const budget = { remaining: Math.max(4096, source.length * 8) };
    let output = "", plainStart = 0;
    for (let index = 0; index < source.length && budget.remaining >= 0; index += 1) {
      if (state.closing || source[index] === "<") {
        const end = attachmentMarkupEnd(source, index, budget, state);
        if (end > index) { index = end - 1; labels.length = 0; continue; }
      }
      if (source[index] === "\\") { index += 1; continue; }
      const codeEnd = inlineCodeEnd(source, index, budget);
      // 跳过代码内部，但保留外层链接标签；[Read code](file) 的标签允许含代码 span。
      if (codeEnd > index) { index = codeEnd - 1; continue; }
      if (source[index] === "[") labels.push(index);
      else if (source[index] === "]" && labels.length) {
        const start = labels.pop();
        if (source[index + 1] !== "(") continue;
        let escapes = 0;
        for (let before = start - 2; before >= 0 && source[before] === "\\"; before -= 1) escapes += 1;
        const image = source[start - 1] === "!" && escapes % 2 === 0;
        const link = image ? null : sandboxAttachmentLink(source, start, index, budget);
        if (!link) {
          // 非附件链接整体保留，不能深入其 URL/title，把里面的文本误当附件。
          index = inlineLinkEnd(source, index + 1, budget) - 1; labels.length = 0; continue;
        }
        output += source.slice(plainStart, start) + appendAttachment(link.attachment);
        plainStart = link.end; index = link.end - 1; labels.length = 0;
      }
    }
    return output + source.slice(plainStart);
  }

  function splitTableRow(line) {
    return line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
  }

  // 从接口返回的 Markdown 正文拆出段落、代码、列表等内容块。
  // 导出使用完整源内容，不拿界面截短后的摘要代替正文。
  function markdownToBlocks(value, resolver = null, appendImage = null, appendAttachment = null) {
    const original = String(value || "");
    let mediaPrefix = "\u0000tidy-media:";
    while (original.includes(mediaPrefix)) mediaPrefix += ":";
    const media = [], attachmentState = {};
    const mark = item => mediaPrefix + (media.push(item) - 1) + "\u0000";
    const appendMedia = item => item.type === "attachment" ? appendAttachment(item.value) : appendImage(item.value);
    const resolve = text => {
      const imagesResolved = resolver ? resolver.replace(text, image => mark({ type: "image", value: image })) : text;
      return appendAttachment
        ? replaceFinalAttachments(imagesResolved, attachment => mark({ type: "attachment", value: attachment }), attachmentState)
        : imagesResolved;
    };
    const lines = original.replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index += 1; continue; }

      // 只有新块开头的四空格/制表符属于缩进代码；段落续行仍由段落消费。
      if (/^(?: {4}|\t)/.test(line)) {
        const code = [];
        while (index < lines.length && (/^(?: {4}|\t)/.test(lines[index]) || !lines[index].trim())) {
          code.push(lines[index].replace(/^(?: {4}|\t)/, "")); index += 1;
        }
        while (code.length && !code[code.length - 1]) code.pop();
        blocks.push({ type: "code", language: "", code: code.join("\n") });
        continue;
      }
      const fence = line.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)$/);
      if (fence) {
        const marker = fence[1][0];
        const length = fence[1].length;
        const code = [];
        index += 1;
        while (index < lines.length && !new RegExp(`^\\s*${marker}{${length},}\\s*$`).test(lines[index])) {
          code.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        blocks.push({ type: "code", language: fence[2].trim().split(/\s+/)[0] || "", code: code.join("\n") });
        continue;
      }

      const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
      if (heading) {
        blocks.push({ type: "heading", level: heading[1].length, text: cleanInlineMarkdown(heading[2]) });
        index += 1;
        continue;
      }

      if (
        index + 1 < lines.length
        && line.includes("|")
        && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])
      ) {
        const headers = splitTableRow(line).map(cleanInlineMarkdown);
        const rows = [];
        index += 2;
        while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
          rows.push(splitTableRow(lines[index]).map(cleanInlineMarkdown));
          index += 1;
        }
        blocks.push({ type: "table", headers, rows });
        continue;
      }

      const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        const type = unordered ? "unordered-list" : "ordered-list";
        const items = [];
        while (index < lines.length) {
          const match = type === "unordered-list"
            ? lines[index].match(/^\s*[-+*]\s+(.+)$/)
            : lines[index].match(/^\s*\d+[.)]\s+(.+)$/);
          if (!match) break;
          items.push(cleanInlineMarkdown(match[1]));
          index += 1;
        }
        blocks.push({ type, items });
        continue;
      }

      if (/^\s*>/.test(line)) {
        const quote = [];
        while (index < lines.length && /^\s*>/.test(lines[index])) {
          quote.push(lines[index].replace(/^\s*>\s?/, ""));
          index += 1;
        }
        blocks.push({ type: "blockquote", text: cleanInlineMarkdown(quote.join("\n")) });
        continue;
      }

      const paragraph = [line];
      index += 1;
      while (index < lines.length && lines[index].trim()) {
        if (/^\s*(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|>|`{3,}|~{3,})/.test(lines[index])) break;
        paragraph.push(lines[index]);
        index += 1;
      }
      blocks.push({ type: "paragraph", text: paragraph.join("\n").trim() });
    }
    // 段落媒体按原顺序成为独立块；表格/列表的图片和附件放在宿主块之后，不破坏其结构。
    const expanded = [];
    const marker = new RegExp(mediaPrefix + "(\\d+)\\u0000", "g");
    for (const block of blocks) {
      // 先识别 Markdown 结构，再只解码非代码块；引用不能改变块边界或改写代码资料。
      if (block.type === "code") { expanded.push(block); continue; }
      if (typeof block.text === "string") block.text = resolve(block.text);
      if (block.items) block.items = block.items.map(resolve);
      if (block.headers) block.headers = block.headers.map(resolve);
      if (block.rows) block.rows = block.rows.map(row => row.map(resolve));
      if (!media.length) { expanded.push(block); continue; }
      const trailing = [];
      const extract = text => String(text).replace(marker, (_, index) => {
        trailing.push(appendMedia(media[Number(index)])); return "";
      });
      if (block.type === "paragraph") {
        let start = 0;
        for (const match of block.text.matchAll(marker)) {
          const text = block.text.slice(start, match.index).trim();
          if (text) expanded.push({ type: "paragraph", text });
          expanded.push(appendMedia(media[Number(match[1])]));
          start = match.index + match[0].length;
        }
        const text = block.text.slice(start).trim();
        if (text) expanded.push({ type: "paragraph", text });
        continue;
      }
      if (typeof block.text === "string") block.text = extract(block.text).trim();
      if (block.items) block.items = block.items.map(item => {
        const delivered = [...String(item).matchAll(marker)].some(match => media[Number(match[1])].type === "attachment");
        const value = extract(item);
        // 纯附件列表项已由独立附件块承接，不留下空 bullet；原本内容和图片规则不变。
        return delivered && !value.trim() ? null : value;
      }).filter(item => item !== null);
      if (block.headers) block.headers = block.headers.map(extract);
      if (block.rows) block.rows = block.rows.map(row => row.map(extract));
      expanded.push(block, ...trailing);
    }
    return expanded.filter((block) => {
      if (["paragraph", "heading", "blockquote"].includes(block.type)) return Boolean(block.text.trim());
      if (["ordered-list", "unordered-list"].includes(block.type)) return block.items.length > 0;
      if (block.type === "code") return Boolean(block.code || block.language);
      if (block.type === "table") return block.headers.length > 0;
      return true;
    });
  }

  const imageResourceId = (sourceMessageId, partIndex) => `${sourceMessageId}:image:${partIndex + 1}`;

  function contentBlocks(message, warnings, resources, sourceMessageId, imageReferences, options = {}) {
    const content = message?.content || {};
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const blocks = [];
    const resolver = createResolver(message);
    let inlineImageIndex = 0, attachmentIndex = 0;
    const resourceIds = new Set(resources.map(resource => resource.id));
    const appendImage = image => {
      let resourceId;
      do { resourceId = sourceMessageId + ":inline-image:" + (++inlineImageIndex); } while (resourceIds.has(resourceId));
      resourceIds.add(resourceId);
      resources.push({ id: resourceId, type: "image", name: image.name || "image-" + inlineImageIndex,
        mimeType: image.mimeType || "", sizeBytes: null, src: image.src || "", alt: image.alt || "" });
      return { type: "image", resourceId, alt: image.alt || "" };
    };
    // 是否为最终回复由会话投影的既有 classifier 决定；这里仍要求明确的最终频道，
    // 防止工具/推理解码意外启用文件提升。最终交付说明与真实 basename 分开保留。
    const appendAttachment = options.finalAttachments === true
      && message?.author?.role === "assistant" && message?.recipient === "all" && message?.channel === "final"
      ? attachment => {
        let resourceId;
        do { resourceId = sourceMessageId + ":attachment:" + (++attachmentIndex); } while (resourceIds.has(resourceId));
        resourceIds.add(resourceId);
        resources.push({ id: resourceId, type: "attachment", name: attachment.name,
          mimeType: "", sizeBytes: null, src: "", alt: "" });
        return { type: "attachment", resourceId, label: attachment.label };
      } : null;
    const contentType = String(content.content_type || "text");
    if (contentType === "code") {
      const code = parts.map(textValue).filter(Boolean).join("\n") || textValue(content.text);
      if (code) blocks.push({ type: "code", language: String(content.language || ""), code });
    } else {
      for (const [partIndex, part] of parts.entries()) {
        const text = textValue(part);
        if (text) blocks.push(...markdownToBlocks(text, resolver, appendImage, appendAttachment));
        if (!part || typeof part !== "object") continue;
        const partType = String(part.content_type || part.type || "");
        if (/image/i.test(partType)) {
          const descriptor = imageDescription(part);
          const { src, alt } = descriptor;
          const resourceId = imageResourceId(sourceMessageId, partIndex);
          resources.push({
            id: resourceId,
            type: "image",
            name: descriptor.name || `image-${partIndex + 1}`,
            mimeType: descriptor.mimeType,
            sizeBytes: null,
            src,
            alt,
          });
          blocks.push({
            type: "image",
            resourceId,
            alt,
          });
          if (descriptor.sourceLink) blocks.push({ type: "paragraph", text: descriptor.sourceLink });
          // 上传图片返回文件引用，不是公开 URL。先登记，用户实际选择它时再查地址。
          const fileId = /^sediment:\/\/(file_[a-f0-9]{32})$/i.exec(String(part.asset_pointer || ""))?.[1];
          if (!src && fileId && imageReferences) imageReferences.set(resourceId, fileId);
          else if (!src) warnings.add("IMAGE_UNAVAILABLE");
        }
      }
    }
    if (!blocks.length) {
      const fallback = textValue(content.text || content.result || message?.text);
      if (fallback) blocks.push(...markdownToBlocks(fallback, resolver, appendImage, appendAttachment));
    }
    return blocks;
  }


  global.TidyChatgptNativeMessageContent = Object.freeze({ toIso, textValue, imageResourceId, cleanInlineMarkdown, markdownToBlocks, publicUrl, contentBlocks });
})(globalThis);
