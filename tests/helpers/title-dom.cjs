// Minimal DOM protocol for the title patcher's algorithm tests. This deliberately
// does not simulate layout, focus or a native select popup; those need browser QA.
function textNode(value) {
  return {
    nodeType: 3, nodeName: "#text", nodeValue: value, parentNode: null,
    cloneNode() { return textNode(this.nodeValue); },
    remove() { detach(this); },
    replaceWith(next) { replace(this, next); },
  };
}

function detach(node) {
  const parent = node.parentNode;
  if (!parent) return;
  parent.childNodes.splice(parent.childNodes.indexOf(node), 1);
  node.parentNode = null;
}

function replace(node, next) {
  const parent = node.parentNode;
  parent.childNodes[parent.childNodes.indexOf(node)] = next;
  next.parentNode = parent;
  node.parentNode = null;
}

function element(name, attributes = {}, children = [], properties = {}) {
  const attrs = new Map(Object.entries(attributes));
  let value = properties.value || "", checked = Boolean(properties.checked);
  const node = {
    nodeType: 1, nodeName: name.toUpperCase(), parentNode: null, childNodes: [],
    writes: { attributes: 0, value: 0, checked: 0 },
    get attributes() { return Array.from(attrs, ([name, value]) => ({ name, value })); },
    get value() { return value; },
    set value(next) { this.writes.value += 1; value = next; },
    get checked() { return checked; },
    set checked(next) { this.writes.checked += 1; checked = next; },
    hasAttribute(name) { return attrs.has(name); },
    getAttribute(name) { return attrs.get(name) ?? null; },
    setAttribute(name, value) { this.writes.attributes += 1; attrs.set(name, String(value)); },
    removeAttribute(name) { this.writes.attributes += 1; attrs.delete(name); },
    append(child) { child.parentNode = this; this.childNodes.push(child); },
    remove() { detach(this); },
    replaceWith(next) { replace(this, next); },
    cloneNode(deep = false) {
      return element(this.nodeName, Object.fromEntries(attrs), deep ? this.childNodes.map((child) => child.cloneNode(true)) : [], { value, checked });
    },
  };
  for (const child of children) node.append(child);
  return node;
}

module.exports = { element, textNode };
