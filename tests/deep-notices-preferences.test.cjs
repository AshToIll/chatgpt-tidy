const test = require("node:test");
const assert = require("node:assert/strict");
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function harness() {
  const { createPreferenceController } = await import("../src/platform/preferences/preference-controller.js");
  const { DEFAULT_PREFERENCES } = await import("../src/platform/preferences/preferences.js");
  let stored = { ...DEFAULT_PREFERENCES }, nextRead = null, notice = null;
  const loaded = [], failures = [], paints = [], writes = [];
  const controller = createPreferenceController({
    read: () => nextRead ? nextRead.promise : Promise.resolve({ ...stored }),
    write: patch => { const gate = defer(); writes.push({ patch, ...gate }); return gate.promise; },
    onChanged: value => paints.push(value),
    onError(error, action) { notice = { error, action }; failures.push(notice); },
    onLoaded() { notice = null; loaded.push(true); },
  });
  return { controller, loaded, failures, paints, writes, defaults: DEFAULT_PREFERENCES,
    get notice() { return notice; },
    readWith(gate) { nextRead = gate; },
    observe(patch = {}) { stored = { ...stored, ...patch }; controller.observe(stored); },
  };
}

async function failRead(h) {
  const gate = defer(); h.readWith(gate);
  const loading = h.controller.load();
  gate.reject(Object.assign(Error("Synthetic preference read failure"), { code: "STORAGE_ERROR" }));
  assert.equal(await loading, false); h.readWith(null);
}
async function failWrite(h) {
  const saving = h.controller.save({ theme: "sage" });
  h.writes.at(-1).reject(Object.assign(Error("Synthetic unknown write result"), { code: "ADAPTER_UNAVAILABLE" }));
  assert.equal(await saving, false);
  assert.equal(h.notice.action, "save");
}

test("authoritative unchanged preferences clear a read-failure notice without repainting", async () => {
  const h = await harness(); await failRead(h);
  assert.equal(h.notice.action, "read");
  h.observe();
  assert.equal(h.notice, null);
  assert.equal(h.loaded.length, 1);
  assert.equal(h.paints.length, 0);
  h.observe();
  assert.equal(h.loaded.length, 1, "duplicate storage events must not re-emit recovery");
});

test("authoritative observation recovers a failed read while an older retry is still pending", async () => {
  const h = await harness(); await failRead(h);
  const retry = defer(); h.readWith(retry);
  const loading = h.controller.load();
  h.observe({ theme: "amber" });
  assert.equal(h.notice, null);
  retry.resolve(h.defaults);
  assert.equal(await loading, true);
  assert.equal(h.controller.current().theme, "amber");
  assert.equal(h.notice, null);
  assert.equal(h.loaded.length, 1);
});

test("an unrelated authoritative observation does not erase an unknown write result", async () => {
  const h = await harness(); await failWrite(h);
  const original = h.notice, recovered = h.loaded.length;
  h.observe({ language: "ja" });
  assert.equal(h.controller.current().language, "ja");
  assert.equal(h.notice, original);
  assert.equal(h.loaded.length, recovered);
  assert.equal(await h.controller.load(), true, "an explicit successful read still reconciles settings");
  assert.equal(h.notice, null);
});

test("a failed retry cannot downgrade unknown write state into an observation-clearable read error", async () => {
  const h = await harness(); await failWrite(h);
  const original = h.notice;
  await failRead(h);
  assert.equal(h.notice, original, "keep the unresolved write outcome rather than replacing it with a weaker read failure");
  h.observe({ language: "ja" });
  assert.equal(h.notice, original);
});

test("disposed controller does not publish read recovery from storage events", async () => {
  const h = await harness(); await failRead(h);
  const original = h.notice;
  h.controller.dispose(); h.observe({ theme: "sage" });
  assert.equal(h.notice, original); assert.equal(h.loaded.length, 0);
});