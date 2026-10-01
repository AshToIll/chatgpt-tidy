import { createLibraryBackupView, downloadLibraryBackup } from '../../src/features/settings/ui/library-backup-view.js';
import { createLibraryBackupService } from '../../src/features/settings/background/library-backup-service.js';
import { createLibraryBackupRepository } from '../../src/features/settings/storage/library-backup.js';
import { createFavoritesRepository } from '../../src/features/favorites/storage/favorites.js';
import { normalizeFavoritesState, createEmptyFavoritesState } from '../../src/features/favorites/storage/favorites-domain.js';
import { normalizeBookmarksState, createEmptyBookmarksState } from '../../src/features/bookmarks/storage/bookmarks-domain.js';
import { serializeLibraryBackup } from '../../src/features/settings/storage/library-backup-domain.js';
import { createTranslator } from '../../src/messages/i18n.js';
import '../../src/platform/theme/theme.js';

// 原生 File、IndexedDB、按钮、Blob 与生产模块；账号、Worker 传输及 downloads API 使用合成替身。
// 不连接真实 ChatGPT、不读取用户扩展资料、不实际保存下载文件。
const checks = [], requests = [], toasts = [], notices = [], root = document.querySelector('#library-backup');
const el = name => root.querySelector(`[data-backup-${name}]`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw Error(message); };
const same = (a, b, message) => assert(a === b, `${message}: ${a} !== ${b}`);
const check = async (name, run) => { try { await run(); checks.push({ name, ok: true }); } catch (error) { checks.push({ name, ok: false, error: error.stack }); throw error; } };
const wait = async read => { for (let i = 0; i < 250; i++) { if (read()) return; await sleep(10); } throw Error('Fixture state timed out'); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
let inputSequence = 0, inputDone;
globalThis.completeFixtureInput = id => {
  same(globalThis.fixtureInputRequest?.id, id, 'Native input receipt'); globalThis.fixtureInputRequest = null; inputDone();
};
const key = (key, code, vk) => new Promise(resolve => {
  inputDone = resolve; globalThis.fixtureInputRequest = { id: ++inputSequence, kind: 'key', key, code, vk };
});
const owner = { accountKey: '["fixture-user","personal"]', generation: 1, tab: { id: 31 }, identity: { documentId: 'fixture', epoch: 1 } };
let currentOwner = null, translator = createTranslator('zh-CN'), gate = null, failRestore = false, clock = Date.now();
const current = token => Boolean(token && currentOwner && token.accountKey === currentOwner.accountKey && token.generation === currentOwner.generation);
const repository = createLibraryBackupRepository(), favorites = createFavoritesRepository();
const assertCurrent = context => { if (!current(context)) throw Object.assign(Error('stale'), { code: 'CONTEXT_MISMATCH' }); };
const service = createLibraryBackupService({ repository, assertCurrent, notify: (kind, value) => notices.push({ kind, revision: value.revision }), now: () => clock });
const downloads = [], downloadListeners = new Set();
let saveGate = null, saveError = null;
const downloadApi = {
  download: async options => {
    const record = { ...options, value: await (await fetch(options.url)).json() };
    downloads.push(record);
    if (saveGate) await saveGate.promise;
    if (saveError) throw Error(saveError);
    return downloads.length;
  },
  search: async ({ id }) => [{ id, state: 'complete' }],
  onChanged: { addListener: fn => downloadListeners.add(fn), removeListener: fn => downloadListeners.delete(fn) },
};
const view = createLibraryBackupView({ root, captureOwner: () => currentOwner, isCurrent: current,
  // 备份只提交文案键；实际通知节点及切语言重绘由完整 panel 夹具验证。
  translate: (...args) => translator(...args), toast: (key, error = false, values = {}) => toasts.push({ key, error, values }), onRestored: () => {},
  download: value => downloadLibraryBackup(value, { downloads: downloadApi }),
  request: async (action, payload, context) => {
    requests.push(action);
    if (gate && action === gate.action) await gate.promise;
    if (action === 'restore' && failRestore) throw Error('injected storage failure');
    return action === 'export' ? service.exportBackup(context)
      : action === 'preview' ? service.preview(context, payload.text)
        : action === 'restore' ? service.restore(context, payload.previewId) : service.discard(context, payload.previewId);
  },
});
// 文件由原生 File/DataTransfer 注入；不打开无法在无头浏览器中关闭的系统选文件窗口。
el('file').addEventListener('click', event => event.preventDefault());
const NOW = '2026-09-19T12:00:00.000Z';
const sample = {
  favorites: normalizeFavoritesState({ ...createEmptyFavoritesState(), items: { first: { conversationId: 'first', routePath: '/c/first',
    savedAt: NOW, title: 'Sample conversation', note: 'Private sample note', groupId: 'study' } } }),
  bookmarks: normalizeBookmarksState({ ...createEmptyBookmarksState(), items: { 'first::message': { conversationId: 'first', messageId: 'message',
    bookmarkId: 'first::message', routePath: '/c/first', bookmarkedAt: NOW, excerpt: 'Sample excerpt', note: 'Sample bookmark note', groupId: 'bookmark-quote' } } }),
};
const text = serializeLibraryBackup(owner.accountKey, sample, NOW);
function assertSummary(favorites, bookmarks, skipped) {
  same(el('counts').textContent, translator('backupCounts', { favorites, bookmarks }), 'Wrong added counts');
  same(el('skipped').textContent, translator('backupSkipped', { count: skipped }), 'Wrong skipped count');
  assert(!el('counts').hidden && !el('skipped').hidden, 'Zero count must remain visible');
  same(el('preview').querySelectorAll(':scope > p').length, 3, 'Only filename and two summary lines should remain');
  same(el('groups'), null, 'Extra group explanation retained');
}
async function selectFile(content = text, name = 'TIDY-library.json') {
  el('choose').click();
  const transfer = new DataTransfer(); transfer.items.add(new File([content], name, { type: 'application/json' }));
  el('file').files = transfer.files; el('file').dispatchEvent(new Event('change', { bubbles: true }));
  await wait(() => !el('choose').disabled);
}
try {
  view.setActive(true);
  await check('unverified account cannot start backup or restore', async () => {
    assert(el('export').disabled && el('choose').disabled, 'Unowned buttons enabled');
    same(requests.length, 0, 'Unowned view made requests');
    currentOwner = owner; view.update(); assert(!el('choose').disabled, 'Verified owner not enabled');
  });
  await check('file picker previews without writing; filename is rendered as text', async () => {
    await selectFile(text, '<img onerror=alert(1)>.json');
    assert(!el('preview').hidden, 'Preview missing'); same(root.querySelectorAll('img').length, 0, 'Filename became HTML');
    assert(el('counts').textContent.includes('1 个收藏'), 'Favorite count missing');
    assertSummary(1, 1, 0);
    same(Object.keys((await repository.read(owner.accountKey, () => {})).favorites.items).length, 0, 'Preview wrote items');
    same(document.activeElement, el('confirm'), 'Confirmation was not focused');
  });
  await check('native keyboard confirms one atomic restoration and success is a toast, not a sticky card', async () => {
    await key(' ', 'Space', 32); await wait(() => el('preview').hidden);
    const state = await repository.read(owner.accountKey, () => {});
    same(state.favorites.items.first.note, 'Private sample note', 'Favorite missing');
    same(state.bookmarks.items['first::message'].excerpt, 'Sample excerpt', 'Bookmark missing');
    same(notices.length, 2, 'Both commit notifications required');
    same(toasts.at(-1).key, 'backupRestored', 'Success toast missing'); same(toasts.at(-1).error, false, 'Restore success is not an error'); same(el('status').hidden, true, 'Sticky success card');
    same(document.activeElement, el('choose'), 'Focus not restored');
  });
  await check('repeated import reports skipped entries; cancel and route leave discard confirmation', async () => {
    await selectFile(); assert(el('counts').textContent.includes('0 个收藏'), 'Duplicate is scheduled as new');
    assert(el('skipped').textContent.includes('2'), 'Duplicates not reported');
    assertSummary(0, 0, 2);
    const before = requests.filter(action => action === 'restore').length;
    el('cancel').click(); same(el('preview').hidden, true, 'Cancel retained preview');
    await selectFile(); view.setActive(false); view.setActive(true);
    same(el('preview').hidden, true, 'Route leave retained preview');
    same(requests.filter(action => action === 'restore').length, before, 'Cancel restored data');
  });
  await check('partial and empty backups use the same two summary lines including zero counts', async () => {
    const partial = JSON.parse(text);
    partial.favorites.items.push({ ...partial.favorites.items[0], conversationId: 'second', routePath: '/c/second', title: 'Second' });
    await selectFile(JSON.stringify(partial)); assertSummary(1, 0, 2); el('cancel').click();
    const empty = serializeLibraryBackup(owner.accountKey, { favorites: createEmptyFavoritesState(), bookmarks: createEmptyBookmarksState() }, NOW);
    await selectFile(empty); assertSummary(0, 0, 0); el('cancel').click();
  });
  await check('invalid file and wrong workspace have actionable errors and no confirm action', async () => {
    await selectFile('{'); same(el('status').textContent, translator('backupInvalid'), 'Invalid file not explained'); assert(el('preview').hidden, 'Invalid preview shown');
    const wrong = JSON.parse(text); wrong.accountKey = '["fixture-user","other-workspace"]';
    await selectFile(JSON.stringify(wrong)); same(el('status').textContent, translator('backupAccountMismatch'), 'Wrong owner not explained');
    assert(el('preview').hidden, 'Wrong owner allowed confirmation');
  });
  await check('concurrent edits require a fresh preview and never overwrite the current note', async () => {
    await selectFile();
    await favorites.transact(owner.accountKey, state => ({ ...state, revision: state.revision + 1,
      items: { ...state.items, first: { ...state.items.first, note: 'Keep my changed note' } } }));
    el('confirm').click(); await wait(() => !el('choose').disabled);
    same(el('status').textContent, translator('backupChanged'), 'Stale confirmation not rejected');
    same((await repository.read(owner.accountKey, () => {})).favorites.items.first.note, 'Keep my changed note', 'Concurrent edit overwritten');
  });
  await check('one busy restore cannot be clicked twice; a failure never claims success', async () => {
    await selectFile(); gate = { action: 'restore', ...deferred() }; failRestore = true;
    const successes = toasts.length, before = requests.filter(action => action === 'restore').length;
    el('confirm').click(); el('confirm').click(); same(requests.filter(action => action === 'restore').length, before + 1, 'Double submit');
    assert(el('choose').disabled && el('confirm').disabled, 'Busy buttons enabled');
    gate.resolve(); gate = null; await wait(() => !el('checked').hidden); failRestore = false;
    assert(el('choose').disabled && el('confirm').disabled, 'Unknown restore must keep duplicate import locked');
    same(toasts.length, successes, 'Failed restore claimed success'); same(el('status').textContent, translator('backupRestoreFailed'), 'Failure has no recovery instruction'); assert(!el('retry').hidden && !el('retry').disabled, 'Unknown restore has no inspection action'); same(el('retry').textContent, translator('backupCheckLibrary'), 'Recovery action differs from its label');
    const submitted = requests.filter(action => action === 'restore').length;
    el('checked').click();
    assert(!el('choose').disabled && el('checked').hidden, 'Only explicit confirmation releases the unknown restore lock');
    same(requests.filter(action => action === 'restore').length, submitted, 'Checking the result replayed restoration');
    same(toasts.length, successes, 'Checking the result claimed success');
  });
  await check('account switch suppresses a delayed preview and leaves no private filename', async () => {
    gate = { action: 'preview', ...deferred() };
    const selected = selectFile(); await wait(() => requests.at(-1) === 'preview' && el('choose').disabled);
    currentOwner = { ...owner, accountKey: '["fixture-other","personal"]', generation: 2 }; view.update();
    assert(el('preview').hidden, 'Preview crossed account'); same(el('filename').textContent, '', 'Filename crossed account');
    gate.resolve(); gate = null; await selected; await sleep(20); assert(el('preview').hidden, 'Late preview revived');
    currentOwner = owner; view.update();
  });
  await check('Save As receives the complete account-local Blob backup, without claiming saved', async () => {
    const before = downloads.length;
    el('export').click(); await wait(() => !el('export').disabled);
    same(downloads.length, before + 1, 'No download API call');
    const { value, saveAs, filename } = downloads.at(-1);
    same(saveAs, true, 'Save chooser not requested'); assert(filename.endsWith('.json'), 'Backup filename missing');
    same(value.accountKey, owner.accountKey, 'Wrong backup owner'); same(value.favorites.items[0].note, 'Keep my changed note', 'Download lost data');
    same(toasts.at(-1).key, 'backupDownloadStarted', 'Download incorrectly claimed saved');
    same(downloadListeners.size, 0, 'Completed download retained listeners');
  });
  await check('pending Save As disables duplicate actions, even after leaving settings; cancel is quiet', async () => {
    const before = downloads.length, successes = toasts.length;
    saveGate = deferred(); saveError = 'Download canceled'; el('export').click();
    await wait(() => downloads.length === before + 1);
    same(toasts.length, successes, 'Pending chooser claimed success');
    assert(el('export').disabled && el('choose').disabled, 'Busy buttons enabled');
    el('export').click(); view.setActive(false); view.setActive(true); el('export').click();
    same(downloads.length, before + 1, 'Second save window opened');
    saveGate.resolve(); saveGate = null; await wait(() => !el('export').disabled); saveError = null;
    same(toasts.length, successes, 'Cancelled save claimed success'); assert(el('status').hidden, 'Cancellation displayed an error');
    same(downloadListeners.size, 0, 'Cancelled download retained listeners');
  });
  await check('Save As failure offers retry without a success toast', async () => {
    const before = toasts.length; saveError = 'File access denied';
    el('export').click(); await wait(() => !el('export').disabled); saveError = null;
    same(toasts.length, before, 'Failure claimed success'); assert(el('status').textContent.includes('重试'), 'Missing save error');
  });
  await check('account switch while the chooser is open suppresses its late toast', async () => {
    const before = downloads.length, successes = toasts.length;
    saveGate = deferred(); el('export').click(); await wait(() => downloads.length === before + 1);
    currentOwner = { ...owner, accountKey: '["fixture-other","personal"]', generation: 2 }; view.update();
    saveGate.resolve(); saveGate = null; await wait(() => !el('export').disabled);
    same(toasts.length, successes, 'Old account save toast crossed owner'); currentOwner = owner; view.update();
  });
  await check('a delayed export cannot download after the owner changes', async () => {
    const before = toasts.length, count = downloads.length;
    gate = { action: 'export', ...deferred() }; el('export').click();
    currentOwner = null; view.update(); gate.resolve(); gate = null; await sleep(30);
    same(downloads.length, count, 'Stale download started'); same(toasts.length, before, 'Stale success shown');
    currentOwner = owner; view.update();
  });
  await check('all four languages and both appearances retain controls, focus and preview state', async () => {
    await selectFile(); const button = el('confirm'), input = el('file'); button.focus();
    for (const [language, label] of Object.entries({ en: 'Import backup', ja: 'バックアップを読み込む', 'zh-TW': '匯入備份', 'zh-CN': '导入备份' })) {
      translator = createTranslator(language); view.update(); same(document.activeElement, button, 'Language reset focus');
      assertSummary(0, 0, 2);
      same(el('choose').textContent, label, 'Import action is not named clearly'); same(input.getAttribute('aria-label'), label, 'Input label differs');
      assert(!el('preview').hidden && button === el('confirm') && input === el('file'), 'Language replaced controls');
      assert(!root.textContent.includes('backupConfirm'), 'Missing translated label');
    }
    for (const scheme of ['light', 'dark']) {
      const theme = TidyTheme.NATIVE_APPEARANCE_TOKENS[scheme];
      for (const [css, key] of [['--surface', 'surface'], ['--surface-subtle', 'surfaceSubtle'], ['--text-primary', 'textPrimary'],
        ['--text-secondary', 'textSecondary'], ['--border', 'border']]) document.documentElement.style.setProperty(css, theme[key]);
      document.documentElement.dataset.nativeColorScheme = scheme;
      const rgb = hex => `rgb(${[1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16)).join(', ')})`;
      same(getComputedStyle(el('preview')).backgroundColor, rgb(theme.surfaceSubtle), 'Wrong preview surface');
      same(getComputedStyle(el('choose')).backgroundColor, rgb(theme.surface), 'Wrong button surface');
      assert(root.scrollWidth <= root.clientWidth, 'Backup layout overflows'); same(document.activeElement, button, 'Theme reset focus');
    }
  });
} catch (error) {
  if (!checks.some(check => !check.ok)) checks.push({ name: 'initialization', ok: false, error: error.stack });
} finally {
  const result = document.querySelector('#results');
  result.textContent = JSON.stringify({ ok: checks.every(check => check.ok), checks,
    scope: 'Isolated Chromium, production modules and native IndexedDB; synthetic accounts, no installed extension or live ChatGPT acceptance' });
  result.dataset.complete = 'true';
}
