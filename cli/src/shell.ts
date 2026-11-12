import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { mergeRuns, type Run } from "./apply.js";
import { readNote, type Note } from "./notes.js";
import { readText, Store } from "./store.js";

/**
 * Attribution for agent shell commands (Claude Code `Bash`, Codex `exec_command`, OpenCode `bash`).
 * A shell command can write any file, so there are no paths to go on:
 *  - before: anything changed since prov last looked is caught up first (credited as the watcher would),
 *    then the time and HEAD are remembered;
 *  - after: every file modified since then was written by the command → the agent.
 * Content that matches the committed version came out of git (checkout, restore, stash, pull…), not
 * from the agent: it takes its owners from that commit's prov note instead.
 */

const SCAN_LIMIT = 100_000;

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/** Files prov tracks in a repo: committed + untracked-but-not-ignored. */
export function repoFiles(root: string): string[] {
  const out = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]) ?? "";
  return [...new Set(out.split("\0").filter((p) => p && !p.startsWith(".prov/")))].slice(0, SCAN_LIMIT);
}

const mtime = (abs: string): number | undefined => {
  try {
    return statSync(abs).mtimeMs / 1000;
  } catch {
    return undefined;
  }
};

/** git's blob id for some text, to tell "restored from git" apart from "written". */
export const blobId = (text: string) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

const stateKey = (session: string) => `shell:${session}`;
type Pending = { t: number; head?: string };

/** Credit for files changed outside any hook: an agent mid-edit on that path, else the human. */
function catchUp(store: Store, root: string, human: number, ttlSec: number): number {
  const last = store.lastRecorded();
  let n = 0;
  for (const path of repoFiles(root)) {
    const m = mtime(join(root, path));
    const seen = last.get(path);
    if (m === undefined || (seen !== undefined && m <= seen)) continue;
    const content = readText(join(root, path));
    if (typeof content !== "string") continue;
    if (store.applyChange(path, content, store.activeSession([path], ttlSec) ?? human)) n++;
  }
  // Deleted files stay in `git ls-files` until staged, so "gone" means: no longer on disk.
  for (const path of last.keys()) {
    if (mtime(join(root, path)) !== undefined) continue;
    if (store.file(path)?.content) store.applyChange(path, "", human), n++;
  }
  return n;
}

export function shellBefore(store: Store, root: string, session: string, human: number, ttlSec = 120): number {
  const caught = catchUp(store, root, human, ttlSec);
  const pending: Pending = { t: Date.now() / 1000, head: git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])?.trim() };
  store.metaSet(stateKey(session), JSON.stringify(pending));
  return caught;
}

/** Char runs for `content` from a note's line owners; lines the note doesn't cover go to `fallback`. */
export function runsFromNote(store: Store, note: Note, path: string, content: string, fallback: number): Run[] {
  const nf = note.files[path];
  const envOf = new Map<number, number>();
  const env = (idx: number): number => {
    if (!envOf.has(idx)) {
      const a = note.actors[idx];
      envOf.set(
        idx,
        !a || a.kind === "unknown" ? fallback : a.kind === "human" ? store.human(a.id.replace(/^h:/, "")) : store.agent(a.harness ?? a.id.replace(/^a:/, "").split("/")[0], a.model, a.effort)
      );
    }
    return envOf.get(idx)!;
  };
  const runs: Run[] = [];
  const lines = content.split("\n");
  lines.forEach((text, i) => {
    const len = text.length + (i < lines.length - 1 ? 1 : 0);
    if (!len) return;
    const owner = nf?.owners.find(([a, b]) => i + 1 >= a && i + 1 <= b);
    runs.push({ l: len, o: String(owner ? env(owner[2]) : fallback) });
  });
  return mergeRuns(runs);
}

export type ShellResult = { agent: string[]; fromGit: string[] };

export function shellAfter(store: Store, root: string, session: string, agent: number, human: number): ShellResult {
  const res: ShellResult = { agent: [], fromGit: [] };
  const raw = store.metaGet(stateKey(session));
  if (!raw) return res;
  store.metaDelete(stateKey(session));
  const pending: Pending = JSON.parse(raw);

  const files = repoFiles(root);
  // 1 s slack: some filesystems store mtimes in whole seconds.
  const changed = files.filter((p) => (mtime(join(root, p)) ?? 0) >= pending.t - 1);
  const removed = [...store.lastRecorded().keys()].filter((p) => mtime(join(root, p)) === undefined && store.file(p)?.content);
  if (!changed.length && !removed.length) return res;

  const head = git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])?.trim();
  const tree = new Map<string, string>();
  if (head) {
    for (const entry of (git(root, ["ls-tree", "-r", "-z", "--full-tree", head]) ?? "").split("\0")) {
      const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
      if (m) tree.set(m[2], m[1]);
    }
  }
  let note: Note | undefined | null = null;
  const headNote = () => (note === null ? (note = head ? readNote(root, head) : undefined) : note);

  for (const path of changed) {
    const content = readText(join(root, path));
    if (typeof content !== "string") continue;
    if (tree.get(path) === blobId(content)) {
      // Came out of git: ownership is whatever was recorded when it was committed.
      const n = headNote();
      if (n?.files[path]) {
        const runs = runsFromNote(store, n, path, content, human);
        const cur = store.file(path);
        if (!cur || cur.content !== content || JSON.stringify(cur.runs) !== JSON.stringify(runs)) {
          store.setFile(path, content, runs, human);
          res.fromGit.push(path);
        }
      } else if (store.applyChange(path, content, human)) res.fromGit.push(path);
      continue;
    }
    if (store.applyChange(path, content, agent)) res.agent.push(path);
  }
  const headMoved = head !== pending.head;
  for (const path of removed) if (store.applyChange(path, "", headMoved ? human : agent)) (headMoved ? res.fromGit : res.agent).push(path);
  return res;
}
