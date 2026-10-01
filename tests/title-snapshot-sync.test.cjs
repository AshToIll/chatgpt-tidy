const assert = require("node:assert/strict");
const test = require("node:test");
const { snapshotHarness } = require("./helpers/adapter-snapshot.cjs");

const original = "Original title";
const renamed = "2026/09/01 | Original title";
const identity = { accountKey: "user-one", workspaceKey: "personal" };
const createdAt = "2026-09-01T00:00:00.000Z";
const updatedAt = "2026-09-09T00:00:00.000Z";

test("batch readback synchronizes the off-current project target without replacing its owner snapshot", async () => {
  const targetId = "project-target", targetProjectId = "g-p-project";
  const ownerRecord = { id: "owner", title: "Owner title", serverId$: () => null,
    create_time: Date.parse(createdAt) / 1000, update_time: Date.parse(createdAt) / 1000 };
  const h = snapshotHarness({ url: "https://chatgpt.com/c/owner", documentTitle: "Owner title", thread: ownerRecord,
    sidebar: [{ href: "/c/owner", title: "Owner title", sidebarItem: true, record: ownerRecord },
      { href: `/g/${targetProjectId}/c/${targetId}`, title: original, sidebarItem: true,
        record: { id: targetId, title: original, create_time: ownerRecord.create_time, update_time: ownerRecord.update_time } }],
    titleAdapter: { writeCurrent: async () => ({ status: "verified", current: {
      conversationId: targetId, title: renamed, createdAt, updatedAt,
    } }) }, returnSession: true,
  });
  const initial = h.readSnapshot();
  const result = await h.requestTitle("TITLE_WRITE_CURRENT", { conversationId: targetId, targetProjectId, identity,
    before: original, after: renamed, ownerContext: { conversationId: "owner", pathname: "/c/owner", projectId: null } });
  assert.equal(result.payload.status, "verified");
  assert.equal(h.documentTitle(), "Owner title");
  assert.equal(h.sidebarText(0), "Owner title");
  assert.equal(h.sidebarText(1), renamed);
  const latest = h.readSnapshot();
  assert.deepEqual(latest.conversation, initial.conversation, "off-current readback is not current-conversation authority");
  const target = latest.sidebarConversations.find((row) => row.conversationId === targetId);
  assert.equal(target.title.value, renamed);
  assert.equal(target.updatedAt.value, updatedAt);
});

function harness({ status = "verified", readTitle = renamed } = {}) {
  const calls = [];
  // Both native data sources deliberately remain stale after the adapter's
  // independent readback. Updating only the sidebar DOM must not pass this test.
  const thread = { id: "current", title: original, serverId$: () => null,
    create_time: Date.parse(createdAt) / 1000, update_time: Date.parse(createdAt) / 1000 };
  const metadata = { ...thread };
  const current = { conversationId: "current", title: readTitle, createdAt, updatedAt };
  const session = snapshotHarness({
    url: "https://chatgpt.com/c/current",
    documentTitle: original,
    thread,
    sidebar: [{ href: "/c/current", title: original, sidebarItem: true, ariaLabel: `${original} (unread)`, record: metadata },
      { href: "/c/other", title: "Other title", sidebarItem: true, record: { id: "other", title: "Other title", create_time: thread.create_time, update_time: thread.update_time } }],
    messages: [{ id: "message-one", role: "assistant", record: {
      id: "message-one", conversation_id: "current", author: { role: "assistant" }, create_time: thread.create_time,
      content: { content_type: "text", parts: ["Existing answer"] },
    } }],
    titleAdapter: {
      readCurrent: async (payload) => { calls.push({ type: "read", payload }); return { identity, current }; },
      writeCurrent: async (payload) => {
        calls.push({ type: "write", payload });
        return { status, [status === "accepted" ? "accepted" : "current"]: { ...current, title: payload.after } };
      },
    },
    returnSession: true,
  });
  return { ...session, calls, metadata, thread };
}

function updates(h) {
  return h.snapshotEvents();
}

test("real main-world accepted batch write publishes title-only metadata without claiming verified timestamps", async () => {
  const h = harness({ status: "accepted" }), initial = h.readSnapshot();
  const response = await h.requestTitle("TITLE_WRITE_CURRENT", { conversationId: "current", identity,
    before: original, after: renamed, batchScopeId: "confirmed-batch" });
  assert.equal(response.payload.status, "accepted"); assert.equal(response.payload.current, undefined);
  assert.equal(h.calls.length, 1); assert.equal(h.sidebarText(), renamed); assert.equal(h.sidebarText(1), "Other title");
  assert.equal(h.documentTitle(), renamed);
  const events = updates(h); assert.equal(events.length, 1);
  assert.equal(events[0].envelope.payload.reason, "title-accepted");
  const snapshot = events[0].envelope.payload.snapshot;
  assert.equal(snapshot.conversation.title.source, "chatgpt-api.title-accepted");
  assert.equal(snapshot.conversation.title.value, renamed);
  assert.deepEqual(snapshot.conversation.createdAt, initial.conversation.createdAt);
  assert.deepEqual(snapshot.conversation.updatedAt, initial.conversation.updatedAt);
  assert.deepEqual(snapshot.sidebarConversations[0].createdAt, initial.sidebarConversations[0].createdAt);
  assert.deepEqual(snapshot.sidebarConversations[0].updatedAt, initial.sidebarConversations[0].updatedAt);
  assert.deepEqual(snapshot.messages, initial.messages);
  assert.equal(h.thread.title, original); assert.equal(h.metadata.title, original, "native React objects stay immutable");
});

test("real main-world verified write publishes a readback snapshot before its receipt over stale native metadata", async () => {
  const h = harness();
  const initial = h.readSnapshot();
  assert.equal(initial.conversation.title.value, original);
  const response = await h.requestTitle("TITLE_WRITE_CURRENT", { conversationId: "current", identity, before: original, after: renamed });
  assert.equal(response.ok, true);
  assert.equal(response.payload.status, "verified");
  assert.equal(h.calls.length, 1);
  assert.equal(h.metadata.title, original, "native React record is not mutated");
  assert.equal(h.thread.title, original, "thread record remains deliberately stale");
  assert.equal(h.sidebarText(), renamed);
  assert.equal(h.sidebarText(1), "Other title");
  assert.equal(h.sidebarLabel(), `${renamed} (unread)`);
  assert.equal(h.documentTitle(), renamed);

  const events = updates(h);
  assert.equal(events.length, 1);
  assert.equal(events[0].envelope.payload.reason, "title-readback");
  const next = events[0].envelope.payload.snapshot;
  assert.equal(next.route.pathname, "/c/current");
  assert.equal(next.conversation.conversationId, "current");
  assert.equal(next.conversation.bindingStatus, "bound");
  assert.equal(next.conversation.title.value, renamed);
  assert.equal(next.conversation.title.source, "chatgpt-api.title-readback");
  assert.equal(next.conversation.updatedAt.value, updatedAt);
  assert.equal(next.sidebarConversations[0].title.value, renamed);
  assert.equal(next.sidebarConversations[0].updatedAt.value, updatedAt);
  assert.deepEqual(next.messages, initial.messages, "title sync does not replace message data");
  assert.deepEqual(next.sidebarConversations[1], initial.sidebarConversations[1]);
  assert.equal(h.postedMessages().at(-1).envelope.requestId, response.requestId, "snapshot is published before response");

  h.rerenderSidebarTitle(0, original);
  const afterRerender = h.readSnapshot();
  assert.equal(h.sidebarText(), renamed);
  assert.equal(afterRerender.conversation.title.value, renamed);
  assert.equal(afterRerender.sidebarConversations[0].title.value, renamed);
  assert.equal(h.calls.length, 1, "snapshot synchronization performs no additional backend read or rename");
});

test("uncertain writes cannot change visible titles or publish a success snapshot", async () => {
  const h = harness({ status: "uncertain" });
  h.readSnapshot();
  const result = await h.requestTitle("TITLE_WRITE_CURRENT", { conversationId: "current", identity, before: original, after: renamed });
  assert.equal(result.payload.status, "uncertain");
  assert.equal(h.sidebarText(), original);
  assert.equal(h.documentTitle(), original);
  assert.equal(h.readSnapshot().conversation.title.value, original);
  assert.equal(updates(h).length, 0);
});

test("authenticated read-only reconciliation synchronizes the accepted title without a write", async () => {
  const h = harness();
  h.readSnapshot();
  const result = await h.requestTitle("TITLE_READ_CURRENT", { conversationId: "current" });
  assert.equal(result.ok, true);
  assert.equal(h.sidebarText(), renamed);
  assert.equal(h.readSnapshot().conversation.title.value, renamed);
  assert.equal(updates(h).length, 1);
  assert.deepEqual(h.calls.map((call) => call.type), ["read"]);
});

test("verified date removal replaces the projected title in the real main-world snapshot", async () => {
  const h = harness();
  await h.requestTitle("TITLE_WRITE_CURRENT", { conversationId: "current", identity, before: original, after: renamed });
  await h.requestTitle("TITLE_WRITE_CURRENT", { conversationId: "current", identity, before: renamed, after: original });
  const restored = h.readSnapshot();
  assert.equal(h.sidebarText(), original);
  assert.equal(h.documentTitle(), original);
  assert.equal(restored.conversation.title.value, original);
  assert.equal(restored.sidebarConversations[0].title.value, original);
  assert.equal(updates(h).length, 2);
  assert.equal(h.calls.length, 2);
});
