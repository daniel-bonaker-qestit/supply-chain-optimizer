import highsLoader from 'highs';
import { getSectorDefinition } from '../src/domain/sector-defs.ts';
import { solve as slice1Solve } from '../src/optimizer/optimizer.ts';

interface BenchNode {
  id: string;
  layer: number;
  holding: number;
}
interface ModeSpec {
  transitHours: number;
  costPerUnit: number;
}
interface BenchLane {
  id: string;
  from: string;
  to: string;
  capacityPerHour: number;
  slow: ModeSpec;
  fast: ModeSpec;
}
interface BenchContract {
  id: string;
  endpoint: string;
  quantity: number;
  dueByHour: number;
}
interface BenchChain {
  nodes: BenchNode[];
  lanes: BenchLane[];
  origins: string[];
}

function buildRepresentativeChain(): BenchChain {
  const nodes: BenchNode[] = [
    { id: 'farm', layer: 0, holding: 0.02 },
    { id: 'reg-e', layer: 1, holding: 0.05 },
    { id: 'reg-w', layer: 1, holding: 0.05 },
    { id: 'hub-1', layer: 2, holding: 0.08 },
    { id: 'hub-2', layer: 2, holding: 0.08 },
    { id: 'hub-3', layer: 2, holding: 0.08 },
    { id: 'rdc-1', layer: 3, holding: 0.1 },
    { id: 'rdc-2', layer: 3, holding: 0.1 },
    { id: 'rdc-3', layer: 3, holding: 0.1 },
    { id: 'ret-1', layer: 4, holding: 0 },
    { id: 'ret-2', layer: 4, holding: 0 },
    { id: 'ret-3', layer: 4, holding: 0 },
  ];

  const m = (transit: number, cost: number) => ({
    transitHours: transit,
    costPerUnit: cost,
  });
  const mk = (
    id: string,
    from: string,
    to: string,
    slow: ModeSpec,
    fast: ModeSpec,
  ): BenchLane => ({ id, from, to, capacityPerHour: 1000, slow, fast });

  const lanes: BenchLane[] = [
    mk('l01a', 'farm', 'reg-e', m(8, 1.0), m(4, 2.4)),
    mk('l01b', 'farm', 'reg-w', m(9, 1.1), m(5, 2.6)),

    mk('l12a', 'reg-e', 'hub-1', m(6, 0.8), m(3, 1.9)),
    mk('l12b', 'reg-e', 'hub-2', m(5, 0.7), m(3, 1.7)),
    mk('l12c', 'reg-w', 'hub-2', m(5, 0.75), m(3, 1.8)),
    mk('l12d', 'reg-w', 'hub-3', m(7, 0.85), m(4, 2.1)),

    mk('l23a', 'hub-1', 'rdc-1', m(4, 0.6), m(2, 1.5)),
    mk('l23b', 'hub-2', 'rdc-2', m(4, 0.6), m(2, 1.5)),
    mk('l23c', 'hub-3', 'rdc-3', m(5, 0.65), m(2, 1.6)),

    mk('l34a', 'rdc-1', 'ret-1', m(2, 0.4), m(1, 1.0)),
    mk('l34b', 'rdc-2', 'ret-2', m(2, 0.4), m(1, 1.0)),
    mk('l34c', 'rdc-3', 'ret-3', m(2, 0.4), m(1, 1.0)),
  ];

  return { nodes, lanes, origins: ['farm'] };
}

function buildRepresentativeContracts(): BenchContract[] {
  return [
    { id: 'c1', endpoint: 'ret-1', quantity: 200, dueByHour: 48 },
    { id: 'c2', endpoint: 'ret-2', quantity: 350, dueByHour: 72 },
    { id: 'c3', endpoint: 'ret-3', quantity: 250, dueByHour: 96 },
    { id: 'c4', endpoint: 'ret-1', quantity: 400, dueByHour: 120 },
    { id: 'c5', endpoint: 'ret-2', quantity: 150, dueByHour: 144 },
    { id: 'c6', endpoint: 'ret-3', quantity: 100, dueByHour: 160 },
  ];
}

interface BuiltLP {
  lp: string;
  nVars: number;
  nConstraints: number;
}

function buildBenchLP(
  chain: BenchChain,
  contracts: BenchContract[],
  horizon: number,
): BuiltLP {
  const T = horizon;
  const originSet = new Set(chain.origins);
  const nonOrigin = chain.nodes.filter((n) => !originSet.has(n.id));
  const nodeIdToIdx = new Map(nonOrigin.map((n, i) => [n.id, i]));

  const incoming = new Map<string, number[]>();
  const outgoing = new Map<string, number[]>();
  chain.lanes.forEach((lane, idx) => {
    if (!incoming.has(lane.to)) incoming.set(lane.to, []);
    incoming.get(lane.to)!.push(idx);
    if (!outgoing.has(lane.from)) outgoing.set(lane.from, []);
    outgoing.get(lane.from)!.push(idx);
  });

  const xVar = (li: number, mode: 'slow' | 'fast', h: number) =>
    `x_l${li}_${mode}_h${h}`;
  const invVar = (ni: number, h: number) => `inv_n${ni}_h${h}`;

  const lines: string[] = [];
  let nVars = 0;
  let nConstraints = 0;

  lines.push('Minimize');
  const obj: string[] = [];
  chain.lanes.forEach((lane, li) => {
    for (let h = 0; h < T; h++) {
      obj.push(`+ ${lane.slow.costPerUnit} ${xVar(li, 'slow', h)}`);
      obj.push(`+ ${lane.fast.costPerUnit} ${xVar(li, 'fast', h)}`);
      nVars += 2;
    }
  });
  nonOrigin.forEach((node, ni) => {
    if (node.holding <= 0) return;
    for (let h = 1; h <= T; h++) {
      obj.push(`+ ${node.holding} ${invVar(ni, h)}`);
    }
  });
  // Inventory variables count regardless of objective participation
  nVars += nonOrigin.length * (T + 1);
  lines.push(' obj: ' + obj.join(' '));

  lines.push('Subject To');
  nonOrigin.forEach((_n, ni) => {
    lines.push(` init_n${ni}: ${invVar(ni, 0)} = 0`);
    nConstraints++;
  });

  nonOrigin.forEach((node, ni) => {
    for (let h = 0; h < T; h++) {
      const terms: string[] = [];
      terms.push(`+ ${invVar(ni, h + 1)}`);
      terms.push(`- ${invVar(ni, h)}`);
      for (const li of incoming.get(node.id) ?? []) {
        const lane = chain.lanes[li]!;
        const slowRel = h - lane.slow.transitHours;
        const fastRel = h - lane.fast.transitHours;
        if (slowRel >= 0) terms.push(`- ${xVar(li, 'slow', slowRel)}`);
        if (fastRel >= 0) terms.push(`- ${xVar(li, 'fast', fastRel)}`);
      }
      for (const li of outgoing.get(node.id) ?? []) {
        terms.push(`+ ${xVar(li, 'slow', h)}`);
        terms.push(`+ ${xVar(li, 'fast', h)}`);
      }
      lines.push(` flow_n${ni}_h${h}: ${terms.join(' ')} = 0`);
      nConstraints++;
    }
  });

  contracts.forEach((c, ci) => {
    const idx = nodeIdToIdx.get(c.endpoint);
    if (idx === undefined) {
      throw new Error(`Unknown endpoint ${c.endpoint}`);
    }
    lines.push(` dem_c${ci}: ${invVar(idx, c.dueByHour)} >= ${c.quantity}`);
    nConstraints++;
  });

  lines.push('Bounds');
  chain.lanes.forEach((lane, li) => {
    for (let h = 0; h < T; h++) {
      lines.push(` 0 <= ${xVar(li, 'slow', h)} <= ${lane.capacityPerHour}`);
      lines.push(` 0 <= ${xVar(li, 'fast', h)} <= ${lane.capacityPerHour}`);
    }
  });
  lines.push('End');

  return { lp: lines.join('\n'), nVars, nConstraints };
}

interface BenchResult {
  label: string;
  solveMs: number;
  status: string;
  objective: number;
  nVars: number;
  nConstraints: number;
  description: string;
}

async function benchTrivial(): Promise<BenchResult> {
  const def = getSectorDefinition('food');
  const t0 = performance.now();
  const plan = await slice1Solve({
    chain: def.chain,
    contracts: def.contracts,
    currentHour: 0,
    horizonHours: def.horizonHours,
    inFlight: [],
    delivered: {},
  });
  const ms = performance.now() - t0;

  const lanesCount = def.chain.lanes.length;
  const nonOriginCount =
    def.chain.nodes.length - new Set(def.chain.origins).size;
  const nVars =
    lanesCount * def.horizonHours + nonOriginCount * (def.horizonHours + 1);
  const nConstraints =
    nonOriginCount + nonOriginCount * def.horizonHours + def.contracts.length;

  return {
    label: 'Trivial (slice-1 food chain, slow-only)',
    solveMs: ms,
    status: 'Optimal',
    objective: plan.totalCost,
    nVars,
    nConstraints,
    description: `${lanesCount} lanes × ${def.horizonHours}h × 1 mode + ${nonOriginCount} non-origin nodes inv; ${def.contracts.length} contract(s)`,
  };
}

async function benchRepresentative(
  highs: Awaited<ReturnType<typeof highsLoader>>,
): Promise<BenchResult> {
  const chain = buildRepresentativeChain();
  const contracts = buildRepresentativeContracts();
  const horizon = 168;
  const built = buildBenchLP(chain, contracts, horizon);

  const t0 = performance.now();
  const sol = highs.solve(built.lp, { random_seed: 0, threads: 1 });
  const ms = performance.now() - t0;

  return {
    label: 'Representative (12 lanes × 2 modes × 168h, 6 contracts)',
    solveMs: ms,
    status: sol.Status,
    objective: sol.ObjectiveValue,
    nVars: built.nVars,
    nConstraints: built.nConstraints,
    description: `${chain.lanes.length} lanes × ${horizon}h × 2 modes + ${chain.nodes.length - 1} non-origin nodes inv; ${contracts.length} contracts`,
  };
}

function recommendation(repMs: number): {
  verdict: 'GO' | 'SHRINK' | 'PIVOT';
  rationale: string;
} {
  if (repMs < 5000) {
    return {
      verdict: 'GO',
      rationale:
        'Representative-scale solve well under 5s; expected ~30–40 replans per run leaves plenty of headroom even on slower hardware.',
    };
  }
  if (repMs < 30000) {
    return {
      verdict: 'SHRINK',
      rationale:
        'Representative solve in 5–30s would push 30+ replans into minutes. Cut horizon (168h → 72h) or simplify chain before downstream slices land.',
    };
  }
  return {
    verdict: 'PIVOT',
    rationale:
      'Representative solve over 30s makes the deterministic-MILP-per-replan plan untenable in WASM. Consider warm-start, server-side solver, or rolling-horizon decomposition.',
  };
}

function format(r: BenchResult): string {
  return [
    `### ${r.label}`,
    `- **Solve time:** ${r.solveMs.toFixed(1)} ms`,
    `- **Status:** ${r.status}`,
    `- **Objective:** ${r.objective.toFixed(2)}`,
    `- **Variables:** ${r.nVars}`,
    `- **Constraints:** ${r.nConstraints}`,
    `- **Shape:** ${r.description}`,
  ].join('\n');
}

async function main() {
  console.log('Loading HiGHS WASM…');
  const highs = await highsLoader();
  console.log('HiGHS ready. Running benchmarks (Node, single-threaded)…\n');

  const trivial = await benchTrivial();
  console.log(format(trivial));
  console.log('');

  const rep = await benchRepresentative(highs);
  console.log(format(rep));
  console.log('');

  const rec = recommendation(rep.solveMs);
  console.log(`### Recommendation: ${rec.verdict}`);
  console.log(rec.rationale);

  console.log('\n--- markdown for issue comment ---\n');
  console.log(
    [
      '## highs-js solve-time benchmark (slice 1 gate)',
      '',
      `Run on Node ${process.version} (${process.platform} ${process.arch}), HiGHS via WASM, single-threaded, ${new Date().toISOString().slice(0, 10)}.`,
      '',
      format(trivial),
      '',
      format(rep),
      '',
      `### Recommendation: **${rec.verdict}**`,
      rec.rationale,
    ].join('\n'),
  );
}

await main();
