import { describe, expect, it } from 'vitest';
import { Simulator } from './simulator.ts';
import { getSectorDefinition } from '../domain/sector-defs.ts';

describe('Simulator — opportunity contracts', () => {
  it('across multiple seeds the optimizer both accepts and declines opportunities', async () => {
    const seeds = ['ops-1', 'ops-2', 'ops-3', 'ops-4', 'ops-5', 'ops-6'];
    let totalAccepted = 0;
    let totalDeclined = 0;

    for (const seed of seeds) {
      const { chain, contracts, horizonHours } = getSectorDefinition('food');
      const sim = await Simulator.start({
        chain,
        contracts,
        horizonHours,
        seed,
      });
      for (let h = 0; h < horizonHours; h++) await sim.step(h);
      const log = sim.currentState().eventLog;
      totalAccepted += log.filter(
        (e) => e.kind === 'opportunity-accepted',
      ).length;
      totalDeclined += log.filter(
        (e) => e.kind === 'opportunity-declined',
      ).length;
    }

    expect(totalAccepted).toBeGreaterThan(0);
    expect(totalDeclined).toBeGreaterThan(0);
  }, 120000);

  it('declined opportunities never resurface in subsequent replans', async () => {
    const { chain, contracts, horizonHours } = getSectorDefinition('food');
    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      seed: 'ops-final-test',
    });

    for (let h = 0; h < horizonHours; h++) await sim.step(h);

    const log = sim.currentState().eventLog;
    const declined = log.filter((e) => e.kind === 'opportunity-declined');
    for (const decline of declined) {
      const acceptsAfter = log.filter(
        (e) =>
          e.kind === 'opportunity-accepted' &&
          e.contractId === decline.contractId &&
          e.hour > decline.hour,
      );
      expect(acceptsAfter.length).toBe(0);
    }
  });
});
