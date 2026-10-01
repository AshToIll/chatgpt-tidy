const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const context = vm.createContext({ setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync("src/platform/library/library-hydration.js", "utf8"), context);
vm.runInContext(fs.readFileSync("src/platform/library/ui/library-controller.js", "utf8").replace("export function", "function"), context);
const create = context.createLibraryController;
const state = (accountKey = "a", revision = 1, epoch = accountKey === "b" ? 1 : 0) => ({ accountKey, identity: { documentId: "document", epoch },
  favorites: { accountKey, revision, items: { one: { title: `${accountKey} private` } } },
  bookmarks: { accountKey, revision, items: {} }, errors: { favorites: null, bookmarks: null } });
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
function clock() {
  let time = 0, nextId = 0; const timers = new Map();
  return {
    now: () => time,
    setTimer(callback, delay) { const id = ++nextId; timers.set(id, { at: time + delay, callback }); return id; },
    clearTimer: id => timers.delete(id),
    identityRecoveryDelayMs: 80, identityDeadlineMs: 600,
    size: () => timers.size,
    async advance(delay) {
      const end = time + delay;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
      }
      time = end; await flush();
    },
  };
}
const documentState = (documentId, accountKey = "a", epoch = 1) => ({ ...state(accountKey, 1, epoch), identity: { documentId, epoch } });

test("document departure at the same unavailable epoch cancels the pending read instead of being deduplicated", async () => {
  const timer = clock(), old = deferred(); let calls = 0, value = documentState("source");
  const controller = create({ ...timer, request: () => { calls++; return value; } });
  await controller.refresh(); value = old.promise;
  controller.observeIdentity({ documentId: "source", epoch: 2, phase: "unavailable" });
  await flush(); assert.equal(calls, 2);
  controller.observeIdentity({ documentId: "source", epoch: 2, phase: "unavailable", transition: "document-hidden" });
  old.resolve(documentState("source", "a", 2)); await flush();
  assert.equal(controller.getState().accountKey, null, "the departing page cannot republish its late library");
  await timer.advance(100); assert.equal(calls, 2);
  value = documentState("source", "a", 3);
  controller.observeIdentity({ ...value.identity, phase: "ready", accountKey: "a" });
  await flush(); assert.equal(calls, 3); assert.equal(controller.getState().identity.epoch, 3);
  controller.dispose();
});

test("departing source clears authority without reading it again before destination initialization", async () => {
  const timer = clock(); let calls = 0, value = documentState('source');
  const controller = create({ ...timer, request: () => { calls++; return value; } });
  await controller.refresh(); const lease = controller.capture();
  controller.observeIdentity({ documentId: 'source', epoch: 2, phase: 'unavailable', accountKey: null, transition: 'document-hidden' });
  await flush(); assert.equal(controller.getState().accountKey, null); assert.equal(controller.isCurrent(lease), false);
  assert.equal(calls, 1, 'Departing source must not trigger another LIBRARY_GET');
  await timer.advance(100); assert.equal(calls, 1);
  controller.observeIdentity({ documentId: 'destination', epoch: 0, phase: 'unavailable', accountKey: null });
  value = documentState('destination');
  controller.observeIdentity({ documentId: 'destination', epoch: 1, phase: 'ready', accountKey: 'a' });
  await flush(); assert.equal(calls, 2); assert.equal(controller.getState().identity.documentId, 'destination');
  await timer.advance(1000); assert.equal(calls, 2); controller.dispose();
});

test("departed document cannot poll itself, and missing successor has a bounded error", async () => {
  const timer = clock(); let calls = 0;
  const controller = create({ ...timer, request: () => { calls++; return documentState('source'); } });
  await controller.refresh();
  const event = { documentId: 'source', epoch: 2, phase: 'unavailable', accountKey: null, transition: 'document-hidden' };
  controller.observeIdentity(event); await timer.advance(300); controller.observeIdentity(event);
  await timer.advance(300);
  assert.equal(calls, 1); assert.equal(controller.getState().errors.bookmarks.code, 'ADAPTER_TIMEOUT');
  assert.equal(timer.size(), 0); controller.dispose();
});

test("a newly created hidden side panel defers its single shared initialization until first shown", async () => {
  const timer = clock(), wait = deferred(); let calls = 0;
  const controller = create({ ...timer, visible: false, request: () => { calls++; return wait.promise; } });
  await controller.refresh(); await controller.refresh();
  assert.equal(calls, 0); assert.equal(timer.size(), 0);
  assert.equal(controller.getState().errors.bookmarks, null, 'A read that never started did not fail');
  await timer.advance(2000);
  controller.setVisible(true); controller.setVisible(true); await flush();
  const joined = controller.refresh();
  assert.equal(calls, 1, 'Showing and consumers join the same first request, not a recovery read');
  wait.resolve(state()); await joined;
  assert.ok(controller.getState().favorites); assert.ok(controller.getState().bookmarks);
  for (let i = 0; i < 5; i++) { controller.setVisible(false); controller.setVisible(true); }
  await timer.advance(2000);
  assert.equal(calls, 1); assert.equal(timer.size(), 0);
});

test("unknown-owner revision hints exist only during the bounded initial read", async () => {
  const timer = clock(), old = deferred(); let calls = 0, value = old.promise;
  const controller = create({ ...timer, visible: false, request: () => { calls++; return value; } });
  await controller.refresh();
  controller.observeRevision("favorites", { accountKey: "a", revision: 99 });
  controller.setVisible(true); await flush();
  controller.observeRevision("bookmarks", { accountKey: "a", revision: 100 });
  await timer.advance(600);
  assert.equal(calls, 1); assert.equal(controller.getState().errors.favorites.code, "ADAPTER_TIMEOUT");
  value = state(); await controller.refresh({ retryIdentity: true });
  old.resolve(state("a", 101)); await flush();
  assert.equal(calls, 2, "the timed-out cycle cannot demand a read in the new cycle");
  assert.equal(controller.getState().favorites.revision, 1);
  assert.equal(controller.getState().bookmarks.revision, 1); controller.dispose();
});

test("identity received before first visibility fences initialization to the latest document", async () => {
  for (const staleReply of [false, true]) {
    const timer = clock(); let calls = 0;
    const controller = create({ ...timer, visible: false, request: () => {
      calls++; return staleReply ? documentState('old', 'a') : documentState('new', 'b');
    } });
    await controller.refresh();
    controller.observeIdentity({ documentId: 'old', epoch: 1, phase: 'ready', accountKey: 'a' });
    controller.observeIdentity({ documentId: 'new', epoch: 0, phase: 'unavailable' });
    controller.observeIdentity({ documentId: 'new', epoch: 1, phase: 'ready', accountKey: 'b' });
    assert.equal(calls, 0); assert.equal(timer.size(), 0);
    assert.equal(controller.getState().errors.bookmarks, null);
    controller.setVisible(true); await flush();
    assert.equal(calls, 1);
    assert.equal(controller.getState().accountKey, staleReply ? null : 'b');
    if (staleReply) assert.equal(controller.getState().errors.bookmarks.code, 'CONTEXT_MISMATCH');
    controller.dispose();
  }
});

test("deferred initialization never becomes a visibility retry after actual failure or disposal", async () => {
  for (const code of ['AUTH_REQUIRED', 'FORBIDDEN', 'ADAPTER_UNAVAILABLE', 'STORAGE_ERROR']) {
    const timer = clock(); let calls = 0;
    const controller = create({ ...timer, visible: false, request: () => { calls++; throw Object.assign(Error('Actual failure'), { code }); } });
    await controller.refresh(); controller.setVisible(true); await flush();
    assert.equal(calls, 1); assert.equal(controller.getState().errors.bookmarks.code, code);
    controller.setVisible(false); controller.setVisible(true); await timer.advance(2000);
    assert.equal(calls, 1); assert.equal(timer.size(), 0);
    controller.dispose();
  }
  let calls = 0;
  const controller = create({ visible: false, request: () => { calls++; return state(); } });
  await controller.refresh(); controller.dispose(); controller.setVisible(true); await flush();
  assert.equal(calls, 0);
});

test("concurrent consumers share a read and explicit refresh still reads local storage", async () => {
  let calls = 0; const wait = deferred(); const controller = create({ request: () => { calls++; return wait.promise; } });
  const first = controller.refresh(), second = controller.refresh();
  assert.equal(first, second); await Promise.resolve(); assert.equal(calls, 1);
  wait.resolve(state()); await first;
  await controller.refresh(); assert.equal(calls, 2);
});

test("an explicit ownership invalidation clears data synchronously and rejects the old pending response", async () => {
  const wait = deferred(); let result = state();
  const controller = create({ request: () => result }); await controller.refresh();
  const lease = controller.capture(); result = wait.promise; const pending = controller.refresh();
  await Promise.resolve(); controller.invalidate();
  assert.equal(controller.getState().accountKey, null); assert.equal(controller.getState().favorites, null);
  assert.equal(controller.isCurrent(lease), false);
  wait.resolve(state()); await pending;
  assert.equal(controller.getState().accountKey, null);
});

test("a new account cannot borrow mismatched store data or revive an earlier mutation", async () => {
  let result = state(); const controller = create({ request: () => result }); await controller.refresh();
  const old = controller.capture(); result = { ...state("b"), favorites: state("a").favorites };
  await controller.refresh(); assert.equal(controller.getState().accountKey, "b");
  assert.equal(controller.getState().favorites, null);
  assert.equal(controller.acceptMutation(old, "favorites", state("a", 9).favorites), false);
  assert.equal(controller.acceptMutation(controller.capture(), "favorites", state("a").favorites), false);
});

test("one failed storage module does not hide its sibling or the verified current-export owner", async () => {
  const result = { ...state(), bookmarks: null, errors: { favorites: null, bookmarks: { code: "STORAGE_ERROR" } } };
  const controller = create({ request: () => result }); await controller.refresh();
  assert.equal(controller.getState().accountKey, "a"); assert.equal(controller.getState().favorites, result.favorites);
  assert.equal(controller.getState().bookmarks, null);
});

test("a late read cannot roll back a newer same-account mutation", async () => {
  let result = state(); const controller = create({ request: () => result }); await controller.refresh();
  const wait = deferred(); result = wait.promise; const pending = controller.refresh(); await Promise.resolve();
  assert.equal(controller.acceptMutation(controller.capture(), "favorites", state("a", 3).favorites), true);
  wait.resolve(state("a", 2)); await pending;
  assert.equal(controller.getState().favorites.revision, 3);
  assert.equal(controller.acceptMutation(controller.capture(), "favorites", state("a", 1).favorites), false);
});

test("an authoritative identity mismatch clears data rather than using the previous owner", async () => {
  let fail = false; const controller = create({ request: () => { if (fail) throw Object.assign(Error("signed out"), { code: "CONTEXT_MISMATCH" }); return state(); } });
  await controller.refresh(); fail = true; await controller.refresh();
  assert.equal(controller.getState().accountKey, null); assert.equal(controller.getState().bookmarks, null);
});

test("same-owner refresh keeps object references, leases and committed data during a transient failure", async () => {
  let value = state(); const seen = [], controller = create({ request: () => value, onChanged: value => seen.push(value) });
  await controller.refresh(); const before = controller.getState(), lease = controller.capture();
  value = state(); await controller.refresh();
  assert.equal(controller.getState(), before); assert.equal(seen.length, 1); assert.equal(controller.isCurrent(lease), true);
  value = Promise.reject(Object.assign(Error("temporary"), { code: "ADAPTER_UNAVAILABLE" })); await controller.refresh();
  assert.equal(controller.getState(), before); assert.equal(seen.length, 1); assert.equal(controller.isCurrent(lease), true);
  value = { ...state(), favorites: null, errors: { favorites: { code: "STORAGE_ERROR" }, bookmarks: null } };
  await controller.refresh(); assert.equal(controller.getState().favorites, before.favorites);
});

test("read supersession cancels the earlier response without cancelling same-owner mutation leases", async () => {
  let value = state(); const seen = [], controller = create({ request: () => value, onChanged: value => seen.push(value) });
  await controller.refresh(); const lease = controller.capture(), wait = deferred(); value = wait.promise;
  const first = controller.refresh(); await Promise.resolve(); value = state("a", 2);
  await controller.refresh({ supersede: true }); wait.resolve(state("a", 9)); await first;
  assert.equal(controller.getState().favorites.revision, 2); assert.equal(controller.isCurrent(lease), true);
  assert.ok(seen.every(value => value.accountKey === "a"));
});

test("same-document unavailable clears immediately and initializes its epoch exactly once", async () => {
  let value = state(), calls = 0; const controller = create({ request: () => { calls++; return value; } });
  await controller.refresh(); const lease = controller.capture(), wait = deferred(); value = wait.promise;
  const event = { documentId: "document", epoch: 1, phase: "unavailable", accountKey: null };
  controller.observeIdentity(event); controller.observeIdentity(event);
  assert.equal(controller.getState().accountKey, null); assert.equal(controller.isCurrent(lease), false);
  await Promise.resolve(); assert.equal(calls, 2);
  controller.observeIdentity({ ...event, phase: "ready", accountKey: "b" });
  wait.resolve(state("b")); await controller.refresh(); assert.equal(controller.getState().accountKey, "b"); assert.equal(calls, 2);
});

test("new-document unavailable waits for ready and rejects the old document's late read", async () => {
  let value = state(), calls = 0; const controller = create({ request: () => { calls++; return value; } });
  await controller.refresh(); const wait = deferred(); value = wait.promise;
  const pending = controller.refresh(); await Promise.resolve();
  controller.observeIdentity({ documentId: "replacement", epoch: 0, phase: "unavailable", accountKey: null });
  wait.resolve(state()); await pending; assert.equal(controller.getState().accountKey, null); assert.equal(calls, 2);
  value = { ...state("b"), identity: { documentId: "replacement", epoch: 0 } };
  controller.observeIdentity({ ...value.identity, phase: "ready", accountKey: "b" }); await controller.refresh();
  assert.equal(controller.getState().accountKey, "b"); assert.equal(calls, 3);
});

test("initial ready shares the pending read but ready after initial bridge failure recovers", async () => {
  const wait = deferred(); let value = wait.promise, calls = 0;
  const controller = create({ request: () => { calls++; return value; } });
  const pending = controller.refresh(); await Promise.resolve();
  controller.observeIdentity({ documentId: "document", epoch: 0, phase: "ready", accountKey: "a" });
  wait.resolve(state()); await pending; assert.equal(calls, 1); assert.equal(controller.getState().accountKey, "a");
  let fail = true; const recovery = create({ request: () => { if (fail) throw Object.assign(Error("initial bridge"), { code: "ADAPTER_UNAVAILABLE" }); return state(); } });
  await recovery.refresh(); assert.equal(recovery.getState().accountKey, null); fail = false;
  recovery.observeIdentity({ documentId: "document", epoch: 0, phase: "ready", accountKey: "a" }); await recovery.refresh();
  assert.equal(recovery.getState().accountKey, "a");
});

test("A to B to A uses epoch fences so an earlier A response or click never becomes current again", async () => {
  let value = state(); const controller = create({ request: () => value }); await controller.refresh();
  const firstA = controller.capture(), wait = deferred(); value = wait.promise; const pending = controller.refresh(); await Promise.resolve();
  value = state("b", 1, 1); controller.observeIdentity({ ...value.identity, accountKey: "b", phase: "ready" }); await controller.refresh();
  value = state("a", 1, 2); controller.observeIdentity({ ...value.identity, accountKey: "a", phase: "ready" }); await controller.refresh();
  wait.resolve(state("a", 99, 0)); await pending;
  controller.observeIdentity({ documentId: "document", epoch: 0, accountKey: "a", phase: "ready" });
  assert.equal(controller.getState().identity.epoch, 2); assert.equal(controller.getState().favorites.revision, 1);
  assert.equal(controller.isCurrent(firstA), false); assert.equal(controller.acceptMutation(firstA, "favorites", state("a", 99).favorites), false);
});

test("a second ready identity supersedes an initial read whose first ready event already fixed its owner", async () => {
  const old = deferred(), next = deferred(); let calls = 0;
  const controller = create({ request: () => (++calls === 1 ? old.promise : next.promise) });
  const initial = controller.refresh(); await Promise.resolve();
  controller.observeIdentity({ documentId: "document", epoch: 1, accountKey: "a", phase: "ready" });
  controller.observeIdentity({ documentId: "document", epoch: 2, accountKey: "b", phase: "ready" });
  await Promise.resolve(); assert.equal(calls, 2, "B ready must not be consumed by A's in-flight read");
  old.reject(Object.assign(Error("old epoch"), { code: "CONTEXT_MISMATCH" })); await initial;
  next.resolve(state("b", 1, 2)); await controller.refresh();
  assert.equal(controller.getState().accountKey, "b"); assert.equal(controller.getState().identity.epoch, 2);
});

test("the first unbound read may prove the newly observed document without a separate ready event", async () => {
  const timer = clock(), wait = deferred(); let calls = 0;
  const controller = create({ ...timer, request: () => { calls++; return wait.promise; } });
  const first = controller.refresh(); await flush();
  controller.observeIdentity({ documentId: "new-doc", epoch: 0, phase: "unavailable", accountKey: null });
  wait.resolve(documentState("new-doc")); await first;
  assert.equal(controller.getState().accountKey, "a"); assert.equal(calls, 1);
  await timer.advance(2000); assert.equal(calls, 1); assert.equal(timer.size(), 0);
});

test("an initial unknown read has a deadline and manual retry cannot revive its late proof", async () => {
  const timer = clock(), old = deferred(); let value = old.promise, calls = 0;
  const controller = create({ ...timer, request: () => { calls++; return value; } });
  const first = controller.refresh(); await flush(); await timer.advance(600);
  assert.equal(controller.getState().errors.favorites?.code, "ADAPTER_TIMEOUT");
  assert.equal(controller.getState().errors.bookmarks?.code, "ADAPTER_TIMEOUT");
  assert.equal(await first, null); assert.equal(calls, 1);
  value = documentState("new-doc", "b", 2); await controller.refresh({ retryIdentity: true });
  old.resolve(state("a", 99)); await flush();
  assert.equal(controller.getState().accountKey, "b"); assert.equal(controller.getState().identity.documentId, "new-doc");
});

test("a real document boundary with missing ready performs one bounded ordinary recovery read", async () => {
  const timer = clock(), seen = []; let value = state(), calls = 0;
  const controller = create({ ...timer, request: options => { calls++; seen.push(options); return value; } });
  await controller.refresh(); const oldLease = controller.capture(); value = documentState("new-doc", "b");
  const event = { documentId: "new-doc", epoch: 0, phase: "unavailable", accountKey: null };
  controller.observeIdentity(event); controller.observeIdentity(event);
  assert.equal(controller.getState().accountKey, null); assert.equal(controller.isCurrent(oldLease), false);
  await timer.advance(79); assert.equal(calls, 1);
  await timer.advance(1); assert.equal(calls, 2); assert.equal(controller.getState().accountKey, "b");
  assert.equal(seen[1].retryIdentity, false);
  await timer.advance(2000); assert.equal(calls, 2); assert.equal(timer.size(), 0);
});

test("hung boundary recovery becomes retryable once and duplicate unavailable does not reset its deadline", async () => {
  const timer = clock(), stuck = deferred(); let value = state(), calls = 0;
  const controller = create({ ...timer, request: () => { calls++; return value; } });
  await controller.refresh(); value = stuck.promise;
  const event = { documentId: "new-doc", epoch: 0, phase: "unavailable", accountKey: null };
  controller.observeIdentity(event); await timer.advance(80);
  for (let index = 0; index < 20; index++) { controller.observeIdentity(event); await timer.advance(20); }
  await timer.advance(120);
  assert.equal(controller.getState().errors.bookmarks?.code, "ADAPTER_TIMEOUT"); assert.equal(calls, 2);
  controller.observeIdentity(event); await timer.advance(2000); assert.equal(calls, 2);
  stuck.resolve(documentState("new-doc")); await flush(); assert.equal(controller.getState().accountKey, null);
});

test("a failed recovery exposes retry and never retries authentication automatically", async () => {
  const timer = clock(), options = []; let value = state();
  const controller = create({ ...timer, request: option => { options.push(option); if (value instanceof Error) throw value; return value; } });
  await controller.refresh(); value = Object.assign(Error("bridge absent"), { code: "ADAPTER_UNAVAILABLE" });
  const event = { documentId: "new-doc", epoch: 0, phase: "unavailable", accountKey: null };
  controller.observeIdentity(event); await timer.advance(80);
  assert.equal(controller.getState().errors.favorites?.code, "ADAPTER_UNAVAILABLE");
  for (let index = 0; index < 20; index++) { controller.observeIdentity(event); controller.setVisible(false); controller.setVisible(true); }
  await timer.advance(2000); assert.equal(options.length, 2); assert.ok(options.every(option => option.retryIdentity === false));
  value = documentState("new-doc"); await controller.refresh({ retryIdentity: true });
  assert.equal(options[2].retryIdentity, true); assert.equal(controller.getState().accountKey, "a");
});

test("the retained first read is fenced against a wrong document, older epoch or conflicting ready owner", async () => {
  for (const bad of [documentState("wrong"), documentState("new-doc", "a", 0), documentState("new-doc", "b", 1)]) {
    const timer = clock(), wait = deferred(); const controller = create({ ...timer, request: () => wait.promise });
    const first = controller.refresh(); await flush();
    controller.observeIdentity({ documentId: "new-doc", epoch: 1, phase: "unavailable", accountKey: null });
    if (bad.accountKey === "b") controller.observeIdentity({ documentId: "new-doc", epoch: 1, phase: "ready", accountKey: "a" });
    wait.resolve(bad); await first;
    assert.equal(controller.getState().accountKey, null); assert.equal(controller.getState().errors.favorites?.code, "CONTEXT_MISMATCH");
    assert.equal(timer.size(), 0);
  }
});

test("first ready A then a new document cannot retain A's initially unbound read", async () => {
  const timer = clock(), old = deferred(); let value = old.promise, calls = 0;
  const controller = create({ ...timer, request: () => { calls++; return value; } });
  const first = controller.refresh(); await flush();
  controller.observeIdentity({ documentId: "old-doc", epoch: 1, phase: "ready", accountKey: "a" });
  controller.observeIdentity({ documentId: "new-doc", epoch: 0, phase: "unavailable", accountKey: null });
  old.resolve(documentState("old-doc")); await first; assert.equal(controller.getState().accountKey, null);
  value = documentState("new-doc", "b"); await timer.advance(80);
  assert.equal(calls, 2); assert.equal(controller.getState().accountKey, "b");
});

test("ready before recovery uses one fresh read and cancels the recovery timer", async () => {
  const timer = clock(); let value = state(), calls = 0;
  const controller = create({ ...timer, request: () => { calls++; return value; } });
  await controller.refresh(); controller.observeIdentity({ documentId: "new-doc", epoch: 0, phase: "unavailable", accountKey: null });
  value = documentState("new-doc", "b");
  controller.observeIdentity({ ...value.identity, phase: "ready", accountKey: "b" }); await flush();
  assert.equal(calls, 2); await timer.advance(2000); assert.equal(calls, 2); assert.equal(timer.size(), 0);
});

test("hidden and disposed controllers cancel their recovery watchdog without visibility-driven reads", async () => {
  for (const lifecycle of ["hidden", "disposed"]) {
    const timer = clock(); let calls = 0;
    const controller = create({ ...timer, request: () => { calls++; return state(); } });
    await controller.refresh(); const lease = controller.capture();
    for (let index = 0; index < 20; index++) { controller.setVisible(false); controller.setVisible(true); }
    assert.equal(controller.isCurrent(lease), true); assert.equal(calls, 1);
    controller.observeIdentity({ documentId: "new-doc", epoch: 0, phase: "unavailable", accountKey: null });
    if (lifecycle === "hidden") controller.setVisible(false); else controller.dispose();
    assert.equal(timer.size(), 0); await timer.advance(2000); assert.equal(calls, 1);
    controller.setVisible(true); await timer.advance(2000); assert.equal(calls, 1);
    if (lifecycle === "hidden") assert.ok(controller.getState().errors.bookmarks, "returning exposes manual retry instead of an endless waiting state");
  }
});

test("retaining the first read never extends its original identity deadline", async () => {
  const timer = clock(), stuck = deferred(); let calls = 0;
  const controller = create({ ...timer, request: () => { calls++; return stuck.promise; } });
  const first = controller.refresh(); await flush(); await timer.advance(500);
  controller.observeIdentity({ documentId: "new-doc", epoch: 0, phase: "unavailable" });
  await timer.advance(100); assert.equal(controller.getState().errors.favorites?.code, "ADAPTER_TIMEOUT");
  assert.equal(await first, null); assert.equal(calls, 1);
});

test("duplicate ready after a failed verification does not create an authentication loop", async () => {
  const timer = clock(); let calls = 0;
  const controller = create({ ...timer, request: () => { calls++; throw Object.assign(Error("offline"), { code: "ADAPTER_UNAVAILABLE" }); } });
  const event = { documentId: "document", epoch: 1, phase: "ready", accountKey: "a" };
  controller.observeIdentity(event); await flush(); assert.equal(calls, 1);
  for (let index = 0; index < 20; index++) controller.observeIdentity(event);
  await timer.advance(2000); assert.equal(calls, 1); assert.ok(controller.getState().errors.favorites);
});

test("replacement recovery A to B to A cannot publish late B or revive the first A lease", async () => {
  const timer = clock(), oldB = deferred(); let value = documentState("doc-a", "a", 1), calls = 0;
  const controller = create({ ...timer, request: () => { calls++; return value; } });
  await controller.refresh(); const firstA = controller.capture(); value = oldB.promise;
  controller.observeIdentity({ documentId: "doc-b", epoch: 0, phase: "unavailable" });
  await timer.advance(80); assert.equal(calls, 2);
  value = documentState("doc-a-return", "a", 1);
  controller.observeIdentity({ documentId: "doc-a-return", epoch: 0, phase: "unavailable" });
  controller.observeIdentity({ documentId: "doc-a-return", epoch: 0, phase: "unavailable", accountKey: null });
  await timer.advance(80); assert.equal(calls, 3);
  oldB.resolve(documentState("doc-b", "b", 1)); await flush();
  assert.equal(controller.getState().identity.documentId, "doc-a-return");
  assert.equal(controller.isCurrent(firstA), false); assert.equal(controller.acceptMutation(firstA, "favorites", state("a", 99).favorites), false);
  await timer.advance(2000); assert.equal(calls, 3);
});

test("identity events received while hidden leave explicit retry rather than background reads or a stuck spinner", async () => {
  const timer = clock(); let value = state(), calls = 0;
  const controller = create({ ...timer, request: () => { calls++; return value; } });
  await controller.refresh(); controller.setVisible(false);
  controller.observeIdentity({ documentId: "new-doc", epoch: 0, phase: "unavailable" });
  value = documentState("new-doc", "b");
  controller.observeIdentity({ ...value.identity, phase: "ready", accountKey: "b" });
  controller.setVisible(true); await timer.advance(2000);
  assert.equal(calls, 1); assert.equal(controller.getState().accountKey, null); assert.ok(controller.getState().errors.bookmarks);
  await controller.refresh({ retryIdentity: true }); assert.equal(calls, 2); assert.equal(controller.getState().accountKey, "b");
});

const disconnected = (stage = "service-worker.library-account-transport", reason = "connection-closed") => Object.assign(Error("Port disconnected"), {
  code: "ADAPTER_UNAVAILABLE", details: { stage, disconnect: reason },
});
const reloadReady = { documentId: "reload-document", epoch: 1, accountKey: "a", phase: "ready" };

test("reload recovery consumes only a new in-flight ready proof and sends its exact read fences", async () => {
  for (const stage of ["service-worker.library-account-transport", "sidepanel.runtime-send-message"]) {
    for (const reason of ["context-invalidated", "receiver-missing", "connection-closed"]) {
      const timer = clock(), old = deferred(), options = [];
      const controller = create({ ...timer, request: option => {
        options.push(option); return options.length === 1 ? old.promise : documentState("reload-document", "a", 1);
      } });
      const initial = controller.refresh(); await flush();
      controller.observeIdentity(reloadReady); old.reject(disconnected(stage, reason)); await initial;
      assert.equal(controller.getState().accountKey, "a"); assert.equal(options.length, 2);
      assert.deepEqual(JSON.parse(JSON.stringify(options[1])), { retryIdentity: false, expectedAccountKey: "a",
        expectedIdentity: { documentId: "reload-document", epoch: 1 } });
      assert.equal(timer.size(), 0); controller.dispose();
    }
  }
});

test("a recovery transport failure remains visible and duplicate ready cannot cause a third read", async () => {
  const timer = clock(), old = deferred(); let calls = 0;
  const controller = create({ ...timer, request: () => { if (++calls === 1) return old.promise; throw disconnected(); } });
  const initial = controller.refresh(); await flush(); controller.observeIdentity(reloadReady);
  old.reject(disconnected()); await initial;
  assert.equal(calls, 2); assert.equal(controller.getState().errors.bookmarks.details.disconnect, "connection-closed");
  for (let i = 0; i < 30; i++) controller.observeIdentity(reloadReady);
  await timer.advance(2000); assert.equal(calls, 2); assert.equal(timer.size(), 0);
});

test("recovery must finish inside the original deadline, not a fresh timeout after ready", async () => {
  const timer = clock(), old = deferred(), recovered = deferred(); let calls = 0;
  const controller = create({ ...timer, request: () => ++calls === 1 ? old.promise : recovered.promise });
  const initial = controller.refresh(); await flush(); await timer.advance(500);
  controller.observeIdentity(reloadReady); old.reject(disconnected()); await flush();
  assert.equal(calls, 2); await timer.advance(100); await initial;
  assert.equal(controller.getState().errors.bookmarks.code, "ADAPTER_TIMEOUT"); assert.equal(timer.size(), 0);
  recovered.resolve(documentState("reload-document", "a", 1)); await flush();
  assert.equal(controller.getState().accountKey, null); await timer.advance(2000); assert.equal(calls, 2);
});

test("ready is not permission to retry auth, network, malformed responses or identity conflicts", async () => {
  const failures = [
    Object.assign(Error("401"), { code: "LIBRARY_ACCOUNT_UNAVAILABLE", details: { status: 401 } }),
    Object.assign(Error("429"), { code: "ADAPTER_UNAVAILABLE", details: { status: 429 } }),
    Object.assign(Error("Failed to fetch"), { code: "ADAPTER_UNAVAILABLE" }),
    Object.assign(Error("Timeout"), { code: "ADAPTER_TIMEOUT" }),
    Object.assign(Error("Wrong envelope"), { code: "INVALID_ENVELOPE" }),
    Object.assign(disconnected(), { code: "CONTEXT_MISMATCH" }),
    disconnected("service-worker.library-account-response"),
    disconnected("sidepanel.runtime-send-message", null),
  ];
  for (const failure of failures) {
    const timer = clock(), old = deferred(); let calls = 0;
    const controller = create({ ...timer, request: () => { calls++; return old.promise; } });
    const first = controller.refresh(); await flush(); controller.observeIdentity(reloadReady); old.reject(failure); await first;
    for (let i = 0; i < 20; i++) controller.observeIdentity(reloadReady);
    await timer.advance(2000);
    assert.equal(calls, 1, failure.message); assert.equal(controller.getState().errors.bookmarks, failure);
  }
});

test("permanently invalidated context without a new ready signal does not guess a reconnect", async () => {
  const timer = clock(); let calls = 0;
  const controller = create({ ...timer, request: () => { calls++; throw disconnected("sidepanel.runtime-send-message", "context-invalidated"); } });
  await controller.refresh(); await timer.advance(2000);
  assert.equal(calls, 1); assert.equal(controller.getState().errors.bookmarks.details.disconnect, "context-invalidated");
  assert.equal(timer.size(), 0);
});

test("panel ready after a real auth/network/identity failure keeps explicit retry", async () => {
  for (const failure of [Object.assign(Error("auth"), { code: "LIBRARY_ACCOUNT_UNAVAILABLE", details: { status: 401 } }),
    Object.assign(Error("network"), { code: "ADAPTER_UNAVAILABLE" }), Object.assign(Error("identity"), { code: "CONTEXT_MISMATCH" })]) {
    const timer = clock(); let calls = 0;
    const controller = create({ ...timer, request: () => { calls++; throw failure; } });
    await controller.refresh(); controller.observeIdentity(reloadReady); await timer.advance(100);
    assert.equal(calls, 1); assert.equal(controller.getState().errors.bookmarks, failure);
    assert.equal(controller.getDiagnostic().find(e => e.event === "read-failed").error.code, failure.code);
  }
});

test("panel ready after the first disconnect retains exact fences and the original deadline", async () => {
  const timer = clock(), options = [], stuck = deferred();
  const controller = create({ ...timer, request: option => {
    options.push(option); if (options.length === 1) throw disconnected(); return stuck.promise;
  } });
  await controller.refresh(); await timer.advance(500); controller.observeIdentity(reloadReady); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(options[1])), { retryIdentity: false, expectedAccountKey: "a",
    expectedIdentity: { documentId: "reload-document", epoch: 1 } });
  await timer.advance(100); assert.equal(controller.getState().errors.bookmarks.code, "ADAPTER_TIMEOUT");
  stuck.resolve(documentState("reload-document")); await flush(); assert.equal(controller.getState().accountKey, null);
});

test("automatic recovery cannot retarget a newer epoch, different account or document", async () => {
  for (const value of [documentState("reload-document", "b", 2), documentState("other-document", "a", 1), documentState("reload-document", "a", 2)]) {
    const timer = clock(), old = deferred(); let calls = 0;
    const controller = create({ ...timer, request: () => ++calls === 1 ? old.promise : value });
    const first = controller.refresh(); await flush(); controller.observeIdentity(reloadReady); old.reject(disconnected()); await first;
    assert.equal(calls, 2); assert.equal(controller.getState().errors.bookmarks.code, "CONTEXT_MISMATCH");
    assert.equal(controller.getState().accountKey, null); assert.equal(timer.size(), 0);
  }
});

test("hidden or disposed panels do not start a recovery from an old transport's late rejection", async () => {
  for (const action of [controller => controller.setVisible(false), controller => controller.dispose()]) {
    const timer = clock(), old = deferred(); let calls = 0;
    const controller = create({ ...timer, request: () => { calls++; return old.promise; } });
    const first = controller.refresh(); await flush(); controller.observeIdentity(reloadReady); action(controller);
    old.reject(disconnected()); await first; await timer.advance(2000);
    assert.equal(calls, 1); assert.equal(controller.getState().accountKey, null); assert.equal(timer.size(), 0);
  }
});
