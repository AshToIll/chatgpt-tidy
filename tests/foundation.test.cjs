const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");

function loadClassic(path, globals = {}) {
  const context = vm.createContext({
    URL,
    Date,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    JSON,
    setTimeout,
    clearTimeout,
    ...globals,
  });
  vm.runInContext(fs.readFileSync(path, "utf8"), context, { filename: path });
  return context;
}

const protocolContext = loadClassic("src/platform/protocol.js", {
  crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
});
const protocol = protocolContext.TidyProtocol;
assert.equal(protocol.VERSION, "tidy.protocol.v1");
const request = protocol.request(protocol.Type.GET_SNAPSHOT, { test: true });
assert.equal(protocol.isRequest(request, protocol.Type.GET_SNAPSHOT), true);
assert.equal(protocol.isResponse(protocol.response(request, { ok: true }), request.requestId), true);
assert.equal(protocol.failure(request, protocol.ErrorCode.INTERNAL_ERROR, "boom").ok, false);

const routeContext = loadClassic("src/platform/chatgpt/route.js", {
  TidySnapshot: loadClassic("src/platform/snapshot.js").TidySnapshot,
  location: { href: "https://chatgpt.com/", origin: "https://chatgpt.com" },
});
const route = routeContext.TidyChatgptRoute;
assert.deepEqual(
  JSON.parse(JSON.stringify(route.parse("https://chatgpt.com/c/abc-123"))),
  {
    supported: true,
    href: "https://chatgpt.com/c/abc-123",
    pathname: "/c/abc-123",
    kind: "conversation",
    conversationId: "abc-123",
    projectId: null,
    identityStatus: "stable",
  },
);
const projectRoute = route.parse("https://chatgpt.com/g/g-p-deadbeef/c/conversation-1");
assert.equal(projectRoute.kind, "project-conversation");
assert.equal(projectRoute.projectId, "g-p-deadbeef");
assert.equal(projectRoute.conversationId, "conversation-1");
const draftRoute = route.parse("https://chatgpt.com/c/WEB%3Atemporary-id");
assert.equal(draftRoute.conversationId, "WEB:temporary-id");
assert.equal(draftRoute.identityStatus, "draft");

const snapshotContext = loadClassic("src/platform/snapshot.js");
const snapshotContract = snapshotContext.TidySnapshot;
const validSnapshot = {
  schemaVersion: snapshotContract.VERSION,
  capturedAt: new Date().toISOString(),
  appearance: { colorScheme: "light", source: "test", status: "available", surface: { value: "rgb(255, 255, 255)", source: "test", status: "available" } },
  route: { pathname: "/c/abc" },
  conversation: {
    conversationId: "abc",
    draftId: null,
    identityStatus: "stable",
    bindingStatus: "bound",
    title: { value: "Title", source: "dom", status: "available" },
    createdAt: { value: null, source: null, status: "missing" },
    updatedAt: { value: null, source: null, status: "missing" },
  },
  sidebarConversations: [],
  messages: [
    {
      messageId: "message-1",
      idStatus: "stable",
      presentationStatus: "formal",
      role: "user",
      timestamp: { value: null, source: null, status: "missing" },
      excerpt: { value: "Hello", source: "test", status: "available" },
      order: { index: 0 },
      locator: { strategy: "data-message-id", value: "message-1" },
    },
  ],
};
assert.deepEqual(JSON.parse(JSON.stringify(snapshotContract.validate(validSnapshot))), { valid: true, errors: [] });
assert.equal(snapshotContract.validate({}).valid, false);

const manifest = JSON.parse(fs.readFileSync("src/manifest.json", "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.minimum_chrome_version, "116");
assert.equal(manifest.action.default_popup, undefined);
assert.equal(manifest.side_panel, undefined);
assert.equal(manifest.background.service_worker, "app/background/service-worker.js");
assert.ok(manifest.permissions.includes("sidePanel"));
assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*"]);
assert.ok(manifest.content_scripts.every((entry) =>
  JSON.stringify(entry.matches) === JSON.stringify(["https://chatgpt.com/*"]),
));
assert.ok(!manifest.content_scripts.flatMap((entry) => entry.js).includes("main.js"));
assert.ok(!manifest.content_scripts.flatMap((entry) => entry.js).includes("bridge.js"));
const mainWorldEntry = manifest.content_scripts.find((entry) => entry.world === "MAIN");
assert.deepEqual(mainWorldEntry.js, ["app/page/main-world.bundle.js"]);
const isolatedEntry = manifest.content_scripts.find((entry) => !entry.world);
assert.ok(isolatedEntry.js.includes("platform/time-format.js"));
assert.ok(isolatedEntry.js.includes("platform/ui/dom-ownership.js"));
assert.ok(isolatedEntry.js.includes("features/time/chatgpt/time-presentation.js"));
assert.equal(manifest.web_accessible_resources, undefined);
for (const legacyPath of [
  "src/main.js",
  "src/bridge.js",
  "src/popup.html",
  "src/popup.js",
  "src/utils.js",
  "src/assets/icon.png",
]) {
  assert.equal(fs.existsSync(legacyPath), false, `${legacyPath} must not return to the production tree`);
}
const mainWorldBundle = fs.readFileSync("src/app/page/main-world.bundle.js", "utf8");
assert.equal(mainWorldBundle.includes("GENERATED FILE"), true);
// Feature-independent readers and publishers must ship before the MAIN
// composition root; an extracted owner left out of the bundle is not wired.
const mainWorldOwners = [
  "platform/chatgpt/native-appearance.js",
  "platform/chatgpt/native-snapshot-reader.js",
  "platform/chatgpt/snapshot-metadata.js",
  "platform/chatgpt/snapshot-projection.js",
  "platform/chatgpt/snapshot-publisher.js",
  "platform/chatgpt/page-navigation-runtime.js",
  "app/page/request-router.js",
  "platform/chatgpt/native-observer.js",
  "app/page/main-world.js",
];
const bundledSources = [...mainWorldBundle.matchAll(/^\/\/ Source: src\/(.+)$/gm)].map(match => match[1]);
for (const path of ["platform/chatgpt/binding.js", "platform/ui/dom-ownership.js", ...mainWorldOwners]) {
  assert.equal(bundledSources.filter(source => source === path).length, 1, path + " is bundled exactly once");
}
for (const path of mainWorldOwners.slice(0, -1)) {
  assert.ok(bundledSources.indexOf(path) < bundledSources.indexOf("app/page/main-world.js"),
    path + " must be available when the MAIN composition root starts");
}
assert.equal(protocol.Type.ENSURE_CONVERSATION_RANGES, undefined);

const preferenceSource = fs.readFileSync("src/platform/preferences/preferences.js", "utf8");
const storageSchemaSource = fs.readFileSync("src/platform/storage/schema.js", "utf8");
const themeIds = Object.keys(loadClassic("src/platform/theme/theme.js").TidyTheme.THEMES);
assert.deepEqual(themeIds, [
  "mist-indigo", "sage", "wineberry", "smoke-purple", "amber", "terracotta", "mist-cyan", "graphite",
]);
assert.match(preferenceSource, /STORAGE_BOUNDARIES\.sync\.preferences/);
assert.doesNotMatch(preferenceSource, /bookmark:/);
assert.match(storageSchemaSource, /tidy\.v1\.preferences/);
assert.doesNotMatch(storageSchemaSource, /tidy\.v1\.local/);
assert.match(storageSchemaSource, /chatgpt-tidy-storage/);
assert.match(storageSchemaSource, /bookmark-groups/);
// 检查实际存储契约，而不是强迫注释保留某一句英文。
test("sync storage exposes only the global preference key", async () => {
  const { STORAGE_BOUNDARIES } = await import("../src/platform/storage/schema.js");
  assert.deepEqual(STORAGE_BOUNDARIES.sync, { preferences: "tidy.v1.preferences" });
  assert.equal(Object.hasOwn(STORAGE_BOUNDARIES, "local"), false);
});

const panelHtml = fs.readFileSync("src/app/sidepanel/index.html", "utf8");
assert.match(panelHtml, /class="time-dock"/);
assert.deepEqual(
  [...panelHtml.matchAll(/data-route="([^"]+)"/g)].map((match) => match[1]),
  ["time", "titles", "favorites", "bookmarks", "search", "export", "settings"],
);
const titlesDockButton = panelHtml.match(/<button\b[^>]*data-route="titles"[^>]*>/)?.[0];
assert.ok(titlesDockButton, "Title organization has its own production Dock route");
assert.doesNotMatch(titlesDockButton, /\bdisabled\b/, "Title organization is no longer a disabled placeholder");
assert.doesNotMatch(panelHtml, /data-route="title-time"/, "The retired placeholder route has no alias");
assert.doesNotMatch(panelHtml, /class="dock"/);

console.log("foundation assertions passed");
