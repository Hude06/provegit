#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { findProvRoot, readText, Store } from "./store.js";
import { lineOwners, ownerStats, splitLines } from "./apply.js";
import { watch } from "./watch.js";
import { hook } from "./hooks.js";
import { integrate } from "./integrations.js";
import { login, logout } from "./login.js";
import { githubLogin, readCreds } from "./creds.js";
import { sync } from "./sync.js";
import { serve } from "./serve.js";

const USAGE = `prov — char/line-level provenance for AI-written code

  prov init [--force] [--hooks]     baseline tracked files to you (+ install agent hooks)
  prov install | uninstall          add/remove Claude Code, Codex and OpenCode adapters
  prov watch [--ttl SEC]            attribute live edits to you (or to an agent mid-edit; ttl caps a stuck window, default 120)
  prov <file> | prov blame <file>   ownership summary | per-line overlay
  prov stats                        repo-wide ownership
  prov claim <file> [--human | --harness H [--model M] [--effort E]]
  prov login [--client-id ID] | logout | whoami
  prov sync --server URL | prov serve [--port N]
  prov hook claude|codex|opencode   (called by agent hooks; reads JSON on stdin)`;

const git = (args: string[], cwd = process.cwd()): string | undefined => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch {
    return undefined;
  }
};

function gitIdentity(): string {
  return githubLogin() ?? git(["config", "user.email"])?.split("@")[0] ?? git(["config", "user.name"])?.split(" ")[0] ?? "anon";
}

/** Initialised prov root above cwd, else the git root, else cwd. */
function projectRoot(): string {
  return findProvRoot(process.cwd()) ?? git(["rev-parse", "--show-toplevel"]) ?? process.cwd();
}

/** Store key for a user-supplied path (relative to cwd, any subdirectory). */
function repoPath(root: string, file: string | undefined): string {
  if (!file) throw new Error("file argument required");
  const rel = relative(root, resolve(file));
  if (rel.startsWith("..")) throw new Error(`${file} is outside ${root}`);
  return rel.split(sep).join("/");
}

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const PALETTE = ["36", "33", "35", "32", "34", "31", "90"];
function paint(label: string, width = 0): string {
  const padded = label.padEnd(width);
  if (!COLOR) return padded;
  const idx = [...label].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length;
  return `\x1b[${PALETTE[idx]}m${padded}\x1b[0m`;
}

function openStore(root = projectRoot()): Store {
  if (!findProvRoot(root)) throw new Error(`no provenance db in ${root} — run prov init`);
  return new Store(root);
}

function cmdInit(force: boolean): void {
  const gitTop = git(["rev-parse", "--show-toplevel"]);
  const root = gitTop ?? process.cwd();
  if (!gitTop) console.warn(`warning: ${root} is not a git repository — baselining nothing; prov will still track edits here`);
  const store = new Store(root);
  const human = store.human(gitIdentity());
  // Tracked + untracked-but-not-ignored, so a fresh `git init` (no commits yet) still gets a baseline.
  const files = gitTop ? (git(["ls-files", "--cached", "--others", "--exclude-standard"], root) ?? "").split("\n").filter((f) => f && !f.startsWith(".prov/")) : [];
  let n = 0;
  let skipped = 0;
  for (const f of files) {
    if (!force && store.file(f)) {
      skipped++;
      continue;
    }
    const content = readText(join(root, f));
    if (typeof content !== "string") continue;
    store.baseline(f, content, human);
    n++;
  }
  // Keep the local db out of commits without touching tracked files.
  if (gitTop) {
    const exclude = join(gitTop, ".git", "info", "exclude");
    try {
      if (!existsSync(exclude) || !readFileSync(exclude, "utf8").split("\n").includes(".prov/")) appendFileSync(exclude, "\n.prov/\n");
    } catch {}
  }
  console.log(`prov init: baseline ${n} files → ${store.envLabel(human)}${skipped ? ` (${skipped} already tracked, --force to reset)` : ""}`);
  store.close();
}

function cmdShow(store: Store, file: string): void {
  const row = store.file(file);
  if (!row) throw new Error(`no provenance for ${file}`);
  const owners = lineOwners(row.content, row.runs);
  const chars = ownerStats(row.runs);
  const total = [...chars.values()].reduce((a, b) => a + b, 0) || 1;
  const lineCount = new Map<string, number>();
  for (const o of owners) lineCount.set(o, (lineCount.get(o) ?? 0) + 1);
  console.log(`${file} (${row.content.length} chars, ${owners.length} lines)`);
  for (const [o, c] of [...chars.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = ((c / total) * 100).toFixed(1).padStart(5);
    console.log(`  ${paint(store.envLabel(Number(o)), 36)} ${pct}%  ${String(lineCount.get(o) ?? 0).padStart(4)} lines`);
  }
}

function cmdBlame(store: Store, file: string): void {
  const row = store.file(file);
  if (!row) throw new Error(`no provenance for ${file}`);
  const owners = lineOwners(row.content, row.runs);
  const labels = owners.map((o) => store.envLabel(Number(o)));
  const width = Math.min(48, Math.max(...labels.map((l) => l.length), 0));
  const lines = splitLines(row.content);
  const digits = String(lines.length).length;
  lines.forEach((line, i) => console.log(`${paint(labels[i].slice(0, width), width)} ${String(i + 1).padStart(digits)}│ ${line}`));
}

function cmdStats(store: Store): void {
  const s = store.stats();
  let total = 0;
  for (const v of s.values()) total += v.chars;
  console.log("repo provenance");
  for (const [o, v] of [...s.entries()].sort((a, b) => b[1].chars - a[1].chars)) {
    const pct = ((v.chars / (total || 1)) * 100).toFixed(1).padStart(5);
    console.log(`  ${paint(store.envLabel(Number(o)), 36)} ${pct}%  ${String(v.files).padStart(4)} files`);
  }
}

function cmdIntegrate(install: boolean): void {
  const bin = resolve(process.argv[1]);
  for (const r of integrate(bin, install)) {
    const mark = r.status === "skipped" ? "·" : install ? "+" : "-";
    console.log(`${mark} ${r.name.padEnd(9)} ${r.status.padEnd(9)} ${r.file}${r.note ? `  (${r.note})` : ""}`);
  }
  if (install) console.log("restart running agent sessions to pick up hooks; edits are recorded only in repos with `prov init`");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v && !v.startsWith("--") ? v : undefined;
  };
  const cmd = argv[0];
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return console.log(USAGE);
    case "hook":
      return hook(argv[1] ?? "unknown");
    case "init":
      cmdInit(argv.includes("--force"));
      if (argv.includes("--hooks")) cmdIntegrate(true);
      return;
    case "install":
      return cmdIntegrate(true);
    case "uninstall":
      return cmdIntegrate(false);
    case "watch": {
      const root = projectRoot();
      const ttl = Number(flag("--ttl") ?? 120) || 120;
      await watch(root, openStore(root), gitIdentity(), ttl, (s) => console.log(s));
      return;
    }
    case "login": {
      const name = await login(flag("--client-id"));
      return console.log(`linked to GitHub: ${name} — token stored 0600 at ~/.prov/credentials.json`);
    }
    case "logout":
      return console.log(logout());
    case "whoami": {
      const c = readCreds();
      return console.log(c.github ? `linked: ${c.github.login} (since ${c.github.added})` : `not linked — run prov login (attributing to h:${gitIdentity()})`);
    }
    case "sync": {
      const server = flag("--server") ?? process.env.PROV_SERVER;
      if (!server) throw new Error("prov sync --server URL required (or set PROV_SERVER)");
      return console.log(await sync(openStore(), server, readCreds().github?.token));
    }
    case "serve":
      serve(Number(flag("--port") ?? 8717) || 8717, (s) => console.log(s));
      return;
    case "stats":
      return cmdStats(openStore());
    case "blame": {
      const root = projectRoot();
      return cmdBlame(openStore(root), repoPath(root, argv[1]));
    }
    case "claim": {
      const root = projectRoot();
      const store = openStore(root);
      const file = repoPath(root, argv[1]);
      const content = readText(join(root, file));
      if (typeof content !== "string") throw new Error(`${file}: missing, binary or larger than 1 MiB`);
      let env: number;
      if (argv.includes("--human")) env = store.human(gitIdentity());
      else {
        const h = flag("--harness");
        if (!h) throw new Error("claim: pass --human or --harness <name> [--model M] [--effort E]");
        env = store.agent(h, flag("--model"), flag("--effort"));
      }
      store.claim(file, content, env);
      return console.log(`claimed ${file} → ${store.envLabel(env)}`);
    }
    default: {
      if (cmd.startsWith("-")) throw new Error(`unknown option ${cmd}\n\n${USAGE}`);
      const root = projectRoot();
      return cmdShow(openStore(root), repoPath(root, cmd === "show" ? argv[1] : cmd));
    }
  }
}

main().catch((e) => {
  console.error(`prov: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
