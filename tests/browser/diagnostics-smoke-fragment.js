
// Supplementary diagnostics host: production service/store/contract, in-memory chrome.storage.session.
// No fabricated ACK is returned. Every accepted record/read/clear comes from the actual worker handler.
const hostEvents = [], hostStorageKey = "tidy.diagnostics.session.v1";
let hostSaved = {}, hostWrites = 0, failNextHostWrite = false;
const hostChrome = {
  runtime: { id: "architecture-smoke", getURL: file => "chrome-extension://architecture-smoke/" + file },
  storage: { session: {
    async get(key) { return { [key]: clone(hostSaved[key]) }; },
    async set(patch) {
      if (failNextHostWrite) { failNextHostWrite = false; throw Error("Synthetic diagnostics storage failure"); }
      hostSaved = { ...hostSaved, ...clone(patch) }; hostWrites++;
    },
  } },
};
const hostSender = { id: hostChrome.runtime.id, url: hostChrome.runtime.getURL("app/sidepanel/index.html?tidyTabId=31"), frameId: 0, documentId: "architecture-smoke-document", documentLifecycle: "active" };
const hostService = createDiagnosticsService({ chrome: hostChrome });
const baseTransport = chrome.runtime.sendMessage.bind(chrome.runtime);
chrome.runtime.sendMessage = async envelope => {
  if (!hostService.matches(envelope)) return baseTransport(envelope);
  const result = await hostService.handle(envelope, hostSender);
  hostEvents.push({ operation: envelope.operation, request: clone(envelope), result: clone(result), writes: hostWrites });
  return result;
};
// Capture only the clipboard boundary so this sleeping user's system clipboard stays untouched.
// Actual button handler + exportText + real service snapshot + serialized payload are all exercised.
const clipboardTexts = [];
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { async writeText(text) { clipboardTexts.push(String(text)); } } });
const hostIdle = async () => {
  await until(() => globalThis.TidyDiagnosticsClient && TidyDiagnosticsClient.status().pending === 0 && TidyDiagnosticsClient.status().inFlight === 0, "Diagnostic producer did not drain");
  const status = TidyDiagnosticsClient.status();
  assert(status.recording && status.transportFailures === 0 && status.storageFailures === 0, "Diagnostic producer unhealthy");
};
const diagnosticStatusNode = () => document.querySelector("[data-diagnostics-status]");
const diagnosticStatus = () => diagnosticStatusNode().textContent;
let diagnosticOwner = null, healthyDocumentId = null;
const rendered = node => Boolean(node && !node.closest("[hidden], [inert]") && node.getClientRects().length
  && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
const clearOperations = () => hostEvents.filter(entry => entry.operation === "clear").length;
const diagnosticRoot = () => {
  const root = document.getElementById("settings-diagnostics"), settings = document.getElementById("settings-view");
  assert(root && root.parentElement === settings, "Log footer must stay directly inside settings view");
  assert(root.previousElementSibling === document.getElementById("settings-form"), "Log footer must follow, not nest in, settings form");
  assert(!root.closest("form"), "Log footer shares the blocked settings form");
  equal(document.querySelectorAll("#settings-diagnostics").length, 1, "Log footer has multiple owners");
  assert(!document.getElementById("connection-diagnostics"), "Retired public diagnostics host still exists");
  if (diagnosticOwner) equal(root, diagnosticOwner, "Route or session update replaced/moved the log owner");
  return root;
};
const routeOwnsLogs = route => {
  const root = diagnosticRoot();
  equal(rendered(root), route === "settings", "Logs may render only on settings: " + route);
  equal(document.querySelector(".time-panel__body").dataset.activeRoute, route, "Shell route did not switch");
  return { route, logsVisible: rendered(root), owner: root.parentElement.id };
};
const openClearConfirmation = () => {
  document.querySelector("[data-diagnostics-clear]").click();
  assert(rendered(document.querySelector("[data-diagnostics-confirm-clear]")), "Clear must show an inline confirmation");
  assert(rendered(document.querySelector("[data-diagnostics-cancel-clear]")), "Clear confirmation must provide a visible cancel button");
};
globalThis.ArchitectureDiagnosticsSmoke = Object.freeze({
  async ready() {
    await until(() => document.querySelector("[data-diagnostics-copy]"), "Diagnostics UI did not mount");
    await hostIdle();
    diagnosticOwner = diagnosticRoot(); healthyDocumentId = documentId;
    assert(diagnosticStatusNode().hidden && diagnosticStatus() === "", "Initial log status should be empty and hidden");
    assert(!rendered(document.querySelector("[data-diagnostics-confirm-clear]")), "Clear confirmation starts visible");
    assert(hostEvents.some(entry => entry.operation === "record" && entry.result.ok === true), "No actual diagnostics service handshake");
    assert(hostWrites > 0 && hostSaved[hostStorageKey], "Worker store never committed session state");
    return { realWorkerService: true, realSessionStore: true, storage: "isolated in-memory Chrome session adapter", clipboard: "isolated capture adapter", writes: hostWrites };
  },
  labels(language) {
    const t = createTranslator(language);
    equal(document.querySelector("[data-diagnostics-title]").textContent, t("diagnosticsTitle"), "Diagnostics heading translation");
    equal(document.querySelector("[data-diagnostics-scope]").textContent, t("diagnosticsScope"), "Log scope translation");
    equal(document.querySelector("[data-diagnostics-copy]").textContent, t("diagnosticsCopy"), "Copy button translation");
    equal(document.querySelector("[data-diagnostics-clear]").textContent, t("diagnosticsClear"), "Clear button translation");
    equal(document.querySelector("[data-diagnostics-confirm-clear]").textContent, t("diagnosticsConfirmClear"), "Confirm-clear translation");
    equal(document.querySelector("[data-diagnostics-cancel-clear]").textContent, t("cancel"), "Cancel-clear translation");
    return { language, copy: t("diagnosticsCopy"), clear: t("diagnosticsClear") };
  },
  async copy() {
    dock("settings"); await hostIdle();
    routeOwnsLogs("settings");
    const copies = clipboardTexts.length, clears = clearOperations(), before = clone(hostSaved[hostStorageKey]);
    document.querySelector("[data-diagnostics-copy]").click();
    await until(() => clipboardTexts.length === copies + 1 && !document.querySelector("[data-diagnostics-copy]").disabled, "Copy button did not complete");
    equal(clearOperations(), clears, "Copy also dispatched a destructive clear");
    equal(JSON.stringify(hostSaved[hostStorageKey]), JSON.stringify(before), "Copy altered the persisted log snapshot");
    const copied = JSON.parse(clipboardTexts.at(-1));
    const receipt = hostEvents.filter(entry => entry.operation === "read").at(-1);
    assert(receipt && receipt.result.ok, "Copy did not execute the real worker read operation");
    const snapshot = receipt.result.snapshot;
    equal(JSON.stringify(copied.events), JSON.stringify(snapshot.events), "Clipboard contains actual stored events");
    equal(copied.generation, snapshot.generation, "Clipboard generation matches committed state");
    equal(copied.persisted, true, "Copied snapshot must have a committed persistence receipt");
    equal(copied.buildFingerprint, ChatGPTTidyBuildInfo.fingerprint, "Copied snapshot build identity");
    assert(copied.incomplete === false, "Healthy diagnostic export unexpectedly incomplete");
    const t = createTranslator(preferences.language);
    equal(diagnosticStatus(), t("diagnosticsCopied"), "Successful copy has one concise confirmation, including empty logs");
    assert(!diagnosticStatusNode().hidden, "Copy success feedback is hidden");
    return { action: "copy", eventCount: copied.events.length, generation: copied.generation, status: diagnosticStatus(), hostWrites, clipboardChars: clipboardTexts.at(-1).length };
  },
  async cancelClear() {
    dock("settings"); await hostIdle(); routeOwnsLogs("settings");
    const before = clone(hostSaved[hostStorageKey]), clears = clearOperations();
    openClearConfirmation(); await sleep(30);
    equal(clearOperations(), clears, "Opening clear confirmation dispatched a clear");
    equal(JSON.stringify(hostSaved[hostStorageKey]), JSON.stringify(before), "Opening clear confirmation changed persisted logs");
    document.querySelector("[data-diagnostics-cancel-clear]").click(); await sleep(30);
    assert(!rendered(document.querySelector("[data-diagnostics-confirm-clear]")), "Cancel did not dismiss clear confirmation");
    equal(clearOperations(), clears, "Cancelling clear dispatched a clear");
    equal(JSON.stringify(hostSaved[hostStorageKey]), JSON.stringify(before), "Cancelling clear changed persisted logs");
    openClearConfirmation();
    document.querySelector("[data-diagnostics-cancel-clear]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(30);
    assert(!rendered(document.querySelector("[data-diagnostics-confirm-clear]")), "Escape did not cancel clear confirmation");
    equal(clearOperations(), clears, "Escape cancellation dispatched a clear");
    equal(JSON.stringify(hostSaved[hostStorageKey]), JSON.stringify(before), "Escape cancellation changed persisted logs");
    return { action: "cancel-clear", storedEvents: before.events.length, clearRequests: 0, generationUnchanged: true, cancelButtonAndEscape: true };
  },
  async clear() {
    dock("settings"); await hostIdle(); routeOwnsLogs("settings");
    const before = clone(hostSaved[hostStorageKey]), writes = hostWrites, clears = clearOperations();
    openClearConfirmation(); await sleep(30);
    equal(clearOperations(), clears, "Clear was destructive before confirmation");
    equal(JSON.stringify(hostSaved[hostStorageKey]), JSON.stringify(before), "Clear opening erased history before confirmation");
    document.querySelector("[data-diagnostics-confirm-clear]").click();
    await until(() => !document.querySelector("[data-diagnostics-clear]").disabled && diagnosticStatus() === createTranslator(preferences.language)("diagnosticsCleared"), "Clear button did not complete");
    equal(clearOperations(), clears + 1, "Confirmation must dispatch exactly one clear");
    assert(!rendered(document.querySelector("[data-diagnostics-confirm-clear]")), "Successful clear left confirmation open");
    const receipt = hostEvents.filter(entry => entry.operation === "clear").at(-1);
    assert(receipt && receipt.result.ok && receipt.result.snapshot.persisted, "Clear lacked real committed worker receipt");
    const saved = hostSaved[hostStorageKey];
    assert(hostWrites > writes, "Clear did not commit session storage");
    assert(saved.generation !== before.generation, "Clear did not rotate generation");
    equal(saved.events.length, 0, "Clear left persisted events");
    equal(receipt.result.snapshot.events.length, 0, "Clear returned nonempty snapshot");
    equal(ChatGPTTidyDiagnostics.snapshot().events.length, 0, "Clear left local observation events");
    equal(JSON.stringify(stored), smokeLibraryBefore, "Clearing diagnostics altered user library");
    equal(preferences.timeZone, smokeZoneBefore, "Clearing diagnostics altered settings");
    return { action: "clear", generationRotated: true, storedEvents: saved.events.length, localEvents: ChatGPTTidyDiagnostics.snapshot().events.length, committedWrites: hostWrites - writes, status: diagnosticStatus() };
  },
  async feedbackExpires() {
    assert(!diagnosticStatusNode().hidden && diagnosticStatus(), "Expected fresh success feedback before expiry check");
    const initial = diagnosticStatus();
    await sleep(3200);
    assert(diagnosticStatusNode().hidden && diagnosticStatus() === "", "Success feedback did not disappear after three seconds");
    return { initial, elapsedMs: 3200, hidden: true };
  },
  async layout({ width, height, confirmation = false, blocked = false }) {
    dock("settings"); await sleep(30); routeOwnsLogs("settings");
    equal(innerWidth, width, "Layout viewport width did not match requested CDP size");
    equal(innerHeight, height, "Layout viewport height did not match requested CDP size");
    if (confirmation) openClearConfirmation();
    const root = diagnosticRoot(), form = document.getElementById("settings-form");
    const view = root.parentElement, body = document.querySelector(".time-panel__body");
    const style = getComputedStyle(root), viewStyle = getComputedStyle(view), formStyle = getComputedStyle(form);
    const box = element => { const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height }; };
    const footer = box(root), viewBox = box(view), formBox = box(form);
    assert(viewStyle.display === "flex" && viewStyle.flexDirection === "column", "Settings must own a column flex layout");
    assert(!["absolute", "fixed", "sticky"].includes(style.position), "Log footer must reserve its own space, not overlay settings");
    assert(parseFloat(style.borderTopWidth) >= 1 && style.borderTopStyle !== "none", "Log footer lacks its separating top rule");
    assert(Math.abs(footer.bottom - viewBox.bottom) <= 1, "Log footer is not aligned to settings bottom");
    assert(footer.top >= viewBox.top - 1 && footer.bottom <= innerHeight + 1, "Log footer escaped the visible viewport");
    assert(root.scrollWidth <= root.clientWidth + 1 && view.scrollWidth <= view.clientWidth + 1 && body.scrollWidth <= body.clientWidth + 1,
      "Log footer or settings has horizontal overflow");
    const footerScrolls = root.scrollHeight > root.clientHeight + 1;
    if (footerScrolls) assert(["auto", "scroll"].includes(style.overflowY), "Oversized footer content is clipped rather than scrollable");
    assert(body.scrollHeight <= body.clientHeight + 1, "Settings outer body scrolls; only the upper form should scroll");
    for (const element of root.querySelectorAll("button, p, h2")) {
      if (!rendered(element)) continue;
      const rect = box(element);
      assert(rect.left >= footer.left - 1 && rect.right <= footer.right + 1,
        "Visible log text or button escapes footer width: " + element.textContent);
      if (!footerScrolls) assert(rect.top >= footer.top - 1 && rect.bottom <= footer.bottom + 1,
        "Visible log text or button escapes footer height: " + element.textContent);
      assert(element.scrollWidth <= element.clientWidth + 1, "Log text or button is horizontally clipped: " + element.textContent);
    }
    if (footerScrolls) {
      // At a short height, the footer may have its own bounded scroll area.
      // Test reachability instead of silently accepting clipped confirmation buttons.
      for (const button of root.querySelectorAll("button")) {
        if (!rendered(button)) continue;
        const top = box(button).top - footer.top + root.scrollTop;
        root.scrollTop = Math.max(0, top - 8); await sleep(10);
        const rect = box(button);
        assert(rect.top >= footer.top - 1 && rect.bottom <= footer.bottom + 1, "Log action cannot be fully reached by footer scrolling");
      }
      root.scrollTop = 0;
    }
    let formScrolled = false, backupReachable = null;
    if (blocked) {
      assert(form.hidden && form.inert, "Disconnected settings form must stay hidden and inert");
    } else {
      assert(!form.hidden && !form.inert && formBox.height > 0, "Settings form is unavailable while connected");
      assert(["auto", "scroll"].includes(formStyle.overflowY), "Upper settings form must own vertical scrolling");
      assert(formBox.bottom <= footer.top + 1, "Log footer overlaps the settings form");
      const oldScroll = form.scrollTop;
      form.scrollTop = form.scrollHeight; await sleep(20);
      formScrolled = form.scrollTop > 0;
      if (height <= 440) assert(formScrolled, "Short viewport did not make the upper settings area scrollable");
      const backup = document.getElementById("library-backup"), backupBox = box(backup), scrolledForm = box(form);
      backupReachable = backupBox.bottom <= scrolledForm.bottom + 1 && backupBox.bottom > scrolledForm.top;
      assert(backupReachable, "Backup footer cannot be reached by scrolling the settings form");
      assert(scrolledForm.bottom <= box(root).top + 1, "Scrolled backup content overlays the log footer");
      assert(Math.abs(box(root).top - footer.top) <= 1 && Math.abs(box(root).bottom - footer.bottom) <= 1,
        "Scrolling settings moves the persistent log footer");
      form.scrollTop = oldScroll;
    }
    return { language: preferences.language, width, height, blocked, confirmation, footer, form: formBox, formScrolled, footerScrolls, backupReachable };
  },
  dismissConfirmation() {
    const clears = clearOperations();
    document.querySelector("[data-diagnostics-cancel-clear]").click();
    assert(!rendered(document.querySelector("[data-diagnostics-confirm-clear]")), "Layout confirmation did not dismiss");
    equal(clearOperations(), clears, "Dismissing layout confirmation cleared logs");
    return { cancelled: true };
  },
  async routes() {
    const results = [];
    for (const route of Object.keys(smokeRoutes)) {
      dock(route); await sleep(30); results.push(routeOwnsLogs(route));
    }
    return { phase: pageRuntimeAvailable ? "ready" : "refresh-required", routes: results, uniqueOwner: true };
  },
  async blockPage() {
    const languageBefore = preferences.language;
    pageRuntimeAvailable = false;
    documentId = "architecture-diagnostics-refresh-required";
    event(protocol.Type.CONTEXT_CHANGED, { tabId: 31, documentId, url: currentSnapshot.route.href });
    const businessViews = [...document.querySelectorAll('[data-view]:not([data-view="settings"])')];
    const settings = document.getElementById("settings-view"), form = document.getElementById("settings-form");
    await until(() => businessViews.every(view => view.hidden && view.inert) && form.hidden && form.inert,
      "Disconnected business views and settings form were not blocked");
    assert(businessViews.length === 6, "Expected exactly six non-settings business views");
    assert(!settings.hidden && !settings.inert, "Settings route must remain admitted for its log footer");
    const root = diagnosticRoot();
    dock("settings"); routeOwnsLogs("settings");
    assert(!root.closest("[inert]") && !root.closest("[hidden]"), "Disconnected log footer is inside a blocked ancestor");
    assert(!document.getElementById("page-refresh-notice").hidden, "Refresh-required explanation missing");
    await sleep(150);
    const before = requests.length;
    for (const route of Object.keys(smokeRoutes)) { dock(route); await sleep(20); routeOwnsLogs(route); }
    const selector = document.getElementById("language-select");
    selector.value = languageBefore === "en" ? "zh-CN" : "en";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(50);
    equal(requests.length, before, "Blocked navigation or settings dispatched a business request");
    equal(preferences.language, languageBefore, "Blocked settings changed preferences");
    selector.value = languageBefore;
    assert(!root.querySelector("[data-diagnostics-copy]").disabled && !root.querySelector("[data-diagnostics-clear]").disabled,
      "Settings log operations were disabled by business admission");
    return { syntheticPageAvailable: pageRuntimeAvailable, blockedBusinessViews: 6, blockedSettingsForm: true, owner: "#settings-view",
      uniqueDiagnosticOwner: true, businessRequestsAfterBlockedClicks: requests.length - before };
  },
  async recoverPage() {
    pageRuntimeAvailable = true;
    updateSnapshot(); await sleep(30);
    assert(!document.getElementById("page-refresh-notice").hidden, "Same failed document snapshot improperly cleared refresh-required state");
    // Return to the fixture's original healthy document. This is a different
    // document from the retired one, without rewriting the synthetic library.
    documentId = healthyDocumentId;
    event(protocol.Type.CONTEXT_CHANGED, { tabId: 31, documentId, url: currentSnapshot.route.href });
    const views = [...document.querySelectorAll("[data-view]")], form = document.getElementById("settings-form");
    await until(() => document.getElementById("page-refresh-notice").hidden && views.every(view => !view.hidden && !view.inert)
      && !form.hidden && !form.inert, "Fresh healthy document did not restore business controls");
    await hostIdle();
    dock("settings"); routeOwnsLogs("settings");
    equal(JSON.stringify(stored), smokeLibraryBefore, "Connection recovery rewrote the synthetic library");
    equal(preferences.timeZone, smokeZoneBefore, "Connection recovery altered time-zone settings");
    return { syntheticPageAvailable: true, businessViewsRestored: 6, settingsFormRestored: true, logOwnerUnchanged: true };
  },
  report() {
    return { operations: hostEvents.map(entry => ({ operation: entry.operation, ok: entry.result.ok, code: entry.result.code || null, accepted: entry.result.accepted ?? null, eventCount: entry.result.snapshot?.events.length ?? null })),
      writes: hostWrites, storedEventCount: hostSaved[hostStorageKey]?.events.length ?? null, clipboardWrites: clipboardTexts.length,
      copyBoundary: "Navigator clipboard adapter captured serialized text; operating-system clipboard was not touched",
      executionBoundary: "Production worker-service/session-store/wire in browser with synthetic sender and isolated session storage; not a real extension worker process" };
  },
});
