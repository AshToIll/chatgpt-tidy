const assert = require('node:assert/strict');
const { installPageSession } = require('./helpers/page-session.cjs');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { exportMessages } = require('./helpers/export-i18n.cjs');
const root = path.resolve(__dirname, '..');
// 全部使用合成标识和随包图标，测试不包含真实账号、签名地址或用户上传图片。
const fileId = 'file_' + 'a'.repeat(32);
const signedUrl = `https://chatgpt.com/backend-api/estuary/content?id=${fileId}&sig=synthetic-test-only`;
const pointer = { content_type: 'image_asset_pointer', asset_pointer: `sediment://${fileId}` };
const png = new Uint8Array(fs.readFileSync(path.join(root, 'src/assets/icons/tidy-outlined-32.png')));
function load(context, file) { vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file }); }
function adapter({ parts = ['Before image', pointer, 'After image'], response, afterImage, gizmoId } = {}) {
  const calls = [], location = { href: 'https://chatgpt.com/c/test-images', origin: 'https://chatgpt.com' }, document = { cookie: '' };
  const payload = id => ({ id, gizmo_id: gizmoId, title: 'Uploaded image regression', current_node: 'u', mapping: {
    u: { id: 'u', parent: null, message: { id: 'user-image', author: { role: 'user' }, create_time: 1700000000,
      content: { content_type: 'multimodal_text', parts } } },
  } });
  const context = vm.createContext({ URL, Headers, location, document, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/auth/session') return { ok: true, json: async () => ({ accessToken: 'test-token', user: { id: 'test-user' } }) };
      if (url.startsWith('/backend-api/conversation/')) return { ok: true, json: async () => payload(url.split('/').pop()) };
      assert.equal(url, `/backend-api/files/download/${fileId}?inline=false&download_intent=false${gizmoId ? '&gizmo_id=' + gizmoId : ''}`);
      afterImage?.({ document, location });
      return response || { ok: true, json: async () => ({ download_url: signedUrl, mime_type: 'image/png', file_name: 'uploaded.png', file_size_bytes: png.length }) };
    },
  });
  installPageSession(context);
  for (const file of ['src/platform/snapshot.js', 'src/features/export/model/export.js', 'src/platform/chatgpt/route.js', 'src/platform/chatgpt/api.js', 'src/platform/chatgpt/active-branch.js', 'src/platform/chatgpt/native-message-references.js', 'src/platform/chatgpt/native-message-content.js',
    'src/platform/chatgpt/native-message-process.js', 'src/platform/chatgpt/conversation-projection.js', 'src/features/export/chatgpt/export.js']) load(context, file);
  const readText = () => context.TidyChatgptExport.readCurrentConversation({ expectedConversationId: 'test-images' });
  const hydrate = async doc => {
    for (const r of doc.conversation.resources) if (r.pending) {
      const result = await context.TidyChatgptExport.readImageResource({ readHandle: r.readHandle });
      Object.assign(r, result.resource); delete r.readHandle;
      if (!r.src && !doc.warnings.includes('IMAGE_UNAVAILABLE')) doc.warnings.push('IMAGE_UNAVAILABLE');
    }
    return doc;
  };
  return { context, calls, payload: payload('test-images'), readText, hydrate, read: async () => hydrate(await readText()) };
}
function runtime() {
  const context = vm.createContext({ URL, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, setTimeout, clearTimeout, setImmediate });
  for (const file of ['src/features/export/model/export-preview.js', 'src/features/export/engine/i18n.js', 'src/features/export/engine/normalize.js', 'src/features/export/engine/plan.js', 'src/features/export/engine/inline-content.js', 'src/features/export/engine/serializers.js']) load(context, file);
  return context;
}
function plan(context, document, format = 'pdf', mediaAttachments = true) {
  return context.TidyExport.buildExportPlan({ messages: exportMessages(), mode: 'current', format, currentConversationId: document.conversation.id,
    options: { mediaAttachments }, data: context.TidyExport.normalizeExportData({ conversations: [document.conversation], bookmarks: [] }) });
}

test('uploaded pointers resolve authenticated addresses and preserve ordered blocks; repeated images reuse the lookup', async () => {
  const h = adapter({ parts: ['Before', pointer, 'Between', pointer, 'After'] }), doc = await h.read();
  assert.deepEqual(Array.from(doc.warnings), []);
  assert.equal(h.context.TidyExportContract.validateDocument(doc).valid, true);
  assert.deepEqual(Array.from(doc.conversation.messages[0].segments[0].blocks, b => b.type), ['paragraph', 'image', 'paragraph', 'image', 'paragraph']);
  for (const resource of doc.conversation.resources) {
    assert.equal(resource.src, signedUrl); assert.equal(resource.temporaryUrl, true); assert.equal(resource.mimeType, 'image/png');
  }
  const requests = h.calls.filter(c => c.url.includes('/files/download/'));
  assert.equal(requests.length, 1); assert.equal(requests[0].options.headers.get('Authorization'), 'Bearer test-token');
  assert.ok(h.calls.every(c => !c.url.startsWith('http')), 'MAIN resolves metadata only, never fetches image bytes');
});

test('text-only phase never looks up uploaded images and exports no raw file locator', async () => {
  const h = adapter(), doc = await h.readText();
  assert.equal(h.calls.filter(c => c.url.includes('/files/download/')).length, 0);
  assert.equal(doc.conversation.resources[0].pending, true);
  assert.ok(doc.conversation.resources[0].readHandle);
  assert.doesNotMatch(JSON.stringify(doc), /sediment|file_[a-f0-9]{32}|test-token/);
  const c = runtime(), p = plan(c, doc, 'markdown', false);
  assert.equal(c.TidyExport.selectedImageResources(p).length, 0);
});

test('repeated image handles share one in-flight lookup without changing the source body', async () => {
  const h = adapter({ parts: [pointer, pointer] }), doc = await h.readText();
  const results = await Promise.all(doc.conversation.resources.map(r => h.context.TidyChatgptExport.readImageResource({ readHandle: r.readHandle })));
  assert.equal(h.calls.filter(c => c.url.includes('/files/download/')).length, 1);
  assert.ok(results.every(r => r.resource.src === signedUrl && !r.resource.pending));
  assert.ok(doc.conversation.resources.every(r => r.pending), 'Adapter does not mutate already-published source snapshots');
});

test('unregistered image handles fail before any authenticated fetch', async () => {
  const h = adapter();
  await assert.rejects(h.context.TidyChatgptExport.readImageResource({ readHandle: 'image-1-unknown' }), /expired/);
  assert.equal(h.calls.length, 0);
});

test('batch image resolution uses the same authenticated path; numbering remains synchronous without network', async () => {
  const h = adapter();
  assert.equal(h.context.TidyChatgptConversationProjection.messageNumbersFromPayload(h.payload, 'test-images')['user-image'], 1);
  assert.equal(h.calls.length, 0);
  const result = await h.context.TidyChatgptExport.readConversations({ conversationIds: ['first', 'second'] });
  assert.equal(h.calls.filter(c => c.url.includes('/files/download/')).length, 0, 'Batch body never waits for image lookups');
  await Promise.all(result.documents.map(h.hydrate));
  assert.deepEqual(Array.from(result.documents, d => d.conversation.resources[0].src), [signedUrl, signedUrl]);
});

test('project image lookup carries the source conversation context rather than the active page project', async () => {
  const h = adapter({ gizmoId: 'g-p-' + 'b'.repeat(32) }), doc = await h.read();
  assert.equal(doc.warnings.length, 0);
  assert.ok(h.calls.at(-1).url.includes('gizmo_id=g-p-'));
});

test('bad or expired image metadata keeps the text with an explicit warning, never arbitrary fetches', async () => {
  const failures = [
    { ok: false, status: 403 }, { ok: true, json: async () => { throw new Error('bad json'); } },
    ...['https://example.com/image.png', signedUrl.replace(fileId, 'file_' + 'b'.repeat(32)), 'javascript:alert(1)'].map(download_url => ({ ok: true, json: async () => ({ download_url }) })),
  ];
  for (const response of failures) {
    const h = adapter({ response }), doc = await h.read();
    assert.deepEqual(Array.from(doc.warnings), ['IMAGE_UNAVAILABLE']);
    assert.equal(doc.conversation.resources[0].src, '');
    assert.equal(doc.conversation.messages[0].segments[0].blocks.at(-1).text, 'After image');
  }
  const unsupported = adapter({ parts: [{ ...pointer, asset_pointer: 'sediment://../../private' }] });
  assert.deepEqual(Array.from((await unsupported.read()).warnings), ['IMAGE_UNAVAILABLE']);
  assert.equal(unsupported.calls.length, 2);
});

test('route/workspace changes during image lookup abort rather than publishing stale resources', async () => {
  for (const afterImage of [({ location }) => { location.href = 'https://chatgpt.com/c/other'; }, ({ document }) => { document.cookie = '_account=another-workspace'; }]) {
    await assert.rejects(adapter({ afterImage }).read(), /owner changed/);
  }
});

test('PDF preview shows ordered images, respects the media switch and safely escapes content', async () => {
  const context = runtime(), doc = await adapter().read(), api = context.TidyExport;
  const parts = api.serializePreviewParts(plan(context, doc).files[0], { messages: exportMessages() });
  assert.deepEqual(Array.from(parts, p => p.type), ['text', 'image', 'text']);
  assert.match(parts[0].text, /Before image/); assert.match(parts[2].text, /After image/);
  assert.equal(context.TidyExportPreview.valid(parts), true);
  const hidden = api.serializePreviewParts(plan(context, doc, 'pdf', false).files[0], { messages: exportMessages() });
  assert.equal(hidden.some(p => p.type === 'image'), false);
  const malicious = [{ type: 'text', text: '<script>alert(1)</script>' }, { ...parts[1], alt: '"><script>bad</script>' }];
  const html = context.TidyExportPreview.markup(malicious);
  assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/);
  assert.equal(context.TidyExportPreview.valid([{ ...parts[1], src: 'javascript:alert(1)' }]), false);
  assert.equal(context.TidyExportPreview.valid([{ ...parts[1], src: 'https://user:pass@example.com/image' }]), false);
});

test('resolved upload embeds in PDF but Markdown is text only; temporary signatures never leave in file links', async () => {
  const context = runtime(), doc = await adapter().read(), api = context.TidyExport;
  for (const file of ['src/vendor/pdf-lib-1.17.1.min.js', 'src/vendor/regenerator-runtime-0.14.1.js', 'src/vendor/fontkit-1.1.1.min.js', 'src/vendor/jszip-3.10.1.min.js',
    'src/features/export/engine/dependencies.js', 'src/features/export/engine/assets.js', 'src/features/export/engine/pdf.js', 'src/features/export/engine/download.js']) load(context, file);
  const assetLoader = async source => {
    if (source === signedUrl) return png;
    assert.ok(source.startsWith('./vendor/fonts/'));
    return new Uint8Array(fs.readFileSync(path.join(root, 'src/assets/fonts', source.slice('./vendor/fonts/'.length))));
  };
  const settings = { messages: exportMessages(), assetLoader, pdf: { pageSize: 'A4', orientation: 'portrait', fontSize: 'standard' } };
  const output = await api.generateExport(plan(context, doc), settings);
  assert.deepEqual(Array.from(output.warnings), []);
  const pdf = await context.PDFLib.PDFDocument.load(output.bytes);
  const imageObjects = pdf.context.enumerateIndirectObjects().filter(([, obj]) => obj.dict?.get(context.PDFLib.PDFName.of('Subtype'))?.toString() === '/Image');
  assert.ok(imageObjects.length > 0, 'embedded image streams, not just an external link or alt text');
  assert.doesNotMatch(Buffer.from(output.bytes).toString('latin1'), /synthetic-test-only|estuary/);
  let markdownReads = 0;
  const md = await api.generateExport(plan(context, doc, 'markdown'), { ...settings, assetLoader: async () => {
    markdownReads++; throw new Error('Markdown must not load media');
  } });
  const text = Buffer.from(md.bytes).toString('utf8');
  assert.equal(plan(context, doc, 'markdown').zipped, false);
  assert.equal(markdownReads, 0);
  assert.equal(md.warnings.length, 0);
  assert.match(text, /Before image[\s\S]*After image/);
  assert.match(text, /图片|uploaded/);
  assert.doesNotMatch(text, /synthetic-test-only|estuary|!\[|assets\//);
  const json = api.serializeTextFile(plan(context, doc, 'json').files[0], 'json', settings);
  assert.doesNotMatch(json, /synthetic-test-only|estuary|temporaryUrl/);

});
