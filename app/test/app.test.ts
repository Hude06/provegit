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
      if (req.headers.authorization !== "Bearer inst-token") return send(401, { message: "no token" });
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

const sign = (body: string) => "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

test("webhook → verified → report comment + check run via installation token", async () => {
  const { server, calls } = mockGitHub();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  const env: Env = { APP_ID: "123", PRIVATE_KEY: PKCS1, WEBHOOK_SECRET: SECRET, GITHUB_API: `http://127.0.0.1:${port}`, NOTES_WAIT_MS: "0" };
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
  assert.deepEqual(check.body.output.annotations.map((a: any) => [a.path, a.start_line, a.end_line]), [["src/a.ts", 2, 4]]);
});
