import { describe, expect, it } from 'vitest';
import highsLoader from 'highs';

describe('highs loads in Vitest Node env', () => {
  it('solves a trivial LP', async () => {
    const highs = await highsLoader();
    const sol = highs.solve(`Minimize
 obj: x
Subject To
 c1: x >= 5
Bounds
 0 <= x
End`);
    expect(sol.Status).toBe('Optimal');
    expect(sol.ObjectiveValue).toBeCloseTo(5);
  });
});
