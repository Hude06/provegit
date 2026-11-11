import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";
import { diff_match_patch } from "diff-match-patch";
import { charDiff, Run } from "./apply.js";
import { readText, Store } from "./store.js";

/**
 * One diff line. `s` = [text, ownerEnvId, isNew] segments for lines in the current file;
 * isNew = 1 for chars not present in the base (char-level diff), so a modified line paints only what changed.
 */
export type Row = { k: "ctx" | "add" | "del"; o?: number; n?: number; s?: [string, string, number][]; d?: [string, number][] };
export type FileDiff = { rows: Row[]; added: Record<string, number>; addLines: number; delLines: number };

/** Split keeping each line's "\n" (last line may lack one). */
function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Ownership slicer over runs, for monotonically increasing offsets. */
function slicer(runs: Run[]) {
  let ri = 0;
  let rstart = 0;
  return (start: number, len: number): [string, number][] => {
    while (ri < runs.length && rstart + runs[ri].l <= start) rstart += runs[ri++].l;
    const out: [string, number][] = [];
    let pos = start;
    let i = ri;
    let s = rstart;
    while (pos < start + len) {
      if (i >= runs.length) {
        out.push(["unknown", start + len - pos]);
        break;
      }
      const end = s + runs[i].l;
      const m = Math.min(end, start + len) - pos;
      if (m > 0) {
        const last = out[out.length - 1];
        if (last && last[0] === runs[i].o) last[1] += m;
        else out.push([runs[i].o, m]);
        pos += m;
      }
      if (pos >= end) {
        s = end;
        i++;
      }
    }
    return out;
  };
}

/** Monotonic splitter over `ranges`: [len, inRange] pieces. */
function freshness(ranges: [number, number][]) {
  let ri = 0;
  /** Split [start, start+len) into [len, isNew] pieces. */
  return (start: number, len: number): [number, number][] => {
    const out: [number, number][] = [];
    let pos = start;
    const end = start + len;
    while (ri < ranges.length && ranges[ri][1] <= pos) ri++;
    let i = ri;
    while (pos < end) {
      const r = ranges[i];
      if (!r || r[0] >= end) {
        out.push([end - pos, 0]);
        break;
      }
      if (pos < r[0]) {
        out.push([r[0] - pos, 0]);
        pos = r[0];
      }
      const m = Math.min(r[1], end) - pos;
      out.push([m, 1]);
      pos += m;
      if (pos >= r[1]) i++;
    }
    return out;
  };
}

/** Line diff base → cur, each current line split into owner segments (runs describe `cur`) flagged new/unchanged. */
export function fileDiff(base: string, cur: string, runs: Run[]): FileDiff {
  const dmp = new diff_match_patch();
  const a = dmp.diff_linesToChars_(base, cur);
  const ops = dmp.diff_main(a.chars1, a.chars2, false);
  dmp.diff_charsToLines_(ops, a.lineArray);
  const own = slicer(runs);
  const ins: [number, number][] = [];
  const rem: [number, number][] = [];
  let bo = 0;
  let co = 0;
  for (const [op, text] of charDiff(base, cur)) {
    if (op === 1) ins.push([co, co + text.length]);
    if (op === -1) rem.push([bo, bo + text.length]);
    if (op !== 1) bo += text.length;
    if (op !== -1) co += text.length;
  }
  const fresh = freshness(ins);
  const gone = freshness(rem);
  let boff = 0; // offset in base
  const rows: Row[] = [];
  const added: Record<string, number> = {};
  let o = 1;
  let n = 1;
  let off = 0;
  let addLines = 0;
  let delLines = 0;
  for (const [op, text] of ops) {
    for (const line of lines(text)) {
      const body = line.endsWith("\n") ? line.slice(0, -1) : line;
      if (op !== 1) boff += line.length;
      if (op === -1) {
        let p = boff - line.length;
        const d: [string, number][] = [];
        for (const [len, removed] of gone(p, body.length)) {
          d.push([body.slice(p - (boff - line.length), p - (boff - line.length) + len), removed]);
          p += len;
        }
        rows.push({ k: "del", o: o++, d });
        delLines++;
        continue;
      }
      const s: [string, string, number][] = [];
      if (!body.length) {
        const [[owner]] = own(off, 1).length ? own(off, 1) : [["unknown", 1] as [string, number]];
        s.push(["", owner, op === 1 ? 1 : 0]);
      } else {
        let p = off;
        for (const [owner, len] of own(off, body.length)) {
          for (const [flen, isNew] of op === 1 ? fresh(p, len) : [[len, 0] as [number, number]]) {
            s.push([body.slice(p - off, p - off + flen), owner, isNew]);
            if (isNew) added[owner] = (added[owner] ?? 0) + flen;
            p += flen;
          }
        }
      }
      off += line.length;
      if (op === 1) {
        rows.push({ k: "add", n: n++, s });
        addLines++;
      } else rows.push({ k: "ctx", o: o++, n: n++, s });
    }
  }
  return { rows, added, addLines, delLines };
}

const REF = /^[A-Za-z0-9._\/~^@{}-]{1,200}$/;

export function uiServer(store: Store, port: number, log: (s: string) => void = () => {}): Server {
  const root = store.root;
  const git = (args: string[]): string | undefined => {
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return undefined;
    }
  };
  const resolveBase = (ref: string): string | null | undefined => {
    if (!REF.test(ref) || ref.startsWith("-")) return undefined;
    const sha = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])?.trim();
    if (sha) return sha;
    return ref === "HEAD" ? null : undefined; // null = unborn HEAD (no commits yet): everything is new
  };
  const baseText = (sha: string | null, path: string): string => (sha ? (git(["show", `${sha}:${path}`]) ?? "") : "");
  const current = (path: string): string => store.file(path)?.content ?? readText(join(root, path)) ?? "";

  const changedPaths = (sha: string | null): string[] => {
    const z = (s: string | undefined) => (s ?? "").split("\0").filter(Boolean);
    const set = new Set<string>(z(git(["ls-files", "--others", "--exclude-standard", "-z"])));
    if (sha) for (const p of z(git(["diff", "--name-only", "-z", sha, "--"]))) set.add(p);
    else for (const p of z(git(["ls-files", "-z"]))) set.add(p);
    return [...set].filter((p) => !p.startsWith(".prov/")).sort();
  };

  const actors = () =>
    Object.fromEntries(
      (store.db.prepare("SELECT id, kind, actor, harness, model, effort FROM envelopes").all() as any[]).map((r) => [
        String(r.id),
        { label: store.envLabel(Number(r.id)), kind: r.kind, harness: r.harness, model: r.model, effort: r.effort },
      ])
    );

  const page = () => readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Local-only tool: reject other Host headers (DNS rebinding) and cross-origin use.
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(403);
      return res.end();
    }
    const url = new URL(req.url ?? "/", `http://${host}`);
    const q = url.searchParams;
    try {
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(page());
      }
      if (url.pathname === "/api/changes") {
        const ref = q.get("base") || "HEAD";
        const sha = resolveBase(ref);
        if (sha === undefined) return json(res, 400, { error: `"${ref}" is not a commit in this repo` });
        const files = changedPaths(sha)
          .slice(0, 500)
          .map((path) => {
            const cur = current(path);
            const before = baseText(sha, path);
            if (cur === before) return undefined;
            const d = fileDiff(before, cur, store.file(path)?.runs ?? [{ l: cur.length, o: "unknown" }]);
            const status = !before && cur ? "added" : before && !cur ? "deleted" : "modified";
            return { path, status, addLines: d.addLines, delLines: d.delLines, added: d.added };
          })
          .filter(Boolean);
        return json(res, 200, { root, base: ref, sha, files, actors: actors(), lastEvent: lastId() });
      }
      if (url.pathname === "/api/diff") {
        const path = q.get("path") ?? "";
        const ref = q.get("base") || "HEAD";
        const sha = resolveBase(ref);
        if (sha === undefined) return json(res, 400, { error: `"${ref}" is not a commit in this repo` });
        const cur = current(path);
        const row = store.file(path);
        return json(res, 200, { path, tracked: !!row, ...fileDiff(baseText(sha, path), cur, row?.runs ?? [{ l: cur.length, o: "unknown" }]) });
      }
      if (url.pathname === "/api/events") {
        const limit = Math.min(Number(q.get("limit") ?? 200) || 200, 1000);
        // first = the event that started tracking a file (prov init baseline or a brand-new file).
        const rows = store.db
          .prepare(
            "SELECT e.id, e.ts, e.path, e.env_id, e.ins, e.del, (e.id = (SELECT min(id) FROM events f WHERE f.path = e.path)) AS first " +
              "FROM events e ORDER BY e.id DESC LIMIT ?"
          )
          .all(limit) as any[];
        return json(res, 200, { events: rows, actors: actors() });
      }
      if (url.pathname === "/api/event") {
        const r = store.db.prepare("SELECT id, ts, path, env_id, ins, del, patch FROM events WHERE id=?").get(Number(q.get("id"))) as any;
        if (!r) return json(res, 404, { error: "no such edit" });
        // Rebuild before/after from the stored patch so a single edit renders like any other diff.
        const ops = JSON.parse(r.patch ?? "[]") as [number, string][];
        let before = "";
        let after = "";
        for (const [op, text] of ops) {
          if (op !== 1) before += text;
          if (op !== -1) after += text;
        }
        const d = fileDiff(before, after, after ? [{ l: after.length, o: String(r.env_id) }] : []);
        return json(res, 200, { id: r.id, ts: r.ts, path: r.path, env_id: r.env_id, ins: r.ins, del: r.del, ...d });
      }
      if (url.pathname === "/api/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        let seen = lastId();
        res.write(`data: ${JSON.stringify({ id: seen })}\n\n`);
        const t = setInterval(() => {
          const id = lastId();
          if (id !== seen) {
            seen = id;
            res.write(`data: ${JSON.stringify({ id })}\n\n`);
          } else res.write(": ping\n\n");
        }, 500);
        req.on("close", () => clearInterval(t));
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });
  const lastId = () => Number((store.db.prepare("SELECT max(id) AS m FROM events").get() as any)?.m ?? 0);
  server.listen(port, "127.0.0.1", () => log(`prov ui → http://127.0.0.1:${port}`));
  return server;
}
