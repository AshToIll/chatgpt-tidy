const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function loadTokens() {
  const context = vm.createContext({ Object });
  vm.runInContext(fs.readFileSync("src/platform/theme/theme.js", "utf8"), context);
  return { native: context.TidyTheme.NATIVE_APPEARANCE_TOKENS, themes: context.TidyTheme.THEMES };
}

function luminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map((value) => Number.parseInt(value, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(left, right) {
  const [bright, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (bright + 0.05) / (dark + 0.05);
}

const { native, themes } = loadTokens();
assert.equal(Object.keys(themes).length, 8);
for (const appearance of ["light", "dark"]) {
  assert.ok(contrast(native[appearance].textPrimary, native[appearance].surface) >= 4.5, `${appearance}: native primary text reaches AA`);
  assert.ok(contrast(native[appearance].textSecondary, native[appearance].surface) >= 4.5, `${appearance}: native secondary text reaches AA`);
  assert.notEqual(native[appearance].border, native[appearance].textTertiary, `${appearance}: borders and auxiliary text are separate tokens`);
}

for (const [themeId, theme] of Object.entries(themes)) {
  for (const appearance of ["light", "dark"]) {
    const accent = theme[appearance];
    assert.deepEqual(
      Object.keys(accent).sort(),
      ["accent", "accentForeground", "accentInk", "accentSoft", "hoverSurface", "selectedSurface"].sort(),
      `${themeId}.${appearance}: themes own emphasis only`,
    );
    assert.ok(contrast(accent.accentForeground, accent.accent) >= 4.5, `${themeId}.${appearance}: accent controls reach AA`);
    assert.ok(contrast(accent.accentInk, accent.selectedSurface) >= 4.5, `${themeId}.${appearance}: selected labels reach AA`);
  }
}

console.log("native neutral and accent contrast assertions passed");
