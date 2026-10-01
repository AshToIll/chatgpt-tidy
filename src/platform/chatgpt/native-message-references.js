// ChatGPT 原生引用只在此解码。下游导出器只接收普通链接与图片块，不能猜内部编号。
(function initTidyChatgptNativeMessageReferences(global) {
  "use strict";
  if (global.TidyChatgptNativeMessageReferences) return;
  const TOKEN_START = "\uE200", TOKEN_END = "\uE201", TOKEN_SEPARATOR = "\uE202";
  const object = value => value && typeof value === "object" && !Array.isArray(value);
  const string = value => typeof value === "string" ? value.trim() : "";
  function publicUrl(value) {
    try {
      const url = new URL(string(value));
      // 凭据不是公开来源的一部分；只允许可独立访问的 HTTP(S) 地址。
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
    } catch { return ""; }
  }
  const imageType = value => /image/i.test(String(value?.type || value?.content_type || ""));
  const titleOf = value => string(value?.title) || string(value?.attribution) || string(value?.name);
  function nodes(reference, inheritedImage = false) {
    if (!object(reference)) return [];
    const image = inheritedImage || imageType(reference);
    return [{ value: reference, image },
      ...nodes(reference.metadata, image),
      ...(Array.isArray(reference.items) ? reference.items.flatMap(item => nodes(item, image)) : [])];
  }
  function sourceCandidates(reference) {
    const candidates = [];
    for (const { value, image } of nodes(reference)) {
      if (image) continue;
      // 标题和地址必须来自同一个对象；绝不把 safe_urls[n] 与 items[n] 拼接。
      const url = publicUrl(value.url) || publicUrl(value.href) || publicUrl(value.link);
      const title = titleOf(value);
      if (url) candidates.push({ title: title || url, url, domain: new URL(url).hostname, named: Boolean(title) });
      for (const raw of Array.isArray(value.safe_urls) ? value.safe_urls : []) {
        const safe = publicUrl(raw);
        if (safe) candidates.push({ title: safe, url: safe, domain: new URL(safe).hostname, named: false });
      }
    }
    return candidates;
  }
  function preferredSources(candidates, namedFirst = true) {
    const byUrl = new Map();
    for (const candidate of namedFirst ? [...candidates.filter(value => value.named), ...candidates.filter(value => !value.named)] : candidates) {
      const previous = byUrl.get(candidate.url);
      if (!previous || (!previous.named && candidate.named)) byUrl.set(candidate.url, candidate);
    }
    return [...byUrl.values()].map(({ title, url, domain }) => ({ title, url, domain }));
  }
  const sourcesFromReference = reference => preferredSources(sourceCandidates(reference));
  const dedupeSources = sources => preferredSources(sources.filter(Boolean).map(source => ({
    ...source, named: Boolean(source.title && source.title !== source.url),
  })), false);
  function references(message) {
    const metadata = message?.metadata || {};
    return [...(Array.isArray(metadata.citations) ? metadata.citations : []),
      ...(Array.isArray(metadata.content_references) ? metadata.content_references : [])];
  }
  const finalSources = message => preferredSources(references(message).flatMap(sourceCandidates));
  function identities(value) {
    const result = new Set();
    const add = raw => { const id = string(raw); if (id && id.length <= 256) result.add(id); };
    for (const key of ["id", "ref_id", "reference_id", "citation_id", "file_id"]) add(value?.[key]);
    for (const ref of [...(Array.isArray(value?.refs) ? value.refs : []), value?.ref].filter(Boolean)) {
      if (typeof ref === "string") { add(ref); continue; }
      for (const key of ["id", "ref_id", "reference_id"]) add(ref?.[key]);
      if (/^\d+$/.test(String(ref?.turn_index)) && /^[a-z]+$/i.test(String(ref?.ref_type))
        && /^\d+$/.test(String(ref?.ref_index))) add(
          `turn${ref.turn_index}${ref.ref_type}${ref.ref_index}`,
        );
    }
    return [...result];
  }
  // 检索图片有时把缩略图和来源装进 caption，而不是独立 image_url。
  // 只解析完整、明确的 Markdown 图片结构；普通说明中的 URL 不能被猜成图片。
  function metadataMarkdownImage(value) {
    const source = string(value), budget = { remaining: Math.max(4096, source.length * 8) };
    const wrapped = source.startsWith("[") ? markdownImage(source, 1, budget) : null;
    const outer = wrapped && source[wrapped.end] === "]"
      ? markdownDestination(source, wrapped.end + 1, budget) : null;
    if (wrapped && outer && outer.end === source.length) return { image: wrapped.image, sourceUrl: outer.url };
    const image = markdownImage(source, 0, budget);
    return image && image.end === source.length ? { image: image.image, sourceUrl: "" } : null;
  }

  // 引用 metadata 与显式 image 内容块共享这一个描述规则，输出只剩普通资源字段。
  function imageDescription(value, typedImage = imageType(value)) {
    const explicitSrc = publicUrl(value.image_url) || publicUrl(value.image?.url)
      || (typedImage ? publicUrl(value.url) || publicUrl(value.src) : "");
    if (!explicitSrc && !typedImage && !value.image_url && !value.image) return null;
    const descriptions = [value.alt, value.caption, value.image?.alt, value.name].map(string).filter(Boolean);
    const parsed = descriptions.map(metadataMarkdownImage).find(Boolean);
    const readable = raw => {
      const image = metadataMarkdownImage(raw);
      return image ? image.image.alt : raw;
    };
    const alt = descriptions.length ? readable(descriptions[0]) : "";
    const name = string(value.name) ? readable(string(value.name)) : alt;
    return {
      src: explicitSrc || parsed?.image.src || "", alt, name, mimeType: string(value.mime_type),
      ...(parsed?.sourceUrl ? { sourceLink: link({ title: alt || parsed.sourceUrl, url: parsed.sourceUrl }) } : {}),
    };
  }

  function imageDescriptors(reference) {
    const result = [];
    for (const { value, image } of nodes(reference)) {
      const descriptor = imageDescription(value, image);
      if (!descriptor) continue;
      if (!descriptor.src && (object(value.metadata) || (Array.isArray(value.items) && value.items.length))) continue;
      result.push(descriptor);
    }
    const seen = new Set();
    return result.filter(item => { const key = JSON.stringify(item); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  function fileNames(reference) {
    return [...new Set(nodes(reference).map(({ value }) => string(value.file_name) || string(value.filename)
      || titleOf(value)).filter(Boolean))];
  }
  function binding(reference) {
    return { sources: sourcesFromReference(reference), images: imageDescriptors(reference), names: fileNames(reference) };
  }
  const sameValues = (left, right) => JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
  function addBinding(map, key, value) {
    if (!key || !(value.sources.length || value.images.length || value.names.length)) return;
    if (!map.has(key)) { map.set(key, value); return; }
    const previous = map.get(key);
    if (!previous) return;
    const sourceUrls = entry => entry.sources.map(source => source.url);
    const imageUrls = entry => entry.images.map(image => image.src).filter(Boolean);
    const conflicts = (left, right) => left.length && right.length && !sameValues(left, right);
    const knownImages = imageUrls(previous).length || imageUrls(value).length;
    // 不同载荷各自判断冲突：文件名差异不能遮蔽同一编号已经明确的网页 URL。
    const ambiguousSources = previous.ambiguousSources || value.ambiguousSources
      || Boolean(conflicts(sourceUrls(previous), sourceUrls(value)));
    const ambiguousImages = previous.ambiguousImages || value.ambiguousImages
      || Boolean(conflicts(imageUrls(previous), imageUrls(value)));
    const ambiguousNames = previous.ambiguousNames || value.ambiguousNames
      || Boolean(conflicts(previous.names, value.names));
    const images = [...previous.images, ...value.images];
    const seenImages = new Set();
    map.set(key, {
      sources: ambiguousSources ? [] : dedupeSources([...previous.sources, ...value.sources]),
      images: ambiguousImages ? [] : images.filter(image => !knownImages || image.src).filter(image => {
        const identity = image.src || image.alt;
        if (seenImages.has(identity)) return false; seenImages.add(identity); return true;
      }),
      names: ambiguousNames ? [] : [...new Set([...previous.names, ...value.names])],
      ambiguousSources, ambiguousImages, ambiguousNames,
    });
  }
  function escapeLabel(value) {
    return String(value).replace(/[\r\n]+/g, " ").replace(/([\\\[\]`*_~|<>&])/g, "\\$1");
  }
  function link(source) {
    const destination = source.url.replace(/([()|&\\])/g, "\\$1").replace(/[<>]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return `[${escapeLabel(source.title)}](${destination})`;
  }
  function inlineCodeEnd(source, index, budget = null) {
    if (source[index] !== "`") return -1;
    const ticks = /^`+/.exec(source.slice(index))[0];
    let end = index + ticks.length;
    while ((end = source.indexOf(ticks, end)) >= 0) {
      if (budget && --budget.remaining < 0) return -1;
      if (source[end - 1] !== "`" && source[end + ticks.length] !== "`") return end + ticks.length;
      end += ticks.length;
    }
    return -1;
  }
  function decodeMarkdownValue(value) {
    const entities = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
    // Markdown 转义优先于字符实体；不把显式 \\&amp; 当作待解码的实体。
    return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])|&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
      (raw, escaped, entity) => {
        if (escaped) return escaped;
        if (entity[0] !== "#") return entities[entity.toLowerCase()] || raw;
        const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : raw;
      });
  }
  function markdownDestination(source, opening, budget) {
    if (source[opening] !== "(") return null;
    let depth = 1, angle = false, quote = "", index = opening + 1;
    for (; index < source.length; index += 1) {
      if (--budget.remaining < 0) return null;
      const character = source[index];
      if (character === "\\") { index += 1; continue; }
      if (quote) { if (character === quote) quote = ""; continue; }
      if (angle) { if (character === ">") angle = false; continue; }
      if (character === "<") { angle = true; continue; }
      if ((character === "\"" || character === "'") && /\s/.test(source[index - 1])) { quote = character; continue; }
      if (character === "(") depth += 1;
      else if (character === ")" && --depth === 0) break;
    }
    if (depth !== 0) return null;
    let raw = source.slice(opening + 1, index).trim();
    if (raw.startsWith("<")) {
      const end = raw.indexOf(">");
      if (end < 0) return null;
      raw = raw.slice(1, end);
    } else raw = raw.replace(/\s+(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\([^()]*\))\s*$/, "");
    return { end: index + 1, url: publicUrl(decodeMarkdownValue(raw)) };
  }
  function markdownImage(source, opening, budget) {
    if (source.slice(opening, opening + 2) !== "![") return null;
    let depth = 1, index = opening + 2;
    for (; index < source.length; index += 1) {
      if (--budget.remaining < 0) return null;
      if (source[index] === "\\") { index += 1; continue; }
      if (source[index] === "[") depth += 1;
      else if (source[index] === "]" && --depth === 0) break;
    }
    if (depth !== 0) return null;
    const destination = markdownDestination(source, index + 1, budget);
    if (!destination) return null;
    const alt = decodeMarkdownValue(source.slice(opening + 2, index));
    return { end: destination.end, image: { src: destination.url, alt, name: alt, mimeType: "" } };
  }
  function createResolver(message) {
    const byId = new Map(), byText = new Map();
    const all = [...references(message), ...(Array.isArray(message?.metadata?.search_result_groups)
      ? message.metadata.search_result_groups.flatMap(group => Array.isArray(group?.entries) ? group.entries : []) : [])];
    for (const reference of all) {
      for (const { value } of nodes(reference)) {
        const entry = binding(value);
        for (const id of identities(value)) addBinding(byId, id, entry);
        if (typeof value.matched_text === "string" && value.matched_text.includes(TOKEN_START)) {
          addBinding(byText, value.matched_text, entry);
        }
      }
    }
    function resolveToken(token, appendImage) {
      const parts = token.slice(1, -1).split(TOKEN_SEPARATOR), kind = parts.shift();
      if (kind === "url") {
        const url = publicUrl(parts[1]);
        return url ? link({ title: parts[0] || url, url }) : "";
      }
      if (!["cite", "filecite", "i", "image"].includes(kind)) return token;
      const exact = byText.get(token);
      const imageToken = kind === "i" || kind === "image";
      const applicable = entry => entry && (imageToken ? entry.images.length || entry.ambiguousImages
        : kind === "cite" ? entry.sources.length || entry.ambiguousSources
          : entry.sources.length || entry.names.length || entry.ambiguousSources || entry.ambiguousNames);
      const ambiguous = entry => imageToken ? entry.ambiguousImages
        : entry.ambiguousSources || (kind === "filecite" && !entry.sources.length && entry.ambiguousNames);
      // matched_text 必须包含当前 token 类型的有效资料；泛化标题不是网页引用映射。
      // 真实目标冲突不回退猜测，只有缺少该类型资料时才查精确编号。
      const identities = parts.map(id => byId.get(id));
      let selected = applicable(exact) ? [exact] : identities;
      // 图片说明仍是有效占位，但不能遮蔽精确编号上已知的图片地址。
      // 若双方均无地址则保留说明；实际地址冲突仍保持未解析状态。
      if (imageToken && exact && !exact.ambiguousImages && !exact.images.some(image => image.src)
        && identities.some(entry => entry && (entry.ambiguousImages || entry.images.some(image => image.src)))) {
        selected = identities;
      }
      const entries = selected.filter(applicable).filter(entry => !ambiguous(entry));
      if (kind === "i" || kind === "image") {
        const images = entries.flatMap(entry => entry.images);
        // 不暴露内部编号；缺少地址时仍生成既有图片占位，媒体开关可正常过滤它。
        return (images.length ? images : [{ src: "", alt: "", name: "", mimeType: "" }]).map(image => appendImage(image) + (image.sourceLink || "")).join("");
      }
      const sources = dedupeSources(entries.flatMap(entry => entry.sources));
      if (sources.length) return sources.map(link).join(" ");
      return kind === "filecite" ? [...new Set(entries.flatMap(entry => entry.names))].map(escapeLabel).join(", ") : "";
    }
    // 按 Markdown 字面量边界扫描：代码块和行内代码里的 token 是用户资料，不是引用。
    function replace(value, appendImage) {
      const source = String(value || "");
      let output = "", index = 0;
      // 畸形长 Markdown 只做有界扫描，不能让单条消息卡住页面 MAIN 世界。
      const budget = { remaining: Math.max(4096, source.length * 8) };
      while (index < source.length) {
        if (budget.remaining < 0) { output += source.slice(index); break; }
        if (index === 0 || source[index - 1] === "\n") {
          const fence = /^\s{0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(source.slice(index));
          if (fence) {
            const endPattern = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*(?:\\n|$)`, "gm");
            endPattern.lastIndex = index + fence[0].length;
            const end = endPattern.exec(source);
            const until = end ? end.index + end[0].length : source.length;
            output += source.slice(index, until); index = until; continue;
          }
        }
        if (source[index] === "\\") { output += source.slice(index, index + 2); index += 2; continue; }
        const codeEnd = inlineCodeEnd(source, index, budget);
        if (codeEnd > index) { output += source.slice(index, codeEnd); index = codeEnd; continue; }
        // 真正 Markdown 图片与原生图片走同一媒体模型；代码示例不进入此分支。
        const wrappedImage = source[index] === "[" ? markdownImage(source, index + 1, budget) : null;
        const outerLink = wrappedImage && source[wrappedImage.end] === "]"
          ? markdownDestination(source, wrappedImage.end + 1, budget) : null;
        if (wrappedImage && outerLink) {
          output += appendImage(wrappedImage.image);
          if (outerLink.url) output += link({ title: wrappedImage.image.alt || outerLink.url, url: outerLink.url });
          index = outerLink.end; continue;
        }
        const image = markdownImage(source, index, budget);
        if (image) { output += appendImage(image.image); index = image.end; continue; }
        if (source[index] === TOKEN_START) {
          const end = source.indexOf(TOKEN_END, index + 1);
          if (end >= 0) { output += resolveToken(source.slice(index, end + 1), appendImage); index = end + 1; continue; }
          output += source.slice(index); break;
        }
        output += source[index++];
      }
      return output;
    }
    return Object.freeze({ replace });
  }
  global.TidyChatgptNativeMessageReferences = Object.freeze({ publicUrl, imageDescription, sourcesFromReference, finalSources, dedupeSources, createResolver, inlineCodeEnd });
})(globalThis);
