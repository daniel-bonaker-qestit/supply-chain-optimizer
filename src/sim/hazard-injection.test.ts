import { describe, expect, it } from 'vitest';
import { Simulator } from './simulator.ts';
import { getSectorDefinition } from '../domain/sector-defs.ts';
import { pickHazard } from '../hazards/hazard-generator.ts';
import { mulberry32 } from '../util/rng.ts';

describe('Simulator.injectHazard', () => {
  it('appends an active disruption and fires a replan', async () => {
    const { chain, contracts, horizonHours } = getSectorDefinition('food');
    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      events: [],
    });

    const before = sim.currentState();
    const beforeReplans = before.eventLog.filter(
      (e) => e.kind === 'replan',
    ).length;

    const haz = pickHazard({
      sector: 'food',
      chain,
      currentHour: 0,
      horizonHours,
      rng: mulberry32(1),
      type: 'lane-disruption' as never,
      // Force a real-ish hazard via type override:
    } as never);
    // Use 'strike' instead — pickHazard with type override.
    const strike = pickHazard({
      sector: 'food',
      chain,
      currentHour: 0,
      horizonHours,
      rng: mulberry32(1),
      type: 'strike',
    });
    void haz;

    await sim.injectHazard(strike);

    const after = sim.currentState();
    expect(after.injectedHazards).toContainEqual(strike);
    expect(after.activeDisruptions.some((d) => d.sourceId === strike.id)).toBe(
      true,
    );
    const afterReplans = after.eventLog.filter(
      (e) => e.kind === 'replan',
    ).length;
    expect(afterReplans).toBe(beforeReplans + 1);
  });

  it('cyberattack suppresses replans during its window', async () => {
    const { chain, contracts, horizonHours } = getSectorDefinition('food');
    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      // Schedule a non-weekend event AFTER cyberattack injection so it fires
      // within the blackout window.
      events: [
        {
          id: 'after-cyber',
          type: 'lane-disruption',
          fireHour: 5,
          durationHours: 4,
          targetLaneId: chain.lanes[0]!.id,
          capacityFactor: 0,
          description: 'late lane disruption (fires inside cyber window)',
          sector: 'food',
        },
      ],
    });

    // Inject cyberattack at hour 0 with duration 24h — replans suppressed
    // for hours [0, 24).
    const cyber = pickHazard({
      sector: 'food',
      chain,
      currentHour: 0,
      horizonHours,
      rng: mulberry32(99),
      type: 'cyberattack',
    });
    await sim.injectHazard(cyber);
    const replansAfterCyberInject = sim
      .currentState()
      .eventLog.filter((e) => e.kind === 'replan').length;
    // The cyberattack injection itself did NOT replan (suppressed at injection too).
    expect(replansAfterCyberInject).toBe(0);

    // Tick into hour 5 and the lane-disruption event fires; replan must be suppressed.
    for (let h = 0; h <= 5; h++) await sim.step(h);
    const log = sim.currentState().eventLog;
    expect(log.some((e) => e.kind === 'event-fired')).toBe(true);
    expect(log.some((e) => e.kind === 'replan-suppressed')).toBe(true);
    expect(log.filter((e) => e.kind === 'replan').length).toBe(0);
  });

  it('rejects injection after the run completes', async () => {
    const { chain, contracts, horizonHours } = getSectorDefinition('food');
    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      events: [],
    });
    for (let h = 0; h < horizonHours; h++) await sim.step(h);

    const haz = pickHazard({
      sector: 'food',
      chain,
      currentHour: horizonHours,
      horizonHours,
      rng: mulberry32(1),
      type: 'strike',
    });
    await expect(sim.injectHazard(haz)).rejects.toThrow();
  });
});
