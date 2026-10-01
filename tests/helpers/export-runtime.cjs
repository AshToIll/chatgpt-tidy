const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const realms = new WeakMap();

// Load the shipping ESM dependency graph with a separate lexical scope per file.
// The tests retain their deterministic VM clock/browser realm; no old view body,
// state hook, compatibility API, or substitute feature implementation is used.
function loadExportModule(context, relativePath) {
  let modules = realms.get(context);
  if (!modules) { modules = new Map(); realms.set(context, modules); }
  const absolute = path.resolve(root, relativePath);
  if (!absolute.startsWith(root + path.sep)) throw Error('Test module escaped the project');
  if (modules.has(absolute)) return modules.get(absolute);

  // These state/IPC harnesses deliberately use a markup-only DOM boundary. The
  // real DOM patcher has separate browser tests; all feature owners remain real.
  if (absolute === path.join(root, 'src/platform/ui/stable-list-dom.js') && context.renderListMarkup) {
    const dom = { renderListMarkup: context.renderListMarkup };
    modules.set(absolute, dom);
    return dom;
  }

  const exports = {}, imports = [];
  modules.set(absolute, exports);
  const dependency = specifier => {
    if (!specifier.startsWith('.')) throw Error('Unsupported non-local test import: ' + specifier);
    const index = imports.length;
    imports.push(loadExportModule(context, path.relative(root, path.resolve(path.dirname(absolute), specifier))));
    return '__imports[' + index + ']';
  };
  let source = fs.readFileSync(absolute, 'utf8');
  const names = [];
  // Evaluate dependencies in their declared order, including side-effect imports.
  source = source.replace(/^import\s+(?:(\{[\s\S]*?\}|\*\s+as\s+\w+)\s+from\s+)?["']([^"']+)["'];?\s*$/gm, (_, clause, specifier) => {
    const reference = dependency(specifier);
    if (!clause) return '';
    const binding = clause.trim();
    if (binding.startsWith('{')) return 'const ' + binding.replace(/\bas\b/g, ':') + ' = ' + reference + ';';
    if (binding.startsWith('*')) return 'const ' + binding.replace(/^\*\s+as\s+/, '') + ' = ' + reference + ';';
    throw Error('Unsupported test import binding in ' + relativePath + ': ' + binding);
  });
  source = source.replace(/^export\s+(?=(?:async\s+)?function\s|class\s|const\s|let\s|var\s)(?:(async\s+)?function|class|const|let|var)\s+(\w+)/gm, (match, _async, name) => {
    names.push([name, name]); return match.replace(/^export\s+/, '');
  });
  source = source.replace(/^export\s*\{([^}]+)\};?\s*$/gm, (_, list) => {
    for (const entry of list.split(',')) {
      const [local, exported = local] = entry.trim().split(/\s+as\s+/);
      if (local) names.push([exported, local]);
    }
    return '';
  });
  if (/^\s*(?:import|export)\s/m.test(source)) throw Error('Unsupported ESM syntax in ' + relativePath);
  const publish = names.map(([exported, local]) => 'Object.defineProperty(__exports, ' + JSON.stringify(exported)
    + ', { enumerable: true, get: () => ' + local + ' });').join('\n');
  const evaluate = vm.runInContext('(function(__imports, __exports) { "use strict";\n' + source + '\n' + publish + '\n})', context, { filename: relativePath });
  evaluate(imports, exports);
  return exports;
}

module.exports = { loadExportModule };
