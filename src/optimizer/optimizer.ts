import highsLoader from 'highs';
import type {
  Chain,
  ContractId,
  DeliveryCommitment,
  Mode,
  Plan,
  ShipmentCommitment,
} from '../domain/types.ts';
import type { OptimizerState } from './types.ts';

const SOLUTION_EPSILON = 1e-6;

const MODES: readonly Mode[] = ['slow', 'fast'] as const;

export const BREACH_PENALTY_PER_UNIT = 500;

interface LPContext {
  laneIdxToLaneId: string[];
  nodeIdToIdx: Map<string, number>;
  contractIdxToContractId: string[];
}

const xVar = (laneIdx: number, mode: Mode, hour: number): string =>
  `x_l${laneIdx}_${mode}_h${hour}`;
const invVar = (nodeIdx: number, hour: number): string =>
  `inv_n${nodeIdx}_h${hour}`;
const shortfallVar = (cIdx: number): string => `sf_c${cIdx}`;

function buildLP(state: OptimizerState): { lp: string; context: LPContext } {
  const { chain, contracts, horizonHours: T } = state;

  const originSet = new Set(chain.origins);
  const nonOriginNodes = chain.nodes.filter((n) => !originSet.has(n.id));

  const laneIdxToLaneId = chain.lanes.map((l) => l.id);
  const nodeIdToIdx = new Map(nonOriginNodes.map((n, i) => [n.id, i]));
  const contractIdxToContractId = contracts.map((c) => c.id);

  const incoming = new Map<string, number[]>();
  const outgoing = new Map<string, number[]>();
  chain.lanes.forEach((lane, idx) => {
    if (!incoming.has(lane.to)) incoming.set(lane.to, []);
    incoming.get(lane.to)!.push(idx);
    if (!outgoing.has(lane.from)) outgoing.set(lane.from, []);
    outgoing.get(lane.from)!.push(idx);
  });

  // Group contracts by endpoint, sorted by dueByHour. The cumulative-shortfall
  // demand constraint per contract sums quantities and shortfall vars over all
  // contracts at the same endpoint with an earlier-or-equal deadline.
  const contractsByEndpoint = new Map<
    string,
    Array<{ idx: number; dueByHour: number; quantity: number }>
  >();
  contracts.forEach((c, idx) => {
    if (!contractsByEndpoint.has(c.endpoint)) {
      contractsByEndpoint.set(c.endpoint, []);
    }
    contractsByEndpoint
      .get(c.endpoint)!
      .push({ idx, dueByHour: c.dueByHour, quantity: c.quantity });
  });
  for (const list of contractsByEndpoint.values()) {
    list.sort((a, b) => a.dueByHour - b.dueByHour || a.idx - b.idx);
  }

  const lines: string[] = [];

  // ---------- Objective ----------
  lines.push('Minimize');
  const objTerms: string[] = [];

  chain.lanes.forEach((lane, laneIdx) => {
    for (const mode of MODES) {
      const cost = lane.modes[mode].costPerUnit;
      for (let h = 0; h < T; h++) {
        objTerms.push(`+ ${cost} ${xVar(laneIdx, mode, h)}`);
      }
    }
  });

  nonOriginNodes.forEach((node, nodeIdx) => {
    if (node.holdingCostPerUnitHour <= 0) return;
    for (let h = 1; h <= T; h++) {
      objTerms.push(`+ ${node.holdingCostPerUnitHour} ${invVar(nodeIdx, h)}`);
    }
  });

  contracts.forEach((_c, cIdx) => {
    objTerms.push(`+ ${BREACH_PENALTY_PER_UNIT} ${shortfallVar(cIdx)}`);
  });

  if (objTerms.length === 0) objTerms.push('+ 0 dummy');
  lines.push(' obj: ' + objTerms.join(' '));

  // ---------- Constraints ----------
  lines.push('Subject To');

  // Initial inventory zero per non-origin node.
  nonOriginNodes.forEach((_node, nodeIdx) => {
    lines.push(` init_n${nodeIdx}: ${invVar(nodeIdx, 0)} = 0`);
  });

  // Flow balance per (non-origin node, hour h ∈ [0, T)):
  //   inv_<n>_<h+1> - inv_<n>_<h> - sum(modal arrivals at h) + sum(modal departures at h) = 0
  nonOriginNodes.forEach((node, nodeIdx) => {
    for (let h = 0; h < T; h++) {
      const terms: string[] = [];
      terms.push(`+ ${invVar(nodeIdx, h + 1)}`);
      terms.push(`- ${invVar(nodeIdx, h)}`);

      for (const laneIdx of incoming.get(node.id) ?? []) {
        const lane = chain.lanes[laneIdx]!;
        for (const mode of MODES) {
          const releaseHour = h - lane.modes[mode].transitHours;
          if (releaseHour >= 0) {
            terms.push(`- ${xVar(laneIdx, mode, releaseHour)}`);
          }
        }
      }
      for (const laneIdx of outgoing.get(node.id) ?? []) {
        for (const mode of MODES) {
          terms.push(`+ ${xVar(laneIdx, mode, h)}`);
        }
      }
      lines.push(` flow_n${nodeIdx}_h${h}: ${terms.join(' ')} = 0`);
    }
  });

  // Per-(lane, hour) total capacity: sum of modal flows ≤ lane capacity.
  chain.lanes.forEach((lane, laneIdx) => {
    for (let h = 0; h < T; h++) {
      const terms = MODES.map((m) => `+ ${xVar(laneIdx, m, h)}`).join(' ');
      lines.push(
        ` cap_l${laneIdx}_h${h}: ${terms} <= ${lane.capacity.perHour}`,
      );
    }
  });

  // Cumulative-with-shortfall demand per contract: for contract c at endpoint
  // with deadline D, all earlier-or-equal-deadline contracts at the same
  // endpoint must collectively have arrivals + cumulative shortfall ≥ qty sum.
  for (const [endpoint, list] of contractsByEndpoint) {
    const endpointIdx = nodeIdToIdx.get(endpoint);
    if (endpointIdx === undefined) {
      throw new Error(
        `Contract endpoint '${endpoint}' is not a non-origin node.`,
      );
    }
    let cumQty = 0;
    const cumShortfall: string[] = [];
    for (const { idx, dueByHour, quantity } of list) {
      if (dueByHour > T) {
        throw new Error(
          `Contract ${contracts[idx]!.id} due-by-hour ${dueByHour} exceeds horizon ${T}.`,
        );
      }
      cumQty += quantity;
      cumShortfall.push(`+ ${shortfallVar(idx)}`);
      const lhs = `${invVar(endpointIdx, dueByHour)} ${cumShortfall.join(' ')}`;
      lines.push(` dem_c${idx}: ${lhs} >= ${cumQty}`);
    }
  }

  // ---------- Bounds ----------
  lines.push('Bounds');
  // x and inv default to [0, +inf]. Cap the shortfall by contract quantity so
  // it can't run away above the only meaningful upper bound.
  contracts.forEach((c, cIdx) => {
    lines.push(` 0 <= ${shortfallVar(cIdx)} <= ${c.quantity}`);
  });

  lines.push('End');

  return {
    lp: lines.join('\n'),
    context: { laneIdxToLaneId, nodeIdToIdx, contractIdxToContractId },
  };
}

interface ParsedShipment {
  laneIdx: number;
  mode: Mode;
  releaseHour: number;
  quantity: number;
}

const X_VAR_RE = /^x_l(\d+)_(slow|fast)_h(\d+)$/;
const SF_VAR_RE = /^sf_c(\d+)$/;

interface ParsedSolution {
  shipments: ParsedShipment[];
  shortfallByContractIdx: Map<number, number>;
}

function parseSolution(
  columns: Record<string, { Primal: number }>,
): ParsedSolution {
  const shipments: ParsedShipment[] = [];
  const shortfallByContractIdx = new Map<number, number>();

  for (const [name, col] of Object.entries(columns)) {
    const xm = X_VAR_RE.exec(name);
    if (xm) {
      const qty = col.Primal;
      if (qty <= SOLUTION_EPSILON) continue;
      shipments.push({
        laneIdx: Number.parseInt(xm[1]!, 10),
        mode: xm[2] as Mode,
        releaseHour: Number.parseInt(xm[3]!, 10),
        quantity: qty,
      });
      continue;
    }
    const sm = SF_VAR_RE.exec(name);
    if (sm) {
      const idx = Number.parseInt(sm[1]!, 10);
      const v = col.Primal;
      if (v > SOLUTION_EPSILON) shortfallByContractIdx.set(idx, v);
    }
  }
  return { shipments, shortfallByContractIdx };
}

function buildPlan(
  parsed: ParsedSolution,
  totalCost: number,
  state: OptimizerState,
  context: LPContext,
): Plan {
  const contractsByEndpoint = new Map<string, typeof state.contracts>();
  for (const c of state.contracts) {
    const list = contractsByEndpoint.get(c.endpoint) ?? [];
    list.push(c);
    contractsByEndpoint.set(c.endpoint, list);
  }
  for (const list of contractsByEndpoint.values()) {
    list.sort((a, b) => a.dueByHour - b.dueByHour);
  }

  // Build shipment commitments and collect last-leg arrivals (per endpoint).
  const shipmentCommitments: ShipmentCommitment[] = [];
  const arrivalsByEndpoint = new Map<
    string,
    Array<{ arriveHour: number; quantity: number }>
  >();

  for (const ps of parsed.shipments) {
    const laneId = context.laneIdxToLaneId[ps.laneIdx]!;
    const lane = state.chain.lanes.find((l) => l.id === laneId)!;
    const isLastLeg = contractsByEndpoint.has(lane.to);
    const arriveHour = ps.releaseHour + lane.modes[ps.mode].transitHours;

    shipmentCommitments.push({
      laneId,
      mode: ps.mode,
      releaseHour: ps.releaseHour,
      quantity: ps.quantity,
      contractId: undefined,
    });

    if (isLastLeg) {
      const list = arrivalsByEndpoint.get(lane.to) ?? [];
      list.push({ arriveHour, quantity: ps.quantity });
      arrivalsByEndpoint.set(lane.to, list);
    }
  }

  // FIFO-by-deadline contract attribution at each endpoint, mirroring the
  // simulator's delivery-allocation policy.
  const deliveryCommitments: DeliveryCommitment[] = [];
  for (const [endpoint, arrivals] of arrivalsByEndpoint) {
    arrivals.sort((a, b) => a.arriveHour - b.arriveHour);
    const contractsHere = contractsByEndpoint.get(endpoint) ?? [];
    const remainingByContract = new Map<ContractId, number>();
    for (const c of contractsHere) remainingByContract.set(c.id, c.quantity);

    for (const arr of arrivals) {
      let remaining = arr.quantity;
      for (const c of contractsHere) {
        if (remaining <= SOLUTION_EPSILON) break;
        const need = remainingByContract.get(c.id) ?? 0;
        if (need <= SOLUTION_EPSILON) continue;
        const give = Math.min(need, remaining);
        remainingByContract.set(c.id, need - give);
        remaining -= give;
        deliveryCommitments.push({
          contractId: c.id,
          arriveHour: arr.arriveHour,
          quantity: give,
        });
      }
    }
  }

  const breachByContract: Record<ContractId, number> = {};
  for (const c of state.contracts) breachByContract[c.id] = 0;
  for (const [cIdx, v] of parsed.shortfallByContractIdx) {
    const cid = context.contractIdxToContractId[cIdx];
    if (cid !== undefined) breachByContract[cid] = v;
  }

  shipmentCommitments.sort(
    (a, b) =>
      a.releaseHour - b.releaseHour ||
      a.laneId.localeCompare(b.laneId) ||
      (a.mode === b.mode ? 0 : a.mode === 'slow' ? -1 : 1),
  );
  deliveryCommitments.sort(
    (a, b) =>
      a.arriveHour - b.arriveHour || a.contractId.localeCompare(b.contractId),
  );

  return {
    shipments: shipmentCommitments,
    deliveries: deliveryCommitments,
    totalCost,
    breachByContract,
  };
}

let cachedHighs: Awaited<ReturnType<typeof highsLoader>> | undefined;

async function getHighs(): Promise<Awaited<ReturnType<typeof highsLoader>>> {
  if (cachedHighs) return cachedHighs;
  const opts =
    typeof window !== 'undefined'
      ? { locateFile: (file: string) => `${import.meta.env.BASE_URL}${file}` }
      : undefined;
  cachedHighs = await highsLoader(opts);
  return cachedHighs;
}

export async function solve(state: OptimizerState): Promise<Plan> {
  validateState(state);
  const { lp, context } = buildLP(state);
  const highs = await getHighs();
  const sol = highs.solve(lp, { random_seed: 0, threads: 1 });

  if (sol.Status !== 'Optimal') {
    throw new Error(`Optimizer did not return Optimal status: ${sol.Status}`);
  }

  const parsed = parseSolution(sol.Columns);
  return buildPlan(parsed, sol.ObjectiveValue, state, context);
}

function validateState(state: OptimizerState): void {
  if (state.horizonHours <= 0) {
    throw new Error(`horizonHours must be > 0, got ${state.horizonHours}`);
  }
  if (state.currentHour < 0 || state.currentHour > state.horizonHours) {
    throw new Error(
      `currentHour ${state.currentHour} is out of [0, ${state.horizonHours}].`,
    );
  }
  assertLayeredDAG(state.chain);
}

function assertLayeredDAG(chain: Chain): void {
  const layerById = new Map(chain.nodes.map((n) => [n.id, n.layer]));
  for (const lane of chain.lanes) {
    const a = layerById.get(lane.from);
    const b = layerById.get(lane.to);
    if (a === undefined || b === undefined) {
      throw new Error(`Lane ${lane.id} references unknown nodes.`);
    }
    if (b !== a + 1) {
      throw new Error(
        `Lane ${lane.id} crosses non-adjacent layers (${a} -> ${b}); chain must be layered DAG.`,
      );
    }
  }
}
