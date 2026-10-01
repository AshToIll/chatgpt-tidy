const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { installPageSession } = require("./helpers/page-session.cjs");

const root = path.resolve(__dirname, "..");
const source = name => fs.readFileSync(path.join(root, name), "utf8");

// Explicit catalog requests must bypass a warmed session cache after a
// same-document account switch, without reading any conversation history.
test("explicit search account resolution refreshes the real shared session helper after a same-document account switch", async () => {
  let current = "first";
  let sessionReads = 0;
  const context = vm.createContext({ console, Date, Math, Headers, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async (url) => {
      assert.equal(url, "/api/auth/session", "identity refresh does not read conversations");
      sessionReads += 1;
      return { ok: true, json: async () => ({ user: { id: current }, accessToken: `test-${current}` }) };
    },
  });
  installPageSession(context);
  for (const name of ["src/platform/catalog/date-search.js", "src/platform/chatgpt/api.js",
    "src/platform/chatgpt/messages.js", "src/platform/catalog/chatgpt/date-index.js"]) {
    vm.runInContext(source(name), context);
  }
  await context.TidyChatgptApi.loadSession();
  current = "second";
  assert.equal((await context.TidyChatgptApi.loadSession()).user.id, "first", "test actually warmed the original helper cache");
  assert.equal((await context.TidyChatgptDateIndex.account()).accountKey, "second");
  assert.equal(sessionReads, 2);
  assert.equal((await context.TidyChatgptMessages.account()).accountKey, "second");
  assert.equal(sessionReads, 2, "continuation identity checks reuse the refreshed session");
});
