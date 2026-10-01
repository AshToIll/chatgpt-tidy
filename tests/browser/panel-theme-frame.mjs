import { createExportSelection } from '../../src/features/export/ui/export-selection.js';
import { TIME_VIEW_TEMPLATE } from "../../src/features/time/ui/time-template.js";
import { SETTINGS_VIEW_TEMPLATE } from "../../src/features/settings/ui/settings-template.js";
import '../../src/features/export/model/export.js';
import '../../src/features/export/model/export-preview.js';
import '../../src/features/export/engine/i18n.js';
import '../../src/features/export/engine/normalize.js';
import '../../src/features/export/engine/plan.js';
import '../../src/features/export/engine/inline-content.js';
import '../../src/features/export/engine/serializers.js';
import { createTranslator } from '../../src/messages/i18n.js';
import '../../src/platform/theme/theme.js';
const { NATIVE_APPEARANCE_TOKENS, THEMES } = globalThis.TidyTheme;
import { createExportView } from '../../src/features/export/ui/export-view.js';

// 页面骨架、导航和导出列表直接使用生产实现；仅账号与会话数据是合成的。
const assert = (value, message) => { if (!value) throw Error(message); };
const query = new URLSearchParams(location.search), mode = query.get('mode'), finalScheme = query.get('scheme');
const html = await (await fetch('../../src/app/sidepanel/index.html')).text();
document.body.append(new DOMParser().parseFromString(html, 'text/html').querySelector('.tidy-shell'));
  // This fixture mounts the real static feature templates without starting extension IPC.
  document.querySelector("#time-view").innerHTML = TIME_VIEW_TEMPLATE;
  document.querySelector("#settings-view").innerHTML = SETTINGS_VIEW_TEMPLATE;
document.querySelector('#panel-title').textContent = '导出';
document.querySelector('#panel-subtitle').textContent = '整理并保存对话';
document.querySelector('#time-display-control').hidden = true;
document.querySelector('.time-panel__body').dataset.activeRoute = 'export';
document.querySelectorAll('.module-view').forEach(element => element.classList.toggle('is-active', element.id === 'export-view'));
document.querySelector('[data-route="export"]').classList.add('is-active');
const root = document.querySelector('#export-view');
const field = value => ({ value, status: 'available', source: 'synthetic' });
const items = Object.fromEntries(['one', 'two', 'three'].map((id, index) => [id, { conversationId: id, title: ['调研与记录', '清单与想法', '产品交互讨论'][index], createdAt: '2026-09-17T00:00:00Z' }]));
const source = id => ({ schemaVersion: TidyExportContract.VERSION, warnings: [], conversation: { id, title: items[id].title,
  createdAt: '2026-09-17T00:00:00Z', updatedAt: '2026-09-17T00:00:00Z', sourceUrl: `https://chatgpt.com/c/${id}`, resources: [],
  messages: [{ id: `${id}-message`, messageNumber: 1, role: 'user', timestamp: null,
    segments: [{ type: 'content', sourceMessageId: `${id}-message`, timestamp: null, blocks: [{ type: 'paragraph', text: '本地合成会话' }] }] }] } });
const selection = createExportSelection({ noticeText: (key, values) => model.translator(key, values) });
const view = createExportView({ selection, root, requestDocument: async () => source('one'),
  requestDocuments: async () => ({ schemaVersion: TidyExportContract.COLLECTION_VERSION, documents: Object.keys(items).map(source) }),
  presentFullPreview: async () => { throw Error('Full preview is outside this theme fixture'); },
  dismissFullPreview: async () => {},
  formatTimestamp: () => '2026/09/17 08:00',
});
const model = { active: true, accountKey: 'theme-fixture', translator: createTranslator('zh-CN'), preferences: {},
  snapshot: { route: { pathname: '/c/one' }, conversation: { conversationId: 'one', identityStatus: 'stable', bindingStatus: 'bound',
    title: field(items.one.title), createdAt: field('2026-09-17T00:00:00Z'), updatedAt: field('2026-09-17T00:00:00Z') }, messages: [] },
  favorites: { accountKey: 'theme-fixture', revision: 1, items, groups: [] }, bookmarks: { accountKey: 'theme-fixture', revision: 1, items: {}, groups: [] },
};
view.setMode('batch'); view.updateContext(model);
if (mode === 'manage') {
  selection.beginSelection('favorites', 'export');
  for (const id of Object.keys(items)) selection.toggleSelection('favorites', id);
  selection.submitSelection('favorites');
  view.setSettingsView('manage'); view.updateContext(model);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert(root.querySelectorAll('.export-basket-conversation').length === 3, 'Production basket not populated');
  root.querySelector('[data-export-add-toggle]').click();
  assert(!root.querySelector('.export-add-menu').hidden, 'Add menu did not open');
}

// 同一批 DOM 反复换主题，覆盖动态切换，而不是靠重建页面掩盖遗留颜色。
function applyTheme(scheme, name, captured = null) {
  document.documentElement.dataset.nativeColorScheme = scheme;
  const style = document.documentElement.style;
  const kebab = key => key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());
  for (const [key, value] of Object.entries(NATIVE_APPEARANCE_TOKENS[scheme])) style.setProperty('--' + kebab(key), value);
  for (const [key, value] of Object.entries(THEMES[name][scheme])) {
    style.setProperty('--' + ({ selectedSurface: 'surface-selected', hoverSurface: 'surface-hover' }[key] || kebab(key)), value);
  }
  const accent = THEMES[name][scheme].accent;
  style.setProperty('--accent-rgb', [1, 3, 5].map(offset => parseInt(accent.slice(offset, offset + 2), 16)).join(', '));
  if (captured) style.setProperty('--surface', captured);
}
const fixtures = document.createElement('div'); fixtures.className = 'qa-fixtures'; fixtures.setAttribute('aria-hidden', 'true');
fixtures.innerHTML = `<div class="export-add-menu"><button>添加来源</button><button disabled>不可用</button></div>
  <div class="export-secondary-format">格式</div><div class="export-mini-segment"><button>选项</button></div>
  <span class="toggle-track"></span><div class="export-switch"><span></span></div>
  <div class="export-source-notice">已添加</div><div><span class="source-export-check"></span></div>
  <div class="is-added"><span class="source-export-check"></span></div>
  <footer class="source-export-select__footer"><span>来源</span><button disabled>添加</button></footer>
  <div class="export-action-bar__main"><button disabled>导出</button></div>
  <span class="export-organization-radio"></span><div class="export-error">错误说明</div>
  <div class="titles-notice">已保存</div><div class="titles-notice is-warning">请检查</div>
  <div class="titles-action-bar__end"><button disabled>确认</button></div>
  <div class="titles-batch-result-hero"><span>✓</span><span class="is-warning">!</span></div><div class="export-pdf-mini"></div>`;
document.body.append(fixtures);
const surfaceCases = [
  ['.export-add-menu', 'surface'], ['.export-add-menu button:disabled', 'surface-subtle'],
  ['.export-secondary-format', 'surface'], ['.export-mini-segment', 'surface-subtle'],
  ['.toggle-track', 'border'], ['.export-switch > span', 'border'],
  ['.export-source-notice', 'surface-subtle'], ['.qa-fixtures > div:not(.is-added) > .source-export-check', 'surface'],
  ['.is-added > .source-export-check', 'surface-subtle'], ['.source-export-select__footer', 'surface'],
  ['.source-export-select__footer button:disabled', 'surface-subtle'], ['.export-action-bar__main > button:disabled', 'surface-subtle'],
  ['.export-organization-radio', 'surface'], ['.export-error', 'danger-soft'],
  ['.titles-notice:not(.is-warning)', 'success-soft'], ['.titles-notice.is-warning', 'warning-soft'],
  ['.titles-action-bar__end > button:disabled', 'surface-subtle'], ['.titles-batch-result-hero > span:not(.is-warning)', 'success-soft'],
  ['.titles-batch-result-hero > span.is-warning', 'warning-soft'],
];
const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
const context = canvas.getContext('2d');
function rgb(color) { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; }
function luminance(color) {
  const channels = rgb(color).slice(0, 3).map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
const probe = document.createElement('span'); fixtures.append(probe);
function tokenColor(token) { probe.style.background = `var(--${token})`; return rgb(getComputedStyle(probe).backgroundColor).join(','); }
let surfacesChecked = 0;
for (const scheme of ['light', 'dark', 'light']) {
  for (const name of Object.keys(THEMES)) {
    for (const captured of [null, scheme === 'dark' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)']) {
      applyTheme(scheme, name, captured);
      // 开关保留生产的颜色过渡，等待浏览器动画真实结束再读落定值。
      getComputedStyle(fixtures.querySelector('.toggle-track')).backgroundColor;
      await Promise.all(fixtures.getAnimations({ subtree: true }).map(animation => animation.finished));
      for (const [selector, token] of surfaceCases) {
        const element = fixtures.querySelector(selector);
        assert(element, 'Missing theme sample ' + selector);
        assert(rgb(getComputedStyle(element).backgroundColor).join(',') === tokenColor(token), `${scheme}/${name}: ${selector} missed ${token}`);
        surfacesChecked++;
      }
      for (const selector of ['.titles-notice:not(.is-warning)', '.titles-notice.is-warning', '.export-error', '.export-secondary-format']) {
        const style = getComputedStyle(fixtures.querySelector(selector)), ink = luminance(style.color), surface = luminance(style.backgroundColor);
        assert((Math.max(ink, surface) + .05) / (Math.min(ink, surface) + .05) >= 4.5, `${scheme}: ${selector} text has insufficient contrast`);
      }
      if (mode === 'manage') {
        assert(rgb(getComputedStyle(root.querySelector('.export-add-menu')).backgroundColor).join(',') === tokenColor('surface'), 'Production menu surface missed theme');
      } else {
        assert(getComputedStyle(root.querySelector('.export-fixed-top')).borderBottomWidth === '0px', 'Empty basket kept second divider');
        const card = root.querySelector('.export-basket-empty').getBoundingClientRect(), tabs = root.querySelector('.export-mode-tabs').getBoundingClientRect();
        const gap = card.top - tabs.bottom;
        assert(gap >= 11 && gap <= 13, `Empty basket spacing was ${gap}, expected 12px`);
        assert(Math.abs(card.left - tabs.left) < 1 && Math.abs(card.right - tabs.right) < 1, 'Empty card and tabs do not align');
      }
      assert(rgb(getComputedStyle(fixtures.querySelector('.export-pdf-mini')).backgroundColor).slice(0, 3).every(value => value === 255), 'PDF paper followed UI theme');
    }
  }
}
for (const button of document.querySelectorAll('.dock-button')) {
  assert(button.getAttribute('aria-label') && !button.hasAttribute('title') && !button.hasAttribute('data-tooltip'), 'Navigation name/tooltip regression');
  button.focus(); assert(['none', 'normal'].includes(getComputedStyle(button, '::after').content), 'Navigation tooltip survives keyboard focus');
  button.blur();
}
applyTheme(finalScheme, 'mist-indigo', finalScheme === 'dark' ? 'rgb(0, 0, 0)' : null);
if (mode === 'empty') {
  // 留白不牺牲矮窗口可用性：最后一个添加按钮仍能滚到可见区域。
  root.style.height = '180px';
  const scroller = root.querySelector('.export-scroll');
  assert(scroller.scrollHeight > scroller.clientHeight, 'Compact empty basket lost scrolling');
  scroller.scrollTop = scroller.scrollHeight;
  assert(root.querySelector('.export-basket-empty button:last-child').getBoundingClientRect().bottom <= scroller.getBoundingClientRect().bottom + 1, 'Last add button cannot be reached');
  root.style.height = ''; scroller.scrollTop = 0;
}
await Promise.all(root.getAnimations({ subtree: true }).map(animation => animation.finished));
assert(document.documentElement.scrollWidth <= innerWidth, 'Sidebar overflows horizontally');
window.themeReport = { ok: true, surfacesChecked, nativePaletteAndEightAccents: true, dynamicSwitch: true, navigationAccessibleWithoutTooltip: true, emptyDivider: mode === 'empty' };
