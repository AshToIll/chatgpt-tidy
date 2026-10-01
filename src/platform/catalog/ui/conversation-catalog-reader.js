import { createConversationCatalogRepository } from "../storage/conversation-catalog.js";

const contract = globalThis.TidyDateSearch;
const CATALOG_VERSION = 2;
const COVERAGE_BOUNDARIES = ["shared-projects-unverified", "group-chats-unverified"];
const schemaError = (message) => Object.assign(new TypeError(message), {
  code: "SCHEMA", category: "SCHEMA", retryable: false,
});
function requireCheckpointVersion(state) {
  if (state == null || state.catalogVersion === CATALOG_VERSION) return;
  throw Object.assign(new TypeError("Unsupported conversation catalog checkpoint version"), {
    code: "CATALOG_VERSION_UNSUPPORTED", category: "SCHEMA", retryable: false,
    expectedCatalogVersion: CATALOG_VERSION,
    observedCatalogVersion: typeof state.catalogVersion === "number" && Number.isFinite(state.catalogVersion) ? state.catalogVersion : null,
  });
}
function nextCounter(previous, key) {
  if (!previous) return 1;
  const value = previous[key];
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw schemaError("Catalog checkpoint counter cannot be safely incremented");
  }
  return value + 1;
}
const sourceCheckpoint = (source, projectId = null) => ({
  source, projectId, cursor: null, done: false, seenCursors: [], signatures: [], error: null, coverageReasons: [],
  // A completed scan keeps only its first-page IDs. Explicit refresh starts at
  // the head and stops as soon as that prior boundary reappears. If every head
  // item disappeared, pagination continues to exhaustion instead of guessing.
  mode: "full", boundaryIds: [], headIds: [],
});

function newCatalogState(startedAt = null, previous = null) {
  requireCheckpointVersion(previous);
  return {
    catalogVersion: CATALOG_VERSION, generation: nextCounter(previous, "generation"),
    revision: nextCounter(previous, "revision"), pages: 0, phase: "paused", pauseReason: null,
    snapshotStartedAt: startedAt, lastObservedAt: null, completedAt: null,
    sources: Object.fromEntries(["ordinary", "archived", "pins", "projects"]
      .map((source) => [source, sourceCheckpoint(source)])),
    // Historical project heads are optimization hints, not an active source
    // queue. A project must be discovered again before its endpoint is read.
    projectHeadHints: {},
  };
}

function refreshCatalogState(startedAt, previous, { full = true } = {}) {
  const state = newCatalogState(startedAt, previous);
  if (full || !previous) return state;
  const headBoundary = (prior) => prior?.done && !prior.error && Array.isArray(prior.headIds)
    ? [...new Set(prior.headIds)] : [];
  // Keep unconsumed hints if parent discovery failed in the previous refresh.
  // Neither a missing parent page nor its failure proves project deletion.
  state.projectHeadHints = structuredClone(previous.projectHeadHints || {});
  for (const [key, prior] of Object.entries(previous.sources || {})) {
    if (prior.source === "project") {
      const boundary = headBoundary(prior);
      const projectKey = `project:${prior.projectId}`;
      if (boundary.length) state.projectHeadHints[projectKey] = boundary;
      else delete state.projectHeadHints[projectKey];
      continue;
    }
    if (!Object.hasOwn(state.sources, key)) continue;
    const checkpoint = sourceCheckpoint(prior.source, prior.projectId || null);
    // Only a clean completed source has a trustworthy head watermark. Empty
    // and interrupted sources take the full path so new multi-page data cannot
    // be hidden behind a missing boundary. The project parent always enumerates
    // every membership page: stopping at its old head would strand still-live
    // projects farther down the directory after removing the old active queue.
    const boundary = headBoundary(prior);
    if (prior.source !== "projects" && boundary.length) {
      checkpoint.mode = "head";
      checkpoint.boundaryIds = boundary;
    }
    state.sources[key] = checkpoint;
  }
  return state;
}

const pageIds = (page) => [...page.conversations.map((row) => `conversation:${row.conversationId}`),
  ...page.projects.map((row) => `project:${row.projectId}`)];

// One account-scoped enumerator for directory consumers. It never sorts or
// paginates date results; Search and Titles project their own views.
function readError(error, source, stage = null) {
  const details = error?.details || {};
  const code = details.code || error?.code || "UNKNOWN";
  return {
    source, code, category: details.category || error?.category || (code === "STORAGE_ERROR" ? "STORAGE" : "UNKNOWN"),
    name: error?.name || details.name || "Error",
    // Preserve transport recovery evidence in the catalog's flat error DTO.
    // A source-fetch checkpoint must not replace a page-session diagnosis.
    stage: details.stage || error?.stage || stage || null,
    disconnect: details.disconnect || error?.disconnect || null,
    status: Number.isInteger(details.status) ? details.status : Number.isInteger(error?.status) ? error.status : null,
    retryable: typeof details.retryable === "boolean" ? details.retryable
      : typeof error?.retryable === "boolean" ? error.retryable : null,
    serverCode: details.serverCode || error?.serverCode || null,
    ...(code === "CATALOG_VERSION_UNSUPPORTED" ? {
      expectedCatalogVersion: CATALOG_VERSION,
      observedCatalogVersion: Number.isFinite(error?.observedCatalogVersion) ? error.observedCatalogVersion
        : Number.isFinite(details.observedCatalogVersion) ? details.observedCatalogVersion : null,
    } : {}),
    message: error?.message || details.message || "Unable to read conversation directory",
  };
}

// 完成的最后一页可能在暂停后才落库：这是完整目录，不应在缓存刷新时又变回“暂停”。
const completedCheckpoint = (state) => {
  const sources = Object.values(state?.sources || {});
  return sources.length > 0 && ["settled", "paused"].includes(state?.phase)
    && Number.isFinite(state.completedAt) && sources.every(source => source.done && !source.error);
};
const checkpointStamp = ({ key, accountKey, ...state }) => JSON.stringify(state);
const newerCheckpoint = (observed, expected) => observed && expected
  && ((observed.generation ?? 0) > (expected.generation ?? 0)
    || (observed.generation === expected.generation && (observed.revision ?? 0) > (expected.revision ?? 0)));
const supersededError = (expected, observed) => Object.assign(new Error("A newer catalog checkpoint was observed"), {
  name: "CatalogSupersededError", code: "CATALOG_SUPERSEDED", category: "CONCURRENCY", retryable: false,
  expectedGeneration: expected.generation ?? 0, expectedRevision: expected.revision ?? 0,
  observedGeneration: observed.generation ?? 0, observedRevision: observed.revision ?? 0,
});
const atStage = (error, stage) => Object.assign(new Error(error?.message || "Unable to read conversation directory"), {
  ...readError(error, "catalog", stage), cause: error,
  expectedGeneration: error?.expectedGeneration, expectedRevision: error?.expectedRevision,
  observedGeneration: error?.observedGeneration, observedRevision: error?.observedRevision,
});

function statusFor(snapshot, criteria, phase = snapshot.state?.phase || "paused") {
  const state = snapshot.state || newCatalogState();
  const sources = Object.values(state.sources);
  const errors = sources.filter((source) => source.error).map((source) => source.error);
  const missingDates = criteria.dateField ? snapshot.rows.filter((row) => !Number.isFinite(row[criteria.dateField])).length : 0;
  const staleRows = snapshot.rows.filter((row) => row.catalogGeneration !== state.generation).length;
  const reasons = new Set(COVERAGE_BOUNDARIES);
  if (sources.some((source) => !source.done)) reasons.add("catalog-pending");
  if (missingDates) reasons.add(`catalog-${criteria.dateField}-missing`);
  if (staleRows) reasons.add("catalog-snapshot-stale");
  for (const source of sources) for (const reason of source.coverageReasons || []) reasons.add(reason);
  for (const error of errors) reasons.add(`read-error:${error.category}`);
  return {
    phase, sessionId: criteria.sessionId || null, dateField: criteria.dateField, revision: state.revision,
    // Finishing this directory run is not a claim of account-wide coverage.
    // Unsupported scopes remain partial internally but do not keep pagination spinning.
    resultStable: phase === "settled" && sources.every((source) => source.done) && !errors.length,
    coverageState: reasons.size ? "partial" : "complete", coverageReasons: [...reasons], readErrors: errors,
    pauseReason: state.pauseReason,
    snapshotStartedAt: state.snapshotStartedAt, lastObservedAt: state.lastObservedAt, completedAt: state.completedAt,
    progress: { discovered: snapshot.rows.length, pages: state.pages,
      sourcesCompleted: sources.filter((source) => source.done).length, failed: errors.length, missingDates, staleRows },
  };
}

export function createConversationCatalogReader(options) {
  const { requestAdapter, onStatus = () => {}, canDispatch = () => globalThis.document?.hidden !== true,
    now = () => Date.now() } = options;
  const repository = options.repository || createConversationCatalogRepository();
  let accountPromise = null;
  let currentAccount = null;
  let lastCriteria = null;
  let queryEpoch = 0;
  let wanted = null;
  let active = null;
  let tail = Promise.resolve();
  let latestStatus = null;
  let failureNoticeSequence = 0;
  let lastCommittedCheckpoint = null;

  // A notification is a new failure event, not the durable catalog error state.
  // Allocate only at a current owner's publication boundary; ordinary progress
  // and cached errors never recreate it. The detached DTO cannot mutate a page
  // checkpoint, and neither this sequence nor the notice is persisted.
  const failureNotice = (error) => ({ id: ++failureNoticeSequence, error: structuredClone(error) });

  // 只为本 reader 已成功落库的正常进度签收，不用读到的快照替别人背书。
  // 仅保留一份账号绑定的完整检查点；错误/限流/账号停止不能借交接自动恢复。
  async function writeCheckpoint(account, state, page = null) {
    const stamp = !state.pauseReason && Object.values(state.sources).every(source => !source.error)
      ? checkpointStamp(state) : null;
    if (page) await repository.commitPage(account, page, state);
    else await repository.putState(account, state);
    lastCommittedCheckpoint = stamp === null ? null : { account, stamp };
  }
  const isLocalCheckpoint = (account, state) => lastCommittedCheckpoint?.account === account
    && (state.accountKey == null || state.accountKey === account)
    && lastCommittedCheckpoint.stamp === checkpointStamp(state);

  function accountKey() {
    accountPromise ||= Promise.resolve().then(() => requestAdapter("account", {})).then((value) => {
      if (value?.schemaVersion !== contract.VERSION || typeof value.accountKey !== "string" || !value.accountKey.trim()) {
        throw schemaError("Invalid conversation catalog account");
      }
      return value.accountKey;
    }).catch((error) => { accountPromise = null; throw error; });
    return accountPromise;
  }

  function publish(snapshot, criteria, phase, account = currentAccount, errorOrigin = "previous", observation = {}) {
    // A shared catalog consumer must pair progress with the account whose
    // rows produced it, including an explicit retry that revalidates identity.
    try {
      latestStatus = { ...statusFor(snapshot, criteria, phase), accountKey: account, ...observation };
      if (observation.readErrors?.length) {
        latestStatus.coverageState = "partial";
        latestStatus.coverageReasons = [...new Set([...latestStatus.coverageReasons,
          ...observation.readErrors.map((error) => `read-error:${error.category}`)])];
      }
      // Ephemeral observation provenance, never written into the checkpoint.
      // Reopening persisted errors must not claim a new request failed now.
      latestStatus.errorOrigin = latestStatus.readErrors.length ? errorOrigin : null;
      // Optional second argument lets a directory consumer display this exact
      // account/status observation without opening the same full catalog again.
      onStatus(latestStatus, snapshot);
    }
    catch (error) { throw atStage(error, "status-publish"); }
    return latestStatus;
  }

  async function observeSuperseded(account, criteria, expected, stillCurrent, knownSnapshot = null, pendingSourceError = null) {
    // Losing a checkpoint is control flow, not a source failure. Rebase only
    // this still-visible account/session; hide, pause and replacement reads can
    // revoke it on either side of the asynchronous IndexedDB read.
    if (!stillCurrent()) return null;
    let snapshot;
    try { snapshot = knownSnapshot || await repository.getSnapshot(account); }
    catch (error) { throw atStage(error, "checkpoint-rebase"); }
    if (!stillCurrent()) return null;
    const state = snapshot?.state;
    try { requireCheckpointVersion(state); }
    catch (error) { throw atStage(error, "checkpoint-rebase"); }
    if (state?.catalogVersion !== CATALOG_VERSION || !state.sources || Array.isArray(state.sources)
      || (state.accountKey != null && state.accountKey !== account) || !newerCheckpoint(state, expected)) {
      throw atStage(schemaError("A newer same-account catalog checkpoint could not be verified"), "checkpoint-rebase");
    }
    const sources = Object.values(state.sources);
    const completed = !pendingSourceError && completedCheckpoint(state);
    // Another owner's loading flag is not our activity. Do not keep a spinner
    // running without a subscription, invent completion, or clear its errors.
    publish(snapshot, criteria, completed ? "settled" : "paused", account, pendingSourceError ? "current" : "previous", {
      pauseReason: "catalog-superseded",
      // If persisting a just-observed source failure lost the fence, that real
      // failure still exists. In particular, newer cached rows cannot clear an
      // ACCOUNT_MISMATCH gate. Preserve it ephemerally, never in the winner's DB.
      ...(pendingSourceError ? { readErrors: [...sources.filter((source) => source.error).map((source) => source.error),
        pendingSourceError], failureNotice: failureNotice(pendingSourceError) } : {}),
    });
    return snapshot;
  }

  function nextSource(state, failed, allowRetry) {
    return Object.entries(state.sources).find(([key, source]) => !source.done && !failed.has(key)
      && (!source.error || (allowRetry && source.error.retryable)));
  }

  function start(account, criteria, allowRetry = false, expectedCheckpoint = null) {
    if (wanted?.account === account && !wanted.cancelled && !wanted.stopped && !wanted.superseded) {
      wanted.criteria = criteria;
      wanted.epoch = queryEpoch;
      wanted.allowRetry ||= allowRetry;
      return;
    }
    if (wanted) wanted.cancelled = true;
    const owner = { account, criteria, allowRetry, cancelled: false, stopped: false, superseded: false, epoch: queryEpoch };
    wanted = owner;
    const current = () => wanted === owner && !owner.cancelled && owner.epoch === queryEpoch
      && currentAccount === account && lastCriteria?.sessionId === owner.criteria.sessionId && canDispatch();
    // Retain only this run's last successfully read snapshot for an error
    // notification. It is never used to continue a failed storage operation.
    let snapshot = null, state = null, supersedingSnapshot = null, pendingSourceError = null, stage = "cache-read";
    tail = tail.then(async () => {
      if (!current()) return;
      snapshot = await repository.getSnapshot(account);
      if (!current()) return;
      requireCheckpointVersion(snapshot.state);
      const advanced = expectedCheckpoint && snapshot.state && newerCheckpoint(snapshot.state, expectedCheckpoint);
      // 切条件期间旧页仍可正常完成；只接续本地已签收的精确进度，真正外部写入仍让位。
      const localHandoff = advanced && isLocalCheckpoint(account, snapshot.state);
      if (advanced && !localHandoff) {
        state = expectedCheckpoint;
        supersedingSnapshot = snapshot;
        throw supersededError(expectedCheckpoint, snapshot.state);
      }
      state = snapshot.state ? structuredClone(snapshot.state) : newCatalogState(now());
      if ((state.pauseReason === "rate-limited" && !owner.allowRetry) || !nextSource(state, new Set(), owner.allowRetry)) {
        // 前驱恰好读完最后一页时，没有下一次 GET 替新条件发布完成状态。
        if (localHandoff && completedCheckpoint(state)) publish(snapshot, owner.criteria, "settled", account);
        return;
      }
      active = owner;
      const failed = new Set();
      const owns = () => wanted === owner && !owner.cancelled && !owner.stopped && canDispatch();
      const emit = (phase, newFailure = null) => {
        if (current()) {
          publish(snapshot, owner.criteria, phase, account, failed.size ? "current" : "previous",
            newFailure ? { failureNotice: failureNotice(newFailure) } : {});
        }
      };
      state.phase = "loading";
      state.pauseReason = null;
      snapshot = { ...snapshot, state };
      emit("loading");
      while (owns()) {
        const next = nextSource(state, failed, owner.allowRetry);
        if (!next) break;
        const [key, source] = next;
        let newSourceFailure = null;
        try {
          stage = "source-fetch";
          // Directory discovery is intentionally sequential. No per-conversation
          // message read, message index or heuristic range gate belongs here.
          const page = await requestAdapter("source-page", {
            source: source.source, projectId: source.projectId, cursor: source.cursor, accountKey: account,
          });
          if (!contract.validateSourcePage(page) || page.source !== source.source
            || page.done !== (page.nextCursor === null)) throw schemaError("Invalid conversation catalog page");
          const signature = JSON.stringify([page.conversations.map((row) => row.conversationId).sort(),
            page.projects.map((row) => row.projectId).sort()]);
          if (!page.done && (page.nextCursor === source.cursor || source.seenCursors.includes(page.nextCursor)
            || source.signatures.includes(signature))) throw schemaError("Conversation catalog cursor or page repeated");
          const nextState = structuredClone(state);
          const ids = pageIds(page);
          const firstPage = source.seenCursors.length === 0;
          const reachedBoundary = source.mode === "head" && ids.some((id) => source.boundaryIds.includes(id));
          const done = page.done || reachedBoundary;
          nextState.sources[key] = {
            ...source, cursor: done ? null : page.nextCursor, done, error: null,
            headIds: firstPage ? ids : source.headIds,
            seenCursors: [...source.seenCursors, ...(done || page.nextCursor === null ? [] : [page.nextCursor])],
            signatures: [...source.signatures, signature],
            coverageReasons: [...new Set([...source.coverageReasons, ...page.coverageReasons])],
          };
          for (const project of page.projects) {
            const projectKey = `project:${project.projectId}`;
            if (nextState.sources[projectKey]) continue;
            const checkpoint = sourceCheckpoint("project", project.projectId);
            const boundary = nextState.projectHeadHints?.[projectKey];
            if (Array.isArray(boundary) && boundary.length) {
              checkpoint.mode = "head";
              checkpoint.boundaryIds = boundary;
            }
            nextState.sources[projectKey] = checkpoint;
            // The current generation now owns this source. Its next completed
            // checkpoint, rather than an older hint, defines the next refresh.
            if (nextState.projectHeadHints) delete nextState.projectHeadHints[projectKey];
          }
          nextState.pages += 1;
          nextState.revision += 1;
          nextState.lastObservedAt = now();
          stage = "page-commit";
          await writeCheckpoint(account, nextState, page);
          state = nextState;
          stage = "page-readback";
          snapshot = await repository.getSnapshot(account);
          requireCheckpointVersion(snapshot.state);
          if (newerCheckpoint(snapshot.state, state)) {
            supersedingSnapshot = snapshot;
            throw supersededError(state, snapshot.state);
          }
        } catch (error) {
          // Pausing revokes this run, not its already valid cached pages. A
          // document handoff can reject an in-flight GET after that boundary;
          // it must not persist a source failure or block the next run's cursor.
          // Genuine failures observed while current still follow the error path.
          if (!current()) return;
          if (["STORAGE_ERROR", "CATALOG_SUPERSEDED", "CATALOG_VERSION_UNSUPPORTED"].includes(error?.code)) throw error;
          const details = readError(error, key, stage);
          pendingSourceError = details;
          state.sources[key] = { ...source, error: details };
          failed.add(key);
          state.revision += 1;
          if (details.status === 429) { owner.stopped = true; state.pauseReason = "rate-limited"; }
          if (details.code === "ACCOUNT_MISMATCH") {
            owner.stopped = true;
            accountPromise = null;
            state.pauseReason = "account-mismatch";
          }
          stage = "failure-checkpoint";
          await writeCheckpoint(account, state);
          pendingSourceError = null;
          snapshot = { ...snapshot, state };
          newSourceFailure = details;
        }
        emit(owns() ? "loading" : "paused", newSourceFailure);
      }
      state.phase = owns() ? "settled" : "paused";
      if (Object.values(state.sources).every((source) => source.done)) state.completedAt = now();
      stage = "final-checkpoint";
      await writeCheckpoint(account, state);
      snapshot = { ...snapshot, state };
      emit(state.phase);
    }).catch(async (error) => {
      if (error?.code === "CATALOG_SUPERSEDED") {
        owner.superseded = true;
        const epoch = owner.epoch, criteria = owner.criteria;
        const stillCurrent = () => wanted === owner && !owner.cancelled && epoch === queryEpoch
          && currentAccount === account && lastCriteria?.sessionId === criteria.sessionId && canDispatch();
        try {
          await observeSuperseded(account, criteria, state, stillCurrent, supersedingSnapshot, pendingSourceError);
          return;
        } catch (rebaseError) {
          if (!stillCurrent()) return;
          error = rebaseError;
        }
      }
      if (current()) {
        const details = readError(error, "catalog", stage);
        latestStatus = { phase: "paused", sessionId: owner.criteria.sessionId, accountKey: account,
          dateField: owner.criteria.dateField, coverageState: "partial", coverageReasons: ["catalog-interrupted"],
          readErrors: [...(pendingSourceError ? [pendingSourceError] : []), details], errorOrigin: "current",
          failureNotice: failureNotice(details),
          revision: latestStatus?.revision || 0, progress: latestStatus?.progress || {} };
        try { onStatus(latestStatus, snapshot); }
        catch (publishError) { throw atStage(publishError, "status-publish"); }
      }
    }).finally(() => {
      if (active === owner) active = null;
      if (wanted === owner) wanted = null;
    });
  }

  async function read(criteria = {}, { allowRetry = false, revalidateAccount = true } = {}) {
    let stage = "account-read";
    try {
      if (criteria.empty === true) {
        // An empty local day needs no account, catalog snapshot or network read.
        // Invalidate old owners so their eventual completion cannot replace zero.
        pause();
        currentAccount = null;
        if (revalidateAccount) accountPromise = null;
        lastCriteria = { ...criteria, cursor: null, refresh: false };
        const state = newCatalogState();
        state.phase = "settled";
        for (const source of Object.values(state.sources)) source.done = true;
        const snapshot = { state, rows: [] };
        const status = publish(snapshot, criteria, "settled");
        return { snapshot, status, criteria, accountKey: null };
      }
      const refresh = criteria.refresh === true;
      const epoch = refresh ? queryEpoch : ++queryEpoch;
      if (!refresh) {
        lastCriteria = { ...criteria, cursor: null, refresh: false };
        // Account validation is separate from directory enumeration. Field/range
        // changes reuse the catalog, but must not expose a different account.
        accountPromise = null;
      }
      const account = await accountKey();
      // A pause or replacement query can happen while account validation waits.
      // Check before opening storage; obsolete work must not start a catalog read.
      if (epoch !== queryEpoch) throw Object.assign(new Error("Conversation date query was cancelled"), {
        name: "AbortError", code: "CANCELLED", category: "CANCELLED", retryable: false,
      });
      stage = "cache-read";
      const snapshot = await repository.getSnapshot(account);
      requireCheckpointVersion(snapshot.state);
      const current = epoch === queryEpoch;
      if (current && !refresh) {
        if (wanted?.account !== account && wanted) wanted.cancelled = true;
        currentAccount = account;
        if (wanted?.account === account && !wanted.superseded) { wanted.criteria = criteria; wanted.epoch = queryEpoch; }
      }
      const phase = active?.account === account && !active.cancelled && !active.stopped && !active.superseded ? "loading"
        : snapshot.state?.phase === "settled" || completedCheckpoint(snapshot.state) ? "settled" : "paused";
      const status = current ? publish(snapshot, criteria, phase, account) : statusFor(snapshot, criteria, phase);
      // Cache results resolve before the queued catalog run. Refresh only ever
      // reads this snapshot and cannot restart an interrupted directory.
      const unfinished = snapshot.state == null
        || Object.values(snapshot.state.sources).some((source) => !source.done);
      if (!refresh && current && canDispatch() && unfinished) start(account, criteria, allowRetry, snapshot.state);
      // Selection/export carries the account that owns this catalog snapshot.
      // The worker revalidates it before reading selected full conversations.
      return { snapshot, status, criteria, accountKey: account };
    } catch (error) { throw atStage(error, stage); }
  }

  function pause() {
    queryEpoch += 1;
    if (wanted) wanted.cancelled = true;
    wanted = null;
    return tail;
  }

  async function resume(options = {}) {
    if (!lastCriteria || !canDispatch()) return latestStatus;
    // An explicit resume may retry failed sources once; query refresh/field
    // changes alone never retry failures or restart completed catalogs.
    return read({ ...lastCriteria, refresh: false }, {
      allowRetry: true, revalidateAccount: options.revalidateAccount !== false,
    });
  }

  async function refreshCatalog(options = {}) {
    if (!lastCriteria || !canDispatch()) return latestStatus;
    if (lastCriteria.empty === true) {
      await read(lastCriteria);
      return latestStatus;
    }
    const criteria = lastCriteria;
    const drained = pause();
    const epoch = queryEpoch;
    let stage = "account-read", account = null, expected = null;
    const stillCurrent = () => epoch === queryEpoch && lastCriteria === criteria
      && currentAccount === account && canDispatch();
    try {
      await drained;
      if (epoch !== queryEpoch || !canDispatch()) return latestStatus;
      if (options.revalidateAccount !== false) accountPromise = null;
      account = await accountKey();
      if (epoch !== queryEpoch || !canDispatch()) return latestStatus;
      currentAccount = account;
      stage = "cache-read";
      const snapshot = await repository.getSnapshot(account);
      if (!stillCurrent()) return latestStatus;
      requireCheckpointVersion(snapshot.state);
      // Keep cached rows until observed again; unverified scopes are not
      // evidence of deletion. Titles requests a head scan, Search a full scan.
      stage = "refresh-reset";
      expected = refreshCatalogState(now(), snapshot.state, { full: options.full !== false });
      await writeCheckpoint(account, expected);
      if (!stillCurrent()) return latestStatus;
      start(account, criteria, false, expected);
      // The explicit action owns the run, not just its immediate cache read.
      await tail;
      return latestStatus;
    } catch (error) {
      if (error?.code === "CATALOG_SUPERSEDED") {
        try { await observeSuperseded(account, criteria, expected, stillCurrent); }
        catch (rebaseError) {
          if (!stillCurrent()) return latestStatus;
          throw rebaseError;
        }
        return latestStatus;
      }
      throw atStage(error, stage);
    }
  }

  return Object.freeze({ read, pause, resume, refreshCatalog, status: () => latestStatus, whenIdle: () => tail });
}
