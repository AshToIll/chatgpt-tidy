const { installRulesRuntime } = require("./helpers/title-rules.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { snapshotHarness } = require("./helpers/adapter-snapshot.cjs");
const { element, textNode } = require("./helpers/title-dom.cjs");
const source = (file) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
// Catalog test doubles publish state exactly like the real catalog. Promise
// return values are deliberately separate from the view's onUpdate channel.
const publishCatalog = (options, result) => { options.onUpdate(result); return result; };
const preferences = { language: "zh-CN", timeZone: "Asia/Singapore", dateFormat: "iso", conversationTimeMode: "range" };
const row = (id, title) => ({ conversationId: id, title, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" });
const rows = [row("one", "Alpha"), row("two", "2020-01-01 | Beta"), row("three", "2020-01-01"), row("four", "Gamma")];
const snapshot = (id = "owner", title = "Owner") => snapshotHarness({ url: `https://chatgpt.com/c/${id}`,
  sidebar: [{ href: `/c/${id}`, title, record: { id, title, create_time: 1785542400, update_time: 1788220800 } }] });

function harness({ intercept, catalogRows = rows, loadCatalog, stored = null, initialJob = null, language = "zh-CN" } = {}) {
  const calls = [], saved = [], busy = [], listeners = new Map(); let changed = 0, catalogCalls = 0, catalogUpdate, modelCalls = 0, dateLabelCalls = 0;
  const root = { innerHTML: "", attributes: {}, addEventListener(k, fn) { listeners.set(k, fn); }, removeEventListener(k) { listeners.delete(k); },
    setAttribute(k, v) { this.attributes[k] = v; }, contains(node) { return node?.owner === root; } };
  const context = vm.createContext({ URL, Intl, console, navigator: { language: "zh-CN" }, chrome: { storage: { local: {
    get: async (key) => ({ [key]: stored }), set: async (v) => saved.push(plain(v)),
  } } } });
  for (const file of ["src/messages/i18n.js", "src/platform/snapshot.js", "src/platform/navigation/conversation-route.js", "src/features/titles/model/title-context.js", "src/platform/time-format.js", "src/features/titles/model/title-dates.js", "src/platform/ui/loading-flower.js"])
    vm.runInContext(source(file).replace(/^import .*$/gm, "").replace(/^export /gm, ""), context);
  installRulesRuntime(context, preferences);
  const originalModel = context.TidyTitleDates, originalTime = context.TidyTimeFormat;
  context.TidyTitleDates = { ...originalModel, plan(...args) { modelCalls++; return originalModel.plan(...args); } };
  context.TidyTimeFormat = { ...originalTime, formatRange(...args) { dateLabelCalls++; return originalTime.formatRange(...args); } };
  vm.runInContext(source("src/features/titles/ui/title-batch-view.js").replace(/^import[^\n]+\n/gm, "").replace(/^export /gm, "")
    .replace("return Object.freeze({ update, canLeave:", "return Object.freeze({ update, state, canLeave:"), context);
  let job = initialJob && plain(initialJob), sequence = 0;
  const model = (current, rules, operation = "assign", decision = "skip") => plain(context.TidyTitleDates.plan(current, rules, { operation, decision }));
  function freshId() { return `batch-${++sequence}`; }
  function advance(phase) {
    job.phase = job.items.some((item) => item.status === "ready") ? phase : "result";
    job.nextStepId = job.phase === "applying" ? `step-${++sequence}` : null;
  }
  // Protocol fake only: UI tests exercise the actual title model and rendered
  // event handlers, not HTTP or IndexedDB. The real worker has separate tests.
  function respond(action, payload) {
    if (action === "batch-status") return plain(job || { batchId: null });
    if (action === "batch-preview") {
      job = { batchId: freshId(), catalogAccountKey: "account-1", operation: payload.operation, rules: payload.rules,
        phase: "preview", nextStepId: null,
        items: payload.conversationIds.map((id) => {
          const current = plain(catalogRows.find((r) => r.conversationId === id));
          const plan = model(current, payload.rules, payload.operation);
          return { conversationId: id, status: plan.canApply ? "ready" : "skipped", current, plan, settled: false };
        }) };
    } else if (action === "batch-replan") {
      assert.equal(payload.batchId, job.batchId); job.batchId = freshId(); job.rules = payload.rules;
      for (const item of job.items.filter((item) => !item.settled && ["ready", "skipped"].includes(item.status))) {
        item.plan = model(item.current, job.rules, job.operation, payload.decisions[item.conversationId]);
        item.status = item.plan.canApply ? "ready" : "skipped";
      }
    } else if (action === "batch-apply") {
      assert.equal(payload.batchId, job.batchId); for (const item of job.items) if (item.status === "skipped") item.settled = true;
      advance("applying");
    } else if (action === "batch-step") {
      assert.equal(payload.stepId, job.nextStepId); const item = job.items.find((item) => item.status === "ready");
      item.current = { ...item.current, title: item.plan.after }; item.status = "verified"; item.settled = true; advance("applying");
    } else if (action === "batch-retry-preview") {
      job.batchId = freshId(); job.rules = payload.rules;
      for (const item of job.items.filter((item) => !item.settled)) {
        item.plan = model(item.current, job.rules, job.operation, payload.decisions[item.conversationId]);
        item.status = item.plan.canApply ? "ready" : "skipped";
      }
      job.phase = "preview"; job.nextStepId = null;
    } else if (action === "batch-reconcile") {
      if (job.phase === "applying") { job.phase = job.items.some((item) => ["ready", "pending", "uncertain"].includes(item.status)) ? "paused" : "result"; job.nextStepId = null; }
    } else throw new Error(`Unexpected ${action}`);
    return plain(job);
  }
  const server = { respond, get job() { return job; }, set job(value) { job = plain(value); }, model };
  const view = context.createTitleBatchView({ root, ownerTabId: 7, onChanged: () => changed++, onBusyChange: (v) => busy.push(v),
    request: async (action, payload) => { calls.push({ action, payload: plain(payload) }); return intercept ? intercept(action, payload, server) : respond(action, payload); },
    loadCatalog: async (options) => {
      catalogCalls++; catalogUpdate = options.onUpdate;
      if (loadCatalog) return loadCatalog(options);
      return publishCatalog(options, { accountKey: "account-1", rows: catalogRows, loading: false, partial: false });
    },
  });
  let options = { snapshot: snapshot(), preferences, active: true, t: context.createTranslator(language) };
  const update = (patch = {}) => { options = { ...options, ...patch }; view.update(options); };
  const node = (dataset, value = "", disabled = false) => ({ owner: root, dataset, value, disabled, closest() { return this; } });
  const dispatch = (dataset, value, disabled = false, event = "click") => listeners.get(event)?.({ target: node(dataset, value, disabled) });
  const click = (action) => {
    const tag = root.innerHTML.match(new RegExp(`<button[^>]*data-batch-action="${action}"[^>]*>`))?.[0];
    assert.ok(tag, `Missing action ${action}: ${root.innerHTML}`); dispatch({ batchAction: action }, null, /\sdisabled(?:\s|>)/.test(tag));
  };
  return { root, view, calls, saved, busy, context, server, update, click, dispatch,
    select: (id) => dispatch({ batchSelect: id }), filter: (id) => dispatch({ batchFilter: id }),
    search: (value) => dispatch({ batchQuery: "" }, value, false, "input"),
    decide: (id, value) => dispatch({ batchDecision: id }, value, false, "change"),
    rule: (field, value) => dispatch({ batchRule: field }, value, false, "change"),
    sort: (field) => dispatch({ batchSortField: "" }, field, false, "change"),
    catalog: (v) => catalogUpdate(v), get catalogCalls() { return catalogCalls; }, get changed() { return changed; },
    get modelCalls() { return modelCalls; }, get dateLabelCalls() { return dateLabelCalls; } };
}
async function review(h, ids = ["one", "two"]) { h.update(); await flush(); for (const id of ids) h.select(id); h.click("preview"); await flush(); }
const actions = (h) => h.calls.map((c) => c.action);
const button = (h, action) => h.root.innerHTML.match(new RegExp(`<button[^>]*data-batch-action="${action}"[^>]*>`))?.[0];
const visibleIds = (h) => [...h.root.innerHTML.matchAll(/data-batch-select="([^"]+)"/g)].map((match) => match[1]);

test("external rename updates only its selection row and preserves filters, checks and scroll without requests", async () => {
  const h = harness(); h.update(); await flush(); h.select("one"); h.view.state.selectScroll = 87;
  const before = actions(h), catalogCalls = h.catalogCalls;
  h.catalog({ accountKey: "account-1", rows: rows.map(row => row.conversationId === "one"
    ? { ...row, title: "Native new title", titleChangeStartedAt: Date.now() } : row), loading: false });
  assert.equal(h.view.state.rows[0].title, "Native new title");
  assert.deepEqual([...h.view.state.selected], ["one"]); assert.equal(h.view.state.selectScroll, 87);
  assert.deepEqual(actions(h), before); assert.equal(h.catalogCalls, catalogCalls);
});

test("external rename freezes an old preview until explicit targeted review, never an automatic write", async () => {
  const h = harness({ intercept: (action, payload, server) => {
    if (action === "batch-retry-preview" && payload.refreshConversationIds) {
      for (const id of payload.refreshConversationIds) server.job.items.find(item => item.conversationId === id).current.title = "Native new title";
    }
    return server.respond(action, payload);
  } });
  await review(h, ["one", "four"]);
  const frozen = plain(h.view.state.batch), before = actions(h);
  h.catalog({ accountKey: "account-1", rows: rows.map(row => row.conversationId === "one"
    ? { ...row, title: "Native new title", titleChangeStartedAt: Date.now() } : row), loading: false });
  assert.deepEqual(plain(h.view.state.batch), frozen, "never silently edit the reviewed recipe");
  assert.match(button(h, "apply"), /disabled/); assert.ok(button(h, "refresh-preview"));
  h.click("apply"); h.rule("dateFormat", "dot"); await flush();
  assert.deepEqual(actions(h), before, "even option edits cannot restore stale confirmation");
  h.click("refresh-preview"); await flush();
  assert.deepEqual(h.calls.at(-1).payload.refreshConversationIds, ["one"]);
  assert.equal(h.view.state.batch.items[0].current.title, "Native new title");
  assert.doesNotMatch(button(h, "apply"), /disabled/);
  assert.equal(actions(h).includes("batch-apply"), false);
});

test('batch title format labels follow zoned today without changing plans or requesting another preview', async () => {
  const h = harness();
  const time = h.context.TidyTimeFormat;
  let now = new Date('2026-09-17T20:00:00Z');
  h.context.TidyTimeFormat = { ...time, dateFormatLabels: zone => time.dateFormatLabels(zone, now) };
  await review(h, ['one']);
  assert.match(h.root.innerHTML, /<option value="iso" selected>2026-09-18<\/option>/);
  const batchBefore = plain(h.view.state.batch), callsBefore = h.calls.length, catalogBefore = h.catalogCalls;
  now = new Date('2026-09-18T20:00:00Z');
  h.update(); await flush();
  assert.match(h.root.innerHTML, /<option value="iso" selected>2026-09-19<\/option>/);
  assert.equal(h.calls.length, callsBefore); assert.equal(h.catalogCalls, catalogBefore);
  assert.deepEqual(plain(h.view.state.batch), batchBefore, 'a newer label does not rewrite the reviewed title plan');
  h.update({ preferences: { ...preferences, timeZone: 'America/Los_Angeles' } }); await flush();
  assert.match(h.root.innerHTML, /<option value="iso" selected>2026-09-18<\/option>/);
});

test("navigation dismisses pure previews without discarding selection or requesting recovery", async () => {
  const h = harness(); await review(h, ["one", "four"]);
  const before = actions(h); h.view.state.selectScroll = 72;
  h.update({ snapshot: snapshot("other") }); await flush();
  assert.equal(h.view.state.batch, null); assert.equal(h.view.state.recovery, false);
  assert.equal(h.view.state.batchContext, ""); assert.deepEqual([...h.view.state.selected], ["one", "four"]);
  assert.equal(h.view.state.selectScroll, 72); assert.deepEqual(actions(h), before);
  assert.ok(button(h, "preview")); assert.doesNotMatch(button(h, "preview"), / disabled/);
  h.click("preview"); await flush();
  assert.equal(h.calls.at(-1).payload.expectedConversationId, "other");
  assert.equal(h.view.state.batch.phase, "preview");
});

test("navigation dismisses settled results but preserves unknown write recovery and a return-owner action", async () => {
  const settled = harness(); await review(settled, ["one"]); settled.click("apply"); await flush();
  assert.equal(settled.view.state.batch.phase, "result");
  settled.update({ snapshot: snapshot("other") }); await flush();
  assert.equal(settled.view.state.batch, null); assert.equal(settled.view.state.recovery, false);
  const h = harness({ intercept: (action, payload, server) => action === "return-owner" ? { navigated: true } : server.respond(action, payload) });
  await review(h, ["one"]); h.view.state.batch.items[0].status = "uncertain";
  h.update({ snapshot: snapshot("other") }); await flush();
  assert.equal(h.view.state.recovery, true); assert.equal(h.view.state.batch.items[0].status, "uncertain");
  assert.ok(button(h, "return-owner")); h.click("return-owner"); await flush();
  assert.equal(h.calls.at(-1).action, "return-owner"); assert.equal(h.calls.at(-1).payload.pathname, "/c/owner");
  assert.equal(actions(h).includes("batch-apply"), false); assert.equal(actions(h).includes("batch-reconcile"), false);
});

test("selection navigation keeps the catalog, choices and scroll without status or directory reload", async () => {
  const h = harness(); h.update(); await flush(); h.select("one"); h.select("four");
  h.search("Alpha"); h.sort("updatedAt"); h.view.state.selectScroll = 180;
  const before = actions(h), catalogCalls = h.catalogCalls;
  for (const next of [null, snapshot("other"), snapshot("owner")]) {
    h.update({ snapshot: next }); await flush();
    assert.equal(h.catalogCalls, catalogCalls);
    assert.deepEqual(actions(h), before);
    assert.deepEqual([...h.view.state.selected], ["one", "four"]);
    assert.equal(h.view.state.rows.length, rows.length);
    assert.equal(h.view.state.query, "Alpha"); assert.equal(h.view.state.sortField, "updatedAt");
    assert.equal(h.view.state.selectScroll, 180);
    assert.match(h.root.innerHTML, /data-batch-scroll="select"/);
    assert.doesNotMatch(h.root.innerHTML, /tidy-loading-flower/);
    if (!next) { h.dispatch({ batchAction: "preview" }); await flush(); assert.deepEqual(actions(h), before); }
  }
  h.click("preview"); await flush();
  assert.equal(h.calls.find(call => call.action === "batch-preview").payload.expectedConversationId, "owner");
});

test("a catalog stream survives conversation navigation but not hide, disposal or replacement", async () => {
  const pending = deferred(); let stream;
  const h = harness({ loadCatalog: (options) => {
    stream = options;
    options.onUpdate({ accountKey: "account-1", rows: [rows[0]], loading: true });
    return pending.promise;
  } });
  h.update(); await flush(); h.select("one");
  h.update({ snapshot: null }); await flush();
  assert.equal(stream.canRefresh(), true, "directory enumeration is not owned by the open conversation");
  h.update({ snapshot: snapshot("other") }); await flush();
  stream.onUpdate({ accountKey: "account-1", rows, loading: false });
  assert.equal(h.view.state.rows.length, rows.length);
  assert.deepEqual([...h.view.state.selected], ["one"]);
  assert.equal(h.catalogCalls, 1);
  h.update({ active: false });
  stream.onUpdate({ accountKey: "another-account", rows: [], loading: false });
  assert.equal(h.view.state.accountKey, "account-1", "hidden generation cannot publish new rows");
  assert.equal(stream.canRefresh(), false);
  pending.resolve(); await flush(); h.view.dispose();
});

// A linked mini DOM, not an HTML-string stub: replacement really detaches the
// old node and sibling traversal/insertBefore behave like the browser. Native
// layout and focus remain the separate live browser fixture's responsibility.
function linked(node) {
  if (node.linked) return node;
  node.linked = true;
  Object.defineProperties(node, {
    firstChild: { get() { return this.childNodes?.[0] || null; } },
    lastChild: { get() { return this.childNodes?.at(-1) || null; } },
    children: { get() { return this.childNodes?.filter((child) => child.nodeType === 1) || []; } },
    nextSibling: { get() { const children = this.parentNode?.childNodes; return children?.[children.indexOf(this) + 1] || null; } },
    previousSibling: { get() { const children = this.parentNode?.childNodes; return children?.[children.indexOf(this) - 1] || null; } },
  });
  const clone = node.cloneNode;
  node.cloneNode = function (deep) { return linked(clone.call(this, deep)); };
  node.insertBefore = function (child, reference) {
    if (child === reference) return child;
    if (child.parentNode) child.remove();
    const index = reference ? this.childNodes.indexOf(reference) : this.childNodes.length;
    assert.ok(index >= 0, "insertBefore reference must still be attached");
    this.childNodes.splice(index, 0, child); child.parentNode = this; return child;
  };
  for (const child of node.childNodes || []) linked(child);
  return node;
}
const keyed = (key, name = "section", children = []) => element(name, { "data-batch-key": key }, children);
function domShape(node) {
  return node.nodeType === 3 ? node.nodeValue : [node.nodeName, Object.fromEntries(node.attributes.map(({ name, value }) => [name, value])),
    (node.childNodes || []).map(domShape), ...(node.nodeName === "INPUT" ? [node.checked, node.value] : [])];
}

test("batch DOM patch follows replacement nodes and removes all old selection controls on phase changes", () => {
  const h = harness();
  const old = linked(keyed("select", "div", [keyed("search", "label", [element("input", { type: "search" })]), textNode("\n"),
    keyed("toolbar"), textNode("\n"), keyed("filters"), keyed("status", "div"), textNode("\n"), keyed("list", "div"), keyed("footer", "footer", [element("button", { "data-batch-action": "preview" })])]));
  const host = linked(element("main", {}, [old]));
  const paused = linked(keyed("paused", "div", [keyed("status", "div"), keyed("hero"), textNode("\n"),
    keyed("list", "div"), element("p", {}, [textNode("Verify before continuing")]),
    element("div", { class: "titles-batch-result-actions" }, [element("button", { "data-batch-action": "reconcile" })])]));
  h.context.patchNode(old, paused);
  assert.deepEqual(domShape(host.firstChild), domShape(paused));
  assert.deepEqual(host.firstChild.children.map((child) => child.getAttribute("data-batch-key")), ["status", "hero", "list", null, null]);
});

test("same-phase DOM patch cannot leave duplicate reconcile buttons after notice insertion/removal", () => {
  const h = harness();
  const make = (warning, disabled) => linked(keyed("paused", "div", [keyed("status", "div"), keyed("hero"),
    ...(warning ? [keyed("notice", "div", [textNode("Unverified")])] : []), textNode("\n"), keyed("list", "div"),
    element("p", {}, [textNode("Verify before continuing")]), element("div", { class: "titles-batch-result-actions" },
      [element("button", { "data-batch-action": "reconcile", ...(disabled ? { disabled: "" } : {}) })])]));
  const old = make(false, false), host = linked(element("main", {}, [old]));
  for (const next of [make(true, true), make(false, false), make(true, false)]) {
    h.context.patchNode(host.firstChild, next); assert.deepEqual(domShape(host.firstChild), domShape(next));
    assert.equal(host.firstChild.children.filter((child) => child.getAttribute("class") === "titles-batch-result-actions").length, 1);
  }
});

test("batch keyed reordering preserves a live radio while moving its row and updates its checked value", () => {
  const h = harness(), radio = element("input", { type: "radio", checked: "" }, [], { checked: true, value: "replace" });
  const old = linked(keyed("preview", "div", [keyed("status", "div"), keyed("a", "article", [radio]), keyed("b", "article")]));
  const host = linked(element("main", {}, [old]));
  const next = linked(keyed("preview", "div", [keyed("b", "article"), keyed("status", "div"),
    keyed("a", "article", [element("input", { type: "radio" }, [], { checked: false, value: "replace" })])]));
  h.context.patchNode(old, next); assert.deepEqual(domShape(host.firstChild), domShape(next));
  assert.equal(host.firstChild.lastChild.firstChild, radio); assert.equal(radio.checked, false);
});

test("keyed list reconciliation reads row keys linearly while preserving every live row", () => {
  const h = harness();
  for (const size of [100, 1000]) {
    let reads = 0;
    const live = Array.from({ length: size }, (_, i) => keyed(`row-${i}`, "button", [textNode(`Chat ${i}`)]));
    for (const row of live) { const get = row.getAttribute; row.getAttribute = function (name) { reads++; return get.call(this, name); }; }
    const old = linked(keyed("list", "div", live));
    const next = linked(keyed("list", "div", [...live].reverse().map((row) => row.cloneNode(true))));
    h.context.patchNode(old, next);
    assert.deepEqual(old.children, [...live].reverse());
    assert.ok(reads <= size * 3, `${size} rows required ${reads} key/attribute reads; do not restore a per-row linear lookup`);
  }
});

test("a large preview validates exact target membership without repeated ID-array scans", async () => {
  const catalogRows = Array.from({ length: 100 }, (_, i) => row(`member-${i}`, `Chat ${i}`));
  const h = harness({ catalogRows, intercept: (action, payload, server) => {
    const value = server.respond(action, payload);
    if (action !== "batch-preview") return value;
    return { ...value, phase: "preview", nextStepId: null, items: value.items.map((item) => ({ ...item, status: "skipped" })) };
  } });
  h.update(); await flush(); h.click("select-all");
  vm.runInContext(`globalThis.validationArrayScans = 0;
    const originalIncludes = Array.prototype.includes;
    Array.prototype.includes = function (...args) {
      if (this.length === 100) globalThis.validationArrayScans++;
      return originalIncludes.apply(this, args);
    };`, h.context);
  h.click("preview"); await flush();
  assert.equal(h.view.state.batch.items.length, 100);
  assert.equal(h.context.validationArrayScans, 0, "membership must use one Set, not scan 100 expected IDs for each returned item");
  h.view.dispose();
});

 test("batch entry resolves the catalog account then reads local status, with no automatic preview or write", async () => {
  const h = harness(); h.update(); await flush(); assert.deepEqual(actions(h), ["batch-status"]); assert.equal(h.catalogCalls, 1);
  assert.deepEqual(h.calls[0].payload.catalogAccountKey, "account-1");
  assert.match(button(h, "preview"), /disabled/); assert.match(h.root.innerHTML, /预览 0 项/);
  assert.equal(h.root.attributes["aria-busy"], "false");
  const unsupported = harness(); unsupported.update({ snapshot: snapshotHarness({ url: "https://chatgpt.com/" }) }); await flush();
  assert.equal(unsupported.calls.length, 0); assert.equal(unsupported.catalogCalls, 0); assert.match(unsupported.root.innerHTML, /请打开普通或项目会话/);
});

test("an initial catalog callback plus the same Promise result publishes rows only once", async () => {
  const initial = { accountKey: "account-1", rows: [rows[0]], loading: false };
  const h = harness({ loadCatalog: async (options) => publishCatalog(options, initial) });
  let markup = h.root.innerHTML, populatedRenders = 0;
  Object.defineProperty(h.root, "innerHTML", {
    get: () => markup,
    set: (value) => { markup = value; if (value.includes('data-batch-select="one"')) populatedRenders++; },
  });
  h.update(); await flush();
  // The account publication renders once immediately; clearing the following
  // local status check renders the same rows once more. The Promise result is
  // deliberately not consumed as a second catalog publication.
  assert.equal(populatedRenders, 2);
  assert.equal(h.catalogCalls, 1); assert.deepEqual(visibleIds(h), ["one"]);
  h.view.dispose();
});

test("an older load Promise result cannot overwrite newer streamed rows, loading or the account gate", async () => {
  for (const latestAccountBlocked of [false, true]) {
    const gate = deferred();
    const initial = { accountKey: "account-old", rows: [row("old", "Old snapshot")], loading: true,
      readErrors: latestAccountBlocked ? [] : [{ code: "AUTH", category: "AUTH" }] };
    const latest = { accountKey: "account-new", rows: [row("new", "New snapshot")], loading: false,
      readErrors: latestAccountBlocked ? [{ code: "AUTH", category: "AUTH" }] : [] };
    let catalogRead = 0;
    const h = harness({ loadCatalog: async (options) => {
      if (catalogRead++ > 0) return publishCatalog(options, latest);
      options.onUpdate(initial); await gate.promise; return initial;
    } });
    h.update(); await flush(); assert.deepEqual(visibleIds(h), ["old"]);
    h.catalog(latest); h.select("new");
    gate.resolve(); await flush();
    assert.deepEqual(visibleIds(h), ["new"]); assert.equal(h.view.state.rows[0].title, "New snapshot");
    assert.equal(h.view.state.accountKey, "account-new"); assert.equal(h.view.state.loading, false);
    assert.equal(h.view.state.catalogIssue, latestAccountBlocked ? "account" : "");
    // Directory hydration is not a receipt acknowledgement for the new owner.
    // A stale successful old-account response must never enable a new write.
    assert.equal(h.view.state.receiptStatusReady, false);
    assert.equal(/disabled/.test(button(h, "preview")), true);
    assert.deepEqual([...h.view.state.selected], ["new"]);
    if (!latestAccountBlocked) {
      const before = h.calls.length;
      h.click("recheck-status"); await flush();
      assert.deepEqual(h.calls.slice(before).map(call => call.action), ["batch-status"]);
      assert.equal(h.calls.at(-1).payload.catalogAccountKey, "account-new");
      assert.equal(h.view.state.receiptStatusReady, true);
      assert.equal(/disabled/.test(button(h, "preview")), false);
    }
    h.view.dispose();
  }
});

test("saved rules appear before selection search, filters and local list tools", async () => {
  const h = harness({ stored: { mode: "created", dateFormat: "dot" } }); h.update(); await flush();
  assert.deepEqual(plain(h.view.state.rules), { mode: "created", dateFormat: "dot" });
  assert.match(h.root.innerHTML, /data-batch-rule=/);
  const order = ["rules", "search", "filters", "toolbar", "list", "footer"].map((key) => h.root.innerHTML.indexOf(`data-batch-key="${key}"`));
  assert.ok(order.every((position, i) => position >= 0 && (!i || position > order[i - 1])));
  h.search("Beta"); assert.match(h.root.innerHTML, /1 个会话 · 已选 0/); assert.match(h.root.innerHTML, /data-batch-filter="all"[^>]*><span>全部<\/span><strong>1/);
  assert.deepEqual(actions(h), ["batch-status"]);
});

test("selection rules recalculate conflict classification synchronously without worker or directory I/O", async () => {
  const target = { conversationId: "night", title: "2026.09.09｜TIDY 标题夜间跟进",
    createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z" };
  const h = harness({ catalogRows: [target], stored: { mode: "created", dateFormat: "dot" } }); h.update(); await flush(); h.select("night");
  h.filter("decision"); assert.deepEqual(visibleIds(h), []);
  h.rule("mode", "range"); assert.deepEqual(visibleIds(h), ["night"]); assert.match(h.root.innerHTML, /1 个会话 · 已选 1/);
  assert.doesNotMatch(h.root.innerHTML, /tidy-loading-flower|aria-busy="true"/);
  h.rule("mode", "created"); assert.deepEqual(visibleIds(h), []);
  h.rule("dateFormat", "iso"); assert.deepEqual(visibleIds(h), ["night"]);
  h.rule("dateFormat", "dot"); assert.deepEqual(visibleIds(h), []); assert.match(h.root.innerHTML, /预览 1 项/);
  await flush(); assert.deepEqual(actions(h), ["batch-status"]); assert.equal(h.catalogCalls, 1);
  assert.deepEqual(plain(h.view.state.rules), { mode: "created", dateFormat: "dot" });
});

test("local sorting defaults to creation descending, supports both fields/directions, and always puts missing dates last", async () => {
  const timed = (id, created, updated) => ({ conversationId: id, title: id, createdAt: created && `2026-09-${created}T00:00:00.000Z`, updatedAt: updated && `2026-09-${updated}T00:00:00.000Z` });
  const catalogRows = [timed("old", "01", "09"), timed("new", "03", "06"), timed("tie-b", "02", "08"), timed("tie-a", "02", "07"),
    timed("missing", null, null), { ...timed("invalid", null, "10"), createdAt: "invalid" }];
  const h = harness({ catalogRows }); h.update(); await flush();
  assert.equal(h.view.state.sortField, "createdAt"); assert.equal(h.view.state.sortDirection, "desc");
  assert.deepEqual(visibleIds(h), ["new", "tie-b", "tie-a", "old", "missing", "invalid"]);
  assert.match(h.root.innerHTML, /value="createdAt" selected>创建时间/); assert.match(h.root.innerHTML, /data-batch-action="sort-direction"[^>]*>↓/);
  h.click("sort-direction"); assert.deepEqual(visibleIds(h), ["old", "tie-b", "tie-a", "new", "missing", "invalid"]);
  h.sort("updatedAt"); assert.deepEqual(visibleIds(h), ["new", "tie-a", "tie-b", "old", "invalid", "missing"]);
  h.click("sort-direction"); assert.deepEqual(visibleIds(h), ["invalid", "old", "tie-b", "tie-a", "new", "missing"]);
  h.select("missing"); h.search("new"); assert.match(h.root.innerHTML, /1 个会话 · 已选 0/); h.click("select-all");
  h.sort("createdAt"); assert.match(h.root.innerHTML, /预览 2 项/); assert.deepEqual([...h.view.state.selected], ["missing", "new"]);
  h.search(""); h.sort("title"); assert.equal(h.view.state.sortField, "createdAt");
  h.catalog({ accountKey: "account-1", rows: [...catalogRows].reverse(), loading: false });
  assert.deepEqual(visibleIds(h), ["new", "tie-b", "tie-a", "old", "missing", "invalid"], "equal dates retain their original stable order");
  h.catalog({ accountKey: "account-1", rows: catalogRows.map((entry) => entry.conversationId === "old" ? { ...entry, createdAt: "2026-09-04T00:00:00.000Z" } : entry), loading: false });
  assert.deepEqual(visibleIds(h), ["old", "new", "tie-b", "tie-a", "missing", "invalid"], "fresh timestamps actually update the sort order");
  assert.deepEqual(actions(h), ["batch-status"]); assert.equal(h.catalogCalls, 1);
  assert.doesNotMatch(h.root.innerHTML, /type="date"|data-batch-page|pagination|上一页|下一页|开始日期|结束日期/);
});

test("background sorted insertions preserve the visible row anchor while an explicit sort returns to the top", async () => {
  const catalogRows = [1, 2, 3, 4].map((day) => ({ ...row(`day-${day}`, `Chat ${day}`), createdAt: `2026-09-0${day}T00:00:00.000Z` }));
  const h = harness({ catalogRows }); h.update(); await flush();
  // Controlled list geometry exercises the actual render/update anchor path;
  // this is a DOM-protocol regression, not a claim of real browser layout QA.
  const list = { dataset: { batchScroll: "select" }, scrollTop: 50, getBoundingClientRect: () => ({ top: 100 }),
    get children() { return visibleIds(h).map((id, index) => ({ dataset: { batchSelect: id }, getBoundingClientRect: () => ({ top: 100 + index * 40 - list.scrollTop, bottom: 140 + index * 40 - list.scrollTop }) })); } };
  h.root.querySelector = (selector) => selector.includes("data-batch-scroll") ? list : null;
  const before = plain(h.context.captureSelectionAnchor(list)); assert.deepEqual(before, { conversationId: "day-3", offset: -10 });
  h.catalog({ accountKey: "account-1", rows: [...catalogRows, { ...row("day-5", "Chat 5"), createdAt: "2026-09-05T00:00:00.000Z" }], loading: false });
  assert.equal(list.scrollTop, 90); assert.deepEqual(plain(h.context.captureSelectionAnchor(list)), before);
  assert.deepEqual(visibleIds(h), ["day-5", "day-4", "day-3", "day-2", "day-1"]);
  h.click("sort-direction"); assert.equal(list.scrollTop, 0); assert.deepEqual(visibleIds(h), ["day-1", "day-2", "day-3", "day-4", "day-5"]);
});

test("search and filters preserve selection; select-all affects current filtered rows only", async () => {
  const h = harness(); h.update(); await flush(); h.select("one"); h.search("Beta"); h.click("select-all");
  assert.deepEqual([...h.view.state.selected], ["one", "two"]); assert.match(h.root.innerHTML, /1 个会话 · 已选 1/);
  assert.match(h.root.innerHTML, /预览 2 项/); h.click("select-all"); assert.deepEqual([...h.view.state.selected], ["one"]);
  assert.match(h.root.innerHTML, /1 个会话 · 已选 0/); assert.match(h.root.innerHTML, /预览 1 项/);
  h.search(""); h.filter("no-head"); h.click("select-all"); assert.deepEqual([...h.view.state.selected], ["one", "four"]);
  assert.match(h.root.innerHTML, /2 个会话 · 已选 2/);
  h.filter("has-head"); assert.equal(h.view.state.selected.size, 2); assert.match(h.root.innerHTML, /2 个会话 · 已选 0/);
  assert.match(h.root.innerHTML, /预览 2 项/);
  h.click("select-all"); assert.match(h.root.innerHTML, /2 个会话 · 已选 2/); assert.match(h.root.innerHTML, /预览 4 项/);
  h.click("select-all"); assert.deepEqual([...h.view.state.selected], ["one", "four"]);
  assert.match(h.root.innerHTML, /2 个会话 · 已选 0/); assert.match(h.root.innerHTML, /预览 2 项/);
});

test("apple search counts visible selected rows while its preview retains two hidden selections", async () => {
  const fruits = [row("banana", "香蕉讨论"), row("orange", "橘子讨论"), row("apple-1", "苹果一"), row("apple-2", "苹果二"), row("apple-3", "苹果三")];
  const h = harness({ catalogRows: fruits }); h.update(); await flush(); h.select("banana"); h.select("orange");
  h.search("苹果"); assert.match(h.root.innerHTML, /3 个会话 · 已选 0/); assert.match(h.root.innerHTML, /预览 2 项/);
  h.select("apple-1"); assert.match(h.root.innerHTML, /3 个会话 · 已选 1/); assert.match(h.root.innerHTML, /预览 3 项/);
  h.click("select-all"); assert.match(h.root.innerHTML, /3 个会话 · 已选 3/); assert.match(h.root.innerHTML, /预览 5 项/);
  h.click("select-all"); assert.match(h.root.innerHTML, /3 个会话 · 已选 0/); assert.match(h.root.innerHTML, /预览 2 项/);
  assert.deepEqual([...h.view.state.selected], ["banana", "orange"]); assert.deepEqual(actions(h), ["batch-status"]);
});

test("the supplied dotted TIDY title belongs to all/dated filters and only enters conflict when the target differs", async () => {
  const title = "2026.09.09｜TIDY 标题夜间跟进";
  const sameDay = { createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T12:00:00.000Z" };
  // Only the title text is user-supplied. These controlled metadata values make
  // the target-date distinction reproducible without claiming live verification.
  for (const differs of [false, true]) {
    const actual = { conversationId: "tidy-night", title, ...sameDay,
      ...(differs ? { updatedAt: "2026-09-10T00:00:00.000Z" } : {}) };
    const catalogRows = [actual, { conversationId: "plain", title: "普通会话", ...sameDay },
      { conversationId: "other-date", title: "2026.09.08｜另一个日期标题", ...sameDay }];
    const h = harness({ catalogRows, stored: { mode: "range", dateFormat: "dot" } }); h.update(); await flush();
    const visibleIds = () => [...h.root.innerHTML.matchAll(/data-batch-select="([^"]+)"/g)].map((match) => match[1]);
    const counts = () => Object.fromEntries([...h.root.innerHTML.matchAll(/data-batch-filter="([^"]+)"[^>]*><span>[^<]+<\/span><strong>(\d+)<\/strong>/g)]
      .map((match) => [match[1], Number(match[2])]));
    const expectedCounts = { all: 3, "no-head": 1, "has-head": 2, decision: differs ? 2 : 1 };
    assert.deepEqual(counts(), expectedCounts);
    assert.deepEqual(visibleIds(), ["tidy-night", "plain", "other-date"]);
    const target = h.server.model(actual, { mode: "range", dateFormat: "dot", timeZone: "Asia/Singapore", locale: "zh-CN" });
    assert.equal(target.hasDateHead, true); assert.equal(target.needsDecision, differs); assert.equal(target.noOp, !differs);
    h.filter("no-head"); assert.deepEqual(visibleIds(), ["plain"]); assert.deepEqual(counts(), expectedCounts);
    h.filter("has-head"); assert.deepEqual(visibleIds(), ["tidy-night", "other-date"]); assert.deepEqual(counts(), expectedCounts);
    h.filter("decision"); assert.deepEqual(visibleIds(), differs ? ["tidy-night", "other-date"] : ["other-date"]);
    assert.deepEqual(counts(), expectedCounts); h.filter("all"); assert.deepEqual(visibleIds(), ["tidy-night", "plain", "other-date"]);
    h.search("TIDY 标题夜间跟进"); assert.deepEqual(counts(), { all: 1, "no-head": 0, "has-head": 1, decision: differs ? 1 : 0 });
    h.filter("decision"); assert.deepEqual(visibleIds(), differs ? ["tidy-night"] : []);
    assert.deepEqual(actions(h), ["batch-status"]);
  }
});

test("removal is a dated-filter secondary entry, clears assignment selection and disables date-only titles", async () => {
  const h = harness(); h.update(); await flush(); assert.equal(button(h, "remove"), undefined);
  h.select("one"); h.filter("has-head"); h.click("remove"); assert.equal(h.view.state.selected.size, 0);
  assert.doesNotMatch(h.root.innerHTML, /data-batch-rule=/); assert.match(h.root.innerHTML, /data-batch-sort-field/);
  assert.match(h.root.innerHTML, /请选择要移除日期的会话/);
  assert.match(h.root.innerHTML, /<button[^>]*data-batch-select="three"[^>]*disabled/);
  h.click("select-all"); assert.deepEqual([...h.view.state.selected], ["two"]);
  h.click("exit-remove"); assert.equal(h.view.state.selected.size, 0); assert.equal(h.view.state.filter, "has-head");
  h.search("2020-01-01"); h.search("nothing"); assert.equal(button(h, "remove"), undefined);
});

test("explicit preview returns every local recipe in one worker receipt and never writes", async () => {
  const h = harness(); await review(h);
  assert.deepEqual(actions(h), ["batch-status", "batch-preview"]);
  assert.equal(h.view.state.batch.phase, "preview"); assert.match(h.root.innerHTML, /本次处理 2 个/);
  assert.match(h.root.innerHTML, /标题日期与当前规则冲突 · 1 个/); assert.match(h.root.innerHTML, /data-batch-rule="mode"/);
  assert.ok(h.calls.every((call) => call.payload.expectedConversationId === "owner"));
});

test("a failed preview resumes a gate-paused partial catalog once without retrying preview or clearing its error", async () => {
  const previewGate = deferred(), resumedCatalog = deferred(), catalogPorts = [];
  const h = harness({ loadCatalog: async (options) => {
    catalogPorts.push(options); return publishCatalog(options, catalogPorts.length === 1
      ? { accountKey: "account-1", rows: [rows[0]], loading: true, partial: true }
      : await resumedCatalog.promise);
  }, intercept: (action, payload, server) => action === "batch-preview" ? previewGate.promise : server.respond(action, payload) });
  h.update(); await flush(); h.select("one"); h.click("preview");
  assert.equal(catalogPorts[0].canRefresh(), false);
  // The directory's in-flight page finishes after the preview gate closes.
  catalogPorts[0].onUpdate({ accountKey: "account-1", rows: [rows[0]], loading: false, partial: true, pauseReason: "inactive" });
  previewGate.reject(Object.assign(new Error("metadata unavailable"), { code: "CONTEXT_MISMATCH" })); await flush();
  assert.equal(h.catalogCalls, 2); assert.equal(catalogPorts[1].canRefresh(), true); assert.equal(catalogPorts[1].retry, undefined);
  assert.equal(h.view.state.batch, null); assert.equal(h.view.state.busy, null); assert.equal(h.view.state.error, "titlesConflict");
  assert.match(h.root.innerHTML, /预览过期/); assert.deepEqual([...h.view.state.selected], ["one"]);
  assert.deepEqual(actions(h), ["batch-status", "batch-preview"]);
  resumedCatalog.resolve({ accountKey: "account-1", rows, loading: false, partial: false }); await flush();
  assert.equal(h.view.state.rows.length, 4); assert.equal(h.view.state.error, "titlesConflict");
  h.update(); await flush(); assert.equal(h.catalogCalls, 2); assert.deepEqual(actions(h), ["batch-status", "batch-preview"]);
});

test("successful local preview never reopens selection's catalog", async () => {
  const h = harness(); await review(h, ["one"]);
  assert.equal(h.catalogCalls, 1); assert.equal(h.view.state.batch.phase, "preview");
  assert.equal(actions(h).filter((action) => action === "batch-preview").length, 1);
  assert.equal(actions(h).includes("batch-apply"), false);
});

test("shared rules changed while preview is in flight are adopted once by local replan after its receipt", async () => {
  const waiting = deferred();
  const h = harness({ intercept: (action, payload, server) => {
    const result = server.respond(action, payload);
    return action === "batch-preview" ? waiting.promise.then(() => result) : result;
  } });
  h.update(); await flush(); h.select("one"); h.click("preview");
  const controller = h.context.getTitleRulesController();
  controller.update({ dateFormat: "compact" }); controller.update({ mode: "created" });
  assert.equal(h.view.state.rules.dateFormat, "iso", "do not mutate the in-flight request's recipe");
  waiting.resolve(); await flush();
  assert.equal(h.view.state.rules.dateFormat, "compact"); assert.equal(h.view.state.rules.mode, "created");
  assert.deepEqual(actions(h), ["batch-status", "batch-preview", "batch-replan"]);
  assert.equal(h.calls.at(-1).payload.rules.dateFormat, "compact");
  assert.equal(h.calls.at(-1).payload.rules.mode, "created");
  assert.deepEqual(plain(controller.snapshot().rules), { mode: "created", dateFormat: "compact" });
  assert.equal(h.catalogCalls, 1); h.view.dispose();
});

test("an account-status failure still displays newer shared settings without clearing its error or retrying I/O", async () => {
  const waiting = deferred(); let failing = false;
  const h = harness({ intercept: (action, payload, server) => action === "batch-status" && failing ? waiting.promise : server.respond(action, payload) });
  h.update(); await flush(); h.select("one"); h.update({ active: false }); failing = true;
  h.update({ active: true }); await flush();
  h.context.getTitleRulesController().update({ dateFormat: "dot" });
  waiting.reject({ code: "TITLE_AUTH_REQUIRED" }); await flush();
  assert.equal(h.view.state.rules.dateFormat, "dot"); assert.equal(h.view.state.error, "titlesAuthPending");
  assert.deepEqual([...h.view.state.selected], ["one"]);
  assert.deepEqual(actions(h), ["batch-status", "batch-status"]);
  assert.equal(h.catalogCalls, 2, "reentry revalidates the catalog account once before local status");
  assert.match(button(h, "preview"), /disabled/); h.view.dispose();
});

test("disposed batch views unsubscribe from the shared rule owner", async () => {
  const h = harness(); h.update(); await flush();
  const html = h.root.innerHTML, count = h.calls.length, controller = h.context.getTitleRulesController();
  h.view.dispose(); controller.update({ mode: "created", dateFormat: "slash" }); await flush();
  assert.equal(h.root.innerHTML, html); assert.equal(h.calls.length, count);
  assert.equal(h.view.state.rules.dateFormat, "iso");
});

test("a shared notification cannot clear or retry a failed replan; explicit review adopts its latest rules", async () => {
  let fail = true;
  const h = harness({ intercept: (action, payload, server) => {
    if (action === "batch-replan" && fail) throw { code: "TITLE_RATE_LIMITED" };
    return server.respond(action, payload);
  } });
  await review(h, ["one"]); h.rule("dateFormat", "dot"); await flush();
  assert.equal(h.view.state.error, "titlesRateLimited");
  const count = h.calls.length;
  h.context.getTitleRulesController().update({ mode: "created" }); await flush();
  assert.equal(h.view.state.error, "titlesRateLimited"); assert.equal(h.calls.length, count);
  fail = false; h.click("refresh-preview"); await flush();
  const retry = h.calls.find(call => call.action === "batch-retry-preview");
  assert.equal(retry.payload.rules.mode, "created"); assert.equal(retry.payload.rules.dateFormat, "dot");
  assert.equal(h.view.state.error, ""); assert.equal(h.view.state.rules.mode, "created");
  assert.ok(h.calls.every(call => !["batch-apply", "batch-step"].includes(call.action))); h.view.dispose();
});

test("late preview failures cannot restart a hidden, disposed, or changed owner's catalog", async () => {
  for (const abandon of ["hide", "dispose", "ineligible", "navigate"]) {
    const pending = deferred();
    const h = harness({ intercept: (action, payload, server) => action === "batch-preview" ? pending.promise : server.respond(action, payload) });
    h.update(); await flush(); h.select("one"); h.click("preview"); await flush();
    if (abandon === "hide") h.update({ active: false });
    else if (abandon === "dispose") h.view.dispose();
    else h.update({ snapshot: abandon === "ineligible" ? snapshotHarness({ url: "https://chatgpt.com/" }) : snapshot("new-owner") });
    await flush(); const count = h.catalogCalls, before = actions(h);
    pending.reject(new Error("Old preview failed")); await flush();
    assert.equal(h.catalogCalls, count, abandon); assert.deepEqual(actions(h), before, abandon);
    assert.equal(actions(h).includes("batch-apply"), false);
  }
});

test("radio and format changes render synchronously without flower; queued replan uses latest returned batch ID", async () => {
  const first = deferred(), second = deferred(); let replans = 0;
  const h = harness({ intercept: (action, payload, server) => {
    if (action === "batch-replan") { const result = server.respond(action, payload); return (++replans === 1 ? first : second).promise.then(() => result); }
    return server.respond(action, payload);
  } }); await review(h);
  const originalId = h.view.state.batch.batchId; h.decide("two", "replace");
  assert.match(h.root.innerHTML, /value="replace" checked/); assert.doesNotMatch(h.root.innerHTML, /tidy-loading-flower|aria-busy="true"/);
  assert.match(h.root.innerHTML, /应用 2 项/); assert.match(button(h, "apply"), /disabled/);
  h.rule("dateFormat", "dot"); h.decide("two", "stack");
  assert.match(h.root.innerHTML, /value="stack" checked/); assert.match(h.root.innerHTML, /2026\.08\.01/);
  assert.equal(actions(h).filter((a) => a === "batch-replan").length, 1);
  assert.doesNotMatch(h.root.innerHTML.match(/<select[^>]*data-batch-rule="dateFormat"[^>]*>/)[0], /disabled/);
  first.resolve(); await flush();
  const calls = h.calls.filter((c) => c.action === "batch-replan"); assert.equal(calls.length, 2);
  assert.equal(calls[0].payload.batchId, originalId); assert.notEqual(calls[1].payload.batchId, originalId);
  assert.equal(calls[1].payload.decisions.two, "stack"); assert.equal(calls[1].payload.rules.dateFormat, "dot");
  second.resolve(); await flush(); assert.doesNotMatch(button(h, "apply"), /disabled/);
  assert.equal(actions(h).filter((a) => a === "batch-prepare-step").length, 0);
});

test("a local choice that changes initial exact match into conflict accepts its radio while replan is pending", async () => {
  const delayed = deferred();
  const h = harness({ catalogRows: [row("one", "2026-08-01 ~ 09-01 | Alpha")], intercept: (action, payload, server) => {
    const result = server.respond(action, payload); return action === "batch-replan" ? delayed.promise.then(() => result) : result;
  } }); await review(h, ["one"]); h.rule("mode", "created"); h.decide("one", "replace");
  assert.equal(h.view.state.decisions.one, "replace"); assert.match(h.root.innerHTML, /value="replace" checked/);
  delayed.resolve(); await flush();
});

test("explicit confirm alone authorizes sequential steps and locks navigation until verified results", async () => {
  const gate = deferred(); let steps = 0;
  const h = harness({ intercept: (action, payload, server) => action === "batch-step" && ++steps === 1 ? gate.promise.then(() => server.respond(action, payload)) : server.respond(action, payload) });
  await review(h, ["one", "four"]); h.click("apply"); await flush();
  assert.equal(h.view.canLeave(), false); assert.deepEqual(h.busy, [true]); assert.match(h.root.innerHTML, /正在应用中/);
  h.dispatch({ batchAction: "apply" }); assert.equal(actions(h).filter((a) => a === "batch-apply").length, 1);
  gate.resolve(); await flush(); assert.equal(h.view.canLeave(), true); assert.deepEqual(h.busy, [true, false]);
  assert.equal(actions(h).filter((a) => a === "batch-step").length, 2); assert.equal(h.changed, 1);
  assert.match(h.root.innerHTML, /已更新 2 个会话的标题日期/); assert.doesNotMatch(h.root.innerHTML, /0 项失败|撤销/);
});

test("settled titles update selection and survive a late stale directory page", async () => {
  const h = harness(); await review(h, ["one"]); h.click("apply"); await flush(); const savedTitle = h.view.state.batch.items[0].current.title;
  h.click("finish"); assert.match(h.root.innerHTML, new RegExp(savedTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  h.catalog({ accountKey: "account-1", rows, loading: false, partial: false });
  assert.equal(h.view.state.rows.find((r) => r.conversationId === "one").title, savedTitle);
  h.catalog({ accountKey: "account-1", rows: [{ ...rows[0], title: "Later phone edit", updatedAt: "2026-09-02T00:00:00.000Z" }], loading: false });
  assert.equal(h.view.state.rows[0].title, "Later phone edit"); assert.equal(h.view.state.settledRows.has("one"), false);
});

test("a newly scanned row releases the settled UI overlay even with equal or missing server time", async () => {
  for (const updatedAt of [rows[0].updatedAt, null]) {
    const h = harness(); await review(h, ["one"]); h.click("apply"); await flush();
    const saved = h.view.state.batch.items[0].current, observed = h.view.state.settledRows.get("one");
    assert.equal(observed.current, saved); assert.equal(typeof observed.observedAt, "number");
    assert.equal(Object.hasOwn(saved, "observedAt"), false, "observation clocks stay outside conversation metadata");
    h.click("finish"); await flush();
    const corrected = { ...rows[0], title: "Phone corrected title", updatedAt, catalogGeneration: "fresh-scan" };
    const publish = (snapshotStartedAt, generation, rowGeneration = corrected.catalogGeneration) => h.catalog({
      accountKey: "account-1", rows: [{ ...corrected, catalogGeneration: rowGeneration }], loading: false,
      snapshotStartedAt, generation,
    });
    publish(observed.observedAt, "fresh-scan");
    assert.equal(h.view.state.rows[0].title, saved.title, "a scan started no later than readback remains stale");
    publish(observed.observedAt + 1, "fresh-scan", "retained-old-scan");
    assert.equal(h.view.state.rows[0].title, saved.title, "a retained row does not acquire a newer scan's authority");
    publish(observed.observedAt + 1, undefined, undefined);
    assert.equal(h.view.state.rows[0].title, saved.title, "missing generation is not proof of a new observation");
    publish(observed.observedAt + 1, "fresh-scan");
    assert.equal(h.view.state.rows[0].title, corrected.title); assert.equal(h.view.state.rows[0].updatedAt, updatedAt);
    assert.equal(h.view.state.settledRows.has("one"), false);
    assert.equal(Object.hasOwn(h.view.state.rows[0], "observedAt"), false);
  }
});

test("the catalog refresh port grants selection-only idle reads and the view owns no polling timer", async () => {
  const gates = [], pending = deferred();
  const h = harness({ loadCatalog: async (options) => {
    gates.push(options.canRefresh); return publishCatalog(options, { accountKey: "account-1", rows, loading: false, partial: false });
  }, intercept: (action, payload, server) => action === "batch-preview" ? pending.promise.then(() => server.respond(action, payload)) : server.respond(action, payload) });
  h.update(); await flush(); const canRefresh = gates[0]; assert.equal(typeof canRefresh, "function"); assert.equal(canRefresh(), true);
  h.select("one"); assert.equal(canRefresh(), true); assert.equal(h.catalogCalls, 1);
  h.click("preview"); assert.equal(canRefresh(), false, "preview dispatch is busy even before a batch ID returns");
  pending.resolve(); await flush(); assert.equal(canRefresh(), false, "review does not refresh the directory");
  h.rule("dateFormat", "dot"); await flush(); assert.equal(canRefresh(), false); assert.equal(h.catalogCalls, 1);
  h.click("back"); await flush(); assert.equal(h.catalogCalls, 2, "explicit back restarts catalog despite cached rows");
  assert.equal(gates.at(-1)(), true); assert.deepEqual([...h.view.state.selected], ["one"]);
  const previousGate = gates.at(-1); h.update({ active: false }); assert.equal(previousGate(), false);
  h.update({ active: true }); await flush(); assert.equal(previousGate(), false, "a retired UI context cannot grant a future refresh");
  assert.equal(gates.at(-1)(), true); h.view.dispose(); assert.equal(gates.at(-1)(), false);
  assert.doesNotMatch(source("src/features/titles/ui/title-batch-view.js"), /\bset(?:Interval|Timeout)\s*\(/);
});

test("finish reopens catalog while preserving the explicit receipt dismissal boundary", async () => {
  const gates = [];
  const h = harness({ loadCatalog: async (options) => {
    gates.push(options.canRefresh); return publishCatalog(options, { accountKey: "account-1", rows, loading: false, partial: false });
  } }); await review(h, ["one"]); h.click("apply"); await flush();
  const resultId = h.view.state.batch.batchId; assert.equal(gates[0](), false); assert.equal(h.catalogCalls, 1);
  h.click("finish"); await flush(); assert.equal(h.catalogCalls, 2); assert.equal(gates.at(-1)(), true);
  assert.equal(h.view.state.dismissedBatchId, resultId); assert.equal(h.view.state.selected.size, 0);
  h.update({ active: false }); h.update({ active: true }); await flush();
  assert.equal(h.view.state.batch, null); assert.equal(h.catalogCalls, 3); assert.equal(h.view.state.dismissedBatchId, resultId);
  const gate = gates.at(-1); h.update({ snapshot: snapshotHarness({ url: "https://chatgpt.com/" }) });
  assert.equal(gate(), true, "an already-open directory is independent of the new-chat route");
  assert.match(button(h, "preview"), /disabled/, "new-chat has no saved owner for a title preview");
});

test("explicit back and successful completion both return to selection on module reentry", async () => {
  const preview = harness(); await review(preview, ["one"]); preview.click("back");
  preview.update({ active: false }); preview.update({ active: true }); await flush();
  assert.equal(preview.view.state.batch, null); assert.ok(button(preview, "preview"));
  assert.deepEqual([...preview.view.state.selected], ["one"]);
  const done = harness(); await review(done, ["one"]); done.click("apply"); await flush();
  assert.equal(done.view.state.batch.phase, "result", "this run still shows its completion receipt");
  const receipt = plain(done.server.job), before = actions(done);
  done.update({ active: false }); done.update({ active: true }); await flush();
  assert.equal(done.view.state.batch, null); assert.ok(button(done, "preview"));
  assert.deepEqual(plain(done.server.job), receipt, "leaving a result never deletes the durable receipt");
  assert.deepEqual(actions(done).slice(before.length), ["batch-status"], "reentry is read-only");
  done.update({ active: false }); done.update({ active: true }); await flush();
  assert.equal(done.view.state.batch, null); assert.ok(button(done, "preview"));
});

test("a fresh view observes historical success without restoring its result page or issuing writes", async () => {
  const original = harness(); await review(original, ["one", "four"]); original.click("apply"); await flush();
  const receipt = plain(original.server.job);
  for (const status of ["verified", "accepted", "skipped"]) {
    const historical = plain(receipt); historical.items[0].status = status;
    const reopened = harness({ initialJob: historical }); reopened.update(); await flush();
    assert.equal(reopened.view.state.batch, null, status);
    assert.ok(button(reopened, "preview")); assert.equal(reopened.view.state.receiptStatusReady, true);
    assert.deepEqual(actions(reopened), ["batch-status"]);
    assert.deepEqual(reopened.server.job, historical);
    assert.equal(reopened.view.state.settledRows.size, 0, "historical receipt is not a fresh title observation");
  }
});

test("failed, pending, uncertain and unfinished historical receipts remain available on reentry", async () => {
  const original = harness(); await review(original, ["one", "four"]); original.click("apply"); await flush();
  for (const status of ["failed", "conflict", "pending", "uncertain", "ready"]) {
    const receipt = plain(original.server.job); receipt.items[0].status = status; receipt.items[0].settled = false;
    const reopened = harness({ initialJob: receipt }); reopened.update(); await flush();
    assert.equal(reopened.view.state.batch.items[0].status, status);
    reopened.update({ active: false }); reopened.update({ active: true }); await flush();
    assert.equal(reopened.view.state.batch.items[0].status, status);
    assert.deepEqual(actions(reopened), ["batch-status", "batch-status"]);
    assert.deepEqual(reopened.server.job, receipt);
  }
});

test("historical success still requires a valid receipt before returning to selection", async () => {
  const original = harness(); await review(original, ["one"]); original.click("apply"); await flush();
  const receipt = plain(original.server.job); receipt.items[0].current.conversationId = "wrong-target";
  const reopened = harness({ initialJob: receipt }); reopened.update(); await flush();
  assert.equal(reopened.view.state.receiptStatusReady, false);
  assert.match(button(reopened, "preview"), /disabled/); assert.ok(button(reopened, "recheck-status"));
  assert.deepEqual(actions(reopened), ["batch-status"]);
});

test("historical success cannot overwrite newer catalog titles or refresh an old observation timestamp", async () => {
  const original = harness(); await review(original, ["one"]); original.click("apply"); await flush();
  const receipt = plain(original.server.job), latest = { ...rows[0], title: "Newer external title", updatedAt: "2026-09-12T00:00:00.000Z" };
  const reopened = harness({ initialJob: receipt, catalogRows: [latest, ...rows.slice(1)] }); reopened.update(); await flush();
  assert.equal(reopened.view.state.batch, null);
  assert.equal(reopened.view.state.rows[0].title, latest.title);
  assert.equal(reopened.view.state.rows[0].updatedAt, latest.updatedAt);
  assert.equal(reopened.view.state.settledRows.size, 0);
  assert.deepEqual(actions(reopened), ["batch-status"]);
});

test("dismissal never exempts a reentered receipt from target and account validation", async () => {
  for (const corrupt of [job => { job.items[0].current.conversationId = "wrong-target"; }, job => { job.catalogAccountKey = "wrong-account"; }]) {
    const h = harness(); await review(h, ["one"]); h.click("apply"); await flush();
    h.update({ active: false }); const receipt = plain(h.server.job); corrupt(receipt); h.server.job = receipt;
    h.update({ active: true }); await flush();
    assert.equal(h.view.state.receiptStatusReady, false);
    assert.match(button(h, "preview"), /disabled/); assert.ok(button(h, "recheck-status"));
    assert.equal(h.view.state.accountKey, "account-1", "historical receipt cannot change the catalog owner");
    assert.equal(actions(h).filter(action => action === "batch-step").length, 1);
  }
});

test("reentering selection resumes its partial directory and drops cross-account selection", async () => {
  let account = "account-1";
  const h = harness({ loadCatalog: async (options) => publishCatalog(options, { accountKey: account, rows, loading: false, partial: true }) });
  h.update(); await flush(); h.select("one"); h.update({ active: false }); h.update({ active: true }); await flush();
  assert.equal(h.catalogCalls, 2); assert.deepEqual([...h.view.state.selected], ["one"]);
  h.update({ active: false }); account = "account-2"; h.update({ active: true }); await flush();
  assert.equal(h.catalogCalls, 3); assert.equal(h.view.state.selected.size, 0); assert.equal(h.view.state.accountKey, "account-2");
});

test("partial directory source errors have explicit retry without adding a permanent refresh button", async () => {
  const requests = [];
  const h = harness({ loadCatalog: async (options) => {
    requests.push(options.retry === true); return publishCatalog(options, { accountKey: "account-1", rows, loading: false,
      partial: !options.retry, error: !options.retry, ...(options.retry ? {} : { errorOrigin: "current" }) });
  } }); h.update(); await flush(); h.select("one");
  assert.ok(button(h, "reload")); assert.match(h.root.innerHTML, /列表未读全/); h.click("reload"); await flush();
  assert.deepEqual(requests, [false, true]); assert.deepEqual([...h.view.state.selected], ["one"]);
  assert.equal(button(h, "reload"), undefined); assert.equal(h.view.state.catalogError, false);
});

test("enabled directory retry still runs after owner loss interrupts the first pending receipt lookup", async () => {
  const firstStatus = deferred(), retryFlags = [], statusOwners = [];
  const retained = { accountKey: "account-1", rows, loading: false, phase: "paused", errorOrigin: "current",
    readErrors: [{ code: "NETWORK", category: "NETWORK", retryable: true }] };
  const h = harness({ loadCatalog: async options => {
    retryFlags.push(options.retry === true);
    return publishCatalog(options, options.retry ? { accountKey: "account-1", rows, loading: false, phase: "settled" } : retained);
  }, intercept: (action, payload, server) => {
    if (action === "batch-status") {
      statusOwners.push(payload.expectedConversationId);
      if (statusOwners.length === 1) return firstStatus.promise;
    }
    return server.respond(action, payload);
  } });
  h.update(); await flush();
  assert.equal(h.view.state.initialized, false); assert.equal(h.view.state.busy, "status");
  assert.match(button(h, "reload"), /disabled/);
  h.dispatch({ batchAction: "reload" }); await flush(); assert.deepEqual(retryFlags, [false]);

  h.update({ snapshot: null }); await flush();
  assert.equal(h.view.state.eligible, false); assert.equal(h.view.state.busy, null);
  assert.doesNotMatch(button(h, "reload"), /disabled/);
  h.select("one"); h.click("reload"); await flush();
  assert.deepEqual(retryFlags, [false, true], "an enabled catalog action cannot silently enter an owner-bound no-op");
  assert.equal(h.view.state.catalogIssue, ""); assert.deepEqual([...h.view.state.selected], ["one"]);
  assert.equal(h.view.state.initialized, false, "directory recovery does not invent a completed owner receipt check");
  assert.match(button(h, "preview"), /disabled/); assert.deepEqual(statusOwners, ["owner"]);
  h.dispatch({ batchAction: "preview" }); await flush(); assert.deepEqual(actions(h), ["batch-status"]);

  firstStatus.resolve({ batchId: null }); await flush();
  assert.equal(h.view.state.initialized, false, "late receipt from the abandoned owner remains quarantined");
  h.update({ snapshot: snapshot("new-owner") }); await flush();
  assert.equal(h.view.state.initialized, true); assert.deepEqual(statusOwners, ["owner", "new-owner"]);
  assert.equal(actions(h).includes("batch-preview"), false); assert.equal(actions(h).includes("batch-apply"), false);
  h.view.dispose();
});

test("retrying an incomplete first receipt initialization preserves the explicit directory retry flag", async () => {
  const retryFlags = []; let statusCalls = 0;
  const h = harness({ loadCatalog: async options => {
    retryFlags.push(options.retry === true);
    return publishCatalog(options, { accountKey: "account-1", rows, loading: false,
      ...(options.retry ? {} : { errorOrigin: "current", readErrors: [{ code: "NETWORK", category: "NETWORK", retryable: true }] }) });
  }, intercept: (action, payload, server) => {
    if (action === "batch-status" && ++statusCalls === 1) throw Object.assign(new Error("Synthetic receipt read failed"), { code: "STORAGE_ERROR" });
    return server.respond(action, payload);
  } });
  h.update(); await flush(); assert.equal(h.view.state.initialized, false); assert.equal(h.view.state.error, "titlesReadFailed");
  h.click("reload"); await flush();
  assert.deepEqual(retryFlags, [false, true], "manual retry must not fall back to a passive cached-catalog load");
  assert.equal(statusCalls, 2); assert.equal(h.view.state.initialized, true); assert.equal(h.view.state.catalogIssue, "");
  assert.deepEqual(actions(h), ["batch-status", "batch-status"]); h.view.dispose();
});

test("a failed reentry receipt check cannot be cleared by a successful catalog reload", async () => {
  let failing = false;
  const h = harness({ intercept: (action, payload, server) => {
    if (action === "batch-status" && failing) throw Object.assign(new Error("Synthetic receipt unavailable"), { code: "STORAGE_ERROR" });
    return server.respond(action, payload);
  } });
  h.update(); await flush(); h.select("one"); h.update({ active: false }); failing = true; h.update({ active: true }); await flush();
  assert.equal(h.view.state.error, "titlesReadFailed"); assert.match(button(h, "preview"), /disabled/);
  assert.match(h.root.innerHTML, /读取失败，请重试/);
  assert.doesNotMatch(h.root.innerHTML, /结果未明|预览过期/);
  h.dispatch({ batchAction: "preview" }); await flush(); assert.equal(actions(h).includes("batch-preview"), false);
  h.catalog({ accountKey: "account-1", rows, loading: false, phase: "settled", readErrors: [] });
  assert.equal(h.view.state.error, "titlesReadFailed", "directory success is not a receipt observation");
  h.click("recheck-status"); await flush();
  assert.equal(actions(h).filter(action => action === "batch-status").length, 3, "retry must reach the failed receipt lookup again");
  assert.equal(h.view.state.error, "titlesReadFailed"); assert.match(button(h, "preview"), /disabled/);
  h.search("Alpha"); h.sort("updatedAt"); assert.equal(h.view.state.sortField, "updatedAt");
  failing = false; h.click("recheck-status"); await flush();
  assert.equal(actions(h).filter(action => action === "batch-status").length, 4);
  assert.equal(h.view.state.error, ""); assert.doesNotMatch(button(h, "preview"), /disabled/);
  assert.deepEqual([...h.view.state.selected], ["one"]); h.view.dispose();
});

test("status read failures never claim a preview expired and retry does not force a directory scan", async () => {
  for (const code of ["CONTEXT_MISMATCH", "TITLE_PREVIEW_REQUIRED", "TITLE_PLAN_EXPIRED"]) {
    let failing = true;
    const retries = [];
    const h = harness({ loadCatalog: options => {
      retries.push(options.retry === true);
      return publishCatalog(options, { accountKey: "account-1", rows, loading: false });
    }, intercept: (action, payload, server) => {
      if (action === "batch-status" && failing) throw { code };
      return server.respond(action, payload);
    } });
    h.update(); await flush(); h.select("one");
    assert.match(h.root.innerHTML, /读取失败，请重试/);
    assert.doesNotMatch(h.root.innerHTML, /预览过期|检查结果|结果未明/);
    assert.match(button(h, "preview"), /disabled/);
    failing = false; h.click("recheck-status"); await flush();
    assert.deepEqual(retries, [false, false]);
    assert.equal(h.view.state.error, ""); assert.equal(h.view.state.receiptStatusReady, true);
    assert.doesNotMatch(button(h, "preview"), /disabled/);
    assert.deepEqual([...h.view.state.selected], ["one"]);
    assert.deepEqual(actions(h), ["batch-status", "batch-status"]);
    h.view.dispose();
  }
});

test("a retained preview cannot replace or execute its receipt while the reentry status is unconfirmed", async () => {
  let failing = false;
  const h = harness({ intercept: (action, payload, server) => {
    if (action === "batch-status" && failing) throw Object.assign(new Error("Synthetic receipt unavailable"), { code: "STORAGE_ERROR" });
    return server.respond(action, payload);
  } });
  await review(h, ["one"]); h.update({ active: false }); failing = true; h.update({ active: true }); await flush();
  const before = actions(h);
  h.rule("dateFormat", "dot"); h.dispatch({ batchAction: "refresh-preview" }); h.dispatch({ batchAction: "apply" });
  await flush(); assert.deepEqual(actions(h), before, "rule/review/save actions cannot clear a failed receipt status check");
  assert.match(button(h, "apply"), /disabled/); assert.ok(button(h, "recheck-status"));
  failing = false; h.click("recheck-status"); await flush();
  assert.equal(actions(h).at(-1), "batch-status"); assert.equal(actions(h).includes("batch-apply"), false);
  assert.equal(h.view.state.error, ""); h.view.dispose();
});

test("a pending explicit receipt retry retains its error, stays single-flight and unlocks only on status success", async () => {
  const pending = deferred(); let statusCalls = 0;
  const h = harness({ intercept: (action, payload, server) => {
    if (action === "batch-status") {
      statusCalls++;
      if (statusCalls === 2) throw { code: "STORAGE_ERROR" };
      if (statusCalls === 3) return pending.promise;
    }
    return server.respond(action, payload);
  } });
  h.update(); await flush(); h.select("one"); h.update({ active: false }); h.update({ active: true }); await flush();
  h.click("recheck-status"); await flush();
  assert.equal(h.view.state.receiptChecking, true); assert.equal(h.view.state.receiptStatusReady, false);
  assert.equal(h.view.state.error, "titlesReadFailed"); assert.match(button(h, "preview"), /disabled/);
  h.catalog({ accountKey: "account-1", rows, loading: false, phase: "settled" });
  h.dispatch({ batchAction: "recheck-status" }); h.dispatch({ batchAction: "preview" }); h.update(); h.sort("updatedAt"); await flush();
  assert.equal(statusCalls, 3); assert.equal(h.view.state.error, "titlesReadFailed");
  assert.equal(h.view.state.sortField, "updatedAt", "a read-only status check does not disable local list tools");
  pending.resolve({ batchId: null }); await flush();
  assert.equal(h.view.state.receiptStatusReady, true); assert.equal(h.view.state.error, "");
  assert.doesNotMatch(button(h, "preview"), /disabled/); assert.equal(actions(h).includes("batch-preview"), false);
  h.view.dispose();
});

for (const failedRead of ["account", "receipt"]) test(`passive binding changes cannot retry a failed ${failedRead} read behind the receipt gate`, async () => {
  let failing = true;
  const h = harness({ loadCatalog: options => {
    if (failing && failedRead === "account") throw Object.assign(new Error("Synthetic unavailable account"), { code: "HTTP", status: 503 });
    return publishCatalog(options, { accountKey: "account-1", rows, loading: false, phase: "settled" });
  }, intercept: (action, payload, server) => {
    if (failing && failedRead === "receipt" && action === "batch-status") throw { code: "STORAGE_ERROR" };
    return server.respond(action, payload);
  } });
  h.update(); await flush();
  const requests = { catalog: h.catalogCalls, status: actions(h).filter(action => action === "batch-status").length };
  const bound = snapshot(), pending = plain(bound); pending.conversation.bindingStatus = "route-only";
  for (let event = 0; event < 4; event++) { h.update({ snapshot: pending }); h.update({ snapshot: bound }); await flush(); }
  assert.equal(h.catalogCalls, requests.catalog, "binding hydration is not permission to retry account lookup");
  assert.equal(actions(h).filter(action => action === "batch-status").length, requests.status);
  assert.equal(h.view.state.receiptStatusReady, false);
  failing = false; h.click(failedRead === "receipt" ? "recheck-status" : "reload"); await flush();
  assert.equal(h.catalogCalls, requests.catalog + 1, "the explicit recovery action still performs one fresh read");
  assert.equal(h.view.state.receiptStatusReady, true); h.view.dispose();
});

test("owner replacement cannot reuse or receive a late interrupted reentry receipt check", async () => {
  const oldStatus = deferred(), newStatus = deferred(), owners = [];
  const h = harness({ intercept: (action, payload, server) => {
    if (action === "batch-status") {
      owners.push(payload.expectedConversationId);
      if (owners.length === 2) return oldStatus.promise;
      if (owners.length === 3) return newStatus.promise;
    }
    return server.respond(action, payload);
  } });
  h.update(); await flush(); h.select("one"); h.update({ active: false }); h.update({ active: true }); await flush();
  h.update({ snapshot: null }); h.update({ snapshot: snapshot("new-owner") }); await flush();
  assert.deepEqual(owners, ["owner", "owner", "new-owner"]);
  assert.equal(h.view.state.receiptStatusReady, false); assert.match(button(h, "preview"), /disabled/);
  oldStatus.resolve({ batchId: null }); await flush();
  assert.equal(h.view.state.receiptStatusReady, false, "the departed owner's success cannot unlock the new owner");
  newStatus.resolve({ batchId: null }); await flush();
  assert.equal(h.view.state.receiptStatusReady, true); assert.deepEqual([...h.view.state.selected], ["one"]);
  assert.equal(actions(h).includes("batch-preview"), false); h.view.dispose();
});

for (const observation of ["reentry", "stream"]) test(`a ${observation} account mismatch keeps an explicit receipt recheck without querying the old batch in the new account`, async () => {
  let account = "account-1";
  const h = harness({ loadCatalog: options => publishCatalog(options, { accountKey: account, rows, loading: false, phase: "settled" }) });
  await review(h, ["one"]);
  account = "account-2";
  if (observation === "reentry") { h.update({ active: false }); h.update({ active: true }); }
  else h.catalog({ accountKey: account, rows, loading: false, phase: "settled" });
  await flush();
  assert.equal(h.view.state.receiptStatusReady, false); assert.equal(h.view.state.recovery, true);
  assert.equal(h.view.state.error, "titlesAccountChanged");
  assert.ok(button(h, "recheck-status"), "an invalidated receipt must retain a read-only recovery entry");
  assert.doesNotMatch(button(h, "recheck-status"), /disabled/);
  assert.match(button(h, "retry-preview"), /disabled/);
  const statusCount = actions(h).filter(action => action === "batch-status").length;
  h.click("recheck-status"); await flush();
  assert.equal(actions(h).filter(action => action === "batch-status").length, statusCount,
    "the changed directory account must stop recovery before querying an old account's batch receipt");
  assert.equal(h.view.state.receiptStatusReady, false); assert.equal(h.view.state.error, "titlesAccountChanged");
  assert.ok(button(h, "recheck-status"), "a failed-closed account recheck must remain retryable");

  account = "account-1";
  h.catalog({ accountKey: account, rows, loading: false, phase: "settled" }); h.update(); await flush();
  assert.equal(h.view.state.receiptStatusReady, false, "account restoration alone is still not a receipt read");
  h.click("recheck-status"); await flush();
  assert.equal(actions(h).filter(action => action === "batch-status").length, statusCount + 1);
  assert.ok(h.calls.filter(call => call.action === "batch-status").every(call => call.payload.catalogAccountKey === "account-1"));
  assert.equal(h.view.state.receiptStatusReady, true); assert.equal(h.view.state.recovery, false);
  assert.equal(h.view.state.error, ""); assert.equal(button(h, "recheck-status"), undefined);
  assert.equal(actions(h).includes("batch-apply"), false); assert.equal(actions(h).includes("batch-step"), false);
  h.view.dispose();
});

test("loaded rows explain an unavailable conversation owner separately from directory errors", async () => {
  const h = harness(); h.update(); await flush(); h.select("one");
  h.catalog({ accountKey: "account-1", rows, loading: false, errorOrigin: "current", readErrors: [{ code: "UNKNOWN" }] });
  h.update({ snapshot: null }); await flush();
  assert.match(h.root.innerHTML, /data-batch-key="owner-unavailable"/);
  assert.match(button(h, "preview"), /disabled/); assert.equal(h.view.state.rows.length, rows.length);
  h.select("four"); assert.deepEqual([...h.view.state.selected], ["one", "four"]);
  h.update({ snapshot: snapshot("new-owner") }); await flush();
  assert.doesNotMatch(h.root.innerHTML, /data-batch-key="owner-unavailable"/);
  assert.match(h.root.innerHTML, /列表未读全/); h.view.dispose();
});

test("a superseded paused catalog offers Continue without authorizing a fresh generation retry", async () => {
  const retryFlags = [];
  const h = harness({ loadCatalog: async options => {
    retryFlags.push(options.retry === true);
    return publishCatalog(options, { accountKey: "account-1", rows, loading: false, phase: "paused",
      pauseReason: "catalog-superseded", coverageReasons: ["catalog-pending"], readErrors: [] });
  } });
  h.update(); await flush(); h.select("one");
  assert.equal(h.view.state.catalogIssue, "superseded"); assert.equal(h.view.state.catalogError, false);
  assert.ok(button(h, "resume-catalog")); assert.equal(button(h, "reload"), undefined);
  assert.doesNotMatch(button(h, "preview"), /disabled/);
  h.click("resume-catalog"); await flush(); assert.deepEqual(retryFlags, [false, false]);
  assert.deepEqual([...h.view.state.selected], ["one"]); h.view.dispose();
});

test("directory errors distinguish account, 429 and read failure without countdowns or automatic retries", async () => {
  const cases = [
    { readErrors: [{ code: "ACCOUNT_MISMATCH" }, { status: 429 }], issue: "account", notice: /账号未读到/, action: /重试/ },
    { readErrors: [{ code: "HTTP", status: 401 }], issue: "account", notice: /账号未读到/, action: /重试/ },
    { readErrors: [{ code: "AUTH", category: "AUTH" }], issue: "account", notice: /账号未读到/, action: /重试/ },
    { readErrors: [{ code: "HTTP", status: 429, retryable: true }], pauseReason: "rate-limited", errorOrigin: "current", issue: "rate", notice: /操作太快/, action: /重新读取/ },
    { readErrors: [{ code: "NETWORK", category: "NETWORK", retryable: true }], errorOrigin: "current", issue: "read", notice: /列表未读全/, action: /重新读取/ },
    { readErrors: [{ code: "HTTP", status: 403 }], errorOrigin: "current", issue: "read", notice: /列表未读全/, action: /重新读取/ },
  ];
  for (const entry of cases) {
    const requests = [];
    const h = harness({ loadCatalog: async (options) => {
      requests.push(options.retry === true);
      return publishCatalog(options, { accountKey: "account-1", rows, partial: true, loading: false, ...(options.retry ? {} : entry) });
    } }); h.update(); await flush();
    assert.equal(h.view.state.catalogIssue, entry.issue); assert.equal(h.view.state.catalogError, true);
    assert.match(h.root.innerHTML, entry.notice); assert.match(h.root.innerHTML, entry.action);
    assert.doesNotMatch(h.root.innerHTML, /倒计时|\d+\s*秒后|tidy-loading-flower/);
    h.select("one"); h.update(); h.search("Alpha"); h.sort("updatedAt"); await flush(); assert.deepEqual(requests, [false]);
    if (entry.issue === "account") {
      assert.match(button(h, "preview"), /disabled/); h.dispatch({ batchAction: "preview" }); await flush();
      assert.deepEqual(actions(h), ["batch-status"]); assert.deepEqual([...h.view.state.selected], ["one"]);
      h.rule("mode", "created"); assert.equal(h.view.state.rules.mode, "created", "account errors still permit local browsing and rules");
    } else assert.doesNotMatch(button(h, "preview"), /disabled/, "403 is a read failure, not blanket account failure");
    h.click("reload"); await flush(); assert.deepEqual(requests, [false, true]); assert.equal(h.view.state.catalogIssue, "");
    assert.doesNotMatch(button(h, "preview"), /disabled/); assert.deepEqual([...h.view.state.selected], ["one"]);
    assert.equal(button(h, "reload"), undefined); assert.deepEqual(actions(h), ["batch-status"]);
  }
});

test("unsupported catalog notice hides internal failures and offers current conversation mode", async () => {
  const h = harness({ loadCatalog: async (options) => publishCatalog(options, {
    accountKey: "account-1", rows, loading: false, errorOrigin: "current", readErrors: [
      { source: "project:private-project-id", code: "HTTP", category: "INACCESSIBLE", status: 404,
        message: "private-title https://chatgpt.com/private-url", serverCode: "private-server-code" },
      { source: "project:another-private-id", code: "HTTP", category: "INACCESSIBLE", status: 404 },
      { source: "projects", code: "SCHEMA", category: "SCHEMA" },
      { source: "__proto__", code: "private-error-code", category: "private-error-category" },
    ],
  }) }); h.update(); await flush();
  assert.match(h.root.innerHTML, /此列表暂不支持/);
  assert.ok(button(h, "use-current"), "unsupported lists offer current-chat mode, not an ineffective retry");
  assert.equal(button(h, "reload"), undefined);
  assert.doesNotMatch(h.root.innerHTML, /HTTP|SCHEMA|catalog-diagnostics|返回的数据格式/);
  assert.doesNotMatch(h.root.innerHTML, /private-project-id|another-private-id|private-title|private-url|private-server-code|private-error/);
  assert.doesNotMatch(h.root.innerHTML, /请手动刷新/);
  h.select("one"); assert.doesNotMatch(button(h, "preview"), /disabled/);
  h.catalog({ accountKey: "account-1", rows, loading: false, readErrors: [] });
  assert.doesNotMatch(h.root.innerHTML, /HTTP 404|返回的数据格式无法识别/); h.view.dispose();
});

test("unsupported catalog notice is localized without exposing failure details", async () => {
  for (const [language, detail] of [["zh-CN", /此列表暂不支持/],
    ["en", /This list is not supported yet/], ["ja", /この一覧は未対応です/]]) {
    const h = harness({ language, loadCatalog: async () => { throw Object.assign(new Error("secret-response"), {
      details: { code: "SCHEMA", category: "SCHEMA", status: 200 },
    }); } }); h.update(); await flush();
    assert.match(h.root.innerHTML, detail); assert.doesNotMatch(h.root.innerHTML, /HTTP 200|SCHEMA/);
    assert.doesNotMatch(h.root.innerHTML, /secret-response|titlesBatchCatalogSource|titlesBatchCatalogReason/); h.view.dispose();
  }
});

test("failed account status on reentry blocks cached selection preview until account recheck succeeds", async () => {
  let statusFails = false;
  const h = harness({ intercept: (action, payload, server) => {
    if (action === "batch-status" && statusFails) throw Object.assign(new Error("Sign-in expired"), { code: "TITLE_AUTH_EXPIRED" });
    return server.respond(action, payload);
  } }); h.update(); await flush(); h.select("one"); h.update({ active: false }); statusFails = true; h.update({ active: true }); await flush();
  assert.equal(h.view.state.error, "titlesAuthExpired"); assert.match(button(h, "preview"), /disabled/);
  h.dispatch({ batchAction: "preview" }); await flush(); assert.equal(actions(h).includes("batch-preview"), false);
  assert.deepEqual([...h.view.state.selected], ["one"]); h.search("Alpha"); assert.match(h.root.innerHTML, /1 个会话 · 已选 1/);
  statusFails = false; h.click("reload"); await flush(); assert.equal(h.view.state.error, "");
  assert.doesNotMatch(button(h, "preview"), /disabled/); assert.deepEqual([...h.view.state.selected], ["one"]);
});

test("preview remains blocked while an account recheck is pending, without blocking ordinary directory loading", async () => {
  for (const origin of ["catalog", "status"]) {
    const waiting = deferred(); let rechecking = false, failedStatus = false;
    const loaded = { accountKey: "account-1", rows, loading: false, partial: true };
    const h = harness({ loadCatalog: async (options) => publishCatalog(options, rechecking ? await waiting.promise : loaded),
      intercept: (action, payload, server) => {
        if (failedStatus && action === "batch-status") throw { code: "TITLE_AUTH_REQUIRED" };
        return server.respond(action, payload);
      } });
    h.update(); await flush(); h.select("one");
    h.catalog({ ...loaded, loading: true });
    assert.doesNotMatch(button(h, "preview"), /disabled/, "ordinary progressive loading keeps known candidates usable");
    if (origin === "catalog") h.catalog({ ...loaded, readErrors: [{ code: "AUTH" }] });
    else { failedStatus = true; h.update({ active: false }); h.update({ active: true }); await flush(); }
    assert.match(button(h, "preview"), /disabled/);
    rechecking = true; failedStatus = false; h.click("reload"); await flush();
    assert.match(button(h, "preview"), /disabled/, "starting the recheck cannot clear the account gate");
    h.dispatch({ batchAction: "preview" }); h.sort("updatedAt"); await flush();
    assert.equal(actions(h).includes("batch-preview"), false); assert.equal(h.view.state.sortField, "updatedAt");
    assert.deepEqual([...h.view.state.selected], ["one"]);
    waiting.resolve(loaded); await flush();
    assert.doesNotMatch(button(h, "preview"), /disabled/); assert.equal(h.view.state.catalogIssue, "");
    assert.deepEqual([...h.view.state.selected], ["one"]); h.view.dispose();
  }
});

test("initial directory exceptions use catalog-specific account and read messages", async () => {
  for (const error of [Object.assign(new Error("Sign in"), { code: "AUTH", category: "AUTH" }),
    Object.assign(new Error("Sign in"), { details: { code: "HTTP", status: 401 } }),
    Object.assign(new Error("bad schema"), { code: "SCHEMA" })]) {
    const h = harness({ loadCatalog: async () => { throw error; } }); h.update(); await flush();
    const account = error.category === "AUTH" || error.details?.status === 401;
    assert.equal(h.view.state.catalogIssue, account ? "account" : "read");
    assert.match(h.root.innerHTML, account ? /账号未读到/ : /此列表暂不支持/);
    assert.ok(button(h, account ? "reload" : "use-current")); assert.equal(h.view.state.loading, false); assert.equal(h.catalogCalls, 1);
  }
});

test("only a genuinely unfinished paused scan offers Continue; settled unverified or missing dates stay quiet", async () => {
  const requests = [];
  const h = harness({ loadCatalog: async (options) => {
    requests.push(options.retry === true); return publishCatalog(options, { accountKey: "account-1", rows, loading: false, phase: "settled" });
  } }); h.update(); await flush();
  for (const phase of ["settled", "paused"]) {
    h.catalog({ accountKey: "account-1", rows, loading: false, phase, partial: true, readErrors: [],
      coverageReasons: ["shared-projects-unverified", "group-chats-unverified", "catalog-createdAt-missing", "catalog-snapshot-stale"] });
    assert.equal(h.view.state.catalogIssue, ""); assert.doesNotMatch(h.root.innerHTML, /data-batch-key="notice"/);
    assert.equal(button(h, "resume-catalog"), undefined);
  }
  h.catalog({ accountKey: "account-1", rows, loading: false, phase: "paused", partial: true, readErrors: [], coverageReasons: ["catalog-pending"] });
  assert.equal(h.view.state.catalogIssue, "paused"); assert.equal(h.view.state.catalogError, false);
  assert.match(h.root.innerHTML, /列表尚未加载完整，可先选择已显示的会话/); assert.ok(button(h, "resume-catalog"));
  assert.doesNotMatch(h.root.innerHTML, /titles-notice titles-catalog-notice is-warning/);
  h.click("resume-catalog"); await flush(); assert.deepEqual(requests, [false, false]); assert.equal(h.view.state.catalogIssue, "");
});

test("ordinary list loading uses only the fixed flower visually and keeps its operation screen-reader accessible", async () => {
  const h = harness({ loadCatalog: async (options) => publishCatalog(options, { accountKey: "account-1", rows: [], loading: true, partial: true, phase: "loading", coverageReasons: ["catalog-pending"] }) });
  h.update(); await flush(); assert.match(h.root.innerHTML, /titles-status__label--sr-only[^>]*>读取会话列表…/);
  assert.match(h.root.innerHTML, /tidy-loading-flower/); assert.doesNotMatch(h.root.innerHTML, /data-batch-key="notice"|部分会话/);
  h.catalog({ accountKey: "account-1", rows, loading: true, phase: "loading", partial: true });
  assert.match(h.root.innerHTML, /titles-status__label--sr-only[^>]*>更新会话列表…/);
  assert.doesNotMatch(h.root.innerHTML, /titles-batch-status__caption|titles-notice|is-warning/);
  h.catalog({ accountKey: "account-1", rows, loading: false, phase: "settled", partial: true, coverageReasons: ["shared-projects-unverified"] });
  assert.doesNotMatch(h.root.innerHTML, /tidy-loading-flower|titles-batch-status__caption|data-batch-key="notice"/);
  const css = source("src/features/titles/ui/title-batch.css");
  assert.doesNotMatch(css, /\.titles-batch-status__caption/);
  assert.match(css, /\.titles-batch-select-toolbar\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.titles-batch-select-list, \.titles-batch-preview-list\s*\{[^}]*overflow-y:\s*auto/);
});

test("malformed empty status cannot be mistaken for no saved job, and dispose stops later updates", async () => {
  const h = harness({ intercept: (action, payload, server) => action === "batch-status" ? {} : server.respond(action, payload) });
  h.update(); await flush(); assert.equal(h.catalogCalls, 1); assert.match(h.root.innerHTML, /读取失败，请重试/);
  h.view.dispose(); const calls = h.calls.length; h.update({ active: false }); h.update({ active: true }); await flush();
  assert.equal(h.calls.length, calls);
});

test("hiding during local preview ignores its late UI result; reopening restores the durable review read-only", async () => {
  const gate = deferred(); const h = harness({ intercept: (action, payload, server) => {
    const result = server.respond(action, payload); return action === "batch-preview" ? gate.promise.then(() => result) : result;
  } }); h.update(); await flush(); h.select("one"); h.click("preview"); await flush(); h.update({ active: false }); gate.resolve(); await flush();
  assert.equal(h.view.state.batch, null); assert.equal(actions(h).includes("batch-prepare-step"), false);
  h.update({ active: true }); await flush(); assert.equal(h.view.state.batch.phase, "preview");
  assert.equal(actions(h).includes("batch-prepare-step"), false); assert.equal(actions(h).includes("batch-apply"), false);
});

test("hidden replan response cannot strand reopening on its superseded batch ID", async () => {
  const gate = deferred();
  const h = harness({ intercept: (action, payload, server) => {
    if (action === "batch-status" && payload.batchId && payload.batchId !== server.job?.batchId) throw Object.assign(new Error("superseded"), { code: "TITLE_PREVIEW_REQUIRED" });
    const result = server.respond(action, payload); return action === "batch-replan" ? gate.promise.then(() => result) : result;
  } });
  await review(h, ["one"]); const oldId = h.view.state.batch.batchId; h.rule("dateFormat", "dot");
  h.update({ active: false }); gate.resolve(); await flush(); assert.equal(h.view.state.batch.batchId, oldId);
  h.update({ active: true }); await flush(); assert.notEqual(h.view.state.batch.batchId, oldId);
  assert.doesNotMatch(button(h, "apply"), /disabled/); assert.equal(actions(h).includes("batch-apply"), false);
  assert.equal(h.calls.filter((call) => call.action === "batch-status").at(-1).payload.batchId, undefined);
});

test("a failed replan response can recover the latest ID once without confirming a write", async () => {
  let failReplan = true;
  const h = harness({ intercept: (action, payload, server) => {
    if (action === "batch-retry-preview" && payload.batchId !== server.job.batchId) throw Object.assign(new Error("superseded"), { code: "TITLE_PREVIEW_REQUIRED" });
    const result = server.respond(action, payload);
    if (action === "batch-replan" && failReplan) { failReplan = false; throw new Error("Response lost"); }
    return result;
  } });
  await review(h, ["one"]); h.rule("dateFormat", "dot"); await flush(); h.click("refresh-preview"); await flush();
  assert.doesNotMatch(button(h, "apply"), /disabled/); assert.equal(h.view.state.rules.dateFormat, "dot");
  assert.equal(actions(h).filter((action) => action === "batch-status").length, 2);
  assert.equal(actions(h).includes("batch-apply"), false);
});

test("the UI rejects a retired preparation response rather than silently discarding its receipt", async () => {
  const h = harness({ intercept: (action, payload, server) => {
    const result = server.respond(action, payload);
    return action === "batch-preview" ? { ...result, phase: "preparing", nextStepId: "retired-token" } : result;
  } });
  await review(h, ["one"]); assert.equal(h.view.state.batch, null);
  assert.equal(h.view.state.dismissedBatchId, null);
  assert.equal(actions(h).filter((action) => action === "batch-prepare-step").length, 0);
  assert.equal(actions(h).includes("batch-apply"), false); assert.equal(actions(h).includes("batch-step"), false);
  assert.match(h.root.innerHTML, /读取失败/);
  assert.match(h.root.innerHTML, /data-batch-scroll="select"/); assert.equal(h.view.state.busy, null);
});

test("worker-normalized historical receipts remain visible recovery without automatic continuation", async () => {
  const seed = harness(); await review(seed, ["one", "four"]);
  for (const status of ["accepted", "verified", "uncertain", "ready"]) {
    const job = plain(seed.server.job); job.phase = "paused"; job.nextStepId = null; job.pauseReason = "review-required";
    job.items[0].status = status; job.items[0].settled = ["accepted", "verified"].includes(status);
    if (job.items[0].settled) job.items[0].current.title = job.items[0].plan.after;
    job.items[1].status = "failed"; job.items[1].messageCode = "title_preview_required";
    const h = harness({ initialJob: job }); h.update(); await flush();
    assert.equal(h.view.state.batch.batchId, job.batchId); assert.equal(h.view.state.batch.items[0].status, status);
    assert.equal(h.view.state.recovery, true); assert.match(h.root.innerHTML, /处理已暂停/);
    assert.deepEqual(actions(h), ["batch-status"]);
    h.dispatch({ batchAction: "apply" }); await flush(); assert.deepEqual(actions(h), ["batch-status"]);
    assert.equal(button(h, "reconcile") !== undefined, status === "uncertain");
    assert.equal(button(h, "retry-preview") !== undefined, status !== "uncertain");
  }
});

test("moving the same owner ID to a different project invalidates an outstanding local preview", async () => {
  const gate = deferred();
  const h = harness({ intercept: (action, payload, server) => {
    const result = server.respond(action, payload); return action === "batch-preview" ? gate.promise.then(() => result) : result;
  } }); h.update(); await flush(); h.select("one"); h.select("four"); h.click("preview"); await flush();
  const moved = plain(snapshot()); moved.route.pathname = "/g/g-p-new/c/owner"; moved.route.kind = "project-conversation";
  moved.conversation.kind = "project-conversation"; moved.conversation.project = { projectId: "g-p-new" };
  h.update({ snapshot: moved }); gate.resolve(); await flush();
  assert.equal(actions(h).filter((action) => action === "batch-prepare-step").length, 0);
  assert.equal(actions(h).includes("batch-apply"), false); assert.equal(h.view.state.batch, null);
});

test("navigation during a write stops next items; returning to the original owner restores paused status without POST", async () => {
  const gate = deferred(); const h = harness({ intercept: (action, payload, server) => action === "batch-step" ? gate.promise.then(() => server.respond(action, payload)) : server.respond(action, payload) });
  await review(h, ["one", "four"]); h.click("apply"); await flush(); h.update({ snapshot: snapshot("other") });
  assert.equal(h.view.canLeave(), true); gate.resolve(); await flush();
  assert.equal(actions(h).filter((a) => a === "batch-step").length, 1);
  h.update({ snapshot: snapshot("owner") }); await flush(); assert.match(h.root.innerHTML, /处理已暂停/);
  assert.equal(actions(h).filter((a) => a === "batch-step").length, 1); assert.ok(button(h, "retry-preview")); assert.equal(button(h, "reconcile"), undefined);
});

test("reopening an applying receipt is read-only, and retry requires a fresh review and second confirm", async () => {
  const h = harness(); await review(h, ["one", "four"]);
  const job = plain(h.server.job); job.phase = "applying"; job.items[0].status = "verified"; job.items[0].settled = true; job.items[0].current.title = job.items[0].plan.after;
  const reopened = harness({ initialJob: job }); reopened.update(); await flush();
  assert.deepEqual(actions(reopened), ["batch-status"]); assert.match(reopened.root.innerHTML, /处理已暂停/);
  assert.equal(button(reopened, "reconcile"), undefined); assert.ok(button(reopened, "retry-preview"));
  reopened.click("retry-preview"); await flush(); assert.equal(reopened.view.state.batch.phase, "preview");
  assert.deepEqual(actions(reopened).slice(0, 3), ["batch-status", "batch-reconcile", "batch-retry-preview"], "one explicit review click performs a read-only recovery first");
  assert.equal(actions(reopened).filter((a) => a === "batch-prepare-step").length, 0); assert.equal(actions(reopened).includes("batch-apply"), false);
  assert.match(reopened.root.innerHTML, /本次处理 2 个/); assert.match(reopened.root.innerHTML, /已保存/); assert.match(reopened.root.innerHTML, /应用 1 项/);
  reopened.rule("dateFormat", "dot"); await flush(); assert.match(reopened.root.innerHTML, /应用 1 项/);
  reopened.click("apply"); await flush(); assert.match(reopened.root.innerHTML, /已更新 2 个会话的标题日期/);
});

test("uncertain write has read-only reconcile and cannot be silently retried", async () => {
  const h = harness({ intercept: (action, payload, server) => {
    if (action === "batch-step") { const job = plain(server.job); job.phase = "paused"; job.items.find((i) => i.status === "ready").status = "uncertain"; server.job = job; return job; }
    return server.respond(action, payload);
  } }); await review(h, ["one", "four"]); h.click("apply"); await flush();
  assert.ok(button(h, "reconcile")); assert.equal(button(h, "retry-preview"), undefined);
  h.dispatch({ batchAction: "retry-preview" }); h.dispatch({ batchAction: "apply" }); await flush();
  assert.equal(actions(h).filter((a) => a === "batch-step").length, 1); assert.equal(actions(h).includes("batch-retry-preview"), false);
  h.click("reconcile"); await flush(); assert.equal(actions(h).filter((a) => a === "batch-step").length, 1);
});

for (const messageCode of ["title_unchanged", "title_rechecked"]) {
  test(`batch ${messageCode} recovery offers review, not an automatic next write`, async () => {
    const h = harness({ intercept: (action, payload, server) => {
      if (action === "batch-step") {
        const job = plain(server.job); job.phase = "paused";
        job.items.find(item => item.status === "ready").status = "uncertain";
        server.job = job; return job;
      }
      if (action === "batch-reconcile") {
        const job = plain(server.job), item = job.items.find(item => item.status === "uncertain");
        if (item) { item.status = "conflict"; item.messageCode = messageCode; }
        job.phase = "paused"; job.pauseReason = "review-required"; server.job = job; return job;
      }
      return server.respond(action, payload);
    } });
    await review(h, ["one", "four"]); h.click("apply"); await flush();
    h.click("reconcile"); await flush();
    assert.equal(button(h, "reconcile"), undefined); assert.ok(button(h, "retry-preview"));
    assert.match(h.root.innerHTML, /需重新预览/);
    assert.equal(actions(h).filter(action => action === "batch-step").length, 1);
    h.click("retry-preview"); await flush();
    assert.ok(button(h, "apply"));
    assert.equal(actions(h).filter(action => action === "batch-apply").length, 1, "another confirmation is required");
  });
}

test("failed result has an actionable retry review retaining prior successes", async () => {
  let failed = false; const h = harness({ intercept: (action, payload, server) => {
    if (action === "batch-step" && !failed) { failed = true; const result = server.respond(action, payload); result.items.find((i) => i.status === "ready").status = "failed"; result.phase = "result"; server.job = result; return result; }
    return server.respond(action, payload);
  } }); await review(h, ["one", "four"]); h.click("apply"); await flush();
  assert.match(h.root.innerHTML, /1 项失败/); h.click("retry-preview"); await flush();
  assert.match(h.root.innerHTML, /应用 1 项/); assert.equal(actions(h).filter((a) => a === "batch-apply").length, 1);
  h.click("apply"); await flush(); assert.match(h.root.innerHTML, /已更新 2 个会话的标题日期/);
});

test("malformed/mismatched write receipt stops the chain and exposes recovery, not success", async () => {
  const h = harness({ intercept: (action, payload, server) => action === "batch-step" ? { ...server.respond(action, payload), batchId: "wrong" } : server.respond(action, payload) });
  await review(h, ["one", "four"]); h.click("apply"); await flush(); assert.equal(actions(h).filter((a) => a === "batch-step").length, 1);
  assert.match(h.root.innerHTML, /结果未明/); assert.equal(h.changed, 0); assert.ok(button(h, "reconcile"));
  assert.equal(h.root.innerHTML.split('结果未明').length - 1, 1, 'one primary explanation');
  assert.doesNotMatch(h.root.innerHTML, /titles-batch-pause-explanation|不会自动继续|不会写入/);
});

test("preview cannot accept unexpected target IDs or another account", async () => {
  for (const corrupt of [(value) => ({ ...value, catalogAccountKey: "wrong" }), (value) => ({ ...value, items: [{ conversationId: "intruder", status: "unread" }] })]) {
    const h = harness({ intercept: (action, payload, server) => action === "batch-preview" ? corrupt(server.respond(action, payload)) : server.respond(action, payload) });
    await review(h, ["one"]); assert.equal(h.view.state.batch, null); assert.equal(actions(h).includes("batch-prepare-step"), false); assert.match(h.root.innerHTML, /读取失败/);
  }
});

test("expired review exposes fresh read retry without automatically confirming", async () => {
  let fail = true; const h = harness({ intercept: (action, payload, server) => {
    if (action === "batch-replan" && fail) { fail = false; throw Object.assign(new Error("expired"), { code: "TITLE_PREVIEW_REQUIRED" }); }
    return server.respond(action, payload);
  } }); await review(h, ["one"]); h.rule("mode", "created"); await flush(); assert.ok(button(h, "refresh-preview"));
  h.click("refresh-preview"); await flush(); assert.ok(actions(h).includes("batch-retry-preview")); assert.equal(actions(h).includes("batch-apply"), false);
  assert.doesNotMatch(button(h, "apply"), /disabled/);
});

test("large selections have no product cap and long-term partial coverage does not produce a standing warning", async () => {
  const large = Array.from({ length: 513 }, (_, i) => row(`id-${i}`, `Chat ${i}`));
  const h = harness({ catalogRows: large }); h.update(); await flush(); const models = h.modelCalls, dates = h.dateLabelCalls;
  h.click("select-all"); assert.equal(h.view.state.selected.size, 513);
  assert.equal(h.modelCalls, models, "checkbox changes reuse cached title/date classification");
  assert.equal(h.dateLabelCalls, dates, "checkbox changes do not repeat Intl date formatting");
  h.catalog({ accountKey: "account-1", rows: large, partial: true, loading: false, coverageReasons: ["shared-projects-unverified", "group-chats-unverified"] });
  assert.doesNotMatch(h.root.innerHTML, /部分会话可能未收录|titles-batch-coverage|data-batch-key="notice"/); assert.equal(button(h, "reload"), undefined);
});

test("Chinese, English, Japanese labels are present and never leak translation keys", async () => {
  for (const language of ["zh-CN", "zh-TW", "en", "ja"]) {
    const h = harness({ language }); await review(h); assert.doesNotMatch(h.root.innerHTML, />titles[A-Z]/);
    assert.doesNotMatch(h.root.innerHTML, /rangeStyle|range-full|撤销|Undo|元に戻す/);
  }
});

test("retired preparation controls and dead copy stay outside production title sources", () => {
  const view = source("src/features/titles/ui/title-batch-view.js");
  const messages = source("src/messages/i18n.js");
  assert.doesNotMatch(view, /request\(["']batch-prepare-step|data-batch-action=["']prepare/);
  assert.doesNotMatch(view, /retiredReadOnlyReceipt|RETIRED_READ_ONLY_STATUSES|["']preparing["']|["']unread["']/);
  for (const key of ["titlesBatchPreviewPaused", "titlesBatchPreparing", "titlesBatchContinuePreview",
    "titlesBatchReadIncomplete", "titlesBatchReadOnly"]) assert.doesNotMatch(messages, new RegExp(`\\b${key}\\b`));
});

test("a complete local batch opens review without any preparation-step requests", async () => {
  const h = harness();
  await review(h, ["one", "four"]);
  assert.deepEqual(actions(h), ["batch-status", "batch-preview"]);
  assert.equal(h.view.state.batch.phase, "preview"); assert.doesNotMatch(h.root.innerHTML, /tidy-loading-flower/);
  h.rule("dateFormat", "dot"); await flush();
  assert.deepEqual(actions(h), ["batch-status", "batch-preview", "batch-replan"]);
});

test("ten selected rows open one complete local review with no partial-read phase", async () => {
  const catalogRows = Array.from({ length: 10 }, (_, i) => row(`chat-${i}`, `Title ${i}`));
  const h = harness({ catalogRows });
  await review(h, catalogRows.map(row => row.conversationId));
  assert.equal(h.view.state.batch.phase, "preview"); assert.equal(h.view.state.batch.items.length, 10);
  assert.match(h.root.innerHTML, /本次处理 10 个/);
  assert.doesNotMatch(h.root.innerHTML, /4 \/ 10|预览读取已暂停|会话信息尚未读完|tidy-loading-flower/);
  assert.equal(button(h, "prepare"), undefined); assert.ok(button(h, "back"));
  assert.equal(actions(h).includes("batch-apply"), false); assert.equal(actions(h).includes("batch-prepare-step"), false);
});

test("save conflicts distinguish timestamp drift from title edits even when no title has a date", async () => {
  const h = harness(); await review(h, ["one", "four"]);
  const job = plain(h.server.job); job.phase = "applying";
  job.items[0].status = "conflict"; job.items[0].messageCode = "dates_changed";
  job.items[0].dateDifferences = { updatedAt: { expected: "2026-09-01T00:00:00.000Z", actual: "2026-09-01T00:00:01.752Z" } };
  job.items[1].status = "conflict"; job.items[1].messageCode = "title_conflict";
  const reopened = harness({ initialJob: job }); reopened.update(); await flush();
  assert.match(reopened.root.innerHTML, /日期已变化/); assert.match(reopened.root.innerHTML, /标题已变化/);
  assert.doesNotMatch(reopened.root.innerHTML, /日期冲突|规则冲突/);
  assert.match(reopened.root.innerHTML, /日期已变，请重新预览/);
  assert.doesNotMatch(reopened.root.innerHTML, /2026-09-01T00:00:01.752Z/);
  assert.match(reopened.root.innerHTML, /查看未完成原因/);
  assert.match(reopened.root.innerHTML, /已保存 0 项/);
  assert.ok(button(reopened, "retry-preview")); assert.equal(button(reopened, "reconcile"), undefined);
  assert.deepEqual(actions(reopened), ["batch-status"]);
});

test("hiding during local preview never auto-confirms or starts a write on return", async () => {
  const gate = deferred();
  const h = harness({ intercept: (action, payload, server) => {
    const result = server.respond(action, payload);
    return action === "batch-preview" ? gate.promise.then(() => result) : result;
  } });
  h.update(); await flush(); h.select("one"); h.select("four"); h.click("preview"); await flush();
  h.update({ active: false }); gate.resolve(); await flush(); h.update({ active: true }); await flush();
  assert.equal(h.view.state.batch.phase, "preview"); assert.match(h.root.innerHTML, /本次处理 2 个/);
  assert.equal(actions(h).filter(a => a === "batch-prepare-step").length, 0);
  assert.equal(actions(h).includes("batch-apply"), false);
});

test("a recovered write-rate pause preserves its reason and never automatically resumes", async () => {
  const h = harness();
  const job = h.server.respond("batch-preview", { conversationIds: ["one"], operation: "assign", rules: { mode: "created", dateFormat: "iso", timeZone: "UTC" } });
  job.phase = "paused"; job.pauseReason = "rate-limited"; job.items[0].status = "failed"; job.items[0].messageCode = "TITLE_RATE_LIMITED"; h.server.job = job;
  h.update(); await flush();
  assert.match(h.root.innerHTML, /操作太快，稍后再试/);
  assert.doesNotMatch(h.root.innerHTML, /titles-batch-pause-explanation/, 'specific rate-limit cause replaces generic pause explanation');
  assert.equal(actions(h).includes("batch-prepare-step"), false); assert.equal(actions(h).includes("batch-step"), false);
});

test("reviewing a locally stopped run rechecks durable uncertainty before creating any new preview", async () => {
  const fixture = harness(); await review(fixture, ["one", "four"]);
  const job = plain(fixture.server.job); job.phase = "applying";
  const h = harness({ initialJob: job, intercept: (action, payload, server) => {
    const value = server.respond(action, payload);
    if (action === "batch-reconcile") { value.items[0].status = "uncertain"; server.job = value; }
    return value;
  } });
  h.update(); await flush(); h.click("retry-preview"); await flush();
  assert.deepEqual(actions(h), ["batch-status", "batch-reconcile"]);
  assert.ok(button(h, "reconcile")); assert.equal(button(h, "retry-preview"), undefined);
  assert.match(h.root.innerHTML, /结果未明/);
});

test("new conflict details and pause explanations are localized and escape diagnostic values", async () => {
  const fixture = harness(); await review(fixture, ["one"]);
  const job = plain(fixture.server.job); job.phase = "paused"; job.pauseReason = "runtime-restarted";
  job.items[0].status = "conflict"; job.items[0].messageCode = "dates_changed";
  job.items[0].dateDifferences = { updatedAt: { expected: '<img src=x onerror="boom">', actual: "2026-09-01T00:00:00.000Z" } };
  for (const language of ["zh-CN", "zh-TW", "en", "ja"]) {
    const h = harness({ initialJob: job, language }); h.update(); await flush();
    assert.doesNotMatch(h.root.innerHTML, /titlesBatch[A-Z]|<img/);
    assert.doesNotMatch(h.root.innerHTML, /&lt;img|onerror|2026-09-01T/);
    assert.ok(button(h, "retry-preview"));
  }
});

test("initial authentication failures stay distinct, do not invent empty counts and remain write-blocking", async () => {
  for (const [code, key, notice] of [
    ["TITLE_AUTH_REQUIRED", "titlesAuthPending", /账号未读到/],
    ["TITLE_AUTH_EXPIRED", "titlesAuthExpired", /登录过期/],
    ["TITLE_ACCOUNT_CHANGED", "titlesAccountChanged", /账号或工作区已变/],
  ]) {
    const h = harness({ intercept: async () => { throw { code }; } }); h.update(); await flush();
    assert.equal(h.view.state.error, key); assert.match(h.root.innerHTML, notice);
    assert.doesNotMatch(h.root.innerHTML, /登录已变化|当前结果没有会话|0 个会话/);
    assert.equal(h.root.innerHTML.includes("<strong>0</strong>"), false);
    assert.equal(h.root.innerHTML.split("<strong>—</strong>").length - 1, 0,
      "known local catalog counts remain visible even if receipt status fails");
    assert.equal(h.catalogCalls, 1);
    assert.match(button(h, "preview"), /disabled/); h.dispatch({ batchAction: "preview" });
    h.update(); await flush(); assert.deepEqual(actions(h), ["batch-status"]);
    h.view.dispose();
  }
});

test("directory not yet observed is not zero, but a successful empty directory is", async () => {
  const pending = deferred();
  const h = harness({ loadCatalog: async options => publishCatalog(options, await pending.promise) });
  h.update(); await flush();
  assert.match(h.root.innerHTML, /会话列表尚未加载/);
  assert.doesNotMatch(h.root.innerHTML, /当前结果没有会话|0 个会话/);
  assert.equal(h.root.innerHTML.includes("<strong>0</strong>"), false);
  pending.resolve({ accountKey: "account-1", rows: [], loading: false, phase: "settled" }); await flush();
  assert.match(h.root.innerHTML, /当前结果没有会话/); assert.match(h.root.innerHTML, /0 个会话/);
  assert.equal(h.view.state.catalogLoaded, true); h.view.dispose();
});

test("an empty unfinished checkpoint cannot masquerade as a successfully read empty directory", async () => {
  const h = harness({ loadCatalog: async options => publishCatalog(options, {
    accountKey: "account-1", rows: [], loading: false, phase: "paused", coverageReasons: ["catalog-pending"],
  }) }); h.update(); await flush();
  assert.match(h.root.innerHTML, /会话列表尚未加载/);
  assert.doesNotMatch(h.root.innerHTML, /当前结果没有会话|0 个会话/);
  assert.equal(h.root.innerHTML.includes("<strong>0</strong>"), false);
  assert.equal(h.view.state.catalogIssue, "paused"); h.view.dispose();
});

test("saved and new rate limits keep the same plain action while severity and selection remain correct", async () => {
  const saved = { accountKey: "account-1", rows, loading: false, partial: true, phase: "paused", pauseReason: "rate-limited",
    readErrors: [{ code: "HTTP", status: 429, retryable: true }], errorOrigin: "previous" };
  const retryFlags = [];
  const h = harness({ loadCatalog: async options => {
    retryFlags.push(options.retry === true);
    return publishCatalog(options, options.retry ? { accountKey: "account-1", rows, loading: false, phase: "settled" } : saved);
  } }); h.update(); await flush(); h.select("one");
  assert.match(h.root.innerHTML, /操作太快，稍后再试/);
  assert.match(h.root.innerHTML, /class="titles-notice titles-catalog-notice"/);
  h.search("Alpha"); h.rule("mode", "range"); h.update(); await flush();
  assert.deepEqual(retryFlags, [false]); assert.deepEqual(actions(h), ["batch-status"]);
  h.catalog({ ...saved, errorOrigin: "current" });
  assert.match(h.root.innerHTML, /操作太快，稍后再试/);
  assert.match(h.root.innerHTML, /class="titles-notice titles-catalog-notice is-warning"/);
  h.click("reload"); await flush(); assert.deepEqual(retryFlags, [false, true]);
  assert.doesNotMatch(h.root.innerHTML, /遇到限流/); assert.deepEqual([...h.view.state.selected], ["one"]);
  assert.equal(h.view.state.rows.length, 4); h.view.dispose();
});

test("saved and current generic read failures use different severity while retaining rows until manual retry", async () => {
  const saved = { accountKey: "account-1", rows, loading: false, partial: true, phase: "paused",
    readErrors: [{ code: "NETWORK", category: "NETWORK", retryable: true }], errorOrigin: "previous" };
  const retryFlags = [];
  const h = harness({ loadCatalog: async options => {
    retryFlags.push(options.retry === true);
    return publishCatalog(options, options.retry ? { accountKey: "account-1", rows, loading: false, phase: "settled" } : saved);
  } });
  h.update(); await flush(); h.select("one");
  assert.match(h.root.innerHTML, /列表未读全/);
  assert.match(h.root.innerHTML, /class="titles-notice titles-catalog-notice"/); assert.doesNotMatch(h.root.innerHTML, /titles-notice titles-catalog-notice is-warning/);

  h.catalog({ ...saved, errorOrigin: "current" });
  assert.match(h.root.innerHTML, /列表未读全/);
  assert.match(h.root.innerHTML, /class="titles-notice titles-catalog-notice is-warning"/);

  h.click("reload"); await flush();
  assert.deepEqual(retryFlags, [false, true]); assert.deepEqual([...h.view.state.selected], ["one"]);
  assert.doesNotMatch(h.root.innerHTML, /列表未读全/); assert.equal(h.view.state.rows.length, 4);
  h.view.dispose();
});

// 产品文案边界：同一规则冲突 key 同时用于筛选和行标签，不改变选择或默认保持不变。
for (const [language, label] of Object.entries({
  "zh-CN": "规则冲突", "zh-TW": "規則衝突", en: "Conflict", ja: "ルール競合",
})) test("rule-conflict copy is shared by filter and badges: " + language, async () => {
  const h = harness({ language }); h.update(); await flush();
  assert.ok(h.root.innerHTML.includes('data-batch-filter="decision" aria-pressed="false"><span>' + label + '</span><strong>2</strong>'));
  assert.equal(h.root.innerHTML.split('<em class="is-risk">' + label + '</em>').length - 1, 2);
  h.filter("decision");
  assert.deepEqual([...h.root.innerHTML.matchAll(/data-batch-select="([^"]+)"/g)].map(match => match[1]), ["two", "three"]);
  h.select("two"); h.click("preview"); await flush();
  const plan = h.server.job.items[0].plan;
  assert.equal(plan.needsDecision, true);
  assert.equal(plan.selectedDecision, "skip");
  assert.equal(plan.after, plan.before);
  assert.deepEqual(plan.choices.map(choice => choice.id), ["skip", "replace", "stack"]);
  assert.equal(actions(h).includes("batch-apply"), false);
});
