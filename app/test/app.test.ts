import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac, generateKeyPairSync, createVerify } from "node:crypto";
import worker, { type Env } from "../src/worker.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PKCS1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString(); // the format GitHub hands out
const SECRET = "whsec-test";

const note = {
  v: 1, commit: "c1", parent: null, added: {},
  actors: [{ id: "h:jude", kind: "human" }, { id: "a:claude/claude-opus-5-5@high", kind: "agent", harness: "claude", model: "claude-opus-5-5", effort: "high" }],
  files: { "src/a.ts": { lines: 4, owners: [[1, 1, 0], [2, 4, 1]], added: {} } },
};

function mockGitHub() {
  const calls: { m: string; u: string; body: any }[] = [];
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const u = req.url!;
      calls.push({ m: req.method!, u, body: b ? JSON.parse(b) : null });
      const send = (code: number, j: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
      if (u === "/app/installations/42/access_tokens") {
        // verify the App JWT really is signed by our key
        const [h, p, s] = String(req.headers.authorization).replace("Bearer ", "").split(".");
        const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"));
        const claims = JSON.parse(Buffer.from(p, "base64url").toString());
        return ok && claims.iss === "123" ? send(201, { token: "inst-token" }) : send(401, { message: "bad jwt" });
      }
      if (u === "/login/oauth/access_token" && req.method === "POST") {
        const b2 = JSON.parse(b);
        return b2.code === "good-code" && b2.client_secret === "cs" ? send(200, { access_token: "user-token", expires_in: 28800 }) : send(200, { error: "bad_verification_code" });
      }
      if (!["Bearer inst-token", "Bearer user-token"].includes(String(req.headers.authorization))) return send(401, { message: "no token" });
      if (u === "/repos/o/r/pulls/7") return send(200, { number: 7, title: "Add a", html_url: "https://github.com/o/r/pull/7", head: { sha: "c2", repo: { full_name: "o/r" } } });
      if (u.startsWith("/repos/o/r/pulls/7/commits")) return send(200, [{ sha: "c1", parents: [{}] }, { sha: "c2", parents: [{}] }]);
      if (u.startsWith("/repos/o/r/pulls/7/files")) return send(200, [
        { filename: "src/a.ts", status: "modified", patch: "@@ -1,1 +1,4 @@\n line1\n+two\n+three\n+four" },
        { filename: "README.md", status: "modified", patch: "@@ -1 +1,2 @@\n x\n+y" },
      ]);
      if (u === "/repos/o/r/git/ref/notes/prov") return send(200, { object: { sha: "notescommit" } });
      if (u === "/repos/o/r/git/commits/notescommit") return send(200, { tree: { sha: "t1" } });
      if (u.startsWith("/repos/o/r/git/trees/t1")) return send(200, { tree: [{ path: "c1", type: "blob", sha: "b1" }] });
      if (u === "/repos/o/r/git/blobs/b1") return send(200, { content: Buffer.from(JSON.stringify(note) + "\n").toString("base64") });
      if (u === "/repos/o/r/commits/c2") return send(200, { files: [{ filename: "README.md" }] });
      if (u.startsWith("/repos/o/r/issues/7/comments") && req.method === "GET") return send(200, []);
      if (u === "/repos/o/r/issues/7/comments") return send(201, { id: 1 });
      if (u === "/repos/o/r/check-runs") return send(201, { id: 9 });
      send(404, { message: "unexpected " + u });
    });
  });
  return { server, calls };
}

const PAGE = "<!doctype html><title>prov page</title>";
const makeEnv = (port: number): Env => ({
  APP_ID: "123", PRIVATE_KEY: PKCS1, WEBHOOK_SECRET: SECRET, GITHUB_API: `http://127.0.0.1:${port}`, GITHUB_WEB: `http://127.0.0.1:${port}`,
  NOTES_WAIT_MS: "0", PUBLIC_URL: "https://prov.example", CLIENT_ID: "Iv1.test", CLIENT_SECRET: "cs", SESSION_KEY: "k".repeat(43),
  ASSETS: { fetch: async () => new Response(PAGE) },
});
const sign = (body: string) => "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

test("webhook → verified → report comment + check run via installation token", async () => {
  const { server, calls } = mockGitHub();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  const env = makeEnv(port);
  const payload = JSON.stringify({
    action: "synchronize", installation: { id: 42 }, repository: { full_name: "o/r" },
    pull_request: { number: 7, head: { sha: "c2", repo: { full_name: "o/r" } } },
  });
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
  const req = (body: string, sig: string, event = "pull_request") =>
    new Request("https://app.example/webhook", { method: "POST", body, headers: { "x-github-event": event, "x-hub-signature-256": sig } });

  assert.equal((await worker.fetch(req(payload, "sha256=" + "0".repeat(64)), env, ctx)).status, 401);
  assert.equal((await worker.fetch(req("{}", sign("{}"), "ping"), env, ctx)).status, 200);
  const res = await worker.fetch(req(payload, sign(payload)), env, ctx);
  assert.equal(res.status, 202);
  await Promise.all(waits);
  server.close();

  const comment = calls.find((c) => c.m === "POST" && c.u === "/repos/o/r/issues/7/comments")!;
  assert.ok(comment, "comment posted");
  assert.match(comment.body.body, /\*\*4 added lines\*\* across 2 files: claude · claude-opus-5-5 \(high\) 75%, not recorded 25%/);
  assert.match(comment.body.body, /`README\.md` \| 1 \| not recorded \(last changed in c2, which has no prov note\)/);
  const check = calls.find((c) => c.u === "/repos/o/r/check-runs")!;
  assert.equal(check.body.head_sha, "c2");
  assert.equal(check.body.output.title, "75% of 4 added lines written by AI agents");
  assert.deepEqual(check.body.output.annotations.map((a: any) => [a.path, a.start_line, a.end_line, a.title]), [
    ["src/a.ts", 2, 4, "Written by claude · claude-opus-5-5 (high)"],
    ["README.md", 2, 2, "Not recorded"],
  ]);
  assert.equal(check.body.details_url, "https://prov.example/pr/o/r/7");
  assert.match(comment.body.body, /\[See who wrote each line →\]\(https:\/\/prov\.example\/pr\/o\/r\/7\)/);
});

test("PR page: sign in with GitHub, then the diff with an author on every line", async () => {
  const { server, calls } = mockGitHub();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const env = makeEnv((server.address() as any).port);
  const ctx = { waitUntil: () => {} };
  const get = (path: string, cookie = "") => worker.fetch(new Request(`https://prov.example${path}`, { headers: cookie ? { cookie } : {} }), env, ctx);
  const cookieOf = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(name + "="))!.split(";")[0];

  // Not signed in: page → login → GitHub authorize, with a state bound to a cookie.
  let res = await get("/pr/o/r/7");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://prov.example/login?next=%2Fpr%2Fo%2Fr%2F7");
  assert.equal((await get("/api/pr/o/r/7")).status, 401);
  res = await get("/login?next=%2Fpr%2Fo%2Fr%2F7");
  const auth = new URL(res.headers.get("location")!);
  assert.equal(auth.pathname, "/login/oauth/authorize");
  assert.equal(auth.searchParams.get("client_id"), "Iv1.test");
  assert.equal(auth.searchParams.get("redirect_uri"), "https://prov.example/auth/callback");
  const oauth = cookieOf(res, "__Host-prov_oauth");
  const state = auth.searchParams.get("state")!;

  // Wrong state or no cookie → refused. Open redirects are dropped.
  assert.equal((await get(`/auth/callback?code=good-code&state=nope`, oauth)).status, 400);
  assert.equal((await get(`/auth/callback?code=good-code&state=${state}`)).status, 400);
  const evil = await get("/login?next=https%3A%2F%2Fevil.example");
  assert.equal(await (async () => {
    const o = cookieOf(evil, "__Host-prov_oauth");
    const st = new URL(evil.headers.get("location")!).searchParams.get("state");
    return (await get(`/auth/callback?code=good-code&state=${st}`, o)).headers.get("location");
  })(), "/");

  res = await get(`/auth/callback?code=good-code&state=${state}`, oauth);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/pr/o/r/7");
  const sessionCookie = cookieOf(res, "__Host-prov_session");
  assert.match(res.headers.getSetCookie().join("\n"), /__Host-prov_session=[^;]+; Path=\/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax/);
  assert.ok(!sessionCookie.includes("user-token"), "token is encrypted in the cookie");

  // Signed in: page served with a strict CSP; data read with the viewer's token.
  res = await get("/pr/o/r/7", sessionCookie);
  assert.equal(await res.text(), PAGE);
  assert.match(res.headers.get("content-security-policy")!, /default-src 'none'.*frame-ancestors 'none'/);
  const before = calls.length;
  const j: any = await (await get("/api/pr/o/r/7", sessionCookie)).json();
  assert.ok(calls.slice(before).every((c) => !c.u.includes("access_tokens")), "no installation token for viewer reads");
  assert.equal(j.title, "Add a");
  assert.equal(j.notedCommits, 1);
  const a = j.files.find((f: any) => f.path === "src/a.ts");
  assert.deepEqual(a.rows.map((r: any) => [r.k, r.n, r.s[0][1]]), [
    ["ctx", 1, "h:jude"], ["add", 2, "a:claude/claude-opus-5-5@high"], ["add", 3, "a:claude/claude-opus-5-5@high"], ["add", 4, "a:claude/claude-opus-5-5@high"],
  ]);
  assert.equal(a.rows[0].h, "@@ -1,1 +1,4 @@");
  assert.deepEqual(a.added, { "a:claude/claude-opus-5-5@high": 3 });
  assert.equal(j.actors["a:claude/claude-opus-5-5@high"].long, "claude · claude-opus-5-5 (high)");
  const readme = j.files.find((f: any) => f.path === "README.md");
  assert.equal(readme.recorded, false);
  assert.deepEqual(readme.added, { "?": 1 });

  // Tampered cookie = signed out.
  assert.equal((await get("/api/pr/o/r/7", sessionCookie.slice(0, -4) + "AAAA")).status, 401);
  server.close();
});
