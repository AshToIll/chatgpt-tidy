// List data and the currently open conversation are independent. Patch the
// existing tree instead of remounting it on every snapshot: native selects,
// focused inputs, row identity and scroll containers must stay alive.
// data-list-key is unique among siblings; use it for sections and entity rows.
const listNodeKey = (node) => node.nodeType === 1 ? node.getAttribute("data-list-key") : null;

export function patchListNode(node, next) {
  if (node.nodeType !== next.nodeType || node.nodeName !== next.nodeName) {
    const replacement = next.cloneNode(true);
    node.replaceWith(replacement);
    return replacement;
  }
  if (node.nodeType !== 1) {
    if (node.nodeValue !== next.nodeValue) node.nodeValue = next.nodeValue;
    return node;
  }
  // An unchanged value attribute must not overwrite an unsaved live draft.
  // This also protects group names/notes when only the current card changes.
  const valueChanged = node.getAttribute("value") !== next.getAttribute("value");
  const textChanged = node.nodeName === "TEXTAREA" && node.textContent !== next.textContent;
  for (const attr of Array.from(node.attributes)) if (!next.hasAttribute(attr.name)) node.removeAttribute(attr.name);
  for (const attr of Array.from(next.attributes)) if (node.getAttribute(attr.name) !== attr.value) node.setAttribute(attr.name, attr.value);
  patchListChildren(node, next);
  if (node.nodeName === "SELECT" && node.value !== next.value) node.value = next.value;
  if (node.nodeName === "INPUT") {
    if (node.checked !== next.checked) node.checked = next.checked;
    if (valueChanged && node.value !== next.value) node.value = next.value;
  }
  if (textChanged && node.value !== next.value) node.value = next.value;
  return node;
}

function patchListChildren(parent, nextParent) {
  // One sibling index per parent avoids N-squared row matching. Unchanged
  // lists cause no insert/remove operations, even when the current card varies.
  const keyed = new Map(Array.from(parent.childNodes).map(node => [listNodeKey(node), node]).filter(([key]) => key));
  // 先删除消失的 keyed 区块。否则删除前面的提示卡时，insertBefore 会先搬动
  // 后面的表单；节点虽没重建，浏览器仍会因移出再插入而丢掉它里面的焦点。
  const nextKeys = new Set(Array.from(nextParent.childNodes).map(listNodeKey).filter(Boolean));
  for (const [key, node] of keyed) if (!nextKeys.has(key)) { node.remove(); keyed.delete(key); }
  let cursor = parent.firstChild;
  for (const next of Array.from(nextParent.childNodes)) {
    const key = listNodeKey(next);
    if (key) {
      const found = keyed.get(key);
      if (found && found !== cursor) parent.insertBefore(found, cursor);
      else if (!found) parent.insertBefore(next.cloneNode(true), cursor);
      cursor = found || (cursor ? cursor.previousSibling : parent.lastChild);
    } else if (cursor && listNodeKey(cursor)) {
      // Inserting an optional unkeyed note must not consume the next keyed
      // control/list. Its key may still appear later in the desired order.
      parent.insertBefore(next.cloneNode(true), cursor);
      cursor = cursor.previousSibling;
    }
    if (!cursor) { parent.append(next.cloneNode(true)); cursor = parent.lastChild; }
    else cursor = patchListNode(cursor, next);
    if (key) keyed.set(key, cursor);
    cursor = cursor.nextSibling;
  }
  while (cursor) { const following = cursor.nextSibling; cursor.remove(); cursor = following; }
}

export function renderListMarkup(root, markup) {
  const template = root.ownerDocument.createElement("template");
  template.innerHTML = markup;
  patchListChildren(root, template.content);
}
