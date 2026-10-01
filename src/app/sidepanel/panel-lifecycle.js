// 面板文档级生命周期：这里只编排窄能力，不读取/持有业务 state。
// 导航按钮、关闭按钮、Escape 与重试入口仍由外壳各自处理。
const GUARDED_EVENTS = Object.freeze(["click", "change", "input", "keydown", "submit", "pointerdown"]);
const BUSINESS_CONTROL_SELECTOR = "[data-view], #time-display-control";

export function installPanelLifecycle({
  document, window, isReady, getRoute, getContextError, refreshContext, dismissNotice,
  session, navigation, bookmarks, search, library, titles, preferences, titleRules,
  time, settings, backup, filing,
}) {
  let disposed = false;
  const removeListeners = [];
  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    removeListeners.push(() => target.removeEventListener(type, handler, options));
  }

  function guardInteraction(event) {
    if (disposed || isReady() || !event.target?.closest?.(BUSINESS_CONTROL_SELECTOR)) return;
    // 只有当前设置栏底部的排查日志是本地支持能力；它不发送任何业务命令。
    // 限定真实归属与当前路由，不可给整栏、其他栏目或脱离归属的同名节点放行。
    if (getRoute() === "settings" && event.target.closest("#settings-view > #settings-diagnostics")) return;
    // inert 拦物理输入；捕获阶段也要挡住合成事件，不能绕过页面准入。
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function beforeUnload(event) {
    if (disposed) return;
    // isBusy 由装配层映射现有 !titleView.canLeave()，不引入第二份 busy 状态。
    // 即使浏览器不显示确认框，写入检查点也仍由标题模块独立负责。
    if (isReady() && getRoute() === "titles" && titles.isBusy()) {
      event.preventDefault();
      event.returnValue = "";
    }
  }

  function visibilityChanged() {
    if (disposed) return;
    if (document.hidden) navigation.close();
    library.setVisible(isReady() && !document.hidden);
    if (document.hidden) bookmarks.cancel();
    search.setVisible(isReady() && !document.hidden);
    // 复用标题模块的可见性更新：隐藏会暂停下一批步骤，回来只读恢复回执，
    // 此编排器没有 apply/step 能力，因此不能自动继续写入。
    titles.render();
    filing.syncFavorites();
    filing.syncBookmarks();
    if (!document.hidden) {
      // 一次显式可见性变化只发一次握手，不建立 timer 或重试轮询。
      if (!isReady()) { void session.check(); return; }
      if (getRoute() === "time") time.becameVisible();
      if (getContextError()) void refreshContext();
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    // pagehide 的 once 与显式 dispose 共用同一个门，避免重复销毁/请求。
    for (const remove of removeListeners.splice(0)) remove();
    dismissNotice();
    session.dispose();
    preferences.dispose();
    titleRules.dispose();
    backup.dispose();
    time.dispose();
    settings.dispose();
    navigation.close("panel-closed");
    bookmarks.dispose();
    library.dispose();
    try {
      search.setVisible(false);
      titles.suspend();
      void titles.pauseCatalog();
    } finally {
      // 即使最后的 view teardown 抛错，也不能遗留关闭面板的归档目标。
      filing.closeFavorites();
      filing.closeBookmarks();
    }
  }

  for (const type of GUARDED_EVENTS) listen(document, type, guardInteraction, true);
  listen(window, "beforeunload", beforeUnload);
  listen(document, "visibilitychange", visibilityChanged);
  listen(window, "pagehide", dispose, { once: true });
  return Object.freeze({ dispose });
}
