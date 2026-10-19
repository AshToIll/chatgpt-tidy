(function initTidyChatgptTitleSync(global) {
  "use strict";

  if (global.TidyChatgptTitleSync) return;
  const pageSession = global.TidyPageSession;
  const HISTORY_KEYS = [["conversationHistory"], ["conversationHistory", { hideProjectChats: true }]];
  // Page-lifetime observations cover SPA navigation, but never survive reload
  // or an observed account/workspace switch. This is not a title history store.
  const observations = new Map();
  // One receipt per changed conversation, released with the page/identity.
  // Do not evict the first rows of a batch while native queries are still stale.
  let accountKey = null;
  let observedWorkspace = null;

  function workspace() {
    try { return global.TidyChatgptApi.activeWorkspace(); }
    catch { return null; }
  }

  function revoke() {
    observations.clear();
    accountKey = null;
    observedWorkspace = null;
  }

  function matchesIdentity(identity, owner = accountKey, selectedWorkspace = observedWorkspace) {
    return identity?.phase === "ready"
      && identity.accountKey === JSON.stringify([owner, selectedWorkspace]);
  }

  // Title receipts use the raw user/workspace pair; IdentitySession exposes its
  // opaque compound key. Revoke presentation and delayed QueryClient callbacks
  // together, including a same-workspace user switch and document suspension.
  const unsubscribeIdentity = global.TidyChatgptApi.onLibraryIdentityChanged((identity) => {
    if (!pageSession.check()) return;
    if (identity.phase !== "ready" || (accountKey && !matchesIdentity(identity))) revoke();
  });
  // 官方已保存的新标题接管展示；旧回执和延迟 QueryClient 回调不能再把它改回去。
  const unsubscribeTitle = global.TidyChatgptApi.onTitleChanged(({ conversationId }) => {
    if (pageSession.check()) observations.delete(conversationId);
  });
  // Retiring this page instance only releases TIDY-owned state/listeners. Native
  // queries must not be cancelled or invalidated as part of teardown.
  pageSession.onDispose(() => {
    revoke();
    unsubscribeIdentity();
    unsubscribeTitle();
  });

  function active(conversationId) {
    if (!pageSession.check()) return undefined;
    global.TidyChatgptApi.checkLibraryIdentity();
    if (!pageSession.check()) return undefined;
    if (observedWorkspace !== workspace()) revoke();
    return pageSession.check() ? observations.get(conversationId) : undefined;
  }

  function fiber(element, visit, maxDepth = 160) {
    const key = Object.keys(element || {}).find((name) => name.startsWith("__reactFiber$"));
    let value = element?.[key];
    for (let depth = 0; value && depth < maxDepth; depth++, value = value.return) {
      const found = visit(value.memoizedProps || {});
      if (found) return found;
    }
    return null;
  }

  function sidebarRows() {
    const grouped = new Map();
    for (const link of global.TidyChatgptSidebarDom.candidates()) {
      let href;
      try { href = new URL(link.getAttribute("href"), global.location.origin).href; } catch { continue; }
      const route = savedRoute(href);
      if (!route) continue;
      const conversationId = route.conversationId;
      const row = rowMetadata(link);
      if (!row) continue;
      const ids = [row.id, row.conversation_id, row.conversationId].filter(value => value != null);
      // Match the same native anchor boundary as snapshots/date/favorites,
      // including project + Recents copies without data-sidebar-item. Id-less
      // history props must still belong to this exact anchor and carry native
      // title/metadata; an explicit conflicting ID is never overridden by href.
      const bound = ids.length ? ids.every(id => id === conversationId)
        : typeof row.title === "string" && (row.create_time != null || row.update_time != null);
      if (!bound) continue;
      if (!grouped.has(conversationId)) grouped.set(conversationId, []);
      grouped.get(conversationId).push(link);
    }
    return grouped;
  }

  function savedRoute(href = global.location.href) {
    let url;
    try { url = new URL(href); } catch { return null; }
    const route = global.TidyChatgptRoute.parse(href);
    const saved = global.TidySnapshot.parseConversationPath(url.pathname);
    // 与面板、后台、标题读写共用精确路径边界；名称后缀不参与项目身份。
    return url.origin === "https://chatgpt.com" && saved ? { ...route, ...saved } : null;
  }

  function acceptScope(current, scope) {
    const route = savedRoute();
    if (!route) return null;
    const owner = scope.ownerContext;
    if (owner !== undefined && (!owner || owner.conversationId !== route.conversationId
      || owner.pathname !== route.pathname || owner.projectId !== (route.projectId || null))) return null;
    if (owner === undefined && route.conversationId !== current.conversationId) return null;
    const projectId = scope.targetProjectId === undefined
      ? route.conversationId === current.conversationId ? route.projectId || null : null : scope.targetProjectId;
    if ((projectId !== null && (typeof projectId !== "string" || !/^g-p-[A-Za-z0-9_-]+$/.test(projectId)))
      || (route.conversationId === current.conversationId && projectId !== (route.projectId || null))) return null;
    return { projectId, isCurrent: route.conversationId === current.conversationId };
  }

  function rowMetadata(link) {
    return fiber(link, (props) => props.conversation || props.historyItem, 40);
  }

  function timestamp(value) {
    if (value == null || value === "") return NaN;
    const number = Number(value);
    return Number.isFinite(number) ? Math.abs(number) < 100_000_000_000 ? number * 1000 : number : Date.parse(value);
  }

  function newer(value, than) {
    return Number.isFinite(timestamp(value)) && (!Number.isFinite(timestamp(than)) || timestamp(value) > timestamp(than));
  }

  function superseded(item, current) {
    return item?.title !== current.title && newer(item?.update_time, current.updatedAt);
  }

  function supersededObservation(item, record) {
    if (!record.titleOnly) return superseded(item, record.current);
    // Accepted renames have no post-write timestamp. Compare later native
    // observations only to the native baseline captured at acceptance, never
    // compare directory timestamps with the detail preflight's timestamp.
    return (typeof item?.title === "string" && !record.titles.has(item.title))
      || (record.nativeUpdatedAt && item?.title !== record.current.title && newer(item?.update_time, record.nativeUpdatedAt));
  }

  function titleNodes(element, nodes = []) {
    for (const child of element?.childNodes || []) {
      if (child.nodeType === 3) { nodes.push(child); continue; }
      if (child.nodeType !== 1 || child.matches?.('[data-tidy-owned], button, svg, [aria-hidden="true"]')) continue;
      titleNodes(child, nodes);
    }
    return nodes;
  }

  function titleText(element) {
    return titleNodes(element).map(node => node.textContent).join("").trim();
  }

  function queryClient(rows) {
    const roots = [...rows, global.document.querySelector("div[data-message-id]"), global.document.querySelector("main")];
    for (const root of roots.filter(Boolean)) {
      const client = fiber(root, (props) => {
        const candidate = props.client;
        return candidate && ["getQueryCache", "setQueriesData", "cancelQueries", "invalidateQueries"]
          .every((name) => typeof candidate[name] === "function") ? candidate : null;
      });
      if (client) return client;
    }
    return null;
  }

  function patchHistory(data, record) {
    const current = record.current;
    // QueryClient may retain this updater and invoke it after cancellation has
    // settled. Guard the updater itself, not just the call that supplied it.
    if (active(current.conversationId) !== record) return data;
    // Match the native infinite-query shape. Preserve all pagination and row
    // fields; never create a directory row or reorder conversations ourselves.
    if (!Array.isArray(data?.pages) || data.pages.some((page) => !Array.isArray(page?.items))) return data;
    if (data.pages.some((page) => page.items.some((item) => item?.id === current.conversationId && supersededObservation(item, record)))) {
      observations.delete(current.conversationId);
      return data;
    }
    let changed = false;
    const pages = data.pages.map((page) => {
      let pageChanged = false;
      const items = page.items.map((item) => {
        if (item?.id !== current.conversationId) return item;
        if (record.titleOnly) {
          if (item.title === current.title) return item;
          changed = pageChanged = true;
          return { ...item, title: current.title };
        }
        if (newer(item.update_time, current.updatedAt)) return item;
        if (item.title === current.title && item.update_time === current.updatedAt) return item;
        changed = pageChanged = true;
        return { ...item, title: current.title,
          ...(current.createdAt ? { create_time: current.createdAt } : {}),
          ...(current.updatedAt ? { update_time: current.updatedAt } : {}),
        };
      });
      return pageChanged ? { ...page, items } : page;
    });
    return changed && active(current.conversationId) === record ? { ...data, pages } : data;
  }

  function refresh() {
    if (!pageSession.check()) return;
    global.TidyChatgptApi.checkLibraryIdentity();
    if (!pageSession.check()) return;
    if (observedWorkspace !== workspace()) revoke();
    if (!observations.size) return;
    // A batch can cover the whole sidebar: enumerate native anchors once per
    // refresh, rather than re-scanning the document for every saved receipt.
    const rows = sidebarRows();
    for (const record of observations.values()) refreshRecord(record, rows.get(record.current.conversationId) || []);
  }

  function refreshRecord(record, rows) {
    if (active(record.current.conversationId) !== record) return;
    const route = savedRoute();
    // A move into/out of a project changes the metadata scope. Retire the old
    // observation rather than carrying it across the newly bound native page.
    if (route?.conversationId === record.current.conversationId
      && (route.projectId || null) !== record.projectId) {
      observations.delete(record.current.conversationId);
      return;
    }
    // A third native title is a newer external observation. Relinquish our
    // presentation instead of fighting another tab or the native rename UI.
    if (rows.some((row) => !record.titles.has(titleText(row)))
      || rows.some((row) => supersededObservation(rowMetadata(row), record))) {
      observations.delete(record.current.conversationId);
      return;
    }
    for (const row of rows) {
      if (titleText(row) !== record.current.title) {
        // A native title may be split into highlight spans. Keep the React DOM
        // nodes/handlers, but replace the whole title instead of only its prefix.
        const nodes = titleNodes(row);
        for (const [index, node] of nodes.entries()) {
          if (active(record.current.conversationId) !== record) return;
          node.textContent = index === 0 ? record.current.title : "";
        }
      }
    }
    for (const row of rows) {
      const label = row.getAttribute("aria-label");
      // Preserve native qualifiers such as pinned/unread; change only the
      // known title prefix so screen readers agree with the visible label.
      const prefix = [...record.titles].filter(Boolean).sort((a, b) => b.length - a.length)
        .find((title) => label?.startsWith(title));
      if (prefix && prefix !== record.current.title) {
        if (active(record.current.conversationId) !== record) return;
        row.setAttribute("aria-label", record.current.title + label.slice(prefix.length));
      }
    }
    if (route?.conversationId === record.current.conversationId
      && global.document.title !== record.current.title && record.documentTitles.has(global.document.title)) {
      if (active(record.current.conversationId) !== record) return;
      global.document.title = record.current.title;
    }
  }

  function acceptObservation(current, identity, before, nativeCurrent, scope, titleOnly) {
    if (!pageSession.check()) return false;
    if (!current || typeof current.title !== "string" || !identity?.accountKey || identity.workspaceKey !== workspace()
      || !/^[A-Za-z0-9_-]+$/.test(current.conversationId || "")) return false;
    const pageIdentity = global.TidyChatgptApi.checkLibraryIdentity();
    if (!pageSession.check()) return false;
    // A verified receipt can precede the first session observation. Once any
    // page identity boundary is known, however, a late old receipt cannot
    // recreate a revoked record, even after BFCache restores the same page.
    if (!(pageIdentity.phase === "unavailable" && pageIdentity.epoch === 0)
      && !matchesIdentity(pageIdentity, identity.accountKey, identity.workspaceKey)) return false;
    const target = acceptScope(current, scope);
    if (!target) return false;
    // A batch result belongs to its target, never the currently open owner's
    // title/store. It may update that target's existing sidebar row and cache.
    if (nativeCurrent?.conversationId !== current.conversationId) nativeCurrent = null;
    if (accountKey !== identity.accountKey || observedWorkspace !== workspace()) observations.clear();
    accountKey = identity.accountKey;
    observedWorkspace = workspace();
    const previous = observations.get(current.conversationId);
    // Consecutive edits can finish before native React metadata catches up.
    // Carry only this same target's acknowledged chain, never another owner's
    // titles; external renames still revoke it through the API/native observer.
    const continuing = previous?.current.title === before && previous.projectId === target.projectId;
    const knownTitles = new Set([...(continuing ? previous.titles : []), before, current.title]);
    if (titleOnly && nativeCurrent?.title?.value && !knownTitles.has(nativeCurrent.title.value)) return false;
    const rows = sidebarRows().get(current.conversationId) || [];
    const changed = nativeCurrent?.title?.value !== current.title
      || newer(current.updatedAt, nativeCurrent?.updatedAt?.value)
      || rows.some((row) => titleText(row) !== current.title);
    const record = {
      // A 2xx is title acceptance, not a verified metadata readback. Keep its
      // observation title-only even if an adapter supplied preflight dates.
      current: titleOnly ? { conversationId: current.conversationId, title: current.title } : { ...current },
      titleOnly,
      // A prior verified receipt may already have patched QueryClient while
      // React props remain stale. Its timestamp is ours, not a later external
      // rename. This carries verified/observed dates, never preflight guesses.
      nativeUpdatedAt: titleOnly ? [nativeCurrent?.updatedAt?.value,
        continuing ? previous.titleOnly ? previous.nativeUpdatedAt : previous.current.updatedAt : null,
        ...rows.map(row => rowMetadata(row)?.update_time)]
        .filter(value => Number.isFinite(timestamp(value))).sort((a, b) => timestamp(b) - timestamp(a))[0] ?? null : null,
      projectId: target.projectId,
      titles: new Set([...knownTitles, nativeCurrent?.title?.value,
        ...rows.map(titleText)].filter((value) => typeof value === "string"
          && (!titleOnly || knownTitles.has(value)))),
      documentTitles: new Set([...(continuing ? previous.documentTitles : []), ...(target.isCurrent ? [global.document.title] : []), current.title,
        before, nativeCurrent?.title?.value].filter((value) => typeof value === "string"
          && (!titleOnly || knownTitles.has(value)))),
    };
    if (!pageSession.check()) return false;
    observations.delete(current.conversationId);
    observations.set(current.conversationId, record);
    refreshRecord(record, rows);
    if (!pageSession.check()) return false;
    // ChatGPT's history cache uses the public QueryClient API. Its separate
    // thread-title store has no exposed setter, so a verified, page-scoped text
    // projection also covers that stale label without mutating React state.
    const client = changed ? queryClient(rows) : null;
    if (client) {
      try {
        // These are the native public directory query keys. A project has
        // several paged variants under this prefix; do not invalidate messages
        // or every project merely because one title changed.
        const projectKey = record.projectId ? ["snorlaxConversations", { gizmoId: record.projectId }] : null;
        if (active(current.conversationId) !== record) return false;
        const historyCancelled = client.cancelQueries({ queryKey: ["conversationHistory"] }, { silent: true });
        // A native callback can retire the page synchronously. Do not dispatch
        // the second query operation merely because the first was authorized.
        if (active(current.conversationId) !== record) {
          void Promise.resolve(historyCancelled).catch(() => {});
          return false;
        }
        const cancelled = projectKey ? Promise.all([historyCancelled,
          client.cancelQueries({ queryKey: projectKey }, { silent: true })]) : historyCancelled;
        void Promise.resolve(cancelled).then(() => {
          if (active(current.conversationId) !== record) return;
          for (const queryKey of HISTORY_KEYS) {
            if (active(current.conversationId) !== record) return;
            client.setQueriesData({ queryKey, exact: true }, (data) => patchHistory(data, record));
          }
          if (projectKey && active(current.conversationId) === record) {
            client.setQueriesData({ queryKey: projectKey }, (data) => patchHistory(data, record));
          }
          // Refetch only the directory. Never invalidate the active message
          // tree, change navigation, replay rename, or reload the document.
          if (typeof before === "string" && before !== current.title && active(current.conversationId) === record) {
            const historyRefresh = client.invalidateQueries({ queryKey: ["conversationHistory"], refetchType: "active" });
            if (!projectKey || active(current.conversationId) !== record) return historyRefresh;
            return Promise.all([historyRefresh, client.invalidateQueries({ queryKey: projectKey, refetchType: "active" })]);
          }
        }).catch(() => {});
      } catch { /* Display synchronization must not change a verified save receipt. */ }
    }
    return pageSession.check();
  }

  function accept(current, identity, before = null, nativeCurrent = null, scope = {}) {
    return acceptObservation(current, identity, before, nativeCurrent, scope, false);
  }

  function acceptTitle(current, identity, before, nativeCurrent = null, scope = {}) {
    if (typeof before !== "string" || current?.title === before) return false;
    return acceptObservation(current, identity, before, nativeCurrent, scope, true);
  }

  function project(conversation) {
    if (!pageSession.check()) return conversation;
    const record = active(conversation?.conversationId);
    if (!record
      || conversation.bindingStatus !== "bound") return conversation;
    const route = savedRoute();
    if (route?.conversationId === record.current.conversationId
      && (route.projectId || null) !== record.projectId) {
      observations.delete(record.current.conversationId);
      return conversation;
    }
    const nativeTitle = conversation.title?.value;
    if ((nativeTitle && !record.titles.has(nativeTitle)) || (record.titleOnly
      && supersededObservation({ title: nativeTitle, update_time: conversation.updatedAt?.value }, record))) {
      observations.delete(record.current.conversationId);
      return conversation;
    }
    const sourced = (value) => ({ value, source: record.titleOnly ? "chatgpt-api.title-accepted" : "chatgpt-api.title-readback", status: "available" });
    if (record.titleOnly) return pageSession.check() ? { ...conversation, title: sourced(record.current.title) } : conversation;
    // A subsequent message can advance the update time without changing the
    // title. Keep that newer native timestamp; dates are never guessed.
    const updatedAt = Date.parse(conversation.updatedAt?.value) > Date.parse(record.current.updatedAt)
      ? conversation.updatedAt : record.current.updatedAt ? sourced(record.current.updatedAt) : conversation.updatedAt;
    if (!pageSession.check()) return conversation;
    return { ...conversation, title: sourced(record.current.title), updatedAt,
      createdAt: record.current.createdAt ? sourced(record.current.createdAt) : conversation.createdAt,
    };
  }

  global.TidyChatgptTitleSync = Object.freeze({ accept, acceptTitle, project, refresh });
})(globalThis);
