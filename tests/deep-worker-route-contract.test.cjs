const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const routeModule = () => import("../src/platform/navigation/conversation-route.js");

test("platform owns route parsing and canonical persistence without title compatibility exports", async () => {
  const route = await routeModule();
  const title = await import("../src/features/titles/model/title-context.js");
  assert.equal(typeof route.parseConversationRoute, "function");
  assert.equal(typeof route.canonicalConversationPath, "function");
  assert.deepEqual(Object.keys(title), ["titleSnapshotContext"]);
  assert.equal(title.titleSnapshotContext(null, 4), null);
});

test("all ordinary and project path spellings preserve the one snapshot grammar", async () => {
  const { parseConversationRoute, canonicalConversationPath } = await routeModule();
  const projectId = "g-p-0123456789abcdef0123456789abcdef";
  for (const path of ["/c/chat", "/g/g-p-short/c/chat", `/g/${projectId}-my-project/c/chat`]) {
    for (const input of [path, path + "/", path + "?q=one#message", "https://chatgpt.com" + path + "/?q=one"]) {
      const parsed = parseConversationRoute(input);
      assert.equal(parsed.pathname, path);
      assert.equal(parsed.conversationId, "chat");
      assert.equal(canonicalConversationPath(input, "chat"), path);
      assert.equal(canonicalConversationPath(input, "other"), null);
      if (path.includes(projectId)) assert.equal(parsed.projectId, projectId);
    }
  }
});

test("canonical storage never repairs URL spellings that route observation may normalize", async () => {
  const { parseConversationRoute, canonicalConversationPath } = await routeModule();
  for (const input of ["c/chat", "https://chatgpt.com:443/c/chat", "https://user@chatgpt.com/c/chat", "/discard/../c/chat"]) {
    assert.equal(parseConversationRoute(input).pathname, "/c/chat");
    assert.equal(canonicalConversationPath(input, "chat"), null);
  }
  for (const input of [undefined, null, {}, 12, true, "/c/chat/extra", "https://evil.test/c/chat", "http://chatgpt.com/c/chat",
    "/share/chat", "/g/g-custom/c/chat", "/gg/chat"]) {
    assert.equal(canonicalConversationPath(input, "chat"), null);
  }
});

test("platform canonical helper preserves snapshot return and exception contracts exactly", async () => {
  const { canonicalConversationPath } = await routeModule();
  const original = globalThis.TidySnapshot.canonicalConversationPath;
  const contract = globalThis.TidySnapshot;
  // The contract is immutable: ordinary delegation equivalence proves there is no second grammar.
  for (const [value, id] of [["/c/a", "a"], ["/c/a", "b"], ["/c/a?x", "a"], [null, "a"], ["/c/a", null]]) {
    assert.equal(canonicalConversationPath(value, id), original(value, id));
  }
  assert.equal(globalThis.TidySnapshot, contract);
});

test("favorites and bookmarks import the shared route capability without a titles dependency", async () => {
  for (const feature of ["favorites", "bookmarks"]) {
    const file = `src/features/${feature}/storage/${feature}-domain.js`;
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /import \{ canonicalConversationPath \} from "\.\.\/\.\.\/\.\.\/platform\/navigation\/conversation-route\.js"/);
    assert.doesNotMatch(source, /titles\/model\/title-context/);
    const domain = await import(`../${file}`);
    assert.equal(typeof domain[feature === "favorites" ? "normalizeFavoritesState" : "normalizeBookmarksState"], "function");
  }
});
