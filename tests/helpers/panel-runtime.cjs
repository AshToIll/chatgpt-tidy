const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ROOT = path.resolve(__dirname, "../..");

/**
 * Run complete production modules with their real dependency graph in one VM.
 * Tests supply browser/transport/DOM boundaries, never a reconstructed panel.js.
 * Per-file transforms are reserved for observing a module's private state in
 * tests; normal behavior and dependencies still execute from production files.
 */
function createPanelRuntime(globals = {}, { transforms = {}, modules = {} } = {}) {
  const context = vm.createContext({
    console, URL, URLSearchParams, Date, Intl, AbortController, structuredClone,
    setTimeout, clearTimeout, queueMicrotask, ...globals,
  });
  const cache = new Map();
  function load(file, parent = path.join(ROOT, "entry.js")) {
    const full = file.startsWith(".") ? path.resolve(path.dirname(parent), file) : path.resolve(ROOT, file);
    if (cache.has(full)) return cache.get(full);
    const relative = path.relative(ROOT, full).split(path.sep).join("/");
    // Explicit exact-path seams for unrelated UI/browser boundaries only.
    // There is no wildcard fallback: every unstubbed owner loads real source.
    if (Object.hasOwn(modules, relative)) { cache.set(full, modules[relative]); return modules[relative]; }
    let source = fs.readFileSync(full, "utf8");
    if (transforms[relative]) source = transforms[relative](source);
    const names = [];
    source = source.replace(/^import\s+([^"';]*?)\s+from\s+["']([^"']+)["'];?\s*$/gm, (_all, bindings, dependency) => {
      const value = "__load(" + JSON.stringify(dependency) + ")";
      const parts = bindings.trim();
      if (parts.startsWith("{")) return "const " + parts.replace(/\bas\b/g, ":") + " = " + value + ";";
      if (parts.startsWith("* as ")) return "const " + parts.slice(5) + " = " + value + ";";
      if (/^[\w$]+$/.test(parts)) return "const " + parts + " = " + value + ".default;";
      throw new Error("Unsupported import in " + relative + ": " + parts);
    });
    source = source.replace(/^import\s+["']([^"']+)["'];?\s*$/gm, (_all, dependency) => "__load(" + JSON.stringify(dependency) + ");");
    source = source.replace(/^export\s+(?=(?:async\s+)?function|class|const|let|var)/gm, "");
    const original = fs.readFileSync(full, "utf8");
    for (const match of original.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([\w$]+)/gm)) names.push([match[1], match[1]]);
    source = source.replace(/^export\s*\{([^}]+)\};?\s*$/gm, (_all, declarations) => {
      for (const entry of declarations.split(",")) {
        const [local, exported] = entry.trim().split(/\s+as\s+/);
        if (local) names.push([exported || local, local]);
      }
      return "";
    });
    if (/^export\s/m.test(source)) throw new Error("Unsupported export in " + relative);
    const result = {};
    cache.set(full, result);
    const assignments = names.map(([exported, local]) => "__exports[" + JSON.stringify(exported) + "] = " + local + ";").join("\n");
    const execute = vm.runInContext("(function (__load, __exports) {\n" + source + "\n" + assignments + "\n})", context, { filename: full });
    execute(dependency => load(dependency, full), result);
    return result;
  }
  return { context, load };
}
module.exports = { createPanelRuntime };
