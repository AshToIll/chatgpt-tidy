"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const test = require("node:test");
const { checkArchitecture, javascriptReferences, markupReferences, mainAssemblyMetadata, classicGlobalReferences, FEATURES } = require("../tools/check-architecture.cjs");

const projectRoot = path.resolve(__dirname, "..");
const digest = text => crypto.createHash("sha256").update(text).digest("hex");
const errorCodes = result => result.errors.map(error => error.code);

// 每个反例只在独立系统临时目录内构造，绝不修改真实项目、旧源目录或用户文件。
function fixture(run) {
  const temporaryBase = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryBase, "tidy-architecture-check-"));
  const write = (relative, value) => {
    const target = path.resolve(root, relative);
    assert.ok(target.startsWith(root + path.sep), "Fixture writes must stay inside their own root");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value, "utf8");
  };
  try {
    write("docs/current/MIGRATION_MAP.json", JSON.stringify({ files: { "src/sidepanel/panel.js": "src/app/sidepanel/panel.js" } }));
    write("docs/current/BEHAVIOR_BASELINE.json", JSON.stringify({ assetHashes: { "src/assets/sample.txt": digest("unchanged asset") } }));
    write("src/assets/sample.txt", "unchanged asset");
    for (const [feature, view] of Object.entries(FEATURES)) {
      write("src/features/" + feature + "/ui/" + view, "export const view = true;\n");
      write("src/features/" + feature + "/ui/" + feature + ".css", ".fixture-" + feature + " { color: inherit; }\n");
    }
    write("src/platform/shared.js", "export const shared = true;\n");
    write("src/platform/lazy.js", "export const lazy = true;\n");
    write("src/platform/worker.js", "self.onmessage = () => {};\n");
    write("src/features/search/model/contract.js", "export const contract = true;\n");
    write("src/app/sidepanel/panel.js", [
      'import "../../features/time/ui/time-view.js";',
      'export { shared } from "../../platform/shared.js";',
      'import("../../platform/lazy.js");',
      'importScripts("../../platform/shared.js", "../../platform/lazy.js");',
      'chrome.runtime.getURL("assets/sample.txt");',
      'runtime.getURL("/");',
      'new Worker("../../platform/worker.js");',
      'new URL("../../platform/worker.js", import.meta.url);',
      'const ordinaryText = ".";'
    ].join("\n"));
    write("src/app/sidepanel/panel.css", '@import url("../../features/time/ui/time.css");\n');
    write("src/app/sidepanel/index.html", '<link href="panel.css"><script type="module" src="panel.js"></script><a href="#local">Local</a><a href="https://example.test/">External</a>');
    write("src/manifest.json", JSON.stringify({ background: { service_worker: "app/sidepanel/panel.js" }, side_panel: { default_path: "app/sidepanel/index.html" } }));
    return run({ root, write });
  } finally {
    // Windows 递归清理前核对真实绝对路径、父目录和专属前缀，不能删除任意计算路径。
    const resolved = fs.realpathSync(root);
    assert.equal(resolved, path.resolve(root));
    assert.equal(path.dirname(resolved), temporaryBase);
    assert.ok(path.basename(resolved).startsWith("tidy-architecture-check-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

test("real standalone architecture closes references and preserves all 443 asset/vendor files", () => {
  const result = checkArchitecture(projectRoot);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.stats.features, 7);
  assert.equal(result.stats.assetFiles, 443);
  assert.ok(result.stats.migratedFiles >= 100);
  assert.ok(result.stats.checkedReferences >= 200);
});

test("a valid new architecture tree runs independently without a source checkout or .tmp", () => fixture(({ root }) => {
  const result = checkArchitecture(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.stats.assetFiles, 1);
  assert.ok(result.stats.checkedReferences >= 13);
  assert.ok(!fs.existsSync(path.join(root, ".tmp")), "Checker must not create temporary state");
}));

test("a real retired compatibility alias is rejected even when its target is valid", () => fixture(({ root, write }) => {
  write("src/sidepanel/panel.js", 'export * from "../app/sidepanel/panel.js";');
  assert.ok(errorCodes(checkArchitecture(root)).includes("retired-path-exists"));
}));

test("missing migration targets and primary feature owners cannot silently disappear", () => fixture(({ root, write }) => {
  const map = { files: { "src/sidepanel/missing.js": "src/app/sidepanel/missing.js" } };
  write("docs/current/MIGRATION_MAP.json", JSON.stringify(map));
  fs.unlinkSync(path.join(root, "src/features/time/ui/time-view.js"));
  fs.unlinkSync(path.join(root, "src/features/settings/ui/settings.css"));
  const codes = errorCodes(checkArchitecture(root));
  assert.ok(codes.includes("missing-migration-target"));
  assert.ok(codes.includes("missing-feature-view"));
  assert.ok(codes.includes("missing-feature-style"));
}));

test("a broken static reference reports source line, literal and resolved target", () => fixture(({ root, write }) => {
  write("src/features/time/ui/time-view.js", 'export const view = true;\nimport "./missing.js";\n');
  const issue = checkArchitecture(root).errors.find(error => error.code === "missing-reference");
  assert.equal(issue.source, "src/features/time/ui/time-view.js");
  assert.equal(issue.line, 2);
  assert.equal(issue.reference, "./missing.js");
  assert.equal(issue.target, "src/features/time/ui/missing.js");
}));

test("feature imports cannot reach app or another feature UI", () => fixture(({ root, write }) => {
  write("src/features/time/ui/time-view.js", [
    'import "../../../app/sidepanel/panel.js";',
    'import "../../search/ui/search-view.js";',
    'import "../../search/model/contract.js";'
  ].join("\n"));
  const result = checkArchitecture(root);
  assert.deepEqual(errorCodes(result).sort(), ["feature-imports-app", "feature-imports-other-ui", "static-esm-cycle"]);
}));

test("cross-feature model contracts remain permitted instead of forbidding local development", () => fixture(({ root, write }) => {
  write("src/features/time/ui/time-view.js", 'import "../../search/model/contract.js";\n');
  assert.deepEqual(checkArchitecture(root).errors, []);
}));

test("asset changes and unregistered additions are rejected", () => fixture(({ root, write }) => {
  write("src/assets/sample.txt", "changed asset");
  write("src/vendor/extra.js", "unexpected");
  const codes = errorCodes(checkArchitecture(root));
  assert.ok(codes.includes("changed-baseline-asset"));
  assert.ok(codes.includes("unexpected-asset"));
}));

test("dynamic expressions are reported, while comments regexes and ordinary text are not paths", () => {
  const source = [
    'const ordinary = ".";',
    'const prose = "import \\"./missing.js\\"";',
    '// import "./comment.js";',
    '/* importScripts("./comment-worker.js"); */',
    'const pattern = /importScripts\\("regex.js"\\)/g;',
    'chrome.runtime.getURL("./" + file);',
    'import(\x60./\x24{name}.js\x60);',
    'root.importScripts("../../../vendor/" + library.file);',
    'const html = \x60<script src="text.js">\x24{flag ? \x60nested \x24{name}\x60 : ""}</script>\x60;',
    'import "./real.js";'
  ].join("\n");
  const result = javascriptReferences(source);
  assert.deepEqual(result.references.map(reference => reference.value), ["./real.js"]);
  assert.equal(result.dynamic.length, 3);
});

test("HTML data attributes and inline script text are not asset references", () => {
  const result = markupReferences('<div data-src="ignore.js"></div><script>const s = \'<img src="ignore-too.png">\';</script><script src="real.js"></script>', "html");
  assert.deepEqual(result.references.map(reference => reference.value), ["real.js"]);
});

test("CSS text content is not mistaken for url syntax and imports are not duplicated", () => {
  const result = markupReferences('@import url("./real.css");\n.note::after { content: "url(ordinary-text)"; background: url("./image.png"); }\n/* url("comment.png") */', "css");
  assert.deepEqual(result.references.map(reference => reference.value), ["./real.css", "./image.png"]);
});

test("local static imports cannot escape the packaged source tree", () => fixture(({ root, write }) => {
  write("src/features/time/ui/time-view.js", 'import "../../../../outside.js";');
  assert.ok(errorCodes(checkArchitecture(root)).includes("reference-outside-src"));
}));


test("platform dependencies cannot invert ownership into an application root", () => fixture(({ root, write }) => {
  write("src/platform/shared.js", 'export { shell } from "../app/sidepanel/other.js";');
  write("src/app/sidepanel/other.js", 'export const shell = true;');
  const result = checkArchitecture(root);
  assert.deepEqual(errorCodes(result), ["platform-imports-app"]);
  assert.equal(result.errors[0].target, "src/app/sidepanel/other.js");
}));

test("static ESM cycles include re-exports and self-imports but not lazy return edges", () => fixture(({ root, write }) => {
  write("src/platform/shared.js", 'export { lazy } from "./lazy.js";');
  write("src/platform/lazy.js", 'import "./shared.js"; export const lazy = true;');
  write("src/platform/self.js", 'import "./self.js";');
  const cycles = checkArchitecture(root).errors.filter(issue => issue.code === "static-esm-cycle");
  assert.deepEqual(cycles.map(issue => issue.modules), [["src/platform/lazy.js", "src/platform/shared.js"], ["src/platform/self.js"]]);
  write("src/platform/lazy.js", 'export const lazy = () => import("./shared.js");');
  write("src/platform/self.js", 'export const self = true;');
  assert.deepEqual(checkArchitecture(root).errors, []);
}));

test("cycle scans ignore prose, regular expressions and comments that resemble imports", () => fixture(({ root, write }) => {
  write("src/platform/shared.js", 'const prose = "import \\"./lazy.js\\""; /* import "./lazy.js"; */ export const shared = true;');
  write("src/platform/lazy.js", 'export { shared } from "./shared.js";');
  assert.deepEqual(checkArchitecture(root).errors, []);
  assert.ok(checkArchitecture(root).scope.some(item => item.includes("Classic global assembly")));
}));


function mainFixture(write, files, dependencies = {}) {
  write("tools/build-main-world.cjs", "const sourceFiles = " + JSON.stringify(files) + ";\nconst sourceDependencies = Object.freeze(" + JSON.stringify(dependencies) + ");\n");
  write("src/platform/main-provider.js", '(function(global) { global.TidyFixtureProvider = Object.freeze({}); })(globalThis);');
  write("src/platform/main-consumer.js", '(function(global) { const provider = global.TidyFixtureProvider; global.TidyFixtureConsumer = Object.freeze({ provider }); })(globalThis);');
  write("src/app/page/main-world.js", 'const fixture = globalThis.TidyFixtureConsumer;');
}

const MAIN_FIXTURE_INPUTS = ["src/platform/main-provider.js", "src/platform/main-consumer.js", "src/app/page/main-world.js"];

test("MAIN input order checks both direct classic globals and explicit injected dependencies", () => fixture(({ root, write }) => {
  mainFixture(write, MAIN_FIXTURE_INPUTS, { "src/app/page/main-world.js": ["src/platform/main-consumer.js"] });
  const valid = checkArchitecture(root);
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.stats.mainInputs, 3);
  mainFixture(write, [MAIN_FIXTURE_INPUTS[1], MAIN_FIXTURE_INPUTS[0], MAIN_FIXTURE_INPUTS[2]]);
  assert.ok(errorCodes(checkArchitecture(root)).includes("main-dependency-order"));
  mainFixture(write, MAIN_FIXTURE_INPUTS, { "src/platform/main-provider.js": ["src/platform/main-consumer.js"] });
  assert.ok(errorCodes(checkArchitecture(root)).includes("main-dependency-order"));
}));

test("MAIN missing duplicate escaped and reversed composition inputs cannot pass assembly checks", () => fixture(({ root, write }) => {
  mainFixture(write, [...MAIN_FIXTURE_INPUTS, MAIN_FIXTURE_INPUTS[0]]);
  let codes = errorCodes(checkArchitecture(root));
  assert.ok(codes.includes("duplicate-main-input"));
  assert.ok(codes.includes("main-entry-order"));
  mainFixture(write, ["src/../outside.js", "src/platform/missing.js", MAIN_FIXTURE_INPUTS[2]], { [MAIN_FIXTURE_INPUTS[2]]: [MAIN_FIXTURE_INPUTS[0]] });
  codes = errorCodes(checkArchitecture(root));
  assert.ok(codes.includes("invalid-main-input"));
  assert.ok(codes.includes("missing-main-input"));
  assert.ok(codes.includes("missing-main-dependency"));
}));

test("MAIN metadata is parsed as literals without executing build tools or business strings", () => {
  const metadata = mainAssemblyMetadata('const note = "const sourceFiles = [bad]"; const sourceFiles = ["src/one.js"]; const sourceDependencies = Object.freeze({ "src/two.js": ["src/one.js"] }); throw new Error("must not execute");');
  assert.deepEqual(metadata.sourceFiles, ["src/one.js"]);
  assert.deepEqual([...metadata.sourceDependencies["src/two.js"]], ["src/one.js"]);
  assert.throws(() => mainAssemblyMetadata('const sourceFiles = compute(); const sourceDependencies = {};'), /literal/);
  assert.throws(() => mainAssemblyMetadata('const sourceFiles = ["src/one.js"] + stolen; const sourceDependencies = {};'), /Expected/);
  const globals = classicGlobalReferences('const note = "global.TidyFake = value"; /* root.TidyComment; */ global.TidyReal = {}; const value = globalThis.TidyNeeded;');
  assert.deepEqual(globals, { provided: ["TidyReal"], used: ["TidyNeeded"] });
});
