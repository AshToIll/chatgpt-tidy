// Navigation receipts are separate from search pages. Keep the cancellation
// handle after a receipt, but only consume a receipt for the exact clicked target.
export function createSearchResultNavigation({ onAction, createIntentId }) {
  let owned = null;
  function cancel(reason) {
    if (!owned) return;
    const { id } = owned;
    owned = null;
    void Promise.resolve(onAction("cancel-navigation", { navigationIntentId: id, reason })).catch(() => {});
  }
  function cancelId(id) { if (owned?.id === id) owned = null; }
  function open(payload) {
    cancel("superseded");
    const id = createIntentId();
    owned = { id, conversationId: payload.conversationId, messageId: payload.messageId ?? null,
      latest: payload.navigationKind === "conversation", completed: false };
    void Promise.resolve(onAction("open", { ...payload, navigationIntentId: id })).catch(() => {});
  }
  function complete(result) {
    if (!owned || owned.completed || result?.navigationIntentId !== owned.id
      || result.conversationId !== owned.conversationId || (result.messageId ?? null) !== owned.messageId
      || typeof result.located !== "boolean" || (owned.latest ? result.placement !== "latest" : result.placement != null)) return false;
    owned.completed = true;
    return true;
  }
  // A route's intermediate null snapshot is part of our own authorized OPEN.
  function ownsConversationTransition(next) { return Boolean(owned && (next === null || next === owned.conversationId)); }
  return Object.freeze({ open, cancel, cancelId, complete, ownsConversationTransition });
}
