import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Ops } from "./apply.js";
import { readText, Store } from "./store.js";
import { fileDiff, FileDiff } from "./ui.js";

export type FileChange = { path: string; status: "added" | "deleted" | "modified"; addLines: number; delLines: number; added: Record<string, number> };
export type Actor = { label: string; kind: "human" | "agent"; harness?: string; model?: string; effort?: string };
export type EditEvent = { id: number; ts: number; path: string; env_id: number; ins: number; del: number };

const REF = /^[A-Za-z0-9._\/~^@{}-]{1,200}$/;

/** Read side of the provenance db + git, shared by the web (`prov ui`) and terminal (`prov tui`) viewers. */
export class Changes {
  constructor(readonly store: Store) {}

  get root(): string {
    return this.store.root;
  }

  private git(args: string[]): string | undefined {
    try {
      return execFileSync("git", args, { cwd: this.root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return undefined;
    }
  }

  /** Commit sha for `ref`; null = unborn HEAD (no commits yet: everything is new); undefined = not a commit. */
  resolveBase(ref: string): string | null | undefined {
    if (!REF.test(ref) || ref.startsWith("-")) return undefined;
    const sha = this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])?.trim();
    if (sha) return sha;
    return ref === "HEAD" ? null : undefined;
  }

  private baseText(sha: string | null, path: string): string {
    return sha ? (this.git(["show", `${sha}:${path}`]) ?? "") : "";
  }

  private current(path: string): string {
    return this.store.file(path)?.content ?? readText(join(this.root, path)) ?? "";
  }

  private changedPaths(sha: string | null): string[] {
    const z = (s: string | undefined) => (s ?? "").split("\0").filter(Boolean);
    const set = new Set<string>(z(this.git(["ls-files", "--others", "--exclude-standard", "-z"])));
    if (sha) for (const p of z(this.git(["diff", "--name-only", "-z", sha, "--"]))) set.add(p);
    else for (const p of z(this.git(["ls-files", "-z"]))) set.add(p);
    return [...set].filter((p) => !p.startsWith(".prov/")).sort();
  }

  /** Files that differ from `sha`, with line counts and who added how many chars. */
  files(sha: string | null, limit = 500): FileChange[] {
    const out: FileChange[] = [];
    for (const path of this.changedPaths(sha).slice(0, limit)) {
      const cur = this.current(path);
      const before = this.baseText(sha, path);
      if (cur === before) continue;
      const d = fileDiff(before, cur, this.store.file(path)?.runs ?? [{ l: cur.length, o: "unknown" }]);
      const status = !before && cur ? "added" : before && !cur ? "deleted" : "modified";
      out.push({ path, status, addLines: d.addLines, delLines: d.delLines, added: d.added });
    }
    return out;
  }

  diff(sha: string | null, path: string): FileDiff & { tracked: boolean } {
    const cur = this.current(path);
    const row = this.store.file(path);
    return { tracked: !!row, ...fileDiff(this.baseText(sha, path), cur, row?.runs ?? [{ l: cur.length, o: "unknown" }]) };
  }

  actors(): Record<string, Actor> {
    return Object.fromEntries(
      (this.store.db.prepare("SELECT id, kind, harness, model, effort FROM envelopes").all() as any[]).map((r) => [
        String(r.id),
        { label: this.store.envLabel(Number(r.id)), kind: r.kind, harness: r.harness ?? undefined, model: r.model ?? undefined, effort: r.effort ?? undefined },
      ])
    );
  }

  events(limit = 200): EditEvent[] {
    return (this.store.db.prepare("SELECT id, ts, path, env_id, ins, del FROM events ORDER BY id DESC LIMIT ?").all(Math.min(limit, 1000)) as any[]).map(
      (r) => ({ id: Number(r.id), ts: Number(r.ts), path: r.path, env_id: Number(r.env_id), ins: Number(r.ins), del: Number(r.del) })
    );
  }

  event(id: number): (EditEvent & { ops: Ops }) | undefined {
    const r = this.store.db.prepare("SELECT id, ts, path, env_id, ins, del, patch FROM events WHERE id=?").get(id) as any;
    if (!r) return undefined;
    return { id: Number(r.id), ts: Number(r.ts), path: r.path, env_id: Number(r.env_id), ins: Number(r.ins), del: Number(r.del), ops: JSON.parse(r.patch ?? "[]") };
  }

  lastId(): number {
    return Number((this.store.db.prepare("SELECT max(id) AS m FROM events").get() as any)?.m ?? 0);
  }

  /** Record edits made while nothing was watching (agent edits are already recorded by hooks). Returns files recorded. */
  catchUp(human: number, ttlSec = 120): number {
    const files = (this.git(["ls-files", "-z", "--modified", "--deleted", "--others", "--exclude-standard"]) ?? "")
      .split("\0")
      .filter((f) => f && !f.startsWith(".prov/"));
    let caught = 0;
    for (const f of files) {
      const disk = readText(join(this.root, f));
      if (disk === null) continue;
      if (disk === undefined && !this.store.file(f)) continue;
      if (this.store.applyChange(f, disk ?? "", this.store.activeSession([f], ttlSec) ?? human)) caught++;
    }
    return caught;
  }
}
