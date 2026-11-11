import { test } from "node:test";
import assert from "node:assert/strict";
import { addedLines, annotations, buildReport, markdown, MARKER } from "../src/report.ts";
import type { Note } from "../src/notes.ts";

test("addedLines reads head line numbers from a unified diff", () => {
  const patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n a\n-b\n+B\n+C\n c\n@@ -10 +11,2 @@\n+y\n+z\n\\ No newline at end of file";
  assert.deepEqual(addedLines(patch), [2, 3, 11, 12]);
});

const note = (commit: string, files: Note["files"]): Note => ({
  v: 1, commit, parent: null, added: {},
  actors: [{ id: "h:jude", kind: "human" }, { id: "a:claude/claude-opus-5-5@high", kind: "agent", harness: "claude", model: "claude-opus-5-5", effort: "high" }],
  files,
});

test("buildReport: newest note per file wins; agent blocks become annotations", () => {
  const c1 = note("c1", { "a.ts": { lines: 4, owners: [[1, 4, 0]], added: {} } });
  const c2 = note("c2", { "a.ts": { lines: 6, owners: [[1, 2, 0], [3, 5, 1], [6, 6, 0]], added: {} } });
  const r = buildReport(
    [{ sha: "c1", note: c1 }, { sha: "c2", note: c2 }, { sha: "c3" }],
    [{ path: "a.ts", added: [3, 4, 5, 6], lastCommit: "c2" }, { path: "b.ts", added: [1], lastCommit: "c3" }]
  );
  assert.equal(r.added, 5);
  assert.equal(r.totals.get("a:claude/claude-opus-5-5@high"), 3);
  assert.equal(r.totals.get("h:jude"), 1);
  assert.equal(r.totals.get("?"), 1);
  assert.deepEqual(r.missingNotes, ["c3"]);
  const anns = annotations(r);
  assert.equal(anns.length, 1);
  assert.deepEqual([anns[0].path, anns[0].start_line, anns[0].end_line], ["a.ts", 3, 5]);
  assert.match(anns[0].title, /claude · claude-opus-5-5 \(high\)/);
  const md = markdown(r);
  assert.ok(md.startsWith(MARKER));
  assert.match(md, /\*\*5 added lines\*\* across 2 files: claude · claude-opus-5-5 \(high\) 60%, jude 20%, not recorded 20%/);
  assert.match(md, /`b\.ts` \| 1 \| not recorded \(last changed in c3, which has no prov note\)/);
});
