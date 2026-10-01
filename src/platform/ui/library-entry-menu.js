import { escapeHtml } from "./html.js";

// 两栏只共享移组菜单的呈现。目标条目、有效分组和写入权限由各自栏目验证。
export function libraryEntryMenuMarkup({ heading, groups, removeLabel }) {
  const choices = groups.map(({ id, label, current }) => '<button type="button" data-library-move-group="' + escapeHtml(id)
    + '" role="menuitemradio" aria-checked="' + Boolean(current) + '"' + (current ? ' class="is-current" disabled' : '') + '>' + escapeHtml(label) + '</button>').join("");
  return '<div class="library-entry-menu" role="menu" aria-label="' + escapeHtml(heading) + '"><div class="library-entry-menu__heading">' + escapeHtml(heading)
    + '</div><div class="library-entry-menu__groups" role="group">' + choices + '</div><button type="button" class="is-danger" data-library-remove role="menuitem">' + escapeHtml(removeLabel) + '</button></div>';
}
