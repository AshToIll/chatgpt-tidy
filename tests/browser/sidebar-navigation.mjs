import { createExportSelection } from '../../src/features/export/ui/export-selection.js';
// Shared error-presentation contract used by the real search owner, including failure paths.
import "../../src/platform/library/library-hydration.js";
import "../../src/platform/snapshot.js";
import "../../src/platform/time-format.js";
import "../../src/features/titles/model/title-dates.js";
import "../../src/features/search/model/search.js";
import "../../src/platform/catalog/date-search.js";
import { createTranslator } from "../../src/messages/i18n.js";
import { createEmptyFavoritesState, upsertFavoriteFromSnapshot } from "../../src/features/favorites/storage/favorites-domain.js";
import { createEmptyBookmarksState, addBookmarkFromSnapshot } from "../../src/features/bookmarks/storage/bookmarks-domain.js";
import { createFavoritesView } from "../../src/features/favorites/ui/favorites-view.js";
import { createBookmarksView } from "../../src/features/bookmarks/ui/bookmarks-view.js";
import { createTitleBatchView } from "../../src/features/titles/ui/title-batch-view.js";
import { createTitleRulesController } from "../../src/features/titles/ui/title-rules.js";
import { createTitleOrganizationView } from "../../src/features/titles/ui/title-organization-view.js";
import { createTitleView } from "../../src/features/titles/ui/title-view.js";
import { createTitleService } from "../../src/features/titles/background/title-service.js";
import { createTitleRulesStore } from "../../src/features/titles/storage/title-rules.js";
import { TITLE_RULES_KEY } from "../../src/features/titles/model/title-rules.js";
import { createSearchView } from "../../src/features/search/ui/search-view.js";
import "../../src/features/export/model/export.js";
import "../../src/features/export/model/export-preview.js";
import "../../src/features/export/engine/i18n.js";
import "../../src/features/export/engine/normalize.js";
import "../../src/features/export/engine/plan.js";
import "../../src/features/export/engine/inline-content.js";
import "../../src/features/export/engine/serializers.js";
import { createExportView } from "../../src/features/export/ui/export-view.js";

const results = [], t = createTranslator("zh-CN");
const preferences = { language: "zh-CN", timeZone: "UTC", dateFormat: "iso", conversationTimeMode: "range" };
const field = value => ({ value, source: "fixture", status: "available" });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
const same = (a, b, message) => assert(a === b, message);
function snapshot(id) {
  return { schemaVersion: TidySnapshot.VERSION, route: { pathname: `/c/${id}`, href: `https://chatgpt.com/c/${id}`,
    kind: "conversation", source: "fixture", status: "available" },
    appearance: { colorScheme: "light", source: "fixture", status: "available", surface: field("rgb(255, 255, 255)") },
    conversation: { conversationId: id, draftId: null, kind: "conversation", bindingStatus: "bound", identityStatus: "stable",
      title: field(`Fixture ${id}`), createdAt: field("2026-08-01T00:00:00.000Z"), updatedAt: field("2026-09-01T00:00:00.000Z"), project: null },
    sidebarConversations: [], messages: [{ messageId: `message-${id}`, idStatus: "stable", presentationStatus: "formal",
      role: "assistant", timestamp: field("2026-09-01T00:00:00.000Z"), excerpt: field(`Fixture note ${id}`),
      order: { index: 1 }, locator: { strategy: "fixture", value: id } }] };
}
function root(name) {
  const node = document.createElement("section"); node.className = "fixture"; node.dataset.fixture = name;
  document.querySelector("#fixtures").append(node); return node;
}
async function check(name, work) {
  try { await work(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: error.message }); }
}
function watch(node) { const observer = new MutationObserver(() => {}); observer.observe(node, { childList: true, subtree: true }); return observer; }

await check("favorites: native nodes, focus, unsaved group name and scroll survive A/empty/B", async () => {
  const host = root("favorites"), view = createFavoritesView({ root: host, onAction: async () => {} });
  let store = createEmptyFavoritesState();
  for (let i = 0; i < 16; i++) store = upsertFavoriteFromSnapshot(store, snapshot(`chat-${i}`));
  const model = { store, snapshot: snapshot("chat-0"), preferences, bookmarkCounts: {}, t };
  view.render(model);
  host.querySelector("[data-open-new-group]").click();
  await sleep(30);
  const list = host.querySelector('[data-results-viewport="favorites"]'), row = list.firstElementChild;
  const input = host.querySelector("[data-new-group] input"), sort = host.querySelector("[data-favorite-sort]");
  input.value = "Unsaved group draft"; input.focus(); input.setSelectionRange(4, 9);
  list.scrollTop = 80; assert(list.scrollTop > 0, "fixture must really scroll");
  const scroll = list.scrollTop, observer = watch(list);
  for (const next of [null, snapshot("chat-1"), snapshot("not-favorited")]) {
    view.render({ ...model, snapshot: next });
    same(host.querySelector('[data-results-viewport="favorites"]'), list, "list remounted");
    same(list.firstElementChild, row, "row remounted"); same(host.querySelector("[data-favorite-sort]"), sort, "select remounted");
    same(document.activeElement, input, "draft input lost focus"); same(input.value, "Unsaved group draft", "draft overwritten");
    same(input.selectionStart, 4, "caret changed"); same(list.scrollTop, scroll, "scroll changed");
  }
  same(observer.takeRecords().length, 0, "navigation mutated list children"); observer.disconnect();
});

await check("bookmarks: all-list stays mounted; current-chat filtering updates only matching rows", async () => {
  const host = root("bookmarks"), view = createBookmarksView({ root: host, onAction: async () => {} });
  let store = createEmptyBookmarksState();
  for (let i = 0; i < 16; i++) store = addBookmarkFromSnapshot(store, snapshot(`chat-${i}`), `message-chat-${i}`);
  store.view.groupId = "all";
  const model = { store, snapshot: snapshot("chat-0"), preferences, activeBookmarkId: null, t };
  view.render(model); await sleep(30);
  const list = host.querySelector('[data-results-viewport="bookmarks"]'), row = list.firstElementChild;
  const input = host.querySelector("[data-bookmark-search]"), sort = host.querySelector("[data-bookmark-sort]");
  input.focus(); list.scrollTop = 70; const scroll = list.scrollTop, observer = watch(list);
  assert(scroll > 0, "fixture must really scroll");
  for (const next of [null, snapshot("chat-1")]) {
    view.render({ ...model, snapshot: next });
    same(host.querySelector('[data-results-viewport="bookmarks"]'), list, "all-list remounted");
    same(list.firstElementChild, row, "all-list row remounted"); same(document.activeElement, input, "search lost focus");
    same(host.querySelector("[data-bookmark-sort]"), sort, "sort select remounted"); same(list.scrollTop, scroll, "scroll changed");
  }
  same(observer.takeRecords().length, 0, "navigation mutated all-list children"); observer.disconnect();
  const currentStore = { ...store, view: { ...store.view, groupId: "current" } };
  view.render({ ...model, store: currentStore });
  const oldId = list.firstElementChild.dataset.bookmarkJump;
  view.render({ ...model, store: currentStore, snapshot: snapshot("chat-1") });
  same(host.querySelector("[data-bookmark-search]"), input, "current filter remounted search");
  same(host.querySelector('[data-results-viewport="bookmarks"]'), list, "current filter remounted viewport");
  assert(list.firstElementChild.dataset.bookmarkJump !== oldId, "current filter did not change its actual data");
});

await check("batch: owner navigation retains selection DOM and issues no status/catalog request", async () => {
  const host = root("batch"), calls = [];
  const rows = Array.from({ length: 16 }, (_, i) => ({ conversationId: `chat-${i}`, title: `Fixture ${i}`,
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }));
  const view = createTitleBatchView({ root: host, ownerTabId: 7,
    rulesController: createTitleRulesController({ read: async () => ({ mode: "range", dateFormat: "iso" }), write: async () => { throw new Error("Unexpected settings write"); } }),
    request: async action => { calls.push(action); assert(action === "batch-status", "fixture must never prepare or write"); return { batchId: null }; },
    loadCatalog: async options => { calls.push("catalog"); options.onUpdate({ accountKey: "fixture-account", rows, loading: false }); },
  });
  view.update({ snapshot: snapshot("chat-0"), preferences, active: true, t }); await sleep(30);
  host.querySelector('[data-batch-select="chat-2"]').click();
  const list = host.querySelector('[data-batch-scroll="select"]'), row = host.querySelector('[data-batch-select="chat-2"]');
  const input = host.querySelector("[data-batch-query]"); input.focus(); list.scrollTop = 90;
  const scroll = list.scrollTop, count = calls.length;
  for (const next of [null, snapshot("chat-1"), snapshot("chat-3")]) {
    view.update({ snapshot: next, preferences, active: true, t });
    same(calls.length, count, "navigation issued I/O");
    same(host.querySelector('[data-batch-scroll="select"]'), list, "directory remounted");
    same(host.querySelector('[data-batch-select="chat-2"]'), row, "selected row remounted");
    same(row.getAttribute("aria-pressed"), "true", "selection cleared");
    same(document.activeElement, input, "search lost focus"); same(list.scrollTop, scroll, "scroll changed");
    assert(!host.querySelector(".tidy-loading-flower"), "navigation showed a spinner");
  }
  view.dispose();
});

await check("search: clicking a result and native navigation only update active markers", async () => {
  const host = root("search"), calls = [];
  const view = createSearchView({ root: host, onAction: async (action, payload) => {
    calls.push(action);
    if (action !== "query") return null;
    return { schemaVersion: "tidy.search.v1", query: payload.query, cursor: null, hasMore: false, partialResults: false, readErrors: [],
      items: Array.from({ length: 12 }, (_, i) => ({ resultId: `fixture-${i}`, conversationId: `chat-${i}`, messageId: `m-${i}`,
        source: "conversation", title: `Fixture chat ${i}`, snippet: `needle ${i}`, matchKind: "content", messageTimestamp: null,
        conversationUpdatedAt: "2026-09-01T00:00:00.000Z" })) };
  } });
  view.setTabId(7); view.render({ translator: t }); view.setActive(true);
  const input = host.querySelector("[data-global-search]"); input.value = "needle";
  input.dispatchEvent(new Event("input", { bubbles: true })); await sleep(1000);
  const list = host.querySelector("[data-search-result-list]"), target = host.querySelector("[data-search-match-id]");
  assert(target, "keyword results did not finish loading");
  const panel = host.firstElementChild, stableInput = host.querySelector("[data-global-search]");
  target.focus(); target.click();
  same(host.firstElementChild, panel, "result click remounted panel"); same(document.activeElement, target, "result click lost focus");
  const count = calls.length;
  for (const id of ["chat-0", null, "chat-1"]) {
    view.setConversationId(id);
    same(calls.length, count, "native navigation triggered search I/O");
    same(host.querySelector("[data-search-result-list]"), list, "result viewport remounted");
    same(host.querySelector("[data-global-search]"), stableInput, "query control remounted");
    same(stableInput.value, "needle", "query changed");
  }
  view.setActive(false);
});

function dateFixture(name, { translator = t, items = [] } = {}) {
  const host = root(name), calls = [];
  const view = createSearchView({ root: host, onAction: async (action, payload) => {
    calls.push({ action, payload });
    if (action !== "query") return null;
    return { items, cursor: null, hasMore: false, total: items.length, resultStable: true,
      partialResults: false, readErrors: [], accountKey: '["fixture-user","personal"]' };
  } });
  view.setTabId(7); view.render({ translator, timeZone: "UTC" }); view.setActive(true);
  host.querySelector('[data-search-mode="date"]').click();
  const click = selector => {
    const node = host.querySelector(selector);
    assert(node && !node.disabled, `missing or disabled calendar control: ${selector}`);
    node.focus(); node.click();
  };
  const choose = (endpoint, date) => {
    const [year, month] = date.split("-").map(Number);
    click(`[data-search-date="${endpoint}"]`);
    click("[data-calendar-view-toggle]"); click("[data-calendar-view-toggle]");
    click(`[data-calendar-year-choice="${year}"]`);
    click(`[data-calendar-month-choice="${month}"]`);
    click(`[data-calendar-date="${date}"]`);
  };
  return { host, view, calls, click, choose };
}

const timeLabels = [
  ["zh-CN", ["创建时间", "更新时间"], ["创建", "更新"]],
  ["zh-TW", ["建立時間", "更新時間"], ["建立", "更新"]],
  ["en", ["Created", "Updated"], ["Created", "Updated"]],
  ["ja", ["作成日時", "更新日時"], ["作成", "更新"]],
];

await check("time wording: all four languages use the same fields in date controls and compact result labels", async () => {
  const item = { resultId: "wording-date", conversationId: "wording-date", messageId: null, source: "conversation",
    title: "Time wording fixture", snippet: "", messageTimestamp: null, matchKind: "conversation-date",
    conversationCreatedAt: "2026-09-05T01:00:00.000Z", conversationUpdatedAt: "2026-09-05T02:00:00.000Z" };
  for (const [language, full, compact] of timeLabels) {
    const h = dateFixture(`time-wording-${language}`, { translator: createTranslator(language), items: [item] });
    try {
      h.choose("start", "2026-09-05"); await sleep(30);
      for (const [index, field] of ["createdAt", "updatedAt"].entries()) {
        same(h.host.querySelector(`[data-search-date-field="${field}"]`).textContent, full[index], `${language}: wrong date basis`);
        same(h.host.querySelector(`[data-search-sort-field] option[value="${field}"]`).textContent, full[index], `${language}: wrong sort label`);
        same(h.host.querySelector(`[data-search-conversation-time="${field}"] > span`).textContent, compact[index], `${language}: wrong result label`);
      }
      // The disabled export keyword tab is intentionally not part of this wording change.
      h.view.render({ exportSelection: { active: true, source: "search", draftIds: [] } });
      assert(h.host.querySelector('[data-search-mode="keyword"]').disabled, `${language}: export keyword mode was enabled`);
    } finally { h.view.setActive(false); }
  }
});

await check("calendar: real ESM controls preserve cross-year bands, focus and one query per chosen range", async () => {
  const { host, view, calls, click, choose } = dateFixture("calendar-range");
  try {
    await sleep(30);
    same(calls.filter(call => call.action === "query").length, 0, "empty dates dispatched a query");
    choose("start", "2025-12-29"); await sleep(30);
    choose("end", "2026-01-03"); await sleep(30);
    same(calls.filter(call => call.action === "query").length, 2, "choosing endpoints must query once each");
    same(document.activeElement.dataset.searchDate, "end", "query render lost endpoint focus");
    const query = calls.filter(call => call.action === "query").at(-1).payload;
    same(new Date(query.startMs).toISOString(), "2025-12-29T00:00:00.000Z", "wrong start boundary");
    same(new Date(query.endMs).toISOString(), "2026-01-04T00:00:00.000Z", "wrong inclusive end boundary");
    click('[data-search-date="start"]');
    same(host.querySelectorAll("[data-calendar-date]").length, 42, "calendar grid changed");
    assert(host.querySelector('[data-calendar-date="2026-01-01"]').matches('.is-outside.is-in-range'), "cross-year band missing");
    same(document.activeElement.dataset.calendarDate, "2025-12-29", "open did not focus chosen day");
    const old = document.activeElement; view.render();
    assert(document.activeElement !== old, "calendar fixture did not actually replace nodes");
    same(document.activeElement.dataset.calendarDate, "2025-12-29", "repaint lost day focus");
    click('[data-search-date="end"]');
    click('[data-calendar-date="2026-01-01"]'); await sleep(30);
    same(calls.filter(call => call.action === "query").length, 3, "endpoint switch dispatched extra queries");
    click('[data-search-date="start"]'); click("[data-calendar-clear]"); await sleep(30);
    same(host.querySelector('[data-search-date="start"] span').textContent, t("searchStartDate"), "clear did not reset endpoint");
    same(calls.filter(call => call.action === "query").length, 4, "clear must query once");
    same(document.activeElement.dataset.searchDate, "start", "clear lost endpoint focus");
  } finally { view.setActive(false); }
});

await check("calendar: measured popup fits its panel, Escape restores focus and outside pointer does not steal focus", async () => {
  const { host, view, calls, click } = dateFixture("calendar-position");
  try {
    await sleep(30); host.scrollIntoView();
    for (const endpoint of ["start", "end"]) {
      click(`[data-search-date="${endpoint}"]`);
      const popup = host.querySelector('.search-calendar'), box = popup.getBoundingClientRect();
      const panel = host.getBoundingClientRect();
      assert(box.width > 0 && box.height > 0, "calendar has no rendered size");
      assert(box.left >= panel.left + 9 && box.right <= panel.right - 9, "popup escaped horizontal bounds");
      assert(box.top >= panel.top && box.bottom <= panel.bottom, "popup escaped vertical bounds");
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      assert(!host.querySelector('[data-search-calendar-layer]'), "Escape left calendar open");
      same(document.activeElement.dataset.searchDate, endpoint, "Escape lost endpoint focus");
    }
    click('[data-search-date="start"]');
    const outside = document.createElement('button'); outside.textContent = 'Outside focus';
    document.body.append(outside); outside.focus();
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    assert(!host.querySelector('[data-search-calendar-layer]'), "outside click left calendar open");
    same(document.activeElement, outside, "outside focus was stolen"); outside.remove();
    same(calls.filter(call => call.action === "query").length, 0, "opening/closing calendar queried history");
  } finally { view.setActive(false); }
});

await check("calendar: two view instances keep independent popup state and tab changes close only their own popup", async () => {
  const first = dateFixture("calendar-owner-a"), second = dateFixture("calendar-owner-b");
  try {
    await sleep(30);
    first.click('[data-search-date="start"]');
    first.click('[data-calendar-view-toggle]');
    second.click('[data-search-date="end"]');
    assert(first.host.querySelector('[data-calendar-month-choice]'), "second instance changed first zoom level");
    assert(second.host.querySelector('[data-calendar-date]'), "second instance did not open days");
    second.view.setTabId(8);
    assert(!second.host.querySelector('[data-search-calendar-layer]'), "tab change kept popup");
    assert(first.host.querySelector('[data-calendar-month-choice]'), "other tab change closed first popup");
    first.view.prepareDateExport();
    assert(!first.host.querySelector('[data-search-calendar-layer]'), "export preparation kept popup");
    same(first.calls.filter(call => call.action === 'query').length, 0, "local calendar operations queried history");
    same(second.calls.filter(call => call.action === 'query').length, 0, "local calendar operations queried history");
  } finally { first.view.setActive(false); second.view.setActive(false); }
});

function exportFixture(name) {
  const host = root(name), reads = [];
  const owner = '["export-fixture","personal"]';
  let favorites = createEmptyFavoritesState(), bookmarks = createEmptyBookmarksState();
  for (const id of ['chat-0', 'chat-1']) {
    favorites = upsertFavoriteFromSnapshot(favorites, snapshot(id));
    bookmarks = addBookmarkFromSnapshot(bookmarks, snapshot(id), `message-${id}`);
  }
  favorites.accountKey = owner; bookmarks.accountKey = owner;
  let model = { active: false, accountKey: owner, favorites, bookmarks, snapshot: null, preferences, translator: t };
  const selection = createExportSelection({ noticeText: (key, values) => model.translator(key, values) });
  const view = createExportView({ selection, root: host,
    requestDocument: async () => { throw new Error('basket fixture must not read the current conversation'); },
    requestDocuments: payload => new Promise(resolve => reads.push({ payload, resolve })),
    presentFullPreview: async () => {}, dismissFullPreview: async () => {}, formatTimestamp: value => value || '',
  });
  // A supplied context is a lifecycle event; view.render() is deliberately paint-only.
  const update = patch => { model = { ...model, ...patch }; view.updateContext(model); };
  const select = (source, ids) => {
    assert(selection.beginSelection(source), `could not open ${source} picker`);
    selection.selectSelectionRange(source, ids); return selection.submitSelection(source);
  };
  update({});
  return { host, view, selection, reads, update, select, owner, favorites, bookmarks };
}

function exportDocument(id, title) {
  return { schemaVersion: TidyExportContract.VERSION, warnings: [], conversation: {
    id, title, sourceUrl: `https://chatgpt.com/c/${id}`, createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z', resources: [], messages: [{ id: `message-${id}`,
      messageNumber: 1, role: 'assistant', timestamp: '2026-09-01T00:00:00.000Z',
      segments: [{ type: 'content', sourceMessageId: `message-${id}`, timestamp: '2026-09-01T00:00:00.000Z',
        blocks: [{ type: 'paragraph', text: `Fixture content ${id}` }] }],
    }],
  } };
}

await check('export basket: real ESM view merges sources, retains unavailable selections and removes each kind independently', async () => {
  const h = exportFixture('export-basket');
  try {
    h.select('favorites', ['chat-0']);
    h.selection.beginSelection('search');
    h.selection.registerSearchResults(['chat-0', 'chat-1'].map(id => ({ source: 'conversation', matchKind: 'conversation-date',
      conversationId: id, messageId: null, title: `Search ${id}`, accountKey: 'fixture-catalog',
      conversationCreatedAt: null, conversationUpdatedAt: null })));
    h.selection.selectSelectionRange('search', ['chat-0', 'chat-1']);
    const result = h.selection.submitSelection('search');
    same(result.added, 1, 'whole conversation duplicated'); same(result.sourceUpdated, 1, 'source provenance not merged');
    h.select('bookmarks', Object.keys(h.bookmarks.items));
    same(h.selection.basketCount(), 4, 'conversation/bookmark membership conflated');
    h.view.setSettingsView('manage'); h.update({});
    same(h.host.querySelectorAll('[data-export-remove-conversation]').length, 2, 'wrong conversation rows');
    same(h.host.querySelectorAll('[data-export-remove-bookmark]').length, 2, 'wrong bookmark rows');
    h.update({ favorites: null, bookmarks: null });
    same(h.selection.basketCount(), 4, 'unavailable source deleted basket');
    h.update({ favorites: { ...h.favorites, revision: 2, items: {} }, bookmarks: h.bookmarks });
    same(h.selection.selectionState('search').basketConversationSources['chat-0'].join(','), 'search', 'proven favorite deletion lost search source');
    h.host.querySelector('[data-export-remove-conversation="chat-0"]').click();
    same(h.selection.basketCount(), 3, 'conversation removal also removed bookmarks');
    h.host.querySelector('[data-export-remove-bookmark-group="chat-0"]').click();
    same(h.selection.basketCount(), 2, 'group removal did not use bookmark membership');
    h.update({ accountKey: '["another-export-owner","personal"]' });
    same(h.selection.basketCount(), 0, 'account change retained old basket');
    same(h.reads.length, 0, 'inactive basket changes dispatched a read');
  } finally { h.update({ active: false, accountKey: null }); }
});

await check('export basket: removal invalidates a pending read; a later basket can load without publishing the old reply', async () => {
  const h = exportFixture('export-stale-read');
  try {
    h.select('favorites', ['chat-0']); h.view.setSettingsView('manage'); h.update({ active: true });
    same(h.reads.length, 1, 'batch read did not start');
    h.host.querySelector('[data-export-remove-conversation="chat-0"]').click();
    const old = exportDocument('chat-0', 'STALE_PRIVATE_TITLE');
    assert(TidyExportContract.validateDocument(old).valid, 'old reply fixture must be a valid export document');
    h.reads[0].resolve({ schemaVersion: TidyExportContract.COLLECTION_VERSION, documents: [old] });
    await sleep(30);
    same(h.selection.basketCount(), 0, 'late read restored removed membership');
    assert(!h.host.textContent.includes('STALE_PRIVATE_TITLE'), 'late read was published');
    h.select('favorites', ['chat-1']); h.update({});
    same(h.reads.length, 2, 'old loading latch blocked new basket');
    same(h.reads[1].payload.conversationIds.join(','), 'chat-1', 'new basket read old IDs');
    h.reads[1].resolve({ schemaVersion: TidyExportContract.COLLECTION_VERSION, documents: [exportDocument('chat-1', 'FRESH_TITLE')] });
    await sleep(30);
    assert(h.host.textContent.includes('FRESH_TITLE'), 'fresh validated document was not published');
    assert(!h.host.textContent.includes('STALE_PRIVATE_TITLE'), 'old document survived fresh load');
  } finally { h.update({ active: false, accountKey: null }); }
});

await check("title settings: fresh panels default to creation, keep choices, merge patches and recover from failures", async () => {
  let stored = {}, failWrite = false, failRead = false;
  const observers = new Set(), calls = [], panels = [];
  const store = createTitleRulesStore({ defaults: async () => preferences, storage: {
    get: async key => { if (failRead) throw new Error("Fixture read failure"); return { [key]: { ...stored } }; },
    set: async values => {
      await sleep(10);
      if (failWrite) throw new Error("Fixture write failure");
      stored = { ...values[TITLE_RULES_KEY] };
      for (const listener of observers) listener(stored);
    },
  } });
  const createPanel = () => {
    const host = root("title-settings"), id = panels.length;
    const rules = createTitleRulesController({ read: store.read, write: store.update,
      listen: listener => { observers.add(listener); return () => observers.delete(listener); } });
    const current = { conversationId: "chat-0", title: "Fixture chat-0", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };
    const view = createTitleOrganizationView({ root: host, ownerTabId: 7, rulesController: rules,
      request: async (action, payload) => {
        calls.push({ id, action });
        assert(["preview", "replan"].includes(action), "settings changes must not write ChatGPT titles");
        return { current, operation: null, previewContext: { id: `fixture-context-${id}`, expiresAt: Date.now() + 300000 },
          plan: { ...TidyTitleDates.plan(current, payload.rules, { operation: payload.operation, decision: payload.decision }), id: `fixture-plan-${calls.length}` } };
      }, loadCatalog: async () => { throw new Error("Unexpected catalog read"); },
    });
    view.update({ active: true, snapshot: snapshot("chat-0"), preferences, translator: t });
    const panel = { host, rules, view, select: field => host.querySelector(`[data-title-rule="${field}"]`) };
    panels.push(panel); return panel;
  };
  const choose = (panel, field, value) => {
    const input = panel.select(field); assert(input && !input.disabled, "title setting must be usable");
    input.value = value; input.dispatchEvent(new Event("change", { bubbles: true })); return input;
  };
  try {
    const a = createPanel(), b = createPanel(); await sleep(40);
    same(a.select("mode").value, "created", "fresh editor inherited the display range setting");
    same(b.select("mode").value, "created", "fresh panels disagree on the default");
    same(Object.keys(stored).length, 0, "opening editors wrote default settings");
    choose(a, "mode", "range"); await a.rules.whenSaved(); await sleep(20);
    same(b.select("mode").value, "range", "explicit range choice was replaced by default");
    const original = a.select("dateFormat"); original.focus();
    choose(a, "dateFormat", "dot");
    same(document.activeElement, original, "local choice lost keyboard focus");
    same(a.select("dateFormat"), original, "local preview replaced select");
    choose(b, "mode", "created");
    await Promise.all([a.rules.whenSaved(), b.rules.whenSaved()]); await sleep(30);
    for (const panel of [a, b]) {
      same(panel.select("dateFormat").value, "dot", "other window reset the date format");
      same(panel.select("mode").value, "created", "mode did not synchronize");
      same(getComputedStyle(panel.host.querySelector("[data-title-rules-notice]")).display, "none", "success must not leave a notice occupying space");
    }
    same(a.select("dateFormat"), original, "storage notification replaced select");
    same(document.activeElement, original, "storage notification lost focus");
    failWrite = true; choose(a, "dateFormat", "compact");
    same(a.select("dateFormat").value, "compact", "preview must not wait for storage");
    same(await a.rules.whenSaved(), false, "failed save reported success"); await sleep(20);
    same(a.select("dateFormat").value, "dot", "failed choice did not roll back");
    assert(a.host.querySelector("[data-title-rules-notice]").textContent.includes(t("titlesSettingsSaveFailed")), "save failure is not visible");
    assert(!a.host.querySelector("[data-title-rules-notice]").hidden, "failure notice remains hidden");
    failWrite = false; choose(a, "dateFormat", "compact"); await a.rules.whenSaved(); await sleep(20);
    assert(a.host.querySelector("[data-title-rules-notice]").hidden, "notice persists after successful new choice");
    failRead = true; const c = createPanel(); await sleep(30);
    const retry = c.host.querySelector("[data-title-rules-retry]");
    assert(!retry.hidden, "failed load has no retry action");
    failRead = false; retry.focus(); retry.click(); await sleep(40);
    same(c.select("dateFormat").value, "compact", "retry did not read the saved choice");
    assert(c.host.querySelector("[data-title-rules-notice]").hidden, "read failure persists after recovery");
    same(document.activeElement, c.host.querySelector('[data-titles-mode][aria-selected="true"]'), "successful retry left focus on a hidden action");
    same(calls.filter(call => call.action === "preview").length, 3, "settings updates triggered extra authenticated previews");
  } finally { for (const panel of panels) { panel.view.dispose(); panel.rules.dispose(); } }
  same(observers.size, 0, "disposed panels still subscribe to settings");
});

await check("title metadata: current and batch reuse the same range for every language, date format and title mode", async () => {
  const rows = [
    ["same-day", "2026-09-28T08:23:00.000Z", "2026-09-28T19:42:00.000Z"],
    ["cross-day", "2026-09-27T23:23:00.000Z", "2026-09-28T00:25:00.000Z"],
    ["cross-year", "2025-12-31T23:23:00.000Z", "2026-01-01T00:25:00.000Z"],
  ].map(([conversationId, createdAt, updatedAt]) => ({ conversationId, title: `Fixture ${conversationId}`, createdAt, updatedAt }));
  const cases = [
    [0, "iso", "UTC", "created"], [0, "iso", "UTC", "range"],
    [1, "slash", "UTC", "range"], [1, "dot", "Asia/Shanghai", "created"],
    [2, "compact", "UTC", "range"], [2, "locale", "America/Los_Angeles", "created"],
  ];
  for (const [language, labels] of timeLabels) {
    const translator = createTranslator(language), currentHost = root(`title-range-current-${language}`), batchHost = root(`title-range-batch-${language}`);
    let current = rows[0], saved = { dateFormat: "iso", mode: "created" }, sequence = 0;
    const rules = createTitleRulesController({ read: async () => saved,
      write: async patch => (saved = { ...saved, ...patch }), listen: () => () => {} });
    await rules.initialize(preferences);
    const currentView = createTitleView({ root: currentHost, ownerTabId: 7, rulesController: rules,
      request: async (action, payload) => {
        assert(["preview", "replan"].includes(action), "metadata rendering must never write a title");
        return { current: { ...current }, operation: null, previewContext: { id: `range-context-${++sequence}`, expiresAt: Date.now() + 300000 },
          plan: { ...TidyTitleDates.plan(current, payload.rules, { operation: payload.operation, decision: payload.decision }), id: `range-plan-${sequence}` } };
      } });
    const batchView = createTitleBatchView({ root: batchHost, ownerTabId: 7, rulesController: rules,
      request: async action => { same(action, "batch-status", "range rendering dispatched a batch mutation"); return { batchId: null }; },
      loadCatalog: async options => options.onUpdate({ accountKey: "range-fixture", rows, loading: false }),
    });
    try {
      for (const [rowIndex, dateFormat, timeZone, mode] of cases) {
        current = rows[rowIndex];
        rules.update({ dateFormat, mode }); await rules.whenSaved();
        const observed = snapshot(current.conversationId);
        Object.assign(observed.conversation, { title: field(current.title), createdAt: field(current.createdAt), updatedAt: field(current.updatedAt) });
        const model = { snapshot: observed, preferences: { ...preferences, timeZone }, active: true, translator };
        currentView.update(model); batchView.update(model); await sleep(30);
        const context = `${language}/${current.conversationId}/${dateFormat}/${timeZone}/${mode}`;
        const expected = TidyTimeFormat.formatRange(current.createdAt, current.updatedAt, { dateFormat, timeZone, locale: navigator.language, mode });
        assert(expected, `${context}: fixture range must be available`);
        same(currentHost.getAttribute("aria-busy"), "false", `${context}: current read did not settle`);
        // Exact equality also rejects the obsolete Created / Recent labels and fixed slash-only formatting.
        same(currentHost.querySelector(".titles-scope small").textContent, expected, `${context}: current metadata is not the shared range`);
        same(batchHost.querySelector(`[data-batch-select="${current.conversationId}"] small`).textContent, expected, `${context}: batch range differs`);
        for (const [index, field] of ["createdAt", "updatedAt"].entries()) {
          same(batchHost.querySelector(`[data-batch-sort-field] option[value="${field}"]`).textContent, labels[index], `${language}: inconsistent batch sort field`);
        }
      }
    } finally { currentView.dispose(); batchView.dispose(); rules.dispose(); }
  }
});

await check('title recovery: real service and mounted view distinguish unsent changes from unknown results', async () => {
  const host = root('title-recovery'), records = new Map();
  let rejectPrepared = true, failObservation = false, writes = 0, sequence = 0;
  const current = { conversationId: 'chat-0', title: 'Fixture chat-0', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' };
  const service = createTitleService({ model: TidyTitleDates, createId: () => `recovery-${++sequence}`,
    read: async () => {
      if (failObservation) throw Error('Fixture observation failure');
      return { identity: { accountKey: 'fixture-user', workspaceKey: 'personal' }, current: { ...current } };
    },
    write: async (_context, _plan, beforeDispatch) => { await beforeDispatch(); writes++; return { status: 'uncertain', current: { ...current } }; },
    storage: { get: async key => structuredClone(records.get(key) || null), set: async (key, value) => {
      if (rejectPrepared && value.operation?.status === 'pending' && value.operation.dispatchPhase === 'prepared') throw Error('Fixture disk failure');
      records.set(key, structuredClone(value));
    } },
  });
  const rules = createTitleRulesController({ read: async () => ({ mode: 'created', dateFormat: 'iso' }), write: async value => value, listen: () => () => {} });
  await rules.initialize(preferences);
  const view = createTitleView({ root: host, ownerTabId: 7, rulesController: rules,
    request: (action, payload) => service.handle(action, { tabId: 7, conversationId: 'chat-0' }, payload) });
  const action = name => host.querySelector(`[data-title-action="${name}"]`);
  const waitFor = async predicate => { for (let i = 0; i < 50; i++) { if (predicate()) return; await sleep(20); } throw Error('Title recovery did not settle'); };
  try {
    view.update({ active: true, snapshot: snapshot('chat-0'), preferences, translator: t });
    await waitFor(() => action('apply') && !action('apply').disabled);
    action('apply').click(); await waitFor(() => host.textContent.includes('修改未提交'));
    same(writes, 0, 'failed checkpoint reached writer');
    assert(action('preview') && !action('preview').disabled && !action('reconcile'), 'known unsent change has no recovery exit');
    rejectPrepared = false; action('preview').click();
    await waitFor(() => action('apply') && !action('apply').disabled);
    same(writes, 0, 'preview automatically retried a write');
    action('apply').click(); await waitFor(() => host.querySelector('[data-title-recovery]'));
    same(writes, 1, 'confirmation did not reach exactly one guarded write');
    // 读取失败才继续待确认；可靠读到原标题允许重新预览，但绝不重放旧确认。
    failObservation = true;
    for (let i = 0; i < 2; i++) {
      action('reconcile').click(); await waitFor(() => host.getAttribute('aria-busy') === 'false');
      assert(action('reconcile') && !action('reconcile').disabled, 'failed observation lost its check action');
      assert(host.querySelector('[data-title-recovery]'), 'failed observation incorrectly unlocked recovery');
      assert(!action('apply') && !action('preview'), 'unknown outcome offers a resend');
    }
    const recovery = host.querySelector('[data-title-recovery]');
    assert(recovery.textContent.includes(t('titlesRecoveryTarget')) && recovery.textContent.includes(t('titlesRecoveryObserved')), 'unknown outcome has no readable comparison');
    same(writes, 1, 'failed checking resubmitted the change');
    failObservation = false;
    action('reconcile').click(); await waitFor(() => !host.querySelector('[data-title-recovery]'));
    assert(host.textContent.includes(t('titlesUnchanged')), 'observed original title has no accurate explanation');
    assert(action('preview') && !action('preview').disabled && !action('apply'), 'observed original must require a new preview before confirmation');
    same(writes, 1, 'observing original title automatically resent the change');
    current.title = [...records.values()][0].operation.after;
    action('preview').click(); await waitFor(() => host.getAttribute('aria-busy') === 'false');
    same([...records.values()][0].operation.status, 'verified', 'late target observation did not settle the existing receipt');
    assert(host.textContent.includes(current.title), 'observed target is not shown');
    same(writes, 1, 'success recovery wrote again');
  } finally { view.dispose(); rules.dispose(); }
});

document.querySelector("#results").textContent = JSON.stringify({ ok: results.every(result => result.ok), checks: results }, null, 2);
document.querySelector("#results").dataset.complete = "true";
