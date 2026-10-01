const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const JSZip = require("../src/vendor/jszip-3.10.1.min.js");
const { SOURCE_TOOL_FILES, assertReleasePath, assertSourcePath, listSourceFiles, listSourceBundleFiles, readInputFile, validateManifest, createArchive, verifyArchive } = require("../tools/package-extension.cjs");

const READMES = ["README.md", "README.en.md", "README.ja.md"];

const CANONICAL_DOC_FILES = [
  "docs/README.md",
  "docs/current/ARCHITECTURE.md",
  "docs/current/BASELINE_VALIDATION.md",
  "docs/current/BEHAVIOR_BASELINE.json",
  "docs/current/DEVELOPMENT.md",
  "docs/current/DEVELOPMENT_DEPENDENCIES.json",
  "docs/current/FEATURE_CONTRACTS.md",
  "docs/current/FILE_GUIDE.md",
  "docs/current/MESSAGE_INDEX.json",
  "docs/current/MESSAGE_INDEX.md",
  "docs/current/MIGRATION_MAP.json",
  "docs/current/REFACTOR_PLAN.md",
  "docs/current/RELEASE_CHECKLIST.md",
  "docs/current/STORAGE.md",
  "docs/current/VALIDATION.md",
  "docs/licenses/fake-indexeddb-6.2.5-LICENSE.txt",
];

const testSandboxes = new Set();

// These fixtures contain only synthetic data, unlike retained browser receipts.
// Reclaim this process's exact directories after the tests, including failures;
// never sweep .tmp or remove another run's files. Node removes junctions as links.
test.after(() => {
  for (const sandbox of testSandboxes) {
    const temporaryRoot = fs.realpathSync(path.resolve(__dirname, "../.tmp"));
    const resolved = fs.realpathSync(sandbox);
    if (path.dirname(resolved) !== temporaryRoot || !/^package-boundary-[A-Za-z0-9]{6}$/.test(path.basename(resolved))) {
      throw new Error("Refusing to clean a fixture outside the test-output root");
    }
    fs.rmSync(resolved, { recursive: true });
  }
});

function syntheticProject(linkedDirectory = null) {
  const temporaryRoot = path.resolve(__dirname, "../.tmp");
  if (fs.existsSync(temporaryRoot) && fs.lstatSync(temporaryRoot).isSymbolicLink()) throw new Error("Refusing a linked test-output root");
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const sandbox = fs.mkdtempSync(path.join(temporaryRoot, "package-boundary-"));
  testSandboxes.add(sandbox);
  const root = path.join(sandbox, "project");
  const syntheticTarget = path.join(sandbox, "synthetic-link-target");
  fs.mkdirSync(root);
  fs.mkdirSync(syntheticTarget);
  for (const name of ["src", "tests", "tools", ".githooks", "docs", "docs/current", "docs/licenses"]) {
    if (name === linkedDirectory) {
      // Junctions exercise real directory-link rejection on Windows without
      // requiring symlink privileges. Both ends remain inside this new fixture.
      fs.symlinkSync(syntheticTarget, path.join(root, name), process.platform === "win32" ? "junction" : "dir");
    } else if (!linkedDirectory || !name.startsWith(linkedDirectory + "/")) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
    }
  }
  for (const name of ["src/manifest.json", "tests/synthetic.test.cjs", ...SOURCE_TOOL_FILES.map(name => `tools/${name}`),
    ...READMES, "LICENSE", "package.json", "package-lock.json", ".gitignore", ".gitattributes", ".githooks/pre-commit",
    ...CANONICAL_DOC_FILES]) {
    if (!linkedDirectory || !name.startsWith(linkedDirectory + "/")) fs.writeFileSync(path.join(root, name), "synthetic fixture\n");
  }
  return root;
}

test("release membership includes all manifest resources but no repository diagnostics", () => {
  const files = listSourceFiles();
  validateManifest(JSON.parse(fs.readFileSync("src/manifest.json", "utf8")), files);
  assert.ok(files.includes("features/titles/ui/title-catalog.js"));
  assert.ok(files.includes("platform/catalog/storage/conversation-catalog.js"));
  assert.ok(files.includes("platform/navigation/background/worker-navigation.js"));
  assert.ok(files.includes("platform/library/background/library-identity.js"));
  assert.ok(files.includes("features/search/ui/search-calendar.js"));
  assert.ok(files.includes("features/export/ui/export-basket.js"));
  for (const name of ['features/settings/ui/library-backup-view.js', 'features/settings/model/library-backup-format.js',
    'features/settings/storage/library-backup.js', 'features/settings/storage/library-backup-domain.js', 'features/settings/background/library-backup-service.js']) assert.ok(files.includes(name), name);
  assert.ok(files.every((name) => !/\.har$|^docs\/|^tests\/|^src\//.test(name)));
  for (const name of READMES) assert.ok(!files.includes(name), name);
});

test("release paths fail closed for traversal, private files, hidden folders and unsupported artifacts", () => {
  for (const name of ["../private.json", "/private.json", "C:/private.json", "dir\\file.js", ".env", ".git/config",
    "tests/fixture.js", "fixtures/data.json", "node_modules/module.js", "capture.har", "src//file.js"]) {
    assert.throws(() => assertReleasePath(name));
  }
  assert.equal(assertReleasePath("_locales/en/messages.json"), "_locales/en/messages.json");
  assert.equal(assertReleasePath("vendor/licenses/base64-arraybuffer-0.1.5-LICENSE-MIT"), "vendor/licenses/base64-arraybuffer-0.1.5-LICENSE-MIT");
});

test("release archives have deterministic bytes, exact members and readback-verified content", async () => {
  const entries = [{ name: "manifest.json", bytes: Buffer.from('{"version":"0.4.0"}') },
    { name: "LICENSE.txt", bytes: Buffer.from("Synthetic license for archive test") }];
  const first = await createArchive(entries), second = await createArchive(entries);
  assert.deepEqual(first, second);
  await verifyArchive(first, entries);
  await assert.rejects(verifyArchive(first, [{ ...entries[0], bytes: Buffer.from("changed") }, entries[1]]), /content mismatch/);
  await assert.rejects(createArchive([entries[0], entries[0]]), /Duplicate/);
});

test("source archive preserves executable hooks and rejects changed file permissions", async () => {
  const entries = [{ name: ".githooks/pre-commit", bytes: fs.readFileSync(".githooks/pre-commit") },
    { name: "package.json", bytes: fs.readFileSync("package.json") }];
  const bytes = await createArchive(entries, { source: true });
  const archive = await JSZip.loadAsync(bytes);
  assert.equal(archive.file(".githooks/pre-commit").unixPermissions, 0o100755);
  assert.equal(archive.file("package.json").unixPermissions, 0o100644);
  await verifyArchive(bytes, entries);
  archive.file(".githooks/pre-commit").unixPermissions = 0o100644;
  const changed = await archive.generateAsync({ type: "nodebuffer", platform: "UNIX" });
  await assert.rejects(verifyArchive(changed, entries), /permissions mismatch: \.githooks\/pre-commit/);
});

test("source hook setup targets only the local repository and canonical verifier", () => {
  const setup = JSON.parse(fs.readFileSync("package.json", "utf8")).scripts["setup:hooks"];
  assert.equal(setup, "git config --local core.hooksPath .githooks");
  assert.equal(fs.readFileSync(".githooks/pre-commit", "utf8"), "#!/bin/sh\nexec node tools/verify.cjs\n");
});

// 公开仓库在 Windows 也固定 LF；第三方字节校验输入继续保持原样。
test("source checkouts use LF text without rewriting third-party byte inputs", () => {
  const attributes = fs.readFileSync(".gitattributes", "utf8").split(/\r?\n/);
  assert.ok(attributes.includes("* text=auto eol=lf"));
  for (const rule of ["src/assets/** -text", "src/vendor/*.js -text", "src/vendor/REGENERATOR-RUNTIME-LICENSE.txt -text -whitespace",
    "src/vendor/licenses/* -text -whitespace", "src/assets/fonts/OFL-*.txt -text -whitespace",
    "src/assets/fonts/licenses/* -text -whitespace", "docs/licenses/* -text -whitespace"]) {
    assert.ok(attributes.includes(rule), rule);
  }
});

test("source metadata and locked development runtime match the extension release", () => {
  const metadata = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  const manifest = JSON.parse(fs.readFileSync("src/manifest.json", "utf8"));
  assert.equal(metadata.version, manifest.version);
  assert.equal(lock.version, metadata.version);
  assert.equal(lock.packages[""].version, metadata.version);
  assert.equal(metadata.engines.node, ">=24");
  assert.equal(lock.packages[""].engines.node, metadata.engines.node);
});

test("source candidates include verification and canonical docs without history or diagnostic artifacts", () => {
  const files = listSourceBundleFiles();
  for (const name of [...READMES, "src/manifest.json", "tools/build-main-world.cjs", "tools/build-icons.cjs", "tools/package-extension.cjs",
    "tools/build-messages.cjs", "tools/build-message-index.cjs", "tools/check-architecture.cjs",
    "tools/clean-verification.cjs", "tools/check-seven-columns-browser.cjs", "tests/browser/diagnostics-smoke-fragment.js",
    "tools/check-bookmark-landing-browser.cjs", "tools/verify-release.cjs", "tests/browser/bookmark-landing.html", "tests/browser/bookmark-landing.mjs",
    "tools/browser-fixture.cjs", "tools/check-export-images-browser.cjs", "tools/check-export-jobs-browser.cjs", "tools/check-panel-theme-browser.cjs", "tools/check-bookmark-theme-browser.cjs",
    "tools/check-export-keyboard-browser.cjs", "tests/browser/export-keyboard.html", "tests/browser/export-keyboard.mjs",
    "tests/catalog-version-validation.test.cjs", "tests/browser/native-sidebar-fixture.mjs",
    "tests/browser/native-sidebar-navigation.mjs", "tests/browser/sidebar-navigation.mjs",
    "tests/fixtures/approved-ui-baseline.css", "package-lock.json", "LICENSE", "tools/verify.cjs", ".githooks/pre-commit", ".gitattributes",
    "docs/README.md", "docs/current/ARCHITECTURE.md", "docs/current/STORAGE.md",
    "docs/current/DEVELOPMENT.md", "docs/current/RELEASE_CHECKLIST.md", "docs/current/DEVELOPMENT_DEPENDENCIES.json",
    "docs/licenses/fake-indexeddb-6.2.5-LICENSE.txt", "tools/check-third-party.cjs", "tools/check-library-backup-browser.cjs",
    "tests/browser/library-backup.html", "tests/browser/library-backup.mjs", "tests/library-backup.test.cjs"]) assert.ok(files.includes(name), name);
  assert.ok(files.every((name) => !/^(?:\.git|\.tmp|\.artifacts|tmp|node_modules|\.workbuddy)\//.test(name) && !/\.(?:har|pdf|zip|fig|pyc)$/.test(name)));
  assert.deepEqual(files.filter(name => name.startsWith("docs/")), CANONICAL_DOC_FILES);
  for (const name of ["README.private.md", "README.backup.md", ".git/config", ".artifacts/verification/report.json", ".workbuddy/memory.md", ".githooks/other-hook", "docs/private.md", "docs/private.mjs",
    "docs/archive/README.md", "docs/current/AUDIT.md", "docs/design-preview/README.md", "docs/design-preview/THIRD_PARTY_LICENSES.md",
    "docs/design-preview/vendor/font.ttf", "tests/../private.mjs", "tools/capture.har", "tools/private.pdf"]) {
    assert.throws(() => assertSourcePath(name));
  }
  assert.equal(assertSourcePath(".gitignore"), ".gitignore");
});

test("missing required source tools fail instead of creating an incomplete archive", () => {
  const root = syntheticProject();
  for (const name of ["build-main-world.cjs", "build-icons.cjs", "verify.cjs", "browser-fixture.cjs"]) {
    const target = path.join(root, "tools", name);
    fs.unlinkSync(target);
    assert.throws(() => listSourceBundleFiles(root), error => error.code === "ENOENT" && error.path === target);
    fs.writeFileSync(target, "synthetic fixture\n");
  }
});

test("all README translations are required and retain their exact text in source archives", async () => {
  const root = syntheticProject();
  for (const name of READMES) {
    const target = path.join(root, name);
    fs.unlinkSync(target);
    assert.throws(() => listSourceBundleFiles(root), error => error.code === "ENOENT" && error.path === target);
    fs.writeFileSync(target, "synthetic fixture\n");
  }
  const entries = READMES.map(name => ({ name, bytes: fs.readFileSync(name) }));
  await verifyArchive(await createArchive(entries, { source: true }), entries);
});

test("source archives preserve browser ES modules without broadening installable runtime inputs", async () => {
  const entries = [{ name: "tests/browser/synthetic-fixture.mjs", bytes: Buffer.from('export const fixture = "synthetic";\n') },
    { name: "tests/browser/synthetic-fixture.html", bytes: Buffer.from('<script type="module" src="./synthetic-fixture.mjs"></script>\n') }];
  assert.equal(assertSourcePath(entries[0].name), entries[0].name);
  const first = await createArchive(entries, { source: true });
  const second = await createArchive(entries, { source: true });
  assert.deepEqual(first, second);
  await verifyArchive(first, entries);
  await assert.rejects(createArchive(entries), /Unsafe release input/);
});

test("package traversal rejects linked source, test and tool roots before following them", () => {
  for (const directory of ["src", "tests", "tools", ".githooks", "docs", "docs/current"]) {
    const root = syntheticProject(directory);
    assert.throws(() => listSourceBundleFiles(root), /Symlink is not a package input/, directory);
    if (directory === "src") assert.throws(() => listSourceFiles(root), /Symlink is not a package input/);
  }
});

test("clean source packaging needs neither personal design drafts nor unused tool fixtures", () => {
  const root = syntheticProject();
  assert.equal(fs.existsSync(path.join(root, "tools/fixtures")), false);
  assert.equal(fs.existsSync(path.join(root, "docs/design-preview")), false);
  const files = listSourceBundleFiles(root);
  assert.ok(files.includes("tests/synthetic.test.cjs"));
  assert.ok(files.includes("docs/current/DEVELOPMENT.md"));
  assert.ok(files.every(name => !name.startsWith("tools/fixtures/")));
  assert.ok(files.every(name => !name.startsWith("docs/design-preview/")));
  // 即使作者电脑上存在草稿（含指向本夹具的目录链接），打包也不访问它。
  fs.symlinkSync(path.dirname(root), path.join(root, "docs/design-preview"), process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(listSourceBundleFiles(root), files);
});

test("root-file link checks cover both membership and the final byte-read boundary", (t) => {
  const root = syntheticProject();
  const lstatSync = fs.lstatSync;
  let linkedName = "";
  // Windows file symlinks require privileges that an ordinary test runner may
  // not have. Inject only their lstat result; real directory links are tested
  // above, and these ordinary fixture files contain no outside/private data.
  t.mock.method(fs, "lstatSync", (target, ...options) => path.resolve(target) === path.join(root, linkedName)
    ? { isSymbolicLink: () => true }
    : lstatSync(target, ...options));
  for (const name of [...READMES, "LICENSE", "package.json", "package-lock.json", ".gitignore"]) {
    linkedName = name;
    assert.throws(() => listSourceBundleFiles(root), /Symlink is not a package input/, name);
    assert.throws(() => readInputFile(root, name), /Symlink is not a package input/, name);
  }
});
