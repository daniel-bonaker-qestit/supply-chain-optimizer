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

export interface ContractTrial {
  /** Trial validation portion (typically 5–10% of the contract quantity). */
  quantity: number;
  /** Trial-shipment delivery deadline (must be earlier than main dueByHour). */
  dueByHour: number;
  /** Initial shelf-life of trial units when shipped (hours). */
  initialShelfLife: number;
  /** Minimum shelf-life remaining at trial-delivery for the trial to pass. */
  minShelfLifeAtDelivery: number;
}

export interface Contract {
  id: ContractId;
  endpoint: NodeId;
  quantity: number;
  /** Main delivery deadline. */
  dueByHour: number;
  revenue: number;
  kind: ContractKind;
  /** When present, the contract follows the trial → main lifecycle. */
  trial?: ContractTrial;
}

export interface Shipment {
  id: string;
  laneId: LaneId;
  mode: Mode;
  quantity: number;
  releasedAtHour: number;
  arrivesAtHour: number;
  contractId?: ContractId;
  /** Initial shelf-life snapshot at release; consumed during transit. */
  shelfLifeAtRelease?: number;
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
