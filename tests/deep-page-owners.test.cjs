const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const pure = ["active-branch", "native-message-references", "native-message-content", "native-message-process", "conversation-projection"];
function load(context, name) {
  const file = "src/platform/chatgpt/" + name + ".js";
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
}
const flush = async () => { for (let i = 0; i < 18; i++) await Promise.resolve(); };
const plain = value => JSON.parse(JSON.stringify(value));
function payload(id = "a") {
  return { conversation_id: id, title: "Title", create_time: 1, update_time: 3, current_node: "answer", mapping: {
    root: { parent: null },
    user: { parent: "root", message: { id: "u", author: { role: "user" }, create_time: 1, content: { parts: ["Question"] } } },
    thought: { parent: "user", message: { id: "r", author: { role: "assistant" }, create_time: 2,
      content: { content_type: "thoughts", thoughts: [{ summary: "**Plan**", content: "Details" }] } } },
    answer: { parent: "thought", message: { id: "a", author: { role: "assistant" }, create_time: 3, content: { parts: ["Answer"] } } },
  } };
}

test("native canonical projection is independent of feature contracts and groups process IDs identically", () => {
  const context = vm.createContext({ URL });
  for (const file of pure) load(context, file);
  const projection = context.TidyChatgptConversationProjection;
  assert.deepEqual(plain(projection.messageNumbersFromPayload(payload(), "a")), { u: 1, a: 2, r: 2 });
  const projected = projection.projectConversation(payload(), "a");
  assert.equal(projected.conversation.messages.length, 2);
  assert.equal(projected.conversation.messages[1].segments[0].blocks[0].text, "Plan");
  assert.equal(context.TidyExportContract, undefined);
  assert.equal(context.TidyChatgptExport, undefined);
  assert.equal(context.TidyPageSession, undefined);
});

test("canonical numbers reject wrong owners, incomplete ancestry and cyclic active branches", () => {
  const context = vm.createContext({ URL });
  for (const file of pure) load(context, file);
  const numbers = context.TidyChatgptConversationProjection.messageNumbersFromPayload;
  assert.throws(() => numbers(payload(), "other"), /changed/);
  const incomplete = payload(); delete incomplete.mapping.user;
  assert.throws(() => numbers(incomplete, "a"), /incomplete/);
  const cyclic = payload(); cyclic.mapping.root.parent = "answer";
  assert.throws(() => numbers(cyclic, "a"), /cyclic/);
});

function metadataHarness() {
  let route = { kind: "conversation", conversationId: "a", projectId: null };
  let active = true;
  const requests = [], changes = [];
  const context = vm.createContext({ URL, encodeURIComponent, document: { cookie: "_account=one" }, fetch() {},
    TidyChatgptRoute: { parse: () => route, isDraftId: id => id.startsWith("WEB:") },
    TidyChatgptBinding: { BindingStatus: { BOUND: "bound" } },
    TidyPageSession: { assertActive() { if (!active) throw Error("retired"); } },
    TidyChatgptApi: { fetchAuthenticated: url => new Promise(resolve => requests.push({ url, resolve })) },
  });
  for (const file of [...pure, "snapshot-metadata"]) load(context, file);
  const owner = context.TidyChatgptSnapshotMetadata.create({
    routeStillOwnsConversation: id => route.conversationId === id, onChanged: (...args) => changes.push(args),
  });
  const sync = () => owner.syncScope(route);
  sync();
  return { context, owner, requests, changes, sync,
    read: (unnumbered = []) => owner.ensure({ conversationId: route.conversationId, bindingStatus: "bound" }, route, unnumbered),
    route: id => { route = { ...route, conversationId: id }; sync(); },
    retire: () => { active = false; owner.dispose(); },
    respond: (index, value = payload()) => requests[index].resolve({ ok: true, json: async () => value }),
  };
}

test("metadata owns only lightweight canonical projection, reusing one read for dates and numbering", async () => {
  const h = metadataHarness(); h.read([{ id: "u", status: "finished" }]); h.read(); await flush();
  assert.equal(h.requests.length, 1);
  h.respond(0); await flush();
  assert.equal(h.owner.cached("a").value.title, "Title");
  assert.deepEqual(plain(h.owner.messageNumbers().numbers), { u: 1, a: 2, r: 2 });
  assert.equal(h.owner.messageNumbers().records.u.content, undefined);
  assert.equal(h.changes.length, 1);
  h.read([{ id: "u", status: "finished" }]); await flush();
  assert.equal(h.requests.length, 1);
  h.read([{ id: "new", status: "in_progress" }]); await flush();
  assert.equal(h.requests.length, 2);
});

test("metadata optional-read failure is sticky only for its exact route/workspace scope", async () => {
  const h = metadataHarness(); h.read(); await flush();
  h.requests[0].resolve({ ok: false, status: 429 }); await flush();
  for (let i = 0; i < 10; i++) { h.sync(); h.read([{ id: "new", status: "finished" }]); }
  await flush(); assert.equal(h.requests.length, 1);
  h.context.document.cookie = "_account=two"; h.sync(); h.read(); await flush();
  assert.equal(h.requests.length, 2);
});

test("metadata rejects late replies after leaving and returning to the same route", async () => {
  const h = metadataHarness(); h.read(); await flush(); h.route("b"); h.route("a");
  h.respond(0); await flush();
  assert.equal(h.owner.cached("a"), null); assert.equal(h.owner.messageNumbers(), null);
  assert.equal(h.changes.length, 0);
});

test("metadata rejects workspace-stale and retired replies without republishing", async () => {
  const h = metadataHarness(); h.read(); await flush();
  h.context.document.cookie = "_account=two"; h.respond(0); await flush();
  assert.equal(h.owner.cached("a"), null); assert.equal(h.changes.length, 0);
  h.read(); await flush(); h.retire(); h.respond(1); await flush();
  assert.equal(h.owner.messageNumbers(), null); assert.equal(h.changes.length, 0);
});

test("metadata can publish canonical numbering without fabricating missing conversation dates", async () => {
  const h = metadataHarness(); h.read([{ id: "u", status: "finished" }]); await flush();
  const value = payload(); delete value.create_time; delete value.update_time;
  h.respond(0, value); await flush();
  assert.equal(h.owner.cached("a"), null);
  assert.equal(h.owner.messageNumbers().numbers.u, 1);
  assert.equal(h.changes[0][0], "current-conversation-numbers");
  h.read([{ id: "u", status: "finished" }]); await flush(); assert.equal(h.requests.length, 1);
});

function timers() {
  let next = 0; const pending = new Map();
  return { pending, setTimeout(fn, delay) { const id = ++next; pending.set(id, { fn, delay }); return id; },
    clearTimeout(id) { pending.delete(id); },
    fire() { const [id, { fn }] = pending.entries().next().value; pending.delete(id); fn(); },
  };
}
function snapshot(retryable = false) {
  return { route: { pathname: "/c/a" }, appearance: { colorScheme: "light", surface: { value: null } },
    conversation: { conversationId: "a", title: { value: "Title" }, createdAt: { value: null }, updatedAt: { value: null } },
    sidebarConversations: [], messages: [], adapter: { retryable, responseInProgress: false } };
}

test("publisher alone owns debounce, fingerprint deduplication and retirement timer cancellation", () => {
  const clock = timers(), posted = []; let checks = 0;
  const context = vm.createContext({ ...clock, TidyProtocol: { Type: { SNAPSHOT_UPDATED: "snapshot" }, event: (...args) => args },
    TidyPageSession: { check: () => true }, TidyChatgptApi: { checkLibraryIdentity: () => checks++ } });
  load(context, "snapshot-publisher");
  const owner = context.TidyChatgptSnapshotPublisher.create({ readSnapshot: () => snapshot(), postEnvelope: value => posted.push(value) });
  owner.schedule("one"); owner.schedule("two"); assert.equal(clock.pending.size, 1); assert.equal(checks, 2);
  clock.fire(); owner.publish("same"); assert.equal(posted.length, 1);
  owner.schedule("late"); const queued = [...clock.pending.values()][0].fn;
  owner.dispose(); queued(); assert.equal(clock.pending.size, 0); assert.equal(posted.length, 1);
});

test("publisher retries are bounded and a native route explicitly resets the budget", () => {
  const clock = timers(); const context = vm.createContext({ ...clock,
    TidyProtocol: { Type: {}, event: () => ({}) }, TidyPageSession: { check: () => true }, TidyChatgptApi: { checkLibraryIdentity() {} } });
  load(context, "snapshot-publisher");
  let reads = 0; const owner = context.TidyChatgptSnapshotPublisher.create({ readSnapshot: () => { reads++; return snapshot(true); }, postEnvelope() {} });
  owner.publish("initial"); for (let i = 0; i < 6; i++) clock.fire();
  assert.equal(reads, 7); assert.equal(clock.pending.size, 0);
  owner.resetRetry(); owner.publish("route"); assert.equal(clock.pending.size, 1); owner.dispose();
});

test("native observer restores only its own history wrappers and queued work cannot revive it", () => {
  const clock = timers(), listeners = new Map(), observers = [], refreshes = [], microtasks = [];
  const target = () => ({ addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); } });
  const native = function () { return "native-result"; };
  const context = vm.createContext({ ...clock, ...target(), queueMicrotask: fn => microtasks.push(fn),
    document: { ...target(), documentElement: {} }, history: { pushState: native, replaceState: native },
    TidyPageSession: { check: () => true }, TidyDomOwnership: { areOnlyTidyOwnedMutations: () => false },
    TidyChatgptApi: { checkLibraryIdentity() {} }, MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe(_target, options) { this.options = options; } disconnect() { this.stopped = true; } },
  });
  load(context, "native-observer");
  let routes = 0; const owner = context.TidyChatgptNativeObserver.create({ onRefresh: (...args) => refreshes.push(args),
    onRoute: () => routes++, onHidden() {}, onMessage() {} });
  assert.equal(observers[0].options.attributes, true);
  assert.ok(observers[0].options.attributeFilter.includes("aria-hidden"), "native task-link identity changes must refresh the snapshot");
  observers[0].callback([{ type: "attributes", attributeName: "aria-hidden", target: {} }]);
  assert.equal(refreshes.at(-1)[0], "dom-mutation");
  assert.equal(context.history.pushState(), "native-result"); microtasks.shift()(); assert.equal(routes, 1);
  const wrapped = context.history.pushState; const later = (...args) => wrapped(...args); context.history.pushState = later;
  owner.dispose(); const count = refreshes.length;
  for (const observer of observers) { assert.equal(observer.stopped, true); observer.callback([]); }
  later(); assert.equal(microtasks.length, 0); assert.equal(refreshes.length, count);
  assert.equal(context.history.pushState, later); assert.equal(context.history.replaceState, native);
  assert.equal(listeners.get("message").size, 0);
});

test("shared projection rejects duplicate logical IDs before either numbering or export can accept them", () => {
  const context = vm.createContext({ URL });
  for (const file of pure) load(context, file);
  const projection = context.TidyChatgptConversationProjection;
  const value = payload();
  value.mapping.answer.message.author.role = "user";
  value.mapping.answer.message.id = "u";
  for (const project of [projection.projectConversation, projection.messageNumbersFromPayload]) {
    assert.throws(() => project(value, "a"), /duplicateId/);
  }
});

test("shared projection keeps invalid native identity and unreadable process records fail-closed", () => {
  const context = vm.createContext({ URL });
  for (const file of pure) load(context, file);
  const project = context.TidyChatgptConversationProjection.projectConversation;
  assert.throws(() => project(payload(), " "), /conversation.id/);
  const value = payload();
  value.mapping.thought.message = { id: "r", author: { role: "assistant" }, recipient: "all",
    content: { content_type: "thoughts" }, metadata: { title: " " } };
  assert.throws(() => project(value, "a"), /emptyProcess/);
});
