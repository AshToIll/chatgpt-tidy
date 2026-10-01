const { translator } = require('./helpers/export-i18n.cjs');
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");
const flush = () => new Promise(setImmediate);
const field = (value) => ({ value, source: "test", status: "available" });

function languageModel(language) { return { preferences: { language }, translator: translator(language) }; }

function documentFor(id = "same", title = "Original", text = "Original body") {
  return { schemaVersion: "chatgpt-tidy.export-source.v2", warnings: [],
    conversation: { id, title, createdAt: "2026-09-10T00:00:00Z", updatedAt: "2026-09-10T00:01:00Z", resources: [],
      sourceUrl: `https://chatgpt.com/c/${id}`,
      messages: [{ id: `${id}-assistant`, messageNumber: 1, role: "assistant", timestamp: "2026-09-10T00:01:00Z",
        segments: [{ type: "content", sourceMessageId: `${id}-assistant`, timestamp: "2026-09-10T00:01:00Z",
          blocks: [{ type: "paragraph", text }] }] }],
    } };
}

function snapshotFor({ title = "Original", id = "same", messageId = `${id}-assistant`, text = "Original body", responseInProgress = false } = {}) {
  return { route: { pathname: `/c/${id}` },
    adapter: { responseInProgress },
    conversation: { conversationId: id, identityStatus: "stable", bindingStatus: "bound", title: field(title),
      createdAt: field("2026-09-10T00:00:00Z"), updatedAt: field("2026-09-10T00:01:00Z") },
    messages: [{ messageId, idStatus: "stable", presentationStatus: "formal", role: "assistant",
      timestamp: field("2026-09-10T00:01:00Z"), excerpt: field(text) }],
  };
}

function addImage(source, id = 'image', pending = false) {
  source.conversation.resources.push({ id, type: 'image', name: id, mimeType: '', sizeBytes: null, src: '', alt: id,
    ...(pending ? { pending: true, readHandle: `image-1-${id}` } : {}) });
  source.conversation.messages[0].segments.find(s => s.type === 'content').blocks.push({ type: 'image', resourceId: id, alt: id });
  return source;
}

function harness(options = {}) {
  const timers = new Map();
  let nextTimer = 0;
  let now = 0;
  const context = vm.createContext({
    URL, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, structuredClone,
    document: { activeElement: null },
    renderListMarkup: (root, markup) => { root.innerHTML = markup; }, // DOM identity is covered by the native keyboard fixture.
    crypto: { randomUUID: () => "test-preview" },
    requestAnimationFrame: (callback) => queueMicrotask(callback),
    setTimeout: (callback, ms) => { timers.set(++nextTimer, { callback, at: now + ms }); return nextTimer; },
    clearTimeout: (id) => timers.delete(id),
  });
  for (const relative of ["src/messages/build-info.js", "src/messages/notice-registry.js", "src/messages/notice-lifecycle.js", "src/messages/diagnostics.js", "src/features/export/model/export.js", "src/features/export/model/export-preview.js", "src/features/export/engine/i18n.js", "src/features/export/engine/normalize.js", "src/features/export/engine/plan.js", "src/features/export/engine/inline-content.js", "src/features/export/engine/serializers.js"]) {
    vm.runInContext(fs.readFileSync(path.join(projectRoot, relative), "utf8"), context, { filename: relative });
  }
  vm.runInContext(fs.readFileSync(path.join(projectRoot, 'src/features/export/model/export-job.js'), 'utf8'), context);
  const { createExportView } = require('./helpers/export-runtime.cjs').loadExportModule(context, 'src/features/export/ui/export-view.js');
  const { createExportSelection } = require('./helpers/export-runtime.cjs').loadExportModule(context, 'src/features/export/ui/export-selection.js');
  const listeners = {};
  const root = { innerHTML: "", addEventListener(type, listener) { listeners[type] = listener; }, querySelector() { return null; } };
  const reads = [], batchReads = [], downloads = [], submissions = [], dismissed = [], jobActions = [];
  let job = null;
  const api = context.TidyExport;
  api.generateExport = options.generateExport || (async () => ({ bytes: new Uint8Array([1]), outputName: "test.md", warnings: [] }));
  const selection = createExportSelection({ noticeText: (key, values) => model.translator(key, values) });
  const view = createExportView({ root, selection,
    requestResource: options.requestResource || (async () => { throw Error('Unexpected image read'); }),
    // 此处模拟后台；真实 worker/浏览器保存的验证另由 export-jobs 套件负责。
    jobRequest: options.jobRequest || (async (action, payload) => {
      jobActions.push(action);
      if (action === 'status') return job;
      if (action === 'dismiss') return job = { ...job, revision: job.revision + 1, dismissedAt: 1 };
      if (action === 'cancel') return job = { ...job, state: 'cancelled', revision: 3 };
      submissions.push(payload);
      job = { id: payload.id, outputName: payload.spec.plan.outputName, state: 'generating', revision: 1 };
      const { plan, context } = payload.spec;
      try {
        const result = await api.generateExport(plan, { ...context, messages: plan.messages,
          formatTimestamp: value => context.timestamps[value] ?? value });
        downloads.push(result);
        return job = { ...job, revision: 2, state: 'completed', warnings: [...payload.spec.warnings, ...(result.warnings || [])] };
      } catch { return job = { ...job, revision: 2, state: 'failed', errorCode: 'exportJobFailed' }; }
    }),
    requestDocument: (payload) => { reads.push(payload); return options.requestDocument?.(payload, reads.length) || Promise.resolve(documentFor()); },
    requestDocuments: (payload) => { batchReads.push(payload); return options.requestDocuments?.(payload)
      || Promise.resolve({ schemaVersion: context.TidyExportContract.COLLECTION_VERSION, documents: [documentFor()] }); },
    presentFullPreview: options.presentFullPreview || (async () => {}), dismissFullPreview: async p => { dismissed.push(p); }, formatTimestamp: options.formatTimestamp || ((value) => value),
    reloadSources: options.reloadSources, openDownloads: options.openDownloads, onToast: options.onToast,
  });
  let model = { active: false, accountKey: "library-one", snapshot: snapshotFor(), preferences: {}, translator: (key) => key,
    favorites: { accountKey: "library-one", revision: 1, items: { same: { conversationId: "same", title: "Original" } }, groups: [] },
    bookmarks: { accountKey: "library-one", revision: 1, items: {}, groups: [] } };
  function update(patch = {}) { model = { ...model, ...patch }; view.updateContext(model); }
  function advance(ms = 400) {
    const until = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].callback();
    }
    now = until;
  }
  function event(type, selector, properties = {}) {
    const target = { dataset: {}, disabled: false, ...properties, closest: (candidate) => candidate === selector ? target : null,
      matches: candidate => candidate === selector };
    listeners[type]({ target, key: properties.key });
  }
  if (!options.skipInitialUpdate) update(options.model);
  return { view, selection, root, reads, batchReads, downloads, submissions, dismissed, jobActions, update, advance, event, api, model: () => model };
}

test("saved notices expire once, and ordinary rerenders or later status cannot resurrect them", async () => {
  const h = harness(); h.update({ active: true }); await flush();
  h.event('click', '[data-export-action]'); await flush();
  assert.match(h.root.innerHTML, /data-export-job-dismiss/);
  h.advance(3000); h.update(); h.advance(2999);
  assert.match(h.root.innerHTML, /data-export-job tabindex/);
  h.advance(1); await flush();
  assert.doesNotMatch(h.root.innerHTML, /data-export-job tabindex/);
  await h.view.refreshJob(); h.update({ active: false }); h.update({ active: true }); h.advance(12000);
  assert.doesNotMatch(h.root.innerHTML, /data-export-job tabindex/);
  assert.equal(h.jobActions.filter(x => x === 'dismiss').length, 1);
  assert.equal(h.jobActions.filter(x => x === 'cancel').length, 0);
  assert.equal(h.downloads.length, 1);
});

test('body preview appears before image addresses, pending cannot download, and media-off exports without waiting', async () => {
  const source = addImage(documentFor(), 'first', true), requests = [];
  const h = harness({ requestDocument: async () => source,
    requestResource: p => new Promise(resolve => requests.push({ p, resolve })) });
  h.event('click', '[data-export-format]', { dataset: { exportFormat: 'pdf' } });
  setContentToggle(h, 'mediaAttachments', true); h.update({ active: true }); await flush();
  assert.match(h.root.innerHTML, /Original body/);
  assert.match(h.root.innerHTML, /exportImagesPreparing/);
  assert.doesNotMatch(h.root.innerHTML, /exportImageUnavailable/);
  assert.equal(requests.length, 1);
  h.event('click', '[data-export-action]'); await flush(); assert.equal(h.submissions.length, 0);
  h.event('change', '[data-export-toggle]', { dataset: { exportToggle: 'mediaAttachments', exportToggleGroup: 'content' }, checked: false });
  h.event('click', '[data-export-action]'); await flush();
  assert.equal(h.submissions.length, 1); assert.equal(h.api.selectedImageResources(h.submissions[0].spec.plan).length, 0);
  requests[0].resolve({ readHandle: requests[0].p.readHandle,
    resource: { ...source.conversation.resources[0], src: 'https://example.com/image.png', pending: false } });
  await flush(); assert.equal(source.conversation.resources[0].pending, true, 'Off switch rejects the late result');
  assert.equal(h.reads.length, 1); assert.equal(requests.length, 1);
});

test('media off before body arrives performs zero lookups; excluded tool images are not selected', async () => {
  const source = addImage(documentFor(), 'toolimage', true);
  const blocks = source.conversation.messages[0].segments[0].blocks;
  source.conversation.messages[0].segments.push({ type: 'process', category: 'tool', phase: 'result',
    sourceMessageId: 'tool', timestamp: null, label: '', blocks: [blocks.pop()], queries: [], results: [], tool: { name: 'test', callId: '' } });
  let lookups = 0;
  const h = harness({ requestDocument: async () => source, requestResource: async () => { lookups++; throw Error('unused'); } });
  h.event('click', '[data-export-format]', { dataset: { exportFormat: 'pdf' } });
  setContentToggle(h, 'mediaAttachments', true); h.update({ active: true }); await flush(); assert.equal(lookups, 0);
  h.event('change', '[data-export-toggle]', { dataset: { exportToggle: 'mediaAttachments', exportToggleGroup: 'content' }, checked: false });
  h.event('change', '[data-export-toggle]', { dataset: { exportToggle: 'toolProcess', exportToggleGroup: 'content' }, checked: true });
  await flush(); assert.equal(lookups, 0); assert.equal(h.reads.length, 1);
  h.event('change', '[data-export-toggle]', { dataset: { exportToggle: 'mediaAttachments', exportToggleGroup: 'content' }, checked: true });
  await flush(); assert.equal(lookups, 1); assert.match(h.root.innerHTML, /exportImageUnavailable/);
});

test('image completion updates the plan and permits a complete task without re-reading the conversation', async () => {
  const source = addImage(documentFor(), 'ready', true);
  const h = harness({ requestDocument: async () => source, requestResource: async p => ({ readHandle: p.readHandle,
    resource: { ...source.conversation.resources[0], src: 'https://example.com/ready.png', pending: false } }) });
  h.event('click', '[data-export-format]', { dataset: { exportFormat: 'pdf' } });
  setContentToggle(h, 'mediaAttachments', true); h.update({ active: true }); await flush();
  assert.doesNotMatch(h.root.innerHTML, /exportImagesPreparing|exportImageUnavailable/);
  h.event('click', '[data-export-action]'); await flush();
  assert.equal(h.submissions.length, 1);
  assert.equal(h.api.selectedImageResources(h.submissions[0].spec.plan).length, 1); assert.equal(h.reads.length, 1);
});

test('settings page skips invisible preview serialization; PDF avoids a redundant full TXT pass', async () => {
  const h = harness(); h.update({ active: true }); await flush();
  h.api.serializeTextFile = () => { throw Error('unnecessary full text serialization'); };
  h.api.serializeTextExcerpt = () => { throw Error('invisible excerpt serialization'); };
  h.event('click', '[data-export-settings-view]', { dataset: { exportSettingsView: 'shared' } });
  h.event('change', '[data-export-toggle]', { dataset: { exportToggle: 'timestamps', exportToggleGroup: 'content' }, checked: false });
  assert.equal(h.reads.length, 1);
  h.event('click', '[data-export-format]', { dataset: { exportFormat: 'pdf' } });
  h.view.setMode('current'); h.update();
});

test("warning details, hovering and keyboard reading pause expiry; leaving Export pauses unseen results", async () => {
  const h = harness({ generateExport: async () => ({ bytes: new Uint8Array([1]), warnings: ['Check images'] }) });
  h.update({ active: true }); await flush(); h.event('click', '[data-export-action]'); await flush();
  h.advance(6000); assert.match(h.root.innerHTML, /Check images/);
  h.event('toggle', '[data-export-job-warnings]', { open: true }); h.advance(60000); h.update();
  assert.match(h.root.innerHTML, /data-export-job-warnings open/);
  h.event('toggle', '[data-export-job-warnings]', { open: false });
  h.event('pointerover', '[data-export-job]'); h.advance(60000);
  assert.equal(h.jobActions.includes('dismiss'), false);
  h.event('pointerout', '[data-export-job]'); h.event('focusin', '[data-export-job]'); h.advance(60000);
  assert.equal(h.jobActions.includes('dismiss'), false);
  h.event('focusout', '[data-export-job]'); h.update({ active: false }); h.advance(60000);
  assert.equal(h.jobActions.includes('dismiss'), false);
  h.update({ active: true }); h.advance(12000); await flush();
  assert.doesNotMatch(h.root.innerHTML, /data-export-job tabindex/);
});

test("failed results remain readable but can be dismissed without cancelling or resubmitting", async () => {
  const h = harness({ generateExport: async () => { throw Error('generation failed'); } });
  h.update({ active: true }); await flush(); h.event('click', '[data-export-action]'); await flush();
  h.advance(60000); assert.match(h.root.innerHTML, /exportJobFailed/);
  h.event('click', '[data-export-job-dismiss]'); await flush();
  assert.doesNotMatch(h.root.innerHTML, /data-export-job tabindex/);
  assert.equal(h.jobActions.filter(x => x === 'start').length, 1);
  assert.equal(h.jobActions.includes('cancel'), false);
});

test('repeated status failures stop polling and expose read-only recovery, never another export', async () => {
  const calls = []; let healthy = false, opened = 0;
  const h = harness({ jobRequest: async action => {
    calls.push(action); if (!healthy) throw Error('private transport detail'); return null;
  }, openDownloads: async () => { opened++; } });
  h.update({ active: true, ...languageModel('zh-CN') }); await flush();
  for (let i = 0; i < 6; i++) { h.advance(2000); await flush(); }
  assert.equal(calls.length, 3);
  assert.match(h.root.innerHTML, /导出结果待确认/);
  assert.match(h.root.innerHTML, /data-export-job-check/); assert.match(h.root.innerHTML, /data-export-downloads/);
  assert.doesNotMatch(h.root.innerHTML, /private transport detail/);
  h.event('click', '[data-export-downloads]'); await flush(); assert.equal(opened, 1);
  healthy = true; h.event('click', '[data-export-job-check]'); await flush();
  assert.equal(h.view.hasActiveJob(), false); assert.ok(calls.every(action => action === 'status'));
});

test('missing library source retry actually reloads favorites before reading selected chats', async () => {
  let reloads = 0, h, saved;
  h = harness({ reloadSources: async () => { reloads++; h.update({ favorites: saved }); } });
  saved = h.model().favorites;
  h.selection.beginSelection('favorites'); h.selection.selectSelectionRange('favorites', ['same']);
  h.selection.submitSelection('favorites'); h.view.setMode('batch'); h.update({ active: true }); await flush();
  h.update({ favorites: null }); await flush();
  assert.match(h.root.innerHTML, /exportSourcesUnavailable/);
  const before = h.batchReads.length;
  h.event('click', '[data-export-batch-retry]'); await flush(); await flush();
  assert.equal(reloads, 1); assert.ok(h.batchReads.length > before);
  assert.doesNotMatch(h.root.innerHTML, /exportSourcesUnavailable/);
});

test('bookmark read limit explains reducing selection and never offers an ineffective read retry', async () => {
  const h = harness({ model: languageModel('zh-CN') });
  const items = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`b${i}`, {
    bookmarkId: `b${i}`, conversationId: 'same', messageId: `m${i}`, excerpt: 'fixture', groupId: null }]));
  h.update({ bookmarks: { ...h.model().bookmarks, items } });
  h.selection.beginSelection('bookmarks'); h.selection.selectSelectionRange('bookmarks', Object.keys(items));
  h.selection.submitSelection('bookmarks'); h.view.setMode('batch'); h.update({ active: true }); await flush();
  assert.match(h.root.innerHTML, /书签过多，请减少选择/);
  assert.doesNotMatch(h.root.innerHTML, /data-export-batch-retry/); assert.equal(h.batchReads.length, 0);
});

test('a failed full preview names preview, not file generation, and hides private errors', async () => {
  const toasts = [];
  const privateError = Object.assign(Error('secret preview transport'), {
    requestId: 'req-1750000000000-ab12', accountKey: 'private-account', url: 'https://private.example/secret',
    details: { stage: 'private-stage', disconnect: 'private-disconnect', status: 503, retryable: false },
  });
  const h = harness({ presentFullPreview: async () => { throw privateError; },
    onToast: (...args) => toasts.push(args) });
  h.update({ active: true, ...languageModel('zh-CN') }); await flush();
  h.event('click', '[data-export-full-preview]'); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(toasts)), [['exportPreviewFailed', true, {}, {
    reasonCode: 'OBSERVATION_ONLY_UNSPECIFIED', requestId: 'req-1750000000000-ab12', navigationIntentId: null, jobId: null,
    stage: null, disconnect: null, status: 503, retryable: false,
  }]]);
  assert.notEqual(toasts[0][3], privateError);
  assert.equal(Object.isFrozen(toasts[0][3]), true);
  assert.doesNotMatch(JSON.stringify(toasts), /secret preview transport|private-account|private\.example|private-stage|private-disconnect/);
  assert.equal(h.submissions.length, 0);
});

test('retained current-read failures translate after leaving, changing language and returning without another request', async () => {
  const h = harness({ model: languageModel('zh-CN'), requestDocument: async () => { throw Error('private transport detail'); } });
  h.update({ active: true }); await flush();
  assert.ok(h.root.innerHTML.includes(translator('zh-CN')('exportUnavailable')));
  h.update({ active: false });
  h.update(languageModel('en'));
  h.update({ active: true }); await flush();
  assert.ok(h.root.innerHTML.includes(translator('en')('exportUnavailable')));
  assert.ok(!h.root.innerHTML.includes(translator('zh-CN')('exportUnavailable')));
  assert.doesNotMatch(h.root.innerHTML, /private transport detail/);
  assert.equal(h.reads.length, 1);
  h.event('click', '[data-export-retry]'); await flush();
  assert.equal(h.reads.length, 2, 'explicit retry still reads');
});

test('retained batch failures and generated missing titles translate without retrying on presentation changes', async () => {
  const h = harness({ model: languageModel('zh-CN'), requestDocuments: async () => { throw Error('private batch detail'); } });
  h.update({ favorites: { ...h.model().favorites, items: { same: { conversationId: 'same', title: '' } } } });
  h.selection.beginSelection('favorites'); h.selection.selectSelectionRange('favorites', ['same']);
  h.selection.submitSelection('favorites'); h.view.setMode('batch'); h.update({ active: true }); await flush();
  for (const language of ['en', 'ja']) {
    h.update(languageModel(language)); await flush();
    assert.ok(h.root.innerHTML.includes(translator(language)('exportBatchUnavailable')));
    assert.ok(h.root.innerHTML.includes(`<li>${translator(language)('untitled')}</li>`));
    assert.ok(!h.root.innerHTML.includes(translator('zh-CN')('exportBatchUnavailable')));
    assert.doesNotMatch(h.root.innerHTML, /private batch detail/);
    assert.equal(h.batchReads.length, 1);
  }
  h.event('click', '[data-export-batch-retry]'); await flush(); await flush();
  assert.equal(h.batchReads.length, 2);
});

test('source selection notice translates its unit without extending expiry and cannot survive an owner change', async () => {
  const h = harness({ model: languageModel('zh-CN') });
  h.selection.beginSelection('favorites', 'source'); h.selection.selectSelectionRange('favorites', ['same']);
  h.selection.submitSelection('favorites');
  const notice = language => translator(language)('exportAddedCount', { count: 1, unit: translator(language)('conversationItemsUnit') });
  assert.equal(h.selection.selectionState('favorites').notice, notice('zh-CN'));
  h.advance(1200); h.update(languageModel('en'));
  assert.equal(h.selection.selectionState('favorites').notice, notice('en'));
  h.advance(1199); h.update(languageModel('ja'));
  assert.equal(h.selection.selectionState('favorites').notice, notice('ja'));
  h.advance(1);
  assert.equal(h.selection.selectionState('favorites').notice, null);
  h.update(languageModel('zh-CN'));
  assert.equal(h.selection.selectionState('favorites').notice, null, 'expired feedback never reappears');
  h.selection.beginSelection('favorites', 'source'); h.selection.selectSelectionRange('favorites', ['same']);
  h.selection.submitSelection('favorites');
  h.update({ accountKey: 'new-owner' });
  assert.equal(h.selection.selectionState('favorites').notice, null);
});

test('rejected admission remains visible in the current language until a relevant export action changes it', async () => {
  const h = harness({ model: languageModel('zh-CN'), jobRequest: async action => { if (action === 'status') return null; throw Error('not admitted'); } });
  h.update({ active: true }); await flush(); h.event('click', '[data-export-action]'); await flush();
  assert.ok(h.root.innerHTML.includes(translator('zh-CN')('exportJobNotStarted')));
  h.update(languageModel('ja'));
  assert.ok(h.root.innerHTML.includes(translator('ja')('exportJobNotStarted')));
  assert.ok(!h.root.innerHTML.includes(translator('zh-CN')('exportJobNotStarted')));
  h.event('click', '[data-export-format]', { dataset: { exportFormat: 'txt' } });
  assert.ok(!h.root.innerHTML.includes(translator('ja')('exportJobNotStarted')));
});

test("a dismissed saved receipt remains hidden in a newly opened panel; active tasks never expire", async () => {
  let job = { id: 'previous', state: 'completed', revision: 4, dismissedAt: 1, warnings: [] };
  const h = harness({ jobRequest: async () => job }); h.update({ active: true }); await flush();
  assert.doesNotMatch(h.root.innerHTML, /data-export-job tabindex/);
  job = { id: 'next', state: 'generating', revision: 1 };
  await h.view.refreshJob(); h.advance(60000); await flush();
  assert.match(h.root.innerHTML, /exportJobGenerating/);
  assert.doesNotMatch(h.root.innerHTML, /data-export-job-dismiss/);
});

for (const language of ['zh-CN', 'zh-TW', 'en', 'ja']) test(`${language}: export status stays concise without hiding warnings or recovery`, async () => {
  const t = translator(language);
  let job = { id: 'copy-check', state: 'generating', revision: 1, outputName: 'sample.pdf',
    progress: { phase: 'resources', done: 128, total: null } };
  const h = harness({ jobRequest: async () => job });
  h.update({ active: true, ...languageModel(language) }); await flush();
  const card = () => h.root.innerHTML.match(/<section class="export-job"[\s\S]*?<\/section>/)?.[0] || '';
  assert.ok(card().includes(t('exportJobGenerating')));
  assert.match(card(), /export-job__spinner/);
  assert.match(card(), /data-export-job-cancel/);
  assert.match(card(), /sample\.pdf/);
  assert.doesNotMatch(card(), /128|<p>|export-job__detail/, 'no internal resource counts or implementation footnote');
  job = { ...job, revision: 2, progress: { phase: 'files', done: 2, total: 5 } };
  await h.view.refreshJob();
  assert.ok(card().includes(t('exportJobFiles', { done: 2, total: 5 })), 'known file totals remain useful');
  job = { ...job, revision: 3, state: 'failed', errorCode: 'exportJobFailed' };
  await h.view.refreshJob();
  assert.equal(card().split(t('exportJobFailed')).length - 1, 1, 'same failure is not shown twice');
  assert.doesNotMatch(card(), /export-job__spinner|data-export-job-cancel/);
  for (const errorCode of ['exportJobOwnerChanged', 'exportJobInterrupted', 'exportJobSaveFailed', 'exportJobTimeout',
    'exportDependencyFailed', 'exportPdfNoGlyphs', 'exportInvalidDocument', 'private-internal-error']) {
    job = { ...job, revision: job.revision + 1, errorCode };
    await h.view.refreshJob();
    assert.equal(card().split(t('exportJobFailed')).length - 1, 1, 'all failures use one actionable message');
    assert.doesNotMatch(card(), /data-export-downloads|data-export-job-check|data-export-job-cancel/);
    assert.ok(!card().includes(errorCode), 'internal failure reasons stay out of the card');
    assert.equal(h.view.hasActiveJob(), false);
    assert.doesNotMatch(h.root.innerHTML, /data-export-action[^>]*disabled/);
  }
  job = { ...job, revision: job.revision + 1, state: 'cancelling', errorCode: null };
  await h.view.refreshJob();
  assert.ok(card().includes(t('exportJobCancelling')));
  assert.doesNotMatch(card(), /<p>|data-export-downloads/, 'do not ask users to coordinate another save window');
  job = { ...job, revision: job.revision + 1, state: 'completed', warnings: [t('exportImageNoAddress', { name: 'photo.png' })] };
  await h.view.refreshJob();
  assert.ok(card().includes(t('exportJobCompleted')));
  assert.match(card(), /<details[^>]*data-export-job-warnings>/, 'content warnings stay available but closed');
  assert.ok(card().includes(t('exportContentWarnings')));
  assert.match(card(), /photo\.png/);
});

for (const mode of ['current', 'batch']) test(`${mode}: failed save retains the selection and settings, and the main button retries without a second recovery step`, async () => {
  const submissions = []; let job = null;
  const h = harness({ jobRequest: async (action, payload) => {
    if (action === 'status') return job;
    assert.equal(action, 'start'); submissions.push(payload);
    return job = { id: payload.id, revision: 1, state: 'saving', outputName: payload.spec.plan.outputName };
  } });
  h.selection.beginSelection('favorites'); h.selection.toggleSelection('favorites', 'same'); h.selection.submitSelection('favorites');
  h.view.setMode(mode); h.update({ active: true, ...languageModel('zh-CN') }); await flush();
  h.event('click', '[data-export-format]', { dataset: { exportFormat: 'pdf' } });
  h.event('input', '[data-export-filename]', { dataset: { exportFilename: mode === 'current' ? 'current' : 'batch-single' }, value: '保留的文件名' });
  h.event('change', '[data-export-toggle]', { dataset: { exportToggle: 'timestamps', exportToggleGroup: 'content' }, checked: false });
  h.event('click', '[data-export-action]'); await flush();
  assert.equal(submissions.length, 1); assert.equal(h.view.hasActiveJob(), true);
  job = { ...job, revision: 2, state: 'failed', errorCode: 'exportJobInterrupted' };
  await h.view.refreshJob();
  assert.equal(h.view.hasActiveJob(), false); assert.equal(h.selection.basketCount(), 1);
  assert.match(h.root.innerHTML, /导出失败，请重新导出/);
  assert.doesNotMatch(h.root.innerHTML, /正在取消|先查下载|若已弹出保存窗口|data-export-action[^>]*disabled/);
  assert.match(h.root.innerHTML, /data-export-action[^>]*>导出 PDF<\/button>/);
  assert.match(h.root.innerHTML, /value="保留的文件名"/);
  h.advance(10000); await flush(); assert.equal(submissions.length, 1, 'no automatic retry');
  h.event('click', '[data-export-action]'); await flush();
  assert.equal(submissions.length, 2);
  assert.equal(JSON.stringify(submissions[1].spec), JSON.stringify(submissions[0].spec), 'retry keeps the content, format and filename');
});

test("streaming waits for the native completion signal then refreshes automatically", async () => {
  const h = harness({ requestDocument: (_payload, read) => Promise.resolve(documentFor("same", read === 1 ? "Original" : "Fresh", `body-${read}`)) });
  h.update({ active: true });
  await flush();
  assert.equal(h.reads.length, 1);
  assert.match(h.root.innerHTML, /data-export-refresh/);
  for (const text of ["N", "New", "New completed answer"]) {
    h.update({ snapshot: snapshotFor({ messageId: "new-answer", text, responseInProgress: true }) });
    h.advance(5000);
  }
  await flush();
  assert.equal(h.reads.length, 1, "token snapshots do not dispatch backend reads");
  assert.match(h.root.innerHTML, /exportWaitingForResponse/);
  assert.doesNotMatch(h.root.innerHTML, /exportContentChanged/);
  assert.match(h.root.innerHTML, /data-export-action[^>]*disabled/);
  h.update({ active: false });
  h.update({ active: true });
  await flush();
  assert.equal(h.reads.length, 1, "changing module does not read an in-progress reply");
  h.update({ snapshot: snapshotFor({ messageId: "new-answer", text: "New completed answer" }) });
  assert.match(h.root.innerHTML, /exportSyncing/);
  h.advance();
  await flush();
  assert.equal(h.reads.length, 2);
  assert.match(h.root.innerHTML, /Fresh/);
  assert.doesNotMatch(h.root.innerHTML, /exportContentChanged/);
  assert.doesNotMatch(h.root.innerHTML, /data-export-action[^>]*disabled/);
});

test("branch changes auto-refresh, while local settings never re-read or postpone refresh", async () => {
  const h = harness();
  h.update({ active: true });
  await flush();
  h.event("click", "[data-export-format]", { dataset: { exportFormat: "json" } });
  h.event("change", "[data-export-toggle]", { dataset: { exportToggle: "timestamps", exportToggleGroup: "content" }, checked: false });
  assert.equal(h.reads.length, 1);
  assert.doesNotMatch(h.root.innerHTML, /data-export-action[^>]*disabled/);
  h.update({ snapshot: snapshotFor({ messageId: "replacement-answer", text: "Another branch" }) });
  assert.match(h.root.innerHTML, /exportSyncing/);
  assert.match(h.root.innerHTML, /data-export-action[^>]*disabled/);
  assert.equal(h.reads.length, 1);
  h.advance(200);
  h.update({ preferences: { timeZone: "UTC" } });
  h.event("click", "[data-export-format]", { dataset: { exportFormat: "txt" } });
  h.advance(200);
  await flush();
  assert.equal(h.reads.length, 2, "settings do not postpone the pending source update");
  assert.doesNotMatch(h.root.innerHTML, /data-export-action[^>]*disabled/);
});

test("hydration during the first read discards stale content and automatically follows up once", async () => {
  let resolve;
  const h = harness({ requestDocument: () => new Promise((done) => { resolve = done; }) });
  h.update({ active: true });
  h.update({ snapshot: snapshotFor({ title: "Renamed", messageId: "new-answer" }) });
  h.advance(5000);
  h.event("click", "[data-export-refresh]");
  assert.equal(h.reads.length, 1, "an invalidated in-flight read is not duplicated");
  resolve(documentFor("same", "Late old title"));
  await flush();
  assert.doesNotMatch(h.root.innerHTML, /Late old title/);
  assert.match(h.root.innerHTML, /data-export-action[^>]*disabled/);
  assert.equal(h.reads.length, 1);
  h.advance(200);
  h.update({ snapshot: snapshotFor({ title: "Final title", messageId: "new-answer", text: "Mounted body" }) });
  h.advance(399);
  assert.equal(h.reads.length, 1, "successive hydration updates are coalesced");
  h.advance(1);
  assert.equal(h.reads.length, 2);
  resolve(documentFor("same", "Final title", "Mounted body"));
  await flush();
  assert.match(h.root.innerHTML, /Mounted body/);
  assert.doesNotMatch(h.root.innerHTML, /exportContentChanged|data-export-action[^>]*disabled/);
  h.advance(10000); h.update(); await flush();
  assert.equal(h.reads.length, 2, "no background polling after convergence");
});

test("every later conversation switch also converges without manual Refresh", async () => {
  const pending = [];
  const h = harness({ requestDocument: payload => new Promise(resolve => pending.push({ payload, resolve })) });
  h.update({ active: true });
  pending[0].resolve(documentFor()); await flush();
  for (const id of ["second", "third"]) {
    const first = snapshotFor({ id, title: "" }); first.messages = [];
    first.conversation.createdAt = field(null); first.conversation.updatedAt = field(null);
    h.update({ snapshot: first });
    const read = pending.at(-1);
    h.update({ snapshot: snapshotFor({ id, title: `Title ${id}` }) });
    read.resolve(documentFor(id, "Stale title")); await flush();
    assert.doesNotMatch(h.root.innerHTML, /Stale title|exportContentChanged/);
    h.advance();
    pending.at(-1).resolve(documentFor(id, `Title ${id}`, `Body ${id}`)); await flush();
    assert.match(h.root.innerHTML, new RegExp(`Body ${id}`));
    assert.doesNotMatch(h.root.innerHTML, /data-export-action[^>]*disabled/);
  }
  assert.equal(h.reads.length, 5);
});

test("slow old conversations cannot block a new conversation or overwrite its new preview", async () => {
  const pending = [];
  const h = harness({ requestDocument: payload => new Promise(resolve => pending.push({ payload, resolve })) });
  h.update({ active: true });
  h.update({ snapshot: snapshotFor({ id: "second" }) });
  assert.equal(h.reads.length, 2);
  pending[0].resolve(documentFor("same", "Private old title")); await flush();
  assert.doesNotMatch(h.root.innerHTML, /Private old title/);
  pending[1].resolve(documentFor("second", "New conversation")); await flush();
  assert.match(h.root.innerHTML, /New conversation/);
  h.advance(10000); assert.equal(h.reads.length, 2);
});

test("automatic refresh pauses while hidden or in batch mode, and resumes on return", async () => {
  const h = harness(); h.update({ active: true }); await flush();
  h.update({ snapshot: snapshotFor({ title: "New title" }) });
  h.update({ active: false }); h.advance(10000);
  assert.equal(h.reads.length, 1);
  h.update({ active: true }); h.advance(399); assert.equal(h.reads.length, 1);
  h.event("click", "[data-export-mode]", { dataset: { exportMode: "batch" } });
  h.advance(10000); assert.equal(h.reads.length, 1);
  h.event("click", "[data-export-mode]", { dataset: { exportMode: "current" } });
  h.advance(); await flush(); assert.equal(h.reads.length, 2);
  assert.doesNotMatch(h.root.innerHTML, /data-export-action[^>]*disabled/);
});

test("failed auto-refresh stays actionable without an implicit retry loop", async () => {
  const h = harness({ requestDocument: (_payload, read) => read === 2 ? Promise.reject(Error("Offline")) : Promise.resolve(documentFor()) });
  h.update({ active: true }); await flush();
  h.update({ snapshot: snapshotFor({ title: "Changed" }) }); h.advance(); await flush();
  assert.match(h.root.innerHTML, /exportUnavailable/);
  assert.doesNotMatch(h.root.innerHTML, /Offline/, "show localized recovery copy, not raw transport text");
  for (let i = 0; i < 5; i++) { h.update(); h.advance(5000); await flush(); }
  assert.equal(h.reads.length, 2);
  assert.match(h.root.innerHTML, /data-export-retry/);
  h.event("click", "[data-export-retry]"); await flush();
  assert.equal(h.reads.length, 3);
  assert.doesNotMatch(h.root.innerHTML, /Offline|data-export-action[^>]*disabled/);
});

test("opening during a long reply does not read each token or treat a quiet pause as completion", async () => {
  const text = "Long reply prefix ".repeat(20).slice(0, 320);
  const h = harness();
  h.update({ active: true, snapshot: snapshotFor({ text, responseInProgress: true }) });
  h.advance(60000); h.update(); h.advance(60000);
  assert.equal(h.reads.length, 0);
  assert.match(h.root.innerHTML, /exportWaitingForResponse/);
  h.update({ snapshot: snapshotFor({ text, responseInProgress: false }) }); await flush();
  assert.equal(h.reads.length, 1, "completion refreshes even if the bounded excerpt is identical");
  assert.doesNotMatch(h.root.innerHTML, /data-export-action[^>]*disabled/);
});

test("an account change cancels the pending auto-refresh before any old-owner request", async () => {
  const h = harness(); h.update({ active: true }); await flush();
  h.update({ snapshot: snapshotFor({ title: "Changed" }) });
  h.update({ accountKey: null }); h.advance(10000); await flush();
  assert.equal(h.reads.length, 1);
  assert.doesNotMatch(h.root.innerHTML, /Changed|data-export-action/);
});

test("background generation freezes its plan while the next preview can refresh independently", async () => {
  let finish;
  let capturedPlan;
  const h = harness({ generateExport: (plan) => { capturedPlan = plan; return new Promise((resolve) => { finish = resolve; }); } });
  h.update({ active: true });
  await flush();
  h.event("click", "[data-export-action]");
  await flush();
  assert.ok(capturedPlan);
  h.update({ snapshot: snapshotFor({ title: "Replacement", messageId: "replacement-answer" }) });
  await h.view.retry();
  assert.equal(h.reads.length, 2, "the next preview can refresh without altering the background plan");
  assert.equal(capturedPlan.files[0].conversations[0].title, "Original");
  finish({ bytes: new Uint8Array([1]), warnings: [] });
  await flush();
  assert.equal(h.downloads.length, 1);
  assert.match(h.root.innerHTML, /exportJobCompleted/);
});

test("source and generation warnings are visible and never claim a complete export", async () => {
  const source = documentFor();
  source.warnings = ["IMAGE_UNAVAILABLE"]; addImage(source);
  const h = harness({ requestDocument: () => Promise.resolve(source),
    generateExport: async () => ({ bytes: new Uint8Array([1]), warnings: ["Image failed <script>bad()</script>", "Font fallback"] }) });
  h.event('click', '[data-export-format]', { dataset: { exportFormat: 'pdf' } });
  setContentToggle(h, 'mediaAttachments', true); h.update({ active: true });
  await flush();
  assert.match(h.root.innerHTML, /exportImageUnavailable/);
  h.event("click", "[data-export-action]");
  await flush();
  assert.equal(h.downloads.length, 1);
  assert.match(h.root.innerHTML, /exportJobCompleted/);
  assert.match(h.root.innerHTML, /data-export-warnings/);
  assert.match(h.root.innerHTML, /Image failed &lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(h.root.innerHTML, /Font fallback/);
  assert.doesNotMatch(h.root.innerHTML, /<script>/);
});

test("unknown account fails closed and account changes discard cached documents, baskets and late reads", async () => {
  let resolve;
  const h = harness({ model: { accountKey: null }, requestDocument: () => new Promise((done) => { resolve = done; }) });
  h.update({ active: true });
  await flush();
  assert.equal(h.reads.length, 0);
  assert.equal(h.selection.beginSelection("favorites"), false);
  h.update({ accountKey: "library-one", active: true, favorites: { accountKey: "library-one", revision: 1, items: {}, groups: [] } });
  assert.equal(h.reads.length, 1);
  assert.equal(h.reads[0].expectedAccountKey, "library-one");
  h.selection.beginSelection("search");
  h.selection.registerSearchResults([{ source: "conversation", matchKind: "conversation-date", messageId: null,
    conversationId: "date-one", title: "Directory title", accountKey: "different-directory-key",
    conversationCreatedAt: null, conversationUpdatedAt: null }]);
  h.selection.toggleSelection("search", "date-one");
  h.selection.submitSelection("search");
  assert.equal(h.selection.basketCount(), 1, "directory and library identity are distinct contracts");
  h.update({ accountKey: "library-two", active: false });
  resolve(documentFor("same", "Old account private title"));
  await flush();
  assert.equal(h.selection.basketCount(), 0);
  assert.equal(h.selection.selectionContext(), null);
  assert.doesNotMatch(h.root.innerHTML, /Old account private title|Directory title/);
  assert.equal(h.selection.beginSelection("favorites"), false, "old-account store data is not a source for the new owner");
});

test("missing active-branch bookmarks are named in the panel and block partial export", async () => {
  const h = harness();
  h.update({ bookmarks: { accountKey: "library-one", revision: 1, groups: [], items: {
    good: { bookmarkId: "good", conversationId: "same", messageId: "same-assistant", excerpt: "Current answer" },
    missing: { bookmarkId: "missing", conversationId: "same", messageId: "replaced-answer", excerpt: "Replaced answer" },
  } } });
  h.selection.beginSelection("bookmarks");
  h.selection.selectSelectionRange("bookmarks", ["good", "missing"]);
  h.selection.submitSelection("bookmarks");
  h.update({ active: true });
  await flush();
  assert.match(h.root.innerHTML, /exportSelectionIncomplete/);
  assert.match(h.root.innerHTML, /Replaced answer/);
  assert.match(h.root.innerHTML, /data-export-action[^>]*disabled/);
  assert.equal(h.selection.basketCount(), 2);
});

test("suspension hides private content and actions while same-owner resume preserves the internal basket", async () => {
  const h = harness();
  h.selection.beginSelection("favorites"); h.selection.toggleSelection("favorites", "same"); h.selection.submitSelection("favorites");
  h.view.setMode("current"); h.update({ active: true }); await flush();
  assert.equal(h.selection.basketCount(), 1);
  h.view.suspend();
  assert.equal(h.selection.basketCount(), 0);
  assert.doesNotMatch(h.root.innerHTML, /Original|data-export-action/);
  assert.equal(h.selection.beginSelection("favorites"), false);
  h.event("click", "[data-export-action]"); await flush();
  assert.equal(h.downloads.length, 0);
  h.update();
  assert.equal(h.selection.basketCount(), 1);
  assert.match(h.root.innerHTML, /exportSyncing/);
  h.view.suspend(); h.update({ accountKey: "different-owner", active: false });
  assert.equal(h.selection.basketCount(), 0);
});

test("first suspension renders localized retry state and ignores unverified private model fields", async () => {
  const h = harness({ skipInitialUpdate: true });
  h.view.suspend({ active: true, preferences: { language: "zh-CN" },
    translator: (key) => ({ exportAccountRequired: "请确认账号", retry: "重试" }[key] || key),
    accountKey: "unverified-owner", snapshot: snapshotFor({ title: "Must not display" }) });
  assert.match(h.root.innerHTML, /请确认账号/); assert.match(h.root.innerHTML, /data-retry-library>重试/);
  assert.doesNotMatch(h.root.innerHTML, /Must not display|unverified-owner|data-export-action/);
  assert.equal(h.selection.basketCount(), 0); assert.equal(h.selection.beginSelection("search"), false);
  h.view.suspend({ translator: (key) => ({ exportAccountRequired: "Verify account", retry: "Retry" }[key] || key) });
  assert.match(h.root.innerHTML, /Verify account/); assert.doesNotMatch(h.root.innerHTML, /请确认账号/);
  await h.view.retry(); await flush(); assert.equal(h.reads.length, 0);
});


test("three-language preview and download settings share one vocabulary without rereading the source", async () => {
  const source = documentFor("same", "", "Original body");
  source.warnings = ["IMAGE_UNAVAILABLE"]; addImage(source);
  source.conversation.messages[0].segments.unshift({ type: "process", category: "reasoning", phase: "summary", label: "Original subtitle",
    timestamp: null, sourceMessageId: "thinking", blocks: [{ type: "paragraph", text: "Original reasoning" }], queries: [], results: [], tool: null });
  const jobs = [];
  const h = harness({ requestDocument: async () => source, generateExport: async (plan, context) => {
    jobs.push({ plan, context });
    return { outputName: plan.outputName, bytes: h.api.serializeTextBytes(plan.files[0], plan.format, context), warnings: [] };
  } });
  setContentToggle(h, "mediaAttachments", true);
  h.event("click", "[data-export-format]", { dataset: { exportFormat: "json" } });
  h.update({ active: true, snapshot: snapshotFor({ title: "" }), ...languageModel("zh-CN") });
  await flush();
  h.event("change", "[data-export-toggle]", { dataset: { exportToggle: "visibleProcess", exportToggleGroup: "content" }, checked: true });
  for (const language of ["zh-CN", "zh-TW", "en", "ja"]) {
    h.update(languageModel(language));
    const t = translator(language);
    assert.ok(h.root.innerHTML.includes(t("exportImageUnavailable")));
    assert.ok(h.root.innerHTML.includes(t("untitled")));
    assert.ok(h.root.innerHTML.includes('User / Assistant'));
    for (const format of ["markdown", "txt", "json"]) {
      h.event("click", "[data-export-format]", { dataset: { exportFormat: format } });
      if (format !== "json") assert.ok(h.root.innerHTML.includes(t("exportVisibleProcess")));
      h.event("click", "[data-export-action]");
      await flush();
      const { plan, context } = jobs.at(-1);
      assert.equal(context.messages.exportVisibleProcess, t("exportVisibleProcess"));
      assert.equal(context.roleNames.user, 'User');
      assert.equal(context.roleNames.assistant, 'Assistant');
      assert.equal(plan.files[0].conversations[0].title, t("untitled"));
      assert.equal(plan.files[0].baseName, t("untitled"));
      const text = new TextDecoder().decode(h.downloads.at(-1).bytes);
      assert.ok(text.includes(format === "json" ? '"category": "reasoning"' : t("exportVisibleProcess")));
      assert.ok(text.includes("Original subtitle"));
      if (format === 'json') {
        const message = JSON.parse(text).conversation.messages[0];
        assert.equal(message.role, 'assistant');
        assert.equal(message.displayName, 'Assistant');
      }
    }
  }
  assert.equal(h.reads.length, 1, "language changes stay local");
  h.event("input", "[data-export-role]", { dataset: { exportRole: "assistant" }, value: "My assistant" });
  h.event("input", "[data-export-filename]", { dataset: { exportFilename: "current" }, value: "My filename" });
  h.update(languageModel("en"));
  h.event("click", "[data-export-action]");
  await flush();
  assert.equal(jobs.at(-1).plan.outputName, "My filename.json");
  assert.equal(jobs.at(-1).context.roleNames.assistant, "My assistant");
});

test('role fields keep raw drafts across languages; default labels are placeholders, not editable values', async () => {
  const h = harness({ model: languageModel('zh-CN') });
  h.update({ active: true }); await flush();
  const open = () => h.event('click', '[data-export-settings-view]', { dataset: { exportSettingsView: 'shared', exportSettingsTarget: 'roles' } });
  const edit = (role, value) => h.event('input', '[data-export-role]', { dataset: { exportRole: role }, value });
  const emptyFields = () => {
    assert.match(h.root.innerHTML, /data-export-role="user" value="" placeholder="User"/);
    assert.match(h.root.innerHTML, /data-export-role="assistant" value="" placeholder="Assistant"/);
  };
  open(); emptyFields();
  edit('user', '我的名字'); edit('assistant', '私の助手');
  for (const language of ['en', 'ja', 'zh-CN']) {
    h.update(languageModel(language));
    assert.match(h.root.innerHTML, /data-export-role="user" value="我的名字"/);
    assert.match(h.root.innerHTML, /data-export-role="assistant" value="私の助手"/);
  }
  edit('user', ''); edit('assistant', '');
  h.update(languageModel('ja')); emptyFields();
  await h.view.refreshJob(); h.update(); emptyFields();
  // 切走再回来也不是“提交默认值”；空草稿保留，默认值只在展示/输出处生效。
  h.event('click', '[data-export-settings-back]');
  assert.match(h.root.innerHTML, /User \/ Assistant/);
  open(); emptyFields();
  edit('user', ' Reader '); edit('assistant', '助手');
  h.update();
  assert.match(h.root.innerHTML, /data-export-role="user" value=" Reader "/);
  assert.match(h.root.innerHTML, /data-export-role="assistant" value="助手"/);
  assert.equal(h.reads.length, 1, 'renaming roles stays local');
});

test('empty role drafts use output defaults for every export format without writing them into the form', async () => {
  const jobs = [];
  const h = harness({ generateExport: async (plan, context) => {
    jobs.push({ plan, context });
    return { outputName: plan.outputName, bytes: new Uint8Array([1]), warnings: [] };
  } });
  h.update({ active: true }); await flush();
  h.event('input', '[data-export-role]', { dataset: { exportRole: 'user' }, value: 'Reader' });
  h.event('input', '[data-export-role]', { dataset: { exportRole: 'assistant' }, value: 'Helper' });
  for (const role of ['user', 'assistant']) h.event('input', '[data-export-role]', { dataset: { exportRole: role }, value: '' });
  for (const format of ['markdown', 'txt', 'json', 'pdf']) {
    h.event('click', '[data-export-format]', { dataset: { exportFormat: format } });
    h.event('click', '[data-export-action]'); await flush();
    assert.equal(jobs.at(-1).plan.format, format);
    assert.equal(jobs.at(-1).context.roleNames.user, 'User');
    assert.equal(jobs.at(-1).context.roleNames.assistant, 'Assistant');
    h.event('click', '[data-export-settings-view]', { dataset: { exportSettingsView: 'shared', exportSettingsTarget: 'roles' } });
    assert.match(h.root.innerHTML, /data-export-role="user" value="" placeholder="User"/);
    assert.match(h.root.innerHTML, /data-export-role="assistant" value="" placeholder="Assistant"/);
    h.event('click', '[data-export-settings-back]');
  }
  assert.equal(h.reads.length, 1);
});

test('batch selection only reads new bodies, while refresh and source revisions invalidate the cache', async () => {
  const h = harness({ requestDocuments: payload => Promise.resolve({ schemaVersion: 'chatgpt-tidy.export-source-collection.v2',
    documents: payload.conversationIds.map(id => documentFor(id)) }) });
  h.update({ favorites: { ...h.model().favorites, items: { ...h.model().favorites.items, second: { conversationId: 'second', title: 'Second' } } } });
  const select = ids => {
    h.selection.beginSelection('favorites'); h.selection.selectSelectionRange('favorites', ids);
    h.selection.submitSelection('favorites'); h.view.setMode('batch'); h.update({ active: true });
  };
  select(['same']); await flush();
  select(['second']); await flush();
  assert.deepEqual(h.batchReads.map(read => Array.from(read.conversationIds)), [['same'], ['second']]);
  h.event('click', '[data-export-refresh]'); await flush();
  assert.deepEqual(Array.from(h.batchReads[2].conversationIds), ['same', 'second']);
  h.update({ favorites: { ...h.model().favorites, revision: 2 } }); await flush();
  assert.deepEqual(Array.from(h.batchReads[3].conversationIds), ['same', 'second']);
});

test("batch automatic names translate, while customized excerpt and ZIP names survive language changes", async () => {
  const h = harness({ model: languageModel("en") });
  h.update({ bookmarks: { ...h.model().bookmarks, items: { saved: { bookmarkId: "saved", conversationId: "same", messageId: "same-assistant", groupId: null, excerpt: "Original body" } } } });
  h.selection.beginSelection("bookmarks");
  h.selection.selectSelectionRange("bookmarks", ["saved"]);
  h.selection.submitSelection("bookmarks");
  h.view.setMode("batch");
  h.update({ active: true });
  await flush();
  assert.ok(h.root.innerHTML.includes('value="Bookmark excerpts"'));
  h.update(languageModel("ja"));
  assert.ok(h.root.innerHTML.includes('value="ブックマーク抜粋"'));
  h.event("input", "[data-export-filename]", { dataset: { exportFilename: "batch-single" }, value: "My excerpt" });
  h.update(languageModel("zh-CN"));
  assert.ok(h.root.innerHTML.includes('value="My excerpt"'));
  h.selection.beginSelection("favorites");
  h.selection.selectSelectionRange("favorites", ["same"]);
  h.selection.submitSelection("favorites");
  h.update();
  await flush();
  assert.ok(h.root.innerHTML.includes('value="ChatGPT-Tidy-导出"'));
  h.update(languageModel("en"));
  assert.ok(h.root.innerHTML.includes('value="ChatGPT-Tidy-Export"'));
  h.event("input", "[data-export-filename]", { dataset: { exportFilename: "batch" }, value: "My archive" });
  h.update(languageModel("ja"));
  assert.ok(h.root.innerHTML.includes('value="My archive"'));
  assert.equal(h.batchReads.length, 1, "adding the already loaded conversation reuses its verified body; language changes stay local");
});

test("changing language during generation leaves the submitted task text and dates intact", async () => {
  let finish, job;
  const h = harness({ model: languageModel("en"), formatTimestamp: (value, preferences) => preferences.language + ":" + value,
    generateExport: (plan, context) => { job = { plan, context }; return new Promise((resolve) => { finish = resolve; }); } });
  h.update({ active: true });
  await flush();
  h.event("click", "[data-export-action]");
  await flush();
  h.update(languageModel("ja"));
  assert.equal(job.context.messages.exportVisibleProcess, "Visible reasoning");
  assert.equal(job.context.formatTimestamp("2026-09-10T00:01:00Z"), "en:2026-09-10T00:01:00Z");
  assert.equal(job.plan.messages.exportVisibleProcess, "Visible reasoning");
  finish({ outputName: "old.md", bytes: new Uint8Array([1]), warnings: [] });
  await flush();
  assert.equal(h.downloads.length, 1);
  assert.equal(h.reads.length, 1);
  assert.doesNotMatch(h.root.innerHTML, /data-export-action[^>]*disabled/);
});

test("source warnings and dependency failures are translated at the panel boundary in all shipping languages", async () => {
  const source = documentFor();
  source.warnings = ["IMAGE_UNAVAILABLE"]; addImage(source);
  const h = harness({ requestDocument: async () => source, generateExport: async () => { throw h.api.exportError("exportDependencyFailed", { name: "PDF" }); } });
  h.event('click', '[data-export-format]', { dataset: { exportFormat: 'pdf' } });
  setContentToggle(h, 'mediaAttachments', true); h.update({ active: true });
  await flush();
  for (const language of ["zh-CN", "zh-TW", "en", "ja"]) {
    h.update(languageModel(language));
    h.event("click", "[data-export-action]");
    await flush();
    assert.ok(h.root.innerHTML.includes(translator(language)("exportJobFailed")));
    assert.ok(h.root.innerHTML.includes(translator(language)("exportImageUnavailable")));
  }
  assert.equal(h.reads.length, 1);
});

test('admitted task survives module and settings changes, repeats show progress, and only explicit cancel stops it', async () => {
  const submissions = [], cancels = []; let job = null;
  const h = harness({ jobRequest: async (action, p) => {
    if (action === 'status') return job;
    if (action === 'cancel') { cancels.push(p.id); return job = { ...job, revision: 2, state: 'cancelled' }; }
    submissions.push(p); return job = { id: p.id, outputName: p.spec.plan.outputName, state: 'generating', revision: 1 };
  } });
  h.update({ active: true }); await flush(); h.event('click', '[data-export-action]'); await flush();
  h.event('input', '[data-export-filename]', { dataset: { exportFilename: 'current' }, value: 'Next file' });
  h.event('click', '[data-export-format]', { dataset: { exportFormat: 'pdf' } });
  h.update({ active: false }); h.update({ active: true });
  h.event('click', '[data-export-action]'); await flush();
  assert.equal(submissions.length, 1); assert.equal(submissions[0].spec.plan.format, 'markdown');
  assert.equal(submissions[0].spec.plan.outputName, 'Original.md'); assert.equal(cancels.length, 0);
  assert.match(h.root.innerHTML, /exportJobShowProgress/); assert.equal(h.view.hasActiveJob(), true);
  h.event('click', '[data-export-job-cancel]'); await flush();
  assert.deepEqual(cancels, ['test-preview']); assert.match(h.root.innerHTML, /exportJobCancelled/);
  h.event('click', '[data-export-action]'); await flush();
  assert.equal(submissions.length, 2); assert.equal(submissions[1].spec.plan.outputName, 'Next file.pdf');
});

test('media exclusion removes irrelevant missing-image warnings from both preview and task snapshot', async () => {
  const source = documentFor(); source.warnings = ['IMAGE_UNAVAILABLE'];
  const h = harness({ requestDocument: async () => source }); h.update({ active: true }); await flush();
  h.event('change', '[data-export-toggle]', { dataset: { exportToggle: 'mediaAttachments', exportToggleGroup: 'content' }, checked: false });
  assert.doesNotMatch(h.root.innerHTML, /exportImageUnavailable/);
  h.event('click', '[data-export-action]'); await flush();
  assert.equal(h.submissions[0].spec.warnings.length, 0);
  assert.doesNotMatch(h.root.innerHTML, /exportImageUnavailable/);
});

test('changed settings dismiss full preview, but a repeat click on the same format does not', async () => {
  const h = harness(); h.update({ active: true }); await flush();
  h.event('click', '[data-export-full-preview]'); await flush();
  h.event('click', '[data-export-format]', { dataset: { exportFormat: 'markdown' } }); await flush();
  assert.equal(h.dismissed.length, 0);
  h.event('click', '[data-export-format]', { dataset: { exportFormat: 'pdf' } }); await flush();
  assert.equal(h.dismissed.length, 1);
});

test('lost submit reply checks status once and does not replay the export', async () => {
  let starts = 0, job;
  const h = harness({ jobRequest: async (action, p) => {
    if (action === 'status') return job || null;
    starts++; job = { id: p.id, state: 'saving', revision: 3, outputName: p.spec.plan.outputName };
    throw Error('Lost message port');
  } });
  h.update({ active: true }); await flush(); h.event('click', '[data-export-action]'); await flush();
  assert.equal(starts, 1); assert.match(h.root.innerHTML, /exportJobSaving/);
  h.event('click', '[data-export-action]'); await flush(); assert.equal(starts, 1);
});

test('confirmed rejected admission shows a retryable error, not a silent vanished task', async () => {
  const h = harness({ jobRequest: async action => { if (action === 'status') return null; throw Error('Route changed before admission'); } });
  h.update({ active: true }); await flush(); h.event('click', '[data-export-action]'); await flush();
  assert.match(h.root.innerHTML, /exportJobNotStarted/); assert.equal(h.view.hasActiveJob(), false);
});

test('late job status cannot expose an old account after suspend and owner change', async () => {
  let resolve;
  const h = harness({ jobRequest: () => new Promise(r => { resolve = r; }) });
  const oldResolve = resolve;
  h.view.suspend(); h.update({ accountKey: 'new-owner' });
  oldResolve({ id: 'private', state: 'generating', outputName: 'OLD PRIVATE TITLE' }); await flush();
  assert.doesNotMatch(h.root.innerHTML, /OLD PRIVATE TITLE/);
  resolve(null); await flush(); assert.equal(h.view.hasActiveJob(), false);
});

test('a pre-submit status response cannot clear the newly admitted task when messages arrive out of order', async () => {
  let resolveStatus;
  const h = harness({ jobRequest: async (action, payload) => {
    if (action === 'status') return new Promise(r => { resolveStatus = r; });
    return { id: payload.id, outputName: 'NEW TASK.txt', state: 'generating', revision: 2 };
  } });
  h.update({ active: true }); await flush(); h.event('click', '[data-export-action]'); await flush();
  assert.equal(h.view.hasActiveJob(), true);
  resolveStatus(null); await flush();
  assert.equal(h.view.hasActiveJob(), true); assert.match(h.root.innerHTML, /NEW TASK.txt/);
});

// Rendering is a read-only presentation boundary, even while feature owners have
// unresolved work. These exercise the real graph rather than a renderer stub.
test('render alone preserves a source draft and never starts hidden document or job work', async () => {
  const h = harness(); await flush();
  assert.equal(h.selection.beginSelection('favorites', 'source'), true);
  assert.equal(h.selection.toggleSelection('favorites', 'same'), true);
  const before = JSON.stringify(h.selection.selectionState('favorites'));
  const actions = [...h.jobActions];
  for (let index = 0; index < 8; index++) h.view.render();
  await flush();
  assert.equal(JSON.stringify(h.selection.selectionState('favorites')), before);
  assert.equal(h.selection.selectionContext().source, 'favorites');
  assert.equal(h.reads.length, 0); assert.equal(h.batchReads.length, 0);
  assert.equal(h.submissions.length, 0); assert.deepEqual(h.jobActions, actions);
});

test('repeated render does not restart or retire the pending selected image owner', async () => {
  const source = addImage(documentFor(), 'render-image', true), requests = [];
  const h = harness({ requestDocument: async () => source,
    requestResource: payload => new Promise(resolve => requests.push({ payload, resolve })) });
  h.event('click', '[data-export-format]', { dataset: { exportFormat: 'pdf' } });
  setContentToggle(h, 'mediaAttachments', true); h.update({ active: true }); await flush();
  assert.equal(requests.length, 1); assert.match(h.root.innerHTML, /exportImagesPreparing/);
  const actions = [...h.jobActions], markup = h.root.innerHTML;
  for (let index = 0; index < 8; index++) h.view.render();
  await flush();
  assert.equal(h.root.innerHTML, markup);
  assert.equal(h.reads.length, 1); assert.equal(requests.length, 1);
  assert.deepEqual(h.jobActions, actions); assert.equal(h.submissions.length, 0);
  requests[0].resolve({ readHandle: requests[0].payload.readHandle,
    resource: { ...source.conversation.resources[0], src: 'https://example.com/render-image.png', pending: false } });
  await flush();
  assert.doesNotMatch(h.root.innerHTML, /exportImagesPreparing|exportImageUnavailable/);
  h.event('click', '[data-export-action]'); await flush();
  assert.equal(h.submissions.length, 1);
  assert.equal(h.api.selectedImageResources(h.submissions[0].spec.plan).length, 1);
  // Resolution is applied only to the immutable document owner, not its input.
  const selected = h.api.selectedImageResources(h.submissions[0].spec.plan)[0].resource;
  assert.equal(selected.pending, undefined); assert.equal(selected.readHandle, undefined);
  assert.equal(selected.src, 'https://example.com/render-image.png');
  assert.equal(source.conversation.resources[0].pending, true);
  assert.equal(source.conversation.resources[0].readHandle, 'image-1-render-image');
  assert.equal(h.reads.length, 1); assert.equal(requests.length, 1);
});


test('a custom batch filename survives refresh gaps and resets only for a genuinely different selection', async () => {
  let reads = 0, finishRefresh;
  const collection = id => ({ schemaVersion: 'chatgpt-tidy.export-source-collection.v2',
    documents: [documentFor(id, id === 'same' ? 'Original' : 'Second')] });
  const h = harness({ model: languageModel('en'), requestDocuments: payload => {
    reads++;
    if (reads === 2) return new Promise(resolve => { finishRefresh = resolve; });
    return Promise.resolve(collection(payload.conversationIds[0]));
  } });
  h.selection.beginSelection('favorites'); h.selection.toggleSelection('favorites', 'same');
  h.selection.submitSelection('favorites'); h.view.setMode('batch'); h.update({ active: true });
  await flush();
  assert.equal(h.batchReads.length, 1);
  h.event('input', '[data-export-filename]', { dataset: { exportFilename: 'batch-single' }, value: 'Custom' });
  assert.match(h.root.innerHTML, /data-export-filename="batch-single" value="Custom"/);

  h.event('click', '[data-export-refresh]'); await flush();
  assert.equal(h.batchReads.length, 2);
  assert.ok(h.root.innerHTML.includes(translator('en')('exportBatchReading')));
  assert.match(h.root.innerHTML, /data-export-action disabled/);
  assert.doesNotMatch(h.root.innerHTML, /data-export-filename="batch-single" value="Original"/);
  h.event('click', '[data-export-action]'); await flush();
  assert.equal(h.submissions.length, 0);
  assert.equal(h.batchReads.length, 2, 'a disabled export cannot duplicate the pending refresh');

  finishRefresh(collection('same')); await flush();
  assert.match(h.root.innerHTML, /data-export-filename="batch-single" value="Custom"/);
  h.event('click', '[data-export-action]'); await flush();
  assert.equal(h.submissions.length, 1);
  assert.equal(h.submissions[0].spec.plan.outputName, 'Custom.md');

  h.selection.removeConversation('same');
  h.update({ favorites: { ...h.model().favorites, revision: 2,
    items: { second: { conversationId: 'second', title: 'Second' } } } });
  h.selection.beginSelection('favorites'); h.selection.toggleSelection('favorites', 'second');
  h.selection.submitSelection('favorites'); await flush();
  assert.equal(h.batchReads.length, 3);
  assert.deepEqual(Array.from(h.batchReads[2].conversationIds), ['second']);
  assert.match(h.root.innerHTML, /data-export-filename="batch-single" value="Second"/);
  assert.doesNotMatch(h.root.innerHTML, /data-export-filename="batch-single" value="Custom"/);
});


// These are product defaults, not a change to what an explicit media/source opt-in can export.
function sourceWithOptionalContent() {
  const source = addImage(documentFor(), 'opt-in-image', true);
  source.conversation.messages[0].segments.push({ type: 'sources', sourceMessageId: 'same-assistant', timestamp: null,
    items: [{ title: 'Optional source', url: 'https://source.example/reference', domain: 'source.example' }] });
  return source;
}
function setContentToggle(h, key, checked) {
  h.event('change', '[data-export-toggle]', { dataset: { exportToggle: key, exportToggleGroup: 'content' }, checked });
}
function checkContentToggle(h, key, checked) {
  const input = h.root.innerHTML.match(new RegExp('<input[^>]*data-export-toggle="' + key + '"[^>]*>'));
  assert.ok(input, key);
  assert.ok(input[0].includes('aria-checked="' + checked + '"'), input[0]);
}

test('new export UI starts with sources and media off, retains other defaults and requests no image', async () => {
  const source = sourceWithOptionalContent(); let imageReads = 0;
  const h = harness({ requestDocument: async () => source, requestResource: async () => { imageReads++; throw Error('unexpected image lookup'); } });
  h.update({ active: true }); await flush();
  h.event('click', '[data-export-settings-view]', { dataset: { exportSettingsView: 'shared' } });
  for (const key of ['finalSources', 'mediaAttachments', 'visibleProcess', 'toolProcess', 'webProcess']) checkContentToggle(h, key, false);
  for (const key of ['timestamps', 'messageNumbers']) checkContentToggle(h, key, true);
  h.event('click', '[data-export-action]'); await flush();
  assert.equal(imageReads, 0);
  assert.equal(h.submissions.length, 1);
  assert.equal(h.api.selectedImageResources(h.submissions[0].spec.plan).length, 0);
  assert.doesNotMatch(JSON.stringify(h.submissions[0].spec.plan.files), /Optional source|opt-in-image/);
});

test('engine plans omitted options from the same frozen defaults in every format; explicit opt-in remains available', () => {
  const h = harness(), source = sourceWithOptionalContent(), api = h.api;
  assert.equal(Object.isFrozen(api.DEFAULT_PROJECTION_OPTIONS), true);
  const data = api.normalizeExportData({ conversations: [source.conversation], bookmarks: [] });
  for (const format of ['markdown', 'json', 'txt', 'pdf']) {
    const config = { mode: 'current', format, currentConversationId: 'same', data, messages: api.createExportMessages(key => key) };
    const off = api.buildExportPlan(config);
    assert.equal(api.selectedImageResources(off).length, 0, format);
    assert.equal(Object.hasOwn(off, 'assets'), false, format);
    assert.doesNotMatch(JSON.stringify(off.files), /Optional source|opt-in-image/, format);
    const on = api.buildExportPlan({ ...config, options: { finalSources: true, mediaAttachments: true } });
    assert.equal(api.selectedImageResources(on).length, 1, format);
    assert.match(JSON.stringify(on.files), /Optional source/, format);
  }
});

test('manually enabled sources and media survive format switches, settings navigation and leaving the export panel', async () => {
  const source = sourceWithOptionalContent(); let imageReads = 0;
  const h = harness({ requestDocument: async () => source, requestResource: async p => {
    imageReads++;
    return { readHandle: p.readHandle, resource: { ...source.conversation.resources[0], pending: false, src: 'https://images.example/opt-in.png' } };
  } });
  h.update({ active: true }); await flush();
  setContentToggle(h, 'mediaAttachments', true); setContentToggle(h, 'finalSources', true); await flush();
  assert.equal(imageReads, 0, 'Markdown opt-in adds descriptions, not image-address reads');
  for (const format of ['markdown', 'json', 'txt', 'pdf']) {
    h.event('click', '[data-export-format]', { dataset: { exportFormat: format } });
    h.event('click', '[data-export-settings-view]', { dataset: { exportSettingsView: 'shared' } });
    h.update({ active: false }); h.update({ active: true }); await flush();
    checkContentToggle(h, 'mediaAttachments', true); checkContentToggle(h, 'finalSources', true);
    h.event('click', '[data-export-action]'); await flush();
    const plan = h.submissions.at(-1).spec.plan;
    assert.equal(plan.format, format);
    assert.equal(h.api.selectedImageResources(plan).length, 1, format);
    assert.match(JSON.stringify(plan.files), /Optional source/, format);
  }
  assert.equal(imageReads, 1, 'format/panel changes do not refetch an already resolved image');
});


for (const format of ['markdown', 'txt']) test(format + ' media opt-in uses the same description in full preview and export without resolving images', async () => {
  const source = sourceWithOptionalContent(), previews = []; let imageReads = 0;
  const h = harness({ requestDocument: async () => source,
    requestResource: async () => { imageReads++; throw Error('text formats must never resolve images'); },
    presentFullPreview: async payload => { previews.push(payload); },
    generateExport: async (plan, context) => ({ outputName: plan.outputName,
      bytes: h.api.serializeTextBytes(plan.files[0], plan.format, context), warnings: [] }),
  });
  h.update({ active: true, ...languageModel('en') }); await flush();
  setContentToggle(h, 'mediaAttachments', true);
  h.event('click', '[data-export-format]', { dataset: { exportFormat: format } });
  h.event('click', '[data-export-full-preview]'); await flush();
  assert.equal(previews.length, 1);
  assert.equal(previews[0].previewParts, undefined);
  assert.match(previews[0].content, /opt-in-image/);
  assert.match(previews[0].content, /https:\/\/chatgpt.com\/c\/same/);
  assert.doesNotMatch(previews[0].content, /!\[|image-1-opt-in-image/);
  assert.doesNotMatch(h.root.innerHTML, /exportImagesPreparing|exportImageUnavailable/);
  h.event('click', '[data-export-action]'); await flush();
  assert.equal(h.submissions.length, 1);
  assert.equal(imageReads, 0);
  assert.equal(h.submissions[0].spec.plan.zipped, false);
  assert.equal(new TextDecoder().decode(h.downloads[0].bytes), previews[0].content);
});

test('switching a pending PDF image to text releases its wait and ignores the old image-address result', async () => {
  const source = sourceWithOptionalContent(), requests = [];
  const h = harness({ requestDocument: async () => source,
    requestResource: payload => new Promise(resolve => requests.push({ payload, resolve })) });
  h.update({ active: true }); await flush();
  setContentToggle(h, 'mediaAttachments', true);
  h.event('click', '[data-export-format]', { dataset: { exportFormat: 'pdf' } }); await flush();
  assert.equal(requests.length, 1); assert.match(h.root.innerHTML, /exportImagesPreparing/);
  h.event('click', '[data-export-format]', { dataset: { exportFormat: 'markdown' } });
  h.event('click', '[data-export-action]'); await flush();
  assert.equal(h.submissions.length, 1);
  assert.doesNotMatch(h.root.innerHTML, /exportImagesPreparing|exportImageUnavailable/);
  requests[0].resolve({ readHandle: requests[0].payload.readHandle,
    resource: { ...source.conversation.resources[0], src: 'https://chatgpt.com/private?sig=late', temporaryUrl: true, pending: false } });
  await flush();
  assert.equal(h.api.selectedImageResources(h.submissions[0].spec.plan)[0].resource.pending, true);
  assert.equal(requests.length, 1);
  assert.doesNotMatch(h.root.innerHTML, /sig=late/);
});

const streamingPendingError = () => Object.assign(new Error('private streaming detail'), { code: 'EXPORT_RESPONSE_PENDING' });

test('API pending uses existing syncing UI, exhausts to reread, and never exports cached preview', async () => {
  let pending = false;
  const h = harness({ requestDocument: async () => {
    if (pending) throw streamingPendingError();
    return documentFor();
  } });
  h.update({ active: true }); await flush();
  assert.match(h.root.innerHTML, /Original body/);
  h.event('click', '[data-export-full-preview]'); await flush();
  pending = true;
  h.event('click', '[data-export-refresh]'); await flush();
  assert.doesNotMatch(h.root.innerHTML, /Original body|exportUnavailable|private streaming detail/);
  assert.match(h.root.innerHTML, /exportSyncing/);
  assert.match(h.root.innerHTML, /data-export-action[^>]*disabled/);
  assert.ok(h.dismissed.length > 0);
  for (const delay of [400, 1000, 2000]) {
    h.advance(delay); await flush();
    h.event('click', '[data-export-action]'); await flush();
  }
  assert.equal(h.reads.length, 5);
  assert.equal(h.submissions.length, 0);
  assert.match(h.root.innerHTML, /exportInvalidDocument/);
  assert.match(h.root.innerHTML, /data-export-retry/);
  assert.doesNotMatch(h.root.innerHTML, /exportSyncing|data-export-refresh disabled/);
  h.update(); h.advance(10000); await flush(); assert.equal(h.reads.length, 5);
  pending = false;
  h.event('click', '[data-export-retry]'); await flush();
  assert.match(h.root.innerHTML, /Original body/);
  assert.doesNotMatch(h.root.innerHTML, /data-export-action[^>]*disabled/);
});

test('pending retry deadline survives language, settings, and layout rendering', async () => {
  const h = harness({ requestDocument: async (_payload, number) => {
    if (number <= 2) throw streamingPendingError();
    return documentFor();
  } });
  h.update({ active: true }); await flush();
  h.advance(100); h.update(languageModel('en'));
  h.advance(100); h.event('click', '[data-export-format]', { dataset: { exportFormat: 'txt' } });
  h.advance(100); h.view.render();
  h.advance(100); await flush();
  assert.equal(h.reads.length, 2);
  h.advance(500); h.update(languageModel('ja')); h.view.render();
  h.advance(500); await flush();
  assert.equal(h.reads.length, 3);
  assert.match(h.root.innerHTML, /Original body/);
  assert.doesNotMatch(h.root.innerHTML, /data-export-action[^>]*disabled/);
});

test('definite pending start invalidates its ready preview and waits for reread, not job status', async () => {
  const actions = [];
  const h = harness({ jobRequest: async (action, payload) => {
    actions.push(action);
    if (action === 'start') throw streamingPendingError();
    return null;
  } });
  h.update({ active: true }); await flush();
  const statuses = actions.filter(action => action === 'status').length;
  h.event('click', '[data-export-action]'); await flush();
  assert.equal(h.view.hasActiveJob(), false);
  assert.match(h.root.innerHTML, /exportSyncing/);
  assert.doesNotMatch(h.root.innerHTML, /Original body|exportJobUnknown|exportGenerationFailed/);
  assert.match(h.root.innerHTML, /data-export-action[^>]*disabled/);
  h.event('click', '[data-export-action]'); await flush();
  assert.equal(actions.filter(action => action === 'start').length, 1);
  h.advance(400); await flush();
  assert.equal(h.reads.length, 2);
  assert.equal(actions.filter(action => action === 'status').length, statuses);
  assert.match(h.root.innerHTML, /Original body/);
  h.event('click', '[data-export-action]'); await flush();
  assert.equal(actions.filter(action => action === 'start').length, 2);
});

test('late definite pending start cannot invalidate a reentered route A after A-B-A', async () => {
  let rejectStart;
  const h = harness({ jobRequest: async action => action === 'start'
    ? new Promise((_resolve, reject) => { rejectStart = reject; }) : null,
    requestDocument: async payload => documentFor(payload.expectedConversationId),
  });
  h.update({ active: true }); await flush();
  h.event('click', '[data-export-action]'); await flush();
  h.update({ snapshot: snapshotFor({ id: 'second' }) }); await flush();
  h.update({ snapshot: snapshotFor() }); await flush();
  assert.equal(h.reads.length, 3);
  rejectStart(streamingPendingError()); await flush();
  h.advance(10000); await flush();
  assert.match(h.root.innerHTML, /Original body/);
  assert.doesNotMatch(h.root.innerHTML, /exportSyncing|exportInvalidDocument|exportJobUnknown/);
  assert.equal(h.reads.length, 3);
});

test('accepted job snapshot stays frozen when later preview read is API-pending', async () => {
  let finish, captured;
  const h = harness({ requestDocument: async (_payload, number) => {
    if (number > 1) throw streamingPendingError();
    return documentFor();
  }, jobRequest: async (action, payload) => {
    if (action !== 'start') return null;
    captured = payload;
    return new Promise(resolve => { finish = resolve; });
  } });
  h.update({ active: true }); await flush();
  h.event('click', '[data-export-action]'); await flush();
  const frozen = JSON.stringify(captured);
  h.update({ snapshot: snapshotFor({ responseInProgress: true, text: 'new response' }) });
  assert.match(h.root.innerHTML, /exportWaitingForResponse/);
  h.update({ snapshot: snapshotFor({ responseInProgress: false, text: 'new response' }) });
  h.advance(400); await flush();
  assert.match(h.root.innerHTML, /exportSyncing/);
  assert.equal(JSON.stringify(captured), frozen);
  finish({ id: captured.id, revision: 2, state: 'completed', outputName: 'frozen.md', warnings: [] }); await flush();
  assert.match(h.root.innerHTML, /exportJobCompleted/);
  assert.match(h.root.innerHTML, /exportSyncing/);
  assert.equal(JSON.stringify(captured), frozen);
});