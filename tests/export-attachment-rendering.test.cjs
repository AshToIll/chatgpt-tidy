const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { exportMessages } = require('./helpers/export-i18n.cjs');

const root = path.resolve(__dirname, '..');
const messages = exportMessages('en');
const options = { timestamps: false, messageNumbers: false, toolProcess: false, mediaAttachments: true };
const label = 'Read the complete verification notes';
const sourceUrl = 'https://chatgpt.com/c/attachment-conversation';
const plain = value => JSON.parse(JSON.stringify(value));
const occurrences = (text, needle) => String(text).split(needle).length - 1;

// Exercise the shipping contract, projection and serializers, not copied test renderers.
// Native attachment recognition has a separate owner and separate real-shape fixtures.
function runtime() {
  const context = vm.createContext({ URL, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, setTimeout, clearTimeout, setImmediate });
  const load = relative => vm.runInContext(fs.readFileSync(path.join(root, 'src', relative), 'utf8'), context, { filename: relative });
  load('features/export/model/export.js');
  for (const name of ['i18n', 'assets', 'normalize', 'plan', 'inline-content', 'serializers', 'pdf']) load('features/export/engine/' + name + '.js');
  return { context, api: context.TidyExport, contract: context.TidyExportContract, load };
}
function conversation(id = 'attachment-conversation', block = { type: 'attachment', resourceId: 'delivered', label }) {
  const attachment = (id, name) => ({ id, type: 'attachment', name, mimeType: 'text/plain', sizeBytes: 128, src: '', alt: '' });
  return {
    id, title: 'Attachment export ' + id, createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z',
    sourceUrl: 'https://chatgpt.com/c/' + id,
    resources: [attachment('delivered', 'report.txt'), attachment('temporary', 'tool-only.txt')],
    messages: [{ id: 'answer-' + id, role: 'assistant', messageNumber: 1, timestamp: null, segments: [
      { type: 'process', sourceMessageId: 'tool-' + id, timestamp: null, category: 'tool', phase: 'result', label: '',
        blocks: [{ type: 'attachment', resourceId: 'temporary', label: 'Internal tool file' }], queries: [], results: [], tool: { name: 'python', callId: '' } },
      { type: 'content', sourceMessageId: 'answer-' + id, timestamp: null, blocks: [{ type: 'paragraph', text: 'The final answer stays visible.' }, block] },
    ] }],
  };
}
function planned(h, conversations = [conversation()], selectedOptions = options, extra = {}) {
  const data = h.api.normalizeExportData({ conversations, bookmarks: conversations.map(item => ({
    id: 'saved-' + item.id, conversationId: item.id, messageId: item.messages[0].id, bookmarkedAt: '2026-09-29T00:00:00Z', groupId: null,
  })) });
  return h.api.buildExportPlan({ messages, options: selectedOptions, data, mode: 'current', format: 'markdown', currentConversationId: conversations[0].id, ...extra });
}
function output(h, file, selectedOptions = options) {
  const context = { messages, options: selectedOptions };
  return {
    markdown: h.api.serializeTextFile(file, 'markdown', context),
    txt: h.api.serializeTextFile(file, 'txt', context),
    json: JSON.parse(h.api.serializeTextFile(file, 'json', context)),
    preview: h.api.serializePreviewParts(file, context).map(part => part.text || '').join('\n'),
  };
}
const attachmentBlocks = item => item.messages.flatMap(message => message.segments.flatMap(segment => segment.blocks || [])).filter(block => block.type === 'attachment');

test('attachment label is optional but must be a string when explicitly present', () => {
  const h = runtime();
  for (const value of [undefined, '', label]) {
    const block = { type: 'attachment', resourceId: 'delivered', ...(value === undefined ? {} : { label: value }) };
    const doc = { schemaVersion: h.contract.VERSION, conversation: conversation(undefined, block), warnings: [] };
    assert.equal(h.contract.validateDocument(doc).valid, true, String(value));
  }
  for (const value of [null, 7, false, {}, []]) {
    const doc = { schemaVersion: h.contract.VERSION, conversation: conversation(undefined, { type: 'attachment', resourceId: 'delivered', label: value }), warnings: [] };
    const result = h.contract.validateDocument(doc);
    assert.equal(result.valid, false, JSON.stringify(value));
    assert.ok(result.errors.some(error => error.endsWith('.label')));
  }
});

test('normalization, public JSON and media plain text preserve the delivery label without exposing a sandbox locator', () => {
  const h = runtime(), input = conversation();
  const normalized = h.api.normalizeConversation(input);
  assert.equal(attachmentBlocks(normalized).find(block => block.resourceId === 'delivered').label, label);
  assert.match(h.api.blocksToPlainText([input.messages[0].segments[1].blocks[1]], input.resources), /Read the complete verification notes/);
  const { json } = output(h, planned(h, [input]).files[0]);
  assert.equal(attachmentBlocks(json.conversation)[0].label, label);
  assert.equal(json.conversation.sourceUrl, sourceUrl);
  assert.equal(json.conversation.resources.length, 1);
  assert.equal(Object.hasOwn(json.conversation.resources[0], 'src'), false);
  assert.doesNotMatch(JSON.stringify(json), /sandbox:|\/mnt\/data\//);
});

test('Markdown, TXT and preview show the same delivery label and the original conversation at the attachment', () => {
  const h = runtime(), file = planned(h).files[0], rendered = output(h, file);
  for (const kind of ['markdown', 'txt', 'preview']) {
    assert.equal(occurrences(rendered[kind], label), 1, kind);
    assert.equal(occurrences(rendered[kind], 'report.txt'), 1, kind);
    assert.equal(occurrences(rendered[kind], sourceUrl), 2, kind + ': conversation header and attachment card');
    assert.ok(rendered[kind].lastIndexOf(sourceUrl) > rendered[kind].indexOf(label), kind + ': card source follows the label');
    assert.doesNotMatch(rendered[kind], /Internal tool file|tool-only\.txt|sandbox:/);
  }
  assert.equal(h.api.serializeTextExcerpt(file, 'markdown', { messages, options }, 10000), rendered.markdown);
  assert.equal(h.api.serializeTextExcerpt(file, 'txt', { messages, options }, 10000), rendered.txt);
});

test('attachments without a label retain their original simple rendering and do not gain a redundant card source', () => {
  const h = runtime(), block = { type: 'attachment', resourceId: 'delivered' }, input = conversation(undefined, block);
  const context = { messages, sourceUrl, resourcesById: new Map(input.resources.map(resource => [resource.id, resource])) };
  assert.equal(h.api.markdownBlocks([block], context), '> **Attachment**\n>\n> `report.txt` · text/plain · 128 B');
  assert.equal(h.api.txtBlocks([block], context), '[Attachment: report.txt] text/plain · 128 B');
  const rendered = output(h, planned(h, [input]).files[0]);
  assert.equal(Object.hasOwn(attachmentBlocks(rendered.json.conversation)[0], 'label'), false);
  for (const kind of ['markdown', 'txt', 'preview']) assert.equal(occurrences(rendered[kind], sourceUrl), 1, kind);
});

test('a delivery label equal to the file name is not repeated but still identifies an original-conversation card', () => {
  const h = runtime(), input = conversation(undefined, { type: 'attachment', resourceId: 'delivered', label: 'report.txt' });
  const rendered = output(h, planned(h, [input]).files[0]);
  for (const kind of ['markdown', 'txt', 'preview']) {
    assert.equal(occurrences(rendered[kind], 'report.txt'), 1, kind);
    assert.equal(occurrences(rendered[kind], sourceUrl), 2, kind);
  }
});

test('attachment cards never invent a source link for missing or unsafe conversation addresses', () => {
  const h = runtime(), input = conversation(), block = input.messages[0].segments[1].blocks[1];
  for (const sourceUrl of ['', 'not a URL', 'sandbox:/mnt/data/report.txt', 'javascript:alert(1)', 'file:///C:/report.txt', 'http://localhost/report']) {
    const context = { messages, sourceUrl, resourcesById: new Map(input.resources.map(resource => [resource.id, resource])) };
    for (const render of [h.api.markdownBlocks, h.api.txtBlocks]) {
      const text = render([block], context);
      assert.ok(text.includes(label));
      assert.doesNotMatch(text, /Open original conversation|sandbox:|javascript:|file:|localhost/);
    }
  }
});

test('content attachments obey media only; temporary tool attachments additionally obey tool process', () => {
  const h = runtime();
  for (const toolProcess of [false, true]) for (const mediaAttachments of [false, true]) {
    const selectedOptions = { ...options, toolProcess, mediaAttachments };
    const file = planned(h, [conversation()], selectedOptions).files[0], rendered = output(h, file, selectedOptions);
    const blocks = attachmentBlocks(rendered.json.conversation);
    assert.equal(blocks.some(block => block.resourceId === 'delivered'), mediaAttachments);
    assert.equal(blocks.some(block => block.resourceId === 'temporary'), mediaAttachments && toolProcess);
    assert.equal(rendered.json.conversation.resources.length, mediaAttachments ? (toolProcess ? 2 : 1) : 0);
    for (const kind of ['markdown', 'txt', 'preview']) {
      assert.equal(rendered[kind].includes(label), mediaAttachments, kind);
      assert.equal(rendered[kind].includes('Internal tool file'), mediaAttachments && toolProcess, kind);
      assert.ok(rendered[kind].includes('The final answer stays visible.'));
      // The common conversation header remains; media-off removes the extra attachment source.
      assert.equal(occurrences(rendered[kind], sourceUrl), 1 + (mediaAttachments ? (toolProcess ? 2 : 1) : 0), kind);
    }
  }
});

test('merged bookmark excerpts keep each attachment label and source inside its own conversation section', () => {
  const h = runtime(), first = conversation('first'), second = conversation('second');
  first.messages[0].segments[1].blocks[1].label = 'Delivery from FIRST';
  second.messages[0].segments[1].blocks[1].label = 'Delivery from SECOND';
  const file = planned(h, [first, second], options, { mode: 'batch', currentConversationId: undefined,
    conversationIds: [], bookmarkIds: ['saved-first', 'saved-second'], bookmarkOrganization: 'all-bookmarks' }).files[0];
  const rendered = output(h, file);
  for (const kind of ['markdown', 'txt', 'preview']) {
    const text = rendered[kind], start = text.indexOf('Delivery from FIRST'), end = text.indexOf('Attachment export second');
    assert.ok(start >= 0 && end > start, kind);
    assert.ok(text.slice(start, end).includes(first.sourceUrl), kind + ': first card source');
    assert.equal(text.slice(start, end).includes(second.sourceUrl), false, kind + ': no cross-conversation source');
    assert.ok(text.slice(text.indexOf('Delivery from SECOND')).includes(second.sourceUrl), kind + ': second card source');
  }
  assert.deepEqual(rendered.json.conversations.map(item => attachmentBlocks(item)[0].label), ['Delivery from FIRST', 'Delivery from SECOND']);
});

// Decode actual saved PDF glyph streams and annotations. Counting input labels alone
// would miss cards whose text was dropped or whose source URL was never linked.
async function pdfContents(h, bytes) {
  const P = h.context.PDFLib, document = await P.PDFDocument.load(bytes), pageTexts = [], links = [];
  const unpack = stream => Buffer.from(P.decodePDFRawStream(stream).decode()).toString('latin1');
  for (const page of document.getPages()) {
    const fonts = new Map(), output = [];
    for (const [name, ref] of page.node.Resources().lookup(P.PDFName.of('Font')).entries()) {
      const cmap = unpack(document.context.lookup(ref).lookup(P.PDFName.of('ToUnicode'))), glyphs = new Map();
      for (const section of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const pair of section[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>/gi))
        glyphs.set(pair[1].toUpperCase(), new TextDecoder('utf-16be').decode(Buffer.from(pair[2], 'hex')));
      fonts.set(name.toString().slice(1), glyphs);
    }
    const contents = page.node.Contents(), streams = contents instanceof P.PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i)) : [contents];
    let font;
    for (const stream of streams) for (const token of unpack(stream).matchAll(/\/([A-Za-z0-9_-]+)\s+[-+.\d]+\s+Tf|<([\da-f]+)>\s*Tj/gi)) {
      if (token[1]) { font = fonts.get(token[1]); assert.ok(font); continue; }
      for (const code of token[2].match(/.{4}/g)) { assert.ok(font.has(code.toUpperCase())); output.push(font.get(code.toUpperCase())); }
    }
    pageTexts.push(output.join(''));
    const annotations = page.node.Annots();
    for (let i = 0; i < (annotations?.size() || 0); i++) {
      const action = annotations.lookup(i).lookup(P.PDFName.of('A'));
      const uri = action?.lookup(P.PDFName.of('URI'));
      if (uri) links.push(uri.decodeText());
    }
  }
  return { pageTexts, links };
}

test('saved PDF preserves attachment labels and source links without fetching attachment bytes', { timeout: 30000 }, async () => {
  const h = runtime(), requests = [];
  for (const file of ['pdf-lib-1.17.1.min.js', 'regenerator-runtime-0.14.1.js', 'fontkit-1.1.1.min.js']) h.load('vendor/' + file);
  const assetLoader = async source => {
    requests.push(source);
    assert.ok(source.startsWith('./vendor/fonts/'), 'Attachment descriptions must not download binaries: ' + source);
    return new Uint8Array(fs.readFileSync(path.join(root, 'src/assets/fonts', source.slice('./vendor/fonts/'.length))));
  };
  const result = await h.api.serializePdf(planned(h).files[0], { messages, options, assetLoader });
  assert.deepEqual(plain(result.warnings), []);
  const pdf = await pdfContents(h, result.bytes), text = pdf.pageTexts.join('');
  assert.equal(occurrences(text, label), 1);
  assert.equal(occurrences(text, 'report.txt'), 1);
  assert.equal(occurrences(pdf.links.join('\n'), sourceUrl), 2, 'Header and attachment card each link to original conversation');
  assert.doesNotMatch(text, /Internal tool file|sandbox:/);
  assert.ok(requests.length > 0);
  const mediaOff = { ...options, mediaAttachments: false };
  const hidden = await h.api.serializePdf(planned(h, [conversation()], mediaOff).files[0], { messages, options: mediaOff, assetLoader });
  const hiddenPdf = await pdfContents(h, hidden.bytes);
  assert.doesNotMatch(hiddenPdf.pageTexts.join(''), /Read the complete verification notes|report\.txt|tool-only\.txt/);
  assert.equal(occurrences(hiddenPdf.links.join('\n'), sourceUrl), 1, 'Media-off leaves only the conversation header source');
});

test('a multi-page attachment description retains every line exactly once', { timeout: 30000 }, async () => {
  const h = runtime(), lines = Array.from({ length: 115 }, (_, i) => 'ATTACHMENT-LINE-' + String(i).padStart(3, '0') + '-END');
  for (const file of ['pdf-lib-1.17.1.min.js', 'regenerator-runtime-0.14.1.js', 'fontkit-1.1.1.min.js']) h.load('vendor/' + file);
  const input = conversation(undefined, { type: 'attachment', resourceId: 'delivered', label: lines.join('\n') });
  const result = await h.api.serializePdf(planned(h, [input]).files[0], { messages, options, pdf: { orientation: 'landscape', fontSize: 'large' },
    assetLoader: async source => {
      assert.ok(source.startsWith('./vendor/fonts/'));
      return new Uint8Array(fs.readFileSync(path.join(root, 'src/assets/fonts', source.slice('./vendor/fonts/'.length))));
    } });
  const pdf = await pdfContents(h, result.bytes), text = pdf.pageTexts.join('');
  assert.ok(pdf.pageTexts.length >= 3 && pdf.pageTexts.length < 15);
  for (const line of lines) assert.equal(occurrences(text, line), 1, line);
  assert.equal(occurrences(pdf.links.join('\n'), sourceUrl), 2);
});
