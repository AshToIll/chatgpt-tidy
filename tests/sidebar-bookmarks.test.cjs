const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync("src/features/bookmarks/chatgpt/bookmarks-presentation.js", "utf8");

// The visible badge is width-bounded while title/aria-label retain the exact
// count. This protects project-row time without pretending the count is truly
// infinite or silently dropping accessibility information.
assert.match(source, /if \(count > 9\) return \{ text: "9\+", size: "capped" \}/);
assert.match(source, /data-tidy-bookmark-count-size="capped"[^}]+28px/);
assert.match(source, /button\.title = `\$\{count\}`/);
assert.match(source, /const ariaLabel = [^\n]+\$\{count\}/);
assert.match(source, /setAttribute\("aria-label", ariaLabel\)/);
assert.equal(
  (source.match(/button\.innerHTML =/g) || []).length,
  1,
  "only the one-time message button creation uses innerHTML; count rendering never replaces its subtree",
);
const renderCountsSource = source.slice(source.indexOf("function renderCounts"), source.indexOf("function cleanup"));
assert.doesNotMatch(renderCountsSource, /innerHTML\s*=/);
assert.match(renderCountsSource, /text\.textContent !== displayed\.text/);
assert.match(source, /domOwnership\.areOnlyTidyOwnedMutations\(mutations\)/);

console.log("sidebar bookmark count assertions passed");
