const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { installPageSession } = require('./helpers/page-session.cjs');
const { exportMessages } = require('./helpers/export-i18n.cjs');
const root = path.resolve(__dirname, '..');
const ids = { user: 'file_' + 'a'.repeat(32), generated: 'file_' + 'b'.repeat(32), process: 'file_' + 'c'.repeat(32) };
const publicImage = 'https://images.example.test/search-thumbnail.png';
const publicSource = 'https://sources.example.test/image-result';
const signed = id => 'https://chatgpt.com/backend-api/estuary/content?id=' + id + '&sig=synthetic-test-only';
// Real responses use dynamic tool aliases and carry the generation identity on each image part.
// The fixture retains that structure while replacing every user, generation and file identity.
const pointer = kind => ({ content_type: 'image_asset_pointer', asset_pointer: 'sediment://' + ids[kind],
  ...(kind === 'generated' ? { metadata: { generation: { gen_id: 'synthetic-generation', gen_size: 'smimage' },
    dalle: { gen_id: 'synthetic-generation' } } } : {}),
});
const defaults = { mediaAttachments: true, toolProcess: false, webProcess: false, visibleProcess: false, finalSources: false, timestamps: false, messageNumbers: false };

// Only the upstream response and downloaded image bytes are synthetic. The native adapter,
// authenticated read-handle lifecycle, option projection, preview and final file generators are real.
// A generated tool result is visible assistant output; ordinary/hidden tool pictures are not promoted.
function harness() {
  const calls = [], assets = [];
  const icons = ['tidy-outlined-32.png', 'tidy-white-48.png', 'tidy-outlined-128.png'];
  const imageBytes = new Map([
    [signed(ids.user), fs.readFileSync(path.join(root, 'src/assets/icons', icons[0]))],
    [signed(ids.generated), fs.readFileSync(path.join(root, 'src/assets/icons', icons[1]))],
    [publicImage, fs.readFileSync(path.join(root, 'src/assets/icons', icons[2]))],
  ]);
  const imageToken = '\uE200i\uE202turn20image0\uE201';
  const message = (id, role, parts, extra = {}) => ({ id, author: { role }, create_time: 1700000000,
    content: { content_type: 'multimodal_text', parts }, ...extra });
  const payload = id => ({ id, title: 'Both participants have images', current_node: 'final', mapping: {
    user: { parent: null, message: message('user-picture', 'user', ['Draw this reference.', pointer('user')]) },
    call: { parent: 'user', message: message('image-call', 'assistant', ['Internal generation prompt'], { recipient: 'dynamic-tool-a.result-b' }) },
    generated: { parent: 'call', message: message('generated-picture', 'tool', [pointer('generated'), 'Internal generation diagnostic'],
      { author: { role: 'tool', name: 'dynamic-tool-a.result-b' } }) },
    ordinary: { parent: 'generated', message: message('ordinary-tool-picture', 'tool', [pointer('process'), 'Ordinary tool details'],
      { author: { role: 'tool', name: 'python' } }) },
    hidden: { parent: 'ordinary', message: message('hidden-picture', 'tool', [pointer('generated')],
      { author: { role: 'tool', name: 'dynamic-tool-a.result-b' }, metadata: { is_visually_hidden_from_conversation: true } }) },
    final: { parent: 'hidden', message: message('assistant-answer', 'assistant', ['The finished picture is above.', imageToken],
      { metadata: { content_references: [{ type: 'image', ref_id: 'turn20image0', caption: '[![Search picture](' + publicImage + ')](' + publicSource + ')' }] } }) },
    abandoned: { parent: 'user', message: message('abandoned-picture', 'tool', [pointer('generated')],
      { author: { role: 'tool', name: 'dynamic-tool-a.result-b' } }) },
  } });
  const context = vm.createContext({ URL, Headers, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, AbortController,
    setTimeout, clearTimeout, setImmediate, location: { href: 'https://chatgpt.com/c/both-images', origin: 'https://chatgpt.com' },
    document: { cookie: '' }, fetch: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/auth/session') return { ok: true, json: async () => ({ accessToken: 'synthetic-token', user: { id: 'synthetic-account' } }) };
      if (url.startsWith('/backend-api/conversation/')) return { ok: true, json: async () => payload(url.split('/').pop()) };
      const match = /^\/backend-api\/files\/download\/(file_[a-f0-9]{32})\?inline=false&download_intent=false$/.exec(url);
      assert.ok(match, 'Only an explicitly registered native image locator may be resolved: ' + url);
      assert.equal(options.headers.get('Authorization'), 'Bearer synthetic-token');
      return { ok: true, json: async () => ({ download_url: signed(match[1]), mime_type: 'image/png', file_name: 'picture-' + match[1].slice(-1) + '.png' }) };
    } });
  const load = name => vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context, { filename: name });
  installPageSession(context);
  for (const file of ['src/platform/snapshot.js', 'src/features/export/model/export.js', 'src/features/export/model/export-preview.js',
    'src/platform/chatgpt/route.js', 'src/platform/chatgpt/api.js', 'src/platform/chatgpt/active-branch.js',
    'src/platform/chatgpt/native-message-references.js', 'src/platform/chatgpt/native-message-content.js',
    'src/platform/chatgpt/native-message-process.js', 'src/platform/chatgpt/conversation-projection.js', 'src/features/export/chatgpt/export.js'])
    load(file);
  for (const name of ['i18n', 'normalize', 'plan', 'inline-content', 'serializers', 'pdf']) load('src/features/export/engine/' + name + '.js');
  const api = context.TidyExport;
  const plan = (doc, format = 'pdf', options = defaults, mode = 'current') => api.buildExportPlan({
    messages: exportMessages('en'), mode, format, options,
    data: api.normalizeExportData({ conversations: [doc.conversation], bookmarks: [{
      id: 'saved-answer', conversationId: doc.conversation.id, messageId: 'assistant-answer', bookmarkedAt: '2026-09-29T00:00:00Z', groupId: null,
    }] }),
    ...(mode === 'current' ? { currentConversationId: doc.conversation.id } : { conversationIds: [doc.conversation.id], bookmarkIds: ['saved-answer'] }),
  });
  const read = async () => context.TidyChatgptExport.readCurrentConversation({ expectedConversationId: 'both-images' });
  const hydrate = async (doc, options = defaults) => {
    for (const { resource } of api.selectedImageResources(plan(doc, 'pdf', options))) if (resource.pending) {
      const original = doc.conversation.resources.find(item => item.id === resource.id);
      const result = await context.TidyChatgptExport.readImageResource({ readHandle: original.readHandle });
      Object.assign(original, result.resource); delete original.readHandle;
    }
    return doc;
  };
  const assetLoader = async source => {
    assets.push(source);
    if (imageBytes.has(source)) return new Uint8Array(imageBytes.get(source));
    assert.ok(source.startsWith('./vendor/fonts/'), 'Unexpected image or resource request: ' + source);
    return new Uint8Array(fs.readFileSync(path.join(root, 'src/assets/fonts', source.slice('./vendor/fonts/'.length))));
  };
  const libraries = () => {
    for (const file of ['pdf-lib-1.17.1.min.js', 'regenerator-runtime-0.14.1.js', 'fontkit-1.1.1.min.js', 'jszip-3.10.1.min.js']) load('src/vendor/' + file);
    load('src/features/export/engine/dependencies.js'); load('src/features/export/engine/assets.js'); load('src/features/export/engine/download.js');
  };
  return { context, api, calls, assets, imageBytes, read, hydrate, plan, assetLoader, libraries };
}

test('media-enabled current/batch/bookmark exports select visible generated pictures without enabling tool internals', async () => {
  for (const mediaAttachments of [false, true]) for (const toolProcess of [false, true]) {
    const h = harness(), doc = await h.read(), options = { ...defaults, mediaAttachments, toolProcess };
    const expected = mediaAttachments ? (toolProcess ? 4 : 3) : 0;
    for (const mode of ['current', 'batch']) {
      const planned = h.plan(doc, 'pdf', options, mode);
      assert.equal(h.api.selectedImageResources(planned).length, expected, mode + '/' + mediaAttachments + '/' + toolProcess);
      const printable = JSON.stringify(planned);
      assert.doesNotMatch(printable, /hidden-picture|abandoned-picture/);
      if (!toolProcess) assert.doesNotMatch(printable, /Internal generation|Ordinary tool details/);
    }
    await h.hydrate(doc, options);
    const downloads = h.calls.filter(call => call.url.includes('/files/download/'));
    assert.equal(downloads.length, mediaAttachments ? (toolProcess ? 3 : 2) : 0);
    assert.equal(downloads.some(call => call.url.includes(ids.generated)), mediaAttachments);
    assert.equal(downloads.some(call => call.url.includes(ids.process)), mediaAttachments && toolProcess);
  }
});

test('final PDF embeds both participants and search pictures while Markdown keeps only media descriptions', async () => {
  const h = harness(), doc = await h.hydrate(await h.read()); h.libraries();
  const planned = h.plan(doc), context = { messages: exportMessages('en'), options: defaults, assetLoader: h.assetLoader };
  const preview = h.api.serializePreviewParts(planned.files[0], context);
  assert.equal(preview.filter(part => part.type === 'image').length, 3);
  assert.doesNotMatch(JSON.stringify(preview), /\[!\[|Internal generation|Ordinary tool/);
  const result = await h.api.generateExport(planned, context);
  assert.deepEqual(Array.from(result.warnings), []);
  const pdf = await h.context.PDFLib.PDFDocument.load(result.bytes), { PDFName, PDFDict } = h.context.PDFLib;
  const drawnImages = pdf.getPages().flatMap(page => {
    const dictionary = page.node.Resources().lookup(PDFName.of('XObject'), PDFDict);
    return dictionary ? Array.from(dictionary.entries()).filter(([, ref]) => pdf.context.lookup(ref)?.dict?.get(PDFName.of('Subtype'))?.toString() === '/Image') : [];
  });
  assert.equal(drawnImages.length, 3, 'Check page image objects, not just alt text or resource metadata');
  assert.doesNotMatch(Buffer.from(result.bytes).toString('latin1'), /synthetic-test-only|estuary/);
  for (const source of h.imageBytes.keys()) assert.ok(h.assets.includes(source), 'Missing real image-byte request: ' + source);
  h.assets.length = 0;
  const markdownPlan = h.plan(doc, 'markdown');
  const markdown = await h.api.generateExport(markdownPlan, context);
  assert.equal(markdownPlan.zipped, false);
  assert.equal(markdownPlan.assets?.length || 0, 0);
  assert.equal(h.assets.length, 0);
  const text = new TextDecoder().decode(markdown.bytes);
  assert.equal((text.match(/> \*\*Image\*\*/g) || []).length, 3);
  assert.doesNotMatch(text, /!\[|assets\/|synthetic-test-only|estuary|Internal generation|Ordinary tool/);
  assert.match(text, /Search picture/);
  assert.ok(text.includes(publicImage));
});

test('missing search-thumbnail bytes do not erase the user and generated pictures or print nested image syntax', async () => {
  const h = harness(), doc = await h.hydrate(await h.read()); h.libraries();
  const result = await h.api.generateExport(h.plan(doc), { messages: exportMessages('en'), options: defaults,
    assetLoader: source => source === publicImage ? Promise.reject(Error('Synthetic image unavailable')) : h.assetLoader(source) });
  assert.equal(result.warnings.length, 1);
  assert.doesNotMatch(result.warnings.join('\n'), /\[!\[|turn20image0/);
  const pdf = await h.context.PDFLib.PDFDocument.load(result.bytes), { PDFName, PDFDict } = h.context.PDFLib;
  const images = pdf.getPages().flatMap(page => {
    const dictionary = page.node.Resources().lookup(PDFName.of('XObject'), PDFDict);
    return dictionary ? Array.from(dictionary.entries()).filter(([, ref]) => pdf.context.lookup(ref)?.dict?.get(PDFName.of('Subtype'))?.toString() === '/Image') : [];
  });
  assert.equal(images.length, 2);
});
