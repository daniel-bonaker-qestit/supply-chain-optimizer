import { describe, expect, it } from 'vitest';
import {
  activeWeekdays,
  generateEvents,
  isWeekendHour,
} from './event-generator.ts';
import { getSectorDefinition } from '../domain/sector-defs.ts';

const food = () => getSectorDefinition('food');

describe('event-generator — determinism and counts', () => {
  it('produces 5 events per active weekday (25 total for a 168h Mon-start run)', () => {
    const { chain, horizonHours } = food();
    const events = generateEvents({
      sector: 'food',
      seed: 'demo-1',
      chain,
      horizonHours,
    });
    expect(events.length).toBe(25);
  });

  it('same (sector, seed) produces identical timelines', () => {
    const { chain, horizonHours } = food();
    const a = generateEvents({
      sector: 'food',
      seed: 'demo-1',
      chain,
      horizonHours,
    });
    const b = generateEvents({
      sector: 'food',
      seed: 'demo-1',
      chain,
      horizonHours,
    });
    expect(b).toEqual(a);
  });

  it('different seeds produce different timelines', () => {
    const { chain, horizonHours } = food();
    const a = generateEvents({
      sector: 'food',
      seed: 'one',
      chain,
      horizonHours,
    });
    const b = generateEvents({
      sector: 'food',
      seed: 'two',
      chain,
      horizonHours,
    });
    expect(b).not.toEqual(a);
  });

  it('never schedules events at weekend hours (>= day 5)', () => {
    const { chain, horizonHours } = food();
    const events = generateEvents({
      sector: 'food',
      seed: 'demo-1',
      chain,
      horizonHours,
    });
    for (const e of events) {
      expect(isWeekendHour(e.fireHour)).toBe(false);
    }
  });

  it('uses the food-specific event types in addition to the shared ones', () => {
    const { chain, horizonHours } = food();
    const seeds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const seenTypes = new Set<string>();
    for (const s of seeds) {
      const events = generateEvents({
        sector: 'food',
        seed: s,
        chain,
        horizonHours,
      });
      for (const e of events) seenTypes.add(e.type);
    }
    // Across enough seeds, every type should eventually appear.
    expect(seenTypes.has('spoilage-incident')).toBe(true);
    expect(seenTypes.has('contamination-alert')).toBe(true);
    expect(seenTypes.size).toBeGreaterThanOrEqual(4);
  });

  it('activeWeekdays excludes Saturday and Sunday for a 168h run', () => {
    expect(activeWeekdays(168)).toEqual([0, 1, 2, 3, 4]);
  });
});
