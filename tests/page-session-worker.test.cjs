const test = require('node:test'), assert = require('node:assert/strict');
const runtime = import('../src/platform/session/background/page-session.js');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function harness() {
  const { createPageSession, pageSessionRequestPolicy } = await runtime;
  const protocol = globalThis.TidyProtocol, calls = [];
  const tab = { id: 31, url: 'https://chatgpt.com/c/current', status: 'complete' };
  let documentId = 'current-document', result = null;
  const chrome = {
    webNavigation: { getFrame: async input => { calls.push({ frame: input }); return {
      documentId, documentLifecycle: 'active', url: tab.url,
    }; } },
    tabs: { get: async id => ({ ...tab, id }), sendMessage: async (tabId, envelope, target) => {
      calls.push({ tabId, type: envelope.type, target });
      if (result instanceof Error) throw result;
      if (typeof result === 'function') return result(envelope);
      return protocol.response(envelope, result || { ready: true });
    } },
  };
  const options = { chrome, isChatgptUrl: value => /^https:\/\/chatgpt\.com\//.test(value) };
  return { session: createPageSession(options), restartWorker: () => createPageSession(options), tab, calls, protocol,
    policy: pageSessionRequestPolicy, setDocument: value => { documentId = value; }, setResult: value => { result = value; } };
}

test('page readiness uses the exact browser document and a live content/MAIN probe, not cached data', async () => {
  const h = await harness();
  assert.deepEqual(await h.session.assert(h.tab), { ready: true, documentId: 'current-document' });
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls[1], { tabId: 31, type: 'page-session.probe', target: { documentId: 'current-document' } });
  h.setResult(Error('Could not establish connection. Receiving end does not exist.'));
  await assert.rejects(h.session.assert(h.tab), error => error.tidyCode === 'ADAPTER_UNAVAILABLE'
    && error.details.stage === 'service-worker.page-session' && error.details.disconnect === 'receiver-missing'
    && error.details.documentId === 'current-document' && error.details.phase === 'refresh-required');
});

test('first install on a pre-existing completed page requires refresh; loading document remains connecting', async () => {
  const h = await harness(); h.setResult(Error('Could not establish connection. Receiving end does not exist.'));
  await assert.rejects(h.session.assert(h.tab), error => error.details.phase === 'refresh-required');
  h.tab.status = 'loading';
  await assert.rejects(h.session.assert(h.tab), error => error.details.phase === 'connecting' && !error.details.disconnect);
  h.setResult(null);
  assert.equal((await h.session.assert(h.tab)).ready, true, 'A ready script does not wait for unrelated page HTTP to finish');
});

test('a retired content runtime is refresh-required even if a stale receiver returns a response', async () => {
  const h = await harness();
  h.setResult(envelope => h.protocol.failure(envelope, 'ADAPTER_UNAVAILABLE', 'Retired', {
    stage: 'page-session', disconnect: 'context-invalidated',
  }));
  await assert.rejects(h.session.assert(h.tab), error => error.details.phase === 'refresh-required'
    && error.details.disconnect === 'context-invalidated');
});

test('an old completed Tab snapshot cannot mark the new loading document as refresh-required', async () => {
  const h = await harness(), oldTab = { ...h.tab };
  h.setDocument('fresh-loading-document'); h.tab.status = 'loading';
  h.setResult(Error('Could not establish connection. Receiving end does not exist.'));
  await assert.rejects(h.session.assert(oldTab), error => error.details.phase === 'connecting' && !error.details.disconnect);
  h.setResult(null);
  assert.equal((await h.session.assert(h.tab)).documentId, 'fresh-loading-document');
});

test('a document switch while a missing-receiver response is in flight remains connecting, not sticky refresh-required', async () => {
  const h = await harness(), entered = deferred(), held = deferred();
  h.setResult(async () => { entered.resolve(); await held.promise; throw Error('Could not establish connection. Receiving end does not exist.'); });
  const pending = h.session.assert(h.tab); await entered.promise;
  h.setDocument('replacement-document'); held.resolve();
  await assert.rejects(pending, error => error.details.phase === 'connecting' && !error.details.disconnect);
});

test('Worker sleep, closed transport, HTTP-like failure and invalid responses never manufacture a permanent reload requirement', async () => {
  const h = await harness();
  for (const failure of [Error('The message port closed before a response was received.'), Error('Failed to fetch'),
    envelope => h.protocol.failure(envelope, 'LIBRARY_ACCOUNT_UNAVAILABLE', 'Auth failed', { status: 401 }),
    () => ({ ok: true, payload: { ready: true } }), () => null, { ready: false }]) {
    h.setResult(failure);
    await assert.rejects(h.session.assert(h.tab), error => error.details.phase === 'connecting' && !error.details.disconnect);
  }
  h.setResult(null);
  assert.equal((await h.restartWorker().assert(h.tab)).ready, true);
});

test('a stale request sender cannot borrow a new document readiness capability', async () => {
  const h = await harness();
  await assert.rejects(h.session.assert(h.tab, { expectedDocumentId: 'old-document' }), error => error.tidyCode === 'CONTEXT_MISMATCH');
  assert.equal(h.calls.filter(call => call.type).length, 0);
});

test('navigation during the probe cannot admit a reply from the previous document', async () => {
  const h = await harness(), held = deferred(), entered = deferred();
  h.setResult(async envelope => { entered.resolve(); await held.promise; return h.protocol.response(envelope, { ready: true }); });
  const pending = h.session.assert(h.tab); await entered.promise;
  h.setDocument('replacement-document'); held.resolve();
  await assert.rejects(pending, error => error.details.phase === 'connecting');
  h.setResult(null);
  assert.equal((await h.session.assert(h.tab)).documentId, 'replacement-document');
});

test('business policy is explicit across every module and does not inherit authority from a protocol prefix', async () => {
  const h = await harness(), T = h.protocol.Type;
  for (const type of [T.TITLE_APPLY, T.TITLE_REPLAN, T.TITLE_RULES_UPDATE, T.SEARCH_MESSAGES, T.SEARCH_OPEN_RESULT,
    T.DATE_INDEX_SOURCE_PAGE, T.LIBRARY_GET, T.FAVORITES_TOGGLE_SIDEBAR, T.BOOKMARKS_TOGGLE_CURRENT,
    T.BOOKMARKS_OPEN_CONVERSATION_VIEW, T.LIBRARY_BACKUP_RESTORE, T.EXPORT_CURRENT_CONVERSATION,
    T.EXPORT_JOB_START, T.PREFERENCES_UPDATE]) assert.equal(h.policy(type), 'business', type);
  for (const type of [T.PREFERENCES_GET, T.TITLE_RULES_GET, T.NAVIGATION_CANCELLED, T.EXPORT_PREVIEW_CLOSE,
    T.EXPORT_JOB_CANCEL, T.EXPORT_JOB_DISMISS]) assert.equal(h.policy(type), 'control', type);
  assert.equal(h.policy(T.PAGE_SESSION_PROBE), 'probe');
  for (const type of ['favorites.future', 'settings.unknown', T.SNAPSHOT_UPDATED, T.TITLE_WRITE_CURRENT, undefined]) {
    assert.equal(h.policy(type), null, String(type));
  }
});
