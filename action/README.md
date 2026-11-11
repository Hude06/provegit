# prov GitHub Action

Comments on each pull request with who wrote its added lines (you, Claude Code, Codex, OpenCode…), and adds a check run whose inline notes mark agent-written lines in **Files changed**. Data comes from prov's git notes (`refs/notes/prov`), written by `prov` on each author's machine at commit time and pushed with `git push` (pre-push hook) or `prov notes push`.

```yaml
# .github/workflows/prov.yml   (or run: prov github init)
name: prov
on: pull_request
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
          fetch-depth: 0
      - uses: OWNER/provegit/action@main
```

PRs from forks get a read-only token, so the comment and check run are skipped there; the report still appears in the job summary.

Build: `cd cli && npm run build:action` → `action/dist/index.mjs` (single file, no dependencies).
