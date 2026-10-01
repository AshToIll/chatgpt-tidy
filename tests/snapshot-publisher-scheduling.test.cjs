const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Run the production owner on a deterministic elapsed clock, not a replacement
// publisher. This reproduces a token stream that never leaves a 120 ms gap.
function harness({ retryable = false } = {}) {
  let now = 0, nextTimer = 0, active = true, identityChecks = 0;
  const timers = new Map(), reads = [], events = [];
  const state = { route: { pathname: "/c/a" }, appearance: { colorScheme: "light", surface: { value: null } },
    conversation: { conversationId: "a", title: { value: "New chat" }, createdAt: { value: null }, updatedAt: { value: null } },
    sidebarConversations: [], messages: [], adapter: { retryable, responseInProgress: false } };
  class ClockDate extends Date { static now() { return now; } }
  const context = vm.createContext({ Date: ClockDate,
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: now + delay, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    TidyProtocol: { Type: { SNAPSHOT_UPDATED: "snapshot.updated" }, event: (type, payload) => ({ type, payload }) },
    TidyPageSession: { check: () => active },
    TidyChatgptApi: { checkLibraryIdentity() { identityChecks++; } },
  });
  const source = path.resolve(__dirname, "../src/platform/chatgpt/snapshot-publisher.js");
  vm.runInContext(fs.readFileSync(source, "utf8"), context, { filename: source });
  const publisher = context.TidyChatgptSnapshotPublisher.create({
    readSnapshot() { reads.push(now); return structuredClone(state); },
    postEnvelope(envelope) { events.push({ at: now, ...envelope }); },
  });
  function advance(ms) {
    const target = now + ms;
    let turns = 0;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      assert.ok(++turns < 1000, "scheduler must not create a polling loop");
      const [id, timer] = due; now = timer.at; timers.delete(id); timer.fn();
    }
    now = target;
  }
  return { publisher, state, events, reads, timers, advance,
    get identityChecks() { return identityChecks; },
    retire() { active = false; },
    token(text) { state.messages = [{ messageId: "answer", timestamp: { value: null }, order: { displayNumber: 2 }, excerpt: { value: text } }]; },
  };
}

test("continuous 100 ms native changes deliver busy within the first window and completion after the last change", () => {
  const h = harness(); h.publisher.publish("initial");
  h.state.adapter.responseInProgress = true;
  h.state.conversation.title.value = "Current title";
  for (let token = 0; token < 50; token++) {
    h.token(String(token)); h.publisher.schedule("dom-mutation"); h.advance(100);
    if (token === 1) {
      assert.equal(h.events.length, 2, "busy must publish while streaming, not after silence");
      assert.equal(h.events[1].at, 120);
      assert.equal(h.events[1].payload.snapshot.adapter.responseInProgress, true);
      assert.equal(h.events[1].payload.snapshot.conversation.title.value, "Current title");
    }
  }
  assert.equal(h.reads.length, 26, "50 native events coalesce into 25 bounded reads, not one read per token");
  h.state.adapter.responseInProgress = false;
  h.token("complete"); h.publisher.schedule("dom-mutation"); h.advance(120);
  assert.equal(h.events.at(-1).payload.snapshot.adapter.responseInProgress, false);
  assert.equal(h.events.at(-1).payload.snapshot.messages[0].excerpt.value, "complete");
  assert.equal(h.timers.size, 0);
  const reads = h.reads.length; h.advance(60_000); assert.equal(h.reads.length, reads, "idle pages never self-poll");
});

test("later ordinary changes keep the first deadline while publication reads the latest state", () => {
  const h = harness(); h.publisher.schedule("first"); h.advance(100);
  h.state.conversation.title.value = "Latest"; h.publisher.schedule("later");
  h.advance(19); assert.equal(h.reads.length, 0);
  h.advance(1); assert.deepEqual(h.reads, [120]);
  assert.equal(h.events[0].payload.snapshot.conversation.title.value, "Latest");
  assert.equal(h.timers.size, 0); assert.equal(h.identityChecks, 2);
});

test("short route requests advance a pending DOM window and ordinary changes cannot delay or relabel it", () => {
  const h = harness(); h.publisher.schedule("dom-mutation"); h.advance(20);
  h.publisher.schedule("spa-route", 30); h.advance(10); h.publisher.schedule("dom-mutation");
  h.advance(19); assert.equal(h.reads.length, 0);
  h.advance(1); assert.deepEqual(h.reads, [50]);
  assert.equal(h.events[0].payload.reason, "spa-route"); assert.equal(h.timers.size, 0);
});

test("zero-delay accepted metadata advances a pending route publication without inline reentrancy", () => {
  const h = harness(); h.publisher.schedule("spa-route", 30); h.advance(10);
  h.publisher.schedule("current-conversation-metadata", 0); h.publisher.schedule("dom-mutation");
  assert.equal(h.reads.length, 0, "schedule(0) remains asynchronous");
  h.advance(0); assert.deepEqual(h.reads, [10]);
  assert.equal(h.events[0].payload.reason, "current-conversation-metadata");
});

test("a later short request never moves an already earlier deadline backwards", () => {
  const h = harness(); h.publisher.schedule("dom-mutation"); h.advance(110);
  h.publisher.schedule("spa-route", 30); h.advance(10);
  assert.deepEqual(h.reads, [120]); assert.equal(h.timers.size, 0);
});

test("explicit publish supersedes a queued window and invalidates its already captured callback", () => {
  const h = harness(); h.publisher.schedule("dom-mutation");
  const staleCallback = [...h.timers.values()][0].fn;
  h.advance(20); h.publisher.publish("manual-refresh");
  assert.equal(h.timers.size, 0); assert.deepEqual(h.reads, [20]);
  h.state.conversation.title.value = "Should wait";
  staleCallback(); h.advance(500); assert.deepEqual(h.reads, [20]);
  assert.equal(h.events[0].payload.reason, "manual-refresh");
});

test("an accelerated window invalidates the captured callback from the superseded deadline", () => {
  const h = harness(); h.publisher.schedule("dom-mutation");
  const staleCallback = [...h.timers.values()][0].fn;
  h.advance(10); h.publisher.schedule("current-conversation-numbers", 0);
  staleCallback(); assert.equal(h.reads.length, 0, "a replaced timer cannot flush the new window");
  h.advance(0); assert.deepEqual(h.reads, [10]);
  assert.equal(h.events[0].payload.reason, "current-conversation-numbers");
});

test("successive identical windows keep fingerprint deduplication and do not create retries", () => {
  const h = harness();
  for (let n = 0; n < 3; n++) { h.publisher.schedule("dom-mutation"); h.advance(120); }
  assert.equal(h.reads.length, 3); assert.equal(h.events.length, 1); assert.equal(h.timers.size, 0);
});

test("inactive documents reject new schedules and direct publication before identity or snapshot reads", () => {
  const h = harness(); h.retire(); h.publisher.schedule("late"); h.publisher.publish("late");
  assert.equal(h.identityChecks, 0); assert.equal(h.reads.length, 0); assert.equal(h.timers.size, 0);
});

test("retirement rejects a queued window without creating any follow-up work", () => {
  const h = harness({ retryable: true }); h.publisher.schedule("late"); h.retire(); h.advance(120);
  assert.equal(h.reads.length, 0); assert.equal(h.events.length, 0); assert.equal(h.timers.size, 0);
});

test("dispose clears refresh plus bounded retry and captured callbacks cannot revive the publisher", () => {
  const h = harness({ retryable: true }); h.publisher.publish("initial"); h.publisher.schedule("pending");
  const callbacks = [...h.timers.values()].map(timer => timer.fn);
  assert.equal(callbacks.length, 2); h.publisher.dispose(); h.publisher.dispose();
  for (const callback of callbacks) callback();
  h.publisher.schedule("disposed"); h.publisher.publish("disposed");
  assert.equal(h.timers.size, 0); assert.equal(h.reads.length, 1); assert.equal(h.events.length, 1);
});

test("refresh coalescing preserves the six-attempt exponential retry limit and explicit route reset", () => {
  const h = harness({ retryable: true }); h.publisher.publish("initial");
  for (const delay of [350, 700, 1400, 2800, 4000, 4000]) {
    assert.equal([...h.timers.values()][0].delay, delay); h.advance(delay);
  }
  assert.equal(h.reads.length, 7); assert.equal(h.events.length, 1); assert.equal(h.timers.size, 0);
  h.publisher.resetRetry(); h.publisher.schedule("spa-route", 30); h.advance(30);
  assert.equal([...h.timers.values()][0].delay, 350);
  h.state.adapter.retryable = false; h.publisher.publish("bound");
  assert.equal(h.timers.size, 0); const count = h.reads.length; h.advance(60_000); assert.equal(h.reads.length, count);
  h.state.adapter.retryable = true; h.publisher.publish("needs-binding-again");
  assert.equal([...h.timers.values()][0].delay, 350);
});

test("a bounded retry reading fresh data supersedes a pending native refresh without duplicate reads", () => {
  const h = harness({ retryable: true }); h.publisher.publish("initial"); h.advance(300);
  h.publisher.schedule("dom-mutation"); h.advance(50);
  assert.deepEqual(h.reads, [0, 350]);
  assert.equal(h.timers.size, 1, "only the next bounded retry should remain");
  assert.equal([...h.timers.values()][0].delay, 700);
  h.advance(70); assert.deepEqual(h.reads, [0, 350]);
});
