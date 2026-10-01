const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { readPanelCss } = require("./helpers/read-panel-css.cjs");
const { readPanelHtml } = require("./helpers/read-panel-html.cjs");
const root = path.resolve(__dirname, "..");
const html = readPanelHtml();
const css = readPanelCss();
const favoritesView = fs.readFileSync(path.join(root, "src", "features", "favorites", "ui", "favorites-view.js"), "utf8");
const bookmarksView = fs.readFileSync(path.join(root, "src", "features", "bookmarks", "ui", "bookmarks-view.js"), "utf8");
const currentCardModule = fs.readFileSync(path.join(root, "src", "platform", "ui", "current-context-card.js"), "utf8");

function productionFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(entryPath);
    return /\.(?:css|html|js)$/.test(entry.name) ? [entryPath] : [];
  });
}

function cssRules(source) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1].split(",").map((selector) => selector.trim()),
    declarations: match[2].trim(),
  }));
}

function rulesForSelector(rules, selector) {
  return rules.filter((rule) => rule.selectors.includes(selector));
}

function declarationNames(rule) {
  return rule.declarations.split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .map((declaration) => declaration.slice(0, declaration.indexOf(":"))).sort();
}

// Frame 03 must ship inside the actual extension stylesheet. A raw bookmark
// SVG has a large browser-default viewport, so missing these rules makes the
// whole panel look broken even though its data and event handlers still work.
assert.match(html, /<link rel="stylesheet" href="panel\.css"\s*\/>/);
assert.match(css, /\.time-panel__body\[data-active-route="bookmarks"\]\s*\{[^}]*overflow-y:\s*hidden/s);
assert.match(css, /#bookmarks-view\s*\{[^}]*height:\s*100%[^}]*overflow:\s*hidden/s);
assert.match(css, /\.bookmarks-panel\s*\{[^}]*grid-template-rows:[^}]*minmax\(0,\s*1fr\)[^}]*overflow:\s*hidden/s);
// Favorites and Bookmarks must consume one production primitive. The variants
// control composition only; geometry, typography, state, and dark surfaces
// remain single-source so the two modules cannot silently drift again.
assert.match(favoritesView, /import\s*\{[^}]*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/platform\/ui\/current-context-card\.js["']/s);
assert.match(bookmarksView, /import\s*\{[^}]*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/platform\/ui\/current-context-card\.js["']/s);
assert.match(currentCardModule, /export\s+function\s+currentContextCardMarkup\s*\(/);
assert.match(currentCardModule, /current-context-card/);
for (const slot of ["leading", "copy", "title", "subtitle", "trailing"]) {
  assert.match(currentCardModule, new RegExp(`current-context-card__${slot}`));
}
assert.match(currentCardModule, /CARD_VARIANTS\s*=\s*new Set\(\[[^\]]*["']centered["'][^\]]*["']summary["'][^\]]*\]\)/s);
assert.match(currentCardModule, /`current-context-card--\$\{variant\}`/);
assert.match(currentCardModule, /is-selected/);
assert.match(css, /\.current-context-card\s*\{[^}]*width:\s*100%[^}]*min-height:\s*54px/s);
assert.match(css, /\.current-context-card\s*\{[^}]*gap:\s*6px[^}]*padding:\s*8px 12px/s);
assert.match(css, /\.current-context-card__title\s*\{[^}]*font-size:\s*13px[^}]*font-weight:\s*600[^}]*line-height:\s*1\.2/s);
assert.match(css, /\.current-context-card__subtitle\s*\{[^}]*font-size:\s*12px[^}]*line-height:\s*1\.25/s);
assert.match(css, /\.current-context-card--centered/s);
assert.match(css, /\.current-context-card--summary/s);
assert.match(css, /\.current-context-card\.is-selected/s);

// The defect came from two independent surface definitions. Keep the base and
// dark surface on the shared selector exactly once; variants may only describe
// composition, while .is-selected owns the common selected state.
const parsedCssRules = cssRules(css);
const baseSurfaceRules = rulesForSelector(parsedCssRules, ".current-context-card");
assert.equal(baseSurfaceRules.length, 1, "the shared base surface has one source of truth");
assert.match(baseSurfaceRules[0].declarations, /--current-context-card-border\s*:/);
assert.match(baseSurfaceRules[0].declarations, /--current-context-card-surface\s*:/);
assert.match(baseSurfaceRules[0].declarations, /\bborder\s*:\s*[^;]*var\(--current-context-card-border\)/);
assert.match(baseSurfaceRules[0].declarations, /\bbackground\s*:\s*var\(--current-context-card-surface\)/);
const darkSurfaceRules = rulesForSelector(parsedCssRules, ':root[data-native-color-scheme="dark"] .current-context-card');
assert.equal(darkSurfaceRules.length, 1, "dark mode must not reintroduce competing Favorites and Bookmarks surfaces");
assert.deepEqual(
  declarationNames(darkSurfaceRules[0]),
  ["--current-context-card-border", "--current-context-card-surface"],
  "dark mode overrides only the two local surface tokens",
);
assert.doesNotMatch(
  darkSurfaceRules[0].declarations,
  /(?:^|;)\s*(?:border(?:-color)?|background(?:-color)?|color)\s*:/,
  "the higher-specificity dark selector must not mask shared hover or selected surfaces",
);
for (const variant of [".current-context-card--centered", ".current-context-card--summary"]) {
  const rules = rulesForSelector(parsedCssRules, variant);
  assert.equal(rules.length, 1, `${variant} has one composition rule`);
  assert.doesNotMatch(rules[0].declarations, /\b(?:background(?:-color)?|border(?:-color)?|color)\s*:/, `${variant} must not fork the shared surface`);
  assert.doesNotMatch(rules[0].declarations, /\b(?:padding|gap|min-height|border-radius|font-size)\s*:/, `${variant} must not fork shared geometry or typography`);
}
assert.ok(
  parsedCssRules.some((rule) => rule.selectors.some((selector) => selector === ".current-context-card.is-selected" || selector.endsWith(" .current-context-card.is-selected"))),
  "the shared card owns selected-state styling",
);

const legacyDisplayClass = /\b(?:favorite-current-action|favorite-current-copy|favorite-current-star(?:--(?:large|right))?|favorite-current-confirmation|bookmark-current-card(?:__[\w-]+)?)\b/g;
const legacyHits = productionFiles(path.join(root, "src")).flatMap((file) => {
  const matches = [...fs.readFileSync(file, "utf8").matchAll(legacyDisplayClass)].map((match) => match[0]);
  return matches.map((className) => `${path.relative(root, file)}:${className}`);
});
assert.deepEqual(legacyHits, [], "removed view-specific current-card display classes stay at zero across production JS/CSS/HTML");
assert.match(css, /\.bookmark-group-icon svg\s*\{[^}]*width:\s*15px[^}]*fill:\s*none[^}]*stroke:\s*currentColor/s);
assert.match(css, /\.bookmark-group-row\.is-system \.bookmark-group-select\s*\{[^}]*var\(--browse-subtle\)/s);
assert.match(css, /\.bookmark-section-heading, \.bookmark-list-heading\s*\{[^}]*font-weight:\s*500/s);
assert.match(css, /\.bookmark-entry-source\s*\{[^}]*font-size:\s*11px/s);
assert.match(css, /\.bookmark-entry-meta\s*\{[^}]*font-size:\s*10px/s);
assert.match(css, /\.bookmark-entry p\s*\{[^}]*var\(--browse-text\)[^}]*font-size:\s*11px[^}]*line-height:\s*1\.25/s);
assert.doesNotMatch(css, /\.bookmark-entry(?:-source|-meta)?[^{}]*\{[^}]*font-size:\s*var\(/s);
assert.doesNotMatch(css, /\.bookmark-entry-group\s*\{/);
assert.doesNotMatch(css, /\.bookmark-entry-note\s*\{|\.bookmark-note-editor\s*\{/);
assert.match(css, /:root\[data-native-color-scheme="dark"\] \.bookmark-entry p\s*\{[^}]*var\(--browse-text\)/s);
assert.match(css, /--browse-list:\s*#777980/);
assert.match(css, /--browse-muted:\s*#85878d/);
assert.match(css, /--browse-faint:\s*#9b9da2/);

const view = bookmarksView;
assert.match(view, /bookmark-entry-meta__role/);
assert.doesNotMatch(view, /bookmark-entry-group|data-bookmark-edit-note|bookmark-note-editor/);
// Menu state/dismissal is now shared; Bookmarks keeps only its small DOM cleanup
// callback. Search typing must not rebuild the column or steal the active input.
for (const featureView of [favoritesView, bookmarksView]) {
  assert.match(featureView, /import\s*\{\s*createLibraryTransientUi\s*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/platform\/ui\/library-transient-ui\.js["']/);
  assert.match(featureView, /const\s+\w+\s*=\s*createLibraryTransientUi\(\{/);
}
assert.match(view, /close: \(\) => \{ openMenuGroupId = null; iconPickerGroupId = null; openEntryId = null; \},\s*render: removeRenderedOverlays,/);
assert.match(view, /transientUi\.dismiss\(\); resetResultScroll = true; void act\("view-update", \{ groupId:/);
assert.match(view, /transientUi\.dismiss\(\); resetResultScroll = true; void act\("view-update", \{ sortDirection:/);
const localCleanup = view.match(/  function removeRenderedOverlays\(\) \{([\s\S]*?)\n  \}/)?.[1];
assert.ok(localCleanup, "Bookmarks provides a local cleanup callback to the shared lifecycle");
assert.match(localCleanup, /root\.querySelector\("\[data-bookmark-group-overlay\]"\)\?\.remove\(\)/);
assert.match(localCleanup, /root\.querySelector\("\[data-bookmark-entry-overlay\]"\)\?\.remove\(\)/);
assert.match(localCleanup, /classList\.remove\("is-menu-open", "is-picker-open"\)/);
assert.match(localCleanup, /setAttribute\("aria-expanded", "false"\)/);
assert.doesNotMatch(localCleanup, /\brender(?:ListMarkup)?\s*\(|\.innerHTML\s*=|\.replaceChildren\s*\(|\.focus\s*\(/,
  "shared dismissal only retires local overlay DOM, never rebuilds or refocuses the search column");
assert.match(view, /if \(query === model\.store\.view\.query\) return;\s*transientUi\.dismiss\(\);\s*resetResultScroll = true;\s*void act\("view-update", \{ query \}\)/);

// Run actual shared dependencies as well as checking their assembly. The DOM
// fixture models node identity/focus; CSS geometry has separate browser QA.
const { createLibraryViewHarness } = require("./helpers/library-view-harness.cjs");
for (const kind of ["group", "icon", "entry"]) {
  const h = createLibraryViewHarness("bookmarks");
  if (kind === "entry") {
    const bookmarkId = "conversation-a::message-a";
    h.render({ store: { ...h.model.store, view: { ...h.model.store.view, groupId: "all" },
      items: { [bookmarkId]: { bookmarkId, conversationId: "conversation-a", messageId: "message-a",
        routePath: "/c/conversation-a", conversationTitle: "Test", excerpt: "saved excerpt", role: "assistant",
        groupId: "bookmark-quote", bookmarkedAt: "2026-10-01T00:00:00.000Z" } } } });
    h.click('[data-bookmark-entry-menu="' + bookmarkId + '"]');
  } else {
    h.click('[data-bookmark-group-menu="bookmark-quote"]');
    if (kind === "icon") h.click('[data-bookmark-group-action="icon"]');
  }
  assert.ok(h.root.querySelector("[data-bookmark-group-overlay], [data-bookmark-entry-overlay]"), kind + " overlay opens");
  const input = h.root.querySelector("[data-bookmark-search]");
  const groups = h.root.querySelector("[data-bookmark-group-list]");
  const results = h.root.querySelector('[data-results-viewport="bookmarks"]');
  input.value = "retained search"; input.focus(); input.selectionStart = 4; input.selectionEnd = 9;
  h.event("input", input); h.flush();
  assert.equal(h.root.querySelector("[data-bookmark-search]") === input, true, kind + " dismissal keeps the search node");
  assert.equal(h.document.activeElement === input, true, kind + " dismissal preserves search focus");
  assert.equal(input.value, "retained search");
  assert.equal(input.selectionStart, 4); assert.equal(input.selectionEnd, 9);
  assert.equal(h.root.querySelector("[data-bookmark-group-list]") === groups, true);
  assert.equal(h.root.querySelector('[data-results-viewport="bookmarks"]') === results, true);
  assert.equal(h.root.querySelector("[data-bookmark-group-overlay], [data-bookmark-entry-overlay]") === null, true);
  assert.equal(h.root.querySelectorAll('.bookmark-group-row.is-menu-open, .bookmark-group-row.is-picker-open').length, 0);
  assert.equal(h.root.querySelectorAll('[data-bookmark-group-menu][aria-expanded="true"], [data-bookmark-entry-menu][aria-expanded="true"]').length, 0);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].type, "view-update");
  assert.equal(h.actions[0].payload.query, "retained search");
  h.view.dispose();
}

const openBraces = (css.match(/\{/g) || []).length;
const closeBraces = (css.match(/\}/g) || []).length;
assert.equal(openBraces, closeBraces, "panel.css should keep balanced blocks");

console.log("sidepanel bookmark style assertions passed");

