import type { Chain, Sector } from '../domain/types.ts';
import { mulberry32, pick, rangeFloat, rangeInt, type Rng } from '../util/rng.ts';
import { ALL_HAZARD_TYPES, type Hazard, type HazardType } from './types.ts';

interface PickHazardInput {
  sector: Sector;
  chain: Chain;
  currentHour: number;
  horizonHours: number;
  rng?: Rng;
  /** Force a specific hazard type (used by tests). */
  type?: HazardType;
}

let hazardSeq = 0;

export function pickHazard(input: PickHazardInput): Hazard {
  const rng = input.rng ?? mulberry32(Date.now() & 0xffffffff);
  const type = input.type ?? pick(rng, ALL_HAZARD_TYPES);
  const seq = ++hazardSeq;
  const id = `haz-${seq.toString().padStart(4, '0')}`;
  const remaining = Math.max(1, input.horizonHours - input.currentHour);

  const lanes = input.chain.lanes;
  const originSet = new Set(input.chain.origins);
  const nonOriginNodes = input.chain.nodes.filter(
    (n) => !originSet.has(n.id),
  );

  switch (type) {
    case 'strike': {
      const node = pick(rng, nonOriginNodes);
      const dur = rangeInt(rng, 24, Math.min(72, remaining));
      return {
        id,
        type,
        injectedAtHour: input.currentHour,
        durationHours: dur,
        persistThroughHorizon: false,
        targetNodeId: node.id,
        capacityFactor: 0,
        blocksReplans: false,
        description: `Strike at ${node.id} for ${dur}h (outbound halted)`,
      };
    }
    case 'border-closure': {
      const sample = pickSample(rng, lanes, Math.min(2, lanes.length));
      const dur = rangeInt(rng, 24, Math.min(48, remaining));
      return {
        id,
        type,
        injectedAtHour: input.currentHour,
        durationHours: dur,
        persistThroughHorizon: false,
        targetLaneIds: sample.map((l) => l.id),
        capacityFactor: 0,
        blocksReplans: false,
        description: `Border closure on ${sample.map((l) => l.id).join(', ')} for ${dur}h`,
      };
    }
    case 'catastrophic-node-loss': {
      const node = pick(rng, nonOriginNodes);
      return {
        id,
        type,
        injectedAtHour: input.currentHour,
        durationHours: remaining,
        persistThroughHorizon: true,
        targetNodeId: node.id,
        capacityFactor: 0,
        blocksReplans: false,
        description: `Catastrophic loss of ${node.id} for the remaining horizon`,
      };
    }
    case 'cyberattack': {
      const dur = rangeInt(rng, 12, Math.min(36, remaining));
      return {
        id,
        type,
        injectedAtHour: input.currentHour,
        durationHours: dur,
        persistThroughHorizon: false,
        blocksReplans: true,
        description: `Cyberattack — visibility blackout for ${dur}h (replans suppressed)`,
      };
    }
    case 'sanctions': {
      const sample = pickSample(rng, lanes, Math.max(1, Math.floor(lanes.length / 3)));
      return {
        id,
        type,
        injectedAtHour: input.currentHour,
        durationHours: remaining,
        persistThroughHorizon: true,
        targetLaneIds: sample.map((l) => l.id),
        capacityFactor: 0,
        blocksReplans: false,
        description: `Sanctions on ${sample.map((l) => l.id).join(', ')} for the remaining horizon`,
      };
    }
    case 'pandemic': {
      const factor = rangeFloat(rng, 0.3, 0.5);
      const dur = rangeInt(rng, 48, Math.min(120, remaining));
      return {
        id,
        type,
        injectedAtHour: input.currentHour,
        durationHours: dur,
        persistThroughHorizon: false,
        capacityFactor: factor,
        blocksReplans: false,
        description: `Pandemic — global capacity drag (×${factor.toFixed(2)}) for ${dur}h`,
      };
    }
    case 'weather-event': {
      const node = pick(rng, nonOriginNodes);
      const factor = rangeFloat(rng, 0, 0.3);
      const dur = rangeInt(rng, 12, Math.min(36, remaining));
      return {
        id,
        type,
        injectedAtHour: input.currentHour,
        durationHours: dur,
        persistThroughHorizon: false,
        targetNodeId: node.id,
        capacityFactor: factor,
        blocksReplans: false,
        description: `Weather event at ${node.id} for ${dur}h (×${factor.toFixed(2)})`,
      };
    }
    case 'equipment-recall': {
      const dur = rangeInt(rng, 24, Math.min(72, remaining));
      return {
        id,
        type,
        injectedAtHour: input.currentHour,
        durationHours: dur,
        persistThroughHorizon: false,
        blockMode: 'fast',
        blocksReplans: false,
        description: `Equipment recall — fast mode grounded globally for ${dur}h`,
      };
    }
  }
}

function pickSample<T>(rng: Rng, items: readonly T[], count: number): T[] {
  if (count >= items.length) return [...items];
  const indices = new Set<number>();
  while (indices.size < count) indices.add(Math.floor(rng() * items.length));
  return [...indices].map((i) => items[i]!);
}
