const assert = require("node:assert/strict");
const { installPageSession } = require('./helpers/page-session.cjs');
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function runClassic(context, relativePath) {
  vm.runInContext(
    fs.readFileSync(path.join(root, relativePath), "utf8"),
    context,
    { filename: relativePath },
  );
}

function conversationPayload(id, title = id) {
  return {
    id,
    title,
    create_time: 1_700_000_000,
    update_time: 1_700_000_100,
    current_node: "assistant",
    mapping: {
      root: {
        id: "root",
        parent: null,
        message: { id: `${id}-system`, author: { role: "system" }, content: { parts: ["system"] } },
      },
      user: {
        id: "user",
        parent: "root",
        message: {
          id: `${id}-user`,
          author: { role: "user" },
          create_time: 1_700_000_001,
          content: { content_type: "text", parts: [`Question for ${id}`] },
        },
      },
      assistant: {
        id: "assistant",
        parent: "user",
        message: {
          id: `${id}-assistant`,
          author: { role: "assistant" },
          create_time: 1_700_000_002,
          content: { content_type: "text", parts: [`Answer for ${id}`] },
        },
      },
    },
  };
}

function createAdapter(payloadById) {
  const calls = [];
  const context = vm.createContext({
    URL,
    Date,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    JSON,
    Headers,
    Set,
    RegExp,
    TextEncoder,
    TextDecoder,
    encodeURIComponent,
    location: { href: "https://chatgpt.com/c/current", origin: "https://chatgpt.com" },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url === "/api/auth/session") {
        return { ok: true, status: 200, json: async () => ({ accessToken: "batch-token", user: { id: "test-user" } }) };
      }
      const id = decodeURIComponent(String(url).split("/").pop());
      const payload = payloadById[id];
      return payload
        ? { ok: true, status: 200, json: async () => payload }
        : { ok: false, status: 404, json: async () => ({}) };
    },
  });
  context.globalThis = context;
  runClassic(context, "src/features/export/model/export.js");
  runClassic(context, "src/platform/snapshot.js");
  runClassic(context, "src/features/export/model/export-preview.js");
  runClassic(context, "src/platform/chatgpt/route.js");
  installPageSession(context);
  runClassic(context, "src/platform/chatgpt/api.js");
  // The page bootstrap supplies one shared native-message projection to export.
  for (const module of ['active-branch', 'native-message-references', 'native-message-content', 'native-message-process', 'conversation-projection']) {
    runClassic(context, 'src/platform/chatgpt/' + module + '.js');
  }
  runClassic(context, "src/features/export/chatgpt/export.js");
  return { context, calls };
}

test("batch adapter reads a de-duplicated collection and fails on response identity drift", async () => {
  const payloads = {
    "conversation-a": conversationPayload("conversation-a", "A"),
    "conversation-b": conversationPayload("conversation-b", "B"),
  };
  const { context, calls } = createAdapter(payloads);
  const collection = await context.TidyChatgptExport.readConversations({
    conversationIds: ["conversation-a", "conversation-b", "conversation-a"],
    fallbackTitles: { "conversation-a": "fallback A" },
  });

  assert.equal(collection.schemaVersion, context.TidyExportContract.COLLECTION_VERSION);
  assert.deepEqual(
    Array.from(collection.documents, (document) => document.conversation.id),
    ["conversation-a", "conversation-b"],
  );
  assert.deepEqual(
    Array.from(calls.filter((call) => call.url.startsWith("/backend-api/conversation/")), (call) => call.url),
    ["/backend-api/conversation/conversation-a", "/backend-api/conversation/conversation-b"],
  );
  assert.equal(context.TidyExportContract.validateCollection(collection).valid, true);

  const mismatch = createAdapter({
    "conversation-a": conversationPayload("conversation-other", "Wrong"),
  });
  await assert.rejects(
    mismatch.context.TidyChatgptExport.readConversations({ conversationIds: ["conversation-a"] }),
    /identity changed/,
  );
});

function loadExportView() {
  const context = vm.createContext({
    setTimeout, clearTimeout,
    URL,
    Date,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    JSON,
    Map,
    Set,
    Promise,
    TextEncoder,
    TextDecoder,
    document: { activeElement: null },
    renderListMarkup: (root, markup) => { root.innerHTML = markup; }, // State/IPC fixture; real DOM is checked in Chromium.
    window: { addEventListener() {} },
    crypto: { randomUUID: () => "preview-test" },
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }),
  });
  context.globalThis = context;
  // Mirror the side-panel observation prelude; diagnostics never controls state.
  for (const module of ['build-info', 'notice-registry', 'notice-lifecycle', 'diagnostics']) {
    runClassic(context, 'src/messages/' + module + '.js');
  }
  runClassic(context, "src/features/export/model/export.js");
  runClassic(context, "src/features/export/model/export-preview.js");
  runClassic(context, "src/features/export/engine/i18n.js");
  runClassic(context, "src/features/export/model/export-job.js");
  runClassic(context, "src/features/export/engine/normalize.js");
  runClassic(context, "src/features/export/engine/plan.js");
  runClassic(context, "src/features/export/engine/inline-content.js");
  runClassic(context, "src/features/export/engine/serializers.js");
  context.__exports = require('./helpers/export-runtime.cjs').loadExportModule(context, 'src/features/export/ui/export-view.js');
  context.__selection = require('./helpers/export-runtime.cjs').loadExportModule(context, 'src/features/export/ui/export-selection.js');
  return context;
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function sourceStores() {
  return {
    favorites: {
      accountKey: "library-one",
      revision: 1,
      items: {
        "conversation-a": {
          conversationId: "conversation-a",
          title: "Favorite A",
          createdAt: "2026-08-18T01:00:00.000Z",
          updatedAt: "2026-08-18T02:00:00.000Z",
          routePath: "/c/conversation-a",
        },
      },
      groups: [],
      view: { groupId: "all" },
    },
    bookmarks: {
      accountKey: "library-one",
      revision: 1,
      items: {
        "bookmark-a": {
          bookmarkId: "bookmark-a",
          conversationId: "conversation-a",
          conversationTitle: "Favorite A",
          messageId: "conversation-a-assistant",
          messageTimestamp: "2026-08-18T02:00:00.000Z",
          bookmarkedAt: "2026-08-18T03:00:00.000Z",
          groupId: null,
          excerpt: "Answer for conversation-a",
        },
        "bookmark-b": {
          bookmarkId: "bookmark-b",
          conversationId: "conversation-b",
          conversationTitle: "Bookmark B",
          messageId: "conversation-b-assistant",
          messageTimestamp: "2026-08-18T04:00:00.000Z",
          bookmarkedAt: "2026-08-18T05:00:00.000Z",
          groupId: null,
          excerpt: "Answer for conversation-b",
        },
      },
      groups: [],
      view: { groupId: "all", query: "" },
    },
  };
}

function documentFor(id, title = id) {
  return {
    schemaVersion: "chatgpt-tidy.export-source.v2",
    conversation: {
      id,
      title,
      createdAt: "2026-08-18T01:00:00.000Z",
      updatedAt: "2026-08-18T02:00:00.000Z",
      sourceUrl: `https://chatgpt.com/c/${id}`,
      resources: [],
      messages: [
        {
          id: `${id}-assistant`,
          messageNumber: 1,
          role: "assistant",
          timestamp: "2026-08-18T02:00:00.000Z",
          segments: [{
            type: "content",
            sourceMessageId: `${id}-assistant`,
            timestamp: "2026-08-18T02:00:00.000Z",
            blocks: [{ type: "paragraph", text: `Answer for ${id}` }],
          }],
        },
      ],
    },
    warnings: [],
  };
}

test("export coordinator links Favorites and Bookmarks into one batch request", async () => {
  const context = loadExportView();
  const stores = sourceStores();
  const root = {
    innerHTML: "",
    addEventListener() {},
    querySelector() { return null; },
  };
  let requested = null;
  let resolveRequest;
  const selection = context.__selection.createExportSelection();
  const view = context.__exports.createExportView({
    selection,
    root,
    requestDocument: async () => documentFor("conversation-a", "Favorite A"),
    requestDocuments: (payload) => {
      requested = payload;
      return new Promise((resolve) => { resolveRequest = resolve; });
    },
    presentFullPreview: async () => {},
    dismissFullPreview: async () => {},
    formatTimestamp: (value) => value.slice(0, 10),
  });
  const translate = (key, values = {}) => Object.entries(values).reduce(
    (result, [name, value]) => result.replaceAll(`{${name}}`, String(value)),
    key,
  );

  view.updateContext({
    active: false,
    accountKey: "library-one",
    snapshot: null,
    preferences: { language: "zh-CN" },
    translator: translate,
    favorites: stores.favorites,
    bookmarks: stores.bookmarks,
  });

  assert.equal(selection.beginSelection("favorites", "source"), true);
  selection.toggleSelection("favorites", "conversation-a");
  assert.equal(selection.submitSelection("favorites").added, 1);
  assert.equal(selection.beginSelection("bookmarks", "source"), true);
  selection.toggleSelection("bookmarks", "bookmark-a");
  selection.toggleSelection("bookmarks", "bookmark-b");
  assert.equal(selection.submitSelection("bookmarks").added, 2);

  assert.deepEqual(Array.from(selection.selectionState("favorites").basketConversationIds), ["conversation-a"]);
  assert.deepEqual(Array.from(selection.selectionState("bookmarks").basketBookmarkIds), ["bookmark-a", "bookmark-b"]);

  view.setMode("batch");
  view.updateContext({
    active: true,
    accountKey: "library-one",
    snapshot: null,
    preferences: { language: "zh-CN" },
    translator: translate,
    favorites: stores.favorites,
    bookmarks: stores.bookmarks,
  });
  await flush();
  assert.deepEqual(Array.from(requested.conversationIds), ["conversation-a", "conversation-b"]);
  assert.deepEqual(Array.from(requested.bookmarkIds), ["bookmark-a", "bookmark-b"]);
  assert.equal(Object.hasOwn(requested, "searchSelection"), false);

  resolveRequest({
    schemaVersion: context.TidyExportContract.COLLECTION_VERSION,
    documents: [documentFor("conversation-a", "Fresh A"), documentFor("conversation-b", "Fresh B")],
  });
  await flush();
  await flush();
  assert.match(root.innerHTML, /data-export-mode="batch"/);
  assert.match(root.innerHTML, /Fresh A|Fresh B/);
  view.setSettingsView("manage");
  view.updateContext({
    active: true,
    accountKey: "library-one",
    snapshot: null,
    preferences: { language: "zh-CN" },
    translator: translate,
    favorites: stores.favorites,
    bookmarks: stores.bookmarks,
  });
  assert.match(root.innerHTML, /role="menuitem" data-export-source="search"/);
  assert.doesNotMatch(root.innerHTML, /data-export-source="search"[^>]*disabled/);
  assert.match(root.innerHTML, /data-export-add-toggle[^>]*aria-haspopup="menu"/);
  assert.match(root.innerHTML, /class="export-add-menu"[^>]*role="menu"/);
  assert.match(root.innerHTML, /role="menuitem"[^>]*data-export-source="favorites"/);
  assert.match(root.innerHTML, /export-action-bar__main is-button-only/);
  assert.doesNotMatch(root.innerHTML, /export-action-bar__main is-button-only"><span>/);
});

test("a source revision cancels a stale batch read and reloads the live basket", async () => {
  const context = loadExportView();
  const stores = sourceStores();
  const root = {
    innerHTML: "",
    addEventListener() {},
    querySelector() { return null; },
  };
  const requests = [];
  const selection = context.__selection.createExportSelection();
  const view = context.__exports.createExportView({
    selection,
    root,
    requestDocument: async () => documentFor("conversation-a"),
    requestDocuments: (payload) => {
      const request = { payload };
      request.promise = new Promise((resolve, reject) => {
        request.resolve = resolve;
        request.reject = reject;
      });
      requests.push(request);
      return request.promise;
    },
    presentFullPreview: async () => {},
    dismissFullPreview: async () => {},
    formatTimestamp: (value) => value.slice(0, 10),
  });
  const translate = (key, values = {}) => Object.entries(values).reduce(
    (result, [name, value]) => result.replaceAll(`{${name}}`, String(value)),
    key,
  );

  view.updateContext({
    active: false,
    accountKey: "library-one",
    snapshot: null,
    preferences: { language: "zh-CN" },
    translator: translate,
    favorites: stores.favorites,
    bookmarks: stores.bookmarks,
  });
  selection.beginSelection("favorites", "source");
  selection.toggleSelection("favorites", "conversation-a");
  selection.submitSelection("favorites");
  selection.beginSelection("bookmarks", "source");
  selection.toggleSelection("bookmarks", "bookmark-b");
  selection.submitSelection("bookmarks");
  view.setMode("batch");
  view.updateContext({
    active: true,
    accountKey: "library-one",
    snapshot: null,
    preferences: { language: "zh-CN" },
    translator: translate,
    favorites: stores.favorites,
    bookmarks: stores.bookmarks,
  });
  await flush();
  assert.equal(requests.length, 1);

  const nextBookmarks = JSON.parse(JSON.stringify(stores.bookmarks));
  delete nextBookmarks.items["bookmark-b"];
  nextBookmarks.revision = 2;
  view.updateContext({
    active: true,
    accountKey: "library-one",
    snapshot: null,
    preferences: { language: "zh-CN" },
    translator: translate,
    favorites: stores.favorites,
    bookmarks: nextBookmarks,
  });
  await flush();
  assert.equal(requests.length, 2);
  assert.deepEqual(Array.from(requests[1].payload.conversationIds), ["conversation-a"]);
  assert.deepEqual(Array.from(requests[1].payload.bookmarkIds), []);

  requests[1].resolve({
    schemaVersion: context.TidyExportContract.COLLECTION_VERSION,
    documents: [documentFor("conversation-a", "Fresh A")],
  });
  await flush();
  await flush();
  assert.match(root.innerHTML, /Fresh A/);

  // The superseded response is deliberately resolved after the live request;
  // it must not resurrect the removed bookmark conversation or re-lock loading.
  requests[0].resolve({
    schemaVersion: context.TidyExportContract.COLLECTION_VERSION,
    documents: [documentFor("conversation-a", "Stale A"), documentFor("conversation-b", "Stale B")],
  });
  await flush();
  await flush();
  assert.doesNotMatch(root.innerHTML, /Stale B/);
  assert.doesNotMatch(root.innerHTML, /exportBatchReading/);
});

function dateResult(conversationId, overrides = {}) {
  return {
    resultId: `conversation-date:${conversationId}`,
    source: "conversation",
    matchKind: "conversation-date",
    conversationId,
    messageId: null,
    title: `Search ${conversationId}`,
    conversationCreatedAt: "2026-07-12T01:00:00.000Z",
    conversationUpdatedAt: "2026-09-08T02:00:00.000Z",
    accountKey: "account-one",
    ...overrides,
  };
}

function createSearchExportHarness() {
  const context = loadExportView();
  const stores = sourceStores();
  const requests = [];
  const sourceRequests = [];
  const handlers = {};
  const root = {
    innerHTML: "",
    addEventListener(type, handler) { handlers[type] = handler; },
    querySelector() { return null; },
  };
  const selection = context.__selection.createExportSelection();
  const view = context.__exports.createExportView({
    selection,
    root,
    requestDocument: async () => documentFor("conversation-a"),
    requestDocuments: (payload) => new Promise((resolve, reject) => requests.push({ payload, resolve, reject })),
    presentFullPreview: async () => {},
    dismissFullPreview: async () => {},
    formatTimestamp: (value) => value?.slice(0, 10) || "",
    onSourceRequest: (source, target) => sourceRequests.push({ source, target }),
  });
  const model = {
    active: false,
    accountKey: "library-one",
    snapshot: null,
    preferences: { language: "zh-CN" },
    translator: (key) => key,
    favorites: stores.favorites,
    bookmarks: stores.bookmarks,
  };
  const update = (changes = {}) => {
    Object.assign(model, changes);
    view.updateContext(model);
  };
  update();
  return { context, view, selection, root, stores, requests, sourceRequests, handlers, update };
}

test("date export only registers account-bound conversation-date candidates in the active picker", () => {
  const { view, selection } = createSearchExportHarness();
  assert.equal(selection.selectionState("search").accountKey, null);
  assert.equal(selection.registerSearchResults([dateResult("first")]), 0);
  assert.equal(selection.beginSelection("search"), true);
  assert.equal(selection.selectionState("search").accountKey, null);
  assert.equal(selection.toggleSelection("search", "unknown"), false);
  assert.equal(selection.registerSearchResults([
    dateResult("keyword-message", { matchKind: "message", messageId: "message-one" }),
    dateResult("keyword-title", { matchKind: "title" }),
    dateResult("message-date", { messageId: "message-one" }),
    dateResult("missing-account", { accountKey: undefined }),
    dateResult("blank-account", { accountKey: " " }),
    dateResult("bad-timestamp", { conversationCreatedAt: "not-a-date" }),
    dateResult("bad-title", { title: null }),
    dateResult("wrong-source", { source: "image" }),
    dateResult(" padded-id "),
    null,
  ]), 0);
  assert.equal(selection.selectSelectionRange("search", ["keyword-message", "unknown"]), true);
  assert.deepEqual(Array.from(selection.selectionState("search").draftIds), []);
  assert.equal(selection.registerSearchResults([dateResult("first"), dateResult("first")]), 1);
  assert.equal(selection.selectionState("search").accountKey, "account-one");
  assert.equal(selection.selectionState("favorites").accountKey, null);
  assert.equal(selection.toggleSelection("search", "first"), true);
  assert.equal(selection.submitSelection("search").added, 1);
  assert.deepEqual(Array.from(selection.selectionState("search").basketConversationIds), ["first"]);
  assert.equal(selection.selectionState("search").accountKey, null);
});

test("date export draft survives page and criteria registration without accepting another account", () => {
  const { view, selection } = createSearchExportHarness();
  selection.beginSelection("search");
  selection.registerSearchResults([dateResult("first"), dateResult("second")]);
  selection.toggleSelection("search", "first");
  selection.registerSearchResults([dateResult("third")]);
  selection.selectSelectionRange("search", ["third", "unknown", "third"]);
  assert.deepEqual(Array.from(selection.selectionState("search").draftIds), ["first", "third"]);
  selection.selectSelectionRange("search", ["third"]);
  assert.deepEqual(Array.from(selection.selectionState("search").draftIds), ["first"]);
  assert.equal(selection.registerSearchResults([dateResult("fourth", { accountKey: "account-two" })]), 0);
  assert.equal(selection.toggleSelection("search", "fourth"), false);
  assert.equal(selection.toggleSelection("search", "second"), true);
  assert.equal(selection.submitSelection("search").added, 2);
  assert.deepEqual(Array.from(selection.selectionState("search").basketConversationIds), ["first", "second"]);
});

test("leaving a date export picker forgets its candidates but keeps submitted basket metadata", () => {
  const { view, selection, root, update } = createSearchExportHarness();
  selection.beginSelection("search");
  selection.registerSearchResults([dateResult("first"), dateResult("second")]);
  selection.toggleSelection("search", "first");
  selection.submitSelection("search");
  selection.beginSelection("search");
  assert.equal(selection.toggleSelection("search", "second"), false);
  assert.equal(selection.registerSearchResults([dateResult("second", { accountKey: "account-two" })]), 1);
  selection.toggleSelection("search", "second");
  selection.cancelSelection();
  assert.equal(selection.selectionState("search").accountKey, null);
  selection.beginSelection("search");
  assert.equal(selection.toggleSelection("search", "second"), false);
  view.setSettingsView("manage");
  update();
  assert.match(root.innerHTML, /Search first/);
  assert.doesNotMatch(root.innerHTML, /Search second/);
});

test("Favorites and date export merge one conversation and current-page selection is source aware", () => {
  const { view, selection } = createSearchExportHarness();
  selection.beginSelection("favorites");
  selection.toggleSelection("favorites", "conversation-a");
  selection.submitSelection("favorites");
  selection.beginSelection("search");
  selection.registerSearchResults([dateResult("conversation-a"), dateResult("search-only")]);
  selection.selectSelectionRange("search", ["conversation-a", "search-only"]);
  assert.deepEqual(Array.from(selection.selectionState("search").draftIds), ["conversation-a", "search-only"]);
  const result = selection.submitSelection("search");
  assert.equal(result.added, 1);
  assert.equal(result.sourceUpdated, 1);
  assert.equal(selection.basketCount(), 2);
  assert.deepEqual(Array.from(selection.selectionState("search").basketConversationSources["conversation-a"]), ["favorites", "search"]);
  selection.beginSelection("search");
  selection.registerSearchResults([dateResult("conversation-a")]);
  assert.equal(selection.toggleSelection("search", "conversation-a"), false);
  selection.selectSelectionRange("search", ["conversation-a"]);
  assert.deepEqual(Array.from(selection.selectionState("search").draftIds), []);

  const reverse = createSearchExportHarness().selection;
  reverse.beginSelection("search");
  reverse.registerSearchResults([dateResult("conversation-a")]);
  reverse.toggleSelection("search", "conversation-a");
  reverse.submitSelection("search");
  reverse.beginSelection("favorites");
  reverse.selectSelectionRange("favorites", ["conversation-a"]);
  assert.equal(reverse.submitSelection("favorites").sourceUpdated, 1);
  assert.equal(reverse.basketCount(), 1);
});

test("Favorites refresh preserves date drafts and the search source of merged basket entries", () => {
  const { view, selection, stores, root, update } = createSearchExportHarness();
  selection.beginSelection("favorites");
  selection.toggleSelection("favorites", "conversation-a");
  selection.submitSelection("favorites");
  selection.beginSelection("search");
  selection.registerSearchResults([dateResult("conversation-a"), dateResult("draft-only")]);
  selection.toggleSelection("search", "conversation-a");
  selection.submitSelection("search");
  selection.beginSelection("search");
  selection.registerSearchResults([dateResult("draft-only")]);
  selection.toggleSelection("search", "draft-only");
  view.setSettingsView("manage");
  update({ favorites: { ...stores.favorites, revision: 2, items: {} } });
  assert.deepEqual(Array.from(selection.selectionState("search").draftIds), ["draft-only"]);
  assert.deepEqual(Array.from(selection.selectionState("search").basketConversationSources["conversation-a"]), ["search"]);
  assert.match(root.innerHTML, /Search conversation-a/);
  assert.equal(selection.submitSelection("search").added, 1);
  assert.equal(selection.basketCount(), 2);
});

test("date export shows safe fallback metadata immediately and reuses the batch document read", async () => {
  const { context, view, selection, root, requests, update } = createSearchExportHarness();
  selection.beginSelection("search");
  selection.registerSearchResults([dateResult("search-only", { title: "<script>date title</script>" })]);
  selection.toggleSelection("search", "search-only");
  selection.submitSelection("search");
  view.setSettingsView("manage");
  update({ active: true });
  assert.match(root.innerHTML, /&lt;script&gt;date title&lt;\/script&gt;/);
  assert.doesNotMatch(root.innerHTML, /<script>date title/);
  assert.match(root.innerHTML, /2026-07-12/);
  assert.equal(requests.length, 1);
  const payload = JSON.parse(JSON.stringify(requests[0].payload));
  assert.deepEqual(payload, {
    expectedTabId: null,
    expectedAccountKey: "library-one",
    conversationIds: ["search-only"],
    bookmarkIds: [],
    fallbackTitles: { "search-only": "<script>date title</script>" },
    searchSelection: { accountKey: "account-one", conversationIds: ["search-only"] },
  });
  requests[0].resolve({
    schemaVersion: context.TidyExportContract.COLLECTION_VERSION,
    documents: [documentFor("search-only", "Authoritative export title")],
  });
  await flush();
  assert.match(root.innerHTML, /Authoritative export title/);
  assert.doesNotMatch(root.innerHTML, /&lt;script&gt;date title/);
  update();
  assert.equal(requests.length, 1);
});

test("date export refuses a mixed-account basket before requesting any documents", async () => {
  const { view, selection, root, requests, update } = createSearchExportHarness();
  for (const [id, accountKey] of [["first", "account-one"], ["second", "account-two"]]) {
    selection.beginSelection("search");
    selection.registerSearchResults([dateResult(id, { accountKey })]);
    selection.toggleSelection("search", id);
    selection.submitSelection("search");
  }
  update({ active: true });
  await flush();
  assert.equal(requests.length, 0);
  assert.equal(selection.basketCount(), 2);
  assert.match(root.innerHTML, /exportBatchUnavailable/);
});

test("both empty-basket and manage-list menus open the enabled date source picker", () => {
  const { view, selection, root, handlers, sourceRequests, update } = createSearchExportHarness();
  const clickSearch = () => handlers.click({
    target: {
      closest: (selector) => selector === "[data-export-source]"
        ? { disabled: false, dataset: { exportSource: "search" } } : null,
    },
  });
  view.setMode("batch");
  update();
  assert.match(root.innerHTML, /data-export-source="search">/);
  clickSearch();
  view.setSettingsView("manage");
  update();
  assert.match(root.innerHTML, /role="menuitem" data-export-source="search">/);
  clickSearch();
  assert.deepEqual(sourceRequests, [
    { source: "search", target: "batch-main" },
    { source: "search", target: "manage" },
  ]);
});

function addSearchSelection(selection, ids) {
  selection.beginSelection("search");
  selection.registerSearchResults(ids.map((id) => dateResult(id)));
  selection.selectSelectionRange("search", ids);
  selection.submitSelection("search");
}

function resolveExportBatch(harness, index, options = {}) {
  const request = harness.requests[index];
  request.resolve({
    schemaVersion: harness.context.TidyExportContract.COLLECTION_VERSION,
    documents: (options.ids || request.payload.conversationIds)
      .map((id) => documentFor(id, `${options.prefix || "Loaded"} ${id}`)),
  });
}

test("date export reads more than 100 conversations sequentially and publishes only the complete collection", async () => {
  const harness = createSearchExportHarness();
  const { view, selection, root, requests, update } = harness;
  const ids = Array.from({ length: 205 }, (_, index) => `date-${index}`);
  addSearchSelection(selection, ids);
  view.setSettingsView("manage");
  update({ active: true });
  assert.equal(selection.basketCount(), 205, "transport batches must not cap the selection");
  assert.equal(requests.length, 1);
  assert.deepEqual(Array.from(requests[0].payload.conversationIds), ids.slice(0, 100));
  resolveExportBatch(harness, 0);
  await flush();
  assert.equal(requests.length, 2);
  assert.doesNotMatch(root.innerHTML, /Loaded date-0/, "first batch stays outside the live cache");
  assert.match(root.innerHTML, /data-export-action[^>]*disabled/);
  resolveExportBatch(harness, 1);
  await flush();
  assert.equal(requests.length, 3);
  assert.doesNotMatch(root.innerHTML, /Loaded date-0/);
  assert.deepEqual(requests.map((request) => request.payload.conversationIds.length), [100, 100, 5]);
  for (const request of requests) {
    const payload = JSON.parse(JSON.stringify(request.payload));
    assert.deepEqual(payload.searchSelection, { accountKey: "account-one", conversationIds: payload.conversationIds });
    assert.deepEqual(Object.keys(payload.fallbackTitles), payload.conversationIds);
    assert.deepEqual(payload.bookmarkIds, []);
  }
  resolveExportBatch(harness, 2);
  await flush();
  assert.match(root.innerHTML, /Loaded date-0/);
  assert.doesNotMatch(root.innerHTML, /data-export-action[^>]*disabled/);
  update();
  assert.equal(requests.length, 3, "the complete basket is reused locally");
});

test("mixed-source transport batches carry only their own search provenance, titles and selected bookmarks", async () => {
  const harness = createSearchExportHarness();
  const { view, selection, requests, update } = harness;
  selection.beginSelection("favorites");
  selection.toggleSelection("favorites", "conversation-a");
  selection.submitSelection("favorites");
  const searchIds = ["conversation-a", ...Array.from({ length: 100 }, (_, index) => `search-${index}`)];
  addSearchSelection(selection, searchIds);
  selection.beginSelection("bookmarks");
  selection.selectSelectionRange("bookmarks", ["bookmark-a", "bookmark-b"]);
  selection.submitSelection("bookmarks");
  update({ active: true });
  assert.equal(requests.length, 1);
  const first = JSON.parse(JSON.stringify(requests[0].payload));
  assert.equal(first.conversationIds.length, 100);
  assert.deepEqual(first.bookmarkIds, ["bookmark-a"]);
  assert.deepEqual(first.searchSelection.conversationIds, searchIds.slice(0, 100));
  assert.deepEqual(Object.keys(first.fallbackTitles), first.conversationIds);
  assert.equal(first.fallbackTitles["conversation-a"], "Favorite A");
  resolveExportBatch(harness, 0);
  await flush();
  assert.equal(requests.length, 2);
  const second = JSON.parse(JSON.stringify(requests[1].payload));
  assert.deepEqual(second.conversationIds, ["search-99", "conversation-b"]);
  assert.deepEqual(second.bookmarkIds, ["bookmark-b"]);
  assert.deepEqual(second.searchSelection, { accountKey: "account-one", conversationIds: ["search-99"] });
  assert.deepEqual(second.fallbackTitles, { "search-99": "Search search-99", "conversation-b": "Bookmark B" });
  resolveExportBatch(harness, 1);
  await flush();
});

test("a saved-only transport batch does not inherit search authorization from an earlier batch", async () => {
  const harness = createSearchExportHarness();
  const { view, selection, requests, update } = harness;
  addSearchSelection(selection, Array.from({ length: 100 }, (_, index) => `search-${index}`));
  selection.beginSelection("favorites");
  selection.toggleSelection("favorites", "conversation-a");
  selection.submitSelection("favorites");
  selection.beginSelection("bookmarks");
  selection.toggleSelection("bookmarks", "bookmark-b");
  selection.submitSelection("bookmarks");
  update({ active: true });
  resolveExportBatch(harness, 0);
  await flush();
  assert.equal(requests.length, 2);
  const second = JSON.parse(JSON.stringify(requests[1].payload));
  assert.deepEqual(second, {
    expectedTabId: null,
    expectedAccountKey: "library-one",
    conversationIds: ["conversation-a", "conversation-b"],
    bookmarkIds: ["bookmark-b"],
    fallbackTitles: { "conversation-a": "Favorite A", "conversation-b": "Bookmark B" },
  });
  resolveExportBatch(harness, 1);
  await flush();
});

test("incomplete, extra or failed later batches never publish an earlier partial collection", async () => {
  for (const outcome of ["missing", "extra", "duplicate", "failure"]) {
    const harness = createSearchExportHarness();
    const { view, selection, root, requests, update } = harness;
    addSearchSelection(selection, Array.from({ length: 205 }, (_, index) => `search-${index}`));
    update({ active: true });
    resolveExportBatch(harness, 0);
    await flush();
    if (outcome === "failure") requests[1].reject(new Error("Second batch failed"));
    else {
      const expected = Array.from(requests[1].payload.conversationIds);
      const ids = outcome === "missing" ? expected.slice(1)
        : outcome === "extra" ? [...expected, "unrequested"] : [...expected, expected[0]];
      resolveExportBatch(harness, 1, { ids });
    }
    await flush();
    assert.equal(requests.length, 2, outcome);
    assert.doesNotMatch(root.innerHTML, /Loaded search-0/, outcome);
    assert.match(root.innerHTML, /data-export-action[^>]*disabled/, outcome);
    assert.match(root.innerHTML, /exportBatchUnavailable|exportInvalidDocument|Second batch failed/, outcome);
  }
});

test("changing source during a multi-batch read discards staged and late results without dispatching another batch", async () => {
  const harness = createSearchExportHarness();
  const { view, selection, root, requests, update } = harness;
  addSearchSelection(selection, Array.from({ length: 205 }, (_, index) => `search-${index}`));
  view.setSettingsView("manage");
  update({ active: true });
  resolveExportBatch(harness, 0);
  await flush();
  assert.equal(requests.length, 2);
  selection.beginSelection("favorites");
  resolveExportBatch(harness, 1);
  await flush();
  assert.equal(requests.length, 2, "old generation cannot dispatch the third batch");
  assert.doesNotMatch(root.innerHTML, /Loaded search-0/);
  selection.cancelSelection();
  update();
  assert.equal(requests.length, 3);
  assert.equal(requests[2].payload.conversationIds[0], "search-0", "the next generation reads the complete basket again");
  update({ active: false });
  resolveExportBatch(harness, 2);
  await flush();
  assert.equal(requests.length, 3, "hidden view cannot dispatch a continuation");
});

test("a failed refresh cannot re-enable export from previously cached batch documents", async () => {
  const harness = createSearchExportHarness();
  const { view, selection, root, stores, requests, update } = harness;
  addSearchSelection(selection, ["search-only"]);
  update({ active: true });
  resolveExportBatch(harness, 0);
  await flush();
  assert.doesNotMatch(root.innerHTML, /data-export-action[^>]*disabled/);
  update({ favorites: { ...stores.favorites, revision: 2 } });
  assert.equal(requests.length, 2);
  requests[1].reject(new Error("Current source verification failed"));
  await flush();
  assert.match(root.innerHTML, /data-export-action[^>]*disabled/);
  assert.match(root.innerHTML, /exportBatchUnavailable/);
  assert.doesNotMatch(root.innerHTML, /Current source verification failed/, "raw adapter exception stays out of UI");
});

test("a transport batch over the existing bookmark limit fails rather than truncating its selection", async () => {
  const { view, selection, root, stores, requests, update } = createSearchExportHarness();
  const items = Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`bookmark-${index}`, {
    ...stores.bookmarks.items["bookmark-a"], bookmarkId: `bookmark-${index}`,
  }]));
  update({ bookmarks: { ...stores.bookmarks, revision: 2, items } });
  selection.beginSelection("bookmarks");
  selection.selectSelectionRange("bookmarks", Object.keys(items));
  selection.submitSelection("bookmarks");
  update({ active: true });
  await flush();
  assert.equal(selection.basketCount(), 501);
  assert.equal(requests.length, 0);
  assert.match(root.innerHTML, /exportBatchUnavailable/);
  assert.match(root.innerHTML, /data-export-action[^>]*disabled/);
});
