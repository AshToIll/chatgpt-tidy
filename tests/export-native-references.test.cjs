const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
// 只使用合成引用和公开示例地址，不复制真实会话、账号或签名图片链接。
// 回归重点：标题/链接来自同一来源对象；内部编号不是读者可见的引用或图片说明。
const START = '\uE200', SEP = '\uE202', END = '\uE201';
const token = (kind, ...parts) => START + kind + SEP + parts.join(SEP) + END;
const cite = (...ids) => token('cite', ...ids);
const image = id => token('i', id);
const docs = 'https://docs.example.test/guide';
const repo = 'https://code.example.test/project';
const canonical = value => JSON.parse(JSON.stringify(value));

function runtime() {
  const context = vm.createContext({ URL, TextEncoder, TextDecoder, console });
  for (const file of [
    'src/platform/chatgpt/native-message-references.js',
    'src/platform/chatgpt/native-message-content.js',
    'src/platform/chatgpt/native-message-process.js',
    'src/features/export/engine/normalize.js',
  ]) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  return context;
}

function message(text, metadata = {}) {
  return {
    id: 'synthetic-message', author: { role: 'assistant' },
    content: { content_type: 'text', parts: [text] }, metadata,
  };
}

function decode(context, value) {
  const warnings = new Set(), resources = [], imageReferences = new Map();
  const blocks = context.TidyChatgptNativeMessageContent.contentBlocks(
    value, warnings, resources, 'synthetic-message', imageReferences,
  );
  return { blocks: canonical(blocks), resources: canonical(resources), warnings: [...warnings], imageReferences };
}

function reference(id = 'turn12view0', title = 'Example documentation', url = docs) {
  return { ref_id: id, title, url };
}

function sourcePairs(sources) {
  return canonical(sources).map(({ title, url }) => ({ title, url }));
}

function blockText(blocks) {
  return blocks.map(block => {
    if (block.type === 'table') return [block.headers, ...block.rows].flat().join('\n');
    if (block.items) return block.items.join('\n');
    return block.text || block.code || block.alt || '';
  }).join('\n');
}

test('source extraction expands every item and never zips titles against safe_urls order', () => {
  const c = runtime();
  const input = {
    safe_urls: [repo, docs],
    items: [
      { title: 'Example documentation', url: docs },
      { title: 'Project repository', url: repo },
    ],
  };
  const before = JSON.stringify(input);
  assert.deepEqual(sourcePairs(c.TidyChatgptNativeMessageReferences.sourcesFromReference(input)), [
    { title: 'Example documentation', url: docs },
    { title: 'Project repository', url: repo },
  ]);
  assert.equal(JSON.stringify(input), before, 'Reading references must not mutate the source snapshot');
});

test('nested metadata items retain their own title and URL pairs', () => {
  const c = runtime();
  const result = c.TidyChatgptNativeMessageProcess.finalSources(message('', {
    content_references: [{
      title: 'Unrelated group label',
      metadata: {
        safe_urls: [repo, docs],
        items: [{ title: 'Example documentation', url: docs }, { title: 'Project repository', url: repo }],
      },
    }],
  }));
  assert.deepEqual(sourcePairs(result), [
    { title: 'Example documentation', url: docs },
    { title: 'Project repository', url: repo },
  ]);
});

test('safe URL-only fallbacks do not borrow a group title or another item title', () => {
  const c = runtime();
  const result = c.TidyChatgptNativeMessageReferences.sourcesFromReference({
    title: 'Group label is not a document title', safe_urls: [docs, repo],
  });
  assert.equal(result.length, 2);
  assert.ok(result.every(source => source.title === source.url));
});

test('a named atomic source outranks an earlier URL-only fallback without duplicate sources', () => {
  const c = runtime();
  const result = c.TidyChatgptNativeMessageProcess.finalSources(message('', {
    citations: [{ safe_urls: [docs, repo] }],
    content_references: [{ items: [
      { title: 'Example documentation', url: docs },
      { title: 'Project repository', url: repo },
    ] }],
  }));
  assert.deepEqual(sourcePairs(result), [
    { title: 'Example documentation', url: docs },
    { title: 'Project repository', url: repo },
  ]);
});

test('source URLs reject unsupported schemes and embedded credentials', () => {
  const c = runtime(), api = c.TidyChatgptNativeMessageReferences;
  for (const url of ['javascript:alert(1)', 'data:text/html,bad', 'file:///private/file', '//example.test/path', 'https://user:password@example.test/private']) {
    assert.equal(api.publicUrl(url), '', url);
    assert.equal(api.sourcesFromReference({ title: 'Unsafe', url }).length, 0, url);
  }
  assert.equal(api.publicUrl(docs), docs);
  assert.equal(api.publicUrl('http://docs.example.test/guide'), 'http://docs.example.test/guide');
});

test('empty and malformed reference collections do not create object-string titles', () => {
  const c = runtime();
  for (const metadata of [{}, { citations: null }, { citations: {} }, { content_references: 'not-an-array' }]) {
    assert.deepEqual(sourcePairs(c.TidyChatgptNativeMessageProcess.finalSources(message('', metadata))), []);
  }
  const result = c.TidyChatgptNativeMessageProcess.finalSources(message('', {
    content_references: [null, false, 42, { items: [null, {}] }, { safe_urls: [null, 'javascript:bad'] }],
  }));
  assert.deepEqual(sourcePairs(result), []);
});

test('flat reference identities resolve web citations to readable clickable links', () => {
  const c = runtime();
  const result = decode(c, message('Before ' + cite('turn12view0') + ' after', {
    content_references: [reference()],
  }));
  assert.equal(result.blocks[0].text, 'Before [Example documentation](' + docs + ') after');
  assert.doesNotMatch(blockText(result.blocks), /turn12view0|File citation|[\uE200\uE201\uE202]/);
});

test('structured refs identities resolve all cited sources and keep citation order', () => {
  const c = runtime();
  const unresolved = decode(c, message(cite('turn12view1', 'turn12view0')));
  const actual = decode(c, message('References ' + cite('turn12view1', 'turn12view0'), {
    content_references: [{
      items: [
        { title: 'Example documentation', url: docs, refs: [{ turn_index: 12, ref_type: 'view', ref_index: 0 }] },
        { title: 'Project repository', url: repo, refs: [{ turn_index: 12, ref_type: 'view', ref_index: 1 }] },
      ],
    }],
  }));
  const text = blockText(actual.blocks);
  assert.ok(text.includes('[Example documentation](' + docs + ')'));
  assert.ok(text.includes('[Project repository](' + repo + ')'));
  assert.ok(text.indexOf(repo) < text.indexOf(docs), 'Citation order follows explicit token identities, not items order');
  assert.doesNotMatch(text, /turn12view[01]|File citation|[\uE200\uE201\uE202]/);
  assert.doesNotMatch(blockText(unresolved.blocks), /turn12view[01]/, 'Unknown IDs are omitted rather than printed');
});

test('matched_text binds a citation group only to its own recorded sources', () => {
  const c = runtime(), marker = cite('turn12view0');
  const result = decode(c, message('Exact ' + marker, {
    content_references: [
      { matched_text: marker, items: [{ title: 'Example documentation', url: docs }] },
      { matched_text: cite('turn12view1'), items: [{ title: 'Project repository', url: repo }] },
    ],
  }));
  assert.equal(blockText(result.blocks), 'Exact [Example documentation](' + docs + ')');
  assert.doesNotMatch(blockText(result.blocks), /Project repository/);
});

test('an identity assigned conflicting URLs is not guessed by item order', () => {
  const c = runtime();
  for (const items of [
    [reference('turn12view0', 'First candidate', docs), reference('turn12view0', 'Other candidate', repo)],
    [reference('turn12view0', 'Other candidate', repo), reference('turn12view0', 'First candidate', docs)],
  ]) {
    const result = decode(c, message('Before ' + cite('turn12view0') + ' after', { citations: items }));
    const text = blockText(result.blocks);
    assert.match(text, /Before/); assert.match(text, /after/);
    assert.doesNotMatch(text, /First candidate|Other candidate|turn12view0|https:|[\uE200\uE201\uE202]/);
  }
});

test('missing citations remove only the markers, preserving nearby prose', () => {
  const c = runtime();
  const value = 'Beginning ' + cite('turn99view0', 'turn99search1') + ' middle ' + token('filecite', 'turn99file0') + ' end.';
  const result = decode(c, message(value));
  assert.match(blockText(result.blocks), /Beginning/);
  assert.match(blockText(result.blocks), /middle/);
  assert.match(blockText(result.blocks), /end\./);
  assert.doesNotMatch(blockText(result.blocks), /turn99|File citation|[\uE200\uE201\uE202]/);
});

test('explicit file metadata gives a readable filename without raw locator text', () => {
  const c = runtime();
  const result = decode(c, message('See ' + token('filecite', 'turn12file0') + '.', {
    content_references: [{ type: 'file', ref_id: 'turn12file0', file_name: 'design-notes.pdf' }],
  }));
  assert.match(blockText(result.blocks), /design-notes\.pdf/);
  assert.doesNotMatch(blockText(result.blocks), /turn12file0|[\uE200\uE201\uE202]/);
});

test('URL citation tokens produce safe Markdown links and escape bracketed labels', () => {
  const c = runtime();
  const result = decode(c, message('Read ' + token('url', 'Guide [stable]', docs)));
  assert.equal(blockText(result.blocks), 'Read [Guide \\[stable\\]](' + docs + ')');
  for (const url of ['javascript:alert(1)', 'data:text/html,bad', 'file:///private/file', 'https://user:password@example.test/private']) {
    const unsafe = blockText(decode(c, message('Before ' + token('url', 'Unsafe', url) + ' after')).blocks);
    assert.match(unsafe, /Before/); assert.match(unsafe, /after/);
    assert.doesNotMatch(unsafe, /javascript:|data:text|file:|password|[\uE200\uE201\uE202]/);
  }
});

test('citation replacement preserves paragraph, heading, list, table, and quote boundaries', () => {
  const c = runtime(), marker = cite('turn12view0');
  const input = [
    '# Heading ' + marker, '',
    'Paragraph ' + marker, '',
    '- Unordered ' + marker, '',
    '1. Ordered ' + marker, '',
    '> Quoted ' + marker, '',
    '| Column ' + marker + ' | Value |',
    '| --- | --- |',
    '| Row | Table ' + marker + ' |',
  ].join('\n');
  const result = decode(c, message(input, { citations: [reference()] }));
  assert.deepEqual(result.blocks.map(block => block.type), [
    'heading', 'paragraph', 'unordered-list', 'ordered-list', 'blockquote', 'table',
  ]);
  for (const block of result.blocks) {
    assert.ok(blockText([block]).includes('[Example documentation](' + docs + ')'), block.type);
  }
  assert.doesNotMatch(blockText(result.blocks), /turn12view0|File citation|[\uE200\uE201\uE202]/);
});

test('fenced code and inline code preserve literal markers instead of treating examples as citations', () => {
  const c = runtime(), marker = cite('turn12view0'), imageMarker = image('turn12image0');
  const input = [
    'Literal inline: \x60' + marker + '\x60 and \x60' + imageMarker + '\x60.',
    '', '\x60\x60\x60text', marker, imageMarker, '\x60\x60\x60', '',
    'Real citation: ' + marker,
  ].join('\n');
  const result = decode(c, message(input, { citations: [reference()] }));
  assert.ok(result.blocks[0].text.includes(marker));
  assert.ok(result.blocks[0].text.includes(imageMarker));
  const code = result.blocks.find(block => block.type === 'code');
  assert.equal(code.code, marker + '\n' + imageMarker);
  assert.ok(result.blocks.at(-1).text.includes('[Example documentation](' + docs + ')'));
  assert.equal(result.resources.length, 0, 'A code sample of an image token must not request an image');
});

test('native code messages remain byte-for-byte literal even with citation metadata', () => {
  const c = runtime(), literal = cite('turn12view0') + '\n' + image('turn12image0');
  const value = message(literal, { citations: [reference()] });
  value.content.content_type = 'code';
  value.content.language = 'text';
  const result = decode(c, value);
  assert.deepEqual(result.blocks, [{ type: 'code', language: 'text', code: literal }]);
  assert.equal(result.resources.length, 0);
});

test('known native image tokens become ordered image blocks with readable metadata', () => {
  const c = runtime(), marker = image('turn12image0');
  const value = message('Before\n\n' + marker + '\n\nAfter', {
    content_references: [{
      ref_id: 'turn12image0', image_url: 'https://images.example.test/plot.png', caption: 'Trend plot',
    }],
  });
  const before = JSON.stringify(value), result = decode(c, value);
  assert.deepEqual(result.blocks.map(block => block.type), ['paragraph', 'image', 'paragraph']);
  assert.equal(result.blocks[1].alt, 'Trend plot');
  assert.equal(result.resources.length, 1);
  assert.equal(result.resources[0].src, 'https://images.example.test/plot.png');
  assert.equal(result.resources[0].alt, 'Trend plot');
  assert.equal(result.resources[0].id, result.blocks[1].resourceId);
  assert.doesNotMatch(JSON.stringify(result.blocks) + JSON.stringify(result.resources), /turn12image0|[\uE200\uE201\uE202]/);
  assert.equal(JSON.stringify(value), before);
});

test('matched_text image metadata resolves only the matching image token', () => {
  const c = runtime(), marker = image('turn12image0');
  const result = decode(c, message(marker, {
    content_references: [{
      matched_text: marker, image_url: 'https://images.example.test/plot.png', alt: 'Matched diagram',
    }],
  }));
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].type, 'image');
  assert.equal(result.blocks[0].alt, 'Matched diagram');
  assert.equal(result.resources[0].src, 'https://images.example.test/plot.png');
});

test('unknown image tokens become an empty-alt media placeholder, never a paragraph of IDs', () => {
  const c = runtime();
  const result = decode(c, message('Before ' + image('turn99image0') + ' after'));
  const block = result.blocks.find(value => value.type === 'image');
  assert.ok(block);
  assert.equal(block.alt, '');
  const resource = result.resources.find(value => value.id === block.resourceId);
  assert.ok(resource);
  assert.equal(resource.src, '');
  assert.match(blockText(result.blocks), /Before/);
  assert.match(blockText(result.blocks), /after/);
  assert.doesNotMatch(JSON.stringify(result.blocks) + JSON.stringify(result.resources), /turn99image0|iturn|[\uE200\uE201\uE202]/);
});

test('turning off media removes native image placeholders and their resources without losing prose', () => {
  const c = runtime();
  const result = decode(c, message('Before ' + image('turn99image0') + ' after'));
  const conversation = {
    id: 'synthetic-conversation', title: 'Synthetic media switch',
    resources: result.resources,
    messages: [{
      id: 'synthetic-message', role: 'assistant', messageNumber: 1, timestamp: null,
      segments: [{ type: 'content', sourceMessageId: 'synthetic-message', timestamp: null, blocks: result.blocks }],
    }],
  };
  const visible = c.TidyExport.projectConversation(conversation, { mediaAttachments: true });
  const hidden = c.TidyExport.projectConversation(conversation, { mediaAttachments: false });
  assert.ok(visible.messages[0].segments[0].blocks.some(block => block.type === 'image'));
  assert.ok(visible.resources.length > 0);
  assert.ok(hidden.messages[0].segments[0].blocks.every(block => block.type !== 'image'));
  assert.equal(hidden.resources.length, 0);
  assert.match(blockText(hidden.messages[0].segments[0].blocks), /Before/);
  assert.match(blockText(hidden.messages[0].segments[0].blocks), /after/);
  assert.doesNotMatch(JSON.stringify(hidden), /turn99image0|iturn/);
  assert.ok(conversation.resources.length > 0, 'Projection does not mutate original media ownership');
});

test('unsafe image metadata cannot turn a native marker into a fetchable arbitrary scheme', () => {
  const c = runtime();
  for (const image_url of ['javascript:alert(1)', 'data:text/html,bad', 'file:///private/file', 'https://user:password@example.test/private']) {
    const result = decode(c, message(image('turn12image0'), {
      content_references: [{ ref_id: 'turn12image0', image_url, caption: 'Diagram' }],
    }));
    assert.ok(result.blocks.some(block => block.type === 'image'));
    assert.ok(result.resources.every(resource => !resource.src), image_url);
    assert.doesNotMatch(JSON.stringify(result), /javascript:|data:text|file:\/\/|password/);
  }
});

test('multiple native image markers have unique resource ownership and keep surrounding order', () => {
  const c = runtime();
  const result = decode(c, message(
    'First ' + image('turn12image0') + ' middle ' + image('turn12image1') + ' last',
    { content_references: [
      { ref_id: 'turn12image0', image_url: 'https://images.example.test/first.png', caption: 'First image' },
      { ref_id: 'turn12image1', image_url: 'https://images.example.test/second.png', caption: 'Second image' },
    ] },
  ));
  assert.deepEqual(result.blocks.map(block => block.type), ['paragraph', 'image', 'paragraph', 'image', 'paragraph']);
  assert.equal(new Set(result.resources.map(resource => resource.id)).size, 2);
  assert.deepEqual(result.blocks.filter(block => block.type === 'image').map(block => block.alt), ['First image', 'Second image']);
  assert.equal(result.blocks[0].text.trim(), 'First');
  assert.equal(result.blocks[2].text.trim(), 'middle');
  assert.equal(result.blocks[4].text.trim(), 'last');
});

test('Markdown image syntax becomes canonical media instead of text that bypasses the media switch', () => {
  const c = runtime(), src = 'https://images.example.test/diagram.png';
  const result = decode(c, message('Before\n\n![Diagram caption](' + src + ')\n\nAfter'));
  assert.deepEqual(result.blocks.map(block => block.type), ['paragraph', 'image', 'paragraph']);
  assert.equal(result.blocks[1].alt, 'Diagram caption');
  const resource = result.resources.find(item => item.id === result.blocks[1].resourceId);
  assert.ok(resource);
  assert.equal(resource.src, src);
  assert.equal(resource.alt, 'Diagram caption');
  assert.doesNotMatch(blockText(result.blocks), /!\[|https:\/\/images/);
});

test('inline Markdown images split into media blocks without discarding surrounding text', () => {
  const c = runtime(), src = 'https://images.example.test/inline.png';
  const result = decode(c, message('Before ![Inline diagram](' + src + ') after.'));
  assert.deepEqual(result.blocks.map(block => block.type), ['paragraph', 'image', 'paragraph']);
  assert.equal(result.blocks[0].text.trim(), 'Before');
  assert.equal(result.blocks[1].alt, 'Inline diagram');
  assert.equal(result.blocks[2].text.trim(), 'after.');
  assert.equal(result.resources[0].src, src);
});

test('Markdown images in list text obey the same media contract and keep list prose', () => {
  const c = runtime(), src = 'https://images.example.test/list.png';
  const result = decode(c, message('- Before ![List diagram](' + src + ') after\n- Second item'));
  assert.ok(result.blocks.some(block => block.type === 'image'));
  assert.ok(result.blocks.some(block => block.type === 'unordered-list'));
  assert.match(blockText(result.blocks), /Before/);
  assert.match(blockText(result.blocks), /after/);
  assert.match(blockText(result.blocks), /Second item/);
  assert.doesNotMatch(blockText(result.blocks), /!\[|https:\/\/images/);
  assert.equal(result.resources.find(resource => resource.src === src)?.alt, 'List diagram');
});

test('media off removes normal Markdown images from every selected block and resource list', () => {
  const c = runtime(), src = 'https://images.example.test/example.png';
  for (const text of [
    'Before ![Diagram](' + src + ') after',
    '- Before ![Diagram](' + src + ') after\n- Keep item',
    '> Before ![Diagram](' + src + ') after',
  ]) {
    const result = decode(c, message(text));
    const conversation = {
      id: 'synthetic-images', title: 'Images',
      resources: result.resources,
      messages: [{
        id: 'synthetic-message', role: 'assistant', messageNumber: 1, timestamp: null,
        segments: [{ type: 'content', sourceMessageId: 'synthetic-message', timestamp: null, blocks: result.blocks }],
      }],
    };
    const projected = c.TidyExport.projectConversation(conversation, { mediaAttachments: false });
    const blocks = projected.messages[0].segments[0].blocks;
    assert.ok(blocks.every(block => block.type !== 'image'));
    assert.equal(projected.resources.length, 0);
    assert.match(blockText(blocks), /Before/);
    assert.match(blockText(blocks), /after/);
    assert.doesNotMatch(JSON.stringify(projected), /!\[|images\.example\.test/);
  }
});

test('literal Markdown image examples in fenced or inline code are not media resources', () => {
  const c = runtime(), literal = '![Example](https://images.example.test/not-fetched.png)';
  const result = decode(c, message([
    'Literal: \x60' + literal + '\x60', '',
    '\x60\x60\x60markdown', literal, '\x60\x60\x60', '',
    'Normal prose',
  ].join('\n')));
  assert.equal(result.resources.length, 0);
  assert.ok(result.blocks.every(block => block.type !== 'image'));
  assert.equal(result.blocks[0].text, 'Literal: \x60' + literal + '\x60');
  assert.equal(result.blocks.find(block => block.type === 'code').code, literal);
});

test('ordinary Markdown links remain ordinary links rather than image resources', () => {
  const c = runtime();
  const result = decode(c, message('Read [Project documentation](' + docs + ') and [the repository](' + repo + ').'));
  assert.equal(result.resources.length, 0);
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].text, 'Read [Project documentation](' + docs + ') and [the repository](' + repo + ').');
});

test('a linked Markdown image retains the outer clickable target as well as the inner image', () => {
  const c = runtime(), src = 'https://images.example.test/thumbnail.png';
  const result = decode(c, message('Before [![Thumbnail](' + src + ')](' + docs + ') after'));
  const imageBlock = result.blocks.find(block => block.type === 'image');
  assert.ok(imageBlock);
  assert.equal(result.resources.find(item => item.id === imageBlock.resourceId)?.src, src);
  assert.ok(JSON.stringify(result.blocks).includes(docs), 'The image link destination must not disappear');
  assert.match(blockText(result.blocks), /Before/);
  assert.match(blockText(result.blocks), /after/);
  assert.doesNotMatch(blockText(result.blocks), /!\[/);
});

test('inline code spans remain explicit literal code in headings, lists, table cells and quotes', () => {
  const c = runtime(), literal = '\x60' + cite('turn12view0') + '\x60';
  const text = [
    '# Heading ' + literal, '',
    '- List ' + literal, '',
    '> Quote ' + literal, '',
    '| Header | Content |',
    '| --- | --- |',
    '| Row | ' + literal + ' |',
  ].join('\n');
  const result = decode(c, message(text, { citations: [reference()] }));
  assert.deepEqual(result.blocks.map(block => block.type), ['heading', 'unordered-list', 'blockquote', 'table']);
  for (const block of result.blocks) assert.ok(blockText([block]).includes(literal), block.type);
  assert.equal(result.resources.length, 0);
});

test('Markdown image destinations with unsafe schemes become non-fetching placeholders', () => {
  const c = runtime();
  for (const url of ['javascript:alert(1)', 'data:text/html,bad', 'file:///private/file']) {
    const result = decode(c, message('Before ![Diagram](' + url + ') after'));
    assert.ok(result.blocks.some(block => block.type === 'image'));
    assert.ok(result.resources.every(resource => !resource.src), url);
    assert.match(blockText(result.blocks), /Before/);
    assert.match(blockText(result.blocks), /after/);
    assert.doesNotMatch(JSON.stringify(result), /javascript:|data:text|file:\/\/|!\[/);
  }
});

test('typed image wrappers with nested metadata create one real image, not an extra empty placeholder', () => {
  const c = runtime(), src = 'https://images.example.test/nested.png';
  const result = decode(c, message(image('turn12image0'), {
    content_references: [{
      type: 'image', ref_id: 'turn12image0',
      metadata: { image_url: src, caption: 'Nested diagram' },
    }],
  }));
  assert.deepEqual(result.blocks.map(block => block.type), ['image']);
  assert.equal(result.resources.length, 1);
  assert.equal(result.resources[0].src, src);
  assert.equal(result.blocks[0].alt, 'Nested diagram');
  assert.equal(result.resources[0].id, result.blocks[0].resourceId);
});

test('citation URLs and titles containing pipes cannot manufacture extra table cells', () => {
  const c = runtime(), url = 'https://docs.example.test/find?q=alpha|beta';
  const result = decode(c, message([
    '| Topic | Reference |',
    '| --- | --- |',
    '| Keep first cell | ' + cite('turn12view0') + ' |',
  ].join('\n'), { citations: [reference('turn12view0', 'Alpha | Beta', url)] }));
  assert.equal(result.blocks.length, 1);
  const table = result.blocks[0];
  assert.equal(table.type, 'table');
  assert.equal(table.headers.length, 2);
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].length, 2);
  assert.equal(table.rows[0][0], 'Keep first cell');
  assert.equal(table.rows[0][1], '[Alpha \\| Beta](https://docs.example.test/find?q=alpha\\|beta)');
  const final = c.TidyChatgptNativeMessageProcess.finalSources(message('', {
    citations: [reference('turn12view0', 'Alpha | Beta', url)],
  }));
  assert.equal(final[0].url, url, 'Canonical source URL is not changed just to escape Markdown table syntax');
});

test('four-space and tab-indented code preserve native markers, Markdown images, and ordinary links literally', () => {
  const c = runtime();
  const literals = [
    cite('turn12view0'),
    image('turn12image0'),
    '![Example](https://images.example.test/code-sample.png)',
    '[Documentation](' + docs + ')',
  ];
  for (const indent of ['    ', '\t']) {
    const result = decode(c, message(literals.map(line => indent + line).join('\n'), {
      citations: [reference()],
      content_references: [{
        ref_id: 'turn12image0', image_url: 'https://images.example.test/not-fetched.png', caption: 'Not decoded',
      }],
    }));
    assert.deepEqual(result.blocks, [{ type: 'code', language: '', code: literals.join('\n') }]);
    assert.equal(result.resources.length, 0);
  }
});

test('indented continuation lines inside an ordinary paragraph are not misclassified as a new code block', () => {
  const c = runtime();
  for (const indent of ['    ', '\t']) {
    const result = decode(c, message('Opening paragraph\n' + indent + 'continued ' + cite('turn12view0') + '\nClosing paragraph', {
      citations: [reference()],
    }));
    assert.deepEqual(result.blocks.map(block => block.type), ['paragraph']);
    assert.match(blockText(result.blocks), /Opening paragraph/);
    assert.match(blockText(result.blocks), /continued/);
    assert.match(blockText(result.blocks), /Closing paragraph/);
    assert.ok(blockText(result.blocks).includes('[Example documentation](' + docs + ')'));
    assert.doesNotMatch(blockText(result.blocks), /turn12view0|[\uE200\uE201\uE202]/);
  }
});

test('native thought summaries and details share reference decoding with unique ownership for repeated images', () => {
  const c = runtime(), marker = image('turn12image0'), citation = cite('turn12view0');
  const value = message('', {
    citations: [reference()],
    content_references: [{ ref_id: 'turn12image0', image_url: 'https://images.example.test/thought.png', caption: 'Process diagram' }],
  });
  value.create_time = 1700000000;
  value.content = {
    content_type: 'thoughts',
    thoughts: [
      { summary: 'First summary ' + marker + ' ' + citation, content: 'First detail ' + marker + ' ' + citation },
      { summary: 'Second summary ' + marker, content: 'Second detail ' + marker },
    ],
  };
  const resources = [], warnings = new Set();
  const segment = c.TidyChatgptNativeMessageProcess.processSegment(
    value, 'synthetic-thought', warnings, resources, new Map(),
  );
  assert.equal(segment.type, 'process');
  assert.equal(segment.category, 'reasoning');
  assert.equal(segment.phase, 'summary');
  const images = segment.blocks.filter(block => block.type === 'image');
  assert.equal(images.length, 4);
  assert.equal(resources.length, 4);
  assert.equal(new Set(resources.map(resource => resource.id)).size, 4);
  assert.equal(new Set(images.map(block => block.resourceId)).size, 4);
  for (const block of images) {
    const resource = resources.find(item => item.id === block.resourceId);
    assert.equal(resource.src, 'https://images.example.test/thought.png');
    assert.equal(block.alt, 'Process diagram');
  }
  assert.match(blockText(segment.blocks), /First summary/);
  assert.match(blockText(segment.blocks), /First detail/);
  assert.match(blockText(segment.blocks), /Second summary/);
  assert.match(blockText(segment.blocks), /Second detail/);
  assert.ok(blockText(segment.blocks).includes('[Example documentation](' + docs + ')'));
  assert.doesNotMatch(JSON.stringify(segment), /turn12image0|turn12view0|[\uE200\uE201\uE202]/);
});

test('unresolved citation-only blocks do not survive as empty visible content', () => {
  const c = runtime();
  for (const text of [
    cite('turn99view0'),
    token('filecite', 'turn99file0'),
    cite('turn99view0') + ' ' + token('filecite', 'turn99file0'),
    '# ' + cite('turn99view0'),
    '> ' + cite('turn99view0'),
  ]) {
    const result = decode(c, message(text));
    assert.deepEqual(result.blocks, [], JSON.stringify(text));
    assert.equal(result.resources.length, 0);
  }
});


test('deduplication across source segments upgrades only URL-only fallback titles', () => {
  const c = runtime();
  const values = c.TidyChatgptNativeMessageProcess.dedupeSources([
    { title: docs, url: docs, domain: 'docs.example.test' },
    { title: 'Explicit documentation', url: docs, domain: 'docs.example.test' },
    { title: 'Conflicting later title', url: docs, domain: 'docs.example.test' },
  ]);
  assert.deepEqual(sourcePairs(values), [{ title: 'Explicit documentation', url: docs }]);
});


test('long malformed Markdown image candidates stay literal within a bounded scan', () => {
  const c = runtime();
  c.longMalformedText = '!['.repeat(50000) + 'plain text';
  const actual = vm.runInContext('TidyChatgptNativeMessageReferences.createResolver({}).replace(longMalformedText, () => "IMAGE")', c, { timeout: 2000 });
  assert.equal(actual, c.longMalformedText);
});

test('Markdown image URL entities decode once while escaped ampersands remain literal', () => {
  const c = runtime();
  const result = decode(c, message('![A &amp; B](https://images.example.test/a.png?a=1&amp;b=2)\n\n![Literal](https://images.example.test/b.png?a=1\\&amp;b=2)'));
  assert.equal(result.resources[0].src, 'https://images.example.test/a.png?a=1&b=2');
  assert.equal(result.resources[0].alt, 'A & B');
  assert.equal(result.resources[1].src, 'https://images.example.test/b.png?a=1&amp;b=2');
});

test('file metadata wrappers preserve an explicitly named document without inventing a URL', () => {
  const c = runtime();
  const result = decode(c, message(token('filecite', 'turn12file0'), { content_references: [
    { type: 'file', ref_id: 'turn12file0', metadata: { name: 'design-notes.pdf' } },
  ] }));
  assert.equal(blockText(result.blocks), 'design-notes.pdf');
});


test('empty citation annotations never hide an exact known source regardless of collection order', () => {
  const marker = cite('turn12view0');
  for (const annotation of [{ matched_text: marker }, { ref_id: 'turn12view0' }, { matched_text: marker, ref_id: 'turn12view0' }]) {
    for (const reverse of [false, true]) {
      const c = runtime();
      const metadata = reverse ? { citations: [annotation], content_references: [reference()] }
        : { citations: [reference()], content_references: [annotation] };
      const result = decode(c, message('Before ' + marker + ' after', metadata));
      assert.equal(blockText(result.blocks), 'Before [Example documentation](' + docs + ') after');
    }
  }
});

test('partial image annotations retain the exact known image URL but conflicting URLs remain unresolved', () => {
  for (const reverse of [false, true]) {
    const known = { ref_id: 'turn12image0', image_url: 'https://images.example.test/actual.png', caption: 'Actual image' };
    const partial = { ref_id: 'turn12image0', type: 'image', caption: 'Actual image' };
    const c = runtime();
    const metadata = reverse ? { citations: [partial], content_references: [known] }
      : { citations: [known], content_references: [partial] };
    const result = decode(c, message(image('turn12image0'), metadata));
    assert.equal(result.resources.length, 1);
    assert.equal(result.resources[0].src, known.image_url);
  }
  const c = runtime();
  const result = decode(c, message(image('turn12image0'), { content_references: [
    { ref_id: 'turn12image0', image_url: 'https://images.example.test/one.png' },
    { ref_id: 'turn12image0', image_url: 'https://images.example.test/two.png' },
  ] }));
  assert.equal(result.resources.length, 1);
  assert.equal(result.resources[0].src, '');
});


test('inline citation order follows token identities even when the first source has no title', () => {
  const c = runtime();
  const result = decode(c, message(cite('turn12view0', 'turn12view1'), { content_references: [
    { ref_id: 'turn12view0', url: docs },
    { ref_id: 'turn12view1', title: 'Repository', url: repo },
  ] }));
  assert.equal(blockText(result.blocks), '[' + docs + '](' + docs + ') [Repository](' + repo + ')');
});


test('names-only matched text never shadows an exact web citation source', () => {
  const marker = cite('turn12view0');
  for (const annotation of [
    { matched_text: marker, title: 'Sources' },
    { matched_text: marker, ref_id: 'turn12view0', title: 'Sources' },
    { matched_text: marker, file_name: 'notes.pdf' },
  ]) {
    for (const reverse of [false, true]) {
      const c = runtime();
      const metadata = reverse ? { citations: [annotation], content_references: [reference()] }
        : { citations: [reference()], content_references: [annotation] };
      const result = decode(c, message(marker, metadata));
      assert.equal(blockText(result.blocks), '[Example documentation](' + docs + ')');
    }
  }
});

test('unrelated title conflicts cannot poison exact source identity before a URL arrives', () => {
  const marker = cite('turn12view0');
  for (const refs of [
    [{ ref_id: 'turn12view0', title: 'Sources' }, { ref_id: 'turn12view0', title: 'References' }, reference()],
    [reference(), { ref_id: 'turn12view0', title: 'Sources' }, { ref_id: 'turn12view0', title: 'References' }],
    [reference(), reference('turn12view0', 'Different explicit title', docs)],
  ]) {
    const c = runtime();
    const result = decode(c, message(marker, { content_references: refs }));
    assert.equal(blockText(result.blocks), '[Example documentation](' + docs + ')');
  }
});

test('actual conflicting matched-text targets stay unresolved even if a fallback identity is known', () => {
  const marker = cite('turn12view0');
  const c = runtime();
  const result = decode(c, message('Before ' + marker + ' after', {
    citations: [reference()], content_references: [
      { matched_text: marker, title: 'A', url: docs },
      { matched_text: marker, title: 'B', url: repo },
    ],
  }));
  assert.equal(blockText(result.blocks), 'Before  after');
});


test('caption-only matched images cannot shadow exact image URLs but keep captions when no URL exists', () => {
  const marker = image('turn12image0');
  for (const reverse of [false, true]) {
    const known = { ref_id: 'turn12image0', image_url: 'https://images.example.test/actual.png', caption: 'Actual image' };
    const caption = { matched_text: marker, type: 'image', caption: 'Caption placeholder' };
    const c = runtime();
    const metadata = reverse ? { citations: [caption], content_references: [known] }
      : { citations: [known], content_references: [caption] };
    const result = decode(c, message(marker, metadata));
    assert.equal(result.resources.length, 1);
    assert.equal(result.resources[0].src, known.image_url);
  }
  const c = runtime();
  const fallback = decode(c, message(marker, { content_references: [
    { matched_text: marker, type: 'image', caption: 'Caption placeholder' },
  ] }));
  assert.equal(fallback.resources[0].src, '');
  assert.equal(fallback.resources[0].alt, 'Caption placeholder');
  const conflict = decode(c, message(marker, { citations: [
    { ref_id: 'turn12image0', image_url: 'https://images.example.test/actual.png' },
  ], content_references: [
    { matched_text: marker, image_url: 'https://images.example.test/one.png' },
    { matched_text: marker, image_url: 'https://images.example.test/two.png' },
  ] }));
  assert.equal(conflict.resources[0].src, '');
});


test('native image captions containing linked Markdown expose the thumbnail, readable caption, and source', () => {
  const src = 'https://images.example.test/preview.png?a=1&b=2';
  const encoded = '[![Diagram &amp; pose](https://images.example.test/preview.png?a=1&amp;b=2)](' + docs + ')';
  for (const field of ['caption', 'alt', 'name']) {
    const c = runtime();
    const value = message(image('turn12image0'), { content_references: [
      { type: 'image', ref_id: 'turn12image0', [field]: encoded },
    ] });
    const original = JSON.stringify(value), result = decode(c, value);
    assert.equal(result.resources.length, 1);
    assert.equal(result.resources[0].src, src, field + ': URL belongs in the resource, not its name');
    assert.equal(result.resources[0].alt, 'Diagram & pose');
    assert.equal(result.resources[0].name, 'Diagram & pose');
    assert.equal(result.blocks[0].type, 'image');
    assert.equal(result.blocks[1].text, '[Diagram \\& pose](' + docs + ')');
    assert.doesNotMatch(result.resources[0].alt, /!\[|https:/);
    assert.equal(JSON.stringify(value), original, 'Decoding never mutates native metadata');
  }
});

test('typed image content parts share caption decoding with image references', () => {
  const c = runtime(), src = 'https://images.example.test/preview.png';
  const value = message('');
  value.content.parts = [{ content_type: 'image', alt: '[![Diagram](' + src + ')](' + docs + ')' }];
  const result = decode(c, value);
  assert.equal(result.resources[0].src, src);
  assert.equal(result.blocks[0].alt, 'Diagram');
  assert.ok(result.blocks.some(block => block.type === 'paragraph' && block.text === '[Diagram](' + docs + ')'));
  assert.equal(result.warnings.length, 0);
});

test('explicit image URLs keep priority while Markdown captions supply readable labels and sources', () => {
  const c = runtime(), src = 'https://images.example.test/original.png';
  const result = decode(c, message(image('turn12image0'), { content_references: [
    { type: 'image', ref_id: 'turn12image0', image_url: src,
      alt: 'Accessible description', caption: '[![Caption](https://images.example.test/thumb.png)](' + docs + ')' },
  ] }));
  assert.equal(result.resources[0].src, src);
  assert.equal(result.resources[0].alt, 'Accessible description');
  assert.equal(result.blocks[1].text, '[Accessible description](' + docs + ')');
});

test('native caption parsing never invents image URLs from prose or permits unsafe image/source destinations', () => {
  const c = runtime();
  const plain = decode(c, message(image('turn12image0'), { content_references: [
    { type: 'image', ref_id: 'turn12image0', caption: 'See https://example.test/page for a diagram' },
  ] }));
  assert.equal(plain.resources[0].src, '');
  assert.equal(plain.resources[0].alt, 'See https://example.test/page for a diagram');
  const unsafe = decode(c, message(image('turn12image0'), { content_references: [
    { type: 'image', ref_id: 'turn12image0', caption: '[![Diagram](javascript:alert(1))](file:///private)' },
  ] }));
  assert.equal(unsafe.resources[0].src, '');
  assert.equal(unsafe.resources[0].alt, 'Diagram');
  assert.equal(unsafe.blocks.length, 1);
});

test('metadata Markdown image placeholders remain controlled by the media switch', () => {
  const c = runtime(), result = decode(c, message(image('turn12image0'), { content_references: [
    { type: 'image', ref_id: 'turn12image0', caption: '![Diagram](https://images.example.test/diagram.png)' },
  ] }));
  assert.equal(result.resources[0].src, 'https://images.example.test/diagram.png');
  assert.equal(result.resources[0].alt, 'Diagram');
  assert.equal(result.blocks.length, 1);
  const doc = c.TidyExport.normalizeConversation({
    id: 'native-caption', title: 'Caption', resources: result.resources,
    messages: [{ id: 'one', messageNumber: 1, role: 'assistant', segments: [{ type: 'content', sourceMessageId: 'one', blocks: result.blocks }] }],
  });
  const hidden = c.TidyExport.projectConversation(doc, { mediaAttachments: false });
  assert.equal(hidden.resources.length, 0);
  assert.ok(hidden.messages.every(message => message.segments.every(segment =>
    segment.blocks.every(block => block.type !== 'image'))));
});
