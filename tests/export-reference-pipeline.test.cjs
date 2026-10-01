const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { exportMessages } = require('./helpers/export-i18n.cjs');
const root = path.resolve(__dirname, '..');
const marker = (kind, ...ids) => '\uE200' + kind + '\uE202' + ids.join('\uE202') + '\uE201';
const cite = marker('cite', 'turn10view0', 'turn10view1');
const image = marker('i', 'turn10image0');
const targets = ['https://docs.example.test/guide', 'https://code.example.test/repository'];
const picture = 'https://images.example.test/reference.png';

// The source adapter, DTO contract, options, preview and file generators are all real.
// Only the upstream conversation and image bytes are synthetic: no live account or downloads.
function harness() {
  const context = vm.createContext({ URL, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
    setTimeout, clearTimeout, setImmediate });
  const load = file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  for (const name of ['active-branch', 'native-message-references', 'native-message-content',
    'native-message-process', 'conversation-projection']) load('src/platform/chatgpt/' + name + '.js');
  load('src/features/export/model/export.js');
  for (const name of ['i18n', 'assets', 'normalize', 'plan', 'inline-content', 'serializers', 'pdf'])
    load('src/features/export/engine/' + name + '.js');
  const body = ['# Report ' + cite, '', 'Body ' + cite, '', '| Claim | Evidence |', '| --- | --- |',
    '| table content | ' + cite + ' |', '', image, '', '![Ordinary media](' + picture + ')', '', 'End of answer'].join('\n');
  const payload = { id: 'pipeline', title: 'Synthetic export reference pipeline',
    create_time: 1700000000, update_time: 1700000001, current_node: 'answer', mapping: {
      root: { parent: null },
      user: { parent: 'root', message: { id: 'question', author: { role: 'user' }, create_time: 1700000000,
        content: { content_type: 'text', parts: ['A question'] } } },
      answer: { parent: 'user', message: { id: 'answer', author: { role: 'assistant' }, create_time: 1700000001,
        content: { content_type: 'text', parts: [body] }, metadata: { content_references: [
          { type: 'grouped_webpages', matched_text: cite, safe_urls: [targets[1], targets[0]],
            items: [{ title: 'Documentation', url: targets[0], refs: [{ turn_index: 10, ref_type: 'view', ref_index: 0 }] },
              { title: 'Repository', url: targets[1], refs: [{ turn_index: 10, ref_type: 'view', ref_index: 1 }] }] },
          { ref_id: 'turn10image0', image_url: picture, caption: 'Reference diagram' },
        ] } } },
    } };
  const projected = context.TidyChatgptConversationProjection.projectConversation(payload, 'pipeline');
  const document = { schemaVersion: context.TidyExportContract.VERSION, ...projected };
  const validation = context.TidyExportContract.validateDocument(document);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const api = context.TidyExport;
  const data = api.normalizeExportData({ conversations: [document.conversation],
    bookmarks: [{ id: 'saved-answer', conversationId: 'pipeline', messageId: 'answer',
      bookmarkedAt: '2026-09-29T00:00:00Z', groupId: null }] });
  const plan = (format, options, mode = 'current', messages = exportMessages('en')) =>
    api.buildExportPlan({ format, options, data, messages, mode,
      ...(mode === 'current' ? { currentConversationId: 'pipeline' }
        : { conversationIds: ['pipeline'], bookmarkIds: ['saved-answer'] }) });
  return { context, load, api, data, document, plan };
}

const optionNames = ['timestamps', 'messageNumbers', 'visibleProcess', 'toolProcess', 'webProcess', 'finalSources', 'mediaAttachments'];
test('native references survive current/batch/bookmark and all 128 content-option combinations', () => {
  const h = harness(), messages = exportMessages('en');
  for (let bits = 0; bits < 128; bits += 1) {
    const options = Object.fromEntries(optionNames.map((name, index) => [name, Boolean(bits & (1 << index))]));
    for (const mode of ['current', 'batch']) for (const format of ['markdown', 'txt', 'json']) {
      const plan = h.plan(format, options, mode);
      assert.equal(plan.files.length, mode === 'current' ? 1 : 2);
      for (const file of plan.files) {
        const output = h.api.serializeTextFile(file, format, { messages, options });
        const label = format + '/' + mode + '/' + bits + '/' + file.kind;
        assert.doesNotMatch(output, /File citation|iturn|turn10(?:view|image)|[\uE200\uE201\uE202]/, label);
        assert.ok(output.includes('End of answer'), label);
        for (const target of targets) assert.ok(output.includes(target), label + ' missing inline reference');
        assert.equal(output.includes('Reference diagram'), options.mediaAttachments, label + ' native image toggle');
        assert.equal(output.includes('Ordinary media'), options.mediaAttachments, label + ' Markdown image toggle');
        if (format !== 'json') assert.equal(output.includes('Final cited sources'), options.finalSources, label + ' source section toggle');
        else {
          const parsed = JSON.parse(output);
          assert.ok(parsed.schemaVersion);
          const conversations = parsed.conversation ? [parsed.conversation] : parsed.conversations;
          for (const conversation of conversations) {
            assert.equal(conversation.resources.length > 0, options.mediaAttachments, label + ' resource projection');
            const sources = conversation.messages.flatMap(message => message.segments).filter(segment => segment.type === 'sources');
            assert.equal(sources.length > 0, options.finalSources, label + ' source projection');
          }
        }
      }
    }
  }
});

test('real PDF paragraphs and tables keep resolved source URLs without native-marker glyph warnings', async () => {
  const h = harness();
  for (const file of ['pdf-lib-1.17.1.min.js', 'regenerator-runtime-0.14.1.js', 'fontkit-1.1.1.min.js']) h.load('src/vendor/' + file);
  const messages = exportMessages('en');
  const options = { timestamps: false, messageNumbers: false, mediaAttachments: false, finalSources: false };
  const file = h.plan('pdf', options).files[0], encoded = [];
  const original = h.context.PDFLib.PDFFont.prototype.encodeText;
  h.context.PDFLib.PDFFont.prototype.encodeText = function(text) { encoded.push(text); return original.call(this, text); };
  const result = await h.api.serializePdf(file, { messages, options, assetLoader: async source => {
    assert.ok(source.startsWith('./vendor/fonts/'), 'Disabled media must not trigger a picture request');
    return new Uint8Array(fs.readFileSync(path.join(root, 'src/assets/fonts', source.slice('./vendor/fonts/'.length))));
  } });
  const text = encoded.join('');
  assert.ok(result.bytes.length > 1000);
  assert.equal(result.warnings.length, 0, result.warnings.join('\n'));
  assert.doesNotMatch(text, /File citation|iturn|turn10(?:view|image)|[\uE200\uE201\uE202\u25a1]/);
  for (const target of targets) assert.ok(text.includes(target), 'Final PDF dropped ' + target);
  assert.match(text, /table content/);
  const pdf = await h.context.PDFLib.PDFDocument.load(result.bytes);
  const urls = pdf.getPages().flatMap(page => {
    const annotations = page.node.Annots();
    if (!annotations) return [];
    return Array.from({ length: annotations.size() }, (_, i) => annotations.lookup(i))
      .map(item => item.lookup(h.context.PDFLib.PDFName.of('A'))?.lookup(h.context.PDFLib.PDFName.of('URI'))?.decodeText()).filter(Boolean);
  });
  for (const target of targets) assert.ok(urls.includes(target), 'PDF link annotation missing ' + target);
  const preview = h.api.serializePreviewParts(file, { messages, options }).map(part => part.text || part.alt).join('\n');
  assert.doesNotMatch(preview, /File citation|iturn|turn10(?:view|image)|[\uE200\uE201\uE202]/);
  for (const target of targets) assert.ok(preview.includes(target), 'PDF preview dropped ' + target);
});
