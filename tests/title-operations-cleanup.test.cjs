const assert = require("node:assert/strict");
const test = require("node:test");
const { IDBFactory } = require("fake-indexeddb");
require("fake-indexeddb/auto");

const PREFIX = "title-operations.v1:";
const jobKey = (id) => `title-batch.job:${id}`;
const pointerKey = (id) => `title-batch.latest:${JSON.stringify(["account-a", id])}`;
const NOW = 10000;
const draft = (id, patch = {}) => ({ version: 1, id, phase: "preview", createdAt: 1, expiresAt: 100,
  runtimeId: null, nextStepId: null, usedStepIds: [],
  items: [{ status: "ready", settled: false }], ...patch });
const stub = (id) => ({ version: 1, id, superseded: "newest" });

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error || new Error("transaction aborted"));
  });
}

async function fixture(entries = [], wrap = (db) => db) {
  const { openTidyDatabase } = await import("../src/platform/storage/database.js");
  const { createTitleOperationsRepository } = await import("../src/features/titles/storage/title-operations.js");
  const db = await openTidyDatabase(new IDBFactory());
  const tx = db.transaction("module-state", "readwrite"), completed = done(tx);
  for (const [key, value] of entries) tx.objectStore("module-state").put({ key: PREFIX + key, value });
  await completed;
  const openDatabase = async () => wrap(db);
  const newRepository = () => createTitleOperationsRepository({ openDatabase, now: () => NOW });
  async function records() {
    const tx = db.transaction("module-state", "readonly"), completed = done(tx);
    const request = tx.objectStore("module-state").getAll();
    await completed;
    return new Map(request.result.map(({ key, value }) => [key.slice(PREFIX.length), value]));
  }
  return { db, newRepository, repository: newRepository(), records };
}

test("repository startup removes historical stubs and expired read-only drafts with their exact pointers", async (t) => {
  const entries = [
    [jobKey("old-stub"), stub("old-stub")], [pointerKey("old-stub"), { batchId: "old-stub" }],
    [jobKey("abandoned"), draft("abandoned")], [pointerKey("abandoned"), { batchId: "abandoned" }],
    [jobKey("newest"), draft("newest", { expiresAt: NOW + 1 })],
    [pointerKey("newest"), { batchId: "newest" }],
    // 同一 owner 已发布新指针，删除旧 job 不能把新指针也删掉。
    [pointerKey("replaced-owner"), { batchId: "newest" }],
    ["single-receipt", { operation: { status: "uncertain" } }],
    ["some-other-module", { preserved: true }],
  ];
  const f = await fixture(entries); t.after(() => f.db.close());
  assert.equal(await f.repository.get(jobKey("old-stub")), null);
  const remaining = await f.records();
  assert.deepEqual([...remaining.keys()].sort(), entries.slice(4).map(([key]) => key).sort());
  for (const [key, value] of entries.slice(4)) assert.deepEqual(remaining.get(key), value);
});

test("cleanup preserves write evidence, results, unknown versions and contradictory records regardless of age", async (t) => {
  const candidates = [
    draft("result", { phase: "result", items: [{ status: "verified", settled: true }] }),
    draft("paused", { phase: "paused" }), draft("applying", { phase: "applying" }),
    draft("preparing", { phase: "preparing" }), draft("future-version", { version: 2 }),
    draft("future-expiry", { expiresAt: NOW + 1 }), draft("at-expiry", { expiresAt: NOW }),
    draft("missing-expiry", { expiresAt: null }), draft("reversed-time", { createdAt: 200, expiresAt: 100 }),
    draft("missing-items", { items: null }), draft("empty-items", { items: [] }),
    { ...stub("contradictory-stub"), operation: { status: "uncertain" } },
    { ...stub("self-stub"), superseded: "self-stub" },
  ];
  for (const field of ["runtimeId", "startedAt", "startedAtMs", "operationId", "recoveryOperationId", "nextStepId"]) {
    candidates.push(draft(`job-${field}`, { [field]: 0 }));
    candidates.push(draft(`item-${field}`, { items: [{ status: "ready", settled: false, [field]: 0 }] }));
  }
  for (const status of ["pending", "uncertain", "accepted", "verified", "conflict", "failed", "unknown"]) {
    candidates.push(draft(`item-${status}`, { items: [{ status, settled: false }] }));
  }
  for (const [name, patch] of Object.entries({ settled: { settled: true }, unproven: { settled: undefined },
    operation: { operation: { status: "pending" } }, used: { usedStepIds: ["used"] }, brokenSteps: { usedStepIds: "bad" } })) {
    candidates.push(draft(name, { items: [{ status: "ready", settled: false, ...patch }] }));
  }
  const entries = candidates.flatMap((job) => [[jobKey(job.id), job], [pointerKey(job.id), { batchId: job.id }]]);
  entries.push([jobKey("wrong-key"), draft("different-id")]);
  const f = await fixture(entries); t.after(() => f.db.close());
  await f.repository.get("missing");
  assert.deepEqual(await f.records(), new Map(entries));
});

test("startup cleanup rolls back job and pointer together and never blocks receipt reads", async (t) => {
  const entries = [[jobKey("old"), stub("old")], [pointerKey("old"), { batchId: "old" }],
    ["receipt", { operation: { status: "uncertain" } }]];
  let failOnce = true;
  const f = await fixture(entries, (db) => ({
    transaction(...args) {
      const tx = db.transaction(...args);
      if (failOnce && args[1] === "readwrite") {
        failOnce = false;
        const original = tx.objectStore.bind(tx);
        tx.objectStore = (name) => {
          const store = original(name), openCursor = store.openCursor.bind(store);
          store.openCursor = (range) => {
            if (range.lower.includes("title-batch.latest:")) throw new Error("injected cleanup failure after job deletion");
            return openCursor(range);
          };
          return store;
        };
      }
      return tx;
    },
  }));
  t.after(() => f.db.close());
  assert.deepEqual(await f.repository.get("receipt"), entries[2][1]);
  assert.deepEqual(await f.records(), new Map(entries), "failed cleanup must not leave a deleted job or dangling pointer");
  await f.newRepository().get("receipt");
  assert.deepEqual(await f.records(), new Map([entries[2]]), "next worker retries the optional cleanup");
});

test("repository cleans once on first use, not on every get or replan save", async (t) => {
  let cleanupTransactions = 0;
  const f = await fixture([], (db) => ({ transaction(...args) {
    if (args[1] === "readwrite") cleanupTransactions++;
    return db.transaction(...args);
  } }));
  t.after(() => f.db.close());
  await Promise.all([f.repository.get("one"), f.repository.get("two")]);
  assert.equal(cleanupTransactions, 1, "concurrent first reads share initialization");
  await f.repository.set(jobKey("late"), draft("late"));
  assert.ok(await f.repository.get(jobKey("late")), "normal calls do not rescan");
  assert.equal(cleanupTransactions, 2, "one cleanup and one explicit save");
  assert.equal(await f.newRepository().get(jobKey("late")), null);
  assert.equal(cleanupTransactions, 3);
});
