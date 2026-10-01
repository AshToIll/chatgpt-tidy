(function initTidyPanelContext(global) {
  "use strict";

  if (global.TidyPanelContext) return;

  function pathname(value) {
    if (typeof value === "object" && typeof value?.route?.pathname === "string") {
      return value.route.pathname;
    }
    try {
      return new URL(String(value || ""), "https://chatgpt.com").pathname;
    } catch {
      return "";
    }
  }

  function routeKey(tabId, value) {
    return `${Number.isInteger(tabId) ? tabId : "none"}|${pathname(value)}`;
  }

  // Every new request or route invalidation advances the generation. Async
  // responses may update UI state only while their generation is current.
  function createRequestGate() {
    let generation = 0;
    return Object.freeze({
      next: () => ++generation,
      invalidate: () => ++generation,
      isCurrent: (candidate) => candidate === generation,
      current: () => generation,
    });
  }

  global.TidyPanelContext = Object.freeze({ pathname, routeKey, createRequestGate });
})(globalThis);
