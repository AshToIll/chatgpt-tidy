const { readPanelCss } = require("./helpers/read-panel-css.cjs");
// The fixed UUID is synthetic and does not identify a real ChatGPT conversation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { installPageSession } = require("./helpers/page-session.cjs");
const { createWorkerModuleLoader } = require("./helpers/worker-runtime.cjs");

const root = path.resolve(__dirname, "..");

function loadSearch(fetchImpl = null) {
  const context = vm.createContext({
    console,
    Date,
    Math,
    AbortController,
    Headers,
    fetch: fetchImpl,
    crypto: { randomUUID: () => "11111111-2222-4333-8444-555555555555" },
  });
  context.globalThis = context;
  installPageSession(context);
  for (const file of [
    "src/features/search/model/search.js",
    "src/platform/chatgpt/api.js",
    "src/features/search/chatgpt/search.js",
  ]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  }
  return context;
}

function rawResponse(overrides = {}) {
  return {
    items: [{
      id: "conversation:conversation-1:message:message-7",
      source_type: "conversation",
      source_key: "conversation",
      title: "OpenPencil notes",
      snippet: "The OpenPencil renderer is ready",
      update_time: 1_700_000_000.5,
      match_kind: "content",
      payload: {
        kind: "conversation",
        conversation_id: "conversation-1",
        message_id: "message-7",
        is_archived: false,
        is_starred: null,
      },
    }],
    cursor: "opaque-page-two",
    partial_results: false,
    source_statuses: [{ source: "conversation", status: "ok", has_more: true, duration_ms: 628 }],
    ...overrides,
  };
}

async function loadWorkerWithChrome(chrome) {
  const runtime = {
    getURL: (value = "") => `chrome-extension://tidy-test/${String(value).replace(/^\//, "")}`,
    ...(chrome.runtime || {}),
  };
  const sidePanel = {
    getOptions: async ({ tabId }) => ({
      enabled: true,
      path: `app/sidepanel/index.html?tidyTabId=${tabId}`,
    }),
    ...(chrome.sidePanel || {}),
  };
  const resolvedChrome = { ...chrome, runtime, sidePanel };
  // Exercise the production binding factory and its real protocol/navigation
  // imports. Chrome is the only boundary replaced here; no worker entrypoint
  // function is copied into a synthetic global scope.
  const context = vm.createContext({ chrome: resolvedChrome, URL, URLSearchParams });
  const loader = createWorkerModuleLoader(context);
  const { createRequestBinding } = loader.load("src/platform/session/background/request-binding.js");
  return createRequestBinding({ chrome: resolvedChrome, libraryIdentity: {
    readAccount: async () => { throw new Error("Tab binding must not read the library account"); },
  } });
}

test("official search response becomes the standard message-result DTO", () => {
  const { TidyChatgptSearch, TidySearch } = loadSearch();
  const page = TidyChatgptSearch.normalizeResponse(rawResponse(), "OpenPencil");
  assert.equal(page.schemaVersion, "tidy.search.v1");
  assert.equal(page.items.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(page.items[0])), {
    resultId: "conversation:conversation-1:message:message-7",
    source: "conversation",
    conversationId: "conversation-1",
    messageId: "message-7",
    title: "OpenPencil notes",
    snippet: "The OpenPencil renderer is ready",
    conversationUpdatedAt: "2023-11-14T22:13:20.500Z",
    matchKind: "content",
  });
  assert.equal(page.cursor, "opaque-page-two");
  assert.equal(page.hasMore, true);
  assert.equal(TidySearch.validatePage(page).valid, true);
});

test("pagination returns the official opaque cursor unchanged", () => {
  const { TidyChatgptSearch } = loadSearch();
  const body = TidyChatgptSearch.buildRequestBody({
    query: "OpenPencil",
    limit: 10,
    sessionId: "11111111-2222-4333-8444-555555555555",
    cursor: "opaque-page-two",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(body)), {
    query: "OpenPencil",
    limit: 10,
    query_id: "11111111-2222-4333-8444-555555555555",
    entrypoint: "global_search",
    source_requests: [{ type: "conversation" }],
    cursor: "opaque-page-two",
  });
});

test("all four search page sizes pass request validation, including the 60-result option", () => {
  const { TidyChatgptSearch, TidySearch } = loadSearch();
  assert.deepEqual(Array.from(TidySearch.PAGE_SIZE_OPTIONS), [7, 15, 30, 60]);
  for (const limit of TidySearch.PAGE_SIZE_OPTIONS) {
    const body = TidyChatgptSearch.buildRequestBody({ query: "needle", sessionId: "page-size-test", limit });
    assert.equal(body.limit, limit);
  }
  assert.throws(() => TidySearch.normalizeRequest({ query: "needle", sessionId: "page-size-test", limit: 61 }),
    /Search limit is invalid/);
});

test("non-conversation sources are excluded without re-filtering server-qualified results", () => {
  const { TidyChatgptSearch } = loadSearch();
  const project = {
    id: "project:1", source_type: "project", source_key: "project",
    title: "OpenPencil", snippet: "renderer", payload: { kind: "project" },
  };
  const missingTerm = {
    ...rawResponse().items[0], id: "conversation:2:message:2",
    title: "OpenPencil only", snippet: "no second term",
    payload: { kind: "conversation", conversation_id: "2", message_id: "2" },
  };
  const page = TidyChatgptSearch.normalizeResponse(
    rawResponse({ items: [project, rawResponse().items[0], missingTerm] }),
    "OpenPencil renderer",
  );
  assert.deepEqual(page.items.map((item) => item.resultId), [
    "conversation:conversation-1:message:message-7",
    "conversation:2:message:2",
  ]);
});

test("title-level results fall back to a conversation and schema drift still fails closed", () => {
  const { TidyChatgptSearch } = loadSearch();
  const titleMatch = TidyChatgptSearch.normalizeResponse(rawResponse({
    items: [{
      ...rawResponse().items[0],
      id: "conversation:conversation-1",
      match_kind: "title",
      payload: { kind: "conversation", conversation_id: "conversation-1" },
    }],
  }), "OpenPencil");
  assert.equal(titleMatch.items[0].messageId, null);
  assert.throws(
    () => TidyChatgptSearch.normalizeResponse(rawResponse({
      items: [{ ...rawResponse().items[0], payload: { kind: "conversation", message_id: "message-7" } }],
    }), "OpenPencil"),
    /schema changed/,
  );
  assert.throws(
    () => TidyChatgptSearch.normalizeResponse({ items: [], cursor: null }, "OpenPencil"),
    /partial_results/,
  );
});

test("official request uses the shared authenticated POST contract without N+1 fetches", async () => {
  const calls = [];
  const context = loadSearch(async (url, options) => {
    calls.push({ url, options });
    if (url === "/api/auth/session") {
      return { ok: true, status: 200, json: async () => ({ accessToken: "search-token" }) };
    }
    return { ok: true, json: async () => rawResponse({ cursor: null, source_statuses: [{ status: "ok", has_more: false }] }) };
  });
  const page = await context.TidyChatgptSearch.search({
    query: "OpenPencil", sessionId: "11111111-2222-4333-8444-555555555555", limit: 10, cursor: null,
  });
  assert.equal(page.items.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "/api/auth/session");
  assert.equal(calls[1].url, "/backend-api/global/search");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.credentials, "include");
  assert.equal(calls[1].options.headers.get("Authorization"), "Bearer search-token");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    query: "OpenPencil",
    limit: 10,
    query_id: "11111111-2222-4333-8444-555555555555",
    entrypoint: "global_search",
    source_requests: [{ type: "conversation" }],
  });
});

test("formal Side Panel shares result typography and keeps custom conversation-date controls", () => {
  const html = fs.readFileSync(path.join(root, "src/app/sidepanel/index.html"), "utf8");
  const css = readPanelCss();
  const view = fs.readFileSync(path.join(root, "src/features/search/ui/search-presentation.js"), "utf8");
  const controller = fs.readFileSync(path.join(root, "src/features/search/ui/search-query-controller.js"), "utf8");
  assert.match(html, /data-route="search"[^>]*>/);
  assert.doesNotMatch(html, /data-route="search"[^>]*disabled/);
  assert.doesNotMatch(html, /id="search-view"[^>]*>\s*<div class="module-placeholder"/);
  assert.match(css, /\.search-result__source\s*\{[^}]*font-size:\s*12px/s);
  assert.match(css, /\.search-result__conversation-summary, \.search-result--keyword p\s*\{[^}]*font-size:\s*12px/s);
  assert.doesNotMatch(css, /\.bookmark-entry-source\s*,\s*\.search-result__source/);
  assert.match(html, /id="search-view" class="module-view search-view"[^>]*aria-label="搜索"/);
  assert.match(view, /panel\.className = "search-panel"/);
  assert.match(css, /\.search-panel\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(view, /className = "search-sort-section"/);
  assert.match(view, /className = "search-results-area"/);
  assert.match(view, /className = "result-pagination"/);
  assert.match(view, /conversationCreatedAt/);
  assert.match(view, /conversationUpdatedAt/);
  assert.doesNotMatch(view, /input\.type\s*=\s*"date"|type=["']date["']/);
  const calendar = fs.readFileSync(path.join(root, "src/features/search/ui/search-calendar.js"), "utf8");
  assert.match(calendar, /button\.dataset\.searchDate = target/);
  assert.match(calendar, /button\.setAttribute\("aria-haspopup", "dialog"\)/);
  assert.match(view, /search-mode-tabs/);
  assert.match(view, /makeDateBasis\(\)/);
  assert.match(controller, /function setTabId\(tabId,/);
});

test("formal date controls retain the frozen TIDY calendar interactions and range markers", () => {
  const css = readPanelCss();
  const view = fs.readFileSync(path.join(root, "src/features/search/ui/search-calendar.js"), "utf8");
  assert.match(view, /function makeSearchCalendar\(\)/);
  assert.match(view, /dataset\.searchCalendarLayer/);
  assert.match(view, /dataset\.calendarNav/);
  assert.match(view, /dataset\.calendarViewToggle/);
  assert.match(view, /dataset\.calendarMonthChoice/);
  assert.match(view, /dataset\.calendarYearChoice/);
  assert.match(view, /dataset\.calendarDate/);
  assert.match(view, /dataset\.calendarClear/);
  assert.match(view, /dataset\.calendarClose/);
  assert.match(view, /"is-in-range"/);
  assert.match(view, /"is-range-edge"/);
  assert.match(view, /"is-selected"/);
  assert.match(view, /"is-today"/);
  assert.match(view, /dateContract\.searchDateBounds\(/);
  assert.match(view, /const rangeValid = isRangeValid\(\)/);
  assert.match(css, /\.search-overlay-layer\s*\{/);
  assert.match(css, /\.search-calendar\s*\{[^}]*width:\s*min\(300px, calc\(100% - 20px\)\)/s);
  assert.match(css, /\.search-calendar__days button\.is-in-range/);
  assert.match(css, /\.search-calendar footer/);
});

test("protocol relay and exact-message navigation stay search-scoped", () => {
  const read = file => fs.readFileSync(path.join(root, file), "utf8");
  const protocol = read("src/platform/protocol.js");
  const isolated = read("src/app/page/isolated.js");
  const mainWorld = read("src/app/page/main-world.js");
  const pageRouter = read("src/app/page/request-router.js");
  const worker = read("src/app/background/service-worker.js");
  const binding = read("src/platform/session/background/request-binding.js");
  const gateway = read("src/app/background/adapters/search-gateway.js");
  const searchHandler = read("src/app/background/handlers/search.js");
  const contextHandler = read("src/app/background/handlers/preferences.js");
  const router = read("src/app/background/request-router.js");
  const runtime = read("src/app/background/runtime-messages.js");
  const panelHost = read("src/platform/navigation/background/panel-host.js");
  const lifecycle = read("src/app/background/browser-lifecycle.js");
  const navigationHandler = read("src/app/background/handlers/navigation.js");
  const navigation = read("src/platform/navigation/background/worker-navigation.js");
  const panel = read("src/app/sidepanel/panel.js");
  const panelRequest = read("src/app/sidepanel/request-client.js");
  const panelContext = read("src/app/sidepanel/context-controller.js");
  assert.match(protocol, /SEARCH_MESSAGES:\s*"search\.messages"/);
  assert.match(protocol, /SEARCH_OPEN_RESULT:\s*"search\.open-result"/);
  assert.match(protocol, /SEARCH_UNAVAILABLE:\s*"SEARCH_UNAVAILABLE"/);
  assert.match(isolated, /protocol\.Type\.SEARCH_MESSAGES/);
  assert.match(isolated, /content\.isolated\.request-main-timeout/);
  assert.match(isolated, /content\.isolated\.post-main/);
  assert.match(mainWorld, /TidyPageRequestRouter\.create\(/);
  assert.match(pageRouter, /searchAdapter\.search\(envelope\.payload\)/);
  assert.match(pageRouter, /main-world\.search-adapter/);
  assert.match(read("src/features/search/chatgpt/search.js"), /chatgptApi\.fetchAuthenticated\(ENDPOINT/);
  assert.match(binding, /async function getBoundTab\(expectedTabId, sender = null\)/);
  assert.match(binding, /const tab = await chrome\.tabs\.get\(tabId\)/);
  assert.match(gateway, /async function requestBoundSearch\(expectedTabId, payload, sender = null\)/);
  assert.match(gateway, /service-worker\.tabs-send-message/);
  assert.match(binding, /service-worker\.resolve-tab/);
  assert.match(gateway, /service-worker\.bound-search/);
  assert.match(runtime, /error\.details \|\| \(error\.stage \? \{ stage: error\.stage \} : null\)/);
  assert.match(searchHandler, /SEARCH_MESSAGES[\s\S]{0,500}requestBoundSearch\(payload\.expectedTabId, request, sender\)/);
  assert.match(gateway, /const tab = await getBoundTab\(expectedTabId, sender\);/);
  assert.match(contextHandler, /binding\.getBoundTab\(envelope\.payload\?\.expectedTabId, sender\)/);
  assert.match(contextHandler, /GET_ACTIVE_CONTEXT/);
  assert.match(worker, /createPreferencesHandler\(\{ binding, pageGateway, panelHost \}\)/);
  assert.match(worker, /createSearchHandler\(\{ search \}\)/);
  for (const owner of [worker, binding, gateway, router]) assert.doesNotMatch(owner, /queryActiveTab/);
  assert.match(panelHost, /path:\s*createSidePanelPath\(tabId\)/);
  assert.match(panel, /parsePanelOwnerTabId\([\s\S]{0,160}chrome\.runtime\.getURL\("app\/sidepanel\/index\.html"\)/);
  assert.match(panel, /createPanelContextController\(\{\s*ownerTabId:\s*panelOwnerTabId,[\s\S]{0,180}contextType:\s*protocol\.Type\.GET_ACTIVE_CONTEXT/);
  assert.match(panelContext, /request\(contextType,\s*\{\s*expectedTabId:\s*ownerTabId\s*\}\)/);
  for (const owner of [worker, lifecycle, panelHost]) assert.doesNotMatch(owner, /reason:\s*"tab-activated"/);
  assert.match(worker, /requestTabMessageLocation:\s*pageGateway\.locate/);
  assert.match(navigation, /requestTabMessageLocation\(tab,[\s\S]{0,180}messageId:\s*ticket\.messageId/);
  assert.match(navigationHandler, /navigation\.openSearch\(navigationHandle, envelope\.payload/);
  assert.match(navigation, /searchParams\.set\("messageId", ticket\.messageId\)/);
  assert.doesNotMatch(navigation, /searchParams\.set\("(?:historySearchQuery|src)"/);
  assert.doesNotMatch(navigationHandler, /payload\.title/);
  assert.match(panelRequest, /sidepanel\.runtime-send-message/);
  assert.match(panelRequest, /sidepanel\.runtime-response/);
  assert.match(panel, /CONTEXT_CHANGED\)\s*\{[\s\S]{0,140}payload\?\.tabId !== panelOwnerTabId/);
});

test("the search bridge resolves the Side Panel's bound tab, not Chrome's current window", async () => {
  const calls = [];
  const expected = { id: 41, url: "https://chatgpt.com/c/conversation-1" };
  const context = await loadWorkerWithChrome({
    tabs: {
      query: async () => [{ id: 99, url: "devtools://devtools" }],
      get: async (tabId) => { calls.push(tabId); return expected; },
    },
  });
  assert.deepEqual(await context.getBoundTab(41), expected);
  assert.deepEqual(calls, [41]);
  await assert.rejects(() => context.getBoundTab(null), (error) => error.tidyCode === "TAB_UNAVAILABLE");
});

test("the first Side Panel request resolves its immutable owner URL", async () => {
  const calls = [];
  const context = await loadWorkerWithChrome({
    runtime: {
      getContexts: async () => { throw new Error("getContexts must not own a panel"); },
    },
    sidePanel: {
      getOptions: async (query) => {
        calls.push(["options", query.tabId]);
        return { enabled: true, path: "app/sidepanel/index.html?tidyTabId=52" };
      },
    },
    tabs: {
      get: async (tabId) => {
        calls.push(["tab", tabId]);
        return { id: tabId, url: "https://chatgpt.com/" };
      },
    },
  });
  const sender = {
    documentId: "panel-1",
    url: "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=52",
  };
  assert.equal((await context.getBoundTab(52, sender)).id, 52);
  assert.deepEqual(calls, [["options", 52], ["tab", 52]]);
});

test("conflicting request and Side Panel URL owners fail before tab access", async () => {
  const calls = [];
  const context = await loadWorkerWithChrome({
    sidePanel: { getOptions: async () => { calls.push("options"); return {}; } },
    tabs: {
      get: async (tabId) => { calls.push(tabId); return { id: tabId, url: "https://chatgpt.com/" }; },
    },
  });
  await assert.rejects(
    () => context.getBoundTab(41, {
      documentId: "panel-1",
      url: "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=52",
    }),
    (error) => error.tidyCode === "TAB_UNAVAILABLE",
  );
  assert.deepEqual(calls, []);
});

test("Chrome panel options must still name the same owner", async () => {
  const calls = [];
  const context = await loadWorkerWithChrome({
    sidePanel: {
      getOptions: async () => ({ enabled: true, path: "app/sidepanel/index.html?tidyTabId=99" }),
    },
    tabs: {
      get: async (tabId) => { calls.push(tabId); return { id: tabId, url: "https://chatgpt.com/" }; },
    },
  });
  await assert.rejects(
    () => context.getBoundTab(41, {
      url: "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=41",
    }),
    (error) => error.tidyCode === "TAB_UNAVAILABLE" && error.stage === "service-worker.resolve-panel-options",
  );
  assert.deepEqual(calls, []);
});

test("a Side Panel URL without a strict owner fails before Chrome APIs", async () => {
  const calls = [];
  const context = await loadWorkerWithChrome({
    sidePanel: { getOptions: async () => { calls.push("options"); return {}; } },
    tabs: {
      get: async (tabId) => { calls.push(tabId); return { id: tabId, url: "https://chatgpt.com/" }; },
    },
  });
  await assert.rejects(
    () => context.getBoundTab(41, { url: "chrome-extension://tidy-test/app/sidepanel/index.html" }),
    (error) => error.tidyCode === "TAB_UNAVAILABLE",
  );
  assert.deepEqual(calls, []);
});

test("search bridge failures render as errors instead of zero-result states", async () => {
  const view = fs.readFileSync(path.join(root, "src/features/search/ui/search-presentation.js"), "utf8");
  const strings = fs.readFileSync(path.join(root, "src/messages/i18n.js"), "utf8");
  // Drive the real controller through public intents and its debounce boundary.
  for (const [error, expected] of [
    [{ code: "ADAPTER_UNAVAILABLE", details: { stage: "page-session", disconnect: "context-invalidated", retryable: false } },
      { code: "ADAPTER_UNAVAILABLE", stage: "page-session", disconnect: "context-invalidated", status: null, retryable: false }],
    [{ code: "SEARCH_UNAVAILABLE", details: { stage: "adapter.search", status: 503, retryable: true } },
      { code: "SEARCH_UNAVAILABLE", stage: "adapter.search", disconnect: null, status: 503, retryable: true }],
    [{ code: "CANCELLED" }, false],
  ]) {
    const timers = new Map();
    let timerId = 0;
    let renders = 0;
    let queries = 0;
    const context = vm.createContext({ structuredClone, queueMicrotask,
      setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
      clearTimeout: id => timers.delete(id),
    });
    const loader = createWorkerModuleLoader(context);
    loader.load("src/features/search/model/search.js");
    loader.load("src/platform/catalog/date-search.js");
    loader.load("src/platform/library/library-hydration.js");
    const { createSearchQueryController } = loader.load("src/features/search/ui/search-query-controller.js");
    const controller = createSearchQueryController({
      onAction: async action => { if (action === "query") { queries += 1; throw error; } },
      onChange: () => { renders += 1; },
    });
    controller.setActive(true);
    controller.changeMode("date");
    controller.changeDateRange({ startDate: "2024-01-01", endDate: "2024-01-02" });
    const scheduled = [...timers].filter(([, timer]) => timer.delay === 0);
    assert.equal(scheduled.length, 1, "the real controller schedules one first-page read");
    const beforeRead = renders;
    for (const [id, timer] of scheduled) { timers.delete(id); timer.callback(); }
    await new Promise(setImmediate);
    const state = controller.snapshot();
    assert.equal(queries, 1, "the production first-page query handler ran");
    assert.ok(renders > beforeRead, "the resolved failure state is published to the view");
    assert.deepEqual(JSON.parse(JSON.stringify(state.error)), expected,
      "real failures retain the complete recovery DTO; cancellation is not a failure");
    assert.equal(state.loading, false);
    assert.ok(renders > 0, "the resolved failure state is rendered");
  }
  assert.match(view, /label\.textContent = t\(presentation\.messageKey\)/);
  assert.match(view, /empty\.hidden = true/); // 已有错误提示时不再伪装成零结果。
  // The cumulative keyword count stays visible on failure; a separate alert
  // exposes the diagnostic and retry rather than disguising it as zero hits.
  assert.match(view, /notice\.className = "search-keyword-error";\s*notice\.role = "alert";\s*notice\.dataset\.searchErrorCode = error\.code/);
  assert.match(view, /retry\.dataset\.searchKeywordRetry/);
  assert.match(view, /count\.textContent = t\("searchKeywordResultCount"/);
  assert.match(view, /searchFailure\(error, "searchKeywordIncomplete"\)/);
  // Assert translated values, not the generated dictionary source formatting.
  const messages = vm.createContext({});
  vm.runInContext(strings.replace(/^export /gm, "") + "\nthis.messages = STRINGS;", messages);
  assert.equal(messages.messages["zh-CN"].searchKeywordIncomplete, "搜索未完成");
  assert.equal(messages.messages["zh-CN"].searchKeywordRetry, "重试");
  assert.doesNotMatch(strings, /搜索接口|backend|main-world/);
});

test("search view exposes independent keyword and conversation-date modes", () => {
  const view = fs.readFileSync(path.join(root, "src/features/search/ui/search-view.js"), "utf8");
  const presentation = fs.readFileSync(path.join(root, "src/features/search/ui/search-presentation.js"), "utf8");
  const controller = fs.readFileSync(path.join(root, "src/features/search/ui/search-query-controller.js"), "utf8");
  const calendar = fs.readFileSync(path.join(root, "src/features/search/ui/search-calendar.js"), "utf8");
  const css = readPanelCss();
  const strings = fs.readFileSync(path.join(root, "src/messages/i18n.js"), "utf8");
  assert.match(presentation, /input\.type = "search"/);
  assert.doesNotMatch(presentation, /input\.type\s*=\s*"date"|type=["']date["']/);
  assert.match(calendar, /dataset\.searchDate = target/);
  assert.match(view, /createSearchCalendar\(/);
  assert.match(controller, /dateContract\.searchDateRange/);
  assert.match(css, /\.search-date-range/);
  assert.match(css, /\.search-calendar-layer/);
  assert.match(strings, /createdTime:\s*"创建时间"/);
  assert.match(strings, /updatedTime:\s*"更新时间"/);
  assert.match(presentation, /t\(field === "createdAt" \? "createdTime" : "updatedTime"\)/);
  assert.doesNotMatch(presentation, /searchConversationCreated|searchConversationUpdated/);
  assert.match(presentation, /dataset\.searchMode/);
  for (const owner of [view, presentation, controller]) assert.doesNotMatch(owner, /searchCombinedHelper|enrichKeywordPage/);
});

test("active context never performs account-local persistence on the snapshot critical path", async () => {
  const storageCalls = [];
  const forbiddenStorage = () => {
    storageCalls.push("storage");
    return new Promise(() => {});
  };
  const context = vm.createContext({ URL, URLSearchParams, chrome: {
    storage: {
      local: { get: forbiddenStorage, set: forbiddenStorage },
      sync: { get: forbiddenStorage, set: forbiddenStorage },
    },
  } });
  const loader = createWorkerModuleLoader(context);
  const { createPreferencesHandler } = loader.load("src/app/background/handlers/preferences.js");
  const tab = { id: 73, windowId: 8, title: "ChatGPT", url: "https://chatgpt.com/" };
  const sender = { documentId: "panel-73" };
  const calls = [];
  const handler = createPreferencesHandler({
    binding: { getBoundTab: async (tabId, owner) => {
      calls.push(["binding", tabId, owner]);
      return tab;
    } },
    pageGateway: { snapshot: async target => {
      calls.push(["snapshot", target]);
      return { snapshot: { schemaVersion: "tidy.snapshot.v1" } };
    } },
    panelHost: { takeRoute: (tabId, owner) => { calls.push(["route", tabId, owner]); return null; } },
  });
  const result = await Promise.race([
    handler.handle({ envelope: context.TidyProtocol.request(context.TidyProtocol.Type.GET_ACTIVE_CONTEXT,
      { expectedTabId: 73 }), sender }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("context response waited for storage")), 50)),
  ]);
  assert.deepEqual(storageCalls, [], "a DOM snapshot cannot authorize account-local metadata changes");
  assert.equal(result.tab.id, 73);
  assert.deepEqual(calls, [["binding", 73, sender], ["snapshot", tab], ["route", 73, sender]]);
});

test("search handler dispatches validated requests through its exact-tab gateway", async () => {
  const calls = [];
  const context = vm.createContext({ URL, URLSearchParams });
  const loader = createWorkerModuleLoader(context);
  const { createRequestBinding } = loader.load("src/platform/session/background/request-binding.js");
  const { createPageGateway } = loader.load("src/platform/session/background/page-gateway.js");
  const { createSearchGateway } = loader.load("src/app/background/adapters/search-gateway.js");
  const { createSearchHandler } = loader.load("src/app/background/handlers/search.js");
  const protocol = context.TidyProtocol;
  const page = loadSearch().TidyChatgptSearch.normalizeResponse(rawResponse(), "OpenPencil");
  const chrome = {
    runtime: { getURL: value => "chrome-extension://tidy-test/" + value.replace(/^\//, "") },
    sidePanel: { getOptions: async ({ tabId }) => ({ enabled: true, path: "app/sidepanel/index.html?tidyTabId=" + tabId }) },
    tabs: {
      query: () => { throw new Error("Search must never query the focused tab"); },
      get: async tabId => { calls.push(["get", tabId]); return { id: tabId, url: "https://chatgpt.com/c/conversation-1" }; },
      sendMessage: async (tabId, envelope) => {
        calls.push(["send", tabId, envelope.type, JSON.parse(JSON.stringify(envelope.payload))]);
        return protocol.response(envelope, page);
      },
    },
  };
  const binding = createRequestBinding({ chrome, libraryIdentity: {
    readAccount: () => { throw new Error("Keyword search must not read library identity"); },
  } });
  const handler = createSearchHandler({ search: createSearchGateway({ binding, pageGateway: createPageGateway({ chrome }) }) });
  const sender = { url: "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=41" };
  const request = { query: "OpenPencil", limit: 7, sessionId: "synthetic-search", cursor: null, expectedTabId: 41 };
  assert.equal(await handler.handle({ envelope: protocol.request(protocol.Type.SEARCH_MESSAGES, request), sender }), page);
  assert.deepEqual(calls, [["get", 41], ["send", 41, protocol.Type.SEARCH_MESSAGES,
    { query: "OpenPencil", limit: 7, sessionId: "synthetic-search", cursor: null }]]);
  await assert.rejects(() => handler.handle({ envelope: protocol.request(protocol.Type.SEARCH_MESSAGES,
    { ...request, limit: 61 }), sender }), error => error.tidyCode === "INVALID_REQUEST");
  assert.equal(calls.length, 2, "invalid requests fail before any tab or transport access");
});

test("search actions carry the immutable panel owner and exact target without a title hint", async () => {
  const context = vm.createContext({ URL });
  const loader = createWorkerModuleLoader(context);
  loader.load("src/platform/protocol.js");
  const { createSearchActions } = loader.load("src/app/sidepanel/search-actions.js");
  const protocol = context.TidyProtocol;
  const requests = [];
  const targets = [];
  const actions = createSearchActions({ ownerTabId: 41, protocol, isReady: () => true,
    request: async (type, payload) => { requests.push([type, JSON.parse(JSON.stringify(payload))]); return {}; },
    dateSearch: { pause: async () => {} }, pauseTitleCatalog: async () => {},
    navigation: { setTarget: (id, target) => { targets.push([id, target]); return true; } },
    notice: { beginSearchNotice() {} },
  });
  await actions.handle("query", { mode: "keyword", query: "OpenPencil", cursor: null,
    sessionId: "synthetic-search", limit: 7, expectedTabId: 99 });
  await actions.handle("open", { navigationIntentId: "search-intent", resultId: "result-1",
    conversationId: "conversation-1", messageId: "message-7", query: "OpenPencil",
    title: "Do not navigate by title", expectedTabId: 99 });
  assert.deepEqual(requests, [
    [protocol.Type.SEARCH_MESSAGES, { query: "OpenPencil", cursor: null, sessionId: "synthetic-search", limit: 7, expectedTabId: 41 }],
    [protocol.Type.SEARCH_OPEN_RESULT, { navigationIntentId: "search-intent", resultId: "result-1",
      conversationId: "conversation-1", messageId: "message-7", query: "OpenPencil", expectedTabId: 41 }],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(targets)), [["search-intent", { conversationId: "conversation-1", messageId: "message-7" }]]);
});
