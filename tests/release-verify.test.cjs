const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyChild, browserChecks, sourceFingerprint, childTimeout } = require('../tools/verify-release.cjs');

test('release browser gate requires both successful process and explicit successful receipt', () => {
  const pass = { status: 0, stdout: '{"ok":true}' };
  assert.equal(classifyChild(pass, true).ok, true);
  for (const patch of [{ status: 1 }, { signal: 'SIGTERM' }, { error: Error('spawn failed') },
    { stdout: '' }, { stdout: '{}' }, { stdout: '{"ok":false}' }, { stdout: 'not JSON' }]) {
    assert.equal(classifyChild({ ...pass, ...patch }, true).ok, false);
  }
  assert.equal(classifyChild({ status: 0 }, false).ok, true);
  assert.equal(classifyChild({ status: null }, false).ok, false);
});

test('release gate explicitly retains toolbar theme, keyboard, panel, lifecycle, physical geometry and both sidebar fixtures', () => {
  assert.deepEqual(browserChecks.map(([name]) => name), ['page-session', 'toolbar-theme', 'export-jobs', 'export-images', 'export-keyboard', 'panel-current-protocol', 'library-lifecycle',
    'library-backup', 'panel-theme', 'bookmark-theme', 'message-landing', 'sidebar-navigation', 'native-sidebar-navigation']);
});

test('release evidence fingerprints actual source-candidate inputs deterministically', () => {
  const before = sourceFingerprint();
  assert.match(before, /^[a-f0-9]{64}$/);
  assert.equal(sourceFingerprint(), before);
});

test('source cleanup audits have a bounded budget without widening browser deadlines', () => {
  assert.equal(childTimeout(false), 600000);
  assert.equal(childTimeout(true), 180000);
});
