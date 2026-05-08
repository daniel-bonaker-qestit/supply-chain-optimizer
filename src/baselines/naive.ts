import type {
  Chain,
  Contract,
  Lane,
  Plan,
  ShipmentCommitment,
  DeliveryCommitment,
} from '../domain/types.ts';

/** Hours of safety buffer the naive plan keeps before each contract deadline. */
const SAFETY_BUFFER_HOURS = 12;

interface NaiveInput {
  chain: Chain;
  contracts: Contract[];
  horizonHours: number;
}

/**
 * Deterministic non-optimizing strategy:
 *   - For every committed contract, ship slow mode along the (only) path.
 *   - Schedule shipments backward from the deadline with a fixed safety buffer.
 *   - Decline all opportunities (they aren't included in the input here).
 *   - No rerouting under events.
 */
export function buildNaivePlan(input: NaiveInput): Plan {
  const { chain, contracts, horizonHours } = input;

  const lanesByFrom = new Map<string, Lane[]>();
  for (const l of chain.lanes) {
    if (!lanesByFrom.has(l.from)) lanesByFrom.set(l.from, []);
    lanesByFrom.get(l.from)!.push(l);
  }

  const origin = chain.origins[0]!;

  const findPath = (endpoint: string): Lane[] => {
    const path: Lane[] = [];
    let current = origin;
    const guard = chain.nodes.length + 2;
    for (let i = 0; i < guard && current !== endpoint; i++) {
      const next = lanesByFrom.get(current);
      if (!next || next.length === 0) break;
      const lane = next[0]!;
      path.push(lane);
      current = lane.to;
    }
    return current === endpoint ? path : [];
  };

  const shipments: ShipmentCommitment[] = [];
  const deliveries: DeliveryCommitment[] = [];
  const breachByContract: Record<string, number> = {};

  for (const c of contracts) {
    breachByContract[c.id] = 0;
    if (c.kind === 'opportunity') {
      // Naive declines all opportunities.
      breachByContract[c.id] = 0;
      continue;
    }

    const path = findPath(c.endpoint);
    if (path.length === 0) {
      breachByContract[c.id] = c.quantity;
      continue;
    }
    const totalSlow = path.reduce(
      (s, l) => s + l.modes.slow.transitHours,
      0,
    );

    const scheduleSegment = (qty: number, deadline: number) => {
      const targetRelease = Math.max(
        0,
        deadline - SAFETY_BUFFER_HOURS - totalSlow,
      );
      let releaseHour = targetRelease;
      for (const lane of path) {
        if (releaseHour >= horizonHours) {
          breachByContract[c.id] = (breachByContract[c.id] ?? 0) + qty;
          return;
        }
        shipments.push({
          laneId: lane.id,
          mode: 'slow',
          releaseHour,
          quantity: qty,
          contractId: c.id,
        });
        releaseHour += lane.modes.slow.transitHours;
      }
      deliveries.push({
        contractId: c.id,
        arriveHour: releaseHour,
        quantity: qty,
      });
    };

    if (c.trial) {
      scheduleSegment(c.trial.quantity, c.trial.dueByHour);
      const mainQty = Math.max(0, c.quantity - c.trial.quantity);
      if (mainQty > 0) scheduleSegment(mainQty, c.dueByHour);
    } else {
      scheduleSegment(c.quantity, c.dueByHour);
    }
  }

  shipments.sort(
    (a, b) =>
      a.releaseHour - b.releaseHour ||
      a.laneId.localeCompare(b.laneId),
  );
  deliveries.sort((a, b) => a.arriveHour - b.arriveHour);

  return {
    shipments,
    deliveries,
    totalCost: 0, // simulator computes realized cost
    breachByContract,
  };
}
