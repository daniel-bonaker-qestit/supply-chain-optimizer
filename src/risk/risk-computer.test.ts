import { describe, expect, it } from 'vitest';
import { bufferTime, bufferTimeAll } from './risk-computer.ts';
import type { Contract, Plan } from '../domain/types.ts';

const c: Contract = {
  id: 'c1',
  endpoint: 'sink',
  quantity: 100,
  dueByHour: 50,
  revenue: 10,
  kind: 'committed',
};

const planFor = (deliveries: Array<{ arriveHour: number }>) => ({
  shipments: [],
  deliveries: deliveries.map((d) => ({
    contractId: c.id,
    arriveHour: d.arriveHour,
    quantity: 100,
  })),
  totalCost: 0,
  breachByContract: { [c.id]: 0 },
}) as Plan;

describe('risk-computer.bufferTime', () => {
  it('returns positive buffer when arrival is before deadline', () => {
    expect(bufferTime(planFor([{ arriveHour: 40 }]), c)).toBe(10);
  });
  it('returns 0 when arrival exactly at deadline', () => {
    expect(bufferTime(planFor([{ arriveHour: 50 }]), c)).toBe(0);
  });
  it('returns negative when arrival after deadline (forced breach)', () => {
    expect(bufferTime(planFor([{ arriveHour: 60 }]), c)).toBe(-10);
  });
  it('returns +Infinity when no arrival is scheduled', () => {
    expect(bufferTime(planFor([]), c)).toBe(Number.POSITIVE_INFINITY);
  });
  it('uses the latest arrival when multiple chunks deliver to the same contract', () => {
    expect(
      bufferTime(planFor([{ arriveHour: 30 }, { arriveHour: 45 }]), c),
    ).toBe(5);
  });
});

describe('risk-computer.bufferTimeAll', () => {
  it('returns one row per contract with forced-breach flag', () => {
    const rows = bufferTimeAll(planFor([{ arriveHour: 60 }]), [c]);
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual({
      contractId: 'c1',
      bufferHours: -10,
      forcedBreach: true,
    });
  });
});
