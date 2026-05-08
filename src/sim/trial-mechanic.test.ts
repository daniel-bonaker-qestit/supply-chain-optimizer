import { describe, expect, it } from 'vitest';
import { Simulator } from './simulator.ts';
import { getSectorDefinition } from '../domain/sector-defs.ts';
import type { Contract } from '../domain/types.ts';

describe('Simulator — trial mechanic', () => {
  it('every food contract reaches "delivered" under nominal conditions', async () => {
    const { chain, contracts, horizonHours } = getSectorDefinition('food');
    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      events: [],
    });

    for (let h = 0; h < horizonHours; h++) await sim.step(h);

    const final = sim.currentState();
    for (const c of contracts) {
      const cd = final.contractDeliveries[c.id]!;
      expect(cd.status).toBe('delivered');
      expect(cd.trialQualityPassed).toBe(true);
    }
    // Every trial-evaluated entry was a pass.
    const evals = final.eventLog.filter((e) => e.kind === 'trial-evaluated');
    expect(evals.length).toBeGreaterThan(0);
    for (const e of evals) {
      expect(e.detail).toMatch(/Trial passed/);
    }
  });

  it('voids the contract when the trial cannot meet the quality threshold', async () => {
    const { chain } = getSectorDefinition('food');
    const horizonHours = 168;
    // Threshold higher than 96 (initial shelf-life) — impossible to meet with any mode.
    const contract: Contract = {
      id: 'tight-trial',
      endpoint: 'retailer',
      quantity: 100,
      dueByHour: 72,
      revenue: 12,
      kind: 'committed',
      trial: {
        quantity: 10,
        dueByHour: 24,
        initialShelfLife: 96,
        minShelfLifeAtDelivery: 200, // unreachable
      },
    };
    const sim = await Simulator.start({
      chain,
      contracts: [contract],
      horizonHours,
      events: [],
    });

    for (let h = 0; h < horizonHours; h++) await sim.step(h);

    const final = sim.currentState();
    const cd = final.contractDeliveries[contract.id]!;
    expect(cd.status).toBe('voided');
    expect(cd.trialQualityPassed).toBe(false);

    // No breach penalty was incurred for the voided main sub-contract:
    // its quantity was zeroed after the trial failed, so the LP had no
    // unmet demand to penalise.
    const mainBreach =
      final.plan.breachByContract[`${contract.id}::main`] ?? 0;
    expect(mainBreach).toBeCloseTo(0);

    const evals = final.eventLog.filter((e) => e.kind === 'trial-evaluated');
    expect(evals.length).toBe(1);
    expect(evals[0]!.detail).toMatch(/FAILED/);
  });
});
