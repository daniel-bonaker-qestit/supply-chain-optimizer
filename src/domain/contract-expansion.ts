import type { Contract, ContractId } from './types.ts';

export type ContractPhase = 'whole' | 'trial' | 'main';

export interface SubContractRef {
  id: ContractId;
  originalId: ContractId;
  phase: ContractPhase;
}

export const TRIAL_SUFFIX = '::trial';
export const MAIN_SUFFIX = '::main';

export function expandContractsForOptimizer(contracts: Contract[]): {
  expanded: Contract[];
  subRefs: Map<ContractId, SubContractRef>;
} {
  const expanded: Contract[] = [];
  const subRefs = new Map<ContractId, SubContractRef>();

  for (const c of contracts) {
    if (!c.trial) {
      expanded.push(c);
      subRefs.set(c.id, { id: c.id, originalId: c.id, phase: 'whole' });
      continue;
    }
    const trialId = `${c.id}${TRIAL_SUFFIX}`;
    const mainId = `${c.id}${MAIN_SUFFIX}`;
    const trialQty = Math.max(0, c.trial.quantity);
    const mainQty = Math.max(0, c.quantity - trialQty);

    expanded.push({
      id: trialId,
      endpoint: c.endpoint,
      quantity: trialQty,
      dueByHour: c.trial.dueByHour,
      revenue: c.revenue,
      kind: c.kind,
    });
    expanded.push({
      id: mainId,
      endpoint: c.endpoint,
      quantity: mainQty,
      dueByHour: c.dueByHour,
      revenue: c.revenue,
      kind: c.kind,
    });
    subRefs.set(trialId, { id: trialId, originalId: c.id, phase: 'trial' });
    subRefs.set(mainId, { id: mainId, originalId: c.id, phase: 'main' });
  }

  return { expanded, subRefs };
}
