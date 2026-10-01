const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const path = require("node:path");
const viewFiles = {
  "bookmarks-view": "src/features/bookmarks/ui/bookmarks-view.js",
  "favorites-view": "src/features/favorites/ui/favorites-view.js",
  "current-context-card": "src/platform/ui/current-context-card.js",
  "export-view": "src/features/export/ui/export-view.js",
  "title-view": "src/features/titles/ui/title-view.js",
};
function assertHelperImport(source, owner, helper) {
  const imports = [...source.matchAll(/import \{ ([^}]+) \} from "([^"]+)";/g)];
  assert.ok(imports.some(([, bindings, dependency]) => bindings.split(",").map(value => value.trim()).includes(helper.name)
    && path.resolve(path.dirname(owner), dependency) === path.resolve(helper.file)), owner + " uses the shared " + helper.name);
}

test("escapeHtml has one entity form and no browser dependencies", async () => {
  const { escapeHtml } = await import("../src/platform/ui/html.js");
  for (const [value, expected] of [
    [null, ""], [undefined, ""], [0, "0"], [false, "false"],
    ["<&>\"'", "&lt;&amp;&gt;&quot;&#39;"],
    ["&amp; &#39;", "&amp;amp; &amp;#39;"],
    ["中文 日本語 😀\n", "中文 日本語 😀\n"],
    ['<a title="x" onclick=\'y\'>', "&lt;a title=&quot;x&quot; onclick=&#39;y&#39;&gt;"],
  ]) assert.equal(escapeHtml(value), expected);
});

test("clampPage preserves the two views' shared finite, fractional and empty-result contract", async () => {
  const { clampPage } = await import("../src/platform/ui/pagination.js");
  for (const [value, pages, expected] of [
    [1, 5, 1], [5, 5, 5], [100, 5, 5], [0, 5, 1], [-3, 5, 1],
    [2.9, 5, 2], [-2.9, 5, 1], ["3", 5, 3], ["", 5, 1],
    [null, 5, 1], [undefined, 5, 1], ["invalid", 5, 1],
    [NaN, 5, 1], [Infinity, 5, 1], [-Infinity, 5, 1],
    [1, 1, 1], [99, 1, 1],
  ]) assert.equal(clampPage(value, pages), expected);
});

test("all five ESM view renderers import escaping; only library views share page clamping", () => {
  for (const name of ["bookmarks-view", "favorites-view", "current-context-card", "export-view", "title-view"]) {
    const source = fs.readFileSync(viewFiles[name], "utf8");
    // Export's entry point now composes owners; its pure markup module owns escaping.
    // Require that exact edge as well as the shared helper, not any transitive match.
    const markupFile = name === "export-view" ? "src/features/export/ui/export-markup.js" : viewFiles[name];
    if (name === "export-view") {
      assertHelperImport(source, viewFiles[name], { name: "renderExportMarkup", file: markupFile });
    }
    const markup = fs.readFileSync(markupFile, "utf8");
    assertHelperImport(markup, markupFile, { name: "escapeHtml", file: "src/platform/ui/html.js" });
    assert.doesNotMatch(source, /function escapeHtml\(/);
    assert.doesNotMatch(markup, /function escapeHtml\(/);
    if (["bookmarks-view", "favorites-view"].includes(name)) {
      assertHelperImport(source, viewFiles[name], { name: "clampPage", file: "src/platform/ui/pagination.js" });
      assert.doesNotMatch(source, /function clampPage\(/);
    }
  }
});

test("the real ESM view graph resolves the extracted helpers without a VM import shim", async () => {
  for (const [name, exported] of [
    ["bookmarks-view", "createBookmarksView"], ["favorites-view", "createFavoritesView"],
    ["current-context-card", "currentContextCardMarkup"], ["export-view", "createExportView"],
    ["title-view", "createTitleView"],
  ]) {
    const module = await import(`../${viewFiles[name]}`);
    assert.equal(typeof module[exported], "function");
  }
});
