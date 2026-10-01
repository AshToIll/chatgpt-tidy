const assert = require("node:assert/strict");
const test = require("node:test");

// Import the production ESM graph rather than copying the worker function.
// The fixture supplies only its three public dependencies, with no chrome global.
const observerModule = import("../src/app/background/title-catalog-observer.js");
const OWNER = '["title-user","personal"]';
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function harness(overrides = {}) {
  const { createTitleCatalogObserver } = await observerModule;
  const protocol = globalThis.TidyProtocol;
  const sender = {
    tab: { id: 31, url: "https://chatgpt.com/c/open-chat" },
    frameId: 0, documentId: "doc-a", documentLifecycle: "active",
    url: "https://chatgpt.com/c/open-chat",
  };
  const change = {
    ownerAccountKey: OWNER, epoch: 4, catalogAccountKey: "catalog-account",
    conversationId: "off-current_chat-1", title: "Private native title", startedAt: 1000,
  };
  let current = {
    accountKey: OWNER, epoch: 4, documentId: "doc-a", phase: "ready",
  };
  const events = [], peeks = [], writes = [], messages = [], order = [];
  const observer = createTitleCatalogObserver({
    chrome: { runtime: { sendMessage: async envelope => {
      messages.push(envelope); order.push("broadcast");
      await overrides.send?.(envelope);
    } } },
    identity: {
      acceptEvent: async (event, from) => {
        events.push({ event, sender: from }); order.push("identity");
        await overrides.acceptEvent?.(event, from);
      },
      peek: tabId => { peeks.push(tabId); return current; },
    },
    repository: { acceptTitleChange: async (accountKey, payload, isCurrent) => {
      writes.push({ accountKey, payload, isCurrent }); order.push("write");
      return overrides.save ? await overrides.save(accountKey, payload, isCurrent) : true;
    } },
  });
  return {
    observer, protocol, sender, change, events, peeks, writes, messages, order,
    setIdentity: value => { current = value; },
    identity: () => current,
  };
}

test("title observer construction is inert and exposes one frozen capability", async () => {
  const h = await harness();
  assert.ok(Object.isFrozen(h.observer));
  assert.deepEqual(Object.keys(h.observer), ["accept"]);
  assert.deepEqual([h.events, h.peeks, h.writes, h.messages], [[], [], [], []]);
});

test("a valid external rename persists its exact projection and broadcasts only locator keys", async () => {
  const h = await harness();
  // Tab zero is a real browser owner, not the absence of one.
  h.sender.tab.id = 0;
  assert.equal(await h.observer.accept(h.change, h.sender), true);
  assert.deepEqual(h.events, [{
    event: { accountKey: OWNER, epoch: 4, phase: "ready" }, sender: h.sender,
  }]);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0].payload, {
    conversationId: h.change.conversationId, title: h.change.title, startedAt: 1000,
  });
  assert.equal(h.writes[0].accountKey, "catalog-account");
  assert.equal(h.writes[0].isCurrent(), true);
  assert.ok(h.peeks.every(tabId => tabId === 0));
  assert.deepEqual(h.order, ["identity", "write", "broadcast"]);
  assert.equal(h.messages.length, 1);
  const [message] = h.messages;
  assert.equal(h.protocol.isEnvelope(message), true);
  assert.equal(message.kind, h.protocol.Kind.EVENT);
  assert.equal(message.type, h.protocol.Type.TITLE_CATALOG_CHANGED);
  assert.deepEqual(message.payload, {
    accountKey: "catalog-account", conversationId: h.change.conversationId,
  });
  assert.equal(JSON.stringify(message).includes(h.change.title), false);
  assert.equal(Object.hasOwn(message.payload, "ownerAccountKey"), false);
});

test("invalid browser senders are rejected before identity or storage access", async () => {
  const h = await harness();
  const invalid = [
    undefined, null, {}, { ...h.sender, tab: undefined },
    ...[-1, -0, 1.5, "31", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(id => ({
      ...h.sender, tab: { ...h.sender.tab, id },
    })),
    { ...h.sender, frameId: 1 }, { ...h.sender, frameId: undefined },
    { ...h.sender, documentId: "" }, { ...h.sender, documentId: undefined },
    { ...h.sender, documentLifecycle: "cached" },
    { ...h.sender, documentLifecycle: undefined },
    { ...h.sender, url: "https://example.com/c/open-chat" },
    { ...h.sender, url: "https://chatgpt.com.example.com/c/open-chat" },
    { ...h.sender, url: "not a URL" },
    { ...h.sender, url: undefined },
  ];
  for (const sender of invalid) {
    assert.equal(await h.observer.accept(h.change, sender), false);
  }
  assert.deepEqual([h.events, h.peeks, h.writes, h.messages], [[], [], [], []]);
});

test("invalid title projections are rejected before identity or storage access", async () => {
  const h = await harness();
  const invalid = [
    undefined, null, {},
    ...["", "path/slash", "contains space", 123].map(conversationId => ({ ...h.change, conversationId })),
    ...["", "  ", "x".repeat(4097), 123].map(title => ({ ...h.change, title })),
    ...["", "  ", " leading", "trailing ", 123].map(catalogAccountKey => ({ ...h.change, catalogAccountKey })),
    ...[-1, NaN, Infinity, "1000", undefined].map(startedAt => ({ ...h.change, startedAt })),
  ];
  for (const change of invalid) {
    assert.equal(await h.observer.accept(change, h.sender), false);
  }
  assert.deepEqual([h.events, h.peeks, h.writes, h.messages], [[], [], [], []]);
});

test("an identity mismatch after admission prevents persistence and publication", async () => {
  for (const patch of [
    null, { phase: "unavailable" }, { documentId: "doc-b" },
    { accountKey: '["other-user","personal"]' }, { epoch: 5 },
  ]) {
    const h = await harness();
    h.setIdentity(patch === null ? null : { ...h.identity(), ...patch });
    assert.equal(await h.observer.accept(h.change, h.sender), false);
    assert.equal(h.events.length, 1);
    assert.deepEqual([h.writes, h.messages], [[], []]);
  }
});

test("identity changes while admission is pending cannot reach storage", async () => {
  const entered = deferred(), gate = deferred();
  const h = await harness({ acceptEvent: async () => {
    entered.resolve(); await gate.promise;
  } });
  const pending = h.observer.accept(h.change, h.sender);
  await entered.promise;
  h.setIdentity({ ...h.identity(), documentId: "doc-b" });
  gate.resolve();
  assert.equal(await pending, false);
  assert.deepEqual([h.writes, h.messages], [[], []]);
});

test("the repository receives a live identity guard rather than an admission snapshot", async () => {
  const entered = deferred(), gate = deferred();
  const h = await harness({ save: async (_accountKey, _payload, isCurrent) => {
    assert.equal(isCurrent(), true);
    entered.resolve(); await gate.promise;
    return isCurrent();
  } });
  const pending = h.observer.accept(h.change, h.sender);
  await entered.promise;
  h.setIdentity({ ...h.identity(), epoch: 5 });
  assert.equal(h.writes[0].isCurrent(), false);
  gate.resolve();
  assert.equal(await pending, false);
  assert.deepEqual(h.messages, []);
});

test("identity changes during a successful write suppress its broadcast", async () => {
  const entered = deferred(), gate = deferred();
  const h = await harness({ save: async () => {
    entered.resolve(); await gate.promise; return true;
  } });
  const pending = h.observer.accept(h.change, h.sender);
  await entered.promise;
  h.setIdentity(null);
  gate.resolve();
  // Preserve the repository result, but never publish for a retired owner.
  assert.equal(await pending, true);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.messages, []);
});

test("a repository no-op does not publish a catalog change", async () => {
  const h = await harness({ save: async () => false });
  assert.equal(await h.observer.accept(h.change, h.sender), false);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.messages, []);
});

test("an unavailable panel does not turn an accepted cache update into failure", async () => {
  const h = await harness({ send: async () => { throw new Error("No receiver"); } });
  assert.equal(await h.observer.accept(h.change, h.sender), true);
  assert.equal(h.messages.length, 1);
});
