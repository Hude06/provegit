/**
 * GitHub Action entrypoint (bundled to action/dist/index.js). Runs on pull_request:
 * reads prov notes for the PR's commits from refs/notes/prov, works out who wrote each added line,
 * then writes a sticky PR comment, a Check Run with inline annotations, and the job summary.
 * No dependencies: git + fetch only.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { addedLines, buildReport, markdown, MARKER, parseNote, PrCommit, PrFile } from "./report.js";
import { Gh, makeGh, postCheckRun, upsertComment } from "./ghpost.js";

const NOTES_REF = "refs/notes/prov";
const env = process.env;
const input = (name: string, def = "") => (env[`INPUT_${name.toUpperCase().replace(/ /g, "_")}`] ?? def).trim();
const log = (s: string): void => void process.stdout.write(s + "\n");
const warn = (s: string): void => void process.stdout.write(`::warning::${s.replace(/\n/g, "%0A")}\n`);

function git(args: string[], opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync("git", args, { cwd: env.GITHUB_WORKSPACE || process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 });
  } catch (e) {
    if (opts.allowFail) return "";
    throw new Error(`git ${args.join(" ")} failed: ${(e as any).stderr ?? e}`);
  }
}

/** Collect report inputs from the checked-out repo. */
export function collect(base: string, head: string): { commits: PrCommit[]; files: PrFile[] } {
  const mb = git(["merge-base", base, head]).trim();
  const shas = git(["rev-list", "--reverse", "--no-merges", `${mb}..${head}`]).split("\n").filter(Boolean);
  const commits = shas.map((sha) => ({ sha, note: parseNote(git(["notes", `--ref=${NOTES_REF}`, "show", sha], { allowFail: true })) }));
  const diff = git(["diff", "--no-color", "--no-ext-diff", "-U0", "-M", mb, head]);
  const files: PrFile[] = [];
  for (const chunk of diff.split(/^(?=diff --git )/m)) {
    const path = /^\+\+\+ b\/(.+)$/m.exec(chunk)?.[1];
    if (!path) continue; // deleted or binary
    const added = addedLines(chunk);
    if (!added.length) continue;
    const lastCommit = git(["log", "-1", "--no-merges", "--format=%H", `${mb}..${head}`, "--", path]).trim() || undefined;
    files.push({ path, added, lastCommit });
  }
  return { commits, files };
}

async function main(): Promise<void> {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH!, "utf8"));
  const pr = event.pull_request;
  if (!pr) return log("prov: not a pull_request event — nothing to do");
  const repo = env.GITHUB_REPOSITORY!;
  const base = pr.base.sha, head = pr.head.sha;

  // Notes + both ends of the PR (works with fetch-depth: 0; tries to deepen otherwise).
  git(["fetch", "--no-tags", "origin", `+${NOTES_REF}:${NOTES_REF}`], { allowFail: true });
  if (!git(["cat-file", "-t", base], { allowFail: true }) || !git(["merge-base", base, head], { allowFail: true })) {
    git(["fetch", "--no-tags", "--unshallow", "origin"], { allowFail: true });
    git(["fetch", "--no-tags", "origin", base, head], { allowFail: true });
  }

  // pre-push sends notes just after the branch push, so they can trail the PR event by a few seconds.
  let { commits, files } = collect(base, head);
  for (let i = 0; i < 6 && commits.some((c) => !c.note); i++) {
    await new Promise((r) => setTimeout(r, 5000));
    git(["fetch", "--no-tags", "origin", `+${NOTES_REF}:${NOTES_REF}`], { allowFail: true });
    ({ commits, files } = collect(base, head));
  }
  const report = buildReport(commits, files);
  const body = markdown(report, { headSha: head, toolUrl: input("tool-url") || undefined });
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, body.replace(MARKER, "") + "\n");
  log(`prov: ${report.added} added lines, ${report.notedCommits}/${report.commits} commits with notes`);
  if (!report.notedCommits && report.commits) warn("No prov notes found for this PR's commits. Run `prov init` locally and push notes (`prov notes push`).");

  const fromFork = pr.head.repo?.full_name && pr.head.repo.full_name !== repo;
  const gh: Gh = makeGh(env.GITHUB_API_URL || "https://api.github.com", input("token") || env.GITHUB_TOKEN || "", "prov-action");
  // Only edit a report comment this workflow's bot posted (the prov GitHub App may have its own).
  const mine = (c: any) => c.user?.login === "github-actions[bot]" || !c.performed_via_github_app;
  const tasks: [string, () => Promise<string>][] = [];
  if (input("comment", "true") !== "false") tasks.push(["comment", () => upsertComment(gh, repo, pr.number, body, mine)]);
  if (input("annotations", "true") !== "false") tasks.push(["check run", () => postCheckRun(gh, repo, head, report)]);
  for (const [name, run] of tasks) {
    try {
      log(`prov: ${await run()}`);
    } catch (e: any) {
      // Fork PRs get a read-only token: the job summary above still has the report.
      if (e.status === 403 || e.status === 404) warn(`prov: couldn't write the ${name}${fromFork ? " (PR from a fork: the token is read-only)" : " — check the workflow's permissions"}. The report is in the job summary.`);
      else throw e;
    }
  }
}

if (env.GITHUB_ACTIONS) {
  main().catch((e) => {
    process.stdout.write(`::error::${String(e?.message ?? e).replace(/\n/g, "%0A")}\n`);
    process.exit(1);
  });
}
