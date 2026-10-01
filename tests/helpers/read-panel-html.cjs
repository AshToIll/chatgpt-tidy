const fs = require("node:fs");
const vm = require("node:vm");

// Compose the shell with the exact production templates mounted by each view.
// This keeps DOM contract assertions valid without reintroducing mixed ownership.
function readPanelHtml() {
  let html = fs.readFileSync("src/app/sidepanel/index.html", "utf8");
  for (const [feature, id, exported] of [["time", "time", "TIME_VIEW_TEMPLATE"], ["settings", "settings", "SETTINGS_VIEW_TEMPLATE"]]) {
    const filename = "src/features/" + feature + "/ui/" + feature + "-template.js";
    const source = fs.readFileSync(filename, "utf8").replace("export const " + exported, "globalThis.template");
    const context = vm.createContext({ String });
    vm.runInContext(source, context, { filename });
    const opening = new RegExp('(<section id="' + id + '-view"[^>]*>)');
    html = html.replace(opening, (_, tag) => tag + context.template);
  }
  return html;
}
module.exports = { readPanelHtml };
