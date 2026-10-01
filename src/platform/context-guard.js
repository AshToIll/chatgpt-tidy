export function assertExpectedConversationContext(tab, snapshot, expected = {}) {
  if (Number.isInteger(expected.tabId) && tab?.id !== expected.tabId) {
    throw Object.assign(new Error("The active ChatGPT tab changed before the action completed."), {
      code: "CONTEXT_MISMATCH",
      tidyCode: "CONTEXT_MISMATCH",
    });
  }
  if (
    expected.conversationId &&
    snapshot?.conversation?.conversationId !== expected.conversationId
  ) {
    throw Object.assign(new Error("The active ChatGPT conversation changed before the action completed."), {
      code: "CONTEXT_MISMATCH",
      tidyCode: "CONTEXT_MISMATCH",
    });
  }
  return true;
}
