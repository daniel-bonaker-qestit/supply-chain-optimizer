import { describe, it, expect } from 'vitest';
import { Simulator } from './simulator.ts';
import { getSectorDefinition } from '../domain/sector-defs.ts';

const food = () => getSectorDefinition('food');

describe('Simulator — sim-start replan', () => {
  it('solves an initial plan during start() and exposes it via currentState()', async () => {
    const { chain, contracts, horizonHours } = food();
    const sim = await Simulator.start({ chain, contracts, horizonHours });
    const state = sim.currentState();

    expect(state.plan).toBeDefined();
    expect(state.plan.shipments.length).toBeGreaterThan(0);
    expect(state.currentHour).toBe(0);
    expect(state.status).toBe('running');
    expect(state.totalCost).toBeUndefined();
  });

  it('initial contract statuses are on-track when the plan has no breach', async () => {
    const { chain, contracts, horizonHours } = food();
    const sim = await Simulator.start({ chain, contracts, horizonHours });
    const state = sim.currentState();
    for (const c of contracts) {
      expect(state.contractDeliveries[c.id]!.status).toBe('on-track');
    }
  });
});

describe('Simulator — state transitions per step(h)', () => {
  it('rejects step(h) when h !== currentHour', async () => {
    const { chain, contracts, horizonHours } = food();
    const sim = await Simulator.start({ chain, contracts, horizonHours });
    expect(() => sim.step(5)).toThrow(/step.*0/);
  });

  it('advances currentHour by exactly one per step(h)', async () => {
    const { chain, contracts, horizonHours } = food();
    const sim = await Simulator.start({ chain, contracts, horizonHours });
    sim.step(0);
    expect(sim.currentState().currentHour).toBe(1);
    sim.step(1);
    expect(sim.currentState().currentHour).toBe(2);
  });

  it('releases planned shipments at their releaseHour', async () => {
    const { chain, contracts, horizonHours } = food();
    const sim = await Simulator.start({ chain, contracts, horizonHours });
    const plan = sim.currentState().plan;
    const firstRelease = Math.min(...plan.shipments.map((s) => s.releaseHour));

    for (let h = 0; h < firstRelease; h++) sim.step(h);
    expect(sim.currentState().inFlight.length).toBe(0);

    sim.step(firstRelease);
    expect(sim.currentState().inFlight.length).toBeGreaterThan(0);
  });

  it('removes shipments from inFlight at their arriveHour', async () => {
    const { chain, contracts, horizonHours } = food();
    const sim = await Simulator.start({ chain, contracts, horizonHours });
    const plan = sim.currentState().plan;
    const lastArrival = plan.shipments.reduce((max, s) => {
      const lane = chain.lanes.find((l) => l.id === s.laneId)!;
      return Math.max(max, s.releaseHour + lane.modes[s.mode].transitHours);
    }, 0);

    for (let h = 0; h <= lastArrival; h++) sim.step(h);
    expect(sim.currentState().inFlight.length).toBe(0);
  });

  it('marks every committed food contract as delivered on time when feasible', async () => {
    const { chain, contracts, horizonHours } = food();
    const sim = await Simulator.start({ chain, contracts, horizonHours });

    for (let h = 0; h < horizonHours; h++) sim.step(h);

    const state = sim.currentState();
    for (const c of contracts) {
      const cd = state.contractDeliveries[c.id]!;
      expect(cd.delivered).toBeGreaterThanOrEqual(c.quantity - 1e-6);
      expect(cd.status).toBe('delivered');
    }
  });
});

describe('Simulator — terminal state', () => {
  it('reaches status="complete" at currentHour=horizonHours with totalCost=plan.totalCost', async () => {
    const { chain, contracts, horizonHours } = food();
    const sim = await Simulator.start({ chain, contracts, horizonHours });
    const expectedCost = sim.currentState().plan.totalCost;

    for (let h = 0; h < horizonHours; h++) sim.step(h);

    const state = sim.currentState();
    expect(state.status).toBe('complete');
    expect(state.currentHour).toBe(horizonHours);
    expect(state.totalCost).toBeCloseTo(expectedCost, 5);
  });

  it('rejects step() once complete', async () => {
    const { chain, contracts, horizonHours } = food();
    const sim = await Simulator.start({ chain, contracts, horizonHours });
    for (let h = 0; h < horizonHours; h++) sim.step(h);
    expect(() => sim.step(horizonHours)).toThrow();
  });
});
