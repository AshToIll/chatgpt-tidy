// 全屏预览只拥有页面租约、关闭回执与焦点归还，不读取或修改导出篮。
export function createExportPreviewController({ root, present, dismiss, onError = () => {} }) {
  let owner = { active: false, verified: false, accountKey: null }, lease = null, generation = 0;
  function close({ notifyPage = true, restoreFocus = false } = {}) {
    if (!lease) return;
    const previous = lease; lease = null; generation++;
    const document = root.ownerDocument, focused = document?.activeElement, opener = previous.opener;
    if (restoreFocus && owner.active && owner.verified && owner.accountKey === previous.accountKey
      && opener?.isConnected && root.contains(opener) && !opener.disabled && opener.getClientRects().length
      && (!focused || focused === document.body || focused === document.documentElement || focused === opener)) opener.focus({ preventScroll: true });
    if (notifyPage) void Promise.resolve().then(() => dismiss({ sessionId: previous.id, expectedAccountKey: previous.accountKey })).catch(() => {});
  }
  async function open(payload, opener) {
    if (lease || !payload || !owner.verified || !owner.active || owner.accountKey !== payload.expectedAccountKey) return false;
    const id = globalThis.crypto?.randomUUID?.() || `preview-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ticket = ++generation, accountKey = payload.expectedAccountKey;
    lease = { id, accountKey, opener };
    try {
      await present({ ...payload, sessionId: id });
      // 关闭/切账号在发送中发生时，迟到的打开回执必须马上关闭旧页面展示。
      if (ticket !== generation || lease?.id !== id || owner.accountKey !== accountKey) {
        await dismiss({ sessionId: id, expectedAccountKey: accountKey });
      }
    } catch (error) {
      if (ticket !== generation || lease?.id !== id) return false;
      lease = null; onError(error);
    }
    return true;
  }
  return Object.freeze({
    open, close, isOpen: () => Boolean(lease),
    updateOwner(next) {
      const changed = owner.accountKey !== next.accountKey || !next.active || !next.verified;
      owner = { active: Boolean(next.active), verified: Boolean(next.verified), accountKey: next.accountKey || null };
      if (changed) close();
    },
    handleClosed(id) { if (id && id === lease?.id) close({ notifyPage: false, restoreFocus: true }); },
  });
}
