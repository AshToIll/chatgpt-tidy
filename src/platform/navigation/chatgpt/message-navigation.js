(function initTidyChatgptMessageNavigation(global) {
  "use strict";

  if (global.TidyChatgptMessageNavigation) return;

  // Only bookmark message commands enter this adapter. Native history search
  // owns its own route, scroll and highlight; observing its URL is not a command.
  const EXCLUDED = 'button, [role="button"], input, textarea, select, script, style, svg, [hidden], [aria-hidden="true"], [data-tidy-owned]';

  function create({ resolveTarget, resolveLoadTarget = () => null, onStatus = () => {},
    isIntentCurrent = () => false, canPresent = () => false, locate = null, cancelLocation = () => {} }) {
    let target = null;
    let status = { located: false, highlighted: false, pending: false, reason: "idle" };
    function report(next) { status = { ...next }; onStatus(status, target); return status; }
    function clear(reason = "cancelled") {
      const previous = target;
      target = null;
      if (previous) cancelLocation(previous.navigationIntentId, reason);
      return report({ located: false, highlighted: false, pending: false, reason });
    }
    function start(payload) {
      if (!isIntentCurrent(payload?.navigationIntentId) || !locate) return { located: false, highlighted: false, pending: false, reason: "superseded" };
      clear("superseded");
      if (!isIntentCurrent(payload.navigationIntentId)) return status;
      if (!payload.conversationId || !payload.messageId) return report({ located: false, highlighted: false, pending: false, reason: "no-message-target" });
      // Query is deliberately not forwarded to the message locator. Search
      // results have a separate native navigation lane, not a bookmark variant.
      const { query: _unusedQuery, ...admitted } = payload;
      target = admitted;
      const current = () => target === admitted && isIntentCurrent(admitted.navigationIntentId);
      const ready = canPresent(admitted.navigationIntentId);
      if (!current()) return status;
      const initial = ready ? resolveTarget(admitted) : { reason: "identity-pending" };
      if (!current()) return status;
      const loadable = ready && !initial.element ? resolveLoadTarget(admitted) : null;
      if (!current()) return status;
      // Presence selects source-page settlement versus native target loading;
      // it is NOT a successful location receipt. Only the common executor can
      // acknowledge geometry. This view owns no timer or second scroll loop.
      report({ located: false, highlighted: false, pending: true, targetPresent: !!(initial.element || loadable?.element),
        reason: initial.element ? "settling" : loadable?.element ? "loading-target" : initial.reason || "message-not-present" });
      if (!current()) return status;
      if (!initial.element && !loadable?.element && payload.waitForTarget !== true) return status;
      Promise.resolve(locate(admitted)).then(result => {
        if (!current()) return;
        report({ highlighted: false, highlightReason: null, ...result, pending: false });
      }).catch(() => {
        if (current()) report({ located: false, highlighted: false, pending: false, reason: "location-failed" });
      });
      return status;
    }
    return Object.freeze({ start, clear,
      dispose() { clear("extension-reloaded"); },
      cancelId: (id, reason = "cancelled") => target?.navigationIntentId === id ? clear(reason) : status,
      getStatus: () => ({ ...status }) });
  }
  // A native message-ID wrapper mounts before its lazy body. Expand/collapse
  // controls and our timestamp already have geometry at that point, but none
  // is message content. Keep that shell in the existing loading phase; do not
  // consume the landing window or report success for an empty bubble.
  function hasRenderedContent(element, document = global.document) {
    const visible = node => {
      for (let parent = node; parent; parent = parent.parentElement) {
        const style = global.getComputedStyle(parent);
        if (style.display === "none" || /^(hidden|collapse)$/.test(style.visibility)) return false;
        if (parent === element) return true;
      }
      return false;
    };
    const walker = document.createTreeWalker(element, 4);
    for (let node = walker.nextNode(), count = 0; node && count < 1_000; node = walker.nextNode(), count++) {
      const parent = node.parentElement;
      if (String(node.textContent || "").trim() && parent && !parent.closest(EXCLUDED)
        && global.TidyChatgptMessageDom.closest(parent) === element && visible(parent)) return true;
    }
    // Image-only/audio messages are content too. Their preview may itself be
    // a button, unlike the shell's text controls; do not require a text query.
    for (const media of element.querySelectorAll?.('img, video, audio, canvas') || []) {
      if (global.TidyChatgptMessageDom.closest(media) !== element
        || media.closest('[hidden], [aria-hidden="true"], [data-tidy-owned]') || !visible(media)) continue;
      const rect = media.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
    }
    return false;
  }
  global.TidyChatgptMessageNavigation = Object.freeze({ create, hasRenderedContent });
})(globalThis);
