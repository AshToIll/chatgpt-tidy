// Loading-only TIDY flower: six fixed lobes light in sequence; clock hands
// stay still. Both DOM-based and template-based views share this exact glyph.
const FLOWER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
  + Array.from({ length: 6 }, (_, index) => `<path class="tidy-loading-flower__petal" style="--petal-index: ${index}" transform="rotate(${index * 60} 12 12)" d="M12 12C9.4 10.3 7.9 7.8 8.2 5.6C8.5 3.4 10 2 12 2C14 2 15.5 3.4 15.8 5.6C16.1 7.8 14.6 10.3 12 12Z"/>`).join("")
  + '<path class="tidy-loading-flower__hands" d="M12 17V12L16.3 7.7"/><circle class="tidy-loading-flower__hub" cx="12" cy="12" r="1"/></svg>';

function animationPhase(startedAt) {
  // Keep the phase across view rerenders without retaining detached DOM nodes.
  const elapsed = Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0;
  return `${-elapsed}ms`;
}

export function loadingFlowerMarkup(startedAt = Date.now()) {
  return `<span class="tidy-loading-flower" aria-hidden="true" style="--tidy-loading-phase: ${animationPhase(startedAt)}">${FLOWER_ICON}</span>`;
}

export function createLoadingFlower(startedAt = Date.now()) {
  const flower = document.createElement("span");
  flower.className = "tidy-loading-flower";
  flower.setAttribute("aria-hidden", "true");
  flower.style.setProperty("--tidy-loading-phase", animationPhase(startedAt));
  flower.innerHTML = FLOWER_ICON;
  return flower;
}
