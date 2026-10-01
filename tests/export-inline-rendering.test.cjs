const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { exportMessages } = require('./helpers/export-i18n.cjs');

const root = path.resolve(__dirname, '..');
const context = vm.createContext({ URL, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, setTimeout, clearTimeout, setImmediate });
for (const file of ['vendor/pdf-lib-1.17.1.min.js', 'vendor/regenerator-runtime-0.14.1.js', 'vendor/fontkit-1.1.1.min.js',
  'features/export/engine/i18n.js', 'features/export/engine/assets.js', 'features/export/engine/normalize.js', 'features/export/engine/plan.js',
  'features/export/engine/inline-content.js', 'features/export/engine/serializers.js', 'features/export/engine/pdf.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'src', file), 'utf8'), context, { filename: file });
}
const api = context.TidyExport;
const messages = exportMessages('en');
const options = { timestamps: false, messageNumbers: false, finalSources: true };
const settings = { messages, options, assetLoader: async source => {
  assert.ok(source.startsWith('./vendor/fonts/'), 'No network requests in this test');
  return new Uint8Array(fs.readFileSync(path.join(root, 'src/assets/fonts', source.slice('./vendor/fonts/'.length))));
} };

function fileFor(blocks, sources = []) {
  const data = api.normalizeExportData({ conversations: [{
    id: 'inline', title: 'Inline rendering', createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z',
    resources: [], messages: [{ id: 'answer', messageNumber: 1, role: 'assistant', timestamp: null, segments: [
      { type: 'content', sourceMessageId: 'answer', timestamp: null, blocks },
      ...(sources.length ? [{ type: 'sources', sourceMessageId: 'answer', timestamp: null, items: sources }] : []),
    ] }],
  }], bookmarks: [] });
  return api.buildExportPlan({ messages, options, data, mode: 'current', format: 'pdf', currentConversationId: 'inline' }).files[0];
}

test('ordinary links retain complete destinations, escaped labels, nested parentheses and optional titles', () => {
  const cases = [
    ['Read [GitHub](https://example.test/a_(b)?q=%2F#part).', 'Read GitHub · https://example.test/a_(b)?q=%2F#part.'],
    ['[Escaped \\] label](<https://example.test/a_(b)> "Title with )")', 'Escaped ] label · https://example.test/a_(b)'],
    ["[Title [nested]]( https://example.test/a\\)b 'Optional title')", 'Title [nested] · https://example.test/a)b'],
    ['[Entity &amp; label](https://example.test/?a=1&amp;b=2)', 'Entity & label · https://example.test/?a=1&b=2'],
    ['[Numeric](https://example.test/a&#40;b&#x29;)', 'Numeric · https://example.test/a(b)'],
    ['[Literal entity](https://example.test/?a=1\\&amp;b=2)', 'Literal entity · https://example.test/?a=1&amp;b=2'],
    ['[\x60a\\_b\x60](https://example.test/a)', '\x60a\\_b\x60 · https://example.test/a'],
    ['[https://example.test/a](https://example.test/a)', 'https://example.test/a'],
  ];
  for (const [input, expected] of cases) assert.equal(api.inlinePlainText(input), expected, input);
});

test('code, images, malformed candidates and unrelated literals are not reinterpreted', { timeout: 2000 }, () => {
  const literals = [
    '\x60[example](https://code.test/a)\x60',
    '\x60\x60literal \x60 [example](https://code.test/a)\x60\x60',
    '![caption](https://image.test/a.png)',
    "![a\\]b](https://image.test/a\\(b\\))",
    '[unfinished](https://example.test/a',
    '[space](https://example.test/(a b))',
    '[unknown entity](https://example.test/?q=&unrecognized;)',
    'Native code sample: \x60\uE200cite\uE202turn123view0\uE201\x60',
    '['.repeat(100_000),
    '[x]('.repeat(20_000),
  ];
  assert.equal(api.inlinePlainText('See design\\_notes\\[1\\].pdf.'), 'See design_notes[1].pdf.');
  assert.equal(api.inlinePlainText('Use \x60design\\_notes\\[1\\].pdf\x60'), 'Use \x60design\\_notes\\[1\\].pdf\x60');
  assert.equal(api.inlinePlainText('\\\\![alt](https://image.test/a)'), '\\![alt](https://image.test/a)');
  for (const literal of literals) assert.equal(api.inlinePlainText(literal), literal);
  assert.equal(api.inlinePlainText('Before ![caption](https://image.test/a.png) then [text](https://example.test/a)'),
    'Before ![caption](https://image.test/a.png) then text · https://example.test/a');
});

test('engine-generated links escape data labels and destinations without changing percent encoding', () => {
  const label = 'Guide](https://wrong.test/) [Other\\name **literal** <tag> &amp;\nNext';
  for (const url of [
    'https://example.test/a)b?x=%2F&query=1',
    'https://example.test/a(b?x=1&amp;b=2',
    'https://example.test/a\\b?q=x',
    'assets/image%20%281%29.png',
  ]) {
    const markdown = api.formatMarkdownLink(label, url);
    const runs = Array.from(api.inlineMarkdownRuns(markdown));
    assert.equal(runs.length, 1);
    assert.equal(runs[0].url, url);
    assert.equal(runs[0].text, label.replace(/\n/g, ' ') + ' · ' + url);
    assert.ok(!markdown.includes('\n'));
    assert.ok(!markdown.includes('%252F'));
  }
  const whitespace = api.formatMarkdownLink('Label', 'https://example.test/a b\nc<d>');
  assert.equal(api.inlineMarkdownRuns(whitespace)[0].url, 'https://example.test/a%20b%0Ac%3Cd%3E');
  const image = api.formatMarkdownLink('Alt [x]\\name', 'assets/a%20%281%29.png', true);
  assert.equal(image, '![Alt \\[x\\]\\\\name](assets/a%20%281%29.png)');
});

test('source sections, search results, block links and images use the safe generated-link boundary', () => {
  const title = 'Title](https://wrong.test/) [actual\\name';
  const url = 'https://example.test/a)b?x=%2F&b=2';
  const source = { title, url, domain: 'example.test' };
  const file = fileFor([{ type: 'link', text: title, url }], [source]);
  file.conversations[0].messages[0].segments.unshift({
    type: 'process', category: 'search', phase: 'result', label: '', tool: null, queries: [], blocks: [], results: [source],
  });
  const markdown = api.serializeMarkdown(file, settings);
  const exact = api.formatMarkdownLink(title, url);
  assert.equal(markdown.split(exact).length - 1, 3, 'block, final source, and search result keep one exact pair');
  assert.equal(api.inlineMarkdownRuns(exact)[0].url, url);
  const imageMarkdown = api.markdownBlocks([{ type: 'image', resourceId: 'image', alt: title }], {
    messages, conversationId: 'inline',
    resourcesById: new Map([['image', { src: 'https://example.test/a)b.png' }]]),
  });
  assert.equal(imageMarkdown, '> **Image**\n>\n> ' + api.formatMarkdownLink(title, 'https://example.test/a)b.png'));
  assert.doesNotMatch(imageMarkdown, /!\[/);
});


test('native citation pipes survive Markdown table serialization exactly once', () => {
  for (const file of ['native-message-references', 'native-message-content']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'src/platform/chatgpt', file + '.js'), 'utf8'), context, { filename: file });
  }
  const title = 'A | B', url = 'https://example.test/?q=a|b';
  const message = { id: 'pipes', author: { role: 'assistant' }, content: { content_type: 'text',
    parts: ['| Reference |\n| --- |\n| \uE200cite\uE202turn1view0\uE201 |'] },
    metadata: { content_references: [{ ref_id: 'turn1view0', title, url }] } };
  const blocks = context.TidyChatgptNativeMessageContent.contentBlocks(message, new Set(), [], 'pipes', new Map());
  const markdown = api.markdownBlocks(blocks, settings);
  const cell = markdown.split('\n')[2].slice(2, -2);
  assert.ok(cell.includes('\\|'));
  assert.ok(!cell.includes('\\\\|'), 'already escaped citation pipes are not double escaped');
  const run = api.inlineMarkdownRuns(cell)[0];
  assert.equal(run.url, url);
  assert.equal(run.text, title + ' · ' + url);
});

const targets = ['paragraph', 'heading', 'list', 'ordered', 'quote', 'table'].map(name =>
  'https://example.test/' + name + '/full_(destination)?q=%2F&section=details#fragment');
const blocks = [
  { type: 'paragraph', text: '[Paragraph](' + targets[0] + ')' },
  { type: 'heading', level: 2, text: '[Heading](' + targets[1] + ')' },
  { type: 'unordered-list', items: ['[List](' + targets[2] + ')'] },
  { type: 'ordered-list', items: ['[Ordered](' + targets[3] + ')'] },
  { type: 'blockquote', text: '[Quote](' + targets[4] + ')' },
  { type: 'table', headers: ['Reference'], rows: [['[Table](' + targets[5] + ')']] },
  { type: 'paragraph', text: '\x60[Example](https://code.test/inline)\x60' },
  { type: 'code', language: 'md', code: '[Example](https://code.test/block)' },
];

test('Markdown and JSON preserve canonical source; TXT and PDF preview share readable links in every content block', () => {
  const file = fileFor(blocks);
  const markdown = api.serializeMarkdown(file, settings);
  const txt = api.serializeTxt(file, settings);
  const preview = api.serializePreviewParts(file, settings).filter(part => part.type === 'text').map(part => part.text).join('\n');
  for (let index = 0; index < targets.length; index += 1) {
    const label = ['Paragraph', 'Heading', 'List', 'Ordered', 'Quote', 'Table'][index];
    assert.ok(markdown.includes('[' + label + '](' + targets[index] + ')'));
    assert.ok(txt.includes(label + ' · ' + targets[index]));
    assert.ok(preview.includes(label + ' · ' + targets[index]));
  }
  for (const output of [markdown, txt, preview]) {
    assert.ok(output.includes('\x60[Example](https://code.test/inline)\x60'));
    assert.ok(output.includes('[Example](https://code.test/block)'));
  }
  assert.deepEqual(JSON.parse(api.serializeJson(file, settings)).conversation.messages[0].segments[0].blocks, blocks);
});

// Decode final saved PDF streams and ToUnicode maps, not merely input strings.
async function readPdf(bytes) {
  const P = context.PDFLib;
  const document = await P.PDFDocument.load(bytes);
  const unpack = stream => Buffer.from(P.decodePDFRawStream(stream).decode()).toString('latin1');
  const output = [], annotations = [];
  for (const page of document.getPages()) {
    const maps = new Map();
    for (const [name, ref] of page.node.Resources().lookup(P.PDFName.of('Font')).entries()) {
      const cmap = unpack(document.context.lookup(ref).lookup(P.PDFName.of('ToUnicode')));
      const glyphs = new Map();
      assert.doesNotMatch(cmap, /beginbfrange/);
      for (const section of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const pair of section[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>/gi)) {
          glyphs.set(pair[1].toUpperCase(), new TextDecoder('utf-16be').decode(Buffer.from(pair[2], 'hex')));
        }
      }
      maps.set(name.toString().slice(1), glyphs);
    }
    const contents = page.node.Contents();
    const streams = contents instanceof P.PDFArray
      ? Array.from({ length: contents.size() }, (_, index) => contents.lookup(index)) : [contents];
    let font;
    for (const stream of streams) for (const token of unpack(stream).matchAll(/\/([A-Za-z0-9_-]+)\s+[-+.\d]+\s+Tf|<([\da-f]+)>\s*Tj/gi)) {
      if (token[1]) { font = maps.get(token[1]); assert.ok(font); continue; }
      for (const code of token[2].match(/.{4}/g)) { assert.ok(font.has(code.toUpperCase())); output.push(font.get(code.toUpperCase())); }
    }
    const annots = page.node.Annots();
    for (let index = 0; index < (annots?.size() || 0); index += 1) {
      const action = annots.lookup(index).lookup(P.PDFName.of('A'));
      annotations.push(action.lookup(P.PDFName.of('URI')).decodeText());
    }
  }
  return { text: output.join(''), annotations };
}

test('actual PDF matches readable preview links including tables, full long sources and safe clickable targets', async () => {
  const specialTitle = 'Special](https://wrong.test/) [source';
  const specialUrl = 'https://example.test/a)b?q=%2F&amp;b=2';
  const longUrl = 'https://example.test/' + 'long-path-segment/'.repeat(12) + '?q=%2F&full=true#tail';
  const file = fileFor([...blocks,
    { type: 'paragraph', text: '[Unsafe](javascript:alert(1))' },
    { type: 'table', headers: ['Entity link'], rows: [['[Entity](https://example.test/?a=1&amp;b=2)']] },
  ], [{ title: 'Long source', url: longUrl, domain: 'example.test' }, { title: specialTitle, url: specialUrl, domain: 'example.test' }]);
  const result = await api.serializePdf(file, settings);
  assert.ok(result.bytes.length > 1000);
  assert.deepEqual(Array.from(result.warnings), []);
  const actual = await readPdf(result.bytes);
  for (let index = 0; index < targets.length; index += 1) {
    const label = ['Paragraph', 'Heading', 'List', 'Ordered', 'Quote', 'Table'][index];
    assert.ok(actual.text.includes(label + ' · ' + targets[index]), 'Real PDF lost ' + label);
    assert.ok(actual.annotations.includes(targets[index]), 'Real PDF link lost ' + label);
  }
  assert.ok(actual.text.includes(longUrl), 'Visible PDF source URL is complete, never shortened');
  assert.ok(actual.annotations.includes(longUrl));
  assert.ok(actual.text.includes(specialTitle));
  assert.ok(actual.text.includes(specialUrl));
  assert.ok(actual.annotations.includes(specialUrl));
  assert.ok(!actual.annotations.includes('https://wrong.test/'));
  assert.ok(actual.text.includes('Entity · https://example.test/?a=1&b=2'));
  assert.ok(actual.annotations.includes('https://example.test/?a=1&b=2'));
  assert.ok(actual.text.includes('[Example](https://code.test/block)'));
  assert.ok(actual.text.includes('\x60[Example](https://code.test/inline)\x60'));
  assert.ok(!actual.annotations.some(url => /code\.test|^javascript:/.test(url)));
  assert.doesNotMatch(actual.text, /File citation:|turn\d+(?:view|image)|□/);
});
