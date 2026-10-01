// Same lifecycle owner required by the manifest-loaded page presenters.
import '../../src/messages/notice-lifecycle.js';
import '../../src/messages/page-runtime.js';
import '../../src/platform/protocol.js';
import '../../src/platform/session/shared/page-session.js';
import '../../src/platform/library/library-hydration.js';
import '../../src/platform/snapshot.js';
import '../../src/platform/ui/dom-ownership.js';
import '../../src/platform/time-format.js';
import '../../src/platform/theme/theme.js';

// 真实展示代码与真实 CSS；仅页面快照、设置和本地资料回包为合成数据。
const output = document.querySelector('#results'), checks = [], runtimeListeners = [], snapshotListeners = [];
const protocol = globalThis.TidyProtocol, { THEMES, NATIVE_APPEARANCE_TOKENS } = globalThis.TidyTheme;
const assert = (condition, message) => { if (!condition) throw Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async condition => { const until = performance.now() + 2500;
  while (!condition()) { if (performance.now() > until) throw Error('Timed out waiting for production rendering'); await sleep(10); } };
let inputSequence = 0;
const inputWaiters = new Map();
globalThis.completeFixtureInput = id => { const resolve = inputWaiters.get(id); inputWaiters.delete(id); globalThis.fixtureInputRequest = null; resolve?.(); };
function nativePointer(x, y) {
  return new Promise(resolve => { const id = ++inputSequence; inputWaiters.set(id, resolve);
    globalThis.fixtureInputRequest = { id, kind: 'pointer', steps: [{ type: 'mouseMoved', x, y }] }; });
}
const rgb = hex => 'rgb(' + [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(', ') + ')';
const field = value => ({ value, source: value == null ? null : 'synthetic', status: value == null ? 'missing' : 'available' });
const initialPreferences = { language: 'zh-CN', theme: 'mist-indigo', timeZone: 'UTC', dateFormat: 'iso',
  messageTimePrecision: 'second', messageNumbersEnabled: true, timeDisplayEnabled: true };
const initialSnapshot = { schemaVersion: TidySnapshot.VERSION, route: { pathname: '/c/synthetic' },
  appearance: { colorScheme: 'light', source: 'synthetic', status: 'available', surface: field('rgb(255, 255, 255)') },
  conversation: { conversationId: 'synthetic', draftId: null, identityStatus: 'stable', bindingStatus: 'bound',
    title: field('合成会话'), createdAt: field(null), updatedAt: field(null) },
  sidebarConversations: [{ conversationId: 'synthetic', identityStatus: 'stable', bindingStatus: 'bound', kind: 'conversation',
    title: field('合成会话'), createdAt: field(null), updatedAt: field(null), locator: { strategy: 'href', value: '/c/synthetic' } }],
  messages: ['user', 'assistant'].map((role, index) => ({ messageId: role, idStatus: 'stable', presentationStatus: 'formal', role,
    timestamp: field('2026-09-17T06:00:00Z'), excerpt: field('本地合成消息'), order: { index: index + 1, displayNumber: index + 1 },
    locator: { strategy: 'data-message-id', value: role } })),
};
const library = { accountKey: 'synthetic-only', identity: { documentId: 'synthetic-document', epoch: 0 },
  favorites: { accountKey: 'synthetic-only', revision: 1, groups: [], items: { synthetic: { conversationId: 'synthetic' } } },
  bookmarks: { accountKey: 'synthetic-only', revision: 1, groups: [], items: {
    'synthetic::user': { bookmarkId: 'synthetic::user', conversationId: 'synthetic', messageId: 'user' },
  } },
};
let preferences = initialPreferences, snapshot = initialSnapshot, libraryReads = 0, remoteAttempts = 0, releaseStartup;
const startupGate = new Promise(resolve => { releaseStartup = resolve; });
globalThis.chrome = { runtime: {
  id: 'synthetic-extension',
  onMessage: { addListener: listener => runtimeListeners.push(listener),
    removeListener: listener => { const i = runtimeListeners.indexOf(listener); if (i >= 0) runtimeListeners.splice(i, 1); } },
  async sendMessage(envelope) {
    if (envelope.type === protocol.Type.PREFERENCES_GET) { await startupGate; return protocol.response(envelope, initialPreferences); }
    assert(envelope.type === protocol.Type.LIBRARY_GET, 'Unexpected request: ' + envelope.type);
    libraryReads++; return protocol.response(envelope, structuredClone(library));
  },
} };
globalThis.TidyPageSession = TidyPageSessionContract.create({ runtime: chrome.runtime });
globalThis.TidyContentBridge = {
  onSnapshot: listener => { snapshotListeners.push(listener); return () => {
    const i = snapshotListeners.indexOf(listener); if (i >= 0) snapshotListeners.splice(i, 1);
  }; },
  onLibraryIdentityChanged: () => () => {},
  async requestMain(type) { assert(type === protocol.Type.GET_SNAPSHOT, 'Unexpected page request'); await startupGate; return initialSnapshot; },
};
globalThis.fetch = () => { remoteAttempts++; throw Error('Network is forbidden'); };
function emitTheme(name) {
  preferences = { ...preferences, theme: name };
  for (const listener of runtimeListeners) listener(protocol.event(protocol.Type.PREFERENCES_UPDATED, preferences));
}
function emitAppearance(scheme) {
  const native = NATIVE_APPEARANCE_TOKENS[scheme];
  for (const [key, value] of Object.entries({ '--text-secondary': native.textSecondary, '--text-tertiary': native.textTertiary, '--page-surface': native.surface })) {
    document.documentElement.style.setProperty(key, value);
  }
  snapshot = { ...snapshot, appearance: { ...snapshot.appearance, colorScheme: scheme, surface: field(rgb(native.surface)) } };
  assert(TidySnapshot.validate(snapshot).valid, 'Invalid synthetic snapshot');
  for (const listener of snapshotListeners) listener(snapshot);
}
const messageHost = id => document.querySelector(`[data-message-id="${id}"], [data-chatgpt-search-message-ids~="${id}"]`);
const button = id => messageHost(id)?.querySelector('.tidy-message-bookmark');
const color = element => getComputedStyle(element).color;
async function settledAccent(name, scheme) {
  await wait(() => button('user') && color(button('user')) === rgb(THEMES[name][scheme].accent));
}
try {
  await import('../../src/platform/library/content/library-client.js');
  await import('../../src/platform/chatgpt/message-dom.js');
  await import('../../src/platform/chatgpt/sidebar-dom.js');
  await import('../../src/features/time/chatgpt/time-presentation.js');
  await import('../../src/features/favorites/chatgpt/favorites-presentation.js');
  await import('../../src/features/bookmarks/chatgpt/bookmarks-presentation.js');
  emitAppearance('dark'); emitTheme('sage'); await settledAccent('sage', 'dark');
  releaseStartup(); await sleep(100); await settledAccent('sage', 'dark');
  assert(color(button('user')) === rgb(THEMES.sage.dark.accent), 'Late startup preferences replaced the current theme');
  checks.push('late startup replies cannot roll back current theme or appearance');
  const star = document.querySelector('.tidy-sidebar-favorite'), count = document.querySelector('.tidy-sidebar-bookmark-count');
  assert(star && count, 'Native sidebar markers missing');
  // 从文字输入框移交可见焦点，避免把普通脚本 focus() 当成键盘焦点。
  const focusAnchor = document.createElement('input'); focusAnchor.style.position = 'fixed'; focusAnchor.style.left = '-9999px';
  document.body.append(focusAnchor);
  await sleep(100); // 夹具插入原生节点产生的观察回调先落定，不混入改色的计数。
  for (const scheme of ['light', 'dark', 'light']) {
    emitAppearance(scheme);
    // 星星保留原来的 120ms 颜色过渡，验收落定色而不是中间帧。
    color(star); await Promise.all(star.getAnimations().map(animation => animation.finished));
    for (const name of Object.keys(THEMES)) {
      const mutations = [], scans = [];
      const observer = new MutationObserver(records => mutations.push(...records));
      observer.observe(document.querySelector('#scene'), { subtree: true, childList: true, characterData: true, attributes: true });
      const queryAll = document.querySelectorAll;
      document.querySelectorAll = function(selector) {
        if (selector === 'div[data-message-id]' || selector === 'a[href]') scans.push(selector);
        return queryAll.call(this, selector);
      };
      try { emitTheme(name); await settledAccent(name, scheme); await sleep(20); }
      finally { document.querySelectorAll = queryAll; mutations.push(...observer.takeRecords()); observer.disconnect(); }
      assert(scans.length === 0, 'Theme-only update scanned native message or sidebar hosts');
      assert(mutations.every(record => record.type === 'attributes' && record.attributeName === 'style'
        && record.target.dataset.tidyOwned === 'message-bookmark'), 'Theme-only update changed time, star, count or message structure');
      const active = button('user'), inactive = button('assistant'), expected = rgb(THEMES[name][scheme].accent);
      assert(getComputedStyle(active.querySelector('svg')).fill === expected, 'Active bookmark lost its filled accent');
      assert(active.getAttribute('aria-pressed') === 'true', 'Active state changed');
      assert(color(inactive) === rgb(NATIVE_APPEARANCE_TOKENS[scheme].textTertiary), 'Inactive bookmark unexpectedly colored');
      assert(getComputedStyle(inactive.querySelector('svg')).fill === 'none', 'Inactive bookmark must stay hollow');
      focusAnchor.focus(); inactive.focus();
      assert(inactive.matches(':focus-visible') && color(inactive) === expected, 'Visible focus missed theme accent'); inactive.blur();
      assert(color(star) === rgb(NATIVE_APPEARANCE_TOKENS[scheme].textSecondary), 'Favorite star changed color');
      assert(color(count) === rgb(NATIVE_APPEARANCE_TOKENS[scheme].textTertiary), 'Sidebar count changed color');
      assert(color(document.querySelector('.tidy-message-meta')) === rgb(NATIVE_APPEARANCE_TOKENS[scheme].textTertiary), 'Message time was recolored');
      assert(document.documentElement.style.getPropertyValue('--tidy-bookmark-accent') === '', 'Bookmark color leaked to native page');
      checks.push(`${scheme}/${name}: active, inactive, focus, star, count, time`);
    }
  }
  emitAppearance('dark'); emitTheme('terracotta'); await settledAccent('terracotta', 'dark');
  focusAnchor.remove();
  const old = button('user'); old.remove();
  await wait(() => button('user') && button('user') !== old); await settledAccent('terracotta', 'dark');
  checks.push('remounted native message receives the latest theme');
  button('user').classList.add('is-error');
  assert(color(button('user')) === rgb('#c45b66'), 'Error feedback must still override the accent');
  button('user').classList.remove('is-error');
  emitTheme('unknown'); await settledAccent('mist-indigo', 'dark');
  assert(libraryReads === 1 && remoteAttempts === 0, 'Theme changes caused account/library/network reads');
  checks.push('invalid theme uses shared default; no extra reads');
  preferences = { ...preferences, language: 'zh-TW', conversationTimeMode: 'created' };
  snapshot = { ...snapshot, sidebarConversations: snapshot.sidebarConversations.map(item => ({ ...item, createdAt: field('2026-09-17T06:00:00Z') })) };
  emitAppearance('light');
  emitTheme('sage');
  await wait(() => button('user')?.getAttribute('aria-label') === '取消訊息書籤');
  assert(button('assistant').getAttribute('aria-label') === '新增訊息書籤', 'Unselected message missed Traditional label');
  assert(document.querySelector('.tidy-sidebar-bookmark-count').getAttribute('aria-label').includes('開啟書籤'), 'Sidebar count missed Traditional label');
  assert(document.querySelector('.tidy-sidebar-favorite').getAttribute('aria-label') === '取消收藏 合成会话', 'Favorite label must retain the original conversation title');
  await wait(() => document.querySelector('.tidy-sidebar-time')?.textContent.startsWith('建立 '));
  assert(libraryReads === 1 && remoteAttempts === 0, 'Language change caused account/library/network reads');
  checks.push('Traditional native message and sidebar labels; no extra reads');
  const mixed = document.createElement('section');
  mixed.innerHTML = '<div data-chatgpt-search-message-ids="first"></div><div data-message-id="second"></div><div data-message-id="third" data-chatgpt-search-message-ids="third"><section data-chatgpt-search-message-ids="nested"><span></span></section></div>';
  assert(TidyChatgptMessageDom.candidates(mixed).map(TidyChatgptMessageDom.id).join(',') === 'first,second,third', 'Mixed native shapes lost document order or duplicated a host');
  assert(TidyChatgptMessageDom.targets('third', mixed).length === 1, 'Dual-marked exact target counted twice');
  assert(TidyChatgptMessageDom.id(TidyChatgptMessageDom.closest(mixed.querySelector('span'))) === 'nested', 'Closest message crossed a nested native boundary');
  // 重现新版 ChatGPT：外层只带 search-message-ids，正文内部不再有旧消息属性。
  await import('../../src/platform/navigation/chatgpt/message-navigation.js');
  const hosts = ['user', 'assistant'].map(role => {
    const host = document.createElement('div'); host.className = 'fixture-message fixture-' + role;
    host.setAttribute('data-chatgpt-search-message-ids', role === 'user' ? role : `${role} ${role}`);
    const content = document.createElement('div');
    content.setAttribute(role === 'user' ? 'data-user-message-bubble' : 'data-markdown-text-style', role === 'user' ? '' : 'assistant-message');
    content.textContent = role === 'user' ? '用户消息：时间应该贴近气泡，而不是隔着悬停按钮。' : '助手消息：正文、时间与操作按钮保持相同顺序。needle';
    if (role === 'user') {
      // 2026-10-01 实测原生层级：精确消息 host > 搜索单元 > 正文列 > 气泡、动作分支。
      // 标识/布局忠实，但内容和 ID 完全合成；用户私有 DOM 不进入仓库。
      const unit = document.createElement('div'); unit.dataset.contentSearchUnitKey = 'synthetic-user';
      const column = document.createElement('div'); column.className = 'fixture-user-column';
      const actions = document.createElement('div'); actions.className = 'fixture-user-actions';
      actions.innerHTML = '<div class="turn-action-controls"><button type="button">复制</button><button type="button">编辑</button></div>';
      column.append(content, actions); unit.append(column); host.append(unit);
    } else host.append(content);
    return host;
  });
  const assistantActions = document.createElement('section'); assistantActions.className = 'fixture-assistant-actions';
  assistantActions.innerHTML = '<div class="turn-action-controls"><button type="button">复制</button><button type="button">更多</button></div>';
  document.querySelector('main').replaceChildren(...hosts, assistantActions);
  const metaFor = host => host.querySelector('.tidy-message-meta');
  const placed = (host, index, position) => position === 'before' ? host.firstElementChild === metaFor(host)
    : index === 0 ? metaFor(host)?.nextElementSibling === host.querySelector('.fixture-user-actions')
      : host.lastElementChild === metaFor(host);
  const nativeNodes = hosts.map(host => [...host.querySelectorAll('*')]);
  snapshot = { ...snapshot, messages: snapshot.messages.map(message => ({ ...message,
    locator: { strategy: 'data-chatgpt-search-message-ids', value: message.messageId } })) };
  emitAppearance('light');
  await wait(() => hosts.every(host => host.querySelector('.tidy-message-time') && host.querySelector('.tidy-message-bookmark')));
  for (const [index, host] of hosts.entries()) {
    assert(host.querySelectorAll('.tidy-message-meta').length === 1, 'New native host duplicated the shared metadata row');
    assert(host.querySelector('.tidy-message-time').textContent.includes('2026-09-17'), 'New native host missed its message date');
    assert(host.querySelector('.tidy-message-time').textContent.includes(`#${index + 1}`), 'New native host missed its canonical number');
    assert(!host.hasAttribute('data-message-id'), 'Presentation forged an old native message ID');
    assert(TidyChatgptMessageDom.targets(snapshot.messages[index].messageId)[0] === host, 'Exact navigation missed the new native host');
    assert(TidyChatgptMessageNavigation.hasRenderedContent(host), 'New message content was treated as an empty shell');
  }
  assert(!('prepare' in TidyChatgptMessageNavigation), 'Bookmark adapter must not expose a native-search highlight owner');
  for (const position of ['before', 'after']) {
    preferences = { ...preferences, messageTimePosition: position }; emitTheme('sage');
    await wait(() => hosts.every((host, index) => placed(host, index, position)));
    for (const [index, host] of hosts.entries()) assert(nativeNodes[index].every(node => host.contains(node)), 'Placement replaced a native node');
  }
  const rect = element => { const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
  const user = hosts[0], bubble = user.querySelector('[data-user-message-bubble]'), actions = user.querySelector('.fixture-user-actions');
  const metadata = metaFor(user), userTime = user.querySelector('.tidy-message-time span:last-child');
  const stable = rect(metadata), bodyRect = rect(bubble), actionRect = rect(actions);
  assert(bodyRect.bottom <= stable.top && stable.bottom <= actionRect.top, 'User metadata is not between body and action row');
  assert(stable.top - bodyRect.bottom <= 12, 'User time is detached from its bubble');
  assert(Math.abs(rect(userTime).right - bodyRect.right) < 2, 'User time lost right alignment');
  assert(rect(metaFor(hosts[1])).bottom <= rect(assistantActions).top, 'Assistant metadata moved after actions');
  assert(getComputedStyle(actions).opacity === '0', 'Native user actions should start hidden');
  await nativePointer(bodyRect.left + 10, bodyRect.top + 10);
  await wait(() => getComputedStyle(actions).opacity === '1');
  assert(JSON.stringify(rect(metadata)) === JSON.stringify(stable), 'Hover moved the metadata row');
  await nativePointer(1050, 10);
  await wait(() => getComputedStyle(actions).opacity === '0');
  const edit = actions.querySelector('button:last-child'); edit.focus();
  await wait(() => getComputedStyle(actions).opacity === '1');
  assert(document.activeElement === edit && JSON.stringify(rect(metadata)) === JSON.stringify(stable), 'Keyboard focus moved the row or lost the native control');
  edit.blur();
  checks.push('nested user actions: body/time/actions geometry, real pointer hover, native button focus, stable alignment');
  // 图片和附件不是正文中的文字行；统一插在最后的动作分支前，不截断这些内容。
  const attachment = document.createElement('div'); attachment.className = 'fixture-attachment'; attachment.textContent = '示例附件.pdf';
  bubble.parentElement.insertBefore(attachment, bubble);
  bubble.replaceChildren(Object.assign(document.createElement('img'), { alt: '合成图片消息', width: 180, height: 50,
    src: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="50"><rect width="180" height="50" fill="#c6b5e8"/></svg>') }));
  await sleep(100);
  assert(placed(user, 0, 'after') && attachment.nextElementSibling === bubble && bubble.nextElementSibling === metadata, 'Image/attachment content was split by metadata');
  assert(TidyChatgptMessageNavigation.hasRenderedContent(user), 'Image-only message lost navigable content');
  bubble.textContent = '用户消息：时间贴近气泡，悬停按钮位于时间下方。'; attachment.remove();
  // 两个时间内容开关都关闭后，书签仍是共享行的独立 owner，并继续响应位置设置。
  preferences = { ...preferences, timeDisplayEnabled: false, messageNumbersEnabled: false }; emitTheme('sage');
  await wait(() => hosts.every(host => !host.querySelector('.tidy-message-time') && host.querySelector('.tidy-message-bookmark')));
  for (const position of ['before', 'after']) {
    preferences = { ...preferences, messageTimePosition: position }; emitTheme('sage');
    await wait(() => hosts.every((host, index) => placed(host, index, position)));
    assert(hosts.every(host => host.classList.contains('tidy-message-meta-host')), 'Time cleanup removed the bookmark hover owner');
  }
  preferences = { ...preferences, timeDisplayEnabled: true, messageNumbersEnabled: true }; emitTheme('sage');
  await wait(() => hosts.every(host => host.querySelector('.tidy-message-time')));
  const userReplacement = user.cloneNode(true); metaFor(userReplacement).remove(); user.replaceWith(userReplacement); hosts[0] = userReplacement;
  await wait(() => placed(hosts[0], 0, 'after') && hosts[0].querySelector('.tidy-message-bookmark'));
  checks.push('image/attachment-only content, bookmark-only before/after, independent cleanup and nested user remount');
  const replacement = hosts[1].cloneNode(true);
  replacement.querySelector('.tidy-message-meta').remove(); hosts[1].replaceWith(replacement); hosts[1] = replacement;
  await wait(() => replacement.querySelector('.tidy-message-time') && replacement.querySelector('.tidy-message-bookmark'));
  const bound = snapshot.conversation;
  snapshot = { ...snapshot, conversation: { ...bound, bindingStatus: 'route-only', title: field(null), createdAt: field(null), updatedAt: field(null) }, messages: [] }; emitAppearance('light');
  await wait(() => hosts.every(host => !host.querySelector('.tidy-message-meta')));
  snapshot = { ...snapshot, conversation: bound, messages: initialSnapshot.messages.map(message => ({ ...message,
    locator: { strategy: 'data-chatgpt-search-message-ids', value: message.messageId } })) }; emitAppearance('light');
  await wait(() => hosts.every(host => host.querySelector('.tidy-message-time') && host.querySelector('.tidy-message-bookmark')));
  assert(libraryReads === 1 && remoteAttempts === 0, 'Native message remount created extra reads');
  checks.push('composed native messages: timestamps, numbers, bookmarks, exact landing, before/after, remount and binding cleanup');
  // 截图样本从通过计算样式检查的生产按钮克隆，只用于并排观察浅/深配色。
  for (const scheme of ['light', 'dark']) {
    const palette = document.createElement('section'); palette.className = 'palette ' + scheme;
    palette.innerHTML = `<h2>${scheme === 'light' ? '浅色' : '深色'} · 书签 / 星星</h2>`;
    document.querySelector('#samples').append(palette); emitAppearance(scheme);
    for (const name of Object.keys(THEMES)) {
      emitTheme(name); await settledAccent(name, scheme);
      const row = document.createElement('div'); row.className = 'sample';
      const label = document.createElement('label'); label.textContent = name;
      const bookmarkCopy = button('user').cloneNode(true), starCopy = star.cloneNode(true);
      // 样本不冒充运行中的 TIDY 挂载节点，避免被真实清理器移除。
      for (const copy of [bookmarkCopy, starCopy]) { delete copy.dataset.tidyOwned; copy.tabIndex = -1; }
      starCopy.style.color = NATIVE_APPEARANCE_TOKENS[scheme].textSecondary;
      row.append(label, bookmarkCopy, starCopy); palette.append(row);
    }
  }
  emitAppearance('light'); emitTheme('sage'); await settledAccent('sage', 'light');
  output.textContent = JSON.stringify({ ok: true, checks, libraryReads, remoteAttempts, scope: 'Production presenters; synthetic local data only' }, null, 2);
} catch (error) { output.textContent = JSON.stringify({ ok: false, error: error.stack, checks }); }
output.dataset.complete = 'true';
