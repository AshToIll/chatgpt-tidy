/* 每次导出固定一份语言快照，途中切换界面语言不会让同一文件混用标签；译文只维护在 src/messages/catalogs/export.json 等所属文案目录。 */
(function (root) {
  'use strict';

  const api = root.TidyExport = root.TidyExport || {};
  const MESSAGE_KEYS = Object.freeze([
    'untitled', 'ungrouped', 'bookmarks',
    'exportVisibleProcess', 'exportToolProcess', 'exportWebProcess', 'exportFinalSources',
    'exportConversationSection', 'exportDefaultName', 'exportMergedConversationsName',
    'exportBookmarkExcerpt', 'exportConversationExcerpt', 'exportExcerptNotice',
    'exportOpenOriginal', 'exportFromGroup', 'exportToolLabel', 'exportQueryLabel',
    'exportImage', 'exportUnnamedImage', 'exportAttachment', 'exportUnnamedAttachment',
    'exportImageLabel', 'exportAttachmentLabel', 'exportDocumentTitle',
    'exportPlanFiles', 'exportImageNoAddress',
    'exportImageEmbedFailed', 'exportImagePreviewFailed', 'exportUnsupportedGlyphs', 'exportLinkAnnotationFailed',
  ]);

  function createExportMessages(translate) {
    return Object.freeze(Object.fromEntries(MESSAGE_KEYS.map((key) => [key, translate(key)])));
  }

  function exportText(messages, key, values = {}) {
    let text = messages[key];
    for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
    return text;
  }

  // Errors cross async dependency/renderer boundaries as keys, not text in the
  // language of whichever job happened to load a shared dependency first.
  function exportError(key, values = {}) {
    return Object.assign(new Error(key), { exportMessageKey: key, exportMessageValues: values });
  }

  function exportErrorDescriptor(error, translate, fallback = 'exportGenerationFailed') {
    // 界面只显示已登记的文案；底层异常可能含字段、地址或库名，不直接交给用户。
    const key = error?.exportMessageKey;
    const message = typeof key === 'string' && key.startsWith('export') ? translate(key, error.exportMessageValues) : null;
    return message && message !== key ? { key, values: { ...error.exportMessageValues } } : { key: fallback, values: {} };
  }

  function exportErrorText(error, translate, fallback = 'exportGenerationFailed') {
    // 即时文本和持久提示共用同一个错误边界；提示保存描述符，在显示时使用当前语言。
    const descriptor = exportErrorDescriptor(error, translate, fallback);
    return translate(descriptor.key, descriptor.values);
  }

  Object.assign(api, { createExportMessages, exportText, exportError, exportErrorDescriptor, exportErrorText });
}(typeof globalThis !== 'undefined' ? globalThis : window));
