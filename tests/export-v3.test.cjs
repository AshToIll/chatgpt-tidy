const { exportMessages } = require('./helpers/export-i18n.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { TextDecoder, TextEncoder } = require('node:util');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, '.tmp', 'deep-refactor', 'export-v3');
// Exercise real PNG embedding with the public extension icon, not a design
// screenshot that would make automated tests depend on private QA artifacts.
const sampleImage = path.join(root, 'src', 'assets', 'icons', 'tidy-outlined-32.png');

function runClassic(context, relativePath) {
  vm.runInContext(fs.readFileSync(path.join(root, relativePath), 'utf8'), context, { filename: relativePath });
}

let sharedRuntime = null;
function runtime() {
  if (sharedRuntime) return sharedRuntime;
  for (const file of ['src/vendor/pdf-lib-1.17.1.min.js', 'src/vendor/regenerator-runtime-0.14.1.js', 'src/vendor/fontkit-1.1.1.min.js', 'src/vendor/jszip-3.10.1.min.js']) {
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    vm.runInThisContext(`(function(module, exports, define) { ${code}\n}).call(globalThis, undefined, undefined, undefined);`, { filename: file });
  }
  for (const file of ['src/features/export/engine/i18n.js', 'src/features/export/engine/dependencies.js', 'src/features/export/engine/assets.js', 'src/features/export/engine/normalize.js', 'src/features/export/engine/plan.js', 'src/features/export/engine/inline-content.js', 'src/features/export/engine/serializers.js', 'src/features/export/engine/pdf.js', 'src/features/export/engine/download.js']) {
    vm.runInThisContext(fs.readFileSync(path.join(root, file), 'utf8'), { filename: file });
  }
  sharedRuntime = globalThis;
  return sharedRuntime;
}

function sourceData() {
  const rows = Array.from({ length: 70 }, (_, index) => [`第 ${index + 1} 行`, `跨页表格内容 ${'甲乙丙丁'.repeat(index % 4 + 2)}`]);
  return {
    conversations: [{
      id: 'conversation-v3', title: '导出 V3 排版验收 🧭',
      createdAt: '2026-08-31T01:00:00.000Z', updatedAt: '2026-08-31T02:00:00.000Z',
      sourceUrl: 'https://chatgpt.com/c/conversation-v3',
      resources: [
        { id: 'image-1', type: 'image', name: 'tidy-outlined-32.png', mimeType: 'image/png', sizeBytes: fs.statSync(sampleImage).size, src: 'fixtures/tidy-outlined-32.png', alt: 'Tidy 测试图标' },
        { id: 'attachment-1', type: 'attachment', name: '访谈录音.MP3', mimeType: 'audio/mpeg', sizeBytes: 3817472, src: '', alt: '' },
      ],
      messages: [
        {
          id: 'user-1', messageNumber: 1, role: 'user', timestamp: '2026-08-31T01:00:01.000Z',
          segments: [{ type: 'content', sourceMessageId: 'user-1', timestamp: '2026-08-31T01:00:01.000Z', blocks: [
            { type: 'paragraph', text: '请检查图片和附件，并保持它们在原来的位置。' },
            { type: 'image', resourceId: 'image-1', alt: 'Tidy 测试图标' },
            { type: 'attachment', resourceId: 'attachment-1' },
          ] }],
        },
        {
          id: 'assistant-1', messageNumber: 2, role: 'assistant', timestamp: '2026-08-31T01:00:02.000Z',
          segments: [
            { type: 'process', sourceMessageId: 'thought-1', timestamp: '2026-08-31T01:00:02.000Z', category: 'reasoning', phase: 'summary', label: '检查导出结构', blocks: [{ type: 'paragraph', text: '先核对图片、附件与正文顺序。✨' }], queries: [], results: [], tool: null },
            { type: 'process', sourceMessageId: 'thought-2', timestamp: '2026-08-31T01:00:02.500Z', category: 'reasoning', phase: 'event', label: '', blocks: [{ type: 'paragraph', text: '继续保留相邻思考段的原始顺序。' }], queries: [], results: [], tool: null },
            { type: 'process', sourceMessageId: 'search-1', timestamp: '2026-08-31T01:00:03.000Z', category: 'search', phase: 'result', label: '检索参考资料', blocks: [], queries: ['PDF typography'], results: [{ title: 'Typography reference', url: 'https://example.com/typography', domain: 'example.com' }], tool: { name: 'web.run', callId: 'call-1' } },
            { type: 'process', sourceMessageId: 'tool-1', timestamp: '2026-08-31T01:00:03.500Z', category: 'tool', phase: 'request', label: '读取工作区', blocks: [{ type: 'code', language: 'json', code: '{"path":"README.md"}' }], queries: [], results: [], tool: { name: 'api_tool.call_tool', callId: 'call-2' } },
            { type: 'process', sourceMessageId: 'tool-2', timestamp: '2026-08-31T01:00:03.600Z', category: 'tool', phase: 'result', label: '读取工作区', blocks: [{ type: 'paragraph', text: 'README 内容已读取。' }], queries: [], results: [], tool: { name: 'api_tool.call_tool', callId: 'call-2' } },
            { type: 'content', sourceMessageId: 'assistant-1', timestamp: '2026-08-31T01:00:04.000Z', blocks: [
              { type: 'heading', level: 2, text: '正式回复' },
              { type: 'paragraph', text: `正文使用 Regular 400，标题使用 Medium 500。Emoji：🧭 ✨ ❤️ 👍🏽。${'长段落用于检查孤行与分页。'.repeat(28)}` },
              { type: 'paragraph', text: '多语言来源：ChatGPT 기록 및 데이터 내보내기；اپنی ChatGPT ہسٹری اور ڈیٹا ایکسپورٹ کرنا；Извезување на вашата историја и податоци од ChatGPT。' },
              { type: 'paragraph', text: '扩展文字验收：日本語のチャット履歴；ქართული მონაცემების ექსპორტი；हिन्दी में ChatGPT डेटा निर्यात；עברית；Հայերեն；বাংলা；தமிழ்；తెలుగు；ગુજરાતી；ಕನ್ನಡ；മലയാളം；ਪੰਜਾਬੀ；සිංහල；ภาษาไทย；ខ្មែរ；ລາວ；မြန်မာ；ከChatGPT የውሂብ ላክ።' },
              { type: 'paragraph', text: '内部来源标记：[Exporting your ChatGPT history and data](https://example.com/export)。' },
              { type: 'code', language: 'javascript', code: `const veryLongValue = "${'abcdefghij'.repeat(32)}";\nconsole.log(veryLongValue);` },
              { type: 'table', headers: ['项目', '说明'], rows },
            ] },
            { type: 'sources', sourceMessageId: 'assistant-1', timestamp: '2026-08-31T01:00:04.000Z', items: [
              { title: 'Typography reference', url: 'https://example.com/typography', domain: 'example.com' },
              { title: 'PDF specification with a deliberately long title and URL', url: 'https://example.org/a/very/long/path/that/should/be/compressed/in/the/visible/pdf/output?with=query&and=more', domain: 'example.org' },
              { title: 'ChatGPT 기록 및 데이터 내보내기 | OpenAI Help Center', url: 'https://help.openai.com/ko-kr/articles/7260999', domain: 'help.openai.com' },
              { title: 'اپنی ChatGPT ہسٹری اور ڈیٹا ایکسپورٹ کرنا | OpenAI Help Center', url: 'https://help.openai.com/ur-in/articles/7260999', domain: 'help.openai.com' },
              { title: 'Извезување на вашата историја и податоци од ChatGPT | OpenAI Help Center', url: 'https://help.openai.com/mk-mk/articles/7260999', domain: 'help.openai.com' },
            ] },
          ],
        },
      ],
    }],
    bookmarks: [],
  };
}

function exportContext() {
  return {
    messages: exportMessages(),
    options: { timestamps: true, messageNumbers: true, visibleProcess: true, toolProcess: true, webProcess: true, finalSources: true, mediaAttachments: true },
    roleNames: { user: 'User', assistant: 'Assistant' },
    pdf: { pageSize: 'A4', orientation: 'portrait', fontSize: 'standard', pageNumbers: true },
    formatTimestamp: (value) => value,
    assetLoader: async (source) => {
      if (source === 'fixtures/tidy-outlined-32.png') return new Uint8Array(fs.readFileSync(sampleImage));
      if (source.startsWith('./vendor/fonts/noto-sans-sc/')) return new Uint8Array(fs.readFileSync(path.join(root, 'src', 'assets', 'fonts', 'noto-sans-sc', source.slice('./vendor/fonts/noto-sans-sc/'.length))));
      if (source.startsWith('./vendor/fonts/fallback/')) return new Uint8Array(fs.readFileSync(path.join(root, 'src', 'assets', 'fonts', 'fallback', source.slice('./vendor/fonts/fallback/'.length))));
      if (source === './vendor/fonts/NotoEmoji-Regular.ttf') return new Uint8Array(fs.readFileSync(path.join(root, 'src', 'assets', 'fonts', 'NotoEmoji-Regular.ttf')));
      throw new Error(`unknown asset: ${source}`);
    },
  };
}

function planFor(api, format, options = exportContext().options) {
  const data = api.normalizeExportData(sourceData());
  return api.buildExportPlan({ messages: exportMessages(), mode: 'current', format, currentConversationId: 'conversation-v3', names: { current: '导出 V3 排版验收' }, options, data });
}

test('small text previews match full file prefixes and stop before later messages', () => {
  const { TidyExport: api } = runtime(), context = exportContext();
  for (const format of ['markdown', 'txt', 'json']) {
    const file = planFor(api, format).files[0];
    file.conversations.push({ ...file.conversations[0], title: 'Second conversation' });
    const full = api.serializeTextFile(file, format, context);
    for (const limit of [0, 12, 160, 2600, full.length - 1, full.length + 5]) {
      assert.equal(api.serializeTextExcerpt(file, format, context, limit), full.slice(0, limit + 1), `${format}/${limit}`);
    }
    if (format === 'json') continue;
    Object.defineProperty(file.conversations[0].messages[1], 'segments', { get() { throw Error('Formatted a message outside the preview'); } });
    assert.doesNotThrow(() => api.serializeTextExcerpt(file, format, context, 100));
  }
});

test('small PDF previews stop consuming later text; full previews remain complete', () => {
  const { TidyExport: api } = runtime(), context = exportContext();
  const file = planFor(api, 'pdf').files[0];
  const full = api.serializePreviewParts(file, context);
  assert.ok(full.some(p => p.type === 'text' && p.text.includes('正式回复')));
  Object.defineProperty(file.conversations[0].messages[1], 'segments', { get() { throw Error('Formatted a message outside the preview'); } });
  const small = api.serializePreviewParts(file, context, 100);
  assert.ok(small.reduce((total, part) => total + (part.text?.length || 0), 0) <= 104);
});

test('projection keeps mutable descendants independent without duplicate whole-document cloning', () => {
  const { TidyExport: api } = runtime();
  const normalized = api.normalizeExportData(sourceData()), before = JSON.stringify(normalized);
  const projected = api.projectExportData(normalized, exportContext().options);
  const conversation = projected.conversations[0];
  conversation.resources[0].src = 'changed';
  conversation.messages[0].segments[0].blocks[0].text = 'changed';
  const segments = conversation.messages[1].segments;
  segments.find(s => s.type === 'process').blocks[0].text = 'changed';
  segments.find(s => s.type === 'sources').items[0].title = 'changed';
  assert.equal(JSON.stringify(normalized), before);
});

test('ordered V3 projection filters types without moving remaining segments', () => {
  const { TidyExport: api } = runtime();
  const full = planFor(api, 'json');
  const message = full.files[0].conversations[0].messages[1];
  assert.deepEqual(Array.from(message.segments, (segment) => segment.type === 'process' ? `${segment.type}:${segment.category}` : segment.type), [
    'process:reasoning', 'process:reasoning', 'process:search', 'process:tool', 'process:tool', 'content', 'sources',
  ]);
  const grouped = api.groupAdjacentProcessSegments(message.segments);
  assert.deepEqual(Array.from(grouped, (segment) => segment.type === 'process-group' ? `${segment.type}:${segment.category}:${segment.segments.length}` : segment.type), [
    'process-group:reasoning:2', 'process-group:search:1', 'process-group:tool:2', 'content', 'sources',
  ]);

  const filtered = planFor(api, 'json', { visibleProcess: false, toolProcess: false, webProcess: false, finalSources: true, mediaAttachments: false });
  assert.deepEqual(Array.from(filtered.files[0].conversations[0].messages[1].segments, (segment) => segment.type), ['content', 'sources']);
  assert.equal(filtered.files[0].conversations[0].resources.length, 0);
  assert.equal(filtered.files[0].conversations[0].messages[0].segments[0].blocks.some((block) => ['image', 'attachment'].includes(block.type)), false);

  const noTools = planFor(api, 'json', { visibleProcess: true, toolProcess: false, webProcess: true, finalSources: true, mediaAttachments: true });
  assert.deepEqual(Array.from(noTools.files[0].conversations[0].messages[1].segments, (segment) => segment.type === 'process' ? segment.category : segment.type), [
    'reasoning', 'reasoning', 'search', 'content', 'sources',
  ]);
});

test('four V3 formats generate real inspectable outputs', async () => {
  const context = runtime();
  const api = context.TidyExport;
  fs.mkdirSync(outputDir, { recursive: true });
  const outputs = {};
  for (const format of ['markdown', 'json', 'txt', 'pdf']) {
    const plan = planFor(api, format);
    const generated = await api.generateExport(plan, exportContext());
    outputs[format] = { plan, generated };
    fs.writeFileSync(path.join(outputDir, generated.outputName), Buffer.from(generated.bytes));
    assert.ok(generated.bytes.byteLength > 100, `${format} must not be empty`);
  }

  assert.equal(outputs.markdown.plan.zipped, false);
  assert.equal(outputs.markdown.plan.assets?.length || 0, 0);
  assert.match(outputs.markdown.generated.outputName, /\.md$/);
  const markdown = new TextDecoder().decode(outputs.markdown.generated.bytes);
  assert.ok(markdown.indexOf('检查导出结构') < markdown.indexOf('检索参考资料'));
  assert.ok(markdown.indexOf('检索参考资料') < markdown.indexOf('正式回复'));
  assert.equal((markdown.match(/\*\*可见思考\*\*/g) || []).length, 1);
  assert.equal((markdown.match(/\*\*工具过程\*\*/g) || []).length, 1);
  assert.equal((markdown.match(/\*\*网页检索过程\*\*/g) || []).length, 1);
  assert.doesNotMatch(markdown, /||/);
  assert.match(markdown, /> \*\*图片\*\*[\s\S]*Tidy 测试图标/);
  assert.doesNotMatch(markdown, /!\[|assets\//);
  assert.match(markdown, /> \*\*附件\*\*/);

  const json = JSON.parse(new TextDecoder().decode(outputs.json.generated.bytes));
  assert.equal(json.schemaVersion, 'chatgpt-tidy.export.v3');
  assert.equal(json.conversation.id, 'conversation-v3');
  assert.equal(json.conversation.messages[0].id, 'user-1');
  assert.equal(json.conversation.messages[0].role, 'user');
  assert.equal(json.conversation.messages[0].displayName, 'User');
  assert.equal(json.conversation.messages[1].role, 'assistant');
  assert.equal(json.conversation.messages[1].displayName, 'Assistant');
  assert.equal(JSON.stringify(json).includes('contentBlocks'), false);
  assert.equal(JSON.stringify(json).includes('"tidy":'), false);

  const txt = new TextDecoder().decode(outputs.txt.generated.bytes);
  assert.match(txt, /\[图片：Tidy 测试图标\]/);
  assert.match(txt, /\[附件：访谈录音\.MP3\]/);

  const pdfBytes = outputs.pdf.generated.bytes;
  assert.equal(new TextDecoder('latin1').decode(pdfBytes.slice(0, 8)).startsWith('%PDF-'), true);
  assert.ok(outputs.pdf.generated.generatedFiles[0].pageCount >= 4);
  assert.equal(outputs.pdf.generated.warnings.length, 0, `multilingual fixture should use bundled fallbacks without glyph warnings: ${outputs.pdf.generated.warnings.join(' | ')}`);
  const pdfText = Buffer.from(pdfBytes).toString('latin1');
  assert.match(pdfText, /\/ToUnicode/);
  assert.doesNotMatch(pdfText, /\/Outlines\b/);
  assert.ok(pdfBytes.byteLength < 20 * 1024 * 1024, 'font shards must keep the multilingual stress PDF below 20 MB');

  const fontDirectory = path.join(root, 'src', 'assets', 'fonts', 'noto-sans-sc');
  const fontManifest = JSON.parse(fs.readFileSync(path.join(fontDirectory, 'manifest.json'), 'utf8'));
  assert.equal(fontManifest.schema, 'chatgpt-tidy.pdf-font-shards.v1');
  for (const shard of fontManifest.shards) {
    assert.ok(fs.statSync(path.join(fontDirectory, shard.regular)).size > 1000);
    assert.ok(fs.statSync(path.join(fontDirectory, shard.medium)).size > 1000);
  }
  const fallbackDirectory = path.join(root, 'src', 'assets', 'fonts', 'fallback');
  const fallbackManifest = JSON.parse(fs.readFileSync(path.join(fallbackDirectory, 'manifest.json'), 'utf8'));
  assert.equal(fallbackManifest.schema, 'chatgpt-tidy.pdf-font-fallbacks.v1');
  assert.equal(fallbackManifest.families.length, 22);
  for (const family of fallbackManifest.families) {
    assert.equal(family.preserveLayout, false, `${family.id} fallback must omit unstable GPOS layout`);
    for (const shard of family.shards) {
      assert.ok(fs.statSync(path.join(fallbackDirectory, family.id, shard.regular)).size > 1000);
      assert.ok(fs.statSync(path.join(fallbackDirectory, family.id, shard.medium)).size > 1000);
    }
  }
});

test('Markdown media descriptions do not request image bytes or produce image-download warnings', async () => {
  const context = runtime(), api = context.TidyExport;
  const plan = planFor(api, 'markdown');
  let reads = 0;
  const generated = await api.generateExport(plan, { ...exportContext(), assetLoader: async () => { reads++; throw new Error('offline'); } });
  assert.ok(generated.bytes.byteLength > 100);
  assert.equal(reads, 0);
  assert.deepEqual(Array.from(generated.warnings), []);
  const markdown = new TextDecoder().decode(generated.bytes);
  assert.match(markdown, /Tidy 测试图标/);
  assert.match(markdown, /https:\/\/chatgpt\.com\/c\/conversation-v3/);
  assert.doesNotMatch(markdown, /!\[|assets\//);
});
