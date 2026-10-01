// 每个栏目创建一个客户。它只拥有 Port、重连计时器和关闭标记；
// 哪个分组当前可归档由栏目自己的 getContext 决定，不由连接层推断。
export const FILING_RECONNECT_MS = 250;

export function createFilingContextClient({
  runtime,
  protocol,
  ownerTabId,
  type,
  name,
  getContext,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
}) {
  let port = null;
  let reconnectTimer = null;
  let closed = false;

  function sync() {
    if (!port) return;
    try {
      const { accountKey = null, groupId = null } = getContext();
      port.postMessage(protocol.event(type, {
        tabId: ownerTabId,
        accountKey,
        // 关闭前必须撤销归档目标，即使调用方仍保留最后一个分组。
        groupId: closed ? null : groupId,
      }));
    } catch {
      // 扩展重新加载后旧 Port 可能失效；worker 的断连事件负责最终清理。
    }
  }

  function connect() {
    clearTimer(reconnectTimer);
    reconnectTimer = null;
    if (port || closed || !runtime?.id) return;
    try {
      const next = runtime.connect({ name });
      port = next;
      next.onDisconnect.addListener(() => {
        if (port !== next) return;
        port = null;
        if (closed || !runtime?.id) return;
        clearTimer(reconnectTimer);
        reconnectTimer = setTimer(connect, FILING_RECONNECT_MS);
      });
      sync();
    } catch {
      port = null;
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    clearTimer(reconnectTimer);
    reconnectTimer = null;
    sync();
    const previous = port;
    port = null;
    try { previous?.disconnect(); } catch { /* 扩展上下文可能已经失效。 */ }
  }

  return Object.freeze({ connect, sync, close });
}
