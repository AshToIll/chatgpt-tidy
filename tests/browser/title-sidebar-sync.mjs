// Real DOM and production title synchronization, with explicit synthetic
// account/route/cache ports. Never connect to the user's ChatGPT page.
const results = [], sidebar = document.querySelector("#sidebar"), draft = document.querySelector("#draft");
const original = "Original title", identity = { accountKey: "fixture-user", workspaceKey: "personal" };
const createdAt = "2026-09-01T00:00:00.000Z", updatedAt = "2026-09-09T00:00:00.000Z";
const ownerContext = { conversationId: "current", pathname: "/g/g-p-project/c/current", projectId: "g-p-project" };
const calls = [], dispose = [];
let live = true;
const client = {
  data: { pages: [{ items: [] }], pageParams: [0] },
  getQueryCache() {},
  cancelQueries(options) { calls.push(["cancel", options]); return Promise.resolve(); },
  setQueriesData(options, update) { calls.push(["patch", options]); this.data = update(this.data); },
  invalidateQueries(options) { calls.push(["invalidate", options]); return Promise.resolve(); },
};
const environment = {
  URL, document, location: { origin: "https://chatgpt.com", href: `https://chatgpt.com${ownerContext.pathname}` },
  TidyPageSession: { check: () => live, onDispose: callback => dispose.push(callback) },
  TidyChatgptApi: {
    activeWorkspace: () => "personal",
    checkLibraryIdentity: () => ({ phase: "ready", accountKey: JSON.stringify([identity.accountKey, "personal"]), epoch: 1 }),
    onLibraryIdentityChanged: () => () => {}, onTitleChanged: () => () => {}, onConversationAvailabilityChanged: () => () => {},
  },
};
for (const file of ["src/platform/snapshot.js", "src/platform/chatgpt/route.js", "src/platform/chatgpt/sidebar-dom.js", "src/features/titles/chatgpt/title-sync.js"]) {
  const source = await (await fetch(`../../${file}`)).text();
  new Function("globalThis", source)(environment);
}
const sync = environment.TidyChatgptTitleSync;
document.querySelector("main").__reactFiber$fixture = { memoizedProps: { client } };
function row(id, { href = `/c/${id}`, title = original, props = "historyItem", idless = false, parent = sidebar, split = false } = {}) {
  const link = document.createElement("a"); link.setAttribute("href", href); link.setAttribute("aria-label", `${title} (unread)`);
  const label = document.createElement("span"); label.className = "native-title";
  if (split) {
    const head = document.createElement("span"), tail = document.createElement("span");
    head.textContent = title.slice(0, 3); tail.textContent = title.slice(3); label.append(head, tail);
  } else label.textContent = title;
  const decoration = document.createElement("span"); decoration.dataset.tidyOwned = "sidebar-time"; decoration.textContent = "2026/09/01";
  link.append(label, decoration); parent.append(link);
  const metadata = { ...(idless ? {} : { id }), title, create_time: 1788220800, update_time: 1788220800 };
  link.__reactFiber$fixture = { memoizedProps: { [props]: metadata }, return: { memoizedProps: { client } } };
  return { link, label, metadata, decoration };
}
const project = document.createElement("section"); project.hidden = true; sidebar.append(project);
const copies = [row("current", { href: ownerContext.pathname, parent: project, props: "conversation", split: true }), row("current", { idless: true })];
const batchRows = Array.from({ length: 24 }, (_, i) => row(`batch-${i}`, { title: `Chat ${i}`, split: i % 2 === 0 }));
client.data.pages[0].items = [copies[0].metadata, ...batchRows.map(entry => entry.metadata)];
const snapshot = { conversationId: "current", bindingStatus: "bound", title: { value: original }, updatedAt: { value: createdAt } };
const assert = (value, message) => { if (!value) throw new Error(message); };
const check = async (name, fn) => { try { await fn(); results.push({ name, ok: true }); } catch (error) { results.push({ name, ok: false, error: error.message }); } };
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const title = entry => entry.label.textContent.trim();

draft.focus(); draft.setSelectionRange(3, 8); sidebar.scrollTop = 90;
const scrollTop = sidebar.scrollTop, nativeLabel = copies[0].label, span = nativeLabel.firstChild;
for (const mode of ["accept", "acceptTitle"]) {
  let before = original;
  for (const after of ["2026/09/01 | Original title", "2026-09-01 | Original title", "2026-09-09 | Original title", original]) {
    await check(`${mode}: ${after} immediately updates both native copies`, async () => {
      const ok = sync[mode]({ conversationId: "current", title: after, createdAt, updatedAt }, identity, before, snapshot);
      assert(ok, "receipt rejected");
      for (const entry of copies) {
        assert(title(entry) === after, "native row not updated synchronously");
        assert(entry.link.getAttribute("aria-label") === `${after} (unread)`, "accessible label stale");
        assert(entry.decoration.textContent === "2026/09/01", "TIDY date decoration changed");
      }
      assert(document.title === after, "document title stale");
      assert(copies[0].label === nativeLabel && nativeLabel.firstChild === span, "native nodes replaced");
      assert(document.activeElement === draft && draft.value === "Unsent draft stays here.", "composer disturbed");
      assert(draft.selectionStart === 3 && draft.selectionEnd === 8, "selection disturbed");
      assert(sidebar.scrollTop === scrollTop, "sidebar scrolled");
      await settle();
      assert(client.data.pages[0].items[0].title === after, "native history cache stale");
    });
    await check(`${mode}: delayed native rerender cannot revert ${after}`, () => {
      copies[0].label.firstChild.textContent = "Ori"; copies[0].label.lastChild.textContent = "ginal title";
      copies[1].label.firstChild.textContent = original;
      sync.refresh();
      assert(copies.every(entry => title(entry) === after), "stale React render won");
    });
    before = after;
  }
}
await check("24 accepted batch targets survive delayed DOM remounts without changing the open document", async () => {
  for (let i = 0; i < batchRows.length; i++) {
    assert(sync.acceptTitle({ conversationId: `batch-${i}`, title: `2026/09/01 | Chat ${i}` }, identity, `Chat ${i}`, null,
      { ownerContext, targetProjectId: "g-p-other" }), "batch receipt rejected");
  }
  await settle();
  batchRows.forEach((entry, i) => { entry.label.textContent = `Chat ${i}`; });
  sync.refresh();
  batchRows.forEach((entry, i) => assert(title(entry) === `2026/09/01 | Chat ${i}`, `lost batch receipt ${i}`));
  assert(document.title === original, "batch changed the owner's title");
});
await check("lazy-mounted project copy receives the latest batch title", () => {
  const lazy = row("batch-0", { parent: project, href: "/g/g-p-other/c/batch-0", title: "Chat 0", props: "conversation" });
  sync.refresh(); assert(title(lazy) === "2026/09/01 | Chat 0", "late project copy missed the saved title");
});
await check("citations, dialogs, auxiliary links and conflicting row IDs stay untouched", () => {
  const excluded = [];
  for (const parent of [document.querySelector("main"), document.body.appendChild(document.createElement("dialog"))]) {
    excluded.push(row("current", { parent }));
  }
  const auxiliary = row("current"); auxiliary.link.setAttribute("aria-hidden", "true"); excluded.push(auxiliary);
  excluded.push(row("wrong", { href: "/c/current" }), row("current", { href: "https://example.com/c/current" }));
  sync.accept({ conversationId: "current", title: "2026/09/01 | Original title", createdAt, updatedAt }, identity, original, snapshot);
  assert(excluded.every(entry => title(entry) === original), "non-sidebar/conflicting link mutated");
  excluded.forEach(entry => entry.link.remove());
});
await check("native later rename wins over the projection even with epoch-second metadata", () => {
  copies.forEach(entry => { entry.label.textContent = "Native rename"; entry.metadata.title = "Native rename"; entry.metadata.update_time = 1788998400; });
  sync.refresh(); assert(copies.every(entry => title(entry) === "Native rename"), "external rename overwritten");
});
await settle();
await check("teardown releases page-scoped receipts and never reloads or edits message data", () => {
  live = false; dispose.forEach(callback => callback());
  const count = calls.length; sync.refresh();
  assert(calls.length === count, "native requests after retirement");
  assert(document.querySelector("main a").textContent === "Body citation stays here", "message link changed");
  assert(calls.every(([, options]) => ["conversationHistory", "snorlaxConversations"].includes(options.queryKey[0])), "non-directory query changed");
});
const output = document.querySelector("#results");
output.textContent = JSON.stringify({ ok: results.every(result => result.ok), checks: results.length, results }, null, 2);
output.dataset.complete = "true";
