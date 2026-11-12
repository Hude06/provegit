# MVP plan · kill test · next actions

## MVP (2 engineers, ~6 weeks)
1. **Recorder CLI** — hooks: Claude Code `PostToolUse`/edit hooks + Codex/Cursor equivalents → append-only JSONL: `{ts, file, patch, agent, model, tokens_in/out, cost, session_id, user}`. No LLM calls → immune to model churn.
2. **Index + blame** — SQLite session DB; recorded-patch replay yields `prov blame <file>`: per-line authorship (human | agent+model+session), survives rebase/squash.
3. **GitHub App** — PR annotation: "68 lines: Claude Sonnet (session #a1b2) · 12 lines human-edited · est. $X spend"; org dashboard: % AI-authored per repo/author/model, cost chargebacks.
4. **Certificate** — signed JSON + PDF: authorship, model, session, cost, timestamp at merge; EU-disclosure one-liner for prose.
5. **Free tier** — OSS repos: local recording + PR annotations free; paid: org dashboard + certificates + self-hosted.

Stack: TypeScript (hooks ecosystem), SQLite, no model APIs. Demo repo with 3 agents collaborating = the pitch.

## Locked decisions (2026-11-10)
- Ownership rule: **flip to last editor** — human touching agent chars reclaims them; `prov claim` for manual fixes.
- Storage: local `.prov/prov.db` (SQLite) — append-only events + per-file owner-runs `[(len, owner_id)]`; content-keyed, never inline file metadata.
- Attribution: change inside agent session window (time+path, TTL) → that agent; else `h:<git identity>` device-linked account.
- Envelope v1: every event logs `{harness, harness_ver, model, effort, entry, session_id, turn_id}` — e.g. `a:claude-code/fable5@extra-high`. Codex: payload `model` + `model_reasoning_effort`; Claude Code: transcript JSONL; Grok: `model: unknown` (honest gap).
- Sync privacy: **upload full patches** (encrypted at rest) → server replays vs commit SHAs; GitHub App PR overlay for teammates; `prov login` device-flow OAuth; `prov sync` manual + post-push hook.
- Hooks verified: Codex `~/.codex/hooks.json` `PostToolUse` (patch in `tool_input.command`, `model`, `PostModelRequest.token_usage`); Claude Code `PostToolUse` `Edit|Write`; OpenCode plugin `tool.execute.before/after` + `chat.message`/`chat.params` for model/variant (verified vs @opencode-ai/plugin 1.3.15, 2026-11-10); Pi extensions; T3 Code inherits Codex; Grok CLI watcher-only.

## MVP status (built 2026-11-10, `cli/`)
- [x] Recorder+watcher+reconciler: `prov init` (baseline to human, `--hooks` installs adapters), `prov watch` (chokidar + session-window attribution)
- [x] Owner-run resolver + char diff (diff-match-patch): `prov <file>` %, `prov blame` overlay, `prov stats`, `prov claim`
- [x] Hook entrypoints: `prov hook claude|codex|opencode` — Pre opens session window, Post records the edit directly (no `prov watch` needed for agent edits); no-op in repos without `prov init`; subagents keyed `session:agent_id` with model from `<session>/subagents/agent-<id>.jsonl`
- [x] `prov install|uninstall` — Claude Code `settings.json`, Codex `hooks.json` (Pre+PostToolUse, `# prov-hook` marker, foreign hooks kept, invalid JSON never overwritten), OpenCode `~/.config/opencode/plugins/prov.js`; live-verified 2026-11-10 (`claude -p` → `agent:claude/claude-haiku-5-5@medium`)
- [x] `prov login` GitHub OAuth **device flow** (browser confirm + code, terminal poll) → `~/.prov/credentials.json` 0600, login used as `h:` identity; `prov whoami`, `prov logout` (best-effort server revoke)
- [x] `prov sync --server URL` (HTTPS enforced, localhost exception; Bearer token) — batches events with patches since cursor; server replays patch chain, verifies sha256 vs snapshot, rejects tampered chains
- [x] `prov serve [--port]` — local ingest/replay-verify demo endpoint
- [x] `prov ui` (2026-11-10) — local diff viewer at 127.0.0.1:8718 (runs watcher too): Changes vs any ref, inserted chars painted in author's ink (human graphite, Claude violet, Codex teal, OpenCode amber; model = shade), intra-line deletions, live Timeline of every edit + per-edit diff, author focus filter. Files: `cli/src/ui.ts`, `cli/ui/index.html`
- [x] Commit link (2026-11-10): post-commit hook → `prov note` writes per-commit JSON note on `refs/notes/prov` (line owners per changed file + lines added per actor); `prov log`, `prov notes push` (fetch+merge `-s ours`+push); `notes.rewriteRef` + `rewriteMode=ignore` (amend keeps fresh note, rebase copies original). Unwatched edits credited to human when disk == commit; partial staging → `?` unrecorded. Code: `cli/src/notes.ts`
- [x] GitHub Action (2026-11-11): `action/` (node24, single-file bundle from `cli/src/action.ts`) → sticky PR comment + neutral Check Run, annotations on agent-written blocks; report engine `cli/src/report.ts` shared with App. `prov github init` writes `.github/workflows/prov.yml`. Live-verified on private `Hude06/prov-action-test` PR #1.
- [x] pre-push hook pushes notes in background after `git push` exits (back-to-back pushes → GitHub intermittent `remote rejected (failed)`, verified 1/3 → 0/5); Action/App re-check for trailing notes.
- [x] GitHub App code (2026-11-11): Cloudflare Worker `app/` (webhook HMAC verify, RS256 app JWT incl. PKCS#1→PKCS#8, installation token, notes via git data API, fork head-repo notes) + `app/scripts/register.mjs` manifest flow → wrangler secrets. Mock-GitHub test passes.
- [x] App live (2026-11-11): Worker https://prov-github-app.prov-github-app.workers.dev, GitHub App `prov-who-wrote-this` (id 5719868, installed on all Hude06 repos); PR comment + check run verified on prov-action-test PR #1. Creds: `app/.prov-app.json` (gitignored) + Worker secrets
- [x] PR line view (2026-11-11): check run notes every block (agents, people, unrecorded). Worker `/pr/:owner/:repo/:n` = GitHub-style diff + blame column (`app/public/pr.html`, data `app/src/prview.ts`); GitHub sign-in (`app/src/session.ts`, AES-GCM cookie, viewer token for all reads, strict CSP). Linked from comment + check "Details". SESSION_KEY set
- [ ] User: App settings → Callback URL `…workers.dev/auth/callback` + generate client secret → `pbpaste | npx wrangler secret put CLIENT_SECRET`
- [ ] Action + App both on a repo = two identical comments/checks → pick one per repo (App preferred; drop workflow)
- [ ] Publish action: public repo so others can `uses:` it (currently `uses: ./action` in test repo)
- [ ] GitHub App PR overlay + certificate (needs hosted server + app registration)
- Client IDs: public device-flow client_id via `PROV_GITHUB_CLIENT_ID`, `~/.prov/credentials.json clientId`, or `--client-id` (no secret stored locally).
- Note: node:sqlite used (no native deps; node ≥22.13); node 26 prebuilds absent for better-sqlite3.
- Review fixes 2026-11-10: device-flow grant type (login was broken), incremental sync (server keeps per-repo state, 409 → full resend), replay must consume whole file, semantic char diff, chokidar v4 ignores, sqlite busy_timeout + tx, repo id = origin URL not local path, cwd-relative file args. `npm test` = 10 tests.
- [ ] Legacy DB rows (pre-fix `claim` patches `[[0,content]]`) can fail full-chain replay → `prov init --force` to rebaseline.

## Distribution to first 100
- Show HN into the primed audience: threads 46597023 (58p), 49232300 (54p), 50246778 (9p).
- GitHub App installs on OSS repos drowning in AI PRs (the "Vibe coding kills open source" 330p crowd) — free tier = zero-friction install; star/install count is the traction metric.
- EU-disclosure writers/publishers: certificate is the deliverable their rule demands.
- FinOps/engineering orgs: agent-cost chargeback view sells to teams already paying Semgrep-style plans.

## Kill test (pre-registered, honest)
- **60-day test:** if GitHub App installs < 200 across OSS repos AND no org contacts support asking for attribution/cost/authorization answers → downgrade to runner-up (audit-certificate framing) rather than sunk-cost.
- Demand check monthly: watch for first "I need to buy this" post; today there is none — this is the top risk.

## Open tasks
- [x] Name: `proveGIT` — npm `provegit`/`provgit` free, `provegit.com`/`provgit.com` unregistered, GitHub matches hobby-only (verified 2026-11-10). CLI binary: `prov`. Trademark search still open.
- [x] Pull actual EU text-provenance rule text — Article 50 marking requirement confirmed via ai-act-service-desk + openai.com/index/eu-text-provenance (verified 2026-11-10).
- [x] Confirm hook APIs today: Codex CLI lifecycle hooks + payload schema verified; Claude Code hooks verified; Cursor not relevant — target set is Claude Code/Codex/OpenCode/Pi/T3/Grok (verified 2026-11-10). OpenCode events resolved (see Hooks verified).
- [ ] Monitor absorption weekly: Semgrep Guardian expansion, Anthropic/OpenAI attribution features (moat watchlist in report).
- [ ] Reddit evidence (r/git, r/ExplainLikeImCalibration blocked) — retry with proper UA.
