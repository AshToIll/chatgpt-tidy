const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const { snapshotHarness } = require("./helpers/adapter-snapshot.cjs");

const plain = value => JSON.parse(JSON.stringify(value));
const message = (id, role, turnIndex) => ({ id, role, turnIndex, record: { id,
  conversation_id: "numbering", author: { role }, create_time: 1_900_000_000,
  content: { parts: [`Unchanged content for ${id}`] } } });
function read(messages) {
  return snapshotHarness({ url: "https://chatgpt.com/c/numbering", thread: { id: "numbering", serverId$: () => null },
    sidebar: [{ href: "/c/numbering", title: "Numbering", record: { id: "numbering", title: "Numbering" } }], messages });
}
function readFunction(file, name, nextName, globals) {
  const source = fs.readFileSync(file, "utf8");
  const start = source.indexOf(`function ${name}(`), end = source.indexOf(`function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext(globals);
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.result = ${name};`, context);
  return context.result;
}

test("virtualization cannot promote any exact-record turnIndex to an unproven global number", () => {
  const full = [message("older-user", "user", 11), message("older-assistant", "assistant", 12),
    message("late-user", "user", 13), message("late-assistant", "assistant", undefined),
    message("later-user", "user", 15), message("later-assistant", "assistant", undefined)];
  const before = read(full), after = read(full.slice(2));
  assert.deepEqual(after.messages.map(item => item.order.index), [0, 1, 2, 3]);
  assert.deepEqual(after.messages.map(item => item.order.displayNumber), [null, null, null, null]);
  for (const current of after.messages) {
    const previous = before.messages.find(item => item.messageId === current.messageId);
    assert.equal(current.order.displayNumber, previous.order.displayNumber);
    assert.equal(current.order.source, null);
    assert.equal(current.timestamp.value, previous.timestamp.value);
    assert.equal(current.excerpt.value, previous.excerpt.value);
    assert.equal(current.idStatus, "stable");
  }
});

test("even a positive safe index bound to the exact record has no independent global proof", () => {
  // The retired test treated exact-record ownership as proof of global order.
  // It proves message identity only: a turnIndex can still be branch/local.
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "13", null, undefined, 1, 13]) {
    const current = read([message("user", "user", value)]).messages[0];
    assert.equal(current.order.displayNumber, null, `Unproven native turn index ${value}`);
    assert.equal(current.order.source, null);
  }
  const unrelated = message("user", "user", undefined);
  unrelated.ancestorProps = [{ turnIndex: 77, message: { id: "another-message" } }, { turnIndex: 88 }];
  assert.equal(read([unrelated]).messages[0].order.displayNumber, null, "an unrelated ancestor is not this message's ordinal");
  const exact = message("user", "user", undefined);
  exact.ancestorProps = [{ turnIndex: 13, messages: [exact.record] }];
  assert.equal(read([exact]).messages[0].order.displayNumber, null);
});

test("mixed assistant 12/14/16 and user 3/5 sources never become displayed global ordinals", () => {
  const input = [message("assistant-a", "assistant", 12), message("user-a", "user", 3),
    message("assistant-b", "assistant", 14), message("user-b", "user", 5), message("assistant-c", "assistant", 16)];
  const observed = read(input);
  assert.deepEqual(observed.messages.map(item => item.order.displayNumber), [null, null, null, null, null]);
  assert.deepEqual(observed.messages.map(item => item.order.source), [null, null, null, null, null]);
  assert.deepEqual(observed.messages.map(item => item.role), input.map(item => item.role));
  assert.deepEqual(observed.messages.map(item => item.messageId), input.map(item => item.id));
  assert.ok(observed.messages.every(item => item.timestamp.value && item.excerpt.value));
});

test("apparently contiguous or role-specific indices do not manufacture a global proof", () => {
  for (const role of ["user", "assistant", "system", "tool"]) {
    const observed = read([message("first", role, 1), message("second", role, 2), message("third", role, 3)]);
    assert.deepEqual(observed.messages.map(item => item.order.displayNumber), [null, null, null], role);
    assert.deepEqual(observed.messages.map(item => item.order.index), [0, 1, 2]);
    assert.ok(observed.messages.every(item => item.role === role));
  }
});

test("exact calpico records and branch-like message arrays remain unproven sources", () => {
  for (const shape of ["message", "calpicoMessage", "messages"]) {
    const exact = message("selected", "assistant", undefined);
    const branchSibling = { ...exact.record, id: "alternate-version", parent: "same-parent" };
    exact.record.parent = "same-parent";
    exact.ancestorProps = [{ turnIndex: 14, [shape]: shape === "messages" ? [branchSibling, exact.record] : exact.record }];
    const observed = read([exact]);
    assert.equal(observed.messages[0].order.displayNumber, null, shape);
    assert.equal(observed.messages[0].order.source, null, shape);
    assert.equal(observed.messages[0].messageId, "selected");
  }
});

test("page and Side Panel omit unknown numbers while retaining existing time content", () => {
  const preferences = { messageNumbersEnabled: true, timeDisplayEnabled: true };
  const formatMessageMeta = readFunction("src/features/time/chatgpt/time-presentation.js", "formatMessageMeta", "renderMessages", {
    preferences, baseFormatOptions: () => ({}), timeFormat: { formatDateTime: () => "unchanged time" },
  });
  const number = readFunction("src/features/time/ui/time-view.js", "messageNumber", "messageTime", { preferences });
  for (const displayNumber of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "13"]) {
    const current = { order: { index: 1, displayNumber }, timestamp: { value: "2030-03-17T17:46:40Z" } };
    assert.deepEqual(plain(formatMessageMeta(current)), ["unchanged time"]);
    assert.equal(number(current), "");
  }
  const current = { order: { index: 0, displayNumber: 13 }, timestamp: { value: "2030-03-17T17:46:40Z" } };
  assert.deepEqual(plain(formatMessageMeta(current)), ["#13", "unchanged time"]); assert.equal(number(current), "#13");
});

test("new bookmarks keep unproven numbers null and a metadata refresh preserves saved notes", async () => {
  const domain = await import("../src/features/bookmarks/storage/bookmarks-domain.js");
  const observed = read([message("known", "user", 13), message("unknown", "assistant", undefined)]);
  let store = domain.createEmptyBookmarksState();
  store = domain.addBookmarkFromSnapshot(store, observed, "known");
  store = domain.addBookmarkFromSnapshot(store, observed, "unknown");
  assert.equal(store.items["numbering::known"].orderNumber, null);
  assert.equal(store.items["numbering::unknown"].orderIndex, 1);
  assert.equal(store.items["numbering::unknown"].orderNumber, null);
  // Synthetic old record only: this test never reads or migrates saved data.
  store.items["numbering::known"].orderNumber = 13;
  store.items["numbering::known"].note = "Preserve the saved note";
  const unavailable = plain(observed);
  unavailable.messages[0].order = { index: 8, displayNumber: null, source: null };
  const refreshed = domain.refreshBookmarksFromSnapshot(store, unavailable);
  assert.equal(refreshed.items["numbering::known"].orderNumber, null);
  assert.equal(refreshed.items["numbering::known"].note, "Preserve the saved note");
  assert.equal(refreshed.items["numbering::known"].messageId, "known");
  for (const orderNumber of [0, -1, Number.MAX_SAFE_INTEGER + 1, "13"]) {
    const malformed = plain(store); malformed.items["numbering::unknown"].orderNumber = orderNumber;
    assert.equal(domain.normalizeBookmarksState(malformed).items["numbering::unknown"].orderNumber, null);
  }
});

function canonicalPayload(records) {
  const mapping = { root: { id: "root", parent: null, message: null } };
  let parent = "root";
  for (const record of records) {
    mapping[record.id] = { id: record.id, parent, message: record };
    parent = record.id;
  }
  return { conversation_id: "numbering", title: "Numbering", create_time: 1_900_000_000,
    update_time: 1_900_000_100, current_node: parent, mapping };
}
const flushCanonical = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
function numberedPage(mounted, payload) {
  const calls = [];
  const h = snapshotHarness({ url: "https://chatgpt.com/c/numbering", returnSession: true,
    sessionFixture: { user: { id: "snapshot-fixture" }, accessToken: "fixture-token" },
    thread: { id: "numbering", serverId$: () => null }, messages: mounted,
    fetch: async (url, options) => {
      calls.push(url);
      assert.equal(url, "/backend-api/conversation/numbering");
      assert.equal(options.headers.get("Authorization"), "Bearer fixture-token", "Canonical read uses shared authentication");
      return { ok: true, json: async () => typeof payload === "function" ? payload() : payload };
    } });
  h.readSnapshot();
  return { ...h, calls };
}

test("complete canonical sequence restores 12/13/14/15/16 despite a partial DOM and wrong Fiber indices", async () => {
  const full = Array.from({ length: 16 }, (_, i) => message(`m${i + 1}`, i % 2 ? "assistant" : "user", i + 1));
  const mounted = full.slice(11).map((m, i) => ({ ...m, turnIndex: i + 1 }));
  const h = numberedPage(mounted, canonicalPayload(full.map(m => m.record)));
  await flushCanonical();
  const snapshot = h.readSnapshot();
  assert.deepEqual(snapshot.messages.map(m => m.order.displayNumber), [12, 13, 14, 15, 16]);
  assert.ok(snapshot.messages.every(m => m.order.source === "chatgpt-api.canonical-active-branch"));
  for (let i = 0; i < 30; i++) h.readSnapshot();
  assert.equal(h.calls.length, 1, "One conversation read, not one request per message or snapshot");
  h.setLocation("https://chatgpt.com/c/another-conversation"); h.readSnapshot();
  h.setLocation("https://chatgpt.com/c/numbering");
  assert.deepEqual(h.readSnapshot().messages.map(m => m.order.displayNumber), [12, 13, 14, 15, 16]);
  assert.equal(h.calls.length, 1, "Returning to a warm conversation reuses its numbers with its metadata");
  const domain = await import("../src/features/bookmarks/storage/bookmarks-domain.js");
  const store = domain.addBookmarkFromSnapshot(domain.createEmptyBookmarksState(), snapshot, "m13");
  assert.equal(store.items["numbering::m13"].orderNumber, 13);
  assert.equal(store.items["numbering::m13"].orderNumberSource, "chatgpt-api.canonical-active-branch");
});

test("assistant analysis and final source records share one reply number; hidden records consume none", async () => {
  const u1 = message("u1", "user", 1), thinking = message("thinking", "assistant", 87), a1 = message("a1", "assistant", 88);
  thinking.record.channel = "analysis";
  const hidden = message("hidden", "assistant", 90); hidden.record.metadata = { is_visually_hidden_from_conversation: true };
  const u2 = message("u2", "user", 1), a2 = message("a2", "assistant", 2);
  const h = numberedPage([thinking, a1, u2, a2], canonicalPayload([u1, thinking, hidden, a1, u2, a2].map(m => m.record)));
  await flushCanonical();
  assert.deepEqual(h.readSnapshot().messages.map(m => m.order.displayNumber), [2, 2, 3, 4]);
});

test("canonical numbering follows the selected branch and rejects an incomplete chain", async () => {
  const u = message("u", "user", 1), old = message("old", "assistant", 2), selected = message("selected", "assistant", 200);
  const payload = canonicalPayload([u.record, selected.record]);
  payload.mapping.old = { id: "old", parent: "u", message: old.record };
  const h = numberedPage([old, selected], payload); await flushCanonical();
  assert.deepEqual(h.readSnapshot().messages.map(m => m.order.displayNumber), [null, 2]);
  const broken = canonicalPayload([u.record, selected.record]); delete broken.mapping.u;
  const invalid = numberedPage([selected], broken); await flushCanonical();
  assert.equal(invalid.readSnapshot().messages[0].order.displayNumber, null);
  assert.notEqual(invalid.readSnapshot().conversation.createdAt.value, null, "Broken numbering does not remove valid dates");
});

test("new reply and generation completion refresh the sequence without polling streaming tokens", async () => {
  const u = message("u", "user", 1), a = message("a", "assistant", 2);
  let payload = canonicalPayload([u.record, a.record]);
  const h = numberedPage([u, a], () => payload); await flushCanonical();
  const next = message("next", "user", 1), generating = message("generating", "assistant", 2);
  generating.record.status = "in_progress";
  payload = canonicalPayload([u.record, a.record, next.record]);
  h.setMessages([next, generating]); h.readSnapshot(); await flushCanonical();
  assert.deepEqual(h.readSnapshot().messages.map(m => m.order.displayNumber), [3, null]);
  for (let i = 0; i < 30; i++) { generating.record.content.parts = [`Streaming token ${i}`]; h.readSnapshot(); }
  await flushCanonical(); assert.equal(h.calls.length, 2, "No per-token or per-snapshot reads");
  generating.record.status = "finished_successfully";
  payload = canonicalPayload([u.record, a.record, next.record, generating.record]);
  h.readSnapshot(); await flushCanonical();
  assert.deepEqual(h.readSnapshot().messages.map(m => m.order.displayNumber), [3, 4]);
  assert.equal(h.calls.length, 3, "One new semantic completion, one canonical read");
});

test("canonical numbers do not require dates and can still advance to a new message", async () => {
  const u = message("u", "user", 1), a = message("a", "assistant", 2);
  const payload = canonicalPayload([u.record]); delete payload.create_time; delete payload.update_time;
  const h = numberedPage([u], payload); await flushCanonical();
  assert.equal(h.readSnapshot().messages[0].order.displayNumber, 1);
  Object.assign(payload, { mapping: canonicalPayload([u.record, a.record]).mapping, current_node: "a" });
  h.setMessages([u, a]); h.readSnapshot(); await flushCanonical();
  assert.deepEqual(h.readSnapshot().messages.map(m => m.order.displayNumber), [1, 2]);
  assert.equal(h.readSnapshot().conversation.createdAt.value, null);
  assert.equal(h.calls.length, 2);
});

test("bookmark rows display proven live or saved numbers, including selection mode and the preference toggle", () => {
  const model = { preferences: { messageNumbersEnabled: true }, store: { groups: [] },
    snapshot: { conversation: { conversationId: "numbering" }, messages: [{ messageId: "a", order: { displayNumber: 14, source: "chatgpt-api.canonical-active-branch" } }] } };
  const row = readFunction("src/features/bookmarks/ui/bookmarks-view.js", "bookmarkRow", "pagination", {
    model, formatMessageTime: () => "time", escapeHtml: String, openEntryId: null,
  });
  const item = { bookmarkId: "numbering::a", conversationId: "numbering", messageId: "a", role: "assistant", excerpt: "content",
    orderNumber: 999, orderNumberSource: null };
  assert.match(row(item, true, value => value), /<span>#14<\/span>/);
  model.exportSelection = { active: true, draftIds: [] };
  assert.match(row(item, true, value => value), /<span>#14<\/span>/);
  model.snapshot.messages = []; item.orderNumber = 14; item.orderNumberSource = "chatgpt-api.canonical-active-branch";
  assert.match(row(item, true, value => value), /<span>#14<\/span>/);
  model.preferences.messageNumbersEnabled = false;
  assert.doesNotMatch(row(item, true, value => value), /#14/);
});
