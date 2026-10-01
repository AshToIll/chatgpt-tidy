const fs = require('node:fs');
const assert = require('node:assert/strict');
const test = require('node:test');
const { readPanelCss } = require('./helpers/read-panel-css.cjs');
const { readPanelHtml } = require('./helpers/read-panel-html.cjs');
// Inspect each file at its feature-owned location; panel CSS follows browser import order.
const read = name => {
  if (name === 'panel.css') return readPanelCss();
  if (name === 'index.html') return readPanelHtml();
  const file = name.startsWith('export') ? 'src/features/export/ui/' + name
    : name.startsWith('title') ? 'src/features/titles/ui/' + name : 'src/app/sidepanel/' + name;
  return fs.readFileSync(file, 'utf8');
};
function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const match = css.match(new RegExp('^' + escaped + '\\s*\\{([^}]+)\\}', 'm'));
  assert.ok(match, 'Missing selector: ' + selector);
  return match[1];
}

test('navigation icons retain accessible names without native or custom hover tooltips', () => {
  const html = read('index.html'), js = read('shell-presentation.js'), css = read('panel.css');
  const buttons = [...html.matchAll(/<button\b[^>]*data-route="[^"]+"[^>]*>/g)];
  assert.equal(buttons.length, 7);
  for (const [button] of buttons) {
    assert.match(button, /aria-label="[^"]+"/);
    assert.doesNotMatch(button, /\b(?:title|data-tooltip)=/);
  }
  assert.doesNotMatch(css, /\.dock-button[^{}]*::(?:before|after)/);
  assert.doesNotMatch(js, /dataset\.tooltip|data-i18n-tooltip/);
  assert.match(js, /button\.setAttribute\("aria-label", translate\(PANEL_ROUTES\[button\.dataset\.route\]\?\.title \|\| "settings"\)\)/);
  assert.match(rule(css, '.dock-button:focus-visible'), /outline:\s*2px solid var\(--accent-ring\)/);
});

const surfaces = {
  'panel.css': ['.toggle-track', '.source-export-entry:hover, .source-export-entry:focus-visible'],
  'export.css': ['.export-add-menu', '.export-add-menu button:disabled, .export-add-menu button:disabled:hover',
    '.export-secondary-format', '.export-mini-segment', '.export-switch > span', '.export-source-notice',
    '.source-export-row:hover, .source-export-row:focus-visible', '.source-export-check', '.is-added > .source-export-check',
    '.source-export-select__footer', '.source-export-select__footer button:disabled', '.export-action-bar__main > button:disabled',
    '.export-organization-radio', '.export-error',
    '.export-organization-options button:hover, .export-organization-options button:focus-visible',
    '.export-basket-conversation > button:hover, .export-basket-bookmark > button:hover, .export-basket-bookmark-group > header > button:last-child:hover'],
  'title.css': ['.titles-notice', '.titles-notice.is-warning', '.titles-action-bar__end > button:not(.titles-icon-action):disabled'],
  'title-batch.css': ['.titles-batch-result-hero > span', '.titles-batch-result-hero > span.is-warning'],
};
for (const [file, selectors] of Object.entries(surfaces)) {
  test(`${file}: previously missed surfaces use theme variables at their original declaration`, () => {
    const css = read(file);
    for (const selector of selectors) {
      const declarations = rule(css, selector);
      assert.match(declarations, /background:\s*var\(--[a-z-]+\)/, selector);
      assert.doesNotMatch(declarations, /(?:background(?:-color)?|color|border(?:-color)?):[^;]*#[\da-f]{3,8}\b/i, selector);
    }
  });
}

test('empty batch keeps only the tab divider and a deliberate gap before the add card', () => {
  const css = read('export.css');
  assert.match(rule(css, '.export-panel.is-empty > .export-fixed-top'), /border-bottom:\s*0/);
  assert.match(rule(css, '.export-panel.is-empty > .export-fixed-top'), /padding-bottom:\s*0/);
  assert.match(rule(css, '.export-panel.is-empty > .export-scroll'), /padding-top:\s*12px/);
  assert.match(rule(css, '.export-panel.is-empty > .export-scroll'), /scrollbar-gutter:\s*auto/);
  assert.match(rule(css, '.export-mode-tabs'), /border-bottom:\s*1px solid var\(--border\)/);
});

test('semantic notices follow current surface while PDF paper keeps its own appearance', () => {
  const css = read('panel.css');
  for (const name of ['success', 'warning']) {
    assert.match(rule(css, ':root'), new RegExp('--' + name + ':'));
    assert.match(rule(css, ':root[data-native-color-scheme="dark"]'), new RegExp('--' + name + ':'));
  }
  for (const name of ['success', 'warning', 'danger']) {
    assert.match(rule(css, ':root'), new RegExp('--' + name + '-soft:\\s*color-mix\\(in srgb, var\\(--surface\\)'));
  }
  assert.match(rule(read('export.css'), '.export-pdf-mini'), /background:\s*#fff/);
});
