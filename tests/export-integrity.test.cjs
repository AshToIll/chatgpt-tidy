const { exportMessages } = require('./helpers/export-i18n.cjs');
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");
const JSZip = require("../src/vendor/jszip-3.10.1.min.js");

function runtime() {
  const context = vm.createContext({
    URL, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, setTimeout, clearTimeout, JSZip,
  });
  for (const module of ["i18n", "assets", "normalize", "plan", "inline-content", "serializers", "download"]) {
    vm.runInContext(fs.readFileSync(path.join(projectRoot, "src/features/export/engine", `${module}.js`), "utf8"), context);
  }
  context.TidyExport.ensureExportDependencies = async () => {};
  return context.TidyExport;
}

function conversation(id, title = id, blocks = [{ type: "paragraph", text: `Body of ${id}` }]) {
  return {
    id, title, createdAt: "2026-09-10T00:00:00Z", updatedAt: "2026-09-10T00:01:00Z", resources: [],
    messages: [{ id: `${id}-message`, messageNumber: 1, role: "assistant", timestamp: "2026-09-10T00:01:00Z",
      segments: [{ type: "content", sourceMessageId: `${id}-message`, timestamp: "2026-09-10T00:01:00Z", blocks }] }],
  };
}

function bookmark(id, conversationId, messageId = `${conversationId}-message`) {
  return { id, conversationId, messageId, bookmarkedAt: "2026-09-10T01:00:00Z", groupId: null };
}

function normalized(api, conversations, bookmarks = []) {
  return api.normalizeExportData({ conversations, bookmarks });
}

test("every same-title conversation survives the real ZIP, including an existing numbered title", async () => {
  const api = runtime();
  const conversations = [conversation("one", "A"), conversation("two", "A"), conversation("three", "A (2)"),
    conversation("four", "a (2)"), conversation("five", "Ａ")];
  const plan = api.buildExportPlan({ messages: exportMessages(), mode: "batch", format: "json", data: normalized(api, conversations),
    conversationIds: conversations.map((item) => item.id) });
  assert.equal(new Set(plan.files.map((file) => file.path.toLowerCase())).size, conversations.length);
  const generated = await api.generateExport(plan);
  const zip = await JSZip.loadAsync(generated.bytes);
  const filePaths = Object.keys(zip.files).filter((entry) => !zip.files[entry].dir);
  assert.equal(filePaths.length, conversations.length);
  const exportedIds = [];
  for (const filePath of filePaths) exportedIds.push(JSON.parse(await zip.file(filePath).async("string")).conversation.id);
  assert.deepEqual(exportedIds.sort(), conversations.map((item) => item.id).sort());
});

test("the ZIP writer rejects a duplicate final path before loading dependencies or assets", async () => {
  const api = runtime();
  const plan = api.buildExportPlan({ messages: exportMessages(), mode: "batch", format: "json",
    data: normalized(api, [conversation("one"), conversation("two")]), conversationIds: ["one", "two"] });
  plan.files[1].path = plan.files[0].path.toUpperCase();
  let dependencyReads = 0;
  api.ensureExportDependencies = async () => { dependencyReads += 1; };
  await assert.rejects(api.generateExport(plan), (error) => error.code === "EXPORT_PATH_COLLISION");
  assert.equal(dependencyReads, 0);
});

test("a selected missing bookmark, conversation or active-branch message cannot silently disappear", () => {
  const api = runtime();
  for (const invalid of [null, bookmark("missing", "unread"), bookmark("missing", "one", "old-branch")]) {
    const data = normalized(api, [conversation("one")], [bookmark("good", "one"), ...(invalid ? [invalid] : [])]);
    assert.throws(() => api.buildExportPlan({ messages: exportMessages(), mode: "batch", format: "json", data, bookmarkIds: ["good", "missing"] }),
      (error) => error.code === "EXPORT_SELECTION_INCOMPLETE"
        && error.missingBookmarks.some((item) => item.bookmarkId === "missing"));
  }
});

test("content switches cannot silently remove a selected media-only bookmark", () => {
  const api = runtime();
  const media = conversation("media", "Image", [{ type: "image", resourceId: "image", alt: "Image" }]);
  media.resources = [{ id: "image", type: "image", name: "image.png", src: "https://example.test/image.png" }];
  const data = normalized(api, [conversation("one"), media], [bookmark("good", "one"), bookmark("image", "media")]);
  assert.throws(() => api.buildExportPlan({ messages: exportMessages(), mode: "batch", format: "json", data,
    bookmarkIds: ["good", "image"], options: { mediaAttachments: false } }),
  (error) => error.code === "EXPORT_SELECTION_INCOMPLETE"
    && error.missingBookmarks.some((item) => item.bookmarkId === "image" && item.reason === "content-excluded"));
});

test("mixed-export Markdown ZIP contains only text files and readable media links without reading image bytes", async () => {
  const api = runtime();
  const item = conversation("image-conversation", "Image", [{ type: "image", resourceId: "image-1", alt: "test" }]);
  item.resources = [{ id: "image-1", type: "image", name: "test.png", mimeType: "image/png",
    src: "https://example.test/test.png", alt: "test" }];
  const plan = api.buildExportPlan({ messages: exportMessages(), mode: "batch", format: "markdown", data: normalized(api, [item], [bookmark("image", item.id)]),
    conversationIds: [item.id], bookmarkIds: ["image"], options: { mediaAttachments: true } });
  let reads = 0;
  const generated = await api.generateExport(plan, { assetLoader: async () => { reads++; throw Error('Markdown must not read assets'); } });
  const zip = await JSZip.loadAsync(generated.bytes);
  for (const file of plan.files) {
    const markdown = await zip.file(file.path).async("string");
    assert.match(markdown, /test/);
    assert.ok(markdown.includes(item.resources[0].src));
    assert.doesNotMatch(markdown, /!\[|assets\//);
  }
  assert.equal(reads, 0, "Markdown does not download images in either output subtree");
  assert.equal(plan.assets?.length || 0, 0);
  assert.deepEqual(Object.values(zip.files).filter(file => !file.dir).map(file => file.name).sort(), Array.from(plan.files, file => file.path).sort());
});

test("the production normalization API has no fixture-named compatibility alias", () => {
  const api = runtime();
  assert.equal(typeof api.normalizeExportData, "function");
  assert.equal(Object.hasOwn(api, "normalizeFixtureData"), false);
});
