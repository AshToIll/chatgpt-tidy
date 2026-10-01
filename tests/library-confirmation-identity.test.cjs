const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createPanelRuntime } = require("./helpers/panel-runtime.cjs");
const { createLibraryViewHarness } = require("./helpers/library-view-harness.cjs");

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

// Real library receipt ownership and real panel invalidation surround the real
// feature view. Only DOM/confirmation buttons and transport are fixture seams.
async function harness(kind) {
  const h = createLibraryViewHarness(kind);
  const runtime = createPanelRuntime();
  runtime.load("src/platform/library/library-hydration.js");
  const { createLibraryController } = runtime.load("src/platform/library/ui/library-controller.js");
  const { createLibraryPanelController } = runtime.load("src/app/sidepanel/library-panel-controller.js");
  const accountKey = "identity-review-owner";
  let receipt = { accountKey, identity: { documentId: "identity-review-document", epoch: 1 },
    favorites: { accountKey, revision: 1, items: {}, groups: [] },
    bookmarks: { accountKey, revision: 1, items: {}, groups: [] }, errors: {} };
  receipt[kind] = { ...h.model.store, accountKey, revision: 1 };
  let panel, resets = 0;
  const library = createLibraryController({ request: async () => receipt,
    onChanged: model => panel.onLibraryChanged(model) });
  const passive = { root: {}, reset() {}, render() {} };
  const view = { root: h.root, reset() { resets++; h.view.reset(); }, render: patch => h.render(patch) };
  panel = createLibraryPanelController({ ownerTabId: 11, readLibrary: library.getState,
    readPresentation: () => ({ preferences: h.model.preferences, snapshot: null, t: key => key }),
    readRoute: () => kind, isReady: () => true,
    views: { favorites: kind === "favorites" ? view : passive, bookmarks: kind === "bookmarks" ? view : passive },
    navigation: { pendingConversationId: () => null, pendingBookmarkId: () => null },
    presentation: { hasLibraryWaiting: () => false, clearLibraryNotice() {}, renderLibraryWaiting() {}, renderModuleError() {} },
    selectionState: () => ({ active: false }), filing: { favorites() {}, bookmarks() {} },
    refreshLibrary: library.refresh, navigate() {},
    onChanged() { kind === "favorites" ? panel.renderFavorites() : panel.renderBookmarks(); },
  });
  await library.refresh();
  const groupId = kind === "favorites" ? "study" : "bookmark-quote";
  function ask() {
    h.click(kind === "favorites" ? '[data-group-menu="study"]' : '[data-bookmark-group-menu="bookmark-quote"]');
    h.click(kind === "favorites" ? '[data-group-action="delete"]' : '[data-bookmark-group-action="delete"]');
    assert.equal(h.confirmations.length, 1, "Delete opens the shared asynchronous confirmation");
    assert.equal(h.actions.length, 0, "Opening confirmation does not dispatch deletion");
  }
  return { h, library, ask, groupId, get resets() { return resets; }, get receipt() { return receipt; },
    set receipt(value) { receipt = value; }, dispose() { library.dispose(); h.view.reset(); } };
}

for (const kind of ["favorites", "bookmarks"]) {
  test(kind + " rejects pending deletion when a refresh receipt advances identity without a preceding event", async () => {
    const x = await harness(kind);
    try {
      x.ask(); const token = x.library.capture(), before = x.resets;
      x.receipt = { ...x.receipt, identity: { ...x.receipt.identity, epoch: 2 } };
      await x.library.refresh();
      assert.equal(x.library.isCurrent(token), false, "The library retired its old owner fence");
      assert.equal(x.library.getState().identity.epoch, 2);
      assert.equal(x.resets, before + 1, "A same-account new identity also resets pending view authorization");
      x.h.answerConfirmation(true); await flush();
      assert.equal(x.h.actions.length, 0, "A stale confirmation cannot acquire the new action owner");
    } finally { x.dispose(); }
  });

  test(kind + " rejects pending deletion when a replacement document reuses the same account", async () => {
    const x = await harness(kind);
    try {
      x.ask(); const token = x.library.capture(), before = x.resets;
      x.receipt = { ...x.receipt, identity: { documentId: "identity-review-replacement", epoch: 1 } };
      x.library.observeIdentity({ ...x.receipt.identity, accountKey: x.receipt.accountKey, phase: "ready" });
      await flush();
      assert.equal(x.library.isCurrent(token), false);
      assert.equal(x.library.getState().identity.documentId, "identity-review-replacement");
      assert.ok(x.resets > before, "Document ownership retires old confirmations even for the same account");
      x.h.answerConfirmation(true); await flush();
      assert.equal(x.h.actions.length, 0);
    } finally { x.dispose(); }
  });

  test(kind + " preserves pending confirmation through ordinary same-owner store and translation refresh", async () => {
    const x = await harness(kind);
    try {
      x.ask(); const token = x.library.capture(), before = x.resets;
      x.receipt = { ...x.receipt, identity: { ...x.receipt.identity },
        [kind]: { ...x.receipt[kind], revision: 2, groups: x.receipt[kind].groups.map(group => ({ ...group })) } };
      await x.library.refresh();
      x.h.render({ t: key => "translated:" + key });
      assert.equal(x.library.isCurrent(token), true);
      assert.equal(x.resets, before, "Equivalent identity values must not reset for new object references/revisions");
      x.h.answerConfirmation(true); await flush();
      assert.equal(x.h.actions.length, 1, "The still-current deliberate confirmation remains usable");
      assert.equal(x.h.actions[0].type, "group-delete");
      assert.equal(x.h.actions[0].payload.groupId, x.groupId);
    } finally { x.dispose(); }
  });
}
