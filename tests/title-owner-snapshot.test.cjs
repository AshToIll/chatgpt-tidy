const assert = require("node:assert/strict");
const test = require("node:test");
const { snapshotHarness } = require("./helpers/adapter-snapshot.cjs");

const record = { id: "owner", title: "Owner", create_time: 1700000000, update_time: 1700000001 };
const message = (conversationId) => ({ id: "message-one", role: "assistant", record: {
  id: "message-one", conversation_id: conversationId, author: { role: "assistant" },
  create_time: 1700000001, content: { content_type: "text", parts: ["Unrelated private excerpt"] },
} });

for (const [name, fixture, binding] of [
  ["saved ordinary conversation", { sidebar: [{ href: "/c/owner", title: "Owner", record }], messages: [message("owner")] }, "bound"],
  ["saved project conversation", { url: "https://chatgpt.com/g/g-p-one/c/owner",
    sidebar: [{ href: "/g/g-p-one/c/owner", title: "Owner", record }], messages: [message("owner")] }, "bound"],
  ["exact current-page message evidence with no sidebar", { messages: [message("owner")] }, "bound"],
  ["route-only page", {}, "route-only"],
  ["mismatched thread", { thread: { ...record, id: "another" }, messages: [message("another")] }, "mismatch"],
]) {
  test(`title owner projection preserves original binding: ${name}`, () => {
    const h = snapshotHarness({ url: "https://chatgpt.com/c/owner", ...fixture, returnSession: true });
    const full = h.readSnapshot(), narrow = h.readSnapshot({ scope: "title-owner" });
    assert.deepEqual(narrow.conversation, full.conversation);
    assert.deepEqual(narrow.route, full.route);
    assert.equal(narrow.conversation.bindingStatus, binding);
    assert.deepEqual(narrow.messages, []);
    assert.deepEqual(narrow.sidebarConversations, []);
    assert.doesNotMatch(JSON.stringify(narrow), /Unrelated private excerpt/);
    assert.deepEqual(h.readSnapshot().messages, full.messages, "ordinary snapshots stay full after a title preflight");
  });
}

test("title owner proof does not trigger a redundant background date fetch", async () => {
  const requests = [];
  const native = { ...record };
  // Start with complete metadata so there is no in-flight startup read that
  // could accidentally hide a redundant fetch through request deduplication.
  const h = snapshotHarness({ url: "https://chatgpt.com/c/owner", returnSession: true,
    sidebar: [{ href: "/c/owner", title: "Owner", record: native }],
    messages: [message("owner")], fetch: async (url) => {
      requests.push(url); return { ok: false, status: 503 };
    } });
  native.create_time = null; native.update_time = null;
  for (let index = 0; index < 10; index++) h.readSnapshot({ scope: "title-owner" });
  await new Promise(setImmediate);
  assert.equal(requests.length, 0);
  h.readSnapshot();
  await new Promise(setImmediate);
  assert.ok(requests.length > 0, "ordinary snapshots still replenish missing dates");
});
