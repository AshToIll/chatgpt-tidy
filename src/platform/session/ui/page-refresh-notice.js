import "../../../messages/notice-lifecycle.js";

// Page-session admission owns the supplied business regions, independently of
// account or snapshot availability. The shell passes six feature views plus the
// settings form; the settings-local log footer is deliberately outside this gate.
// Recovery has one fixed slot, never per-module toasts.
export function pageRefreshRequired(model) {
  return model.pageSession?.phase === "refresh-required";
}

// Each DOM surface retains one condition instance. Language/theme repainting
// updates its text only; it must not revive a consumed reconnect action.
const pageRefreshProjections = new WeakMap();

export function renderPageRefreshNotice({ root, views, model, translate, onReconnect }) {
  const session = model.pageSession;
  const phase = session?.phase || "connecting";
  const blocked = phase !== "ready";
  const messageKey = phase === "refresh-required" ? "refreshChatgptPage"
    : phase === "stalled" ? "pageSessionStalled" : "libraryVerifyingAccount";
  const reasonCode = phase === "refresh-required" ? "PAGE_REFRESH_REQUIRED"
    : phase === "stalled" ? "PAGE_SESSION_STALLED" : "PAGE_SESSION_CONNECTING";
  let projection = pageRefreshProjections.get(root);
  if (!projection) {
    projection = { slot: globalThis.ChatGPTTidyNoticeLifecycle.createSlot(), condition: null,
      phase: null, generation: null, cause: null, message: null, action: null, consumed: false };
    pageRefreshProjections.set(root, projection);
  }
  const changed = projection.phase !== phase || projection.generation !== session?.generation
    || projection.cause !== session?.error;
  if (changed) {
    projection.phase = phase; projection.generation = session?.generation;
    projection.cause = session?.error; projection.consumed = false;
    projection.message = null; projection.action = null;
    if (blocked) {
      projection.condition = projection.slot.replace({ kind: "condition", surface: "session.page-refresh",
        ownerEpoch: session?.generation, messageKey, cause: session?.error, phase });
      const cause = projection.condition.cause;
      globalThis.ChatGPTTidyDiagnostics?.notice({ event: "show", surface: "session.page-refresh",
        source: "src/platform/session/ui/page-refresh-notice.js", messageKey, ...cause,
        // A known error keeps its exact code and safe request correlation;
        // otherwise the explicit controller phase is still known evidence.
        reasonCode: cause?.reasonCode && cause.reasonCode !== "OBSERVATION_ONLY_UNSPECIFIED" ? cause.reasonCode : reasonCode });
    } else {
      projection.slot.clear(projection.condition, "resolved"); projection.condition = null;
      globalThis.ChatGPTTidyDiagnostics?.notice({ event: "clear", surface: "session.page-refresh",
        reasonCode: "PAGE_SESSION_READY" });
    }
  }
  root.hidden = !blocked;
  root.setAttribute?.("aria-busy", String(phase === "connecting"));
  const message = blocked ? translate(messageKey) : "";
  projection.onReconnect = onReconnect;
  if (phase === "stalled") {
    if (!projection.action) {
      const document = root.ownerDocument;
      const text = document.createElement("span"), action = document.createElement("button");
      action.type = "button"; action.dataset.pageSessionReconnect = "";
      const expected = projection.condition;
      action.addEventListener("click", () => {
        // This button owns one condition generation, not an arbitrary current
        // page. It only asks the controller to probe; no write is replayed.
        if (projection.slot.current() !== expected || projection.consumed
          || model.pageSession?.phase !== "stalled" || model.pageSession?.generation !== projection.generation
          || typeof projection.onReconnect !== "function") return;
        projection.consumed = true; action.disabled = true;
        projection.onReconnect();
      });
      projection.message = text; projection.action = action;
      root.replaceChildren(text, action);
    }
    projection.message.textContent = message;
    projection.action.textContent = translate("reconnect");
    projection.action.disabled = projection.consumed || typeof onReconnect !== "function";
  } else if (root.textContent !== message || changed) {
    root.textContent = message;
  }
  // inert is the trusted-input boundary; panel lifecycle + command admission
  // also stop timers, delayed replies and programmatic actions behind the UI.
  for (const view of views) { view.hidden = blocked; view.inert = blocked; }
  return blocked;
}
