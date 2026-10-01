import { parseConversationRoute } from "../../../platform/navigation/conversation-route.js";
import "../../../platform/snapshot.js";

// Title ownership adds snapshot evidence to the shared route grammar, not a second parser.
export function titleSnapshotContext(snapshot, tabId) {
  const conversation = snapshot?.conversation;
  const route = snapshot?.route;
  const parsed = parseConversationRoute(route?.pathname || "");
  if (!Number.isInteger(tabId) || tabId < 0 || !parsed
    || !globalThis.TidySnapshot?.isPersistenceEligible(snapshot)
    || conversation?.bindingStatus !== "bound" || conversation.identityStatus !== "stable"
    || route?.status !== "available"
    || conversation.conversationId !== parsed.conversationId
    || route.kind !== (parsed.projectId ? "project-conversation" : "conversation")
    || conversation.kind !== route.kind
    || (conversation.project?.projectId || null) !== parsed.projectId) return null;
  return { tabId, ...parsed };
}
