import type { Contract, Plan } from '../domain/types.ts';

/**
 * Buffer time (hours) between the contract's deadline and the plan's last
 * scheduled arrival for that contract.
 *
 *   > 0  → on-track with slack
 *   = 0  → arriving exactly at deadline
 *   < 0  → forced-breach (plan delivers after deadline)
 *
 * Returns Number.POSITIVE_INFINITY if no scheduled arrival exists for the
 * contract (e.g., declined opportunity or fully delivered already).
 */
export function bufferTime(plan: Plan, contract: Contract): number {
  const arrivals = plan.deliveries.filter(
    (d) => d.contractId === contract.id,
  );
  if (arrivals.length === 0) return Number.POSITIVE_INFINITY;
  const lastArrive = Math.max(...arrivals.map((d) => d.arriveHour));
  return contract.dueByHour - lastArrive;
}

export interface BufferRow {
  contractId: string;
  bufferHours: number;
  /** True when buffer < 0 (plan already shows breach). */
  forcedBreach: boolean;
}

export function bufferTimeAll(plan: Plan, contracts: Contract[]): BufferRow[] {
  return contracts.map((c) => {
    const b = bufferTime(plan, c);
    return {
      contractId: c.id,
      bufferHours: b,
      forcedBreach: Number.isFinite(b) && b < 0,
    };
  });
}
