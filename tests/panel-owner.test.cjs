const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/platform/navigation/panel-owner.js"), "utf8")
  .replace(/^export\s+/gm, "");
const context = vm.createContext({ URL, URLSearchParams });
vm.runInContext(source, context, { filename: "panel-owner.js" });

test("a tab-specific Side Panel path carries one strict owner id", () => {
  assert.equal(context.createSidePanelPath(0), "app/sidepanel/index.html?tidyTabId=0");
  assert.equal(context.createSidePanelPath(52), "app/sidepanel/index.html?tidyTabId=52");
  assert.equal(
    context.parsePanelOwnerTabId(
      "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=52",
      "chrome-extension://tidy-test/app/sidepanel/index.html",
    ),
    52,
  );
});

for (const [name, url] of [
  ["relative", "app/sidepanel/index.html?tidyTabId=73"],
  ["missing", "chrome-extension://tidy-test/app/sidepanel/index.html"],
  ["duplicate", "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=1&tidyTabId=2"],
  ["negative", "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=-1"],
  ["decimal", "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=1.5"],
  ["exponent", "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=1e2"],
  ["whitespace", "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=%201"],
  ["leading zero", "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=01"],
  ["overflow", "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=9007199254740992"],
  ["extra parameter", "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=1&mode=x"],
  ["fragment", "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=1#x"],
  ["empty fragment", "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=1#"],
  ["empty trailing parameter", "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=1&"],
  ["encoded value", "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=%31"],
  ["encoded parameter name", "chrome-extension://tidy-test/app/sidepanel/index.html?tidy%54abId=1"],
  ["normalized dot path", "chrome-extension://tidy-test/app/sidepanel/foo/../index.html?tidyTabId=1"],
  ["userinfo", "chrome-extension://user@tidy-test/app/sidepanel/index.html?tidyTabId=1"],
  ["wrong origin", "chrome-extension://other/app/sidepanel/index.html?tidyTabId=1"],
  ["wrong path", "chrome-extension://tidy-test/other.html?tidyTabId=1"],
]) {
  test(`${name} owner URL fails closed`, () => {
    assert.equal(
      context.parsePanelOwnerTabId(url, "chrome-extension://tidy-test/app/sidepanel/index.html"),
      null,
    );
  });
}

test("owner parsing requires the exact production extension base URL", () => {
  const url = "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=1";
  assert.equal(context.parsePanelOwnerTabId(url), null);
  assert.equal(context.parsePanelOwnerTabId(url, null), null);
  assert.equal(context.parsePanelOwnerTabId(url, "https://tidy-test/app/sidepanel/index.html"), null);
});

test("the largest safe owner id round-trips without coercion", () => {
  const tabId = Number.MAX_SAFE_INTEGER;
  const path = context.createSidePanelPath(tabId);
  assert.equal(path, `app/sidepanel/index.html?tidyTabId=${tabId}`);
  assert.equal(
    context.parsePanelOwnerTabId(
      `chrome-extension://tidy-test/${path}`,
      "chrome-extension://tidy-test/app/sidepanel/index.html",
    ),
    tabId,
  );
});

test("path creation rejects Chrome's sentinel and unsafe values", () => {
  for (const value of [-1, -0, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, "52", null]) {
    assert.throws(
      () => context.createSidePanelPath(value),
      (error) => error?.name === "TypeError",
    );
    assert.equal(context.isValidTabId(value), false);
  }
});
