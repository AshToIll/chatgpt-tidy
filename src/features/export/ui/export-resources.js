// 正文与图片分开就绪：只为当前实际选择的图片查地址，最多同时 3 个请求。
// 关图/离开后不派发后续请求；已发出的少量请求不能把旧账号或旧文档写回。
export function createExportResources({ request, onResolved, validResource }) {
  const CONCURRENCY = 3;
  let owner = null, epoch = 0, active = false, targets = new Map(), scheduled = false;
  const running = new Map(), delivered = new Set();

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    Promise.resolve().then(() => { scheduled = false; pump(); });
  }

  function pump() {
    if (!active) return;
    for (const [handle, target] of targets) {
      if (running.size >= CONCURRENCY) break;
      if (!target.pending || running.has(handle) || delivered.has(handle)) continue;
      const ticket = { epoch, target, owner };
      running.set(handle, ticket);
      Promise.resolve().then(() => {
        if (!active || epoch !== ticket.epoch || targets.get(handle) !== target) throw new Error('Retired image read');
        return request({ readHandle: handle, expectedAccountKey: ticket.owner });
      })
        .then(result => {
          if (result?.readHandle !== handle || result.resource?.id !== target.id
            || result.resource?.type !== 'image' || result.resource.pending || !validResource(result.resource)) {
            throw new Error('Invalid export image response');
          }
          return result.resource;
        })
        .catch(() => ({ ...target, src: '', pending: false }))
        .then(resource => {
          if (!active || epoch !== ticket.epoch || targets.get(handle) !== target) return;
          // Transport publishes a scoped receipt; only the document owner writes.
          delivered.add(handle);
          onResolved({ accountKey: ticket.owner, readHandle: handle, resource });
        })
        .finally(() => { running.delete(handle); schedule(); });
    }
  }

  return {
    update({ accountKey, enabled, resources }) {
      if (owner !== accountKey || (active && !enabled)) { epoch++; delivered.clear(); }
      owner = accountKey; active = enabled;
      targets = new Map((resources || []).filter(r => r.pending && r.readHandle).map(r => [r.readHandle, r]));
      for (const handle of delivered) if (!targets.has(handle)) delivered.delete(handle);
      schedule();
    },
  };
}
