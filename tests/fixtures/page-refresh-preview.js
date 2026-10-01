import { TIME_VIEW_TEMPLATE } from "/src/features/time/ui/time-template.js";
import { SETTINGS_VIEW_TEMPLATE } from "/src/features/settings/ui/settings-template.js";
import '/src/platform/library/library-hydration.js';
import '/src/features/export/model/export.js';
import '/src/features/export/model/export-preview.js';
import '/src/features/export/engine/i18n.js';
import '/src/features/export/engine/normalize.js';
import '/src/features/export/engine/plan.js';
import '/src/features/export/engine/inline-content.js';
import '/src/features/export/engine/serializers.js';
import { createTranslator } from '/src/messages/i18n.js';
import { renderPageRefreshNotice, pageRefreshRequired } from '/src/platform/session/ui/page-refresh-notice.js';
import { createLibraryBackupView } from '/src/features/settings/ui/library-backup-view.js';
import { createExportView } from '/src/features/export/ui/export-view.js';

// Real shell/CSS/notice/backup/export views; only disconnected account data is synthetic.
// This fixture never contacts ChatGPT, extension storage, or the user's saved library.
const query = new URLSearchParams(location.search);
if (!query.has('frame')) {
  document.body.style.cssText = 'display:flex;gap:24px;padding:16px;overflow:auto;height:100vh';
  for (const [width, scheme] of [[320, 'light'], [360, 'dark']]) {
    const frame = document.createElement('iframe');
    frame.width = width; frame.height = 640; frame.style.cssText = 'border:0;outline:1px solid #ccc;flex-shrink:0';
    frame.src = `${location.pathname}?frame=1&scheme=${scheme}`;
    frame.title = `${width}px ${scheme} shared refresh fixture`; document.body.append(frame);
  }
} else {
  const assert = (value, message) => { if (!value) throw Error(message); };
  const t = createTranslator('zh-CN'), html = await (await fetch('/src/app/sidepanel/index.html')).text();
  document.body.append(new DOMParser().parseFromString(html, 'text/html').querySelector('.tidy-shell'));
  // This fixture mounts the real static feature templates without starting extension IPC.
  document.querySelector("#time-view").innerHTML = TIME_VIEW_TEMPLATE;
  document.querySelector("#settings-view").innerHTML = SETTINGS_VIEW_TEMPLATE;
  if (query.get('scheme') === 'dark') {
    document.documentElement.dataset.nativeColorScheme = 'dark';
    for (const [name, color] of Object.entries({ surface: '#202123', text: '#eee', 'text-primary': '#eee', 'text-secondary': '#bdbdc4', muted: '#aaa', line: '#45454c', border: '#45454c', danger: '#ff8795' })) {
      document.documentElement.style.setProperty(`--${name}`, color);
    }
  }
  const error = { code: 'ADAPTER_UNAVAILABLE', details: { stage: 'service-worker.snapshot-send-message', disconnect: 'receiver-missing' } };
  const model = { snapshot: null, accountKey: null, error, moduleErrors: { favorites: error, bookmarks: error } };
  const root = document.querySelector('#page-refresh-notice'), views = [...document.querySelectorAll('[data-view]')];
  const backup = createLibraryBackupView({ root: document.querySelector('#library-backup'), translate: t,
    captureOwner: () => null, isCurrent: () => false, request: async () => { throw Error('No writes allowed'); },
    onRestored() {}, toast() {}, connection: () => ({ error, noticeShown: pageRefreshRequired(model) }) });
  backup.setActive(true);
  const exporter = createExportView({ root: document.querySelector('#export-view'),
    requestDocument: async () => { throw Error('No reads allowed'); }, requestDocuments: async () => { throw Error('No reads allowed'); },
    presentFullPreview: async () => {}, dismissFullPreview: async () => {} });
  exporter.suspend({ translator: t, preferences: {}, active: false });
  const titles = { time: '时间显示', titles: '标题整理', favorites: '收藏', bookmarks: '书签', search: '搜索', export: '导出', settings: '设置' };
  const render = route => {
    model.route = route;
    document.querySelector('#panel-title').textContent = titles[route];
    document.querySelector('#panel-subtitle').textContent = '仅合成测试，不连接真实账号';
    document.querySelector('#time-display-control').hidden = route !== 'time';
    document.querySelector('.time-panel__body').dataset.activeRoute = route;
    for (const view of views) view.classList.toggle('is-active', view.dataset.view === route);
    for (const button of document.querySelectorAll('[data-route]')) button.classList.toggle('is-active', button.dataset.route === route);
    renderPageRefreshNotice({ root, views, model, translate: t }); backup.update();
  };
  let position = null; const checked = [];
  for (const route of Object.keys(titles)) {
    render(route);
    const rect = root.getBoundingClientRect();
    if (!position) position = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    assert(rect.width > 0 && rect.height > 0 && rect.y > 0, `${route}: missing shared notice`);
    for (const key of Object.keys(position)) assert(rect[key] === position[key], `${route}: notice position drift`);
    assert(document.body.innerText.split('连接中断，请刷新网页').length === 2, `${route}: missing or duplicate message`);
    assert(!document.body.innerText.includes('重新读取'), `${route}: ineffective retry visible`);
    assert(!root.querySelector('button'), `${route}: refresh notice has a retry button`);
    assert(document.documentElement.scrollWidth <= innerWidth, `${route}: horizontal overflow`);
    checked.push(route);
  }
  model.error = null; model.moduleErrors = {}; render('export');
  assert(root.hidden && !views.some(view => view.hidden), 'Recovery did not restore visibility');
  assert(document.querySelector('.page-refresh-slot').getBoundingClientRect().height === 0, 'Empty notice retains its height');
  assert(document.querySelector('.time-panel__body').getBoundingClientRect().top === 58, 'Healthy shell layout changed');
  model.error = error; model.moduleErrors = { favorites: error, bookmarks: error }; render('export');
  document.querySelectorAll('[data-route]').forEach(button => button.addEventListener('click', () => render(button.dataset.route)));
  window.refreshNoticeReport = { ok: true, checked, position, width: innerWidth, scheme: query.get('scheme'), recoveredWithoutGap: true };
  window.addEventListener('pagehide', () => { backup.dispose(); exporter.suspend({ active: false }); });
}
