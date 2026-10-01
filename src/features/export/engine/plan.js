/* 导出文件规划：决定拆成几个文件及文件名；图片不会把 Markdown 单文件变成 ZIP，不生成文件内容也不开始下载。 */
(function (root) {
  'use strict';

  const api = root.TidyExport = root.TidyExport || {};

  function cleanBaseName(value, fallback) {
    const cleaned = String(value || '').normalize('NFKC')
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
      .replace(/[. ]+$/g, '').replace(/\s+/g, ' ').trim();
    // 仍以 120 个 UTF-16 单元为文件名上限，但不能把末尾 emoji 截成半个字符。
    // 在规划边界统一确保合法 Unicode，让 ZIP 成员名与链接编码使用同一串文字。
    return (cleaned || fallback).slice(0, 120).replace(/[\uD800-\uDBFF]$/, '').toWellFormed();
  }

  function uniquifyFiles(files, t) {
    const occupied = new Set();
    return files.map((file) => {
      const folderKey = file.folder || '';
      const base = cleanBaseName(file.baseName, t(file.kind === 'bookmark-excerpt' ? 'exportBookmarkExcerpt' : 'untitled'));
      const keyFor = (name) => `${folderKey}\u0000${name}`.toLowerCase();
      let candidate = base;
      let suffix = 2;
      // Reserve the actual output name, not only the original title. A title
      // such as "A (2)" can collide with a suffix assigned to an earlier "A".
      while (occupied.has(keyFor(candidate))) candidate = `${base} (${suffix++})`;
      occupied.add(keyFor(candidate));
      return { ...file, baseName: candidate };
    });
  }

  function sortConversations(conversations) {
    return [...conversations].sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt));
  }

  function fileConversationSelections(file) {
    if (file.kind === 'conversation') {
      return file.conversations.map((conversation) => ({ conversation, messages: conversation.messages }));
    }
    const grouped = new Map();
    file.bookmarkEntries.forEach((entry) => {
      if (!grouped.has(entry.conversation.id)) grouped.set(entry.conversation.id, { conversation: entry.conversation, messages: [] });
      grouped.get(entry.conversation.id).messages.push(entry.message);
    });
    return [...grouped.values()];
  }

  function selectedBookmarkEntries(data, bookmarkIds, bookmarkGroups, messages, missingMessageReason = 'message-unavailable') {
    const conversations = new Map(data.conversations.map((item) => [item.id, item]));
    const bookmarks = new Map(data.bookmarks.map((item) => [item.id, item]));
    const groupNames = new Map((bookmarkGroups || []).filter((group) => !['all'].includes(group.id)).map((group) => [group.id, group.name]));
    const missingBookmarks = [];
    const entries = [...new Set(bookmarkIds || [])].map((bookmarkId) => {
      const bookmark = bookmarks.get(bookmarkId);
      const conversation = conversations.get(bookmark?.conversationId);
      const message = conversation?.messages.find((item) => item.id === bookmark?.messageId);
      if (!bookmark || !conversation || !message) {
        missingBookmarks.push({ bookmarkId, conversationId: bookmark?.conversationId || null,
          messageId: bookmark?.messageId || null,
          reason: !bookmark ? 'bookmark-unavailable' : !conversation ? 'conversation-unavailable' : missingMessageReason });
        return null;
      }
      return {
        bookmarkId: bookmark.id,
        groupId: bookmark.groupId,
        groupName: groupNames.get(bookmark.groupId || 'ungrouped') || api.exportText(messages, 'ungrouped'),
        bookmarkedAt: bookmark.bookmarkedAt,
        conversation: {
          id: conversation.id, title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
          ...(conversation.sourceUrl ? { sourceUrl: conversation.sourceUrl } : {}), resources: conversation.resources,
        },
        message
      };
    });
    if (missingBookmarks.length) {
      throw Object.assign(api.exportError('exportSelectionIncomplete'), { code: 'EXPORT_SELECTION_INCOMPLETE', missingBookmarks });
    }
    return entries.sort((left, right) => {
      const conversationOrder = new Date(left.conversation.createdAt) - new Date(right.conversation.createdAt);
      return conversationOrder || left.message.messageNumber - right.message.messageNumber;
    });
  }

  function groupBy(items, getKey) {
    const groups = new Map();
    items.forEach((item) => {
      const key = getKey(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    return groups;
  }

  function buildExportPlan(config) {
    const messages = config.messages;
    const t = (key, values) => api.exportText(messages, key, values);
    if (!config.data) throw api.exportError('exportDataMissing');
    // Check the source before projection so the UI can distinguish a missing
    // active-branch message from one intentionally excluded by content switches.
    if (config.mode !== 'current') selectedBookmarkEntries(config.data, config.bookmarkIds || [], config.bookmarkGroups || [], messages);
    // Project once, before both resource planning and rendering. This makes
    // the shared content switches authoritative for every output format.
    const data = api.projectExportData(config.data, config.options || {});
    // Missing metadata stays language-neutral until this job's presentation boundary.
    data.conversations = data.conversations.map((conversation) => ({ ...conversation, title: conversation.title || t('untitled') }));
    const format = config.format || 'markdown';
    const extension = { markdown: 'md', json: 'json', txt: 'txt', pdf: 'pdf' }[format];
    if (!extension) throw api.exportError('exportUnsupportedFormat', { format });
    const names = config.names || {};
    const allConversations = new Map(data.conversations.map((item) => [item.id, item]));

    if (config.mode === 'current') {
      const conversation = allConversations.get(config.currentConversationId);
      if (!conversation) throw api.exportError('exportCurrentMissing');
      const file = { kind: 'conversation', baseName: cleanBaseName(names.current, conversation.title), customKey: 'current', conversations: [conversation] };
      return finalizePlan([file], extension, false, names.zip, format, 'current', messages);
    }

    const selectedIds = [...new Set(config.conversationIds || [])];
    const missingConversations = selectedIds.filter((id) => !allConversations.has(id));
    if (missingConversations.length) {
      throw Object.assign(api.exportError('exportConversationsIncomplete'), { code: 'EXPORT_SELECTION_INCOMPLETE', missingConversations, missingBookmarks: [] });
    }
    const selectedConversations = sortConversations(selectedIds.map((id) => allConversations.get(id)));
    const bookmarkEntries = selectedBookmarkEntries(data, config.bookmarkIds || [], config.bookmarkGroups || [], messages, 'content-excluded');
    const conversationFiles = [];
    const bookmarkFiles = [];

    if (selectedConversations.length) {
      if (selectedConversations.length === 1 || config.conversationOrganization !== 'all-conversations') {
        selectedConversations.forEach((conversation) => conversationFiles.push({ kind: 'conversation', baseName: conversation.title, conversations: [conversation] }));
      } else {
        conversationFiles.push({ kind: 'conversation', baseName: cleanBaseName(names.mergedConversations, t('exportMergedConversationsName')), customKey: 'mergedConversations', conversations: selectedConversations });
      }
    }

    if (bookmarkEntries.length) {
      const organization = config.bookmarkOrganization || 'all-bookmarks';
      if (organization === 'per-conversation' && new Set(bookmarkEntries.map((item) => item.conversation.id)).size >= 2) {
        groupBy(bookmarkEntries, (item) => item.conversation.id).forEach((entries) => {
          bookmarkFiles.push({ kind: 'bookmark-excerpt', baseName: t('exportConversationExcerpt', { title: entries[0].conversation.title }), bookmarkEntries: entries });
        });
      } else if (organization === 'per-bookmark-group' && new Set(bookmarkEntries.map((item) => item.groupId || 'ungrouped')).size >= 2) {
        groupBy(bookmarkEntries, (item) => item.groupId || 'ungrouped').forEach((entries) => {
          bookmarkFiles.push({ kind: 'bookmark-excerpt', baseName: entries[0].groupName, bookmarkEntries: entries, bookmarkGroupName: entries[0].groupName });
        });
      } else {
        bookmarkFiles.push({ kind: 'bookmark-excerpt', baseName: cleanBaseName(names.mergedBookmarks, t('exportBookmarkExcerpt')), customKey: 'mergedBookmarks', bookmarkEntries });
      }
    }

    const mixed = conversationFiles.length > 0 && bookmarkFiles.length > 0;
    const rawFiles = [
      ...conversationFiles.map((file) => ({ ...file, folder: mixed ? t('exportConversationSection') : '' })),
      ...bookmarkFiles.map((file) => ({ ...file, folder: mixed ? t('bookmarks') : '' }))
    ];
    if (!rawFiles.length) throw api.exportError('exportNoFiles');
    // A true single-file result is always editable, regardless of which
    // organization route produced it.
    if (rawFiles.length === 1 && !rawFiles[0].customKey) {
      rawFiles[0].baseName = cleanBaseName(names.single, rawFiles[0].baseName);
      rawFiles[0].customKey = 'single';
    }
    const zipped = mixed || rawFiles.length > 1;
    return finalizePlan(rawFiles, extension, zipped, names.zip, format, 'batch', messages);
  }

  function finalizePlan(rawFiles, extension, zipped, zipName, format, mode, messages) {
    const t = (key, values) => api.exportText(messages, key, values);
    const files = uniquifyFiles(rawFiles, t).map((file) => ({
      ...file,
      fileName: `${file.baseName}.${extension}`,
      path: [file.folder, `${file.baseName}.${extension}`].filter(Boolean).join('/')
    }));
    const outputName = zipped ? `${cleanBaseName(zipName, t('exportDefaultName'))}.zip` : files[0].fileName;
    return {
      schemaVersion: 'tidy-plan-2', messages, mode, format, extension, zipped, outputName, files,
      title: zipped ? t('exportPlanFiles', { count: files.length }) : files[0].fileName,
      counts: {
        conversations: files.filter((file) => file.kind === 'conversation').reduce((sum, file) => sum + file.conversations.length, 0),
        bookmarks: files.filter((file) => file.kind === 'bookmark-excerpt').reduce((sum, file) => sum + file.bookmarkEntries.length, 0)
      }
    };
  }

  // 按文件中的实际消息选资源：书签摘录不能顺带读取整段会话的其他图片。
  function selectedImageResources(plan) {
    const selected = new Map();
    for (const file of plan?.files || []) for (const { conversation, messages } of fileConversationSelections(file)) {
      const ids = new Set(messages.flatMap(message => message.segments.flatMap(segment =>
        (segment.blocks || []).filter(block => block.type === 'image').map(block => block.resourceId))));
      for (const resource of conversation.resources) if (ids.has(resource.id)) {
        selected.set(`${conversation.id}\u0000${resource.id}`, { conversationId: conversation.id, resource });
      }
    }
    return [...selected.values()];
  }

  Object.assign(api, { cleanBaseName, selectedBookmarkEntries, buildExportPlan, selectedImageResources });
}(typeof globalThis !== 'undefined' ? globalThis : window));
