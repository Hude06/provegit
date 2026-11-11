import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".prov");
const FILE = join(DIR, "credentials.json");

export type Creds = { github?: { login: string; token: string; added: string }; clientId?: string };

function ensureDir(): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 });
}

export function readCreds(): Creds {
  if (!existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

export function writeCreds(creds: Creds): void {
  ensureDir();
  writeFileSync(FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  chmodSync(FILE, 0o600);
}

export function githubLogin(): string | undefined {
  const c = readCreds();
  return c.github?.login;
}

export function clientId(): string | undefined {
  const c = readCreds();
  return process.env.PROV_GITHUB_CLIENT_ID ?? c.clientId;
}

export function clearCreds(): void {
  if (existsSync(FILE)) {
    const c = readCreds();
    delete c.github;
    writeCreds(c);
  }
}
