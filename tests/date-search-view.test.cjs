const { readPanelCss } = require("./helpers/read-panel-css.cjs");
const { createPanelRuntime } = require("./helpers/panel-runtime.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = (name) => fs.readFileSync(path.resolve(__dirname, "..", name), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class Element {
  constructor(ownerDocument = null) {
    this.ownerDocument = ownerDocument;
    this.children = []; this.dataset = {}; this.style = {
      setProperty(name, value) { this[name] = value; },
      getPropertyValue(name) { return this[name] || ""; },
    };
    this.listeners = new Map(); this.attributes = {}; this.className = "";
    this.classList = {
      toggle: (name, enabled) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        if (enabled) names.add(name); else names.delete(name);
        this.className = [...names].join(" ");
      },
      add: (name) => this.classList.toggle(name, true),
    };
  }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  replaceChildren(...children) {
    if (this.ownerDocument?.activeElement && this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = null;
    this.children = []; this.append(...children);
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  insertAdjacentHTML() {}
  matches(selector) {
    return selector.split(",").some((part) => {
      const value = part.trim();
      if (value.startsWith(".")) return value.slice(1).split(".").every((name) => this.className.split(/\s+/).includes(name));
      const data = /^\[data-([\w-]+)\]$/.exec(value);
      if (!data) return false;
      return Object.hasOwn(this.dataset, data[1].replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase()));
    });
  }
  querySelector(selector) { return descendants(this).find((child) => child.matches?.(selector)) || null; }
  querySelectorAll(selector) { return descendants(this).filter((child) => child.matches?.(selector)); }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest?.(selector) || null; }
  contains(node) { return this === node || descendants(this).includes(node); }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener); this.listeners.set(type, listeners);
  }
  emit(type, target, extra = {}) { for (const listener of this.listeners.get(type) || []) listener({ target, ...extra }); }
}

const descendants = (element) => (element.children || []).flatMap((child) => [child, ...descendants(child)]);
const findAll = (root, selector) => descendants(root).filter((child) => child.matches?.(selector));
const text = (element) => [element.textContent || "", ...descendants(element).map((child) => child.textContent || "")].join(" ");

function loadView(onAction, geometry = null, onExportAction = () => {}, nowMs = null, viewSource = source("src/features/search/ui/search-view.js"), options = {}) {
  let resizeCallback = null;
  const document = { hidden: false, activeElement: null, createElement: () => {
    const element = new Element(document);
    if (geometry) element.getBoundingClientRect = () => ({ height:
      Object.hasOwn(element.dataset, "searchResultList") ? geometry.listHeight
        : Object.hasOwn(element.dataset, "searchKeywordResult") ? geometry.rowHeight : 0 });
    return element;
  },
    createTextNode: (textContent) => ({ textContent }), addEventListener() {} };
  const root = new Element(document);
  const Clock = nowMs === null ? Date : class extends Date {
    constructor(...args) { super(...(args.length ? args : [nowMs])); }
    static now() { return nowMs; }
  };
  const runtime = createPanelRuntime({ document, console, Date: Clock, Intl,
    setTimeout: options.clock?.setTimeout || ((callback, delay, ...args) => {
      const timer = setTimeout(callback, delay, ...args);
      // Legacy cases need real debounce timing, but notices must not keep Node alive.
      if (delay === 5000) timer.unref();
      return timer;
    }), clearTimeout: options.clock?.clearTimeout || clearTimeout, queueMicrotask,
    ...(geometry ? { ResizeObserver: class {
      constructor(callback) { resizeCallback = callback; }
      observe(target) { assert.equal(target, root, "observe the stable view root, not replaceable result nodes"); }
    } } : {}) }, { transforms: {
    // Only these exact modules gain test-only observation seams. The runtime
    // recursively loads their full real import graph, including shared notices
    // and error presentation; no dependency is replaced or reconstructed here.
    "src/features/search/ui/search-query-controller.js": (original) => {
      const controllerSource = options.controllerSource || original;
      const marker = "return Object.freeze({ snapshot,";
      assert.equal(controllerSource.split(marker).length, 2, "instrument the actual controller's single public return");
      return controllerSource.replace(marker,
        "return Object.freeze({ state, loadFirstPage, loadNextPage, keywordSearch, snapshot,");
    },
    "src/features/search/ui/search-view.js": () => viewSource.replace(
      /return Object\.freeze\(\{ (render, setTabId, setIndexStatus, setActive, setVisible[^}]*) \}\);/,
      "return Object.freeze({ $1, controller, state: controller.state, loadFirstPage: controller.loadFirstPage, loadNextPage: controller.loadNextPage, keywordSearch: controller.keywordSearch });"),
  } });
  const { context } = runtime;
  for (const file of ["src/platform/protocol.js", "src/features/search/model/search.js", "src/platform/catalog/date-search.js", "src/platform/library/library-hydration.js"]) runtime.load(file);
  const { createSearchView } = runtime.load("src/features/search/ui/search-view.js");
  const view = createSearchView({ root, onExportAction, onInteraction: options.onInteraction, onAction: async (action, payload) => {
    const response = await onAction(action, payload);
    // Keyword transport fixtures exercise the same validated DTO as the live
    // bridge. Date fixtures intentionally keep their separate catalog contract.
    return action === "query" && payload.mode === "keyword" && response
      ? { schemaVersion: "tidy.search.v1", query: payload.query, ...response } : response;
  } });
  view.render({ translator: (key, values = {}) => `${key}:${JSON.stringify(values)}` });
  return { view, root, context, resize: (listHeight, rowHeight = geometry.rowHeight) => {
    Object.assign(geometry, { listHeight, rowHeight });
    resizeCallback();
  } };
}

const dateRows = (count, prefix = "date") => Array.from({ length: count }, (_, index) => ({
  resultId: `${prefix}-${index}`, conversationId: `conversation-${prefix}-${index}`, messageId: null, source: "conversation",
  title: "Known conversation", snippet: "", messageTimestamp: null, matchKind: "conversation-date",
  conversationCreatedAt: "2026-09-05T01:00:00.000Z", conversationUpdatedAt: "2026-09-05T02:00:00.000Z",
}));
const hit = (conversationId, messageId, extra = {}) => ({
  resultId: `hit:${conversationId}:${messageId}`, conversationId, messageId, source: "conversation",
  title: `Conversation ${conversationId}`, snippet: `needle ${messageId}`, messageTimestamp: null,
  conversationUpdatedAt: "2026-09-05T02:00:00.000Z", matchKind: "content", ...extra,
});
const page = (items, extra = {}) => ({ items, cursor: null, hasMore: false, partialResults: false, readErrors: [],
  catalogPhase: "settled", catalogRevision: 0, resultStable: true, ...extra });
const cachedPage = (values, limit = 7) => page(values.slice(0, limit), {
  cursor: values.length > limit ? `local:${limit}` : null, hasMore: values.length > limit,
  partialResults: true, coverageState: "partial", catalogPhase: "loading", resultStable: false,
});
function beginDate(view) {
  view.setActive(true); view.state.mode = "date"; view.state.pageSize = view.state.datePageSize;
  view.state.startDate = "2026-09-05"; view.state.endDate = "2026-09-05";
  return view.loadFirstPage();
}
function beginKeyword(view, query = "needle") {
  view.setActive(true); view.state.mode = "keyword"; view.state.query = query;
  return view.loadFirstPage();
}

for (const mode of ["date", "keyword"]) test(`${mode} result navigation changes selection without remounting results or controls`, async () => {
  const calls = [], items = mode === "date" ? dateRows(2) : [hit("one", "m1"), hit("two", "m2")];
  const { view, root, context } = loadView(async (action, payload) => {
    calls.push({ action, payload }); return action === "query" ? page(items) : null;
  });
  await (mode === "date" ? beginDate(view) : beginKeyword(view)); await flush();
  const panel = root.children[0], list = root.querySelector("[data-search-result-list]");
  const selector = mode === "date" ? "[data-search-result-id]" : "[data-search-match-id]";
  const targets = root.querySelectorAll(selector), target = targets[1];
  list.scrollTop = 87; root.emit("scroll", list); target.focus();
  const reads = calls.filter(call => call.action === "query").length;
  root.emit("click", target); await flush();
  assert.ok(root.children[0] === panel, "the same panel node stays mounted");
  assert.ok(root.querySelector("[data-search-result-list]") === list, "the result viewport stays mounted");
  assert.ok(root.querySelectorAll(selector)[1] === target, "the clicked row stays mounted");
  assert.ok(context.document.activeElement === target, "selection does not steal focus");
  assert.equal(list.scrollTop, 87);
  assert.equal(calls.filter(call => call.action === "query").length, reads);
  assert.equal(view.state.activeResultId, target.dataset.searchMatchId || target.dataset.searchResultId);
});

test("native conversation navigation changes only search highlighting, not its session, query or page", async () => {
  const calls = [], items = dateRows(3);
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload }); return action === "query" ? page(items) : null;
  });
  await beginDate(view); await flush();
  const panel = root.children[0], list = root.querySelector("[data-search-result-list]");
  const sessionId = view.state.sessionId, before = calls.length;
  list.scrollTop = 91; root.emit("scroll", list);
  for (const id of [items[0].conversationId, null, items[2].conversationId]) {
    view.setConversationId(id);
    assert.ok(root.children[0] === panel);
    assert.ok(root.querySelector("[data-search-result-list]") === list);
    assert.equal(list.scrollTop, 91); assert.equal(view.state.sessionId, sessionId);
    assert.equal(view.state.startDate, "2026-09-05"); assert.equal(view.state.page, 1);
    assert.equal(calls.length, before);
    assert.equal(view.state.activeResultId, items.find(item => item.conversationId === id)?.resultId || null);
  }
});

// Isolated presentation fixtures: exercising every label/animation phase must
// not dispatch catalog or keyword requests just to make the UI reach that state.
function renderSearchPhase(view, mode, phase, options = {}) {
  const working = phase === "searching" || phase === "refreshing";
  Object.assign(view.state, {
    mode, active: true, visible: true, searched: phase !== "waiting", loading: working, error: false,
    keywordRefreshing: phase === "refreshing", catalogRefreshing: phase === "refreshing",
    keywordStatus: { phase: working ? "loading" : phase === "waiting" ? "idle" : phase },
    indexStatus: null,
    resultStatus: { phase: working ? "loading" : phase === "paused" ? "paused" : "settled",
      resultStable: phase === "complete" },
  });
  view.render(options);
}

const exportSelection = (extra = {}) => ({
  active: true, returnTarget: "source", draftIds: [], basketConversationSources: {}, notice: null, ...extra,
});

test("date export entry is absent from keyword and enabled only for account-scoped date rows", async () => {
  const exports = [];
  const { view, root } = loadView(async (_action, payload) => payload?.mode === "keyword"
    ? page([hit("one", "m1")]) : page(dateRows(1), { accountKey: "workspace-a" }), null,
  (action, payload) => exports.push({ action, payload }));
  assert.equal(root.querySelector("[data-export-select-mode]"), null);
  await beginKeyword(view);
  assert.equal(root.querySelector("[data-export-select-mode]"), null);
  assert.deepEqual(plain(view.exportItems()), []);
  await beginDate(view);
  const entry = root.querySelector("[data-export-select-mode]");
  assert.equal(entry.dataset.exportSelectMode, "search");
  assert.equal(entry.disabled, false);
  root.emit("click", entry);
  assert.deepEqual(plain(exports), [{ action: "start", payload: { source: "search" } }]);
  const items = view.exportItems();
  assert.equal(items[0].accountKey, "workspace-a");
  assert.equal(items[0].conversationId, dateRows(1)[0].conversationId);
  items[0].title = "changed export copy";
  assert.equal(view.state.pages[0][0].title, "Known conversation", "export records do not mutate search data");
  view.setVisible(false);
});

test("date export excludes raw message hits, title hits and malformed conversation IDs", async () => {
  const valid = dateRows(1)[0];
  const values = [valid, hit("message", "m1"), hit("title", null, { matchKind: "title" }),
    { ...valid, resultId: "blank", conversationId: " " },
    { ...valid, resultId: "missing", conversationId: null },
    { ...valid, resultId: "message", messageId: "m2" },
    { ...valid, resultId: "foreign", source: "image" }];
  const { view } = loadView(async () => page(values, { accountKey: "workspace-a" }));
  await beginDate(view);
  assert.deepEqual(plain(view.exportItems().map((item) => item.conversationId)), [valid.conversationId]);
  for (const accountKey of [null, ""]) {
    view.state.dateAccountKey = accountKey;
    assert.deepEqual(plain(view.exportItems()), [], "missing account identity cannot enter the export basket");
  }
  view.setVisible(false);
});

test("date export selection uses whole-conversation rows and never opens a message", async () => {
  const calls = []; const exports = []; const values = dateRows(3);
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload }); return page(values, { accountKey: "workspace-a" });
  }, null, (action, payload) => exports.push({ action, payload }));
  await beginDate(view);
  const oldOpen = root.querySelector(".search-result__conversation-main");
  view.render({ exportSelection: exportSelection({
    draftIds: [values[0].conversationId],
    basketConversationSources: { [values[1].conversationId]: ["search"], [values[2].conversationId]: ["favorites"] },
  }) });
  const rows = findAll(root, "[data-export-draft-conversation]");
  assert.equal(rows.length, 3);
  assert.equal(rows[0].getAttribute("aria-pressed"), "true");
  assert.equal(rows[1].disabled, true);
  assert.match(text(rows[1]), /alreadyInExportList/);
  assert.equal(rows[2].disabled, false);
  assert.match(text(rows[2]), /supplementExportSource/);
  assert.equal(findAll(root, "[data-search-conversation-time]").length, 6);
  assert.equal(findAll(root, "[data-search-match-id]").length, 0);
  assert.equal(findAll(root, "[data-search-result-id]").length, 0);
  assert.doesNotMatch(text(root), /searchMatchCount|messageCount|messagesCount/);
  for (const row of rows) root.emit("click", row);
  root.emit("click", oldOpen);
  assert.deepEqual(plain(exports), [
    { action: "toggle", payload: { source: "search", id: values[0].conversationId } },
    { action: "toggle", payload: { source: "search", id: values[2].conversationId } },
  ]);
  assert.equal(calls.some((call) => call.action === "open"), false);
  assert.equal(calls.filter((call) => call.action === "query").length, 1, "selecting needs no message-history reads");
  const keywordTab = findAll(root, "[data-search-mode]").find((node) => node.dataset.searchMode === "keyword");
  assert.equal(keywordTab.disabled, true);
  root.emit("click", keywordTab);
  assert.equal(view.state.mode, "date");
  view.setVisible(false);
});

test("date export select-all acts only on the current page and retains external cross-page drafts", async () => {
  const exports = []; const values = dateRows(10);
  const { view, root } = loadView(async (_action, payload) => page(values.slice(0, payload?.limit || 7), {
    cursor: payload?.limit >= 10 ? null : "local:7", hasMore: payload?.limit < 10,
    accountKey: "workspace-a", total: 10,
  }), null,
  (action, payload) => exports.push({ action, payload }));
  await beginDate(view);
  const selection = exportSelection({ draftIds: [values[0].conversationId],
    basketConversationSources: { [values[8].conversationId]: ["search"] } });
  view.render({ exportSelection: selection });
  await view.loadNextPage(); await flush();
  assert.equal(view.state.page, 2);
  const range = root.querySelector("[data-export-select-current]");
  assert.match(range.textContent, /selectAllCurrentPage/);
  root.emit("click", range);
  assert.deepEqual(plain(exports.at(-1)), { action: "select-current", payload: {
    source: "search", ids: [values[7].conversationId, values[9].conversationId],
  } });
  selection.draftIds.push(values[7].conversationId, values[9].conversationId);
  view.render({ exportSelection: selection });
  assert.match(root.querySelector("[data-export-select-current]").textContent, /clearCurrentPageSelection/);
  assert.match(text(root.querySelector(".source-export-select__footer")), /exportSelectedCount:\{"count":3/);
  assert.deepEqual(plain(view.exportItems().map((item) => item.conversationId)), values.slice(7).map((item) => item.conversationId));
  const previous = findAll(root, "[data-search-page-direction]").find((node) => node.dataset.searchPageDirection === "previous");
  root.emit("click", previous);
  assert.equal(view.state.page, 1);
  assert.equal(root.querySelector("[data-export-draft-conversation]").getAttribute("aria-pressed"), "true");
  assert.deepEqual(selection.draftIds, [values[0].conversationId, values[7].conversationId, values[9].conversationId]);
  view.setVisible(false);
});

test("date export header, empty footer and populated submit preserve the shared source actions", async () => {
  const exports = [];
  const { view, root } = loadView(async () => page([], { accountKey: "workspace-a" }), null,
    (action, payload) => exports.push({ action, payload }));
  await beginDate(view);
  assert.equal(root.querySelector("[data-export-select-mode]").disabled, true);
  for (const [returnTarget, label] of [["source", "cancelExportSelection"], ["manage", "exportList"], ["batch-main", "exportBatch"]]) {
    view.render({ exportSelection: exportSelection({ returnTarget }) });
    assert.match(text(root.querySelector(".export-secondary-header")), new RegExp(label));
    assert.equal(root.querySelector("[data-export-selection-submit]").disabled, true);
    assert.match(text(root.querySelector(".source-export-select__footer")), /exportSelectedCount:\{"count":0/);
    root.emit("click", root.querySelector("[data-export-selection-back]"));
    assert.deepEqual(plain(exports.at(-1)), { action: "selection-back", payload: { source: "search" } });
  }
  view.render({ exportSelection: exportSelection({ draftIds: ["previous-page-selection"] }) });
  const submit = root.querySelector("[data-export-selection-submit]");
  assert.equal(submit.disabled, false, "an empty current page does not discard an existing cross-page draft");
  root.emit("click", submit);
  assert.deepEqual(plain(exports.at(-1)), { action: "submit", payload: { source: "search" } });
  view.setVisible(false);
});

test("date export blocks loading, failed and invalid criteria without exporting stale rows", async () => {
  const pending = deferred(); const exports = []; let queries = 0;
  const { view, root } = loadView(async (action) => {
    if (action !== "query") return null;
    queries += 1;
    return queries === 1 ? page(dateRows(1), { accountKey: "workspace-a" }) : pending.promise;
  }, null, (action, payload) => exports.push({ action, payload }));
  await beginDate(view);
  view.render({ exportSelection: exportSelection() });
  const oldRow = root.querySelector("[data-export-draft-conversation]");
  root.emit("click", findAll(root, "[data-search-date-field]")[1]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await flush();
  assert.equal(view.state.loading, true);
  assert.deepEqual(plain(view.exportItems()), []);
  root.emit("click", oldRow);
  assert.deepEqual(exports, [], "detached rows cannot select from the preceding search criteria");
  pending.resolve(page(dateRows(1), { accountKey: "workspace-a" }));
  await flush();
  assert.equal(view.exportItems().length, 1);
  view.state.error = { code: "SEARCH_UNAVAILABLE" };
  assert.deepEqual(plain(view.exportItems()), []);
  view.state.error = null;
  view.state.startDate = "2026-09-06"; view.state.endDate = "2026-09-05";
  assert.deepEqual(plain(view.exportItems()), []);
  view.state.startDate = ""; view.state.endDate = "";
  assert.deepEqual(plain(view.exportItems()), []);
  view.setVisible(false);
});

test("date export can select confirmed rows while the directory continues loading", async () => {
  const { view, root } = loadView(async () => page(dateRows(1), {
    accountKey: "workspace-a", resultStable: false, catalogPhase: "loading", partialResults: true,
  }));
  await beginDate(view);
  assert.equal(view.state.loading, false);
  assert.equal(view.exportItems().length, 1);
  assert.equal(root.querySelector("[data-export-select-mode]").disabled, false);
  view.setVisible(false);
});

test("date source feedback opens the shared basket and never appears in keyword results", async () => {
  const exports = [];
  const { view, root } = loadView(async () => page(dateRows(1), { accountKey: "workspace-a" }), null,
    (action, payload) => exports.push({ action, payload }));
  await beginDate(view);
  view.render({ exportSelection: exportSelection({ active: false, notice: "added one conversation" }) });
  assert.match(text(root.querySelector(".export-source-notice")), /added one conversation/);
  root.emit("click", root.querySelector("[data-export-view-basket]"));
  assert.deepEqual(plain(exports), [{ action: "view-basket", payload: { source: "search" } }]);
  view.state.mode = "keyword";
  view.render();
  assert.equal(root.querySelector(".export-source-notice"), null);
  assert.equal(root.querySelector("[data-export-select-mode]"), null);
  view.setVisible(false);
});

test("preparing date export preserves the current date search and cancels a keyword session", async () => {
  const calls = [];
  const { view } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    return page(payload?.mode === "keyword" ? [hit("one", "m1")] : dateRows(1), { accountKey: "workspace-a" });
  });
  await beginDate(view);
  const sessionId = view.state.sessionId; const queries = calls.filter((entry) => entry.action === "query").length;
  view.prepareDateExport(); await flush();
  assert.equal(view.state.mode, "date");
  assert.equal(view.state.sessionId, sessionId);
  assert.equal(view.state.startDate, "2026-09-05");
  assert.equal(view.exportItems().length, 1);
  assert.equal(calls.filter((entry) => entry.action === "query").length, queries);
  await beginKeyword(view);
  view.prepareDateExport(); await flush();
  assert.equal(view.state.mode, "date");
  assert.equal(view.keywordSearch.snapshot().phase, "idle");
  assert.equal(view.state.startDate, "2026-09-05");
  assert.equal(view.state.pages.flat().some((item) => item.messageId === "m1"), false);
  view.setVisible(false);
});

test("keyword/date modes have disjoint visible controls and payloads", async () => {
  const calls = [];
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    return action === "query" ? page(payload.mode === "keyword" ? [hit("one", "m1")] : dateRows(1)) : null;
  });
  assert.equal(view.state.mode, "keyword");
  assert.equal(findAll(root, "[data-search-mode]").length, 2);
  assert.equal(findAll(root, "[data-global-search]").length, 1);
  assert.equal(findAll(root, "[data-search-date]").length, 0);
  assert.equal(findAll(root, "[data-search-sort-direction]").length, 0);
  view.state.startDate = "2026-09-05"; view.state.endDate = "2026-09-04";
  await beginKeyword(view);
  const keyword = calls.find((call) => call.action === "query").payload;
  assert.deepEqual(Object.keys(keyword).sort(), ["cursor", "limit", "mode", "query", "sessionId"].sort());
  assert.equal(view.state.dateError, false, "retained invalid dates cannot affect keyword search");
  root.emit("click", findAll(root, "[data-search-mode]")[1]);
  assert.equal(view.state.pages.length, 0);
  await beginDate(view);
  const date = calls.filter((call) => call.action === "query").at(-1).payload;
  assert.equal(date.mode, "date"); assert.equal(date.query, "");
  assert.equal(date.dateField, "createdAt"); assert.equal(date.hasDate, true);
  assert.equal(findAll(root, "[data-global-search]").length, 0);
  assert.equal(findAll(root, "[data-search-date-field]").length, 2);
  assert.equal(findAll(root, "[data-search-date]").length, 2);
  assert.equal(findAll(root, "[data-search-sort-direction]").length, 1);
  assert.doesNotMatch(text(root), /Combined|MatchedMessageTime/);
  view.setVisible(false);
});

test("date cards show both conversation times and never expose message expansion", async () => {
  const calls = []; const values = dateRows(2); values[1].conversationUpdatedAt = null;
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload }); return action === "query" ? page(values) : null;
  });
  view.state.query = "retained keyword";
  await beginDate(view);
  assert.equal(findAll(root, "[data-search-conversation-card]").length, 2);
  assert.equal(findAll(root, "[data-search-expand]").length, 0);
  assert.equal(findAll(root, "[data-search-match-count-state]").length, 0);
  assert.equal(findAll(root, "[data-search-conversation-time]").length, 4);
  assert.deepEqual(findAll(root, ".search-result__conversation-time.is-selected").map((node) => node.dataset.searchConversationTime), ["createdAt", "createdAt"]);
  assert.match(text(root), /noTime/);
  root.emit("click", root.querySelector(".search-result__conversation-main"));
  assert.equal(calls.at(-1).payload.messageId, null); assert.equal(calls.at(-1).payload.query, "");
  root.emit("click", findAll(root, "[data-search-date-field]")[1]);
  await view.loadFirstPage();
  assert.equal(calls.filter((call) => call.action === "query").at(-1).payload.dateField, "updatedAt");
  assert.deepEqual(findAll(root, ".search-result__conversation-time.is-selected").map((node) => node.dataset.searchConversationTime), ["updatedAt", "updatedAt"]);
  assert.equal(root.querySelector(".search-sort-field").children.find((option) => option.selected).value, "createdAt",
    "changing the filter basis must not change the independent sort field");
  view.setVisible(false);
});

for (const [language, shortLabels, fullLabels] of [
  ["zh-CN", ["创建", "更新"], ["创建时间", "更新时间"]],
  ["zh-TW", ["建立", "更新"], ["建立時間", "更新時間"]],
  ["en", ["Created", "Updated"], ["Created", "Updated"]],
  ["ja", ["作成", "更新"], ["作成日時", "更新日時"]],
]) {
  test(`date cards and field controls reuse shared ${language} created/updated labels`, async () => {
    const calls = [];
    const rows = dateRows(1);
    const { view, root, context } = loadView(async (action, payload) => {
      calls.push({ action, payload }); return action === "query" ? page(rows) : null;
    });
    vm.runInContext(source("src/messages/i18n.js").replace(/^export /gm, ""), context);
    const t = context.createTranslator(language);
    // 完整字段名与卡片简称共用词典；不要为搜索单独维护另一套时间术语。
    assert.deepEqual([t("created"), t("updated")], shortLabels);
    assert.deepEqual([t("createdTime"), t("updatedTime")], fullLabels);
    view.render({ translator: t });
    await beginDate(view);

    const times = findAll(root, "[data-search-conversation-time]");
    assert.deepEqual(times.map((node) => node.children[0].textContent), shortLabels);
    assert.deepEqual(times.map((node) => node.dataset.searchConversationTime), ["createdAt", "updatedAt"]);
    assert.deepEqual(times.map((node) => node.children[1].dateTime),
      [rows[0].conversationCreatedAt, rows[0].conversationUpdatedAt], "short labels do not alter timestamps");
    assert.deepEqual(findAll(root, "[data-search-date-field]").map((node) => node.textContent), fullLabels);
    assert.deepEqual(root.querySelector("[data-search-sort-field]").children.map((node) => node.textContent), fullLabels);
    assert.equal(calls.filter((call) => call.action === "query").length, 1);
    assert.ok(calls.every((call) => call.action === "query"), "rendering metadata adds no history reads");
    view.setVisible(false);
  });
}

test("directory revisions refresh one prefix without resetting session, page or selection", async () => {
  const calls = []; let values = dateRows(25);
  const { view } = loadView(async (action, payload) => {
    calls.push({ action, payload }); return action === "query" ? cachedPage(values, payload.limit) : null;
  });
  view.setActive(true); assert.equal(calls.length, 0);
  await beginDate(view);
  const sessionId = view.state.sessionId;
  await view.loadNextPage(); await flush();
  assert.equal(view.state.page, 2);
  view.state.activeResultId = "date-9"; view.state.scrollTop = 53;
  values = [...dateRows(1, "new"), ...values];
  view.setIndexStatus({ sessionId, phase: "loading", revision: 1, coverageState: "partial", progress: { pages: 1, discovered: 10 } });
  view.setIndexStatus({ sessionId, phase: "loading", revision: 2, coverageState: "partial", progress: { pages: 2, discovered: 20 } });
  assert.equal(view.state.loading, false);
  await flush();
  const queries = calls.filter((item) => item.action === "query");
  assert.equal(queries.length, 3); assert.equal(queries[2].payload.refresh, true);
  assert.equal(queries[2].payload.cursor, null); assert.equal(queries[2].payload.limit, 14);
  assert.equal(queries[2].payload.sessionId, sessionId); assert.equal(view.state.page, 2);
  assert.equal(view.state.activeResultId, "date-9"); assert.equal(view.state.scrollTop, 53);
  assert.deepEqual(plain(view.state.pages.flat().map((item) => item.resultId)), values.slice(0, 14).map((item) => item.resultId));
  view.setVisible(false);
});

test("directory progress during initial loading refreshes after the query drains", async () => {
  const pending = deferred(); const queries = [];
  const { view } = loadView(async (action, payload) => {
    if (action !== "query") return null;
    queries.push(payload); return queries.length === 1 ? pending.promise : cachedPage(dateRows(9), payload.limit);
  });
  const first = beginDate(view); const sessionId = view.state.sessionId;
  view.setIndexStatus({ sessionId, phase: "loading", revision: 1, coverageState: "partial", progress: {} });
  await flush(); assert.equal(queries.length, 1);
  pending.resolve(cachedPage([])); await first; await flush();
  assert.equal(queries.length, 2); assert.equal(queries[1].refresh, true);
  assert.equal(queries[1].sessionId, sessionId); assert.equal(view.state.pages[0].length, 7);
  view.setVisible(false);
});

test("date sorting and lifecycle preserve the date session; keyword never resumes catalog reads", async () => {
  const calls = [];
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    return action === "query" ? page(payload.mode === "date" ? dateRows(1) : [hit("one", "m1")]) : null;
  });
  await beginDate(view); const sessionId = view.state.sessionId;
  const direction = root.querySelector("[data-search-sort-direction]");
  assert.equal(direction.textContent, "↓");
  assert.match(direction.getAttribute("aria-label"), /sortDescending.*createdTime/);
  assert.equal(direction.title, direction.getAttribute("aria-label"));
  root.emit("click", root.querySelector("[data-search-sort-direction]")); await flush();
  const sorted = calls.filter((call) => call.action === "query").at(-1).payload;
  assert.equal(sorted.refresh, true); assert.equal(sorted.direction, "asc"); assert.equal(sorted.sessionId, sessionId);
  view.setVisible(false); assert.equal(calls.at(-1).payload.reason, "hidden");
  view.setVisible(true); await flush(); view.setActive(false);
  assert.equal(calls.at(-1).payload.reason, "route-away"); view.setActive(true); await flush();
  assert.equal(calls.filter((call) => call.action === "resume").length, 2);
  view.setTabId(44, { renderNow: false }); assert.equal(view.state.sessionId, null);
  await beginKeyword(view); const before = calls.filter((call) => call.action === "query").length;
  view.setIndexStatus({ phase: "loading", revision: 99, coverageState: "partial", progress: {} });
  view.setVisible(false); view.setVisible(true); await flush();
  assert.equal(calls.filter((call) => call.action === "resume").length, 2);
  assert.equal(calls.filter((call) => call.action === "query").length, before); view.setVisible(false);
});

test("synthetic status preview uses the current public API and closes the private calendar when replacing its fixture", async () => {
  const tool = source("tools/search-status-preview.cjs");
  const start = tool.indexOf("async function previewSearchView()");
  const controllerStart = tool.indexOf("async function previewSearchQueryController()", start);
  const end = tool.indexOf("const bootstrapModule", controllerStart);
  assert.ok(start >= 0 && controllerStart > start && end > controllerStart, "both preview transforms come from the real tool");
  const globals = { fs: fs.promises, path, repository: path.resolve(__dirname, "..") };
  const transform = vm.runInNewContext(`(${tool.slice(start, controllerStart).trim()})`, globals);
  const transformController = vm.runInNewContext(`(${tool.slice(controllerStart, end).trim()})`, globals);
  const clock = noticeClock();
  const { view, root } = loadView(async () => null, null, () => {}, null, await transform(), {
    clock, controllerSource: await transformController(),
  });
  assert.equal(typeof view.setConversationId, "function");
  assert.equal(typeof view.completeNavigation, "function");
  view.__previewSetState({ mode: "date", startDate: "2025-12-29", endDate: "2026-01-03" });
  root.emit("click", findAll(root, "[data-search-date]")[0]);
  assert.ok(root.querySelector("[data-search-calendar-layer]"));
  view.__previewSetState({ mode: "keyword" });
  assert.equal(root.querySelector("[data-search-calendar-layer]"), null);
  for (const mode of ["date", "keyword"]) {
    view.__previewSetState({ mode, active: true, visible: true, searched: true,
      error: { code: "SEARCH_UNAVAILABLE", status: 503 } });
    assert.ok(root.querySelector(".search-" + mode + "-error"));
    clock.advance(4000); view.render(); clock.advance(1000);
    assert.equal(root.querySelector(".search-" + mode + "-error"), null, "preview rerender obeys the actual five-second lifetime");
  }
  assert.doesNotMatch(source("src/features/search/ui/search-view.js"), /__previewSetState/);
});

test("calendar owner is private; search query controller keeps the sole date criteria and scheduler", () => {
  const { view } = loadView(async () => null);
  for (const key of ["calendarTarget", "calendarMonth", "calendarView"]) assert.equal(Object.hasOwn(view.state, key), false);
  const calendar = source("src/features/search/ui/search-calendar.js");
  assert.doesNotMatch(calendar, /onAction|scheduleSearch|invalidateCriteria|setTimeout|addEventListener|keywordSearch|exportSelection/);
  assert.doesNotMatch(source("src/features/search/ui/search-view.js"), /state\.calendar|function makeSearchCalendar/);
  assert.match(calendar, /return Object\.freeze\(\{/);
});

test("mode, tab and export preparation close the calendar without clearing date criteria", () => {
  const { view, root } = loadView(async () => null);
  Object.assign(view.state, { mode: "date", pageSize: view.state.datePageSize, startDate: "2025-12-29", endDate: "2026-01-03" });
  view.render();
  const open = () => root.emit("click", findAll(root, "[data-search-date]").find(node => node.dataset.searchDate === "start"));
  open(); assert.ok(root.querySelector("[data-search-calendar-layer]"));
  view.setTabId(7);
  assert.equal(root.querySelector("[data-search-calendar-layer]"), null);
  open(); view.prepareDateExport();
  assert.equal(root.querySelector("[data-search-calendar-layer]"), null);
  open();
  root.emit("click", findAll(root, "[data-search-mode]").find(node => node.dataset.searchMode === "keyword"));
  root.emit("click", findAll(root, "[data-search-mode]").find(node => node.dataset.searchMode === "date"));
  assert.equal(root.querySelector("[data-search-calendar-layer]"), null);
  assert.deepEqual([view.state.startDate, view.state.endDate], ["2025-12-29", "2026-01-03"]);
  view.setVisible(false);
});

test("an open calendar reads the new timezone and rejects a formerly valid detached day", () => {
  const calls = [];
  const { view, root } = loadView(async action => { calls.push(action); }, null, () => {}, Date.parse("2026-09-08T00:30:00.000Z"));
  Object.assign(view.state, { mode: "date", pageSize: view.state.datePageSize, startDate: "2026-09-07", endDate: "2026-09-07" });
  view.render({ timeZone: "UTC" });
  root.emit("click", findAll(root, "[data-search-date]")[0]);
  const oldDay = findAll(root, "[data-calendar-date]").find(node => node.dataset.calendarDate === "2026-09-08");
  assert.equal(oldDay.disabled, false);
  view.render({ timeZone: "America/Los_Angeles" });
  assert.equal(findAll(root, "[data-calendar-date]").find(node => node.dataset.calendarDate === "2026-09-08").disabled, true);
  const count = calls.length;
  root.emit("click", oldDay);
  assert.deepEqual([view.state.startDate, view.state.endDate], ["2026-09-07", "2026-09-07"]);
  assert.equal(calls.length, count);
});

test("calendar endpoints follow the newly chosen date before rendering and automatically querying", async () => {
  const calls = [];
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload }); return action === "query" ? page(dateRows(1), { total: 1 }) : null;
  });
  await beginDate(view);
  for (const [target, date] of [["end", "2026-09-01"], ["start", "2026-09-04"]]) {
    root.emit("click", findAll(root, "[data-search-date]").find(node => node.dataset.searchDate === target));
    const day = findAll(root, "[data-calendar-date]").find(node => node.dataset.calendarDate === date);
    assert.ok(day);
    root.emit("click", day);
    assert.equal(view.state.startDate, date); assert.equal(view.state.endDate, date);
    assert.equal(view.state.dateError, false);
    assert.doesNotMatch(text(root), /searchDateRangeError/);
    const before = calls.filter(c => c.action === "query").length;
    await new Promise(resolve => setTimeout(resolve, 15)); await flush();
    assert.equal(calls.filter(c => c.action === "query").length, before + 1, "no search-button click is required");
    const query = calls.filter(c => c.action === "query").at(-1).payload;
    assert.equal(query.endMs - query.startMs, 86400000);
    assert.equal(new Date(query.startMs).toISOString().slice(0, 10), date);
  }
  assert.ok(calls.every(c => ["query", "pause"].includes(c.action)));
  view.setVisible(false);
});

test("cross-year calendar keeps adjacent-month range bands and distinguishes the edited endpoint", () => {
  const { view, root } = loadView(async () => null);
  Object.assign(view.state, { mode: "date", pageSize: view.state.datePageSize, startDate: "2025-12-29", endDate: "2026-01-03" });
  view.render();
  root.emit("click", findAll(root, "[data-search-date]").find(node => node.dataset.searchDate === "start"));
  const days = findAll(root, "[data-calendar-date]");
  const day = value => days.find(node => node.dataset.calendarDate === value);
  assert.equal(days.length, 42);
  assert.equal(day("2025-12-29").matches(".is-range-edge.is-selected"), true);
  assert.equal(day("2026-01-01").matches(".is-outside.is-in-range"), true);
  assert.equal(day("2026-01-03").matches(".is-outside.is-range-edge"), true);
  assert.equal(day("2026-01-04").matches(".is-in-range"), false);
  root.emit("click", findAll(root, "[data-search-date]").find(node => node.dataset.searchDate === "end"));
  assert.equal(root.querySelector(".search-calendar__title").textContent, 'searchCalendarMonthTitle:{"year":2026,"month":1}');
  const selected = root.querySelector(".is-selected");
  assert.equal(selected.dataset.calendarDate, "2026-01-03");
  assert.equal(findAll(root, "[data-search-date]").find(node => node.dataset.searchDate === "end").getAttribute("aria-expanded"), "true");
});

test("calendar focus survives repaint and view changes, returns to its endpoint, and never steals outside focus", () => {
  const { view, root, context } = loadView(async () => null);
  Object.assign(view.state, { mode: "date", pageSize: view.state.datePageSize, startDate: "2025-12-29", endDate: "2026-01-03" });
  view.render();
  const doc = context.document;
  const click = node => { node.focus(); root.emit("click", node); };
  click(findAll(root, "[data-search-date]").find(node => node.dataset.searchDate === "start"));
  assert.equal(doc.activeElement.dataset.calendarDate, "2025-12-29", "open moves into the selected day");
  const original = doc.activeElement;
  view.render();
  assert.notEqual(doc.activeElement, original, "focus refers to the replacement DOM node");
  assert.equal(doc.activeElement.dataset.calendarDate, "2025-12-29");
  click(findAll(root, "[data-calendar-nav]").find(node => node.dataset.calendarNav === "previous"));
  assert.equal(doc.activeElement.dataset.calendarNav, "previous");
  click(root.querySelector("[data-calendar-view-toggle]"));
  assert.equal(doc.activeElement.dataset.calendarMonthChoice, "11");
  click(root.querySelector("[data-calendar-view-toggle]"));
  assert.equal(doc.activeElement.dataset.calendarYearChoice, "2025");
  click(doc.activeElement);
  assert.equal(doc.activeElement.dataset.calendarMonthChoice, "11");
  click(doc.activeElement);
  assert.equal(doc.activeElement.dataset.calendarDate, "2025-11-01", "fallback selects a valid current-month day");
  click(root.querySelector("[data-calendar-close]"));
  assert.equal(doc.activeElement.dataset.searchDate, "start");
  click(findAll(root, "[data-search-date]").find(node => node.dataset.searchDate === "end"));
  assert.equal(doc.activeElement.dataset.calendarDate, "2026-01-03");
  let prevented = false;
  root.emit("keydown", doc.activeElement, { key: "Escape", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(doc.activeElement.dataset.searchDate, "end");
  const external = doc.createElement("button"); external.focus();
  view.render();
  assert.equal(doc.activeElement, external);
});

test("choosing and clearing a date retain endpoint focus through automatic result rerenders", async () => {
  const calls = [];
  const { view, root, context } = loadView(async (action, payload) => {
    calls.push({ action, payload }); return action === "query" ? page([], { total: 0 }) : null;
  });
  await beginDate(view);
  const click = node => { node.focus(); root.emit("click", node); };
  click(findAll(root, "[data-search-date]").find(node => node.dataset.searchDate === "start"));
  click(findAll(root, "[data-calendar-date]").find(node => node.dataset.calendarDate === "2026-09-04"));
  await new Promise(resolve => setTimeout(resolve, 15)); await flush();
  assert.equal(context.document.activeElement.dataset.searchDate, "start");
  assert.equal(view.state.startDate, "2026-09-04");
  click(findAll(root, "[data-search-date]").find(node => node.dataset.searchDate === "end"));
  click(root.querySelector("[data-calendar-clear]"));
  await new Promise(resolve => setTimeout(resolve, 15)); await flush();
  assert.equal(context.document.activeElement.dataset.searchDate, "end");
  assert.equal(view.state.endDate, "");
  assert.ok(calls.every(call => ["query", "pause"].includes(call.action)));
  view.setVisible(false);
});

test("calendar lower bound disables earlier days, months, years and backward navigation", () => {
  const calls = [];
  const { view, root, context } = loadView(async (action) => { calls.push(action); return null; }, null,
    () => {}, Date.parse("2026-09-08T00:30:00.000Z"));
  Object.assign(view.state, { mode: "date", pageSize: view.state.datePageSize, startDate: "2022-11-30", endDate: "2022-11-30" });
  view.render();
  root.emit("click", findAll(root, "[data-search-date]").find(node => node.dataset.searchDate === "start"));
  const find = (selector, key, value) => findAll(root, selector).find((node) => node.dataset[key] === value);
  const forgedClick = (key, value) => {
    const before = [root.querySelector(".search-calendar__title").textContent, view.state.startDate, view.state.endDate];
    const button = context.document.createElement("button");
    button.dataset[key] = value; button.disabled = false;
    root.querySelector(".search-calendar").append(button);
    root.emit("click", button);
    assert.deepEqual([root.querySelector(".search-calendar__title").textContent, view.state.startDate, view.state.endDate], before,
      `forged ${key}=${value} cannot escape the supported range`);
  };
  for (const day of findAll(root, "[data-calendar-date]")) {
    assert.equal(day.disabled, day.dataset.calendarDate < "2022-11-30");
  }
  assert.equal(find("[data-calendar-date]", "calendarDate", "2022-11-30").disabled, false);
  const previous = () => find("[data-calendar-nav]", "calendarNav", "previous");
  assert.equal(previous().disabled, true);
  root.emit("click", previous());
  assert.equal(root.querySelector(".search-calendar__title").textContent, 'searchCalendarMonthTitle:{"year":2022,"month":11}');
  forgedClick("calendarDate", "2022-11-29");
  forgedClick("calendarNav", "previous");

  root.emit("click", root.querySelector("[data-calendar-view-toggle]"));
  assert.ok(root.querySelector(".search-calendar__choices--months"));
  for (const month of findAll(root, "[data-calendar-month-choice]")) {
    assert.equal(month.disabled, Number(month.dataset.calendarMonthChoice) < 11);
  }
  assert.equal(previous().disabled, true);
  forgedClick("calendarMonthChoice", "10");
  forgedClick("calendarMonthChoice", "0");
  forgedClick("calendarNav", "previous");

  root.emit("click", root.querySelector("[data-calendar-view-toggle]"));
  assert.ok(root.querySelector(".search-calendar__choices--years"));
  for (const year of findAll(root, "[data-calendar-year-choice]")) {
    const value = Number(year.dataset.calendarYearChoice);
    assert.equal(year.disabled, value < 2022 || value > 2026);
  }
  assert.equal(previous().disabled, true);
  forgedClick("calendarYearChoice", "2021");
  forgedClick("calendarNav", "previous");
  assert.deepEqual(calls, [], "calendar navigation cannot fetch history or submit a date query");
  view.setVisible(false);
});

for (const [timeZone, today] of [["UTC", "2026-09-08"], ["America/Los_Angeles", "2026-09-07"]]) {
  test(`calendar upper bound follows today in ${timeZone} across day, month and year navigation`, () => {
    const { view, root, context } = loadView(async () => null, null, () => {}, Date.parse("2026-09-08T00:30:00.000Z"));
    Object.assign(view.state, { mode: "date", pageSize: view.state.datePageSize, startDate: today, endDate: today, timeZone });
    view.render();
    root.emit("click", findAll(root, "[data-search-date]").find(node => node.dataset.searchDate === "end"));
    const find = (selector, key, value) => findAll(root, selector).find((node) => node.dataset[key] === value);
    const next = () => find("[data-calendar-nav]", "calendarNav", "next");
    const forgedClick = (key, value) => {
      const before = [root.querySelector(".search-calendar__title").textContent, view.state.startDate, view.state.endDate];
      const button = context.document.createElement("button");
      button.dataset[key] = value; button.disabled = false;
      root.querySelector(".search-calendar").append(button); root.emit("click", button);
      assert.deepEqual([root.querySelector(".search-calendar__title").textContent, view.state.startDate, view.state.endDate], before);
    };
    for (const day of findAll(root, "[data-calendar-date]")) {
      assert.equal(day.disabled, day.dataset.calendarDate > today);
    }
    assert.equal(find("[data-calendar-date]", "calendarDate", today).disabled, false);
    assert.equal(next().disabled, true);
    forgedClick("calendarDate", "2026-09-09");
    forgedClick("calendarNav", "next");
    root.emit("click", root.querySelector("[data-calendar-view-toggle]"));
    for (const month of findAll(root, "[data-calendar-month-choice]")) {
      assert.equal(month.disabled, Number(month.dataset.calendarMonthChoice) > 9);
    }
    assert.equal(next().disabled, true);
    forgedClick("calendarMonthChoice", "10");
    forgedClick("calendarMonthChoice", "13");
    forgedClick("calendarNav", "next");
    root.emit("click", root.querySelector("[data-calendar-view-toggle]"));
    assert.equal(find("[data-calendar-year-choice]", "calendarYearChoice", "2026").disabled, false);
    assert.equal(find("[data-calendar-year-choice]", "calendarYearChoice", "2027").disabled, true);
    assert.equal(next().disabled, true);
    forgedClick("calendarYearChoice", "2027");
    forgedClick("calendarNav", "next");
    root.emit("click", find("[data-calendar-year-choice]", "calendarYearChoice", "2026"));
    root.emit("click", find("[data-calendar-month-choice]", "calendarMonthChoice", "9"));
    root.emit("click", find("[data-calendar-date]", "calendarDate", today));
    assert.equal(view.state.endDate, today, "the inclusive upper endpoint remains selectable");
    view.setVisible(false);
  });
}

test("date criteria reject unsupported endpoints without a query and bound open ends", async () => {
  const calls = [];
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload }); return action === "query" ? page(dateRows(1)) : null;
  }, null, () => {}, Date.parse("2026-09-08T00:30:00.000Z"));
  view.setActive(true); view.state.mode = "date"; view.state.pageSize = view.state.datePageSize;
  for (const [startDate, endDate] of [["2022-11-29", "2026-09-08"], ["2022-11-30", "2026-09-09"]]) {
    Object.assign(view.state, { startDate, endDate }); await view.loadFirstPage();
    assert.equal(view.state.dateError, true);
    assert.match(text(root), /searchDateBoundsError/);
    assert.equal(calls.filter((call) => call.action === "query").length, 0);
  }
  for (const [startDate, endDate] of [["2022-11-30", ""], ["", "2026-09-08"]]) {
    Object.assign(view.state, { startDate, endDate }); await view.loadFirstPage();
    const request = calls.filter((call) => call.action === "query").at(-1).payload;
    assert.equal(request.startMs, Date.parse("2022-11-30T00:00:00.000Z"));
    assert.equal(request.endMs, Date.parse("2026-09-09T00:00:00.000Z"));
  }
  view.setVisible(false);
});

test("calendar state colors use theme tokens without a dark-mode selector overriding their priority", () => {
  const css = readPanelCss();
  assert.ok(css.indexOf("button.is-in-range {") < css.indexOf("button.is-outside {"));
  assert.ok(css.indexOf("button.is-outside {") < css.indexOf("button.is-range-edge {"));
  assert.match(css, /button\.is-outside\s*\{\s*color:\s*color-mix/);
  assert.match(css, /button\[aria-expanded="true"\]\s*\{[^}]*border-color: var\(--accent\)/);
  assert.doesNotMatch(css, /:root\[data-native-color-scheme="dark"\] \.search-(?:calendar__days button|calendar__choices button|date-field > button)/);
  assert.match(css, /button\.is-selected:focus-visible\s*\{[^}]*color: var\(--accent-foreground\)/);
});

test("date sort field and direction remain independent of the filter and use only local snapshot refreshes", async () => {
  const calls = [];
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload }); return action === "query" ? page(dateRows(1), { total: 1 }) : null;
  });
  await beginDate(view); const sessionId = view.state.sessionId;
  const field = root.querySelector("[data-search-sort-field]");
  field.value = "updatedAt"; root.emit("change", field); await flush();
  root.emit("click", root.querySelector("[data-search-sort-direction]")); await flush();
  let query = calls.filter(c => c.action === "query").at(-1).payload;
  assert.equal(query.dateField, "createdAt"); assert.equal(query.sortField, "updatedAt");
  assert.equal(query.direction, "asc"); assert.equal(query.refresh, true); assert.equal(query.sessionId, sessionId);
  root.emit("click", findAll(root, "[data-search-date-field]")[1]);
  await new Promise(resolve => setTimeout(resolve, 15)); await flush();
  const other = root.querySelector("[data-search-sort-field]");
  other.value = "createdAt"; root.emit("change", other); await flush();
  query = calls.filter(c => c.action === "query").at(-1).payload;
  assert.equal(query.dateField, "updatedAt"); assert.equal(query.sortField, "createdAt");
  assert.equal(query.direction, "asc"); assert.equal(query.refresh, true);
  const direction = root.querySelector("[data-search-sort-direction]");
  assert.equal(direction.textContent, "↑");
  assert.match(direction.getAttribute("aria-label"), /sortAscending.*createdTime/);
  assert.equal(direction.title, direction.getAttribute("aria-label"));
  assert.equal(calls.filter(c => c.action === "refresh-catalog" || c.action === "expand").length, 0);
  view.setVisible(false);
});

test("both modes keep one shared status row between controls and results", () => {
  const { view, root } = loadView(async () => null);
  for (const mode of ["keyword", "date"]) {
    view.state.mode = mode; view.render();
    const panel = root.querySelector(".search-panel");
    const controls = root.querySelector(".search-control-section");
    const status = root.querySelector("[data-search-status]");
    const results = root.querySelector(".search-results-area");
    assert.equal(findAll(root, "[data-search-status]").length, 1);
    assert.equal(status.role, "status");
    assert.equal(status.dataset.searchStatus, "waiting");
    assert.equal(status.getAttribute("aria-live"), "polite");
    assert.equal(status.getAttribute("aria-atomic"), "true");
    assert.equal(panel.children.indexOf(status), panel.children.indexOf(controls) + 1);
    assert.equal(panel.children.indexOf(results), panel.children.indexOf(status) + 1);
    assert.equal(root.querySelector(".search-list-heading").parentNode, root.querySelector(".search-list-section"));
    assert.equal(status.querySelector(".tidy-loading-flower"), null);
    assert.equal(text(status).trim(), "", "neither mode labels an idle status slot");
    if (mode === "date") {
      assert.equal(controls.contains(root.querySelector(".search-sort-section")), true,
        "date sorting belongs before the shared status row");
    }
    assert.equal(root.querySelector(".search-keyword-heading"), null);
    assert.equal(root.querySelector(".search-keyword-status"), null);
    assert.equal(root.querySelector(".search-keyword-progress"), null);
    assert.equal(root.querySelector(".search-date-status"), null);
  }
  const css = readPanelCss();
  assert.doesNotMatch(css, /\.search-(?:keyword-heading|keyword-status|keyword-progress|date-status)\b/);
  assert.doesNotMatch(css, /\.search-results-area--date[^{}]*\{[^}]*grid-template-rows/);
});

test("both search modes use exactly six clockwise petals with static hands and hub", () => {
  const { view, root } = loadView(async () => { assert.fail("rendering a flower must not query data"); });
  let previousMarkup = null;
  for (const mode of ["keyword", "date"]) {
    renderSearchPhase(view, mode, "searching");
    const flower = root.querySelector(".tidy-loading-flower");
    assert.equal(findAll(root, ".tidy-loading-flower").length, 1);
    assert.equal(flower.getAttribute("aria-hidden"), "true", "the status label, not decorative paths, is announced");
    assert.match(flower.innerHTML, /^<svg\b[^>]*viewBox="0 0 24 24"[^>]*aria-hidden="true"[^>]*focusable="false"/);
    const petals = [...flower.innerHTML.matchAll(/<path\b[^>]*class="tidy-loading-flower__petal"[^>]*\/>/g)].map(match => match[0]);
    assert.equal(petals.length, 6, "the TIDY silhouette must remain explicitly six-petalled");
    for (const [index, petal] of petals.entries()) {
      assert.match(petal, new RegExp(`--petal-index:\\s*${index}(?:[;\"]|\\s)`));
      assert.match(petal, new RegExp(`transform="rotate\\(${index * 60} 12 12\\)"`),
        "static 60-degree placement and matching phase index give clockwise light flow");
    }
    const hands = flower.innerHTML.match(/<path\b[^>]*class="tidy-loading-flower__hands"[^>]*\/>/g);
    const hub = flower.innerHTML.match(/<circle\b[^>]*class="tidy-loading-flower__hub"[^>]*\/>/g);
    assert.equal(hands?.length, 1);
    assert.equal(hub?.length, 1);
    assert.doesNotMatch(hands[0] + hub[0], /--petal-index|transform=|animation/);
    assert.doesNotMatch(flower.innerHTML, /<(?:animate|animateTransform|set)\b/,
      "SVG cannot animate or rotate the silhouette independently of the opacity-only CSS");
    if (previousMarkup !== null) assert.equal(flower.innerHTML, previousMarkup, "both modes share one brand glyph");
    previousMarkup = flower.innerHTML;
  }
});

test("Chinese, English and Japanese status labels stay accessible while normal states are visually quiet", () => {
  const dictionaries = vm.createContext({});
  vm.runInContext(source("src/messages/i18n.js").replace(/^export /gm, "") + "\nthis.strings = STRINGS;", dictionaries);
  const expected = {
    "zh-CN": ["搜索中…", "刷新中…", "搜索完成", "搜索已暂停"],
    en: ["Searching…", "Refreshing…", "Search complete", "Search paused"],
    ja: ["検索中…", "更新中…", "検索完了", "検索を一時停止中"],
  };
  const { view, root } = loadView(async () => { assert.fail("status translation must not query data"); });
  for (const [language, labels] of Object.entries(expected)) {
    const dictionary = dictionaries.strings[language];
    assert.ok(dictionary, language);
    for (const mode of ["keyword", "date"]) {
      for (const [index, phase] of ["waiting", "searching", "refreshing", "complete", "paused"].entries()) {
        renderSearchPhase(view, mode, phase, { translator: key => dictionary[key] || key });
        const status = root.querySelector("[data-search-status]");
        const label = status.querySelector(".search-status__label");
        assert.equal(status.dataset.searchStatus, phase, `${language}/${mode}/${phase}`);
        assert.equal(status.role, "status");
        assert.equal(status.getAttribute("aria-live"), "polite");
        assert.equal(status.getAttribute("aria-atomic"), "true");
        assert.equal(label.textContent, index ? labels[index - 1] : "");
        assert.equal(label.matches(".search-status__label--sr-only"), phase !== "paused",
          "only a pause is visible text; search, refresh and completion still reach screen readers");
        assert.equal(Boolean(status.querySelector(".tidy-loading-flower")), phase === "searching" || phase === "refreshing");
        if (phase === "waiting" || phase === "complete") {
          assert.equal(status.children.filter(child => !child.matches(".search-status__label--sr-only")).length, 0,
            "idle and successful completion leave only the fixed slot, never a visible label or animation");
        }
      }
    }
  }
});

test("flower CSS uses fixed 18px geometry, opacity-only 1.5s light flow and a static reduced-motion fallback", () => {
  const css = readPanelCss();
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const result = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`).exec(css)?.[1];
    assert.ok(result, selector);
    return result;
  };
  const slot = rule(".search-status");
  assert.match(slot, /height:\s*24px\s*;/);
  assert.match(slot, /flex:\s*0 0 24px\s*;/);
  assert.match(slot, /font-size:\s*12px\s*;/);
  assert.match(slot, /line-height:\s*16px\s*;/);
  assert.match(slot, /align-items:\s*center\s*;/);
  assert.match(slot, /justify-content:\s*center\s*;/);
  const flower = rule(".tidy-loading-flower");
  assert.match(flower, /width:\s*18px\s*;/);
  assert.match(flower, /height:\s*18px\s*;/);
  assert.match(flower, /color:\s*var\(--accent\)\s*;/, "both themes reuse the TIDY accent");
  const petal = rule(".tidy-loading-flower__petal");
  assert.match(petal, /opacity:\s*\.35\s*;/, "unlit petals remain visible instead of vanishing like spinner dots");
  assert.match(petal, /animation:\s*tidy-petal-light 1\.5s ease-in-out infinite\s*;/);
  assert.match(petal, /animation-delay:\s*calc\(var\(--tidy-loading-phase, 0ms\) \+ var\(--petal-index\) \* 250ms - 1500ms\)/);
  const keyframes = /@keyframes tidy-petal-light\s*\{((?:\s*[^{}]+\{[^{}]+\})+)\s*\}/.exec(css)?.[1];
  assert.ok(keyframes);
  const declarations = [...keyframes.matchAll(/\{([^}]+)\}/g)].map(match => match[1].trim());
  assert.deepEqual(declarations, ["opacity: .9;", "opacity: .35;"], "no rotation, scaling, glow or movement is animated");
  for (const selector of [".tidy-loading-flower", ".tidy-loading-flower svg", ".tidy-loading-flower__hands", ".tidy-loading-flower__hub"]) {
    assert.doesNotMatch(rule(selector), /(?:animation|transition|transform|filter)\s*:/, selector);
  }
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.tidy-loading-flower__petal\s*\{\s*animation:\s*none;\s*opacity:\s*\.65;\s*\}\s*\}/);
  const hidden = rule(".search-status__label--sr-only");
  assert.match(hidden, /clip-path:\s*inset\(50%\)/);
  assert.doesNotMatch(hidden, /(?:display:\s*none|visibility:\s*hidden)/, "normal status text is hidden visually, not from accessibility APIs");
});

test("flower light phase survives list rerenders and restarts only after work stops", () => {
  for (const mode of ["keyword", "date"]) {
    let now = Date.parse("2026-09-08T02:00:00Z");
    const { view, root, context } = loadView(async () => { assert.fail("a status rerender must not query data"); }, null, () => {}, now);
    // This VM gets its own Date subclass so the clock cannot affect other tests.
    context.Date.now = () => now;
    const offset = () => root.querySelector(".tidy-loading-flower")?.style.getPropertyValue("--tidy-loading-phase");
    renderSearchPhase(view, mode, "searching");
    const firstFlower = root.querySelector(".tidy-loading-flower");
    assert.equal(offset(), "0ms");
    now += 625; view.render();
    assert.notEqual(root.querySelector(".tidy-loading-flower"), firstFlower, "the list render replaces DOM nodes");
    assert.equal(offset(), "-625ms", "the replacement resumes elapsed light phase instead of lighting petal zero again");
    now += 1385; renderSearchPhase(view, mode, "refreshing");
    assert.equal(offset(), "-2010ms", "continuous work keeps its phase even beyond one cycle or between working labels");
    for (const stopped of ["paused", "complete", "waiting"]) {
      renderSearchPhase(view, mode, stopped);
      assert.equal(offset(), undefined, `${stopped} removes the animated flower`);
      now += 250; renderSearchPhase(view, mode, "searching");
      assert.equal(offset(), "0ms", `${stopped} clears the preceding animation epoch`);
      now += 125; view.render();
      assert.equal(offset(), "-125ms");
    }
  }
});

test("keyword status keeps loading visual and completion accessible in the shared slot", async () => {
  const first = deferred(); const refreshed = deferred(); const calls = [];
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    return action === "query" ? (calls.filter((call) => call.action === "query").length === 1
      ? first.promise : refreshed.promise) : null;
  });
  const check = (phase, key, working) => {
    const status = root.querySelector("[data-search-status]");
    assert.equal(status.dataset.searchStatus, phase);
    assert.match(text(status), new RegExp(key));
    assert.equal(Boolean(status.querySelector(".tidy-loading-flower")), working);
    assert.match(text(status.querySelector(".search-status__label--sr-only")), new RegExp(key));
    assert.equal(root.querySelector(".search-list-heading").querySelector(".tidy-loading-flower"), null);
  };
  const searching = beginKeyword(view); await flush();
  check("searching", "searchDateSearching", true);
  assert.equal(root.querySelector("[data-search-refresh-keyword]").getAttribute("aria-busy"), "false",
    "automatic search animates the common flower, not the manual refresh control");
  first.resolve(page([hit("one", "m1")])); await searching;
  check("complete", "searchDateComplete", false);
  root.emit("click", root.querySelector("[data-search-refresh-keyword]")); await flush();
  check("refreshing", "searchDateRefreshing", true);
  assert.equal(root.querySelector("[data-search-refresh-keyword]").getAttribute("aria-busy"), "true");
  refreshed.resolve(page([hit("two", "m2")])); await view.keywordSearch.whenIdle();
  check("complete", "searchDateComplete", false);
  assert.equal(calls.filter((call) => call.action === "query").length, 2);
  assert.ok(calls.every((call) => call.action === "query"), "status rendering cannot activate the date catalog");
  view.setVisible(false);
});

test("paused keyword status is quiet and real failures keep a separate retry alert", async () => {
  const calls = []; let fail = true;
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    if (action !== "query") return null;
    if (!payload.cursor) return page([hit("one", "m1")], { cursor: "next", hasMore: true });
    if (fail) throw Object.assign(new Error("temporary read failure"), { code: "SEARCH_UNAVAILABLE" });
    return page([hit("two", "m2")]);
  });
  await beginKeyword(view); view.keywordSearch.pause();
  const paused = root.querySelector("[data-search-status]");
  assert.equal(paused.dataset.searchStatus, "paused");
  assert.match(text(paused), /searchDatePaused/);
  assert.equal(paused.querySelector(".tidy-loading-flower"), null);
  assert.equal(paused.querySelector(".search-status__label--sr-only"), null,
    "a pause is visible instead of silently resembling successful completion");
  assert.equal(root.querySelector(".search-keyword-error"), null, "a lifecycle pause is not an error");
  view.keywordSearch.resume(); await view.keywordSearch.whenIdle();
  const status = root.querySelector("[data-search-status]");
  const error = root.querySelector(".search-keyword-error");
  assert.equal(status.dataset.searchStatus, "paused");
  assert.equal(status.querySelector(".tidy-loading-flower"), null);
  assert.equal(error.role, "alert");
  assert.equal(error.dataset.searchErrorCode, "SEARCH_UNAVAILABLE");
  assert.equal(status.contains(error), false, "failure details do not replace the common status row");
  assert.equal(root.querySelector(".search-list-heading").contains(error), false);
  assert.match(text(error), /searchKeywordIncomplete/);
  assert.equal(view.state.pages.flat().length, 1, "known results stay available after a read failure");
  fail = false;
  root.emit("click", error.querySelector("[data-search-keyword-retry]"));
  await view.keywordSearch.whenIdle();
  assert.equal(root.querySelector(".search-keyword-error"), null);
  assert.equal(root.querySelector("[data-search-status]").dataset.searchStatus, "complete");
  assert.deepEqual(calls.filter((call) => call.action === "query").map((call) => call.payload.cursor), [null, "next", "next"]);
  view.setVisible(false);
});

test("date status, matching total and stable page count update without navigating past page one", async () => {
  let total = 7, phase = "loading", revision = 0;
  const pending = deferred(); let first = true;
  const { view, root } = loadView(async (action, payload) => {
    if (action !== "query") return null;
    if (first) { first = false; await pending.promise; }
    return page(dateRows(Math.min(total, payload.limit)), { total, hasMore: total > payload.limit,
      cursor: total > payload.limit ? "next" : null, coverageState: "partial", partialResults: true,
      catalogPhase: phase, catalogRevision: revision, resultStable: phase === "settled" });
  });
  view.state.mode = "date"; view.state.pageSize = view.state.datePageSize; view.render();
  assert.equal(root.querySelector("[data-search-status]").dataset.searchStatus, "waiting");
  assert.equal(root.querySelector(".tidy-loading-flower"), null);
  const initial = beginDate(view);
  assert.equal(root.querySelector("[data-search-status]").dataset.searchStatus, "searching");
  assert.equal(root.querySelector(".tidy-loading-flower").parentNode, root.querySelector("[data-search-status]"));
  pending.resolve(); await initial;
  for (total of [7, 12, 19, 23]) {
    revision += 1;
    view.setIndexStatus({ sessionId: view.state.sessionId, revision, phase, resultStable: false,
      coverageState: "partial", progress: { discovered: 649 } });
    await flush();
    assert.match(text(root.querySelector(".search-list-heading")), new RegExp(`"count":${total}`));
    assert.equal(view.state.page, 1); assert.equal(view.state.pages[0].length, 7);
    assert.equal(root.querySelector(".result-pagination__total").textContent, "/ …");
    assert.doesNotMatch(text(root), /649|searchDirectory/);
  }
  phase = "settled";
  view.setIndexStatus({ sessionId: view.state.sessionId, revision, phase, resultStable: true,
    coverageState: "partial", progress: { discovered: 649 } });
  await flush();
  assert.equal(root.querySelector("[data-search-status]").dataset.searchStatus, "complete");
  assert.equal(root.querySelector(".tidy-loading-flower"), null);
  assert.equal(root.querySelector(".result-pagination__total").textContent, "/ 4");
  assert.match(text(root.querySelector(".search-list-heading")), /"count":23/);
  view.setVisible(false);
});

test("manual refresh stays busy through paging and sorting, blocks duplicate clicks and completes with the same criteria", async () => {
  const calls = [], pending = deferred();
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "refresh-catalog") return pending.promise;
    return action === "query" ? page(dateRows(payload.limit), { total: 23, hasMore: true, cursor: "next" }) : null;
  });
  await beginDate(view); const sessionId = view.state.sessionId;
  const refresh = root.querySelector("[data-search-refresh-catalog]");
  assert.match(text(refresh), /searchDateRefresh/);
  root.emit("click", refresh); root.emit("click", refresh);
  assert.equal(calls.filter(c => c.action === "refresh-catalog").length, 1);
  assert.equal(root.querySelector("[data-search-refresh-catalog]").disabled, true);
  await view.loadNextPage(); await flush();
  root.emit("click", root.querySelector("[data-search-sort-direction]")); await flush();
  assert.equal(root.querySelector("[data-search-status]").dataset.searchStatus, "refreshing");
  assert.equal(root.querySelector(".tidy-loading-flower").parentNode, root.querySelector("[data-search-status]"));
  assert.equal(root.querySelector(".result-pagination__total").textContent, "/ …");
  pending.resolve(); await flush();
  assert.equal(view.state.sessionId, sessionId);
  assert.equal(root.querySelector("[data-search-status]").dataset.searchStatus, "complete");
  assert.equal(root.querySelector(".tidy-loading-flower"), null);
  assert.equal(root.querySelector("[data-search-refresh-catalog]").disabled, false);
  assert.equal(root.querySelector(".result-pagination__total").textContent, "/ 4");
  assert.equal(calls.filter(c => c.action === "expand").length, 0);
  view.setVisible(false);
});

test("cancelled initial date queries clear loading quietly and resume with a fresh local query", async () => {
  const pending = deferred(); const calls = [];
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    if (action !== "query") return null;
    return calls.filter((call) => call.action === "query").length === 1
      ? pending.promise : page(dateRows(1), { total: 1 });
  });
  const initial = beginDate(view); await flush();
  assert.equal(view.state.loading, true);
  view.setVisible(false);
  pending.reject(Object.assign(new Error("superseded date epoch"), { code: "CANCELLED" }));
  await initial; await flush();
  assert.equal(view.state.loading, false);
  assert.equal(view.state.error, false);
  assert.equal(view.state.pages.length, 0);
  assert.equal(root.querySelector(".search-date-error"), null);
  assert.equal(root.querySelector("[data-search-status]").dataset.searchStatus, "paused");
  assert.equal(root.querySelector(".tidy-loading-flower"), null);
  assert.equal(calls.filter((call) => call.action === "query").length, 1, "hidden cancellation cannot trigger another query");
  view.setVisible(true); await flush();
  assert.equal(calls.filter((call) => call.action === "query").length, 2);
  assert.equal(view.state.pages.flat().length, 1);
  assert.equal(root.querySelector("[data-search-status]").dataset.searchStatus, "complete");
  assert.equal(root.querySelector(".search-date-error"), null);
  view.setVisible(false);
});

test("cancelled cached date refreshes retain results and release the refresh lock for resume", async () => {
  const pending = deferred(); const calls = []; const known = dateRows(2);
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    if (action !== "query") return null;
    const number = calls.filter((call) => call.action === "query").length;
    if (number === 2) return pending.promise;
    return page(known, { total: 2, catalogPhase: number === 1 ? "loading" : "settled", resultStable: number !== 1 });
  });
  await beginDate(view);
  const before = plain(view.state.pages);
  root.emit("click", root.querySelector("[data-search-sort-direction]")); await flush();
  assert.equal(calls.filter((call) => call.action === "query").length, 2);
  view.setActive(false);
  pending.reject(Object.assign(new Error("superseded date epoch"), { code: "CANCELLED" }));
  await flush(); view.render();
  assert.deepEqual(plain(view.state.pages), before);
  assert.equal(view.state.error, false);
  assert.equal(view.state.loading, false);
  assert.equal(root.querySelector(".search-date-error"), null);
  assert.equal(root.querySelector("[data-search-status]").dataset.searchStatus, "paused");
  assert.equal(root.querySelector(".tidy-loading-flower"), null);
  assert.equal(calls.filter((call) => call.action === "query").length, 2, "inactive cancellation does not retry by itself");
  view.setActive(true); await flush();
  assert.equal(calls.filter((call) => call.action === "query").length, 3,
    "the cancelled local refresh cannot leave the internal refresh lock set");
  assert.deepEqual(plain(view.state.pages), before);
  assert.equal(root.querySelector("[data-search-status]").dataset.searchStatus, "complete");
  assert.equal(root.querySelector(".search-date-error"), null);
  view.setVisible(false);
});

test("cancelled manual date refreshes finish busy state without dropping results or reporting an error", async () => {
  const pending = deferred(); const calls = []; const known = dateRows(2);
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "refresh-catalog") return calls.filter((call) => call.action === "refresh-catalog").length === 1
      ? pending.promise : null;
    return action === "query" ? page(known, { total: 2 }) : null;
  });
  await beginDate(view); const before = plain(view.state.pages);
  root.emit("click", root.querySelector("[data-search-refresh-catalog]")); await flush();
  assert.equal(view.state.catalogRefreshing, true);
  assert.equal(root.querySelector("[data-search-status]").dataset.searchStatus, "refreshing");
  view.setVisible(false);
  pending.reject(Object.assign(new Error("superseded date epoch"), { code: "CANCELLED" }));
  await flush();
  assert.equal(view.state.catalogRefreshing, false);
  assert.equal(view.state.loading, false);
  assert.equal(view.state.error, false);
  assert.deepEqual(plain(view.state.pages), before);
  assert.equal(root.querySelector(".search-date-error"), null);
  assert.equal(root.querySelector(".tidy-loading-flower"), null);
  assert.equal(root.querySelector("[data-search-status]").dataset.searchStatus, "complete",
    "hiding does not downgrade an already completed snapshot");
  assert.equal(calls.filter((call) => call.action === "query").length, 1);
  view.setVisible(true); await flush();
  assert.equal(calls.filter((call) => call.action === "query").length, 2);
  assert.equal(root.querySelector("[data-search-refresh-catalog]").disabled, false);
  root.emit("click", root.querySelector("[data-search-refresh-catalog]")); await flush();
  assert.equal(calls.filter((call) => call.action === "refresh-catalog").length, 2);
  assert.equal(view.state.catalogRefreshing, false);
  assert.deepEqual(plain(view.state.pages), before);
  assert.equal(root.querySelector(".search-date-error"), null);
  view.setVisible(false);
});

test("settled status waits for the matching result revision before revealing the final page total", async () => {
  const pending = deferred(); let reads = 0;
  const { view, root } = loadView(async action => {
    if (action !== "query") return null;
    if (++reads === 1) return page(dateRows(7), { total: 14, hasMore: true, cursor: "next", catalogRevision: 0 });
    await pending.promise;
    return page(dateRows(7), { total: 64, hasMore: true, cursor: "next", catalogRevision: 1 });
  });
  await beginDate(view);
  view.setIndexStatus({ sessionId: view.state.sessionId, revision: 1, phase: "settled", resultStable: true });
  await flush();
  assert.equal(root.querySelector(".result-pagination__total").textContent, "/ …");
  pending.resolve(); await flush();
  assert.equal(root.querySelector(".result-pagination__total").textContent, "/ 10");
  assert.match(text(root.querySelector(".search-list-heading")), /"count":64/);
  view.setVisible(false);
});

test("real catalog service streams into the view and settles pagination without any message-history or next-page request", { timeout: 3000 }, async t => {
  const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");
  const nextStarted = deferred(), second = deferred();
  const nowMs = Date.parse("2026-09-08T00:30:00.000Z");
  let service, queries = 0;
  const { view, root, context } = loadView(async (action, payload) => {
    if (action === "query") {
      assert.ok(++queries < 40, "status refresh must not form a query loop");
      return service.queryDate(payload);
    }
    if (action === "pause") return service.pause();
    if (action === "refresh-catalog") return service.refreshCatalog();
    throw Error(`Unexpected view action: ${action}`);
  }, null, () => {}, nowMs);
  Object.assign(context, { indexedDB: new IDBFactory(), IDBKeyRange, structuredClone });
  for (const [file, names] of [
    ["src/platform/storage/schema.js", ["STORAGE_BOUNDARIES"]],
    ["src/platform/storage/database.js", ["openTidyDatabase", "storageError", "assertAccountKey"]],
    ["src/platform/catalog/storage/conversation-catalog.js", ["createConversationCatalogRepository"]],
    ["src/platform/catalog/ui/conversation-catalog-reader.js", ["createConversationCatalogReader"]],
    ["src/features/search/ui/conversation-date-search.js", ["createConversationDateSearch"]],
  ]) {
    const code = source(file).replace(/^import .*$/gm, "").replace(/^export \{.*\};?$/gm, "").replace(/^export /gm, "");
    vm.runInContext(`(() => { ${code}\n${names.map(name => `globalThis.${name} = ${name};`).join("\n")} })();`, context);
  }
  const db = await context.openTidyDatabase(); t.after(() => db.close());
  const repository = context.createConversationCatalogRepository({ openDatabase: async () => db });
  const requests = [];
  const time = Date.parse("2026-09-05T10:00:00Z");
  const values = Array.from({ length: 23 }, (_, i) => ({ conversationId: `integrated-${i}`, title: `Result ${i}`,
    updatedAt: time + i, directoryBounds: { createdAt: time + i, updatedAt: time + i, sources: ["ordinary"] } }));
  const sourcePage = (source, conversations = [], extra = {}) => ({ schemaVersion: "tidy.date-search.v1", source,
    conversations, projects: [], nextCursor: null, done: true, coverageReasons: [], ...extra });
  service = context.createConversationDateSearch({ repository, now: () => nowMs, canDispatch: () => view.state.active && view.state.visible,
    onStatus: status => view.setIndexStatus(status), requestAdapter: async (action, payload) => {
      requests.push(action);
      if (action === "account") return { schemaVersion: "tidy.date-search.v1", accountKey: "integration" };
      assert.equal(action, "source-page", "date UI cannot request message history");
      if (payload.source !== "ordinary") return sourcePage(payload.source);
      if (payload.cursor === null) return sourcePage("ordinary", values.slice(0, 7), { nextCursor: "next", done: false });
      nextStarted.resolve(); return second.promise;
    } });
  await beginDate(view); await nextStarted.promise;
  for (let i = 0; i < 4; i++) await flush();
  assert.equal(view.state.resultStatus.total, 7); assert.equal(view.state.page, 1);
  assert.equal(root.querySelector("[data-search-status]").dataset.searchStatus, "searching");
  second.resolve(sourcePage("ordinary", values.slice(7))); await service.whenIdle();
  for (let i = 0; i < 4; i++) await flush();
  assert.equal(view.state.resultStatus.total, 23); assert.equal(view.state.page, 1);
  assert.equal(view.state.resultStatus.coverageState, "partial");
  assert.equal(root.querySelector("[data-search-status]").dataset.searchStatus, "complete");
  assert.equal(root.querySelector(".result-pagination__total").textContent, "/ 4");
  assert.equal(requests.filter(action => action === "source-page").length, 5);
  view.setVisible(false); await service.whenIdle();
});


for (const changes of [["2026-09-05"], ["2026-09-05", "2026-09-04", "2026-09-05"]]) {
  test("real calendar condition handoff completes after a late successful page (changes=" + changes.length + ")", { timeout: 3000 }, async t => {
    const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");
    const nextStarted = deferred(), second = deferred();
    const nowMs = Date.parse("2026-09-08T00:30:00.000Z");
    const calls = [], statuses = [], requests = [];
    let service, nextCriteriaRead = null;
    const { view, root, context } = loadView(async (action, payload) => {
      calls.push({ action, payload });
      if (action === "query") {
        assert.ok(calls.filter(call => call.action === "query").length < 40,
          "catalog status refresh must not form a query loop");
        const readFinished = !payload.refresh ? nextCriteriaRead : null;
        const result = await service.queryDate(payload);
        readFinished?.resolve();
        return result;
      }
      if (action === "pause") return service.pause();
      throw Error("Unexpected view action: " + action);
    }, null, () => {}, nowMs);
    Object.assign(context, { indexedDB: new IDBFactory(), IDBKeyRange, structuredClone });
    for (const [file, names] of [
      ["src/platform/storage/schema.js", ["STORAGE_BOUNDARIES"]],
      ["src/platform/storage/database.js", ["openTidyDatabase", "storageError", "assertAccountKey"]],
      ["src/platform/catalog/storage/conversation-catalog.js", ["createConversationCatalogRepository"]],
      ["src/platform/catalog/ui/conversation-catalog-reader.js", ["createConversationCatalogReader"]],
      ["src/features/search/ui/conversation-date-search.js", ["createConversationDateSearch"]],
    ]) {
      const code = source(file).replace(/^import .*$/gm, "").replace(/^export \{.*\};?$/gm, "").replace(/^export /gm, "");
      vm.runInContext("(() => { " + code + "\n" + names.map(name => "globalThis." + name + " = " + name + ";").join("\n") + " })();", context);
    }
    const db = await context.openTidyDatabase();
    const repository = context.createConversationCatalogRepository({ openDatabase: async () => db });
    const time = Date.parse("2026-09-05T10:00:00Z"), oldTime = Date.parse("2026-09-04T10:00:00Z");
    const row = (id, at = time) => ({ conversationId: id, title: id, updatedAt: at,
      directoryBounds: { createdAt: at, updatedAt: at, sources: ["ordinary"] } });
    const values = Array.from({ length: 5 }, (_, index) => row("handoff-match-" + index));
    const sourcePage = (source, conversations = [], nextCursor = null) => ({ schemaVersion: "tidy.date-search.v1", source,
      conversations, projects: [], nextCursor, done: nextCursor === null, coverageReasons: [] });
    const latePage = sourcePage("ordinary", [row("old-range-only", oldTime)], "page3");
    service = context.createConversationDateSearch({ repository, now: () => nowMs,
      canDispatch: () => view.state.active && view.state.visible,
      onStatus: status => { statuses.push(plain(status)); view.setIndexStatus(status); },
      requestAdapter: async (action, payload) => {
        if (action === "account") return { schemaVersion: "tidy.date-search.v1", accountKey: "calendar-handoff" };
        assert.equal(action, "source-page", "changing a date range must not request message history");
        requests.push({ source: payload.source, cursor: payload.cursor });
        if (payload.source !== "ordinary") return sourcePage(payload.source);
        if (payload.cursor === null) return sourcePage("ordinary", values.slice(0, 4), "page2");
        if (payload.cursor === "page2") { nextStarted.resolve(); return second.promise; }
        assert.equal(payload.cursor, "page3");
        return sourcePage("ordinary", values.slice(4));
      } });
    t.after(async () => {
      second.resolve(latePage);
      view.setVisible(false);
      await service.pause();
      db.close();
    });
    view.setActive(true);
    Object.assign(view.state, { mode: "date", pageSize: view.state.datePageSize,
      startDate: "2026-09-04", endDate: "2026-09-05", timeZone: "UTC" });
    await view.loadFirstPage(); await nextStarted.promise;
    for (let i = 0; i < 4; i++) await flush();
    assert.equal(view.state.resultStatus.total, 4);
    const sessions = [view.state.sessionId];
    for (const date of changes) {
      // The real calendar owns criteria invalidation and the non-awaited pause;
      // no direct service pause/query or manual-refresh shortcut is used here.
      nextCriteriaRead = deferred();
      root.emit("click", findAll(root, "[data-search-date]").find(node => node.dataset.searchDate === "start"));
      const day = findAll(root, "[data-calendar-date]").find(node => node.dataset.calendarDate === date);
      assert.ok(day, "the new date is a visible day in the actual calendar");
      root.emit("click", day);
      await nextCriteriaRead.promise; await flush();
      nextCriteriaRead = null;
      assert.equal(view.state.startDate, date);
      assert.ok(view.state.sessionId && !sessions.includes(view.state.sessionId));
      sessions.push(view.state.sessionId);
      assert.equal(view.state.resultStatus.total, 4, "each replacement immediately reads the four cached matches");
    }
    const latestSession = sessions.at(-1), statusStart = statuses.length;
    second.resolve(latePage);
    await service.whenIdle();
    for (let i = 0; i < 8; i++) await flush();
    assert.equal(view.state.resultStatus.total, 5, "the newest date query must finish without a refresh-button click");
    assert.equal(view.state.resultStatus.resultStable, true);
    assert.equal(root.querySelector("[data-search-status]").dataset.searchStatus, "complete");
    assert.equal(view.state.sessionId, latestSession);
    assert.equal(view.state.indexStatus.sessionId, latestSession);
    assert.deepEqual(plain(view.state.pages.flat().map(item => item.conversationId).sort()),
      values.map(item => item.conversationId).sort(), "a late old-range result cannot replace the latest criteria");
    assert.equal(view.state.error, false);
    assert.ok(statuses.slice(statusStart).some(status => status.sessionId === latestSession && status.resultStable));
    assert.equal(calls.filter(call => call.action === "pause").length, changes.length);
    assert.equal(calls.filter(call => call.action === "query" && !call.payload.refresh).length, changes.length + 1);
    assert.ok(calls.every(call => call.action === "query" || call.action === "pause"), "the calendar never requests a manual catalog refresh");
    assert.deepEqual(requests.filter(request => request.source === "ordinary").map(request => request.cursor),
      [null, "page2", "page3"], "replacement runs continue the accepted checkpoint instead of restarting the directory");
  });
}

test("keyword refresh is a lightweight independent control and stays disabled without a query", () => {
  const calls = [];
  const { view, root } = loadView(async (action, payload) => { calls.push({ action, payload }); return null; });
  view.setActive(true);
  const keywordRefresh = root.querySelector("[data-search-refresh-keyword]");
  assert.ok(keywordRefresh);
  assert.equal(keywordRefresh.disabled, true);
  assert.equal(keywordRefresh.getAttribute("aria-busy"), "false");
  assert.match(text(keywordRefresh), /searchKeywordRefresh/);
  assert.match(keywordRefresh.getAttribute("aria-label"), /searchKeywordRefresh/);
  assert.equal(keywordRefresh.title, keywordRefresh.getAttribute("aria-label"));
  assert.equal(keywordRefresh.parentNode.matches(".search-list-heading"), true);
  assert.equal(findAll(root, "[data-search-refresh-catalog]").length, 0);
  assert.equal(findAll(root, "[data-search-sort-direction]").length, 0);
  root.emit("click", keywordRefresh);
  assert.equal(calls.length, 0);
  view.state.mode = "date"; view.state.pageSize = view.state.datePageSize; view.render();
  const dateRefresh = root.querySelector("[data-search-refresh-catalog]");
  assert.equal(keywordRefresh.className, dateRefresh.className, "both modes use the existing lightweight refresh style");
  assert.equal(findAll(root, "[data-search-refresh-keyword]").length, 0);
  view.setVisible(false);
});

test("keyword refresh starts one fresh native session and clears prior results, page and selection", async () => {
  const calls = []; const pending = deferred();
  const old = Array.from({ length: 12 }, (_, index) => hit(`old-${index}`, `m${index}`));
  let queries = 0;
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "query") return ++queries === 1 ? page(old) : pending.promise;
    return null;
  });
  await beginKeyword(view, "needle original");
  const previousSession = view.state.sessionId;
  await view.loadNextPage();
  assert.equal(view.state.page, 2);
  root.emit("click", root.querySelector("[data-search-match-id]"));
  assert.ok(view.state.activeResultId);
  const refresh = root.querySelector("[data-search-refresh-keyword]");
  assert.equal(refresh.disabled, false);
  root.emit("click", refresh);
  await flush();
  const request = calls.filter(call => call.action === "query").at(-1).payload;
  assert.deepEqual(Object.keys(request).sort(), ["mode", "query", "cursor", "sessionId", "limit"].sort());
  assert.equal(request.mode, "keyword");
  assert.equal(request.query, "needle original");
  assert.equal(request.cursor, null);
  assert.equal(request.limit, 30, "native batch size is independent of the visible page size");
  assert.notEqual(request.sessionId, previousSession);
  assert.equal(view.state.page, 1);
  assert.equal(view.state.pages.flat().length, 0, "a fresh run clears every previous result");
  assert.equal(view.state.activeResultId, null);
  assert.equal(view.state.loading, true);
  const busy = root.querySelector("[data-search-refresh-keyword]");
  assert.equal(busy.disabled, true);
  assert.equal(busy.getAttribute("aria-busy"), "true");
  // An already detached, enabled button must not bypass the state-level guard.
  root.emit("click", refresh); root.emit("click", busy); root.emit("click", refresh);
  assert.equal(queries, 2);
  pending.resolve(page([hit("fresh", "new-message")])); await flush();
  assert.deepEqual(plain(view.state.pages.flat().map(item => item.conversationId)), ["fresh"]);
  assert.equal(view.state.page, 1);
  assert.equal(root.querySelector("[data-search-refresh-keyword]").disabled, false);
  assert.equal(root.querySelector("[data-search-refresh-keyword]").getAttribute("aria-busy"), "false");
  assert.equal(findAll(root, "[data-search-match-id]").length, 1);
  assert.equal(findAll(root, "[data-search-expand]").length, 0, "native message previews do not require disclosure");
  assert.ok(calls.every(call => ["query", "open"].includes(call.action)), "no catalog refresh, authentication or hydration action is dispatched");
  view.setVisible(false);
});

test("keyword refresh cannot dispatch an empty query or an in-progress IME composition", async () => {
  const calls = [];
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    return action === "query" ? page([hit("one", "m1")]) : null;
  });
  await beginKeyword(view);
  const refresh = root.querySelector("[data-search-refresh-keyword]");
  const input = root.querySelector("[data-global-search]");
  input.value = "   "; root.emit("input", input);
  root.emit("click", refresh);
  assert.equal(calls.filter(call => call.action === "query").length, 1, "a stale enabled button cannot search whitespace");
  root.emit("compositionstart", input);
  input.value = "composing text"; root.emit("input", input);
  root.emit("click", refresh); await flush();
  assert.equal(calls.filter(call => call.action === "query").length, 1, "refresh must not submit unfinished IME text");
  assert.equal(calls.filter(call => call.action === "refresh-catalog" || call.action === "expand").length, 0);
  root.emit("compositionend", input);
  view.setVisible(false);
});

test("a failed keyword refresh remains retryable with a new native search session", async () => {
  const calls = []; let queries = 0;
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    if (action !== "query") return null;
    queries += 1;
    if (queries === 2) throw Object.assign(new Error("unavailable"), { code: "SEARCH_UNAVAILABLE" });
    return page([hit(queries === 1 ? "old" : "recovered", "m1")]);
  });
  await beginKeyword(view);
  root.emit("click", root.querySelector("[data-search-refresh-keyword]")); await flush();
  assert.equal(view.state.error.code, "SEARCH_UNAVAILABLE");
  assert.equal(view.state.loading, false);
  assert.equal(root.querySelector("[data-search-refresh-keyword]").disabled, false);
  assert.equal(root.querySelector("[data-search-refresh-keyword]").getAttribute("aria-busy"), "false");
  const failedSession = view.state.sessionId;
  root.emit("click", root.querySelector("[data-search-refresh-keyword]")); await flush();
  assert.equal(queries, 3);
  assert.notEqual(view.state.sessionId, failedSession);
  assert.equal(view.state.error, false);
  assert.deepEqual(plain(view.state.pages.flat().map(item => item.conversationId)), ["recovered"]);
  assert.ok(calls.every(call => call.action === "query"));
  assert.ok(calls.every(call => call.payload.cursor === null && call.payload.query === "needle"));
  view.setVisible(false);
});

test("changing keywords or switching to date rejects an older refresh response", async () => {
  for (const change of ["query", "date"]) {
    const calls = []; const pending = deferred(); let keywordQueries = 0;
    const { view, root } = loadView(async (action, payload) => {
      calls.push({ action, payload });
      if (action !== "query") return null;
      if (payload.mode === "date") return page(dateRows(1, "current-date"));
      return ++keywordQueries === 2 ? pending.promise : page([hit(payload.query, "m1")]);
    });
    await beginKeyword(view, "old keyword");
    root.emit("click", root.querySelector("[data-search-refresh-keyword]"));
    await flush();
    const refreshSession = view.state.sessionId;
    assert.equal(view.state.loading, true);
    if (change === "query") {
      const input = root.querySelector("[data-global-search]");
      input.value = "new keyword"; root.emit("input", input);
      await view.loadFirstPage();
    } else {
      root.emit("click", findAll(root, "[data-search-mode]")[1]);
      await beginDate(view);
    }
    const activeSession = view.state.sessionId;
    assert.notEqual(activeSession, refreshSession);
    const before = plain(view.state.pages);
    pending.resolve(page([hit("late-refresh", "late-message", { snippet: "stale-refresh-body" })]));
    await flush();
    assert.equal(view.state.sessionId, activeSession, change);
    assert.deepEqual(plain(view.state.pages), before, "late refresh cannot replace current criteria results");
    assert.equal(view.state.loading, false);
    assert.equal(view.state.error, false);
    assert.doesNotMatch(text(root), /stale-refresh-body|late-refresh/);
    assert.equal(calls.filter(call => call.action === "refresh-catalog" || call.action === "expand").length, 0);
    if (change === "date") {
      assert.equal(view.state.mode, "date");
      assert.equal(findAll(root, "[data-search-refresh-keyword]").length, 0);
      assert.equal(findAll(root, "[data-search-match-id]").length, 0);
    }
    view.setVisible(false);
  }
});

test("native keyword pages load automatically with distinct message results in official order", async () => {
  const calls = [];
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    if (action !== "query") return null;
    return payload.cursor ? page([hit("A", "a3"), hit("C", "c1")])
      : page([hit("A", "a1"), hit("B", "b1"), hit("A", "a2")], { cursor: "native-next", hasMore: true });
  });
  await beginKeyword(view);
  assert.deepEqual(plain(view.state.pages.flat().map(item => item.messageId)), ["a1", "b1", "a2"]);
  await view.keywordSearch.whenIdle();
  assert.equal(calls.filter((call) => call.action === "query").length, 2);
  assert.equal(calls.filter((call) => call.action === "expand").length, 0);
  assert.deepEqual(plain(view.state.pages.flat().map((item) => item.conversationId)), ["A", "B", "A", "A", "C"]);
  assert.deepEqual(plain(view.state.pages.flat().map((item) => item.messageId)), ["a1", "b1", "a2", "a3", "c1"]);
  assert.equal(view.state.keywordStatus.complete, true);
  assert.equal(view.state.page, 1, "background pages must not navigate the visible page");
  assert.equal(findAll(root, "[data-search-sort-direction]").length, 0);
  assert.equal(findAll(root, "[data-search-match-count-state]").length, 0);
  assert.deepEqual(calls.map(call => call.action), ["query", "query"]);
  view.setVisible(false);
});

test("keyword results always show a conversation title and native preview for each returned message", async () => {
  const calls = [];
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    return action === "query" ? page([hit("one", "m1"), hit("one", "m2")]) : null;
  });
  await beginKeyword(view);
  assert.deepEqual(findAll(root, "[data-search-keyword-title]").map(node => text(node).trim()), ["Conversation one", "Conversation one"]);
  assert.deepEqual(findAll(root, "[data-search-match-id]").map(node => node.dataset.searchMatchId), ["keyword:one:m1", "keyword:one:m2"]);
  assert.match(text(root), /m1/);
  assert.match(text(root), /m2/);
  assert.equal(findAll(root, "[data-search-expand]").length, 0);
  assert.equal(findAll(root, "[data-search-match-count-state]").length, 0);
  assert.equal(findAll(root, "[data-search-expand-retry]").length, 0);
  assert.equal(findAll(root, ".search-result__expansion-status").length, 0);
  await flush();
  assert.deepEqual(calls.map(call => call.action), ["query"], "message display must not hydrate conversation history");
  view.setVisible(false);
});

test("native previews remain visible without inventing a message timestamp from the conversation update time", async () => {
  const calls = [];
  const native = hit("one", "m1", { snippet: "native-body-sentinel" });
  const other = hit("two", "m2", { snippet: "other-body-sentinel" });
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    return action === "query" ? page([native, other]) : null;
  });
  view.render({ formatTimestamp: () => { throw new Error("conversation updated time is not a message timestamp"); } });
  await beginKeyword(view);
  const rows = findAll(root, "[data-search-match-id]");
  assert.equal(rows.length, 2);
  assert.match(text(rows[0]), /native-body-sentinel/);
  assert.match(text(rows[1]), /other-body-sentinel/);
  assert.doesNotMatch(text(root), /2026-09-05|visible-message-time/);
  assert.equal(view.state.activeResultId, null);
  assert.deepEqual(calls.map(call => call.action), ["query"]);
  view.setVisible(false);
});

test("each native message row highlights query terms and opens its exact message with the original query", async () => {
  const calls = [];
  const values = [
    hit("one", "m1", { projectId: "project-one", snippet: "prefix NEEDLE original suffix" }),
    hit("one", "m2", { snippet: "another needle original result", messageTimestamp: "2026-09-05T01:00:00.000Z" }),
  ];
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    return action === "query" ? page(values) : null;
  });
  await beginKeyword(view, "needle original");
  const rows = () => findAll(root, "[data-search-match-id]");
  assert.equal(rows().length, 2);
  // The highlighted fragments are child nodes, so their clicks must bubble to
  // the same whole-message action rather than to the conversation header.
  const firstSnippet = rows()[0].children.at(-1);
  assert.deepEqual(firstSnippet.children.map(child => child.textContent), ["prefix ", "NEEDLE", " ", "original", " suffix"]);
  root.emit("click", firstSnippet.children[1]);
  assert.equal(calls.at(-1).action, "open");
  assert.equal(calls.at(-1).payload.messageId, "m1");
  assert.equal(calls.at(-1).payload.query, "needle original");
  assert.equal(calls.at(-1).payload.projectId, "project-one");
  root.emit("click", rows()[1].children[0]);
  assert.equal(calls.at(-1).payload.messageId, "m2", "preview clicks target their own message");
  assert.equal(calls.at(-1).payload.conversationId, "one");
  assert.equal(calls.at(-1).payload.query, "needle original");
  root.emit("click", rows()[0]);
  assert.deepEqual(calls.filter(call => call.action === "open").map(call => call.payload.messageId), ["m1", "m2", "m1"]);
  assert.deepEqual(calls.map(call => call.action), ["query", "open", "cancel-navigation", "open", "cancel-navigation", "open"]);
  view.setVisible(false);
});

test("leaving search cancels its exact pending OPEN before any acknowledgement and ignores stale cancel IDs", async () => {
  const calls = [];
  let resolveOpen;
  const pendingOpen = new Promise(resolve => { resolveOpen = resolve; });
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    if (action === "query") return page([hit("one", "m1")]);
    if (action === "open") return pendingOpen;
    return null;
  });
  await beginKeyword(view, "needle");
  view.setActive(true);
  root.emit("click", findAll(root, "[data-search-match-id]")[0]);
  const opened = calls.find(call => call.action === "open");
  assert.ok(opened.payload.navigationIntentId);
  view.cancelId("unrelated-intent");
  view.setActive(false);
  const cancelled = calls.filter(call => call.action === "cancel-navigation");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].payload.navigationIntentId, opened.payload.navigationIntentId);
  assert.equal(cancelled[0].payload.reason, "route-away");
  resolveOpen({ navigationIntentId: opened.payload.navigationIntentId });
  await flush();
  view.setVisible(false);
  assert.equal(calls.filter(call => call.action === "cancel-navigation").length, 1, "a late OPEN receipt cannot reinstall the cancelled handle");
});

test("a final search receipt is consumed once without losing the completed highlight cancellation handle", async () => {
  const calls = [];
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    return action === 'query' ? page([hit('one', 'm1')]) : null;
  });
  await beginKeyword(view, 'needle'); view.setActive(true);
  root.emit('click', findAll(root, '[data-search-match-id]')[0]);
  const id = calls.find(call => call.action === 'open').payload.navigationIntentId;
  assert.equal(view.completeNavigation({ navigationIntentId: 'wrong', conversationId: 'one', messageId: 'm1', located: true }), false);
  assert.equal(view.completeNavigation({ navigationIntentId: id, conversationId: 'one', messageId: 'm1', located: true }), true);
  assert.equal(view.completeNavigation({ navigationIntentId: id, conversationId: 'one', messageId: 'm1', located: true }), false);
  view.setActive(false);
  assert.equal(calls.filter(call => call.action === 'cancel-navigation').length, 1);
  assert.equal(calls.find(call => call.action === 'cancel-navigation').payload.navigationIntentId, id);
});

test("late English and Chinese keywords render local context without changing native previews or jump targets", async () => {
  const chinese = "\u5173\u952e\u5e27";
  for (const { query, term, original } of [
    { query: "codex", term: "CODEX", original: "An unrelated opening. ".repeat(30)
      + "The relevant CODEX explanation follows. " + "Unrelated trailing text. ".repeat(30) },
    { query: chinese, term: chinese, original: "\u8fd9\u662f\u65e0\u5173\u7684\u5f00\u573a\u3002".repeat(50)
      + "\u9700\u8981\u8c03\u6574" + chinese + "\u7684\u65f6\u95f4\u3002"
      + "\u540e\u7eed\u8bf4\u660e\u3002".repeat(50) },
  ]) {
    const calls = [];
    const native = hit("one", "m1", { projectId: "project-one", snippet: original });
    const { view, root } = loadView(async (action, payload) => {
      calls.push({ action, payload });
      return action === "query" ? page([native]) : null;
    });
    await beginKeyword(view, query);
    const message = root.querySelector("[data-search-match-id]");
    const snippet = message.children[0];
    const visible = snippet.children.map(child => child.textContent).join("") || snippet.textContent;
    assert.ok(visible.startsWith("\u2026"));
    assert.ok(visible.endsWith("\u2026"));
    assert.ok(visible.indexOf(term) <= 29);
    assert.ok(visible.length <= 182);
    const highlighted = snippet.children.find(child => child.textContent === term);
    assert.ok(highlighted, "the late term is still a dedicated highlighted fragment");
    assert.equal(view.state.pages[0][0].snippet, original, "the canonical native DTO is not shortened");
    assert.equal(view.state.keywordStatus.items[0].snippet, original);
    assert.equal(native.snippet, original);
    root.emit("click", highlighted);
    assert.equal(calls.at(-1).action, "open");
    assert.equal(calls.at(-1).payload.conversationId, "one");
    assert.equal(calls.at(-1).payload.messageId, "m1");
    assert.equal(calls.at(-1).payload.projectId, "project-one");
    assert.equal(calls.at(-1).payload.query, query);
    view.render();
    await flush();
    assert.deepEqual(calls.map(call => call.action), ["query", "open"],
      "excerpt rendering must not request conversation history or repeat the native search");
    view.setVisible(false);
  }
});

test("native previews without a literal match and title-only results retain their original fallback", async () => {
  const calls = [];
  const original = "Unmatched native preview. ".repeat(30);
  const titleOnly = hit("two", null, { title: "Needle title-only result", snippet: "", matchKind: "title" });
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    return action === "query" ? page([hit("one", "m1", { snippet: original }), titleOnly]) : null;
  });
  await beginKeyword(view, "needle");
  const unmatched = root.querySelector("[data-search-match-id]").children[0];
  assert.equal(unmatched.children.map(child => child.textContent).join("") || unmatched.textContent, original);
  const fallback = root.querySelector("[data-search-result-id]");
  assert.ok(fallback, "a native title-only match still opens the conversation");
  assert.equal(fallback.children[0].children.map(child => child.textContent).join(""), titleOnly.title);
  root.emit("click", fallback);
  assert.equal(calls.at(-1).payload.conversationId, "two");
  assert.equal(calls.at(-1).payload.messageId, null);
  assert.equal(calls.at(-1).payload.query, "needle");
  assert.deepEqual(calls.map(call => call.action), ["query", "open"]);
  view.setVisible(false);
});

test("later native pages merge duplicate messages without replacing canonical selection, focus or preview", async () => {
  const first = hit("one", "m1", { resultId: "native:first:m1", snippet: "needle original preview" });
  const duplicate = hit("one", "m1", { resultId: "native:later:m1", snippet: "needle later duplicate" });
  const second = hit("one", "m2", { resultId: "native:later:m2" });
  const calls = []; const pending = deferred();
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    return action === "query" ? payload.cursor
      ? pending.promise
      : page([first], { cursor: "next", hasMore: true }) : null;
  });
  await beginKeyword(view);
  const findMessage = () => findAll(root, "[data-search-match-id]").find(node => node.dataset.searchMatchId === "keyword:one:m1");
  const before = findMessage();
  before.focus(); root.emit("click", before);
  assert.equal(root.ownerDocument.activeElement, findMessage());
  pending.resolve(page([duplicate, second, second]));
  await view.keywordSearch.whenIdle();
  const after = findMessage();
  assert.notEqual(after, before);
  assert.equal(root.ownerDocument.activeElement, after, "the same message retains keyboard focus after pagination repaint");
  assert.equal(view.state.activeResultId, "keyword:one:m1");
  assert.equal(after.closest("[data-search-keyword-result]").matches(".is-active"), true);
  assert.equal(findAll(root, "[data-search-keyword-title]").length, 2);
  assert.deepEqual(findAll(root, "[data-search-match-id]").map(node => node.dataset.searchMatchId), ["keyword:one:m1", "keyword:one:m2"]);
  assert.match(text(after), /needle\s+original preview/);
  assert.doesNotMatch(text(after), /later duplicate/);
  root.emit("click", after);
  assert.equal(calls.at(-1).payload.messageId, "m1");
  assert.equal(calls.at(-1).payload.query, "needle");
  assert.ok(calls.every(call => ["query", "open", "cancel-navigation"].includes(call.action)));
  assert.equal(calls.filter(call => call.action === "query").length, 2);
  view.setVisible(false);
});

test("background keyword pages update cumulative results without moving the current page", async () => {
  const pending = deferred(); const calls = [];
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    return action === "query" ? payload.cursor ? pending.promise
      : page(Array.from({ length: 12 }, (_, index) => hit("one", `m${index}`)), { cursor: "next", hasMore: true }) : null;
  });
  await beginKeyword(view);
  await view.loadNextPage();
  assert.equal(view.state.page, 2);
  const before = root.querySelector("[data-search-result-list]");
  before.scrollTop = 37; root.emit("scroll", before);
  const focusedMessage = root.querySelector("[data-search-match-id]");
  focusedMessage.focus();
  pending.resolve(page([hit("one", "m12", { snippet: "late-body-sentinel" })]));
  await view.keywordSearch.whenIdle();
  assert.equal(view.state.page, 2);
  assert.equal(root.querySelector("[data-search-result-list]").scrollTop, 37);
  assert.equal(root.ownerDocument.activeElement.dataset.searchMatchId, focusedMessage.dataset.searchMatchId);
  assert.equal(view.state.pages.flat().length, 13);
  assert.equal(findAll(root, "[data-search-match-id]").length, 3);
  assert.match(text(root), /late-body-sentinel/);
  assert.deepEqual(calls.map(call => call.action), ["query", "query"]);
  view.setVisible(false);
});

test("the entire keyword card opens the same native message from title, preview or blank space", async () => {
  const calls = [];
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    return action === "query" ? page([hit("one", "m1", { projectId: "project-one", title: "Needle title" })]) : null;
  });
  await beginKeyword(view, "needle");
  const card = root.querySelector("[data-search-keyword-result]");
  const title = root.querySelector("[data-search-keyword-title]");
  const message = root.querySelector("[data-search-match-id]");
  const snippet = message.children[0];
  const mark = snippet.children.find(child => child.textContent === "needle");
  assert.ok(mark, "the preview contains a nested highlighted term");
  assert.match(title.getAttribute("aria-label"), /^jumpMessage:/);
  const targets = [title, title.children[0], message, snippet, mark, card];
  for (const target of targets) {
    const before = calls.filter(call => call.action === "open").length;
    root.emit("click", target);
    const opens = calls.filter(call => call.action === "open");
    assert.equal(opens.length, before + 1, "one click dispatches exactly one navigation");
    assert.equal(opens.at(-1).payload.navigationKind, "keyword");
    assert.equal(opens.at(-1).payload.conversationId, "one");
    assert.equal(opens.at(-1).payload.messageId, "m1");
    assert.equal(opens.at(-1).payload.query, "needle");
    assert.equal(opens.at(-1).payload.projectId, "project-one");
    assert.equal(view.state.activeResultId, "keyword:one:m1");
    assert.equal(root.querySelector("[data-search-keyword-result]"), card, "selection keeps the card mounted");
    assert.equal(card.matches(".is-active"), true);
  }
  assert.equal(calls.filter(call => call.action === "query").length, 1);
  view.setVisible(false);
});

test("a title-only keyword card retains the official null message target in every click area", async () => {
  const calls = [];
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    return action === "query" ? page([hit("one", null, { title: "Needle title", snippet: "", matchKind: "title" })]) : null;
  });
  await beginKeyword(view, "needle");
  for (const selector of ["[data-search-keyword-result]", "[data-search-keyword-title]", "[data-search-result-id]"]) {
    const before = calls.filter(call => call.action === "open").length;
    root.emit("click", root.querySelector(selector));
    const opens = calls.filter(call => call.action === "open");
    assert.equal(opens.length, before + 1);
    assert.equal(opens.at(-1).payload.navigationKind, "keyword", "a title match is not a date-result conversation navigation");
    assert.equal(opens.at(-1).payload.conversationId, "one");
    assert.equal(opens.at(-1).payload.messageId, null, "never fabricate a message id for a native title match");
    assert.equal(opens.at(-1).payload.query, "needle");
  }
  view.setVisible(false);
});

test("the entire date card always opens the conversation latest message without a keyword", async () => {
  const calls = [], items = dateRows(1);
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload }); return action === "query" ? page(items) : null;
  });
  view.state.query = "retained keyword";
  await beginDate(view);
  const card = root.querySelector("[data-search-conversation-card]");
  for (const target of [card, root.querySelector("[data-search-result-id]"), root.querySelector(".search-result__source"),
    root.querySelector(".search-result__conversation-summary")]) {
    const before = calls.filter(call => call.action === "open").length;
    root.emit("click", target);
    const opens = calls.filter(call => call.action === "open");
    assert.equal(opens.length, before + 1);
    assert.equal(opens.at(-1).payload.navigationKind, "conversation");
    assert.equal(opens.at(-1).payload.conversationId, items[0].conversationId);
    assert.equal(opens.at(-1).payload.messageId, null);
    assert.equal(opens.at(-1).payload.query, "");
    assert.equal(root.querySelector("[data-search-conversation-card]"), card);
  }
  view.setVisible(false);
});

test("hiding and returning to a completed keyword search never restarts native or hydration reads", async () => {
  const calls = [];
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    return action === "query" ? page([hit("one", "m1")]) : null;
  });
  await beginKeyword(view);
  view.setVisible(false); view.setVisible(true);
  view.setActive(false); view.setActive(true);
  await flush();
  assert.equal(calls.filter(call => call.action === "query").length, 1);
  assert.ok(calls.every(call => ["query", "pause"].includes(call.action)), "only the catalog lifecycle pause is allowed");
  assert.equal(findAll(root, "[data-search-expand-retry]").length, 0);
  view.setVisible(false);
});

test("hiding an unfinished keyword search pauses the next batch and returning resumes the same session", async () => {
  const calls = [];
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    if (action !== "query") return null;
    return payload.cursor ? page([hit("one", "m2")])
      : page([hit("one", "m1")], { cursor: "resume-next", hasMore: true });
  });
  await beginKeyword(view);
  const sessionId = view.state.sessionId;
  view.setVisible(false);
  await view.keywordSearch.whenIdle();
  assert.equal(calls.filter(call => call.action === "query").length, 1);
  assert.equal(view.state.keywordStatus.complete, false);
  assert.equal(root.querySelector(".result-pagination__total").textContent, "/ …");
  view.setVisible(true);
  await view.keywordSearch.whenIdle();
  const queries = calls.filter(call => call.action === "query");
  assert.equal(queries.length, 2);
  assert.equal(queries[1].payload.cursor, "resume-next");
  assert.ok(queries.every(call => call.payload.sessionId === sessionId));
  assert.deepEqual(plain(view.state.pages.flat().map(item => item.messageId)), ["m1", "m2"]);
  assert.equal(view.state.keywordStatus.complete, true);
  assert.ok(calls.every(call => ["query", "pause"].includes(call.action)), "keyword resume must not activate the date catalog");
  view.setVisible(false);
});

test("mode changes discard in-flight date DTOs instead of rendering them as keyword hits", async () => {
  const pending = deferred();
  const { view, root } = loadView(async (action, payload) => action === "query"
    ? payload.mode === "date" ? pending.promise : page([hit("one", "m1")]) : null);
  view.state.query = "needle"; const oldQuery = beginDate(view);
  root.emit("click", findAll(root, "[data-search-mode]")[0]); await view.loadFirstPage();
  pending.resolve(page(dateRows(2))); await oldQuery;
  assert.equal(view.state.mode, "keyword");
  assert.deepEqual(plain(view.state.pages.flat().map((item) => item.conversationId)), ["one"]);
  assert.equal(findAll(root, "[data-search-conversation-time]").length, 0); view.setVisible(false);
});

test("date calendar is retained and technical directory details are not user-facing", async () => {
  const { view, root } = loadView(async (action) => action === "query" ? page(dateRows(1)) : null);
  await beginDate(view); root.emit("click", root.querySelector("[data-search-date]"));
  assert.equal(findAll(root, "[data-calendar-date]").length, 42); root.emit("click", root.querySelector("[data-calendar-close]"));
  const sessionId = view.state.sessionId;
  for (const [revision, phase] of ["loading", "paused", "settled"].entries()) {
    view.setIndexStatus({ sessionId, revision, phase, coverageState: "partial", progress: { pages: 4, discovered: 72, failed: 1 } }); await flush();
    const notice = root.querySelector(".search-status");
    assert.match(text(notice), /searchDate/);
    assert.doesNotMatch(text(root), /searchDirectory|discovered|72|Scanning|MatchedMessage|CandidateCount|conversationRequests/);
  }
  view.setVisible(false);
});

test("all translations contain split-mode copy and retire combined/message-date UI keys", () => {
  const context = vm.createContext({});
  vm.runInContext(source("src/messages/i18n.js").replace(/^export /gm, "") + "\nthis.strings = STRINGS;", context);
  for (const dictionary of Object.values(context.strings)) {
    for (const key of ["searchKeywordMode", "searchDateMode", "createdTime", "updatedTime", "created", "updated",
      "searchDateSearching", "searchDateComplete", "searchDateRefreshing", "searchDateRefresh",
      "searchDatePaused", "searchDateReadFailed", "searchDateSortField", "sortAscending", "sortDescending",
      "searchKeywordResultCount", "searchLoading",
      "searchKeywordIncomplete", "searchKeywordRetry", "searchTotalPagesUnknown"]) {
      assert.equal(typeof dictionary[key], "string", key);
    }
    for (const retired of ["searchConversationCreated", "searchConversationUpdated", "searchConversationCreatedLabel", "searchConversationUpdatedLabel", "titlesRecent",
      "searchDirectoryLoading", "searchDirectoryPartial", "searchDirectoryFailures", "searchDirectoryNoCachedResults",
      "searchCombinedHelper", "searchDateScanning", "searchDateMatchCount", "searchDateCandidateCount", "searchMatchedMessageTime",
      "searchKeywordUnverified", "searchKeywordLoading", "searchKeywordReadFailed", "searchKeywordPartial", "searchKeywordNoMatches",
      "searchKeywordKnownMatches", "searchKeywordKnownMatchesHint", "searchKeywordConversationMatch", "searchKeywordAutoPageSize"]) {
      assert.equal(Object.hasOwn(dictionary, retired), false, retired);
    }
  }
});

test("keyword page-size selectors reuse the shared compact pagination width", () => {
  const css = readPanelCss();
  const sharedRule = css.match(/(?:^|\n)\.result-page-size select\s*\{([^}]+)\}/)?.[1];
  assert.ok(sharedRule, "the common page-size selector remains available to all modules");
  assert.match(sharedRule, /(?:^|;)\s*width:\s*42px\s*;/);
  assert.doesNotMatch(css,
    /\.search-panel--keyword[^{}]*\.result-page-size[^{}]*select[^{}]*\{[^}]*\bwidth\s*:/,
    "keyword mode must not override the shared selector width");
});

test("date pagination retains its four explicit sizes and default of seven", async () => {
  for (const mode of ["date"]) {
    const calls = [];
    const { view, root } = loadView(async (action, payload) => {
      calls.push({ action, payload });
      return action === "query" ? page(mode === "date" ? dateRows(1) : [hit("one", "m1")]) : null;
    });
    await (mode === "date" ? beginDate(view) : beginKeyword(view));
    assert.equal(view.state.pageSize, 7);
    const size = root.querySelector("[data-search-page-size]");
    assert.deepEqual(size.children.map((option) => option.value), ["7", "15", "30", "60"]);
    assert.deepEqual(size.children.filter((option) => option.selected).map((option) => option.value), ["7"]);
    assert.equal(calls.find((call) => call.action === "query").payload.limit, 7);
    size.value = "60"; root.emit("change", size); await flush();
    assert.equal(view.state.pageSize, 60);
    assert.equal(calls.filter((call) => call.action === "query").at(-1).payload.limit, 60);
    size.value = "8"; root.emit("change", size); await flush();
    assert.equal(view.state.pageSize, 60, "unsupported sizes cannot reenter through the change handler");
    view.setVisible(false);
  }
});

test("keyword page sizes default to adaptive and reflow cached results without another search", async () => {
  const calls = [];
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    return action === "query" ? page(Array.from({ length: 35 }, (_, index) => hit("one", `m${index}`))) : null;
  });
  await beginKeyword(view);
  assert.equal(view.state.keywordPageSize, "auto");
  assert.equal(view.state.pageSize, 10, "headless views use a stable adaptive fallback");
  let size = root.querySelector("[data-search-page-size]");
  assert.deepEqual(size.children.map(option => option.value), ["auto", "15", "20", "30", "60"]);
  assert.equal(size.children.find(option => option.selected).value, "auto");
  assert.deepEqual(size.children.map(option => option.textContent), ["10", "15", "20", "30", "60"]);
  assert.equal(calls.find(call => call.action === "query").payload.limit, 30);
  assert.equal(root.querySelector(".result-pagination__total").textContent, "/ 4");
  await view.loadNextPage();
  size.value = "20"; root.emit("change", size); await flush();
  assert.equal(view.state.keywordPageSize, 20);
  assert.equal(view.state.pageSize, 20);
  assert.deepEqual(plain(view.state.pages.map(items => items.length)), [20, 15]);
  assert.equal(root.querySelector(".result-pagination__total").textContent, "/ 2");
  assert.equal(calls.filter(call => call.action === "query").length, 1);
  size = root.querySelector("[data-search-page-size]");
  size.value = "8"; root.emit("change", size); await flush();
  assert.equal(view.state.pageSize, 20, "unsupported sizes cannot enter through the UI");
  view.state.keywordAutoSize = 25; view.render();
  size = root.querySelector("[data-search-page-size]");
  assert.equal(view.state.pageSize, 20, "layout changes cannot replace a manual choice");
  assert.deepEqual(size.children.map(option => option.value), ["auto", "20", "30", "60"], "retain the chosen tier even below the adaptive recommendation");
  size.value = "auto"; root.emit("change", size); await flush();
  assert.equal(view.state.pageSize, 25);
  assert.equal(calls.filter(call => call.action === "query").length, 1);
  view.setVisible(false);
});

test("keyword adaptive capacity follows measured space, preserves the reading anchor and respects a manual tier", async () => {
  const calls = [];
  const { view, root, resize } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    return action === "query" ? page(Array.from({ length: 35 }, (_, index) => hit("one", `m${index}`))) : null;
  }, { listHeight: 940, rowHeight: 92 });
  await beginKeyword(view); await flush();
  assert.equal(view.state.pageSize, 10);
  await view.loadNextPage();
  const list = root.querySelector("[data-search-result-list]");
  list.scrollTop = 96; root.emit("scroll", list);
  const anchor = () => (view.state.page - 1) * view.state.pageSize
    + Math.floor(root.querySelector("[data-search-result-list]").scrollTop / 94);
  assert.equal(anchor(), 11);
  resize(1126); await flush();
  assert.equal(view.state.keywordAutoSize, 12);
  assert.equal(view.state.pageSize, 12);
  assert.equal(anchor(), 11, "the same first visible message survives an adaptive repagination");
  assert.equal(root.querySelector("[data-search-result-list]").scrollTop % 94, 2);
  let size = root.querySelector("[data-search-page-size]");
  assert.deepEqual(size.children.map(option => option.value), ["auto", "15", "20", "30", "60"]);
  size.value = "20"; root.emit("change", size); await flush();
  assert.equal(anchor(), 11);
  resize(470); await flush();
  assert.equal(view.state.keywordAutoSize, 5);
  assert.equal(view.state.pageSize, 20, "window resizing must not replace an explicit user choice");
  size = root.querySelector("[data-search-page-size]");
  assert.deepEqual(size.children.map(option => option.value), ["auto", "10", "15", "20", "30", "60"]);
  assert.deepEqual(size.children.map(option => option.textContent), ["5", "10", "15", "20", "30", "60"]);
  size.value = "auto"; root.emit("change", size); await flush();
  assert.equal(view.state.pageSize, 5);
  assert.equal(anchor(), 11);
  assert.equal(root.querySelector(".result-pagination__total").textContent, "/ 7");
  resize(562); await flush();
  assert.equal(view.state.keywordAutoSize, 6);
  assert.equal(view.state.pageSize, 6, "the compact selector must not force a fixed seven-result page");
  assert.equal(anchor(), 11);
  size = root.querySelector("[data-search-page-size]");
  assert.equal(size.children.find(option => option.selected).value, "auto");
  assert.equal(size.children.find(option => option.selected).textContent, "6", "automatic capacity stays numeric-only");
  assert.equal(root.querySelector(".result-pagination__total").textContent, "/ 6");
  assert.equal(calls.filter(call => call.action === "query").length, 1, "resizing uses only cached official results");
  view.setVisible(false);
});

test("failed background keyword batches keep known results and retry the same cursor without resetting the view", async () => {
  const calls = []; let continuationAttempts = 0;
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    if (action !== "query") return null;
    if (!payload.cursor) return page(Array.from({ length: 12 }, (_, index) => hit("one", `m${index}`)),
      { cursor: "resume-here", hasMore: true });
    if (++continuationAttempts === 1) throw Object.assign(new Error("temporarily unavailable"), { code: "SEARCH_UNAVAILABLE" });
    return page([hit("one", "m12"), hit("one", "m13")]);
  });
  await beginKeyword(view);
  await view.loadNextPage();
  await view.keywordSearch.whenIdle();
  const session = view.state.sessionId;
  assert.equal(view.state.page, 2);
  assert.equal(view.state.pages.flat().length, 12);
  assert.equal(root.querySelector(".result-pagination__total").textContent, "/ …");
  assert.match(text(root.querySelector("[data-search-result-count]")), /"count":12/);
  const retry = root.querySelector("[data-search-keyword-retry]");
  assert.ok(retry, "a failed continuation needs a retry distinct from restarting search");
  root.emit("click", retry); await flush(); await view.keywordSearch.whenIdle();
  assert.equal(view.state.sessionId, session);
  assert.equal(view.state.page, 2);
  assert.equal(view.state.pages.flat().length, 14);
  assert.equal(view.state.error, false);
  assert.equal(view.state.keywordStatus.complete, true);
  assert.equal(root.querySelector(".result-pagination__total").textContent, "/ 2");
  assert.equal(root.querySelector("[data-search-keyword-retry]"), null);
  assert.deepEqual(calls.filter(call => call.action === "query").map(call => call.payload.cursor), [null, "resume-here", "resume-here"]);
  view.setVisible(false);
});

test("editing or composing a new keyword keeps the live input attached while discarding an older native request", async () => {
  for (const event of ["input", "compositionstart"]) {
    const continuationStarted = deferred(); const pending = deferred();
    const { view, root } = loadView(async (action, payload) => {
      if (action !== "query") return null;
      if (!payload.cursor) return page([hit("old", "m1")], { cursor: "old-next", hasMore: true });
      continuationStarted.resolve();
      return pending.promise;
    });
    await beginKeyword(view, "old keyword");
    await continuationStarted.promise;
    const input = root.querySelector("[data-global-search]");
    input.focus(); input.value = "new unfinished keyword";
    root.emit(event, input);
    assert.equal(root.querySelector("[data-global-search]"), input, `${event} must not replace an input during typing`);
    assert.equal(root.ownerDocument.activeElement, input);
    pending.resolve(page([hit("stale", "m2")])); await flush();
    assert.equal(root.querySelector("[data-global-search]"), input);
    assert.equal(input.value, "new unfinished keyword");
    assert.equal(view.state.pages.flat().length, 0);
    assert.equal(view.state.loading, false);
    view.setVisible(false);
  }
});

test("an overlong keyword cannot leave the view permanently loading or dispatch an invalid native request", async () => {
  const calls = [];
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    return action === "query" ? page([hit("one", "m1")]) : null;
  });
  assert.equal(root.querySelector("[data-global-search]").maxLength, 500);
  await beginKeyword(view, "x".repeat(501));
  assert.equal(view.state.loading, false);
  assert.ok(view.state.error?.code, "programmatic input still needs a recoverable validation error");
  assert.equal(calls.filter(call => call.action === "query").length, 0);
  await beginKeyword(view, "needle");
  assert.equal(view.state.error, false);
  assert.equal(view.state.keywordStatus.complete, true);
  assert.equal(calls.filter(call => call.action === "query").length, 1);
  view.setVisible(false);
});

test("partial date pagination keeps current page and an unknown total while directory totals grow", async () => {
  let total = 14;
  const { view, root } = loadView(async (action, payload) => action === "query"
    ? page(dateRows(payload.limit), { total, cursor: `more:${total}`, hasMore: true, coverageState: "partial",
      partialResults: true, catalogPhase: "loading", resultStable: false }) : null);
  await beginDate(view);
  const assertCurrent = (current) => {
    const rail = root.querySelector(".result-pagination__rail");
    assert.equal(rail.children.length, 3, "only previous, position and next are rendered");
    assert.deepEqual(findAll(rail, "[data-search-page-direction]").map((node) => node.dataset.searchPageDirection), ["previous", "next"]);
    assert.equal(root.querySelector(".result-pagination__input").value, String(current));
    assert.equal(root.querySelector(".result-pagination__total").textContent, "/ …");
  };
  assertCurrent(1);
  total = 647;
  view.setIndexStatus({ sessionId: view.state.sessionId, revision: 1, phase: "loading", coverageState: "partial", progress: { discovered: total } });
  await flush(); assertCurrent(1);
  await view.loadNextPage(); await flush(); assertCurrent(2);
  assert.equal(findAll(root, "[data-search-page-direction]")[0].disabled, false);
  view.setIndexStatus({ sessionId: view.state.sessionId, revision: 1, phase: "settled", coverageState: "partial", progress: { discovered: total } });
  await flush(); assertCurrent(2);
  view.setVisible(false);
});

test("final date page count uses all matching conversations even when account coverage remains partial", async () => {
  const { view, root } = loadView(async (action, payload) => action === "query"
    ? page(dateRows(payload.limit), { total: 64, cursor: "next", hasMore: true, coverageState: "partial", partialResults: true }) : null);
  await beginDate(view);
  assert.equal(view.state.pages.length, 1);
  assert.equal(root.querySelector(".result-pagination__input").value, "1");
  assert.equal(root.querySelector(".result-pagination__total").textContent, "/ 10");
  await view.loadNextPage(); await flush();
  assert.equal(root.querySelector(".result-pagination__input").value, "2");
  assert.equal(root.querySelector(".result-pagination__total").textContent, "/ 10");
  view.setVisible(false);
});

test("keyword count grows across native batches and reveals the final message page total only at completion", async () => {
  const queries = []; const pending = deferred();
  const initial = Array.from({ length: 7 }, (_, index) => hit(`c${index}`, `m${index}`));
  const { view, root } = loadView(async (action, payload) => {
    if (action !== "query") return null;
    queries.push(payload);
    return queries.length === 1
      ? page(initial, { cursor: "native-next", hasMore: true }) : pending.promise;
  });
  assert.equal(root.querySelector(".result-pagination__input").value, "1");
  assert.equal(root.querySelector(".result-pagination__total").textContent, "/ …", "unsearched is not a complete one-page result");
  await beginKeyword(view);
  assert.equal(root.querySelector(".result-pagination__input").value, "1");
  assert.equal(root.querySelector(".result-pagination__total").textContent, "/ …");
  assert.equal(view.state.pages.flat().length, 7);
  assert.match(root.querySelector(".tidy-loading-flower").innerHTML, /<svg\b/, "loading indicator has a visible glyph");
  assert.equal(root.querySelector(".tidy-loading-flower").parentNode, root.querySelector("[data-search-status]"));
  assert.equal(root.querySelector(".search-list-heading").querySelector(".tidy-loading-flower"), null);
  assert.equal(root.querySelector(".result-pagination__total").textContent, "/ …", "in-flight native page has no final total");
  pending.resolve(page(initial.map((item, index) => hit(item.conversationId, `extra${index}`))));
  await view.keywordSearch.whenIdle();
  assert.equal(queries.length, 2);
  assert.equal(view.state.pages.flat().length, 14, "distinct messages from the same conversation count separately");
  assert.equal(root.querySelector(".tidy-loading-flower"), null);
  assert.equal(view.state.pages.length, 2);
  assert.equal(root.querySelector(".result-pagination__input").value, "1");
  assert.equal(root.querySelector(".result-pagination__total").textContent, "/ 2");
  assert.equal(findAll(root, "[data-search-page-direction]").find((node) => node.dataset.searchPageDirection === "next").disabled, false);
  await view.loadNextPage();
  assert.equal(view.state.page, 2);
  assert.equal(queries.length, 2, "display pagination never fetches an official page");
  view.setVisible(false);
});

test("native keyword pagination keeps an unknown total for partial results, dangling cursors and failures", async () => {
  for (const response of [
    page([hit("one", "m1")], { partialResults: true }),
    page([hit("one", "m1")], { coverageState: "partial" }),
    page([hit("one", "m1")], { readErrors: [{ category: "HTTP", status: 429 }] }),
    page([hit("one", "m1")], { cursor: "unexpected", hasMore: false }),
    null,
  ]) {
    const { view, root } = loadView(async (action) => {
      if (action !== "query") return null;
      if (!response) throw Object.assign(new Error("unavailable"), { code: "SEARCH_UNAVAILABLE" });
      return response;
    });
    await beginKeyword(view);
    assert.equal(root.querySelector(".result-pagination__input").value, "1");
    assert.equal(root.querySelector(".result-pagination__total").textContent, "/ …", JSON.stringify(response));
    view.setVisible(false);
  }
});

test("date totals remain provisional during active, paused, failed or revision-mismatched states", async () => {
  const cases = [
    { phase: "loading", coverageState: "complete", progress: {} },
    { phase: "paused", coverageState: "complete", progress: {} },
    { phase: "settled", coverageState: "partial", resultStable: true, revision: 1, progress: {} },
    { phase: "settled", coverageState: "complete", progress: { failed: 1 } },
    { phase: "settled", coverageState: "complete", progress: {}, readErrors: [{ category: "HTTP", status: 429 }] },
  ];
  for (const status of cases) {
    const { view, root } = loadView(async (action) => action === "query"
      ? page(dateRows(7), { total: 64, cursor: "next", hasMore: true, coverageState: "complete" }) : null);
    await beginDate(view);
    view.setIndexStatus({ sessionId: view.state.sessionId, revision: 0, ...status }); await flush();
    assert.equal(root.querySelector(".result-pagination__input").value, "1", JSON.stringify(status));
    assert.equal(root.querySelector(".result-pagination__total").textContent, "/ …");
    view.setVisible(false);
  }
  const { view, root } = loadView(async (action) => action === "query" ? page(dateRows(1), { coverageState: "complete" }) : null);
  await beginDate(view);
  assert.equal(root.querySelector(".result-pagination__input").value, "1");
  assert.equal(root.querySelector(".result-pagination__total").textContent, "/ …", "missing exact total is not inferred from the one fetched page");
  view.setVisible(false);
});

test("the status slot stays quiet and fixed-height; real failures are separate from hidden coverage", async () => {
  const { view, root } = loadView(async (action) => action === "query"
    ? page(dateRows(1), { coverageState: "partial", partialResults: true }) : null);
  await beginDate(view);
  for (const phase of ["loading", "paused", "settled"]) {
    view.setIndexStatus({ sessionId: view.state.sessionId, revision: 0, phase, coverageState: "partial", progress: { discovered: 647, failed: 0 } });
    await flush();
    const notice = root.querySelector(".search-status");
    assert.equal(notice.role, "status");
    assert.equal(notice.dataset.searchStatus, { loading: "searching", paused: "paused", settled: "complete" }[phase]);
    assert.equal(Boolean(notice.querySelector(".tidy-loading-flower")), phase === "loading");
    assert.equal(notice.matches(".is-error"), false, phase);
    assert.doesNotMatch(text(root), /647|searchDirectory|discovered/);
    assert.equal(findAll(root, ".search-date-error").length, 0);
  }
  view.setIndexStatus({ sessionId: view.state.sessionId, revision: 0, phase: "settled", coverageState: "partial",
    progress: { discovered: 647, failed: 1 }, readErrors: [{ category: "HTTP", status: 429, retryable: true }],
    failureNotice: { id: 1, error: { code: "HTTP", status: 429, retryable: true } } });
  await flush();
  const failed = root.querySelector(".search-date-error");
  assert.equal(failed.role, "alert");
  assert.match(text(failed), /titlesRateLimited/);
  assert.deepEqual(JSON.parse(failed.dataset.searchReadErrors), [{ category: "HTTP", status: 429, retryable: true }]);
  const css = readPanelCss();
  const statusRule = /\.search-status\s*\{([^}]+)\}/.exec(css)?.[1];
  assert.match(statusRule, /height:\s*24px/);
  assert.match(statusRule, /flex:\s*0 0 24px/);
  assert.match(statusRule, /justify-content:\s*center/);
  assert.doesNotMatch(statusRule, /danger|#b14a55|177,\s*74,\s*85/);
  const context = vm.createContext({});
  vm.runInContext(source("src/messages/i18n.js").replace(/^export /gm, "") + "\nthis.strings = STRINGS;", context);
  assert.ok(Object.values(context.strings).some((dictionary) => dictionary.searchDateComplete === "搜索完成"));
  view.setVisible(false);
});

test("date card uses timezone calendar dates, not message precision, and refresh command reads only the catalog", async () => {
  const calls = [];
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    return action === "query" ? page([{ ...dateRows(1)[0], conversationCreatedAt: "2026-09-04T18:00:00.000Z" }]) : null;
  });
  view.render({ timeZone: "Asia/Singapore", formatTimestamp: () => { throw new Error("message formatter must not format directory dates"); } });
  await beginDate(view);
  const metadata = root.querySelector(".search-result__conversation-summary");
  assert.equal(metadata.querySelector("[data-search-conversation-time]").children[0].textContent, "created:{}");
  assert.match(text(metadata), /2026-09-05/);
  assert.doesNotMatch(text(metadata), /2026-09-04|T18:00|T02:00/);
  const refresh = root.querySelector("[data-search-refresh-catalog]");
  assert.match(refresh.title, /searchDateRefresh/);
  assert.equal(refresh.disabled, false);
  root.emit("click", refresh);
  await flush();
  assert.equal(calls.filter((call) => call.action === "refresh-catalog").length, 1);
  assert.equal(calls.filter((call) => call.action === "query").length, 2);
  assert.equal(calls.filter((call) => call.action === "query").at(-1).payload.refresh, true,
    "refresh completion rereads only the local result snapshot");
  assert.equal(calls.filter((call) => call.action === "expand").length, 0);
  view.setVisible(false);
});

test("title-only native results stay visible and never expose a nonexistent message target", async () => {
  const calls = [];
  const { view, root } = loadView(async (action, payload) => {
    calls.push({ action, payload });
    return action === "query" ? page([hit("title-only", null, { matchKind: "title", snippet: "needle title preview" })]) : null;
  });
  await beginKeyword(view);
  assert.match(text(root), /Conversation title-only/);
  assert.equal(view.state.pages.flat().length, 1);
  assert.equal(findAll(root, "[data-search-match-id]").length, 0);
  assert.equal(findAll(root, "[data-search-expand]").length, 0);
  assert.deepEqual(calls.map(call => call.action), ["query"], "title-only results must not fetch a message locator");
  root.emit("click", root.querySelector("[data-search-result-id]"));
  assert.equal(calls.at(-1).action, "open");
  assert.equal(calls.at(-1).payload.conversationId, "title-only");
  assert.equal(calls.at(-1).payload.messageId, null);
  assert.deepEqual(calls.map(call => call.action), ["query", "open"]);
  view.setVisible(false);
});

test("a repeated native cursor stops background pagination and retains known message results", async () => {
  let queries = 0;
  const { view, root } = loadView(async (action) => {
    if (action !== "query") return null;
    queries += 1;
    return page([hit("one", "m1")], { cursor: "repeated", hasMore: true });
  });
  await beginKeyword(view);
  await view.keywordSearch.whenIdle();
  assert.equal(view.state.keywordStatus.complete, false);
  assert.equal(root.querySelector("[data-search-error-code]").dataset.searchErrorCode, "SEARCH_CURSOR_LOOP");
  assert.equal(findAll(root, "[data-search-match-id]").length, 1);
  assert.equal(root.querySelector(".result-pagination__total").textContent, "/ …");
  await view.loadNextPage();
  assert.equal(queries, 2);
  view.setVisible(false);
});

// Document replacement revokes pending reads, not the user's search criteria.
test("document handoff during the first date read cannot leave loading stuck", async () => {
  const old = deferred(); let queries = 0;
  const { view } = loadView(async action => {
    if (action !== "query") return null;
    queries += 1; return queries === 1 ? old.promise : page(dateRows(2));
  });
  const started = beginDate(view);
  await flush();
  view.setActive(false, { preserveNavigation: true, invalidateReads: true });
  assert.equal(view.state.loading, false, "the replaced document no longer owns the loading flag");
  view.setActive(true);
  await flush();
  assert.equal(queries, 2, "new document can read without waiting for the old bridge");
  old.reject(Object.assign(new Error("old bridge closed"), { code: "ADAPTER_UNAVAILABLE" }));
  await started; await flush();
  assert.equal(view.state.error, false);
  assert.equal(view.state.pages[0].length, 2);
});

test("document handoff revokes the old keyword page without cancelling the clicked result", async () => {
  const old = deferred(), queries = [], actions = [];
  const { view, root } = loadView(async (action, payload) => {
    actions.push({ action, payload });
    if (action !== "query") return null;
    queries.push(payload);
    if (queries.length === 1) return page([hit("one", "m1")], { cursor: "next", hasMore: true });
    return queries.length === 2 ? old.promise : page([hit("two", "m2")]);
  });
  await beginKeyword(view);
  for (let attempts = 0; queries.length < 2 && attempts < 20; attempts++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(queries.length, 2);
  root.emit("click", root.querySelector("[data-search-match-id]"));
  await flush();
  const clicked = actions.find(call => call.action === "open").payload.navigationIntentId;
  view.setActive(false, { preserveNavigation: true, invalidateReads: true });
  old.reject(Object.assign(new Error("source document closed"), { code: "ADAPTER_UNAVAILABLE" }));
  await flush();
  assert.equal(view.state.keywordStatus.error, false);
  assert.equal(actions.some(call => call.action === "cancel-navigation" && call.payload.navigationIntentId === clicked), false);
  view.setActive(true);
  await view.keywordSearch.whenIdle(); await flush();
  assert.equal(view.state.keywordStatus.complete, true);
  assert.equal(view.state.keywordStatus.total, 2);
  assert.deepEqual(queries.map(query => query.cursor), [null, "next", "next"]);
  view.keywordSearch.reset();
});

test("a replaced document cannot hold the date cache refresh lock or release its successor", async () => {
  const old = deferred(), next = deferred(); let queries = 0;
  const { view } = loadView(async action => {
    if (action !== "query") return null;
    queries += 1;
    return queries === 1 ? page(dateRows(1)) : queries === 2 ? old.promise : next.promise;
  });
  await beginDate(view); await flush();
  view.setIndexStatus({ phase: "loading", revision: 1 }); await flush();
  assert.equal(queries, 2);
  view.setActive(false, { preserveNavigation: true, invalidateReads: true });
  view.setActive(true); await flush();
  assert.equal(queries, 3, "new document need not wait for the previous bridge timeout");
  old.reject(Object.assign(new Error("old bridge closed"), { code: "ADAPTER_UNAVAILABLE" }));
  await flush();
  view.setIndexStatus({ phase: "loading", revision: 2 }); await flush();
  assert.equal(queries, 3, "old finally cannot release the new document's active read");
  next.resolve(page(dateRows(2))); await flush();
  assert.equal(view.state.error, false);
  assert.equal(view.state.pages[0].length, 2);
});

test("a manual catalog refresh from the previous document cannot restore a red notice", async () => {
  const old = deferred();
  const { view, root } = loadView(async action => {
    if (action === "query") return page(dateRows(2));
    if (action === "refresh-catalog") return old.promise;
    return null;
  });
  await beginDate(view); await flush();
  root.emit("click", root.querySelector("[data-search-refresh-catalog]"));
  await flush(); assert.equal(view.state.catalogRefreshing, true);
  view.setActive(false, { preserveNavigation: true, invalidateReads: true });
  assert.equal(view.state.catalogRefreshing, false);
  view.setActive(true); await flush();
  old.reject(Object.assign(new Error("old manual refresh closed"), { code: "ADAPTER_UNAVAILABLE" }));
  await flush(); assert.equal(view.state.error, false);
});

// Date errors preserve their diagnosis but never add a second catalog refresh action.
for (const scenario of [
  { label: "non-retryable schema mismatch", error: { code: "CATALOG_SCHEMA_CHANGED", retryable: false }, key: "searchDateReadFailed" },
  { label: "invalidated page receiver", error: { code: "ADAPTER_UNAVAILABLE", details: { stage: "page-session", disconnect: "context-invalidated" } }, key: "refreshChatgptPage" },
  { label: "unknown read failure", error: { code: "SEARCH_UNAVAILABLE" }, key: "searchDateReadFailed" },
  { label: "service unavailable", error: { code: "SEARCH_UNAVAILABLE", details: { status: 503 } }, key: "searchDateReadFailed" },
  { label: "rate limit", error: { code: "SEARCH_UNAVAILABLE", details: { status: 429 } }, key: "titlesRateLimited" },
  { label: "explicitly non-retryable rate limit", error: { code: "SEARCH_UNAVAILABLE", status: 429, retryable: false }, key: "titlesRateLimited" },
]) test("date query preserves diagnosis for " + scenario.label, async () => {
  const { view, root } = loadView(async (action) => {
    if (action === "query") throw Object.assign(new Error("private backend detail"), scenario.error);
    return null;
  });
  await beginDate(view);
  const notice = root.querySelector(".search-date-error");
  assert.ok(notice);
  assert.match(text(notice), new RegExp(scenario.key));
  assert.equal(notice.querySelector("[data-search-refresh-catalog]"), null);
  assert.equal(Object.hasOwn(view.state.error, "message"), false, "exception text does not become a retained UI DTO");
  assert.doesNotMatch(text(root), /private backend detail/);
  view.setVisible(false);
});

test("cached catalog diagnosis stays quiet and a new failure event offers no useless reread", async () => {
  const diagnostic = { code: "CATALOG_SCHEMA_CHANGED", stage: "catalog", disconnect: null, status: null, retryable: false };
  const { view, root } = loadView(async action => action === "query" ? page(dateRows(1), { readErrors: [diagnostic], catalogPhase: "paused", resultStable: false }) : null);
  await beginDate(view);
  assert.equal(root.querySelector(".search-date-error"), null, "cached diagnostics are not a fresh failure event");
  assert.equal(root.querySelector("[data-search-status]").dataset.searchStatus, "paused");
  view.setIndexStatus({ sessionId: view.state.sessionId, revision: 0, phase: "paused", readErrors: [diagnostic],
    failureNotice: { id: 1, error: diagnostic } });
  await flush();
  const notice = root.querySelector(".search-date-error");
  assert.ok(notice);
  assert.match(text(notice), /searchDateReadFailed/);
  assert.equal(notice.querySelector("[data-search-refresh-catalog]"), null);
  assert.deepEqual(JSON.parse(notice.dataset.searchReadErrors), [diagnostic]);
  view.setVisible(false);
});

test("cached date query failures preserve a non-retryable diagnosis and already visible rows", async () => {
  let queries = 0;
  const known = dateRows(1);
  const { view, root } = loadView(async action => {
    if (action !== "query") return null;
    if (++queries > 1) throw { code: "CATALOG_SCHEMA_CHANGED", retryable: false };
    return page(known);
  });
  await beginDate(view);
  root.emit("click", root.querySelector("[data-search-sort-direction]")); await flush();
  assert.equal(view.state.error.retryable, false);
  assert.deepEqual(plain(view.state.pages.flat()), known);
  assert.equal(root.querySelector(".search-date-error").querySelector("[data-search-refresh-catalog]"), null);
  view.setVisible(false);
});

test("manual catalog refresh retains normalized diagnosis before the following local query", async () => {
  let view, seen;
  const fixture = loadView(async (action, payload) => {
    if (action === "refresh-catalog") throw { code: "ADAPTER_UNAVAILABLE", details: { stage: "page-session", disconnect: "context-invalidated", retryable: false } };
    if (action === "query") {
      if (payload.refresh) seen = plain(view.state.error);
      return page(dateRows(1));
    }
    return null;
  });
  view = fixture.view;
  await beginDate(view);
  fixture.root.emit("click", fixture.root.querySelector("[data-search-refresh-catalog]")); await flush();
  assert.equal(seen.code, "ADAPTER_UNAVAILABLE");
  assert.equal(seen.stage, "page-session");
  assert.equal(seen.disconnect, "context-invalidated");
  assert.equal(seen.retryable, false);
  view.setVisible(false);
});

// This UI policy applies to every language and every kind of date read error.
for (const language of ["zh-CN", "zh-TW", "en", "ja"]) {
  for (const diagnostic of [
    { code: "HTTP", status: 429, retryable: true },
    { code: "HTTP", status: 503, retryable: true },
    { code: "SEARCH_UNAVAILABLE", status: null, retryable: null },
  ]) test(language + " date read notice has no action for " + (diagnostic.status || "unknown"), async () => {
    const calls = [], known = dateRows(2), pending = deferred();
    const { view, root, context } = loadView(async (action, payload) => {
      calls.push({ action, payload });
      if (action === "refresh-catalog") return pending.promise;
      return action === "query" ? page(known, { readErrors: [diagnostic], catalogPhase: "paused", resultStable: false }) : null;
    });
    vm.runInContext(source("src/messages/i18n.js").replace(/^export /gm, ""), context);
    await beginDate(view); await flush();
    const translator = context.createTranslator(language);
    assert.equal(root.querySelector(".search-date-error"), null, "cached readErrors alone never reannounce");
    view.setIndexStatus({ sessionId: view.state.sessionId, revision: 0, phase: "paused", readErrors: [diagnostic],
      failureNotice: { id: 1, error: diagnostic } });
    await flush();
    view.render({ translator });
    const notice = root.querySelector(".search-date-error");
    assert.equal(notice.role, "alert");
    assert.equal(notice.querySelector("[data-search-refresh-catalog]"), null);
    assert.equal(descendants(notice).some(node => node.type === "button"), false, "no renamed replacement action");
    assert.deepEqual(JSON.parse(notice.dataset.searchReadErrors), [diagnostic]);
    assert.match(text(notice), new RegExp(translator(diagnostic.status === 429 ? "titlesRateLimited" : "searchDateReadFailed")));
    assert.deepEqual(plain(view.state.pages.flat()), known);
    const controls = root.querySelectorAll("[data-search-refresh-catalog]");
    assert.equal(controls.length, 1, "only the normal toolbar refresh remains");
    assert.equal(controls[0].matches(".search-directory-refresh"), true);
    assert.equal(controls[0].getAttribute("aria-label"), translator("searchDateRefresh"));
    const before = calls.length;
    root.emit("click", notice); root.emit("click", notice.children[0]); await flush();
    assert.equal(calls.length, before, "the error text and background do not issue requests");
    root.emit("click", root.querySelector("[data-search-result-id]")); await flush();
    assert.equal(calls.at(-1).action, "open", "cached results stay navigable");
    root.emit("click", controls[0]); root.emit("click", controls[0]); await flush();
    assert.equal(calls.filter(call => call.action === "refresh-catalog").length, 1);
    assert.equal(root.querySelector("[data-search-refresh-catalog]").disabled, true);
    pending.resolve(); await flush();
    assert.deepEqual(plain(view.state.pages.flat()), known);
    view.setVisible(false);
  });
}

// Search notice lifetime is deterministic: no test waits five real seconds.
function noticeClock() {
  let now = 0, nextId = 0;
  const pending = new Map(), history = [];
  return {
    setTimeout(callback, delay = 0) {
      const task = { id: ++nextId, callback, due: now + delay, delay };
      pending.set(task.id, task); history.push(task); return task.id;
    },
    clearTimeout(id) { pending.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const task = [...pending.values()].filter(task => task.due <= end).sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (!task) break;
        pending.delete(task.id); now = task.due; task.callback();
      }
      now = end;
    },
    notices: () => history.filter(task => task.delay === 5000),
  };
}

function loadNoticeView(onAction, extra = {}) {
  const clock = noticeClock(), interactions = [];
  const fixture = loadView(onAction, null, () => {}, null, source("src/features/search/ui/search-view.js"), {
    clock, onInteraction: () => interactions.push("interaction"), ...extra,
  });
  return { ...fixture, clock, interactions };
}

const noticeDiagnostic = { code: "SEARCH_UNAVAILABLE", status: 503, retryable: true };
function catalogFailure(view, id = 1, error = noticeDiagnostic) {
  view.setIndexStatus({ sessionId: view.state.sessionId, accountKey: "workspace-a", revision: 0, phase: "paused",
    readErrors: [error], failureNotice: { id, error } });
}

for (const mode of ["date", "keyword"]) test("transient " + mode + " direct-query failure ends after five seconds", async () => {
  const { view, root, clock } = loadNoticeView(async action => { if (action === "query") throw noticeDiagnostic; return null; });
  await (mode === "date" ? beginDate(view) : beginKeyword(view));
  const selector = ".search-" + mode + "-error";
  assert.equal(Boolean(root.querySelector(selector)), true);
  clock.advance(4999); assert.equal(Boolean(root.querySelector(selector)), true);
  clock.advance(1); assert.equal(Boolean(root.querySelector(selector)), false);
  assert.equal(view.state.error.code, "SEARCH_UNAVAILABLE", "notice expiry never rewrites the actual outcome");
});

test("date notice expires at 5000ms without rebuilding rows, scrolling or stealing focus", async () => {
  const known = dateRows(2);
  const { view, root, context, clock } = loadNoticeView(async action => action === "query" ? page(known) : null);
  await beginDate(view); catalogFailure(view); await flush();
  const list = root.querySelector("[data-search-result-list]"), row = root.querySelector("[data-search-result-id]");
  list.scrollTop = 91; root.emit("scroll", list); row.focus();
  assert.ok(root.querySelector(".search-date-error"));
  assert.equal(descendants(root).filter(node => node.role === "alert" && !node.hidden).length, 1,
    "the result count does not repeat the visible failure alert");
  assert.ok(root.querySelector(".search-status__label--sr-only"), "do not repeat the pause beside the failure");
  clock.advance(4999); assert.ok(root.querySelector(".search-date-error"));
  clock.advance(1);
  assert.equal(root.querySelector(".search-date-error"), null);
  assert.equal(root.querySelector("[data-search-result-list]"), list);
  assert.equal(root.querySelector("[data-search-result-id]"), row);
  assert.equal(context.document.activeElement, row);
  assert.equal(list.scrollTop, 91);
  assert.deepEqual(plain(view.state.pages.flat()), known);
  assert.deepEqual(plain(view.state.indexStatus.readErrors), [noticeDiagnostic]);
  assert.equal(root.querySelector(".search-status__label--sr-only"), null);
  assert.equal(root.querySelector("[data-search-status]").dataset.searchStatus, "paused");
});

test("rendering or republishing the same catalog failure never restarts its five-second lifetime", async () => {
  const { view, root, clock } = loadNoticeView(async action => action === "query" ? page(dateRows(1)) : null);
  await beginDate(view); catalogFailure(view); await flush();
  clock.advance(4000); view.render(); catalogFailure(view); await flush();
  assert.equal(clock.notices().length, 1);
  clock.advance(1000); assert.equal(root.querySelector(".search-date-error"), null);
  view.render(); catalogFailure(view); await flush();
  assert.equal(root.querySelector(".search-date-error"), null, "history is not a new notification");
});

test("a queued stale timer cannot remove a newer catalog failure notice", async () => {
  const { view, root, clock } = loadNoticeView(async action => action === "query" ? page(dateRows(1)) : null);
  await beginDate(view); catalogFailure(view); await flush();
  const first = clock.notices()[0]; clock.advance(1000);
  catalogFailure(view, 2, { code: "HTTP", status: 429 }); await flush();
  const newer = root.querySelector(".search-date-error");
  first.callback();
  assert.equal(root.querySelector(".search-date-error"), newer);
  assert.match(text(newer), /titlesRateLimited/);
  clock.advance(4999); assert.equal(root.querySelector(".search-date-error"), newer);
  clock.advance(1); assert.equal(root.querySelector(".search-date-error"), null);
});

for (const action of ["sort-field", "sort-direction", "date-basis", "mode", "page-size", "next-page", "result", "refresh"]) {
  test("new date " + action + " interaction clears the old inline notice and informs the panel", async () => {
    const { view, root, interactions } = loadNoticeView(async name => name === "query"
      ? page(dateRows(7), { cursor: "next", hasMore: true }) : null);
    await beginDate(view); catalogFailure(view); await flush();
    const before = interactions.length;
    if (action === "sort-field" || action === "page-size") {
      const control = root.querySelector(action === "sort-field" ? "[data-search-sort-field]" : "[data-search-page-size]");
      control.value = action === "sort-field" ? "updatedAt" : "15";
      root.emit("change", control);
    } else {
      const selector = { "sort-direction": "[data-search-sort-direction]", "date-basis": "[data-search-date-field]",
        mode: "[data-search-mode]", "next-page": "[data-search-page-direction]", result: "[data-search-result-id]",
        refresh: "[data-search-refresh-catalog]" }[action];
      const targets = root.querySelectorAll(selector);
      const target = action === "date-basis" ? targets.find(node => node.dataset.searchDateField === "updatedAt")
        : action === "mode" ? targets.find(node => node.dataset.searchMode === "keyword")
          : action === "next-page" ? targets.find(node => node.dataset.searchPageDirection === "next") : targets[0];
      root.emit("click", target);
    }
    assert.equal(root.querySelector(".search-date-error"), null);
    assert.equal(interactions.length, before + 1);
    await flush();
    assert.equal(root.querySelector(".search-date-error"), null, "local cache repaint cannot revive the old failure");
  });
}

test("cached readErrors remain paused and never produce a fresh red notice on query or render", async () => {
  const { view, root, clock } = loadNoticeView(async action => action === "query"
    ? page(dateRows(2), { readErrors: [noticeDiagnostic], catalogPhase: "paused", resultStable: false }) : null);
  await beginDate(view); view.render(); await view.loadFirstPage(); view.render();
  assert.equal(root.querySelector(".search-date-error"), null);
  assert.equal(clock.notices().length, 0);
  assert.equal(root.querySelector("[data-search-status]").dataset.searchStatus, "paused");
  assert.equal(root.querySelector(".search-status__label--sr-only"), null);
  assert.equal(view.state.pages.flat().length, 2);
});

test("a fresh catalog failure survives an already-running local query succeeding", async () => {
  const pending = deferred();
  const { view, root } = loadNoticeView(async action => action === "query" ? pending.promise : null);
  const loading = beginDate(view); await flush();
  catalogFailure(view); await flush();
  assert.ok(root.querySelector(".search-date-error"));
  pending.resolve(page(dateRows(2))); await loading; await flush();
  assert.ok(root.querySelector(".search-date-error"), "local cache success cannot claim the catalog recovered");
  assert.equal(view.state.pages.flat().length, 2);
});

test("current clean catalog status clears its failure notice immediately", async () => {
  const { view, root, clock } = loadNoticeView(async action => action === "query" ? page(dateRows(1)) : null);
  await beginDate(view); catalogFailure(view); await flush();
  view.setIndexStatus({ sessionId: view.state.sessionId, accountKey: "workspace-a", revision: 1,
    phase: "settled", resultStable: true, readErrors: [] }); await flush();
  assert.equal(root.querySelector(".search-date-error"), null);
  clock.advance(5000); assert.equal(root.querySelector("[data-search-status]").dataset.searchStatus, "complete");
});

test("old, same-revision, other-account and incomplete success cannot clear a fresh catalog warning", async () => {
  const { view, root } = loadNoticeView(async action => action === "query" ? page(dateRows(1)) : null);
  await beginDate(view);
  view.setIndexStatus({ sessionId: view.state.sessionId, accountKey: "workspace-a", revision: 10,
    phase: "paused", readErrors: [noticeDiagnostic], failureNotice: { id: 1, error: noticeDiagnostic } });
  await flush();
  for (const fields of [{ revision: 9 }, { revision: 10 }, { revision: 11, accountKey: "workspace-b" },
    { revision: 11, resultStable: false }]) {
    view.setIndexStatus({ sessionId: view.state.sessionId, accountKey: "workspace-a", phase: "settled",
      resultStable: true, readErrors: [], ...fields });
    await flush(); assert.ok(root.querySelector(".search-date-error"), JSON.stringify(fields));
  }
  view.setIndexStatus({ sessionId: view.state.sessionId, accountKey: "workspace-a", revision: 11,
    phase: "settled", resultStable: true, readErrors: [] });
  await flush(); assert.equal(root.querySelector(".search-date-error"), null);
});

test("a current local query success clears only the query failure it started with", async () => {
  let failing = true;
  const { view, root } = loadNoticeView(async action => {
    if (action !== "query") return null;
    if (failing) throw noticeDiagnostic;
    return page(dateRows(1));
  });
  await beginDate(view); assert.ok(root.querySelector(".search-date-error"));
  failing = false; await view.loadFirstPage();
  assert.equal(root.querySelector(".search-date-error"), null);
  assert.equal(view.state.error, false);
});

test("new result interaction suppresses a late earlier date query failure but retains diagnosis and rows", async () => {
  let queries = 0; const pending = deferred(), known = dateRows(1);
  const { view, root } = loadNoticeView(async action => action !== "query" ? null : ++queries === 1 ? page(known) : pending.promise);
  await beginDate(view);
  root.emit("click", root.querySelector("[data-search-sort-direction]")); await flush();
  root.emit("click", root.querySelector("[data-search-result-id]"));
  pending.reject(noticeDiagnostic); await flush();
  assert.equal(root.querySelector(".search-date-error"), null);
  assert.equal(view.state.error.code, "SEARCH_UNAVAILABLE");
  assert.deepEqual(plain(view.state.pages.flat()), known);
});

for (const boundary of ["hidden", "route-away"]) test(boundary + " clears a notice and never replays the same catalog failure after return", async () => {
  const { view, root } = loadNoticeView(async action => action === "query" ? page(dateRows(1)) : null);
  await beginDate(view); catalogFailure(view); await flush();
  if (boundary === "hidden") view.setVisible(false); else view.setActive(false);
  assert.equal(root.querySelector(".search-date-error"), null);
  if (boundary === "hidden") view.setVisible(true); else view.setActive(true);
  catalogFailure(view); await flush(); view.render();
  assert.equal(root.querySelector(".search-date-error"), null);
});

test("a hidden catalog failure is consumed, not replayed when the view becomes visible", async () => {
  const { view, root } = loadNoticeView(async action => action === "query" ? page(dateRows(1)) : null);
  await beginDate(view); view.setVisible(false); catalogFailure(view); await flush();
  view.setVisible(true); catalogFailure(view); await flush();
  assert.equal(root.querySelector(".search-date-error"), null);
});

test("manual catalog refresh failure remains visible through its successful local cache reread", async () => {
  const { view, root, clock } = loadNoticeView(async action => {
    if (action === "refresh-catalog") throw noticeDiagnostic;
    return action === "query" ? page(dateRows(1)) : null;
  });
  await beginDate(view); root.emit("click", root.querySelector("[data-search-refresh-catalog]")); await flush();
  assert.ok(root.querySelector(".search-date-error"));
  assert.equal(view.state.pages.flat().length, 1);
  clock.advance(5000); assert.equal(root.querySelector(".search-date-error"), null);
});

test("keyword failure expires without losing rows, total, retry diagnosis or rebuilding the list", async () => {
  const { view, root, clock } = loadNoticeView(async (action, payload) => {
    if (action !== "query") return null;
    if (payload.cursor) throw noticeDiagnostic;
    return page([hit("one", "m1")], { cursor: "next", hasMore: true });
  });
  await beginKeyword(view); clock.advance(100); await view.keywordSearch.whenIdle();
  const list = root.querySelector("[data-search-result-list]");
  assert.ok(root.querySelector(".search-keyword-error"));
  assert.ok(root.querySelector("[data-search-keyword-retry]"));
  clock.advance(5000);
  assert.equal(root.querySelector(".search-keyword-error"), null);
  assert.equal(root.querySelector("[data-search-result-list]"), list);
  assert.equal(view.state.pages.flat().length, 1);
  assert.equal(view.state.keywordStatus.error.code, "SEARCH_UNAVAILABLE");
  assert.match(text(root.querySelector("[data-search-result-count]")), /"count":1/);
  assert.equal(root.querySelector("[data-search-status]").dataset.searchStatus, "paused");
  view.render(); assert.equal(root.querySelector(".search-keyword-error"), null);
});

test("keyword retry is useful: clears the alert, preserves known hits and finishes the failed cursor", async () => {
  let failed = true; const cursors = [];
  const { view, root, interactions, clock } = loadNoticeView(async (action, payload) => {
    if (action !== "query") return null;
    cursors.push(payload.cursor);
    if (!payload.cursor) return page([hit("one", "m1")], { cursor: "next", hasMore: true });
    if (failed) throw noticeDiagnostic;
    return page([hit("two", "m2")]);
  });
  await beginKeyword(view); clock.advance(100); await view.keywordSearch.whenIdle();
  failed = false; const before = interactions.length;
  root.emit("click", root.querySelector("[data-search-keyword-retry]"));
  assert.equal(root.querySelector(".search-keyword-error"), null);
  await view.keywordSearch.whenIdle();
  assert.equal(interactions.length, before + 1);
  assert.deepEqual(cursors, [null, "next", "next"]);
  assert.equal(view.state.pages.flat().length, 2);
  assert.equal(root.querySelector("[data-search-status]").dataset.searchStatus, "complete");
});

test("keyword input clears the previous failure immediately and late old requests cannot restore it", async () => {
  const { view, root, interactions, clock } = loadNoticeView(async action => { if (action === "query") throw noticeDiagnostic; return null; });
  await beginKeyword(view); const before = interactions.length;
  const input = root.querySelector("[data-global-search]"); input.value = "new query";
  root.emit("input", input);
  assert.equal(root.querySelector(".search-keyword-error"), null);
  assert.equal(interactions.length, before + 1);
  clock.advance(349); assert.equal(root.querySelector(".search-keyword-error"), null);
});

test("hide then immediate resume does not grant a previous keyword in-flight failure new notice ownership", async () => {
  const pending = deferred(); let reads = 0;
  const { view, root, clock } = loadNoticeView(async action => { if (action === "query") { reads++; return pending.promise; } return null; });
  const loading = beginKeyword(view); await flush();
  view.setVisible(false); view.setVisible(true);
  pending.reject(noticeDiagnostic); await loading; await flush();
  assert.equal(reads, 1, "resume drains the same read instead of inventing a new request");
  assert.equal(root.querySelector(".search-keyword-error"), null);
  assert.equal(clock.notices().length, 0);
  assert.equal(view.state.keywordStatus.error.code, "SEARCH_UNAVAILABLE");
});

test("genuine invalid date range remains visible after five seconds", async () => {
  const { view, root, clock } = loadNoticeView(async () => { throw new Error("invalid range must not fetch"); });
  view.setActive(true); view.state.mode = "date"; view.state.pageSize = view.state.datePageSize;
  view.state.startDate = "2026-09-10"; view.state.endDate = "2026-09-01";
  await view.loadFirstPage();
  assert.match(text(root), /searchDateRangeError/);
  clock.advance(5000); view.render();
  assert.match(text(root), /searchDateRangeError/);
  assert.equal(view.state.dateError, true);
});

for (const language of ["zh-CN", "zh-TW", "en", "ja"]) test(language + " keyword short notice reuses the existing translated failure text", async () => {
  const { view, root, context, clock } = loadNoticeView(async action => { if (action === "query") throw noticeDiagnostic; return null; });
  vm.runInContext(source("src/messages/i18n.js").replace(/^export /gm, ""), context);
  const translator = context.createTranslator(language); view.render({ translator });
  await beginKeyword(view);
  assert.ok(text(root.querySelector(".search-keyword-error")).includes(translator("searchKeywordIncomplete")));
  clock.advance(5000);
  assert.equal(root.querySelector(".search-keyword-error"), null);
  assert.ok(text(root.querySelector("[data-search-status]")).includes(translator("searchDatePaused")));
});

test("own OPEN null-to-target snapshots keep the current navigation notice ownership; other conversation changes revoke it", async () => {
  const calls = [], target = dateRows(1)[0];
  const { view, root, interactions } = loadNoticeView(async (action, payload) => { calls.push({ action, payload }); return action === "query" ? page([target]) : null; });
  await beginDate(view); view.setConversationId("source-conversation");
  root.emit("click", root.querySelector("[data-search-result-id]"));
  const opened = calls.find(call => call.action === "open"), afterOpen = interactions.length;
  view.setConversationId(null); view.setConversationId(target.conversationId);
  assert.equal(interactions.length, afterOpen, "the authorized OPEN's own route transition is not new user intent");
  assert.equal(view.completeNavigation({ navigationIntentId: opened.payload.navigationIntentId, conversationId: target.conversationId, placement: "latest", located: false, reason: "target-timeout" }), true,
    "its real failure receipt remains current for the panel's short toast");
  view.setConversationId("other-conversation");
  assert.equal(interactions.length, afterOpen + 1);
});

test("preserved document rebind clears read alerts without revoking the authorized OPEN receipt", async () => {
  const calls = [];
  const { view, root, interactions } = loadNoticeView(async (action, payload) => { calls.push({ action, payload }); return action === "query" ? page(dateRows(1)) : null; });
  await beginDate(view); root.emit("click", root.querySelector("[data-search-result-id]"));
  catalogFailure(view); await flush(); const before = interactions.length;
  const id = calls.find(call => call.action === "open").payload.navigationIntentId;
  view.setActive(false, { preserveNavigation: true, invalidateReads: true });
  assert.equal(root.querySelector(".search-date-error"), null);
  assert.equal(interactions.length, before);
  assert.equal(calls.filter(call => call.action === "cancel-navigation").length, 0);
  view.setActive(true); await flush();
  assert.equal(view.completeNavigation({ navigationIntentId: id, conversationId: dateRows(1)[0].conversationId, placement: "latest", located: false, reason: "target-timeout" }), true);
});
