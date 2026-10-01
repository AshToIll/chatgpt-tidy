const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/features/export/engine/inline-content.js'), 'utf8'), context);
const render = context.TidyExport.markdownTextWithoutImages;
const tick = String.fromCharCode(96);

// This boundary does not resolve image references or HTML. It only prevents a
// Markdown reader from loading images outside literal code.
test('Markdown inline, reference, collapsed and shortcut image syntax is readable but inactive', () => {
  const source = '![Inline](https://example.test/p.png) ![Reference][ref] ![Collapsed][] ![Shortcut]\n\n[ref]: https://example.test/reference.png';
  assert.equal(render(source), source.replace(/!\[/g, '\\!['));
  assert.equal(render('nested ![outer ![inner][ref]][other]'), 'nested \\![outer \\![inner][ref]][other]');
});

test('existing Markdown escapes are preserved and even backslash runs do not hide active images', () => {
  for (let count = 0; count < 8; count++) {
    const prefix = '\\'.repeat(count);
    assert.equal(render(prefix + '![pic][ref]'), prefix + (count % 2 ? '' : '\\') + '![pic][ref]');
  }
  assert.equal(render('!\\[not-image] &excl;[not-image]'), '!\\[not-image] &excl;[not-image]');
});

test('HTML img names and valid tag-name boundaries are neutralized without broad HTML rewriting', () => {
  for (const tag of ['<img src="https://example.test/a.png">', '<IMG SRC=x>', '<ImG\tsrc=x>', '<img\nsrc=x>',
    '<img\rsrc=x>', '<img\fsrc=x>', '<img/>', '<img>', '<img / >']) {
    assert.equal(render(tag), '&lt;' + tag.slice(1), JSON.stringify(tag));
  }
  const unrelated = '<image src=x> <imgfoo src=x> < img src=x> <picture> &lt;img src=x&gt; <img';
  assert.equal(render(unrelated), unrelated);
});

test('escaped HTML remains literal while an even backslash run still deactivates img', () => {
  for (let count = 0; count < 8; count++) {
    const prefix = '\\'.repeat(count), tag = '<IMG src=x>';
    assert.equal(render(prefix + tag), prefix + (count % 2 ? tag : '&lt;IMG src=x>'));
  }
});

test('paired code spans preserve image examples exactly across delimiter widths and line breaks', () => {
  for (let width = 1; width < 12; width++) {
    const delimiter = tick.repeat(width);
    const literal = delimiter + '![code][ref]\n<IMG src=x> ' + tick.repeat(width + 1) + ' example' + delimiter;
    const source = '![before][r] ' + literal + ' <img src=after>';
    assert.equal(render(source), '\\![before][r] ' + literal + ' &lt;img src=after>');
  }
});

test('escaped first tick can leave a shorter opening span, and closing ticks are not escaped inside code', () => {
  const partialOpening = '\\' + tick.repeat(3) + ' ![code][r] <img src=x> ' + tick.repeat(2);
  assert.equal(render(partialOpening + ' ![outside][r]'), partialOpening + ' \\![outside][r]');
  const slashBeforeClosing = tick + ' ![code][r] <img src=x> \\' + tick;
  assert.equal(render(slashBeforeClosing + ' <img src=outside>'), slashBeforeClosing + ' &lt;img src=outside>');
});

test('unmatched backticks do not protect active image syntax in prose', () => {
  const source = tick.repeat(3) + ' ![plain][r] <img src=x> ' + tick.repeat(2);
  assert.equal(render(source), tick.repeat(3) + ' \\![plain][r] &lt;img src=x> ' + tick.repeat(2));
  assert.equal(render('\\' + tick + ' ![plain][r]'), '\\' + tick + ' \\![plain][r]');
});

test('ordinary links, reference definitions and existing safe image literals are preserved idempotently', () => {
  const source = '[link](https://example.test/path?q=1) [ref]\n[ref]: https://example.test/r\n\\![literal][r] &lt;img src=x>';
  assert.equal(render(source), source);
  const mixed = '![image][r] <img src=x> ' + tick + '![literal][r]<img>' + tick;
  assert.equal(render(render(mixed)), render(mixed));
  assert.equal(render(null), '');
});

test('many malformed image prefixes and distinct unmatched code runs stay bounded', () => {
  const runs = Array.from({ length: 1200 }, (_, index) => tick.repeat(index + 1) + ' ![unclosed <IMG src=x>\n');
  const source = runs.join('') + '!['.repeat(100000), started = performance.now();
  const result = render(source);
  assert.equal((result.match(/\\!\[/g) || []).length, 101200);
  assert.equal((result.match(/&lt;IMG/g) || []).length, 1200);
  assert.ok(performance.now() - started < 5000, 'single-pass delimiter indexing must not repeatedly scan long malformed suffixes');
});



test('actual Markdown block rendering deactivates prose images but preserves code blocks and inline examples', () => {
  const realm = vm.createContext({ URL, TextEncoder });
  for (const name of ['i18n', 'inline-content', 'serializers']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/features/export/engine/' + name + '.js'), 'utf8'), realm);
  }
  const api = realm.TidyExport;
  const literal = '![code][ref]\n<img src="https://example.test/code.png">';
  const prose = '![ref][pic]\n<pic> <IMG src="https://example.test/live.png"> ' + tick + '![inline][pic]' + tick;
  const result = api.markdownBlocks([{ type: 'paragraph', text: prose }, { type: 'code', language: 'md', code: literal }]);
  assert.ok(result.includes('\\![ref][pic]'));
  assert.ok(result.includes('&lt;IMG src="https://example.test/live.png">'));
  assert.ok(result.includes(tick + '![inline][pic]' + tick));
  assert.ok(result.includes(tick.repeat(3) + 'md\n' + literal + '\n' + tick.repeat(3)));
});
