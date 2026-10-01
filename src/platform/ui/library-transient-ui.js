// 收藏与书签只共用浮层生命周期；菜单目标和业务数据仍由各栏目持有。
export function createLibraryTransientUi({ root, getState, isInside, close, render, onHidden = () => {} }) {
  const document = root.ownerDocument;
  const insideClicks = new WeakMap();
  let revision = 0;
  let disposed = false;

  function invalidate() { revision += 1; }

  function queueFocus(find, { select = false } = {}) {
    const scheduled = revision;
    requestAnimationFrame(() => {
      if (disposed || scheduled !== revision || document?.hidden) return;
      const control = find();
      if (!control || !root.contains(control)) return;
      control.focus({ preventScroll: true });
      if (select) control.select();
    });
  }

  function dismiss({ restoreFocus = false, rerender = true } = {}) {
    const state = getState();
    invalidate();
    if (!state.open) return false;
    close();
    if (rerender) render();
    if (restoreFocus && state.findTrigger) queueFocus(state.findTrigger);
    return true;
  }

  // 捕获阶段只记住点击归属，不改 DOM。菜单切成图标层后旧按钮会脱离，
  // 冒泡时重新检查旧 target 会误判为外部点击，立刻关掉刚打开的新浮层。
  function captureClick(event) { insideClicks.set(event, Boolean(isInside(event.target))); }
  function click(event) {
    const inside = insideClicks.has(event) ? insideClicks.get(event) : Boolean(isInside(event.target));
    insideClicks.delete(event);
    if (!inside && getState().open) dismiss();
  }
  function keydown(event) {
    if (event.defaultPrevented || event.isComposing || event.key !== "Escape" || !getState().open) return;
    event.preventDefault();
    event.stopPropagation();
    dismiss({ restoreFocus: true });
  }
  function visibilitychange() {
    if (!document.hidden) return;
    dismiss();
    onHidden();
  }
  document?.addEventListener?.("click", captureClick, true);
  document?.addEventListener?.("click", click);
  document?.addEventListener?.("keydown", keydown);
  document?.addEventListener?.("visibilitychange", visibilitychange);

  function dispose() {
    if (disposed) return;
    dismiss({ rerender: false });
    disposed = true;
    document?.removeEventListener?.("click", captureClick, true);
    document?.removeEventListener?.("click", click);
    document?.removeEventListener?.("keydown", keydown);
    document?.removeEventListener?.("visibilitychange", visibilitychange);
  }
  return Object.freeze({ dismiss, queueFocus, invalidate, dispose });
}
