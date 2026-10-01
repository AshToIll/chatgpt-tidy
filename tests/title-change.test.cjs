const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { installPageSession } = require("./helpers/page-session.cjs");
const test = require("node:test");
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");
const plain = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
const renameUrl = id => `/backend-api/conversation/id/${id}/rename`;

async function page() {
  const changes = [], calls = [], events = new Map(); let clock = 1000;
  let session = { user: { id: "user-a" }, activeAccountId: "catalog-a", accessToken: "never-publish-this" };
  let response = () => Promise.resolve(new Response("{}", { status: 200 }));
  const context = vm.createContext({ URL, Request, Response, Headers,
    document: { cookie: "" }, location: new URL("https://chatgpt.com/c/open-chat"),
    performance: { timeOrigin: 100000, now: () => ++clock },
    addEventListener: (type, fn) => events.set(type, fn),
    fetch(...args) {
      calls.push(args);
      if (args[0] === "/api/auth/session") return Promise.resolve(new Response(JSON.stringify(session)));
      return response(...args);
    },
  });
  installPageSession(context);
  vm.runInContext(fs.readFileSync("src/platform/chatgpt/api.js", "utf8"), context);
  const api = context.TidyChatgptApi;
  api.onTitleChanged(value => changes.push(plain(value)));
  await api.readLibraryAccount(); await settle();
  return { api, context, changes, calls, events,
    setResponse: fn => { response = fn; }, switchUser: async () => {
      session = { ...session, user: { id: "user-b" }, activeAccountId: "catalog-b" };
      await api.loadSession({ refresh: true }); await settle();
    },
    rename: (id = "off-current", title = "Native title") => context.fetch(renameUrl(id), { method: "POST", body: JSON.stringify({ title }) }),
  };
}

test("native rename observes the exact off-current ID and title only after success without changing fetch or making requests", async () => {
  const h = await page(); let resolve;
  const pending = new Promise(done => { resolve = done; });
  const response = new Response("private response body");
  h.setResponse(() => pending);
  const request = h.rename(); assert.equal(request, pending, "return the site's original Promise");
  assert.equal(h.changes.length, 0);
  resolve(response); assert.equal(await request, response); await settle();
  assert.equal(h.changes.length, 1);
  assert.deepEqual(h.changes[0], { ownerAccountKey: '["user-a","personal"]', epoch: 1,
    catalogAccountKey: "catalog-a", conversationId: "off-current", title: "Native title", startedAt: 101001 });
  assert.equal(h.calls.length, 2, "initial session and native rename only");
  assert.equal(await response.text(), "private response body", "observer never consumes the response body");
  assert.doesNotMatch(JSON.stringify(h.changes), /never-publish|private response/);
});

test("Request bodies and URL objects are supported without consuming the original request", async () => {
  const h = await page();
  const request = new Request("https://chatgpt.com" + renameUrl("request-id"), { method: "POST", body: '{"title":"Request title"}' });
  await h.context.fetch(request); await settle();
  assert.equal(h.changes[0].conversationId, "request-id"); assert.equal(request.bodyUsed, false);
  await h.context.fetch(new URL("https://chatgpt.com" + renameUrl("url-id")), { method: "POST", body: '{"title":"URL title"}' });
  await settle(); assert.equal(h.changes[1].conversationId, "url-id");
});

test("failed, rejected, malformed, unrelated and TIDY-owned requests never publish external changes", async () => {
  const h = await page();
  for (const status of [400, 401, 403, 429, 500]) {
    h.setResponse(() => Promise.resolve(new Response("{}", { status }))); await h.rename(); await settle();
  }
  const failure = new Error("native network failure");
  h.setResponse(() => Promise.reject(failure)); await assert.rejects(h.rename(), error => error === failure);
  h.setResponse(() => { throw failure; }); assert.throws(() => h.rename(), error => error === failure);
  h.setResponse(() => Promise.resolve(new Response("{}")));
  for (const url of ["https://example.com" + renameUrl("x"), renameUrl("x") + "?ignored=1", "/backend-api/conversation/x", renameUrl("x/y")]) {
    await h.context.fetch(url, { method: "POST", body: '{"title":"No"}' });
  }
  for (const body of ["not-json", "null", '{"title":123}', '{"title":""}', JSON.stringify({ title: "x".repeat(5000) })]) {
    await h.context.fetch(renameUrl("x"), { method: "POST", body });
  }
  await h.context.fetch(renameUrl("x"), { method: "GET" });
  await h.api.fetchTitleRequest(renameUrl("x"), { method: "POST", body: '{"title":"TIDY write"}' });
  await settle(); assert.deepEqual(h.changes, []);
});

test("newer renames supersede late replies independently by ID; failed newer requests never revive old events", async () => {
  const h = await page(), pending = [];
  h.setResponse(() => new Promise(resolve => pending.push(resolve)));
  const old = h.rename("a", "old"), other = h.rename("b", "independent"), latest = h.rename("a", "latest");
  pending[2](new Response("{}")); await latest; await settle();
  pending[0](new Response("{}")); pending[1](new Response("{}")); await Promise.all([old, other]); await settle();
  assert.deepEqual(h.changes.map(x => [x.conversationId, x.title]), [["a", "latest"], ["b", "independent"]]);
  const before = h.changes.length, a = h.rename("c", "old"), b = h.rename("c", "failed");
  pending[4](new Response("{}", { status: 500 })); await b; await settle();
  pending[3](new Response("{}")); await a; await settle(); assert.equal(h.changes.length, before);
});

for (const boundary of ["user", "workspace", "pagehide"]) test(`late rename cannot cross ${boundary} boundary`, async () => {
  const h = await page(); let resolve;
  h.setResponse(() => new Promise(done => { resolve = done; })); const pending = h.rename();
  if (boundary === "user") await h.switchUser();
  else if (boundary === "workspace") { h.context.document.cookie = "_account=team"; h.api.checkLibraryIdentity(); }
  else h.events.get("pagehide")();
  resolve(new Response("{}")); await pending; await settle(); assert.deepEqual(h.changes, []);
});

async function repository(t) {
  globalThis.IDBKeyRange = IDBKeyRange;
  const { openTidyDatabase } = await import("../src/platform/storage/database.js");
  const { createConversationCatalogRepository } = await import("../src/platform/catalog/storage/conversation-catalog.js");
  const db = await openTidyDatabase(new IDBFactory()); t.after(() => db.close());
  let clock = 100;
  const repo = createConversationCatalogRepository({ openDatabase: async () => db, now: () => clock });
  const state = { catalogVersion: 2, generation: 1, revision: 1, snapshotStartedAt: 1 };
  const row = (id, title = "Before", updatedAt = null) => ({ conversationId: id, title, updatedAt, projectId: "g-p-example", directoryBounds: { createdAt: 10 } });
  await repo.commitPage("catalog-a", { conversations: [row("one"), row("two")] }, state);
  await repo.commitPage("catalog-b", { conversations: [row("one", "Other account")] }, state);
  return { repo, db, state, row, tick: value => { clock = value; } };
}

test("one native rename updates one existing catalog row, preserves metadata, and fences duplicates and stale scans", async t => {
  const h = await repository(t), { repo } = h;
  const before = await repo.getSnapshot("catalog-a"), other = await repo.getSnapshot("catalog-b");
  assert.equal(await repo.acceptTitleChange("catalog-a", { conversationId: "one", title: "Native", startedAt: 90 }), true);
  assert.equal(await repo.acceptTitleChange("catalog-a", { conversationId: "one", title: "Late", startedAt: 80 }), false);
  assert.equal(await repo.acceptTitleChange("catalog-a", { conversationId: "one", title: "Duplicate", startedAt: 90 }), false);
  assert.equal(await repo.acceptTitleChange("catalog-a", { conversationId: "missing", title: "Don't invent", startedAt: 120 }), false);
  const changed = await repo.getRow("catalog-a", "one");
  assert.equal(changed.title, "Native"); assert.equal(changed.updatedAt, null); assert.equal(changed.projectId, "g-p-example");
  assert.deepEqual(await repo.getRow("catalog-a", "two"), before.rows[1]);
  assert.deepEqual((await repo.getSnapshot("catalog-a")).state, before.state);
  assert.deepEqual(await repo.getSnapshot("catalog-b"), other);
  await repo.commitPage("catalog-a", { conversations: [h.row("one", "Late old page", 1000)] }, { ...h.state, revision: 2 });
  assert.equal((await repo.getRow("catalog-a", "one")).title, "Native", "old scan cannot overwrite even null/different timestamps");
  await repo.commitPage("catalog-a", { conversations: [h.row("one", "New scan", 1001)] }, { ...h.state, generation: 2, snapshotStartedAt: 200 });
  assert.equal((await repo.getRow("catalog-a", "one")).title, "New scan");
  h.tick(300); await repo.acceptTitles("catalog-a", [{ conversationId: "one", title: "TIDY newer" }]);
  assert.equal(await repo.acceptTitleChange("catalog-a", { conversationId: "one", title: "Late native", startedAt: 250 }), false);
});

test("revoked identity and storage failures do not publish or corrupt the current title", async t => {
  const { repo, db } = await repository(t);
  assert.equal(await repo.acceptTitleChange("catalog-a", { conversationId: "one", title: "No", startedAt: 110 }, () => false), false);
  assert.equal((await repo.getRow("catalog-a", "one")).title, "Before");
  const original = db.transaction.bind(db);
  db.transaction = (...args) => {
    const tx = original(...args);
    if (args[1] === "readwrite") { const objectStore = tx.objectStore.bind(tx); tx.objectStore = name => {
      const store = objectStore(name); store.put = () => { throw new Error("injected write failure"); }; return store;
    }; }
    return tx;
  };
  await assert.rejects(repo.acceptTitleChange("catalog-a", { conversationId: "one", title: "No", startedAt: 120 }), { code: "STORAGE_ERROR" });
  db.transaction = original;
  assert.equal((await repo.getRow("catalog-a", "one")).title, "Before");
  assert.equal(await repo.acceptTitleChange("catalog-a", { conversationId: "one", title: "Recovered", startedAt: 130 }), true);
});

test("back-to-back native renames are ordered by request start, not delayed cache commit time", async t => {
  const { repo, tick } = await repository(t);
  tick(1000);
  assert.equal(await repo.acceptTitleChange("catalog-a", { conversationId: "one", title: "First", startedAt: 100 }), true);
  assert.equal(await repo.acceptTitleChange("catalog-a", { conversationId: "one", title: "Second", startedAt: 200 }), true);
  assert.equal((await repo.getRow("catalog-a", "one")).title, "Second");
  assert.equal(await repo.acceptTitleChange("catalog-a", { conversationId: "one", title: "Late", startedAt: 150 }), false);
  for (const change of [null, {}, { conversationId: "one", title: "", startedAt: 300 },
    { conversationId: "one", title: "Malformed", startedAt: -1 }]) {
    assert.equal(await repo.acceptTitleChange("catalog-a", change), false);
  }
});
