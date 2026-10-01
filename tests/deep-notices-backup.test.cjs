const test = require("node:test"), assert = require("node:assert/strict");

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const preview = { id: "preview-1", summary: { favorites: { added: 1, skipped: 0 }, bookmarks: { added: 1, skipped: 0 } } };
const file = { name: "private-backup.json", size: 2, text: async () => "{}" };

// Real handlers, synthetic owners and deferred receipts: no browser or saved user data.
async function harness({ restore = () => Promise.resolve({}), request: suppliedRequest } = {}) {
  const { createLibraryBackupView } = await import("../src/features/settings/ui/library-backup-view.js");
  const nodes = new Map(), calls = [], toasts = [], accepted = [];
  let owner = { accountKey: "account-a", generation: 1 }, checks = 0;
  const el = name => {
    if (!nodes.has(name)) nodes.set(name, { hidden: false, disabled: false, textContent: "", value: "", listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute() {}, focus() {}, click() {} });
    return nodes.get(name);
  };
  const root = { innerHTML: "", querySelector: selector => el(selector.match(/data-backup-([^\]]+)/)[1]), querySelectorAll: () => [] };
  const view = createLibraryBackupView({
    root, captureOwner: () => owner, isCurrent: value => value === owner,
    translate: key => key, onRestored: (...args) => accepted.push(args), toast: (...args) => toasts.push(args),
    request: async (action, payload, token) => {
      calls.push({ action, payload, token });
      if (suppliedRequest) return suppliedRequest(action, payload, token);
      if (action === "preview") return preview;
      if (action === "restore") return restore(token);
      return {};
    },
    checkLibrary: () => { checks++; view.setActive(false); },
    download: async () => true,
  });
  view.setActive(true);
  const click = name => el(name).listeners.click();
  return { view, el, calls, toasts, accepted, click,
    get checks() { return checks; },
    get owner() { return owner; },
    account(accountKey, generation = owner.generation + 1) { owner = { accountKey, generation }; view.update(); },
    async select() { await click("choose"); el("file").files = [file]; await el("file").listeners.change(); },
    async start() { await this.select(); return { pending: click("confirm") }; },
  };
}

test("pending restore survives leaving and returning without discarding or resubmitting", async () => {
  const receipt = deferred(), h = await harness({ restore: () => receipt.promise });
  const { pending } = await h.start();
  h.view.setActive(false); h.view.setActive(true);
  assert.equal(h.el("status").textContent, "backupRestoring");
  assert.equal(h.el("choose").disabled, true);
  assert.deepEqual(h.calls.map(value => value.action), ["preview", "restore"]);
  await h.click("confirm");
  assert.equal(h.calls.filter(value => value.action === "restore").length, 1);
  receipt.resolve({}); await pending;
});

test("unknown receipt while hidden remains a locked inspectable operation on return", async () => {
  const receipt = deferred(), h = await harness({ restore: () => receipt.promise });
  const { pending } = await h.start();
  h.view.setActive(false);
  receipt.reject(Object.assign(Error("private response text"), { code: "TRANSPORT_ERROR" }));
  await pending; h.view.setActive(true);
  assert.equal(h.el("status").textContent, "backupRestoreFailed");
  assert.equal(h.el("retry").hidden, false);
  assert.equal(h.el("retry").textContent, "backupCheckLibrary");
  assert.equal(h.el("choose").disabled, true);
  await h.click("retry");
  assert.equal(h.checks, 1);
  h.view.setActive(true);
  assert.equal(h.el("status").textContent, "backupRestoreFailed");
  assert.equal(h.el("choose").disabled, true);
  assert.deepEqual(h.calls.map(value => value.action), ["preview", "restore"]);
});

test("hidden success settles the submitted operation and is visible when settings returns", async () => {
  const receipt = deferred(), h = await harness({ restore: () => receipt.promise });
  const { pending } = await h.start(); h.view.setActive(false);
  receipt.resolve({ favorites: {}, bookmarks: {} }); await pending;
  assert.equal(h.accepted.length, 1);
  assert.equal(h.toasts.length, 0, "hidden success does not create an unrelated route toast");
  h.view.setActive(true);
  assert.equal(h.el("status").textContent, "backupRestored");
  assert.equal(h.el("choose").disabled, false);
  assert.deepEqual(h.calls.map(value => value.action), ["preview", "restore"]);
});

test("late old-account receipt stays private and returns only with its account", async () => {
  const receipt = deferred(), h = await harness({ restore: () => receipt.promise });
  const { pending } = await h.start(); h.account("account-b");
  assert.equal(h.el("status").hidden, true);
  assert.equal(h.el("choose").disabled, false);
  receipt.reject(Error("lost old account receipt")); await pending;
  assert.equal(h.el("status").hidden, true);
  assert.deepEqual(h.toasts, []); assert.deepEqual(h.accepted, []);
  h.account("account-a");
  assert.equal(h.el("status").textContent, "backupRestoreFailed");
  assert.equal(h.el("choose").disabled, true);
  assert.equal(h.el("retry").hidden, false);
});

test("same-account generation change preserves outcome but never applies stale models", async () => {
  const receipt = deferred(), h = await harness({ restore: () => receipt.promise });
  const { pending } = await h.start(); h.account("account-a");
  receipt.resolve({ favorites: {}, bookmarks: {} }); await pending;
  assert.deepEqual(h.accepted, [], "model adoption still requires the exact identity generation");
  assert.equal(h.el("status").textContent, "backupRestored");
  assert.equal(h.el("choose").disabled, false);
});

test("old-account completion cannot replace a newer account operation", async () => {
  const a = deferred(), b = deferred();
  const h = await harness({ restore: token => token.accountKey === "account-a" ? a.promise : b.promise });
  const { pending: first } = await h.start(); h.account("account-b");
  const { pending: second } = await h.start();
  a.reject(Error("old account failed")); await first;
  assert.equal(h.el("status").textContent, "backupRestoring");
  assert.equal(h.el("choose").disabled, true);
  b.resolve({}); await second;
  assert.deepEqual(h.toasts, [["backupRestored"]]);
  h.account("account-a");
  assert.equal(h.el("status").textContent, "backupRestoreFailed");
});

test("ordinary unsubmitted preview still disappears and is discarded when settings leaves", async () => {
  const h = await harness(); await h.select();
  assert.equal(h.el("preview").hidden, false);
  h.view.setActive(false); h.view.setActive(true);
  assert.equal(h.el("preview").hidden, true);
  assert.equal(h.el("status").hidden, true);
  assert.deepEqual(h.calls.map(value => value.action), ["preview", "discard"]);
});

test("known pre-write rejection releases import, but identity mismatch remains uncertain", async () => {
  for (const [code, key, locked] of [
    ["BACKUP_EXPIRED", "backupExpired", false],
    ["BACKUP_CHANGED", "backupChanged", false],
    ["CONTEXT_MISMATCH", "backupRestoreFailed", true],
  ]) {
    const h = await harness({ restore: async () => { throw Object.assign(Error("private"), { code }); } });
    const { pending } = await h.start(); await pending;
    assert.equal(h.el("status").textContent, key, code);
    assert.equal(h.el("choose").disabled, locked, code);
  }
});


test("explicit user acknowledgement unlocks import without asserting success or replaying a write", async () => {
  const h = await harness({ restore: async () => { throw Error("lost response"); } });
  const { pending } = await h.start(); await pending;
  assert.equal(h.el("checked").hidden, false);
  assert.equal(h.el("recovery").hidden, false);
  await h.click("choose");
  assert.deepEqual(h.calls.map(value => value.action), ["preview", "restore"], "locked import never starts a second preview");
  await h.click("checked");
  assert.equal(h.el("checked").hidden, true); assert.equal(h.el("status").hidden, true);
  assert.equal(h.el("choose").disabled, false);
  assert.deepEqual(h.toasts, []); assert.deepEqual(h.accepted, []);
  assert.deepEqual(h.calls.map(value => value.action), ["preview", "restore"]);
});

test("safe export cannot erase an unresolved restore or its inspect action", async () => {
  const exported = deferred();
  const h = await harness({ request: action => {
    if (action === "preview") return preview;
    if (action === "restore") return Promise.reject(Error("lost response"));
    if (action === "export") return exported.promise;
    return {};
  } });
  const { pending } = await h.start(); await pending;
  const reading = h.click("export");
  assert.equal(h.el("status").textContent, "backupRestoreFailed");
  assert.equal(h.el("retry").hidden, false);
  assert.equal(h.el("choose").disabled, true);
  assert.equal(h.el("checked").disabled, true);
  exported.resolve({}); await reading;
  h.view.update();
  assert.equal(h.el("status").textContent, "backupRestoreFailed");
  assert.equal(h.el("choose").disabled, true);
  assert.equal(h.el("checked").disabled, false);
  assert.equal(h.calls.filter(value => value.action === "restore").length, 1);
});

test("a different account cannot acknowledge the hidden account's unknown restore", async () => {
  const h = await harness({ restore: async () => { throw Error("lost response"); } });
  const { pending } = await h.start(); await pending;
  h.account("account-b");
  assert.equal(h.el("checked").hidden, true);
  await h.click("checked");
  h.account("account-a");
  assert.equal(h.el("status").textContent, "backupRestoreFailed");
  assert.equal(h.el("choose").disabled, true);
});

test("disposed view does not accept or announce a late restore receipt", async () => {
  const receipt = deferred(), h = await harness({ restore: () => receipt.promise });
  const { pending } = await h.start(); h.view.dispose();
  receipt.resolve({}); await pending;
  assert.deepEqual(h.accepted, []); assert.deepEqual(h.toasts, []);
  assert.deepEqual(h.calls.map(value => value.action), ["preview", "restore"]);
});


test("dispose revokes every interactive entry point, even if stale DOM events arrive", async () => {
  const h = await harness(); h.view.dispose();
  await h.click("export"); await h.click("choose"); await h.click("confirm");
  h.el("file").files = [file]; await h.el("file").listeners.change();
  h.view.setActive(true);
  await h.click("export");
  assert.deepEqual(h.calls, [], "disposed controls cannot send new library requests");
  for (const name of ["export", "choose", "confirm", "cancel", "retry", "checked", "file"]) {
    assert.equal(h.el(name).disabled, true, name);
  }
});


test("unknown restore diagnostics survive repaint, safe export and account hiding", async t => {
  const prior = globalThis.ChatGPTTidyDiagnostics, notices = [];
  const requestId = "req-00000000-0000-4000-8000-000000000001";
  globalThis.ChatGPTTidyDiagnostics = {
    cause: error => error ? { reasonCode: error.code, requestId: error.requestId } : {},
    notice: value => notices.push(value),
  };
  t.after(() => { if (prior) globalThis.ChatGPTTidyDiagnostics = prior; else delete globalThis.ChatGPTTidyDiagnostics; });
  const h = await harness({ restore: async () => {
    throw Object.assign(Error("private free-form detail"), { code: "CONTEXT_MISMATCH", requestId });
  } });
  const { pending } = await h.start(); await pending;
  h.view.update(); h.view.setActive(false); h.view.setActive(true);
  await h.click("export");
  h.account("account-b"); h.account("account-a");
  const shown = notices.filter(value => value.event === "show" && value.messageKey === "backupRestoreFailed");
  assert.ok(shown.length >= 4);
  for (const value of shown) {
    assert.equal(value.reasonCode, "CONTEXT_MISMATCH");
    assert.equal(value.requestId, requestId);
  }
  assert.ok(!JSON.stringify(notices).includes("private free-form detail"));
  assert.equal(h.el("choose").disabled, true);
});
