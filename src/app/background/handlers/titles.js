import { getTitleRules, updateTitleRules } from "../../../features/titles/storage/title-rules.js";
import { createTitleService } from "../../../features/titles/background/title-service.js";
import { createTitleBatchService } from "../../../features/titles/background/title-batch-service.js";
import { parseConversationRoute } from "../../../platform/navigation/conversation-route.js";
import { isValidTabId } from "../../../platform/navigation/panel-owner.js";
import { libraryError } from "../../../platform/session/background/request-binding.js";
import { createTitleGateway } from "../adapters/title-gateway.js";
import "../../../platform/protocol.js";
import "../../../platform/time-format.js";
import "../../../features/titles/model/title-dates.js";

/**
 * 标题入口只组合明确的面板绑定、页面网关与目录投影，不持有整个 Worker 状态。
 * 恢复库和标题服务仍按需创建；本机规则读取不会启动标题或账号请求。
 */
export function createTitlesHandler({ chrome, binding, pageGateway, catalog }) {
  const protocol = globalThis.TidyProtocol;
  const gateway = createTitleGateway({ chrome, pageGateway });
  let titleService = null;
  let titleBatchService = null;

  const batchActions = Object.freeze({
    [protocol.Type.TITLE_BATCH_PREVIEW]: "preview", [protocol.Type.TITLE_BATCH_REPLAN]: "replan",
    [protocol.Type.TITLE_BATCH_RETRY_PREVIEW]: "retry-preview",
    [protocol.Type.TITLE_BATCH_APPLY]: "apply", [protocol.Type.TITLE_BATCH_STEP]: "step",
    [protocol.Type.TITLE_BATCH_STATUS]: "status", [protocol.Type.TITLE_BATCH_RECONCILE]: "reconcile",
  });
  const titleActions = Object.freeze({
    [protocol.Type.TITLE_PREVIEW]: "preview",
    [protocol.Type.TITLE_REPLAN]: "replan",
    [protocol.Type.TITLE_APPLY]: "apply",
    [protocol.Type.TITLE_STATUS]: "status",
    [protocol.Type.TITLE_RECONCILE]: "reconcile",
  });
  // 显式类型清单用于组合根分发；不按 TITLE_ 前缀授予任何新请求权限。
  const types = Object.freeze([
    protocol.Type.TITLE_RULES_GET, protocol.Type.TITLE_RULES_UPDATE, protocol.Type.TITLE_RETURN_OWNER,
    ...Object.keys(batchActions), ...Object.keys(titleActions),
  ]);

  function getTitleBatchService() {
    if (!titleBatchService) titleBatchService = createTitleBatchService({
      titleService: getTitleService(), model: globalThis.TidyTitleDates,
      beginExecution: (context, execution) => gateway.request(context, protocol.Type.TITLE_BATCH_EXECUTION_BEGIN, {
        batchScopeId: execution.scopeId, ...(execution.identity ? { identity: execution.identity } : {}),
        expectedCatalogAccountKey: execution.catalogAccountKey,
      }),
      endExecution: (context, scopeId) => gateway.request(context, protocol.Type.TITLE_BATCH_EXECUTION_END, { batchScopeId: scopeId }),
      resolveSelection: async (_context, payload) => {
        const ids = payload.conversationIds;
        if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id))
          || new Set(ids).size !== ids.length || typeof payload.accountKey !== "string" || !payload.accountKey.trim()) {
          throw Object.assign(new Error("Select conversations from this account's directory."), { tidyCode: "INVALID_REQUEST" });
        }
        // 外部改名后的显式重新预览只按主键取受影响的行，不重读全目录。
        const rows = payload.refreshOnly
          ? new Map((await Promise.all(ids.map(id => catalog.getRow(payload.accountKey, id))))
            .filter(Boolean).map(row => [row.conversationId, row]))
          : await catalog.read({ accountKey: payload.accountKey, conversationIds: ids });
        // Preview authority is only local catalog membership. The final Apply
        // click opens one authenticated batch lease and rechecks this account.
        return { accountKey: payload.accountKey, rows: ids.map((id) => rows.get(id)) };
      },
    });
    return titleBatchService;
  }

  function getTitleService() {
    // Keep title-specific state lazy: opening search/time must not open the
    // title recovery database or perform title account requests.
    if (!titleService) titleService = createTitleService({
      model: globalThis.TidyTitleDates,
      read: (context, options) => gateway.request(context, protocol.Type.TITLE_READ_CURRENT, options),
      write: (context, plan, beforeDispatch) => gateway.request(context, protocol.Type.TITLE_WRITE_CURRENT, plan, beforeDispatch),
      // Current and batch writes share one post-receipt projection. The adapter
      // supplies this directory key from the same checked session as readback;
      // never guess it from the title writer's user ID or from a panel payload.
      onVerified: (_context, observation) => catalog.observeTitles(
        observation.catalogAccountKey, [observation.current]),
      onAccepted: (_context, observation) => catalog.acceptTitles(
        observation.catalogAccountKey, [{ conversationId: observation.accepted.conversationId, title: observation.accepted.title }]),
    });
    return titleService;
  }

  async function handle({ envelope, sender }) {
    // 本机标题设置不读取会话、不验证 ChatGPT 账号，也不进入远端改标题链路。
    if ([protocol.Type.TITLE_RULES_GET, protocol.Type.TITLE_RULES_UPDATE].includes(envelope.type)) {
      if (!binding.isSidePanelDocumentUrl(sender?.url)) throw libraryError("Title settings require the side panel.");
      return envelope.type === protocol.Type.TITLE_RULES_GET ? getTitleRules() : updateTitleRules(envelope.payload);
    }
    if (envelope.type === protocol.Type.TITLE_RETURN_OWNER) {
      const payload = envelope.payload || {}, target = parseConversationRoute(payload.pathname);
      if (!binding.isSidePanelDocumentUrl(sender?.url) || !target || target.pathname !== payload.pathname) {
        throw libraryError("The saved title owner route is invalid.");
      }
      const tab = await binding.getBoundTab(payload.expectedTabId, sender);
      await chrome.tabs.update(tab.id, { url: `https://chatgpt.com${target.pathname}` });
      return { navigated: true };
    }
    if (Object.hasOwn(batchActions, envelope.type)) {
      const payload = envelope.payload || {};
      if (!binding.isSidePanelDocumentUrl(sender?.url) || !isValidTabId(payload.expectedTabId)
        || typeof payload.expectedConversationId !== "string" || !payload.expectedConversationId) {
        throw Object.assign(new Error("Batch title actions require the exact owner panel."), { tidyCode: "INVALID_REQUEST" });
      }
      const tab = await binding.getBoundTab(payload.expectedTabId, sender);
      const route = parseConversationRoute(tab.url);
      if (!route || route.conversationId !== payload.expectedConversationId) {
        throw Object.assign(new Error("The batch owner conversation changed."), { tidyCode: "CONTEXT_MISMATCH" });
      }
      // A selection change cannot do page/session/metadata I/O. The frozen job
      // checks its exact owner route and TTL; apply/step retain fresh live checks.
      const context = { tabId: tab.id, ...route, targetProjectId: route.projectId };
      const result = await getTitleBatchService().handle(batchActions[envelope.type], context, payload);
      return result;
    }
    if (Object.hasOwn(titleActions, envelope.type)) {
      const payload = envelope.payload || {};
      // Only an owner-bound extension panel can create/confirm a stored plan.
      // A content script cannot ask the worker to rename an arbitrary title.
      if (!binding.isSidePanelDocumentUrl(sender?.url) || !isValidTabId(payload.expectedTabId)
        || typeof payload.expectedConversationId !== "string" || !payload.expectedConversationId) {
        throw Object.assign(new Error("Title organization requires an exact Side Panel context."), {
          tidyCode: protocol.ErrorCode.INVALID_REQUEST,
        });
      }
      const tab = await binding.getBoundTab(payload.expectedTabId, sender);
      const route = parseConversationRoute(tab.url);
      const context = { tabId: tab.id, ...route, conversationId: payload.expectedConversationId, targetProjectId: route?.projectId || null };
      if (envelope.type === protocol.Type.TITLE_REPLAN) {
        // Changing a radio/select is a local calculation, not another account or
        // conversation read. Chrome's exact tab/route and the worker's frozen
        // preview context are sufficient here; final apply retains every live
        // snapshot, identity, metadata and write/readback check below.
        if (!route || route.conversationId !== context.conversationId) {
          throw Object.assign(new Error("The frozen title preview no longer matches this conversation."), {
            tidyCode: protocol.ErrorCode.CONTEXT_MISMATCH,
          });
        }
        return getTitleService().handle("replan", context, payload);
      }
      const { snapshot } = await pageGateway.snapshot(tab, { scope: "title-owner" });
      return getTitleService().handle(titleActions[envelope.type], gateway.context(tab, snapshot, context.conversationId), payload);
    }
    throw Object.assign(new Error("Unsupported title request type: " + envelope.type), {
      tidyCode: protocol.ErrorCode.UNSUPPORTED_TYPE,
    });
  }

  return Object.freeze({ types, handle });
}
