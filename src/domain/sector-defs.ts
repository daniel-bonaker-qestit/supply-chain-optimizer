import type { Chain, Contract, Lane, ModeProfile, Sector, SupplyNode } from './types.ts';

export interface SectorDefinition {
  chain: Chain;
  contracts: Contract[];
  horizonHours: number;
}

const lane = (
  id: string,
  from: string,
  to: string,
  slow: ModeProfile,
  fast: ModeProfile,
  capacityPerHour = 1000,
): Lane => ({
  id,
  from,
  to,
  capacity: { perHour: capacityPerHour },
  modes: { slow, fast },
});

function foodChain(): Chain {
  const nodes: SupplyNode[] = [
    { id: 'farm', layer: 0, holdingCostPerUnitHour: 0.02, label: 'Origin farm' },
    { id: 'regional', layer: 1, holdingCostPerUnitHour: 0.05, label: 'Regional DC' },
    { id: 'cold-hub', layer: 2, holdingCostPerUnitHour: 0.08, label: 'Cold storage hub' },
    { id: 'retail-dc', layer: 3, holdingCostPerUnitHour: 0.1, label: 'Retail DC' },
    { id: 'retailer', layer: 4, holdingCostPerUnitHour: 0, label: 'Retailer (endpoint)' },
  ];

  const lanes: Lane[] = [
    lane(
      'farm->regional',
      'farm',
      'regional',
      { transitHours: 8, costPerUnit: 1.0 },
      { transitHours: 4, costPerUnit: 2.4 },
    ),
    lane(
      'regional->cold-hub',
      'regional',
      'cold-hub',
      { transitHours: 6, costPerUnit: 0.8 },
      { transitHours: 3, costPerUnit: 1.9 },
    ),
    lane(
      'cold-hub->retail-dc',
      'cold-hub',
      'retail-dc',
      { transitHours: 4, costPerUnit: 0.6 },
      { transitHours: 2, costPerUnit: 1.5 },
    ),
    lane(
      'retail-dc->retailer',
      'retail-dc',
      'retailer',
      { transitHours: 2, costPerUnit: 0.4 },
      { transitHours: 1, costPerUnit: 1.0 },
    ),
  ];

  return {
    sector: 'food',
    nodes,
    lanes,
    origins: ['farm'],
  };
}

function foodCommittedContracts(): Contract[] {
  const SHELF_LIFE = 96;
  const SHELF_THRESHOLD = 24;
  const trialFor = (mainDue: number, totalQty: number) => {
    const dueByHour = Math.max(24, mainDue - 36);
    const quantity = Math.max(1, Math.round(totalQty * 0.1));
    return {
      quantity,
      dueByHour,
      initialShelfLife: SHELF_LIFE,
      minShelfLifeAtDelivery: SHELF_THRESHOLD,
    };
  };

  return [
    { id: 'food-c1', endpoint: 'retailer', quantity: 200, dueByHour: 48,  revenue: 10.0, kind: 'committed', trial: trialFor(48, 200) },
    { id: 'food-c2', endpoint: 'retailer', quantity: 350, dueByHour: 72,  revenue: 11.0, kind: 'committed', trial: trialFor(72, 350) },
    { id: 'food-c3', endpoint: 'retailer', quantity: 250, dueByHour: 96,  revenue: 12.0, kind: 'committed', trial: trialFor(96, 250) },
    { id: 'food-c4', endpoint: 'retailer', quantity: 400, dueByHour: 120, revenue: 11.5, kind: 'committed', trial: trialFor(120, 400) },
    { id: 'food-c5', endpoint: 'retailer', quantity: 150, dueByHour: 144, revenue: 10.5, kind: 'committed', trial: trialFor(144, 150) },
    { id: 'food-c6', endpoint: 'retailer', quantity: 100, dueByHour: 160, revenue: 10.0, kind: 'committed', trial: trialFor(160, 100) },
  ];
}

export function getSectorDefinition(sector: Sector): SectorDefinition {
  if (sector !== 'food') {
    throw new Error(`Sector not implemented in slice 1: ${sector as string}`);
  }
  return {
    chain: foodChain(),
    contracts: foodCommittedContracts(),
    horizonHours: 168,
  };
}
