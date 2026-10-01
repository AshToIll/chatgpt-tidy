import { escapeHtml } from "./html.js";

const CARD_VARIANTS = new Set(["centered", "summary"]);
const BUSINESS_ATTRIBUTE = /^(?:aria|data)-[a-z][a-z0-9-]*$/;

function attributeMarkup(attributes) {
  return Object.entries(attributes).map(([name, value]) => {
    // The primitive owns its element contract. Callers may add only business
    // semantics (for example data-* and aria-*), never replace its structure.
    if (!BUSINESS_ATTRIBUTE.test(name)) {
      throw new TypeError(`Unsupported current-context-card attribute: ${name}`);
    }
    if (value === null || value === undefined) return "";
    // ARIA booleans are string-valued states, unlike presence-only HTML/data
    // attributes. Keeping this distinction here prevents `false` from being
    // dropped and `true` from becoming an invalid bare aria-* attribute.
    if (name.startsWith("aria-")) return ` ${name}="${escapeHtml(value)}"`;
    if (value === false) return "";
    return value === true ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`;
  }).join("");
}

/**
 * Builds the shared current-conversation action used by Favorites and
 * Bookmarks. `title` and `subtitle` are plain text and are escaped here;
 * `leading` and `trailing` are trusted icon/stat markup owned by the caller.
 * Every slot is emitted even when empty so both views keep one stable DOM
 * contract while CSS variants decide layout only.
 */
export function currentContextCardMarkup({
  variant,
  selected = false,
  disabled = false,
  attributes = {},
  leading = "",
  title = "",
  subtitle = "",
  trailing = "",
}) {
  if (!CARD_VARIANTS.has(variant)) {
    throw new TypeError(`Unsupported current-context-card variant: ${variant}`);
  }

  const classes = [
    "current-context-card",
    `current-context-card--${variant}`,
    selected ? "is-selected" : "",
  ].filter(Boolean).join(" ");

  return `<button class="${classes}" type="button"${disabled ? " disabled" : ""}${attributeMarkup(attributes)}><span class="current-context-card__leading">${leading}</span><span class="current-context-card__copy"><span class="current-context-card__title">${escapeHtml(title)}</span><span class="current-context-card__subtitle">${escapeHtml(subtitle)}</span></span><span class="current-context-card__trailing">${trailing}</span></button>`;
}
