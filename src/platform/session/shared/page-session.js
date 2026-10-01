// 一个网页文档只有一次扩展生命周期。账号切换、SPA 路由和 Worker 休眠不结束它；
// 扩展上下文失效后不可复活，必须由浏览器刷新/新建文档重新加载完整脚本。
(function initPageSessionContract(global) {
  "use strict";

  const ATTRIBUTE = "data-tidy-page-session";
  const RETIRED_EVENT = "chatgpt-tidy:page-session-retired";
  const CHECK_EVENT = "chatgpt-tidy:page-session-check";
  // 只检查本地 runtime.id，不发消息、不唤醒 Worker，不扫描页面 DOM。
  const INVALIDATION_CHECK_MS = 1000;

  function create({ runtime = null, watch = false } = {}) {
    const controller = new AbortController();
    const disposers = new Set();
    let retired = false;
    let interval = null;
    let suppressPointerClick = false;
    const document = global.document;

    function error() {
      return Object.assign(new Error("The extension was reloaded. Refresh the ChatGPT page."), {
        code: "ADAPTER_UNAVAILABLE", tidyCode: "ADAPTER_UNAVAILABLE",
        details: { stage: "page-session", disconnect: "context-invalidated" },
      });
    }

    function stop() {
      if (retired) return;
      // 先关闭总闸，再通知取消和清理。清理触发的 observer/Promise 不能重建 UI。
      retired = true;
      if (interval !== null) global.clearInterval(interval);
      interval = null;
      document?.documentElement?.setAttribute(ATTRIBUTE, "retired");
      document?.removeEventListener?.(RETIRED_EVENT, stop);
      if (runtime) document?.removeEventListener?.(CHECK_EVENT, check);
      // DOM 标记/事件只传播停机状态，绝不是可信账号身份或权限凭据。
      document?.dispatchEvent?.(new Event(RETIRED_EVENT));
      controller.abort(error());
      for (const dispose of [...disposers]) {
        try { dispose(); } catch { /* 一个模块清理失败不能阻止其他模块退役。 */ }
      }
      disposers.clear();
    }

    function check() {
      if (retired) return false;
      // MAIN 无扩展 API。每个副作用/异步续程都同步让 ISOLATED 验 runtime.id，
      // 不能等下一秒 watchdog 才发现重载。此 DOM 事件不发 IPC，也不唤醒 Worker。
      if (!runtime) document?.dispatchEvent?.(new Event(CHECK_EVENT));
      if (retired) return false;
      let runtimeValid = true;
      if (runtime) {
        try { runtimeValid = Boolean(runtime.id); } catch { runtimeValid = false; }
      }
      if (!runtimeValid || document?.documentElement?.getAttribute(ATTRIBUTE) === "retired") {
        stop();
        return false;
      }
      return true;
    }

    function assertActive() { if (!check()) throw error(); }

    function onDispose(dispose) {
      if (retired) { dispose(); return () => {}; }
      disposers.add(dispose);
      return () => disposers.delete(dispose);
    }

    async function runtimeRequest(envelope) {
      assertActive();
      let release;
      try {
        const response = await new Promise((resolve, reject) => {
          const abort = () => reject(error());
          controller.signal.addEventListener("abort", abort, { once: true });
          release = () => controller.signal.removeEventListener("abort", abort);
          // 同步 dispatch，不把写操作排进可能在停机后才执行的微任务。
          try {
            Promise.resolve(runtime.sendMessage(envelope)).then(resolve, reject);
          } catch (cause) {
            // Chrome 可同步抛失效；同一个启动栈中的后续模块也必须立刻看到停机。
            if (/extension context invalidated/i.test(String(cause?.message || cause))) stop();
            reject(cause);
          }
        });
        assertActive();
        return response;
      } catch (cause) {
        // Port/Worker 临时断连不等于扩展重载；仅明确上下文失效才永久停机。
        if (/extension context invalidated/i.test(String(cause?.message || cause))) stop();
        assertActive();
        throw cause;
      } finally {
        release?.();
      }
    }

    function guardInteraction(event) {
      // 必须在 check 的清理移除节点前记录归属，防旧星星点击穿透到原生会话链接。
      const owned = event.composedPath?.().some(node => node?.hasAttribute?.("data-tidy-owned"))
        || Boolean(event.target?.closest?.("[data-tidy-owned]"));
      const active = check();
      // 移除旧按钮可能让随后的 click 重新命中下方原生链接；同一手势仍须取消。
      if (event.type === "pointerdown") suppressPointerClick = !active && owned;
      const blocked = !active && (owned || (event.type === "click" && suppressPointerClick));
      if (event.type === "click") suppressPointerClick = false;
      if (blocked) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }

    document?.addEventListener?.(RETIRED_EVENT, stop);
    if (runtime) document?.addEventListener?.(CHECK_EVENT, check);
    if (check()) document?.documentElement?.setAttribute(ATTRIBUTE, "active");
    if (runtime && watch && check()) {
      const events = ["pointerdown", "mousedown", "click", "keydown"];
      for (const name of events) global.addEventListener(name, guardInteraction, true);
      const verify = () => check();
      global.addEventListener("focus", verify, true);
      global.addEventListener("pageshow", verify, true);
      document.addEventListener("visibilitychange", verify, true);
      interval = global.setInterval(verify, INVALIDATION_CHECK_MS);
      onDispose(() => {
        // 保留交互捕获门禁：已经开始的 pointer 序列和分离节点上的 click 仍须吞掉。
        // document 销毁会一起释放它；原生目标始终透传。
        global.removeEventListener("focus", verify, true);
        global.removeEventListener("pageshow", verify, true);
        document.removeEventListener("visibilitychange", verify, true);
      });
    }
    return Object.freeze({ check, assertActive, onDispose, stop, error,
      runtimeRequest, signal: controller.signal });
  }

  global.TidyPageSessionContract = Object.freeze({ create, ATTRIBUTE, RETIRED_EVENT, CHECK_EVENT, INVALIDATION_CHECK_MS });
})(globalThis);
