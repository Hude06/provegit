# Report: AI Code Provenance (proveGIT) — 2026-11-10

## TL;DR
Build a neutral, cross-vendor **provenance layer for AI-written code and text**. Records which lines came from which human, agent, model, and session — with per-line cost and signed certificates. Demand is voiced in community, motive is legal/compliance (survives model generations), commercial supply is ~zero, and an adjacent market (Semgrep's AI-native plans, $30/seat/mo) proves willingness to pay. MVP: 2 people, ~6 weeks.

## Product spec
1. **Record** — hooks into Claude Code / Codex CLI / Cursor agent sessions (PostToolUse/edit hooks). Captures every edit: file, diff, agent, model, tokens, cost, timestamp, session id.
2. **Index** — append-only local store; `prov blame` CLI: line-level authorship (human vs agent+model), surviving rebase/squash via recorded patches.
3. **Publish** — GitHub App: PR annotations ("68 lines: Claude Sonnet 4.5 session #a1b2 · 12 lines human-edited"), org dashboard, per-line cost rollups.
4. **Certify** — signed provenance certificate (JSON + PDF) for compliance/legal review: who/what/when/model at merge time.
5. **Text mode** — same engine for prose (EU text-provenance rules: disclose AI usage) — diff-based line-level human/AI split.

## Exact target customer
- Teams shipping AI-written code who must **answer "who wrote this, with what model, at what cost"**: OSS maintainers drowning in AI PRs, enterprises with copyright/compliance review, publishers/writers under EU text-provenance disclosure rules, engineering orgs budgeting agent spend.
- Where they gather: `Provenance Is the New Version Control` thread (news.ycombinator.com/item?id=46597023), the 54p provenance-tool thread (id=49232300), r/git, r/programming, OSS maintainer mailing lists, EU-rule compliance teams.

## Evidence of the problem (all links in sources.md; every item verified via HN/Algolia today)
**Voiced demand:**
- "Provenance Is the New Version Control" — 58p, 2026-01-13 (id=46597023)
- "Human vs. AI – Diff-based line-level provenance for text under agentic editing" — 54p, 2026-08-09 (id=49232300) — proof-of-concept exists, no product
- "Our approach to EU text provenance rules" — 72p, 2026-10-05 (id=49966293) — regulatory motive is live
- "Compaction Laundering: Provenance Destruction in Context-Compacting Coding Agent" — 9p, 2026-10-26 (id=50246778) — agents actively destroy provenance today
**Background pain (attribution crisis around AI code):**
- "AI usage generates a fragile codebase" — 316p, 2026-11-10 (id=50438318)
- "After two years of vibecoding, I'm back to writing by hand" — 865p (id=46765460); "Vibe coding kills open source" — 330p (id=46765120); vibe-coding meta wave 787p/616p/434p/405p
- Institutional AI-provenance incidents: US Military hallucinated intelligence report 519p (id=49757520); Home Office used AI-hallucinated info to refuse asylum claim, judge 24p (id=49085998); Ga. court order with AI-hallucinated cases 21p (id=47480219); arXiv 1-year ban for hallucinated references 659p (id=48140922)

## Market size (bottom-up; assumptions labeled — no sourced stat exists)
- Assume 500k–1M developers use agent tooling daily by 2026 (judgment; labeled assumption, not a sourced stat).
- Orgs with a legal/compliance/budget reason to demand attribution: assume 5,000 (legal review, EU disclosure, OSS gatekeeping, agent-cost chargebacks).
- WTP ~1% in year 1 → 50 paying orgs × ~10 seats × $25/mo = **$150k/mo ≈ $1.8M/yr** at steady state; first 100 customers ≈ $30k/mo. Comparable evidence (live, verified today): Semgrep Teams = $30/mo per contributor; Sourcegraph Enterprise starts at $16K/yr org contract.
- Honest note: no one has measured this market; it's a greenfield inference. That's the top risk.

## Why now
- Agent usage is at peak (front page 2026-11-10: "AI usage generates a fragile codebase" 316p; Claude Sheets/Whiteboards/Data launched — labs pushing agent workflows into docs/data).
- EU text-provenance disclosure rules are circulating (72p post, 2026-10-05); institutions are getting burned by unverifiable AI output (military, Home Office, courts, arXiv policy).
- Context-compaction in agents destroys history *now* (compaction-laundering post) — the longer teams wait, the more history is lost. Recording is retro-impossible.

## Why original (disproof attempts run)
- GitHub repo search (`provenance`+`attribution`+`AI`, created >2025): **0 results** (verified today; API caps apply).
- HN: adjacent OSS experiments exist (54p tool, 9p post) but **no hosted product, no pricing, no GitHub App** found across 12+ search vectors.
- Nearest competitors: **Semgrep Guardian** (verified live: "Scan and fix AI-generated code the moment it's written" — security scanning, *not* attribution/authorship), Sourcegraph (code intelligence, no line attribution), GitHub Copilot chat-tracking (private, single-vendor, not cross-agent blame).
- Frontier-absorption check: Claude Sheets/Whiteboards/Data, AlphaProof, Apple local-AI Mac app are live — labs absorb their own surfaces; none is a neutral cross-vendor attribution auditor.

## MVP (weeks, not months)
1. Week 1: recorder CLI — Claude Code + Codex hooks → append-only JSONL (edit diffs, model, tokens, cost).
2. Weeks 2–3: SQLite index + `prov blame` overlay + local web viewer (session scrub).
3. Week 4: GitHub App — PR annotations + org dashboard (per-line cost by model).
4. Week 5: certificate export (JSON/PDF) + EU disclosure one-liner ("This text: 40% AI (GPT-x), disclosed").
5. Week 6: Show HN + OSS free tier. Team: 2 engineers. No model calls needed core (pure bookkeeping) → **model-generation-proof**.

## First 100 customers
- Post in provenance threads + Show HN (audience already primed; 58p/54p threads = the watering hole).
- GitHub App installs on OSS repos with heavy AI PR volume ("Vibe coding kills open source" 330p maintainers = the desperate segment; free tier removes pricing friction, paid seats later).
- EU-disclosure publishers: certificate is the deliverable they're asked for by rule.
- Enterprise: agent-cost chargeback view sells to FinOps teams first (they already pay Semgrep-style per-seat plans).

## Top risks (skeptical pass)
1. **WTP inferred, not volunteered** — nobody has posted "I need to buy a provenance tool." Provenance traction is discussion-level (58p/54p). Mitigation: free GitHub App tier; sell the certificate as the paid artifact.
2. **Absorption**: Semgrep already brands "Code security for builders and agents" and ships agent plugins; frontier labs ship telemetry. Moat = neutral, cross-vendor, blame-grade authorship + certificates. If a lab ships cross-vendor blame, pivot to compliance-cert framing (runner-up idea).
3. **Engineering hard spot**: blame correctness across rebase/squash — mitigate with recorded-patch replay, not naive blame.
4. **Privacy**: session logs contain proprietary code — self-host/local-first default (Semgrep's own privacy FAQ shows this is a real buyer concern).
5. **Name**: `proveGIT` (decided 2026-11-10) — npm `provegit`/`provgit` free, `.com` domains unregistered, GitHub `provegit` matches are hobby repos only (all verified today); trademark search still pending. CLI binary: `prov`.

## Runners-up and why they lost (details in candidates.md)
1. **Agent-session audit/forensics service** — real incidents (military 519p, Home Office 24p, arXiv 659p) but audit Show HNs drew only 3–11p, audit fatigue is live ("Glasswing Overwhelms Maintainers" 13p; "Delve AI Audit Fraud" 11p), and Semgrep Guardian absorbs write-time AI-code auditing. Lost to provenance on traction. Salvaged as proveGIT's certificate module.
2. **LLM token-cost meter/chargeback** — saturated: ≥5 Show HN proxies/calculators (AgentReady, Lago, TokenMeter, AI-Gateway, Cost Calculator), all 1–8p.
3. **Agent memory tools** — saturated: A-MEM, Memvid, MemoryKit, Vexp (all Show HN); frontier compaction features absorb it.
4. **Vibe-debt scanner (hallucinated-API finder)** — directly absorbed by live Semgrep Guardian + audit fatigue.
5. **EU text-disclosure checker alone** — same demand as winner but narrower; folded in as text mode.

## What I could not verify (honesty)
- Veracode pricing page 404s today; earlier "tier" figures were agent-reported, unreproduced → dropped.
- Reddit scraping blocked (403/no UA) → no Reddit evidence cited.
- No adoption statistics exist for "teams wanting attribution" — market size is a labeled model, not data.
