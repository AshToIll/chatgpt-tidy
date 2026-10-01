import { escapeHtml } from "../../../platform/ui/html.js";
import { loadingFlowerMarkup } from "../../../platform/ui/loading-flower.js";
import { titleSnapshotContext } from "../model/title-context.js";
import { getTitleRulesController } from "./title-rules.js";
import { TITLE_RULE_FORMATS } from "../model/title-rules.js";
import "../../../messages/notice-lifecycle.js";

const UNSETTLED = new Set(["pending", "uncertain"]);
// Only these worker errors prove a frozen preview needs a fresh read. Auth,
// transport and write-result errors are never treated as retry instructions.
const EXPIRED_PREVIEW = new Set(["TITLE_PLAN_EXPIRED", "TITLE_PREVIEW_REQUIRED"]);

function effectiveZone(preferences) {
  const zone = preferences?.timeZone === "system" || !preferences?.timeZone
    ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" : preferences.timeZone;
  try { return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone; }
  catch { return "UTC"; }
}

function contextFor(snapshot, ownerTabId) {
  const conversation = snapshot?.conversation;
  const route = snapshot?.route;
  const id = conversation?.conversationId;
  const eligible = Boolean(titleSnapshotContext(snapshot, ownerTabId));
  return {
    id: eligible ? id : null,
    key: JSON.stringify([id, eligible, route?.pathname, conversation?.bindingStatus, conversation?.identityStatus]),
    dataKey: JSON.stringify([conversation?.title?.value, conversation?.createdAt?.value, conversation?.updatedAt?.value]),
  };
}

function errorKey(error) {
  // Never render arbitrary server messages, request URLs or error.details.
  const code = error?.code;
  if (code === "CONTEXT_MISMATCH") return "titlesContextChanged";
  if (code === "TITLE_CONFLICT") return "titlesConflict";
  if (code === "TITLE_ACCOUNT_CHANGED") return "titlesAccountChanged";
  if (["TITLE_PLAN_EXPIRED", "TITLE_INVALID_PLAN", "TITLE_PREVIEW_REQUIRED", "NOT_FOUND"].includes(code)) return "titlesPlanExpired";
  if (code === "TITLE_AUTH_REQUIRED") return "titlesAuthPending";
  if (code === "TITLE_AUTH_EXPIRED") return "titlesAuthExpired";
  if (code === "TITLE_BUSY") return "titlesPending";
  if (code === "TITLE_RATE_LIMITED") return "titlesRateLimited";
  if (code === "TITLE_NOT_DISPATCHED") return "titlesNotDispatched";
  if (["UNSUPPORTED_PAGE", "PERSISTENCE_REJECTED", "TAB_UNAVAILABLE"].includes(code)) return "titlesNeedsConversation";
  return "titlesReadFailed";
}

// Keep live controls in the document. Replacing innerHTML on every receipt or
// snapshot closes an open native select even when the selected rule is unchanged.
// The panel has a small fixed tree; patch only changed attributes/text in place.
function patchTitleNode(node, next) {
  if (node.nodeType !== next.nodeType || node.nodeName !== next.nodeName) {
    node.replaceWith(next.cloneNode(true));
    return;
  }
  if (node.nodeType !== 1) {
    if (node.nodeValue !== next.nodeValue) node.nodeValue = next.nodeValue;
    return;
  }
  for (const attribute of Array.from(node.attributes)) {
    if (!next.hasAttribute(attribute.name)) node.removeAttribute(attribute.name);
  }
  for (const attribute of Array.from(next.attributes)) {
    if (node.getAttribute(attribute.name) !== attribute.value) node.setAttribute(attribute.name, attribute.value);
  }
  const before = Array.from(node.childNodes), after = Array.from(next.childNodes);
  for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
    if (!after[index]) before[index].remove();
    else if (!before[index]) node.append(after[index].cloneNode(true));
    else patchTitleNode(before[index], after[index]);
  }
  // Native inputs have dirty properties independent of their HTML attributes.
  if (node.nodeName === "SELECT" && node.value !== next.value) node.value = next.value;
  if (node.nodeName === "INPUT" && node.checked !== next.checked) node.checked = next.checked;
}

// 本地提交证据与编辑草稿分开：隐藏预览不能销毁用户已确认的原计划。
// 核对拥有独立 token；其失败只能更新自己的次级原因，不能替换原写入原因。
function createSubmittedRecovery() {
  const checks = globalThis.ChatGPTTidyNoticeLifecycle.createOwner();
  let snapshot = Object.freeze({ attempt: null, check: null });
  return Object.freeze({
    current: () => snapshot,
    submit(plan) {
      checks.revoke();
      snapshot = Object.freeze({ attempt: Object.freeze({ id: plan.id, before: plan.before,
        after: plan.after, conversationId: plan.conversationId }), check: null });
    },
    beginCheck() {
      snapshot = Object.freeze({ ...snapshot, check: null });
      return checks.begin();
    },
    failCheck(token, messageKey, error) {
      if (!checks.owns(token)) return false;
      snapshot = Object.freeze({ ...snapshot, check: Object.freeze({ messageKey,
        cause: globalThis.ChatGPTTidyNoticeLifecycle.cause(error) }) });
      return true;
    },
    clear() { checks.revoke(); snapshot = Object.freeze({ attempt: null, check: null }); },
    dispose() { checks.dispose(); snapshot = Object.freeze({ attempt: null, check: null }); },
  });
}

/**
 * 当前会话的标题整理：进入时读取原题和日期，普通规则切换复用这份快照生成预览。
 * 预览过期才重新读取，不定时轮询；点击确认后仍由 worker 校验账号、原题和日期再写入。
 * 界面展示的预览不是保存成功回执。
 */
export function createTitleView({ root, request, onChanged = () => {}, ownerTabId,
  onBusyChange = () => {}, rulesController = getTitleRulesController() }) {
  if (!root || typeof request !== "function") throw new TypeError("Title view requires a root and request transport");
  const initialRules = rulesController.snapshot();
  const state = {
    active: false, disposed: false, snapshot: null, t: (key) => key,
    contextKey: "", dataKey: "", conversationId: null, timeZone: "UTC", locale: "en-US",
    rules: initialRules.rules, rulesReady: initialRules.ready, pendingRules: false,
    plan: null, displayPlan: null, previewContext: null, previewKind: "assign", decision: "skip", current: null,
    operation: null, recoveryNeeded: false, statusReady: false, submittedPlanId: null,
    busy: null, busyStartedAt: null, generation: 0, error: "", notice: "", refreshNeeded: false,
    autoRefreshBlocked: false,
  };
  let replanChannel = { running: false, queued: null };
  let localRuleChange = false;
  // A visible failure owns its cause independently of preview/request epochs.
  // Unknown writes have no expiry; hiding the editor must not erase their evidence.
  const failureNotice = globalThis.ChatGPTTidyNoticeLifecycle.createSlot();
  const submittedRecovery = createSubmittedRecovery();
  function observeNotice(key) {
    const failure = failureNotice.current();
    const receiptMatchesAttempt = state.operation && (!state.submittedPlanId || state.operation.id === state.submittedPlanId);
    const receiptCause = receiptMatchesAttempt && key === receiptKey()
      && (!state.recoveryNeeded || UNSETTLED.has(state.operation.status))
      ? globalThis.ChatGPTTidyDiagnostics?.cause({ code: state.operation.messageCode || {
        pending: "title_pending", uncertain: "title_uncertain", failed: "title_failed", conflict: "title_conflict",
      }[state.operation.status], jobId: state.operation.id }) : null;
    const cause = failure?.key === key ? failure.cause : receiptCause;
    globalThis.ChatGPTTidyDiagnostics?.notice({ event: state.active && key ? "show" : "clear",
      surface: "titles.current.notice", source: "src/features/titles/ui/title-view.js",
      messageKey: key, ...(cause || { reasonCode: "OBSERVATION_ONLY_UNSPECIFIED" }) });
    const check = state.active && key && unsettled() ? submittedRecovery.current().check : null;
    globalThis.ChatGPTTidyDiagnostics?.notice({ event: check ? "show" : "clear",
      surface: "titles.current.recovery", source: "src/features/titles/ui/title-view.js",
      ...(check ? { messageKey: check.messageKey, ...check.cause } : { reasonCode: "NOTICE_HIDDEN" }) });
  }

  function clearQueuedReplan() {
    replanChannel.queued?.resolve(null);
    replanChannel.queued = null;
  }

  function requestReplan(payload) {
    const channel = replanChannel;
    return new Promise((resolve, reject) => {
      // Worker-only calculation, not an authenticated read. Coalesce rapid
      // choices so old plans cannot build up or overtake the final selection.
      channel.queued?.resolve(null);
      channel.queued = { payload, resolve, reject };
      const pump = () => {
        if (channel.running || !channel.queued) return;
        const job = channel.queued;
        channel.queued = null;
        channel.running = true;
        Promise.resolve().then(() => request("replan", job.payload)).then(job.resolve, job.reject).finally(() => {
          channel.running = false;
          pump();
        });
      };
      pump();
    });
  }

  function localPreview(operation, decision) {
    // Authenticated metadata only. This pure display plan has no executable
    // ID; the worker's latest immutable plan remains the sole write authority.
    if (!state.current) return null;
    return globalThis.TidyTitleDates.plan(state.current, {
      ...state.rules, timeZone: state.timeZone, locale: state.locale,
    }, { operation, decision });
  }

  function unsettled() { return state.recoveryNeeded || UNSETTLED.has(state.operation?.status); }
  function locked() { return Boolean(state.busy) || unsettled(); }
  // A local plan registration is intentionally not a user-visible I/O state.
  // It temporarily gates confirm, but never adds a flower or locks the choices.
  function waitingForIO() { return Boolean(state.busy && state.busy !== "replan"); }
  function choicesLocked() { return waitingForIO() || unsettled(); }

  function hasEditablePreview() {
    // A no-op or missing-date plan is still a completed preview. Whether it
    // can write is a separate concern; only missing/expired read context needs
    // a retry affordance, never an ordinary change of options.
    return Boolean(state.plan && state.previewContext && state.previewContext.expiresAt > Date.now());
  }

  function refreshPreviewAutomatically() {
    // Event-driven, single-flight recovery only: never a timer, a POST retry,
    // or an escape from a pending write. A failed read stops this path until
    // manual retry or deliberate re-entry; ordinary snapshots cannot restart it.
    if (state.disposed || !state.active || !state.conversationId || !state.rulesReady
      || state.autoRefreshBlocked || waitingForIO() || unsettled()) return false;
    clearQueuedReplan();
    state.plan = null;
    state.previewContext = null;
    state.busy = null;
    state.refreshNeeded = false;
    void run("preview", state.previewKind, state.decision, { automatic: true });
    return true;
  }

  function discardPlan(notice = "") {
    state.plan = null;
    state.displayPlan = null;
    clearQueuedReplan();
    state.notice = notice;
    state.decision = "skip";
    // An in-flight write is owned by the worker, not by a visible preview.
    if (state.busy !== "apply") { state.generation += 1; state.busy = null; }
  }

  function receiveRules(next) {
    if (state.disposed) return;
    const wasReady = state.rulesReady;
    const changed = next.rules.mode !== state.rules.mode || next.rules.dateFormat !== state.rules.dateFormat;
    state.rulesReady = next.ready;
    // A shared preference notification is not permission to alter a submitted
    // plan or unknown receipt. Consume the latest preference only after it is
    // settled (or a different conversation owns the view).
    if (wasReady && changed && choicesLocked()) { state.pendingRules = true; return; }
    state.rules = next.rules;
    state.pendingRules = false;
    if (!next.ready) { render(); return; }
    if (!wasReady) {
      render();
      if (state.active && state.conversationId && !state.busy) void run(unsettled() ? "status" : "preview");
      return;
    }
    if (!changed) return;
    // Removing a recognized prefix does not depend on assignment formatting.
    // Keep that reviewed removal intact; Back will use the latest shared rules.
    if (state.previewKind === "remove") { render(); return; }
    const decision = state.decision;
    const operation = state.previewKind === "remove" ? "remove" : "assign";
    discardPlan("titlesPreviewStale");
    state.previewKind = operation;
    if (!state.autoRefreshBlocked) state.error = "";
    if (!state.active) {
      state.previewContext = null;
      state.refreshNeeded = false;
      render();
    } else {
      // External notifications may re-register a valid local context, but must
      // never initiate an authenticated read just because another tab changed
      // a preference. An explicit local edit retains normal expired recovery.
      void run("replan", operation, decision, { allowRefresh: localRuleChange });
    }
  }

  const unsubscribeRules = rulesController.subscribe(receiveRules);

  function validateResult(result, id) {
    if (!result || typeof result !== "object"
      || !Object.hasOwn(result, "current") || !Object.hasOwn(result, "operation") || !Object.hasOwn(result, "plan")
      || (result.current && (result.current.conversationId !== id || typeof result.current.title !== "string"))
      || (result.operation && (result.operation.conversationId !== id
        || !["pending", "accepted", "verified", "uncertain", "conflict", "failed"].includes(result.operation.status)))
      || (result.plan && (result.plan.conversationId !== id || typeof result.plan.id !== "string"
        || typeof result.plan.before !== "string" || typeof result.plan.after !== "string"
        || typeof result.plan.canApply !== "boolean"))) {
      // This is response validation after a possible write, not the service's
      // proven pre-write CONTEXT_MISMATCH rejection. Never classify it as safe
      // to retry when the apply request may already have reached ChatGPT.
      throw Object.assign(new Error("Invalid title response"), { code: "TITLE_INVALID_RESPONSE" });
    }
    return result;
  }

  async function run(action, operation = "assign", decision = "skip", { automatic = false, allowRefresh = true } = {}) {
    if (state.disposed || !state.active || !state.conversationId || !state.rulesReady
      || (state.busy && !(action === "replan" && state.busy === "replan"))) return;
    if (unsettled() && !["status", "reconcile"].includes(action)) return;
    if (action === "apply" && (!state.plan?.canApply || state.plan.noOp || state.plan.wouldEmpty)) return;
    if (action === "apply" && !hasEditablePreview()) {
      // The old confirmation authorizes only the old plan. Refresh it, then
      // require another explicit confirmation rather than replaying this click.
      state.plan = null;
      state.previewContext = null;
      state.error = "titlesPlanExpired";
      state.refreshNeeded = true;
      if (!refreshPreviewAutomatically()) render();
      return;
    }
    if (action === "preview" && !automatic) state.autoRefreshBlocked = false;
    const id = state.conversationId;
    const generation = ++state.generation;
    const payload = { expectedTabId: ownerTabId, expectedConversationId: id };
    if (["preview", "replan"].includes(action)) {
      state.previewKind = operation;
      state.decision = decision;
      payload.rules = { ...state.rules, timeZone: state.timeZone, locale: state.locale };
      payload.operation = operation;
      payload.decision = decision;
      if (!automatic) state.displayPlan = localPreview(operation, decision);
      if (action === "replan") {
        // Normal choices stay local. A missing/expired context is the sole
        // local exception: renew once, keeping the latest choice and card.
        const frozen = state.previewContext;
        if (!frozen || frozen.expiresAt <= Date.now()) {
          state.previewContext = null;
          clearQueuedReplan();
          state.plan = null;
          state.busy = null;
          state.error ||= "titlesPlanExpired";
          state.notice = "";
          state.refreshNeeded = true;
          if (!allowRefresh || !refreshPreviewAutomatically()) render();
          return;
        }
        payload.previewContextId = frozen.id;
      } else state.previewContext = null;
    } else if (action === "apply") {
      // The caller can never swap in a new title after the user has reviewed it.
      payload.planId = state.plan.id;
      state.submittedPlanId = state.plan.id;
      submittedRecovery.submit(state.plan);
      state.displayPlan = state.plan;
    }
    if (!["preview", "replan"].includes(action)) state.previewContext = null;
    if (action !== "replan" && state.busyStartedAt == null) state.busyStartedAt = Date.now();
    const checkingUnknown = ["status", "reconcile"].includes(action) && unsettled();
    const checkToken = checkingUnknown ? submittedRecovery.beginCheck() : null;
    state.busy = action;
    state.error = "";
    // A read-only check does not supersede the unknown write or its request ID.
    if (!checkingUnknown) failureNotice.clear();
    state.notice = "";
    state.plan = null;
    render();
    try {
      const received = await (action === "replan" ? requestReplan(payload) : request(action, payload));
      if (state.disposed || generation !== state.generation || id !== state.conversationId) return;
      const result = validateResult(received, id);
      // 恢复依据必须是本次读取的实际标题，单独一张历史回执不能解除待核对。
      if (["status", "reconcile"].includes(action) && !result.current) {
        throw Object.assign(new Error("Missing title observation"), { code: "TITLE_INVALID_RESPONSE" });
      }
      state.current = result.current || state.current;
      const differentReceipt = state.submittedPlanId && result.operation?.id !== state.submittedPlanId;
      if (differentReceipt && action === "apply") {
        // A read of an older successful receipt is not proof that the latest
        // lost write succeeded. Keep the latest attempt quarantined by planId.
        state.recoveryNeeded = true;
        state.statusReady = false;
        state.error = "titlesReceiptMissing";
        return;
      }
      // 新核对读到了当前标题，即可回到重新预览；不要求历史回信必须找回来。
      // 不相关的旧成功回执不能冒充刚才那次操作成功，也不能阻止新一次确认。
      const recoveredWithoutReceipt = differentReceipt && ["status", "reconcile"].includes(action);
      state.operation = recoveredWithoutReceipt ? null : result.operation || null;
      if (recoveredWithoutReceipt) { state.submittedPlanId = null; submittedRecovery.clear(); state.notice = "titlesRecoveryReady"; }
      state.recoveryNeeded = false;
      state.statusReady = true;
      const frozen = result.previewContext;
      const saved = action === "apply" && state.operation?.status === "verified";
      // A successful write's exact receipt is checked above before accepting
      // its fresh readback context. That context is for the NEXT edit only.
      state.previewContext = (["preview", "replan"].includes(action) || saved) && result.plan
        && typeof frozen?.id === "string" && Boolean(frozen.id) && Number.isFinite(frozen.expiresAt)
        ? { id: frozen.id, expiresAt: frozen.expiresAt } : null;
      // status/reconcile restore observed state, not unreviewed executable plans.
      state.plan = ["preview", "replan"].includes(action) || (saved && state.previewContext)
        ? result.plan || null : null;
      // A newly accepted edit is not the previous write attempt. The worker
      // keeps that receipt for durable recovery/deduplication, but it must not
      // become a warning (or a success claim) about this fresh preview. Keep
      // pending/uncertain outcomes visible and locked, even if a bad response
      // happens to include a plan; only a settled receipt can be superseded.
      if (["preview", "replan"].includes(action) && hasEditablePreview()
        && !UNSETTLED.has(state.operation?.status)) {
        state.operation = null;
        state.submittedPlanId = null;
        submittedRecovery.clear();
      }
      if (!unsettled()) { submittedRecovery.clear(); failureNotice.clear(); }
      state.refreshNeeded = !hasEditablePreview();
      if (action === "preview") state.autoRefreshBlocked = state.refreshNeeded;
      // A rename can advance update_time. Do not replace the success receipt
      // with a fresh range-conflict warning before the user starts another edit.
      // Once removal leaves a plain title, immediately return to the normal
      // add-date preview. A dated success stays compact so a changed update_time
      // does not show a new range conflict before the user makes another choice.
      state.displayPlan = saved && state.plan?.hasDateHead !== false ? null : state.plan;
      if (saved) state.previewKind = "assign";
      if (state.plan) state.decision = state.plan.selectedDecision || decision;
      if (["apply", "reconcile"].includes(action)
        && state.operation?.status === "verified") {
        Promise.resolve().then(() => onChanged()).catch(() => {});
      }
    } catch (error) {
      if (state.disposed || generation !== state.generation || id !== state.conversationId) return;
      if ((action === "replan" && EXPIRED_PREVIEW.has(error?.code))
        || (action === "apply" && error?.code === "TITLE_PREVIEW_REQUIRED")) {
        // The service rejects this apply before writing. Only renew the
        // preview; never automatically retry the mutation with a new planId.
        if (action === "apply") { state.submittedPlanId = null; submittedRecovery.clear(); }
        state.previewContext = null;
        state.busy = null;
        if (allowRefresh && refreshPreviewAutomatically()) return;
      }
      state.autoRefreshBlocked = true;
      state.refreshNeeded = true;
      if (action === "replan") state.previewContext = null;
      if (action === "apply" && !["TITLE_PREVIEW_REQUIRED", "CONTEXT_MISMATCH", "TITLE_NOT_DISPATCHED"].includes(error?.code)) {
        // Even a lost worker/bridge response may follow a successful write.
        // Keep only a read-only reconciliation path until the worker settles it.
        state.recoveryNeeded = true;
        state.error = "titlesUncertain";
      } else {
        if (action === "apply") { state.submittedPlanId = null; submittedRecovery.clear(); }
        if (error?.code === "TITLE_BUSY") state.recoveryNeeded = true;
        if (["status", "reconcile"].includes(action) && unsettled()) {
          // A failed read cannot downgrade an unknown save into an ordinary
          // load failure. Keep the save warning and describe this check below it.
          state.error = receiptKey() || "titlesUncertain";
          submittedRecovery.failCheck(checkToken, errorKey(error), error);
        } else state.error = errorKey(error);
        if (["status", "reconcile"].includes(action)) state.statusReady = false;
      }
      if (!checkingUnknown) failureNotice.replace({ kind: unsettled() ? "operation" : "condition", key: state.error,
        cause: globalThis.ChatGPTTidyDiagnostics?.cause(error) });
    } finally {
      if (!state.disposed && generation === state.generation && id === state.conversationId) {
        state.busy = null;
        state.busyStartedAt = null;
        if (state.pendingRules && !unsettled()) receiveRules(rulesController.snapshot());
        render();
      }
    }
  }

  function selectMarkup(field, label, options, selected) {
    return `<label class="titles-rule-select"><select aria-label="${escapeHtml(state.t(label))}" data-title-rule="${field}"${choicesLocked() ? " disabled" : ""}>${options.map(([value, text]) => `<option value="${value}"${value === selected ? " selected" : ""}>${escapeHtml(text)}</option>`).join("")}</select><i class="titles-rule-select__chevron" aria-hidden="true"></i></label>`;
  }

  function button(action, label, { disabled = false, icon = "" } = {}) {
    const icons = {
      remove: '<path d="M3 5h14M7 5V3h6v2M5 5l1 12h8l1-12M8 8v6M12 8v6"/>',
      refresh: '<path d="M16 7a6 6 0 1 0 0 6M16 3v4h-4"/>',
    };
    const text = escapeHtml(state.t(label));
    const title = text;
    return `<button type="button" class="${action === "back" ? "titles-back-action" : icon ? `titles-icon-action is-${icon}` : "titles-button"}" data-title-action="${action}" title="${title}"${icon ? ` aria-label="${text}"` : ""}${disabled ? " disabled" : ""}>${icon ? `<svg viewBox="0 0 20 20" aria-hidden="true">${icons[icon]}</svg><span>${text}</span>` : text}</button>`;
  }

  function loadingMarkup() {
    const key = !state.rulesReady ? "waiting" : state.busy === "apply" ? "titlesSaving"
      : state.busy === "preview" ? "titlesPreviewing" : "titlesChecking";
    const label = escapeHtml(state.t(key));
    return `${loadingFlowerMarkup(state.busyStartedAt ?? Date.now())}<span class="titles-status__label--sr-only">${label}</span>`;
  }

  function statusMarkup(loading = waitingForIO()) {
    // Like Search, reserve one quiet central slot below controls. Normal local
    // choices don't use it; renewing an expired context is real read-only I/O.
    return `<div class="titles-status" role="status" aria-live="polite">${loading ? loadingMarkup() : ""}</div>`;
  }

  function replaceContents(markup) {
    const template = root.ownerDocument?.createElement("template");
    if (template && root.firstChild) {
      template.innerHTML = markup;
      patchTitleNode(root.firstChild, template.content.firstChild);
    } else {
      // Initial mount (and non-DOM transport test fixtures) only.
      root.innerHTML = markup;
    }
  }

  function dateRow() {
    // 与批量列表复用同一范围格式：标题日期格式、全局时区、浏览器地区和默认分钟精度。
    // 端点仍是会话的创建/更新时间，不是消息时间；读取后不拼接旧快照来补缺失端点。
    const value = (field) => state.current ? state.current[field] : state.snapshot?.conversation?.[field]?.value;
    return escapeHtml(globalThis.TidyTimeFormat.formatRange(value("createdAt"), value("updatedAt"),
      { ...state.rules, timeZone: state.timeZone, locale: state.locale }) || "");
  }

  function receiptKey() {
    if (state.recoveryNeeded) return "titlesUncertain";
    const op = state.operation;
    if (!op) return "";
    if (op.status === "failed" && op.messageCode === "title_not_dispatched") return "titlesNotDispatched";
    if (op.status === "conflict" && op.messageCode === "title_unchanged") return "titlesUnchanged";
    if (op.httpStatus === 429 && op.status === "failed") return "titlesRateLimited";
    if ([401, 403].includes(op.httpStatus) && op.status === "failed") return "titlesAuthPending";
    // A date preflight conflict proves a timestamp mismatch, not a title edit.
    // Unknown conflict codes stay neutral rather than inventing a cause.
    if (op.status === "conflict") return op.messageCode === "dates_changed" ? "titlesDatesChanged"
      : ["title_conflict", "title_changed_externally"].includes(op.messageCode) ? "titlesTitleChanged" : "titlesConflict";
    return { pending: "titlesPending", uncertain: "titlesUncertain",
      failed: "titlesFailed", verified: "titlesVerified" }[op.status] || "";
  }

  function previewMarkup() {
    const plan = state.displayPlan;
    const receipt = receiptKey();
    // 待核对不是新预览：并列呈现原计划和最近读到的标题，不把计划写成“已修改”。
    // 丢失回执时只用本次已确认的草稿，不能借上一次成功记录解释这一次请求。
    const submitted = submittedRecovery.current().attempt;
    const attempt = UNSETTLED.has(state.operation?.status) ? state.operation
      : state.submittedPlanId && submitted?.id === state.submittedPlanId ? submitted : null;
    if (unsettled() && typeof attempt?.after === "string") {
      return `<article class="titles-preview-card is-risk" data-title-recovery><div class="titles-preview-card__body"><dl><div><dt>${escapeHtml(state.t("titlesRecoveryTarget"))}</dt><dd>${escapeHtml(attempt.after)}</dd></div><div><dt>${escapeHtml(state.t("titlesRecoveryObserved"))}</dt><dd>${escapeHtml(state.current?.title || "—")}</dd></div></dl></div></article>`;
    }
    const success = state.busy !== "apply" && !unsettled() && receipt === "titlesVerified";
    if (!plan) return success
      ? `<article class="titles-preview-card is-matched"><div class="titles-noop"><strong>${escapeHtml(state.current?.title || "")}</strong><span role="status">${escapeHtml(state.t(receipt))}</span></div></article>`
      : "";
    const conflict = plan.needsDecision && state.previewKind === "assign";
    // 不把空标题、异常时间都说成“缺少日期”；只给用户当前能采取的动作。
    const detail = plan.wouldEmpty ? "titlesWouldEmpty" : plan.action === "blocked"
      ? ({ empty_title: "titlesEmptyTitle", missing_updated_time: "titlesMissingUpdated",
        invalid_date_range: "titlesInvalidDates" }[plan.reason] || "titlesMissingDates") : "";
    if (plan.noOp && !conflict && !detail) {
      return `<article class="titles-preview-card is-matched" data-title-preview><div class="titles-noop"><strong>${escapeHtml(plan.before)}</strong><span>${escapeHtml(state.t("titlesNoChange"))}</span></div></article>`;
    }
    const decisions = conflict
      ? `<fieldset class="titles-decision-options" aria-label="${escapeHtml(state.t("titlesExistingDate"))}"${choicesLocked() ? " disabled" : ""}>${["skip", "replace", "stack"].map((value) => `<label${state.decision === value ? ' class="is-selected"' : ""}><input type="radio" name="title-date-decision" data-title-decision value="${value}"${state.decision === value ? " checked" : ""}><span>${escapeHtml(state.t({ skip: "titlesSkip", replace: "titlesReplace", stack: "titlesStack" }[value]))}</span></label>`).join("")}</fieldset>` : "";
    return `<article class="titles-preview-card ${conflict ? "is-decision" : detail ? "is-risk" : state.previewKind === "remove" ? "is-replace" : "is-clean"}" data-title-preview><div class="titles-preview-card__body">${conflict ? `<p class="titles-conflict-note">${escapeHtml(state.t("titlesExistingDate"))}</p>` : ""}<dl><div><dt>${escapeHtml(state.t("titlesBefore"))}</dt><dd>${escapeHtml(plan.before)}</dd></div><div><dt>${escapeHtml(state.t("titlesAfter"))}</dt><dd>${escapeHtml(plan.after || "—")}</dd></div></dl>${detail ? `<p class="titles-match-note">${escapeHtml(state.t(detail))}</p>` : ""}${decisions}</div></article>`;
  }

  function render() {
    onBusyChange(state.busy === "apply");
    if (state.disposed) return;
    const t = state.t;
    root.setAttribute("aria-label", t("titleOrganization"));
    root.setAttribute("aria-busy", String(waitingForIO()));
    if (!state.conversationId) {
      observeNotice(null);
      replaceContents(`<div class="titles-panel"><div class="titles-empty"><p>${escapeHtml(t("titlesNeedsConversation"))}</p></div></div>`);
      return;
    }
    if (!state.rulesReady) {
      observeNotice(null);
      replaceContents(`<div class="titles-panel">${statusMarkup(true)}</div>`);
      return;
    }
    const title = state.current?.title ?? state.snapshot?.conversation?.title?.value ?? t("untitled");
    const receipt = receiptKey();
    const notice = state.error || state.notice || (receipt !== "titlesVerified" ? receipt : "");
    observeNotice(notice);
    const checkMessage = unsettled() ? submittedRecovery.current().check?.messageKey : null;
    const noticeText = [notice && t(notice), checkMessage && checkMessage !== notice
      ? t(checkMessage) : ""].filter(Boolean).join(" ");
    const blocked = locked() || !state.statusReady;
    const displayed = state.displayPlan;
    const confirm = Boolean(displayed?.canApply && !displayed.noOp && !displayed.wouldEmpty);
    const confirmLabel = state.busy === "apply" ? "titlesSaving"
      : state.previewKind === "remove" ? "titlesConfirmRemove"
      : displayed?.action === "replace" ? "titlesConfirmReplace" : displayed?.action === "stack" ? "titlesConfirmStack" : "titlesConfirm";
    const primary = unsettled() ? button("reconcile", "titlesReconcile", { disabled: Boolean(state.busy) })
      : confirm ? button("apply", confirmLabel, { disabled: blocked || !state.plan }) : "";
    // Refresh is a recovery exit, not a routine editing step. Keep that exit
    // visible but disabled while its explicit retry runs; first reads and
    // ordinary saves never introduce it. Unsettled writes only allow checking.
    const refresh = state.refreshNeeded && !unsettled()
      ? button("preview", notice === "titlesNotDispatched" ? "titlesPreviewAgain" : "titlesRefreshPreview", { icon: "refresh", disabled: locked() }) : "";
    const remove = state.previewKind === "remove"
      ? button("back", "titlesBack", { disabled: blocked })
      : (displayed || state.plan)?.hasDateHead ? button("remove", "titlesRemove", { icon: "remove", disabled: blocked }) : "";
    const previewHeight = waitingForIO() ? root.querySelector?.(".titles-preview")?.getBoundingClientRect?.().height || 0 : 0;
    replaceContents(`<div class="titles-panel"><div class="titles-current">
      <section class="titles-scope"><strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong><small>${dateRow()}</small></section>
      ${state.previewKind === "remove" ? "" : `<section class="titles-rule"><h3>${escapeHtml(t("titlesRules"))}</h3><div class="titles-rule-controls">
        ${selectMarkup("dateFormat", "dateFormat", [["locale", t("titlesRegional")], ...Object.entries(globalThis.TidyTimeFormat.dateFormatLabels(state.timeZone))], state.rules.dateFormat)}
        ${selectMarkup("mode", "titlesDateBasis", [["created", t("titlesCreatedDate")], ["range", t("titlesRange")]], state.rules.mode)}
      </div></section>`}${statusMarkup()}<section class="titles-preview${waitingForIO() ? " is-loading" : ""}"${previewHeight > 0 ? ` style="min-height: ${Math.ceil(previewHeight)}px"` : ""}>
        <header class="titles-preview-toolbar"><div class="titles-preview-toolbar__start"><h3>${escapeHtml(t("titlesPreviewHeading"))}</h3>${refresh}</div><div class="titles-preview-toolbar__end">${remove}</div></header>${previewMarkup()}</section>
      <p class="titles-notice is-warning" role="status" data-title-notice${notice ? "" : " hidden"}>${escapeHtml(noticeText)}</p>
      <footer class="titles-action-bar"${primary ? "" : " hidden"}><div class="titles-action-bar__end">${primary}</div></footer>
    </div></div>`);
  }

  function onClick(event) {
    const target = event.target.closest?.("[data-title-action]");
    if (!target || target.disabled || !root.contains(target)) return;
    const action = target.dataset.titleAction;
    if (action === "preview") void run("preview", state.previewKind === "remove" ? "remove" : "assign", state.decision);
    else if (action === "back") void run("replan", "assign");
    else if (action === "remove") void run("replan", "remove");
    else if (["apply", "status", "reconcile"].includes(action)) void run(action);
  }

  function onChange(event) {
    if (choicesLocked() || !state.rulesReady || !state.active) return;
    const rule = event.target.closest?.("[data-title-rule]");
    if (rule && root.contains(rule)) {
      const { value } = rule;
      if (state.previewKind === "remove") return;
      if (!(rule.dataset.titleRule === "dateFormat" && TITLE_RULE_FORMATS.includes(value))
        && !(rule.dataset.titleRule === "mode" && ["created", "range"].includes(value))) return;
      localRuleChange = true;
      try { rulesController.update({ [rule.dataset.titleRule]: value }); }
      finally { localRuleChange = false; }
      return;
    }
    const decision = event.target.closest?.("[data-title-decision]");
    if (decision && root.contains(decision) && ["skip", "replace", "stack"].includes(decision.value)) {
      // Changing a collision decision creates a new immutable preview. It must
      // never reuse the previous planId with a different displayed title.
      void run("replan", "assign", decision.value);
    }
  }

  function update({ snapshot, preferences, active = false, translator }) {
    if (state.disposed) return;
    const next = contextFor(snapshot, ownerTabId);
    const zone = effectiveZone(preferences);
    const locale = globalThis.navigator?.language || "en-US";
    const entering = active && !state.active;
    const contextChanged = next.key !== state.contextKey;
    const rulesContextChanged = zone !== state.timeZone || locale !== state.locale;
    const metadataChanged = next.dataKey !== state.dataKey;
    let refreshChangedMetadata = false;
    if (entering || contextChanged || rulesContextChanged) state.autoRefreshBlocked = false;
    if (contextChanged) {
      clearQueuedReplan();
      replanChannel = { running: false, queued: null };
      state.generation += 1;
      state.busy = null;
      state.plan = null;
      state.displayPlan = null;
      state.previewContext = null;
      state.busyStartedAt = null;
      state.current = null;
      state.operation = null;
      state.recoveryNeeded = false;
      state.submittedPlanId = null;
      submittedRecovery.clear();
      failureNotice.clear();
      state.statusReady = false;
      state.error = "";
      state.notice = "";
      state.refreshNeeded = false;
      state.decision = "skip";
      state.previewKind = "assign";
    } else if (metadataChanged && !waitingForIO() && !rulesContextChanged && active
      && (!state.current || state.current.title !== snapshot?.conversation?.title?.value
        || state.current.createdAt !== snapshot?.conversation?.createdAt?.value
        || state.current.updatedAt !== snapshot?.conversation?.updatedAt?.value)) {
      // A genuinely different remote observation invalidates WRITE authority,
      // not the user's draft. Renew once while keeping their card/choice;
      // an identical publication of our own readback must not start a loop.
      clearQueuedReplan();
      state.generation += 1;
      state.busy = null;
      state.plan = null;
      state.previewContext = null;
      state.notice = "titlesPreviewStale";
      state.refreshNeeded = true;
      refreshChangedMetadata = true;
    } else if (rulesContextChanged || (!active && state.active && state.busy !== "apply")) {
      // Authenticated reads publish their canonical snapshot before returning
      // the plan/receipt. That self-update must not cancel the pending read.
      // Route/rule changes still invalidate it; writes recheck metadata anyway.
      discardPlan(state.plan ? "titlesPreviewStale" : "");
      state.previewContext = null;
      state.refreshNeeded = false;
    }
    state.snapshot = snapshot;
    state.contextKey = next.key;
    state.dataKey = next.dataKey;
    state.conversationId = next.id;
    state.timeZone = zone;
    state.locale = locale;
    state.active = active;
    state.t = translator || state.t;
    if (state.pendingRules && !choicesLocked()) receiveRules(rulesController.snapshot());
    if (active && !state.rulesReady) void rulesController.initialize(preferences);
    // A changed snapshot never creates an executable plan by itself. Only a
    // fresh authenticated preview can restore confirmation, and never a POST.
    if (active && state.rulesReady && next.id && !state.busy && (entering || contextChanged || rulesContextChanged)) {
      void run(unsettled() ? "status" : "preview");
    } else if (!refreshChangedMetadata || !refreshPreviewAutomatically()) render();
  }

  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  return Object.freeze({ update, dispose() {
    for (const surface of ["titles.current.notice", "titles.current.recovery"])
      globalThis.ChatGPTTidyDiagnostics?.notice({ event: "clear", surface, reasonCode: "VIEW_DISPOSED" });
    state.disposed = true;
    failureNotice.dispose();
    submittedRecovery.dispose();
    unsubscribeRules();
    clearQueuedReplan();
    state.previewContext = null;
    state.generation += 1;
    root.removeEventListener("click", onClick);
    root.removeEventListener("change", onChange);
    // This releases only the view; it does not cancel a dispatched mutation.
  }, canLeave: () => state.busy !== "apply" });
}
