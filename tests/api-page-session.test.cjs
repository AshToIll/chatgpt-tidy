const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const { installPageSession } = require("./helpers/page-session.cjs");

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
const sessionBody = { user: { id: "owner" }, accessToken: "page-memory-only" };
const response = (body = sessionBody, status = 200) => ({ ok: status < 400, status, json: async () => body });
const stopped = error => error.tidyCode === "ADAPTER_UNAVAILABLE"
  && error.details?.stage === "page-session" && error.details?.disconnect === "context-invalidated";

function harness(fetch) {
  const calls = [], listeners = new Map();
  const originalFetch = function (...args) {
    calls.push({ args, receiver: this });
    return fetch(...args);
  };
  const context = vm.createContext({ URL, Headers, AbortController, AbortSignal,
    document: { cookie: "" }, location: new URL("https://chatgpt.com/c/current"),
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
    fetch: originalFetch,
  });
  installPageSession(context);
  vm.runInContext(fs.readFileSync("src/platform/chatgpt/api.js", "utf8"), context);
  return { context, calls, originalFetch, api: context.TidyChatgptApi, lifecycle: context.TidyPageSession,
    emit: type => listeners.get(type)?.({ type }) };
}

test("retirement aborts a TIDY session and rejects its late response before reading or caching it", async () => {
  const waiting = deferred(); let bodyReads = 0;
  const h = harness(() => waiting.promise);
  const request = h.api.loadSession();
  const signal = h.calls[0].args[1].signal;
  h.lifecycle.stop("extension-reloaded");
  assert.equal(signal.aborted, true);
  waiting.resolve({ ...response(), json: async () => { bodyReads++; return sessionBody; } });
  await assert.rejects(request, stopped);
  await assert.rejects(h.api.loadAccessToken(), stopped);
  await assert.rejects(h.api.readLibraryAccount({ retry: true }), stopped);
  assert.equal(bodyReads, 0);
  assert.equal(h.calls.length, 1);
});

test("retirement while session JSON is pending prevents the authenticated follow-up fetch", async () => {
  const body = deferred();
  const h = harness(() => Promise.resolve({ ...response(), json: () => body.promise }));
  const request = h.api.fetchAuthenticated("/backend-api/conversations");
  await flush();
  h.lifecycle.stop("extension-reloaded"); body.resolve(sessionBody);
  await assert.rejects(request, stopped);
  assert.equal(h.calls.length, 1);
});

test("a late 401 after retirement cannot refresh auth or retry the backend request", async () => {
  const backend = deferred();
  const h = harness(url => url === "/api/auth/session" ? Promise.resolve(response()) : backend.promise);
  await h.api.loadSession();
  const request = h.api.fetchAuthenticated("/backend-api/conversations");
  await flush(); assert.equal(h.calls.length, 2);
  h.lifecycle.stop("extension-reloaded"); backend.resolve(response(null, 401));
  await assert.rejects(request, stopped);
  assert.equal(h.calls.length, 2);
});

test("retirement during a 401 refresh prevents the second backend request", async () => {
  const refresh = deferred(); let sessions = 0;
  const h = harness(url => url === "/api/auth/session"
    ? ++sessions === 1 ? Promise.resolve(response()) : refresh.promise
    : Promise.resolve(response(null, 401)));
  const request = h.api.fetchAuthenticated("/backend-api/conversations");
  await flush(); assert.equal(h.calls.length, 3);
  h.lifecycle.stop("extension-reloaded"); refresh.resolve(response());
  await assert.rejects(request, stopped);
  assert.equal(h.calls.length, 3);
});

test("retirement restores only its own fetch hook and never aborts or clones a pending native request", async () => {
  const native = deferred(); let clones = 0;
  const h = harness(() => native.promise);
  const wrapper = h.context.fetch, receiver = {};
  const request = wrapper.call(receiver, "/api/auth/session");
  assert.equal(request, native.promise);
  assert.equal(h.calls[0].args.length, 1, "native arguments are not rewritten");
  assert.equal(h.calls[0].receiver, receiver);
  h.lifecycle.stop("extension-reloaded");
  assert.equal(h.context.fetch, h.originalFetch);
  native.resolve({ ...response(), clone: () => { clones++; return response(); } });
  await request; await flush();
  assert.equal(clones, 0);
  h.emit("pageshow");
  await assert.rejects(h.api.loadSession(), stopped);
  assert.equal(h.calls.length, 1);
});

test("a third-party hook stays installed and its retained TIDY wrapper becomes an exact passthrough", async () => {
  const native = Promise.resolve(response()); let failure = null;
  const h = harness(() => { if (failure) throw failure; return native; });
  const retained = h.context.fetch;
  const thirdParty = function (...args) { return retained.apply(this, args); };
  h.context.fetch = thirdParty;
  h.lifecycle.stop("extension-reloaded");
  assert.equal(h.context.fetch, thirdParty);
  const receiver = {}, controller = new AbortController(), init = { signal: controller.signal };
  assert.equal(thirdParty.call(receiver, "/api/auth/session", init), native);
  assert.equal(h.calls[0].args[1], init);
  assert.equal(h.calls[0].receiver, receiver);
  assert.equal(controller.signal.aborted, false);
  failure = new Error("native synchronous failure");
  assert.throws(() => thirdParty.call(receiver, "/api/auth/session", init), error => error === failure);
});

test("title requests combine caller abort with retirement without mutating the caller init", async () => {
  const h = harness(() => Promise.resolve(response({})));
  const caller = new AbortController(), init = { method: "POST", signal: caller.signal, body: '{"title":"New"}' };
  await h.api.fetchTitleRequest("/backend-api/conversation/id/current/rename", init);
  const signal = h.calls[0].args[1].signal;
  assert.notEqual(signal, caller.signal);
  assert.equal(init.signal, caller.signal);
  h.lifecycle.stop("extension-reloaded");
  assert.equal(signal.aborted, true);
  assert.equal(caller.signal.aborted, false);
  assert.throws(() => h.api.fetchTitleRequest("/backend-api/conversation/id/current/rename", init), stopped);
  assert.equal(h.calls.length, 1);
});
