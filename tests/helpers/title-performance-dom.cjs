// Local algorithm fixture, not a browser: parses the production view's markup
// and keeps linked siblings for patchNode. It has no layout, paint or focus cost.
const VOID = new Set(["INPUT", "BR", "HR", "IMG", "META", "LINK"]);
const decode = (text) => String(text).replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[entity]);

function createFixture(stats, { dom = true } = {}) {
  function join(parent) {
    const children = parent.childNodes;
    for (let i = 0; i < children.length; i++) {
      children[i].parentNode = parent;
      children[i].previousSibling = children[i - 1] || null;
      children[i].nextSibling = children[i + 1] || null;
    }
  }
  function node(name, text = "") {
    stats.domCreates++;
    const attrs = new Map(), listeners = new Map();
    let storedHTML = "", ownValue;
    const value = {
      nodeName: name, nodeType: name === "#text" ? 3 : name === "#fragment" ? 11 : 1,
      nodeValue: text, parentNode: null, previousSibling: null, nextSibling: null,
      childNodes: [], scrollTop: 0, ownerDocument: dom ? document : undefined,
      get firstChild() { return this.childNodes[0] || null; },
      get lastChild() { return this.childNodes.at(-1) || null; },
      get children() { stats.childrenReads++; return this.childNodes.filter((child) => child.nodeType === 1); },
      get attributes() { return Array.from(attrs, ([name, value]) => ({ name, value })); },
      get dataset() { return Object.fromEntries([...attrs].filter(([key]) => key.startsWith("data-")).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), value])); },
      get value() { return ownValue ?? (name === "SELECT" ? (this.childNodes.find((child) => child.hasAttribute?.("selected")) || this.firstChild)?.getAttribute("value") || "" : attrs.get("value") || ""); },
      set value(next) { stats.propertyWrites++; ownValue = next; },
      get checked() { return attrs.has("checked"); },
      set checked(next) { stats.propertyWrites++; if (next) attrs.set("checked", ""); else attrs.delete("checked"); },
      get disabled() { return attrs.has("disabled"); },
      get innerHTML() { return storedHTML; },
      set innerHTML(markup) {
        storedHTML = markup;
        if (!dom) return;
        const started = performance.now();
        const parsed = parse(markup);
        const target = name === "TEMPLATE" ? (this.content ||= node("#fragment")) : this;
        target.childNodes = parsed.childNodes; join(target);
        stats.parseMs += performance.now() - started;
      },
      getAttribute(key) { stats.attributeReads++; return attrs.get(key) ?? null; },
      hasAttribute(key) { stats.attributeReads++; return attrs.has(key); },
      setAttribute(key, next) { stats.attributeWrites++; attrs.set(key, String(next)); },
      removeAttribute(key) { stats.attributeWrites++; attrs.delete(key); },
      append(child) { if (child.parentNode) child.remove(); const last = this.lastChild;
        child.parentNode = this; child.previousSibling = last; child.nextSibling = null;
        if (last) last.nextSibling = child; this.childNodes.push(child); stats.inserts++; },
      insertBefore(child, reference) {
        if (child === reference) return child;
        if (child.parentNode) child.remove();
        const i = reference ? this.childNodes.indexOf(reference) : this.childNodes.length;
        if (i < 0) throw new Error("Detached insertBefore reference");
        const previous = this.childNodes[i - 1] || null;
        child.parentNode = this; child.previousSibling = previous; child.nextSibling = reference;
        if (previous) previous.nextSibling = child; if (reference) reference.previousSibling = child;
        this.childNodes.splice(i, 0, child); stats.inserts++; return child;
      },
      remove() {
        if (!this.parentNode) return;
        const parent = this.parentNode; parent.childNodes.splice(parent.childNodes.indexOf(this), 1);
        if (this.previousSibling) this.previousSibling.nextSibling = this.nextSibling;
        if (this.nextSibling) this.nextSibling.previousSibling = this.previousSibling;
        this.parentNode = this.previousSibling = this.nextSibling = null; stats.removes++;
      },
      replaceWith(next) { const parent = this.parentNode; if (!parent) throw new Error("Detached replacement"); parent.insertBefore(next, this); this.remove(); },
      cloneNode(deep) {
        stats.clones++; const copy = node(name, this.nodeValue);
        for (const [key, entry] of attrs) copy.setAttribute(key, entry);
        if (deep) { copy.childNodes = this.childNodes.map((child) => child.cloneNode(true)); join(copy); }
        return copy;
      },
      contains(child) { if (child?.owner === this) return true; for (let next = child; next; next = next.parentNode) if (next === this) return true; return false; },
      addEventListener(event, listener) { listeners.set(event, listener); },
      removeEventListener(event) { listeners.delete(event); },
      dispatch(event, target) { listeners.get(event)?.({ target }); },
      querySelector(selector) {
        const match = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
        const accepts = (child) => match && child.nodeType === 1 && child.hasAttribute(match[1]) && (match[2] === undefined || child.getAttribute(match[1]) === match[2]);
        const queue = [...this.childNodes];
        while (queue.length) { const child = queue.shift(); if (accepts(child)) return child; queue.unshift(...child.childNodes); }
        return null;
      },
    };
    return value;
  }
  function parse(markup) {
    const root = node("#fragment"), stack = [root];
    const tokens = markup.match(/<\/?[a-zA-Z][^>]*(?:"[^"]*")?[^>]*>|[^<]+/g) || [];
    for (const token of tokens) {
      if (token.startsWith("</")) { stack.pop(); continue; }
      let child;
      if (token[0] === "<") {
        const name = token.match(/^<([\w-]+)/)[1].toUpperCase(); child = node(name);
        const attributes = token.slice(name.length + 1, token.endsWith("/>") ? -2 : -1);
        for (const match of attributes.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) child.setAttribute(match[1], decode(match[2] ?? match[3] ?? match[4] ?? ""));
        stack.at(-1).childNodes.push(child);
        if (!VOID.has(name) && !token.endsWith("/>")) stack.push(child);
      } else { child = node("#text", decode(token)); stack.at(-1).childNodes.push(child); }
    }
    function link(value) { join(value); for (const child of value.childNodes) link(child); }
    link(root); return root;
  }
  const document = { createElement: (name) => node(name.toUpperCase()) };
  const root = node("MAIN");
  return { root, node, document };
}

module.exports = { createFixture };
