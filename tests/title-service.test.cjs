const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");

const ROOT = path.resolve(__dirname, "..");
const plain = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const source = (file) => fs.readFileSync(path.join(ROOT, file), "utf8")
  .replace(/^import[^;]+;\r?\n/gm, "")
  .replace(/^export\s+\{[^;]+;\r?\n/gm, "")
  .replaceAll("export ", "");

function loadModule(file, names, globals = {}) {
  const context = vm.createContext({ Date, JSON, Object, Array, String, Number, Boolean, Promise, Math, ...globals });
  vm.runInContext(`${source(file)}\nglobalThis.result = {${names.join(",")}};`, context, { filename: file });
  return context.result;
}

const { createTitleService, TITLE_PLAN_TTL_MS } = loadModule("src/features/titles/background/title-service.js", ["createTitleService", "TITLE_PLAN_TTL_MS"], {
  titleOperationsRepository: null,
});

const CONTEXT = Object.freeze({ tabId: 31, conversationId: "conversation-a" });
const INITIAL = Object.freeze({
  conversationId: "conversation-a", title: "Original title", createdAt: "2026-09-01T01:00:00.000Z", updatedAt: "2026-09-07T02:00:00.000Z",
});

function memoryStorage() {
  const records = new Map();
  const writes = [];
  return {
    records, writes,
    get: async (key) => plain(records.get(key)) || null,
    set: async (key, value) => { writes.push(plain(value)); records.set(key, plain(value)); },
  };
}

const model = {
  normalizeRules: (value = {}) => ({ mode: "range", dateFormat: "iso", timeZone: "Asia/Singapore", locale: "zh-CN", ...value }),
  plan: (metadata, rules, options = {}) => {
    const after = options.operation === "remove" ? metadata.title.replace(/^\[2026-09-01 ~ 09-07\] /, "") : `[2026-09-01 ~ 09-07] ${metadata.title}`;
    return {
      before: metadata.title, after, rules, operation: options.operation || "assign", action: options.operation || "assign",
      canApply: after !== metadata.title, noOp: after === metadata.title, needsDecision: false,
      selectedDecision: "skip", hasDateHead: false, wouldEmpty: false, targetLayer: "[2026-09-01 ~ 09-07]",
    };
  },
};

function fixture(options = {}) {
  let current = plain(INITIAL);
  let identity = { accountKey: "account-a", workspaceKey: "personal" };
  let clock = 1000;
  let ids = 0;
  const readCalls = [];
  const readOptions = [];
  const writeCalls = [];
  const dispatchedCalls = [];
  const storage = options.storage || memoryStorage();
  const read = async (context, input) => {
    readCalls.push(plain(context));
    readOptions.push(plain(input));
    if (input?.identityOnly) return { identity: { ...identity, accessToken: "DO-NOT-PERSIST" }, catalogAccountKey: options.identityCatalogAccountKey };
    return { identity: { ...identity, accessToken: "DO-NOT-PERSIST" }, current: { ...current, messages: ["private message"] },
      accessToken: "DO-NOT-PERSIST", catalogAccountKey: options.readCatalogAccountKey };
  };
  const write = async (context, payload, beforeDispatch) => {
    writeCalls.push({ context: plain(context), payload: plain(payload) });
    // The production writer owns the final metadata preflight. Calling the
    // adapter is not a POST: a stale title/date exits before dispatch.
    if (current.title !== payload.before) return { status: "conflict", current: plain(current), messageCode: "title_conflict" };
    for (const [expected, field] of [["expectedCreatedAt", "createdAt"], ["expectedUpdatedAt", "updatedAt"]]) {
      if (Object.hasOwn(payload, expected) && payload[expected] !== current[field]) {
        return { status: "conflict", current: plain(current), messageCode: "dates_changed" };
      }
    }
    if (options.beforeDispatch) await options.beforeDispatch(context, payload, beforeDispatch);
    await beforeDispatch();
    dispatchedCalls.push({ context: plain(context), payload: plain(payload) });
    if (options.write) return options.write(context, payload, { current, setCurrent: (value) => { current = value; }, storage });
    current = { ...current, title: payload.after, updatedAt: "2026-09-08T03:00:00.000Z" };
    return { status: "verified", current: plain(current), httpStatus: 200, catalogAccountKey: options.writeCatalogAccountKey };
  };
  const makeService = () => createTitleService({ read, write, storage, model: options.model || model, now: () => clock,
    createId: () => `operation-${++ids}`, onVerified: options.onVerified, onAccepted: options.onAccepted });
  return {
    service: makeService(), makeService, storage, readCalls, readOptions, writeCalls, dispatchedCalls,
    current: () => plain(current), setCurrent: (patch) => { current = { ...current, ...patch }; },
    setIdentity: (value) => { identity = value; }, setClock: (value) => { clock = value; },
  };
}

const preview = (f, payload = {}) => f.service.handle("preview", CONTEXT, payload);
const apply = (f, plan) => f.service.handle("apply", CONTEXT, { planId: plan.id });
const replan = (f, previewContext, payload = {}) => f.service.handle("replan", CONTEXT, { ...payload, previewContextId: previewContext.id });

const BATCH_CONTEXT = Object.freeze({ ...CONTEXT,
  ownerContext: { conversationId: "owner", pathname: "/c/owner", projectId: null },
  targetProjectId: null, batchScopeId: "confirmed-batch", expectedIdentity: { accountKey: "account-a", workspaceKey: "personal" } });
function batchRecipe(f, id = "batch-confirmed-recipe") {
  return { ...model.plan(f.current(), model.normalizeRules()), id, kind: "apply", conversationId: CONTEXT.conversationId };
}
const authorizeBatch = (f, recipe) => f.service.authorize(BATCH_CONTEXT, { identity: BATCH_CONTEXT.expectedIdentity, current: f.current(), metadataSource: "detail" }, recipe);

test("batch 2xx persists an accepted receipt and projects its exact title without inventing readback", async () => {
  const acceptedCalls = [], verifiedCalls = [];
  const f = fixture({ onAccepted: async (context, value) => {
    assert.equal([...f.storage.records.values()][0].operation.status, "accepted", "receipt is durable before projection");
    acceptedCalls.push({ context: plain(context), value: plain(value) });
  }, onVerified: (...args) => verifiedCalls.push(args), write: async (_context, payload, { current }) => ({
    status: "accepted", accepted: { ...plain(current), title: payload.after }, httpStatus: 200,
    catalogAccountKey: "catalog-accepted",
  }) });
  const recipe = batchRecipe(f); await authorizeBatch(f, recipe);
  const result = await f.service.applyAuthorized(BATCH_CONTEXT, BATCH_CONTEXT.expectedIdentity, recipe.id);
  assert.equal(result.operation.status, "accepted"); assert.equal(result.current, null);
  assert.equal(result.accepted.title, recipe.after); assert.equal(result.previewContext, null);
  assert.equal(verifiedCalls.length, 0); assert.deepEqual(acceptedCalls, [{ context: plain(BATCH_CONTEXT), value: {
    catalogAccountKey: "catalog-accepted", accepted: { ...plain(INITIAL), title: recipe.after },
  } }]);
});

test("explicit accepted-receipt recovery settles current-editor and batch observations without another write", async (t) => {
  for (const context of [CONTEXT, BATCH_CONTEXT]) {
    for (const observedTitle of ["after", "before", "external"]) {
      await t.test(`${context.batchScopeId ? "batch" : "editor"}: ${observedTitle}`, async () => {
        const verifiedCalls = [];
        const f = fixture({ readCatalogAccountKey: "catalog-recovery",
          onVerified: async (_context, value) => verifiedCalls.push(plain(value)),
          write: async (_context, payload, { current, setCurrent }) => {
            const accepted = { ...plain(current), title: payload.after };
            setCurrent(accepted);
            return { status: "accepted", accepted, httpStatus: 200 };
          } });
        const plan = context.batchScopeId ? batchRecipe(f) : (await preview(f)).plan;
        if (context.batchScopeId) await authorizeBatch(f, plan);
        const applied = context.batchScopeId
          ? await f.service.applyAuthorized(context, context.expectedIdentity, plan.id)
          : await apply(f, plan);
        assert.equal(applied.operation.status, "accepted");
        assert.equal(verifiedCalls.length, 0, "2xx acceptance is not readback verification");

        f.service = f.makeService();
        const status = await f.service.handle("status", context);
        assert.equal(status.operation.status, "accepted", "status preserves the accepted receipt until explicit reconciliation");
        const title = observedTitle === "external" ? "Changed elsewhere" : plan[observedTitle];
        f.setCurrent({ title });
        const readsBefore = f.readCalls.length;
        const result = await f.service.handle("reconcile", context);
        assert.equal(result.operation.id, plan.id);
        assert.equal(result.operation.status, observedTitle === "after" ? "verified" : "conflict");
        assert.equal(result.operation.messageCode, observedTitle === "after" ? "title_verified"
          : observedTitle === "before" ? "title_unchanged" : "title_changed_externally");
        assert.equal(result.current.title, title);
        assert.equal(result.plan, null); assert.equal(result.previewContext, null);
        assert.equal(result.accepted, undefined, "fresh readback never fabricates the original acceptance projection");
        assert.equal([...f.storage.records.values()][0].operation.status, result.operation.status);
        assert.equal(f.readCalls.length, readsBefore + 1, "recovery consumes its existing authenticated read only");
        assert.equal(verifiedCalls.length, observedTitle === "after" ? 1 : 0);
        if (observedTitle === "after") assert.deepEqual(verifiedCalls[0], {
          catalogAccountKey: "catalog-recovery", current: f.current(),
        });
        await assert.rejects(f.service.handle("apply", context, { planId: plan.id }), { code: "TITLE_PREVIEW_REQUIRED" });
        assert.equal(f.dispatchedCalls.length, 1, "recovery never revives the consumed confirmation");
      });
    }
  }
});

test("accepted recovery preserves identity isolation and waits for durable verification before projection", async () => {
  const verifiedCalls = [], f = fixture({ readCatalogAccountKey: "catalog-recovery",
    onVerified: async (_context, value) => verifiedCalls.push(plain(value)),
    write: async (_context, payload, { current, setCurrent }) => {
      const accepted = { ...plain(current), title: payload.after };
      setCurrent(accepted);
      return { status: "accepted", accepted, httpStatus: 200 };
    } });
  const recipe = batchRecipe(f); await authorizeBatch(f, recipe);
  await f.service.applyAuthorized(BATCH_CONTEXT, BATCH_CONTEXT.expectedIdentity, recipe.id);
  f.service = f.makeService();
  f.setIdentity({ accountKey: "other-account", workspaceKey: "personal" });
  await assert.rejects(f.service.handle("reconcile", BATCH_CONTEXT), { code: "CONTEXT_MISMATCH" });
  assert.equal([...f.storage.records.values()][0].operation.status, "accepted");
  assert.equal(verifiedCalls.length, 0);

  f.setIdentity(BATCH_CONTEXT.expectedIdentity);
  f.setCurrent({ conversationId: "another-conversation" });
  await assert.rejects(f.service.handle("reconcile", BATCH_CONTEXT), { code: "CONTEXT_MISMATCH" });
  assert.equal([...f.storage.records.values()][0].operation.status, "accepted");
  assert.equal(verifiedCalls.length, 0, "another conversation cannot verify the accepted receipt");
  f.setCurrent({ conversationId: CONTEXT.conversationId });
  const save = f.storage.set;
  f.storage.set = async (key, state) => {
    if (state.operation?.status === "verified") throw new Error("recovery checkpoint failure");
    return save(key, state);
  };
  await assert.rejects(f.service.handle("reconcile", BATCH_CONTEXT), /recovery checkpoint failure/);
  assert.equal([...f.storage.records.values()][0].operation.status, "accepted");
  assert.equal(verifiedCalls.length, 0, "failed verification persistence must not project success");
  f.storage.set = save;
  const recovered = await f.service.handle("reconcile", BATCH_CONTEXT);
  assert.equal(recovered.operation.status, "verified");
  assert.equal(verifiedCalls.length, 1); assert.equal(f.dispatchedCalls.length, 1);
});

test("ordinary preview and stale apply preserve accepted without impersonating explicit recovery", async () => {
  const verifiedCalls = [], f = fixture({ readCatalogAccountKey: "catalog-recovery",
    onVerified: async (...args) => verifiedCalls.push(args),
    write: async (_context, payload, { current, setCurrent }) => {
      const accepted = { ...plain(current), title: payload.after };
      setCurrent(accepted);
      return { status: "accepted", accepted, httpStatus: 200 };
    } });
  const recipe = batchRecipe(f); await authorizeBatch(f, recipe);
  await f.service.applyAuthorized(BATCH_CONTEXT, BATCH_CONTEXT.expectedIdentity, recipe.id);
  f.service = f.makeService();
  await assert.rejects(f.service.handle("apply", BATCH_CONTEXT, { planId: recipe.id }), { code: "TITLE_PREVIEW_REQUIRED" });
  assert.equal([...f.storage.records.values()][0].operation.status, "accepted");
  const editor = await preview(f);
  assert.equal(editor.operation.status, "accepted");
  assert.ok(editor.plan); assert.notEqual(editor.plan.id, recipe.id);
  const changed = await replan(f, editor.previewContext, { rules: { mode: "created" } });
  assert.equal(changed.operation.status, "accepted");
  assert.equal(verifiedCalls.length, 0); assert.equal(f.dispatchedCalls.length, 1);
});

test("batch authorization requires observation provenance and ignores a forged recipe source", async () => {
  for (const metadataSource of [undefined, null, "unknown"]) {
    const f = fixture();
    await assert.rejects(f.service.authorize(BATCH_CONTEXT, { identity: BATCH_CONTEXT.expectedIdentity,
      current: f.current(), metadataSource }, { ...batchRecipe(f), metadataSource: "catalog" }), { code: "CONTEXT_MISMATCH" });
    assert.equal(f.readCalls.length, 0); assert.equal(f.storage.writes.length, 0);
  }
  for (const metadataSource of ["detail", "catalog"]) {
    const f = fixture(), recipe = { ...batchRecipe(f), metadataSource: metadataSource === "detail" ? "catalog" : "detail" };
    const authorized = await f.service.authorize(BATCH_CONTEXT, { identity: BATCH_CONTEXT.expectedIdentity,
      current: f.current(), metadataSource }, recipe);
    assert.equal(authorized.plan.metadataSource, undefined, "provenance is private, not an editable plan field");
    assert.equal([...f.storage.records.values()][0].plan.metadataSource, metadataSource);
    assert.equal(f.readCalls.length, 0, "authorization remains local-only");
    await f.service.handle("apply", BATCH_CONTEXT, { planId: recipe.id, metadataSource: recipe.metadataSource });
    assert.equal(f.writeCalls[0].payload.metadataSource, metadataSource);
    assert.deepEqual(f.writeCalls[0].payload.catalogIntent, metadataSource === "catalog"
      ? { rules: recipe.rules, operation: recipe.operation, decision: recipe.selectedDecision } : undefined);
  }
});

test("source-less persisted drafts cannot execute after restart and do not erase recovery receipts", async () => {
  const f = fixture(), first = await preview(f), [key, state] = [...f.storage.records.entries()][0];
  delete state.plan.metadataSource; f.storage.records.set(key, state); f.service = f.makeService();
  await assert.rejects(apply(f, first.plan), { code: "TITLE_PREVIEW_REQUIRED" });
  assert.equal(f.writeCalls.length, 0);
  state.operation = { id: "pending-receipt", conversationId: CONTEXT.conversationId, status: "pending",
    before: first.plan.before, after: first.plan.after, startedAtMs: 900 };
  f.storage.records.set(key, state); f.setCurrent({ title: first.plan.after }); f.service = f.makeService();
  const result = await f.service.handle("reconcile", CONTEXT);
  assert.equal(result.operation.id, "pending-receipt"); assert.equal(result.operation.status, "verified");
  assert.equal(f.writeCalls.length, 0);
});

test("public single-title preview and apply payloads cannot opt into catalog timestamp validation", async () => {
  const f = fixture();
  const first = await preview(f, { metadataSource: "catalog", catalogIntent: { rules: {}, operation: "remove" } });
  assert.equal(first.plan.metadataSource, undefined);
  assert.equal([...f.storage.records.values()][0].plan.metadataSource, "detail");
  f.setCurrent({ updatedAt: new Date(Date.parse(INITIAL.updatedAt) + 1).toISOString() });
  const result = await f.service.handle("apply", CONTEXT, { planId: first.plan.id, metadataSource: "catalog" });
  assert.equal(result.operation.status, "conflict"); assert.equal(result.operation.messageCode, "dates_changed");
  assert.equal(f.writeCalls[0].payload.metadataSource, "detail"); assert.equal(f.dispatchedCalls.length, 0);
});

test("successful batch execution persists and projects its exact receipt without creating a current-editor draft", async () => {
  let plans = 0;
  const calls = [], f = fixture({ writeCatalogAccountKey: "catalog-batch-readback",
    model: { ...model, plan: (...args) => { plans++; return model.plan(...args); } },
    onVerified: async (context, observation) => {
      assert.equal([...f.storage.records.values()][0].operation.status, "verified");
      assert.equal([...f.storage.records.values()][0].plan, null);
      calls.push({ context: plain(context), observation: plain(observation) });
    } });
  const recipe = batchRecipe(f); await authorizeBatch(f, recipe);
  const result = await f.service.handle("apply", BATCH_CONTEXT, { planId: recipe.id });
  assert.equal(result.operation.status, "verified"); assert.equal(result.plan, null); assert.equal(result.previewContext, null);
  assert.equal(plans, 0, "the core neither prepares nor follows a batch with an unused model draft");
  assert.equal(f.storage.writes.length, 4, "authorize, prepared, dispatch permit, then verified receipt remain durable");
  assert.deepEqual(calls, [{ context: BATCH_CONTEXT, observation: { catalogAccountKey: "catalog-batch-readback", current: f.current() } }]);
  assert.equal((await authorizeBatch(f, { ...recipe, before: f.current().title })).plan, null, "the consumed exact receipt cannot be reauthorized");
  assert.equal(calls.length, 1); assert.equal(f.dispatchedCalls.length, 1);
  f.service = f.makeService();
  await assert.rejects(f.service.handle("apply", BATCH_CONTEXT, { planId: recipe.id }), { code: "TITLE_PREVIEW_REQUIRED" });
  assert.equal(f.dispatchedCalls.length, 1);
});

test("batch receipt persistence failure stays unknown until a fresh read can persist the observed result", async () => {
  const calls = [], f = fixture({ writeCatalogAccountKey: "catalog-batch-readback", readCatalogAccountKey: "catalog-recovery",
    onVerified: async (_context, value) => calls.push(plain(value)) });
  const recipe = batchRecipe(f); await authorizeBatch(f, recipe);
  const save = f.storage.set;
  f.storage.set = async (key, state) => {
    if (state.operation?.status === "verified") throw new Error("receipt disk failure");
    return save(key, state);
  };
  const result = await f.service.handle("apply", BATCH_CONTEXT, { planId: recipe.id });
  assert.equal(result.operation.status, "uncertain"); assert.equal(result.operation.messageCode, "title_result_not_saved");
  assert.equal(result.plan, null); assert.equal(result.previewContext, null); assert.equal(calls.length, 0);
  assert.equal([...f.storage.records.values()][0].operation.status, "pending");
  f.storage.set = save; f.service = f.makeService();
  assert.equal((await f.service.handle("status", BATCH_CONTEXT)).operation.status, "verified");
  assert.equal(calls.length, 1);
  const recovered = await f.service.handle("reconcile", BATCH_CONTEXT);
  assert.equal(recovered.operation.status, "verified"); assert.equal(calls.length, 2);
  assert.equal(calls[0].catalogAccountKey, "catalog-recovery"); assert.equal(f.dispatchedCalls.length, 1);
});

test("batch projection failure cannot change a durable verified receipt without an editor draft", async () => {
  const f = fixture({ writeCatalogAccountKey: "catalog-batch-readback", onVerified: async () => { throw new Error("projection unavailable"); } });
  const recipe = batchRecipe(f); await authorizeBatch(f, recipe);
  const result = await f.service.handle("apply", BATCH_CONTEXT, { planId: recipe.id });
  assert.equal(result.operation.status, "verified"); assert.equal(result.plan, null); assert.equal(result.previewContext, null);
  assert.equal([...f.storage.records.values()][0].operation.status, "verified"); assert.equal(f.dispatchedCalls.length, 1);
});

test("verified projection waits for durable receipt, receives only the exact write readback, and cannot mutate core state", async () => {
  const calls = [];
  let signal, release, finished = false;
  const entered = new Promise((resolve) => { signal = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ readCatalogAccountKey: "catalog-preview", identityCatalogAccountKey: "catalog-identity-only",
    writeCatalogAccountKey: "catalog-write-readback",
    onVerified: async (context, observation) => {
      calls.push({ context: plain(context), observation: plain(observation) });
      const persisted = [...f.storage.records.values()][0];
      assert.equal(persisted.operation.status, "verified");
      assert.equal(persisted.operation.after, observation.current.title);
      // Projection owns copies, not our immutable plan/current/owner objects.
      context.tabId = 999; observation.current.title = "Hook mutation";
      observation.catalogAccountKey = "Hook mutation";
      signal(); await gate;
    },
  });
  const first = await preview(f);
  assert.equal(calls.length, 0);
  const pending = f.service.handle("apply", CONTEXT, { planId: first.plan.id,
    catalogAccountKey: "forged-caller-key", current: { title: "forged-caller-title" } }).then((value) => { finished = true; return value; });
  await entered;
  assert.equal(finished, false, "apply awaits the bounded local projection callback");
  assert.deepEqual(calls, [{ context: CONTEXT, observation: { catalogAccountKey: "catalog-write-readback", current: f.current() } }]);
  release();
  const result = await pending;
  assert.equal(result.operation.status, "verified"); assert.equal(result.current.title, first.plan.after);
  assert.equal(result.plan.before, first.plan.after);
  assert.equal(result.catalogAccountKey, undefined);
  assert.equal(result.current.catalogAccountKey, undefined);
  assert.equal(result.plan.catalogAccountKey, undefined);
  assert.ok(!JSON.stringify([...f.storage.records]).includes("catalogAccountKey"));
  assert.ok(!JSON.stringify([...f.storage.records]).includes("DO-NOT-PERSIST"));
  assert.deepEqual(f.readOptions, [undefined, { identityOnly: true }]);
  assert.equal(f.dispatchedCalls.length, 1);
});

test("failed projection is independent of a successful receipt and can be retried by exact read-only reconciliation", async () => {
  const calls = [];
  const options = { readCatalogAccountKey: "catalog-reconcile", writeCatalogAccountKey: "catalog-write", onVerified: async (_context, value) => {
    calls.push(plain(value)); if (calls.length === 1) throw new Error("Cache unavailable");
  } };
  const f = fixture(options); const first = await preview(f);
  const saved = await apply(f, first.plan);
  assert.equal(saved.operation.status, "verified"); assert.ok(saved.previewContext);
  assert.equal([...f.storage.records.values()][0].operation.status, "verified");
  const result = await f.service.handle("reconcile", CONTEXT, { catalogAccountKey: "forged" });
  assert.equal(result.operation.status, "verified");
  assert.deepEqual(calls.map((value) => value.catalogAccountKey), ["catalog-write", "catalog-reconcile"]);
  assert.deepEqual(calls[1].current, f.current());
  assert.equal(f.dispatchedCalls.length, 1); assert.equal(f.readCalls.length, 3);
  await assert.rejects(apply(f, first.plan), { code: "TITLE_PREVIEW_REQUIRED" });
  assert.equal(f.dispatchedCalls.length, 1); assert.equal(calls.length, 2);
});

test("only reconcile of the exact confirmed title may reproject an old verified receipt", async () => {
  const calls = [];
  const f = fixture({ readCatalogAccountKey: "catalog-live", writeCatalogAccountKey: "catalog-live", onVerified: async (_context, value) => calls.push(plain(value)) });
  const first = await preview(f); await apply(f, first.plan);
  await f.service.handle("status", CONTEXT);
  assert.equal(calls.length, 1, "status does not turn a historical receipt into a new observation");
  f.setCurrent({ title: "New title changed externally", updatedAt: "2026-09-10T02:00:00.000Z" });
  const result = await f.service.handle("reconcile", CONTEXT);
  assert.equal(result.operation.status, "verified", "the historical receipt remains valid evidence of the earlier write");
  assert.equal(result.current.title, "New title changed externally");
  assert.equal(calls.length, 1, "the old receipt does not verify the unrelated current title");
  await preview(f);
  assert.equal(calls.length, 1); assert.equal(f.dispatchedCalls.length, 1);
});

test("unknown write recovery projects the new verified transition using this full read's catalog key", async () => {
  const calls = [];
  const options = { readCatalogAccountKey: "catalog-before", onVerified: async (context, value) => calls.push({ context: plain(context), value: plain(value) }),
    write: async () => ({ status: "uncertain", catalogAccountKey: "catalog-unverified" }) };
  const f = fixture(options); const first = await preview(f); await apply(f, first.plan);
  await f.service.handle("reconcile", CONTEXT);
  assert.equal(calls.length, 0, "observing unchanged title cannot prove an unknown POST succeeded");
  f.setCurrent({ title: first.plan.after, updatedAt: "2026-09-10T01:00:00.000Z" });
  options.readCatalogAccountKey = "catalog-fresh-recovery";
  f.service = f.makeService();
  const result = await f.service.handle("reconcile", CONTEXT, { catalogAccountKey: "forged" });
  assert.equal(result.operation.status, "verified");
  assert.deepEqual(calls, [{ context: CONTEXT, value: { catalogAccountKey: "catalog-fresh-recovery", current: f.current() } }]);
  assert.equal(result.catalogAccountKey, undefined); assert.equal(f.dispatchedCalls.length, 1);
});

test("nonverified and malformed write readbacks never project, even with a valid directory key", async () => {
  for (const status of ["pending", "uncertain", "conflict", "failed"]) {
    const calls = [];
    const f = fixture({ onVerified: async (...args) => calls.push(args), readCatalogAccountKey: "catalog-read",
      write: async (_context, payload, { current }) => ({ status, current: { ...current, title: payload.after }, catalogAccountKey: "catalog-write" }) });
    const first = await preview(f); await apply(f, first.plan);
    assert.equal(calls.length, 0, status);
  }
  for (const current of [undefined, { ...INITIAL, conversationId: "other", title: "[2026-09-01 ~ 09-07] Original title" }, INITIAL]) {
    const calls = [];
    const f = fixture({ onVerified: async (...args) => calls.push(args),
      write: async () => ({ status: "verified", current, catalogAccountKey: "catalog-write" }) });
    const first = await preview(f); const result = await apply(f, first.plan);
    assert.equal(result.operation.status, "uncertain"); assert.equal(calls.length, 0);
  }
});

test("projection requires an exact nonempty adapter directory key and never infers it from another channel", async () => {
  for (const key of [undefined, null, "", "   ", " catalog ", 12, { accountKey: "catalog" }]) {
    const calls = [];
    const f = fixture({ readCatalogAccountKey: "preview-key-not-authority", identityCatalogAccountKey: "identity-only-not-authority",
      writeCatalogAccountKey: key, onVerified: async (...args) => calls.push(args) });
    const first = await preview(f); const result = await apply(f, first.plan);
    assert.equal(result.operation.status, "verified"); assert.equal(calls.length, 0);
    assert.equal(f.dispatchedCalls.length, 1);
  }
  const calls = [], options = { writeCatalogAccountKey: "write-only", onVerified: async (...args) => calls.push(args) };
  const f = fixture(options); const first = await preview(f); await apply(f, first.plan);
  await f.service.handle("reconcile", CONTEXT);
  assert.equal(calls.length, 1, "reconcile cannot reuse the old write's directory key when this read omits it");
});

test("failed verified receipt persistence suppresses projection until durable read-only recovery succeeds", async () => {
  const storage = memoryStorage(), set = storage.set, calls = [];
  let rejectVerified = true;
  storage.set = async (key, value) => {
    if (rejectVerified && value.operation?.status === "verified") throw new Error("Receipt storage unavailable");
    return set(key, value);
  };
  const f = fixture({ storage, readCatalogAccountKey: "catalog-recovery", writeCatalogAccountKey: "catalog-write",
    onVerified: async (_context, value) => calls.push(plain(value)) });
  const first = await preview(f); const saved = await apply(f, first.plan);
  assert.equal(saved.operation.status, "uncertain"); assert.equal(calls.length, 0);
  f.service = f.makeService();
  await assert.rejects(f.service.handle("reconcile", CONTEXT), /Receipt storage unavailable/);
  assert.equal(calls.length, 0); assert.equal(f.dispatchedCalls.length, 1);
  rejectVerified = false;
  const recovered = await f.service.handle("reconcile", CONTEXT);
  assert.equal(recovered.operation.status, "verified"); assert.equal(calls.length, 1);
  assert.equal(calls[0].catalogAccountKey, "catalog-recovery"); assert.equal(f.dispatchedCalls.length, 1);
});

test("nonverified reconciliation and read-only editing never call the projection hook", async () => {
  const calls = [];
  const f = fixture({ readCatalogAccountKey: "catalog-read", writeCatalogAccountKey: "catalog-write",
    onVerified: async (...args) => calls.push(args), write: async () => ({ status: "uncertain", catalogAccountKey: "catalog-write" }) });
  const first = await preview(f);
  const changed = await replan(f, first.previewContext, { catalogAccountKey: "forged" });
  await f.service.handle("status", CONTEXT); assert.equal(calls.length, 0);
  await apply(f, changed.plan);
  await f.service.handle("reconcile", CONTEXT); assert.equal(calls.length, 0);
  f.setCurrent({ title: "Third title" });
  const conflict = await f.service.handle("reconcile", CONTEXT);
  assert.equal(conflict.operation.status, "conflict"); assert.equal(calls.length, 0);
  await f.service.handle("reconcile", CONTEXT);
  assert.equal(calls.length, 0); assert.equal(f.dispatchedCalls.length, 1);
});

test("batch execution uses the same durable projection hook with its exact owner and target context", async () => {
  const calls = [];
  const f = fixture({ writeCatalogAccountKey: "catalog-batch-readback", onVerified: async (context, value) => calls.push({ context: plain(context), value: plain(value) }) });
  const context = { ...CONTEXT, ownerContext: { conversationId: "owner", pathname: "/g/g-p-owner/c/owner", projectId: "g-p-owner" },
    targetProjectId: null, batchScopeId: "batch-one", expectedIdentity: { accountKey: "account-a", workspaceKey: "personal" } };
  const first = await f.service.handle("preview", context);
  const result = await f.service.handle("apply", context, { planId: first.plan.id });
  assert.equal(result.operation.status, "verified");
  assert.deepEqual(calls, [{ context, value: { catalogAccountKey: "catalog-batch-readback", current: f.current() } }]);
  assert.equal(f.readCalls.length, 2); assert.equal(f.dispatchedCalls.length, 1);
});

test("repeated title choices replan one authenticated observation without session or metadata reads", async () => {
  const dateModel = require(path.join(ROOT, "src/features/titles/model/title-dates.js"));
  const f = fixture({ model: dateModel });
  f.setCurrent({ title: "2026-09-01｜Original title" });
  const first = await preview(f);
  assert.deepEqual(plain(first.previewContext), { id: first.previewContext.id, expiresAt: 1000 + TITLE_PLAN_TTL_MS });
  let previousPlan = first.plan;
  const planIds = new Set([first.plan.id]);
  for (const decision of ["skip", "replace", "stack"]) {
    for (const mode of ["created", "range"]) {
      for (const dateFormat of ["iso", "slash", "dot"]) {
        const result = await replan(f, first.previewContext, { decision, rules: { mode, dateFormat, timeZone: "UTC" } });
        const expected = dateModel.plan(result.current,
          dateModel.normalizeRules({ mode, dateFormat, timeZone: "UTC" }), { decision });
        assert.equal(result.plan.after, expected.after);
        assert.equal(result.plan.selectedDecision, expected.selectedDecision);
        assert.deepEqual(plain(result.previewContext), plain(first.previewContext));
        assert.equal(result.plan.previewContextId, undefined);
        assert.equal(result.plan.identity, undefined);
        assert.equal(result.plan.createdAtMs, undefined);
        assert.notEqual(result.plan.id, previousPlan.id);
        planIds.add(result.plan.id);
        previousPlan = result.plan;
      }
    }
  }
  assert.equal(planIds.size, 19);
  assert.equal(f.readCalls.length, 1, "selection changes must never fetch session or conversation metadata");
  assert.equal(f.writeCalls.length, 0);
  assert.equal(f.storage.records.size, 1, "only the latest immutable plan is durable");
  assert.ok(!JSON.stringify([...f.storage.records.values()]).includes("DO-NOT-PERSIST"));
});

test("replan trusts only frozen metadata and identity, never forged caller fields", async () => {
  const f = fixture();
  const first = await preview(f);
  first.current.title = "mutated response";
  first.plan.before = "mutated plan";
  const next = await replan(f, first.previewContext, {
    before: "injected before", after: "injected after", current: { ...INITIAL, title: "injected metadata" },
    identity: { accountKey: "attacker", workspaceKey: "attacker" }, capturedAtMs: Number.MAX_SAFE_INTEGER,
    previewContext: { ...first.previewContext, expiresAt: Number.MAX_SAFE_INTEGER },
    rules: { timeZone: "UTC" },
  });
  assert.equal(next.current.title, INITIAL.title);
  assert.equal(next.plan.before, INITIAL.title);
  assert.equal(next.plan.after, "[2026-09-01 ~ 09-07] Original title");
  assert.deepEqual(plain(next.previewContext), plain(first.previewContext));
  const persisted = [...f.storage.records.values()][0];
  assert.deepEqual(persisted.plan.identity, { accountKey: "account-a", workspaceKey: "personal" });
  assert.equal(persisted.plan.createdAtMs, 1000);
  assert.equal(f.readCalls.length, 1);
});

test("replanning cannot extend the original metadata and plan lifetime", async () => {
  const f = fixture();
  const first = await preview(f);
  f.setClock(1000 + TITLE_PLAN_TTL_MS - 1);
  const next = await replan(f, first.previewContext);
  assert.equal(next.previewContext.expiresAt, first.previewContext.expiresAt);
  assert.equal([...f.storage.records.values()][0].plan.createdAtMs, 1000);
  f.setClock(1001 + TITLE_PLAN_TTL_MS);
  await assert.rejects(replan(f, first.previewContext), { code: "TITLE_PLAN_EXPIRED" });
  assert.equal(f.readCalls.length, 1);
  await assert.rejects(apply(f, next.plan), { code: "TITLE_PREVIEW_REQUIRED" });
  assert.equal(f.writeCalls.length, 0);
});

test("verified apply resumes editing from its readback without another authenticated read", async () => {
  const dateModel = require(path.join(ROOT, "src/features/titles/model/title-dates.js"));
  const f = fixture({ model: dateModel });
  const first = await preview(f, { rules: { mode: "range", dateFormat: "slash", timeZone: "UTC", locale: "zh-CN" } });
  const beforeStorage = f.storage.writes.length;
  f.setClock(4000);
  const saved = await apply(f, first.plan);

  assert.equal(saved.operation.status, "verified");
  assert.equal(saved.operation.id, first.plan.id, "the receipt must still refer to the submitted plan");
  assert.notEqual(saved.plan.id, first.plan.id, "the continuation is a distinct, unsubmitted plan");
  assert.notEqual(saved.previewContext.id, first.previewContext.id);
  assert.equal(saved.previewContext.expiresAt, 4000 + TITLE_PLAN_TTL_MS);
  assert.deepEqual(plain(saved.current), f.current());
  assert.equal(saved.plan.before, saved.current.title);
  assert.equal(saved.plan.operation, "assign");
  assert.equal(saved.plan.selectedDecision, "skip");
  assert.deepEqual(plain(saved.plan.rules), plain(first.plan.rules));
  assert.equal(saved.operation.rules, undefined, "private recovery settings stay out of public receipts");
  assert.equal(saved.plan.previewContextId, undefined);
  assert.equal(f.storage.writes.length, beforeStorage + 3, "prepared, dispatch permit and readback are local durable writes, not extra HTTP");
  assert.deepEqual(f.readOptions, [undefined, { identityOnly: true }]);
  assert.equal(f.dispatchedCalls.length, 1);

  await assert.rejects(replan(f, first.previewContext), { code: "TITLE_PREVIEW_REQUIRED" });
  const next = await replan(f, saved.previewContext, {
    decision: "replace", rules: { ...first.plan.rules, mode: "created", dateFormat: "dot" },
  });
  assert.equal(next.plan.before, saved.current.title);
  assert.equal(next.current.updatedAt, "2026-09-08T03:00:00.000Z");
  assert.equal([...f.storage.records.values()][0].plan.expectedUpdatedAt, next.current.updatedAt);
  assert.equal(f.readCalls.length, 2, "post-save choices must not read ChatGPT again");
  assert.equal(f.writeCalls.length, 1);
});

test("readback editing contexts retain ownership, expiry, and strict next-apply preconditions", async () => {
  const f = fixture();
  const first = await preview(f);
  const saved = await apply(f, first.plan);
  await assert.rejects(f.service.handle("replan", { ...CONTEXT, tabId: 32 }, {
    previewContextId: saved.previewContext.id,
  }), { code: "CONTEXT_MISMATCH" });
  const next = await replan(f, saved.previewContext, { rules: { timeZone: "UTC" } });
  f.setCurrent({ updatedAt: "2026-09-09T05:00:00.000Z" });
  const conflict = await apply(f, next.plan);
  assert.equal(conflict.operation.status, "conflict");
  assert.equal(conflict.previewContext, null);
  assert.equal(f.dispatchedCalls.length, 1, "a changed readback timestamp still fails before a second POST");
  assert.equal(f.writeCalls.at(-1).payload.expectedUpdatedAt, saved.current.updatedAt);
  assert.equal(f.writeCalls.at(-1).payload.expectedTimeZone, "UTC");

  const fresh = await preview(f);
  const savedAgain = await apply(f, fresh.plan);
  f.setClock(savedAgain.previewContext.expiresAt + 1);
  const reads = f.readCalls.length;
  await assert.rejects(replan(f, savedAgain.previewContext), { code: "TITLE_PLAN_EXPIRED" });
  assert.equal(f.readCalls.length, reads, "expired continuation contexts do not silently refresh remotely");
});

test("only an exact verified readback can create a post-save editing context", async () => {
  for (const outcome of [
    () => ({ status: "verified" }),
    (payload, current) => ({ status: "verified", current: { ...current, title: payload.after, conversationId: "different" } }),
    (_payload, current) => ({ status: "verified", current }),
    (payload, current) => ({ status: "uncertain", current: { ...current, title: payload.after } }),
    (payload, current) => ({ status: "failed", current: { ...current, title: payload.after } }),
    (payload, current) => ({ status: "conflict", current: { ...current, title: payload.after } }),
  ]) {
    const f = fixture({ write: async (_context, payload, { current }) => outcome(payload, current) });
    const first = await preview(f);
    const result = await apply(f, first.plan);
    assert.equal(result.previewContext, null);
    assert.equal(result.plan, null);
    await assert.rejects(replan(f, first.previewContext), { code: "TITLE_PREVIEW_REQUIRED" });
    assert.equal(f.readCalls.length, 2);
    assert.equal(f.dispatchedCalls.length, 1);
  }
});

test("retired undo actions are rejected locally without invalidating the current editing context", async () => {
  const f = fixture();
  const first = await preview(f, { rules: { dateFormat: "dot", timeZone: "UTC" } });
  await assert.rejects(f.service.handle("undo-preview", CONTEXT), { code: "INVALID_REQUEST" });
  const changed = await replan(f, first.previewContext, { rules: first.plan.rules });
  assert.equal(changed.plan.kind, "apply");
  assert.equal(f.readCalls.length, 1);
  assert.equal(f.writeCalls.length, 0);
});

test("verified removal resumes the same date settings from its readback without extra reads", async () => {
  const dateModel = require(path.join(ROOT, "src/features/titles/model/title-dates.js"));
  const f = fixture({ model: dateModel });
  const first = await preview(f, { rules: { mode: "range", dateFormat: "dot", timeZone: "UTC", locale: "zh-CN" } });
  const saved = await apply(f, first.plan);
  const removal = await replan(f, saved.previewContext, { operation: "remove", rules: first.plan.rules });
  f.setClock(6000);
  const beforeReads = f.readCalls.length;
  const restored = await apply(f, removal.plan);
  assert.equal(restored.operation.id, removal.plan.id);
  assert.equal(restored.operation.status, "verified");
  assert.equal(restored.canUndo, undefined);
  assert.equal(restored.plan.before, INITIAL.title);
  assert.deepEqual(plain(restored.plan.rules), plain(first.plan.rules));
  assert.equal(restored.previewContext.expiresAt, 6000 + TITLE_PLAN_TTL_MS);
  assert.equal(f.readCalls.length, beforeReads + 1, "remove apply adds only its existing identity-only read");
  await assert.rejects(replan(f, removal.previewContext), { code: "TITLE_PREVIEW_REQUIRED" });
  const edited = await replan(f, restored.previewContext, { rules: { ...first.plan.rules, mode: "created" } });
  assert.equal(edited.plan.before, restored.current.title);
  assert.equal(f.readCalls.length, beforeReads + 1);
  assert.equal(f.writeCalls.length, 2);
  assert.equal(f.writeCalls[1].payload.expectedCreatedAt, saved.current.createdAt);
  assert.equal(f.writeCalls[1].payload.expectedUpdatedAt, saved.current.updatedAt);
  assert.equal(f.writeCalls[1].payload.expectedTimeZone, "UTC", "removal keeps the full date and timezone preconditions");
});

test("clock rollback, missing contexts and worker restart fail locally without authenticated fallback", async () => {
  const f = fixture();
  const first = await preview(f);
  f.setClock(999);
  await assert.rejects(replan(f, first.previewContext), { code: "TITLE_PLAN_EXPIRED" });
  await assert.rejects(f.service.handle("replan", CONTEXT), { code: "TITLE_PREVIEW_REQUIRED" });
  await assert.rejects(replan(f, { id: "unknown-context" }), { code: "TITLE_PREVIEW_REQUIRED" });
  f.setClock(1000);
  const second = await preview(f);
  f.service = f.makeService();
  await assert.rejects(replan(f, second.previewContext), { code: "TITLE_PREVIEW_REQUIRED" });
  assert.equal(f.readCalls.length, 2);
  assert.equal(f.writeCalls.length, 0);
});

test("a frozen preview belongs to one exact tab and conversation", async () => {
  const f = fixture();
  const first = await preview(f);
  for (const other of [{ ...CONTEXT, tabId: 32 }, { ...CONTEXT, conversationId: "conversation-b" }]) {
    await assert.rejects(f.service.handle("replan", other, { previewContextId: first.previewContext.id }), { code: "CONTEXT_MISMATCH" });
  }
  assert.ok((await replan(f, first.previewContext)).plan.id, "a mismatched caller cannot consume the rightful context");
  assert.equal(f.readCalls.length, 1);
});

test("new authenticated previews supersede old contexts across the same conversation or owner tab", async () => {
  const f = fixture();
  const first = await preview(f);
  const second = await f.service.handle("preview", { ...CONTEXT, tabId: 32 });
  await assert.rejects(replan(f, first.previewContext), { code: "TITLE_PREVIEW_REQUIRED" });
  f.setCurrent({ conversationId: "conversation-b" });
  await f.service.handle("preview", { tabId: 32, conversationId: "conversation-b" });
  await assert.rejects(f.service.handle("replan", { ...CONTEXT, tabId: 32 }, { previewContextId: second.previewContext.id }), { code: "TITLE_PREVIEW_REQUIRED" });
  assert.equal(f.readCalls.length, 3);
});

test("the bounded editing-context registry evicts oldest sessions without a network fallback", async () => {
  const f = fixture();
  const sessions = [];
  for (let index = 0; index < 17; index++) {
    const context = { tabId: index, conversationId: `conversation-${index}` };
    f.setCurrent({ conversationId: context.conversationId });
    sessions.push({ context, result: await f.service.handle("preview", context) });
  }
  await assert.rejects(f.service.handle("replan", sessions[0].context, { previewContextId: sessions[0].result.previewContext.id }), { code: "TITLE_PREVIEW_REQUIRED" });
  const latest = sessions.at(-1);
  assert.ok((await f.service.handle("replan", latest.context, { previewContextId: latest.result.previewContext.id })).plan);
  assert.equal(f.readCalls.length, 17);
});

test("each offline replan supersedes the old plan and only the latest confirmation can dispatch", async () => {
  const f = fixture();
  const first = await preview(f);
  const next = await replan(f, first.previewContext, { rules: { timeZone: "UTC" } });
  await assert.rejects(apply(f, first.plan), { code: "TITLE_PREVIEW_REQUIRED" });
  const attempts = await Promise.allSettled([apply(f, next.plan), apply(f, next.plan)]);
  assert.equal(attempts[0].status, "fulfilled");
  assert.equal(attempts[0].value.operation.status, "verified");
  assert.equal(attempts[1].status, "rejected");
  assert.equal(f.dispatchedCalls.length, 1);
  assert.equal(f.writeCalls[0].payload.expectedCreatedAt, INITIAL.createdAt);
  assert.equal(f.writeCalls[0].payload.expectedUpdatedAt, INITIAL.updatedAt);
  assert.equal(f.writeCalls[0].payload.expectedTimeZone, "UTC");
  await assert.rejects(replan(f, first.previewContext), { code: "TITLE_PREVIEW_REQUIRED" });
});

test("offline replanning does not relax final metadata or identity validation", async () => {
  for (const patch of [{ title: "Mobile edit" }, { createdAt: "2026-08-01T01:00:00.000Z" }, { updatedAt: "2026-09-09T01:00:00.000Z" }]) {
    const f = fixture();
    const first = await preview(f);
    f.setCurrent(patch);
    const next = await replan(f, first.previewContext);
    assert.deepEqual(plain(next.current), INITIAL, "choice changes keep the exact first observation");
    assert.equal(f.readCalls.length, 1);
    const result = await apply(f, next.plan);
    assert.equal(result.operation.status, "conflict");
    assert.equal(f.writeCalls.length, 1, "the authoritative writer still owns final metadata preflight");
    assert.equal(f.dispatchedCalls.length, 0);
  }
  for (const identity of [{ accountKey: "other-account", workspaceKey: "personal" }, { accountKey: "account-a", workspaceKey: "other-workspace" }]) {
    const f = fixture();
    const first = await preview(f);
    f.setIdentity(identity);
    const next = await replan(f, first.previewContext);
    assert.equal(f.readCalls.length, 1);
    await assert.rejects(apply(f, next.plan), { code: "TITLE_PREVIEW_REQUIRED" });
    assert.equal(f.writeCalls.length, 0);
    assert.equal(f.dispatchedCalls.length, 0);
  }
});

test("apply, status and recovery invalidate frozen contexts without allowing them to be revived", async () => {
  for (const action of ["status", "reconcile"]) {
    const f = fixture();
    const first = await preview(f);
    const result = await f.service.handle(action, CONTEXT);
    assert.equal(result.previewContext, null);
    await assert.rejects(replan(f, first.previewContext), { code: "TITLE_PREVIEW_REQUIRED" });
    assert.equal(f.readCalls.length, 2);
  }
  const f = fixture({ write: async () => ({ status: "uncertain" }) });
  const first = await preview(f);
  await apply(f, first.plan);
  await assert.rejects(replan(f, first.previewContext), { code: "TITLE_PREVIEW_REQUIRED" });
  const after = await preview(f);
  assert.notEqual(after.plan.id, first.plan.id);
  assert.notEqual(after.previewContext.id, first.previewContext.id);
  await assert.rejects(apply(f, first.plan), { code: "TITLE_PREVIEW_REQUIRED" });
  assert.equal(f.dispatchedCalls.length, 1);
});

test("offline replans retain the durable pending checkpoint and verified readback requirements", async () => {
  const storage = memoryStorage();
  const save = storage.set;
  storage.set = async (key, value) => {
    if (value.operation?.status === "pending") throw new Error("disk unavailable");
    return save(key, value);
  };
  const f = fixture({ storage });
  const first = await preview(f);
  const next = await replan(f, first.previewContext);
  await assert.rejects(apply(f, next.plan), { code: "TITLE_NOT_DISPATCHED" });
  assert.equal(f.writeCalls.length, 0);
  await assert.rejects(replan(f, first.previewContext), { code: "TITLE_PREVIEW_REQUIRED" });

  const readback = fixture({ write: async () => ({ status: "verified" }) });
  const initial = await preview(readback);
  const changed = await replan(readback, initial.previewContext);
  const result = await apply(readback, changed.plan);
  assert.equal(result.operation.status, "uncertain");
  assert.equal(result.canUndo, undefined);
  assert.equal(readback.dispatchedCalls.length, 1);
});

test("preview is read-only, projects credentials out, and persists its immutable target", async () => {
  const f = fixture();
  const result = await preview(f);
  assert.equal(result.plan.before, INITIAL.title);
  assert.equal(result.plan.after, "[2026-09-01 ~ 09-07] Original title");
  assert.equal(result.canUndo, undefined);
  assert.equal(f.writeCalls.length, 0);
  assert.equal(result.plan.identity, undefined);
  assert.equal(result.current.messages, undefined);
  assert.ok(!JSON.stringify([...f.storage.records.values()]).includes("DO-NOT-PERSIST"));
  result.plan.after = "caller mutated response";
  const status = await f.service.handle("status", CONTEXT);
  assert.equal(status.plan.after, "[2026-09-01 ~ 09-07] Original title");
});

test("apply persists pending before one write and ignores caller-supplied title replacements", async () => {
  const f = fixture({ write: async (context, payload, { current, storage }) => {
    const persisted = [...storage.records.values()][0];
    assert.equal(persisted.operation.status, "pending");
    assert.equal(persisted.plan, null);
    return { status: "verified", current: { ...current, title: payload.after } };
  } });
  const { plan } = await preview(f);
  const result = await f.service.handle("apply", CONTEXT, { planId: plan.id, after: "unconfirmed injected title", before: "anything" });
  assert.equal(result.operation.status, "verified");
  assert.equal(result.canUndo, undefined);
  assert.equal(f.writeCalls.length, 1);
  assert.equal(f.writeCalls[0].payload.after, plan.after);
  assert.equal(f.writeCalls[0].payload.expectedCreatedAt, INITIAL.createdAt);
  assert.equal(f.writeCalls[0].payload.expectedUpdatedAt, INITIAL.updatedAt);
  assert.equal(f.writeCalls[0].payload.expectedTimeZone, "Asia/Singapore");
  assert.deepEqual(f.readOptions, [undefined, { identityOnly: true }]);
});

test("the returned verified status requires actual title readback", async () => {
  const f = fixture({ write: async () => ({ status: "verified" }) });
  const { plan } = await preview(f);
  const result = await apply(f, plan);
  assert.equal(result.operation.status, "uncertain");
  assert.equal(result.canUndo, undefined);
  assert.equal(result.current, null, "a missing readback does not substitute a preview as current metadata");
});

test("verified requires an exact conversation and target-title readback", async () => {
  for (const readback of [
    (payload, current) => ({ ...current, conversationId: "different-conversation", title: payload.after }),
    (_payload, current) => ({ ...current, title: "Not the confirmed title" }),
  ]) {
    const f = fixture({ write: async (_context, payload, { current }) => ({ status: "verified", current: readback(payload, current) }) });
    const { plan } = await preview(f);
    const result = await apply(f, plan);
    assert.equal(result.operation.status, "uncertain");
    assert.equal(result.canUndo, undefined);
  }
});

test("dispatch timezone comes from the stored normalized preview, not apply payload", async () => {
  const f = fixture();
  const { plan } = await preview(f, { rules: { timeZone: "UTC" } });
  await f.service.handle("apply", CONTEXT, {
    planId: plan.id, expectedTimeZone: "Asia/Tokyo", rules: { timeZone: "Asia/Tokyo" },
  });
  assert.equal(f.writeCalls[0].payload.expectedTimeZone, "UTC");
});

test("title changed since preview conflicts in the writer preflight without dispatch", async () => {
  const f = fixture();
  const { plan } = await preview(f);
  f.setCurrent({ title: "Mobile edit" });
  const result = await apply(f, plan);
  assert.equal(result.operation.status, "conflict");
  assert.equal(result.operation.messageCode, "title_conflict");
  assert.equal(result.plan, null);
  assert.equal(result.current.title, "Mobile edit");
  assert.equal(f.writeCalls.length, 1);
  assert.equal(f.dispatchedCalls.length, 0);
});

test("changed update_time invalidates the frozen preview without silently regenerating dates", async () => {
  const f = fixture();
  const { plan } = await preview(f);
  f.setCurrent({ updatedAt: "2026-09-08T03:00:00.000Z" });
  const result = await apply(f, plan);
  assert.equal(result.operation.messageCode, "dates_changed");
  assert.equal(f.writeCalls.length, 1);
  assert.equal(f.dispatchedCalls.length, 0);
});

test("expired plans require a new preview", async () => {
  const f = fixture();
  const { plan } = await preview(f);
  f.setClock(1001 + TITLE_PLAN_TTL_MS);
  await assert.rejects(apply(f, plan), { code: "TITLE_PREVIEW_REQUIRED" });
  assert.equal(f.writeCalls.length, 0);
});

test("a fresh preview and local replan preserve the old terminal receipt for durable recovery", async () => {
  const f = fixture();
  const first = await preview(f);
  f.setCurrent({ updatedAt: "2026-09-08T03:00:00.000Z" });
  const conflict = await apply(f, first.plan);
  assert.equal(conflict.operation.messageCode, "dates_changed");
  const next = await preview(f);
  assert.notEqual(next.plan.id, conflict.operation.id);
  assert.equal(next.operation.id, conflict.operation.id, "the API distinguishes the last receipt from the new plan");
  const reads = f.readCalls.length;
  const replanned = await f.service.handle("replan", CONTEXT, { previewContextId: next.previewContext.id,
    rules: { dateFormat: "dot" }, operation: "assign", decision: "skip" });
  assert.equal(replanned.operation.id, conflict.operation.id);
  assert.equal(f.storage.writes.at(-1).operation.id, conflict.operation.id, "UI cleanup must not delete durable receipts");
  assert.equal(f.readCalls.length, reads);
  assert.equal(f.dispatchedCalls.length, 0);
});

test("plan ownership is exact even when another tab shows the same conversation", async () => {
  const f = fixture();
  const { plan } = await preview(f);
  const other = { ...CONTEXT, tabId: 32 };
  assert.equal((await f.service.handle("status", other)).plan, null);
  await assert.rejects(f.service.handle("apply", other, { planId: plan.id }), { code: "CONTEXT_MISMATCH" });
  assert.equal(f.writeCalls.length, 0);
});

test("account/workspace changes cannot consume an earlier identity's preview", async () => {
  const f = fixture();
  const { plan } = await preview(f);
  f.setIdentity({ accountKey: "account-a", workspaceKey: "workspace-b" });
  const status = await f.service.handle("status", CONTEXT);
  assert.equal(status.plan, null);
  assert.equal(status.operation, null);
  await assert.rejects(apply(f, plan), { code: "TITLE_PREVIEW_REQUIRED" });
  assert.equal(f.writeCalls.length, 0);
});

test("concurrent confirmations consume a plan only once", async () => {
  const f = fixture();
  const { plan } = await preview(f);
  const results = await Promise.allSettled([apply(f, plan), apply(f, plan)]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(f.writeCalls.length, 1);
});

test("queued actions snapshot the caller's context and payload immediately", async () => {
  const f = fixture();
  const context = { ...CONTEXT };
  const payload = { rules: { dateFormat: "slash" } };
  const promise = f.service.handle("preview", context, payload);
  context.tabId = 999;
  payload.rules.dateFormat = "dot";
  const result = await promise;
  assert.equal(f.readCalls[0].tabId, CONTEXT.tabId);
  assert.equal(result.plan.rules.dateFormat, "slash");
});

test("a throwing write is uncertain and no later preview/apply automatically retries", async () => {
  const f = fixture({ write: async () => { throw new Error("secret bearer value in bridge error"); } });
  const { plan } = await preview(f);
  const result = await apply(f, plan);
  assert.equal(result.operation.status, "uncertain");
  assert.equal(result.operation.messageCode, "title_outcome_unknown");
  assert.equal(result.canUndo, undefined);
  const fresh = await preview(f);
  assert.equal(fresh.plan.before, f.current().title);
  assert.notEqual(fresh.plan.id, plan.id);
  await assert.rejects(apply(f, plan), { code: "TITLE_PREVIEW_REQUIRED" });
  assert.equal(f.writeCalls.length, 1);
  assert.ok(!JSON.stringify([...f.storage.records.values()]).includes("secret"));
});

test("unresolved apply reads genuine current metadata for display without dispatching again", async () => {
  const f = fixture({ write: async () => ({ status: "uncertain" }) });
  const { plan } = await preview(f);
  await apply(f, plan);
  f.setCurrent({ title: "A later observed title" });
  const beforeReads = f.readOptions.length;
  const result = await apply(f, plan);
  assert.equal(result.operation.status, "uncertain");
  assert.equal(result.current.title, "A later observed title");
  assert.deepEqual(f.readOptions.slice(beforeReads), [{ identityOnly: true }, undefined]);
  assert.equal(f.writeCalls.length, 1);
});

test("unchanged title reconciliation unlocks a fresh review but never replays the old confirmation", async () => {
  const f = fixture({ write: async () => ({ status: "uncertain" }) });
  const { plan } = await preview(f);
  await apply(f, plan);
  const result = await f.service.handle("reconcile", CONTEXT);
  assert.equal(result.operation.status, "conflict");
  assert.equal(result.operation.messageCode, "title_unchanged");
  assert.equal(result.plan, null);
  await assert.rejects(apply(f, plan), { code: "TITLE_PREVIEW_REQUIRED" });
  const fresh = await preview(f);
  assert.equal(fresh.plan.before, INITIAL.title);
  assert.notEqual(fresh.plan.id, plan.id);
  assert.equal(f.writeCalls.length, 1);
});

test("read-only reconciliation confirms a later committed title without creating history", async () => {
  const f = fixture({ write: async () => ({ status: "uncertain" }) });
  const { plan } = await preview(f);
  await apply(f, plan);
  f.setCurrent({ title: plan.after });
  const result = await f.service.handle("reconcile", CONTEXT);
  assert.equal(result.operation.status, "verified");
  assert.equal(result.canUndo, undefined);
  assert.equal(f.writeCalls.length, 1);
});

test("a late old commit after recovery invalidates the fresh confirmation at final preflight", async () => {
  const f = fixture({ write: async () => ({ status: "uncertain" }) });
  const first = await preview(f); await apply(f, first.plan);
  const recovered = await f.service.handle("reconcile", CONTEXT);
  assert.equal(recovered.operation.messageCode, "title_unchanged");
  const fresh = await preview(f);
  assert.notEqual(fresh.plan.id, first.plan.id);
  assert.equal(f.dispatchedCalls.length, 1, "recovery and preview do not POST");
  // A successful read is not proof that the server cancelled the old request.
  // If it commits before the next final preflight, the new plan must not write.
  f.setCurrent({ title: first.plan.after });
  const blocked = await apply(f, fresh.plan);
  assert.equal(blocked.operation.status, "conflict");
  assert.equal(blocked.operation.messageCode, "title_conflict");
  assert.equal(blocked.current.title, first.plan.after);
  assert.equal(f.dispatchedCalls.length, 1);
  await assert.rejects(apply(f, first.plan), { code: "TITLE_PREVIEW_REQUIRED" });
});

test("the normal preview, local edits and save keep their exact read and dispatch budget", async () => {
  const f = fixture(); let state = await preview(f);
  assert.deepEqual(f.readOptions, [undefined]);
  for (let i = 0; i < 100; i++) state = await replan(f, state.previewContext, { rules: { dateFormat: i % 2 ? "dot" : "iso" } });
  assert.deepEqual(f.readOptions, [undefined], "ordinary option changes stay entirely local");
  const saved = await apply(f, state.plan);
  assert.equal(saved.operation.status, "verified");
  assert.deepEqual(f.readOptions, [undefined, { identityOnly: true }]);
  assert.equal(f.writeCalls.length, 1); assert.equal(f.dispatchedCalls.length, 1);
  assert.equal(saved.plan.before, saved.current.title, "next preview reuses the writer's readback");
});

test("reconciliation of a third title reports an external conflict", async () => {
  const f = fixture({ write: async () => ({ status: "uncertain" }) });
  const { plan } = await preview(f);
  await apply(f, plan);
  f.setCurrent({ title: "A different edit" });
  const result = await f.service.handle("reconcile", CONTEXT);
  assert.equal(result.operation.status, "conflict");
  assert.equal(result.operation.messageCode, "title_changed_externally");
  assert.equal(f.writeCalls.length, 1);
});

test("a restarted worker resolves a pending receipt against its existing fresh read without replay", async () => {
  const f = fixture();
  const { plan } = await preview(f);
  const [key, persisted] = [...f.storage.records.entries()][0];
  persisted.plan = null;
  persisted.operation = { id: plan.id, conversationId: CONTEXT.conversationId, before: plan.before, after: plan.after, kind: "apply", status: "pending" };
  await f.storage.set(key, persisted);
  f.service = f.makeService();
  const result = await f.service.handle("status", CONTEXT);
  assert.equal(result.operation.status, "conflict");
  assert.equal(result.operation.messageCode, "title_unchanged");
  assert.equal(f.storage.records.get(key).operation.status, "conflict");
  assert.equal(f.writeCalls.length, 0);
});

for (const dispatchPhase of ["prepared", "dispatched", undefined, "invalid"]) {
  test(`interrupted ${dispatchPhase || 'missing'} dispatch evidence requires the correct recovery path`, async () => {
    const f = fixture(), first = await preview(f);
    const [key, stored] = [...f.storage.records.entries()][0];
    stored.plan = null;
    stored.operation = { id: first.plan.id, conversationId: CONTEXT.conversationId, before: first.plan.before,
      after: first.plan.after, status: "pending", dispatchPhase };
    await f.storage.set(key, stored); f.service = f.makeService();
    const status = await f.service.handle("status", CONTEXT);
    assert.equal(status.operation.status, dispatchPhase === "prepared" ? "failed" : "conflict");
    assert.equal(status.plan, null); assert.equal(status.operation.dispatchPhase, undefined, 'internal dispatch phases stay out of UI payloads');
    for (let i = 0; i < 2; i++) {
      const checked = await f.service.handle("reconcile", CONTEXT);
      assert.equal(checked.operation.status, dispatchPhase === "prepared" ? "failed" : "conflict");
    }
    assert.equal(f.writeCalls.length, 0, 'checking never resends');
    const next = await preview(f, { dispatchPhase: "prepared", status: "failed" });
    assert.notEqual(next.plan.id, first.plan.id);
    assert.equal(status.operation.messageCode, dispatchPhase === "prepared" ? "title_not_dispatched" : "title_unchanged");
    await assert.rejects(apply(f, first.plan), { code: "TITLE_PREVIEW_REQUIRED" });
    assert.equal(f.dispatchedCalls.length, 0, 'recovery does not consume the old confirmation');
    await apply(f, next.plan); assert.equal(f.dispatchedCalls.length, 1);
  });
}

test("dispatch checkpoint failure never calls the page and allows only a fresh preview", async () => {
  const f = fixture(), first = await preview(f), save = f.storage.set;
  f.storage.set = async (key, state) => {
    if (state.operation?.dispatchPhase === 'dispatched') throw new Error('storage unavailable');
    await save(key, state);
  };
  const failed = await apply(f, first.plan);
  assert.equal(failed.operation.status, 'failed'); assert.equal(failed.operation.messageCode, 'title_not_dispatched');
  assert.equal(f.dispatchedCalls.length, 0);
  f.storage.set = save; f.service = f.makeService();
  const next = await preview(f); assert.notEqual(next.plan.id, first.plan.id);
  assert.equal(f.dispatchedCalls.length, 0);
  await apply(f, next.plan); assert.equal(f.dispatchedCalls.length, 1);
});

test("pre-dispatch exceptions and late permits cannot revive a finished write attempt", async () => {
  let permit;
  const f = fixture({ beforeDispatch: async (_context, _payload, beforeDispatch) => { permit = beforeDispatch; throw new Error('preflight stopped'); } });
  const first = await preview(f), failed = await apply(f, first.plan);
  assert.equal(failed.operation.status, 'failed'); assert.equal(f.dispatchedCalls.length, 0);
  await assert.rejects(permit(), { code: 'TITLE_INVALID_PLAN' });
  assert.equal(f.storage.writes.at(-1).operation.dispatchPhase, 'prepared');
});

test("pre-dispatch result persistence failure is not turned into a possibly-sent write", async () => {
  const f = fixture({ beforeDispatch: async () => { throw new Error('preflight stopped'); } });
  const first = await preview(f), save = f.storage.set;
  f.storage.set = async (key, state) => {
    if (state.operation?.status === 'failed') throw new Error('receipt unavailable');
    await save(key, state);
  };
  const failed = await apply(f, first.plan);
  assert.equal(failed.operation.status, 'failed'); assert.equal(f.dispatchedCalls.length, 0);
  f.storage.set = save; f.service = f.makeService();
  const checked = await f.service.handle('reconcile', CONTEXT);
  assert.equal(checked.operation.messageCode, 'title_not_dispatched');
  assert.ok((await preview(f)).plan);
});

test("a consumed dispatch permit is persisted before the single outbound call", async () => {
  const f = fixture({ write: async (_context, payload, { current, storage }) => {
    assert.deepEqual(storage.writes.slice(-2).map(value => [value.operation.status, value.operation.dispatchPhase]),
      [['pending', 'prepared'], ['pending', 'dispatched']]);
    return { status: 'verified', current: { ...current, title: payload.after } };
  } });
  await apply(f, (await preview(f)).plan);
  assert.equal(f.dispatchedCalls.length, 1);
});

test("retired persisted inverse plans cannot execute and obsolete checkpoints are discarded", async () => {
  const f = fixture();
  const initial = await preview(f);
  const [key, stored] = [...f.storage.records.entries()][0];
  const inverseId = "retired-inverse-plan";
  stored.undo = { operationId: "old-operation", before: "Original", after: "Dated" };
  stored.plan = {
    ...stored.plan, id: inverseId, kind: "undo", action: "undo", operation: undefined,
    before: "Dated", after: "Original", undoOperationId: "old-operation", editingRules: stored.plan.rules,
    canApply: true, noOp: false,
  };
  await f.storage.set(key, stored);
  f.service = f.makeService();
  await assert.rejects(f.service.handle("apply", CONTEXT, { planId: inverseId }), { code: "TITLE_PREVIEW_REQUIRED" });
  assert.equal(f.writeCalls.length, 0);
  assert.equal(f.dispatchedCalls.length, 0);
  assert.equal(f.storage.records.get(key).plan, null);
  assert.equal(Object.hasOwn(f.storage.records.get(key), "undo"), false);
  assert.equal((await f.service.handle("status", CONTEXT)).canUndo, undefined);
  await assert.rejects(apply(f, initial.plan), { code: "TITLE_PREVIEW_REQUIRED" });
});

test("a current apply plan is projected without obsolete history fields and remains executable", async () => {
  const f = fixture();
  const first = await preview(f);
  const [key, stored] = [...f.storage.records.entries()][0];
  stored.undo = { before: "retired-before", after: "retired-after" };
  stored.plan.undoOperationId = "retired-operation-id";
  stored.plan.editingRules = { timeZone: "different-old-zone" };
  await f.storage.set(key, stored);
  const status = await f.service.handle("status", CONTEXT);
  assert.equal(status.plan.id, first.plan.id);
  assert.equal(status.plan.undoOperationId, undefined);
  assert.equal(status.plan.editingRules, undefined);
  const projected = f.storage.records.get(key);
  assert.equal(Object.hasOwn(projected, "undo"), false);
  assert.equal(Object.hasOwn(projected.plan, "undoOperationId"), false);
  const writes = f.storage.writes.length;
  await f.service.handle("status", CONTEXT);
  assert.equal(f.storage.writes.length, writes, "a current-schema status read does not rewrite storage");
  const applied = await apply(f, first.plan);
  assert.equal(applied.operation.status, "verified");
  assert.equal(applied.operation.kind, undefined);
  assert.equal(applied.canUndo, undefined);
  assert.equal(f.writeCalls[0].payload.expectedUpdatedAt, INITIAL.updatedAt);
  assert.equal(f.writeCalls[0].payload.expectedTimeZone, "Asia/Singapore");
  assert.equal(Object.hasOwn(f.storage.records.get(key), "undo"), false);
});

test("retired pending and uncertain writes retain recovery evidence but can never be replayed", async () => {
  for (const status of ["pending", "uncertain"]) {
    for (const observed of ["before", "after", "external"]) {
      const f = fixture();
      const first = await preview(f);
      const [key, stored] = [...f.storage.records.entries()][0];
      const receipt = {
        id: "retired-dispatched-write", conversationId: CONTEXT.conversationId,
        before: "Date head | Original", after: INITIAL.title, status, kind: "undo", startedAtMs: 900,
      };
      stored.operation = receipt;
      stored.undo = { before: INITIAL.title, after: receipt.before };
      stored.plan = { ...stored.plan, kind: "undo", id: receipt.id };
      await f.storage.set(key, stored);
      f.setCurrent({ title: observed === "before" ? receipt.before : observed === "after" ? receipt.after : "External title" });
      f.service = f.makeService();
      const recovered = await f.service.handle("status", CONTEXT);
      const expected = observed === "after" ? "verified" : "conflict";
      assert.equal(recovered.operation.status, expected);
      assert.equal(recovered.operation.id, receipt.id);
      assert.equal(recovered.operation.before, receipt.before);
      assert.equal(recovered.operation.after, receipt.after);
      assert.equal(recovered.operation.kind, undefined);
      assert.equal(recovered.plan, null);
      assert.equal(recovered.canUndo, undefined);
      assert.equal(f.storage.records.get(key).operation.status, expected);
      assert.equal(Object.hasOwn(f.storage.records.get(key), "undo"), false);
      await assert.rejects(apply(f, first.plan), { code: "TITLE_PREVIEW_REQUIRED" });
      const reconciled = await f.service.handle("reconcile", CONTEXT);
      assert.equal(reconciled.operation.status, expected);
      assert.equal(reconciled.operation.id, receipt.id);
      assert.equal(reconciled.canUndo, undefined);
      assert.equal(reconciled.plan, null, "reconciliation is observational, never a replacement write plan");
      assert.notEqual((await preview(f)).plan.id, first.plan.id);
      assert.equal(f.writeCalls.length, 0);
      assert.equal(f.dispatchedCalls.length, 0);
    }
  }
});

test("retired completed undo receipts are not surfaced as active title state", async () => {
  const f = fixture();
  await preview(f);
  const [key, stored] = [...f.storage.records.entries()][0];
  stored.plan = null;
  stored.operation = { id: "completed-inverse", status: "undone", before: "Dated", after: INITIAL.title, kind: "undo" };
  stored.undo = { before: "Dated", after: INITIAL.title };
  await f.storage.set(key, stored);
  const result = await f.service.handle("status", CONTEXT);
  assert.equal(result.operation, null);
  assert.equal(result.canUndo, undefined);
  assert.equal(f.storage.records.get(key).operation, null);
  assert.equal(Object.hasOwn(f.storage.records.get(key), "undo"), false);
  assert.equal(f.writeCalls.length, 0);
});

test("a no-op preview preserves the current receipt without dispatching or generating history", async () => {
  let noOp = false;
  const f = fixture({ model: { ...model, plan: (...args) => noOp ? { ...model.plan(...args), after: args[0].title, noOp: true, canApply: false } : model.plan(...args) } });
  const { plan } = await preview(f);
  await apply(f, plan);
  noOp = true;
  const next = await preview(f);
  assert.equal(next.operation.id, plan.id);
  assert.equal(next.canUndo, undefined);
  const beforeReads = f.readOptions.length;
  const unchanged = await apply(f, next.plan);
  assert.equal(unchanged.operation.id, plan.id);
  assert.equal(unchanged.canUndo, undefined);
  assert.deepEqual(f.readOptions.slice(beforeReads), [{ identityOnly: true }, undefined]);
  assert.equal(f.writeCalls.length, 1);
  assert.equal(Object.hasOwn([...f.storage.records.values()][0], "undo"), false);
});

test("the production model adds, removes and re-adds based only on the current title", async () => {
  const dateModel = require(path.join(ROOT, "src/features/titles/model/title-dates.js"));
  const f = fixture({ model: dateModel });
  const result = await preview(f, { rules: { mode: "range", dateFormat: "iso", timeZone: "Asia/Singapore", locale: "zh-CN" } });
  assert.equal(result.plan.after, "2026-09-01\u2009~\u200909-07｜Original title");
  assert.equal(result.plan.canApply, true);
  const applied = await apply(f, result.plan);
  assert.equal(applied.operation.status, "verified");
  const removal = await replan(f, applied.previewContext, { operation: "remove", rules: result.plan.rules });
  assert.equal(removal.plan.after, INITIAL.title);
  assert.equal(removal.plan.canApply, true);
  const removed = await apply(f, removal.plan);
  assert.equal(removed.operation.status, "verified");
  assert.equal(removed.plan.before, INITIAL.title);
  assert.equal(removed.plan.hasDateHead, false);
  assert.equal(removed.plan.canApply, true);
  assert.equal(removed.canUndo, undefined);
  assert.equal(removed.plan.after, "2026-09-01\u2009~\u200909-08｜Original title", "a fresh addition uses the readback update time, not prior history");
  assert.equal(f.readCalls.length, 3, "only first metadata read and each apply identity lookup are needed");
  assert.equal(f.writeCalls.length, 2);
});

test("a failed second attempt retains its failure receipt without reviving previous history", async () => {
  let count = 0;
  const f = fixture({ write: async (context, payload, { current, setCurrent }) => {
    count++;
    if (count > 1) return { status: "failed", current, httpStatus: 403, messageCode: "title_http_error" };
    const changed = { ...current, title: payload.after };
    setCurrent(changed);
    return { status: "verified", current: changed };
  } });
  const first = await preview(f);
  await apply(f, first.plan);
  const second = await preview(f);
  const failed = await apply(f, second.plan);
  assert.equal(failed.operation.status, "failed");
  assert.equal(failed.operation.id, second.plan.id);
  assert.equal(failed.canUndo, undefined);
  assert.equal(failed.plan, null);
  assert.equal(failed.previewContext, null);
  assert.equal(Object.hasOwn([...f.storage.records.values()][0], "undo"), false);
});

test("a missing durable pending checkpoint prevents any write", async () => {
  const storage = memoryStorage();
  const save = storage.set;
  storage.set = async (key, value) => {
    if (value.operation?.status === "pending") throw new Error("disk unavailable");
    return save(key, value);
  };
  const f = fixture({ storage });
  const { plan } = await preview(f);
  await assert.rejects(apply(f, plan), { code: "TITLE_NOT_DISPATCHED" });
  assert.equal(f.writeCalls.length, 0);
});

test("failing to save readback leaves a recoverable uncertain result", async () => {
  const storage = memoryStorage();
  const save = storage.set;
  storage.set = async (key, value) => {
    if (value.operation?.status === "verified") throw new Error("disk unavailable");
    return save(key, value);
  };
  const f = fixture({ storage });
  const { plan } = await preview(f);
  const result = await apply(f, plan);
  assert.equal(result.operation.status, "uncertain");
  assert.equal(result.operation.messageCode, "title_result_not_saved");
  assert.equal(result.canUndo, undefined);
  assert.equal(result.previewContext, null, "an undurable receipt cannot authorize continued editing");
  assert.equal(result.plan, null);
  assert.equal([...storage.records.values()][0].operation.status, "pending");
  storage.set = save;
  f.service = f.makeService();
  const reconciled = await f.service.handle("reconcile", CONTEXT);
  assert.equal(reconciled.operation.status, "verified");
  assert.equal(reconciled.canUndo, undefined);
  assert.equal(f.writeCalls.length, 1);
});

test("malformed metadata and incomplete identity fail closed", async () => {
  for (const bad of [
    { identity: { accountKey: "a", workspaceKey: "personal" }, current: { ...INITIAL, conversationId: "another" } },
    { identity: { accountKey: "a" }, current: INITIAL },
  ]) {
    const service = createTitleService({ read: async () => bad, write: async () => assert.fail("must not write"), storage: memoryStorage(), model });
    await assert.rejects(service.handle("preview", CONTEXT), { code: "CONTEXT_MISMATCH" });
  }
});

test("the display-only read rejects an identity change after apply's identity lookup", async () => {
  let readCount = 0;
  const service = createTitleService({
    read: async () => ({
      identity: { accountKey: ++readCount < 3 ? "account-a" : "account-b", workspaceKey: "personal" }, current: INITIAL,
    }),
    write: async () => assert.fail("a no-op must not dispatch"), storage: memoryStorage(),
    model: { ...model, plan: (...args) => ({ ...model.plan(...args), canApply: false, noOp: true, after: args[0].title }) },
    createId: () => "no-op-identity-test",
  });
  const { plan } = await service.handle("preview", CONTEXT);
  await assert.rejects(service.handle("apply", CONTEXT, { planId: plan.id }), { code: "CONTEXT_MISMATCH" });
});

test("title operations use existing IndexedDB module-state and support atomic record cleanup", async () => {
  const { STORAGE_BOUNDARIES } = loadModule("src/platform/storage/schema.js", ["STORAGE_BOUNDARIES"]);
  const { openTidyDatabase, storageError } = loadModule("src/platform/storage/database.js", ["openTidyDatabase", "storageError"], { STORAGE_BOUNDARIES });
  const { createTitleOperationsRepository } = loadModule("src/features/titles/storage/title-operations.js", ["createTitleOperationsRepository"], {
    STORAGE_BOUNDARIES, openTidyDatabase, storageError, IDBKeyRange,
  });
  const indexedDbFactory = new IDBFactory();
  const repository = createTitleOperationsRepository({ indexedDbFactory });
  assert.equal(await repository.get("identity-conversation"), null);
  await repository.set("identity-conversation", { operation: { before: "one", after: "two" } });
  await repository.set("identity-conversation", { operation: { before: "two", after: "three" } });
  assert.deepEqual(plain(await repository.get("identity-conversation")), { operation: { before: "two", after: "three" } });
  const reopened = createTitleOperationsRepository({ indexedDbFactory });
  assert.deepEqual(plain(await reopened.get("identity-conversation")), { operation: { before: "two", after: "three" } });
  const db = await openTidyDatabase(indexedDbFactory);
  const tx = db.transaction("module-state", "readonly");
  const records = await new Promise((resolve, reject) => {
    const request = tx.objectStore("module-state").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].key, "title-operations.v1:identity-conversation");
  assert.equal(db.version, STORAGE_BOUNDARIES.indexedDb.version);
  db.close();
  await reopened.remove(["identity-conversation", "already-missing"]);
  assert.equal(await reopened.get("identity-conversation"), null);
});
