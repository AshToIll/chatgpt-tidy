const test = require('node:test');
const assert = require('node:assert/strict');
const { nativeKeyDownParams } = require('../tools/browser-fixture.cjs');

test('native Enter includes carriage-return text for Chromium default activation', () => {
  assert.deepEqual(nativeKeyDownParams({ key: 'Enter', code: 'Enter', vk: 13 }), {
    key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, text: '\r', unmodifiedText: '\r',
  });
});

test('non-character keys keep their prior protocol without injecting text', () => {
  for (const [key, code, vk] of [['Escape', 'Escape', 27], ['Backspace', 'Backspace', 8], ['Tab', 'Tab', 9]]) {
    assert.deepEqual(nativeKeyDownParams({ key, code, vk }), { key, code, windowsVirtualKeyCode: vk, modifiers: 0 });
  }
});

test('native keyboard modifiers remain unchanged', () => {
  const result = nativeKeyDownParams({ key: 'Enter', code: 'Enter', vk: 13, modifiers: 8 });
  assert.equal(result.modifiers, 8);
  assert.equal(result.text, '\r');
});
