const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { installPageSession } = require("./helpers/page-session.cjs");
const flush = () => new Promise(setImmediate);

function libraryFor(accountKey, revision = 1, epoch = 0, documentId = "document") {
  return { accountKey, identity: { documentId, epoch }, favorites: { accountKey, revision, items: {}, groups: [] },
    bookmarks: { accountKey, revision, items: {}, groups: [] } };
}

function harness({ hidden = false, clock = null } = {}) {
  const windowEvents = new Map(), documentEvents = new Map(), runtimeListeners = [], snapshotListeners = [], identityListeners = [];
  const requests = [];
  const document = { hidden, addEventListener(name, callback) { documentEvents.set(name, callback); } };
  const context = vm.createContext({
    AbortController,
    Date: clock?.Date || Date,
    setTimeout: clock?.setTimeout || ((fn, ms) => setTimeout(fn, ms).unref()), clearTimeout: clock?.clearTimeout || clearTimeout,
    document, location: { pathname: "/c/one" },
    addEventListener(name, callback) { windowEvents.set(name, callback); },
    removeEventListener(name, callback) { if (windowEvents.get(name) === callback) windowEvents.delete(name); },
    TidyContentBridge: { onSnapshot(callback) { snapshotListeners.push(callback); }, onLibraryIdentityChanged(callback) {
      identityListeners.push(callback); return () => identityListeners.splice(identityListeners.indexOf(callback), 1);
    } },
    chrome: { runtime: {
      id: "test-extension",
      onMessage: { addListener(callback) { runtimeListeners.push(callback); },
        removeListener(callback) { const i = runtimeListeners.indexOf(callback); if (i >= 0) runtimeListeners.splice(i, 1); } },
      sendMessage(envelope) { return new Promise((resolve, reject) => requests.push({ envelope, resolve, reject })); },
    } },
  });
  for (const file of ["src/platform/protocol.js", "src/platform/library/library-hydration.js", "src/platform/library/content/library-client.js"]) {
    if (file === "src/platform/library/content/library-client.js") installPageSession(context, { runtime: true });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, "..", file), "utf8"), context, { filename: file });
  }
  function resolve(index, value) {
    const { envelope, resolve } = requests[index];
    resolve(context.TidyProtocol.response(envelope, value));
  }
  return { client: context.TidyLibraryClient, protocol: context.TidyProtocol, requests, resolve, session: context.TidyPageSession,
    runtime: context.chrome.runtime, runtimeListeners, identityListeners, windowEvents,
    focus() { windowEvents.get("focus")?.(); },
    visible(value) { document.hidden = !value; documentEvents.get("visibilitychange")?.(); },
    pagehide() { windowEvents.get("pagehide")?.(); },
    localIdentity(value) { identityListeners.forEach(callback => callback(value)); },
    identity(accountKey, epoch, documentId = "document") {
      this.event(this.protocol.Type.LIBRARY_IDENTITY_CHANGED, { accountKey, epoch, documentId, phase: accountKey ? "ready" : "unavailable" });
    },
    snapshot(pathname) { snapshotListeners.forEach((callback) => callback({ route: { pathname } })); },
    event(type, payload) { runtimeListeners.forEach((callback) => callback(context.TidyProtocol.event(type, payload))); },
  };
}

test("two presenters share initialization and ordinary focus preserves rows without another read", async () => {
  const h = harness();
  const seen = [[], []];
  h.client.subscribe((value) => seen[0].push(value));
  h.client.subscribe((value) => seen[1].push(value));
  h.client.refresh(); h.client.refresh();
  await flush();
  assert.equal(h.requests.length, 1);
  h.resolve(0, libraryFor("account-one")); await flush();
  assert.equal(seen[0].at(-1).accountKey, "account-one");
  assert.equal(seen[1].at(-1).accountKey, "account-one");
  h.focus();
  const before = h.client.current(); assert.equal(before.accountKey, "account-one");
  await flush();
  assert.equal(h.requests.length, 1); assert.equal(h.client.current(), before);
  assert.equal(seen[0].length, 2, "focus does not publish a temporary null");
});

test("departing page identity clears private markers without requesting the outgoing account again", async () => {
  const h = harness(); await flush(); h.resolve(0, libraryFor('one')); await flush();
  const lease = h.client.capture();
  h.event(h.protocol.Type.LIBRARY_IDENTITY_CHANGED, { documentId: 'document', epoch: 1, phase: 'unavailable', accountKey: null, transition: 'document-hidden' });
  await flush(); assert.equal(h.client.current(), null); assert.equal(h.client.owns(lease), false);
  assert.equal(h.requests.length, 1);
  // BFCache 恢复仍需新的 ready 证据，不能靠焦点或旧 lease 复活。
  h.visible(true); h.focus(); await flush(); assert.equal(h.requests.length, 1);
  h.identity('one', 2); await flush(); assert.equal(h.requests.length, 2);
  h.resolve(1, libraryFor('one', 1, 2)); await flush(); assert.equal(h.client.current().identity.epoch, 2);
});

test("same-epoch departure revokes a pending content refresh and its late reply", async () => {
  const h = harness(); await flush(); h.resolve(0, libraryFor("one")); await flush();
  h.identity(null, 1); await flush(); assert.equal(h.requests.length, 2);
  h.event(h.protocol.Type.LIBRARY_IDENTITY_CHANGED, {
    documentId: "document", epoch: 1, phase: "unavailable", transition: "document-hidden",
  });
  h.resolve(1, libraryFor("one", 1, 1)); await flush();
  assert.equal(h.client.current(), null); assert.equal(h.requests.length, 2);
  h.identity("one", 2); await flush(); assert.equal(h.requests.length, 3);
  h.resolve(2, libraryFor("one", 1, 2)); await flush(); assert.equal(h.client.current().identity.epoch, 2);
});

test("ordinary visibility changes retain the shared owner and do not cancel initial loading", async () => {
  const h = harness(); await flush();
  h.visible(false);
  h.resolve(0, libraryFor("old-account")); await flush();
  assert.equal(h.client.current().accountKey, "old-account");
  h.event(h.protocol.Type.FAVORITES_UPDATED, { accountKey: "old-account", revision: 2 });
  await flush(); assert.equal(h.requests.length, 2, "a real revision event may refresh local storage while hidden");
  h.visible(true); h.focus(); await flush();
  assert.equal(h.requests.length, 2, "visibility and focus add no reads");
  h.resolve(1, libraryFor("old-account", 2)); await flush();
  assert.equal(h.client.current().accountKey, "old-account");
});

test("twenty route/focus/visibility transitions retain ownership, leases and object references without reads", async () => {
  const h = harness(); await flush();
  h.resolve(0, libraryFor("one")); await flush();
  const before = h.client.current(), lease = h.client.capture("favorites"), seen = [];
  h.client.subscribe(value => seen.push(value));
  for (let i = 0; i < 20; i++) { h.snapshot(`/c/chat-${i}`); h.visible(false); h.visible(true); h.focus(); }
  await flush(); assert.equal(h.requests.length, 1);
  assert.equal(h.client.current(), before); assert.equal(h.client.owns(lease), true); assert.equal(seen.length, 1);
});

test("invalidation payloads are metadata only; foreign events cannot replace the visible library", async () => {
  const h = harness(); await flush();
  h.resolve(0, libraryFor("one")); await flush();
  h.event(h.protocol.Type.FAVORITES_UPDATED, { accountKey: "foreign", revision: 2, items: { private: {} } });
  await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.client.current().accountKey, "one");
  h.event(h.protocol.Type.FAVORITES_UPDATED, { accountKey: "one", revision: 2 });
  assert.equal(h.client.current().accountKey, "one"); await flush();
  h.resolve(1, libraryFor("one", 2)); await flush();
  assert.equal(h.client.current().favorites.revision, 2);
});

test("mutation leases inject the captured account and reject owner changes before or after dispatch", async () => {
  const h = harness(); await flush();
  h.resolve(0, libraryFor("one")); await flush();
  const lease = h.client.capture("favorites");
  const pending = h.client.request(h.protocol.Type.FAVORITES_TOGGLE_SIDEBAR, { conversationId: "chat" }, lease);
  const rejected = assert.rejects(pending, (error) => error.code === "CONTEXT_MISMATCH");
  await flush();
  assert.equal(h.requests[1].envelope.payload.expectedAccountKey, "one");
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[1].envelope.payload.expectedIdentity)), { documentId: "document", epoch: 0 });
  h.identity(null, 1);
  h.resolve(1, libraryFor("one", 2).favorites);
  await rejected;
  assert.equal(h.client.current(), null);
  await assert.rejects(h.client.request(h.protocol.Type.FAVORITES_TOGGLE_SIDEBAR, {}, lease));
  assert.equal(h.requests.filter(value => value.envelope.type === h.protocol.Type.FAVORITES_TOGGLE_SIDEBAR).length, 1,
    "the old lease cannot dispatch a second write");
});

test("out-of-order same-owner mutation responses cannot roll a module revision backwards", async () => {
  const h = harness(); await flush();
  h.resolve(0, libraryFor("one")); await flush();
  const lease = h.client.capture("favorites");
  const first = h.client.request(h.protocol.Type.FAVORITES_TOGGLE_SIDEBAR, { conversationId: "a" }, lease);
  const second = h.client.request(h.protocol.Type.FAVORITES_TOGGLE_SIDEBAR, { conversationId: "b" }, lease);
  await flush();
  h.resolve(2, libraryFor("one", 3).favorites); await second;
  h.resolve(1, libraryFor("one", 2).favorites); await first;
  assert.equal(h.client.current().favorites.revision, 3);
});

test("partial local availability preserves the healthy module, but mismatched owners are rejected", async () => {
  const h = harness(); await flush();
  h.resolve(0, { ...libraryFor("one"), bookmarks: null, errors: { bookmarks: { code: "STORAGE_ERROR" } } }); await flush();
  assert.ok(h.client.capture("favorites")); assert.equal(h.client.capture("bookmarks"), null);
  h.client.refresh(); await flush();
  h.resolve(1, { ...libraryFor("one"), bookmarks: libraryFor("foreign").bookmarks }); await flush();
  assert.equal(h.client.current(), null);
});

test("a revision committed during a read gets one bounded retry rather than stale publication or a loop", async () => {
  const h = harness(); await flush();
  h.event(h.protocol.Type.FAVORITES_UPDATED, { accountKey: "one", revision: 3 });
  h.resolve(0, libraryFor("one", 1)); await flush();
  assert.equal(h.client.current(), null);
  assert.equal(h.requests.length, 2);
  h.resolve(1, libraryFor("one", 2)); await flush();
  assert.equal(h.client.current(), null);
  assert.equal(h.requests.length, 2, "persistent storage drift does not create an automatic polling loop");
});

test("a failed presenter cannot prevent another subscriber from receiving verification or synchronous cleanup", async () => {
  const h = harness(), seen = [];
  h.client.subscribe(() => { throw new Error("presentation failure"); });
  h.client.subscribe((value) => seen.push(value)); await flush();
  h.resolve(0, libraryFor("one")); await flush();
  assert.equal(h.client.current().accountKey, "one"); assert.equal(seen.at(-1).accountKey, "one");
  h.pagehide(); assert.equal(seen.at(-1), null);
});

test("a local identity boundary revokes old clicks immediately but waits for the worker to start one read", async () => {
  const h = harness(); await flush();
  h.localIdentity({ phase: "unavailable", epoch: 0 }); h.localIdentity({ phase: "ready", epoch: 0 });
  assert.equal(h.requests.length, 1, "initial bridge signals share the initialization read");
  h.resolve(0, libraryFor("one")); await flush(); const lease = h.client.capture("favorites");
  h.localIdentity({ phase: "unavailable", epoch: 1 }); assert.equal(h.client.current(), null); assert.equal(h.client.owns(lease), false);
  await flush(); assert.equal(h.requests.length, 1, "local event cannot race worker identity acceptance");
  h.identity(null, 1); h.identity(null, 1); await flush(); assert.equal(h.requests.length, 2);
  h.identity("two", 1); h.resolve(1, libraryFor("two", 1, 1)); await flush();
  assert.equal(h.client.current().accountKey, "two"); assert.equal(h.requests.length, 2);
});

test("new-document identity waits for ready and A to B to A never revives the first A lease", async () => {
  const h = harness(); await flush(); h.resolve(0, libraryFor("a")); await flush();
  const lease = h.client.capture("favorites"); h.identity(null, 0, "new-document");
  await flush(); assert.equal(h.requests.length, 1); assert.equal(h.client.current(), null);
  h.identity("b", 0, "new-document"); await flush(); h.resolve(1, libraryFor("b", 1, 0, "new-document")); await flush();
  h.identity("a", 1, "new-document"); await flush(); h.resolve(2, libraryFor("a", 1, 1, "new-document")); await flush();
  assert.equal(h.client.current().accountKey, "a"); assert.equal(h.client.owns(lease), false);
  h.identity("b", 0, "new-document"); await flush(); assert.equal(h.requests.length, 3);
});

test("ready after a proven receiver-missing initial read recovers once and same-owner refresh never publishes a temporary null", async () => {
  const h = harness(), seen = []; h.client.subscribe(value => seen.push(value)); await flush();
  h.requests[0].reject(Error("Could not establish connection. Receiving end does not exist.")); await flush();
  h.identity("one", 0); await flush(); assert.equal(h.requests.length, 2);
  h.resolve(1, libraryFor("one")); await flush(); const before = h.client.current(), publications = seen.length;
  h.client.refresh(); await flush(); assert.equal(h.client.current(), before); h.resolve(2, libraryFor("one")); await flush();
  assert.equal(h.client.current(), before); assert.equal(seen.length, publications);
});

test("content consumes an in-flight ready once after a closed connection, with exact fences and shared presenters", async () => {
  const h = harness(), seen = [[], []];
  h.client.subscribe(value => seen[0].push(value)); h.client.subscribe(value => seen[1].push(value)); await flush();
  h.identity("one", 4); h.requests[0].reject(Error("The message port closed before a response was received.")); await flush();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[1].envelope.payload)), {
    expectedAccountKey: "one", expectedIdentity: { documentId: "document", epoch: 4 },
  });
  h.client.refresh(); h.client.refresh(); await flush(); assert.equal(h.requests.length, 2);
  h.resolve(1, libraryFor("one", 1, 4)); await flush();
  assert.equal(h.client.current().accountKey, "one");
  assert.equal(seen[0].at(-1), seen[1].at(-1));
  assert.deepEqual(Array.from(h.client.getDiagnostic(), e => e.event), ["read", "identity", "read-failed", "recovery-read", "hydrated"]);
});

for (const readyFirst of [true, false]) test(`content keeps real failures explicit with ready ${readyFirst ? "before" : "after"} error`, async () => {
  for (const [code, details] of [["LIBRARY_ACCOUNT_UNAVAILABLE", { status: 401 }],
    ["LIBRARY_ACCOUNT_UNAVAILABLE", { status: 403 }], ["ADAPTER_UNAVAILABLE", { status: 503 }],
    ["ADAPTER_UNAVAILABLE", null], ["CONTEXT_MISMATCH", null], ["INVALID_ENVELOPE", null]]) {
    const h = harness(); await flush(); if (readyFirst) h.identity("one", 4);
    const request = h.requests[0]; request.resolve(h.protocol.failure(request.envelope, code, "Failure", details)); await flush();
    if (!readyFirst) h.identity("one", 4);
    for (let i = 0; i < 20; i++) { h.identity("one", 4); h.focus(); h.visible(true); await flush(); }
    assert.equal(h.requests.length, 1, code); assert.equal(h.client.current(), null);
    const failure = h.client.getDiagnostic().find(e => e.event === "read-failed");
    assert.equal(failure.error.code, code); assert.equal(failure.error.status, details?.status ?? null);
  }
});

test("content second disconnect stops; duplicate ready and focus never produce a third read", async () => {
  const h = harness(); await flush(); h.identity("one", 4);
  h.requests[0].reject(Error("The message port closed before a response was received.")); await flush();
  h.requests[1].reject(Error("The message port closed before a response was received.")); await flush();
  for (let i = 0; i < 30; i++) { h.identity("one", 4); h.focus(); await flush(); }
  assert.equal(h.requests.length, 2); assert.equal(h.client.current(), null);
  assert.equal(h.client.getDiagnostic().filter(e => e.event === "read-failed").length, 2);
});

test("content automatic recovery rejects another owner, document or epoch and pagehide cancels it", async () => {
  for (const value of [libraryFor("other", 1, 4), libraryFor("one", 1, 4, "other"), libraryFor("one", 1, 5), null]) {
    const h = harness(); await flush(); h.identity("one", 4);
    h.requests[0].reject(Error("The message port closed before a response was received.")); await flush();
    if (value) h.resolve(1, value);
    else { h.pagehide(); h.resolve(1, libraryFor("one", 1, 4)); }
    await flush(); assert.equal(h.client.current(), null); assert.equal(h.requests.length, 2);
  }
});

test("content recovery uses the original six-second deadline and a late success cannot publish", async () => {
  let now = 0, id = 0; const timers = new Map();
  const clock = { Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay) { timers.set(++id, { at: now + delay, fn }); return id; }, clearTimeout: key => timers.delete(key) };
  const h = harness({ clock }); await flush(); assert.equal(timers.size, 0, "Do not shorten ordinary account bootstrap");
  now = 5900; h.identity("one", 4); h.requests[0].reject(Error("The message port closed before a response was received.")); await flush();
  assert.equal(h.requests.length, 2); assert.equal(timers.size, 1); assert.equal([...timers.values()][0].at, 6000);
  now = 6000; [...timers.values()][0].fn(); await flush();
  assert.equal(timers.size, 0); assert.equal(h.client.getDiagnostic().at(-1).error.code, "ADAPTER_TIMEOUT");
  h.resolve(1, libraryFor("one", 1, 4)); await flush(); assert.equal(h.client.current(), null);
  for (let i = 0; i < 20; i++) h.identity("one", 4); await flush(); assert.equal(h.requests.length, 2);
});

test("ready B supersedes the pending initial read after ready A, and an old failure cannot strand B", async () => {
  const h = harness(); await flush(); h.identity("a", 1); h.identity("b", 2); await flush();
  assert.equal(h.requests.length, 2, "the second ready event initializes its own epoch rather than waiting on A");
  const old = h.requests[0]; old.resolve(h.protocol.failure(old.envelope, "CONTEXT_MISMATCH", "old epoch")); await flush();
  h.resolve(1, libraryFor("b", 1, 2)); await flush(); assert.equal(h.client.current().accountKey, "b");
});

test("a local ready with a different owner or epoch revokes old leases without reading ahead of the worker", async () => {
  for (const event of [{ phase: "ready", accountKey: "other", epoch: 0 }, { phase: "ready", accountKey: "one", epoch: 2 }]) {
    const h = harness(); await flush(); h.resolve(0, libraryFor("one")); await flush();
    const lease = h.client.capture("favorites"); h.localIdentity(event);
    assert.equal(h.client.current(), null); assert.equal(h.client.owns(lease), false);
    await flush(); assert.equal(h.requests.length, 1);
  }
});

function isRetired(error) {
  return error?.code === "ADAPTER_UNAVAILABLE" && error?.tidyCode === "ADAPTER_UNAVAILABLE"
    && error.details?.stage === "page-session" && error.details?.disconnect === "context-invalidated";
}

test("runtime loss synchronously revokes library leases and removes every subscription permanently", async () => {
  const h = harness(), seen = []; h.client.subscribe(value => seen.push(value));
  await flush(); h.resolve(0, libraryFor("one")); await flush();
  const lease = h.client.capture("favorites");
  h.runtime.id = undefined;
  assert.equal(h.client.owns(lease), false);
  assert.equal(h.client.capture(), null); assert.equal(h.client.current(), null);
  assert.equal(seen.at(-1), null);
  assert.equal(h.runtimeListeners.length, 0); assert.equal(h.identityListeners.length, 0);
  assert.equal(h.windowEvents.size, 0);
  // Even an accidental restored mock ID cannot revive this document's session.
  h.runtime.id = "test-extension";
  await h.client.refresh(); h.identity("one", 0); h.localIdentity({ phase: "ready", accountKey: "one", epoch: 0 });
  await assert.rejects(h.client.request(h.protocol.Type.FAVORITES_TOGGLE_SIDEBAR, {}, lease), isRetired);
  await flush(); assert.equal(h.requests.length, 1); assert.equal(h.client.current(), null);
  const late = []; h.client.subscribe(value => late.push(value));
  await h.client.refresh(); assert.deepEqual(late, [null]);
});

test("runtime loss between click and dispatch sends no mutation", async () => {
  const h = harness(); await flush(); h.resolve(0, libraryFor("one")); await flush();
  const pending = h.client.request(h.protocol.Type.FAVORITES_TOGGLE_SIDEBAR, {}, h.client.capture("favorites"));
  h.runtime.id = undefined;
  await assert.rejects(pending, isRetired);
  assert.equal(h.requests.length, 1); assert.equal(h.client.current(), null);
});

test("extension invalidation errors cannot consume a ready event to resurrect the initial read", async () => {
  const h = harness(); await flush(); h.identity("one", 4);
  h.requests[0].reject(Error("Extension context invalidated.")); await flush();
  assert.equal(h.session.check(), false); assert.equal(h.client.current(), null);
  for (let i = 0; i < 5; i++) { h.identity("one", 4); await h.client.refresh(); }
  assert.equal(h.requests.length, 1);
});

test("a pending read settles at retirement and its late success cannot republish private data", async () => {
  const h = harness(), seen = []; h.client.subscribe(value => seen.push(value));
  const pending = h.client.refresh(); await flush();
  h.runtime.id = undefined; assert.equal(h.client.capture(), null);
  assert.equal(await pending, null);
  h.resolve(0, libraryFor("one")); await flush();
  assert.equal(h.client.current(), null); assert.equal(seen.some(Boolean), false);
  assert.equal(h.requests.length, 1);
});

test("late mutation replies after runtime loss cannot publish data or reuse old ownership", async () => {
  const h = harness(), seen = []; h.client.subscribe(value => seen.push(value));
  await flush(); h.resolve(0, libraryFor("one")); await flush();
  const lease = h.client.capture("favorites");
  const pending = h.client.request(h.protocol.Type.FAVORITES_TOGGLE_SIDEBAR, {}, lease);
  const rejected = assert.rejects(pending, isRetired); await flush();
  h.runtime.id = undefined; h.client.current();
  h.resolve(1, libraryFor("one", 2).favorites); await rejected; await flush();
  assert.equal(h.client.current(), null); assert.equal(h.client.owns(lease), false);
  assert.equal(seen.filter(Boolean).length, 1); assert.equal(seen.at(-1), null);
});

test("retirement cancels an active recovery deadline and a late reply cannot restart reads", async () => {
  let id = 0; const timers = new Map();
  const clock = { setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(key) { timers.delete(key); } };
  const h = harness({ clock }); await flush(); h.identity("one", 4);
  h.requests[0].reject(Error("The message port closed before a response was received.")); await flush();
  assert.equal(timers.size, 1);
  h.runtime.id = undefined; assert.equal(h.client.capture(), null); assert.equal(timers.size, 0);
  h.resolve(1, libraryFor("one", 1, 4)); await flush();
  assert.equal(h.client.current(), null); assert.equal(timers.size, 0); assert.equal(h.requests.length, 2);
});


for (const failure of ["transport", "response", "invalid-response", "wrong-type", "wrong-request"]) {
  test("content library " + failure + " errors retain the current request ID without retrying the mutation", async () => {
    const h = harness(); await flush(); h.resolve(0, libraryFor("one")); await flush();
    const lease = h.client.capture("favorites"), before = h.client.current();
    const pending = h.client.request(h.protocol.Type.FAVORITES_TOGGLE_SIDEBAR, { conversationId: "chat" }, lease);
    let expectedId;
    const rejected = assert.rejects(pending, error => {
      assert.equal(error.requestId, expectedId);
      if (failure === "transport") {
        assert.equal(error.code, "ADAPTER_UNAVAILABLE"); assert.equal(error.tidyCode, "ADAPTER_UNAVAILABLE");
        assert.equal(error.message, "The library runtime connection was interrupted.");
        assert.deepEqual(JSON.parse(JSON.stringify(error.details)), {
          stage: "content.library-runtime-send-message", disconnect: "connection-closed",
        });
      } else if (failure === "response") {
        assert.equal(error.code, "STORAGE_ERROR"); assert.equal(error.tidyCode, "STORAGE_ERROR");
        assert.equal(error.message, "Synthetic write failure");
        assert.deepEqual(JSON.parse(JSON.stringify(error.details)), { stage: "synthetic-write", retryable: false });
      } else {
        assert.equal(error.code, "CONTEXT_MISMATCH"); assert.equal(error.tidyCode, "CONTEXT_MISMATCH");
        assert.equal(error.message, "Invalid library response"); assert.equal(Object.hasOwn(error, "details"), false);
      }
      return true;
    });
    await flush();
    const current = h.requests[1]; expectedId = current.envelope.requestId;
    assert.equal(typeof expectedId, "string"); assert.ok(expectedId.length > 0);
    if (failure === "transport") current.reject(Error("The message port closed before a response was received."));
    else if (failure === "response") current.resolve(h.protocol.failure(current.envelope, "STORAGE_ERROR", "Synthetic write failure", {
      stage: "synthetic-write", retryable: false,
    }));
    else if (failure === "wrong-type") current.resolve({ ...h.protocol.response(current.envelope, {}), type: "unrelated-type" });
    else if (failure === "wrong-request") current.resolve({ ...h.protocol.response(current.envelope, {}), requestId: "unrelated-request" });
    else current.resolve(null);
    await rejected; await flush();
    assert.equal(h.requests.length, 2, "a diagnostic request ID cannot trigger another read or replay a write");
    assert.equal(h.client.current(), before); assert.equal(h.client.owns(lease), true);
  });
}
