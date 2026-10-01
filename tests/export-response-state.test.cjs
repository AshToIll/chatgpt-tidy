const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { installPageSession } = require('./helpers/page-session.cjs');
const root = path.resolve(__dirname, '..');
const PENDING = 'EXPORT_RESPONSE_PENDING';
const flush = () => new Promise(setImmediate);

function payload(id = 'current', tail = {}) {
  const message = (id, role, extra = {}) => ({ id, author: { role }, create_time: 1700000000,
    content: { content_type: 'text', parts: ['Readable ' + id] }, ...extra });
  return { id, title: 'New chat', current_node: 'reply', mapping: {
    root: { id: 'root', parent: null, message: null },
    user: { id: 'user', parent: 'root', message: message('user', 'user') },
    reply: { id: 'reply', parent: 'user', message: message('reply', 'assistant', tail) },
  } };
}
function adapter(payloads) {
  const calls = [];
  const context = vm.createContext({ URL, AbortController, encodeURIComponent,
    location: { href: 'https://chatgpt.com/c/current', origin: 'https://chatgpt.com' },
    TidyChatgptApi: {
      async readLibraryAccount() {}, activeWorkspace: () => '',
      checkLibraryIdentity: () => ({ accountKey: 'owner', epoch: 1, phase: 'ready' }),
      onLibraryIdentityChanged: () => () => {},
      async fetchAuthenticated(url) { calls.push(url); return { ok: true, json: async () => payloads[url.split('/').pop()] }; },
    },
  });
  installPageSession(context);
  for (const file of ['src/platform/protocol.js', 'src/features/export/model/export.js', 'src/platform/snapshot.js',
    'src/platform/chatgpt/route.js', 'src/platform/chatgpt/active-branch.js',
    'src/platform/chatgpt/native-message-references.js', 'src/platform/chatgpt/native-message-content.js',
    'src/platform/chatgpt/native-message-process.js', 'src/platform/chatgpt/conversation-projection.js',
    'src/features/export/chatgpt/export.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  return { api: context.TidyChatgptExport, context, calls };
}
const pending = error => { assert.equal(error.tidyCode, PENDING); return true; };
const readCurrent = h => h.api.readCurrentConversation({ expectedConversationId: 'current' });

for (const role of ['assistant', 'tool']) test('current API rejects explicit in_progress ' + role + ' before publishing a document', async () => {
  const h = adapter({ current: payload('current', { author: { role }, status: 'in_progress', end_turn: false, metadata: { is_complete: false } }) });
  await assert.rejects(readCurrent(h), pending);
  assert.equal(h.calls.length, 1);
});

test('one pending API member rejects the whole batch and does not read later members', async () => {
  const h = adapter({ first: payload('first'), second: payload('second', { status: 'in_progress' }), third: payload('third') });
  await assert.rejects(h.api.readConversations({ conversationIds: ['first', 'second', 'third'] }), pending);
  assert.deepEqual(h.calls, ['/backend-api/conversation/first', '/backend-api/conversation/second']);
});

for (const status of ['finished_successfully', 'finished_partial', 'cancelled', 'error', undefined]) {
  test('settled or unspecified API status remains exportable without inferring end_turn completeness: ' + status, async () => {
    const value = payload('current', { status, end_turn: false, metadata: { is_complete: false } });
    const h = adapter({ current: value });
    assert.equal((await readCurrent(h)).conversation.messages.length, 2);
  });
}

test('a completed generated-image tool at the branch tip is not rejected for end_turn false', async () => {
  const value = payload('current', { author: { role: 'tool', name: 'image_gen' }, status: 'finished_successfully', end_turn: false,
    content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_' + 'a'.repeat(32) }] } });
  const h = adapter({ current: value });
  const result = await readCurrent(h);
  assert.equal(result.conversation.resources.length, 1);
  assert.equal(result.conversation.messages[1].role, 'assistant');
});

test('completed active tip supersedes historical and abandoned in_progress records', async () => {
  const value = payload('current', { status: 'finished_successfully' });
  value.mapping.process = { id: 'process', parent: 'user', message: { id: 'process', author: { role: 'assistant' },
    recipient: 'web.run', status: 'in_progress', end_turn: false, metadata: { is_complete: false }, content: { parts: ['search'] } } };
  value.mapping.reply.parent = 'process';
  value.mapping.abandoned = { id: 'abandoned', parent: 'user', message: { ...value.mapping.reply.message, id: 'abandoned', status: 'in_progress' } };
  const h = adapter({ current: value });
  assert.equal((await readCurrent(h)).conversation.messages.length, 2);
});

test('latest user boundary does not inherit an unfinished status from a previous reply', async () => {
  const value = payload('current', { status: 'in_progress' });
  value.mapping.nextUser = { id: 'nextUser', parent: 'reply', message: { id: 'nextUser', author: { role: 'user' }, content: { parts: ['New turn'] } } };
  value.current_node = 'nextUser';
  assert.equal((await readCurrent(adapter({ current: value }))).conversation.messages.length, 3);
});

test('null/system tail nodes do not hide the current reply in_progress state', async () => {
  const value = payload('current', { status: 'in_progress' });
  value.mapping.system = { id: 'system', parent: 'reply', message: { id: 'system', author: { role: 'system' }, content: { parts: ['hidden'] } } };
  value.mapping.tail = { id: 'tail', parent: 'system', message: null };
  value.current_node = 'tail';
  await assert.rejects(readCurrent(adapter({ current: value })), pending);
});

test('pending API data allocates no image handle before the read is admitted', async () => {
  const value = payload('current', { status: 'in_progress', content: { content_type: 'multimodal_text',
    parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_' + 'a'.repeat(32) }] } });
  const h = adapter({ current: value });
  await assert.rejects(readCurrent(h), pending);
  value.mapping.reply.message.status = 'finished_successfully';
  const document = await readCurrent(h);
  assert.match(document.conversation.resources[0].readHandle, /^image-1-/);
});

test('broken branches are malformed data, not waiting-for-response errors', async () => {
  const value = payload('current', { status: 'in_progress' });
  value.mapping.reply.parent = 'missing';
  await assert.rejects(readCurrent(adapter({ current: value })), error => {
    assert.notEqual(error.tidyCode, PENDING); assert.match(error.message, /incomplete|cyclic/); return true;
  });
});

for (const type of ['export.current-conversation', 'export.conversations']) for (const code of [PENDING, 'UNTRUSTED_STATUS']) {
  test('page router exports only the pending read status as a typed error: ' + type + '/' + code, async () => {
    const h = adapter({ current: payload() }), replies = [];
    vm.runInContext(fs.readFileSync(path.join(root, 'src/app/page/request-router.js'), 'utf8'), h.context);
    const fail = async () => { throw Object.assign(new Error('synthetic failure'), { tidyCode: code }); };
    h.context.router = h.context.TidyPageRequestRouter.create({ postEnvelope: value => replies.push(value),
      exportAdapter: { readCurrentConversation: fail, readConversations: fail } });
    h.context.requestType = type;
    vm.runInContext('router.handleMessage({source:globalThis,origin:location.origin,data:{channel:TidyProtocol.WINDOW_CHANNEL,source:"chatgpt-isolated",envelope:TidyProtocol.request(requestType,{})}})', h.context);
    await flush();
    assert.equal(replies.length, 1);
    assert.equal(replies[0].ok, false);
    assert.equal(replies[0].error.code, code === PENDING ? PENDING : 'EXPORT_UNAVAILABLE');
  });
}

async function worker({ busy = true, identityError = false, conversationId = 'current' } = {}) {
  const { createExportHandler } = await import('../src/app/background/handlers/export.js');
  const protocol = globalThis.TidyProtocol;
  const calls = [];
  const snapshot = { conversation: { conversationId, bindingStatus: 'bound', identityStatus: 'stable', title: { value: 'Current' } },
    adapter: { responseInProgress: busy } };
  const doc = { schemaVersion: globalThis.TidyExportContract.VERSION, conversation: { id: 'current', title: 'Current', createdAt: '', updatedAt: '', resources: [],
    messages: [{ id: 'u', role: 'user', messageNumber: 1, timestamp: null,
      segments: [{ type: 'content', sourceMessageId: 'u', timestamp: null, blocks: [{ type: 'paragraph', text: 'Hello' }] }] }] }, warnings: [] };
  const tab = { id: 31, url: 'https://chatgpt.com/c/current' };
  const handler = createExportHandler({ binding: { getBoundTab: async () => tab },
    pageGateway: { snapshot: async () => ({ snapshot }), send: async (id, request) => { calls.push('read'); return protocol.response(request, doc); } },
    library: { snapshot: async () => ({ snapshot }), assertCurrent: async () => {
      calls.push('identity'); if (identityError) throw Object.assign(new Error('Owner changed'), { tidyCode: 'CONTEXT_MISMATCH' });
    } }, catalog: {}, exportJobs: { get: () => ({ start: async () => { calls.push('start'); return { state: 'generating' }; }, status: async () => ({ state: 'generating' }) }) },
  });
  const run = type => handler.handle({ envelope: protocol.request(type, { expectedTabId: 31, expectedConversationId: 'current' }),
    libraryOwner: { tab, accountKey: 'owner', identity: { documentId: 'document', epoch: 1 } } });
  return { run, calls };
}
for (const type of ['export.current-conversation', 'export.job-start']) {
  test('fresh native busy blocks ' + type + ' before read/job side effects', async () => {
    const h = await worker(); await assert.rejects(h.run(type), pending);
    assert.ok(h.calls.includes('identity')); assert.ok(!h.calls.includes('read')); assert.ok(!h.calls.includes('start'));
  });
  test('owner identity drift takes priority over native busy in ' + type, async () => {
    const h = await worker({ identityError: true });
    await assert.rejects(h.run(type), error => error.tidyCode === 'CONTEXT_MISMATCH');
    assert.ok(!h.calls.includes('read')); assert.ok(!h.calls.includes('start'));
  });
  test('wrong conversation takes priority over native busy in ' + type, async () => {
    const h = await worker({ conversationId: 'other' });
    await assert.rejects(h.run(type), error => error.tidyCode === 'CONTEXT_MISMATCH');
    assert.ok(!h.calls.includes('read')); assert.ok(!h.calls.includes('start'));
  });
  test('false means no observed busy, and does not block normal ' + type, async () => {
    const h = await worker({ busy: false }); await h.run(type);
    assert.ok(h.calls.includes(type === 'export.job-start' ? 'start' : 'read'));
  });
}
test('observing an already-submitted job is not blocked or mutated by later response activity', async () => {
  const h = await worker(); const value = await h.run('export.job-status');
  assert.equal(value.state, 'generating'); assert.deepEqual(h.calls, []);
});

for (const method of ['current', 'batch']) test('background gateway preserves typed pending for ' + method, async () => {
  const { createExportGateway } = await import('../src/app/background/adapters/export-gateway.js');
  const protocol = globalThis.TidyProtocol;
  const gateway = createExportGateway({ pageGateway: { send: async (id, envelope) =>
    protocol.failure(envelope, PENDING, 'Synthetic pending', { stage: 'main-world.export-adapter' }) } });
  await assert.rejects(gateway[method]({ id: 31, url: 'https://chatgpt.com/c/current' },
    method === 'current' ? { expectedConversationId: 'current' } : { conversationIds: ['current'] }), pending);
});
