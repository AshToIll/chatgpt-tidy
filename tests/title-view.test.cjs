const { installRulesRuntime } = require("./helpers/title-rules.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { snapshotHarness } = require("./helpers/adapter-snapshot.cjs");
const { installPageSession } = require("./helpers/page-session.cjs");
const { createPanelRuntime } = require("./helpers/panel-runtime.cjs");

const source = (file) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise(setImmediate); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const preferences = { language: "zh-CN", timeZone: "Asia/Singapore", dateFormat: "iso", conversationTimeMode: "range" };
function snapshot(id = "one", title = "Original") {
  // Use the real main-world GET_SNAPSHOT producer. A handcrafted internal
  // route.parse() object once masked a production-wide eligibility failure.
  return snapshotHarness({
    url: `https://chatgpt.com/c/${id}`,
    sidebar: [{ href: `/c/${id}`, title, record: {
      id, title, create_time: Date.parse("2026-08-01T00:00:00.000Z") / 1000,
      update_time: Date.parse("2026-09-01T00:00:00.000Z") / 1000,
    } }],
  });
}
const current = (id = "one", title = "Original") => ({ conversationId: id, title,
  createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" });
const plan = (extra = {}) => ({ id: "plan-1", conversationId: "one", before: "Original", after: "[2026-08-01] Original",
  action: "assign", canApply: true, noOp: false, needsDecision: false, selectedDecision: "skip", hasDateHead: false, wouldEmpty: false, ...extra });
// Preview responses carry an opaque worker-owned metadata context. Tests may
// explicitly replace it with null/expired data to exercise refresh boundaries.
const previewContext = (extra = {}) => ({ id: "context-one", expiresAt: Date.now() + 300000, ...extra });
const result = (extra = {}) => ({ plan: null, operation: null, current: current(), previewContext: previewContext(), ...extra });
const receipt = (status = "verified", extra = {}) => ({ id: "plan-1", conversationId: "one", status,
  before: "Original", after: "[2026-08-01] Original", ...extra });

for (const status of ["conflict", "failed", "accepted", "verified"]) {
  test(`a fresh preview supersedes a historical ${status} receipt without replaying a write`, async () => {
    const local = deferred();
    const previous = receipt(status, { id: "previous-attempt", messageCode: "dates_changed", httpStatus: 429 });
    const h = harness({ request: action => action === "replan" ? local.promise
      : result({ plan: plan(), operation: previous }) });
    h.update(); await flush();
    const notice = () => h.root.innerHTML.match(/<p[^>]*data-title-notice[^>]*>[\s\S]*?<\/p>/)?.[0];
    assert.equal(h.view.state.operation, null, "the historical receipt is not this edit's operation");
    assert.match(notice(), / hidden/);
    assert.doesNotMatch(actionMarkup(h.root, "apply"), /disabled/);
    h.change("dateFormat", "dot"); await flush();
    assert.match(notice(), / hidden/, "a pending local replan must not resurrect an old receipt");
    local.resolve(result({ plan: plan({ id: "next-plan" }), operation: previous })); await flush();
    assert.match(notice(), / hidden/);
    assert.deepEqual(h.calls.map(call => call.action), ["preview", "replan"]);
    assert.equal(previous.status, status, "presentation does not mutate the persisted receipt");
  });
}

for (const [messageCode, phrase] of [["dates_changed", "日期"], ["title_conflict", "标题"],
  ["title_changed_externally", "标题"]]) {
  test(`a current ${messageCode} receipt reports its own cause until a new preview succeeds`, async () => {
    let previews = 0;
    const h = harness({ request: action => {
      if (action === "preview") {
        if (++previews === 2) throw Object.assign(new Error("offline"), { code: "NETWORK" });
        return result({ plan: plan({ id: `plan-${previews}` }) });
      }
      return result({ operation: receipt("conflict", { messageCode }) });
    } });
    h.update(); await flush(); h.click("apply"); await flush();
    const text = h.root.innerHTML.match(/<p[^>]*data-title-notice[^>]*>([\s\S]*?)<\/p>/)?.[1];
    assert.match(text, new RegExp(phrase));
    if (messageCode === "dates_changed") assert.doesNotMatch(text, /标题/);
    assert.equal(actionMarkup(h.root, "apply"), "");
    h.click("preview"); await flush();
    assert.ok(!actionMarkup(h.root, "apply") || /disabled/.test(actionMarkup(h.root, "apply")),
      "a failed new read may retain a disabled draft, never write authority");
    assert.equal(h.view.state.plan, null);
    assert.equal(h.calls.filter(call => call.action === "apply").length, 1);
    h.click("preview"); await flush();
    assert.match(h.root.innerHTML.match(/<p[^>]*data-title-notice[^>]*>/)?.[0], / hidden/);
  });
}

test("context and malformed response errors do not claim the title changed", async () => {
  for (const code of ["CONTEXT_MISMATCH", "TITLE_INVALID_RESPONSE"]) {
    const h = harness({ request: () => { throw Object.assign(new Error("fixture"), { code }); } });
    h.update(); await flush();
    const text = h.root.innerHTML.match(/<p[^>]*data-title-notice[^>]*>([\s\S]*?)<\/p>/)?.[1];
    assert.doesNotMatch(text, /标题.*变化/);
    assert.equal(actionMarkup(h.root, "apply"), "");
  }
});

for (const status of ["pending", "uncertain"]) {
  test(`a ${status} receipt cannot be hidden by an accompanying fresh-looking plan`, async () => {
    const h = harness({ request: () => result({ plan: plan(), operation: receipt(status, { id: "unknown-write" }) }) });
    h.update(); await flush();
    assert.equal(h.view.state.operation.status, status);
    assert.match(h.root.innerHTML, /data-title-action="reconcile"/);
    h.dispatch("apply"); h.dispatch("preview"); h.change("dateFormat", "dot"); await flush();
    assert.equal(h.calls.length, 1, "an unknown write must be reconciled, not superseded by a preview");
  });
}

function harness({ request = async () => result(), stored = null, getStorage = null, ownerTabId = 7, onChanged, rulesController } = {}) {
  const calls = [], saved = [], listeners = new Map();
  const root = {
    innerHTML: "", attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); },
    contains(target) { return target?.owner === root; },
  };
  // Load the complete production dependency graph. The only transform exposes
  // private state/DOM patching for assertions; it does not replace behavior.
  const runtime = createPanelRuntime({ navigator: { language: "zh-CN" }, chrome: { storage: { local: {
    get: getStorage || (async (key) => ({ [key]: stored })), set: async (value) => saved.push(plain(value)),
  } } } }, { transforms: {
    "src/features/titles/ui/title-view.js": value => value
      .replace("return Object.freeze({ update, dispose()", "return Object.freeze({ update, state, dispose()")
      + "\nglobalThis.patchTitleNode = patchTitleNode;\n",
  } });
  const context = runtime.context;
  Object.assign(context, runtime.load("src/messages/i18n.js"));
  runtime.load("src/platform/time-format.js");
  runtime.load("src/features/titles/model/title-dates.js");
  installRulesRuntime(context, preferences);
  Object.assign(context, runtime.load("src/features/titles/ui/title-view.js"));
  const controller = rulesController || context.getTitleRulesController();
  const view = context.createTitleView({ root, ownerTabId, onChanged, rulesController: controller, request: async (action, payload) => {
    calls.push({ action, payload: plain(payload) });
    return request(action, payload);
  } });
  let options = { snapshot: snapshot(), preferences, active: true, translator: context.createTranslator("zh-CN") };
  function update(patch = {}) { options = { ...options, ...patch }; view.update(options); }
  function node(dataset, value, disabled = false) { return { owner: root, dataset, value, disabled,
    closest(selector) {
      const key = selector.slice(6, -1).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return Object.hasOwn(dataset, key) ? this : null;
    },
  }; }
  function click(action) {
    const markup = root.innerHTML.match(new RegExp(`<button[^>]*data-title-action="${action}"[^>]*>`))?.[0];
    assert.ok(markup, `Expected action ${action} in ${root.innerHTML}`);
    dispatch(action, /\sdisabled(?:\s|>)/.test(markup));
  }
  // Exercise handler guards with an old/queued event even after its action is
  // absent from the current markup; visibility is not a write-safety boundary.
  function dispatch(action, disabled = false) {
    listeners.get("click")?.({ target: node({ titleAction: action }, null, disabled) });
  }
  function change(field, value) { listeners.get("change")?.({ target: node({ titleRule: field }, value) }); }
  function decide(value) { listeners.get("change")?.({ target: node({ titleDecision: "" }, value) }); }
  return { view, root, calls, saved, update, click, dispatch, change, decide, context, runtime, rulesController: controller };
}

test('known unsent apply errors offer explicit preview instead of quarantine or automatic retry', async () => {
  const h = harness({ request: (action, payload) => {
    if (action === 'apply') throw Object.assign(new Error('private disk diagnostic'), { code: 'TITLE_NOT_DISPATCHED' });
    return result({ plan: plan({ id: `plan-${h.calls.length}` }) });
  } });
  h.update(); await flush(); h.click('apply'); await flush();
  assert.equal(h.view.state.recoveryNeeded, false);
  assert.match(h.root.innerHTML, /修改未提交/); assert.match(h.root.innerHTML, /重新读取/);
  assert.equal(actionMarkup(h.root, 'reconcile'), ''); assert.match(actionMarkup(h.root, 'apply'), / disabled/);
  assert.doesNotMatch(h.root.innerHTML, /private disk diagnostic/);
  assert.deepEqual(h.calls.map(call => call.action), ['preview', 'apply']);
  h.click('preview'); await flush();
  assert.equal(h.view.state.plan.id, 'plan-3');
  assert.equal(h.calls.filter(call => call.action === 'apply').length, 1, 'a preview does not repeat the write');
});

for (const language of ['zh-CN', 'zh-TW', 'en', 'ja']) test(`${language}: an unchanged recovery read allows review without claiming success or resending`, async () => {
  const target = '<img src=x onerror=bad> target';
  const h = harness({ request: action => result({ current: current('one', '<original>'), operation: receipt(action === 'reconcile' ? 'conflict' : 'uncertain', {
    after: target, messageCode: action === 'reconcile' ? 'title_unchanged' : 'title_interrupted',
  }) }) });
  const t = h.context.createTranslator(language);
  h.update({ translator: t }); await flush();
  assert.match(h.root.innerHTML, /data-title-recovery/);
  assert.ok(h.root.innerHTML.includes(t('titlesRecoveryTarget')) && h.root.innerHTML.includes(t('titlesRecoveryObserved')));
  assert.match(h.root.innerHTML, /&lt;img/); assert.doesNotMatch(h.root.innerHTML, /<img/);
  h.click('reconcile'); await flush();
  assert.ok(h.root.innerHTML.includes(t('titlesUnchanged')));
  assert.ok(actionMarkup(h.root, 'preview')); assert.equal(actionMarkup(h.root, 'apply'), '');
  assert.doesNotMatch(h.root.innerHTML, /data-title-recovery/);
  h.dispatch('apply'); await flush();
  assert.deepEqual(h.calls.map(call => call.action), ['preview', 'reconcile']);
});

test('a matching unsent receipt clears quarantine but never consumes the previous confirmation', async () => {
  let checked = false;
  const h = harness({ request: action => {
    if (action === 'reconcile') checked = true;
    return result({ operation: receipt(checked ? 'failed' : 'uncertain', {
      messageCode: checked ? 'title_not_dispatched' : 'title_interrupted',
    }) });
  } });
  h.update(); await flush(); h.click('reconcile'); await flush();
  assert.match(h.root.innerHTML, /修改未提交/); assert.equal(h.view.state.recoveryNeeded, false);
  assert.ok(actionMarkup(h.root, 'preview')); assert.equal(actionMarkup(h.root, 'apply'), '');
  assert.doesNotMatch(h.root.innerHTML, /data-title-recovery/);
  assert.equal(h.calls.filter(call => call.action === 'apply').length, 0);
});

test('single title format labels follow zoned today without changing source dates or triggering a read', async () => {
  const h = harness();
  const time = h.context.TidyTimeFormat;
  let now = new Date('2026-09-17T20:00:00Z');
  h.context.TidyTimeFormat = { ...time, dateFormatLabels: zone => time.dateFormatLabels(zone, now) };
  h.update(); await flush();
  assert.match(h.root.innerHTML, /<option value="iso" selected>2026-09-18<\/option>/);
  const currentBefore = plain(h.view.state.current), callsBefore = h.calls.length;
  now = new Date('2026-09-18T20:00:00Z');
  h.update(); await flush();
  assert.match(h.root.innerHTML, /<option value="iso" selected>2026-09-19<\/option>/);
  assert.equal(h.calls.length, callsBefore, 'a newer display date does not request metadata or replan');
  assert.deepEqual(plain(h.view.state.current), currentBefore);
  h.update({ preferences: { ...preferences, timeZone: 'America/Los_Angeles' } }); await flush();
  assert.match(h.root.innerHTML, /<option value="iso" selected>2026-09-18<\/option>/);
});

test("production route is enabled as titles only, with no legacy alias or active batch action", () => {
  const html = source("src/app/sidepanel/index.html"), panel = source("src/app/sidepanel/panel.js");
  assert.match(html, /href="\.\.\/\.\.\/features\/titles\/ui\/title\.css"/);
  assert.match(html, /data-view="titles"/);
  assert.match(html, /data-route="titles"[^>]*>/);
  assert.doesNotMatch(html.match(/<button[^>]*data-route="titles"[^>]*>/)[0], /disabled/);
  assert.doesNotMatch(html + panel, /title-time|titleTime/);
  // Protocol mapping belongs to the feature client, not the composition root.
  const runtime = createPanelRuntime();
  runtime.load("src/platform/protocol.js");
  const requests = [];
  const clients = runtime.load("src/app/sidepanel/feature-clients.js").createFeatureClients({
    ownerTabId: 7, protocol: runtime.context.TidyProtocol,
    request: (type, payload) => requests.push({ type, payload: plain(payload) }),
  });
  assert.doesNotMatch(panel + source("src/app/sidepanel/feature-clients.js"), /TITLE_UNDO_PREVIEW/);
  clients.titles("reconcile", { expectedConversationId: "reviewed-owner", expectedTabId: 99 });
  assert.deepEqual(requests, [{ type: runtime.context.TidyProtocol.Type.TITLE_RECONCILE,
    payload: { expectedConversationId: "reviewed-owner", expectedTabId: 7 } }]);
  assert.throws(() => clients.titles("undo-preview", {}), /Unsupported feature operation/);
  assert.doesNotMatch(source("src/features/titles/ui/title-view.js"), /data-title-action="batch/);
});

test("first entry previews read-only, seeds separate rules, and binds the immutable plan to its owner", async () => {
  const h = harness({ request: async (action) => action === "preview" ? result({ plan: plan() }) : result() });
  h.update(); await flush();
  assert.deepEqual(h.calls.map((call) => call.action), ["preview"]);
  assert.deepEqual(plain(h.view.state.rules), { mode: "created", dateFormat: "iso" });
  assert.deepEqual(h.calls.at(-1), { action: "preview", payload: { expectedTabId: 7, expectedConversationId: "one",
    operation: "assign", decision: "skip", rules: { mode: "created", dateFormat: "iso", timeZone: "Asia/Singapore", locale: "zh-CN" } } });
  assert.match(h.root.innerHTML, /data-title-action="apply"/);
  assert.match(h.root.innerHTML, /修改前/);
  assert.equal(h.calls.filter((call) => call.action === "apply").length, 0);
});

for (const phase of ["startup", "metadata"]) test(`real title startup pipeline: ${phase} workspace transition`, async () => {
  const http = [], records = new Map();
  let sessionCalls = 0, metadataCalls = 0, serial = 0;
  const native = { conversation_id: "one", title: "Original", create_time: Date.parse(current().createdAt) / 1000,
    update_time: Date.parse(current().updatedAt) / 1000 };
  // Only the browser transport and storage are fixtures. Authentication,
  // immutable plan creation and the actual Chinese notice use production code.
  const core = vm.createContext({ Date, URL, AbortController, setTimeout, clearTimeout,
    location: { href: "https://chatgpt.com/c/one", origin: "https://chatgpt.com" }, document: { cookie: "" },
    fetch: async (url, init) => {
      http.push({ url, method: init.method });
      assert.notEqual(init.method, "POST", "opening or recovering a preview never writes");
      if (url === "/api/auth/session") {
        if (++sessionCalls === 1) core.document.cookie = "_account=workspace-ready";
        return { ok: true, status: 200, json: async () => ({ accessToken: "fixture-secret", user: { id: "user-1" } }) };
      }
      if (++metadataCalls === 1 && phase === "metadata") core.document.cookie = "_account=workspace-other";
      return { ok: true, status: 200, json: async () => native };
    },
  });
  installPageSession(core);
  vm.runInContext(source("src/platform/snapshot.js"), core);
  for (const file of ["src/platform/chatgpt/api.js", "src/platform/chatgpt/route.js", "src/features/titles/chatgpt/titles.js"]) vm.runInContext(source(file), core);
  vm.runInContext(source("src/features/titles/background/title-service.js").replace(/^import[^;]+;\r?\n/gm, "").replace(/^export /gm, ""), core);
  const service = core.createTitleService({
    read: (target, options) => core.TidyChatgptTitles.readCurrent({ ...options, conversationId: target.conversationId }),
    write: async () => assert.fail("preview must not invoke the writer"),
    storage: { get: async (key) => records.get(key), set: async (key, value) => records.set(key, plain(value)) },
    model: require("../src/features/titles/model/title-dates.js"), createId: () => `startup-${++serial}`,
  });
  const h = harness({ request: async (action, payload) => {
    try { return await service.handle(action, { tabId: 7, conversationId: payload.expectedConversationId }, payload); }
    catch (error) { throw Object.assign(error, { code: error.code || error.tidyCode }); }
  } });
  h.update(); await flush();
  if (phase === "metadata") {
    assert.equal(h.view.state.error, "titlesAccountChanged");
    assert.match(h.root.innerHTML, /账号或工作区已变/);
    assert.equal(http.length, 2);
    for (let i = 0; i < 10; i++) h.update();
    await flush();
    assert.equal(http.length, 2, "a real bound-workspace failure remains stopped, not automatically retried");
    h.click("preview"); await flush();
  }
  assert.equal(h.view.state.error, "");
  assert.match(h.root.innerHTML, /data-title-action="apply"/);
  assert.doesNotMatch(h.root.innerHTML, /账号或工作区已变|fixture-secret/);
  assert.equal(http.length, phase === "startup" ? 3 : 5);
  assert.equal(h.calls.filter(call => call.action === "apply").length, 0);
});

test("a preview's readback snapshot cannot cancel its own pending plan response", async () => {
  const read = deferred();
  const h = harness({ request: async () => read.promise });
  h.update(); await flush();
  assert.equal(h.view.state.busy, "preview");
  const generation = h.view.state.generation;
  const observed = { ...current("one", "Canonical title"), updatedAt: "2026-09-08T01:00:00.000Z" };
  const next = snapshot("one", observed.title);
  next.conversation.updatedAt.value = observed.updatedAt;
  // The main-world bridge publishes authenticated metadata before resolving
  // the same request with the worker's stored immutable plan.
  h.update({ snapshot: next });
  assert.equal(h.view.state.busy, "preview");
  assert.equal(h.view.state.generation, generation);
  const prepared = plan({ id: "canonical-plan", before: observed.title, after: "[2026-08-01] Canonical title" });
  read.resolve(result({ current: observed, plan: prepared })); await flush();
  assert.equal(h.view.state.plan.id, "canonical-plan");
  assert.equal(h.view.state.current.title, observed.title);
  assert.equal(h.view.state.busy, null);
  assert.match(h.root.innerHTML, /data-title-action="apply"/);
  assert.deepEqual(h.calls.map((call) => call.action), ["preview"]);
});

test("real GET_SNAPSHOT fields render the current title without internal route properties", async () => {
  const h = harness({ request: async () => result({ current: current("one", "确认工具可用") }) });
  const native = snapshot("one", "确认工具可用");
  assert.equal(h.context.TidySnapshot.validate(native).valid, true);
  assert.deepEqual(Object.keys(native.route).sort(), ["href", "kind", "pathname", "source", "status"]);
  h.update({ snapshot: native });
  await flush();
  assert.equal(h.view.state.conversationId, "one");
  assert.deepEqual(h.calls.map((call) => call.action), ["preview"]);
  assert.match(h.root.innerHTML, /data-title-action="preview"/);
  assert.match(h.root.innerHTML, /确认工具可用/);
  assert.doesNotMatch(h.root.innerHTML, /请打开一个稳定的普通会话/);
});

test("date mode has only created and range, with no persisted or dispatched range-style switch", async () => {
  const h = harness({ stored: { mode: "range", dateFormat: "iso", rangeStyle: "full" },
    request: async () => result({ plan: plan() }) });
  h.update(); await flush();
  const select = h.root.innerHTML.match(/<select[^>]*data-title-rule="mode"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...select.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]),
    [["created", "创建日期"], ["range", "范围日期"]]);
  assert.match(select, /value="range" selected/);
  assert.equal(Object.hasOwn(h.view.state.rules, "rangeStyle"), false);
  assert.doesNotMatch(h.root.innerHTML, /范围日期 [SF]/);
  h.change("mode", "created"); await flush();
  assert.equal(h.calls.at(-1).payload.rules.mode, "created");
  h.change("mode", "range"); await flush();
  assert.equal(h.calls.at(-1).payload.rules.mode, "range");
  const count = h.calls.length;
  h.change("mode", "range-full"); await flush();
  assert.equal(h.calls.length, count, "removed mode cannot create another plan");
  assert.ok(h.calls.every((call) => !Object.hasOwn(call.payload.rules, "rangeStyle")));
  assert.ok(h.saved.every((entry) => !Object.hasOwn(entry["tidy.titles.rules.v1"], "rangeStyle")));
});

test("an ordinary route with one trailing slash stays eligible like the worker and writer", async () => {
  const h = harness(), native = snapshot();
  native.route.pathname += "/";
  native.route.href += "/";
  h.update({ snapshot: native }); await flush();
  assert.deepEqual(h.calls.map((call) => call.action), ["preview"]);
});

test("apply submits planId only; double-confirm and rule changes cannot duplicate the in-flight write", async () => {
  const write = deferred(); let changed = 0;
  const h = harness({ onChanged: () => { changed += 1; }, request: async (action) => {
    if (action === "preview") return result({ plan: plan() });
    if (action === "apply") return write.promise;
    return result();
  } });
  h.update(); await flush(); h.click("apply");
  h.click("apply"); h.change("dateFormat", "compact");
  assert.equal(h.view.state.rules.dateFormat, "iso");
  assert.deepEqual(h.calls.at(-1), { action: "apply", payload: { expectedTabId: 7, expectedConversationId: "one", planId: "plan-1" } });
  assert.equal(h.calls.filter((call) => call.action === "apply").length, 1);
  write.resolve(result({ operation: receipt(), current: current("one", plan().after) })); await flush();
  assert.equal(changed, 1);
  assert.match(h.root.innerHTML, /已保存/);
  assert.doesNotMatch(h.root.innerHTML, /网页侧栏未更新时|请手动刷新/);
  assert.doesNotMatch(h.root.innerHTML, /<p[^>]*>.*网页侧栏/);
  assert.equal(h.view.state.plan, null);
  assert.equal(Object.hasOwn(h.view.state, "canUndo"), false);
});

test("remove is a local preview followed by explicit confirmation, never a direct write", async () => {
  const h = harness({ request: async (action, payload) => {
    if (["preview", "replan"].includes(action)) return result({ plan: plan({ id: "remove-1", action: payload.operation, hasDateHead: true }) });
    if (action === "apply") return result({ operation: receipt("verified", { id: "remove-1" }) });
    return result({ operation: receipt() });
  } });
  h.update(); await flush(); h.click("remove"); await flush();
  assert.equal(h.calls.at(-1).action, "replan"); assert.equal(h.calls.at(-1).payload.operation, "remove");
  assert.equal(h.calls.filter((call) => call.action === "apply").length, 0);
  assert.doesNotMatch(h.root.innerHTML, /data-title-decision/);
  assert.match(h.root.innerHTML, /确认移除日期/);
  assert.doesNotMatch(h.root.innerHTML, /撤销|undo/);
  assert.equal(h.calls.filter((call) => call.action === "apply").length, 0);
  h.click("apply"); await flush();
  assert.equal(h.calls.at(-1).payload.planId, "remove-1");
  assert.match(h.root.innerHTML, /已保存/);
});

test("existing date decisions reuse the frozen context and replace only the immutable planId", async () => {
  const h = harness({ request: async (action, payload) => ["preview", "replan"].includes(action)
    ? result({ plan: plan({ id: `decision-${payload.decision}`, hasDateHead: true, needsDecision: true,
      canApply: payload.decision !== "skip", noOp: payload.decision === "skip", selectedDecision: payload.decision }) }) : result() });
  h.update(); await flush();
  assert.match(h.root.innerHTML, /标题日期与当前规则冲突/); assert.equal(h.view.state.plan.canApply, false);
  h.decide("replace"); await flush(); assert.equal(h.view.state.plan.id, "decision-replace");
  h.decide("stack"); await flush(); assert.equal(h.view.state.plan.id, "decision-stack");
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "replan", "replan"]);
  assert.deepEqual(h.calls.filter((call) => call.action === "replan").map((call) => call.payload.decision), ["replace", "stack"]);
  assert.ok(h.calls.filter((call) => call.action === "replan").every((call) => call.payload.previewContextId === "context-one"));
  assert.equal(h.calls.filter((call) => call.action === "apply").length, 0);
});

test("lost apply response exposes reconciliation only, never retries the mutation", async () => {
  const h = harness({ request: async (action) => {
    if (action === "preview") return result({ plan: plan() });
    if (action === "apply") throw Object.assign(new Error("secret token in a server error"), { code: "ADAPTER_TIMEOUT" });
    if (action === "reconcile") return result({ operation: receipt() });
    return result();
  } });
  h.update(); await flush(); h.click("apply"); await flush();
  assert.equal(h.view.state.recoveryNeeded, true);
  assert.match(h.root.innerHTML, /data-title-action="reconcile"/);
  assert.doesNotMatch(h.root.innerHTML, /data-title-action="apply"|secret token/);
  assert.doesNotMatch(h.root.innerHTML, /data-title-action="remove"/);
  h.change("dateFormat", "dot"); assert.equal(h.calls.at(-1).action, "apply");
  h.click("reconcile"); await flush();
  assert.equal(h.calls.filter((call) => call.action === "apply").length, 1);
  assert.equal(h.view.state.recoveryNeeded, false);
  assert.match(h.root.innerHTML, /已保存/);
});

test("a reconcile readback snapshot preserves the pending receipt and does not replay a write", async () => {
  const read = deferred(); let changed = 0;
  const h = harness({ onChanged: () => { changed += 1; }, request: async (action) => {
    if (action === "preview") return result({ plan: plan() });
    if (action === "apply") throw new Error("Lost response");
    if (action === "reconcile") return read.promise;
    return result();
  } });
  h.update(); await flush(); h.click("apply"); await flush();
  h.click("reconcile");
  assert.equal(h.view.state.busy, "reconcile");
  const generation = h.view.state.generation;
  const observed = { ...current("one", plan().after), updatedAt: "2026-09-08T01:00:00.000Z" };
  const next = snapshot("one", observed.title);
  next.conversation.updatedAt.value = observed.updatedAt;
  h.update({ snapshot: next });
  assert.equal(h.view.state.busy, "reconcile");
  assert.equal(h.view.state.generation, generation);
  assert.equal(h.view.state.recoveryNeeded, true);
  assert.doesNotMatch(h.root.innerHTML, /已保存/);
  read.resolve(result({ current: observed, operation: receipt() })); await flush();
  assert.equal(h.view.state.busy, null);
  assert.equal(h.view.state.recoveryNeeded, false);
  assert.equal(h.view.state.operation.status, "verified");
  assert.equal(h.view.state.current.title, observed.title);
  assert.match(h.root.innerHTML, /已保存/);
  assert.equal(changed, 1);
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "apply", "reconcile"]);
});

test("an older receipt cannot claim the latest save succeeded but a fresh read releases recovery", async () => {
  const h = harness({ request: async (action) => {
    if (action === "preview") return result({ plan: plan({ id: "latest-attempt" }) });
    if (action === "apply") throw new Error("Lost bridge response");
    return result({ operation: receipt("verified", { id: "older-attempt" }) });
  } });
  h.update(); await flush(); h.click("apply"); await flush();
  h.click("reconcile"); await flush();
  assert.equal(h.view.state.recoveryNeeded, false);
  assert.equal(Object.hasOwn(h.view.state, "canUndo"), false);
  assert.match(h.root.innerHTML, /已核对/);
  assert.ok(actionMarkup(h.root, "preview"));
  assert.doesNotMatch(h.root.innerHTML, /data-title-action="apply"|已保存/);
  assert.equal(h.calls.filter((call) => call.action === "apply").length, 1);
});

for (const operation of [null, receipt(), receipt("verified", { id: "older-attempt" })]) {
  test(`recovery without an actual read stays locked even with receipt ${operation?.id || "missing"}`, async () => {
    const h = harness({ request: async (action) => {
      if (action === "preview") return result({ plan: plan() });
      if (action === "apply") throw new Error("Lost reply");
      return result({ current: null, operation });
    } });
    h.update(); await flush(); h.click("apply"); await flush(); h.click("reconcile"); await flush();
    assert.equal(h.view.state.recoveryNeeded, true);
    assert.equal(h.view.state.statusReady, false);
    assert.ok(actionMarkup(h.root, "reconcile"));
    assert.equal(actionMarkup(h.root, "apply"), "");
    assert.doesNotMatch(h.root.innerHTML, /已保存/);
  });
}

for (const observed of ["unchanged", "manual", "target"]) {
  test(`real core and view recover a lost reply from ${observed} title without replay`, async () => {
    const core = vm.createContext({});
    vm.runInContext(source("src/features/titles/background/title-service.js").replace(/^import[^;]+;\r?\n/gm, "").replace(/^export /gm, ""), core);
    const records = new Map(), reads = []; let actual = current(), writes = 0, ids = 0, offline = false;
    const service = core.createTitleService({ model: require("../src/features/titles/model/title-dates.js"), createId: () => `integration-${++ids}`,
      storage: { get: async key => records.get(key) ? plain(records.get(key)) : null,
        set: async (key, value) => records.set(key, plain(value)) },
      read: async (_context, options) => {
        reads.push(options?.identityOnly ? "identity" : "title");
        if (offline) throw Object.assign(new Error("offline"), { code: "NETWORK" });
        return { identity: { accountKey: "account-a", workspaceKey: "personal" }, current: options?.identityOnly ? null : plain(actual) };
      },
      write: async (_context, payload, beforeDispatch) => {
        await beforeDispatch(); writes++;
        if (observed === "target") actual.title = payload.after;
        throw new Error("Write reply missing");
      },
    });
    const h = harness({ request: async (action, payload) => {
      const response = await service.handle(action, { tabId: 7, conversationId: payload.expectedConversationId }, payload);
      if (action === "apply") throw new Error("Panel reply missing too");
      return response;
    } });
    h.update(); await flush(); const firstPlan = h.view.state.plan;
    h.click("apply"); await flush(); assert.equal(h.view.state.recoveryNeeded, true);
    if (observed === "manual") actual.title = "Manually renamed elsewhere";
    offline = true; h.click("reconcile"); await flush();
    assert.equal(h.view.state.recoveryNeeded, true); assert.equal(writes, 1);
    offline = false; h.click("reconcile"); await flush();
    assert.equal(h.view.state.recoveryNeeded, false); assert.equal(h.view.state.current.title, actual.title);
    assert.equal(h.view.state.operation.status, observed === "target" ? "verified" : "conflict");
    assert.equal(h.view.state.plan, null, "reading alone cannot restore old write authority");
    if (observed !== "target") assert.doesNotMatch(h.root.innerHTML, /已保存/);
    h.click("preview"); await flush();
    assert.equal(h.view.state.plan.before, actual.title); assert.notEqual(h.view.state.plan.id, firstPlan.id);
    assert.equal(writes, 1);
    assert.deepEqual(reads, ["title", "identity", "title", "title", "title"], "recovery adds only the requested reads");
    await assert.rejects(service.handle("apply", { tabId: 7, conversationId: "one" }, { planId: firstPlan.id }), { code: "TITLE_PREVIEW_REQUIRED" });
    assert.equal(writes, 1);
  });
}

test("a service-proven context mismatch needs explicit recovery, not an uncertain-write state or automatic retry", async () => {
  const h = harness({ request: async (action) => {
    if (action === "preview") return result({ plan: plan() });
    if (action === "apply") throw Object.assign(new Error("No write dispatched"), { code: "CONTEXT_MISMATCH" });
    return result();
  } });
  h.update(); await flush(); h.click("apply"); await flush();
  assert.equal(h.view.state.recoveryNeeded, false);
  assert.equal(h.view.state.submittedPlanId, null);
  assert.equal(h.view.state.plan, null);
  assert.doesNotMatch(h.root.innerHTML, /data-title-action="reconcile"|No write dispatched/);
  assert.match(h.root.innerHTML, /data-title-action="preview"/);
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "apply"]);
});

test("malformed or wrong-target apply responses are uncertain, not safe prewrite rejections", async () => {
  const h = harness({ request: async (action) => action === "preview" ? result({ plan: plan() })
    : action === "apply" ? result({ current: current("wrong"), operation: receipt() }) : result() });
  h.update(); await flush(); h.click("apply"); await flush();
  assert.equal(h.view.state.recoveryNeeded, true);
  assert.equal(h.view.state.submittedPlanId, "plan-1");
  assert.match(h.root.innerHTML, /data-title-action="reconcile"/);
  assert.doesNotMatch(h.root.innerHTML, /data-title-action="apply"/);
});

test("a retired completion status is not accepted as proof of a new write", async () => {
  const h = harness({ request: async (action) => action === "preview" ? result({ plan: plan() })
    : result({ operation: receipt("undone"), plan: plan({ id: "unproven-next-edit" }) }) });
  h.update(); await flush(); h.click("apply"); await flush();
  assert.equal(h.view.state.recoveryNeeded, true);
  assert.equal(h.view.state.plan, null);
  assert.equal(h.view.state.previewContext, null);
  assert.match(h.root.innerHTML, /data-title-action="reconcile"/);
  assert.doesNotMatch(h.root.innerHTML, /data-title-action="apply"|已保存|已恢复/);
  assert.equal(h.calls.filter((call) => call.action === "apply").length, 1);
});

test("inactive views do not read titles and storage initialization cannot outlive disposal", async () => {
  const storage = deferred();
  const h = harness({ getStorage: async () => storage.promise });
  h.update({ active: false }); await flush(); assert.equal(h.calls.length, 0);
  h.update({ active: true }); h.view.dispose();
  storage.resolve({}); await flush(); assert.equal(h.calls.length, 0);
});

for (const status of ["pending", "uncertain"]) {
  test(`${status} worker receipt after reopening blocks preview and new mutations`, async () => {
    const h = harness({ request: async () => result({ operation: receipt(status) }) });
    h.update(); await flush();
    assert.match(h.root.innerHTML, /data-title-action="reconcile"/);
    assert.doesNotMatch(h.root.innerHTML, /data-title-action="remove"/);
    assert.equal(actionMarkup(h.root, "preview"), "", "an unresolved write only offers reconciliation");
    assert.match(footerMarkup(h.root), /data-title-action="reconcile"/);
    assert.doesNotMatch(footerMarkup(h.root), /<footer\b[^>]*\bhidden/);
    h.dispatch("preview");
    assert.doesNotMatch(h.root.innerHTML, /undo|撤销/); h.change("dateFormat", "dot");
    assert.equal(h.calls.length, 1); assert.equal(h.view.state.rules.dateFormat, "iso");
  });
}

test("conversation switches quarantine late preview responses and read the newly bound conversation", async () => {
  const read = deferred();
  const h = harness({ request: async (action, payload) => action === "preview" ? read.promise
    : result({ current: current(payload.expectedConversationId) }) });
  h.update(); await flush();
  h.update({ snapshot: snapshot("one", "Readback title") });
  assert.equal(h.view.state.busy, "preview", "the same request's metadata remains pending");
  h.update({ snapshot: snapshot("two", "Other conversation") }); await flush();
  read.resolve(result({ plan: plan() })); await flush();
  assert.equal(h.view.state.conversationId, "two"); assert.equal(h.view.state.plan, null);
  assert.equal(h.calls.at(-1).payload.expectedConversationId, "two");
  assert.doesNotMatch(h.root.innerHTML, /data-title-action="apply"/);
});

test("UI-language changes preserve reviewed plan; rules, global zone and metadata changes invalidate it", async () => {
  const h = harness({ request: async (action) => ["preview", "replan"].includes(action) ? result({ plan: plan() }) : result() });
  h.update(); await flush();
  h.update({ preferences: { ...preferences, language: "en", dateFormat: "compact" }, translator: h.context.createTranslator("en") });
  assert.equal(h.view.state.plan.id, "plan-1"); assert.equal(h.view.state.rules.dateFormat, "iso");
  assert.match(h.root.innerHTML, /Before/);
  h.change("dateFormat", "dot"); assert.equal(h.view.state.plan, null); await flush();
  assert.deepEqual(h.saved.at(-1), { "tidy.titles.rules.v1": { mode: "created", dateFormat: "dot" } });
  assert.equal(h.view.state.plan.id, "plan-1");
  h.update({ preferences: { ...preferences, timeZone: "Asia/Tokyo" } });
  assert.equal(h.view.state.plan, null);
  await flush();
  const next = snapshot(); next.conversation.updatedAt.value = "2026-09-02T00:00:00.000Z";
  h.update({ snapshot: next }); assert.equal(h.view.state.plan, null);
});

test("time-zone changes discard an in-flight preview even if it resolves late", async () => {
  const oldRead = deferred(), newRead = deferred();
  const h = harness({ request: async (action, payload) => action === "preview"
    ? payload.rules.timeZone === "UTC" ? newRead.promise : oldRead.promise : result() });
  h.update(); await flush();
  h.update({ snapshot: snapshot("one", "Readback title"), preferences: { ...preferences, timeZone: "UTC" } });
  oldRead.resolve(result({ plan: plan({ id: "old-zone-plan" }) })); await flush();
  assert.equal(h.view.state.plan, null); assert.equal(h.view.state.busy, "preview");
  assert.doesNotMatch(h.root.innerHTML, /data-title-action="apply"/);
  newRead.resolve(result({ plan: plan({ id: "new-zone-plan" }) })); await flush();
  assert.equal(h.view.state.plan.id, "new-zone-plan"); assert.equal(h.view.state.busy, null);
  assert.deepEqual(h.calls.map((call) => call.payload.rules.timeZone), ["Asia/Singapore", "UTC"]);
});

test("hiding during a write does not cancel it, and re-entry never writes automatically", async () => {
  const write = deferred();
  const h = harness({ request: async (action) => action === "preview" ? result({ plan: plan() })
    : action === "apply" ? write.promise : result({ operation: receipt() }) });
  h.update(); await flush(); h.click("apply");
  h.update({ active: false });
  assert.equal(h.view.state.busy, "apply");
  write.resolve(result({ operation: receipt() })); await flush();
  assert.equal(h.view.state.operation.status, "verified");
  h.update({ active: true }); await flush();
  assert.equal(h.calls.filter((call) => call.action === "apply").length, 1);
  assert.equal(h.calls.at(-1).action, "preview");
});

test("the verified save's exact title and timestamps do not trigger an extra preview or rename loop", async () => {
  const saved = { ...current("one", plan().after), updatedAt: "2026-09-08T00:00:00.000Z" };
  const h = harness({ request: async (action) => action === "preview" ? result({ plan: plan() })
    : action === "apply" ? result({ operation: receipt(), current: saved,
      plan: plan({ id: "after-save", before: saved.title, hasDateHead: true, noOp: true, canApply: false }) }) : result() });
  h.update(); await flush(); h.click("apply"); await flush();
  const next = snapshot("one", plan().after); next.conversation.updatedAt.value = "2026-09-08T00:00:00.000Z";
  h.update({ snapshot: next }); await flush();
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "apply"]);
});

test("stored rules are isolated from later time-display defaults and never store conversation content", async () => {
  const h = harness({ stored: { mode: "created", dateFormat: "slash", rangeStyle: "full", title: "secret", conversationId: "old" } });
  h.update(); await flush();
  assert.deepEqual(plain(h.view.state.rules), { mode: "created", dateFormat: "slash" });
  h.change("mode", "range"); await flush();
  assert.deepEqual(h.saved, [{ "tidy.titles.rules.v1": { mode: "range", dateFormat: "slash" } }]);
  assert.doesNotMatch(JSON.stringify(h.saved), /secret|conversationId|Original/);
});

test("unbound, project, group, GPT, draft and mismatched routes never dispatch", async () => {
  const variants = [
    (s) => { s.conversation.bindingStatus = "route-only"; },
    (s) => { s.conversation.bindingStatus = "mismatch"; },
    (s) => { s.conversation.identityStatus = "draft"; },
    (s) => { s.conversation.project = { projectId: "project-1" }; },
    (s) => { s.route.kind = "project-conversation"; },
    (s) => { s.route.kind = "group"; },
    (s) => { s.route.pathname = "/g/custom-gpt/c/one"; },
    (s) => { s.route.pathname = "/c/two"; },
    (s) => { s.route.status = "unsupported"; },
    (s) => { s.schemaVersion = "invalid"; },
  ];
  for (const change of variants) {
    const h = harness(), next = snapshot(); change(next); h.update({ snapshot: next }); await flush();
    assert.equal(h.calls.length, 0); assert.doesNotMatch(h.root.innerHTML, /data-title-action/);
  }
  const h = harness({ ownerTabId: null }); h.update(); await flush(); assert.equal(h.calls.length, 0);
});

test("no-op and empty-result plans cannot render a confirm button", async () => {
  for (const extra of [{ noOp: true }, { wouldEmpty: true, after: "" }, { canApply: false }]) {
    const h = harness({ request: async (action) => action === "preview" ? result({ plan: plan(extra) }) : result() });
    h.update(); await flush();
    assert.doesNotMatch(h.root.innerHTML, /data-title-action="apply"/);
  }
});

test("HTML titles are escaped, wrong-target responses are rejected, and errors do not leak text", async () => {
  const h = harness({ request: async (action) => action === "preview"
    ? result({ plan: plan({ before: '<img src=x onerror="bad">', after: "<script>bad</script>" }) }) : result() });
  h.update(); await flush();
  assert.match(h.root.innerHTML, /&lt;img/); assert.doesNotMatch(h.root.innerHTML, /<script>|<img/);
  const bad = harness({ request: async () => result({ current: current("wrong") }) });
  bad.update(); await flush(); assert.equal(bad.view.state.statusReady, false); assert.match(bad.root.innerHTML, /读取失败/);
  const failed = harness({ request: async () => { throw Object.assign(new Error("private error"), { code: "TITLE_PREVIEW_REQUIRED" }); } });
  failed.update(); await flush(); assert.match(failed.root.innerHTML, /预览过期/); assert.doesNotMatch(failed.root.innerHTML, /private error/);
});

test("all title strings are available in Chinese, English and Japanese", () => {
  const h = harness();
  for (const language of ["zh-CN", "zh-TW", "en", "ja"]) {
    const t = h.context.createTranslator(language);
    const keys = new Set(source("src/features/titles/ui/title-view.js").match(/"titles[A-Za-z]+"/g).map((value) => value.slice(1, -1)));
    for (const key of keys) assert.notEqual(t(key), key, `${language}: ${key}`);
    assert.notEqual(t("titleOrganization"), "titleOrganization");
  }
  assert.doesNotMatch(source("src/messages/i18n.js"), /titlesUndo|titlesConfirmUndo|titlesRestoring/);
  assert.doesNotMatch(source("src/features/titles/ui/title-view.js"), /canUndo|undo-preview|titlesUndone/);
  assert.doesNotMatch(source("src/features/titles/ui/title.css"), /is-undo/);
});

test("happy path uses the approved compact prototype sequence with no explanatory paragraphs", async () => {
  const h = harness({ request: async () => result({ plan: plan() }) });
  h.update(); await flush();
  const html = h.root.innerHTML;
  const order = ["titles-scope", "titles-rule", "titles-status", "titles-preview-toolbar", "titles-preview-card", "titles-action-bar"];
  for (let i = 1; i < order.length; i += 1) assert.ok(html.indexOf(order[i - 1]) < html.indexOf(order[i]));
  assert.match(html, /<small>2026-08-01 08:00\u2009~\u200909-01 08:00<\/small>/);
  assert.equal((html.match(/<select /g) || []).length, 2);
  assert.match(html, /<h3>规则设置<\/h3>/);
  assert.match(html, /<h3>标题预览<\/h3>/);
  assert.doesNotMatch(html, /titles-mode-tabs|暂未启用/, "tabs belong to the parent view, not a disabled legacy placeholder");
  assert.match(html, /data-title-action="apply"[^>]*>确认添加日期<\/button>/);
  // The stable notice node stays hidden rather than shifting every following
  // control when a notice appears. It adds no visible explanatory paragraph.
  assert.doesNotMatch(html.replace(/<p\b[^>]*hidden[^>]*>[\s\S]*?<\/p>/g, ""), /<p\b|<h2\b|data-title-action="remove"|data-title-action="undo-preview"/);
  assert.doesNotMatch(previewToolbarMarkup(h.root), /data-title-action="preview"/);
  assert.doesNotMatch(footerMarkup(h.root), /data-title-action="preview"|data-title-action="remove"|data-title-action="back"/);
  assert.doesNotMatch(html, /全局时区|最后一条消息|修改真实标题|生成预览|修改预览|仅在 TIDY/);
});

test("scope range uses readback update_time and follows the batch date format and global zone", async () => {
  const h = harness({ request: async () => result({ plan: plan(), current: {
    ...current(), createdAt: "2026-08-01T23:30:00.000Z", updatedAt: "2026-09-01T23:30:00.000Z",
  } }) });
  h.update(); await flush();
  assert.equal(scopeRange(h), "2026-08-02 07:30\u2009~\u200909-02 07:30");
  h.change("dateFormat", "compact"); await flush();
  assert.equal(scopeRange(h), "20260802 07:30\u2009~\u20090902 07:30");
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "replan"]);
  h.update({ preferences: { ...preferences, timeZone: "UTC" } }); await flush();
  assert.equal(scopeRange(h), "20260801 23:30\u2009~\u20090901 23:30");
});

const scopeRange = (h) => h.root.innerHTML.match(/<section class="titles-scope">[\s\S]*?<small>(.*?)<\/small>/)?.[1];

// Exercise the real batch selection renderer beside the current view. Only
// transport is synthetic; both views share the actual preferences controller,
// title model and formatter so a second presentation implementation cannot drift.
function siblingBatch(h, metadata) {
  Object.assign(h.context, h.runtime.load("src/features/titles/ui/title-batch-view.js"));
  const root = { innerHTML: "", setAttribute() {}, addEventListener() {}, removeEventListener() {} };
  const view = h.context.createTitleBatchView({ root, ownerTabId: 7, rulesController: h.rulesController,
    request: async (action) => { assert.equal(action, "batch-status"); return { batchId: null }; },
    loadCatalog: async ({ onUpdate }) => {
      const data = { accountKey: "account-1", rows: [metadata], loading: false, partial: false };
      onUpdate(data); return data;
    },
  });
  let options = { snapshot: snapshot(), preferences, active: true, t: h.context.createTranslator("zh-CN") };
  return { view, update(patch = {}) { options = { ...options, ...patch }; view.update(options); },
    range: () => root.innerHTML.match(/data-batch-select="one"[\s\S]*?<small>(.*?)<\/small>/)?.[1] };
}

for (const [language, locale] of [["zh-CN", "zh-CN"], ["zh-TW", "zh-TW"], ["en", "en-US"], ["ja", "ja-JP"]]) {
  test(`${language}: current and batch range labels share formatting for complete and missing dates`, async () => {
    for (const [name, createdAt, updatedAt] of [
      ["same day", "2026-09-28T00:23:14.000Z", "2026-09-28T00:25:03.000Z"],
      ["same minute", "2026-09-28T00:23:14.000Z", "2026-09-28T00:23:59.000Z"],
      ["multiple days", "2026-09-27T00:23:14.000Z", "2026-09-28T00:25:03.000Z"],
      ["multiple years", "2025-09-28T00:23:14.000Z", "2026-09-28T00:25:03.000Z"],
      ["missing start", null, "2026-09-28T00:25:03.000Z"],
      ["missing end", "2026-09-28T00:23:14.000Z", null],
      ["missing both", null, null],
    ]) {
      const metadata = { ...current(), createdAt, updatedAt };
      const h = harness({ stored: { mode: "created", dateFormat: "locale" }, request: async () => result({ plan: plan(), current: metadata }) });
      h.context.navigator.language = locale;
      const batch = siblingBatch(h, metadata), translator = h.context.createTranslator(language);
      h.update({ translator }); batch.update({ t: translator }); await flush();
      for (const dateFormat of ["locale", "iso", "slash", "dot", "compact"]) {
        h.rulesController.update({ dateFormat }); await flush();
        const expected = h.context.TidyTimeFormat.formatRange(createdAt, updatedAt,
          { ...h.view.state.rules, timeZone: h.view.state.timeZone, locale }) || "";
        assert.equal(scopeRange(h), expected, `${name}, ${dateFormat}: current range`);
        assert.equal(batch.range(), expected, `${name}, ${dateFormat}: batch range`);
      }
      assert.ok(h.calls.every(call => ["preview", "replan"].includes(call.action)), "display changes never write titles");
      assert.deepEqual(plain(metadata), { ...current(), createdAt, updatedAt }, "rendering preserves source metadata");
      batch.view.dispose(); h.view.dispose();
    }
  });
}

test("scope range uses the snapshot before readback and does not fill missing readback dates from stale data", async () => {
  const pending = deferred();
  const h = harness({ stored: { mode: "created", dateFormat: "slash" }, request: () => pending.promise });
  h.update(); await flush();
  assert.equal(scopeRange(h), "2026/08/01 08:00\u2009~\u200909/01 08:00");
  pending.resolve(result({ plan: plan(), current: { ...current(), updatedAt: null } })); await flush();
  assert.equal(scopeRange(h), "", "a partial fresh readback must not borrow the old snapshot endpoint");
  assert.equal(h.view.state.current.updatedAt, null);
});

test("current and batch ranges respond alike to shared title modes, browser locale and timezone", async () => {
  const metadata = { ...current(), createdAt: "2026-09-28T15:30:00.000Z", updatedAt: "2026-09-28T16:45:00.000Z" };
  const h = harness({ stored: { mode: "created", dateFormat: "slash" }, request: async () => result({ plan: plan(), current: metadata }) });
  const batch = siblingBatch(h, metadata);
  h.update(); batch.update(); await flush();
  assert.equal(scopeRange(h), "2026/09/28 23:30\u2009~\u200909/29 00:45");
  assert.equal(batch.range(), scopeRange(h));
  for (const mode of ["range", "created"]) {
    h.change("mode", mode); await flush();
    assert.equal(scopeRange(h), "2026/09/28 23:30\u2009~\u200909/29 00:45", "title basis does not collapse metadata to one date");
    assert.equal(batch.range(), scopeRange(h));
  }
  h.context.navigator.language = "en-GB";
  const updatedPreferences = { ...preferences, timeZone: "UTC", conversationTimeMode: "updated", conversationTimePrecision: "date" };
  h.update({ preferences: updatedPreferences }); batch.update({ preferences: updatedPreferences }); await flush();
  h.change("dateFormat", "locale"); await flush();
  assert.equal(scopeRange(h), "28/09/2026 15:30\u2009~\u200916:45");
  assert.equal(batch.range(), scopeRange(h), "both use browser regional dates and default minutes, not sidebar display precision");
  assert.ok(h.calls.every(call => ["preview", "replan"].includes(call.action)));
  batch.view.dispose(); h.view.dispose();
});

test("remove copies the prototype's readable icon-and-text action without a duplicate reversal entry", async () => {
  const h = harness({ request: async () => result({ plan: plan({ hasDateHead: true }) }) });
  h.update(); await flush();
  for (const [action, label] of [["remove", "移除日期"]]) {
    const markup = h.root.innerHTML.match(new RegExp(`<button[^>]*data-title-action="${action}"[^>]*>[\\s\\S]*?<\\/button>`))[0];
    assert.match(markup, /aria-label=/);
    assert.match(markup, /<svg /);
    assert.match(markup, new RegExp(`<span>${label}</span>`));
  }
  assert.doesNotMatch(h.root.innerHTML, /undo|撤销/);
});

test("matching and missing-date plans stay compact and cannot offer a mutation", async () => {
  for (const [extra, label] of [
    [{ action: "noop", noOp: true, canApply: false }, "符合规则"],
    [{ action: "blocked", canApply: false, noOp: true, reason: "missing_updated_time" }, "缺少日期，请选创建日期"],
    [{ action: "blocked", canApply: false, noOp: true, reason: "empty_title" }, "标题为空，请先改名"],
    [{ action: "blocked", canApply: false, noOp: true, reason: "invalid_date_range" }, "日期异常，请选创建日期"],
  ]) {
    const h = harness({ request: async () => result({ plan: plan(extra) }) });
    h.update(); await flush();
    assert.match(h.root.innerHTML, new RegExp(label));
    assert.doesNotMatch(h.root.innerHTML, /data-title-action="apply"/);
    assert.doesNotMatch(h.root.innerHTML, /data-title-action="preview"/, "a valid non-writing plan is not a read failure");
    assert.match(previewToolbarMarkup(h.root), /<h3>标题预览<\/h3>/);
    assert.match(footerMarkup(h.root), /<footer\b[^>]*\bhidden/, "no empty action divider when nothing needs confirmation");
  }
});

// These interaction fixtures use the production pure model, not invented
// after-titles: the local draft and worker plan must describe the same edit.
function canonicalPreview(payload, observed = current(), id = "canonical-plan") {
  const model = require("../src/features/titles/model/title-dates.js");
  return result({ current: observed, plan: { ...model.plan(observed, payload.rules, {
    operation: payload.operation, decision: payload.decision,
  }), id } });
}

test("shared rules synchronously update the active draft and register only a local replacement plan", async () => {
  const replan = deferred();
  const h = harness({ request: async (action, payload) => action === "replan" ? replan.promise : canonicalPreview(payload) });
  h.update(); await flush();
  const original = h.view.state.plan;
  h.rulesController.update({ dateFormat: "dot" });
  assert.equal(h.view.state.rules.dateFormat, "dot");
  assert.equal(h.view.state.displayPlan.rules.dateFormat, "dot", "cross-mode preference changes render in the same turn");
  assert.equal(h.view.state.plan, null, "the old immutable plan cannot authorize the new draft");
  assert.equal(h.root.attributes["aria-busy"], "false");
  await flush();
  assert.deepEqual(h.calls.map(call => call.action), ["preview", "replan"]);
  assert.equal(h.calls[1].payload.previewContextId, "context-one");
  replan.resolve(canonicalPreview(h.calls[1].payload, current(), "shared-new-plan")); await flush();
  assert.notEqual(h.view.state.plan.id, original.id);
  h.rulesController.update({ dateFormat: "dot" }); await flush();
  assert.equal(h.calls.length, 2, "a duplicate preference notification never invalidates a reviewed plan");
});

for (const contextState of ["missing", "expired"]) test(`shared rules cannot start an authenticated read for a ${contextState} current preview context`, async () => {
  const h = harness({ request: async (_action, payload) => canonicalPreview(payload) });
  h.update(); await flush();
  if (contextState === "missing") h.view.state.previewContext = null;
  else h.view.state.previewContext.expiresAt = 1;
  h.rulesController.update({ dateFormat: "compact" }); await flush();
  assert.equal(h.view.state.displayPlan.rules.dateFormat, "compact");
  assert.equal(h.view.state.plan, null);
  assert.equal(h.view.state.refreshNeeded, true);
  assert.deepEqual(h.calls.map(call => call.action), ["preview"]);
});

test("an expired worker context after an external rule notification does not silently renew metadata", async () => {
  const h = harness({ request: async (action, payload) => {
    if (action === "replan") throw Object.assign(new Error("expired local context"), { code: "TITLE_PLAN_EXPIRED" });
    return canonicalPreview(payload);
  } });
  h.update(); await flush();
  h.rulesController.update({ dateFormat: "slash" }); await flush();
  assert.deepEqual(h.calls.map(call => call.action), ["preview", "replan"]);
  assert.equal(h.view.state.plan, null); assert.equal(h.view.state.refreshNeeded, true);
  assert.equal(h.view.state.displayPlan.rules.dateFormat, "slash");
});

test("inactive current views receive shared settings without I/O and read the latest rules on deliberate reentry", async () => {
  const h = harness({ request: async (_action, payload) => canonicalPreview(payload) });
  h.update(); await flush(); h.update({ active: false });
  h.rulesController.update({ mode: "created", dateFormat: "dot" });
  assert.deepEqual(plain(h.view.state.rules), { mode: "created", dateFormat: "dot" });
  assert.equal(h.view.state.plan, null); await flush();
  assert.deepEqual(h.calls.map(call => call.action), ["preview"]);
  h.update({ active: true }); await flush();
  assert.deepEqual(h.calls.map(call => call.action), ["preview", "preview"]);
  assert.equal(h.calls[1].payload.rules.dateFormat, "dot"); assert.equal(h.calls[1].payload.rules.mode, "created");
});

test("shared choices arriving during the first metadata read wait for that context and never repeat the authenticated read", async () => {
  const reading = deferred();
  const h = harness({ request: async (action, payload) => action === "preview" ? reading.promise : canonicalPreview(payload) });
  h.update(); await flush();
  h.rulesController.update({ dateFormat: "dot" });
  assert.equal(h.view.state.busy, "preview"); assert.equal(h.view.state.rules.dateFormat, "iso");
  assert.equal(h.view.state.pendingRules, true);
  reading.resolve(canonicalPreview(h.calls[0].payload)); await flush();
  assert.deepEqual(h.calls.map(call => call.action), ["preview", "replan"]);
  assert.equal(h.calls[1].payload.rules.dateFormat, "dot");
  assert.equal(h.view.state.rules.dateFormat, "dot"); assert.equal(h.view.state.plan.rules.dateFormat, "dot");
});

test("shared preferences never rewrite a submitted or uncertain plan and settle without another write or metadata read", async () => {
  const writing = deferred();
  const h = harness({ request: async (action, payload) => {
    if (action === "preview") return canonicalPreview(payload);
    if (action === "apply") return writing.promise;
    return result({ operation: receipt("verified", { id: "canonical-plan" }) });
  } });
  h.update(); await flush(); h.click("apply");
  const frozen = h.view.state.displayPlan;
  h.rulesController.update({ dateFormat: "dot", mode: "created" });
  assert.equal(h.view.state.displayPlan, frozen); assert.equal(h.view.state.rules.dateFormat, "iso");
  assert.equal(h.calls.at(-1).payload.planId, "canonical-plan");
  writing.resolve(result({ operation: receipt("uncertain", { id: "canonical-plan" }) })); await flush();
  assert.equal(h.view.state.rules.dateFormat, "iso"); assert.equal(h.view.state.pendingRules, true);
  assert.equal(h.rulesController.snapshot().rules.dateFormat, "dot");
  h.click("reconcile"); await flush();
  assert.equal(h.view.state.rules.dateFormat, "dot"); assert.equal(h.view.state.pendingRules, false);
  assert.equal(h.view.state.plan, null, "settlement without a fresh editable context cannot restore write authority");
  assert.deepEqual(h.calls.map(call => call.action), ["preview", "apply", "reconcile"]);
});

test("pure removal hides assignment rules, ignores stale rule events and Back uses shared preferences without a new read", async () => {
  const observed = current("one", "2026-01-01｜Original");
  const h = harness({ request: async (action, payload) => canonicalPreview(payload, observed, `plan-${action}-${payload.operation}`) });
  h.update(); await flush(); h.click("remove"); await flush();
  const removal = h.view.state.plan;
  assert.doesNotMatch(h.root.innerHTML, /data-title-rule=/);
  h.change("dateFormat", "compact");
  assert.equal(h.rulesController.snapshot().rules.dateFormat, "iso", "hidden assignment controls cannot mutate preferences");
  h.rulesController.update({ dateFormat: "dot" }); await flush();
  assert.equal(h.view.state.plan, removal, "formatting is irrelevant to the reviewed removal");
  assert.deepEqual(h.calls.map(call => call.action), ["preview", "replan"]);
  h.click("back"); await flush();
  assert.match(h.root.innerHTML, /data-title-rule="dateFormat"/);
  assert.equal(h.calls.at(-1).payload.operation, "assign"); assert.equal(h.calls.at(-1).payload.rules.dateFormat, "dot");
  assert.deepEqual(h.calls.map(call => call.action), ["preview", "replan", "replan"]);
});

test("disposing a current view releases its shared-rules subscription but leaves the shared controller usable", async () => {
  const h = harness({ request: async (_action, payload) => canonicalPreview(payload) });
  h.update(); await flush();
  const before = h.root.innerHTML, rules = h.view.state.rules;
  h.view.dispose(); h.rulesController.update({ dateFormat: "dot" }); await h.rulesController.whenSaved(); await flush();
  assert.equal(h.root.innerHTML, before); assert.equal(h.view.state.rules, rules);
  assert.equal(h.rulesController.snapshot().rules.dateFormat, "dot");
  assert.deepEqual(h.calls.map(call => call.action), ["preview"]);
});

function actionMarkup(root, action) {
  return root.innerHTML.match(new RegExp(`<button[^>]*data-title-action="${action}"[^>]*>`))?.[0] || "";
}

// The stable toolbar lives inside the preview section, before its card. Slice
// its own header so assertions never mistake a footer action for a toolbar one.
function previewToolbarMarkup(root) {
  const start = root.innerHTML.indexOf('class="titles-preview-toolbar"');
  assert.ok(start >= 0, "the preview heading and optional actions have one stable row");
  const end = root.innerHTML.indexOf('</header>', start);
  assert.ok(end > start, "the toolbar has an independent header boundary");
  return root.innerHTML.slice(start, end);
}

function footerMarkup(root) {
  return root.innerHTML.match(/<footer\b[\s\S]*?<\/footer>/)?.[0] || "";
}

test("the preview toolbar stays between status and card during initial reading and after a plan arrives", async () => {
  const read = deferred();
  const h = harness({ request: () => read.promise });
  h.update(); await flush();
  for (const reading of [true, false]) {
    const toolbar = previewToolbarMarkup(h.root);
    assert.equal((h.root.innerHTML.match(/class="titles-preview-toolbar"/g) || []).length, 1);
    assert.ok(h.root.innerHTML.indexOf('class="titles-status"') < h.root.innerHTML.indexOf('class="titles-preview-toolbar"'));
    assert.match(toolbar, /<h3>标题预览<\/h3>/);
    assert.doesNotMatch(toolbar, /data-title-action="preview"|<span>重新读取<\/span>/);
    assert.doesNotMatch(footerMarkup(h.root), /data-title-action="preview"/);
    if (reading) {
      assert.match(footerMarkup(h.root), /<footer\b[^>]*\bhidden/);
      read.resolve(result({ plan: plan() })); await flush();
    } else {
      assert.doesNotMatch(actionMarkup(h.root, "apply"), /disabled/, "a successful preview is ready without a refresh step");
      assert.match(footerMarkup(h.root), /data-title-action="apply"/);
    }
  }
  assert.deepEqual(h.calls.map((call) => call.action), ["preview"]);
});

test("external invalidation automatically reads once while retaining the reviewed card and blocking writes", async () => {
  const fresh = deferred();
  const h = harness({ request: (action) => action === "preview"
    ? h.calls.length === 1 ? result({ plan: plan() }) : fresh.promise
    : result({ operation: receipt("verified", { id: "fresh-plan" }) }) });
  h.update(); await flush();
  assert.doesNotMatch(actionMarkup(h.root, "apply"), /disabled/);
  assert.equal(actionMarkup(h.root, "preview"), "");
  h.update({ snapshot: snapshot("one", "Changed elsewhere") });
  await flush();
  assert.match(previewToolbarMarkup(h.root), /<h3>标题预览<\/h3>/);
  assert.equal(actionMarkup(h.root, "preview"), "", "automatic renewal is not an extra user task");
  assert.match(h.root.innerHTML, /tidy-loading-flower/);
  assert.match(h.root.innerHTML, /data-title-preview/);
  assert.doesNotMatch(h.root.innerHTML, /预览过期|请重新读取/);
  assert.match(actionMarkup(h.root, "apply"), /disabled/, "a fresh read cannot race an older plan's write");
  h.dispatch("preview"); h.click("apply");
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "preview"]);
  fresh.resolve(result({ plan: plan({ id: "fresh-plan" }) })); await flush();
  assert.equal(h.view.state.plan.id, "fresh-plan");
  assert.equal(actionMarkup(h.root, "preview"), "", "a successful renewal needs no manual follow-up");
  h.click("apply"); await flush();
  assert.deepEqual(h.calls.at(-1), { action: "apply", payload: {
    expectedTabId: 7, expectedConversationId: "one", planId: "fresh-plan",
  } });
});

test("first-read failure exposes refresh, failed retries keep it, and a successful retry removes it", async () => {
  const first = deferred(), retry = deferred(), recovered = deferred();
  const responses = [first, retry, recovered];
  const h = harness({ request: () => responses[h.calls.length - 1].promise });
  h.update(); await flush();
  assert.equal(actionMarkup(h.root, "preview"), "", "the first read has only the fixed status flower");
  first.reject(new Error("private upstream error")); await flush();
  assert.match(previewToolbarMarkup(h.root), /data-title-action="preview"/);
  assert.doesNotMatch(actionMarkup(h.root, "preview"), /disabled/);
  assert.doesNotMatch(h.root.innerHTML, /private upstream error|tidy-loading-flower/);

  h.click("preview");
  assert.match(actionMarkup(h.root, "preview"), /disabled/, "retry does not remove the button under the pointer");
  assert.match(h.root.innerHTML, /tidy-loading-flower/);
  h.click("preview");
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "preview"]);
  retry.reject(new Error("second private failure")); await flush();
  assert.match(previewToolbarMarkup(h.root), /data-title-action="preview"/);
  assert.doesNotMatch(actionMarkup(h.root, "preview"), /disabled/);

  h.click("preview");
  assert.match(actionMarkup(h.root, "preview"), /disabled/);
  recovered.resolve(result({ plan: plan({ id: "recovered-plan" }) })); await flush();
  assert.equal(actionMarkup(h.root, "preview"), "");
  assert.doesNotMatch(actionMarkup(h.root, "apply"), /disabled/);
  assert.doesNotMatch(h.root.innerHTML, /tidy-loading-flower|second private failure/);
  h.update(); await flush();
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "preview", "preview"]);
});

for (const action of ["status", "reconcile"]) {
  test(`${action} that settles a write without editable context offers refresh, never a replay`, async () => {
    const check = deferred();
    const h = harness({ request: (requested) => {
      if (requested === "preview") return result({ plan: plan({ id: h.calls.length === 1 ? "plan-1" : "next-edit" }) });
      if (requested === "apply") throw new Error("lost write response");
      return check.promise;
    } });
    h.update(); await flush(); h.click("apply"); await flush();
    assert.equal(actionMarkup(h.root, "preview"), "");
    if (action === "status") { h.update({ active: false }); h.update({ active: true }); }
    else h.click("reconcile");
    await flush();
    assert.equal(h.calls.at(-1).action, action);
    assert.equal(actionMarkup(h.root, "preview"), "");
    assert.match(actionMarkup(h.root, "reconcile"), /disabled/);
    h.dispatch("preview");
    assert.equal(h.calls.length, 3, "refresh cannot escape an unsettled check");

    check.resolve(result({ operation: receipt() })); await flush();
    assert.equal(h.view.state.plan, null);
    assert.equal(h.view.state.previewContext, null);
    assert.match(previewToolbarMarkup(h.root), /data-title-action="preview"/);
    assert.doesNotMatch(actionMarkup(h.root, "preview"), /disabled/);
    assert.equal(actionMarkup(h.root, "reconcile"), "");
    assert.equal(actionMarkup(h.root, "apply"), "");
    h.click("preview"); await flush();
    assert.equal(actionMarkup(h.root, "preview"), "");
    assert.equal(h.view.state.plan.id, "next-edit");
    assert.deepEqual(h.calls.map((call) => call.action), ["preview", "apply", action, "preview"]);
  });
}

test("toolbar remove and return are local choices while the footer remains confirmation-only", async () => {
  const observed = current("one", "2026-07-01｜Original");
  const h = harness({ request: (action, payload) => canonicalPreview(payload, observed) });
  h.update(); await flush();
  let toolbar = previewToolbarMarkup(h.root);
  assert.match(toolbar, /data-title-action="remove"/);
  assert.doesNotMatch(toolbar, /data-title-action="preview"/);
  assert.doesNotMatch(footerMarkup(h.root), /data-title-action="remove"|data-title-action="back"|data-title-action="preview"/);
  h.click("remove"); await flush();
  toolbar = previewToolbarMarkup(h.root);
  assert.match(toolbar, /data-title-action="back"/);
  assert.doesNotMatch(toolbar, /data-title-action="remove"/);
  assert.match(footerMarkup(h.root), /data-title-action="apply"[^>]*>确认移除日期<\/button>/);
  assert.doesNotMatch(h.root.innerHTML, /titles-section-heading/);
  h.click("back"); await flush();
  h.change("dateFormat", "dot"); await flush();
  h.decide("replace"); await flush();
  h.decide("stack"); await flush();
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", ...Array(5).fill("replan")]);
  assert.equal(h.calls.filter((call) => call.action === "apply").length, 0);
  assert.doesNotMatch(h.root.innerHTML, /tidy-loading-flower/);
  assert.match(previewToolbarMarkup(h.root), /data-title-action="remove"/);
});

test("saving and uncertain readback hide refresh while reconciliation remains the only recovery action", async () => {
  const write = deferred();
  const h = harness({ request: (action) => action === "preview" ? result({ plan: plan() }) : write.promise });
  h.update(); await flush(); h.click("apply");
  assert.equal(actionMarkup(h.root, "preview"), "");
  assert.match(footerMarkup(h.root), /data-title-action="apply"/);
  h.dispatch("preview");
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "apply"]);
  write.resolve(result({ operation: receipt("uncertain") })); await flush();
  assert.equal(actionMarkup(h.root, "preview"), "");
  assert.match(footerMarkup(h.root), /data-title-action="reconcile"/);
  assert.doesNotMatch(footerMarkup(h.root), /<footer\b[^>]*\bhidden/);
  assert.doesNotMatch(footerMarkup(h.root), /data-title-action="preview"|data-title-action="apply"|data-title-action="remove"|data-title-action="back"/);
  h.dispatch("preview");
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "apply"]);
});

test("date-head presence determines add versus keep-replace-stack-remove controls", async () => {
  for (const title of ["Original", "2026-07-01｜Original"]) {
    const h = harness({ request: (action, payload) => canonicalPreview(payload, current("one", title)) });
    h.update(); await flush();
    assert.doesNotMatch(h.root.innerHTML, /undo|撤销/);
    if (title === "Original") {
      assert.equal(h.view.state.plan.hasDateHead, false);
      assert.match(h.root.innerHTML, /确认添加日期/);
      assert.doesNotMatch(h.root.innerHTML, /data-title-decision|data-title-action="remove"/);
    } else {
      assert.equal(h.view.state.plan.hasDateHead, true);
      assert.deepEqual([...h.root.innerHTML.matchAll(/data-title-decision value="([^"]+)"/g)].map((match) => match[1]),
        ["skip", "replace", "stack"]);
      assert.match(h.root.innerHTML, /保持不变/);
      assert.match(h.root.innerHTML, /替换日期/);
      assert.match(h.root.innerHTML, /叠加日期/);
      assert.match(h.root.innerHTML, /data-title-action="remove"/);
      assert.doesNotMatch(h.root.innerHTML, /data-title-action="apply"/, "keeping the existing head needs no write");
    }
    assert.deepEqual(h.calls.map((call) => call.action), ["preview"]);
  }
});

test("an already matching date head remains compact and removable without another save", async () => {
  const h = harness({ request: (action, payload) => {
    const dated = canonicalPreview(payload).plan.after;
    return canonicalPreview(payload, current("one", dated));
  } });
  h.update(); await flush();
  assert.equal(h.view.state.plan.hasDateHead, true);
  assert.match(h.root.innerHTML, /符合规则/);
  assert.match(h.root.innerHTML, /data-title-action="remove"/);
  assert.doesNotMatch(h.root.innerHTML, /data-title-action="apply"|undo|撤销/);
  assert.deepEqual(h.calls.map((call) => call.action), ["preview"]);
});

test("repeated radios and both date selects only replan the first authenticated metadata without I/O indicators", async () => {
  const observed = current("one", "2026-07-01｜Original");
  let id = 0;
  const h = harness({ stored: { mode: "range", dateFormat: "iso" }, request: (action, payload) => {
    assert.ok(["preview", "replan"].includes(action));
    return canonicalPreview(payload, observed, `instant-${++id}`);
  } });
  h.update(); await flush();
  const initialContext = h.view.state.previewContext.id;
  for (const round of [1, 2]) {
    for (const decision of ["replace", "stack", "skip"]) {
      h.decide(decision);
      assert.equal(h.view.state.displayPlan.selectedDecision, decision);
      assert.equal(h.root.attributes["aria-busy"], "false");
      assert.doesNotMatch(h.root.innerHTML, /tidy-loading-flower|class="titles-busy"|titles-preview is-loading/);
      await flush();
      assert.equal(h.view.state.plan.id, `instant-${id}`);
      assert.doesNotMatch(h.root.innerHTML, /tidy-loading-flower/);
    }
    for (const [field, value] of [["dateFormat", round === 1 ? "dot" : "compact"], ["mode", round === 1 ? "created" : "range"]]) {
      h.change(field, value);
      assert.equal(h.view.state.displayPlan.rules[field], value);
      assert.equal(h.root.attributes["aria-busy"], "false");
      assert.doesNotMatch(h.root.innerHTML, /tidy-loading-flower|class="titles-busy"|titles-preview is-loading/);
      await flush();
    }
  }
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", ...Array(10).fill("replan")]);
  for (const call of h.calls.slice(1)) {
    assert.equal(call.payload.previewContextId, initialContext);
    assert.deepEqual(Object.keys(call.payload).sort(), ["decision", "expectedConversationId", "expectedTabId", "operation", "previewContextId", "rules"]);
    assert.equal(Object.hasOwn(call.payload, "current"), false, "the UI cannot supply replacement authenticated metadata");
  }
});

for (const context of [null, previewContext({ expiresAt: 1 })]) {
  test(`first preview returning ${context ? "expired" : "missing"} context stops automatic reads until explicit retry`, async () => {
    const observed = current("one", "2026-07-01｜Original");
    const refresh = deferred();
    const h = harness({ request: (action, payload) => action === "preview" && h.calls.length === 1
      ? { ...canonicalPreview(payload, observed), previewContext: context } : refresh.promise });
    h.update(); await flush();
    assert.match(previewToolbarMarkup(h.root), /data-title-action="preview"/, "an unusable read context has a recovery exit");
    h.decide("replace"); await flush();
    h.change("dateFormat", "dot"); await flush();
    assert.equal(h.calls.length, 1);
    assert.equal(h.view.state.plan, null);
    assert.equal(h.view.state.previewContext, null);
    assert.equal(h.root.attributes["aria-busy"], "false");
    assert.doesNotMatch(h.root.innerHTML, /tidy-loading-flower/);
    assert.match(h.root.innerHTML, /预览过期/);
    h.click("preview"); await flush();
    assert.deepEqual(h.calls.map((call) => call.action), ["preview", "preview"]);
    assert.equal(h.calls[1].payload.decision, "replace");
    assert.equal(h.calls[1].payload.rules.dateFormat, "dot");
    assert.equal(h.root.attributes["aria-busy"], "true");
    assert.match(h.root.innerHTML, /tidy-loading-flower/);
    refresh.resolve(canonicalPreview(h.calls[1].payload, observed, "refreshed")); await flush();
    assert.equal(actionMarkup(h.root, "preview"), "");
  });
}

for (const code of ["TITLE_PLAN_EXPIRED", "TITLE_PREVIEW_REQUIRED"]) {
  test(`${code} from worker replan renews authenticated preview once and preserves the chosen draft`, async () => {
    const fresh = deferred(), observed = current("one", "2026-07-01｜Original");
    const h = harness({ request: (action, payload) => {
      if (action === "preview") return h.calls.length === 1 ? canonicalPreview(payload, observed) : fresh.promise;
      throw Object.assign(new Error("private evicted-context detail"), { code });
    } });
    h.update(); await flush(); h.decide("replace");
    const draft = plain(h.view.state.displayPlan);
    await flush();
    assert.deepEqual(h.calls.map((call) => call.action), ["preview", "replan", "preview"]);
    assert.equal(h.calls.at(-1).payload.decision, "replace");
    assert.equal(h.calls.at(-1).payload.operation, "assign");
    assert.deepEqual(plain(h.view.state.displayPlan), draft);
    assert.equal(h.view.state.plan, null, "the old immutable ID is not executable during renewal");
    assert.equal(h.view.state.previewContext, null);
    assert.equal(h.root.attributes["aria-busy"], "true");
    assert.match(h.root.innerHTML, /tidy-loading-flower/);
    assert.match(actionMarkup(h.root, "apply"), /disabled/);
    assert.equal(actionMarkup(h.root, "preview"), "");
    assert.doesNotMatch(h.root.innerHTML, /预览过期|请重新读取|private evicted-context/);
    h.dispatch("apply"); h.dispatch("preview"); h.decide("stack");
    assert.equal(h.calls.length, 3, "renewal is single-flight and never replays a pending click");
    fresh.resolve(canonicalPreview(h.calls[2].payload, observed, "renewed-choice")); await flush();
    assert.equal(h.view.state.plan.id, "renewed-choice");
    assert.equal(h.view.state.decision, "replace");
    assert.doesNotMatch(actionMarkup(h.root, "apply"), /disabled/);
    assert.doesNotMatch(h.root.innerHTML, /tidy-loading-flower/);
    assert.equal(h.calls.filter((call) => call.action === "apply").length, 0);
  });
}

test("metadata changes cancel stale queued replans and renew once without collapsing the selected draft", async () => {
  const pending = deferred(), fresh = deferred();
  const h = harness({ request: (action, payload) => action === "preview"
    ? h.calls.length === 1 ? canonicalPreview(payload) : fresh.promise : pending.promise });
  h.update(); await flush();
  h.change("dateFormat", "dot"); await flush();
  h.change("mode", "created");
  const reviewedDraft = plain(h.view.state.displayPlan);
  const changed = snapshot("one", "Changed elsewhere");
  changed.conversation.updatedAt.value = "2026-09-02T00:00:00.000Z";
  h.update({ snapshot: changed });
  assert.equal(h.view.state.previewContext, null);
  assert.equal(h.view.state.plan, null);
  pending.resolve(canonicalPreview(h.calls[1].payload, current(), "stale-before-metadata-change")); await flush();
  assert.equal(h.view.state.plan, null);
  assert.deepEqual(plain(h.view.state.displayPlan), reviewedDraft);
  assert.equal(h.view.state.rules.mode, "created");
  assert.equal(h.view.state.rules.dateFormat, "dot");
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "replan", "preview"], "stale queued choice is replaced by one authenticated read");
  assert.equal(h.calls[2].payload.rules.mode, "created");
  assert.equal(h.calls[2].payload.rules.dateFormat, "dot");
  assert.match(h.root.innerHTML, /tidy-loading-flower/);
  assert.match(h.root.innerHTML, /data-title-preview/);
  assert.match(actionMarkup(h.root, "apply"), /disabled/);
  assert.equal(actionMarkup(h.root, "preview"), "");
  h.click("apply");
  assert.equal(h.calls.length, 3, "the retained draft is display-only until renewal completes");
  const observed = { ...current("one", "Changed elsewhere"), updatedAt: "2026-09-02T00:00:00.000Z" };
  fresh.resolve(canonicalPreview(h.calls[2].payload, observed, "renewed-metadata")); await flush();
  assert.equal(h.view.state.plan.id, "renewed-metadata");
  assert.equal(h.view.state.plan.before, "Changed elsewhere");
});

test("an idle external metadata update automatically renews with the reviewed conflict decision", async () => {
  let observed = current("one", "2026-07-01｜Original");
  const fresh = deferred();
  const h = harness({ request: (action, payload) => action === "preview" && h.calls.length > 1
    ? fresh.promise : canonicalPreview(payload, observed, `plan-${h.calls.length}`) });
  h.update(); await flush(); h.decide("replace"); await flush();
  const reviewedDraft = plain(h.view.state.displayPlan);
  observed = { ...observed, title: "2026-07-01｜Edited elsewhere", updatedAt: "2026-09-03T00:00:00.000Z" };
  const changed = snapshot("one", observed.title);
  changed.conversation.updatedAt.value = observed.updatedAt;
  h.update({ snapshot: changed });
  assert.equal(h.view.state.plan, null);
  assert.equal(h.view.state.previewContext, null);
  assert.equal(h.view.state.decision, "replace");
  assert.deepEqual(plain(h.view.state.displayPlan), reviewedDraft);
  assert.match(h.root.innerHTML, /value="replace" checked/);
  assert.match(actionMarkup(h.root, "apply"), /disabled/);
  assert.doesNotMatch(h.root.innerHTML, /会话已变，请重新读取/);
  assert.match(h.root.innerHTML, /tidy-loading-flower/);
  await flush();
  assert.equal(h.view.state.decision, "replace");
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "replan", "preview"]);
  assert.equal(h.calls.at(-1).payload.decision, "replace");
  assert.equal(h.calls.at(-1).payload.rules.mode, "created");
  fresh.resolve(canonicalPreview(h.calls[2].payload, observed, "fresh-conflict")); await flush();
  assert.equal(h.view.state.plan.before, observed.title);
  assert.doesNotMatch(actionMarkup(h.root, "apply"), /disabled/);
});

test("an offline replan's final confirmation sends only its immutable ID and retains genuine saving feedback", async () => {
  const pending = deferred(), observed = current("one", "2026-07-01｜Original");
  const h = harness({ request: (action, payload) => action === "apply" ? pending.promise
    : canonicalPreview(payload, observed, action === "preview" ? "first-plan" : "reviewed-offline-plan") });
  h.update(); await flush();
  h.decide("replace"); await flush();
  assert.doesNotMatch(h.root.innerHTML, /tidy-loading-flower/);
  h.click("apply");
  assert.deepEqual(h.calls.at(-1), { action: "apply", payload: {
    expectedTabId: 7, expectedConversationId: "one", planId: "reviewed-offline-plan",
  } });
  assert.equal(h.root.attributes["aria-busy"], "true");
  assert.equal((h.root.innerHTML.match(/class="tidy-loading-flower__petal"/g) || []).length, 6);
  assert.equal(h.view.state.previewContext, null);
  const after = h.view.state.displayPlan.after;
  const renewed = previewContext({ id: "verified-readback-context" });
  const nextPreview = canonicalPreview({ ...h.calls[1].payload, decision: "skip" }, current("one", after), "next-readback-plan");
  pending.resolve(result({ current: current("one", after), plan: nextPreview.plan, previewContext: renewed,
    operation: receipt("verified", { id: "reviewed-offline-plan", after }) }));
  await flush();
  assert.deepEqual(plain(h.view.state.previewContext), renewed, "only the new verified readback context continues editing");
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "replan", "apply"]);
  assert.match(h.root.innerHTML, /已保存/);
});

test("remove and Back reuse metadata without flowers or an extra authenticated read", async () => {
  const observed = current("one", "2026-07-01｜Original");
  const h = harness({ request: (action, payload) => canonicalPreview(payload, observed) });
  h.update(); await flush();
  h.click("remove");
  assert.equal(h.view.state.displayPlan.after, "Original");
  assert.equal(h.root.attributes["aria-busy"], "false");
  assert.doesNotMatch(h.root.innerHTML, /tidy-loading-flower/);
  await flush();
  h.click("back");
  assert.equal(h.view.state.previewKind, "assign");
  assert.equal(h.root.attributes["aria-busy"], "false");
  assert.doesNotMatch(h.root.innerHTML, /tidy-loading-flower/);
  await flush();
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "replan", "replan"]);
  assert.deepEqual(h.calls.slice(1).map((call) => call.payload.operation), ["remove", "assign"]);
  assert.equal(h.calls.filter((call) => call.action === "preview").length, 1);
  assert.doesNotMatch(h.root.innerHTML, /undo|撤销/);
});

test("initial loading shows the shared six-petal flower but no draft from unauthenticated snapshot data", async () => {
  const remote = deferred();
  const h = harness({ request: () => remote.promise });
  h.update(); await flush();
  assert.equal(h.view.state.current, null);
  assert.equal(h.view.state.displayPlan, null);
  assert.equal(h.view.state.plan, null);
  assert.equal((h.root.innerHTML.match(/class="tidy-loading-flower__petal"/g) || []).length, 6);
  assert.match(h.root.innerHTML, /class="titles-status" role="status" aria-live="polite"/);
  assert.match(h.root.innerHTML, /class="titles-status__label--sr-only">正在读取…<\/span>/);
  assert.doesNotMatch(h.root.innerHTML, /data-title-action="apply"/);
  remote.resolve(canonicalPreview(h.calls[0].payload)); await flush();
  assert.doesNotMatch(h.root.innerHTML, /class="tidy-loading-flower"/);
});

test("the flower occupies one reserved status row between rules and preview, never the action footer", async () => {
  const initial = deferred(), write = deferred();
  const h = harness({ request: (action) => action === "preview" ? initial.promise : write.promise });
  function assertStatusRow({ loading }) {
    const html = h.root.innerHTML;
    assert.equal((html.match(/class="titles-status"/g) || []).length, 1);
    const status = html.indexOf('class="titles-status"');
    const preview = html.indexOf('class="titles-preview');
    assert.ok(html.indexOf('class="titles-rule"') < status);
    assert.ok(status < preview, "status stays above the card instead of migrating beside confirm");
    const beforePreview = html.slice(status, preview);
    if (loading) assert.match(beforePreview, /tidy-loading-flower/);
    else assert.doesNotMatch(html, /tidy-loading-flower/);
    const footer = html.match(/<footer\b[\s\S]*?<\/footer>/)?.[0] || "";
    assert.doesNotMatch(footer, /tidy-loading-flower|titles-busy/);
  }
  h.update(); await flush(); assertStatusRow({ loading: true });
  initial.resolve(result({ plan: plan() })); await flush(); assertStatusRow({ loading: false });
  h.click("apply"); assertStatusRow({ loading: true });
  write.resolve(result({ current: current("one", plan().after), operation: receipt() }));
  await flush(); assertStatusRow({ loading: false });
});

test("remove preview has a readable Back action that returns to the date choices without I/O", async () => {
  const observed = current("one", "2026-07-01｜Original");
  const h = harness({ request: (action, payload) => canonicalPreview(payload, observed) });
  function assertBack() {
    const markup = h.root.innerHTML.match(/<button[^>]*data-title-action="back"[^>]*>[\s\S]*?<\/button>/)?.[0];
    assert.ok(markup);
    assert.match(markup, /class="[^"]*titles-back-action/);
    assert.match(markup, />返回<\/button>/);
    assert.match(previewToolbarMarkup(h.root), /data-title-action="back"/);
    assert.doesNotMatch(footerMarkup(h.root), /data-title-action="back"|data-title-action="remove"|data-title-action="preview"/);
    assert.doesNotMatch(h.root.innerHTML, /titles-section-heading/, "the preview toolbar replaces the duplicate remove heading");
  }
  h.update(); await flush();
  h.click("remove"); await flush(); assertBack();
  assert.doesNotMatch(h.root.innerHTML, /undo|撤销/);
  assert.equal(h.view.state.previewKind, "remove");
  h.click("back");
  assert.equal(h.view.state.previewKind, "assign");
  assert.equal(h.root.attributes["aria-busy"], "false");
  assert.doesNotMatch(h.root.innerHTML, /tidy-loading-flower/);
  await flush();
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "replan", "replan"]);
  assert.equal(h.calls.at(-1).payload.operation, "assign");
  assert.equal(h.calls.at(-1).payload.previewContextId, "context-one");
  assert.equal(h.calls.filter((call) => call.action === "apply").length, 0);
});

test("pending add and remove saves acknowledge the accepted click without duplicating the write", async () => {
  for (const removing of [false, true]) {
    const pending = deferred();
    const id = removing ? "remove-accepted" : "save-accepted";
    const h = harness({ request: (action, payload) => {
      if (action === "apply") return pending.promise;
      return result({ plan: plan({ id, hasDateHead: removing, action: payload.operation }) });
    } });
    h.update(); await flush();
    if (removing) { h.click("remove"); await flush(); }
    h.click("apply");
    const markup = h.root.innerHTML.match(/<button[^>]*data-title-action="apply"[^>]*>[\s\S]*?<\/button>/)[0];
    assert.match(markup, /disabled/);
    assert.match(markup, /正在保存…/);
    assert.doesNotMatch(markup, /tidy-loading-flower/);
    h.click("apply");
    assert.deepEqual(h.calls.filter((call) => call.action === "apply"), [{ action: "apply", payload: {
      expectedTabId: 7, expectedConversationId: "one", planId: id,
    } }]);
    pending.resolve(result({ operation: receipt("verified", { id }) }));
    await flush();
  }
});

test("verified save readback supports immediate further date choices without a manual refresh", async () => {
  const freshContext = previewContext({ id: "after-save" });
  let savedCurrent = null;
  const h = harness({ request: (action, payload) => {
    if (action === "apply") {
      savedCurrent = current("one", h.view.state.displayPlan.after);
      const nextPreview = canonicalPreview(h.calls[0].payload, savedCurrent, "next-save-plan");
      return result({ current: savedCurrent, plan: nextPreview.plan, previewContext: freshContext,
        operation: receipt("verified", { id: payload.planId, after: savedCurrent.title }) });
    }
    return { ...canonicalPreview(payload, savedCurrent || current(), `plan-${h.calls.length}`),
      previewContext: savedCurrent ? freshContext : previewContext() };
  } });
  h.update(); await flush(); h.click("apply"); await flush();
  assert.equal(h.view.state.plan.id, "next-save-plan");
  assert.equal(h.view.state.plan.canApply, false, "the saved title already matches; the old write must not be executable again");
  assert.equal(actionMarkup(h.root, "preview"), "", "verified readback already supplied the next editable context");
  h.change("dateFormat", "dot");
  assert.equal(actionMarkup(h.root, "preview"), "", "local replanning does not flash a refresh affordance");
  assert.doesNotMatch(h.root.innerHTML, /tidy-loading-flower|预览过期/);
  assert.equal(h.view.state.displayPlan.rules.dateFormat, "dot");
  await flush();
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "apply", "replan"]);
  assert.equal(h.calls.at(-1).payload.previewContextId, freshContext.id);
  assert.equal(h.view.state.plan.before, savedCurrent.title);
  assert.equal(h.calls.filter((call) => call.action === "apply").length, 1);
});

test("a verified receipt with context only cannot resurrect the submitted executable plan", async () => {
  const h = harness({ request: (action) => action === "preview" ? result({ plan: plan() })
    : result({ current: current("one", plan().after), operation: receipt(),
      previewContext: previewContext({ id: "context-without-canonical-plan" }), plan: null }) });
  h.update(); await flush(); h.click("apply"); await flush();
  assert.equal(h.view.state.plan, null);
  assert.equal(h.view.state.previewContext, null);
  assert.doesNotMatch(h.root.innerHTML, /data-title-action="apply"/);
  assert.match(h.root.innerHTML, /已保存/);
  assert.match(previewToolbarMarkup(h.root), /data-title-action="preview"/, "a receipt alone leaves a visible route to the next edit");
  assert.equal(h.calls.filter((call) => call.action === "apply").length, 1);
});

test("verified removal immediately offers add-date again and keeps further choices local", async () => {
  const freshContext = previewContext({ id: "after-remove" });
  const plainTitle = current("one", "Original"), dated = current("one", "2026-07-01｜Original");
  let removedAlready = false;
  const h = harness({ stored: { mode: "range", dateFormat: "iso" }, request: (action, payload) => {
    if (action === "apply") {
      removedAlready = true;
      const next = canonicalPreview({ ...h.calls[0].payload, operation: "assign", decision: "skip" }, plainTitle, "after-remove-plan");
      return { ...next, previewContext: freshContext, operation: receipt("verified", {
        id: payload.planId, before: dated.title, after: plainTitle.title,
      }) };
    }
    return { ...canonicalPreview(payload, removedAlready ? plainTitle : dated),
      previewContext: removedAlready ? freshContext : previewContext() };
  } });
  h.update(); await flush(); h.click("remove"); await flush(); h.click("apply"); await flush();
  assert.equal(h.view.state.previewKind, "assign");
  assert.equal(h.view.state.displayPlan.before, "Original");
  assert.equal(h.view.state.plan.hasDateHead, false);
  assert.match(h.root.innerHTML, /确认添加日期/);
  const addButton = h.root.innerHTML.match(/<button[^>]*data-title-action="apply"[^>]*>/)[0];
  assert.doesNotMatch(addButton, /disabled/, "a plain title can be dated immediately without changing a rule first");
  assert.doesNotMatch(h.root.innerHTML, /undo|撤销|data-title-action="remove"/);
  assert.equal(actionMarkup(h.root, "preview"), "", "removal's fresh readback supports another edit with no refresh step");
  h.change("dateFormat", "compact"); await flush();
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "replan", "apply", "replan"]);
  assert.equal(h.calls.at(-1).payload.previewContextId, freshContext.id);
  assert.equal(h.calls.at(-1).payload.operation, "assign");
  assert.equal(h.view.state.plan.before, plainTitle.title);
  assert.equal(h.view.state.displayPlan.after, "20260801\u2009~\u20090901｜Original");
  assert.doesNotMatch(h.root.innerHTML, /tidy-loading-flower|预览过期/);
});

test("add-remove-add is a complete two-state cycle with one initial read and only confirmed writes", async () => {
  let observed = current(), context = previewContext(), sequence = 0;
  const h = harness({ request: (action, payload) => {
    if (action === "apply") {
      const reviewed = h.view.state.displayPlan;
      assert.equal(payload.planId, reviewed.id);
      observed = current("one", reviewed.after);
      context = previewContext({ id: `readback-${++sequence}` });
      return { ...canonicalPreview(h.calls[0].payload, observed, `next-${sequence}`), previewContext: context,
        operation: receipt("verified", { id: payload.planId, before: reviewed.before, after: reviewed.after }) };
    }
    return { ...canonicalPreview(payload, observed, `choice-${++sequence}`), previewContext: context };
  } });
  h.update(); await flush();
  h.click("apply"); await flush();
  assert.match(h.root.innerHTML, /已保存/);
  assert.match(h.root.innerHTML, /data-title-action="remove"/);
  assert.doesNotMatch(h.root.innerHTML, /data-title-action="apply"|undo|撤销/);
  h.click("remove"); await flush();
  assert.match(h.root.innerHTML, /确认移除日期/);
  h.click("apply"); await flush();
  assert.equal(observed.title, "Original");
  assert.match(h.root.innerHTML, /确认添加日期/);
  assert.doesNotMatch(actionMarkup(h.root, "apply"), /disabled/);
  const nextId = h.view.state.plan.id;
  h.click("apply"); await flush();
  assert.equal(h.calls.at(-1).payload.planId, nextId);
  assert.match(h.root.innerHTML, /已保存/);
  assert.match(h.root.innerHTML, /data-title-action="remove"/);
  assert.doesNotMatch(h.root.innerHTML, /undo|撤销/);
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "apply", "replan", "apply", "apply"]);
});

for (const status of ["pending", "uncertain", "failed"]) {
  test(`${status} write receipts cannot turn an accompanying context into next-edit authority`, async () => {
    const h = harness({ request: (action) => action === "preview" ? result({ plan: plan() })
      : result({ operation: receipt(status), plan: plan({ id: "unproven-next-edit" }),
        previewContext: previewContext({ id: "unproven-readback" }) }) });
    h.update(); await flush(); h.click("apply"); await flush();
    assert.equal(h.view.state.plan, null);
    assert.equal(h.view.state.previewContext, null);
    assert.doesNotMatch(h.root.innerHTML, /data-title-action="apply"|已保存/);
    assert.equal(Boolean(actionMarkup(h.root, "preview")), status === "failed", "only a settled failure can reread; uncertain writes must be checked first");
    assert.equal(h.calls.filter((call) => call.action === "apply").length, 1);
  });
}

test("in-place title patching retains select, option and radio identities across unrelated status changes", () => {
  const { element: e, textNode: txt } = require("./helpers/title-dom.cjs");
  const h = harness();
  const option = e("option", { value: "iso", selected: "" }, [txt("2026-08-18")]);
  const select = e("select", { "data-title-rule": "dateFormat" }, [option], { value: "iso" });
  const radio = e("input", { "data-title-decision": "", value: "replace", checked: "" }, [], { checked: true });
  const status = e("div", { class: "titles-status" }, [txt("")]);
  const before = e("div", {}, [e("section", { class: "titles-rule" }, [select]), status,
    e("section", { class: "titles-preview" }, [radio])]);
  const after = before.cloneNode(true);
  after.childNodes[1].childNodes[0].nodeValue = "正在读取…";
  h.context.patchTitleNode(before, after);
  assert.equal(before.childNodes[0].childNodes[0], select);
  assert.equal(select.childNodes[0], option);
  assert.equal(before.childNodes[2].childNodes[0], radio);
  assert.equal(status.childNodes[0].nodeValue, "正在读取…");
  assert.deepEqual(select.writes, { attributes: 0, value: 0, checked: 0 });
  assert.deepEqual(radio.writes, { attributes: 0, value: 0, checked: 0 });
});

test("in-place title patching updates dirty native choice properties without replacing the controls", () => {
  const { element: e } = require("./helpers/title-dom.cjs");
  const h = harness();
  // A click changes DOM properties independently of the original attributes.
  const select = e("select", { "data-title-rule": "dateFormat" }, [], { value: "iso" });
  const skip = e("input", { value: "skip", checked: "" }, [], { checked: false });
  const replace = e("input", { value: "replace" }, [], { checked: true });
  const before = e("div", {}, [select, skip, replace]);
  const after = e("div", {}, [e("select", { "data-title-rule": "dateFormat" }, [], { value: "dot" }),
    e("input", { value: "skip" }, [], { checked: false }),
    e("input", { value: "replace", checked: "" }, [], { checked: true })]);
  h.context.patchTitleNode(before, after);
  assert.deepEqual(before.childNodes, [select, skip, replace]);
  assert.equal(select.value, "dot");
  assert.equal(select.writes.value, 1);
  assert.equal(skip.checked, false);
  assert.equal(skip.hasAttribute("checked"), false);
  assert.equal(replace.checked, true);
  assert.equal(replace.hasAttribute("checked"), true);
  assert.equal(skip.writes.checked + replace.writes.checked, 0, "already-correct user properties are not rewritten");
});

test("showing, disabling and removing contextual refresh preserves the toolbar and preview control identities", () => {
  const { element: e, textNode: txt } = require("./helpers/title-dom.cjs");
  const h = harness();
  const heading = e("h3", {}, [txt("标题预览")]);
  const start = e("div", { class: "titles-preview-toolbar__start" }, [heading]);
  const remove = e("button", { "data-title-action": "remove" }, [txt("移除日期")]);
  const end = e("div", { class: "titles-preview-toolbar__end" }, [remove]);
  const toolbar = e("header", { class: "titles-preview-toolbar" }, [start, end]);
  const radio = e("input", { "data-title-decision": "", value: "replace", checked: "" }, [], { checked: true });
  const card = e("article", { class: "titles-preview-card" }, [radio]);
  const before = e("section", { class: "titles-preview" }, [toolbar, card]);

  const invalidated = before.cloneNode(true);
  invalidated.childNodes[0].childNodes[0].append(e("button", { "data-title-action": "preview" }, [txt("重新读取")]));
  h.context.patchTitleNode(before, invalidated);
  const refresh = start.childNodes[1];
  const retrying = before.cloneNode(true);
  retrying.childNodes[0].childNodes[0].childNodes[1].setAttribute("disabled", "");
  h.context.patchTitleNode(before, retrying);
  assert.equal(start.childNodes[1], refresh, "the clicked refresh button stays in the document while waiting");
  assert.equal(refresh.hasAttribute("disabled"), true);

  const recovered = before.cloneNode(true);
  recovered.childNodes[0].childNodes[0].childNodes[1].remove();
  h.context.patchTitleNode(before, recovered);
  assert.deepEqual(before.childNodes, [toolbar, card]);
  assert.deepEqual(toolbar.childNodes, [start, end]);
  assert.deepEqual(start.childNodes, [heading]);
  assert.equal(end.childNodes[0], remove);
  assert.equal(card.childNodes[0], radio);
  assert.deepEqual(radio.writes, { attributes: 0, value: 0, checked: 0 });
});

test("a conflict choice renders its pure draft immediately and leaves choices enabled without authorizing a write", async () => {
  const remote = deferred(), observed = current("one", "2026-07-01｜Original");
  let reads = 0;
  const h = harness({ stored: { mode: "range", dateFormat: "iso" }, request: (action, payload) => ++reads === 1
    ? canonicalPreview(payload, observed, "initial") : remote.promise });
  h.update(); await flush();
  h.decide("replace");
  assert.equal(h.root.attributes["aria-busy"], "false");
  assert.doesNotMatch(h.root.innerHTML, /class="tidy-loading-flower"|class="titles-busy"/);
  assert.equal(h.view.state.plan, null);
  assert.equal(Object.hasOwn(h.view.state.displayPlan, "id"), false);
  assert.equal(h.view.state.displayPlan.action, "replace");
  assert.equal(h.view.state.displayPlan.after, "2026-08-01\u2009~\u200909-01｜Original");
  assert.match(h.root.innerHTML, /data-title-preview/);
  assert.match(h.root.innerHTML, /value="replace" checked/);
  assert.doesNotMatch(h.root.innerHTML.match(/<fieldset[^>]*>/)[0], /disabled/);
  for (const select of h.root.innerHTML.match(/<select[^>]*>/g)) assert.doesNotMatch(select, /disabled/);
  assert.match(actionMarkup(h.root, "apply"), /disabled/);
  h.click("apply");
  assert.equal(h.calls.filter((call) => call.action === "apply").length, 0);
  await flush();
  remote.resolve(canonicalPreview(h.calls.at(-1).payload, observed, "confirmed-replace")); await flush();
  assert.equal(h.view.state.plan.id, "confirmed-replace");
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "replan"]);
  assert.doesNotMatch(h.root.innerHTML, /class="tidy-loading-flower"|class="titles-busy"/);
  assert.doesNotMatch(actionMarkup(h.root, "apply"), /disabled/);
});

test("a rule change keeps the preview card and shows the new formatting synchronously", async () => {
  const remote = deferred(); let reads = 0;
  const h = harness({ stored: { mode: "range", dateFormat: "iso" }, request: (action, payload) => ++reads === 1
    ? canonicalPreview(payload) : remote.promise });
  h.update(); await flush();
  h.change("dateFormat", "compact");
  assert.equal(actionMarkup(h.root, "preview"), "", "ordinary local choice changes do not introduce retry UI");
  assert.equal(h.view.state.displayPlan.after, "20260801\u2009~\u20090901｜Original");
  assert.equal(h.view.state.plan, null);
  assert.match(h.root.innerHTML, /data-title-preview/);
  assert.doesNotMatch(h.root.innerHTML, /class="tidy-loading-flower"/);
  assert.equal(h.root.attributes["aria-busy"], "false");
  assert.match(h.root.innerHTML, /value="compact" selected/);
  assert.match(actionMarkup(h.root, "apply"), /disabled/);
  await flush();
  // Replanning uses the same frozen observation rather than refreshing remote
  // metadata. The submit path, not this control, owns fresh server validation.
  remote.resolve(canonicalPreview(h.calls.at(-1).payload, current(), "new-format")); await flush();
  assert.equal(h.view.state.plan.before, "Original");
  assert.equal(h.view.state.displayPlan.after, "20260801\u2009~\u20090901｜Original");
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "replan"]);
  assert.doesNotMatch(actionMarkup(h.root, "apply"), /disabled/);
});

test("rapid replace-stack-skip choices keep one local replan in flight and only the latest queued choice", async () => {
  const first = deferred(), latest = deferred(), observed = current("one", "2026-07-01｜Original");
  let reads = 0;
  const h = harness({ request: (action, payload) => ++reads === 1 ? canonicalPreview(payload, observed, "initial")
    : reads === 2 ? first.promise : latest.promise });
  h.update(); await flush();
  h.decide("replace"); await flush();
  h.decide("stack"); h.decide("skip"); await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.view.state.decision, "skip");
  assert.equal(h.view.state.displayPlan.after, observed.title);
  assert.equal(h.view.state.plan, null);
  assert.equal(h.root.attributes["aria-busy"], "false");
  assert.doesNotMatch(h.root.innerHTML, /class="tidy-loading-flower"/);
  first.resolve(canonicalPreview(h.calls[1].payload, observed, "superseded-replace")); await flush();
  assert.deepEqual(h.calls.map((call) => call.payload.decision), ["skip", "replace", "skip"]);
  assert.equal(h.view.state.plan, null, "superseded response cannot authorize confirmation");
  assert.equal(h.view.state.displayPlan.after, observed.title);
  latest.resolve(canonicalPreview(h.calls[2].payload, observed, "latest-skip")); await flush();
  assert.equal(h.view.state.plan.id, "latest-skip");
  assert.equal(h.view.state.busy, null);
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "replan", "replan"]);
  assert.equal(h.calls.filter((call) => call.action === "apply").length, 0);
});

// Formatting and date-source controls refine the chosen conflict action; they
// must not silently switch back to Keep while an earlier replan is still pending.
for (const decision of ["replace", "stack"]) {
  for (const [field, value, prefix] of [
    ["dateFormat", "dot", "2026.08.01\u2009~\u200909.01"],
    ["mode", "created", "2026-08-01"],
  ]) {
    test(`${decision} survives a ${field} change with an immediate draft and only a fresh canonical authorization`, async () => {
      const earlier = deferred(), latest = deferred(), observed = current("one", "2026-07-01｜Original");
      let reads = 0;
      const h = harness({ stored: { mode: "range", dateFormat: "iso" }, request: (action, payload) => ++reads === 1 ? canonicalPreview(payload, observed, "initial")
        : reads === 2 ? earlier.promise : latest.promise });
      h.update(); await flush();
      h.decide(decision); await flush();
      h.change(field, value);

      const expectedAfter = `${prefix}｜${decision === "replace" ? "Original" : observed.title}`;
      assert.equal(h.view.state.decision, decision);
      assert.equal(h.view.state.displayPlan.selectedDecision, decision);
      assert.equal(h.view.state.displayPlan.after, expectedAfter);
      assert.equal(h.view.state.displayPlan.rules[field], value);
      assert.equal(Object.hasOwn(h.view.state.displayPlan, "id"), false);
      assert.equal(h.view.state.plan, null);
      assert.match(h.root.innerHTML, new RegExp(`value="${decision}" checked`));
      assert.match(actionMarkup(h.root, "apply"), /disabled/);
      h.click("apply");
      assert.equal(h.calls.length, 2, "rule refinement is queued behind the current replan, not a write");
      assert.doesNotMatch(h.root.innerHTML, /class="tidy-loading-flower"/);

      earlier.resolve(canonicalPreview(h.calls[1].payload, observed, "old-rules")); await flush();
      assert.equal(h.calls.length, 3);
      assert.equal(h.calls[2].action, "replan");
      assert.equal(h.calls[2].payload.decision, decision);
      assert.equal(h.calls[2].payload.rules[field], value);
      assert.equal(h.view.state.displayPlan.after, expectedAfter);
      assert.equal(h.view.state.plan, null, "an older choice response cannot authorize the refined draft");
      assert.match(actionMarkup(h.root, "apply"), /disabled/);

      latest.resolve(canonicalPreview(h.calls[2].payload, observed, "new-rules")); await flush();
      assert.equal(h.view.state.plan.id, "new-rules");
      assert.equal(h.view.state.plan.selectedDecision, decision);
      assert.equal(h.view.state.displayPlan.after, expectedAfter);
      assert.doesNotMatch(actionMarkup(h.root, "apply"), /disabled/);
      assert.deepEqual(h.calls.map((call) => call.action), ["preview", "replan", "replan"]);
    });
  }
}

test("A-B-A rule changes require the latest A response rather than reusing the earlier matching plan", async () => {
  const earlierA = deferred(), latestA = deferred(); let reads = 0;
  const h = harness({ request: (action, payload) => ++reads === 1 ? canonicalPreview(payload)
    : reads === 2 ? earlierA.promise : latestA.promise });
  h.update(); await flush();
  h.change("dateFormat", "dot"); await flush();
  h.change("dateFormat", "compact"); h.change("dateFormat", "dot"); await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.view.state.displayPlan.rules.dateFormat, "dot");
  earlierA.resolve(canonicalPreview(h.calls[1].payload, current(), "old-A")); await flush();
  assert.deepEqual(h.calls.map((call) => call.payload.rules.dateFormat), ["iso", "dot", "dot"]);
  assert.equal(h.view.state.plan, null);
  assert.match(actionMarkup(h.root, "apply"), /disabled/);
  latestA.resolve(canonicalPreview(h.calls[2].payload, current(), "latest-A")); await flush();
  assert.equal(h.view.state.plan.id, "latest-A");
  assert.doesNotMatch(actionMarkup(h.root, "apply"), /disabled/);
});

test("a superseded failed replan drains the latest choice without flashing an error or dropping its draft", async () => {
  const first = deferred(), latest = deferred(); let reads = 0;
  const h = harness({ request: (action, payload) => ++reads === 1 ? canonicalPreview(payload)
    : reads === 2 ? first.promise : latest.promise });
  h.update(); await flush();
  h.change("dateFormat", "dot"); await flush(); h.change("dateFormat", "compact");
  first.reject(new Error("private rejected response")); await flush();
  assert.equal(h.calls.length, 3);
  assert.equal(h.view.state.error, "");
  assert.equal(h.view.state.displayPlan.rules.dateFormat, "compact");
  assert.equal(h.view.state.plan, null);
  latest.resolve(canonicalPreview(h.calls[2].payload, current(), "recovered-latest")); await flush();
  assert.equal(h.view.state.plan.id, "recovered-latest");
  assert.equal(h.view.state.busy, null);
});

test("hiding cancels the queued preview and quarantines its earlier in-flight response", async () => {
  const remote = deferred(); let reads = 0;
  const h = harness({ request: (action, payload) => ++reads === 1 ? canonicalPreview(payload) : remote.promise });
  h.update(); await flush();
  h.change("dateFormat", "dot"); await flush(); h.change("dateFormat", "compact");
  h.update({ active: false });
  remote.resolve(canonicalPreview(h.calls[1].payload, current(), "hidden-old")); await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.view.state.plan, null);
  assert.equal(h.view.state.displayPlan, null);
  assert.equal(h.view.state.busy, null);
});

test("route changes discard old queued choices and do not block a fresh conversation preview", async () => {
  const remote = deferred(); let reads = 0;
  const h = harness({ request: (action, payload) => payload.expectedConversationId === "two"
    ? canonicalPreview(payload, current("two", "Second conversation"), "second-conversation")
    : ++reads === 1 ? canonicalPreview(payload) : remote.promise });
  h.update(); await flush();
  h.change("dateFormat", "dot"); await flush(); h.change("dateFormat", "compact");
  h.update({ snapshot: snapshot("two", "Second conversation") }); await flush();
  assert.equal(h.view.state.plan.id, "second-conversation");
  remote.resolve(canonicalPreview(h.calls[1].payload, current(), "old-conversation")); await flush();
  assert.equal(h.view.state.plan.id, "second-conversation");
  assert.deepEqual(h.calls.map((call) => call.payload.expectedConversationId), ["one", "one", "two"]);
});

test("saving retains the reviewed card with a six-petal flower and prevents further choices", async () => {
  const remote = deferred();
  const h = harness({ request: (action, payload) => action === "preview"
    ? canonicalPreview(payload, current(), "reviewed") : remote.promise });
  h.update(); await flush();
  const reviewed = plain(h.view.state.plan);
  h.click("apply");
  assert.equal(h.view.state.plan, null);
  assert.equal(h.view.state.displayPlan.after, reviewed.after);
  assert.match(h.root.innerHTML, /data-title-preview/);
  assert.equal((h.root.innerHTML.match(/class="tidy-loading-flower__petal"/g) || []).length, 6);
  for (const select of h.root.innerHTML.match(/<select[^>]*>/g)) assert.match(select, /disabled/);
  h.change("dateFormat", "compact");
  assert.equal(h.view.state.rules.dateFormat, "iso");
  assert.match(actionMarkup(h.root, "apply"), /disabled/);
  remote.resolve(result({ operation: receipt("verified", { id: "reviewed", after: reviewed.after }),
    current: current("one", reviewed.after) })); await flush();
  assert.match(h.root.innerHTML, /已保存/);
  assert.doesNotMatch(h.root.innerHTML, /class="tidy-loading-flower"/);
});

test("a failed latest replan keeps the selected draft and only an explicit refresh rereads that exact choice", async () => {
  const failure = deferred(), retry = deferred(), observed = current("one", "2026-07-01｜Original");
  let reads = 0;
  const h = harness({ request: (action, payload) => ++reads === 1 ? canonicalPreview(payload, observed, "initial")
    : reads === 2 ? failure.promise : retry.promise });
  h.update(); await flush();
  h.decide("replace"); await flush();
  const draft = h.view.state.displayPlan.after;
  failure.reject(new Error("do not expose private error")); await flush();
  assert.equal(h.view.state.busy, null);
  assert.equal(h.view.state.plan, null);
  assert.equal(h.view.state.displayPlan.after, draft);
  assert.equal(h.view.state.decision, "replace");
  assert.match(actionMarkup(h.root, "apply"), /disabled/);
  assert.doesNotMatch(h.root.innerHTML, /do not expose private error/);
  h.click("preview"); await flush();
  assert.match(h.root.innerHTML, /class="tidy-loading-flower"/);
  assert.equal(h.calls[2].payload.decision, "replace");
  assert.equal(h.view.state.displayPlan.after, draft);
  retry.resolve(canonicalPreview(h.calls[2].payload, observed, "retry-replace")); await flush();
  assert.equal(h.view.state.plan.id, "retry-replace");
  assert.doesNotMatch(actionMarkup(h.root, "apply"), /disabled/);
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "replan", "preview"]);
});

test("a failed remove preview retries removal while its distinct Back action returns to assignment", async () => {
  const failure = deferred(), observed = current("one", "2026-07-01｜Original"); let reads = 0;
  const h = harness({ request: (action, payload) => ++reads === 2 ? failure.promise
    : canonicalPreview(payload, observed, `plan-${reads}`) });
  h.update(); await flush();
  h.click("remove"); await flush();
  failure.reject(new Error("read failed")); await flush();
  assert.equal(h.view.state.previewKind, "remove");
  assert.equal(h.view.state.displayPlan.after, "Original");
  h.click("preview"); await flush();
  assert.equal(h.calls.at(-1).payload.operation, "remove");
  assert.equal(h.view.state.plan.action, "remove");
  h.click("back"); await flush();
  assert.equal(h.calls.at(-1).payload.operation, "assign");
  assert.equal(h.view.state.previewKind, "assign");
  assert.equal(h.calls.filter((call) => call.action === "apply").length, 0);
});

test("disposal drops the queued latest choice and prevents late responses from mutating view markup", async () => {
  const remote = deferred(); let reads = 0;
  const h = harness({ request: (action, payload) => ++reads === 1 ? canonicalPreview(payload) : remote.promise });
  h.update(); await flush();
  h.change("dateFormat", "dot"); await flush(); h.change("dateFormat", "compact");
  h.view.dispose();
  const disposedMarkup = h.root.innerHTML;
  remote.resolve(canonicalPreview(h.calls[1].payload, current(), "late-disposed")); await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.root.innerHTML, disposedMarkup);
  assert.equal(h.view.state.plan, null);
});

// Expiration is simulated after a successful read, rather than returning a bad
// context from that read: a malformed first response must trip the retry brake.
for (const frozen of [null, previewContext({ expiresAt: 1 })]) {
  test(`a ${frozen ? "locally expired" : "lost"} previously valid context renews on the next choice, not on a timer`, async () => {
    const fresh = deferred(), observed = current("one", "2026-07-01｜Original");
    const h = harness({ request: (action, payload) => h.calls.length === 1
      ? canonicalPreview(payload, observed) : fresh.promise });
    h.update(); await flush();
    h.view.state.previewContext = frozen;
    await flush();
    assert.deepEqual(h.calls.map((call) => call.action), ["preview"], "there is no timer or background poll");
    h.decide("stack");
    const draft = plain(h.view.state.displayPlan);
    await flush();
    assert.deepEqual(h.calls.map((call) => call.action), ["preview", "preview"]);
    assert.equal(h.calls[1].payload.decision, "stack");
    assert.equal(h.calls[1].payload.operation, "assign");
    assert.deepEqual(h.calls[1].payload.rules, { mode: "created", dateFormat: "iso", timeZone: "Asia/Singapore", locale: "zh-CN" });
    assert.equal(Object.hasOwn(h.calls[1].payload, "planId"), false);
    assert.deepEqual(plain(h.view.state.displayPlan), draft);
    assert.equal(h.view.state.plan, null);
    assert.equal(actionMarkup(h.root, "preview"), "");
    assert.match(h.root.innerHTML, /tidy-loading-flower/);
    assert.doesNotMatch(h.root.innerHTML, /预览过期|请重新读取/);
    fresh.resolve(canonicalPreview(h.calls[1].payload, observed, "automatic-stack")); await flush();
    assert.equal(h.view.state.plan.id, "automatic-stack");
    assert.equal(h.view.state.decision, "stack");
    assert.doesNotMatch(actionMarkup(h.root, "apply"), /disabled/);
  });
}

test("expired removal renews that removal preview without resetting to assignment", async () => {
  const fresh = deferred(), observed = current("one", "2026-07-01｜Original");
  const h = harness({ request: (action, payload) => h.calls.length === 1
    ? canonicalPreview(payload, observed) : fresh.promise });
  h.update(); await flush(); h.view.state.previewContext.expiresAt = 1;
  h.click("remove"); await flush();
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "preview"]);
  assert.equal(h.calls[1].payload.operation, "remove");
  assert.equal(h.view.state.previewKind, "remove");
  assert.equal(h.view.state.displayPlan.after, "Original");
  assert.match(previewToolbarMarkup(h.root), /data-title-action="back"/);
  assert.match(actionMarkup(h.root, "apply"), /disabled/);
  fresh.resolve(canonicalPreview(h.calls[1].payload, observed, "automatic-remove")); await flush();
  assert.equal(h.view.state.plan.action, "remove");
  assert.match(footerMarkup(h.root), /确认移除日期/);
  assert.equal(h.calls.filter((call) => call.action === "apply").length, 0);
});

test("confirming a locally expired context only refreshes; the renewed plan needs a second explicit confirmation", async () => {
  const fresh = deferred();
  const h = harness({ request: (action, payload) => {
    if (action === "preview") return h.calls.length === 1 ? canonicalPreview(payload, current(), "old-reviewed") : fresh.promise;
    return result({ operation: receipt("verified", { id: payload.planId }) });
  } });
  h.update(); await flush(); h.view.state.previewContext.expiresAt = 1;
  h.click("apply"); await flush();
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "preview"], "no expired plan crosses the write boundary");
  assert.equal(h.view.state.submittedPlanId, null);
  assert.equal(h.view.state.recoveryNeeded, false);
  h.dispatch("apply");
  fresh.resolve(canonicalPreview(h.calls[1].payload, current(), "new-reviewed")); await flush();
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "preview"]);
  assert.equal(h.view.state.plan.id, "new-reviewed");
  h.click("apply"); await flush();
  assert.deepEqual(h.calls.at(-1), { action: "apply", payload: {
    expectedTabId: 7, expectedConversationId: "one", planId: "new-reviewed",
  } });
});

test("a service-proven expired apply refreshes read-only and never silently resubmits the replacement plan", async () => {
  const fresh = deferred();
  const h = harness({ request: (action, payload) => {
    if (action === "preview") return h.calls.length === 1 ? canonicalPreview(payload, current(), "old-reviewed") : fresh.promise;
    if (payload.planId === "old-reviewed") throw Object.assign(new Error("No POST dispatched"), { code: "TITLE_PREVIEW_REQUIRED" });
    return result({ operation: receipt("verified", { id: payload.planId }) });
  } });
  h.update(); await flush(); h.click("apply"); await flush();
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "apply", "preview"]);
  assert.equal(h.view.state.recoveryNeeded, false);
  assert.equal(h.view.state.submittedPlanId, null);
  assert.equal(actionMarkup(h.root, "preview"), "");
  assert.doesNotMatch(h.root.innerHTML, /No POST dispatched|预览过期|请重新读取/);
  fresh.resolve(canonicalPreview(h.calls[2].payload, current(), "new-reviewed")); await flush();
  assert.equal(h.calls.filter((call) => call.action === "apply").length, 1, "the original click was consumed, not replayed");
  h.click("apply"); await flush();
  assert.equal(h.calls.at(-1).payload.planId, "new-reviewed");
});

for (const code of ["TITLE_INVALID_PLAN", "NOT_FOUND", "CONTEXT_MISMATCH"]) {
  test(`${code} is not treated as proof that a replan context merely expired`, async () => {
    const h = harness({ request: (action, payload) => {
      if (action === "preview") return canonicalPreview(payload);
      throw Object.assign(new Error("private failure"), { code });
    } });
    h.update(); await flush(); h.change("dateFormat", "dot"); await flush();
    assert.deepEqual(h.calls.map((call) => call.action), ["preview", "replan"]);
    assert.match(previewToolbarMarkup(h.root), /data-title-action="preview"/);
    h.change("mode", "created");
    h.update({ snapshot: snapshot("one", "Changed while recovery is blocked") }); await flush();
    assert.equal(h.calls.length, 2, "an unrelated event cannot escalate a failed read into repeated authentication");
    assert.doesNotMatch(h.root.innerHTML, /private failure|tidy-loading-flower/);
  });
}

for (const brokenRead of ["reject", "missing-context", "expired-context", "missing-plan"]) {
  test(`automatic preview ${brokenRead} stops retry loops until manual recovery, keeping the latest choices`, async () => {
    const failed = deferred(), observed = current("one", "2026-07-01｜Original");
    const h = harness({ request: (action, payload) => h.calls.length === 2 ? failed.promise
      : canonicalPreview(payload, observed, `read-${h.calls.length}`) });
    h.update(); await flush(); h.view.state.previewContext.expiresAt = 1;
    h.decide("replace"); await flush();
    assert.deepEqual(h.calls.map((call) => call.action), ["preview", "preview"]);
    if (brokenRead === "reject") failed.reject(new Error("private authentication failure"));
    else failed.resolve({ ...canonicalPreview(h.calls[1].payload, observed),
      ...(brokenRead === "missing-plan" ? { plan: null } : {
        previewContext: brokenRead === "missing-context" ? null : previewContext({ expiresAt: 1 }),
      }) });
    await flush();
    assert.equal(h.view.state.busy, null);
    assert.match(previewToolbarMarkup(h.root), /data-title-action="preview"/);
    h.change("dateFormat", "dot"); h.decide("stack");
    for (let i = 0; i < 3; i += 1) {
      const changed = snapshot("one", `External update ${i}`);
      changed.conversation.updatedAt.value = `2026-09-0${i + 2}T00:00:00.000Z`;
      h.update({ snapshot: changed }); await flush();
    }
    assert.equal(h.calls.length, 2, "metadata bursts and local choices cannot retrigger a broken authenticated read");
    assert.equal(h.view.state.plan, null);
    assert.equal(h.view.state.decision, "stack");
    assert.equal(h.view.state.rules.dateFormat, "dot");
    assert.doesNotMatch(h.root.innerHTML, /private authentication failure|tidy-loading-flower/);
    h.click("preview"); await flush();
    assert.equal(h.calls.length, 3);
    assert.equal(h.calls[2].payload.decision, "stack");
    assert.equal(h.calls[2].payload.rules.dateFormat, "dot");
    assert.equal(h.view.state.plan.id, "read-3");
    assert.equal(actionMarkup(h.root, "preview"), "");
  });
}

test("first-read failure does not auto-retry on subsequent metadata notifications or option changes", async () => {
  const h = harness({ request: async () => { throw new Error("first read unavailable"); } });
  h.update(); await flush();
  h.update({ snapshot: snapshot("one", "A different title") });
  h.change("dateFormat", "dot"); h.change("mode", "created");
  h.update({ snapshot: snapshot("one", "Another title") }); await flush();
  assert.equal(h.calls.length, 1);
  assert.match(previewToolbarMarkup(h.root), /data-title-action="preview"/);
  assert.doesNotMatch(h.root.innerHTML, /tidy-loading-flower|first read unavailable/);
});

test("metadata bursts during automatic renewal stay single-flight and an identical readback is ignored", async () => {
  const fresh = deferred();
  const h = harness({ request: (action, payload) => h.calls.length === 1 ? canonicalPreview(payload) : fresh.promise });
  h.update(); await flush();
  const unrelated = snapshot(); unrelated.conversation.messageCount = 73;
  h.update({ snapshot: unrelated }); await flush();
  assert.equal(h.calls.length, 1, "non-title metadata is irrelevant to the preview context");
  for (let i = 0; i < 5; i += 1) {
    h.update({ snapshot: snapshot("one", `Changed ${i}`) });
    h.dispatch("apply"); h.dispatch("preview");
  }
  await flush();
  assert.deepEqual(h.calls.map((call) => call.action), ["preview", "preview"]);
  fresh.resolve(canonicalPreview(h.calls[1].payload, current("one", "Changed 4"), "burst-readback")); await flush();
  h.update({ snapshot: snapshot("one", "Changed 4") }); await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.view.state.plan.id, "burst-readback");
  assert.equal(actionMarkup(h.root, "preview"), "");
});

for (const status of ["pending", "uncertain"]) {
  test(`${status} receipt blocks metadata-driven renewal and stale choice or preview events`, async () => {
    const h = harness({ request: () => result({ operation: receipt(status) }) });
    h.update(); await flush();
    h.update({ snapshot: snapshot("one", "Changed during unresolved write") });
    h.dispatch("preview"); h.dispatch("remove"); h.dispatch("apply");
    h.change("dateFormat", "dot"); h.decide("replace"); await flush();
    assert.deepEqual(h.calls.map((call) => call.action), ["preview"]);
    assert.equal(h.view.state.operation.status, status);
    assert.equal(actionMarkup(h.root, "preview"), "");
    assert.match(footerMarkup(h.root), /data-title-action="reconcile"/);
  });
}

for (const exit of ["route", "hide", "dispose"]) {
  test(`${exit} quarantines a late automatic renewal without resurrecting its plan or retrying it`, async () => {
    const late = deferred();
    const h = harness({ request: (action, payload) => payload.expectedConversationId === "two"
      ? canonicalPreview(payload, current("two", "Second conversation"), "second-route")
      : h.calls.length === 1 ? canonicalPreview(payload) : late.promise });
    h.update(); await flush(); h.view.state.previewContext.expiresAt = 1;
    h.change("dateFormat", "dot"); await flush();
    assert.equal(h.calls.length, 2);
    if (exit === "route") h.update({ snapshot: snapshot("two", "Second conversation") });
    else if (exit === "hide") h.update({ active: false });
    else h.view.dispose();
    await flush();
    const markup = h.root.innerHTML;
    late.resolve(canonicalPreview(h.calls[1].payload, current(), "late-auto-preview")); await flush();
    assert.equal(h.root.innerHTML, markup);
    assert.notEqual(h.view.state.plan?.id, "late-auto-preview");
    assert.equal(h.calls.length, exit === "route" ? 3 : 2);
    if (exit === "route") assert.equal(h.view.state.plan.id, "second-route");
  });
}
