import { createExportSelection } from '../../src/features/export/ui/export-selection.js';
import '../../src/platform/protocol.js';
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
import { runDisclosureChecks } from './export-disclosures.mjs';

const results = [], assert = (ok, message) => { if (!ok) throw new Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check) { for (let i = 0; i < 60; i++) { if (check()) return; await sleep(25); } throw new Error('Timed out'); }
async function check(name, run) {
  document.querySelector('#results').textContent = JSON.stringify({ running: name, results });
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: error.message }); }
}
let sequence = 0, inputDone;
globalThis.completeFixtureInput = id => {
  if (globalThis.fixtureInputRequest?.id !== id) throw new Error('Input receipt mismatch');
  globalThis.fixtureInputRequest = null; inputDone();
};
const input = request => new Promise(resolve => { inputDone = resolve; globalThis.fixtureInputRequest = { id: ++sequence, ...request }; });
const key = (key, code, vk, modifiers = 0) => input({ kind: 'key', key, code, vk, modifiers });
const tab = (shift = false) => key('Tab', 'Tab', 9, shift ? 8 : 0);
const space = () => key(' ', 'Space', 32);
const escape = () => key('Escape', 'Escape', 27);
const text = value => input({ kind: 'text', text: value });
// 由隔离浏览器驱动真实 IME 合成，不能用合成 DOM 事件假装候选输入。
const composition = value => input({ kind: 'composition', text: value, selectionStart: value.length, selectionEnd: value.length });
const clickAt = (x, y) => input({ kind: 'pointer', steps: [
  { type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
  { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
] });
const root = document.querySelector('#export-view'), $ = selector => root.querySelector(selector);
const focused = node => document.activeElement === node;
const field = value => ({ value, source: 'test', status: 'available' });
const source = { schemaVersion: TidyExportContract.VERSION, warnings: [], conversation: {
  id: 'keyboard-test', title: '导出键盘测试', createdAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:00:00Z',
  sourceUrl: 'https://chatgpt.com/c/keyboard-test', resources: [], messages: [
    { id: 'message-1', messageNumber: 1, role: 'user', timestamp: null, segments: [
      { type: 'content', sourceMessageId: 'message-1', timestamp: null, blocks: [{ type: 'paragraph', text: '测试正文。\n'.repeat(150) }] },
    ] },
  ],
} };
let job = null, reads = 0, currentPayload;
const closed = [];
function send(type, payload) {
  let response; globalThis.previewReceiver(TidyProtocol.request(type, payload), {}, value => { response = value; });
  assert(response?.ok, 'Preview request rejected: ' + JSON.stringify(response?.error)); return response.payload;
}
const selection = createExportSelection({ noticeText: (key, values) => model.translator(key, values) });
const view = createExportView({ selection, root,
  requestDocument: async () => { reads++; return structuredClone(source); },
  requestDocuments: async ({ conversationIds }) => ({ schemaVersion: TidyExportContract.COLLECTION_VERSION, documents: conversationIds.map(id => {
    const copy = structuredClone(source); copy.conversation.id = id; copy.conversation.sourceUrl = `https://chatgpt.com/c/${id}`; return copy;
  }) }),
  presentFullPreview: async payload => { currentPayload = payload; return send(TidyProtocol.Type.EXPORT_PREVIEW_OPEN, payload); },
  dismissFullPreview: async payload => send(TidyProtocol.Type.EXPORT_PREVIEW_CLOSE, payload),
  jobRequest: async () => job,
  formatTimestamp: value => value,
});
let frameView = null;
globalThis.previewClosed = envelope => {
  closed.push(envelope.payload.sessionId); view.handleFullPreviewClosed(envelope.payload.sessionId);
  frameView?.handleFullPreviewClosed(envelope.payload.sessionId);
};
const model = { active: true, accountKey: 'keyboard-account', translator: createTranslator('zh-CN'), preferences: {},
  snapshot: { route: { pathname: '/c/keyboard-test' }, conversation: { conversationId: source.conversation.id, identityStatus: 'stable', bindingStatus: 'bound',
    title: field(source.conversation.title), createdAt: field(source.conversation.createdAt), updatedAt: field(source.conversation.updatedAt) }, messages: [] },
  favorites: { accountKey: 'keyboard-account', revision: 1, items: {
    'keyboard-test': { conversationId: 'keyboard-test', title: source.conversation.title },
    'keyboard-second': { conversationId: 'keyboard-second', title: 'Second' },
  }, groups: [] },
  bookmarks: { accountKey: 'keyboard-account', revision: 1, items: {}, groups: [] },
};
view.updateContext(model);
const previewReady = () => $('[data-export-full-preview]')?.disabled === false;
await waitFor(previewReady);

await check('filename editing keeps the node, caret and draft through preview and job updates', async () => {
  const name = $('[data-export-filename]'); name.focus(); name.setSelectionRange(2, 2);
  await text('AB');
  assert(focused(name) && name.isConnected && name.selectionStart === 4, 'Filename caret or node lost');
  const draft = name.value;
  job = { id: 'keyboard-job', state: 'generating', revision: 1, outputName: 'example.md', progress: { phase: 'files', done: 1, total: 2 } };
  await view.refreshJob(); view.updateContext(model);
  assert(focused(name) && name.value === draft && name.selectionStart === 4, 'Background update rewrote the draft');
  job = null; await view.refreshJob();
});
await check('Space toggles repeatedly without losing focus; Tab reaches the next setting', async () => {
  const opener = $('[data-export-settings-target="content"]'); opener.focus(); await space();
  assert(focused($('[data-export-settings-back]')), 'Settings have no initial focus');
  const toggle = $('[data-export-toggle="timestamps"]'); toggle.focus();
  await space(); assert(focused(toggle) && !toggle.checked && toggle.isConnected, 'First Space lost switch focus');
  await space(); assert(focused(toggle) && toggle.checked, 'Second Space did not restore switch');
  await tab(); assert(focused($('[data-export-toggle="messageNumbers"]')), 'Tab skipped next option');
});
await check('native select retains focus and selection through change and background refresh', async () => {
  const select = $('[data-export-secondary-format]'); select.focus();
  await key('ArrowDown', 'ArrowDown', 40); await key('Enter', 'Enter', 13);
  assert(focused(select) && select.isConnected && select.value === 'json', 'Native format select lost focus or value');
  view.updateContext(model); assert(focused(select) && select.value === 'json', 'Refresh reset the select');
});
await check('role editing and secondary scroll survive updates; Escape returns to its entry', async () => {
  const role = $('[data-export-role="user"]'); role.focus(); role.setSelectionRange(0, 0); await text('Reader');
  const caret = role.selectionStart, scroller = $('.export-secondary-scroll'); scroller.scrollTop = 50;
  const top = scroller.scrollTop;
  view.updateContext(model);
  assert(focused(role) && role.selectionStart === caret && role.value.includes('Reader'), 'Role edit lost caret');
  assert(scroller.scrollTop === top, 'Refresh jumped back to the settings anchor');
  await escape(); assert(focused($('[data-export-settings-target="content"]')), 'Escape failed to restore settings entry');
});

for (const [roleKey, defaultName] of [['user', 'User'], ['assistant', 'Assistant']]) {
  await check(roleKey + ' name can be cleared, refreshed, blurred and retyped with native keyboard input', async () => {
    $('[data-export-settings-target="roles"]')?.click();
    const role = $('[data-export-role="' + roleKey + '"]');
    role.focus(); await key('a', 'KeyA', 65, 2); await text(defaultName + ' draft');
    await key('a', 'KeyA', 65, 2); await key('Backspace', 'Backspace', 8);
    assert(focused(role) && role.value === '' && role.selectionStart === 0, 'Select-all deletion rewrote ' + roleKey);
    assert(role.placeholder === defaultName, 'Default name must be a placeholder, not an editing value');
    view.updateContext(model); await view.refreshJob();
    assert(focused(role) && role.value === '' && role.selectionStart === 0, 'Background refresh replaced an empty draft');
    await text('我的名字');
    assert(role.value === '我的名字' && role.selectionStart === 4, 'Chinese replacement was prefixed or lost caret');
    for (let i = 0; i < 4; i++) await key('Backspace', 'Backspace', 8);
    assert(role.value === '' && role.selectionStart === 0, 'Character-by-character deletion restored a default');
    await text('Reader');
    assert(role.value === 'Reader', 'English replacement contains an old/default name');
    await key('a', 'KeyA', 65, 2); await key('Backspace', 'Backspace', 8);
    await tab(); view.updateContext(model);
    assert(role.value === '' && role.isConnected, 'Blur or refresh committed the placeholder into the draft');
    await escape();
    $('[data-export-settings-target="roles"]')?.click();
    assert($('[data-export-role="' + roleKey + '"]').value === '', 'Reopening settings discarded the empty draft');
    await escape();
  });
  await check(roleKey + ' name preserves native IME composition, commit and cancellation through refresh', async () => {
    $('[data-export-settings-target="roles"]')?.click();
    const role = $('[data-export-role="' + roleKey + '"]'), events = [];
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input']) {
      role.addEventListener(type, event => events.push({ type, trusted: event.isTrusted, composing: event.isComposing }));
    }
    role.focus(); await key('a', 'KeyA', 65, 2); await key('Backspace', 'Backspace', 8);
    await composition('zhong');
    assert(role.value === 'zhong' && focused(role), 'IME draft was changed before confirmation');
    const caret = role.selectionStart; view.updateContext(model); await view.refreshJob();
    assert(role.value === 'zhong' && focused(role) && role.selectionStart === caret, 'Refresh interrupted IME draft');
    await composition('中文'); await text('中文');
    assert(role.value === '中文' && role.selectionStart === 2, 'IME commit duplicated or prefixed the name');
    // Chromium 的 Input.insertText 提交会发出 isTrusted=false 的 compositionend；
    // 原生 compositionstart 和 composing input 才是确实走过候选输入链路的证据。
    assert(events.some(event => event.type === 'compositionstart' && event.trusted)
      && events.some(event => event.type === 'input' && event.trusted && event.composing)
      && events.some(event => event.type === 'compositionend'), 'IME was not tested with native composition events: ' + JSON.stringify(events));
    await key('a', 'KeyA', 65, 2); await key('Backspace', 'Backspace', 8);
    await composition('lin'); await composition('');
    view.updateContext(model);
    assert(role.value === '' && focused(role), 'Cancelling IME restored a default');
    await escape();
  });
}

$('[data-export-settings-back]')?.click();
await check('PDF choices and page-number switch keep native keyboard focus', async () => {
  const pdf = $('[data-export-format="pdf"]'); pdf.focus(); await space();
  assert(focused(pdf), 'Format activation remounted the control');
  $('[data-export-settings-view="pdf"]').click();
  const choice = $('[data-export-pdf-setting="orientation"][data-value="landscape"]'); choice.focus(); await space();
  assert(focused(choice) && choice.getAttribute('aria-pressed') === 'true', 'PDF choice lost focus');
  const toggle = $('[data-export-toggle="pageNumbers"]'); toggle.focus(); await space();
  assert(focused(toggle) && !toggle.checked, 'PDF page-number switch lost focus');
  await escape(); assert(focused($('[data-export-settings-view="pdf"]')), 'PDF settings did not return focus');
});
await check('inserting and removing job cards does not move the focused action button', async () => {
  const button = $('[data-export-action]'); button.focus();
  job = { id: 'keyboard-job', state: 'generating', revision: 2, outputName: 'example.pdf', progress: { phase: 'files', done: 1, total: 2 } };
  await view.refreshJob(); assert(focused(button), 'Adding job card moved focus');
  job = null; await view.refreshJob(); assert(focused(button), 'Removing job card moved focus');
});
await check('batch mode and organization choices retain a clear keyboard continuation', async () => {
  selection.beginSelection('favorites', 'export'); selection.toggleSelection('favorites', 'keyboard-test'); selection.toggleSelection('favorites', 'keyboard-second'); selection.submitSelection('favorites');
  view.setMode('current'); view.updateContext(model);
  const mode = $('[data-export-mode="batch"]'); mode.focus(); await space();
  await waitFor(previewReady);
  assert(focused($('[data-export-mode="batch"]')), 'Mode tab did not retain focus');
  const toggle = $('[data-export-organization-toggle="conversations"]'); toggle.focus(); await space();
  assert(focused(toggle), 'Organization expansion moved focus');
  const choice = $('[data-export-organization="conversations"]'); choice.focus(); await space();
  assert(focused(toggle), 'Organization choice did not return to its summary');
  $('[data-export-mode="current"]').click();
  assert(reads === 1, 'Local option changes unnecessarily reread conversation');
});

const host = () => document.querySelector('#tidy-export-preview-host');
const shadow = () => host()?.shadowRoot;
const modal = () => shadow()?.querySelector('dialog');
const closeButton = () => shadow()?.querySelector('header button');
const body = () => shadow()?.querySelector('.export-full-preview__body');
const background = document.querySelector('#background');
let clicks = 0; background.addEventListener('click', () => clicks++);
const open = sessionId => send(TidyProtocol.Type.EXPORT_PREVIEW_OPEN, { ...currentPayload, sessionId, format: 'txt', content: 'Keyboard preview\n'.repeat(150) });
const dismiss = sessionId => send(TidyProtocol.Type.EXPORT_PREVIEW_CLOSE, { sessionId });
await check('full preview is truly modal, autofocuses close, and cycles Tab inside Shadow DOM', async () => {
  const opener = $('[data-export-full-preview]'); opener.focus(); await space();
  await waitFor(() => modal()?.open);
  assert(shadow().activeElement === closeButton() && modal().matches(':modal'), 'Preview is not a focused native modal');
  await tab(true); assert(shadow().activeElement === body(), 'Shift+Tab escaped to the background');
  await tab(); assert(shadow().activeElement === closeButton(), 'Tab did not wrap to close');
  await tab(); assert(shadow().activeElement === body(), 'Tab cannot reach preview body');
  await key('PageDown', 'PageDown', 34); await sleep(200);
  assert(body().scrollTop > 0, 'Preview text cannot be scrolled with keyboard');
  background.focus(); assert(document.activeElement === host(), 'Background accepts focus while modal is open');
  await escape();
  assert(!host() && focused(opener), 'Escape did not restore preview trigger');
  assert(closed.at(-1) === currentPayload.sessionId, 'Close notification lost session ownership');
});
await check('backdrop blocks real clicks on the background, then clears modality without touching existing inert', async () => {
  background.focus(); open('backdrop-test');
  const rect = background.getBoundingClientRect();
  await clickAt(rect.left + 5, rect.top + 5);
  assert(!host() && clicks === 0 && focused(background), 'Backdrop click leaked or did not restore focus');
  assert(document.querySelector('#preexisting-inert').inert, 'Existing inert flag was cleared');
  await clickAt(rect.left + 5, rect.top + 5); assert(clicks === 1, 'Background remained blocked after close');
});
await check('new background nodes are inert too; close restores an opener nested in Shadow DOM', async () => {
  const owner = document.createElement('div'); document.body.append(owner);
  const nested = owner.attachShadow({ mode: 'open' }); nested.innerHTML = '<button>Nested opener</button>';
  const opener = nested.querySelector('button'); opener.focus(); open('nested-test');
  const added = document.createElement('button'); added.textContent = 'Added while modal open'; document.body.append(added); added.focus();
  assert(document.activeElement === host(), 'New background node escaped native modality');
  closeButton().focus(); await space();
  assert(!host() && nested.activeElement === opener, 'Closing did not restore deep Shadow DOM focus');
  owner.remove(); added.remove();
});
await check('iframe opener retains its inner focus on close, as in the embedded sidebar', async () => {
  const frame = document.createElement('iframe'); frame.srcdoc = '<div id="panel"></div>'; document.body.append(frame);
  await waitFor(() => frame.contentDocument?.querySelector('#panel'));
  try {
    const frameSelection = createExportSelection({ noticeText: (key, values) => model.translator(key, values) });
    frameView = createExportView({ selection: frameSelection, root: frame.contentDocument.querySelector('#panel'),
      requestDocument: async () => structuredClone(source), requestDocuments: async () => {},
      presentFullPreview: async payload => send(TidyProtocol.Type.EXPORT_PREVIEW_OPEN, payload),
      dismissFullPreview: async payload => send(TidyProtocol.Type.EXPORT_PREVIEW_CLOSE, payload),
      formatTimestamp: value => value,
    });
    frameView.updateContext(model);
    await waitFor(() => frame.contentDocument.querySelector('[data-export-full-preview]')?.disabled === false);
    const opener = frame.contentDocument.querySelector('[data-export-full-preview]'); opener.focus(); await space();
    await waitFor(() => modal()?.open); await escape();
    assert(document.activeElement === frame && frame.contentDocument.activeElement === opener, 'Inline sidebar focus was not restored');
  } finally { frameView?.updateContext({ ...model, active: false }); frameView = null; frame.remove(); }
});
await check('stale close cannot dismiss a replacement; repeated close emits only one receipt', async () => {
  background.focus(); open('old-session'); open('replacement-session');
  assert(!dismiss('old-session').closed && modal()?.open, 'Stale close removed the current modal');
  const before = closed.length; await escape();
  assert(closed.length === before + 1 && closed.at(-1) === 'replacement-session', 'Wrong close receipt');
  assert(!dismiss('replacement-session').closed && closed.length === before + 1, 'Duplicate close notification');
  assert(focused(background), 'Replacement forgot the original opener');
});
await check('separate sidepanel close receipts restore only the matching, still-owned entry', async () => {
  // 独立 Side Panel 不在页面模态的背景文档里；用隔离的表单实例验证关闭回执归属。
  const panel = document.createElement('div'); document.body.append(panel);
  let session;
  const isolatedSelection = createExportSelection({ noticeText: (key, values) => model.translator(key, values) });
  const isolatedView = createExportView({ selection: isolatedSelection, root: panel,
    requestDocument: async () => structuredClone(source), requestDocuments: async () => {},
    presentFullPreview: async payload => { session = payload.sessionId; return { opened: true }; },
    dismissFullPreview: async () => ({}), formatTimestamp: value => value,
  });
  try {
    isolatedView.updateContext(model);
    await waitFor(() => panel.querySelector('[data-export-full-preview]')?.disabled === false);
    const opener = panel.querySelector('[data-export-full-preview]'), filename = panel.querySelector('[data-export-filename]');
    opener.focus(); opener.click(); opener.blur();
    isolatedView.handleFullPreviewClosed('not-this-session');
    assert(!focused(opener), 'Foreign session restored focus');
    isolatedView.handleFullPreviewClosed(session); assert(focused(opener), 'Matching session did not restore focus');
    opener.click(); filename.focus(); isolatedView.handleFullPreviewClosed(session);
    assert(focused(filename), 'User focus on another control was stolen');
    opener.focus(); opener.click(); const oldSession = session;
    isolatedView.updateContext({ ...model, active: false }); background.focus(); isolatedView.handleFullPreviewClosed(oldSession);
    assert(focused(background), 'Inactive panel revived focus');
  } finally { isolatedView.updateContext({ ...model, active: false }); panel.remove(); }
});
await check('a removed opener is not revived or replaced with arbitrary background focus', async () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus(); open('removed-test'); opener.remove();
  await escape(); assert(!host() && !opener.isConnected, 'Removed opener or modal leaked');
  background.focus(); assert(focused(background), 'Focus remains blocked after detached opener close');
});
await check('preview header dragging stays in bounds and dragging out of content does not dismiss', async () => {
  open('drag-test'); const header = shadow().querySelector('header').getBoundingClientRect();
  await input({ kind: 'pointer', steps: [
    { type: 'mousePressed', x: header.left + 50, y: header.top + 20, button: 'left', clickCount: 1 },
    { type: 'mouseMoved', x: 3, y: 3, button: 'left', buttons: 1 },
    { type: 'mouseReleased', x: 3, y: 3, button: 'left', clickCount: 1 },
  ] });
  const rect = modal().getBoundingClientRect(); assert(rect.left >= 9 && rect.top >= 9, 'Modal drag escaped viewport');
  const inside = body().getBoundingClientRect();
  await input({ kind: 'pointer', steps: [
    { type: 'mousePressed', x: inside.left + 30, y: inside.top + 30, button: 'left', clickCount: 1 },
    { type: 'mouseMoved', x: 2, y: 2, button: 'left', buttons: 1 },
    { type: 'mouseReleased', x: 2, y: 2, button: 'left', clickCount: 1 },
  ] });
  assert(modal()?.open, 'Selecting text to the backdrop closed preview'); await escape();
});
await check('deactivation and account invalidation close preview without reviving stale form content', async () => {
  $('[data-export-full-preview]').click(); await waitFor(() => modal()?.open);
  const session = currentPayload.sessionId; view.updateContext({ ...model, accountKey: null });
  await waitFor(() => !host());
  view.handleFullPreviewClosed(session);
  assert(!$('[data-export-filename]') && $('[data-retry-library]'), 'Old account form survived invalidation');
  view.updateContext(model); await waitFor(previewReady);
  $('[data-export-full-preview]').click(); await waitFor(() => modal()?.open);
  view.updateContext({ ...model, active: false }); await waitFor(() => !host());
  background.focus(); view.handleFullPreviewClosed(currentPayload.sessionId);
  assert(focused(background), 'Late close notification stole background focus');
  view.updateContext(model);
});
await runDisclosureChecks({ check, assert, waitFor, sleep, space });

// 完成回执和截图来自同一次运行；最后留下 PDF 弹窗供人工核对视觉，没有真实文件下载。
await waitFor(previewReady); $('[data-export-format="pdf"]').click(); $('[data-export-full-preview]').click();
await waitFor(() => modal()?.open);
const output = document.querySelector('#results');
output.textContent = JSON.stringify({ ok: results.every(item => item.ok), results }, null, 2); output.dataset.complete = 'true';
