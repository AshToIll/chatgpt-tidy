// 收藏与书签的 portal 浮层统一按栏目可见边界定位，不跨出侧栏或分组容器。
export function positionLibraryOverlay({ layer, overlay, anchor }) {
  if (!layer || !overlay || !anchor) return;
  const bounds = layer.getBoundingClientRect();
  const rect = anchor.getBoundingClientRect();
  const width = Math.max(0, bounds.width ?? bounds.right - bounds.left);
  const height = Math.max(0, bounds.height ?? bounds.bottom - bounds.top);
  const margin = 4;
  const maxWidth = Math.max(0, width - margin * 2);
  const maxHeight = Math.max(0, height - margin * 2);
  overlay.style.maxWidth = maxWidth + "px";
  overlay.style.maxHeight = maxHeight + "px";
  overlay.style.overflowY = "auto";

  // 长移组菜单优先只滚中间分组列表，标题与取消收藏/书签仍留在视野内。
  // 每次先去掉上次的局部约束，窗口变大时能恢复 CSS 原本的上限。
  const groups = overlay.querySelector(".library-entry-menu__groups");
  if (groups) {
    groups.style.maxHeight = "";
    const groupHeight = groups.offsetHeight;
    const chromeHeight = Math.max(0, overlay.scrollHeight - groupHeight);
    groups.style.maxHeight = Math.max(0, Math.min(groupHeight, maxHeight - chromeHeight)) + "px";
  }
  const overlayWidth = Math.min(overlay.offsetWidth, maxWidth);
  const overlayHeight = Math.min(overlay.offsetHeight, maxHeight);
  const left = Math.max(margin, Math.min(width - overlayWidth - margin, rect.right - bounds.left - overlayWidth));
  const below = rect.bottom - bounds.top + margin;
  const preferredTop = below + overlayHeight <= height - margin
    ? below : rect.top - bounds.top - overlayHeight - margin;
  const top = Math.max(margin, Math.min(height - overlayHeight - margin, preferredTop));
  overlay.style.left = left + "px";
  overlay.style.top = top + "px";
}
