import { execFileSync } from "node:child_process";
import { githubLogin } from "./creds.js";
import { sha256, Store } from "./store.js";

function safeUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
}

const git = (root: string, args: string[]): string => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

/** Stable repo id that doesn't leak the local filesystem path: origin URL (credentials stripped) or a path hash. */
export function repoId(root: string): string {
  const origin = git(root, ["remote", "get-url", "origin"]);
  if (origin) {
    try {
      const u = new URL(origin);
      u.username = "";
      u.password = "";
      return u.toString();
    } catch {
      return origin; // scp-style git@host:org/repo
    }
  }
  return "local:" + sha256(root).slice(0, 16);
}

export async function sync(store: Store, server: string, token?: string): Promise<string> {
  if (!safeUrl(server)) throw new Error(`refusing non-HTTPS server: ${server}`);
  const root = store.root;
  const head = git(root, ["rev-parse", "HEAD"]);
  const files = store.fileContents().map((f) => ({ path: f.path, sha: sha256(f.content ?? "") }));
  const post = async (since: number) => {
    const rows = store.unsyncedEvents(since);
    if (!rows.length) return { rows, status: 0, text: "" };
    const body = {
      repo: repoId(root),
      head,
      since,
      identity: githubLogin() ?? null,
      synced: new Date().toISOString(),
      files,
      events: rows.map((r) => ({ id: r.id, ts: r.ts, path: r.path, actor: r.actor, kind: r.kind, model: r.model, effort: r.effort, ops: JSON.parse(r.patch ?? "[]") })),
    };
    const res = await fetch(server.replace(/\/+$/, "") + "/sync", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { rows, status: res.status, text: await res.text() };
  };
  const cursor = Number(store.metaGet("last_sync") ?? 0);
  let r = await post(cursor);
  if (!r.rows.length) return "nothing to sync";
  if (r.status === 409 && cursor > 0) r = await post(0); // server lost/never had our base state
  if (r.status !== 200) throw new Error(`sync rejected: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  const j = JSON.parse(r.text);
  if (!j.ok || !j.verified) throw new Error(`server rejected patch chain: ${j.error ?? "verification failed"}`);
  store.metaSet("last_sync", String(r.rows[r.rows.length - 1].id));
  return `synced ${r.rows.length} events, ${files.length} files verified → ${server}`;
}
