const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { javascriptReferences, markupReferences, mainAssemblyMetadata } = require('../tools/check-architecture.cjs');

const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const walk = directory => fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap(entry => {
  const file = directory + '/' + entry.name;
  return entry.isDirectory() ? file === 'src/vendor' ? [] : walk(file) : /\.(js|css|html)$/.test(file) ? [file] : [];
});

function productionGraph() {
  const files = walk('src'), edges = new Map(files.map(file => [file, new Set()]));
  for (const file of files) {
    // MAIN is assembled from explicit source inputs, not re-parsed as if its
    // original relative imports lived beside the generated bundle.
    if (file === 'src/app/page/main-world.bundle.js') continue;
    const source = read(file);
    const { references } = file.endsWith('.js') ? javascriptReferences(source)
      : markupReferences(source, path.extname(file).slice(1));
    for (const reference of references) {
      if (!reference.value || /^(?:https?:|data:|#)/.test(reference.value)) continue;
      const name = reference.value.split(/[?#]/)[0];
      const base = reference.base === 'extension' || name.startsWith('/') ? 'src' : path.dirname(file);
      const target = path.posix.normalize(path.posix.join(base.replaceAll('\\', '/'), name.replace(/^\//, '')));
      if (edges.has(target)) edges.get(file).add(target);
    }
  }
  const assembly = mainAssemblyMetadata(read('tools/build-main-world.cjs'));
  for (const file of assembly.sourceFiles) edges.get('src/app/page/main-world.bundle.js').add(file);
  // These two URLs are passed through variables, so the literal-only scanner
  // cannot resolve them. Tie each edge to its real owner, never to tests/docs.
  for (const [owner, target] of [
    ['src/platform/navigation/panel-owner.js', 'src/app/sidepanel/index.html'],
    ['src/features/export/background/offscreen-host.js', 'src/features/export/engine/offscreen.html'],
  ]) {
    assert.ok(read(owner).includes(target.slice(4)), `${owner} no longer owns ${target}; update the runtime boundary`);
    edges.get(owner).add(target);
  }
  const manifest = JSON.parse(read('src/manifest.json'));
  const roots = [manifest.background.service_worker, ...manifest.content_scripts.flatMap(entry => [...(entry.js || []), ...(entry.css || [])])]
    .map(file => 'src/' + file);
  return { edges, roots };
}

function unreachable({ edges, roots }) {
  const reached = new Set(), queue = [...roots];
  for (const file of queue) {
    if (reached.has(file)) continue;
    reached.add(file);
    queue.push(...(edges.get(file) || []));
  }
  return [...edges.keys()].filter(file => !reached.has(file));
}

test('every first-party runtime JS, CSS and HTML file is reachable from the production entrypoints', () => {
  assert.deepEqual(unreachable(productionGraph()), [], 'Tests, docs and a self-referencing dead module do not make a runtime file live');
});

test('the production graph rejects disconnected modules even when they refer to each other', () => {
  const graph = productionGraph();
  graph.edges.set('src/retired-a.js', new Set(['src/retired-b.js']));
  graph.edges.set('src/retired-b.js', new Set(['src/retired-a.js']));
  assert.deepEqual(unreachable(graph), ['src/retired-a.js', 'src/retired-b.js']);
});
