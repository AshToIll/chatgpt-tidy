const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const flush = () => new Promise(setImmediate);
const documentFor = id => ({ conversation: { id, title: "Title " + id, messages: [], resources: [] } });
const snapshotFor = (id = "current", text = "one", responding = false) => ({
  conversation: { conversationId: id, bindingStatus: "bound", identityStatus: "stable",
    title: { value: "Title " + id } },
  route: { pathname: "/c/" + id }, adapter: { responseInProgress: responding },
  messages: [{ messageId: "m1", excerpt: { value: text } }],
});
const collectionFor = call => ({ documents: call.payload.conversationIds.map(documentFor) });

function sourcesFor(ids = ["a"], accountKey = "owner") {
  return { favorites: { accountKey, revision: 1,
    items: Object.fromEntries(ids.map(id => [id, { conversationId: id, title: "Title " + id }])) },
  bookmarks: { accountKey, revision: 1, items: {} },
  basket: { conversations: ids.map(conversationId => ({ conversationId, sources: ["favorites"] })), bookmarkIds: [] } };
}

function harness() {
  let now = 0, serial = 0, changed = 0, invalidated = 0;
  const timers = new Map(), currentCalls = [], batchCalls = [];
  const rememberedCauses = new WeakMap();
  const context = vm.createContext({
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const filename = path.resolve(__dirname, "../src/features/export/ui/export-context-controller.js");
  vm.runInContext(fs.readFileSync(filename, "utf8").replace(/^export /gm, ""), context, { filename });
  const request = calls => payload => new Promise((resolve, reject) => calls.push({ payload, resolve, reject }));
  const controller = context.createExportContextController({
    requestDocument: request(currentCalls), requestDocuments: request(batchCalls),
    exportApi: {
      exportError: key => Object.assign(new Error(key), { exportMessageKey: key }),
      exportErrorDescriptor: (error, translate, fallback) => error.notice || ({ key: error.exportMessageKey || fallback }),
    },
    exportContract: {
      validResource: resource => Boolean(resource?.id && resource.type === "image" && typeof resource.src === "string"),
      validateDocument: document => ({ valid: Boolean(document?.conversation?.id) }),
      validateCollection: collection => ({ valid: Array.isArray(collection?.documents)
        && collection.documents.every(document => Boolean(document?.conversation?.id)) }),
    },
    rememberCause: (notice, error) => { rememberedCauses.set(notice, error); return notice; }, translate: key => key,
    onChanged() { changed++; }, onInvalidated() { invalidated++; },
  });
  let model = { snapshot: snapshotFor(), accountKey: "owner", verified: true, active: true,
    mode: "current", sources: sourcesFor() };
  function update(patch = {}) { model = { ...model, ...patch }; controller.update(model); }
  function advance(milliseconds) {
    now += milliseconds;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
  }
  update();
  return { controller, currentCalls, batchCalls, update, advance, causeOf: notice => rememberedCauses.get(notice),
    model: () => model, changed: () => changed, invalidated: () => invalidated };
}

test("current reads are single-flight and ordinary updates do not replay success", async () => {
  const h = harness();
  const read = h.controller.ensureCurrent();
  h.update();
  await h.controller.ensureCurrent();
  await h.controller.ensureCurrent({ force: true });
  assert.equal(h.currentCalls.length, 1);
  h.currentCalls[0].resolve(documentFor("current"));
  await read;
  assert.equal(h.controller.currentReady(), true);
  await h.controller.ensureCurrent();
  assert.equal(h.currentCalls.length, 1);
});

for (const boundary of ["account", "route", "content", "mode", "hidden", "suspended", "unverified"]) {
  test("late current result cannot cross " + boundary, async () => {
    const h = harness(), read = h.controller.ensureCurrent();
    if (boundary === "account") h.update({ accountKey: "other", sources: sourcesFor(["a"], "other") });
    if (boundary === "route") h.update({ snapshot: snapshotFor("different") });
    if (boundary === "content") h.update({ snapshot: snapshotFor("current", "two") });
    if (boundary === "mode") h.update({ mode: "batch" });
    if (boundary === "hidden") h.update({ active: false });
    if (boundary === "suspended") h.controller.suspend();
    if (boundary === "unverified") h.update({ verified: false });
    h.currentCalls[0].resolve(documentFor("current"));
    await read;
    assert.equal(h.controller.snapshot().document, null);
    assert.equal(h.controller.snapshot().loading, false);
    assert.equal(h.controller.currentReady(), false);
  });
}

test("current same-context invalidation waits for old read, settles 400ms, and follows once", async () => {
  const h = harness(), read = h.controller.ensureCurrent();
  h.update({ snapshot: snapshotFor("current", "two") });
  await h.controller.ensureCurrent({ force: true });
  assert.equal(h.currentCalls.length, 1);
  h.currentCalls[0].resolve(documentFor("current"));
  await read;
  h.advance(399);
  assert.equal(h.currentCalls.length, 1);
  h.advance(1);
  assert.equal(h.currentCalls.length, 2);
  h.currentCalls[1].resolve(documentFor("current"));
  await flush();
  assert.equal(h.controller.currentReady(), true);
});

test("current A to B to A retains single-flight ownership for both pending contexts", async () => {
  const h = harness(), first = h.controller.ensureCurrent();
  h.update({ snapshot: snapshotFor("different") });
  const second = h.controller.ensureCurrent();
  h.update({ snapshot: snapshotFor() });
  await h.controller.ensureCurrent();
  assert.equal(h.currentCalls.length, 2);
  h.currentCalls[0].resolve(documentFor("current"));
  await first;
  assert.equal(h.currentCalls.length, 3);
  h.currentCalls[1].resolve(documentFor("different"));
  await second;
  assert.equal(h.controller.snapshot().document, null);
  h.currentCalls[2].resolve(documentFor("current"));
  await flush();
  assert.equal(h.controller.currentReady(), true);
});

test("streaming never polls full text and completion starts one settled refresh", async () => {
  const h = harness(), first = h.controller.ensureCurrent();
  h.currentCalls[0].resolve(documentFor("current"));
  await first;
  h.update({ snapshot: snapshotFor("current", "two", true) });
  await h.controller.ensureCurrent();
  h.advance(1000);
  assert.equal(h.currentCalls.length, 1);
  h.update({ snapshot: snapshotFor("current", "two", false) });
  await h.controller.ensureCurrent();
  h.advance(400);
  assert.equal(h.currentCalls.length, 2);
  h.currentCalls[1].resolve(documentFor("current"));
  await flush();
  assert.equal(h.controller.currentReady(), true);
});

for (const mode of ["current", "batch"]) {
  test(mode + " failure is not retried by update or hide/return; explicit retry is allowed", async () => {
    const h = harness();
    h.update({ mode });
    const ensure = mode === "current" ? h.controller.ensureCurrent : h.controller.ensureBatch;
    const calls = mode === "current" ? h.currentCalls : h.batchCalls;
    const read = ensure();
    calls[0].reject(new Error("read failed"));
    await read;
    h.update();
    await ensure();
    h.update({ active: false });
    await ensure();
    h.update({ active: true });
    await ensure();
    assert.equal(calls.length, 1);
    const retry = ensure({ force: true });
    assert.equal(calls.length, 2);
    calls[1].resolve(mode === "current" ? documentFor("current") : collectionFor(calls[1]));
    await retry;
    assert.equal(mode === "current" ? h.controller.snapshot().loadError : h.controller.snapshot().batchLoadError, null);
  });
}

for (const boundary of ["account", "source", "selection", "mode", "hidden", "suspended", "unverified"]) {
  test("late batch result cannot cross " + boundary + " or dispatch its next chunk", async () => {
    const h = harness(), ids = Array.from({ length: 101 }, (_, i) => "c" + i);
    h.update({ mode: "batch", sources: sourcesFor(ids) });
    const read = h.controller.ensureBatch();
    assert.equal(h.batchCalls.length, 1);
    if (boundary === "account") h.update({ accountKey: "other", sources: sourcesFor(ids, "other") });
    if (boundary === "source") h.update({ sources: { ...h.model().sources,
      favorites: { ...h.model().sources.favorites, revision: 2 } } });
    if (boundary === "selection") h.update({ sources: { ...h.model().sources,
      basket: { conversations: [], bookmarkIds: [] } } });
    if (boundary === "mode") h.update({ mode: "current" });
    if (boundary === "hidden") h.update({ active: false });
    if (boundary === "suspended") h.controller.suspend();
    if (boundary === "unverified") h.update({ verified: false });
    h.batchCalls[0].resolve(collectionFor(h.batchCalls[0]));
    await read;
    assert.equal(h.batchCalls.length, 1);
    assert.equal(h.controller.snapshot().batchDocuments.size, 0);
    assert.equal(h.controller.snapshot().batchLoading, false);
  });
}

test("batch documents publish atomically after 100/100/5 sequential requests", async () => {
  const h = harness(), ids = Array.from({ length: 205 }, (_, i) => "c" + i);
  h.update({ mode: "batch", sources: sourcesFor(ids) });
  const read = h.controller.ensureBatch();
  for (let index = 0; index < 3; index++) {
    assert.equal(h.batchCalls.length, index + 1);
    assert.equal(h.batchCalls[index].payload.conversationIds.length, [100, 100, 5][index]);
    assert.equal(h.controller.snapshot().batchDocuments.size, 0);
    h.batchCalls[index].resolve(collectionFor(h.batchCalls[index]));
    await flush();
  }
  await read;
  assert.equal(h.controller.snapshot().batchDocuments.size, 205);
  await h.controller.ensureBatch();
  assert.equal(h.batchCalls.length, 3);
  const dto = h.controller.snapshot();
  dto.batchDocuments.clear();
  dto.batchStaleConversationIds.add("tampered");
  assert.equal(h.controller.snapshot().batchDocuments.size, 205);
  assert.equal(h.controller.snapshot().batchStaleConversationIds.size, 0);
});

test("batch failure in the second chunk publishes no partial documents and dispatches no third chunk", async () => {
  const h = harness(), ids = Array.from({ length: 205 }, (_, i) => "c" + i);
  h.update({ mode: "batch", sources: sourcesFor(ids) });
  const read = h.controller.ensureBatch();
  h.batchCalls[0].resolve(collectionFor(h.batchCalls[0]));
  await flush();
  h.batchCalls[1].reject(new Error("failed"));
  await read;
  assert.equal(h.batchCalls.length, 2);
  assert.equal(h.controller.snapshot().batchDocuments.size, 0);
  assert.equal(h.controller.snapshot().batchFailedTitles.length, 100);
  await h.controller.ensureBatch();
  assert.equal(h.batchCalls.length, 2);
});

test("stable source revisions reuse cached documents while basket additions read only missing ids", async () => {
  const h = harness(), sources = sourcesFor(["a", "b"]);
  h.update({ mode: "batch", sources: { ...sources, basket: {
    conversations: [sources.basket.conversations[0]], bookmarkIds: [] } } });
  const first = h.controller.ensureBatch();
  h.batchCalls[0].resolve(collectionFor(h.batchCalls[0]));
  await first;
  h.update({ sources });
  const second = h.controller.ensureBatch();
  assert.deepEqual(Array.from(h.batchCalls[1].payload.conversationIds), ["b"]);
  h.batchCalls[1].resolve(collectionFor(h.batchCalls[1]));
  await second;
  assert.equal(h.controller.snapshot().batchDocuments.size, 2);
});

test("selected conversation content drift remains blocked until explicit refresh", async () => {
  const h = harness();
  h.update({ mode: "batch", snapshot: snapshotFor("a") });
  const first = h.controller.ensureBatch();
  h.batchCalls[0].resolve(collectionFor(h.batchCalls[0]));
  await first;
  h.update({ snapshot: snapshotFor("a", "two") });
  assert.equal(h.controller.snapshot().batchStaleConversationIds.has("a"), true);
  await h.controller.ensureBatch();
  assert.equal(h.batchCalls.length, 1);
  const retry = h.controller.ensureBatch({ force: true });
  h.batchCalls[1].resolve(collectionFor(h.batchCalls[1]));
  await retry;
  assert.equal(h.controller.snapshot().batchStaleConversationIds.size, 0);
});

test("more than 500 bookmarks in one transport chunk produces nonretryable error without reads", async () => {
  const h = harness(), sources = sourcesFor([]);
  sources.basket.bookmarkIds = Array.from({ length: 501 }, (_, i) => "b" + i);
  sources.bookmarks.items = Object.fromEntries(sources.basket.bookmarkIds.map(id => [
    id, { id, conversationId: "a", conversationTitle: "Title a" },
  ]));
  h.update({ mode: "batch", sources });
  await h.controller.ensureBatch();
  assert.equal(h.batchCalls.length, 0);
  assert.equal(h.controller.snapshot().batchLoadError.key, "exportTooManyBookmarks");
  assert.equal(h.controller.snapshot().batchRetryable, false);
});

test("missing source and invalid collection both fail closed", async () => {
  const h = harness();
  h.update({ mode: "batch", sources: { ...sourcesFor(), favorites: null } });
  await h.controller.ensureBatch();
  assert.equal(h.batchCalls.length, 0);
  assert.equal(h.controller.snapshot().batchLoadError.key, "exportSourcesUnavailable");
  h.update({ sources: sourcesFor() });
  const read = h.controller.ensureBatch();
  h.batchCalls[0].resolve({ documents: [documentFor("wrong")] });
  await read;
  assert.equal(h.controller.snapshot().batchDocuments.size, 0);
  assert.equal(h.controller.snapshot().batchLoadError.key, "exportBatchUnavailable");
});


test("late rejected current read cannot replace a newer context with an obsolete failure", async () => {
  const h = harness(), first = h.controller.ensureCurrent();
  h.update({ snapshot: snapshotFor("different") });
  const second = h.controller.ensureCurrent();
  h.currentCalls[0].reject(new Error("obsolete"));
  await first;
  assert.equal(h.controller.snapshot().loadError, null);
  assert.equal(h.controller.snapshot().loading, true);
  h.currentCalls[1].resolve(documentFor("different"));
  await second;
  assert.equal(h.controller.currentReady(), true);
});

test("generic batch invalidation preserves a confirmed failure until explicitly cleared", async () => {
  const h = harness();
  h.update({ mode: "batch" });
  const first = h.controller.ensureBatch();
  h.batchCalls[0].reject(new Error("failed"));
  await first;
  h.controller.invalidateBatch();
  await h.controller.ensureBatch();
  assert.equal(h.batchCalls.length, 1);
  assert.equal(h.controller.snapshot().batchFailedTitles[0], "Title a");
  h.controller.invalidateBatch({ clearError: true });
  const retry = h.controller.ensureBatch();
  assert.equal(h.batchCalls.length, 2);
  h.batchCalls[1].resolve(collectionFor(h.batchCalls[1]));
  await retry;
});

test("search provenance is forwarded for selected ids and mixed provenance fails closed", async () => {
  const h = harness(), sources = sourcesFor([]);
  sources.basket.conversations = ["a", "b"].map(conversationId => ({
    conversationId, sources: ["search"], searchMetadata: { accountKey: "catalog-owner", title: conversationId },
  }));
  h.update({ mode: "batch", sources });
  const first = h.controller.ensureBatch();
  assert.equal(h.batchCalls[0].payload.expectedAccountKey, "owner");
  assert.equal(h.batchCalls[0].payload.searchSelection.accountKey, "catalog-owner");
  assert.deepEqual(Array.from(h.batchCalls[0].payload.searchSelection.conversationIds), ["a", "b"]);
  h.batchCalls[0].resolve(collectionFor(h.batchCalls[0]));
  await first;
  sources.basket.conversations[1].searchMetadata.accountKey = "different-catalog";
  h.update({ sources });
  await h.controller.ensureBatch({ force: true });
  assert.equal(h.batchCalls.length, 1);
  assert.equal(h.controller.snapshot().batchDocuments.size, 0);
  assert.equal(h.controller.snapshot().batchLoadError.key, "exportBatchUnavailable");
});


const pendingImage = (id = "image", readHandle = "image-handle") => ({
  id, type: "image", name: id, alt: id, mimeType: "", sizeBytes: null,
  src: "", pending: true, readHandle, metadata: { label: "owned" },
});
const withImages = (id = "current") => {
  const document = documentFor(id);
  document.conversation.resources = [pendingImage(), pendingImage("second", "second-handle")];
  document.conversation.messages = [{ id: "message", blocks: [{ type: "paragraph", text: "original" }] }];
  return document;
};
const resolvedImage = overrides => ({
  ...pendingImage(), pending: false, src: "https://chatgpt.com/image.png", ...overrides,
});

for (const mode of ["current", "batch"]) {
  test(mode + " documents are deeply frozen owned copies, not writable DTO references", async () => {
    const h = harness(), raw = withImages(mode === "current" ? "current" : "a");
    h.update({ mode });
    const read = mode === "current" ? h.controller.ensureCurrent() : h.controller.ensureBatch();
    if (mode === "current") h.currentCalls[0].resolve(raw);
    else h.batchCalls[0].resolve({ documents: [raw] });
    await read;
    const dto = h.controller.snapshot();
    const owned = mode === "current" ? dto.document : dto.batchDocuments.get("a");
    assert.notEqual(owned, raw);
    assert.equal(Object.isFrozen(raw), false);
    assert.equal(Object.isFrozen(raw.conversation.resources[0]), false);
    for (const node of [owned, owned.conversation, owned.conversation.messages,
      owned.conversation.messages[0], owned.conversation.messages[0].blocks,
      owned.conversation.messages[0].blocks[0], owned.conversation.resources,
      owned.conversation.resources[0], owned.conversation.resources[0].metadata]) {
      assert.equal(Object.isFrozen(node), true);
    }
    assert.equal(Reflect.set(owned.conversation.resources[0], "src", "tampered"), false);
    assert.equal(Reflect.set(owned.conversation.messages[0].blocks[0], "text", "tampered"), false);
    raw.conversation.resources[0].src = "caller-owned edit";
    raw.conversation.messages[0].blocks[0].text = "caller-owned edit";
    assert.equal(owned.conversation.resources[0].src, "");
    assert.equal(owned.conversation.messages[0].blocks[0].text, "original");
    if (mode === "batch") {
      dto.batchDocuments.set("a", raw);
      assert.equal(h.controller.snapshot().batchDocuments.get("a"), owned);
    }
  });
}

test("applyResource owns immutable image updates in current and batch cache with one notification", async () => {
  const h = harness(), raw = withImages();
  h.update({ sources: sourcesFor(["current"]) });
  const current = h.controller.ensureCurrent();
  h.currentCalls[0].resolve(raw);
  await current;
  h.update({ mode: "batch" });
  const batch = h.controller.ensureBatch();
  h.batchCalls[0].resolve({ documents: [raw] });
  await batch;
  const before = h.controller.snapshot(), changed = h.changed(), result = resolvedImage();
  assert.equal(h.controller.applyResource({ accountKey: "owner", readHandle: "image-handle", resource: result }), true);
  const after = h.controller.snapshot();
  assert.equal(h.changed(), changed + 1);
  for (const [oldDocument, document] of [
    [before.document, after.document], [before.batchDocuments.get("current"), after.batchDocuments.get("current")],
  ]) {
    assert.notEqual(document, oldDocument);
    assert.equal(oldDocument.conversation.resources[0].pending, true);
    assert.equal(document.conversation.resources[0].pending, false);
    assert.equal(document.conversation.resources[0].src, result.src);
    assert.equal("readHandle" in document.conversation.resources[0], false);
    assert.equal(Object.isFrozen(document.conversation.resources[0]), true);
    assert.equal(Object.isFrozen(document.conversation.resources[0].metadata), true);
    assert.equal(document.conversation.resources[1], oldDocument.conversation.resources[1]);
    assert.equal(document.conversation.messages, oldDocument.conversation.messages);
  }
  assert.equal(raw.conversation.resources[0].pending, true);
  assert.equal(result.readHandle, "image-handle");
  assert.equal(Object.isFrozen(result), false);
  result.metadata.label = "caller edit";
  assert.equal(after.document.conversation.resources[0].metadata.label, "owned");
  assert.equal(h.controller.applyResource({ accountKey: "owner", readHandle: "image-handle", resource: result }), false);
  assert.equal(h.changed(), changed + 1);
});

test("applyResource rejects stale owner/handle, identity drift, pending or invalid resources", async () => {
  const h = harness(), read = h.controller.ensureCurrent();
  h.currentCalls[0].resolve(withImages());
  await read;
  const before = h.controller.snapshot().document, changed = h.changed();
  const valid = { accountKey: "owner", readHandle: "image-handle", resource: resolvedImage() };
  for (const input of [
    { ...valid, accountKey: "other" }, { ...valid, readHandle: "retired" },
    { ...valid, readHandle: "" }, { ...valid, resource: resolvedImage({ id: "wrong" }) },
    { ...valid, resource: resolvedImage({ type: "file" }) },
    { ...valid, resource: resolvedImage({ pending: true }) },
    { ...valid, resource: resolvedImage({ src: 12 }) },
  ]) {
    assert.equal(h.controller.applyResource(input), false);
  }
  assert.equal(h.controller.snapshot().document, before);
  assert.equal(h.changed(), changed);
  h.controller.suspend();
  const suspendedChanges = h.changed();
  assert.equal(h.controller.applyResource(valid), false);
  assert.equal(h.changed(), suspendedChanges);
});

test("resource handles from replaced documents cannot hydrate a new document version", async () => {
  const h = harness(), first = h.controller.ensureCurrent();
  h.currentCalls[0].resolve(withImages());
  await first;
  const replacement = withImages();
  replacement.conversation.resources[0].readHandle = "new-handle";
  const refresh = h.controller.ensureCurrent({ force: true });
  h.currentCalls[1].resolve(replacement);
  await refresh;
  assert.equal(h.controller.applyResource({
    accountKey: "owner", readHandle: "image-handle", resource: resolvedImage(),
  }), false);
  assert.equal(h.controller.snapshot().document.conversation.resources[0].pending, true);
  assert.equal(h.controller.applyResource({
    accountKey: "owner", readHandle: "new-handle", resource: resolvedImage(),
  }), true);
});


test("snapshot identity and content are owned immutable values, never writable upstream aliases", async () => {
  const h = harness(), raw = snapshotFor();
  h.update({ snapshot: raw });
  const dto = h.controller.snapshot(), owned = dto.snapshot;
  assert.notEqual(owned, raw);
  assert.equal(Object.isFrozen(raw), false);
  assert.equal(Object.isFrozen(raw.conversation), false);
  for (const value of [owned, owned.conversation, owned.conversation.title, owned.adapter,
    owned.messages, owned.messages[0], owned.messages[0].excerpt]) assert.equal(Object.isFrozen(value), true);
  assert.equal(Reflect.set(owned.conversation, "bindingStatus", "unbound"), false);
  assert.equal(Reflect.set(owned.adapter, "responseInProgress", true), false);
  raw.conversation.bindingStatus = "unbound";
  raw.adapter.responseInProgress = true;
  raw.messages[0].excerpt.value = "upstream mutation";
  assert.equal(h.controller.snapshot().snapshot.conversation.bindingStatus, "bound");
  assert.equal(h.controller.snapshot().snapshot.adapter.responseInProgress, false);
  assert.equal(h.controller.snapshot().snapshot.messages[0].excerpt.value, "one");
  const read = h.controller.ensureCurrent();
  assert.equal(h.currentCalls.length, 1);
  h.currentCalls[0].resolve(documentFor("current"));
  await read;
  assert.equal(h.controller.currentReady(), true);
});


test("error notices are deeply immutable owned values and keep diagnostics WeakMap identity", async () => {
  for (const mode of ["current", "batch"]) {
    const h = harness(), rawNotice = { key: "failure", values: { limit: { max: 500 }, labels: ["original"] } };
    const failure = Object.assign(new Error("failed"), { notice: rawNotice });
    h.update({ mode });
    const read = mode === "current" ? h.controller.ensureCurrent() : h.controller.ensureBatch();
    (mode === "current" ? h.currentCalls : h.batchCalls)[0].reject(failure);
    await read;
    const field = mode === "current" ? "loadError" : "batchLoadError";
    const notice = h.controller.snapshot()[field];
    assert.notEqual(notice, rawNotice);
    assert.equal(Object.isFrozen(rawNotice), false);
    for (const value of [notice, notice.values, notice.values.limit, notice.values.labels]) {
      assert.equal(Object.isFrozen(value), true);
    }
    assert.equal(Reflect.set(notice.values.limit, "max", 0), false);
    rawNotice.values.limit.max = 10;
    rawNotice.values.labels[0] = "caller edit";
    assert.equal(notice.values.limit.max, 500);
    assert.equal(notice.values.labels[0], "original");
    assert.equal(h.controller.snapshot()[field], notice);
    assert.equal(h.causeOf(notice), failure);
  }
  const h = harness();
  h.update({ mode: "batch", sources: { ...sourcesFor(), favorites: null } });
  await h.controller.ensureBatch();
  assert.equal(Object.isFrozen(h.controller.snapshot().batchLoadError), true);
});

const responsePending = () => Object.assign(new Error('response still streaming'), { code: 'EXPORT_RESPONSE_PENDING' });

async function pendingCurrent(h) {
  const reading = h.controller.ensureCurrent();
  h.currentCalls.at(-1).reject(responsePending());
  await reading;
}

test('API pending clears document and retries only 400/1000/2000ms before explicit recovery', async () => {
  const h = harness();
  await pendingCurrent(h);
  assert.equal(h.controller.snapshot().currentResponsePending, true);
  assert.equal(h.controller.snapshot().loadError, null);
  assert.equal(h.controller.currentReady(), false);
  for (const [index, delay] of [400, 1000, 2000].entries()) {
    h.update(); await h.controller.ensureCurrent();
    h.advance(delay - 1); assert.equal(h.currentCalls.length, index + 1);
    h.advance(1); assert.equal(h.currentCalls.length, index + 2);
    h.currentCalls.at(-1).reject(responsePending()); await flush();
  }
  assert.equal(h.controller.snapshot().currentResponsePending, false);
  assert.equal(h.controller.snapshot().documentStale, false);
  assert.equal(h.controller.snapshot().loadError.key, 'exportInvalidDocument');
  h.update(); await h.controller.ensureCurrent(); h.advance(10000);
  assert.equal(h.currentCalls.length, 4);
  const retry = h.controller.ensureCurrent({ force: true });
  h.currentCalls.at(-1).resolve(documentFor('current')); await retry;
  assert.equal(h.controller.currentReady(), true);
});

test('snapshot content churn cannot replenish the finite pending budget', async () => {
  const h = harness(); await pendingCurrent(h);
  for (const [index, delay] of [400, 1000, 2000].entries()) {
    for (let repeat = 0; repeat < 3; repeat++) {
      h.update({ snapshot: snapshotFor('current', 'churn-' + index + '-' + repeat) });
      await h.controller.ensureCurrent();
    }
    h.advance(delay);
    assert.equal(h.currentCalls.length, index + 2);
    h.currentCalls.at(-1).reject(responsePending()); await flush();
  }
  h.update({ snapshot: snapshotFor('current', 'after-exhaustion') });
  await h.controller.ensureCurrent(); h.advance(10000);
  assert.equal(h.currentCalls.length, 4);
  assert.equal(h.controller.snapshot().loadError.key, 'exportInvalidDocument');
});

test('native busy pauses pending reads and true-to-false starts one new settled cycle', async () => {
  const h = harness(); await pendingCurrent(h);
  h.update({ snapshot: snapshotFor('current', 'stream', true) });
  await h.controller.ensureCurrent(); h.advance(10000);
  assert.equal(h.currentCalls.length, 1);
  h.update({ snapshot: snapshotFor('current', 'stream', false) });
  await h.controller.ensureCurrent(); h.advance(399);
  assert.equal(h.currentCalls.length, 1);
  h.advance(1); assert.equal(h.currentCalls.length, 2);
  h.currentCalls.at(-1).reject(responsePending()); await flush();
  for (const delay of [400, 1000, 2000]) {
    h.advance(delay); h.currentCalls.at(-1).reject(responsePending()); await flush();
  }
  assert.equal(h.currentCalls.length, 5);
  assert.equal(h.controller.snapshot().loadError.key, 'exportInvalidDocument');
});

for (const boundary of ['hidden', 'mode', 'suspended', 'unverified']) {
  test('pending budget survives ' + boundary + ' and old timer/read cannot publish', async () => {
    const h = harness(); await pendingCurrent(h);
    h.advance(400); assert.equal(h.currentCalls.length, 2);
    if (boundary === 'hidden') h.update({ active: false });
    if (boundary === 'mode') h.update({ mode: 'batch' });
    if (boundary === 'suspended') h.controller.suspend();
    if (boundary === 'unverified') h.update({ verified: false });
    h.currentCalls.at(-1).resolve(documentFor('current')); await flush();
    assert.equal(h.controller.snapshot().document, null);
    h.advance(10000); assert.equal(h.currentCalls.length, 2);
    h.update({ active: true, mode: 'current', verified: true });
    await h.controller.ensureCurrent(); h.advance(999);
    assert.equal(h.currentCalls.length, 2);
    h.advance(1); assert.equal(h.currentCalls.length, 3);
    h.currentCalls.at(-1).reject(responsePending()); await flush();
    h.advance(2000); h.currentCalls.at(-1).reject(responsePending()); await flush();
    assert.equal(h.currentCalls.length, 4);
    assert.equal(h.controller.snapshot().loadError.key, 'exportInvalidDocument');
  });
}

test('last pending retry invalidated in flight never grants a fourth automatic read', async () => {
  const h = harness(); await pendingCurrent(h);
  for (const delay of [400, 1000]) {
    h.advance(delay); h.currentCalls.at(-1).reject(responsePending()); await flush();
  }
  h.advance(2000); assert.equal(h.currentCalls.length, 4);
  h.update({ snapshot: snapshotFor('current', 'content-after-dispatch') });
  h.currentCalls.at(-1).resolve(documentFor('current')); await flush();
  h.advance(10000); await h.controller.ensureCurrent();
  assert.equal(h.currentCalls.length, 4);
  assert.equal(h.controller.snapshot().document, null);
  assert.equal(h.controller.snapshot().loadError.key, 'exportInvalidDocument');
});

test('ordinary failure during pending recovery stops instead of spending remaining retries', async () => {
  const h = harness(); await pendingCurrent(h);
  h.advance(400); h.currentCalls.at(-1).reject(new Error('network')); await flush();
  h.update(); await h.controller.ensureCurrent(); h.advance(10000);
  assert.equal(h.currentCalls.length, 2);
  assert.equal(h.controller.snapshot().currentResponsePending, false);
  assert.equal(h.controller.snapshot().loadError.key, 'exportUnavailable');
});

for (const boundary of ['account', 'routeABA', 'content', 'hidden', 'mode', 'suspended']) {
  test('job pending callback is fenced across ' + boundary, async () => {
    const h = harness(), read = h.controller.ensureCurrent();
    h.currentCalls[0].resolve(documentFor('current')); await read;
    const rejectPending = h.controller.captureResponsePending();
    if (boundary === 'account') { h.update({ accountKey: 'other' }); h.update({ accountKey: 'owner' }); }
    if (boundary === 'routeABA') { h.update({ snapshot: snapshotFor('different') }); h.update({ snapshot: snapshotFor() }); }
    if (boundary === 'content') h.update({ snapshot: snapshotFor('current', 'changed') });
    if (boundary === 'hidden') { h.update({ active: false }); h.update({ active: true }); }
    if (boundary === 'mode') { h.update({ mode: 'batch' }); h.update({ mode: 'current' }); }
    if (boundary === 'suspended') { h.controller.suspend(); h.update(); }
    rejectPending(); h.advance(10000);
    assert.equal(h.controller.snapshot().currentResponsePending, false);
    assert.equal(h.currentCalls.length, 1);
  });
}

test('owned job pending clears cached document and schedules a fresh bounded read', async () => {
  const h = harness(), read = h.controller.ensureCurrent();
  h.currentCalls[0].resolve(documentFor('current')); await read;
  h.controller.captureResponsePending()();
  assert.equal(h.controller.snapshot().document, null);
  assert.equal(h.controller.currentReady(), false);
  assert.equal(h.controller.snapshot().currentResponsePending, true);
  h.advance(400); assert.equal(h.currentCalls.length, 2);
  h.currentCalls.at(-1).resolve(documentFor('current')); await flush();
  assert.equal(h.controller.currentReady(), true);
});

test('batch pending is atomic and only explicit retry can read again', async () => {
  const h = harness(), ids = Array.from({ length: 205 }, (_, index) => 'batch-' + index);
  h.update({ mode: 'batch', sources: sourcesFor(ids) });
  const read = h.controller.ensureBatch();
  h.batchCalls[0].resolve(collectionFor(h.batchCalls[0])); await flush();
  h.batchCalls[1].reject(responsePending()); await read;
  assert.equal(h.controller.snapshot().batchDocuments.size, 0);
  assert.equal(h.controller.snapshot().batchLoadError.key, 'exportInvalidDocument');
  assert.equal(h.controller.snapshot().batchRetryable, true);
  h.update(); await h.controller.ensureBatch(); h.advance(10000);
  assert.equal(h.batchCalls.length, 2);
});
for (const boundary of ['account', 'route']) {
  test('a new ' + boundary + ' resets an exhausted pending cycle', async () => {
    const h = harness(); await pendingCurrent(h);
    for (const delay of [400, 1000, 2000]) {
      h.advance(delay); h.currentCalls.at(-1).reject(responsePending()); await flush();
    }
    assert.equal(h.controller.snapshot().loadError.key, 'exportInvalidDocument');
    if (boundary === 'account') h.update({ accountKey: 'new-owner', sources: sourcesFor(['a'], 'new-owner') });
    else h.update({ snapshot: snapshotFor('different') });
    const read = h.controller.ensureCurrent();
    assert.equal(h.currentCalls.length, 5);
    h.currentCalls.at(-1).reject(responsePending()); await read;
    h.advance(400); assert.equal(h.currentCalls.length, 6);
    h.currentCalls.at(-1).resolve(documentFor(boundary === 'route' ? 'different' : 'current')); await flush();
    assert.equal(h.controller.currentReady(), true);
  });
}

test('continuous 100ms content updates cannot postpone any pending retry deadline', async () => {
  const h = harness(); await pendingCurrent(h);
  let updates = 0;
  for (const [index, delay] of [400, 1000, 2000].entries()) {
    for (let elapsed = 0; elapsed < delay; elapsed += 100) {
      h.advance(100);
      h.update({ snapshot: snapshotFor('current', 'continuous-' + ++updates) });
      await h.controller.ensureCurrent();
    }
    assert.equal(h.currentCalls.length, index + 2);
    // The last update supersedes the just-dispatched read; this also verifies
    // that losing a response does not replenish the charged dispatch budget.
    h.currentCalls.at(-1).reject(responsePending()); await flush();
  }
  h.advance(10000);
  assert.equal(h.currentCalls.length, 4);
  assert.equal(h.controller.snapshot().loadError.key, 'exportInvalidDocument');
});