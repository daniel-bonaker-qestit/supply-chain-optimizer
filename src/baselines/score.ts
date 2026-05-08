export interface OptimizerScoreInput {
  ourCost: number;
  naiveCost: number;
  hindsightCost: number;
}

/**
 * Optimizer score = (naive_cost - our_cost) / (naive_cost - hindsight_cost).
 *
 *   1.0 → our optimizer captured all available improvement
 *   0.0 → no improvement over naive
 *  <0.0 → worse than naive (broken optimizer or unlucky naive plan)
 *
 * Returns null when naive == hindsight (denominator is zero — no headroom).
 */
export function optimizerScore({
  ourCost,
  naiveCost,
  hindsightCost,
}: OptimizerScoreInput): number | null {
  const denom = naiveCost - hindsightCost;
  if (Math.abs(denom) < 1e-9) return null;
  return (naiveCost - ourCost) / denom;
}
