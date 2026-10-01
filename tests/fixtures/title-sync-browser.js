// Synthetic native cache/row only. The production synchronization module runs
// against real browser text nodes; this fixture never contacts ChatGPT.
const sidebar = document.querySelector("nav a");
const titleNode = sidebar.querySelector("span").firstChild;
const initial = { conversationId: "current", title: "Original", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };
const nativeSnapshot = { conversationId: "current", bindingStatus: "bound", title: { value: "Original" }, updatedAt: { value: initial.updatedAt } };
let current = initial;
const client = {
  data: { pages: [{ items: [{ id: "current", title: "Original", update_time: initial.updatedAt }] }] },
  getQueryCache() {},
  cancelQueries() { return Promise.resolve(); },
  setQueriesData(_options, updater) {
    this.data = updater(this.data);
    document.querySelector("#cache-title").textContent = this.data.pages[0].items[0].title;
  },
  invalidateQueries() { return Promise.resolve(); },
};
sidebar.__reactFiber$fixture = { memoizedProps: { historyItem: { id: "current" } }, return: { memoizedProps: { client } } };
document.querySelector("main a").__reactFiber$fixture = { memoizedProps: { conversation: { id: "current" } } };
globalThis.TidyChatgptRoute = { parse: () => ({ kind: "conversation", pathname: "/c/current", conversationId: "current" }) };
function render() {
  globalThis.TidyChatgptTitleSync.refresh();
  document.querySelector("#snapshot-title").textContent = globalThis.TidyChatgptTitleSync.project(nativeSnapshot).title.value;
}
function save(title, updatedAt) {
  const before = current.title;
  current = { ...initial, title, updatedAt };
  globalThis.TidyChatgptTitleSync.accept(current, { accountKey: "fixture-user", workspaceKey: "personal" }, before, nativeSnapshot);
  render();
}
document.querySelector("#save").onclick = () => save("2026/09/01 | Original", "2026-09-09T00:00:00.000Z");
document.querySelector("#remove").onclick = () => save("Original", "2026-09-10T00:00:00.000Z");
document.querySelector("#rerender").onclick = () => { titleNode.textContent = "Original"; render(); };
