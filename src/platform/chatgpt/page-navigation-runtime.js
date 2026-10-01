// 页面导航装配与精确目标证明：共用只读证据，不扫描完整快照，不放宽worker凭证。
(function initTidyChatgptPageNavigationRuntime(global) {
  "use strict";
  if (global.TidyChatgptPageNavigationRuntime) return;
  function create({ reader, postEnvelope }) {
    const protocol = global.TidyProtocol;
    const session = global.TidyPageSession;
    const routeAdapter = global.TidyChatgptRoute;
    const bindingAdapter = global.TidyChatgptBinding;
    const messageDom = global.TidyChatgptMessageDom;
    const document = global.document;
    const { findMessageRecord, walkFiber, resolveRouteIdentity, recordId, normalizeRole } = reader;
    function locateMessage(payload) {
      session.assertActive();
      const control = payload?.navigationControl;
      if (typeof control?.ownerAccountKey !== "string" || !control.ownerAccountKey
        || control.navigationIntentId !== payload.navigationIntentId || control.conversationId !== payload.conversationId
        || control.phase !== "active" || pageNavigation?.observe(control)?.accepted !== true) {
        throw Object.assign(new Error("The message command was not admitted by its worker."), { tidyCode: protocol.ErrorCode.CONTEXT_MISMATCH });
      }
      assertNavigationOwner(control.ownerAccountKey);
      assertNavigationCurrent(payload);
      return messageNavigation.start(payload);
    }

    function assertNavigationOwner(accountKey) {
      const identity = global.TidyChatgptApi.checkLibraryIdentity();
      const state = global.TidyNavigationIdentity.state(identity, accountKey);
      if (state === "revoked") {
        throw Object.assign(new Error("The navigation owner changed."), { tidyCode: protocol.ErrorCode.CONTEXT_MISMATCH });
      }
      return state === "ready";
    }

    function usableNavigationElement(element) {
      if (element.isConnected !== true || !element.getClientRects().length) return false;
      for (let node = element; node; node = node.parentElement) {
        const style = global.getComputedStyle(node);
        if (node.hidden || node.getAttribute?.("aria-hidden") === "true" || node.hasAttribute?.("inert")
          || style.display === "none" || /^(hidden|collapse)$/.test(style.visibility)) return false;
      }
      return true;
    }

    // The native placeholder has a different ID from some messages in its turn.
    // Exact read-only Fiber evidence may authorize revealing it, NEVER a receipt.
    function resolveMessageLoadTarget(payload) {
      const route = routeAdapter.parse();
      if (!route.supported || route.conversationId !== payload.conversationId) return null;
      let target = null;
      for (const element of document.querySelectorAll("main [data-turn-id-container]")) {
        if (!usableNavigationElement(element) || element.closest('[data-tidy-owned]')) continue;
        const turnId = element.getAttribute("data-turn-id-container");
        if (!global.TidyChatgptVirtualMessageTarget?.read(element, turnId, payload.conversationId, payload.messageId)) continue;
        if (target) return null; // equally plausible live trees are not a target
        target = element;
      }
      return target ? { element: target } : null;
    }

    // Narrow target proof for bookmarks and latest-message navigation. Re-running the full
    // snapshot here would scan every mounted message on each landing sample.
    function resolveMessageTarget(payload) {
      const route = routeAdapter.parse();
      if (!route.supported || route.conversationId !== payload.conversationId) {
        return { element: null, reason: payload.waitForConversation ? "conversation-loading" : "conversation-mismatch" };
      }
      // Transition/virtualization trees can temporarily retain the same exact
      // message ID twice. Never choose the first hidden old tree just because its
      // Fiber record still matches; equally plausible live targets fail closed.
      const candidates = messageDom.targets(payload.messageId);
      if (!candidates.length) return { element: null, reason: "message-not-present" };
      let target = null;
      for (const element of candidates) {
        if (!usableNavigationElement(element)) continue;
        const record = findMessageRecord(element, payload.messageId);
        const thread = walkFiber(element, (props) => typeof props.conversation?.id === "string" ? props.conversation : null, 40);
        let identity = resolveRouteIdentity(route, thread);
        identity = bindingAdapter.withExactMetadata(identity,
          bindingAdapter.recordConversationId(record) === payload.conversationId);
        if (!bindingAdapter.messageMatchesIdentity(record, identity)
          || recordId(record) !== payload.messageId
          || bindingAdapter.stableMessageId(messageDom.id(element), recordId(record)) !== payload.messageId
          || !["user", "assistant"].includes(normalizeRole(record))) continue;
        if (target) return { element: null, reason: "message-not-bound" };
        target = element;
      }
      return { element: target, contentReady: target ? global.TidyChatgptMessageNavigation.hasRenderedContent(target, document) : false,
        reason: target ? null : "message-not-bound" };
    }

    function resolveLatestConversation(payload) {
      // 原生路由尚在切换时等待；真正离开目标由统一导航凭证撤销，不能滚动旧会话。
      if (routeAdapter.parse().conversationId !== payload.conversationId) return { reason: "conversation-loading" };
      const candidates = messageDom.candidates(document.querySelector("main") || document);
      for (const element of candidates.reverse()) {
        const messageId = messageDom.id(element);
        const resolved = resolveMessageTarget({ ...payload, messageId });
        if (resolved.element === element && resolved.contentReady) return resolved;
      }
      return { reason: "conversation-loading" };
    }

    const pageNavigation = global.TidyChatgptNavigationIntent?.create({
      readIdentity: () => global.TidyChatgptApi.checkLibraryIdentity(),
      parseRoute: () => routeAdapter.parse(),
      onRevoked: ({ navigationIntentId, reason, notify }) => {
        messageLocation?.cancelId(navigationIntentId, reason);
        messageNavigation?.cancelId(navigationIntentId, reason);
        if (notify) postEnvelope(protocol.event(protocol.Type.NAVIGATION_CANCELLED, { navigationIntentId, reason }));
      },
    });
    function assertNavigationCurrent(payload) {
      session.assertActive();
      if (!pageNavigation?.isCurrent(payload?.navigationIntentId)) throw Object.assign(new Error("The navigation was superseded."), {
        tidyCode: protocol.ErrorCode.CONTEXT_MISMATCH,
      });
    }
    const messageLocation = global.TidyChatgptMessageLocation?.create({
      resolveTarget: payload => payload.placement === "latest" ? resolveLatestConversation(payload) : resolveMessageTarget(payload),
      resolveLoadTarget: payload => payload.placement === "latest" ? null : resolveMessageLoadTarget(payload),
      assertCurrent: payload => { assertNavigationCurrent(payload);
        return pageNavigation.canPresent(payload.navigationIntentId); },
      onCancelled: (_payload, reason) => pageNavigation.cancel(reason),
    });
    const messageNavigation = global.TidyChatgptMessageNavigation?.create({
      resolveTarget: resolveMessageTarget,
      resolveLoadTarget: resolveMessageLoadTarget,
      isIntentCurrent: id => session.check() && pageNavigation?.isCurrent(id) === true,
      canPresent: id => session.check() && pageNavigation?.canPresent(id) === true,
      locate: payload => messageLocation.start(payload),
      cancelLocation: (id, reason) => messageLocation.cancelId(id, reason),
      onStatus: (result, target) => {
        if (target && !result.pending && pageNavigation.isCurrent(target.navigationIntentId)) {
          postEnvelope(protocol.event(protocol.Type.NAVIGATION_RESULT, {
            navigationIntentId: target.navigationIntentId, conversationId: target.conversationId,
            messageId: target.messageId, ...result,
          }));
        }
      },
    });
    const libraryNavigation = global.TidyChatgptLibraryNavigation?.create({
      // 无刷新入口与原生左栏的展开、加载范围无关；模块内部探测站点路由器。
      isIntentCurrent: id => session.check() && pageNavigation?.isCurrent(id) === true,
      revealLatest: target => {
        const payload = { ...target, placement: "latest" };
        void messageLocation.start(payload).then(result => {
          if (pageNavigation.isCurrent(target.navigationIntentId)) postEnvelope(protocol.event(protocol.Type.NAVIGATION_RESULT, {
            navigationIntentId: target.navigationIntentId, conversationId: target.conversationId, messageId: null,
            placement: "latest", pending: false, ...result,
          }));
        });
      },
    });


    function navigate(payload) {
      if (!libraryNavigation) throw Object.assign(new Error("The native library navigation adapter is unavailable."), {
        tidyCode: protocol.ErrorCode.ADAPTER_UNAVAILABLE,
      });
      assertNavigationCurrent(payload);
      return libraryNavigation.navigate(payload);
    }
    function hidden() {
      pageNavigation?.cancel("page-hidden"); messageLocation?.cancel("page-hidden"); messageNavigation?.clear("page-hidden");
    }
    function dispose() {
      pageNavigation?.cancel("extension-reloaded"); messageNavigation?.dispose(); messageLocation?.dispose();
    }
    return Object.freeze({ locateMessage, navigate, hidden, dispose,
      observe: payload => pageNavigation?.observe(payload) || { accepted: false },
      observeIdentity: identity => pageNavigation?.observeIdentity(identity),
      routeChanged: () => pageNavigation?.routeChanged() });
  }
  global.TidyChatgptPageNavigationRuntime = Object.freeze({ create });
})(globalThis);
