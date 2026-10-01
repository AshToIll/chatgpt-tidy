const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const read = (file) => fs.readFileSync(file, "utf8");
const htmlScripts = (file) => [...read(file).matchAll(/<script\b([^>]*?)\bsrc="([^"]+)"[^>]*>/g)]
  .map((match) => ({ file: new URL(match[2], `https://fixture.invalid/${file}`).pathname.slice(1),
    module: /type="module"/.test(match[1]) }));

// These are dependencies, not a universal script order. MAIN, ISOLATED and
// the Side Panel keep their different entry points and execution worlds.
const dependencies = {
  "src/platform/session/content/page-session.js": ["src/platform/session/shared/page-session.js"],
  "src/platform/session/chatgpt/page-session.js": ["src/platform/session/shared/page-session.js"],
  "src/platform/chatgpt/route.js": ["src/platform/snapshot.js"],
  "src/features/titles/chatgpt/titles.js": ["src/platform/snapshot.js"],
  "src/features/titles/chatgpt/title-sync.js": ["src/platform/snapshot.js", "src/platform/chatgpt/route.js"],
  "src/features/titles/model/title-dates.js": ["src/platform/time-format.js"],
  "src/platform/navigation/chatgpt/navigation-intent.js": ["src/platform/navigation/navigation-identity.js"],
  "src/platform/navigation/chatgpt/message-location.js": ["src/platform/navigation/navigation-identity.js"],
  "src/platform/navigation/chatgpt/message-navigation.js": ["src/platform/navigation/navigation-identity.js", "src/platform/navigation/chatgpt/message-location.js", "src/platform/chatgpt/message-dom.js"],
  "src/app/page/isolated.js": ["src/platform/session/shared/page-session.js", "src/platform/protocol.js", "src/platform/snapshot.js", "src/features/search/model/search.js", "src/platform/catalog/date-search.js", "src/features/export/model/export.js"],
  "src/platform/library/content/library-client.js": ["src/platform/protocol.js", "src/platform/library/library-hydration.js"],
  "src/features/time/chatgpt/time-presentation.js": ["src/platform/time-format.js", "src/platform/snapshot.js", "src/platform/chatgpt/message-dom.js", "src/platform/chatgpt/sidebar-dom.js"],
  "src/features/bookmarks/chatgpt/bookmarks-presentation.js": ["src/platform/chatgpt/message-dom.js", "src/platform/chatgpt/sidebar-dom.js"],
  "src/features/favorites/chatgpt/favorites-presentation.js": ["src/platform/chatgpt/sidebar-dom.js"],
  "src/platform/chatgpt/native-snapshot-reader.js": ["src/platform/chatgpt/sidebar-dom.js"],
};

// Pure contracts now belong to their feature/platform owner. Keep the real
// provider execution check without loading DOM or Chrome entrypoint effects.
const classicProviders = new Set([
  "src/features/export/model/export-job.js",
  "src/features/export/model/export-preview.js",
  "src/features/export/model/export.js",
  "src/features/search/model/search.js",
  "src/features/settings/model/library-backup-format.js",
  "src/features/titles/model/title-context.js",
  "src/features/titles/model/title-dates.js",
  "src/features/titles/model/title-rules.js",
  "src/messages/i18n.js",
  "src/platform/catalog/date-search.js",
  "src/platform/chatgpt/sidebar-dom.js",
  "src/platform/library/library-hydration.js",
  "src/platform/navigation/navigation-identity.js",
  "src/platform/navigation/panel-owner.js",
  "src/platform/protocol.js",
  "src/platform/session/shared/page-session.js",
  "src/platform/snapshot.js",
  "src/platform/theme/shared/toolbar-theme.js",
  "src/platform/theme/theme.js",
  "src/platform/time-format.js",
  "src/platform/ui/dom-ownership.js",
  "src/platform/ui/html.js",
]);

function verifyOrder(files) {
  assert.equal(new Set(files).size, files.length, "an entrypoint must not double-load a provider");
  for (const file of files) {
    assert.ok(fs.existsSync(file), `missing entrypoint resource: ${file}`);
    for (const dependency of dependencies[file] || []) {
      assert.ok(files.includes(dependency) && files.indexOf(dependency) < files.indexOf(file), `${dependency} must precede ${file}`);
    }
  }
}

const manifest = JSON.parse(read("src/manifest.json"));
const mainSources = [...read("src/app/page/main-world.bundle.js").matchAll(/^\/\/ Source: (.+)$/gm)].map((match) => match[1]);
const isolated = manifest.content_scripts.find((entry) => entry.world !== "MAIN").js.map((file) => `src/${file}`);
const panel = htmlScripts("src/app/sidepanel/index.html").filter((entry) => !entry.module).map((entry) => entry.file);

for (const [name, files] of [["MAIN bundle", mainSources], ["ISOLATED manifest", isolated], ["Side Panel HTML", panel]]) {
  test(`${name} resolves its own ordered classic dependencies`, () => {
    assert.ok(files.length > 5);
    verifyOrder(files);
    const context = vm.createContext({ URL, Intl, TextEncoder });
    // Execute the actual shared prefix instead of providing mocks for globals.
    // DOM/Chrome effects are covered by their browser and worker suites.
    for (const file of files.filter((file) => classicProviders.has(file))) vm.runInContext(read(file), context, { filename: file });
    assert.equal(context.TidySnapshot.canonicalConversationPath("/c/one", "one"), "/c/one");
    assert.equal(context.TidySnapshot.canonicalConversationPath("/g/custom/c/one", "one"), null);
    if (files.includes("src/features/titles/model/title-dates.js")) {
      assert.ok(context.TidyTitleDates);
      assert.equal(context.TidyTimeFormat.formatDate("2026-09-16T12:00:00Z", { dateFormat: "iso", timeZone: "UTC", includeYear: true }), "2026-09-16");
    }
  });
}

test("browser and preview HTML fixtures close their real script dependencies", () => {
  for (const directory of ["tests/browser", "tests/fixtures"]) {
    for (const name of fs.readdirSync(directory).filter((name) => name.endsWith(".html"))) {
      const entries = htmlScripts(`${directory}/${name}`);
      for (const entry of entries) assert.ok(fs.existsSync(entry.file), entry.file);
      verifyOrder(entries.filter((entry) => !entry.module).map((entry) => entry.file));
    }
  }
});

test("load-order guard rejects the actual missing-provider and reversed-order regressions", () => {
  assert.throws(() => verifyOrder(["src/platform/navigation/chatgpt/message-location.js"]), /navigation-identity/);
  assert.throws(() => verifyOrder(["src/features/titles/model/title-dates.js", "src/platform/time-format.js"]), /time-format/);
  const context = vm.createContext({});
  assert.throws(() => vm.runInContext(read("src/features/titles/model/title-dates.js"), context), /shared time formatter/);
});

test("title ESM entrypoint resolves its shared route provider without fixture injection", async () => {
  const title = await import("../src/features/titles/model/title-context.js");
  assert.deepEqual(Object.keys(title), ["titleSnapshotContext"]);
  const { canonicalConversationPath, parseConversationRoute } = await import("../src/platform/navigation/conversation-route.js");
  assert.equal(canonicalConversationPath("https://chatgpt.com/g/g-p-one/c/two", "two"), "/g/g-p-one/c/two");
  assert.equal(parseConversationRoute("https://chatgpt.com/g/g-p-one/c/two").conversationId, "two");
});
