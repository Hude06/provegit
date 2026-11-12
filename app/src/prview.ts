/**
 * Data for the hosted "who wrote each line" PR page: GitHub's patch per file, turned into diff rows
 * (same shape the local `prov ui` renders) with the author of every head-side line from the prov notes.
 */
import { charDiff } from "../../cli/src/apply.js";
import { actorAt, displayName, fileOwnership, type PrCommit } from "../../cli/src/report.js";
import type { NoteActor } from "../../cli/src/notes.js";

/** s: [text, owner, isNew][] for head-side text; d: [text, removed][] for base-side text. h: hunk header starting here. */
export type Row = { k: "ctx" | "add" | "del"; o?: number; n?: number; s?: [string, string, boolean][]; d?: [string, boolean][]; h?: string };
export type ViewActor = { kind: NoteActor["kind"]; name: string; long: string; harness?: string; model?: string; effort?: string };
export type ViewFile = {
  path: string;
  previous?: string;
  status: string;
  addLines: number;
  delLines: number;
  added: Record<string, number>;
  rows: Row[];
  recorded: boolean;
  reason?: string;
  note?: string;
};
export type GhFile = { filename: string; previous_filename?: string; status: string; patch?: string; additions: number; deletions: number };

const MAX_ROWS = 20000;

/** Parse a GitHub `patch` into rows; `ownerOf(headLine)` gives each head-side line's author key. */
export function patchRows(patch: string, ownerOf: (line: number) => string): Row[] {
  const rows: Row[] = [];
  let o = 0, n = 0, header: string | undefined;
  for (const line of patch.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      header = line;
      continue;
    }
    if (!header && !rows.length) continue; // before the first hunk
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const text = line.slice(1);
    let row: Row;
    if (line[0] === "+") row = { k: "add", n, s: [[text, ownerOf(n), true]] }, n++;
    else if (line[0] === "-") row = { k: "del", o, d: [[text, true]] }, o++;
    else if (line[0] === " " || line === "") row = { k: "ctx", o, n, s: [[text, ownerOf(n), false]] }, o++, n++;
    else continue;
    if (header) (row.h = header), (header = undefined);
    rows.push(row);
  }
  // A trailing empty line is the split artefact of a final "\n", not a context line.
  const last = rows[rows.length - 1];
  if (last?.k === "ctx" && last.s![0][0] === "" && patch.endsWith("\n")) rows.pop();
  wordDiff(rows);
  return rows;
}

/** Pair deleted/added lines in each change block and mark only the changed words, like GitHub. */
function wordDiff(rows: Row[]): void {
  for (let i = 0; i < rows.length; ) {
    if (rows[i].k === "ctx") { i++; continue; }
    const dels: Row[] = [], adds: Row[] = [];
    while (i < rows.length && rows[i].k === "del") dels.push(rows[i++]);
    while (i < rows.length && rows[i].k === "add") adds.push(rows[i++]);
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const before = dels[k].d![0][0], after = adds[k].s![0][0], owner = adds[k].s![0][1];
      if (before.length + after.length > 2000) continue;
      const ops = charDiff(before, after);
      const same = ops.filter(([op]) => op === 0).reduce((s, [, t]) => s + t.trim().length, 0);
      if (!same) continue; // nothing in common: leave both lines whole
      dels[k].d = ops.filter(([op]) => op !== 1).map(([op, t]) => [t, op === -1]);
      adds[k].s = ops.filter(([op]) => op !== -1).map(([op, t]) => [t, owner, op === 1]);
    }
  }
}

export function prView(commits: PrCommit[], files: (GhFile & { lastCommit?: string })[]) {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const actors: Record<string, ViewActor> = {};
  const keyOf = (a: NoteActor): string => {
    const key = a.kind === "unknown" ? "?" : a.id;
    if (!actors[key]) {
      const long = displayName(a);
      const name = a.kind === "agent" ? a.harness ?? long : long;
      actors[key] = { kind: a.kind, name, long, harness: a.harness, model: a.model, effort: a.effort };
    }
    return key;
  };
  let rowBudget = MAX_ROWS;
  const out: ViewFile[] = files.map((f) => {
    const base = { path: f.filename, previous: f.previous_filename, status: f.status, addLines: f.additions, delLines: f.deletions };
    const own = fileOwnership(commits, bySha, { path: f.filename, lastCommit: f.lastCommit });
    const empty = { ...base, added: {}, rows: [], recorded: !!own.nf, reason: own.reason };
    if (!f.patch) return { ...empty, note: f.status === "removed" ? "File deleted." : "Binary file, or too large for GitHub to show a diff." };
    if (rowBudget <= 0) return { ...empty, note: "Not shown: this PR is too large to show every file." };
    const rows = patchRows(f.patch, (line) => keyOf(actorAt(own.note, own.nf, line)));
    rowBudget -= rows.length;
    const added: Record<string, number> = {};
    for (const r of rows) if (r.k === "add") added[r.s![0][1]] = (added[r.s![0][1]] ?? 0) + 1;
    return { ...base, added, rows, recorded: !!own.nf, reason: own.reason };
  });
  return { actors, files: out };
}
