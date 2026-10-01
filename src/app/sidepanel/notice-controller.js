import "../../messages/notice-lifecycle.js";

// 通知控制器只拥有呈现与导航提示授权；计时和旧实例隔离统一交给生命周期核心。
// translate 每次渲染时调用，所以四种语言切换不会重启倒计时或替换焦点节点。
export const NOTICE_TIMING = Object.freeze({ successMs: 2400, searchErrorMs: 5000 });

export function createNoticeController({
  root,
  translate,
  isReady,
  isCurrentNavigation,
  document = globalThis.document,
  diagnostics = globalThis.ChatGPTTidyDiagnostics,
  lifecycleCore = globalThis.ChatGPTTidyNoticeLifecycle,
  now = Date.now,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
}) {
  const searchOwner = lifecycleCore.createOwner();
  let searchIntentId = null;
  let searchToken = null;
  let disposed = false;
  let pointerInside = false;
  let focusInside = false;
  const slot = lifecycleCore.createSlot({
    now, setTimer, clearTimer,
    onChange(current, change) {
      if (!current) {
        root.hidden = true;
        root.replaceChildren();
        pointerInside = false;
        focusInside = false;
        syncPause();
        diagnostics?.notice({ event: "clear", surface: "shell.toast", reasonCode: change.reason });
        return;
      }
      root.hidden = false;
      root.classList.toggle("is-error", current.error);
      root.replaceChildren(current.label, ...(current.close ? [current.close] : []));
      // 删除焦点节点不保证触发 focusout；重算实际状态，避免新提示永久暂停。
      focusInside = isInside(document.activeElement);
      if (root.matches) pointerInside = root.matches(":hover");
      syncPause();
      diagnostics?.notice({
        event: "show", surface: "shell.toast", messageKey: current.key,
        source: "src/app/sidepanel/notice-controller.js",
        reasonCode: current.error ? "OBSERVATION_ONLY_UNSPECIFIED" : "UI_INFORMATIONAL_NOTICE",
        ...diagnostics?.cause(current.cause),
        ...(current.cause ? {} : {
          reasonCode: current.error ? "OBSERVATION_ONLY_UNSPECIFIED" : "UI_INFORMATIONAL_NOTICE",
        }),
        navigationIntentId: current.navigationIntentId || current.terminalNavigationIntentId,
      });
      renderToast();
    },
  });

  // 阅读中的短提示暂停“剩余时间”，不是重新开始五秒。核心独占所有计时器。
  function isInside(target) { return Boolean(target && root.contains?.(target)); }
  function syncPause() {
    if (!disposed) slot.setPaused(Boolean(pointerInside || focusInside || document.hidden));
  }
  function onPointerOver(event) {
    if (disposed || isInside(event.relatedTarget)) return;
    pointerInside = true;
    syncPause();
  }
  function onPointerOut(event) {
    if (disposed || isInside(event.relatedTarget)) return;
    pointerInside = false;
    syncPause();
  }
  function onFocusIn(event) {
    if (disposed || isInside(event.relatedTarget)) return;
    focusInside = true;
    syncPause();
  }
  function onFocusOut(event) {
    if (disposed || isInside(event.relatedTarget)) return;
    focusInside = false;
    syncPause();
  }
  const rootListeners = { pointerover: onPointerOver, pointerout: onPointerOut,
    focusin: onFocusIn, focusout: onFocusOut };
  for (const [type, listener] of Object.entries(rootListeners)) root.addEventListener(type, listener);
  document.addEventListener?.("visibilitychange", syncPause);
  syncPause();

  function dismissToast() {
    slot.clear(slot.current(), "NOTICE_DISMISSED");
  }

  function renderToast() {
    const notice = slot.current();
    if (!notice) return;
    if (disposed || !isReady()) { dismissToast(); return; }
    const { key, values, label, close } = notice;
    const message = translate(key, values);
    if (label.textContent !== message) label.textContent = message;
    if (close) close.setAttribute("aria-label", translate("exportJobDismiss"));
  }

  // 默认成功提示 2.4 秒；写入结果未知属于 operation，必须等待手动关闭。
  // 只读导航失败显式传 durationMs 与导航 owner/intent，不能把未知写入偷偷改成短提示。
  function showToast(key, error = false, values = {}, lifecycle = {}) {
    if (disposed || !isReady()) return false;
    const navigationIntentId = lifecycle.navigationIntentId || null;
    // 终态 ID 仅用于已准入 coordinator 的结果关联；取消后的 ID 不再拥有执行权限。
    const terminalNavigationIntentId = lifecycle.terminalNavigationIntentId || null;
    if (navigationIntentId && terminalNavigationIntentId) throw new TypeError("Active and terminal navigation intents are mutually exclusive");
    if (navigationIntentId && !isCurrentNavigation(navigationIntentId)) return false;
    const durationMs = lifecycle.durationMs ?? (error ? null : NOTICE_TIMING.successMs);
    const kind = lifecycle.kind || (durationMs === null ? "operation" : "transient");
    const label = document.createElement("span");
    let close = null;
    let shownNotice = null;
    if (error && durationMs === null) {
      close = document.createElement("button");
      close.type = "button";
      close.textContent = "×";
      close.addEventListener("click", () => slot.clear(shownNotice, "NOTICE_DISMISSED"));
    }
    shownNotice = slot.replace({
      kind, key, error, values: { ...values }, label, close,
      owner: lifecycle.owner || null, navigationIntentId, terminalNavigationIntentId, cause: lifecycle.cause || null,
    }, {
      ...(durationMs === null ? {} : { ttlMs: durationMs }),
      ...(lifecycle.owner === "search" && navigationIntentId
        ? { owner: searchOwner, token: searchToken } : {}),
    });
    return Boolean(shownNotice);
  }

  // 仅清理指定归属；没有 intent 的未知写入不会被其他导航的回执误清。
  function dismissOwnedToast(owner, navigationIntentId) {
    if (owner === "search" && (navigationIntentId === undefined || searchIntentId === navigationIntentId)) {
      searchIntentId = null;
      searchToken = null;
      searchOwner.revoke();
    }
    const current = slot.current();
    if (current?.owner !== owner
      || (navigationIntentId !== undefined && (current.navigationIntentId || current.terminalNavigationIntentId) !== navigationIntentId)) return false;
    return slot.clear(current, "NOTICE_DISMISSED");
  }

  // 协调层在新导航、离栏或取消后传入当前 intent（没有则 null）。
  // 只读导航提示随权限撤销；与导航无关的写入 unknown 保持可核对。
  function reconcileNavigationNotice(currentIntentId = null) {
    if (searchIntentId !== null && searchIntentId !== currentIntentId) {
      searchIntentId = null;
      searchToken = null;
      searchOwner.revoke();
    }
    const current = slot.current();
    const staleActive = current?.navigationIntentId && current.navigationIntentId !== currentIntentId;
    // openFailed 已先取消导航再发布终态；随后的重复 null 不得吞掉结果。
    // 新意图会撤销旧终态，离栏/隐藏由协调层显式撤销所属 owner。
    const staleTerminal = current?.terminalNavigationIntentId && currentIntentId
      && current.terminalNavigationIntentId !== currentIntentId;
    if (staleActive || staleTerminal) return slot.clear(current, "NOTICE_DISMISSED");
    return false;
  }

  function dismissSearchToast() {
    return dismissOwnedToast("search");
  }

  function beginSearchNotice(navigationIntentId) {
    if (disposed || !isCurrentNavigation(navigationIntentId)) return false;
    dismissSearchToast();
    searchIntentId = navigationIntentId;
    searchToken = searchOwner.begin();
    return true;
  }

  function finishSearchNotice(navigationIntentId) {
    if (!isCurrentNavigation(navigationIntentId) || searchIntentId !== navigationIntentId) return false;
    dismissOwnedToast("search", navigationIntentId);
    return true;
  }

  function showSearchToast(key, navigationIntentId = null, cause = null) {
    if (navigationIntentId !== null) {
      if (!isCurrentNavigation(navigationIntentId) || searchIntentId !== navigationIntentId) return false;
    } else {
      // 导出来源失效不是导航回执，但仍属于搜索；接管提示不修改导出流程。
      searchIntentId = null;
      searchToken = null;
      searchOwner.revoke();
    }
    return showToast(key, true, {}, {
      owner: "search", navigationIntentId, durationMs: NOTICE_TIMING.searchErrorMs, cause,
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [type, listener] of Object.entries(rootListeners)) root.removeEventListener?.(type, listener);
    document.removeEventListener?.("visibilitychange", syncPause);
    searchIntentId = null;
    searchToken = null;
    searchOwner.dispose();
    slot.dispose();
    root.hidden = true;
    root.replaceChildren();
  }

  return Object.freeze({
    showToast, dismissToast, renderToast, dismissOwnedToast, reconcileNavigationNotice,
    beginSearchNotice, finishSearchNotice, showSearchToast, dismissSearchToast, dispose,
  });
}
