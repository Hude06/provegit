// prov GitHub Action — generated from cli/src/action.ts; do not edit

// src/action.ts
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

// src/report.ts
var MARKER = "<!-- prov-report -->";
var UNRECORDED = { id: "?", kind: "unknown" };
function parseNote(text) {
  if (!text) return void 0;
  for (const line of text.trim().split("\n").reverse()) {
    try {
      const n = JSON.parse(line);
      if (n?.v === 1 && n.files && Array.isArray(n.actors)) return n;
    } catch {
    }
  }
  return void 0;
}
function displayName(a) {
  if (a.kind === "unknown") return "not recorded";
  if (a.kind === "human") return a.id.replace(/^h:/, "");
  return [a.harness ?? a.id.replace(/^a:/, "").split("/")[0], a.model].filter(Boolean).join(" \xB7 ") + (a.effort ? ` (${a.effort})` : "");
}
function addedLines(patch) {
  const out = [];
  let n = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git")) {
      inHunk = false;
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      n = Number(h[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue;
    if (line[0] === "+") out.push(n++);
    else if (line[0] !== "-") n++;
  }
  return out;
}
function fileOwnership(commits, bySha, f) {
  let note;
  let reason;
  if (f.lastCommit && bySha.has(f.lastCommit)) {
    note = bySha.get(f.lastCommit).note;
    if (!note?.files[f.path]) {
      reason = `last changed in ${f.lastCommit.slice(0, 7)}, which has no prov note`;
      note = void 0;
    }
  } else {
    for (let i = commits.length - 1; i >= 0 && !note; i--) if (commits[i].note?.files[f.path]) note = commits[i].note;
    if (!note) reason = "no prov note covers this file";
  }
  return { note, nf: note?.files[f.path], reason };
}
function actorAt(note, nf, line) {
  if (!nf || !note) return UNRECORDED;
  for (const [a, b, i] of nf.owners) if (line >= a && line <= b) return note.actors[i] ?? UNRECORDED;
  return UNRECORDED;
}
function buildReport(commits, files) {
  const owners = /* @__PURE__ */ new Map();
  const own = (a) => {
    const key = a.kind === "unknown" ? "?" : a.id;
    if (!owners.has(key)) owners.set(key, { key, actor: a.kind === "unknown" ? UNRECORDED : a });
    return owners.get(key);
  };
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const totals = /* @__PURE__ */ new Map();
  const blocks = [];
  const fileReports = [];
  let added = 0;
  for (const f of files) {
    if (!f.added.length) continue;
    const { note, nf, reason } = fileOwnership(commits, bySha, f);
    const lineOwner = (line) => own(actorAt(note, nf, line));
    const by = /* @__PURE__ */ new Map();
    let cur;
    for (const line of [...f.added].sort((a, b) => a - b)) {
      const o = lineOwner(line);
      by.set(o.key, (by.get(o.key) ?? 0) + 1);
      totals.set(o.key, (totals.get(o.key) ?? 0) + 1);
      added++;
      if (cur && cur.owner.key === o.key && cur.end === line - 1) cur.end = line;
      else blocks.push(cur = { path: f.path, start: line, end: line, owner: o });
    }
    fileReports.push({ path: f.path, added: f.added.length, by, recorded: !!nf, reason });
  }
  const missingNotes = commits.filter((c) => !c.note).map((c) => c.sha);
  return { owners, totals, added, files: fileReports, blocks, commits: commits.length, notedCommits: commits.length - missingNotes.length, missingNotes };
}
var pct = (n, d) => d ? Math.round(n / d * 100) : 0;
var bar = (n, d, w = 12) => {
  const f = d ? Math.round(n / d * w) : 0;
  return "\u2588".repeat(f) + "\u2591".repeat(w - f);
};
var sorted = (m) => [...m].sort((a, b) => b[1] - a[1]);
var plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
function markdown(r, opts = {}) {
  const name = (k) => displayName(r.owners.get(k).actor);
  const out = [MARKER, "### Who wrote this PR"];
  if (!r.added) {
    out.push("", "This PR adds no lines.");
    return out.join("\n");
  }
  const top = sorted(r.totals);
  out.push("", `**${plural(r.added, "added line")}** across ${plural(r.files.length, "file")}: ` + top.map(([k, n]) => `${name(k)} ${pct(n, r.added)}%`).join(", "));
  out.push("", "| Author | Lines | Share |", "|---|---:|---|");
  for (const [k, n] of top) out.push(`| ${name(k)} | ${n} | \`${bar(n, r.added)}\` ${pct(n, r.added)}% |`);
  if (opts.viewUrl) out.push("", `**[See who wrote each line \u2192](${opts.viewUrl})**`);
  out.push("", "<details><summary>By file</summary>", "", "| File | Added | Written by |", "|---|---:|---|");
  for (const f of [...r.files].sort((a, b) => b.added - a.added)) {
    const who = f.recorded ? sorted(f.by).map(([k, n]) => `${name(k)} ${n}`).join(", ") : `not recorded (${f.reason})`;
    out.push(`| \`${f.path}\` | ${f.added} | ${who} |`);
  }
  out.push("", "</details>");
  if (r.missingNotes.length) {
    const shas = r.missingNotes.slice(0, 5).map((s) => `\`${s.slice(0, 7)}\``).join(", ");
    out.push(
      "",
      `${r.notedCommits} of ${plural(r.commits, "commit")} have prov notes. Missing: ${shas}${r.missingNotes.length > 5 ? " and more" : ""}. Commits made without prov, or notes not pushed yet (\`prov notes push\`).`
    );
  }
  out.push(
    "",
    `<sub>Line ownership recorded on the author's machine by ${opts.toolUrl ? `[prov](${opts.toolUrl})` : "prov"}; agent and model names are as reported by each agent's hooks.${opts.headSha ? ` Head ${opts.headSha.slice(0, 7)}.` : ""}</sub>`
  );
  return out.join("\n");
}
function annotations(r) {
  return r.blocks.map((b) => {
    const a = b.owner.actor;
    const n = b.end - b.start + 1;
    const lines = plural(n, "line");
    let message;
    if (a.kind === "agent") message = `${lines} written by ${a.harness ?? "an agent"}${a.model ? ` using ${a.model}` : ""}${a.effort ? ` at ${a.effort} effort` : ""}.`;
    else if (a.kind === "human") message = `${lines} written by ${displayName(a)}.`;
    else message = `${lines} not recorded by prov (made without prov running, or the commit's note wasn't pushed).`;
    return {
      path: b.path,
      start_line: b.start,
      end_line: b.end,
      annotation_level: "notice",
      title: a.kind === "unknown" ? "Not recorded" : `Written by ${displayName(a)}`,
      message
    };
  });
}

// src/ghpost.ts
function makeGh(base, token, userAgent) {
  return async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": userAgent,
        ...body ? { "content-type": "application/json" } : {}
      },
      body: body ? JSON.stringify(body) : void 0
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`GitHub ${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`), { status: res.status });
    return text ? JSON.parse(text) : void 0;
  };
}
async function upsertComment(gh, repo, pr, body, mine = () => true) {
  for (let page = 1; page <= 10; page++) {
    const list = await gh("GET", `/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    const found = list.find((c) => typeof c.body === "string" && c.body.startsWith(MARKER) && mine(c));
    if (found) {
      await gh("PATCH", `/repos/${repo}/issues/comments/${found.id}`, { body });
      return "updated PR comment";
    }
    if (list.length < 100) break;
  }
  await gh("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
  return "posted PR comment";
}
var CHECK_NAME = "prov: who wrote this";
async function postCheckRun(gh, repo, head, r, detailsUrl) {
  const anns = annotations(r).slice(0, 1e3);
  const agentLines = [...r.totals].filter(([k]) => r.owners.get(k).actor.kind === "agent").reduce((s, [, n]) => s + n, 0);
  const title = r.added ? `${Math.round(agentLines / r.added * 100)}% of ${r.added} added lines written by AI agents` : "No added lines";
  const summary = [...r.totals].sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${displayName(r.owners.get(k).actor)}: ${n}`).join("\n") || "No added lines.";
  const run = await gh("POST", `/repos/${repo}/check-runs`, {
    name: CHECK_NAME,
    head_sha: head,
    status: "completed",
    conclusion: "neutral",
    ...detailsUrl ? { details_url: detailsUrl } : {},
    output: { title, summary, annotations: anns.slice(0, 50) }
  });
  for (let i = 50; i < anns.length; i += 50) {
    await gh("PATCH", `/repos/${repo}/check-runs/${run.id}`, { output: { title, summary, annotations: anns.slice(i, i + 50) } });
  }
  return `check run with ${anns.length} annotation(s)`;
}

// src/action.ts
var NOTES_REF = "refs/notes/prov";
var env = process.env;
var input = (name, def = "") => (env[`INPUT_${name.toUpperCase().replace(/ /g, "_")}`] ?? def).trim();
var log = (s) => void process.stdout.write(s + "\n");
var warn = (s) => void process.stdout.write(`::warning::${s.replace(/\n/g, "%0A")}
`);
function git(args, opts = {}) {
  try {
    return execFileSync("git", args, { cwd: env.GITHUB_WORKSPACE || process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 });
  } catch (e) {
    if (opts.allowFail) return "";
    throw new Error(`git ${args.join(" ")} failed: ${e.stderr ?? e}`);
  }
}
function collect(base, head) {
  const mb = git(["merge-base", base, head]).trim();
  const shas = git(["rev-list", "--reverse", "--no-merges", `${mb}..${head}`]).split("\n").filter(Boolean);
  const commits = shas.map((sha) => ({ sha, note: parseNote(git(["notes", `--ref=${NOTES_REF}`, "show", sha], { allowFail: true })) }));
  const diff = git(["diff", "--no-color", "--no-ext-diff", "-U0", "-M", mb, head]);
  const files = [];
  for (const chunk of diff.split(/^(?=diff --git )/m)) {
    const path = /^\+\+\+ b\/(.+)$/m.exec(chunk)?.[1];
    if (!path) continue;
    const added = addedLines(chunk);
    if (!added.length) continue;
    const lastCommit = git(["log", "-1", "--no-merges", "--format=%H", `${mb}..${head}`, "--", path]).trim() || void 0;
    files.push({ path, added, lastCommit });
  }
  return { commits, files };
}
async function main() {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const pr = event.pull_request;
  if (!pr) return log("prov: not a pull_request event \u2014 nothing to do");
  const repo = env.GITHUB_REPOSITORY;
  const base = pr.base.sha, head = pr.head.sha;
  git(["fetch", "--no-tags", "origin", `+${NOTES_REF}:${NOTES_REF}`], { allowFail: true });
  if (!git(["cat-file", "-t", base], { allowFail: true }) || !git(["merge-base", base, head], { allowFail: true })) {
    git(["fetch", "--no-tags", "--unshallow", "origin"], { allowFail: true });
    git(["fetch", "--no-tags", "origin", base, head], { allowFail: true });
  }
  let { commits, files } = collect(base, head);
  for (let i = 0; i < 6 && commits.some((c) => !c.note); i++) {
    await new Promise((r) => setTimeout(r, 5e3));
    git(["fetch", "--no-tags", "origin", `+${NOTES_REF}:${NOTES_REF}`], { allowFail: true });
    ({ commits, files } = collect(base, head));
  }
  const report = buildReport(commits, files);
  const body = markdown(report, { headSha: head, toolUrl: input("tool-url") || void 0 });
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, body.replace(MARKER, "") + "\n");
  log(`prov: ${report.added} added lines, ${report.notedCommits}/${report.commits} commits with notes`);
  if (!report.notedCommits && report.commits) warn("No prov notes found for this PR's commits. Run `prov init` locally and push notes (`prov notes push`).");
  const fromFork = pr.head.repo?.full_name && pr.head.repo.full_name !== repo;
  const gh = makeGh(env.GITHUB_API_URL || "https://api.github.com", input("token") || env.GITHUB_TOKEN || "", "prov-action");
  const mine = (c) => c.user?.login === "github-actions[bot]" || !c.performed_via_github_app;
  const tasks = [];
  if (input("comment", "true") !== "false") tasks.push(["comment", () => upsertComment(gh, repo, pr.number, body, mine)]);
  if (input("annotations", "true") !== "false") tasks.push(["check run", () => postCheckRun(gh, repo, head, report)]);
  for (const [name, run] of tasks) {
    try {
      log(`prov: ${await run()}`);
    } catch (e) {
      if (e.status === 403 || e.status === 404) warn(`prov: couldn't write the ${name}${fromFork ? " (PR from a fork: the token is read-only)" : " \u2014 check the workflow's permissions"}. The report is in the job summary.`);
      else throw e;
    }
  }
}
if (env.GITHUB_ACTIONS) {
  main().catch((e) => {
    process.stdout.write(`::error::${String(e?.message ?? e).replace(/\n/g, "%0A")}
`);
    process.exit(1);
  });
}
export {
  collect
};
