const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const root = path.resolve(__dirname, "..");
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const messages = readJson("src/messages/catalogs/export.json").messages;
const expected = {
  "zh-CN": "图片与附件",
  "zh-TW": "圖片與附件",
  en: "Images and attachments",
  ja: "画像と添付ファイル",
};

// The option describes media content, not PDF embedding; keep it neutral for every format.
test("export media option uses the approved neutral label in every language", () => {
  assert.deepEqual(messages.exportMediaAttachments, expected);
});

test("export media summary keeps its independent concise wording", () => {
  assert.deepEqual(messages.exportMediaShort, {
    "zh-CN": "图片与附件", "zh-TW": "圖片與附件", en: "Media", ja: "画像と添付",
  });
});

test("neutral media wording has exact approvals anchored to the historical baseline", () => {
  const approval = readJson("tests/fixtures/message-copy-amendments.json");
  const baseline = readJson("docs/current/BEHAVIOR_BASELINE.json").stringHashes;
  const entries = approval.amendments.filter(entry => entry.key === "exportMediaAttachments");
  assert.equal(entries.length, Object.keys(expected).length);
  for (const [language, after] of Object.entries(expected)) {
    const matches = entries.filter(entry => entry.language === language);
    assert.equal(matches.length, 1, language + " must have one precise approval");
    const entry = matches[0];
    assert.equal(entry.after, after);
    assert.equal(createHash("sha256").update(entry.before).digest("hex"), baseline[language + ":exportMediaAttachments"]);
    assert.ok(entry.reason.trim());
  }
});
