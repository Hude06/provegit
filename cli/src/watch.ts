import chokidar from "chokidar";
import { execFileSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { readText, Store } from "./store.js";

const IGNORES = new Set([".git", ".prov", "node_modules", "dist", ".DS_Store"]);

function gitIgnored(root: string, rel: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", rel], { cwd: root, stdio: "ignore" });
    return true; // exit 0 = ignored
  } catch {
    return false; // exit 1 = not ignored, 128 = not a git repo
  }
}

/** Watch the repo; attribute each change to the agent whose session recently touched the file, else the human. */
export function watch(root: string, store: Store, identity: string, ttlSec: number, log: (s: string) => void): Promise<void> {
  const rootAbs = resolve(root);
  const human = store.human(identity);
  const skipped = new Set<string>();
  let seen = 0; // highest event id already shown, so hook-recorded edits print once
  const skip = (path: string, why: string) => {
    if (skipped.has(path)) return;
    skipped.add(path);
    log(`· ${path} skipped (${why})`);
  };
  const watcher = chokidar.watch(rootAbs, {
    // chokidar v4 dropped glob support: `ignored` must be a function/regex.
    ignored: (p: string) => relative(rootAbs, p).split(sep).some((seg) => IGNORES.has(seg)),
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  const onChange = (abs: string, kind: "change" | "add" | "unlink") => {
    const path = relative(rootAbs, abs).split(sep).join("/");
    const tracked = store.file(path);
    if (!tracked && gitIgnored(rootAbs, path)) return skip(path, "gitignored");
    const env = store.activeSession([path], ttlSec) ?? human;
    let content: string | undefined | null = kind === "unlink" ? undefined : readText(abs);
    if (content === null) return skip(path, "binary or > 1 MiB");
    if (content === undefined) {
      if (!tracked) return;
      content = "";
    }
    const sign = kind === "unlink" ? "-" : tracked ? "~" : "+";
    if (!store.applyChange(path, content, env)) {
      // Unchanged vs db: an agent hook usually recorded it a moment ago — show that once.
      const ev = store.lastEvent(path);
      if (ev && ev.id > seen && Date.now() / 1000 - ev.ts < 10) {
        seen = ev.id;
        log(`${sign} ${path} → ${store.envLabel(ev.env_id)} (hook)`);
      }
      return;
    }
    seen = Math.max(seen, store.lastEvent(path)?.id ?? 0);
    log(`${sign} ${path} → ${store.envLabel(env)}`);
  };
  watcher.on("change", (p) => onChange(p, "change"));
  watcher.on("add", (p) => onChange(p, "add"));
  watcher.on("unlink", (p) => onChange(p, "unlink"));
  watcher.on("error", (e) => log(`watch error: ${String(e)}`));
  log(`watching ${rootAbs} as ${store.envLabel(human)} — agent hooks credit their own edits; Ctrl-C to stop`);
  return new Promise((res) => watcher.on("ready", () => res()));
}
