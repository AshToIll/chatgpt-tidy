const assert = require("node:assert/strict");
const { snapshotHarness } = require("./helpers/adapter-snapshot.cjs");

async function main() {

// Project child anchors are eligible even before ChatGPT adds its optional
// data-sidebar-item marker during the lazy expand animation.
const projectChild = snapshotHarness({
  url: "https://chatgpt.com/g/g-p-project/c/project-conversation",
  thread: { id: "project-conversation", serverId$: () => null },
  sidebar: [{
    href: "/g/g-p-project/c/project-conversation",
    title: "Project child",
    record: {
      id: "project-conversation",
      title: "Project child",
      create_time: 1_900_000_000,
      update_time: 1_900_000_100,
    },
  }],
  messages: [{
    id: "project-user",
    role: "user",
    record: {
      id: "project-user",
      conversation_id: "project-conversation",
      author: { role: "user" },
      create_time: 1_900_000_050,
    },
  }, {
    id: "project-assistant",
    role: "assistant",
    record: {
      id: "project-assistant",
      conversation_id: "project-conversation",
      author: { role: "assistant" },
      create_time: 1_900_000_060,
    },
  }],
});
assert.equal(projectChild.sidebarConversations[0].kind, "project-conversation");
assert.equal(projectChild.sidebarConversations[0].bindingStatus, "bound");
assert.equal(projectChild.sidebarConversations[0].createdAt.value, "2030-03-17T17:46:40.000Z");
assert.equal(projectChild.sidebarConversations[0].updatedAt.value, "2030-03-17T17:48:20.000Z");

// A task-clock action can precede the title and has the same row-link marker.
// Its own aria-hidden flag excludes it before conversation-id deduplication,
// so an unbound action cannot steal the title's metadata or exact locator.
for (const auxiliaryFirst of [true, false]) {
  for (const auxiliaryHref of ["/c/synthetic-task", "/c/synthetic-task?task=synthetic"]) {
    const titleLink = {
      href: "/c/synthetic-task", title: "Synthetic task title",
      attributes: { "data-interactive-row-link": "true" },
      record: { id: "synthetic-task", create_time: 1_900_000_000, update_time: 1_900_000_100 },
    };
    const auxiliaryLink = {
      href: auxiliaryHref, title: "Synthetic task action",
      attributes: { "data-interactive-row-link": "true", "aria-hidden": "true", tabindex: "-1" },
    };
    const taskSnapshot = snapshotHarness({
      url: "https://chatgpt.com/c/synthetic-task",
      sidebar: auxiliaryFirst ? [auxiliaryLink, titleLink] : [titleLink, auxiliaryLink],
    });
    assert.equal(taskSnapshot.sidebarConversations.length, 1);
    const [task] = taskSnapshot.sidebarConversations;
    assert.equal(task.title.value, "Synthetic task title", "task action must not occupy the primary sidebar DTO");
    assert.equal(task.bindingStatus, "bound");
    assert.equal(task.locator.value, "/c/synthetic-task", "DTO locator belongs to the primary title, not the task query URL");
    assert.equal(task.createdAt.value, "2030-03-17T17:46:40.000Z");
    assert.equal(task.updatedAt.value, "2030-03-17T17:48:20.000Z");
  }
}

const groupBeforeBeginning = snapshotHarness({
  url: "https://chatgpt.com/",
  sidebar: [{
    href: "/gg/group-room",
    title: "Group room",
    room: {
      id: "group-room",
      create_time: 1_700_000_000,
      updatedAt$: () => 1_900_000_100,
      hasFetchedBeginning$: () => false,
      messages$: () => [{ createdAt: 1_800_000_000 }],
    },
  }],
});
assert.equal(groupBeforeBeginning.sidebarConversations[0].createdAt.value, null);
assert.equal(groupBeforeBeginning.sidebarConversations[0].updatedAt.value, "2030-03-17T17:48:20.000Z");

const groupAfterBeginning = snapshotHarness({
  url: "https://chatgpt.com/",
  sidebar: [{
    href: "/gg/group-room",
    title: "Group room",
    room: {
      id: "group-room",
      create_time: 1_700_000_000,
      updatedAt$: () => 1_900_000_100,
      hasFetchedBeginning$: () => true,
      messages$: () => [{ createdAt: 1_800_000_000 }],
    },
  }],
});
assert.equal(groupAfterBeginning.sidebarConversations[0].createdAt.value, "2027-01-15T08:00:00.000Z");

const oldThread = { id: "old-conversation", serverId$: () => null };
const oldMessage = {
  id: "old-message",
  role: "user",
  record: {
    id: "old-message",
    conversation_id: "old-conversation",
    author: { role: "user" },
    create_time: 1_700_000_000,
  },
};
const oldSidebar = {
  href: "/c/old-conversation",
  title: "Old title",
  record: {
    id: "old-conversation",
    title: "Old title",
    create_time: 1_700_000_000,
    update_time: 1_700_000_100,
  },
};

// Blank route with old DOM/sidebar must be an entirely empty, valid snapshot.
const blank = snapshotHarness({
  url: "https://chatgpt.com/",
  documentTitle: "Old title - ChatGPT",
  thread: oldThread,
  sidebar: [oldSidebar],
  messages: [oldMessage],
});
assert.equal(blank.conversation.conversationId, null);
assert.deepEqual(blank.appearance, {
  colorScheme: "light",
  source: "system-color-scheme",
  status: "partial",
  surface: { value: null, source: null, status: "missing" },
});
assert.equal(blank.conversation.identityStatus, "empty");
assert.equal(blank.conversation.bindingStatus, "unbound");
assert.deepEqual(blank.conversation.title, { value: null, source: null, status: "missing" });
assert.deepEqual(blank.conversation.createdAt, { value: null, source: null, status: "missing" });
assert.deepEqual(blank.conversation.updatedAt, { value: null, source: null, status: "missing" });
assert.deepEqual(blank.messages, []);
assert.equal(blank.sidebarConversations.length, 1);
assert.equal(blank.sidebarConversations[0].conversationId, "old-conversation");
assert.equal(blank.sidebarConversations[0].bindingStatus, "bound");
assert.equal(blank.sidebarConversations[0].createdAt.value, "2023-11-14T22:13:20.000Z");
assert.equal(blank.sidebarConversations[0].updatedAt.value, "2023-11-14T22:15:00.000Z");
assert.equal(blank.sidebarConversations[0].createdAt.status, "available");

// A new stable route keeps its route ID while old visible DOM is quarantined.
const fastSwitch = snapshotHarness({
  url: "https://chatgpt.com/c/new-conversation",
  documentTitle: "Old title - ChatGPT",
  thread: oldThread,
  sidebar: [
    oldSidebar,
    {
      href: "/c/new-conversation",
      title: "New title",
      record: {
        id: "new-conversation",
        title: "New title",
        create_time: 1_800_000_000,
        update_time: 1_800_000_100,
      },
    },
  ],
  messages: [oldMessage],
});
assert.equal(fastSwitch.conversation.conversationId, "new-conversation");
assert.equal(fastSwitch.conversation.bindingStatus, "mismatch");
assert.equal(fastSwitch.conversation.title.value, null);
assert.equal(fastSwitch.conversation.createdAt.value, null);
assert.equal(fastSwitch.conversation.updatedAt.value, null);
assert.deepEqual(fastSwitch.messages, []);
assert.deepEqual(
  fastSwitch.sidebarConversations.map((item) => item.conversationId),
  ["old-conversation", "new-conversation"],
);

// A bound current route still reads its own metadata and messages normally.
const currentThread = { id: "current-conversation", serverId$: () => null };
const current = snapshotHarness({
  url: "https://chatgpt.com/c/current-conversation",
  thread: currentThread,
  sidebar: [
    {
      href: "/c/current-conversation",
      title: "Current title",
      record: {
        id: "current-conversation",
        title: "Current title",
        create_time: 1_900_000_000,
        update_time: 1_900_000_100,
      },
    },
  ],
  messages: [
    {
      id: "current-user-message",
      role: "user",
      record: {
        id: "current-user-message",
        conversation_id: "current-conversation",
        author: { role: "user" },
        create_time: 1_900_000_050,
      },
    },
    {
      id: "current-message",
      role: "assistant",
      record: {
        id: "current-message",
        conversation_id: "current-conversation",
        author: { role: "assistant" },
        create_time: 1_900_000_060,
      },
    },
  ],
});
assert.equal(current.conversation.bindingStatus, "bound");
assert.equal(current.conversation.title.value, "Current title");
assert.equal(current.messages.length, 2);
assert.equal(current.messages[0].messageId, "current-user-message");
assert.equal(current.sidebarConversations[0].bindingStatus, "bound");
assert.equal(current.conversation.createdAt.value, "2030-03-17T17:46:40.000Z");
assert.equal(current.conversation.updatedAt.value, "2030-03-17T17:48:20.000Z");
assert.equal(current.conversation.updatedAt.source, "react-fiber.history-item");
assert.equal(current.sidebarConversations[0].createdAt.value, "2030-03-17T17:46:40.000Z");
assert.equal(current.sidebarConversations[0].updatedAt.value, "2030-03-17T17:48:20.000Z");
assert.notEqual(
  current.conversation.createdAt.value,
  current.messages[0].timestamp.value,
  "message timestamps must not overwrite canonical conversation metadata",
);

// Thinking shells can carry a DOM message id before a canonical Fiber message
// exists. They must not consume a number or receive time/bookmark UI. A real
// streaming assistant record remains presentable even while end_turn is false.
const generatingState = snapshotHarness({
  url: "https://chatgpt.com/c/generating-conversation",
  thread: { id: "generating-conversation", serverId$: () => null },
  sidebar: [{
    href: "/c/generating-conversation",
    title: "Generating",
    record: { id: "generating-conversation", title: "Generating", create_time: 1_900_000_000, update_time: 1_900_000_100 },
  }],
  messages: [{
    id: "thinking-shell",
    role: "assistant",
    record: {
      id: "thinking-shell",
      conversation_id: "generating-conversation",
      author: { role: "assistant" },
      status: "in_progress",
    },
  }, {
    id: "assistant-message-live",
    role: "assistant",
    record: {
      id: "assistant-message-live",
      conversation_id: "generating-conversation",
      author: { role: "assistant" },
      create_time: 1_900_000_060,
      status: "in_progress",
      end_turn: false,
      metadata: { is_complete: false },
      content: { parts: ["partial formal response"] },
    },
  }],
});
assert.deepEqual(generatingState.messages.map((message) => message.messageId), ["assistant-message-live"]);
assert.equal(generatingState.messages[0].presentationStatus, "formal");
assert.equal(generatingState.adapter.responseInProgress, true);
assert.equal(current.adapter.responseInProgress, false);
assert.equal(fastSwitch.adapter.responseInProgress, false);

// 同一条长回复结束时摘要可能一字不变，原生状态仍须单独通知导出页。
const liveMessage = { id: "response", role: "assistant", record: { id: "response",
  conversation_id: "completion", author: { role: "assistant" }, create_time: 1_900_000_060,
  status: "in_progress", content: { parts: ["identical prefix ".repeat(40)] } } };
const completionSession = snapshotHarness({ url: "https://chatgpt.com/c/completion",
  thread: { id: "completion", serverId$: () => null }, messages: [liveMessage], returnSession: true });
const beforeCompletion = completionSession.readSnapshot();
liveMessage.record.status = "finished_successfully";
const afterCompletion = completionSession.readSnapshot();
assert.equal(beforeCompletion.messages[0].excerpt.value, afterCompletion.messages[0].excerpt.value);
assert.equal(beforeCompletion.adapter.responseInProgress, true);
assert.equal(afterCompletion.adapter.responseInProgress, false);
completionSession.setLocation("https://chatgpt.com/c/another");
liveMessage.record.status = "in_progress";
assert.equal(completionSession.readSnapshot().adapter.responseInProgress, false, "old-route streaming cannot block the new route");

// Responsive layouts can unmount the native sidebar. Exact current-page Fiber
// metadata remains eligible when it is bound to the route conversation ID.
const narrowCurrent = snapshotHarness({
  url: "https://chatgpt.com/c/narrow-conversation",
  thread: {
    id: "narrow-conversation",
    serverId$: () => null,
    title: "Narrow title",
    create_time: 1_900_100_000,
    update_time: 1_900_100_100,
  },
  sidebar: [],
  messages: [{
    id: "narrow-message",
    role: "assistant",
    record: {
      id: "narrow-message",
      conversation_id: "narrow-conversation",
      author: { role: "assistant" },
      create_time: 1_900_100_050,
    },
  }],
});
assert.equal(narrowCurrent.conversation.bindingStatus, "bound");
assert.equal(narrowCurrent.conversation.createdAt.value, "2030-03-18T21:33:20.000Z");
assert.equal(narrowCurrent.conversation.updatedAt.value, "2030-03-18T21:35:00.000Z");
assert.equal(narrowCurrent.conversation.createdAt.source, "react-fiber.current-conversation");

// Exact route/message identity alone may keep the current conversation bound,
// but it cannot manufacture canonical times when no metadata source exists.
const narrowMissing = snapshotHarness({
  url: "https://chatgpt.com/c/narrow-missing",
  thread: null,
  sidebar: [],
  messages: [{
    id: "narrow-missing-message",
    role: "assistant",
    record: {
      id: "narrow-missing-message",
      conversation_id: "narrow-missing",
      author: { role: "assistant" },
      create_time: 1_900_200_050,
    },
  }],
});
assert.equal(narrowMissing.conversation.bindingStatus, "bound");
assert.equal(narrowMissing.conversation.createdAt.value, null);
assert.equal(narrowMissing.conversation.updatedAt.value, null);

// When current-page identity is exact but its Fiber omits canonical metadata,
// one current-conversation request may fill only that route's cache. This is
// deliberately not the removed sidebar-wide/N+1 hydration architecture.
const requestedCurrentMetadata = [];
const narrowFallback = snapshotHarness({
  url: "https://chatgpt.com/c/narrow-fallback",
  sessionFixture: { user: { id: "snapshot-fixture" }, accessToken: "fixture-token" },
  thread: null,
  sidebar: [],
  messages: [{
    id: "narrow-fallback-message",
    role: "assistant",
    record: {
      id: "narrow-fallback-message",
      conversation_id: "narrow-fallback",
      author: { role: "assistant" },
      create_time: 1_900_300_050,
    },
  }],
  fetch: async (url, options) => {
    requestedCurrentMetadata.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        // The live endpoint can omit a top-level conversation ID. The exact
        // request URL and unchanged route remain the binding proof.
        title: "Canonical current conversation",
        create_time: 1_900_300_000,
        update_time: 1_900_300_100,
      }),
    };
  },
  returnSession: true,
});
const narrowFallbackBefore = narrowFallback.readSnapshot();
assert.equal(narrowFallbackBefore.conversation.createdAt.value, null);
assert.equal(narrowFallbackBefore.conversation.updatedAt.value, null);
await new Promise((resolve) => setImmediate(resolve));
const narrowFallbackAfter = narrowFallback.readSnapshot();
assert.equal(requestedCurrentMetadata.length, 1);
assert.equal(requestedCurrentMetadata[0].url, "/backend-api/conversation/narrow-fallback");
assert.equal(requestedCurrentMetadata[0].options.credentials, "include");
assert.equal(narrowFallbackAfter.conversation.createdAt.value, "2030-03-21T05:06:40.000Z");
assert.equal(narrowFallbackAfter.conversation.updatedAt.value, "2030-03-21T05:08:20.000Z");
assert.equal(narrowFallbackAfter.conversation.createdAt.source, "chatgpt-api.current-conversation-metadata");

// Snapshot requests and page events do not retry an optional failed read.
// A genuinely different workspace starts a new scope, without a cooldown.
let incompleteAttempt = 0;
const incompleteThenValid = snapshotHarness({
  url: "https://chatgpt.com/c/incomplete-then-valid",
  sessionFixture: { user: { id: "snapshot-fixture" }, accessToken: "fixture-token" },
  thread: null,
  sidebar: [],
  messages: [{
    id: "incomplete-message",
    role: "assistant",
    record: {
      id: "incomplete-message",
      conversation_id: "incomplete-then-valid",
      author: { role: "assistant" },
      create_time: 1_900_400_050,
    },
  }],
  fetch: async () => {
    incompleteAttempt += 1;
    return {
      ok: true,
      status: 200,
      json: async () => incompleteAttempt === 1
        ? { title: "Incomplete", create_time: 1_900_400_000 }
        : {
            title: "Complete",
            create_time: 1_900_400_000,
            update_time: 1_900_400_100,
          },
    };
  },
  returnSession: true,
});
incompleteThenValid.readSnapshot();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(incompleteAttempt, 1);
const retryBoundarySnapshot = incompleteThenValid.readSnapshot();
assert.equal(retryBoundarySnapshot.conversation.createdAt.value, null);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(incompleteAttempt, 1);
incompleteThenValid.setCookie("_account=another-workspace");
incompleteThenValid.readSnapshot();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(incompleteAttempt, 2);
const recoveredSnapshot = incompleteThenValid.readSnapshot();
assert.equal(recoveredSnapshot.conversation.createdAt.value, "2030-03-22T08:53:20.000Z");
assert.equal(recoveredSnapshot.conversation.updatedAt.value, "2030-03-22T08:55:00.000Z");

// A responsive route with only stale previous-conversation Fibers remains
// quarantined. It cannot start a request or expose the stale canonical range.
let staleRequestCount = 0;
const narrowStale = snapshotHarness({
  url: "https://chatgpt.com/c/narrow-new",
  thread: {
    id: "narrow-old",
    serverId$: () => null,
    create_time: 1_700_000_000,
    update_time: 1_700_000_100,
  },
  sidebar: [],
  messages: [{
    id: "narrow-old-message",
    role: "assistant",
    record: {
      id: "narrow-old-message",
      conversation_id: "narrow-old",
      author: { role: "assistant" },
      create_time: 1_700_000_050,
    },
  }],
  fetch: async () => {
    staleRequestCount += 1;
    throw new Error("stale current page must not fetch");
  },
});
assert.equal(narrowStale.conversation.bindingStatus, "mismatch");
assert.equal(narrowStale.conversation.createdAt.value, null);
assert.equal(narrowStale.conversation.updatedAt.value, null);
assert.equal(staleRequestCount, 0);

// A stale Fiber attached to an href is never allowed to lend its times to a
// different sidebar conversation.
const mismatchedSidebar = snapshotHarness({
  url: "https://chatgpt.com/",
  sidebar: [{
    href: "/c/visible-conversation",
    title: "Visible title",
    record: {
      id: "stale-conversation",
      create_time: 1_700_000_000,
      update_time: 1_700_000_100,
    },
  }],
});
assert.equal(mismatchedSidebar.sidebarConversations[0].bindingStatus, "mismatch");
assert.equal(mismatchedSidebar.sidebarConversations[0].createdAt.value, null);
assert.equal(mismatchedSidebar.sidebarConversations[0].updatedAt.value, null);

const darkPage = snapshotHarness({
  url: "https://chatgpt.com/scheduled",
  backgroundColor: "rgb(0, 0, 0)",
});
assert.deepEqual(darkPage.appearance, {
  colorScheme: "dark",
  source: "computed-style.background",
  status: "available",
  surface: { value: "rgb(0, 0, 0)", source: "computed-style.root.background", status: "available" },
});

console.log("adapter-snapshot assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
