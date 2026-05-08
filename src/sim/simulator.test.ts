import { describe, it, expect } from 'vitest';
import { Simulator } from './simulator.ts';
import { getSectorDefinition } from '../domain/sector-defs.ts';

const food = () => getSectorDefinition('food');

describe('Simulator — sim-start replan', () => {
  it('solves an initial plan during start() and exposes it via currentState()', async () => {
    const { chain, contracts, horizonHours } = food();
    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      events: [],
    });
    const state = sim.currentState();

    expect(state.plan).toBeDefined();
    expect(state.plan.shipments.length).toBeGreaterThan(0);
    expect(state.currentHour).toBe(0);
    expect(state.status).toBe('running');
    expect(state.totalCost).toBeUndefined();
  });

  it('initial contract statuses are on-track when the plan has no breach', async () => {
    const { chain, contracts, horizonHours } = food();
    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      events: [],
    });
    const state = sim.currentState();
    for (const c of contracts) {
      expect(state.contractDeliveries[c.id]!.status).toBe('on-track');
    }
  });
});

describe('Simulator — state transitions per step(h)', () => {
  it('rejects step(h) when h !== currentHour', async () => {
    const { chain, contracts, horizonHours } = food();
    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      events: [],
    });
    await expect(sim.step(5)).rejects.toThrow(/step.*0/);
  });

  it('advances currentHour by exactly one per step(h)', async () => {
    const { chain, contracts, horizonHours } = food();
    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      events: [],
    });
    await sim.step(0);
    expect(sim.currentState().currentHour).toBe(1);
    await sim.step(1);
    expect(sim.currentState().currentHour).toBe(2);
  });

  it('releases planned shipments at their releaseHour', async () => {
    const { chain, contracts, horizonHours } = food();
    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      events: [],
    });
    const plan = sim.currentState().plan;
    const firstRelease = Math.min(...plan.shipments.map((s) => s.releaseHour));

    for (let h = 0; h < firstRelease; h++) await sim.step(h);
    expect(sim.currentState().inFlight.length).toBe(0);

    await sim.step(firstRelease);
    expect(sim.currentState().inFlight.length).toBeGreaterThan(0);
  });

  it('removes shipments from inFlight at their arriveHour', async () => {
    const { chain, contracts, horizonHours } = food();
    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      events: [],
    });
    const plan = sim.currentState().plan;
    const lastArrival = plan.shipments.reduce((max, s) => {
      const lane = chain.lanes.find((l) => l.id === s.laneId)!;
      return Math.max(max, s.releaseHour + lane.modes[s.mode].transitHours);
    }, 0);

    for (let h = 0; h <= lastArrival; h++) await sim.step(h);
    expect(sim.currentState().inFlight.length).toBe(0);
  });

  it('marks every committed food contract as delivered on time when feasible', async () => {
    const { chain, contracts, horizonHours } = food();
    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      events: [],
    });

    for (let h = 0; h < horizonHours; h++) await sim.step(h);

    const state = sim.currentState();
    for (const c of contracts) {
      const cd = state.contractDeliveries[c.id]!;
      expect(cd.delivered).toBeGreaterThanOrEqual(c.quantity - 1e-6);
      expect(cd.status).toBe('delivered');
    }
  });
});

describe('Simulator — terminal state', () => {
  it('reaches status="complete" at currentHour=horizonHours with totalCost set', async () => {
    const { chain, contracts, horizonHours } = food();
    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      events: [],
    });
    const expectedCost = sim.currentState().plan.totalCost;

    for (let h = 0; h < horizonHours; h++) await sim.step(h);

    const state = sim.currentState();
    expect(state.status).toBe('complete');
    expect(state.currentHour).toBe(horizonHours);
    expect(state.totalCost).toBeCloseTo(expectedCost, 5);
  });

  it('rejects step() once complete', async () => {
    const { chain, contracts, horizonHours } = food();
    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      events: [],
    });
    for (let h = 0; h < horizonHours; h++) await sim.step(h);
    await expect(sim.step(horizonHours)).rejects.toThrow();
  });
});

describe('Simulator — events + replan triggers', () => {
  it('fires deterministic events and triggers a replan at each event hour', async () => {
    const { chain, contracts, horizonHours } = food();
    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      seed: 'evt-test-1',
    });

    const initialEvents = sim.currentState().scheduledEvents;
    expect(initialEvents.length).toBe(25);

    for (let h = 0; h < horizonHours; h++) await sim.step(h);

    const log = sim.currentState().eventLog;
    const fired = log.filter((e) => e.kind === 'event-fired');
    const replans = log.filter((e) => e.kind === 'replan');
    // All scheduled weekday events fire exactly once.
    expect(fired.length).toBe(initialEvents.length);
    // One replan per distinct hour that had ≥ 1 event (collisions in same hour batch).
    const distinctEventHours = new Set(initialEvents.map((e) => e.fireHour))
      .size;
    expect(replans.length).toBe(distinctEventHours);
  });

  it('does not fire events on weekend hours even if they happen to be scheduled there', async () => {
    const { chain, contracts, horizonHours } = food();
    // Inject a hand-crafted event on a weekend hour (hour 144 = Sunday day-6 start).
    const weekendHour = 144; // day 6 (Sunday) — weekend
    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      events: [
        {
          id: 'manual-weekend',
          type: 'lane-disruption',
          fireHour: weekendHour,
          durationHours: 6,
          targetLaneId: chain.lanes[0]!.id,
          capacityFactor: 0,
          description: 'weekend test',
          sector: 'food',
        },
      ],
    });

    for (let h = 0; h < horizonHours; h++) await sim.step(h);

    const fired = sim
      .currentState()
      .eventLog.filter((e) => e.kind === 'event-fired');
    expect(fired.length).toBe(0);
  });

  it('records active disruptions when a lane-disruption event fires', async () => {
    const { chain, contracts, horizonHours } = food();
    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      events: [
        {
          id: 'manual-lane',
          type: 'lane-disruption',
          fireHour: 4,
          durationHours: 6,
          targetLaneId: chain.lanes[0]!.id,
          capacityFactor: 0,
          description: 'lane disruption test',
          sector: 'food',
        },
      ],
    });

    for (let h = 0; h <= 4; h++) await sim.step(h);

    const disruptions = sim.currentState().activeDisruptions;
    expect(disruptions.some((d) => d.laneId === chain.lanes[0]!.id)).toBe(true);
  });

  it('completes the run end-to-end with seeded events and a non-empty event log', async () => {
    const { chain, contracts, horizonHours } = food();
    const sim = await Simulator.start({
      chain,
      contracts,
      horizonHours,
      seed: 'demo-run',
    });

    for (let h = 0; h < horizonHours; h++) await sim.step(h);

    const state = sim.currentState();
    expect(state.status).toBe('complete');
    expect(state.eventLog.some((e) => e.kind === 'replan')).toBe(true);
    expect(state.eventLog.some((e) => e.kind === 'event-fired')).toBe(true);
    // Most contracts still deliver under typical seeds; under adversarial
    // disruption profiles some may breach. Both are valid outcomes.
    for (const c of contracts) {
      const cd = state.contractDeliveries[c.id]!;
      expect(['delivered', 'breached', 'pending']).toContain(cd.status);
    }
  });
});
