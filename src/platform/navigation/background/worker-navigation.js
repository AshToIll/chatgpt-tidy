import { assertAccountKey } from "../../storage/database.js";
import { parseConversationRoute } from "../conversation-route.js";
import { assertExpectedConversationContext } from "../../context-guard.js";
import "../../protocol.js";
import "../navigation-identity.js";

/**
 * 每个标签页只维护一个导航归属，避免旧的“跳到书签/搜索消息”盖过新操作。
 * 导航凭证、截止时间和已取消记录留在模块内部，外部只能使用只读句柄。
 * 浏览器操作和账号核验通过回调提供，不允许回调直接篡改导航状态。
 * 搜索查询规则由组合根注入，导航平台不反向加载搜索功能模块。
 */
export function createWorkerNavigation({
  chrome, allocateNavigationEpoch, navigationSenderTab, getBoundTab,
  libraryDocument, readLibraryAccount, readLibraryIdentity, assertLibraryContext,
  requestTabMessageLocation, searchContract,
}) {
  const protocol = globalThis.TidyProtocol;
  const navigationIdentity = globalThis.TidyNavigationIdentity;
  const navigationIntents = new Map();
  const handles = new WeakMap();
  let navigationSequence = 0;
  function libraryError(message) {
    return Object.assign(new Error(message), { tidyCode: protocol.ErrorCode.CONTEXT_MISMATCH });
  }

  function navigationId(value) {
    if (typeof value !== "string" || !value || value.length > 160 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
      throw libraryError("This navigation needs its exact intent ID.");
    }
    return value;
  }

  function beginNavigation(envelope, sender) {
    const payload = envelope.payload || {}, identity = payload.expectedIdentity;
    const search = envelope.type === protocol.Type.SEARCH_OPEN_RESULT;
    const tabId = navigationSenderTab(payload, sender, !search);
    if ((envelope.type === protocol.Type.BOOKMARKS_OPEN_CONVERSATION_VIEW && !sender?.tab)
      || (!search && (typeof identity?.documentId !== "string" || !identity.documentId
        || !Number.isSafeInteger(identity.epoch) || identity.epoch < 0))) {
      throw libraryError("This library navigation needs its exact sender tab and document lease.");
    }
    let accountKey = null;
    if (!search) {
      try { accountKey = assertAccountKey(payload.expectedAccountKey); }
      catch { throw libraryError("This library navigation needs its account owner."); }
    }
    const target = envelope.type === protocol.Type.BOOKMARKS_OPEN ? payload.bookmarkId : payload.conversationId;
    if (typeof target !== "string" || !target || target !== target.trim()
      || (envelope.type === protocol.Type.BOOKMARKS_OPEN ? target.length > 1536 : !/^[A-Za-z0-9_-]+$/.test(target))) {
      throw libraryError("The requested library navigation target is invalid.");
    }
    if (search && (!["keyword", "conversation"].includes(payload.navigationKind)
      || typeof payload.resultId !== "string" || !payload.resultId.trim()
      || (payload.messageId != null && (typeof payload.messageId !== "string" || !payload.messageId.trim()))
      || (payload.navigationKind === "keyword" && (typeof payload.query !== "string" || !payload.query.trim()
        || payload.query.length > searchContract.MAX_QUERY_LENGTH))
      || (payload.navigationKind === "conversation" && (payload.messageId != null || (payload.query != null && payload.query !== ""))))) {
      throw libraryError("The search result locator is invalid.");
    }
    // This is only a pure ingress filter, not authorization. The normal panel
    // configuration, stored membership, account and document proofs still run.
    const key = JSON.stringify([envelope.type, target, accountKey, identity?.documentId, identity?.epoch,
      search ? payload.navigationKind : null, search ? payload.messageId : null, search ? payload.query : null]);
    const id = payload.navigationIntentId == null ? protocol.createRequestId("navigation") : navigationId(payload.navigationIntentId);
    const previous = navigationIntents.get(tabId);
    if (previous?.id === id) {
      if (previous.key !== key || previous.cancelled) throw libraryError("A retired navigation ID cannot be reused.");
      return previous;
    }
    const ticket = { tabId, id, key, type: envelope.type, sequence: ++navigationSequence, workerEpoch: null,
      accountKey, sourceDocumentId: identity?.documentId || null, documentId: identity?.documentId || null,
      conversationId: envelope.type === protocol.Type.BOOKMARKS_OPEN ? null : target,
      messageId: search ? payload.messageId || null : null, query: search ? payload.query || "" : null,
      navigationKind: search ? payload.navigationKind : null,
      cancelled: false, dispatched: false,
      expectedUrl: null, fullPage: false, committedDocumentId: null, sawDestination: false,
      // One accepted-click budget across documents and identity observations.
      loadDeadlineAt: Date.now() + navigationIdentity.LOAD_WINDOW_MS };
    ticket.deadlineAt = ticket.loadDeadlineAt + navigationIdentity.LANDING_WINDOW_MS;
    ticket.deadlineTimer = hasLocation(ticket) ? setTimeout(() => {
      if (navigationIntents.get(tabId) !== ticket || ticket.cancelled || ticket.completed) return;
      finishLocationNavigation(ticket, { located: false, reason: "target-timeout" });
      retireNavigation(ticket, "target-timeout", { broadcast: false });
    }, Math.max(0, ticket.deadlineAt - Date.now())) : null;
    // Retire synchronously, before epoch allocation, Chrome APIs or storage.
    navigationIntents.set(tabId, ticket);
    if (previous) retireNavigation(previous, "superseded");
    return ticket;
  }

  function assertNavigationTicket(ticket) {
    if (!ticket || ticket.cancelled || navigationIntents.get(ticket.tabId) !== ticket) {
      throw libraryError("A newer library navigation replaced this request.");
    }
  }

  function assertLibraryNavigation(context) {
    assertLibraryContext(context);
    return ticketFor(context.navigationHandle);
  }

  async function publishNavigationControl(ticket, phase = "active", documentId = ticket.documentId) {
    ticket.workerEpoch ??= await allocateNavigationEpoch();
    if (phase === "active") assertNavigationTicket(ticket);
    if (!documentId) throw libraryError("The navigation document is unavailable.");
    const envelope = protocol.request(protocol.Type.NAVIGATION_INTENT, navigationControl(ticket, phase));
    const response = await chrome.tabs.sendMessage(ticket.tabId, envelope, { documentId });
    if (phase === "active") {
      assertNavigationTicket(ticket);
      if (!protocol.isResponse(response, envelope.requestId) || response.type !== envelope.type || !response.ok || response.payload?.accepted !== true) {
        throw libraryError("The page rejected this obsolete navigation intent.");
      }
      ticket.installedDocumentId = documentId;
      ticket.installedConversationId = ticket.conversationId;
    }
  }

  function navigationControl(ticket, phase = "active") {
    return { navigationIntentId: ticket.id, workerEpoch: ticket.workerEpoch,
      sequence: ticket.sequence, phase, conversationId: ticket.conversationId,
      // The source page needs the command owner too: refresh can happen between
      // accepted OPEN and the first LOCATE, including same-document navigation.
      ...((hasLocation(ticket) || isNativeSearch(ticket)) ? { ownerAccountKey: ticket.accountKey } : {}) };
  }

  const isNativeSearch = ticket => ticket.type === protocol.Type.SEARCH_OPEN_RESULT && ticket.navigationKind === "keyword";
  const isMessageNavigation = ticket => ticket.type === protocol.Type.BOOKMARKS_OPEN;

  const isLatestNavigation = ticket => ticket.type === protocol.Type.FAVORITES_OPEN
    || (ticket.type === protocol.Type.SEARCH_OPEN_RESULT && ticket.navigationKind === "conversation");
  const hasLocation = ticket => isMessageNavigation(ticket) || isLatestNavigation(ticket);
  // 搜索承诺同文档导航；任何加载/落点失败都不能借兜底刷新整页和官方左栏。
  const allowsFullPage = ticket => ticket.type !== protocol.Type.SEARCH_OPEN_RESULT;
  const nativeFailure = result => ["native-router-unavailable", "native-router-failed", "native-router-timeout", "native-route-unconfirmed"].includes(result?.reason);
  const canFallback = result => ["native-router-unavailable", "native-router-failed"].includes(result?.reason);
  // 只允许目标等待/加载或落稳失败触发整页补载；用户取消和账号变化不重试。
  const FALLBACK_RESULTS = new Set(["native-target-missing", "loading-unstable", "landing-unstable", "landing-timeout"]);
  const matchesDestination = (ticket, route) => route?.conversationId === ticket.conversationId
    && (!parseConversationRoute(ticket.routePath)?.projectId || route.projectId === parseConversationRoute(ticket.routePath).projectId);

  async function prepareNavigation(ticket, tab, identity = null) {
    assertNavigationTicket(ticket);
    const documentId = identity?.documentId || (await libraryDocument(tab)).documentId;
    assertNavigationTicket(ticket);
    if (ticket.sourceDocumentId && ticket.sourceDocumentId !== documentId) throw libraryError("The navigation source document changed.");
    ticket.sourceDocumentId = ticket.documentId = documentId;
    if (identity) { ticket.identityEpoch = identity.epoch; ticket.identityDocumentId = documentId; }
    else {
      const record = readLibraryIdentity(tab.id);
      if (record?.phase === "ready") {
        ticket.accountKey = record.accountKey;
        ticket.identityEpoch = record.epoch;
        ticket.identityDocumentId = documentId;
      }
    }
    ticket.originConversationId = parseConversationRoute(tab.url)?.conversationId || null;
    if (ticket.conversationId && ticket.originConversationId === ticket.conversationId) ticket.sawDestination = true;
    ticket.originUrl = tab.url;
    if (ticket.installedDocumentId !== documentId || ticket.installedConversationId !== ticket.conversationId) await publishNavigationControl(ticket);
    assertNavigationTicket(ticket);
  }

  function retireNavigation(ticket, reason, { broadcast = true } = {}) {
    if (!ticket || ticket.cancelled) return false;
    ticket.cancelled = true;
    clearTimeout(ticket.deadlineTimer);
    if (ticket.documentId) void publishNavigationControl(ticket, "cancelled").catch(() => {});
    if (broadcast) chrome.runtime.sendMessage(protocol.event(protocol.Type.NAVIGATION_CANCELLED,
      { tabId: ticket.tabId, navigationIntentId: ticket.id, reason })).catch(() => {});
    return true;
  }

  function cancelNavigation(payload, sender) {
    const tabId = navigationSenderTab(payload, sender);
    const id = navigationId(payload?.navigationIntentId), ticket = navigationIntents.get(tabId);
    if (!ticket || ticket.id !== id) return { cancelled: false };
    if (sender?.tab && sender.documentId !== ticket.documentId) return { cancelled: false };
    // A dispatched full-page transition retires the source page's local effect,
    // not the one allowed continuation in the exact destination document.
    if (sender?.tab && ticket.fullPage && sender.documentId === ticket.sourceDocumentId
      && payload.reason === "page-hidden") return { cancelled: false };
    return { cancelled: retireNavigation(ticket, payload.reason || "cancelled") };
  }

  function observeNavigationRoute(details, committed = false) {
    const ticket = navigationIntents.get(details.tabId);
    if (!ticket || ticket.cancelled || details.frameId !== 0) return;
    if (details.documentId && ticket.documentId && details.documentId !== ticket.documentId && !committed) return;
    const target = parseConversationRoute(details.url)?.conversationId || null;
    if (committed) {
      if (ticket.fullPage && ticket.dispatched && target === ticket.conversationId
        && details.url === ticket.expectedUrl
        && !ticket.committedDocumentId && details.documentId && details.documentId !== ticket.sourceDocumentId) {
        ticket.committedDocumentId = ticket.documentId = details.documentId;
        ticket.sawDestination = true;
        ticket.installedDocumentId = null;
        return;
      }
      retireNavigation(ticket, "document-changed"); return;
    }
    if (target && target === ticket.conversationId && (ticket.dispatched || ticket.sawDestination)) { ticket.sawDestination = true; return; }
    if (!ticket.sawDestination && details.url === ticket.originUrl) return;
    retireNavigation(ticket, "route-changed");
  }

  function acceptNavigationResult(payload, sender) {
    // MAIN reports only its exact execution. The worker supplies trusted tab /
    // document ownership and rejects stale, duplicate or cross-target receipts.
    const tabId = navigationSenderTab({}, sender), ticket = navigationIntents.get(tabId);
    if (!sender?.tab || !sender.documentId || !ticket || ticket.cancelled || ticket.completed
      || !hasLocation(ticket) || ticket.documentId !== sender.documentId
      || ticket.id !== payload?.navigationIntentId || ticket.conversationId !== payload.conversationId
      || ticket.messageId !== payload.messageId || payload.pending !== false
      || (isLatestNavigation(ticket) && payload.placement !== "latest")
      || typeof payload.located !== "boolean" || (payload.reason != null && typeof payload.reason !== "string")) return;
    // 整页补载已发出后，源页的迟到回执不能结束目标文档的任务。
    if (ticket.fullPage && sender.documentId === ticket.sourceDocumentId) return;
    if (payload.located) {
      const identity = readLibraryIdentity(tabId);
      if (identity?.documentId !== sender.documentId || navigationIdentity.state(identity, ticket.accountKey) !== "ready") return;
    }
    // 无刷新未完成定位时只补载一次，仍属于同一次点击，不能先通知失败再继续跳。
    if (allowsFullPage(ticket) && ticket.nativeAttempt && !ticket.fullPage && !payload.located && FALLBACK_RESULTS.has(payload.reason)) {
      if (!ticket.nativeFallbackPending) {
        ticket.nativeFallbackPending = true;
        void continueFullPage(ticket).catch(() => {
          finishLocationNavigation(ticket, { located: false, reason: "context-unavailable" });
        });
      }
      return;
    }
    finishLocationNavigation(ticket, payload);
  }

  async function continueFullPage(ticket) {
    if (!allowsFullPage(ticket)) throw libraryError("Search navigation cannot reload the ChatGPT document.");
    const tab = await getBoundTab(ticket.tabId);
    assertNavigationTicket(ticket);
    const document = await libraryDocument(tab);
    assertNavigationTicket(ticket);
    const identity = readLibraryIdentity(ticket.tabId), route = parseConversationRoute(tab.url);
    const atDestination = matchesDestination(ticket, route);
    // 路由器拒绝/没有动作时可以从原页兜底；已经离开目标的用户不能被旧任务拉回。
    const atOrigin = !ticket.sawDestination && tab.url === ticket.originUrl;
    if (ticket.completed || document.documentId !== ticket.sourceDocumentId || identity?.documentId !== document.documentId
      || navigationIdentity.state(identity, ticket.accountKey) !== "ready"
      || (!atDestination && !atOrigin)) {
      throw libraryError("The native destination is no longer current.");
    }
    // 普通 /c 地址可被官方正规化为项目地址；只接受同一会话，已指定项目则必须匹配。
    if (atDestination) ticket.routePath = route.pathname;
    return loadTargetDocument(ticket, tab);
  }

  async function loadTargetDocument(ticket, tab) {
    assertNavigationTicket(ticket);
    if (!allowsFullPage(ticket)) throw libraryError("Search navigation cannot reload the ChatGPT document.");
    if (ticket.completed || ticket.fullPage) return ticket.result;
    if (Date.now() >= ticket.loadDeadlineAt) {
      finishLocationNavigation(ticket, { located: false, reason: "target-timeout" });
      return ticket.result;
    }
    const url = new URL(ticket.routePath, "https://chatgpt.com");
    if (isMessageNavigation(ticket)) url.searchParams.set("messageId", ticket.messageId);
    ticket.dispatched = true; ticket.fullPage = true; ticket.expectedUrl = url.href;
    await chrome.tabs.update(tab.id, { url: url.href });
    assertNavigationTicket(ticket);
    return { located: false, navigated: true, pending: true, reason: "loading-conversation",
      navigationIntentId: ticket.id, mode: "full-page" };
  }

  function finishLocationNavigation(ticket, payload) {
    if (ticket.cancelled || ticket.completed || navigationIntents.get(ticket.tabId) !== ticket) return;
    ticket.completed = true;
    clearTimeout(ticket.deadlineTimer);
    const expired = payload.located && Date.now() > ticket.deadlineAt;
    const result = { tabId: ticket.tabId, navigationIntentId: ticket.id, conversationId: ticket.conversationId,
      ...(isLatestNavigation(ticket) ? { placement: "latest" } : {}),
      messageId: ticket.messageId, located: payload.located && !expired, reason: expired ? "target-timeout" : payload.reason || null,
      highlighted: payload.highlighted === true && !expired, highlightReason: typeof payload.highlightReason === "string" ? payload.highlightReason : null };
    ticket.result = result;
    void chrome.runtime.sendMessage(protocol.event(protocol.Type.NAVIGATION_RESULT, result)).catch(() => {});
  }

  async function executeMessageNavigation(ticket, tab, { waitForTarget = false } = {}) {
    assertNavigationTicket(ticket);
    // 同一次 OPEN 单飞。源页探测不启动缺席目标的定位器；原生路由被接受
    // 后才开始等待。整页兜底也只接续到浏览器证明的那个目标文档。
    if (ticket.executionDocumentId === ticket.documentId) return ticket.execution;
    ticket.executionDocumentId = ticket.documentId;
    ticket.execution = Promise.resolve().then(async () => {
      assertNavigationTicket(ticket);
      if (Date.now() >= ticket.loadDeadlineAt) {
        finishLocationNavigation(ticket, { located: false, reason: "target-timeout" });
        return { located: false, pending: false, reason: "target-timeout", navigationIntentId: ticket.id };
      }
      const locate = extra => requestTabMessageLocation(tab, {
        navigationIntentId: ticket.id, conversationId: ticket.conversationId, messageId: ticket.messageId,
        query: ticket.query || "", navigationControl: navigationControl(ticket), waitForTarget,
        loadDeadlineAt: ticket.loadDeadlineAt, deadlineAt: ticket.deadlineAt, ...extra,
      }, ticket.documentId);
      const result = await locate();
      assertNavigationTicket(ticket);
      if (result?.pending && (result.targetPresent || waitForTarget)) {
        return { ...result, navigationIntentId: ticket.id, mode: result.reason };
      }
      if (result?.located || ticket.completed) return { ...result, navigationIntentId: ticket.id };
      // 书签才使用自有精确消息执行器；关键词的定位和高亮完全交还官方搜索。
      // 同一书签只允许一次原生加载，不在落稳后重新派发导航。
      if (ticket.fullPage || waitForTarget) return { ...result, navigationIntentId: ticket.id };
      if (ticket.originConversationId !== ticket.conversationId) {
        const identity = readLibraryIdentity(ticket.tabId);
        if (identity?.documentId !== ticket.documentId || navigationIdentity.state(identity, ticket.accountKey) !== "ready") {
          throw libraryError("The navigation owner is no longer ready.");
        }
        ticket.dispatched = true;
        const opened = await requestLibraryNavigation(ticket, identity);
        if (opened?.navigated) {
          // 书签只加载目标会话，随后由精确消息执行器定位。
          ticket.nativeAttempt = true;
          const pending = await locate({ waitForTarget: true, waitForConversation: true,
            nativeFallbackAt: Math.min(ticket.loadDeadlineAt, Date.now() + navigationIdentity.NATIVE_TARGET_WINDOW_MS) });
          assertNavigationTicket(ticket);
          return { ...pending, navigationIntentId: ticket.id, mode: "same-document" };
        }
        if (!canFallback(opened)) throw libraryError("The native message opening was not confirmed.");
      }
      return continueFullPage(ticket);
    });
    return ticket.execution;
  }

  async function resumeLocationNavigation(ticket) {
    if (!ticket || !hasLocation(ticket) || ticket.cancelled || ticket.completed || !ticket.fullPage
      || !ticket.committedDocumentId || ticket.resumedDocumentId === ticket.committedDocumentId) return;
    const identity = readLibraryIdentity(ticket.tabId);
    if (identity?.documentId !== ticket.committedDocumentId || navigationIdentity.state(identity, ticket.accountKey) !== "ready") return;
    // Commit proves this document's ORIGINAL URL. Identity proves its owner.
    // ChatGPT may already have removed messageId/query; they are no longer a
    // continuation token. Mark once before the first await, retaining deadlines.
    ticket.resumedDocumentId = ticket.committedDocumentId;
    try {
      const tab = await getBoundTab(ticket.tabId);
      assertNavigationTicket(ticket);
      const route = parseConversationRoute(tab.url);
      if (!route || !matchesDestination(ticket, route)) {
        retireNavigation(ticket, "route-changed"); return;
      }
      await publishNavigationControl(ticket);
      assertNavigationTicket(ticket);
      if (isMessageNavigation(ticket)) await executeMessageNavigation(ticket, tab, { waitForTarget: true });
      else {
        const result = await requestLibraryNavigation(ticket, identity);
        if (!result?.navigated) throw libraryError("The latest-conversation continuation was not accepted.");
      }
    } catch {
      finishLocationNavigation(ticket, { located: false, reason: "context-unavailable" });
      retireNavigation(ticket, "context-unavailable", { broadcast: false });
    }
  }

  async function navigateLibrary(context, routePath, conversationId) {
    const ticket = assertLibraryNavigation(context);
    ticket.conversationId = conversationId;
    ticket.routePath = routePath;
    if (ticket.installedConversationId !== conversationId) await publishNavigationControl(ticket);
    assertLibraryNavigation(context);
    const key = JSON.stringify([context.identity.epoch, routePath, conversationId]);
    const active = ticket.libraryOperation;
    if (active?.key === key) {
      // Only an exact retry of the same opaque intent may share its promise.
      return active.promise;
    }
    const operation = { key, promise: null, fullDispatched: false };
    ticket.libraryOperation = operation;
    operation.promise = Promise.resolve().then(() => dispatchLibraryNavigation(context, ticket, routePath, conversationId, operation))
      .finally(() => {
        // A tabs.update acknowledgement may precede onCommitted. Keep that
        // dispatched fallback latched until the real document boundary arrives.
        if (!operation.fullDispatched && ticket.libraryOperation === operation) delete ticket.libraryOperation;
      });
    return operation.promise;
  }

  async function requestLibraryNavigation(ticket, identity) {
    // 关键词携带官方搜索上下文；会话最新位置与书签不伪造任何搜索参数。
    const request = protocol.request(protocol.Type.LIBRARY_NAVIGATE, {
      pathname: ticket.routePath, conversationId: ticket.conversationId, expectedAccountKey: ticket.accountKey,
      expectedEpoch: identity.epoch,
      navigationIntentId: ticket.id,
      ...(isNativeSearch(ticket) ? { placement: "native-search", messageId: ticket.messageId, query: ticket.query,
        loadDeadlineAt: ticket.loadDeadlineAt } : {}),
      ...(isLatestNavigation(ticket) ? { placement: "latest",
        loadDeadlineAt: ticket.loadDeadlineAt, deadlineAt: ticket.deadlineAt,
        ...(allowsFullPage(ticket) && !ticket.fullPage ? { nativeFallbackAt: Math.min(ticket.loadDeadlineAt,
          Date.now() + navigationIdentity.NATIVE_TARGET_WINDOW_MS) } : {}) } : {}),
    });
    let response;
    try { response = await chrome.tabs.sendMessage(ticket.tabId, request, { documentId: identity.documentId }); }
    catch (cause) {
      assertNavigationTicket(ticket);
      throw Object.assign(new Error("The native navigation request could not reach this ChatGPT document."), {
        tidyCode: protocol.ErrorCode.ADAPTER_UNAVAILABLE,
        details: { stage: "native-navigation.transport", disconnect: protocol.runtimeDisconnectReason(cause) }, cause,
      });
    }
    assertNavigationTicket(ticket);
    if (!protocol.isResponse(response, request.requestId) || response.type !== request.type) {
      throw Object.assign(new Error("The native navigation returned an invalid response."), {
        tidyCode: protocol.ErrorCode.ADAPTER_UNAVAILABLE, details: { stage: "native-navigation.response" },
      });
    }
    if (!response.ok) throw Object.assign(new Error(response.error?.message || "The native navigation adapter failed."), {
      // 超时/断桥不是“会话已变”：保留真实 bridge 错误，供界面只报当前动作。
      tidyCode: response.error?.code || protocol.ErrorCode.ADAPTER_UNAVAILABLE,
      details: response.error?.details || { stage: "native-navigation.adapter" },
    });
    return response.payload;
  }

  async function dispatchLibraryNavigation(context, ticket, routePath, conversationId, operation) {
    assertLibraryContext(context);
    assertNavigationTicket(ticket);
    const route = parseConversationRoute(routePath);
    if (!route || route.pathname !== routePath || route.conversationId !== conversationId) {
      throw libraryError("The saved library conversation route is invalid.");
    }
    ticket.dispatched = true;
    ticket.expectedUrl = `https://chatgpt.com${route.pathname}`;
    ticket.nativeAttempt = true;
    const result = await requestLibraryNavigation(ticket, context.identity);
    if (result?.navigated === true) return "same-document";
    if (!canFallback(result)) throw libraryError("The saved conversation navigation changed.");
    assertLibraryContext(context);
    assertNavigationTicket(ticket);
    await continueFullPage(ticket);
    operation.fullDispatched = ticket.fullPage;
    assertNavigationTicket(ticket);
    if (!ticket.fullPage) throw libraryError("The navigation loading budget expired before fallback.");
    // A positive browser acknowledgement is the only authority for the panel's
    // one-time, same-account handoff to a new document. Failures never get it.
    return "full-page";
  }

  function ticketFor(handle) {
    const ticket = handles.get(handle);
    assertNavigationTicket(ticket);
    return ticket;
  }

  function begin(envelope, sender) {
    const ticket = beginNavigation(envelope, sender);
    if (!ticket.handle) {
      ticket.handle = Object.freeze({ tabId: ticket.tabId, id: ticket.id });
      handles.set(ticket.handle, ticket);
    }
    return ticket.handle;
  }

  async function openSearch(handle, payload, sender) {
    const ticket = ticketFor(handle);
    // 从第一次异步读取开始单飞，而非仅合并最终路由调用。重复 IPC 不得另读
    // 身份后覆盖同一点击的源页面，更不能用迟到失败撤销已在执行的原生交接。
    // 一个搜索点击只派发一次原生同文档导航。关键词的定位/标黄由官方所有；
    // 日期才等待我们自己的 latest 回执，二者都不允许整页兜底。
    ticket.searchOperation ??= Promise.resolve().then(async () => {
      assertNavigationTicket(ticket);
      const tab = await getBoundTab(payload.expectedTabId, sender);
      assertExpectedConversationContext(tab, null, { tabId: ticket.tabId });
      assertNavigationTicket(ticket);
      const verified = await readLibraryAccount(tab);
      assertNavigationTicket(ticket);
      if (verified) ticket.accountKey = verified.accountKey;
      await prepareNavigation(ticket, tab, verified?.identity);
      assertNavigationTicket(ticket);
      const currentRoute = parseConversationRoute(tab.url);
      ticket.routePath = currentRoute?.conversationId === ticket.conversationId ? currentRoute.pathname : "/c/" + encodeURIComponent(ticket.conversationId);
      ticket.dispatched = true; ticket.nativeAttempt = true;
      const opened = await requestLibraryNavigation(ticket, verified.identity);
      if (opened?.navigated !== true) {
        if (!nativeFailure(opened)) throw libraryError("The search conversation navigation changed.");
        throw Object.assign(new Error("The native search navigation is unavailable."), {
          tidyCode: protocol.ErrorCode.ADAPTER_UNAVAILABLE,
          details: { stage: "native-navigation", reason: opened.reason },
        });
      }
      if (isNativeSearch(ticket)) {
        if (opened.presentationOwner !== "native") throw Object.assign(new Error("The native search controller did not accept this navigation."), {
          tidyCode: protocol.ErrorCode.ADAPTER_UNAVAILABLE,
          details: { stage: "native-navigation", reason: "native-search-not-accepted" },
        });
        // 此回执只证明原生导航已接受，绝不伪称已完成消息定位或黄色高亮。
        // 官方控制器接手后不再运行 Tidy 的落点超时/重试/完成事件。
        ticket.completed = true;
        ticket.result = { navigated: true, presentationOwner: "native",
          navigationIntentId: ticket.id, mode: "same-document" };
        return ticket.result;
      }
      return { located: false, navigated: true, pending: true, reason: "loading-conversation",
        navigationIntentId: ticket.id, mode: "same-document" };
    });
    return ticket.searchOperation;

  }

  async function selectBookmark(handle, bookmark) {
    const ticket = ticketFor(handle);
    ticket.conversationId = bookmark.conversationId;
    ticket.messageId = bookmark.messageId;
    if (ticket.installedConversationId !== bookmark.conversationId) await publishNavigationControl(ticket);
  }

  function openBookmark(handle, tab, routePath) {
    const ticket = ticketFor(handle);
    ticket.routePath = routePath;
    return executeMessageNavigation(ticket, tab);
  }

  // Called only after the worker validates the browser document and event
  // epoch, before it replaces the library lease. Resume follows that update.
  function identityChanged(payload, sender, previousEpoch) {
    const intent = navigationIntents.get(sender.tab.id);
    if (intent && !intent.cancelled && intent.documentId === sender.documentId) {
      const departingSource = intent.fullPage && intent.dispatched && sender.documentId === intent.sourceDocumentId
        && payload.phase === "unavailable" && payload.transition === "document-hidden";
      const messageNavigation = hasLocation(intent) || isNativeSearch(intent);
      const identityState = navigationIdentity.state(payload, intent.accountKey);
      if (departingSource) {
        // pagehide revokes the SOURCE lease; it is not a user account switch and
        // cannot consume the one destination handoff before onCommitted arrives.
      } else if (messageNavigation && identityState === "waiting") {
        // Retain the same read-only command; the page gate pauses presentation.
        // Data transactions below still lose their lease in the normal way.
      } else if (identityState === "revoked" || (!messageNavigation && (payload.phase !== "ready"
        || (intent.identityEpoch != null && intent.identityDocumentId === sender.documentId && intent.identityEpoch !== payload.epoch)))) {
        retireNavigation(intent, "identity-changed");
      } else {
        intent.accountKey = payload.accountKey;
        intent.identityEpoch = payload.epoch;
        intent.identityDocumentId = sender.documentId;
      }
    }
    if (intent && previousEpoch !== payload.epoch) delete intent.libraryOperation;
  }

  function committed(details) {
    observeNavigationRoute(details, true);
  }

  function closeTab(tabId) {
    retireNavigation(navigationIntents.get(tabId), "tab-closed");
    navigationIntents.delete(tabId);
  }

  function fail(handle) {
    const ticket = handles.get(handle);
    if (ticket && !ticket.completed) retireNavigation(ticket, "request-failed", { broadcast: false });
  }

  return Object.freeze({
    begin, fail, openSearch, selectBookmark, openBookmark, identityChanged, committed, closeTab,
    assertCurrent: handle => { ticketFor(handle); },
    prepare: (handle, tab, identity) => prepareNavigation(ticketFor(handle), tab, identity),
    openLibrary: navigateLibrary,
    cancel: cancelNavigation,
    observeRoute: observeNavigationRoute,
    acceptResult: acceptNavigationResult,
    resume: tabId => resumeLocationNavigation(navigationIntents.get(tabId)),
  });
}
