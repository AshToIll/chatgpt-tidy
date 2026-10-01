import { createExportSelection } from '../../src/features/export/ui/export-selection.js';
// 使用原生 details 验证阅读状态；不连接账号，也不生成或下载真实文件。
import { createTranslator } from '../../src/messages/i18n.js';
import { createExportView } from '../../src/features/export/ui/export-view.js';

export async function runDisclosureChecks({ check, assert, waitFor, sleep, space }) {
  const warningSelector = '[data-export-warnings]';
  const selectionSelector = '[data-export-selection-error]';
  function image(source, id, pending = false) {
    source.conversation.resources.push({ id, type: 'image', name: id, mimeType: '', sizeBytes: null, src: '', alt: id,
      ...(pending ? { pending: true, readHandle: `image-1-${id}` } : {}) });
    source.conversation.messages[0].segments[0].blocks.push({ type: 'image', resourceId: id, alt: id });
    return source;
  }
  function sourceFor(id) {
    return image({ schemaVersion: TidyExportContract.VERSION, warnings: [], conversation: {
      id, title: id, sourceUrl: `https://chatgpt.com/c/${id}`, createdAt: '', updatedAt: '', resources: [],
      messages: [{ id: `${id}-message`, messageNumber: 1, role: 'user', timestamp: null, segments: [
        { type: 'content', sourceMessageId: `${id}-message`, timestamp: null, blocks: [{ type: 'paragraph', text: 'Fixture' }] },
      ] }],
    } }, 'missing-image');
  }
  function snapshotFor(id) {
    return { route: { pathname: `/c/${id}` }, messages: [], conversation: {
      conversationId: id, identityStatus: 'stable', bindingStatus: 'bound', title: { value: id },
    } };
  }
  function harness(options = {}) {
    const validation = TidyExportContract.validateDocument(options.source || sourceFor('disclosure-one'));
    assert(validation.valid, 'Invalid disclosure fixture: ' + JSON.stringify(validation));
    const root = document.createElement('div'); document.body.append(root);
    let reads = 0, job = null;
    const model = { active: true, accountKey: 'disclosure-account', translator: createTranslator('zh-CN'), preferences: {},
      snapshot: snapshotFor('disclosure-one'),
      favorites: { accountKey: 'disclosure-account', revision: 1, groups: [], items: {
        'disclosure-one': { conversationId: 'disclosure-one', title: 'One' },
        'disclosure-two': { conversationId: 'disclosure-two', title: 'Two' },
      } },
      bookmarks: { accountKey: 'disclosure-account', revision: 1, groups: [], items: {
        first: { bookmarkId: 'first', conversationId: 'disclosure-one', messageId: 'missing-first', excerpt: 'First missing' },
        second: { bookmarkId: 'second', conversationId: 'disclosure-one', messageId: 'missing-second', excerpt: 'Second missing' },
      } },
    };
    const selection = createExportSelection({ noticeText: (key, values) => model.translator(key, values) });
    const view = createExportView({ selection, root,
      requestDocument: async ({ expectedConversationId }) => { reads++; return options.source || sourceFor(expectedConversationId); },
      requestDocuments: async ({ conversationIds }) => ({ schemaVersion: TidyExportContract.COLLECTION_VERSION,
        documents: conversationIds.map(sourceFor) }),
      requestResource: options.requestResource,
      presentFullPreview: async () => ({}), dismissFullPreview: async () => ({}), formatTimestamp: value => value,
      jobRequest: async () => job,
    });
    const $ = selector => root.querySelector(selector);
    const update = (patch = {}) => { Object.assign(model, patch); view.updateContext(model); };
    function select(source, ids) {
      assert(selection.beginSelection(source), 'Selection could not open');
      selection.selectSelectionRange(source, ids); selection.submitSelection(source); update();
    }
    update();
    // These scenarios intentionally exercise image-warning reading state, not
    // the default text-only export. JSON and PDF resolve media when opted in.
    $('[data-export-format="json"]').click();
    $('[data-export-settings-target="content"]').click();
    $('[data-export-toggle="mediaAttachments"]').click();
    $('[data-export-settings-back]').click();
    return { root, $, view, model, update, select, reads: () => reads,
      async progress() {
        job = { id: 'disclosure-job', state: 'generating', revision: (job?.revision || 0) + 1,
          outputName: 'fixture.md', progress: { phase: 'files', done: 1, total: 2 } };
        await view.refreshJob();
      },
      async close() { job = null; await view.refreshJob(); update({ active: false }); root.remove(); },
    };
  }
  async function scenario(name, run, options) {
    await check(name, async () => {
      const h = harness(options);
      try { await waitFor(() => h.$(warningSelector)); await run(h); }
      finally { await h.close(); }
    });
  }

  await scenario('source warning retains native expansion and focus through model, progress and language updates', async h => {
    const details = h.$(warningSelector), summary = details.querySelector('summary');
    summary.focus(); await space(); assert(details.open, 'Space did not expand warning');
    const reads = h.reads();
    h.update(); await h.progress();
    h.update({ preferences: { language: 'zh-TW' }, translator: createTranslator('zh-TW') });
    assert(h.$(warningSelector) === details && details.open, 'Unrelated update collapsed warning');
    assert(document.activeElement === summary, 'Warning summary lost keyboard focus');
    assert(h.reads() === reads, 'Disclosure preservation triggered another document read');
    await space(); h.update(); await h.progress();
    assert(!details.open, 'Manual collapse was reversed');
  });

  await scenario('immediate refresh before native toggle delivery keeps the latest open and closed state', async h => {
    const details = h.$(warningSelector);
    details.querySelector('summary').click(); h.update();
    assert(details.open, 'Refresh before toggle event collapsed warning');
    await sleep(20); h.update(); assert(details.open, 'Delayed toggle changed expansion');
    details.querySelector('summary').click(); h.update();
    assert(!details.open, 'Refresh before toggle event reopened warning');
    await sleep(20); h.update(); assert(!details.open, 'Delayed toggle reopened warning');
  });

  let releaseImage;
  await scenario('changed missing-image set resets expansion even when the summary text is unchanged', async h => {
    await waitFor(() => releaseImage);
    const details = h.$(warningSelector), label = details.textContent;
    details.open = true; h.update(); assert(details.open, 'Warning did not stay open before image result');
    releaseImage(); await waitFor(() => !details.open);
    assert(h.$(warningSelector) === details && details.textContent === label, 'Fixture warning wording unexpectedly changed');
    details.open = true; h.update(); assert(details.open, 'New warning cannot retain its own expansion');
  }, { source: image(sourceFor('disclosure-one'), 'pending-image', true), requestResource: payload => new Promise(resolve => {
    releaseImage = () => resolve({ readHandle: payload.readHandle, resource: {
      id: 'pending-image', type: 'image', name: 'pending-image', mimeType: '', sizeBytes: null, src: '', alt: 'pending-image', pending: false,
    } });
  }) });

  await scenario('new conversation and account do not inherit old expansion or delayed toggle events', async h => {
    h.$(warningSelector).open = true;
    h.update({ snapshot: snapshotFor('disclosure-two') });
    await waitFor(() => h.$(warningSelector));
    await sleep(20); h.update();
    assert(!h.$(warningSelector).open, 'Another conversation inherited expansion');
    h.$(warningSelector).open = true;
    h.update({ accountKey: 'another-account' });
    await waitFor(() => h.$(warningSelector));
    await sleep(20); h.update();
    assert(!h.$(warningSelector).open, 'Another account inherited expansion');
  });

  await scenario('format and settings keep the same warning open; media off removes it and re-enabling starts closed', async h => {
    h.$(warningSelector).open = true; h.$('[data-export-format="pdf"]').click();
    assert(h.$(warningSelector).open, 'Format change collapsed the same warning');
    h.$('[data-export-settings-target="content"]').click();
    assert(h.$(warningSelector).open, 'Settings navigation collapsed the same warning');
    h.$('[data-export-toggle="mediaAttachments"]').click();
    assert(!h.$(warningSelector), 'Excluded media still warns');
    h.$('[data-export-toggle="mediaAttachments"]').click();
    assert(h.$(warningSelector) && !h.$(warningSelector).open, 'Reappearing warning inherited expansion');
  });

  await scenario('Markdown and TXT do not warn about images; returning to PDF starts the warning closed', async h => {
    h.$(warningSelector).open = true;
    const reads = h.reads();
    for (const format of ['markdown', 'txt']) {
      h.$('[data-export-format="' + format + '"]').click();
      assert(!h.$(warningSelector), 'Text-only format shows an image-read warning: ' + format);
      h.$('[data-export-settings-target="content"]').click();
      assert(h.$('[data-export-toggle="mediaAttachments"]').checked, 'Format switch silently disabled media descriptions');
      assert(!h.$(warningSelector), 'Settings revived a text-format image warning');
      h.$('[data-export-settings-back]').click();
      assert(!h.$('[data-export-full-preview]').disabled, 'Text preview waits for image data it does not use');
    }
    h.$('[data-export-format="pdf"]').click();
    assert(h.$(warningSelector) && !h.$(warningSelector).open, 'Returning PDF warning inherited retired expansion');
    assert(h.reads() === reads, 'Format switches reread the conversation');
  });

  await scenario('batch warning survives unrelated conversation navigation but resets for a different basket or mode', async h => {
    h.$(warningSelector).open = true;
    h.select('favorites', ['disclosure-one']); await waitFor(() => h.$(warningSelector));
    assert(!h.$(warningSelector).open, 'Batch inherited current-conversation expansion');
    const details = h.$(warningSelector); details.open = true;
    h.update({ snapshot: snapshotFor('disclosure-two') }); await h.progress();
    assert(h.$(warningSelector) === details && details.open, 'Unrelated current conversation collapsed batch warning');
    h.select('favorites', ['disclosure-two']); await waitFor(() => h.$(warningSelector));
    assert(!h.$(warningSelector).open, 'Changed basket inherited expansion');
  });

  await scenario('missing-bookmark disclosure keeps manual state through refresh and resets for new missing items', async h => {
    h.select('bookmarks', ['first']); await waitFor(() => h.$(selectionSelector));
    const details = h.$(selectionSelector), summary = details.querySelector('summary');
    summary.focus(); await space(); h.update(); await h.progress();
    assert(h.$(selectionSelector) === details && details.open, 'Missing bookmark explanation collapsed');
    assert(document.activeElement === summary, 'Missing bookmark summary lost focus');
    summary.click(); h.update(); assert(!details.open, 'Missing bookmark manual collapse was reversed');
    details.open = true;
    h.select('bookmarks', ['second']); await waitFor(() => h.$(selectionSelector)?.textContent.includes('Second missing'));
    assert(!h.$(selectionSelector).open, 'New missing selection inherited expansion');
  });
}
