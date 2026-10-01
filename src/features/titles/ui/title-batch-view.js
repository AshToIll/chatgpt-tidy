import { loadingFlowerMarkup } from "../../../platform/ui/loading-flower.js";
import { titleSnapshotContext } from "../model/title-context.js";
import { getTitleRulesController } from "./title-rules.js";
import { normalizeTitleRules, TITLE_RULE_FORMATS } from "../model/title-rules.js";

const DECISIONS = ["skip", "replace", "stack"];
const SORT_FIELDS = ["createdAt", "updatedAt"];
const PHASES = ["preview", "applying", "paused", "result"];
const STATUSES = ["ready", "skipped", "pending", "accepted", "verified", "conflict", "failed", "uncertain"];
const completed = (item) => item?.status === "accepted" || item?.status === "verified";
const esc = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const trash = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"/></svg>';

function zoneFor(preferences) {
  const value = !preferences?.timeZone || preferences.timeZone === "system"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone : preferences.timeZone;
  try { return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone; }
  catch { return "UTC"; }
}
function contextKey(snapshot) {
  return JSON.stringify([snapshot?.route?.pathname, snapshot?.route?.kind, snapshot?.conversation?.conversationId,
    snapshot?.conversation?.project?.projectId]);
}

// Stable keyed controls preserve native select menus, search focus and radio
// focus while the local preview or a directory page updates around them.
function patchNode(node, next) {
  if (node.nodeType !== next.nodeType || node.nodeName !== next.nodeName) {
    const replacement = next.cloneNode(true);
    node.replaceWith(replacement);
    // The parent cursor must follow the live replacement. The detached old
    // node has no nextSibling, which otherwise leaves stale buttons behind.
    return replacement;
  }
  if (node.nodeType !== 1) { if (node.nodeValue !== next.nodeValue) node.nodeValue = next.nodeValue; return node; }
  for (const attr of Array.from(node.attributes)) {
    // Expanded technical details are a user's local choice. A background
    // status/route observation must not collapse the text they are copying.
    if (node.nodeName === "DETAILS" && attr.name === "open") continue;
    if (!next.hasAttribute(attr.name)) node.removeAttribute(attr.name);
  }
  for (const attr of Array.from(next.attributes)) if (node.getAttribute(attr.name) !== attr.value) node.setAttribute(attr.name, attr.value);
  let cursor = node.firstChild;
  let keyedChildren;
  for (const desired of Array.from(next.childNodes)) {
    const key = desired.nodeType === 1 && desired.getAttribute("data-batch-key");
    if (key) {
      // Index this parent's live children once. A linear find for every row
      // turned even one checkbox into N squared key comparisons. Nodes still
      // move in place, preserving the same focus, controls and scroll anchor.
      if (!keyedChildren) keyedChildren = new Map(Array.from(node.children)
        .map((child) => [child.getAttribute("data-batch-key"), child]).filter(([key]) => key));
      const found = keyedChildren.get(key);
      if (found && found !== cursor) node.insertBefore(found, cursor);
      else if (!found) node.insertBefore(desired.cloneNode(true), cursor);
      cursor = found || (cursor ? cursor.previousSibling : node.lastChild);
    }
    if (!cursor) { node.append(desired.cloneNode(true)); cursor = node.lastChild; }
    else cursor = patchNode(cursor, desired);
    if (key) keyedChildren.set(key, cursor);
    cursor = cursor.nextSibling;
  }
  while (cursor) { const nextSibling = cursor.nextSibling; cursor.remove(); cursor = nextSibling; }
  if (node.nodeName === "SELECT" && node.value !== next.value) node.value = next.value;
  if (node.nodeName === "INPUT") {
    if (node.checked !== next.checked) node.checked = next.checked;
    if (node.value !== next.value) node.value = next.value;
  }
  return node;
}

// Keep the row the user is reading in view when a background directory page
// changes the sorted order. Explicit sort/search gestures choose a new view.
function captureSelectionAnchor(list) {
  if (!list?.getBoundingClientRect || list.scrollTop <= 0) return null;
  const top = list.getBoundingClientRect().top;
  const row = Array.from(list.children || []).find((child) => child.dataset?.batchSelect && child.getBoundingClientRect().bottom > top);
  return row ? { conversationId: row.dataset.batchSelect, offset: row.getBoundingClientRect().top - top } : null;
}

function restoreSelectionAnchor(list, anchor) {
  if (!list?.getBoundingClientRect || !anchor) return;
  const row = Array.from(list.children || []).find((child) => child.dataset?.batchSelect === anchor.conversationId);
  if (row) list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.offset;
}

// Coverage boundaries are not read errors. Only concrete transport/account
// evidence, or an unfinished paused checkpoint, produces a list notice.
function catalogErrorFields(error) {
  const nested = error?.details || {};
  // A bridge may attach only a stage in details. That must not erase a useful
  // top-level code/name/status from the original failure.
  return {
    code: nested.code || error?.code || "UNKNOWN", category: nested.category || error?.category || "UNKNOWN",
    status: nested.status ?? error?.status ?? null,
  };
}
function catalogIssueFor(value, failed = false) {
  const errors = Array.isArray(value?.readErrors) ? value.readErrors : [];
  const details = errors.concat(failed ? [value || {}] : []).map(catalogErrorFields);
  const code = (error) => String(error?.code || "").toUpperCase();
  if (value?.pauseReason === "account-mismatch" || details.some((error) => error?.category === "AUTH" || error?.status === 401
    || /^(?:TITLE_)?(?:AUTH|AUTH_REQUIRED|AUTH_EXPIRED|ACCOUNT_CHANGED|ACCOUNT_MISMATCH|UNAUTHORIZED)$/.test(code(error)))) return "account";
  if (value?.pauseReason === "rate-limited" || details.some((error) => error?.status === 429
    || /^(?:TITLE_)?(?:RATE_LIMITED|RATE_LIMIT)$/.test(code(error)))) return "rate";
  if (failed || errors.length || value?.error || value?.errorCode
    || value?.coverageReasons?.some((reason) => String(reason).startsWith("read-error:"))) return "read";
  if (value?.pauseReason === "catalog-superseded" && value?.phase === "paused") return "superseded";
  if (!value?.loading && value?.phase === "paused" && value?.coverageReasons?.includes("catalog-pending")) return "paused";
  return "";
}

// 格式/版本不支持时停止引导用户原样重试；诊断仍保留在读取层，不展示给用户。
function catalogUnsupported(value, failed = false) {
  const errors = Array.isArray(value?.readErrors) ? value.readErrors : [];
  return errors.concat(failed ? [value || {}] : []).map(catalogErrorFields).some(error =>
    error.code === "CATALOG_VERSION_UNSUPPORTED" || error.code === "SCHEMA" || error.category === "SCHEMA");
}

// Success is a completion screen for the run that just finished, not the next
// visit's default workspace. Only fully settled, non-actionable results can be
// dismissed; failures, unfinished items and uncertain writes retain recovery.
function settledResultReceipt(value) {
  return value?.phase === "result" && !value.nextStepId && Array.isArray(value.items)
    && value.items.every((item) => item.settled === true && (completed(item) || item.status === "skipped"));
}

/** 批量标题整理依次展示选择、预览和执行结果。
 * 目录行只供选择，不能直接决定写入内容；确认和逐条执行都使用 worker 核准的计划与步骤凭证。
 */
export function createTitleBatchView({ root, request: sendRequest, loadCatalog, ownerTabId, onChanged = () => {}, onBusyChange = () => {}, onUseCurrent = () => {},
  rulesController = getTitleRulesController() }) {
  if (!root || typeof sendRequest !== "function" || typeof loadCatalog !== "function") throw new TypeError("Batch title view requires transports");
  const state = { active: false, disposed: false, t: (key) => key, preferences: {}, context: "", batchContext: "",
    rules: null, timeZone: "UTC", locale: "en-US", initialized: false, generation: 0, catalogGeneration: 0,
    accountKey: null, rows: [], rowOrder: new Map(), catalogLoaded: false, catalogError: false, catalogIssue: "", catalogErrorOrigin: null, catalogUnsupported: false, loading: false,
    // 产品默认按创建时间从新到旧排列；只影响列表，不改变标题使用“创建日期/时间范围”的规则。
    query: "", filter: "all", sortField: "createdAt", sortDirection: "desc",
    selected: new Set(), operation: "assign", batch: null, dismissedBatchId: null, displayItems: null, decisions: {},
    busy: null, startedAt: null, replanning: false, replanRevision: 0, error: "", recovery: false, pauseReason: "",
    running: false, eligible: false, ownerConversationId: null, receiptStatusReady: false, receiptStatusError: "", receiptChecking: false,
    settledRows: new Map(), selectScroll: 0, previewScroll: 0 };
  let queue = null, channelRunning = false, returnOwnerRevision = 0;
  let observedFailure = null, receiptFailure = null; // 安全诊断旁路，不能改变批量任务状态。
  const rowMemo = new WeakMap();
  const text = (key, values) => esc(state.t(key, values));
  // Capture the bound owner when dispatching, not when a queued bridge finally
  // reads the panel's newest snapshot after the user has navigated elsewhere.
  const request = (action, payload = {}) => sendRequest(action, { ...payload, expectedConversationId: state.ownerConversationId });
  const fullRules = () => ({ ...state.rules, timeZone: state.timeZone, locale: state.locale });
  const displayItems = () => state.displayItems || state.batch?.items || [];
  const sameContext = () => !state.batchContext || state.batchContext === state.context;
  const accountBlocked = () => state.catalogIssue === "account"
    || ["titlesAuthPending", "titlesAuthExpired", "titlesAccountChanged"].includes(state.error);
  // Local directory browsing has no conversation owner. Only execution needs
  // one; a route's loading gap must not lock its checkboxes.
  const locked = () => Boolean((state.batch && !state.eligible) || state.busy || state.running || state.recovery || !sameContext());
  // Directory candidates and a durable operation receipt are independent.
  // A healthy list cannot clear a failed receipt lookup or authorize another
  // preview/write. Keep local browsing available while explicitly rechecking.
  const receiptBlocked = () => !state.receiptStatusReady || Boolean(state.receiptStatusError || state.receiptChecking);
  const editable = (item) => !item.settled && ["ready", "skipped"].includes(item.status);
  const actionable = (item) => editable(item) && item.plan?.canApply;
  // 列表与冻结的确认计划各司其职：外部标题变化只让旧预览失效，不能静默改计划。
  const changedPreviewIds = () => {
    if (state.batch?.phase !== "preview") return [];
    const rows = new Map(state.rows.map(row => [row.conversationId, row]));
    return state.batch.items.filter(item => editable(item) && rows.get(item.conversationId)?.titleChangeStartedAt != null
      && rows.get(item.conversationId).title !== item.current?.title).map(item => item.conversationId);
  };
  const hasUnknown = () => state.batch?.items.some((item) => ["pending", "uncertain"].includes(item.status));
  const needsReconciliation = () => hasUnknown() || state.error === "titlesReceiptMissing";
  const retryable = () => Boolean(state.batch && (["preview", "paused", "result"].includes(state.batch.phase) || state.recovery && state.batch.phase === "applying")
    && !needsReconciliation() && state.batch.items.some((item) => ["ready", "failed", "conflict"].includes(item.status)));
  function rowCache(current) {
    // Selection, search and count badges reuse the same frozen row. Rebuilding
    // its date parser/Intl formatters for every checkbox made large lists lag.
    // A changed title, timestamp or rule starts a fresh cache, never authority.
    const key = JSON.stringify([current.title, current.createdAt, current.updatedAt, fullRules()]);
    let cached = rowMemo.get(current);
    if (!cached || cached.key !== key) { cached = { key, plans: new Map() }; rowMemo.set(current, cached); }
    return cached;
  }
  function modelPlan(current, operation = state.operation, decision = "skip") {
    const cached = rowCache(current), key = `${operation}:${decision}`;
    if (!cached.plans.has(key)) cached.plans.set(key, globalThis.TidyTitleDates.plan(current, fullRules(), { operation, decision }));
    return cached.plans.get(key);
  }
  const phase = () => state.batch ? (state.recovery && state.batch.phase !== "result" ? "paused" : state.batch.phase) : "select";
  function setBusy(value) { state.busy = value; if (value) state.startedAt = Date.now(); }
  function setRunning(value) { if (state.running !== value) { state.running = value; onBusyChange(value); } }
  function receiveRules(snapshot = rulesController.snapshot()) {
    if (!snapshot.ready || state.disposed || state.busy || state.running || state.recovery || !sameContext()) return;
    // The module owns editable preferences; a durable receipt owns the recipe
    // already reviewed/confirmed. Never replace an applying/unknown recipe or
    // publish a restored receipt back into global preferences. Deferred changes
    // are picked up on the next safe editable boundary or return to selection.
    if (state.batch && (!state.active || state.batch.phase !== "preview" || state.operation !== "assign" || state.error)) return;
    if (state.rules?.mode === snapshot.rules.mode && state.rules?.dateFormat === snapshot.rules.dateFormat) return;
    state.rules = { ...snapshot.rules };
    if (!state.active || !state.eligible) return;
    if (state.batch) replan(); else render();
  }
  const unsubscribeRules = rulesController.subscribe(receiveRules);
  function validateReceipt(value, expectedId = null, expectedIds = null) {
    // Every receipt still needs exact target membership. Build one lookup per
    // receipt instead of scanning all expected IDs again for every item/step.
    const expectedIdSet = expectedIds && new Set(expectedIds);
    if (!value || typeof value.batchId !== "string" || !value.batchId || !PHASES.includes(value.phase)
      || (expectedId && expectedId !== value.batchId) || !["assign", "remove"].includes(value.operation)
      || typeof value.catalogAccountKey !== "string" || !value.catalogAccountKey
      || (state.accountKey && value.catalogAccountKey !== state.accountKey)
      || !Array.isArray(value.items) || new Set(value.items.map((item) => item.conversationId)).size !== value.items.length
      || (expectedIds && (value.items.length !== expectedIds.length || value.items.some((item) => !expectedIdSet.has(item.conversationId))))
      || value.items.some((item) => typeof item.conversationId !== "string" || !STATUSES.includes(item.status)
        || (item.current && (item.current.conversationId !== item.conversationId || typeof item.current.title !== "string"))
        || (item.plan && (item.plan.conversationId !== item.conversationId || typeof item.plan.before !== "string" || typeof item.plan.after !== "string")))) {
      throw Object.assign(new Error("Invalid batch response"), { code: "TITLE_INVALID_RESPONSE" });
    }
  }
  function accept(value, expectedId = null, expectedIds = null) {
    // Historical storage is normalized by the worker. The UI accepts one
    // current receipt contract and never silently discards an unknown phase.
    validateReceipt(value, expectedId, expectedIds);
    if (value.phase === "preview" || value.phase === "result") state.pauseReason = "";
    state.batch = value; state.displayItems = null; state.operation = value.operation; state.accountKey = value.catalogAccountKey;
    state.rules = normalizeTitleRules(value.rules, state.preferences);
    state.decisions = Object.fromEntries(value.items.filter((item) => item.plan?.selectedDecision).map((item) => [item.conversationId, item.plan.selectedDecision]));
    // A verified readback or accepted rename is the latest local list title.
    // Returning to selection must not resurrect the old cached title head.
    const updated = new Map(value.items.filter((item) => completed(item) && item.current).map((item) => [item.conversationId, item.current]));
    for (const [id, current] of updated) state.settledRows.set(id, { current, observedAt: Date.now() });
    if (updated.size) state.rows = state.rows.map((row) => updated.has(row.conversationId) ? { ...row, ...updated.get(row.conversationId) } : row);
    return value;
  }
  function observeError(key, error) {
    // Cause belongs to this notice, not to a later read generation. Hiding or
    // starting a read-only recheck must not erase the original safe evidence.
    observedFailure = { key, cause: globalThis.ChatGPTTidyDiagnostics?.cause(error) };
    return key;
  }
  function restoreReceiptError() {
    // Receipt lookup failures survive separate navigation/preview notices.
    // Restore the message and its own cause together, never by matching text.
    state.error = state.receiptStatusError;
    observedFailure = state.error ? receiptFailure : null;
  }
  function errorKey(error, { readingStatus = false } = {}) {
    const observe = (key) => observeError(key, error);
    if (error?.code === "TITLE_ACCOUNT_CHANGED") return observe("titlesAccountChanged");
    if (error?.code === "TITLE_AUTH_REQUIRED") return observe("titlesAuthPending");
    if (error?.code === "TITLE_AUTH_EXPIRED") return observe("titlesAuthExpired");
    if (error?.code === "TITLE_RATE_LIMITED") return observe("titlesRateLimited");
    // 进入批量页只是在读取状态，尚未生成预览；不能把身份/记录读取失败说成预览过期。
    if (readingStatus) return observe("titlesReadFailed");
    if (["TITLE_CONFLICT", "CONTEXT_MISMATCH"].includes(error?.code)) return observe("titlesConflict");
    if (["TITLE_PLAN_EXPIRED", "TITLE_PREVIEW_REQUIRED", "TITLE_INVALID_PLAN"].includes(error?.code)) return observe("titlesPlanExpired");
    return observe("titlesReadFailed");
  }
  function applyCatalog(value, generation) {
    if (!value || generation !== state.catalogGeneration || state.disposed || !state.active || !Array.isArray(value.rows)) return;
    const anchor = captureSelectionAnchor(root.querySelector?.('[data-batch-scroll="select"]'));
    if (state.accountKey && value.accountKey !== state.accountKey) {
      state.selected.clear(); state.settledRows.clear(); state.rowOrder.clear();
      // Even an empty receipt is account-scoped. Revoke the old lookup before
      // accepting the new directory; its late null result cannot unlock writes.
      state.receiptStatusReady = false;
      state.generation++; queue = null; state.replanning = false; state.receiptChecking = false;
      setBusy(null); setRunning(false);
      if (state.batch) {
        state.error = observeError("titlesAccountChanged", { code: "TITLE_ACCOUNT_CHANGED" });
        state.recovery = true; state.loading = false; render(); return;
      }
      // A fresh list is not a receipt observation. Keep selection usable and
      // offer an explicit read-only status check for this newly observed account.
      state.error = state.receiptStatusError = observeError("titlesBatchReceiptUnconfirmed", { code: "TITLE_ACCOUNT_CHANGED" });
      receiptFailure = observedFailure;
    }
    state.accountKey = value.accountKey;
    state.rows = value.rows.filter((row) => typeof row.conversationId === "string" && typeof row.title === "string")
      .map((row) => {
        if (!state.rowOrder.has(row.conversationId)) state.rowOrder.set(row.conversationId, state.rowOrder.size);
        const settled = state.settledRows.get(row.conversationId);
        if (!settled) return row;
        // An older directory page cannot undo a successful readback. A newer
        // timestamp, or a row actually observed in a scan begun after that
        // readback, ends this UI overlay. The latter also handles equal/missing
        // server timestamps without mistaking an old retained row for freshness.
        const freshScan = Number.isFinite(value.snapshotStartedAt) && value.snapshotStartedAt > settled.observedAt
          && value.generation != null && row.catalogGeneration === value.generation;
        if (row.titleChangeStartedAt > settled.observedAt || Date.parse(row.updatedAt) > Date.parse(settled.current.updatedAt) || freshScan) {
          state.settledRows.delete(row.conversationId); return row;
        }
        return { ...row, ...settled.current };
      });
    state.loading = value.loading === true; state.catalogLoaded = true;
    state.catalogIssue = catalogIssueFor(value); state.catalogError = ["account", "rate", "read"].includes(state.catalogIssue);
    state.catalogErrorOrigin = state.catalogError ? value.errorOrigin === "current" ? "current" : "previous" : null;
    state.catalogUnsupported = state.catalogError && catalogUnsupported(value);
    render({ selectionAnchor: anchor });
  }
  function readCatalog({ retry = false } = {}) {
    // Catalog reads are scoped to their authenticated directory, not the open
    // conversation. New catalog loads/hide/dispose invalidate this channel;
    // ordinary A -> B navigation only invalidates owner-bound operations.
    const generation = ++state.catalogGeneration;
    // Starting a recheck is not evidence that the account recovered. Keep the
    // account gate until an exact, fresh catalog response clears it; normal
    // background loading still permits previewing already-discovered rows.
    const checkingAccount = accountBlocked();
    state.loading = true; state.catalogError = checkingAccount; state.catalogIssue = checkingAccount ? "account" : "";
    state.catalogErrorOrigin = null; state.catalogUnsupported = false;
    state.startedAt = Date.now(); render();
    // The stream is the sole state-publication channel. The load Promise only
    // owns lifecycle/errors: its initial return can already be older than a
    // streamed page, and consuming both would render the first snapshot twice.
    // Entry needs only the first account-scoped publication before it can read
    // the local receipt pointer. Do not hold that status lookup behind a long
    // progressive scan: the catalog lifecycle may continue streaming pages.
    let settleFirst;
    const firstPublication = new Promise((resolve) => { settleFirst = resolve; });
    const publish = (value) => {
      applyCatalog(value, generation);
      if (typeof value?.accountKey === "string" && value.accountKey) settleFirst(value.accountKey);
    };
    let lifecycle;
    try {
      lifecycle = loadCatalog({ ...(retry ? { retry: true } : {}), onUpdate: publish,
        // The catalog owns scheduling. The UI only grants refresh while this
        // exact selection context is idle; review and writes do no directory I/O.
        canRefresh: () => generation === state.catalogGeneration && !state.disposed && state.active
          && !state.batch && (!state.busy || state.busy === "status") && !state.running,
      });
    } catch (error) { lifecycle = Promise.reject(error); }
    Promise.resolve(lifecycle).then(() => settleFirst(state.accountKey)).catch((error) => {
      if (generation === state.catalogGeneration) {
        state.catalogIssue = catalogIssueFor(error, true); state.catalogError = true; state.catalogErrorOrigin = "current";
        state.catalogUnsupported = catalogUnsupported(error, true);
        state.loading = false; render();
      }
      settleFirst(null);
    });
    return firstPublication;
  }
  async function enter({ retry = false, receiptRetry = false } = {}) {
    if (!state.eligible || !sameContext() || state.receiptChecking) return;
    const generation = state.generation;
    let checkingReceipt = false;
    if (accountBlocked()) state.catalogIssue = "account";
    state.receiptChecking = true; state.receiptStatusReady = false;
    setBusy(receiptRetry ? null : "status"); restoreReceiptError(); render();
    try {
      await rulesController.initialize(state.preferences);
      if (generation !== state.generation || state.disposed) return;
      if (!state.batch) state.rules = { ...rulesController.snapshot().rules };
      // Resolve the account once through the shared catalog. The status lookup
      // below is local and keyed by that account; it must not open a second
      // ChatGPT session merely to discover an optional batch receipt.
      await readCatalog({ retry });
      if (generation !== state.generation || state.disposed) return;
      // Recovery is read-only even when a durable receipt says "applying".
      // Reopening the panel never grants permission to issue another step.
      // Replan replaces the worker ID. Its response can be lost when the panel
      // hides, so reopening asks for the owner's latest durable receipt rather
      // than getting permanently stuck on an already superseded local ID.
      const receiptAccountKey = state.accountKey;
      checkingReceipt = Boolean(receiptAccountKey);
      const value = receiptAccountKey
        ? await request("batch-status", { catalogAccountKey: receiptAccountKey }) : { batchId: null };
      if (generation !== state.generation || receiptAccountKey !== state.accountKey || state.disposed || !state.active) return;
      if (!value || (value.batchId !== null && !value.batchId) || (state.batch && !value.batchId)) throw new Error("Missing batch status");
      // A dismissed page does not exempt its receipt from account/target
      // validation. No historical response may change the catalog's owner.
      if (value.batchId) validateReceipt(value, null, state.batch?.items.map((item) => item.conversationId));
      // An explicit Back/Done leaves this receipt available in storage but
      // should not reopen that same finished/review page on a module switch.
      // Unknown or applying work is never dismissed this way.
      const dismissed = !state.batch && value.batchId === state.dismissedBatchId && ["preview", "result"].includes(value.phase)
        && Array.isArray(value.items) && !value.items.some((item) => ["pending", "uncertain"].includes(item.status));
      if (value.batchId && (dismissed || settledResultReceipt(value))) {
        // The current directory owns list freshness. An old successful receipt
        // is validated history, not a new title observation: replaying it could
        // overwrite a later external edit and renew a stale overlay timestamp.
        discardDisplayBatch(value.batchId);
      } else if (value.batchId) {
        const accepted = accept(value, null, state.batch?.items.map((item) => item.conversationId));
        state.batchContext = state.context;
        state.recovery = accepted.phase === "applying" || accepted.phase === "paused"
          || accepted.items.some((item) => ["pending", "uncertain"].includes(item.status));
      }
      // Only a successfully validated receipt observation clears this gate.
      // An initial account failure can skip the lookup; it is not a recovery.
      if (checkingReceipt) {
        state.receiptStatusReady = true; state.receiptStatusError = ""; state.error = "";
        receiptFailure = null; observedFailure = null;
      }
      state.initialized = true;
    } catch (error) {
      if (generation === state.generation) {
        state.error = errorKey(error, { readingStatus: checkingReceipt });
        if (checkingReceipt) { state.receiptStatusError = state.error; receiptFailure = observedFailure; }
      }
    } finally {
      if (generation === state.generation && !state.disposed) {
        state.receiptChecking = false; setBusy(null); receiveRules(); render();
      }
    }
  }
  async function preview(ids = [...state.selected]) {
    if (locked() || receiptBlocked() || !state.eligible || accountBlocked() || !state.active || !ids.length || !state.accountKey) return;
    const generation = state.generation;
    let failed = false;
    // This is a local catalog transaction, not a ChatGPT read. Keep the guard
    // in state so a second click cannot race it, but do not repaint thousands
    // of selection rows into a transient disabled/loading copy first.
    setBusy("preview"); state.error = "";
    try {
      const value = await request("batch-preview", { conversationIds: ids, accountKey: state.accountKey, rules: fullRules(), operation: state.operation });
      if (generation !== state.generation || state.disposed) return;
      accept(value, null, ids);
      state.batchContext = state.context; state.recovery = false; state.previewScroll = 0;
    } catch (error) { if (generation === state.generation) { failed = true; state.error = errorKey(error); } }
    finally {
      if (generation === state.generation) {
        setBusy(null); receiveRules(); render();
        // Preview temporarily closes the selection-only refresh gate. If it
        // fails before creating a batch, an in-flight directory page may have
        // paused at that gate. Resume the list once, keeping the preview error;
        // never retry preview, preparation, or a write here.
        if (failed && !state.disposed && state.active && state.eligible && !state.batch) void readCatalog();
      }
    }
  }
  function replan() {
    if (locked() || receiptBlocked() || !state.batch || state.batch.phase !== "preview" || changedPreviewIds().length) return;
    const generation = state.generation, revision = ++state.replanRevision, batchId = state.batch.batchId;
    state.error = ""; state.replanning = true;
    state.displayItems = state.batch.items.map((item) => editable(item) && item.current ? { ...item,
      plan: modelPlan(item.current, state.operation, state.decisions[item.conversationId] || "skip") } : item);
    // Render before transport. A radio or date format change has zero I/O and
    // never owns the flower, disables another choice, or collapses its card.
    render();
    queue = { generation, revision, batchId, rules: fullRules(), decisions: { ...state.decisions } };
    void pumpReplan();
  }
  async function pumpReplan() {
    if (channelRunning || !queue) return;
    channelRunning = true;
    while (queue) {
      const job = queue; queue = null;
      if (state.disposed || job.generation !== state.generation || !state.active || !state.eligible || receiptBlocked()) continue;
      try {
        // Replan replaces the batch authority. A queued rule edit must address
        // the newly returned ID, never the ID captured when it was clicked.
        const value = await request("batch-replan", { batchId: state.batch.batchId, rules: job.rules, decisions: job.decisions });
        if (!state.disposed && job.generation === state.generation) {
          const desired = { rules: state.rules, decisions: state.decisions, items: state.displayItems };
          accept(value, null, state.batch.items.map((item) => item.conversationId));
          if (job.revision === state.replanRevision) { state.replanning = false; render(); }
          else { state.rules = desired.rules; state.decisions = desired.decisions; state.displayItems = desired.items; }
        }
      } catch (error) {
        if (!state.disposed && job.generation === state.generation && job.revision === state.replanRevision) {
          state.replanning = false; state.error = errorKey(error); render();
        }
      }
    }
    channelRunning = false;
  }
  async function apply() {
    if (locked() || receiptBlocked() || state.replanning || state.error || !state.active || state.batch?.phase !== "preview" || changedPreviewIds().length) return;
    if (!displayItems().some(actionable)) { backToSelection(); return; }
    const generation = state.generation, batchId = state.batch.batchId;
    setRunning(true); setBusy("apply"); state.error = ""; render();
    let stepDispatched = false;
    try {
      let value = await request("batch-apply", { batchId });
      if (generation !== state.generation || state.disposed) return;
      value = accept(value, batchId, state.batch.items.map((item) => item.conversationId));
      render();
      const consumedSteps = new Set();
      // One explicit confirmation authorizes this run only. A failed bridge,
      // context change or reused token stops it; nothing silently resumes.
      while (value.phase === "applying" && state.active && generation === state.generation && !state.disposed) {
        const stepId = value.nextStepId;
        if (typeof stepId !== "string" || !stepId || consumedSteps.has(stepId)) throw new Error("Missing next step token");
        consumedSteps.add(stepId);
        // Mark before dispatch: a thrown response can follow a completed write.
        stepDispatched = true;
        value = await request("batch-step", { batchId, stepId });
        if (generation !== state.generation || state.disposed) return;
        value = accept(value, batchId, state.batch.items.map((item) => item.conversationId));
        render();
      }
      state.recovery = value.phase === "paused" || value.phase === "applying";
      if (value.items.some(completed)) onChanged();
    } catch (error) {
      if (generation === state.generation && !state.disposed) {
        // Only this explicit worker rejection proves the start was refused.
        // Once any step was dispatched, even the same code requires read-only
        // reconciliation. Neither branch automatically retries a title write.
        const rejectedStart = !stepDispatched && state.batch?.phase === "preview"
          && !hasUnknown() && error?.code === "TITLE_PLAN_EXPIRED";
        state.recovery = !rejectedStart;
        state.error = rejectedStart ? errorKey(error) : observeError("titlesReceiptMissing", error);
      }
    } finally {
      if (generation === state.generation) { setBusy(null); setRunning(false); render(); }
    }
  }
  async function reconcile() {
    if (state.busy || state.running || receiptBlocked() || !state.active || !state.eligible || !state.batch || !sameContext()) return;
    const generation = state.generation, batchId = state.batch.batchId;
    setBusy("reconcile"); state.error = ""; render();
    try {
      const value = await request("batch-reconcile", { batchId });
      if (generation !== state.generation || state.disposed) return;
      accept(value, batchId, state.batch.items.map((item) => item.conversationId));
      state.recovery = ["paused", "applying"].includes(value.phase);
      if (value.items.some(completed)) onChanged();
    } catch (error) { if (generation === state.generation) state.error = errorKey(error); }
    finally { if (generation === state.generation) { setBusy(null); receiveRules(); render(); } }
  }
  async function retryPreview() {
    if (state.busy || state.running || receiptBlocked() || state.replanning || !state.active || !state.eligible || !sameContext()
      || !state.batch || needsReconciliation() || !(["preview", "paused", "result"].includes(state.batch.phase)
        || state.recovery && state.batch.phase === "applying")) return;
    const generation = state.generation, ids = state.batch.items.map((item) => item.conversationId);
    // This explicit new review can adopt preferences deferred by a failed or
    // completed receipt. Merely receiving a shared-setting notification cannot
    // clear that error, retry the failed replan, or resume an unknown write.
    const shared = rulesController.snapshot();
    if (state.operation === "assign" && shared.ready) state.rules = { ...shared.rules };
    setBusy("preview"); state.error = ""; render();
    try {
      // A retry is a new read-only review, not a new write attempt. The worker
      // retains settled successes/skips and rereads only the remaining items.
      const changedIds = changedPreviewIds();
      const requested = { rules: fullRules(), decisions: { ...state.decisions },
        ...(changedIds.length ? { refreshConversationIds: changedIds } : {}) };
      let value;
      // A reopened live-worker run can still say "applying" while the panel
      // has stopped sending steps. One explicit Review action first revokes
      // that run read-only; users need not discover a meaningless Recheck hop.
      if (state.batch.phase === "applying") {
        value = await request("batch-reconcile", { batchId: state.batch.batchId });
        if (generation !== state.generation || state.disposed) return;
        value = accept(value, state.batch.batchId, ids);
        if (hasUnknown()) { state.recovery = true; render(); return; }
      }
      try { value = await request("batch-retry-preview", { batchId: state.batch.batchId, ...requested }); }
      catch (error) {
        if (error?.code !== "TITLE_PREVIEW_REQUIRED") throw error;
        if (generation !== state.generation || state.disposed) return;
        // A lost replan response may have invalidated the ID still on screen.
        // Discover it once, read-only. An applying/unknown receipt is recovery,
        // never permission to resume or to replace it with another review.
        const latest = await request("batch-status", { catalogAccountKey: state.accountKey });
        if (generation !== state.generation || state.disposed) return;
        accept(latest, null, ids);
        if (["applying", "paused"].includes(latest.phase) || hasUnknown()) { state.recovery = true; return; }
        value = await request("batch-retry-preview", { batchId: latest.batchId, ...requested });
      }
      if (generation !== state.generation || state.disposed) return;
      accept(value, null, ids);
      state.recovery = false; state.previewScroll = 0;
    } catch (error) { if (generation === state.generation) state.error = errorKey(error); }
    finally { if (generation === state.generation) { setBusy(null); receiveRules(); render(); } }
  }
  function backToSelection() {
    if (state.busy || state.running || state.receiptChecking || state.replanning || state.recovery) return;
    discardDisplayBatch();
    receiveRules(); render(); void readCatalog();
  }
  function discardDisplayBatch(batchId = state.batch?.batchId) {
    // A read-only preview is not an in-flight write. Keep its selections and
    // directory cache, but never keep authority tied to the previous route.
    // Durable receipts remain in the worker; this only dismisses their UI.
    state.dismissedBatchId = batchId || null;
    state.batch = null; state.batchContext = ""; state.displayItems = null; state.decisions = {};
    restoreReceiptError(); state.pauseReason = ""; state.recovery = false; state.loading = false;
  }
  // A title-date rule conflict is not a save conflict. The latter is live
  // metadata/title drift, even when the original title contains no date.
  function itemStatusKey(item) {
    if (item.status === "conflict" && ["title_unchanged", "title_rechecked"].includes(item.messageCode)) return "titlesBatchReviewRequired";
    if (item.status === "conflict") return item.messageCode === "dates_changed" ? "titlesBatchTimeChanged"
      : item.messageCode === "title_conflict" ? "titlesBatchTitleChanged" : "titlesBatchMetadataChanged";
    return { ready: "titlesBatchWaiting", skipped: "titlesBatchSkipped", pending: "titlesBatchWorking",
      accepted: "titlesBatchAccepted", verified: "titlesBatchSaved", failed: "titlesBatchFailed", uncertain: "titlesBatchUncertain" }[item.status];
  }
  function pauseExplanation() {
    if (needsReconciliation()) return "titlesBatchPauseUnknown";
    const reason = state.batch?.pauseReason || state.pauseReason;
    if (reason === "rate-limited") return "titlesRateLimited";
    if (reason === "context-changed") return "titlesConflict";
    if (reason === "panel-hidden") return "titlesBatchPauseHidden";
    if (reason === "runtime-restarted") return "titlesBatchPauseRestarted";
    return "titlesBatchPauseReview";
  }
  function issueDetailsMarkup() {
    const issues = state.batch?.items.filter(item => ["conflict", "failed", "uncertain"].includes(item.status)) || [];
    if (!issues.length) return "";
    return `<details class="titles-batch-issue-details" data-batch-key="issue-details"><summary>${text("titlesBatchIssueDetails")}</summary>${issues.map((item) => {
      const reason = item.status === "conflict" ? item.messageCode === "title_unchanged" ? "titlesUnchanged"
        : item.messageCode === "title_rechecked" ? "titlesRecoveryReady"
        : item.messageCode === "dates_changed" ? "titlesBatchTimeChangedHelp"
        : item.messageCode === "title_conflict" ? "titlesBatchTitleChangedHelp" : "titlesBatchMetadataChangedHelp"
        : item.status === "uncertain" ? "titlesUncertain"
        : item.messageCode === "title_not_dispatched" ? "titlesNotDispatched" : "titlesFailed";
      return `<article><strong>${esc(item.plan?.before || item.current?.title || "—")}</strong><p>${text(reason)}</p></article>`;
    }).join("")}</details>`;
  }
  function dateLabel(row) {
    const cached = rowCache(row);
    if (cached.dateLabel === undefined) cached.dateLabel = globalThis.TidyTimeFormat?.formatRange(row.createdAt, row.updatedAt, fullRules()) || "";
    return cached.dateLabel;
  }
  function searchRows() {
    const terms = state.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return state.rows.filter((row) => terms.every((term) => row.title.toLocaleLowerCase().includes(term)));
  }
  function candidates(rows = searchRows()) {
    return rows.filter((row) => {
      const plan = modelPlan(row, "assign");
      if (state.operation === "remove" || state.filter === "has-head") return plan.hasDateHead;
      if (state.filter === "no-head") return !plan.hasDateHead;
      if (state.filter === "decision") return plan.needsDecision;
      return true;
    }).sort((left, right) => {
      const a = typeof left[state.sortField] === "string" ? Date.parse(left[state.sortField]) : NaN;
      const b = typeof right[state.sortField] === "string" ? Date.parse(right[state.sortField]) : NaN;
      const aKnown = Number.isFinite(a), bKnown = Number.isFinite(b);
      // Unknown times remain last in either direction. The discovery order is
      // a stable tie-breaker, even when a refreshed source reverses its rows.
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      const difference = aKnown ? (a - b) * (state.sortDirection === "asc" ? 1 : -1) : 0;
      return difference || (state.rowOrder.get(left.conversationId) ?? 0) - (state.rowOrder.get(right.conversationId) ?? 0);
    });
  }
  const selectable = (row) => state.operation !== "remove" || modelPlan(row, "remove").canApply;
  function statusMarkup() {
    const waiting = Boolean(state.busy || state.receiptChecking || (phase() === "select" && state.loading));
    const caption = !waiting ? "" : state.busy === "apply" ? "titlesSaving" : state.busy === "status" || state.receiptChecking ? "titlesBatchCheckingStatus"
      : state.busy === "preview" ? "titlesPreviewing" : phase() === "select"
        ? state.rows.length ? "titlesBatchCatalogRefreshing" : "titlesBatchCatalogLoading" : "titlesPreviewing";
    // The fixed flower already communicates ordinary loading visually. Keep
    // the exact operation for screen readers, not as a second visible notice.
    return `<div class="titles-status titles-batch-status" data-batch-key="status" role="status" aria-live="polite" aria-busy="${waiting}">${waiting ? loadingFlowerMarkup(state.startedAt) : ""}<span class="titles-status__label--sr-only">${text(caption)}</span></div>`;
  }
  function noticeMarkup() {
    const rateLimited = phase() === "paused" && state.batch?.items.some(item => item.messageCode === "TITLE_RATE_LIMITED");
    const catalogRate = state.catalogErrorOrigin === "current" ? "titlesBatchCatalogRateLimited" : "titlesBatchCatalogPreviousRateLimit";
    const catalogRead = state.catalogErrorOrigin === "current" ? "titlesBatchCatalogReadFailed" : "titlesBatchCatalogPreviousReadFailed";
    // A receipt lookup is not a directory read. Keep precise account/rate
    // errors, but name the blocked operation instead of suggesting list retry.
    const operationNotice = state.receiptStatusError && state.error === "titlesReadFailed"
      ? "titlesBatchReceiptUnconfirmed" : state.error;
    const unsupported = !state.error && phase() === "select" && state.catalogIssue === "read" && state.catalogUnsupported;
    const notice = operationNotice || (changedPreviewIds().length ? "titlesPreviewStale" : "") || (rateLimited ? "titlesRateLimited" : "") || (unsupported ? "titlesCatalogUnsupported" : "") || (phase() === "select" ? { account: "titlesBatchCatalogAccount", rate: catalogRate,
      read: catalogRead, paused: "titlesBatchCatalogPaused", superseded: "titlesBatchCatalogSuperseded" }[state.catalogIssue] : "");
    globalThis.ChatGPTTidyDiagnostics?.notice({ event: state.active && notice ? "show" : "clear",
      surface: "titles.batch.notice", source: "src/features/titles/ui/title-batch-view.js",
      messageKey: notice, ...(state.error && observedFailure?.key === state.error
        ? observedFailure.cause : { reasonCode: "OBSERVATION_ONLY_UNSPECIFIED" }) });
    const informational = !state.error && phase() === "select" && (["paused", "superseded"].includes(state.catalogIssue)
      || ["rate", "read"].includes(state.catalogIssue) && state.catalogErrorOrigin !== "current");
    // 恢复按钮紧跟短提示，不能藏到长列表底部。内部诊断不交给用户阅读。
    const resume = ["paused", "superseded"].includes(state.catalogIssue);
    // 仅状态读取失败时重读状态，不强制重扫列表；列表也失败时才一起重新读取。
    const action = state.receiptStatusError && !state.catalogIssue && !accountBlocked() ? "recheck-status" : unsupported ? "use-current" : resume ? "resume-catalog" : "reload";
    const label = state.receiptStatusError ? "titlesBatchRecheckStatus" : unsupported ? "currentConversation"
      : resume ? "titlesBatchCatalogContinue" : state.catalogIssue === "account" ? "reconnect" : "titlesBatchRetryRead";
    const recovery = phase() === "select" && (state.error || state.catalogIssue)
      ? `<button type="button" data-batch-action="${action}"${locked() || state.receiptChecking || state.receiptStatusError && !state.eligible ? " disabled" : ""}>${text(label)}</button>` : "";
    return notice ? `<div class="titles-notice titles-catalog-notice${informational ? "" : " is-warning"}" role="status" data-batch-key="notice" data-catalog-issue="${esc(state.catalogIssue)}" data-catalog-origin="${esc(state.catalogErrorOrigin || "")}"><span>${text(notice, { count: state.rows.length })}</span>${recovery}</div>` : "";
  }
  function selectMarkup() {
    const searched = searchRows(), rows = candidates(searched), enabled = rows.filter(selectable);
    // The toolbar describes this search/filter view. Hidden selections remain
    // in the basket and count toward the footer preview, not this local count.
    const visibleSelected = rows.filter((row) => state.selected.has(row.conversationId)).length;
    const counts = { all: searched.length, "no-head": 0, "has-head": 0, decision: 0 };
    for (const row of searched) { const plan = modelPlan(row, "assign"); counts[plan.hasDateHead ? "has-head" : "no-head"]++; if (plan.needsDecision) counts.decision++; }
    const filters = [["all", "titlesBatchAll"], ["no-head", "titlesBatchNoDate"], ["has-head", "titlesBatchHasDate"], ["decision", "titlesBatchDateConflict"]];
    const removing = state.operation === "remove", selectedAll = enabled.length && enabled.every((row) => state.selected.has(row.conversationId));
    const removable = searched.some((row) => modelPlan(row, "remove").canApply);
    const removeEntry = removing || (state.filter === "has-head" && removable)
      ? `<section class="titles-batch-remove-shortcut${removing ? " is-active" : ""}" data-batch-key="remove"><button data-batch-action="${removing ? "exit-remove" : "remove"}" type="button"${locked() ? " disabled" : ""}>${trash}<span>${text(removing ? "titlesBatchExitRemove" : "titlesRemove")}</span></button>${removing ? `<span>${text("titlesBatchSelectRemove")}</span>` : ""}</section>` : "";
    const sortLabel = state.t(state.sortDirection === "asc" ? "sortAscending" : "sortDescending", { field: state.t(state.sortField === "createdAt" ? "createdTime" : "updatedTime") });
    const countsKnown = state.catalogLoaded && (state.rows.length > 0 || (!state.loading && !state.catalogIssue && !state.error));
    // "Not observed yet" is not a zero-row query result. Preserve known cached
    // rows/counts on a failed recheck, but do not invent zero before first load.
    const emptyLabel = state.loading || state.busy ? "titlesBatchCatalogLoading"
      : !state.catalogLoaded || state.catalogError || state.error || state.catalogIssue
        ? "titlesBatchCatalogUnconfirmed" : "titlesBatchEmpty";
    return `${removing ? "" : rulesMarkup()}<label class="titles-batch-search" data-batch-key="search"><span aria-hidden="true">⌕</span><input type="search" data-batch-query value="${esc(state.query)}" placeholder="${text("titlesBatchSearch")}" aria-label="${text("titlesBatchSearch")}"${state.busy ? " disabled" : ""}></label>
      <section class="titles-batch-status-tabs" data-batch-key="filters" aria-label="${text("titlesBatchFilter")}">${filters.map(([id, label]) => `<button type="button" data-batch-filter="${id}" aria-pressed="${state.filter === id}"${(removing && id !== "has-head") || locked() ? " disabled" : ""}><span>${text(label)}</span><strong>${countsKnown ? counts[id] : "—"}</strong></button>`).join("")}</section>
      <section class="titles-batch-select-toolbar" data-batch-key="toolbar"><span>${countsKnown ? text("titlesBatchSelectionCount", { total: rows.length, selected: visibleSelected }) : text("titlesBatchCatalogUnconfirmed")}</span><div class="titles-batch-list-tools"><label class="titles-batch-sort-field"><select data-batch-sort-field aria-label="${text("titlesBatchSortField")}"${locked() ? " disabled" : ""}>${SORT_FIELDS.map((field) => `<option value="${field}"${state.sortField === field ? " selected" : ""}>${text(field === "createdAt" ? "createdTime" : "updatedTime")}</option>`).join("")}</select></label><button class="titles-batch-sort-direction" type="button" data-batch-action="sort-direction" aria-label="${esc(sortLabel)}" title="${esc(sortLabel)}"${locked() ? " disabled" : ""}>${state.sortDirection === "asc" ? "↑" : "↓"}</button><button type="button" data-batch-action="select-all"${!enabled.length || locked() ? " disabled" : ""}>${text(selectedAll ? "titlesBatchDeselectAll" : "titlesBatchSelectAll")}</button></div></section>${removeEntry}${statusMarkup()}${noticeMarkup()}${state.catalogLoaded && !state.eligible ? `<p class="titles-notice" role="status" data-batch-key="owner-unavailable">${text("titlesBatchOwnerUnavailable")}</p>` : ""}
      <div class="titles-batch-select-list" data-batch-scroll="select" data-batch-key="list">${rows.map((row) => {
        const selected = state.selected.has(row.conversationId), plan = modelPlan(row, removing ? "remove" : "assign");
        const label = removing ? !plan.canApply ? "titlesBatchCannotRemove" : "" : plan.needsDecision ? "titlesBatchDateConflict" : plan.noOp ? "titlesNoChange" : "";
        return `<button class="titles-batch-select-row${selected ? " is-selected" : ""}${label ? "" : " has-no-status"}" data-batch-key="row-${esc(row.conversationId)}" data-batch-select="${esc(row.conversationId)}" type="button" aria-pressed="${selected}"${locked() || (!selectable(row) && !selected) ? " disabled" : ""}><span class="titles-batch-check" aria-hidden="true"></span><span><strong title="${esc(row.title)}">${esc(row.title)}</strong><small>${esc(dateLabel(row))}</small></span>${label ? `<em class="${plan.needsDecision ? "is-risk" : ""}">${text(label)}</em>` : ""}</button>`;
      }).join("") || `<div class="titles-batch-empty">${text(emptyLabel)}</div>`}</div>
      <footer class="titles-batch-select-footer is-action-only" data-batch-key="footer"><button type="button" data-batch-action="preview"${!state.eligible || !state.selected.size || !state.accountKey || locked() || receiptBlocked() || accountBlocked() ? " disabled" : ""}>${text(removing ? "titlesBatchPreviewRemove" : "titlesBatchPreview", { count: state.selected.size })}</button></footer>`;
  }
  function rulesMarkup() {
    const formats = [["locale", state.t("titlesRegional")], ...Object.entries(globalThis.TidyTimeFormat.dateFormatLabels(state.timeZone))];
    const select = (field, values, label) => `<label class="titles-rule-select"><select data-batch-rule="${field}" aria-label="${text(label)}"${locked() || state.batch && receiptBlocked() || !state.rules ? " disabled" : ""}>${values.map(([value, caption]) => `<option value="${value}"${state.rules?.[field] === value ? " selected" : ""}>${esc(caption)}</option>`).join("")}</select><span class="titles-rule-select__chevron" aria-hidden="true"></span></label>`;
    return `<section class="titles-rule" data-batch-key="rules"><h3>${text("titlesRules")}</h3><div class="titles-rule-controls">${select("dateFormat", formats, "titlesBatchFormat")}${select("mode", [["created", state.t("titlesCreatedDate")], ["range", state.t("titlesRange")]], "titlesDateBasis")}</div></section>`;
  }
  function reviewMarkup() {
    const items = displayItems(), removing = state.operation === "remove";
    const stale = changedPreviewIds().length > 0;
    const completedItems = items.filter(completed);
    const conflicts = removing ? [] : items.filter((item) => editable(item) && item.plan?.needsDecision);
    const changed = items.filter((item) => !conflicts.includes(item) && actionable(item));
    const unchanged = items.filter((item) => !completedItems.includes(item) && !conflicts.includes(item) && !changed.includes(item));
    const count = items.filter(actionable).length;
    const skipped = items.filter((item) => item.status === "skipped" && !actionable(item)).length;
    const staticLabel = (item) => item.status === "accepted" ? "titlesBatchAccepted" : item.status === "verified" ? "titlesBatchSaved" : item.status === "failed" ? "titlesBatchFailed"
      : item.status === "conflict" ? itemStatusKey(item) : item.plan?.noOp ? "titlesNoChange" : removing ? "titlesBatchCannotRemove" : "titlesBatchSkipped";
    const rows = (group, staticRows = false) => group.map((item) => `<article class="titles-batch-compact-row${staticRows ? " is-unchanged" : ""}" data-batch-key="row-${esc(item.conversationId)}"><strong title="${esc(completed(item) ? item.current?.title : item.plan?.before || item.current?.title)}">${esc((completed(item) ? item.current?.title : item.plan?.before || item.current?.title) || "—")}</strong>${staticRows ? `<em>${text(staticLabel(item))}</em>` : `<small><b aria-hidden="true">→</b><span title="${esc(item.plan?.after)}">${esc(item.plan?.after || "—")}</span></small>`}</article>`).join("");
    const group = (label, entries, staticRows = false) => entries.length ? `<section class="titles-batch-preview-group" data-batch-key="group-${label}"><header><span>${text(label)}</span></header><div>${rows(entries, staticRows)}</div></section>` : "";
    return `<header class="titles-batch-back-header" data-batch-key="back"><button type="button" data-batch-action="back" aria-label="${text("titlesBatchBackSelection")}"${locked() || state.receiptChecking || state.replanning ? " disabled" : ""}>‹</button><strong>${text(removing ? "titlesBatchBackRemove" : "titlesBatchBackSelection")}</strong><span aria-hidden="true"></span></header>
      ${removing ? "" : rulesMarkup()}${statusMarkup()}<section class="titles-batch-summary" data-batch-key="summary"><strong>${text("titlesBatchReviewCount", { count: items.length })}</strong></section>${noticeMarkup()}
      <div class="titles-batch-preview-list" data-batch-scroll="preview" data-batch-key="list">${conflicts.length ? `<section class="titles-batch-exceptions" data-batch-key="conflicts"><header><strong>${text("titlesBatchConflictsHeading", { count: conflicts.length })}</strong></header>${conflicts.map((item) => `<article class="titles-batch-conflict-row" data-batch-key="conflict-${esc(item.conversationId)}"><strong title="${esc(item.plan.before)}">${esc(item.plan.before)}</strong><small><b aria-hidden="true">→</b><span title="${esc(item.plan.after)}">${esc(item.plan.after)}</span></small><fieldset class="titles-decision-options" aria-label="${esc(item.plan.before)}"${locked() || receiptBlocked() ? " disabled" : ""}>${DECISIONS.map((decision) => `<label class="${item.plan.selectedDecision === decision ? "is-selected" : ""}"><input type="radio" name="batch-decision-${esc(item.conversationId)}" data-batch-decision="${esc(item.conversationId)}" value="${decision}"${item.plan.selectedDecision === decision ? " checked" : ""}>${text({ skip: "titlesSkip", replace: "titlesReplace", stack: "titlesStack" }[decision])}</label>`).join("")}</fieldset></article>`).join("")}</section>` : ""}${group(removing ? "titlesBatchRemovePreview" : "titlesBatchAdd", changed)}${group(removing ? "titlesBatchCannotRemove" : "titlesBatchUnchanged", unchanged, true)}${group("titlesBatchSaved", completedItems, true)}</div>
      <footer class="titles-batch-select-footer" data-batch-key="footer"><span>${skipped ? text(removing ? "titlesBatchSkipRemoveCount" : "titlesBatchSkipCount", { count: skipped }) : ""}</span>${(state.error || stale) && !state.receiptStatusError ? `<button class="is-secondary" type="button" data-batch-action="refresh-preview"${locked() ? " disabled" : ""}>${text("titlesBatchRetryRead")}</button>` : ""}<button type="button" data-batch-action="apply"${locked() || receiptBlocked() || state.replanning || state.error || stale ? " disabled" : ""}>${count ? text(removing ? "titlesBatchConfirmRemove" : "titlesBatchApply", { count }) : text("titlesBatchDone")}</button></footer>`;
  }
  function progressMarkup() {
    const items = state.batch.items, paused = phase() === "paused" || state.recovery;
    // 暂停时只保留一条主原因；已有具体错误时，不再叠加通用暂停说明和实现保证。
    const notice = noticeMarkup();
    const done = items.filter((item) => ["accepted", "verified", "skipped", "conflict", "failed"].includes(item.status)).length;
    const actionDisabled = state.busy || receiptBlocked() || !state.eligible || !sameContext() ? " disabled" : "";
    const pausedActions = paused ? `<div class="titles-batch-result-actions">${retryable()
      ? `<button type="button" data-batch-action="retry-preview"${actionDisabled}>${text("titlesBatchPreviewRemaining")}</button>`
      : `<button type="button" data-batch-action="reconcile"${actionDisabled}>${text("titlesReconcile")}</button>`}</div>` : "";
    const ownerAction = !sameContext() ? `<button type="button" data-batch-action="return-owner"${state.busy || state.running ? " disabled" : ""}>${text("titlesBatchReturnOwner")}</button>` : "";
    const saved = items.filter(completed).length;
    const waiting = items.filter(item => item.status === "ready").length;
    const rowsMarkup = items.map((item) => `<article class="titles-batch-progress-row is-${item.status}" data-batch-key="progress-${esc(item.conversationId)}"><span class="titles-batch-progress-state" aria-hidden="true">${completed(item) ? "✓" : ["conflict", "failed", "uncertain"].includes(item.status) ? "!" : item.status === "skipped" ? "–" : ""}</span><strong title="${esc(item.current?.title || item.plan?.before)}">${esc(item.current?.title || item.plan?.before || "—")}</strong><em>${text(itemStatusKey(item))}</em></article>`).join("");
    return `${statusMarkup()}<section class="titles-batch-progress-hero" data-batch-key="hero"><strong>${text(paused ? "titlesBatchPaused" : state.operation === "remove" ? "titlesBatchRemoving" : "titlesBatchApplying")}</strong><small>${done} / ${items.length}</small>${paused ? `<small>${text("titlesBatchProgressSummary", { saved, waiting })}</small>` : ""}</section>${notice}
      ${paused && !notice ? `<p class="titles-batch-pause-explanation">${text(pauseExplanation())}</p>` : ""}
      <div class="titles-batch-progress-list" data-batch-key="list">${rowsMarkup}</div>${issueDetailsMarkup()}
      ${!paused ? `<p>${text("titlesBatchKeepOpen")}</p>` : ""}${pausedActions}${ownerAction}`;
  }
  function resultMarkup() {
    const items = state.batch.items, counts = {};
    for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
    const issues = (counts.failed || 0) + (counts.conflict || 0) + (counts.uncertain || 0);
    const saved = (counts.accepted || 0) + (counts.verified || 0);
    return `${statusMarkup()}<section class="titles-batch-result-hero" data-batch-key="hero"><span class="${issues ? "is-warning" : ""}" aria-hidden="true">${issues ? "!" : "✓"}</span><strong>${text(saved ? state.operation === "remove" ? "titlesBatchRemovedResult" : "titlesBatchUpdatedResult" : "titlesBatchNoChanges", { count: saved })}</strong></section>${noticeMarkup()}<section class="titles-batch-result-details" data-batch-key="details">${[["skipped", "titlesBatchSkipCount"], ["failed", "titlesBatchFailedCount"], ["conflict", "titlesBatchConflictCount"], ["uncertain", "titlesBatchUncertainCount"]].filter(([status]) => counts[status]).map(([status, key]) => `<span>${text(key, { count: counts[status] })}</span>`).join("")}</section>${issueDetailsMarkup()}<div class="titles-batch-result-actions" data-batch-key="actions">${retryable() ? `<button type="button" data-batch-action="retry-preview"${locked() || receiptBlocked() ? " disabled" : ""}>${text("titlesBatchRetryFailed")}</button>` : ""}<button type="button" data-batch-action="finish"${locked() || state.receiptChecking ? " disabled" : ""}>${text("titlesBatchBack")}</button></div>`;
  }
  function render({ selectionAnchor = null, resetSelectionScroll = false } = {}) {
    if (state.disposed || !state.active) return;
    if (!state.eligible && !state.batch && !state.catalogLoaded) {
      for (const surface of ["titles.batch.notice", "titles.batch.receipt"])
        globalThis.ChatGPTTidyDiagnostics?.notice({ event: "clear", surface, reasonCode: "NOTICE_HIDDEN" });
      root.innerHTML = `<div class="titles-batch-empty">${text("titlesNeedsConversation")}</div>`;
      root.setAttribute?.("aria-busy", "false");
      return;
    }
    const previous = root.querySelector?.("[data-batch-scroll]");
    if (previous) state[previous.dataset.batchScroll === "select" ? "selectScroll" : "previewScroll"] = previous.scrollTop;
    if (resetSelectionScroll) state.selectScroll = 0;
    const viewPhase = phase();
    // The selection footer already retries the failed receipt lookup. Restored
    // preview/result/recovery screens need the same read-only way out, without
    // disguising a status recheck as a new preview or an apply/reconcile action.
    // Account drift can invalidate an in-flight check before batch-status was
    // requested, leaving no receipt error string. Readiness, not that string,
    // owns this escape hatch; enter() still revalidates the catalog account and
    // stops before querying the old batch whenever that account does not match.
    const receiptNotice = (!state.receiptStatusReady || state.receiptStatusError) && viewPhase !== "select"
      ? `<div class="titles-notice is-warning" data-batch-key="receipt-status"><span>${text("titlesBatchReceiptUnconfirmed")}</span><button class="titles-button" type="button" data-batch-action="recheck-status"${state.busy || state.running || state.receiptChecking || !state.eligible || !sameContext() ? " disabled" : ""}>${text("titlesBatchRecheckStatus")}</button></div>` : "";
    globalThis.ChatGPTTidyDiagnostics?.notice({ event: receiptNotice ? "show" : "clear",
      surface: "titles.batch.receipt", source: "src/features/titles/ui/title-batch-view.js",
      messageKey: "titlesBatchReceiptUnconfirmed", reasonCode: "RECEIPT_STATE_UNCONFIRMED" });
    const markup = `<div class="titles-batch titles-batch--${viewPhase}" data-batch-key="${viewPhase}">${receiptNotice}${viewPhase === "select" ? selectMarkup() : viewPhase === "preview" ? reviewMarkup() : viewPhase === "result" ? resultMarkup() : progressMarkup()}</div>`;
    if (root.ownerDocument?.createElement && root.firstChild) {
      const template = root.ownerDocument.createElement("template"); template.innerHTML = markup;
      patchNode(root.firstChild, template.content.firstChild);
    } else root.innerHTML = markup;
    root.setAttribute?.("aria-busy", String(Boolean(state.busy || state.receiptChecking || state.loading && viewPhase === "select")));
    const scroller = root.querySelector?.("[data-batch-scroll]");
    if (scroller) {
      scroller.scrollTop = state[scroller.dataset.batchScroll === "select" ? "selectScroll" : "previewScroll"];
      if (scroller.dataset.batchScroll === "select" && selectionAnchor && !resetSelectionScroll) {
        restoreSelectionAnchor(scroller, selectionAnchor); state.selectScroll = scroller.scrollTop;
      }
    }
  }
  function onClick(event) {
    const node = event.target.closest?.("[data-batch-action], [data-batch-select], [data-batch-filter]");
    if (!node || !root.contains(node) || node.disabled || !state.active || state.disposed) return;
    const action = node.dataset.batchAction;
    if (action === "recheck-status") {
      if (!state.busy && !state.running && receiptBlocked()) void enter({ receiptRetry: true });
      return;
    }
    if (action === "return-owner" && !state.busy && !state.running && !sameContext()) {
      // Navigation does not confirm/retry any operation. The worker validates
      // the exact panel tab and the captured ChatGPT route independently.
      const pathname = JSON.parse(state.batchContext)[0];
      const revision = ++returnOwnerRevision, generation = state.generation;
      const context = state.context, batchContext = state.batchContext, accountKey = state.accountKey;
      void request("return-owner", { pathname }).catch((error) => {
        // Navigation is its own interaction. A returned/hidden/replaced view
        // cannot inherit a late failure from the route it has already left.
        if (state.disposed || !state.active || revision !== returnOwnerRevision || generation !== state.generation
          || context !== state.context || batchContext !== state.batchContext || accountKey !== state.accountKey || sameContext()) return;
        state.error = observeError("titlesConflict", error); render();
      });
      return;
    }
    if (action === "reconcile") { void reconcile(); return; }
    if (action === "retry-preview") { void retryPreview(); return; }
    if (locked()) return;
    if (action === "use-current" && phase() === "select") { onUseCurrent(); return; }
    if (node.dataset.batchSelect !== undefined && phase() === "select") {
      const id = node.dataset.batchSelect, row = state.rows.find((entry) => entry.conversationId === id);
      if (row && (selectable(row) || state.selected.has(id))) { if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id); render(); }
    } else if (node.dataset.batchFilter && phase() === "select" && state.operation !== "remove") {
      if (["all", "no-head", "has-head", "decision"].includes(node.dataset.batchFilter)) { state.filter = node.dataset.batchFilter; render({ resetSelectionScroll: true }); }
    } else if (action === "sort-direction" && phase() === "select") {
      state.sortDirection = state.sortDirection === "desc" ? "asc" : "desc"; render({ resetSelectionScroll: true });
    } else if (action === "select-all" && phase() === "select") {
      const rows = candidates().filter(selectable), all = rows.every((row) => state.selected.has(row.conversationId));
      for (const row of rows) { if (all) state.selected.delete(row.conversationId); else state.selected.add(row.conversationId); } render();
    } else if (["remove", "exit-remove"].includes(action) && phase() === "select") {
      if (action === "remove" && (state.filter !== "has-head" || !searchRows().some((row) => modelPlan(row, "remove").canApply))) return;
      state.operation = action === "remove" ? "remove" : "assign"; state.selected.clear(); render();
    } else if (action === "preview" && phase() === "select") void preview();
    else if (action === "refresh-preview" && phase() === "preview") void retryPreview();
    else if (action === "apply") void apply();
    else if (action === "back") backToSelection();
    else if (action === "finish" && phase() === "result") { state.selected.clear(); backToSelection(); }
    else if (["reload", "resume-catalog"].includes(action) && phase() === "select") {
      if (state.receiptChecking || state.receiptStatusError && !state.eligible) return;
      if (accountBlocked()) state.catalogIssue = "account";
      restoreReceiptError();
      const options = { retry: action === "reload" };
      // The directory has an authenticated account, not a conversation owner.
      // Losing a snapshot while the first receipt lookup is pending must not
      // turn this enabled action into enter()'s owner-bound no-op. Finish the
      // receipt initialization only when an owner exists, and preserve the
      // explicit retry flag instead of silently returning the failed cache.
      if ((!state.initialized || receiptBlocked()) && state.eligible) void enter({ ...options, receiptRetry: state.initialized });
      else void readCatalog(options);
    }
  }
  function onInput(event) {
    const node = event.target;
    if (!root.contains(node) || !state.active || locked() || phase() !== "select" || !Object.hasOwn(node.dataset || {}, "batchQuery")) return;
    state.query = node.value; render({ resetSelectionScroll: true });
  }
  function onChange(event) {
    const node = event.target;
    if (!root.contains(node) || node.disabled || !state.active || locked()) return;
    if (state.batch && receiptBlocked()) return;
    if (Object.hasOwn(node.dataset || {}, "batchSortField") && phase() === "select") {
      if (SORT_FIELDS.includes(node.value) && node.value !== state.sortField) {
        state.sortField = node.value; render({ resetSelectionScroll: true });
      }
      return;
    }
    if (state.operation !== "assign" || !["select", "preview"].includes(phase())) return;
    if (node.dataset.batchRule && state.rules) {
      const field = node.dataset.batchRule;
      if ((field === "mode" && ["created", "range"].includes(node.value)) || (field === "dateFormat" && TITLE_RULE_FORMATS.includes(node.value))) {
        state.rules = { ...state.rules, [field]: node.value }; rulesController.update({ [field]: node.value });
        // Selection classifications come from local directory metadata. A rule
        // change here never asks the worker for an authenticated batch preview.
        if (phase() === "select") render({ resetSelectionScroll: true }); else replan();
      }
    } else if (phase() === "preview" && node.dataset.batchDecision && DECISIONS.includes(node.value)
      && displayItems().some((item) => editable(item) && item.conversationId === node.dataset.batchDecision && item.plan?.needsDecision)) {
      state.decisions[node.dataset.batchDecision] = node.value; replan();
    }
  }
  root.addEventListener("click", onClick); root.addEventListener("input", onInput); root.addEventListener("change", onChange);
  function update({ snapshot, preferences = {}, active, t, translator }) {
    if (state.disposed) return;
    const wasActive = state.active, wasEligible = state.eligible, nextContext = contextKey(snapshot), nextZone = zoneFor(preferences);
    const contextChanged = Boolean(state.context && nextContext !== state.context);
    state.t = t || translator || state.t; state.preferences = preferences;
    state.locale = globalThis.navigator?.language || "en-US";
    const owner = titleSnapshotContext(snapshot, ownerTabId);
    state.eligible = Boolean(owner); state.ownerConversationId = owner?.conversationId || null;
    if (contextChanged || (wasEligible && !state.eligible)) {
      const discardable = !state.running && !needsReconciliation()
        && (!state.batch || ["preview", "result"].includes(state.batch.phase));
      state.generation++; queue = null; state.replanning = false; state.receiptChecking = false; setBusy(null);
      if (discardable) {
        discardDisplayBatch();
      } else if (state.running || state.batch) {
        state.loading = false;
        state.recovery = true; state.error = observeError("titlesConflict", { code: "CONTEXT_MISMATCH" }); setRunning(false);
      }
      // Keep selection rows, filters, checks and their catalog stream. A new
      // owner is used only when the user explicitly requests a fresh preview.
      // An actual directory account change is handled by applyCatalog above.
    }
    state.context = nextContext; state.active = Boolean(active);
    const zoneChanged = state.timeZone !== nextZone; state.timeZone = nextZone;
    if (!state.active) {
      for (const surface of ["titles.batch.notice", "titles.batch.receipt"])
        globalThis.ChatGPTTidyDiagnostics?.notice({ event: "clear", surface, reasonCode: "NOTICE_HIDDEN" });
      // Hide invalidates read-only callbacks too. A late preview/replan must
      // not replace a restored receipt or dispatch another preparation step.
      if (wasActive) {
        // Mode switches and panel reopens resume the selection workspace once
        // this run has cleanly finished. Do not clear an active/recoverable run
        // or mutate the durable receipt just to change the visible page.
        if (!state.running && !state.busy && !needsReconciliation() && settledResultReceipt(state.batch)) discardDisplayBatch();
        if (state.busy || state.running) state.pauseReason = "panel-hidden";
        state.generation++; state.catalogGeneration++; queue = null; state.replanning = false; state.loading = false; state.receiptChecking = false;
        if (state.running) state.recovery = true;
        setBusy(null); setRunning(false);
      }
      return;
    }
    // Binding hydration is not a user retry. Resume a genuinely interrupted
    // receipt check only after an account was observed, never restart a failed
    // account/receipt lookup whenever route-only changes back to bound.
    const passiveReadAllowed = !state.error && !state.catalogError && !state.receiptStatusError;
    const needsInitialRead = (!state.initialized || state.accountKey && !state.receiptStatusReady)
      && (passiveReadAllowed || contextChanged);
    const ownerNeedsRead = state.batch && (contextChanged || !wasEligible && passiveReadAllowed);
    // enter 负责异常与收尾；异步结果必须通过 generation 核验才可更新界面。
    if ((!wasActive || ownerNeedsRead || needsInitialRead) && !state.busy && state.eligible && sameContext()) { void enter(); }
    else if (zoneChanged && state.batch?.phase === "preview" && !locked()) replan();
    render();
  }
  return Object.freeze({ update, canLeave: () => !state.running, dispose() {
    for (const surface of ["titles.batch.notice", "titles.batch.receipt"])
      globalThis.ChatGPTTidyDiagnostics?.notice({ event: "clear", surface, reasonCode: "VIEW_DISPOSED" });
    state.disposed = true; unsubscribeRules(); state.generation++; state.catalogGeneration++; queue = null; setRunning(false);
    root.removeEventListener("click", onClick); root.removeEventListener("input", onInput); root.removeEventListener("change", onChange);
  } });
}
