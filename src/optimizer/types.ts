import type { Chain, Contract, ContractId, Shipment } from '../domain/types.ts';

export interface OptimizerState {
  chain: Chain;
  contracts: Contract[];
  currentHour: number;
  horizonHours: number;
  inFlight: readonly Shipment[];
  delivered: Readonly<Record<ContractId, number>>;
}
