// Callers provide a positive page count (an empty result still has page 1).
// This only bounds the selection; each view owns its pagination markup/events.
export function clampPage(value, totalPages) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(1, Math.trunc(number)), totalPages) : 1;
}
