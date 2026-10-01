const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');

/**
 * Execute whole production ES modules in the test's browser realm.
 * Translation is limited to module declarations: no entrypoint slices and no
 * production-function copies. Named imports make host/store test doubles
 * explicit; every other dependency is loaded from the real module graph.
 */
function createWorkerModuleLoader(context, { read = file => fs.readFileSync(path.join(root, file), 'utf8'),
  imports = {}, modules = {} } = {}) {
  const cache = new Map();
  function load(file) {
    const name = path.posix.normalize(file.replaceAll('\\', '/'));
    if (Object.hasOwn(modules, name)) return modules[name];
    if (cache.has(name)) return cache.get(name);
    const output = {};
    cache.set(name, output);
    const exported = [];
    let code = read(name);
    code = code.replace(/^import\s+([^;]*?)\s+from\s+(['"])([^'"]+)\2\s*;[ \t]*$/gm,
      (_all, specifier, _quote, relative) => {
        const dependency = path.posix.join(path.posix.dirname(name), relative);
        const spec = specifier.trim();
        if (spec.startsWith('{')) {
          return spec.slice(1, -1).split(',').map(value => value.trim()).filter(Boolean).map(member => {
            const [remote, local = remote] = member.split(/\s+as\s+/);
            return 'const ' + local + ' = __dependency(' + JSON.stringify(dependency) + ', ' + JSON.stringify(remote) + ');';
          }).join('\n');
        }
        if (spec.startsWith('* as ')) return 'const ' + spec.slice(5).trim() + ' = __dependency(' + JSON.stringify(dependency) + ');';
        if (/^[\w$]+$/.test(spec)) return 'const ' + spec + ' = __dependency(' + JSON.stringify(dependency) + ', "default");';
        throw new Error('Unsupported production import in ' + name + ': ' + spec);
      });
    code = code.replace(/^import\s+(['"])([^'"]+)\1\s*;[ \t]*$/gm,
      (_all, _quote, relative) => '__dependency(' + JSON.stringify(path.posix.join(path.posix.dirname(name), relative)) + ');');
    code = code.replace(/^export\s+(async\s+)?(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
      (_all, asyncPrefix = '', kind, identifier) => {
        exported.push([identifier, identifier]);
        return asyncPrefix + kind + ' ' + identifier;
      });
    code = code.replace(/^export\s*\{([^}]+)\}\s*;?[ \t]*$/gm, (_all, members) => {
      for (const member of members.split(',').map(value => value.trim()).filter(Boolean)) {
        const [local, remote = local] = member.split(/\s+as\s+/);
        exported.push([remote, local]);
      }
      return '';
    });
    if (/^\s*(?:import|export)\s/m.test(code)) throw new Error('Unsupported module declaration in ' + name);
    const expose = exported.map(([remote, local]) =>
      'Object.defineProperty(__exports, ' + JSON.stringify(remote) + ', { enumerable: true, get: () => ' + local + ' });').join('\n');
    const execute = vm.runInContext('(function (__dependency, __exports) {\n"use strict";\n' + code + '\n' + expose + '\n})',
      context, { filename: name });
    execute((dependency, symbol) => {
      // Resolve the real dependency and prove its export before applying a
      // host/store double. A named stub must never conceal a broken import.
      const namespace = load(dependency);
      if (symbol && !Object.hasOwn(namespace, symbol)) throw new Error("Missing production export " + symbol + " from " + dependency);
      if (symbol && Object.hasOwn(imports, symbol)) return imports[symbol];
      return symbol ? namespace[symbol] : namespace;
    }, output);
    return output;
  }
  return Object.freeze({ load });
}

module.exports = { createWorkerModuleLoader };
