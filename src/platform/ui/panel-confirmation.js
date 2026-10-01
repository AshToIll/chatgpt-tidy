// Side Panel 文档内的确认框。只收字符串和回焦函数，不知道分组或账号。
// 业务调用方在 await 后仍须检查自己的生命周期代际与目标是否有效。
let nextDialogId = 0;
export function createPanelConfirmation({ document }) {
  let dialog = null;
  let titleNode = null;
  let messageNode = null;
  let confirmButton = null;
  let cancelButton = null;
  let pending = null;
  let revision = 0;
  let focusOwner = null;
  let disposed = false;

  function finish(accepted, restoreFocus) {
    const request = pending;
    if (!request) return false;
    pending = null;
    const closed = ++revision;
    if (dialog.open) dialog.close();
    titleNode.textContent = "";
    messageNode.textContent = "";
    focusOwner = restoreFocus ? request.owner : null;
    request.resolve(accepted);
    if (restoreFocus && request.returnFocus) requestAnimationFrame(() => {
      if (disposed || closed !== revision || document.hidden) return;
      const target = request.returnFocus();
      if (target?.isConnected && request.owner?.contains(target)) target.focus({ preventScroll: true });
      focusOwner = null;
    });
    return true;
  }
  function createDialog() {
    if (dialog) return;
    const id = "library-confirmation-" + (++nextDialogId);
    dialog = document.createElement("dialog");
    dialog.className = "library-confirmation";
    dialog.setAttribute("aria-labelledby", id + "-title");
    dialog.setAttribute("aria-describedby", id + "-message");
    titleNode = document.createElement("h2");
    titleNode.id = id + "-title";
    titleNode.className = "library-confirmation__title";
    messageNode = document.createElement("p");
    messageNode.id = id + "-message";
    messageNode.className = "library-confirmation__message";
    const actions = document.createElement("div");
    actions.className = "library-confirmation__actions";
    cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.dataset.panelConfirmationCancel = "";
    confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.className = "library-confirmation__confirm";
    confirmButton.dataset.panelConfirmationAccept = "";
    cancelButton.addEventListener("click", () => finish(false, true));
    confirmButton.addEventListener("click", () => finish(true, true));
    // 在 keydown 冒泡到侧栏路由前处理 Esc，避免同时触发底层页面返回。
    dialog.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.isComposing || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finish(false, true);
    });
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(false, true); });
    // close 事件是异步派发的；旧请求的 close 不能取消已经 showModal 的新请求。
    dialog.addEventListener("close", () => { if (!dialog.open) finish(false, true); });
    actions.append(cancelButton, confirmButton);
    dialog.append(titleNode, messageNode, actions);
    document.body.append(dialog);
  }
  function cancel({ owner, restoreFocus = false } = {}) {
    // 已 resolve 的确认仍可能排着回焦；离栏时也要使这个旧 owner 的任务失效。
    if (owner && pending?.owner !== owner && focusOwner !== owner) return false;
    revision += 1;
    focusOwner = null;
    return finish(false, restoreFocus);
  }
  function ask({ owner, title, message, confirmLabel, cancelLabel, returnFocus }) {
    if (disposed) return Promise.resolve(false);
    cancel();
    createDialog();
    titleNode.textContent = String(title);
    messageNode.textContent = String(message);
    confirmButton.textContent = String(confirmLabel);
    cancelButton.textContent = String(cancelLabel);
    return new Promise((resolve) => {
      pending = { owner, resolve, returnFocus };
      dialog.showModal();
      // 默认落在取消，Enter 不会误删；原生 dialog 负责 Tab 焦点围栏与 Esc。
      cancelButton.focus({ preventScroll: true });
    });
  }
  function dispose() {
    if (disposed) return;
    cancel();
    disposed = true;
    dialog?.remove();
  }
  return Object.freeze({ ask, cancel, dispose });
}
