const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// This fixture implements DOM selector semantics only. It must not know which
// sidebar links production excludes, so removing a production filter fails here.
class Element {
  constructor(tagName, attributes = {}, children = []) {
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attributes };
    this.children = [];
    this.parentElement = null;
    this.append(...children);
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  matches(selector) {
    return selector.split(",").some((part) => {
      const match = /^([a-z]+)?(?:\[([\w-]+)(?:([*^]?=)"([^"]*)")?\])?$/.exec(part.trim());
      assert.ok(match, `Unsupported fixture selector: ${part}`);
      const [, tag, attribute, operator, expected] = match;
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      if (!attribute) return Boolean(tag);
      const actual = this.getAttribute(attribute);
      if (actual === null) return false;
      if (!operator) return true;
      if (operator === "=") return actual === expected;
      if (operator === "^=") return actual.startsWith(expected);
      if (operator === "*=") return actual.includes(expected);
      throw new Error(`Unsupported fixture operator: ${operator}`);
    });
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (child.matches(selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
}

const link = (href = "/c/shared", attributes = {}) => new Element("a", { href, ...attributes });
const row = (...children) => new Element("div", {}, children);
const locator = (value = "/c/shared") => ({ strategy: "href", value });
function load(...children) {
  const document = new Element("html", {}, children);
  const context = vm.createContext({ document });
  const filename = path.resolve(__dirname, "../src/platform/chatgpt/sidebar-dom.js");
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
  assert.ok(context.TidyChatgptSidebarDom, "The real sidebar helper must be loaded");
  return { api: context.TidyChatgptSidebarDom, document };
}
function equalNodes(actual, expected) {
  assert.equal(actual.length, expected.length);
  expected.forEach((node, index) => assert.equal(actual[index], node, `Node ${index} identity/order`));
}

for (const position of ["before", "after"]) {
  test(`task auxiliary link ${position} title never becomes a sidebar target`, () => {
    const title = link("/c/shared", { class: "interactive-row-link", tabindex: "0" });
    const auxiliary = link("/c/shared", { class: "interactive-row-link", "aria-hidden": "true", tabindex: "-1" });
    const children = position === "before" ? [auxiliary, title] : [title, auxiliary];
    const { api } = load(row(...children));
    equalNodes(api.candidates(), [title]);
    equalNodes(api.findAll(locator()), [title]);
    assert.equal(api.find(locator()), title);
  });
}

test("aria-hidden is checked on the link itself and case-insensitively", () => {
  const excluded = ["true", "TRUE", "TrUe"].map((value) => link("/c/shared", { "aria-hidden": value }));
  const retained = [link(), ...["false", "FALSE", "", "0"].map((value) => link("/c/shared", { "aria-hidden": value }))];
  const { api } = load(row(...excluded, ...retained));
  equalNodes(api.candidates(), retained);
});

test("hidden ancestors, tabindex and visibility do not remove real project copies", () => {
  const folded = link("/c/shared", { tabindex: "-1" });
  const lazy = link("/c/shared", { hidden: "", style: "display: none" });
  const visible = link();
  const { api } = load(
    new Element("section", { "aria-hidden": "true" }, [row(folded)]),
    new Element("section", { hidden: "", style: "visibility: hidden" }, [row(lazy)]),
    row(visible),
  );
  equalNodes(api.candidates(), [folded, lazy, visible]);
  equalNodes(api.findAll(locator()), [folded, lazy, visible]);
});

for (const [name, tag, attributes] of [
  ["main content", "main", {}],
  ["classic message", "div", { "data-message-id": "message-1" }],
  ["composed message", "section", { "data-chatgpt-search-message-ids": "message-2 message-3" }],
  ["native dialog", "dialog", {}],
  ["dialog role", "section", { role: "dialog" }],
  ["modal scope", "div", { "aria-modal": "true" }],
]) {
  test(`${name} links are excluded even when their href matches a sidebar row`, () => {
    const outside = link();
    const inside = link();
    const { api } = load(row(outside), new Element(tag, attributes, [row(inside)]));
    equalNodes(api.candidates(), [outside]);
    equalNodes(api.findAll(locator()), [outside]);
    assert.equal(api.find(locator()), outside);
  });
}

test("closest includes the candidate itself for message and dialog attributes", () => {
  const title = link();
  const excluded = [
    link("/c/shared", { "data-message-id": "message-1" }),
    link("/c/shared", { "data-chatgpt-search-message-ids": "message-2" }),
    link("/c/shared", { role: "dialog" }),
    link("/c/shared", { "aria-modal": "true" }),
  ];
  const { api } = load(row(...excluded, title));
  equalNodes(api.candidates(), [title]);
});

test("candidate selectors preserve supported paths and document order without row markers", () => {
  const conversation = link("/c/one");
  const project = link("/g/g-p-project/c/two");
  const group = link("/gg/three");
  const unrelated = [link("/"), link("/g/g-p-project"), new Element("button", { href: "/c/four" }), new Element("a")];
  const { api } = load(row(group), row(...unrelated), row(project), row(conversation));
  equalNodes(api.candidates(), [group, project, conversation]);
});

test("findAll keeps independent duplicate href rows and find returns the first eligible row", () => {
  const auxiliary = link("/c/shared", { "aria-hidden": "true" });
  const project = link();
  const recent = link();
  const { api } = load(row(auxiliary, project), row(recent));
  equalNodes(api.findAll(locator()), [project, recent]);
  assert.equal(api.find(locator()), project);
});

test("locator matching uses exact raw href without removing or rewriting query parameters", () => {
  const plain = link("/c/shared");
  const query = link("/c/shared?task=abc&mode=one");
  const reversed = link("/c/shared?mode=one&task=abc");
  const hash = link("/c/shared#task");
  const encoded = link("/c/shared?task=a%2Fb");
  const decoded = link("/c/shared?task=a/b");
  const { api } = load(row(plain, query, reversed, hash, encoded, decoded));
  for (const candidate of [plain, query, reversed, hash, encoded, decoded]) {
    equalNodes(api.findAll(locator(candidate.getAttribute("href"))), [candidate]);
    assert.equal(api.find(locator(candidate.getAttribute("href"))), candidate);
  }
  equalNodes(api.findAll(locator("https://chatgpt.com/c/shared")), []);
});

test("explicit roots scope all three APIs independently from the default document", () => {
  const first = link();
  const second = link();
  const subtree = new Element("nav", {}, [row(second)]);
  const { api } = load(row(first), subtree);
  equalNodes(api.candidates(), [first, second]);
  equalNodes(api.candidates(subtree), [second]);
  equalNodes(api.findAll(locator(), subtree), [second]);
  assert.equal(api.find(locator(), subtree), second);
  assert.equal(api.find(locator()), first);
});

test("unsupported or missing locators never select a row", () => {
  const { api } = load(row(link()));
  for (const value of [null, undefined, {}, { strategy: "conversation-id", value: "shared" }, { strategy: "href" }, locator("/c/missing")]) {
    equalNodes(api.findAll(value), []);
    assert.equal(api.find(value), null);
  }
});
