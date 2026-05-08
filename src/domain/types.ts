export type Sector = 'food';

export type Mode = 'slow' | 'fast';

export type NodeId = string;
export type LaneId = string;
export type ContractId = string;

export interface SupplyNode {
  id: NodeId;
  layer: number;
  holdingCostPerUnitHour: number;
  label?: string;
}

export interface ModeProfile {
  transitHours: number;
  costPerUnit: number;
}

export interface LaneCapacity {
  perHour: number;
}

export interface Lane {
  id: LaneId;
  from: NodeId;
  to: NodeId;
  capacity: LaneCapacity;
  modes: Record<Mode, ModeProfile>;
}

export interface Chain {
  sector: Sector;
  nodes: SupplyNode[];
  lanes: Lane[];
  origins: NodeId[];
}

export type ContractKind = 'committed' | 'opportunity';

export interface Contract {
  id: ContractId;
  endpoint: NodeId;
  quantity: number;
  dueByHour: number;
  revenue: number;
  kind: ContractKind;
}

export interface Shipment {
  id: string;
  laneId: LaneId;
  mode: Mode;
  quantity: number;
  releasedAtHour: number;
  arrivesAtHour: number;
  contractId?: ContractId;
}

export interface ShipmentCommitment {
  laneId: LaneId;
  mode: Mode;
  releaseHour: number;
  quantity: number;
  contractId?: ContractId;
}

export interface DeliveryCommitment {
  contractId: ContractId;
  arriveHour: number;
  quantity: number;
}

export interface Plan {
  shipments: ShipmentCommitment[];
  deliveries: DeliveryCommitment[];
  totalCost: number;
  breachByContract: Readonly<Record<ContractId, number>>;
}
