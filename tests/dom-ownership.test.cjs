const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function element({ parent = null, classes = [], dataset = {} } = {}) {
  const value = {
    nodeType: 1,
    parentElement: parent,
    classList: classes,
    className: classes.join(" "),
    dataset: { ...dataset },
    closest(selector) {
      let current = this;
      while (current) {
        if (selector === "[data-tidy-owned]" && current.dataset?.tidyOwned) return current;
        current = current.parentElement;
      }
      return null;
    },
  };
  return value;
}

const context = vm.createContext({ Object, Array, Boolean, Node: { ELEMENT_NODE: 1 } });
vm.runInContext(fs.readFileSync("src/platform/ui/dom-ownership.js", "utf8"), context);
const ownership = context.TidyDomOwnership;

const nativeHost = element();
const ownedRoot = element({ parent: nativeHost, dataset: { tidyOwned: "sidebar-bookmark-count" } });
const ownedText = { nodeType: 3, parentElement: ownedRoot };
const nativeChild = element({ parent: nativeHost });

assert.equal(ownership.isTidyOwnedMutation({ type: "characterData", target: ownedText }), true);
assert.equal(ownership.isTidyOwnedMutation({
  type: "childList",
  target: nativeHost,
  addedNodes: [ownedRoot],
  removedNodes: [],
}), true);
assert.equal(ownership.isTidyOwnedMutation({
  type: "childList",
  target: nativeHost,
  addedNodes: [nativeChild],
  removedNodes: [],
}), false);

const markedNativeHost = element({
  classes: ["native", "tidy-sidebar-time-host"],
  dataset: { tidyMainWorld: "ready" },
});
assert.equal(ownership.isTidyOwnedMutation({
  type: "attributes",
  attributeName: "class",
  target: markedNativeHost,
  addedNodes: [],
  removedNodes: [],
}), false, "native html/class changes stay observable even with data-tidy-main-world");
assert.equal(ownership.areOnlyTidyOwnedMutations([
  { type: "characterData", target: ownedText },
]), true);

console.log("dom ownership assertions passed");
