/**
 * prov GitHub App (Cloudflare Worker).
 * - POST /webhook: on pull_request events, reads the PR's commits, their prov notes (refs/notes/prov, via the
 *   git data API) and the changed lines, then posts one updating PR comment + a check run noting who wrote
 *   each block of added lines.
 * - GET /pr/:owner/:repo/:n: a GitHub-style diff with a "who wrote this line" column. Viewers sign in with
 *   GitHub and all reads use their own token, so they only see repositories they can already read.
 */
import { addedLines, buildReport, markdown, parseNote, type PrCommit, type PrFile } from "../../cli/src/report.js";
import { makeGh, postCheckRun, upsertComment, type Gh } from "../../cli/src/ghpost.js";
import type { Note } from "../../cli/src/notes.js";
import { installationToken, verifySignature } from "./github-auth.js";
import { prView, type GhFile } from "./prview.js";
import { callback, clearSession, login, session, type AuthEnv } from "./session.js";

export interface Env extends AuthEnv {
  APP_ID: string;
  PRIVATE_KEY: string;
  WEBHOOK_SECRET: string;
  /** Public origin of this Worker, for links in comments (e.g. https://prov-github-app.example.workers.dev). */
  PUBLIC_URL?: string;
  ASSETS: { fetch(req: Request | string): Promise<Response> };
  /** Override for tests; defaults to https://api.github.com. */
  GITHUB_API?: string;
  /** Override for tests: ms between note re-checks (default 6000, then 10000). */
  NOTES_WAIT_MS?: string;
}
type Ctx = { waitUntil(p: Promise<unknown>): void };

const HANDLED = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
const MAX_BODY = 25 * 1024 * 1024; // GitHub caps webhook payloads at 25 MB
const NOTES_REF = "notes/prov";
const PR_PATH = /^\/pr\/([\w.-]+)\/([\w.-]+)\/(\d+)$/;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const log = (level: "info" | "error", msg: string, fields: Record<string, unknown> = {}) =>
  console[level === "error" ? "error" : "log"](JSON.stringify({ level, msg, ...fields }));

/** Paginate a list endpoint (per_page=100) up to `max` items. */
async function list(gh: Gh, path: string, max: number): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; out.length < max; page++) {
    const batch = await gh("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out.slice(0, max);
}

function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Notes for `shas` from a repo's refs/notes/prov (handles git's fan-out paths like "ab/cdef…"). */
async function readNotes(gh: Gh, repo: string, shas: Set<string>): Promise<Map<string, Note>> {
  const notes = new Map<string, Note>();
  let ref: any;
  try {
    ref = await gh("GET", `/repos/${repo}/git/ref/${NOTES_REF}`);
  } catch (e: any) {
    if (e.status === 404 || e.status === 409) return notes; // no notes pushed yet / empty repo
    throw e;
  }
  const commit = await gh("GET", `/repos/${repo}/git/commits/${ref.object.sha}`);
  const tree = await gh("GET", `/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
  const wanted = (tree.tree as any[]).filter((t) => t.type === "blob" && shas.has(t.path.replace(/\//g, "")));
  await Promise.all(
    wanted.map(async (t) => {
      const blob = await gh("GET", `/repos/${repo}/git/blobs/${t.sha}`);
      const note = parseNote(decodeBase64Utf8(blob.content));
      if (note) notes.set(t.path.replace(/\//g, ""), note);
    })
  );
  return notes;
}

/** Everything both the report and the PR page need: commits with notes, and changed files with patches. */
async function gather(gh: Gh, repo: string, pr: any, opts: { attempts: number; waitMs?: number }) {
  const commits = (await list(gh, `/repos/${repo}/pulls/${pr.number}/commits`, 250)).filter((c) => (c.parents?.length ?? 1) <= 1);
  const shas = new Set<string>(commits.map((c) => c.sha));
  // Notes live where the author pushed: the PR's head repo (a fork) first, then the base repo.
  const notes = new Map<string, Note>();
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, opts.waitMs ?? (attempt === 1 ? 6000 : 10000)));
    for (const r of [...new Set([pr.head?.repo?.full_name, repo].filter(Boolean))]) {
      try {
        for (const [k, v] of await readNotes(gh, r, shas)) if (!notes.has(k)) notes.set(k, v);
      } catch (e) {
        log("info", "notes unreadable", { repo: r, error: String(e) });
      }
    }
    if ([...shas].every((s) => notes.has(s))) break;
  }
  const prCommits: PrCommit[] = commits.map((c) => ({ sha: c.sha, note: notes.get(c.sha) }));

  // Which files did note-less commits touch? (Few: usually none.) Lets the report spot stale ownership.
  const touched = new Map<string, Set<string>>();
  for (const c of prCommits.filter((c) => !c.note).slice(-30)) {
    const detail = await gh("GET", `/repos/${repo}/commits/${c.sha}`);
    touched.set(c.sha, new Set((detail.files ?? []).map((f: any) => f.filename)));
  }
  const ghFiles: (GhFile & { lastCommit?: string })[] = (await list(gh, `/repos/${repo}/pulls/${pr.number}/files`, 3000)).map((f: GhFile) => {
    let lastCommit: string | undefined;
    for (let i = prCommits.length - 1; i >= 0 && !lastCommit; i--) {
      const c = prCommits[i];
      if (c.note?.files[f.filename] || touched.get(c.sha)?.has(f.filename)) lastCommit = c.sha;
    }
    return { ...f, lastCommit };
  });
  return { prCommits, ghFiles };
}

const viewUrl = (env: Env, repo: string, n: number) => (env.PUBLIC_URL ? `${env.PUBLIC_URL.replace(/\/+$/, "")}/pr/${repo}/${n}` : undefined);

export async function handlePullRequest(env: Env, p: any): Promise<string[]> {
  const api = env.GITHUB_API ?? "https://api.github.com";
  const repo: string = p.repository.full_name;
  const pr = p.pull_request;
  const token = await installationToken(api, env.APP_ID, env.PRIVATE_KEY, p.installation.id);
  const gh = makeGh(api, token, "prov-github-app");
  // pre-push sends notes just after the branch push, so they can trail this webhook: re-check twice (~16 s).
  const { prCommits, ghFiles } = await gather(gh, repo, pr, { attempts: 3, waitMs: env.NOTES_WAIT_MS !== undefined ? Number(env.NOTES_WAIT_MS) : undefined });
  const files: PrFile[] = ghFiles
    .filter((f) => f.status !== "removed" && f.patch) // binary / too-large patches have no `patch`
    .map((f) => ({ path: f.filename, added: addedLines(f.patch!), lastCommit: f.lastCommit }))
    .filter((f) => f.added.length);

  const report = buildReport(prCommits, files);
  const view = viewUrl(env, repo, pr.number);
  const body = markdown(report, { headSha: pr.head.sha, viewUrl: view });
  const appId = Number(env.APP_ID);
  const done: string[] = [];
  done.push(await upsertComment(gh, repo, pr.number, body, (c) => c.performed_via_github_app?.id === appId));
  done.push(await postCheckRun(gh, repo, pr.head.sha, report, view));
  log("info", "report posted", { repo, pr: pr.number, added: report.added, notedCommits: report.notedCommits, commits: report.commits });
  return done;
}

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, no-store",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** GET /api/pr/:owner/:repo/:n — the PR page's data, read with the signed-in viewer's own GitHub token. */
async function prApi(env: Env, req: Request, owner: string, name: string, n: number): Promise<Response> {
  const noStore = { "cache-control": "private, no-store" };
  const s = await session(env, req);
  if (!s) return json(401, { error: "Sign in with GitHub to see this pull request." }, noStore);
  const api = env.GITHUB_API ?? "https://api.github.com";
  const gh = makeGh(api, s.t, "prov-github-app");
  const repo = `${owner}/${name}`;
  try {
    const pr = await gh("GET", `/repos/${repo}/pulls/${n}`);
    const { prCommits, ghFiles } = await gather(gh, repo, pr, { attempts: 1 });
    const view = prView(prCommits, ghFiles);
    return json(200, {
      repo,
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      head: pr.head?.sha,
      commits: prCommits.length,
      notedCommits: prCommits.filter((c) => c.note).length,
      ...view,
    }, noStore);
  } catch (e: any) {
    if (e.status === 401) return json(401, { error: "Your GitHub sign-in expired. Sign in again." }, { ...noStore, "set-cookie": clearSession() });
    if (e.status === 404 || e.status === 403)
      return json(404, { error: "Pull request not found. Either it doesn't exist, you can't read this repository, or the prov app isn't installed on it." }, noStore);
    log("error", "pr view failed", { repo, pr: n, error: String(e?.stack ?? e) });
    return json(502, { error: "Couldn't load this pull request from GitHub. Try again in a minute." }, noStore);
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET") {
      if (path === "/") return new Response("prov GitHub App is running.\n", { headers: { "content-type": "text/plain" } });
      if (path === "/login") return login(env, req);
      if (path === "/auth/callback") return callback(env, req);
      const page = PR_PATH.exec(path);
      if (page) {
        if (!(await session(env, req))) return Response.redirect(`${url.origin}/login?next=${encodeURIComponent(path)}`, 302);
        const html = await env.ASSETS.fetch(new Request(`${url.origin}/pr.html`));
        return new Response(html.body, { status: html.status, headers: PAGE_HEADERS });
      }
      const data = /^\/api(\/pr\/.+)$/.exec(path)?.[1];
      const m = data ? PR_PATH.exec(data) : null;
      if (m) return prApi(env, req, m[1], m[2], Number(m[3]));
    }

    if (path !== "/webhook") return json(404, { error: "not found" });
    if (req.method !== "POST") return json(405, { error: "POST only" });
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return json(413, { error: "payload too large" });

    const body = await req.text();
    if (!(await verifySignature(env.WEBHOOK_SECRET, body, req.headers.get("x-hub-signature-256")))) return json(401, { error: "bad signature" });
    const event = req.headers.get("x-github-event");
    if (event === "ping") return json(200, { ok: true });
    if (event !== "pull_request") return json(202, { ignored: event });
    const p = JSON.parse(body);
    if (!HANDLED.has(p.action) || !p.installation?.id) return json(202, { ignored: `pull_request.${p.action}` });

    // Answer GitHub fast (10 s webhook timeout); do the work in the background.
    ctx.waitUntil(
      handlePullRequest(env, p).catch((e) => log("error", "report failed", { repo: p.repository?.full_name, pr: p.pull_request?.number, error: String(e?.stack ?? e) }))
    );
    return json(202, { accepted: true });
  },
};
