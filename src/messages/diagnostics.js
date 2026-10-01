/* 提示诊断只观测，不控制业务：不读聊天、不直接存储或联网、不启动计时器。
 * 本地环形记录最多256条，文档关闭清空；可注入独立sink转交浏览器会话诊断层。
 * 控制台snapshot()/exportText()/clear()只操作当前文档记录，不冒充会话存储。
 * 禁止传 Error.message/details，白名单只接收代码常量和生成的操作编号。
 */
(function installDiagnostics(global) {
  "use strict";
  if (global.ChatGPTTidyDiagnostics) return;
  const LIMIT = 256, records = [], active = new Map();
  let serial = 0, slotSerial = 0, evictedActiveCount = 0;
  const owners = new Map();
  const slots = new WeakMap();
  function slot(owner) {
    try { if (!slots.has(owner)) slots.set(owner, "node-" + (++slotSerial)); return slots.get(owner); } catch { return null; }
  }
  const fallbackReason = "OBSERVATION_ONLY_UNSPECIFIED";
  function allowed(value, values, fallback = null) {
    return typeof value === "string" && Array.isArray(values) && values.includes(value) ? value : fallback;
  }
  function build() { return global.ChatGPTTidyBuildInfo || {}; }
  function code(value) { return allowed(value, build().reasonCodes, fallbackReason); }
  // Shared typed cause/ID sanitization; observation never controls lifecycle.
  const cause = global.ChatGPTTidyNoticeLifecycle.cause;
  let sink = null, sinkRegistration = null;
  function append(record) {
    const info = build();
    const saved = Object.freeze({ eventId: ++serial, at: Date.now(),
      version: typeof info.version === "string" ? info.version : "unverified",
      buildFingerprint: typeof info.fingerprint === "string" ? info.fingerprint : "unverified", ...record });
    records.push(saved);
    if (records.length > LIMIT) records.splice(0, records.length - LIMIT);
    // The optional transport is injected by the composition root. Never let a
    // synchronous throw or a rejected async sink interrupt UI or local history.
    try { const sent = sink?.(saved); if (sent && typeof sent.then === "function") Promise.resolve(sent).catch(() => {}); } catch { /* observation only */ }
    return saved;
  }
  // 原生网页可直接移除父节点；弱引用只用于观测，不保留DOM或改变其生命周期。
  // 清除时间是首次观测到脱离的时间，不冒充原生移除瞬间；无额外定时器。
  function sweepDetached() {
    for (const [key, reference] of owners) {
      try {
        const owner = reference.deref();
        if (owner && owner.isConnected !== false) continue;
        const previous = active.get(key);
        owners.delete(key); active.delete(key);
        if (previous) append({ ...previous, event: "clear", clearReasonCode: "OWNER_NODE_DETACHED" });
      } catch { /* 不能让观测DOM属性干扰业务。 */ }
    }
  }
  function notice(input) {
    try {
      sweepDetached();
      const surface = allowed(input?.surface, global.ChatGPTTidyNoticeRegistry?.surfaces?.map(item => item.surface));
      if (!surface) return null;
      const instanceId = typeof input.instanceId === "string" && /^node-\d+$/.test(input.instanceId) ? input.instanceId : null;
      const activeKey = surface + ":" + (instanceId || "single");
      const previous = active.get(activeKey);
      if (input.event === "clear") {
        if (!previous) return null;
        active.delete(activeKey); owners.delete(activeKey);
        return append({ ...previous, event: "clear", clearReasonCode: code(input.reasonCode) });
      }
      if (input.event !== "show") return null;
      if (input.ownerNode?.isConnected === false) return null;
      const info = build(), messageKey = allowed(input.messageKey, info.messageKeys);
      if (!messageKey) return null;
      const safeCause = cause(input);
      const record = { event: "show", surface, instanceId, messageKey, reasonCode: code(input.reasonCode),
        source: allowed(input.source, info.sources, "SOURCE_NOT_REGISTERED"),
        requestId: safeCause.requestId, navigationIntentId: safeCause.navigationIntentId, jobId: safeCause.jobId,
        stage: safeCause.stage, disconnect: safeCause.disconnect, status: safeCause.status, retryable: safeCause.retryable };
      // 同一可见提示重绘不是新出现；切语言不重新计时或制造诊断噪声。
      if (previous && JSON.stringify(previous) === JSON.stringify(record)) return null;
      if (previous) append({ ...previous, event: "clear", clearReasonCode: "NOTICE_REPLACED" });
      if (!previous && active.size >= LIMIT) {
        const oldest = active.keys().next().value;
        active.delete(oldest); owners.delete(oldest); evictedActiveCount++;
        // 容量淘汰不是用户界面清除，故不伪造 clear 事件。
      }
      active.set(activeKey, record);
      if (input.ownerNode && typeof global.WeakRef === "function") owners.set(activeKey, new global.WeakRef(input.ownerNode));
      return append(record);
    } catch { return null; } // 观测失败绝不能中断显示、清除、请求或下载。
  }
  function snapshot() {
    sweepDetached();
    return { limit: LIMIT, activeCount: active.size, evictedActiveCount, lifetime: "current-document", events: records.map(record => ({ ...record })) };
  }
  global.ChatGPTTidyDiagnostics = Object.freeze({ notice, cause, slot, snapshot,
    setSink(next) {
      if (next !== null && typeof next !== "function") throw new TypeError("Diagnostic sink must be a function or null");
      const registration = {};
      sink = next; sinkRegistration = registration;
      return () => { if (sinkRegistration === registration) { sink = null; sinkRegistration = null; } };
    },
    exportText() { try { return JSON.stringify(snapshot(), null, 2); } catch { return "{}"; } },
    clear() { records.length = 0; active.clear(); owners.clear(); evictedActiveCount = 0; } });
})(globalThis);
