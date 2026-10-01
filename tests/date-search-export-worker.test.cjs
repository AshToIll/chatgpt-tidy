const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { installPageSession } = require('./helpers/page-session.cjs');
const { exportMessages, translator } = require('./helpers/export-i18n.cjs');

const root = path.resolve(__dirname, "..");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const panelSender = { url: "chrome-extension://tidy-test/app/sidepanel/index.html?tidyTabId=31" };

function exportDocument(contract, id, title) {
  return {
    schemaVersion: contract.VERSION,
    conversation: {
      id, title, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z",
      resources: [],
      messages: [{
        id: `${id}-message`, messageNumber: 1, role: "user", timestamp: null,
        segments: [{ type: "content", sourceMessageId: `${id}-message`, timestamp: null,
          blocks: [{ type: "paragraph", text: "Full conversation content" }] }],
      }],
    },
    warnings: [],
  };
}

function loadWorker(options = {}) {
  const calls = [];
  let receiveRuntime;
  let context;
  const event = () => ({ addListener() {} });
  const sessionData = {};
  const sessionStorage = { get: async key => structuredClone({ [key]: sessionData[key] }),
    set: async values => Object.assign(sessionData, structuredClone(values)) };
  const chrome = {
    runtime: {
      getURL: (value = "") => `chrome-extension://tidy-test/${String(value).replace(/^\//, "")}`,
      onInstalled: event(), onStartup: event(), onConnect: event(),
      onMessage: { addListener(listener) { receiveRuntime = listener; } },
    },
    sidePanel: {
      setPanelBehavior: async () => {},
      getOptions: async ({ tabId }) => options.panelOptions || {
        enabled: true, path: `app/sidepanel/index.html?tidyTabId=${tabId}`,
      },
    },
    tabs: {
      get: async (id) => {
        calls.push({ type: "tab", id });
        if (options.tabError) throw options.tabError;
        return { id, url: options.tabUrl || "https://chatgpt.com/c/current", windowId: 9 };
      },
      sendMessage: async (tabId, envelope) => {
        const protocol = context.TidyProtocol;
        if (envelope.type === protocol.Type.PAGE_SESSION_PROBE) return protocol.response(envelope, { ready: true });
        calls.push({ type: envelope.type, tabId, payload: plain(envelope.payload) });
        if (envelope.type === protocol.Type.LIBRARY_ACCOUNT) {
          return protocol.response(envelope, { accountKey: options.libraryAccountKey || "account-a", epoch: 1 });
        }
        if (envelope.type === protocol.Type.DATE_INDEX_ACCOUNT) {
          const result = protocol.response(envelope, options.accountResponse || {
            schemaVersion: context.TidyDateSearch.VERSION, accountKey: options.accountKey || "account-a",
          });
          if (options.accountRequestIdMismatch) result.requestId = "wrong-account-request";
          if (options.accountTypeMismatch) result.type = protocol.Type.DATE_INDEX_SOURCE_PAGE;
          return result;
        }
        assert.equal(envelope.type, protocol.Type.EXPORT_CONVERSATIONS, "selection cannot trigger directory/message scanning");
        if (options.exportConversations) return protocol.response(envelope, await options.exportConversations(envelope.payload));
        const ids = options.returnedIds || envelope.payload.conversationIds;
        return protocol.response(envelope, {
          schemaVersion: context.TidyExportContract.COLLECTION_VERSION,
          documents: ids.map((id) => exportDocument(context.TidyExportContract, id, envelope.payload.fallbackTitles[id] ?? "")),
        });
      },
      onUpdated: event(), onActivated: event(), onRemoved: event(),
    },
    webNavigation: { onHistoryStateUpdated: event(), onCommitted: event(),
      getFrame: async () => ({ documentId: "document-a", documentLifecycle: "active", url: "https://chatgpt.com/c/shared" }) },
    storage: { onChanged: event(), session: sessionStorage },
  };
  context = vm.createContext({
    console, URL, URLSearchParams, chrome,
    // 此 fixture 只验证会话导出边界；工具栏主题有独立的完整运行测试。
    TOOLBAR_THEME_CHANNEL: 'tidy.toolbar-theme.v1',
    createToolbarTheme: () => ({ start: async () => {}, acceptReport: async () => false }),
    // Export setup may load navigation code, but may not allocate its epoch.
    createNavigationEpochAllocator: () => async () => { throw new Error("This non-navigation test must not allocate a navigation epoch"); },
    createFavoriteFilingContextRegistry: () => ({}),
    createBookmarkFilingContextRegistry: () => ({}),
    createConversationCatalogRepository: () => ({ getSnapshot: async (accountKey) => {
      calls.push({ type: "catalog", accountKey });
      if (options.catalogError) throw options.catalogError;
      return options.catalogs?.[accountKey] || options.catalog || {
        rows: [{ conversationId: "search-a", title: "Directory title" }], state: { accountKey },
      };
    } }),
    favoritesRepository: { get: async (accountKey) => {
      assert.equal(accountKey, options.libraryAccountKey || "account-a");
      calls.push({ type: "favorites", accountKey });
      return { ...(options.favorites || { items: {} }), accountKey };
    } },
    bookmarksRepository: { get: async (accountKey) => {
      assert.equal(accountKey, options.libraryAccountKey || "account-a");
      calls.push({ type: "bookmarks", accountKey });
      return { ...(options.bookmarks || { items: {} }), accountKey };
    } },
  });
  const contractModules = require("./helpers/worker-runtime.cjs").createWorkerModuleLoader(context);
  for (const file of ["src/platform/storage/schema.js", "src/platform/storage/database.js", "src/platform/protocol.js", "src/platform/navigation/navigation-identity.js", "src/platform/catalog/date-search.js", "src/features/export/model/export.js",
    "src/features/search/model/search.js", "src/platform/snapshot.js", "src/platform/navigation/panel-owner.js", "src/platform/context-guard.js"]) {
    Object.assign(context, contractModules.load(file));
  }
  require("./helpers/worker-navigation.cjs").loadWorkerNavigation(context, source);
  // Load the real production module graph. Only existing host/storage seams are injected.
  const workerModules = require("./helpers/worker-runtime.cjs").createWorkerModuleLoader(context, { read: source, imports: {
    ...context,
    createWorkerNavigation: options => {
      const owner = context.createWorkerNavigation({ searchContract: context.TidySearch, ...options });
      context.navigation = owner;
      return owner;
    },
  } });
  context.pageSessionRequestPolicy = workerModules.load("src/platform/session/background/page-session.js").pageSessionRequestPolicy;
  workerModules.load("src/app/background/service-worker.js");
  const request = (payload, sender = panelSender) => new Promise((resolve) => {
    const envelope = context.TidyProtocol.request(context.TidyProtocol.Type.EXPORT_CONVERSATIONS, payload);
    assert.equal(receiveRuntime(envelope, sender, (response) => {
      assert.equal(context.TidyProtocol.isResponse(response, envelope.requestId), true);
      resolve(response);
    }), true);
  });
  return { calls, request };
}

function selectionPayload(overrides = {}) {
  return {
    expectedTabId: 31, expectedAccountKey: "account-a", conversationIds: ["search-a"], bookmarkIds: [],
    searchSelection: { accountKey: "account-a", conversationIds: ["search-a"] },
    ...overrides,
  };
}

// Library identity is a separate mandatory boundary for ALL exports. These
// assertions count only catalog/export work, with identity checked separately.
const adapterCalls = (calls) => calls.filter((call) => call.type.includes(".") && call.type !== "library.account");
const libraryAccountCalls = (calls) => calls.filter((call) => call.type === "library.account");
const batchCalls = (calls) => calls.filter((call) => call.type === "export.conversations");

test("date search export verifies bound account and catalog before the existing full-conversation batch", async () => {
  const { calls, request } = loadWorker();
  const result = await request(selectionPayload({ fallbackTitles: { "search-a": "Untrusted panel title" } }));
  assert.equal(result.ok, true);
  assert.equal(result.payload.documents[0].conversation.title, "Directory title");
  assert.equal(libraryAccountCalls(calls).length, 1, "one document bootstrap; final checks use the local identity epoch");
  assert.deepEqual(adapterCalls(calls).map((call) => call.type), ["date-index.account", "export.conversations"]);
  assert.deepEqual(calls.filter((call) => call.type === "catalog"), [{ type: "catalog", accountKey: "account-a" }]);
  assert.ok(calls.filter((call) => call.type === "tab").every((call) => call.id === 31));
  assert.deepEqual(batchCalls(calls)[0], {
    type: "export.conversations", tabId: 31,
    payload: { conversationIds: ["search-a"], fallbackTitles: { "search-a": "Directory title" } },
  });
});

test("mixed saved and date search selections preserve source authorization and authoritative search titles", async () => {
  const { calls, request } = loadWorker({
    favorites: { items: { "saved-a": { title: "Favorite title" }, "search-a": { title: "Old favorite title" } } },
    bookmarks: { items: { "bookmark-b": { conversationId: "bookmarked-b", conversationTitle: "Bookmark title" } } },
  });
  const result = await request(selectionPayload({
    conversationIds: ["saved-a", "search-a", "bookmarked-b"], bookmarkIds: ["bookmark-b"],
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(batchCalls(calls)[0].payload.fallbackTitles, {
    "saved-a": "Favorite title", "search-a": "Directory title", "bookmarked-b": "Bookmark title",
  });
});

test('worker to adapter to export plan localizes absent titles and preserves real titles that match the old fallback', async () => {
  const ids = ['empty-favorite', 'empty-bookmark', 'empty-search', 'named-favorite', 'named-api'];
  const payloads = Object.fromEntries(ids.map(id => [id, {
    id, title: id === 'named-api' ? '未命名会话' : '', current_node: 'message',
    mapping: { message: { id: 'message', parent: null, message: {
      id: `${id}-message`, author: { role: 'user' }, content: { content_type: 'text', parts: ['Original body'] },
    } } },
  }]));
  // 使用正式 adapter 和计划器，而不是在 worker 的消息桩中手工补写默认标题。
  const runtime = vm.createContext({ URL, Headers, TextEncoder, TextDecoder,
    location: { href: 'https://chatgpt.com/c/current', origin: 'https://chatgpt.com' },
    fetch: async url => ({ ok: true, status: 200, json: async () => url === '/api/auth/session'
      ? { accessToken: 'fixture-token', user: { id: 'fixture-user' } }
      : payloads[decodeURIComponent(String(url).split('/').pop())] }),
  });
  for (const file of ['src/features/export/model/export.js', 'src/platform/snapshot.js', 'src/platform/chatgpt/route.js']) {
    vm.runInContext(source(file), runtime, { filename: file });
  }
  installPageSession(runtime);
  for (const file of ['src/platform/chatgpt/api.js', 'src/features/export/chatgpt/export.js',
    'src/features/export/engine/i18n.js', 'src/features/export/engine/normalize.js', 'src/features/export/engine/plan.js', 'src/features/export/engine/inline-content.js', 'src/features/export/engine/serializers.js']) {
    require("./helpers/main-runtime.cjs").loadMainModuleDependencies(runtime, file);
  }
  const { calls, request } = loadWorker({
    favorites: { items: { 'empty-favorite': { title: null }, 'named-favorite': { title: '未命名会话' }, 'named-api': { title: '' } } },
    bookmarks: { items: { bookmark: { conversationId: 'empty-bookmark', conversationTitle: null } } },
    catalog: { rows: [{ conversationId: 'empty-search', title: '' }], state: { accountKey: 'account-a' } },
    exportConversations: payload => runtime.TidyChatgptExport.readConversations(payload),
  });
  const result = await request(selectionPayload({ conversationIds: ids, bookmarkIds: ['bookmark'],
    searchSelection: { accountKey: 'account-a', conversationIds: ['empty-search'] },
    fallbackTitles: Object.fromEntries(ids.map(id => [id, 'Untrusted panel title'])),
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(batchCalls(calls)[0].payload.fallbackTitles, {
    'empty-favorite': '', 'empty-bookmark': '', 'empty-search': '', 'named-favorite': '未命名会话', 'named-api': '',
  });
  const conversations = result.payload.documents.map(document => document.conversation);
  assert.deepEqual(Array.from(conversations, conversation => conversation.title), ['', '', '', '未命名会话', '未命名会话']);
  const api = runtime.TidyExport;
  for (const language of ['en', 'ja', 'zh-TW', 'zh-CN']) {
    const messages = exportMessages(language), t = translator(language);
    const plan = api.buildExportPlan({ messages, mode: 'batch', format: 'markdown', conversationIds: ids,
      data: api.normalizeExportData({ conversations, bookmarks: [] }) });
    const nameCounts = new Map();
    for (const file of plan.files) {
      const expected = file.conversations[0].id.startsWith('empty-') ? t('untitled') : '未命名会话';
      const count = (nameCounts.get(expected) || 0) + 1;
      nameCounts.set(expected, count);
      assert.equal(file.conversations[0].title, expected);
      assert.equal(file.baseName, `${expected}${count > 1 ? ` (${count})` : ''}`);
      assert.equal(api.serializeTextFile(file, 'markdown', { messages }).split('\n')[0], `# ${expected}`);
    }
  }
  assert.equal(conversations[0].title, '', 'each language default belongs to its plan, never the source document');
});

test("saved-only batch export verifies its library owner without directory account or catalog reads", async () => {
  const { calls, request } = loadWorker({ favorites: { items: { "saved-a": { title: "Favorite title" } } } });
  const result = await request({ expectedTabId: 31, expectedAccountKey: "account-a", conversationIds: ["saved-a"], bookmarkIds: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(adapterCalls(calls).map((call) => call.type), ["export.conversations"]);
  assert.equal(calls.some((call) => call.type === "catalog"), false);
  assert.equal(libraryAccountCalls(calls).length, 1);
});

test("catalog membership alone cannot bypass an explicit date search selection", async () => {
  const { calls, request } = loadWorker();
  const result = await request({ expectedTabId: 31, expectedAccountKey: "account-a", conversationIds: ["search-a"] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "NOT_FOUND");
  assert.equal(adapterCalls(calls).length, 0);
  assert.equal(calls.some((call) => call.type === "catalog"), false);
});

test("malformed, empty, oversized and non-subset search selections fail before reads", async () => {
  for (const searchSelection of [null, [], {}, "search-a", { conversationIds: ["search-a"] },
    { accountKey: "", conversationIds: ["search-a"] }, { accountKey: " account-a", conversationIds: ["search-a"] },
    { accountKey: "account-a", conversationIds: [] }, { accountKey: "account-a", conversationIds: "search-a" },
    { accountKey: "account-a", conversationIds: ["outside-selection"] },
    { accountKey: "account-a", conversationIds: [" search-a"] },
    { accountKey: "account-a", conversationIds: [""] },
    { accountKey: "account-a", conversationIds: [3] },
    { accountKey: "account-a", conversationIds: Array(101).fill("search-a") }]) {
    const { calls, request } = loadWorker();
    const result = await request(selectionPayload({ searchSelection }));
    assert.equal(result.ok, false, JSON.stringify(searchSelection));
    assert.equal(result.error.code, "INVALID_REQUEST", JSON.stringify(searchSelection));
    assert.deepEqual(calls, []);
  }
});

test("duplicate valid search identifiers produce one authorized batch conversation", async () => {
  const { calls, request } = loadWorker();
  const result = await request(selectionPayload({
    conversationIds: ["search-a", "search-a"],
    searchSelection: { accountKey: "account-a", conversationIds: ["search-a", "search-a"] },
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(batchCalls(calls)[0].payload.conversationIds, ["search-a"]);
});

test("date selections revalidate current account even when the conversation is also favorited", async () => {
  const { calls, request } = loadWorker({
    accountKey: "account-b", favorites: { items: { "search-a": { title: "Saved on another account" } } },
  });
  const result = await request(selectionPayload());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CONTEXT_MISMATCH");
  assert.equal(calls.some((call) => call.type === "catalog"), false);
  assert.equal(batchCalls(calls).length, 0);
});

test("unknown and malformed catalog rows cannot authorize date search exports", async () => {
  for (const rows of [[], [null], [{ conversationId: "other", title: "Other" }],
    [{ conversationId: "search-a" }], [{ conversationId: "search-a", title: 42 }],
    [{ conversationId: "search-a", title: "Other account row", accountKey: "account-b" }]]) {
    const { calls, request } = loadWorker({ catalog: { rows, state: { accountKey: "account-a" } } });
    const result = await request(selectionPayload());
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "NOT_FOUND");
    assert.equal(batchCalls(calls).length, 0);
  }
});

test("a second account's registered conversation cannot be looked up for the active account", async () => {
  const { calls, request } = loadWorker({ catalogs: {
    "account-a": { rows: [], state: { accountKey: "account-a" } },
    "account-b": { rows: [{ conversationId: "search-a", title: "Private B" }], state: { accountKey: "account-b" } },
  } });
  const result = await request(selectionPayload());
  assert.equal(result.error.code, "NOT_FOUND");
  assert.deepEqual(calls.filter((call) => call.type === "catalog"), [{ type: "catalog", accountKey: "account-a" }]);
  assert.equal(batchCalls(calls).length, 0);
});

test("catalog shape and account-state mismatches fail closed", async () => {
  for (const catalog of [{ rows: null }, { rows: [], state: { accountKey: "account-b" } }]) {
    const { calls, request } = loadWorker({ catalog });
    const result = await request(selectionPayload());
    assert.equal(result.error.code, "EXPORT_UNAVAILABLE");
    assert.equal(batchCalls(calls).length, 0);
  }
});

test("an unknown extra conversation cannot piggyback on a valid date search subset", async () => {
  const { calls, request } = loadWorker();
  const result = await request(selectionPayload({ conversationIds: ["search-a", "arbitrary-other"] }));
  assert.equal(result.error.code, "NOT_FOUND");
  assert.equal(batchCalls(calls).length, 0);
});

test("search batch validates the exact Side Panel tab owner before account reads", async () => {
  const { calls, request } = loadWorker();
  const result = await request(selectionPayload({ expectedTabId: 32 }));
  assert.equal(result.error.code, "TAB_UNAVAILABLE");
  assert.deepEqual(calls, []);
});

test("disabled or rebound Side Panels cannot authorize date selections", async () => {
  for (const panelOptions of [{ enabled: false, path: "app/sidepanel/index.html?tidyTabId=31" },
    { enabled: true, path: "app/sidepanel/index.html?tidyTabId=32" }]) {
    const { calls, request } = loadWorker({ panelOptions });
    const result = await request(selectionPayload());
    assert.equal(result.error.code, "TAB_UNAVAILABLE");
    assert.deepEqual(calls, []);
  }
});

test("closed bound tabs fail before account or catalog reads", async () => {
  const { calls, request } = loadWorker({ tabError: new Error("No tab with id 31") });
  const result = await request(selectionPayload());
  assert.equal(result.error.code, "TAB_UNAVAILABLE");
  assert.equal(adapterCalls(calls).length, 0);
  assert.equal(calls.some((call) => call.type === "catalog"), false);
});

test("catalog read failures never fall back to trusting panel-supplied conversation IDs", async () => {
  const { calls, request } = loadWorker({ catalogError: Object.assign(new Error("Catalog read failed"), {
    tidyCode: "STORAGE_ERROR",
  }) });
  const result = await request(selectionPayload());
  assert.equal(result.error.code, "STORAGE_ERROR");
  assert.equal(batchCalls(calls).length, 0);
});

test("account response schema, request identity and operation type are checked before catalog access", async () => {
  for (const options of [{ accountResponse: { schemaVersion: "wrong", accountKey: "account-a" } },
    { accountRequestIdMismatch: true }, { accountTypeMismatch: true }]) {
    const { calls, request } = loadWorker(options);
    const result = await request(selectionPayload());
    assert.equal(result.error.code, "DATE_INDEX_UNAVAILABLE");
    assert.equal(calls.some((call) => call.type === "catalog"), false);
    assert.equal(batchCalls(calls).length, 0);
  }
});

test("validated date selections retain the batch response conversation-set identity guard", async () => {
  const { request } = loadWorker({ returnedIds: ["different-conversation"] });
  const result = await request(selectionPayload());
  assert.equal(result.error.code, "CONTEXT_MISMATCH");
});

test("valid date rows with no title remain language-neutral at the worker boundary", async () => {
  const { calls, request } = loadWorker({ catalog: { rows: [{ conversationId: "search-a", title: "" }], state: null } });
  const result = await request(selectionPayload());
  assert.equal(result.ok, true);
  assert.equal(batchCalls(calls)[0].payload.fallbackTitles['search-a'], '');
  assert.equal(result.payload.documents[0].conversation.title, '');
});
