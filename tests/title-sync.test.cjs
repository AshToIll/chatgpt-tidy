const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const { installPageSession } = require("./helpers/page-session.cjs");

function harness({ withClient = true, matched = true, delayedCancel = false, url = "https://chatgpt.com/c/current", href = "/c/current", session = null } = {}) {
  const calls = [];
  const text = { nodeType: 3, textContent: "Original" };
  const data = { pages: [{ items: [{ id: "current", title: "Original", update_time: "2026-09-01T00:00:00.000Z", retained: true }, { id: "other", title: "Other" }], cursor: 7 }], pageParams: [0] };
  let completeCancel;
  const cancel = delayedCancel ? new Promise((resolve) => { completeCancel = resolve; }) : undefined;
  const client = {
    getQueryCache() {},
    cancelQueries(...args) { calls.push(["cancel", ...args]); return cancel; },
    setQueriesData(options, update) { calls.push(["patch", options]); client.data = update(client.data); },
    invalidateQueries(options) { calls.push(["invalidate", options]); return Promise.resolve(); },
    data,
  };
  const row = {
    label: "Original (unread)",
    childNodes: [{ nodeType: 1, matches: () => true, childNodes: [{ nodeType: 3, textContent: "Tidy-owned" }] }, text],
    getAttribute: (name) => name === "data-sidebar-item" ? "true" : name === "aria-label" ? row.label : href,
    setAttribute: (name, value) => { if (name === "aria-label") row.label = value; },
    closest: () => null,
    __reactFiber$test: { memoizedProps: { historyItem: { id: matched ? "current" : "wrong" } },
      return: withClient ? { memoizedProps: { client }, return: null } : null },
  };
  const listeners = new Map();
  const pageAttributes = new Map();
  const globals = { URL, document: { cookie: "", title: "Original", querySelector: () => null, querySelectorAll: () => [row],
    documentElement: {
      getAttribute: name => pageAttributes.get(name) || null,
      setAttribute: (name, value) => pageAttributes.set(name, value),
    },
  },
    location: { origin: "https://chatgpt.com", href: url },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  };
  if (session) globals.fetch = async () => {
    const body = await session();
    return { ok: true, status: 200, json: async () => body, clone: () => ({ json: async () => body }) };
  };
  const context = vm.createContext(globals);
  const pageSession = installPageSession(context);
  vm.runInContext(fs.readFileSync("src/platform/snapshot.js", "utf8"), context);
  vm.runInContext(fs.readFileSync("src/platform/chatgpt/api.js", "utf8"), context);
  // Track the actual API listener registrations so teardown has observable
  // ownership evidence rather than merely relying on guarded callbacks.
  const api = context.TidyChatgptApi;
  const subscriptions = { onLibraryIdentityChanged: 0, onTitleChanged: 0 };
  context.TidyChatgptApi = { ...api };
  for (const name of Object.keys(subscriptions)) {
    context.TidyChatgptApi[name] = (listener) => {
      const unsubscribe = api[name](listener);
      subscriptions[name]++;
      return () => { subscriptions[name]--; unsubscribe(); };
    };
  }
  vm.runInContext(fs.readFileSync("src/platform/chatgpt/route.js", "utf8"), context);
  vm.runInContext(fs.readFileSync("src/features/titles/chatgpt/title-sync.js", "utf8"), context);
  const current = { conversationId: "current", title: "2026/09/01 | Original", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z" };
  const native = { conversationId: "current", bindingStatus: "bound", title: { value: "Original" },
    createdAt: { value: "2026-09-01T00:00:00.000Z" }, updatedAt: { value: "2026-09-01T00:00:00.000Z" } };
  const sync = context.TidyChatgptTitleSync;
  const accept = (value = current, identity = { accountKey: "user", workspaceKey: "personal" }) => sync.accept(value, identity, text.textContent, native);
  return { sync, current, native, accept, text, row, client, data, calls, context, completeCancel, pageSession, subscriptions,
    emit(type) { for (const listener of listeners.get(type) || []) listener({ type }); },
    async observeSession() { await context.fetch("/api/auth/session"); for (let n = 0; n < 8; n++) await Promise.resolve(); },
  };
}

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test("named project title synchronization uses the canonical project cache without losing its owner path", async () => {
  const projectId = "g-p-0123456789abcdef0123456789abcdef";
  const pathname = `/g/${projectId}-my-project/c/current`;
  const h = harness({ url: `https://chatgpt.com${pathname}/`, href: pathname });
  assert.equal(h.sync.accept(h.current, { accountKey: "user", workspaceKey: "personal" }, "Original", h.native,
    { ownerContext: { conversationId: "current", projectId, pathname }, targetProjectId: projectId }), true);
  await settle();
  assert.equal(h.text.textContent, h.current.title);
  assert.equal(h.sync.project(h.native).title.value, h.current.title);
  assert.ok(h.calls.some(call => call[0] === "patch" && call[1].queryKey[0] === "snorlaxConversations"
    && call[1].queryKey[1].gizmoId === projectId));
  h.context.location.href = `https://chatgpt.com/g/g-p-abcdef0123456789abcdef0123456789-other/c/current`;
  h.sync.refresh();
  assert.equal(h.sync.project(h.native), h.native, "a real project move retires the old title projection");
});

test("a successful official rename retires TIDY's old projection and delayed native-cache callback", async () => {
  const h = harness({ delayedCancel: true, session: () => ({ user: { id: "user" }, accessToken: "fixture-token" }) });
  await h.context.TidyChatgptApi.readLibraryAccount();
  h.accept();
  assert.equal(h.sync.project(h.native).title.value, h.current.title);
  await h.context.fetch("/backend-api/conversation/id/current/rename", { method: "POST", body: JSON.stringify({ title: "Manual rename" }) });
  await settle(); await settle();
  h.text.textContent = "Manual rename"; h.context.document.title = "Manual rename";
  h.sync.refresh(); h.completeCancel(); await settle();
  assert.equal(h.text.textContent, "Manual rename");
  assert.equal(h.context.document.title, "Manual rename");
  assert.equal(h.sync.project(h.native), h.native);
  assert.deepEqual(h.calls.map(call => call[0]), ["cancel"]);
});

test("actual API same-workspace user changes revoke title projections and pending native cache writes", async () => {
  let user = "user-a";
  const h = harness({ delayedCancel: true, session: () => ({ user: { id: user }, accessToken: "fixture-token" }) });
  await h.context.TidyChatgptApi.readLibraryAccount();
  assert.equal(h.accept(h.current, { accountKey: user, workspaceKey: "personal" }), true);
  user = "user-b"; await h.observeSession();
  h.text.textContent = "Original"; h.context.document.title = "Original";
  h.sync.refresh();
  assert.equal(h.text.textContent, "Original");
  assert.equal(h.context.document.title, "Original");
  assert.equal(h.sync.project(h.native), h.native);
  h.completeCancel(); await settle();
  assert.deepEqual(h.calls.map(call => call[0]), ["cancel"]);
  assert.equal(h.accept(h.current, { accountKey: "user-a", workspaceKey: "personal" }), false,
    "a late old-account result cannot recreate the revoked record");
});

test("first and renewed same-owner API identities preserve an already verified title observation", async () => {
  const h = harness({ session: () => ({ user: { id: "user" }, accessToken: "fixture-token" }) });
  assert.equal(h.accept(), true);
  await h.context.TidyChatgptApi.readLibraryAccount(); await settle();
  assert.equal(h.sync.project(h.native).title.value, h.current.title);
  const calls = h.calls.length;
  await h.observeSession(); h.sync.refresh();
  assert.equal(h.sync.project(h.native).title.value, h.current.title);
  assert.equal(h.calls.length, calls, "same-owner observation neither re-patches nor re-fetches history");
});

test("page identity revocation discards delayed title callbacks and cannot be undone by late acceptance", async () => {
  const h = harness({ delayedCancel: true, session: () => ({ user: { id: "user" }, accessToken: "fixture-token" }) });
  await h.context.TidyChatgptApi.readLibraryAccount(); h.accept();
  h.emit("pagehide");
  assert.equal(h.sync.project(h.native), h.native);
  assert.equal(h.accept(), false);
  h.completeCancel(); await settle();
  assert.deepEqual(h.calls.map(call => call[0]), ["cancel"]);
  h.emit("pageshow");
  assert.equal(h.accept(), false, "BFCache has not obtained a new ready identity yet");
  await h.context.TidyChatgptApi.readLibraryAccount();
  assert.equal(h.accept(), true, "a newly verified same-account result may create a new observation");
});

test("accepted renames patch only title and invalidate the native directory without inventing readback dates", async () => {
  const h = harness(), identity = { accountKey: "user", workspaceKey: "personal" };
  assert.equal(h.sync.acceptTitle(h.current, identity, "Original", h.native), true);
  assert.equal(h.text.textContent, h.current.title); assert.equal(h.context.document.title, h.current.title);
  const projected = h.sync.project(h.native);
  assert.equal(projected.title.source, "chatgpt-api.title-accepted");
  assert.equal(projected.createdAt, h.native.createdAt); assert.equal(projected.updatedAt, h.native.updatedAt);
  await settle();
  assert.deepEqual(h.calls.map(call => call[0]), ["cancel", "patch", "patch", "invalidate"]);
  assert.equal(h.client.data.pages[0].items[0].title, h.current.title);
  assert.equal(h.client.data.pages[0].items[0].update_time, h.data.pages[0].items[0].update_time);
  assert.equal(Object.hasOwn(h.client.data.pages[0].items[0], "create_time"), false);
  assert.equal(h.client.data.pages[0].items[1], h.data.pages[0].items[1]);
  assert.equal(h.client.data.pageParams, h.data.pageParams);
});

test("accepted off-current project title targets its own directory and cannot alter the owner", async () => {
  const owner = { conversationId: "owner", pathname: "/g/g-p-owner/c/owner", projectId: "g-p-owner" };
  const h = harness({ url: `https://chatgpt.com${owner.pathname}`, href: "/g/g-p-target/c/current" });
  h.context.document.title = "Owner title";
  const ownerNative = { ...h.native, conversationId: "owner", title: { value: "Owner title" } };
  assert.equal(h.sync.acceptTitle(h.current, { accountKey: "user", workspaceKey: "personal" }, "Original", ownerNative,
    { ownerContext: owner, targetProjectId: "g-p-target" }), true);
  assert.equal(h.sync.project(ownerNative), ownerNative); assert.equal(h.context.document.title, "Owner title");
  assert.equal(h.text.textContent, h.current.title); await settle(); await settle();
  const projectCalls = h.calls.filter(([, options]) => options.queryKey[0] === "snorlaxConversations");
  assert.equal(projectCalls.length, 3);
  assert.equal(projectCalls.every(([, options]) => options.queryKey[1].gizmoId === "g-p-target"), true);
  assert.equal(h.client.data.pages[0].items[0].update_time, h.data.pages[0].items[0].update_time);
});

test("accepted titles never overwrite an already newer native title or a later rename back to the old title", async () => {
  for (const change of ["already-newer", "later-title", "later-original", "cache-title", "cache-original"]) {
    const h = harness({ delayedCancel: true }), identity = { accountKey: "user", workspaceKey: "personal" };
    if (change === "already-newer") {
      h.native.title.value = "External rename"; h.context.document.title = "External rename";
      assert.equal(h.sync.acceptTitle(h.current, identity, "Original", h.native), false);
      assert.equal(h.context.document.title, "External rename"); assert.equal(h.calls.length, 0); continue;
    }
    h.sync.acceptTitle(h.current, identity, "Original", h.native);
    const title = change.endsWith("original") ? "Original" : "External rename";
    if (change.startsWith("cache")) {
      const latest = { pages: [{ items: [{ id: "current", title, update_time: "2026-09-10T00:00:00.000Z" }] }] };
      h.client.data = latest; h.completeCancel(); await settle();
      assert.equal(h.client.data, latest);
    } else {
      h.text.textContent = title;
      h.row.__reactFiber$test.memoizedProps.historyItem = { id: "current", title, update_time: "2026-09-10T00:00:00.000Z" };
      h.sync.refresh(); assert.equal(h.text.textContent, title); h.completeCancel(); await settle();
    }
    assert.equal(h.sync.project(h.native), h.native);
    assert.equal(h.calls.filter(([name]) => name === "invalidate").length, 0);
  }
});

test("accepted synchronization keeps exact owner/workspace/project gates", async () => {
  const identity = { accountKey: "user", workspaceKey: "personal" };
  const h = harness({ url: "https://chatgpt.com/c/owner", delayedCancel: true });
  const owner = { conversationId: "owner", pathname: "/c/owner", projectId: null };
  assert.equal(h.sync.acceptTitle(h.current, identity, "Original", null, { ownerContext: { ...owner, conversationId: "wrong" } }), false);
  assert.equal(h.sync.acceptTitle(h.current, { ...identity, workspaceKey: "other" }, "Original", null, { ownerContext: owner }), false);
  assert.equal(h.text.textContent, "Original");
  assert.equal(h.sync.acceptTitle(h.current, identity, "Original", null, { ownerContext: owner, targetProjectId: null }), true);
  h.context.document.cookie = "_account=other"; h.completeCancel(); await settle();
  assert.equal(h.calls.filter(([name]) => name === "patch" || name === "invalidate").length, 0);
  assert.equal(h.sync.project(h.native), h.native);
  const current = harness();
  assert.equal(current.sync.acceptTitle(current.current, identity, "Original", current.native, { targetProjectId: "g-p-wrong" }), false);
});

test("verified readback updates the exact native title and public directory caches without reload", async () => {
  const h = harness();
  assert.equal(h.accept(), true);
  assert.equal(h.text.textContent, h.current.title);
  assert.equal(h.context.document.title, h.current.title);
  assert.equal(h.row.label, h.current.title + " (unread)");
  await settle();
  assert.deepEqual(h.calls.map((call) => call[0]), ["cancel", "patch", "patch", "invalidate"]);
  assert.equal(h.client.data.pages[0].items[0].title, h.current.title);
  assert.equal(h.client.data.pages[0].items[0].update_time, h.current.updatedAt);
  assert.equal(h.client.data.pages[0].items[0].retained, true);
  assert.equal(h.client.data.pages[0].items[1], h.data.pages[0].items[1]);
  assert.equal(h.client.data.pageParams, h.data.pageParams);
  assert.equal(h.data.pages[0].items[0].title, "Original", "native cache immutable update");
  assert.equal(h.sync.project(h.native).title.value, h.current.title, "stale thread metadata cannot undo readback");
});

test("missing QueryClient still synchronizes bound text and metadata, not unrelated rows", () => {
  const h = harness({ withClient: false });
  h.accept();
  assert.equal(h.text.textContent, h.current.title);
  assert.equal(h.calls.length, 0);
  const mismatch = harness({ matched: false });
  mismatch.accept();
  assert.equal(mismatch.text.textContent, "Original");
  assert.equal(mismatch.sync.project({ ...mismatch.native, bindingStatus: "mismatch" }).title.value, "Original");
});

test("native rerenders retain verified display, but an external third title relinquishes it", () => {
  const h = harness();
  h.accept();
  h.text.textContent = "Original";
  h.sync.refresh();
  assert.equal(h.text.textContent, h.current.title);
  h.text.textContent = "Externally renamed";
  h.sync.refresh();
  assert.equal(h.text.textContent, "Externally renamed");
  assert.equal(h.sync.project(h.native), h.native);
});

test("SPA navigation keeps sidebar synchronization without changing another document title", () => {
  const h = harness();
  h.accept();
  h.context.location.href = "https://chatgpt.com/c/other";
  h.context.document.title = "Other";
  h.text.textContent = "Original";
  h.sync.refresh();
  assert.equal(h.text.textContent, h.current.title);
  assert.equal(h.context.document.title, "Other");
  h.context.location.href = "https://chatgpt.com/c/current";
  h.context.document.title = "Original";
  h.sync.refresh();
  assert.equal(h.context.document.title, h.current.title);
});

test("workspace switch cancels pending cache patch and drops old observations", async () => {
  const h = harness({ delayedCancel: true });
  h.accept();
  h.context.document.cookie = "_account=workspace-two";
  h.text.textContent = "Another workspace";
  h.completeCancel();
  await settle();
  h.sync.refresh();
  assert.equal(h.text.textContent, "Another workspace");
  assert.equal(h.calls.length, 1);
  assert.equal(h.sync.project(h.native), h.native);
});

test("newer native update time survives the title projection and date removal replaces its record", async () => {
  const h = harness();
  h.accept();
  const updatedAt = { value: "2026-09-10T00:00:00.000Z", source: "native" };
  assert.equal(h.sync.project({ ...h.native, updatedAt }).updatedAt, updatedAt);
  const removed = { ...h.current, title: "Original", updatedAt: "2026-09-11T00:00:00.000Z" };
  h.accept(removed);
  await settle();
  assert.equal(h.text.textContent, "Original");
  assert.equal(h.sync.project(h.native).updatedAt.value, removed.updatedAt);
  assert.equal(h.client.data.pages[0].items[0].title, "Original");
  assert.equal(h.calls.filter((call) => call[0] === "invalidate").length, 1, "superseded sync cannot overwrite removal");
});

test("unsupported directory shape is untouched and a cache error never fails the receipt", async () => {
  const h = harness();
  const malformed = { pages: [{ messages: [] }] };
  h.client.data = malformed;
  h.accept();
  await settle();
  assert.equal(h.client.data, malformed);
  h.client.cancelQueries = () => { throw new Error("Unavailable"); };
  assert.doesNotThrow(() => h.accept());
});

test("foreign routes and missing identity cannot synchronize a title", () => {
  const h = harness();
  assert.equal(h.accept(h.current, null), false);
  h.context.location.href = "https://chatgpt.com/c/other";
  assert.equal(h.accept(), false);
  assert.equal(h.text.textContent, "Original");
  assert.equal(h.calls.length, 0);
});

test("message-body self links are never eligible for title mutation", () => {
  const h = harness();
  h.row.closest = () => ({});
  h.accept();
  assert.equal(h.text.textContent, "Original");
});

test("a newer native rename back to the original title retires the projection", () => {
  const h = harness();
  h.accept();
  h.row.__reactFiber$test.memoizedProps.historyItem = { id: "current", title: "Original", update_time: "2026-09-10T00:00:00.000Z" };
  h.text.textContent = "Original";
  h.sync.refresh();
  assert.equal(h.text.textContent, "Original");
  assert.equal(h.sync.project(h.native), h.native);
});

test("a newer cache update during cancellation cannot be overwritten by an older readback", async () => {
  const h = harness({ delayedCancel: true });
  h.accept();
  const newerData = { pages: [{ items: [{ id: "current", title: "Newer rename", update_time: "2026-09-12T00:00:00.000Z" }] }] };
  h.client.data = newerData;
  h.completeCancel();
  await settle();
  assert.equal(h.client.data, newerData);
  assert.equal(h.sync.project(h.native), h.native);
  assert.equal(h.calls.filter((call) => call[0] === "invalidate").length, 0);
});

test("unchanged authenticated reads do not cancel or refetch the native directory", async () => {
  const h = harness();
  h.text.textContent = h.current.title;
  h.native.title.value = h.current.title;
  h.native.updatedAt.value = h.current.updatedAt;
  h.sync.accept(h.current, { accountKey: "user", workspaceKey: "personal" }, null, h.native);
  await settle();
  assert.equal(h.calls.length, 0);
});

test("a stale result for another workspace cannot alter the current page", () => {
  const h = harness();
  h.context.document.cookie = "_account=team%20two";
  assert.equal(h.accept(), false);
  assert.equal(h.text.textContent, "Original");
  assert.equal(h.accept(h.current, { accountKey: "user", workspaceKey: "team two" }), true);
});

test("project readback updates exact project row, document title and native project directory only", async () => {
  const projectId = "g-p-project-one";
  const href = `/g/${projectId}/c/current`;
  const h = harness({ url: `https://chatgpt.com${href}`, href });
  assert.equal(h.accept(), true);
  assert.equal(h.text.textContent, h.current.title);
  assert.equal(h.context.document.title, h.current.title);
  await settle(); await settle();
  assert.deepEqual(h.calls.filter(([name]) => name === "cancel").map(([, value]) => Array.from(value.queryKey, plainValue)),
    [["conversationHistory"], ["snorlaxConversations", { gizmoId: projectId }]]);
  const projectPatch = h.calls.find(([name, options]) => name === "patch" && options.queryKey[0] === "snorlaxConversations");
  assert.equal(projectPatch[1].queryKey[1].gizmoId, projectId);
  assert.equal(projectPatch[1].exact, undefined, "all native paged variants in this project's prefix are eligible");
  const invalidations = h.calls.filter(([name]) => name === "invalidate");
  assert.equal(invalidations.length, 2);
  assert.equal(invalidations[1][1].queryKey[1].gizmoId, projectId);
  assert.equal(h.sync.project(h.native).title.value, h.current.title);
});

function plainValue(value) { return JSON.parse(JSON.stringify(value)); }

test("batch result changes only target sidebar/cache, never the open owner's document or metadata", async () => {
  const h = harness({ url: "https://chatgpt.com/c/owner" });
  const owner = { conversationId: "owner", pathname: "/c/owner", projectId: null };
  h.context.document.title = "Owner title";
  const ownerNative = { ...h.native, conversationId: "owner", title: { value: "Owner title" } };
  assert.equal(h.sync.accept(h.current, { accountKey: "user", workspaceKey: "personal" }, "Original", ownerNative,
    { ownerContext: owner, targetProjectId: null }), true);
  assert.equal(h.context.document.title, "Owner title");
  assert.equal(h.text.textContent, h.current.title);
  assert.equal(h.sync.project(ownerNative), ownerNative);
  await settle();
  assert.equal(h.client.data.pages[0].items[0].title, h.current.title);
  // Navigation can later reveal the target's native old title without ever
  // teaching this target's observation that the owner's title is its own.
  h.context.location.href = "https://chatgpt.com/c/current";
  h.context.document.title = "Owner title";
  h.sync.refresh();
  assert.equal(h.context.document.title, "Owner title");
  h.context.document.title = "Original";
  h.sync.refresh();
  assert.equal(h.context.document.title, h.current.title);
});

test("batch project target patches its directory rather than the owner project", async () => {
  const href = "/g/g-p-target/c/current";
  const owner = { conversationId: "owner", pathname: "/g/g-p-owner/c/owner", projectId: "g-p-owner" };
  const h = harness({ url: `https://chatgpt.com${owner.pathname}`, href });
  h.context.document.title = "Owner";
  assert.equal(h.sync.accept(h.current, { accountKey: "user", workspaceKey: "personal" }, "Original", null,
    { ownerContext: owner, targetProjectId: "g-p-target" }), true);
  await settle(); await settle();
  assert.equal(h.text.textContent, h.current.title);
  assert.equal(h.context.document.title, "Owner");
  const projectCalls = h.calls.filter(([, options]) => options.queryKey[0] === "snorlaxConversations");
  assert.equal(projectCalls.length, 3);
  assert.equal(projectCalls.every(([, options]) => options.queryKey[1].gizmoId === "g-p-target"), true);
});

test("batch synchronization accepts canonical owner bindings on native trailing-slash pages", async () => {
  for (const owner of [
    { conversationId: "owner", pathname: "/c/owner", projectId: null },
    { conversationId: "owner", pathname: "/g/g-p-owner/c/owner", projectId: "g-p-owner" },
  ]) {
    const h = harness({ url: `https://chatgpt.com${owner.pathname}/` });
    h.context.document.title = "Owner title";
    assert.equal(h.sync.accept(h.current, { accountKey: "user", workspaceKey: "personal" }, "Original", null,
      { ownerContext: owner, targetProjectId: null }), true);
    assert.equal(h.text.textContent, h.current.title);
    assert.equal(h.context.document.title, "Owner title");
    await settle();
    assert.equal(h.client.data.pages[0].items[0].title, h.current.title);
  }
});

test("forged or stale batch owner binding cannot synchronize an off-current result", () => {
  const owner = { conversationId: "owner", pathname: "/c/owner", projectId: null };
  for (const ownerContext of [null, {}, { ...owner, pathname: "/c/other" }, { ...owner, projectId: "g-p-wrong" },
    { ...owner, conversationId: "other" }]) {
    const h = harness({ url: "https://chatgpt.com/c/owner" });
    assert.equal(h.sync.accept(h.current, { accountKey: "user", workspaceKey: "personal" }, "Original", null,
      { ownerContext }), false);
    assert.equal(h.text.textContent, "Original");
    assert.equal(h.calls.length, 0);
  }
});

test("same-target project hint cannot redirect a current ordinary synchronization", () => {
  const h = harness();
  assert.equal(h.sync.accept(h.current, { accountKey: "user", workspaceKey: "personal" }, "Original", h.native,
    { targetProjectId: "g-p-other" }), false);
  assert.equal(h.text.textContent, "Original");
});

test("unsupported or foreign-origin sidebar links are never mutated even with matching native row IDs", () => {
  for (const href of ["https://example.com/c/current", "/share/current", "/g/g-custom/c/current", "/c/current/extra",
    "/g/g-p-one/c/current/extra"]) {
    const h = harness({ href });
    h.accept();
    assert.equal(h.text.textContent, "Original", href);
  }
});

test("project cache cancellation cannot overwrite a switched workspace", async () => {
  const href = "/g/g-p-project-one/c/current";
  const h = harness({ url: `https://chatgpt.com${href}`, href, delayedCancel: true });
  h.accept();
  h.context.document.cookie = "_account=new-workspace";
  h.completeCancel();
  await settle(); await settle();
  assert.equal(h.calls.filter(([name]) => name === "patch" || name === "invalidate").length, 0);
});

test("moving the same target into another project retires old page-scoped title observations", async () => {
  for (const through of ["refresh", "project"]) {
    const href = "/g/g-p-first/c/current";
    const h = harness({ url: `https://chatgpt.com${href}`, href, delayedCancel: true });
    h.accept();
    h.context.location.href = "https://chatgpt.com/g/g-p-second/c/current";
    h.context.document.title = "Original";
    h.text.textContent = "Original";
    if (through === "refresh") h.sync.refresh();
    else assert.equal(h.sync.project(h.native), h.native);
    assert.equal(h.text.textContent, "Original");
    assert.equal(h.context.document.title, "Original");
    assert.equal(h.sync.project(h.native), h.native);
    h.completeCancel();
    await settle(); await settle();
    assert.equal(h.calls.filter(([name]) => name === "patch" || name === "invalidate").length, 0);
  }
});

test("page retirement revokes observations, releases API subscriptions and blocks pending native work", async () => {
  for (const href of ["/c/current", "/g/g-p-project/c/current"]) {
    const h = harness({ url: `https://chatgpt.com${href}`, href, delayedCancel: true });
    assert.equal(h.accept(), true);
    assert.deepEqual(h.subscriptions, { onLibraryIdentityChanged: 1, onTitleChanged: 1 });
    const count = h.calls.length;
    h.pageSession.stop();
    assert.deepEqual(h.subscriptions, { onLibraryIdentityChanged: 0, onTitleChanged: 0 });
    assert.equal(h.calls.length, count, "teardown must not cancel or invalidate any native query");
    h.text.textContent = "Original"; h.row.label = "Original (unread)"; h.context.document.title = "Original";
    h.completeCancel(); await settle(); await settle();
    h.emit("pageshow"); h.emit("prerenderingchange");
    h.sync.refresh();
    assert.equal(h.accept(), false);
    assert.equal(h.sync.acceptTitle(h.current, { accountKey: "user", workspaceKey: "personal" }, "Original", h.native), false);
    assert.equal(h.sync.project(h.native), h.native);
    assert.equal(h.text.textContent, "Original");
    assert.equal(h.row.label, "Original (unread)");
    assert.equal(h.context.document.title, "Original");
    assert.equal(h.client.data, h.data);
    assert.equal(h.calls.length, count, "settled cancellation and later entrypoints cannot restart native work");
  }
});

test("native cache updaters retained by QueryClient return the original data after retirement", async () => {
  const href = "/g/g-p-project/c/current";
  const h = harness({ url: `https://chatgpt.com${href}`, href });
  const updaters = [];
  h.client.setQueriesData = (options, update) => { h.calls.push(["patch", options]); updaters.push(update); };
  assert.equal(h.accept(), true);
  await settle(); await settle();
  assert.equal(updaters.length, 3);
  h.pageSession.stop();
  for (const update of updaters) assert.equal(update(h.data), h.data);
  assert.equal(h.data.pages[0].items[0].title, "Original");
  assert.equal(h.sync.project(h.native), h.native);
});

test("shared retirement marker blocks DOM refresh before a disposal event is delivered", async () => {
  const h = harness({ delayedCancel: true });
  h.accept();
  h.text.textContent = "Original"; h.row.label = "Original (unread)"; h.context.document.title = "Original";
  h.context.document.documentElement.setAttribute("data-tidy-page-session", "retired");
  h.sync.refresh();
  assert.equal(h.text.textContent, "Original");
  assert.equal(h.row.label, "Original (unread)");
  assert.equal(h.context.document.title, "Original");
  assert.equal(h.sync.project(h.native), h.native);
  assert.deepEqual(h.subscriptions, { onLibraryIdentityChanged: 0, onTitleChanged: 0 });
  h.completeCancel(); await settle();
  assert.deepEqual(h.calls.map(([name]) => name), ["cancel"]);
});

test("synchronous retirement during a native text write stops later DOM and cache writes", () => {
  const h = harness();
  let value = "Original";
  Object.defineProperty(h.text, "textContent", {
    get: () => value,
    set: next => { value = next; h.pageSession.stop(); },
  });
  assert.equal(h.accept(), false);
  assert.equal(value, h.current.title, "the already-dispatched write is not undone");
  assert.equal(h.row.label, "Original (unread)");
  assert.equal(h.context.document.title, "Original");
  assert.equal(h.calls.length, 0);
  assert.equal(h.sync.project(h.native), h.native);
});

test("every native QueryClient call checks retirement even within the same synchronous turn", async () => {
  for (const stopAt of ["cancel", "patch", "invalidate"]) {
    const href = "/g/g-p-project/c/current";
    const h = harness({ url: `https://chatgpt.com${href}`, href });
    const name = { cancel: "cancelQueries", patch: "setQueriesData", invalidate: "invalidateQueries" }[stopAt];
    const original = h.client[name];
    h.client[name] = (...args) => {
      h.pageSession.stop();
      return original(...args);
    };
    h.accept(); await settle(); await settle();
    const names = h.calls.map(([kind]) => kind);
    assert.equal(names.filter(kind => kind === stopAt).length, 1, stopAt);
    assert.equal(names.at(-1), stopAt, "no later native call follows the retirement boundary");
    if (stopAt === "patch") assert.equal(h.client.data, h.data, "updater checks retirement after the public API call");
    assert.equal(h.sync.project(h.native), h.native);
  }
});
