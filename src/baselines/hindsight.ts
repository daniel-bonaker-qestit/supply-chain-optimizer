import type { Chain, Contract, Plan } from '../domain/types.ts';
import type { ActiveDisruption, SimEvent } from '../events/types.ts';
import type { Hazard } from '../hazards/types.ts';
import { expandContractsForOptimizer } from '../domain/contract-expansion.ts';
import { solve } from '../optimizer/optimizer.ts';

interface HindsightInput {
  chain: Chain;
  contracts: Contract[];
  horizonHours: number;
  events: readonly SimEvent[];
  hazards: readonly Hazard[];
}

/**
 * Build a Plan with full knowledge of the run's events + hazards baked in
 * upfront as ActiveDisruptions, then solved once. This represents the
 * "perfect hindsight" upper bound on optimizer performance.
 */
export async function buildHindsightPlan(
  input: HindsightInput,
): Promise<Plan> {
  const { chain, contracts, horizonHours, events, hazards } = input;

  const disruptions: ActiveDisruption[] = [
    ...eventsToDisruptions(events, horizonHours),
    ...hazardsToDisruptions(hazards, horizonHours),
  ];

  const { expanded } = expandContractsForOptimizer(contracts);
  const plan = await solve({
    chain,
    contracts: expanded,
    currentHour: 0,
    horizonHours,
    inFlight: [],
    delivered: {},
    currentInventory: {},
    activeDisruptions: disruptions,
  });
  return plan;
}

export function eventsToDisruptions(
  events: readonly SimEvent[],
  horizonHours: number,
): ActiveDisruption[] {
  void horizonHours;
  const out: ActiveDisruption[] = [];
  let n = 0;
  for (const e of events) {
    const fromHour = e.fireHour;
    const toHour = e.fireHour + e.durationHours;
    const baseId = `hsd-${e.id}`;
    const push = (
      d: Omit<ActiveDisruption, 'id' | 'source' | 'sourceId' | 'fromHour' | 'toHour'>,
    ) => {
      out.push({
        id: `${baseId}-${n++}`,
        source: 'event',
        sourceId: e.id,
        fromHour,
        toHour,
        ...d,
      });
    };
    switch (e.type) {
      case 'origin-warehouse-delay':
      case 'contamination-alert':
      case 'regulatory-hold':
      case 'customs-hold':
      case 'esd-exception':
        if (e.targetNodeId) {
          push({
            nodeId: e.targetNodeId,
            effectKind:
              (e.capacityFactor ?? 0) === 0 ? 'block' : 'capacity-factor',
            capacityFactor: e.capacityFactor,
          });
        }
        break;
      case 'lane-disruption':
        if (e.targetLaneId) {
          push({
            laneId: e.targetLaneId,
            effectKind:
              (e.capacityFactor ?? 0) === 0 ? 'block' : 'capacity-factor',
            capacityFactor: e.capacityFactor,
          });
        }
        break;
      case 'mode-disruption':
        if (e.targetLaneId && e.blockMode) {
          push({
            laneId: e.targetLaneId,
            mode: e.blockMode,
            effectKind: 'block',
          });
        }
        break;
      case 'price-spike':
        if (e.targetLaneId) {
          push({
            laneId: e.targetLaneId,
            mode: e.targetMode,
            effectKind: 'price-multiplier',
            priceMultiplier: e.priceMultiplier,
          });
        }
        break;
      case 'spoilage-incident':
      case 'refrigeration-failure':
      case 'opportunity-arrival':
        // No LP-side disruption (per-shipment / new-contract effects).
        break;
    }
  }
  return out;
}

export function hazardsToDisruptions(
  hazards: readonly Hazard[],
  horizonHours: number,
): ActiveDisruption[] {
  const out: ActiveDisruption[] = [];
  let n = 0;
  for (const h of hazards) {
    const fromHour = h.injectedAtHour;
    const toHour = h.persistThroughHorizon
      ? horizonHours
      : h.injectedAtHour + h.durationHours;
    const baseId = `hsd-${h.id}`;
    const push = (
      d: Omit<ActiveDisruption, 'id' | 'source' | 'sourceId' | 'fromHour' | 'toHour'>,
    ) => {
      out.push({
        id: `${baseId}-${n++}`,
        source: 'hazard',
        sourceId: h.id,
        fromHour,
        toHour,
        ...d,
      });
    };
    switch (h.type) {
      case 'strike':
      case 'catastrophic-node-loss':
      case 'weather-event':
        if (h.targetNodeId) {
          push({
            nodeId: h.targetNodeId,
            effectKind:
              (h.capacityFactor ?? 0) === 0 ? 'block' : 'capacity-factor',
            capacityFactor: h.capacityFactor,
          });
        }
        break;
      case 'border-closure':
      case 'sanctions':
        for (const lid of h.targetLaneIds ?? []) {
          push({
            laneId: lid,
            effectKind:
              (h.capacityFactor ?? 0) === 0 ? 'block' : 'capacity-factor',
            capacityFactor: h.capacityFactor,
          });
        }
        break;
      case 'pandemic':
        push({
          effectKind: 'capacity-factor',
          capacityFactor: h.capacityFactor,
        });
        break;
      case 'equipment-recall':
        if (h.blockMode) {
          push({ mode: h.blockMode, effectKind: 'block' });
        }
        break;
      case 'cyberattack':
        // Visibility-only effect; no LP-side disruption.
        break;
    }
  }
  return out;
}
