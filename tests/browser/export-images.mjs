import { createExportSelection } from '../../src/features/export/ui/export-selection.js';
import '../../src/platform/protocol.js';
import '../../src/platform/snapshot.js';
import '../../src/platform/ui/dom-ownership.js';
import '../../src/platform/chatgpt/binding.js';
import '../../src/platform/chatgpt/message-dom.js';
import '../../src/platform/chatgpt/native-snapshot-reader.js';
import '../../src/platform/chatgpt/snapshot-publisher.js';
import '../../src/platform/chatgpt/native-observer.js';
import '../../src/features/export/model/export.js';
import '../../src/features/export/model/export-preview.js';
import '../../src/features/export/chatgpt/export-preview-presentation.js';
import '../../src/features/export/engine/i18n.js';
import '../../src/features/export/engine/normalize.js';
import '../../src/features/export/engine/plan.js';
import '../../src/features/export/engine/inline-content.js';
import '../../src/features/export/engine/serializers.js';
import '../../src/features/export/engine/assets.js';
import '../../src/features/export/engine/pdf.js';
import { createTranslator } from '../../src/messages/i18n.js';
import { createExportView } from '../../src/features/export/ui/export-view.js';

// 隔离浏览器内用真实组件验收，不连接 ChatGPT，也不伪装成安装态验收。
const results = [], assert = (ok, message) => { if (!ok) throw new Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// 普通 release 运行不暂停；专用截图运行只在合成页的明确验收点等待截图回执。
const captureStates = new URL(location.href).searchParams.has('captureStates');
async function checkpoint(name) {
  if (!captureStates) return;
  document.querySelector('#results').style.display = 'none';
  await new Promise(resolve => {
    globalThis.fixtureCapture = { name, bounds: root.getBoundingClientRect().toJSON() };
    globalThis.completeFixtureCapture = () => { globalThis.fixtureCapture = null; resolve(); };
  });
}
async function waitFor(check, timeoutMs = 4000) { const deadline = performance.now() + timeoutMs; while (performance.now() < deadline) { if (check()) return; await sleep(50); } throw new Error('Timed out'); }
async function check(name, run) {
  document.querySelector('#results').textContent = JSON.stringify({ running: name, results });
  try { await run(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: e.message }); }
}
const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
const paint = canvas.getContext('2d'); paint.fillStyle = '#16766b'; paint.fillRect(0, 0, 320, 180);
paint.fillStyle = '#fff2b5'; paint.fillRect(24, 24, 92, 92); paint.fillStyle = '#ffffff'; paint.font = '20px sans-serif'; paint.fillText('TIDY image test', 24, 154);
const imageSrc = canvas.toDataURL('image/png');
const source = { schemaVersion: TidyExportContract.VERSION, warnings: [], conversation: { id: 'image-browser', title: '上传图片 · 图文导出验收',
  createdAt: '2026-09-17T00:00:00Z', updatedAt: '2026-09-17T00:00:00Z', sourceUrl: 'https://chatgpt.com/c/image-browser',
  resources: [{ id: 'image', type: 'image', name: '测试图片.png', mimeType: 'image/png', sizeBytes: null, src: imageSrc, alt: '本地合成图片' }],
  messages: [{ id: 'user-image', messageNumber: 1, role: 'user', timestamp: null, segments: [{ type: 'content', sourceMessageId: 'user-image', timestamp: null,
    blocks: [{ type: 'paragraph', text: '图片前面的说明。' }, { type: 'image', resourceId: 'image', alt: '本地合成图片' }, { type: 'paragraph', text: '图片后面的说明。' }] }] }],
} };
const receiver = globalThis.imagePreviewReceiver;
const root = document.querySelector('#export-view');
let payload, reads = 0, readGate = null, batchGate = null, imageReads = 0, releaseImage;
let pendingReads = 0, batchReads = 0, batchPending = false;
const pendingError = () => Object.assign(new Error('Synthetic response is not yet committed'), { code: 'EXPORT_RESPONSE_PENDING' });
const imageGate = new Promise(resolve => { releaseImage = resolve; });
const readyImage = structuredClone(source.conversation.resources[0]);
Object.assign(source.conversation.resources[0], { src: '', pending: true, readHandle: 'image-1-browser' });
const selection = createExportSelection({ noticeText: (key, values) => model.translator(key, values) });
const view = createExportView({ selection, root, requestDocument: async ({ expectedConversationId }) => {
  reads++;
  if (pendingReads > 0) { pendingReads--; throw pendingError(); }
  const document = structuredClone(source), gate = readGate; readGate = null;
  assert(document.conversation.id === expectedConversationId, 'Read followed the wrong conversation');
  if (gate) await gate;
  return document;
},
  requestResource: async ({ readHandle }) => {
    imageReads++;
    await imageGate;
    return { readHandle, resource: readyImage };
  },
  requestDocuments: async () => {
    batchReads++;
    if (batchPending) throw pendingError();
    const gate = batchGate; batchGate = null;
    if (gate) await gate;
    return { schemaVersion: TidyExportContract.COLLECTION_VERSION, documents: [structuredClone(source)] };
  },
  presentFullPreview: async value => {
    payload = value;
    let response; receiver(TidyProtocol.request(TidyProtocol.Type.EXPORT_PREVIEW_OPEN, value), {}, result => { response = result; });
    assert(response?.ok, 'Page overlay rejected image preview'); return response.payload;
  }, dismissFullPreview: async ({ sessionId }) => receiver(TidyProtocol.request(TidyProtocol.Type.EXPORT_PREVIEW_CLOSE, { sessionId }), {}, () => {}),
  formatTimestamp: value => value,
});
const field = value => ({ value, source: 'test', status: 'available' });
const model = { active: true, accountKey: 'local-image-test', translator: createTranslator('zh-CN'), preferences: {},
  snapshot: { route: { pathname: '/c/image-browser' }, conversation: { conversationId: 'image-browser', identityStatus: 'stable', bindingStatus: 'bound', title: field(source.conversation.title), createdAt: field(source.conversation.createdAt), updatedAt: field(source.conversation.updatedAt) }, messages: [] },
  favorites: { accountKey: 'local-image-test', revision: 1, items: {}, groups: [] }, bookmarks: { accountKey: 'local-image-test', revision: 1, items: {}, groups: [] },
};
view.updateContext(model);
root.querySelector('[data-export-format="pdf"]').click();
root.querySelector('[data-export-settings-view="shared"]').click();
const mediaOptIn = root.querySelector('[data-export-toggle="mediaAttachments"]');
assert(!mediaOptIn.checked, 'Media default changed from opt-in');
mediaOptIn.checked = true; mediaOptIn.dispatchEvent(new Event('change', { bubbles: true }));
root.querySelector('[data-export-settings-back]').click();
await check('text appears before deferred images, with export gated until the image is ready', async () => {
  await waitFor(() => imageReads === 1 && root.textContent.includes('图片前面的说明'));
  assert(root.querySelector('[data-export-action]').disabled, 'Pending media allowed an incomplete export');
  assert(root.textContent.includes('正在准备图片'), 'Image work has no progress explanation');
  assert(root.querySelector('[data-export-full-preview]').disabled, 'Full preview opened a half-prepared file');
  releaseImage();
  await waitFor(() => !root.querySelector('[data-export-action]').disabled);
  assert(reads === 1 && imageReads === 1, 'Image completion reread text or duplicated its address request');
  // 后续切会话夹具使用已经可用的合成资源，单独验证自动刷新行为。
  source.conversation.resources[0] = readyImage;
});
await check('panel preview contains the loaded image in message order', async () => {
  await waitFor(() => root.querySelector('[data-export-format="pdf"]'));
  root.querySelector('[data-export-format="pdf"]').click();
  await waitFor(() => root.querySelector('[data-export-preview-image]')?.naturalWidth === 320);
  const doc = root.querySelector('.export-preview__document');
  assert(doc.children[0].textContent.includes('图片前面') && doc.children[2].textContent.includes('图片后面'), 'Image order changed');
  assert(doc.scrollWidth <= doc.clientWidth + 1, 'Preview overflows sidebar');
});
await check('media switch removes and restores preview images without another backend read', async () => {
  root.querySelector('[data-export-settings-view="shared"]').click();
  const toggle = root.querySelector('[data-export-toggle="mediaAttachments"]');
  toggle.checked = false; toggle.dispatchEvent(new Event('change', { bubbles: true }));
  root.querySelector('[data-export-settings-back]').click(); assert(!root.querySelector('[data-export-preview-image]'), 'Unchecked image still visible');
  root.querySelector('[data-export-settings-view="shared"]').click();
  const restored = root.querySelector('[data-export-toggle="mediaAttachments"]');
  restored.checked = true; restored.dispatchEvent(new Event('change', { bubbles: true }));
  root.querySelector('[data-export-settings-back]').click(); await waitFor(() => root.querySelector('[data-export-preview-image]')?.naturalWidth === 320);
  assert(reads === 1, 'Option changes reread the conversation');
});
await check('failed preview image displays a readable retry caption', async () => {
  const target = document.querySelector('#image-error-fixture');
  TidyExportPreview.append(target, [{ type: 'image', src: 'data:image/png;base64,bm90YW5pbWFnZQ==', alt: '<img onerror=bad>', failureText: '图片读取失败，请刷新内容后重试' }]);
  await waitFor(() => target.querySelector('img').hidden);
  assert(target.querySelector('figcaption').textContent.includes('请刷新内容'), 'Missing failure caption'); target.hidden = true;
});
await check('browser converts WebP/GIF first frames to PNG and keeps JPEG/PNG bytes', async () => {
  for (const mime of ['image/webp', 'image/jpeg', 'image/png']) {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, mime));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const output = await TidyExport.preparePdfImage(bytes);
    if (mime !== 'image/webp') assert(output.bytes === bytes, 'Unnecessary image recompression');
    const image = await createImageBitmap(new Blob([output.bytes], { type: output.format === 'jpeg' ? 'image/jpeg' : 'image/png' }));
    assert(image.width === 320 && image.height === 180, 'Converted dimensions changed'); image.close();
  }
  const gif = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0));
  const output = await TidyExport.preparePdfImage(gif);
  assert(output.format === 'png' && output.bytes[0] === 0x89, 'GIF was not converted');
});
await check('full page preview renders the same image and labels its pagination limitation', async () => {
  root.querySelector('[data-export-full-preview]').click();
  await waitFor(() => document.querySelector('#tidy-export-preview-host')?.shadowRoot.querySelector('img')?.naturalWidth === 320);
  assert(payload.previewParts.filter(p => p.type === 'image').length === 1, 'Full preview lost image');
  assert(payload.summary.includes('分页以下载的 PDF 为准'), 'Preview masquerades as exact pagination');
});
await check('repeated conversation switches auto-update after staggered hydration, without a refresh click', async () => {
  for (const id of ['second-chat', 'third-chat']) {
    const before = reads;
    let release;
    readGate = new Promise(resolve => { release = resolve; });
    source.conversation.id = id; source.conversation.sourceUrl = `https://chatgpt.com/c/${id}`;
    source.conversation.title = `自动更新 ${id}`;
    model.snapshot = { route: { pathname: `/c/${id}` }, adapter: { responseInProgress: false },
      conversation: { conversationId: id, identityStatus: 'stable', bindingStatus: 'bound',
        title: field(''), createdAt: field(null), updatedAt: field(null) }, messages: [] };
    view.updateContext(model);
    model.snapshot.conversation.title = field(source.conversation.title);
    model.snapshot.conversation.createdAt = field(source.conversation.createdAt);
    model.snapshot.messages = [{ messageId: 'user-image', excerpt: field('图片前面的说明。') }];
    view.updateContext(model);
    assert(root.textContent.includes('预览会自动更新'), 'Hydration still asks for manual recovery');
    assert(!root.textContent.includes('请刷新后导出'), 'Manual stale notice flashed on navigation');
    const refresh = root.querySelector('[data-export-refresh]');
    assert(refresh.disabled && refresh.textContent === '更新中…', 'Refresh looks like a required next step');
    release();
    await waitFor(() => !root.querySelector('[data-export-full-preview]').disabled);
    await waitFor(() => root.querySelector('[data-export-preview-image]')?.naturalWidth === 320);
    assert(reads === before + 2, 'Hydration did not coalesce into one follow-up read');
    assert(root.textContent.includes(`自动更新 ${id}`), 'Wrong conversation after switch');
  }
});
await check('a native streaming signal waits, then automatically updates the real browser preview', async () => {
  const before = reads;
  model.snapshot.adapter.responseInProgress = true; view.updateContext(model);
  assert(root.textContent.includes('ChatGPT 正在回复'), 'No understandable waiting state');
  await sleep(800);
  assert(reads === before, 'Silence was mistaken for a completed reply');
  model.snapshot.adapter.responseInProgress = false; view.updateContext(model);
  await waitFor(() => !root.querySelector('[data-export-full-preview]').disabled);
  assert(reads === before + 1, 'Completion did not refresh unchanged excerpts');
});
await check('native observer and production publisher deliver busy during continuous DOM changes, then refresh the complete reply', async () => {
  const before = reads, previousSnapshot = model.snapshot;
  const host = document.createElement('div');
  host.dataset.messageId = 'synthetic-native-answer';
  host.dataset.messageAuthorRole = 'assistant';
  host.hidden = true; host.textContent = '原生合成回复';
  const record = { id: host.dataset.messageId, conversation_id: source.conversation.id,
    author: { role: 'assistant' }, create_time: 1790812800, status: 'finished_successfully',
    content: { content_type: 'text', parts: ['同一个摘要'] } };
  host.__reactFiber$exportFixture = { memoizedProps: { message: record }, return: null };
  document.body.append(host);
  const reader = TidyChatgptNativeSnapshotReader.create({ readMessageNumbers: () => ({
    conversationId: source.conversation.id, numbers: { [record.id]: 2 },
  }) });
  // 只替代外部身份检查；原生观察、消息读取、publisher 指纹/计时与导出 view 均是生产代码。
  const previousApi = globalThis.TidyChatgptApi;
  globalThis.TidyChatgptApi = { checkLibraryIdentity() {} };
  let observer, publisher, pulse, firstBusyAt = null, mutations = 0, busyStartedAt = 0;
  const events = [];
  const readSnapshot = () => {
    const activity = { responseInProgress: false };
    const messages = reader.readMessages({ conversationId: source.conversation.id, bindingStatus: 'bound' }, [], activity);
    return { ...previousSnapshot, appearance: { colorScheme: 'light', surface: field(null) },
      sidebarConversations: [], messages, adapter: { retryable: false, ...activity } };
  };
  try {
    publisher = TidyChatgptSnapshotPublisher.create({ readSnapshot, postEnvelope: envelope => {
      assert(envelope.type === TidyProtocol.Type.SNAPSHOT_UPDATED, 'Publisher did not emit a production snapshot event');
      events.push({ reason: envelope.payload.reason, busy: envelope.payload.snapshot.adapter.responseInProgress, at: performance.now() });
      if (envelope.payload.snapshot.adapter.responseInProgress && firstBusyAt === null) firstBusyAt = performance.now();
      model.snapshot = envelope.payload.snapshot;
      view.updateContext(model);
    } });
    observer = TidyChatgptNativeObserver.create({ onRefresh: publisher.schedule,
      onRoute() {}, onHidden() {}, onMessage() {} });
    await waitFor(() => events.length && !root.querySelector('[data-export-action]').disabled);
    const readsBeforeBusy = reads;
    record.status = 'in_progress'; busyStartedAt = performance.now();
    host.textContent = '原生合成回复 0';
    pulse = setInterval(() => { mutations++; host.textContent = '原生合成回复 ' + mutations; }, 40);
    await waitFor(() => firstBusyAt !== null);
    assert(firstBusyAt - busyStartedAt <= 650, 'Continuous DOM changes postponed busy notification beyond its bounded window');
    assert(root.querySelector('[data-export-action]').disabled, 'Live native generation left export enabled');
    assert(root.querySelector('[data-export-full-preview]').disabled, 'Live native generation allowed an incomplete full preview');
    assert(root.textContent.includes('ChatGPT 正在回复'), 'Native activity has no waiting explanation');
    await checkpoint('native-generating');
    await sleep(Math.max(0, 1600 - (performance.now() - busyStartedAt)));
    assert(mutations >= 20, 'The fixture did not sustain continuous DOM changes');
    assert(reads === readsBeforeBusy, 'Streaming activity read a partial document');
    // 只改完整源正文，不改摘要：完成事件本身必须让旧预览失效。
    source.conversation.messages.push({ id: record.id, messageNumber: 2, role: 'assistant', timestamp: null,
      segments: [{ type: 'content', sourceMessageId: record.id, timestamp: null,
        blocks: [{ type: 'paragraph', text: '生成完成后的完整答案。' }] }] });
    clearInterval(pulse); pulse = null;
    record.status = 'finished_successfully'; host.textContent = '完整回复已结束';
    await waitFor(() => events.at(-1)?.busy === false && !root.querySelector('[data-export-action]').disabled);
    assert(reads === readsBeforeBusy + 1, 'Completion did not coalesce into one full-document read');
    assert(root.textContent.includes('生成完成后的完整答案'), 'Automatic preview kept the pre-generation document');
    await checkpoint('native-complete');
    globalThis.streamingFixtureEvidence = { notificationDelayMs: Math.round(firstBusyAt - busyStartedAt),
      mutationCount: mutations, eventCount: events.length, readsBefore: before, readsAfter: reads };
  } finally {
    clearInterval(pulse); observer?.dispose(); publisher?.dispose(); reader.dispose();
    host.remove(); globalThis.TidyChatgptApi = previousApi;
  }
});
await check('an API-only pending response stays gated and recovers within the bounded read window', async () => {
  const before = reads;
  pendingReads = 2;
  root.querySelector('[data-export-refresh]').click();
  await waitFor(() => reads === before + 1 && root.textContent.includes('正在同步最新会话'));
  assert(model.snapshot.adapter.responseInProgress === false, 'API fallback test accidentally depended on native busy');
  assert(root.querySelector('[data-export-action]').disabled, 'Pending API document became exportable');
  assert(root.querySelector('[data-export-full-preview]').disabled, 'Pending API document opened a partial preview');
  await waitFor(() => reads === before + 3 && !root.querySelector('[data-export-action]').disabled);
  assert(!root.textContent.includes('内容未读全，请重读'), 'Transient API pending became a permanent failure');
});
await check('persistent API pending stops after three retries and needs an explicit recovery click', async () => {
  const before = reads;
  pendingReads = 20;
  root.querySelector('[data-export-refresh]').click();
  await waitFor(() => Boolean(root.querySelector('[data-export-retry]')), 6000);
  assert(reads === before + 4, 'Pending API retries were not limited to three follow-up reads');
  assert(root.textContent.includes('内容未读全，请重读'), 'Exhausted pending response has no readable recovery state');
  assert(root.querySelector('[data-export-action]').disabled, 'Exhausted pending response exported a partial document');
  await sleep(800);
  assert(reads === before + 4, 'Exhausted pending response kept polling in the background');
  pendingReads = 0;
  root.querySelector('[data-export-retry]').click();
  await waitFor(() => !root.querySelector('[data-export-action]').disabled);
  assert(reads === before + 5, 'Manual recovery did not perform exactly one fresh read');
});
await check('all four formats use the neutral Simplified Chinese media label without changing the opt-in state', async () => {
  const before = reads, initialWidth = root.style.width, initialHeight = root.style.height;
  try {
    root.style.width = '320px'; root.style.height = '650px';
    for (const format of ['markdown', 'json', 'txt', 'pdf']) {
      root.querySelector('[data-export-format="' + format + '"]').click();
      root.querySelector('[data-export-settings-view="shared"]').click();
      const toggle = root.querySelector('[data-export-toggle="mediaAttachments"]');
      const label = toggle.closest('label');
      assert(label?.textContent.includes('图片与附件'), format + ': media label is not neutral Simplified Chinese');
      assert(!label.textContent.includes('下载') && !label.textContent.includes('連結'), format + ': old format-specific action label remains');
      assert(toggle.checked, format + ': switching format changed the opt-in choice');
      assert(root.scrollWidth <= root.clientWidth + 1, format + ': 320px media settings overflow');
      if (format === 'pdf') await checkpoint('media-label-320px');
      root.querySelector('[data-export-settings-back]').click();
    }
    assert(reads === before, 'Media wording check or format switch reread the backend');
  } finally {
    root.style.width = initialWidth; root.style.height = initialHeight;
    root.querySelector('[data-export-settings-back]')?.click();
  }
});
await check('current and batch previews keep equal geometry across formats, loading and compact panels', async () => {
  const originalHeight = root.style.height, originalWidth = root.style.width;
  const assertFrame = () => {
    const block = root.querySelector('.export-preview-block'), clip = root.querySelector('.export-preview__clip');
    assert(clip?.getBoundingClientRect().height === 224, 'Preview height differs from the shared 224px');
    assert(getComputedStyle(block).borderBottomWidth === '0px', 'Preview still adds its own bottom divider');
    assert(getComputedStyle(block).marginBottom === '0px', 'Preview retains the old divider gap');
    assert(getComputedStyle(root.querySelector('.export-action-bar')).borderTopWidth === '1px', 'Action divider was removed');
    assert(root.scrollWidth <= root.clientWidth + 1, 'Preview widens the sidebar');
  };
  let releaseBatch;
  try {
    model.favorites.items = { [source.conversation.id]: { conversationId: source.conversation.id, title: source.conversation.title } };
    model.favorites.revision++; view.updateContext(model);
    selection.beginSelection('favorites', 'export'); selection.toggleSelection('favorites', source.conversation.id);
    batchGate = new Promise(resolve => { releaseBatch = resolve; });
    selection.submitSelection('favorites'); view.setMode('batch'); view.updateContext(model);
    await waitFor(() => root.textContent.includes('正在读取所选会话'));
    assertFrame(); // 加载态不再用更矮的批量预览。
    releaseBatch();
    await waitFor(() => !root.querySelector('[data-export-full-preview]').disabled);
    for (const width of [320, 420]) {
      root.style.width = `${width}px`;
      for (const height of [400, 650, 860]) {
        root.style.height = `${height}px`;
        for (const mode of ['current', 'batch']) {
          view.setMode(mode); view.updateContext(model);
          for (const format of ['markdown', 'json', 'txt', 'pdf']) {
            root.querySelector(`[data-export-format="${format}"]`).click();
            assertFrame();
            const scroller = root.querySelector('[data-export-scroll]');
            scroller.scrollTop = scroller.scrollHeight;
            const open = root.querySelector('[data-export-full-preview]').getBoundingClientRect(), viewport = scroller.getBoundingClientRect();
            assert(open.top >= viewport.top - 1 && open.bottom <= viewport.bottom + 1, `${mode}/${height}/${format}: full preview entry is unreachable`);
            scroller.scrollTop = 0;
          }
        }
      }
    }
  } finally {
    releaseBatch?.(); batchGate = null;
    root.style.height = originalHeight; root.style.width = originalWidth;
    view.setMode('current'); view.updateContext(model);
    root.querySelector('[data-export-format="pdf"]')?.click();
  }
});
await check('batch API pending fails atomically without automatic polling and recovers only on request', async () => {
  const before = batchReads;
  batchPending = true;
  view.setMode('batch'); view.updateContext(model);
  root.querySelector('[data-export-refresh]').click();
  await waitFor(() => Boolean(root.querySelector('[data-export-batch-retry]')));
  assert(root.querySelector('[data-export-action]').disabled, 'Batch pending exported an incomplete selection');
  assert(root.querySelector('[data-export-full-preview]').disabled, 'Batch pending opened an incomplete preview');
  await sleep(700);
  assert(batchReads === before + 1, 'Batch pending automatically polled or partially retried');
  batchPending = false;
  root.querySelector('[data-export-batch-retry]').click();
  await waitFor(() => !root.querySelector('[data-export-action]').disabled);
  assert(batchReads === before + 2, 'Batch explicit recovery did not perform exactly one complete read');
  view.setMode('current'); view.updateContext(model);
});
const output = document.querySelector('#results'); output.textContent = JSON.stringify({ ok: results.every(r => r.ok), results, streaming: globalThis.streamingFixtureEvidence }, null, 2); output.dataset.complete = 'true';
