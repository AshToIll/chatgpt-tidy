(function initTidyChatgptMessageDom(global) {
  "use strict";
  if (global.TidyChatgptMessageDom) return;

  // 页面结构的唯一入口：MAIN 的身份核对、时间/书签展示和精确定位共用。
  // 原生两种消息容器可能随账号分批上线；不向页面伪造 data-message-id。
  const CLASSIC = "div[data-message-id]";
  const COMPOSED = "[data-chatgpt-search-message-ids]";
  function id(element) {
    const direct = element?.getAttribute?.("data-message-id");
    if (direct) return direct;
    const ids = [...new Set(String(element?.getAttribute?.("data-chatgpt-search-message-ids") || "").trim().split(/\s+/).filter(Boolean))];
    // 同一 ID 可重复出现；多个不同 ID 的聚合块不能冒充一条精确消息。
    return ids.length === 1 ? ids[0] : null;
  }
  function candidates(root = global.document) {
    const classic = [...root.querySelectorAll(CLASSIC)], composed = [...root.querySelectorAll(COMPOSED)];
    const elements = [...new Set([...classic, ...composed])].filter(element => !closest(element.parentElement));
    // 分批渲染时两种容器可以共存；最新消息仍按页面顺序判断，不能按选择器分组。
    return classic.length && composed.length
      ? elements.sort((a, b) => a.compareDocumentPosition(b) & 2 ? 1 : -1) : elements;
  }
  function targets(messageId, root = global.document) {
    const escaped = global.CSS.escape(messageId);
    return [...new Set([...root.querySelectorAll(`div[data-message-id="${escaped}"]`),
      ...root.querySelectorAll(`[data-chatgpt-search-message-ids~="${escaped}"]`)])]
      .filter(element => id(element) === messageId && !closest(element.parentElement));
  }
  function locator(element) {
    return { strategy: element.getAttribute("data-message-id") ? "data-message-id" : "data-chatgpt-search-message-ids", value: id(element) };
  }
  function find(value) {
    if (!["data-message-id", "data-chatgpt-search-message-ids"].includes(value?.strategy)) return null;
    return candidates().find(element => id(element) === value.value && locator(element).strategy === value.strategy) || null;
  }
  function closest(element) { return element?.closest?.(`[data-message-id], ${COMPOSED}`) || null; }
  function contentRoot(element) {
    const role = element?.matches?.("[data-message-author-role]") ? element : element?.querySelector?.("[data-message-author-role]");
    return role?.querySelector?.('[data-testid="message-content"], .markdown, [class~="prose"]') || role
      || element?.querySelector?.('[data-markdown-text-style="assistant-message"], [data-user-message-bubble]') || null;
  }
  const META_OWNER = "message-meta";
  function metadata(host) {
    // 时间与书签共用一行；它可在原生正文列内，但不能认领嵌套的另一条消息。
    return [...(host?.querySelectorAll?.('[data-tidy-owned="message-meta"]') || [])]
      .find(node => closest(node.parentElement) === host) || null;
  }
  function userActionBoundary(host) {
    const owned = selector => [...(host.querySelectorAll?.(selector) || [])]
      .filter(node => closest(node) === host && !node.closest('[data-tidy-owned]'));
    const bubbles = owned('[data-user-message-bubble]');
    const controls = owned('.turn-action-controls');
    if (bubbles.length !== 1 || controls.length !== 1) return null;
    // 只依赖已核对的正文/动作语义标记，不依赖按钮语言、Tailwind 层数或 hover 状态。
    // 找最近共同父下的动作分支，附件等其他正文节点仍留在它原来的顺序中。
    let bodyBranch = bubbles[0];
    for (let parent = bodyBranch.parentElement; parent; bodyBranch = parent, parent = parent.parentElement) {
      let actionBranch = controls[0];
      while (actionBranch.parentElement && actionBranch.parentElement !== parent) actionBranch = actionBranch.parentElement;
      if (actionBranch.parentElement === parent) {
        const children = [...parent.children];
        return bodyBranch !== actionBranch && children.indexOf(bodyBranch) < children.indexOf(actionBranch)
          ? { parent, before: actionBranch } : null;
      }
      if (parent === host) break;
    }
    return null;
  }
  function ensureMetadata(host, { role, key, position = "after" }) {
    let meta = metadata(host);
    if (!meta) { meta = global.document.createElement("div"); meta.dataset.tidyOwned = META_OWNER; }
    meta.dataset.tidyKey = key;
    meta.className = `tidy-message-meta tidy-message-meta--${role}`;
    meta.dataset.position = position;
    host.classList.add("tidy-message-meta-host");
    const boundary = position === "after" && role === "user" ? userActionBoundary(host) : null;
    if (position === "before") {
      if (host.firstElementChild !== meta) host.prepend(meta);
    } else if (boundary) {
      if (meta.parentElement !== boundary.parent || meta.nextElementSibling !== boundary.before) {
        boundary.parent.insertBefore(meta, boundary.before);
      }
    } else if (host.lastElementChild !== meta) {
      // 未知原生结构（含临时编辑态）不猜测，不移动原生节点；保持消息内安全位置。
      host.append(meta);
    }
    return meta;
  }
  function removeEmptyMetadata(meta) {
    if (meta?.dataset?.tidyOwned !== META_OWNER || meta.children.length) return;
    const host = closest(meta.parentElement);
    meta.remove();
    if (host && !metadata(host)) host.classList.remove("tidy-message-meta-host");
  }
  global.TidyChatgptMessageDom = Object.freeze({ candidates, targets, id, locator, find, closest, contentRoot,
    metadata, ensureMetadata, removeEmptyMetadata });
})(globalThis);
