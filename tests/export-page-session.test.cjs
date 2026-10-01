const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { installPageSession } = require('./helpers/page-session.cjs');

const root = path.resolve(__dirname, '..');
const fileId = 'file_' + 'a'.repeat(32);
const pointer = { content_type: 'image_asset_pointer', asset_pointer: `sediment://${fileId}` };
const payload = (id = 'first') => ({ id, title: 'Lifecycle fixture', current_node: 'u', mapping: {
  u: { id: 'u', parent: null, message: { id: 'user', author: { role: 'user' },
    content: { content_type: 'multimodal_text', parts: ['Body', pointer] } } },
} });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function stopped(error) {
  assert.equal(error.code, 'ADAPTER_UNAVAILABLE');
  assert.equal(error.details.stage, 'page-session');
  assert.equal(error.details.disconnect, 'context-invalidated');
  return true;
}
function harness({ account, fetch } = {}) {
  const calls = [], timers = new Set();
  let accountReads = 0, unsubscriptions = 0, timerId = 0;
  const context = vm.createContext({ URL, AbortController, encodeURIComponent,
    location: { href: 'https://chatgpt.com/c/first', origin: 'https://chatgpt.com' },
    setTimeout() { const id = ++timerId; timers.add(id); return id; },
    clearTimeout(id) { timers.delete(id); },
    TidyChatgptApi: {
      async readLibraryAccount() { accountReads += 1; return account?.(); },
      activeWorkspace() { return ''; },
      checkLibraryIdentity() { return { accountKey: 'fixture', epoch: 1, phase: 'ready' }; },
      onLibraryIdentityChanged() { return () => { unsubscriptions += 1; }; },
      async fetchAuthenticated(url, options) {
        calls.push({ url, options });
        return fetch ? fetch(url, options) : { ok: true, json: async () => payload(url.split('/').pop()) };
      },
    },
  });
  installPageSession(context);
  for (const file of ['src/features/export/model/export.js', 'src/platform/snapshot.js', 'src/platform/chatgpt/route.js', 'src/platform/chatgpt/active-branch.js',
    'src/platform/chatgpt/native-message-references.js', 'src/platform/chatgpt/native-message-content.js', 'src/platform/chatgpt/native-message-process.js',
    'src/platform/chatgpt/conversation-projection.js', 'src/features/export/chatgpt/export.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  return { api: context.TidyChatgptExport, session: context.TidyPageSession, calls, timers,
    counts: () => ({ accountReads, unsubscriptions }) };
}

test('retired export entries fail before account or network work', async () => {
  const h = harness();
  h.session.stop('context-invalidated');
  for (const read of [
    () => h.api.readCurrentConversation({ expectedConversationId: 'first' }),
    () => h.api.readConversations({ conversationIds: ['first'] }),
    () => h.api.readImageResource({ readHandle: 'missing' }),
  ]) await assert.rejects(read(), stopped);
  assert.equal(h.counts().accountReads, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.counts().unsubscriptions, 1);
});

test('account completion after stop cannot start an export request', async () => {
  const gate = deferred(), h = harness({ account: () => gate.promise });
  const pending = h.api.readConversations({ conversationIds: ['first'] });
  h.session.stop('context-invalidated');
  gate.resolve();
  await assert.rejects(pending, stopped);
  assert.equal(h.calls.length, 0);
});

test('late response is not parsed and conversation request observes stop signal', async () => {
  const started = deferred(), gate = deferred();
  let parsed = 0;
  const h = harness({ fetch: () => { started.resolve(); return gate.promise; } });
  const pending = h.api.readCurrentConversation({ expectedConversationId: 'first' });
  await started.promise;
  h.session.stop('context-invalidated');
  assert.equal(h.calls[0].options.signal.aborted, true);
  gate.resolve({ ok: true, json: async () => { parsed += 1; return payload(); } });
  await assert.rejects(pending, stopped);
  assert.equal(parsed, 0);
});

test('stop during batch body parsing prevents the next conversation and late handles', async () => {
  const started = deferred(), gate = deferred();
  const h = harness({ fetch: () => ({ ok: true, json: () => { started.resolve(); return gate.promise; } }) });
  const pending = h.api.readConversations({ conversationIds: ['first', 'second'] });
  await started.promise;
  h.session.stop('context-invalidated');
  gate.resolve(payload());
  await assert.rejects(pending, stopped);
  assert.equal(h.calls.length, 1);
  await assert.rejects(h.api.readImageResource({ readHandle: 'image-1' }), stopped);
  assert.equal(h.calls.length, 1);
});

test('stop aborts a shared image request, clears its timer, and rejects all late readers', async () => {
  const started = deferred(), gate = deferred();
  const h = harness({ fetch: url => url.includes('/files/download/')
    ? (started.resolve(), gate.promise)
    : { ok: true, json: async () => payload() } });
  const doc = await h.api.readCurrentConversation({ expectedConversationId: 'first' });
  const readHandle = doc.conversation.resources[0].readHandle;
  const first = h.api.readImageResource({ readHandle });
  const second = h.api.readImageResource({ readHandle });
  await started.promise;
  assert.equal(h.calls.length, 2, 'both image readers share a single lookup');
  assert.equal(h.timers.size, 1);
  h.session.stop('context-invalidated');
  assert.equal(h.calls[1].options.signal.aborted, true);
  assert.equal(h.timers.size, 0);
  gate.resolve({ ok: true, json: async () => ({ download_url: `https://chatgpt.com/backend-api/estuary/content?id=${fileId}` }) });
  await Promise.all([assert.rejects(first, stopped), assert.rejects(second, stopped)]);
  await assert.rejects(h.api.readImageResource({ readHandle }), stopped);
  assert.equal(h.calls.length, 2, 'a stopped image cannot be retried through its old handle');
});
