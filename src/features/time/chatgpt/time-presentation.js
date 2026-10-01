(function initTidyChatgptTimePresentation(global) {
  "use strict";

  const protocol = global.TidyProtocol;
  const snapshotContract = global.TidySnapshot;
  const timeFormat = global.TidyTimeFormat;
  const domOwnership = global.TidyDomOwnership;
  const sidebarDom = global.TidyChatgptSidebarDom;
  const messageDom = global.TidyChatgptMessageDom;
  const bridge = global.TidyContentBridge;
  const session = global.TidyPageSession;
  if (!protocol || !snapshotContract || !timeFormat || !domOwnership || !sidebarDom || !messageDom || !bridge || !session || !session.check()
      || global.__tidyTimePresentationStarted) {
    return;
  }
  global.__tidyTimePresentationStarted = true;

  const SIDEBAR_OWNER = "sidebar-time";
  const MESSAGE_TIME_OWNER = "message-time";
  // 文案只在 messages/catalogs/time.json 维护；此处保留既有显示/关闭规则。
  const LOCALE_LABELS = global.TidyMessages.pageLabels.time;

  let preferences = null;
  let snapshot = null;
  let renderTimer = null;
  let snapshotGeneration = 0;
  let preferencesGeneration = 0;
  let stopped = false;
  let unsubscribeSnapshot = null;
  // 时间展示只响应这些设置；重点色变化不重新扫描正文和左栏、也不重新测量布局。
  const TIME_PREFERENCES = ["language", "timeZone", "dateFormat", "conversationTimeMode",
    "conversationTimePrecision", "messageTimePrecision", "messageTimePosition", "timeDisplayEnabled", "messageNumbersEnabled"];

  function requestRuntime(type, payload = null) {
    const envelope = protocol.request(type, payload);
    return session.runtimeRequest(envelope).then((response) => {
      if (!protocol.isResponse(response, envelope.requestId)) {
        throw new Error("Tidy service worker returned an invalid response");
      }
      if (!response.ok) throw new Error(response.error?.message || "Tidy request failed");
      return response.payload;
    });
  }

  function effectiveTimeZone() {
    return preferences?.timeZone === "system" || !preferences?.timeZone
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      : preferences.timeZone;
  }

  function baseFormatOptions(precision) {
    return {
      timeZone: effectiveTimeZone(),
      // UI language, date format and timezone are intentionally independent.
      // Regional format follows the browser locale rather than Tidy language.
      locale: global.navigator?.language || "en-US",
      dateFormat: preferences?.dateFormat || "locale",
      precision,
    };
  }

  function findMessageHost(message) {
    return messageDom.find(message?.locator);
  }

  function normalizedText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function elementDescendants(root) {
    const result = [];
    for (const child of root?.children || []) {
      result.push(child, ...elementDescendants(child));
    }
    return result;
  }

  function sidebarTitleInset(host, item, positionHost = host) {
    const title = normalizedText(item.title?.value);
    const hostRect = positionHost.getBoundingClientRect?.();
    if (!title || !hostRect?.width) return 10;

    // Alignment is presentation geometry only: use the DTO title to identify
    // ChatGPT's rendered title leaf, without opening another data-reading path
    // or depending on a fixed project DOM hierarchy.
    const titleNode = elementDescendants(host).find((candidate) => {
      if (candidate.dataset?.tidyOwned || candidate.children?.length) return false;
      if (normalizedText(candidate.textContent) !== title) return false;
      const rect = candidate.getBoundingClientRect?.();
      return Boolean(rect?.width && rect?.height);
    });
    const titleRect = titleNode?.getBoundingClientRect?.();
    if (!titleRect) return 10;

    const direction = global.getComputedStyle?.(host)?.direction || "ltr";
    const rawInset = direction === "rtl"
      ? hostRect.right - titleRect.right
      : titleRect.left - hostRect.left;
    // 相对日期的真实定位容器对齐标题；外层行承担定位后，保留项目缩进。
    return Math.max(0, Math.min(48, Math.round(rawInset)));
  }

  function directOwnedChild(host, owner) {
    return [...host.children].find((child) => child.dataset?.tidyOwned === owner) || null;
  }

  function ensureOwnedNode(host, owner, key) {
    let node = directOwnedChild(host, owner);
    if (!node) {
      node = document.createElement("div");
      node.dataset.tidyOwned = owner;
      host.append(node);
    }
    node.dataset.tidyKey = key;
    return node;
  }

  function placeBookmarkTowardCenter(meta, role) {
    const bookmark = directOwnedChild(meta, "message-bookmark");
    if (!bookmark) return;
    if (role === "user") {
      if (meta.firstElementChild !== bookmark) meta.prepend(bookmark);
    } else if (meta.lastElementChild !== bookmark) {
      meta.append(bookmark);
    }
  }

  function formatSidebarTime(item) {
    const options = {
      ...baseFormatOptions(preferences.conversationTimePrecision),
      mode: preferences.conversationTimeMode,
    };
    const text = timeFormat.formatConversation(item, options);
    if (!text) return null;
    const labels = LOCALE_LABELS[preferences.language] || LOCALE_LABELS.en;
    if (preferences.conversationTimeMode === "created") return `${labels.created} ${text}`;
    if (preferences.conversationTimeMode === "updated") return `${labels.updated} ${text}`;
    return text;
  }

  function renderSidebar(activeNodes) {
    if (!preferences.timeDisplayEnabled) {
      return;
    }
    for (const item of snapshot.sidebarConversations) {
      if (item.bindingStatus !== "bound") continue;
      const text = formatSidebarTime(item);
      if (!text) continue;
      // 同一会话可同时出现在项目目录与最近列表，甚至项目副本暂时隐藏。
      // DTO 仍只有一份；精确 href 的每个原生副本都要展示，不按首个节点截断。
      for (const host of sidebarDom.findAll(item.locator)) {
        const node = ensureOwnedNode(host, SIDEBAR_OWNER, item.conversationId);
        activeNodes.add(node);
        node.className = "tidy-sidebar-time";
        node.style.insetInlineStart = `${sidebarTitleInset(host, item, node.offsetParent || host)}px`;
        if (node.textContent !== text) node.textContent = text;
        // 窄侧栏只截断显示，不改变日期格式；title 保留格式化后的文本说明。
        // 日期不接管鼠标事件，因此不承诺悬停弹出完整时间。
        node.title = text;
      }
    }
  }

  function formatMessageMeta(message) {
    const parts = [];
    const displayNumber = message.order?.displayNumber;
    // The mounted message window is not the beginning of the conversation.
    // Missing source numbering stays absent while its time remains visible.
    if (preferences.messageNumbersEnabled && Number.isSafeInteger(displayNumber) && displayNumber > 0) {
      parts.push(`#${displayNumber}`);
    }
    if (preferences.timeDisplayEnabled && message.timestamp?.value) {
      const text = timeFormat.formatDateTime(
        message.timestamp.value,
        baseFormatOptions(preferences.messageTimePrecision),
      );
      if (text) parts.push(text);
    }
    return parts;
  }

  function renderMessages(activeKeys) {
    // Current-message DTOs are quarantined by the Adapter unless the current
    // route is bound. Keep that rule explicit at the final presentation edge.
    if (snapshot.conversation.bindingStatus !== "bound") return;
    for (const message of snapshot.messages) {
      if (!snapshotContract.isPresentableMessage(message)) continue;
      const parts = formatMessageMeta(message);
      const host = findMessageHost(message);
      if (!host) continue;
      if (!parts.length) continue;
      const key = `${snapshot.conversation.conversationId}:${message.messageId}`;
      activeKeys.add(key);
      const meta = messageDom.ensureMetadata(host, { role: message.role, key, position: preferences.messageTimePosition });
      const node = ensureOwnedNode(meta, MESSAGE_TIME_OWNER, key);
      node.className = "tidy-message-time";
      const serializedParts = JSON.stringify(parts);
      if (node.dataset.parts !== serializedParts) {
        node.dataset.parts = serializedParts;
        node.replaceChildren(...parts.map((part) => {
          const span = document.createElement("span");
          span.textContent = part;
          return span;
        }));
      }
      placeBookmarkTowardCenter(meta, message.role);
    }
  }

  function cleanupOwner(owner, activeNodes) {
    for (const node of document.querySelectorAll(`[data-tidy-owned="${owner}"]`)) {
      // 单个副本可能被 React 复用到另一个 href；其他副本还在，不能保留它的旧日期。
      if (!activeNodes.has(node)) {
        node.remove();
      }
    }
  }

  function cleanupMessageTimes(activeKeys) {
    for (const node of document.querySelectorAll(`[data-tidy-owned="${MESSAGE_TIME_OWNER}"]`)) {
      if (activeKeys.has(node.dataset.tidyKey)) continue;
      const meta = node.parentElement;
      node.remove();
      // message-meta is a shared structural row. Remove it only when neither
      // time nor bookmarks owns a child, otherwise preserve the other module.
      messageDom.removeEmptyMetadata(meta);
    }
  }

  function render() {
    if (stopped || !session.check() || !preferences || !snapshot || !snapshotContract.validate(snapshot).valid) return;
    const sidebarNodes = new Set();
    const messageKeys = new Set();
    renderSidebar(sidebarNodes);
    renderMessages(messageKeys);
    cleanupOwner(SIDEBAR_OWNER, sidebarNodes);
    cleanupMessageTimes(messageKeys);
  }

  function scheduleRender(delay = 60) {
    if (stopped || !session.check()) return;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, delay);
  }

  function installStyle() {
    if (document.getElementById("tidy-time-presentation-style")) return;
    const style = document.createElement("style");
    style.id = "tidy-time-presentation-style";
    style.dataset.tidyOwned = "style";
    style.textContent = `
      .tidy-sidebar-time {
        position: absolute;
        /* Reserve only controls that actually exist. Bookmark placement will
           claim its own slot when that presentation is implemented; reserving
           it now caused useful project-row width to be ellipsized. */
        inset-inline-start: 10px;
        inset-inline-end: calc(8px + var(--tidy-sidebar-star-slot, 22px) + 2px);
        bottom: 5px;
        overflow: hidden;
        color: var(--text-tertiary, var(--token-text-tertiary, #8b8d93));
        font: 400 10px/1.25 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        letter-spacing: .005em;
        pointer-events: none;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .tidy-message-meta {
        box-sizing: border-box;
        display: flex;
        width: min(100%, 48rem);
        gap: 10px;
        margin: 7px auto 0;
        padding-inline: 0;
        color: var(--text-tertiary, var(--token-text-tertiary, #8b8d93));
        font: 400 11px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        pointer-events: none;
      }
      .tidy-message-meta:empty { display: none; }
      .tidy-message-time { display: contents; }
      .tidy-message-meta[data-position="before"] { margin: 0 auto 7px; }
      .tidy-message-meta--user { justify-content: flex-end; text-align: end; }
      .tidy-message-meta--assistant,
      .tidy-message-meta--system,
      .tidy-message-meta--tool,
      .tidy-message-meta--unknown { justify-content: flex-start; text-align: start; }
    `;
    (document.head || document.documentElement).append(style);
  }

  function onSnapshot(nextSnapshot) {
    if (stopped || !session.check() || !nextSnapshot || !snapshotContract.validate(nextSnapshot).valid) return;
    snapshotGeneration += 1;
    snapshot = nextSnapshot;
    scheduleRender(0);
  }

  function onRuntimeMessage(envelope) {
    if (stopped || !session.check()) return false;
    if (
      protocol.isEnvelope(envelope) &&
      envelope.kind === protocol.Kind.EVENT &&
      envelope.type === protocol.Type.PREFERENCES_UPDATED
    ) {
      preferencesGeneration += 1;
      const changed = !preferences || TIME_PREFERENCES.some(key => preferences[key] !== envelope.payload?.[key]);
      preferences = envelope.payload;
      if (changed) scheduleRender(0);
    }
    return false;
  }

  const observer = new MutationObserver((mutations) => {
    if (stopped || !session.check()) return;
    if (!domOwnership.areOnlyTidyOwnedMutations(mutations)) scheduleRender();
  });

  function stop() {
    if (stopped) return;
    stopped = true;
    snapshotGeneration += 1;
    preferencesGeneration += 1;
    clearTimeout(renderTimer);
    renderTimer = null;
    observer.disconnect();
    unsubscribeSnapshot?.();
    unsubscribeSnapshot = null;
    // Chromium may already have invalidated extension APIs; DOM cleanup must
    // still finish even when detaching the runtime listener throws.
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch (_) {}
    document.removeEventListener("DOMContentLoaded", start);
    // 失效页面只拆除自己的装饰；书签拥有的共享消息行由书签模块负责清理。
    cleanupOwner(SIDEBAR_OWNER, new Set());
    cleanupMessageTimes(new Set());
    document.getElementById("tidy-time-presentation-style")?.remove();
    preferences = null;
    snapshot = null;
  }

  function start() {
    if (stopped || !session.check()) return;
    installStyle();
    // React 可只改链接的 href/语义身份而复用节点；不依赖快照字段变化才清理旧日期。
    observer.observe(document.documentElement, { subtree: true, childList: true,
      attributes: true, attributeFilter: ["href", "aria-hidden"] });
    const initialPreferencesGeneration = preferencesGeneration;
    const initialSnapshotGeneration = snapshotGeneration;
    requestRuntime(protocol.Type.PREFERENCES_GET).then((nextPreferences) => {
      if (stopped || !session.check()) return;
      if (preferencesGeneration === initialPreferencesGeneration) preferences = nextPreferences;
      scheduleRender(0);
    }).catch(() => {
      // A later Adapter event or preference event retries naturally. Avoid a
      // page-wide polling loop while the service worker/SPA is starting.
    });
    // A synchronous runtime failure above can retire the session immediately.
    if (stopped || !session.check()) return;
    bridge.requestMain(protocol.Type.GET_SNAPSHOT).then((nextSnapshot) => {
      if (stopped || !session.check()) return;
      // SPA snapshot events are newer than this startup request. Latest wins.
      if (snapshotGeneration === initialSnapshotGeneration) snapshot = nextSnapshot;
      scheduleRender(0);
    }).catch(() => {
      // A later Adapter event retries naturally.
    });
  }

  session.onDispose(stop);
  unsubscribeSnapshot = bridge.onSnapshot(onSnapshot);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true, signal: session.signal });
})(globalThis);
