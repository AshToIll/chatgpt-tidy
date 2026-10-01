import { createSidePanelPath, isValidTabId } from "../panel-owner.js";

const CHATGPT_URLS = ["https://chatgpt.com/*"];
// 面板冷启动可领取一次最近的路由请求；超过一分钟的点击不再改变当前界面。
const ROUTE_LIFETIME_MS = 60_000;

/**
 * 拥有 Side Panel 的浏览器配置、临时路由和归档 Port 生命周期。
 * 此工厂不注册浏览器级监听器；组合根同步注册后，转交对应事件即可。
 * binding 只提供 URL/所有权判断，不在这里引入页面探测或账号读取。
 */
export function createPanelHost({
  chrome,
  protocol,
  binding,
  favoriteFilingContexts,
  bookmarkFilingContexts,
}) {
  const pendingRoutes = new Map();

  async function configure(tabId, url) {
    if (!isValidTabId(tabId)) return;
    await chrome.sidePanel.setOptions({
      tabId,
      path: createSidePanelPath(tabId),
      enabled: binding.isChatgptUrl(url),
    });
  }

  function reportError(error, operation, tabId = null) {
    // 标签可能在事件到达后关闭；只忽略对应标签的精确关闭错误。
    // 权限、配置等真正失败仍要保留诊断，不能全部吞掉或无限重试。
    if (isValidTabId(tabId) && error?.message === `No tab with id: ${tabId}.`) return;
    console.error("TIDY side panel setup failed", {
      operation,
      tabId,
      message: String(error?.message || error),
    });
  }

  async function initialize() {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      const tabs = await chrome.tabs.query({ url: CHATGPT_URLS });
      await Promise.all(tabs.map(tab => configure(tab.id, tab.url)
        .catch(error => reportError(error, "configure", tab.id))));
    } catch (error) {
      reportError(error, "initialize");
    }
  }

  function startBehavior() {
    return chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .catch(error => reportError(error, "behavior"));
  }

  function open(tabId) {
    // 必须在原点击处理的同步调用栈内触达浏览器 API；不要先等待 IPC/探测。
    // 调用方负责验证点击来源、标签和业务权限。
    return chrome.sidePanel.open({ tabId });
  }

  function publishContext(details, reason) {
    // SPA 和完整文档切换共用此通知边界。BFCache 恢复可能没有新快照，
    // 因此归属变更由组合根验证过的浏览器事件发布，而非快照差异推断。
    if (!binding.isChatgptUrl(details.url)) return;
    chrome.runtime.sendMessage(protocol.event(protocol.Type.CONTEXT_CHANGED, {
      reason,
      tabId: details.tabId,
      url: details.url,
      ...(typeof details.documentId === "string" ? { documentId: details.documentId } : {}),
    })).catch(() => {});
  }

  function requestRoute(route) {
    // 业务方完成导航及账号校验后才交付路由；保存和广播同一份请求，
    // 已打开的面板立即接收，冷启动面板则通过 takeRoute 领取。
    pendingRoutes.set(route.tabId, route);
    chrome.runtime.sendMessage(protocol.event(protocol.Type.PANEL_ROUTE_REQUESTED, route))
      .catch(() => {});
  }

  function takeRoute(tabId, sender) {
    const pendingRoute = pendingRoutes.get(tabId);
    const requestedRoute = pendingRoute && Date.now() - pendingRoute.createdAt < ROUTE_LIFETIME_MS
      ? pendingRoute : null;
    // getBoundTab 已核对发件方与 tabId；内容脚本读取上下文不能抢走面板路由。
    if (requestedRoute && binding.isSidePanelDocumentUrl(sender?.url)) pendingRoutes.delete(tabId);
    return requestedRoute;
  }

  function closeTab(tabId) {
    pendingRoutes.delete(tabId);
  }

  function acceptPort(port) {
    const isFavorites = port.name === protocol.FAVORITES_FILING_PORT;
    const isBookmarks = port.name === protocol.BOOKMARKS_FILING_PORT;
    if (!isFavorites && !isBookmarks) return;

    const portOwner = binding.isSidePanelDocumentUrl(port.sender?.url)
      ? binding.panelOwnerTabId(port.sender.url) : null;
    if (!isValidTabId(portOwner)) { port.disconnect(); return; }
    port.onMessage.addListener(envelope => {
      if (envelope?.payload?.tabId !== portOwner) {
        favoriteFilingContexts.clear(port);
        bookmarkFilingContexts.clear(port);
        return;
      }
      if (!protocol.isEnvelope(envelope) || envelope.kind !== protocol.Kind.EVENT) return;
      if (isFavorites && envelope.type === protocol.Type.FAVORITES_FILING_CONTEXT) {
        favoriteFilingContexts.update(port, envelope.payload || {});
      }
      if (isBookmarks && envelope.type === protocol.Type.BOOKMARKS_FILING_CONTEXT) {
        bookmarkFilingContexts.update(port, envelope.payload || {});
      }
    });
    // Port 就是临时归档目的地的寿命；关闭面板、切换路由或扩展都会清除。
    port.onDisconnect.addListener(() => {
      if (isFavorites) favoriteFilingContexts.clear(port);
      if (isBookmarks) bookmarkFilingContexts.clear(port);
    });
  }

  return Object.freeze({
    configure,
    reportError,
    initialize,
    publishContext,
    requestRoute,
    takeRoute,
    closeTab,
    acceptPort,
    open,
    startBehavior,
  });
}
