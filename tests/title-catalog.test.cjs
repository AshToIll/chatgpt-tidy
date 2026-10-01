const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
function load(context, file, name) {
  const source = fs.readFileSync(file, "utf8").replace(/^import[^\n]+\n/gm, "").replace(/^export /gm, "");
  vm.runInContext(`(() => { ${source}; globalThis.${name} = ${name}; })()`, context);
}

function harness({ beforeLoad = async () => {}, beforeSnapshotRead = async () => {}, accountRead, pageRead, rowRead } = {}) {
  const snapshots = new Map(), calls = [], updates = [], rawUpdates = [];
  const timers = new Map(); let timerId = 0, clock = Date.parse("2026-09-10T00:00:00Z");
  const repository = {
    async getRow(account, id) { return rowRead ? rowRead(account, id) : plain(snapshots.get(account)?.rows.find(row => row.conversationId === id) || null); },
    async getSnapshot(account) {
      await beforeSnapshotRead(account);
      return plain(snapshots.get(account) || { rows: [], state: null });
    },
    async putState(account, state) { snapshots.set(account, { ...(snapshots.get(account) || { rows: [] }), state: plain(state) }); },
    async commitPage(account, page, state) {
      const rows = new Map((snapshots.get(account)?.rows || []).map((row) => [row.conversationId, row]));
      for (const row of page.conversations) rows.set(row.conversationId, { ...row,
        createdAt: row.directoryBounds.createdAt, catalogGeneration: state.generation });
      snapshots.set(account, { rows: [...rows.values()], state: plain(state) });
    },
  };
  const document = { hidden: false };
  const context = vm.createContext({ Intl, structuredClone, document });
  vm.runInContext(fs.readFileSync("src/platform/catalog/date-search.js", "utf8"), context);
  load(context, "src/platform/catalog/ui/conversation-catalog-reader.js", "createConversationCatalogReader");
  load(context, "src/features/titles/ui/title-catalog.js", "createTitleCatalog");
  const service = context.createTitleCatalog({ repository, beforeLoad, now: () => clock,
    schedule: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: clock + delay }); return id; },
    cancelSchedule: (id) => timers.delete(id),
    requestAdapter: async (action, payload) => {
      calls.push({ action, payload: plain(payload) });
      if (action === "account") return accountRead ? accountRead() : { schemaVersion: "tidy.date-search.v1", accountKey: "account-one" };
      return pageRead ? pageRead(payload) : { schemaVersion: "tidy.date-search.v1", source: payload.source,
        conversations: payload.source === "ordinary" ? [{ conversationId: "missing-date", title: "No timestamp",
          projectId: null, updatedAt: null, directoryBounds: { createdAt: null, updatedAt: null, sources: ["ordinary"] } }] : [],
        projects: [], nextCursor: null, done: true, coverageReasons: [] };
    },
  });
  return { service, calls, updates, rawUpdates, snapshots, timers,
    setHidden: (value) => { document.hidden = value; },
    async elapse(ms) { clock += ms; for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.callback(); } await flush(); },
    load: (options = {}) => service.load({ ...options, onUpdate: (value) => { rawUpdates.push(value); updates.push(plain(value)); } }) };
}

test("a title change reads just that row, publishes no HTTP and does not change the refresh timer", async () => {
  const reads = [];
  const h = harness({ rowRead: async (account, id) => {
    reads.push([account, id]);
    return { conversationId: id, title: "Native new title", observedAt: Date.now(), titleChangeStartedAt: Date.now() };
  } });
  await h.load(); await flush();
  const calls = plain(h.calls), timers = [...h.timers.keys()], before = h.updates.at(-1);
  await h.service.changed({ accountKey: "other-account", conversationId: "missing-date" });
  assert.equal(reads.length, 0);
  await h.service.changed({ accountKey: "account-one", conversationId: "missing-date" });
  assert.deepEqual(reads, [["account-one", "missing-date"]]);
  const after = h.updates.at(-1);
  assert.equal(after.rows[0].title, "Native new title");
  assert.equal(after.rows[0].createdAt, before.rows[0].createdAt);
  assert.deepEqual(h.calls, calls); assert.deepEqual([...h.timers.keys()], timers);
  await h.service.pause();
});

test("late row reads cannot overwrite newer changes or publish after hide/account replacement", async () => {
  const pending = [];
  const h = harness({ rowRead: (account, id) => new Promise(resolve => pending.push(resolve)) });
  await h.load(); await flush();
  const change = { accountKey: "account-one", conversationId: "missing-date" };
  const older = h.service.changed(change), newer = h.service.changed(change);
  pending[1]({ conversationId: change.conversationId, title: "Newest", observedAt: Date.now() }); await newer;
  pending[0]({ conversationId: change.conversationId, title: "Old", observedAt: Date.now() }); await older;
  assert.equal(h.updates.at(-1).rows[0].title, "Newest");
  const leaving = h.service.changed(change), count = h.updates.length;
  await h.service.pause(); pending[2]({ conversationId: change.conversationId, title: "Late", observedAt: Date.now() }); await leaving;
  assert.equal(h.updates.length, count);
});

test("title catalog reuses directory enumeration, includes undated rows and reports partial coverage truthfully", async () => {
  const h = harness();
  await h.load(); await flush();
  assert.equal(h.updates.at(-1).rows[0].conversationId, "missing-date");
  assert.equal(h.updates.at(-1).rows[0].createdAt, null);
  assert.equal(h.updates.at(-1).partial, true);
  assert.equal(h.updates.at(-1).loading, false);
  assert.equal(h.updates.at(-1).phase, "settled");
  assert.equal(h.updates.at(-1).error, false, "long-term unverified coverage is not a read failure");
  assert.deepEqual(h.calls.map((entry) => entry.action), ["account", "source-page", "source-page", "source-page", "source-page"]);
  await h.service.pause();
});

test("title catalog drains Search before requesting its first account and drops late updates on leave", async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const h = harness({ beforeLoad: () => wait });
  const result = h.load();
  assert.equal(h.calls.length, 0);
  h.service.pause(); release();
  await assert.rejects(result, (error) => error.code === "CANCELLED");
  assert.equal(h.calls.length, 0);
  assert.equal(h.updates.length, 0);
});

test("changing catalog accounts cannot expose or publish another account's retained rows", async () => {
  let account = "account-one";
  const h = harness({ accountRead: async () => ({ schemaVersion: "tidy.date-search.v1", accountKey: account }) });
  await h.load(); await flush(); await h.service.pause();
  account = "account-two";
  const start = h.updates.length;
  await h.load(); await flush();
  assert.ok(h.updates.slice(start).every((value) => value.accountKey === "account-two"));
  await h.service.pause();
});

test("replacement loads discard old draining snapshots while new account validation waits", async () => {
  let releaseFirstPage, releaseSecondPage, releaseAccount;
  const firstPage = new Promise(resolve => { releaseFirstPage = resolve; });
  const secondPage = new Promise(resolve => { releaseSecondPage = resolve; });
  const newAccount = new Promise(resolve => { releaseAccount = resolve; });
  let accountReads = 0, secondPageStarted = false;
  const h = harness({
    accountRead: async () => {
      const call = ++accountReads;
      if (call === 2) await newAccount;
      return { schemaVersion: "tidy.date-search.v1", accountKey: call === 1 ? "account-one" : "account-two" };
    },
    pageRead: async ({ source, cursor, accountKey }) => {
      const ordinaryA = source === "ordinary" && accountKey === "account-one";
      if (ordinaryA) {
        if (cursor) { secondPageStarted = true; await secondPage; }
        else await firstPage;
      }
      return { schemaVersion: "tidy.date-search.v1", source,
        conversations: ordinaryA ? [{ conversationId: cursor ? "private-a2" : "private-a1", title: "Private A title",
          updatedAt: null, directoryBounds: { createdAt: null, updatedAt: null, sources: [source] } }] : [],
        projects: [], nextCursor: ordinaryA && !cursor ? "page-2" : null,
        done: !ordinaryA || Boolean(cursor), coverageReasons: [] };
    },
  });
  await h.load(); await flush();
  releaseFirstPage(); await flush();
  assert.equal(secondPageStarted, true);
  const start = h.updates.length;
  const replacement = h.load();
  try {
    await flush();
    releaseSecondPage(); await flush();
    assert.equal(accountReads, 2, "replacement has drained A and is waiting for B identity");
    assert.deepEqual(h.updates.slice(start), [], "A drain statuses must not publish to the new listener before B validates");
    releaseAccount(); await replacement; await flush();
    assert.ok(h.updates.slice(start).length > 0);
    assert.ok(h.updates.slice(start).every(value => value.accountKey === "account-two" && value.rows.length === 0));
  } finally {
    releaseAccount(); releaseSecondPage();
    await replacement; await h.service.pause();
  }
});

test("title publication reuses enumerator snapshots and does not reread storage for loading or completion", async () => {
  let reads = 0;
  const h = harness({ beforeSnapshotRead: async () => { reads++; } });
  const initial = await h.load(); await flush();
  assert.ok(initial && Array.isArray(initial.rows), "successful load always resolves its initial display result");
  assert.equal(reads, 6, "four source pages + one query + one enumerator start, with zero publication reads");
  assert.ok(h.updates.some(value => value.loading));
  assert.equal(h.updates.at(-1).loading, false); assert.equal(h.updates.at(-1).phase, "settled");
  await h.service.pause(); reads = 0;
  const cached = await h.load(); await flush();
  assert.equal(cached.rows[0].conversationId, "missing-date");
  assert.equal(reads, 1, "warm reentry reads one authenticated snapshot without another full scan");
  reads = 0; await h.elapse(300000);
  assert.equal(reads, 6, "freshness refresh reuses its account and starts without an extra snapshot read");
  await h.service.pause();
});

test("status-only publication preserves row DTO identity, but a newly read snapshot always gets its own projection", async () => {
  const h = harness();
  await h.load(); await flush();
  const previous = h.rawUpdates.at(-2), final = h.rawUpdates.at(-1);
  assert.equal(previous.loading, true); assert.equal(final.loading, false);
  assert.equal(final.rows, previous.rows, "the final state uses the same source snapshot and DTO array");
  assert.equal(final.rows[0], previous.rows[0], "the selection view can retain its per-row memo across a status change");
  const firstRows = h.rawUpdates.filter(value => value.rows.length).slice(0, 2);
  assert.equal(firstRows[0].rows[0].title, firstRows[1].rows[0].title);
  assert.notEqual(firstRows[0].rows, firstRows[1].rows, "an empty directory page still creates a newly observed snapshot");
  assert.notEqual(firstRows[0].rows[0], firstRows[1].rows[0], "no ID/content cache is shared across observations");
  await h.service.pause();
});

test("row DTO projections do not carry over to another entry or account even when titles and IDs match", async () => {
  let account = "account-one";
  const h = harness({ accountRead: async () => ({ schemaVersion: "tidy.date-search.v1", accountKey: account }) });
  await h.load(); await flush();
  const old = h.rawUpdates.at(-1).rows;
  await h.service.pause();
  const sameAccount = await h.load(); await flush();
  assert.equal(sameAccount.rows[0].conversationId, old[0].conversationId);
  assert.notEqual(sameAccount.rows, old); assert.notEqual(sameAccount.rows[0], old[0]);
  await h.service.pause(); account = "account-two";
  const start = h.rawUpdates.length;
  await h.load(); await flush();
  const other = h.rawUpdates.at(-1);
  assert.equal(other.rows[0].conversationId, old[0].conversationId);
  assert.notEqual(other.rows[0], old[0]);
  assert.ok(h.rawUpdates.slice(start).every(value => value.accountKey === "account-two"));
  await h.service.pause();
});

test("a mid-scan storage failure publishes the same account's last known rows with an explicit error", async () => {
  let reads = 0;
  const h = harness({ beforeSnapshotRead: async () => {
    if (++reads === 3) throw Object.assign(new Error("Catalog storage unavailable"), { code: "STORAGE_ERROR" });
  } });
  h.snapshots.set("account-one", { rows: [{ conversationId: "known-a", title: "Last observed A", createdAt: null, updatedAt: null }], state: null });
  await h.load(); await flush();
  const last = h.updates.at(-1);
  assert.equal(reads, 3, "error display never retries the failed full catalog read");
  assert.equal(last.accountKey, "account-one"); assert.equal(last.error, true); assert.equal(last.loading, false);
  assert.equal(last.readErrors[0].code, "STORAGE_ERROR");
  assert.deepEqual(last.rows.map(row => row.conversationId), ["known-a"]);
  assert.equal(h.timers.size, 0); await h.service.pause();
});

test("an account switch followed by a storage failure cannot borrow the prior selection's snapshot", async () => {
  let account = "account-one", readsB = 0;
  const h = harness({
    accountRead: async () => ({ schemaVersion: "tidy.date-search.v1", accountKey: account }),
    beforeSnapshotRead: async key => {
      if (key === "account-two" && ++readsB === 2) throw Object.assign(new Error("B storage unavailable"), { code: "STORAGE_ERROR" });
    },
  });
  await h.load(); await flush(); await h.service.pause();
  assert.equal(h.updates.at(-1).rows.length, 1);
  account = "account-two";
  const start = h.updates.length, initial = await h.load(); await flush();
  assert.equal(initial.accountKey, "account-two"); assert.deepEqual(initial.rows, []);
  assert.equal(h.updates.at(-1).error, true);
  assert.ok(h.updates.slice(start).every(value => value.accountKey === "account-two" && value.rows.length === 0));
  await h.service.pause();
});

test("a failed initial storage read rejects without republishing rows from an earlier same-account entry", async () => {
  let fail = false;
  const h = harness({ beforeSnapshotRead: async () => {
    if (fail) throw Object.assign(new Error("Storage unavailable"), { code: "STORAGE_ERROR" });
  } });
  await h.load(); await flush(); await h.service.pause();
  const start = h.updates.length; fail = true;
  await assert.rejects(h.load(), error => error.code === "STORAGE_ERROR"); await flush();
  assert.deepEqual(h.updates.slice(start), []);
  await h.service.pause();
});

test("catalog source failures are actionable and only an explicit retry resumes a rate-limited source", async () => {
  let attempts = 0;
  const h = harness({ pageRead: async ({ source }) => {
    if (source === "ordinary" && ++attempts === 1) throw Object.assign(new Error("Rate limited"), {
      code: "HTTP", category: "HTTP", status: 429, retryable: true,
    });
    return { schemaVersion: "tidy.date-search.v1", source, conversations: [], projects: [], nextCursor: null, done: true, coverageReasons: [] };
  } });
  await h.load(); await flush(); await h.service.pause();
  assert.equal(h.updates.at(-1).error, true); assert.equal(h.updates.at(-1).pauseReason, "rate-limited");
  assert.equal(h.updates.at(-1).errorOrigin, "current");
  await h.load(); await flush(); await h.service.pause();
  assert.equal(attempts, 1, "visibility reentry never retries the failing source automatically");
  await h.load({ retry: true }); await flush();
  assert.equal(attempts, 2); assert.equal(h.updates.at(-1).error, false);
  await h.service.pause();
});

for (const retryable of [true, false]) test(`account changes during explicit ${retryable ? "resume" : "refresh"} never pair new status with previous account rows`, async () => {
  let accountReads = 0;
  const h = harness({
    accountRead: async () => ({ schemaVersion: "tidy.date-search.v1", accountKey: ++accountReads >= 2 ? "account-two" : "account-one" }),
    pageRead: async ({ source, accountKey }) => {
      if (accountKey === "account-one") throw Object.assign(new Error("Offline"), { code: "NETWORK", category: "NETWORK", retryable });
      return { schemaVersion: "tidy.date-search.v1", source, conversations: [], projects: [], nextCursor: null, done: true, coverageReasons: [] };
    },
  });
  h.snapshots.set("account-one", { rows: [{ conversationId: "private-a", title: "Account A title", createdAt: null, updatedAt: null }], state: null });
  await h.load(); await flush(); await h.service.pause();
  await h.load({ retry: true }); await flush();
  const last = h.updates.at(-1);
  assert.equal(last.accountKey, "account-two"); assert.equal(last.error, false); assert.deepEqual(last.rows, []);
  assert.ok(h.updates.filter(value => value.accountKey === "account-two").every(value => !value.rows.some(row => row.conversationId === "private-a")));
  await h.service.pause();
});

test("completed title catalogs avoid reentry rescans and discover changes when their durable freshness expires", async () => {
  let fresh = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const row = (conversationId, title) => ({ conversationId, title, projectId: null,
    updatedAt: Date.parse("2026-09-09T12:00:00Z"), directoryBounds: { createdAt: Date.parse("2026-09-09T00:00:00Z"), updatedAt: Date.parse("2026-09-09T12:00:00Z"), sources: ["ordinary"] } });
  const h = harness({ pageRead: async ({ source }) => {
    if (fresh && source === "ordinary") await gate;
    return { schemaVersion: "tidy.date-search.v1", source, conversations: source === "ordinary"
      ? fresh ? [row("existing", "2026.09.09｜TIDY 标题夜间跟进"), row("new-chat", "苹果 新会话")]
        : [row("existing", "TIDY 标题夜间跟进")] : [], projects: [], nextCursor: null, done: true, coverageReasons: [] };
  } });
  await h.load(); await flush(); await h.service.pause();
  const oldGeneration = h.snapshots.get("account-one").state.generation;
  fresh = true;
  const cached = await h.load();
  assert.equal(cached.rows[0].title, "TIDY 标题夜间跟进", "load resolves cached rows before the deferred server response");
  await flush();
  assert.equal(h.calls.filter(call => call.action === "source-page").length, 4, "fresh reentry does zero directory GETs");
  await h.elapse(300000);
  release(); await flush();
  const latest = h.updates.at(-1);
  assert.deepEqual(latest.rows.map(row => row.title), ["2026.09.09｜TIDY 标题夜间跟进", "苹果 新会话"]);
  assert.ok(latest.generation > oldGeneration); assert.ok(Number.isFinite(latest.snapshotStartedAt));
  assert.equal(latest.loading, false); assert.equal(h.timers.size, 1);
  await h.service.pause();
});

test("active selection refreshes on one bounded freshness timer, never while previewing or hidden", async () => {
  let selecting = true;
  const h = harness();
  await h.load({ canRefresh: () => selecting }); await flush();
  assert.equal(h.timers.size, 1);
  const count = h.calls.length;
  await h.elapse(299_999); assert.equal(h.calls.length, count);
  await h.elapse(1); assert.ok(h.calls.length > count);
  assert.equal(h.timers.size, 1, "completion schedules one next freshness check");
  selecting = false;
  const beforePreview = h.calls.length;
  await h.elapse(300_000); assert.equal(h.calls.length, beforePreview); assert.equal(h.timers.size, 0);
  selecting = true; await h.load({ canRefresh: () => selecting }); await flush();
  await h.service.pause(); assert.equal(h.timers.size, 0);
  const paused = h.calls.length;
  await h.elapse(600_000); assert.equal(h.calls.length, paused);
});

test("refresh errors stop the freshness timer and ordinary reentry cannot bypass a 429", async () => {
  let broken = false, attempts = 0;
  const h = harness({ pageRead: async ({ source }) => {
    if (source === "ordinary") { attempts++; if (broken) throw Object.assign(new Error("rate limit"), { code: "HTTP", category: "HTTP", status: 429, retryable: true }); }
    return { schemaVersion: "tidy.date-search.v1", source, conversations: [], projects: [], nextCursor: null, done: true, coverageReasons: [] };
  } });
  await h.load(); await flush(); broken = true;
  await h.elapse(300_000); assert.equal(h.updates.at(-1).error, true); assert.equal(h.timers.size, 0);
  await h.service.pause(); await h.load(); await flush();
  const count = attempts; await h.elapse(600_000); assert.equal(attempts, count);
  broken = false; await h.load({ retry: true }); await flush();
  assert.equal(attempts, count + 1); assert.equal(h.updates.at(-1).error, false);
  await h.service.pause();
});

test("background account failures keep their exact HTTP status for actionable selection messages", async () => {
  for (const status of [401, 429]) {
    let failed = false;
    const h = harness({ accountRead: async () => {
      if (failed) throw Object.assign(new Error("Account request rejected"), {
        code: "HTTP", category: "HTTP", status, retryable: true,
      });
      return { schemaVersion: "tidy.date-search.v1", accountKey: "account-one" };
    } });
    await h.load(); await flush(); failed = true;
    await h.elapse(300_000);
    const latest = h.updates.at(-1);
    assert.equal(latest.phase, "paused"); assert.equal(latest.error, true); assert.equal(latest.loading, false);
    assert.equal(latest.readErrors[0].status, status);
    assert.equal(latest.rows.length, 1, "a refresh failure does not discard cached conversations");
    assert.equal(h.timers.size, 0, "account failures do not retry in a timer loop");
    await h.service.pause();
  }
});

test("leaving during the final source page cannot strand a completed catalog in a permanently paused snapshot", async () => {
  let release, first = true;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ pageRead: async ({ source }) => {
    if (first && source === "projects") await gate;
    return { schemaVersion: "tidy.date-search.v1", source, conversations: [], projects: [], nextCursor: null, done: true, coverageReasons: [] };
  } });
  await h.load(); await flush();
  const draining = h.service.pause(); release(); await draining;
  const old = h.snapshots.get("account-one").state;
  assert.equal(old.phase, "paused"); assert.ok(Object.values(old.sources).every(source => source.done));
  first = false;
  await h.load(); await flush();
  assert.equal(h.snapshots.get("account-one").state.generation, old.generation, "a completed paused snapshot is fresh too");
  await h.elapse(300000);
  assert.ok(h.snapshots.get("account-one").state.generation > old.generation);
  assert.equal(h.updates.at(-1).loading, false); assert.equal(h.timers.size, 1);
  await h.service.pause();
});

test("partial scans resume their saved cursor; replacement loads drain one in-flight refresh without duplicate reads", async () => {
  let release, slow = true, pageCalls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ pageRead: async ({ source, cursor }) => {
    const response = { schemaVersion: "tidy.date-search.v1", source, conversations: [], projects: [], nextCursor: null, done: true, coverageReasons: [] };
    if (source === "ordinary") {
      pageCalls++;
      if (!cursor) return { ...response, conversations: [{ conversationId: "first", title: "First", updatedAt: null,
        directoryBounds: { createdAt: null, updatedAt: null, sources: [source] } }], nextCursor: "page-2", done: false };
      if (slow) await gate;
      return { ...response, conversations: [{ conversationId: "second", title: "Second", updatedAt: null,
        directoryBounds: { createdAt: null, updatedAt: null, sources: [source] } }] };
    }
    return response;
  } });
  await h.load(); await flush(); assert.equal(pageCalls, 2);
  const replacement = h.load(); await flush(); assert.equal(pageCalls, 2, "replacement waits for the one in-flight source read");
  slow = false; release(); await replacement; await flush();
  assert.equal(pageCalls, 2, "unfinished source checkpoints resume instead of repeating first pages");
  assert.equal(h.snapshots.get("account-one").state.generation, 1);
  assert.equal(h.updates.at(-1).rows.length, 2);
  h.setHidden(true);
  const count = h.calls.length;
  await h.elapse(300_000); assert.equal(h.calls.length, count, "hidden document cannot trigger a background refresh");
  await h.service.pause();
});

test("a scheduled refresh revalidates its account and never labels prior-account cached rows as the new account", async () => {
  let account = "account-one";
  const h = harness({ accountRead: async () => ({ schemaVersion: "tidy.date-search.v1", accountKey: account }),
    pageRead: async ({ source, accountKey }) => ({ schemaVersion: "tidy.date-search.v1", source,
      conversations: source === "ordinary" ? [{ conversationId: accountKey, title: `Title ${accountKey}`,
        updatedAt: null, directoryBounds: { createdAt: null, updatedAt: null, sources: [source] } }] : [],
      projects: [], nextCursor: null, done: true, coverageReasons: [] }) });
  await h.load(); await flush(); account = "account-two";
  await h.elapse(300_000);
  assert.equal(h.updates.at(-1).accountKey, "account-two");
  assert.deepEqual(h.updates.at(-1).rows.map(row => row.conversationId), ["account-two"]);
  assert.ok(h.updates.filter(value => value.accountKey === "account-two")
    .every(value => value.rows.every(row => row.conversationId !== "account-one")));
  await h.service.pause();
});

test("repeated reentry does not postpone refresh past the original completion and Titles never runs a date query", async () => {
  const h = harness();
  await h.load(); await flush();
  for (let i = 0; i < 4; i++) { await h.elapse(60000); await h.service.pause(); await h.load(); await flush(); }
  assert.equal(h.calls.filter(call => call.action === "source-page").length, 4);
  await h.elapse(60000);
  assert.equal(h.calls.filter(call => call.action === "source-page").length, 8);
  assert.equal(h.updates.at(-1).loading, false);
  const titleSource = fs.readFileSync("src/features/titles/ui/title-catalog.js", "utf8");
  assert.doesNotMatch(titleSource, /queryDate|dateRange|resultPage/);
  await h.service.pause();
});

test("reentry labels a persisted 429 as previous without changing its checkpoint or retrying", async () => {
  let broken = true, requests = 0;
  const h = harness({ pageRead: async ({ source }) => {
    requests++;
    if (broken) throw Object.assign(new Error("Limited"), { code: "HTTP", category: "HTTP", status: 429, retryable: true });
    return { schemaVersion: "tidy.date-search.v1", source, conversations: [], projects: [], nextCursor: null, done: true, coverageReasons: [] };
  } });
  await h.load(); await flush();
  assert.equal(h.updates.at(-1).errorOrigin, "current");
  const checkpoint = JSON.stringify(h.snapshots.get("account-one"));
  await h.service.pause(); await h.load(); await flush();
  assert.equal(requests, 1); assert.equal(h.updates.at(-1).errorOrigin, "previous");
  assert.equal(JSON.stringify(h.snapshots.get("account-one")), checkpoint, "display provenance must not rewrite or clear the saved error");
  await h.service.pause(); await h.load({ retry: true }); await flush();
  assert.equal(requests, 2); assert.equal(h.updates.at(-1).errorOrigin, "current", "only a newly failed explicit retry is a current error");
  broken = false; await h.service.pause(); await h.load({ retry: true }); await flush();
  assert.equal(requests, 6); assert.equal(h.updates.at(-1).errorOrigin, null); assert.equal(h.updates.at(-1).error, false);
  await h.service.pause();
});
