(function initTidyChatgptFavoritesPresentation(global) {
  "use strict";

  const protocol = global.TidyProtocol;
  const snapshotContract = global.TidySnapshot;
  const domOwnership = global.TidyDomOwnership;
  const sidebarDom = global.TidyChatgptSidebarDom;
  const bridge = global.TidyContentBridge;
  const libraryClient = global.TidyLibraryClient;
  const pageSession = global.TidyPageSession;
  if (!protocol || !snapshotContract || !domOwnership || !sidebarDom || !bridge || !libraryClient || global.__tidyFavoritesPresentationStarted) return;
  if (!pageSession.check()) return;
  global.__tidyFavoritesPresentationStarted = true;

  const OWNER = "sidebar-favorite";
  const STAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.78 5.63 6.22.9-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.92 1.06-6.2L3 9.53l6.22-.9L12 3Z"></path></svg>';
  // 文案只在 messages/catalogs/favorites.json 维护；此处保留既有显示/关闭规则。
  const LABELS = global.TidyMessages.pageLabels.favorites;

  let preferences = null;
  let favorites = null;
  let snapshot = null;
  let renderTimer = null;
  let snapshotGeneration = 0;
  let preferencesGeneration = 0;
  const pending = new Map();
  let stopped = false;
  let unsubscribeSnapshot = () => {};
  let unsubscribeLibrary = () => {};

  // 诊断只使用本地节点编号，绝不记录conversationId/messageId或用户文字。
  function observeFeedback(button, messageKey = null, error = null) {
    const observer = global.ChatGPTTidyDiagnostics;
    observer?.notice({ event: messageKey ? "show" : "clear", surface: "page.favorite.error",
      source: "src/features/favorites/chatgpt/favorites-presentation.js", instanceId: observer.slot(button), ownerNode: button, messageKey,
      ...observer.cause(error) });
  }

  function sessionActive() { return !stopped && pageSession.check(); }

  function requestRuntime(type, payload = null) {
    const envelope = protocol.request(type, payload);
    return pageSession.runtimeRequest(envelope).then((response) => {
      pageSession.assertActive();
      if (!protocol.isResponse(response, envelope.requestId)) {
        throw new Error("Tidy service worker returned an invalid response");
      }
      if (!response.ok) throw new Error(response.error?.message || "Tidy request failed");
      return response.payload;
    });
  }

  function directOwnedChild(host) {
    return [...host.children].find((child) => child.dataset?.tidyOwned === OWNER) || null;
  }

  function stopNativeNavigation(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  }

  function labels() {
    return LABELS[preferences?.language] || LABELS.en;
  }

  function updateFeedback(button) {
    const notice = button.querySelector?.("[data-tidy-feedback]");
    if (!notice) return;
    // 提示自身保存文案键：切换语言只更新文字，不清除错误或重建可关闭的节点。
    const text = `${labels()[notice.dataset.tidyFeedback]} ×`;
    if (notice.textContent !== text) notice.textContent = text;
  }

  function updateButton(button, conversationId, starred) {
    const itemLabels = labels();
    const title = snapshot?.sidebarConversations.find(
      (conversation) => conversation.conversationId === conversationId,
    )?.title?.value || "";
    const action = starred ? itemLabels.remove : itemLabels.add;
    button.classList.toggle("is-starred", starred);
    button.setAttribute("aria-pressed", String(starred));
    button.setAttribute("aria-label", `${action}${title ? ` ${title}` : ""}`);
    button.title = action;
    updateFeedback(button);
  }

  function ensureButton(host) {
    let button = directOwnedChild(host);
    if (button) return button;
    button = document.createElement("button");
    button.type = "button";
    button.className = "tidy-sidebar-favorite";
    button.dataset.tidyOwned = OWNER;
    button.innerHTML = STAR_ICON;
    // ChatGPT history rows are anchors. Capturing pointer/click events keeps a
    // star click from also navigating the underlying conversation.
    const listenerOptions = { capture: true, signal: pageSession.signal };
    button.addEventListener("pointerdown", stopNativeNavigation, listenerOptions);
    button.addEventListener("mousedown", stopNativeNavigation, listenerOptions);
    button.addEventListener("click", (event) => {
      stopNativeNavigation(event);
      // 先验证本页连接，再改变星星。扩展重载后旧页面不能乐观染色或继续写入。
      if (!sessionActive()) return;
      // 父按钮在捕获阶段接收点击：关闭提示不能再次切换收藏。
      const feedback = event.target?.closest?.("[data-tidy-feedback]");
      if (feedback) { observeFeedback(button); feedback.remove(); button.classList.remove("is-error"); return; }
      const conversationId = button.dataset.tidyConversationId;
      const locator = button.dataset.tidyLocator;
      const lease = libraryClient.capture("favorites");
      if (!lease || !conversationId || pending.has(conversationId)) return;
      observeFeedback(button);
      button.querySelector?.("[data-tidy-feedback]")?.remove();
      button.classList.remove("is-error");
      const current = Boolean(favorites?.items?.[conversationId]);
      const operation = { lease, value: !current };
      pending.set(conversationId, operation);
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      updateButton(button, conversationId, !current);
      libraryClient.request(protocol.Type.FAVORITES_TOGGLE_SIDEBAR, {
        conversationId,
        locator,
      }, lease)
        .catch((error) => {
          if (!sessionActive() || !libraryClient.owns(lease)) return;
          button.classList.add("is-error");
          // 留下可读提示，不靠瞬间颜色变化表达保存结果；下次操作或页面切换清除。
          const notice = document.createElement("span");
          notice.dataset.tidyFeedback = "failed"; notice.className = "tidy-action-feedback";
          notice.setAttribute("role", "alert");
          button.append(notice);
          updateFeedback(button);
          observeFeedback(button, "pageFavoriteFailed", error);
        })
        .finally(() => {
          if (!sessionActive() || pending.get(conversationId) !== operation) return;
          pending.delete(conversationId);
          scheduleRender(0);
        });
    }, listenerOptions);
    host.append(button);
    return button;
  }

  function render() {
    if (!sessionActive()) return;
    if (document.hidden || !favorites || !snapshot || !snapshotContract.validate(snapshot).valid) {
      clearMarkers();
      return;
    }
    const activeKeys = new Set();
    for (const item of snapshot.sidebarConversations) {
      if (!snapshotContract.isSidebarPersistenceEligible(item)) continue;
      const host = sidebarDom.find(item.locator);
      if (!host) continue;
      const conversationId = item.conversationId;
      activeKeys.add(conversationId);
      host.classList.add("tidy-sidebar-favorite-host");
      const button = ensureButton(host);
      button.dataset.tidyKey = conversationId;
      button.dataset.tidyConversationId = conversationId;
      button.dataset.tidyLocator = item.locator.value;
      const starred = pending.has(conversationId)
        ? pending.get(conversationId).value
        : Boolean(favorites.items?.[conversationId]);
      button.disabled = pending.has(conversationId);
      if (!button.disabled) button.removeAttribute("aria-busy");
      updateButton(button, conversationId, starred);
    }

    for (const button of document.querySelectorAll(`[data-tidy-owned="${OWNER}"]`)) {
      if (activeKeys.has(button.dataset.tidyKey)) continue;
      const host = button.parentElement;
      observeFeedback(button);
      button.remove();
      if (host && !directOwnedChild(host)) host.classList.remove("tidy-sidebar-favorite-host");
    }
  }

  function clearMarkers() {
    for (const button of document.querySelectorAll(`[data-tidy-owned="${OWNER}"]`)) {
      const host = button.parentElement;
      observeFeedback(button);
      button.remove();
      if (host && !directOwnedChild(host)) host.classList.remove("tidy-sidebar-favorite-host");
    }
  }

  function scheduleRender(delay = 60) {
    if (!sessionActive()) return;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, delay);
  }

  function installStyle() {
    if (document.getElementById("tidy-favorites-presentation-style")) return;
    const style = document.createElement("style");
    style.id = "tidy-favorites-presentation-style";
    style.dataset.tidyOwned = "style";
    style.textContent = `
      .tidy-sidebar-favorite-host {
        --tidy-sidebar-star-slot: 22px;
      }
      .tidy-sidebar-favorite {
        position: absolute;
        z-index: 3;
        inset-inline-end: 8px;
        bottom: 2px;
        width: var(--tidy-sidebar-star-slot);
        height: 22px;
        display: grid;
        place-items: center;
        padding: 0;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--text-tertiary, var(--token-text-tertiary, #9a9ca2));
        cursor: pointer;
        opacity: 0;
        transition: opacity .12s ease, background-color .12s ease, color .12s ease;
      }
      .tidy-sidebar-favorite-host:hover .tidy-sidebar-favorite,
      .tidy-sidebar-favorite:focus-visible,
      .tidy-sidebar-favorite.is-starred { opacity: 1; }
      .tidy-sidebar-favorite:hover,
      .tidy-sidebar-favorite:focus-visible {
        background: color-mix(in srgb, currentColor 10%, transparent);
        outline: none;
      }
      .tidy-sidebar-favorite.is-starred { color: var(--text-secondary, var(--token-text-secondary, #74767d)); }
      .tidy-sidebar-favorite.is-error { color: #c45b66; }
      .tidy-sidebar-favorite:disabled { cursor: wait; }
      .tidy-sidebar-favorite svg {
        width: 14px;
        height: 14px;
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.5;
      }
      .tidy-sidebar-favorite.is-starred svg { fill: currentColor; }
    `;
    (document.head || document.documentElement).append(style);
  }

  function onSnapshot(nextSnapshot) {
    if (!sessionActive()) return;
    if (!nextSnapshot || !snapshotContract.validate(nextSnapshot).valid) return;
    snapshotGeneration += 1;
    snapshot = nextSnapshot;
    scheduleRender(0);
  }

  function onLibrary(library) {
    if (!sessionActive()) return;
    favorites = library?.favorites || null;
    for (const [id, operation] of pending) {
      if (!libraryClient.owns(operation.lease)) pending.delete(id);
    }
    if (!favorites) {
      clearTimeout(renderTimer);
      clearMarkers();
    } else scheduleRender(0);
  }

  function onRuntimeMessage(envelope) {
    if (!sessionActive()) return false;
    if (!protocol.isEnvelope(envelope) || envelope.kind !== protocol.Kind.EVENT) return false;
    if (envelope.type === protocol.Type.PREFERENCES_UPDATED) {
      preferencesGeneration += 1;
      // 星星保持原生中性色；设置广播只有语言变化会影响这里的按钮文案。
      const changed = !preferences || preferences.language !== envelope.payload?.language;
      preferences = envelope.payload;
      if (changed) scheduleRender(0);
    }
    return false;
  }

  const observer = new MutationObserver((mutations) => {
    if (!sessionActive()) return;
    if (!domOwnership.areOnlyTidyOwnedMutations(mutations)) scheduleRender();
  });

  function start() {
    if (!sessionActive()) return;
    installStyle();
    observer.observe(document.documentElement, { subtree: true, childList: true });
    const initialSnapshotGeneration = snapshotGeneration;
    const initialPreferencesGeneration = preferencesGeneration;
    requestRuntime(protocol.Type.PREFERENCES_GET).then((nextPreferences) => {
      if (!sessionActive()) return;
      if (preferencesGeneration === initialPreferencesGeneration) preferences = nextPreferences;
      scheduleRender(0);
    }).catch(() => {});
    if (!sessionActive()) return;
    bridge.requestMain(protocol.Type.GET_SNAPSHOT).then((nextSnapshot) => {
      if (!sessionActive()) return;
      if (snapshotGeneration === initialSnapshotGeneration) snapshot = nextSnapshot;
      scheduleRender(0);
    }).catch(() => {});
  }

  function dispose() {
    if (stopped) return;
    stopped = true;
    snapshotGeneration += 1; preferencesGeneration += 1;
    clearTimeout(renderTimer); renderTimer = null;
    observer.disconnect();
    unsubscribeSnapshot(); unsubscribeLibrary();
    document.removeEventListener("DOMContentLoaded", start);
    pending.clear(); preferences = null; favorites = null; snapshot = null;
    clearMarkers();
    // React 可能已移除按钮；仍要清掉遗留在原生链接上的自有 class。
    for (const host of document.querySelectorAll(".tidy-sidebar-favorite-host")) host.classList.remove("tidy-sidebar-favorite-host");
    document.getElementById("tidy-favorites-presentation-style")?.remove();
    // runtime 已失效时移除 Chrome 监听器也可能抛错；DOM 清理不依赖该调用。
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch (_) {}
  }
  pageSession.onDispose(dispose);
  unsubscribeSnapshot = bridge.onSnapshot(onSnapshot);
  if (!sessionActive()) { unsubscribeSnapshot(); return; }
  unsubscribeLibrary = libraryClient.subscribe(onLibrary);
  if (!sessionActive()) { unsubscribeLibrary(); return; }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true, signal: pageSession.signal });
})(globalThis);
