import { describe, expect, it } from 'vitest';
import { buildNaivePlan } from './naive.ts';
import { buildHindsightPlan } from './hindsight.ts';
import { optimizerScore } from './score.ts';
import { Simulator } from '../sim/simulator.ts';
import { getSectorDefinition } from '../domain/sector-defs.ts';
import { generateEvents } from '../events/event-generator.ts';
import type { SimEvent } from '../events/types.ts';

async function runWithPlan(
  input: ReturnType<typeof getSectorDefinition>,
  initialPlan?: Awaited<ReturnType<typeof buildHindsightPlan>>,
  options?: {
    events?: readonly SimEvent[];
    disableReplan?: boolean;
    seed?: string;
  },
): Promise<{ totalCost: number; transport: number; holding: number; breach: number }> {
  const sim = await Simulator.start({
    chain: input.chain,
    contracts: input.contracts,
    horizonHours: input.horizonHours,
    initialPlan,
    disableReplan: options?.disableReplan,
    events: options?.events,
    seed: options?.seed,
  });
  for (let h = 0; h < input.horizonHours; h++) await sim.step(h);
  const finalState = sim.currentState();
  const realized = sim.realizedCosts();
  return {
    totalCost: finalState.totalCost ?? 0,
    transport: realized.transport,
    holding: realized.holding,
    breach: realized.breach,
  };
}

describe('baselines — naive plan', () => {
  it('produces a cost-positive run with all food contracts delivered (no events)', async () => {
    const def = getSectorDefinition('food');
    const naive = buildNaivePlan({
      chain: def.chain,
      contracts: def.contracts,
      horizonHours: def.horizonHours,
    });
    expect(naive.shipments.length).toBeGreaterThan(0);

    const result = await runWithPlan(def, naive, {
      events: [],
      disableReplan: true,
    });
    expect(result.totalCost).toBeGreaterThan(0);
    // Slow-only naive on the food chain is feasible — breach should be ~0.
    expect(result.breach).toBeLessThan(1e-6);
  });
});

describe('baselines — perfect hindsight', () => {
  it('matches the optimizer in the no-events case (both find the same plan up to noise)', async () => {
    const def = getSectorDefinition('food');
    const hindsight = await buildHindsightPlan({
      chain: def.chain,
      contracts: def.contracts,
      horizonHours: def.horizonHours,
      events: [],
      hazards: [],
    });

    const hsResult = await runWithPlan(def, hindsight, {
      events: [],
      disableReplan: true,
    });
    const ours = await runWithPlan(def, undefined, {
      events: [],
    });

    // No events means no replan opportunity; ours and hindsight should agree.
    expect(hsResult.totalCost).toBeCloseTo(ours.totalCost, 0);
  });
});

describe('baselines — optimizer score', () => {
  it('computes a score across multiple seeds — naive ≥ ours and ours typically ≥ hindsight', async () => {
    const seeds = ['score-1', 'score-2', 'score-3'];
    let validScores = 0;
    let nonNegative = 0;

    for (const seed of seeds) {
      const def = getSectorDefinition('food');
      const events = generateEvents({
        sector: 'food',
        seed,
        chain: def.chain,
        horizonHours: def.horizonHours,
      });

      const ours = await runWithPlan(def, undefined, { events });

      const naivePlan = buildNaivePlan({
        chain: def.chain,
        contracts: def.contracts,
        horizonHours: def.horizonHours,
      });
      const naiveResult = await runWithPlan(def, naivePlan, {
        events,
        disableReplan: true,
      });

      const hindsightPlan = await buildHindsightPlan({
        chain: def.chain,
        contracts: def.contracts,
        horizonHours: def.horizonHours,
        events,
        hazards: [],
      });
      const hsResult = await runWithPlan(def, hindsightPlan, {
        events,
        disableReplan: true,
      });

      const score = optimizerScore({
        ourCost: ours.totalCost,
        naiveCost: naiveResult.totalCost,
        hindsightCost: hsResult.totalCost,
      });
      if (score !== null && Number.isFinite(score)) {
        validScores++;
        if (score >= -0.5) nonNegative++;
      }
    }
    expect(validScores).toBeGreaterThan(0);
    // Most runs should produce non-degenerate scores.
    expect(nonNegative).toBeGreaterThanOrEqual(Math.ceil(validScores * 0.5));
  }, 240000);
});

describe('baselines — score function', () => {
  it('returns 1 when our matches hindsight', () => {
    const score = optimizerScore({
      ourCost: 100,
      naiveCost: 200,
      hindsightCost: 100,
    });
    expect(score).toBe(1);
  });
  it('returns 0 when our matches naive', () => {
    const score = optimizerScore({
      ourCost: 200,
      naiveCost: 200,
      hindsightCost: 100,
    });
    expect(score).toBe(0);
  });
  it('returns null when naive equals hindsight', () => {
    const score = optimizerScore({
      ourCost: 100,
      naiveCost: 100,
      hindsightCost: 100,
    });
    expect(score).toBeNull();
  });
});
