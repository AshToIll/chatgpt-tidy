const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("native sidebar layout loads at document_start and is not owned by asynchronous decorators", () => {
  const manifest = JSON.parse(read("src/manifest.json"));
  const owner = manifest.content_scripts.find(entry => entry.css?.includes("platform/chatgpt/sidebar-layout.css"));
  assert.equal(owner?.run_at, "document_start");
  const css = read("src/platform/chatgpt/sidebar-layout.css");
  assert.match(css, /--tidy-sidebar-row-height: 52px/);
  assert.match(css, /--tidy-sidebar-row-bottom: 17px/);
  // Manifest CSS cannot be unloaded after an extension reload. Every rule is
  // gated by the one document session marker, including native Work alignment.
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "").match(/(?:^|\})\s*([^{}]+)\{/g) || [];
  assert.equal(selectors.length, 8);
  for (const selector of selectors) assert.match(selector, /:root\[data-tidy-page-session="active"\]/);
  for (const feature of ["time", "favorites", "bookmarks"]) {
    const source = read(`src/features/${feature}/chatgpt/${feature}-presentation.js`);
    assert.doesNotMatch(source, /min-height:\s*52px|padding-bottom:\s*17px|tidy-sidebar-time-host/);
    assert.doesNotMatch(source, /scrollTop\s*=|scrollIntoView\(/, "decorators must not compensate by forcing native scroll");
  }
});
