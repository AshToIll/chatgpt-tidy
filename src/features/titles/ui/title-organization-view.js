import { createTitleView } from "./title-view.js";
import { createTitleBatchView } from "./title-batch-view.js";
import { getTitleRulesController } from "./title-rules.js";

// The two modes own separate DOM roots and state. Switching a tab never
// reconstructs a form or destroys a batch receipt that the user has just read.
export function createTitleOrganizationView({ root, request, loadCatalog, pauseCatalog = () => {},
  onChanged = () => {}, ownerTabId, onBusyChange = () => {}, rulesController = getTitleRulesController() }) {
  root.innerHTML = `<div class="titles-organization"><div class="titles-mode-tabs" role="tablist">
    <button type="button" role="tab" data-titles-mode="current" aria-selected="true"></button>
    <button type="button" role="tab" data-titles-mode="batch" aria-selected="false"></button>
    </div><div class="titles-notice is-warning" data-title-rules-notice role="status" hidden><span data-title-rules-error></span><button type="button" class="titles-button" data-title-rules-retry hidden></button></div>
    <div class="titles-mode-content" data-titles-current></div>
    <div class="titles-mode-content" data-titles-batch hidden></div></div>`;
  const currentRoot = root.querySelector("[data-titles-current]");
  const batchRoot = root.querySelector("[data-titles-batch]");
  const rulesNotice = root.querySelector("[data-title-rules-notice]");
  const rulesError = root.querySelector("[data-title-rules-error]");
  const rulesRetry = root.querySelector("[data-title-rules-retry]");
  let mode = "current", options = null, disposed = false;
  const rulesNoticeIdentity = { surface: "titles.rules.status",
    instanceId: globalThis.ChatGPTTidyDiagnostics?.slot?.(rulesNotice) };
  function renderRulesNotice() {
    if (disposed) return;
    const { error, errorCause } = rulesController.snapshot(), t = options?.translator || (key => key);
    const messageKey = error === "save" ? "titlesSettingsSaveFailed"
      : error === "unconfirmed" ? "titlesSettingsUnconfirmed" : "titlesSettingsReadFailed";
    rulesNotice.hidden = !error || !options?.active;
    rulesError.textContent = error ? t(messageKey) : "";
    rulesRetry.hidden = rulesNotice.hidden || error === "save";
    rulesRetry.textContent = t("retry");
    // 只观测实际可见的主提示。读回的副原因未单独显示，不伪造第二条提示。
    globalThis.ChatGPTTidyDiagnostics?.notice(rulesNotice.hidden
      ? { ...rulesNoticeIdentity, event: "clear", reasonCode: "NOTICE_HIDDEN" }
      : { ...rulesNoticeIdentity, event: "show", ownerNode: rulesNotice, messageKey,
        source: "src/features/titles/ui/title-organization-view.js",
        ...(errorCause || { reasonCode: "OBSERVATION_ONLY_UNSPECIFIED" }) });
  }
  const unsubscribeRules = rulesController.subscribe(renderRulesNotice);
  const updateLocks = () => {
    for (const button of root.querySelectorAll("[data-titles-mode]")) {
      button.disabled = mode !== button.dataset.titlesMode && !(mode === "batch" ? batch.canLeave() : current.canLeave());
    }
  };
  const current = createTitleView({ root: currentRoot, request, onChanged, ownerTabId, rulesController, onBusyChange: updateLocks });
  const batch = createTitleBatchView({ root: batchRoot, ownerTabId, request: (action, payload) => request(action, {
    ...payload, expectedTabId: ownerTabId,
    expectedConversationId: payload.expectedConversationId ?? options?.snapshot?.conversation?.conversationId,
  }), loadCatalog, rulesController, onChanged,
    onUseCurrent: () => { if (options && batch.canLeave()) { mode = "current"; update(options); } },
    onBusyChange: (busy) => { updateLocks(); onBusyChange(busy); } });

  function update(next) {
    if (disposed) return;
    options = next;
    renderRulesNotice();
    const t = next.translator || ((key) => key);
    for (const button of root.querySelectorAll("[data-titles-mode]")) {
      const selected = mode === button.dataset.titlesMode;
      button.textContent = t(button.dataset.titlesMode === "current" ? "currentConversation" : "titlesBatch");
      button.setAttribute("aria-selected", String(selected));
      button.disabled = !selected && !(mode === "batch" ? batch.canLeave() : current.canLeave());
    }
    currentRoot.hidden = mode !== "current";
    batchRoot.hidden = mode !== "batch";
    current.update({ ...next, active: next.active && mode === "current" });
    batch.update({ ...next, active: next.active && mode === "batch", t });
    if (!next.active || mode !== "batch") pauseCatalog();
  }

  function click(event) {
    if (event.target.closest?.("[data-title-rules-retry]") === rulesRetry && !rulesRetry.hidden && !rulesRetry.disabled) {
      const hadFocus = root.ownerDocument?.activeElement === rulesRetry;
      rulesRetry.disabled = true;
      void rulesController.retry().finally(() => {
        rulesRetry.disabled = false;
        // 成功后提醒会消失；仅在焦点没有被用户主动移走时，回到当前页签。
        if (!disposed && hadFocus && rulesRetry.hidden && [rulesRetry, root.ownerDocument.body].includes(root.ownerDocument.activeElement)) {
          root.querySelector('[data-titles-mode][aria-selected="true"]').focus();
        }
      });
      return;
    }
    const button = event.target.closest?.("[data-titles-mode]");
    if (!button || !root.contains(button) || button.disabled || button.dataset.titlesMode === mode || !options) return;
    if (!(mode === "batch" ? batch.canLeave() : current.canLeave())) return;
    mode = button.dataset.titlesMode;
    update(options);
  }
  root.addEventListener("click", click);
  return Object.freeze({ update,
    canLeave: () => mode === "batch" ? batch.canLeave() : current.canLeave(),
    dispose() {
      if (disposed) return;
      disposed = true; rulesNotice.hidden = true;
      globalThis.ChatGPTTidyDiagnostics?.notice({ ...rulesNoticeIdentity, event: "clear", reasonCode: "VIEW_DISPOSED" });
      unsubscribeRules(); pauseCatalog(); current.dispose(); batch.dispose(); root.removeEventListener("click", click);
    },
  });
}
