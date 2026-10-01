/* 纯展示边界：把标准 Markdown 内联链接变成可阅读的文字片段。
 * 不认识 ChatGPT 原生标记，不查来源，不请求网络；这些属于原生消息适配层。
 * Markdown 导出保留正文结构，但不让图片语法触发加载；TXT、PDF 和 PDF 预览共用文字及完整地址。 */
(function (root) {
  'use strict';
  const api = root.TidyExport = root.TidyExport || {};

  // Decode Markdown escapes/entities, never URL percent escapes. Unknown named
  // entities in a destination stay source Markdown rather than a guessed target.
  function decodeMarkdown(value) {
    let unresolvedEntity = false;
    const entities = { amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>', quot: '"', QUOT: '"', apos: "'" };
    const text = value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_\x60{|}~])|&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi, (token, escaped, entity) => {
      if (escaped) return escaped;
      if (entity[0] === '#') {
        const hexadecimal = entity[1].toLowerCase() === 'x';
        const point = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
        return point && point <= 0x10FFFF && !(point >= 0xD800 && point <= 0xDFFF) ? String.fromCodePoint(point) : '\uFFFD';
      }
      if (Object.hasOwn(entities, entity)) return entities[entity];
      unresolvedEntity = true;
      return token;
    });
    return { text, unresolvedEntity };
  }

  function codeSpanEnd(source, start, indexedEnds) {
    let end = start;
    while (source[end] === '\x60') end += 1;
    // Only the text-only Markdown boundary supplies this linear-time index.
    // Existing link/plain-text readers retain their original matching behavior.
    if (indexedEnds) return indexedEnds.get(start) || end;
    const marker = source.slice(start, end);
    let closing = source.indexOf(marker, end);
    while (closing !== -1) {
      if (source[closing - 1] !== '\x60' && source[closing + marker.length] !== '\x60') return closing + marker.length;
      closing = source.indexOf(marker, closing + marker.length);
    }
    return end;
  }

  // Index delimiter runs once: repeatedly searching the remaining paragraph
  // would become quadratic for malformed examples with many unmatched runs.
  function indexedCodeSpanEnds(source) {
    const runs = [], nextEndByLength = new Map(), ends = new Map();
    for (let start = 0; start < source.length; start += 1) {
      if (source[start] !== '\x60') continue;
      let end = start + 1;
      while (source[end] === '\x60') end += 1;
      runs.push([start, end]); start = end - 1;
    }
    for (let index = runs.length - 1; index >= 0; index -= 1) {
      const [start, end] = runs[index], length = end - start;
      if (nextEndByLength.has(length)) ends.set(start, nextEndByLength.get(length));
      // An escaped first backtick leaves the rest of its run available to open
      // a span, matching the existing scanner's one-character escape rule.
      if (length > 1 && nextEndByLength.has(length - 1)) ends.set(start + 1, nextEndByLength.get(length - 1));
      nextEndByLength.set(length, end);
    }
    return ends;
  }

  // Product boundary: MD is text, not a remote-image viewer. Keep literal code
  // unchanged; deactivate image syntax rather than resolving reference labels
  // or interpreting ChatGPT/native markup. This never fetches any resource.
  function markdownTextWithoutImages(value) {
    const source = String(value || ''), ends = indexedCodeSpanEnds(source), output = [];
    let plainStart = 0;
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] === '\\') { index += 1; continue; }
      if (source[index] === '\x60') { index = codeSpanEnd(source, index, ends) - 1; continue; }
      if (source[index] === '!' && source[index + 1] === '[') {
        output.push(source.slice(plainStart, index), '\\!'); plainStart = index + 1;
      } else if (source[index] === '<' && /^<img(?=[\t\n\f\r />])/i.test(source.slice(index, index + 5))) {
        output.push(source.slice(plainStart, index), '&lt;'); plainStart = index + 1;
      }
    }
    output.push(source.slice(plainStart));
    return output.join('');
  }

  function linkAt(source, start, closing, budget) {
    let index = closing;
    if (source[index + 1] !== '(') return null;
    const label = source.slice(start + 1, index);
    index += 2;
    while (/\s/.test(source[index] || '') && index < source.length) index += 1;
    let destination = '';
    if (source[index] === '<') {
      const opening = ++index;
      for (; index < source.length && source[index] !== '>'; index += 1) {
        if (--budget.remaining < 0) return null;
        if (source[index] === '\\') index += 1;
        else if (source[index] === '\n' || source[index] === '<') return null;
      }
      if (source[index] !== '>') return null;
      destination = source.slice(opening, index++);
    } else {
      const opening = index;
      let parentheses = 0;
      for (; index < source.length; index += 1) {
        if (--budget.remaining < 0) return null;
        const character = source[index];
        if (character === '\\') { index += 1; continue; }
        if (character === '(') parentheses += 1;
        else if (character === ')') {
          if (!parentheses) break;
          parentheses -= 1;
        } else if (/\s/.test(character)) { if (parentheses) return null; break; }
      }
      if (parentheses) return null;
      destination = source.slice(opening, index);
    }
    const spacing = index;
    while (/\s/.test(source[index] || '') && index < source.length) index += 1;
    if (source[index] !== ')') {
      // An optional Markdown title is metadata, not part of the destination.
      const opener = source[index], closer = opener === '(' ? ')' : opener;
      if (index === spacing || !['"', "'", '('].includes(opener)) return null;
      index += 1;
      for (; index < source.length && source[index] !== closer; index += 1) {
        if (--budget.remaining < 0) return null;
        if (source[index] === '\\') index += 1;
      }
      if (source[index] !== closer) return null;
      index += 1;
      while (/\s/.test(source[index] || '') && index < source.length) index += 1;
      if (source[index] !== ')') return null;
    }
    if (!destination) return null;
    const decoded = decodeMarkdown(destination);
    if (decoded.unresolvedEntity) return null;
    return { end: index + 1, label: plainMarkdownText(label, true), url: decoded.text };
  }

  // Engine-owned labels are data, not Markdown. Escape only when constructing a
  // new link; never rewrite existing body Markdown or percent-encode '%' again.
  function formatMarkdownLink(label, url, image = false) {
    const title = String(label || '').replace(/[\r\n]+/g, ' ')
      .replace(/[\\[\]\x60*_!<>&]/g, '\\$&');
    const destination = String(url || '')
      .replace(/[\s<>\u0000-\u001f\u007f]/g, character => encodeURIComponent(character))
      .replace(/[\\()&|]/g, '\\$&');
    return (image ? '!' : '') + '[' + title + '](' + destination + ')';
  }

  function plainLinkText(label, url) {
    const title = String(label || ''), destination = String(url || '');
    return !title || title === destination ? destination : title + ' · ' + destination;
  }

  function plainMarkdownText(value, entities = false) {
    let output = '', start = 0;
    const unescape = text => entities ? decodeMarkdown(text).text : text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_\x60{|}~])/g, '$1');
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === '\\') { index += 1; continue; }
      if (value[index] !== '\x60') continue;
      const end = codeSpanEnd(value, index);
      output += unescape(value.slice(start, index)) + value.slice(index, end);
      start = end; index = end - 1;
    }
    return output + unescape(value.slice(start));
  }

  function isEscapedAt(source, index) {
    let slashes = 0;
    while (index > 0 && source[--index] === '\\') slashes += 1;
    return slashes % 2 === 1;
  }

  function inlineMarkdownRuns(value) {
    const source = String(value || ''), runs = [], brackets = [];
    // Malformed nested destinations must not repeatedly scan a huge remainder.
    // When this linear budget is exhausted, preserve the remaining literal text.
    const budget = { remaining: source.length * 4 };
    let plainStart = 0;
    for (let index = 0; index < source.length && budget.remaining > 0; index += 1) {
      if (source[index] === '\\') { index += 1; continue; }
      // Code examples are literal. Do not interpret links inside them.
      if (source[index] === '\x60') { index = codeSpanEnd(source, index) - 1; continue; }
      if (source[index] === '[') { brackets.push(index); continue; }
      if (source[index] !== ']' || !brackets.length) continue;
      const start = brackets.pop();
      const link = linkAt(source, start, index, budget);
      if (!link) continue;
      // An inline Markdown image belongs to the media adapter, not a text link.
      if (source[start - 1] === '!' && !isEscapedAt(source, start - 1)) {
        if (plainStart < start - 1) runs.push({ text: plainMarkdownText(source.slice(plainStart, start - 1)) });
        runs.push({ text: source.slice(start - 1, link.end) });
        plainStart = link.end;
        index = link.end - 1; brackets.length = 0; continue;
      }
      if (plainStart < start) runs.push({ text: plainMarkdownText(source.slice(plainStart, start)) });
      runs.push({ text: plainLinkText(link.label, link.url), url: link.url });
      plainStart = link.end;
      index = link.end - 1;
      brackets.length = 0;
    }
    if (plainStart < source.length) runs.push({ text: plainMarkdownText(source.slice(plainStart)) });
    return runs;
  }

  function inlinePlainText(value) {
    return inlineMarkdownRuns(value).map(run => run.text).join('');
  }

  Object.assign(api, { inlineMarkdownRuns, inlinePlainText, formatMarkdownLink, plainLinkText, markdownTextWithoutImages });
}(typeof globalThis !== 'undefined' ? globalThis : window));
