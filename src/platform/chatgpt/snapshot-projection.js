// 快照装配：原生证据、可选缓存和标题展示投影在这里合成；不拥有缓存或定时器。
(function initTidyChatgptSnapshotProjection(global) {
  "use strict";
  if (global.TidyChatgptSnapshotProjection) return;
  function create({ reader, metadata, titleProjection = null }) {
    const snapshotContract = global.TidySnapshot;
    const routeAdapter = global.TidyChatgptRoute;
    const bindingAdapter = global.TidyChatgptBinding;
    const session = global.TidyPageSession;
    const titleSync = titleProjection;
    const { readAppearance } = global.TidyChatgptNativeAppearance;
    const { findThreadConversation, resolveRouteIdentity, findConversationMeta, findCurrentPageMeta,
      hasCurrentPageIdentityEvidence, currentConversationMeta, readMessages, readConversationFields,
      readSidebarConversations } = reader;
    const { syncScope: syncCurrentMetadataScope, cached: cachedCurrentConversationMeta,
      ensure: ensureCurrentConversationMeta } = metadata;
    function buildSnapshot({ nativeTitles = false, titleOwnerOnly = false } = {}) {
      session.assertActive();
      if (!nativeTitles) titleSync?.refresh();
      const route = routeAdapter.parse();
      syncCurrentMetadataScope(route);
      const threadConversation = findThreadConversation();
      let identity = resolveRouteIdentity(route, threadConversation);
      const sidebarMeta = findConversationMeta(identity);
      const pageMeta = findCurrentPageMeta(identity);
      const cachedMeta = identity.conversationId
        ? cachedCurrentConversationMeta(identity.conversationId)
        : null;
      const currentMessageNumbers = metadata.messageNumbers();
      const pageIdentityBound = hasCurrentPageIdentityEvidence(identity);
      identity = bindingAdapter.withExactMetadata(
        identity,
        Boolean(sidebarMeta || pageMeta || cachedMeta || pageIdentityBound),
      );

      // Mismatch/route-only snapshots expose route identity only. Canonical
      // conversation fields and messages remain empty until binding is proven.
      // In narrow layouts a matching current-page message record is valid exact
      // identity evidence even though the native sidebar row is not mounted.
      const boundMeta = identity.bindingStatus === bindingAdapter.BindingStatus.BOUND
        ? currentConversationMeta(
            identity,
            sidebarMeta,
            pageMeta,
            cachedMeta,
            threadConversation,
          )
        : null;
      const unnumbered = [];
      const activity = { responseInProgress: false };
      const messages = titleOwnerOnly ? [] : readMessages(identity, unnumbered, activity);
      if (
        !titleOwnerOnly && identity.bindingStatus === bindingAdapter.BindingStatus.BOUND &&
        (boundMeta?.value?.create_time == null || boundMeta?.value?.update_time == null || !currentMessageNumbers || unnumbered.length)
      ) {
        ensureCurrentConversationMeta(identity, route, unnumbered);
      }
      // Title ownership needs the exact SAME route/Fiber/metadata binding proof
      // above, not thousands of message excerpts or unrelated sidebar DTOs. Its
      // own authenticated adapter reads dates; do not launch another background
      // metadata fetch just to establish the owner of that imminent request.
      const nativeConversation = readConversationFields(route, identity, boundMeta);
      const conversation = !nativeTitles && titleSync?.project(nativeConversation) || nativeConversation;
      const sidebarConversations = titleOwnerOnly ? []
        : readSidebarConversations().map((item) => !nativeTitles && titleSync?.project(item) || item);
      const isConversationRoute = Boolean(route.conversationId);

      return {
        schemaVersion: snapshotContract.VERSION,
        capturedAt: new Date().toISOString(),
        appearance: readAppearance(),
        route: {
          href: route.href,
          pathname: route.pathname,
          kind: route.kind,
          source: "location",
          status: route.supported ? "available" : "unsupported",
        },
        conversation,
        sidebarConversations,
        messages,
        adapter: {
          responseInProgress: activity.responseInProgress,
          status: !route.supported
            ? "unsupported"
            : !isConversationRoute
              ? "empty"
              : identity.status === "stable" &&
                  identity.bindingStatus === bindingAdapter.BindingStatus.BOUND &&
                  messages.length
                ? "ready"
                : "partial",
          retryable:
            route.supported &&
            isConversationRoute &&
            (identity.bindingStatus !== bindingAdapter.BindingStatus.BOUND ||
              identity.status !== "stable" ||
              !messages.length ||
              !conversation.title.value),
          sources: ["location", "semantic-dom", "react-fiber"],
        },
      };
    }


    return Object.freeze({ read: buildSnapshot });
  }
  global.TidyChatgptSnapshotProjection = Object.freeze({ create });
})(globalThis);
