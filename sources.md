# Sources — every factual claim tagged (verified today, 2026-11-10)

## Demand evidence (verified via HN Algolia API today; title/points/date from live JSON)
| Claim | Source | Tag |
|---|---|---|
| "Provenance Is the New Version Control", 58p, 2026-01-13 | news.ycombinator.com/item?id=46597023 | VERIFIED |
| "Human vs. AI – Diff-based line-level provenance for text under agentic editing", 54p, 2026-08-09 | news.ycombinator.com/item?id=49232300 | VERIFIED |
| "Our approach to EU text provenance rules", 72p, 2026-10-05 | news.ycombinator.com/item?id=49966293 (evanxmerz) | VERIFIED (post content itself: headline-level only) |
| "Compaction Laundering: Provenance Destruction in Context-Compacting Coding Agent", 9p, 2026-10-26 | news.ycombinator.com/item?id=50246778 | VERIFIED |
| "AI usage generates a fragile codebase", 316p, 2026-11-10 | news.ycombinator.com/item?id=50438318 → evanxmerz.com | VERIFIED |
| "After two years of vibecoding, I'm back to writing by hand", 865p | item?id=46765460 | VERIFIED |
| Vibe-meta wave: 787p id=48037128 · 616p id=47664912 · 434p id=47006615 · 405p id=47167931 · 330p id=46765120 | VERIFIED |
| US Military hallucinated intelligence report 519p id=49757520 · Home Office asylum 24p id=49085998 · Ga. court order 21p id=47480219 · arXiv ref-ban 659p id=48140922 · EY Canada 326p id=48339580 · Twilio support 159p id=45748570 | VERIFIED |
| "Ask HN: When can we trust AI in coding… happy path issue?" 2p id=50209084 | VERIFIED (low traction noted) |

## Supply / absorption (verified)
| Claim | Source | Tag |
|---|---|---|
| Semgrep: "Semgrep Guardian — scan and fix AI-generated code the moment it's written", AI coding agent plugin, "Secure Vibe Coding", "Code security for builders and agents"; pricing Free/$30 per contributor (Code, SCA)/$15 (Secrets)/Enterprise custom | semgrep.com/pricing (fetched live 2026-11-10) | VERIFIED |
| Sourcegraph Enterprise "Starting at $16K, minimum annual contract… credits for AI features; works with Claude Code, Cursor, Codex, Amp" | sourcegraph.com/pricing (fetched live) | VERIFIED |
| Frontier absorption: "Claude Whiteboards, Claude Sheets, and Claude Data" 132p (claude.com/resources/articles/sheets-whiteboards-data) · "AlphaProof Code" 547p · "Apple has new Mac app… local AI models" 49p · "Val Town is winding down" 257p — HN front page 2026-11-10 | VERIFIED (front-page JSON) |
| Audit fatigue: "After 7 Months, Glasswing Overwhelms Maintainers with Underwhelming Findings" 13p (vulncheck.com/blog/anthropic-glasswing-november-update) · "Delve AI Audit Fraud" 11p id=46549252 | VERIFIED |
| Low traction for audit/recorder products: 8p id=48156878 · 7p id=46890306 (Viberails) · 5p id=48400007 · 4p id=47074274 · 4p id=46943348 (Alchemyst) | VERIFIED |
| Token-cost saturation: AgentReady 8p id=47122083 · Lago 3p id=48287802 · AI-Gateway 2p id=48668803 · Token Cost Calculator 2p id=47629677 · TokenMeter 1p id=47057746 | VERIFIED |
| Memory saturation: A-MEM 8p id=46636707 · Memvid 3p id=46502628 · MemoryKit 3p id=47195240 · Vexp 1p id=47136384 · "AI agent forgets user preferences" 6p id=46929447 | VERIFIED |
| GitHub repo search `provenance attribution AI` created>2025 → 0 items | api.github.com (fetched today; result counts API-capped — noted) | VERIFIED |

## Market / pricing anchors
| Claim | Source | Tag |
|---|---|---|
| Semgrep Teams $30/month per contributor (Code & SCA), Secrets $15 | semgrep.com/pricing | VERIFIED (used as pricing comparable) |
| Sourcegraph Enterprise from $16K/yr | sourcegraph.com/pricing | VERIFIED |
| Veracode tier pricing | veracode.com/en/pricing returned 404 today | UNVERIFIED — earlier figure was agent-reported, unreproduced → DROPPED |
| "50k+ Co-authored-by: Cursor trailers", "GitBlame AI", "Sourcegraph AI-attribution product" | earlier subagent claims | UNVERIFIED — not reproduced today → DROPPED from report |
| Developer-adoption counts (500k–1M) | none | ASSUMPTION — labeled as judgment in report |

## Regulatory / legal
| Claim | Source | Tag |
|---|---|---|
| EU text provenance disclosure rules circulating | id=49966293 (headline + author post) | PARTIAL — underlying rule text NOT independently fetched |
| Procurement RFPs demanding third-party AI audit | earlier agent claim | UNVERIFIED — not reproduced → excluded |

## Methods & limits
- All HN data via hn.algolia.com API (live). Front-page pulled with `tags=front_page`.
- Reddit: JSON endpoints blocked (no UA / 403) → **no Reddit evidence cited**.
- X/Product Hunt/YC/newsletters: not directly fetched today → claims of "what everyone is obsessed with" rest on HN front page + search corpus (noted in report).
- GitHub code search: needs auth → 422; only repo search used.

## Corrections made mid-research (integrity log)
- Dropped unverifiable pricing anchors (Veracode/CodeScene figures) after 404/non-reproduction.
- Dropped "GitBlame AI / Sourcegraph attribution product" claims (not reproducible today).
- Semgrep Guardian discovery (live page) *demoted* vibe-debt-scanner candidate and *forced* originality framing: attribution ≠ scanning.
