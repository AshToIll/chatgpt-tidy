/* 独立诊断传输契约；不复用业务准入，不允许把任意对象写入留存。
 * 关联号验证复用 messages observer.cause；这里只投影，不复制其正则。
 */
(function installDiagnosticsWire(global) {
  "use strict";
  if (global.TidyDiagnosticsWire) return;
  const limits = Object.freeze({ records: 512, bytes: 262144, batch: 16, pending: 64, contexts: 128, queuedOperations: 32, queuedEvents: 128 });
  const CHANNEL = "tidy.diagnostics.v1";
  const eventKeys = ["sequence", "at", "event", "surface", "instanceId", "messageKey", "reasonCode", "source",
    "requestId", "navigationIntentId", "jobId", "stage", "disconnect", "status", "retryable", "clearReasonCode"];
  function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
  function shape(value, keys) {
    if (!object(value)) return false;
    const actual = Reflect.ownKeys(value);
    return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key)
      && Object.getOwnPropertyDescriptor(value, key)?.get === undefined
      && Object.getOwnPropertyDescriptor(value, key)?.set === undefined);
  }
  function dense(array) {
    return Array.isArray(array) && Reflect.ownKeys(array).length === array.length + 1
      && Array.from({ length: array.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(array, index);
        return descriptor && Object.hasOwn(descriptor, "value");
      }).every(Boolean);
  }
  function token(value) { return typeof value === "string" && /^[a-f0-9]{32}$/.test(value); }
  function integer(value, minimum = 0) { return Number.isSafeInteger(value) && value >= minimum && !Object.is(value, -0); }
  function createContract({ buildInfo, registry, sanitizeCause }) {
    const surfaces = new Set((registry?.surfaces || []).map(item => item.surface));
    const keys = new Set(buildInfo?.messageKeys || []), reasons = new Set(buildInfo?.reasonCodes || []);
    const sources = new Set(buildInfo?.sources || []);
    const fingerprint = buildInfo?.fingerprint;
    function project(input) {
      try {
        if (!input || input.buildFingerprint !== fingerprint || input.version !== buildInfo.version) return null;
        if (!integer(input.eventId, 1) || !integer(input.at) || !["show", "clear"].includes(input.event)) return null;
        if (!surfaces.has(input.surface) || !keys.has(input.messageKey)) return null;
        const cause = sanitizeCause({ code: input.reasonCode, requestId: input.requestId,
          navigationIntentId: input.navigationIntentId, jobId: input.jobId, stage: input.stage,
          disconnect: input.disconnect, status: input.status, retryable: input.retryable });
        return { sequence: input.eventId, at: input.at, event: input.event, surface: input.surface,
          instanceId: typeof input.instanceId === "string" && /^node-[1-9]\d{0,14}$/.test(input.instanceId) ? input.instanceId : null,
          messageKey: input.messageKey, reasonCode: cause.reasonCode,
          source: sources.has(input.source) ? input.source : "SOURCE_NOT_REGISTERED",
          requestId: cause.requestId, navigationIntentId: cause.navigationIntentId, jobId: cause.jobId,
          stage: cause.stage ?? null, disconnect: cause.disconnect ?? null, status: cause.status ?? null, retryable: cause.retryable ?? null,
          clearReasonCode: input.event === "clear" && reasons.has(input.clearReasonCode) ? input.clearReasonCode : null };
      } catch { return null; }
    }
    function validEvent(event) {
      try {
        if (!shape(event, eventKeys)) return false;
        const projected = project({ ...event, eventId: event.sequence, version: buildInfo.version, buildFingerprint: fingerprint });
        return projected !== null && eventKeys.every(key => projected[key] === event[key])
          && reasons.has(event.reasonCode)
          && (event.event === "show" ? event.clearReasonCode === null : reasons.has(event.clearReasonCode));
      } catch { return false; }
    }
    function validRequest(message) {
      try {
        if (message?.channel !== CHANNEL || message.fingerprint !== fingerprint) return false;
        if (message.operation === "read" || message.operation === "clear") {
          return shape(message, ["channel", "operation", "fingerprint"]);
        }
        return message.operation === "record"
          && shape(message, ["channel", "operation", "fingerprint", "contextId", "generation", "events"])
          && token(message.contextId) && (message.generation === null || token(message.generation))
          && Array.isArray(message.events) && message.events.length <= limits.batch && dense(message.events)
          && (message.generation !== null || message.events.length === 0)
          && message.events.every(validEvent);
      } catch { return false; }
    }
    function validSnapshot(snapshot) {
      try {
        const fields = ["schema", "version", "buildFingerprint", "lifetime", "limit", "byteLimit", "storedBytes",
          "generation", "revision", "persisted", "dropped", "storageFailures", "queueRejectedOperations", "queueDroppedEvents", "events"];
        return shape(snapshot, fields) && snapshot.schema === 1 && snapshot.version === buildInfo.version
          && snapshot.buildFingerprint === fingerprint && snapshot.lifetime === "browser-session"
          && snapshot.limit === limits.records && snapshot.byteLimit === limits.bytes
          && integer(snapshot.storedBytes) && snapshot.storedBytes <= limits.bytes && token(snapshot.generation)
          && integer(snapshot.revision) && snapshot.persisted === true && integer(snapshot.storageFailures)
          && integer(snapshot.queueRejectedOperations) && integer(snapshot.queueDroppedEvents)
          && shape(snapshot.dropped, ["capacity", "duplicateOrOutOfOrder", "staleGeneration"])
          && Object.values(snapshot.dropped).every(value => integer(value))
          && Array.isArray(snapshot.events) && snapshot.events.length <= limits.records && dense(snapshot.events)
          && snapshot.events.every(entry => {
            if (!shape(entry, ["contextId", ...eventKeys]) || !token(entry.contextId)) return false;
            const { contextId, ...event } = entry; return validEvent(event);
          });
      } catch { return false; }
    }
    return Object.freeze({ project, validEvent, validRequest, validSnapshot, fingerprint, version: buildInfo?.version });
  }
  global.TidyDiagnosticsWire = Object.freeze({ CHANNEL, limits, shape, dense, token, integer, createContract });
})(globalThis);
