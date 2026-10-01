const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { installPageSession } = require("./helpers/page-session.cjs");

const root = path.resolve(__dirname, "..");
const id = "conversation-1";
const identity = { accountKey: "user-1", workspaceKey: "personal" };
const plain = (value) => JSON.parse(JSON.stringify(value));
const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function harness(options = {}) {
  const calls = [];
  let sessionCalls = 0;
  let readCalls = 0;
  let postCalls = 0;
  const native = { conversation_id: id, title: "Original", create_time: 1_700_000_000, update_time: 1_700_000_001,
    ...options.native };
  const context = vm.createContext({
    Date, URL, AbortController, encodeURIComponent,
    setTimeout: options.setTimeout || setTimeout, clearTimeout: options.clearTimeout || clearTimeout,
    document: { cookie: options.cookie || "" },
    location: { href: options.url || `https://chatgpt.com/c/${id}`, origin: "https://chatgpt.com" },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url === "/api/auth/session") {
        sessionCalls++;
        if (options.session) return options.session({ sessionCalls, context });
        return ok({ accessToken: "fixture-secret", user: { id: "user-1" }, activeAccountId: "not-workspace" });
      }
      if (init.method === "POST") {
        postCalls++;
        if (options.post) return options.post({ postCalls, native, context, init });
        native.title = JSON.parse(init.body).title;
        native.update_time++;
        return ok({});
      }
      readCalls++;
      if (options.read) return options.read({ readCalls, native, context, url, init });
      return ok({ ...native, messages: [{ content: "Private body never crosses the bridge" }] });
    },
  });
  installPageSession(context);
  vm.runInContext(fs.readFileSync(path.join(root, "src/platform/snapshot.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(root, "src/platform/time-format.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(root, "src/features/titles/model/title-dates.js"), "utf8"), context);
  for (const file of ["src/platform/chatgpt/api.js", "src/platform/chatgpt/route.js", "src/features/titles/chatgpt/titles.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
  }
  return { adapter: context.TidyChatgptTitles, context, calls, native };
}

const input = (overrides = {}) => ({ conversationId: id, identity, before: "Original", after: "2026-09-08 Original", metadataSource: "detail",
  expectedCreatedAt: "2023-11-14T22:13:20.000Z", expectedUpdatedAt: "2023-11-14T22:13:21.000Z", ...overrides });
const writes = (calls) => calls.filter(({ init }) => init.method === "POST");

// Only the worker owns this recipe in production. The helper creates the
// identical private adapter contract without any live network or account.
function catalogInput(h, directory = {}, rules = {}, options = {}) {
  const current = { conversationId: id, title: h.native.title,
    createdAt: new Date(h.native.create_time * 1000).toISOString(),
    updatedAt: new Date(h.native.update_time * 1000).toISOString(), ...directory };
  const planned = h.context.TidyTitleDates.plan(current, {
    mode: "range", dateFormat: "iso", timeZone: "UTC", locale: "en-US", ...rules,
  }, { operation: "assign", ...options });
  assert.equal(planned.canApply, true, "test recipe must actually require a write");
  return input({ before: planned.before, after: planned.after, metadataSource: "catalog",
    expectedCreatedAt: current.createdAt, expectedUpdatedAt: current.updatedAt,
    catalogIntent: { rules: plain(planned.rules), operation: planned.operation, decision: planned.selectedDecision } });
}

test("catalog output validation accepts cross-source drift in either timestamp without an extra request", async () => {
  for (const field of ["createdAt", "updatedAt"]) for (const delta of [1, 802, 1445, 1700, 3297, 3600000]) {
    const h = harness({ native: { create_time: 1_700_000_000 - 86400 } });
    const value = h.native[field === "createdAt" ? "create_time" : "update_time"] * 1000;
    const plan = catalogInput(h, { [field]: new Date(value - delta).toISOString() });
    const reviewed = plain(plan);
    const result = await h.adapter.writeCurrent(plan);
    assert.equal(result.status, "verified", `${field}: ${delta}ms`);
    assert.deepEqual(plan, reviewed, "the reviewed title, rules and dates remain frozen");
    assert.deepEqual(JSON.parse(writes(h.calls)[0].init.body), { title: reviewed.after });
    assert.deepEqual(h.calls.map(({ url, init }) => init.method === "POST" ? "POST" : url === "/api/auth/session" ? "auth" : "metadata"),
      ["auth", "metadata", "auth", "POST", "metadata", "auth"]);
  }
});

test("a confirmed batch revalidates identity once immediately before POST and is revoked explicitly", async () => {
  const h = harness();
  const opened = await h.adapter.beginBatchExecution({ conversationId: id, batchScopeId: "batch-1",
    identity, expectedCatalogAccountKey: "not-workspace" });
  assert.deepEqual(plain(opened), { identity, catalogAccountKey: "not-workspace" });
  const plan = input({ batchScopeId: "batch-1" });
  const result = await h.adapter.writeCurrent(plan);
  assert.equal(result.status, "accepted");
  assert.equal(result.accepted.title, plan.after);
  assert.deepEqual(h.calls.map(({ url, init }) => init.method === "POST" ? "POST" : url === "/api/auth/session" ? "auth" : "metadata"),
    ["auth", "metadata", "auth", "POST"], "one lease acquisition, then one final identity check per POST; no detail readback");
  assert.deepEqual(plain(h.adapter.endBatchExecution({ conversationId: id, batchScopeId: "batch-1" })), { ended: true });
  const before = h.calls.length;
  const closed = await h.adapter.writeCurrent({ ...plan, before: result.accepted.title, after: `Again ${result.accepted.title}` });
  assert.equal(closed.status, "failed"); assert.equal(closed.messageCode, "account_changed");
  assert.equal(h.calls.length, before, "a closed lease fails before metadata or POST");
});

test("a real batch lease rejects a same-workspace user switch before POST and cannot be reused", async () => {
  for (const switchAt of ["before-step", "during-preflight"]) {
    let user = "user-1";
    const h = harness({ session: async () => ok({ accessToken: `token-${user}`, user: { id: user }, activeAccountId: "catalog" }),
      read: async ({ native }) => { if (switchAt === "during-preflight") user = "user-2"; return ok({ ...native }); } });
    await h.adapter.beginBatchExecution({ conversationId: id, batchScopeId: "real-batch",
      identity, expectedCatalogAccountKey: "catalog" });
    if (switchAt === "before-step") user = "user-2";
    const result = await h.adapter.writeCurrent(input({ batchScopeId: "real-batch" }));
    assert.equal(result.status, "failed"); assert.equal(result.messageCode, "account_changed");
    assert.equal(writes(h.calls).length, 0, "the old bearer cannot authorize a write for the newly signed-in user");
    assert.equal(h.context.document.cookie, "", "personal workspace cookie did not change");
    assert.equal(h.calls.filter(call => call.url === "/api/auth/session").length, 2);
    const count = h.calls.length; user = "user-1";
    const reused = await h.adapter.writeCurrent(input({ batchScopeId: "real-batch" }));
    assert.equal(reused.status, "failed"); assert.equal(h.calls.length, count, "switching back is not a new batch confirmation");
  }
});

test("a real batch uses the final checked token, detects catalog-account drift, and never authenticates a no-write conflict", async () => {
  for (const change of ["token", "catalog", "conflict"]) {
    let session = 0;
    const h = harness({ session: async () => ok({ accessToken: `token-${++session}`, user: { id: "user-1" },
      activeAccountId: change === "catalog" && session > 1 ? "another-catalog" : "catalog" }) });
    await h.adapter.beginBatchExecution({ conversationId: id, batchScopeId: "real-batch", identity, expectedCatalogAccountKey: "catalog" });
    if (change === "conflict") h.native.title = "External title";
    const result = await h.adapter.writeCurrent(input({ batchScopeId: "real-batch" }));
    if (change === "token") {
      assert.equal(result.status, "accepted"); assert.equal(writes(h.calls)[0].init.headers.Authorization, "Bearer token-2");
      assert.equal(result.catalogAccountKey, "catalog");
    } else {
      assert.equal(result.status, change === "catalog" ? "failed" : "conflict");
      assert.equal(writes(h.calls).length, 0);
    }
    assert.equal(session, change === "conflict" ? 1 : 2, "only an otherwise writable title needs a final identity check");
  }
});

test("catalog preflight rejects even 1200ms across the selected timezone's date boundary", async () => {
  for (const [timeZone, directory, actual] of [
    ["UTC", "2026-09-07T23:59:59.500Z", "2026-09-08T00:00:00.700Z"],
    ["Asia/Singapore", "2026-09-07T15:59:59.500Z", "2026-09-07T16:00:00.700Z"],
  ]) {
    const h = harness({ native: { update_time: Date.parse(actual) / 1000 } });
    const plan = catalogInput(h, { updatedAt: directory }, { timeZone });
    const result = await h.adapter.writeCurrent(plan);
    assert.equal(result.status, "conflict"); assert.equal(result.messageCode, "dates_changed");
    assert.equal(result.current.updatedAt, actual);
    assert.equal(writes(h.calls).length, 0); assert.equal(h.calls.length, 2, "reject at the first preflight, before final auth/POST");
  }
});

test("catalog decisions remain exact for replace, stack and remove even when an unused date changes", async () => {
  for (const [operation, decision] of [["assign", "replace"], ["assign", "stack"], ["remove", "skip"]]) {
    const h = harness({ native: { title: "2022-01-01｜Exact body" } });
    const plan = catalogInput(h, {}, { mode: "created" }, { operation, decision });
    h.native.update_time += 86400; // created-only/remove output does not use this field
    const result = await h.adapter.writeCurrent(plan);
    assert.equal(result.status, "verified"); assert.equal(writes(h.calls).length, 1);
    assert.deepEqual(JSON.parse(writes(h.calls)[0].init.body), { title: plan.after });
  }
});

test("catalog checks never replace a confirmed title with a newly computed one or overwrite an external title", async () => {
  for (const change of ["after", "title", "decision"]) {
    const h = harness({ native: { title: "2022-01-01｜Exact body" } });
    const plan = catalogInput(h, {}, {}, { decision: "replace" });
    if (change === "after") plan.after = "Unreviewed substitute";
    if (change === "title") h.native.title = "External edit";
    if (change === "decision") plan.catalogIntent.decision = "stack";
    const result = await h.adapter.writeCurrent(plan);
    assert.equal(result.status, "conflict");
    assert.equal(result.messageCode, change === "title" ? "title_conflict" : "dates_changed");
    assert.equal(writes(h.calls).length, 0);
  }
});

test("detail-sourced previews still reject a one-millisecond change in either timestamp", async () => {
  for (const field of ["create_time", "update_time"]) {
    const h = harness(); h.native[field] += 0.001;
    const result = await h.adapter.writeCurrent(input());
    assert.equal(result.status, "conflict"); assert.equal(result.messageCode, "dates_changed");
    assert.equal(writes(h.calls).length, 0);
  }
});

test("missing, unknown or mixed timestamp provenance never reaches HTTP", async () => {
  for (const mutate of [
    plan => delete plan.metadataSource, plan => { plan.metadataSource = "unknown"; },
    plan => { plan.metadataSource = "catalog"; },
    plan => { plan.catalogIntent = { rules: {}, operation: "assign" }; },
    plan => delete plan.expectedCreatedAt, plan => delete plan.expectedUpdatedAt,
  ]) {
    const h = harness(), plan = input(); mutate(plan);
    await assert.rejects(h.adapter.writeCurrent(plan), { tidyCode: "TITLE_INVALID_PLAN" });
    assert.equal(h.calls.length, 0);
  }
});

test("catalog preflight retains account, project and permission checks before any POST", async () => {
  for (const [kind, options] of [
    ["account", { session: async ({ sessionCalls }) => ok({ accessToken: "fixture-secret", user: { id: sessionCalls === 1 ? "user-1" : "user-2" } }) }],
    ["project", { native: { gizmo_type: "snorlax", gizmo_id: "g-p-moved" } }],
    ["permission", { native: { is_read_only: true } }],
  ]) {
    const h = harness(options), plan = catalogInput(h);
    const result = await h.adapter.writeCurrent(plan);
    assert.equal(result.status, "failed", kind); assert.equal(writes(h.calls).length, 0);
    if (kind === "account") assert.equal(result.messageCode, "account_changed");
  }
});

test("title read uses plural metadata, projects only canonical dates, and never exposes auth/messages", async () => {
  const { adapter, calls } = harness();
  const result = plain(await adapter.readCurrent({ conversationId: id }));
  assert.deepEqual(result, { identity, catalogAccountKey: "not-workspace", current: {
    conversationId: id, title: "Original", createdAt: "2023-11-14T22:13:20.000Z", updatedAt: "2023-11-14T22:13:21.000Z",
  } });
  assert.equal(calls[1].url, `/backend-api/conversations/${id}?include_has_versions=true&num_turns=10`);
  assert.equal(calls[1].init.headers["ChatGPT-Account-ID"], undefined);
  assert.equal(calls[1].init.headers.Authorization, "Bearer fixture-secret");
  assert.equal(calls.length, 3, "fresh identity checked before and after metadata");
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|Private body|activeAccountId/);
});

test("workspace header comes only from the native _account cookie", async () => {
  const { adapter, calls } = harness({ cookie: "other=1; _account=workspace%2Fone" });
  const result = await adapter.readCurrent({ conversationId: id });
  assert.equal(result.identity.workspaceKey, "workspace/one");
  assert.equal(calls[1].init.headers["ChatGPT-Account-ID"], "workspace%2Fone");
});

test("first read binds the workspace after startup session hydration without retrying", async () => {
  const h = harness({ session: async ({ context }) => {
    context.document.cookie = "_account=workspace-ready";
    return ok({ accessToken: "fixture-secret", user: { id: "user-1" } });
  } });
  const result = await h.adapter.readCurrent({ conversationId: id });
  assert.equal(result.identity.workspaceKey, "workspace-ready");
  assert.equal(h.calls[1].init.headers["ChatGPT-Account-ID"], "workspace-ready");
  assert.equal(h.calls.length, 3, "one session acquisition, one metadata read, one identity verification");
  assert.equal(writes(h.calls).length, 0);
});

test("startup workspace acquisition never absorbs changes to an already-bound read or apply lookup", async () => {
  for (const payload of [{ identity }, { identityOnly: true }]) {
    const h = harness({ session: async ({ context }) => {
      context.document.cookie = "_account=workspace-ready";
      return ok({ accessToken: "fixture-secret", user: { id: "user-1" } });
    } });
    await assert.rejects(h.adapter.readCurrent({ conversationId: id, ...payload }), { tidyCode: "TITLE_ACCOUNT_CHANGED" });
    assert.equal(h.calls.length, 1, "a bound operation must stop before metadata or POST");
  }
});

test("first-read workspace binding still rejects a switch during metadata or final verification", async () => {
  for (const phase of ["metadata", "final-session", "final-user"]) {
    const h = harness({ session: async ({ context, sessionCalls }) => {
      if (sessionCalls === 1) context.document.cookie = "_account=workspace-ready";
      if (phase === "final-session" && sessionCalls === 2) context.document.cookie = "_account=other";
      return ok({ accessToken: "fixture-secret", user: { id: phase === "final-user" && sessionCalls === 2 ? "user-2" : "user-1" } });
    }, read: async ({ native, context }) => {
      if (phase === "metadata") context.document.cookie = "_account=other";
      return ok(native);
    } });
    await assert.rejects(h.adapter.readCurrent({ conversationId: id }), { tidyCode: "TITLE_ACCOUNT_CHANGED" });
    assert.equal(h.calls.length, phase === "metadata" ? 2 : 3);
    assert.equal(writes(h.calls).length, 0);
  }
});

test("initial session failures stop once even if the page initializes its workspace", async () => {
  for (const status of [401, 429, 503]) {
    const h = harness({ session: async ({ context }) => {
      context.document.cookie = "_account=workspace-ready";
      return ok({}, status);
    } });
    await assert.rejects(h.adapter.readCurrent({ conversationId: id }), {
      tidyCode: status === 429 ? "TITLE_RATE_LIMITED" : "TITLE_AUTH_REQUIRED", httpStatus: status,
    });
    assert.equal(h.calls.length, 1);
    assert.equal(writes(h.calls).length, 0);
  }
});

test("initial session acquisition still refuses navigation before metadata", async () => {
  const h = harness({ session: async ({ context }) => {
    context.location.href = "https://chatgpt.com/c/other";
    return ok({ accessToken: "fixture-secret", user: { id: "user-1" } });
  } });
  await assert.rejects(h.adapter.readCurrent({ conversationId: id }), { tidyCode: "CONTEXT_MISMATCH" });
  assert.equal(h.calls.length, 1);
});

test("a write never acquires a replacement workspace during its first session request", async () => {
  const h = harness({ session: async ({ context }) => {
    context.document.cookie = "_account=workspace-other";
    return ok({ accessToken: "fixture-secret", user: { id: "user-1" } });
  } });
  const result = await h.adapter.writeCurrent(input());
  assert.equal(result.status, "failed");
  assert.equal(result.messageCode, "account_changed");
  assert.equal(h.calls.length, 1);
  assert.equal(writes(h.calls).length, 0);
});

test("identity-only apply lookup performs one session request and exposes no credentials or stale metadata", async () => {
  const { adapter, calls } = harness();
  const result = plain(await adapter.readCurrent({ conversationId: id, identityOnly: true }));
  assert.deepEqual(result, { identity, catalogAccountKey: "not-workspace" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/auth/session");
});

test("title reads and verified writes project a distinct catalog key from the same sessions without extra auth", async () => {
  const h = harness({ cookie: "_account=workspace-cookie", session: async () => ok({
    accessToken: "fixture-secret", user: { id: "user-1" }, active_account_id: "catalog-account",
  }) });
  const read = await h.adapter.readCurrent({ conversationId: id });
  assert.deepEqual(plain(read.identity), { accountKey: "user-1", workspaceKey: "workspace-cookie" });
  assert.equal(read.catalogAccountKey, "catalog-account");
  assert.equal(h.calls.length, 3);
  h.calls.length = 0;
  const saved = await h.adapter.writeCurrent(input({ identity: read.identity }));
  assert.equal(saved.status, "verified");
  assert.equal(saved.catalogAccountKey, "catalog-account");
  assert.equal(h.calls.length, 6);
  assert.equal(h.calls.filter(call => call.url === "/api/auth/session").length, 3);
  assert.equal(writes(h.calls).length, 1);
  assert.equal(writes(h.calls)[0].init.headers["ChatGPT-Account-ID"], "workspace-cookie",
    "directory projection must not change native rename workspace headers");
  assert.doesNotMatch(JSON.stringify(saved), /fixture-secret|active_account_id|workspace-cookie|user-1/);
});

test("a catalog key change during metadata read omits cache projection but preserves checked title metadata", async () => {
  const h = harness({ session: async ({ sessionCalls }) => ok({ accessToken: "fixture-secret",
    user: { id: "user-1" }, activeAccountId: sessionCalls === 1 ? "catalog-a" : "catalog-b" }) });
  const read = await h.adapter.readCurrent({ conversationId: id });
  assert.equal(read.current.title, "Original");
  assert.equal(Object.hasOwn(read, "catalogAccountKey"), false);
  assert.equal(h.calls.length, 3);
  assert.equal(writes(h.calls).length, 0);
});

test("verified projection follows the POST session, not an earlier preflight session", async () => {
  const h = harness({ session: async ({ sessionCalls }) => ok({ accessToken: "fixture-secret",
    user: { id: "user-1" }, activeAccountId: sessionCalls === 1 ? "catalog-a" : "catalog-b" }) });
  const saved = await h.adapter.writeCurrent(input());
  assert.equal(saved.status, "verified");
  assert.equal(saved.catalogAccountKey, "catalog-b");
  assert.equal(h.calls.length, 6);
  assert.equal(writes(h.calls).length, 1);
});

test("a catalog-only identity change after POST omits projection without downgrading a verified receipt", async () => {
  const h = harness({ session: async ({ sessionCalls }) => ok({ accessToken: "fixture-secret",
    user: { id: "user-1" }, account: { id: sessionCalls < 3 ? "catalog-a" : "catalog-b" } }) });
  const saved = await h.adapter.writeCurrent(input());
  assert.equal(saved.status, "verified");
  assert.equal(saved.current.title, input().after);
  assert.equal(Object.hasOwn(saved, "catalogAccountKey"), false);
  assert.equal(h.calls.length, 6);
  assert.equal(writes(h.calls).length, 1);
});

test("failed, conflicting and uncertain writes never expose verified catalog projection", async () => {
  for (const [expected, options] of [
    ["failed", { post: async () => ok({}, 403) }],
    ["conflict", { native: { title: "External title" } }],
    ["conflict", { post: async ({ native }) => { native.title = "External title"; return ok({}); } }],
    ["uncertain", { post: async () => { throw new Error("Network lost before outcome is known"); } }],
  ]) {
    const h = harness(options);
    const saved = await h.adapter.writeCurrent(input());
    assert.equal(saved.status, expected);
    assert.equal(Object.hasOwn(saved, "catalogAccountKey"), false);
    assert.ok(writes(h.calls).length <= 1);
  }
});

test("single confirmed POST carries only title and verifies final server metadata", async () => {
  const { adapter, calls } = harness();
  const result = await adapter.writeCurrent(input({ expectedCreatedAt: "2023-11-14T22:13:20.000Z", expectedUpdatedAt: "2023-11-14T22:13:21.000Z" }));
  assert.equal(result.status, "verified");
  assert.equal(result.current.title, input().after);
  assert.equal(result.current.updatedAt, "2023-11-14T22:13:22.000Z");
  assert.equal(writes(calls).length, 1);
  assert.equal(writes(calls)[0].url, `/backend-api/conversation/id/${id}/rename`);
  assert.deepEqual(JSON.parse(writes(calls)[0].init.body), { title: input().after });
  assert.equal(calls.some(({ init }) => init.method === "PATCH"), false);
  assert.equal(calls.length, 6, "three session checks, two metadata reads, and one POST");
  assert.deepEqual(calls.map(({ url, init }) => init.method === "POST" ? "POST" : url === "/api/auth/session" ? "auth" : "metadata"),
    ["auth", "metadata", "auth", "POST", "metadata", "auth"]);
});

test("the last fresh identity check prevents success after an account switch during readback", async () => {
  const { adapter, calls } = harness({ session: async ({ sessionCalls }) =>
    ok({ accessToken: "fixture-secret", user: { id: sessionCalls < 3 ? "user-1" : "user-2" } }) });
  const result = await adapter.writeCurrent(input());
  assert.equal(result.status, "uncertain");
  assert.equal(result.current, null);
  assert.equal(writes(calls).length, 1);
});

test("readback uses only the operation's latest checked credentials and never retries expiration", async () => {
  const { adapter, calls } = harness({
    session: async ({ sessionCalls }) => ok({ accessToken: `fixture-${sessionCalls}`, user: { id: "user-1" } }),
    read: async ({ readCalls, native }) => readCalls === 1 ? ok(native) : ok({}, 401),
  });
  const result = await adapter.writeCurrent(input());
  assert.equal(result.status, "uncertain");
  assert.equal(calls[3].init.headers.Authorization, "Bearer fixture-2");
  assert.equal(calls[4].init.headers.Authorization, "Bearer fixture-2");
  assert.equal(calls.length, 5);
  assert.equal(writes(calls).length, 1);
});

test("real service and adapter complete a confirmed apply in seven HTTP requests", async () => {
  const { adapter, context, calls } = harness();
  const serviceSource = fs.readFileSync(path.join(root, "src/features/titles/background/title-service.js"), "utf8")
    .replace(/^import[^;]+;\r?\n/gm, "").replaceAll("export ", "");
  vm.runInContext(`${serviceSource}\nglobalThis.makeTitleService = createTitleService;`, context);
  const records = new Map();
  const service = context.makeTitleService({
    read: (target, options) => adapter.readCurrent({ ...options, conversationId: target.conversationId }),
    write: async (target, plan, beforeDispatch) => { await beforeDispatch(); return adapter.writeCurrent({ ...plan, conversationId: target.conversationId }); },
    storage: { get: async (key) => records.get(key), set: async (key, value) => records.set(key, plain(value)) },
    model: require(path.join(root, "src/features/titles/model/title-dates.js")),
    createId: () => "plan-latency-test",
  });
  const target = { tabId: 10, conversationId: id };
  const preview = await service.handle("preview", target, { rules: { mode: "creation", timeZone: "UTC" } });
  assert.equal(preview.plan.canApply, true);
  calls.length = 0;
  const result = await service.handle("apply", target, { planId: preview.plan.id });
  assert.equal(result.operation.status, "verified");
  assert.equal(result.current.title, preview.plan.after);
  assert.equal(calls.length, 7);
  assert.equal(writes(calls).length, 1);
});

test("real adapter is never called for frozen option changes; final apply keeps all seven HTTP steps", async () => {
  const { adapter, context, calls, native } = harness();
  native.title = "2023/11/01｜Original";
  const serviceSource = fs.readFileSync(path.join(root, "src/features/titles/background/title-service.js"), "utf8")
    .replace(/^import[^;]+;\r?\n/gm, "").replaceAll("export ", "");
  vm.runInContext(`${serviceSource}\nglobalThis.makeTitleService = createTitleService;`, context);
  const records = new Map();
  let serial = 0;
  const service = context.makeTitleService({
    read: (target, options) => adapter.readCurrent({ ...options, conversationId: target.conversationId }),
    write: async (target, plan, beforeDispatch) => { await beforeDispatch(); return adapter.writeCurrent({ ...plan, conversationId: target.conversationId }); },
    storage: { get: async (key) => records.get(key), set: async (key, value) => records.set(key, plain(value)) },
    model: require(path.join(root, "src/features/titles/model/title-dates.js")), createId: () => `frozen-${++serial}`,
  });
  const target = { tabId: 10, conversationId: id };
  let prepared = await service.handle("preview", target, { rules: { mode: "created", timeZone: "UTC" } });
  assert.equal(calls.length, 3, "only the first preview reads session, metadata, session");
  const frozenId = prepared.previewContext.id;
  const expiresAt = prepared.previewContext.expiresAt;
  calls.length = 0;
  const planIds = new Set();
  for (const mode of ["created", "range"]) {
    for (const dateFormat of ["locale", "iso", "slash", "dot", "compact"]) {
      for (const decision of ["skip", "stack", "replace"]) {
        prepared = await service.handle("replan", target, {
          previewContextId: frozenId, operation: "assign", decision,
          rules: { mode, dateFormat, timeZone: "UTC", locale: "en-US" },
        });
        assert.equal(prepared.plan.before, "2023/11/01｜Original");
        assert.equal(prepared.plan.selectedDecision, decision);
        assert.equal(prepared.previewContext.expiresAt, expiresAt);
        assert.equal(calls.length, 0, "choice changes may not issue even a session-only GET");
        assert.equal(planIds.has(prepared.plan.id), false);
        planIds.add(prepared.plan.id);
      }
    }
  }
  assert.equal(planIds.size, 30);
  const result = await service.handle("apply", target, { planId: prepared.plan.id, after: "UNREVIEWED" });
  assert.equal(result.operation.status, "verified");
  assert.equal(result.current.title, prepared.plan.after);
  assert.deepEqual(calls.map(({ url, init }) => init.method === "POST" ? "POST" : url === "/api/auth/session" ? "auth" : "metadata"),
    ["auth", "auth", "metadata", "auth", "POST", "metadata", "auth"]);
  assert.equal(writes(calls).length, 1);
});

for (const status of [400, 401, 403, 404, 409, 429]) {
  test(`HTTP ${status} never retries or changes route`, async () => {
    const { adapter, calls } = harness({ post: async () => ok({ secret: "server-error" }, status) });
    const result = await adapter.writeCurrent(input());
    assert.equal(result.status, "failed");
    assert.equal(result.httpStatus, status);
    assert.equal(writes(calls).length, 1);
    assert.doesNotMatch(JSON.stringify(result), /server-error|fixture-secret/);
  });
}

for (const mode of ["network", "http408", "http500", "ok-stale"]) {
  test(`${mode} with original title remains uncertain, never automatically replays`, async () => {
    const { adapter, calls } = harness({ post: async () => {
      if (mode === "network") throw new Error("Disconnected");
      return ok({}, mode === "http408" ? 408 : mode === "http500" ? 500 : 200);
    } });
    const result = await adapter.writeCurrent(input());
    assert.equal(result.status, "uncertain");
    assert.equal(writes(calls).length, 1);
  });
}

test("lost response after server commit is resolved by readback without resend", async () => {
  const { adapter, calls } = harness({ post: async ({ native, init }) => {
    native.title = JSON.parse(init.body).title;
    throw new Error("Lost response");
  } });
  assert.equal((await adapter.writeCurrent(input())).status, "verified");
  assert.equal(writes(calls).length, 1);
});

test("title/date mismatch fails before dispatch and never rebuilds the target", async () => {
  for (const changes of [{ title: "External title" }, { update_time: 1_700_000_009 }]) {
    const { adapter, calls } = harness({ read: async ({ native }) => ok({ ...native, ...changes }) });
    const result = await adapter.writeCurrent(input({ expectedUpdatedAt: "2023-11-14T22:13:21.000Z" }));
    assert.equal(result.status, "conflict");
    assert.equal(writes(calls).length, 0);
  }
});

test("fresh account switch between preflight and write blocks dispatch", async () => {
  const { adapter, calls } = harness({ session: async ({ sessionCalls }) =>
    ok({ accessToken: "fixture-secret", user: { id: sessionCalls === 1 ? "user-1" : "user-2" } }) });
  const result = await adapter.writeCurrent(input());
  assert.equal(result.status, "failed");
  assert.equal(result.messageCode, "account_changed");
  assert.equal(writes(calls).length, 0);
});

test("workspace change during metadata request blocks dispatch", async () => {
  const { adapter, calls } = harness({ read: async ({ native, context }) => {
    context.document.cookie = "_account=another";
    return ok(native);
  } });
  assert.equal((await adapter.writeCurrent(input())).status, "failed");
  assert.equal(writes(calls).length, 0);
});

test("account/route change after dispatch cannot report verified", async () => {
  const { adapter, calls } = harness({ post: async ({ native, context, init }) => {
    native.title = JSON.parse(init.body).title;
    context.location.href = "https://chatgpt.com/c/other";
    return ok({});
  } });
  assert.equal((await adapter.writeCurrent(input())).status, "uncertain");
  assert.equal(writes(calls).length, 1);
});

test("external replacement discovered after POST is conflict rather than success", async () => {
  const { adapter } = harness({ post: async ({ native }) => { native.title = "External later title"; return ok({}); } });
  assert.equal((await adapter.writeCurrent(input())).status, "conflict");
});

test("simultaneous write requests cannot dispatch twice", async () => {
  const { adapter, calls } = harness();
  const results = await Promise.allSettled([adapter.writeCurrent(input()), adapter.writeCurrent(input())]);
  assert.equal(results[0].value.status, "verified");
  assert.equal(results[1].reason.tidyCode, "TITLE_BUSY");
  assert.equal(writes(calls).length, 1);
});

test("invalid target routes and titles are rejected without a network request", async () => {
  for (const url of ["https://chatgpt.com/", `https://chatgpt.com/g/g-custom/c/${id}`, `https://chatgpt.com/share/${id}`, `https://chatgpt.com/c/${id}/extra`,
    `http://chatgpt.com/c/${id}`, `https://chatgpt.com:8443/c/${id}`, `https://example.com/c/${id}`,
    `https://chatgpt.com/g/g-p-test/c/${id}/extra`, `https://chatgpt.com/gg/${id}`, `https://chatgpt.com/c/WEB:draft`,
    `https://chatgpt.com/c/${id}//`, `https://chatgpt.com/g/g-p-test/other/c/${id}`]) {
    const { adapter, calls } = harness({ url });
    await assert.rejects(adapter.writeCurrent(input()), { tidyCode: "CONTEXT_MISMATCH" });
    assert.equal(calls.length, 0);
  }
  for (const after of ["", "   ", "Original", null]) {
    const { adapter, calls } = harness();
    await assert.rejects(adapter.writeCurrent(input({ after })), { tidyCode: "TITLE_INVALID_PLAN" });
    assert.equal(calls.length, 0);
  }
});

test("read validates response conversation identity and does not retry auth errors", async () => {
  const mismatched = harness({ read: async ({ native }) => ok({ ...native, conversation_id: "other" }) });
  await assert.rejects(mismatched.adapter.readCurrent({ conversationId: id }), { tidyCode: "TITLE_UNAVAILABLE" });
  const unauthorized = harness({ read: async () => ok({}, 401) });
  await assert.rejects(unauthorized.adapter.readCurrent({ conversationId: id }), { tidyCode: "TITLE_AUTH_REQUIRED" });
  assert.equal(unauthorized.calls.length, 2);
});

test("timed-out auth cannot dispatch a delayed write", async () => {
  let resolveSession;
  const { adapter, calls } = harness({
    setTimeout: (callback) => setTimeout(callback, 5),
    session: () => new Promise((resolve) => { resolveSession = resolve; }),
  });
  assert.equal((await adapter.writeCurrent(input())).status, "failed");
  resolveSession(ok({ accessToken: "late-secret", user: { id: "user-1" } }));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(writes(calls).length, 0);
});

const projectId = "g-p-project-one";
const projectPath = `/g/${projectId}/c/${id}`;
const projectNative = { gizmo_id: projectId, gizmo_type: "snorlax", owner: { user_id: identity.accountKey },
  is_read_only: null, is_temporary_chat: false };
const ownerContext = { conversationId: "owner-conversation", pathname: "/c/owner-conversation", projectId: null };
const ownerUrl = `https://chatgpt.com${ownerContext.pathname}`;

// Synthetic workspace IDs model the native scoped owner without retaining any live account data.
const workspaceOwnerKey = "11111111-2222-4333-8444-555555555555";
const otherWorkspaceOwnerKey = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const workspaceTitleIdentity = { accountKey: identity.accountKey, workspaceKey: workspaceOwnerKey };
const scopedOwnerId = identity.accountKey + "__" + workspaceOwnerKey;
function workspaceProjectHarness(options = {}) {
  return harness({ ...options,
    cookie: options.cookie ?? "_account=" + workspaceOwnerKey,
    url: options.url ?? "https://chatgpt.com" + projectPath,
    native: { ...projectNative, owner: { user_id: scopedOwnerId }, ...options.native },
  });
}

test("workspace-scoped project owners retain the exact title identity and minimal preview projection", async () => {
  const h = workspaceProjectHarness();
  const result = await h.adapter.readCurrent({ conversationId: id });
  assert.deepEqual(plain(result.identity), workspaceTitleIdentity);
  assert.equal(result.current.title, "Original");
  assert.equal(result.catalogAccountKey, "not-workspace", "the directory account remains a separate projection");
  assert.equal(h.calls[1].init.headers["ChatGPT-Account-ID"], workspaceOwnerKey);
  assert.equal(h.calls[1].init.headers["chatgpt-project-id"], projectId);
  assert.equal(h.calls.length, 3, "auth, metadata and final auth; no extra ownership lookup");
  assert.equal(writes(h.calls).length, 0);
  assert.doesNotMatch(JSON.stringify(result), /user_id|__|gizmo|fixture-secret|Private body/);
});

test("exact bare project owners remain valid in personal and explicit workspaces", async () => {
  for (const cookie of ["", "_account=" + workspaceOwnerKey]) {
    const h = workspaceProjectHarness({ cookie, native: projectNative });
    assert.equal((await h.adapter.readCurrent({ conversationId: id })).current.title, "Original");
  }
});

test("workspace-scoped owners allow one confirmed rename and the same batch metadata preflight", async () => {
  for (const batch of [false, true]) {
    const h = workspaceProjectHarness();
    const batchScopeId = "scoped-owner-batch";
    if (batch) await h.adapter.beginBatchExecution({ conversationId: id, batchScopeId,
      identity: workspaceTitleIdentity, expectedCatalogAccountKey: "not-workspace" });
    h.calls.length = 0;
    const result = await h.adapter.writeCurrent(input({ identity: workspaceTitleIdentity,
      ...(batch ? { batchScopeId } : {}) }));
    assert.equal(result.status, batch ? "accepted" : "verified");
    assert.equal(writes(h.calls).length, 1);
    assert.equal(writes(h.calls)[0].init.headers["ChatGPT-Account-ID"], workspaceOwnerKey);
    assert.equal(writes(h.calls)[0].init.headers["chatgpt-project-id"], undefined);
    const metadata = h.calls.filter(({ url }) => url.startsWith("/backend-api/conversations/"));
    assert.equal(metadata.length, batch ? 1 : 2);
    assert.ok(metadata.every(({ init }) => init.headers["chatgpt-project-id"] === projectId));
    assert.doesNotMatch(JSON.stringify(result), /user_id|__|fixture-secret|Private body/);
  }
});

test("scoped owner validation compares the full exact user and canonical workspace pair", async () => {
  const cases = [
    ["foreign user", workspaceOwnerKey, { user_id: "another-user__" + workspaceOwnerKey }],
    ["foreign workspace", workspaceOwnerKey, { user_id: identity.accountKey + "__" + otherWorkspaceOwnerKey }],
    ["user prefix", workspaceOwnerKey, { user_id: identity.accountKey + "0__" + workspaceOwnerKey }],
    ["appended suffix", workspaceOwnerKey, { user_id: scopedOwnerId + "-extra" }],
    ["case change", workspaceOwnerKey, { user_id: "USER-1__" + workspaceOwnerKey }],
    ["workspace case change", otherWorkspaceOwnerKey, { user_id: identity.accountKey + "__" + otherWorkspaceOwnerKey.toUpperCase() }],
    ["personal", "personal", { user_id: identity.accountKey + "__personal" }],
    ["personal with scoped owner", "personal", { user_id: scopedOwnerId }],
    ["non-UUID workspace", "workspace-one", { user_id: identity.accountKey + "__workspace-one" }],
    ["compact UUID", workspaceOwnerKey.replaceAll("-", ""), { user_id: identity.accountKey + "__" + workspaceOwnerKey.replaceAll("-", "") }],
    ["workspace whitespace", " " + workspaceOwnerKey, { user_id: identity.accountKey + "__ " + workspaceOwnerKey }],
  ];
  for (const [label, workspaceKey, owner] of cases) {
    const h = workspaceProjectHarness({ cookie: workspaceKey === "personal" ? "" : "_account=" + encodeURIComponent(workspaceKey), native: { owner } });
    await assert.rejects(h.adapter.readCurrent({ conversationId: id }), {
      tidyCode: "TITLE_UNAVAILABLE", httpStatus: 200, stage: "main-world.title.metadata.owner-match",
    }, label);
    assert.equal((await h.adapter.writeCurrent(input({ identity: { ...identity, workspaceKey } }))).status, "failed", label);
    assert.equal(writes(h.calls).length, 0, label);
  }
});

test("metadata rejection stages distinguish safe response checks without copying response values", async () => {
  const cases = [
    [{ conversation_id: "another-conversation" }, "conversation-id", "TITLE_UNAVAILABLE"],
    [{ title: null }, "title-shape", "TITLE_UNAVAILABLE"],
    [{ title: 12 }, "title-shape", "TITLE_UNAVAILABLE"],
    [{ gizmo_id: "g-p-other-project" }, "project-match", "TITLE_TARGET_CHANGED"],
    [{ is_read_only: true }, "read-only", "TITLE_UNAVAILABLE"],
    [{ is_temporary_chat: true }, "temporary", "TITLE_UNAVAILABLE"],
    [{ owner: {} }, "owner-shape", "TITLE_UNAVAILABLE"],
    [{ owner: { user_id: 17 } }, "owner-shape", "TITLE_UNAVAILABLE"],
    [{ owner: { user_id: "" } }, "owner-shape", "TITLE_UNAVAILABLE"],
    [{ owner: { user_id: "foreign-owner" } }, "owner-match", "TITLE_UNAVAILABLE"],
  ];
  for (const [native, suffix, tidyCode] of cases) {
    const h = workspaceProjectHarness({ native });
    await assert.rejects(h.adapter.readCurrent({ conversationId: id }), error => {
      assert.equal(error.tidyCode, tidyCode);
      assert.equal(error.httpStatus, 200);
      assert.equal(error.stage, "main-world.title.metadata." + suffix);
      assert.doesNotMatch(JSON.stringify(error), /another-conversation|g-p-other-project|foreign-owner|fixture-secret|Private body/);
      return true;
    });
    assert.equal((await h.adapter.writeCurrent(input({ identity: workspaceTitleIdentity }))).status, "failed");
    assert.equal(writes(h.calls).length, 0);
  }
});

test("metadata HTTP failures retain the fixed request stage and actual status", async () => {
  for (const status of [401, 403, 404, 429, 500, 503]) {
    const h = workspaceProjectHarness({ read: async () => ok({}, status) });
    await assert.rejects(h.adapter.readCurrent({ conversationId: id }), {
      tidyCode: status === 401 ? "TITLE_AUTH_REQUIRED" : status === 429 ? "TITLE_RATE_LIMITED" : "TITLE_UNAVAILABLE",
      httpStatus: status, stage: "main-world.title.metadata.http",
    });
    assert.equal(writes(h.calls).length, 0);
  }
});

test("scoped owner acceptance does not absorb workspace or signed-in user changes", async () => {
  for (const phase of ["metadata-workspace", "final-workspace", "final-user"]) {
    const h = workspaceProjectHarness({
      read: async ({ native, context }) => {
        if (phase === "metadata-workspace") context.document.cookie = "_account=" + otherWorkspaceOwnerKey;
        return ok(native);
      },
      session: async ({ context, sessionCalls }) => {
        if (phase === "final-workspace" && sessionCalls === 2) context.document.cookie = "_account=" + otherWorkspaceOwnerKey;
        return ok({ accessToken: "fixture-secret", activeAccountId: "not-workspace",
          user: { id: phase === "final-user" && sessionCalls === 2 ? "another-user" : identity.accountKey } });
      },
    });
    await assert.rejects(h.adapter.readCurrent({ conversationId: id }), { tidyCode: "TITLE_ACCOUNT_CHANGED" });
    assert.equal(writes(h.calls).length, 0);
  }
});

test("foreign scoped owner seen after a rename remains uncertain and never replays the POST", async () => {
  const h = workspaceProjectHarness({ post: async ({ native, init }) => {
    native.title = JSON.parse(init.body).title;
    native.owner = { user_id: identity.accountKey + "__" + otherWorkspaceOwnerKey };
    return ok({});
  } });
  const result = await h.adapter.writeCurrent(input({ identity: workspaceTitleIdentity }));
  assert.equal(result.status, "uncertain");
  assert.equal(result.messageCode, "readback_unavailable");
  assert.equal(result.current, null);
  assert.equal(writes(h.calls).length, 1);
});

test("current project reads use native metadata header and retain the minimal metadata projection", async () => {
  const h = harness({ url: `https://chatgpt.com${projectPath}`, native: projectNative });
  const result = await h.adapter.readCurrent({ conversationId: id });
  assert.equal(result.current.conversationId, id);
  assert.equal(h.calls[1].init.headers["chatgpt-project-id"], projectId);
  assert.equal(h.calls.length, 3);
  assert.doesNotMatch(JSON.stringify(result), /owner|gizmo|fixture-secret|user_id/);
});

test("named project URLs read and rename using the exact project ID, not its readable slug", async () => {
  const projectId = "g-p-0123456789abcdef0123456789abcdef";
  const pathname = `/g/${projectId}-my-project/c/${id}`;
  const h = harness({ url: `https://chatgpt.com${pathname}/`, native: { ...projectNative, gizmo_id: projectId } });
  const ownerContext = { conversationId: id, pathname, projectId };
  const read = await h.adapter.readCurrent({ conversationId: id, ownerContext, targetProjectId: projectId });
  assert.equal(read.current.title, "Original");
  assert.equal(h.calls.length, 3, "normalizing a project URL adds no request");
  assert.equal(h.calls[1].init.headers["chatgpt-project-id"], projectId);
  h.calls.length = 0;
  const result = await h.adapter.writeCurrent(input({ ownerContext, targetProjectId: projectId }));
  assert.equal(result.status, "verified");
  assert.equal(writes(h.calls).length, 1);
  assert.equal(writes(h.calls)[0].init.headers["chatgpt-project-id"], undefined);
  assert.equal(h.calls[1].init.headers["chatgpt-project-id"], projectId);
  assert.equal(h.calls[4].init.headers["chatgpt-project-id"], projectId);
  assert.equal(h.context.location.href, `https://chatgpt.com${pathname}/`, "the user's URL stays unchanged");
});

test("project slugs never hide a genuinely different project or an ID prefix collision", async () => {
  const projectId = "g-p-0123456789abcdef0123456789abcdef";
  for (const [segment, responseId] of [[`${projectId}-same-name`, "g-p-abcdef0123456789abcdef0123456789"],
    [`${projectId}0-same-name`, projectId]]) {
    const h = harness({ url: `https://chatgpt.com/g/${segment}/c/${id}`, native: { ...projectNative, gizmo_id: responseId } });
    await assert.rejects(h.adapter.readCurrent({ conversationId: id }), { tidyCode: "TITLE_TARGET_CHANGED" });
    assert.equal((await h.adapter.writeCurrent(input())).messageCode, "target_changed");
    assert.equal(writes(h.calls).length, 0);
  }
});

test("current project write keeps exact preflight, one generic POST and independent project readback", async () => {
  const h = harness({ url: `https://chatgpt.com${projectPath}/`, native: projectNative });
  const result = await h.adapter.writeCurrent(input({ targetProjectId: projectId,
    expectedCreatedAt: "2023-11-14T22:13:20.000Z", expectedUpdatedAt: "2023-11-14T22:13:21.000Z" }));
  assert.equal(result.status, "verified");
  assert.equal(h.calls.length, 6);
  assert.equal(h.calls[1].init.headers["chatgpt-project-id"], projectId);
  assert.equal(h.calls[4].init.headers["chatgpt-project-id"], projectId);
  assert.equal(writes(h.calls).length, 1);
  assert.equal(writes(h.calls)[0].init.headers["chatgpt-project-id"], undefined, "native rename call has no project header");
  assert.deepEqual(JSON.parse(writes(h.calls)[0].init.body), { title: input().after });
});

test("off-current batch ordinary target is read and renamed without touching or navigating its owner", async () => {
  const h = harness({ url: ownerUrl });
  const preview = await h.adapter.readCurrent({ conversationId: id, ownerContext });
  assert.equal(preview.current.conversationId, id);
  h.calls.length = 0;
  const result = await h.adapter.writeCurrent(input({ ownerContext }));
  assert.equal(result.status, "verified");
  assert.equal(h.context.location.href, ownerUrl);
  assert.equal(writes(h.calls)[0].url, `/backend-api/conversation/id/${id}/rename`);
  assert.equal(h.calls.filter(({ url }) => url.includes(ownerContext.conversationId)).length, 0);
});

test("batch target owns its project header, never inherits the owner project's header", async () => {
  const projectOwner = { ...ownerContext, projectId: "g-p-owner", pathname: "/g/g-p-owner/c/owner-conversation" };
  for (const target of [null, projectId]) {
    const h = harness({ url: `https://chatgpt.com${projectOwner.pathname}`, native: target ? projectNative : {} });
    const result = await h.adapter.writeCurrent(input({ ownerContext: projectOwner, targetProjectId: target }));
    assert.equal(result.status, "verified");
    assert.equal(h.calls[1].init.headers["chatgpt-project-id"], target || undefined);
    assert.equal(h.calls[4].init.headers["chatgpt-project-id"], target || undefined);
    assert.equal(h.context.location.href, `https://chatgpt.com${projectOwner.pathname}`);
  }
});

test("batch owner with a native trailing slash matches the worker's canonical ordinary or project path", async () => {
  for (const owner of [ownerContext,
    { ...ownerContext, projectId: "g-p-owner", pathname: "/g/g-p-owner/c/owner-conversation" }]) {
    const url = `https://chatgpt.com${owner.pathname}/`;
    const h = harness({ url });
    const preview = await h.adapter.readCurrent({ conversationId: id, ownerContext: owner });
    assert.equal(preview.current.conversationId, id);
    const result = await h.adapter.writeCurrent(input({ ownerContext: owner }));
    assert.equal(result.status, "verified");
    assert.equal(writes(h.calls).length, 1);
    assert.equal(h.context.location.href, url, "normalization must not navigate the user's tab");
    assert.equal(h.calls.some(({ url: requestUrl }) => requestUrl.includes(owner.conversationId)), false);
  }
});

test("off-current target requires explicit exact immutable owner binding before all I/O", async () => {
  for (const owner of [undefined, null, {}, { ...ownerContext, conversationId: id },
    { ...ownerContext, pathname: `${ownerContext.pathname}/` }, { ...ownerContext, projectId },
    { conversationId: ownerContext.conversationId, pathname: ownerContext.pathname }]) {
    const h = harness({ url: ownerUrl });
    await assert.rejects(h.adapter.readCurrent({ conversationId: id, ownerContext: owner }), { tidyCode: "CONTEXT_MISMATCH" });
    await assert.rejects(h.adapter.writeCurrent(input({ ownerContext: owner })), { tidyCode: "CONTEXT_MISMATCH" });
    assert.equal(h.calls.length, 0);
  }
});

test("invalid target ID and project associations never reach auth or metadata", async () => {
  for (const override of [{ conversationId: "../other" }, { conversationId: "WEB:draft" }, { conversationId: 7 },
    { targetProjectId: "g-custom" }, { targetProjectId: "project/1" }, { targetProjectId: 7 },
    { targetProjectId: "g-p-x\r\nInjected: true" }]) {
    const h = harness({ url: ownerUrl });
    await assert.rejects(h.adapter.writeCurrent(input({ ownerContext, ...override })), { tidyCode: "CONTEXT_MISMATCH" });
    assert.equal(h.calls.length, 0);
  }
  const project = harness({ url: `https://chatgpt.com${projectPath}`, native: projectNative });
  for (const targetProjectId of [null, "g-p-other"]) {
    await assert.rejects(project.adapter.writeCurrent(input({ targetProjectId })), { tidyCode: "CONTEXT_MISMATCH" });
  }
  assert.equal(project.calls.length, 0);
});

for (const native of [{ gizmo_id: "g-p-other", gizmo_type: "snorlax" },
  { gizmo_id: projectId, gizmo_type: "gpt" }, { gizmo_id: null, gizmo_type: null },
  { gizmo_id: null, gizmo_type: "snorlax" }]) {
  test(`project metadata must prove exact association (${JSON.stringify(native)})`, async () => {
    const h = harness({ url: `https://chatgpt.com${projectPath}`, native });
    await assert.rejects(h.adapter.readCurrent({ conversationId: id }), { tidyCode: "TITLE_TARGET_CHANGED" });
    const result = await h.adapter.writeCurrent(input());
    assert.equal(result.status, "failed");
    assert.equal(result.messageCode, "target_changed");
    assert.equal(writes(h.calls).length, 0);
  });
}

test("an expected ordinary batch target cannot silently become a project target", async () => {
  const h = harness({ url: ownerUrl, native: projectNative });
  await assert.rejects(h.adapter.readCurrent({ conversationId: id, ownerContext, targetProjectId: null }),
    { tidyCode: "TITLE_TARGET_CHANGED" });
  const result = await h.adapter.writeCurrent(input({ ownerContext, targetProjectId: null }));
  assert.equal(result.status, "failed");
  assert.equal(result.messageCode, "target_changed");
  assert.equal(writes(h.calls).length, 0);
});

test("a batch target moved out of a project fails only its target scope and leaves the owner untouched", async () => {
  const h = harness({ url: ownerUrl });
  await assert.rejects(h.adapter.readCurrent({ conversationId: id, ownerContext, targetProjectId: projectId }),
    { tidyCode: "TITLE_TARGET_CHANGED" });
  const result = await h.adapter.writeCurrent(input({ ownerContext, targetProjectId: projectId }));
  assert.equal(result.status, "failed");
  assert.equal(result.messageCode, "target_changed");
  assert.equal(h.context.location.href, ownerUrl);
  assert.equal(writes(h.calls).length, 0);
});

test("generic GPT metadata is not mistaken for a project association", async () => {
  const h = harness({ native: { gizmo_id: "g-custom", gizmo_type: "gpt" } });
  assert.equal((await h.adapter.readCurrent({ conversationId: id })).current.conversationId, id);
  assert.equal(h.calls[1].init.headers["chatgpt-project-id"], undefined);
});

for (const native of [{ is_read_only: true }, { is_temporary_chat: true },
  { owner: { user_id: "another-user", name: "Private owner" } }, { owner: {} }]) {
  test(`noneditable/foreign metadata prevents project POST (${Object.keys(native)[0]})`, async () => {
    const h = harness({ url: `https://chatgpt.com${projectPath}`, native: { ...projectNative, ...native } });
    await assert.rejects(h.adapter.readCurrent({ conversationId: id }), { tidyCode: "TITLE_UNAVAILABLE" });
    const result = await h.adapter.writeCurrent(input());
    assert.equal(result.status, "failed");
    assert.equal(writes(h.calls).length, 0);
    assert.doesNotMatch(JSON.stringify(result), /Private owner|another-user/);
  });
}

test("batch owner route change during target preflight blocks POST even if target is now open", async () => {
  const h = harness({ url: ownerUrl, read: async ({ native, context }) => {
    context.location.href = `https://chatgpt.com/c/${id}`;
    return ok(native);
  } });
  const result = await h.adapter.writeCurrent(input({ ownerContext }));
  assert.equal(result.status, "failed");
  assert.equal(result.messageCode, "context_changed");
  assert.equal(writes(h.calls).length, 0);
});

test("caller mutation cannot rebind the captured batch owner across an await", async () => {
  const owner = { ...ownerContext };
  const h = harness({ url: ownerUrl, read: async ({ native, context }) => {
    owner.conversationId = "new-owner";
    owner.pathname = "/c/new-owner";
    context.location.href = "https://chatgpt.com/c/new-owner";
    return ok(native);
  } });
  assert.equal((await h.adapter.writeCurrent(input({ ownerContext: owner }))).status, "failed");
  assert.equal(writes(h.calls).length, 0);
});

test("project move or owner navigation after batch dispatch stays uncertain with one POST", async () => {
  for (const change of ["project", "route", "workspace", "owner"]) {
    const h = harness({ url: ownerUrl, native: projectNative, post: async ({ native, context, init }) => {
      native.title = JSON.parse(init.body).title;
      if (change === "project") native.gizmo_id = "g-p-other";
      if (change === "route") context.location.href = "https://chatgpt.com/c/another-owner";
      if (change === "workspace") context.document.cookie = "_account=other";
      if (change === "owner") native.owner = { user_id: "other-user" };
      return ok({});
    } });
    const result = await h.adapter.writeCurrent(input({ ownerContext, targetProjectId: projectId }));
    assert.equal(result.status, "uncertain");
    assert.equal(result.current, null);
    assert.equal(writes(h.calls).length, 1);
  }
});

test("batch account changes before POST block it and after POST cannot produce verified", async () => {
  for (const switchedAt of [2, 3]) {
    const h = harness({ url: ownerUrl, session: async ({ sessionCalls }) =>
      ok({ accessToken: "fixture-secret", user: { id: sessionCalls < switchedAt ? "user-1" : "user-2" } }) });
    const result = await h.adapter.writeCurrent(input({ ownerContext }));
    assert.equal(result.status, switchedAt === 2 ? "failed" : "uncertain");
    assert.equal(writes(h.calls).length, switchedAt === 2 ? 0 : 1);
  }
});

test("two batch writes to the same target still have one writer lane", async () => {
  const h = harness({ url: ownerUrl });
  const results = await Promise.allSettled([
    h.adapter.writeCurrent(input({ ownerContext })), h.adapter.writeCurrent(input({ ownerContext })),
  ]);
  assert.equal(results[0].value.status, "verified");
  assert.equal(results[1].reason.tidyCode, "TITLE_BUSY");
  assert.equal(writes(h.calls).length, 1);
});

for (const where of ["session", "metadata"]) test(`title read identifies ${where} 429 as rate limiting, not sign-out or generic failure`, async () => {
  const h = harness(where === "session" ? { session: async () => ok(null, 429) } : { read: async () => ok(null, 429) });
  await assert.rejects(h.adapter.readCurrent({ conversationId: id }), error => error.tidyCode === "TITLE_RATE_LIMITED" && error.httpStatus === 429);
  assert.equal(writes(h.calls).length, 0);
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const sessionBody = { accessToken: "fixture-secret", user: { id: "user-1" }, activeAccountId: "not-workspace" };
const lifecycleError = error => error.tidyCode === "ADAPTER_UNAVAILABLE"
  && error.details?.stage === "page-session" && error.details?.disconnect === "context-invalidated";
const settleLateWork = () => new Promise(resolve => setImmediate(resolve));

// Ignore AbortSignal deliberately: lifecycle assertions must also fence cached
// responses and body readers that complete despite a browser cancellation.
function pauseResponse(phase, body, entered, release, bodyReads) {
  const response = { ...ok(body), json: async () => {
    bodyReads.count++;
    if (phase.endsWith("json")) {
      entered.resolve();
      await release.promise;
    }
    return body;
  } };
  if (phase.endsWith("fetch")) {
    entered.resolve();
    return release.promise.then(() => response);
  }
  return response;
}

test("a stopped title page rejects every public operation without network access", async () => {
  const h = harness();
  h.context.TidyPageSession.stop("extension-reloaded");
  await assert.rejects(h.adapter.readCurrent({ conversationId: id }), lifecycleError);
  await assert.rejects(h.adapter.writeCurrent(input()), lifecycleError);
  await assert.rejects(h.adapter.beginBatchExecution({ conversationId: id, batchScopeId: "batch-stop",
    identity, expectedCatalogAccountKey: "not-workspace" }), lifecycleError);
  assert.throws(() => h.adapter.endBatchExecution({ conversationId: id, batchScopeId: "batch-stop" }), lifecycleError);
  assert.equal(h.calls.length, 0);
});

for (const operation of ["read", "write"]) for (const phase of [
  "session-fetch", "session-json", "metadata-fetch", "metadata-json", "final-session-fetch", "final-session-json",
]) test(`stop during title ${operation} ${phase} aborts, settles, and prevents its next request`, async () => {
  const entered = deferred(), release = deferred(), bodyReads = { count: 0 }, timers = new Set();
  const pausedSession = phase.startsWith("final-") ? 2 : 1;
  const h = harness({
    setTimeout: (callback, delay) => { const timer = setTimeout(callback, delay); timers.add(timer); return timer; },
    clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); },
    session: ({ sessionCalls }) => phase.includes("session") && sessionCalls === pausedSession
      ? pauseResponse(phase, sessionBody, entered, release, bodyReads) : ok(sessionBody),
    read: ({ native }) => phase.startsWith("metadata")
      ? pauseResponse(phase, { ...native }, entered, release, bodyReads) : ok({ ...native }),
  });
  const pending = operation === "read" ? h.adapter.readCurrent({ conversationId: id }) : h.adapter.writeCurrent(input());
  await entered.promise;
  const count = h.calls.length;
  h.context.TidyPageSession.stop("extension-reloaded");
  assert.equal(h.calls.at(-1).init.signal.aborted, true);
  assert.equal(timers.size, 0, "disposal clears an outstanding deadline immediately");
  await assert.rejects(pending, lifecycleError);
  release.resolve();
  await settleLateWork();
  assert.equal(h.calls.length, count, "late fetch/body completion cannot start the next request");
  assert.equal(writes(h.calls).length, 0);
  assert.equal(bodyReads.count, phase.endsWith("fetch") ? 0 : 1, "a late fetch response is never parsed");
  assert.equal(timers.size, 0);
});

test("stopping pending batch authentication cannot establish or reuse a bearer lease", async () => {
  const entered = deferred(), release = deferred();
  const h = harness({ session: () => { entered.resolve(); return release.promise; } });
  const pending = h.adapter.beginBatchExecution({ conversationId: id, batchScopeId: "batch-stop",
    identity, expectedCatalogAccountKey: "not-workspace" });
  await entered.promise;
  h.context.TidyPageSession.stop("extension-reloaded");
  await assert.rejects(pending, lifecycleError);
  release.resolve(ok(sessionBody));
  await settleLateWork();
  await assert.rejects(h.adapter.writeCurrent(input({ batchScopeId: "batch-stop" })), lifecycleError);
  assert.equal(h.calls.length, 1);
});

for (const batch of [false, true]) for (const completion of ["success", "abort"])
  test(`stop during ${batch ? "batch" : "single"} rename stays uncertain after late ${completion} and skips readback`, async () => {
    const entered = deferred(), release = deferred();
    const h = harness({ post: () => { entered.resolve(); return release.promise; } });
    if (batch) await h.adapter.beginBatchExecution({ conversationId: id, batchScopeId: "batch-stop",
      identity, expectedCatalogAccountKey: "not-workspace" });
    const pending = h.adapter.writeCurrent(input(batch ? { batchScopeId: "batch-stop" } : {}));
    await entered.promise;
    const count = h.calls.length;
    h.context.TidyPageSession.stop("extension-reloaded");
    assert.equal(writes(h.calls)[0].init.signal.aborted, true);
    const result = await pending;
    assert.equal(result.status, "uncertain");
    assert.equal(result.current, null);
    assert.equal(result.accepted, undefined);
    assert.equal(result.catalogAccountKey, undefined);
    if (completion === "success") release.resolve(ok({}));
    else release.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await settleLateWork();
    assert.equal(h.calls.length, count, "aborted POST must never enter metadata/session readback");
    assert.equal(writes(h.calls).length, 1);
    await assert.rejects(h.adapter.writeCurrent(input(batch ? { batchScopeId: "batch-stop" } : {})), lifecycleError);
  });

for (const phase of ["metadata-fetch", "metadata-json", "final-session-fetch", "final-session-json"])
  test(`stop during rename readback ${phase} never reports verified`, async () => {
    const entered = deferred(), release = deferred(), bodyReads = { count: 0 };
    const h = harness({
      session: ({ sessionCalls }) => phase.includes("session") && sessionCalls === 3
        ? pauseResponse(phase, sessionBody, entered, release, bodyReads) : ok(sessionBody),
      read: ({ native, readCalls }) => phase.startsWith("metadata") && readCalls === 2
        ? pauseResponse(phase, { ...native }, entered, release, bodyReads) : ok({ ...native }),
    });
    const pending = h.adapter.writeCurrent(input());
    await entered.promise;
    const count = h.calls.length;
    h.context.TidyPageSession.stop("extension-reloaded");
    const result = await pending;
    assert.equal(result.status, "uncertain");
    assert.equal(result.current, null);
    assert.equal(result.catalogAccountKey, undefined);
    release.resolve();
    await settleLateWork();
    assert.equal(h.calls.length, count);
    assert.equal(writes(h.calls).length, 1);
  });

test("a timed-out title fetch cannot start reading its late response body", async () => {
  const release = deferred();
  let bodyReads = 0;
  const h = harness({ setTimeout: callback => setTimeout(callback, 5), session: () => release.promise });
  await assert.rejects(h.adapter.readCurrent({ conversationId: id }), { tidyCode: "ADAPTER_TIMEOUT" });
  assert.equal(h.calls[0].init.signal.aborted, true);
  release.resolve({ ...ok(sessionBody), json: async () => { bodyReads++; return sessionBody; } });
  await settleLateWork();
  assert.equal(bodyReads, 0);
  assert.equal(h.calls.length, 1);
});
