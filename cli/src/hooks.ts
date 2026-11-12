import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { findProvRoot, readText, Store } from "./store.js";
import { gitIdentity } from "./creds.js";
import { shellAfter, shellBefore } from "./shell.js";

/**
 * Harness-neutral hook input. Adapters:
 *  - claude: Claude Code PreToolUse/PostToolUse JSON (session_id, transcript_path, cwd, tool_input, effort.level, agent_id)
 *  - codex:  Codex hooks.json PreToolUse/PostToolUse JSON (session_id, cwd, model, tool_input.command = apply_patch body)
 *  - opencode: payload built by the generated OpenCode plugin (see integrations.ts), same field names
 */
export type HookInput = {
  harness: string;
  phase: "pre" | "post";
  sessionKey: string;
  cwd: string;
  model?: string;
  effort?: string;
  /** Absolute paths the tool call touches. */
  paths: string[];
  /** A shell command: it may write any file, so changes are found by scanning the repo. */
  shell?: boolean;
};

/** Shell tools: Claude Code `Bash`, Codex `exec_command` (older: `shell`, `local_shell`), OpenCode `bash`. */
export const SHELL_TOOLS = /^(bash|exec_command|shell|local_shell|unified_exec)$/i;

function readStdin(): Promise<string> {
  return new Promise((res) => {
    if (process.stdin.isTTY) return res("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => res(data));
    process.stdin.on("error", () => res(data));
  });
}

const TAIL = 512 * 1024;

/** Last assistant model in a Claude Code transcript JSONL (reads only the tail; transcripts grow large). */
export function modelFromTranscript(path: string): string | undefined {
  let text: string;
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, TAIL);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"model"')) continue;
    try {
      const j = JSON.parse(line);
      const m = j?.message?.model;
      if (j?.type === "assistant" && typeof m === "string" && m && !m.startsWith("<")) return m;
    } catch {}
  }
  return undefined;
}

/** Claude Code stores subagent transcripts at <session>.jsonl → <session>/subagents/agent-<id>.jsonl. */
export function subagentTranscript(transcriptPath: string, agentId: string): string {
  return transcriptPath.replace(/\.jsonl$/, "") + `/subagents/agent-${agentId}.jsonl`;
}

const scalar = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;

const objField = (v: unknown, ...keys: string[]): string | undefined => {
  if (scalar(v)) return scalar(v);
  if (v && typeof v === "object") for (const k of keys) if (scalar((v as any)[k])) return scalar((v as any)[k]);
  return undefined;
};

/** Paths named by a tool call: explicit path fields plus apply_patch headers. Returned absolute. */
export function pathsFromToolInput(ti: any, cwd: string): string[] {
  ti = ti ?? {};
  const out: string[] = [];
  for (const v of [ti.file_path, ti.filePath, ti.notebook_path, ti.path]) if (typeof v === "string" && v) out.push(v);
  if (Array.isArray(ti.file_paths)) for (const v of ti.file_paths) if (typeof v === "string" && v) out.push(v);
  const patchSrc = [ti.command, ti.patch, ti.patchText, ti.input].map((v) => (Array.isArray(v) ? v.join("\n") : typeof v === "string" ? v : "")).join("\n");
  for (const m of patchSrc.matchAll(/^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/gm)) out.push(m[1].trim());
  return [...new Set(out.map((f) => (isAbsolute(f) ? f : resolve(cwd, f))))];
}

export function parsePayload(harness: string, p: any): HookInput | undefined {
  if (!p || typeof p !== "object") return undefined;
  const sid = scalar(p.session_id) ?? scalar(p.sessionID);
  if (!sid) return undefined;
  const agentId = scalar(p.agent_id);
  const cwd = scalar(p.cwd) ?? process.cwd();
  let model = objField(p.model, "id", "modelID", "model");
  const transcript = scalar(p.transcript_path);
  if (!model && transcript) {
    model = (agentId && modelFromTranscript(subagentTranscript(transcript, agentId))) || modelFromTranscript(transcript);
  }
  const effort = objField(p.effort, "level") ?? scalar(p.reasoning_effort) ?? scalar(p.model_reasoning_effort) ?? objField(p.options?.effortLevel, "level");
  const ev = String(p.hook_event_name ?? "PostToolUse");
  const shell = SHELL_TOOLS.test(scalar(p.tool_name) ?? scalar(p.tool) ?? "");
  return {
    harness,
    phase: /^pre/i.test(ev) ? "pre" : "post",
    // Subagents share the parent session_id but can run a different model → own session window.
    sessionKey: `${harness}:${sid}${agentId ? ":" + agentId : ""}`,
    cwd,
    model,
    effort,
    paths: shell ? [] : pathsFromToolInput(p.tool_input, cwd),
    shell,
  };
}

/** Shell command: snapshot before, credit whatever it changed after. */
function recordShell(h: HookInput, log?: (s: string) => void): void {
  const root = findProvRoot(h.cwd);
  if (!root) return;
  const store = new Store(root);
  try {
    const env = store.agent(h.harness, h.model, h.effort);
    const human = store.human(gitIdentity(root));
    // Own window key, so a parallel Edit call's per-path window is untouched. Path-less = watcher credits the agent meanwhile.
    const key = `${h.sessionKey}:sh`;
    if (h.phase === "pre") {
      shellBefore(store, root, key, human);
      store.touchSession(key, env, []);
      return;
    }
    const r = shellAfter(store, root, key, env, human);
    for (const p of r.agent) log?.(`${p} → ${store.envLabel(env)} (shell)`);
    for (const p of r.fromGit) log?.(`${p} → from git`);
    store.closeSession(key, []);
  } finally {
    store.close();
  }
}

/** Record one hook event. Repos without `prov init` (no .prov/prov.db) are left untouched. */
export function record(h: HookInput, log?: (s: string) => void): void {
  if (h.shell) return recordShell(h, log);
  const byRoot = new Map<string, string[]>();
  const add = (root: string | undefined, abs?: string) => {
    if (!root) return;
    const list = byRoot.get(root) ?? [];
    if (abs) {
      const rel = relative(root, abs);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".prov")) list.push(abs);
    }
    byRoot.set(root, list);
  };
  if (h.paths.length) for (const abs of h.paths) add(findProvRoot(dirname(abs)), abs);
  else add(findProvRoot(h.cwd));

  for (const [root, abss] of byRoot) {
    if (h.paths.length && !abss.length) continue;
    const store = new Store(root);
    try {
      const env = store.agent(h.harness, h.model, h.effort);
      const rels = abss.map((a) => relative(root, a).split(sep).join("/"));
      if (h.phase !== "post" || !rels.length) {
        // Pre: open the window. Path-less events keep a TTL-only window (watcher fallback).
        store.touchSession(h.sessionKey, env, rels);
        if (h.phase !== "post") continue;
      }
      for (let i = 0; i < abss.length; i++) {
        const content = readText(abss[i]);
        if (content === null) continue;
        if (content === undefined) {
          if (store.file(rels[i])) store.applyChange(rels[i], "", env);
          continue;
        }
        if (store.applyChange(rels[i], content, env)) log?.(`${rels[i]} → ${store.envLabel(env)}`);
      }
      // Edit recorded → later changes to these files are someone else's (usually the human).
      store.closeSession(h.sessionKey, rels);
    } finally {
      store.close();
    }
  }
}

/** `prov hook <harness>` entrypoint. Never fails the agent's tool call: always prints `{}` and exits 0. */
export async function hook(harness: string): Promise<void> {
  try {
    const h = parsePayload(harness, JSON.parse((await readStdin()) || "null"));
    if (h) record(h);
  } catch (e) {
    if (process.env.PROV_DEBUG) process.stderr.write(`prov hook ${harness}: ${String(e)}\n`);
  }
  process.stdout.write("{}\n");
}
