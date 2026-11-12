#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { findProvRoot, readText, Store } from "./store.js";
import { lineOwners, ownerStats, splitLines } from "./apply.js";
import { watch } from "./watch.js";
import { hook } from "./hooks.js";
import { integrate } from "./integrations.js";
import { login, logout, openBrowser } from "./login.js";
import { uiServer } from "./ui.js";
import { tui } from "./tui.js";
import { gitIdentity, readCreds } from "./creds.js";
import { sync } from "./sync.js";
import { serve } from "./serve.js";
import { githubInit } from "./github.js";
import { buildNote, installGitHooks, pushNotes, readNote, replaying, summarize, writeNote } from "./notes.js";

const USAGE = `prov — char/line-level provenance for AI-written code

  prov init [--force] [--hooks]     baseline tracked files to you (+ install agent hooks)
  prov install | uninstall          add/remove Claude Code, Codex and OpenCode adapters
  prov ui [--port N] [--no-open]     live diff viewer: changes since HEAD, coloured by who wrote them
  prov tui [--base REF] [--follow]  the same live diff viewer in the terminal (alias: prov diff)
  prov watch [--ttl SEC]            attribute live edits to you (or to an agent mid-edit; ttl caps a stuck window, default 120)
  prov <file> | prov blame <file>   ownership summary | per-line overlay
  prov stats                        repo-wide ownership
  prov log [-n N] [REV]             commits with who wrote their lines (from git notes)
  prov note [REV]                   (re)write REV's ownership note (the post-commit hook runs this)
  prov notes push [REMOTE]          share notes now (git push also does it, via the pre-push hook)
  prov github init [--uses REF]     add .github/workflows/prov.yml: PR comment + inline notes on agent-written lines
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
      for (const line of installGitHooks(projectRoot(), resolve(process.argv[1]))) console.log(line);
      if (argv.includes("--hooks")) cmdIntegrate(true);
      return;
    case "note": {
      // --hook: called from post-commit; silent, never fails the commit, and leaves rebases to git's note copying.
      const quiet = argv.includes("--hook");
      try {
        const root = projectRoot();
        const rev = argv[1] && !argv[1].startsWith("--") ? argv[1] : "HEAD";
        if (quiet && (!findProvRoot(root) || replaying(root))) return;
        const store = openStore(root);
        const note = buildNote(store, root, rev, store.human(gitIdentity()));
        if (!note) throw new Error(`${rev} is not a commit`);
        writeNote(root, note);
        if (!quiet) console.log(`${note.commit.slice(0, 8)}  ${summarize(note)}`);
      } catch (e) {
        if (!quiet) throw e;
      }
      return;
    }
    case "log": {
      const root = projectRoot();
      const n = Number(flag("-n") ?? 20) || 20;
      const rev = argv.slice(1).find((a, i, all) => !a.startsWith("-") && all[i - 1] !== "-n") ?? "HEAD";
      const lines = (git(["log", `-n${n}`, "--no-merges", "--format=%H%x09%s", rev], root) ?? "").split("\n").filter(Boolean);
      if (!lines.length) throw new Error(`no commits at ${rev}`);
      for (const l of lines) {
        const [sha, subject] = l.split("\t");
        const note = readNote(root, sha);
        console.log(`${sha.slice(0, 8)}  ${subject.length > 50 ? subject.slice(0, 49) + "…" : subject.padEnd(50)}  ${note ? summarize(note) : "— no note (prov note " + sha.slice(0, 8) + ")"}`);
      }
      return;
    }
    case "notes": {
      if (argv[1] !== "push") throw new Error("usage: prov notes push [REMOTE]");
      const remote = argv[2] && !argv[2].startsWith("--") ? argv[2] : "origin";
      if (argv.includes("--hook")) {
        // From pre-push, detached: wait for the user's `git push` to finish, then send notes. Never errors.
        const pid = Number(flag("--after-pid"));
        const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
        for (let waited = 0; pid > 1 && alive() && waited < 600_000; waited += 250) await new Promise((r) => setTimeout(r, 250));
        try { pushNotes(projectRoot(), remote); } catch {}
        return;
      }
      return console.log(pushNotes(projectRoot(), remote));
    }
    case "github": {
      if (argv[1] !== "init") throw new Error("usage: prov github init [--uses OWNER/REPO/action@REF]");
      return console.log(githubInit(projectRoot(), flag("--uses")));
    }
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
    case "tui":
    case "diff": {
      const root = projectRoot();
      await tui(openStore(root), { base: flag("--base"), follow: argv.includes("--follow"), identity: gitIdentity(), ttl: Number(flag("--ttl") ?? 120) || 120 });
      process.exit(0);
    }
    case "ui": {
      const root = projectRoot();
      const store = openStore(root);
      // Catch up on edits made while nothing was watching (agent edits are already recorded by hooks).
      const human = store.human(gitIdentity());
      const z = (args: string[]) => (git(args, root) ?? "").split("\0").filter((f) => f && !f.startsWith(".prov/"));
      let caught = 0;
      for (const f of z(["ls-files", "-z", "--modified", "--deleted", "--others", "--exclude-standard"])) {
        const disk = readText(join(root, f));
        if (disk === null) continue;
        if (disk === undefined && !store.file(f)) continue;
        if (store.applyChange(f, disk ?? "", store.activeSession([f], 120) ?? human)) caught++;
      }
      if (caught) console.log(`recorded ${caught} file(s) changed while prov wasn't watching → ${store.envLabel(human)}`);
      const port = Number(flag("--port") ?? 8718) || 8718;
      const server = uiServer(store, port, (s) => console.log(s));
      server.on("error", (e: any) => {
        console.error(e?.code === "EADDRINUSE" ? `prov: port ${port} is busy — try prov ui --port ${port + 1}` : `prov: ${e.message}`);
        process.exit(1);
      });
      server.on("listening", () => {
        if (!argv.includes("--no-open")) openBrowser(`http://127.0.0.1:${port}`);
      });
      await watch(root, store, gitIdentity(), Number(flag("--ttl") ?? 120) || 120, (s) => console.log(s));
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
