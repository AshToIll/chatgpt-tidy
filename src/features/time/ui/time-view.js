import { TIME_VIEW_TEMPLATE } from "./time-template.js";

// 时间栏只拥有自己的表单、折叠状态和实时预览；偏好写入与页面准入由壳注入。
// 模板仅挂载一次，后续更新保持按钮节点、焦点和折叠行为不变。
export function createTimeView({ root, body, toggle, timeFormat, effectiveTimeZone, localeForLanguage, savePreference }) {
  root.innerHTML = TIME_VIEW_TEMPLATE;
  const elements = {
    body, timeEnabled: toggle,
    messageNumbers: root.querySelector("#message-numbers"),
    conversationPreview: root.querySelector("#conversation-preview"),
    messagePreview: root.querySelector("#message-preview"),
    listSummary: root.querySelector("#conversation-list-summary"),
    messageSummary: root.querySelector("#message-time-summary"),
  };
  let preferences, t, openDisclosure = null;

  function formatOptions(precision = preferences.conversationTimePrecision) {
    return {
      timeZone: effectiveTimeZone(preferences),
      locale: localeForLanguage(preferences.language),
      dateFormat: preferences.dateFormat,
      precision,
    };
  }

  function messageNumber(message) {
    if (!preferences.messageNumbersEnabled) return "";
    // order.index is only the mounted window's sorting position, not a global
    // conversation number. Keep its absence separate from the existing time UI.
    const number = message.order?.displayNumber;
    return Number.isSafeInteger(number) && number > 0 ? `#${number}` : "";
  }

  function messageTime(message) {
    if (!preferences.timeDisplayEnabled) return "";
    return timeFormat.formatDateTime(
      message.timestamp?.value,
      formatOptions(preferences.messageTimePrecision),
    ) || t("noTime");
  }

  function summaryLabel(key) {
    return t(key);
  }

  function renderDateFormatLabels() {
    const labels = timeFormat.dateFormatLabels(effectiveTimeZone(preferences));
    root.querySelectorAll('button[data-preference="dateFormat"]').forEach(button => {
      const label = labels[button.dataset.value];
      // 保留“跟随地区格式”的译文与默认标记；日期不变时也不重复改动 DOM。
      if (label && button.textContent !== label) button.textContent = label;
    });
  }

  function renderTimeControls() {
    renderDateFormatLabels();
    elements.timeEnabled.checked = preferences.timeDisplayEnabled;
    elements.timeEnabled.setAttribute("aria-checked", String(preferences.timeDisplayEnabled));
    elements.messageNumbers.checked = preferences.messageNumbersEnabled;
    elements.messageNumbers.setAttribute("aria-checked", String(preferences.messageNumbersEnabled));
    elements.body.classList.toggle("time-settings-disabled", !preferences.timeDisplayEnabled);

    root.querySelectorAll("button[data-preference]").forEach((button) => {
      const selected = preferences[button.dataset.preference] === button.dataset.value;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.disabled = !preferences.timeDisplayEnabled;
    });

    const listParts = [summaryLabel({ range: "timeRange", created: "createdTime", updated: "updatedTime" }[preferences.conversationTimeMode])];
    listParts.push(summaryLabel({
      date: "datePrecision",
      hour: "hour",
      minute: "minute",
    }[preferences.conversationTimePrecision]));
    elements.listSummary.innerHTML = listParts.map((part, index) => `${index ? '<span class="summary-separator">·</span>' : ""}${part}`).join("");
    elements.messageSummary.textContent = `${t(preferences.messageTimePosition)} · ${t(preferences.messageTimePrecision)}`;

    root.querySelectorAll("[data-disclosure-toggle]").forEach((button) => {
      const open = preferences.timeDisplayEnabled && openDisclosure === button.dataset.disclosureToggle;
      button.classList.toggle("is-open", open);
      button.setAttribute("aria-expanded", String(open));
      button.disabled = !preferences.timeDisplayEnabled;
      root.querySelector(`#${button.getAttribute("aria-controls")}`).hidden = !open;
    });
  }

  function renderPreview({ snapshot, preferences: nextPreferences, translator }) {
    preferences = nextPreferences; t = translator;
    const conversation = snapshot?.conversation;
    const conversationValue = conversation && preferences.timeDisplayEnabled
      ? timeFormat.formatConversation(conversation, {
        ...formatOptions(),
        mode: preferences.conversationTimeMode,
      }) || t("noTime")
      : "—";
    elements.conversationPreview.textContent = conversationValue;

    const message = [...(snapshot?.messages || [])].reverse().find((item) => item.timestamp?.value)
      || snapshot?.messages?.at?.(-1);
    elements.messagePreview.textContent = message
      ? [messageNumber(message), messageTime(message)].filter(Boolean).join("  ") || "—"
      : "—";

  }

  function changeEnabled() {
    if (!elements.timeEnabled.checked) openDisclosure = null;
    savePreference({ timeDisplayEnabled: elements.timeEnabled.checked });
  }
  function changeNumbers() {
    savePreference({ messageNumbersEnabled: elements.messageNumbers.checked });
  }
  function handleClick(event) {
    const preference = event.target.closest("button[data-preference]");
    if (preference && !preference.disabled) {
      savePreference({ [preference.dataset.preference]: preference.dataset.value });
      return;
    }
    const disclosure = event.target.closest("[data-disclosure-toggle]");
    if (disclosure && !disclosure.disabled) {
      openDisclosure = openDisclosure === disclosure.dataset.disclosureToggle ? null : disclosure.dataset.disclosureToggle;
      renderTimeControls();
    }
  }
  toggle.addEventListener("change", changeEnabled);
  elements.messageNumbers.addEventListener("change", changeNumbers);
  root.addEventListener("click", handleClick);

  return Object.freeze({
    renderControls({ preferences: nextPreferences, translator }) {
      preferences = nextPreferences; t = translator; renderTimeControls();
    },
    renderPreview,
    renderDateFormatLabels(nextPreferences) { preferences = nextPreferences; renderDateFormatLabels(); },
    setAvailable(available) { toggle.disabled = !available; },
    dispose() {
      toggle.removeEventListener("change", changeEnabled);
      elements.messageNumbers.removeEventListener("change", changeNumbers);
      root.removeEventListener("click", handleClick);
    },
  });
}
