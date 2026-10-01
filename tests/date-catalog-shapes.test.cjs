const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { installPageSession } = require("./helpers/page-session.cjs");

const root = path.resolve(__dirname, "..");
const CREATED = "2026-09-04T08:00:00.000Z";
const UPDATED = "2026-09-05T08:00:00.000Z";

function load() {
  const context = vm.createContext({
    Date, Intl, URL, URLSearchParams, Headers, AbortController, setTimeout, clearTimeout, encodeURIComponent,
    TidyChatgptApi: { loadSession: async () => ({ activeAccountId: "test-account" }), fetchAuthenticated() {} },
  });
  const apiStub = context.TidyChatgptApi;
  installPageSession(context);
  delete context.TidyChatgptApi;
  vm.runInContext(fs.readFileSync(path.join(root, "src/platform/chatgpt/api.js"), "utf8"), context);
  context.TidyChatgptApi = { ...context.TidyChatgptApi, ...apiStub };
  for (const file of ["src/platform/catalog/date-search.js", "src/platform/chatgpt/messages.js", "src/platform/catalog/chatgpt/date-index.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  }
  return { adapter: context.TidyChatgptDateIndex, contract: context.TidyDateSearch };
}

// Sanitized fixtures preserve the actual HAR nesting and metadata field types.
// IDs and text are synthetic; no raw HAR response is checked into these tests.
function conversation(id, overrides = {}) {
  return {
    id, title: "Fixture conversation", create_time: CREATED, update_time: UPDATED,
    latest_assistant_turn_created_at: null, pinned_time: null, mapping: null, current_node: null,
    conversation_template_id: null, gizmo_id: null, is_archived: false, is_starred: null,
    is_temporary_chat: false, is_do_not_remember: false, memory_scope: "global",
    context_scopes: null, context_scopes_v2: null, workspace_id: null, async_status: null,
    safe_urls: [], blocked_urls: [], conversation_origin: null, is_automation_conversation: false,
    snippet: null, summary_metadata: null, sugar_item_id: null, sugar_item_visible: false,
    ...overrides,
  };
}

function projectWrapper(projectId) {
  return { gizmo: { id: projectId, gizmo_type: "snorlax" }, tools: [], files: [], product_features: {} };
}

function sidebarItem(projectId, items, cursor = null) {
  return { gizmo: projectWrapper(projectId), conversations: { items, cursor } };
}

function normalize(adapter, source, raw, extra = {}) {
  return adapter.normalizeSourceResponse(raw, { source, cursor: null, ...extra });
}

test("native pins item_type/item yields conversations and project contexts without inventing feature chats", () => {
  const { adapter } = load();
  const result = normalize(adapter, "pins", [
    { item_type: "feature", item: { id: "library-feature" }, pinned_at: UPDATED },
    { item_type: "project", item: projectWrapper("g-p-fixture"), pinned_at: UPDATED },
    { item_type: "conversation", item: conversation("pinned-chat", { is_starred: true }), pinned_at: UPDATED },
  ]);
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].conversationId, "pinned-chat");
  assert.equal(result.conversations[0].projectId, null);
  assert.deepEqual(structuredClone(result.conversations[0].directoryBounds.sources), ["pins"]);
  assert.deepEqual(structuredClone(result.projects), [{ projectId: "g-p-fixture" }]);
  assert.equal(result.done, true);
});

test("native sidebar double-gizmo and conversations.items preserve empty projects and embedded conversations", () => {
  const { adapter } = load();
  const result = normalize(adapter, "projects", { items: [
    sidebarItem("g-p-one", [conversation("project-chat", { gizmo_id: "g-p-one", owner: { user_id: "fixture-user" } })], "next-project-page"),
    sidebarItem("g-p-empty", []),
  ], cursor: "next-sidebar-page" });
  assert.deepEqual(structuredClone(result.projects), [{ projectId: "g-p-one" }, { projectId: "g-p-empty" }]);
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].projectId, "g-p-one");
  assert.deepEqual(structuredClone(result.conversations[0].directoryBounds.sources), ["project"]);
  assert.equal(result.nextCursor, "next-sidebar-page");
});

test("project conversation endpoint carries the requested context and directory bounds", () => {
  const { adapter } = load();
  const result = normalize(adapter, "project", { items: [
    conversation("project-chat", { gizmo_id: "g-p-project" }),
  ], cursor: null }, { projectId: "g-p-project" });
  const candidate = result.conversations[0];
  assert.equal(candidate.projectId, "g-p-project");
  assert.equal(candidate.updatedAt, Date.parse(UPDATED));
  assert.deepEqual(structuredClone(candidate.directoryBounds), {
    createdAt: Date.parse(CREATED), updatedAt: Date.parse(UPDATED), sources: ["project"],
  });
});

test("an explicit terminal project cursor ends even when the native page is exactly full", () => {
  const { adapter } = load();
  // The captured endpoint schema is { items, cursor: string | null }. This
  // boundary fixture is entirely synthetic; null must not become offset "5".
  const items = Array.from({ length: 5 }, (_, index) => conversation(`terminal-chat-${index}`));
  for (const cursor of [null, "0", "opaque-current-page"]) {
    const result = normalize(adapter, "project", { items, cursor: null }, { projectId: "g-p-terminal", cursor });
    assert.equal(result.nextCursor, null);
    assert.equal(result.done, true);
    assert.equal(result.conversations.length, 5);
  }
});

test("an explicit terminal sidebar cursor does not invent a numeric project catalog continuation", () => {
  const { adapter } = load();
  const items = Array.from({ length: 20 }, (_, index) => sidebarItem(`g-p-terminal-${index}`, []));
  const result = normalize(adapter, "projects", { items, cursor: null });
  assert.equal(result.nextCursor, null);
  assert.equal(result.done, true);
  assert.equal(result.projects.length, 20);
});

test("an explicit next_cursor null is terminal instead of falling through to another cursor field", () => {
  const { adapter } = load();
  const result = normalize(adapter, "project", {
    items: Array.from({ length: 5 }, (_, index) => conversation(`next-terminal-${index}`)),
    next_cursor: null, cursor: "current-page-not-a-continuation",
  }, { projectId: "g-p-terminal" });
  assert.equal(result.nextCursor, null);
  assert.equal(result.done, true);
});

test("ordinary and archived offset totals continue correctly when cursor fields are absent", () => {
  const { adapter } = load();
  for (const [source, pageSize] of [["ordinary", 28], ["archived", 30]]) {
    const first = normalize(adapter, source, {
      items: Array.from({ length: pageSize }, (_, index) => conversation(`${source}-${index}`)),
      offset: 0, limit: pageSize, total: pageSize + 1,
    });
    assert.equal(first.nextCursor, String(pageSize));
    assert.equal(first.done, false);
    const last = normalize(adapter, source, {
      items: [conversation(`${source}-last`)], offset: pageSize, limit: pageSize, total: pageSize + 1,
    }, { cursor: first.nextCursor });
    assert.equal(last.nextCursor, null);
    assert.equal(last.done, true);
  }
});

test("opaque native continuations remain unchanged and repeated live cursors still fail closed", () => {
  const { adapter } = load();
  const raw = { items: [conversation("continuation-chat")], cursor: "opaque-next-page" };
  const result = normalize(adapter, "project", raw, { projectId: "g-p-continuation" });
  assert.equal(result.nextCursor, "opaque-next-page");
  assert.equal(result.done, false);
  assert.throws(() => normalize(adapter, "project", raw, {
    projectId: "g-p-continuation", cursor: "opaque-next-page",
  }), /cursor repeated/);
});

test("ordinary metadata exposes conversation timestamps without retired message-range eligibility flags", () => {
  const { adapter } = load();
  const candidate = normalize(adapter, "ordinary", { items: [conversation("ordinary")], total: 1 }).conversations[0];
  assert.deepEqual(structuredClone(candidate.directoryBounds), {
    createdAt: Date.parse(CREATED), updatedAt: Date.parse(UPDATED), sources: ["ordinary"],
  });
  assert.equal(candidate.projectId, null);
  assert.equal(candidate.updatedAt, Date.parse(UPDATED));
});

test("missing or malformed times stay null while reversed fields remain independent metadata", () => {
  const { adapter } = load();
  const result = normalize(adapter, "ordinary", { items: [
    conversation("missing", { create_time: null, update_time: null }),
    conversation("malformed", { create_time: true, update_time: "not a date" }),
    conversation("reversed", { create_time: UPDATED, update_time: CREATED }),
    conversation("seconds", { create_time: Date.parse(CREATED) / 1000, update_time: Date.parse(UPDATED) / 1000 }),
  ], total: 4 });
  assert.equal(result.conversations.length, 4);
  for (const candidate of result.conversations.slice(0, 2)) {
    assert.equal(candidate.directoryBounds.createdAt, null);
    assert.equal(candidate.directoryBounds.updatedAt, null);
    assert.equal(candidate.updatedAt, null);
  }
  assert.equal(result.conversations[2].directoryBounds.createdAt, Date.parse(UPDATED));
  assert.equal(result.conversations[2].directoryBounds.updatedAt, Date.parse(CREATED));
  assert.equal(result.conversations[3].directoryBounds.createdAt, Date.parse(CREATED));
});

test("special state and origin do not gate directory inclusion or invent a project header", () => {
  const { adapter } = load();
  for (const overrides of [
    { is_temporary_chat: true }, { is_automation_conversation: true },
    { is_do_not_remember: true }, { conversation_template_id: "template-fixture" },
    { workspace_id: "workspace-fixture" }, { gizmo_id: "g-custom-gpt" },
  ]) {
    const candidate = normalize(adapter, "ordinary", { items: [conversation("special", overrides)], total: 1 }).conversations[0];
    assert.equal(candidate.conversationId, "special");
    assert.equal(candidate.directoryBounds.createdAt, Date.parse(CREATED));
    assert.equal(candidate.projectId, null, "custom GPT context is not a project header");
  }
  // Only tpp is present in the captured project sample. Other origin strings
  // are synthetic unknowns, not claims about supported native origin enums.
  for (const origin of ["tpp", "fork", "import"]) {
    const candidate = normalize(adapter, "ordinary", { items: [conversation("origin", { conversation_origin: origin })], total: 1 }).conversations[0];
    assert.equal(candidate.conversationId, "origin");
    assert.equal(candidate.directoryBounds.createdAt, Date.parse(CREATED));
  }
  const archived = normalize(adapter, "archived", { items: [conversation("archived", { is_archived: true })], total: 1 }).conversations[0];
  assert.deepEqual(structuredClone(archived.directoryBounds.sources), ["archived"]);
});

test("requested native project context is not overwritten by candidate gizmo metadata", () => {
  const { adapter } = load();
  const result = normalize(adapter, "project", { items: [conversation("mismatch", {
    gizmo_id: "g-p-other", is_temporary_chat: null,
  })], cursor: null }, { projectId: "g-p-requested" });
  const candidate = result.conversations[0];
  assert.equal(candidate.projectId, "g-p-requested");
  assert.equal(candidate.directoryBounds.updatedAt, Date.parse(UPDATED));
});

test("retired pins and single-gizmo/array project shapes fail visibly rather than silently dropping items", () => {
  const { adapter } = load();
  const badShapes = [
    ["pins", { items: [{ item_type: "conversation", item: conversation("one") }] }],
    ["pins", [conversation("one")]],
    ["projects", { items: [{ gizmo: { id: "g-p-old" }, conversations: [] }] }],
    ["projects", { items: [{ gizmo: projectWrapper("g-p-one"), conversations: [] }] }],
    ["ordinary", [conversation("one")]],
    ["ordinary", { items: [{ conversation: conversation("one") }], total: 1 }],
  ];
  for (const [source, raw] of badShapes) {
    assert.throws(() => normalize(adapter, source, raw), (error) => error.category === "SCHEMA" && error.retryable === false);
  }
});

test("shared candidate contract validates directory metadata without message-range proof fields", () => {
  const { contract } = load();
  const valid = { createdAt: null, updatedAt: null, sources: ["ordinary"] };
  assert.equal(contract.validateDirectoryBounds(valid), true);
  for (const bounds of [
    null, [], { ...valid, createdAt: "2026-09-05" }, { ...valid, updatedAt: Infinity },
    { ...valid, sources: [] }, { ...valid, sources: ["projects"] }, { ...valid, sources: ["ordinary", "ordinary"] },
    { ...valid, observedGeneration: 1 }, { updatedAt: null, sources: ["ordinary"] },
  ]) assert.equal(contract.validateDirectoryBounds(bounds), false);
  const source = { schemaVersion: contract.VERSION, source: "ordinary", conversations: [{
    conversationId: "candidate", title: "Fixture", updatedAt: null,
  }], projects: [], nextCursor: null, done: true, coverageReasons: [] };
  assert.equal(contract.validateSourcePage(source), true, "omitted metadata remains an unknown candidate");
  source.conversations[0].directoryBounds = valid;
  assert.equal(contract.validateSourcePage(source), true);
  source.conversations[0].directoryBounds = { ...valid, sources: ["projects"] };
  assert.equal(contract.validateSourcePage(source), false);
});
