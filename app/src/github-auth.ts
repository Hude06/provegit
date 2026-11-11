/** GitHub App auth on Web Crypto (Workers + Node 20+): webhook signatures, app JWT, installation tokens. */

const enc = new TextEncoder();

function hexToBytes(hex: string): Uint8Array | undefined {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Verify X-Hub-Signature-256 with HMAC-SHA256. crypto.subtle.verify compares in constant time. */
export async function verifySignature(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const sig = hexToBytes(header.slice(7));
  if (!sig) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sig, enc.encode(body));
}

const b64url = (bytes: Uint8Array | string) => {
  const bin = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
};

function derLen(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n) {
    out.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | out.length, ...out];
}

/** GitHub hands out PKCS#1 ("BEGIN RSA PRIVATE KEY"); Web Crypto wants PKCS#8. Wrap if needed. */
export function pemToPkcs8(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  if (!pem.includes("BEGIN RSA PRIVATE KEY")) return der;
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]; // rsaEncryption, NULL
  const octet = [0x04, ...derLen(der.length), ...der];
  const inner = [0x02, 0x01, 0x00, ...algo, ...octet]; // version 0
  return new Uint8Array([0x30, ...derLen(inner.length), ...inner]);
}

/** RS256 JWT identifying the App (valid 9 min; iat backdated 60 s for clock drift). */
export async function appJwt(appId: string, privateKeyPem: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(privateKeyPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${claims}`)));
  return `${head}.${claims}.${b64url(sig)}`;
}

export async function installationToken(api: string, appId: string, privateKeyPem: string, installationId: number): Promise<string> {
  const res = await fetch(`${api}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${await appJwt(appId, privateKeyPem)}`, accept: "application/vnd.github+json", "user-agent": "prov-github-app" },
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.token) throw new Error(`installation token: HTTP ${res.status} ${j.message ?? ""}`);
  return j.token;
}
