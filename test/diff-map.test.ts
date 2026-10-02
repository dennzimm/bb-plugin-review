import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorLine, mapDiffLines, rangeInDiff } from "../shared/diff-map.ts";

const diff = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -10,4 +10,5 @@ function x() {",
  " context10",
  "-removed11",
  "+added11",
  "+added12",
  " context13",
  " context14",
  "@@ -40,2 +41,3 @@",
  " c41",
  "+a42",
  " c43",
].join("\n");

test("maps new-side lines to added or context with old line numbers", () => {
  const map = mapDiffLines(diff);
  assert.deepEqual(map.get(10), { kind: "context", oldLine: 10 });
  assert.deepEqual(map.get(11), { kind: "added", oldLine: null });
  assert.deepEqual(map.get(12), { kind: "added", oldLine: null });
  assert.deepEqual(map.get(13), { kind: "context", oldLine: 12 });
  assert.deepEqual(map.get(42), { kind: "added", oldLine: null });
  assert.deepEqual(map.get(43), { kind: "context", oldLine: 41 });
  assert.equal(map.has(20), false);
});

test("anchors and suggestion ranges", () => {
  const map = mapDiffLines(diff);
  assert.equal(anchorLine(map, 11, 12), 12);
  assert.equal(anchorLine(map, 13, 30), 14);
  assert.equal(anchorLine(map, 20, 30), null);
  assert.equal(rangeInDiff(map, 10, 14), true);
  assert.equal(rangeInDiff(map, 14, 16), false);
});

test("comments with suggestions sit on exactly the replaced lines", async () => {
  const { planComment } = await import("../shared/diff-map.ts");
  const map = mapDiffLines(diff);
  // Suggestion for line 11-12 inside a finding about 10-14: anchored at 12, replaces 11-12.
  assert.deepEqual(planComment(map, { start: 10, end: 14 }, { start: 11, end: 12 }), { anchor: 12, start: 11, replaces: { start: 11, end: 12 } });
  // Suggestion outside the diff cannot be applied: comment falls back to the finding range.
  assert.deepEqual(planComment(map, { start: 10, end: 14 }, { start: 20, end: 21 }), { anchor: 14, start: 10, replaces: null });
  // No suggestion, partly outside the diff: single-line comment on the last diff line.
  assert.deepEqual(planComment(map, { start: 13, end: 30 }, null), { anchor: 14, start: 14, replaces: null });
});
