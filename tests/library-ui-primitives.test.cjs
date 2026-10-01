const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createPanelRuntime } = require("./helpers/panel-runtime.cjs");

function eventHub(target = {}) {
  const handlers = new Map();
  target.addEventListener = (type, fn, capture = false) => {
    const key = type + ":" + Boolean(capture);
    const values = handlers.get(key) || [];
    values.push(fn); handlers.set(key, values);
  };
  target.removeEventListener = (type, fn, capture = false) => {
    const key = type + ":" + Boolean(capture);
    handlers.set(key, (handlers.get(key) || []).filter(value => value !== fn));
  };
  target.dispatch = (type, event, capture = false) => {
    for (const fn of handlers.get(type + ":" + Boolean(capture)) || []) fn(event);
  };
  return target;
}
function event(options = {}) {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...options };
}
function transientHarness() {
  const frames = [], document = eventHub({ hidden: false });
  const root = { ownerDocument: document, contains: node => node?.owner === root };
  const trigger = { owner: root, focus: options => { document.activeElement = trigger; document.focusOptions = options; } };
  let open = false, renders = 0, hidden = 0, inside = true;
  const runtime = createPanelRuntime({ requestAnimationFrame: fn => frames.push(fn) });
  const { createLibraryTransientUi } = runtime.load("src/platform/ui/library-transient-ui.js");
  const ui = createLibraryTransientUi({ root, getState: () => ({ open, findTrigger: () => trigger }), isInside: () => inside,
    close: () => { open = false; }, render: () => { renders++; }, onHidden: () => { hidden++; } });
  return { document, ui, trigger, frames, set open(v) { open = v; }, get open() { return open; }, set inside(v) { inside = v; }, get renders() { return renders; }, get hidden() { return hidden; }, flush() { while (frames.length) frames.shift()(); } };
}

test("shared transient lifecycle closes and returns to the actual trigger on Escape", () => {
  const h = transientHarness(); h.open = true;
  const e = event({ key: "Escape" }); h.document.dispatch("keydown", e); h.flush();
  assert.equal(h.open, false); assert.equal(h.renders, 1); assert.equal(e.defaultPrevented, true);
  assert.equal(h.document.activeElement, h.trigger); assert.equal(h.document.focusOptions.preventScroll, true);
});
test("shared transient Escape respects IME and an already handled key", () => {
  const h = transientHarness(); h.open = true;
  h.document.dispatch("keydown", event({ key: "Escape", isComposing: true }));
  h.document.dispatch("keydown", event({ key: "Escape", defaultPrevented: true }));
  assert.equal(h.open, true); assert.equal(h.renders, 0);
});
test("a menu-to-picker render cannot turn its detached old click into an outside click", () => {
  const h = transientHarness(); h.open = true; h.inside = true;
  const e = event(); h.document.dispatch("click", e, true);
  h.inside = false; h.document.dispatch("click", e);
  assert.equal(h.open, true); assert.equal(h.renders, 0);
});
test("outside clicks close without stealing the new control's focus", () => {
  const h = transientHarness(); h.open = true; h.inside = false;
  const nextControl = {}; h.document.activeElement = nextControl;
  const e = event(); h.document.dispatch("click", e, true); h.document.dispatch("click", e); h.flush();
  assert.equal(h.open, false); assert.equal(h.document.activeElement, nextControl);
});
test("lifecycle dismissal invalidates a queued focus even after the menu has closed", () => {
  const h = transientHarness(); h.open = true;
  h.ui.dismiss({ restoreFocus: true }); h.ui.dismiss(); h.flush();
  assert.equal(h.document.activeElement, undefined);
});
test("hidden document closes overlays and invokes owner cancellation without restoring focus", () => {
  const h = transientHarness(); h.open = true; h.document.hidden = true;
  h.document.dispatch("visibilitychange", event()); h.flush();
  assert.equal(h.open, false); assert.equal(h.hidden, 1); assert.equal(h.document.activeElement, undefined);
});
test("disposal removes shared listeners and invalidates delayed work", () => {
  const h = transientHarness(); h.open = true; h.ui.queueFocus(() => h.trigger);
  h.ui.dispose(); h.open = true; h.document.hidden = true;
  h.document.dispatch("visibilitychange", event()); h.document.dispatch("keydown", event({ key: "Escape" })); h.flush();
  assert.equal(h.open, true); assert.equal(h.hidden, 0); assert.equal(h.document.activeElement, undefined);
});

function editorHarness() {
  const events = [];
  const { createGroupNameEditor } = createPanelRuntime().load("src/platform/ui/group-name-editor.js");
  return { editor: createGroupNameEditor({ id: "test-name", onValidation: (required, reason) => events.push({ required, reason }) }), events };
}
for (const value of ["", "   ", "　　", "\t\n"]) {
  test("shared group editor rejects blank " + JSON.stringify(value) + " without changing the draft", () => {
    const { editor, events } = editorHarness(); editor.open({ groupId: "g", value: "Original" });
    assert.equal(editor.validate(value), null); assert.equal(editor.state.value, value); assert.equal(editor.state.groupId, "g");
    editor.validate(value); assert.equal(events.length, 1); assert.equal(events[0].required, true);
    assert.match(editor.inputMarkup({ label: "Name" }), /aria-invalid="true" aria-describedby="test-name-error"/);
    assert.match(editor.errorMarkup({ message: "Required" }), /id="test-name-error" role="alert">Required/);
  });
}
test("shared editor trims only submission and escapes value, label and hint markup", () => {
  const { editor } = editorHarness(); editor.open({ value: '<img src="x">' });
  assert.match(editor.inputMarkup({ label: '"Name"' }), /value="&lt;img src=&quot;x&quot;&gt;"/);
  assert.equal(editor.validate("  Work  "), "Work"); assert.equal(editor.state.value, "  Work  ");
  editor.validate(""); assert.match(editor.errorMarkup({ message: "<script>" }), /&lt;script&gt;/);
});
test("correcting a name removes only associated error attributes/node, keeping IME input intact", () => {
  const { editor, events } = editorHarness(); editor.open({ value: "" }); editor.validate("");
  const removed = [], error = { remove: () => removed.push("error") };
  const input = { value: "名字", removeAttribute: key => removed.push(key), closest: () => ({ querySelector: () => error }) };
  editor.updateInput(input);
  assert.equal(editor.state.value, "名字"); assert.equal(editor.state.required, false);
  assert.deepEqual(removed, ["aria-invalid", "aria-describedby", "error"]);
  assert.equal(events.at(-1).reason, "NAME_EDITED");
});
test("replacing or resetting editor state clears validation without retaining private names", () => {
  const { editor, events } = editorHarness(); editor.open({ value: "Private" }); editor.validate("");
  editor.open({ value: "New" }); assert.equal(events.at(-1).reason, "FORM_REPLACED");
  editor.validate(""); editor.close("VIEW_RESET"); assert.equal(events.at(-1).reason, "VIEW_RESET");
  assert.equal(editor.state, null); assert.equal(editor.inputMarkup({ label: "Name" }), "");
});
function revealHarness({ top = 180, bottom = 234, contained = true } = {}) {
  const { editor } = editorHarness(); editor.open({ value: "" }); editor.validate("");
  const form = { getBoundingClientRect: () => ({ top, bottom }) };
  let focusOptions;
  const input = { closest: () => form, focus: options => { focusOptions = options; } };
  const viewport = { scrollTop: 120, clientTop: 0, clientHeight: 200, contains: () => contained, getBoundingClientRect: () => ({ top: 0, bottom: 200 }) };
  const root = { querySelector: () => input };
  editor.revealInvalid({ root, viewport });
  return { viewport, focusOptions };
}
test("invalid rename reveals the full row including bottom hint by scrolling only its viewport", () => {
  const h = revealHarness(); assert.equal(h.viewport.scrollTop, 158); assert.equal(h.focusOptions.preventScroll, true);
});
test("already visible validation does not move the viewport", () => {
  const h = revealHarness({ top: 100, bottom: 155 }); assert.equal(h.viewport.scrollTop, 120);
});
test("create feedback outside group viewport cannot move unrelated groups", () => {
  const h = revealHarness({ contained: false }); assert.equal(h.viewport.scrollTop, 120);
});

function confirmationHarness() {
  const frames = [], closedEvents = [], created = [];
  const document = { hidden: false };
  document.createElement = name => {
    const node = eventHub({ name, dataset: {}, childNodes: [], attributes: {}, textContent: "", isConnected: false,
      setAttribute(key, value) { this.attributes[key] = value; },
      append(...nodes) { this.childNodes.push(...nodes); for (const node of nodes) { node.parentNode = this; node.isConnected = this.isConnected; } },
      focus(options) { document.activeElement = this; this.focusOptions = options; },
      remove() { this.isConnected = false; },
      showModal() { this.open = true; this.modal = true; },
      close() { this.open = false; closedEvents.push(() => this.dispatch("close", event())); },
    });
    created.push(node); return node;
  };
  document.body = document.createElement("body"); document.body.isConnected = true;
  const ownerA = { contains: node => node.owner === ownerA }, ownerB = { contains: node => node.owner === ownerB };
  const trigger = { owner: ownerA, isConnected: true, focus: () => { document.activeElement = trigger; } };
  const runtime = createPanelRuntime({ requestAnimationFrame: fn => frames.push(fn) });
  const { createPanelConfirmation } = runtime.load("src/platform/ui/panel-confirmation.js");
  const ui = createPanelConfirmation({ document });
  function ask(patch = {}) { return ui.ask({ owner: ownerA, title: "Delete group", message: '<secret & group>', confirmLabel: "Delete", cancelLabel: "Cancel", returnFocus: () => trigger, ...patch }); }
  const find = key => created.find(node => Object.hasOwn(node.dataset, key));
  return { ui, document, created, ownerA, ownerB, trigger, ask, get dialog() { return created.find(node => node.name === "dialog"); }, get cancel() { return find("panelConfirmationCancel"); }, get accept() { return find("panelConfirmationAccept"); }, flush() { while (frames.length) frames.shift()(); }, closeEvents() { while (closedEvents.length) closedEvents.shift()(); } };
}
test("panel confirmation is lazy, stable outside view roots, and defaults to cancel", async () => {
  const h = confirmationHarness(); assert.equal(h.dialog, undefined);
  const answer = h.ask(); assert.equal(h.dialog.parentNode, h.document.body); assert.equal(h.dialog.open, true);
  assert.equal(h.document.activeElement, h.cancel); assert.equal(h.dialog.childNodes[1].textContent, '<secret & group>');
  assert.equal(h.dialog.attributes["aria-describedby"], h.dialog.childNodes[1].id);
  h.cancel.dispatch("click", event()); assert.equal(await answer, false); h.flush();
  assert.equal(h.document.activeElement, h.trigger); assert.equal(h.dialog.childNodes[1].textContent, "");
});
test("Escape cancels native dialog and resolves without acceptance", async () => {
  const h = confirmationHarness(); const answer = h.ask(); const e = event(); h.dialog.dispatch("cancel", e);
  assert.equal(e.defaultPrevented, true); assert.equal(await answer, false); assert.equal(h.dialog.open, false);
});
test("accept is single-shot and stale duplicate clicks cannot create another acceptance", async () => {
  const h = confirmationHarness(); const answer = h.ask(); h.accept.dispatch("click", event()); h.accept.dispatch("click", event());
  assert.equal(await answer, true); assert.equal(h.dialog.open, false);
});
test("owner cancellation affects only its own pending request", async () => {
  const h = confirmationHarness(); const answer = h.ask();
  assert.equal(h.ui.cancel({ owner: h.ownerB }), false); assert.equal(h.dialog.open, true);
  assert.equal(h.ui.cancel({ owner: h.ownerA }), true); assert.equal(await answer, false); h.flush();
  assert.notEqual(h.document.activeElement, h.trigger);
});
test("leaving after resolve fences that owner's delayed focus", async () => {
  const h = confirmationHarness(); const answer = h.ask(); h.accept.dispatch("click", event());
  assert.equal(await answer, true); h.ui.cancel({ owner: h.ownerA }); h.flush();
  assert.notEqual(h.document.activeElement, h.trigger);
});
test("new ask supersedes old owner and an asynchronous old close cannot cancel the new dialog", async () => {
  const h = confirmationHarness(); const first = h.ask(); const second = h.ask({ owner: h.ownerB });
  assert.equal(await first, false); h.closeEvents(); assert.equal(h.dialog.open, true);
  h.accept.dispatch("click", event()); assert.equal(await second, true);
});
test("dispose cancels pending confirmation, removes host and prevents future dialogs", async () => {
  const h = confirmationHarness(); const answer = h.ask(); h.ui.dispose();
  assert.equal(await answer, false); assert.equal(h.dialog.isConnected, false); assert.equal(await h.ask(), false);
});

test("entry menu uses one escaped markup and identifies current group without exposing item data", () => {
  const { libraryEntryMenuMarkup } = createPanelRuntime().load("src/platform/ui/library-entry-menu.js");
  const html = libraryEntryMenuMarkup({ heading: "Move", groups: [{ id: "ungrouped", label: "Ungrouped", current: false }, { id: 'g"1', label: "<Private>", current: true }], removeLabel: "Remove" });
  assert.match(html, /data-library-move-group="ungrouped"/);
  assert.match(html, /data-library-move-group="g&quot;1" role="menuitemradio" aria-checked="true" class="is-current" disabled/);
  assert.match(html, /&lt;Private&gt;/); assert.match(html, /data-library-remove/); assert.doesNotMatch(html, /bookmarkId|conversationId/);
});


test("feedback reveal is consumed once and correction cancels a queued reveal", () => {
  const { editor } = editorHarness(); editor.open({ value: "" }); editor.validate("");
  let focused = 0;
  const input = { value: "", focus() { focused++; }, closest: () => ({ querySelector: () => null }), removeAttribute() {} };
  const root = { querySelector: () => input };
  editor.revealInvalid({ root }); editor.revealInvalid({ root });
  assert.equal(focused, 1, "snapshots cannot refocus an already revealed error");
  editor.validate(""); input.value = "Fixed"; editor.updateInput(input); editor.revealInvalid({ root });
  assert.equal(focused, 1, "editing before the frame cancels error focus");
  editor.validate(""); editor.revealInvalid({ root }); assert.equal(focused, 2, "another explicit invalid submission can reveal again");
});
test("dialog Escape keydown cancels before underlying route handlers and respects IME", async () => {
  const h = confirmationHarness(); const answer = h.ask();
  h.dialog.dispatch("keydown", event({ key: "Escape", isComposing: true }));
  h.dialog.dispatch("keydown", event({ key: "Escape", defaultPrevented: true }));
  assert.equal(h.dialog.open, true);
  const e = event({ key: "Escape" }); h.dialog.dispatch("keydown", e);
  assert.equal(e.defaultPrevented, true); assert.equal(e.stopped, true); assert.equal(await answer, false);
});
test("old owner cannot cancel the replacing owner's dialog or restore stale focus", async () => {
  const h = confirmationHarness(); const first = h.ask(); const second = h.ask({ owner: h.ownerB });
  assert.equal(await first, false); assert.equal(h.ui.cancel({ owner: h.ownerA }), false);
  h.closeEvents(); h.flush(); assert.equal(h.dialog.open, true); assert.equal(h.document.activeElement, h.cancel);
  h.ui.cancel({ owner: h.ownerB }); assert.equal(await second, false);
});
function positionHarness({ rect, overlayWidth = 144, overlayHeight = 160, groups = null } = {}) {
  const { positionLibraryOverlay } = createPanelRuntime().load("src/platform/ui/library-overlay-position.js");
  const layer = { getBoundingClientRect: () => ({ left: 10, right: 280, top: 20, bottom: 520, width: 270, height: 500 }) };
  const anchor = { getBoundingClientRect: () => rect || ({ top: 50, bottom: 78, right: 276 }) };
  const overlay = { style: {}, offsetWidth: overlayWidth, offsetHeight: overlayHeight, scrollHeight: overlayHeight, querySelector: () => groups };
  positionLibraryOverlay({ layer, overlay, anchor });
  return overlay;
}
test("shared popup aligns to its trigger when enough space exists below", () => {
  const overlay = positionHarness(); assert.equal(overlay.style.top, "62px"); assert.equal(overlay.style.left, "122px");
  assert.equal(overlay.style.maxWidth, "262px"); assert.equal(overlay.style.maxHeight, "492px");
});
test("shared popup flips above a bottom trigger without crossing the visible column", () => {
  const overlay = positionHarness({ rect: { top: 460, bottom: 488, right: 276 } });
  assert.equal(overlay.style.top, "276px");
});
test("oversized popup is constrained in both dimensions and scrolls within its own layer", () => {
  const overlay = positionHarness({ overlayWidth: 700, overlayHeight: 800, rect: { top: 80, bottom: 108, right: 700 } });
  assert.equal(overlay.style.left, "4px"); assert.equal(overlay.style.top, "4px"); assert.equal(overlay.style.overflowY, "auto");
});
test("long entry menu reserves room for the heading and remove action while limiting groups", () => {
  const groups = { style: {}, offsetHeight: 480 };
  positionHarness({ overlayHeight: 570, groups });
  assert.equal(groups.style.maxHeight, "402px");
});
