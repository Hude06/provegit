import { annotations, displayName, MARKER, Report } from "./report.js";

/** Minimal GitHub REST caller: (method, path, body?) → parsed JSON. Throws errors with `.status`. */
export type Gh = (method: string, path: string, body?: unknown) => Promise<any>;

export function makeGh(base: string, token: string, userAgent: string): Gh {
  return async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": userAgent,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`GitHub ${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`), { status: res.status });
    return text ? JSON.parse(text) : undefined;
  };
}

/** Keep one report comment per PR: edit ours if present, else post. `mine` tells our comment apart from another poster's. */
export async function upsertComment(gh: Gh, repo: string, pr: number, body: string, mine: (c: any) => boolean = () => true): Promise<string> {
  for (let page = 1; page <= 10; page++) {
    const list = await gh("GET", `/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    const found = list.find((c: any) => typeof c.body === "string" && c.body.startsWith(MARKER) && mine(c));
    if (found) {
      await gh("PATCH", `/repos/${repo}/issues/comments/${found.id}`, { body });
      return "updated PR comment";
    }
    if (list.length < 100) break;
  }
  await gh("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
  return "posted PR comment";
}

export const CHECK_NAME = "prov: who wrote this";

/** Completed, neutral check run whose annotations mark agent-written blocks (API limit: 50 per request). */
export async function postCheckRun(gh: Gh, repo: string, head: string, r: Report): Promise<string> {
  const anns = annotations(r).slice(0, 1000);
  const agentLines = [...r.totals].filter(([k]) => r.owners.get(k)!.actor.kind === "agent").reduce((s, [, n]) => s + n, 0);
  const title = r.added ? `${Math.round((agentLines / r.added) * 100)}% of ${r.added} added lines written by AI agents` : "No added lines";
  const summary = [...r.totals].sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${displayName(r.owners.get(k)!.actor)}: ${n}`).join("\n") || "No added lines.";
  const run = await gh("POST", `/repos/${repo}/check-runs`, {
    name: CHECK_NAME,
    head_sha: head,
    status: "completed",
    conclusion: "neutral",
    output: { title, summary, annotations: anns.slice(0, 50) },
  });
  for (let i = 50; i < anns.length; i += 50) {
    await gh("PATCH", `/repos/${repo}/check-runs/${run.id}`, { output: { title, summary, annotations: anns.slice(i, i + 50) } });
  }
  return `check run with ${anns.length} annotation(s)`;
}
