# 32 candidates, scored, cut
Scoring axes (all judgment-labeled): pain severity · frequency (evidence links in sources.md) · WTP (live comparables) · originality (search vectors run today) · durability vs next 2–3 model generations · MVP-in-weeks.

## WINNER
**1. AI code/text provenance layer (proveGIT)** — line-level human/agent/model attribution + cost + certificates.
- Pain: severe & rising (fragile-codebase 316p; provenance threads 58p/54p; compaction laundering 9p) · frequency: high across dev+legal+EU · WTP: $30/seat market proven adjacent (Semgrep live) · originality: high (0 commercial products found) · durability: **very high** — pure bookkeeping, no model calls; legal/compliance motive outlives any model generation · MVP: 2 people, 6 weeks. **SHIP.**

## CONTENDERS (why they lost)
**2. Agent-session audit/forensics service** — severe incidents (military 519p, Home Office 24p, courts 21p, arXiv 659p) but zero traction on audit products (3–11p Show HNs), audit fatigue live (Glasswing 13p), Semgrep Guardian absorbs write-time AI-code audits. Kept as winner's certificate module.
**3. EU text-disclosure checker** — real regulatory motive (72p) but too narrow alone; folded into winner as text mode.
**4. LLM model fingerprinting (detect model/agent that produced text)** — adjacent to provenance; research-ish (front-page "how fingerprintable users are" 50p), adversarial-detection arm, product demand unproven.
**5. Hallucinated-reference verifier for researchers/publishers** — sharp pain (arXiv ban 659p; EY report 326p) but competitive check incomplete (citation-checker startups may exist — unverified), and frontier labs will absorb citation grounding.

## ABSORBED / SATURATED (cut)
6. Token-cost meter/chargeback — ≥5 Show HN proxies/calculators, 1–8p (AgentReady, Lago, TokenMeter, AI-Gateway, OCR Cost Calc).
7. Agent memory tools — A-MEM, Memvid, MemoryKit, Vexp; frontier compaction/context features.
8. Vibe-debt scanner (hallucinated APIs, dead code from AI commits) — **Semgrep Guardian live today** ("scan AI-generated code the moment it's written"), plus audit fatigue.
9. AI code-review bots / "AI audits your codebase" — 8p Show HNs; frontier labs' first-party reviewers.
10. Evals products for non-coders — crowded space, frontier absorption (labs ship evals; unverified competitor names dropped).
11. Prompt/context optimizers — lab features (caching, compaction).
12. MCP server managers — OSS-crowded, no pricing market found.
13. Agent notifications/"agent inbox" — Show HN supply exists; thin WTP.
14. Sandbox/permission guards for agents — OS sandboxing; absorbed into agent CLIs.
15. Session recorder/replayer standalone — no traction found for audit framing; kept as proveGIT component.
16. Coding-agent IDE shells — frontier absorption certain (Claude Whiteboards/Sheets/Data live).
17. AI watermarking/provenance of images — SynthID/industry incumbents (common knowledge, unverified here); not software-product greenfield.
18. Inference-engineering guides/tooling — front-page guide (54p) = education play, no WTP.
19. Local-first smart-home/offline tools — adjacent domain, 605p front page, not AI-native.
20. Process monitors for agent processes (Process Explorer macOS 102p front page) — OS tooling niche; absorbed by provenance dashboards.

## VERTICAL/GOVERNMENT (cut: demand unverifiable)
21. AI decision audit ledger for government (Home Office, courts, military incidents) — real incidents, but buyers (agencies) don't buy SaaS; procurement angle unverified (earlier RFP-language claim not reproduced).
22. Insurance-appraisal-style AI auditor for insurers — analogous market exists, but no direct evidence insurers want an AI auditor today; demand inferred only.
23. Radiology-accreditation-style AI accreditation service — institutionally durable, MVP too big, buyer path unclear.
24. Enterprise "AI use policy" checklist product — no pain evidence found; feels compliance-theater.
25. Job-site/agency AI cost control product — same as token meters (#6).

## WEAK / VAPOR (cut)
26. ArXiv-ref-ban compliance badge for researchers — meme-sized.
27. "Human touch" style preserver for AI text — aesthetic, no measurable WTP.
28. Agent reliability dashboards (LangSmith-style) — competitive, unverified incumbents; absorbed.
29. Model registry/attestation ("which model ran") — good idea, but only meaningful once provenance layer exists = subset of winner.
30. Human-review queue for agent PRs — real workflow pain but community tooling culture absorbs it (Graphite/bots); originality unverified.
31. Prompt provenance for enterprise RAG — niche, demand unverified.
32. vibe-coding curriculum/coaching — no WTP.

## Pattern across the cut list
Every capability-shaped idea (memory, cost, scanning, reviewing, recording) is either saturated or being absorbed by frontier labs + Semgrep-style platforms *right now* (verified live). The one that survives is **record-keeping**: authorship, cost, and certificates — data, not intelligence. That's the durable layer.
