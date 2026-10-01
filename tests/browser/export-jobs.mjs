import { createExportSelection } from '../../src/features/export/ui/export-selection.js';
import { createExportView } from '../../src/features/export/ui/export-view.js';
import { STRINGS, createTranslator } from '../../src/messages/i18n.js';
import '../../src/platform/theme/theme.js';
const api = globalThis.TidyExport;
const t = (key, values = {}) => (STRINGS['zh-CN'][key] || key).replace(/\{(\w+)\}/g, (_, k) => values[k] ?? '');
const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
const ctx = canvas.getContext('2d'); ctx.fillStyle = '#b2cfe4'; ctx.fillRect(0, 0, 320, 180);
ctx.fillStyle = '#284258'; ctx.font = '32px sans-serif'; ctx.fillText('TIDY Image', 40, 96);
const conversation = { id: 'synthetic', title: '图文导出测试', createdAt: '2026-09-17T00:00:00Z', updatedAt: '2026-09-17T00:00:00Z',
  resources: [{ id: 'image-1', type: 'image', src: canvas.toDataURL(), name: 'fixture.png', mimeType: 'image/png', alt: '合成测试图', sizeBytes: null }],
  messages: [{ id: 'm1', messageNumber: 1, role: 'user', timestamp: '2026-09-17T00:00:00Z',
    segments: [{ type: 'content', sourceMessageId: 'm1', timestamp: null, blocks: [{ type: 'paragraph', text: '中文字号与图片测试。 Background export.' }, { type: 'image', resourceId: 'image-1', alt: '合成测试图' }] }] }] };
for (const [type, src] of [['jpeg', canvas.toDataURL('image/jpeg')], ['webp', canvas.toDataURL('image/webp')],
  ['gif', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7']]) {
  const id = 'image-' + type;
  conversation.resources.push({ id, type: 'image', src, name: 'fixture.' + type, mimeType: 'image/' + type, alt: type, sizeBytes: null });
  conversation.messages[0].segments[0].blocks.push({ type: 'image', resourceId: id, alt: type });
}
window.requestJob = async (action, payload) => {
  if (action === 'start') window.lastExportStart = { format: payload.spec.plan.format, outputName: payload.spec.plan.outputName };
  const response = await chrome.runtime.sendMessage({ test: 'export-jobs', action, payload });
  if (response.error) throw Error(response.error); return response.value;
};
window.startJob = (id, format = 'pdf') => {
  const batch = format === 'zip';
  const data = api.normalizeExportData({ conversations: batch ? [conversation, { ...conversation, id: 'synthetic-two' }] : [conversation], bookmarks: [] });
  const options = { mediaAttachments: true };
  const plan = api.buildExportPlan({ data, mode: batch ? 'batch' : 'current', currentConversationId: 'synthetic',
    conversationIds: ['synthetic', 'synthetic-two'], conversationOrganization: 'per-conversation', format: batch ? 'txt' : format, options,
    names: { current: id }, messages: STRINGS['zh-CN'] });
  return window.requestJob('start', { id, spec: { plan, warnings: [], context: { options, roleNames: { user: '用户', assistant: '助手' }, pdf: { fontSize: 'standard' } } } });
};
const selection = createExportSelection({ noticeText: t });
window.view = createExportView({ selection, root: document.querySelector('#export-root'), jobRequest: window.requestJob,
  requestDocument: async () => ({ schemaVersion: TidyExportContract.VERSION, conversation, warnings: [] }),
  requestDocuments: async () => ({ documents: [] }), presentFullPreview: async () => {}, dismissFullPreview: async () => {} });
view.updateContext({ active: true, accountKey: 'synthetic-account', preferences: { language: 'zh-CN' }, translator: t,
  snapshot: { route: { pathname: '/c/synthetic' }, conversation: { conversationId: 'synthetic', bindingStatus: 'bound', identityStatus: 'stable', title: { value: conversation.title } }, messages: [] } });
window.ready = true;

// 用合成任务检查生产卡片的四语文案和窄栏布局；真实下载流程在此之前独立验收。
window.checkStatusCopy = async () => {
  const assert = (value, message) => { if (!value) throw Error(message); };
  const gallery = document.createElement('main');
  gallery.style.cssText = 'display:grid;grid-template-columns:repeat(3,320px);gap:16px;padding:16px';
  document.body.style.cssText = 'margin:0;width:1024px;height:auto;background:#ddd';
  document.querySelector('#export-root').hidden = true;
  document.body.append(gallery);
  const languages = Object.keys(STRINGS), schemes = ['light', 'dark'];
  for (const scheme of schemes) for (const language of languages) {
    const translate = createTranslator(language), column = document.createElement('section');
    column.lang = language; column.style.cssText = 'min-width:0;padding:8px;color:var(--text-primary);background:var(--surface)';
    for (const [key, value] of Object.entries(TidyTheme.NATIVE_APPEARANCE_TOKENS[scheme])) {
      column.style.setProperty('--' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), value);
    }
    gallery.append(column);
    const heading = document.createElement('h3'); heading.textContent = `${language} · ${scheme}`; column.append(heading);
    let job = { id: 'copy-fixture', state: 'generating', revision: 1, outputName: 'sample.pdf', progress: { phase: 'resources', done: 128, total: null } };
    const host = document.createElement('div');
    const selection = createExportSelection({ noticeText: translate });
    const fixture = createExportView({ selection, root: host, jobRequest: async () => job,
      requestDocument: async () => ({ schemaVersion: TidyExportContract.VERSION, conversation, warnings: [] }),
      requestDocuments: async () => { throw Error('Status copy fixture must not read a batch'); },
      presentFullPreview: async () => {}, dismissFullPreview: async () => {} });
    fixture.updateContext({ active: true, accountKey: 'copy-fixture', preferences: { language }, translator: translate });
    for (const state of ['generating', 'failed', 'completed']) {
      job = { ...job, state, revision: job.revision + 1, errorCode: state === 'failed' ? 'exportJobInterrupted' : null,
        warnings: state === 'completed' ? [translate('exportImageNoAddress', { name: 'photo.png' })] : [] };
      await fixture.refreshJob();
      const card = host.querySelector('[data-export-job]');
      assert(card, `${language}: missing status card`);
      if (state === 'generating') {
        assert(!card.querySelector('p, .export-job__detail') && !card.textContent.includes('128'), 'internal progress leaked');
        assert(card.querySelector('[data-export-job-cancel]'), 'cancel action missing');
      }
      if (state === 'failed') {
        assert(card.textContent.split(translate('exportJobFailed')).length === 2, 'duplicate failure');
        assert(!card.querySelector('[data-export-downloads], [data-export-job-cancel]'), 'failed export must offer retry, not more recovery steps');
        assert(!fixture.hasActiveJob(), 'failure must release the busy state');
      }
      if (state === 'completed') assert(card.querySelector('details:not([open])'), 'missing or expanded warnings');
      const sample = card.cloneNode(true); column.append(sample);
      assert(sample.scrollWidth <= sample.clientWidth, `${language}: card overflows`);
      if (state === 'generating') {
        const cancel = sample.querySelector('button'), title = sample.querySelector('strong');
        assert(title.getBoundingClientRect().right <= cancel.getBoundingClientRect().left, `${language}: cancel overlaps status`);
        assert(getComputedStyle(sample.querySelector('.export-job__spinner')).width === '12px', 'spinner CSS missing');
      }
    }
    fixture.suspend();
  }
  return { ok: true, languages: languages.length, schemes: schemes.length, cards: gallery.querySelectorAll('[data-export-job]').length };
};
