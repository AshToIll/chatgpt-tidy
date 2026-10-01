(function initTidyChatgptBookmarksPresentation(global) {
  "use strict";

  const protocol = global.TidyProtocol;
  const snapshotContract = global.TidySnapshot;
  const domOwnership = global.TidyDomOwnership;
  const sidebarDom = global.TidyChatgptSidebarDom;
  const messageDom = global.TidyChatgptMessageDom;
  const bridge = global.TidyContentBridge;
  const libraryClient = global.TidyLibraryClient;
  const theme = global.TidyTheme;
  const pageSession = global.TidyPageSession;
  const noticeLifecycle = global.ChatGPTTidyNoticeLifecycle;
  if (!protocol || !snapshotContract || !domOwnership || !sidebarDom || !messageDom || !bridge || !libraryClient || !theme || !noticeLifecycle || global.__tidyBookmarksPresentationStarted) return;
  if (!pageSession.check()) return;
  global.__tidyBookmarksPresentationStarted = true;

  const MESSAGE_OWNER = "message-bookmark";
  const COUNT_OWNER = "sidebar-bookmark-count";
  const META_OWNER = "message-meta";
  const COUNT_TEXT_PART = "bookmark-count-text";
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.75C7 3.78 7.78 3 8.75 3h6.5C16.22 3 17 3.78 17 4.75v15.1l-5-3.05-5 3.05V4.75Z"></path></svg>';
  // 文案只在 messages/catalogs/bookmarks.json 维护；此处保留既有显示/关闭规则。
  const LABELS = global.TidyMessages.pageLabels.bookmarks;

  let preferences = null;
  let bookmarks = null;
  let snapshot = null;
  let renderTimer = null;
  let snapshotGeneration = 0;
  let preferencesGeneration = 0;
  const pending = new Map();
  let stopped = false;
  let unsubscribeSnapshot = () => {};
  let unsubscribeLibrary = () => {};
  // 所有计数按钮共享同一个“打开书签”意图：新点击取代旧回执的展示权，
  // 不重放或取消业务请求，也不影响消息书签保存操作。
  const openNoticeOwner = noticeLifecycle.createOwner();
  const openFeedbackTokens = new WeakMap();
  let currentOpen = null;

  function revokeOpenForButton(button) {
    if (!currentOpen || currentOpen.button !== button) return;
    openNoticeOwner.revoke();
    currentOpen = null;
  }

  // 诊断只使用本地节点编号，绝不记录conversationId/messageId或用户文字。
  function observeFeedback(button, messageKey = null, error = null) {
    const observer = global.ChatGPTTidyDiagnostics;
    observer?.notice({ event: messageKey ? "show" : "clear", surface: "page.bookmark.error",
      source: "src/features/bookmarks/chatgpt/bookmarks-presentation.js", instanceId: observer.slot(button), ownerNode: button, messageKey,
      ...observer.cause(error) });
  }

  function sessionActive() { return !stopped && pageSession.check(); }

  function requestRuntime(type, payload = null) {
    const envelope = protocol.request(type, payload);
    return pageSession.runtimeRequest(envelope).then((response) => {
      pageSession.assertActive();
      if (!protocol.isResponse(response, envelope.requestId)) throw new Error("Invalid TIDY response");
      if (!response.ok) throw new Error(response.error?.message || "TIDY request failed");
      return response.payload;
    });
  }
  function labels() { return LABELS[preferences?.language] || LABELS.en; }
  function updateFeedback(button) {
    const notice = button.querySelector?.("[data-tidy-feedback]");
    if (!notice) return;
    // 保存错误类型而非翻译结果；语言重绘保留原提示节点和关闭行为。
    const text = `${labels()[notice.dataset.tidyFeedback]} ×`;
    if (notice.textContent !== text) notice.textContent = text;
  }
  function showFailure(button, key, error) {
    if (!sessionActive()) return;
    button.querySelector?.("[data-tidy-feedback]")?.remove();
    const notice = document.createElement("span");
    notice.dataset.tidyFeedback = key; notice.className = "tidy-action-feedback";
    notice.setAttribute("role", "alert");
    button.append(notice);
    updateFeedback(button);
    observeFeedback(button, key === "openFailed" ? "pageBookmarkOpenFailed" : "pageBookmarkFailed", error);
    return notice;
  }
  // 捕获阶段先处理关闭，不让提示点击落到添加书签/打开书签动作。
  function dismissFeedback(event) {
    const notice = event.target?.closest?.("[data-tidy-feedback]");
    if (!notice) return false;
    // 只撤销被关闭提示所属的展示权；关闭别处的旧提示不能误杀最新点击。
    const token = openFeedbackTokens.get(notice);
    if (token && openNoticeOwner.owns(token)) {
      openNoticeOwner.revoke();
      currentOpen = null;
    }
    observeFeedback(notice.parentElement);
    notice.remove(); return true;
  }
  function findMessageHost(message) {
    return messageDom.find(message?.locator);
  }
  function directOwnedChild(host, owner) {
    return [...(host?.children || [])].find((child) => child.dataset?.tidyOwned === owner) || null;
  }
  function stopNativeNavigation(event) {
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.();
  }
  function updateMessageButton(button, item, active) {
    const text = labels();
    button.classList.toggle("is-bookmarked", active);
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", active ? text.remove : text.add);
    button.title = active ? text.remove : text.add;
    button.dataset.tidyConversationId = snapshot.conversation.conversationId;
    button.dataset.tidyMessageId = item.messageId;
    updateFeedback(button);
  }
  function ensureMessageButton(meta) {
    let button = directOwnedChild(meta, MESSAGE_OWNER);
    if (button) return button;
    button = document.createElement("button");
    button.type = "button";
    button.className = "tidy-message-bookmark";
    button.dataset.tidyOwned = MESSAGE_OWNER;
    button.insertAdjacentHTML("beforeend", ICON);
    button.addEventListener("click", (event) => {
      stopNativeNavigation(event);
      // 与收藏共用本页生命周期：失效先退场，不改变书签、不叠加错误提示。
      if (!sessionActive()) return;
      if (dismissFeedback(event)) return;
      const conversationId = button.dataset.tidyConversationId;
      const messageId = button.dataset.tidyMessageId;
      const key = `${conversationId}:${messageId}`;
      const lease = libraryClient.capture("bookmarks");
      if (!lease || !conversationId || !messageId || pending.has(key)) return;
      observeFeedback(button);
      button.querySelector?.("[data-tidy-feedback]")?.remove();
      const bookmarkId = `${encodeURIComponent(conversationId)}::${encodeURIComponent(messageId)}`;
      const active = Boolean(bookmarks?.items?.[bookmarkId]);
      const operation = { lease, value: !active };
      pending.set(key, operation);
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      updateMessageButton(button, { messageId }, !active);
      libraryClient.request(protocol.Type.BOOKMARKS_TOGGLE_CURRENT, {
        expectedConversationId: conversationId,
        messageId,
      }, lease).catch((error) => {
        if (!sessionActive() || !libraryClient.owns(lease)) return;
        showFailure(button, "failed", error);
      }).finally(() => {
        if (!sessionActive() || pending.get(key) !== operation) return;
        pending.delete(key);
        scheduleRender(0);
      });
    }, { capture: true, signal: pageSession.signal });
    return button;
  }
  function placeMessageButton(meta, button, role) {
    // The bookmark always faces the page center while the native time anchor
    // stays fixed: user [bookmark # time], assistant [# time bookmark].
    if (role === "user") {
      if (meta.firstElementChild !== button) meta.prepend(button);
    } else if (meta.lastElementChild !== button) {
      meta.append(button);
    }
  }
  function ensureCountButton(host) {
    let button = directOwnedChild(host, COUNT_OWNER);
    if (button) return button;
    button = document.createElement("button");
    button.type = "button";
    button.className = "tidy-sidebar-bookmark-count";
    button.dataset.tidyOwned = COUNT_OWNER;
    // Build this subtree once. Replacing it on every render creates a new
    // childList mutation and used to feed the global observer indefinitely.
    button.innerHTML = ICON;
    const text = document.createElement("span");
    text.dataset.tidyPart = COUNT_TEXT_PART;
    button.append(text);
    const listenerOptions = { capture: true, signal: pageSession.signal };
    button.addEventListener("pointerdown", stopNativeNavigation, listenerOptions);
    button.addEventListener("mousedown", stopNativeNavigation, listenerOptions);
    button.addEventListener("click", (event) => {
      stopNativeNavigation(event);
      if (!sessionActive()) return;
      if (dismissFeedback(event)) return;
      const conversationId = button.dataset.tidyConversationId;
      const lease = libraryClient.capture("bookmarks");
      if (!conversationId || !lease) return;
      const token = openNoticeOwner.begin();
      currentOpen = { button, token };
      observeFeedback(button);
      button.querySelector?.("[data-tidy-feedback]")?.remove();
      libraryClient.request(protocol.Type.BOOKMARKS_OPEN_CONVERSATION_VIEW, { conversationId }, lease).catch((error) => {
        if (!sessionActive() || !libraryClient.owns(lease) || !openNoticeOwner.owns(token)) return;
        if (!button.isConnected || button.dataset.tidyConversationId !== conversationId) {
          revokeOpenForButton(button);
          return;
        }
        const notice = showFailure(button, "openFailed", error);
        if (notice) openFeedbackTokens.set(notice, token);
      });
    }, listenerOptions);
    host.append(button);
    return button;
  }
  function countTextNode(button) {
    return [...button.children].find((child) => child.dataset?.tidyPart === COUNT_TEXT_PART) || null;
  }
  function countsByConversation() {
    const counts = {};
    for (const item of Object.values(bookmarks?.items || {})) counts[item.conversationId] = (counts[item.conversationId] || 0) + 1;
    return counts;
  }
  function countPresentation(count) {
    // Sidebar width is more valuable than an exact large badge. Keep the
    // visual slot bounded after one digit; title/aria-label retain the exact
    // count for hover and assistive technology. `9+` is less ambiguous than
    // an infinity glyph, which could imply an unlimited feature.
    if (count > 9) return { text: "9+", size: "capped" };
    return { text: String(count), size: "single" };
  }
  function bookmarkAccent() { return theme.resolve(preferences?.theme, snapshot?.appearance?.colorScheme).accent; }
  function applyButtonAccent(button, accent) {
    if (button.style.getPropertyValue("--tidy-bookmark-accent") !== accent) {
      button.style.setProperty("--tidy-bookmark-accent", accent);
    }
  }
  function updateBookmarkAccent() {
    if (!sessionActive()) return;
    // 纯改色只遍历已挂载的自有按钮，不重新查找每条消息、分组或左栏计数。
    const accent = bookmarkAccent();
    for (const button of document.querySelectorAll(`[data-tidy-owned="${MESSAGE_OWNER}"]`)) applyButtonAccent(button, accent);
  }
  function renderMessages(activeKeys) {
    if (snapshot.conversation.bindingStatus !== "bound") return;
    // 已添加和悬停的消息书签使用设置中的重点色；明暗优先跟随 ChatGPT 页面。
    // 色值只写入书签按钮，不给原生消息、收藏星星或左栏计数染色。
    const accent = bookmarkAccent();
    for (const message of snapshot.messages) {
      if (!snapshotContract.isPresentableMessage(message)) continue;
      const host = findMessageHost(message);
      if (!host) continue;
      const key = `${snapshot.conversation.conversationId}:${message.messageId}`;
      activeKeys.add(key);
      const meta = messageDom.ensureMetadata(host, { role: message.role, key, position: preferences?.messageTimePosition || "after" });
      const button = ensureMessageButton(meta);
      applyButtonAccent(button, accent);
      placeMessageButton(meta, button, message.role);
      button.dataset.tidyKey = key;
      const bookmarkId = `${encodeURIComponent(snapshot.conversation.conversationId)}::${encodeURIComponent(message.messageId)}`;
      const active = pending.has(key) ? pending.get(key).value : Boolean(bookmarks.items?.[bookmarkId]);
      button.disabled = pending.has(key);
      if (!button.disabled) button.removeAttribute("aria-busy");
      updateMessageButton(button, message, active);
    }
  }
  function renderCounts(activeKeys) {
    const counts = countsByConversation();
    for (const item of snapshot.sidebarConversations) {
      if (!snapshotContract.isSidebarPersistenceEligible(item)) continue;
      const count = counts[item.conversationId] || 0;
      if (!count) continue;
      const host = sidebarDom.find(item.locator);
      if (!host) continue;
      activeKeys.add(item.conversationId);
      host.classList.add("tidy-sidebar-bookmark-host");
      const button = ensureCountButton(host);
      button.dataset.tidyKey = item.conversationId;
      button.dataset.tidyConversationId = item.conversationId;
      const displayed = countPresentation(count);
      if (host.dataset.tidyBookmarkCountSize !== displayed.size) {
        host.dataset.tidyBookmarkCountSize = displayed.size;
      }
      const text = countTextNode(button);
      if (text && text.textContent !== displayed.text) text.textContent = displayed.text;
      const ariaLabel = `${labels().open} ${item.title?.value || ""} · ${count}`;
      if (button.getAttribute("aria-label") !== ariaLabel) button.setAttribute("aria-label", ariaLabel);
      if (button.title !== `${count}`) button.title = `${count}`;
      updateFeedback(button);
    }
  }
  function cleanup(owner, activeKeys, hostClass) {
    for (const node of document.querySelectorAll(`[data-tidy-owned="${owner}"]`)) {
      if (activeKeys.has(node.dataset.tidyKey)) continue;
      const host = node.parentElement;
      if (owner === COUNT_OWNER) revokeOpenForButton(node);
      observeFeedback(node);
      node.remove();
      if (owner === MESSAGE_OWNER && host?.dataset?.tidyOwned === META_OWNER) {
        // message-meta is shared with time presentation. Removing a bookmark
        // must not remove live time content, and an empty shared row should not
        // be left behind after both owners have gone.
        messageDom.removeEmptyMetadata(host);
        continue;
      }
      if (host && !directOwnedChild(host, owner)) {
        host.classList.remove(hostClass);
        if (owner === COUNT_OWNER) delete host.dataset.tidyBookmarkCountSize;
      }
    }
  }
  function render() {
    if (!sessionActive()) return;
    if (document.hidden || !bookmarks || !snapshot || !snapshotContract.validate(snapshot).valid) {
      cleanup(MESSAGE_OWNER, new Set(), "tidy-message-meta-host");
      cleanup(COUNT_OWNER, new Set(), "tidy-sidebar-bookmark-host");
      return;
    }
    const messageKeys = new Set(); const countKeys = new Set();
    renderMessages(messageKeys); renderCounts(countKeys);
    cleanup(MESSAGE_OWNER, messageKeys, "tidy-message-meta-host");
    cleanup(COUNT_OWNER, countKeys, "tidy-sidebar-bookmark-host");
  }
  function scheduleRender(delay = 60) {
    if (!sessionActive()) return;
    clearTimeout(renderTimer); renderTimer = setTimeout(render, delay);
  }
  function installStyle() {
    if (document.getElementById("tidy-bookmarks-presentation-style")) return;
    const style = document.createElement("style");
    style.id = "tidy-bookmarks-presentation-style";
    style.dataset.tidyOwned = "style";
    style.textContent = `
      .tidy-message-meta { pointer-events: none; }
      .tidy-message-bookmark { width: 28px; height: 28px; display: grid; flex: 0 0 auto; place-items: center; margin: -6px 0; padding: 0; border: 0; border-radius: 5px; background: transparent; color: inherit; cursor: pointer; opacity: 0; pointer-events: auto; transition: opacity .12s ease; }
      .tidy-message-meta-host:hover .tidy-message-bookmark, .tidy-message-meta-host:focus-within .tidy-message-bookmark, .tidy-message-bookmark:focus-visible, .tidy-message-bookmark.is-bookmarked { opacity: 1; }
      .tidy-message-bookmark:hover, .tidy-message-bookmark:focus-visible { background: color-mix(in srgb, currentColor 10%, transparent); color: var(--tidy-bookmark-accent); outline: none; }
      .tidy-message-bookmark.is-bookmarked { color: var(--tidy-bookmark-accent); }
      .tidy-message-bookmark.is-error { color: #c45b66; }
      .tidy-message-bookmark svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.45; }
      .tidy-message-bookmark.is-bookmarked svg { fill: currentColor; }
      .tidy-sidebar-bookmark-host { --tidy-sidebar-bookmark-slot: 24px; }
      .tidy-sidebar-bookmark-host[data-tidy-bookmark-count-size="capped"] { --tidy-sidebar-bookmark-slot: 28px; }
      .tidy-sidebar-bookmark-count { position: absolute; z-index: 3; inset-inline-end: calc(8px + var(--tidy-sidebar-star-slot, 22px) + 2px); bottom: 2px; width: var(--tidy-sidebar-bookmark-slot); height: 22px; display: inline-flex; align-items: center; justify-content: center; gap: 2px; padding: 0 1px; border: 0; border-radius: 4px; background: transparent; color: var(--text-tertiary, var(--token-text-tertiary, #9a9ca2)); font: 400 10px/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer; }
      .tidy-sidebar-bookmark-count:hover, .tidy-sidebar-bookmark-count:focus-visible { background: color-mix(in srgb, currentColor 10%, transparent); color: var(--text-secondary, #74767d); outline: none; }
      .tidy-sidebar-bookmark-count svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.4; }
      .tidy-sidebar-time { inset-inline-end: calc(8px + var(--tidy-sidebar-star-slot, 22px) + var(--tidy-sidebar-bookmark-slot, 0px) + 4px) !important; }
    `;
    (document.head || document.documentElement).append(style);
  }
  function onSnapshot(next) {
    if (!sessionActive()) return;
    if (next && snapshotContract.validate(next).valid) { snapshotGeneration += 1; snapshot = next; scheduleRender(0); }
  }
  function onLibrary(library) {
    if (!sessionActive()) return;
    bookmarks = library?.bookmarks || null;
    for (const [id, operation] of pending) {
      if (!libraryClient.owns(operation.lease)) pending.delete(id);
    }
    if (!bookmarks) {
      clearTimeout(renderTimer);
      // Run cleanup synchronously on ownership/visibility loss, including the
      // sidebar count. Shared message times remain owned by time presentation.
      render();
    } else scheduleRender(0);
  }
  function onRuntimeMessage(envelope) {
    if (!sessionActive()) return false;
    if (!protocol.isEnvelope(envelope) || envelope.kind !== protocol.Kind.EVENT) return false;
    if (envelope.type === protocol.Type.PREFERENCES_UPDATED) {
      preferencesGeneration += 1;
      const previous = preferences;
      preferences = envelope.payload;
      if (!previous || ["language", "messageTimePosition"].some(key => previous[key] !== preferences?.[key])) scheduleRender(0);
      else if (previous.theme !== preferences?.theme) updateBookmarkAccent();
    }
    return false;
  }
  const observer = new MutationObserver((mutations) => {
    if (!sessionActive()) return;
    // 原生 React 也能移除按钮的祖先；即使同一节点随后被重新挂载，旧请求
    // 仍已失去展示权。先处理卸载，再忽略 TIDY 自己产生的普通 DOM 变更。
    const button = currentOpen?.button;
    if (button && mutations.some((mutation) => [...(mutation.removedNodes || [])]
      .some((node) => node === button || node.contains?.(button)))) revokeOpenForButton(button);
    if (!domOwnership.areOnlyTidyOwnedMutations(mutations)) scheduleRender();
  });
  function start() {
    if (!sessionActive()) return;
    installStyle(); observer.observe(document.documentElement, { subtree: true, childList: true });
    const sg = snapshotGeneration; const pg = preferencesGeneration;
    requestRuntime(protocol.Type.PREFERENCES_GET).then((next) => { if (!sessionActive()) return; if (preferencesGeneration === pg) preferences = next; scheduleRender(0); }).catch(() => {});
    if (!sessionActive()) return;
    bridge.requestMain(protocol.Type.GET_SNAPSHOT).then((next) => { if (!sessionActive()) return; if (snapshotGeneration === sg) snapshot = next; scheduleRender(0); }).catch(() => {});
  }
  function dispose() {
    if (stopped) return;
    stopped = true;
    openNoticeOwner.dispose(); currentOpen = null;
    snapshotGeneration += 1; preferencesGeneration += 1;
    clearTimeout(renderTimer); renderTimer = null;
    observer.disconnect();
    unsubscribeSnapshot(); unsubscribeLibrary();
    document.removeEventListener("DOMContentLoaded", start);
    pending.clear(); preferences = null; bookmarks = null; snapshot = null;
    cleanup(MESSAGE_OWNER, new Set(), "tidy-message-meta-host");
    cleanup(COUNT_OWNER, new Set(), "tidy-sidebar-bookmark-host");
    for (const host of document.querySelectorAll(".tidy-sidebar-bookmark-host")) {
      host.classList.remove("tidy-sidebar-bookmark-host"); delete host.dataset.tidyBookmarkCountSize;
    }
    for (const host of document.querySelectorAll(".tidy-message-meta-host")) {
      if (!messageDom.metadata(host)) host.classList.remove("tidy-message-meta-host");
    }
    document.getElementById("tidy-bookmarks-presentation-style")?.remove();
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch (_) {}
  }
  pageSession.onDispose(dispose);
  unsubscribeSnapshot = bridge.onSnapshot(onSnapshot);
  if (!sessionActive()) { unsubscribeSnapshot(); return; }
  unsubscribeLibrary = libraryClient.subscribe(onLibrary);
  if (!sessionActive()) { unsubscribeLibrary(); return; }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  if (document.documentElement) start(); else document.addEventListener("DOMContentLoaded", start, { once: true, signal: pageSession.signal });
})(globalThis);
