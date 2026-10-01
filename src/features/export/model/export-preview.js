(function initTidyExportPreview(global) {
  "use strict";
  if (global.TidyExportPreview) return;

  // 预览只接收文字/图片两个明确类型，不跨消息传递可执行 HTML。
  // 图文内容跟随导出计划；这里不承诺复现 PDF 的自动分页和字体排版。
  const styles = `
    .export-preview__image { margin: 12px 0; text-align: center; }
    .export-preview__image img { display: block; max-width: 100%; max-height: 420px; width: auto; height: auto; margin: 0 auto; object-fit: contain; }
    .export-preview__image figcaption { margin-top: 6px; font: inherit; font-size: .9em; white-space: pre-wrap; overflow-wrap: anywhere; }
    .export-preview__image img[hidden] { display: none; }
  `;
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  function imageUrl(value) {
    if (typeof value !== "string") return false;
    if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+=*$/i.test(value)) return true;
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }
    catch { return false; }
  }
  function valid(parts) {
    return Array.isArray(parts) && parts.every(part => part?.type === "text" ? typeof part.text === "string"
      : part?.type === "image" && imageUrl(part.src) && typeof part.alt === "string" && typeof part.failureText === "string");
  }
  function excerpt(parts, maxText = 2600) {
    const output = [];
    for (const part of parts) {
      if (part.type === "image") output.push(part);
      else {
        const clipped = part.text.slice(0, maxText);
        output.push({ type: "text", text: clipped + (clipped.length < part.text.length ? "\n…" : "") });
        maxText -= clipped.length;
        if (maxText <= 0) break;
      }
    }
    return output;
  }
  function markup(parts) {
    if (!valid(parts)) throw new TypeError("Invalid export preview parts");
    return parts.map(part => part.type === "text"
      ? `<pre class="export-preview__code">${escape(part.text)}</pre>`
      : `<figure class="export-preview__image"><img data-export-preview-image src="${escape(part.src)}" alt="${escape(part.alt)}" data-preview-failure="${escape(part.failureText)}" loading="lazy" referrerpolicy="no-referrer"><figcaption>${escape(part.alt)}</figcaption></figure>`).join("");
  }
  function onImageError(event) {
    const image = event.target;
    if (!image?.hasAttribute?.("data-export-preview-image")) return;
    image.hidden = true;
    const caption = image.parentElement?.querySelector("figcaption");
    if (caption) caption.textContent = image.dataset.previewFailure;
  }
  function append(container, parts) {
    if (!valid(parts)) throw new TypeError("Invalid export preview parts");
    const document = container.ownerDocument;
    for (const part of parts) {
      if (part.type === "text") {
        const pre = document.createElement("pre"); pre.className = "export-preview__code"; pre.textContent = part.text; container.append(pre);
      } else {
        const figure = document.createElement("figure"), image = document.createElement("img"), caption = document.createElement("figcaption");
        figure.className = "export-preview__image";
        image.setAttribute("data-export-preview-image", ""); image.dataset.previewFailure = part.failureText;
        image.alt = part.alt; image.referrerPolicy = "no-referrer"; image.loading = "lazy";
        image.addEventListener("error", onImageError); image.src = part.src;
        caption.textContent = part.alt; figure.append(image, caption); container.append(figure);
      }
    }
  }
  global.TidyExportPreview = Object.freeze({ styles, imageUrl, valid, excerpt, markup, append, onImageError });
})(globalThis);
