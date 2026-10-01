(function initTidyChatgptExport(global) {
  "use strict";

  if (global.TidyChatgptExport) return;

  const contract = global.TidyExportContract;
  const projection = global.TidyChatgptConversationProjection;
  const { markdownToBlocks } = global.TidyChatgptNativeMessageContent;
  const { activeBranch, responseConversationId } = global.TidyChatgptActiveBranch;
  const routeAdapter = global.TidyChatgptRoute;
  const chatgptApi = global.TidyChatgptApi;
  const pageSession = global.TidyPageSession;
  if (!projection || !contract || !routeAdapter || !chatgptApi || !pageSession) return;

  // 正文先返回。图片只保留页内读取句柄，不把文件编号/凭据交给侧栏。
  // 最多保留 5000 个轻量资源引用；切账号立即清空，旧句柄只能报错，不能串账号。
  const imageReads = new Map();
  const imageRequests = new Map();
  let imageSequence = 0;
  const unsubscribeIdentity = chatgptApi.onLibraryIdentityChanged?.(() => imageReads.clear());
  // 退休页面不能继续持有签名地址、图片句柄或超时器；中止只清理，绝不重试。
  pageSession.onDispose(() => {
    unsubscribeIdentity?.();
    for (const entry of imageReads.values()) entry.resolvedFiles.clear();
    imageReads.clear();
    for (const [controller, timer] of imageRequests) {
      clearTimeout(timer);
      controller.abort(pageSession.error());
    }
    imageRequests.clear();
  });

  function routeOwnsConversation(conversationId, context = {}) {
    if (typeof context.routeOwnsConversation === "function") {
      return context.routeOwnsConversation(conversationId) === true;
    }
    return routeAdapter.parse().conversationId === conversationId;
  }

  function conversationSourceUrl(conversationId) {
    return new URL(`/c/${global.encodeURIComponent(conversationId)}`, global.location.origin).href;
  }

  // 只拦截当前活动回合尾端的明确进行中状态，不把缺字段或工具的 end_turn:false
  // 猜成未完成。历史/废分支的流式标记不应锁死整份会话；本检查也不宣称能
  // 证明 API 已追上页面，或能判断一个已停止记录之后是否还会继续工具调用。
  function assertResponseNotInProgress(payload) {
    const branch = activeBranch(payload);
    for (let index = branch.length - 1; index >= 0; index--) {
      const message = branch[index]?.message;
      const role = message?.author?.role;
      if (role === "user") return;
      if (!["assistant", "tool"].includes(role)) continue;
      if (message.status === "in_progress") {
        throw Object.assign(new Error("The current response is still in progress."), {
          tidyCode: global.TidyProtocol.ErrorCode.EXPORT_RESPONSE_PENDING,
        });
      }
      return;
    }
  }

  // Convert one canonical ChatGPT response into the shared export document.
  // Batch reads and the current-tab read deliberately use this same parser so
  // visible reasoning, web searches, citations, and active-branch filtering
  // cannot drift between export entry points. messageNumber is the logical
  // message sequence in this complete export, never a mounted DOM fallback.
  function documentFromPayload(payload, expectedConversationId, value = {}, sourceUrl = "", imageReferences = null) {
    // 流中的记录仍可用于原生编号，但不能成为可导出的文档/图片读取句柄。
    assertResponseNotInProgress(payload);
    // 原生投影只负责语义；导出契约与有效性校验由导出适配器拥有。
    const projected = projection.projectConversation(payload, expectedConversationId, value,
      sourceUrl || conversationSourceUrl(expectedConversationId), imageReferences);
    const document = { schemaVersion: contract.VERSION, ...projected };
    const validation = contract.validateDocument(document);
    if (!validation.valid) throw new Error(`Invalid current export document: ${validation.errors.join(", ")}`);
    return document;
  }

  async function resourceReadGuard(checkRoute = () => true) {
    pageSession.assertActive();
    // 先确认账号，再记住本次读取归属；首次正常登录不能被误判成中途切换账号。
    await chatgptApi.readLibraryAccount();
    pageSession.assertActive();
    const stamp = () => {
      const identity = chatgptApi.checkLibraryIdentity();
      return JSON.stringify([chatgptApi.activeWorkspace(), identity.accountKey, identity.epoch, identity.phase]);
    };
    const owner = stamp();
    return () => {
      pageSession.assertActive();
      if (!checkRoute() || stamp() !== owner) throw new Error("The export owner changed while image addresses were loading.");
    };
  }

  function registerImageResources(document, references, guard, gizmoId) {
    guard();
    const resolvedFiles = new Map();
    for (const resource of document.conversation.resources) {
      pageSession.assertActive();
      const fileId = references.get(resource.id);
      if (!fileId) continue;
      const readHandle = `image-${++imageSequence}-${Math.random().toString(36).slice(2)}`;
      resource.pending = true;
      resource.readHandle = readHandle;
      imageReads.set(readHandle, { resource: { ...resource }, fileId, guard, gizmoId, resolvedFiles });
      while (imageReads.size > 5000) imageReads.delete(imageReads.keys().next().value);
    }
    return document;
  }

  async function fetchImageAddress(fileId, gizmoId) {
    pageSession.assertActive();
    // 单张地址最多等 20 秒；项目图片沿用来源会话的项目，不借当前打开的其他项目。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    imageRequests.set(controller, timer);
    try {
      const projectQuery = typeof gizmoId === "string" && /^g-[a-z0-9-]+$/i.test(gizmoId)
        ? `&gizmo_id=${global.encodeURIComponent(gizmoId)}` : "";
      const response = await chatgptApi.fetchAuthenticated(
        `/backend-api/files/download/${global.encodeURIComponent(fileId)}?inline=false&download_intent=false${projectQuery}`,
        { headers: { Accept: "application/json" }, signal: controller.signal },
      );
      pageSession.assertActive();
      if (!response.ok) throw new Error("Image address unavailable");
      const data = await response.json();
      pageSession.assertActive();
      const url = new URL(data.download_url);
      // 只接受对应文件的原生签名地址，不转发 Bearer 到任意资源服务器。
      if (url.origin !== "https://chatgpt.com" || url.pathname !== "/backend-api/estuary/content"
        || url.username || url.password || url.searchParams.get("id") !== fileId) throw new Error("Invalid image address");
      return data;
    } finally {
      clearTimeout(timer);
      imageRequests.delete(controller);
    }
  }

  async function readImageResource({ readHandle } = {}) {
    pageSession.assertActive();
    const entry = imageReads.get(readHandle);
    if (!entry) throw new Error("The export image read expired. Refresh the content.");
    const { fileId, guard, gizmoId, resolvedFiles } = entry;
    guard();
    const resource = { ...entry.resource, pending: false };
    delete resource.readHandle;
    try {
      // 同一图片出现多次共用进行中的请求；签名地址仅存在本次导出内存中。
      if (!resolvedFiles.has(fileId)) resolvedFiles.set(fileId, fetchImageAddress(fileId, gizmoId).catch(() => {
        pageSession.assertActive();
        return null;
      }));
      const data = await resolvedFiles.get(fileId);
      pageSession.assertActive();
      if (!data) throw new Error("Image address unavailable");
      resource.src = data.download_url;
      resource.temporaryUrl = true;
      if (typeof data.file_name === "string" && data.file_name) resource.name = data.file_name;
      if (typeof data.mime_type === "string") resource.mimeType = data.mime_type;
      if (Number.isInteger(data.file_size_bytes) && data.file_size_bytes >= 0) resource.sizeBytes = data.file_size_bytes;
    } catch {
      // 只有单图故障可降级；页面停止必须向上失败，不能变成成功的空图片。
      pageSession.assertActive();
    }
    // 归属变化不是单图失败，不能吞掉；句柄淘汰也不能让迟到结果恢复旧资料。
    guard();
    if (imageReads.get(readHandle) !== entry) throw new Error("The export image read expired.");
    return { readHandle, resource };
  }

  async function fetchConversationDocument(expectedConversationId, value = {}, guard) {
    pageSession.assertActive();
    guard();
    const response = await chatgptApi.fetchAuthenticated(
      `/backend-api/conversation/${global.encodeURIComponent(expectedConversationId)}`,
      { headers: { Accept: "application/json" }, signal: pageSession.signal },
    );
    guard();
    if (!response.ok) throw new Error(`Conversation export failed (${response.status}) for ${expectedConversationId}.`);
    const payload = await response.json();
    guard();
    const responseId = responseConversationId(payload);
    if (responseId && responseId !== expectedConversationId) {
      throw new Error(`Conversation export identity changed for ${expectedConversationId}.`);
    }
    guard();
    const references = new Map();
    return registerImageResources(documentFromPayload(payload, expectedConversationId, value, "", references), references, guard, payload.gizmo_id);
  }

  // One conversation order for page, bookmarks and export. An assistant's
  // thinking/tool/final records belong to one logical reply, so every exact
  // source record in that reply receives the SAME number. Never number a
  // virtualized DOM slice or the native Fiber's local turnIndex.
  async function readCurrentConversation(value = {}, context = {}) {
    pageSession.assertActive();
    const expectedConversationId = value.expectedConversationId;
    const route = routeAdapter.parse();
    if (!expectedConversationId || !routeOwnsConversation(expectedConversationId, context)) {
      throw new Error("The current conversation changed before export started.");
    }
    const guard = await resourceReadGuard(() => routeOwnsConversation(expectedConversationId, context));
    guard();
    const response = await chatgptApi.fetchAuthenticated(
      `/backend-api/conversation/${global.encodeURIComponent(expectedConversationId)}`,
      { headers: { Accept: "application/json" }, signal: pageSession.signal },
    );
    pageSession.assertActive();
    if (!response.ok) throw new Error(`Current conversation export failed (${response.status}).`);
    const payload = await response.json();
    pageSession.assertActive();
    const responseId = responseConversationId(payload);
    if (responseId && responseId !== expectedConversationId) {
      throw new Error("The current conversation export identity changed.");
    }
    if (!routeOwnsConversation(expectedConversationId, context)) {
      throw new Error("The current conversation changed while export data was loading.");
    }
    guard();
    const references = new Map();
    return registerImageResources(documentFromPayload(payload, expectedConversationId, value, route.href, references), references, guard, payload.gizmo_id);
  }

  async function readConversations(value = {}) {
    pageSession.assertActive();
    const ids = [...new Set((Array.isArray(value.conversationIds) ? value.conversationIds : [])
      .filter((id) => typeof id === "string" && id.trim())
      .map((id) => id.trim()))];
    if (!ids.length) throw new Error("Batch export requires at least one conversation.");
    const fallbackTitles = value.fallbackTitles && typeof value.fallbackTitles === "object"
      ? value.fallbackTitles : {};
    const documents = [];
    const guard = await resourceReadGuard();
    guard();
    // Keep the request bounded and predictable. The API token is shared by the
    // adapter, while sequential reads avoid a burst when a large favorites
    // catalogue is selected.
    for (const conversationId of ids) {
      guard();
      const document = await fetchConversationDocument(conversationId, {
        fallbackTitle: fallbackTitles[conversationId],
      }, guard);
      guard();
      documents.push(document);
    }
    guard();
    return {
      schemaVersion: contract.COLLECTION_VERSION,
      documents,
    };
  }

  global.TidyChatgptExport = Object.freeze({
    markdownToBlocks,
    routeOwnsConversation,
    readCurrentConversation,
    readConversations,
    readImageResource,
  });
})(globalThis);
