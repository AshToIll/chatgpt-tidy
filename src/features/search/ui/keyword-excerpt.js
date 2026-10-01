// Keep the hit near the first two lines of a narrow panel. These limits affect
// display only; the official snippet and message identity remain unchanged.
const DEFAULT_MAX_LENGTH = 180;
const DEFAULT_LEADING_CONTEXT = 28;
const ELLIPSIS = "\u2026";
const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });

// Excerpt selection and highlighting must agree, including literal punctuation
// and case-insensitive Unicode matches. No user input becomes regex syntax.
export function createKeywordMatcher(query) {
  const terms = [...new Set(String(query || "").trim().split(/\s+/u).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  if (!terms.length) return null;
  return new RegExp(terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "giu");
}

function boundaries(text, start, end, segmenter) {
  const result = [];
  // One extra character distinguishes a real boundary from the window's end.
  // Segmentation stays bounded even when the native snippet is very long.
  for (const { index } of segmenter.segment(text.slice(start, end + 1))) {
    const position = start + index;
    if (position > start && position <= end) result.push(position);
  }
  return result;
}

function splitsSurrogate(text, index) {
  return index > 0 && index < text.length
    && /[\uD800-\uDBFF]/u.test(text[index - 1]) && /[\uDC00-\uDFFF]/u.test(text[index]);
}

export function keywordExcerpt(value, query, {
  maxLength = DEFAULT_MAX_LENGTH, leadingContext = DEFAULT_LEADING_CONTEXT,
} = {}) {
  const text = String(value || "");
  const match = createKeywordMatcher(query)?.exec(text);
  // Native search can qualify a result whose literal hit is outside its snippet.
  // Never hide that result, fabricate context, or fetch history to replace it.
  if (!match || !Number.isInteger(maxLength) || maxLength < 1
    || !Number.isInteger(leadingContext) || leadingContext < 0 || match[0].length > maxLength) return text;

  const matchEnd = match.index + match[0].length;
  let start = Math.max(0, match.index - Math.min(leadingContext, maxLength - match[0].length));
  if (splitsSurrogate(text, start)) start += 1;
  if (start > 0) {
    // Prefer a nearby sentence start, then a word boundary. Long unbroken text
    // still gets a useful window without sacrificing the matched keyword.
    start = boundaries(text, start, match.index, sentences)[0]
      ?? boundaries(text, start, match.index, words)[0] ?? start;
  }
  let end = Math.min(text.length, start + maxLength);
  if (end < text.length) {
    const sentenceEnds = boundaries(text, start, end, sentences)
      .filter((position) => position >= matchEnd + Math.min(24, end - matchEnd));
    const wordEnds = boundaries(text, start, end, words).filter((position) => position >= matchEnd);
    end = sentenceEnds.at(-1) ?? wordEnds.at(-1) ?? end;
    if (splitsSurrogate(text, end)) end -= 1;
  }

  const excerpt = text.slice(start, end).trim();
  const omittedBefore = start > 0 && /\S/u.test(text.slice(0, start));
  const omittedAfter = end < text.length && /\S/u.test(text.slice(end));
  // Preserve one contiguous source passage; only omitted edges get markers.
  return `${omittedBefore ? ELLIPSIS : ""}${excerpt}${omittedAfter ? ELLIPSIS : ""}`;
}
