import type { Mode, Sector } from '../domain/types.ts';

export interface QualityModel {
  /** Quality value at the chain origin when units are released. */
  initialAtOrigin: number;
  /** Quality consumed by a single transit leg given mode + transit hours. */
  decayPerLeg(mode: Mode, transitHours: number): number;
}

const FOOD_MODE_TRANSIT_MULTIPLIER: Record<Mode, number> = {
  slow: 1.5,
  fast: 1.0,
};

const FOOD: QualityModel = {
  initialAtOrigin: 96,
  decayPerLeg: (mode, t) => t * FOOD_MODE_TRANSIT_MULTIPLIER[mode],
};

const PHARMA: QualityModel = {
  // Pharma cold-chain integrity: 1 = intact, 0 = broken. No per-leg decay;
  // refrigeration-failure events flip the in-transit shipment's value.
  initialAtOrigin: 1,
  decayPerLeg: () => 0,
};

export function getQualityModel(sector: Sector): QualityModel {
  switch (sector) {
    case 'food':
      return FOOD;
    case 'pharma':
      return PHARMA;
  }
}
