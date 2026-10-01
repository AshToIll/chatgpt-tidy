// Worker/session/wire diagnostics contract: privacy, sender admission, bounds and durable ordering.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { test } = require("node:test");
const ROOT = path.resolve(__dirname, "..");
const KEY = "tidy.diagnostics.session.v1";
const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const token = value => Number(value).toString(16).padStart(32, "0");
const read = relative => fs.readFileSync(path.join(ROOT, relative), "utf8");
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function storageHarness(initial) {
  const h = { data: initial === undefined ? {} : { [KEY]: copy(initial) }, calls: [],
    getFailures: 0, setFailures: 0, beforeGet: null, beforeSet: null, active: 0, maxActive: 0 };
  async function run(operation, input, action) {
    h.calls.push({ operation, input: copy(input) });
    h.active++; h.maxActive = Math.max(h.maxActive, h.active);
    try {
      const hook = operation === "get" ? h.beforeGet : h.beforeSet;
      if (hook) await hook(input);
      const field = operation === "get" ? "getFailures" : "setFailures";
      if (h[field]) { h[field]--; throw new Error("PRIVATE_STORAGE_ERROR"); }
      return action();
    } finally { h.active--; }
  }
  h.api = {
    get(key) { return run("get", key, () => ({ [key]: copy(h.data[key]) })); },
    set(value) { return run("set", value, () => { Object.assign(h.data, copy(value)); }); },
  };
  return h;
}
function harness(storage = storageHarness(), buildOverrides = null) {
  const context = vm.createContext({ TextEncoder, URL, Uint8Array, crypto: webcrypto });
  const files = [
    "src/messages/build-info.js", "src/messages/notice-registry.js", "src/messages/notice-lifecycle.js",
    "src/messages/diagnostics.js", "src/platform/diagnostics/wire.js",
    "src/platform/navigation/panel-owner.js", "src/platform/diagnostics/session-store.js",
    "src/platform/diagnostics/worker-service.js",
  ];
  for (const file of files) vm.runInContext(read(file)
    .replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/\bexport\s+(?=function|const)/g, ""), context, { filename: file });
  // A narrow fixture can supply a generated enum before the integration build runs.
  if (buildOverrides) context.ChatGPTTidyBuildInfo = Object.freeze({ ...context.ChatGPTTidyBuildInfo, ...buildOverrides });
  const chrome = {
    runtime: { id: EXTENSION_ID, getURL: file => "chrome-extension://" + EXTENSION_ID + "/" + file },
    storage: { session: storage.api },
  };
  const service = context.createDiagnosticsService({ chrome, crypto: webcrypto });
  const wire = context.TidyDiagnosticsWire, build = context.ChatGPTTidyBuildInfo;
  const contract = wire.createContract({ buildInfo: build, registry: context.ChatGPTTidyNoticeRegistry,
    sanitizeCause: input => context.ChatGPTTidyDiagnostics.cause(input) });
  const panel = { id: EXTENSION_ID, url: chrome.runtime.getURL("app/sidepanel/index.html?tidyTabId=7"),
    frameId: 0, documentId: "panel-document", documentLifecycle: "active" };
  const content = { id: EXTENSION_ID, url: "https://chatgpt.com/c/not-retained",
    tab: { id: 7, url: "https://chatgpt.com/c/not-retained" }, frameId: 0,
    documentId: "content-document", documentLifecycle: "active" };
  function request(operation, extra = {}) {
    return { channel: wire.CHANNEL, operation, fingerprint: build.fingerprint, ...extra };
  }
  function raw(sequence = 1, extra = {}) {
    return { eventId: sequence, at: 1800000000000 + sequence, version: build.version, buildFingerprint: build.fingerprint,
      event: "show", surface: "search.error", instanceId: null, messageKey: "searchKeywordIncomplete",
      reasonCode: "SEARCH_UNAVAILABLE", source: "src/features/search/ui/search-view.js",
      requestId: null, navigationIntentId: null, jobId: null, ...extra };
  }
  function event(sequence = 1, extra = {}) {
    const value = contract.project(raw(sequence, extra));
    assert.ok(value, "test fixture must project");
    assert.equal(contract.validEvent(value), true, "test fixture must pass the current wire contract");
    return value;
  }
  const h = { context, storage, service, wire, build, contract, panel, content, request, raw, event };
  h.read = sender => service.handle(request("read"), sender || panel);
  h.clear = sender => service.handle(request("clear"), sender || panel);
  h.record = (contextId, generation, events, sender = content) =>
    service.handle(request("record", { contextId, generation, events }), sender);
  h.handshake = async (contextId = token(1), sender = content) => {
    const result = await h.record(contextId, null, [], sender);
    assert.equal(result.ok, true);
    assert.equal(result.persisted, true);
    assert.match(result.generation, /^[a-f0-9]{32}$/);
    return result.generation;
  };
  return h;
}

test("diagnostics accepts only its independent channel and exact current-build request shapes", async () => {
  const h = harness();
  assert.equal(h.service.matches({ channel: h.wire.CHANNEL }), true);
  assert.equal(h.service.matches({ protocol: "tidy.protocol.v1", kind: "request", type: "diagnostics.read" }), false);
  assert.equal(h.service.matches({ get channel() { throw Error("PRIVATE"); } }), false);
  const valid = h.request("record", { contextId: token(1), generation: null, events: [] });
  assert.equal(h.contract.validRequest(valid), true);
  const invalid = [
    null, [], {}, { ...valid, extra: "PRIVATE" }, { ...valid, fingerprint: "0".repeat(24) },
    { ...valid, contextId: "conversation-business-id" }, { ...valid, contextId: "A".repeat(32) },
    { ...valid, generation: "bad" }, { ...valid, generation: undefined },
    { ...valid, events: [h.event()] }, { ...valid, operation: "append" },
    { ...valid, generation: token(2), events: Array.from({ length: 17 }, (_, i) => h.event(i + 1)) },
    h.request("read", { contextId: token(1) }), h.request("clear", { generation: token(2) }),
    { ...valid, events: "PRIVATE" },
  ];
  for (const message of invalid) {
    assert.equal(h.contract.validRequest(message), false);
    const result = await h.service.handle(message, h.panel);
    assert.equal(result.ok, false);
    assert.equal(result.code, "DIAGNOSTICS_INVALID_REQUEST");
  }
  assert.equal(h.storage.calls.length, 0, "invalid transport never touches session storage");
});

test("sparse arrays and accessor-bearing envelopes fail closed before storage", async () => {
  const h = harness();
  const base = h.request("record", { contextId: token(1), generation: token(2), events: [] });
  const accessor = { ...base };
  Object.defineProperty(accessor, "events", { enumerable: true, get: () => [h.event()] });
  let getterReads = 0;
  const indexAccessor = [h.event()];
  Object.defineProperty(indexAccessor, "0", { enumerable: true, get: () => { getterReads++; return h.event(); } });
  const decorated = [h.event()]; decorated.privateText = "PRIVATE";
  for (const message of [{ ...base, events: Array(1) }, { ...base, events: Array(1000000) },
    { ...base, events: indexAccessor }, { ...base, events: decorated }, accessor]) {
    assert.equal(h.contract.validRequest(message), false);
    const result = await h.service.handle(message, h.panel);
    assert.equal(result.code, "DIAGNOSTICS_INVALID_REQUEST");
  }
  assert.equal(getterReads, 0, "shape validation never evaluates event array accessors");
  assert.equal(h.storage.calls.length, 0);
});

test("content sender requires this extension and an active top-level canonical HTTPS ChatGPT document", async () => {
  const h = harness();
  const malformed = [
    null, {}, { ...h.content, id: undefined }, { ...h.content, id: "other-extension" },
    { ...h.content, frameId: 1 }, { ...h.content, frameId: undefined },
    { ...h.content, documentLifecycle: "cached" }, { ...h.content, documentLifecycle: "prerender" },
    { ...h.content, documentId: "" }, { ...h.content, documentId: undefined },
    { ...h.content, documentId: "x".repeat(129) }, { ...h.content, tab: null },
    { ...h.content, tab: { id: -1 } }, { ...h.content, tab: { id: -0 } },
    { ...h.content, tab: { id: Number.MAX_SAFE_INTEGER + 1 } }, { ...h.content, tab: { id: "7" } },
    ...["http://chatgpt.com/", "https://chatgpt.com.evil.test/", "https://chatgpt.com:444/",
      "https://sub.chatgpt.com/", "https://name:password@chatgpt.com/", "data:text/html,private",
      "chrome-extension://" + EXTENSION_ID + "/app/sidepanel/index.html?tidyTabId=7"]
      .map(url => ({ ...h.content, url })),
  ];
  for (const sender of malformed) {
    const result = await h.record(token(1), null, [], sender);
    assert.deepEqual(copy(result), { ok: false, code: "DIAGNOSTICS_FORBIDDEN" });
  }
  assert.equal(h.storage.calls.length, 0);
  await h.handshake(token(1), h.content);
});

test("only active top-level canonical owner panels may read or clear; content has record-only access", async () => {
  const h = harness();
  const base = "chrome-extension://" + EXTENSION_ID + "/app/sidepanel/index.html";
  const malformed = [
    { ...h.panel, id: "other" }, { ...h.panel, tab: { id: 7 } }, { ...h.panel, tab: null },
    { ...h.panel, frameId: 1 }, { ...h.panel, frameId: null },
    { ...h.panel, documentLifecycle: "cached" }, { ...h.panel, documentId: "" },
    { ...h.panel, documentId: "x".repeat(129) },
    ...[base, base + "?tidyTabId=07", base + "?tidyTabId=-1",
      base + "?tidyTabId=7&tidyTabId=7", base + "?tidyTabId=7&extra=1",
      base + "?tidyTabId=7#fragment", base.replace("index.html", "other.html") + "?tidyTabId=7",
      base.replace(EXTENSION_ID, "other-extension") + "?tidyTabId=7"]
      .map(url => ({ ...h.panel, url })),
    h.content,
  ];
  for (const sender of malformed) {
    for (const operation of ["read", "clear"]) {
      assert.deepEqual(copy(await h.service.handle(h.request(operation), sender)),
        { ok: false, code: "DIAGNOSTICS_FORBIDDEN" });
    }
  }
  assert.equal(h.storage.calls.length, 0);
  assert.equal((await h.read()).ok, true);
  // Chrome may omit frame/document metadata for an extension page without sender.tab.
  assert.equal((await h.read({ id: EXTENSION_ID, url: h.panel.url })).ok, true);
});

test("projection removes free text and business identities while preserving sanitized operation correlations", async () => {
  const h = harness(), secret = "PRIVATE_body_account_conversation_message_https://private.invalid/Error.message";
  const requestId = "req-00000000-0000-4000-8000-000000000001";
  const navigationIntentId = "navigation-1800000000000-abcdef";
  const jobId = "00000000-0000-4000-8000-000000000002";
  const raw = h.raw(1, { requestId, navigationIntentId, jobId, body: secret, accountId: secret,
    conversationId: secret, messageId: secret, url: secret, message: secret, details: { body: secret },
    ownerNode: { body: secret }, reasonCode: "TITLE_RATE_LIMITED" });
  const event = h.contract.project(raw);
  for (const [key, value] of Object.entries({ requestId, navigationIntentId, jobId })) assert.equal(event[key], value);
  assert.equal(JSON.stringify(event).includes(secret), false);
  assert.equal(raw.body, secret, "projection must not mutate its caller");
  const generation = await h.handshake();
  const result = await h.record(token(1), generation, [event]);
  assert.equal(result.accepted, 1);
  const snapshot = (await h.read()).snapshot;
  assert.equal(snapshot.events[0].requestId, requestId);
  assert.equal(snapshot.events[0].contextId, token(1));
  for (const serialized of [JSON.stringify(snapshot), JSON.stringify(h.storage.data)]) {
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes("content-document"), false);
    assert.equal(serialized.includes("not-retained"), false);
    assert.equal(serialized.includes("panel-document"), false);
  }
  const poisoned = h.contract.project(h.raw(2, { reasonCode: secret, source: secret, requestId: secret,
    navigationIntentId: secret, jobId: secret }));
  assert.equal(poisoned.reasonCode, "OBSERVATION_ONLY_UNSPECIFIED");
  assert.equal(poisoned.source, "SOURCE_NOT_REGISTERED");
  for (const key of ["requestId", "navigationIntentId", "jobId"]) assert.equal(poisoned[key], null);
  assert.equal(h.contract.project(h.raw(3, { messageKey: secret })), null);
  assert.equal(h.contract.project(h.raw(3, { surface: secret })), null);
  assert.equal(h.contract.project(h.raw(3, { version: "old-version" })), null);
  assert.equal(h.contract.project(h.raw(3, { buildFingerprint: "0".repeat(24) })), null);
});

test("worker validates each projected field instead of trusting a client-sanitized record", async () => {
  const h = harness(), good = h.event(), badEvents = [
    { ...good, extra: "PRIVATE" }, { ...good, message: "PRIVATE" }, { ...good, sequence: 0 },
    { ...good, sequence: -0 }, { ...good, sequence: 1.5 }, { ...good, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...good, at: Infinity }, { ...good, at: -1 }, { ...good, event: "update" },
    { ...good, surface: "private" }, { ...good, messageKey: "private" }, { ...good, reasonCode: "private" },
    { ...good, source: "https://private.invalid/" }, { ...good, requestId: "conversation-business-id" },
    { ...good, instanceId: "node-0" }, { ...good, instanceId: "business-node" },
    { ...good, clearReasonCode: "NOTICE_REPLACED" }, { ...good, event: "clear", clearReasonCode: null },
  ];
  for (const event of badEvents) {
    assert.equal(h.contract.validEvent(event), false);
    assert.equal((await h.record(token(1), token(2), [event])).code, "DIAGNOSTICS_INVALID_REQUEST");
  }
  assert.equal(h.storage.calls.length, 0);
  const clear = h.event(2, { event: "clear", clearReasonCode: "NOTICE_REPLACED" });
  assert.equal(h.contract.validEvent(clear), true);
});

test("sequence cursors are per-context, accept gaps and reject duplicate or older events across restart", async () => {
  const h = harness(), generation = await h.handshake();
  assert.equal((await h.record(token(1), generation, [h.event(1), h.event(4), h.event(2), h.event(4), h.event(5)])).accepted, 3);
  assert.equal((await h.record(token(2), generation, [h.event(1)])).accepted, 1);
  const restarted = harness(h.storage);
  assert.equal(await restarted.handshake(), generation);
  assert.equal((await restarted.record(token(1), generation, [restarted.event(4), restarted.event(6)])).accepted, 1);
  const snapshot = (await restarted.read()).snapshot;
  assert.deepEqual(copy(snapshot.events).map(e => [e.contextId, e.sequence]),
    [[token(1), 1], [token(1), 4], [token(1), 5], [token(2), 1], [token(1), 6]]);
  assert.equal(snapshot.dropped.duplicateOrOutOfOrder, 3);
  const detached = await restarted.read();
  detached.snapshot.events[0].messageKey = "PRIVATE";
  assert.equal((await restarted.read()).snapshot.events[0].messageKey, "searchKeywordIncomplete");
});

test("record count is capped at 512 and capacity eviction never fabricates a clear lifecycle event", async () => {
  const h = harness(), generation = await h.handshake();
  for (let offset = 0; offset < 544; offset += 16) {
    const events = Array.from({ length: 16 }, (_, i) => h.event(offset + i + 1));
    assert.equal((await h.record(token(1), generation, events)).ok, true);
  }
  const snapshot = (await h.read()).snapshot;
  assert.equal(snapshot.limit, 512);
  assert.equal(snapshot.byteLimit, 256 * 1024);
  assert.equal(snapshot.events.length, 512);
  assert.equal(snapshot.events[0].sequence, 33);
  assert.equal(snapshot.dropped.capacity, 32);
  assert.ok(snapshot.events.every(event => event.event === "show"));
  assert.ok(snapshot.storedBytes <= snapshot.byteLimit);
  const restarted = harness(h.storage);
  assert.equal(await restarted.handshake(), generation);
  assert.equal((await restarted.record(token(1), generation, [restarted.event(1), restarted.event(544)])).accepted, 0);
  assert.equal((await restarted.read()).snapshot.events.length, 512, "history eviction retains its context high-water cursor");
});

test("serialized session bytes stay within 256 KiB even when valid records have maximal metadata", async () => {
  const h = harness(), generation = await h.handshake();
  const longest = values => [...values].sort((a, b) => b.length - a.length)[0];
  const extra = { messageKey: longest(h.build.messageKeys), reasonCode: longest(h.build.reasonCodes),
    source: longest(h.build.sources), instanceId: "node-999999999999999",
    requestId: "export-job-00000000-0000-4000-8000-000000000001",
    navigationIntentId: "navigation-00000000-0000-4000-8000-000000000002",
    jobId: "00000000-0000-4000-8000-000000000003" };
  for (let offset = 0; offset < 512; offset += 16) {
    await h.record(token(1), generation, Array.from({ length: 16 }, (_, i) => h.event(offset + i + 1, extra)));
  }
  const snapshot = (await h.read()).snapshot;
  const bytes = Buffer.byteLength(JSON.stringify(h.storage.data[KEY]), "utf8");
  assert.equal(snapshot.storedBytes, bytes);
  assert.ok(bytes <= 262144);
  assert.ok(snapshot.events.length < 512, "byte limit, not only the record count, must evict long valid entries");
  assert.equal(snapshot.dropped.capacity, 512 - snapshot.events.length);
  assert.ok(snapshot.events.every(event => event.event === "show"));
});

test("128-context cursor bound removes evicted context records without retaining sender identities", async () => {
  const h = harness(), generation = await h.handshake();
  for (let index = 1; index <= 129; index++) {
    assert.equal((await h.record(token(index), generation, [h.event(1)])).accepted, 1);
  }
  const saved = h.storage.data[KEY], snapshot = (await h.read()).snapshot;
  assert.equal(saved.contexts.length, 128);
  assert.equal(saved.contexts[0].contextId, token(2));
  assert.equal(snapshot.events.length, 128);
  assert.equal(snapshot.events.some(event => event.contextId === token(1)), false);
  assert.equal(snapshot.dropped.capacity, 1);
  const cursors = new Map(saved.contexts.map(context => [context.contextId, context.sequence]));
  for (const entry of saved.events) assert.ok(cursors.has(entry.contextId) && entry.event.sequence <= cursors.get(entry.contextId));
  const restarted = harness(h.storage);
  assert.equal(await restarted.handshake(), generation);
  for (const boundary of [2, 129]) {
    assert.equal((await restarted.record(token(boundary), generation, [restarted.event(1)])).accepted, 0);
  }
  const resumed = (await restarted.read()).snapshot;
  assert.equal(resumed.events.length, 128);
  assert.equal(resumed.dropped.duplicateOrOutOfOrder, 2);
  assert.equal(new Set(resumed.events.map(event => event.contextId + ":" + event.sequence)).size, 128);
});

test("cold hydrate, concurrent writes and read share one serialized storage tail", async () => {
  const h = harness(), gate = deferred(), entered = deferred();
  h.storage.beforeGet = async () => { entered.resolve(); await gate.promise; };
  const startup = h.handshake();
  const readDuringHydrate = h.read();
  await entered.promise;
  assert.deepEqual(h.storage.calls.map(call => call.operation), ["get"]);
  gate.resolve();
  const generation = await startup;
  assert.equal((await readDuringHydrate).ok, true);
  const block = deferred(), writeEntered = deferred();
  let first = true;
  h.storage.beforeSet = async () => { if (first) { first = false; writeEntered.resolve(); await block.promise; } };
  const one = h.record(token(1), generation, [h.event(1)]);
  const two = h.record(token(1), generation, [h.event(2)]);
  const three = h.record(token(2), generation, [h.event(1)]);
  const finalRead = h.read();
  await writeEntered.promise;
  assert.equal(h.storage.data[KEY].events.length, 0, "inflight writes are not published in storage");
  block.resolve();
  assert.deepEqual((await Promise.all([one, two, three])).map(result => result.accepted), [1, 1, 1]);
  assert.deepEqual(copy((await finalRead).snapshot.events).map(e => [e.contextId, e.sequence]),
    [[token(1), 1], [token(1), 2], [token(2), 1]]);
  assert.equal(h.storage.maxActive, 1);
});

test("clear is a durable generation barrier; delayed old packets stay rejected after worker restart", async () => {
  const h = harness(), generation = await h.handshake(), gate = deferred(), entered = deferred();
  let first = true;
  h.storage.beforeSet = async () => { if (first) { first = false; entered.resolve(); await gate.promise; } };
  const before = h.record(token(1), generation, [h.event(1)]);
  const clear = h.clear();
  const old = h.record(token(1), generation, [h.event(2)]);
  const snapshotPromise = h.read();
  await entered.promise;
  gate.resolve();
  assert.equal((await before).accepted, 1);
  const cleared = await clear;
  assert.equal(cleared.ok, true);
  assert.notEqual(cleared.snapshot.generation, generation);
  assert.equal(cleared.snapshot.events.length, 0);
  assert.deepEqual(copy(await old), { ok: false, code: "DIAGNOSTICS_STALE_GENERATION", generation: cleared.snapshot.generation });
  const snapshot = (await snapshotPromise).snapshot;
  assert.equal(snapshot.events.length, 0);
  assert.equal(snapshot.dropped.staleGeneration, 1);
  const restarted = harness(h.storage);
  assert.equal(await restarted.handshake(), cleared.snapshot.generation);
  assert.equal((await restarted.record(token(1), generation, [restarted.event(3)])).code, "DIAGNOSTICS_STALE_GENERATION");
  assert.equal((await restarted.read()).snapshot.events.length, 0);
  assert.equal((await restarted.record(token(1), cleared.snapshot.generation, [restarted.event(4)])).accepted, 1);
});

test("failed session get/set does not claim persistence and does not poison the operation queue", async () => {
  const h = harness();
  h.storage.getFailures = 1;
  assert.deepEqual(copy(await h.read()), { ok: false, code: "DIAGNOSTICS_STORAGE_FAILED" });
  const generation = await h.handshake();
  assert.equal((await h.read()).snapshot.storageFailures, 1);
  h.storage.setFailures = 1;
  assert.deepEqual(copy(await h.record(token(1), generation, [h.event(1)])),
    { ok: false, code: "DIAGNOSTICS_STORAGE_FAILED" });
  let snapshot = (await h.read()).snapshot;
  assert.equal(snapshot.events.length, 0);
  assert.equal(snapshot.storageFailures, 2);
  assert.equal(h.storage.data[KEY].contexts.length, 0, "failed writes must not advance sequence cursors");
  assert.equal((await h.record(token(1), generation, [h.event(1)])).accepted, 1);
  h.storage.setFailures = 1;
  assert.deepEqual(copy(await h.clear()), { ok: false, code: "DIAGNOSTICS_STORAGE_FAILED" });
  snapshot = (await h.read()).snapshot;
  assert.equal(snapshot.generation, generation);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.storageFailures, 3);
  assert.equal((await h.record(token(1), generation, [h.event(2)])).accepted, 1);
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE_STORAGE_ERROR"), false);
});

test("initialization write failure remains unpersisted until a later operation succeeds", async () => {
  const h = harness();
  h.storage.setFailures = 1;
  assert.deepEqual(copy(await h.record(token(1), null, [])), { ok: false, code: "DIAGNOSTICS_STORAGE_FAILED" });
  assert.equal(h.storage.data[KEY], undefined);
  await h.handshake();
  assert.equal((await h.read()).snapshot.persisted, true);
  assert.equal((await h.read()).snapshot.storageFailures, 1);
});

test("corrupt, extra-field and other-build session state is replaced instead of leaking through read", async () => {
  const initial = harness();
  const generation = await initial.handshake();
  await initial.record(token(1), generation, [initial.event(1)]);
  const valid = copy(initial.storage.data[KEY]);
  const corrupt = [
    { ...valid, privateText: "PRIVATE" }, { ...valid, fingerprint: "f".repeat(24) },
    { ...valid, version: "old" }, { ...valid, generation: "bad" },
    { ...valid, contexts: [] },
    { ...valid, contexts: [{ contextId: token(1), sequence: 1 }], events: [{ contextId: token(1), event: initial.event(2) }] },
    { ...valid, events: [...valid.events, ...valid.events] },
    { ...valid, revision: -1 }, { ...valid, contexts: [...valid.contexts, ...valid.contexts] },
    { ...valid, events: [{ contextId: token(1), event: { ...valid.events[0].event, body: "PRIVATE" } }] },
    { ...valid, events: Array(513).fill(valid.events[0]) },
  ];
  for (const state of corrupt) {
    const h = harness(storageHarness(state)), result = await h.read();
    assert.equal(result.ok, true);
    assert.equal(result.snapshot.events.length, 0);
    assert.notEqual(result.snapshot.generation, generation);
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
    assert.equal(JSON.stringify(h.storage.data).includes("PRIVATE"), false);
  }
});

test("worker diagnostics integration retains one onMessage owner and no storage/network work in the observer", () => {
  const worker = read("src/app/background/service-worker.js");
  assert.equal((worker.match(/chrome\.runtime\.onMessage\.addListener\s*\(/g) || []).length, 1);
  for (const relative of ["src/platform/diagnostics/worker-service.js", "src/platform/diagnostics/session-store.js",
    "src/platform/diagnostics/wire.js"]) {
    assert.doesNotMatch(read(relative), /onMessage\.addListener|setAccessLevel|\bfetch\s*\(|XMLHttpRequest/);
  }
  assert.doesNotMatch(read("src/messages/diagnostics.js"),
    /chrome\.storage|\b(?:fetch|XMLHttpRequest|setTimeout|setInterval)\s*\(/);
});


test("safe typed cause metadata survives projection while unknown strings and scalar coercions are removed", async () => {
  const h = harness(storageHarness(), { stageCodes: ["catalog"] });
  const safe = { stage: "catalog", disconnect: "connection-closed", status: 429, retryable: false };
  const event = h.event(1, safe);
  for (const [key, value] of Object.entries(safe)) assert.equal(event[key], value);
  const generation = await h.handshake();
  assert.equal((await h.record(token(1), generation, [event])).accepted, 1);
  const stored = (await h.read()).snapshot.events[0];
  for (const [key, value] of Object.entries(safe)) assert.equal(stored[key], value);
  const poisoned = h.contract.project(h.raw(2, { stage: "PRIVATE", disconnect: "PRIVATE", status: "429", retryable: "false" }));
  for (const key of ["stage", "disconnect", "status", "retryable"]) assert.equal(poisoned[key], null);
  for (const [key, values] of Object.entries({ stage: ["PRIVATE"], disconnect: ["PRIVATE"],
    status: [99, 600, 429.5, Infinity, "429"], retryable: [0, 1, "false", "true"] })) {
    for (const value of values) assert.equal(h.contract.validEvent({ ...event, [key]: value }), false);
  }
  for (const status of [100, 599]) assert.equal(h.event(3, { status }).status, status);
  for (const disconnect of ["context-invalidated", "receiver-missing", "connection-closed"])
    assert.equal(h.event(3, { disconnect }).disconnect, disconnect);
});

test("snapshot wire validation rejects private fields and impossible metadata rather than trusting worker-shaped JSON", async () => {
  const h = harness(), generation = await h.handshake();
  await h.record(token(1), generation, [h.event(1)]);
  const snapshot = copy((await h.read()).snapshot);
  assert.equal(h.contract.validSnapshot(snapshot), true);
  const bad = [
    { ...snapshot, body: "PRIVATE" }, { ...snapshot, persisted: false },
    { ...snapshot, generation: "PRIVATE" }, { ...snapshot, lifetime: "forever" },
    { ...snapshot, storedBytes: 262145 }, { ...snapshot, limit: 513 },
    { ...snapshot, revision: -1 }, { ...snapshot, storageFailures: -1 },
    { ...snapshot, queueRejectedOperations: -1 }, { ...snapshot, queueDroppedEvents: -1 },
    { ...snapshot, queueRejectedOperations: 0.5 }, { ...snapshot, queueDroppedEvents: "1" },
    { ...snapshot, buildFingerprint: "0".repeat(24) },
    { ...snapshot, dropped: { ...snapshot.dropped, details: "PRIVATE" } },
    { ...snapshot, events: [{ ...snapshot.events[0], contextId: "conversation-business-id" }] },
    { ...snapshot, events: [{ ...snapshot.events[0], message: "PRIVATE" }] },
    { ...snapshot, events: Array(1) },
  ];
  for (const value of bad) assert.equal(h.contract.validSnapshot(value), false);
});

test("successive clears retire every older generation even if a stale-packet counter write fails", async () => {
  const h = harness(), firstGeneration = await h.handshake();
  await h.record(token(1), firstGeneration, [h.event(1)]);
  const secondGeneration = (await h.clear()).snapshot.generation;
  await h.record(token(1), secondGeneration, [h.event(2)]);
  const thirdGeneration = (await h.clear()).snapshot.generation;
  assert.equal(new Set([firstGeneration, secondGeneration, thirdGeneration]).size, 3);
  h.storage.setFailures = 1;
  assert.equal((await h.record(token(1), firstGeneration, [h.event(3)])).code, "DIAGNOSTICS_STORAGE_FAILED");
  const afterFailure = (await h.read()).snapshot;
  assert.equal(afterFailure.generation, thirdGeneration);
  assert.equal(afterFailure.events.length, 0);
  const restarted = harness(h.storage);
  assert.equal(await restarted.handshake(), thirdGeneration);
  for (const old of [firstGeneration, secondGeneration]) {
    assert.equal((await restarted.record(token(1), old, [restarted.event(4)])).code, "DIAGNOSTICS_STALE_GENERATION");
  }
  assert.equal((await restarted.read()).snapshot.events.length, 0);
  assert.equal((await restarted.record(token(1), thirdGeneration, [restarted.event(5)])).accepted, 1);
  assert.deepEqual(copy((await restarted.read()).snapshot.events).map(event => event.sequence), [5]);
});

test("slow session storage admits at most 32 operations and releases capacity after rejection and failed writes", { timeout: 5000 }, async () => {
  const h = harness(), generation = await h.handshake(), gate = deferred(), entered = deferred();
  assert.equal(h.wire.limits.queuedOperations, 32);
  let first = true;
  h.storage.beforeSet = async () => { if (first) { first = false; entered.resolve(); await gate.promise; } };
  // Include the blocked inflight operation in the bounded worker queue.
  const pending = [h.record(token(1), generation, [h.event(1)])];
  await entered.promise;
  for (let index = 1; index < 32; index++) pending.push(h.record(token(1), generation, []));
  const baselineCalls = h.storage.calls.length;
  const rejected = await Promise.all([h.read(), h.clear(), h.record(token(1), generation, [h.event(2)])]);
  for (const result of rejected) assert.deepEqual(copy(result), { ok: false, code: "DIAGNOSTICS_CAPACITY" });
  assert.equal(h.storage.calls.length, baselineCalls, "rejected operations never reach session storage");
  assert.equal(h.storage.data[KEY].generation, generation, "a capacity-rejected clear is not a successful clear");
  assert.equal(h.storage.data[KEY].events.length, 0);
  h.storage.setFailures = 1;
  gate.resolve();
  const results = await Promise.all(pending);
  assert.equal(results[0].code, "DIAGNOSTICS_STORAGE_FAILED");
  assert.ok(results.slice(1).every(result => result.ok && result.accepted === 0));
  let snapshot = (await h.read()).snapshot;
  assert.equal(snapshot.queueRejectedOperations, 3);
  assert.equal(snapshot.queueDroppedEvents, 1, "zero-event read/clear rejection must not invent dropped records");
  assert.equal(snapshot.storageFailures, 1);
  assert.equal(snapshot.events.length, 0);
  assert.equal(h.contract.validSnapshot(snapshot), true);
  assert.equal((await h.record(token(1), generation, [h.event(1), h.event(2)])).accepted, 2,
    "both the rejected operation and failed write release their queue slots without advancing cursors");
  snapshot = (await h.read()).snapshot;
  assert.equal(snapshot.queueRejectedOperations, 3);
  assert.equal(snapshot.queueDroppedEvents, 1);
  assert.deepEqual(copy(snapshot.events).map(event => event.sequence), [1, 2]);
  assert.equal(Object.hasOwn(h.storage.data[KEY], "queueRejectedOperations"), false);
  assert.equal(Object.hasOwn(h.storage.data[KEY], "queueDroppedEvents"), false);
  const restarted = harness(h.storage), restored = (await restarted.read()).snapshot;
  assert.equal(restored.queueRejectedOperations, 0, "queue counters describe this worker instance, not previous workers");
  assert.equal(restored.queueDroppedEvents, 0);
  assert.deepEqual(copy(restored.events).map(event => event.sequence), [1, 2]);
});

test("slow session storage caps queued events at 128 independently of operation count and counts exact rejected batches", { timeout: 5000 }, async () => {
  const h = harness(), generation = await h.handshake(), gate = deferred(), entered = deferred();
  assert.equal(h.wire.limits.queuedEvents, 128);
  let first = true;
  h.storage.beforeSet = async () => { if (first) { first = false; entered.resolve(); await gate.promise; } };
  const pending = [];
  for (let batch = 0; batch < 8; batch++) {
    pending.push(h.record(token(1), generation, Array.from({ length: 16 }, (_, index) => h.event(batch * 16 + index + 1))));
  }
  await entered.promise;
  const baselineCalls = h.storage.calls.length;
  assert.equal((await h.record(token(1), generation, [h.event(129)])).code, "DIAGNOSTICS_CAPACITY");
  assert.equal((await h.record(token(1), generation,
    Array.from({ length: 16 }, (_, index) => h.event(130 + index)))).code, "DIAGNOSTICS_CAPACITY");
  assert.equal(h.storage.calls.length, baselineCalls);
  // Reads carry no events, so event saturation alone must not reject them.
  const readAtCapacity = h.read();
  gate.resolve();
  const results = await Promise.all(pending);
  assert.ok(results.every(result => result.ok && result.accepted === 16));
  const snapshot = (await readAtCapacity).snapshot;
  assert.equal(snapshot.events.length, 128);
  assert.equal(snapshot.queueRejectedOperations, 2);
  assert.equal(snapshot.queueDroppedEvents, 17);
  assert.equal(snapshot.storageFailures, 0);
  assert.equal(h.contract.validSnapshot(snapshot), true);
  assert.equal((await h.record(token(1), generation, [h.event(129)])).accepted, 1);
  const recovered = (await h.read()).snapshot;
  assert.equal(recovered.events.length, 129);
  assert.equal(recovered.events.at(-1).sequence, 129);
  assert.equal(recovered.queueRejectedOperations, 2);
  assert.equal(recovered.queueDroppedEvents, 17);
  assert.equal(h.storage.maxActive, 1);
});
