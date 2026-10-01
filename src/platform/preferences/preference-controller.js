import { DEFAULT_PREFERENCES, normalizePreferences } from "./preferences.js";

const keys = Object.keys(DEFAULT_PREFERENCES);
const changedKeys = (before, after) => keys.filter(key => before[key] !== after[key]);

// 设置只有一份已保存基线；尚未完成的本地选择覆盖在上面，避免旧通知把新选择拉回去。
// 存储通知是唯一订阅入口。保存回执只负责确认；必要时读回存储，不另触发全界面刷新。
export function createPreferenceController({ read, write, onChanged, onError = () => {}, onLoaded = () => {} }) {
  let confirmed = normalizePreferences(), displayed = confirmed;
  let eventVersion = 0, readVersion = 0, generation = 0, drainingGeneration = null;
  let suspended = false, disposed = false;
  // 读失败可由权威存储通知恢复；写入结果未知必须等明确读回或保存确认。
  let failureAction = null;
  const pending = [];
  const current = cycle => !disposed && cycle === generation;
  const writable = cycle => current(cycle) && !suspended;
  function publish() {
    if (disposed) return;
    const next = pending.reduce((value, operation) => ({ ...value, ...operation.patch }), confirmed);
    const changed = changedKeys(displayed, next);
    if (!changed.length) return;
    displayed = next;
    onChanged({ ...next }, changed);
  }
  function reportFailure(error, action) {
    // 再次读取失败不证明此前写入未发生，不能把“待确认”降级成普通读取错误。
    if (action === "read" && failureAction === "save") return;
    failureAction = action;
    onError(error, action);
  }
  function confirmLoaded() {
    failureAction = null;
    onLoaded();
  }
  function observe(value) {
    if (disposed) return;
    const cycle = generation, version = ++eventVersion;
    confirmed = normalizePreferences(value || {});
    publish();
    // 即使值未变化（没有重绘），完整权威通知也足以结束读取故障。
    // 写入未知不能被无关设置通知抹去；生命周期/更新代次变化同样撤销此回调。
    if (current(cycle) && version === eventVersion && failureAction === "read") confirmLoaded();
  }
  async function load({ reportError = true } = {}) {
    // Connecting pages may still read their language/theme. A lifecycle change
    // retires reads already in flight, without forbidding a new bootstrap read.
    if (disposed) return false;
    const cycle = generation, version = ++readVersion, events = eventVersion;
    try {
      const value = await read();
      if (!current(cycle)) return false;
      if (version !== readVersion || events !== eventVersion) return true;
      confirmed = normalizePreferences(value);
      publish();
      if (!current(cycle)) return false;
      confirmLoaded();
      return true;
    } catch (error) {
      if (current(cycle) && reportError && version === readVersion && events === eventVersion) reportFailure(error, "read");
      return false;
    }
  }
  async function drain() {
    const cycle = generation;
    if (!writable(cycle) || drainingGeneration === cycle) return;
    // A retired write may never settle. A new manual choice after resume gets
    // its own drain; the old drain cannot shift or dispatch this new queue.
    drainingGeneration = cycle;
    try {
      while (writable(cycle) && pending.length) {
        const operation = pending[0];
        let ok = false;
        try {
          const value = await write(operation.patch);
          if (!writable(cycle)) return;
          const receipt = normalizePreferences(value);
          // 通知可能先于回执，也可能晚于回执。已有同一结果就不读、不画；
          // 不一致时只读最新存储，不能用延迟回执覆盖其他窗口更新的值。
          ok = changedKeys(confirmed, receipt).length ? await load() : true;
        } catch (error) {
          if (!writable(cycle)) return;
          // 写入和补读都失败时只提示这次保存失败，不连续弹两条相同提醒。
          await load({ reportError: false });
          if (!writable(cycle)) return;
          reportFailure(error, "save");
        }
        if (!writable(cycle)) return;
        pending.shift();
        publish(); // 失败仅撤回本次乐观显示，后续选择继续保留。
        if (ok && writable(cycle)) confirmLoaded();
        operation.resolve(ok && writable(cycle));
      }
    } finally { if (drainingGeneration === cycle) drainingGeneration = null; }
  }
  function save(patch) {
    if (!writable(generation)) return Promise.resolve(false);
    const normalized = normalizePreferences({ ...displayed, ...patch });
    const changed = keys.filter(key => Object.hasOwn(patch, key) && displayed[key] !== normalized[key]);
    if (!changed.length) return Promise.resolve(true);
    const operation = { patch: Object.fromEntries(changed.map(key => [key, normalized[key]])) };
    const result = new Promise(resolve => { operation.resolve = resolve; });
    pending.push(operation);
    publish(); // 点击立即响应，保存排队不锁住界面。
    void drain();
    return result;
  }
  function retirePending() {
    generation++; readVersion++;
    for (const operation of pending.splice(0)) operation.resolve(false);
  }
  function suspend() {
    if (disposed || suspended) return;
    suspended = true;
    retirePending();
    publish(); // 撤回未确认选择，不让旧队列在新页面准入后自动重放。
  }
  function resume() {
    if (disposed) return false;
    suspended = false;
    return true; // 只开放未来的手动选择；不启动旧写入或补读。
  }
  function dispose() {
    if (disposed) return;
    disposed = true; suspended = true;
    retirePending();
    displayed = confirmed;
  }
  return Object.freeze({ save, observe, load, suspend, resume, dispose, current: () => ({ ...displayed }) });
}
