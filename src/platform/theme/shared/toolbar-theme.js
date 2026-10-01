// 只读窗口原生明暗偏好；不读取网页 class、背景色或 TIDY 自己的配色设置。
// offscreen 没有浏览器窗口的颜色来源，禁止在那里启动这个 reporter。
(function registerToolbarTheme(global) {
  "use strict";
  const CHANNEL = "tidy.toolbar-theme.v1";

  function start({ runtime, session = null }) {
    const media = global.matchMedia("(prefers-color-scheme: dark)");
    const document = global.document;
    let disposed = false, queue = Promise.resolve();
    function active() {
      if (disposed) return false;
      if (session && !session.check()) { dispose(); return false; }
      try { if (runtime.id) return true; } catch { /* 扩展重载后旧上下文不可再用。 */ }
      dispose();
      return false;
    }
    function publish() {
      const pending = queue.then(async () => {
        if (!active()) return false;
        // 执行时重读，避免后台标签页的延迟事件重放过期颜色。
        const message = { channel: CHANNEL, target: "service", type: "changed", dark: media.matches };
        const response = await (session ? session.runtimeRequest(message) : runtime.sendMessage(message));
        return active() && response?.ok === true;
      });
      // 不创建心跳、定时重试或错误 toast。下一次原生主题/显示事件会重新读值。
      queue = pending.catch(() => { active(); return false; });
      return queue;
    }
    const changed = () => { void publish(); };
    const visible = () => { if (document.visibilityState === "visible") changed(); };
    const leaving = event => { if (!event.persisted) dispose(); };
    function onMessage(message, sender, respond) {
      if (message?.channel !== CHANNEL || message.target !== "reporter" || message.type !== "sync"
        || !active() || sender?.id !== runtime.id || sender.tab
        || sender.url !== runtime.getURL("app/background/service-worker.js")) return false;
      publish().then(ok => {
        try { respond({ ok }); } catch { /* 重载/关闭文档后回复通道已不存在。 */ }
      });
      return true;
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      media.removeEventListener("change", changed);
      document.removeEventListener("visibilitychange", visible);
      global.removeEventListener("focus", changed);
      global.removeEventListener("pageshow", changed);
      global.removeEventListener("pagehide", leaving);
      try { runtime.onMessage.removeListener(onMessage); } catch { /* 失效上下文不再有可注销的通道。 */ }
    }
    if (!active()) return Object.freeze({ dispose });
    media.addEventListener("change", changed);
    document.addEventListener("visibilitychange", visible);
    global.addEventListener("focus", changed);
    global.addEventListener("pageshow", changed);
    global.addEventListener("pagehide", leaving);
    try { runtime.onMessage.addListener(onMessage); }
    catch { dispose(); return Object.freeze({ dispose }); }
    session?.onDispose(dispose);
    void publish();
    return Object.freeze({ dispose });
  }
  global.TidyToolbarTheme = Object.freeze({ start, CHANNEL });
})(globalThis);
