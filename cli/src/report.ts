import type { Note, NoteActor } from "./notes.js";

/**
 * PR report engine, shared by the GitHub Action (inputs from git) and the GitHub App (inputs from the API).
 * Pure: no git, no network. Given the PR's commits (oldest → newest) with their prov notes, and the lines the
 * PR adds per file (head line numbers), works out who wrote each added line.
 */
export type PrCommit = { sha: string; note?: Note };
export type PrFile = {
  path: string;
  /** Head-side line numbers this PR adds. */
  added: number[];
  /** Newest non-merge commit in the PR that changed this file, if known. Its note must cover the file. */
  lastCommit?: string;
};
export type Owner = { key: string; actor: NoteActor };
export type Block = { path: string; start: number; end: number; owner: Owner };
export type FileReport = { path: string; added: number; by: Map<string, number>; recorded: boolean; reason?: string };
export type Report = {
  owners: Map<string, Owner>;
  totals: Map<string, number>;
  added: number;
  files: FileReport[];
  blocks: Block[];
  commits: number;
  notedCommits: number;
  missingNotes: string[];
};

export const MARKER = "<!-- prov-report -->";
const UNRECORDED: NoteActor = { id: "?", kind: "unknown" };

/** Parse a note blob (newest valid JSON line wins; tolerates concatenated notes). */
export function parseNote(text: string | undefined): Note | undefined {
  if (!text) return undefined;
  for (const line of text.trim().split("\n").reverse()) {
    try {
      const n = JSON.parse(line);
      if (n?.v === 1 && n.files && Array.isArray(n.actors)) return n;
    } catch {}
  }
  return undefined;
}

export function displayName(a: NoteActor): string {
  if (a.kind === "unknown") return "not recorded";
  if (a.kind === "human") return a.id.replace(/^h:/, "");
  return [a.harness ?? a.id.replace(/^a:/, "").split("/")[0], a.model].filter(Boolean).join(" · ") + (a.effort ? ` (${a.effort})` : "");
}

/** Added-line numbers per file from `git diff -U0` / a GitHub `patch` (head side). */
export function addedLines(patch: string): number[] {
  const out: number[] = [];
  let n = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git")) {
      inHunk = false; // file headers (---/+++) follow; only @@ re-enters a hunk
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      n = Number(h[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line[0] === "+") out.push(n++);
    else if (line[0] !== "-") n++; // context line
  }
  return out;
}

export function buildReport(commits: PrCommit[], files: PrFile[]): Report {
  const owners = new Map<string, Owner>();
  const own = (a: NoteActor): Owner => {
    const key = a.kind === "unknown" ? "?" : a.id;
    if (!owners.has(key)) owners.set(key, { key, actor: a.kind === "unknown" ? UNRECORDED : a });
    return owners.get(key)!;
  };
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const totals = new Map<string, number>();
  const blocks: Block[] = [];
  const fileReports: FileReport[] = [];
  let added = 0;

  for (const f of files) {
    if (!f.added.length) continue;
    // Ownership at head = the newest PR commit whose note covers this file.
    let note: Note | undefined;
    let reason: string | undefined;
    if (f.lastCommit && bySha.has(f.lastCommit)) {
      note = bySha.get(f.lastCommit)!.note;
      if (!note?.files[f.path]) {
        reason = `last changed in ${f.lastCommit.slice(0, 7)}, which has no prov note`;
        note = undefined;
      }
    } else {
      for (let i = commits.length - 1; i >= 0 && !note; i--) if (commits[i].note?.files[f.path]) note = commits[i].note;
      if (!note) reason = "no prov note covers this file";
    }
    const nf = note?.files[f.path];
    const lineOwner = (line: number): Owner => {
      if (!nf || !note) return own(UNRECORDED);
      for (const [a, b, i] of nf.owners) if (line >= a && line <= b) return own(note.actors[i] ?? UNRECORDED);
      return own(UNRECORDED);
    };
    const by = new Map<string, number>();
    let cur: Block | undefined;
    for (const line of [...f.added].sort((a, b) => a - b)) {
      const o = lineOwner(line);
      by.set(o.key, (by.get(o.key) ?? 0) + 1);
      totals.set(o.key, (totals.get(o.key) ?? 0) + 1);
      added++;
      if (cur && cur.owner.key === o.key && cur.end === line - 1) cur.end = line;
      else blocks.push((cur = { path: f.path, start: line, end: line, owner: o }));
    }
    fileReports.push({ path: f.path, added: f.added.length, by, recorded: !!nf, reason });
  }
  const missingNotes = commits.filter((c) => !c.note).map((c) => c.sha);
  return { owners, totals, added, files: fileReports, blocks, commits: commits.length, notedCommits: commits.length - missingNotes.length, missingNotes };
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
const bar = (n: number, d: number, w = 12) => {
  const f = d ? Math.round((n / d) * w) : 0;
  return "█".repeat(f) + "░".repeat(w - f);
};
const sorted = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Sticky PR comment / job summary body. */
export function markdown(r: Report, opts: { headSha?: string; toolUrl?: string } = {}): string {
  const name = (k: string) => displayName(r.owners.get(k)!.actor);
  const out: string[] = [MARKER, "### Who wrote this PR"];
  if (!r.added) {
    out.push("", "This PR adds no lines.");
    return out.join("\n");
  }
  const top = sorted(r.totals);
  out.push("", `**${plural(r.added, "added line")}** across ${plural(r.files.length, "file")}: ` + top.map(([k, n]) => `${name(k)} ${pct(n, r.added)}%`).join(", "));
  out.push("", "| Author | Lines | Share |", "|---|---:|---|");
  for (const [k, n] of top) out.push(`| ${name(k)} | ${n} | \`${bar(n, r.added)}\` ${pct(n, r.added)}% |`);
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
      `${r.notedCommits} of ${plural(r.commits, "commit")} have prov notes. Missing: ${shas}${r.missingNotes.length > 5 ? " and more" : ""}. ` +
        "Commits made without prov, or notes not pushed yet (`prov notes push`)."
    );
  }
  out.push(
    "",
    `<sub>Line ownership recorded on the author's machine by ${opts.toolUrl ? `[prov](${opts.toolUrl})` : "prov"}; agent and model names are as reported by each agent's hooks.${opts.headSha ? ` Head ${opts.headSha.slice(0, 7)}.` : ""}</sub>`
  );
  return out.join("\n");
}

export type Annotation = { path: string; start_line: number; end_line: number; annotation_level: "notice"; title: string; message: string };

/** Check Run annotations: one per block of lines written by an AI agent. */
export function annotations(r: Report): Annotation[] {
  return r.blocks
    .filter((b) => b.owner.actor.kind === "agent")
    .map((b) => {
      const a = b.owner.actor;
      const n = b.end - b.start + 1;
      return {
        path: b.path,
        start_line: b.start,
        end_line: b.end,
        annotation_level: "notice" as const,
        title: `Written by ${displayName(a)}`,
        message: `${plural(n, "line")} written by ${a.harness ?? "an agent"}${a.model ? ` using ${a.model}` : ""}${a.effort ? ` at ${a.effort} effort` : ""}.`,
      };
    });
}
