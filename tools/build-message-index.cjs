#!/usr/bin/env node
"use strict";
// PM 索引由唯一文案源 + 当前源码生成。不是另写一份容易过期的产品规格。
// --check 只比较，不写盘；无静态引用不等于未使用（动态映射另外列出）。
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), vm = require("node:vm");
const ROOT = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
const generated = new Set(["src/messages/build-info.js", "src/messages/i18n.js", "src/messages/page-runtime.js", "src/app/page/main-world.bundle.js"]);
function walk(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name,"en"))
    .flatMap(item => item.isDirectory() ? walk(dir + "/" + item.name) : [dir + "/" + item.name]);
}
function lineAt(text, index) { return text.slice(0, index).split("\n").length; }
function excerptAt(text, index) {
  const start = text.lastIndexOf("\n", index - 1) + 1, end = text.indexOf("\n", index);
  return text.slice(start, end < 0 ? text.length : end).trim().slice(0, 260);
}
function maskComments(text) {
  // 保留字节位置/行号；仅屏蔽注释，字符串和模板中的产品键继续被搜索。
  let result = "", quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (quote) {
      result += c;
      if (c === "\\") { result += text[++i] || ""; continue; }
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === String.fromCharCode(96)) { quote = c; result += c; }
    else if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") { result += " "; i++; } result += text[i] || ""; }
    else if (c === "/" && n === "*") {
      result += "  "; i += 2;
      while (i < text.length && !(text[i] === "*" && text[i+1] === "/")) { result += text[i] === "\n" ? "\n" : " "; i++; }
      result += "  "; i++;
    } else result += c;
  }
  return result;
}
function buildOutputs() {
  const definitions = new Map(), catalogs = [];
  for (const file of walk("src/messages/catalogs").filter(file => file.endsWith(".json"))) {
    const source = read(file), catalog = JSON.parse(source), owner = path.basename(file, ".json");
    catalogs.push({ owner, description: catalog.description });
    for (const [key, translations] of Object.entries(catalog.messages || {})) {
      if (definitions.has(key)) throw new Error("Duplicate message key: " + key);
      const position = source.indexOf(JSON.stringify(key) + ":");
      definitions.set(key, { key, owner, translations, definition: { source: file, line: lineAt(source, position) }, references: [] });
    }
  }
  const files = walk("src").filter(file => !generated.has(file) && !file.startsWith("src/vendor/")
    && !file.startsWith("src/assets/") && /\.(?:js|json|html|css)$/.test(file));
  const sourceFiles = files.filter(file => !file.startsWith("src/messages/catalogs/") && !file.startsWith("src/_locales/"));
  const stageCodes = new Set();
  const dynamicCalls = [], unknownLiteralCalls = [], reasonCodes = new Set(["OBSERVATION_ONLY_UNSPECIFIED", "NOTICE_REPLACED"]);
  for (const file of sourceFiles) {
    const source = read(file), masked = maskComments(source);
    // Only code-authored stage assignments/fallbacks are diagnostic vocabulary.
    // A remote string can never create an allowlist entry at runtime.
    for (const stage of masked.matchAll(/\bstage\s*(?::|=(?!=))\s*([^,;\n}]+)/g)) {
      for (const literal of stage[1].matchAll(/(?:^\s*|(?:\|\||\?\?|[?:])\s*)(["\'])([A-Za-z][A-Za-z0-9_.-]{0,99})\1/g)) stageCodes.add(literal[2]);
    }
    // These helpers put their second literal argument into the structured stage field.
    for (const stage of masked.matchAll(/\b(?:atStage|catalogFailure)\s*\([^,\n]+,\s*(["\'])([A-Za-z][A-Za-z0-9_.-]{0,99})\1/g)) stageCodes.add(stage[2]);
    for (const match of masked.matchAll(/(["'])([A-Za-z][A-Za-z0-9_]*)\1/g)) {
      const key = match[2], definition = definitions.get(key);
      if (/^[A-Z][A-Z0-9_]{2,79}$/.test(key) || /^[a-z]+(?:_[a-z]+)+$/.test(key) || /^export[A-Z][A-Za-z0-9_]*$/.test(key)) reasonCodes.add(key);
      if (!definition) continue;
      const before = masked.slice(Math.max(0, match.index - 60), match.index);
      const direct = /(?:\b(?:t|translate|text|showToast|onToast|toast|showSearchToast))\s*\(\s*$/.test(before);
      definition.references.push({ source: file, line: lineAt(source, match.index),
        kind: direct ? "direct-call" : "literal-reference", excerpt: excerptAt(source, match.index) });
    }
    for (const match of masked.matchAll(/\b(t|translate|text|showToast|onToast|toast|showSearchToast)\s*\(\s*([^,\n)]*)/g)) {
      const first = match[2].trim(), literal = first.match(/^["']([A-Za-z][A-Za-z0-9_]*)["']$/);
      if (literal) {
        if (!definitions.has(literal[1])) unknownLiteralCalls.push({ source: file, line: lineAt(source, match.index), callee: match[1], key: literal[1], excerpt: excerptAt(source, match.index) });
      } else if (first) dynamicCalls.push({ source: file, line: lineAt(source, match.index), callee: match[1], expression: first.slice(0, 180), excerpt: excerptAt(source, match.index) });
    }
  }
  // pageBindings/themeBindings 是代码外的明确运行绑定，不能误报为无静态引用。
  for (const file of walk("src/messages/catalogs").filter(file => file.endsWith(".json"))) {
    const source = read(file), catalog = JSON.parse(source);
    for (const group of [catalog.pageBindings, catalog.themeBindings]) {
      for (const key of Object.values(group || {})) {
        if (definitions.has(key)) {
          const marker = JSON.stringify(key), index = source.lastIndexOf(marker);
          definitions.get(key).references.push({ source: file, line: lineAt(source, index), kind: "runtime-binding", excerpt: excerptAt(source, index) });
        }
      }
    }
  }
  const context = vm.createContext({});
  vm.runInContext(read("src/messages/notice-registry.js"), context, { filename: "notice-registry.js" });
  const surfaces = JSON.parse(JSON.stringify(context.ChatGPTTidyNoticeRegistry.surfaces)).map(surface => ({
    ...surface, observationSites: sourceFiles.flatMap(file => {
      const source = read(file), needle = JSON.stringify(surface.surface), result = [];
      let start = 0, index;
      while ((index = source.indexOf(needle, start)) >= 0) {
        if (file !== "src/messages/notice-registry.js") result.push({ source: file, line: lineAt(source, index) });
        start = index + needle.length;
      }
      return result;
    })
  }));
  const hash = crypto.createHash("sha256");
  for (const file of files.sort()) hash.update(file + "\0").update(read(file)).update("\0");
  // 指纹还覆盖生成规则；生成产物不参与哈希，避免循环和构建顺序依赖。
  for (const file of ["tools/build-messages.cjs", "tools/build-message-index.cjs"]) {
    if (fs.existsSync(path.join(ROOT,file))) hash.update(file + "\0").update(read(file)).update("\0");
  }
  const version = JSON.parse(read("src/manifest.json")).version, fingerprint = hash.digest("hex").slice(0, 24);
  const messages = [...definitions.values()].sort((a,b)=>a.owner.localeCompare(b.owner,"en") || a.key.localeCompare(b.key,"en"));
  const index = { schemaVersion: 1, version, buildFingerprint: fingerprint,
    limitations: ["静态文字引用不是唯一触发条件；条件以列出的函数和分支为准。",
      "无静态引用不等于未使用；动态计算键另列，不自动删除任何文案。",
      "诊断仅记录已接入表面：当前文档环形256条；独立会话层仅保留已成功交付记录，最多512条/256KiB，浏览器会话结束清除。",
      "未保留类型化错误的路径标记 OBSERVATION_ONLY_UNSPECIFIED，不伪造根因。",
      "源码行号随改动更新；修改后重新生成此索引。"],
    catalogs, surfaces, messages, noStaticReferenceKeys: messages.filter(item=>!item.references.length).map(item=>item.key), dynamicCalls, unknownLiteralCalls };
  // 导出模块沿用文案键作为类型化 errorCode（如 exportJobTimeout），必须保留而不是误降为未知。
  const buildInfo = { version, fingerprint, messageKeys: [...definitions.keys()].sort(), reasonCodes: [...new Set([...reasonCodes, ...definitions.keys()])].sort(), stageCodes: [...stageCodes].sort(), sources: sourceFiles.sort() };
  const infoText = "// GENERATED by tools/build-message-index.cjs; do not edit.\n(function(global){ global.ChatGPTTidyBuildInfo = Object.freeze("
    + JSON.stringify(buildInfo, null, 2) + "); })(globalThis);\n";
  const escape = value => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
  const loc = ref => "[" + ref.source + ":" + ref.line + "](../../" + ref.source + "#L" + ref.line + ")";
  const lines = ["# 用户提示与文案索引", "", "> 自动生成：node tools/build-message-index.cjs；仅校验加 --check。不要直接编辑本文件。",
    "", "构建版本：" + version + "；源码指纹：" + fingerprint + "。", "",
    "## 怎么修改与追查", "", "- 改文字：编辑 src/messages/catalogs 下所属栏目 JSON，同一键只存在一处；运行 build:messages 和索引生成器。",
    "- 查触发：先搜看到的文字，找到键和引用位置；动态键也列出。一个键可能对应多个错误，不把中文当错误码。",
    "- 查本次原因：设置里的本地诊断可复制已交付会话记录；控制台 ChatGPTTidyDiagnostics.exportText() 只导出当前文档。仅含安全归因字段、生成关联号、构建指纹和出现/清除。",
    "- 文档内存最多256条；已交付会话层最多512条/256KiB，关闭侧栏仍可查，浏览器结束清除。未发出或在途记录不保证交付；缺少类型化原因时不得宣称已确认根因。",
    "- 文案改动按精确四语言白名单审查；展示分为短暂反馈、持续条件与操作状态，未知写入没有TTL，也不因栏目隐藏被当作完成。",
    "", "## 提示表面：触发、恢复与清除", "",
    "| 表面/所属栏 | 展示类别 | 显示条件 | 用户恢复入口 | 清除策略 | 观测位置 |", "|---|---|---|---|---|---|"];
  for (const surface of surfaces) lines.push("| " + escape(surface.surface + " / " + surface.owner) + " | " + escape(surface.kinds.join(", ")) + " | " + escape(surface.trigger) + " | " + escape(surface.recovery) + " | " + escape(surface.clear) + " | " + surface.observationSites.map(loc).join("<br>") + " |");
  lines.push("", "## 全量文案", "", "包括按钮、悬浮说明、状态、错误和空状态；并非每个文案键都是错误。", "",
    "| 所属栏 / 稳定键 | 简体中文 | 维护位置 | 当前源码引用（字面引用不等于直接显示） |", "|---|---|---|---|");
  for (const item of messages) lines.push("| " + item.owner + " / " + item.key + " | " + escape(item.translations["zh-CN"] ?? "未定义，沿用原翻译回退") + " | " + loc(item.definition) + " | " + (item.references.map(ref => loc(ref) + " (" + ref.kind + ")").join("<br>") || "未找到静态引用；需核对动态入口") + " |");
  lines.push("", "## 未找到静态引用的键", "", "这是待核对候选，不是可直接删除清单：", "", index.noStaticReferenceKeys.join("、") || "无。",
    "", "## 动态键调用", "", "下列调用需沿变量或映射继续看分支；不能假装静态索引已经推导出唯一根因。", "",
    "| 位置 | 调用 |", "|---|---|");
  for (const call of dynamicCalls) lines.push("| " + loc(call) + " | " + escape(call.callee + "(" + call.expression + ")") + " |");
  lines.push("", "## 未登记字面量调用候选", "", "扫描器按常见函数名识别；可能包含同名非翻译函数，必须按源码核对。", "",
    "| 位置 | 调用 |", "|---|---|");
  for (const call of unknownLiteralCalls) lines.push("| " + loc(call) + " | " + escape(call.callee + "(" + call.key + ")") + " |");
  lines.push("", "## 机器可读完整数据", "", "[MESSAGE_INDEX.json](MESSAGE_INDEX.json) 含四语言文字、精确行号、调用片段、表面登记与扫描局限。", "");
  return new Map([["src/messages/build-info.js",infoText], ["docs/current/MESSAGE_INDEX.json", JSON.stringify(index,null,2)+"\n"], ["docs/current/MESSAGE_INDEX.md",lines.join("\n")]]);
}
if (require.main === module) {
  const check = process.argv.includes("--check"), outputs = buildOutputs(), mismatches = [];
  for (const [file, content] of outputs) {
    if (check) { if (!fs.existsSync(path.join(ROOT,file)) || read(file) !== content) mismatches.push(file); }
    else { fs.mkdirSync(path.dirname(path.join(ROOT,file)), { recursive: true }); fs.writeFileSync(path.join(ROOT,file),content); }
  }
  if (mismatches.length) { console.error("Message index/build information is stale:\n" + mismatches.join("\n")); process.exitCode=1; }
  else console.log(check ? "Message index/build information is current." : "Generated message index and build information.");
}
module.exports = { buildOutputs };
