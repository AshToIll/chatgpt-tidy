const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const CURRENT = ["ARCHITECTURE.md", "DEVELOPMENT.md", "RELEASE_CHECKLIST.md", "STORAGE.md",
  "FILE_GUIDE.md", "FEATURE_CONTRACTS.md", "MESSAGE_INDEX.md"];
// Migration evidence is an explicit, finite record, not reusable product documentation.
// Exact source paths and test totals are evidence here; keep them forbidden in public guides.
const EVIDENCE = ["REFACTOR_PLAN.md", "BASELINE_VALIDATION.md", "VALIDATION.md"];
const CURRENT_MARKDOWN = [...CURRENT, ...EVIDENCE];
const CURRENT_DATA = ["DEVELOPMENT_DEPENDENCIES.json", "MIGRATION_MAP.json", "BEHAVIOR_BASELINE.json", "MESSAGE_INDEX.json"];
const LICENSE_FILES = ["fake-indexeddb-6.2.5-LICENSE.txt"];
const ROOT = new Set(["README.md", "current", "design-preview", "licenses"]);
const READMES = ["README.md", "README.en.md", "README.ja.md"];
const PUBLIC_DOCUMENTS = [...READMES, "docs/README.md", ...CURRENT.map(name => `docs/current/${name}`)];
const ALL_DOCUMENTS = [...PUBLIC_DOCUMENTS, ...EVIDENCE.map(name => `docs/current/${name}`)];
const MIGRATION_RECORDS = new Set([...EVIDENCE, "MIGRATION_MAP.json", "BEHAVIOR_BASELINE.json"].map(name => `docs/current/${name}`));
const read = file => fs.readFileSync(file, "utf8");
const linksIn = text => [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(match => match[1]);
function allowedDocument(file) {
  return file === "docs/README.md" || CURRENT_MARKDOWN.some(name => file === `docs/current/${name}`);
}
function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    // 个人草稿不属于公开文档，也不是本测试的输入；不能要求克隆者拥有它。
    if (directory === "docs" && entry.name === "design-preview") return [];
    assert.equal(entry.isSymbolicLink(), false, `Documentation must not follow a linked path: ${entry.name}`);
    const file = `${directory}/${entry.name}`;
    assert.notEqual(entry.name.toLowerCase(), "archive", "Retired documentation is deleted, not archived");
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

test("docs root and current contain only the explicit canonical entry and documents", () => {
  for (const entry of fs.readdirSync("docs", { withFileTypes: true })) {
    assert.ok(ROOT.has(entry.name), `Unexpected docs root entry: ${entry.name}`);
    assert.equal(entry.isDirectory(), entry.name !== "README.md");
  }
  assert.deepEqual(fs.readdirSync("docs/current").sort(), [...CURRENT_MARKDOWN, ...CURRENT_DATA].sort());
  assert.deepEqual(fs.readdirSync("docs/licenses").sort(), LICENSE_FILES);
  for (const file of filesUnder("docs").filter(file => file.endsWith(".md"))) assert.ok(allowedDocument(file), file);
  assert.equal(fs.existsSync("docs/archive"), false);
});

test("new date, report, audit, phase and parallel plan documents cannot reenter canonical directories", () => {
  for (const file of ["docs/AUDIT.md", "docs/REPORT_2026-09-14.md", "docs/PHASE1.md", "docs/PLAN.md",
    "docs/current/AUDIT.md", "docs/current/ARCHITECTURE_2026-09-14.md", "docs/current/REPORT.md",
    "docs/current/PHASE2.md", "docs/current/PLAN.md", "docs/archive/README.md", "docs/design-preview/OLD_PLAN.md"]) {
    assert.equal(allowedDocument(file), false, file);
  }
});

function verifyDocumentText(file, text) {
  // Historical results may keep test totals, but never machine paths or private conversation URLs.
  assert.doesNotMatch(text, /chatgpt-tidy-v[12]|unclaimed-sources|claim-receipts/i, file);
  assert.doesNotMatch(text, /(?:IndexedDB|IDB)\s*(?:version|版本|v)\s*[:=]?\s*5\b/i, file);
  // A drive starts a token: the final p/s in http(s):// is not a Windows drive.
  assert.doesNotMatch(text, /(?<![a-z])[a-z]:[\\/]|\/(?:Users|home)\/|\\\\[^\s\\]+\\[^\s\\]+/i, file);
  assert.doesNotMatch(text, /https:\/\/chatgpt\.com\/(?:g\/[^\s/]+\/)?c\/[a-f0-9-]{20,}/i, file);
  if (!MIGRATION_RECORDS.has(file)) {
    assert.doesNotMatch(text, /\b\d{3,}\s*(?:\/\s*\d+\s*)?(?:tests?\b|pass\b|项)/i, file);
  }
}

test("all public docs forbid private paths and retired storage contracts", () => {
  for (const file of [...READMES, ...filesUnder("docs")]) {
    verifyDocumentText(file, read(file));
  }
});

test("historical test totals do not exempt migration records from public privacy boundaries", () => {
  const evidence = "0.4.0 baseline; 2383 tests";
  for (const file of MIGRATION_RECORDS) assert.doesNotThrow(() => verifyDocumentText(file, evidence), file);
  for (const file of ["docs/current/FILE_GUIDE.md", "docs/current/FEATURE_CONTRACTS.md", "docs/current/MESSAGE_INDEX.md",
    "docs/current/ARCHITECTURE.md", "docs/current/MESSAGE_INDEX.json", "docs/current/OTHER_BASELINE.md"]) {
    assert.throws(() => verifyDocumentText(file, evidence), { name: "AssertionError" }, file);
  }
  for (const file of ALL_DOCUMENTS) {
    for (const local of ["C:/Users/example/data", "D:/projects/tidy-0.4.0", "D:\\projects\\tidy-0.5.0",
      "/Users/example/data", "/home/example/data", "\\\\server\\private-share"]) {
      assert.throws(() => verifyDocumentText(file, local), { name: "AssertionError" }, file);
    }
    assert.throws(() => verifyDocumentText(file, "chatgpt-tidy-v2"), { name: "AssertionError" }, file);
    const privateLink = "https://chatgpt.com/c/" + "12345678-1234-1234-1234-123456789abc";
    assert.throws(() => verifyDocumentText(file, privateLink), { name: "AssertionError" }, file);
  }
});

test("HTTP(S) URLs are not Windows drives, without exempting adjacent local paths", () => {
  for (const file of ALL_DOCUMENTS) {
    for (const url of ["http://chatgpt.com", "https://chatgpt.com", "HTTPS://chatgpt.com/c/example",
      "[Public documentation](https://example.test/guide)", "https://example.test/?q=reference"]) {
      assert.doesNotThrow(() => verifyDocumentText(file, url), file + ": " + url);
    }
    for (const local of ["C:/private/data", "C:\\private\\data", "Z:/private/data", "z:\\private\\data", "S://private/data",
      "D:/projects/tidy-0.4.0/src", "D:\\projects\\tidy-0.5.0\\src"]) {
      for (const text of [local, "Local path: " + local, "https://example.test/guide " + local,
        "[local](" + local + ")", "https://example.test/?path=" + local]) {
        assert.throws(() => verifyDocumentText(file, text), { name: "AssertionError" }, file + ": " + text);
      }
    }
  }
});

test("README links the docs entry, which links all current documents", () => {
  for (const file of READMES) assert.ok(linksIn(read(file)).includes("docs/README.md"), file);
  const entryLinks = linksIn(read("docs/README.md"));
  for (const name of [...CURRENT_MARKDOWN, ...CURRENT_DATA]) assert.ok(entryLinks.includes(`current/${name}`), name);
});

test("README language navigation links every other supported translation", () => {
  for (const file of READMES) {
    const intro = read(file).split(/\r?\n/).slice(0, 4).join("\n");
    assert.match(intro, /^# ChatGPT Tidy/);
    assert.deepEqual(linksIn(intro).sort(), READMES.filter(name => name !== file).sort(), file);
  }
});

test("public documentation links resolve without historical destinations", () => {
  const root = process.cwd();
  for (const file of ALL_DOCUMENTS) {
    for (const link of linksIn(read(file))) {
      if (/^(?:https?:|mailto:|#)/i.test(link)) continue;
      const destination = decodeURIComponent(link.split(/[?#]/, 1)[0]);
      const absolute = path.resolve(path.dirname(file), destination);
      const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      assert.ok(!relative.startsWith("../") && !path.isAbsolute(relative), `${file}: path outside repository ${link}`);
      assert.ok(fs.existsSync(absolute), `${file}: broken link ${link}`);
      // 链接可以指向实际源码和许可材料，但不能重新引入历史文档。
      if (relative.startsWith("docs/") && relative.endsWith(".md")) {
        assert.ok(allowedDocument(relative), `${file}: retired document ${link}`);
      }
    }
  }
});

test("canonical architecture/storage facts match the production boundaries", async () => {
  const { STORAGE_BOUNDARIES } = await import("../src/platform/storage/schema.js");
  const storage = read("docs/current/STORAGE.md"), architecture = read("docs/current/ARCHITECTURE.md");
  assert.ok(storage.includes(`\`${STORAGE_BOUNDARIES.indexedDb.databaseName}\``));
  assert.ok(storage.includes(`IndexedDB version ${STORAGE_BOUNDARIES.indexedDb.version}`));
  const documentedStores = [...storage.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]).sort();
  assert.deepEqual(documentedStores, Object.values(STORAGE_BOUNDARIES.indexedDb.stores).sort());
  assert.match(architecture, /Side Panel → Service Worker → Content\(ISOLATED\) → MAIN/);
  assert.ok(architecture.includes("src/platform/protocol.js"));
});

test("release version and documented development requirements match the project", () => {
  const metadata = JSON.parse(read("package.json"));
  const manifest = JSON.parse(read("src/manifest.json"));
  assert.equal(metadata.version, "0.5.0");
  assert.equal(manifest.version, metadata.version);
  assert.equal(metadata.engines.node, ">=24");
  for (const file of READMES) {
    assert.ok(read(file).includes(metadata.version), file);
    assert.ok(read(file).includes(`Chrome / Edge ${manifest.minimum_chrome_version}`), file);
  }
  for (const file of [...READMES, "docs/current/DEVELOPMENT.md"]) {
    assert.match(read(file), /Node(?:\.js)?\s*(?:>=\s*24|24\+)/, file);
    assert.ok(read(file).includes("npm run verify"), file);
  }
});

test("personal drafts and helper state remain ignored", () => {
  assert.match(read(".gitignore"), /^\/docs\/design-preview\/$/m);
  assert.match(read(".gitignore"), /^\/\.workbuddy\/$/m);
});
