const { createPanelRuntime } = require("./helpers/panel-runtime.cjs");
const assert = require("node:assert/strict");
const test = require("node:test");
const { snapshotHarness } = require("./helpers/adapter-snapshot.cjs");

const plain = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const flush = async () => { for (let index = 0; index < 16; index++) await new Promise(setImmediate); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const PREFS = Object.freeze({ language: "zh-CN", timeZone: "UTC", dateFormat: "iso", conversationTimeMode: "range" });
const INITIAL_RULES = Object.freeze({ mode: "created", dateFormat: "iso" });

function container() {
  const listeners = new Map();
  return { innerHTML: "", hidden: false, attributes: {}, listeners,
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
    setAttribute(name, value) { this.attributes[name] = value; },
    contains(node) { return node?.owner === this; },
  };
}

function harness({ writeStatus = "verified", batchWriteStatus = writeStatus, includeOwner = false, heldWrite = null, stored = INITIAL_RULES, ownerPath = "/c/owner" } = {}) {
  const saved = [], reads = [], writes = [], calls = [], records = new Map();
  const owner = { tabId: 7, conversationId: "owner", pathname: "/c/owner", projectId: null };
  const identity = { accountKey: "user", workspaceKey: "personal" };
  const row = (id, title) => ({ conversationId: id, title, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" });
  const rows = [row("one", "First title"), row("two", "Second title")];
  const targets = new Map([row("owner", "Owner title"), ...rows].map((value) => [value.conversationId, value]));
  if (includeOwner) rows.push(targets.get("owner"));
  const preferencesStorage = { get: async (key) => ({ [key]: plain(stored) }), set: async (value) => saved.push(plain(value)) };
  const storage = { get: async (key) => plain(records.get(key)) || null, set: async (key, value) => { records.set(key, plain(value)); },
    remove: async (keys) => { for (const key of Array.isArray(keys) ? keys : [keys]) records.delete(key); } };
  // Follow the production import graph, including notice-lifecycle side effects.
  // Only Chrome transport and storage are synthetic; no view dependency is replaced.
  const { context, load } = createPanelRuntime({ navigator: { language: "zh-CN" },
    chrome: { storage: { local: preferencesStorage }, runtime: {} } });
  for (const file of ["src/platform/snapshot.js", "src/platform/time-format.js", "src/features/titles/model/title-dates.js"]) load(file);
  Object.assign(owner, plain(context.TidySnapshot.parseConversationPath(ownerPath)));
  const { TITLE_RULES_KEY } = load("src/features/titles/model/title-rules.js");
  const { createTitleRulesStore } = load("src/features/titles/storage/title-rules.js");
  const { getTitleRulesController } = load("src/features/titles/ui/title-rules.js");
  const { createTranslator } = load("src/messages/i18n.js");
  const { createTitleService } = load("src/features/titles/background/title-service.js");
  const { createTitleBatchService } = load("src/features/titles/background/title-batch-service.js");
  const { createTitleOrganizationView } = load("src/features/titles/ui/title-organization-view.js");
  let written;
  const ruleStore = createTitleRulesStore({ defaults: async () => PREFS, storage: {
    get: async key => written ? { [key]: written } : preferencesStorage.get(key),
    set: async values => { await preferencesStorage.set(values); written = { ...values[TITLE_RULES_KEY] }; },
  } });
  context.chrome.runtime.sendMessage = async envelope => {
    const protocol = context.TidyProtocol;
    try {
      if (envelope.type === protocol.Type.TITLE_RULES_GET) return protocol.response(envelope, await ruleStore.read());
      if (envelope.type === protocol.Type.TITLE_RULES_UPDATE) return protocol.response(envelope, await ruleStore.update(envelope.payload));
      throw new Error("Unexpected fixture request");
    } catch (error) { return protocol.failure(envelope, error.tidyCode || "STORAGE_ERROR", "Fixture failure"); }
  };

  let serial = 0;
  const service = createTitleService({ storage, model: context.TidyTitleDates, createId: () => `core-${++serial}`,
    read: async (target, input) => {
      reads.push({ context: plain(target), input: plain(input) });
      return input?.identityOnly ? { identity } : { identity, current: plain(targets.get(target.conversationId)) };
    },
    write: async (target, payload, beforeDispatch) => {
      await beforeDispatch();
      writes.push({ context: plain(target), payload: plain(payload) });
      if (heldWrite) await heldWrite.promise;
      const current = targets.get(target.conversationId);
      const status = target.batchScopeId ? batchWriteStatus : writeStatus;
      if (!["accepted", "verified"].includes(status)) return { status, current: plain(current) };
      if (current.title !== payload.before || current.updatedAt !== payload.expectedUpdatedAt) return { status: "conflict", current: plain(current) };
      const before = plain(current);
      current.title = payload.after; current.updatedAt = "2026-09-10T00:00:00.000Z";
      if (status === "accepted") return { status, accepted: { ...before, title: payload.after }, httpStatus: 200 };
      return { status: "verified", current: plain(current) };
    },
  });
  const batch = createTitleBatchService({ storage, titleService: service, model: context.TidyTitleDates, createId: () => `batch-${++serial}`,
    beginExecution: async () => ({ identity, catalogAccountKey: "catalog-user" }), endExecution: async () => ({ ended: true }),
    resolveSelection: async (_context, payload) => ({ identity, accountKey: "catalog-user", rows: payload.conversationIds.map((id) => {
      const current = targets.get(id);
      return { ...plain(current), createdAt: Date.parse(current.createdAt), updatedAt: Date.parse(current.updatedAt) };
    }) }),
  });
  const currentRoot = container(), batchRoot = container(), root = container();
  const buttons = ["current", "batch"].map((mode) => ({ owner: root, dataset: { titlesMode: mode }, attributes: {}, disabled: false,
    setAttribute(name, value) { this.attributes[name] = value; }, closest() { return this; } }));
  const notices = { notice: {}, error: {}, retry: {} };
  root.querySelector = (selector) => selector.includes("rules-") ? notices[selector.match(/rules-(\w+)/)[1]] : selector.includes("current") ? currentRoot : batchRoot;
  root.querySelectorAll = () => buttons;
  const rules = getTitleRulesController();
  let view;
  const snapshot = () => {
    const current = targets.get("owner");
    return snapshotHarness({ url: `https://chatgpt.com${owner.pathname}`, sidebar: [{ href: owner.pathname, title: current.title,
      record: { id: "owner", title: current.title, create_time: Date.parse(current.createdAt) / 1000, update_time: Date.parse(current.updatedAt) / 1000 } }] });
  };
  const update = ({ active = true } = {}) => view.update({ active, snapshot: snapshot(), preferences: PREFS, translator: createTranslator("zh-CN") });
  view = createTitleOrganizationView({ root, ownerTabId: 7, rulesController: rules,
    request: async (action, payload) => {
      calls.push({ action, payload: plain(payload) });
      return action.startsWith("batch-") ? batch.handle(action.slice(6), owner, payload) : service.handle(action, owner, payload);
    },
    loadCatalog: async ({ onUpdate }) => {
      const result = { accountKey: "catalog-user", rows: plain(rows), loading: false, partial: false };
      onUpdate(result); return result;
    },
    onChanged: update,
  });
  const dispatch = (surface, event, dataset, value = "") => {
    const target = { owner: surface, dataset, value, disabled: false,
      closest(selector) {
        const matches = [...selector.matchAll(/\[data-([a-z-]+)\]/g)];
        return matches.some((match) => Object.hasOwn(dataset, match[1].replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase()))) ? this : null;
      },
    };
    surface.listeners.get(event)?.({ target });
  };
  function selectValue(surface, attribute, name) {
    const select = surface.innerHTML.match(new RegExp(`<select[^>]*${attribute}="${name}"[^>]*>([\\s\\S]*?)</select>`));
    assert.ok(select, `Missing ${attribute}=${name}: ${surface.innerHTML}`);
    return select[1].match(/<option value="([^"]+)" selected/)?.[1];
  }
  function rule(surface, field, value, prefix) {
    selectValue(surface, `data-${prefix}-rule`, field);
    dispatch(surface, "change", { [prefix === "title" ? "titleRule" : "batchRule"]: field }, value);
  }
  const clickBatch = (action) => {
    const button = batchRoot.innerHTML.match(new RegExp(`<button[^>]*data-batch-action="${action}"[^>]*>`))?.[0];
    assert.ok(button, `Missing batch action ${action}: ${batchRoot.innerHTML}`);
    assert.doesNotMatch(button, /\sdisabled(?:\s|>)/, `Disabled batch action ${action}`);
    dispatch(batchRoot, "click", { batchAction: action });
  };
  return { view, rules, saved, reads, writes, calls, rows, targets, records, currentRoot, batchRoot, update,
    tab(mode) { const button = buttons.find((entry) => entry.dataset.titlesMode === mode); root.listeners.get("click")?.({ target: button }); },
    select(id) { dispatch(batchRoot, "click", { batchSelect: id }); },
    currentRule: (field, value) => rule(currentRoot, field, value, "title"),
    batchRule: (field, value) => rule(batchRoot, field, value, "batch"),
    value: (mode, field) => selectValue(mode === "current" ? currentRoot : batchRoot, mode === "current" ? "data-title-rule" : "data-batch-rule", field),
    clickBatch,
    clickCurrent(action) {
      const button = currentRoot.innerHTML.match(new RegExp(`<button[^>]*data-title-action="${action}"[^>]*>`))?.[0];
      assert.ok(button, `Missing current action ${action}: ${currentRoot.innerHTML}`);
      assert.doesNotMatch(button, /\sdisabled(?:\s|>)/, `Disabled current action ${action}`);
      dispatch(currentRoot, "click", { titleAction: action });
    },
    async batchState() { return batch.handle("status", owner, { catalogAccountKey: "catalog-user" }); },
  };
}

async function entered(h) { h.update(); await flush(); }
async function review(h, ids = ["one"]) {
  await entered(h); h.tab("batch"); await flush();
  for (const id of ids) h.select(id);
  h.clickBatch("preview"); await flush();
}

test("real batch view and service stay ready after named-project panel and mode reentry", async () => {
  const h = harness({ ownerPath: "/g/g-p-69ea080a91a081919b8a0c0456e1763e-project-name/c/owner" });
  await entered(h); h.tab("batch"); await flush(); h.select("one");
  for (let attempt = 0; attempt < 3; attempt++) {
    h.update({ active: false }); h.update(); await flush();
    h.tab("current"); await flush(); h.tab("batch"); await flush();
    assert.doesNotMatch(h.batchRoot.innerHTML, /预览过期|读取失败|检查结果/);
    assert.doesNotMatch(h.batchRoot.innerHTML.match(/<button[^>]*data-batch-action="preview"[^>]*>/)?.[0] || "disabled", /disabled/);
  }
  h.clickBatch("preview"); await flush();
  assert.equal((await h.batchState()).phase, "preview");
  assert.match(h.batchRoot.innerHTML, /First title/);
  assert.equal(h.writes.length, 0);
  h.view.dispose();
});

test("a real accepted batch receipt leaves the current-conversation editor usable for local rules and removal", async () => {
  const h = harness({ batchWriteStatus: "accepted", includeOwner: true }); await review(h, ["owner"]);
  h.clickBatch("apply"); await flush();
  assert.equal((await h.batchState()).items[0].status, "accepted");
  h.tab("current"); await flush();
  const receipt = [...h.records.values()].find(value => value.operation?.conversationId === "owner").operation;
  assert.equal(receipt.status, "accepted", "a new read/edit never rebrands the historical batch result as verified");
  const reads = h.reads.length;
  h.currentRule("dateFormat", "slash"); await flush();
  assert.equal(h.reads.length, reads, "ordinary choices remain local after batch completion");
  h.clickCurrent("remove"); await flush(); h.clickCurrent("apply"); await flush();
  assert.equal(h.targets.get("owner").title, "Owner title");
  assert.equal(h.writes.length, 2, "one explicit batch write and one explicit current-title removal");
  assert.equal([...h.records.values()].find(value => value.operation?.conversationId === "owner").operation.status, "verified");
  h.view.dispose();
});

test("fresh current and batch editors both select creation, while saved range remains available", async () => {
  const h = harness({ stored: null }); await entered(h);
  assert.equal(h.value("current", "mode"), "created");
  assert.equal(h.calls.find(call => call.action === "preview").payload.rules.mode, "created");
  h.tab("batch"); await flush();
  assert.equal(h.value("batch", "mode"), "created");
  assert.equal(h.value("batch", "dateFormat"), "iso");
  assert.deepEqual(h.saved, [], "opening either tab must not persist defaults");
  h.select("one"); h.clickBatch("preview"); await flush();
  assert.equal((await h.batchState()).rules.mode, "created");
  assert.equal((await h.batchState()).items[0].plan.after, "2026-08-01｜First title");
  assert.equal(h.writes.length, 0, "preview does not modify ChatGPT titles");
  h.view.dispose();
  const reopened = harness({ stored: { mode: "range", dateFormat: "dot" } }); await entered(reopened);
  assert.equal(reopened.value("current", "mode"), "range");
  reopened.tab("batch"); await flush();
  assert.equal(reopened.value("batch", "mode"), "range");
  assert.deepEqual(reopened.saved, []);
  reopened.view.dispose();
});

test("real mounted current/batch modes share immediate rules, while each option gesture stays local", async () => {
  const h = harness(); await entered(h);
  assert.equal(h.value("current", "mode"), "created", "existing date-basis preference is not replaced by the list's sort default");
  const initialReads = h.reads.length;
  h.currentRule("dateFormat", "slash");
  assert.equal(h.value("current", "dateFormat"), "slash");
  assert.equal(h.rules.snapshot().rules.dateFormat, "slash");
  await flush(); assert.equal(h.reads.length, initialReads); assert.equal(h.writes.length, 0);
  h.tab("batch"); await flush();
  assert.equal(h.value("batch", "dateFormat"), "slash"); assert.equal(h.value("batch", "mode"), "created");
  const before = h.calls.length, readCount = h.reads.length;
  h.batchRule("dateFormat", "dot"); h.batchRule("mode", "range");
  assert.equal(h.value("batch", "dateFormat"), "dot"); assert.equal(h.rules.snapshot().rules.mode, "range");
  await flush(); assert.equal(h.calls.length, before, "selection rules are neither authenticated previews nor batch replans");
  assert.equal(h.reads.length, readCount); assert.equal(h.writes.length, 0);
  h.tab("current"); await flush();
  assert.equal(h.value("current", "dateFormat"), "dot"); assert.equal(h.value("current", "mode"), "range");
  await h.rules.whenSaved();
  assert.deepEqual(h.saved.at(-1), { "tidy.titles.rules.v1": { mode: "range", dateFormat: "dot" } });
  assert.deepEqual(PREFS, { language: "zh-CN", timeZone: "UTC", dateFormat: "iso", conversationTimeMode: "range" });
  h.view.dispose();
});

test("returning to batch preview adopts shared defaults via local replan without replacing its frozen metadata", async () => {
  const h = harness(); await review(h);
  const reviewed = await h.batchState();
  assert.equal(reviewed.rules.dateFormat, "iso");
  const frozen = plain(reviewed.items[0].current);
  h.tab("current"); await flush();
  h.targets.get("one").title = "External edit after review";
  const readCount = h.reads.length;
  h.currentRule("dateFormat", "compact"); h.currentRule("mode", "range");
  await flush(); assert.equal(h.reads.length, readCount);
  h.tab("batch"); await flush();
  const updated = await h.batchState();
  assert.equal(h.value("batch", "dateFormat"), "compact"); assert.equal(h.value("batch", "mode"), "range");
  assert.deepEqual(plain(h.rules.snapshot().rules), { mode: "range", dateFormat: "compact" }, "old receipt rules cannot overwrite shared preferences on entry");
  assert.notEqual(updated.batchId, reviewed.batchId); assert.equal(updated.rules.dateFormat, "compact");
  assert.deepEqual(plain(updated.items[0].current), frozen);
  assert.equal(updated.items[0].plan.before, frozen.title);
  assert.equal(h.reads.length, readCount, "only owner status and local replan are needed; target metadata is not reread");
  assert.equal(h.writes.length, 0);
  h.view.dispose();
});

test("shared edits during unknown batch recovery do not mutate its confirmed execution or issue another write", async () => {
  const h = harness({ writeStatus: "uncertain" }); await review(h);
  h.clickBatch("apply"); await flush();
  const before = await h.batchState(), readCount = h.reads.length, callCount = h.calls.length;
  assert.equal(before.phase, "paused"); assert.equal(before.counts.uncertain, 1); assert.equal(h.writes.length, 1);
  h.rules.update({ mode: "range", dateFormat: "dot" }); await flush();
  const after = await h.batchState();
  assert.deepEqual(plain(after.rules), plain(before.rules)); assert.deepEqual(plain(after.items[0].plan), plain(before.items[0].plan));
  assert.equal(h.calls.length, callCount); assert.equal(h.reads.length, readCount); assert.equal(h.writes.length, 1);
  assert.deepEqual(plain(h.rules.snapshot().rules), { mode: "range", dateFormat: "dot" });
  h.view.dispose();
});

test("shared edits during an in-flight batch preserve the exact confirmed write recipe", async () => {
  const heldWrite = deferred(), h = harness({ heldWrite }); await review(h);
  const reviewed = await h.batchState(); h.clickBatch("apply"); await flush();
  assert.equal(h.writes.length, 1); assert.equal(h.view.canLeave(), false);
  const readCount = h.reads.length, callCount = h.calls.length;
  h.rules.update({ mode: "range", dateFormat: "slash" }); await flush();
  assert.equal(h.reads.length, readCount); assert.equal(h.calls.length, callCount); assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].payload.after, reviewed.items[0].plan.after);
  heldWrite.resolve(); await flush();
  const finished = await h.batchState(); assert.equal(finished.counts.verified, 1);
  assert.deepEqual(plain(finished.rules), plain(reviewed.rules));
  assert.deepEqual(plain(h.rules.snapshot().rules), { mode: "range", dateFormat: "slash" });
  h.view.dispose();
});

test("return to selection restores shared choices and keeps the existing selected conversation IDs", async () => {
  const h = harness(); await review(h, ["one", "two"]);
  h.tab("current"); await flush(); h.currentRule("dateFormat", "slash"); await flush();
  h.tab("batch"); await flush(); h.clickBatch("back"); await flush();
  assert.equal(h.value("batch", "dateFormat"), "slash");
  assert.match(h.batchRoot.innerHTML, /预览\s*2\s*项/, "Back must not discard the user's accumulated selection");
  const before = h.calls.length; h.clickBatch("preview"); await flush();
  const selected = h.calls.slice(before).find((call) => call.action === "batch-preview");
  assert.deepEqual(selected.payload.conversationIds, ["one", "two"]);
  assert.equal(selected.payload.rules.dateFormat, "slash"); assert.equal(h.writes.length, 0);
  h.view.dispose();
});
