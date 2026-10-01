const fs = require('node:fs');
const { createWorkerModuleLoader } = require('./worker-runtime.cjs');

// Load the complete navigation owner and its actual dependency modules in the
// harness realm. The only instrumentation is a copied, read-only test probe;
// no map, mutable ticket, or alternate navigation implementation is exposed.
function loadWorkerNavigation(context, read = file => fs.readFileSync(file, 'utf8')) {
  const file = 'src/platform/navigation/background/worker-navigation.js';
  const loader = createWorkerModuleLoader(context, {
    imports: context,
    read(name) {
      const source = read(name);
      if (name !== file) return source;
      return source.replace('  const handles = new WeakMap();', `
  const handles = new WeakMap();
  globalThis.readNavigationState = tabId => {
    const ticket = navigationIntents.get(tabId);
    if (!ticket) return null;
    const { handle, execution, libraryOperation, deadlineTimer, ...snapshot } = ticket;
    return JSON.parse(JSON.stringify(snapshot));
  };
  globalThis.navigationStateCount = () => navigationIntents.size;
  `);
    },
  });
  context.createWorkerNavigation = loader.load(file).createWorkerNavigation;
}
module.exports = { loadWorkerNavigation };
