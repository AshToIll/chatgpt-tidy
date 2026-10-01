(function initTidyExportPreviewPresentation(global) {
  "use strict";

  const protocol = global.TidyProtocol;
  const preview = global.TidyExportPreview;
  const pageSession = global.TidyPageSession;
  if (!protocol || !preview || !pageSession || global.__tidyExportPreviewPresentationStarted || !pageSession.check()) return;
  global.__tidyExportPreviewPresentationStarted = true;

  const HOST_ID = "tidy-export-preview-host";
  const EDGE_GAP = 10;
  const FORMATS = new Set(["markdown", "json", "txt", "pdf"]);
  const PDF_PAGE_SIZES = new Set(["A4", "Letter"]);
  const PDF_ORIENTATIONS = new Set(["portrait", "landscape"]);
  const PDF_FONT_SIZES = new Set(["small", "standard", "large"]);
  const PDF_PAGE_POINTS = Object.freeze({ A4: [595.28, 841.89], Letter: [612, 792] });
  // Keep these point sizes aligned with src/features/export/engine/pdf.js. Both page geometry
  // and type are converted through the same 96dpi browser scale below.
  const PDF_FONT_POINTS = Object.freeze({ small: 9.5, standard: 10.75, large: 12 });
  const CSS_PIXELS_PER_POINT = 96 / 72;

  let presentation = null;

  const STYLES = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      display: block;
      color-scheme: light;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    :host([data-color-scheme="dark"]) { color-scheme: dark; }
    *, *::before, *::after { box-sizing: border-box; }
    .export-full-preview-layer { position: absolute; inset: 0; overflow: hidden; }
    .export-full-preview__dialog::backdrop {
      background: rgba(28, 29, 34, .18);
      backdrop-filter: blur(1.5px);
    }
    .export-full-preview__dialog {
      position: fixed;
      right: auto;
      bottom: auto;
      top: 50%;
      left: 50%;
      width: min(960px, calc(100% - 48px));
      max-height: calc(100% - 48px);
      max-width: none;
      margin: 0;
      padding: 0;
      color: inherit;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      overflow: hidden;
      border: 1px solid #d9dade;
      border-radius: 11px;
      background: #fff;
      box-shadow: 0 18px 48px rgba(30, 31, 37, .2);
      transform: translate(-50%, -50%);
    }
    .export-full-preview__dialog.is-pdf-landscape { width: min(1200px, calc(100% - 48px)); }
    .export-full-preview__dialog > header {
      min-height: 52px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 0 15px;
      border-bottom: 1px solid #ececef;
      cursor: grab;
      touch-action: none;
      user-select: none;
    }
    .export-full-preview__dialog.is-dragging > header { cursor: grabbing; }
    .export-full-preview__dialog > header > div { min-width: 0; display: grid; gap: 3px; }
    .export-full-preview__dialog > header strong { color: #45474e; font-size: 15px; font-weight: 600; }
    .export-full-preview__dialog > header small {
      overflow: hidden;
      color: #92949a;
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .export-full-preview__dialog > header button {
      width: 27px;
      height: 27px;
      flex: 0 0 auto;
      padding: 0;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: #85878d;
      font: 18px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: pointer;
    }
    .export-full-preview__dialog > header button:hover,
    .export-full-preview__dialog > header button:focus-visible {
      background: #f2f2f4;
      color: #55575d;
      outline: none;
    }
    .export-full-preview__body {
      min-height: 0;
      overflow: auto;
      padding: 18px;
      scrollbar-gutter: stable;
      scrollbar-width: thin;
    }
    .export-preview__document {
      min-width: 0;
      max-width: 860px;
      margin: 0 auto;
      border: 1px solid #ececef;
      border-radius: 8px;
      background: #fff;
      color: #50525a;
    }
    /* PDF points map to CSS pixels at the browser's native 96dpi scale. The
       page therefore opens at visual 100%, rather than reusing the 9px compact
       thumbnail scale from the Side Panel. */
    .export-preview__document--pdf {
      width: var(--preview-page-width);
      max-width: none;
      min-height: var(--preview-page-height);
      padding: 64px;
    }
    .export-preview__document--letter { border-top: 3px solid #f4f4f6; }
    .export-preview__code {
      margin: 0;
      padding: 18px;
      overflow: visible;
      background: #fafafa;
      color: #55575d;
      font: 15px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .export-preview__document--pdf .export-preview__code {
      padding: 0;
      font-family: "Noto Sans SC", "Microsoft YaHei", "PingFang SC", ui-sans-serif, sans-serif;
      font-size: var(--preview-font-size);
      line-height: 1.6;
    }
    :host([data-color-scheme="dark"]) .export-full-preview__dialog::backdrop { background: rgba(0, 0, 0, .36); }
    :host([data-color-scheme="dark"]) .export-full-preview__dialog {
      border-color: #343439;
      background: #212121;
    }
    :host([data-color-scheme="dark"]) .export-full-preview__dialog > header { border-color: #343439; }
    :host([data-color-scheme="dark"]) .export-full-preview__dialog > header strong { color: #f2f2f2; }
    :host([data-color-scheme="dark"]) .export-full-preview__dialog > header small,
    :host([data-color-scheme="dark"]) .export-full-preview__dialog > header button { color: #a7a7ad; }
    :host([data-color-scheme="dark"]) .export-full-preview__dialog > header button:hover,
    :host([data-color-scheme="dark"]) .export-full-preview__dialog > header button:focus-visible {
      background: #2a2a2a;
      color: #f2f2f2;
    }
    :host([data-color-scheme="dark"]) .export-preview__document { border-color: #44444a; }
    :host([data-color-scheme="dark"]) .export-preview__document:not(.export-preview__document--pdf),
    :host([data-color-scheme="dark"]) .export-preview__document:not(.export-preview__document--pdf) .export-preview__code {
      background: #212121;
      color: #f2f2f2;
    }
    :host([data-color-scheme="dark"]) .export-preview__document--pdf.export-preview__document--light,
    :host([data-color-scheme="dark"]) .export-preview__document--pdf.export-preview__document--light .export-preview__code {
      background: #fafafa;
      color: #55575d;
    }
    @media (max-width: 760px) {
      .export-full-preview__dialog { width: calc(100% - 24px); max-height: calc(100% - 24px); }
      .export-full-preview__body { padding: 12px; }
    }
  `;

  function validPayload(payload) {
    return Boolean(
      payload
      && typeof payload.sessionId === "string" && payload.sessionId
      && typeof payload.title === "string"
      && typeof payload.closeLabel === "string"
      && typeof payload.summary === "string"
      && typeof payload.content === "string"
      && (payload.format !== "pdf" || preview.valid(payload.previewParts))
      && FORMATS.has(payload.format),
    );
  }

  function pdfClassNames(pdf) {
    if (!pdf) return [];
    return [
      "export-preview__document--light",
      PDF_FONT_SIZES.has(pdf.fontSize) ? `export-preview__document--${pdf.fontSize}` : "export-preview__document--standard",
      PDF_ORIENTATIONS.has(pdf.orientation) ? `export-preview__document--${pdf.orientation}` : "export-preview__document--portrait",
      PDF_PAGE_SIZES.has(pdf.pageSize) ? `export-preview__document--${pdf.pageSize.toLowerCase()}` : "export-preview__document--a4",
    ];
  }

  function applyPdfVisualScale(previewDocument, pdf) {
    const pageSize = PDF_PAGE_SIZES.has(pdf?.pageSize) ? pdf.pageSize : "A4";
    const fontSize = PDF_FONT_SIZES.has(pdf?.fontSize) ? pdf.fontSize : "standard";
    let [width, height] = PDF_PAGE_POINTS[pageSize];
    if (pdf?.orientation === "landscape") [width, height] = [height, width];
    previewDocument.style.setProperty("--preview-page-width", `${(width * CSS_PIXELS_PER_POINT).toFixed(2)}px`);
    previewDocument.style.setProperty("--preview-page-height", `${(height * CSS_PIXELS_PER_POINT).toFixed(2)}px`);
    previewDocument.style.setProperty("--preview-font-size", `${(PDF_FONT_POINTS[fontSize] * CSS_PIXELS_PER_POINT).toFixed(3)}px`);
  }

  function notifyClosed(sessionId) {
    if (!pageSession.check()) return;
    pageSession.runtimeRequest(
      protocol.event(protocol.Type.EXPORT_PREVIEW_CLOSED, { sessionId }),
    ).catch(() => {});
  }

  function closePresentation({ notify = false, expectedSessionId = null } = {}) {
    if (!presentation || (expectedSessionId && presentation.sessionId !== expectedSessionId)) return false;
    const current = presentation;
    presentation = null;
    current.removeListeners();
    current.releaseDrag();
    // 原生模态负责解除背景 inert，并恢复打开前的焦点（包括 Shadow DOM 内的控件）。
    current.dialog.close();
    current.host.remove();
    if (notify) notifyClosed(current.sessionId);
    return true;
  }

  function makeDraggable(dialog, handle, listen) {
    let drag = null;

    function clampToViewport() {
      if (!pageSession.check() || !dialog.isConnected) return;
      const rect = dialog.getBoundingClientRect();
      const maxLeft = Math.max(EDGE_GAP, global.innerWidth - rect.width - EDGE_GAP);
      const maxTop = Math.max(EDGE_GAP, global.innerHeight - rect.height - EDGE_GAP);
      const left = Math.min(Math.max(rect.left, EDGE_GAP), maxLeft);
      const top = Math.min(Math.max(rect.top, EDGE_GAP), maxTop);
      if (left === rect.left && top === rect.top && dialog.style.transform !== "none") return;
      dialog.style.left = `${left}px`;
      dialog.style.top = `${top}px`;
      dialog.style.transform = "none";
    }

    listen(handle, "pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) return;
      const rect = dialog.getBoundingClientRect();
      drag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
      dialog.style.left = `${rect.left}px`;
      dialog.style.top = `${rect.top}px`;
      dialog.style.transform = "none";
      dialog.classList.add("is-dragging");
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    listen(handle, "pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const rect = dialog.getBoundingClientRect();
      const maxLeft = Math.max(EDGE_GAP, global.innerWidth - rect.width - EDGE_GAP);
      const maxTop = Math.max(EDGE_GAP, global.innerHeight - rect.height - EDGE_GAP);
      dialog.style.left = `${Math.min(Math.max(event.clientX - drag.offsetX, EDGE_GAP), maxLeft)}px`;
      dialog.style.top = `${Math.min(Math.max(event.clientY - drag.offsetY, EDGE_GAP), maxTop)}px`;
    });

    function stopDragging(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag = null;
      dialog.classList.remove("is-dragging");
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      clampToViewport();
    }

    listen(handle, "pointerup", stopDragging);
    listen(handle, "pointercancel", stopDragging);
    return {
      clampToViewport,
      releaseDrag() {
        if (!drag) return;
        const { pointerId } = drag;
        drag = null;
        dialog.classList.remove("is-dragging");
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      },
    };
  }

  function openPresentation(payload) {
    pageSession.assertActive();
    if (!validPayload(payload)) throw new Error("Invalid export preview payload");
    closePresentation();

    // 每个弹窗拥有自己的监听器；关闭或整页退役时统一撤销，旧节点不能继续响应。
    let listening = true;
    const removers = [];
    function listen(target, type, listener, options) {
      const guarded = event => {
        if (listening && pageSession.check()) listener(event);
      };
      target.addEventListener(type, guarded, options);
      removers.push(() => target.removeEventListener(type, guarded, options));
    }
    function removeListeners() {
      listening = false;
      for (const remove of removers.splice(0)) remove();
    }

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.dataset.tidyOwned = "export-preview";
    host.dataset.colorScheme = payload.colorScheme === "dark" ? "dark" : "light";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLES + preview.styles;

    const layer = document.createElement("section");
    layer.className = "export-full-preview-layer";
    layer.setAttribute("aria-label", payload.title);
    const dialog = document.createElement("dialog");
    dialog.className = "export-full-preview__dialog";
    if (payload.format === "pdf" && payload.pdf?.orientation === "landscape") {
      dialog.classList.add("is-pdf-landscape");
    }
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", payload.title);

    const header = document.createElement("header");
    const heading = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = payload.title;
    const summary = document.createElement("small");
    summary.textContent = payload.summary;
    heading.append(title, summary);
    const close = document.createElement("button");
    close.type = "button";
    close.autofocus = true;
    close.setAttribute("aria-label", payload.closeLabel);
    close.textContent = "×";
    header.append(heading, close);

    const body = document.createElement("div");
    body.className = "export-full-preview__body";
    // 正文可用方向键/PageDown 滚动；Tab 可以在关闭按钮、正文和文内链接之间移动。
    body.tabIndex = 0;
    body.setAttribute("role", "region");
    body.setAttribute("aria-label", payload.title);
    const previewDocument = document.createElement("div");
    previewDocument.classList.add("export-preview__document", `export-preview__document--${payload.format}`);
    if (payload.format === "pdf") {
      previewDocument.classList.add(...pdfClassNames(payload.pdf));
      applyPdfVisualScale(previewDocument, payload.pdf);
    }
    if (payload.format === "pdf") preview.append(previewDocument, payload.previewParts);
    else {
      const code = document.createElement("pre");
      code.className = "export-preview__code";
      // 其他格式保持源码预览；会话正文永远作为文字，不解释为 HTML。
      code.textContent = payload.content;
      previewDocument.append(code);
    }
    body.append(previewDocument);
    dialog.append(header, body);
    layer.append(dialog);
    shadow.append(style, layer);
    pageSession.assertActive();
    document.documentElement.append(host);

    const finish = () => closePresentation({ notify: true, expectedSessionId: payload.sessionId });
    const onKeyDown = (event) => {
      if (!event.composedPath().includes(dialog)) return;
      if (event.key === "Tab") {
        // 浏览器处理背景不可交互；这里仅让首尾 Tab 在当前弹窗内循环，
        // 不从最后一个控件跳到地址栏。shadow.activeElement 才是实际控件。
        const controls = [...dialog.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')]
          .filter(node => node.tabIndex >= 0 && !node.disabled && node.getClientRects().length);
        const first = controls[0], last = controls.at(-1), focused = shadow.activeElement;
        if ((event.shiftKey && focused === first) || (!event.shiftKey && focused === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus({ preventScroll: true });
        }
        return;
      }
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      finish();
    };
    const { clampToViewport, releaseDrag } = makeDraggable(dialog, header, listen);
    listen(close, "click", finish);
    listen(dialog, "cancel", event => { event.preventDefault(); finish(); });
    // 原生 ::backdrop 的事件目标是 dialog；只在按下和抬起都在框外时关闭，
    // 从正文拖选到框外不会误关。拖动标题栏仍沿用原来的定位逻辑。
    const outside = event => {
      const rect = dialog.getBoundingClientRect();
      return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom);
    };
    let backdropPressed = false;
    listen(dialog, "pointerdown", event => { backdropPressed = event.button === 0 && outside(event); });
    listen(dialog, "pointerup", event => { if (backdropPressed && outside(event)) finish(); backdropPressed = false; });
    listen(dialog, "pointercancel", () => { backdropPressed = false; });
    listen(global, "keydown", onKeyDown, true);
    listen(global, "resize", clampToViewport);
    presentation = { host, dialog, sessionId: payload.sessionId, removeListeners, releaseDrag };
    try { pageSession.assertActive(); dialog.showModal(); }
    catch (error) { closePresentation(); throw error; }
    return { opened: true, sessionId: payload.sessionId };
  }

  function onMessage(envelope, _sender, sendResponse) {
    if (!pageSession.check() || !protocol.isRequest(envelope)) return false;
    if (envelope.type === protocol.Type.EXPORT_PREVIEW_OPEN) {
      try {
        const result = openPresentation(envelope.payload);
        if (pageSession.check()) sendResponse(protocol.response(envelope, result));
      } catch (error) {
        if (!pageSession.check()) return false;
        sendResponse(protocol.failure(
          envelope,
          protocol.ErrorCode.EXPORT_UNAVAILABLE,
          error?.message || "The export preview could not be shown.",
          { stage: "content.export-preview-open" },
        ));
      }
      return false;
    }
    if (envelope.type === protocol.Type.EXPORT_PREVIEW_CLOSE) {
      const closed = closePresentation({ expectedSessionId: envelope.payload?.sessionId });
      if (pageSession.check()) sendResponse(protocol.response(envelope, { closed, sessionId: envelope.payload?.sessionId || null }));
      return false;
    }
    return false;
  }

  chrome.runtime.onMessage.addListener(onMessage);
  pageSession.onDispose(() => {
    // 退役不是用户关闭，不向已经失效的 Worker 发回执，也不遗留模态/拖动捕获。
    closePresentation();
    chrome.runtime.onMessage.removeListener(onMessage);
  });
})(globalThis);
