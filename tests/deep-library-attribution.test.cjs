const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const flush = () => new Promise(setImmediate);
const makeLibrary = (accountKey = "fixture-account", revision = 1) => ({
  accountKey, identity: { documentId: "fixture-document", epoch: 0 },
  favorites: { accountKey, revision, items: {}, groups: [] },
  bookmarks: { accountKey, revision, items: {}, groups: [] },
});
async function harness() {
  const calls = []; let identityListener;
  const context = vm.createContext({
    crypto: webcrypto, console, Date, setTimeout, clearTimeout,
    addEventListener() {}, removeEventListener() {},
    chrome: { runtime: { onMessage: { addListener() {}, removeListener() {} } } },
    TidyContentBridge: { onLibraryIdentityChanged(callback) { identityListener = callback; return () => {}; } },
    TidyPageSession: {
      check: () => true, assertActive() {}, onDispose() {},
      runtimeRequest(envelope) { return new Promise((resolve, reject) => calls.push({ envelope, resolve, reject })); },
    },
  });
  for (const file of ["src/platform/protocol.js", "src/platform/library/library-hydration.js", "src/platform/library/content/library-client.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context, { filename: file });
  }
  await flush();
  const respond = (index, data) => calls[index].resolve(context.TidyProtocol.response(calls[index].envelope, data));
  respond(0, makeLibrary()); await flush();
  return { client: context.TidyLibraryClient, protocol: context.TidyProtocol, calls, respond,
    depart: () => identityListener({ phase: "unavailable" }) };
}
test("post-response owner validation retains the request that actually ran", async () => {
  const h = await harness(), lease = h.client.capture();
  const result = h.client.request(h.protocol.Type.FAVORITES_TOGGLE_SIDEBAR, {}, lease);
  const checked = assert.rejects(result, error => {
    assert.equal(error.code, "CONTEXT_MISMATCH");
    assert.equal(error.requestId, h.calls[1].envelope.requestId); return true;
  });
  await flush(); h.depart(); h.respond(1, makeLibrary().favorites); await checked;
  assert.equal(h.client.current(), null, "receipt must not revive departed account");
});
test("malformed mutation owner retains request correlation without accepting data", async () => {
  const h = await harness(), before = h.client.current();
  const result = h.client.request(h.protocol.Type.FAVORITES_TOGGLE_SIDEBAR, {}, h.client.capture());
  const checked = assert.rejects(result, error => {
    assert.equal(error.code, "CONTEXT_MISMATCH");
    assert.equal(error.requestId, h.calls[1].envelope.requestId); return true;
  });
  await flush(); h.respond(1, makeLibrary("foreign-fixture").favorites); await checked;
  assert.equal(h.client.current(), before);
});
test("successful mutation payload stays unchanged and pre-dispatch denial invents no request", async () => {
  const h = await harness(), payload = makeLibrary("fixture-account", 2).favorites;
  const result = h.client.request(h.protocol.Type.FAVORITES_TOGGLE_SIDEBAR, {}, h.client.capture());
  await flush(); h.respond(1, payload);
  assert.equal(await result, payload);
  assert.equal(Object.hasOwn(payload, "requestId"), false);
  const count = h.calls.length;
  await assert.rejects(h.client.request(h.protocol.Type.FAVORITES_TOGGLE_SIDEBAR, {}, null), error => {
    assert.equal(error.code, "CONTEXT_MISMATCH"); assert.equal(Object.hasOwn(error, "requestId"), false); return true;
  });
  assert.equal(h.calls.length, count);
});
