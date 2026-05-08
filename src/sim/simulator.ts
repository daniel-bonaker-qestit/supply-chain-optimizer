import type {
  Chain,
  Contract,
  ContractId,
  Mode,
  NodeId,
  Plan,
  Shipment,
} from '../domain/types.ts';
import {
  generateEvents,
  isWeekendHour,
} from '../events/event-generator.ts';
import type {
  ActiveDisruption,
  SimEvent,
} from '../events/types.ts';
import type { Hazard } from '../hazards/types.ts';
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

export interface EventLogEntry {
  hour: number;
  kind:
    | 'event-fired'
    | 'replan'
    | 'sim-start'
    | 'sim-complete'
    | 'hazard-injected'
    | 'replan-suppressed';
  detail: string;
  eventId?: string;
  hazardId?: string;
}

export interface SimulationState {
  currentHour: number;
  horizonHours: number;
  status: SimulationStatus;
  plan: Plan;
  inFlight: readonly Shipment[];
  contractDeliveries: Readonly<Record<ContractId, ContractDeliveryStatus>>;
  totalCost: number | undefined;
  /** All events scheduled for this run (including those not yet fired). */
  scheduledEvents: readonly SimEvent[];
  /** Active disruptions currently affecting the optimizer. */
  activeDisruptions: readonly ActiveDisruption[];
  /** Chronological log of fired events and replan triggers. */
  eventLog: readonly EventLogEntry[];
  /** Per-non-origin-node on-hand inventory. */
  inventory: Readonly<Record<NodeId, number>>;
  /** Hazards injected into this run, in injection order. */
  injectedHazards: readonly Hazard[];
  /** If a cyberattack is active, replans are suppressed until this hour. */
  replanSuppressedUntilHour: number | undefined;
}

export interface SimulatorInput {
  chain: Chain;
  contracts: Contract[];
  horizonHours: number;
  /** Seed for deterministic event-timeline generation. */
  seed?: string;
  /** Override the default event timeline (for testing). */
  events?: readonly SimEvent[];
}

const DELIVERY_EPSILON = 1e-6;

export class Simulator {
  private currentHour = 0;
  private status: SimulationStatus = 'running';
  private inFlight: Shipment[] = [];
  private contractDeliveries: Record<ContractId, ContractDeliveryStatus>;
  private totalCost: number | undefined = undefined;
  private plannedByReleaseHour: Map<number, Plan['shipments']>;
  private contractsById: Map<ContractId, Contract>;
  private contractsByEndpoint: Map<string, Contract[]>;
  private nonOriginNodes: Set<NodeId>;
  private inventory: Record<NodeId, number>;
  private shipmentCounter = 0;

  private scheduledEvents: SimEvent[];
  private firedEventIds: Set<string> = new Set();
  private activeDisruptions: ActiveDisruption[] = [];
  private eventLog: EventLogEntry[] = [];
  private plan: Plan;
  private injectedHazards: Hazard[] = [];
  private replanSuppressedUntilHour: number | undefined;

  private constructor(
    private readonly input: SimulatorInput,
    initialPlan: Plan,
    events: SimEvent[],
  ) {
    this.plan = initialPlan;
    this.scheduledEvents = events;

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

    this.nonOriginNodes = new Set(
      input.chain.nodes
        .filter((n) => !input.chain.origins.includes(n.id))
        .map((n) => n.id),
    );
    this.inventory = {};
    for (const id of this.nonOriginNodes) this.inventory[id] = 0;

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
            initialPlan.breachByContract[c.id] ?? 0,
          ),
        },
      ]),
    );

    this.plannedByReleaseHour = new Map();
    this.indexPlan(initialPlan);

    this.eventLog.push({
      hour: 0,
      kind: 'sim-start',
      detail: `Run started; ${events.length} events scheduled across the horizon`,
    });
  }

  static async start(input: SimulatorInput): Promise<Simulator> {
    const events =
      input.events !== undefined
        ? [...input.events]
        : generateEvents({
            sector: input.chain.sector,
            seed: input.seed ?? 'default',
            chain: input.chain,
            horizonHours: input.horizonHours,
          });

    const plan = await solve({
      chain: input.chain,
      contracts: input.contracts,
      currentHour: 0,
      horizonHours: input.horizonHours,
      inFlight: [],
      delivered: {},
      currentInventory: {},
      activeDisruptions: [],
    });
    return new Simulator(input, plan, events);
  }

  async step(h: number): Promise<void> {
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

    // Fire events scheduled for this hour (only on active weekdays).
    const eventsAtH = this.scheduledEvents.filter(
      (e) => e.fireHour === h && !this.firedEventIds.has(e.id),
    );
    let needsReplan = false;
    if (!isWeekendHour(h)) {
      for (const e of eventsAtH) {
        this.firedEventIds.add(e.id);
        this.applyEvent(e);
        this.eventLog.push({
          hour: h,
          kind: 'event-fired',
          detail: e.description,
          eventId: e.id,
        });
        needsReplan = true;
      }
    }

    this.currentHour = h + 1;

    if (needsReplan && this.currentHour < this.input.horizonHours) {
      if (this.isReplanSuppressed(this.currentHour)) {
        this.eventLog.push({
          hour: this.currentHour,
          kind: 'replan-suppressed',
          detail:
            'Cyberattack visibility blackout active — replan deferred until blackout ends',
        });
      } else {
        await this.replan();
      }
    }

    this.refreshAllStatuses();

    if (this.currentHour >= this.input.horizonHours) {
      this.status = 'complete';
      this.totalCost = this.computeRealizedCost();
      this.eventLog.push({
        hour: this.currentHour,
        kind: 'sim-complete',
        detail: `Run complete; total cost ${this.totalCost.toFixed(2)}`,
      });
    }
  }

  private async replan(): Promise<void> {
    const newPlan = await solve({
      chain: this.input.chain,
      contracts: this.input.contracts,
      currentHour: this.currentHour,
      horizonHours: this.input.horizonHours,
      inFlight: this.inFlight.slice(),
      delivered: this.snapshotDelivered(),
      currentInventory: { ...this.inventory },
      activeDisruptions: this.activeDisruptions.slice(),
    });
    this.plan = newPlan;
    this.indexPlan(newPlan);
    this.eventLog.push({
      hour: this.currentHour,
      kind: 'replan',
      detail: `Replan produced ${newPlan.shipments.length} new shipments, ${newPlan.deliveries.length} deliveries`,
    });
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
      scheduledEvents: this.scheduledEvents.slice(),
      activeDisruptions: this.activeDisruptions.slice(),
      eventLog: this.eventLog.slice(),
      inventory: { ...this.inventory },
      injectedHazards: this.injectedHazards.slice(),
      replanSuppressedUntilHour: this.replanSuppressedUntilHour,
    };
  }

  async injectHazard(hazard: Hazard): Promise<void> {
    if (this.status === 'complete') {
      throw new Error('cannot inject hazard into a completed simulation');
    }
    this.injectedHazards.push(hazard);
    this.applyHazard(hazard);
    this.eventLog.push({
      hour: this.currentHour,
      kind: 'hazard-injected',
      detail: hazard.description,
      hazardId: hazard.id,
    });

    if (hazard.blocksReplans) {
      // A new cyberattack extends or sets the suppression window.
      const until = hazard.injectedAtHour + hazard.durationHours;
      this.replanSuppressedUntilHour = Math.max(
        this.replanSuppressedUntilHour ?? 0,
        until,
      );
    }

    if (
      this.currentHour < this.input.horizonHours &&
      !this.isReplanSuppressed(this.currentHour)
    ) {
      await this.replan();
    } else if (this.isReplanSuppressed(this.currentHour)) {
      this.eventLog.push({
        hour: this.currentHour,
        kind: 'replan-suppressed',
        detail:
          'Cyberattack visibility blackout active — hazard-triggered replan deferred',
      });
    }
  }

  private isReplanSuppressed(hour: number): boolean {
    return (
      this.replanSuppressedUntilHour !== undefined &&
      hour < this.replanSuppressedUntilHour
    );
  }

  private applyHazard(h: Hazard): void {
    const fromHour = h.injectedAtHour;
    const toHour = h.persistThroughHorizon
      ? this.input.horizonHours
      : h.injectedAtHour + h.durationHours;
    const baseId = `disr-${h.id}`;
    let n = 0;
    const push = (
      d: Omit<ActiveDisruption, 'id' | 'source' | 'sourceId' | 'fromHour' | 'toHour'>,
    ) => {
      this.activeDisruptions.push({
        id: `${baseId}-${n++}`,
        source: 'hazard',
        sourceId: h.id,
        fromHour,
        toHour,
        ...d,
      });
    };
    switch (h.type) {
      case 'strike':
      case 'catastrophic-node-loss':
      case 'weather-event':
        if (h.targetNodeId) {
          push({
            nodeId: h.targetNodeId,
            effectKind:
              (h.capacityFactor ?? 0) === 0
                ? 'block'
                : 'capacity-factor',
            capacityFactor: h.capacityFactor,
          });
        }
        break;
      case 'border-closure':
      case 'sanctions':
        for (const lid of h.targetLaneIds ?? []) {
          push({
            laneId: lid,
            effectKind:
              (h.capacityFactor ?? 0) === 0
                ? 'block'
                : 'capacity-factor',
            capacityFactor: h.capacityFactor,
          });
        }
        break;
      case 'pandemic':
        push({
          effectKind: 'capacity-factor',
          capacityFactor: h.capacityFactor,
        });
        break;
      case 'equipment-recall':
        if (h.blockMode) {
          push({
            mode: h.blockMode,
            effectKind: 'block',
          });
        }
        break;
      case 'cyberattack':
        // No state-disruption — only a replan-suppression window. We still
        // record the disruption with a no-op effect so the UI can surface it.
        push({
          effectKind: 'capacity-factor',
          capacityFactor: 1,
        });
        break;
    }
  }

  private indexPlan(plan: Plan): void {
    this.plannedByReleaseHour = new Map();
    for (const s of plan.shipments) {
      const list = this.plannedByReleaseHour.get(s.releaseHour) ?? [];
      list.push(s);
      this.plannedByReleaseHour.set(s.releaseHour, list);
    }
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
      const node = lane.to;
      // Increment node inventory (intermediate or endpoint).
      if (this.nonOriginNodes.has(node)) {
        this.inventory[node] = (this.inventory[node] ?? 0) + s.quantity;
      }
      if (this.contractsByEndpoint.has(node)) {
        arrivalsByEndpoint.set(
          node,
          (arrivalsByEndpoint.get(node) ?? 0) + s.quantity,
        );
      }
    }
    this.inFlight = remaining;

    for (const [endpoint, qty] of arrivalsByEndpoint) {
      this.allocateArrivalsToContracts(endpoint, qty, h);
    }
  }

  private allocateArrivalsToContracts(
    endpoint: string,
    units: number,
    arrivalHour: number,
  ): void {
    let remaining = units;
    const contracts = this.contractsByEndpoint.get(endpoint) ?? [];
    for (const c of contracts) {
      if (remaining <= DELIVERY_EPSILON) break;
      // Skip past-deadline contracts.
      if (c.dueByHour <= arrivalHour) continue;
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
      // Decrement origin inventory (only for non-origin nodes; origin is unbounded source).
      if (this.nonOriginNodes.has(lane.from)) {
        this.inventory[lane.from] =
          (this.inventory[lane.from] ?? 0) - sc.quantity;
      }
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

  private snapshotDelivered(): Record<ContractId, number> {
    const out: Record<ContractId, number> = {};
    for (const [id, cd] of Object.entries(this.contractDeliveries)) {
      out[id] = cd.delivered;
    }
    return out;
  }

  private applyEvent(e: SimEvent): void {
    const fromHour = e.fireHour;
    const toHour = e.fireHour + e.durationHours;
    const baseId = `disr-${e.id}`;
    let n = 0;
    const push = (
      d: Omit<ActiveDisruption, 'id' | 'source' | 'sourceId'>,
    ) => {
      this.activeDisruptions.push({
        id: `${baseId}-${n++}`,
        source: 'event',
        sourceId: e.id,
        ...d,
      });
    };
    switch (e.type) {
      case 'origin-warehouse-delay':
      case 'contamination-alert':
        if (e.targetNodeId) {
          push({
            fromHour,
            toHour,
            nodeId: e.targetNodeId,
            effectKind:
              (e.capacityFactor ?? 0) === 0
                ? 'block'
                : 'capacity-factor',
            capacityFactor: e.capacityFactor,
          });
        }
        break;
      case 'lane-disruption':
        if (e.targetLaneId) {
          push({
            fromHour,
            toHour,
            laneId: e.targetLaneId,
            effectKind:
              (e.capacityFactor ?? 0) === 0
                ? 'block'
                : 'capacity-factor',
            capacityFactor: e.capacityFactor,
          });
        }
        break;
      case 'mode-disruption':
        if (e.targetLaneId && e.blockMode) {
          push({
            fromHour,
            toHour,
            laneId: e.targetLaneId,
            mode: e.blockMode,
            effectKind: 'block',
          });
        }
        break;
      case 'price-spike':
        if (e.targetLaneId) {
          push({
            fromHour,
            toHour,
            laneId: e.targetLaneId,
            mode: e.targetMode,
            effectKind: 'price-multiplier',
            priceMultiplier: e.priceMultiplier,
          });
        }
        break;
      case 'spoilage-incident':
        // Slice 5 will hook quality-state; no LP effect for now.
        break;
    }
  }

  private computeRealizedCost(): number {
    // Realized cost ledger: transport (per shipment, with disruption-time price) +
    // holding (sim-tracked inventory over the run) + breach * sum(shortfall).
    // For slice 3 we use the latest plan's totalCost as the canonical figure
    // since the deterministic LP computes it correctly given the current state.
    return this.plan.totalCost;
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

// Used by Simulator.applyEvent — re-export to keep import surface small.
export type { Mode };
