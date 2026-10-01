#!/usr/bin/env node
"use strict";

// 架构门禁只读当前项目；不依赖迁移源目录、Git 或 .tmp。
// 只识别下面显式支持的引用语法，绝不把任意字符串当作文件路径。
// 动态表达式不猜测、不求值：报告跳过数量，交由运行测试覆盖。
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FEATURES = Object.freeze({
  time: "time-view.js",
  titles: "title-organization-view.js",
  favorites: "favorites-view.js",
  bookmarks: "bookmarks-view.js",
  search: "search-view.js",
  export: "export-view.js",
  settings: "settings-view.js"
});
const STATIC_ESM_KINDS = new Set(["import", "import from", "export from"]);
const GENERATED_BUNDLE = "src/app/page/main-world.bundle.js";
const posix = value => value.split(path.sep).join("/");
const within = (root, file) => file === root || file.startsWith(root + path.sep);
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const lineAt = (source, offset) => source.slice(0, offset).split("\n").length;
const isRemote = value => /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value);
const decodeString = value => value.replace(/\\(u\{[a-f\d]+\}|u[a-f\d]{4}|x[a-f\d]{2}|\r?\n|.)/gi, (_, escape) => {
  if (/^u\{/.test(escape)) return String.fromCodePoint(parseInt(escape.slice(2, -1), 16));
  if (/^[ux]/.test(escape)) return String.fromCodePoint(parseInt(escape.slice(1), 16));
  return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0", "\n": "", "\r\n": "" })[escape] ?? escape;
});

// 小型词法扫描器，不是 JS 执行器。字符串、注释、正则和模板正文会被整体跳过；
// 模板插值只寻找平衡边界，不会执行、折叠字符串或扫描其中的任意文案。
function tokenize(source) {
  function regexAllowed(previous) {
    return !previous || ["(", "[", "{", "=", ":", ",", ";", "!", "?", "&", "|", ">", "return", "throw", "case", "yield", "await"].includes(previous.value);
  }
  function scan(start, previous) {
    let i = start;
    while (i < source.length) {
      if (/\s/.test(source[i])) { i += 1; continue; }
      if (source.startsWith("//", i)) { const end = source.indexOf("\n", i + 2); i = end < 0 ? source.length : end; continue; }
      if (source.startsWith("/*", i)) { const end = source.indexOf("*/", i + 2); i = end < 0 ? source.length : end + 2; continue; }
      break;
    }
    if (i >= source.length) return null;
    const offset = i, quote = source[i];
    if (quote === "'" || quote === '"') {
      i += 1;
      while (i < source.length && source[i] !== quote) i += source[i] === "\\" ? 2 : 1;
      return { kind: "string", value: decodeString(source.slice(offset + 1, i)), offset, end: Math.min(i + 1, source.length) };
    }
    if (quote === "\x60") {
      i += 1;
      let dynamic = false;
      while (i < source.length && source[i] !== "\x60") {
        if (source[i] === "\\") { i += 2; continue; }
        if (source.startsWith("$" + "{", i)) {
          dynamic = true;
          i += 2;
          let depth = 1, previousExpressionToken = null;
          while (depth > 0) {
            const token = scan(i, previousExpressionToken);
            if (!token) { i = source.length; break; }
            if (token.kind === "punctuation" && token.value === "{") depth += 1;
            if (token.kind === "punctuation" && token.value === "}") depth -= 1;
            i = token.end;
            previousExpressionToken = token;
          }
        } else i += 1;
      }
      return { kind: dynamic ? "dynamic-template" : "string", value: dynamic ? "" : decodeString(source.slice(offset + 1, i)), offset, end: Math.min(i + 1, source.length) };
    }
    if (source[i] === "/" && regexAllowed(previous)) {
      i += 1;
      let inClass = false;
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === "[") inClass = true;
        if (source[i] === "]") inClass = false;
        if (source[i] === "/" && !inClass) { i += 1; break; }
        if (source[i] === "\n") break;
        i += 1;
      }
      while (/[a-z]/i.test(source[i] || "") && i < source.length) i += 1;
      return { kind: "regex", value: "", offset, end: i };
    }
    const identifier = source.slice(i).match(/^[A-Za-z_$][\w$]*/);
    if (identifier) return { kind: "identifier", value: identifier[0], offset, end: i + identifier[0].length };
    return { kind: "punctuation", value: source[i], offset, end: i + 1 };
  }
  const tokens = [];
  let i = 0, previous = null;
  while (i < source.length) {
    const token = scan(i, previous);
    if (!token) break;
    tokens.push(token); previous = token; i = token.end;
  }
  return tokens;
}

function callArguments(tokens, opening) {
  if (tokens[opening]?.value !== "(") return [];
  const args = [];
  let start = opening + 1, depth = 1;
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind === "punctuation") {
      if (["(", "[", "{"].includes(token.value)) depth += 1;
      if ([")", "]", "}"].includes(token.value)) depth -= 1;
      if ((token.value === "," && depth === 1) || depth === 0) {
        if (i > start) args.push(tokens.slice(start, i));
        start = i + 1;
        if (depth === 0) return args;
      }
    }
  }
  return args;
}

function javascriptReferences(source) {
  const tokens = tokenize(source), references = [], dynamic = [];
  function addArgument(argument, kind, base = "file", dependency = true) {
    if (argument?.length === 1 && argument[0].kind === "string") {
      references.push({ value: argument[0].value, line: lineAt(source, argument[0].offset), kind, base, dependency });
    } else if (argument?.length) dynamic.push({ kind, line: lineAt(source, argument[0].offset) });
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind !== "identifier") continue;
    if (token.value === "import" && tokens[i - 1]?.value !== ".") {
      if (tokens[i + 1]?.value === "(") addArgument(callArguments(tokens, i + 1)[0], "dynamic import");
      else if (tokens[i + 1]?.kind === "string") addArgument([tokens[i + 1]], "import");
      else if (tokens[i + 1]?.value !== ".") {
        for (let j = i + 1; j < tokens.length && tokens[j].value !== ";"; j += 1) {
          if (tokens[j].value === "from" && tokens[j + 1]?.kind === "string") { addArgument([tokens[j + 1]], "import from"); break; }
          if (j > i + 1 && ["import", "export"].includes(tokens[j].value)) break;
        }
      }
    }
    if (token.value === "export" && ["{", "*"].includes(tokens[i + 1]?.value)) {
      for (let j = i + 1; j < tokens.length && tokens[j].value !== ";"; j += 1) {
        if (tokens[j].value === "from" && tokens[j + 1]?.kind === "string") { addArgument([tokens[j + 1]], "export from"); break; }
        if (j > i + 1 && ["import", "export"].includes(tokens[j].value)) break;
      }
    }
    if (token.value === "importScripts" && tokens[i + 1]?.value === "(") {
      for (const argument of callArguments(tokens, i + 1)) addArgument(argument, "importScripts");
    }
    if (token.value === "getURL" && tokens[i - 1]?.value === "." && tokens[i - 2]?.value === "runtime" && tokens[i + 1]?.value === "(") {
      addArgument(callArguments(tokens, i + 1)[0], "runtime.getURL", "extension", false);
    }
    if (token.value === "new" && ["Worker", "SharedWorker"].includes(tokens[i + 1]?.value) && tokens[i + 2]?.value === "(") {
      addArgument(callArguments(tokens, i + 2)[0], "Worker");
    }
    if (token.value === "new" && tokens[i + 1]?.value === "URL" && tokens[i + 2]?.value === "(") {
      const args = callArguments(tokens, i + 2);
      if (args[1]?.map(part => part.value).join("") === "import.meta.url") addArgument(args[0], "URL(import.meta.url)");
    }
  }
  return { references, dynamic };
}

function markupReferences(source, type) {
  const references = [];
  if (type === "html") {
    const blank = text => text.replace(/[^\n]/g, " ");
    const clean = source
      .replace(/<!--[\s\S]*?-->/g, blank)
      .replace(/(<(?:script|style)\b[^>]*>)([\s\S]*?)(<\/(?:script|style)\s*>)/gi,
        (_, opening, body, closing) => opening + blank(body) + closing);
    for (const tag of clean.matchAll(/<[A-Za-z][^>]*>/g)) {
      for (const attr of tag[0].matchAll(/(?:^|\s)(src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        references.push({ value: attr[2] ?? attr[3], kind: "HTML " + attr[1], line: lineAt(source, tag.index + attr.index), base: "file", dependency: true });
      }
    }
  } else {
    // CSS content 字符串中的 "url(...)" 只是文字，不能误判为资源引用。
    function stringEnd(start) {
      const quote = source[start];
      let i = start + 1;
      while (i < source.length && source[i] !== quote) i += source[i] === "\\" ? 2 : 1;
      return Math.min(i + 1, source.length);
    }
    function readResource(start) {
      let i = start;
      while (/\s/.test(source[i] || "") && i < source.length) i += 1;
      const url = source.slice(i).match(/^url\s*\(\s*/i);
      if (url) i += url[0].length;
      let value, end;
      if (source[i] === "'" || source[i] === '"') {
        end = stringEnd(i);
        value = source.slice(i + 1, end - 1).replace(/\\(['"\\])/g, "$1");
      } else {
        const match = source.slice(i).match(/^[^'"\s;)]+/);
        if (!match) return null;
        value = match[0]; end = i + value.length;
      }
      if (url) { while (/\s/.test(source[end] || "") && end < source.length) end += 1; if (source[end] === ")") end += 1; }
      return { value, end };
    }
    let i = 0;
    while (i < source.length) {
      if (source.startsWith("/*", i)) { const end = source.indexOf("*/", i + 2); i = end < 0 ? source.length : end + 2; continue; }
      if (source[i] === "'" || source[i] === '"') { i = stringEnd(i); continue; }
      const importToken = source.slice(i).match(/^@import\b\s*/i);
      const urlToken = !/[\w-]/.test(source[i - 1] || "") && /^url\s*\(/i.test(source.slice(i));
      if (importToken || urlToken) {
        const resource = readResource(importToken ? i + importToken[0].length : i);
        if (resource) {
          references.push({ value: resource.value, kind: importToken ? "CSS @import" : "CSS url", line: lineAt(source, i), base: "file", dependency: Boolean(importToken) });
          i = resource.end; continue;
        }
      }
      i += 1;
    }
  }
  return { references, dynamic: [] };
}

function manifestReferences(manifest) {
  const references = [];
  function add(value, field) {
    if (typeof value === "string") references.push({ value, kind: "manifest " + field, base: "extension", line: 1, dependency: false });
  }
  add(manifest.background?.service_worker, "background.service_worker");
  add(manifest.side_panel?.default_path, "side_panel.default_path");
  add(manifest.options_ui?.page, "options_ui.page");
  for (const field of ["options_page", "devtools_page"]) add(manifest[field], field);
  for (const field of ["action", "browser_action", "page_action"]) {
    add(manifest[field]?.default_popup, field + ".default_popup");
    const icons = manifest[field]?.default_icon;
    if (typeof icons === "string") add(icons, field + ".default_icon");
    else for (const icon of Object.values(icons || {})) add(icon, field + ".default_icon");
  }
  for (const icon of Object.values(manifest.icons || {})) add(icon, "icons");
  for (const content of manifest.content_scripts || []) for (const field of ["js", "css"]) for (const file of content[field] || []) add(file, "content_scripts." + field);
  for (const page of manifest.sandbox?.pages || []) add(page, "sandbox.pages");
  for (const resource of manifest.web_accessible_resources || []) for (const file of resource.resources || []) add(file, "web_accessible_resources.resources");
  return { references, dynamic: [] };
}

// Read only literal build metadata; never require/execute a candidate project's
// tooling while validating it. Strings in prose/comments cannot become inputs.
function mainAssemblyMetadata(source) {
  const tokens = tokenize(source);
  function declaration(name) {
    const start = tokens.findIndex((token, index) => token.kind === "identifier" && token.value === name
      && ["const", "let", "var"].includes(tokens[index - 1]?.value) && tokens[index + 1]?.value === "=");
    if (start < 0) throw new Error("Missing literal " + name + " build metadata");
    let cursor = start + 2, frozen = false;
    if (tokens.slice(cursor, cursor + 4).map(token => token.value).join("") === "Object.freeze(") { cursor += 4; frozen = true; }
    const punctuation = value => { if (tokens[cursor]?.value !== value) throw new Error("Expected " + value + " in " + name); cursor += 1; };
    function value() {
      const token = tokens[cursor];
      if (token?.kind === "string") { cursor += 1; return token.value; }
      if (token?.value === "[") {
        cursor += 1; const output = [];
        while (tokens[cursor]?.value !== "]") { output.push(value()); if (tokens[cursor]?.value !== "]") punctuation(","); }
        punctuation("]"); return output;
      }
      if (token?.value === "{") {
        cursor += 1; const output = Object.create(null);
        while (tokens[cursor]?.value !== "}") {
          if (tokens[cursor]?.kind !== "string") throw new Error("Build dependency keys must be literal paths");
          const key = tokens[cursor++].value;
          if (Object.hasOwn(output, key)) throw new Error("Duplicate build dependency key: " + key);
          punctuation(":"); output[key] = value();
          if (tokens[cursor]?.value !== "}") punctuation(",");
        }
        punctuation("}"); return output;
      }
      throw new Error("Build metadata must contain only literal paths and arrays/objects");
    }
    const result = value(); if (frozen) punctuation(")"); punctuation(";"); return result;
  }
  return { sourceFiles: declaration("sourceFiles"), sourceDependencies: declaration("sourceDependencies") };
}

// A deliberately narrow classic-global probe: only direct namespace.property
// accesses are visible. Aliases/computed properties and injected parameters are
// not guessed; explicit sourceDependencies cover those assembly contracts.
function classicGlobalReferences(source) {
  const tokens = tokenize(source), provided = new Set(), used = new Set();
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (!["global", "globalThis", "root", "window", "self"].includes(tokens[index].value)
      || tokens[index + 1].value !== "." || tokens[index + 2].kind !== "identifier"
      || !/^Tidy[A-Z]/.test(tokens[index + 2].value)) continue;
    const name = tokens[index + 2].value;
    if (tokens[index + 3]?.value === "=" && tokens[index + 4]?.value !== "=") provided.add(name);
    else used.add(name);
  }
  return { provided: [...provided], used: [...used] };
}

function checkArchitecture(projectRoot = path.resolve(__dirname, "..")) {
  const root = path.resolve(projectRoot), sourceRoot = path.join(root, "src");
  const errors = [], dynamicReferences = [];
  // Only synchronous ESM edges participate in this graph. A literal lazy import
  // remains a checked path, but is not an eager evaluation cycle.
  const esmEdges = new Map();
  const stats = { migratedFiles: 0, features: 0, checkedReferences: 0, assetFiles: 0, scannedSources: 0, staticEsmEdges: 0, mainInputs: 0 };
  const error = (code, source, message, detail = {}) => errors.push({ code, source, message, ...detail });
  const relative = file => posix(path.relative(root, file));
  function loadJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (cause) { error("invalid-metadata", relative(file), cause.message); return {}; }
  }
  function walk(directory) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { error("source-symlink", relative(file), "Source must not link outside the standalone project"); return []; }
      return entry.isDirectory() ? walk(file) : [file];
    });
  }
  const migration = loadJson(path.join(root, "docs/current/MIGRATION_MAP.json"));
  const baseline = loadJson(path.join(root, "docs/current/BEHAVIOR_BASELINE.json"));
  for (const [oldName, newName] of Object.entries(migration.files || {})) {
    const oldFile = path.resolve(root, oldName), newFile = typeof newName === "string" ? path.resolve(root, newName) : "";
    if (!oldName.startsWith("src/") || !within(sourceRoot, oldFile) || typeof newName !== "string" || !newName.startsWith("src/") || !within(sourceRoot, newFile)) {
      error("invalid-migration-path", "docs/current/MIGRATION_MAP.json", "Migration paths must stay within src", { reference: String(oldName) + " -> " + String(newName) }); continue;
    }
    if (oldFile !== newFile && fs.existsSync(oldFile)) error("retired-path-exists", oldName, "Retired source path must not exist, even as a compatibility re-export");
    if (!fs.existsSync(newFile) || !fs.statSync(newFile).isFile()) error("missing-migration-target", newName, "Mapped new source file is missing");
    stats.migratedFiles += 1;
  }
  if (!stats.migratedFiles) error("missing-migration-map", "docs/current/MIGRATION_MAP.json", "Migration file mapping must not be empty");

  for (const [feature, view] of Object.entries(FEATURES)) {
    const ui = path.join(sourceRoot, "features", feature, "ui");
    if (!fs.existsSync(path.join(ui, view))) error("missing-feature-view", relative(path.join(ui, view)), "Each navigation feature must own its primary view");
    if (!fs.existsSync(ui) || !fs.readdirSync(ui).some(name => name.endsWith(".css") && fs.statSync(path.join(ui, name)).isFile())) error("missing-feature-style", relative(ui), "Each navigation feature must own CSS");
    stats.features += 1;
  }

  const sourceFiles = walk(sourceRoot);
  let realSourceRoot;
  try { realSourceRoot = fs.realpathSync(sourceRoot); }
  catch { error("missing-source-root", "src", "Standalone source directory is missing"); }
  function checkReference(owner, reference) {
    const raw = reference.value;
    if (!raw || isRemote(raw)) return;
    if (raw.includes("$" + "{") || /[*?]/.test(raw.split(/[?#]/)[0])) {
      dynamicReferences.push({ source: relative(owner), line: reference.line, kind: reference.kind, reason: "template or glob" }); return;
    }
    // getURL 使用扩展根目录；其他引用只解析明确相对路径或扩展绝对路径。
    // 模块 bare specifier 不是假装成相对文件：本项目没有 import map/包解析器。
    if (["import", "import from", "export from", "dynamic import"].includes(reference.kind) && !raw.startsWith(".") && !raw.startsWith("/")) {
      error("unresolved-bare-module", relative(owner), "Browser extension modules must use explicit local paths", { line: reference.line, reference: raw }); return;
    }
    let clean;
    try { clean = decodeURIComponent(raw.split(/[?#]/)[0]); }
    catch { error("invalid-reference", relative(owner), "Local reference contains invalid URL encoding", { line: reference.line, reference: raw }); return; }
    if (!clean) return;
    const target = reference.base === "extension" || clean.startsWith("/")
      ? path.resolve(sourceRoot, clean.replace(/^\/+/, ""))
      : path.resolve(path.dirname(owner), clean);
    if (!within(sourceRoot, target)) {
      error("reference-outside-src", relative(owner), "Local reference escapes the packaged src tree", { line: reference.line, reference: raw }); return;
    }
    stats.checkedReferences += 1;
    if (!fs.existsSync(target)) {
      error("missing-reference", relative(owner), "Local reference target does not exist", { line: reference.line, reference: raw, target: relative(target) }); return;
    }
    if (realSourceRoot && !within(realSourceRoot, fs.realpathSync(target))) {
      error("reference-outside-project", relative(owner), "Resolved target leaves the standalone source tree", { line: reference.line, reference: raw }); return;
    }
    if (!fs.statSync(target).isFile() && !(reference.kind === "runtime.getURL" && clean.endsWith("/"))) {
      error("reference-not-file", relative(owner), "Local code/style/document reference must identify a file", { line: reference.line, reference: raw, target: relative(target) });
    }
    if (STATIC_ESM_KINDS.has(reference.kind)) {
      const ownerName = relative(owner), targetName = relative(target);
      if (!esmEdges.has(ownerName)) esmEdges.set(ownerName, new Set());
      esmEdges.get(ownerName).add(targetName);
      stats.staticEsmEdges += 1;
    }
    if (reference.dependency) {
      const from = relative(owner).match(/^src\/features\/([^/]+)\//);
      const destination = relative(target);
      if (from && destination.startsWith("src/app/")) error("feature-imports-app", relative(owner), "Features must not import the application composition root", { line: reference.line, reference: raw, target: destination });
      if (relative(owner).startsWith("src/platform/") && destination.startsWith("src/app/")) error("platform-imports-app", relative(owner), "Platform modules must not import the application composition root", { line: reference.line, reference: raw, target: destination });
      const other = destination.match(/^src\/features\/([^/]+)\/ui(?:\/|$)/);
      if (from && other && from[1] !== other[1]) error("feature-imports-other-ui", relative(owner), "Cross-feature UI imports are forbidden; share a model/storage contract or platform component", { line: reference.line, reference: raw, target: destination });
    }
  }

  for (const file of sourceFiles) {
    const name = relative(file);
    if (name.startsWith("src/assets/") || name.startsWith("src/vendor/") || name === GENERATED_BUNDLE) continue;
    const extension = path.extname(file);
    let result;
    if ([".js", ".mjs"].includes(extension)) result = javascriptReferences(fs.readFileSync(file, "utf8"));
    else if ([".html", ".css"].includes(extension)) result = markupReferences(fs.readFileSync(file, "utf8"), extension.slice(1));
    else if (name === "src/manifest.json") result = manifestReferences(loadJson(file));
    else continue;
    stats.scannedSources += 1;
    for (const item of result.dynamic) dynamicReferences.push({ source: name, ...item, reason: "non-literal expression" });
    for (const reference of result.references) checkReference(file, reference);
  }

  // Tarjan SCCs report every eager import cycle exactly once (including self
  // imports), without pretending that dynamic URLs or classic globals are ESM.
  const indices = new Map(), low = new Map(), stack = [], active = new Set();
  let sequence = 0;
  function visitModule(name) {
    indices.set(name, sequence); low.set(name, sequence++); stack.push(name); active.add(name);
    for (const target of esmEdges.get(name) || []) {
      if (!indices.has(target)) { visitModule(target); low.set(name, Math.min(low.get(name), low.get(target))); }
      else if (active.has(target)) low.set(name, Math.min(low.get(name), indices.get(target)));
    }
    if (indices.get(name) !== low.get(name)) return;
    const component = [];
    let item;
    do { item = stack.pop(); active.delete(item); component.push(item); } while (item !== name);
    if (component.length > 1 || esmEdges.get(name)?.has(name)) {
      component.sort();
      error("static-esm-cycle", component[0], "Eager ESM imports must form an acyclic dependency graph", { modules: component });
    }
  }
  for (const name of [...esmEdges.keys()].sort()) if (!indices.has(name)) visitModule(name);

  const builderPath = path.join(root, "tools/build-main-world.cjs");
  const mainEntry = "src/app/page/main-world.js";
  if (fs.existsSync(builderPath) || fs.existsSync(path.join(root, mainEntry))) {
    try {
      const assembly = mainAssemblyMetadata(fs.readFileSync(builderPath, "utf8"));
      const inputs = assembly.sourceFiles, dependencies = assembly.sourceDependencies;
      if (!Array.isArray(inputs) || !inputs.length || !dependencies || Array.isArray(dependencies) || typeof dependencies !== "object") {
        throw new Error("MAIN build metadata must contain a nonempty input array and a dependency object");
      }
      stats.mainInputs = inputs.length;
      const positions = new Map(), providers = new Map(), globals = new Map();
      for (const [index, name] of inputs.entries()) {
        if (typeof name !== "string" || !name.startsWith("src/") || !name.endsWith(".js")
          || name.includes("\\") || !within(sourceRoot, path.resolve(root, name)) || name === GENERATED_BUNDLE) {
          error("invalid-main-input", "tools/build-main-world.cjs", "MAIN inputs must be explicit JavaScript source files inside src", { reference: String(name) }); continue;
        }
        if (positions.has(name)) error("duplicate-main-input", "tools/build-main-world.cjs", "MAIN modules must execute exactly once", { reference: name });
        positions.set(name, index);
        const file = path.resolve(root, name);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { error("missing-main-input", "tools/build-main-world.cjs", "MAIN source input is missing", { reference: name }); continue; }
        if (realSourceRoot && !within(realSourceRoot, fs.realpathSync(file))) { error("main-input-outside-project", name, "MAIN source resolves outside the standalone source tree"); continue; }
        const references = classicGlobalReferences(fs.readFileSync(file, "utf8"));
        globals.set(name, references);
        for (const globalName of references.provided) {
          if (providers.has(globalName) && providers.get(globalName) !== name) error("duplicate-main-global", name, "MAIN global has multiple providers", { reference: globalName, target: providers.get(globalName) });
          providers.set(globalName, name);
        }
      }
      if (inputs.at(-1) !== mainEntry) error("main-entry-order", "tools/build-main-world.cjs", "MAIN composition root must execute after every input", { reference: mainEntry });
      const order = (owner, dependency, kind) => {
        if (!positions.has(owner) || !positions.has(dependency)) error("missing-main-dependency", "tools/build-main-world.cjs", "Declared MAIN owners and dependencies must both be build inputs", { reference: owner, target: dependency });
        else if (positions.get(dependency) >= positions.get(owner)) error("main-dependency-order", owner, kind + " dependency must execute before its consumer", { reference: dependency });
      };
      for (const [owner, required] of Object.entries(dependencies)) {
        if (!Array.isArray(required) || required.some(item => typeof item !== "string")) { error("invalid-main-dependencies", "tools/build-main-world.cjs", "MAIN dependency lists must be literal path arrays", { reference: owner }); continue; }
        for (const dependency of required) order(owner, dependency, "Explicit assembly");
      }
      for (const [owner, references] of globals) for (const name of references.used) {
        const provider = providers.get(name);
        if (provider && provider !== owner && !(dependencies[owner] || []).includes(provider)) order(owner, provider, "Direct classic global");
        else if (!provider) dynamicReferences.push({ source: owner, kind: "classic global", reference: name, reason: "provider is external, optional or not statically visible" });
      }
    } catch (cause) { error("invalid-main-assembly", "tools/build-main-world.cjs", cause.message); }
  }

  const expectedAssets = baseline.assetHashes || {};
  const actualAssets = sourceFiles.filter(file => /^src\/(?:assets|vendor)\//.test(relative(file)));
  const actualNames = new Set(actualAssets.map(relative));
  if (!Object.keys(expectedAssets).length) error("missing-asset-baseline", "docs/current/BEHAVIOR_BASELINE.json", "Asset hash baseline must not be empty");
  for (const [name, expected] of Object.entries(expectedAssets)) {
    if (!/^src\/(?:assets|vendor)\//.test(name) || !within(sourceRoot, path.resolve(root, name))) {
      error("invalid-asset-path", "docs/current/BEHAVIOR_BASELINE.json", "Asset baseline must stay inside src/assets or src/vendor", { reference: name }); continue;
    }
    if (!actualNames.has(name)) { error("missing-baseline-asset", name, "Baseline asset is missing"); continue; }
    if (hash(fs.readFileSync(path.join(root, name))) !== expected) error("changed-baseline-asset", name, "Asset/vendor SHA256 differs from the behavior baseline");
    stats.assetFiles += 1;
  }
  for (const name of actualNames) if (!(name in expectedAssets)) error("unexpected-asset", name, "Architecture-only migration must not add untracked asset/vendor files");
  return {
    ok: errors.length === 0, errors, stats, dynamicReferences,
    scope: [
      "Static ESM import/export-from, literal dynamic import, importScripts, runtime.getURL, Worker and URL(import.meta.url)",
      "Quoted HTML src/href, CSS @import/url and explicit manifest file fields",
      "Dynamic expressions and manifest globs are reported but not evaluated; Worker literals are checked relative to their host source directory",
      "Static ESM import/export-from cycles are rejected; lazy imports are checked only as references",
      "Classic global assembly is not an ESM graph: aliased, computed, injected or delayed dependencies require explicit MAIN input ordering and runtime tests",
      "Generated MAIN bundle content is checked separately by node tools/build-main-world.cjs --check"
    ]
  };
}

module.exports = { checkArchitecture, javascriptReferences, markupReferences, mainAssemblyMetadata, classicGlobalReferences, FEATURES };
if (require.main === module) {
  const result = checkArchitecture();
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    for (const issue of result.errors) console.error(issue.code + " " + issue.source + (issue.line ? ":" + issue.line : "") + ": " + issue.message + (issue.reference ? " [" + issue.reference + "]" : "") + (issue.target ? " -> " + issue.target : ""));
    console.log((result.ok ? "PASS" : "FAIL") + " architecture: " + result.stats.migratedFiles + " migrated files; " + result.stats.features + " feature owners; " + result.stats.checkedReferences + " static references; " + result.stats.assetFiles + " unchanged assets/vendor files.");
    console.log("Scope: " + result.dynamicReferences.length + " dynamic references/globs not evaluated. MAIN bundle freshness belongs to build-main-world.cjs --check.");
    console.log("Graph: " + result.stats.staticEsmEdges + " eager ESM edges; " + result.stats.mainInputs + " ordered MAIN inputs. Classic globals cover direct accesses and declared assembly only; aliases, computed access and injected dependencies require runtime tests.");
  }
  process.exitCode = result.ok ? 0 : 1;
}
