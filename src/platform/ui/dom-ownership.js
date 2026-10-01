(function initTidyDomOwnership(global) {
  "use strict";

  if (global.TidyDomOwnership) return;

  const OWNED_SELECTOR = "[data-tidy-owned]";

  function asElement(node) {
    if (!node) return null;
    if (node.nodeType === Node.ELEMENT_NODE) return node;
    return node.parentElement || null;
  }

  function isOwnedNode(node) {
    return Boolean(asElement(node)?.closest?.(OWNED_SELECTOR));
  }

  /**
   * A MutationRecord belongs to TIDY only when its target is inside an
   * explicitly owned subtree, or every added/removed root is explicitly
   * owned. Native ChatGPT elements never become owned merely because TIDY
   * adds a helper class or data attribute to them.
   */
  function isTidyOwnedMutation(mutation) {
    if (!mutation) return false;
    if (isOwnedNode(mutation.target)) return true;

    const changedNodes = [
      ...(mutation.addedNodes || []),
      ...(mutation.removedNodes || []),
    ];
    return changedNodes.length > 0 && changedNodes.every(isOwnedNode);
  }

  function areOnlyTidyOwnedMutations(mutations) {
    return Boolean(mutations?.length) && [...mutations].every(isTidyOwnedMutation);
  }

  global.TidyDomOwnership = Object.freeze({
    OWNED_SELECTOR,
    isOwnedNode,
    isTidyOwnedMutation,
    areOnlyTidyOwnedMutations,
  });
})(globalThis);
