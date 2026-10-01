const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const { installPageSession } = require("./helpers/page-session.cjs");

const clone = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let n = 0; n < 12; n++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const body = (id = "user-a", token = "private-token") => ({ user: { id }, accessToken: token, activeAccountId: "shared-team" });

function harness({ cookie = "_account=team", respond, prerendering = false } = {}) {
  const calls = [], events = [], listeners = new Map();
  const documentListeners = new Map();
  let value = body();
  const context = vm.createContext({ URL, Request, Headers, document: { cookie, prerendering,
    addEventListener: (type, callback) => documentListeners.set(type, callback) },
    location: { href: "https://chatgpt.com/c/example", origin: "https://chatgpt.com" },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    fetch(input, init) {
      const call = { input, init, receiver: this, clones: 0, bodyReads: 0 };
      calls.push(call);
      call.promise = Promise.resolve(respond ? respond(call, calls.length) : { body: value }).then(result => {
        const status = result?.status ?? 200;
        call.response = { ok: status >= 200 && status < 300, status,
          json: async () => { call.bodyReads++; return result.readBody ? result.readBody() : result.body; },
          clone: () => { call.clones++; return { json: async () => result.body }; },
        };
        return call.response;
      });
      return call.promise;
    },
  });
  installPageSession(context);
  vm.runInContext(fs.readFileSync("src/platform/chatgpt/api.js", "utf8"), context);
  const api = context.TidyChatgptApi;
  api.onLibraryIdentityChanged(value => events.push(clone(value)));
  return { context, api, calls, events,
    setBody(next) { value = next; },
    emit(type) { for (const callback of listeners.get(type) || []) callback({ type }); },
    activatePrerender() {
      context.document.prerendering = false;
      const callback = documentListeners.get("prerenderingchange");
      documentListeners.delete("prerenderingchange");
      callback?.();
    },
  };
}

test("one initial session serves concurrent and repeated local ownership checks", async () => {
  const h = harness();
  const results = await Promise.all(Array.from({ length: 20 }, () => h.api.readLibraryAccount()));
  assert.equal(h.calls.length, 1);
  for (const value of results) assert.deepEqual(clone(value), clone(results[0]));
  for (let n = 0; n < 20; n++) {
    h.api.checkLibraryIdentity(); await h.api.readLibraryAccount();
  }
  assert.equal(h.calls.length, 1);
  assert.equal(h.events.length, 1);
  assert.deepEqual(Object.keys(results[0]), ["accountKey", "epoch"]);
  assert.equal(JSON.stringify(h.events).includes("private-token"), false);
});

test("prerender activation republishes an already-known owner without auth and initializes an unknown owner once", async () => {
  const known = harness({ prerendering: true });
  await known.api.readLibraryAccount();
  const identity = clone(known.api.checkLibraryIdentity());
  known.events.length = 0; // The inactive prerender's event was not delivered.
  known.activatePrerender();
  assert.deepEqual(known.events, [identity]);
  assert.equal(known.calls.length, 1);
  const unknown = harness({ prerendering: true });
  unknown.activatePrerender(); await flush();
  assert.equal(unknown.calls.length, 1);
  assert.equal(unknown.api.checkLibraryIdentity().phase, "ready");
  unknown.activatePrerender(); await flush();
  assert.equal(unknown.calls.length, 1);
});

test("a pre-existing natural session read initializes ownership without an extra request", async () => {
  const waiting = deferred();
  const h = harness({ respond: () => waiting.promise });
  const native = h.context.fetch("/api/auth/session");
  const owner = h.api.readLibraryAccount();
  assert.equal(h.calls.length, 1);
  waiting.resolve({ body: body() });
  assert.equal(await native, h.calls[0].response, "the observer returns the original Response");
  assert.equal((await owner).accountKey, JSON.stringify(["user-a", "team"]));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].bodyReads, 0, "the page response body was not consumed");
});

test("natural same-workspace user changes advance the epoch; token renewal does not", async () => {
  const h = harness();
  const first = await h.api.readLibraryAccount();
  h.setBody(body("user-a", "renewed-secret"));
  await h.context.fetch("/api/auth/session"); await flush();
  assert.deepEqual(clone(await h.api.readLibraryAccount()), clone(first));
  assert.equal(h.events.length, 1);
  assert.equal(await h.api.loadAccessToken(), "renewed-secret");
  h.setBody(body("user-b", "other-secret"));
  await h.context.fetch("/api/auth/session"); await flush();
  const second = await h.api.readLibraryAccount();
  assert.equal(second.accountKey, JSON.stringify(["user-b", "team"]));
  assert.equal(second.epoch, first.epoch + 1);
  assert.equal(h.calls.length, 3, "only the two simulated site reads followed initialization");
  assert.equal(JSON.stringify(h.events).includes("secret"), false);
});

test("a new owner without a token cannot inherit the previous owner's authenticated cache", async () => {
  const h = harness(); await h.api.readLibraryAccount();
  h.setBody({ user: { id: "user-b" } });
  await h.context.fetch("/api/auth/session"); await flush();
  assert.equal((await h.api.readLibraryAccount()).accountKey, JSON.stringify(["user-b", "team"]));
  h.setBody(body("user-b", "user-b-token"));
  assert.equal(await h.api.loadAccessToken(), "user-b-token");
  assert.equal(h.calls.length, 3, "token acquisition cannot return the prior user's cached credential");
});

test("the passive observer clones only the exact same-origin session endpoint and preserves fetch arguments", async () => {
  const h = harness();
  const ignored = ["/backend-api/conversation/example", "/api/auth/session?query=1",
    "https://other.example/api/auth/session", "/api/auth/session-other"];
  for (const url of ignored) await h.context.fetch(url);
  await flush();
  assert.equal(h.events.length, 0);
  assert.equal(h.calls.every(call => call.clones === 0), true);
  const request = new Request("https://chatgpt.com/api/auth/session");
  const init = { method: "GET", headers: { "x-fixture": "same-object" } };
  const receiver = { fixture: true };
  const result = h.context.fetch.call(receiver, request, init);
  const call = h.calls.at(-1);
  assert.equal(result, call.promise, "the native promise is also preserved");
  assert.equal(call.input, request); assert.equal(call.init, init); assert.equal(call.receiver, receiver);
  assert.equal(await result, call.response); await flush();
  assert.equal(call.clones, 1); assert.equal(call.bodyReads, 0);
  assert.equal((await h.api.readLibraryAccount()).accountKey, JSON.stringify(["user-a", "team"]));
  await h.context.fetch(new URL("https://chatgpt.com/api/auth/session")); await flush();
  assert.equal(h.calls.at(-1).clones, 1, "native URL objects are accepted just like Request objects");
});

test("a failed initialization is not retried by subsequent ordinary actions", async () => {
  let status = 429;
  const h = harness({ respond: () => ({ status, body: body() }) });
  for (let n = 0; n < 10; n++) {
    await assert.rejects(h.api.readLibraryAccount(), error => error.status === 429);
  }
  assert.equal(h.calls.length, 1);
  assert.equal(h.events.length, 0);
  status = 200; await h.context.fetch("/api/auth/session"); await flush();
  assert.equal((await h.api.readLibraryAccount()).accountKey, JSON.stringify(["user-a", "team"]));
  assert.equal(h.calls.length, 2, "a later natural success restores the lease without an extra retry");
});

test("only an explicit retry re-arms a failed initializer, with concurrent retries still coalesced", async () => {
  let status = 503;
  const h = harness({ respond: () => ({ status, body: body() }) });
  await assert.rejects(h.api.readLibraryAccount(), error => error.status === 503);
  await assert.rejects(h.api.readLibraryAccount(), error => error.status === 503);
  assert.equal(h.calls.length, 1);
  status = 200;
  const values = await Promise.all(Array.from({ length: 8 }, () => h.api.readLibraryAccount({ retry: true })));
  assert.equal(h.calls.length, 2);
  for (const value of values) assert.equal(value.accountKey, JSON.stringify(["user-a", "team"]));
  await h.api.readLibraryAccount({ retry: true });
  assert.equal(h.calls.length, 2, "a ready identity is not refreshed even by an explicit retry flag");
});

test("workspace changes revoke locally then permit exactly one new initialization", async () => {
  const h = harness();
  const first = await h.api.readLibraryAccount();
  h.context.document.cookie = "_account=second-team";
  const invalid = h.api.checkLibraryIdentity();
  assert.equal(invalid.accountKey, null); assert.equal(invalid.phase, "unavailable");
  assert.ok(invalid.epoch > first.epoch);
  assert.equal(h.calls.length, 1, "local detection itself is network-free");
  const owners = await Promise.all([h.api.readLibraryAccount(), h.api.readLibraryAccount()]);
  assert.equal(owners[0].accountKey, JSON.stringify(["user-a", "second-team"]));
  assert.equal(h.calls.length, 2);
  h.context.document.cookie = "_account=%invalid";
  h.api.checkLibraryIdentity(); h.api.checkLibraryIdentity();
  const eventCount = h.events.length;
  for (let n = 0; n < 5; n++) await assert.rejects(h.api.readLibraryAccount(), error => error.tidyCode === "CONTEXT_MISMATCH");
  assert.equal(h.events.length, eventCount); assert.equal(h.calls.length, 2);
});

test("a workspace change during initialization rejects the old response and does not auto-loop", async () => {
  const waiting = deferred();
  const h = harness({ respond: (_call, number) => number === 1 ? waiting.promise : { body: body("user-b") } });
  const pending = h.api.readLibraryAccount();
  h.context.document.cookie = "_account=changed";
  waiting.resolve({ body: body("user-a", "stale-secret") });
  await assert.rejects(pending, error => error.tidyCode === "CONTEXT_MISMATCH");
  assert.equal(h.calls.length, 1);
  assert.equal(h.api.checkLibraryIdentity().phase, "unavailable");
  assert.equal((await h.api.readLibraryAccount()).accountKey, JSON.stringify(["user-b", "changed"]));
  assert.equal(await h.api.loadAccessToken(), "private-token");
  assert.equal(h.calls.length, 2);
});

test("an older in-flight session response cannot restore a previous owner or token", async () => {
  const old = deferred();
  const h = harness({ respond: (_call, number) => number === 2 ? old.promise : { body: body(number === 1 ? "user-a" : "user-b", number === 1 ? "a-token" : "b-token") } });
  await h.api.readLibraryAccount();
  const slow = h.api.loadSession({ refresh: true });
  await h.context.fetch("/api/auth/session"); await flush();
  const winner = await h.api.readLibraryAccount();
  old.resolve({ body: body("user-a", "stale-token") });
  await slow; await flush();
  assert.deepEqual(clone(await h.api.readLibraryAccount()), clone(winner));
  assert.equal(winner.accountKey, JSON.stringify(["user-b", "team"]));
  assert.equal(await h.api.loadAccessToken(), "b-token");
  assert.equal(h.calls.length, 3);
});

for (const initialized of [false, true]) for (const order of [[0, 1], [1, 0]]) {
  test(`concurrent natural proofs keep the later request authoritative (ready=${initialized}, order=${order.join("-")})`, async () => {
    const gates = [deferred(), deferred()];
    const h = harness({ respond: (_call, number) => initialized && number === 1
      ? { body: body("initial-user") } : gates[number - (initialized ? 2 : 1)].promise });
    if (initialized) await h.api.readLibraryAccount();
    const requests = [h.context.fetch("/api/auth/session"), h.context.fetch("/api/auth/session")];
    const initialOwner = initialized ? null : h.api.readLibraryAccount();
    for (const index of order) {
      gates[index].resolve({ body: body(index === 0 ? "earlier-user" : "later-user", `token-${index}`) });
      await requests[index]; await flush();
    }
    if (initialOwner) assert.equal((await initialOwner).accountKey, JSON.stringify(["later-user", "team"]));
    assert.equal((await h.api.readLibraryAccount()).accountKey, JSON.stringify(["later-user", "team"]));
    assert.equal(await h.api.loadAccessToken(), "token-1");
    assert.equal(h.calls.length, initialized ? 3 : 2, "proof ordering never causes a replacement auth read");
  });
}

test("slow original JSON cannot overwrite a newer token after its clone already accepted the same owner", async () => {
  const slowBody = deferred();
  const h = harness({ respond: (_call, number) => ({ body: body("user-a", `token-${number}`),
    ...(number === 2 ? { readBody: () => slowBody.promise } : {}),
  }) });
  await h.api.readLibraryAccount();
  const slow = h.api.loadSession({ refresh: true }); await flush();
  assert.equal(await h.api.loadAccessToken(), "token-2", "the passive clone completed first");
  await h.context.fetch("/api/auth/session"); await flush();
  assert.equal(await h.api.loadAccessToken(), "token-3");
  slowBody.resolve(body("user-a", "token-2")); await slow;
  assert.equal(await h.api.loadAccessToken(), "token-3", "a lower request sequence cannot roll the token back");
});

test("pagehide fences pending work and a pageshow restoration starts a new lease", async () => {
  const old = deferred();
  const h = harness({ respond: (_call, number) => number === 1 ? old.promise : { body: body("user-b") } });
  const pending = h.api.readLibraryAccount();
  h.emit("pagehide");
  await assert.rejects(h.api.readLibraryAccount(), error => error.tidyCode === "CONTEXT_MISMATCH");
  h.emit("pageshow");
  const restored = await h.api.readLibraryAccount();
  old.resolve({ body: body("user-a", "stale-secret") });
  await assert.rejects(pending, error => error.tidyCode === "CONTEXT_MISMATCH");
  await flush();
  assert.deepEqual(clone(await h.api.readLibraryAccount()), clone(restored));
  assert.equal(restored.accountKey, JSON.stringify(["user-b", "team"]));
  assert.equal(h.calls.length, 2);
});

test("pageshow independently republishes the unavailable epoch even when pagehide delivery was lost", async () => {
  const h = harness(); const first = await h.api.readLibraryAccount();
  h.emit("pagehide");
  const hiddenEpoch = h.api.checkLibraryIdentity().epoch;
  h.events.length = 0; // A worker may reject the cached-document pagehide sender.
  h.emit("pageshow");
  assert.deepEqual(h.events, [{ accountKey: null, epoch: hiddenEpoch, phase: "unavailable", transition: "document-hidden" }]);
  assert.ok(hiddenEpoch > first.epoch);
  assert.equal(h.calls.length, 1, "restoring the invalidation signal does not fetch auth");
  h.emit("pageshow");
  assert.equal(h.events.length, 1, "an ordinary pageshow does not duplicate the recovery boundary");
  const restored = await h.api.readLibraryAccount();
  assert.ok(restored.epoch > hiddenEpoch); assert.equal(h.calls.length, 2);
});

test("natural rate-limit/network failures preserve a ready owner, but explicit session rejection revokes it", async () => {
  let status = 200, fail = false;
  const h = harness({ respond: () => { if (fail) throw new Error("network fixture"); return { status, body: body() }; } });
  const first = await h.api.readLibraryAccount();
  status = 429; await h.context.fetch("/api/auth/session"); await flush();
  assert.deepEqual(clone(await h.api.readLibraryAccount()), clone(first));
  fail = true; assert.throws(() => h.context.fetch("/api/auth/session"), /network fixture/);
  assert.deepEqual(clone(await h.api.readLibraryAccount()), clone(first));
  fail = false; status = 401; await h.context.fetch("/api/auth/session"); await flush();
  assert.equal(h.api.checkLibraryIdentity().phase, "unavailable");
  for (let n = 0; n < 5; n++) await assert.rejects(h.api.readLibraryAccount());
  assert.equal(h.calls.length, 4, "a rejected session is not automatically fetched on each action");
  status = 200; await h.context.fetch("/api/auth/session"); await flush();
  assert.ok((await h.api.readLibraryAccount()).epoch > first.epoch);
});

test("successful session responses without a valid user revoke ownership without leaking the body", async () => {
  const h = harness(); await h.api.readLibraryAccount();
  h.setBody({ user: null, accessToken: "do-not-broadcast", error: "private-detail" });
  await h.context.fetch("/api/auth/session"); await flush();
  assert.equal(h.api.checkLibraryIdentity().phase, "unavailable");
  await assert.rejects(h.api.readLibraryAccount(), error => error.tidyCode === "LIBRARY_ACCOUNT_UNAVAILABLE");
  assert.equal(h.calls.length, 2);
  assert.doesNotMatch(JSON.stringify(h.events), /do-not-broadcast|private-detail/);
});
