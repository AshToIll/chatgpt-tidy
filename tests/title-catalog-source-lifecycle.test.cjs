const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");

const clone = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
const row = (id, source = "project") => ({ conversationId: id, title: `Synthetic ${id}`, updatedAt: null,
  directoryBounds: { createdAt: null, updatedAt: null, sources: [source] } });
const page = (source, overrides = {}) => ({ schemaVersion: "tidy.date-search.v1", source,
  conversations: [], projects: [], nextCursor: null, done: true, coverageReasons: [], ...overrides });

function harness(readPage) {
  let saved = { state: null, rows: [] }, clock = Date.parse("2026-09-12T00:00:00Z"), timerId = 0;
  const calls = [], updates = [], timers = new Map();
  const repository = {
    async getSnapshot() { return clone(saved); },
    async putState(_account, state) { saved.state = clone(state); },
    async commitPage(_account, value, state) {
      const rows = new Map(saved.rows.map((entry) => [entry.conversationId, entry]));
      for (const entry of value.conversations) rows.set(entry.conversationId, { ...entry,
        createdAt: entry.directoryBounds.createdAt, catalogGeneration: state.generation });
      saved = { state: clone(state), rows: [...rows.values()] };
    },
  };
  const context = vm.createContext({ Intl, structuredClone, document: { hidden: false } });
  vm.runInContext(fs.readFileSync("src/platform/catalog/date-search.js", "utf8"), context);
  for (const [file, name] of [
    ["platform/catalog/ui/conversation-catalog-reader", "createConversationCatalogReader"], ["features/titles/ui/title-catalog", "createTitleCatalog"],
  ]) {
    const source = fs.readFileSync(`src/${file}.js`, "utf8")
      .replace(/^import[^\n]+\n/gm, "").replace(/^export /gm, "");
    vm.runInContext(`(() => { ${source}; globalThis.${name} = ${name}; })()`, context);
  }
  const service = context.createTitleCatalog({ repository, now: () => clock,
    schedule: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: clock + delay }); return id; },
    cancelSchedule: (id) => timers.delete(id),
    requestAdapter: async (action, payload) => {
      if (action === "account") return { schemaVersion: "tidy.date-search.v1", accountKey: "account-one" };
      calls.push(clone(payload));
      return readPage(payload);
    },
  });
  return { calls, service, snapshot: () => clone(saved), latest: () => updates.at(-1),
    async load(options = {}) { await service.load({ ...options, onUpdate: (value) => updates.push(clone(value)) }); await flush(); },
    async expire() {
      clock += 300_000;
      for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.callback(); }
      await flush();
    },
  };
}

for (const previouslyFailed of [false, true]) test(
  `a ${previouslyFailed ? "failed" : "completed"} old project cannot revive without current-generation discovery`, async (t) => {
    let listed = true;
    const h = harness(async ({ source }) => {
      if (source === "projects") return page(source, listed ? { projects: [{ projectId: "removed" }],
        conversations: [row("retained-project-metadata")] } : {});
      if (source === "project") {
        if (previouslyFailed || !listed) throw Object.assign(new Error("Synthetic removed project"), {
          code: "INACCESSIBLE", category: "INACCESSIBLE", status: 404, retryable: false,
        });
        return page(source, { conversations: [row("retained-project-metadata")] });
      }
      return page(source);
    });
    t.after(() => h.service.pause());
    await h.load();
    assert.equal(h.latest().error, previouslyFailed);
    const original = h.snapshot().rows;
    listed = false; h.calls.length = 0;
    if (previouslyFailed) await h.load({ retry: true });
    else await h.expire();
    assert.equal(h.latest().error, false);
    assert.equal(h.latest().phase, "settled");
    assert.equal(h.calls.filter((call) => call.source === "project").length, 0,
      "a saved project checkpoint is not authority to request its endpoint again");
    assert.equal(h.snapshot().state.sources["project:removed"], undefined);
    assert.deepEqual(h.snapshot().rows, original, "refresh retires only the work queue, not saved conversation metadata");
    h.calls.length = 0; await h.expire();
    assert.equal(h.latest().error, false);
    assert.equal(h.calls.filter((call) => call.source === "project").length, 0, "a later refresh cannot resurrect the orphan either");
  },
);

test("project parent pages pass the old head while rediscovered conversations retain their head-refresh savings", async (t) => {
  let refreshed = false;
  const h = harness(async ({ source, projectId, cursor }) => {
    if (source === "projects") return page(source, cursor
      ? { projects: [{ projectId: "old-tail" }] }
      : { projects: [...(refreshed ? [{ projectId: "new-head" }] : []), { projectId: "old-head" }], nextCursor: "parents-2", done: false });
    if (source === "project") return page(source, cursor
      ? { conversations: [row(`${projectId}-tail`)] }
      : { conversations: [row(`${projectId}-head`)], nextCursor: "conversations-2", done: false });
    if (source === "ordinary") return page(source, cursor
      ? { conversations: [row("ordinary-tail", source)] }
      : { conversations: [row("ordinary-head", source)], nextCursor: "ordinary-2", done: false });
    return page(source);
  });
  t.after(() => h.service.pause());
  await h.load(); refreshed = true; h.calls.length = 0; await h.expire();
  assert.equal(h.latest().error, false);
  assert.deepEqual(h.calls.filter((call) => call.source === "projects").map((call) => call.cursor), [null, "parents-2"],
    "membership discovery must not stop after seeing an old head project");
  for (const projectId of ["old-head", "old-tail"]) {
    assert.deepEqual(h.calls.filter((call) => call.projectId === projectId).map((call) => call.cursor), [null],
      "rediscovered old projects use their own conversation head boundary");
    assert.equal(h.snapshot().state.sources[`project:${projectId}`].mode, "head");
  }
  assert.deepEqual(h.calls.filter((call) => call.projectId === "new-head").map((call) => call.cursor), [null, "conversations-2"]);
  assert.deepEqual(h.calls.filter((call) => call.source === "ordinary").map((call) => call.cursor), [null]);
  assert.equal(h.snapshot().state.sources.projects.mode, "full");
  assert.ok(h.snapshot().rows.some((entry) => entry.conversationId === "new-head-tail"));
});

test("a failed parent preserves dormant project hints and metadata, and an explicit retry activates only rediscovered projects", async (t) => {
  let parentUnavailable = false;
  const h = harness(async ({ source, cursor }) => {
    if (source === "projects") {
      if (parentUnavailable) throw Object.assign(new Error("Synthetic offline parent"), {
        code: "NETWORK", category: "NETWORK", retryable: true,
      });
      return page(source, { projects: [{ projectId: "known-project" }] });
    }
    if (source === "project") return page(source, cursor
      ? { conversations: [row("known-tail")] }
      : { conversations: [row("known-head")], nextCursor: "tail", done: false });
    return page(source);
  });
  t.after(() => h.service.pause());
  await h.load();
  const original = h.snapshot().rows;
  parentUnavailable = true; h.calls.length = 0; await h.expire();
  assert.equal(h.latest().error, true);
  assert.deepEqual(h.latest().readErrors.map((error) => error.source), ["projects"]);
  assert.equal(h.snapshot().state.sources["project:known-project"], undefined);
  assert.deepEqual(h.snapshot().state.projectHeadHints["project:known-project"], ["conversation:known-head"]);
  assert.deepEqual(h.snapshot().rows, original, "a failed parent cannot erase any previously read metadata");
  assert.equal(h.calls.filter((call) => call.source === "project").length, 0);
  parentUnavailable = false; h.calls.length = 0; await h.load({ retry: true });
  assert.equal(h.latest().error, false);
  assert.deepEqual(h.calls.map((call) => call.source), ["projects", "project"]);
  assert.equal(h.snapshot().state.sources["project:known-project"].mode, "head");
  assert.ok(h.snapshot().rows.some((entry) => entry.conversationId === "known-tail"));
});

test("current pins discovery independently activates a project and deduplicates the owned-parent observation", async (t) => {
  let listedByPins = true, listedByOwnedParent = false;
  const h = harness(async ({ source }) => {
    if (source === "pins") return page(source, listedByPins ? { projects: [{ projectId: "pinned-project" }] } : {});
    if (source === "projects") return page(source, listedByOwnedParent ? { projects: [{ projectId: "pinned-project" }] } : {});
    if (source === "project") return page(source, { conversations: [row("pinned-project-head")] });
    return page(source);
  });
  t.after(() => h.service.pause());
  await h.load();
  assert.ok(h.snapshot().state.sources["project:pinned-project"], "pins is an independent current membership observation");
  listedByOwnedParent = true; h.calls.length = 0; await h.expire();
  assert.equal(h.latest().error, false);
  assert.equal(h.calls.filter((call) => call.source === "project").length, 1);
  assert.equal(h.snapshot().state.sources["project:pinned-project"].mode, "head");
  listedByPins = false; listedByOwnedParent = false; h.calls.length = 0; await h.expire();
  assert.equal(h.latest().error, false);
  assert.equal(h.calls.filter((call) => call.source === "project").length, 0);
  assert.ok(h.snapshot().rows.some((entry) => entry.conversationId === "pinned-project-head"));
});
