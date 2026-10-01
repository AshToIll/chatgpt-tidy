import { DEFAULT_PREFERENCES, PREFERENCES_KEY } from '../../src/platform/preferences/preferences.js';
import { createTranslator } from '../../src/messages/i18n.js';
import { normalizeTitleRules } from '../../src/features/titles/model/title-rules.js';
import { createEmptyFavoritesState, upsertFavoriteFromSnapshot } from '../../src/features/favorites/storage/favorites-domain.js';
import { createEmptyBookmarksState, addBookmarkFromSnapshot } from '../../src/features/bookmarks/storage/bookmarks-domain.js';

// This test imports the COMPLETE production panel, including its real module
// views, event handlers and navigation controller. Worker IPC and the bound-tab
// URL are synthetic. DOM clicks and scroll-retention assertions are real; this
// does not exercise the worker or prove message landing in a live ChatGPT tab.
const protocol = globalThis.TidyProtocol, checks = [], requests = [], errors = [], unexpected = [], runtimeListeners = [];
const storageListeners = [];
// Diagnostics has its own validated transport lane, never a business request.
const diagnosticRequests = [], diagnosticGeneration = "00000000000000000000000000000001";
const chat = document.getElementById('qa-chat'), output = document.getElementById('qa-results');
const clone = value => structuredClone(value), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
const equal = (actual, expected, label) => assert(actual === expected, `${label}: ${actual} !== ${expected}`);
const field = value => ({ value, status: 'available', source: 'synthetic-fixture' });
let preferences = { ...DEFAULT_PREFERENCES, language: 'zh-CN', timeZone: 'UTC' }, networkAttempts = 0, snapshotRevision = 0;
let openGate = null;
let libraryGate = null;
let preferenceGate = null, preferenceFailure = false;
let loseFavoriteWriteReceipt = false, pageProbeGate = null;
const cancelled = new Set();
let owner = 'fixture-owner', identityEpoch = 0;
let documentId = 'fixture-document', documentSequence = 0, nextOpenHandoff = null;
let pageRuntimeAvailable = false, storedTitleRules = normalizeTitleRules(null, preferences);
function snapshot(id = 'fixture-chat') {
  return { schemaVersion: TidySnapshot.VERSION, capturedAt: new Date().toISOString(),
    route: { pathname: `/c/${id}`, href: `https://chatgpt.com/c/${id}`, kind: 'conversation', status: 'available' },
    appearance: { colorScheme: 'light', status: 'available', source: 'fixture', surface: field('rgb(255, 255, 255)') },
    conversation: { conversationId: id, kind: 'conversation', bindingStatus: 'bound', identityStatus: 'stable',
      draftId: null, title: field('Synthetic chat'), createdAt: field('2026-09-01T00:00:00.000Z'),
      updatedAt: field('2026-09-12T00:00:00.000Z'), project: null },
    sidebarConversations: [], messages: Array.from({ length: 12 }, (_, index) => ({
      messageId: `message-${index}`, role: index % 2 ? 'assistant' : 'user', idStatus: 'stable', presentationStatus: 'formal',
      timestamp: field('2026-09-12T00:00:00.000Z'), excerpt: field(`Synthetic message ${index} revision ${snapshotRevision}`),
      order: { index: index + 1, displayNumber: index + 1 }, locator: { strategy: 'data-message-id', value: `message-${index}` },
    })) };
}
let currentSnapshot = snapshot();
function library() {
  let favorites = upsertFavoriteFromSnapshot(createEmptyFavoritesState(), currentSnapshot);
  let bookmarks = createEmptyBookmarksState();
  for (const index of [1, 4, 7]) bookmarks = addBookmarkFromSnapshot(bookmarks, currentSnapshot, `message-${index}`);
  const accountKey = JSON.stringify([owner, 'personal']);
  favorites.accountKey = bookmarks.accountKey = accountKey;
  return { accountKey, identity: { documentId, epoch: identityEpoch }, favorites, bookmarks,
    errors: { favorites: null, bookmarks: null } };
}
let stored = library();
chat.innerHTML = currentSnapshot.messages.map(message => `<article id="${message.messageId}">${message.excerpt.value}</article>`).join('');
const event = (type, payload) => {
  // Worker route notifications identify the current browser document. SPA
  // changes retain it; full navigations replace documentId before publishing.
  if (type === protocol.Type.CONTEXT_CHANGED) payload = { documentId, ...payload };
  runtimeListeners.forEach(listener => listener(protocol.event(type, payload)));
};
const storageEvent = () => storageListeners.forEach(listener => listener({ [PREFERENCES_KEY]: { newValue: clone(preferences) } }, 'sync'));
const updateSnapshot = () => { snapshotRevision++; currentSnapshot = snapshot(currentSnapshot.conversation.conversationId); event(protocol.Type.SNAPSHOT_UPDATED, { tabId: 31, snapshot: clone(currentSnapshot) }); };
function count(type) { return requests.filter(request => request.type === type).length; }
function dock(route) {
  const button = document.querySelector(`[data-route="${route}"]`); assert(button, `Missing ${route} Dock`); button.click();
}
function bookmark(index, conversationId = currentSnapshot.conversation.conversationId) {
  const button = [...document.querySelectorAll('[data-bookmark-jump]')].find(element => element.dataset.bookmarkJump === `${conversationId}::message-${index}`);
  assert(button, `Missing bookmark message-${index}`); button.click();
}
function defer() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate, label) { for (let attempt = 0; attempt < 80; attempt++) { if (predicate()) return; await sleep(20); } throw new Error(label); }
globalThis.addEventListener('error', event => errors.push(event.error?.stack || event.message));
globalThis.addEventListener('unhandledrejection', event => errors.push(event.reason?.stack || String(event.reason)));
globalThis.fetch = () => { networkAttempts++; throw new Error('Network is prohibited in this synthetic fixture'); };
// Transport-only fixture for the COMPLETE production panel. It nominates
// Worker receipts; it does not implement a second worker or claim real target
// location. Physical geometry is covered by bookmark-landing-browser separately.
const toast = () => document.getElementById('toast');
function complete(open, patch = {}) {
  const item = stored.bookmarks.items[open.payload.bookmarkId];
  event(protocol.Type.NAVIGATION_RESULT, { tabId: 31,
    navigationIntentId: open.payload.navigationIntentId,
    conversationId: item.conversationId, messageId: item.messageId,
    located: true, highlighted: false, reason: null, ...patch });
}
const latestOpen = () => requests.filter(request => request.type === protocol.Type.BOOKMARKS_OPEN).at(-1);
globalThis.chrome = {
  runtime: { id: 'synthetic-extension', lastError: null,
    getURL: relative => new URL(`../../src/${relative}`, import.meta.url).href,
    onMessage: { addListener: listener => runtimeListeners.push(listener) },
    connect: () => ({ postMessage() {}, disconnect() {}, onDisconnect: { addListener() {} } }),
    async sendMessage(envelope) {
      if (envelope.channel === 'tidy.diagnostics.v1') {
        const wire = globalThis.TidyDiagnosticsWire;
        assert(wire, 'Diagnostic handshake requires the real wire contract');
        const contract = wire.createContract({ buildInfo: ChatGPTTidyBuildInfo, registry: ChatGPTTidyNoticeRegistry,
          sanitizeCause: cause => ChatGPTTidyDiagnostics.cause(cause) });
        assert(contract.validRequest(envelope) && envelope.operation === 'record', 'Unexpected or unsafe diagnostic request');
        assert(envelope.generation === null || envelope.generation === diagnosticGeneration, 'Diagnostic generation changed unexpectedly');
        diagnosticRequests.push(clone(envelope));
        return { ok: true, persisted: true, generation: diagnosticGeneration, accepted: envelope.events.length };
      }
      requests.push({ type: envelope.type, payload: clone(envelope.payload) });
      let value;
      const bootstrapOrCancel = ['page-session.probe', protocol.Type.PREFERENCES_GET, protocol.Type.GET_ACTIVE_CONTEXT,
        protocol.Type.NAVIGATION_CANCELLED, protocol.Type.EXPORT_PREVIEW_CLOSE, protocol.Type.EXPORT_JOB_CANCEL,
        protocol.Type.LIBRARY_BACKUP_DISCARD].includes(envelope.type);
      if (!pageRuntimeAvailable && !bootstrapOrCancel) return protocol.failure(envelope, 'ADAPTER_UNAVAILABLE', 'Page runtime retired',
        { stage: 'service-worker.page-session', disconnect: 'receiver-missing', documentId });
      switch (envelope.type) {
        case 'page-session.probe':
          if (pageProbeGate) await pageProbeGate.promise;
          if (!pageRuntimeAvailable) return protocol.failure(envelope, 'ADAPTER_UNAVAILABLE', 'This existing page needs reload',
            { stage: 'service-worker.page-session', disconnect: 'receiver-missing', documentId });
          value = { ready: true, documentId }; break;
        case protocol.Type.GET_ACTIVE_CONTEXT: value = { tab: { id: 31, url: currentSnapshot.route.href }, snapshot: clone(currentSnapshot) }; break;
        case protocol.Type.LIBRARY_GET:
          if (libraryGate) await libraryGate.promise;
          value = clone(stored); break;
        case protocol.Type.EXPORT_JOB_STATUS:
          if (envelope.payload.expectedTabId !== 31 || envelope.payload.expectedAccountKey !== stored.accountKey) throw Error('Wrong export status owner');
          value = null; break; // 导航夹具没有活动导出任务；生成仍由独立扩展夹具验收。
        case protocol.Type.FAVORITES_TOGGLE_CURRENT: {
          assert(loseFavoriteWriteReceipt, 'Only the explicit lost-write-receipt scenario may mutate favorites');
          loseFavoriteWriteReceipt = false;
          assert(envelope.payload.expectedConversationId === currentSnapshot.conversation.conversationId
            && envelope.payload.expectedAccountKey === stored.accountKey, 'Unknown write used the wrong captured owner');
          // The synthetic worker commits once, then loses the acknowledgement.
          // The real request client/actions must classify uncertainty, refresh only, and never replay the write.
          stored.favorites = { ...upsertFavoriteFromSnapshot(stored.favorites, currentSnapshot), accountKey: stored.accountKey };
          return protocol.failure(envelope, protocol.ErrorCode.ADAPTER_TIMEOUT, 'Synthetic committed write acknowledgement lost',
            { stage: 'fixture.favorite-write-receipt' });
        }
        case protocol.Type.PREFERENCES_GET: value = clone(preferences); break;
        case protocol.Type.TITLE_RULES_GET: value = clone(storedTitleRules); break;
        case protocol.Type.TITLE_RULES_UPDATE: storedTitleRules = normalizeTitleRules({ ...storedTitleRules, ...envelope.payload }, preferences); value = clone(storedTitleRules); break;
        case protocol.Type.PREFERENCES_UPDATE: {
          if (preferenceFailure) { preferenceFailure = false; throw Error('Synthetic save failure'); }
          preferences = { ...preferences, ...envelope.payload }; value = clone(preferences);
          storageEvent(); event(protocol.Type.PREFERENCES_UPDATED, clone(preferences));
          const gate = preferenceGate; if (gate) await gate.promise;
          break;
        }
        case protocol.Type.BOOKMARKS_OPEN: {
          value = { ...clone(stored.bookmarks.items[envelope.payload.bookmarkId]),
            navigationIntentId: envelope.payload.navigationIntentId };
          const handoff = nextOpenHandoff; nextOpenHandoff = null;
          if (handoff) {
            const transition = async () => {
              const reads = count(protocol.Type.LIBRARY_GET);
              event(protocol.Type.LIBRARY_IDENTITY_CHANGED, { tabId: 31, documentId, epoch: ++identityEpoch,
                phase: 'unavailable', accountKey: null, transition: 'document-hidden' });
              const waiting = document.querySelector('#bookmarks-view > .library-state');
              assert(waiting, 'Departing page must clear private rows and show waiting');
              await sleep(20);
              equal(count(protocol.Type.LIBRARY_GET), reads, 'Do not read the departing page');
              documentId = `replacement-document-${++documentSequence}`; identityEpoch = 0;
              event(protocol.Type.LIBRARY_IDENTITY_CHANGED, { tabId: 31, documentId, epoch: identityEpoch, phase: 'unavailable', accountKey: null });
              equal(document.querySelector('#bookmarks-view > .library-state'), waiting, 'Destination transition must retain one waiting node');
              currentSnapshot = snapshot(value.conversationId);
              if (handoff === 'workspace-recheck') {
                currentSnapshot.conversation.bindingStatus = 'route-only';
                currentSnapshot.conversation.title = { value: null, status: 'missing' };
                currentSnapshot.messages = [];
              }
              stored.identity = { documentId, epoch: identityEpoch };
              event(protocol.Type.CONTEXT_CHANGED, { tabId: 31, url: currentSnapshot.route.href });
              event(protocol.Type.SNAPSHOT_UPDATED, { tabId: 31, snapshot: clone(currentSnapshot) }); await sleep(10);
              equal(document.querySelector('#bookmarks-view > .library-state'), waiting, 'Snapshots must not recreate the waiting message');
              event(protocol.Type.LIBRARY_IDENTITY_CHANGED, { tabId: 31, documentId, epoch: identityEpoch, phase: 'ready', accountKey: stored.accountKey });
              if (handoff === 'workspace-recheck') {
                // Live regression: early account ready -> route-only/empty target ->
                // workspace unconfirmed/restored -> ready again. None is a terminal OPEN result.
                const label = waiting.textContent;
                await sleep(40);
                equal(document.querySelector('#bookmarks-view > .library-state'), waiting, 'Early hydration must not expose an unfinished list');
                currentSnapshot = snapshot(value.conversationId); currentSnapshot.messages = [];
                event(protocol.Type.SNAPSHOT_UPDATED, { tabId: 31, snapshot: clone(currentSnapshot) });
                equal(document.querySelector('#bookmarks-view > .library-state'), waiting, 'A bound but empty target is not completed navigation');
                libraryGate = defer();
                for (const transition of ['workspace-unconfirmed', 'workspace-restored']) {
                  event(protocol.Type.LIBRARY_IDENTITY_CHANGED, { tabId: 31, documentId, epoch: ++identityEpoch,
                    phase: 'unavailable', accountKey: null, transition });
                  await sleep(20);
                  equal(document.querySelector('#bookmarks-view > .library-state'), waiting, 'Workspace checks retain the same waiting node');
                  equal(waiting.textContent, label, 'Workspace checks do not swap waiting wording');
                }
                stored.identity = { documentId, epoch: ++identityEpoch };
                event(protocol.Type.LIBRARY_IDENTITY_CHANGED, { tabId: 31, documentId, epoch: identityEpoch, phase: 'ready', accountKey: stored.accountKey });
                const gate = libraryGate; libraryGate = null; gate.resolve();
              }
              updateSnapshot();
            };
            if (handoff !== 'receipt-first') {
              try { await transition(); } catch (error) { errors.push(String(error)); throw error; }
              await sleep(40);
            }
            else setTimeout(() => { void transition().catch(error => errors.push(String(error))); }, 30);
          }
          const gate = openGate;
          if (gate) await gate.promise;
          break;
        }
        case protocol.Type.NAVIGATION_CANCELLED:
          cancelled.add(envelope.payload.navigationIntentId); value = { cancelled: true }; break;
        case protocol.Type.DATE_INDEX_ACCOUNT:
          return protocol.failure(envelope, 'DATE_INDEX_UNAVAILABLE', 'Synthetic catalog is offline');
        case protocol.Type.TITLE_PREVIEW:
        case protocol.Type.EXPORT_CURRENT_CONVERSATION:
          return protocol.failure(envelope, 'ADAPTER_UNAVAILABLE', 'Synthetic title/export metadata is offline');
        default: unexpected.push(envelope.type); throw new Error(`Unexpected runtime action ${envelope.type}`);
      }
      return protocol.response(envelope, value);
    },
  },
  storage: { onChanged: { addListener: listener => storageListeners.push(listener) }, sync: { get: (_key, callback) => callback({ [PREFERENCES_KEY]: clone(preferences) }) } },
};

export async function runPanelChecks() {
  const watchdog = setTimeout(() => {
    output.textContent = JSON.stringify({ ok: false, error: 'Fixture deadline exceeded', errors, requests, checks });
    output.dataset.complete = 'true';
  }, 14000);
  try {
    const refreshNotice = document.getElementById('page-refresh-notice');
    await until(() => !refreshNotice.hidden && refreshNotice.textContent.includes('刷新'), 'First install on old page must ask for page reload');
    const views = [...document.querySelectorAll('[data-view]')];
    const settingsShell = document.querySelector('#settings-view');
    const businessRegions = views.filter(view => view !== settingsShell).concat(document.querySelector('#settings-form'));
    assert(views.length === 7 && businessRegions.length === 7 && businessRegions.every(view => view.hidden && view.inert), 'First install has no active business module');
    assert(!settingsShell.hidden && !settingsShell.inert, 'Settings shell remains routable for its local log footer');
    const firstInstallRequests = requests.length;
    for (const route of ['time', 'titles', 'favorites', 'bookmarks', 'search', 'export', 'settings']) dock(route);
    document.getElementById('language-select').dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(25);
    equal(requests.length, firstInstallRequests, 'Dock and inert controls cannot dispatch business before initial admission');
    // Another admitted panel may change the saved language while this old page
    // still needs reload. Its one red notice must follow that preference too.
    for (const language of ['en', 'ja', 'zh-TW', 'zh-CN']) {
      preferences = { ...preferences, language }; storageEvent();
      equal(refreshNotice.textContent, createTranslator(language)('refreshChatgptPage'), 'Initial shared red notice follows the saved language');
      assert(businessRegions.every(view => view.hidden && view.inert), 'Retranslating the notice cannot admit business modules');
    }
    equal(requests.length, firstInstallRequests, 'Retranslating initial recovery adds no transport requests');
    checks.push({ name: 'initial red recovery notice translates in all four languages without unlocking any module' });
    pageRuntimeAvailable = true; updateSnapshot(); await sleep(25);
    equal(refreshNotice.hidden, false, 'Same-document snapshot/probe cannot unlock a refresh-required document');
    documentId = 'fresh-initial-document'; stored = library();
    event(protocol.Type.CONTEXT_CHANGED, { tabId: 31, documentId, url: currentSnapshot.route.href });
    await until(() => document.querySelectorAll('[data-bookmark-jump]').length === 3, 'Production panel did not initialize');
    assert(refreshNotice.hidden && [...views, ...businessRegions].every(view => !view.hidden && !view.inert), 'Fresh document handshake restores all modules');
    checks.push({ name: 'first install old page is inert; only a fresh document handshake enables all seven modules' });
    dock('settings'); await sleep(60);
    // 用真实下拉框和保存通知验证四种语言切换；语言变化不能改时区或用户资料。
    const languageSelect = document.getElementById('language-select');
    const originalLibrary = JSON.stringify(stored), originalZone = preferences.timeZone;
    for (const language of ['zh-TW', 'en', 'ja', 'zh-CN']) {
      languageSelect.value = language; languageSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await until(() => preferences.language === language && document.documentElement.lang === language, `Language ${language} did not save/render`);
      const t = createTranslator(language);
      equal(document.querySelector('[data-i18n="language"]').textContent, t('language'), 'Settings label matches saved language');
      equal(languageSelect.value, language, 'Saved language remains selected');
      equal(preferences.timeZone, originalZone, 'Language must not select a timezone');
      equal(JSON.stringify(stored), originalLibrary, 'Language must not translate or rewrite library content');
      if (language === 'zh-TW') {
        assert(document.getElementById('theme-grid').textContent.includes('霧靛'), 'Theme names have no Traditional translation');
        equal(document.querySelector('[data-route="export"]').getAttribute('aria-label'), '匯出', 'Export navigation has no Traditional translation');
      }
    }
    checks.push({ name: 'four UI languages save and render without changing timezone or user content' });
    const untouched = [], gridRebuilds = [];
    const observer = new MutationObserver(records => untouched.push(...records));
    for (const id of ['timezone-select', 'favorites-view', 'bookmarks-view', 'export-view', 'titles-view', 'search-view']) {
      observer.observe(document.getElementById(id), { subtree: true, childList: true, characterData: true, attributes: true });
    }
    const gridObserver = new MutationObserver(records => gridRebuilds.push(...records));
    gridObserver.observe(document.getElementById('theme-grid'), { subtree: true, childList: true });
    const changeTheme = name => {
      const input = document.querySelector(`input[name="settings-theme"][value="${name}"]`);
      input.focus(); input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true }));
      equal(document.activeElement, input, 'Color choice must preserve its focused button');
      equal(document.documentElement.style.getPropertyValue('--accent'), TidyTheme.THEMES[name].light.accent, 'Color updates before saving');
    };
    const themeReads = count(protocol.Type.LIBRARY_GET), preferenceReads = count(protocol.Type.PREFERENCES_GET);
    changeTheme('sage'); await sleep(30); storageEvent(); event(protocol.Type.PREFERENCES_UPDATED, clone(preferences)); await sleep(20);
    equal(count(protocol.Type.PREFERENCES_GET), preferenceReads, 'Save echo and broadcasts do not reread identical preferences');
    preferenceGate = defer(); changeTheme('amber'); await sleep(10); changeTheme('wineberry'); changeTheme('mist-cyan');
    const saveGate = preferenceGate; preferenceGate = null; saveGate.resolve(); await sleep(40);
    equal(document.documentElement.style.getPropertyValue('--accent'), TidyTheme.THEMES['mist-cyan'].light.accent, 'Old receipts cannot roll back latest choice');
    preferenceFailure = true; changeTheme('graphite'); await sleep(40);
    equal(document.documentElement.style.getPropertyValue('--accent'), TidyTheme.THEMES['mist-cyan'].light.accent, 'Failed save rolls back to stored color');
    changeTheme('mist-indigo'); await sleep(40);
    untouched.push(...observer.takeRecords()); gridRebuilds.push(...gridObserver.takeRecords()); observer.disconnect(); gridObserver.disconnect();
    equal(untouched.length, 0, 'Theme-only changes must not redraw unrelated modules');
    equal(gridRebuilds.length, 0, 'Theme-only changes must not recreate color buttons');
    equal(count(protocol.Type.LIBRARY_GET), themeReads, 'Color choices do not reread identity/library');
    checks.push({ name: 'theme changes are local, focus stable, echoes deduplicated, rapid choices and failure rollback checked' });
    const dateButtons = [...document.querySelectorAll('button[data-preference="dateFormat"]')];
    const regionalMarkup = dateButtons[0].innerHTML;
    const dateReads = [protocol.Type.LIBRARY_GET, protocol.Type.TITLE_PREVIEW, protocol.Type.EXPORT_CURRENT_CONVERSATION];
    const readsBeforeDates = dateReads.map(count);
    for (const zone of ['Asia/Singapore', 'America/Los_Angeles', 'UTC']) {
      dock('settings');
      const select = document.getElementById('timezone-select');
      select.value = zone; select.dispatchEvent(new Event('change', { bubbles: true }));
      await until(() => preferences.timeZone === zone, 'Time zone preference was not saved');
      await sleep(30); dock('time');
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone,
        year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(part => [part.type, part.value]));
      for (const [format, separator] of [['iso', '-'], ['slash', '/'], ['dot', '.'], ['compact', '']]) {
        const button = document.querySelector(`button[data-preference="dateFormat"][data-value="${format}"]`);
        equal(button.textContent, [parts.year, parts.month, parts.day].join(separator), `${zone}: ${format} displays zoned today`);
        assert(dateButtons.includes(button), 'Date changes preserve existing option buttons');
      }
      equal(dateButtons[0].innerHTML, regionalMarkup, 'Regional option retains its translated label and default marker');
    }
    dateReads.forEach((type, index) => equal(count(type), readsBeforeDates[index], 'Displaying zoned dates adds no conversation reads'));
    checks.push({ name: 'date options show today in the selected time zone without replacing buttons or reading conversations' });
    // Complete production DOM + CSS: an independent numbering switch must not
    // look disabled just because date/time formatting controls are disabled.
    // Keep this fixture's preferences unchanged for the navigation tests below.
    const beforeTimeControls = clone(preferences);
    const timeToggle = document.getElementById('time-enabled');
    const numberingToggle = document.getElementById('message-numbers');
    const numberingRow = numberingToggle.closest('.setting-section');
    const timeButtons = [...document.querySelectorAll('#time-view button[data-preference], #time-view [data-disclosure-toggle]')];
    const setTimeControl = async (input, key, value) => {
      if (input.checked !== value) input.click();
      await until(() => preferences[key] === value && input.checked === value
        && input.getAttribute('aria-checked') === String(value), key + ' did not save and render');
    };
    try {
      // Secondary switch is visually smaller, but the full label remains clickable.
      const compactLabel = numberingToggle.closest('label');
      const numberTrack = compactLabel.querySelector('.toggle-track');
      const headerTrack = timeToggle.closest('label').querySelector('.toggle-track');
      const dimensions = element => { const rect = element.getBoundingClientRect(); return [rect.width, rect.height]; };
      equal(JSON.stringify(dimensions(headerTrack)), '[34,20]', 'Header switch keeps its original visual size');
      equal(JSON.stringify(dimensions(numberTrack)), '[28,16]', 'Numbering track is one visual size smaller');
      equal(JSON.stringify(dimensions(compactLabel)), '[34,28]', 'Compact switch retains a generous label click target');
      equal(getComputedStyle(numberTrack, '::after').width, '12px', 'Compact thumb width');
      equal(getComputedStyle(numberTrack, '::after').height, '12px', 'Compact thumb height');
      equal(numberTrack.getBoundingClientRect().right, compactLabel.getBoundingClientRect().right, 'Compact track keeps the setting right edge');
      numberingToggle.focus();
      equal(document.activeElement, numberingToggle, 'Compact native switch remains keyboard-focusable');
      for (let click = 0; click < 2; click++) {
        const next = !numberingToggle.checked;
        compactLabel.click();
        await until(() => preferences.messageNumbersEnabled === next && numberingToggle.checked === next, 'Full compact label must toggle/save exactly once');
      }
      checks.push({ name: 'secondary numbering switch is 28x16 with a 34x28 clickable label; primary remains 34x20',
        headerTrack: dimensions(headerTrack), numberingTrack: dimensions(numberTrack), numberingHitTarget: dimensions(compactLabel), labelClicks: 2 });
      await setTimeControl(timeToggle, 'timeDisplayEnabled', false);
      assert(document.querySelector('.time-panel__body').classList.contains('time-settings-disabled'), 'Time controls did not enter their disabled state');
      equal(getComputedStyle(numberingRow).opacity, '1', 'Independent numbering row must not dim with time controls');
      equal(numberingToggle.closest('[data-time-control]'), null, 'Numbering cannot inherit a disabled time group');
      equal(getComputedStyle(document.querySelector('#time-view [data-time-control]')).opacity, '0.48', 'Time-only controls must retain their disabled styling');
      assert(timeButtons.length > 0 && timeButtons.every(button => button.disabled), 'Time-dependent buttons remain disabled');
      assert(!numberingToggle.disabled && !numberingToggle.closest('[inert]'), 'Independent numbering control remains interactive');
      for (const enabled of [!beforeTimeControls.messageNumbersEnabled, beforeTimeControls.messageNumbersEnabled]) {
        await setTimeControl(numberingToggle, 'messageNumbersEnabled', enabled);
        equal(timeToggle.checked, false, 'Numbering changes must not re-enable time');
        equal(getComputedStyle(numberingRow).opacity, '1', 'Numbering saves must not restore the incorrect dimmed style');
        equal(document.getElementById('conversation-preview').textContent, '—', 'Conversation time stays hidden');
        equal(document.getElementById('message-preview').textContent, enabled ? '#12' : '—', 'Preview reflects only the independent number');
        assert(timeButtons.every(button => button.disabled), 'Numbering saves cannot unlock time formatting buttons');
      }
      checks.push({ name: 'time OFF keeps numbering undimmed and independently clickable while time buttons stay disabled',
        numberingOpacity: getComputedStyle(numberingRow).opacity,
        timeGroupOpacity: getComputedStyle(document.querySelector('#time-view [data-time-control]')).opacity, independentNumberingClicks: 2 });
    } finally {
      await setTimeControl(numberingToggle, 'messageNumbersEnabled', beforeTimeControls.messageNumbersEnabled);
      await setTimeControl(timeToggle, 'timeDisplayEnabled', beforeTimeControls.timeDisplayEnabled);
    }
    equal(JSON.stringify(preferences), JSON.stringify(beforeTimeControls), 'Time-control regression restores every original preference');


    // Exercise the real panel route owner, not just the view's dismissal API.
    // Group name drafts remain local while switching columns; popovers do not.
    dock('favorites'); await sleep(30);
    const favoriteRoot = document.querySelector('#favorites-view');
    const favoriteStateBeforeDock = JSON.stringify(stored.favorites);
    for (const route of ['time', 'settings']) {
      const trigger = favoriteRoot.querySelector('[data-group-menu="keepsake"]');
      assert(trigger, 'Synthetic preset group trigger missing'); trigger.click();
      assert(favoriteRoot.querySelector('[data-group-overlay="keepsake"]'), 'Group menu did not open');
      dock(route);
      equal(favoriteRoot.querySelector('[data-group-overlay]'), null, 'Leaving Favorites must immediately dismiss its group menu');
      updateSnapshot(); dock('favorites'); await sleep(20);
      equal(favoriteRoot.querySelector('[data-group-overlay]'), null, 'Returning to Favorites resurrected an old group menu');
    }
    favoriteRoot.querySelector('[data-group-menu="study"]').click();
    favoriteRoot.querySelector('[data-group-action="icon"]').click();
    assert(favoriteRoot.querySelector('.favorite-icon-picker'), 'Group icon picker missing');
    dock('time'); updateSnapshot(); dock('favorites'); await sleep(20);
    equal(favoriteRoot.querySelector('[data-group-overlay]'), null, 'Returning to Favorites resurrected an icon picker');
    favoriteRoot.querySelector('[data-open-new-group]').click(); await sleep(20);
    const favoriteDraft = favoriteRoot.querySelector('[data-new-group] input');
    favoriteDraft.value = 'Unsaved route draft'; favoriteDraft.dispatchEvent(new Event('input', { bubbles: true }));
    dock('settings'); updateSnapshot(); dock('favorites'); await sleep(20);
    equal(favoriteRoot.querySelector('[data-new-group] input'), favoriteDraft, 'Column switch must not remount an unsaved group input');
    equal(favoriteDraft.value, 'Unsaved route draft', 'Column switch discarded the local name draft');
    favoriteRoot.querySelector('[data-cancel-new-group]').click();
    equal(JSON.stringify(stored.favorites), favoriteStateBeforeDock, 'Column switching must not write favorite groups');
    checks.push({ name: 'real panel Dock closes Favorites menu and icon picker across Time/Settings without discarding drafts or changing saved groups' });


    // 两栏挂在真正的 route / identity owner 下：离栏必须取消浮层和未确认的删除，
    // 不能只测 view.dismissTransientUi 这个局部方法而漏掉接线。
    const beforeSharedMenus = JSON.stringify(stored), beforeSharedWrites = requests.length;
    for (const c of [
      { route: 'favorites', other: 'bookmarks', root: favoriteRoot, group: '[data-group-menu="keepsake"]', action: '[data-group-action="delete"]', entry: '[data-favorite-menu]', overlay: '[data-group-overlay], [data-favorite-entry-overlay]' },
      { route: 'bookmarks', other: 'favorites', root: document.querySelector('#bookmarks-view'), group: '[data-bookmark-group-menu="bookmark-quote"]', action: '[data-bookmark-group-action="delete"]', entry: '[data-bookmark-entry-menu]', overlay: '[data-bookmark-group-overlay], [data-bookmark-entry-overlay]' },
    ]) {
      dock(c.route); await sleep(15);
      for (const trigger of [c.group, c.entry]) {
        c.root.querySelector(trigger).click(); assert(c.root.querySelector(c.overlay), 'Real panel menu did not open');
        dock(c.other); equal(c.root.querySelector(c.overlay), null, 'Route exit retained old menu');
        updateSnapshot(); dock(c.route); await sleep(15); equal(c.root.querySelector(c.overlay), null, 'Route return revived old menu');
      }
      c.root.querySelector(c.group).click(); c.root.querySelector(c.action).click(); await sleep(15);
      const dialog = document.querySelector('.library-confirmation[open]'); assert(dialog, 'Real panel confirmation missing');
      const staleAccept = dialog.querySelector('[data-panel-confirmation-accept]');
      dock(c.other); staleAccept.click(); await sleep(15);
      equal(document.querySelector('.library-confirmation[open]'), null, 'Route exit retained pending confirmation');
      equal(JSON.stringify(stored), beforeSharedMenus, 'Route change committed a stale group deletion');
    }
    equal(document.querySelectorAll('.library-confirmation').length, 1, 'Both columns must share one lazy panel confirmation');
    assert(requests.slice(beforeSharedWrites).every(request => ![protocol.Type.FAVORITES_GROUP_DELETE, protocol.Type.BOOKMARKS_GROUP_DELETE, protocol.Type.FAVORITES_MOVE, protocol.Type.BOOKMARKS_MOVE].includes(request.type)), 'Menu lifecycle unexpectedly wrote library data');
    checks.push({ name: 'both real panel routes dismiss group/entry menus and cancel a shared delete confirmation without stale writes' });

    dock('bookmarks'); toast().hidden = true; bookmark(1);
    await until(() => count(protocol.Type.BOOKMARKS_OPEN) === 1, 'Explicit bookmark did not OPEN'); await sleep(40);
    equal(toast().hidden, true, 'OPEN is not a completed location');
    const first = latestOpen();
    equal(document.querySelector('#bookmarks-view > .library-state'), null, 'Same-conversation bookmark never enters account waiting');
    for (const patch of [{ tabId: 99 }, { navigationIntentId: 'wrong' }, { messageId: 'wrong' }]) {
      complete(first, patch); equal(toast().hidden, true, 'Wrong receipt cannot complete the selection');
    }
    complete(first); equal(toast().hidden, false, 'Exact terminal receipt reaches the real panel');
    equal(toast().classList.contains('is-error'), false, 'Successful receipt is not an error');
    toast().hidden = true; complete(first, { located: false });
    equal(toast().hidden, true, 'Duplicate completion cannot replace the terminal result');
    chat.scrollTop = 1700;
    for (let index = 0; index < 20; index++) { updateSnapshot(); await sleep(5); }
    equal(count(protocol.Type.BOOKMARKS_OPEN), 1, 'Snapshots do not replay OPEN');
    equal(chat.scrollTop, 1700, 'User reading position survives snapshots');
    checks.push({ name: 'one OPEN, exact terminal receipt, no duplicate completion or streaming replay' });

    const reads = count(protocol.Type.LIBRARY_GET), before = count(protocol.Type.BOOKMARKS_OPEN);
    for (const route of ['favorites', 'time', 'search', 'export', 'settings', 'titles', 'bookmarks']) {
      dock(route); updateSnapshot(); await sleep(30);
    }
    equal(count(protocol.Type.BOOKMARKS_OPEN), before, 'Module changes cannot replay selection');
    equal(count(protocol.Type.LIBRARY_GET), reads, 'Module changes remain local');
    equal(chat.scrollTop, 1700, 'Module changes preserve native scroll');
    checks.push({ name: 'all seven module routes remain local and cannot restart navigation' });

    openGate = defer(); bookmark(4); await sleep(30); const older = latestOpen();
    for (let index = 0; index < 20; index++) updateSnapshot();
    bookmark(7); await sleep(30); const newer = latestOpen();
    assert(older !== newer, 'New click must issue its own OPEN');
    assert(cancelled.has(older.payload.navigationIntentId), 'New click cancels the exact older intent');
    const gate = openGate; openGate = null; gate.resolve(); await sleep(30);
    toast().hidden = true; complete(older); equal(toast().hidden, true, 'Late older result cannot affect UI');
    complete(newer); equal(toast().hidden, false, 'Newest result wins after delayed OPEN replies');
    checks.push({ name: 'new click retires older pending OPEN and ignores its late receipt' });

    // In production the worker revokes the navigation and separately publishes
    // library identity. Exercise those two current contracts, not a panel-side
    // identity/LOCATE pump that no longer exists.
    event(protocol.Type.NAVIGATION_CANCELLED, { tabId: 31, navigationIntentId: newer.payload.navigationIntentId, reason: 'identity-changed' });
    identityEpoch++;
    event(protocol.Type.LIBRARY_IDENTITY_CHANGED, { tabId: 31, documentId, epoch: identityEpoch, phase: 'unavailable', accountKey: null });
    owner = 'second-fixture-owner'; stored = library();
    event(protocol.Type.LIBRARY_IDENTITY_CHANGED, { tabId: 31, documentId, epoch: identityEpoch, phase: 'ready', accountKey: stored.accountKey });
    await sleep(70); const afterOwner = count(protocol.Type.BOOKMARKS_OPEN);
    for (let index = 0; index < 10; index++) updateSnapshot();
    toast().hidden = true; complete(newer);
    equal(toast().hidden, true, 'Revoked navigation cannot revive after new owner');
    equal(count(protocol.Type.BOOKMARKS_OPEN), afterOwner, 'Identity snapshots cannot replay navigation');
    checks.push({ name: 'worker revocation and new-owner snapshots do not revive old navigation' });

    bookmark(4); await sleep(30); const pending = latestOpen();
    dock('settings'); await sleep(20);
    assert(cancelled.has(pending.payload.navigationIntentId), 'Leaving the module cancels pending intent');
    toast().hidden = true; complete(pending);
    equal(toast().hidden, true, 'Late completion after departure is ignored');
    checks.push({ name: 'leave module while awaiting terminal result' });

    // Same-document opening keeps the actual list DOM and its scroll position.
    const spaDestination = 'native-spa-destination';
    stored.bookmarks = { ...addBookmarkFromSnapshot(stored.bookmarks, snapshot(spaDestination), 'message-1'), accountKey: stored.accountKey };
    stored.bookmarks.view.groupId = 'all';
    event(protocol.Type.BOOKMARKS_UPDATED, { accountKey: stored.accountKey, revision: stored.bookmarks.revision });
    dock('bookmarks'); await sleep(60);
    const spaRow = [...document.querySelectorAll('[data-bookmark-jump]')].find(node => node.dataset.bookmarkJump === spaDestination + '::message-1');
    const spaPanel = document.querySelector('.bookmarks-panel'), spaViewport = document.querySelector('[data-results-viewport="bookmarks"]');
    spaViewport.scrollTop = 36; const retainedScroll = spaViewport.scrollTop;
    const spaReads = count(protocol.Type.LIBRARY_GET), sourceTitle = document.querySelector('#bookmarks-view [data-list-key="current"]').textContent;
    bookmark(1, spaDestination); await sleep(20); const spaOpen = latestOpen();
    equal(document.querySelector('.bookmarks-panel'), spaPanel, 'SPA opening retains list container');
    equal(document.querySelector('[aria-busy="true"][data-bookmark-jump]'), spaRow, 'Only clicked row shows inline progress');
    currentSnapshot = snapshot(spaDestination); currentSnapshot.conversation.bindingStatus = 'route-only';
    currentSnapshot.conversation.title = { value: null, status: 'missing' }; currentSnapshot.messages = [];
    event(protocol.Type.CONTEXT_CHANGED, { tabId: 31, url: currentSnapshot.route.href });
    event(protocol.Type.SNAPSHOT_UPDATED, { tabId: 31, snapshot: clone(currentSnapshot) }); await sleep(40);
    equal(document.querySelector('#bookmarks-view [data-list-key="current"]').textContent, sourceTitle, 'Route-only snapshot does not flash New chat');
    equal(document.querySelector('.bookmarks-panel'), spaPanel, 'Route-only snapshot cannot replace sidebar');
    equal(spaViewport.scrollTop, retainedScroll, 'Sidebar result scrolling survives native transition');
    currentSnapshot = snapshot(spaDestination); updateSnapshot(); complete(spaOpen); await sleep(30);
    equal(document.querySelector('.bookmarks-panel'), spaPanel, 'Completion preserves sidebar nodes');
    equal(document.querySelector('[aria-busy="true"][data-bookmark-jump]'), null, 'Completion removes inline progress');
    equal(document.querySelector('#bookmarks-view > .library-state'), null, 'Native path never shows account waiting');
    equal(count(protocol.Type.LIBRARY_GET), spaReads, 'SPA switching does not reauthenticate library');
    checks.push({ name: 'SPA bookmark retains list DOM, scroll and title through route-only snapshots' });

    for (const order of ['identity-first', 'receipt-first', 'workspace-recheck']) {
      const destination = `destination-${order}`;
      stored.bookmarks = { ...addBookmarkFromSnapshot(stored.bookmarks, snapshot(destination), 'message-1'), accountKey: stored.accountKey };
      stored.bookmarks.view.groupId = 'all';
      event(protocol.Type.BOOKMARKS_UPDATED, { accountKey: stored.accountKey, revision: stored.bookmarks.revision });
      dock('bookmarks');
      await until(() => [...document.querySelectorAll('[data-bookmark-jump]')].some(node => node.dataset.bookmarkJump === `${destination}::message-1`), 'Destination bookmark not rendered');
      const before = count(protocol.Type.BOOKMARKS_OPEN), beforeLibrary = count(protocol.Type.LIBRARY_GET); nextOpenHandoff = order;
      bookmark(1, destination); await sleep(220); const opened = latestOpen();
      equal(count(protocol.Type.BOOKMARKS_OPEN), before + 1, 'Handoff retains one OPEN');
      equal(count(protocol.Type.LIBRARY_GET), beforeLibrary + (order === 'workspace-recheck' ? 3 : 1), 'Reads follow destination identity boundaries only');
      assert(document.querySelector('#bookmarks-view > .library-state'), 'Target snapshots and account readiness do not finish OPEN');
      toast().hidden = true; complete(opened);
      equal(toast().hidden, false, `${order}: same command consumes its terminal receipt`);
      equal(document.querySelector('#bookmarks-view > .library-state'), null, 'Terminal result releases the continuous loading view');
      chat.scrollTop = 1750;
      for (let index = 0; index < 10; index++) updateSnapshot(); await sleep(30);
      equal(count(protocol.Type.BOOKMARKS_OPEN), before + 1, 'Handoff cannot replay navigation');
      equal(chat.scrollTop, 1750, 'Handoff snapshots preserve reading position');
      checks.push({ name: `full-page handoff ${order}: one OPEN and one result` });
    }
    const failedDestination = 'unfinished-destination';
    stored.bookmarks = { ...addBookmarkFromSnapshot(stored.bookmarks, snapshot(failedDestination), 'message-1'), accountKey: stored.accountKey };
    event(protocol.Type.BOOKMARKS_UPDATED, { accountKey: stored.accountKey, revision: stored.bookmarks.revision });
    await sleep(40);
    for (const exit of ['fallback', 'cancel', 'leave-module']) {
      bookmark(1, failedDestination); await sleep(20); const opened = latestOpen();
      assert(document.querySelector('[aria-busy="true"][data-bookmark-jump]'), 'Cross-conversation starts with inline progress');
      if (exit === 'fallback') complete(opened, { located: false, reason: 'load-timeout' });
      if (exit === 'cancel') event(protocol.Type.NAVIGATION_CANCELLED, { tabId: 31, navigationIntentId: opened.payload.navigationIntentId, reason: 'identity-changed' });
      if (exit === 'leave-module') { dock('settings'); dock('bookmarks'); }
      equal(document.querySelector('#bookmarks-view > .library-state'), null, `${exit} cannot strand the loading view`);
      equal(document.querySelector('[aria-busy="true"][data-bookmark-jump]'), null, 'Every terminal path removes inline progress');
      checks.push({ name: `cross-conversation waiting exits on ${exit}` });
    }
    // Read-only navigation failure is explicitly transient. Keep the exact terminal
    // request/result path, and verify expiry rather than the retired sticky-close contract.
    bookmark(1, failedDestination); await sleep(20);
    complete(latestOpen(), { located: false, reason: 'load-timeout' });
    assert(!toast().hidden && toast().classList.contains('is-error'), 'Failed bookmark result shows a transient error');
    assert(toast().querySelector('span') && !toast().querySelector('button'), 'Read-only navigation must not require manual dismissal');
    toast().dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    await sleep(5250);
    assert(!toast().hidden, 'Reading a hovered transient notice must pause expiry');
    toast().dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body }));
    // Production makes the status focusable; use actual browser focus rather than a controller flag.
    toast().focus();
    equal(document.activeElement, toast(), 'Transient notice focus was not acquired by the browser');
    await sleep(5250);
    assert(!toast().hidden, 'Reading a focused transient notice must pause expiry');
    toast().blur();
    await sleep(5250);
    assert(toast().hidden && !toast().childElementCount, 'Read-only navigation error expires after its five-second lifetime');
    checks.push({ name: 'exact read-only navigation failure pauses while hovered or focused, then expires after five seconds without blocking later actions' });

    // Exercise a real business write through DOM -> feature action -> request client.
    // The fixture commits the store then returns ADAPTER_TIMEOUT, not a fabricated notice.
    dock('favorites'); await sleep(40);
    const favoriteToggle = document.querySelector('#favorites-view [data-toggle-current]');
    assert(favoriteToggle && !favoriteToggle.disabled, 'Current-conversation favorite write must be available');
    const writesBeforeUnknown = count(protocol.Type.FAVORITES_TOGGLE_CURRENT);
    loseFavoriteWriteReceipt = true; favoriteToggle.click();
    await until(() => !toast().hidden && toast().textContent.includes(createTranslator(preferences.language)('libraryChangeUnknown')),
      'Lost write acknowledgement did not reach the persistent unknown-write notice');
    await sleep(5250);
    assert(!toast().hidden && toast().classList.contains('is-error'), 'Unknown write must outlive the read-only five-second TTL');
    equal(count(protocol.Type.FAVORITES_TOGGLE_CURRENT), writesBeforeUnknown + 1, 'Unknown write cannot be replayed automatically');
    assert(stored.favorites.items[currentSnapshot.conversation.conversationId], 'Synthetic write was committed before its acknowledgement was lost');
    const toastLabel = toast().querySelector('span'), toastClose = toast().querySelector('button');
    assert(toastLabel && toastClose, 'Persistent toast has a stable text node and close control');
    dock('export');
    await until(() => document.querySelector('#export-view .export-preview-state--error'), 'Export fixture failure was not rendered');
    const exportReads = count(protocol.Type.EXPORT_CURRENT_CONVERSATION);
    dock('settings');
    for (const language of ['en', 'ja', 'zh-TW', 'zh-CN']) {
      toastClose.focus();
      languageSelect.value = language; languageSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await until(() => preferences.language === language && document.documentElement.lang === language, `Notice language ${language} did not render`);
      const t = createTranslator(language);
      equal(toast().querySelector('span'), toastLabel, 'Translation preserves the live toast text element');
      equal(toast().querySelector('button'), toastClose, 'Translation preserves the focused close button');
      equal(document.activeElement, toastClose, 'Translation does not steal close-button focus');
      equal(toastLabel.textContent, t('libraryChangeUnknown'), 'Visible persistent unknown-write error uses the current language');
      equal(toastClose.getAttribute('aria-label'), t('exportJobDismiss'), 'Visible close action uses the current language');
      dock('export');
      equal(document.querySelector('#export-view .export-preview-state--error > span')?.textContent,
        t('exportUnavailable'), 'Settled export read error uses the current language on return');
      equal(count(protocol.Type.EXPORT_CURRENT_CONVERSATION), exportReads, 'Language changes do not retry failed export reads');
      dock('settings');
    }
    toastClose.click();
    storageEvent(); updateSnapshot();
    assert(toast().hidden && !toast().childElementCount, 'Closing a translated toast clears it permanently');
    equal(count(protocol.Type.FAVORITES_TOGGLE_CURRENT), writesBeforeUnknown + 1, 'Translation, readback and explicit close cannot replay an unknown write');
    checks.push({ name: 'real committed write with lost receipt remains persistent beyond TTL; translation and explicit close preserve DOM/focus without replay' });
    dock('settings'); await sleep(20);
    const backup = document.querySelector('#library-backup'), chooseBackup = backup.querySelector('[data-backup-choose]');
    assert(document.querySelector('#settings-form').contains(backup), 'Backup must use the settings scroll container');
    assert(!chooseBackup.disabled, 'Verified settings owner must be able to choose a backup');
    chooseBackup.scrollIntoView({ block: 'center' }); chooseBackup.focus();
    const backupRect = chooseBackup.getBoundingClientRect(), bodyRect = document.querySelector('.time-panel__body').getBoundingClientRect();
    assert(backupRect.top >= bodyRect.top && backupRect.bottom <= bodyRect.bottom, 'Backup action must be reachable in narrow settings');
    const backupRequests = requests.filter(request => request.type.startsWith('library.backup')).length;
    for (let index = 0; index < 5; index++) updateSnapshot();
    equal(document.activeElement, chooseBackup, 'Snapshot refresh cannot steal backup focus');
    equal(backupRequests, 0, 'Opening settings cannot read or export backup contents automatically');
    checks.push({ name: 'settings backup entry is reachable, stable and idle until explicit action' });

    // An unrelated streaming snapshot must not remount an in-progress native IME input.
    dock('search'); await sleep(30);
    const composingInput = document.querySelector('#search-view [data-global-search]');
    assert(composingInput, 'Production search input is missing'); composingInput.focus();
    composingInput.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '输' }));
    composingInput.value = '输入中的草稿';
    composingInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: '输入中的草稿', inputType: 'insertCompositionText', isComposing: true }));
    const searchRequestsDuringComposition = requests.filter(request => request.type.startsWith('search.')).length;
    for (let index = 0; index < 8; index++) { updateSnapshot(); await sleep(5); }
    equal(document.querySelector('#search-view [data-global-search]'), composingInput, 'Streaming snapshot replaced the live IME input node');
    equal(document.activeElement, composingInput, 'Streaming snapshot stole IME focus');
    equal(composingInput.value, '输入中的草稿', 'Streaming snapshot replaced the current composition text');
    equal(requests.filter(request => request.type.startsWith('search.')).length, searchRequestsDuringComposition,
      'An unfinished IME composition must not issue a query');
    composingInput.value = '';
    composingInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteCompositionText', isComposing: true }));
    composingInput.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
    checks.push({ name: 'unrelated streaming snapshots retain the actual focused search input and unfinished IME composition without querying' });

    // Drive the shared basket through actual source controls and the complete shell.
    // Connecting is an unknown identity, not permission to erase a verified basket.
    dock('favorites'); await sleep(40);
    const startSelection = document.querySelector('#favorites-view [data-export-select-mode="favorites"]');
    assert(startSelection && !startSelection.disabled, 'Favorite selection entry is unavailable'); startSelection.click();
    const sourceChoice = document.querySelector('#favorites-view [data-export-draft-conversation]');
    assert(sourceChoice && !sourceChoice.disabled, 'No actual favorite source row is selectable'); sourceChoice.click();
    const submitSelection = document.querySelector('#favorites-view [data-export-selection-submit]');
    assert(submitSelection && !submitSelection.disabled, 'Real selection draft cannot be submitted'); submitSelection.click();
    const exportBadge = document.querySelector('[data-export-badge]');
    await until(() => !exportBadge.hidden && exportBadge.textContent === '1', 'Submitting a source did not reach the shell-owned basket');
    const batchReadsBeforeReconnect = count(protocol.Type.EXPORT_CONVERSATIONS);
    async function reconnectBasket(nextOwner = owner) {
      const expectedCount = nextOwner === owner ? '1' : '0';
      const gate = defer(); pageProbeGate = gate;
      documentId = 'basket-document-' + (++documentSequence); identityEpoch = 0;
      if (nextOwner !== owner) { owner = nextOwner; stored = library(); }
      else stored.identity = { documentId, epoch: identityEpoch };
      event(protocol.Type.CONTEXT_CHANGED, { tabId: 31, documentId, url: currentSnapshot.route.href });
      await until(() => businessRegions.every(view => view.hidden && view.inert), 'Connecting must lock all business views');
      event(protocol.Type.LIBRARY_IDENTITY_CHANGED, { tabId: 31, documentId, epoch: identityEpoch,
        phase: 'unavailable', accountKey: null });
      assert(exportBadge.hidden && exportBadge.textContent === '0', 'Unknown identity must hide the unverified private basket count');
      equal(count(protocol.Type.EXPORT_CONVERSATIONS), batchReadsBeforeReconnect, 'Unknown identity cannot read selected conversation bodies');
      pageProbeGate = null; gate.resolve();
      await until(() => refreshNotice.hidden && [...views, ...businessRegions].every(view => !view.hidden && !view.inert), 'Fresh page handshake did not become ready');
      // Account readiness is an independent real Worker event, not implied by a page probe.
      event(protocol.Type.LIBRARY_IDENTITY_CHANGED, { tabId: 31, documentId, epoch: identityEpoch,
        phase: 'ready', accountKey: stored.accountKey });
      await until(() => refreshNotice.hidden && [...views, ...businessRegions].every(view => !view.hidden && !view.inert)
        && document.querySelector('#favorites-view [data-export-select-mode="favorites"]'), 'Fresh verified document did not restore source controls');
      await until(() => exportBadge.textContent === expectedCount, 'Basket count did not follow the freshly verified account boundary');
      equal(count(protocol.Type.EXPORT_CONVERSATIONS), batchReadsBeforeReconnect, 'Reconnecting a source must not start export reads');
    }
    await reconnectBasket();
    await reconnectBasket('different-basket-owner');
    assert(exportBadge.hidden, 'A freshly verified different account must clear the prior account basket');
    checks.push({ name: 'real source selection basket survives connecting and fresh same-account identity, stays locked while unknown, and clears only for a fresh different account' });
    dock('titles'); await sleep(40);
    const rule = document.querySelector('[data-title-rule="mode"]');
    assert(rule && !rule.disabled, 'Title rule edit uses the real production controller');
    rule.value = 'range'; rule.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => storedTitleRules.mode === 'range', 'Normal title rule write failed');
    pageRuntimeAvailable = false;
    const rulesReadsBeforeRetirement = count(protocol.Type.TITLE_RULES_GET);
    rule.value = 'created'; rule.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => !refreshNotice.hidden && refreshNotice.textContent.includes('刷新'), 'Title rule failure must reach the same page session gate');
    assert(businessRegions.every(view => view.hidden && view.inert), 'Loaded modules and the settings business form are retired');
    assert(toast().hidden, 'Retirement suppresses module toasts');
    const businessTypes = request => !['page-session.probe', protocol.Type.NAVIGATION_CANCELLED,
      protocol.Type.EXPORT_PREVIEW_CLOSE, protocol.Type.EXPORT_JOB_CANCEL, protocol.Type.LIBRARY_BACKUP_DISCARD].includes(request.type);
    const retiredBusiness = requests.filter(businessTypes).length;
    for (const route of ['time', 'titles', 'favorites', 'bookmarks', 'search', 'export', 'settings']) dock(route);
    for (const control of document.querySelectorAll('[data-view] button, [data-view] select, [data-view] input')) {
      if (control.closest('#settings-diagnostics')) continue; // Local log operations are tested separately.
      control.dispatchEvent(new Event(control.tagName === 'BUTTON' ? 'click' : 'change', { bubbles: true, cancelable: true }));
    }
    for (let index = 0; index < 5; index++) updateSnapshot();
    await sleep(50);
    equal(requests.filter(businessTypes).length, retiredBusiness, 'Retired page cannot trigger hidden controls, automatic module work or queued writes');
    equal(count(protocol.Type.TITLE_RULES_GET), rulesReadsBeforeRetirement, 'Retired title-rule write cannot perform automatic readback');
    assert(toast().hidden && businessRegions.every(view => view.hidden && view.inert), 'Shared refresh notice remains while all page-dependent business content stays retired');
    checks.push({ name: 'title rules share admission; reloaded page retires all controls and background work without toast or readback' });
    equal(networkAttempts, 0, 'Zero real network attempts'); equal(errors.length, 0, `No browser errors: ${errors.join('; ')}`);
    equal(unexpected.length, 0, `No unexpected transport actions: ${unexpected.join('; ')}`);
    output.textContent = JSON.stringify({ ok: true, scope: 'Production panel with synthetic current Worker IPC; not live navigation or geometry acceptance', checks, networkAttempts, errors });
  } catch (error) {
    output.textContent = JSON.stringify({ ok: false, checks, error: String(error), errors, networkAttempts, requests });
  } finally { clearTimeout(watchdog); output.dataset.complete = 'true'; }
}
