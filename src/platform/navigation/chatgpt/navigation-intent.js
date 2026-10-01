(function initTidyChatgptNavigationIntent(global) {
  "use strict";
  if (global.TidyChatgptNavigationIntent) return;

  /**
   * The worker owns the one latest navigation per tab. This is only its page
   * execution fence, shared by search, saved-conversation opens and bookmarks.
   * A worker-lifetime epoch + ingress sequence also rejects delayed IPC from a
   * retired worker. Cancellation keeps a tombstone; the same intent cannot be
   * reinstalled by a late active packet.
   */
  function create({ parseRoute, readIdentity = null, onRevoked = () => {} }) {
    let current = null;
    function revoke(reason, notify) {
      if (!current || current.phase !== "active") return false;
      current.phase = "cancelled";
      onRevoked({ navigationIntentId: current.navigationIntentId, reason, notify });
      return true;
    }
    function observe(value) {
      if (typeof value?.navigationIntentId !== "string" || !value.navigationIntentId || value.navigationIntentId.length > 200
        || !Number.isSafeInteger(value.workerEpoch) || value.workerEpoch < 1
        || !Number.isSafeInteger(value.sequence) || value.sequence < 1
        || !["active", "cancelled"].includes(value.phase)
        || (value.ownerAccountKey != null && (typeof value.ownerAccountKey !== "string" || !value.ownerAccountKey))
        || (value.conversationId != null && (typeof value.conversationId !== "string" || !value.conversationId))) return { accepted: false };
      const comparison = !current ? 1 : value.workerEpoch !== current.workerEpoch
        ? Math.sign(value.workerEpoch - current.workerEpoch) : Math.sign(value.sequence - current.sequence);
      if (comparison < 0) return { accepted: false };
      if (comparison === 0) {
        const observed = current;
        if (value.navigationIntentId !== current.navigationIntentId) return { accepted: false };
        if (value.phase === "cancelled") revoke("cancelled", false);
        else if (current.phase === "active" && value.conversationId !== current.conversationId) {
          // The ingress packet can arrive before the saved item is read. Only
          // its first verified destination may fill that blank; no target swap.
          if (current.conversationId != null || !value.conversationId) return { accepted: false };
          current.conversationId = value.conversationId;
          current.sawDestination = parseRoute()?.conversationId === value.conversationId;
        }
        // OPEN's source gate can later become the exact same command's LOCATE
        // gate in a same-document jump. This only attaches its admitted owner.
        if (value.ownerAccountKey && current.phase === "active") {
          if (current.ownerAccountKey && current.ownerAccountKey !== value.ownerAccountKey) return { accepted: false };
          current.ownerAccountKey = value.ownerAccountKey;
        }
        if (readIdentity && current.phase === "active") refreshIdentity();
        return { accepted: current === observed && value.phase === current.phase };
      }
      const previous = current;
      const originConversationId = parseRoute()?.conversationId || null;
      const installed = { ...value, originConversationId, sawDestination: value.conversationId === originConversationId };
      current = installed;
      // Install before notifying cancellation: a synchronous callback may
      // deliver an even newer control packet. Never overwrite that newer one.
      if (previous?.phase === "active") onRevoked({ navigationIntentId: previous.navigationIntentId, reason: "superseded", notify: false });
      if (current === installed && readIdentity && current.phase === "active") refreshIdentity();
      return { accepted: current === installed && current.phase === value.phase };
    }
    function isCurrent(navigationIntentId) {
      return Boolean(current?.phase === "active" && navigationIntentId === current.navigationIntentId);
    }
    // Sole page-side identity lifetime for ALL navigation effects. Search and
    // bookmark renderers may ask whether presentation is ready; they cannot
    // create their own identity subscriptions or revive a cancelled command.
    function observeIdentity(identity) {
      if (current?.phase !== "active") return;
      const owned = Object.hasOwn(current, "ownerAccountKey");
      const state = global.TidyNavigationIdentity.state(identity, current.ownerAccountKey);
      if (state === "revoked" || (!owned && identity.phase !== "ready")) {
        revoke(identity.transition === "document-hidden" ? "page-hidden" : "identity-changed", true);
        return;
      }
      if (owned && state === "ready") current.ownerAccountKey ??= identity.accountKey;
      current.identityReady = state === "ready";
    }
    function refreshIdentity() {
      const before = current;
      const identity = readIdentity(); // may synchronously revoke/replace current
      if (current === before) observeIdentity(identity);
    }
    function canPresent(id) {
      const before = current;
      if (!isCurrent(id)) return false;
      if (readIdentity) refreshIdentity();
      return current === before && isCurrent(id) && current.identityReady === true;
    }
    function routeChanged() {
      if (current?.phase !== "active") return;
      const conversationId = parseRoute()?.conversationId || null;
      if (conversationId === current.conversationId) { current.sawDestination = true; return; }
      if (!current.sawDestination && conversationId === current.originConversationId) return;
      revoke("route-changed", true);
    }
    return Object.freeze({ observe, isCurrent, canPresent, observeIdentity, routeChanged,
      cancel: (reason = "cancelled") => revoke(reason, true),
      getCurrent: () => current ? { ...current } : null });
  }
  global.TidyChatgptNavigationIntent = Object.freeze({ create });
})(globalThis);
