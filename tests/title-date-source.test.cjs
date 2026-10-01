const assert = require("node:assert/strict");
const test = require("node:test");
const { measure } = require("../tools/benchmark-title-backend.cjs");

for (const detailTimeOffsetMs of [802, 1700]) {
  test(`real worker/core/adapter validates a ${detailTimeOffsetMs}ms catalog/detail drift without changing the confirmed range`, async () => {
    // The real plural-detail parser receives fractional Unix seconds; the
    // directory supplies epoch milliseconds through the actual worker route.
    // Synthetic fetch asserts that the only POST contains the reviewed title.
    const result = await measure(1, { detailTimeOffsetMs, mode: "range" });
    assert.equal(result.stages.preview.metadata, 0);
    assert.equal(result.stages.replan.session, 0);
    assert.equal(result.stages.replan.metadata, 0);
    assert.equal(result.stages.step.metadata, 1); // existing preflight only on clear 2xx
    assert.equal(result.stages.step.preflight, 1);
    assert.equal(result.stages.step.readback, 0);
    assert.equal(result.stages.step.post, 1);
  });
}

test("worker and separately loaded page model agree across date formats, regional locales and both modes", async () => {
  // The worker has the shared UI formatter; the page model uses its standalone
  // formatting implementation. Do not hide that distinction with a shared VM
  // object: all confirmed titles must survive the actual adapter preflight.
  for (const mode of ["created", "range"]) for (const locale of ["en-US", "en-GB", "zh-CN", "ja-JP", "ar-EG"]) {
    for (const dateFormat of ["locale", "iso", "slash", "dot", "compact"]) {
      const result = await measure(1, { detailTimeOffsetMs: 1700, mode, locale, dateFormat });
      assert.equal(result.stages.step.post, 1);
      assert.equal(result.stages.step.metadata, 1);
    }
  }
});
