const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { exportMessages } = require('./helpers/export-i18n.cjs');
const { installPageSession } = require('./helpers/page-session.cjs');

const root = path.resolve(__dirname, '..');
const png = new Uint8Array(fs.readFileSync(path.join(root, 'src/assets/icons/tidy-outlined-32.png')));

// Exercise the real source boundary and generators with synthetic API data only.
// Keeping this separate from raw serializer fixtures catches losses before DTO validation.
async function sourceRuntime(body, imageNames = []) {
  const images = imageNames.map((name, index) => ({ name, id: 'file_' + String(index + 1).padStart(32, '0') }));
  const parts = [body, ...images.map(image => ({ content_type: 'image_asset_pointer', asset_pointer: 'sediment://' + image.id }))];
  const payload = { id: 'links', title: 'Links', create_time: 1700000000, update_time: 1700000001, current_node: 'm', mapping: {
    m: { id: 'm', parent: null, message: { id: 'm', author: { role: 'assistant' }, create_time: 1700000001,
      content: { content_type: 'multimodal_text', parts } } },
  } };
  const context = vm.createContext({ URL, Headers, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, AbortController,
    setTimeout, clearTimeout, setImmediate,
    location: { href: 'https://chatgpt.com/c/links', origin: 'https://chatgpt.com' }, document: { cookie: '' },
    fetch: async url => {
      if (url === '/api/auth/session') return { ok: true, json: async () => ({ accessToken: 'synthetic-token', user: { id: 'test-user' } }) };
      if (url === '/backend-api/conversation/links') return { ok: true, json: async () => payload };
      const image = images.find(item => url.startsWith('/backend-api/files/download/' + item.id + '?'));
      assert.ok(image, 'Unexpected network endpoint: ' + url);
      return { ok: true, json: async () => ({ file_name: image.name, mime_type: 'image/png',
        download_url: `https://chatgpt.com/backend-api/estuary/content?id=${image.id}&sig=synthetic-only` }) };
    },
  });
  installPageSession(context);
  const load = relative => vm.runInContext(fs.readFileSync(path.join(root, relative), 'utf8'), context, { filename: relative });
  context.importScripts = relative => load(path.posix.normalize('src/features/export/engine/' + relative));
  for (const file of ['platform/snapshot', 'features/export/model/export', 'features/export/model/export-preview', 'platform/chatgpt/route', 'platform/chatgpt/api',
    'platform/chatgpt/active-branch', 'platform/chatgpt/native-message-references', 'platform/chatgpt/native-message-content', 'platform/chatgpt/native-message-process',
    'platform/chatgpt/conversation-projection', 'features/export/chatgpt/export', 'features/export/engine/i18n', 'features/export/engine/dependencies', 'features/export/engine/normalize', 'features/export/engine/plan', 'features/export/engine/inline-content', 'features/export/engine/serializers', 'features/export/engine/pdf', 'features/export/engine/download']) load('src/' + file + '.js');
  const document = await context.TidyChatgptExport.readCurrentConversation({ expectedConversationId: 'links' });
  for (const resource of document.conversation.resources) if (resource.pending) {
    Object.assign(resource, (await context.TidyChatgptExport.readImageResource({ readHandle: resource.readHandle })).resource);
    delete resource.readHandle;
  }
  assert.equal(context.TidyExportContract.validateDocument(document).valid, true);
  const api = context.TidyExport;
  const data = api.normalizeExportData({ conversations: [document.conversation], bookmarks: [
    { id: 'bookmark', conversationId: 'links', messageId: 'm', bookmarkedAt: '2026-01-01T00:00:00Z' },
  ] });
  const messages = exportMessages('en');
  return { context, api, document,
    plan: (format, mixed = false, options = {}) => api.buildExportPlan({ messages, data, format, options,
      ...(mixed ? { mode: 'batch', conversationIds: ['links'], bookmarkIds: ['bookmark'] } : { mode: 'current', currentConversationId: 'links' }) }),
    settings: { messages, options: { timestamps: false }, assetLoader: async source => {
      if (source.startsWith('https://chatgpt.com/backend-api/estuary/content?')) return png;
      assert.ok(source.startsWith('./vendor/fonts/'), 'Unexpected asset: ' + source);
      return new Uint8Array(fs.readFileSync(path.join(root, 'src/assets/fonts', source.slice('./vendor/fonts/'.length))));
    } },
  };
}

const targets = ['heading', 'list', 'ordered', 'quote', 'table'].map(name => `https://example.test/${name}?q=value#part`);
const linkedBody = [
  `# **Title** [Heading](${targets[0]})`, '', `- [List](${targets[1]})`, '',
  `1. [Ordered](${targets[2]})`, '', `> [Quote](${targets[3]})`, '',
  '| Label | Reference |', '| --- | --- |', `| **Entry** | [Table](${targets[4]}) |`,
].join('\n');

// Test-only decoder for the final operators emitted by export/pdf.js. It reads
// the real page streams and ToUnicode maps, not the generator's input strings.
async function generatedPdfText(P, bytes) {
  const document = await P.PDFDocument.load(bytes);
  const unpack = stream => Buffer.from(P.decodePDFRawStream(stream).decode()).toString('latin1');
  const output = [];
  for (const page of document.getPages()) {
    const maps = new Map();
    const fonts = page.node.Resources().lookup(P.PDFName.of('Font'));
    for (const [name, ref] of fonts.entries()) {
      const cmap = unpack(document.context.lookup(ref).lookup(P.PDFName.of('ToUnicode')));
      assert.doesNotMatch(cmap, /beginbfrange/);
      const glyphs = new Map();
      for (const section of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const pair of section[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>/gi)) {
          assert.equal(pair[1].length, 4);
          glyphs.set(pair[1].toUpperCase(), new TextDecoder('utf-16be').decode(Buffer.from(pair[2], 'hex')));
        }
      }
      assert.ok(glyphs.size);
      maps.set(name.toString().slice(1), glyphs);
    }
    const contents = page.node.Contents();
    const streams = contents instanceof P.PDFArray
      ? Array.from({ length: contents.size() }, (_, index) => contents.lookup(index)) : [contents];
    let font;
    for (const stream of streams) {
      const content = unpack(stream);
      assert.doesNotMatch(content, /\bTJ\b/);
      for (const token of content.matchAll(/\/([A-Za-z0-9_-]+)\s+[-+.\d]+\s+Tf|<([\da-f]+)>\s*Tj/gi)) {
        if (token[1]) { font = maps.get(token[1]); assert.ok(font); continue; }
        assert.ok(font);
        assert.equal(token[2].length % 4, 0);
        for (const code of token[2].match(/.{4}/g)) {
          assert.ok(font.has(code.toUpperCase()), 'Missing PDF glyph: ' + code);
          output.push(font.get(code.toUpperCase()));
        }
      }
    }
  }
  return output.join('');
}

test('source-to-export keeps ordinary inline link targets in headings, lists, quotes and table cells', async () => {
  const h = await sourceRuntime(linkedBody);
  for (const target of targets) assert.ok(JSON.stringify(h.document).includes(target), 'Source DTO lost ' + target);
  for (const format of ['markdown', 'txt', 'json']) {
    const generated = await h.api.generateExport(h.plan(format), h.settings);
    const output = new TextDecoder().decode(generated.bytes);
    for (const target of targets) assert.ok(output.includes(target), `${format} lost ${target}`);
  }
  const markdown = h.api.serializeTextFile(h.plan('markdown').files[0], 'markdown', h.settings);
  for (const [index, label] of ['Heading', 'List', 'Ordered', 'Quote', 'Table'].entries()) {
    assert.ok(markdown.includes(`[${label}](${targets[index]})`), 'Markdown link no longer clickable: ' + label);
  }
  const pdf = await h.api.generateExport(h.plan('pdf'), h.settings);
  const pdfText = await generatedPdfText(h.context.PDFLib, pdf.bytes);
  for (const target of targets) assert.ok(pdfText.includes(target), 'Final PDF lost ' + target);
});

test('inline cleanup never changes link destinations, titles, escapes, or turns preview text into HTML', async () => {
  const links = [
    '[**Nested [label]**](https://example.test/__folder__/a_(b)?x=1#part "A title (and more)")',
    '[Escaped \\] label](<https://example.test/a_(b)> "A title with )")',
    '[Spaced destination]( <https://example.test/a)b__c__> "A title")',
    '![Image](https://example.test/image_(1).png)',
    '[<img src=x onerror=alert(1)>](https://example.test/no-html)',
  ];
  const h = await sourceRuntime(links.map(link => '- ' + link).join('\n'));
  const items = h.document.conversation.messages[0].segments[0].blocks[0].items;
  assert.deepEqual(Array.from(items).filter(Boolean), links.filter(link => !link.startsWith('!')),
    'Ordinary links must survive source cleanup byte-for-byte; images use canonical media blocks');
  const images = h.document.conversation.messages[0].segments[0].blocks.filter(block => block.type === 'image');
  assert.equal(images.length, 1);
  const resource = h.document.conversation.resources.find(item => item.id === images[0].resourceId);
  assert.equal(resource.src, 'https://example.test/image_(1).png');
  assert.equal(resource.alt, 'Image');
  const preview = h.context.TidyExportPreview.markup(h.api.serializePreviewParts(h.plan('pdf', false, { mediaAttachments: true }).files[0], h.settings));
  assert.doesNotMatch(preview, /<img src=x|<script|onerror="/);
  assert.match(preview, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('Markdown preserves image descriptions as text and mixed ZIP contains only Markdown members', async () => {
  const names = ['diagram one.png', 'diagram #1.png', 'diagram (1).png', 'literal%20name.png', 'diagram.png', 'diagram.png', '图 表[1].png',
    'a'.repeat(119) + '😀.png'];
  const h = await sourceRuntime('Pictures', names);
  assert.equal(h.api.cleanBaseName('a'.repeat(119) + '😀', 'image'), 'a'.repeat(119));
  assert.equal(h.api.cleanBaseName('a'.repeat(118) + '😀', 'image'), 'a'.repeat(118) + '😀');
  // Media is explicitly enabled; no packaging dependency may be inferred from it.
  for (const mixed of [false, true]) {
    const plan = h.plan('markdown', mixed, { mediaAttachments: true });
    let reads = 0;
    const output = await h.api.generateExport(plan, { ...h.settings, assetLoader: async () => {
      reads++; throw Error('Markdown must not read media');
    } });
    assert.equal(output.warnings.length, 0);
    assert.equal(reads, 0);
    assert.equal(plan.assets?.length || 0, 0);
    assert.equal(plan.zipped, mixed);
    const zip = mixed ? await h.context.JSZip.loadAsync(output.bytes) : null;
    if (zip) assert.deepEqual(Object.values(zip.files).filter(file => !file.dir).map(file => file.name).sort(), Array.from(plan.files, file => file.path).sort());
    else assert.match(output.outputName, /\.md$/);
    for (const file of plan.files) {
      const markdown = zip ? await zip.file(file.path).async('string') : new TextDecoder().decode(output.bytes);
      assert.match(markdown, /Pictures/);
      assert.equal((markdown.match(/> \*\*Image\*\*/g) || []).length, names.length);
      assert.doesNotMatch(markdown, /!\[|assets\/|synthetic-only|estuary/);
    }
  }
});
