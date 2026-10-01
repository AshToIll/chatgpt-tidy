const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const context = vm.createContext({});
vm.runInContext(fs.readFileSync("src/platform/protocol.js", "utf8"), context);
const protocol = context.TidyProtocol;

test("runtime disconnect classification is narrow and does not mistake backend faults for reconnects", () => {
  for (const [message, reason] of [
    ["Extension context invalidated.", "context-invalidated"],
    ["Could not establish connection. Receiving end does not exist.", "receiver-missing"],
    ["The message port closed before a response was received.", "connection-closed"],
    ["A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received.", "connection-closed"],
  ]) assert.equal(protocol.runtimeDisconnectReason(Error(message)), reason);
  for (const message of ["Failed to fetch", "401 Unauthorized", "429 Too Many Requests", "Network timeout",
    "No tab with id: 31", "The library identity changed", "Server says Extension context invalidated.", ""]) {
    assert.equal(protocol.runtimeDisconnectReason(Error(message)), null, message);
  }
});

test("real panel transport preserves reconnect diagnostics without reclassifying normal failed replies", async () => {
  let result = Error("Extension context invalidated.");
  // This test isolates protocol error translation on an already admitted page.
  const { createPanelRequestClient } = await import("../src/app/sidepanel/request-client.js");
  const client = createPanelRequestClient({ protocol, run: (_type, request) => request(),
    runtime: { sendMessage: async envelope => {
    if (result instanceof Error) throw result;
    return protocol.failure(envelope, "LIBRARY_ACCOUNT_UNAVAILABLE", "Auth failed", { status: 401 });
  } } });
  await assert.rejects(client.send("library.get"), error => error.code === "ADAPTER_UNAVAILABLE"
    && error.details.stage === "sidepanel.runtime-send-message" && error.details.disconnect === "context-invalidated");
  result = null;
  await assert.rejects(client.send("library.get"), error => error.code === "LIBRARY_ACCOUNT_UNAVAILABLE"
    && error.details.status === 401 && !error.details.disconnect);
});
