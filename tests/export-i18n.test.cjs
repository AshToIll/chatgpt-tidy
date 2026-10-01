const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { exportMessages, translator, catalog } = require('./helpers/export-i18n.cjs');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, '.tmp', 'deep-refactor', 'export-i18n');
const options = { timestamps: true, messageNumbers: true, visibleProcess: true, toolProcess: true, webProcess: true, finalSources: true, mediaAttachments: true };
const context = vm.createContext({ URL, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, setTimeout, clearTimeout, setImmediate });
for (const file of ['vendor/pdf-lib-1.17.1.min.js', 'vendor/regenerator-runtime-0.14.1.js', 'vendor/fontkit-1.1.1.min.js', 'vendor/jszip-3.10.1.min.js',
  'features/export/model/export.js', 'features/export/engine/i18n.js', 'features/export/engine/assets.js', 'features/export/engine/dependencies.js', 'features/export/engine/normalize.js', 'features/export/engine/plan.js', 'features/export/engine/inline-content.js', 'features/export/engine/serializers.js', 'features/export/engine/pdf.js', 'features/export/engine/download.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'src', file), 'utf8'), context, { filename: file });
}
const api = context.TidyExport;
const time = '2026-09-16T00:00:00Z';

function sourceData() {
  return { conversations: [{ id: 'one', title: '', createdAt: time, updatedAt: time, sourceUrl: 'https://example.com/chat',
    resources: [
      { id: 'image', type: 'image', name: 'original.png', src: '', alt: '', mimeType: 'image/png', sizeBytes: null },
      { id: 'attachment', type: 'attachment', name: 'original.docx', src: '', alt: '', mimeType: '', sizeBytes: 24 },
    ],
    messages: [{ id: 'message', messageNumber: 1, role: 'assistant', timestamp: time, segments: [
      ...['reasoning', 'search', 'tool'].map((category) => ({ type: 'process', sourceMessageId: category, timestamp: time,
        category, phase: 'summary', label: 'Original process subtitle', blocks: [{ type: 'paragraph', text: 'Original process body' }],
        tool: { name: 'web.run', callId: 'call' }, queries: ['original query'], results: [] })),
      { type: 'content', sourceMessageId: 'message', timestamp: time, blocks: [
        { type: 'paragraph', text: 'Original body. [Original source](https://example.com/source)' },
        { type: 'image', resourceId: 'image', alt: '' }, { type: 'attachment', resourceId: 'attachment' },
      ] },
      { type: 'sources', sourceMessageId: 'message', timestamp: time, items: [{ title: 'Original source', url: 'https://example.com/source', domain: 'example.com' }] },
    ] }],
  }], bookmarks: [{ id: 'bookmark', conversationId: 'one', messageId: 'message', groupId: null, bookmarkedAt: time }] };
}

function plan(language, format, extra = {}) {
  return api.buildExportPlan({ messages: exportMessages(language), mode: 'batch', format, options,
    data: api.normalizeExportData(sourceData()), bookmarkIds: ['bookmark'], ...extra });
}

async function fontLoader(source) {
  assert.ok(source.startsWith('./vendor/fonts/'), `No network in this test: ${source}`);
  return new Uint8Array(fs.readFileSync(path.join(root, 'src/assets/fonts', source.slice('./vendor/fonts/'.length))));
}

test('export vocabulary is present explicitly in all shipping catalogs', () => {
  const keys = Object.keys(catalog['zh-CN']).filter((key) => key.startsWith('export'));
  for (const language of ['zh-CN', 'zh-TW', 'en', 'ja']) {
    for (const key of keys) assert.equal(typeof catalog[language][key], 'string', `${language}: ${key}`);
    for (const [key, value] of Object.entries(exportMessages(language))) assert.notEqual(value, key);
  }
});

test('interface catalogs retain matching keys and interpolation parameters', () => {
  const keys = Object.keys(catalog['zh-CN']).sort();
  const parameters = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const language of ['zh-TW', 'en', 'ja']) {
    assert.deepEqual(Object.keys(catalog[language]).sort(), keys, language);
    for (const key of keys) assert.deepEqual(parameters(catalog[language][key]), parameters(catalog['zh-CN'][key]), `${language}: ${key}`);
  }
  for (const key of ['exportJobNextSettings', 'exportJobResources', 'exportJobCancelHint', 'exportJobOwnerChanged',
    'exportJobInterrupted', 'exportJobSaveFailed', 'exportJobTimeout', 'noteSaved', 'noteSaveUnknown', 'backupNeedsAccount', 'searchUnavailable',
    'titlesBatchNoAutoResume', 'titlesBatchReviewNoWrite', 'titlesBatchUnavailable', 'titlesBatchCatalogRecheckAccount', 'comingSoonShort', 'timeZoneShared']) {
    assert.ok(!keys.includes(key), `obsolete copy has no second entrypoint: ${key}`);
  }
});

test('export failure uses the agreed concise retry wording', () => {
  assert.equal(translator('zh-CN')('exportJobFailed'), '导出失败，请重新导出');
});

test('unexpected export errors show a localized recovery action, never raw implementation details', () => {
  const raw = 'fontkit.js: conversation.messages[0] at https://example.com/private?token=secret';
  for (const language of ['zh-CN', 'zh-TW', 'en', 'ja']) {
    const t = translator(language);
    for (const error of [Error(raw), raw, null, { exportMessageKey: raw }, api.exportError('exportUnregisteredKey')]) {
      assert.equal(api.exportErrorText(error, t), t('exportGenerationFailed'));
      assert.equal(api.exportErrorText(error, t, 'exportUnavailable'), t('exportUnavailable'));
    }
    assert.equal(api.exportErrorText(api.exportError('exportDependencyFailed', { name: raw }), t), t('exportDependencyFailed'));
    assert.equal(api.exportErrorText(api.exportError('exportInvalidDataField', { field: raw }), t), t('exportInvalidDataField'));
    assert.equal(api.exportErrorText(api.exportError('exportImagePreviewFailed', { name: 'photo.png' }), t), t('exportImagePreviewFailed', { name: 'photo.png' }), 'a user-facing filename is still useful');
  }
});

test('persistent export error descriptors share the safe text boundary and translate with current language', () => {
  const raw = 'private field at https://example.com/?token=secret';
  const errors = [Error(raw), raw, null, { exportMessageKey: raw }, api.exportError('exportUnregisteredKey'),
    api.exportError('exportImagePreviewFailed', { name: 'photo.png' })];
  for (const error of errors) {
    const descriptor = api.exportErrorDescriptor(error, translator('zh-CN'), 'exportUnavailable');
    assert.ok(!JSON.stringify(descriptor).includes(raw));
    for (const language of ['zh-CN', 'zh-TW', 'en', 'ja']) {
      const t = translator(language);
      assert.equal(t(descriptor.key, descriptor.values), api.exportErrorText(error, t, 'exportUnavailable'));
    }
  }
  const error = api.exportError('exportImagePreviewFailed', { name: 'original.png' });
  const descriptor = api.exportErrorDescriptor(error, translator('en'));
  error.exportMessageValues.name = 'changed.png';
  assert.equal(descriptor.values.name, 'original.png', 'stored UI parameters are not mutated by the originating error');
});

for (const language of ['zh-CN', 'zh-TW', 'en', 'ja']) {
  const t = translator(language);
  test(`${language}: Markdown/TXT/JSON use localized generated labels and retain raw content/schema`, async () => {
    fs.mkdirSync(outputDir, { recursive: true });
    for (const format of ['markdown', 'txt', 'json']) {
      const planned = plan(language, format);
      const preview = api.serializeTextFile(planned.files[0], format, { messages: planned.messages, options });
      const generated = await api.generateExport(planned, { options });
      const text = new TextDecoder().decode(generated.bytes);
      assert.equal(text, preview, `${format}: preview and downloaded bytes agree`);
      assert.equal(generated.outputName, `${t('exportBookmarkExcerpt')}.${planned.extension}`);
      assert.ok(text.includes(t('untitled')));
      assert.ok(text.includes(t('ungrouped')));
      assert.ok(text.includes('Original body.'));
      assert.ok(text.includes('Original process subtitle'));
      assert.ok(text.includes('original.docx'));
      if (format === 'json') {
        const doc = JSON.parse(text);
        assert.equal(doc.schemaVersion, 'chatgpt-tidy.export.v3');
        assert.equal(doc.documentType, 'bookmarkExcerpt');
        const message = doc.conversations[0].messages[0];
        assert.equal(message.role, 'assistant');
        assert.equal(message.displayName, 'Assistant');
        assert.equal(message.bookmarkGroup, t('ungrouped'));
        assert.equal(message.segments[0].category, 'reasoning');
        assert.equal(message.segments[0].label, 'Original process subtitle');
        assert.ok(message.segments[3].blocks[0].text.includes('[Original source](https://example.com/source)'));
      } else {
        for (const key of ['exportVisibleProcess', 'exportToolProcess', 'exportWebProcess', 'exportFinalSources', 'exportExcerptNotice', 'exportAttachment']) assert.ok(text.includes(t(key)), `${format}: ${key}`);
        for (const [key, values] of [['exportToolLabel', { name: 'web.run' }], ['exportQueryLabel', { query: 'original query' }], ['exportFromGroup', { name: t('ungrouped') }]]) assert.ok(text.includes(t(key, values)), `${format}: ${key}`);
        if (format === 'markdown') assert.ok(text.includes(t('exportOpenOriginal')));
      }
      if (language === 'en') assert.doesNotMatch(text, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);
      if (language === 'ja') assert.doesNotMatch(text, /可见思考|网页检索过程|来自分组|未分组|书签摘录|文件引用/);
      fs.writeFileSync(path.join(outputDir, `${language}.${planned.extension}`), generated.bytes);
    }
  });

  test(`${language}: neutral role defaults and custom names agree across text formats and PDF preview`, () => {
    const raw = sourceData();
    raw.conversations[0].messages.unshift({ id: 'question', messageNumber: 0, role: 'user', timestamp: time,
      segments: [{ type: 'content', sourceMessageId: 'question', timestamp: time, blocks: [{ type: 'paragraph', text: 'Original question' }] }] });
    for (const roleNames of [undefined, { user: '', assistant: '' }, { user: '我的名字', assistant: '私の助手' }]) {
      const expected = { user: roleNames?.user || 'User', assistant: roleNames?.assistant || 'Assistant' };
      for (const format of ['markdown', 'txt', 'json', 'pdf']) {
        const planned = plan(language, format, { data: api.normalizeExportData(raw), conversationIds: ['one'], bookmarkIds: [] });
        const context = { messages: planned.messages, roleNames, options };
        const text = format === 'pdf'
          ? api.serializePreviewParts(planned.files[0], context).filter(part => part.type === 'text').map(part => part.text).join('\n')
          : api.serializeTextFile(planned.files[0], format, context);
        assert.ok(text.includes(expected.user), `${format}: user name`);
        assert.ok(text.includes(expected.assistant), `${format}: assistant name`);
        if (format === 'json') {
          const messages = JSON.parse(text).conversation.messages;
          assert.deepEqual(messages.map(message => [message.role, message.displayName]), [['user', expected.user], ['assistant', expected.assistant]]);
        }
      }
      assert.equal(raw.conversations[0].messages[0].role, 'user', 'display settings never mutate source roles');
      assert.equal(raw.conversations[0].messages[1].role, 'assistant');
    }
  });

  test(`${language}: actual PDF text encoding, metadata and missing-image warnings use the job vocabulary`, async () => {
    const raw = sourceData();
    raw.conversations[0].messages.push({ id: 'question', messageNumber: 2, role: 'user', timestamp: time,
      segments: [{ type: 'content', sourceMessageId: 'question', timestamp: time, blocks: [{ type: 'paragraph', text: 'Original question' }] }] });
    raw.bookmarks.push({ id: 'user-bookmark', conversationId: 'one', messageId: 'question', groupId: null, bookmarkedAt: time });
    const planned = plan(language, 'pdf', { data: api.normalizeExportData(raw), bookmarkIds: ['bookmark', 'user-bookmark'] });
    const encoded = [];
    const prototype = context.PDFLib.PDFFont.prototype;
    const encode = prototype.encodeText;
    prototype.encodeText = function (text) { encoded.push(text); return encode.call(this, text); };
    let result;
    try { result = await api.generateExport(planned, { options, assetLoader: fontLoader }); }
    finally { prototype.encodeText = encode; }
    const text = encoded.join('');
    assert.ok(text.includes('User'));
    assert.ok(text.includes('Assistant'));
    for (const key of ['exportBookmarkExcerpt', 'exportVisibleProcess', 'exportToolProcess', 'exportWebProcess', 'exportFinalSources', 'exportExcerptNotice']) {
      assert.ok(text.includes(t(key)), `Encoded PDF text: ${key}`);
    }
    assert.ok(text.includes(t('exportFromGroup', { name: t('ungrouped') })));
    assert.ok(text.includes('Original source · https://example.com/source'));
    assert.ok(text.includes('Original process subtitle'));
    assert.ok(text.includes('original.docx'));
    assert.ok(!text.includes('□'), 'translated text must not fall back to missing-glyph boxes');
    assert.deepEqual(Array.from(result.warnings), [t('exportImageNoAddress', { name: 'original.png' })]);
    const pdf = await context.PDFLib.PDFDocument.load(result.bytes);
    assert.equal(pdf.getTitle(), t('exportBookmarkExcerpt'));
    assert.ok(pdf.getPageCount() > 0);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, `${language}.pdf`), result.bytes);
  });

  test(`${language}: ZIP directories, auto names, custom names and failed assets follow each format`, async () => {
    for (const format of ['markdown', 'txt', 'json', 'pdf']) {
      const raw = sourceData();
      raw.conversations[0].title = 'My original title';
      raw.conversations[0].resources[0].src = 'https://example.com/image.png';
      const planned = plan(language, format, { data: api.normalizeExportData(raw), conversationIds: ['one'] });
      assert.equal(planned.outputName, `${api.cleanBaseName(t('exportDefaultName'))}.zip`);
      assert.equal(planned.files[0].folder, t('exportConversationSection'));
      assert.equal(planned.files[1].folder, t('bookmarks'));
      assert.equal(planned.files[0].baseName, 'My original title');
      let assetReads = 0;
      const result = await api.generateExport(planned, { options, assetLoader: async (source) => {
        assetReads++;
        if (source.startsWith('https:')) throw new Error('offline image');
        return fontLoader(source);
      } });
      const zip = await context.JSZip.loadAsync(result.bytes);
      for (const file of planned.files) assert.ok(zip.file(file.path), `actual ZIP entry: ${file.path}`);
      if (format === 'markdown') {
        assert.equal(assetReads, 0);
        assert.deepEqual(Array.from(result.warnings), []);
        assert.ok(Object.values(zip.files).filter(file => !file.dir).every(file => file.name.endsWith('.md')));
        assert.equal(Object.keys(zip.files).some(name => name.includes('assets/')), false);
        for (const file of planned.files) {
          const markdown = await zip.file(file.path).async('string');
          assert.ok(markdown.includes('https://example.com/image.png'));
          assert.doesNotMatch(markdown, /!\[/);
        }
      }
      if (format === 'pdf') assert.ok(result.warnings.includes(t('exportImageEmbedFailed', { name: 'original.png' })));
      if (format === 'json') {
        const doc = JSON.parse(await zip.file(planned.files[0].path).async('string'));
        assert.equal(doc.conversation.title, 'My original title');
      }
      const custom = plan(language, format, { data: api.normalizeExportData(raw), conversationIds: ['one'], names: { zip: 'My archive', mergedBookmarks: 'My excerpts' } });
      assert.equal(custom.outputName, 'My archive.zip');
      assert.equal(custom.files[1].baseName, 'My excerpts');
    }
  });
}

test('omitted content options exclude final sources and media in every format without changing the source', () => {
  const raw = sourceData(), before = JSON.stringify(raw);
  for (const format of ['markdown', 'txt', 'json', 'pdf']) {
    const planned = api.buildExportPlan({ messages: exportMessages('en'), mode: 'current', format,
      currentConversationId: 'one', data: api.normalizeExportData(raw) });
    const conversation = planned.files[0].conversations[0];
    assert.equal(conversation.resources.length, 0, format);
    assert.equal(conversation.messages.some(message => message.segments.some(segment => segment.type === 'sources')), false, format);
    assert.equal(conversation.messages.some(message => message.segments.some(segment =>
      segment.blocks?.some(block => ['image', 'attachment'].includes(block.type)))), false, format);
    assert.ok(conversation.messages.some(message => message.segments.some(segment =>
      segment.blocks?.some(block => block.text?.includes('Original body.')))), 'ordinary body remains present: ' + format);
  }
  assert.equal(JSON.stringify(raw), before, 'defaults project a copy instead of deleting source data');
});

test('normalization keeps missing titles language-neutral; defaults are applied only to a job copy', () => {
  const raw = sourceData();
  const data = api.normalizeExportData(raw);
  const planned = plan('ja', 'json', { data });
  assert.equal(data.conversations[0].title, '');
  assert.equal(planned.files[0].bookmarkEntries[0].conversation.title, translator('ja')('untitled'));
  const document = { schemaVersion: context.TidyExportContract.VERSION, conversation: raw.conversations[0], warnings: ['IMAGE_UNAVAILABLE'] };
  assert.equal(context.TidyExportContract.validateDocument(document).valid, true);
  document.warnings = ['hardcoded prose'];
  assert.equal(context.TidyExportContract.validateDocument(document).valid, false);
});

test('custom groups, roles, filenames and source subtitles are not translated', () => {
  const raw = sourceData();
  raw.bookmarks[0].groupId = 'custom';
  for (const language of ['zh-CN', 'zh-TW', 'en', 'ja']) {
    const planned = plan(language, 'json', { data: api.normalizeExportData(raw), bookmarkGroups: [{ id: 'custom', name: '我的组 / My group' }], names: { mergedBookmarks: 'My file' } });
    const doc = JSON.parse(api.serializeTextFile(planned.files[0], 'json', { messages: planned.messages, roleNames: { assistant: '自定义助手' } }));
    assert.equal(planned.outputName, 'My file.json');
    assert.equal(doc.conversations[0].messages[0].displayName, '自定义助手');
    assert.equal(doc.conversations[0].messages[0].bookmarkGroup, '我的组 / My group');
  }
});

test('dependency and data errors retain stable parameters and localize at the display boundary', () => {
  const errors = [api.exportError('exportDependencyFailed', { name: 'fontkit.js' }), api.exportError('exportPdfFontsInvalid')];
  try { api.normalizeExportData(null); } catch (error) { errors.push(error); }
  try { plan('en', 'unknown'); } catch (error) { errors.push(error); }
  for (const language of ['zh-CN', 'zh-TW', 'en', 'ja']) for (const error of errors) {
    const translated = api.exportErrorText(error, translator(language));
    assert.notEqual(translated, error.message);
    if (language === 'en') assert.doesNotMatch(translated, /\p{Script=Han}/u);
  }
});
