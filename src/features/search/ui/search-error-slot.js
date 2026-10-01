import "../../../messages/notice-lifecycle.js";

// A read error is business state; this owner manages only its transient display
// permission. The shared slot owns the timer and rejects stale instance clears.
export const SEARCH_ERROR_NOTICE_MS = 5000;

function frozenSnapshot(value) {
  const copy = structuredClone(value);
  const seen = new WeakSet();
  function freeze(item) {
    if (!item || typeof item !== "object" || seen.has(item)) return item;
    seen.add(item);
    for (const child of Object.values(item)) freeze(child);
    return Object.freeze(item);
  }
  return freeze(copy);
}
export function createSearchErrorSlot({ readContext, onClear = () => {},
  schedule = setTimeout, cancel = clearTimeout } = {}) {
  let epoch = 0;
  const slot = globalThis.ChatGPTTidyNoticeLifecycle.createSlot({ setTimer: schedule, clearTimer: cancel,
    onChange(current, event) {
      if (event.event !== "clear") return;
      globalThis.ChatGPTTidyDiagnostics?.notice({ event: "clear", surface: "search.error", reasonCode: event.reason });
      onClear();
    } });
  function clear(channel = null, expected = slot.current()) {
    const current = slot.current();
    if (!current || expected !== current || (channel && current.channel !== channel)) return false;
    return slot.clear(expected);
  }
  function show(error, channel, expectedEpoch = epoch, evidence = null) {
    const context = readContext();
    if (!context.active || !context.visible || expectedEpoch !== epoch) return false;
    clear();
    // Retain notice identity for timers, but never lend query-owned error data to UI.
    slot.replace({ kind: "transient", error: frozenSnapshot(error), channel,
      mode: context.mode, evidence: frozenSnapshot(evidence) }, { ttlMs: SEARCH_ERROR_NOTICE_MS });
    return true;
  }
  function invalidate() { epoch += 1; clear(); }
  return Object.freeze({ show, clear, invalidate, current: slot.current, epoch: () => epoch });
}
