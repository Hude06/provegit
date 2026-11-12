import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { applyRuns, charDiff, ownerStats, Run } from "./apply.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS envelopes(
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, harness TEXT, model TEXT, effort TEXT, actor TEXT NOT NULL UNIQUE, meta TEXT
);
CREATE TABLE IF NOT EXISTS files(
  path TEXT PRIMARY KEY, hash TEXT, content TEXT, runs TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY, ts REAL NOT NULL, path TEXT, env_id INTEGER, ins INTEGER, del INTEGER, patch TEXT
);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions(
  session_id TEXT PRIMARY KEY, env_id INTEGER NOT NULL, paths TEXT, last_ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS events_path ON events(path);
`;

export const DB_DIR = ".prov";
export const DB_FILE = "prov.db";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Nearest ancestor of `start` (inclusive) holding `.prov/prov.db`, i.e. an initialised prov root. */
export function findProvRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, DB_DIR, DB_FILE))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

const str = (v: unknown): string | null =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : null;

export class Store {
  db: DatabaseSync;
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    const dir = join(this.root, DB_DIR);
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, DB_FILE));
    // Hooks (one process per tool call) and `prov watch` write concurrently.
    this.db.exec("PRAGMA busy_timeout=5000;");
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(SCHEMA);
    const cols = this.db.prepare("PRAGMA table_info(events)").all() as any[];
    if (!cols.some((c) => c.name === "patch")) this.db.exec("ALTER TABLE events ADD COLUMN patch TEXT");
  }

  close(): void {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  envelope(kind: "human" | "agent", actor: string, harness?: string, model?: string, effort?: string): number {
    const found = this.db.prepare("SELECT id FROM envelopes WHERE actor=?").get(actor) as any;
    if (found) return Number(found.id);
    const r = this.db
      .prepare("INSERT INTO envelopes(kind,actor,harness,model,effort) VALUES(?,?,?,?,?) ON CONFLICT(actor) DO NOTHING")
      .run(kind, actor, str(harness), str(model), str(effort));
    if (r.changes) return Number(r.lastInsertRowid);
    return Number((this.db.prepare("SELECT id FROM envelopes WHERE actor=?").get(actor) as any).id);
  }

  human(login: string): number {
    return this.envelope("human", `h:${login}`);
  }

  agent(harness: string, model?: string, effort?: string): number {
    const actor = `a:${harness}${model ? "/" + model : ""}${effort ? "@" + effort : ""}`;
    return this.envelope("agent", actor, harness, model, effort);
  }

  file(path: string): { hash: string; content: string; runs: Run[] } | undefined {
    const r = this.db.prepare("SELECT hash, content, runs FROM files WHERE path=?").get(path) as any;
    if (!r) return undefined;
    return { hash: r.hash, content: r.content ?? "", runs: JSON.parse(r.runs) };
  }

  private write(path: string, prevContent: string, content: string, runs: Run[], envId: number): void {
    const ops = charDiff(prevContent, content);
    let ins = 0;
    let del = 0;
    for (const [op, text] of ops) {
      if (op === 1) ins += text.length;
      else if (op === -1) del += text.length;
    }
    this.db
      .prepare("INSERT INTO files(path,hash,content,runs) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, content=excluded.content, runs=excluded.runs")
      .run(path, sha256(content), content, JSON.stringify(runs));
    this.db
      .prepare("INSERT INTO events(ts,path,env_id,ins,del,patch) VALUES(?,?,?,?,?,?)")
      .run(Date.now() / 1000, path, envId, ins, del, JSON.stringify(ops));
  }

  /** Reset a file so every char is owned by `envId` (init baseline / `prov claim`). Patch is a real diff so chains replay. */
  baseline(path: string, content: string, envId: number): void {
    this.tx(() => {
      const prev = this.file(path);
      this.write(path, prev?.content ?? "", content, content.length ? [{ l: content.length, o: String(envId) }] : [], envId);
    });
  }

  /** Set a file's content with known ownership (e.g. restored from git, owners taken from that commit's note). */
  setFile(path: string, content: string, runs: Run[], envId: number): void {
    this.tx(() => this.write(path, this.file(path)?.content ?? "", content, runs, envId));
  }

  /** When prov last recorded each file (seconds), for spotting files changed since. */
  lastRecorded(): Map<string, number> {
    const rows = this.db.prepare("SELECT path, MAX(ts) AS ts FROM events GROUP BY path").all() as any[];
    return new Map(rows.map((r) => [r.path, Number(r.ts)]));
  }

  metaDelete(key: string): void {
    this.db.prepare("DELETE FROM meta WHERE key=?").run(key);
  }

  claim(path: string, content: string, envId: number): void {
    this.baseline(path, content, envId);
  }

  /** Record new content; inserted chars go to `envId`. Returns false when nothing changed. */
  applyChange(path: string, newContent: string, envId: number): boolean {
    return this.tx(() => {
      const prev = this.file(path);
      if (prev && prev.content === newContent) return false;
      if (!prev && !newContent) return false;
      const ops = charDiff(prev?.content ?? "", newContent);
      const runs = applyRuns(prev?.runs ?? [], ops, String(envId));
      this.write(path, prev?.content ?? "", newContent, runs, envId);
      return true;
    });
  }

  stats(): Map<string, { chars: number; files: number }> {
    const out = new Map<string, { chars: number; files: number }>();
    const rows = this.db.prepare("SELECT runs FROM files").all() as any[];
    for (const row of rows) {
      for (const [o, c] of ownerStats(JSON.parse(row.runs) as Run[])) {
        const e = out.get(o) ?? { chars: 0, files: 0 };
        e.chars += c;
        e.files += 1;
        out.set(o, e);
      }
    }
    return out;
  }

  /** Open an agent session window on `paths` (PreToolUse): the watcher credits changes to them to this agent. */
  touchSession(sessionId: string, envId: number, paths: string[]): void {
    this.tx(() => {
      const prev = this.db.prepare("SELECT paths FROM sessions WHERE session_id=?").get(sessionId) as any;
      const merged = [...new Set([...(prev ? (JSON.parse(prev.paths ?? "[]") as string[]) : []), ...paths])];
      this.upsertSession(sessionId, envId, merged);
    });
  }

  /**
   * Close the window on `paths` once PostToolUse has recorded them, so a human editing the same file
   * right after the agent is credited to the human. The session row goes when no paths remain open.
   */
  closeSession(sessionId: string, paths: string[]): void {
    this.tx(() => {
      const prev = this.db.prepare("SELECT env_id, paths FROM sessions WHERE session_id=?").get(sessionId) as any;
      if (!prev) return;
      const left = (JSON.parse(prev.paths ?? "[]") as string[]).filter((p) => !paths.includes(p));
      if (left.length) this.upsertSession(sessionId, Number(prev.env_id), left);
      else this.db.prepare("DELETE FROM sessions WHERE session_id=?").run(sessionId);
    });
  }

  private upsertSession(sessionId: string, envId: number, paths: string[]): void {
    this.db
      .prepare(
        "INSERT INTO sessions(session_id,env_id,paths,last_ts) VALUES(?,?,?,?) " +
          "ON CONFLICT(session_id) DO UPDATE SET env_id=excluded.env_id, paths=excluded.paths, last_ts=excluded.last_ts"
      )
      .run(sessionId, envId, JSON.stringify(paths), Date.now() / 1000);
  }

  /** Agent envelope whose session recently touched one of `paths` (exact match beats path-less sessions). */
  activeSession(paths: string[], ttlSec: number): number | undefined {
    const now = Date.now() / 1000;
    const rows = this.db.prepare("SELECT env_id, paths, last_ts FROM sessions WHERE last_ts >= ?").all(now - ttlSec) as any[];
    let best: { env: number; exact: boolean; ts: number } | undefined;
    for (const r of rows) {
      const sp: string[] = JSON.parse(r.paths ?? "[]");
      const exact = paths.some((p) => sp.includes(p));
      if (!exact && sp.length) continue;
      const cand = { env: Number(r.env_id), exact, ts: Number(r.last_ts) };
      if (!best || (cand.exact === best.exact ? cand.ts > best.ts : cand.exact)) best = cand;
    }
    return best?.env;
  }

  lastEvent(path: string): { id: number; ts: number; env_id: number } | undefined {
    return this.db.prepare("SELECT id, ts, env_id FROM events WHERE path=? ORDER BY id DESC LIMIT 1").get(path) as any;
  }

  envLabel(envId: number): string {
    const r = this.db.prepare("SELECT kind, actor FROM envelopes WHERE id=?").get(envId) as any;
    if (!r) return "unknown";
    return r.kind === "human" ? r.actor : r.actor.replace(/^a:/, "agent:");
  }

  metaGet(key: string): string | undefined {
    const r = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as any;
    return r?.value;
  }

  metaSet(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  unsyncedEvents(afterId: number): any[] {
    return this.db
      .prepare(
        "SELECT e.id, e.ts, e.path, e.env_id, en.kind, en.actor, en.model, en.effort, e.patch " +
          "FROM events e JOIN envelopes en ON en.id = e.env_id WHERE e.id > ? ORDER BY e.id"
      )
      .all(afterId) as any[];
  }

  fileContents(): { path: string; content: string }[] {
    return this.db.prepare("SELECT path, content FROM files").all() as any[];
  }
}

export const MAX_FILE = 1024 * 1024;

/** Text content of a file: undefined when missing, null when too big or binary (not tracked). */
export function readText(abs: string): string | undefined | null {
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch (e: any) {
    return e?.code === "ENOENT" || e?.code === "ENOTDIR" ? undefined : null;
  }
  if (buf.length > MAX_FILE || buf.includes(0)) return null;
  const s = buf.toString("utf8");
  return s.includes("�") ? null : s;
}
