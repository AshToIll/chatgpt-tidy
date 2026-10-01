const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const { installPageSession } = require("./helpers/page-session.cjs");

const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let index = 0; index < 8; index++) await new Promise(setImmediate); };
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; };
const session = (user = "user-a", token = "fixture-token") => ({ user: { id: user }, accessToken: token });

function harness({ cookie = "_account=W1", respond = () => ({ body: session() }) } = {}) {
  const events = [], calls = [], listeners = new Map();
  const context = vm.createContext({ URL, Headers, document: { cookie },
    location: { href: "https://chatgpt.com/c/fixture", origin: "https://chatgpt.com" },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    fetch(input, init) {
      calls.push({ input, init });
      return Promise.resolve(respond(calls.length)).then(result => ({
        ok: (result.status || 200) >= 200 && (result.status || 200) < 300,
        status: result.status || 200,
        json: async () => result.body, clone: () => ({ json: async () => result.body }),
      }));
    },
  });
  installPageSession(context);
  vm.runInContext(fs.readFileSync("src/platform/chatgpt/api.js", "utf8"), context, { filename: "api.js" });
  const api = context.TidyChatgptApi;
  api.onLibraryIdentityChanged(value => events.push(plain(value)));
  return { context, api, events, calls,
    workspace(cookie) { context.document.cookie = cookie; return plain(api.checkLibraryIdentity()); },
    emit(type) { for (const callback of listeners.get(type) || []) callback({ type }); },
    async naturalSession() { await context.fetch("/api/auth/session"); await flush(); },
  };
}

test("temporary missing selection and explicit W1-W2-W1 retain equal leases but different transition evidence", async () => {
  const temporary = harness(), changed = harness();
  for (const h of [temporary, changed]) await h.api.readLibraryAccount();
  temporary.workspace(""); temporary.workspace("_account=W1"); await temporary.naturalSession();
  changed.workspace("_account=W2"); changed.workspace("_account=W1"); await changed.naturalSession();
  const leases = h => h.events.map(({ transition, ...identity }) => identity);
  assert.deepEqual(leases(temporary), leases(changed), "provenance must not alter the established epoch or owner sequence");
  assert.deepEqual(temporary.events.map(value => value.epoch), [1, 2, 3, 4]);
  assert.deepEqual(temporary.events.filter(value => value.phase === "unavailable").map(value => value.transition),
    ["workspace-unconfirmed", "workspace-restored"]);
  assert.deepEqual(changed.events.filter(value => value.phase === "unavailable").map(value => value.transition),
    ["context-changed", "context-changed"], "returning to A cannot relabel an observed explicit B as initialization");
  assert.equal(temporary.calls.length, 2); assert.equal(changed.calls.length, 2);
  for (const h of [temporary, changed]) for (const value of h.events.filter(value => value.phase === "ready")) {
    assert.equal(Object.hasOwn(value, "transition"), false, "ready identities do not retain an obsolete failure cause");
  }
});

test("empty selected cookie is unconfirmed while explicit personal selection is a hard context change", async () => {
  for (const [cookie, expected] of [["_account=", "workspace-unconfirmed"], ["_account=personal", "context-changed"]]) {
    const h = harness(); await h.api.readLibraryAccount();
    assert.equal(h.workspace(cookie).transition, expected);
    assert.equal(h.api.activeWorkspace(), "personal", "the shared workspace/auth parser keeps its existing return contract");
    assert.equal(h.calls.length, 1);
  }
});

test("a malformed or explicit other selection permanently closes the soft restoration chain", async () => {
  for (const cookie of ["_account=%invalid", "_account=W2"]) {
    const h = harness(); await h.api.readLibraryAccount();
    assert.equal(h.workspace("").transition, "workspace-unconfirmed");
    assert.equal(h.workspace(cookie).transition, "context-changed");
    assert.equal(h.workspace("_account=W1").transition, "context-changed");
    await h.naturalSession();
    assert.equal(h.api.checkLibraryIdentity().phase, "ready");
    assert.equal(h.api.checkLibraryIdentity().epoch, 5);
  }
});

test("an independently authenticated personal owner resets the provenance comparison, never keeps the old workspace authority", async () => {
  const h = harness(); const original = await h.api.readLibraryAccount();
  h.workspace(""); const personal = await h.api.readLibraryAccount();
  assert.notEqual(personal.accountKey, original.accountKey);
  assert.deepEqual(JSON.parse(personal.accountKey), ["user-a", "personal"]);
  assert.equal(h.workspace("_account=W1").transition, "context-changed");
  assert.equal(h.calls.length, 2);
});

test("document pagehide is reported specifically without changing its epoch or stale-read fencing", async () => {
  const h = harness(); const owner = await h.api.readLibraryAccount();
  h.emit("pagehide");
  assert.deepEqual(h.events.at(-1), { accountKey: null, epoch: owner.epoch + 1, phase: "unavailable", transition: "document-hidden" });
  await assert.rejects(h.api.readLibraryAccount(), error => error.tidyCode === "CONTEXT_MISMATCH");
  h.emit("pageshow");
  assert.equal(h.api.checkLibraryIdentity().phase, "unavailable");
  const fresh = await h.api.readLibraryAccount();
  assert.equal(fresh.epoch, owner.epoch + 2); assert.equal(fresh.accountKey, owner.accountKey);
  assert.equal(Object.hasOwn(fresh, "transition"), false);
});

for (const outcome of ["ownerless", 401, 403]) test(`${outcome} session revocation is hard and never labelled workspace initialization`, async () => {
  const h = harness({ respond: count => count === 1 ? { body: session() }
    : outcome === "ownerless" ? { body: {} } : { status: outcome } });
  await h.api.readLibraryAccount(); await h.naturalSession();
  assert.deepEqual(h.events.at(-1), { accountKey: null, epoch: 2, phase: "unavailable", transition: "session-revoked" });
  const count = h.events.length; await h.naturalSession();
  assert.equal(h.events.length, count, "repeated failures do not change the established epoch rules");
  assert.equal(h.workspace("").transition, "context-changed", "a later missing cookie cannot soften the already-hard revocation");
});

test("a slow B proof cannot regain authority after an observed A-B-A workspace boundary", async () => {
  const held = deferred();
  const h = harness({ respond: count => count === 2 ? held.promise : { body: session("user-a", `current-${count}`) } });
  await h.api.readLibraryAccount();
  h.workspace("_account=W2");
  const old = h.api.readLibraryAccount();
  h.workspace("_account=W1");
  const current = await h.api.readLibraryAccount();
  held.resolve({ body: session("user-b", "stale-secret") });
  await assert.rejects(old, error => error.tidyCode === "CONTEXT_MISMATCH"); await flush();
  assert.deepEqual(plain(await h.api.readLibraryAccount()), plain(current));
  assert.equal(await h.api.loadAccessToken(), "current-3");
  assert.deepEqual(h.events.filter(value => value.phase === "unavailable").map(value => value.transition), ["context-changed", "context-changed"]);
  assert.equal(h.events.some(value => value.accountKey?.includes("user-b")), false);
  assert.equal(JSON.stringify(h.events).includes("secret"), false);
});

test("a soft unavailable cause upgraded by session revocation publishes once at the same existing epoch", async () => {
  const h = harness({ respond: count => count === 1 ? { body: session() } : { status: 401 } });
  await h.api.readLibraryAccount();
  h.workspace(""); h.workspace("_account=W1");
  assert.equal(h.api.checkLibraryIdentity().epoch, 3);
  await h.naturalSession();
  assert.deepEqual(h.events.slice(-2), [
    { accountKey: null, epoch: 3, phase: "unavailable", transition: "workspace-restored" },
    { accountKey: null, epoch: 3, phase: "unavailable", transition: "session-revoked" },
  ], "a pending navigation must see the hard cause even when no additional lease epoch was required");
  const count = h.events.length; await h.naturalSession();
  assert.equal(h.events.length, count, "same hard cause is not a repeating event stream");
  assert.equal(h.api.checkLibraryIdentity().epoch, 3);
});

test("initial missing selection and same-owner token renewal do not invent transition events or additional requests", async () => {
  const h = harness({ cookie: "" });
  assert.deepEqual(plain(h.api.checkLibraryIdentity()), { accountKey: null, epoch: 0, phase: "unavailable" });
  const first = await h.api.readLibraryAccount(); await h.naturalSession();
  assert.deepEqual(plain(await h.api.readLibraryAccount()), plain(first));
  assert.equal(h.events.length, 1); assert.equal(Object.hasOwn(h.events[0], "transition"), false); assert.equal(h.calls.length, 2);
});
