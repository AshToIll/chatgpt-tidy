import { createSidePanelPath, isValidTabId, parsePanelOwnerTabId } from '../../navigation/panel-owner.js';

export const TOOLBAR_THEME_CHANNEL = 'tidy.toolbar-theme.v1';

const SYNC = Object.freeze({ channel: TOOLBAR_THEME_CHANNEL, target: 'reporter', type: 'sync' });

function isChatgptUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://chatgpt.com' && !url.username && !url.password;
  } catch { return false; }
}

// 隐藏的 offscreen 文档可能只反映系统主题，不能代表 Chrome 的外观设置。
// 全局只设置双明暗可见的描边底图；可靠文档只改变自己所属标签的图标。
// 没有已加载 reporter 的旧页、浏览器设置页和其他网站均不猜测主题。
export function createToolbarTheme(chrome) {
  const panelBase = chrome.runtime.getURL('app/sidepanel/index.html');
  const states = new Map();
  let starting = null;

  function paths(prefix) {
    // Worker 的相对路径从 background/ 解析，因此始终使用扩展根 URL。
    return Object.fromEntries([16, 32, 48, 128].map(size =>
      [size, chrome.runtime.getURL(`assets/icons/${prefix}-${size}.png`)]));
  }

  function stateFor(tabId) {
    if (!states.has(tabId)) states.set(tabId, { epoch: 0, tail: Promise.resolve(), applied: null });
    return states.get(tabId);
  }

  function current(tabId, state, epoch) {
    return states.get(tabId) === state && state.epoch === epoch;
  }

  function enqueue(state, task) {
    const result = state.tail.then(task);
    // API 失败必须反馈给本次调用，但不能堵住该标签的下一次报告/导航清理。
    state.tail = result.catch(() => {});
    return result;
  }

  async function apply(tabId, state, epoch, prefix) {
    if (!current(tabId, state, epoch)) return false;
    if (state.applied === prefix) return true;
    await chrome.action.setIcon({ tabId, path: paths(prefix) });
    // setIcon 不能取消；若执行中导航，队列后面的 reset 会覆盖它。
    if (!current(tabId, state, epoch)) return false;
    state.applied = prefix;
    return true;
  }

  function reset(tabId) {
    const state = stateFor(tabId), epoch = ++state.epoch;
    // 不能沿用旧 document 的去重状态，包括还在执行中的 setIcon。
    state.applied = null;
    return { state, epoch, done: enqueue(state, () => apply(tabId, state, epoch, 'tidy-outlined')) };
  }

  function close(tabId) {
    const state = states.get(tabId);
    if (state) state.epoch++;
    states.delete(tabId);
  }

  function identify(sender) {
    if (sender?.id !== chrome.runtime.id) return null;
    if (sender.tab) {
      return isValidTabId(sender.tab.id) && sender.frameId === 0
        && typeof sender.documentId === 'string' && Boolean(sender.documentId)
        && sender.documentLifecycle === 'active' && isChatgptUrl(sender.url)
        ? { kind: 'content', tabId: sender.tab.id } : null;
    }
    // Chrome 的真实 Side Panel MessageSender 可能只有 id/url，不提供网页的
    // frameId/documentId/lifecycle。真实文档身份由下方 getContexts 核验，不能猜造。
    if (sender.documentId !== undefined
      && (typeof sender.documentId !== 'string' || !sender.documentId)) return null;
    const tabId = parsePanelOwnerTabId(sender.url, panelBase);
    return isValidTabId(tabId) ? { kind: 'panel', tabId } : null;
  }

  async function validate(owner, sender) {
    try {
      if (owner.kind === 'content') {
        const frame = await chrome.webNavigation.getFrame({ tabId: owner.tabId, frameId: 0 });
        return frame?.documentId === sender.documentId && frame.documentLifecycle === 'active'
          && isChatgptUrl(frame.url);
      }
      // URL 参数仅提供地址，不是授权：配置、真实 Side Panel 文档、所属标签都要匹配。
      const [tab, options, contexts] = await Promise.all([
        chrome.tabs.get(owner.tabId),
        chrome.sidePanel.getOptions({ tabId: owner.tabId }),
        chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'], documentUrls: [sender.url] }),
      ]);
      // Chrome 的 Side Panel context 也可能将 tabId/windowId 标为 -1；不能拿这些
      // 不可用字段猜归属。固定唯一 URL + 浏览器配置共同绑定 owner，真实 context
      // 证明这不是同 URL 的普通扩展 tab。出现同 URL 多文档歧义时拒绝，不任选一个。
      const matches = Array.isArray(contexts) ? contexts.filter(context =>
        context.contextType === 'SIDE_PANEL' && context.documentUrl === sender.url) : [];
      return isChatgptUrl(tab?.url) && options?.enabled === true
        && options.path === createSidePanelPath(owner.tabId)
        && matches.length === 1 && typeof matches[0].documentId === 'string' && Boolean(matches[0].documentId)
        && (sender.documentId === undefined || matches[0].documentId === sender.documentId);
    } catch { return false; } // 缺权限、文档关闭或 API 不存在均关闭此条消息的权限。
  }

  function acceptReport(message, sender) {
    if (message?.channel !== TOOLBAR_THEME_CHANNEL || message.target !== 'service'
      || message.type !== 'changed' || typeof message.dark !== 'boolean') return Promise.resolve(false);
    const owner = identify(sender);
    if (!owner) return Promise.resolve(false);
    const state = stateFor(owner.tabId), epoch = state.epoch;
    return enqueue(state, async () => {
      if (!current(owner.tabId, state, epoch) || !await validate(owner, sender)
        || !current(owner.tabId, state, epoch)) return false;
      return apply(owner.tabId, state, epoch, message.dark ? 'tidy-white' : 'tidy-outlined');
    });
  }

  async function syncTab(tabId, state, epoch) {
    if (!current(tabId, state, epoch)) return;
    const tab = await chrome.tabs.get(tabId);
    if (!isChatgptUrl(tab?.url) || !current(tabId, state, epoch)) return;
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    if (!frame?.documentId || frame.documentLifecycle !== 'active' || !isChatgptUrl(frame.url)
      || !current(tabId, state, epoch)) return;
    // 不在图标队列中等待：reporter 会先反向发送 changed 并等 setIcon 确认。
    // 不存在 receiver 时让此操作结束，不为旧页补注入脚本。
    await chrome.tabs.sendMessage(tabId, SYNC, { documentId: frame.documentId });
  }

  async function refresh(tabId) {
    if (!isValidTabId(tabId)) return;
    const { state, epoch, done } = reset(tabId);
    await done;
    await syncTab(tabId, state, epoch);
  }

  async function syncPanels() {
    // runtime 广播只到扩展文档；面板根据自身固定 owner 再报告，不接收活动 tab 猜测。
    return chrome.runtime.sendMessage(SYNC);
  }

  function ignoreFailure(promise) { void Promise.resolve(promise).catch(() => {}); }
  function listen(event, listener) { event?.addListener(listener); }
  // 事件必须在 Worker 顶层创建时同步注册。可选注册仅用于不含浏览器 API 的测试宿主；
  // 真实消息的来源校验仍 fail closed，不因缺少 API 而放行。
  listen(chrome.tabs?.onActivated, ({ tabId }) => { ignoreFailure(refresh(tabId)); ignoreFailure(syncPanels()); });
  listen(chrome.tabs?.onUpdated, (tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === 'complete') {
      ignoreFailure(refresh(tabId)); ignoreFailure(syncPanels());
    }
  });
  listen(chrome.tabs?.onRemoved, close);
  listen(chrome.tabs?.onReplaced, (addedTabId, removedTabId) => {
    close(removedTabId); ignoreFailure(refresh(addedTabId)); ignoreFailure(syncPanels());
  });
  listen(chrome.webNavigation?.onCommitted, details => {
    if (details.frameId === 0 && details.documentLifecycle === 'active') {
      ignoreFailure(refresh(details.tabId)); ignoreFailure(syncPanels());
    }
  });

  function start() {
    if (!starting) starting = (async () => {
      await chrome.action.setIcon({ path: paths('tidy-outlined') });
      const tabs = await chrome.tabs.query({});
      // 浏览器持有的 tab-specific 图标可跨 Worker 休眠存在。冷启动先去除旧假设，
      // 再向现有文档请求现值；无本地存储、保活 timer 或 offscreen 宿主。
      await Promise.allSettled(tabs.filter(tab => isValidTabId(tab.id)).map(tab => refresh(tab.id)));
      await Promise.resolve(syncPanels()).catch(() => {});
    })();
    return starting;
  }

  return Object.freeze({ acceptReport, start });
}

