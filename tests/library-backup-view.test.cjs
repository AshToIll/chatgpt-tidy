const test = require('node:test'), assert = require('node:assert/strict');
const modules = Promise.all([import('../src/features/settings/ui/library-backup-view.js'), import('../src/messages/i18n.js')]);

// Exercise the real view's handlers without a file picker, browser account, or real saved data.
async function harness({ ready = true, request = async () => ({}), connectionError = null, noticeShown = false } = {}) {
  const [{ createLibraryBackupView }, { createTranslator }] = await modules;
  const nodes = new Map(), token = { accountKey: 'synthetic-owner' }, calls = [], toasts = [];
  const el = name => {
    if (!nodes.has(name)) nodes.set(name, { hidden: false, disabled: false, textContent: '', value: '', listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute() {}, focus() {}, click() {} });
    return nodes.get(name);
  };
  const root = { innerHTML: '', querySelector: selector => el(selector.match(/data-backup-([^\]]+)/)[1]), querySelectorAll: () => [] };
  let reconnects = 0, checks = 0;
  const view = createLibraryBackupView({ root, translate: createTranslator('zh-CN'),
    captureOwner: () => ready ? token : null, isCurrent: value => value === token,
    request: async (action, ...args) => { calls.push(action); return request(action, ...args); },
    onRestored() {}, toast: (...args) => toasts.push(args), download: async () => true, connection: () => ({ error: connectionError, noticeShown }),
    reconnect: async () => { reconnects++; ready = true; }, checkLibrary: () => checks++,
  });
  view.setActive(true);
  return { view, el, calls, toasts, get reconnects() { return reconnects; }, get checks() { return checks; },
    click: name => el(name).listeners.click(),
    async file(file) { await el('choose').listeners.click(); el('file').files = [file]; await el('file').listeners.change(); },
  };
}

test('an unverified account is connecting, not falsely logged out', async () => {
  const h = await harness({ ready: false });
  assert.equal(h.el('status').textContent, '正在连接 ChatGPT…');
  assert.equal(h.el('retry').hidden, true); assert.equal(h.el('export').disabled, true);
});
test('connection failure offers a nearby reconnect that actually reloads the account', async () => {
  const h = await harness({ ready: false, connectionError: Error('secret internal detail') });
  assert.equal(h.el('status').textContent, '连接中断，请重连');
  assert.equal(h.el('retry').hidden, false); assert.equal(h.el('retry').textContent, '重新连接');
  await h.click('retry'); assert.equal(h.reconnects, 1);
  assert.equal(h.el('status').hidden, true); assert.equal(h.el('export').disabled, false);
});
test('shared page refresh notice replaces the backup connection message and useless retry', async () => {
  const h = await harness({ ready: false, connectionError: Error('missing page receiver'), noticeShown: true });
  assert.equal(h.el('status').hidden, true); assert.equal(h.el('retry').hidden, true);
  assert.equal(h.el('export').disabled, true); assert.equal(h.el('choose').disabled, true);
  assert.equal(h.reconnects, 0);
});
test('too large, unreadable and unsupported files have distinct next steps without raw exceptions', async () => {
  for (const [file, code, expected] of [
    [{ name: 'large.json', size: Number.MAX_SAFE_INTEGER }, null, '文件太大，请换文件'],
    [{ name: 'failed.json', size: 1, text: async () => { throw Error('FileReader private detail'); } }, null, '文件未读到，请重选'],
    [{ name: 'version.json', size: 1, text: async () => '{}' }, 'BACKUP_VERSION', '备份不支持，请换文件'],
  ]) {
    const h = await harness({ request: async () => { throw Object.assign(Error('private detail'), { code }); } });
    await h.file(file); assert.equal(h.el('status').textContent, expected);
    assert.equal(h.el('choose').disabled, false); assert.equal(h.el('retry').hidden, true);
  }
});
test('unknown restore offers inspection, never repeats a possibly completed restore', async () => {
  const h = await harness({ request: async action => {
    if (action === 'preview') return { id: 'preview', summary: { favorites: { added: 1, skipped: 0 }, bookmarks: { added: 0, skipped: 0 } } };
    if (action === 'restore') throw Error('lost response');
  } });
  await h.file({ name: 'test.json', size: 2, text: async () => '{}' }); await h.click('confirm');
  assert.equal(h.el('status').textContent, '结果未明，先核对');
  assert.equal(h.el('retry').hidden, false); assert.equal(h.el('retry').textContent, '查看资料');
  await h.click('retry'); assert.equal(h.checks, 1); assert.deepEqual(h.calls, ['preview', 'restore']);
});

test('backup success delegates message keys to the single live-language toast boundary', async () => {
  const h = await harness({ request: async action => action === 'preview'
    ? { id: 'preview', summary: { favorites: { added: 1, skipped: 0 }, bookmarks: { added: 0, skipped: 0 } } }
    : {} });
  await h.click('export');
  await h.file({ name: 'test.json', size: 2, text: async () => '{}' });
  await h.click('confirm');
  assert.deepEqual(h.toasts, [['backupDownloadStarted'], ['backupRestored']]);
});
