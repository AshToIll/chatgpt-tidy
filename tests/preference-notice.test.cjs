const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { createPanelRuntime } = require("./helpers/panel-runtime.cjs");
function harness(error) {
  const root = { children: [], replaceChildren(...children) { this.children = children; } };
  const state = { moduleErrors: { preferences: error } }; let reads = 0;
  const runtime = createPanelRuntime({
    document: { getElementById: () => root, createElement: tag => ({ tag, listeners: {},
      addEventListener(event, callback) { this.listeners[event] = callback; } }) },
  });
  const { createShellPresentation } = runtime.load("src/app/sidepanel/shell-presentation.js");
  const shell = createShellPresentation({ elements: {}, translate: key => key, document: runtime.context.document });
  const render = () => shell.renderPreferenceNotice({ error: state.moduleErrors.preferences, onRetry: async () => reads++ });
  render();
  return { root, state, get reads() { return reads; }, render };
}
test('settings read failure provides a nearby button that only rereads saved settings', async () => {
  const h = harness({ messageKey: 'preferenceReadFailed', retryable: true });
  assert.equal(h.root.hidden, false); assert.equal(h.root.children[0].textContent, 'preferenceReadFailed');
  const button = h.root.children[1]; assert.equal(button.textContent, 'retry');
  await button.listeners.click(); assert.equal(h.reads, 1); assert.equal(button.disabled, false);
});
test('an invalidated panel explains reopening instead of offering an ineffective read', () => {
  const h = harness({ messageKey: 'reopenTidyPanel', retryable: false });
  assert.equal(h.root.children.length, 1); assert.equal(h.root.children[0].textContent, 'reopenTidyPanel');
  assert.equal(h.reads, 0);
});
test('a confirmed settings read removes the notice and its recovery button', () => {
  const h = harness({ messageKey: 'preferenceSaveUnknown', retryable: true });
  h.state.moduleErrors.preferences = null; h.render();
  assert.equal(h.root.hidden, true); assert.equal(h.root.children.length, 0);
});
