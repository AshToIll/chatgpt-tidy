const assert = require("node:assert/strict");
const { test } = require("node:test");

async function actionsHarness() {
  const { createBookmarksActions } = await import("../src/features/bookmarks/ui/bookmarks-actions.js");
  const h = { current: true, notices: [], refreshes: 0, writes: [], accepted: 0 };
  h.request = async () => { throw Object.assign(new Error("private rejected value"), { code: "VALIDATION_ERROR" }); };
  h.actions = createBookmarksActions({ ownerTabId: 7, isReady: () => true,
    captureOwner: () => ({ accountKey: "test-account", identity: { epoch: 1 } }),
    isOwnerCurrent: () => h.current,
    acceptMutation: () => { h.accepted++; return true; },
    refresh: async () => { h.refreshes++; },
    request: (...args) => { h.writes.push(args); return h.request(...args); },
    toast: (...args) => h.notices.push(args),
    readCurrentConversationId: () => "test-conversation", startNavigation: async () => {},
  });
  return h;
}

test("bookmark deterministic validation rejection is brief and does not claim an unknown write", async () => {
  for (const [action, payload] of [
    ["group-create", { name: "   " }],
    ["group-update", { groupId: "test-group", patch: { name: "　" } }],
    ["group-update", { groupId: "test-group", patch: { icon: "invalid" } }],
    ["group-reorder", { orderedGroupIds: [] }],
  ]) {
    const h = await actionsHarness();
    await h.actions.handle(action, payload);
    assert.equal(h.notices.length, 1);
    const [key, error, values, lifecycle] = h.notices[0];
    assert.equal(key, "actionFailed");
    assert.equal(error, true);
    assert.deepEqual(values, {});
    assert.equal(lifecycle.durationMs, 5000);
    assert.equal(lifecycle.owner, "bookmarks");
    assert.equal(lifecycle.cause.code, "VALIDATION_ERROR");
    assert.equal(h.accepted, 0);
    assert.equal(h.refreshes, 1);
  }
});

test("late bookmark validation failure stays silent after account ownership changes", async () => {
  const h = await actionsHarness();
  let reject;
  h.request = () => new Promise((_resolve, fail) => { reject = fail; });
  const work = h.actions.handle("group-create", { name: "Example" });
  h.current = false;
  reject(Object.assign(new Error("invalid"), { code: "VALIDATION_ERROR" }));
  await work;
  assert.equal(h.notices.length, 0);
  assert.equal(h.refreshes, 0);
  assert.equal(h.accepted, 0);
});


const { createLibraryViewHarness } = require("./helpers/library-view-harness.cjs");
function harness() {
  const h = createLibraryViewHarness("bookmarks");
  // Valid canonical records reach the real domain selector. The general
  // harness's convenience seed is intentionally not used for these assertions.
  h.seedBookmarks = () => {
    const item = messageId => ({ bookmarkId: "conversation-a::" + messageId,
      conversationId: "conversation-a", messageId, routePath: "/c/conversation-a",
      conversationTitle: "Test", excerpt: "saved excerpt", role: "assistant",
      groupId: "bookmark-quote", bookmarkedAt: "2026-10-01T00:00:00.000Z" });
    const a = item("bookmark-a"), b = item("bookmark-b");
    h.render({ store: { ...h.model.store, view: { ...h.model.store.view, groupId: "all" },
      items: { [a.bookmarkId]: a, [b.bookmarkId]: b } } });
  };
  return h;
}
// Await production async handlers across the VM boundary, not just the host's
// first Promise microtask. No fixture performs an actual library write.
const settle = () => new Promise(setImmediate);
const overlaySelector = "[data-bookmark-group-overlay], [data-bookmark-entry-overlay]";
const groupMenu = '[data-bookmark-group-menu="bookmark-quote"]';
const entryMenu = '[data-bookmark-entry-menu="conversation-a::bookmark-a"]';
function absent(h, selector, message = "retired UI is absent") {
  assert.equal(h.root.querySelector(selector) === null, true, message);
}
function openOverlay(h, kind) {
  if (kind === "entry") { h.seedBookmarks(); h.click(entryMenu); }
  else {
    h.click(groupMenu);
    if (kind === "icon") h.click('[data-bookmark-group-action="icon"]');
  }
}
function boundary(h, name) {
  if (name === "leave") h.view.dismissTransientUi();
  if (name === "reset") { h.view.reset(); h.render(); }
  if (name === "hidden") { h.document.hidden = true; h.event("visibilitychange", h.root); }
  if (name === "renamed") h.render({ store: { ...h.model.store, groups: h.model.store.groups.map(group => group.id === "bookmark-quote" ? { ...group, name: "remote rename" } : group) } });
  if (name === "deleted") h.render({ store: { ...h.model.store, groups: h.model.store.groups.filter(group => group.id !== "bookmark-quote") } });
}
function openDelete(h) { h.click(groupMenu); h.click('[data-bookmark-group-action="delete"]'); }

for (const kind of ["group", "icon", "entry"]) {
  test("bookmark " + kind + " overlay shares Escape dismissal and exact trigger focus", () => {
    const h = harness(); openOverlay(h, kind);
    assert.ok(h.root.querySelector(overlaySelector));
    const target = h.root.querySelector(kind === "entry" ? '[data-library-move-group="bookmark-insight"]'
      : kind === "icon" ? "[data-bookmark-group-icon]" : "[data-bookmark-group-action]");
    assert.ok(target);
    const event = h.event("keydown", target, { key: "Escape" }); h.flush();
    assert.equal(event.defaultPrevented, true);
    absent(h, overlaySelector);
    assert.equal(h.document.activeElement === h.root.querySelector(kind === "entry" ? entryMenu : groupMenu), true);
    assert.equal(h.actions.length, 0);
  });

  test("bookmark " + kind + " overlay closes before a deferred group change", () => {
    const h = harness(); openOverlay(h, kind);
    const source = h.root.querySelector(kind === "entry" ? entryMenu : groupMenu);
    h.click('[data-bookmark-select-group="bookmark-insight"]');
    absent(h, overlaySelector);
    assert.equal(source.getAttribute("aria-expanded"), "false");
    assert.equal(h.actions.length, 1);
    assert.equal(h.actions[0].type, "view-update");
    assert.equal(h.actions[0].payload.groupId, "bookmark-insight");
  });

  for (const name of ["leave", "hidden", "reset"]) {
    test("bookmark " + kind + " overlay cannot revive after " + name, () => {
      const h = harness(); openOverlay(h, kind);
      boundary(h, name); h.flush(); h.render();
      absent(h, overlaySelector);
      assert.equal(h.actions.length, 0);
    });
  }
}

test("bookmark capture-phase ownership keeps the opened icon picker alive across menu replacement", () => {
  const h = harness(); h.click(groupMenu);
  const oldIconAction = h.root.querySelector('[data-bookmark-group-action="icon"]');
  h.event("click", oldIconAction); h.flush();
  assert.ok(h.root.querySelector(".bookmark-icon-picker"), "the menu changed into the picker before document bubbling");
  assert.ok(h.root.querySelector("[data-bookmark-group-icon]"), "bubble dismissal must remember the click started inside the menu");
  assert.equal(h.actions.length, 0);
});

test("bookmark outside click closes without stealing focus from another control", () => {
  const h = harness(); h.click(groupMenu);
  const outside = { nodeType: 1, childNodes: [], getAttribute: () => null, hasAttribute: () => false };
  h.document.activeElement = outside;
  h.event("click", outside); h.flush();
  absent(h, overlaySelector);
  assert.equal(h.document.activeElement === outside, true);
  assert.equal(h.actions.length, 0);
});

test("bookmark Escape cannot steal IME candidate focus or apply an older queued trigger focus", () => {
  const h = harness(); h.openRename(); const input = h.input("候选文字");
  h.click('[data-bookmark-group-menu="bookmark-insight"]'); input.focus();
  const ime = h.event("keydown", input, { key: "Escape", isComposing: true }); h.flush();
  assert.equal(Boolean(ime.defaultPrevented), false);
  assert.equal(h.document.activeElement === input, true);
  assert.ok(h.root.querySelector(overlaySelector));
  h.event("keydown", h.root.querySelector("[data-bookmark-group-action]"), { key: "Escape" });
  h.event("click", h.root.querySelector('[data-bookmark-group-menu="bookmark-todo"]'));
  h.flush();
  assert.equal(h.root.querySelector("[data-bookmark-group-overlay]").dataset.bookmarkGroupOverlay, "bookmark-todo");
  assert.equal(h.document.activeElement === h.root.querySelector('[data-bookmark-group-menu="bookmark-insight"]'), false);
});

test("bookmark detached old menu cannot issue delete or move after group switch", () => {
  const h = harness(); h.click(groupMenu);
  const staleDelete = h.root.querySelector('[data-bookmark-group-action="delete"]');
  h.click('[data-bookmark-select-group="bookmark-insight"]');
  h.event("click", staleDelete); h.flush();
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].type, "view-update");
});

for (const mode of ["create", "rename"]) {
  for (const value of ["", "   ", "　　"]) {
    test("bookmark " + mode + " rejects " + JSON.stringify(value) + " inline without request or draft loss", () => {
      const h = harness();
      if (mode === "create") h.click("[data-open-bookmark-new-group]"); else h.openRename();
      const input = h.input(value), form = input.closest("form");
      assert.equal(form.hasAttribute("novalidate"), true, "the browser-native balloon is no longer the validator");
      h.submit();
      assert.equal(h.actions.length, 0);
      assert.equal(h.root.querySelector('[name="name"]') === input, true);
      assert.equal(input.value, value);
      assert.equal(input.getAttribute("aria-invalid"), "true");
      const error = h.root.querySelector("[data-group-name-error]");
      assert.ok(error);
      assert.equal(input.getAttribute("aria-describedby"), error.getAttribute("id"));
      assert.equal(h.document.activeElement === input, true);
      h.render({ t: key => "translated:" + key });
      assert.equal(input.value, value);
      h.input("  Corrected name  ");
      absent(h, "[data-group-name-error]");
      assert.equal(input.getAttribute("aria-invalid"), null);
      h.submit();
      assert.equal(h.actions.length, 1);
      assert.equal(h.actions[0].type, mode === "create" ? "group-create" : "group-update");
      assert.equal(mode === "create" ? h.actions[0].payload.name : h.actions[0].payload.patch.name, "Corrected name");
      if (mode === "rename") assert.equal(h.actions[0].payload.groupId, "bookmark-quote");
    });
  }

  test("bookmark " + mode + " retains draft, native input and selection across model refresh", () => {
    const h = harness();
    if (mode === "create") h.click("[data-open-bookmark-new-group]"); else h.openRename();
    const input = h.input("未完成 private draft"); input.focus(); input.selectionStart = 3; input.selectionEnd = 7;
    h.render({ t: key => "ja:" + key, store: { ...h.model.store, groups: h.model.store.groups.map(group => ({ ...group, name: "remote name" })) } });
    assert.equal(h.root.querySelector('[name="name"]') === input, true);
    assert.equal(input.value, "未完成 private draft");
    assert.equal(h.document.activeElement === input, true);
    assert.equal(input.selectionStart, 3); assert.equal(input.selectionEnd, 7);
  });

  test("bookmark " + mode + " does not submit or show errors while an IME composition is active", () => {
    const h = harness();
    if (mode === "create") h.click("[data-open-bookmark-new-group]"); else h.openRename();
    const input = h.input(" ");
    h.event("compositionstart", input);
    h.submit();
    assert.equal(h.actions.length, 0);
    absent(h, "[data-group-name-error]");
    h.event("compositionend", input); h.submit();
    assert.equal(h.actions.length, 0);
    assert.ok(h.root.querySelector("[data-group-name-error]"));
    const sameInput = h.root.querySelector('[name="name"]');
    h.event("compositionstart", sameInput); h.input("新名称");
    absent(h, "[data-group-name-error]");
    assert.equal(h.root.querySelector('[name="name"]') === sameInput, true);
    h.submit(); assert.equal(h.actions.length, 0);
    h.event("compositionend", sameInput); h.submit();
    assert.equal(h.actions.length, 1);
  });

  test("bookmark " + mode + " suppresses repeated pending submit and prevents native navigation", () => {
    const h = harness();
    if (mode === "create") h.click("[data-open-bookmark-new-group]"); else h.openRename();
    h.input("Valid name"); h.submit();
    const form = h.root.querySelector("[data-bookmark-new-group], [data-bookmark-group-rename]");
    assert.ok(form, "deferred response leaves the previously rendered form until a snapshot");
    const repeat = h.event("submit", form); h.flush();
    assert.equal(repeat.defaultPrevented, true);
    assert.equal(h.actions.length, 1);
  });
}

test("bookmark bottom-row invalid feedback reveals only its complete editor, once per submit", () => {
  const h = harness(); h.openRename(); const input = h.input(" ");
  const form = input.closest("form"), groups = h.root.querySelector("[data-bookmark-group-list]");
  const results = h.root.querySelector('[data-results-viewport="bookmarks"]');
  groups.scrollTop = 100; groups.clientHeight = 220;
  groups.getBoundingClientRect = () => ({ top: 100, bottom: 320, left: 0, right: 280, width: 280 });
  form.getBoundingClientRect = () => ({ top: 300, bottom: form.querySelector("[data-group-name-error]") ? 352 : 328, left: 0, right: 280, width: 280 });
  results.scrollTop = 47; h.root.scrollTop = 13;
  h.submit();
  assert.equal(groups.scrollTop, 136, "scrolls only enough to reveal the whole error line with the shared 4px margin");
  assert.equal(results.scrollTop, 47);
  assert.equal(h.root.scrollTop, 13);
  const search = h.root.querySelector("[data-bookmark-search]"); search.focus();
  h.render();
  assert.equal(groups.scrollTop, 136, "snapshot restores the corrected position instead of the clipped old offset");
  assert.equal(h.document.activeElement === search, true, "a persistent error does not repeatedly reclaim input focus");
});

test("bookmark root reset revokes private name draft and queued focus before a new owner renders", () => {
  const h = harness();
  h.event("click", h.root.querySelector("[data-open-bookmark-new-group]"));
  h.input("private old-owner draft"); h.view.reset(); h.render();
  absent(h, "[data-bookmark-new-group]");
  absent(h, "[data-group-name-error]");
  assert.equal(h.document.activeElement === undefined, true);
  assert.equal(h.actions.length, 0);
});

test("bookmark retired name input cannot overwrite a different editor", () => {
  const h = harness(); h.click("[data-open-bookmark-new-group]"); const old = h.input("old draft");
  h.click("[data-cancel-bookmark-new-group]"); h.openRename(); h.input("current draft");
  old.value = "retired change"; h.event("input", old); h.render();
  assert.equal(h.root.querySelector('[name="name"]').value, "current draft");
});

test("bookmark name diagnostics are deduplicated, local and free of private drafts", () => {
  const h = harness(); h.click("[data-open-bookmark-new-group]"); h.input(" "); h.submit(); h.submit(); h.render();
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].event, "show");
  assert.equal(h.notices[0].surface, "bookmarks.group-name-validation");
  assert.equal(h.notices[0].messageKey, "groupNameRequired");
  assert.equal(h.notices[0].reasonCode, "VALIDATION_ERROR");
  h.input("private corrected bookmark name");
  assert.equal(h.notices.length, 2);
  assert.equal(h.notices[1].event, "clear");
  assert.equal(h.notices[1].clearReasonCode, "NAME_EDITED");
  assert.equal(JSON.stringify(h.notices).includes("private corrected bookmark name"), false);
  h.input("　"); h.submit(); h.click("[data-cancel-bookmark-new-group]");
  assert.equal(h.notices.at(-1).clearReasonCode, "FORM_CANCELLED");
  h.openRename(); h.input(""); h.submit(); h.view.reset();
  assert.equal(h.notices.at(-1).clearReasonCode, "VIEW_RESET");
});

for (const answer of [false, true]) {
  test("bookmark delete waits for explicit " + (answer ? "acceptance" : "cancellation") + " and retains its captured target", async () => {
    const h = harness(); openDelete(h);
    assert.equal(h.actions.length, 0);
    assert.equal(h.confirmations.length, 1);
    assert.equal(h.confirmations[0].owner === h.root, true);
    assert.equal(h.confirmations[0].title, "deleteGroup");
    assert.equal(h.confirmations[0].confirmLabel, "deleteGroup");
    assert.equal(h.confirmations[0].cancelLabel, "cancel");
    h.render(); h.answerConfirmation(answer); await settle();
    assert.equal(h.actions.length, answer ? 1 : 0);
    if (answer) {
      assert.equal(h.actions[0].type, "group-delete");
      assert.equal(h.actions[0].payload.groupId, "bookmark-quote");
    }
  });
}

for (const name of ["leave", "reset", "hidden", "renamed", "deleted"]) {
  for (const resolvedFirst of [false, true]) {
    test("bookmark " + (resolvedFirst ? "already-accepted" : "pending") + " confirmation is inert after " + name, async () => {
      const h = harness(); openDelete(h);
      if (resolvedFirst) h.answerConfirmation(true);
      boundary(h, name);
      if (!resolvedFirst) h.answerConfirmation(true);
      await settle(); h.flush();
      assert.equal(h.actions.length, 0, "retired confirmation never turns into a delete request");
    });
  }
}

test("bookmark dispose cancels an already-accepted confirmation without disposing the injected shared service", async () => {
  const h = harness(); openDelete(h); h.answerConfirmation(true);
  // The injected port intentionally has no dispose(): a view owns only its
  // pending request, never the panel-wide confirmation service.
  h.view.dispose(); await settle(); h.flush();
  assert.equal(h.actions.length, 0);
  assert.equal(h.root.childNodes.length, 0);
});

test("bookmark dispose invalidates the queued Escape focus callback", () => {
  const h = harness(); h.click(groupMenu);
  h.event("keydown", h.root.querySelector("[data-bookmark-group-action]"), { key: "Escape" });
  h.view.dispose(); h.flush();
  assert.equal(h.document.activeElement === undefined, true);
  assert.equal(h.root.childNodes.length, 0);
  assert.equal(h.actions.length, 0);
});

test("bookmark disposed view ignores later renders and repeated disposal", () => {
  const h = harness(); h.click("[data-open-bookmark-new-group]"); h.input("private retired draft");
  h.view.dispose(); h.view.dispose(); h.render(); h.flush();
  assert.equal(h.root.childNodes.length, 0, "disposed views cannot revive private editors or cached models");
  assert.equal(h.actions.length, 0);
});

test("bookmark shared entry menu keeps move, remove and open payloads independent", () => {
  const h = harness(); h.seedBookmarks(); const saved = JSON.stringify(h.model.store);
  h.click(entryMenu);
  assert.equal(h.actions.length, 0, "opening the menu does not open the conversation");
  const current = h.root.querySelector('[data-library-move-group="bookmark-quote"]');
  assert.ok(current); assert.equal(current.disabled, true);
  h.event("click", current); h.flush();
  assert.equal(h.actions.length, 0);
  if (!h.root.querySelector("[data-bookmark-entry-overlay]")) h.click(entryMenu);
  h.click('[data-library-move-group="bookmark-insight"]');
  assert.equal(h.actions[0].type, "move"); assert.equal(h.actions[0].payload.bookmarkId, "conversation-a::bookmark-a");
  assert.equal(h.actions[0].payload.groupId, "bookmark-insight");
  absent(h, "[data-bookmark-entry-overlay]");
  h.click(entryMenu); h.click('[data-library-move-group="ungrouped"]');
  assert.equal(h.actions[1].type, "move"); assert.equal(h.actions[1].payload.bookmarkId, "conversation-a::bookmark-a");
  assert.equal(h.actions[1].payload.groupId, null, "the shared UI sends the domain's canonical ungrouped value, never its button sentinel");
  h.click(entryMenu); h.click("[data-library-remove]");
  assert.equal(h.actions[2].type, "remove"); assert.equal(h.actions[2].payload.bookmarkId, "conversation-a::bookmark-a");
  h.click('[data-bookmark-jump="conversation-a::bookmark-b"]');
  assert.equal(h.actions[3].type, "open"); assert.equal(h.actions[3].payload.bookmarkId, "conversation-a::bookmark-b");
  assert.equal(h.actions.length, 4);
  assert.equal(JSON.stringify(h.model.store), saved, "presentation does not mutate source records before owner acceptance");
});

test("bookmark stale entry controls cannot submit twice or target a replacement item", () => {
  const h = harness(); h.seedBookmarks(); h.click(entryMenu);
  const stale = h.root.querySelector('[data-library-move-group="bookmark-insight"]');
  assert.ok(stale);
  h.event("click", stale); h.event("click", stale); h.flush();
  assert.equal(h.actions.length, 1);
  h.click(entryMenu); const staleRemove = h.root.querySelector("[data-library-remove]");
  h.render({ store: { ...h.model.store, items: { "conversation-a::bookmark-b": h.model.store.items["conversation-a::bookmark-b"] } } });
  absent(h, "[data-bookmark-entry-overlay]");
  h.event("click", staleRemove); h.flush();
  assert.equal(h.actions.length, 1);
});

test("bookmark export selection closes its move menu and renders no item management controls", () => {
  const h = harness(); h.seedBookmarks(); h.click(entryMenu);
  h.render({ exportSelection: { active: true, draftIds: [], basketBookmarkIds: [] } });
  absent(h, "[data-bookmark-entry-menu]"); absent(h, "[data-bookmark-entry-overlay]");
  absent(h, "[data-library-move-group]"); absent(h, "[data-library-remove]");
  assert.equal(h.root.querySelectorAll("[data-export-draft-bookmark]").length, 2);
});

test("bookmark overlay closes when a keyboard page change removes its source row from view", () => {
  const h = harness(); h.seedBookmarks();
  const original = h.model.store.items["conversation-a::bookmark-a"], items = {};
  for (let index = 0; index < 8; index++) {
    const bookmarkId = "conversation-a::message-" + index;
    items[bookmarkId] = { ...original, bookmarkId, messageId: "message-" + index };
  }
  h.render({ store: { ...h.model.store, items } });
  const opener = h.root.querySelector("[data-bookmark-entry-menu]"); h.event("click", opener); h.flush();
  assert.ok(h.root.querySelector("[data-bookmark-entry-overlay]"));
  const page = h.root.querySelector("[data-bookmark-page-input]"); page.value = "2";
  h.event("change", page); h.flush();
  absent(h, "[data-bookmark-entry-overlay]");
  assert.equal(h.actions.length, 0);
});

test("bookmark icon choice immediately closes a pending picker and rejects its retired button", () => {
  const h = harness(); h.click(groupMenu); h.click('[data-bookmark-group-action="icon"]');
  const choice = h.root.querySelector('[data-bookmark-group-icon="pin"]');
  assert.ok(choice);
  h.event("click", choice); h.flush();
  absent(h, "[data-bookmark-group-overlay]", "saving an icon cannot leave an unclosable old picker on screen");
  assert.equal(h.root.querySelector(groupMenu).getAttribute("aria-expanded"), "false");
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].type, "group-update");
  assert.equal(h.actions[0].payload.groupId, "bookmark-quote");
  assert.equal(h.actions[0].payload.patch.icon, "pin");
  h.event("click", choice); h.flush();
  assert.equal(h.actions.length, 1, "the same detached control cannot repeat a pending save");
});

test("bookmark keyboard entry activation focuses the first enabled menu item and Escape restores its opener", () => {
  const h = harness(); h.seedBookmarks();
  const item = h.model.store.items["conversation-a::bookmark-a"];
  h.render({ store: { ...h.model.store, items: { ...h.model.store.items, [item.bookmarkId]: { ...item, groupId: null } } } });
  const opener = h.root.querySelector(entryMenu); opener.focus();
  // Native button activation emits a zero-detail click after Enter; this
  // algorithm fixture supplies that browser event instead of navigating the row.
  h.event("keydown", opener, { key: "Enter" }); h.event("click", opener, { detail: 0 }); h.flush();
  assert.equal(h.actions.length, 0);
  assert.equal(h.root.querySelector('[data-library-move-group="ungrouped"]').disabled, true);
  const firstEnabled = h.root.querySelector('[data-library-move-group="bookmark-quote"]');
  assert.equal(h.document.activeElement === firstEnabled, true);
  h.event("keydown", firstEnabled, { key: "Escape" }); h.flush();
  absent(h, "[data-bookmark-entry-overlay]");
  assert.equal(h.document.activeElement === h.root.querySelector(entryMenu), true);
});
