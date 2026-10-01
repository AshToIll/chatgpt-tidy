import { titleOperationsRepository } from "../storage/title-operations.js";

// 产品参数：标题预览有效期为 10 分钟（单位毫秒）；过期后必须重新读取原题。
// 预览只对应当时的账号、会话与日期，不能复用于后来变化的标题。
export const TITLE_PLAN_TTL_MS = 10 * 60 * 1000;
// 性能上限：worker 内最多保留 16 份预览上下文。淘汰或重启后需要重新读取，
// 不能把内存预览当成持久缓存；普通规则切换仍只重算预览，不调用 ChatGPT。
const MAX_PREVIEW_CONTEXTS = 16;

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const unresolved = (operation) => operation?.status === "pending" || operation?.status === "uncertain";
const identityMatches = (left, right) => left?.accountKey === right?.accountKey && left?.workspaceKey === right?.workspaceKey;
const stateKey = (identity, conversationId) => JSON.stringify([identity.accountKey, identity.workspaceKey, conversationId]);

function serviceError(code, message) {
  return Object.assign(new Error(message), { code, tidyCode: code });
}

function validContext(context) {
  if (!Number.isInteger(context?.tabId) || context.tabId < 0 || typeof context.conversationId !== "string" || !context.conversationId) {
    throw serviceError("CONTEXT_MISMATCH", "A bound conversation is required for title organization.");
  }
  const result = { tabId: context.tabId, conversationId: context.conversationId };
  // The worker supplies the owner route separately from an off-screen batch
  // target. Never turn a target into an invented active-tab conversation.
  for (const field of ["pathname", "projectId", "ownerContext", "targetProjectId", "batchScopeId", "expectedIdentity"]) {
    if (Object.hasOwn(context, field)) result[field] = clone(context[field]);
  }
  return result;
}

function ownershipKey(context) {
  return JSON.stringify([context.tabId, context.pathname || null, context.projectId || null,
    context.ownerContext || null, context.targetProjectId || null, context.batchScopeId || null]);
}

function metadata(value, conversationId) {
  if (value?.conversationId !== conversationId || typeof value.title !== "string") {
    throw serviceError("CONTEXT_MISMATCH", "The title response does not belong to this conversation.");
  }
  return {
    conversationId,
    title: value.title,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

function checkedIdentity(result) {
  const identity = result?.identity;
  if (typeof identity?.accountKey !== "string" || !identity.accountKey || typeof identity.workspaceKey !== "string" || !identity.workspaceKey) {
    throw serviceError("CONTEXT_MISMATCH", "The account identity could not be verified.");
  }
  // Explicit projection prevents an adapter's session/token fields from ever
  // entering persistence or a panel response.
  return { accountKey: identity.accountKey, workspaceKey: identity.workspaceKey };
}

function checkedRead(result, conversationId) {
  return { identity: checkedIdentity(result), current: metadata(result.current, conversationId) };
}

function freshState(identity, conversationId) {
  return { version: 1, identity: clone(identity), conversationId, plan: null, operation: null };
}

function project(value, fields) {
  return Object.fromEntries(Object.keys(value).filter((field) => fields.includes(field)).map((field) => [field, clone(value[field])]));
}

function storedPlan(plan) {
  // 只接受当前“添加/移除日期”计划，且必须有目录或详情作为数据来源。
  // 不符合现行格式的草稿丢弃并重新预览；已发出写入的结果记录独立保留，不能跟着删。
  if (plan?.kind !== "apply" || !["assign", "remove"].includes(plan.operation)
    || !["catalog", "detail"].includes(plan.metadataSource)) return null;
  return project(plan, [
    "id", "kind", "conversationId", "ownerTabId", "ownershipKey", "identity", "createdAtMs", "previewContextId",
    "metadataSource", "expectedCreatedAt", "expectedUpdatedAt", "operation", "rules", "before", "after", "action", "reason",
    "canApply", "noOp", "needsDecision", "selectedDecision", "decisionResolved", "hasDateHead", "wouldEmpty",
    "targetLayer", "targetPrefix", "detectedPrefix", "baseTitle", "analysis", "choices", "ruleFingerprint",
  ]);
}

function storedOperation(operation) {
  if (!operation || !["pending", "uncertain", "accepted", "verified", "conflict", "failed"].includes(operation.status)) return null;
  // 结果记录用于核对“之前是否已经写入”，不是再次执行的指令。
  // 回信缺失时保留原计划供读取核对；核对后的实际状态允许新预览，不重放旧确认。
  const stored = project(operation, ["id", "conversationId", "status", "before", "after", "startedAtMs", "messageCode", "httpStatus"]);
  // 没有明确阶段的记录仍按“可能发出”保护，不能倒推成安全重试。
  if (["prepared", "dispatched"].includes(operation.dispatchPhase)) stored.dispatchPhase = operation.dispatchPhase;
  return stored;
}

function publicOperation(operation) {
  if (!operation) return null;
  return {
    id: operation.id, conversationId: operation.conversationId,
    status: operation.status, before: operation.before, after: operation.after,
    ...(operation.messageCode ? { messageCode: operation.messageCode } : {}),
    ...(Number.isInteger(operation.httpStatus) ? { httpStatus: operation.httpStatus } : {}),
  };
}

function publicPlan(plan) {
  if (!plan) return null;
  const { ownerTabId, ownershipKey, identity, metadataSource, expectedCreatedAt, expectedUpdatedAt, createdAtMs, previewContextId, ...visible } = plan;
  return clone(visible);
}

function response(state, context, current, now, previewContext = null) {
  const plan = state.plan?.ownerTabId === context.tabId && state.plan.ownershipKey === ownershipKey(context)
    && now - state.plan.createdAtMs <= TITLE_PLAN_TTL_MS ? state.plan : null;
  return {
    plan: unresolved(state.operation) ? null : publicPlan(plan),
    operation: publicOperation(state.operation),
    current: clone(current),
    previewContext: previewContext ? { id: previewContext.id, expiresAt: previewContext.capturedAtMs + TITLE_PLAN_TTL_MS } : null,
  };
}

function operationFor(plan, now) {
  return {
    id: plan.id, conversationId: plan.conversationId, before: plan.before, after: plan.after,
    status: "pending", dispatchPhase: "prepared", startedAtMs: now,
  };
}

function safeMessageCode(value, fallback) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,79}$/i.test(value) ? value : fallback;
}

export function createTitleService({
  read, write, storage = titleOperationsRepository, model = globalThis.TidyTitleDates,
  now = () => Date.now(), createId = () => globalThis.crypto.randomUUID(),
  onVerified = async () => {}, onAccepted = async () => {},
} = {}) {
  if (typeof read !== "function" || typeof write !== "function" || typeof onVerified !== "function" || typeof onAccepted !== "function"
    || typeof model?.plan !== "function" || typeof model.normalizeRules !== "function") {
    throw new TypeError("Title service requires read/write adapters and the title date model.");
  }
  // All panels share this worker-owned queue. A double click waits for the
  // first attempt, then sees the consumed plan; it never dispatches twice.
  let queue = Promise.resolve();
  const previewContexts = new Map();

  async function projectVerified(context, catalogAccountKey, current) {
    // The adapter supplies the directory identity from this operation's own
    // authenticated readback. Never infer it from title account/workspace IDs,
    // a preview, or caller input, and never persist it in executable plans.
    if (typeof catalogAccountKey !== "string" || !catalogAccountKey
      || catalogAccountKey !== catalogAccountKey.trim()) return;
    try { await onVerified(clone(context), { catalogAccountKey, current: clone(current) }); }
    catch { /* A failed cache projection cannot invalidate a durable receipt. */ }
  }

  async function projectAccepted(context, catalogAccountKey, accepted) {
    if (typeof catalogAccountKey !== "string" || !catalogAccountKey
      || catalogAccountKey !== catalogAccountKey.trim()) return;
    try { await onAccepted(clone(context), { catalogAccountKey, accepted: clone(accepted) }); }
    catch { /* A local projection cannot change the durable accepted receipt. */ }
  }

  function invalidatePreviewContexts(context, identity = null) {
    for (const [id, frozen] of previewContexts) {
      // One current editing session per tab; a fresh operation against the
      // same account/conversation also supersedes previews from another tab.
      if ((frozen.ownerTabId === context.tabId && !frozen.batchScopeId && !context.batchScopeId)
        || (frozen.batchScopeId && frozen.batchScopeId === context.batchScopeId && frozen.current.conversationId === context.conversationId)
        || (identity && frozen.current.conversationId === context.conversationId && identityMatches(frozen.identity, identity))) {
        previewContexts.delete(id);
      }
    }
  }

  function makePlan(context, frozen, payload) {
    const rules = model.normalizeRules(payload.rules);
    const planned = model.plan(clone(frozen.current), rules, { operation: payload.operation, decision: payload.decision });
    return {
      ...clone(planned), rules: clone(rules), id: createId(), kind: "apply",
      conversationId: context.conversationId, ownerTabId: context.tabId,
      ownershipKey: ownershipKey(context),
      identity: clone(frozen.identity), createdAtMs: frozen.capturedAtMs,
      previewContextId: frozen.id,
      metadataSource: "detail",
      expectedCreatedAt: frozen.current.createdAt, expectedUpdatedAt: frozen.current.updatedAt,
    };
  }

  function freezePreview(context, identity, current, capturedAtMs = now()) {
    // Only projected, authenticated observations enter an editing context.
    // A writer's verified readback is already such an observation; it does not
    // need another ChatGPT read just to let the user change a date option.
    return Object.freeze({
      id: createId(), ownerTabId: context.tabId, ownershipKey: ownershipKey(context),
      batchScopeId: context.batchScopeId || null, capturedAtMs,
      identity: Object.freeze(clone(identity)), current: Object.freeze(clone(current)),
    });
  }

  function rememberPreview(frozen) {
    previewContexts.set(frozen.id, frozen);
    const ordinary = [];
    for (const [id, candidate] of previewContexts) {
      if (now() - candidate.capturedAtMs > TITLE_PLAN_TTL_MS) previewContexts.delete(id);
      else if (!candidate.batchScopeId) ordinary.push(id);
    }
    // The current-tab cache is bounded. A selected batch is not truncated to
    // sixteen conversations; its metadata belongs to one explicit batch job.
    while (ordinary.length > MAX_PREVIEW_CONTEXTS) previewContexts.delete(ordinary.shift());
  }

  async function replan(context, payload) {
    const frozen = typeof payload.previewContextId === "string" ? previewContexts.get(payload.previewContextId) : null;
    if (!frozen) throw serviceError("TITLE_PREVIEW_REQUIRED", "Read this conversation before changing its title preview.");
    if (frozen.ownerTabId !== context.tabId || frozen.ownershipKey !== ownershipKey(context) || frozen.current.conversationId !== context.conversationId) {
      throw serviceError("CONTEXT_MISMATCH", "This preview context belongs to a different tab or conversation.");
    }
    if (now() < frozen.capturedAtMs || now() - frozen.capturedAtMs > TITLE_PLAN_TTL_MS) {
      previewContexts.delete(frozen.id);
      throw serviceError("TITLE_PLAN_EXPIRED", "Refresh this expired title preview before continuing.");
    }
    // Replanning reads only our local operation checkpoint: no session fetch,
    // ChatGPT metadata request, or writer call is allowed on this path.
    const { key, state } = await load(frozen.identity, context.conversationId);
    if (unresolved(state.operation) || state.plan?.previewContextId !== frozen.id) {
      previewContexts.delete(frozen.id);
      throw serviceError("TITLE_PREVIEW_REQUIRED", "This title preview was superseded or consumed.");
    }
    state.plan = makePlan(context, frozen, payload);
    await storage.set(key, state);
    return response(state, context, frozen.current, now(), frozen);
  }

  async function load(identity, conversationId) {
    const key = stateKey(identity, conversationId);
    const stored = await storage.get(key);
    const state = freshState(identity, conversationId);
    if (stored?.version === 1 && stored.conversationId === conversationId && identityMatches(stored.identity, identity)) {
      state.plan = storedPlan(stored.plan);
      state.operation = storedOperation(stored.operation);
    }
    // prepared：只存了确认记录，尚未允许消息离开 Worker。
    // dispatched：消息可能已到页面，不等于 POST 已发出或成功。缺少阶段也不能猜。
    if (state.operation?.status === "pending") {
      const unsent = state.operation.dispatchPhase === "prepared";
      state.operation.status = unsent ? "failed" : "uncertain";
      state.operation.messageCode = unsent ? "title_not_dispatched" : "title_interrupted";
      state.plan = null;
    }
    // Keep one current schema at rest rather than carrying retired checkpoints
    // along every later save. This never discards a pending/uncertain outcome.
    if (stored && JSON.stringify(state) !== JSON.stringify(stored)) await storage.set(key, state);
    return { key, state };
  }

  function clearExpiredPlan(state) {
    if (state.plan && (now() - state.plan.createdAtMs > TITLE_PLAN_TTL_MS || now() < state.plan.createdAtMs)) state.plan = null;
  }

  async function reconcileObservation(key, state, context, current, catalogAccountKey) {
    // 这里只消费本次已经通过账号/会话校验的读取，不加请求、不轮询。
    // conflict 表示实际标题不符合旧计划，不断言旧 POST 从未成功或已被服务器取消。
    // 旧计划始终失效；下一次修改必须基于当前数据生成新计划并由用户再次确认。
    const operation = state.operation;
    if (!unresolved(operation) && operation?.status !== "accepted" && operation?.messageCode !== "title_unchanged") return;
    operation.status = current.title === operation.after ? "verified" : "conflict";
    operation.messageCode = current.title === operation.after ? "title_verified"
      : current.title === operation.before ? "title_unchanged" : "title_changed_externally";
    state.plan = null;
    await storage.set(key, state);
    if (operation.status === "verified") await projectVerified(context, catalogAccountKey, current);
  }

  async function finish(key, state, context, plan, result, observed) {
    const catalogAccountKey = result?.catalogAccountKey;
    let current = observed;
    let validReadback = false;
    if (result?.current) {
      try {
        current = metadata(result.current, plan.conversationId);
        validReadback = true;
      } catch { current = observed; }
    }
    let accepted = null;
    if (result?.accepted) {
      try { accepted = metadata(result.accepted, plan.conversationId); }
      catch { accepted = null; }
    }
    let status = ["accepted", "verified", "uncertain", "conflict", "failed"].includes(result?.status) ? result.status : "uncertain";
    // The pre-write observation is display-only fallback, never verification.
    // Only a readback for this exact conversation can establish success.
    if (status === "verified" && (!validReadback || current?.title !== plan.after)) status = "uncertain";
    if (status === "accepted" && (!accepted || accepted.title !== plan.after)) status = "uncertain";
    state.operation.status = status;
    state.operation.messageCode = safeMessageCode(result?.messageCode, status === "verified" ? "title_verified" : `title_${status}`);
    if (Number.isInteger(result?.httpStatus) && result.httpStatus >= 100 && result.httpStatus <= 599) state.operation.httpStatus = result.httpStatus;
    // The operation receipt still identifies the exact submitted plan. Only the
    // current-conversation editor needs a new readback draft. Batch items already
    // own their reviewed recipes/results and must not grow this editing cache.
    let frozen = status === "verified" && !context.batchScopeId ? freezePreview(context, plan.identity, current) : null;
    state.plan = frozen ? makePlan(context, frozen, {
      rules: plan.rules,
      operation: "assign", decision: "skip",
    }) : null;
    try {
      await storage.set(key, state);
    } catch {
      // 已允许派发而结果没存好，只能核对；确认尚未派发的失败则不必假装结果未知。
      const unsent = state.operation.dispatchPhase === "prepared";
      state.operation.status = unsent ? "failed" : "uncertain";
      state.operation.messageCode = unsent ? "title_not_dispatched" : "title_result_not_saved";
      state.plan = null;
      frozen = null;
    }
    // 只有持久保存的成功回执才可更新目录；失败保存不会通过预览草稿投影成成功。
    if (frozen) rememberPreview(frozen);
    if (state.operation.status === "verified") await projectVerified(context, catalogAccountKey, current);
    if (state.operation.status === "accepted") await projectAccepted(context, catalogAccountKey, accepted);
    return { current, accepted: state.operation.status === "accepted" ? accepted : null, previewContext: frozen };
  }

  async function executePlan(key, state, context, identity, plan, current) {
    state.operation = operationFor(plan, now());
    state.plan = null;
    // 两个本地检查点都不联网：先保存确认，再在真正发送页面消息前保存派发许可。
    // 第一段中断可以重新预览；第二段中断只能核对，不能重放旧计划。
    try { await storage.set(key, state); }
    catch {
      // 确认记录没存好，write 尚未调用；明确告知未提交，不让界面误入无限核对。
      throw serviceError("TITLE_NOT_DISPATCHED", "The title change was not dispatched. Preview again before confirming.");
    }
    let dispatchOpen = true, dispatchStarted = false, dispatched = false;
    const beforeDispatch = async () => {
      if (!dispatchOpen || dispatchStarted) throw serviceError("TITLE_INVALID_PLAN", "This write permit was already consumed.");
      dispatchStarted = true;
      const stored = await storage.get(key);
      if (!dispatchOpen || stored?.operation?.id !== plan.id || stored.operation.status !== "pending"
        || stored.operation.dispatchPhase !== "prepared") {
        throw serviceError("TITLE_INVALID_PLAN", "This write permit is no longer current.");
      }
      const checkpoint = clone(state);
      checkpoint.operation.dispatchPhase = "dispatched";
      await storage.set(key, checkpoint);
      if (!dispatchOpen) throw serviceError("TITLE_INVALID_PLAN", "This write attempt already ended.");
      state.operation.dispatchPhase = "dispatched";
      dispatched = true;
    };
    let result;
    try {
      result = await write(context, {
        identity: clone(identity), before: plan.before, after: plan.after,
        metadataSource: plan.metadataSource,
        expectedCreatedAt: plan.expectedCreatedAt, expectedUpdatedAt: plan.expectedUpdatedAt,
        ...(plan.metadataSource === "catalog" ? { catalogIntent: {
          operation: plan.operation, rules: clone(plan.rules), decision: plan.selectedDecision,
        } } : {}),
        // Worker rechecks this against authoritative preferences immediately
        // before dispatch; panel events may not yet reflect a zone change.
        expectedTimeZone: plan.rules.timeZone,
      }, beforeDispatch);
    } catch {
      result = dispatched ? { status: "uncertain", messageCode: "title_outcome_unknown" }
        : { status: "failed", messageCode: "title_not_dispatched" };
    } finally {
      // 超时/返回之后留下的旧回调不得再取得发送许可。
      dispatchOpen = false;
    }
    if (!dispatched && !["failed", "conflict"].includes(result?.status)) {
      result = { status: "failed", messageCode: "title_not_dispatched" };
    }
    const finished = await finish(key, state, context, plan, result, current);
    const output = response(state, context, finished.current, now(), finished.previewContext);
    if (finished.accepted) output.accepted = clone(finished.accepted);
    return output;
  }

  async function handleInner(action, suppliedContext, payload = {}) {
    const context = validContext(suppliedContext);
    if (!["preview", "replan", "apply", "status", "reconcile"].includes(action)) {
      throw serviceError("INVALID_REQUEST", "Unknown title organization action.");
    }
    if (action === "replan") return replan(context, payload);
    // Anything that deliberately observes or mutates remote state ends the
    // previous local editing session, even if that I/O subsequently fails.
    invalidatePreviewContexts(context);
    // Apply locates the stored account-bound plan with a session-only read.
    // Reading its metadata here and again in the writer adds latency without
    // strengthening the writer's final title/date precondition.
    const applying = action === "apply";
    const observed = await read(context, applying ? { identityOnly: true } : undefined);
    const catalogAccountKey = observed?.catalogAccountKey;
    const identity = checkedIdentity(observed);
    if (context.expectedIdentity && !identityMatches(identity, context.expectedIdentity)) {
      throw serviceError("CONTEXT_MISMATCH", "The batch account changed; no title was written.");
    }
    if (action !== "status") invalidatePreviewContexts(context, identity);
    let current = applying ? null : metadata(observed.current, context.conversationId);
    const { key, state } = await load(identity, context.conversationId);
    clearExpiredPlan(state);

    async function readForDisplay() {
      const result = checkedRead(await read(context), context.conversationId);
      if (!identityMatches(result.identity, identity)) {
        throw serviceError("CONTEXT_MISMATCH", "The signed-in account changed while reading the title.");
      }
      current = result.current;
      return current;
    }

    // 普通首次读取/重新进入也以当前实际标题为准，不能被历史回信永久锁住。
    // apply 的身份读取不是标题核对，绝不能据此恢复旧计划或自动重试。
    // accepted 只证明服务器接收了 POST，不包含可在重启后复用的详情回读。
    // 显式核对才用本次已认证的 current 收敛它；普通状态/预览仍保留 accepted，
    // 不增加自动回读、不伪造 accepted 投影，也不重新派发原来的写入。
    const needsObservation = unresolved(state.operation) || state.operation?.messageCode === "title_unchanged"
      || (action === "reconcile" && state.operation?.status === "accepted");
    if (!applying && needsObservation) await reconcileObservation(key, state, context, current, catalogAccountKey);
    if (action === "status") return response(state, context, current, now());

    if (action === "reconcile") {
      if (!needsObservation) {
        // A previous projection may have failed after successful persistence.
        // Read-only recovery may retry that projection only while the freshly
        // authenticated title still equals this exact receipt's confirmed end.
        if (state.operation?.status === "verified" && current.title === state.operation.after) {
          await projectVerified(context, catalogAccountKey, current);
        }
      }
      return response(state, context, current, now());
    }

    if (unresolved(state.operation)) {
      if (applying) await readForDisplay();
      return response(state, context, current, now());
    }

    if (action === "preview") {
      // Store only projected, authenticated metadata and ownership. Neither a
      // session nor credentials nor a caller-provided title enters this map.
      const frozen = freezePreview(context, identity, current);
      state.plan = makePlan(context, frozen, payload);
      await storage.set(key, state);
      rememberPreview(frozen);
      return response(state, context, current, now(), frozen);
    }

    const plan = state.plan;
    if (!plan || plan.kind !== "apply" || typeof payload.planId !== "string" || payload.planId !== plan.id) {
      throw serviceError("TITLE_PREVIEW_REQUIRED", "Generate a fresh title preview before applying it.");
    }
    if (plan.ownerTabId !== context.tabId || plan.ownershipKey !== ownershipKey(context)
      || plan.conversationId !== context.conversationId || !identityMatches(plan.identity, identity)) {
      throw serviceError("CONTEXT_MISMATCH", "This title preview belongs to a different conversation or account.");
    }
    if (!plan.canApply || plan.noOp || plan.before === plan.after) {
      return response(state, context, await readForDisplay(), now());
    }
    return executePlan(key, state, context, identity, plan, current);
  }

  function handle(action, context, payload = {}) {
    // Snapshot caller data immediately: later changes in the panel must not
    // alter a queued action's target or confirmed plan ID.
    const frozenContext = clone(context);
    const frozenPayload = clone(payload);
    const operation = queue.then(() => handleInner(action, frozenContext, frozenPayload));
    queue = operation.catch(() => {});
    return operation;
  }

  function authorize(suppliedContext, observation, recipe) {
    // A confirmed batch can take longer than the review window to finish. Its
    // worker-owned recipe remains immutable; refresh only the short execution
    // authorization, never the reviewed title, decision or rules. Provenance
    // comes from the worker's observation, never the public payload/recipe.
    // The writer validates catalog intent or exact detail versions in its one
    // existing metadata preflight; authorization adds no network request.
    const context = validContext(clone(suppliedContext));
    const frozenObservation = clone(observation);
    const frozenRecipe = clone(recipe);
    const operation = queue.then(async () => {
      const { identity, current } = checkedRead(frozenObservation, context.conversationId);
      if (!context.batchScopeId || !identityMatches(identity, context.expectedIdentity)
        || !["catalog", "detail"].includes(frozenObservation.metadataSource)
        || frozenRecipe?.kind !== "apply" || !["assign", "remove"].includes(frozenRecipe.operation)
        || frozenRecipe.conversationId !== context.conversationId || frozenRecipe.before !== current.title
        || typeof frozenRecipe.after !== "string" || typeof frozenRecipe.id !== "string" || !frozenRecipe.id) {
        throw serviceError("CONTEXT_MISMATCH", "Only an exact confirmed batch recipe may be authorized.");
      }
      const { key, state } = await load(identity, context.conversationId);
      if (unresolved(state.operation)) return response(state, context, current, now());
      // A duplicate dispatch may arrive after core receipt persistence but
      // before batch receipt persistence. Never turn that receipt into a new
      // executable plan with the same operation ID.
      if (state.operation?.id === frozenRecipe.id) return response(state, context, current, now());
      invalidatePreviewContexts(context, identity);
      state.plan = storedPlan({ ...frozenRecipe, ownerTabId: context.tabId, ownershipKey: ownershipKey(context),
        metadataSource: frozenObservation.metadataSource,
        identity, createdAtMs: now(), expectedCreatedAt: current.createdAt, expectedUpdatedAt: current.updatedAt,
        previewContextId: null });
      await storage.set(key, state);
      return response(state, context, current, now());
    });
    queue = operation.catch(() => {});
    return operation;
  }

  function applyAuthorized(suppliedContext, suppliedIdentity, planId) {
    // Batch confirmation has already acquired one page-memory execution lease.
    // This path consumes only the worker-owned durable plan; it deliberately
    // avoids the per-row session lookup performed by the public apply action.
    const context = validContext(clone(suppliedContext));
    const identity = checkedIdentity({ identity: clone(suppliedIdentity) });
    const operation = queue.then(async () => {
      if (!context.batchScopeId || !context.expectedIdentity
        || !identityMatches(identity, context.expectedIdentity)) {
        throw serviceError("CONTEXT_MISMATCH", "Only this confirmed batch may consume its title plan.");
      }
      invalidatePreviewContexts(context, identity);
      const { key, state } = await load(identity, context.conversationId);
      clearExpiredPlan(state);
      if (unresolved(state.operation)) return response(state, context, null, now());
      const plan = state.plan;
      if (!plan || plan.kind !== "apply" || typeof planId !== "string" || plan.id !== planId
        || plan.ownerTabId !== context.tabId || plan.ownershipKey !== ownershipKey(context)
        || plan.conversationId !== context.conversationId || !identityMatches(plan.identity, identity)) {
        throw serviceError("TITLE_PREVIEW_REQUIRED", "Generate a fresh title preview before applying it.");
      }
      if (!plan.canApply || plan.noOp || plan.before === plan.after) {
        throw serviceError("TITLE_PREVIEW_REQUIRED", "This title plan has no confirmed change to apply.");
      }
      return executePlan(key, state, context, identity, plan, null);
    });
    queue = operation.catch(() => {});
    return operation;
  }

  return Object.freeze({ handle, authorize, applyAuthorized });
}
