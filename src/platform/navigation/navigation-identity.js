(function initTidyNavigationIdentity(global) {
  "use strict";
  if (global.TidyNavigationIdentity) return;

  const isInitializing = transition => transition === "workspace-unconfirmed" || transition === "workspace-restored";

  /**
   * Pure presentation contract, shared by the worker and its page executor.
   * A data lease is NEVER kept alive here. Waiting retains only the explicit
   * command; no DOM effect or success is allowed until its owner is confirmed.
   * Callers keep cancellation tombstones, so A -> B -> A cannot revive a click.
   */
  function state(identity, ownerAccountKey) {
    if (identity?.phase === "ready" && typeof identity.accountKey === "string" && identity.accountKey) {
      return !ownerAccountKey || ownerAccountKey === identity.accountKey ? "ready" : "revoked";
    }
    if (identity?.phase === "unavailable") {
      // A new, browser-proven document has not observed its first identity yet.
      if (identity.epoch === 0 && !identity.transition) return "waiting";
      if (ownerAccountKey && isInitializing(identity.transition)) return "waiting";
    }
    return "revoked";
  }

  // Product policy: cold native conversation loading is separate from landing.
  // Live long-history loads exceed 12 s; allow at most 30 s to obtain a usable
  // exact target, then the existing 2.4 s geometry window. Worker stamps both
  // absolute deadlines once. Neither ready nor document handoff can renew them.
  global.TidyNavigationIdentity = Object.freeze({ state, isInitializing,
    // 无刷新导航含路由切换和消息/末尾定位，最多尝试 6 秒；失败整页补载一次。
    // 账号等待不会触发补载；成功立即结束。全程仍共用同一份 30 秒加载预算。
    NATIVE_TARGET_WINDOW_MS: 6_000,
    LOAD_WINDOW_MS: 30_000, LANDING_WINDOW_MS: 2_400 });
})(globalThis);
