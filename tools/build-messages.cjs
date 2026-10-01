#!/usr/bin/env node
"use strict";

// 文案唯一编辑入口在 src/messages/catalogs/；本脚本只组装数据，不决定何时提示。
// i18n.js 供 ESM 侧栏/导出使用，page-runtime.js 供不能 import 的网页脚本使用。
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const GROUPS = Object.freeze(["common", "time", "titles", "favorites", "bookmarks", "search", "export", "settings"]);
const LANGUAGES = Object.freeze(["zh-CN", "zh-TW", "en", "ja"]);
const HEADER = "// 自动生成，请勿直接修改。唯一文案源：src/messages/catalogs/*.json\n"
  + "// 修改文案后运行 npm run build:messages；npm run check:messages 检查生成文件同步。\n";

// 退役清单只记录已审计的身份与历史指纹，不提供运行时别名或兼容文案。
// 构建工具独立读取生产元数据；历史哈希的逐条核对由测试负责，不依赖 tests。
function loadRetiredKeys() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "src/messages/retired-keys.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.retiredKeys)) throw new Error("Invalid retired message manifest");
  const keys = new Set();
  for (const entry of manifest.retiredKeys) {
    if (!entry || Object.keys(entry).sort().join(",") !== "beforeHashes,catalog,key,reason,replacements"
      || !/^[A-Za-z][A-Za-z0-9]*$/.test(entry.key) || !GROUPS.includes(entry.catalog)
      || typeof entry.reason !== "string" || !entry.reason.trim()
      || !Array.isArray(entry.replacements) || new Set(entry.replacements).size !== entry.replacements.length
      || entry.replacements.some(key => typeof key !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/.test(key))
      || !entry.beforeHashes || Object.keys(entry.beforeHashes).sort().join(",") !== [...LANGUAGES].sort().join(",")
      || LANGUAGES.some(language => !/^[a-f0-9]{64}$/.test(entry.beforeHashes[language]))) {
      throw new Error("Invalid retired message entry: " + entry?.key);
    }
    if (keys.has(entry.key)) throw new Error("Duplicate retired message: " + entry.key);
    keys.add(entry.key);
  }
  for (const entry of manifest.retiredKeys) for (const replacement of entry.replacements) {
    if (keys.has(replacement)) throw new Error("Retired replacement message: " + replacement);
  }
  return manifest.retiredKeys;
}

function loadCatalogs({ catalogOverrides = {} } = {}) {
  // 纯内存覆盖供构建门禁回归使用；正常构建仍读取唯一 catalog，不写回覆盖内容。
  if (Object.keys(catalogOverrides).some(group => !GROUPS.includes(group))) throw new Error("Invalid catalog override");
  const retiredKeys = loadRetiredKeys();
  const retired = new Set(retiredKeys.map(entry => entry.key));
  const strings = Object.fromEntries(LANGUAGES.map(language => [language, {}]));
  const owners = new Map();
  const pageBindings = {};
  let themeBindings = {};
  for (const group of GROUPS) {
    const file = path.join(ROOT, "src", "messages", "catalogs", group + ".json");
    const catalog = Object.hasOwn(catalogOverrides, group) ? catalogOverrides[group] : JSON.parse(fs.readFileSync(file, "utf8"));
    if (!catalog.description || !catalog.messages || typeof catalog.messages !== "object") {
      throw new Error("Invalid message catalog: " + group);
    }
    for (const [key, translations] of Object.entries(catalog.messages)) {
      if (retired.has(key)) throw new Error("Retired message cannot be registered: " + key);
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) throw new Error("Invalid message key: " + key);
      if (owners.has(key)) throw new Error("Duplicate message " + key + ": " + owners.get(key) + " / " + group);
      owners.set(key, group);
      if (!translations || typeof translations !== "object") throw new Error("Invalid translations: " + key);
      for (const [language, value] of Object.entries(translations)) {
        if (!LANGUAGES.includes(language) || typeof value !== "string") throw new Error("Invalid translation: " + key + "/" + language);
        strings[language][key] = value;
      }
    }
    if (catalog.pageBindings) pageBindings[group] = catalog.pageBindings;
    if (catalog.themeBindings) themeBindings = catalog.themeBindings;
  }
  for (const entry of retiredKeys) for (const replacement of entry.replacements) {
    if (!owners.has(replacement)) throw new Error("Missing retirement replacement: " + replacement);
  }
  // 缺词保持原 createTranslator 的英文回退；这里不能补齐或改写已有翻译。
  function bind(bindings) {
    return Object.fromEntries(LANGUAGES.map(language => [language,
      Object.fromEntries(Object.entries(bindings).map(([name, key]) => {
        if (!owners.has(key) || typeof strings[language][key] !== "string") {
          throw new Error("Missing bound message: " + key + "/" + language);
        }
        return [name, strings[language][key]];
      })),
    ]));
  }
  return {
    strings,
    retiredKeys,
    pageLabels: Object.fromEntries(Object.entries(pageBindings).map(([group, bindings]) => [group, bind(bindings)])),
    themeNames: bind(themeBindings),
  };
}

// 保持原字典键为普通 JS 属性；便于源码检索，也保留既有检查和无 import 的测试加载方式。
function javascriptObject(value) {
  return JSON.stringify(value, null, 2).replace(/^(\s*)"([A-Za-z_$][\w$]*)":/gm, "$1$2:");
}


const FALLBACK_FILES = Object.freeze([
  "src/app/sidepanel/index.html",
  "src/features/time/ui/time-template.js",
  "src/features/settings/ui/settings-template.js",
]);

// HTML 的结构由栏目维护，初始文案由 catalog 同步；避免用户改了词库，旧字还躲在模板里。
// 这里只处理已登记的纯文本/属性节点，不解析或改写业务模板、HTML 结构或动态用户内容。
function synchronizeFallbacks(source, relative, dictionary) {
  function text(key, attribute = false) {
    if (typeof dictionary[key] !== "string") throw new Error("Missing HTML fallback message: " + key);
    let value = dictionary[key].replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    if (attribute) value = value.replaceAll('"', "&quot;");
    return value;
  }
  function aria(tag, key) {
    if (!/\baria-label="[^"]*"/.test(tag)) throw new Error("Missing fallback aria-label: " + relative + "/" + key);
    return tag.replace(/\baria-label="[^"]*"/, 'aria-label="' + text(key, true) + '"');
  }
  source = source.replace(/<([a-z][\w-]*)\b([^>]*\bdata-i18n="([^"]+)"[^>]*)>([^<]*)<\/\1>/gi,
    (_match, tag, attributes, key) => "<" + tag + attributes + ">" + text(key) + "</" + tag + ">");
  source = source.replace(/<[a-z][\w-]*\b[^>]*\bdata-i18n-aria="([^"]+)"[^>]*>/gi,
    (tag, key) => aria(tag, key));

  const languageNames = { "zh-CN": "languageNameZhCn", "zh-TW": "languageNameZhTw", en: "languageNameEn", ja: "languageNameJa" };
  source = source.replace(/(<select\b[^>]*\bid="language-select"[^>]*>)([\s\S]*?)(<\/select>)/g,
    (_match, start, content, end) => start + content.replace(/(<option\b[^>]*\bvalue="([^"]+)"[^>]*>)[^<]*(<\/option>)/g,
      (_option, opening, language, closing) => {
        if (!languageNames[language]) throw new Error("Unknown language option: " + language);
        return opening + text(languageNames[language]) + closing;
      }) + end);

  if (relative === "src/app/sidepanel/index.html") {
    source = source.replace(/(<title>)[^<]*(<\/title>)/, (_match, start, end) => start + text("appName") + end);
    const headingKeys = { "panel-title": "timeDisplay", "panel-subtitle": "timeSubtitle" };
    source = source.replace(/<([a-z][\w-]*)\b([^>]*\bid="(panel-title|panel-subtitle)"[^>]*)>[^<]*<\/\1>/gi,
      (_match, tag, attributes, id) => "<" + tag + attributes + ">" + text(headingKeys[id]) + "</" + tag + ">");
    source = source.replace(/<button\b[^>]*\bid="close-button"[^>]*>/g, tag => aria(tag, "close"));
    source = source.replace(/<nav\b[^>]*\bclass="time-dock"[^>]*>/g, tag => aria(tag, "appName"));
    const routes = { time: "timeDisplay", titles: "titleOrganization", favorites: "favorites", bookmarks: "bookmarks",
      search: "globalSearch", export: "export", settings: "settings" };
    source = source.replace(/<button\b[^>]*\bdata-route="([^"]+)"[^>]*>/g, (tag, route) => {
      if (!routes[route]) throw new Error("Unknown navigation route: " + route);
      return aria(tag, routes[route]);
    });
  }
  return source;
}

function buildOutputs() {
  const { strings, pageLabels, themeNames } = loadCatalogs();
  const translator = [
    "export function createTranslator(language) {",
    "  const dictionary = Object.hasOwn(STRINGS, language) ? STRINGS[language] : STRINGS.en;",
    "  return (key, values = {}) => {",
    "    const template = dictionary[key] || STRINGS.en[key] || key;",
    "    return Object.entries(values).reduce(",
    "      (text, [name, value]) => text.replaceAll(\`{\${name}}\`, String(value)),",
    "      template,",
    "    );",
    "  };",
    "}",
    "",
  ].join("\n");
  const moduleSource = HEADER
    + "export const STRINGS = Object.freeze(" + javascriptObject(strings) + ");\n\n"
    + "// 主题选择器仅消费这份生成映射；主题名称同样只在 settings.json 编辑。\n"
    + "export const THEME_NAMES = Object.freeze(" + javascriptObject(themeNames) + ");\n\n"
    + translator;
  const pageSource = HEADER
    + "(function initTidyMessages(global) {\n  \"use strict\";\n"
    + "  const pageLabels = Object.freeze(" + javascriptObject(pageLabels) + ");\n"
    + "  for (const labels of Object.values(pageLabels)) Object.freeze(labels);\n"
    + "  global.TidyMessages = Object.freeze({ pageLabels });\n"
    + "})(globalThis);\n";
  const outputs = new Map([
    ["src/messages/i18n.js", moduleSource],
    ["src/messages/page-runtime.js", pageSource],
  ]);
  for (const file of FALLBACK_FILES) {
    outputs.set(file, synchronizeFallbacks(fs.readFileSync(path.join(ROOT, file), "utf8"), file, strings["zh-CN"]));
  }
  return outputs;
}

function main() {
  const check = process.argv.includes("--check");
  const mismatches = [];
  for (const [relative, expected] of buildOutputs()) {
    const file = path.join(ROOT, relative);
    if (check) {
      if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== expected) mismatches.push(relative);
    } else {
      fs.writeFileSync(file, expected);
      console.log("Generated " + relative);
    }
  }
  if (mismatches.length) throw new Error("Generated message files are stale; run npm run build:messages: " + mismatches.join(", "));
  if (check) console.log("Message catalogs and generated runtimes are synchronized.");
}

module.exports = { GROUPS, LANGUAGES, FALLBACK_FILES, loadRetiredKeys, loadCatalogs, buildOutputs, synchronizeFallbacks };
if (require.main === module) main();
