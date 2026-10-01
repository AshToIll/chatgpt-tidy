import { escapeHtml } from "./html.js";

// 只负责名称草稿与字段反馈，不创建分组、不提交请求，也不读取栏目仓库。
export function createGroupNameEditor({ id, onValidation = () => {} }) {
  let state = null;
  let revealPending = false;
  const errorId = id + "-error";

  function setRequired(required, reason) {
    if (!state || state.required === required) return;
    state.required = required;
    onValidation(required, reason);
  }
  function close(reason = "FORM_CANCELLED") {
    setRequired(false, reason);
    state = null;
    revealPending = false;
  }
  function open({ groupId = null, value = "" }) {
    close("FORM_REPLACED");
    state = { groupId, value: String(value), required: false };
  }
  function validate(value) {
    if (!state) return null;
    state.value = String(value ?? "");
    const name = state.value.trim();
    revealPending = !name;
    setRequired(!name, name ? "FORM_SUBMITTED" : "VALIDATION_ERROR");
    return name || null;
  }
  function updateInput(input) {
    if (!state) return;
    state.value = input.value;
    if (!state.required || !state.value.trim()) return;
    setRequired(false, "NAME_EDITED");
    revealPending = false;
    // 输入时只移除错误，不重绘 input；中文输入法、选区与草稿保持原位。
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-describedby");
    input.closest("form")?.querySelector("[data-group-name-error]")?.remove();
  }
  function inputMarkup({ label }) {
    if (!state) return "";
    const invalid = state.required ? ' aria-invalid="true" aria-describedby="' + escapeHtml(errorId) + '"' : "";
    return '<input name="name" data-group-name-input class="library-group-name-input" value="' + escapeHtml(state.value)
      + '" maxlength="24" aria-label="' + escapeHtml(label) + '" required' + invalid + ' />';
  }
  function errorMarkup({ message }) {
    return state?.required
      ? '<span class="library-group-name-error" data-group-name-error id="' + escapeHtml(errorId) + '" role="alert">' + escapeHtml(message) + '</span>'
      : "";
  }
  function revealInvalid({ root, viewport }) {
    // 每次无效提交只定位一次；后台快照/翻译重绘不能反复抢焦点。
    if (!state?.required || !revealPending) return;
    const input = root.querySelector("[data-group-name-input]");
    const form = input?.closest("form");
    if (!input || !form) return;
    revealPending = false;
    input.focus({ preventScroll: true });
    // 只移动明确传入的分组滚动区，不能让整页、会话列表或用户正文跳动。
    // 调用方应在本轮恢复列表 scrollTop 后调用，并保存调整后的 scrollTop。
    if (!viewport || !viewport.contains(form)) return;
    const bounds = viewport.getBoundingClientRect();
    const row = form.getBoundingClientRect();
    const top = bounds.top + (Number(viewport.clientTop) || 0);
    const bottom = Number(viewport.clientHeight) > 0 ? top + viewport.clientHeight : bounds.bottom;
    const margin = 4;
    let delta = 0;
    if (row.bottom + margin > bottom) delta = row.bottom + margin - bottom;
    if (row.top - margin < top) delta = row.top - margin - top;
    if (delta) viewport.scrollTop = Math.max(0, viewport.scrollTop + delta);
  }
  return Object.freeze({ get state() { return state; }, open, close, validate, updateInput, inputMarkup, errorMarkup, revealInvalid });
}
