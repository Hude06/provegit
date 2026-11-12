import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lineOwners } from "../src/apply.ts";
import { parsePayload, record } from "../src/hooks.ts";
import { buildNote, writeNote } from "../src/notes.ts";
import { Store } from "../src/store.ts";
import { gitIdentity } from "../src/creds.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

function repo() {
  const root = mkdtempSync(join(tmpdir(), "prov-shell-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "123+me@users.noreply.github.com");
  git(root, "config", "user.name", "Me");
  writeFileSync(join(root, ".gitignore"), "build/\n");
  writeFileSync(join(root, "a.ts"), "one\ntwo\n");
  writeFileSync(join(root, "d.ts"), "gone soon\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  mkdirSync(join(root, ".prov"));
  const store = new Store(root);
  const me = store.human("me");
  for (const f of [".gitignore", "a.ts", "d.ts"]) store.baseline(f, git(root, "show", `HEAD:${f}`), me);
  writeNote(root, buildNote(store, root, "HEAD")!);
  store.close();
  return root;
}

/** Run a hook the way Claude Code would for a Bash tool call. */
const bash = (root: string, phase: "PreToolUse" | "PostToolUse", command: string) =>
  record(parsePayload("claude", { hook_event_name: phase, session_id: "s1", cwd: root, tool_name: "Bash", tool_input: { command }, model: "claude-opus-5-5", effort: { level: "high" } })!);

const owners = (root: string, path: string) => {
  const s = new Store(root);
  try {
    const f = s.file(path);
    return f ? lineOwners(f.content, f.runs).map((o) => s.envLabel(Number(o))) : undefined;
  } finally {
    s.close();
  }
};
const AGENT = "agent:claude/claude-opus-5-5@high";

test("shell tools are recognised for every harness", () => {
  for (const [h, tool] of [["claude", "Bash"], ["codex", "exec_command"], ["codex", "shell"], ["opencode", "bash"]]) {
    const p = parsePayload(h, { session_id: "x", tool_name: tool, tool_input: { command: "*** Update File: a.ts" } })!;
    assert.equal(p.shell, true, `${h} ${tool}`);
    assert.deepEqual(p.paths, []);
  }
  assert.equal(parsePayload("claude", { session_id: "x", tool_name: "Edit", tool_input: { file_path: "/r/a.ts" } })!.shell, false);
});

test("shell command: its writes go to the agent, earlier unrecorded edits to the human", () => {
  const root = repo();
  // The human edited a.ts with no watcher running: prov hasn't seen it yet.
  writeFileSync(join(root, "a.ts"), "one\ntwo\nmine\n");
  const later = Date.now() / 1000 + 0.5;
  utimesSync(join(root, "a.ts"), later, later);

  bash(root, "PreToolUse", "sed … && node gen.js");
  // What the command does:
  writeFileSync(join(root, "a.ts"), "one\ntwo\nmine\nagent line\n");
  writeFileSync(join(root, "new.ts"), "generated\n");
  rmSync(join(root, "d.ts"));
  mkdirSync(join(root, "build"));
  writeFileSync(join(root, "build", "out.js"), "ignored\n");
  bash(root, "PostToolUse", "sed … && node gen.js");

  const human = `h:${gitIdentity(root)}`; // linked GitHub login if any, else "me" from the noreply email
  assert.deepEqual(owners(root, "a.ts"), ["h:me", "h:me", human, AGENT]);
  assert.deepEqual(owners(root, "new.ts"), [AGENT]);
  const st = new Store(root);
  assert.equal(st.file("d.ts")!.content, "", "deletion recorded");
  st.close();
  assert.equal(owners(root, "build/out.js"), undefined, "gitignored output not tracked");

  // A command that changes nothing credits nothing.
  bash(root, "PreToolUse", "npm test");
  bash(root, "PostToolUse", "npm test");
  assert.deepEqual(owners(root, "a.ts"), ["h:me", "h:me", human, AGENT]);
});

test("shell command restoring files from git: owners come from the commit's note, not the agent", () => {
  const root = repo();
  // Agent (via Edit tool) adds a line; commit it with its note.
  const s = new Store(root);
  s.applyChange("a.ts", "one\ntwo\nagent\n", s.agent("claude", "claude-opus-5-5", "high"));
  writeFileSync(join(root, "a.ts"), "one\ntwo\nagent\n");
  git(root, "commit", "-qam", "agent work");
  writeNote(root, buildNote(s, root, "HEAD")!);
  s.close();

  // Agent scribbles over the file in a shell command…
  bash(root, "PreToolUse", "python rewrite.py");
  writeFileSync(join(root, "a.ts"), "scrap\n");
  bash(root, "PostToolUse", "python rewrite.py");
  assert.deepEqual(owners(root, "a.ts"), [AGENT]);

  // …then throws it away with git: the committed text and its recorded owners come back.
  bash(root, "PreToolUse", "git checkout -- a.ts");
  git(root, "checkout", "--", "a.ts");
  const t = Date.now() / 1000 + 0.5;
  utimesSync(join(root, "a.ts"), t, t);
  bash(root, "PostToolUse", "git checkout -- a.ts");
  assert.deepEqual(owners(root, "a.ts"), ["h:me", "h:me", AGENT]);
});
