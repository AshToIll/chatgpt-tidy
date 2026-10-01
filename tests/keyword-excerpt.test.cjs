const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const context = vm.createContext({});
const source = fs.readFileSync(path.resolve(__dirname, "../src/features/search/ui/keyword-excerpt.js"), "utf8");
vm.runInContext(source.replace(/^export /gm, ""), context);
const { createKeywordMatcher, keywordExcerpt } = context;
const ELLIPSIS = "\u2026";

function assertSourceWindow(original, excerpt) {
  const window = excerpt.replace(/^\u2026/u, "").replace(/\u2026$/u, "");
  assert.ok(original.includes(window), "an excerpt must be a contiguous, unmodified source window");
  assert.equal(window, window.trim(), "only edge whitespace may be removed");
  assert.equal(excerpt.isWellFormed(), true, "window boundaries cannot split a surrogate pair");
}

test("keyword matching is literal, case insensitive, Unicode aware and longest-first", () => {
  const matcher = createKeywordMatcher("code CODEX c++ [a] a.b");
  assert.equal(matcher.flags, "giu");
  assert.deepEqual(Array.from("CODEX code C++ [a] a.b axb".matchAll(matcher), match => match[0]),
    ["CODEX", "code", "C++", "[a]", "a.b"]);
  assert.equal(createKeywordMatcher("k").test("\u212a"), true);
});

test("empty queries have no matcher and preserve the exact original preview", () => {
  const original = "  original opening\n" + "body ".repeat(100) + "  ";
  for (const query of ["", " \n\t "]) {
    assert.equal(createKeywordMatcher(query), null);
    assert.equal(keywordExcerpt(original, query), original);
  }
});

test("unmatched terms preserve the exact original preview without unnecessary truncation", () => {
  const original = "  original opening\n" + "body ".repeat(100) + "  ";
  assert.equal(keywordExcerpt(original, "needle"), original);
  assert.equal(keywordExcerpt(original, "b.dy"), original, "query metacharacters are not regex syntax");
});

test("short matching previews stay intact without synthetic ellipses", () => {
  const original = "Before CODEX, the exact message follows.";
  assert.equal(keywordExcerpt(original, "codex"), original);
});

test("a late English keyword is moved near the start with both omission markers", () => {
  const original = "Unrelated opening sentence. ".repeat(20)
    + "Relevant context includes CODEX and its nearby explanation. "
    + "More distant text. ".repeat(30);
  const excerpt = keywordExcerpt(original, "codex");
  assert.ok(excerpt.startsWith(ELLIPSIS));
  assert.ok(excerpt.endsWith(ELLIPSIS));
  assert.ok(excerpt.indexOf("CODEX") <= 29, "the matched term must not hide behind the old opening");
  assert.ok(excerpt.length <= 182);
  assert.ok(excerpt.includes("nearby explanation"));
  assertSourceWindow(original, excerpt);
});

test("Chinese sentence context keeps a late literal keyword visible", () => {
  const keyword = "\u5173\u952e\u5e27";
  const original = "\u8fd9\u662f\u65e0\u5173\u7684\u5f00\u573a\u5185\u5bb9\u3002".repeat(30)
    + "\u5177\u4f53\u9700\u8981\u8c03\u6574" + keyword + "\u7684\u65f6\u95f4\u548c\u4f4d\u7f6e\u3002"
    + "\u8fd9\u662f\u540e\u7eed\u8bf4\u660e\u3002".repeat(30);
  const excerpt = keywordExcerpt(original, keyword);
  assert.ok(excerpt.startsWith(ELLIPSIS));
  assert.ok(excerpt.endsWith(ELLIPSIS));
  assert.ok(excerpt.indexOf(keyword) <= 29);
  assert.ok(excerpt.length <= 182);
  assertSourceWindow(original, excerpt);
});

test("beginning and ending matches only mark the source side that was omitted", () => {
  const beginning = "needle " + "following content ".repeat(40);
  const end = "earlier content ".repeat(40) + "needle";
  const first = keywordExcerpt(beginning, "needle");
  const last = keywordExcerpt(end, "needle");
  assert.ok(first.startsWith("needle"));
  assert.ok(first.endsWith(ELLIPSIS));
  assert.ok(last.startsWith(ELLIPSIS));
  assert.ok(last.endsWith("needle"));
  assertSourceWindow(beginning, first);
  assertSourceWindow(end, last);
});

test("first native-text match wins even when a later query term is longer", () => {
  const original = "opening ".repeat(40) + "first target " + "middle ".repeat(50) + "longer-second-target";
  const excerpt = keywordExcerpt(original, "longer-second-target first");
  assert.ok(excerpt.includes("first target"));
  assert.ok(!excerpt.includes("longer-second-target"));
  assertSourceWindow(original, excerpt);
});

test("multiple nearby query terms and literal punctuation remain in their original context", () => {
  const original = "intro ".repeat(50) + "C++ and [a] with a.b are exact terms. " + "tail ".repeat(50);
  const excerpt = keywordExcerpt(original, "c++ [a] a.b");
  assert.ok(excerpt.includes("C++ and [a] with a.b"));
  assert.deepEqual(Array.from(excerpt.matchAll(createKeywordMatcher("c++ [a] a.b")), match => match[0]),
    ["C++", "[a]", "a.b"]);
  assertSourceWindow(original, excerpt);
});

test("astral characters around the clipping boundaries stay well formed", () => {
  const original = "\u{1f680}".repeat(31) + "needle" + "\u{1f680}".repeat(31);
  const excerpt = keywordExcerpt(original, "needle", { maxLength: 31, leadingContext: 7 });
  assert.ok(excerpt.includes("needle"));
  assert.ok(excerpt.startsWith(ELLIPSIS));
  assert.ok(excerpt.endsWith(ELLIPSIS));
  assert.ok(excerpt.length <= 33);
  assertSourceWindow(original, excerpt);
});

test("an indivisible query term larger than the window falls back to the original preview", () => {
  const term = "x".repeat(200);
  const original = "opening " + term + " tail";
  assert.equal(keywordExcerpt(original, term), original);
});

test("explicit excerpt limits keep the complete matched term inside the chosen window", () => {
  const original = "prefix ".repeat(20) + "complete-keyword" + " following ".repeat(20);
  const excerpt = keywordExcerpt(original, "complete-keyword", { maxLength: 40, leadingContext: 10 });
  assert.ok(excerpt.includes("complete-keyword"));
  assert.ok(excerpt.indexOf("complete-keyword") <= 11);
  assert.ok(excerpt.length <= 42);
  assertSourceWindow(original, excerpt);
});

test("invalid excerpt parameters preserve the original preview", () => {
  const original = "opening ".repeat(50) + "needle " + "ending ".repeat(50);
  for (const options of [
    { maxLength: 0 }, { maxLength: -1 }, { maxLength: 1.5 }, { maxLength: Infinity },
    { leadingContext: -1 }, { leadingContext: NaN }, { leadingContext: 2.5 },
  ]) assert.equal(keywordExcerpt(original, "needle", options), original);
});

test("removing only edge whitespace does not imply missing source content", () => {
  const original = " ".repeat(40) + "needle" + " \n".repeat(40);
  assert.equal(keywordExcerpt(original, "needle", { maxLength: 20, leadingContext: 3 }), "needle");
});

test("sentence and word segmentation inspect only bounded context even for large native previews", () => {
  const inspectedLengths = [];
  const boundedContext = vm.createContext({ Intl: { Segmenter: class {
    constructor(...args) { this.segmenter = new Intl.Segmenter(...args); }
    segment(value) { inspectedLengths.push(value.length); return this.segmenter.segment(value); }
  } } });
  vm.runInContext(source.replace(/^export /gm, ""), boundedContext);
  const original = "opening ".repeat(20000) + "needle " + "ending ".repeat(20000);
  const excerpt = boundedContext.keywordExcerpt(original, "needle");
  assert.ok(excerpt.includes("needle"));
  assert.ok(inspectedLengths.length > 0);
  assert.ok(inspectedLengths.every(length => length <= 181),
    "segmentation must never walk the complete native preview");
  assertSourceWindow(original, excerpt);
});
