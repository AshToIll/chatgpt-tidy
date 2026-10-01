// 设置底部的排查日志工具：只在用户点击时读取、复制或清空，不主动诊断或重试。
const SUCCESS_FEEDBACK_MS = 3000; // 产品可调：操作成功提示保留 3 秒，之后恢复安静状态。
let viewSequence = 0; // 独立实例拥有独立的辅助说明 ID，不依赖全局页面节点。

export function createDiagnosticsView({
  root, client, writeClipboard = text => globalThis.navigator.clipboard.writeText(text),
  setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout,
}) {
  // 静态控件只创建一次；切换语言不重建节点，不触发 I/O，也不会取消用户正在进行的操作。
  root.innerHTML = '<h2 data-diagnostics-title></h2><p data-diagnostics-scope></p>'
    + '<div class="settings-diagnostics__actions" data-diagnostics-actions><button type="button" data-diagnostics-copy></button>'
    + '<button type="button" data-diagnostics-clear></button></div>'
    + '<div class="settings-diagnostics__confirmation" data-diagnostics-confirmation role="group" hidden>'
    + '<p data-diagnostics-confirm-message></p><div class="settings-diagnostics__actions">'
    + '<button type="button" data-diagnostics-confirm-clear></button><button type="button" data-diagnostics-cancel-clear></button></div></div>'
    + '<p class="settings-diagnostics__status" data-diagnostics-status role="status" aria-live="polite" hidden></p>';
  root.classList.add("settings-diagnostics");
  const el = name => root.querySelector("[data-diagnostics-" + name + "]");
  const title = el("title"), scope = el("scope"), actions = el("actions");
  const copy = el("copy"), clear = el("clear"), status = el("status");
  const confirmation = el("confirmation"), confirmMessage = el("confirm-message");
  const confirmClear = el("confirm-clear"), cancelClear = el("cancel-clear");
  confirmMessage.id = "settings-diagnostics-clear-description-" + (++viewSequence);
  confirmClear.setAttribute("aria-describedby", confirmMessage.id);
  cancelClear.setAttribute("aria-describedby", confirmMessage.id);
  let t = key => key, statusKey = null, busy = false, confirming = false, disposed = false, operation = 0;
  let feedbackTimer = null, feedbackVersion = 0;

  function stopFeedbackTimer() {
    feedbackVersion++;
    if (feedbackTimer !== null) clearTimer(feedbackTimer);
    feedbackTimer = null;
  }
  function render() {
    title.textContent = t("diagnosticsTitle"); scope.textContent = t("diagnosticsScope");
    copy.textContent = t("diagnosticsCopy"); clear.textContent = t("diagnosticsClear");
    confirmMessage.textContent = t("diagnosticsClearConfirm");
    confirmation.setAttribute("aria-label", t("diagnosticsClear"));
    confirmClear.textContent = t("diagnosticsConfirmClear"); cancelClear.textContent = t("cancel");
    actions.hidden = confirming; confirmation.hidden = !confirming;
    status.textContent = busy ? t("diagnosticsBusy") : !statusKey ? ""
      : statusKey === "diagnosticsIncomplete"
        ? t("diagnosticsCopied") + " · " + t(statusKey) : t(statusKey);
    status.hidden = !status.textContent;
    copy.disabled = clear.disabled = busy;
    // 确认按钮保留焦点；aria-disabled 表达忙碌，下面的 busy 守卫阻止重复提交/取消。
    confirmClear.setAttribute("aria-disabled", String(busy)); cancelClear.setAttribute("aria-disabled", String(busy));
    root.setAttribute("aria-busy", String(busy));
  }
  function dismissSuccessLater() {
    const current = feedbackVersion;
    feedbackTimer = setTimer(() => {
      if (disposed || current !== feedbackVersion) return;
      feedbackTimer = null; statusKey = null; render();
    }, SUCCESS_FEEDBACK_MS);
  }
  function askToClear() {
    if (busy || disposed || confirming) return;
    stopFeedbackTimer(); statusKey = null; confirming = true; render();
    // 清空不可撤销，默认焦点放在取消，不让 Enter 误删历史记录。
    cancelClear.focus();
  }
  function cancelConfirmation() {
    if (busy || disposed || !confirming) return;
    confirming = false; render(); clear.focus();
  }
  async function run(kind) {
    if (busy || disposed || (kind === "clear" ? !confirming : confirming)) return;
    stopFeedbackTimer(); statusKey = null;
    busy = true; const current = ++operation; render();
    let next, succeeded = false;
    try {
      if (kind === "clear") {
        await client.clear(); next = "diagnosticsCleared"; succeeded = true;
      } else {
        let report;
        try { report = await client.exportText(); }
        catch { next = "diagnosticsReadFailed"; return; }
        if (disposed || current !== operation) return;
        try { await writeClipboard(report.text); }
        catch { next = "diagnosticsCopyFailed"; return; }
        next = report.incomplete ? "diagnosticsIncomplete" : "diagnosticsCopied";
        succeeded = true;
      }
    } catch { next = kind === "clear" ? "diagnosticsClearFailed" : "diagnosticsReadFailed"; }
    finally {
      if (!disposed && current === operation) {
        // 异步回执不能抢走已经切到其他栏目或控件的焦点。
        const restoreFocus = confirming && [confirmClear, cancelClear].includes(root.ownerDocument?.activeElement);
        busy = false; confirming = false; statusKey = next || null; render();
        if (succeeded) dismissSuccessLater();
        if (restoreFocus) clear.focus();
      }
    }
  }
  const onCopy = () => { void run("copy"); }, onClear = () => askToClear();
  const onConfirmClear = () => { void run("clear"); }, onCancelClear = () => cancelConfirmation();
  const onKeydown = event => {
    if (event.key === "Escape" && confirming && !busy && !disposed) {
      event.preventDefault(); cancelConfirmation();
    }
  };
  copy.addEventListener("click", onCopy); clear.addEventListener("click", onClear);
  confirmClear.addEventListener("click", onConfirmClear); cancelClear.addEventListener("click", onCancelClear);
  root.addEventListener("keydown", onKeydown);
  render();
  return Object.freeze({
    update({ translator }) { if (!disposed) { t = translator; render(); } },
    dispose() {
      if (disposed) return;
      disposed = true; operation++; stopFeedbackTimer();
      copy.removeEventListener("click", onCopy); clear.removeEventListener("click", onClear);
      confirmClear.removeEventListener("click", onConfirmClear); cancelClear.removeEventListener("click", onCancelClear);
      root.removeEventListener("keydown", onKeydown);
    },
  });
}
