import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../util/rng.ts';
import { ALL_HAZARD_TYPES, type HazardType } from './types.ts';
import { pickHazard } from './hazard-generator.ts';
import { getSectorDefinition } from '../domain/sector-defs.ts';

describe('hazard-generator.pickHazard', () => {
  it('produces every hazard type when explicitly requested', () => {
    const { chain, horizonHours } = getSectorDefinition('food');
    for (const type of ALL_HAZARD_TYPES) {
      const h = pickHazard({
        sector: 'food',
        chain,
        currentHour: 24,
        horizonHours,
        rng: mulberry32(42),
        type,
      });
      expect(h.type).toBe(type);
      expect(h.injectedAtHour).toBe(24);
      expect(h.durationHours).toBeGreaterThan(0);
      expect(h.description).toBeTypeOf('string');
    }
  });

  it('marks cyberattack as blocksReplans=true and others as false', () => {
    const { chain, horizonHours } = getSectorDefinition('food');
    for (const type of ALL_HAZARD_TYPES) {
      const h = pickHazard({
        sector: 'food',
        chain,
        currentHour: 0,
        horizonHours,
        rng: mulberry32(7),
        type,
      });
      const expected: HazardType[] = ['cyberattack'];
      expect(h.blocksReplans).toBe(expected.includes(type));
    }
  });

  it('catastrophic-node-loss and sanctions persist through horizon', () => {
    const { chain, horizonHours } = getSectorDefinition('food');
    const cnl = pickHazard({
      sector: 'food',
      chain,
      currentHour: 30,
      horizonHours,
      rng: mulberry32(1),
      type: 'catastrophic-node-loss',
    });
    expect(cnl.persistThroughHorizon).toBe(true);
    expect(cnl.durationHours).toBe(horizonHours - 30);

    const sanc = pickHazard({
      sector: 'food',
      chain,
      currentHour: 30,
      horizonHours,
      rng: mulberry32(1),
      type: 'sanctions',
    });
    expect(sanc.persistThroughHorizon).toBe(true);
  });
});
