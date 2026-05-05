# Idea: Supply Chain Optimizer

## Elevator pitch

Run a 7-day simulation across three sectorally-distinct supply chains, each 5–20 layers deep. Every simulated day randomly throws 5 events at the network, the clock advances in 1-hour ticks, weekends are off, and a button injects a random hazard whenever the user wants chaos. An optimizer reacts in real time and is judged on a single number per day: the business result. The win condition is to honor every contract for the full week while spending as little money as possible. The interesting part is the optimizer — it has to be robust enough to absorb a strike or port closure mid-week and creative enough that its 7-day total beats a naive plan, not just a no-op baseline.

## Hard requirements (verbatim from the spec — non-negotiable)

- 5 random events per simulated day; the simulation must adapt to them.
- Each day produces a business result.
- Simulations span 7 days. Start date is random. Weekends are off.
- Simulate in 1-hour intervals.
- A UI button injects a random hazard into the supply chain on demand.
- Risks and optimizations are tracked over time.
- The optimizer must be robust and "creative" (= intelligent) — produce the best 7-day outcome.
- Goal: minimize cost while honoring every contract.
- Three supply chains modeled, each 5–20 layers deep, in different sectors.

## What we know

- 7-day rolling horizon, hourly tick (so 5 × 24 = 120 active hours over the week, 168 wall-clock hours).
- Weekends off — needs an explicit calendar concept (no production, no inbound? Or just no human activity?). Open question.
- Per-day random events drive most of the volatility; the hazard button is an *additional* user-controlled stressor.
- Three independent supply chains, each a directed graph 5–20 nodes deep, each in a different sector. They're modeled in parallel; whether they share state (e.g. shared logistics, shared finance) is open.
- Cost is the primary metric. Contract fulfillment is a constraint, not an objective.
- "Risks" and "optimizations" are first-class concepts the system tracks over time — not just instantaneous values, time series.

## What we don't know yet — `grill-me` targets

Drill these in order; the early ones unblock the later ones.

### Tech & runtime
- **Stack.** Web app (React/Next + TS for UI, JS or Python optimizer)? Pure Python + Streamlit? Python backend + JS frontend? The "button" implies UI, but the optimizer wants real math libraries.
- **Optimizer paradigm.** LP/MILP (OR-Tools, PuLP)? Greedy heuristic? MCTS / rolling-horizon receding optimization? RL? LLM-reasoning? Hybrid (LP for cost, LLM for "creative" replanning under hazards)? What does *"creative"* mean operationally — out-of-the-box rerouting? Substitution? Renegotiating internal contracts?
- **Determinism.** Same seed → same trajectory required (for testing/replay)? Or live-only, no reproducibility?
- **State persistence.** Replayable seeded runs persisted to disk? Or in-memory only?

### Domain modeling
- **The three sectors.** Pick concrete ones — proposed defaults: pharma cold-chain, consumer electronics, perishable food. What makes each *meaningfully* different (shelf life, lead times, regulatory holds, demand elasticity)?
- **"Layer" semantics.** Is a layer a tier of suppliers (T1 → T2 → T3), a process step (raw → component → assembly → distribution → retail), or just a node in a DAG? Does layer count map to depth from sink, or longest-path?
- **Network topology per chain.** Tree, DAG, or arbitrary graph? Branching factor?

### Events & hazards
- **Event taxonomy.** What pool do the 5 daily events draw from? Examples: demand shock, supplier delay, quality recall, price spike, capacity reduction, weather delay, regulatory hold, currency swing. Same pool across sectors or sector-specific?
- **Hazard taxonomy.** What can the button inject? Strike, port closure, factory fire, pandemic, cyber-attack, geopolitical sanction. How is "random" parameterized — uniform, weighted by historical frequency?
- **Event severity & duration.** Are events instantaneous, multi-hour, or multi-day? Stackable?

### Contracts & cost
- **Contract model.** What does a contract specify — quantity by date, quality spec, price? Penalty for breach: hard infeasibility (run fails), or soft (penalty cost added)?
- **Cost line items.** Inventory holding, transport, expediting (e.g. air freight vs sea), production, penalties, capital, labor, write-off? Which are fixed vs variable?
- **Business result definition.** Profit (revenue − cost)? Net cost only? Service level? Composite KPI weighted by contract criticality?

### Risk & visualization
- **Risk score.** Instantaneous (per node, per hour)? Rolling? Scenario tree (probability-weighted projected outcomes)? How surfaced in the UI?
- **Optimization tracking.** Log of decisions made, with reason and counterfactual cost? Replayable timeline?
- **Visualization.** Network graph (live, with node states)? Gantt / time-distance chart for shipments? KPI dashboard (cost, service level, risk over time)? All three? Per-chain or unified?
- **UI flow.** Single-player "watch the simulation run" with hazard button as the only interaction? Or interactive — user can override the optimizer's decisions?

### Scope guardrails
- **Realism level.** Toy scenarios with hand-picked numbers, or scenarios calibrated against published industry data?
- **Multi-run analytics.** Replay the same seed with different optimizer configs to compare? Or one-shot only?

## Out of scope (for v1) — placeholder

To be filled in by `grill-me`.
