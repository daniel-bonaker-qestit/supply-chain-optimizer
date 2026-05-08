import { describe, it, expect } from 'vitest';
import { BREACH_PENALTY_PER_UNIT, solve } from './optimizer.ts';
import { getSectorDefinition } from '../domain/sector-defs.ts';
import type { OptimizerState } from './types.ts';
import type { Chain, Contract } from '../domain/types.ts';

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

describe('optimizer.solve — slice 2 (food, multi-contract, multi-mode)', () => {
  it('returns an optimal plan with at least one shipment and positive cost', async () => {
    const plan = await solve(buildSimStartState());
    expect(plan.shipments.length).toBeGreaterThan(0);
    expect(plan.totalCost).toBeGreaterThan(0);
    expect(Number.isFinite(plan.totalCost)).toBe(true);
  });

  it('plans full on-time delivery for every committed food contract', async () => {
    const state = buildSimStartState();
    const plan = await solve(state);

    for (const c of state.contracts) {
      expect(plan.breachByContract[c.id]).toBeCloseTo(0);
      const delivered = plan.deliveries
        .filter((d) => d.contractId === c.id && d.arriveHour <= c.dueByHour)
        .reduce((sum, d) => sum + d.quantity, 0);
      expect(delivered).toBeGreaterThanOrEqual(c.quantity - 1e-6);
    }
  });

  it('is deterministic — same state in, same plan cost out', async () => {
    const state = buildSimStartState();
    const a = await solve(state);
    const b = await solve(state);
    expect(b.totalCost).toBeCloseTo(a.totalCost);
    expect(b.shipments.length).toBe(a.shipments.length);
  });

  it('selects fast mode when slow mode cannot meet a tight deadline', async () => {
    // Single-leg chain whose slow transit (10h) blows past the deadline (5h)
    // but whose fast transit (3h) meets it.
    const chain: Chain = {
      sector: 'food',
      origins: ['origin'],
      nodes: [
        { id: 'origin', layer: 0, holdingCostPerUnitHour: 0 },
        { id: 'sink', layer: 1, holdingCostPerUnitHour: 0 },
      ],
      lanes: [
        {
          id: 'origin->sink',
          from: 'origin',
          to: 'sink',
          capacity: { perHour: 1000 },
          modes: {
            slow: { transitHours: 10, costPerUnit: 1.0 },
            fast: { transitHours: 3, costPerUnit: 4.0 },
          },
        },
      ],
    };
    const contract: Contract = {
      id: 'tight',
      endpoint: 'sink',
      quantity: 50,
      dueByHour: 5,
      revenue: 20,
      kind: 'committed',
    };

    const plan = await solve({
      chain,
      contracts: [contract],
      currentHour: 0,
      horizonHours: 24,
      inFlight: [],
      delivered: {},
    });

    expect(plan.breachByContract.tight).toBeCloseTo(0);
    expect(plan.shipments.some((s) => s.mode === 'fast')).toBe(true);
  });

  it('produces a non-zero breach term when the deadline is physically impossible', async () => {
    // Single-leg chain whose fast transit alone exceeds the deadline.
    const chain: Chain = {
      sector: 'food',
      origins: ['origin'],
      nodes: [
        { id: 'origin', layer: 0, holdingCostPerUnitHour: 0 },
        { id: 'sink', layer: 1, holdingCostPerUnitHour: 0 },
      ],
      lanes: [
        {
          id: 'origin->sink',
          from: 'origin',
          to: 'sink',
          capacity: { perHour: 1000 },
          modes: {
            slow: { transitHours: 12, costPerUnit: 1.0 },
            fast: { transitHours: 6, costPerUnit: 4.0 },
          },
        },
      ],
    };
    const contract: Contract = {
      id: 'impossible',
      endpoint: 'sink',
      quantity: 100,
      dueByHour: 3,
      revenue: 50,
      kind: 'committed',
    };

    const plan = await solve({
      chain,
      contracts: [contract],
      currentHour: 0,
      horizonHours: 24,
      inFlight: [],
      delivered: {},
    });

    expect(plan.breachByContract.impossible).toBeGreaterThan(50 - 1e-3);
    // Total cost must reflect the breach penalty.
    expect(plan.totalCost).toBeGreaterThanOrEqual(
      BREACH_PENALTY_PER_UNIT * 100 - 1,
    );
  });

  it('respects per-(lane, hour) capacity with the modal sum constraint', async () => {
    // Capacity 50/hr, demand 100 by hour 5 with 2h slow transit. With sum-of-modes
    // capacity, the optimizer must spread releases across multiple hours.
    const chain: Chain = {
      sector: 'food',
      origins: ['origin'],
      nodes: [
        { id: 'origin', layer: 0, holdingCostPerUnitHour: 0 },
        { id: 'sink', layer: 1, holdingCostPerUnitHour: 0 },
      ],
      lanes: [
        {
          id: 'origin->sink',
          from: 'origin',
          to: 'sink',
          capacity: { perHour: 50 },
          modes: {
            slow: { transitHours: 2, costPerUnit: 1.0 },
            fast: { transitHours: 1, costPerUnit: 4.0 },
          },
        },
      ],
    };
    const contract: Contract = {
      id: 'cap',
      endpoint: 'sink',
      quantity: 100,
      dueByHour: 5,
      revenue: 20,
      kind: 'committed',
    };

    const plan = await solve({
      chain,
      contracts: [contract],
      currentHour: 0,
      horizonHours: 24,
      inFlight: [],
      delivered: {},
    });

    expect(plan.breachByContract.cap).toBeCloseTo(0);
    // Per-hour aggregate flow on the lane never exceeds 50.
    const releasedPerHour = new Map<number, number>();
    for (const s of plan.shipments) {
      releasedPerHour.set(
        s.releaseHour,
        (releasedPerHour.get(s.releaseHour) ?? 0) + s.quantity,
      );
    }
    for (const v of releasedPerHour.values()) {
      expect(v).toBeLessThanOrEqual(50 + 1e-6);
    }
  });
});
