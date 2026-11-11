import { createServer, Server } from "node:http";
import { Ops, replay } from "./apply.js";
import { sha256 } from "./store.js";

export type SyncEvent = { id: number; path: string; ops: Ops };
export type SyncBody = { repo: string; head?: string; since?: number; files?: { path: string; sha: string }[]; events?: SyncEvent[] };

/**
 * Replay `events` on top of `base` and require every reported file hash to match.
 * Each event must consume its file's prior content exactly (no silently dropped text).
 * Returns the new state, or an error string.
 */
export function verifyChain(base: Map<string, string>, events: SyncEvent[], files: { path: string; sha: string }[]): Map<string, string> | string {
  const content = new Map(base);
  for (const e of events) {
    if (typeof e?.path !== "string" || !Array.isArray(e.ops)) return `event ${e?.id}: malformed`;
    const next = replay(content.get(e.path) ?? "", e.ops);
    if (next === undefined) return `event ${e.id} (${e.path}): patch does not apply`;
    content.set(e.path, next);
  }
  for (const f of files) {
    if (sha256(content.get(f.path) ?? "") !== f.sha) return `${f.path}: hash mismatch after replay`;
  }
  return content;
}

const MAX_BODY = 64 * 1024 * 1024;

/** Demo ingest server: keeps per-repo replayed state in memory, so incremental syncs verify against prior batches. */
export function serve(port: number, log: (s: string) => void = () => {}): Server {
  const repos = new Map<string, { content: Map<string, string>; lastId: number; batches: number }>();
  const reply = (res: any, code: number, body: object) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/sync") {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reply(res, 413, { ok: false, error: "body too large" });
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        let j: SyncBody;
        try {
          j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return reply(res, 400, { ok: false, error: "bad json" });
        }
        if (!j || typeof j.repo !== "string") return reply(res, 400, { ok: false, error: "repo required" });
        const events = Array.isArray(j.events) ? j.events : [];
        const since = Number(j.since ?? 0);
        const known = repos.get(j.repo);
        // Incremental batch for a repo we have no (or different) state for → ask the client for the full chain.
        if (since > 0 && known?.lastId !== since) return reply(res, 409, { ok: false, error: "need full resync", need_full: true });
        const result = verifyChain(since > 0 && known ? known.content : new Map(), events, Array.isArray(j.files) ? j.files : []);
        const ok = typeof result !== "string";
        if (ok) {
          const lastId = events.length ? Number(events[events.length - 1].id) : since;
          repos.set(j.repo, { content: result, lastId, batches: (known && since > 0 ? known.batches : 0) + 1 });
        }
        log(`sync ${j.repo} head=${(j.head ?? "").slice(0, 8)} since=${since} events=${events.length} verified=${ok}${ok ? "" : ` (${result})`}`);
        reply(res, ok ? 200 : 422, ok ? { ok, verified: true } : { ok, verified: false, error: result });
      });
      return;
    }
    if (req.method === "GET" && req.url === "/status") {
      return reply(res, 200, { repos: Object.fromEntries([...repos].map(([k, v]) => [k, { batches: v.batches, lastId: v.lastId, files: v.content.size }])) });
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, () => log(`prov serve listening on http://localhost:${port}`));
  return server;
}
