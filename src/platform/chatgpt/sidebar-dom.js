(function initTidyChatgptSidebarDom(global) {
  "use strict";
  if (global.TidyChatgptSidebarDom) return;

  // 主会话链接的统一边界：快照、日期、收藏和书签共用；不读取时间或修改原生 DOM。
  // 保留已支持的项目懒挂载路径，不依赖暂未出现的 data-sidebar-item 属性。
  const CANDIDATES = 'a[href^="/c/"], a[href*="/c/"], a[href^="/gg/"]';
  const CONTENT = 'main, [data-message-id], [data-chatgpt-search-message-ids], dialog, [role="dialog"], [aria-modal="true"]';

  function candidates(root = global.document) {
    return [...root.querySelectorAll(CANDIDATES)].filter((link) =>
      // 原生任务时钟也有相同 href 和 interactive-row-link，但自身 aria-hidden=true。
      // 只判断链接自身，不排除隐藏祖先：折叠项目里的真实会话副本仍须保留。
      String(link.getAttribute("aria-hidden")).toLowerCase() !== "true" && !link.closest(CONTENT),
    );
  }

  function findAll(locator, root = global.document) {
    if (locator?.strategy !== "href") return [];
    // 不去掉查询参数，也不按会话 ID 合并独立 DOM 行；维持精确 href 的展示绑定。
    return candidates(root).filter((link) => link.getAttribute("href") === locator.value);
  }

  function find(locator, root = global.document) {
    return findAll(locator, root)[0] || null;
  }

  global.TidyChatgptSidebarDom = Object.freeze({ candidates, findAll, find });
})(globalThis);
