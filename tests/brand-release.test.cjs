const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('public name and current release agree across the package and extension', () => {
  const manifest = JSON.parse(read('src/manifest.json'));
  assert.equal(manifest.version, '0.5.1');
  assert.equal(JSON.parse(read('package.json')).version, manifest.version);
  for (const locale of ['en', 'ja', 'zh_CN', 'zh_TW']) {
    const messages = JSON.parse(read(`src/_locales/${locale}/messages.json`));
    assert.equal(messages.appName.message, 'ChatGPT Tidy', locale);
    assert.ok(messages.actionTitle.message.includes('ChatGPT Tidy'), locale);
  }
  assert.match(read('src/app/sidepanel/index.html'), /<title>ChatGPT Tidy<\/title>/);
});

test('UI translations use the public name without renaming persisted contracts', () => {
  // 品牌改名不迁移数据库或消息协议；避免把外观更新变成数据兼容改造。
  const entries = [...read('src/messages/i18n.js').matchAll(/appName:\s*"([^"]+)"/g)];
  assert.equal(entries.length, 4);
  for (const entry of entries) assert.equal(entry[1], 'ChatGPT Tidy');
  assert.match(read('src/platform/protocol.js'), /chatgpt-tidy\.window\.v1/);
  assert.match(read('src/platform/storage/schema.js'), /chatgpt-tidy-storage/);
});
