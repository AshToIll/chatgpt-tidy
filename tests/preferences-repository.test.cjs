const assert = require("node:assert/strict");
const test = require("node:test");

test("worker-wide preference queue merges concurrent panels, survives failures and skips no-op writes", async () => {
  const preferences = await import("../src/platform/preferences/preferences.js");
  const { PREFERENCES_KEY, DEFAULT_PREFERENCES, updatePreferences, getPreferences } = preferences;
  let stored = { ...DEFAULT_PREFERENCES };
  let writes = 0;
  let failNextWrite = false;
  let failNextRead = false;
  globalThis.chrome = { runtime: { lastError: null }, storage: { sync: {
    get(key, callback) {
      const snapshot = structuredClone(stored);
      setImmediate(() => {
        if (failNextRead) { failNextRead = false; chrome.runtime.lastError = { message: "read failed" }; }
        callback({ [key]: snapshot });
        chrome.runtime.lastError = null;
      });
    },
    set(patch, callback) {
      setImmediate(() => {
        writes += 1;
        if (failNextWrite) { failNextWrite = false; chrome.runtime.lastError = { message: "write failed" }; }
        else stored = structuredClone(patch[PREFERENCES_KEY]);
        callback();
        chrome.runtime.lastError = null;
      });
    },
  } } };
  await Promise.all([updatePreferences({ language: "en" }), updatePreferences({ theme: "sage" })]);
  assert.equal(stored.language, "en");
  assert.equal(stored.theme, "sage");
  const afterChanges = writes;
  await updatePreferences({ theme: "sage" });
  assert.equal(writes, afterChanges);
  failNextWrite = true;
  await assert.rejects(updatePreferences({ theme: "amber" }), /write failed/);
  await updatePreferences({ language: "ja" });
  assert.equal(stored.language, "ja");
  assert.equal(stored.theme, "sage");
  failNextRead = true;
  await assert.rejects(getPreferences(), /read failed/);
  delete globalThis.chrome;
});
