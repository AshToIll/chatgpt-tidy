const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = file => fs.readFileSync(path.resolve(__dirname, "../src", file), "utf8");
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const credentials = { user: { id: "synthetic-owner" }, accessToken: "synthetic-token" };
const stopped = error => error.tidyCode === "ADAPTER_UNAVAILABLE"
  && error.details?.stage === "page-session" && error.details.disconnect === "context-invalidated";

function harness(fetch) {
  const attributes = new Map();
  const document = Object.assign(new EventTarget(), { cookie: "", documentElement: {
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: name => attributes.get(name),
  } });
  const makeRealm = () => {
    const window = new EventTarget();
    return vm.createContext({ document, Event, AbortController, AbortSignal, URL, Headers,
      location: new URL("https://chatgpt.com/c/synthetic-current"),
      addEventListener: window.addEventListener.bind(window),
      removeEventListener: window.removeEventListener.bind(window),
    });
  };
  const main = makeRealm(), isolated = makeRealm();
  const runtime = { id: "synthetic-extension", sendMessage() { throw Error("No Worker IPC is allowed in a local liveness check"); } };
  const calls = [];
  for (const context of [main, isolated]) vm.runInContext(source("platform/session/shared/page-session.js"), context);
  // Keep two genuine contract instances sharing DOM events, as the browser's
  // MAIN and ISOLATED worlds do. No watchdog tick and no explicit stop() are
  // used below: a late continuation must discover runtime.id invalidation.
  main.TidyPageSession = main.TidyPageSessionContract.create();
  isolated.TidyPageSession = isolated.TidyPageSessionContract.create({ runtime });
  main.fetch = (url, init) => { calls.push({ url, init }); return fetch(url, init); };
  vm.runInContext(source("platform/chatgpt/api.js"), main);
  return { runtime, calls, main, isolated, api: main.TidyChatgptApi };
}

test("late auth after runtime invalidation cannot start a backend request before the watchdog tick", async () => {
  const auth = deferred();
  const h = harness(() => auth.promise);
  const pending = h.api.fetchAuthenticated("/backend-api/conversations");
  assert.equal(h.calls.length, 1);
  h.runtime.id = null;
  auth.resolve(response(credentials));
  await assert.rejects(pending, stopped);
  assert.deepEqual(h.calls.map(call => call.url), ["/api/auth/session"]);
  assert.equal(h.main.TidyPageSession.signal.aborted, true);
  assert.equal(h.isolated.TidyPageSession.signal.aborted, true);
});

test("late 401 after runtime invalidation does not refresh auth or retry before the watchdog tick", async () => {
  const backend = deferred(), entered = deferred();
  const h = harness(url => {
    if (url === "/api/auth/session") return Promise.resolve(response(credentials));
    entered.resolve();
    return backend.promise;
  });
  const pending = h.api.fetchAuthenticated("/backend-api/conversations");
  await entered.promise;
  h.runtime.id = undefined;
  backend.resolve(response(null, 401));
  await assert.rejects(pending, stopped);
  assert.deepEqual(h.calls.map(call => call.url), ["/api/auth/session", "/backend-api/conversations"]);
});

test("the final title API dispatch checks the live isolated runtime rather than its old active marker", () => {
  const h = harness(() => Promise.resolve(response({})));
  h.runtime.id = null;
  assert.throws(() => h.api.fetchTitleRequest("/backend-api/conversation/id/synthetic-current/rename", {
    method: "POST", body: JSON.stringify({ title: "Must not be dispatched" }),
  }), stopped);
  assert.equal(h.calls.length, 0);
});
