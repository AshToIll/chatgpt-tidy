const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");

// Exercise the production classifier without a browser or a user's catalog.
const context = vm.createContext({});
const source = fs.readFileSync("src/features/titles/ui/title-batch-view.js", "utf8")
  .replace(/^import[^\n]+\n/gm, "").replace(/^export /gm, "");
vm.runInContext(source, context);
const unsupported = (error, failed = false) => context.catalogUnsupported(failed ? error : { readErrors: [error] }, failed);

test("storage failures retain a read retry instead of pretending the format is unsupported", () => {
  const error = { code: "STORAGE_ERROR", name: "ConstraintError", stage: "final-checkpoint" };
  assert.equal(unsupported(error), false);
  assert.equal(context.catalogIssueFor({ readErrors: [error] }), "read");
});

test("nested transport details cannot hide the original account or bridge error code", () => {
  const auth = { code: "TITLE_AUTH_EXPIRED", details: { stage: "sidepanel.runtime-response" } };
  assert.equal(unsupported(auth, true), false);
  assert.equal(context.catalogIssueFor(auth, true), "account");
  assert.equal(context.catalogIssueFor({ code: "ADAPTER_UNAVAILABLE", details: { stage: "source-fetch" } }, true), "read");
  assert.equal(context.catalogIssueFor({ code: "RATE_LIMITED" }, true), "rate");
});

test("raw diagnostics are not assembled into the user interface", () => {
  assert.doesNotMatch(source, /catalog-diagnostics|diagnosticText|titlesBatchCatalogReason|titlesBatchExpectedTime/);
});

test("a superseded scan is informational only when the newer checkpoint has no real read error", () => {
  const value = { pauseReason: "catalog-superseded", phase: "paused", readErrors: [] };
  assert.equal(context.catalogIssueFor(value), "superseded");
  assert.equal(context.catalogIssueFor({ ...value, phase: "settled" }), "");
  assert.equal(context.catalogIssueFor({ ...value, readErrors: [{ code: "NETWORK" }] }), "read");
});

test("unsupported catalog shapes and versions do not invite ineffective retries", () => {
  for (const code of ["CATALOG_VERSION_UNSUPPORTED", "SCHEMA"]) {
    assert.equal(unsupported({ code }), true);
    assert.equal(unsupported({ details: { code } }, true), true);
  }
  assert.equal(unsupported({ code: "NETWORK" }), false);
});
