import { describe, it, expect } from 'vitest';
import { getSectorDefinition } from './domain/sector-defs.ts';
import { Simulator } from './sim/simulator.ts';

describe('E2E smoke test', () => {
  it('runs food sector hour-0..168 and delivers every contract on time', async () => {
    const { chain, contracts, horizonHours } = getSectorDefinition('food');

    const sim = await Simulator.start({ chain, contracts, horizonHours });

    const initial = sim.currentState();
    expect(initial.plan.shipments.length).toBeGreaterThan(0);
    expect(initial.plan.totalCost).toBeGreaterThan(0);
    for (const c of contracts) {
      expect(initial.plan.breachByContract[c.id]).toBeCloseTo(0);
    }

    for (let h = 0; h < horizonHours; h++) sim.step(h);

    const final = sim.currentState();
    expect(final.status).toBe('complete');
    expect(final.currentHour).toBe(horizonHours);
    expect(final.totalCost).toBeDefined();
    expect(final.totalCost!).toBeGreaterThan(0);
    expect(final.inFlight.length).toBe(0);

    for (const c of contracts) {
      const cd = final.contractDeliveries[c.id]!;
      expect(cd.status).toBe('delivered');
      expect(cd.delivered).toBeGreaterThanOrEqual(c.quantity - 1e-6);
    }
  });
});
