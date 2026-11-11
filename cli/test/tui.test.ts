import { test } from "node:test";
import assert from "node:assert/strict";
import { charDiff } from "../src/apply.ts";
import { fileDiff } from "../src/ui.ts";
import { clean, eventDoc, fileDoc, width, wrap } from "../src/tui.ts";

const actors = {
  "1": { label: "h:me", kind: "human" as const },
  "2": { label: "agent:claude/opus", kind: "agent" as const, harness: "claude", model: "opus" },
};
const text = (spans: { t: string }[]) => spans.map((s) => s.t).join("");

test("clean: file text can't emit terminal escapes; tabs expand to stops", () => {
  const s = clean("a\x1b[2Jb\tc\r");
  assert.ok(!s.includes("\x1b") && !s.includes("\r"));
  assert.equal(clean("ab\tc"), "ab  c");
});

test("wrap: respects cell width of wide chars", () => {
  assert.equal(width("日本"), 4);
  const lines = wrap([{ t: "ab日本cd" }], 4);
  assert.deepEqual(lines.map(text), ["ab日", "本cd"]);
  assert.ok(lines.every((l) => width(text(l)) <= 4));
});

test("fileDoc: folds unchanged lines around a hunk", () => {
  const base = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const cur = base.replace("line 10\n", "line 10 changed\n");
  const d = fileDiff(base, cur, [{ l: cur.length, o: "1" }]);
  const doc = fileDoc(d.rows, actors);
  const folds = doc.lines.filter((l) => l.fold !== undefined).map((l) => l.fold);
  assert.deepEqual(folds, [7, 6]); // 20 lines − 1 del − 1 add − 2×3 ctx… = 7 above, 6 below
  assert.equal(doc.lines.filter((l) => l.hunk).length, 1);
  assert.equal(fileDoc(d.rows, actors, { whole: true }).lines.filter((l) => l.fold).length, 0);
});

test("eventDoc: inserted lines are +, rewritten ~, removed −", () => {
  const before = "keep\nold line\ngone\n";
  const after = "keep\nnew line\nadded\n";
  const doc = eventDoc(charDiff(before, after), "2", actors);
  const signs = doc.lines.map((l) => l.sign);
  assert.equal(signs[0], " ");
  assert.ok(signs.includes("~"));
  assert.equal(doc.lines.at(-1)!.num[1], "3");
});
