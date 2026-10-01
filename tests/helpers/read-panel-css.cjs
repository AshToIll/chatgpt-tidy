const fs = require("node:fs");
const path = require("node:path");

// Read the same ordered stylesheet graph that the browser loads. Do not flatten
// or reorder selectors in production merely to satisfy source-inspection tests.
function readPanelCss(file = "src/app/sidepanel/panel.css", ancestors = []) {
  const full = path.resolve(file);
  if (ancestors.includes(full)) throw new Error("CSS import cycle: " + full);
  return fs.readFileSync(full, "utf8").replace(/@import\s+(?:url\()?['"]([^'"]+)['"]\)?\s*;/g, (_, dependency) =>
    readPanelCss(path.resolve(path.dirname(full), dependency), [...ancestors, full]));
}
module.exports = { readPanelCss };
