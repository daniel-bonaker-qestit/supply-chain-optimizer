import type { Contract, Mode, Sector } from '../domain/types.ts';

export type EventType =
  | 'origin-warehouse-delay'
  | 'lane-disruption'
  | 'mode-disruption'
  | 'price-spike'
  | 'spoilage-incident'
  | 'contamination-alert'
  | 'opportunity-arrival';

export interface SimEvent {
  id: string;
  type: EventType;
  /** Sim hour at which the event fires. */
  fireHour: number;
  /** How long the effect persists (hours). */
  durationHours: number;
  /** Optional lane the event targets. */
  targetLaneId?: string;
  /** Optional node the event targets. */
  targetNodeId?: string;
  /** Optional mode the event targets. */
  targetMode?: Mode;
  /** Optional shipment ref — only used by quality-state events (slice 5+). */
  targetShipmentHint?: string;
  /** Capacity factor in [0, 1] for capacity-reduction events (0 = closed). */
  capacityFactor?: number;
  /** Multiplier for price-spike (e.g., 1.5 = +50%). */
  priceMultiplier?: number;
  /** Mode to block for mode-disruption. */
  blockMode?: Mode;
  /** Opportunity contract attached to an opportunity-arrival event. */
  opportunityContract?: Contract;
  /** Human-readable description for the event log. */
  description: string;
  sector: Sector;
}

/** Active disruption derived from events / hazards, consumed by the optimizer. */
export interface ActiveDisruption {
  id: string;
  source: 'event' | 'hazard';
  /** Which event/hazard this disruption was derived from. */
  sourceId: string;
  /** Hour the disruption begins (inclusive). */
  fromHour: number;
  /** Hour the disruption ends (exclusive). */
  toHour: number;
  /** Optional lane the disruption applies to. */
  laneId?: string;
  /** Optional mode the disruption applies to. */
  mode?: Mode;
  /** Optional source node — disruption applies to all outgoing lanes from this node. */
  nodeId?: string;
  /** When 'block', cap = 0. When 'capacity-factor', cap *= factor. When 'price-multiplier', cost *= multiplier. */
  effectKind: 'block' | 'capacity-factor' | 'price-multiplier';
  capacityFactor?: number;
  priceMultiplier?: number;
}
