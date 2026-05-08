import type {
  Chain,
  Contract,
  ContractId,
  NodeId,
  Shipment,
} from '../domain/types.ts';
import type { ActiveDisruption } from '../events/types.ts';

export interface OptimizerState {
  chain: Chain;
  contracts: Contract[];
  currentHour: number;
  horizonHours: number;
  inFlight: readonly Shipment[];
  delivered: Readonly<Record<ContractId, number>>;
  /**
   * On-hand inventory at each non-origin node at currentHour (intermediate +
   * endpoint). Endpoints' inventory equals sum of delivered_so_far across
   * contracts at that endpoint.
   */
  currentInventory?: Readonly<Record<NodeId, number>>;
  /** Active disruptions to apply during LP build. */
  activeDisruptions?: readonly ActiveDisruption[];
}
