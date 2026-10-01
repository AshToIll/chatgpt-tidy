import "../snapshot.js";

// 平台只解析普通/项目会话路由；标题、导航等功能共用同一快照路由语法。
export function parseConversationRoute(value) {
  let url;
  try { url = new URL(value, "https://chatgpt.com"); } catch { return null; }
  if (url.origin !== "https://chatgpt.com") return null;
  return globalThis.TidySnapshot.parseConversationPath(url.pathname);
}

// Library persistence is intentionally stricter than observed URL parsing above.
// Delegate to the snapshot contract without repairing ports, credentials, relative paths or dot segments.
export function canonicalConversationPath(value, conversationId) {
  return globalThis.TidySnapshot.canonicalConversationPath(value, conversationId);
}
