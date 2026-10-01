/* 只在本地观测之后排队；不注册业务 listener，不轮询，不自动重试。
 * 最多 64 条等待 + 16 条在途；丢弃/失败数随复制诊断导出，绝不伪称保存成功。
 */
(function installDiagnosticsClientFactory(global) {
  "use strict";
  if (global.TidyDiagnosticsTransport) return;
  function createClient({ runtime, buildInfo = global.ChatGPTTidyBuildInfo,
    registry = global.ChatGPTTidyNoticeRegistry, diagnostics = global.ChatGPTTidyDiagnostics,
    crypto = global.crypto }) {
    const wire = global.TidyDiagnosticsWire;
    const contract = wire.createContract({ buildInfo, registry, sanitizeCause: value => diagnostics.cause(value) });
    const contextId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
    let generation = null, queue = [], flight = null, attached = null, detachSink = null, attachmentToken = null;
    let disposed = false, stopped = false, clearing = false, epoch = 0, observedSequence = 0;
    const counters = { overflow: 0, invalid: 0, transport: 0, staleGeneration: 0, cleared: 0,
      transportFailures: 0, storageFailures: 0, acknowledged: 0 };
    const failure = code => Object.assign(new Error(code), { code });
    const message = operation => ({ channel: wire.CHANNEL, operation, fingerprint: contract.fingerprint });
    function status() {
      return { ...counters, pending: queue.length, inFlight: flight?.count || 0,
        recording: !disposed && !stopped, disposed };
    }
    async function send(envelope) {
      let result;
      try { result = await runtime.sendMessage(envelope); }
      catch { counters.transportFailures++; throw failure("DIAGNOSTICS_TRANSPORT_FAILED"); }
      if (result?.code === "DIAGNOSTICS_STORAGE_FAILED") counters.storageFailures++;
      return result;
    }
    function dropPending(field) { counters[field] += queue.length; queue = []; }
    function pump() {
      if (disposed || stopped || clearing || flight || (!queue.length && generation !== null)) return;
      const operation = { epoch, count: 0, generation };
      const batch = generation === null ? [] : queue.splice(0, wire.limits.batch);
      operation.count = batch.length; flight = operation;
      // Promise.resolve 边界捕获同步 transport 失败；没有定时器或失败重试。
      operation.promise = Promise.resolve().then(() => send({ ...message("record"), contextId, generation: operation.generation, events: batch }))
        .then(result => {
          if (disposed || operation.epoch !== epoch) return;
          if (result?.ok === true && result.persisted === true && wire.token(result.generation)
            && wire.integer(result.accepted) && result.accepted <= batch.length) {
            generation = result.generation; counters.acknowledged += result.accepted; return;
          }
          if (result?.code === "DIAGNOSTICS_STALE_GENERATION" && wire.token(result.generation)) {
            counters.staleGeneration += batch.length; dropPending("staleGeneration");
            generation = result.generation; return;
          }
          counters.transport += batch.length; dropPending("transport"); stopped = true;
        }, () => {
          if (disposed || operation.epoch !== epoch) return;
          counters.transport += batch.length; dropPending("transport"); stopped = true;
        })
        .finally(() => {
          if (flight === operation) flight = null;
          if (!disposed && !stopped) pump();
        });
    }
    function observe(record) {
      try {
        if (disposed) return;
        const event = contract.project(record);
        if (!event || !contract.validEvent(event)) { counters.invalid++; return; }
        if (event.sequence <= observedSequence) return;
        observedSequence = event.sequence;
        if (stopped) { counters.transport++; return; }
        queue.push(event);
        if (queue.length > wire.limits.pending) { queue.shift(); counters.overflow++; }
        pump();
      } catch { counters.invalid++; } // 永不把诊断失败传播给提示绘制。
    }
    async function read() {
      if (disposed) throw failure("DIAGNOSTICS_DISPOSED");
      const result = await send(message("read"));
      if (result?.ok !== true || !contract.validSnapshot(result.snapshot)) throw failure("DIAGNOSTICS_READ_FAILED");
      return result.snapshot;
    }
    return Object.freeze({
      attach(observer = diagnostics) {
        if (disposed) return () => {};
        if (attached === observer) return () => {};
        detachSink?.(); attached = observer; const registration = {}; attachmentToken = registration;
        // snapshot会同步扫除脱离节点并追加clear；先暂停sink交付，再按完整快照序号回放。
        // 否则新增高序号clear会让去重水位提前跳过前面的show历史。
        let snapshotting = true, events;
        detachSink = observer.setSink(record => { if (!snapshotting) observe(record); });
        try { events = observer.snapshot().events; } finally { snapshotting = false; }
        for (const event of events) observe(event);
        pump();
        return () => { if (attachmentToken === registration) {
          detachSink?.(); detachSink = null; attached = null; attachmentToken = null;
        } };
      },
      read,
      async exportText() {
        const snapshot = await read();
        const local = status();
        // 快照不等待所有文档排空；用户必须能分辨“当前没有已保存记录”与“诊断可能缺失”。
        const incomplete = local.pending + local.inFlight + local.overflow + local.invalid + local.transport
          + local.transportFailures + local.storageFailures + snapshot.storageFailures + snapshot.queueDroppedEvents
          + snapshot.dropped.capacity + snapshot.dropped.duplicateOrOutOfOrder > 0;
        return { eventCount: snapshot.events.length, incomplete,
          text: JSON.stringify({ ...snapshot, incomplete, client: local }, null, 2) };
      },
      async clear() {
        if (disposed) throw failure("DIAGNOSTICS_DISPOSED");
        const token = ++epoch; clearing = true; counters.cleared += flight?.count || 0; dropPending("cleared");
        try {
          const result = await send(message("clear"));
          if (disposed || token !== epoch) throw failure("DIAGNOSTICS_DISPOSED");
          if (result?.ok !== true || !contract.validSnapshot(result.snapshot)) {
            throw failure("DIAGNOSTICS_CLEAR_FAILED");
          }
          generation = result.snapshot.generation; stopped = false;
          // 只清观测缓存，不撤销或隐藏任何真实业务提示。
          attached?.clear?.();
          return result.snapshot;
        } catch (error) {
          if (!disposed && token === epoch) { stopped = true; dropPending("transport"); }
          throw error;
        } finally {
          if (token === epoch) { clearing = false; if (!flight) pump(); }
        }
      },
      status,
      dispose() {
        if (disposed) return;
        disposed = true; epoch++; detachSink?.(); detachSink = null; attached = null; attachmentToken = null;
        dropPending("cleared");
      },
    });
  }
  global.TidyDiagnosticsTransport = Object.freeze({ createClient });
})(globalThis);
