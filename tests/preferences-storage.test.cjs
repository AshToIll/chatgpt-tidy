const assert = require("node:assert/strict");
const test = require("node:test");

// 真正异步调用 storage 回调，避免同步 mock 把异常交给 Promise 构造器而漏测挂起。
test("preference storage settles asynchronous callbacks and never overwrites a broken record", { timeout: 5000 }, async () => {
  const original = globalThis.chrome;
  let stored, readError = null;
  const writes = [];
  globalThis.chrome = {
    i18n: { getUILanguage: () => "ja" }, runtime: {},
    storage: { sync: {
      get(key, callback) { setImmediate(() => {
        globalThis.chrome.runtime.lastError = readError;
        try { callback({ [key]: stored }); }
        finally { delete globalThis.chrome.runtime.lastError; }
      }); },
      set(value, callback) { writes.push(value); stored = Object.values(value)[0]; setImmediate(callback); },
    } },
  };
  try {
    const { getPreferences, updatePreferences } = await import("../src/platform/preferences/preferences.js");
    assert.equal((await getPreferences()).language, "ja");
    assert.equal(writes.length, 0, "reading missing settings never writes defaults");
    for (const invalid of [null, [], "bad", 0, false]) {
      stored = invalid;
      await assert.rejects(getPreferences(), { code: "PREFERENCES_INVALID" });
      await assert.rejects(updatePreferences({ language: "en" }), { code: "PREFERENCES_INVALID" });
      assert.equal(writes.length, 0); assert.equal(stored, invalid);
    }
    stored = { language: "ja", dateFormat: "bad-enum" };
    assert.equal((await getPreferences()).dateFormat, "locale", "individual invalid fields still use normal defaults");
    readError = { message: "storage unavailable" };
    await assert.rejects(getPreferences(), /storage unavailable/);
    await assert.rejects(updatePreferences({ language: "en" }), /storage unavailable/);
    assert.equal(writes.length, 0);
    readError = null;
    const saved = await updatePreferences({ language: "en" });
    assert.equal(saved.language, "en"); assert.equal(writes.length, 1, "a failed read does not poison the shared write queue");
    // 即使字段解析本身抛错，也必须 reject，不得留下 pending Promise。
    stored = { get language() { throw new Error("decode failed"); } };
    await assert.rejects(getPreferences(), /decode failed/);
  } finally { globalThis.chrome = original; }
});
