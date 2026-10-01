const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { createFixture } = require("./helpers/title-performance-dom.cjs");

function fixture() {
  const stats = new Proxy({}, { get: (target, key) => target[key] || 0 });
  const { root } = createFixture(stats);
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../src/platform/ui/stable-list-dom.js"), "utf8")
    .replace(/^export /gm, ""), context);
  return { root, render: (html) => context.renderListMarkup(root, html) };
}

test("context-only changes retain keyed list rows, scroll and unsaved input values", () => {
  const { root, render } = fixture();
  const markup = (current, value = "stored") => `<div><section data-list-key="current">${current}</section><section data-list-key="controls"><input value="${value}"></section><section data-list-key="rows"><button data-list-key="a">A</button><button data-list-key="b">B</button></section></div>`;
  render(markup("A"));
  const list = root.querySelector('[data-list-key="rows"]'), row = root.querySelector('[data-list-key="b"]');
  const input = root.querySelector('[data-list-key="controls"]').firstChild;
  list.scrollTop = 73; input.value = "unsaved draft";
  for (const current of ["", "B", "C", "C"]) {
    render(markup(current));
    assert.ok(root.querySelector('[data-list-key="rows"]') === list);
    assert.ok(root.querySelector('[data-list-key="b"]') === row);
    assert.ok(root.querySelector('[data-list-key="controls"]').firstChild === input);
    assert.equal(input.value, "unsaved draft"); assert.equal(list.scrollTop, 73);
  }
  render(markup("C", "confirmed edit"));
  assert.equal(input.value, "confirmed edit", "an actual model change still reaches its input");
});

test("inserting and removing optional sections never consumes a later keyed list", () => {
  const { root, render } = fixture();
  render('<div><section data-list-key="rows"><button data-list-key="a">A</button></section></div>');
  const list = root.querySelector('[data-list-key="rows"]');
  for (const note of ['<p>Note</p>', '<p data-list-key="notice">Notice</p>', '']) {
    render(`<div>${note}<section data-list-key="rows"><button data-list-key="a">A</button></section></div>`);
    assert.ok(root.querySelector('[data-list-key="rows"]') === list);
    assert.equal(root.firstChild.childNodes.length, note ? 2 : 1);
  }
});

test("real row edits, reorder, insertion and deletion patch only their keyed entities", () => {
  const { root, render } = fixture();
  render('<div><button data-list-key="a">A</button><button data-list-key="b">B</button><button data-list-key="c">C</button></div>');
  const a = root.querySelector('[data-list-key="a"]'), c = root.querySelector('[data-list-key="c"]');
  render('<div><button data-list-key="c">Changed C</button><button data-list-key="a">A</button><button data-list-key="d">D</button></div>');
  assert.ok(root.firstChild.firstChild === c); assert.ok(c.nextSibling === a);
  assert.equal(c.firstChild.nodeValue, "Changed C");
  assert.equal(root.querySelector('[data-list-key="b"]'), null);
  assert.equal(root.firstChild.childNodes.length, 3);
});

test("removing an earlier keyed notice never detaches surviving focused controls", () => {
  const { root, render } = fixture();
  render('<div><section data-list-key="notice">Working</section><section data-list-key="controls"><button>Export</button></section></div>');
  const controls = root.querySelector('[data-list-key="controls"]');
  const remove = controls.remove;
  controls.remove = () => { assert.fail('Surviving controls must not be detached'); };
  render('<div><section data-list-key="controls"><button>Export</button></section></div>');
  assert.ok(root.firstChild.firstChild === controls);
  controls.remove = remove;
});

test("a keyed node type replacement advances the live cursor and leaves no duplicate controls", () => {
  const { root, render } = fixture();
  render('<div><div data-list-key="group">Group</div><button data-list-key="action">Open</button></div>');
  const action = root.querySelector('[data-list-key="action"]');
  render('<div><form data-list-key="group"><input value="Group"></form><button data-list-key="action">Open</button></div>');
  assert.equal(root.firstChild.firstChild.nodeName, "FORM");
  assert.ok(root.querySelector('[data-list-key="action"]') === action);
  assert.equal(root.firstChild.childNodes.length, 2);
});
