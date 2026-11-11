import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_ACTION = process.env.PROV_ACTION ?? "Hude06/provegit/action@main";

export function workflowYaml(uses: string): string {
  return `# Added by \`prov github init\`. On each pull request: a comment with who wrote the added lines,
# and a check run whose inline notes mark lines written by AI agents in "Files changed".
name: prov
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
  checks: write
jobs:
  prov:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the PR's full history, so every commit's note can be read
      - uses: ${uses}
`;
}

export function githubInit(root: string, uses = DEFAULT_ACTION): string {
  const dir = join(root, ".github", "workflows");
  const file = join(dir, "prov.yml");
  if (existsSync(file)) return `${file} already exists — left unchanged`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, workflowYaml(uses));
  return `wrote ${file} (uses ${uses}) — commit it, push, and open a PR`;
}
