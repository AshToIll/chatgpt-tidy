const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const JSZip = require("../src/vendor/jszip-3.10.1.min.js");
const { verifyThirdParty } = require("./check-third-party.cjs");

const projectRoot = path.resolve(__dirname, "..");
const fixedDate = new Date("2026-01-01T00:00:00.000Z");
const allowedExtensions = new Set([".js", ".json", ".css", ".html", ".png", ".svg", ".txt", ".md", ".markdown", ".ttf", ".woff", ".woff2"]);
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

// 三语说明只随公开源码收录，保持明确清单，不扫描个人 README 草稿。
const sourceRootFiles = new Set(["README.md", "README.en.md", "README.ja.md", "LICENSE", "package.json", "package-lock.json", ".gitignore", ".gitattributes"]);
// 公开源码只带当前文档与验证入口，不扫整个 docs，更不读取个人设计草稿。
// 第三方运行库与字体许可随 src/ 收集，不依赖草稿目录中的副本。
const sourceSupportFiles = new Set([".githooks/pre-commit", "docs/README.md",
  "docs/current/ARCHITECTURE.md", "docs/current/STORAGE.md", "docs/current/DEVELOPMENT.md", "docs/current/RELEASE_CHECKLIST.md",
  "docs/current/DEVELOPMENT_DEPENDENCIES.json", "docs/licenses/fake-indexeddb-6.2.5-LICENSE.txt",
  // Architecture and copy inventories are part of the maintained public source contract.
  "docs/current/REFACTOR_PLAN.md", "docs/current/MIGRATION_MAP.json", "docs/current/BASELINE_VALIDATION.md",
  "docs/current/BEHAVIOR_BASELINE.json", "docs/current/MESSAGE_INDEX.md", "docs/current/MESSAGE_INDEX.json",
  "docs/current/FILE_GUIDE.md", "docs/current/FEATURE_CONTRACTS.md", "docs/current/VALIDATION.md"]);
const SOURCE_TOOL_FILES = Object.freeze(["clean-verification.cjs", "check-seven-columns-browser.cjs", "build-messages.cjs", "build-message-index.cjs", "check-architecture.cjs", "build-main-world.cjs", "build-icons.cjs", "verify.cjs", "verify-release.cjs", "benchmark-title-backend.cjs", "audit-title-refresh.cjs", "audit-title-har.cjs",
  "package-extension.cjs", "check-sidebar-navigation-browser.cjs", "check-library-lifecycle-browser.cjs", "check-plugin-navigation-browser.cjs", "check-bookmark-landing-browser.cjs",
  // 导出回归及共用浏览器执行器必须一起交付，解压后的源码才能独立运行完整验收。
  "browser-fixture.cjs", "check-export-images-browser.cjs", "check-export-jobs-browser.cjs", "check-export-keyboard-browser.cjs", "check-panel-theme-browser.cjs", "check-bookmark-theme-browser.cjs", "check-toolbar-theme-browser.cjs",
  "date-search-export-preview.cjs", "keyword-search-preview.cjs", "search-status-preview.cjs", "check-third-party.cjs", "check-library-backup-browser.cjs", "check-page-session-browser.cjs"]);

// Checking directory entries alone misses a linked traversal root or LICENSE.
// Verify every selected path component again immediately before reading bytes.
// This is a packaging boundary only; normal development filesystem access is
// unchanged, and the packager never traverses a link to collect extra inputs.
function assertInputPath(root, name, kind) {
  const check = (target, expected, label) => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`Symlink is not a package input: ${label}`);
    if (!(expected === "directory" ? stat.isDirectory() : stat.isFile())) {
      throw new Error(`Expected ${expected} package input: ${label}`);
    }
  };
  check(root, "directory", "project root");
  const parts = name.split("/");
  let target = root;
  for (let index = 0; index < parts.length; index += 1) {
    target = path.join(target, parts[index]);
    check(target, index === parts.length - 1 ? kind : "directory", parts.slice(0, index + 1).join("/"));
  }
  return target;
}

function readInputFile(root, name) {
  assertSourcePath(name);
  return fs.readFileSync(assertInputPath(root, name, "file"));
}

function assertSourcePath(name) {
  if (sourceRootFiles.has(name) || sourceSupportFiles.has(name) || name === "SOURCE-MANIFEST.json") return name;
  if (name.startsWith("src/")) { assertReleasePath(name.slice(4)); return name; }
  if (typeof name !== "string" || name.includes("\\") || name.includes(":") || name.startsWith("/")
    || name.split("/").some((part) => !part || part.startsWith("."))
    // Browser regression fixtures use native ES modules (.mjs). They are
    // public source text, not a reason to include binary QA outputs or docs.
    || !/^(?:tests\/|tools\/)/.test(name) || !/\.(?:cjs|mjs|js|json|css|html|svg)$/.test(name)) {
    throw new Error(`Unsafe source input: ${name}`);
  }
  return name;
}

function listSourceBundleFiles(root = projectRoot) {
  const names = listSourceFiles(root).map((name) => "src/" + name);
  const visit = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Symlink is not a source input: ${name}`);
      if (entry.isDirectory()) visit(path.join(directory, entry.name), name + "/");
      else if (entry.isFile()) names.push(assertSourcePath(name));
    }
  };
  visit(assertInputPath(root, "tests", "directory"), "tests/");
  // 只选择明确列出的工具，但清单中的每一项都必须存在。
  // 先扫目录再取交集会静默漏掉构建/验收工具，产生无法独立开发的源码包。
  assertInputPath(root, "tools", "directory");
  for (const file of SOURCE_TOOL_FILES) {
    const name = "tools/" + file;
    assertInputPath(root, name, "file");
    names.push(name);
  }
  for (const name of sourceRootFiles) assertInputPath(root, name, "file");
  for (const name of sourceSupportFiles) assertInputPath(root, name, "file");
  names.push(...sourceRootFiles, ...sourceSupportFiles);
  return names.sort();
}

function assertReleasePath(name) {
  const licenseText = typeof name === "string" && /^vendor\/licenses\/[a-z0-9._-]*(?:license|notice|copying|copyright)[a-z0-9._-]*$/i.test(name);
  if (typeof name !== "string" || !name || name.includes("\\") || name.startsWith("/") || name.includes(":")
    || name.split("/").some((part) => !part || part.startsWith(".") || ["node_modules", "tests", "fixtures", "tmp"].includes(part))
    || (!allowedExtensions.has(path.posix.extname(name).toLowerCase()) && !licenseText)) {
    throw new Error(`Unsafe release input: ${name}`);
  }
  return name;
}

function listSourceFiles(root = projectRoot) {
  const source = assertInputPath(root, "src", "directory");
  const names = [];
  const visit = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      // A release is an explicit copy of local runtime files, never a traversal
      // through a symlink into private development data outside src.
      if (entry.isSymbolicLink()) throw new Error(`Symlink is not a release input: ${name}`);
      if (entry.isDirectory()) visit(path.join(directory, entry.name), name + "/");
      else if (entry.isFile()) names.push(assertReleasePath(name));
      else throw new Error(`Unsupported release input: ${name}`);
    }
  };
  visit(source);
  return names.sort();
}

function validateManifest(manifest, names) {
  if (manifest.manifest_version !== 3 || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version)) throw new Error("Invalid extension manifest");
  const files = new Set(names);
  const required = ["manifest.json", manifest.background?.service_worker,
    ...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]),
    `_locales/${manifest.default_locale}/messages.json`];
  for (const name of required) if (!files.has(assertReleasePath(name))) throw new Error(`Missing manifest resource: ${name}`);
}

async function createArchive(entries, { source = false } = {}) {
  const archive = new JSZip();
  const names = new Set();
  for (const { name, bytes } of entries) {
    (source ? assertSourcePath : assertReleasePath)(name);
    if (names.has(name)) throw new Error(`Duplicate release input: ${name}`);
    names.add(name);
    // 不继承作者系统的 umask：普通文件固定只读写，唯一 Git hook 明确可执行。
    // 这样源码 ZIP 在 Linux/macOS 解压后，setup:hooks 不会指向被 Git 忽略的脚本。
    const unixPermissions = name === ".githooks/pre-commit" ? 0o100755 : 0o100644;
    archive.file(name, bytes, { date: fixedDate, createFolders: false, unixPermissions });
  }
  return archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "UNIX" });
}

async function verifyArchive(bytes, entries) {
  const archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const names = Object.keys(archive.files).sort();
  if (JSON.stringify(names) !== JSON.stringify(entries.map((entry) => entry.name).sort())) throw new Error("Release archive membership changed");
  for (const entry of entries) {
    const file = archive.file(entry.name);
    const expectedMode = entry.name === ".githooks/pre-commit" ? 0o100755 : 0o100644;
    if (file.unixPermissions !== expectedMode) throw new Error(`Release permissions mismatch: ${entry.name}`);
    const actual = await file.async("nodebuffer");
    if (!actual.equals(Buffer.from(entry.bytes))) throw new Error(`Release content mismatch: ${entry.name}`);
  }
}

async function main() {
  // Packaging never repairs a stale bundle silently. Keep the checked source
  // and the bytes installed by the user tied to the same successful build.
  for (const file of ["build-messages.cjs", "build-message-index.cjs", "build-main-world.cjs"]) {
    // Successful check summaries stay out of the single JSON packaging receipt.
    // Failure diagnostics still reach stderr; a nonzero exit aborts packaging.
    execFileSync(process.execPath, [path.join(__dirname, file), "--check"], { cwd: projectRoot, stdio: ["ignore", "pipe", "inherit"] });
  }
  const thirdParty = verifyThirdParty(projectRoot);
  const names = listSourceFiles();
  const manifest = JSON.parse(readInputFile(projectRoot, "src/manifest.json").toString("utf8"));
  validateManifest(manifest, names);
  const entries = names.map((name) => ({ name, bytes: readInputFile(projectRoot, "src/" + name) }));
  // The repository license is outside src, but it is part of every installable
  // distribution. Do not include the whole repository, HARs, tests or audits.
  entries.push({ name: "LICENSE.txt", bytes: readInputFile(projectRoot, "LICENSE") });
  entries.push({ name: "INSTALL.md", bytes: Buffer.from(`# ChatGPT Tidy ${manifest.version}\n\n`
    + `Chrome / Microsoft Edge ${manifest.minimum_chrome_version} or newer.\n\n`
    + "## 安装\n\n"
    + "1. 解压到固定文件夹。\n"
    + "2. Chrome 打开 chrome://extensions；Edge 打开 edge://extensions。\n"
    + "3. 开启「开发者模式」，点击「加载已解压的扩展程序」，选择含 manifest.json 的文件夹。\n"
    + "4. 刷新 ChatGPT 网页，点击浏览器扩展菜单中的 ChatGPT Tidy。无需安装 Node.js。\n\n"
    + "## 更新\n\n"
    + "先在 ChatGPT Tidy 的「设置 → 资料备份」导出备份。用新版文件覆盖原安装文件夹，重新加载扩展，刷新 ChatGPT 网页并重开侧栏。不要卸载扩展或清空扩展数据。\n\n"
    + "## English\n\n"
    + "Extract this ZIP to a permanent folder. Open chrome://extensions or edge://extensions, enable Developer mode, and use Load unpacked on the folder containing manifest.json. Refresh ChatGPT and open ChatGPT Tidy from the browser extensions menu. No Node.js installation is needed.\n\n"
    + "Before updating, export a backup from ChatGPT Tidy Settings. Replace the files in the same installation folder, reload the extension, refresh ChatGPT, then reopen ChatGPT Tidy. Do not uninstall the extension or clear its storage.\n") });
  const inventory = { name: "ChatGPT Tidy", version: manifest.version,
    files: entries.map(({ name, bytes }) => ({ path: name, size: bytes.length, sha256: sha256(bytes) })) };
  entries.push({ name: "PACKAGE-MANIFEST.json", bytes: Buffer.from(JSON.stringify(inventory, null, 2) + "\n") });
  const source = process.argv.includes("--source");
  let packagedEntries = entries;
  if (source) {
    packagedEntries = listSourceBundleFiles().map((name) => ({ name, bytes: readInputFile(projectRoot, name) }));
    const inventory = { name: "ChatGPT Tidy source", version: manifest.version,
      files: packagedEntries.map(({ name, bytes }) => ({ path: name, size: bytes.length, sha256: sha256(bytes) })) };
    packagedEntries.push({ name: "SOURCE-MANIFEST.json", bytes: Buffer.from(JSON.stringify(inventory, null, 2) + "\n") });
  }
  const bytes = await createArchive(packagedEntries, { source });
  await verifyArchive(bytes, packagedEntries);
  const directory = path.join(projectRoot, "dist");
  fs.mkdirSync(directory, { recursive: true });
  const filename = `chatgpt-tidy-${manifest.version}${source ? "-source" : ""}.zip`;
  const target = path.join(directory, filename);
  fs.writeFileSync(target, bytes);
  fs.writeFileSync(target + ".sha256", `${sha256(bytes)}  ${filename}\n`);
  // 保持 stdout 为一个可解析的 JSON 回执；材料指纹通过与上游缺口分开呈现。
  console.log(JSON.stringify({ path: target, files: packagedEntries.length, bytes: bytes.length, sha256: sha256(bytes),
    verified: true, localCandidate: true, thirdParty }, null, 2));
}

module.exports = { SOURCE_TOOL_FILES, assertReleasePath, assertSourcePath, listSourceFiles, listSourceBundleFiles, readInputFile, validateManifest, createArchive, verifyArchive };
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
