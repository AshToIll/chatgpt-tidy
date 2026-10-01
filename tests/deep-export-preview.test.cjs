const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { loadExportModule } = require("./helpers/export-runtime.cjs");
function harness() {
  const presents = [], dismisses = [], errors = []; let serial = 0, focusCount = 0;
  const context = vm.createContext({ crypto: { randomUUID: () => "preview-" + ++serial } });
  const { createExportPreviewController } = loadExportModule(context, "src/features/export/ui/export-preview-controller.js");
  const body = {}, documentElement = {}, ownerDocument = { body, documentElement, activeElement: body };
  const opener = { isConnected: true, disabled: false, getClientRects: () => [1], focus: () => focusCount++ };
  const root = { ownerDocument, contains: value => value === opener };
  const controller = createExportPreviewController({ root, present: payload => new Promise((resolve, reject) => presents.push({ payload, resolve, reject })),
    dismiss: async payload => { dismisses.push(payload); }, onError: error => errors.push(error) });
  controller.updateOwner({ active: true, verified: true, accountKey: "a" });
  return { controller, presents, dismisses, errors, opener, ownerDocument, focused: () => focusCount };
}
const flush = () => new Promise(setImmediate);
test("preview uses one active lease; late presentation after close cleans up only that lease", async () => {
  const h = harness(), open = h.controller.open({ expectedAccountKey: "a", content: "text" }, h.opener);
  assert.equal(h.controller.isOpen(), true);
  assert.equal(await h.controller.open({ expectedAccountKey: "a" }, h.opener), false);
  h.controller.close(); h.presents[0].resolve(); await open; await flush();
  assert.equal(h.controller.isOpen(), false);
  assert.ok(h.dismisses.every(value => value.sessionId === "preview-1" && value.expectedAccountKey === "a"));
});
test("preview close callback cannot close a newer lease or steal focus", async () => {
  const h = harness(), first = h.controller.open({ expectedAccountKey: "a" }, h.opener);
  h.presents[0].resolve(); await first; h.controller.close();
  const second = h.controller.open({ expectedAccountKey: "a" }, h.opener);
  h.presents[1].resolve(); await second;
  h.controller.handleClosed("preview-1"); assert.equal(h.controller.isOpen(), true); assert.equal(h.focused(), 0);
  h.controller.handleClosed("preview-2"); assert.equal(h.controller.isOpen(), false); assert.equal(h.focused(), 1);
});
test("owner change retires old preview; its late failure cannot remove the new preview or display a stale error", async () => {
  const h = harness(), first = h.controller.open({ expectedAccountKey: "a" }, h.opener);
  h.controller.updateOwner({ accountKey: "b", active: true, verified: true });
  const second = h.controller.open({ expectedAccountKey: "b" }, h.opener);
  h.presents[0].reject(new Error("retired")); await first;
  assert.equal(h.controller.isOpen(), true); assert.equal(h.errors.length, 0);
  h.presents[1].resolve(); await second;
});
test("preview restore-focus respects current user focus and verified visibility", async () => {
  for (const boundary of ["focused elsewhere", "hidden", "unverified"]) {
    const h = harness(), open = h.controller.open({ expectedAccountKey: "a" }, h.opener);
    h.presents[0].resolve(); await open;
    if (boundary === "focused elsewhere") h.ownerDocument.activeElement = {};
    else h.controller.updateOwner({ accountKey: "a", active: boundary !== "hidden", verified: boundary !== "unverified" });
    h.controller.handleClosed("preview-1"); assert.equal(h.focused(), 0);
  }
});
test("current presentation failure clears its own lease and retains exact error for safe boundary classification", async () => {
  const h = harness(), error = new Error("private transport error");
  const open = h.controller.open({ expectedAccountKey: "a" }, h.opener);
  h.presents[0].reject(error); await open;
  assert.equal(h.controller.isOpen(), false); assert.equal(h.errors[0], error);
  h.controller.updateOwner({ accountKey: "a", active: true, verified: false });
  assert.equal(await h.controller.open({ expectedAccountKey: "a" }, h.opener), false);
});
