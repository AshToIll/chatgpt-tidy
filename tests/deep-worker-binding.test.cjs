const assert = require("node:assert/strict");
const test = require("node:test");

const BASE = "chrome-extension://tidy-test/app/sidepanel/index.html";
const panelSender = (tabId = 31) => ({ url: BASE + "?tidyTabId=" + tabId });
const contentSender = () => ({ tab: { id: 31, url: "https://chatgpt.com/c/chat" },
  url: "https://chatgpt.com/c/chat", frameId: 0, documentId: "document-a", documentLifecycle: "active" });
const OWNER = { accountKey: "account-a", identity: { documentId: "document-a", epoch: 4 } };
const payload = () => ({ expectedTabId: 31, expectedAccountKey: OWNER.accountKey,
  expectedIdentity: { ...OWNER.identity } });
const policy = { requireExpected: true, requireIdentity: true, retryIdentity: false };

// Import real ESM entry points; no worker source slicing or source transformations.
async function bindingHarness(overrides = {}) {
  const { createRequestBinding, isChatgptUrl, libraryError } = await import(
    "../src/platform/session/background/request-binding.js");
  const calls = { options: [], get: [], account: [] };
  const chrome = {
    runtime: { getURL: path => "chrome-extension://tidy-test/" + path.replace(/^\//, "") },
    sidePanel: { getOptions: async options => {
      calls.options.push(options);
      if (overrides.optionsError) throw overrides.optionsError;
      return Object.hasOwn(overrides, "options") ? overrides.options
        : { enabled: true, path: "app/sidepanel/index.html?tidyTabId=" + options.tabId };
    } },
    // Deliberately no tabs.query: owner resolution must never query the active tab.
    tabs: { get: async id => {
      calls.get.push(id);
      if (overrides.tabError) throw overrides.tabError;
      return Object.hasOwn(overrides, "tab") ? overrides.tab : { id, url: "https://chatgpt.com/c/chat" };
    } },
  };
  const libraryIdentity = { readAccount: async (tab, options) => {
    calls.account.push({ tab, options });
    if (overrides.accountError) throw overrides.accountError;
    return overrides.owner || OWNER;
  } };
  return { binding: createRequestBinding({ chrome, libraryIdentity }), isChatgptUrl, libraryError, calls };
}

test("binding construction is inert and URL recognition keeps exact routing parts", async () => {
  const h = await bindingHarness();
  assert.deepEqual(h.calls, { options: [], get: [], account: [] });
  for (const url of ["https://chatgpt.com/c/a", "http://chatgpt.com/", "https://chatgpt.com:444/"]) {
    assert.equal(h.isChatgptUrl(url), true);
    assert.equal(h.binding.isChatgptUrl(url), true);
  }
  for (const url of [null, "", "not a URL", "https://chatgpt.com.evil/", "https://www.chatgpt.com/"]) {
    assert.equal(h.isChatgptUrl(url), false);
  }
  assert.equal(h.binding.isSidePanelDocumentUrl(BASE + "?decorated=1#fragment"), true);
  for (const url of [undefined, BASE.replace("tidy-test", "other"), BASE.replace("chrome-extension:", "https:"),
    BASE + "/nested", "https://chatgpt.com/"]) assert.equal(h.binding.isSidePanelDocumentUrl(url), false);
  assert.equal(h.binding.panelOwnerTabId(panelSender(0).url), 0);
  for (const url of [BASE, BASE + "?tidyTabId=01", BASE + "?tidyTabId=31&extra=1",
    BASE + "?tidyTabId=31&tidyTabId=31", BASE + "?tidyTabId=%33%31", panelSender().url + "#fragment"]) {
    assert.equal(h.binding.panelOwnerTabId(url), null);
  }
  assert.equal(h.libraryError("changed").tidyCode, "CONTEXT_MISMATCH");
});

test("panel binding validates configured owner before resolving that exact tab", async () => {
  const h = await bindingHarness();
  assert.equal((await h.binding.getBoundTab(undefined, panelSender())).id, 31);
  assert.deepEqual(h.calls.options, [{ tabId: 31 }]);
  assert.deepEqual(h.calls.get, [31]);
  assert.deepEqual(h.calls.account, []);
});

test("explicit and content owners resolve without panel options or focus queries", async () => {
  const h = await bindingHarness();
  assert.equal((await h.binding.getBoundTab(0)).id, 0);
  assert.equal((await h.binding.getBoundTab(undefined, contentSender())).id, 31);
  assert.equal((await h.binding.getBoundTab(31, contentSender())).id, 31);
  assert.deepEqual(h.calls.get, [0, 31, 31]);
  assert.deepEqual(h.calls.options, []);
});

test("conflicting, absent and malformed panel owners fail before browser or account access", async () => {
  const h = await bindingHarness();
  for (const [expected, sender] of [[32, panelSender()], [32, contentSender()],
    [31, { ...panelSender(), tab: { id: 32 } }], [undefined, undefined], ["31", {}], [-0, {}],
    [31, { url: BASE }], [31, { url: BASE + "?tidyTabId=31&extra=1" }]]) {
    await assert.rejects(h.binding.getBoundTab(expected, sender),
      { tidyCode: "TAB_UNAVAILABLE", stage: "service-worker.resolve-tab" });
  }
  assert.deepEqual(h.calls, { options: [], get: [], account: [] });
});

test("disabled, mismatched and noncanonical configured panels fail closed", async () => {
  for (const options of [null, { enabled: false, path: "app/sidepanel/index.html?tidyTabId=31" },
    { enabled: true, path: "app/sidepanel/index.html?tidyTabId=32" },
    { enabled: true, path: "app/sidepanel/index.html?tidyTabId=031" },
    { enabled: true, path: "app/sidepanel/index.html?tidyTabId=31&extra=1" },
    { enabled: true, path: "chrome-extension://other/app/sidepanel/index.html?tidyTabId=31" }]) {
    const h = await bindingHarness({ options });
    await assert.rejects(h.binding.getBoundTab(31, panelSender()), error => {
      assert.equal(error.tidyCode, "TAB_UNAVAILABLE");
      assert.equal(error.stage, "service-worker.resolve-panel-options");
      assert.ok(error.cause instanceof Error);
      return true;
    });
    assert.deepEqual(h.calls.get, []);
  }
});

test("panel and tab API failures retain causes and distinct resolution stages", async () => {
  for (const [key, stage] of [["optionsError", "service-worker.resolve-panel-options"],
    ["tabError", "service-worker.resolve-tab"]]) {
    const cause = new Error("permission denied"), h = await bindingHarness({ [key]: cause });
    await assert.rejects(h.binding.getBoundTab(31, panelSender()), error =>
      error.tidyCode === "TAB_UNAVAILABLE" && error.stage === stage && error.cause === cause);
  }
  for (const tab of [null, { id: -1 }, { id: 32 }]) {
    const h = await bindingHarness({ tab });
    await assert.rejects(h.binding.getBoundTab(31),
      { tidyCode: "TAB_UNAVAILABLE", stage: "service-worker.resolve-tab" });
  }
});

test("library reads discover an account and pass the identity retry policy", async () => {
  const h = await bindingHarness(), sender = panelSender();
  const result = await h.binding.libraryContext({ expectedTabId: 31 }, sender,
    { requireExpected: false, requireIdentity: false, retryIdentity: true });
  assert.equal(result.accountKey, OWNER.accountKey);
  assert.equal(result.identity, OWNER.identity);
  assert.equal(result.sender, sender);
  assert.equal(result.tab.id, 31);
  assert.deepEqual(h.calls.account, [{ tab: result.tab, options: { retry: true } }]);
});

test("library admission and malformed mandatory leases reject before reading an account", async () => {
  const h = await bindingHarness();
  for (const sender of [undefined, { url: "https://example.com/" },
    { tab: { id: 31, url: "https://example.com/" } }]) {
    await assert.rejects(h.binding.libraryContext(payload(), sender, policy), { tidyCode: "CONTEXT_MISMATCH" });
  }
  assert.deepEqual(h.calls.get, []);
  for (const expectedIdentity of [undefined, {}, { documentId: "document-a", epoch: -1 },
    { documentId: "document-a", epoch: 1.5 }, { documentId: "document-a", epoch: "4" }]) {
    await assert.rejects(h.binding.libraryContext({ ...payload(), expectedIdentity }, panelSender(), policy),
      { tidyCode: "CONTEXT_MISMATCH" });
  }
  assert.deepEqual(h.calls.account, []);
});

test("library actions validate expected account, lease, content frame and current document", async () => {
  const h = await bindingHarness();
  assert.equal((await h.binding.libraryContext(payload(), contentSender(), policy)).identity, OWNER.identity);
  for (const patch of [{ expectedAccountKey: undefined }, { expectedAccountKey: "" },
    { expectedAccountKey: "account-b" }, { expectedIdentity: { documentId: "old", epoch: 4 } },
    { expectedIdentity: { documentId: "document-a", epoch: 3 } }]) {
    await assert.rejects(h.binding.libraryContext({ ...payload(), ...patch }, panelSender(), policy),
      { tidyCode: "CONTEXT_MISMATCH" });
  }
  for (const patch of [{ frameId: 1 }, { documentId: "old" }]) {
    await assert.rejects(h.binding.libraryContext(payload(), { ...contentSender(), ...patch }, policy),
      { tidyCode: "CONTEXT_MISMATCH" });
  }
  // Optional expectations still constrain reads when supplied.
  for (const input of [{ expectedAccountKey: "account-b" },
    { expectedIdentity: { documentId: "old", epoch: 4 } }]) {
    await assert.rejects(h.binding.libraryContext(input, panelSender(),
      { requireExpected: false, requireIdentity: false }), { tidyCode: "CONTEXT_MISMATCH" });
  }
});

test("library account read failures propagate unchanged", async () => {
  const cause = new Error("identity unavailable"), h = await bindingHarness({ accountError: cause });
  await assert.rejects(h.binding.libraryContext(payload(), panelSender(), policy), error => error === cause);
});

test("navigation sender validation is synchronous, exact-owner scoped and performs no I/O", async () => {
  const h = await bindingHarness();
  assert.equal(h.binding.navigationSenderTab(payload(), panelSender(), true), 31);
  assert.equal(h.binding.navigationSenderTab(payload(), contentSender(), true), 31);
  assert.equal(h.binding.navigationSenderTab({}, contentSender()), 31);
  for (const sender of [undefined, { url: BASE }, { ...panelSender(), tab: { id: 31 } },
    { ...contentSender(), frameId: 1 }, { ...contentSender(), documentLifecycle: "cached" },
    { ...contentSender(), documentLifecycle: undefined }, { ...contentSender(), url: "https://example.com/" },
    { ...contentSender(), tab: { id: 31, url: "https://example.com/" } },
    { ...contentSender(), documentId: "old" }]) {
    assert.throws(() => h.binding.navigationSenderTab(payload(), sender, true), { tidyCode: "CONTEXT_MISMATCH" });
  }
  for (const expectedTabId of [32, "31"]) {
    assert.throws(() => h.binding.navigationSenderTab({ expectedTabId }, panelSender()),
      { tidyCode: "CONTEXT_MISMATCH" });
  }
  assert.deepEqual(h.calls, { options: [], get: [], account: [] });
});

function validSnapshot() {
  const missing = () => ({ value: null, source: null, status: "missing" });
  return { schemaVersion: globalThis.TidySnapshot.VERSION, route: { pathname: "/" },
    appearance: { colorScheme: "light", source: "fixture", status: "available", surface: missing() },
    conversation: { identityStatus: "empty", bindingStatus: "unbound", conversationId: null,
      draftId: null, title: missing(), createdAt: missing(), updatedAt: missing() },
    sidebarConversations: [], messages: [] };
}

async function gatewayHarness(overrides = {}) {
  const [{ createPageGateway }] = await Promise.all([
    import("../src/platform/session/background/page-gateway.js"),
    import("../src/platform/protocol.js"), import("../src/platform/snapshot.js"),
  ]);
  const protocol = globalThis.TidyProtocol, calls = [], queries = [], snapshot = validSnapshot();
  assert.equal(globalThis.TidySnapshot.validate(snapshot).valid, true);
  const chrome = { tabs: {
    sendMessage: async (...args) => {
      calls.push(args);
      return overrides.send ? overrides.send(...args) : protocol.response(args[1], snapshot);
    },
    query: async query => {
      queries.push(query);
      if (overrides.queryError) throw overrides.queryError;
      return overrides.tabs || [];
    },
  } };
  return { gateway: createPageGateway({ chrome }), protocol, snapshot, calls, queries };
}

test("raw page send preserves envelope and response identity with nullable document targeting", async () => {
  const reply = { marker: "response" }, h = await gatewayHarness({ send: () => reply });
  const envelope = h.protocol.request("fixture", { marker: "payload" });
  assert.deepEqual(h.calls, []);
  assert.equal(await h.gateway.send(31, envelope), reply);
  await h.gateway.send(31, envelope, "document-a");
  await h.gateway.send(31, envelope, "");
  assert.deepEqual(h.calls, [[31, envelope], [31, envelope, { documentId: "document-a" }],
    [31, envelope, { documentId: "" }]]);
});

test("snapshot preserves tab and payload references but targets only truthy document IDs", async () => {
  const h = await gatewayHarness(), tab = { id: 31, url: "https://chatgpt.com/c/chat" };
  const input = { scope: "title-owner" }, result = await h.gateway.snapshot(tab, input, "document-a");
  assert.equal(result.tab, tab);
  assert.equal(result.snapshot, h.snapshot);
  assert.equal(h.calls[0][1].type, h.protocol.Type.GET_SNAPSHOT);
  assert.equal(h.calls[0][1].payload, input);
  assert.deepEqual(h.calls[0][2], { documentId: "document-a" });
  await h.gateway.snapshot(tab, null, "");
  assert.equal(h.calls[1].length, 2);
  assert.equal(h.calls[1][1].payload, null);
});

test("snapshot rejects invalid tabs and unsupported pages before sending", async () => {
  const h = await gatewayHarness();
  for (const tab of [null, { id: -1, url: "https://chatgpt.com/" },
    { id: "31", url: "https://chatgpt.com/" }, { id: 31, url: "https://example.com/" }]) {
    await assert.rejects(h.gateway.snapshot(tab), { tidyCode: "UNSUPPORTED_PAGE" });
  }
  assert.deepEqual(h.calls, []);
});

test("snapshot transport failures retain disconnect evidence and original causes", async () => {
  for (const [message, disconnect] of [
    ["Could not establish connection. Receiving end does not exist.", "receiver-missing"],
    ["The message port closed before a response was received.", "connection-closed"],
    ["Extension context invalidated.", "context-invalidated"], ["Permission denied", null],
  ]) {
    const cause = new Error(message), h = await gatewayHarness({ send: () => { throw cause; } });
    await assert.rejects(h.gateway.snapshot({ id: 31, url: "https://chatgpt.com/" }), error => {
      assert.equal(error.tidyCode, "ADAPTER_UNAVAILABLE");
      assert.equal(error.cause, cause);
      assert.deepEqual(error.details, { stage: "service-worker.snapshot-send-message", disconnect });
      return true;
    });
  }
});

test("snapshot requires matching response identity and a valid snapshot contract", async () => {
  for (const mode of ["missing", "request", "wrong-id", "invalid-snapshot"]) {
    const h = await gatewayHarness({ send: (_tab, envelope) => {
      if (mode === "missing") return undefined;
      if (mode === "request") return envelope;
      const result = globalThis.TidyProtocol.response(envelope, mode === "invalid-snapshot" ? {} : validSnapshot());
      if (mode === "wrong-id") result.requestId = "unrelated";
      return result;
    } });
    await assert.rejects(h.gateway.snapshot({ id: 31, url: "https://chatgpt.com/" }),
      { tidyCode: "INVALID_ENVELOPE" });
  }
});

test("snapshot retains adapter error details and fallback error values", async () => {
  const details = { account: "changed" };
  const h = await gatewayHarness({ send: (_tab, envelope) =>
    globalThis.TidyProtocol.failure(envelope, "CONTEXT_MISMATCH", "changed", details) });
  await assert.rejects(h.gateway.snapshot({ id: 31, url: "https://chatgpt.com/" }), error => {
    assert.equal(error.tidyCode, "CONTEXT_MISMATCH");
    assert.equal(error.message, "changed");
    assert.equal(error.details, details);
    return true;
  });
  const fallback = await gatewayHarness({ send: (_tab, envelope) =>
    ({ ...globalThis.TidyProtocol.response(envelope), ok: false }) });
  await assert.rejects(fallback.gateway.snapshot({ id: 31, url: "https://chatgpt.com/" }),
    { tidyCode: "ADAPTER_UNAVAILABLE", message: "The ChatGPT adapter failed", details: null });
});

test("location forwards payload and retains empty-string document targeting", async () => {
  const located = { located: true };
  const h = await gatewayHarness({ send: (_tab, envelope) => globalThis.TidyProtocol.response(envelope, located) });
  const input = { messageId: "message-a" };
  assert.equal(await h.gateway.locate({ id: 31 }, input), located);
  await h.gateway.locate({ id: 31 }, input, "");
  assert.equal(h.calls[0][1].type, h.protocol.Type.LOCATE_MESSAGE);
  assert.equal(h.calls[0][1].payload, input);
  assert.equal(h.calls[0].length, 2);
  assert.deepEqual(h.calls[1][2], { documentId: "" });
});

test("location and raw send propagate transport rejections without snapshot reclassification", async () => {
  const cause = new Error("The message port closed before a response was received.");
  const h = await gatewayHarness({ send: () => { throw cause; } });
  await assert.rejects(h.gateway.locate({ id: 31 }, {}), error => error === cause);
  await assert.rejects(h.gateway.send(31, h.protocol.request("fixture")), error => error === cause);
});

test("location rejects invalid responses and retains adapter code without snapshot details", async () => {
  for (const mode of ["missing", "wrong-id", "adapter"]) {
    const h = await gatewayHarness({ send: (_tab, envelope) => {
      if (mode === "missing") return undefined;
      if (mode === "adapter") return globalThis.TidyProtocol.failure(envelope,
        "CONTEXT_MISMATCH", "location changed", { notForwarded: true });
      return { ...globalThis.TidyProtocol.response(envelope), requestId: "unrelated" };
    } });
    await assert.rejects(h.gateway.locate({ id: 31 }, {}), error => {
      assert.equal(error.tidyCode, mode === "adapter" ? "CONTEXT_MISMATCH" : "ADAPTER_UNAVAILABLE");
      assert.equal(error.message, mode === "adapter" ? "location changed" : "The ChatGPT adapter could not locate the message");
      assert.equal(error.details, undefined);
      return true;
    });
  }
});

test("broadcast filters invalid IDs, settles receiver failures and propagates query failures", async () => {
  const h = await gatewayHarness({ tabs: [{ id: 0 }, { id: 31 }, { id: -0 }, { id: -1 }, { id: "31" }],
    send: id => { if (id === 0) throw new Error("closed receiver"); return null; } });
  const envelope = h.protocol.event("fixture", { changed: true });
  await h.gateway.broadcast(envelope);
  assert.deepEqual(h.queries, [{ url: ["https://chatgpt.com/*"] }]);
  assert.deepEqual(h.calls, [[0, envelope], [31, envelope]]);
  const cause = new Error("query unavailable"), failed = await gatewayHarness({ queryError: cause });
  await assert.rejects(failed.gateway.broadcast(envelope), error => error === cause);
});

test("conversation route parser retains ordinary and project route grammar", async () => {
  const { parseConversationRoute } = await import("../src/platform/navigation/conversation-route.js");
  assert.deepEqual(parseConversationRoute("/c/chat-A_1/"), {
    conversationId: "chat-A_1", projectId: null, pathname: "/c/chat-A_1",
  });
  assert.deepEqual(parseConversationRoute("https://chatgpt.com/c/chat?view=1#message"), {
    conversationId: "chat", projectId: null, pathname: "/c/chat",
  });
  const projectId = "g-p-" + "a".repeat(32), path = "/g/" + projectId + "-readable/c/chat";
  assert.deepEqual(parseConversationRoute(path), { conversationId: "chat", projectId, pathname: path });
  for (const value of [undefined, null, "", "/", "/share/chat", "/g/custom/c/chat", "/c/chat/extra",
    "https://example.com/c/chat", "http://chatgpt.com/c/chat", "https://chatgpt.com:444/c/chat", "/c/a%2Fb"]) {
    assert.equal(parseConversationRoute(value), null, String(value));
  }
});

test("worker navigation enforces the injected search query limit without importing the search feature", async () => {
  const { createWorkerNavigation } = await import("../src/platform/navigation/background/worker-navigation.js");
  const navigation = createWorkerNavigation({ searchContract: { MAX_QUERY_LENGTH: 3 },
    navigationSenderTab: () => 6, chrome: { runtime: { sendMessage: async () => {} } } });
  const protocol = globalThis.TidyProtocol;
  const request = query => protocol.request(protocol.Type.SEARCH_OPEN_RESULT, {
    conversationId: "chat", resultId: "result", navigationKind: "keyword", query,
  });
  assert.throws(() => navigation.begin(request("four"), {}), { tidyCode: "CONTEXT_MISMATCH" });
  const handle = navigation.begin(request("abc"), {});
  assert.equal(handle.tabId, 6);
  assert.equal(typeof handle.id, "string");
});
