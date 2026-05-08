# PRD: Supply Chain Optimizer v1 — 7-day sim + deterministic MILP

## Problem Statement

A logistics-curious analyst, hiring panel, or portfolio reviewer has no good way to see a real operations-research optimizer at work on a realistic-feeling supply chain. Static dashboards show finished plans but not adaptation. Industry simulators are closed-source or require domain access. There is nothing the user can run locally that lets them pick a sector, watch an optimizer plan a 7-day horizon and react to disruptions hour-by-hour, inject chaos on demand, and tell whether the optimizer's decisions are actually adding value compared to a naive plan or to the theoretical optimum with hindsight.

## Solution

A locally-run, web-based 7-day supply chain simulation across three sector-distinct logistics networks (pharma cold-chain, electronics, perishable food). The user picks a sector, sets a seed, and starts the run. A 4-panel live dashboard shows the network graph, a KPI tape (profit and cost over time), an event log, and a hazard button. Time advances in 1-hour ticks; weekends are inactive. Five random events fire per active simulated day; the user can press the hazard button to inject a catastrophic disruption at any moment. At end of run, a self-contained HTML report scores the optimizer against a naive baseline and a perfect-hindsight upper bound.

Behind the dashboard, a deterministic mixed-integer linear program is built and solved at every event, hazard, and opportunity-contract arrival. The MILP maximizes profit (revenue from delivered contracts minus transport, holding, and breach penalties) subject to honoring all committed contracts. The optimizer is reactive — it does not anticipate future events, but on each replan it produces the cost-optimal plan against the current state and the remaining horizon.

The system is built in Python with Plotly Dash for the live UI and OR-Tools (or PuLP) for the MILP. Runs are reproducible via seed and persisted to disk for replay. The simulation models a third-party logistics provider (3PL): we move goods, we don't own them, and we don't produce anything.

## User Stories

**Run setup**

1. As a user, I want to pick one of three sectors (pharma cold-chain, electronics, perishable food) at run start, so that I can demo the optimizer on the network type most relevant to my interest.
2. As a user, I want to enter a seed at run start (or accept an auto-generated one), so that I can reproduce the same simulation deterministically.
3. As a user, I want the same seed plus the same sector plus zero hazard injections to produce an identical run every time, so that runs are reproducible for debugging and demo prep.
4. As a user, I want the run to default to a sensible seed if I don't pick one, so that I can hit "start" without thinking.

**Live simulation experience**

5. As a user, I want to watch the network graph update live as time advances, so that I can see shipments moving and nodes changing state.
6. As a user, I want to see node and lane state visually distinguished (healthy / event-affected / hazard-affected), so that I can spot disruptions at a glance.
7. As a user, I want to see in-transit shipments on the network graph annotated with their transport mode (slow vs fast), so that I can see when the optimizer is paying for expedited transport.
8. As a user, I want to see the current quality state of each in-transit shipment (cold-chain integrity, shelf-life remaining, handling integrity), so that I can predict trial pass/fail.
9. As a user, I want to see a live KPI tape with profit-to-date, cost-to-date, and cost broken down by category (transport, holding, breach), so that I can track the optimizer's running performance.
10. As a user, I want to see an event log scrolling chronologically with events, hazards, and the optimizer's responses, so that I can read the narrative of the run.
11. As a user, I want each contract listed with its status (committed/opportunity, trial-pending/main-active/delivered/breached/voided), so that I can see what's outstanding.
12. As a user, I want to see buffer time per active contract (hours of slack in the current plan), so that I can spot contracts at risk of breaching.
13. As a user, I want committed contracts visually distinguished from opportunity contracts, so that I understand which the optimizer is required to honor.

**Live controls**

14. As a user, I want a hazard button that injects a random catastrophic disruption when I click it, so that I can stress-test the optimizer on demand.
15. As a user, I want to see which hazard was injected and its current effects, so that I understand what just happened to the chain.
16. As a user, I want a sim-speed control (slider or buttons) to change how fast wall-clock time advances sim hours, so that I can speed past quiet stretches and slow down for interesting moments.
17. As a user, I want a pause/resume control, so that I can stop the sim to examine state or read the plan.
18. As a user, I want a "fast-forward to next event" control, so that I can skip dwell time without missing perturbations.
19. As a user, I want to inspect the optimizer's current plan (which shipments scheduled when, which mode, which path through the network), so that I can verify its decisions look sensible.

**End-of-run reporting**

20. As a user, I want an HTML report generated automatically at end of run, so that I have a self-contained artifact to review or share.
21. As a user, I want the report to include a full timeline replay (events, hazards, decisions), so that I can study the run after the fact.
22. As a user, I want the report to compare my run against a naive baseline plan (simple-rule alternative) on the same seed, so that I know whether the optimizer added value over a non-optimizer.
23. As a user, I want the report to compare my run against a perfect-hindsight upper bound (the same MILP solved once at end with full event knowledge) on the same seed, so that I know how much room remains versus the theoretical optimum.
24. As a user, I want the report to express the optimizer's score as a fraction of available improvement captured `(naive_cost - our_cost) / (naive_cost - perfect_hindsight_cost)`, so that I have a single number summarizing optimizer quality.
25. As a user, I want the report to be a single self-contained HTML file (no external dependencies at view time), so that I can email or commit it.

**Persistence and replay**

26. As a user, I want every run automatically persisted to disk (state snapshots, decision log, event timeline), so that I can revisit it later.
27. As a user, I want to load a saved run and step through it, so that I can analyze decisions retrospectively.
28. As a user, I want runs identified by their seed and sector, so that I can find specific runs in the archive.

**Demo behavior under stress**

29. As a viewer, I want to watch the optimizer reroute around a disrupted lane, so that I see the chain visibly adapt to events.
30. As a viewer, I want to watch the optimizer pay for fast-mode transport when slow mode would miss a deadline, so that I see the expediting decision in action.
31. As a viewer, I want to watch the optimizer accept opportunity contracts when their revenue exceeds marginal cost, so that I see the accept/decline judgment.
32. As a viewer, I want to watch the optimizer decline opportunity contracts when accepting would risk a committed contract, so that I see contract honoring as the load-bearing constraint.
33. As a viewer, I want to watch the optimizer hold inventory at upstream nodes when shipping later is cheaper than shipping now, so that I see holding-cost vs. transport-cost trade-offs.

**Sector-specific quality**

34. As a user running pharma, I want refrigeration failures to break cold-chain integrity for affected shipments, so that the trial-and-quality model behaves realistically.
35. As a user running food, I want shelf-life to deplete during transit and dwell, so that slow plans risk spoilage and trial failure.
36. As a user running electronics, I want ESD handling exceptions to force rerouting away from non-equipped nodes, so that the sector's distinguishing constraint is felt.

**Contract lifecycle**

37. As a user, I want contracts to begin with a trial shipment whose pass/fail is determined by quality state at trial-delivery hour, so that the validation step is modeled.
38. As a user, I want a failed trial to void the contract without firing the breach penalty (setup cost is sunk), so that the trial behaves as a safety mechanism not a punishment.
39. As a user, I want a successful trial to activate the main contract for full delivery, so that the lifecycle proceeds.
40. As a user, I want missed main-deliveries on committed contracts to fire a very high breach penalty in the cost objective, so that the optimizer is strongly incentivized to honor committed contracts whenever physically possible.

**Replan triggers**

41. As a user, I want the MILP to re-solve at sim start, on every random event, on every hazard injection, and on every opportunity-contract arrival, so that the optimizer reacts to every state change.
42. As a user, I want each replan to produce a plan covering the full remaining horizon (not a fixed window), so that long-horizon decisions are coordinated.
43. As a user, I do not want the MILP to re-solve on a periodic schedule (e.g., every sim-day), because event-triggered replans suffice.

**Developer / contributor**

44. As a developer, I want each of the five deep modules (sim-engine, optimizer, quality-state, contract-manager, event-generator) to have a small interface and be unit-testable in isolation, so that I can refactor confidently.
45. As a developer, I want to add a new sector by extending the sector-defs module without touching the optimizer or sim-engine internals, so that sectors are pluggable.
46. As a developer, I want to add a new event or hazard type by extending the event/hazard pool config without touching consumers, so that the disruption taxonomy is extensible.
47. As a developer, I want to inspect the MILP that was built at any replan (variables, constraints, objective coefficients), so that I can debug optimizer behavior.
48. As a developer, I want to tune cost, transit-time, and capacity parameters per sector via a single config file or module, so that calibration is centralized.

## Implementation Decisions

**Strategy and paradigm**

- Optimizer-star focus: investment skews toward correctness and depth of the optimizer, not UI polish. The UI exists to make the optimizer's behavior legible.
- The optimizer is a deterministic Mixed-Integer Linear Program (MILP). It uses nominal parameters and re-solves on every state-changing trigger. Robustness is delivered through optimal re-solving on each disruption, not through anticipation.
- The simulator is the outer loop; the optimizer is called at trigger points.
- We model a third-party logistics provider (3PL). The system does not own goods, does not produce anything, and does not model production costs.

**Domain model**

- Each run simulates one chain in one user-selected sector. Three sectors are supported: pharma cold-chain, electronics, and perishable food.
- Each chain is a layered Directed Acyclic Graph (DAG) with edges only between adjacent layers. Layers represent handover points (origin warehouse, transport leg, port, customs, distribution center, last-mile, endpoint), not production stages.
- Sector-specific depth: pharma 6–8 layers, electronics 12–18, food 5–7. Branching factor 2–4 per node.
- Contracts are the unit of demand. Each contract has an endpoint, a quantity, a due-by-hour, a per-unit revenue, and a setup/trial requirement.
- Two contract origins: committed contracts (5–8 per chain, all known at sim start, all mandatory under breach penalty) and opportunity contracts (arrive mid-week, optional, accept iff marginal revenue > marginal cost).
- Trial mechanic: every contract begins with a small validation shipment (5–10% of contract qty). Pass/fail is a deterministic function of quality state at trial-delivery hour. Failure voids the contract without firing the breach penalty; setup cost is sunk.
- Quality state is tracked per shipment, sector-specific in definition: cold-chain integrity (boolean) for pharma; shelf-life remaining (continuous) for food; handling integrity (boolean / counter) for electronics.

**Cost and objective**

- Three cost lines in the MILP objective: transport, holding (warehouse storage), and breach penalty. Production cost does not exist in 3PL framing.
- Two transport modes per lane: slow/cheap and fast/expensive. Mode choice per shipment is the expediting decision.
- All contracts carry per-unit revenue. Objective is to maximize profit (sum of revenue from delivered units minus the three cost lines). For committed contracts revenue is constant and drops out of decisions; for opportunity contracts revenue drives the accept/decline binary.
- Breach penalty is set very high so that the optimal plan honors every committed contract when physically possible. When a hazard makes a delivery genuinely impossible, the MILP still returns a plan and the breach surfaces as a flag plus penalty cost in the report.

**Stochasticity model**

- Hybrid event pool: 4 shared event types (origin warehouse delay, lane disruption, mode disruption, price spike) plus 2–3 sector-specific event types per sector (pharma: refrigeration failure, regulatory hold; electronics: customs / IP-clearance hold, ESD handling exception; food: spoilage incident, contamination alert).
- 5 events fire per active sim-day, drawn from the sector's pool with replacement. Weekends are inactive — no events, no shipments, no opportunities — but holding cost still accrues and hazards from the button still fire.
- Universal 8-hazard pool injectable on demand: strike, border / customs closure, catastrophic node loss, cyberattack (visibility blackout), sanctions, pandemic (system-wide capacity drag), major weather event, equipment recall (fast-mode grounded). Each hazard's parameters (target node, severity, duration) are sampled at injection.
- Event severity is sector-scaled: a refrigeration-failure event is severe in pharma, moderate in food, irrelevant in electronics.

**Replan cadence and horizon**

- Replan triggers: sim start, each random event, each hazard injection, each opportunity contract arrival. No periodic time-based replan.
- Each replan plans over the full remaining horizon (e.g., at hour 12 the MILP plans hours 13–168). The horizon shrinks naturally as the run progresses.
- Approximately 30–40 MILP solves per typical run. Each is small enough that solve time is comfortable on a developer laptop.

**UI and reporting**

- Live dashboard built as a React single-page app. Four panels: animated network graph (Cytoscape.js), KPI tape (Plotly.js, profit / cost time series), event log, and hazard button. Plus run controls: seed input, sector selection, sim-speed slider, pause/resume, fast-forward-to-next-event.
- End-of-run report rendered as a deep-linkable URL view of the saved run (route + run id), reusing the live dashboard components in a "frozen" replay mode. Optional export to a self-contained static HTML file for emailing or committing.
- Includes timeline replay, decision log, cost breakdown, naive-baseline comparison, perfect-hindsight comparison, and the optimizer score `(naive_cost - our_cost) / (naive_cost - perfect_hindsight_cost)`.
- Risk surfaced as buffer time per active contract (hours of slack between current plan delivery and contract deadline). Cheap to compute; consistent with the deterministic-no-prediction stance.

**Persistence**

- Every run is persisted in the browser's IndexedDB on completion: state snapshots per replan, decision log, event timeline, hazard timeline, final scorecard. Format: JSON-serializable objects.
- Runs are identified by `(sector, seed, hazard-injection-fingerprint)`.
- Optional JSON export and import so users can share runs between machines or commit them as fixtures.
- A "load run" UI lets the user open a saved run and step through it post-hoc.
- No multi-run side-by-side comparison UI.

**Realism**

- Numerical parameters (transit times, costs, capacities) are industry-ballpark — in the right order of magnitude, sourced from public estimates, not strictly calibrated to citations.

**Module structure**

The system decomposes into 14 modules. Five are deep (rich internal logic, small external interface, primary bug surface):

- `sim-engine` — outer loop hour-tick state machine. Interface: `step(h)`, `inject_hazard(t)`, `current_state()`. Applies events, accepts hazards, fires replan triggers, advances shipments and quality states.
- `optimizer` — MILP builder + solver. Interface: `solve(state) -> Plan`. Encapsulates OR-Tools / PuLP usage; the rest of the system never sees the solver directly.
- `quality-state` — per-sector quality-evolution rules. Effectively a pure function of shipment history and ambient conditions per sector.
- `contract-manager` — owns contract lifecycle (committed / opportunity → trial-pending → main-active → delivered / breached / voided), trial pass/fail evaluation, and revenue / penalty accounting.
- `event-generator` — deterministic-per-`(sector, seed)` weekly event timeline generator with sector-scaled severity.

The remaining nine are shallower (config, bridges, UI glue): `domain-model`, `sector-defs`, `hazard-generator`, `plan-executor`, `baselines`, `risk-computer`, `run-archive`, `live-ui`, `report-generator`.

**Stack**

- Language: TypeScript (strict mode).
- MILP: `highs-js` — the HiGHS solver compiled to WebAssembly. Real MIP support, MIT-licensed, npm-distributed. Solve time in WASM is the load-bearing assumption to validate during slice 1; if it proves too slow on representative chains, the levers are: shorter horizon, smaller variable count via sector simplification, or warm-starting between replans.
- Build / dev: Vite. GitHub Pages deploy via a GitHub Action on push to `main`.
- UI framework: React. Strict-mode TS, function components.
- Visualization: Plotly.js for KPI tape and report charts; Cytoscape.js for the animated network graph.
- Persistence: browser IndexedDB. Optional JSON file export/import.
- Hosting: GitHub Pages. The whole app is static; no backend.

## Testing Decisions

**What makes a good test in this codebase**

- Tests exercise external behavior of each module. They construct realistic state (or use small fixtures), call the module's public interface, and assert on the observable outcome. They do not assert on internal state or call internal helpers.
- Tests are deterministic. Any module that uses randomness must accept a seed or random-state parameter.
- Tests prefer realistic small scenarios over heavy mocking. The MILP optimizer is fast enough that real solves on toy problems are the right test fixture for `optimizer` tests — there is no need to mock the solver.
- Tests should fail loudly when behavior diverges, not be edited to match new behavior. A failing test under refactoring is information, not a problem to silence.

**Modules with tests written from day one**

All five deep modules:

- `sim-engine` — state-transition tests covering: events fire on the expected schedule for a given seed; hazard injection updates affected nodes; replan triggers fire on every event/hazard/opportunity; weekend hours skip business activity; quality state evolves on shipments.
- `optimizer` — scenario-based MILP tests covering: trivial single-contract minimum-cost plan; breach-forced state where penalty must fire; opportunity contract accepted iff revenue > marginal cost; opportunity contract declined when it endangers a committed contract; mode choice flips to fast-mode when slow misses the deadline.
- `quality-state` — pure-function tests per sector: cold-chain integrity flips false on temperature excursion; shelf-life decrements correctly on slow modes; handling integrity flips on ESD exception event.
- `contract-manager` — lifecycle tests: committed contract creation; opportunity contract arrival and accept/decline; trial pass given good quality state; trial fail voids contract without breach; main delivery success; main delivery miss fires breach penalty.
- `event-generator` — determinism tests (same seed → same timeline); sector-severity tests (severity distribution differs across sectors); pool-coverage tests (over many seeds, all event types eventually appear).

**Prior art**

- No existing tests in the codebase yet — this is a bootstrap project. Test conventions will be established by the first deep module to land. The TDD skill installed in this repo is the operational guide.

## Out of Scope

- Stochastic / scenario-aware MILP. Considered and explicitly rejected in favor of deterministic re-solve.
- LLM-based replanning or any LLM in the optimizer loop.
- Multi-run side-by-side comparison UI.
- Production cost modeling, capital cost, financing cost, labor scheduling. Not applicable to 3PL framing.
- Calibration of parameters against specific cited industry data.
- Multiple chains running concurrently in a single simulation. Each run is one sector.
- Tiered contract criticality (critical-hard plus secondary-soft). Single-tier soft-with-very-high-penalty only.
- Setup cost as a fourth cost line in the MILP objective. Setup is folded into the accept-time decision for opportunity contracts; can revisit if observable bugs surface.
- Hazards beyond the 8 in the locked pool (fuel/energy crisis, demand cancellation, supplier insolvency). Held for a possible v2.
- Real currency or multi-currency cost modeling. Single-currency only.
- Mobile or responsive UI. Desktop-only.
- Authentication, multi-user, deployment to a hosted environment. Local-run only.
- Trial mechanics other than the deterministic-pass-iff-quality-state-intact form locked in design.

## Further Notes

- **3PL framing matters.** The choice not to model production fundamentally simplifies the cost model and makes the 3-line objective (transport + holding + breach) correct rather than minimal. Reviewers and contributors should hold this framing — proposals that assume vertical integration or production-side costs are off-spec.
- **"Robust" is interpreted as "recovers optimally on every event."** It does not mean "anticipates events." Pre-emptive moves are not part of v1 behavior. Don't be alarmed if the optimizer waits to react.
- **Risk = buffer time, not predicted breach probability.** Any future request to add Monte Carlo risk should be checked against the deterministic-no-prediction lock here.
- **`/grill-with-docs` should produce a `CONTEXT.md`** at the repo root with the vocabulary established during this PRD's grilling session: run, sector, chain, layer, node, lane, mode, shipment, contract (committed / opportunity), trial, quality state, event, hazard, replan, trigger, buffer time, plan, naive baseline, perfect-hindsight, optimizer score, run archive. ADRs in `docs/adr/` should record load-bearing decisions like the deterministic-MILP choice and the 3PL framing.
- **Open details deferred to implementation time** (not architectural; resolve via ADRs as encountered): concrete quality-state evolution rules per sector; specific node throughput and lane capacity ranges; specific transit-time and cost ranges per sector and mode; opportunity contract arrival distribution shape and rate; specific event severity distributions per sector; HTML report layout details.
- **Implementation slicing** is the next step: `/to-issues` against this PRD should produce vertical-slice tickets in a tracer-bullet order — the first slice ought to deliver an end-to-end thin path (sim-engine ticking → optimizer solving a trivial chain → live UI showing one number) rather than building modules to completion in isolation.
