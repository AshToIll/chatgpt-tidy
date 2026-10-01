import "../../../platform/catalog/date-search.js";

const CALENDAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14.5" rx="2"></rect><path d="M8 3.5v4M16 3.5v4M4 9.5h16"></path></svg>';

// 日历只管理正在选择的起止日期、显示月份和年/月/日视图，不自行发起查询。
// 搜索页接收选中日期并安排查询；时区和有效日期边界统一由 TidyDateSearch 计算。
export function createSearchCalendar({ root, readSelection, isRangeValid, translate, onRender, onChange }) {
  const document = root.ownerDocument;
  const dateContract = globalThis.TidyDateSearch;
  const t = translate;
  const state = { target: null, month: "", view: "days" };

  function padDatePart(value) {
    return String(value).padStart(2, "0");
  }

  function parseDateValue(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return null;
    const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
    const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    return check.getUTCFullYear() === parts.year
      && check.getUTCMonth() === parts.month - 1
      && check.getUTCDate() === parts.day ? parts : null;
  }

  function todayParts() {
    const selection = readSelection();
    return parseDateValue(dateContract.searchDateBounds(selection.timeZone).maxDate);
  }

  function dateKey(year, monthIndex, day) {
    return `${year}-${padDatePart(monthIndex + 1)}-${padDatePart(day)}`;
  }

  function calendarMonthParts() {
    const selection = readSelection();
    const selected = parseDateValue(`${state.month}-01`);
    const seed = selected || parseDateValue(selection.startDate || selection.endDate) || todayParts();
    const { minDate, maxDate } = dateContract.searchDateBounds(selection.timeZone);
    const monthKey = dateKey(seed.year, seed.month - 1, 1).slice(0, 7);
    const bounded = monthKey < minDate.slice(0, 7) ? minDate : monthKey > maxDate.slice(0, 7) ? maxDate : null;
    return bounded ? parseDateValue(bounded) : seed;
  }

  function setCalendarMonth(year, month) {
    const selection = readSelection();
    const normalized = new Date(Date.UTC(year, month - 1, 1));
    const key = `${normalized.getUTCFullYear()}-${padDatePart(normalized.getUTCMonth() + 1)}`;
    const { minDate, maxDate } = dateContract.searchDateBounds(selection.timeZone);
    state.month = key < minDate.slice(0, 7) ? minDate.slice(0, 7)
      : key > maxDate.slice(0, 7) ? maxDate.slice(0, 7) : key;
  }

  // Month/year cells are available when any day intersects the product range.
  // Reuse this guard for clicks as detached controls may outlive a timezone change.
  function calendarPeriodAllowed(year, month = null, bounds = dateContract.searchDateBounds(readSelection().timeZone)) {
    if (!Number.isInteger(year) || (month !== null && (!Number.isInteger(month) || month < 1 || month > 12))) return false;
    const { minDate, maxDate } = bounds;
    const start = dateKey(year, month === null ? 0 : month - 1, 1);
    const end = month === null ? dateKey(year, 11, 31)
      : dateKey(year, month - 1, new Date(Date.UTC(year, month, 0)).getUTCDate());
    return start <= maxDate && end >= minDate;
  }

  function calendarYearRange(year) {
    const start = Math.floor(year / 12) * 12;
    return { start, end: start + 11 };
  }

  function makeDateField(target, labelText, value) {
    const field = document.createElement("div");
    field.className = "search-date-field";
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.searchDate = target;
    button.setAttribute("aria-label", labelText);
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", String(state.target === target));
    const display = document.createElement("span");
    display.textContent = value || labelText;
    button.append(display);
    button.insertAdjacentHTML("beforeend", CALENDAR_ICON);
    field.append(button);
    return field;
  }

  function makeDateControl() {
    const selection = readSelection();
    const group = document.createElement("div");
    group.className = "search-date-control-group";
    const label = document.createElement("span");
    label.className = "search-control-caption";
    label.textContent = t("searchDateRange");
    const range = document.createElement("div");
    range.className = "search-date-range";
    range.setAttribute("aria-label", t("searchDateRange"));
    const divider = document.createElement("span");
    divider.className = "search-date-range__divider";
    divider.setAttribute("aria-hidden", "true");
    divider.textContent = "~";
    range.append(
      makeDateField("start", t("searchStartDate"), selection.startDate),
      divider,
      makeDateField("end", t("searchEndDate"), selection.endDate),
    );
    group.append(label, range);
    return group;
  }

  function makeCalendarNavigationButton(direction, label, disabled = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.calendarNav = direction;
    button.disabled = disabled;
    button.setAttribute("aria-label", label);
    const glyph = document.createElement("span");
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = direction === "previous" ? "‹" : "›";
    button.append(glyph);
    return button;
  }

  // 日历输出 YYYY-MM-DD 日期，不自行换算时间戳。
  // 日期范围是否合法、在全局时区下对应哪段时间，仍由共享日期模块判断。
  function makeSearchCalendar() {
    const selection = readSelection();
    if (!state.target) return null;
    const { year, month } = calendarMonthParts();
    const bounds = dateContract.searchDateBounds(selection.timeZone);
    const { minDate, maxDate: todayKey } = bounds;
    const earliest = parseDateValue(minDate);
    const today = parseDateValue(todayKey);
    const view = state.view;
    const yearRange = calendarYearRange(year);
    const previousDisabled = view === "days"
      ? year < earliest.year || (year === earliest.year && month <= earliest.month)
      : view === "months" ? year <= earliest.year : yearRange.start <= earliest.year;
    const nextDisabled = view === "days"
      ? year > today.year || (year === today.year && month >= today.month)
      : view === "months" ? year >= today.year : yearRange.end >= today.year;
    const unitKey = view === "days" ? "Month" : view === "months" ? "Year" : "YearGroup";

    const layer = document.createElement("div");
    layer.className = "search-calendar-layer";
    layer.dataset.searchCalendarLayer = "";
    const calendar = document.createElement("div");
    calendar.className = "search-calendar";
    calendar.role = "dialog";
    calendar.setAttribute("aria-label", t("searchCalendarDialog", {
      target: state.target === "start" ? t("searchStartDate") : t("searchEndDate"),
    }));

    const header = document.createElement("header");
    const title = document.createElement("button");
    title.type = "button";
    title.className = "search-calendar__title";
    title.dataset.calendarViewToggle = "";
    title.disabled = view === "years";
    title.setAttribute("aria-label", t(view === "days" ? "searchCalendarChooseMonth" : view === "months" ? "searchCalendarChooseYear" : "searchCalendarYearRange"));
    title.textContent = view === "days"
      ? t("searchCalendarMonthTitle", { year, month })
      : view === "months"
        ? t("searchCalendarYearTitle", { year })
        : t("searchCalendarYearRangeTitle", yearRange);
    header.append(
      makeCalendarNavigationButton("previous", t(`searchCalendarPrevious${unitKey}`), previousDisabled),
      title,
      makeCalendarNavigationButton("next", t(`searchCalendarNext${unitKey}`), nextDisabled),
    );
    calendar.append(header);

    if (view === "days") {
      const weekdays = document.createElement("div");
      weekdays.className = "search-calendar__weekdays";
      for (const label of t("searchCalendarWeekdays").split(",")) {
        const day = document.createElement("span");
        day.textContent = label;
        weekdays.append(day);
      }
      const days = document.createElement("div");
      days.className = "search-calendar__days";
      const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const previousMonthDays = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
      const selectedValue = state.target === "start" ? selection.startDate : selection.endDate;
      const rangeValid = isRangeValid();
      for (let index = 0; index < 42; index += 1) {
        const offset = index - firstWeekday + 1;
        let cellYear = year;
        let cellMonthIndex = month - 1;
        let day = offset;
        let outside = false;
        if (offset <= 0) {
          outside = true;
          day = previousMonthDays + offset;
          cellMonthIndex -= 1;
        } else if (offset > daysInMonth) {
          outside = true;
          day = offset - daysInMonth;
          cellMonthIndex += 1;
        }
        if (cellMonthIndex < 0) { cellMonthIndex = 11; cellYear -= 1; }
        if (cellMonthIndex > 11) { cellMonthIndex = 0; cellYear += 1; }
        const value = dateKey(cellYear, cellMonthIndex, day);
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.calendarDate = value;
        button.setAttribute("aria-label", value);
        button.disabled = value < minDate || value > todayKey;
        button.textContent = String(day);
        button.classList.toggle("is-outside", outside);
        button.classList.toggle("is-disabled", button.disabled);
        button.classList.toggle("is-in-range", Boolean(selection.startDate && selection.endDate && rangeValid && value > selection.startDate && value < selection.endDate));
        button.classList.toggle("is-range-edge", value === selection.startDate || value === selection.endDate);
        button.classList.toggle("is-selected", value === selectedValue);
        button.classList.toggle("is-today", value === todayKey);
        days.append(button);
      }
      calendar.append(weekdays, days);
    } else {
      const choices = document.createElement("div");
      choices.className = `search-calendar__choices search-calendar__choices--${view}`;
      if (view === "months") {
        for (let value = 1; value <= 12; value += 1) {
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.calendarMonthChoice = String(value);
          button.disabled = !calendarPeriodAllowed(year, value, bounds);
          button.classList.toggle("is-selected", value === month);
          button.textContent = t("searchCalendarMonthChoice", { month: value });
          choices.append(button);
        }
      } else {
        for (let index = 0; index < 12; index += 1) {
          const value = yearRange.start + index;
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.calendarYearChoice = String(value);
          button.disabled = !calendarPeriodAllowed(value, null, bounds);
          button.classList.toggle("is-selected", value === year);
          button.textContent = String(value);
          choices.append(button);
        }
      }
      calendar.append(choices);
    }

    const footer = document.createElement("footer");
    const clear = document.createElement("button");
    clear.type = "button";
    clear.dataset.calendarClear = state.target;
    clear.textContent = t("searchCalendarClear");
    const close = document.createElement("button");
    close.type = "button";
    close.dataset.calendarClose = "";
    close.textContent = t("searchCalendarDone");
    footer.append(clear, close);
    calendar.append(footer);
    layer.append(calendar);
    return layer;
  }

  function positionSearchCalendar(view) {
    const layer = view?.querySelector("[data-search-calendar-layer]");
    const calendar = layer?.querySelector(".search-calendar");
    const anchor = view?.querySelector(`[data-search-date="${state.target}"]`);
    if (!layer || !calendar || !anchor) return;
    const viewRect = view.getBoundingClientRect();
    const panelRect = view.closest(".time-panel")?.getBoundingClientRect() || viewRect;
    const anchorRect = anchor.getBoundingClientRect();
    const width = calendar.offsetWidth;
    const height = calendar.offsetHeight;
    // Keep the popup inside the panel, with a 10px edge inset and 7px gap
    // from its endpoint. Flip above when the space below is insufficient.
    const safeInset = 10;
    const minLeft = panelRect.left + safeInset - viewRect.left;
    const maxLeft = Math.max(minLeft, panelRect.right - safeInset - viewRect.left - width);
    const preferredLeft = state.target === "end" ? maxLeft : minLeft;
    const left = Math.min(Math.max(preferredLeft, minLeft), maxLeft);
    const below = anchorRect.bottom - viewRect.top + 7;
    const above = anchorRect.top - viewRect.top - height - 7;
    const maxTop = Math.max(safeInset, viewRect.height - height - safeInset);
    const top = below + height <= viewRect.height - safeInset ? below : Math.max(safeInset, Math.min(above, maxTop));
    calendar.style.left = `${left}px`;
    calendar.style.top = `${top}px`;
  }

  // Calendar rerenders replace DOM nodes (including during directory progress).
  // Preserve only a focused date control, never pull focus back from elsewhere.
  // Semantic data keys also let day/month/year transitions choose a new target.
  const dateFocusKeys = ["searchDate", "calendarNav", "calendarViewToggle", "calendarDate",
    "calendarMonthChoice", "calendarYearChoice", "calendarClear", "calendarClose"];

  function focusedDateControl(active) {
    if (!active || !root.contains(active)) return null;
    const key = dateFocusKeys.find((name) => Object.hasOwn(active.dataset || {}, name));
    return key ? { key, value: active.dataset[key] } : null;
  }

  function restoreDateControlFocus(request) {
    if (!request) return;
    // Attribute names are our fixed keys; compare values without inserting them
    // into a CSS selector, so focus restoration cannot depend on CSS escaping.
    const key = dateFocusKeys.includes(request.key) ? request.key : "calendarDate";
    const attribute = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    let target = [...root.querySelectorAll(`[data-${attribute}]`)]
      .find((node) => node.dataset[key] === request.value && !node.disabled);
    if (!target && state.target) {
      const choices = [...root.querySelectorAll("[data-calendar-date], [data-calendar-month-choice], [data-calendar-year-choice]")]
        .filter((node) => !node.disabled);
      target = choices.find((node) => node.matches(".is-selected"))
        || choices.find((node) => !node.matches(".is-outside")) || choices[0];
    }
    target?.focus({ preventScroll: true });
  }

  function click(targetNode) {
    const selection = readSelection();
    let closedCalendar = false;
    if (state.target && !targetNode.closest("[data-search-calendar-layer], [data-search-date]")) {
      close();
      closedCalendar = true;
      // A result click may now update selection without calling onRender().
      // Close just the overlay and its two toggles, never the result viewport.
      root.querySelector(".search-overlay-layer")?.replaceChildren();
      for (const button of root.querySelectorAll("[data-search-date]")) button.setAttribute("aria-expanded", "false");
    }
    const dateButton = targetNode.closest("[data-search-date]");
    if (dateButton) {
      const target = dateButton.dataset.searchDate === "end" ? "end" : "start";
      if (state.target === target) {
        close();
      } else {
        state.target = target;
        state.view = "days";
        const seed = target === "start" ? selection.startDate : selection.endDate;
        const fallback = selection.startDate || selection.endDate;
        const today = todayParts();
        state.month = (seed || fallback || `${today.year}-${padDatePart(today.month)}-${padDatePart(today.day)}`).slice(0, 7);
      }
      onRender({ dateFocus: state.target
        ? { key: "calendarDate", value: target === "start" ? selection.startDate : selection.endDate }
        : { key: "searchDate", value: target } });
      return { handled: true, closed: closedCalendar };
    }
    const calendarNav = targetNode.closest("[data-calendar-nav]");
    if (calendarNav && !calendarNav.disabled) {
      const { year, month } = calendarMonthParts();
      const direction = calendarNav.dataset.calendarNav === "previous" ? -1 : 1;
      if (state.view === "days") setCalendarMonth(year, month + direction);
      else setCalendarMonth(year + (state.view === "years" ? direction * 12 : direction), month);
      onRender();
      return { handled: true, closed: closedCalendar };
    }
    const calendarViewToggle = targetNode.closest("[data-calendar-view-toggle]");
    if (calendarViewToggle && !calendarViewToggle.disabled) {
      state.view = state.view === "days" ? "months" : "years";
      const { year, month } = calendarMonthParts();
      onRender({ dateFocus: { key: state.view === "months" ? "calendarMonthChoice" : "calendarYearChoice",
        value: String(state.view === "months" ? month : year) } });
      return { handled: true, closed: closedCalendar };
    }
    const monthChoice = targetNode.closest("[data-calendar-month-choice]");
    if (monthChoice && !monthChoice.disabled) {
      const { year } = calendarMonthParts();
      const month = Number(monthChoice.dataset.calendarMonthChoice);
      if (!calendarPeriodAllowed(year, month)) return { handled: true, closed: closedCalendar };
      setCalendarMonth(year, month);
      state.view = "days";
      onRender({ dateFocus: { key: "calendarDate", value: state.target === "start" ? selection.startDate : selection.endDate } });
      return { handled: true, closed: closedCalendar };
    }
    const yearChoice = targetNode.closest("[data-calendar-year-choice]");
    if (yearChoice && !yearChoice.disabled) {
      const { month } = calendarMonthParts();
      const year = Number(yearChoice.dataset.calendarYearChoice);
      if (!calendarPeriodAllowed(year)) return { handled: true, closed: closedCalendar };
      setCalendarMonth(year, month);
      state.view = "months";
      onRender({ dateFocus: { key: "calendarMonthChoice", value: String(month) } });
      return { handled: true, closed: closedCalendar };
    }
    const calendarDate = targetNode.closest("[data-calendar-date]");
    if (calendarDate && !calendarDate.disabled && state.target) {
      const value = calendarDate.dataset.calendarDate;
      const { minDate, maxDate } = dateContract.searchDateBounds(selection.timeZone);
      if (!parseDateValue(value) || value < minDate || value > maxDate) return { handled: true, closed: closedCalendar };
      const target = state.target;
      // The chosen endpoint wins; publish both dates atomically. Only the
      // parent invalidates results and schedules the resulting query.
      let { startDate, endDate } = selection;
      if (target === "start") {
        startDate = value;
        if (endDate && value > endDate) endDate = value;
      } else {
        endDate = value;
        if (startDate && value < startDate) startDate = value;
      }
      close();
      onChange({ startDate, endDate }, target);
      return { handled: true, closed: closedCalendar };
    }
    const calendarClear = targetNode.closest("[data-calendar-clear]");
    if (calendarClear) {
      const target = calendarClear.dataset.calendarClear;
      close();
      onChange({ startDate: target === "start" ? "" : selection.startDate,
        endDate: target === "end" ? "" : selection.endDate }, target);
      return { handled: true, closed: closedCalendar };
    }
    if (targetNode.closest("[data-calendar-close]")) {
      const target = close();
      onRender({ dateFocus: { key: "searchDate", value: target } });
      return { handled: true, closed: closedCalendar };
    }
    return { handled: false, closed: closedCalendar };
  }

  // Close is deliberately render-free: mode/tab changes render once in their
  // owner, and result clicks must not remount the result viewport.
  function close() {
    const target = state.target;
    state.target = null;
    state.view = "days";
    return target;
  }

  function keydown(event) {
    if (!state.target || event.key !== "Escape") return false;
    event.preventDefault();
    event.stopPropagation?.();
    onRender({ dateFocus: { key: "searchDate", value: close() } });
    return true;
  }

  function dismissOutside(target) {
    if (!state.target || root.contains(target)) return;
    close();
    onRender();
  }

  return Object.freeze({ controls: makeDateControl, overlay: makeSearchCalendar,
    position: () => positionSearchCalendar(root), close, click, keydown, dismissOutside,
    captureFocus: focusedDateControl, restoreFocus: restoreDateControlFocus });
}
