const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const { GROUPS, LANGUAGES, loadRetiredKeys, loadCatalogs, buildOutputs } = require("../tools/build-messages.cjs");
const ROOT = path.resolve(__dirname, "..");
const read = relative => fs.readFileSync(path.join(ROOT, relative), "utf8");
const moduleReady = import(pathToFileURL(path.join(ROOT, "src/messages/i18n.js")).href);

// 只在测试中保存基线指纹；生产文案仍只有 catalogs 一份手写来源。
const PAGE_BASELINE = Object.freeze({
  favorites: "1be58f2a2b5d7600b1476ec717cde50919fdc3a2940cb073725a6aff9c674aef",
  bookmarks: "8d9ff8fd65cb56a20db8c9be27dc0a1bffb0ba1c19edaecf2c80f9ae98e0357e",
  time: "31385e5dee7e47c4f3ee2f35979410cabf4b115e4627cb4f79550c41930159d6",
});
// These 20 catalog aliases already existed at the version checkpoint. Their
// bytes remain independently locked by PAGE_BASELINE, THEME_BASELINE and the
// autonym assertions below; they are not new product copy approvals.
const ORIGINAL_CATALOG_ALIASES = new Set([
  "pageFavoriteAdd", "pageFavoriteRemove", "pageFavoriteFailed", "pageBookmarkAdd",
  "pageBookmarkRemove", "pageBookmarkOpen", "pageBookmarkFailed", "pageBookmarkOpenFailed",
  "themeNameMistIndigo", "themeNameSage", "themeNameWineberry", "themeNameSmokePurple",
  "themeNameAmber", "themeNameTerracotta", "themeNameMistCyan", "themeNameGraphite",
  "languageNameZhCn", "languageNameZhTw", "languageNameEn", "languageNameJa",
]);
const THEME_BASELINE = "4755977b5e0d2019981644960d7ceccb8869712ea3b4d580791c0686be6c98ab";
function canonical(value) {
  return value && typeof value === "object"
    ? JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, JSON.parse(canonical(child))])))
    : JSON.stringify(value);
}
const sha = value => crypto.createHash("sha256").update(value).digest("hex");

test("message catalogs have one owner per key and precisely common plus seven feature groups", () => {
  assert.deepEqual(GROUPS, ["common", "time", "titles", "favorites", "bookmarks", "search", "export", "settings"]);
  const { strings } = loadCatalogs(); // 检查重复键、无效语言、无效绑定。
  const owners = new Map();
  for (const group of GROUPS) {
    const catalog = JSON.parse(read("src/messages/catalogs/" + group + ".json"));
    assert.ok(catalog.description.length > 0);
    assert.ok(Object.keys(catalog.messages).length > 0);
    for (const [key, translations] of Object.entries(catalog.messages)) {
      assert.equal(owners.has(key), false, "duplicate message: " + key);
      owners.set(key, group);
      for (const [language, text] of Object.entries(translations)) assert.equal(strings[language][key], text);
    }
  }
});

test("all generated message runtimes exactly match the unique catalogs", () => {
  for (const [file, expected] of buildOutputs()) assert.equal(read(file), expected, file + " is stale");
});

// Explicitly approved copy edits never replace the historical fingerprint set.
// The fixture records exact before/after bytes and a human-readable reason.
function validateCopyAmendments(approval, baseline, strings) {
  assert.equal(approval.schemaVersion, 1);
  assert.ok(Array.isArray(approval.amendments));
  assert.ok(Array.isArray(approval.newKeys));
  const changed = new Map(), additions = new Set();
  const retired = new Set(loadRetiredKeys().map(entry => entry.key));
  for (const entry of approval.amendments) {
    assert.deepEqual(Object.keys(entry).sort(), ["after", "before", "key", "language", "reason"]);
    assert.ok(LANGUAGES.includes(entry.language));
    assert.equal(typeof entry.key, "string");
    assert.equal(retired.has(entry.key), false, entry.key + " cannot be amended after retirement");
    assert.equal(typeof entry.before, "string");
    assert.equal(typeof entry.after, "string");
    assert.ok(typeof entry.reason === "string" && entry.reason.trim().length > 0);
    const identity = entry.language + ":" + entry.key;
    assert.ok(Object.hasOwn(baseline, identity), identity + " is not an original entry");
    assert.equal(changed.has(identity), false, identity + " has duplicate approval");
    assert.equal(sha(entry.before), baseline[identity], identity + " old bytes do not match baseline");
    assert.notEqual(entry.before, entry.after, identity + " is not an amendment");
    assert.equal(strings[entry.language][entry.key], entry.after, identity + " differs from exact approved copy");
    changed.set(identity, entry);
  }
  const originalKeys = new Set([...ORIGINAL_CATALOG_ALIASES, ...Object.keys(baseline).map(identity => identity.slice(identity.indexOf(":") + 1))]);
  for (const entry of approval.newKeys) {
    assert.deepEqual(Object.keys(entry).sort(), ["catalog", "key", "reason", "translations"]);
    assert.ok(GROUPS.includes(entry.catalog));
    assert.ok(typeof entry.reason === "string" && entry.reason.trim().length > 0);
    assert.equal(originalKeys.has(entry.key), false, entry.key + " cannot replace an original key");
    assert.equal(additions.has(entry.key), false, entry.key + " has duplicate new-key approval");
    assert.deepEqual(Object.keys(entry.translations).sort(), [...LANGUAGES].sort());
    const catalog = JSON.parse(read("src/messages/catalogs/" + entry.catalog + ".json"));
    assert.deepEqual(catalog.messages[entry.key], entry.translations, entry.key + " catalog owner or bytes differ");
    for (const language of LANGUAGES) {
      assert.equal(typeof entry.translations[language], "string");
      assert.equal(strings[language][entry.key], entry.translations[language]);
    }
    additions.add(entry.key);
  }
  for (const language of LANGUAGES) for (const key of Object.keys(strings[language])) {
    assert.ok(originalKeys.has(key) || additions.has(key), language + ":" + key + " has no explicit new-key approval");
  }
  return changed;
}

test("all 2268 original language entries retain their hashes with exact amendment and retirement approvals", async () => {
  const { STRINGS } = await moduleReady;
  const baseline = JSON.parse(read("docs/current/BEHAVIOR_BASELINE.json")).stringHashes;
  assert.equal(Object.keys(baseline).length, 2268);
  const approval = JSON.parse(read("tests/fixtures/message-copy-amendments.json"));
  const changes = validateCopyAmendments(approval, baseline, STRINGS);
  const retired = new Map(loadRetiredKeys().map(entry => [entry.key, entry]));
  for (const entry of retired.values()) for (const language of LANGUAGES) {
    assert.equal(entry.beforeHashes[language], baseline[language + ":" + entry.key], entry.key + " retirement must match the original hash");
  }
  for (const [identity, hash] of Object.entries(baseline)) {
    const split = identity.indexOf(":");
    const language = identity.slice(0, split), key = identity.slice(split + 1);
    if (retired.has(key)) {
      assert.equal(Object.hasOwn(STRINGS[language], key), false, identity + " retired entry reappeared");
      continue;
    }
    assert.equal(typeof STRINGS[language][key], "string", identity + " disappeared");
    const amendment = changes.get(identity);
    assert.equal(sha(STRINGS[language][key]), amendment ? sha(amendment.after) : hash, identity + " changed");
  }
  // Preserve every original missing-translation fallback, even for approved text edits.
  const oldKeys = new Set(Object.keys(baseline).map(identity => identity.slice(identity.indexOf(":") + 1)));
  for (const language of LANGUAGES) for (const key of oldKeys) {
    assert.equal(Object.hasOwn(STRINGS[language], key), !retired.has(key) && Object.hasOwn(baseline, language + ":" + key));
  }
});

test("copy amendment audit rejects false before bytes, undeclared edits and duplicate approvals", () => {
  const identity = "en:created", baseline = { [identity]: sha("Created") };
  const entry = { language: "en", key: "created", before: "Created", after: "Approved", reason: "Synthetic exact-copy audit" };
  const strings = Object.fromEntries(LANGUAGES.map(language => [language, { created: "Approved" }]));
  const approval = { schemaVersion: 1, amendments: [entry], newKeys: [] };
  assert.equal(validateCopyAmendments(approval, baseline, strings).size, 1);
  assert.throws(() => validateCopyAmendments({ ...approval, amendments: [{ ...entry, before: "Forged" }] }, baseline, strings));
  assert.throws(() => validateCopyAmendments({ ...approval, amendments: [entry, entry] }, baseline, strings));
  assert.throws(() => validateCopyAmendments(approval, baseline, { ...strings, en: { created: "Unapproved" } }));
  assert.throws(() => validateCopyAmendments(approval, baseline, { ...strings, en: { created: "Approved", accidentalNewKey: "Unapproved" } }));
});

test("classic page runtime retains all favorites bookmarks and time labels", () => {
  const context = vm.createContext({});
  vm.runInContext(read("src/messages/page-runtime.js"), context);
  const pageLabels = context.TidyMessages.pageLabels;
  for (const [group, hash] of Object.entries(PAGE_BASELINE)) {
    assert.equal(sha(canonical(pageLabels[group])), hash, group);
    assert.equal(Object.isFrozen(pageLabels[group]), true, group + " dictionary remains immutable");
  }
  assert.deepEqual(JSON.parse(JSON.stringify(pageLabels)), loadCatalogs().pageLabels);
});

test("theme labels and language autonyms are centralized without changing text", async () => {
  const { STRINGS, THEME_NAMES } = await moduleReady;
  assert.equal(sha(canonical(THEME_NAMES)), THEME_BASELINE);
  const expected = { languageNameZhCn: "简体中文", languageNameZhTw: "繁體中文", languageNameEn: "English", languageNameJa: "日本語" };
  for (const language of LANGUAGES) for (const [key, text] of Object.entries(expected)) assert.equal(STRINGS[language][key], text);
});

test("translator fallback and placeholder replacement preserve the original contract", async () => {
  const { STRINGS, createTranslator } = await moduleReady;
  const unknown = "__architecture_test_missing_key__";
  for (const language of [...LANGUAGES, "unknown-language", undefined, "constructor"]) {
    const dictionary = Object.hasOwn(STRINGS, language) ? STRINGS[language] : STRINGS.en;
    for (const key of ["exportPlanFiles", "backupCounts", "created", unknown]) {
      const values = { count: 7, favorites: 2, bookmarks: 3 };
      const expected = Object.entries(values).reduce((text, [name, value]) =>
        text.replaceAll("{" + name + "}", String(value)), dictionary[key] || STRINGS.en[key] || key);
      assert.equal(createTranslator(language)(key, values), expected);
    }
  }
});

test("generated ESM dictionary stays directly loadable by existing isolated VM fixtures", () => {
  const context = vm.createContext({});
  vm.runInContext(read("src/messages/i18n.js").replace(/^export /gm, "") + "\nthis.result = createTranslator('en')('created');", context);
  assert.equal(context.result, "Created");
});

test("webpage presentations have no privately maintained language dictionaries", () => {
  for (const group of ["favorites", "bookmarks", "time"]) {
    const source = read("src/features/" + group + "/chatgpt/" + group + "-presentation.js");
    assert.ok(source.includes("global.TidyMessages.pageLabels." + group));
    assert.doesNotMatch(source, /"zh-(?:CN|TW)"\s*:\s*\{/);
  }
});

test("template fallback synchronization replaces stale copy while preserving layout and attributes", () => {
  const { synchronizeFallbacks } = require("../tools/build-messages.cjs");
  const strings = loadCatalogs().strings["zh-CN"];
  const snippet = '<label class="unchanged" data-i18n="created">旧字</label>'
    + '<section class="unchanged" aria-label="旧字" data-i18n-aria="updated"></section>';
  const expected = '<label class="unchanged" data-i18n="created">' + strings.created + '</label>'
    + '<section class="unchanged" aria-label="' + strings.updated + '" data-i18n-aria="updated"></section>';
  assert.equal(synchronizeFallbacks(snippet, "template.js", strings), expected);
  assert.equal(synchronizeFallbacks(expected, "template.js", strings), expected, "synchronization is idempotent");
  assert.equal(synchronizeFallbacks('<span data-i18n="sample">old</span>', "template.js", { sample: '<&>' }),
    '<span data-i18n="sample">&lt;&amp;&gt;</span>', "catalog text cannot become template markup");
  assert.throws(() => synchronizeFallbacks('<span data-i18n="notRegistered">old</span>', "template.js", strings),
    /Missing HTML fallback message/);
});
