import { test } from "node:test";
import assert from "node:assert/strict";
import { patchRows } from "../src/prview.ts";

test("patchRows: hunks, line numbers, owners, and word-level changes on edited lines", () => {
  const patch = "@@ -1,3 +1,3 @@\n const a = 1;\n-const total = price * qty;\n+const total = price * qty * (1 - discount);\n end\n@@ -10,1 +10,2 @@\n x\n+brand new\n\\ No newline at end of file";
  const rows = patchRows(patch, (n) => (n === 2 ? "agent" : "human"));
  assert.deepEqual(rows.map((r) => [r.k, r.o ?? null, r.n ?? null, r.h ?? null]), [
    ["ctx", 1, 1, "@@ -1,3 +1,3 @@"], ["del", 2, null, null], ["add", null, 2, null], ["ctx", 3, 3, null],
    ["ctx", 10, 10, "@@ -10,1 +10,2 @@"], ["add", null, 11, null],
  ]);
  // Edited line: only the new words are marked new, all owned by the line's author.
  assert.deepEqual(rows[2].s, [["const total = price * qty", "agent", false], [" * (1 - discount)", "agent", true], [";", "agent", false]]);
  assert.deepEqual(rows[1].d, [["const total = price * qty", false], [";", false]]);
  // Brand-new line stays whole.
  assert.deepEqual(rows[5].s, [["brand new", "human", true]]);
});
