import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRuns, charDiff, lineOwners, replay, runsLength } from "../src/apply.ts";
import { verifyChain } from "../src/serve.ts";
import { parsePayload, pathsFromToolInput, record, subagentTranscript, modelFromTranscript } from "../src/hooks.ts";
import { integrate, MARK, opencodePlugin } from "../src/integrations.ts";
import { sha256, Store } from "../src/store.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "prov-test-"));

test("applyRuns keeps prior owners and assigns inserts", () => {
  const a = "hello world";
  const b = "hello brave world";
  const runs = applyRuns([{ l: a.length, o: "1" }], charDiff(a, b), "2");
  assert.equal(runsLength(runs), b.length);
  assert.deepEqual(runs, [{ l: 6, o: "1" }, { l: 6, o: "2" }, { l: 5, o: "1" }]);
});

test("rewritten line goes to the rewriter (semantic diff, no stray kept chars)", () => {
  const a = "export const a = 1;\nexport const b = 3;\nx\nexport const c = 9;\n";
  const b = "export const a = 1;\nexport const fromOpencode = true;\n";
  const ops = charDiff(a, b);
  assert.equal(replay(a, ops), b);
  const runs = applyRuns([{ l: a.length, o: "h" }], ops, "agent");
  assert.deepEqual(lineOwners(b, runs), ["h", "agent"]);
});

test("lineOwners uses majority owner per line", () => {
  const content = "aaaa\nbb\n\nc";
  const runs = [{ l: 3, o: "1" }, { l: 4, o: "2" }, { l: 4, o: "3" }];
  assert.deepEqual(lineOwners(content, runs), ["1", "2", "3", "3"]);
  assert.deepEqual(lineOwners("ab\ncd\n", [{ l: 3, o: "1" }, { l: 3, o: "2" }]), ["1", "2"]);
});

test("replay rejects ops that skip trailing content", () => {
  assert.equal(replay("abc", [[0, "ab"], [1, "X"]]), undefined);
  assert.equal(replay("abc", [[0, "ab"], [-1, "c"], [1, "X"]]), "abX");
});

test("verifyChain builds on prior state (incremental sync)", () => {
  const ev1 = { id: 1, path: "f", ops: charDiff("", "one") };
  const s1 = verifyChain(new Map(), [ev1], [{ path: "f", sha: sha256("one") }]);
  assert.ok(s1 instanceof Map);
  const ev2 = { id: 2, path: "f", ops: charDiff("one", "one two") };
  const s2 = verifyChain(s1 as Map<string, string>, [ev2], [{ path: "f", sha: sha256("one two") }]);
  assert.ok(s2 instanceof Map);
  assert.equal(typeof verifyChain(new Map(), [ev2], []), "string");
});

test("parsePayload: claude subagent gets its own session + model", () => {
  const dir = tmp();
  const tr = join(dir, "sess.jsonl");
  writeFileSync(tr, JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5" } }) + "\n");
  const sub = subagentTranscript(tr, "abc");
  mkdirSync(join(dir, "sess", "subagents"), { recursive: true });
  writeFileSync(sub, JSON.stringify({ type: "assistant", message: { model: "claude-haiku-5-5" } }) + "\n");
  assert.equal(modelFromTranscript(tr), "claude-opus-5-5");
  const h = parsePayload("claude", {
    session_id: "s1", agent_id: "abc", transcript_path: tr, cwd: dir, effort: { level: "high" },
    hook_event_name: "PreToolUse", tool_input: { file_path: "src/x.ts" },
  })!;
  assert.equal(h.sessionKey, "claude:s1:abc");
  assert.equal(h.model, "claude-haiku-5-5");
  assert.equal(h.effort, "high");
  assert.equal(h.phase, "pre");
  assert.deepEqual(h.paths, [join(dir, "src/x.ts")]);
});

test("pathsFromToolInput parses apply_patch bodies (codex string/array, opencode patchText)", () => {
  const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n*** Add File: b/c.ts\n+x\n*** End Patch";
  assert.deepEqual(pathsFromToolInput({ command: ["apply_patch", patch] }, "/r"), ["/r/a.ts", "/r/b/c.ts"]);
  assert.deepEqual(pathsFromToolInput({ patchText: patch }, "/r"), ["/r/a.ts", "/r/b/c.ts"]);
  assert.deepEqual(pathsFromToolInput({ filePath: "/abs/z.ts" }, "/r"), ["/abs/z.ts"]);
});

test("record: post hook attributes edit to agent; uninitialised repos untouched", () => {
  const root = tmp();
  const store = new Store(root);
  const human = store.human("me");
  writeFileSync(join(root, "f.ts"), "const a = 1;\n");
  store.baseline("f.ts", "const a = 1;\n", human);
  store.close();
  writeFileSync(join(root, "f.ts"), "const a = 1;\nconst b = 2;\n");
  record(parsePayload("opencode", { session_id: "o1", cwd: root, model: "r740/qwen", effort: "high", tool_input: { filePath: "f.ts" } })!);
  const s2 = new Store(root);
  const row = s2.file("f.ts")!;
  assert.equal(row.content, "const a = 1;\nconst b = 2;\n");
  assert.deepEqual(lineOwners(row.content, row.runs).map((o) => s2.envLabel(Number(o))).slice(0, 2), ["h:me", "agent:opencode/r740/qwen@high"]);
  s2.close();

  // Post closed the window: a human edit right after the agent's is credited to the human.
  const s3 = new Store(root);
  assert.equal(s3.activeSession(["f.ts"], 300), undefined);
  record(parsePayload("opencode", { session_id: "o1", cwd: root, hook_event_name: "PreToolUse", tool_input: { filePath: "f.ts" } })!);
  assert.notEqual(s3.activeSession(["f.ts"], 300), undefined);
  s3.close();

  const bare = tmp();
  writeFileSync(join(bare, "g.ts"), "x");
  record(parsePayload("claude", { session_id: "c1", cwd: bare, tool_input: { file_path: "g.ts" } })!);
  assert.equal(existsSync(join(bare, ".prov")), false);
});

test("integrate installs idempotently, preserves foreign hooks, uninstalls cleanly", () => {
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"]) delete process.env[k];
  const home = tmp();
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".codex"));
  mkdirSync(join(home, ".config", "opencode", "plugin"), { recursive: true });
  const other = { matcher: "", hooks: [{ type: "command", command: "other-tool" }] };
  const legacy = { matcher: "Edit|Write", hooks: [{ type: "command", command: "node /x/.local/bin/prov hook claude" }] };
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "opus", hooks: { PreToolUse: [other], PostToolUse: [legacy] } }));
  writeFileSync(join(home, ".config", "opencode", "plugin", "prov.js"), `// ${MARK} old copy`);

  integrate("/bin/prov", true, { home });
  integrate("/bin/prov", true, { home });
  const cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(cfg.model, "opus");
  assert.equal(cfg.hooks.PreToolUse.length, 2);
  assert.equal(cfg.hooks.PostToolUse.length, 1);
  assert.match(cfg.hooks.PostToolUse[0].hooks[0].command, /hook claude # prov-hook$/);
  const codex = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
  assert.match(codex.hooks.PostToolUse[0].hooks[0].command, /hook codex/);
  assert.ok(existsSync(join(home, ".config", "opencode", "plugins", "prov.js")));
  assert.equal(existsSync(join(home, ".config", "opencode", "plugin", "prov.js")), false);

  integrate("/bin/prov", false, { home });
  const after = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(after.hooks, { PreToolUse: [other] });
  assert.equal(existsSync(join(home, ".config", "opencode", "plugins", "prov.js")), false);

  writeFileSync(join(home, ".claude", "settings.json"), "{ // comment\n}");
  const r = integrate("/bin/prov", true, { home }).find((x) => x.name === "claude")!;
  assert.equal(r.status, "skipped");
  assert.equal(readFileSync(join(home, ".claude", "settings.json"), "utf8"), "{ // comment\n}");
  rmSync(home, { recursive: true });
});

test("opencode plugin is valid JS exporting a plugin", async () => {
  const dir = tmp();
  const f = join(dir, "prov.mjs");
  writeFileSync(f, opencodePlugin("/nonexistent/prov"));
  const mod = await import(f);
  const hooks = await mod.ProvPlugin({ directory: dir });
  assert.equal(typeof hooks["tool.execute.after"], "function");
  await hooks["chat.message"]({ sessionID: "s", model: { providerID: "p", modelID: "m" }, variant: "high" });
  await hooks["tool.execute.before"]({ tool: "read", sessionID: "s", callID: "c" }, { args: {} }); // non-edit tool: no spawn
  assert.equal(mod.default.id, "prov");
});
