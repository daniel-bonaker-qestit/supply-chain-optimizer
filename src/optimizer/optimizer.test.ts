import { describe, it, expect } from 'vitest';
import { solve } from './optimizer.ts';
import { getSectorDefinition } from '../domain/sector-defs.ts';
import type { OptimizerState } from './types.ts';

const buildSimStartState = (): OptimizerState => {
  const { chain, contracts, horizonHours } = getSectorDefinition('food');
  return {
    chain,
    contracts,
    currentHour: 0,
    horizonHours,
    inFlight: [],
    delivered: {},
  };
};

describe('optimizer.solve (slice 1)', () => {
  it('returns an optimal plan with at least one shipment and positive cost', async () => {
    const plan = await solve(buildSimStartState());

    expect(plan.shipments.length).toBeGreaterThan(0);
    expect(plan.totalCost).toBeGreaterThan(0);
    expect(Number.isFinite(plan.totalCost)).toBe(true);
  });

  it('schedules enough deliveries to satisfy the committed contract by its deadline', async () => {
    const state = buildSimStartState();
    const plan = await solve(state);
    const contract = state.contracts[0]!;

    const onTimeDelivered = plan.deliveries
      .filter((d) => d.contractId === contract.id && d.arriveHour <= contract.dueByHour)
      .reduce((sum, d) => sum + d.quantity, 0);

    expect(onTimeDelivered).toBeGreaterThanOrEqual(contract.quantity - 1e-6);
  });

  it('uses slow mode only in slice 1 (single-mode optimizer)', async () => {
    const plan = await solve(buildSimStartState());
    expect(plan.shipments.every((s) => s.mode === 'slow')).toBe(true);
  });

  it('is deterministic — same state in, same plan out', async () => {
    const state = buildSimStartState();
    const a = await solve(state);
    const b = await solve(state);

    expect(b.totalCost).toBeCloseTo(a.totalCost);
    expect(b.shipments.length).toBe(a.shipments.length);
  });
});
