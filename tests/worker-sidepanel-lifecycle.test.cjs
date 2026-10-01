const assert = require("node:assert/strict");
const vm = require("node:vm");
const test = require("node:test");
const { createWorkerModuleLoader } = require("./helpers/worker-runtime.cjs");
const flush = () => new Promise(setImmediate);

function harness({ fail = "", message = "Permission denied" } = {}) {
  const errors = [], calls = [];
  const event = () => ({ addListener(fn) { this.run = fn; } });
  const action = (name, result) => async (...args) => {
    calls.push({ name, args });
    if (name === fail) throw new Error(message);
    return result;
  };
  const chrome = {
    runtime: { getURL: file => `chrome-extension://lifecycle-test/${file}`,
      onInstalled: event(), onStartup: event(), onMessage: event(), onConnect: event(), sendMessage: action("context") },
    sidePanel: { setOptions: action("options"), setPanelBehavior: action("behavior") },
    tabs: { onUpdated: event(), onActivated: event(), onRemoved: event(), get: action("get", { id: 7, url: "https://chatgpt.com/c/one" }),
      query: action("query", [{ id: 7, url: "https://chatgpt.com/c/one" }]) },
    storage: { onChanged: event() },
    webNavigation: { onHistoryStateUpdated: event(), onCommitted: event(), getFrame: action("frame", { documentId: "current-document", documentLifecycle: "active", url: "https://chatgpt.com/c/one" }) },
  };
  const context = vm.createContext({ chrome, URL, setTimeout, clearTimeout,
    AbortController, AbortSignal, structuredClone,
    console: { error: (...args) => errors.push(args) },
  });
  // Load the complete composition root so these assertions verify its actual
  // synchronous browser registrations and the real panel-host/lifecycle graph.
  // Toolbar painting and diagnostic persistence are separate host boundaries;
  // neither should add side effects to the panel configuration fixture.
  createWorkerModuleLoader(context, { imports: {
    createToolbarTheme: () => ({ start: async () => {} }),
    createDiagnosticsService: () => ({ matches: () => false }),
  } }).load("src/app/background/service-worker.js");
  return { chrome, errors, calls };
}

test("startup and install share setup and update preserves the exact tab-bound panel path", async () => {
  const h = harness();
  assert.equal(h.chrome.runtime.onInstalled.run, h.chrome.runtime.onStartup.run);
  await h.chrome.runtime.onStartup.run();
  await h.chrome.tabs.onUpdated.run(7, { status: "complete" }, { url: "https://chatgpt.com/c/one" });
  await h.chrome.tabs.onUpdated.run(7, { url: "https://example.com/" }, {});
  const options = h.calls.filter((call) => call.name === "options").map((call) => call.args[0]);
  assert.equal(options.length, 3);
  assert.ok(options.every((option) => option.tabId === 7 && option.path === "app/sidepanel/index.html?tidyTabId=7"));
  assert.deepEqual(options.map((option) => option.enabled), [true, true, false]);
  assert.equal(h.errors.length, 0);
});

for (const event of ["updated", "activated", "startup"]) {
  for (const gone of [false, true]) {
    test(`${event}: ${gone ? "exact tab disappearance is expected" : "configuration failure is reported without retry or rejection"}`, async () => {
      const h = harness({ fail: "options", message: gone ? "No tab with id: 7." : "Permission denied" });
      if (event === "startup") await h.chrome.runtime.onStartup.run();
      if (event === "updated") await h.chrome.tabs.onUpdated.run(7, { status: "complete" }, { url: "https://chatgpt.com/c/one" });
      if (event === "activated") await h.chrome.tabs.onActivated.run({ tabId: 7 });
      assert.equal(h.errors.length, gone ? 0 : 1);
      assert.equal(h.calls.filter((call) => call.name === "options").length, 1);
    });
  }
}

test("startup host failures and initial behavior failure are reported", async () => {
  for (const fail of ["behavior", "query"]) {
    const h = harness({ fail });
    await flush();
    assert.equal(h.errors.length, fail === "behavior" ? 1 : 0);
    await h.chrome.runtime.onStartup.run();
    assert.equal(h.errors.at(-1)[1].operation, "initialize");
    assert.equal(h.calls.filter((call) => call.name === "options").length, 0);
  }
});

test("a different tab's error is not hidden by the disappearance classification", async () => {
  const h = harness({ fail: "get", message: "No tab with id: 8." });
  await h.chrome.tabs.onActivated.run({ tabId: 7 });
  assert.equal(h.errors.length, 1);
});

test('browser load completion wakes page admission even when an initially loading page has no content script', async () => {
  const h = harness();
  await h.chrome.tabs.onUpdated.run(7, { status: 'loading' }, { url: 'https://chatgpt.com/c/one' });
  assert.equal(h.calls.filter(call => call.name === 'context').length, 0);
  await h.chrome.tabs.onUpdated.run(7, { status: 'complete' }, { url: 'https://chatgpt.com/c/one' });
  const signals = h.calls.filter(call => call.name === 'context');
  assert.equal(signals.length, 1);
  assert.equal(signals[0].args[0].type, 'context.changed');
  assert.equal(signals[0].args[0].payload.reason, 'document-load-complete');
  assert.equal(signals[0].args[0].payload.documentId, 'current-document');
});
