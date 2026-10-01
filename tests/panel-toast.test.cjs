const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/app/sidepanel/panel.js', 'utf8');

function node() {
  return { hidden: true, textContent: '', children: [], attributes: {}, listeners: {},
    classList: { toggle() {} }, append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; } };
}

async function harness() {
  const { createTranslator } = await import('../src/messages/i18n.js');
  const { createNoticeController } = await import("../src/app/sidepanel/notice-controller.js");
  const toast = node(), timers = new Map();
  let ready = true, clock = 0, nextTimer = 0, timerStarts = 0;
  let translate = createTranslator('zh-CN');
  const context = createNoticeController({
    root: toast, translate: (...args) => translate(...args),
    isReady: () => ready, isCurrentNavigation: () => false,
    document: { createElement: node },
    setTimer(callback, delay) { timerStarts++; timers.set(++nextTimer, { at: clock + delay, callback }); return nextTimer; },
    clearTimer(id) { timers.delete(id); },
  });
  return { toast, timers, context, createTranslator,
    get timerStarts() { return timerStarts; },
    ready(value) { ready = value; },
    language(value) { translate = createTranslator(value); context.renderToast(); },
    advance(ms) {
      clock += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.callback(); }
    },
  };
}

test('visible error and close label retranslate in place without dismissing or replacing focus', async () => {
  const h = await harness();
  h.context.showToast('libraryChangeUnknown', true);
  const [label, close] = h.toast.children;
  for (const language of ['en', 'zh-TW', 'ja', 'zh-CN']) {
    h.language(language);
    const t = h.createTranslator(language);
    assert.equal(h.toast.hidden, false);
    assert.equal(h.toast.children[0], label);
    assert.equal(h.toast.children[1], close);
    assert.equal(label.textContent, t('libraryChangeUnknown'));
    assert.equal(close.attributes['aria-label'], t('exportJobDismiss'));
  }
  assert.equal(h.timerStarts, 0, 'errors remain until explicitly dismissed');
  close.listeners.click();
  h.language('en');
  assert.equal(h.toast.hidden, true);
  assert.equal(h.toast.children.length, 0, 'language changes cannot revive dismissed errors');
});

test('success parameters retranslate but the original expiry does not restart', async () => {
  const h = await harness(), values = { count: 3 };
  h.context.showToast('messagesCount', false, values);
  values.count = 99;
  h.advance(1700);
  h.language('en');
  assert.equal(h.toast.children[0].textContent, h.createTranslator('en')('messagesCount', { count: 3 }));
  assert.equal(h.timerStarts, 1);
  h.advance(699); assert.equal(h.toast.hidden, false);
  h.advance(1); assert.equal(h.toast.hidden, true);
  h.language('ja'); assert.equal(h.toast.children.length, 0);
});

test('replacement cancels the old success timer and closing removes all notice state', async () => {
  const h = await harness();
  h.context.showToast('favoriteAdded'); h.advance(1000);
  h.context.showToast('libraryChangeUnknown', true);
  assert.equal(h.timers.size, 0);
  h.advance(5000); assert.equal(h.toast.hidden, false);
  h.context.dismissToast(); h.language('en');
  assert.equal(h.toast.hidden, true);
  assert.equal(h.toast.children.length, 0);
});

test('page-session retirement prevents late notices and never restores an old error', async () => {
  const h = await harness();
  h.context.showToast('libraryChangeUnknown', true);
  h.ready(false); h.language('en');
  assert.equal(h.toast.hidden, true);
  h.context.showToast('favoriteAdded');
  assert.equal(h.toast.hidden, true); assert.equal(h.timers.size, 0);
  h.ready(true); h.language('ja');
  assert.equal(h.toast.children.length, 0);
  const retirement = source.slice(source.indexOf('function handlePageSession('), source.indexOf('function syncRouteActivity('));
  assert.match(retirement, /if \(next\.phase !== "ready"\)[\s\S]*?dismissToast\(\)/);
  const lifecycle = fs.readFileSync("src/app/sidepanel/panel-lifecycle.js", "utf8");
  assert.match(lifecycle, /function dispose\(\)[\s\S]*?dismissNotice\(\)/);
  assert.match(lifecycle, /listen\(window, "pagehide", dispose, \{ once: true \}\)/);
  assert.match(source, /dismissNotice: dismissToast/);
});
