const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const loadedByContext = new WeakMap();

// Use the real build manifest, not a reconstructed giant MAIN entry or a
// second test-only dependency graph. Every listed module executes intact.
function mainSourceFiles() {
  return require("../../tools/build-main-world.cjs").sourceFiles;
}

function loadMainModule(context, file) {
  let loaded = loadedByContext.get(context);
  if (!loaded) loadedByContext.set(context, loaded = new Set());
  if (loaded.has(file)) return;
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  loaded.add(file);
}

// Unit fixtures provide their boundary ports first, then load the genuine
// target and its declared pure dependencies. They never load unrelated MAIN
// page effects just to obtain the conversation/export projection.
function loadMainModuleDependencies(context, file) {
  const { sourceDependencies } = require("../../tools/build-main-world.cjs");
  const visiting = new Set();
  function visit(current) {
    if (loadedByContext.get(context)?.has(current)) return;
    if (visiting.has(current)) throw new Error("Cyclic MAIN dependency: " + current);
    visiting.add(current);
    for (const dependency of sourceDependencies[current] || []) visit(dependency);
    loadMainModule(context, current);
    visiting.delete(current);
  }
  visit(file);
}

function loadMainRuntime(context) {
  for (const file of mainSourceFiles()) loadMainModule(context, file);
  return context.TidyPageSession;
}

module.exports = { loadMainModule, loadMainModuleDependencies, loadMainRuntime, mainSourceFiles };
