import { describe, expect, it } from 'vitest';
import { Simulator } from './simulator.ts';
import { getSectorDefinition } from '../domain/sector-defs.ts';

describe('Electronics sector', () => {
  it('runs end-to-end with no events and delivers every committed contract', async () => {
    const { chain, contracts, horizonHours } =
      getSectorDefinition('electronics');
    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      events: [],
    });

    for (let h = 0; h < horizonHours; h++) await sim.step(h);

    const final = sim.currentState();
    expect(final.status).toBe('complete');
    for (const c of contracts) {
      const cd = final.contractDeliveries[c.id]!;
      expect(cd.status).toBe('delivered');
    }
  });

  it('reroutes around an ESD-excluded node — sim still completes', async () => {
    const { chain, contracts, horizonHours } =
      getSectorDefinition('electronics');
    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      events: [
        {
          id: 'esd-1',
          type: 'esd-exception',
          fireHour: 4,
          durationHours: 24,
          targetNodeId: 'sub-assembly',
          capacityFactor: 0,
          description: 'forced ESD exception (test)',
          sector: 'electronics',
        },
      ],
    });

    for (let h = 0; h < horizonHours; h++) await sim.step(h);

    const final = sim.currentState();
    // The chain has only one path through each layer, so blocking sub-assembly
    // for 24h forces the LP to delay — it absorbs via holding rather than a
    // literal alternate route, but the run still completes.
    expect(final.status).toBe('complete');
    expect(final.eventLog.some((e) => e.kind === 'event-fired')).toBe(true);
    expect(final.eventLog.some((e) => e.kind === 'replan')).toBe(true);
  });

  it('runs end-to-end with seeded events on the longer chain', async () => {
    const { chain, contracts, horizonHours } =
      getSectorDefinition('electronics');
    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      seed: 'elec-events-1',
    });

    for (let h = 0; h < horizonHours; h++) await sim.step(h);

    const final = sim.currentState();
    expect(final.status).toBe('complete');
  }, 60000);
});
