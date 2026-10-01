const assert = require("node:assert/strict");
const test = require("node:test");
const { snapshotHarness } = require("./helpers/adapter-snapshot.cjs");
const flush = () => new Promise(resolve => setImmediate(resolve));
const url = "https://chatgpt.com/c/metadata-scope";
const complete = { title: "Current", create_time: 1_900_000_000, update_time: 1_900_000_100 };
function fixture(fetch) {
  return snapshotHarness({ url, thread: null, sidebar: [], returnSession: true, fetch,
    sessionFixture: { user: { id: "snapshot-fixture" }, accessToken: "fixture-token" },
    messages: [{ id: "message", role: "assistant", record: { id: "message", conversation_id: "metadata-scope",
      author: { role: "assistant" }, create_time: 1_900_000_050 } }],
  });
}

for (const status of [401, 404, 429, 503]) test(`optional metadata ${status} stops until the route/workspace scope changes`, async () => {
  let calls = 0;
  const h = fixture(async () => { calls++; return { ok: false, status }; });
  const perScope = status === 401 ? 2 : 1; // Shared API's existing one token-refresh attempt.
  for (let event = 0; event < 20; event++) { h.readSnapshot(); await flush(); }
  assert.equal(calls, perScope, "snapshot events never authorize automatic retries after failure");
  h.setCookie("analytics=changed"); h.readSnapshot(); await flush();
  h.setLocation(url + "?presentation=changed"); h.readSnapshot(); await flush();
  assert.equal(calls, perScope, "unrelated cookies and URL query changes are not a new owner");
  h.setCookie("_account=workspace-two"); h.readSnapshot(); await flush();
  assert.equal(calls, perScope * 2, "a new workspace gets one new read, not a permanent global block");
  h.setLocation("https://chatgpt.com/"); h.readSnapshot();
  h.setLocation(url); h.readSnapshot(); await flush();
  assert.equal(calls, perScope * 3, "leaving and returning establishes a new route scope");
});

test("late successful metadata cannot populate a different workspace's snapshot", async () => {
  let release, calls = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const h = fixture(async () => { calls++; return waiting; });
  h.readSnapshot();
  h.setCookie("_account=workspace-two"); h.readSnapshot();
  release({ ok: true, status: 200, json: async () => complete }); await flush();
  const firstNewScope = h.readSnapshot();
  assert.equal(firstNewScope.conversation.createdAt.value, null, "old response is not cached across workspace scope");
  await flush();
  assert.equal(calls, 2); assert.notEqual(h.readSnapshot().conversation.createdAt.value, null);
});

test("failed optional metadata does not prevent later native page metadata or a new document's attempt", async () => {
  let calls = 0;
  const fetch = async () => { calls++; throw new Error("Offline"); };
  const first = fixture(fetch); first.readSnapshot(); await flush();
  first.readSnapshot(); await flush(); assert.equal(calls, 1);
  const reloaded = fixture(fetch); reloaded.readSnapshot(); await flush(); assert.equal(calls, 2);
  const native = snapshotHarness({ url, sidebar: [{ href: "/c/metadata-scope", title: "Current",
    record: { id: "metadata-scope", ...complete } }], fetch });
  assert.notEqual(native.conversation.createdAt.value, null); assert.equal(calls, 2);
});
