import { titleOperationsRepository } from "../storage/title-operations.js";
import { TITLE_PLAN_TTL_MS } from "./title-service.js";
import "../../../platform/snapshot.js";

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
// Batch recipes are execution/review data, not a copy of the parser's evidence.
// Titles and normalized rules stay exact; both frozen dates live in item.current.
// Analysis layers, alternative-title choices and display prefixes are derivable
// and would otherwise be copied into every persisted/public whole-job update.
const RECIPE_FIELDS = Object.freeze(["operation", "rules", "before", "after", "action", "reason", "canApply", "noOp",
  "needsDecision", "selectedDecision", "decisionResolved", "hasDateHead", "wouldEmpty"]);
const unknown = (item) => item.status === "pending" || item.status === "uncertain";
const METADATA_SOURCES = new Set(["catalog", "detail"]);
const RETIRED_READ_ONLY_STATUSES = new Set(["unread", "ready", "skipped"]);
const WRITE_EVIDENCE_FIELDS = ["runtimeId", "startedAt", "startedAtMs", "operationId", "recoveryOperationId"];
const identityMatches = (a, b) => a?.accountKey === b?.accountKey && a?.workspaceKey === b?.workspaceKey;
const jobKey = (id) => `title-batch.job:${id}`;
const ownerKey = (owner) => JSON.stringify([owner.tabId, owner.conversationId, owner.pathname, owner.projectId]);
const latestKey = (catalogAccountKey, owner) => `title-batch.latest:${JSON.stringify([catalogAccountKey, ownerKey(owner)])}`;
const error = (code, message) => Object.assign(new Error(message), { code, tidyCode: code });
const codeFor = (cause, fallback) => /^[a-z][a-z0-9_]{0,79}$/i.test(cause?.tidyCode || cause?.code || "") ? cause.tidyCode || cause.code : fallback;
const contextFailure = (code) => ["CONTEXT_MISMATCH", "TITLE_ACCOUNT_CHANGED", "TITLE_AUTH_REQUIRED", "TITLE_AUTH_EXPIRED", "TITLE_TIMEZONE_CHANGED"].includes(code);

// 清理旧准备记录时，不能只看“准备中”标签就断定从未写入。
// 只有所有条目都明确只读、且没有执行痕迹时才能丢弃；不确定的写入记录必须留待核对。
function hasWriteEvidence(value) {
  return WRITE_EVIDENCE_FIELDS.some((field) => value?.[field] != null)
    || (value?.operation != null && typeof value.operation === "object")
    || (Array.isArray(value?.usedStepIds) && value.usedStepIds.length > 0);
}
function retiredReadOnlyJob(job) {
  return job?.version === 1 && job.phase === "preparing" && !hasWriteEvidence(job)
    && Array.isArray(job.items) && job.items.every((item) => RETIRED_READ_ONLY_STATUSES.has(item?.status)
      && item.settled !== true && !hasWriteEvidence(item));
}

function checkedOwner(context) {
  // 与当前会话、面板和 worker 入口共用同一身份边界；网址中的项目名称不属于 ID。
  // 真实路径仍须完全一致，不能借此接管别的标签页、会话或旧批次。
  const route = globalThis.TidySnapshot.parseConversationPath(context?.pathname);
  if (!Number.isInteger(context?.tabId) || context.tabId < 0 || !route
    || context.pathname !== route.pathname || context.conversationId !== route.conversationId
    || (context.projectId || null) !== route.projectId) {
    throw error("CONTEXT_MISMATCH", "A bound saved conversation must own this title batch.");
  }
  return { tabId: context.tabId, ...route };
}

function checkedIdentity(value) {
  const identity = value?.identity || value;
  if (typeof identity?.accountKey !== "string" || !identity.accountKey || typeof identity.workspaceKey !== "string" || !identity.workspaceKey) {
    throw error("CONTEXT_MISMATCH", "The title batch account could not be verified.");
  }
  // Project identity, never an auth session or adapter's extra payload fields.
  return { accountKey: identity.accountKey, workspaceKey: identity.workspaceKey };
}

function checkedCurrent(value, id) {
  if (value?.conversationId !== id || typeof value.title !== "string") {
    throw error("CONTEXT_MISMATCH", "The title metadata belongs to another conversation.");
  }
  return { conversationId: id, title: value.title,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null };
}

// Directory timestamps have one contract: epoch milliseconds (or missing).
// Do not accept panel-authored dates or silently infer seconds/string formats.
function catalogCurrent(row) {
  const iso = (value) => Number.isFinite(value) && Number.isFinite(new Date(value).getTime())
    ? new Date(value).toISOString() : null;
  return checkedCurrent({ conversationId: row.conversationId, title: row.title,
    createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) }, row.conversationId);
}

function checkedCatalogSelection(directory, conversationIds) {
  if (!Array.isArray(directory?.rows) || typeof directory.accountKey !== "string" || !directory.accountKey) {
    throw error("CONTEXT_MISMATCH", "The selected directory could not be authenticated.");
  }
  const rows = new Map();
  for (const row of directory.rows) {
    if (typeof row?.conversationId !== "string" || typeof row.title !== "string" || rows.has(row.conversationId)
      || (row.projectId != null && (typeof row.projectId !== "string" || !/^g-p-[A-Za-z0-9_-]+$/.test(row.projectId)))) {
      throw error("CONTEXT_MISMATCH", "The selected directory contains an invalid target.");
    }
    rows.set(row.conversationId, row);
  }
  if (rows.size !== conversationIds.length || conversationIds.some((id) => !rows.has(id))) {
    throw error("CONTEXT_MISMATCH", "Refresh the directory before reviewing titles whose metadata is missing.");
  }
  return rows;
}

function countsFor(items) {
  const counts = { total: items.length, prepared: items.length, ready: 0, accepted: 0, verified: 0, skipped: 0, failed: 0, conflict: 0, uncertain: 0 };
  for (const item of items) {
    if (Object.hasOwn(counts, item.status)) counts[item.status]++;
    if (item.status === "pending") counts.uncertain++;
  }
  return counts;
}

/** 批量标题执行器：worker 保存进度，侧栏每次只推进一个步骤。
 * 写入标题来自已核准计划，不信任界面临时传来的标题；每步凭证只能使用一次。
 * 中断后结果不明的写入先核对，不能自动重发；修改规则只重新生成预览计划。
 */
export function createTitleBatchService({ titleService, resolveSelection, beginExecution, endExecution,
  storage = titleOperationsRepository, model = globalThis.TidyTitleDates,
  now = () => Date.now(), createId = () => globalThis.crypto.randomUUID(),
} = {}) {
  if (typeof titleService?.handle !== "function" || typeof titleService.authorize !== "function"
    || typeof titleService.applyAuthorized !== "function"
    || typeof resolveSelection !== "function"
    || typeof beginExecution !== "function" || typeof endExecution !== "function"
    || typeof storage?.get !== "function" || typeof storage.set !== "function" || typeof storage.remove !== "function"
    || typeof model?.plan !== "function" || typeof model.normalizeRules !== "function") {
    throw new TypeError("Title batch service requires the shared title executor and authenticated directory.");
  }
  let queue = Promise.resolve();
  // This marker is not a lease that resumes on a new worker. A new worker must
  // present the interrupted job and demand another explicit review for rest.
  const runtimeId = createId();

  function targetContext(job, item) {
    return { tabId: job.owner.tabId, conversationId: item.conversationId,
      ownerContext: { conversationId: job.owner.conversationId, pathname: job.owner.pathname, projectId: job.owner.projectId },
      targetProjectId: item.projectId, batchScopeId: job.scopeId, expectedIdentity: clone(job.identity) };
  }

  function response(job, observed = []) {
    if (!job) return { batchId: null, phase: null, items: [], counts: countsFor([]), nextStepId: null };
    return { batchId: job.id, phase: job.phase, operation: job.operation, rules: clone(job.rules),
      items: job.items.map((item) => ({ conversationId: item.conversationId, projectId: item.projectId,
        current: clone(item.current), plan: clone(item.plan), status: item.status, settled: Boolean(item.settled),
        ...(item.messageCode ? { messageCode: item.messageCode } : {}),
        ...(item.dateDifferences ? { dateDifferences: clone(item.dateDifferences) } : {}) })),
      counts: countsFor(job.items), expiresAt: job.expiresAt, nextStepId: job.nextStepId,
      catalogAccountKey: job.catalogAccountKey,
      ...(job.pauseReason ? { pauseReason: job.pauseReason } : {}),
      ...(observed.length ? { observed: clone(observed) } : {}) };
  }

  async function save(job) { await storage.set(jobKey(job.id), job); }

  async function latest(catalogAccountKey, owner) {
    const pointerKey = latestKey(catalogAccountKey, owner);
    const pointer = await storage.get(pointerKey);
    if (!pointer?.batchId) return null;
    const job = clone(await storage.get(jobKey(pointer.batchId)));
    if (job?.catalogAccountKey && job.catalogAccountKey !== catalogAccountKey) {
      throw error("CONTEXT_MISMATCH", "The title batch pointer belongs to another catalog account.");
    }
    if (retiredReadOnlyJob(job) && job.id === pointer.batchId && job.catalogAccountKey === catalogAccountKey
      && ownerKey(job.owner) === ownerKey(owner)) {
      await storage.remove([jobKey(job.id), pointerKey]);
      return null;
    }
    return load(pointer.batchId, owner, { job, pointer });
  }

  async function load(id, owner, snapshot = null) {
    if (typeof id !== "string" || !id) throw error("INVALID_REQUEST", "A title batch ID is required.");
    const job = snapshot ? clone(snapshot.job) : clone(await storage.get(jobKey(id)));
    if (!job || job.version !== 1 || job.id !== id || job.superseded) {
      throw error("TITLE_PREVIEW_REQUIRED", "This title batch was replaced; open its latest preview.");
    }
    if (ownerKey(job.owner) !== ownerKey(owner)) {
      throw error("CONTEXT_MISMATCH", "This title batch belongs to another tab, conversation or account.");
    }
    const pointer = snapshot ? snapshot.pointer : await storage.get(latestKey(job.catalogAccountKey, owner));
    if (pointer?.batchId !== id) throw error("TITLE_PREVIEW_REQUIRED", "This title batch was superseded.");
    let changed = false;
    if (job.phase === "preparing") {
      // Storage ingress is the only migration boundary. Public responses use
      // the current paused model; neither the worker nor the view revives an
      // old preparation token. Keep all operation IDs and successful receipts.
      const unreadConversationIds = job.items.filter((item) => item.status === "unread").map((item) => item.conversationId);
      job.preparationMigration = { sourcePhase: "preparing", unreadConversationIds, migratedAt: now() };
      job.phase = "paused"; job.nextStepId = null; job.pauseReason = "review-required";
      for (const item of job.items) {
        if (["accepted", "verified"].includes(item.status)) item.settled = true;
        else if (RETIRED_READ_ONLY_STATUSES.has(item.status) && hasWriteEvidence(item)) {
          // A write marker contradicts a read-only status. Preserve it behind
          // reconciliation instead of allowing a new preview to erase it.
          item.status = "uncertain"; item.settled = false; item.messageCode = "title_interrupted";
        } else if (item.status === "unread") {
          // Unread is not success and has no executable recipe. Its original
          // state lives only in migration metadata; an explicit preview is due.
          item.status = "failed"; item.settled = false; item.messageCode = "title_preview_required";
        }
      }
      changed = true;
    }
    for (const item of job.items) {
      if (item.status === "pending") { item.status = "uncertain"; item.messageCode = "title_interrupted"; changed = true; }
    }
    if ((job.phase === "applying" && job.runtimeId !== runtimeId) || job.items.some(unknown)) {
      if (job.phase !== "paused" || job.nextStepId !== null) changed = true;
      const reason = job.items.some(unknown) ? "outcome-unknown" : "runtime-restarted";
      if (job.pauseReason !== reason) changed = true;
      job.pauseReason = reason;
      job.phase = "paused"; job.nextStepId = null;
    }
    if (changed) await save(job);
    return job;
  }

  async function endExecutionQuietly(job) {
    try { await endExecution(job.owner, job.scopeId); }
    catch { /* Lease cleanup must not rewrite a known operation outcome. */ }
  }

  function recipe(job, item, decisions = {}) {
    const decision = ["skip", "replace", "stack"].includes(decisions[item.conversationId])
      ? decisions[item.conversationId] : item.plan?.selectedDecision || "skip";
    const planned = model.plan(clone(item.current), clone(job.rules), { operation: job.operation, decision });
    item.plan = { ...Object.fromEntries(RECIPE_FIELDS.map((field) => [field, clone(planned[field])])),
      id: createId(), kind: "apply", conversationId: item.conversationId };
    item.status = item.plan.canApply && !item.plan.noOp ? "ready" : "skipped";
    item.settled = false;
    delete item.messageCode;
    delete item.dateDifferences;
  }

  function finishPreview(job) {
    job.phase = job.items.some(unknown) ? "paused" : "preview";
    if (job.phase === "paused") job.pauseReason = "outcome-unknown";
    else delete job.pauseReason;
    // Review freezes the intended title and rules. A directory timestamp is
    // not a detail version: the writer validates the exact reviewed output
    // against live details in its existing preflight, without a second read.
    job.expiresAt = now() + TITLE_PLAN_TTL_MS;
    job.nextStepId = null;
  }

  async function replaceJob(previous, job) {
    // 先保存新计划并发布指针，再删除旧记录，不为每次选项切换留下墓碑。
    // 删除中断也不能重放旧计划：load 仍会核对最新指针。
    await save(job);
    await storage.set(latestKey(job.catalogAccountKey, job.owner), { batchId: job.id });
    if (previous) await storage.remove(jobKey(previous.id));
  }

  async function preview(owner, payload) {
    if (!Array.isArray(payload.conversationIds) || !payload.conversationIds.length
      || payload.conversationIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id))
      || new Set(payload.conversationIds).size !== payload.conversationIds.length
      || ![undefined, "assign", "remove"].includes(payload.operation)) {
      throw error("INVALID_REQUEST", "Select valid conversations before previewing title changes.");
    }
    const directory = await resolveSelection(owner, clone(payload));
    const rows = checkedCatalogSelection(directory, payload.conversationIds);
    const previous = await latest(directory.accountKey, owner);
    if (previous && (previous.phase === "applying" || previous.phase === "paused" || previous.items.some(unknown))) {
      throw error("TITLE_BATCH_RECOVERY_REQUIRED", "Resolve the previous batch before starting another one.");
    }
    const id = createId();
    const job = { version: 1, id, scopeId: id, owner, identity: null, catalogAccountKey: directory.accountKey,
      phase: "preview", operation: payload.operation || "assign", rules: model.normalizeRules(payload.rules),
      createdAt: now(), expiresAt: null, nextStepId: null, usedStepIds: [], runtimeId: null,
      items: payload.conversationIds.map((conversationId) => ({ conversationId, projectId: rows.get(conversationId).projectId || null,
        current: catalogCurrent(rows.get(conversationId)), plan: null, status: "skipped", settled: false })) };
    // Preview is one local pass over the already-read directory. Missing dates
    // remain a local no-op; selecting or reviewing titles never opens a session
    // or fetches conversation details.
    for (const item of job.items) {
      item.metadataSource = "catalog";
      recipe(job, item);
    }
    finishPreview(job);
    await replaceJob(previous, job);
    return response(job);
  }

  function requireMetadataSources(job) {
    // Never guess the provenance of an older/incomplete checkpoint. A fresh
    // review migrates it naturally; unknown write receipts remain recoverable.
    if (job.items.some(item => !item.settled && ["ready", "skipped"].includes(item.status)
      && !METADATA_SOURCES.has(item.metadataSource))) {
      throw error("TITLE_PREVIEW_REQUIRED", "Read a fresh batch with an explicit metadata source.");
    }
  }

  async function replan(job, payload) {
    if (job.phase !== "preview" || job.items.some(unknown)) throw error("TITLE_PREVIEW_REQUIRED", "Only an editable batch may change its rules.");
    requireMetadataSources(job);
    if (!Number.isFinite(job.expiresAt) || now() > job.expiresAt || now() < job.createdAt) {
      throw error("TITLE_PLAN_EXPIRED", "Read fresh titles before reviewing an expired batch.");
    }
    const next = clone(job);
    next.id = createId(); next.rules = model.normalizeRules(payload.rules || job.rules);
    next.usedStepIds = []; next.nextStepId = null;
    for (const item of next.items) {
      if (!item.settled && ["ready", "skipped"].includes(item.status) && item.current) recipe(next, item, payload.decisions || {});
    }
    await replaceJob(job, next);
    return response(next);
  }

  async function retryPreview(job, payload) {
    if (!["preview", "paused", "result"].includes(job.phase) || job.items.some(unknown)) {
      throw error("TITLE_BATCH_RECOVERY_REQUIRED", "Read back the uncertain operation before reviewing remaining titles.");
    }
    const next = clone(job);
    next.id = createId(); next.phase = "preview"; next.rules = model.normalizeRules(payload.rules || job.rules);
    next.createdAt = now(); next.expiresAt = null; next.nextStepId = null; next.usedStepIds = []; next.runtimeId = null;
    delete next.pauseReason;
    const refreshIds = payload.refreshConversationIds || [];
    if (!Array.isArray(refreshIds) || new Set(refreshIds).size !== refreshIds.length
      || refreshIds.some(id => !next.items.some(item => item.conversationId === id && !item.settled
        && ["ready", "skipped"].includes(item.status)))) {
      throw error("INVALID_REQUEST", "Only changed, unexecuted preview rows can be refreshed.");
    }
    const missing = next.items.filter((item) => (item.current == null || refreshIds.includes(item.conversationId))
      && !(item.settled && ["accepted", "verified", "skipped"].includes(item.status)));
    if (missing.length) {
      // 只有显式重新预览才从本地目录补齐缺项或重读被改名的指定行。
      // 已完成项目不重读；状态通知不偷偷改写冻结计划，也不发 HTTP。
      const conversationIds = missing.map((item) => item.conversationId);
      const directory = await resolveSelection(job.owner, { accountKey: job.catalogAccountKey, conversationIds,
        ...(refreshIds.length ? { refreshOnly: true } : {}) });
      if (directory?.accountKey !== job.catalogAccountKey) {
        throw error("CONTEXT_MISMATCH", "The title batch directory account changed before review.");
      }
      const rows = checkedCatalogSelection(directory, conversationIds);
      for (const item of missing) {
        const row = rows.get(item.conversationId);
        if ((row.projectId || null) !== item.projectId) {
          throw error("CONTEXT_MISMATCH", "Refresh the directory before reviewing a title whose project changed.");
        }
        item.current = catalogCurrent(row); item.metadataSource = "catalog";
      }
    }
    for (const item of next.items) {
      if (item.settled && ["accepted", "verified", "skipped"].includes(item.status)) continue;
      item.decision = payload.decisions?.[item.conversationId] || item.plan?.selectedDecision || "skip";
      item.plan = null; item.settled = false;
      if (!METADATA_SOURCES.has(item.metadataSource)) item.metadataSource = "catalog";
      delete item.messageCode; delete item.recoveryOperationId; delete item.dateDifferences;
      recipe(next, item, { [item.conversationId]: item.decision });
    }
    finishPreview(next);
    await replaceJob(job, next);
    return response(next);
  }

  async function apply(job) {
    if (["applying", "result"].includes(job.phase)) return response(job);
    if (job.phase !== "preview" || job.items.some(unknown)) throw error("TITLE_BATCH_RECOVERY_REQUIRED", "Review this batch before starting it.");
    requireMetadataSources(job);
    if (!Number.isFinite(job.expiresAt) || now() > job.expiresAt || now() < job.createdAt) {
      throw error("TITLE_PLAN_EXPIRED", "Read fresh titles before applying an expired batch.");
    }
    for (const item of job.items) if (item.status === "skipped") item.settled = true;
    const hasWrites = job.items.some((item) => item.status === "ready");
    if (hasWrites) {
      const execution = await beginExecution(job.owner, {
        scopeId: job.scopeId, identity: clone(job.identity), catalogAccountKey: job.catalogAccountKey,
      });
      const identity = checkedIdentity(execution);
      if ((job.identity && !identityMatches(identity, job.identity)) || execution?.catalogAccountKey !== job.catalogAccountKey) {
        await endExecutionQuietly(job);
        throw error("TITLE_ACCOUNT_CHANGED", "The title batch account changed before execution.");
      }
      job.identity = identity;
    }
    job.phase = hasWrites ? "applying" : "result";
    job.runtimeId = runtimeId; job.startedAt = now();
    delete job.pauseReason;
    job.nextStepId = job.phase === "applying" ? createId() : null;
    try { await save(job); }
    catch (cause) {
      if (hasWrites) await endExecutionQuietly(job);
      throw cause;
    }
    return response(job);
  }

  function acceptReceipt(item, result) {
    const receipt = result?.operation;
    const expectedId = item.recoveryOperationId || item.plan?.id;
    if (!receipt || receipt.id !== expectedId || receipt.conversationId !== item.conversationId) {
      item.status = "uncertain"; item.messageCode = "title_receipt_mismatch";
      return;
    }
    let observed = null;
    try { observed = checkedCurrent(result.current, item.conversationId); } catch { /* A receipt without exact readback is not success. */ }
    let accepted = null;
    try { accepted = checkedCurrent(result.accepted, item.conversationId); } catch { /* Accepted projection is validated below. */ }
    // Keep only the two timestamp differences before replacing the frozen
    // preview observation. This explains a failed preflight without retaining
    // an HTTP body, account data, or a second executable plan.
    delete item.dateDifferences;
    if (receipt.status === "conflict" && receipt.messageCode === "dates_changed" && observed && expectedId === item.plan?.id) {
      const differences = {};
      for (const field of ["createdAt", "updatedAt"]) if (item.current?.[field] !== observed[field]) {
        differences[field] = { expected: item.current?.[field] || null, actual: observed[field] };
      }
      if (Object.keys(differences).length) item.dateDifferences = differences;
    }
    if (observed) item.current = observed;
    const status = ["accepted", "verified", "conflict", "failed", "uncertain"].includes(receipt.status) ? receipt.status : "uncertain";
    item.status = status;
    item.messageCode = codeFor({ code: receipt.messageCode }, `title_${status}`);
    if (status === "verified" && (!observed || observed.title !== receipt.after)) {
      item.status = "uncertain"; item.messageCode = "title_readback_missing";
    }
    if (status === "accepted" && (!accepted || accepted.title !== receipt.after)) {
      item.status = "uncertain"; item.messageCode = "title_acceptance_missing";
    }
    if (item.status === "accepted") item.current = accepted;
    // A previously pending operation can block preparation. Resolving somebody
    // else's receipt clears recovery, but must not count as this batch's write.
    if (expectedId !== item.plan?.id && !unknown(item)) {
      item.status = "failed"; item.messageCode = "title_preview_required";
    }
    item.settled = ["accepted", "verified"].includes(item.status);
  }

  async function step(job, payload) {
    if (job.usedStepIds.includes(payload.stepId)) return response(job);
    if (job.phase !== "applying" || job.runtimeId !== runtimeId || typeof payload.stepId !== "string" || payload.stepId !== job.nextStepId) {
      throw error("INVALID_REQUEST", "This title execution token is no longer current.");
    }
    const item = job.items.find((candidate) => candidate.status === "ready");
    if (!item) {
      job.phase = "result"; job.nextStepId = null;
      try { await save(job); } finally { await endExecutionQuietly(job); }
      return response(job);
    }
    requireMetadataSources(job);
    item.status = "pending"; item.recoveryOperationId = item.plan.id;
    job.usedStepIds.push(payload.stepId); job.nextStepId = null;
    // Persist before even authorizing the core. If completion persistence fails,
    // recovery reads actual state; only this exact receipt can count as success.
    await save(job);
    let halt = false, coreApplyEntered = false, resolvingExisting = false;
    try {
      const context = targetContext(job, item);
      const authorized = await titleService.authorize(context, { identity: job.identity,
        current: item.current, metadataSource: item.metadataSource }, item.plan);
      if (authorized.plan?.id === item.plan.id) {
        coreApplyEntered = true;
        const result = await titleService.applyAuthorized(context, job.identity, item.plan.id);
        acceptReceipt(item, result);
        const rateLimited = result.operation?.httpStatus === 429 || result.operation?.messageCode === "title_rate_limited";
        if (rateLimited) item.messageCode = "TITLE_RATE_LIMITED";
        halt = rateLimited || ["account_changed", "context_changed", "TITLE_TIMEZONE_CHANGED"].includes(result.operation?.messageCode);
        if (halt) job.pauseReason = rateLimited ? "rate-limited" : "context-changed";
      } else if (authorized.operation) {
        resolvingExisting = true;
        item.recoveryOperationId = authorized.operation.id;
        const result = await titleService.handle("reconcile", context);
        acceptReceipt(item, result);
      } else {
        item.status = "failed"; item.messageCode = "title_preview_required";
      }
    } catch (cause) {
      // The core owns POST uncertainty. An exception above may follow durable
      // core dispatch but precede return; conservatively require readback.
      item.messageCode = codeFor(cause, "title_outcome_unknown");
      // Core authorization is local-only and cannot dispatch a POST.
      // Once an existing receipt is discovered, a failed reconciliation must
      // never be mistaken for a fresh no-write.
      const prewrite = !resolvingExisting && (!coreApplyEntered
        || ["CONTEXT_MISMATCH", "TITLE_PREVIEW_REQUIRED", "TITLE_PLAN_EXPIRED", "TITLE_NOT_DISPATCHED"].includes(item.messageCode));
      item.status = prewrite ? "failed" : "uncertain";
      if (item.messageCode === "TITLE_NOT_DISPATCHED") item.messageCode = "title_not_dispatched";
      halt = contextFailure(item.messageCode) || item.messageCode === "TITLE_RATE_LIMITED";
      if (halt) job.pauseReason = item.messageCode === "TITLE_RATE_LIMITED" ? "rate-limited" : "context-changed";
    }
    if (unknown(item) || halt) {
      job.phase = "paused"; job.nextStepId = null;
      if (unknown(item)) job.pauseReason = "outcome-unknown";
    }
    else { job.phase = job.items.some((candidate) => candidate.status === "ready") ? "applying" : "result";
      job.nextStepId = job.phase === "applying" ? createId() : null; }
    let saved = false;
    try { await save(job); saved = true; }
    finally {
      if (!saved || job.phase !== "applying") await endExecutionQuietly(job);
    }
    return response(job, ["accepted", "verified"].includes(item.status) ? [item.current] : []);
  }

  async function reconcile(job) {
    // Read-only recovery revokes any still-live page lease first. A failed
    // reconciliation may remain unknown, but it can never leave later POSTs armed.
    await endExecutionQuietly(job);
    const item = job.items.find(unknown);
    if (item) {
      const result = await titleService.handle("reconcile", targetContext(job, item));
      // 以已核验的当前详情作为下次预览的基线，不要求旧操作回信永久可找回。
      // 缺少/不同的回执不能计为本批成功；旧确认与步骤凭证仍不复用。
      const current = checkedCurrent(result.current, item.conversationId);
      item.metadataSource = "detail";
      if (!result.operation && item.plan && current.title === item.plan.before) {
        // The batch checkpoint may precede a failed core pending checkpoint.
        // No durable core operation means its guarded writer never dispatched.
        item.current = current;
        item.status = "failed"; item.messageCode = "title_not_dispatched";
      } else if (result.operation?.id !== (item.recoveryOperationId || item.plan?.id)) {
        item.current = current; item.status = "conflict"; item.messageCode = "title_rechecked"; item.settled = false;
      } else acceptReceipt(item, result);
    }
    // Reconciliation is observation, never permission to execute another item.
    // Remaining rows get a fresh review through retry-preview, not a resume POST.
    if (["applying", "paused"].includes(job.phase) || item) {
      job.phase = job.items.some(unknown) || job.items.some((candidate) => candidate.status === "ready") ? "paused" : "result";
      // A panel can close between two successful steps without restarting the
      // worker. Explicit read-only recovery also revokes that live run's token;
      // remaining titles require a fresh preview and another confirmation.
      job.nextStepId = null; job.runtimeId = null;
      if (job.phase === "paused") job.pauseReason = job.items.some(unknown) ? "outcome-unknown" : "review-required";
      else delete job.pauseReason;
      await save(job);
    }
    return response(job, ["accepted", "verified"].includes(item?.status) ? [item.current] : []);
  }

  async function handleInner(action, context, payload) {
    const owner = checkedOwner(context);
    if (action === "preview") return preview(owner, payload);
    if (!["replan", "retry-preview", "apply", "step", "status", "reconcile"].includes(action)) {
      throw error("INVALID_REQUEST", "Unknown title batch action.");
    }
    // Replanning has deliberately no adapter call. Its old opaque ID plus
    // worker-validated owner scope are enough to edit, not enough to POST.
    if (action === "replan") return replan(await load(payload.batchId, owner), payload);
    // An explicit opaque batch ID plus exact owner route is enough for local
    // status/replan/checkpoint work. Remote reads below authenticate themselves;
    // confirmation acquires one batch execution lease for all write steps.
    let job;
    if (payload.batchId) job = await load(payload.batchId, owner);
    else if (action === "status" && typeof payload.catalogAccountKey === "string" && payload.catalogAccountKey) {
      job = await latest(payload.catalogAccountKey, owner);
    }
    else job = null;
    if (!job) {
      if (action === "status") return response(null);
      throw error("TITLE_PREVIEW_REQUIRED", "A title batch preview is required.");
    }
    if (action === "status") return response(job);
    if (action === "retry-preview") return retryPreview(job, payload);
    if (action === "apply") return apply(job);
    if (action === "step") return step(job, payload);
    return reconcile(job);
  }

  function handle(action, context, payload = {}) {
    const frozenContext = clone(context), frozenPayload = clone(payload);
    const operation = queue.then(() => handleInner(action, frozenContext, frozenPayload));
    queue = operation.catch(() => {});
    return operation;
  }
  return Object.freeze({ handle });
}
