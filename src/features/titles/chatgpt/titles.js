(function initTidyChatgptTitles(global) {
  "use strict";

  if (global.TidyChatgptTitles) return;

  const pageSession = global.TidyPageSession;

  // These are operation deadlines, not a retry interval. A timed-out write
  // must be reconciled by reading; neither 401 nor 5xx ever repeats the POST.
  const READ_TIMEOUT_MS = 20_000;
  const WRITE_TIMEOUT_MS = 55_000;
  const REQUEST_TIMEOUT_MS = 12_000;
  const BATCH_EXECUTION_TTL_MS = 10 * 60_000;
  const writing = new Set();
  // One page owns at most one explicitly confirmed batch. Credentials stay in
  // page memory only; a reload drops them and the worker pauses the durable job.
  const batchExecutions = new Map();
  pageSession.onDispose(() => {
    // A stopped page can never reuse a confirmed batch or its bearer headers.
    writing.clear();
    batchExecutions.clear();
  });

  function fault(code, message, httpStatus = null, stage = null) {
    return Object.assign(new Error(message), { tidyCode: code, httpStatus, stage });
  }

  function workspace() {
    pageSession.assertActive();
    try { return global.TidyChatgptApi.activeWorkspace(); }
    catch {
      throw fault("TITLE_ACCOUNT_CHANGED", "The active workspace is unavailable.");
    }
  }

  const isConversationId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
  const isProjectId = (value) => typeof value === "string" && /^g-p-[A-Za-z0-9_-]+$/.test(value);

  function canonicalRoute() {
    pageSession.assertActive();
    let url;
    try { url = new URL(global.location.href); } catch { /* Rejected below. */ }
    // The general snapshot parser intentionally tolerates more routes. A write
    // owner is narrower: one saved ordinary/project conversation, not a share,
    // custom GPT, draft, group, suffix route, or an insecure/lookalike origin.
    const route = global.TidySnapshot.parseConversationPath(url?.pathname);
    if (url?.origin !== "https://chatgpt.com" || !route) {
      throw fault("CONTEXT_MISMATCH", "Open the same saved conversation before continuing.");
    }
    // Match the worker's canonical owner path. A native trailing slash is the
    // same saved page, not a new owner, but arbitrary suffix routes stay banned.
    return route;
  }

  function operationContext(input) {
    const route = canonicalRoute();
    const conversationId = input.conversationId;
    const requestedOwner = input.ownerContext;
    if (!isConversationId(conversationId)
      || (requestedOwner !== undefined && (!requestedOwner || typeof requestedOwner !== "object"
        || requestedOwner.conversationId !== route.conversationId || requestedOwner.pathname !== route.pathname
        || requestedOwner.projectId !== route.projectId))
      || (requestedOwner === undefined && conversationId !== route.conversationId)) {
      throw fault("CONTEXT_MISMATCH", "The title operation no longer belongs to this page.");
    }
    // An off-current batch target is authorized by the worker's frozen catalog,
    // not by navigating the user's tab. Never inherit the owner's project for
    // another target; each target has its own proven project association.
    const projectId = input.targetProjectId === undefined
      ? conversationId === route.conversationId ? route.projectId : null : input.targetProjectId;
    if ((projectId !== null && !isProjectId(projectId))
      || (conversationId === route.conversationId && projectId !== route.projectId)) {
      throw fault("CONTEXT_MISMATCH", "The target project does not match its confirmed context.");
    }
    return Object.freeze({ conversationId, projectId, owner: Object.freeze({ ...route }) });
  }

  function assertRoute(context) {
    const route = canonicalRoute();
    if (route.conversationId !== context.owner.conversationId || route.pathname !== context.owner.pathname
      || route.projectId !== context.owner.projectId) {
      throw fault("CONTEXT_MISMATCH", "The title operation no longer belongs to this page.");
    }
  }

  function sameIdentity(left, right) {
    return Boolean(left && right && left.accountKey === right.accountKey
      && left.workspaceKey === right.workspaceKey);
  }

  function assertContext(context, workspaceKey) {
    assertRoute(context);
    if (workspaceKey !== workspace()) {
      throw fault("TITLE_ACCOUNT_CHANGED", "The active workspace changed.");
    }
  }

  async function boundedRequest(url, init, deadline, json = true) {
    pageSession.assertActive();
    const remaining = Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now());
    if (remaining <= 0) throw fault("ADAPTER_TIMEOUT", "The title request timed out.");
    const controller = new global.AbortController();
    let timer;
    let unsubscribe = () => {};
    let expired = false;
    const assertRequest = () => {
      // Fetch/body readers may ignore abort (including mocks and cached bodies).
      // Their late continuation must not begin the next operation after timeout.
      pageSession.assertActive();
      if (expired) throw fault("ADAPTER_TIMEOUT", "The title request timed out.");
    };
    try {
      const stopped = new Promise((_, reject) => {
        unsubscribe = pageSession.onDispose(() => {
          global.clearTimeout(timer);
          controller.abort();
          reject(pageSession.error());
        });
      });
      const result = await Promise.race([
        (async () => {
          assertRequest();
          const response = await global.TidyChatgptApi.fetchTitleRequest(url, {
            ...init, credentials: "include", cache: "no-store", signal: controller.signal,
          });
          assertRequest();
          // Never forward server bodies (which can contain account information)
          // or credentials over the page bridge.
          const body = json && response.ok ? await response.json() : null;
          assertRequest();
          return { ok: response.ok, status: response.status, body };
        })(),
        new Promise((_, reject) => {
          timer = global.setTimeout(() => {
            expired = true;
            controller.abort();
            reject(fault("ADAPTER_TIMEOUT", "The title request timed out."));
          }, remaining);
        }),
        stopped,
      ]);
      assertRequest();
      return result;
    } finally {
      global.clearTimeout(timer);
      unsubscribe();
    }
  }

  async function readSession(context, deadline) {
    assertRoute(context);
    const response = await boundedRequest("/api/auth/session", {
      method: "GET", headers: { Accept: "application/json" },
    }, deadline);
    assertRoute(context);
    if (response.status === 429) throw fault("TITLE_RATE_LIMITED", "ChatGPT is limiting title requests.", 429);
    const session = response.body;
    if (!response.ok || typeof session?.accessToken !== "string" || !session.accessToken
      || typeof session?.user?.id !== "string" || !session.user.id) {
      throw fault("TITLE_AUTH_REQUIRED", "Sign in again before organizing titles.", response.status);
    }
    return session;
  }

  function sessionAuth(session, workspaceKey) {
    pageSession.assertActive();
    const identity = { accountKey: session.user.id, workspaceKey };
    const headers = { Accept: "application/json", Authorization: `Bearer ${session.accessToken}` };
    // Native ChatGPT derives the workspace header from _account, not user.id
    // or session.activeAccountId. Personal workspace intentionally omits it.
    if (workspaceKey !== "personal") headers["ChatGPT-Account-ID"] = encodeURIComponent(workspaceKey);
    // Project the directory identity from this very session, not a second
    // request or a guess based on the rename adapter's different identity.
    const { accountKey: catalogAccountKey } = global.TidyChatgptApi.catalogIdentity(session);
    return { identity, headers, catalogAccountKey };
  }

  async function acquirePreviewAuth(context, deadline) {
    // A first read-only preview has no accepted workspace to compare against.
    // ChatGPT may initialize _account while its startup session is loading:
    // bind AFTER that request, rather than calling initialization an account
    // switch. Metadata and the final session still verify this exact identity.
    // This is acquisition, not a retry and never authority for an existing plan.
    const session = await readSession(context, deadline);
    pageSession.assertActive();
    return sessionAuth(session, workspace());
  }

  async function freshAuth(context, deadline, expectedIdentity = null) {
    // Already-bound reads, apply lookups, writes and readback keep the strict
    // before/after workspace check. They may never adopt a new workspace.
    const workspaceKey = workspace();
    const session = await readSession(context, deadline);
    assertContext(context, workspaceKey);
    const auth = sessionAuth(session, workspaceKey);
    if (expectedIdentity && !sameIdentity(auth.identity, expectedIdentity)) {
      throw fault("TITLE_ACCOUNT_CHANGED", "The signed-in account changed.");
    }
    return auth;
  }

  function catalogProjection(before, after = before) {
    pageSession.assertActive();
    // Directory synchronization is optional evidence, never write authority.
    // If only the catalog key changes, retain the independently verified title
    // result but do not attach an ambiguous account for cache projection.
    return before.catalogAccountKey && before.catalogAccountKey === after.catalogAccountKey
      ? { catalogAccountKey: before.catalogAccountKey } : {};
  }

  function batchScope(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
  }

  async function beginBatchExecution(input = {}) {
    const context = operationContext(input);
    const scopeId = batchScope(input.batchScopeId);
    if (!scopeId || typeof input.expectedCatalogAccountKey !== "string" || !input.expectedCatalogAccountKey
      || (input.identity != null && (typeof input.identity?.accountKey !== "string" || typeof input.identity.workspaceKey !== "string"))) {
      throw fault("TITLE_INVALID_PLAN", "The title batch execution context is invalid.");
    }
    const deadline = Date.now() + READ_TIMEOUT_MS;
    const auth = await freshAuth(context, deadline, input.identity || null);
    pageSession.assertActive();
    if (auth.catalogAccountKey !== input.expectedCatalogAccountKey) {
      throw fault("TITLE_ACCOUNT_CHANGED", "The conversation directory account changed.");
    }
    batchExecutions.clear();
    batchExecutions.set(scopeId, {
      identity: auth.identity, headers: auth.headers, catalogAccountKey: auth.catalogAccountKey,
      owner: context.owner, expiresAt: Date.now() + BATCH_EXECUTION_TTL_MS,
    });
    return { identity: auth.identity, catalogAccountKey: auth.catalogAccountKey };
  }

  function batchAuth(input, context) {
    pageSession.assertActive();
    const scopeId = batchScope(input.batchScopeId);
    const execution = scopeId ? batchExecutions.get(scopeId) : null;
    if (!execution || execution.expiresAt < Date.now() || !sameIdentity(execution.identity, input.identity)
      || execution.owner.conversationId !== context.owner.conversationId
      || execution.owner.pathname !== context.owner.pathname || execution.owner.projectId !== context.owner.projectId) {
      if (scopeId) batchExecutions.delete(scopeId);
      throw fault("TITLE_AUTH_EXPIRED", "Confirm this batch again before continuing.");
    }
    assertContext(context, execution.identity.workspaceKey);
    return execution;
  }

  function endBatchExecution(input = {}) {
    const context = operationContext(input);
    const scopeId = batchScope(input.batchScopeId);
    if (!scopeId) throw fault("TITLE_INVALID_PLAN", "The title batch execution context is invalid.");
    const execution = batchExecutions.get(scopeId);
    if (execution) {
      if (execution.owner.conversationId !== context.owner.conversationId
        || execution.owner.pathname !== context.owner.pathname || execution.owner.projectId !== context.owner.projectId) {
        throw fault("CONTEXT_MISMATCH", "The title batch belongs to another page.");
      }
      batchExecutions.delete(scopeId);
    }
    return { ended: true };
  }

  function iso(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const date = new Date(value * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  function ownerMatchesIdentity(ownerId, identity) {
    if (ownerId === identity.accountKey) return true;
    // 工作区中的本人 owner 可以是“用户 ID__工作区 UUID”，不等于换了一个用户。
    // 必须核对完整的两段身份；不能去掉后缀或按前缀放行另一个工作区的 owner。
    const workspaceKey = identity.workspaceKey;
    return workspaceKey !== "personal"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceKey)
      && ownerId === identity.accountKey + "__" + workspaceKey;
  }

  async function readMetadata(context, auth, deadline) {
    const { conversationId, projectId } = context;
    assertContext(context, auth.identity.workspaceKey);
    // Native project reads add this header (HAR project sample + native Ky).
    // Rename itself uses the generic endpoint without a project header. Shared
    // project owner headers are deliberately not guessed or copied from a UI.
    const headers = { ...auth.headers, ...(projectId ? { "chatgpt-project-id": projectId } : {}) };
    const response = await boundedRequest(
      `/backend-api/conversations/${encodeURIComponent(conversationId)}?include_has_versions=true&num_turns=10`,
      { method: "GET", headers }, deadline,
    );
    assertContext(context, auth.identity.workspaceKey);
    if (!response.ok) {
      throw fault(response.status === 429 ? "TITLE_RATE_LIMITED" : response.status === 401 ? "TITLE_AUTH_REQUIRED" : "TITLE_UNAVAILABLE",
        "The current title could not be read.", response.status, "main-world.title.metadata.http");
    }
    const body = response.body;
    if (body?.conversation_id !== conversationId) {
      throw fault("TITLE_UNAVAILABLE", "The title response did not match this conversation.",
        response.status, "main-world.title.metadata.conversation-id");
    }
    if (typeof body.title !== "string") {
      throw fault("TITLE_UNAVAILABLE", "The title response did not contain a valid title.",
        response.status, "main-world.title.metadata.title-shape");
    }
    const nativeProjectId = body.gizmo_type === "snorlax" && isProjectId(body.gizmo_id) ? body.gizmo_id : null;
    if (nativeProjectId !== projectId || (body.gizmo_type === "snorlax" && !nativeProjectId)) {
      // A stale directory target is not an owner-tab/account change. The
      // batch may reject this one item and keep preparing unrelated titles;
      // it must never borrow the newly observed project and silently write.
      throw fault("TITLE_TARGET_CHANGED", "The conversation's project changed.",
        response.status, "main-world.title.metadata.project-match");
    }
    // Fixed diagnostic stages describe the rejected boundary, never the private title/owner values.
    if (body.is_read_only === true) {
      throw fault("TITLE_UNAVAILABLE", "This conversation is read-only.",
        response.status, "main-world.title.metadata.read-only");
    }
    if (body.is_temporary_chat === true) {
      throw fault("TITLE_UNAVAILABLE", "Temporary conversations cannot be organized.",
        response.status, "main-world.title.metadata.temporary");
    }
    if (body.owner != null) {
      if (typeof body.owner.user_id !== "string" || !body.owner.user_id) {
        throw fault("TITLE_UNAVAILABLE", "The conversation owner is unavailable.",
          response.status, "main-world.title.metadata.owner-shape");
      }
      if (!ownerMatchesIdentity(body.owner.user_id, auth.identity)) {
        throw fault("TITLE_UNAVAILABLE", "This conversation is not owned by the current identity.",
          response.status, "main-world.title.metadata.owner-match");
      }
    }
    return {
      conversationId, title: body.title,
      createdAt: iso(body.create_time), updatedAt: iso(body.update_time),
    };
  }

  async function readCurrent(input = {}) {
    const context = operationContext(input);
    const { identity: expectedIdentity, identityOnly = false } = input;
    const deadline = Date.now() + READ_TIMEOUT_MS;
    const auth = !expectedIdentity && identityOnly !== true
      ? await acquirePreviewAuth(context, deadline)
      : await freshAuth(context, deadline, expectedIdentity);
    pageSession.assertActive();
    // Apply only needs the identity to locate its durable plan. Its writer
    // performs the authoritative metadata preflight immediately before POST.
    if (identityOnly === true) return { identity: auth.identity, ...catalogProjection(auth) };
    const current = await readMetadata(context, auth, deadline);
    pageSession.assertActive();
    // Detect logout/account changes that occurred during the metadata request.
    const finalAuth = await freshAuth(context, deadline, auth.identity);
    pageSession.assertActive();
    return { identity: auth.identity, current, ...catalogProjection(auth, finalAuth) };
  }

  async function writeCurrent(input = {}) {
    const { conversationId, identity, before, after } = input;
    const context = operationContext(input);
    if (typeof identity?.accountKey !== "string" || !identity.accountKey || typeof identity.workspaceKey !== "string" || !identity.workspaceKey
      || typeof before !== "string" || typeof after !== "string" || !after.trim() || before === after) {
      throw fault("TITLE_INVALID_PLAN", "The confirmed title plan is invalid.");
    }
    // Explicit provenance is mandatory. Never compare directory timestamps to
    // detail timestamps as if they were a shared version number, and never
    // infer the source of an older/incomplete executable plan.
    if (!["catalog", "detail"].includes(input.metadataSource)
      || !Object.hasOwn(input, "expectedCreatedAt") || !Object.hasOwn(input, "expectedUpdatedAt")
      || (input.metadataSource === "catalog" && (!input.catalogIntent?.rules
        || !["assign", "remove"].includes(input.catalogIntent.operation)))
      || (input.metadataSource === "detail" && Object.hasOwn(input, "catalogIntent"))) {
      throw fault("TITLE_INVALID_PLAN", "The title plan requires an explicit date validation source.");
    }
    if (writing.has(conversationId)) throw fault("TITLE_BUSY", "A title write is already running.");
    writing.add(conversationId);
    const deadline = Date.now() + WRITE_TIMEOUT_MS;
    let dispatched = false;
    let current = null;
    let httpStatus = null;
    try {
      const batchExecution = batchScope(input.batchScopeId);
      let auth = batchExecution ? batchAuth(input, context) : await freshAuth(context, deadline, identity);
      pageSession.assertActive();
      current = await readMetadata(context, auth, deadline);
      pageSession.assertActive();
      if (current.title !== before) return { status: "conflict", current, messageCode: "title_conflict" };
      if (input.metadataSource === "catalog") {
        // Reuse this live preflight and the same pure date model as the preview.
        // Only the EXACT confirmed output may be sent, with the original rules
        // and conflict decision. No tolerance, new recipe, extra GET or retry.
        const planned = global.TidyTitleDates.plan(current, input.catalogIntent.rules, {
          operation: input.catalogIntent.operation, decision: input.catalogIntent.decision,
        });
        if (planned.before !== before || planned.after !== after || !planned.canApply || planned.noOp || planned.wouldEmpty) {
          return { status: "conflict", current, messageCode: "dates_changed" };
        }
      } else {
        // A detail preview already has a same-source baseline. Preserve exact
        // comparison of BOTH timestamps, including a one-millisecond change.
        for (const [expected, field] of [["expectedCreatedAt", "createdAt"], ["expectedUpdatedAt", "updatedAt"]]) {
          if (input[expected] !== current[field]) return { status: "conflict", current, messageCode: "dates_changed" };
        }
      }
      // A lease proves the original confirmation, not the browser's current
      // user. Another tab can switch users without changing the personal
      // workspace cookie or reloading this page. Revalidate once, at the last
      // asynchronous boundary before POST; metadata already passed preflight.
      // Batch 2xx still needs no detail readback or second session request.
      auth = await freshAuth(context, deadline, identity);
      pageSession.assertActive();
      if (batchExecution && auth.catalogAccountKey !== batchAuth(input, context).catalogAccountKey) {
        throw fault("TITLE_ACCOUNT_CHANGED", "The conversation directory account changed.");
      }
      dispatched = true;
      let outcome;
      try {
        // One modern native rename endpoint, verified in the website's public
        // client. Do not fall back to PATCH or replay when the result is unclear.
        outcome = await boundedRequest(
          `/backend-api/conversation/id/${encodeURIComponent(conversationId)}/rename`,
          { method: "POST", headers: { ...auth.headers, "Content-Type": "application/json" },
            body: JSON.stringify({ title: after }) }, deadline, false,
        );
        pageSession.assertActive();
        httpStatus = outcome.status;
      } catch {
        // A lost response permits a readback only while this page still owns
        // the operation. Disposal is terminal, not a retry/reconcile trigger.
        pageSession.assertActive();
        // Dispatch may have reached the server. A readback is safe; resend isn't.
      }
      pageSession.assertActive();
      if (outcome && !outcome.ok && outcome.status >= 400 && outcome.status < 500 && outcome.status !== 408) {
        return { status: "failed", current, httpStatus, messageCode: "http_error" };
      }
      if (batchExecution && outcome?.ok) {
        // ChatGPT's native client treats a successful rename response as the
        // mutation boundary and refreshes its directory later. Record that
        // narrower fact truthfully: accepted is not a metadata readback.
        return { status: "accepted", accepted: { ...current, title: after }, httpStatus,
          ...catalogProjection(auth) };
      }
      try {
        // Keep this operation's already checked credentials for the readback.
        // Route/workspace checks bracket the request, and the final fresh
        // session check still rejects an account switch during POST/readback.
        const observed = await readMetadata(context, auth, deadline);
        pageSession.assertActive();
        const finalAuth = batchExecution ? (assertContext(context, identity.workspaceKey), auth)
          : await freshAuth(context, deadline, identity);
        pageSession.assertActive();
        if (observed.title === after) return { status: "verified", current: observed, httpStatus,
          ...catalogProjection(auth, finalAuth) };
        if (observed.title !== before) {
          return { status: "conflict", current: observed, httpStatus, messageCode: "title_conflict" };
        }
        return { status: "uncertain", current: observed, httpStatus, messageCode: "write_uncertain" };
      } catch {
        pageSession.assertActive();
        return { status: "uncertain", current: null, httpStatus, messageCode: "readback_unavailable" };
      }
    } catch (error) {
      // An undispatched operation retains the canonical lifecycle error. A
      // dispatched POST may have reached the server, so keep only uncertainty:
      // no readback, accepted/verified result, or catalog projection survives.
      if (!pageSession.check()) {
        if (!dispatched) throw pageSession.error();
        return { status: "uncertain", current: null, httpStatus, messageCode: "write_uncertain" };
      }
      // A failed identity check must also disarm the old page-memory lease.
      // A later explicit confirmation can acquire a new one; a queued step
      // cannot recover by reusing credentials from the previous signed-in user.
      if (["TITLE_ACCOUNT_CHANGED", "TITLE_AUTH_REQUIRED", "TITLE_AUTH_EXPIRED", "CONTEXT_MISMATCH"].includes(error.tidyCode)) {
        batchExecutions.delete(batchScope(input.batchScopeId));
      }
      return {
        status: dispatched ? "uncertain" : "failed", current: null, httpStatus: error.httpStatus || httpStatus,
        messageCode: dispatched ? "write_uncertain"
          : ["TITLE_ACCOUNT_CHANGED", "TITLE_AUTH_REQUIRED", "TITLE_AUTH_EXPIRED"].includes(error.tidyCode) ? "account_changed"
          : error.tidyCode === "TITLE_RATE_LIMITED" ? "title_rate_limited"
          : error.tidyCode === "TITLE_TARGET_CHANGED" ? "target_changed"
          : error.tidyCode === "CONTEXT_MISMATCH" ? "context_changed" : "readback_unavailable",
      };
    } finally {
      writing.delete(conversationId);
    }
  }

  global.TidyChatgptTitles = Object.freeze({ readCurrent, writeCurrent, beginBatchExecution, endBatchExecution });
})(globalThis);
