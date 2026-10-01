// 原生观察生命周期唯一所有者：DOM、history、交互settle与监听解绑；BFCache只暂停导航。
(function initTidyChatgptNativeObserver(global) {
  "use strict";
  if (global.TidyChatgptNativeObserver) return;
  function create({ onRefresh: scheduleRefresh, onRoute, onHidden, onMessage }) {
    const session = global.TidyPageSession;
    const domOwnership = global.TidyDomOwnership;
    const document = global.document;
    const listeners = [];
    const historyHooks = [];
    const settleTimers = new Set();
    let observer = null;
    let appearanceObserver = null;
    let disposed = false;
    function listen(target, type, listener, options) {
      target.addEventListener(type, listener, options);
      listeners.push(() => target.removeEventListener(type, listener, options));
    }

    listen(global, "message", onMessage);
    const notifyRoute = () => {
      if (disposed || !session.check()) return;
      global.TidyChatgptApi.checkLibraryIdentity();
      onRoute();
      scheduleRefresh("spa-route", 30);
    };
    for (const method of ["pushState", "replaceState"]) {
      const original = global.history[method];
      const wrapped = function tidyHistoryMethod(...args) {
        const result = original.apply(this, args);
        if (!disposed && session.check()) queueMicrotask(notifyRoute);
        return result;
      };
      global.history[method] = wrapped;
      historyHooks.push({ method, original, wrapped });
    }
    listen(global, "popstate", notifyRoute);
    listen(global, "hashchange", notifyRoute);
    listen(global, "focus", () => { if (!disposed && session.check()) global.TidyChatgptApi.checkLibraryIdentity(); });
    listen(document, "visibilitychange", () => { if (!disposed && session.check()) global.TidyChatgptApi.checkLibraryIdentity(); });
    // BFCache is a reversible document pause, not retirement. Keep the location
    // controller's listeners installed so restored documents can navigate again.
    listen(global, "pagehide", onHidden);

    // Expanding a project is not necessarily an SPA navigation: ChatGPT may
    // reveal an already-mounted lazy subtree without changing the URL. Sample
    // immediately and once after the small open animation/data settle window.
    // This is interaction-bounded and replaces neither MutationObserver nor a
    // forbidden page-wide polling loop.
    listen(global, "click", (event) => {
      if (disposed || !session.check()) return;
      const target = event.target?.closest?.(
        'a[href$="/project"], a[href*="/g/g-p-"], [aria-expanded]',
      );
      if (!target) return;
      scheduleRefresh("project-interaction", 30);
      const timer = setTimeout(() => {
        settleTimers.delete(timer);
        if (disposed || !session.check()) return;
        scheduleRefresh("project-interaction-settled", 0);
      }, 420);
      settleTimers.add(timer);
    }, true);

    const startObserver = () => {
      if (disposed || !session.check()) return;
      observer = new global.MutationObserver((mutations) => {
        if (disposed || !session.check()) return;
        if (!domOwnership.areOnlyTidyOwnedMutations(mutations)) {
          scheduleRefresh("dom-mutation");
        }
      });
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["href", "data-message-id", "data-chatgpt-search-message-ids", "data-sidebar-item", "aria-expanded", "hidden", "aria-hidden"],
      });
      appearanceObserver = new global.MutationObserver((mutations) => {
        if (disposed || !session.check()) return;
        if (!domOwnership.areOnlyTidyOwnedMutations(mutations)) {
          scheduleRefresh("appearance-change", 30);
        }
      });
      appearanceObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme", "data-color-scheme"],
      });
      scheduleRefresh("initial", 0);
    };


    function dispose() {
      disposed = true;
      for (const timer of settleTimers) clearTimeout(timer);
      settleTimers.clear(); observer?.disconnect(); appearanceObserver?.disconnect();
      for (const remove of listeners) remove();
      for (const { method, original, wrapped } of historyHooks) {
        if (global.history[method] === wrapped) global.history[method] = original;
      }
    }
    if (document.documentElement) startObserver();
    else listen(document, "DOMContentLoaded", startObserver, { once: true });
    return Object.freeze({ dispose });
  }
  global.TidyChatgptNativeObserver = Object.freeze({ create });
})(globalThis);
