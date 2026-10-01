const assert = require("node:assert/strict");
const test = require("node:test");
const { IDBFactory } = require("fake-indexeddb");

const KEY = "navigation:worker-epoch";

// Exercise real IndexedDB transactions and serialization, not a hand-written
// counter mock: this generation must survive different worker instances.
async function setup(t) {
  const [{ openTidyDatabase }, { STORAGE_BOUNDARIES }, { createNavigationEpochAllocator }] = await Promise.all([
    import("../src/platform/storage/database.js"), import("../src/platform/storage/schema.js"), import("../src/platform/navigation/storage/navigation-epoch.js"),
  ]);
  const factory = new IDBFactory();
  const database = await openTidyDatabase(factory);
  t.after(() => database.close());
  const storeName = STORAGE_BOUNDARIES.indexedDb.stores.moduleState;
  async function transaction(mode, action) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = action(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = transaction.onerror = () => reject(transaction.error || Error("Test transaction failed"));
    });
  }
  return {
    database, factory, createNavigationEpochAllocator,
    create: options => createNavigationEpochAllocator({ openDatabase: async () => database, ...options }),
    read: () => transaction("readonly", store => store.get(KEY)),
    write: record => transaction("readwrite", store => store.put(record)),
    openAnother: () => openTidyDatabase(factory),
  };
}

test("one allocator caches the exact pending and fulfilled promise and increments storage only once", async t => {
  const h = await setup(t); let opens = 0;
  const allocate = h.create({ openDatabase: async () => { opens++; return h.database; } });
  const first = allocate(), concurrent = allocate();
  assert.equal(first, concurrent);
  assert.equal(await first, 1);
  const afterSuccess = allocate();
  assert.equal(afterSuccess, first); assert.equal(await afterSuccess, 1); assert.equal(opens, 1);
  assert.deepEqual(await h.read(), { key: KEY, epoch: 1 });
});

test("a new allocator observes the committed generation and strictly increments it", async t => {
  const h = await setup(t);
  const firstWorker = h.create(), nextWorker = h.create(), thirdWorker = h.create();
  assert.equal(await firstWorker(), 1); assert.equal(await nextWorker(), 2); assert.equal(await thirdWorker(), 3);
  assert.equal(await firstWorker(), 1, "a still-alive old worker never takes another generation");
  assert.deepEqual(await h.read(), { key: KEY, epoch: 3 });
});

test("two concurrent worker connections allocate unique consecutive generations atomically", async t => {
  const h = await setup(t), another = await h.openAnother();
  t.after(() => another.close());
  await h.write({ key: KEY, epoch: 40 });
  const left = h.create(), right = h.create({ openDatabase: async () => another });
  const allocated = await Promise.all([left(), right()]);
  assert.equal(new Set(allocated).size, 2);
  assert.deepEqual(allocated.slice().sort((a, b) => a - b), [41, 42]);
  assert.deepEqual(await h.read(), { key: KEY, epoch: 42 });
});

test("many concurrent allocator instances do not lose read-modify-write increments", async t => {
  const h = await setup(t);
  const values = await Promise.all(Array.from({ length: 20 }, () => h.create()()));
  assert.deepEqual(values.slice().sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.deepEqual(await h.read(), { key: KEY, epoch: 20 });
});

const malformedRecords = [
  ["missing epoch", { key: KEY }],
  ["null epoch", { key: KEY, epoch: null }],
  ["string epoch", { key: KEY, epoch: "4" }],
  ["negative epoch", { key: KEY, epoch: -1 }],
  ["fractional epoch", { key: KEY, epoch: 1.5 }],
  ["NaN epoch", { key: KEY, epoch: NaN }],
  ["infinite epoch", { key: KEY, epoch: Infinity }],
  ["exhausted safe integer", { key: KEY, epoch: Number.MAX_SAFE_INTEGER }],
  ["overflow epoch", { key: KEY, epoch: Number.MAX_SAFE_INTEGER + 1 }],
];
for (const [name, record] of malformedRecords) {
  test(`${name} fails closed, preserves the damaged record and caches rejection`, async t => {
    const h = await setup(t); await h.write(record); let opens = 0;
    const allocate = h.create({ openDatabase: async () => { opens++; return h.database; } });
    const first = allocate(), concurrent = allocate();
    assert.equal(first, concurrent);
    await assert.rejects(first, error => error.code === "STORAGE_ERROR" || error.tidyCode === "STORAGE_ERROR");
    const retry = allocate(); assert.equal(retry, first);
    await assert.rejects(retry); assert.equal(opens, 1);
    assert.deepEqual(await h.read(), record, "an invalid counter must never be reset or partially overwritten");
  });
}

test("the last safe generation can be committed once but the following worker fails closed", async t => {
  const h = await setup(t); await h.write({ key: KEY, epoch: Number.MAX_SAFE_INTEGER - 1 });
  assert.equal(await h.create()(), Number.MAX_SAFE_INTEGER);
  await assert.rejects(h.create()(), error => error.code === "STORAGE_ERROR" || error.tidyCode === "STORAGE_ERROR");
  assert.deepEqual(await h.read(), { key: KEY, epoch: Number.MAX_SAFE_INTEGER });
});

test("database-open failure remains one rejected promise for the worker lifetime", async t => {
  const h = await setup(t), failure = Error("storage unavailable"); let opens = 0;
  const allocate = h.create({ openDatabase: async () => { opens++; throw failure; } });
  const first = allocate(); await assert.rejects(first, error => error === failure);
  assert.equal(allocate(), first); await assert.rejects(allocate(), error => error === failure);
  assert.equal(opens, 1); assert.equal(await h.read(), undefined);
});
