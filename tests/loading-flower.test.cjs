const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadFlower() {
  const context = vm.createContext({
    Date: { now: () => 2500 },
    document: {
      createElement(tag) {
        return { tag, attributes: {}, style: { setProperty(name, value) { this[name] = value; } },
          setAttribute(name, value) { this.attributes[name] = value; } };
      },
    },
  });
  const source = fs.readFileSync(path.resolve(__dirname, "../src/platform/ui/loading-flower.js"), "utf8");
  vm.runInContext(source.replace(/^export /gm, ""), context);
  return context;
}

test("template and DOM renderers share the exact six-petal loading glyph", () => {
  const { createLoadingFlower, loadingFlowerMarkup } = loadFlower();
  const flower = createLoadingFlower(2000);
  const markup = loadingFlowerMarkup(2000);
  assert.equal(flower.tag, "span");
  assert.equal(flower.className, "tidy-loading-flower");
  assert.equal(flower.attributes["aria-hidden"], "true");
  assert.equal(flower.style["--tidy-loading-phase"], "-500ms");
  assert.equal(markup, `<span class="tidy-loading-flower" aria-hidden="true" style="--tidy-loading-phase: -500ms">${flower.innerHTML}</span>`);
  assert.equal((flower.innerHTML.match(/class="tidy-loading-flower__petal"/g) || []).length, 6);
  assert.match(flower.innerHTML, /class="tidy-loading-flower__hands"/);
  assert.match(flower.innerHTML, /class="tidy-loading-flower__hub"/);
});

test("flower phase defaults safely and never interpolates arbitrary markup", () => {
  const { createLoadingFlower, loadingFlowerMarkup } = loadFlower();
  for (const startedAt of [undefined, null, NaN, Infinity, 3000, '"><script>bad</script>']) {
    assert.equal(createLoadingFlower(startedAt).style["--tidy-loading-phase"], "0ms");
    assert.match(loadingFlowerMarkup(startedAt), /style="--tidy-loading-phase: 0ms"/);
    assert.doesNotMatch(loadingFlowerMarkup(startedAt), /<script>/);
  }
});
