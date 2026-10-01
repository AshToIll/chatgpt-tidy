const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const plain = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const model = require(path.join(ROOT, "src/features/titles/model/title-dates.js"));
const OWNER = Object.freeze({ tabId: 31, conversationId: "owner-chat", pathname: "/c/owner-chat", projectId: null });
const IDENTITY = Object.freeze({ accountKey: "account-a", workspaceKey: "personal" });
const RULES = Object.freeze({ mode: "created", dateFormat: "iso", timeZone: "UTC", locale: "en-US" });
const failure = (code) => Object.assign(new Error(code), { code, tidyCode: code });

function loadModule(file, names, globals = {}) {
  const source = fs.readFileSync(path.join(ROOT, file), "utf8")
    .replace(/^import[^;]+;\r?\n/gm, "").replaceAll("export ", "");
  const context = vm.createContext({ Date, JSON, Object, Array, String, Number, Boolean, Promise, Math, ...globals });
  vm.runInContext(`${source}\nglobalThis.result = { ${names.join(",")} };`, context, { filename: file });
  return context.result;
}

const { createTitleService, TITLE_PLAN_TTL_MS } = loadModule("src/features/titles/background/title-service.js", ["createTitleService", "TITLE_PLAN_TTL_MS"], { titleOperationsRepository: null });
const { TidySnapshot } = loadModule("src/platform/snapshot.js", ["TidySnapshot"]);
const { createTitleBatchService } = loadModule("src/features/titles/background/title-batch-service.js", ["createTitleBatchService"], { titleOperationsRepository: null, TITLE_PLAN_TTL_MS, TidySnapshot });

function memoryStorage() {
  const records = new Map(), writes = [], removals = [];
  return {
    records, writes, removals, reject: null, rejectRemove: null,
    async get(key) { return plain(records.get(key)) || null; },
    async set(key, value) {
      if (this.reject?.(key, value)) throw failure("storage_failed");
      writes.push({ key, value: plain(value) }); records.set(key, plain(value));
    },
    async remove(keys) {
      const removed = Array.isArray(keys) ? keys : [keys];
      if (this.rejectRemove?.(removed)) throw failure("storage_failed");
      removals.push([...removed]);
      for (const key of removed) records.delete(key);
    },
  };
}

// The adapter double deliberately preserves the production boundary: a write
// invocation is not a POST. Identity, permission and the exact title must
// match; dates use catalog output equality or exact detail-version equality.
function fixture(options = {}) {
  const storage = options.storage || memoryStorage();
  const rows = (options.rows || ["chat-a", "chat-b", "chat-c"]).map((row) => typeof row === "string" ? { conversationId: row, projectId: null } : plain(row));
  const current = new Map(rows.map((row) => [row.conversationId, {
    conversationId: row.conversationId, title: row.title || `Original ${row.conversationId}`,
    createdAt: "2026-09-01T01:00:00.000Z", updatedAt: "2026-09-07T02:00:00.000Z",
  }]));
  let identity = plain(IDENTITY), clock = 1000, sequence = 0;
  let directoryIdentity = plain(identity), directoryAccountKey = `catalog:${identity.accountKey}:${identity.workspaceKey}`;
  const reads = [], directoryReads = [], writes = [], posts = [], executionBegins = [], executionEnds = [];
  const f = { storage, rows, current, reads, directoryReads, writes, posts, executionBegins, executionEnds,
    readHook: null, writeHook: null, authorizeHook: null, preflightHook: null, directoryHook: null, beginHook: null,
    denied: new Set(), timeZone: "UTC", owner: plain(OWNER),
    setIdentity(value) { identity = plain(value); },
    setClock(value) { clock = value; }, advance(ms) { clock += ms; }, clock: () => clock,
    patch(id, patch) { current.set(id, { ...current.get(id), ...patch }); },
  };
  const assertOwner = (owner) => {
    assert.equal(owner.tabId, f.owner.tabId, "adapter stays bound to the original Chrome tab");
    assert.equal(owner.conversationId, f.owner.conversationId, "batch target never impersonates the active route");
    assert.equal(owner.pathname, f.owner.pathname);
    assert.equal(owner.projectId || null, f.owner.projectId || null);
  };
  const assertTarget = (context) => {
    if (context.ownerContext) {
      assertOwner({ tabId: context.tabId, ...context.ownerContext });
      assert.equal(typeof context.expectedIdentity?.accountKey, "string");
      assert.equal(typeof context.expectedIdentity?.workspaceKey, "string");
      assert.ok(context.batchScopeId);
      assert.equal(context.targetProjectId, rows.find((row) => row.conversationId === context.conversationId)?.projectId || null);
    }
  };
  const read = async (context, input) => {
    reads.push({ context: plain(context), input: plain(input) });
    if (f.readHook) await f.readHook(context, input);
    assertTarget(context);
    if (!input?.identityOnly && f.denied.has(context.conversationId)) throw failure("TITLE_PERMISSION_DENIED");
    const result = { identity: { ...identity, accessToken: "NEVER-PERSIST-TOKEN" } };
    if (!input?.identityOnly) result.current = { ...plain(current.get(context.conversationId)), messages: ["NEVER-PERSIST-MESSAGES"] };
    return result;
  };
  const write = async (context, payload, beforeDispatch) => {
    await beforeDispatch();
    writes.push({ context: plain(context), payload: plain(payload) });
    assertTarget(context);
    const preflightFailure = await f.preflightHook?.(context, payload);
    if (preflightFailure) return preflightFailure;
    const observed = plain(current.get(context.conversationId));
    if (payload.identity.accountKey !== identity.accountKey || payload.identity.workspaceKey !== identity.workspaceKey) {
      return { status: "failed", current: null, messageCode: "account_changed" };
    }
    if (f.denied.has(context.conversationId)) return { status: "failed", current: observed, messageCode: "title_permission_denied", httpStatus: 403 };
    if (payload.expectedTimeZone !== f.timeZone) return { status: "failed", current: observed, messageCode: "TITLE_TIMEZONE_CHANGED" };
    if (observed.title !== payload.before) {
      return { status: "conflict", current: observed, messageCode: "title_conflict" };
    }
    assert.ok(["catalog", "detail"].includes(payload.metadataSource));
    if (payload.metadataSource === "catalog") {
      const planned = model.plan(observed, payload.catalogIntent.rules, payload.catalogIntent);
      if (planned.after !== payload.after || !planned.canApply || planned.noOp || planned.wouldEmpty) {
        return { status: "conflict", current: observed, messageCode: "dates_changed" };
      }
    } else if (observed.createdAt !== payload.expectedCreatedAt || observed.updatedAt !== payload.expectedUpdatedAt) {
      return { status: "conflict", current: observed, messageCode: "dates_changed" };
    }
    posts.push({ context: plain(context), payload: plain(payload) });
    if (f.writeHook) return f.writeHook(context, payload, observed);
    f.patch(context.conversationId, { title: payload.after, updatedAt: "2026-09-08T03:00:00.000Z" });
    return { status: "verified", current: plain(current.get(context.conversationId)), httpStatus: 200 };
  };
  f.newCore = () => createTitleService({ read, write, storage, model, now: () => clock, createId: () => `core-${++sequence}` });
  f.core = f.newCore();
  f.newBatch = () => createTitleBatchService({
    titleService: { handle: (...args) => f.core.handle(...args),
      applyAuthorized: (...args) => f.core.applyAuthorized(...args), authorize: async (...args) => {
      const result = await f.core.authorize(...args);
      if (f.authorizeHook) await f.authorizeHook(...args);
      return result;
    } },
    storage, model, now: () => clock, createId: () => `batch-${++sequence}`,
    beginExecution: async (owner, execution) => {
      assertOwner(owner); executionBegins.push(plain(execution));
      if (f.beginHook) await f.beginHook(owner, execution);
      const sameDirectoryIdentity = identity.accountKey === directoryIdentity.accountKey && identity.workspaceKey === directoryIdentity.workspaceKey;
      return { identity: plain(identity), catalogAccountKey: sameDirectoryIdentity
        ? directoryAccountKey : `catalog:${identity.accountKey}:${identity.workspaceKey}` };
    },
    endExecution: async (owner, scopeId) => { assertOwner(owner); executionEnds.push(scopeId); return { ended: true }; },
    resolveSelection: async (owner, payload) => {
      directoryReads.push({ owner: plain(owner), payload: plain(payload) }); assertOwner(owner);
      const result = f.directoryHook ? await f.directoryHook(owner, payload) : { identity: { ...identity, accessToken: "NEVER-PERSIST-TOKEN" }, accountKey: `catalog:${identity.accountKey}:${identity.workspaceKey}`,
        rows: rows.filter((row) => payload.conversationIds.includes(row.conversationId)).map(row => ({ ...plain(row),
          title: row.title || `Original ${row.conversationId}`,
          createdAt: options.completeCatalog !== false ? Date.parse(current.get(row.conversationId).createdAt) : null,
          updatedAt: options.completeCatalog !== false ? Date.parse(current.get(row.conversationId).updatedAt) : null })) };
      directoryIdentity = { accountKey: result.identity.accountKey, workspaceKey: result.identity.workspaceKey };
      directoryAccountKey = result.accountKey;
      return result;
    },
  });
  f.batch = f.newBatch();
  f.call = (action, payload = {}, owner = f.owner) => f.batch.handle(action, owner,
    action === "status" && !payload.batchId && !payload.catalogAccountKey
      ? { ...payload, catalogAccountKey: directoryAccountKey } : payload);
  f.start = (payload = {}) => f.call("preview", { conversationIds: rows.map((row) => row.conversationId), rules: RULES, ...payload });
  f.review = async (state = null) => state || f.start();
  f.finish = async (state) => {
    state = await f.call("apply", { batchId: state.batchId });
    while (state.phase === "applying") state = await f.call("step", { batchId: state.batchId, stepId: state.nextStepId });
    return state;
  };
  return f;
}

test("selection preview is one local catalog pass with zero session or detail reads", async () => {
  const f = fixture();
  const state = await f.start();
  assert.equal(state.phase, "preview"); assert.equal(state.counts.prepared, 3);
  assert.equal(f.reads.length, 0); assert.equal(f.directoryReads.length, 1);
  await assert.rejects(f.call("prepare-step", { batchId: state.batchId, stepId: "retired" }), { code: "INVALID_REQUEST" });
  assert.equal(state.expiresAt, f.clock() + TITLE_PLAN_TTL_MS);
  assert.equal(state.counts.ready, 3); assert.equal(f.posts.length, 0);
  assert.ok(!JSON.stringify([...f.storage.records]).includes("NEVER-PERSIST"));
  assert.ok(!JSON.stringify(state).includes("NEVER-PERSIST"));
});

function seedRetiredPreparation(f, { id = "retired-preparation", job: patch = {}, items } = {}) {
  const catalogAccountKey = `catalog:${IDENTITY.accountKey}:${IDENTITY.workspaceKey}`;
  const ownerKey = JSON.stringify([f.owner.tabId, f.owner.conversationId, f.owner.pathname, f.owner.projectId]);
  const pointerKey = `title-batch.latest:${JSON.stringify([catalogAccountKey, ownerKey])}`;
  const key = `title-batch.job:${id}`;
  const job = { version: 1, id, scopeId: id, owner: f.owner, identity: IDENTITY,
    catalogAccountKey, phase: "preparing", operation: "assign", rules: RULES, runtimeId: null,
    createdAt: 1000, usedStepIds: [], nextStepId: "retired-preparation-token", ...patch,
    items: (items || [{ status: "unread" }, { status: "ready" }, { status: "skipped" }]).map((item, index) => {
      const conversationId = `chat-${String.fromCharCode(97 + index)}`, current = plain(f.current.get(conversationId));
      return { conversationId, projectId: null, settled: false, current,
        plan: { id: `recipe-${index}`, conversationId, before: current.title, after: `${current.title} dated` }, ...item };
    }) };
  f.storage.records.set(key, plain(job)); f.storage.records.set(pointerKey, { batchId: id });
  return { job: plain(job), key, pointerKey, catalogAccountKey };
}

test("status only deletes positively read-only preparation and its exact owner/account pointer", async () => {
  const f = fixture(), retired = seedRetiredPreparation(f);
  const unrelated = { batchId: "another-owner-job" };
  f.storage.records.set("title-batch.latest:another-owner", unrelated);
  f.storage.records.set("title-batch.job:another-owner-job", { receipt: "must-stay" });
  const cleared = await f.call("status", { catalogAccountKey: retired.catalogAccountKey });
  assert.equal(cleared.batchId, null);
  assert.equal(f.storage.records.has(retired.key), false); assert.equal(f.storage.records.has(retired.pointerKey), false);
  assert.deepEqual(f.storage.removals.at(-1), [retired.key, retired.pointerKey]);
  assert.deepEqual(f.storage.records.get("title-batch.latest:another-owner"), unrelated);
  assert.deepEqual(f.storage.records.get("title-batch.job:another-owner-job"), { receipt: "must-stay" });
  assert.equal(f.reads.length, 0); assert.equal(f.posts.length, 0); assert.equal(f.executionBegins.length, 0);
});

test("retired preparation with any write evidence survives as a current read-only recovery receipt", async (t) => {
  const cases = [
    { name: "accepted", item: { status: "accepted" } },
    { name: "verified", item: { status: "verified" } },
    { name: "pending", item: { status: "pending", recoveryOperationId: "possible-post" } },
    { name: "uncertain", item: { status: "uncertain", recoveryOperationId: "possible-post" } },
    { name: "failed", item: { status: "failed" } },
    { name: "conflict", item: { status: "conflict" } },
    { name: "started at epoch zero", job: { startedAt: 0 } },
    { name: "runtime marker", job: { runtimeId: "previous-worker" } },
    { name: "job operation ID", job: { operationId: "job-operation" } },
    { name: "job recovery ID", job: { recoveryOperationId: "job-recovery" } },
    { name: "consumed step", job: { usedStepIds: ["previous-step"] } },
    { name: "settled skip", item: { status: "skipped", settled: true } },
    { name: "item operation ID", item: { operationId: "item-operation" }, uncertain: true },
    { name: "item recovery ID", item: { recoveryOperationId: "item-recovery" }, uncertain: true },
    { name: "item start timestamp", item: { startedAtMs: 0 }, uncertain: true },
    { name: "nested operation receipt", item: { operation: { id: "nested-operation", status: "pending" } }, uncertain: true },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const f = fixture(), seeded = seedRetiredPreparation(f, { job: entry.job,
      items: [{ status: "ready", ...entry.item }, { status: "unread" }] });
    const recovered = await f.call("status", { catalogAccountKey: seeded.catalogAccountKey });
    assert.equal(recovered.batchId, seeded.job.id); assert.equal(recovered.phase, "paused");
    assert.equal(recovered.nextStepId, null); assert.equal(f.storage.removals.length, 0);
    const stored = f.storage.records.get(seeded.key);
    for (const [key, value] of Object.entries(entry.job || {})) assert.deepEqual(stored[key], value);
    for (const [key, value] of Object.entries(entry.item || {})) if (key !== "status") assert.deepEqual(stored.items[0][key], value);
    const expectedStatus = entry.uncertain || entry.item?.status === "pending" ? "uncertain" : entry.item?.status || "ready";
    assert.equal(recovered.items[0].status, expectedStatus);
    if (["accepted", "verified"].includes(expectedStatus)) assert.equal(recovered.items[0].settled, true, "known success cannot be replayed even if the retired settled flag was false");
    assert.equal(recovered.items[1].status, "failed"); assert.equal(recovered.items[1].messageCode, "title_preview_required");
    assert.equal(recovered.items[1].settled, false); assert.equal(recovered.counts.failed >= 1, true);
    assert.deepEqual(stored.preparationMigration, { sourcePhase: "preparing", unreadConversationIds: ["chat-b"], migratedAt: f.clock() });
    assert.equal("preparationMigration" in recovered, false, "migration history is not a second public runtime model");
    assert.equal(f.reads.length, 0); assert.equal(f.executionBegins.length, 0);
    await assert.rejects(f.call("apply", { batchId: recovered.batchId }), { code: "TITLE_BATCH_RECOVERY_REQUIRED" });
    await assert.rejects(f.call("step", { batchId: recovered.batchId, stepId: "retired-preparation-token" }), { code: "INVALID_REQUEST" });
    const writesBeforeStatus = f.storage.writes.length;
    await f.call("status", { batchId: recovered.batchId });
    assert.equal(f.storage.writes.length, writesBeforeStatus, "the storage migration is one-shot");
    const observed = await f.call("reconcile", { batchId: recovered.batchId });
    assert.equal(observed.nextStepId, null); assert.ok(["paused", "result"].includes(observed.phase));
    assert.equal(f.storage.records.has(seeded.key), true); assert.equal(f.storage.records.has(seeded.pointerKey), true);
    assert.equal(f.posts.length, 0); assert.equal(f.writes.length, 0); assert.equal(f.executionBegins.length, 0);
  });
});

test("explicit retry review retains accepted and verified legacy rows without creating new write authority", async () => {
  const f = fixture(), seeded = seedRetiredPreparation(f, { items: [
    { status: "accepted" }, { status: "verified" }, { status: "unread" },
  ] });
  let state = await f.call("status", { batchId: seeded.job.id });
  assert.equal(state.phase, "paused"); assert.equal(state.counts.accepted, 1); assert.equal(state.counts.verified, 1);
  const retained = plain(state.items.slice(0, 2));
  state = await f.call("retry-preview", { batchId: state.batchId });
  assert.equal(state.phase, "preview"); assert.equal(state.nextStepId, null);
  assert.deepEqual(plain(state.items.slice(0, 2)), retained); assert.equal(state.items[2].status, "ready");
  assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0); assert.equal(f.posts.length, 0); assert.equal(f.executionBegins.length, 0);
});

test("explicit retry fills only absent unsettled metadata from the same account's local directory", async () => {
  const f = fixture({ rows: ["chat-a", "chat-b", "chat-c", "chat-d"] });
  const seeded = seedRetiredPreparation(f, { items: [
    { status: "accepted", current: null }, { status: "verified" }, { status: "ready" },
    { status: "unread", current: null, plan: null },
  ] });
  let state = await f.call("status", { batchId: seeded.job.id });
  const retained = plain(state.items.slice(0, 3));
  assert.equal(state.items[3].status, "failed"); assert.equal(f.directoryReads.length, 0);
  state = await f.call("reconcile", { batchId: seeded.job.id });
  assert.equal(f.directoryReads.length, 0, "read-only recovery does not rebuild previews");
  state = await f.call("retry-preview", { batchId: seeded.job.id });
  assert.equal(state.phase, "preview"); assert.equal(state.nextStepId, null);
  assert.deepEqual(plain(f.directoryReads.map((call) => call.payload)), [
    { accountKey: seeded.catalogAccountKey, conversationIds: ["chat-d"] },
  ]);
  assert.deepEqual(plain(state.items.slice(0, 2)), retained.slice(0, 2), "known writes are never re-read, replaced or made executable");
  assert.deepEqual(plain(state.items[2].current), retained[2].current, "existing metadata stays frozen");
  assert.equal(state.items[3].current.title, f.current.get("chat-d").title); assert.equal(state.items[3].status, "ready");
  assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0); assert.equal(f.posts.length, 0); assert.equal(f.executionBegins.length, 0);
});

test("retry cannot replace a missing observation with a missing, wrong-account or wrong-target catalog row", async (t) => {
  const cases = [
    { name: "missing row", transform: (value) => ({ ...value, rows: [] }) },
    { name: "another account", transform: (value) => ({ ...value, accountKey: "another-account" }) },
    { name: "another target", transform: (value) => ({ ...value, rows: [{ ...value.rows[0], conversationId: "intruder" }] }) },
    { name: "extra target", transform: (value) => ({ ...value, rows: [...value.rows, { ...value.rows[0], conversationId: "intruder" }] }) },
    { name: "duplicate target", transform: (value) => ({ ...value, rows: [value.rows[0], value.rows[0]] }) },
    { name: "project moved", transform: (value) => ({ ...value, rows: [{ ...value.rows[0], projectId: "g-p-moved" }] }) },
    { name: "missing title", transform: (value) => ({ ...value, rows: [{ ...value.rows[0], title: undefined }] }) },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const f = fixture(), seeded = seedRetiredPreparation(f, { items: [
      { status: "accepted" }, { status: "unread", current: null, plan: null },
    ] });
    await f.call("status", { batchId: seeded.job.id });
    const before = plain([...f.storage.records]);
    f.directoryHook = async () => entry.transform({ identity: IDENTITY, accountKey: seeded.catalogAccountKey,
      rows: [{ ...f.current.get("chat-b"), projectId: null,
        createdAt: Date.parse(f.current.get("chat-b").createdAt), updatedAt: Date.parse(f.current.get("chat-b").updatedAt) }] });
    await assert.rejects(f.call("retry-preview", { batchId: seeded.job.id }), { code: "CONTEXT_MISMATCH" });
    assert.deepEqual(plain([...f.storage.records]), before, "failed review preserves the exact recovery receipt and pointer");
    const observed = await f.call("status", { batchId: seeded.job.id });
    assert.equal(observed.items[1].status, "failed"); assert.equal(observed.items[1].messageCode, "title_preview_required");
    assert.equal(observed.items[1].current, null); assert.equal(observed.nextStepId, null);
    assert.equal(f.directoryReads.length, 1); assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0);
    assert.equal(f.posts.length, 0); assert.equal(f.executionBegins.length, 0);
  });
});

test("unknown writes block missing-metadata retry before even a local directory read", async () => {
  const f = fixture(), seeded = seedRetiredPreparation(f, { items: [
    { status: "pending", recoveryOperationId: "possibly-dispatched" }, { status: "unread", current: null, plan: null },
  ] });
  await f.call("status", { batchId: seeded.job.id });
  await assert.rejects(f.call("retry-preview", { batchId: seeded.job.id }), { code: "TITLE_BATCH_RECOVERY_REQUIRED" });
  assert.equal(f.directoryReads.length, 0); assert.equal(f.reads.length, 0); assert.equal(f.posts.length, 0);
});

test("a retired checkpoint cannot delete or normalize a different owner or catalog pointer", async () => {
  for (const mismatch of ["owner", "catalog"]) {
    const f = fixture(), seeded = seedRetiredPreparation(f);
    const job = f.storage.records.get(seeded.key);
    if (mismatch === "owner") job.owner = { ...job.owner, tabId: job.owner.tabId + 1 };
    else job.catalogAccountKey = "another-catalog";
    f.storage.records.set(seeded.key, plain(job));
    await assert.rejects(f.call("status", { catalogAccountKey: seeded.catalogAccountKey }), { code: "CONTEXT_MISMATCH" });
    assert.equal(f.storage.removals.length, 0); assert.deepEqual(f.storage.records.get(seeded.key), job);
    assert.deepEqual(f.storage.records.get(seeded.pointerKey), { batchId: seeded.job.id });
  }
});

test("local batch preview owns the only recipes and creates core receipts only after confirmation", async () => {
  const f = fixture(), actions = [], core = f.core;
  f.core = { handle: (...args) => { actions.push(args[0]); return core.handle(...args); }, authorize: (...args) => core.authorize(...args),
    applyAuthorized: (...args) => core.applyAuthorized(...args) };
  let state = await f.review();
  assert.deepEqual(actions, []);
  assert.equal(f.storage.writes.filter(({ key }) => !key.startsWith("title-batch.")).length, 0);
  const recipes = plain(state.items.map(({ plan }) => plan));
  assert.equal(new Set(recipes.map(({ id }) => id)).size, 3);
  state = await f.finish(state);
  assert.equal(state.counts.verified, 3); assert.equal(f.posts.length, 3);
  assert.deepEqual(plain(state.items.map(({ plan }) => plan)), recipes, "confirmed batch recipes are never replaced with readback drafts");
  const coreRecords = [...f.storage.records].filter(([key]) => !key.startsWith("title-batch."));
  assert.equal(coreRecords.length, 3);
  for (const [, record] of coreRecords) { assert.equal(record.operation.status, "verified"); assert.equal(record.plan, null); }
});

test("clear 2xx batch receipts are settled as accepted without pretending they were read back", async () => {
  const f = fixture({ completeCatalog: true, rows: ["chat-a", "chat-b"] });
  f.writeHook = async (_context, payload, observed) => ({ status: "accepted",
    accepted: { ...observed, title: payload.after }, httpStatus: 200,
    catalogAccountKey: `catalog:${IDENTITY.accountKey}:${IDENTITY.workspaceKey}` });
  const state = await f.finish(await f.start());
  assert.equal(state.phase, "result"); assert.equal(state.counts.accepted, 2); assert.equal(state.counts.verified, 0);
  assert.ok(state.items.every((item) => item.status === "accepted" && item.settled && item.current.title === item.plan.after));
  assert.equal(f.posts.length, 2); assert.equal(f.executionBegins.length, 1); assert.equal(f.executionEnds.length, 1);
  const retried = await f.call("retry-preview", { batchId: state.batchId });
  assert.equal(retried.phase, "preview"); assert.equal(retried.counts.accepted, 2, "settled accepted rows are never replayed");
});

test("batch recipes explicitly project execution and review fields without retaining parser evidence or alternative titles", async () => {
  const f = fixture({ rows: [{ conversationId: "chat-a", title: "2024-01-01｜2023-01-01｜Keep exact body" }] });
  let state = await f.review();
  const expectedFields = ["operation", "rules", "before", "after", "action", "reason", "canApply", "noOp",
    "needsDecision", "selectedDecision", "decisionResolved", "hasDateHead", "wouldEmpty", "id", "kind", "conversationId"].sort();
  assert.deepEqual(Object.keys(state.items[0].plan).sort(), expectedFields);
  const original = plain(state.items[0].current);
  const fullModel = model.plan(original, state.rules, { operation: "assign", decision: "replace" });
  assert.equal(fullModel.analysis.layers.length, 2); assert.equal(fullModel.choices.length, 3, "the input exercises expensive omitted evidence");
  state = await f.call("replan", { batchId: state.batchId, decisions: { "chat-a": "replace" } });
  const plan = plain(state.items[0].plan);
  assert.deepEqual(Object.keys(plan).sort(), expectedFields);
  assert.equal(plan.before, original.title); assert.equal(plan.after, fullModel.after);
  assert.deepEqual(plan.rules, plain(fullModel.rules)); assert.equal(plan.selectedDecision, "replace");
  const job = [...f.storage.records.values()].find(value => value.id === state.batchId);
  assert.deepEqual(Object.keys(job.items[0].plan).sort(), expectedFields);
  assert.deepEqual(job.items[0].current, original, "both prewrite dates remain frozen alongside the recipe");
  state = await f.finish(state);
  assert.equal(state.counts.verified, 1); assert.equal(f.posts[0].payload.before, original.title);
  assert.equal(f.posts[0].payload.after, fullModel.after);
  assert.equal(f.posts[0].payload.expectedCreatedAt, original.createdAt);
  assert.equal(f.posts[0].payload.expectedUpdatedAt, original.updatedAt);
  assert.equal(f.posts[0].payload.expectedTimeZone, fullModel.rules.timeZone);
});

test("local preview leaves an editor draft untouched; final authorization replaces it durably", async () => {
  const f = fixture({ rows: ["chat-a"] }), context = { tabId: 99, conversationId: "chat-a" };
  const old = await f.core.handle("preview", context, { rules: RULES });
  let state = await f.start();
  assert.equal(state.counts.ready, 1); assert.equal(f.posts.length, 0);
  assert.equal([...f.storage.records.values()].find(value => value.conversationId === "chat-a").plan.id, old.plan.id);
  state = await f.finish(state);
  assert.equal(state.counts.verified, 1); assert.equal(f.posts.length, 1);
  f.core = f.newCore();
  await assert.rejects(f.core.handle("apply", context, { planId: old.plan.id }), { code: "TITLE_PREVIEW_REQUIRED" });
});

test("failed local preview persistence creates neither a receipt nor a core draft", async () => {
  const f = fixture({ rows: ["chat-a"] });
  f.storage.reject = (key, value) => key.startsWith("title-batch.job:") && value.items?.some(item => item.status === "ready");
  await assert.rejects(f.start(), { code: "storage_failed" });
  assert.equal(f.reads.length, 0); assert.equal(f.posts.length, 0);
  assert.equal([...f.storage.records.keys()].some(key => !key.startsWith("title-batch.")), false);
});

test("account changes are checked once at confirmation, never during local preview", async () => {
  const f = fixture({ rows: ["chat-a"] }), state = await f.start();
  f.setIdentity({ accountKey: "account-b", workspaceKey: "personal" });
  await assert.rejects(f.call("apply", { batchId: state.batchId }), { code: "TITLE_ACCOUNT_CHANGED" });
  assert.equal(f.executionBegins.length, 1); assert.equal(f.posts.length, 0);
  assert.equal([...f.storage.records.keys()].some(key => !key.startsWith("title-batch.")), false);
});

test("selection and returned previews are immutable snapshots; caller title and scope injection has no authority", async () => {
  const f = fixture();
  const payload = { conversationIds: ["chat-a"], rules: { ...RULES }, before: "forged before", after: "forged after",
    identity: { accountKey: "attacker", workspaceKey: "attacker" }, current: { conversationId: "chat-a", title: "forged" }, projectId: "g-p-forged" };
  const pending = f.call("preview", payload);
  payload.conversationIds[0] = "chat-b"; payload.rules.mode = "range";
  let state = await f.review(await pending);
  assert.equal(state.items[0].conversationId, "chat-a");
  const expected = state.items[0].plan.after;
  state.items[0].plan.after = "mutated response"; state.items[0].current.title = "mutated metadata";
  state = await f.finish(state);
  assert.equal(state.counts.verified, 1);
  assert.equal(f.posts[0].payload.before, "Original chat-a"); assert.equal(f.posts[0].payload.after, expected);
});

test("local replan never authenticates or fetches metadata and invalidates previous opaque IDs", async () => {
  const f = fixture({ rows: [{ conversationId: "chat-a", title: "2025-01-01｜Original chat-a" }] });
  let state = await f.review();
  assert.equal(state.items[0].plan.needsDecision, true);
  const reads = f.reads.length, directory = f.directoryReads.length;
  const expiresAt = state.expiresAt;
  for (const decision of ["replace", "stack", "skip"]) {
    const oldId = state.batchId;
    state = await f.call("replan", { batchId: oldId, rules: { ...RULES, mode: "range" }, decisions: { "chat-a": decision },
      before: "forged", after: "forged", current: { title: "forged" }, expiresAt: Number.MAX_SAFE_INTEGER });
    assert.notEqual(state.batchId, oldId); assert.equal(state.expiresAt, expiresAt);
    assert.equal(state.items[0].plan.selectedDecision, decision);
    assert.equal(state.items[0].plan.before, "2025-01-01｜Original chat-a");
    await assert.rejects(f.call("replan", { batchId: oldId }), { code: "TITLE_PREVIEW_REQUIRED" });
  }
  assert.equal(f.reads.length, reads); assert.equal(f.directoryReads.length, directory);
  assert.equal(f.posts.length, 0);
  const fullJobs = [...f.storage.records.values()].filter((value) => value.items);
  assert.equal(fullJobs.length, 1, "old full metadata jobs are compacted instead of multiplying per radio click");
});

test("batch supports more than the current-view 16-context limit and more than 20 selected titles", async () => {
  const f = fixture({ rows: Array.from({ length: 25 }, (_, index) => `chat-${index}`) });
  let state = await f.review();
  assert.equal(state.counts.ready, 25); assert.equal(f.reads.length, 0);
  state = await f.call("replan", { batchId: state.batchId, rules: { ...RULES, dateFormat: "slash" } });
  assert.equal(f.reads.length, 0);
  state = await f.finish(state);
  assert.equal(state.phase, "result"); assert.equal(state.counts.verified, 25); assert.equal(f.posts.length, 25);
  assert.equal(new Set(f.posts.map((post) => post.context.conversationId)).size, 25);
});

test("execution tokens are replay-safe under simultaneous duplicate requests", async () => {
  const f = fixture({ rows: ["chat-a"] });
  let state = await f.start();
  assert.equal(f.reads.length, 0);
  state = await f.call("apply", { batchId: state.batchId });
  const step = { batchId: state.batchId, stepId: state.nextStepId };
  const completed = await Promise.all([f.call("step", step), f.call("step", step)]);
  assert.equal(completed[0].counts.verified, 1); assert.equal(completed[1].counts.verified, 1); assert.equal(f.posts.length, 1);
  assert.equal((await f.call("apply", { batchId: state.batchId })).counts.verified, 1);
  assert.equal(f.posts.length, 1);
});

test("unknown, missing and future step tokens cannot advance the batch", async () => {
  const f = fixture({ rows: ["chat-a"] });
  let state = await f.start();
  for (const stepId of [null, undefined, "guessed-token", 42]) {
    await assert.rejects(f.call("prepare-step", { batchId: state.batchId, stepId }), { code: "INVALID_REQUEST" });
  }
  assert.equal(f.reads.length, 0);
  state = await f.review(state); state = await f.call("apply", { batchId: state.batchId });
  for (const stepId of [null, undefined, "guessed-token", 42]) {
    await assert.rejects(f.call("step", { batchId: state.batchId, stepId }), { code: "INVALID_REQUEST" });
  }
  assert.equal(f.posts.length, 0);
});

test("review TTL begins with the local preview, replan does not extend it, and a backwards clock is rejected", async () => {
  const f = fixture({ rows: ["chat-a"] });
  let state = await f.start(); assert.equal(state.expiresAt, f.clock() + TITLE_PLAN_TTL_MS);
  const expiresAt = state.expiresAt;
  f.advance(TITLE_PLAN_TTL_MS - 1);
  state = await f.call("replan", { batchId: state.batchId, rules: { ...RULES, dateFormat: "dot" } });
  assert.equal(state.expiresAt, expiresAt);
  f.advance(2);
  await assert.rejects(f.call("replan", { batchId: state.batchId }), { code: "TITLE_PLAN_EXPIRED" });
  await assert.rejects(f.call("apply", { batchId: state.batchId }), { code: "TITLE_PLAN_EXPIRED" });
  f.setClock(0);
  await assert.rejects(f.call("apply", { batchId: state.batchId }), { code: "TITLE_PLAN_EXPIRED" });
  assert.equal(f.posts.length, 0);
});

test("an explicitly started long batch keeps exact reviewed recipes after review TTL", async () => {
  const f = fixture();
  let state = await f.review();
  const reviewed = plain(state.items);
  state = await f.call("apply", { batchId: state.batchId });
  for (let index = 0; index < 3; index++) {
    f.advance(TITLE_PLAN_TTL_MS + 100);
    state = await f.call("step", { batchId: state.batchId, stepId: state.nextStepId });
    assert.equal(f.posts[index].payload.before, reviewed[index].plan.before);
    assert.equal(f.posts[index].payload.after, reviewed[index].plan.after);
    assert.equal(f.posts[index].payload.expectedUpdatedAt, reviewed[index].current.updatedAt);
  }
  assert.equal(state.counts.verified, 3); assert.equal(state.phase, "result");
});

test("title and date changes since batch preview are conflicts, not a new automatic recipe", async () => {
  const f = fixture(); let state = await f.review();
  f.patch("chat-a", { title: "Changed on mobile" });
  f.patch("chat-b", { updatedAt: "2026-09-09T00:00:00.000Z" });
  f.patch("chat-c", { createdAt: "2026-08-31T00:00:00.000Z" });
  state = await f.finish(state);
  assert.equal(state.counts.conflict, 2); assert.equal(state.counts.verified, 1); assert.equal(f.posts.length, 1);
  assert.equal(state.items[0].plan.before, "Original chat-a");
  assert.equal(state.items[0].current.title, "Changed on mobile");
});

test("project owner and offscreen project targets retain independently verified route bindings", async () => {
  const f = fixture({ rows: [{ conversationId: "chat-a", projectId: "g-p-project-a" }, { conversationId: "chat-b", projectId: null }] });
  f.owner = { tabId: 31, conversationId: "owner-chat", pathname: "/g/g-p-owner/c/owner-chat", projectId: "g-p-owner" };
  const state = await f.finish(await f.review());
  assert.equal(state.counts.verified, 2);
  assert.equal(f.posts[0].context.targetProjectId, "g-p-project-a");
  assert.equal(f.posts[1].context.targetProjectId, null);
  assert.equal(f.posts[0].context.ownerContext.projectId, "g-p-owner");
});

test("named project owner supports status, worker reopen, preview and explicit execution using the shared identity", async () => {
  const f = fixture();
  const pathname = "/g/g-p-69ea080a91a081919b8a0c0456e1763e-project-name/c/owner-chat";
  f.owner = { tabId: 31, ...plain(TidySnapshot.parseConversationPath(pathname)) };
  for (let reopen = 0; reopen < 3; reopen++) {
    f.batch = f.newBatch();
    assert.equal((await f.call("status")).batchId, null);
  }
  assert.equal(f.reads.length, 0); assert.equal(f.directoryReads.length, 0); assert.equal(f.posts.length, 0);
  const preview = await f.start();
  f.batch = f.newBatch();
  assert.equal((await f.call("status")).batchId, preview.batchId);
  const result = await f.finish(preview);
  assert.equal(result.counts.verified, 3);
  assert.equal(f.posts[0].context.ownerContext.projectId, "g-p-69ea080a91a081919b8a0c0456e1763e");
  assert.equal(f.posts[0].context.ownerContext.pathname, pathname);
});

test("named project owner cannot forge another ID, route, tab or conversation", async () => {
  const f = fixture();
  const id = "g-p-69ea080a91a081919b8a0c0456e1763e";
  f.owner = { tabId: 31, conversationId: "owner-chat", pathname: `/g/${id}-project-name/c/owner-chat`, projectId: id };
  for (const patch of [{ projectId: `${id}-project-name` }, { projectId: "g-p-other" },
    { pathname: `/g/${id}a-project-name/c/owner-chat` }, { conversationId: "other" },
    { pathname: `${f.owner.pathname}/extra` }, { pathname: "/g/custom/c/owner-chat" }]) {
    await assert.rejects(f.call("status", {}, { ...f.owner, ...patch }), { code: "CONTEXT_MISMATCH" });
  }
  const preview = await f.start();
  for (const patch of [{ tabId: 99 }, { pathname: `/g/${id}-other-name/c/owner-chat` }]) {
    await assert.rejects(f.call("apply", { batchId: preview.batchId }, { ...f.owner, ...patch }), { code: "CONTEXT_MISMATCH" });
  }
  assert.equal(f.posts.length, 0);
});

test("an account or workspace switch cannot apply an old batch", async () => {
  for (const next of [{ accountKey: "account-b", workspaceKey: "personal" }, { accountKey: "account-a", workspaceKey: "workspace-b" }]) {
    const f = fixture(); const state = await f.review(); f.setIdentity(next);
    await assert.rejects(f.call("apply", { batchId: state.batchId }), { code: "TITLE_ACCOUNT_CHANGED" });
    assert.equal(f.posts.length, 0);
    const nextCatalogKey = `catalog:${next.accountKey}:${next.workspaceKey}`;
    assert.equal((await f.call("status", { catalogAccountKey: nextCatalogKey })).batchId, null,
      "latest pointer is account-and-workspace isolated");
  }
});

test("another owner cannot locally replan or adopt the opaque batch ID", async () => {
  const f = fixture(); const state = await f.review();
  for (const owner of [{ ...OWNER, tabId: 99 }, { tabId: 31, conversationId: "other", pathname: "/c/other", projectId: null },
    { tabId: 31, conversationId: "owner-chat", pathname: "/g/g-p-other/c/owner-chat", projectId: "g-p-other" }]) {
    await assert.rejects(f.call("replan", { batchId: state.batchId }, owner), { code: "CONTEXT_MISMATCH" });
  }
  assert.equal(f.posts.length, 0);
});

test("account change between the batch lease and writer stops the run before POST", async () => {
  const f = fixture(); let state = await f.review();
  state = await f.call("apply", { batchId: state.batchId });
  f.authorizeHook = async () => f.setIdentity({ accountKey: "account-b", workspaceKey: "personal" });
  state = await f.call("step", { batchId: state.batchId, stepId: state.nextStepId });
  assert.equal(state.phase, "paused"); assert.equal(state.items[0].status, "failed");
  assert.equal(state.items[0].messageCode, "account_changed"); assert.equal(state.nextStepId, null);
  assert.equal(f.posts.length, 0);
});

test("local preview persists only normalized catalog metadata and ignores injected extras", async () => {
  const f = fixture({ rows: ["chat-a"] });
  f.directoryHook = async () => ({ identity: { ...IDENTITY, accessToken: "NEVER-PERSIST-TOKEN" }, accountKey: "catalog-a",
    rows: [{ conversationId: "chat-a", title: "Original chat-a", createdAt: Date.parse("2026-09-01T01:00:00.000Z"),
      updatedAt: Date.parse("2026-09-07T02:00:00.000Z"), messages: ["NEVER-PERSIST-MESSAGES"], forgedScope: "g-p-forged" }] });
  const state = await f.start(), serialized = JSON.stringify([...f.storage.records]);
  assert.equal(state.counts.ready, 1); assert.doesNotMatch(serialized, /NEVER-PERSIST|forgedScope|messages/);
  assert.equal(f.reads.length, 0); assert.equal(f.posts.length, 0);
});

test("a malformed verified adapter result cannot complete a batch without exact title readback", async () => {
  for (const result of [{ status: "verified" }, { status: "verified", current: { conversationId: "wrong", title: "2026-09-01｜Original chat-a" } },
    { status: "verified", current: { conversationId: "chat-a", title: "Not the reviewed title" } }]) {
    const f = fixture({ rows: ["chat-a"] }); f.writeHook = async () => result;
    const state = await f.finish(await f.review());
    assert.equal(state.phase, "paused"); assert.equal(state.counts.verified, 0); assert.equal(state.counts.uncertain, 1);
    assert.equal(f.posts.length, 1);
  }
});

test("a conflicting later title resolves unknown write without claiming success or retrying it", async () => {
  const f = fixture({ rows: ["chat-a"] }); f.writeHook = async () => ({ status: "uncertain" });
  let state = await f.finish(await f.review());
  f.patch("chat-a", { title: "A third title from another device" });
  state = await f.call("reconcile", { batchId: state.batchId });
  assert.equal(state.phase, "result"); assert.equal(state.counts.conflict, 1); assert.equal(state.counts.verified, 0);
  assert.equal(f.posts.length, 1);
});

test("core authorization does not replay its exact completed receipt after a batch checkpoint gap", async () => {
  const f = fixture({ rows: ["chat-a"] }); const preview = await f.review();
  const expected = preview.items[0];
  await f.finish(preview);
  const context = f.posts[0].context;
  const authorize = await f.core.authorize(context, { identity: IDENTITY, current: expected.current, metadataSource: "detail" }, expected.plan);
  assert.equal(authorize.operation.id, expected.plan.id); assert.equal(authorize.operation.status, "verified");
  assert.notEqual(authorize.plan?.id, expected.plan.id);
  await assert.rejects(f.core.handle("apply", context, { planId: expected.plan.id }), { code: "TITLE_PREVIEW_REQUIRED" });
  assert.equal(f.posts.length, 1);
});

test("permission failure is checked per item at final execution and never posts that target", async () => {
  const f = fixture(); f.denied.add("chat-b");
  let state = await f.review();
  assert.equal(state.counts.ready, 3); assert.equal(f.reads.length, 0);
  state = await f.finish(state);
  assert.equal(state.counts.verified, 2); assert.equal(state.counts.failed, 1);
  assert.equal(f.posts.some((post) => post.context.conversationId === "chat-b"), false);
});

test("permission loss after preview is checked again before POST", async () => {
  const f = fixture(); let state = await f.review();
  state = await f.call("apply", { batchId: state.batchId }); f.denied.add("chat-a");
  state = await f.call("step", { batchId: state.batchId, stepId: state.nextStepId });
  assert.equal(f.posts.length, 0);
  assert.equal(state.items[0].status, "failed");
  assert.equal(state.items[0].messageCode, "title_permission_denied");
  assert.equal(state.phase, "applying"); assert.equal(state.counts.ready, 2);
});

test("restart between completed items pauses; status and reconcile never resume writes", async () => {
  const f = fixture(); let state = await f.review();
  state = await f.call("apply", { batchId: state.batchId });
  state = await f.call("step", { batchId: state.batchId, stepId: state.nextStepId });
  const oldToken = state.nextStepId; assert.equal(state.counts.verified, 1);
  f.core = f.newCore(); f.batch = f.newBatch();
  state = await f.call("status", { batchId: state.batchId });
  assert.equal(state.phase, "paused"); assert.equal(state.nextStepId, null);
  await assert.rejects(f.call("step", { batchId: state.batchId, stepId: oldToken }), { code: "INVALID_REQUEST" });
  state = await f.call("reconcile", { batchId: state.batchId });
  assert.equal(state.phase, "paused"); assert.equal(f.posts.length, 1);
  state = await f.call("retry-preview", { batchId: state.batchId });
  assert.equal(state.phase, "preview"); assert.equal(state.counts.verified, 1);
  state = await f.finish(await f.review(state));
  assert.equal(state.counts.verified, 3); assert.equal(f.posts.length, 3);
});

test("same-worker panel reopen can read-only pause an applying job between items", async () => {
  const f = fixture(); let state = await f.review();
  state = await f.call("apply", { batchId: state.batchId });
  state = await f.call("step", { batchId: state.batchId, stepId: state.nextStepId });
  const oldToken = state.nextStepId;
  state = await f.call("status", { batchId: state.batchId });
  assert.equal(state.phase, "applying", "status only observes; opening a panel is not execution consent");
  assert.equal(f.posts.length, 1);
  state = await f.call("reconcile", { batchId: state.batchId });
  assert.equal(state.phase, "paused"); assert.equal(state.nextStepId, null); assert.equal(f.posts.length, 1);
  await assert.rejects(f.call("step", { batchId: state.batchId, stepId: oldToken }), { code: "INVALID_REQUEST" });
  await assert.rejects(f.call("apply", { batchId: state.batchId }), { code: "TITLE_BATCH_RECOVERY_REQUIRED" });
  state = await f.review(await f.call("retry-preview", { batchId: state.batchId }));
  assert.equal(state.counts.verified, 1); assert.equal(state.counts.ready, 2);
  state = await f.finish(state);
  assert.equal(state.counts.verified, 3); assert.equal(f.posts.length, 3);
});

test("a moved target is a per-item writer failure, distinct from owner context loss", async () => {
  const f = fixture();
  f.preflightHook = async (context) => context.conversationId === "chat-a"
    ? { status: "failed", current: plain(f.current.get("chat-a")), messageCode: "TITLE_TARGET_CHANGED" } : null;
  let state = await f.review();
  assert.equal(state.phase, "preview"); assert.equal(state.counts.ready, 3); assert.equal(f.reads.length, 0);
  state = await f.finish(state);
  assert.equal(state.counts.failed, 1); assert.equal(state.counts.verified, 2);
  assert.equal(state.items[0].messageCode, "TITLE_TARGET_CHANGED");
  assert.equal(f.posts.length, 2);
});

test("owner context loss stops final confirmation without changing the local preview", async () => {
  const f = fixture(); const state = await f.start();
  f.beginHook = async () => { throw failure("CONTEXT_MISMATCH"); };
  await assert.rejects(f.call("apply", { batchId: state.batchId }), { code: "CONTEXT_MISMATCH" });
  const restored = await f.call("status", { batchId: state.batchId });
  assert.equal(restored.phase, "preview"); assert.equal(restored.counts.ready, 3); assert.equal(f.posts.length, 0);
});

test("POST timeout reads the actual title, releases recovery, and requires a fresh batch confirmation", async () => {
  const f = fixture(); f.writeHook = async () => { throw failure("network_timeout"); };
  let state = await f.finish(await f.review());
  assert.equal(state.phase, "paused"); assert.equal(state.counts.uncertain, 1); assert.equal(f.posts.length, 1);
  f.core = f.newCore(); f.batch = f.newBatch();
  state = await f.call("status", { batchId: state.batchId });
  state = await f.call("reconcile", { batchId: state.batchId });
  assert.equal(state.phase, "paused"); assert.equal(state.counts.uncertain, 0); assert.equal(state.counts.conflict, 1);
  assert.equal(state.items[0].messageCode, "title_unchanged");
  await assert.rejects(f.start(), { code: "TITLE_BATCH_RECOVERY_REQUIRED" });
  assert.equal(f.posts.length, 1);
  const oldId = state.batchId;
  state = await f.call("retry-preview", { batchId: oldId });
  assert.notEqual(state.batchId, oldId); assert.equal(state.counts.ready, 3);
  assert.equal(f.posts.length, 1, "reviewing must not resubmit");
  await assert.rejects(f.call("apply", { batchId: oldId }), { code: "TITLE_PREVIEW_REQUIRED" });
  f.writeHook = null;
  state = await f.finish(await f.review(state));
  assert.equal(state.counts.verified, 3); assert.equal(f.posts.length, 4);
});

test("late POST commit is recovered read-only, then remaining items demand fresh review", async () => {
  const f = fixture(); f.writeHook = async () => ({ status: "uncertain" });
  let state = await f.finish(await f.review());
  const expected = state.items[0].plan.after;
  f.patch("chat-a", { title: expected });
  state = await f.call("reconcile", { batchId: state.batchId });
  assert.equal(state.counts.verified, 1); assert.equal(state.phase, "paused"); assert.equal(f.posts.length, 1);
  assert.equal(state.observed[0].title, expected);
  f.writeHook = null;
  const beforeReads = f.reads.length;
  state = await f.review(await f.call("retry-preview", { batchId: state.batchId }));
  assert.deepEqual(f.reads.slice(beforeReads).map((call) => call.context.conversationId), []);
  state = await f.finish(state); assert.equal(state.counts.verified, 3); assert.equal(f.posts.length, 3);
});

test("retry keeps cumulative successes and deliberate skips, rereading only failed or conflicted items", async () => {
  const f = fixture({ rows: ["chat-a", { conversationId: "chat-b", title: "2026-09-01｜Already dated" }, "chat-c"] });
  let state = await f.review(); f.patch("chat-c", { title: "External change" });
  state = await f.finish(state);
  assert.equal(state.counts.verified, 1); assert.equal(state.counts.skipped, 1); assert.equal(state.counts.conflict, 1);
  const oldId = state.batchId, beforeReads = f.reads.length;
  state = await f.review(await f.call("retry-preview", { batchId: state.batchId }));
  assert.deepEqual(f.reads.slice(beforeReads).map((call) => call.context.conversationId), []);
  state = await f.finish(state);
  assert.equal(state.counts.verified, 2); assert.equal(state.counts.skipped, 1); assert.equal(state.counts.total, 3);
  assert.equal(f.posts.length, 2);
  await assert.rejects(f.call("status", { batchId: oldId }), { code: "TITLE_PREVIEW_REQUIRED" });
});

test("remove is a fresh forward plan; date-only titles and titles without a head stay skipped", async () => {
  const f = fixture({ rows: [{ conversationId: "chat-a", title: "2026-09-01｜Keep this title" },
    { conversationId: "chat-b", title: "2026-09-01" }, { conversationId: "chat-c", title: "Undated title" }] });
  let state = await f.review(await f.start({ operation: "remove" }));
  assert.equal(state.items[0].plan.after, "Keep this title"); assert.equal(state.items[1].plan.wouldEmpty, true);
  state = await f.finish(state);
  assert.equal(state.counts.verified, 1); assert.equal(state.counts.skipped, 2); assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].payload.after, "Keep this title");
});

test("persisting pending fails before POST and the batch reports a known unsent change", async () => {
  const f = fixture({ rows: ["chat-a"] }); let state = await f.review();
  state = await f.call("apply", { batchId: state.batchId });
  f.storage.reject = (key, value) => !key.startsWith("title-batch.") && value.operation?.status === "pending";
  state = await f.call("step", { batchId: state.batchId, stepId: state.nextStepId });
  assert.equal(state.counts.uncertain, 0); assert.equal(state.counts.failed, 1); assert.equal(f.posts.length, 0);
  f.storage.reject = null;
  state = await f.call("reconcile", { batchId: state.batchId });
  assert.equal(state.counts.failed, 1); assert.equal(state.items[0].messageCode, "title_not_dispatched");
  assert.equal(state.phase, "result"); assert.equal(f.posts.length, 0);
});

test("batch recovery consumes exact prepared evidence, then requires a new reviewed plan", async () => {
  const f = fixture({ rows: ['chat-a'] }); let state = await f.review();
  state = await f.call('apply', { batchId: state.batchId });
  f.storage.reject = (key, value) => !key.startsWith('title-batch.') && value.operation?.dispatchPhase === 'dispatched';
  state = await f.call('step', { batchId: state.batchId, stepId: state.nextStepId });
  assert.equal(state.counts.failed, 1); assert.equal(state.counts.uncertain, 0); assert.equal(f.posts.length, 0);
  assert.equal(state.items[0].messageCode, 'title_not_dispatched');
  f.storage.reject = null;
  const reviewed = await f.call('retry-preview', { batchId: state.batchId });
  assert.equal(reviewed.phase, 'preview'); assert.equal(reviewed.counts.ready, 1);
  assert.equal(f.posts.length, 0, 'a new review is not a retry POST');
});

test("batch pending checkpoint failure prevents even authorizing or dispatching the core", async () => {
  const f = fixture({ rows: ["chat-a"] }); let state = await f.review();
  state = await f.call("apply", { batchId: state.batchId });
  f.storage.reject = (key, value) => key.startsWith("title-batch.job:") && value.items?.some((item) => item.status === "pending");
  await assert.rejects(f.call("step", { batchId: state.batchId, stepId: state.nextStepId }), { code: "storage_failed" });
  assert.equal(f.posts.length, 0); assert.equal(f.writes.length, 0);
  f.storage.reject = null; state = await f.call("status", { batchId: state.batchId });
  assert.equal(state.counts.ready, 1); assert.equal(state.phase, "applying");
});

test("failed core result persistence retains uncertainty and recovers the exact successful POST", async () => {
  const f = fixture({ rows: ["chat-a"] }); let state = await f.review();
  f.storage.reject = (key, value) => !key.startsWith("title-batch.") && value.operation?.status === "verified";
  state = await f.finish(state);
  assert.equal(state.counts.uncertain, 1); assert.equal(state.phase, "paused"); assert.equal(f.posts.length, 1);
  f.storage.reject = null; f.core = f.newCore(); f.batch = f.newBatch();
  state = await f.call("reconcile", { batchId: state.batchId });
  assert.equal(state.counts.verified, 1); assert.equal(state.phase, "result"); assert.equal(f.posts.length, 1);
});

test("failed batch result persistence leaves pending durable and never repeats a verified core receipt", async () => {
  const f = fixture({ rows: ["chat-a"] }); let state = await f.review();
  state = await f.call("apply", { batchId: state.batchId });
  const step = { batchId: state.batchId, stepId: state.nextStepId };
  f.storage.reject = (key, value) => key.startsWith("title-batch.job:") && value.items?.some((item) => item.status === "verified");
  await assert.rejects(f.call("step", step), { code: "storage_failed" });
  assert.equal(f.posts.length, 1);
  f.storage.reject = null; f.core = f.newCore(); f.batch = f.newBatch();
  state = await f.call("status", { batchId: state.batchId });
  assert.equal(state.counts.uncertain, 1); assert.equal(state.phase, "paused");
  state = await f.call("step", step); assert.equal(state.counts.uncertain, 1); assert.equal(f.posts.length, 1);
  state = await f.call("reconcile", { batchId: state.batchId });
  assert.equal(state.counts.verified, 1); assert.equal(f.posts.length, 1);
});

test("lost batch checkpoint recovers a durable production accepted receipt against fresh actual titles", async (t) => {
  for (const observedTitle of ["after", "before", "external"]) {
    await t.test(observedTitle, async () => {
      const f = fixture({ rows: ["chat-a", "chat-b"] });
      f.writeHook = async (context, payload, observed) => {
        // Production batch 2xx returns accepted without a detail readback.
        const accepted = { ...observed, title: payload.after };
        f.patch(context.conversationId, accepted);
        return { status: "accepted", accepted, httpStatus: 200 };
      };
      let state = await f.start();
      const plan = plain(state.items[0].plan);
      state = await f.call("apply", { batchId: state.batchId });
      const oldStep = { batchId: state.batchId, stepId: state.nextStepId };
      f.storage.reject = (key, value) => key.startsWith("title-batch.job:")
        && value.items?.some(item => item.status === "accepted");
      await assert.rejects(f.call("step", oldStep), { code: "storage_failed" });
      const core = [...f.storage.records.entries()].find(([key]) => !key.startsWith("title-batch."))[1];
      assert.equal(core.operation.status, "accepted");
      assert.equal(core.operation.id, plan.id);
      assert.equal(f.posts.length, 1);

      f.storage.reject = null; f.core = f.newCore(); f.batch = f.newBatch();
      f.patch("chat-a", { title: observedTitle === "external" ? "Changed elsewhere" : plan[observedTitle] });
      state = await f.call("status", { batchId: state.batchId });
      assert.equal(state.counts.uncertain, 1);
      state = await f.call("step", oldStep);
      assert.equal(state.counts.uncertain, 1, "the old execution token stays consumed");
      f.readHook = async () => { throw failure("TITLE_AUTH_REQUIRED"); };
      await assert.rejects(f.call("reconcile", { batchId: state.batchId }), { code: "TITLE_AUTH_REQUIRED" });
      const retainedCore = [...f.storage.records.entries()].find(([key]) => !key.startsWith("title-batch."))[1];
      assert.equal(retainedCore.operation.status, "accepted", "failed authentication does not settle a receipt");
      assert.equal(f.posts.length, 1);
      f.readHook = null;
      state = await f.call("reconcile", { batchId: state.batchId });
      assert.equal(state.counts.uncertain, 0);
      assert.equal(state.items[0].status, observedTitle === "after" ? "verified" : "conflict");
      assert.equal(state.items[0].settled, observedTitle === "after");
      assert.equal(state.items[1].status, "ready");
      assert.equal(state.phase, "paused"); assert.equal(state.pauseReason, "review-required");
      assert.equal(state.nextStepId, null);
      assert.equal(f.posts.length, 1, "reading back accepted never dispatches another item");
      const reviewed = await f.call("retry-preview", { batchId: state.batchId });
      assert.equal(reviewed.phase, "preview");
      assert.notEqual(reviewed.batchId, state.batchId);
      assert.equal(f.posts.length, 1, "remaining work still requires a new explicit confirmation");
    });
  }
});

test("accepted recovery cannot count another operation's matching title as this batch success", async () => {
  const f = fixture({ rows: ["chat-a"] });
  f.writeHook = async (context, payload, observed) => {
    const accepted = { ...observed, title: payload.after };
    f.patch(context.conversationId, accepted);
    return { status: "accepted", accepted, httpStatus: 200 };
  };
  let state = await f.start();
  state = await f.call("apply", { batchId: state.batchId });
  f.storage.reject = (key, value) => key.startsWith("title-batch.job:")
    && value.items?.some(item => item.status === "accepted");
  await assert.rejects(f.call("step", { batchId: state.batchId, stepId: state.nextStepId }), { code: "storage_failed" });
  const [key, core] = [...f.storage.records.entries()].find(([recordKey]) => !recordKey.startsWith("title-batch."));
  core.operation.id = "another-accepted-operation";
  f.storage.records.set(key, core);
  f.storage.reject = null; f.core = f.newCore(); f.batch = f.newBatch();
  state = await f.call("reconcile", { batchId: state.batchId });
  assert.equal(state.counts.verified, 0); assert.equal(state.counts.accepted, 0);
  assert.equal(state.items[0].status, "conflict");
  assert.equal(state.items[0].messageCode, "title_rechecked");
  assert.equal(state.items[0].settled, false); assert.equal(f.posts.length, 1);
});

for (const receiptState of ["missing", "different"]) {
  test(`batch recovery accepts fresh actual state with a ${receiptState} receipt, never old success`, async () => {
    const f = fixture({ rows: ["chat-a"] });
    f.writeHook = async () => ({ status: "uncertain" });
    let state = await f.finish(await f.start());
    const oldId = state.batchId;
    for (const [key, value] of f.storage.records) {
      if (key.startsWith("title-batch.")) continue;
      value.operation = receiptState === "missing" ? null : { ...value.operation, id: "unrelated-receipt", status: "verified" };
      f.storage.records.set(key, value);
    }
    f.patch("chat-a", { title: "Manually changed", updatedAt: "2026-09-10T00:00:00.000Z" });
    const beforeReads = f.reads.length;
    state = await f.call("reconcile", { batchId: oldId });
    assert.equal(f.reads.length - beforeReads, 1); assert.equal(f.posts.length, 1);
    assert.equal(state.counts.verified, 0); assert.equal(state.counts.uncertain, 0);
    assert.equal(state.items[0].status, "conflict"); assert.equal(state.items[0].messageCode, "title_rechecked");
    state = await f.call("retry-preview", { batchId: oldId });
    assert.notEqual(state.batchId, oldId); assert.equal(state.items[0].plan.before, "Manually changed");
    assert.equal(f.posts.length, 1);
    await assert.rejects(f.call("apply", { batchId: oldId }), { code: "TITLE_PREVIEW_REQUIRED" });
    f.writeHook = null; state = await f.finish(state);
    assert.equal(state.counts.verified, 1); assert.equal(f.posts.length, 2);
  });
}

test("batch read failure or changed account cannot release an unknown operation", async () => {
  const f = fixture({ rows: ["chat-a"] }); f.writeHook = async () => ({ status: "uncertain" });
  let state = await f.finish(await f.start()); const batchId = state.batchId;
  f.readHook = async () => { throw failure("NETWORK"); };
  await assert.rejects(f.call("reconcile", { batchId }), { code: "NETWORK" });
  f.readHook = null; f.setIdentity({ ...IDENTITY, accountKey: "another-account" });
  await assert.rejects(f.call("reconcile", { batchId }), { code: "CONTEXT_MISMATCH" });
  state = await f.call("status", { batchId }); assert.equal(state.counts.uncertain, 1);
  await assert.rejects(f.call("retry-preview", { batchId }), { code: "TITLE_BATCH_RECOVERY_REQUIRED" });
  assert.equal(f.posts.length, 1);
  f.setIdentity(IDENTITY); state = await f.call("reconcile", { batchId });
  assert.equal(state.counts.uncertain, 0); assert.equal(state.items[0].messageCode, "title_unchanged");
  assert.equal(f.posts.length, 1);
});

test("another panel preview between batch authorize and apply cannot steal the writer target", async () => {
  const f = fixture({ rows: ["chat-a"] });
  const otherContext = { tabId: 99, conversationId: "chat-a" };
  f.authorizeHook = async () => f.core.handle("preview", otherContext, { rules: { ...RULES, dateFormat: "dot" } });
  const state = await f.finish(await f.review());
  assert.equal(state.counts.failed, 1); assert.equal(state.items[0].messageCode, "TITLE_PREVIEW_REQUIRED");
  assert.equal(f.posts.length, 0, "the wrong panel plan must not be substituted for the confirmed batch plan");
});

test("an unrelated unresolved core operation is discovered only at execution and never counted as this batch success", async () => {
  const f = fixture({ rows: ["chat-a"] });
  const context = { tabId: 99, conversationId: "chat-a" };
  const preview = await f.core.handle("preview", context, { rules: RULES });
  f.writeHook = async () => ({ status: "uncertain" });
  await f.core.handle("apply", context, { planId: preview.plan.id });
  let state = await f.start(); assert.equal(state.phase, "preview"); assert.equal(state.counts.ready, 1);
  state = await f.finish(state); assert.equal(state.phase, "result"); assert.equal(state.counts.uncertain, 0);
  assert.equal(state.counts.verified, 0); assert.equal(state.counts.failed, 1);
  assert.equal(state.items[0].messageCode, "title_preview_required"); assert.equal(f.posts.length, 1);
});

test("malformed selection, retired operation and unsupported owner routes fail before directory IO", async () => {
  const f = fixture();
  for (const conversationIds of [[], null, ["chat-a", "chat-a"], ["../chat-a"], [42]]) {
    await assert.rejects(f.call("preview", { conversationIds, rules: RULES }), { code: "INVALID_REQUEST" });
  }
  await assert.rejects(f.start({ operation: "undo" }), { code: "INVALID_REQUEST" });
  for (const owner of [{ ...OWNER, pathname: "/" }, { ...OWNER, pathname: "/c/wrong" }, { ...OWNER, projectId: "g-p-forged" },
    { ...OWNER, tabId: -1 }, { ...OWNER, pathname: "/gg/group-a" }]) {
    await assert.rejects(f.call("preview", { conversationIds: ["chat-a"] }, owner), { code: "CONTEXT_MISMATCH" });
  }
  assert.equal(f.directoryReads.length, 0); assert.equal(f.posts.length, 0);
});

test("directory must authenticate exactly all selected IDs and only genuine project identifiers", async () => {
  for (const rows of [[], [{ conversationId: "chat-x" }], [{ conversationId: "chat-a" }, { conversationId: "chat-a" }],
    [{ conversationId: "chat-a", projectId: "g-custom-gpt" }]]) {
    const f = fixture({ rows: ["chat-a"] });
    f.directoryHook = async () => ({ identity: IDENTITY, accountKey: "catalog-a", rows });
    await assert.rejects(f.start(), { code: "CONTEXT_MISMATCH" }); assert.equal(f.reads.length, 0);
  }
});

test("a replaced preview is never executable, including when old-record deletion fails", async () => {
  const f = fixture({ rows: ["chat-a"] }); const state = await f.review();
  f.storage.rejectRemove = () => true;
  await assert.rejects(f.call("replan", { batchId: state.batchId, rules: { ...RULES, dateFormat: "dot" } }), { code: "storage_failed" });
  f.storage.rejectRemove = null;
  assert.ok(f.storage.records.has(`title-batch.job:${state.batchId}`), "failed deletion retains the old record, not its authority");
  await assert.rejects(f.call("apply", { batchId: state.batchId }), { code: "TITLE_PREVIEW_REQUIRED" });
  const recovered = await f.call("status");
  assert.notEqual(recovered.batchId, state.batchId); assert.equal(recovered.rules.dateFormat, "dot"); assert.equal(f.posts.length, 0);
});

test("100 local replans keep only the latest batch and pointer, without tombstones or HTTP reads", async () => {
  const f = fixture({ rows: ["chat-a"] });
  let state = await f.review();
  const oldIds = [];
  for (let index = 0; index < 100; index++) {
    oldIds.push(state.batchId);
    state = await f.call("replan", { batchId: state.batchId, rules: { ...RULES, dateFormat: index % 2 ? "iso" : "dot" } });
    assert.equal(f.storage.records.size, 2);
  }
  for (const batchId of oldIds) await assert.rejects(f.call("apply", { batchId }), { code: "TITLE_PREVIEW_REQUIRED" });
  assert.equal(f.posts.length, 0); assert.equal(f.reads.length, 0);
  assert.equal(f.directoryReads.length, 1);
  assert.equal((await f.finish(state)).counts.verified, 1, "only a new explicit confirmation executes the latest plan");
  assert.equal(f.posts.length, 1);
});

test("external rename review refreshes only named unexecuted catalog rows and invalidates the previous ID", async () => {
  const f = fixture({ rows: ["chat-a", "chat-b"] }), original = await f.review();
  const untouched = plain(original.items[1].current);
  f.directoryHook = async (_owner, payload) => {
    assert.deepEqual(plain(payload.conversationIds), ["chat-a"]); assert.equal(payload.refreshOnly, true);
    return { accountKey: original.catalogAccountKey, identity: IDENTITY, rows: [{ conversationId: "chat-a",
      title: "Native title", projectId: null, createdAt: Date.parse(original.items[0].current.createdAt),
      updatedAt: Date.parse(original.items[0].current.updatedAt) }] };
  };
  for (const refreshConversationIds of [["other"], ["chat-a", "chat-a"], "chat-a"]) {
    await assert.rejects(f.call("retry-preview", { batchId: original.batchId, refreshConversationIds }), { code: "INVALID_REQUEST" });
  }
  const updated = await f.call("retry-preview", { batchId: original.batchId, refreshConversationIds: ["chat-a"] });
  assert.equal(updated.items[0].current.title, "Native title");
  assert.deepEqual(plain(updated.items[1].current), untouched);
  assert.equal(f.posts.length, 0); assert.equal(f.reads.length, 0);
  await assert.rejects(f.call("apply", { batchId: original.batchId }), { code: "TITLE_PREVIEW_REQUIRED" });
});

// Normal directories contain dates; the earlier fixtures intentionally omit
// them to exercise the bounded metadata-supplement and interruption paths.
test("complete catalog previews N titles in one local pass without per-target auth or metadata reads", async () => {
  const f = fixture({ completeCatalog: true, rows: Array.from({ length: 100 }, (_, i) => `chat-${i}`) });
  const state = await f.start();
  assert.equal(state.phase, "preview"); assert.equal(state.counts.ready, 100);
  assert.equal(state.nextStepId, null); assert.equal(f.reads.length, 0);
  assert.equal(f.directoryReads.length, 1); assert.equal(f.storage.writes.length, 2, "one batch plus its latest pointer, not N whole-batch checkpoints");
  assert.equal(f.posts.length, 0); assert.ok(!JSON.stringify([...f.storage.records]).includes("NEVER-PERSIST"));
});

test("catalog timestamp drift reuses the writer preflight only when the confirmed title stays identical", async () => {
  // Include the observed 802/1445/1700ms cases and a much larger same-day
  // difference: correctness is output equality, never an arbitrary tolerance.
  for (const delta of [802, 1445, 1700, 3297, 3600000]) {
    const f = fixture({ completeCatalog: true, rows: ["chat-a"] });
    const detail = plain(f.current.get("chat-a"));
    f.directoryHook = async () => ({ identity: IDENTITY, accountKey: "catalog-a", rows: [{ conversationId: "chat-a",
      title: detail.title, createdAt: Date.parse(detail.createdAt), updatedAt: Date.parse(detail.updatedAt) - delta }] });
    let state = await f.start({ rules: { ...RULES, mode: "range" } });
    state = await f.call("replan", { batchId: state.batchId, rules: { ...state.rules, dateFormat: "dot" } });
    const reviewed = plain(state.items[0].plan);
    assert.equal(f.reads.length, 0, "preview and choices still use the local directory");
    const result = await f.finish(state);
    assert.equal(result.counts.verified, 1, `cross-source delta ${delta}ms must not be compared as a version`);
    assert.equal(f.posts.length, 1);
    assert.equal(f.posts[0].payload.before, reviewed.before); assert.equal(f.posts[0].payload.after, reviewed.after);
    assert.equal(f.posts[0].payload.expectedCreatedAt, detail.createdAt);
    assert.equal(f.posts[0].payload.metadataSource, "catalog");
    assert.equal(f.posts[0].payload.expectedUpdatedAt, state.items[0].current.updatedAt);
    assert.deepEqual(f.posts[0].payload.catalogIntent, { operation: reviewed.operation, rules: reviewed.rules, decision: reviewed.selectedDecision });
    assert.deepEqual(plain(result.items[0].plan), reviewed, "validation may not replace the confirmed recipe");
    assert.equal(f.reads.filter(call => !call.input?.identityOnly).length, 0, "no full read is added before the writer");
  }
});

test("a tiny cross-source delta crossing a date boundary requires a new review, not a changed POST", async () => {
  const f = fixture({ completeCatalog: true, rows: ["chat-a"] });
  const directoryTime = "2026-09-07T23:59:59.500Z", detailTime = "2026-09-08T00:00:00.700Z";
  f.patch("chat-a", { updatedAt: detailTime });
  f.directoryHook = async () => ({ identity: IDENTITY, accountKey: "catalog-a", rows: [{ conversationId: "chat-a",
    title: f.current.get("chat-a").title, createdAt: Date.parse(f.current.get("chat-a").createdAt), updatedAt: Date.parse(directoryTime) }] });
  const state = await f.start({ rules: { ...RULES, mode: "range" } }), reviewed = plain(state.items[0].plan);
  const result = await f.finish(state);
  assert.equal(result.counts.conflict, 1); assert.equal(result.items[0].messageCode, "dates_changed");
  assert.deepEqual(plain(result.items[0].dateDifferences), { updatedAt: { expected: directoryTime, actual: detailTime } });
  assert.deepEqual(plain(result.items[0].plan), reviewed);
  assert.equal(f.posts.length, 0); assert.equal(f.writes.length, 1, "changed intent is rejected inside the existing preflight, before POST");
});

test("a one-millisecond catalog/detail delta with identical rendered intent does not create a false conflict", async () => {
  const f = fixture({ rows: ["chat-a"] });
  const state = await f.start({ rules: { ...RULES, mode: "range" } });
  const original = f.current.get("chat-a").updatedAt;
  f.authorizeHook = async () => f.patch("chat-a", { updatedAt: new Date(Date.parse(original) + 1).toISOString() });
  const result = await f.finish(state);
  assert.equal(result.counts.verified, 1);
  assert.equal(f.writes[0].payload.expectedUpdatedAt, original); assert.equal(f.posts.length, 1);
});

test("catalog preflight stops the batch on rate limits or account changes without POST or another target", async () => {
  for (const code of ["TITLE_RATE_LIMITED", "TITLE_ACCOUNT_CHANGED"]) {
    const f = fixture({ completeCatalog: true });
    const state = await f.start();
    f.preflightHook = async () => ({ status: "failed", messageCode: code === "TITLE_RATE_LIMITED" ? "title_rate_limited" : "account_changed" });
    const result = await f.finish(state);
    assert.equal(result.phase, "paused"); assert.equal(result.counts.ready, 2);
    assert.equal(result.pauseReason, code === "TITLE_RATE_LIMITED" ? "rate-limited" : "context-changed");
    assert.equal(f.reads.length, 0); assert.equal(f.posts.length, 0); assert.equal(f.writes.length, 1);
  }
});

test("a ready checkpoint without an explicit metadata source must be reviewed again", async () => {
  const f = fixture({ completeCatalog: true, rows: ["chat-a"] }), state = await f.start();
  const key = `title-batch.job:${state.batchId}`, job = await f.storage.get(key);
  delete job.items[0].metadataSource;
  await f.storage.set(key, job);
  await assert.rejects(f.call("replan", { batchId: state.batchId, rules: RULES }), { code: "TITLE_PREVIEW_REQUIRED" });
  await assert.rejects(f.call("apply", { batchId: state.batchId }), { code: "TITLE_PREVIEW_REQUIRED" });
  assert.equal(f.posts.length, 0); assert.equal(f.reads.length, 0);
});

test("catalog authorization preserves the user's replace, stack and remove decisions", async () => {
  for (const decision of ["replace", "stack", "remove"]) {
    const f = fixture({ completeCatalog: true, rows: [{ conversationId: "chat-a", title: "2026-08-20｜Existing" }] });
    let state = await f.start({ operation: decision === "remove" ? "remove" : "assign" });
    if (decision !== "remove") state = await f.call("replan", { batchId: state.batchId, decisions: { "chat-a": decision } });
    const reviewed = plain(state.items[0].plan);
    f.patch("chat-a", { updatedAt: "2026-09-07T02:00:01.700Z" });
    const result = await f.finish(state);
    assert.equal(result.counts.verified, 1, decision);
    assert.equal(f.posts[0].payload.after, reviewed.after);
    assert.deepEqual(plain(result.items[0].plan), reviewed);
  }
});

test("catalog authorization recovers its already-dispatched exact core receipt instead of treating it as changed intent", async () => {
  for (const status of ["verified", "uncertain"]) {
    const f = fixture({ completeCatalog: true, rows: ["chat-a"] }), state = await f.start(), item = state.items[0];
    const context = { tabId: OWNER.tabId, conversationId: item.conversationId, targetProjectId: null,
      ownerContext: { conversationId: OWNER.conversationId, pathname: OWNER.pathname, projectId: null },
      batchScopeId: state.batchId, expectedIdentity: IDENTITY };
    await f.core.authorize(context, { identity: IDENTITY, current: item.current, metadataSource: "catalog" }, item.plan);
    if (status === "uncertain") f.writeHook = async () => ({ status: "uncertain" });
    await f.core.handle("apply", context, { planId: item.plan.id });
    assert.equal(f.posts.length, 1);
    const result = await f.finish(state);
    assert.equal(result.items[0].status, status === "uncertain" ? "conflict" : status);
    assert.equal(f.posts.length, 1, "authorization/reconciliation must not replay an existing operation");
  }
});

test("failed reconciliation of an operation discovered during authorization retains uncertainty", async () => {
  const f = fixture({ completeCatalog: true, rows: ["chat-a"] }), state = await f.start();
  const otherContext = { tabId: 99, conversationId: "chat-a" };
  const other = await f.core.handle("preview", otherContext, { rules: RULES });
  f.writeHook = async () => ({ status: "uncertain" });
  await f.core.handle("apply", otherContext, { planId: other.plan.id });
  const original = f.core;
  f.core = { ...original, handle: (action, ...args) => {
    if (action === "reconcile") throw failure("CONTEXT_MISMATCH");
    return original.handle(action, ...args);
  } };
  const result = await f.finish(state);
  assert.equal(result.phase, "paused"); assert.equal(result.counts.uncertain, 1);
  assert.equal(result.pauseReason, "outcome-unknown"); assert.equal(f.posts.length, 1);
  await assert.rejects(f.call("retry-preview", { batchId: state.batchId }), { code: "TITLE_BATCH_RECOVERY_REQUIRED" });
});

test("a fresh detail read restores missing provenance without replaying an unknown write", async () => {
  const f = fixture({ completeCatalog: true, rows: ["chat-a"] });
  f.writeHook = async () => ({ status: "uncertain" });
  const state = await f.finish(await f.start()), key = `title-batch.job:${state.batchId}`;
  const job = await f.storage.get(key); delete job.items[0].metadataSource; await f.storage.set(key, job);
  const result = await f.call("reconcile", { batchId: state.batchId });
  assert.equal(result.counts.uncertain, 0); assert.equal(result.counts.conflict, 1); assert.equal(f.posts.length, 1);
  assert.equal((await f.storage.get(key)).items[0].metadataSource, "detail");
  assert.equal((await f.call("retry-preview", { batchId: state.batchId })).counts.ready, 1);
});

test("catalog-based review cannot overwrite a changed title or silently change either date in a range", async () => {
  const f = fixture({ completeCatalog: true }); const state = await f.start({ rules: { ...RULES, mode: "range" } });
  f.patch("chat-a", { title: "External edit" });
  f.patch("chat-b", { createdAt: "2026-08-01T00:00:00.000Z" });
  f.patch("chat-c", { updatedAt: "2026-09-09T00:00:00.000Z" });
  const result = await f.finish(state);
  assert.equal(result.counts.conflict, 3); assert.equal(f.posts.length, 0);
});

test("local preview does not touch editor drafts, while its own unknown receipt still blocks replacement after restart", async () => {
  const f = fixture({ completeCatalog: true, rows: ["chat-a"] });
  const context = { tabId: 99, conversationId: "chat-a" };
  const old = await f.core.handle("preview", context, { rules: RULES });
  const reads = f.reads.length;
  let state = await f.start();
  assert.equal(f.reads.length, reads); assert.equal(state.counts.ready, 1);
  assert.equal([...f.storage.records.values()].find(value => value.conversationId === "chat-a").plan.id, old.plan.id);
  f.writeHook = async () => ({ status: "uncertain" });
  state = await f.finish(state); assert.equal(state.phase, "paused"); assert.equal(f.posts.length, 1);
  f.core = f.newCore(); f.batch = f.newBatch();
  await assert.rejects(f.start(), { code: "TITLE_BATCH_RECOVERY_REQUIRED" });
  assert.equal(f.posts.length, 1);
});

test("a failed final authorization is visible and never dispatches the catalog row", async () => {
  const f = fixture({ completeCatalog: true, rows: ["chat-a"] });
  await f.core.handle("preview", { tabId: 99, conversationId: "chat-a" }, { rules: RULES });
  const state = await f.start();
  f.storage.reject = (key, value) => !key.startsWith("title-batch.") && value.plan?.id === state.items[0].plan.id;
  const result = await f.finish(state);
  assert.equal(result.counts.failed, 1); assert.equal(result.items[0].messageCode, "storage_failed"); assert.equal(f.posts.length, 0);
});

test("partial date coverage stays local, marks only the missing row skipped, and makes no detail request", async () => {
  const f = fixture({ completeCatalog: true });
  f.directoryHook = async () => ({ identity: IDENTITY, accountKey: "catalog-a", rows: f.rows.map((row, i) => ({
    ...row, title: `Original ${row.conversationId}`, createdAt: i === 1 ? null : Date.parse(f.current.get(row.conversationId).createdAt),
    updatedAt: Date.parse(f.current.get(row.conversationId).updatedAt),
  })) });
  const state = await f.start();
  assert.equal(state.phase, "preview"); assert.equal(state.counts.prepared, 3); assert.equal(f.reads.length, 0);
  const original = plain(state.items[0].plan);
  assert.equal(state.counts.ready, 2); assert.equal(state.counts.skipped, 1); assert.deepEqual(plain(state.items[0].plan), original);
});

test("catalog preview persistence failure returns no receipt and cannot authorize any write", async () => {
  const f = fixture({ completeCatalog: true });
  f.storage.reject = (key) => key.startsWith("title-batch.job:");
  await assert.rejects(f.start(), { code: "storage_failed" });
  assert.equal(f.posts.length, 0); assert.equal(f.reads.length, 0);
});

test("preview never enters the metadata 429 path because it performs no remote supplement", async () => {
  const f = fixture({ completeCatalog: false });
  f.readHook = async () => { throw failure("TITLE_RATE_LIMITED"); };
  const state = await f.start();
  assert.equal(state.phase, "preview"); assert.equal(state.counts.skipped, 3);
  assert.equal(f.reads.length, 0); assert.equal(f.posts.length, 0); assert.equal(state.pauseReason, undefined);
});

test("a rate-limited write receipt pauses remaining targets instead of amplifying the request burst", async () => {
  const f = fixture({ completeCatalog: true });
  f.writeHook = async (_context, _payload, current) => ({ status: "failed", current, httpStatus: 429, messageCode: "http_error" });
  const state = await f.finish(await f.start());
  assert.equal(state.phase, "paused"); assert.equal(state.counts.failed, 1); assert.equal(f.posts.length, 1);
  assert.equal(state.counts.ready, 2); assert.equal(state.nextStepId, null);
  assert.equal(state.items[0].messageCode, "TITLE_RATE_LIMITED");
  assert.equal(state.pauseReason, "rate-limited");
});

test("a plain title ignores same-day catalog timestamp drift when its rendered intent is unchanged", async () => {
  const f = fixture({ rows: [{ conversationId: "chat-a", title: "Plain title" }] });
  const preview = await f.review();
  assert.equal(preview.items[0].plan.hasDateHead, false);
  const before = preview.items[0].current.updatedAt;
  const after = new Date(Date.parse(before) + 1752).toISOString();
  f.authorizeHook = async () => f.patch("chat-a", { updatedAt: after });
  const result = await f.finish(preview);
  assert.equal(result.counts.verified, 1); assert.equal(result.items[0].messageCode, "title_verified");
  assert.equal(f.posts.length, 1); assert.equal(f.writes[0].payload.expectedUpdatedAt, before);
});

test("runtime interruption and read-only review expose distinct durable pause reasons", async () => {
  const f = fixture({ completeCatalog: true });
  let result = await f.call("apply", { batchId: (await f.start()).batchId });
  result = await f.call("step", { batchId: result.batchId, stepId: result.nextStepId });
  f.batch = f.newBatch();
  result = await f.call("status");
  assert.equal(result.pauseReason, "runtime-restarted");
  assert.equal(f.posts.length, 1);
  result = await f.call("reconcile", { batchId: result.batchId });
  assert.equal(result.pauseReason, "review-required");
  result = await f.call("retry-preview", { batchId: result.batchId });
  assert.equal(result.pauseReason, undefined);
  assert.equal(f.posts.length, 1);
});
