const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const copy = value => JSON.parse(JSON.stringify(value));
const fileLink = '[Read the report](sandbox:/mnt/data/generated-report.txt)';
// Only synthetic source data belongs in tests; the private Network response is
// checked separately and never becomes a repository fixture.
function runtime() {
  const c = vm.createContext({ URL, TextEncoder, TextDecoder });
  for (const name of ['active-branch', 'native-message-references', 'native-message-content',
    'native-message-process', 'conversation-projection']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'src/platform/chatgpt/' + name + '.js'), 'utf8'), c);
  }
  vm.runInContext(fs.readFileSync(path.join(root, 'src/features/export/engine/normalize.js'), 'utf8'), c);
  return c;
}
function message(body = fileLink, extra = {}) {
  return { id: 'final', author: { role: 'assistant' }, recipient: 'all', channel: 'final',
    create_time: 1900000000, metadata: {}, content: { content_type: 'text', parts: [body] }, ...extra };
}
function payload(final = message()) {
  return { id: 'attachments', title: 'Synthetic attachment delivery', current_node: 'final', mapping: {
    user: { id: 'user', parent: null, message: message('Please prepare a report', {
      id: 'user', author: { role: 'user' }, recipient: undefined, channel: undefined,
    }) },
    final: { id: 'final', parent: 'user', message: final },
  } };
}
function project(input = payload(), options) {
  const c = runtime(), references = new Map();
  const document = c.TidyChatgptConversationProjection.projectConversation(input, input.id, {}, '', references);
  return { c, document: copy(document), conversation: copy(options
    ? c.TidyExport.projectConversation(document.conversation, options) : document.conversation), references };
}
const allBlocks = conversation => conversation.messages.flatMap(m => m.segments.flatMap(s => s.blocks || []));
const attachments = conversation => allBlocks(conversation).filter(b => b.type === 'attachment');
const plainText = blocks => blocks.map(b => b.text || b.code || b.items?.join('\n')
  || (b.rows ? [b.headers, ...b.rows].flat().join('\n') : '')).join('\n');

test('explicit final delivery preserves the real basename separately from the visible link label', () => {
  const original = payload(), before = JSON.stringify(original);
  const { conversation, references } = project(original);
  assert.deepEqual(attachments(conversation), [{ type: 'attachment', resourceId: 'final:attachment:1', label: 'Read the report' }]);
  assert.deepEqual(conversation.resources, [{ id: 'final:attachment:1', type: 'attachment', name: 'generated-report.txt',
    mimeType: '', sizeBytes: null, src: '', alt: '' }]);
  assert.equal(references.size, 0, 'A sandbox path is not an authenticated image handle');
  assert.equal(JSON.stringify(original), before);
  assert.doesNotMatch(JSON.stringify(conversation), /sandbox:|mnt\/data/);
});

test('native decoding is opt-in and exact final assistant recipient/channel evidence is required', () => {
  const c = runtime(), resources = [];
  c.TidyChatgptNativeMessageContent.contentBlocks(message(), new Set(), resources, 'final', new Map());
  assert.equal(resources.length, 0, 'Direct process callers default to no final attachment promotion');
  for (const extra of [
    { author: { role: 'user' } }, { author: { role: 'tool', name: 'python' } },
    { recipient: 'python' }, { recipient: undefined }, { channel: 'analysis' }, { channel: 'commentary' }, { channel: undefined },
  ]) {
    const input = payload(message(fileLink, extra));
    assert.equal(attachments(project(input).conversation).length, 0, JSON.stringify(extra));
  }
});

test('media controls final attachments independently of tool process, without dropping surrounding prose', () => {
  for (const toolProcess of [false, true]) for (const mediaAttachments of [false, true]) {
    const { conversation } = project(payload(message('Before ' + fileLink + ' after.')), { toolProcess, mediaAttachments });
    assert.equal(attachments(conversation).length, mediaAttachments ? 1 : 0);
    assert.equal(conversation.resources.length, mediaAttachments ? 1 : 0);
    assert.match(plainText(allBlocks(conversation)), /Before[\s\S]*after\./);
    assert.doesNotMatch(JSON.stringify(conversation), /sandbox:/);
  }
});

test('paragraph attachments keep their position and non-media public links remain untouched', () => {
  const external = '[Public source](https://example.test/download.zip)';
  const { conversation } = project(payload(message('Before ' + fileLink + ' between ' + external + ' after.')));
  const blocks = conversation.messages[1].segments[0].blocks;
  assert.deepEqual(blocks.map(b => b.type), ['paragraph', 'attachment', 'paragraph']);
  assert.equal(blocks[0].text, 'Before');
  assert.equal(blocks[2].text, 'between ' + external + ' after.');
});

test('headings, lists, quotes and tables keep their text and place attachment blocks after the host', () => {
  const bodies = [
    '# Before ' + fileLink + ' after',
    '- Before ' + fileLink + ' after\n- Other item',
    '1. Before ' + fileLink + ' after\n2. Other item',
    '> Before ' + fileLink + ' after',
    '| Name | File |\n| --- | --- |\n| Entry | Before ' + fileLink + ' after |',
  ];
  for (const body of bodies) {
    const { conversation } = project(payload(message(body)));
    const blocks = conversation.messages[1].segments[0].blocks;
    assert.equal(blocks.at(-1).type, 'attachment', body);
    assert.equal(attachments(conversation).length, 1);
    assert.match(plainText(blocks), /Before\s+after/);
    assert.doesNotMatch(plainText(blocks), /sandbox:/);
  }
});

test('inline, fenced, indented and native code remain literal rather than file deliveries', () => {
  for (const body of ['Use \x60' + fileLink + '\x60 literally.', 'Use \x60\x60' + fileLink + '\x60\x60 literally.',
    '\x60\x60\x60md\n' + fileLink + '\n\x60\x60\x60', '~~~md\n' + fileLink + '\n~~~',
    '    ' + fileLink, '\t' + fileLink, '- Code \x60' + fileLink + '\x60',
    '| Code |\n| --- |\n| \x60' + fileLink + '\x60 |']) {
    const { conversation } = project(payload(message(body)));
    assert.equal(attachments(conversation).length, 0, body);
    assert.match(plainText(allBlocks(conversation)), /sandbox:\/mnt\/data\/generated-report\.txt/);
  }
  const { conversation } = project(payload(message('', { content: { content_type: 'code', language: 'text', parts: [fileLink] } })));
  assert.equal(attachments(conversation).length, 0);
  assert.equal(conversation.messages[1].segments[0].blocks[0].code, fileLink);
});

test('Markdown images and linked Markdown images never turn into attachments', () => {
  for (const body of [
    '![Diagram](sandbox:/mnt/data/diagram.png)',
    '![Diagram](https://images.example.test/diagram.png)',
    '[![Diagram](https://images.example.test/diagram.png)](sandbox:/mnt/data/diagram.png)',
  ]) {
    const { conversation } = project(payload(message(body)));
    assert.equal(attachments(conversation).length, 0, body);
    assert.equal(conversation.resources.filter(r => r.type === 'image').length, 1);
  }
});

test('bare paths, non-sandbox URLs and unsupported or incomplete destinations remain ordinary source text', () => {
  for (const body of [
    'sandbox:/mnt/data/report.txt', '/mnt/data/report.txt', 'file.docx',
    '[Public](https://example.test/report.txt)', '[Relative](report.txt)',
    '[Public](https://example.test/ "[Download](sandbox:/mnt/data/report.txt)")',
    '[Public](https://example.test/[Download](sandbox:/mnt/data/report.txt))',
    '[Wrong root](sandbox:/etc/report.txt)', '[Host](sandbox://mnt/data/report.txt)',
    '[Empty](sandbox:/mnt/data/)', '[Dir](sandbox:/mnt/data/reports/)',
    '[Blank](sandbox:/mnt/data/%20)', '[Unicode blank](sandbox:/mnt/data/%E3%80%80)',
    '[Parent](sandbox:/mnt/data/../report.txt)', '[Dot](sandbox:/mnt/data/./report.txt)',
    '[Encoded parent](sandbox:/mnt/data/%2e%2e/report.txt)', '[Slash](sandbox:/mnt/data/%2freport.txt)',
    '[Backslash](sandbox:/mnt/data/%5Creport.txt)', '[Bad escape](sandbox:/mnt/data/%XX.txt)',
    '[Query](sandbox:/mnt/data/report.txt?download=1)', '[Fragment](sandbox:/mnt/data/report.txt#part)',
    '[Incomplete](sandbox:/mnt/data/report.txt', '[Unclosed](sandbox:/mnt/data/(report.txt)',
  ]) {
    const { conversation } = project(payload(message(body)));
    assert.equal(attachments(conversation).length, 0, body);
    assert.equal(conversation.messages[1].segments[0].blocks[0].text, body);
  }
});

test('explicit file links decode filenames and visible labels without inferring MIME or requiring an extension', () => {
  const cases = [
    ['[Download](sandbox:/mnt/data/reports/report%20one.txt)', 'report one.txt', 'Download'],
    ['[Download](<sandbox:/mnt/data/report one.txt>)', 'report one.txt', 'Download'],
    ['[Download](sandbox:/mnt/data/report(1).txt "Title")', 'report(1).txt', 'Download'],
    ['[Download](sandbox:/mnt/data/report\\(1\\).txt)', 'report(1).txt', 'Download'],
    ['[Read \\[report\\]](sandbox:/mnt/data/report.txt)', 'report.txt', 'Read [report]'],
    ['[**Read** &amp; save](sandbox:/mnt/data/report%23.txt)', 'report#.txt', 'Read & save'],
    ['[Read](sandbox:/mnt/data/report&amp;notes.txt)', 'report&notes.txt', 'Read'],
    ['[Read \x60report\x60](sandbox:/mnt/data/report.txt)', 'report.txt', 'Read report'],
    ['\\![Download](sandbox:/mnt/data/report.txt)', 'report.txt', 'Download'],
    ['[Download](sandbox:/mnt/data/output)', 'output', 'Download'],
    ['[](sandbox:/mnt/data/report.txt)', 'report.txt', ''],
  ];
  for (const [body, name, label] of cases) {
    const { conversation } = project(payload(message(body)));
    assert.equal(conversation.resources[0]?.name, name, body);
    assert.equal(attachments(conversation)[0]?.label, label, body);
    assert.equal(conversation.resources[0]?.mimeType, '');
  }
});

test('tool requests/results and thinking text are never promoted to final attachments', () => {
  const input = payload(message('The final answer has no delivered file.'));
  input.mapping.call = { id: 'call', parent: 'user', message: message(fileLink, { id: 'call', channel: 'commentary', recipient: 'python' }) };
  input.mapping.tool = { id: 'tool', parent: 'call', message: message(fileLink, { id: 'tool',
    author: { role: 'tool', name: 'python' }, channel: 'commentary' }) };
  input.mapping.final.parent = 'tool';
  for (const toolProcess of [false, true]) {
    const { conversation } = project(input, { toolProcess, mediaAttachments: true });
    assert.equal(attachments(conversation).length, 0);
    assert.equal(JSON.stringify(conversation).includes('sandbox:/'), toolProcess);
  }
  for (const metadata of [{ reasoning_status: 'is_reasoning' }, { is_thinking_preamble_message: true }]) {
    assert.equal(attachments(project(payload(message(fileLink, { metadata }))).conversation).length, 0);
  }
});

test('hidden and abandoned final deliveries remain excluded by the canonical conversation owner', () => {
  const input = payload(message('Visible final response'));
  input.mapping.hidden = { id: 'hidden', parent: 'user', message: message(fileLink, {
    id: 'hidden', metadata: { is_visually_hidden_from_conversation: true },
  }) };
  input.mapping.final.parent = 'hidden';
  input.mapping.abandoned = { id: 'abandoned', parent: 'user', message: message(fileLink, { id: 'abandoned' }) };
  assert.equal(attachments(project(input).conversation).length, 0);
});

test('multiple attachments, parts and images retain unique ownership without crossing media sentinel collisions', () => {
  const literal = '\u0000tidy-media:0\u0000';
  const input = payload(message('', { content: { content_type: 'text', parts: [
    literal + '\n\n' + fileLink + '\n\n![Image](https://example.test/picture.png)',
    '[Second](sandbox:/mnt/data/second.pdf)',
  ] } }));
  const { conversation } = project(input);
  assert.equal(attachments(conversation).length, 2);
  assert.equal(conversation.resources.length, 3);
  assert.equal(new Set(conversation.resources.map(r => r.id)).size, 3);
  assert.match(plainText(allBlocks(conversation)), /\u0000tidy-media:0\u0000/);
});

test('malformed repeated sandbox candidates are bounded and preserve source text', () => {
  const body = '[Read](sandbox:/mnt/data/('.repeat(3500);
  const started = performance.now(), { conversation } = project(payload(message(body)));
  assert.equal(attachments(conversation).length, 0);
  assert.equal(conversation.messages[1].segments[0].blocks[0].text, body);
  assert.ok(performance.now() - started < 1500, 'Malformed input must not repeatedly scan every suffix');
});

test('HTML attributes, comments and raw code containers are not visible attachment deliveries', () => {
  const cases = [
    '<span data-example="' + fileLink + '">Text</span>',
    '<!-- ' + fileLink + ' -->',
    '<code>' + fileLink + '</code>',
    '<pre>' + fileLink + '</pre>',
    '<pre>\n\n' + fileLink + '\n\n</pre>',
    '<!--\n\n' + fileLink + '\n\n-->',
    '<script>' + fileLink + '</script>',
    '<style>' + fileLink + '</style>',
    '<textarea>' + fileLink + '</textarea>',
    '<https://example.test/' + fileLink + '>',
  ];
  for (const body of cases) {
    const { conversation } = project(payload(message(body)));
    assert.equal(attachments(conversation).length, 0, body);
    assert.match(plainText(allBlocks(conversation)), /sandbox:/);
  }
  for (const body of [
    '<!-- ' + fileLink + ' -->\n\n' + fileLink,
    '<pre>\n\n' + fileLink + '\n\n</pre>\n\n' + fileLink,
    '<span>Visible ' + fileLink + '</span>',
  ]) {
    assert.equal(attachments(project(payload(message(body))).conversation).length, 1, body);
  }
});

test('attachment-only list items do not survive as empty bullets, while mixed text remains', () => {
  for (const prefix of ['- ', '1. ']) {
    const body = prefix + fileLink + '\n' + prefix + '[Second](sandbox:/mnt/data/second.txt)';
    for (const mediaAttachments of [false, true]) {
      const { conversation } = project(payload(message(body)), { mediaAttachments });
      assert.equal(allBlocks(conversation).filter(b => /list$/.test(b.type)).length, 0);
      assert.equal(attachments(conversation).length, mediaAttachments ? 2 : 0);
    }
    const { conversation } = project(payload(message(prefix + fileLink + '\n' + prefix + 'Keep this ' + fileLink + ' text.')), { mediaAttachments: false });
    const list = allBlocks(conversation).find(b => /list$/.test(b.type));
    assert.deepEqual(list.items, ['Keep this  text.']);
  }
});
