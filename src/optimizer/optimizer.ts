import highsLoader from 'highs';
import type {
  Chain,
  Contract,
  ContractId,
  DeliveryCommitment,
  Mode,
  NodeId,
  Plan,
  ShipmentCommitment,
} from '../domain/types.ts';
import type { ActiveDisruption } from '../events/types.ts';
import type { OptimizerState } from './types.ts';

const SOLUTION_EPSILON = 1e-6;
const MODES: readonly Mode[] = ['slow', 'fast'] as const;

export const BREACH_PENALTY_PER_UNIT = 500;

interface LPContext {
  laneIdxToLaneId: string[];
  nonOriginNodeIds: NodeId[];
  nodeIdToIdx: Map<NodeId, number>;
  contractIdxToContractId: ContractId[];
  /** Sim hour at which this LP was built. */
  currentHour: number;
  /** Map originalId → oppIdx for opportunities with accept binaries. */
  oppOriginalToIdx: Map<ContractId, number>;
  /** Pending opportunity originals in their declared order. */
  pendingOpportunityOriginals: ContractId[];
}

const xVar = (laneIdx: number, mode: Mode, hour: number): string =>
  `x_l${laneIdx}_${mode}_h${hour}`;
const invVar = (nodeIdx: number, hour: number): string =>
  `inv_n${nodeIdx}_h${hour}`;
const deliveredVar = (cIdx: number): string => `d_c${cIdx}`;
const sfVar = (cIdx: number): string => `sf_c${cIdx}`;
const acceptVar = (oppIdx: number): string => `acc_o${oppIdx}`;

interface DisruptionMatch {
  /** Effective capacity multiplier (1 = unaffected, 0 = blocked). */
  capFactor: number;
  /** Effective price multiplier (1 = unaffected). */
  priceMul: number;
}

function applyDisruptions(
  laneId: string,
  laneFromNode: string,
  mode: Mode,
  hour: number,
  disruptions: readonly ActiveDisruption[],
): DisruptionMatch {
  let capFactor = 1;
  let priceMul = 1;
  for (const d of disruptions) {
    if (hour < d.fromHour || hour >= d.toHour) continue;
    if (d.laneId !== undefined && d.laneId !== laneId) continue;
    if (d.mode !== undefined && d.mode !== mode) continue;
    if (d.nodeId !== undefined && d.nodeId !== laneFromNode) continue;
    if (d.effectKind === 'block') {
      capFactor = 0;
    } else if (d.effectKind === 'capacity-factor') {
      capFactor *= d.capacityFactor ?? 1;
    } else if (d.effectKind === 'price-multiplier') {
      priceMul *= d.priceMultiplier ?? 1;
    }
  }
  return { capFactor, priceMul };
}

interface BuiltLP {
  lp: string;
  context: LPContext;
}

function buildLP(state: OptimizerState): BuiltLP {
  const { chain, contracts, currentHour, horizonHours: T } = state;
  const inFlight = state.inFlight ?? [];
  const delivered = state.delivered ?? {};
  const currentInventory = state.currentInventory ?? {};
  const disruptions: readonly ActiveDisruption[] =
    state.activeDisruptions ?? [];
  const pendingOriginals = new Set(state.pendingOpportunityIds ?? []);
  const subToOriginal = state.subToOriginal ?? {};
  const isPendingForContract = (c: Contract): boolean => {
    const orig = subToOriginal[c.id] ?? c.id;
    return pendingOriginals.has(orig);
  };
  const originalIdForContract = (c: Contract): ContractId =>
    subToOriginal[c.id] ?? c.id;

  const originSet = new Set(chain.origins);
  const nonOriginNodes = chain.nodes.filter((n) => !originSet.has(n.id));
  const nonOriginNodeIds = nonOriginNodes.map((n) => n.id);
  const nodeIdToIdx = new Map(nonOriginNodes.map((n, i) => [n.id, i]));

  const incoming = new Map<string, number[]>();
  const outgoing = new Map<string, number[]>();
  chain.lanes.forEach((lane, idx) => {
    if (!incoming.has(lane.to)) incoming.set(lane.to, []);
    incoming.get(lane.to)!.push(idx);
    if (!outgoing.has(lane.from)) outgoing.set(lane.from, []);
    outgoing.get(lane.from)!.push(idx);
  });

  // Active vs locked contracts.
  const activeContracts: Array<{
    idx: number;
    c: Contract;
    remaining: number;
    isPending: boolean;
    originalId: ContractId;
  }> = [];
  contracts.forEach((c, idx) => {
    if (c.dueByHour <= currentHour) return; // locked: handled in plan output
    const got = delivered[c.id] ?? 0;
    activeContracts.push({
      idx,
      c,
      remaining: Math.max(0, c.quantity - got),
      isPending: isPendingForContract(c),
      originalId: originalIdForContract(c),
    });
  });

  // Pending opportunity originals → oppIdx.
  const pendingOriginalsList: ContractId[] = [];
  const oppOriginalToIdx = new Map<ContractId, number>();
  for (const ac of activeContracts) {
    if (!ac.isPending) continue;
    if (oppOriginalToIdx.has(ac.originalId)) continue;
    oppOriginalToIdx.set(ac.originalId, pendingOriginalsList.length);
    pendingOriginalsList.push(ac.originalId);
  }

  const activeByEndpoint = new Map<
    string,
    Array<(typeof activeContracts)[number]>
  >();
  for (const ac of activeContracts) {
    if (!activeByEndpoint.has(ac.c.endpoint)) {
      activeByEndpoint.set(ac.c.endpoint, []);
    }
    activeByEndpoint.get(ac.c.endpoint)!.push(ac);
  }
  for (const list of activeByEndpoint.values()) {
    list.sort((a, b) => a.c.dueByHour - b.c.dueByHour || a.idx - b.idx);
  }

  // Pre-baked arrivals from in-flight shipments per (node, hour).
  const inFlightArrivals = new Map<string, Map<number, number>>();
  for (const s of inFlight) {
    if (s.arrivesAtHour < currentHour || s.arrivesAtHour >= T) continue;
    const lane = chain.lanes.find((l) => l.id === s.laneId);
    if (!lane) continue;
    if (!inFlightArrivals.has(lane.to)) inFlightArrivals.set(lane.to, new Map());
    const m = inFlightArrivals.get(lane.to)!;
    m.set(s.arrivesAtHour, (m.get(s.arrivesAtHour) ?? 0) + s.quantity);
  }

  const lines: string[] = [];

  // ---------- Objective ----------
  lines.push('Minimize');
  const objTerms: string[] = [];

  chain.lanes.forEach((lane, laneIdx) => {
    for (const mode of MODES) {
      const baseCost = lane.modes[mode].costPerUnit;
      for (let h = currentHour; h < T; h++) {
        const eff = applyDisruptions(
          lane.id,
          lane.from,
          mode,
          h,
          disruptions,
        );
        const cost = baseCost * eff.priceMul;
        if (cost === 0) continue;
        objTerms.push(`+ ${cost} ${xVar(laneIdx, mode, h)}`);
      }
    }
  });

  nonOriginNodes.forEach((node, nodeIdx) => {
    if (node.holdingCostPerUnitHour <= 0) return;
    for (let h = currentHour + 1; h <= T; h++) {
      objTerms.push(`+ ${node.holdingCostPerUnitHour} ${invVar(nodeIdx, h)}`);
    }
  });

  // For non-pending active contracts (committed or already-accepted opportunities):
  // minimize -breach * delivered (with sf = remaining - delivered implicit).
  // For pending opportunities: minimize -revenue * delivered + breach * sf.
  for (const ac of activeContracts) {
    if (ac.isPending) {
      objTerms.push(`- ${ac.c.revenue} ${deliveredVar(ac.idx)}`);
      objTerms.push(`+ ${BREACH_PENALTY_PER_UNIT} ${sfVar(ac.idx)}`);
    } else {
      objTerms.push(`- ${BREACH_PENALTY_PER_UNIT} ${deliveredVar(ac.idx)}`);
    }
  }

  if (objTerms.length === 0) objTerms.push('+ 0 dummy');
  lines.push(' obj: ' + objTerms.join(' '));

  // ---------- Constraints ----------
  lines.push('Subject To');

  // Initial inventory conditions at currentHour for each non-origin node.
  // Clamp to ≥ 0 to absorb floating-point drift from sim-time accounting.
  nonOriginNodes.forEach((node, nodeIdx) => {
    const initVal = Math.max(0, currentInventory[node.id] ?? 0);
    lines.push(` init_n${nodeIdx}: ${invVar(nodeIdx, currentHour)} = ${initVal}`);
  });

  // Flow balance per (non-origin n, h ∈ [currentHour, T-1]).
  nonOriginNodes.forEach((node, nodeIdx) => {
    for (let h = currentHour; h < T; h++) {
      const terms: string[] = [];
      terms.push(`+ ${invVar(nodeIdx, h + 1)}`);
      terms.push(`- ${invVar(nodeIdx, h)}`);

      // Arrivals at h: from new shipments scheduled in this LP.
      for (const laneIdx of incoming.get(node.id) ?? []) {
        const lane = chain.lanes[laneIdx]!;
        for (const mode of MODES) {
          const releaseHour = h - lane.modes[mode].transitHours;
          if (releaseHour >= currentHour) {
            terms.push(`- ${xVar(laneIdx, mode, releaseHour)}`);
          }
        }
      }
      // Departures at h: outgoing lanes from this node.
      for (const laneIdx of outgoing.get(node.id) ?? []) {
        for (const mode of MODES) {
          terms.push(`+ ${xVar(laneIdx, mode, h)}`);
        }
      }

      // Pre-baked in-flight arrivals at this (node, hour) become a constant rhs term.
      const ifArr = inFlightArrivals.get(node.id)?.get(h) ?? 0;
      lines.push(
        ` flow_n${nodeIdx}_h${h}: ${terms.join(' ')} = ${ifArr.toFixed(6)}`,
      );
    }
  });

  // Per-(lane, mode, hour) capacity bound (0 when blocked).
  // Per-(lane, hour) sum-of-modes capacity bound (lane-level + node-level disruptions).
  chain.lanes.forEach((lane, laneIdx) => {
    for (let h = currentHour; h < T; h++) {
      // Per-mode upper bounds via individual constraints (default lane.capacity.perHour
      // unless mode-block disruption applies).
      let laneCapAtH = lane.capacity.perHour;
      let laneBlockedSum = false;
      // For lane-level / node-level capacity factors that don't specify a mode,
      // use the most-restrictive across both modes.
      const checkLane = applyDisruptions(
        lane.id,
        lane.from,
        'slow', // mode is irrelevant for lane/node-level checks
        h,
        disruptions.filter(
          (d) => d.mode === undefined,
        ),
      );
      if (checkLane.capFactor === 0) {
        laneBlockedSum = true;
      } else {
        laneCapAtH *= checkLane.capFactor;
      }

      for (const mode of MODES) {
        const eff = applyDisruptions(
          lane.id,
          lane.from,
          mode,
          h,
          disruptions,
        );
        const cap =
          eff.capFactor === 0
            ? 0
            : lane.capacity.perHour * eff.capFactor;
        // Enforce per-(lane, mode, hour) upper bound.
        lines.push(
          ` mc_l${laneIdx}_${mode}_h${h}: ${xVar(laneIdx, mode, h)} <= ${cap}`,
        );
      }

      // Sum-of-modes capacity (effective lane cap considering lane/node-level effects).
      const sumTerms = MODES.map((m) => `+ ${xVar(laneIdx, m, h)}`).join(' ');
      const sumCap = laneBlockedSum ? 0 : laneCapAtH;
      lines.push(` cap_l${laneIdx}_h${h}: ${sumTerms} <= ${sumCap}`);
    }
  });

  // Endpoint capacity per active deadline:
  // sum(delivered_<c'> for c' at e with currentHour < dueByHour' ≤ D, active)
  //   ≤ inv_<e>_<D> - inv_<e>_<currentHour>.
  for (const [endpoint, list] of activeByEndpoint) {
    const endpointIdx = nodeIdToIdx.get(endpoint);
    if (endpointIdx === undefined) {
      throw new Error(
        `Contract endpoint '${endpoint}' is not a non-origin node.`,
      );
    }
    const initRef = invVar(endpointIdx, currentHour);
    const cumDelivered: string[] = [];
    for (const ac of list) {
      const D = ac.c.dueByHour;
      if (D > T) {
        throw new Error(
          `Contract ${ac.c.id} due-by-hour ${D} exceeds horizon ${T}.`,
        );
      }
      cumDelivered.push(`+ ${deliveredVar(ac.idx)}`);
      // sum delivered ≤ inv_e_D - inv_e_currentHour
      // → sum delivered + inv_e_currentHour - inv_e_D ≤ 0
      const lhs = `${cumDelivered.join(' ')} + ${initRef} - ${invVar(endpointIdx, D)}`;
      lines.push(` ec_c${ac.idx}: ${lhs} <= 0`);
    }
  }

  // Pending-opportunity linking constraints:
  // delivered_<c> + sf_<c> = c.quantity * accept_<O>  (per sub-contract of a pending opp)
  for (const ac of activeContracts) {
    if (!ac.isPending) continue;
    const oppIdx = oppOriginalToIdx.get(ac.originalId)!;
    // Linking equality. CPLEX LP: lhs - rhs = 0:
    // delivered + sf - quantity * accept = 0
    lines.push(
      ` opl_${ac.idx}: ${deliveredVar(ac.idx)} + ${sfVar(ac.idx)} - ${ac.c.quantity} ${acceptVar(oppIdx)} = 0`,
    );
  }

  // ---------- Bounds ----------
  lines.push('Bounds');
  for (const ac of activeContracts) {
    if (ac.isPending) {
      // delivered ≤ c.quantity (linking constraint forces delivered=0 when accept=0)
      lines.push(` 0 <= ${deliveredVar(ac.idx)} <= ${ac.c.quantity}`);
      lines.push(` 0 <= ${sfVar(ac.idx)} <= ${ac.c.quantity}`);
    } else {
      lines.push(` 0 <= ${deliveredVar(ac.idx)} <= ${ac.remaining}`);
    }
  }
  // Accept binaries:
  for (let i = 0; i < pendingOriginalsList.length; i++) {
    lines.push(` 0 <= ${acceptVar(i)} <= 1`);
  }
  if (pendingOriginalsList.length > 0) {
    lines.push('Binary');
    for (let i = 0; i < pendingOriginalsList.length; i++) {
      lines.push(` ${acceptVar(i)}`);
    }
  }
  // Allow inv_<n>_<h> to take any non-negative value (default LB=0).
  // The init constraint pins inv_<n>_<currentHour> exactly. CPLEX needs the
  // pinned value to be within [LB, UB]; default LB=0, UB=+inf accepts any
  // non-negative initial inventory.

  lines.push('End');

  return {
    lp: lines.join('\n'),
    context: {
      laneIdxToLaneId: chain.lanes.map((l) => l.id),
      nonOriginNodeIds,
      nodeIdToIdx,
      contractIdxToContractId: contracts.map((c) => c.id),
      currentHour,
      oppOriginalToIdx,
      pendingOpportunityOriginals: pendingOriginalsList,
    },
  };
}

interface ParsedShipment {
  laneIdx: number;
  mode: Mode;
  releaseHour: number;
  quantity: number;
}

const X_VAR_RE = /^x_l(\d+)_(slow|fast)_h(\d+)$/;
const D_VAR_RE = /^d_c(\d+)$/;
const ACC_VAR_RE = /^acc_o(\d+)$/;

interface ParsedSolution {
  shipments: ParsedShipment[];
  deliveredByContractIdx: Map<number, number>;
  acceptByOppIdx: Map<number, number>;
}

function parseSolution(
  columns: Record<string, { Primal: number }>,
): ParsedSolution {
  const shipments: ParsedShipment[] = [];
  const deliveredByContractIdx = new Map<number, number>();
  const acceptByOppIdx = new Map<number, number>();

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
    const dm = D_VAR_RE.exec(name);
    if (dm) {
      deliveredByContractIdx.set(
        Number.parseInt(dm[1]!, 10),
        Math.max(0, col.Primal),
      );
      continue;
    }
    const am = ACC_VAR_RE.exec(name);
    if (am) {
      acceptByOppIdx.set(Number.parseInt(am[1]!, 10), col.Primal);
    }
  }
  return { shipments, deliveredByContractIdx, acceptByOppIdx };
}

function buildPlan(
  parsed: ParsedSolution,
  totalCost: number,
  state: OptimizerState,
  context: LPContext,
): Plan {
  const contractsByEndpoint = new Map<string, Contract[]>();
  for (const c of state.contracts) {
    const list = contractsByEndpoint.get(c.endpoint) ?? [];
    list.push(c);
    contractsByEndpoint.set(c.endpoint, list);
  }
  for (const list of contractsByEndpoint.values()) {
    list.sort((a, b) => a.dueByHour - b.dueByHour);
  }

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
  // simulator's delivery-allocation policy. Skip past-deadline contracts.
  const deliveryCommitments: DeliveryCommitment[] = [];
  const delivered = state.delivered ?? {};
  for (const [endpoint, arrivals] of arrivalsByEndpoint) {
    arrivals.sort((a, b) => a.arriveHour - b.arriveHour);
    const contractsHere = contractsByEndpoint.get(endpoint) ?? [];
    const remainingByContract = new Map<ContractId, number>();
    for (const c of contractsHere) {
      const got = delivered[c.id] ?? 0;
      remainingByContract.set(c.id, Math.max(0, c.quantity - got));
    }

    for (const arr of arrivals) {
      let remaining = arr.quantity;
      for (const c of contractsHere) {
        if (remaining <= SOLUTION_EPSILON) break;
        // Skip past-deadline contracts.
        if (c.dueByHour <= arr.arriveHour) continue;
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

  // Compute breach per contract.
  const breachByContract: Record<ContractId, number> = {};
  for (const c of state.contracts) {
    const got = delivered[c.id] ?? 0;
    if (c.dueByHour <= state.currentHour) {
      // Locked.
      breachByContract[c.id] = Math.max(0, c.quantity - got);
    } else {
      const cIdx = state.contracts.indexOf(c);
      const planDelivered = parsed.deliveredByContractIdx.get(cIdx) ?? 0;
      const remaining = Math.max(0, c.quantity - got);
      breachByContract[c.id] = Math.max(0, remaining - planDelivered);
    }
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

  // Determine which pending opportunities the LP accepted vs declined.
  const acceptedOpportunityIds: ContractId[] = [];
  const declinedOpportunityIds: ContractId[] = [];
  for (const [origId, oppIdx] of context.oppOriginalToIdx) {
    const v = parsed.acceptByOppIdx.get(oppIdx) ?? 0;
    if (v > 0.5) acceptedOpportunityIds.push(origId);
    else declinedOpportunityIds.push(origId);
  }

  void totalCost;
  return {
    shipments: shipmentCommitments,
    deliveries: deliveryCommitments,
    totalCost: computeTrueCost(state, parsed, breachByContract, context),
    breachByContract,
    acceptedOpportunityIds,
    declinedOpportunityIds,
  };
}

function computeTrueCost(
  state: OptimizerState,
  parsed: ParsedSolution,
  breachByContract: Record<ContractId, number>,
  context: LPContext,
): number {
  const disruptions = state.activeDisruptions ?? [];
  let transport = 0;
  let holding = 0;

  for (const ps of parsed.shipments) {
    const laneId = context.laneIdxToLaneId[ps.laneIdx]!;
    const lane = state.chain.lanes.find((l) => l.id === laneId)!;
    const eff = applyDisruptions(
      lane.id,
      lane.from,
      ps.mode,
      ps.releaseHour,
      disruptions,
    );
    transport += ps.quantity * lane.modes[ps.mode].costPerUnit * eff.priceMul;
  }

  // Holding cost: derive future inventory at non-origin nodes through hour-by-hour
  // simulation of arrivals/departures from the planned shipments + in-flight + initial.
  holding = computeHoldingCost(state, parsed, context);

  const breach = Object.values(breachByContract).reduce(
    (sum, v) => sum + v,
    0,
  );
  return transport + holding + BREACH_PENALTY_PER_UNIT * breach;
}

function computeHoldingCost(
  state: OptimizerState,
  parsed: ParsedSolution,
  context: LPContext,
): number {
  const { chain, currentHour, horizonHours: T } = state;
  const inFlight = state.inFlight ?? [];
  const currentInventory = state.currentInventory ?? {};

  const originSet = new Set(chain.origins);
  const nonOriginNodes = chain.nodes.filter((n) => !originSet.has(n.id));

  // Build per-(node, hour) arrival/departure schedules.
  const inv = new Map<NodeId, number[]>();
  for (const n of nonOriginNodes) {
    const arr = new Array<number>(T - currentHour + 1).fill(0);
    arr[0] = currentInventory[n.id] ?? 0;
    inv.set(n.id, arr);
  }

  const addArrival = (node: NodeId, hour: number, qty: number) => {
    const arr = inv.get(node);
    if (!arr) return;
    const idx = hour - currentHour + 1; // arrivals at hour h appear in inv[h+1]
    if (idx >= 0 && idx < arr.length) arr[idx] = (arr[idx] ?? 0) + qty;
  };
  const addDeparture = (node: NodeId, hour: number, qty: number) => {
    const arr = inv.get(node);
    if (!arr) return;
    const idx = hour - currentHour + 1;
    if (idx >= 0 && idx < arr.length) arr[idx] = (arr[idx] ?? 0) - qty;
  };

  // Pre-baked in-flight arrivals.
  for (const s of inFlight) {
    if (s.arrivesAtHour < currentHour || s.arrivesAtHour >= T) continue;
    const lane = chain.lanes.find((l) => l.id === s.laneId);
    if (!lane) continue;
    addArrival(lane.to, s.arrivesAtHour, s.quantity);
  }

  // Planned shipments' arrivals & departures.
  for (const ps of parsed.shipments) {
    const laneId = context.laneIdxToLaneId[ps.laneIdx]!;
    const lane = chain.lanes.find((l) => l.id === laneId)!;
    addDeparture(lane.from, ps.releaseHour, ps.quantity);
    addArrival(
      lane.to,
      ps.releaseHour + lane.modes[ps.mode].transitHours,
      ps.quantity,
    );
  }

  let total = 0;
  for (const n of nonOriginNodes) {
    if (n.holdingCostPerUnitHour <= 0) continue;
    const arr = inv.get(n.id)!;
    let level = arr[0] ?? 0;
    // Holding cost accrues against end-of-hour inventory, summed for hours
    // currentHour..T-1. arr index 0 is at currentHour; arr index 1 is end-of-currentHour.
    for (let i = 1; i < arr.length; i++) {
      level += arr[i] ?? 0;
      if (level > 0) total += level * n.holdingCostPerUnitHour;
    }
  }

  return total;
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

