import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { applyRuns, charDiff, lineOwners, Run, splitLines } from "./apply.js";
import { readText, Store } from "./store.js";
import { fileDiff } from "./ui.js";

/**
 * Commit link: each commit's line ownership, stored as a git note under refs/notes/prov.
 * Notes travel with `prov notes push` and are what the PR Action / GitHub App read.
 *
 * v1 shape (compact JSON):
 *   actors: [{ id: "a:claude/claude-opus-5-5@high", kind: "agent", harness, model, effort } | { id: "h:jude", kind: "human" } | { id: "?", kind: "unknown" }]
 *   files[path].owners: [[firstLine, lastLine, actorIdx], …]  — every line of the file at this commit
 *   files[path].added:  { actorIdx: lines added by this commit }
 *   added: totals of files[*].added
 */
export const NOTES_REF = "refs/notes/prov";
export type NoteActor = { id: string; kind: "agent" | "human" | "unknown"; harness?: string; model?: string; effort?: string };
export type NoteFile = { lines: number; owners: [number, number, number][]; added: Record<string, number> };
export type Note = { v: 1; commit: string; parent: string | null; actors: NoteActor[]; files: Record<string, NoteFile>; added: Record<string, number> };

const UNKNOWN = "?";

function git(root: string, args: string[], input?: string): string | undefined {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/** File content at a commit; undefined if absent, null if binary. */
function blob(root: string, rev: string, path: string): string | undefined | null {
  const s = git(root, ["cat-file", "blob", `${rev}:${path}`]);
  if (s === undefined) return undefined;
  return s.includes("\0") ? null : s;
}

/** Who owns this line: author of its new chars on an added line, else of most of its chars. */
function rowOwner(segs: [string, string, number][], added: boolean): string {
  const top = (keep: (n: number) => boolean) => {
    const m = new Map<string, number>();
    for (const [t, o, n] of segs) if (keep(n)) m.set(o, (m.get(o) ?? 0) + (t.length || 1));
    return [...m].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  return (added && top((n) => n === 1)) || top(() => true) || UNKNOWN;
}

/**
 * @param human envelope id to credit for committed text prov never saw (edited with no watcher running and
 *   no agent hook) — same rule as `prov watch`. Only applied when the working-tree file equals the committed
 *   one, so partially staged edits stay "unrecorded".
 */
export function buildNote(store: Store, root: string, rev = "HEAD", human?: number): Note | undefined {
  const sha = git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])?.trim();
  if (!sha) return undefined;
  const parent = git(root, ["rev-parse", "--verify", "--quiet", `${sha}^`])?.trim() || null;
  const paths = (git(root, ["diff-tree", "--no-commit-id", "-r", "--root", "--name-only", "-z", sha]) ?? "").split("\0").filter((p) => p && !p.startsWith(".prov/"));

  const actorIdx = new Map<string, number>();
  const actors: NoteActor[] = [];
  const idxOf = (envId: string): number => {
    let id = UNKNOWN;
    let a: NoteActor = { id: UNKNOWN, kind: "unknown" };
    if (envId !== UNKNOWN) {
      const r = store.db.prepare("SELECT kind, actor, harness, model, effort FROM envelopes WHERE id=?").get(Number(envId)) as any;
      if (r) {
        id = r.actor;
        a = r.kind === "human" ? { id, kind: "human" } : { id, kind: "agent", harness: r.harness ?? undefined, model: r.model ?? undefined, effort: r.effort ?? undefined };
      }
    }
    if (!actorIdx.has(id)) {
      actorIdx.set(id, actors.length);
      actors.push(a);
    }
    return actorIdx.get(id)!;
  };

  const files: Record<string, NoteFile> = {};
  const total: Record<string, number> = {};
  for (const path of paths) {
    const committed = blob(root, sha, path);
    if (typeof committed !== "string") continue; // deleted or binary
    const before = parent ? (blob(root, parent, path) ?? "") : "";
    if (human !== undefined && rev === "HEAD" && readText(join(root, path)) === committed && store.file(path)?.content !== committed) {
      store.applyChange(path, committed, store.activeSession([path], 120) ?? human);
    }
    // Map recorded ownership onto the committed text. Text prov never saw (e.g. partial staging) → unknown.
    const row = store.file(path);
    let runs: Run[];
    if (!row) runs = committed ? [{ l: committed.length, o: UNKNOWN }] : [];
    else if (row.content === committed) runs = row.runs;
    else runs = applyRuns(row.runs, charDiff(row.content, committed), UNKNOWN);

    const owners: [number, number, number][] = [];
    lineOwners(committed, runs).forEach((o, i) => {
      const idx = idxOf(o);
      const last = owners[owners.length - 1];
      if (last && last[2] === idx && last[1] === i) last[1] = i + 1;
      else owners.push([i + 1, i + 1, idx]);
    });
    const added: Record<string, number> = {};
    for (const r of fileDiff(before, committed, runs).rows) {
      if (r.k !== "add" || !r.s) continue;
      const idx = String(idxOf(rowOwner(r.s, true)));
      added[idx] = (added[idx] ?? 0) + 1;
      total[idx] = (total[idx] ?? 0) + 1;
    }
    files[path] = { lines: splitLines(committed).length, owners, added };
  }
  return { v: 1, commit: sha, parent, actors, files, added: total };
}

export function writeNote(root: string, note: Note): void {
  if (git(root, ["notes", `--ref=${NOTES_REF}`, "add", "-f", "-F", "-", note.commit], JSON.stringify(note) + "\n") === undefined) {
    throw new Error(`git notes add failed for ${note.commit.slice(0, 8)}`);
  }
}

export function readNote(root: string, rev: string): Note | undefined {
  const s = git(root, ["notes", `--ref=${NOTES_REF}`, "show", rev]);
  if (!s) return undefined;
  // Normally one JSON line; older setups may have concatenated notes — newest valid line wins.
  for (const line of s.trim().split("\n").reverse()) {
    try {
      const n = JSON.parse(line);
      if (n?.v === 1) return n;
    } catch {}
  }
  return undefined;
}

export function actorName(a: NoteActor): string {
  if (a.kind === "unknown") return "unrecorded";
  if (a.kind === "human") return a.id.replace(/^h:/, "");
  return a.id.replace(/^a:/, "");
}

/** "68% claude/claude-opus-5-5@high, 32% jude" over lines added in the commit. */
export function summarize(note: Note): string {
  const entries = Object.entries(note.added).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (!total) return "no added lines";
  return entries.map(([i, n]) => `${Math.round((n / total) * 100)}% ${actorName(note.actors[Number(i)])}`).join(", ") + ` (${total} line${total === 1 ? "" : "s"})`;
}

/** True while git is replaying commits (rebase, cherry-pick, revert): git copies their original notes itself. */
export function replaying(root: string): boolean {
  return ["rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"].some((p) => {
    const g = git(root, ["rev-parse", "--git-path", p])?.trim();
    return !!g && existsSync(join(root, g));
  });
}

const MARK = "# prov-hook";

/** Add (or refresh) our marked line in a git hook script, never clobbering someone else's hook. */
function hookLine(root: string, name: string, line: string, header: string): string {
  const rel = git(root, ["rev-parse", "--git-path", `hooks/${name}`])?.trim(); // respects core.hooksPath
  if (!rel) return `${name} hook: not a git repo, skipped`;
  const file = join(root, rel);
  if (existsSync(file)) {
    const cur = readFileSync(file, "utf8");
    if (cur.includes(MARK)) {
      writeFileSync(file, cur.split("\n").map((l) => (l.includes(MARK) ? line : l)).join("\n"));
      return `${name} hook: updated ${file}`;
    }
    if (!/^#!.*\b(sh|bash|zsh|dash)\b/.test(cur)) return `${name} hook: ${file} exists and isn't a shell script — add this line yourself:\n  ${line}`;
    writeFileSync(file, cur.replace(/\n*$/, "\n") + line + "\n");
    return `${name} hook: appended to existing ${file}`;
  }
  writeFileSync(file, `#!/bin/sh\n# ${header}\n${line}\n`);
  chmodSync(file, 0o755);
  return `${name} hook: installed ${file}`;
}

/**
 * post-commit: write the commit's ownership note.
 * pre-push: send notes along with every `git push` (guarded against recursion; never blocks the push).
 */
export function installGitHooks(root: string, bin: string): string[] {
  // Rebase/cherry-pick copy the original commit's note to the new commit. On amend our hook has already
  // written a fresh note, and "ignore" stops git concatenating the old one onto it (two JSON docs = invalid).
  git(root, ["config", "notes.rewriteRef", NOTES_REF]);
  git(root, ["config", "notes.rewriteMode", "ignore"]);
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const node = `command -v node >/dev/null 2>&1 && node --no-warnings ${q(bin)}`;
  return [
    hookLine(root, "post-commit", `${node} note --hook || true ${MARK}`, "Records who wrote each line (you or an AI agent) as a git note on refs/notes/prov."),
    hookLine(
      root,
      "pre-push",
      // `[ -n … ] ||` (not `[ -z … ] &&`): the line must exit 0 when skipped, or git aborts our own notes push.
      // Notes go in the background *after* this push exits ($PPID = git push): two back-to-back pushes to
      // the same repo make GitHub intermittently reject the second ("remote rejected … (failed)").
      `[ -n "$PROV_NOTES_PUSH" ] || { command -v node >/dev/null 2>&1 && (nohup node --no-warnings ${q(bin)} notes push "$1" --hook --after-pid $PPID </dev/null >/dev/null 2>&1 &); true; } ${MARK}`,
      "Pushes prov's ownership notes (refs/notes/prov) alongside your commits."
    ),
  ];
}

/** Fetch the remote's notes, merge (keep ours on the rare same-commit clash) and push. */
export function pushNotes(root: string, remote = "origin"): string {
  process.env.PROV_NOTES_PUSH = "1"; // our own push must not re-trigger the pre-push hook
  if (git(root, ["rev-parse", "--verify", "--quiet", NOTES_REF]) === undefined) return "no prov notes yet — commit something first";
  const tmp = "refs/notes/prov-remote";
  if (git(root, ["fetch", remote, `+${NOTES_REF}:${tmp}`]) !== undefined) {
    git(root, ["notes", `--ref=${NOTES_REF}`, "merge", "-s", "ours", tmp]);
    git(root, ["update-ref", "-d", tmp]);
  }
  const out = execFileSync("git", ["push", remote, NOTES_REF], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return `pushed ${NOTES_REF} to ${remote}${out.trim() ? "\n" + out.trim() : ""}`;
}
