const assert = require("node:assert/strict");
const test = require("node:test");
const { snapshotHarness } = require("./helpers/adapter-snapshot.cjs");

// Import the actual module graph: platform route grammar must not depend on a title-owned alias.
const routeModule = import("../src/platform/navigation/conversation-route.js");
const titleModule = import("../src/features/titles/model/title-context.js");
let routes;
let titles;
test.before(async () => { [routes, titles] = await Promise.all([routeModule, titleModule]); });
const plain = (value) => JSON.parse(JSON.stringify(value));

test("title context exports only snapshot ownership while shared route grammar belongs to the platform", () => {
  assert.deepEqual(Object.keys(titles), ["titleSnapshotContext"]);
  assert.deepEqual(Object.keys(routes).sort(), ["canonicalConversationPath", "parseConversationRoute"]);
});

test("title routes accept only saved ordinary and canonical project conversations", () => {
  for (const [url, projectId] of [["https://chatgpt.com/c/one", null], ["/g/g-p-project/c/one/", "g-p-project"]]) {
    const result = routes.parseConversationRoute(url);
    assert.equal(result.conversationId, "one");
    assert.equal(result.projectId, projectId);
  }
  for (const url of ["https://evil.test/c/one", "http://chatgpt.com/c/one", "/g/g-custom/c/one", "/gg/one",
    "/share/one", "/c/WEB:one", "/c/one/more", "/g/g-p-project", "/"]) assert.equal(routes.parseConversationRoute(url), null, url);
});

test("real project snapshot, native identity and route must all agree", () => {
  const snapshot = snapshotHarness({ url: "https://chatgpt.com/g/g-p-project/c/one",
    sidebar: [{ href: "/g/g-p-project/c/one", title: "Project chat", record: {
      id: "one", title: "Project chat", create_time: 1700000000, update_time: 1700000001,
    } }] });
  assert.deepEqual(plain(titles.titleSnapshotContext(snapshot, 4)), {
    tabId: 4, conversationId: "one", pathname: "/g/g-p-project/c/one", projectId: "g-p-project",
  });
  for (const mutate of [
    (s) => { s.conversation.project.projectId = "g-p-other"; },
    (s) => { s.route.kind = "conversation"; },
    (s) => { s.conversation.kind = "conversation"; },
    (s) => { s.conversation.bindingStatus = "route-only"; },
    (s) => { s.route.pathname = "/g/g-p-project/c/other"; },
  ]) {
    const changed = plain(snapshot); mutate(changed);
    assert.equal(titles.titleSnapshotContext(changed, 4), null);
  }
});

test("named project routes keep the exact page path but expose only the canonical project ID", () => {
  const projectId = "g-p-0123456789abcdef0123456789abcdef";
  const pathname = `/g/${projectId}-my-project/c/one`;
  const snapshot = snapshotHarness({ url: `https://chatgpt.com${pathname}/`,
    sidebar: [{ href: pathname, title: "Project chat", record: { id: "one", title: "Project chat" } }] });
  assert.equal(snapshot.conversation.project.projectId, projectId);
  assert.equal(snapshot.sidebarConversations[0].project.projectId, projectId);
  assert.deepEqual(plain(titles.titleSnapshotContext(snapshot, 4)), { tabId: 4, conversationId: "one", pathname, projectId });
  assert.equal(routes.parseConversationRoute(`${pathname}/extra`), null);
  assert.equal(routes.parseConversationRoute(`/g/${projectId}-my-project/other/c/one`), null);
});
