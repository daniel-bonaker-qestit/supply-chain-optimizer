import type {
  Chain,
  Contract,
  ContractId,
  Plan,
  Shipment,
} from '../domain/types.ts';
import { solve } from '../optimizer/optimizer.ts';

export type SimulationStatus = 'running' | 'complete';
export type ContractStatus =
  | 'on-track'
  | 'pending'
  | 'delivered'
  | 'breached';

export interface ContractDeliveryStatus {
  contractId: ContractId;
  delivered: number;
  status: ContractStatus;
}

export interface SimulationState {
  currentHour: number;
  horizonHours: number;
  status: SimulationStatus;
  plan: Plan;
  inFlight: readonly Shipment[];
  contractDeliveries: Readonly<Record<ContractId, ContractDeliveryStatus>>;
  totalCost: number | undefined;
}

export interface SimulatorInput {
  chain: Chain;
  contracts: Contract[];
  horizonHours: number;
}

const DELIVERY_EPSILON = 1e-6;

export class Simulator {
  private currentHour = 0;
  private status: SimulationStatus = 'running';
  private inFlight: Shipment[] = [];
  private contractDeliveries: Record<ContractId, ContractDeliveryStatus>;
  private totalCost: number | undefined = undefined;
  private plannedByReleaseHour: Map<
    number,
    Plan['shipments']
  >;
  private contractsById: Map<ContractId, Contract>;
  private contractsByEndpoint: Map<string, Contract[]>;
  private shipmentCounter = 0;

  private constructor(
    private readonly input: SimulatorInput,
    private readonly plan: Plan,
  ) {
    this.contractsById = new Map(input.contracts.map((c) => [c.id, c]));
    this.contractsByEndpoint = new Map();
    for (const c of input.contracts) {
      const list = this.contractsByEndpoint.get(c.endpoint) ?? [];
      list.push(c);
      this.contractsByEndpoint.set(c.endpoint, list);
    }
    for (const list of this.contractsByEndpoint.values()) {
      list.sort((a, b) => a.dueByHour - b.dueByHour);
    }

    this.contractDeliveries = Object.fromEntries(
      input.contracts.map((c) => [
        c.id,
        {
          contractId: c.id,
          delivered: 0,
          status: deriveStatus(
            c,
            0,
            0,
            plan.breachByContract[c.id] ?? 0,
          ),
        },
      ]),
    );

    this.plannedByReleaseHour = new Map();
    for (const s of plan.shipments) {
      const list = this.plannedByReleaseHour.get(s.releaseHour) ?? [];
      list.push(s);
      this.plannedByReleaseHour.set(s.releaseHour, list);
    }
  }

  static async start(input: SimulatorInput): Promise<Simulator> {
    const plan = await solve({
      chain: input.chain,
      contracts: input.contracts,
      currentHour: 0,
      horizonHours: input.horizonHours,
      inFlight: [],
      delivered: {},
    });
    return new Simulator(input, plan);
  }

  step(h: number): void {
    if (this.status === 'complete') {
      throw new Error('step called on a completed simulation');
    }
    if (h !== this.currentHour) {
      throw new Error(
        `step called with hour ${h}, expected ${this.currentHour}`,
      );
    }
    if (h >= this.input.horizonHours) {
      throw new Error(`step called beyond horizon ${this.input.horizonHours}`);
    }

    this.processArrivals(h);
    this.processReleases(h);

    this.currentHour = h + 1;
    this.refreshAllStatuses();

    if (this.currentHour >= this.input.horizonHours) {
      this.status = 'complete';
      this.totalCost = this.plan.totalCost;
    }
  }

  currentState(): SimulationState {
    return {
      currentHour: this.currentHour,
      horizonHours: this.input.horizonHours,
      status: this.status,
      plan: this.plan,
      inFlight: this.inFlight.slice(),
      contractDeliveries: { ...this.contractDeliveries },
      totalCost: this.totalCost,
    };
  }

  private processArrivals(h: number): void {
    const remaining: Shipment[] = [];
    const arrivalsByEndpoint = new Map<string, number>();

    for (const s of this.inFlight) {
      if (s.arrivesAtHour !== h) {
        remaining.push(s);
        continue;
      }
      const lane = this.input.chain.lanes.find((l) => l.id === s.laneId);
      if (!lane) continue;
      const endpoint = lane.to;
      if (this.contractsByEndpoint.has(endpoint)) {
        arrivalsByEndpoint.set(
          endpoint,
          (arrivalsByEndpoint.get(endpoint) ?? 0) + s.quantity,
        );
      }
    }
    this.inFlight = remaining;

    for (const [endpoint, qty] of arrivalsByEndpoint) {
      this.allocateArrivalsToContracts(endpoint, qty);
    }
  }

  private allocateArrivalsToContracts(endpoint: string, units: number): void {
    let remaining = units;
    const contracts = this.contractsByEndpoint.get(endpoint) ?? [];
    for (const c of contracts) {
      if (remaining <= DELIVERY_EPSILON) break;
      const status = this.contractDeliveries[c.id]!;
      const need = c.quantity - status.delivered;
      if (need <= DELIVERY_EPSILON) continue;
      const give = Math.min(need, remaining);
      status.delivered += give;
      remaining -= give;
    }
  }

  private processReleases(h: number): void {
    const due = this.plannedByReleaseHour.get(h);
    if (!due) return;
    for (const sc of due) {
      const lane = this.input.chain.lanes.find((l) => l.id === sc.laneId);
      if (!lane) {
        throw new Error(
          `Plan references unknown lane ${sc.laneId} at hour ${h}`,
        );
      }
      const transit = lane.modes[sc.mode].transitHours;
      this.inFlight.push({
        id: `ship-${this.shipmentCounter++}`,
        laneId: sc.laneId,
        mode: sc.mode,
        quantity: sc.quantity,
        releasedAtHour: sc.releaseHour,
        arrivesAtHour: sc.releaseHour + transit,
        contractId: sc.contractId,
      });
    }
  }

  private refreshAllStatuses(): void {
    for (const c of this.input.contracts) {
      const cd = this.contractDeliveries[c.id]!;
      cd.status = deriveStatus(
        c,
        this.currentHour,
        cd.delivered,
        this.plan.breachByContract[c.id] ?? 0,
      );
    }
  }
}

function deriveStatus(
  c: Contract,
  currentHour: number,
  delivered: number,
  plannedBreach: number,
): ContractStatus {
  if (delivered >= c.quantity - DELIVERY_EPSILON) return 'delivered';
  if (currentHour > c.dueByHour) return 'breached';
  if (plannedBreach > DELIVERY_EPSILON) return 'pending';
  return 'on-track';
}
