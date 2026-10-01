// 会话内唯一诊断写入者。所有 get/set/clear 走同一尾链，避免冷启动与清空竞态。
// session.set 同时提交 generation、游标与记录；失败不发布内存副本，也不假称保存成功。
export const DIAGNOSTICS_STORAGE_KEY = "tidy.diagnostics.session.v1";
export function createDiagnosticsSessionStore({ storage, contract, wire, randomToken }) {
  const { limits, shape, token, integer } = wire;
  let state = null, tail = Promise.resolve(), storageFailures = 0;
  let queuedOperations = 0, queuedEvents = 0, queueRejectedOperations = 0, queueDroppedEvents = 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  const size = value => new TextEncoder().encode(JSON.stringify(value)).length;
  function empty() {
    return { schema: 1, version: contract.version, fingerprint: contract.fingerprint, generation: randomToken(),
      revision: 0, dropped: { capacity: 0, duplicateOrOutOfOrder: 0, staleGeneration: 0 },
      contexts: [], events: [] };
  }
  function coherentCursors(value) {
    const cursors = new Map(value.contexts.map(context => [context.contextId, context.sequence]));
    const seen = new Map();
    return value.events.every(({ contextId, event }) => {
      if (!cursors.has(contextId) || event.sequence > cursors.get(contextId)
        || event.sequence <= (seen.get(contextId) || 0)) return false;
      seen.set(contextId, event.sequence); return true;
    });
  }
  function isState(value) {
    try {
      return shape(value, ["schema", "version", "fingerprint", "generation", "revision", "dropped", "contexts", "events"])
        && value.schema === 1 && value.version === contract.version && value.fingerprint === contract.fingerprint
        && token(value.generation) && integer(value.revision)
        && shape(value.dropped, ["capacity", "duplicateOrOutOfOrder", "staleGeneration"])
        && Object.values(value.dropped).every(number => integer(number))
        && Array.isArray(value.contexts) && value.contexts.length <= limits.contexts && wire.dense(value.contexts)
        && value.contexts.every(context => shape(context, ["contextId", "sequence"]) && token(context.contextId) && integer(context.sequence, 1))
        && new Set(value.contexts.map(context => context.contextId)).size === value.contexts.length
        && Array.isArray(value.events) && value.events.length <= limits.records && wire.dense(value.events)
        && value.events.every(entry => shape(entry, ["contextId", "event"]) && token(entry.contextId) && contract.validEvent(entry.event))
        && coherentCursors(value) && size(value) <= limits.bytes;
    } catch { return false; }
  }
  async function write(next) {
    try { await storage.set({ [DIAGNOSTICS_STORAGE_KEY]: next }); }
    catch { storageFailures++; throw Object.assign(new Error("DIAGNOSTICS_STORAGE_FAILED"), { code: "DIAGNOSTICS_STORAGE_FAILED" }); }
    state = next;
  }
  async function hydrate() {
    if (state) return;
    let saved;
    try { saved = (await storage.get(DIAGNOSTICS_STORAGE_KEY))?.[DIAGNOSTICS_STORAGE_KEY]; }
    catch { storageFailures++; throw Object.assign(new Error("DIAGNOSTICS_STORAGE_FAILED"), { code: "DIAGNOSTICS_STORAGE_FAILED" }); }
    // 构建变化/损坏数据不得把未知字段带入导出；没有旧格式兼容分支。
    if (isState(saved)) state = clone(saved);
    else await write(empty());
  }
  function serial(action, eventCount = 0) {
    // 多个合法文档遇到慢storage也不能制造无界Promise/闭包队列。只拒绝诊断，业务不受影响。
    if (queuedOperations >= limits.queuedOperations || queuedEvents + eventCount > limits.queuedEvents) {
      queueRejectedOperations++; queueDroppedEvents += eventCount;
      return Promise.reject(Object.assign(new Error("DIAGNOSTICS_CAPACITY"), { code: "DIAGNOSTICS_CAPACITY" }));
    }
    queuedOperations++; queuedEvents += eventCount;
    const result = tail.then(async () => { await hydrate(); return action(); });
    tail = result.catch(() => {});
    return result.finally(() => { queuedOperations--; queuedEvents -= eventCount; });
  }
  function publicSnapshot() {
    return { schema: 1, version: state.version, buildFingerprint: state.fingerprint, lifetime: "browser-session",
      limit: limits.records, byteLimit: limits.bytes, storedBytes: size(state), generation: state.generation,
      revision: state.revision, persisted: true, dropped: clone(state.dropped), storageFailures,
      queueRejectedOperations, queueDroppedEvents,
      events: state.events.map(({ contextId, event }) => ({ contextId, ...event })) };
  }
  return Object.freeze({
    read() { return serial(() => publicSnapshot()); },
    clear() {
      return serial(async () => {
        const next = empty(); next.revision = state.revision + 1;
        await write(next); return publicSnapshot();
      });
    },
    record({ contextId, generation, events }) {
      return serial(async () => {
        if (generation === null && events.length === 0) return { generation: state.generation, accepted: 0, persisted: true };
        const next = clone(state);
        if (generation !== state.generation) {
          next.dropped.staleGeneration += events.length; next.revision++;
          await write(next);
          return { stale: true, generation: state.generation, accepted: 0, persisted: true };
        }
        let accepted = 0, context = next.contexts.find(item => item.contextId === contextId);
        for (const event of events) {
          if (context && event.sequence <= context.sequence) { next.dropped.duplicateOrOutOfOrder++; continue; }
          if (!context) {
            context = { contextId, sequence: event.sequence };
            next.contexts.push(context);
          } else context.sequence = event.sequence;
          next.events.push({ contextId, event: clone(event) }); accepted++;
        }
        // 活跃文档游标也有界；容量淘汰不是业务生命周期，不伪造 clear。
        if (next.contexts.length > limits.contexts) {
          const removed = new Set(next.contexts.splice(0, next.contexts.length - limits.contexts).map(item => item.contextId));
          const kept = next.events.filter(item => !removed.has(item.contextId));
          next.dropped.capacity += next.events.length - kept.length; next.events = kept;
        }
        while (next.events.length > limits.records) { next.events.shift(); next.dropped.capacity++; }
        next.revision++;
        while (size(next) > limits.bytes && next.events.length) { next.events.shift(); next.dropped.capacity++; }
        await write(next);
        return { generation: state.generation, accepted, persisted: true };
      }, events.length);
    },
  });
}
