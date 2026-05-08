import type { Chain, Mode, Sector } from '../domain/types.ts';
import {
  pick,
  rangeFloat,
  rangeInt,
  rngFromSeed,
  type Rng,
} from '../util/rng.ts';
import type { EventType, SimEvent } from './types.ts';

const SHARED_TYPES: EventType[] = [
  'origin-warehouse-delay',
  'lane-disruption',
  'mode-disruption',
  'price-spike',
];

const FOOD_TYPES: EventType[] = ['spoilage-incident', 'contamination-alert'];
const PHARMA_TYPES: EventType[] = ['refrigeration-failure', 'regulatory-hold'];

const SECTOR_TYPES: Record<Sector, readonly EventType[]> = {
  food: [...SHARED_TYPES, ...FOOD_TYPES],
  pharma: [...SHARED_TYPES, ...PHARMA_TYPES],
};

const EVENTS_PER_WEEKDAY = 5;
/** Assumes Monday-start runs (per slice 3 brief: "5 events per active weekday"). */
const HOURS_PER_DAY = 24;
const WEEKDAY_INDICES = [0, 1, 2, 3, 4] as const;

export function activeWeekdays(horizonHours: number): number[] {
  const out: number[] = [];
  for (let day = 0; day * HOURS_PER_DAY < horizonHours; day++) {
    const dow = day % 7;
    if (WEEKDAY_INDICES.includes(dow as 0 | 1 | 2 | 3 | 4)) out.push(day);
  }
  return out;
}

export function isWeekendHour(hour: number): boolean {
  const day = Math.floor(hour / HOURS_PER_DAY);
  const dow = day % 7;
  return dow >= 5;
}

interface GenerateInput {
  sector: Sector;
  seed: string;
  chain: Chain;
  horizonHours: number;
}

export function generateEvents(input: GenerateInput): SimEvent[] {
  const { sector, seed, chain, horizonHours } = input;
  const types = SECTOR_TYPES[sector];
  const out: SimEvent[] = [];
  let seq = 0;

  const days = activeWeekdays(horizonHours);
  for (const day of days) {
    const dayRng = rngFromSeed(seed, `events:day${day}`);
    const hourLo = day * HOURS_PER_DAY;
    const hourHi = Math.min(hourLo + HOURS_PER_DAY, horizonHours) - 1;
    if (hourHi < hourLo) continue;

    for (let k = 0; k < EVENTS_PER_WEEKDAY; k++) {
      const evRng = rngFromSeed(seed, `event:day${day}:k${k}`);
      const type = pick(evRng, types);
      const fireHour = rangeInt(dayRng, hourLo, hourHi);
      out.push(buildEvent(type, fireHour, evRng, chain, sector, ++seq));
    }
  }

  // Opportunities are scheduled separately (sub-type, not part of the 5/day pool).
  const oppRng = rngFromSeed(seed, 'opp:count');
  const oppCount = 3 + Math.floor(oppRng() * 3); // 3..5 inclusive
  for (let k = 0; k < oppCount; k++) {
    const r = rngFromSeed(seed, `opp:${k}`);
    const day = pick(r, days);
    const hour = day * HOURS_PER_DAY + rangeInt(r, 8, 20);
    if (hour >= horizonHours) continue;
    out.push(buildOpportunityEvent(hour, r, chain, sector, ++seq, k));
  }

  out.sort((a, b) => a.fireHour - b.fireHour || a.id.localeCompare(b.id));
  return out;
}

function buildOpportunityEvent(
  fireHour: number,
  rng: Rng,
  chain: Chain,
  sector: Sector,
  seq: number,
  oppIdx: number,
): SimEvent {
  const id = `evt-${seq.toString().padStart(3, '0')}`;
  const oppId = `opp-${oppIdx.toString().padStart(2, '0')}`;
  const endpoint = chain.nodes[chain.nodes.length - 1]!.id;
  const horizonHours = 168;
  const qty = rangeInt(rng, 50, 250);
  const dueByHour = Math.min(
    horizonHours - 8,
    fireHour + rangeInt(rng, 36, 96),
  );
  const revenue = rangeInt(rng, 9, 18);

  const trialDueByHour = Math.max(fireHour + 12, dueByHour - 36);
  const trialQuantity = Math.max(1, Math.round(qty * 0.1));
  const isPharma = sector === 'pharma';
  const opportunityContract = {
    id: oppId,
    endpoint,
    quantity: qty,
    dueByHour,
    revenue,
    kind: 'opportunity' as const,
    trial: {
      quantity: trialQuantity,
      dueByHour: trialDueByHour,
      initialShelfLife: isPharma ? 1 : 96,
      minShelfLifeAtDelivery: isPharma ? 1 : 24,
    },
  };

  return {
    id,
    type: 'opportunity-arrival',
    fireHour,
    durationHours: 1,
    description: `Opportunity ${oppId} arrives: ${qty} units to ${endpoint} by h${dueByHour} @ $${revenue}/unit`,
    sector,
    opportunityContract,
  };
}

function buildEvent(
  type: EventType,
  fireHour: number,
  rng: Rng,
  chain: Chain,
  sector: Sector,
  seq: number,
): SimEvent {
  const id = `evt-${seq.toString().padStart(3, '0')}`;
  const baseDuration = rangeInt(rng, 6, 24);
  const lanes = chain.lanes;
  const nonOrigin = chain.nodes.filter(
    (n) => !chain.origins.includes(n.id),
  );

  switch (type) {
    case 'origin-warehouse-delay': {
      const originId = pick(rng, chain.origins);
      const factor = rangeFloat(rng, 0.2, 0.6);
      return {
        id,
        type,
        fireHour,
        durationHours: baseDuration,
        targetNodeId: originId,
        capacityFactor: factor,
        description: `Origin warehouse delay at ${originId} for ${baseDuration}h (capacity ×${factor.toFixed(2)})`,
        sector,
      };
    }
    case 'lane-disruption': {
      const lane = pick(rng, lanes);
      return {
        id,
        type,
        fireHour,
        durationHours: baseDuration,
        targetLaneId: lane.id,
        capacityFactor: 0,
        description: `Lane disruption on ${lane.id} for ${baseDuration}h (closed)`,
        sector,
      };
    }
    case 'mode-disruption': {
      const lane = pick(rng, lanes);
      const mode: Mode = rng() < 0.5 ? 'fast' : 'slow';
      return {
        id,
        type,
        fireHour,
        durationHours: baseDuration,
        targetLaneId: lane.id,
        targetMode: mode,
        blockMode: mode,
        description: `Mode disruption (${mode}) on ${lane.id} for ${baseDuration}h`,
        sector,
      };
    }
    case 'price-spike': {
      const lane = pick(rng, lanes);
      const multiplier = rangeFloat(rng, 1.3, 2.0);
      const longer = rangeInt(rng, 12, 36);
      return {
        id,
        type,
        fireHour,
        durationHours: longer,
        targetLaneId: lane.id,
        priceMultiplier: multiplier,
        description: `Price spike on ${lane.id} for ${longer}h (×${multiplier.toFixed(2)})`,
        sector,
      };
    }
    case 'spoilage-incident': {
      // Slice 3 logs only; slice 5 will hook quality-state.
      const targetLane = lanes.length > 0 ? pick(rng, lanes).id : undefined;
      return {
        id,
        type,
        fireHour,
        durationHours: 1,
        targetLaneId: targetLane,
        description: `Spoilage incident on ${targetLane ?? 'unknown lane'} (logged; quality effect deferred to slice 5)`,
        sector,
      };
    }
    case 'opportunity-arrival': {
      throw new Error(
        'opportunity-arrival is built via buildOpportunityEvent, not buildEvent',
      );
    }
    case 'refrigeration-failure': {
      // Targets a random lane; sim will pick an in-flight shipment on that
      // lane at the fire hour and flip its quality to 0.
      const lane = pick(rng, lanes);
      return {
        id,
        type,
        fireHour,
        durationHours: 1,
        targetLaneId: lane.id,
        description: `Refrigeration failure on ${lane.id} (in-flight shipment integrity flipped)`,
        sector,
      };
    }
    case 'regulatory-hold': {
      const node = pick(rng, nonOrigin.length > 0 ? nonOrigin : chain.nodes);
      return {
        id,
        type,
        fireHour,
        durationHours: baseDuration,
        targetNodeId: node.id,
        capacityFactor: 0,
        description: `Regulatory hold at ${node.id} for ${baseDuration}h (outbound halted)`,
        sector,
      };
    }
    case 'contamination-alert': {
      // Treats a non-origin, non-endpoint node as quarantined for the duration.
      const nodeOptions =
        nonOrigin.length > 0 ? nonOrigin : chain.nodes;
      const node = pick(rng, nodeOptions);
      return {
        id,
        type,
        fireHour,
        durationHours: baseDuration,
        targetNodeId: node.id,
        capacityFactor: 0,
        description: `Contamination alert at ${node.id} for ${baseDuration}h (outbound halted)`,
        sector,
      };
    }
  }
}
