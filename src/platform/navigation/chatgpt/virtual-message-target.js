(function initTidyChatgptVirtualMessageTarget(global) {
  "use strict";
  if (global.TidyChatgptVirtualMessageTarget) return;

  /**
   * ChatGPT keeps a native turn container while its message DOM is virtualized.
   * Its current Fiber owns the conversation/turn ID and a read-only turn snapshot.
   * Prove the exact message there before revealing that container. A turn ID is
   * NOT necessarily a message ID (one assistant turn can contain several).
   *
   * No hook index, minified function name, alternate tree, native setter or
   * module import is a contract. Unknown native shapes simply supply no target.
   * This proof permits loading only; the mounted DOM resolver still owns success.
   */
  function read(element, turnId, conversationId, messageId) {
    if (!element || !turnId || !conversationId || !messageId) return null;
    const key = Object.keys(element).find(name => name.startsWith("__reactFiber$"));
    let fiber = key ? element[key] : null;
    const seen = new Set();
    for (let depth = 0; fiber && depth < 40 && !seen.has(fiber); depth++, fiber = fiber.return) {
      seen.add(fiber);
      const props = fiber.memoizedProps;
      if (!props?.turnId) continue;
      if (props.turnId !== turnId || props.conversation?.id !== conversationId) return null;
      const hooks = new Set(), records = new Set();
      for (let hook = fiber.memoizedState, count = 0; hook && count < 60 && !hooks.has(hook); hook = hook.next, count++) {
        hooks.add(hook);
        // Native useSyncExternalStore caches [currentTurn, previousTurn]. Read
        // only that shallow value, not arbitrary children or a getter callback.
        if (!Array.isArray(hook.memoizedState) || hook.memoizedState.length > 4) continue;
        for (const turn of hook.memoizedState) {
          if (turn?.id !== turnId || !Array.isArray(turn.messages)) continue;
          const matches = turn.messages.filter(message => message?.id === messageId);
          if (matches.length > 1) return null;
          for (const message of matches) {
            const owner = message.conversation_id ?? message.conversationId;
            if ((owner != null && owner !== conversationId) || !["user", "assistant"].includes(message.author?.role)) return null;
            records.add(message);
          }
        }
      }
      return records.size === 1 ? [...records][0] : null;
    }
    return null;
  }
  global.TidyChatgptVirtualMessageTarget = Object.freeze({ read });
})(globalThis);
