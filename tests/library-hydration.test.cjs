const fs = require("node:fs"), vm = require("node:vm"), test = require("node:test"), assert = require("node:assert/strict");
const context = vm.createContext({});
vm.runInContext(fs.readFileSync("src/platform/library/library-hydration.js", "utf8"), context);
const hydration = context.TidyLibraryHydration;

test("invalid side panel requires reopening; transient and real failures retain local retry", () => {
  const error = { code: "ADAPTER_UNAVAILABLE", details: { stage: "sidepanel.runtime-send-message", disconnect: "context-invalidated" } };
  assert.deepEqual(JSON.parse(JSON.stringify(hydration.errorPresentation(error))), { messageKey: "reopenTidyPanel", retryable: false });
  for (const other of [{ ...error, code: "CONTEXT_MISMATCH" },
    { ...error, details: { ...error.details, status: 401 } },
    { ...error, details: { ...error.details, disconnect: "connection-closed" } },
    { ...error, details: { ...error.details, disconnect: "receiver-missing" } },
    { ...error, details: { ...error.details, stage: "service-worker.library-account-response" } }, {}, null]) {
    assert.deepEqual(JSON.parse(JSON.stringify(hydration.errorPresentation(other))), { messageKey: "actionFailed", retryable: true });
  }
});

test("F5 is reserved for missing or invalidated page-side receivers, not an arbitrary adapter error", () => {
  for (const [stage, disconnect] of [["service-worker.snapshot-send-message", "receiver-missing"],
    ["service-worker.library-account-transport", "receiver-missing"], ["content.library-runtime-send-message", "context-invalidated"]]) {
    const error = { code: "ADAPTER_UNAVAILABLE", details: { stage, disconnect } };
    assert.deepEqual(JSON.parse(JSON.stringify(hydration.errorPresentation(error))), { messageKey: "refreshChatgptPage", retryable: false });
    for (const other of [{ ...error, code: "CONTEXT_MISMATCH" }, { ...error, details: { stage } },
      { ...error, details: { stage, disconnect: "connection-closed" } }, { ...error, details: { stage, disconnect, status: 403 } }]) {
      assert.equal(hydration.errorPresentation(other).retryable, true);
    }
  }
});

test("diagnostics are bounded, detached and contain no library data or arbitrary exception messages", () => {
  const diagnostic = hydration.createDiagnostic();
  for (let i = 0; i < 40; i++) diagnostic.record("failure", { code: "CONTEXT_MISMATCH", message: "private-text" },
    { accountKey: "private-owner", documentId: "doc", epoch: i, phase: "ready", token: "private-token" });
  const result = diagnostic.get(); assert.equal(result.length, 24); assert.equal(result[0].identity.epoch, 16);
  assert.equal(JSON.stringify(result).includes("private-"), false);
  result[0].identity.epoch = 999; assert.equal(diagnostic.get()[0].identity.epoch, 16);
});

test("production loaders install shared policy before both library consumers", () => {
  const manifest = JSON.parse(fs.readFileSync("src/manifest.json", "utf8"));
  const scripts = manifest.content_scripts.find(entry => entry.js.includes("platform/library/content/library-client.js")).js;
  const sharedPolicy = scripts.indexOf("platform/library/library-hydration.js");
  const contentConsumer = scripts.indexOf("platform/library/content/library-client.js");
  assert.ok(sharedPolicy >= 0 && contentConsumer > sharedPolicy,
    "the content runtime must install the shared policy before the library client");
  const html = fs.readFileSync("src/app/sidepanel/index.html", "utf8");
  const htmlScripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)].map(match => match[1]);
  const panelPolicy = htmlScripts.indexOf("../../platform/library/library-hydration.js");
  const panelConsumer = htmlScripts.indexOf("panel.js");
  assert.ok(panelPolicy >= 0 && panelConsumer > panelPolicy,
    "the sidepanel entry must install the shared policy before its module graph");
});

test("transport errors become one flat recovery DTO without account or arbitrary exception data", () => {
  const dto = hydration.normalizeError({ code: "ADAPTER_UNAVAILABLE", message: "private text", accountKey: "private account",
    details: { stage: "page-session", disconnect: "context-invalidated", status: null, retryable: false } });
  const expected = { code: "ADAPTER_UNAVAILABLE", stage: "page-session", disconnect: "context-invalidated", status: null, retryable: false };
  assert.deepEqual(JSON.parse(JSON.stringify(dto)), expected);
  assert.deepEqual(JSON.parse(JSON.stringify(hydration.normalizeError(dto))), expected,
    "a catalog DTO must keep the same meaning when presented");
  assert.deepEqual(JSON.parse(JSON.stringify(hydration.errorPresentation(dto, "searchDateReadFailed"))),
    { messageKey: "refreshChatgptPage", retryable: false });
});

test("explicitly non-retryable errors stay visible without a useless reread action", () => {
  for (const code of ["SCHEMA", "CATALOG_VERSION_UNSUPPORTED", "SEARCH_SCHEMA_CHANGED"]) {
    assert.deepEqual(JSON.parse(JSON.stringify(hydration.errorPresentation({ code, retryable: false }, "searchDateReadFailed"))),
      { messageKey: "searchDateReadFailed", retryable: false });
  }
  assert.deepEqual(JSON.parse(JSON.stringify(hydration.errorPresentation({ code: "HTTP", details: { status: 503, retryable: true } }, "searchDateReadFailed"))),
    { messageKey: "searchDateReadFailed", retryable: true });
  assert.deepEqual(JSON.parse(JSON.stringify(hydration.errorPresentation({ code: "UNKNOWN" }, "searchDateReadFailed"))),
    { messageKey: "searchDateReadFailed", retryable: true }, "unknown real failures are neither hidden nor labelled non-retryable");
  assert.equal(hydration.normalizeError({ code: "UNKNOWN" }).retryable, null);
});


test("flat error normalization preserves only a known request ID without changing recovery decisions", () => {
  const original = { code: "ADAPTER_UNAVAILABLE", details: { stage: "page-session", disconnect: "context-invalidated", retryable: false } };
  const baseline = JSON.parse(JSON.stringify(hydration.normalizeError(original)));
  const withId = { ...original, requestId: "request-known-123" };
  const dto = JSON.parse(JSON.stringify(hydration.normalizeError(withId)));
  assert.deepEqual(dto, { ...baseline, requestId: withId.requestId });
  assert.deepEqual(JSON.parse(JSON.stringify(hydration.normalizeError(dto))), dto);
  assert.deepEqual(JSON.parse(JSON.stringify(hydration.errorPresentation(withId))),
    JSON.parse(JSON.stringify(hydration.errorPresentation(original))));
  for (const requestId of [undefined, null, "", 123, false]) {
    const unknown = hydration.normalizeError({ ...original, requestId });
    assert.equal(Object.hasOwn(unknown, "requestId"), false);
    assert.deepEqual(JSON.parse(JSON.stringify(unknown)), baseline);
  }
});
