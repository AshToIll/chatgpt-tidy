const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');

// These hashes freeze the exact original 0.4.0 inner markup (LF normalized).
// They guard IDs, classes, element order, accessibility attributes and fallback
// copy without depending on another checkout or an ignored .tmp directory.
test('extracted templates preserve original markup apart from documented independent controls', async () => {
  const { TIME_VIEW_TEMPLATE } = await import('../src/features/time/ui/time-template.js');
  const { SETTINGS_VIEW_TEMPLATE } = await import('../src/features/settings/ui/settings-template.js');
  const digest = value => crypto.createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex');
  // Reconstruct only the authorized independent grouping and compact switch changes.
  // All other historical markup stays frozen.
  const numberingSection = '<section class="setting-section setting-section--toggle setting-section--no-border">';
  assert.equal(TIME_VIEW_TEMPLATE.split(numberingSection).length, 2, 'one independent numbering row is present');
  const compactSwitch = '<label class="toggle-control toggle-control--compact"><input id="message-numbers"';
  assert.equal(TIME_VIEW_TEMPLATE.split(compactSwitch).length, 2, 'only the numbering switch uses the compact variant');
  const originalTimeMarkup = TIME_VIEW_TEMPLATE
    .replace(numberingSection, numberingSection.slice(0, -1) + ' data-time-control>')
    .replace(compactSwitch, '<label class="toggle-control"><input id="message-numbers"');
  assert.equal(digest(originalTimeMarkup), '100b12c951c19ce9af4e6f14ad9a18cb15f97b57ba5352f0146518666984b113');
  // The diagnostics mount is the only explicitly authorized new settings markup.
  // Keep the original settings baseline frozen; audit the new mount separately.
  const diagnosticsMount = '            <!-- 排查日志只属于设置底部；不放入依赖网页连接的业务表单。 -->\n            <section id="settings-diagnostics" class="settings-diagnostics"></section>\n';
  assert.equal(SETTINGS_VIEW_TEMPLATE.split(diagnosticsMount).length, 2, 'one diagnostics mount is present');
  assert.match(SETTINGS_VIEW_TEMPLATE, /<section id="library-backup"[^>]*><\/section>\n\s+<\/form>\n\s+<!--[^]*?-->\n\s+<section id="settings-diagnostics"/);
  assert.equal(digest(SETTINGS_VIEW_TEMPLATE.replace(diagnosticsMount, '')), 'ed3c4ec1e53e86339062704496a8524b3613a4d2303fb4cbfcb0716c07f651e7');
  const html = fs.readFileSync(path.join(ROOT, 'src/app/sidepanel/index.html'), 'utf8');
  assert.match(html, /<section id="time-view"[^>]*><\/section>/);
  assert.match(html, /<section id="settings-view"[^>]*><\/section>/);
  assert.doesNotMatch(html, /id="settings-form"|id="conversation-list-panel"/);
  const panel = fs.readFileSync(path.join(ROOT, 'src/app/sidepanel/panel.js'), 'utf8');
  assert.ok(panel.indexOf('const timeView = createTimeView(') < panel.indexOf('async function init()'));
  assert.ok(panel.indexOf('const settingsView = createSettingsView(') < panel.indexOf('root: document.getElementById("library-backup")'), 'settings mounts its template before backup binds its host');
  assert.doesNotMatch(panel, /function renderTimeControls|function timeZoneList|const THEME_NAMES|openDisclosure/);
  const lifecycle = fs.readFileSync(path.join(ROOT, 'src/app/sidepanel/panel-lifecycle.js'), 'utf8');
  assert.match(lifecycle, /time\.dispose\(\);\s*settings\.dispose\(\);/);
  assert.match(panel, /time: \{ dispose: timeView\.dispose/);
  assert.match(panel, /settings: settingsView/);
});

function node() {
  const classes = new Set(), listeners = new Map(), attributes = new Map();
  let html = '', text = '';
  return {
    dataset: {}, disabled: false, hidden: false, checked: false, value: '', htmlWrites: 0, textWrites: 0,
    get innerHTML() { return html; }, set innerHTML(value) { this.htmlWrites++; html = value; },
    get textContent() { return text; }, set textContent(value) { this.textWrites++; text = value; },
    classList: { toggle(key, value) { if (value) classes.add(key); else classes.delete(key); }, contains: key => classes.has(key) },
    setAttribute(key, value) { attributes.set(key, value); }, getAttribute: key => attributes.get(key),
    addEventListener(key, fn) { listeners.set(key, fn); },
    removeEventListener(key, fn) { if (listeners.get(key) === fn) listeners.delete(key); },
    emit(key, event = {}) { listeners.get(key)?.(event); },
    listenerCount: () => listeners.size,
  };
}
function timeHost() {
  const root = node(), body = node(), toggle = node(), ids = new Map();
  for (const id of ['message-numbers', 'conversation-preview', 'message-preview', 'conversation-list-summary', 'message-time-summary', 'conversation-list-panel', 'message-time-panel']) ids.set(id, node());
  const options = Object.entries({ dateFormat: ['locale', 'iso', 'slash', 'dot', 'compact'], conversationTimeMode: ['range', 'created', 'updated'], conversationTimePrecision: ['date', 'hour', 'minute'], messageTimePosition: ['before', 'after'], messageTimePrecision: ['minute', 'second'] })
    .flatMap(([preference, values]) => values.map(value => Object.assign(node(), { dataset: { preference, value } })));
  const disclosures = ['list', 'message'].map(value => {
    const button = Object.assign(node(), { dataset: { disclosureToggle: value } });
    button.setAttribute('aria-controls', value === 'list' ? 'conversation-list-panel' : 'message-time-panel');
    return button;
  });
  root.querySelector = selector => ids.get(selector.slice(1));
  root.querySelectorAll = selector => selector === '[data-disclosure-toggle]' ? disclosures
    : options.filter(item => selector === 'button[data-preference]' || item.dataset.preference === 'dateFormat');
  const click = (item, kind) => root.emit('click', { target: { closest: selector => selector === kind ? item : null } });
  return { root, body, toggle, ids, options, disclosures, click };
}
const preferences = () => ({ language: 'en', timeZone: 'UTC', theme: 'sage', dateFormat: 'locale', conversationTimeMode: 'range', conversationTimePrecision: 'minute', messageTimePosition: 'after', messageTimePrecision: 'second', timeDisplayEnabled: true, messageNumbersEnabled: true });
async function timeHarness() {
  const { createTimeView } = await import('../src/features/time/ui/time-view.js');
  const host = timeHost(), saves = [], formats = [];
  const format = {
    dateFormatLabels: () => ({ iso: '2026-09-29', slash: '2026/09/29', dot: '2026.09.29', compact: '20260929' }),
    formatConversation: (value, options) => { formats.push(options); return value.label || ''; },
    formatDateTime: (value, options) => { formats.push(options); return value ? 'time:' + value : ''; },
  };
  const view = createTimeView({ ...host, timeFormat: format, effectiveTimeZone: value => value.timeZone, localeForLanguage: () => 'en-US', savePreference: patch => saves.push(patch) });
  return { ...host, view, saves, formats };
}

test('time view retains option selection, disclosure and preference behavior without remounting', async () => {
  const h = await timeHarness(), prefs = preferences(), translator = key => key;
  const update = () => h.view.renderControls({ preferences: prefs, translator });
  const regional = h.options[0]; regional.textContent = 'Follow regional format · Default';
  update();
  assert.equal(h.root.htmlWrites, 1);
  assert.equal(h.toggle.checked, true);
  assert.equal(h.toggle.getAttribute('aria-checked'), 'true');
  assert.equal(regional.classList.contains('is-selected'), true);
  assert.equal(regional.textContent, 'Follow regional format · Default');
  assert.equal(h.options[1].textContent, '2026-09-29');
  const writes = h.options[1].textWrites; update();
  assert.equal(h.options[1].textWrites, writes, 'unchanged dates do not rewrite button text');
  assert.equal(h.ids.get('conversation-list-summary').innerHTML, 'timeRange<span class="summary-separator">·</span>minute');
  assert.equal(h.ids.get('message-time-summary').textContent, 'after · second');
  h.click(h.disclosures[0], '[data-disclosure-toggle]');
  assert.equal(h.ids.get('conversation-list-panel').hidden, false);
  h.click(h.disclosures[1], '[data-disclosure-toggle]');
  assert.equal(h.ids.get('conversation-list-panel').hidden, true);
  assert.equal(h.ids.get('message-time-panel').hidden, false);
  h.click(h.options[1], 'button[data-preference]');
  assert.deepEqual(h.saves.pop(), { dateFormat: 'iso' });
  h.toggle.checked = false; h.toggle.emit('change');
  assert.deepEqual(h.saves.pop(), { timeDisplayEnabled: false });
  prefs.timeDisplayEnabled = false; update();
  assert.ok(h.options.every(item => item.disabled));
  assert.ok(h.disclosures.every(item => item.disabled));
  assert.equal(h.body.classList.contains('time-settings-disabled'), true);
  h.click(h.options[1], 'button[data-preference]'); assert.equal(h.saves.length, 0);
  prefs.timeDisplayEnabled = true; update();
  assert.equal(h.ids.get('message-time-panel').hidden, true, 'turning time off clears the remembered disclosure');
  h.ids.get('message-numbers').checked = false; h.ids.get('message-numbers').emit('change');
  assert.deepEqual(h.saves.pop(), { messageNumbersEnabled: false });
  assert.equal(h.root.htmlWrites, 1, 'updates do not replace the module DOM');
  h.view.setAvailable(false); assert.equal(h.toggle.disabled, true);
  h.view.setAvailable(true); assert.equal(h.toggle.disabled, false);
  h.view.dispose();
  assert.equal(h.root.listenerCount() + h.toggle.listenerCount() + h.ids.get('message-numbers').listenerCount(), 0);
});

test('message numbering stays outside the time-disabled group and switches independently while time is off', async () => {
  const { TIME_VIEW_TEMPLATE } = await import('../src/features/time/ui/time-template.js');
  const sections = [...TIME_VIEW_TEMPLATE.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/g)];
  const numberingSection = sections.find(([, , content]) => content.includes('id="message-numbers"'));
  assert.ok(numberingSection, 'the production template owns one message-numbering row');
  assert.doesNotMatch(numberingSection[1], /\bdata-time-control\b/,
    'an independent numbering toggle must not inherit the time-disabled opacity');
  assert.equal(sections.filter(([, attributes]) => /\bdata-time-control\b/.test(attributes)).length, 3,
    'date format, conversation time and message time keep their disabled group');

  const h = await timeHarness(), prefs = preferences(), translator = key => key;
  const snapshot = { conversation: { label: 'conversation-time' }, messages: [
    { timestamp: { value: 'known-time' }, order: { displayNumber: 8 } },
  ] };
  const update = () => {
    h.view.renderControls({ preferences: prefs, translator });
    h.view.renderPreview({ snapshot, preferences: prefs, translator });
  };
  update();
  h.toggle.checked = false; h.toggle.emit('change');
  assert.deepEqual(h.saves.pop(), { timeDisplayEnabled: false });
  prefs.timeDisplayEnabled = false; update();
  const numbering = h.ids.get('message-numbers');
  assert.equal(h.body.classList.contains('time-settings-disabled'), true);
  assert.ok(h.options.every(item => item.disabled) && h.disclosures.every(item => item.disabled));
  assert.equal(numbering.disabled, false, 'numbering remains available when time settings are disabled');
  assert.equal(numbering.checked, true);
  assert.equal(h.ids.get('message-preview').textContent, '#8');
  for (const enabled of [false, true]) {
    numbering.checked = enabled; numbering.emit('change');
    assert.deepEqual(h.saves.pop(), { messageNumbersEnabled: enabled },
      'changing numbering never re-enables time or overwrites another preference');
    prefs.messageNumbersEnabled = enabled; update();
    assert.equal(h.toggle.checked, false);
    assert.equal(numbering.disabled, false);
    assert.equal(numbering.checked, enabled);
    assert.equal(numbering.getAttribute('aria-checked'), String(enabled));
    assert.equal(h.ids.get('conversation-preview').textContent, '—');
    assert.equal(h.ids.get('message-preview').textContent, enabled ? '#8' : '—');
  }
  assert.equal(h.root.htmlWrites, 1, 'independent switches preserve their existing DOM');
  h.view.dispose();
});

test('time preview preserves last timestamp selection, numbering and disabled fallbacks', async () => {
  const h = await timeHarness(), prefs = preferences();
  const snapshot = { conversation: { label: 'conversation-time' }, messages: [
    { timestamp: { value: 'first' }, order: { displayNumber: 1 } },
    { timestamp: { value: 'last-known' }, order: { displayNumber: 2 } },
    { order: { displayNumber: 3 } },
  ] };
  const render = () => h.view.renderPreview({ snapshot, preferences: prefs, translator: key => key });
  render();
  assert.equal(h.ids.get('conversation-preview').textContent, 'conversation-time');
  assert.equal(h.ids.get('message-preview').textContent, '#2  time:last-known');
  assert.deepEqual(h.formats.at(-1), { timeZone: 'UTC', locale: 'en-US', dateFormat: 'locale', precision: 'second' });
  prefs.timeDisplayEnabled = false; render();
  assert.equal(h.ids.get('conversation-preview').textContent, '—');
  assert.equal(h.ids.get('message-preview').textContent, '#2');
  prefs.messageNumbersEnabled = false; render();
  assert.equal(h.ids.get('message-preview').textContent, '—');
  prefs.timeDisplayEnabled = true; snapshot.messages = [{ order: { index: 7 } }]; render();
  assert.equal(h.ids.get('message-preview').textContent, 'noTime', 'mounted order.index is not a global number');
  snapshot.messages = []; render(); assert.equal(h.ids.get('message-preview').textContent, '—');
});

function settingsHost() {
  const root = node(), language = node(), timeZone = node(), themes = node(), backup = node();
  language.options = ['zh-CN', 'zh-TW', 'en', 'ja'].map(value => Object.assign(node(), { value }));
  let inputs = [], html = '';
  Object.defineProperty(themes, 'innerHTML', { get() { return html; }, set(value) {
    this.htmlWrites++; html = value;
    inputs = [...value.matchAll(/<input type="radio" name="settings-theme" value="([^"]+)"/g)].map(match => {
      const label = node(); return Object.assign(node(), { value: match[1], closest: () => label });
    });
  } });
  themes.querySelectorAll = () => inputs;
  const ids = { 'language-select': language, 'timezone-select': timeZone, 'theme-grid': themes, 'library-backup': backup };
  root.querySelector = selector => ids[selector.slice(1)];
  return { root, language, timeZone, themes, backup, getInputs: () => inputs };
}

test('settings view retains language, timezone and theme behavior and does not remount backup', async () => {
  const { createSettingsView } = await import('../src/features/settings/ui/settings-view.js');
  const { createTranslator } = await import('../src/messages/i18n.js');
  const host = settingsHost(), saves = [], prefs = preferences();
  const palette = { light: { accent: '#aabbcc', accentSoft: '#ddeeff' }, dark: { accent: '#ccddee', accentSoft: '#112233' } };
  const view = createSettingsView({ root: host.root, themes: { sage: palette, amber: palette }, savePreference: value => saves.push(value) });
  const update = (appearance = 'light') => view.update({ preferences: prefs, translator: createTranslator(prefs.language), appearance });
  update();
  assert.equal(host.root.htmlWrites, 1);
  assert.equal(host.language.value, 'en');
  assert.deepEqual(host.language.options.map(item => item.textContent), ['简体中文', '繁體中文', 'English', '日本語']);
  assert.equal(host.timeZone.value, 'UTC');
  assert.match(host.timeZone.innerHTML, /value="system"/);
  assert.match(host.timeZone.innerHTML, /value="UTC"/);
  assert.equal(host.getInputs()[0].checked, true);
  const originalInput = host.getInputs()[0], originalThemeWrites = host.themes.htmlWrites;
  prefs.theme = 'amber'; view.updateTheme({ preferences: prefs, appearance: 'light' });
  assert.equal(host.themes.htmlWrites, originalThemeWrites, 'accent-only updates retain focused radios');
  assert.equal(host.getInputs()[0], originalInput);
  assert.equal(host.getInputs()[0].checked, false); assert.equal(host.getInputs()[1].checked, true);
  view.updateTheme({ preferences: prefs, appearance: 'dark' });
  assert.equal(host.themes.htmlWrites, originalThemeWrites + 1);
  host.language.value = 'ja'; host.language.emit('change'); assert.deepEqual(saves.pop(), { language: 'ja' });
  host.timeZone.value = 'Asia/Tokyo'; host.timeZone.emit('change'); assert.deepEqual(saves.pop(), { timeZone: 'Asia/Tokyo' });
  host.themes.emit('change', { target: { matches: selector => selector === 'input[name="settings-theme"]', value: 'sage' } });
  assert.deepEqual(saves.pop(), { theme: 'sage' });
  prefs.language = 'ja'; update();
  assert.deepEqual(host.language.options.map(item => item.textContent), ['简体中文', '繁體中文', 'English', '日本語']);
  assert.equal(host.root.htmlWrites, 1); assert.equal(host.backup.htmlWrites, 0);
  view.dispose();
  assert.equal(host.language.listenerCount() + host.timeZone.listenerCount() + host.themes.listenerCount(), 0);
});
