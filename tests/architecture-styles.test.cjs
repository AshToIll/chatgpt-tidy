const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const sourceRoot = path.join(root, "src");
const entry = path.join(sourceRoot, "app/sidepanel/panel.css");
const baseline = JSON.parse(fs.readFileSync(path.join(root, "docs/current/BEHAVIOR_BASELINE.json"), "utf8"));
const digest = text => crypto.createHash("sha256").update(text).digest("hex");
const libraryAmendments = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/library-style-amendments.json"), "utf8"));

// 仅去掉本次拆分新增的说明，不移除旧注释、不排序规则、不折叠选择器或属性。
// 这样值、顺序、空格甚至旧注释意外变化都会令基线哈希失败。
function stripBoundaryNotes(css) {
  return css.replace(/\/\* architecture-boundary:[\s\S]*?\*\/\n/g, "");
}

// 明确记录本轮批准的局部差异，逆向恢复后继续校验不可变历史基线。
// 每个替换都带相邻原规则作锚点；不要整文件忽略，也不要放宽成选择器正则。
function restoreLibraryAmendments(relative, css) {
  const addition = libraryAmendments.additions.find(item => item.file === relative);
  if (addition) {
    assert.equal(digest(css), addition.sha256, "Shared library styles changed without an explicit reviewed amendment: " + relative);
    return "";
  }
  for (const amendment of libraryAmendments.changes.filter(item => item.file === relative)) {
    assert.ok(amendment.before && amendment.after, "Use a nonempty exact context for every style amendment");
    assert.equal(css.split(amendment.after).length, 2, "Approved CSS chunk must occur exactly once: " + amendment.id);
    css = css.replace(amendment.after, () => amendment.before);
  }
  return css;
}

function expandStylesheet(file, visited = new Set(), restoreLibrary = false) {
  const resolved = path.resolve(file);
  assert.ok(resolved.startsWith(sourceRoot + path.sep), "Stylesheet must remain inside src");
  assert.ok(!visited.has(resolved), "Each stylesheet must be imported once without cycles: " + resolved);
  visited.add(resolved);
  const rawCss = fs.readFileSync(resolved, "utf8").replace(/\r\n/g, "\n");
  const relativePath = path.relative(sourceRoot, resolved).split(path.sep).join("/");
  const css = stripBoundaryNotes(restoreLibrary ? restoreLibraryAmendments(relativePath, rawCss) : rawCss);
  return css.replace(/^@import "([^"]+)";\n/gm, (_, relative) =>
    expandStylesheet(path.resolve(path.dirname(resolved), relative), visited, restoreLibrary));
}

test("sidepanel stylesheet remains a local import-only composition root", () => {
  const css = stripBoundaryNotes(fs.readFileSync(entry, "utf8").replace(/\r\n/g, "\n"));
  const imports = [...css.matchAll(/^@import "([^"]+)";\n/gm)];
  assert.ok(imports.length >= 7, "All feature and common ownership files must be assembled");
  assert.equal(css.replace(/^@import "([^"]+)";\n/gm, ""), "", "Do not hide feature rules in the composition root");
  for (const [, relative] of imports) {
    assert.ok(relative.startsWith("../../"), "Only package-local CSS imports are allowed");
    assert.ok(fs.existsSync(path.resolve(path.dirname(entry), relative)), "Missing stylesheet: " + relative);
  }
});

// User-approved secondary-control variant is additive; keep every original rule frozen.
const compactToggleRules = [
  '/* 小号用于编号等次级开关：只缩小视觉，34×28 点击区仍易操作；右沿与设置选项对齐。 */',
  '.toggle-control--compact { width: 34px; height: 28px; align-items: center; justify-content: flex-end; }',
  '.toggle-control--compact .toggle-track { width: 28px; height: 16px; border-radius: 8px; }',
  '.toggle-control--compact .toggle-track::after { width: 12px; height: 12px; }',
  '.toggle-control--compact input:checked + .toggle-track::after { transform: translateX(12px); }',
].join('\n') + '\n';

test("compact toggle is an explicit additive variant and preserves the original cascade", () => {
  const css = expandStylesheet(entry);
  assert.equal(css.split(compactToggleRules).length, 2, 'one explicit, isolated compact variant');
  const originalCss = css.replace(compactToggleRules, '');
  assert.doesNotMatch(originalCss, /toggle-control--compact/, 'no unrelated compact overrides');
});

// Empty group names now have one input-associated line; authorize only this local delta.
const groupCreateOriginal = '.favorite-group-create { display: flex; gap: 4px; margin-top: 5px; }';
const groupCreateValidated = '.favorite-group-create { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }';
const groupNameFeedbackRules = [
  '/* 字段错误只在需要时占一行，和输入框对齐；不是常驻诊断卡片。 */',
  '.favorite-group-name-error { flex: 0 0 100%; grid-column: 2 / -1; color: var(--danger); font-size: 11px; line-height: 1.4; }',
  '.favorite-group-create input[aria-invalid="true"], .favorite-group-edit input[aria-invalid="true"] { border-color: var(--danger); }',
].join('\n') + '\n';

test("the earlier group-name validation delta remains exact when the shared-library migration is reversed", () => {
  const css = expandStylesheet(entry, new Set(), true);
  assert.equal(css.split(groupCreateValidated).length, 2);
  assert.equal(css.split(groupNameFeedbackRules).length, 2);
  assert.doesNotMatch(css.replace(groupNameFeedbackRules, ''), /favorite-group-name-error|aria-invalid/);
});

test("expanded sidepanel CSS preserves the 0.4.0 baseline apart from explicitly approved UI amendments", () => {
  const css = expandStylesheet(entry, new Set(), true).replace(compactToggleRules, '')
    .replace(groupCreateValidated, groupCreateOriginal).replace(groupNameFeedbackRules, '');
  assert.doesNotMatch(css, /@import\b|@layer\b/, "All imports expand and no new cascade layer is introduced");
  assert.equal(digest(css), baseline.cssSha256,
    "Architecture-only migration must not change selectors, values or their order");
  // 本地迁移现场有原文件时再逐字对照；源码发布包不依赖 .tmp。
  const original = path.join(root, ".tmp/architecture-baseline/panel.original.css");
  if (fs.existsSync(original)) {
    assert.equal(css, fs.readFileSync(original, "utf8").replace(/\r\n/g, "\n"));
  }
});

test("shared library UI styles have an exact scoped approval and are loaded after existing feature styles", () => {
  assert.equal(libraryAmendments.schemaVersion, 1);
  assert.deepEqual(libraryAmendments.additions.map(item => item.file), ["platform/ui/library-interactions.css"]);
  const permittedOwners = new Set(["features/favorites/ui/favorites.css", "features/bookmarks/ui/bookmarks.css", "platform/ui/dark-mode-overrides.css"]);
  assert.equal(new Set(libraryAmendments.changes.map(item => item.id)).size, libraryAmendments.changes.length);
  for (const amendment of libraryAmendments.changes) {
    assert.ok(permittedOwners.has(amendment.file), "Do not extend this authorization to unrelated features");
    assert.ok(amendment.reason, "Every local style delta needs its user-visible purpose");
  }
  const imports = [...fs.readFileSync(entry, "utf8").matchAll(/^@import "([^"]+)";\r?$/gm)].map(match => match[1]);
  assert.equal(imports.at(-1), "../../platform/ui/library-interactions.css");
  assert.doesNotMatch(expandStylesheet(entry), /bookmark-entry-move-menu|bookmark-entry-move-heading/,
    "Retired entry-menu aliases must not remain in feature or dark styles");
  const restoredCss = expandStylesheet(entry, new Set(), true);
  assert.doesNotMatch(restoredCss, /\.library-(?:group-name|entry-menu|confirmation)|\.favorite-(?:conversation-row|entry-menu-toggle|entry-overlay)/,
    "Shared UI additions must be isolated in their reviewed local deltas");
});

test("time settings favorites bookmarks and search have explicit stylesheet owners", () => {
  const files = [
    "features/time/ui/time.css",
    "features/settings/ui/settings.css",
    "features/settings/ui/library-backup.css",
    "features/favorites/ui/favorites.css",
    "features/bookmarks/ui/bookmarks.css",
    "features/search/ui/search-controls.css",
    "features/search/ui/search-results.css"
  ];
  const entryCss = fs.readFileSync(entry, "utf8");
  for (const relative of files) {
    assert.ok(fs.existsSync(path.join(sourceRoot, relative)), "Missing feature style owner: " + relative);
    assert.ok(entryCss.includes("../../" + relative), "Feature owner must be loaded: " + relative);
  }
});


test("each imported CSS file contains complete independently parsed rule blocks", () => {
  const entryCss = fs.readFileSync(entry, "utf8");
  for (const [, relative] of entryCss.matchAll(/^@import "([^"]+)";$/gm)) {
    const css = fs.readFileSync(path.resolve(path.dirname(entry), relative), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
    let depth = 0;
    for (const char of css) {
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      assert.ok(depth >= 0, "A stylesheet must not begin inside another file's rule: " + relative);
    }
    assert.equal(depth, 0, "A stylesheet must not end inside an unfinished rule: " + relative);
  }
});
