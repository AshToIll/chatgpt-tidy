import { TITLE_RULES_KEY, normalizeTitleRules, titleRulesPatch } from "../model/title-rules.js";
import "../../../platform/protocol.js";

const sameRules = (a, b) => a.mode === b.mode && a.dateFormat === b.dateFormat;
const safeCause = error => globalThis.ChatGPTTidyDiagnostics?.cause(error)
  || Object.freeze({ reasonCode: "OBSERVATION_ONLY_UNSPECIFIED", requestId: null });

// 界面只发字段补丁，不直接写 storage。保留立即预览，后台负责跨窗口串行保存。
async function requestRules(type, patch) {
  const protocol = globalThis.TidyProtocol, envelope = protocol.request(type, patch);
  let result;
  try { result = await chrome.runtime.sendMessage(envelope); }
  catch (error) {
    throw Object.assign(new Error("Title settings request failed"), {
      code: error?.code, tidyCode: error?.tidyCode, requestId: envelope.requestId,
    });
  }
  const invalid = () => Object.assign(new Error("Title settings request failed"), {
    code: "TITLE_INVALID_RESPONSE", tidyCode: "TITLE_INVALID_RESPONSE", requestId: envelope.requestId,
  });
  if (!protocol.isResponse(result, envelope.requestId) || result.type !== type) throw invalid();
  if (!result.ok) throw Object.assign(new Error(result.error?.message || "Title settings request failed"), {
    code: result.error?.code, tidyCode: result.error?.code, details: result.error?.details, requestId: envelope.requestId,
  });
  if (Object.keys(titleRulesPatch(result.payload)).length !== 2) throw invalid();
  return result.payload;
}

function listenToRules(listener) {
  const changes = globalThis.chrome?.storage?.onChanged;
  const onChanged = (values, area) => {
    if (area === "local" && Object.hasOwn(values, TITLE_RULES_KEY)) listener(values[TITLE_RULES_KEY].newValue);
  };
  changes?.addListener(onChanged);
  return () => changes?.removeListener(onChanged);
}

export function createTitleRulesController({
  read = () => requestRules(globalThis.TidyProtocol.Type.TITLE_RULES_GET),
  write = patch => requestRules(globalThis.TidyProtocol.Type.TITLE_RULES_UPDATE, patch),
  listen = listenToRules,
} = {}) {
  let preferences = {}, confirmed = normalizeTitleRules(null), ready = false, error = null, revision = 0;
  let initialization = null, saving = Promise.resolve(), draining = false, disposed = false, eventVersion = 0;
  // 只有新增失败证据推进 errorVersion；纯重绘或成功回执不能撤销在途只读核对的资格。
  let readVersion = 0, errorVersion = 0, generation = 0, suspended = false, seeded = false, operationId = 0;
  let readFailure = null, errorCause = null, errorRecoveryCause = null;
  const active = epoch => !disposed && !suspended && epoch === generation;
  const pending = [], failures = new Map(), listeners = new Set();
  let current = Object.freeze({ rules: Object.freeze({ ...confirmed }), ready, error, saving: false, revision });

  // 错误属于具体操作和字段，而不是全局“最后一次结果”。未知写入优先显示；
  // 新选择只能预览，不能把旧失败当成已经解决，也不能抹掉另一个字段的失败。
  function refreshError() {
    const outstanding = [...failures.values()];
    const failure = outstanding.findLast(item => item.type === "unconfirmed")
      || outstanding.findLast(item => item.type === "save") || readFailure;
    error = failure?.type || null;
    errorCause = failure?.cause || null;
    errorRecoveryCause = failure?.recoveryCause || null;
  }

  function clearErrors() {
    failures.clear(); readFailure = null; refreshError();
  }

  function failRead(cause) {
    errorVersion++;
    const latestCause = safeCause(cause);
    readFailure = { type: "load", cause: latestCause };
    // 核对失败只更新最新读取原因，未知写入仍保留原操作及其写入原因。
    for (const failure of failures.values()) {
      if (failure.type === "unconfirmed") failure.recoveryCause = latestCause;
    }
    refreshError();
  }

  function failSave(operation, type, cause, fields, recoveryCause = null) {
    errorVersion++; // 即使新字段失败被更高优先级 unknown 遮住，也必须挡住旧核对的清除。
    failures.set(operation.id, { type, fields: new Set(fields), cause: safeCause(cause),
      recoveryCause: recoveryCause ? safeCause(recoveryCause) : null });
    refreshError();
  }

  function confirmSave(operation, receipt) {
    const covered = Object.keys(operation.patch).filter(key => receipt[key] === operation.patch[key]);
    for (const [id, failure] of failures) {
      // 只有较新的、确实成功覆盖该字段的操作能清除已知保存失败。
      // unconfirmed 必须留给显式只读核对；成功写别的字段不是旧请求的回执。
      if (id >= operation.id || failure.type !== "save") continue;
      for (const key of covered) failure.fields.delete(key);
      if (!failure.fields.size) failures.delete(id);
    }
    readFailure = null; refreshError();
  }

  function publish() {
    if (disposed) return current;
    const rules = pending.reduce((value, operation) => ({ ...value, ...operation.patch }), confirmed);
    if (sameRules(rules, current.rules) && ready === current.ready && error === current.error
      && errorCause === (current.errorCause || null) && errorRecoveryCause === (current.errorRecoveryCause || null)
      && Boolean(pending.length) === current.saving) return current;
    // 可选 cause 只含诊断白名单代码与请求编号，不保留 Error.message/details 或会话内容。
    current = Object.freeze({ rules: Object.freeze(rules), ready, error,
      ...(errorCause ? { errorCause } : {}), ...(errorRecoveryCause ? { errorRecoveryCause } : {}),
      saving: Boolean(pending.length), revision: ++revision });
    for (const listener of [...listeners]) {
      try { listener(current); } catch { /* 一个已卸载的视图不应阻断另一个视图。 */ }
    }
    return current;
  }

  const unlisten = listen(value => {
    if (!active(generation)) return;
    eventVersion++;
    confirmed = normalizeTitleRules(value, preferences);
    publish(); // 新通知更新已保存基线，但不撤销本窗口正在保存的选择。
  });

  async function load(epoch = generation) {
    if (!active(epoch)) return;
    const version = eventVersion, reading = ++readVersion;
    const value = await read();
    if (active(epoch) && reading === readVersion && version === eventVersion) confirmed = normalizeTitleRules(value, preferences);
  }

  function drain() {
    if (draining || !active(generation) || !ready || !pending.length) return;
    const epoch = generation;
    draining = true;
    saving = (async () => {
      while (pending.length && active(epoch)) {
        const operation = pending[0], { patch } = operation, version = eventVersion;
        try {
          const receipt = normalizeTitleRules(await write(patch), preferences);
          if (!active(epoch)) return;
          confirmSave(operation, receipt);
          if (version === eventVersion) { confirmed = receipt; eventVersion++; }
          else if (!sameRules(confirmed, receipt)) {
            // 别的窗口可能已在本次回执之后保存。只读最新存储，不用旧回执拉回界面。
            try { await load(epoch); } catch (cause) { if (active(epoch)) failRead(cause); }
          }
        } catch (cause) {
          if (!active(epoch)) return;
          try {
            await load(epoch);
            if (!active(epoch)) return;
            // 回执丢失不等于没保存；读回一致的字段按已确认处理，不重复写入。
            confirmSave(operation, confirmed);
            const missing = Object.keys(patch).filter(key => confirmed[key] !== patch[key]);
            if (missing.length) failSave(operation, "save", cause, missing);
          } catch (recoveryCause) {
            if (active(epoch)) failSave(operation, "unconfirmed", cause, Object.keys(patch), recoveryCause);
          } // 读回也失败，保留写入原因及核对失败原因，等待用户显式重新读取。
        }
        if (!active(epoch)) return;
        pending.shift();
        publish(); // 失败只撤回本次选择；后面还在排队的字段继续即时显示。
      }
      if (active(epoch)) draining = false;
    })();
  }

  function initialize(seed = preferences) {
    if (disposed) return Promise.resolve(current);
    if (suspended) { preferences = seed; return Promise.resolve(current); }
    if (initialization) return ready ? Promise.resolve(current) : initialization;
    preferences = seed;
    // 初次读取前默认创建日期，仅日期格式沿用全局设置；不自动将默认值写回存储。
    if (!seeded && !eventVersion) confirmed = normalizeTitleRules(null, preferences);
    seeded = true;
    const errorsBeforeRead = errorVersion, epoch = generation;
    // 手动重读的旧回包不能抹掉用户随后遇到的保存失败。
    initialization = Promise.resolve().then(() => load(epoch)).then(
      () => { if (active(epoch) && errorsBeforeRead === errorVersion) clearErrors(); },
      cause => { if (active(epoch) && errorsBeforeRead === errorVersion) failRead(cause); })
      .then(() => { if (active(epoch)) { ready = true; publish(); drain(); } return current; });
    publish();
    return initialization;
  }

  function update(value) {
    if (!active(generation)) return current;
    const patch = titleRulesPatch(value);
    for (const key of Object.keys(patch)) if (ready && patch[key] === current.rules[key]) delete patch[key];
    if (!Object.keys(patch).length) return current;
    pending.push({ id: ++operationId, patch });
    publish(); // 同一事件内通知单条、批量视图，无需等待保存或再次验证账号。
    if (!initialization) void initialize();
    drain();
    return current;
  }

  function suspend() {
    if (disposed || suspended) return current;
    // 页面准入失效即切断整个保存队列。已发请求无法撤回，但其回执、失败读回和
    // 存储通知都不能重新激活旧会话；恢复后仅重新读取，不重放用户的旧写操作。
    suspended = true; generation++; readVersion++;
    pending.length = 0; ready = false; initialization = null;
    saving = Promise.resolve(); draining = false; clearErrors();
    return publish();
  }

  return Object.freeze({ snapshot: () => current, initialize, update, suspend,
    resume() {
      if (disposed) return Promise.resolve(current);
      suspended = false;
      return initialize();
    },
    // ready 只表示首次读取已结束。error 区分读取失败、保存失败和无法确认，不能据此冒充保存成功。
    retry() { if (!active(generation)) return Promise.resolve(current); initialization = null; return initialize(); },
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("Title rules subscriber must be a function");
      if (disposed) return () => {};
      listeners.add(listener); return () => listeners.delete(listener);
    },
    // 返回是否确认成功，而不是“Promise 结束就代表已经保存”。错误同时留给界面展示。
    whenSaved: async () => {
      const epoch = generation;
      if (!active(epoch)) return false;
      await initialization;
      if (!active(epoch)) return false;
      await saving;
      return active(epoch) && ready && !error;
    },
    dispose() {
      if (disposed) return;
      disposed = true; generation++; readVersion++; pending.length = 0; failures.clear(); readFailure = null;
      initialization = null; saving = Promise.resolve(); draining = false;
      unlisten(); listeners.clear();
    },
  });
}

let sharedTitleRulesController = null;
export function getTitleRulesController() {
  return sharedTitleRulesController ||= createTitleRulesController();
}
