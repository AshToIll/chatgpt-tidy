const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const { installPageSession } = require("./helpers/page-session.cjs");
const { snapshotHarness } = require("./helpers/adapter-snapshot.cjs");

function libraryHarness({ cookie = "", session = { user: { id: "user-one" }, accessToken: "private-token", activeAccountId: "shared-team" }, onRead } = {}) {
  const calls = [];
  const context = vm.createContext({ document: { cookie }, fetch: async (url, init) => {
    calls.push({ url, init });
    const body = onRead ? await onRead(context, calls.length) : session;
    return { ok: true, status: 200, json: async () => body };
  } });
  installPageSession(context);
  vm.runInContext(fs.readFileSync("src/platform/chatgpt/api.js", "utf8"), context);
  return { api: context.TidyChatgptApi, context, calls };
}

test("library ownership reuses the observed user-plus-workspace session until a real identity signal", async () => {
  let user = "user-one";
  const h = libraryHarness({ cookie: "_account=team%20one", onRead: async () => ({
    user: { id: user }, accessToken: "private-token", activeAccountId: "shared-team",
  }) });
  await h.api.loadSession(); // Deliberately populate the general reader's cache.
  const first = await h.api.readLibraryAccount();
  user = "user-two";
  const unchanged = await h.api.readLibraryAccount();
  assert.equal(unchanged.accountKey, first.accountKey, "unobserved fixture changes cannot cause an auth request");
  await h.api.loadSession({ refresh: true }); // An independently required session read observes the switch.
  const second = await h.api.readLibraryAccount();
  h.context.document.cookie = "_account=team%20two"; const third = await h.api.readLibraryAccount();
  h.context.document.cookie = ""; const personal = await h.api.readLibraryAccount();
  assert.deepEqual(JSON.parse(first.accountKey), ["user-one", "team one"]);
  assert.deepEqual(JSON.parse(second.accountKey), ["user-two", "team one"]);
  assert.deepEqual(JSON.parse(third.accountKey), ["user-two", "team two"]);
  assert.deepEqual(JSON.parse(personal.accountKey), ["user-two", "personal"]);
  assert.equal(new Set([first, second, third, personal].map(value => value.accountKey)).size, 4);
  assert.equal(h.calls.length, 4, "only initial/session-change/workspace initialization reads use the network");
  assert.equal(h.calls.every(call => call.url === "/api/auth/session" && call.init.cache === "no-store"), true);
  for (const value of [first, second, third, personal]) {
    assert.deepEqual(Object.keys(value), ["accountKey", "epoch"]); assert.equal(JSON.stringify(value).includes("private-token"), false);
  }
});

test("library ownership rejects missing users and malformed or changing workspace selections", async () => {
  for (const user of [undefined, null, {}, { id: "" }, { id: " " }, { id: 12 }, { id: " user-one " }]) {
    const h = libraryHarness({ session: { user, activeAccountId: "shared-team", accessToken: "private-token" } });
    await assert.rejects(h.api.readLibraryAccount(), error => error.tidyCode === "LIBRARY_ACCOUNT_UNAVAILABLE");
    assert.equal(h.calls.length, 1);
  }
  const malformed = libraryHarness({ cookie: "_account=%invalid" });
  await assert.rejects(malformed.api.readLibraryAccount(), error => error.tidyCode === "CONTEXT_MISMATCH");
  assert.equal(malformed.calls.length, 0, "malformed selection is not a personal workspace fallback");
  const changed = libraryHarness({ cookie: "_account=before", onRead: async context => {
    context.document.cookie = "_account=after"; return { user: { id: "user-one" }, accessToken: "private-token" };
  } });
  await assert.rejects(changed.api.readLibraryAccount(), error => error.tidyCode === "CONTEXT_MISMATCH");
  assert.equal(changed.calls.length, 1, "an account change never triggers an implicit replacement read");
});

test("the real main-world library action retains its epoch and broadcasts confirmed workspace identity changes", async () => {
  let user = "first", reads = 0;
  const h = snapshotHarness({ url: "https://chatgpt.com/", returnSession: true, fetch: async (url) => {
    assert.equal(url, "/api/auth/session"); reads++;
    return { ok: true, status: 200, json: async () => ({ user: user && { id: user }, accessToken: "never-expose", activeAccountId: "shared-team" }) };
  } });
  h.setCookie("_account=team");
  const first = await h.requestTitle("LIBRARY_ACCOUNT", {}); user = "second";
  const second = await h.requestTitle("LIBRARY_ACCOUNT", {});
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  assert.equal(first.payload.accountKey, JSON.stringify(["first", "team"]));
  assert.deepEqual(second.payload, first.payload);
  assert.equal(reads, 1, "ordinary bridge ownership checks are local after initialization");
  h.setCookie("_account=other");
  const changed = await h.requestTitle("LIBRARY_ACCOUNT", {});
  assert.equal(changed.payload.accountKey, JSON.stringify(["second", "other"]));
  assert.ok(changed.payload.epoch > first.payload.epoch);
  const events = h.postedMessages().filter(item => item.envelope.type === "library.identity-changed").map(item => item.envelope.payload);
  assert.ok(events.some(event => event.phase === "unavailable" && event.accountKey === null));
  assert.ok(events.some(event => event.phase === "ready" && event.accountKey === changed.payload.accountKey));
  user = null; h.setCookie("_account=last"); const failed = await h.requestTitle("LIBRARY_ACCOUNT", {});
  assert.equal(failed.ok, false); assert.equal(failed.error.code, "LIBRARY_ACCOUNT_UNAVAILABLE");
  assert.equal(reads, 3); assert.equal(JSON.stringify(h.postedMessages()).includes("never-expose"), false);
});

test("main-world observes natural session results and checks SPA workspace changes without authenticating", async () => {
  let page, user = "first", reads = 0;
  const h = snapshotHarness({ url: "https://chatgpt.com/", returnSession: true, fetch: function (url) {
    page = this; reads++;
    assert.equal(url, "/api/auth/session");
    const body = { user: { id: user }, accessToken: "never-expose" };
    return Promise.resolve({ ok: true, status: 200, json: async () => body, clone: () => ({ json: async () => body }) });
  } });
  const first = await h.requestTitle("LIBRARY_ACCOUNT", {});
  user = "second"; await page.fetch("/api/auth/session");
  for (let n = 0; n < 8; n++) await new Promise(resolve => setImmediate(resolve));
  const second = await h.requestTitle("LIBRARY_ACCOUNT", {});
  assert.equal(second.payload.accountKey, JSON.stringify(["second", "personal"]));
  assert.ok(second.payload.epoch > first.payload.epoch);
  assert.equal(reads, 2, "the natural read is not duplicated by the library request");
  page.queueMicrotask = callback => callback();
  page.history.pushState({}, "", "/c/ordinary");
  assert.equal(reads, 2, "an ordinary SPA event never reads auth");
  h.setCookie("_account=changed");
  page.history.replaceState({}, "", "/c/ordinary");
  const event = h.postedMessages().filter(item => item.envelope.type === "library.identity-changed").at(-1).envelope.payload;
  assert.equal(event.phase, "unavailable"); assert.equal(event.accountKey, null);
  assert.equal(reads, 2, "workspace detection publishes locally before any initialization request");
});

test("library-stamped snapshots reject stale identities before and after their synchronous projection", async () => {
  let page, reads = 0;
  const h = snapshotHarness({ url: "https://chatgpt.com/", returnSession: true, fetch: function () {
    page = this; reads++;
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ user: { id: "first" }, accessToken: "secret" }) });
  } });
  const owner = (await h.requestTitle("LIBRARY_ACCOUNT", {})).payload;
  const accepted = await h.requestTitle("GET_SNAPSHOT", { expectedLibraryIdentity: owner });
  assert.equal(accepted.ok, true);
  const original = page.document.querySelectorAll;
  let changed = false;
  page.document.querySelectorAll = function (selector) {
    if (!changed) { changed = true; this.cookie = "_account=after-build-start"; }
    return original.call(this, selector);
  };
  const after = await h.requestTitle("GET_SNAPSHOT", { expectedLibraryIdentity: owner });
  assert.equal(after.ok, false); assert.equal(after.error.code, "CONTEXT_MISMATCH");
  const before = await h.requestTitle("GET_SNAPSHOT", { expectedLibraryIdentity: owner });
  assert.equal(before.ok, false); assert.equal(before.error.code, "CONTEXT_MISMATCH");
  const malformed = await h.requestTitle("GET_SNAPSHOT", { expectedLibraryIdentity: null });
  assert.equal(malformed.ok, false); assert.equal(malformed.error.code, "CONTEXT_MISMATCH");
  assert.equal(reads, 1, "all four ownership stamp checks are local and never initialize a new owner");
});

test("main-world forwards an explicit failed-identity retry but never treats ordinary reads as retries", async () => {
  let reads = 0, status = 429;
  const h = snapshotHarness({ url: "https://chatgpt.com/", returnSession: true, fetch: async () => {
    reads++;
    return { ok: status === 200, status, json: async () => ({ user: { id: "user" }, accessToken: "secret" }) };
  } });
  assert.equal((await h.requestTitle("LIBRARY_ACCOUNT", {})).ok, false);
  assert.equal((await h.requestTitle("LIBRARY_ACCOUNT", {})).ok, false);
  assert.equal(reads, 1);
  status = 200;
  const retried = await h.requestTitle("LIBRARY_ACCOUNT", { retry: true });
  assert.equal(retried.ok, true); assert.equal(reads, 2);
  assert.deepEqual((await h.requestTitle("LIBRARY_ACCOUNT", { retry: true })).payload, retried.payload);
  assert.equal(reads, 2);
});

test("catalog identity is one pure session projection with unchanged directory precedence", () => {
  const context = vm.createContext({ fetch() { throw new Error("Pure identity projection must not fetch"); } });
  installPageSession(context);
  vm.runInContext(fs.readFileSync("src/platform/chatgpt/api.js", "utf8"), context);
  const project = context.TidyChatgptApi.catalogIdentity;
  for (const [session, accountKey, accountId] of [
    [{ activeAccountId: " camel ", active_account_id: "snake", account: { id: "nested" }, user: { id: "user" } }, "camel", "camel"],
    [{ activeAccountId: " ", active_account_id: " snake ", account: { id: "nested" }, user: { id: "user" } }, "snake", "snake"],
    [{ activeAccountId: 123, active_account_id: null, account: { id: " nested " }, user: { id: "user" } }, "nested", "nested"],
    [{ account: { id: [] }, user: { id: " user " } }, "user", null],
    [{ user: { id: " " } }, "", null],
    [null, "", null],
  ]) {
    const original = JSON.stringify(session);
    assert.deepEqual(JSON.parse(JSON.stringify(project(session))), { accountKey, accountId });
    assert.equal(JSON.stringify(session), original, "projection does not change the supplied session");
  }
});

test("session HTTP errors retain status through the account reader without implicit retry or body leakage", async () => {
  for (const [status, category] of [[401, "AUTH"], [403, "AUTH"], [429, "HTTP"], [503, "HTTP"]]) {
    let calls = 0, bodyReads = 0;
    const context = vm.createContext({ fetch: async () => { calls++; return {
      ok: false, status, json: async () => { bodyReads++; return { token: "must-not-escape" }; },
    }; } });
    installPageSession(context);
    for (const file of ["api", "messages"]) vm.runInContext(fs.readFileSync("src/platform/chatgpt/" + file + ".js", "utf8"), context);
    await assert.rejects(context.TidyChatgptMessages.account({ refresh: true }), error => {
      assert.equal(error.category, category); assert.equal(error.status, status); assert.equal(error.retryable, true);
      assert.equal(JSON.stringify(error).includes("must-not-escape"), false); return true;
    });
    assert.equal(calls, 1); assert.equal(bodyReads, 0);
  }
});
