import { describe, it, expect } from 'vitest';
import { getSectorDefinition } from './domain/sector-defs.ts';
import { Simulator } from './sim/simulator.ts';

describe('E2E smoke test', () => {
  it('runs food sector hour-0..168 (no events) and delivers every contract', async () => {
    const { chain, contracts, horizonHours } = getSectorDefinition('food');

    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      events: [],
    });

    const initial = sim.currentState();
    expect(initial.plan.shipments.length).toBeGreaterThan(0);
    expect(initial.plan.totalCost).toBeGreaterThan(0);
    expect(initial.scheduledEvents.length).toBe(0);

    for (let h = 0; h < horizonHours; h++) await sim.step(h);

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

  it('runs food sector with seeded events and the run still completes', async () => {
    const { chain, contracts, horizonHours } = getSectorDefinition('food');

    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      seed: 'e2e-events-1',
    });

    expect(sim.currentState().scheduledEvents.length).toBe(25);

    for (let h = 0; h < horizonHours; h++) await sim.step(h);

    const final = sim.currentState();
    expect(final.status).toBe('complete');
    expect(final.eventLog.some((e) => e.kind === 'replan')).toBe(true);
  });
});
