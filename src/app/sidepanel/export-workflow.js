/**
 * 跨栏导出工作流只决定去向。选择/草稿属于 selection owner，界面不充当资料库。
 * navigate 是唯一栏目切换出口；公开方法不接整个 panel state 或 export view。
 */
export function createExportWorkflow({ selection, isReady, readRoute, navigate, prepareDateExport,
  readSearchItems, showSearchToast, ensureSource, setDestination, onChanged = () => {} }) {
  function sourceRoute(source) { return ["favorites", "bookmarks", "search"].includes(source) ? source : null; }
  function begin(source, returnTarget = "batch-main") {
    if (!isReady() || !sourceRoute(source) || !selection.beginSelection(source, returnTarget)) return false;
    if (source === "search") prepareDateExport();
    navigate(source);
    ensureSource(source);
    return true;
  }
  function returnFrom(context) {
    const target = context?.returnTarget;
    setDestination({ mode: "batch", settings: target === "manage" ? "manage" : null });
    navigate(["manage", "batch-main"].includes(target) ? "export" : sourceRoute(context?.source));
  }
  function handle(action, payload = {}) {
    if (!isReady()) return false;
    const source = payload.source;
    if (!sourceRoute(source)) return false;
    if (source === "search" && ["toggle", "select-current", "submit"].includes(action)) {
      if (readRoute() !== "search" || selection.selectionContext()?.source !== "search") return false;
      const items = readSearchItems();
      const selectedAccountKey = selection.selectionState("search").accountKey;
      const currentAccountKey = items[0]?.accountKey;
      if (selectedAccountKey && currentAccountKey && selectedAccountKey !== currentAccountKey) {
        const context = selection.selectionContext();
        selection.cancelSelection(); returnFrom(context); onChanged();
        showSearchToast("searchExportAccountChanged"); return false;
      }
      selection.registerSearchResults(items);
      if (action === "toggle" && !items.some(item => item.conversationId === payload.id)) return false;
      if (action === "select-current") {
        const available = new Set(items.map(item => item.conversationId));
        payload = { ...payload, ids: (payload.ids || []).filter(id => available.has(id)) };
        if (!payload.ids.length) return false;
      }
    }
    if (action === "start") return begin(source, payload.returnTarget || "source");
    if (action === "selection-back") {
      const context = selection.selectionContext();
      selection.cancelSelection(); returnFrom(context || { source }); onChanged(); return true;
    }
    if (action === "toggle" || action === "select-current") {
      const changed = action === "toggle" ? selection.toggleSelection(source, payload.id)
        : selection.selectSelectionRange(source, payload.ids || []);
      if (changed) onChanged();
      return changed;
    }
    if (action === "submit") {
      const result = selection.submitSelection(source);
      if (!result) return false;
      returnFrom(result.context); onChanged(); return result;
    }
    if (action === "view-basket") {
      selection.cancelSelection(); setDestination({ mode: "batch", settings: null }); navigate("export"); onChanged(); return true;
    }
    return false;
  }
  return Object.freeze({ begin, handle, sourceRoute,
    leave(route) {
      const context = selection.selectionContext();
      if (context && route !== sourceRoute(context.source)) selection.cancelSelection();
    },
    back() {
      const context = selection.selectionContext();
      return context && readRoute() === sourceRoute(context.source) ? handle("selection-back", { source: context.source }) : false;
    },
  });
}
