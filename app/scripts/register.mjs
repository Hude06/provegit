#!/usr/bin/env node
// Registers the prov GitHub App via GitHub's manifest flow and stores its credentials as Wrangler secrets.
//   node scripts/register.mjs --url https://prov-github-app.<you>.workers.dev [--name prov-yourname] [--org ORG]
// You click "Create GitHub App" once in the browser; GitHub redirects back here with a one-time code,
// which is exchanged for the App id, private key and webhook secret. Nothing is printed.
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createPrivateKey, randomBytes } from "node:crypto";
import { writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const workerUrl = (arg("--url") ?? "").replace(/\/+$/, "");
if (!/^https:\/\//.test(workerUrl)) { console.error("usage: node scripts/register.mjs --url https://<worker>.workers.dev [--name NAME] [--org ORG]"); process.exit(1); }
const name = arg("--name") ?? "prov-who-wrote-this";
const org = arg("--org");
const state = randomBytes(16).toString("hex");
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const server = createServer(async (req, res) => {
  const port = server.address().port;
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const page = (title, body) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(`<!doctype html><meta charset=utf-8><title>${title}</title><body style="font:16px system-ui;margin:48px;max-width:560px">${body}`); };
  if (url.pathname === "/") {
    const manifest = {
      name,
      url: workerUrl,
      description: "Shows which lines in a pull request were written by AI agents and which by people (from prov's git notes).",
      hook_attributes: { url: `${workerUrl}/webhook`, active: true },
      redirect_url: `http://127.0.0.1:${port}/callback`,
      public: false,
      default_permissions: { contents: "read", pull_requests: "write", checks: "write", metadata: "read" },
      default_events: ["pull_request"],
    };
    const action = org ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new` : "https://github.com/settings/apps/new";
    return page("Create the prov GitHub App", `<p>Sending you to GitHub to create <b>${esc(name)}</b>…</p>
      <form id=f method=post action="${action}?state=${state}"><input type=hidden name=manifest value="${esc(JSON.stringify(manifest))}"><button>Continue to GitHub</button></form>
      <script>document.getElementById("f").submit()</script>`);
  }
  if (url.pathname === "/callback") {
    if (url.searchParams.get("state") !== state) return page("Error", "<p>State mismatch — rerun the script.</p>");
    try {
      const r = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(url.searchParams.get("code") ?? "")}/conversions`, {
        method: "POST", headers: { accept: "application/vnd.github+json", "user-agent": "prov-register" },
      });
      const app = await r.json();
      if (!r.ok) throw new Error(`GitHub: HTTP ${r.status} ${app.message ?? ""}`);
      const pkcs8 = createPrivateKey(app.pem).export({ type: "pkcs8", format: "pem" }).toString();
      // Local fallback copy (gitignored, 0600) in case a secret upload fails.
      const file = join(here, ".prov-app.json");
      writeFileSync(file, JSON.stringify({ id: app.id, slug: app.slug, html_url: app.html_url, client_id: app.client_id, webhook_secret: app.webhook_secret, pem: pkcs8 }, null, 2));
      chmodSync(file, 0o600);
      const put = (key, value) => {
        const p = spawnSync("npx", ["wrangler", "secret", "put", key], { cwd: here, input: value, encoding: "utf8" });
        if (p.status !== 0) throw new Error(`wrangler secret put ${key} failed: ${(p.stderr || p.stdout).slice(-300)}`);
      };
      put("APP_ID", String(app.id));
      put("PRIVATE_KEY", pkcs8);
      put("WEBHOOK_SECRET", app.webhook_secret);
      const install = `${app.html_url}/installations/new`;
      page("Done", `<p>Created <b>${esc(app.slug)}</b> and saved its secrets to the Worker.</p><p><a href="${install}">Install it on a repository →</a></p>`);
      console.log(`created GitHub App ${app.slug} (id ${app.id}); secrets stored in the Worker`);
      console.log(`install it: ${install}`);
      setTimeout(() => process.exit(0), 300);
    } catch (e) {
      page("Error", `<p>${esc(String(e.message ?? e))}</p>`);
      console.error(String(e.message ?? e));
      setTimeout(() => process.exit(1), 300);
    }
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(0, "127.0.0.1", () => {
  const u = `http://127.0.0.1:${server.address().port}/`;
  console.log(`opening ${u} — click "Create GitHub App" on GitHub`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(opener, [u], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
});
