const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { readPanelCss } = require("./helpers/read-panel-css.cjs");
const read = (file) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
const approvedBaseline = read("tests/fixtures/approved-ui-baseline.css");
const production = read("src/features/titles/ui/title.css");

function declarations(css, selector) {
  const exact = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = css.match(new RegExp(`^${exact}\\s*\\{([^}]+)\\}`, "m"));
  assert.ok(block, `Missing approved selector: ${selector}`);
  return Object.fromEntries(block[1].split(";").map((part) => {
    const colon = part.indexOf(":");
    return colon < 0 ? null : [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
  }).filter(Boolean));
}

// The public fixture freezes only the approved typography/content declarations.
// Later approved changes (underline tabs, quiet card edges, tighter status
// spacing) have separate assertions below instead of preserving retired UI.
for (const [suffix, properties] of [
  ["panel", ["grid-template-rows", "gap"]],
  ["current", ["display", "align-content", "padding-right"]],
  ["scope", ["gap", "padding-bottom"]],
  ["scope > strong", ["font-size", "font-weight", "text-overflow", "white-space"]],
  ["scope > small", ["font-size", "line-height"]],
  ["rule", ["gap", "padding-bottom"]],
  ["rule > h3", ["font-size", "font-weight", "line-height"]],
  ["rule-controls", ["grid-template-columns", "gap"]],
  ["rule-select select", ["height", "padding", "font-size", "border-radius", "appearance"]],
  ["preview-card", ["padding", "border", "border-radius"]],
  ["preview-card.is-clean", ["background", "border-color"]],
  ["preview-card dl", ["gap", "margin"]],
  ["preview-card dl > div", ["grid-template-columns", "gap"]],
  ["preview-card dt", ["font-size", "font-weight"]],
  ["preview-card dd", ["font-size", "line-height"]],
  ["action-bar", ["min-height", "gap", "padding-top"]],
  ["icon-action", ["min-height", "display", "align-items", "gap", "padding", "border", "border-radius", "background", "font-size", "font-weight"]],
  ["icon-action svg", ["width", "height", "fill", "stroke", "stroke-width"]],
]) {
  test(`title UI keeps approved baseline dimensions: ${suffix}`, () => {
    const expected = declarations(approvedBaseline, `.title-time-${suffix}`);
    const actual = declarations(production, `.titles-${suffix}`);
    for (const property of properties) assert.equal(actual[property], expected[property], `${suffix}.${property}`);
  });
}

test("title page tabs copy Search underline navigation in light and dark themes", () => {
  const search = readPanelCss();
  for (const [suffix, properties] of [
    ["", ["display", "grid-template-columns", "border-bottom"]],
    [" button", ["min-width", "min-height", "padding", "border", "border-bottom", "background", "color", "font", "font-size", "cursor"]],
    [' button[aria-selected="true"]', ["border-bottom-color", "color", "font-weight"]],
  ]) {
    const expected = declarations(search, `.search-mode-tabs${suffix}`);
    const actual = declarations(production, `.titles-mode-tabs${suffix}`);
    for (const property of properties) assert.equal(actual[property], expected[property], `titles-mode-tabs${suffix}.${property}`);
    for (const retired of ["height", "border-radius", "box-shadow"]) assert.equal(actual[retired], undefined);
  }
  const tabs = declarations(production, ".titles-mode-tabs");
  assert.equal(tabs.background, undefined, "page tabs must not regain a surrounding pill");
  assert.equal(declarations(production, ".titles-mode-tabs button:focus-visible")["outline-offset"], "-2px");
  assert.match(declarations(production, ".titles-mode-tabs button:focus-visible").outline, /var\(--accent-ring\)/);
  assert.equal(declarations(production, ".titles-mode-tabs button:disabled").color, "var(--text-tertiary)");
  assert.doesNotMatch(production, /:root\[data-native-color-scheme="dark"\][^{]*\.titles-mode-tabs/);
  assert.doesNotMatch(production, /\.titles-mode-tabs button\.is-active/);
});

test("preview cards retain readable state cues without a redundant left stripe", () => {
  const base = declarations(production, ".titles-preview-card");
  assert.equal(base.border, "1px solid #e5e5e8");
  assert.equal(base["min-width"], "0");
  for (const state of ["clean", "replace", "matched", "risk", "decision"]) {
    const actual = declarations(production, `.titles-preview-card.is-${state}`);
    assert.ok(actual.background, `${state} keeps its soft background`);
    assert.ok(actual["border-color"], `${state} keeps a thin state outline`);
  }
  assert.doesNotMatch(production, /border-left(?:-[a-z]+)?\s*:/);
  assert.equal(declarations(production, ':root[data-native-color-scheme="dark"] .titles-preview-card').background, "var(--surface-subtle)");
  assert.equal(declarations(production, ':root[data-native-color-scheme="dark"] .titles-preview-card')["border-color"], "var(--border)");
  assert.equal(declarations(production, ".titles-preview-card dd")["overflow-wrap"], "anywhere");
});

test("only the two status-adjacent spaces tighten while regular sections keep 10px", () => {
  assert.equal(declarations(production, ".titles-current").gap, "0");
  assert.equal(declarations(production, ".titles-current > * + *")["margin-top"], "10px");
  assert.equal(declarations(production, ".titles-current > .titles-rule + .titles-status")["margin-top"], "4px");
  assert.equal(declarations(production, ".titles-current > .titles-status + .titles-preview")["margin-top"], "4px");
  assert.equal(declarations(production, ".titles-status").height, "24px");
  assert.doesNotMatch(production, /\.titles-current[^{}]*\{[^}]*margin(?:-top|-bottom)?:\s*-/);
});

test("title footer follows the preview instead of being pinned at panel bottom", () => {
  const panel = declarations(production, ".titles-panel");
  assert.equal(panel["grid-template-rows"], "auto minmax(0, 1fr)");
  assert.equal(declarations(production, ".titles-current")["align-content"], "start");
  assert.doesNotMatch(production, /position:\s*(?:fixed|sticky)/);
});

test("narrow title footers wrap action groups rather than splitting confirmation words", () => {
  assert.equal(declarations(production, ".titles-action-bar")["flex-wrap"], "wrap");
  assert.equal(declarations(production, ".titles-action-bar button")["white-space"], "nowrap");
  assert.equal(declarations(production, ".titles-action-bar button")["flex-shrink"], "0");
});

test("approved body inset and subtitle size are scoped to title organization", () => {
  assert.equal(declarations(production, '.time-panel__body[data-active-route="titles"]')["padding-right"], "10px");
  assert.equal(declarations(production, '.time-panel:has([data-active-route="titles"]) .time-panel__header p')["font-size"], "12px");
});

test("dark confirmation uses the theme foreground without changing the light baseline", () => {
  const dark = declarations(production, ':root[data-native-color-scheme="dark"] .titles-action-bar__end > button:not(.titles-icon-action):not(:disabled)');
  assert.equal(dark.color, "var(--accent-foreground)");
  assert.equal(declarations(production, '.titles-action-bar__end > button:not(.titles-icon-action)').color, "#fff");
});

test("the title status row inherits search's fixed centered 24px waiting slot", () => {
  const expected = declarations(readPanelCss(), ".search-status");
  const actual = declarations(production, ".titles-status");
  for (const property of ["height", "box-sizing", "display", "align-items", "justify-content", "text-align"]) {
    assert.equal(actual[property], expected[property], `titles-status.${property}`);
  }
  assert.equal(actual.height, "24px");
  assert.equal(actual["justify-content"], "center");
});

test("the text Back entry preserves the approved remove-date navigation", () => {
  const expected = declarations(approvedBaseline, ".title-time-remove-entry");
  const actual = declarations(production, ".titles-back-action");
  for (const property of ["padding", "border", "background", "color", "font-size", "cursor"]) {
    assert.equal(actual[property], expected[property], `titles-back-action.${property}`);
  }
});

test("title preview toolbar copies search results typography and spacing", () => {
  const expected = declarations(readPanelCss(), ".search-list-heading");
  const actual = declarations(production, ".titles-preview-toolbar");
  for (const property of ["min-width", "min-height", "display", "flex-wrap", "align-items", "justify-content", "gap", "color", "font-size", "font-weight"]) {
    assert.equal(actual[property], expected[property], `titles-preview-toolbar.${property}`);
  }
  const heading = declarations(production, ".titles-preview-toolbar__start > h3");
  for (const property of ["color", "font-size", "font-weight"]) assert.equal(heading[property], "inherit");
  assert.equal(heading.margin, "0");
  assert.equal(declarations(production, ".titles-preview-toolbar__start").gap, expected.gap);
});

test("title refresh copies the small search refresh control instead of a primary button", () => {
  const search = readPanelCss();
  for (const [source, target, properties] of [
    [".search-directory-refresh", ".titles-icon-action.is-refresh", ["height", "flex", "display", "align-items", "gap", "padding", "border", "border-radius", "background", "color", "font", "font-size", "white-space", "cursor"]],
    [".search-directory-refresh svg", ".titles-icon-action.is-refresh svg", ["width", "height", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"]],
    [".search-directory-refresh:focus-visible", ".titles-icon-action.is-refresh:focus-visible", ["outline", "outline-offset"]],
  ]) {
    const expected = declarations(search, source);
    const actual = declarations(production, target);
    for (const property of properties) assert.equal(actual[property], expected[property], `${target}.${property}`);
  }
});

test("title toolbar keeps right-side actions readable on narrow panels and keyboard accessible", () => {
  assert.equal(declarations(production, ".titles-preview-toolbar")["flex-wrap"], "wrap");
  assert.equal(declarations(production, ".titles-preview-toolbar__end")["margin-left"], "auto");
  assert.equal(declarations(production, ".titles-preview-toolbar button")["white-space"], "nowrap");
  assert.equal(declarations(production, ".titles-preview-toolbar button")["flex-shrink"], "0");
  assert.equal(declarations(production, ".titles-preview-toolbar .titles-icon-action")["min-height"], "25px");
  assert.match(production, /\.titles-preview-toolbar button:focus-visible\s*\{[^}]*outline: 2px solid var\(--accent-ring\)/);
  assert.match(production, /:root\[data-native-color-scheme="dark"\] \.titles-back-action\s*\{ color: var\(--danger\); \}/);
  assert.doesNotMatch(production, /\.titles-section-heading|\.titles-action-bar__start/);
});
