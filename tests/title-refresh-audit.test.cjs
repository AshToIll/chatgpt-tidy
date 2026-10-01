const assert = require("node:assert/strict");
const test = require("node:test");
const { auditScenario } = require("../tools/audit-title-refresh.cjs");
const { analyzeHar } = require("../tools/audit-title-har.cjs");
const { snapshotHarness } = require("./helpers/adapter-snapshot.cjs");
const START = Date.parse("2026-09-11T00:00:00.000Z");
const entry = (offset, url, status = 200, patch = {}) => ({
  startedDateTime: new Date(START + offset).toISOString(),
  request: { method: "GET", url: `https://chatgpt.com${url}` },
  response: { status }, time: 10, timings: { blocked: 0, dns: 0, connect: 0, send: 0, wait: 10, receive: 0 },
  ...patch,
});

// Characterization of this audit's baseline, not a target to preserve forever.
// A later approved change to refresh/auth policy must update its measured bill.
test("fresh persisted title catalog reentry uses one identity GET and no directory/detail/write", async () => {
  const r = await auditScenario({ name: "fresh", count: 56 });
  assert.deepEqual(r.calls, { identity: 1, directory: 0, detail: 0, write: 0, other: 0 });
  assert.equal(r.db.retainedRows, 56); assert.equal(r.db.generation, 1);
  assert.equal(r.db.pageWrites + r.db.stateWrites, 0); assert.equal(r.first429, null);
  assert.equal(r.ui.some(state => state.signInChanged), false, "unknown binding -> bound is not an account-change event");
});

test("expired catalog reuses one account lookup and stops at its prior head watermark", async () => {
  const r = await auditScenario({ name: "expired", seed: "expired", count: 56 });
  assert.deepEqual(r.calls, { identity: 1, directory: 4, detail: 0, write: 0, other: 0 });
  const pages = r.requests.filter(row => row.kind === "directory");
  assert.equal(new Set(pages.map(row => row.endpoint)).size, pages.length);
  assert.equal(r.db.retainedRows, 56); assert.equal(r.db.generation, 2);
});

test("cold audit waits for the actual enumeration queue rather than its empty cache publication", async () => {
  const r = await auditScenario({ name: "cold", seed: "none", count: 56 });
  assert.equal(r.calls.directory, 5); assert.equal(r.db.pageWrites, 5);
  assert.equal(r.db.retainedRows, 56); assert.equal(r.publications.at(-1).loading, false);
});

test("a persisted rate-limit notice is not evidence of a new HTTP 429", async () => {
  const r = await auditScenario({ name: "old-429", seed: "rate-limited", count: 56 });
  assert.equal(r.finalCatalogIssue, "rate"); assert.equal(r.ui.at(-1).rateLimited, true);
  assert.equal(r.first429, null); assert.equal(r.calls.directory, 0); assert.equal(r.calls.identity, 1);
  assert.ok(r.requests.every(row => row.status === 200));
});

test("account lookup failure neither borrows cached rows nor retries on passive binding events", async () => {
  const r = await auditScenario({ name: "auth-then-old-429", seed: "rate-limited", count: 56,
    accountStatus: 503, bindingEvents: true });
  assert.equal(r.calls.identity, 1); assert.equal(r.finalCatalogIssue, "read");
  assert.equal(r.ui.some(state => state.signInChanged || state.emptyResult), false);
  assert.equal(r.ui.some(state => state.rows > 0 || state.rateLimited), false,
    "without a current account, persisted rows and old errors stay partitioned");
  assert.equal(r.db.retainedRows, 56);
  assert.deepEqual(r.requests.map(row => row.status), [503]);
  assert.equal(r.first429, null); assert.equal(r.calls.directory, 0);
});

test("a newly injected first-page 429 stops immediately and retains all cached rows", async () => {
  const r = await auditScenario({ name: "new-429", seed: "expired", count: 56, firstPageStatus: 429 });
  assert.equal(r.calls.identity, 1); assert.equal(r.calls.directory, 1);
  assert.equal(r.first429.sequence, 2); assert.equal(r.db.retainedRows, 56);
  assert.equal(r.db.pageWrites, 0); assert.equal(r.finalCatalogIssue, "rate");
});

test("shared catalog authentication retains HTTP 429 without erasing persisted rows", async () => {
  const r = await auditScenario({ name: "catalog-auth-429", count: 56, accountStatus: 429 });
  assert.equal(r.first429.endpoint, "/api/auth/session"); assert.equal(r.first429.sequence, 1);
  assert.equal(r.finalCatalogIssue, "rate"); assert.equal(r.calls.directory, 0);
  assert.equal(r.db.retainedRows, 56); assert.equal(r.db.pageWrites + r.db.stateWrites, 0);
});

test("HAR bill ends at first 429 response, including requests started while it was in flight", () => {
  const har = { log: { entries: [entry(0, "/api/auth/session"), entry(5, "/backend-api/conversations", 429,
    { timings: { blocked: 0, dns: 0, connect: 0, send: 0, wait: 100, receive: 2 }, time: 102 }),
  entry(10, "/backend-api/conversations/private-id", 200, { time: 200,
    timings: { blocked: 0, dns: 0, connect: 0, send: 0, wait: 190, receive: 10 } }),
  entry(50, "/some-native-request"), entry(110, "/backend-api/pins")] } };
  const r = analyzeHar(har, { from: new Date(START).toISOString() });
  assert.deepEqual(r.counts, { identity: 1, directory: 1, detail: 1, write: 0, other: 1 });
  assert.equal(r.first429.observedAt, new Date(START + 105).toISOString());
  assert.equal(r.requests[2].statusKnownByCutoff, false);
  assert.equal(r.window.basis, "caller-supplied F5 start");
});

test("HAR attribution and duplicate detection never expose private IDs, headers, URL queries or body text", () => {
  const secret = "do-not-publish-private-value";
  const first = entry(0, `/backend-api/conversations/${secret}?token=${secret}`, 200, {
    _initiator: { stack: { callFrames: [{ url: "chrome-extension://installed/app/page/main-world.bundle.js" }] } },
    response: { status: 200, headers: [{ name: "Cookie", value: secret }], content: { text: JSON.stringify({ title: secret }) } },
  });
  const second = entry(15, `/backend-api/conversations/${secret}?token=${secret}`);
  const r = analyzeHar({ log: { entries: [first, second] } });
  assert.equal(r.duplicates.length, 1); assert.equal(r.byInitiator["tidy-stack"], 1); assert.equal(r.byInitiator.unknown, 1);
  assert.equal(JSON.stringify(r).includes(secret), false);
  assert.equal(r.window.basis, "capture start; NOT asserted to be F5");
  assert.equal(r.first429, null);
});

test("HAR source comparison retains same-field seconds drift after millisecond normalization", () => {
  const id = "private-conversation", title = "private-title", listing = "2026-09-10T09:19:52.817Z";
  const list = entry(0, "/backend-api/conversations", 200, { response: { status: 200,
    content: { text: JSON.stringify({ items: [{ id, title, create_time: "2026-01-01T00:00:00Z", update_time: listing }] }) } } });
  const detailBody = { conversation_id: id, title, create_time: Date.parse("2026-01-01T00:00:00Z") / 1000,
    update_time: Date.parse("2026-09-10T09:19:54.249Z") / 1000 };
  const detail = entry(10, `/backend-api/conversations/${id}`, 200, { response: { status: 200,
    content: { encoding: "base64", text: Buffer.from(JSON.stringify(detailBody)).toString("base64") } } });
  const r = analyzeHar({ log: { entries: [list, detail] } });
  assert.equal(r.timestamps.pairs.length, 1);
  const pair = r.timestamps.pairs[0];
  assert.equal(pair.directoryUpdatedType, "string"); assert.equal(pair.detailUpdatedType, "number");
  assert.equal(pair.normalizedUpdatedDeltaMs, 1432); assert.equal(pair.createdDeltaMs, 0);
  assert.equal(JSON.stringify(r).includes(id), false); assert.equal(JSON.stringify(r).includes(title), false);
  assert.match(r.timestamps.limitation, /no causal proof/);
});

test("HAR timestamps reject mismatched target identity and record sub-millisecond clipping separately", () => {
  const title = "Synthetic", time = 1789031992.8175;
  const list = entry(0, "/backend-api/conversations", 200, { response: { status: 200, content: { text: JSON.stringify({
    items: [{ id: "same", title, create_time: time, update_time: new Date(time * 1000).toISOString() }],
  }) } } });
  const detail = id => entry(10, "/backend-api/conversations/same", 200, { response: { status: 200,
    content: { text: JSON.stringify({ conversation_id: id, title, create_time: time, update_time: time }) } } });
  assert.equal(analyzeHar({ log: { entries: [list, detail("different")] } }).timestamps.detailObservations, 0);
  const pair = analyzeHar({ log: { entries: [list, detail("same")] } }).timestamps.pairs[0];
  assert.equal(pair.normalizedUpdatedDeltaMs, 0); assert.ok(pair.rawUpdatedDeltaMs > 0 && pair.rawUpdatedDeltaMs < 1);
});

test("HAR named caller families separate TIDY fallback, title auth, catalog auth and another extension scan", () => {
  const tidy = functionName => ({ functionName, url: "chrome-extension://private-id/app/page/main-world.bundle.js" });
  const ext = functionName => ({ functionName, url: "chrome-extension://private-id/content/injected.js" });
  const requests = [
    ["/backend-api/conversation/private-id", 404, [ext("window.fetch"), tidy("ensureCurrentConversationMeta")]],
    ["/api/auth/session", 200, [tidy("freshAuth")]],
    ["/api/auth/session", 200, [tidy("loadSession")]],
    ["/backend-api/conversations?offset=100&limit=100&is_archived=false&token=private-id", 200,
      [ext("fetchPage"), ext("loadConversationsByArchivedState")]],
    ["/backend-api/conversations?offset=private-id", 200, [ext("window.fetch")]],
  ].map(([url, status, callFrames], i) => entry(i, url, status, { _initiator: { stack: { callFrames } } }));
  const r = analyzeHar({ log: { entries: requests } });
  assert.deepEqual(r.byFamily, { "tidy-current-metadata": 1, "tidy-title-auth": 1, "tidy-catalog-auth": 1,
    "other-extension-directory-scan": 1, unattributed: 1 });
  assert.deepEqual(r.requests[3].pagination, { offset: 100, limit: 100, is_archived: false });
  assert.deepEqual(r.requests[4].pagination, {});
  assert.deepEqual(r.statusCounts, { 200: 4, 404: 1 });
  assert.equal(JSON.stringify(r).includes("private-id"), false);
});

test("failed current-metadata fallback stops repeated snapshot events within the same scope", async () => {
  let requests = 0;
  const session = snapshotHarness({ url: "https://chatgpt.com/c/fallback-audit", thread: null, sidebar: [],
    messages: [{ id: "message", role: "assistant", record: { id: "message", conversation_id: "fallback-audit",
      author: { role: "assistant" }, create_time: 1_900_300_050 } }],
    fetch: async () => { requests++; return { ok: false, status: 404 }; }, returnSession: true });
  for (let event = 0; event < 97; event++) {
    const snapshot = session.readSnapshot();
    session.readSnapshot(); // Same pending request: not two concurrent requests.
    assert.equal(snapshot.conversation.createdAt.value, null);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(requests, 1, "a failed read is not retried by later snapshot events");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1, "the failure does not schedule its own polling timer");
});

test("HAR counts explicit non-retryable fallback failures without printing error messages or identities", () => {
  const id = "private-id";
  const failure = offset => entry(offset, `/backend-api/conversation/${id}`, 404, {
    _initiator: { stack: { callFrames: [{ functionName: "ensureCurrentConversationMeta",
      url: "chrome-extension://private-id/app/page/main-world.bundle.js" }] } },
    response: { status: 404, content: { text: JSON.stringify({ detail: { code: "conversation_inaccessible",
      can_retry: false, conversation_id: id, message: "private-message" } }) } },
  });
  const r = analyzeHar({ log: { entries: [failure(0), failure(10)] } });
  assert.equal(r.currentMetadataFailures.requests, 2); assert.equal(r.currentMetadataFailures.uniqueTargets, 1);
  assert.equal(r.currentMetadataFailures.explicitNoRetry, 2); assert.equal(r.currentMetadataFailures.inaccessible, 2);
  assert.equal(r.currentMetadataFailures.matchedResponseIdentity, 2);
  assert.equal(JSON.stringify(r).includes("private-id"), false); assert.equal(JSON.stringify(r).includes("private-message"), false);
});
