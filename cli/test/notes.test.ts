import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { buildNote, readNote, summarize, writeNote } from "../src/notes.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

test("commit note: line owners, added lines per author, partial staging → unrecorded", () => {
  const root = mkdtempSync(join(tmpdir(), "prov-notes-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@x.io");
  git(root, "config", "user.name", "T");
  writeFileSync(join(root, "a.ts"), "one\ntwo\n");
  git(root, "add", "a.ts");
  git(root, "commit", "-qm", "base");
  const store = new Store(root);
  const me = store.human("me");
  store.baseline("a.ts", "one\ntwo\n", me);
  const agent = store.agent("claude", "claude-opus-5-5", "high");
  store.applyChange("a.ts", "one\ntwo\nthree\nfour\n", agent);
  writeFileSync(join(root, "a.ts"), "one\ntwo\nthree\nfour\n");
  // staged version differs from what prov recorded: an extra line prov never saw
  writeFileSync(join(root, "a.ts"), "one\ntwo\nthree\nfour\nfive\n");
  git(root, "add", "a.ts");
  git(root, "commit", "-qm", "agent work");

  const note = buildNote(store, root, "HEAD")!;
  const f = note.files["a.ts"];
  const name = (i: number) => note.actors[i].id;
  assert.equal(f.lines, 5);
  assert.deepEqual(f.owners.map(([a, b, i]) => [a, b, name(i)]), [[1, 2, "h:me"], [3, 4, "a:claude/claude-opus-5-5@high"], [5, 5, "?"]]);
  const added = Object.fromEntries(Object.entries(f.added).map(([i, n]) => [name(Number(i)), n]));
  assert.deepEqual(added, { "a:claude/claude-opus-5-5@high": 2, "?": 1 });

  writeNote(root, note);
  const back = readNote(root, "HEAD")!;
  assert.equal(back.commit, note.commit);
  assert.match(summarize(back), /^67% claude\/claude-opus-5-5@high, 33% unrecorded \(3 lines\)$/);
  store.close();
});

test("commit note credits unwatched edits to the human when disk matches the commit", () => {
  const root = mkdtempSync(join(tmpdir(), "prov-notes-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@x.io");
  git(root, "config", "user.name", "T");
  writeFileSync(join(root, "b.ts"), "a\n");
  git(root, "add", "b.ts");
  git(root, "commit", "-qm", "base");
  const store = new Store(root);
  const me = store.human("me");
  store.baseline("b.ts", "a\n", me);
  writeFileSync(join(root, "b.ts"), "a\nb\n"); // edited with nothing watching
  git(root, "commit", "-qam", "edit");
  const note = buildNote(store, root, "HEAD", me)!;
  assert.equal(summarize(note), "100% me (1 line)");
  store.close();
});
