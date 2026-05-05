# Supply Chain Optimizer

A 7-day supply chain simulation + optimizer with hourly ticks, daily random events, hazard injection, and contract-honoring cost minimization across three sectorally-distinct supply chains.

## Status

Bootstrap. No application code yet. Tech stack, optimizer approach, and the three sectors are intentionally undecided — the next step is `/grill-me` against `docs/ideas/supply-chain-optimizer.md`. Don't write production code before grilling converges.

## Hard requirements (from the user spec — non-negotiable inputs to grill-me / to-prd)

- 5 random events per simulated day; the simulation must adapt to them.
- Each day produces a business result.
- Simulations span 7 days. Start date is random. Weekends are off.
- Simulate in 1-hour intervals.
- A UI button injects a random hazard into the supply chain on demand.
- Risks and optimizations are tracked over time.
- The optimizer must be robust and "creative" (= intelligent) — produce the best 7-day outcome.
- Goal: minimize cost while honoring every contract.
- Three supply chains modeled, each 5–20 layers deep, in different sectors.

## Where things live

- `docs/ideas/` — pre-PRD concepts. Current concept: `supply-chain-optimizer.md`.
- `docs/agents/` — agent skill configuration (issue tracker, triage labels, domain layout).
- `docs/prd/` — PRDs once `/to-prd` produces them (does not yet exist).
- `docs/adr/` — architectural decision records once they're needed (does not yet exist).
- `.claude/skills/` — Matt Pocock's skills (and any future custom skills).
- `.agents/skills/` and `skills/` — canonical skill source the skills CLI manages.

## Workflow norms

Idea → `/grill-me` (drill the design) → `/to-prd` (publish PRD as a GitHub issue) → `/to-issues` (slice into vertical-slice issues) → `/tdd` per slice. Use `/diagnose` for hard bugs, `/zoom-out` when you've lost the architectural plot.

## Agent skills

### Issue tracker

GitHub Issues on `daniel-bonaker-qestit/supply-chain-optimizer` (public). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at repo root (created lazily by `/grill-with-docs`). See `docs/agents/domain.md`.
