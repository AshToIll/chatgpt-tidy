// Same lifecycle owner required by the manifest-loaded page presenters.
import '../../src/messages/notice-lifecycle.js';
import '../../src/messages/page-runtime.js';
import "../../src/platform/protocol.js";
import "../../src/platform/session/shared/page-session.js";
import "../../src/platform/snapshot.js";
import "../../src/platform/time-format.js";
import "../../src/platform/ui/dom-ownership.js";
import "../../src/platform/theme/theme.js";
import "../../src/platform/chatgpt/message-dom.js";
import "../../src/platform/chatgpt/sidebar-dom.js";

const results = [], sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
const equal = (value, expected, message) => assert(value === expected, `${message}: ${value} !== ${expected}`);
async function check(name, run) {
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: error.message }); }
}
const field = value => ({ value, source: "fixture", status: value === null ? "missing" : "available" });
const history = document.querySelector("#native-history"), viewport = document.querySelector("#native-scroll");
const items = Array.from({ length: 24 }, (_, i) => ({ conversationId: `fixture-${i}`, bindingStatus: "bound", identityStatus: "stable",
  kind: i === 1 ? "project-conversation" : i === 2 ? "group" : "conversation", title: field(`Fixture ${i}`),
  createdAt: field("2026-08-01T01:00:00.000Z"), updatedAt: field("2026-09-01T02:00:00.000Z"),
  locator: { strategy: "href", value: i === 1 ? "/g/g-p-fixture/c/fixture-1" : i === 2 ? "/gg/fixture-2" : `/c/fixture-${i}` } }));
function row(item, index) {
  const node = document.createElement("a"); node.className = "native-row";
  node.setAttribute("href", item.locator.value);
  // Lazy project children may not yet carry the native sidebar marker.
  if (index !== 1) node.dataset.sidebarItem = "true";
  const title = document.createElement("span"); title.textContent = item.title.value; node.append(title);
  return node;
}
history.append(...items.map(row));
const preferences = { language: "en", timeZone: "UTC", dateFormat: "iso", conversationTimeMode: "created",
  conversationTimePrecision: "minute", messageTimePrecision: "second", messageTimePosition: "after",
  timeDisplayEnabled: true, messageNumbersEnabled: true };
let snapshot = { schemaVersion: TidySnapshot.VERSION, route: { pathname: "/c/fixture-0" },
  appearance: { colorScheme: "light", source: "fixture", status: "available", surface: field("rgb(255, 255, 255)") },
  conversation: { ...items[0], draftId: null }, sidebarConversations: items, messages: [] };
const subscribers = [], runtimeListeners = [], calls = [];
globalThis.chrome ||= {};
globalThis.chrome.runtime = {
  id: "synthetic-extension",
  sendMessage(envelope) {
    calls.push(envelope.type);
    const payload = envelope.type === TidyProtocol.Type.PREFERENCES_GET ? preferences
      : envelope.type === TidyProtocol.Type.FAVORITES_GET ? { items: {} }
      : envelope.type === TidyProtocol.Type.BOOKMARKS_GET ? { items: {} } : null;
    if (!payload) throw new Error(`Unexpected mutation/request ${envelope.type}`);
    return Promise.resolve(TidyProtocol.response(envelope, payload));
  }, onMessage: { addListener: fn => runtimeListeners.push(fn),
    removeListener: fn => { const i = runtimeListeners.indexOf(fn); if (i >= 0) runtimeListeners.splice(i, 1); } },
};
globalThis.TidyPageSession = TidyPageSessionContract.create({ runtime: chrome.runtime });
globalThis.TidyContentBridge = { onSnapshot: fn => { subscribers.push(fn); return () => {
  const i = subscribers.indexOf(fn); if (i >= 0) subscribers.splice(i, 1);
}; }, requestMain: () => Promise.resolve(snapshot) };
// 真实收藏/书签渲染器需要已读取的资料；只替换资料传输，不伪造按钮或布局。
const library = { favorites: { items: { "fixture-0": { conversationId: "fixture-0" } } },
  bookmarks: { items: Object.fromEntries(items.map(item => [item.conversationId, { conversationId: item.conversationId }])) } };
globalThis.TidyLibraryClient = { subscribe(fn) { fn(library); return () => {}; },
  capture: () => ({ accountKey: "fixture" }), owns: () => true,
  request(type) { calls.push(type); return Promise.resolve({}); } };
function publish(next) {
  assert(TidySnapshot.validate(next).valid, "fixture snapshot must obey production contract");
  snapshot = next; subscribers.forEach(fn => fn(next));
}
const height = node => node.getBoundingClientRect().height;

void check("native rows reserve their final height before metadata or decoration arrives", () => {
  for (const node of history.children) equal(height(node), 52, "row height before presentation");
});

export { results, sleep, assert, equal, check, history, viewport, items, row, publish, height, field };
export const currentSnapshot = () => snapshot;
export const runtimeCalls = calls;
