const { readPanelCss } = require("./helpers/read-panel-css.cjs");
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const runtime = Promise.all([import('../src/platform/session/ui/page-refresh-notice.js'), import('../src/messages/i18n.js'), import('../src/platform/library/library-hydration.js')]);
const missing = stage => ({ code: 'ADAPTER_UNAVAILABLE', details: { stage, disconnect: 'receiver-missing' } });
const routes = ['time', 'titles', 'favorites', 'bookmarks', 'search', 'export', 'settings'];
async function harness() {
  const [{ pageRefreshRequired, renderPageRefreshNotice }, { createTranslator }] = await runtime;
  const root = { hidden: true, textContent: '' };
  // The presentation shell supplies six business roots plus the page-dependent settings form.
  const views = routes.map(view => ({ id: view === 'settings' ? 'settings-form' : view + '-view', dataset: { view }, hidden: false }));
  const model = { pageSession: { phase: 'ready' }, error: null, snapshot: null, accountKey: null, favorites: null, bookmarks: null, moduleErrors: {} };
  const update = (language = 'zh-CN') => renderPageRefreshNotice({ root, views, model, translate: createTranslator(language) });
  return { root, views, model, update, required: () => pageRefreshRequired(model) };
}
test('only page session admission controls the shell, not business errors', async () => {
  const h = await harness();
  for (const error of [missing('service-worker.snapshot-send-message'), missing('service-worker.library-account-transport'),
    { code: 'ADAPTER_UNAVAILABLE', details: { stage: 'content.library-runtime-send-message', disconnect: 'context-invalidated' } }]) {
    h.model.error = error; h.model.pageSession.phase = 'refresh-required';
    assert.equal(h.update(), true); assert.equal(h.root.textContent, '连接中断，请刷新网页');
  }
  for (const error of [null, { code: 'STORAGE_ERROR' }, { code: 'ADAPTER_UNAVAILABLE', details: { status: 503 } },
    { code: 'ADAPTER_UNAVAILABLE', details: { stage: 'sidepanel.runtime-send-message', disconnect: 'context-invalidated' } },
    { code: 'ADAPTER_UNAVAILABLE', details: { stage: 'service-worker.snapshot-send-message', disconnect: 'connection-closed' } }]) {
    h.model.error = error; h.model.pageSession.phase = 'ready'; assert.equal(h.update(), false); assert.equal(h.root.hidden, true);
    assert.ok(h.views.every(view => !view.hidden));
  }
});
test('all seven routes share one header notice; their business regions have no competing controls', async () => {
  const h = await harness(); h.model.pageSession.phase = 'refresh-required';
  for (const route of routes) {
    h.model.route = route; h.update();
    assert.equal(h.root.hidden, false); assert.equal(h.root.textContent, '连接中断，请刷新网页');
    for (const view of h.views) { assert.equal(view.hidden, true); assert.equal(view.inert, true); }
  }
});
test('loaded library/export/settings form stay hidden and inert, not a capability to keep interacting', async () => {
  const h = await harness(); h.model.pageSession.phase = 'refresh-required';
  h.model.accountKey = 'synthetic'; h.model.favorites = {}; h.model.bookmarks = {};
  h.update();
  for (const name of routes) { const view = h.views.find(v => v.dataset.view === name); assert.equal(view.hidden, true); assert.equal(view.inert, true); }
  assert.equal(h.model.accountKey, 'synthetic'); assert.ok(h.model.favorites); assert.ok(h.model.bookmarks);
});
test('snapshot and library recovery cannot unlock the shell in either order', async () => {
  for (const first of ['snapshot', 'library']) {
    const h = await harness();
    h.model.pageSession.phase = 'refresh-required';
    h.model.error = missing('service-worker.snapshot-send-message');
    h.model.moduleErrors.favorites = missing('service-worker.library-account-transport'); h.update();
    const restore = source => {
      if (source === 'snapshot') { h.model.snapshot = {}; h.model.error = null; }
      else h.model.moduleErrors.favorites = null;
      h.update();
    };
    restore(first); assert.equal(h.root.hidden, false);
    restore(first === 'snapshot' ? 'library' : 'snapshot'); assert.equal(h.root.hidden, false);
    h.model.pageSession.phase = 'ready'; h.update(); assert.equal(h.root.hidden, true);
    assert.equal(h.root.textContent, ''); assert.ok(h.views.every(view => !view.hidden));
  }
});
test('the shared notice follows UI language, and bootstrap waiting has one inert presentation', async () => {
  const h = await harness(); h.model.pageSession.phase = 'refresh-required';
  h.update('en'); assert.equal(h.root.textContent, 'Connection lost. Reload ChatGPT.');
  h.model.snapshot = {}; assert.equal(h.update(), true);
  h.model.pageSession.phase = 'connecting'; h.update('en');
  assert.equal(h.root.textContent, 'Connecting to ChatGPT…'); assert.ok(h.views.every(v => v.hidden && v.inert));
  h.model.pageSession.phase = 'ready'; assert.equal(h.update(), false); assert.ok(h.views.every(v => !v.hidden && !v.inert));
});
test('the shared slot reuses the original red card and does not consume content height when empty', () => {
  const html = fs.readFileSync('src/app/sidepanel/index.html', 'utf8'), css = readPanelCss();
  assert.equal((html.match(/id="page-refresh-notice"/g) || []).length, 1);
  assert.match(html, /id="page-refresh-notice" class="status-card" role="status" aria-live="polite" hidden/);
  assert.ok(html.indexOf('id="page-refresh-notice"') < html.indexOf('class="time-panel__body"'));
  assert.match(css, /\.time-panel:has\(> \.page-refresh-slot\)\s*\{\s*grid-template-rows: 58px auto minmax\(0, 1fr\)/);
  assert.match(css, /\.page-refresh-slot:has\(\.status-card:not\(\[hidden\]\)\)/);
});
