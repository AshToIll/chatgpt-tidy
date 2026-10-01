const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadRulesModules(context) {
  for (const [file, names] of [
    ["platform/protocol", []],
    ["features/titles/model/title-rules", ["TITLE_RULES_KEY", "TITLE_RULE_FORMATS", "TITLE_RULE_MODES", "normalizeTitleRules", "titleRulesPatch"]],
    ["features/titles/storage/title-rules", ["createTitleRulesStore", "getTitleRules", "updateTitleRules"]],
    ["features/titles/ui/title-rules", ["createTitleRulesController", "getTitleRulesController"]],
  ]) {
    const source = fs.readFileSync(path.join(__dirname, "../../src", `${file}.js`), "utf8")
      .replace(/^import[^\n]+\n/gm, "").replace(/^export /gm, "");
    vm.runInContext(`(() => { ${source}\nObject.assign(globalThis, { ${names.join(",")} }); })();`, context, { filename: file });
  }
  return context;
}

// View fixtures use the real queued store and protocol; only Chrome transport
// and durable I/O are synthetic. A successful set is visible to later reads.
function installRulesRuntime(context, preferences = {}) {
  loadRulesModules(context);
  const local = context.chrome?.storage?.local || { get: async () => ({}), set: async () => {} };
  let written;
  const store = context.createTitleRulesStore({ defaults: async () => preferences, storage: {
    get: async key => written ? { [key]: written } : local.get(key),
    set: async values => { await local.set(values); written = { ...values[context.TITLE_RULES_KEY] }; },
  } });
  context.chrome ||= {};
  context.chrome.runtime ||= {};
  context.chrome.runtime.sendMessage = async envelope => {
    const p = context.TidyProtocol;
    try {
      if (envelope.type === p.Type.TITLE_RULES_GET) return p.response(envelope, await store.read());
      if (envelope.type === p.Type.TITLE_RULES_UPDATE) return p.response(envelope, await store.update(envelope.payload));
      throw new Error("Unexpected fixture request");
    } catch (error) { return p.failure(envelope, error.tidyCode || "STORAGE_ERROR", "Fixture failure"); }
  };
  return store;
}
module.exports = { loadRulesModules, installRulesRuntime };
