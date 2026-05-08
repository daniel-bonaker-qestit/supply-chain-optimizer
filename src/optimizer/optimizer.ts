import highsLoader from 'highs';
import type {
  Chain,
  DeliveryCommitment,
  Plan,
  ShipmentCommitment,
} from '../domain/types.ts';
import type { OptimizerState } from './types.ts';

const SOLUTION_EPSILON = 1e-6;

interface LPContext {
  laneIdToIdx: Map<string, number>;
  laneIdxToLaneId: string[];
  nodeIdToIdx: Map<string, number>;
}

const xVar = (laneIdx: number, hour: number): string =>
  `x_l${laneIdx}_h${hour}`;
const invVar = (nodeIdx: number, hour: number): string =>
  `inv_n${nodeIdx}_h${hour}`;

function buildLP(state: OptimizerState): { lp: string; context: LPContext } {
  const { chain, contracts, horizonHours: T } = state;

  const originSet = new Set(chain.origins);
  const nonOriginNodes = chain.nodes.filter((n) => !originSet.has(n.id));

  const laneIdxToLaneId = chain.lanes.map((l) => l.id);
  const laneIdToIdx = new Map(chain.lanes.map((l, i) => [l.id, i]));
  const nodeIdToIdx = new Map(nonOriginNodes.map((n, i) => [n.id, i]));

  const incoming = new Map<string, number[]>();
  const outgoing = new Map<string, number[]>();
  chain.lanes.forEach((lane, idx) => {
    if (!incoming.has(lane.to)) incoming.set(lane.to, []);
    incoming.get(lane.to)!.push(idx);
    if (!outgoing.has(lane.from)) outgoing.set(lane.from, []);
    outgoing.get(lane.from)!.push(idx);
  });

  const lines: string[] = [];

  lines.push('Minimize');
  const objTerms: string[] = [];

  chain.lanes.forEach((lane, laneIdx) => {
    const cost = lane.modes.slow.costPerUnit;
    for (let h = 0; h < T; h++) {
      objTerms.push(`+ ${cost} ${xVar(laneIdx, h)}`);
    }
  });

  nonOriginNodes.forEach((node, nodeIdx) => {
    if (node.holdingCostPerUnitHour <= 0) return;
    for (let h = 1; h <= T; h++) {
      objTerms.push(`+ ${node.holdingCostPerUnitHour} ${invVar(nodeIdx, h)}`);
    }
  });

  if (objTerms.length === 0) {
    objTerms.push('+ 0 dummy');
  }
  lines.push(' obj: ' + objTerms.join(' '));

  lines.push('Subject To');

  nonOriginNodes.forEach((_node, nodeIdx) => {
    lines.push(` init_n${nodeIdx}: ${invVar(nodeIdx, 0)} = 0`);
  });

  nonOriginNodes.forEach((node, nodeIdx) => {
    for (let h = 0; h < T; h++) {
      const terms: string[] = [];
      terms.push(`+ ${invVar(nodeIdx, h + 1)}`);
      terms.push(`- ${invVar(nodeIdx, h)}`);

      for (const laneIdx of incoming.get(node.id) ?? []) {
        const lane = chain.lanes[laneIdx]!;
        const releaseHour = h - lane.modes.slow.transitHours;
        if (releaseHour >= 0) {
          terms.push(`- ${xVar(laneIdx, releaseHour)}`);
        }
      }
      for (const laneIdx of outgoing.get(node.id) ?? []) {
        terms.push(`+ ${xVar(laneIdx, h)}`);
      }
      lines.push(` flow_n${nodeIdx}_h${h}: ${terms.join(' ')} = 0`);
    }
  });

  contracts.forEach((c, cIdx) => {
    const endpointIdx = nodeIdToIdx.get(c.endpoint);
    if (endpointIdx === undefined) {
      throw new Error(
        `Contract ${c.id} endpoint '${c.endpoint}' is not a non-origin node in the chain.`,
      );
    }
    if (c.dueByHour > T) {
      throw new Error(
        `Contract ${c.id} due-by-hour ${c.dueByHour} exceeds horizon ${T}.`,
      );
    }
    lines.push(
      ` dem_c${cIdx}: ${invVar(endpointIdx, c.dueByHour)} >= ${c.quantity}`,
    );
  });

  lines.push('Bounds');
  chain.lanes.forEach((lane, laneIdx) => {
    const cap = lane.capacity.perHour;
    for (let h = 0; h < T; h++) {
      lines.push(` 0 <= ${xVar(laneIdx, h)} <= ${cap}`);
    }
  });

  lines.push('End');

  return {
    lp: lines.join('\n'),
    context: { laneIdToIdx, laneIdxToLaneId, nodeIdToIdx },
  };
}

interface ParsedShipment {
  laneIdx: number;
  releaseHour: number;
  quantity: number;
}

const X_VAR_RE = /^x_l(\d+)_h(\d+)$/;

function extractShipments(
  columns: Record<string, { Primal: number }>,
): ParsedShipment[] {
  const out: ParsedShipment[] = [];
  for (const [name, col] of Object.entries(columns)) {
    const m = X_VAR_RE.exec(name);
    if (!m) continue;
    const qty = col.Primal;
    if (qty <= SOLUTION_EPSILON) continue;
    out.push({
      laneIdx: Number.parseInt(m[1]!, 10),
      releaseHour: Number.parseInt(m[2]!, 10),
      quantity: qty,
    });
  }
  return out;
}

function buildPlan(
  shipments: ParsedShipment[],
  totalCost: number,
  state: OptimizerState,
  context: LPContext,
): Plan {
  const endpointToContractId = new Map<string, string>();
  for (const c of state.contracts) {
    endpointToContractId.set(c.endpoint, c.id);
  }

  const shipmentCommitments: ShipmentCommitment[] = [];
  const deliveryCommitments: DeliveryCommitment[] = [];

  for (const ps of shipments) {
    const laneId = context.laneIdxToLaneId[ps.laneIdx]!;
    const lane = state.chain.lanes.find((l) => l.id === laneId)!;
    const contractId = endpointToContractId.get(lane.to);

    shipmentCommitments.push({
      laneId,
      mode: 'slow',
      releaseHour: ps.releaseHour,
      quantity: ps.quantity,
      contractId,
    });

    if (contractId !== undefined) {
      deliveryCommitments.push({
        contractId,
        arriveHour: ps.releaseHour + lane.modes.slow.transitHours,
        quantity: ps.quantity,
      });
    }
  }

  shipmentCommitments.sort(
    (a, b) =>
      a.releaseHour - b.releaseHour || a.laneId.localeCompare(b.laneId),
  );
  deliveryCommitments.sort((a, b) => a.arriveHour - b.arriveHour);

  return {
    shipments: shipmentCommitments,
    deliveries: deliveryCommitments,
    totalCost,
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

  const shipments = extractShipments(sol.Columns);
  return buildPlan(shipments, sol.ObjectiveValue, state, context);
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
