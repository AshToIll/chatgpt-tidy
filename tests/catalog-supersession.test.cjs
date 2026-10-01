const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");

globalThis.IDBKeyRange = IDBKeyRange;
const ACCOUNT = "synthetic-catalog-owner";
const VERSION = "tidy.date-search.v1";
const clone = (value) => structuredClone(value);
const emptyPage = (source) => ({ schemaVersion: VERSION, source, conversations: [], projects: [], nextCursor: null,
  done: true, coverageReasons: [] });
const sourceState = (source) => ({ source, projectId: null, cursor: null, done: false, seenCursors: [],
  signatures: [], error: null, coverageReasons: [], mode: "full", boundaryIds: [], headIds: [] });
const checkpoint = (overrides = {}) => ({ catalogVersion: 2, generation: 1, revision: 1, pages: 0,
  phase: "paused", pauseReason: null, snapshotStartedAt: 1, lastObservedAt: null, completedAt: null,
  sources: Object.fromEntries(["ordinary", "archived", "pins", "projects"].map((source) => [source, sourceState(source)])),
  projectHeadHints: {}, ...overrides });
const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function until(predicate) {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await new Promise(setImmediate);
  assert.ok(predicate(), "synthetic asynchronous boundary was reached");
}

async function harness(t) {
  const { openTidyDatabase } = await import("../src/platform/storage/database.js");
  const { createConversationCatalogRepository } = await import("../src/platform/catalog/storage/conversation-catalog.js");
  const db = await openTidyDatabase(new IDBFactory());
  t.after(() => db.close());
  const options = { openDatabase: async () => db };
  const repository = createConversationCatalogRepository(options), other = createConversationCatalogRepository(options);
  const hooks = {}, calls = [], updates = [], timers = new Map();
  let timerId = 0, currentAccount = ACCOUNT;
  const wrapped = {
    async getSnapshot(account) {
      await hooks.beforeSnapshot?.(account);
      return repository.getSnapshot(account);
    },
    async commitPage(account, page, state) {
      await repository.commitPage(account, page, state);
      await hooks.afterCommit?.(account, page, state);
    },
    async putState(account, state) {
      await hooks.beforeState?.(account, state);
      return repository.putState(account, state);
    },
  };
  const document = { hidden: false };
  const context = vm.createContext({ Intl, structuredClone, document });
  vm.runInContext(fs.readFileSync("src/platform/catalog/date-search.js", "utf8"), context);
  for (const file of ["conversation-catalog-reader", "title-catalog"]) {
    const source = fs.readFileSync(file === "title-catalog" ? "src/features/titles/ui/title-catalog.js" : "src/platform/catalog/ui/conversation-catalog-reader.js", "utf8")
      .replace(/^import[^\n]+\n/gm, "").replace(/^export /gm, "");
    vm.runInContext(`(() => { ${source}; globalThis.${file === "title-catalog" ? "createTitleCatalog = createTitleCatalog" : "createConversationCatalogReader = createConversationCatalogReader"}; })()`, context);
  }
  const requestAdapter = async (action, payload) => {
    if (action === "account") return { schemaVersion: VERSION, accountKey: currentAccount };
    calls.push(clone(payload));
    if (hooks.sourcePage) return hooks.sourcePage(payload);
    return { ...emptyPage(payload.source), conversations: payload.source === "ordinary"
      ? Array.from({ length: 681 }, (_, index) => ({ conversationId: `synthetic-${index}`, title: "Synthetic title",
        updatedAt: null, directoryBounds: { createdAt: null, updatedAt: null, sources: ["ordinary"] } })) : [] };
  };
  const reader = context.createConversationCatalogReader({ repository: wrapped, requestAdapter,
    onStatus: (status, snapshot) => updates.push({ status: clone(status), snapshot: clone(snapshot) }),
  });
  const title = context.createTitleCatalog({ repository: wrapped, requestAdapter, now: () => 1_000_000,
    schedule: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    cancelSchedule: (id) => timers.delete(id),
  });
  t.after(async () => { await reader.pause(); await title.pause(); });
  return { db, reader, title, repository, other, hooks, calls, updates, timers, document,
    setAccount: (value) => { currentAccount = value; },
  };
}

test("a newer durable checkpoint rejects stale rows with CATALOG_SUPERSEDED, not a storage outage", async (t) => {
  const h = await harness(t);
  const newer = checkpoint({ generation: 3, revision: 8 });
  await h.other.putState(ACCOUNT, newer);
  await assert.rejects(h.repository.putState(ACCOUNT, checkpoint({ generation: 3, revision: 7 })), (error) => {
    assert.equal(error.code, "CATALOG_SUPERSEDED");
    assert.equal(error.expectedRevision, 7); assert.equal(error.observedRevision, 8);
    return true;
  });
  await assert.rejects(h.repository.commitPage(ACCOUNT, { ...emptyPage("ordinary"), conversations: [{
    conversationId: "stale-row", title: "Must not be written", updatedAt: null,
  }] }, checkpoint({ generation: 2, revision: 99 })), (error) => error.code === "CATALOG_SUPERSEDED");
  const snapshot = await h.repository.getSnapshot(ACCOUNT);
  assert.equal(snapshot.state.generation, 3); assert.equal(snapshot.state.revision, 8);
  assert.equal(snapshot.rows.length, 0);
});

test("a competing final checkpoint retains 681 rows as paused newer progress without a read failure", async (t) => {
  const h = await harness(t);
  h.hooks.afterCommit = async (account, page, state) => {
    if (page.source === "projects") await h.other.putState(account, { ...state, revision: state.revision + 1 });
  };
  await h.reader.read({ sessionId: "one" }); await h.reader.whenIdle();
  const latest = h.updates.at(-1);
  assert.equal(latest.snapshot.rows.length, 681);
  assert.equal(latest.status.phase, "paused");
  assert.equal(latest.status.pauseReason, "catalog-superseded");
  assert.deepEqual(latest.status.readErrors, []);
  assert.ok(h.updates.every(update => !update.status.failureNotice), "clean supersession is control flow, not a new failure");
  assert.equal(latest.status.resultStable, false, "done source pages are not proof that the other owner finalized its run");
  assert.equal((await h.repository.getSnapshot(ACCOUNT)).state.phase, "loading", "observing another run cannot rewrite its phase");
  assert.equal(h.calls.length, 4);
});

test("supersession observed after a page commit stops further source requests and preserves newer errors", async (t) => {
  const h = await harness(t);
  const sourceError = { source: "pins", code: "HTTP", category: "HTTP", status: 429, retryable: true,
    message: "Synthetic newer source error", stage: "source-fetch" };
  h.hooks.afterCommit = async (account, page, state) => {
    if (page.source !== "ordinary") return;
    const newer = clone(state);
    newer.revision++; newer.phase = "paused"; newer.pauseReason = "rate-limited";
    newer.sources.pins.error = sourceError;
    await h.other.putState(account, newer);
  };
  await h.reader.read({ sessionId: "one" }); await h.reader.whenIdle();
  const latest = h.updates.at(-1);
  assert.equal(h.calls.length, 1, "old progress cannot issue another source GET after observing a newer checkpoint");
  assert.equal(latest.snapshot.rows.length, 681);
  assert.deepEqual(latest.status.readErrors, [sourceError]);
  assert.equal(latest.status.errorOrigin, "previous");
  assert.ok(h.updates.every(update => !update.status.failureNotice), "another owner's saved error is not this reader's failure event");
  assert.equal(latest.status.phase, "paused");
});

test("Titles may show a proven completed newer snapshot but never schedule an automatic competing refresh", async (t) => {
  const h = await harness(t), results = [];
  h.hooks.afterCommit = async (account, page, state) => {
    if (page.source !== "projects") return;
    await h.other.putState(account, { ...state, revision: state.revision + 1, phase: "settled", completedAt: 1 });
  };
  await h.title.load({ onUpdate: (value) => results.push(clone(value)) });
  await until(() => results.at(-1)?.phase === "settled" || results.at(-1)?.error === true);
  const latest = results.at(-1);
  assert.equal(latest.phase, "settled"); assert.equal(latest.error, false);
  assert.equal(latest.pauseReason, "catalog-superseded");
  assert.equal(latest.loading, false); assert.equal(latest.rows.length, 681);
  assert.equal(h.timers.size, 0, "even an expired complete snapshot cannot restart the superseded owner");
  assert.equal(h.calls.length, 4);
});

test("a details object containing only a stage cannot erase top-level error diagnostics", async (t) => {
  const h = await harness(t);
  h.hooks.sourcePage = async ({ source }) => {
    if (source === "ordinary") throw Object.assign(new Error("Synthetic transport error"), {
      name: "SyntheticTransportError", code: "NETWORK", category: "NETWORK", status: 503, retryable: true,
      details: { stage: "adapter.synthetic" },
    });
    return emptyPage(source);
  };
  await h.reader.read({ sessionId: "one" }); await h.reader.whenIdle();
  const error = h.updates.at(-1).status.readErrors[0];
  assert.equal(error.code, "NETWORK"); assert.equal(error.category, "NETWORK"); assert.equal(error.status, 503);
  assert.equal(error.name, "SyntheticTransportError"); assert.equal(error.retryable, true);
  // The real transport boundary determines recovery; generic source-fetch must not erase it.
  assert.equal(error.stage, "adapter.synthetic"); assert.equal(error.message, "Synthetic transport error");
});

// Inject the competing checkpoint inside the real repository's final write
// boundary. Unlike afterCommit, this exercises the rejected-write rebase path,
// not just early detection during the post-page snapshot observation.
function supersedeAtFinalWrite(h, onSuperseded = () => {}) {
  let injected = false;
  h.hooks.beforeState = async (account, state) => {
    if (injected || state.phase !== "settled") return;
    injected = true;
    await h.other.putState(account, { ...state, revision: state.revision + 1, phase: "loading", completedAt: null });
    await onSuperseded(account, state);
  };
}

test("the real final-write fence rebases once without rewriting the winning checkpoint", async (t) => {
  const h = await harness(t);
  let recoveryReads = 0;
  supersedeAtFinalWrite(h, () => { h.hooks.beforeSnapshot = async () => { recoveryReads++; }; });
  await h.reader.read({ sessionId: "one" }); await h.reader.whenIdle();
  assert.equal(recoveryReads, 1);
  const latest = h.updates.at(-1);
  assert.equal(latest.status.pauseReason, "catalog-superseded"); assert.deepEqual(latest.status.readErrors, []);
  assert.equal(latest.snapshot.rows.length, 681); assert.equal(latest.status.phase, "paused");
  assert.equal((await h.repository.getSnapshot(ACCOUNT)).state.phase, "loading");
  assert.equal(h.calls.length, 4);
});

for (const replacement of ["hide", "pause", "session", "same-session-epoch", "account"]) test(
  `a ${replacement} change while the newer snapshot waits blocks superseded publication`, async (t) => {
    const h = await harness(t), hold = gate();
    let reading = false;
    supersedeAtFinalWrite(h, () => {
      h.hooks.beforeSnapshot = async (account) => {
        if (account !== ACCOUNT || reading) return;
        reading = true; await hold.promise;
      };
    });
    await h.reader.read({ sessionId: "one" });
    try {
      await until(() => reading);
      if (replacement === "hide") h.document.hidden = true;
      else if (replacement === "pause") h.reader.pause();
      else {
        if (replacement === "account") h.setAccount("synthetic-other-owner");
        await h.reader.read({ sessionId: replacement === "session" ? "two" : "one" });
      }
      const mark = h.updates.length;
      hold.resolve(); await h.reader.whenIdle();
      if (replacement === "account") {
        assert.ok(h.updates.slice(mark).every(({ status }) => status.accountKey === "synthetic-other-owner"
          && status.pauseReason !== "catalog-superseded"), "only the replacement account's own new run may publish");
        assert.equal(h.updates.at(-1).status.accountKey, "synthetic-other-owner");
      } else assert.equal(h.updates.length, mark, "a departing observation must not publish into a replacement or hidden consumer");
    } finally { hold.resolve(); await h.reader.whenIdle(); }
  },
);

test("hiding before the supersession fence prevents even the recovery snapshot read", async (t) => {
  const h = await harness(t);
  let recoveryReads = 0;
  supersedeAtFinalWrite(h, () => {
    h.document.hidden = true;
    h.hooks.beforeSnapshot = async () => { recoveryReads++; };
  });
  await h.reader.read({ sessionId: "one" }); await h.reader.whenIdle();
  assert.equal(recoveryReads, 0);
  assert.ok(h.updates.every(({ status }) => status.readErrors.length === 0));
});

test("a genuine recovery read failure remains a storage error with the last 681 rows and its stage", async (t) => {
  const h = await harness(t);
  supersedeAtFinalWrite(h, () => { h.hooks.beforeSnapshot = async () => { h.db.close(); }; });
  await h.reader.read({ sessionId: "one" }); await h.reader.whenIdle();
  const latest = h.updates.at(-1), error = latest.status.readErrors[0];
  assert.equal(latest.snapshot.rows.length, 681);
  assert.equal(error.code, "STORAGE_ERROR"); assert.equal(error.name, "InvalidStateError");
  assert.equal(error.stage, "checkpoint-rebase"); assert.equal(latest.status.phase, "paused");
  assert.notEqual(latest.status.pauseReason, "catalog-superseded", "failed recovery cannot claim that synchronization succeeded");
});

test("a refresh-reset fence observes the newer generation without launching a competing scan", async (t) => {
  const h = await harness(t);
  await h.reader.read({ sessionId: "one" }); await h.reader.whenIdle();
  h.calls.length = 0;
  h.hooks.beforeState = async (account, state) => {
    if (state.pages === 0) await h.other.putState(account, { ...state, generation: state.generation + 1,
      revision: state.revision + 1, phase: "loading" });
  };
  await h.reader.refreshCatalog({ full: false });
  const latest = h.updates.at(-1);
  assert.equal(latest.status.pauseReason, "catalog-superseded"); assert.equal(latest.status.phase, "paused");
  assert.equal(latest.snapshot.rows.length, 681); assert.deepEqual(latest.status.readErrors, []);
  assert.equal(h.calls.length, 0);
});

for (const failure of [
  { code: "HTTP", category: "HTTP", status: 429, retryable: true },
  { code: "ACCOUNT_MISMATCH", category: "ACCOUNT_MISMATCH", status: null, retryable: false },
]) test(`${failure.code}/${failure.status} followed by a failed error-checkpoint never loses the real stop reason`, async (t) => {
  const h = await harness(t);
  h.hooks.sourcePage = async ({ source }) => {
    if (source === "ordinary") throw Object.assign(new Error("Synthetic current source failure"), failure);
    return emptyPage(source);
  };
  h.hooks.beforeState = async (account, state) => {
    if (!state.sources.ordinary.error) return;
    const newer = clone(state);
    newer.revision++; newer.sources.ordinary.error = null; newer.phase = "loading"; newer.pauseReason = null;
    await h.other.putState(account, newer);
  };
  await h.reader.read({ sessionId: "one" }); await h.reader.whenIdle();
  const latest = h.updates.at(-1);
  assert.equal(latest.status.phase, "paused"); assert.equal(latest.status.pauseReason, "catalog-superseded");
  assert.equal(latest.status.readErrors[0].code, failure.code);
  assert.equal(latest.status.readErrors[0].status, failure.status);
  assert.equal(latest.status.errorOrigin, "current", "the just-observed source failure remains current even if its checkpoint lost");
  assert.equal(latest.status.failureNotice.id, 1);
  assert.equal(latest.status.failureNotice.error.code, failure.code);
  assert.equal(latest.status.failureNotice.error.status, failure.status);
  assert.equal(h.updates.filter(update => update.status.failureNotice).length, 1);
  assert.equal(h.calls.length, 1);
  assert.equal((await h.repository.getSnapshot(ACCOUNT)).state.sources.ordinary.error, null,
    "the current failure is only an observation; it cannot overwrite the newer durable checkpoint");
  assert.equal(JSON.stringify(await h.repository.getSnapshot(ACCOUNT)).includes("failureNotice"), false);
});
