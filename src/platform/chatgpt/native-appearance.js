// 只读原生主题与画布颜色；不写 DOM，也不拥有快照发布。
(function initTidyChatgptNativeAppearance(global) {
  "use strict";
  if (global.TidyChatgptNativeAppearance) return;
  const document = global.document;
  function parsedBackgroundColor(value) {
    const match = String(value || "").match(/rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)(?:\D+([\d.]+))?/i);
    // Semi-transparent layers are not a native surface by themselves; using
    // their uncomposited RGB would make the Side Panel visibly wrong.
    if (!match || Number(match[4] ?? 1) < 0.98) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  }

  function isDarkRgb([red, green, blue]) {
    // Perceptual luminance is sufficient here; this is appearance metadata,
    // not a color transformation or user-content decision.
    return (0.2126 * red + 0.7152 * green + 0.0722 * blue) < 128;
  }

  function cssRgb([red, green, blue]) {
    return `rgb(${red}, ${green}, ${blue})`;
  }

  function readAppearance() {
    const root = document.documentElement;
    const body = document.body;
    const classScheme = root?.classList?.contains("dark") || body?.classList?.contains("dark")
      ? "dark" : null;
    let declaredScheme = null;
    let computedScheme = null;
    let nativeSurface = null;
    let surfaceSource = null;
    if (typeof global.getComputedStyle === "function") {
      // Prefer the actual conversation canvas, then fall back to body/root.
      // Computed colors are parsed into an opaque rgb value before crossing
      // the Adapter boundary, so arbitrary CSS can never reach the panel.
      const candidates = [
        document.querySelector?.("main"),
        document.querySelector?.('[role="main"]'),
        body,
        root,
      ].filter(Boolean);
      for (const element of [...new Set(candidates)]) {
        if (!element) continue;
        const style = global.getComputedStyle(element);
        const candidateScheme = String(style?.colorScheme || "").toLowerCase();
        if (!declaredScheme && ["dark", "only dark"].includes(candidateScheme)) {
          declaredScheme = "dark";
        }
        if (!declaredScheme && ["light", "only light"].includes(candidateScheme)) {
          declaredScheme = "light";
        }
        const background = parsedBackgroundColor(style?.backgroundColor);
        if (!nativeSurface && background) {
          nativeSurface = cssRgb(background);
          surfaceSource = element === body
            ? "computed-style.body.background"
            : element === root
              ? "computed-style.root.background"
              : "computed-style.main.background";
          computedScheme = isDarkRgb(background) ? "dark" : "light";
        }
      }
    }
    const colorScheme = classScheme || declaredScheme || computedScheme
      || (global.matchMedia?.("(prefers-color-scheme: dark)")?.matches === true ? "dark" : "light");
    const source = classScheme ? "document.class"
      : declaredScheme ? "computed-style.color-scheme"
        : computedScheme ? "computed-style.background" : "system-color-scheme";
    const surfaceMatchesScheme = nativeSurface && computedScheme === colorScheme;
    return {
      colorScheme,
      source,
      status: source === "system-color-scheme" ? "partial" : "available",
      surface: {
        value: surfaceMatchesScheme ? nativeSurface : null,
        source: surfaceMatchesScheme ? surfaceSource : null,
        status: surfaceMatchesScheme ? "available" : "missing",
      },
    };
  }


  global.TidyChatgptNativeAppearance = Object.freeze({ readAppearance });
})(globalThis);
