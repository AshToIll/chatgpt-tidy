/* 导出内容整理：校验并规范化源数据，再按用户开关筛选正文、过程、来源和媒体。
   保持原始片段顺序，不凭空补内容；不发请求、不生成下载文件。 */
(function (root) {
  'use strict';

  const api = root.TidyExport = root.TidyExport || {};
  const MEDIA_BLOCK_TYPES = new Set(['image', 'attachment']);
  // 产品默认只有正文：来源列表和图片/附件需手动开启。UI 与文件规划共享此处，避免默认值漂移。
  const DEFAULT_PROJECTION_OPTIONS = Object.freeze({
    visibleProcess: false,
    toolProcess: false,
    webProcess: false,
    finalSources: false,
    mediaAttachments: false,
  });

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function safeDomain(url) {
    try { return new URL(url).hostname; } catch (error) { return ''; }
  }

  function dedupeSources(sources) {
    const seen = new Set();
    return (Array.isArray(sources) ? sources : []).filter((source) => {
      const url = String(source?.url || '').trim();
      if (!url || seen.has(url)) return false;
      seen.add(url);
      return true;
    }).map((source) => ({
      title: String(source.title || source.url),
      url: String(source.url),
      domain: String(source.domain || safeDomain(source.url)),
    }));
  }

  function normalizeBlock(block) {
    if (!block || typeof block !== 'object') return null;
    const type = String(block.type || 'paragraph');
    if (['paragraph', 'blockquote'].includes(type)) return { type, text: String(block.text || '') };
    if (type === 'heading') return { type, level: Math.min(6, Math.max(1, Number(block.level) || 2)), text: String(block.text || '') };
    if (type === 'ordered-list' || type === 'unordered-list') return { type, items: (block.items || []).map(String) };
    if (type === 'code') return { type, language: String(block.language || ''), code: String(block.code || '') };
    if (type === 'table') return { type, headers: (block.headers || []).map(String), rows: (block.rows || []).map((row) => row.map(String)) };
    if (type === 'image') return { type, resourceId: String(block.resourceId || ''), alt: String(block.alt || '') };
    if (type === 'attachment') return { type, resourceId: String(block.resourceId || ''),
      ...(typeof block.label === 'string' ? { label: block.label } : {}) };
    if (type === 'link') return { type, text: String(block.text || block.url || ''), url: String(block.url || '') };
    return null;
  }

  function normalizeResource(resource) {
    if (!resource || typeof resource !== 'object') return null;
    const type = resource.type === 'attachment' ? 'attachment' : resource.type === 'image' ? 'image' : '';
    if (!resource.id || !type) return null;
    const size = resource.sizeBytes == null ? null : Number(resource.sizeBytes);
    return {
      id: String(resource.id),
      type,
      name: String(resource.name || ''),
      mimeType: String(resource.mimeType || ''),
      sizeBytes: Number.isInteger(size) && size >= 0 ? size : null,
      src: String(resource.src || ''),
      ...(resource.temporaryUrl === true ? { temporaryUrl: true } : {}),
      ...(resource.pending === true ? { pending: true } : {}),
      alt: String(resource.alt || ''),
    };
  }

  function normalizeSegment(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const common = {
      sourceMessageId: String(raw.sourceMessageId || ''),
      timestamp: raw.timestamp == null ? null : String(raw.timestamp),
    };
    if (raw.type === 'content') {
      return { type: 'content', ...common, blocks: (raw.blocks || []).map(normalizeBlock).filter(Boolean) };
    }
    if (raw.type === 'process') {
      if (!['reasoning', 'search', 'tool', 'generic'].includes(raw.category)) throw api.exportError('exportInvalidDataField', { field: 'process.category' });
      if (!['summary', 'request', 'result', 'event'].includes(raw.phase)) throw api.exportError('exportInvalidDataField', { field: 'process.phase' });
      const tool = raw.tool && typeof raw.tool === 'object'
        ? { name: String(raw.tool.name || ''), callId: String(raw.tool.callId || '') }
        : null;
      return {
        type: 'process', ...common, category: raw.category, phase: raw.phase,
        label: String(raw.label || ''),
        blocks: (raw.blocks || []).map(normalizeBlock).filter(Boolean),
        queries: (raw.queries || []).map(String).filter(Boolean),
        results: dedupeSources(raw.results),
        tool,
      };
    }
    if (raw.type === 'sources') {
      return { type: 'sources', ...common, items: dedupeSources(raw.items) };
    }
    return null;
  }

  function normalizeMessage(raw) {
    if (!raw?.id || !Number.isFinite(Number(raw.messageNumber))) throw api.exportError('exportInvalidDataField', { field: 'message.id / messageNumber' });
    if (!Array.isArray(raw.segments)) throw api.exportError('exportInvalidDataField', { field: 'message.segments' });
    if (!['user', 'assistant'].includes(raw.role)) throw api.exportError('exportInvalidDataField', { field: 'message.role' });
    return {
      id: String(raw.id),
      messageNumber: Number(raw.messageNumber),
      role: raw.role,
      timestamp: raw.timestamp == null ? null : String(raw.timestamp),
      segments: raw.segments.map(normalizeSegment).filter(Boolean),
    };
  }

  function normalizeConversation(raw) {
    if (!Array.isArray(raw?.resources)) throw api.exportError('exportInvalidDataField', { field: 'conversation.resources' });
    return {
      id: String(raw.id),
      title: String(raw.title || ''),
      createdAt: String(raw.createdAt || ''),
      updatedAt: String(raw.updatedAt || raw.createdAt || ''),
      ...(raw.sourceUrl ? { sourceUrl: String(raw.sourceUrl) } : {}),
      resources: raw.resources.map(normalizeResource).filter(Boolean),
      messages: (raw.messages || []).map(normalizeMessage),
    };
  }

  // Normalize real export input without dropping unresolved selections. The
  // planner owns completeness checks and must be able to explain every bookmark.
  function normalizeExportData(raw) {
    if (!raw || typeof raw !== 'object') throw api.exportError('exportDataMissing');
    const conversations = (raw.conversations || []).map(normalizeConversation);
    const bookmarks = (raw.bookmarks || []).map((bookmark) => ({
      id: String(bookmark.id), conversationId: String(bookmark.conversationId), messageId: String(bookmark.messageId),
      bookmarkedAt: String(bookmark.bookmarkedAt || ''), groupId: bookmark.groupId == null ? null : String(bookmark.groupId),
    }));
    return { schemaVersion: '3.0', conversations, bookmarks };
  }

  function blockToPlainText(block, resourcesById = new Map()) {
    if (!block) return '';
    if (['paragraph', 'heading', 'blockquote'].includes(block.type)) return block.text;
    if (block.type === 'ordered-list' || block.type === 'unordered-list') return block.items.join(' ');
    if (block.type === 'code') return block.code;
    if (block.type === 'table') return [block.headers, ...block.rows].flat().join(' ');
    if (block.type === 'image') {
      const resource = resourcesById.get(block.resourceId);
      return block.alt || resource?.alt || resource?.name || '';
    }
    if (block.type === 'attachment') {
      const name = resourcesById.get(block.resourceId)?.name || '';
      const label = typeof block.label === 'string' ? block.label.trim() : '';
      return [name, label !== name ? label : ''].filter(Boolean).join(' ');
    }
    if (block.type === 'link') return [block.text, block.url].filter(Boolean).join(' ');
    return '';
  }

  function blocksToPlainText(blocks, resources = []) {
    const resourcesById = resources instanceof Map ? resources : new Map((resources || []).map((item) => [item.id, item]));
    return (blocks || []).map((block) => blockToPlainText(block, resourcesById)).filter(Boolean).join('\n');
  }

  function segmentToPlainText(segment, resources = []) {
    if (segment?.type === 'content') return blocksToPlainText(segment.blocks, resources);
    if (segment?.type === 'process') {
      return [segment.label, blocksToPlainText(segment.blocks, resources), ...(segment.queries || []), ...(segment.results || []).map((item) => item.title)].filter(Boolean).join('\n');
    }
    if (segment?.type === 'sources') return (segment.items || []).map((item) => item.title).join('\n');
    return '';
  }

  function segmentsToPlainText(segments, resources = []) {
    return (segments || []).map((segment) => segmentToPlainText(segment, resources)).filter(Boolean).join('\n');
  }

  function filterMediaBlocks(blocks, mediaAttachments) {
    if (mediaAttachments) return (blocks || []).map(clone);
    return (blocks || []).filter((block) => !MEDIA_BLOCK_TYPES.has(block.type)).map(clone);
  }

  // Reading serializers use this view-only grouping to avoid repeating a
  // process heading for every adjacent source event. The source segments are
  // never mutated or merged in JSON; each child remains available for audit.
  function groupAdjacentProcessSegments(segments) {
    const output = [];
    let current = null;
    for (const segment of segments || []) {
      if (segment?.type === 'process') {
        if (current && current.category === segment.category) {
          current.segments.push(segment);
        } else {
          current = { type: 'process-group', category: segment.category, segments: [segment] };
          output.push(current);
        }
        continue;
      }
      current = null;
      output.push(segment);
    }
    return output;
  }

  function processHasContent(segment) {
    return Boolean(segment.label || segment.blocks.length || segment.queries.length || segment.results.length || segment.tool);
  }

  function projectSegment(segment, options) {
    if (segment.type === 'content') {
      const blocks = filterMediaBlocks(segment.blocks, options.mediaAttachments);
      return blocks.length ? { ...segment, blocks } : null;
    }
    if (segment.type === 'process') {
      const enabled = segment.category === 'search'
        ? options.webProcess
        : segment.category === 'tool'
          ? options.toolProcess
          : options.visibleProcess;
      if (!enabled) return null;
      const projected = { ...clone(segment), blocks: filterMediaBlocks(segment.blocks, options.mediaAttachments) };
      return processHasContent(projected) ? projected : null;
    }
    if (segment.type === 'sources') return options.finalSources && segment.items.length ? clone(segment) : null;
    return null;
  }

  function referencedResourceIds(messages) {
    const ids = new Set();
    for (const message of messages) {
      for (const segment of message.segments) {
        for (const block of segment.blocks || []) {
          if (MEDIA_BLOCK_TYPES.has(block.type) && block.resourceId) ids.add(block.resourceId);
        }
      }
    }
    return ids;
  }

  function projectConversation(conversation, rawOptions = {}) {
    const options = { ...DEFAULT_PROJECTION_OPTIONS, ...rawOptions };
    const messages = conversation.messages.map((message) => {
      const segments = message.segments.map((segment) => projectSegment(segment, options)).filter(Boolean);
      return segments.length ? { ...message, segments } : null;
    }).filter(Boolean);
    const resourceIds = referencedResourceIds(messages);
    return {
      // 正规化后的其余字段都是标量；不先复制整段正文再覆盖 messages/resources。
      ...conversation, messages,
      resources: conversation.resources.filter((resource) => resourceIds.has(resource.id)).map(clone),
    };
  }

  function projectExportData(data, options = {}) {
    const conversations = data.conversations.map((conversation) => projectConversation(conversation, options));
    // Content switches may empty a selected message. Preserve the selection so
    // the planner reports that exclusion instead of quietly producing less data.
    const bookmarks = data.bookmarks.map(clone);
    return { ...clone(data), conversations, bookmarks };
  }

  Object.assign(api, {
    clone, dedupeSources, normalizeBlock, normalizeResource, normalizeSegment, normalizeMessage, normalizeConversation,
    normalizeExportData, blockToPlainText, blocksToPlainText, segmentToPlainText, segmentsToPlainText,
    groupAdjacentProcessSegments, projectConversation, projectExportData, DEFAULT_PROJECTION_OPTIONS,
  });
}(typeof globalThis !== 'undefined' ? globalThis : window));
