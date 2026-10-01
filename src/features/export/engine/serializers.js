/* 按已经筛选好的片段生成文本格式（Markdown、HTML、TXT、JSON），不改变内容顺序。 */
(function (root) {
  'use strict';

  const api = root.TidyExport = root.TidyExport || {};
  const encoder = new TextEncoder();
  const defaultOptions = { timestamps: true, messageNumbers: true };
  // 导出角色名不跟随界面语言；需要昵称时由用户自行填写。修改默认名称只改这里。
  const DEFAULT_ROLE_NAMES = Object.freeze({ user: 'User', assistant: 'Assistant' });

  function text(context, key, values) { return api.exportText(context.messages, key, values); }

  function resolveRoleNames(roleNames = {}) {
    return { user: roleNames.user || DEFAULT_ROLE_NAMES.user, assistant: roleNames.assistant || DEFAULT_ROLE_NAMES.assistant };
  }

  function roleName(message, roleNames) {
    return resolveRoleNames(roleNames)[message.role === 'assistant' ? 'assistant' : 'user'];
  }

  function formatTimestamp(value, context) {
    return typeof context?.formatTimestamp === 'function' ? context.formatTimestamp(value) : value;
  }

  function resourcesById(resources) {
    return new Map((resources || []).map((resource) => [resource.id, resource]));
  }

  function stablePublicUrl(value) {
    const source = String(value || '').trim();
    if (!/^https?:\/\//i.test(source)) return '';
    try {
      const parsed = new URL(source);
      const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      if (!['http:', 'https:'].includes(parsed.protocol) || !host) return '';
      if (host === 'localhost' || host.endsWith('.local') || host === '::1' || /^(?:fc|fd|fe8|fe9|fea|feb)/i.test(host)) return '';
      const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
      if (ipv4) {
        const [a, b] = ipv4;
        if (ipv4.some((part) => part > 255) || a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && [18, 19].includes(b)) || a >= 224) return '';
      }
      return source;
    } catch (error) {
      return '';
    }
  }

  function formatBytes(value) {
    if (!Number.isInteger(value) || value < 0) return '';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
    return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function resourceDetails(resource) {
    return [resource?.mimeType, formatBytes(resource?.sizeBytes)].filter(Boolean).join(' · ');
  }

  // MD/TXT 保留图片说明与已有可用链接，不嵌图、不下载、不推测临时文件地址。
  function imagePresentation(block, context = {}) {
    const resource = context.resourcesById?.get(block.resourceId);
    const name = block.alt || resource?.alt || resource?.name || text(context, 'exportImage');
    const sourceUrl = resource?.temporaryUrl ? '' : stablePublicUrl(resource?.src);
    return { name, sourceUrl, originalUrl: sourceUrl ? '' : stablePublicUrl(context.sourceUrl) };
  }

  function quoteMarkdown(value) {
    return String(value || '').split('\n').map((line) => `> ${line}`.trimEnd()).join('\n');
  }

  // 交付说明与来源只随附件一起显示，不在正文再复制一份绕过媒体开关。
  // 原会话链接不是文件直链；资源 src 不用于下载或推测 sandbox 文件地址。
  function attachmentPresentation(block, context = {}) {
    const resource = context.resourcesById?.get(block.resourceId);
    const name = resource?.name || text(context, 'exportUnnamedAttachment');
    const suppliedLabel = typeof block.label === 'string' ? block.label.trim() : '';
    return { name, details: resourceDetails(resource),
      label: suppliedLabel && suppliedLabel !== name ? suppliedLabel : '',
      sourceUrl: suppliedLabel ? stablePublicUrl(context.sourceUrl) : '' };
  }

  function markdownAttachment(block, context) {
    const { name, details, label, sourceUrl } = attachmentPresentation(block, context);
    const description = label ? label.replace(/([\\`*_{}\[\]<>])/g, '\\$1') : '';
    const lines = [`**${text(context, 'exportAttachment')}**`,
      `\`${name.replace(/`/g, '\\`')}\`${details ? ` · ${details}` : ''}`,
      description, sourceUrl ? api.formatMarkdownLink(text(context, 'exportOpenOriginal'), sourceUrl) : ''];
    return quoteMarkdown(lines.filter(Boolean).join('\n\n'));
  }

  function markdownBlocks(blocks, context = {}) {
    return (blocks || []).map(block => {
      const value = markdownBlock(block, context);
      // 原生适配未识别的图片引用/HTML 也只能作文字显示；代码示例保持原字面量。
      return block.type === 'code' ? value : api.markdownTextWithoutImages(value);
    }).filter(Boolean).join('\n\n');
  }

  function markdownBlock(block, context) {
    if (block.type === 'paragraph') return String(block.text || '');
    if (block.type === 'heading') return `${'#'.repeat(block.level)} ${String(block.text || '')}`;
    if (block.type === 'unordered-list') return block.items.map((item) => `- ${String(item || '')}`).join('\n');
    if (block.type === 'ordered-list') return block.items.map((item, index) => `${index + 1}. ${String(item || '')}`).join('\n');
    if (block.type === 'blockquote') return quoteMarkdown(String(block.text || ''));
    if (block.type === 'code') {
      const longest = Math.max(3, ...((block.code.match(/`+/g) || []).map((item) => item.length + 1)));
      const fence = '`'.repeat(longest);
      return `${fence}${block.language || ''}\n${block.code}\n${fence}`;
    }
    if (block.type === 'table') {
      // Canonical inline links may already escape pipes. Add only missing table escapes.
      const escapeCell = (value) => String(value || '').replace(/(\\*)\|/g, (_, slashes) => slashes + (slashes.length % 2 ? '' : '\\') + '|').replace(/\n/g, '<br>');
      const headers = block.headers.map(escapeCell);
      return `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${block.rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`).join('\n')}`;
    }
    if (block.type === 'image') {
      const { name, sourceUrl, originalUrl } = imagePresentation(block, context);
      const description = sourceUrl ? api.formatMarkdownLink(name, sourceUrl) : name.replace(/([\\`*_{}\[\]<>])/g, '\\$1');
      return quoteMarkdown(['**' + text(context, 'exportImage') + '**', description,
        originalUrl ? api.formatMarkdownLink(text(context, 'exportOpenOriginal'), originalUrl) : ''].filter(Boolean).join('\n\n'));
    }
    if (block.type === 'attachment') return markdownAttachment(block, context);
    if (block.type === 'link') return api.formatMarkdownLink(block.text, block.url);
    return '';
  }

  function processCategoryLabel(category, messages) {
    const key = category === 'search' ? 'exportWebProcess' : category === 'tool' ? 'exportToolProcess' : 'exportVisibleProcess';
    return api.exportText(messages, key);
  }

  function processSubLabel(segment, context) {
    const label = String(segment?.label || '').trim();
    return label && label !== processCategoryLabel(segment?.category, context.messages) ? label : '';
  }

  // Render one process segment's payload without its category heading. The
  // caller adds that heading once for an adjacent same-category group.
  function markdownProcessBody(segment, context) {
    const lines = [];
    const subLabel = processSubLabel(segment, context);
    if (subLabel) lines.push(`**${subLabel}**`);
    if (segment.tool?.name) lines.push(text(context, 'exportToolLabel', { name: segment.tool.name }));
    if (segment.blocks?.length) lines.push(markdownBlocks(segment.blocks, context));
    segment.queries?.forEach((query) => lines.push(text(context, 'exportQueryLabel', { query })));
    segment.results?.forEach((source) => lines.push('- ' + api.formatMarkdownLink(source.title, source.url)));
    return lines.filter(Boolean).join('\n\n');
  }

  function markdownProcessGroup(group, context) {
    const lines = [`**${processCategoryLabel(group.category, context.messages)}**`];
    group.segments.forEach((segment) => {
      const body = markdownProcessBody(segment, context);
      if (body) lines.push(body);
    });
    return quoteMarkdown(lines.filter(Boolean).join('\n\n'));
  }

  function markdownProcess(segment, context) {
    return markdownProcessGroup({ category: segment.category, segments: [segment] }, context);
  }

  function markdownSegment(segment, context) {
    if (segment.type === 'content') return markdownBlocks(segment.blocks, context);
    if (segment.type === 'process') return markdownProcess(segment, context);
    if (segment.type === 'process-group') return markdownProcessGroup(segment, context);
    if (segment.type === 'sources') return `### ${text(context, 'exportFinalSources')}\n\n${segment.items.map((source) => '- ' + api.formatMarkdownLink(source.title, source.url)).join('\n')}`;
    return '';
  }

  function txtBlocks(blocks, context = {}) {
    return (blocks || []).map((block) => {
      if (block.type === 'paragraph' || block.type === 'heading') return api.inlinePlainText(block.text);
      if (block.type === 'unordered-list') return block.items.map((item) => `- ${api.inlinePlainText(item)}`).join('\n');
      if (block.type === 'ordered-list') return block.items.map((item, index) => `${index + 1}. ${api.inlinePlainText(item)}`).join('\n');
      if (block.type === 'blockquote') return api.inlinePlainText(block.text).split('\n').map((line) => `> ${line}`).join('\n');
      if (block.type === 'code') return block.code.split('\n').map((line) => `    ${line}`).join('\n');
      if (block.type === 'table') return [block.headers, ...block.rows].map((row) => row.map((cell) => api.inlinePlainText(cell)).join(' | ')).join('\n');
      if (block.type === 'image') {
        const { name, sourceUrl, originalUrl } = imagePresentation(block, context);
        return ['[' + text(context, 'exportImageLabel', { name }) + ']', sourceUrl,
          originalUrl ? api.plainLinkText(text(context, 'exportOpenOriginal'), originalUrl) : ''].filter(Boolean).join('\n');
      }
      if (block.type === 'attachment') {
        const { name, details, label, sourceUrl } = attachmentPresentation(block, context);
        return [`[${text(context, 'exportAttachmentLabel', { name })}]${details ? ` ${details}` : ''}`,
          label, sourceUrl ? api.plainLinkText(text(context, 'exportOpenOriginal'), sourceUrl) : ''].filter(Boolean).join('\n');
      }
      if (block.type === 'link') return api.plainLinkText(api.inlinePlainText(block.text), block.url);
      return '';
    }).filter(Boolean).join('\n\n');
  }

  function txtProcessBody(segment, context) {
    const lines = [];
    const subLabel = processSubLabel(segment, context);
    if (subLabel) lines.push(subLabel);
    if (segment.tool?.name) lines.push(text(context, 'exportToolLabel', { name: segment.tool.name }));
    if (segment.blocks?.length) lines.push(txtBlocks(segment.blocks, context));
    segment.queries?.forEach((query) => lines.push(text(context, 'exportQueryLabel', { query })));
    segment.results?.forEach((source) => lines.push(`- ${source.title} · ${source.url}`));
    return lines.filter(Boolean).join('\n');
  }

  function txtProcessGroup(group, context) {
    const lines = [`【${processCategoryLabel(group.category, context.messages)}】`];
    group.segments.forEach((segment) => {
      const body = txtProcessBody(segment, context);
      if (body) lines.push(body);
    });
    return lines.join('\n');
  }

  function txtSegment(segment, context) {
    if (segment.type === 'content') return txtBlocks(segment.blocks, context);
    if (segment.type === 'process') return txtProcessGroup({ category: segment.category, segments: [segment] }, context);
    if (segment.type === 'process-group') return txtProcessGroup(segment, context);
    if (segment.type === 'sources') return `【${text(context, 'exportFinalSources')}】\n${segment.items.map((source) => `- ${source.title} · ${source.url}`).join('\n')}`;
    return '';
  }

  function markdownMessage(message, context) {
    const options = { ...defaultOptions, ...(context.options || {}) };
    const meta = [];
    if (options.messageNumbers) meta.push(`#${message.messageNumber}`);
    if (options.timestamps && message.timestamp) meta.push(formatTimestamp(message.timestamp, context));
    return [
      `## ${roleName(message, context.roleNames)}${meta.length ? ` · ${meta.join(' · ')}` : ''}`,
      ...api.groupAdjacentProcessSegments(message.segments).map((segment) => markdownSegment(segment, context)),
    ].filter(Boolean).join('\n\n');
  }

  function txtMessage(message, context) {
    const options = { ...defaultOptions, ...(context.options || {}) };
    const meta = [];
    if (options.messageNumbers) meta.push(`#${message.messageNumber}`);
    if (options.timestamps && message.timestamp) meta.push(formatTimestamp(message.timestamp, context));
    return [
      `${roleName(message, context.roleNames)}${meta.length ? `  ${meta.join('  ')}` : ''}`,
      ...api.groupAdjacentProcessSegments(message.segments).map((segment) => txtSegment(segment, context)),
    ].filter(Boolean).join('\n\n');
  }

  function publicResource(resource) {
    const src = resource.temporaryUrl ? '' : stablePublicUrl(resource.src);
    return {
      id: resource.id,
      type: resource.type,
      ...(resource.name ? { name: resource.name } : {}),
      ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
      ...(resource.sizeBytes != null ? { sizeBytes: resource.sizeBytes } : {}),
      ...(resource.alt ? { alt: resource.alt } : {}),
      ...(src ? { src } : {}),
    };
  }

  function publicBlock(block) {
    if (block.type === 'image') return { type: 'image', resourceId: block.resourceId, alt: block.alt };
    if (block.type === 'attachment') return { type: 'attachment', resourceId: block.resourceId,
      ...(typeof block.label === 'string' ? { label: block.label } : {}) };
    return cloneWithoutUndefined(block);
  }

  function cloneWithoutUndefined(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function publicSegment(segment) {
    if (segment.type === 'content') {
      return { type: 'content', timestamp: segment.timestamp, blocks: segment.blocks.map(publicBlock) };
    }
    if (segment.type === 'process') {
      return {
        type: 'process', timestamp: segment.timestamp, category: segment.category, phase: segment.phase,
        label: segment.label, blocks: segment.blocks.map(publicBlock), queries: [...segment.queries],
        results: segment.results.map(cloneWithoutUndefined),
        tool: segment.tool ? cloneWithoutUndefined(segment.tool) : null,
      };
    }
    return { type: 'sources', timestamp: segment.timestamp, items: segment.items.map(cloneWithoutUndefined) };
  }

  function jsonMessage(message, context) {
    const options = { ...defaultOptions, ...(context.options || {}) };
    return {
      id: message.id,
      role: message.role,
      // role 是供程序读取的原始角色；自定义名称只影响 displayName。
      displayName: roleName(message, context.roleNames),
      ...(options.messageNumbers ? { messageNumber: message.messageNumber } : {}),
      ...(options.timestamps && message.timestamp ? { timestamp: message.timestamp } : {}),
      segments: message.segments.map(publicSegment),
    };
  }

  function referencedResourceIds(messages) {
    const ids = new Set();
    for (const message of messages) for (const segment of message.segments) for (const block of segment.blocks || []) {
      if (['image', 'attachment'].includes(block.type)) ids.add(block.resourceId);
    }
    return ids;
  }

  function conversationJson(conversation, context, selectedMessages = conversation.messages) {
    const ids = referencedResourceIds(selectedMessages);
    return {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      ...(conversation.sourceUrl ? { sourceUrl: conversation.sourceUrl } : {}),
      resources: conversation.resources.filter((resource) => ids.has(resource.id)).map(publicResource),
      messages: selectedMessages.map((message) => jsonMessage(message, context)),
    };
  }

  function conversationContext(conversation, context, file) {
    return {
      ...context,
      conversationId: conversation.id,
      sourceUrl: conversation.sourceUrl || '',
      resourcesById: resourcesById(conversation.resources),
    };
  }

  function conversationMarkdown(conversation, context, file, selectedMessages = conversation.messages) {
    const local = conversationContext(conversation, context, file);
    const header = [`# ${conversation.title}`, context.options?.timestamps ? `> ${formatTimestamp(conversation.createdAt, context)} ～ ${formatTimestamp(conversation.updatedAt, context)}` : '', conversation.sourceUrl ? '> ' + api.formatMarkdownLink(text(context, 'exportOpenOriginal'), conversation.sourceUrl) : ''].filter(Boolean).join('\n\n');
    return `${header}\n\n${selectedMessages.map((message) => markdownMessage(message, local)).join('\n\n---\n\n')}`;
  }

  function conversationTxt(conversation, context, selectedMessages = conversation.messages) {
    const local = conversationContext(conversation, context, {});
    const header = [conversation.title, context.options?.timestamps ? `${formatTimestamp(conversation.createdAt, context)} ～ ${formatTimestamp(conversation.updatedAt, context)}` : '', conversation.sourceUrl || ''].filter(Boolean).join('\n');
    return `${header}\n${'='.repeat(56)}\n\n${selectedMessages.map((message) => txtMessage(message, local)).join('\n\n' + '-'.repeat(56) + '\n\n')}`;
  }

  function bookmarkConversations(file) {
    const grouped = new Map();
    file.bookmarkEntries.forEach((entry) => {
      if (!grouped.has(entry.conversation.id)) grouped.set(entry.conversation.id, { ...entry.conversation, entries: [] });
      grouped.get(entry.conversation.id).entries.push(entry);
    });
    return [...grouped.values()].sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt));
  }

  function serializeMarkdown(file, context) {
    if (file.kind === 'conversation') return file.conversations.map((conversation) => conversationMarkdown(conversation, context, file)).join('\n\n\n***\n\n\n');
    const sections = bookmarkConversations(file).map((conversation) => {
      const local = conversationContext(conversation, context, file);
      const messages = conversation.entries.map((entry) => `${markdownMessage(entry.message, local)}\n\n*${text(context, 'exportFromGroup', { name: entry.groupName })}*`).join('\n\n---\n\n');
      return `## ${conversation.title}\n\n${conversation.sourceUrl ? api.formatMarkdownLink(text(context, 'exportOpenOriginal'), conversation.sourceUrl) + '\n\n' : ''}${messages}`;
    });
    return `# ${text(context, 'exportBookmarkExcerpt')}\n\n> ${text(context, 'exportExcerptNotice')}\n\n${sections.join('\n\n\n***\n\n\n')}`;
  }

  function serializeTxt(file, context) {
    if (file.kind === 'conversation') return file.conversations.map((conversation) => conversationTxt(conversation, context)).join('\n\n' + '='.repeat(72) + '\n\n');
    const sections = bookmarkConversations(file).map((conversation) => {
      const local = conversationContext(conversation, context, {});
      const messages = conversation.entries.map((entry) => `${txtMessage(entry.message, local)}\n${text(context, 'exportFromGroup', { name: entry.groupName })}`).join('\n\n' + '-'.repeat(56) + '\n\n');
      return `${conversation.title}\n${conversation.sourceUrl || ''}\n\n${messages}`;
    });
    return `${text(context, 'exportBookmarkExcerpt')}\n${text(context, 'exportExcerptNotice')}\n${'='.repeat(56)}\n\n${sections.join('\n\n' + '='.repeat(72) + '\n\n')}`;
  }

  function serializeJson(file, context) {
    if (file.kind === 'conversation') {
      const body = file.conversations.length === 1
        ? { schemaVersion: 'chatgpt-tidy.export.v3', documentType: 'conversation', conversation: conversationJson(file.conversations[0], context) }
        : { schemaVersion: 'chatgpt-tidy.export.v3', documentType: 'conversationCollection', conversations: file.conversations.map((conversation) => conversationJson(conversation, context)) };
      return JSON.stringify(body, null, 2);
    }
    const conversations = bookmarkConversations(file).map((conversation) => {
      const selectedMessages = conversation.entries.map((entry) => entry.message);
      const output = conversationJson(conversation, context, selectedMessages);
      output.messages = conversation.entries.map((entry) => ({ ...jsonMessage(entry.message, context), bookmarkGroup: entry.groupName }));
      return output;
    });
    return JSON.stringify({ schemaVersion: 'chatgpt-tidy.export.v3', documentType: 'bookmarkExcerpt', conversations }, null, 2);
  }

  function serializeTextFile(file, format, context = {}) {
    if (format === 'markdown') return serializeMarkdown(file, context);
    if (format === 'json') return serializeJson(file, context);
    if (format === 'txt') return serializeTxt(file, context);
    throw api.exportError('exportUnsupportedFormat', { format });
  }

  function serializeTextBytes(file, format, context = {}) {
    return encoder.encode(serializeTextFile(file, format, context));
  }

  // 小预览只消费开头，不把长会话的每条消息先格式化一遍。
  // JSON 仍走完整序列化以保持真实字段/缩进顺序；全文预览与下载不截断。
  function serializeTextExcerpt(file, format, context = {}, limit = 2600) {
    if (format === 'json' || file.kind !== 'conversation') return serializeTextFile(file, format, context).slice(0, limit + 1);
    const markdown = format === 'markdown';
    if (!markdown && format !== 'txt') throw api.exportError('exportUnsupportedFormat', { format });
    let output = '';
    for (const [index, conversation] of file.conversations.entries()) {
      if (index) output += markdown ? '\n\n\n***\n\n\n' : '\n\n' + '='.repeat(72) + '\n\n';
      output += markdown ? conversationMarkdown(conversation, context, file, []) : conversationTxt(conversation, context, []);
      const local = conversationContext(conversation, context, file);
      for (const [messageIndex, message] of conversation.messages.entries()) {
        if (output.length > limit) return output.slice(0, limit + 1);
        if (messageIndex) output += markdown ? '\n\n---\n\n' : '\n\n' + '-'.repeat(56) + '\n\n';
        output += markdown ? markdownMessage(message, local) : txtMessage(message, local);
      }
      if (output.length > limit) return output.slice(0, limit + 1);
    }
    return output;
  }

  // 从已经按用户开关筛选的同一份文件计划生成图文预览，图片保留原消息位置。
  // 文本复用正式序列化规则；临时图片地址只用于屏幕显示，不成为可携带文件中的链接。
  function serializePreviewParts(file, context = {}, maxText = Infinity) {
    const parts = [];
    let remaining = maxText;
    const addText = value => {
      if (!value || remaining <= 0) return;
      const previous = parts[parts.length - 1];
      if (previous?.type === 'text') remaining -= 2;
      const clipped = value.slice(0, Math.max(0, remaining));
      remaining -= value.length;
      value = clipped + (remaining < 0 ? '\n…' : '');
      if (previous?.type === 'text') previous.text += '\n\n' + value;
      else parts.push({ type: 'text', text: value });
    };
    function blocks(items, local) {
      for (const block of items || []) {
        if (remaining <= 0) return;
        const resource = local.resourcesById.get(block.resourceId);
        if (block.type === 'image' && resource?.src) {
          const alt = block.alt || resource.alt || resource.name || text(local, 'exportImage');
          parts.push({ type: 'image', src: resource.src, alt, failureText: text(local, 'exportImagePreviewFailed', { name: alt }) });
        } else addText(txtBlocks([block], local));
      }
    }
    const conversations = file.kind === 'conversation' ? file.conversations : bookmarkConversations(file);
    if (file.kind !== 'conversation') addText(text(context, 'exportExcerptNotice'));
    for (const conversation of conversations) {
      if (remaining <= 0) break;
      const local = conversationContext(conversation, context, file);
      addText(conversationTxt(conversation, context, []));
      const entries = file.kind === 'conversation' ? conversation.messages.map(message => ({ message })) : conversation.entries;
      for (const entry of entries) {
        if (remaining <= 0) break;
        addText(txtMessage({ ...entry.message, segments: [] }, local));
        for (const segment of api.groupAdjacentProcessSegments(entry.message.segments)) {
          if (remaining <= 0) break;
          if (segment.type === 'content') blocks(segment.blocks, local);
          else if (segment.type === 'process-group') {
            addText(`【${processCategoryLabel(segment.category, context.messages)}】`);
            for (const item of segment.segments) {
              addText(txtProcessBody({ ...item, blocks: [], queries: [], results: [] }, local));
              blocks(item.blocks, local);
              addText(txtProcessBody({ ...item, label: '', tool: null, blocks: [] }, local));
            }
          } else addText(txtSegment(segment, local));
        }
        if (entry.groupName) addText(text(local, 'exportFromGroup', { name: entry.groupName }));
      }
    }
    return parts;
  }

  Object.assign(api, {
    resolveRoleNames, roleName, stablePublicUrl, imagePresentation, processCategoryLabel, attachmentPresentation,
    markdownBlocks, txtBlocks, jsonMessage,
    serializeMarkdown, serializeJson, serializeTxt, serializeTextFile, serializeTextBytes, serializeTextExcerpt, bookmarkConversations,
    serializePreviewParts,
  });
}(typeof globalThis !== 'undefined' ? globalThis : window));
