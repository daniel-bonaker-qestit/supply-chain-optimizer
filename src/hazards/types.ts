import type { Mode } from '../domain/types.ts';

export type HazardType =
  | 'strike'
  | 'border-closure'
  | 'catastrophic-node-loss'
  | 'cyberattack'
  | 'sanctions'
  | 'pandemic'
  | 'weather-event'
  | 'equipment-recall';

export const ALL_HAZARD_TYPES: readonly HazardType[] = [
  'strike',
  'border-closure',
  'catastrophic-node-loss',
  'cyberattack',
  'sanctions',
  'pandemic',
  'weather-event',
  'equipment-recall',
] as const;

export interface Hazard {
  id: string;
  type: HazardType;
  injectedAtHour: number;
  durationHours: number;
  /** When true, the hazard persists through end of horizon regardless of `durationHours`. */
  persistThroughHorizon: boolean;
  /** Optional single node target (strike, catastrophic-node-loss, weather, pandemic origin). */
  targetNodeId?: string;
  /** Optional list of lane targets (border-closure, sanctions). */
  targetLaneIds?: string[];
  /** Capacity factor for capacity-reducing hazards (0 = closed). */
  capacityFactor?: number;
  /** Mode to block globally (equipment-recall). */
  blockMode?: Mode;
  /** True for cyberattack — sim suppresses replan during the window. */
  blocksReplans: boolean;
  description: string;
}
