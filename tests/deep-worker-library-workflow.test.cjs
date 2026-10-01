const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { createWorkerModuleLoader } = require("./helpers/worker-runtime.cjs");

function harness({ requestId, failed = "favorites", stale = false } = {}) {
  const calls = [], owner = { accountKey: "account", tab: { id: 4 }, identity: { documentId: "doc", epoch: 2 } };
  const states = { favorites: { accountKey: "account", revision: 1, items: {} }, bookmarks: { accountKey: "account", revision: 2, items: {} } };
  const repository = kind => ({ get: async () => {
    calls.push(kind);
    if (kind === failed) throw Object.assign(new Error("private implementation detail"), { tidyCode: "STORAGE_ERROR" });
    return states[kind];
  } });
  const context = vm.createContext({ URL, console, setTimeout, clearTimeout });
  const loader = createWorkerModuleLoader(context, { imports: {
    favoritesRepository: repository("favorites"), bookmarksRepository: repository("bookmarks"),
  } });
  const { createLibraryWorkflow } = loader.load("src/app/background/library-workflow.js");
  const workflow = createLibraryWorkflow({
    chrome: { runtime: { sendMessage: async () => { calls.push("broadcast"); } } },
    identity: { assertCurrent: () => { if (stale) throw Object.assign(new Error("changed"), { tidyCode: "CONTEXT_MISMATCH" }); } },
    pageGateway: { snapshot: async () => { calls.push("snapshot"); throw Object.assign(new Error("no DOM"), { tidyCode: "ADAPTER_UNAVAILABLE" }); },
      broadcast: async () => { calls.push("page broadcast"); } },
  });
  return { load: () => workflow.load(owner, requestId), calls, owner, states };
}

test("partial library storage failure retains the known outer request ID for safe notice attribution", async () => {
  const h = harness({ requestId: "request-known" });
  const result = await h.load();
  assert.equal(result.errors.favorites.requestId, "request-known");
  assert.equal(result.errors.favorites.code, "STORAGE_ERROR");
  assert.equal(result.errors.favorites.details.stage, "service-worker.library-storage");
  assert.equal(result.errors.favorites.message, "This local library is unavailable.");
  assert.equal(result.favorites, null);
  assert.equal(result.bookmarks, h.states.bookmarks);
  assert.equal(result.errors.bookmarks, null);
  assert.deepEqual(h.calls, ["snapshot", "favorites", "bookmarks"]);
});

test("library workflow never invents a request ID when called without an envelope", async () => {
  const result = await harness().load();
  assert.equal(Object.hasOwn(result.errors.favorites, "requestId"), false);
});

test("one unavailable library never hides the other valid account library", async () => {
  const h = harness({ failed: "bookmarks", requestId: "request-bookmark" });
  const result = await h.load();
  assert.equal(result.favorites, h.states.favorites);
  assert.equal(result.errors.favorites, null);
  assert.equal(result.bookmarks, null);
  assert.equal(result.errors.bookmarks.requestId, "request-bookmark");
});

test("stale identity before snapshot stops all repository work", async () => {
  const h = harness({ stale: true });
  await assert.rejects(h.load(), { tidyCode: "CONTEXT_MISMATCH" });
  assert.deepEqual(h.calls, []);
});
