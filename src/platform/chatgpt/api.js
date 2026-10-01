// ChatGPT 会话与鉴权入口：凭据只留在页面内存中，向扩展提供最小身份信息。
// 页面、账号或工作区变化会使旧请求失效，不能把晚到响应当作新账号的数据。
(function initTidyChatgptApi(global) {
  "use strict";

  if (global.TidyChatgptApi) return;

  // Extension replacement retires this instance permanently. This boundary is
  // separate from pagehide/BFCache, which can resume the same live extension.
  const pageSession = global.TidyPageSession;

  const SESSION_ENDPOINT = "/api/auth/session";
  let cachedSession = null;
  let cachedAccessToken = "";
  let sessionRequest = null;
  // Library ownership is a page-session lease, not a network check per action.
  // Only an observed identity/workspace/document boundary advances this epoch.
  let libraryIdentity = { accountKey: null, epoch: 0, phase: "unavailable" };
  let libraryWorkspace;
  // Provenance only: these fields classify a local invalidation; they never
  // keep a lease/token alive or authorize accepting a stale session ticket.
  let lastReadyWorkspace;
  let workspaceUnconfirmed = false;
  let hardBoundarySinceReady = false;
  let libraryAttempted = false;
  let libraryPending = null;
  let libraryFailure = null;
  let documentActive = true;
  // Unlike the public epoch, this fence advances only when existing requests
  // lose authority. Accepting an earlier valid proof must not discard a later
  // request from the same unchanged document/workspace boundary.
  let identityBoundary = 0;
  let sessionSequence = 0;
  let acceptedSessionSequence = 0;
  let observedSessionPending = null;
  const identityListeners = new Set();
  const responseTickets = new WeakMap();
  const titleListeners = new Set();
  const ownTitleRequests = new WeakSet();
  // 仅登记正在发生的改名，不保存所有会话 ID，也不轮询目录。
  const pendingRenames = new Map();

  function workspaceSelection() {
    // ChatGPT's selected workspace comes from _account. An absent/empty cookie
    // means personal; a malformed selection must never silently become personal.
    // All title and library consumers share this parser, not separate fallbacks.
    const pair = String(global.document?.cookie || "").split(";")
      .map(part => part.trim()).find(part => part.startsWith("_account="));
    try {
      const selected = pair ? decodeURIComponent(pair.slice(9)) : "";
      return { workspace: selected || "personal", explicit: Boolean(selected) };
    }
    catch { throw Object.assign(new Error("The active workspace is unavailable."), { tidyCode: "CONTEXT_MISMATCH" }); }
  }

  function activeWorkspace() { pageSession.assertActive(); return workspaceSelection().workspace; }

  function identityError(message = "The signed-in library owner is unavailable.", code = "LIBRARY_ACCOUNT_UNAVAILABLE") {
    return Object.assign(new Error(message), { tidyCode: code });
  }

  function publishIdentity() {
    if (!pageSession.check()) return;
    for (const listener of identityListeners) {
      if (!pageSession.check()) return;
      try { listener({ ...libraryIdentity }); } catch { /* One view cannot interrupt the identity boundary. */ }
    }
  }

  function invalidateIdentity(error, { initialize = false, force = false, transition = "session-revoked" } = {}) {
    const changed = force || libraryIdentity.phase === "ready";
    const hard = ["context-changed", "session-revoked", "document-hidden"].includes(transition);
    const escalated = hard && ["workspace-unconfirmed", "workspace-restored"].includes(libraryIdentity.transition);
    if (hard) { workspaceUnconfirmed = false; hardBoundarySinceReady = true; }
    if (changed) identityBoundary++;
    libraryIdentity = { accountKey: null, epoch: libraryIdentity.epoch + Number(changed), phase: "unavailable", transition };
    libraryAttempted = !initialize;
    libraryPending = null;
    libraryFailure = error;
    cachedSession = null;
    cachedAccessToken = "";
    sessionRequest = null;
    pendingRenames.clear();
    // A soft-to-hard cause upgrade is observable even if the lease is already
    // invalid. Keep its original epoch/ticket rules and publish that escalation
    // once; repeated hard failures remain silent, as before.
    if (changed || escalated) publishIdentity();
  }

  function checkLibraryIdentity() {
    if (!pageSession.check()) return { ...libraryIdentity };
    if (!documentActive) return { ...libraryIdentity };
    let selection;
    try { selection = workspaceSelection(); }
    catch (error) {
      if (libraryWorkspace !== null) {
        libraryWorkspace = null;
        invalidateIdentity(error, { force: true, transition: "context-changed" });
      }
      return { ...libraryIdentity };
    }
    const workspace = selection.workspace;
    if (libraryWorkspace === undefined) libraryWorkspace = workspace;
    else if (libraryWorkspace !== workspace) {
      let transition = "context-changed";
      if (!hardBoundarySinceReady && !selection.explicit && lastReadyWorkspace !== undefined
        && lastReadyWorkspace !== "personal" && libraryWorkspace === lastReadyWorkspace) {
        transition = "workspace-unconfirmed";
        workspaceUnconfirmed = true;
      } else if (!hardBoundarySinceReady && workspaceUnconfirmed && selection.explicit && workspace === lastReadyWorkspace) {
        transition = "workspace-restored";
        workspaceUnconfirmed = false;
      }
      libraryWorkspace = workspace;
      invalidateIdentity(identityError("The selected workspace changed.", "CONTEXT_MISMATCH"), {
        initialize: true, force: true, transition,
      });
    }
    return { ...libraryIdentity };
  }

  function onLibraryIdentityChanged(listener) {
    if (!pageSession.check() || typeof listener !== "function") return () => {};
    identityListeners.add(listener);
    return () => identityListeners.delete(listener);
  }

  function sessionOwner(session, workspace) {
    const userId = session?.user?.id;
    return typeof userId === "string" && userId.trim() && userId === userId.trim()
      ? JSON.stringify([userId, workspace]) : null;
  }

  function sessionTicket() {
    checkLibraryIdentity();
    return { sequence: ++sessionSequence, boundary: identityBoundary, workspace: libraryWorkspace };
  }

  function currentSessionTicket(ticket) {
    if (!pageSession.check()) return false;
    checkLibraryIdentity();
    return documentActive && ticket && typeof ticket.workspace === "string"
      && ticket.workspace === libraryWorkspace && ticket.boundary === identityBoundary
      && ticket.sequence >= acceptedSessionSequence;
  }

  function acceptSession(session, ticket) {
    if (!currentSessionTicket(ticket)) return false;
    acceptedSessionSequence = ticket.sequence;
    const accountKey = sessionOwner(session, libraryWorkspace);
    if (!accountKey) {
      // A successful session response without a usable owner revokes authority;
      // do not label malformed data as a specific user's logout.
      invalidateIdentity(identityError());
      return false;
    }
    // This independently accepted proof becomes the comparison point for later
    // cause labels only. A prior explicit B boundary stays hard until such a
    // proof; returning its cookie to A alone never softens that boundary.
    lastReadyWorkspace = libraryWorkspace;
    workspaceUnconfirmed = false;
    hardBoundarySinceReady = false;
    if (libraryIdentity.accountKey !== accountKey || libraryIdentity.phase !== "ready") {
      // Identity and credential caches must move together. A valid new user
      // projection without a token must never inherit the old user's token or
      // join the old user's still-pending authenticated session request.
      cachedSession = null;
      cachedAccessToken = "";
      sessionRequest = null;
      libraryIdentity = { accountKey, epoch: libraryIdentity.epoch + 1, phase: "ready" };
      publishIdentity();
    }
    // A subscriber may synchronously retire the page while the ready identity
    // is published. Never restore credentials after the disposal callback ran.
    if (!pageSession.check()) return false;
    libraryAttempted = true;
    libraryFailure = null;
    const token = session?.accessToken || session?.access_token;
    if (typeof token === "string" && token.trim()) {
      cachedSession = session;
      cachedAccessToken = token;
    }
    return true;
  }

  function sessionEndpoint(input) {
    const url = typeof input === "string" ? input : input?.url
      || (typeof global.URL === "function" && input instanceof global.URL ? input.href : null);
    if (typeof url !== "string") return false;
    if (url === SESSION_ENDPOINT) return true;
    try {
      const parsed = new global.URL(url, global.location?.href);
      return parsed.origin === global.location?.origin && parsed.pathname === SESSION_ENDPOINT
        && !parsed.search && !parsed.hash;
    } catch { return false; }
  }

  function renameTicket(input, init) {
    try {
      const url = new global.URL(typeof input === "string" ? input : input?.url || input?.href, global.location.href);
      const match = /^\/backend-api\/conversation\/id\/([A-Za-z0-9_-]+)\/rename$/.exec(url.pathname);
      if (url.origin !== "https://chatgpt.com" || url.origin !== global.location.origin || url.search || url.hash
        || !match || String(init?.method || input?.method || "GET").toUpperCase() !== "POST") return null;
      const identity = checkLibraryIdentity();
      const catalogAccountKey = catalogIdentity(cachedSession).accountKey;
      if (identity.phase !== "ready" || !catalogAccountKey) return null;
      const ticket = { ...identity, catalogAccountKey, conversationId: match[1],
        startedAt: global.performance?.timeOrigin + global.performance?.now() || Date.now(),
        own: Boolean(init && ownTitleRequests.has(init)) };
      const readTitle = (body) => {
        if (typeof body !== "string" || body.length > 16_384) return null;
        const value = JSON.parse(body)?.title;
        return typeof value === "string" && value.trim() && value.length <= 4096 ? value : null;
      };
      // 只读取精确改名接口的请求体；不读取认证头、聊天正文或响应正文。
      ticket.title = Promise.resolve(init?.body !== undefined ? init.body
        : typeof input?.clone === "function" ? input.clone().text() : null).then(readTitle).catch(() => null);
      pendingRenames.set(ticket.conversationId, ticket);
      return ticket;
    } catch { return null; }
  }

  async function observeRename(ticket, response) {
    if (!ticket || !pageSession.check()) return;
    try {
      const title = await ticket.title;
      if (!pageSession.check()) return;
      const identity = checkLibraryIdentity();
      if (!response?.ok || response.redirected || !title || ticket.own
        || pendingRenames.get(ticket.conversationId) !== ticket || !documentActive
        || identity.phase !== "ready" || identity.epoch !== ticket.epoch || identity.accountKey !== ticket.accountKey
        || catalogIdentity(cachedSession).accountKey !== ticket.catalogAccountKey) return;
      const change = { ownerAccountKey: ticket.accountKey, epoch: ticket.epoch,
        catalogAccountKey: ticket.catalogAccountKey, conversationId: ticket.conversationId, title, startedAt: ticket.startedAt };
      for (const listener of titleListeners) {
        if (!pageSession.check()) return;
        try { listener(change); } catch { /* 一个订阅者不能影响官方改名。 */ }
      }
    } finally {
      if (pendingRenames.get(ticket.conversationId) === ticket) pendingRenames.delete(ticket.conversationId);
    }
  }

  function onTitleChanged(listener) {
    if (!pageSession.check() || typeof listener !== "function") return () => {};
    titleListeners.add(listener);
    return () => titleListeners.delete(listener);
  }

  // TIDY 写入走原有回执链路，不把自己的请求再当成“外部改名”。标记只在内存中。
  function fetchTitleRequest(input, init) {
    pageSession.assertActive();
    const requestInit = tidyRequestInit(init);
    ownTitleRequests.add(requestInit);
    return global.fetch(input, requestInit);
  }

  // Only requests explicitly initiated by TIDY receive this signal. Combining
  // signals preserves caller deadlines and keeps response-body reads abortable.
  // The global fetch observer never adds a signal to the website's own requests.
  function tidyRequestInit(init = {}) {
    pageSession.assertActive();
    return { ...init, signal: init.signal
      ? global.AbortSignal.any([init.signal, pageSession.signal]) : pageSession.signal };
  }

  // Observe the site's existing session reads (including title freshAuth)
  // without changing their arguments, Response, errors, or request count.
  // Never clone conversation bodies or publish credentials over the bridge.
  const originalFetch = global.fetch;
  let tidyIdentityFetch = null;
  if (typeof originalFetch === "function") {
    tidyIdentityFetch = function tidyIdentityFetch(...args) {
      // A later third-party wrapper may retain us in its chain. Stay a pure
      // passthrough after disposal without changing Promise or error identity.
      if (!pageSession.check()) return originalFetch.apply(this, args);
      if (!sessionEndpoint(args[0])) {
        const ticket = renameTicket(args[0], args[1]);
        let request;
        try { request = originalFetch.apply(this, args); }
        catch (error) { void observeRename(ticket, null).catch(() => {}); throw error; }
        if (ticket) void Promise.resolve(request).then(response => observeRename(ticket, response),
          () => observeRename(ticket, null)).catch(() => {});
        return request;
      }
      const ticket = sessionTicket();
      const request = originalFetch.apply(this, args);
      const observed = Promise.resolve(request).then(async response => {
        if (!pageSession.check()) return;
        if (response && typeof response === "object") responseTickets.set(response, ticket);
        if (!response?.ok) {
          if ([401, 403].includes(response?.status) && currentSessionTicket(ticket)) {
            acceptedSessionSequence = ticket.sequence;
            invalidateIdentity(identityError());
          }
          return;
        }
        // Real Fetch Responses are cloneable. Lightweight adapter mocks can
        // still feed the same acceptance path through loadSession below.
        if (typeof response.clone === "function") {
          const session = await response.clone().json();
          if (pageSession.check()) acceptSession(session, ticket);
        }
      }).catch(() => {
        // A network/JSON failure is not evidence that the owner changed.
      }).finally(() => {
        if (observedSessionPending?.promise === observed) observedSessionPending = null;
      });
      if (pageSession.check()) observedSessionPending = { promise: observed, ticket };
      return request;
    };
    global.fetch = tidyIdentityFetch;
  }

  async function readLibraryAccount({ retry = false } = {}) {
    pageSession.assertActive();
    checkLibraryIdentity();
    if (libraryIdentity.phase === "ready") return { accountKey: libraryIdentity.accountKey, epoch: libraryIdentity.epoch };
    if (!documentActive || libraryWorkspace === null) throw libraryFailure || identityError();
    if (libraryPending) return libraryPending;
    // Only an explicit user retry may re-arm a failed initialization. Ordinary
    // route/focus/library requests remain network-free after that one failure.
    if (retry === true) { libraryAttempted = false; libraryFailure = null; }
    if (libraryAttempted) throw libraryFailure || identityError();
    libraryAttempted = true;
    const boundary = identityBoundary;
    const workspace = libraryWorkspace;
    const observed = observedSessionPending?.ticket.boundary === boundary ? observedSessionPending.promise : null;
    const pending = (async () => {
      let session;
      try {
        if (observed) await observed;
        else session = await loadSession({ refresh: true });
        pageSession.assertActive();
        checkLibraryIdentity();
        if (!documentActive || libraryWorkspace !== workspace || identityBoundary !== boundary) {
          throw (libraryIdentity.phase === "unavailable" && libraryFailure)
            || identityError("The page identity changed while reading library ownership.", "CONTEXT_MISMATCH");
        }
        if (session && libraryIdentity.phase === "ready" && sessionOwner(session, workspace) !== libraryIdentity.accountKey) {
          throw identityError("A newer library owner replaced this session response.", "CONTEXT_MISMATCH");
        }
        if (libraryIdentity.phase !== "ready") {
          throw libraryFailure || identityError();
        }
        return { accountKey: libraryIdentity.accountKey, epoch: libraryIdentity.epoch };
      } catch (error) {
        pageSession.assertActive();
        if (identityBoundary === boundary && libraryIdentity.phase !== "ready") libraryFailure = error;
        throw error;
      } finally {
        if (libraryPending === pending) libraryPending = null;
      }
    })();
    libraryPending = pending;
    return pending;
  }

  function catalogIdentity(session) {
    // One pure projection for directory/cache identity. It intentionally does
    // not fetch a session or equate the catalog key with a title user ID or
    // workspace cookie. Callers keep their own missing-identity error type.
    const string = (value) => typeof value === "string" ? value.trim() : "";
    const accountId = string(session?.activeAccountId)
      || string(session?.active_account_id) || string(session?.account?.id);
    return { accountKey: accountId || string(session?.user?.id), accountId: accountId || null };
  }

  function requestHeaders(initHeaders, accessToken) {
    const headers = new global.Headers(initHeaders || {});
    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${accessToken}`);
    return headers;
  }

  async function loadSession({ refresh = false } = {}) {
    pageSession.assertActive();
    if (!refresh && cachedSession) return cachedSession;
    if (!refresh && sessionRequest) return sessionRequest;
    const request = (async () => {
      const response = await global.fetch(SESSION_ENDPOINT, tidyRequestInit({
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
      }));
      pageSession.assertActive();
      if (!response.ok) {
        // Preserve the status without copying the session/error body. Consumers
        // must not turn a real 429/5xx into an alleged login/account change.
        throw Object.assign(new Error(`ChatGPT session could not be read (${response.status}).`), {
          status: response.status,
        });
      }
      const session = await response.json();
      pageSession.assertActive();
      if (!session || typeof session !== "object") {
        throw new Error("ChatGPT session response is invalid.");
      }
      const accessToken = session?.accessToken || session?.access_token || "";
      if (typeof accessToken !== "string" || !accessToken.trim()) {
        throw new Error("ChatGPT session did not provide an access token.");
      }
      const ticket = responseTickets.get(response);
      if (ticket) acceptSession(session, ticket);
      // A response begun before an identity boundary must not restore an old
      // token cache after a newer session/workspace has already been observed.
      if (!ticket || currentSessionTicket(ticket)) {
        cachedSession = session;
        cachedAccessToken = accessToken;
      }
      return session;
    })();

    sessionRequest = request;
    try {
      const session = await request;
      pageSession.assertActive();
      return session;
    } finally {
      if (sessionRequest === request) sessionRequest = null;
    }
  }

  async function loadAccessToken({ refresh = false } = {}) {
    pageSession.assertActive();
    if (!refresh && cachedAccessToken) return cachedAccessToken;
    const session = await loadSession({ refresh });
    pageSession.assertActive();
    return session.accessToken || session.access_token;
  }

  async function fetchAuthenticated(input, init = {}) {
    pageSession.assertActive();
    async function send(refresh) {
      pageSession.assertActive();
      const accessToken = await loadAccessToken({ refresh });
      pageSession.assertActive();
      return global.fetch(input, tidyRequestInit({
        ...init,
        credentials: "include",
        headers: requestHeaders(init.headers, accessToken),
      }));
    }

    let response = await send(false);
    pageSession.assertActive();
    if (response.status === 401) {
      cachedSession = null;
      cachedAccessToken = "";
      response = await send(true);
      pageSession.assertActive();
    }
    return response;
  }

  function onPageHide() {
    if (!pageSession.check()) return;
    documentActive = false;
    invalidateIdentity(identityError("The page document is no longer active.", "CONTEXT_MISMATCH"), { force: true, transition: "document-hidden" });
  }
  function onPageShow() {
    if (!pageSession.check()) return;
    if (documentActive) return;
    documentActive = true;
    libraryWorkspace = undefined;
    libraryAttempted = false;
    libraryFailure = null;
    checkLibraryIdentity();
    // The pagehide event may have been dropped after Chrome marked this
    // document cached. Re-announce the revoked lease from the active document;
    // BFCache restoration must not leave the worker holding its old ready epoch.
    publishIdentity();
  }
  function onPrerenderingChange() {
    if (!pageSession.check()) return;
    if (checkLibraryIdentity().phase === "ready") publishIdentity();
    else void readLibraryAccount({ retry: true }).catch(() => {});
  }
  global.addEventListener?.("pagehide", onPageHide);
  global.addEventListener?.("pageshow", onPageShow);
  if (global.document?.prerendering) {
    // Prerender activation is a real document boundary, not ordinary focus.
    // Its earlier events may have been rejected by the active-document worker
    // guard, so republish the ready identity (or initialize it once) on entry.
    global.document.addEventListener("prerenderingchange", onPrerenderingChange, { once: true });
  }

  pageSession.onDispose(() => {
    documentActive = false;
    invalidateIdentity(pageSession.error(), { force: true, transition: "document-hidden" });
    observedSessionPending = null;
    identityListeners.clear();
    titleListeners.clear();
    global.removeEventListener?.("pagehide", onPageHide);
    global.removeEventListener?.("pageshow", onPageShow);
    global.document?.removeEventListener?.("prerenderingchange", onPrerenderingChange);
    // Never overwrite somebody else's wrapper or abort a site-owned request.
    if (global.fetch === tidyIdentityFetch) global.fetch = originalFetch;
  });

  global.TidyChatgptApi = Object.freeze({ activeWorkspace, readLibraryAccount, checkLibraryIdentity,
    onLibraryIdentityChanged, onTitleChanged, fetchTitleRequest, catalogIdentity, loadSession, loadAccessToken, fetchAuthenticated });
})(globalThis);
