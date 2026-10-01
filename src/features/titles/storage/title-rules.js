import { TITLE_RULES_KEY, normalizeTitleRules, titleRulesPatch } from "../model/title-rules.js";
import { getPreferences } from "../../../platform/preferences/preferences.js";

// 只由后台调用。所有侧栏共用同一条写入队列，每次只提交刚改的字段，
// 排到自己时再读最新设置，避免窗口 A 的日期格式被窗口 B 的旧快照覆盖。
export function createTitleRulesStore({ storage = globalThis.chrome.storage.local, defaults = getPreferences } = {}) {
  let writes = Promise.resolve();
  async function read() {
    const stored = (await storage.get(TITLE_RULES_KEY))?.[TITLE_RULES_KEY];
    const valid = titleRulesPatch(stored);
    return normalizeTitleRules(valid, Object.keys(valid).length === 2 ? undefined : await defaults());
  }
  function update(value) {
    const patch = titleRulesPatch(value);
    if (!value || Array.isArray(value) || !Object.keys(patch).length
      || Object.keys(value).some(key => !Object.hasOwn(patch, key))) {
      return Promise.reject(Object.assign(new TypeError("Invalid title settings patch"), { tidyCode: "VALIDATION_ERROR" }));
    }
    const operation = writes.then(async () => {
      const current = await read(); // 读取失败就停止；不能把默认值当成已保存值覆盖回去。
      const next = { ...current, ...patch };
      if (next.mode !== current.mode || next.dateFormat !== current.dateFormat) {
        await storage.set({ [TITLE_RULES_KEY]: next });
      }
      return next;
    });
    writes = operation.catch(() => {}); // 一次失败不堵住后面的保存；本次调用仍然收到异常。
    return operation;
  }
  return Object.freeze({ read, update });
}

let store;
export function getTitleRules() { return (store ||= createTitleRulesStore()).read(); }
export function updateTitleRules(patch) { return (store ||= createTitleRulesStore()).update(patch); }
