const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createLibraryViewHarness: harness } = require("./helpers/library-view-harness.cjs");

for (const picker of [false, true]) {
  test(`switching group closes ${picker ? "icon picker" : "menu"} before the pending view save`, () => {
    const h = harness();
    h.click('[data-group-menu="study"]');
    if (picker) h.click('[data-group-action="icon"]');
    assert.ok(h.root.querySelector("[data-group-overlay]"));
    h.click('[data-select-group="work"]');
    assert.equal(h.root.querySelector("[data-group-overlay]") === null, true, "[data-group-overlay] is absent");
    assert.equal(h.actions.length, 1);
    assert.equal(h.actions[0].type, "view-update");
    assert.equal(h.actions[0].payload.groupId, "work");
    assert.equal(h.root.querySelector('[data-group-menu="study"]').getAttribute("aria-expanded"), "false");
  });
  test(`Escape closes ${picker ? "icon picker" : "menu"} and restores the exact trigger`, () => {
    const h = harness(); h.click('[data-group-menu="study"]');
    if (picker) h.click('[data-group-action="icon"]');
    const target = h.root.querySelector(picker ? "[data-group-icon]" : "[data-group-action]");
    const event = h.event("keydown", target, { key: "Escape" }); h.flush();
    assert.equal(event.defaultPrevented, true);
    assert.equal(h.root.querySelector("[data-group-overlay]") === null, true, "[data-group-overlay] is absent");
    assert.equal(h.document.activeElement === h.root.querySelector('[data-group-menu="study"]'), true, "focus returns to the exact group trigger");
    assert.equal(h.actions.length, 0);
  });
}

test("external click and the explicit column lifecycle hook close without stealing focus", () => {
  const h = harness(); h.click('[data-group-menu="study"]');
  const outside = { nodeType: 1, childNodes: [], matches: () => false, closest: () => null, getAttribute: () => null, hasAttribute: () => false };
  h.document.activeElement = outside;
  h.event("click", outside); h.flush();
  assert.equal(h.root.querySelector("[data-group-overlay]") === null, true, "[data-group-overlay] is absent");
  assert.equal(h.document.activeElement === outside, true, "outside focus is unchanged");
  h.click('[data-group-menu="work"]'); h.view.dismissTransientUi(); h.flush();
  assert.equal(h.root.querySelector("[data-group-overlay]") === null, true, "[data-group-overlay] is absent");
  h.render(); assert.equal(h.root.querySelector("[data-group-overlay]") === null, true, "[data-group-overlay] is absent");
});

test("programmatic group switch closes an existing overlay; same-group refresh retains it", () => {
  const h = harness(); h.click('[data-group-menu="study"]'); h.render();
  assert.ok(h.root.querySelector("[data-group-overlay]"));
  h.render({ store: { ...h.model.store, view: { ...h.model.store.view, groupId: "work" } } });
  assert.equal(h.root.querySelector("[data-group-overlay]") === null, true, "[data-group-overlay] is absent");
});

test("a detached old menu cannot target a group after switching context", () => {
  const h = harness(); h.click('[data-group-menu="study"]');
  const stale = h.root.querySelector('[data-group-action="delete"]');
  h.click('[data-select-group="work"]');
  h.event("click", stale); h.flush();
  assert.equal(h.actions.length, 1, "only the intended view change is dispatched");
});

for (const mode of ["create", "rename"]) {
  for (const value of ["", "   ", "　　"]) {
    test(`${mode} rejects ${JSON.stringify(value)} inline without dispatch or draft loss`, () => {
      const h = harness();
      if (mode === "create") h.click("[data-open-new-group]"); else h.openRename();
      const input = h.input(value), form = input.closest("form");
      assert.equal(form.hasAttribute("novalidate"), true);
      h.submit();
      assert.equal(h.actions.length, 0);
      assert.equal(h.root.querySelector('[name="name"]') === input, true, "editing keeps its native input");
      assert.equal(input.value, value);
      assert.equal(input.getAttribute("aria-invalid"), "true");
      const error = h.root.querySelector("[data-group-name-error]");
      assert.ok(error);
      assert.equal(input.getAttribute("aria-describedby"), error.getAttribute("id"));
      h.render({ t: key => `translated:${key}` });
      assert.equal(input.value, value, "translation and snapshots cannot reinsert the default name");
      h.input("  New Name  ");
      assert.equal(h.root.querySelector("[data-group-name-error]") === null, true, "[data-group-name-error] is absent");
      assert.equal(input.getAttribute("aria-invalid"), null);
      h.submit();
      assert.equal(h.actions.length, 1);
      assert.equal(h.actions[0].type, mode === "create" ? "group-create" : "group-update");
      assert.equal(mode === "create" ? h.actions[0].payload.name : h.actions[0].payload.patch.name, "New Name");
      if (mode === "rename") assert.equal(h.actions[0].payload.groupId, "study");
    });
  }
  test(`${mode} keeps an in-progress name across translation and source title changes`, () => {
    const h = harness(); if (mode === "create") h.click("[data-open-new-group]"); else h.openRename();
    const input = h.input("unfinished draft");
    h.render({ t: key => `ja:${key}`, store: { ...h.model.store, groups: h.model.store.groups.map(group => ({ ...group, name: "remote name" })) } });
    assert.equal(h.root.querySelector('[name="name"]') === input, true, "draft input identity survives rendering");
    assert.equal(input.value, "unfinished draft");
  });
}

test("reset revokes queued focus and private drafts before another account can render", () => {
  const h = harness();
  h.event("click", h.root.querySelector("[data-open-new-group]"));
  h.input("private draft");
  h.view.reset();
  h.render();
  assert.equal(h.root.querySelector("[data-new-group]") === null, true, "[data-new-group] is absent");
  assert.equal(h.root.querySelector("[data-group-overlay]") === null, true, "[data-group-overlay] is absent");
  assert.equal(h.document.activeElement === undefined, true, "reset cancels stale focus");
});

test("a later overlay cannot receive an earlier Escape focus callback", () => {
  const h = harness(); h.click('[data-group-menu="study"]');
  h.event("keydown", h.root.querySelector("[data-group-action]"), { key: "Escape" });
  h.event("click", h.root.querySelector('[data-group-menu="work"]'));
  h.flush();
  assert.equal(h.root.querySelector("[data-group-overlay]").dataset.groupOverlay, "work");
  assert.equal(h.document.activeElement === h.root.querySelector('[data-group-menu="study"]'), false, "stale focus cannot reach the former trigger");
});


test("name validation reports one show and the explicit clear reason without private drafts", () => {
  const h = harness(); h.click("[data-open-new-group]"); h.input("   "); h.submit(); h.submit(); h.render();
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].event, "show");
  assert.equal(h.notices[0].reasonCode, "VALIDATION_ERROR");
  assert.equal(h.notices[0].messageKey, "groupNameRequired");
  const input = h.input("private corrected draft");
  assert.equal(h.notices.length, 2);
  assert.equal(h.notices[1].event, "clear");
  assert.equal(h.notices[1].clearReasonCode, "NAME_EDITED");
  assert.equal(input.value, "private corrected draft");
  assert.equal(JSON.stringify(h.notices).includes("private corrected draft"), false);
  h.input("　"); h.submit(); h.click("[data-cancel-new-group]");
  assert.equal(h.notices.at(-1).clearReasonCode, "FORM_CANCELLED");
  h.openRename(); h.input(""); h.submit(); h.view.reset();
  assert.equal(h.notices.at(-1).clearReasonCode, "VIEW_RESET");
});

test("hidden document dismisses overlays while preserving the current name draft", () => {
  const h = harness(); h.click("[data-open-new-group]"); h.input("kept draft");
  h.click('[data-group-menu="study"]');
  h.document.hidden = true; h.event("visibilitychange", h.root); h.flush();
  assert.equal(h.root.querySelector("[data-group-overlay]") === null, true, "[data-group-overlay] is absent");
  assert.equal(h.root.querySelector('[name="name"]').value, "kept draft");
});


test("IME Escape cancels its candidate rather than stealing editor focus for a menu", () => {
  const h = harness(); h.openRename(); const input = h.input("中文候选");
  h.click('[data-group-menu="work"]'); input.focus();
  const event = h.event("keydown", input, { key: "Escape", isComposing: true }); h.flush();
  assert.equal(event.defaultPrevented, undefined);
  assert.equal(h.document.activeElement === input, true, "IME keeps editor focus");
  assert.equal(h.root.querySelector("[data-group-overlay]").dataset.groupOverlay, "work");
});


for (const mode of ["create", "rename"]) {
  test(`${mode} pending save consumes a repeated native submit without a duplicate request`, () => {
    const h = harness(); if (mode === "create") h.click("[data-open-new-group]"); else h.openRename();
    h.input("accepted draft"); h.submit();
    const form = h.root.querySelector("[data-new-group], [data-group-rename]");
    assert.ok(form, "the deferred action has not rerendered the saved editor yet");
    const event = h.event("submit", form);
    assert.equal(event.defaultPrevented, true);
    assert.equal(h.actions.length, 1);
  });
}

test("retired input events cannot overwrite a newer group editor", () => {
  const h = harness(); h.click("[data-open-new-group]"); const retired = h.input("retired private draft");
  h.click("[data-cancel-new-group]"); h.openRename(); h.input("current draft");
  retired.value = "stale change"; h.event("input", retired); h.render();
  assert.equal(h.root.querySelector('[name="name"]').value, "current draft");
});


test("favorite row separates navigation, bookmark count and keyboard-reachable management", () => {
  const h = harness(); h.seedFavorites();
  const open = h.root.querySelector('[data-open-favorite="favorite-a"]');
  const menu = h.root.querySelector('[data-favorite-menu="favorite-a"]');
  assert.ok(menu); assert.equal(menu.nodeName, "BUTTON");
  assert.equal(open.contains(menu), false, "management is not a nested button inside navigation");
  assert.ok(open.querySelector(".favorite-bookmark-stat"));
  h.click('[data-favorite-menu="favorite-a"]');
  assert.equal(h.actions.length, 0, "opening management must not navigate");
  assert.ok(h.root.querySelector('[data-favorite-entry-overlay="favorite-a"]'));
  h.click('[data-open-favorite="favorite-b"]');
  assert.equal(h.actions.length, 1); assert.equal(h.actions[0].type, "open");
  assert.equal(h.actions[0].payload.conversationId, "favorite-b");
  assert.equal(h.root.querySelector("[data-favorite-entry-overlay]") === null, true);
});

test("favorite move dispatches the existing move command once, with no toggle or removal", () => {
  const h = harness(); h.seedFavorites(); h.click('[data-favorite-menu="favorite-a"]');
  const current = h.root.querySelector('[data-library-move-group="study"]');
  assert.equal(current.disabled, true, "the current destination is unavailable");
  h.click('[data-library-move-group="study"]');
  assert.equal(h.actions.length, 0, "even a synthetic click cannot write the current destination");
  h.click('[data-library-move-group="work"]');
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].type, "move");
  assert.equal(h.actions[0].payload.conversationId, "favorite-a");
  assert.equal(h.actions[0].payload.groupId, "work");
  assert.equal(h.root.querySelector("[data-favorite-entry-overlay]") === null, true);
});

test("favorite move to ungrouped and remove keep their exact independent contracts", () => {
  const h = harness(); h.seedFavorites(); h.click('[data-favorite-menu="favorite-a"]');
  h.click('[data-library-move-group="ungrouped"]');
  assert.equal(h.actions[0].type, "move"); assert.equal(h.actions[0].payload.groupId, null);
  assert.equal(h.actions[0].payload.conversationId, "favorite-a");
  h.click('[data-favorite-menu="favorite-b"]'); h.click('[data-library-remove]');
  assert.equal(h.actions[1].type, "remove"); assert.equal(h.actions[1].payload.conversationId, "favorite-b");
});

test("favorite entry menu shares Escape, column leave and reset dismissal with group menus", () => {
  const h = harness(); h.seedFavorites(); h.click('[data-favorite-menu="favorite-a"]');
  h.event("keydown", h.root.querySelector('[data-library-move-group="work"]'), { key: "Escape" }); h.flush();
  assert.equal(h.root.querySelector("[data-favorite-entry-overlay]") === null, true);
  assert.equal(h.document.activeElement === h.root.querySelector('[data-favorite-menu="favorite-a"]'), true);
  h.click('[data-favorite-menu="favorite-a"]'); h.view.dismissTransientUi(); h.flush(); h.render();
  assert.equal(h.root.querySelector("[data-favorite-entry-overlay]") === null, true);
  h.click('[data-favorite-menu="favorite-a"]'); h.view.reset(); h.render();
  assert.equal(h.root.querySelector("[data-favorite-entry-overlay]") === null, true);
});

test("favorite move menu is invalidated by view changes or removal, and retired actions do not dispatch", () => {
  const h = harness(); h.seedFavorites(); h.click('[data-favorite-menu="favorite-a"]');
  const stale = h.root.querySelector('[data-library-move-group="work"]');
  h.click('[data-select-group="work"]'); h.event("click", stale); h.flush();
  assert.equal(h.actions.length, 1, "only view selection is accepted");
  h.click('[data-favorite-menu="favorite-a"]');
  h.render({ store: { ...h.model.store, items: {} } });
  assert.equal(h.root.querySelector("[data-favorite-entry-overlay]") === null, true);
});

test("export selection omits favorite management and closes an existing move menu", () => {
  const h = harness(); h.seedFavorites(); h.click('[data-favorite-menu="favorite-a"]');
  h.render({ exportSelection: { active: true, draftIds: [], basketConversationSources: {} } });
  assert.equal(h.root.querySelector("[data-favorite-menu]") === null, true);
  assert.equal(h.root.querySelector("[data-favorite-entry-overlay]") === null, true);
  assert.equal(h.root.querySelectorAll("[data-export-draft-conversation]").length, 2);
});


for (const answer of [false, true]) {
  test(`favorite group deletion requires explicit ${answer ? "acceptance" : "cancel"} and preserves the captured target`, async () => {
    const h = harness(); h.click('[data-group-menu="study"]'); h.click('[data-group-action="delete"]');
    assert.equal(h.actions.length, 0, "opening a confirmation cannot write");
    assert.equal(h.confirmations.length, 1);
    assert.equal(h.confirmations[0].confirmLabel, "deleteGroup");
    assert.equal(h.confirmations[0].owner === h.root, true);
    h.render(); h.answerConfirmation(answer); await new Promise(setImmediate);
    assert.equal(h.actions.length, answer ? 1 : 0);
    if (answer) { assert.equal(h.actions[0].type, "group-delete"); assert.equal(h.actions[0].payload.groupId, "study"); }
  });
}

for (const boundary of ["leave", "reset", "hidden", "renamed", "deleted"]) {
  test(`favorite group confirmation is cancelled across ${boundary} boundary`, async () => {
    const h = harness(); h.click('[data-group-menu="study"]'); h.click('[data-group-action="delete"]');
    if (boundary === "leave") h.view.dismissTransientUi();
    if (boundary === "reset") { h.view.reset(); h.render(); }
    if (boundary === "hidden") { h.document.hidden = true; h.event("visibilitychange", h.root); }
    if (boundary === "renamed") h.render({ store: { ...h.model.store, groups: h.model.store.groups.map(group => group.id === "study" ? { ...group, name: "updated name" } : group) } });
    if (boundary === "deleted") h.render({ store: { ...h.model.store, groups: h.model.store.groups.filter(group => group.id !== "study") } });
    h.answerConfirmation(true); await new Promise(setImmediate);
    assert.equal(h.actions.length, 0, "retired confirmation never becomes a delete request");
  });
}

test("a favorite action retired by the first move cannot submit twice", () => {
  const h = harness(); h.seedFavorites(); h.click('[data-favorite-menu="favorite-a"]');
  const move = h.root.querySelector('[data-library-move-group="work"]');
  h.event("click", move); h.event("click", move); h.flush();
  assert.equal(h.actions.length, 1); assert.equal(h.actions[0].type, "move");
});

test("favorite management never follows an invalidated target into another entry", () => {
  const h = harness(); h.seedFavorites(); h.click('[data-favorite-menu="favorite-a"]');
  h.render({ store: { ...h.model.store, items: { "favorite-b": h.model.store.items["favorite-b"] } } });
  assert.equal(h.root.querySelector("[data-favorite-entry-overlay]") === null, true);
  assert.equal(h.actions.length, 0);
});


test("bottom-row name validation reveals only its own group scroll area and remembers the adjusted position", () => {
  const h = harness(); h.openRename(); h.input("   ");
  const viewport = h.root.querySelector("[data-group-list]");
  const results = h.root.querySelector('[data-results-viewport="favorites"]');
  const form = h.root.querySelector("[data-group-rename]");
  viewport.scrollTop = 91; results.scrollTop = 53;
  viewport.getBoundingClientRect = () => ({ top: 0, bottom: 220, left: 0, right: 280, width: 280 });
  form.getBoundingClientRect = () => ({ top: 205, bottom: 252, left: 0, right: 280, width: 280 });
  h.submit();
  assert.equal(viewport.scrollTop, 127, "the complete input plus error moves into the group viewport");
  assert.equal(results.scrollTop, 53, "conversation scrolling stays untouched");
  h.render();
  assert.equal(viewport.scrollTop, 127, "ordinary model renders must not restore the old clipped position");
  h.input("fixed");
  assert.equal(viewport.scrollTop, 127, "correcting a field never starts another scroll");
});


test("disposed favorites view cannot revive a private draft or pending confirmation", async () => {
  const h = harness(); h.click("[data-open-new-group]"); h.input("private abandoned draft");
  h.click('[data-group-menu="study"]'); h.click('[data-group-action="delete"]');
  h.view.dispose(); h.answerConfirmation(true); h.render(); await new Promise(setImmediate);
  assert.equal(h.root.childNodes.length, 0);
  assert.equal(h.actions.length, 0);
});


test("an intervening snapshot render cannot cancel a pending invalid-name reveal", () => {
  const h = harness(); h.openRename(); h.input("   ");
  const viewport = h.root.querySelector("[data-group-list]");
  const form = h.root.querySelector("[data-group-rename]");
  viewport.scrollTop = 91;
  viewport.getBoundingClientRect = () => ({ top: 0, bottom: 220, left: 0, right: 280, width: 280 });
  form.getBoundingClientRect = () => ({ top: 205, bottom: 252, left: 0, right: 280, width: 280 });
  h.event("submit", form);
  h.render({ t: key => "translated:" + key });
  assert.equal(viewport.scrollTop, 127);
});
