const assert = require("node:assert/strict");
const nodeTest = require("node:test");
const test = (name, run) => nodeTest(name, { timeout: 5000 }, run);
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");
const { createPanelRuntime } = require("./helpers/panel-runtime.cjs");

const ACCOUNT = "synthetic-query-handoff", clone = value => structuredClone(value);
const page = (source, id = null, cursor = null) => ({
  schemaVersion: "tidy.date-search.v1", source, projects: [], nextCursor: cursor, done: cursor === null,
  coverageReasons: [], conversations: id ? [{ conversationId: id, title: id, updatedAt: null,
    directoryBounds: { createdAt: null, updatedAt: null, sources: [source] } }] : [],
});
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };

async function harness(t) {
  const runtime = createPanelRuntime({ indexedDB: new IDBFactory(), IDBKeyRange });
  runtime.load("src/platform/catalog/date-search.js");
  const { openTidyDatabase } = runtime.load("src/platform/storage/database.js");
  const { createConversationCatalogRepository } = runtime.load("src/platform/catalog/storage/conversation-catalog.js");
  const { createConversationCatalogReader } = runtime.load("src/platform/catalog/ui/conversation-catalog-reader.js");
  const db = await openTidyDatabase(runtime.context.indexedDB);
  const options = { openDatabase: async () => db };
  const repository = createConversationCatalogRepository(options), other = createConversationCatalogRepository(options);
  const calls = [], statuses = [], hooks = {}, releases = [];
  let account = ACCOUNT, visible = true;
  const reader = createConversationCatalogReader({
    repository: {
      async getSnapshot(key) {
        const value = await repository.getSnapshot(key);
        await hooks.afterSnapshot?.(key, value);
        return value;
      },
      async commitPage(key, value, state) {
        await hooks.beforeCommit?.(key, value, state);
        await repository.commitPage(key, value, state);
        await hooks.afterCommit?.(key, value, state);
      },
      async putState(key, state) {
        await hooks.beforeState?.(key, state);
        await repository.putState(key, state);
        await hooks.afterState?.(key, state);
      },
    },
    canDispatch: () => visible,
    onStatus: value => statuses.push(clone(value)),
    requestAdapter: async (action, payload) => {
      if (action === "account") return { schemaVersion: "tidy.date-search.v1", accountKey: account };
      calls.push(clone(payload));
      return hooks.sourcePage ? hooks.sourcePage(payload) : page(payload.source);
    },
  });
  t.after(async () => { releases.forEach(release => release()); await reader.pause(); db.close(); });
  return { reader, repository, other, hooks, calls, statuses,
    setAccount: value => { account = value; }, setVisible: value => { visible = value; },
    hold(fallback) { const value = gate(); releases.push(() => value.resolve(fallback)); return value; },
  };
}

async function beginLatePage(h, source = "ordinary") {
  const waiting = h.hold(page(source, "late", "third")), began = gate();
  h.hooks.sourcePage = async payload => {
    if (payload.source !== source) return page(payload.source);
    if (payload.cursor === null) return page(source, "first", "second");
    if (payload.cursor === "second") { began.resolve(); return waiting.promise; }
    return page(source, "last");
  };
  await h.reader.read({ sessionId: "old" }); await began.promise;
  return waiting;
}
function ordinaryCursors(h) { return h.calls.filter(call => call.source === "ordinary").map(call => call.cursor); }

for (const sessions of [["new"], ["one", "two", "new"]]) test(
  "replacement queries continue their own late page without manual refresh: " + sessions.join(" -> "), async t => {
    const h = await harness(t), waiting = await beginLatePage(h);
    for (const sessionId of sessions) { h.reader.pause(); await h.reader.read({ sessionId }); }
    const mark = h.statuses.length;
    waiting.resolve(page("ordinary", "late", "third")); await h.reader.whenIdle();
    assert.equal(h.reader.status().phase, "settled");
    assert.equal(h.reader.status().resultStable, true);
    assert.equal(h.reader.status().sessionId, "new");
    assert.ok(h.statuses.slice(mark).every(status => status.sessionId === "new" && status.pauseReason !== "catalog-superseded"));
    assert.deepEqual(ordinaryCursors(h), [null, "second", "third"], "continue the accepted cursor, never reread old pages");
    assert.deepEqual((await h.repository.getSnapshot(ACCOUNT)).rows.map(row => row.conversationId).sort(), ["first", "last", "late"]);
  },
);

test("handoff still works when the predecessor finishes while the replacement snapshot is waiting", async t => {
  const h = await harness(t), waiting = await beginLatePage(h), captured = gate(), readback = h.hold();
  h.reader.pause();
  let held = false;
  h.hooks.afterSnapshot = async (_account, value) => {
    if (!held && value.state?.sources.ordinary.cursor === "second") {
      held = true; captured.resolve(); await readback.promise;
    }
  };
  const replacement = h.reader.read({ sessionId: "new" });
  await captured.promise;
  waiting.resolve(page("ordinary", "late", "third"));
  await h.reader.whenIdle(); // The old owner no longer exists when start() is reached.
  readback.resolve(); await replacement; await h.reader.whenIdle();
  assert.equal(h.reader.status().resultStable, true);
  assert.equal(h.reader.status().sessionId, "new");
  assert.deepEqual(ordinaryCursors(h), [null, "second", "third"]);
});

test("a last late page completes the replacement view even when no source request remains", async t => {
  const h = await harness(t);
  await h.reader.read({ sessionId: "seed" }); await h.reader.whenIdle();
  const saved = clone((await h.repository.getSnapshot(ACCOUNT)).state);
  Object.assign(saved.sources.ordinary, { done: false, cursor: null, signatures: [], seenCursors: [] });
  Object.assign(saved, { phase: "paused", completedAt: null, revision: saved.revision + 1 });
  await h.repository.putState(ACCOUNT, saved);
  const waiting = await beginLatePage(h);
  h.reader.pause(); await h.reader.read({ sessionId: "new" });
  const calls = h.calls.length, mark = h.statuses.length;
  waiting.resolve(page("ordinary", "last")); await h.reader.whenIdle();
  assert.equal(h.calls.length, calls);
  assert.equal(h.reader.status().sessionId, "new");
  assert.equal(h.reader.status().phase, "settled");
  assert.equal(h.reader.status().resultStable, true);
  assert.ok(h.statuses.slice(mark).every(status => status.sessionId === "new" && !status.pauseReason));
  const cached = await h.reader.read({ sessionId: "new", refresh: true });
  assert.equal(cached.status.phase, "settled");
  assert.equal(cached.status.resultStable, true, "cache refresh cannot undo the completed handoff");
});

for (const stop of ["pause", "hide", "empty"]) test(
  "a " + stop + " after queuing replacement revokes handoff without auto-resume", async t => {
    const h = await harness(t), waiting = await beginLatePage(h);
    h.reader.pause(); await h.reader.read({ sessionId: "new" });
    if (stop === "pause") h.reader.pause();
    else if (stop === "hide") h.setVisible(false);
    else await h.reader.read({ sessionId: "empty", empty: true });
    const mark = h.statuses.length;
    waiting.resolve(page("ordinary", "late", "third")); await h.reader.whenIdle();
    assert.deepEqual(ordinaryCursors(h), [null, "second"]);
    assert.equal(h.statuses.length, mark, "accepted cached data cannot restore a retired view");
    assert.equal((await h.repository.getSnapshot(ACCOUNT)).state.sources.ordinary.cursor, "third");
  },
);

test("late pages stay in their original account while a different account starts independently", async t => {
  const h = await harness(t), waiting = await beginLatePage(h);
  h.reader.pause(); h.setAccount("synthetic-other");
  const originalHandler = h.hooks.sourcePage;
  h.hooks.sourcePage = payload => payload.accountKey === ACCOUNT
    ? originalHandler(payload) : page(payload.source, payload.source === "ordinary" ? "other-only" : null);
  await h.reader.read({ sessionId: "other" });
  const mark = h.statuses.length;
  waiting.resolve(page("ordinary", "late", "third")); await h.reader.whenIdle();
  assert.ok(h.statuses.slice(mark).every(status => status.accountKey === "synthetic-other" && status.sessionId === "other"));
  assert.deepEqual((await h.repository.getSnapshot("synthetic-other")).rows.map(row => row.conversationId), ["other-only"]);
  assert.deepEqual(ordinaryCursors(h), [null, "second", null]);
});

for (const change of ["revision", "generation", "same-version-cursor", "same-version-error", "same-version-phase"]) test(
  "a foreign " + change + " checkpoint must not acquire the local handoff receipt", async t => {
    const h = await harness(t), waiting = await beginLatePage(h);
    let winner;
    h.hooks.afterState = async (account, state) => {
      if (state.phase !== "paused" || state.sources.ordinary.cursor !== "third") return;
      winner = clone(state);
      if (change === "revision") winner.revision++;
      if (change === "generation") { winner.generation++; winner.revision++; }
      if (change === "same-version-cursor") winner.sources.ordinary.cursor = "foreign-cursor";
      if (change === "same-version-phase") winner.phase = "loading";
      if (change === "same-version-error") {
        winner.pauseReason = "rate-limited";
        winner.sources.ordinary.error = { code: "HTTP", category: "HTTP", status: 429, retryable: true };
      }
      await h.other.putState(account, winner);
    };
    h.reader.pause(); await h.reader.read({ sessionId: "new" });
    waiting.resolve(page("ordinary", "late", "third")); await h.reader.whenIdle();
    assert.deepEqual(ordinaryCursors(h), [null, "second"], "foreign progress cannot start another competing scan");
    assert.equal(h.reader.status().pauseReason, "catalog-superseded");
    const actual = clone((await h.repository.getSnapshot(ACCOUNT)).state);
    delete actual.key; delete actual.accountKey;
    delete winner.key; delete winner.accountKey;
    assert.deepEqual(actual, winner, "the winner's checkpoint remains unchanged");
  },
);

test("a failed local page write cannot certify a foreign checkpoint as its own", async t => {
  const h = await harness(t), waiting = await beginLatePage(h);
  h.hooks.beforeCommit = async (account, _page, state) => {
    if (state.sources.ordinary.cursor !== "third") return;
    await h.other.putState(account, state);
    throw Object.assign(new Error("Synthetic failed local transaction"), { code: "STORAGE_ERROR" });
  };
  h.reader.pause(); await h.reader.read({ sessionId: "new" });
  waiting.resolve(page("ordinary", "late", "third")); await h.reader.whenIdle();
  assert.deepEqual(ordinaryCursors(h), [null, "second"]);
  assert.equal(h.reader.status().pauseReason, "catalog-superseded");
});

for (const failure of [
  { code: "HTTP", category: "HTTP", status: 429, retryable: true },
  { code: "ACCOUNT_MISMATCH", category: "ACCOUNT_MISMATCH", retryable: false },
]) test("a delayed " + failure.code + " failure checkpoint never becomes successful handoff progress", async t => {
  const h = await harness(t), persisted = gate(), waiting = h.hold();
  let second;
  h.hooks.sourcePage = async ({ source, cursor }) => {
    if (source !== "ordinary") return page(source);
    if (cursor === null) return page(source, "first", "second");
    throw Object.assign(new Error("Synthetic active failure"), failure);
  };
  h.hooks.beforeState = async (_account, state) => {
    if (state.sources.ordinary.error && !second) {
      second = clone(state); persisted.resolve(); await waiting.promise;
    }
  };
  await h.reader.read({ sessionId: "old" }); await persisted.promise;
  h.reader.pause(); await h.reader.read({ sessionId: "new" });
  waiting.resolve(); await h.reader.whenIdle();
  assert.deepEqual(ordinaryCursors(h), [null, "second"]);
  assert.equal(h.calls.length, 2, "a saved stop reason cannot restart another directory source");
  assert.equal(h.reader.status().resultStable, false);
  assert.ok(h.reader.status().readErrors.some(error => error.code === failure.code));
});
