import { createConversationCatalogReader } from "../../../platform/catalog/ui/conversation-catalog-reader.js";

// Full directory refresh is deliberately infrequent while the user stays in
// selection. Typing/filtering never restarts a scan. Reentry rechecks identity,
// reuses fresh completed rows, and resumes partial scans instead of starting over.
export const TITLE_CATALOG_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// Merge protocol details field-by-field. A bridge may provide only its stage;
// that must never hide the original exception's code, HTTP status or name.
function catalogFailure(error, stage = null) {
  const details = error?.details || {};
  return { source: error?.source || details.source || "catalog", code: details.code || error?.code || "UNKNOWN",
    category: details.category || error?.category || "UNKNOWN", name: error?.name || details.name || "Error",
    stage: error?.stage || stage || details.stage || null,
    status: Number.isInteger(details.status) ? details.status : Number.isInteger(error?.status) ? error.status : null,
    retryable: typeof details.retryable === "boolean" ? details.retryable : error?.retryable === true,
    serverCode: details.serverCode || error?.serverCode || null, message: error?.message || details.message || "Catalog failed",
    ...((details.code || error?.code) === "CATALOG_VERSION_UNSUPPORTED" ? {
      expectedCatalogVersion: error?.expectedCatalogVersion ?? details.expectedCatalogVersion,
      observedCatalogVersion: error?.observedCatalogVersion ?? details.observedCatalogVersion,
    } : {}),
  };
}

// Reuse the directory enumerator and account-scoped IndexedDB rows used by
// Search. This is a selection list, not a second metadata cache or a write plan.
export function createTitleCatalog({ repository, requestAdapter, beforeLoad = async () => {},
  now = () => Date.now(), schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
  cancelSchedule = (timer) => globalThis.clearTimeout(timer) }) {
  let generation = 0, active = false, accountKey = null, onUpdate = () => {}, status = null;
  let snapshotOwner = null, rowProjection = null;
  let publication = Promise.resolve(), refreshing = null, refreshTimer = null, selectionIsActive = () => true;
  let loadingEpoch = null;
  const titleChanges = new Map();
  const rowReads = new Map();
  const iso = (value) => Number.isFinite(value) ? new Date(value).toISOString() : null;
  const cancelled = () => Object.assign(new Error("Catalog cancelled"), { code: "CANCELLED" });
  const canDispatch = () => active && globalThis.document?.hidden !== true && selectionIsActive();
  // A final in-flight page is committed even if the panel closes meanwhile.
  // That checkpoint has completedAt + all sources done, but phase is paused;
  // it is refreshable on reentry, not an unfinished cursor to resume forever.
  const completedCheckpoint = () => status?.pauseReason !== "catalog-superseded" && !status?.readErrors?.length && (status?.resultStable
    || (status?.phase === "paused" && Number.isFinite(status.completedAt)
      && !status.coverageReasons?.includes("catalog-pending")));
  const loader = createConversationCatalogReader({ repository, requestAdapter, now,
    canDispatch,
    onStatus(next, snapshot) {
      // Draining an old reader may still commit its final page. That status
      // belongs to the departing selection, never the replacement listener.
      if (!active) return;
      status = next;
      // A newer directory owner can supply complete cached rows, but observing
      // them never grants this superseded run another automatic refresh turn.
      if (next.pauseReason === "catalog-superseded") clearRefreshTimer();
      const account = typeof next.accountKey === "string" && next.accountKey.trim() ? next.accountKey : null;
      if (account !== accountKey) { snapshotOwner = null; rowProjection = null; titleChanges.clear(); rowReads.clear(); }
      accountKey = account;
      // The enumerator has already read this account's whole directory. Reuse
      // that exact observation, not a second full read with potentially newer
      // rows but older status. An error may retain only this epoch/account's
      // last known snapshot; it never borrows another selection's cached rows.
      if (account && snapshot) snapshotOwner = { epoch: generation, account, snapshot };
      publish();
      armRefresh();
    },
  });

  function projectRows(snapshot) {
    const sourceRows = snapshot?.rows;
    if (!sourceRows) return [];
    // Loading/completion can refer to the very same directory observation.
    // Reuse only that array's display DTOs, so status-only updates do not flush
    // the view's row memo. A new snapshot is always projected independently.
    if (rowProjection?.sourceRows !== sourceRows) rowProjection = { sourceRows,
      rows: sourceRows.map((row) => {
        const changed = titleChanges.get(row.conversationId);
        const newerScan = changed && snapshot.state?.snapshotStartedAt > changed.observedAt
          && row.catalogGeneration === snapshot.state?.generation;
        if (newerScan) titleChanges.delete(row.conversationId);
        const current = changed && !newerScan ? { ...row, title: changed.title,
          titleChangeStartedAt: changed.titleChangeStartedAt } : row;
        return { ...current, createdAt: iso(current.createdAt), updatedAt: iso(current.updatedAt) };
      }),
    };
    return rowProjection.rows;
  }

  function publish() {
    const epoch = generation, account = accountKey;
    const owner = snapshotOwner?.epoch === epoch && snapshotOwner.account === account ? snapshotOwner : null;
    const observedStatus = status;
    const loading = observedStatus?.phase === "loading" || refreshing?.epoch === epoch;
    publication = publication.catch(() => {}).then(async () => {
      if (!active || !account || epoch !== generation || account !== accountKey) return null;
      const snapshot = owner?.snapshot;
      const result = { accountKey: account,
        rows: projectRows(snapshot),
        generation: snapshot?.state?.generation ?? null, snapshotStartedAt: snapshot?.state?.snapshotStartedAt ?? null,
        // Completion and coverage are separate. Unsupported/unverified scopes
        // must not look like an interrupted scan in the selection UI.
        phase: observedStatus?.phase || "paused",
        loading, partial: observedStatus?.coverageState !== "complete",
        coverageReasons: observedStatus?.coverageReasons || [],
        error: Boolean(observedStatus?.readErrors?.length),
        readErrors: observedStatus?.readErrors || [], pauseReason: observedStatus?.pauseReason || null,
        errorOrigin: observedStatus?.errorOrigin || null,
      };
      onUpdate(result);
      return result;
    }).catch((error) => {
      throw Object.assign(new Error(error?.message || "Catalog publication failed"), catalogFailure(error, "status-publish"), { cause: error });
    });
    return publication;
  }

  function clearRefreshTimer() {
    if (refreshTimer !== null) cancelSchedule(refreshTimer);
    refreshTimer = null;
  }

  // Returning from a preview must not start another full scan. Freshness is
  // measured from the durable completion, so repeated reentry cannot extend it.
  function refreshDelay() {
    const age = now() - status?.completedAt;
    return !Number.isFinite(age) || age < 0 ? 0 : Math.max(0, TITLE_CATALOG_REFRESH_INTERVAL_MS - age);
  }
  const refreshDue = () => refreshDelay() === 0;

  function armRefresh() {
    // load() owns the first cache/account observation. Do not let a zero-delay
    // expiry timer race it and open a second session before load() can start
    // the same refresh with that already-validated account.
    if (loadingEpoch === generation || refreshTimer !== null || refreshing || !canDispatch() || !completedCheckpoint()) return;
    const epoch = generation;
    refreshTimer = schedule(() => {
      refreshTimer = null;
      if (epoch === generation && canDispatch()) startRefresh(epoch);
    }, refreshDelay());
    refreshTimer?.unref?.();
  }

  function startRefresh(epoch, { retry = false, reuseAccount = false } = {}) {
    if (epoch !== generation || !canDispatch() || (!retry && !completedCheckpoint())) return;
    if (refreshing?.epoch === epoch) return refreshing.promise;
    clearRefreshTimer();
    const owner = { epoch, promise: null };
    refreshing = owner;
    // Directory work is independent of the immediate cache response. Its
    // statuses stream through onUpdate; no search/selection gesture owns I/O.
    owner.promise = (async () => {
      if (retry && !status?.readErrors?.some((error) => !error.retryable)) {
        await loader.resume({ revalidateAccount: !reuseAccount });
      }
      else await loader.refreshCatalog({ revalidateAccount: !reuseAccount, full: false });
      await loader.whenIdle();
    })().catch((error) => {
      if (epoch !== generation || !active) return;
      status = { ...status, phase: "paused", resultStable: false,
        readErrors: [catalogFailure(error)],
        errorOrigin: "current", coverageState: "partial", coverageReasons: ["catalog-interrupted"] };
    }).finally(() => {
      if (refreshing !== owner) return;
      refreshing = null;
      if (epoch === generation && active) { publish(); armRefresh(); }
    });
    publish();
    return owner.promise;
  }

  async function load({ onUpdate: listener = () => {}, retry = false, canRefresh = () => true } = {}) {
    const epoch = ++generation;
    loadingEpoch = epoch;
    active = false; clearRefreshTimer(); accountKey = null; snapshotOwner = null; rowProjection = null;
    titleChanges.clear(); rowReads.clear();
    // Search and Titles share one persisted enumeration checkpoint. Drain the
    // other reader before claiming it; never race two generations into storage.
    try {
      await Promise.all([beforeLoad(), loader.pause()]);
      if (epoch !== generation) throw cancelled();
      refreshing = null;
      accountKey = null; status = null; snapshotOwner = null; rowProjection = null;
      active = true; selectionIsActive = canRefresh; onUpdate = listener;
      const { status: cached } = await loader.read({ sessionId: `titles-${epoch}` });
      if (epoch !== generation || !active) throw cancelled();
      // Read all directory rows, including ones with missing dates. Date filters
      // are for Search only; a missing timestamp must not hide a selectable chat.
      const initial = await publish();
      if (epoch !== generation || !active) throw cancelled();
      loadingEpoch = null;
      // Refresh expired completed snapshots, not every step back from preview.
      // Failed and unfinished scans retain their checkpoint; only an explicit
      // retry can clear failures. Final writes still revalidate live metadata.
      if (retry || (!cached.readErrors?.length && completedCheckpoint() && refreshDue())) {
        startRefresh(epoch, { retry, reuseAccount: true });
      } else armRefresh();
      return initial;
    } catch (error) {
      if (loadingEpoch === epoch) loadingEpoch = null;
      throw error;
    }
  }

  async function changed({ accountKey: account, conversationId } = {}) {
    if (!active || account !== accountKey || typeof conversationId !== "string") return;
    const epoch = generation, ticket = {};
    rowReads.set(conversationId, ticket);
    try {
      const row = await repository.getRow(account, conversationId);
      if (!active || epoch !== generation || account !== accountKey || rowReads.get(conversationId) !== ticket || !row) return;
      titleChanges.set(conversationId, row);
      if (rowProjection) rowProjection = { ...rowProjection,
        rows: rowProjection.rows.map(current => current.conversationId === conversationId
          ? { ...current, title: row.title, titleChangeStartedAt: row.titleChangeStartedAt } : current) };
      // 只更新现有内存快照的一行；不 load、不重开定时器、不发目录 HTTP。
      await publish();
    } finally { if (rowReads.get(conversationId) === ticket) rowReads.delete(conversationId); }
  }
  function pause() { active = false; generation++; loadingEpoch = null; clearRefreshTimer(); rowReads.clear(); return loader.pause(); }
  return Object.freeze({ load, pause, changed });
}
