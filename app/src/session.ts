/**
 * "Sign in with GitHub" for the PR page. The user's GitHub token lives only in an AES-GCM encrypted,
 * HttpOnly cookie; every read uses that token, so GitHub itself decides who may see a repository.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

export const SESSION_COOKIE = "__Host-prov_session";
const OAUTH_COOKIE = "__Host-prov_oauth";

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function aesKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("SESSION_KEY secret is missing or too short");
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`prov-session-v1:${secret}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(secret: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(JSON.stringify(value))));
  return `${b64url(iv)}.${b64url(ct)}`;
}

export async function unseal<T>(secret: string, sealed: string | undefined): Promise<T | undefined> {
  if (!sealed) return undefined;
  try {
    const [iv, ct] = sealed.split(".");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64url(iv) }, await aesKey(secret), unb64url(ct));
    return JSON.parse(dec.decode(pt));
  } catch {
    return undefined; // tampered, wrong key, or malformed
  }
}

export function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
export const clearSession = () => setCookie(SESSION_COOKIE, "", 0);

/** Only same-site PR page paths may be a post-login destination (no open redirect). */
export const safeNext = (next: string | null) => (next && /^\/pr\/[\w.-]+\/[\w.-]+\/\d+$/.test(next) ? next : "/");

export type Session = { t: string; e: number };
export type AuthEnv = { CLIENT_ID: string; CLIENT_SECRET: string; SESSION_KEY: string; GITHUB_WEB?: string };

export async function session(env: AuthEnv, req: Request): Promise<Session | undefined> {
  const s = await unseal<Session>(env.SESSION_KEY, cookies(req)[SESSION_COOKIE]);
  return s && s.e > Date.now() ? s : undefined;
}

/** GET /login?next=/pr/o/r/1 → GitHub's authorize page. */
export async function login(env: AuthEnv, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const next = safeNext(url.searchParams.get("next"));
  const auth = new URL(`${env.GITHUB_WEB ?? "https://github.com"}/login/oauth/authorize`);
  auth.searchParams.set("client_id", env.CLIENT_ID);
  auth.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
  auth.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: { location: auth.toString(), "set-cookie": setCookie(OAUTH_COOKIE, await seal(env.SESSION_KEY, { s: state, n: next }), 600) },
  });
}

/** GET /auth/callback?code&state → exchange the code, store the token in the session cookie, go back to the PR page. */
export async function callback(env: AuthEnv, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pending = await unseal<{ s: string; n: string }>(env.SESSION_KEY, cookies(req)[OAUTH_COOKIE]);
  const code = url.searchParams.get("code");
  if (!pending || !code || url.searchParams.get("state") !== pending.s) {
    return new Response("Sign-in expired or was started elsewhere. Go back to the pull request and open the link again.", { status: 400 });
  }
  const r = await fetch(`${env.GITHUB_WEB ?? "https://github.com"}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "prov-github-app" },
    body: JSON.stringify({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, code, redirect_uri: `${url.origin}/auth/callback` }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) return new Response(`GitHub sign-in failed: ${j.error_description ?? j.error ?? `HTTP ${r.status}`}`, { status: 502 });
  const ttl = Math.min(Number(j.expires_in) || 8 * 3600, 8 * 3600);
  const headers = new Headers({ location: safeNext(pending.n) });
  headers.append("set-cookie", setCookie(SESSION_COOKIE, await seal(env.SESSION_KEY, { t: j.access_token, e: Date.now() + ttl * 1000 }), ttl));
  headers.append("set-cookie", setCookie(OAUTH_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}
