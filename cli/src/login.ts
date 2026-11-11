import { spawn } from "node:child_process";
import { clearCreds, clientId, readCreds, writeCreds } from "./creds.js";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

async function postForm(url: string, form: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`GitHub ${url}: HTTP ${res.status} ${text.slice(0, 120)}`);
  }
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    // spawn reports a missing binary via an async 'error' event, not a throw.
    const p = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
  } catch {}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GitHub OAuth device flow: show code, open browser, poll until the user approves. */
export async function login(clientIdArg?: string, log = (s: string) => console.log(s)): Promise<string> {
  const id = clientIdArg ?? clientId();
  if (!id) throw new Error("no client_id: set PROV_GITHUB_CLIENT_ID, save clientId in ~/.prov/credentials.json, or pass --client-id");
  const d = await postForm("https://github.com/login/device/code", { client_id: id, scope: "read:user" });
  if (!d.device_code) throw new Error(`GitHub device/code: ${d.error_description ?? d.error ?? "no device_code"} (client_id ${id.slice(0, 4)}…)`);
  log(`sign in at ${d.verification_uri}  code: ${d.user_code}`);
  openBrowser(d.verification_uri);
  let interval = Number(d.interval ?? 5) * 1000;
  const deadline = Date.now() + Number(d.expires_in ?? 900) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const t = await postForm("https://github.com/login/oauth/access_token", { client_id: id, device_code: d.device_code, grant_type: DEVICE_GRANT });
    if (t.error === "authorization_pending") continue;
    if (t.error === "slow_down") {
      // Spec: permanently add 5s (GitHub also returns the new interval).
      interval = Number(t.interval ?? interval / 1000 + 5) * 1000;
      continue;
    }
    if (t.error) throw new Error(`GitHub: ${t.error_description ?? t.error}`);
    if (t.access_token) return finish(id, t.access_token);
  }
  throw new Error("device code expired — rerun prov login");
}

async function finish(id: string, token: string): Promise<string> {
  const res = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } });
  if (res.status !== 200) throw new Error(`GitHub rejected the token (HTTP ${res.status})`);
  const login = ((await res.json()) as { login: string }).login;
  const creds = readCreds();
  creds.clientId = id;
  creds.github = { login, token, added: new Date().toISOString() };
  writeCreds(creds);
  return login;
}

/**
 * Clears the local token. Server-side revocation (DELETE /applications/{client_id}/token) needs the
 * OAuth app's client secret, which a CLI must not hold — so the user revokes on GitHub if wanted.
 */
export function logout(): string {
  const creds = readCreds();
  if (!creds.github) return "not logged in";
  clearCreds();
  return `local token cleared for ${creds.github.login} — to revoke it on GitHub too: https://github.com/settings/applications`;
}
