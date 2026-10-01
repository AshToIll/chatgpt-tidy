// 严格验证活动分支：缺祖先与循环都失败，绝不把局部分支重新编号为第一条。
(function initTidyChatgptActiveBranch(global) {
  "use strict";
  if (global.TidyChatgptActiveBranch) return;
  function activeBranch(payload) {
    const mapping = payload?.mapping;
    const currentNode = payload?.current_node || payload?.currentNode;
    if (!mapping || typeof mapping !== "object" || !currentNode || !mapping[currentNode]) {
      throw new Error("The current conversation response has no active message branch.");
    }
    const branch = [];
    const seen = new Set();
    let nodeId = currentNode;
    while (nodeId) {
      const node = mapping[nodeId];
      // A broken chain is not a complete conversation starting at message 1.
      // Export numbering requires a verified path all the way to a root;
      // missing ancestors and cycles must fail, not silently truncate it.
      if (!node || typeof node !== "object" || seen.has(nodeId)
        || !Object.hasOwn(node, "parent")
        || (node.parent !== null && (typeof node.parent !== "string" || !node.parent))) {
        throw new Error("The current conversation's active message branch is incomplete or cyclic.");
      }
      seen.add(nodeId);
      branch.push(node);
      nodeId = node.parent;
    }
    return branch.reverse();
  }

  function responseConversationId(payload) {
    return payload?.conversation_id || payload?.conversationId || payload?.id || null;
  }


  global.TidyChatgptActiveBranch = Object.freeze({ activeBranch, responseConversationId });
})(globalThis);
