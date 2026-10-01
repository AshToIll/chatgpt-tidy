const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const fileId = 'file_' + 'a'.repeat(32);
const pointer = { content_type: 'image_asset_pointer', asset_pointer: 'sediment://' + fileId, alt: 'Generated artwork' };
const plain = value => JSON.parse(JSON.stringify(value));
function runtime() {
  const c = vm.createContext({ URL, TextEncoder, TextDecoder });
  for (const f of ['active-branch', 'native-message-references', 'native-message-content', 'native-message-process', 'conversation-projection']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'src/platform/chatgpt/' + f + '.js'), 'utf8'), c);
  }
  vm.runInContext(fs.readFileSync(path.join(root, 'src/features/export/engine/normalize.js'), 'utf8'), c);
  return c;
}
function payload({ name = 'image_gen', hidden = false, generatedParts = ['Private tool status', pointer], metadata = {} } = {}) {
  const message = (id, role, parts, extra = {}) => ({
    id, author: { role }, create_time: 1900000000,
    content: { content_type: 'multimodal_text', parts }, metadata: {}, ...extra,
  });
  return {
    id: 'generated-images', current_node: 'final',
    mapping: {
      user: { id: 'user', parent: null, message: message('user', 'user', ['Draw this', { ...pointer, alt: 'Uploaded reference' }]) },
      request: { id: 'request', parent: 'user', message: message('request', 'assistant', ['Private generation prompt'], { recipient: name }) },
      result: { id: 'result', parent: 'request', message: message('result', 'tool', generatedParts, {
        author: { role: 'tool', name },
        metadata: { ...metadata, ...(hidden ? { is_visually_hidden_from_conversation: true } : {}) },
      }) },
      final: { id: 'final', parent: 'result', message: message('final', 'assistant', ['Here is your image.']) },
      abandoned: { id: 'abandoned', parent: 'request', message: message('abandoned', 'tool', [{ ...pointer, alt: 'Abandoned version' }], { author: { role: 'tool', name } }) },
    },
  };
}
function project(value, options = {}) {
  const c = runtime(), imageReferences = new Map();
  const native = c.TidyChatgptConversationProjection.projectConversation(value, value.id, {}, '', imageReferences);
  const result = c.TidyExport.projectConversation(native.conversation, options);
  return { c, native: plain(native), result: plain(result), imageReferences };
}
const imageBlocks = conversation => conversation.messages.flatMap(message =>
  message.segments.flatMap(segment => segment.blocks || [])).filter(block => block.type === 'image');

test('explicit generated-image tool results are assistant content even when tool process is off', () => {
  for (const name of ['image_gen', 'image_gen.text2im', 'dalle', 'dalle.text2im']) {
    const { native, result, imageReferences } = project(payload({ name }), { toolProcess: false, mediaAttachments: true });
    assert.equal(imageBlocks(result).length, 2, name);
    assert.equal(result.resources.length, 2);
    assert.equal(imageReferences.size, 2, 'Existing authenticated file handles remain available');
    assert.equal(result.messages.length, 2, 'A generated result remains in the same assistant turn');
    assert.equal(result.messages[1].id, 'final');
    const content = result.messages[1].segments.filter(segment => segment.type === 'content');
    assert.deepEqual(content.map(segment => segment.sourceMessageId), ['result', 'final']);
    assert.equal(content[0].blocks[0].alt, 'Generated artwork');
    assert.doesNotMatch(JSON.stringify(result), /Private tool status|Private generation prompt|Abandoned version/);
    assert.equal(native.conversation.resources.length, 2);
  }
});

test('enabling tool process preserves tool text without duplicating generated images', () => {
  const { result } = project(payload(), { toolProcess: true, mediaAttachments: true });
  assert.equal(imageBlocks(result).length, 2);
  const assistant = result.messages[1];
  assert.ok(assistant.segments.some(segment => segment.type === 'process' && segment.blocks.some(block => block.text === 'Private tool status')));
  assert.ok(assistant.segments.every(segment => segment.type !== 'process' || segment.blocks.every(block => block.type !== 'image')));
});

test('media off removes both uploaded and generated images independently of tool process', () => {
  for (const toolProcess of [false, true]) {
    const { result } = project(payload(), { toolProcess, mediaAttachments: false });
    assert.equal(imageBlocks(result).length, 0);
    assert.equal(result.resources.length, 0);
    assert.match(JSON.stringify(result), /Here is your image/);
  }
});

test('hidden, unknown and ordinary tool results never get promoted to assistant image content', () => {
  for (const options of [
    { name: 'python' }, { name: 'other.image_gen' }, { name: 'image_gen.progress' }, { hidden: true },
    { name: 'python', metadata: { tool_name: 'image_gen' } },
    { metadata: { reasoning_status: 'is_reasoning' } },
  ]) {
    const { result } = project(payload(options), { toolProcess: false, mediaAttachments: true });
    assert.equal(imageBlocks(result).length, 1, JSON.stringify(options));
    assert.equal(result.resources.length, 1);
  }
  const ordinary = project(payload({ name: 'python' }), { toolProcess: true, mediaAttachments: true });
  assert.equal(imageBlocks(ordinary.result).length, 2, 'Ordinary tool image remains controlled by its original switch');
});

test('tool metadata alone and Markdown-only tool pictures are not final generated-image evidence', () => {
  const { result } = project(payload({ generatedParts: ['![Internal diagram](https://images.example.test/debug.png)'] }),
    { toolProcess: false, mediaAttachments: true });
  assert.equal(imageBlocks(result).length, 1);
  assert.equal(result.resources.length, 1);
});

test('generated media keeps active-branch ownership and maps to the same logical message number', () => {
  const value = payload(), { c, native } = project(value);
  const numbers = plain(c.TidyChatgptConversationProjection.messageNumbersFromPayload(value, value.id));
  assert.equal(numbers.user, 1);
  assert.equal(numbers.result, 2);
  assert.equal(numbers.final, 2);
  assert.equal(numbers.abandoned, undefined);
  assert.ok(native.conversation.resources.every(resource => !resource.id.startsWith('abandoned')));
});

test('unsupported generated asset pointers stay unavailable rather than guessing a URL or file identity', () => {
  const { native, result, imageReferences } = project(payload({
    generatedParts: [{ ...pointer, asset_pointer: 'unknown://not-a-supported-file-reference' }],
  }), { mediaAttachments: true });
  assert.equal(imageBlocks(result).length, 2);
  assert.equal(imageReferences.size, 1, 'Only the supported uploaded reference receives a handle');
  assert.equal(result.resources[1].src, '');
  assert.ok(native.warnings.includes('IMAGE_UNAVAILABLE'));
});

test('generated results without a final text response still form one assistant turn', () => {
  const value = payload();
  value.mapping.final.message.content.parts = [''];
  const { result } = project(value, { mediaAttachments: true });
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[1].role, 'assistant');
  assert.equal(result.messages[1].id, 'result');
  assert.equal(imageBlocks(result).length, 2);
});

test('a generated result promotes only structural output images, not Markdown debug pictures beside them', () => {
  const { result } = project(payload({ generatedParts: [
    'Private before\n\n![Internal diagram](https://images.example.test/debug.png)',
    pointer,
    'Private after',
  ] }), { toolProcess: false, mediaAttachments: true });
  assert.equal(imageBlocks(result).length, 2);
  assert.doesNotMatch(JSON.stringify(result), /debug\.png|Internal diagram|Private before|Private after/);
  const all = project(payload({ generatedParts: [
    'Private before\n\n![Internal diagram](https://images.example.test/debug.png)', pointer, 'Private after',
  ] }), { toolProcess: true, mediaAttachments: true }).result;
  assert.equal(imageBlocks(all).length, 3);
  const segments = all.messages[1].segments.filter(segment => segment.sourceMessageId === 'result');
  assert.deepEqual(segments.map(segment => segment.type), ['process', 'content', 'process']);
});

test('explicit metadata tool identity is supported only when no conflicting author tool name exists', () => {
  const value = payload({ name: '', metadata: { tool_name: 'image_gen' } });
  const { result } = project(value, { mediaAttachments: true });
  assert.equal(imageBlocks(result).length, 2);
});

// Shape observed in a real browser export. All names, IDs, text and asset identities below
// are synthetic: production-generated pictures have per-run tool aliases, not image_gen.
const generatedPointer = metadata => ({ ...pointer, metadata });
test('part generation identity recognizes dynamic tool aliases without depending on title or size labels', () => {
  for (const name of ['dynamic-tool-a.result-b', 'another-dynamic-alias', '']) {
    for (const metadata of [
      { generation: { gen_id: 'synthetic-generation', gen_size: 'image' } },
      { generation: { gen_id: 'synthetic-generation', gen_size: 'smimage' }, dalle: { gen_id: 'synthetic-generation' } },
      { dalle: { gen_id: 'synthetic-generation' } },
    ]) {
      const value = payload({ name, generatedParts: ['Private tool status', generatedPointer(metadata)] });
      value.mapping.result.message.recipient = 'all';
      const { result, imageReferences } = project(value, { toolProcess: false, mediaAttachments: true });
      assert.equal(imageBlocks(result).length, 2, name + JSON.stringify(metadata));
      assert.equal(result.messages[1].segments[0].type, 'content');
      assert.equal(imageReferences.size, 2);
      assert.doesNotMatch(JSON.stringify(result), /Private tool status|synthetic-generation|gen_size/);
      for (const toolProcess of [false, true]) {
        const off = project(value, { toolProcess, mediaAttachments: false }).result;
        assert.equal(imageBlocks(off).length, 0);
        assert.equal(off.resources.length, 0);
      }
    }
  }
});

test('a dynamic tool promotes each generated part individually and never its sibling process pictures', () => {
  const value = payload({ name: 'dynamic-tool.result', generatedParts: [
    'Private before', generatedPointer({ generation: { gen_id: 'synthetic-generation' } }),
    'Private between', { ...pointer, alt: 'Process screenshot' }, 'Private after',
  ] });
  const { result, c } = project(value, { toolProcess: false, mediaAttachments: true });
  assert.equal(imageBlocks(result).length, 2);
  assert.doesNotMatch(JSON.stringify(result), /Process screenshot|Private before|Private between|Private after/);
  const all = project(value, { toolProcess: true, mediaAttachments: true }).result;
  assert.equal(imageBlocks(all).length, 3);
  assert.deepEqual(all.messages[1].segments.filter(segment => segment.sourceMessageId === 'result')
    .map(segment => segment.type), ['process', 'content', 'process']);
  const numbers = plain(c.TidyChatgptConversationProjection.messageNumbersFromPayload(value, value.id));
  assert.equal(numbers.result, numbers.final);
  assert.equal(numbers.abandoned, undefined);
});

test('generation metadata never overrides hidden, reasoning, preamble or internal-recipient boundaries', () => {
  for (const name of ['dynamic-tool.result', 'image_gen']) for (const overrides of [
    { metadata: { is_visually_hidden_from_conversation: true } },
    { metadata: { reasoning_status: 'is_reasoning' } },
    { metadata: { is_thinking_preamble_message: true } },
    { recipient: 'assistant' }, { recipient: 'another-tool' },
  ]) {
    const value = payload({ name, generatedParts: [
      generatedPointer({ generation: { gen_id: 'synthetic-generation' } }),
    ] });
    Object.assign(value.mapping.result.message, overrides);
    const { result } = project(value, { toolProcess: false, mediaAttachments: true, visibleProcess: false });
    assert.equal(imageBlocks(result).length, 1, JSON.stringify(overrides));
    assert.equal(result.resources.length, 1);
  }
});

test('titles, empty generation metadata and untyped or Markdown pictures are not generation evidence', () => {
  for (const metadata of [null, {}, { generation: {} }, { generation: { gen_id: '' } },
    { generation: { gen_id: ' ' } }, { generation: { gen_id: 123 } }, { generation: { gen_id: {} } }, { dalle: { gen_id: null } }]) {
    const value = payload({ name: 'dynamic-tool.result', metadata: {
      image_gen_title: 'Generated artwork', generation: { gen_id: 'not-part-metadata' },
    }, generatedParts: [generatedPointer(metadata)] });
    assert.equal(imageBlocks(project(value, { toolProcess: false, mediaAttachments: true }).result).length, 1);
  }
  for (const part of [
    { text: '![Process screenshot](https://images.example.test/debug.png)', metadata: { generation: { gen_id: 'synthetic-generation' } } },
    { content_type: 'image_process_snapshot', asset_pointer: pointer.asset_pointer, metadata: { generation: { gen_id: 'synthetic-generation' } } },
  ]) {
    const value = payload({ name: 'dynamic-tool.result', generatedParts: [part] });
    assert.equal(imageBlocks(project(value, { toolProcess: false, mediaAttachments: true }).result).length, 1);
  }
});
