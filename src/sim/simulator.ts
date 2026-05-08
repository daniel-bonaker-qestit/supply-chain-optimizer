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
  expandContractsForOptimizer,
  type SubContractRef,
  TRIAL_SUFFIX,
} from '../domain/contract-expansion.ts';
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
import { shelfLifeCostOfLeg } from '../quality/food-shelf-life.ts';

export type SimulationStatus = 'running' | 'complete';
export type ContractStatus =
  | 'on-track'
  | 'pending'
  | 'delivered'
  | 'breached'
  | 'trial-pending'
  | 'main-active'
  | 'voided'
  | 'declined';

export interface ContractDeliveryStatus {
  contractId: ContractId;
  delivered: number;
  trialDelivered: number;
  mainDelivered: number;
  status: ContractStatus;
  /** undefined = not yet evaluated; true = passed; false = failed. */
  trialQualityPassed: boolean | undefined;
  /** Minimum shelf-life observed across trial-allocated chunks (Infinity if none). */
  trialMinShelfLife: number;
}

export interface EventLogEntry {
  hour: number;
  kind:
    | 'event-fired'
    | 'replan'
    | 'sim-start'
    | 'sim-complete'
    | 'hazard-injected'
    | 'replan-suppressed'
    | 'trial-evaluated'
    | 'opportunity-arrived'
    | 'opportunity-accepted'
    | 'opportunity-declined';
  detail: string;
  eventId?: string;
  hazardId?: string;
  contractId?: ContractId;
}

export interface SimulationState {
  currentHour: number;
  horizonHours: number;
  status: SimulationStatus;
  plan: Plan;
  inFlight: readonly Shipment[];
  contractDeliveries: Readonly<Record<ContractId, ContractDeliveryStatus>>;
  totalCost: number | undefined;
  scheduledEvents: readonly SimEvent[];
  activeDisruptions: readonly ActiveDisruption[];
  eventLog: readonly EventLogEntry[];
  inventory: Readonly<Record<NodeId, number>>;
  injectedHazards: readonly Hazard[];
  replanSuppressedUntilHour: number | undefined;
}

export interface SimulatorInput {
  chain: Chain;
  contracts: Contract[];
  horizonHours: number;
  seed?: string;
  events?: readonly SimEvent[];
}

const DELIVERY_EPSILON = 1e-6;

interface FifoEntry {
  qty: number;
  shelfLife: number;
}

export class Simulator {
  private currentHour = 0;
  private status: SimulationStatus = 'running';
  private inFlight: Shipment[] = [];
  private subContractDeliveries: Record<ContractId, number> = {};
  private contractDeliveries: Record<ContractId, ContractDeliveryStatus>;
  private totalCost: number | undefined = undefined;
  private plannedByReleaseHour: Map<number, Plan['shipments']>;
  private contractsByEndpoint: Map<string, Contract[]>;
  private nonOriginNodes: Set<NodeId>;
  private inventory: Record<NodeId, number>;
  private nodeFifoQueues: Record<NodeId, FifoEntry[]>;
  private shipmentCounter = 0;

  private scheduledEvents: SimEvent[];
  private firedEventIds: Set<string> = new Set();
  private activeDisruptions: ActiveDisruption[] = [];
  private eventLog: EventLogEntry[] = [];
  private plan: Plan;
  private injectedHazards: Hazard[] = [];
  private replanSuppressedUntilHour: number | undefined;

  private originalContracts: Contract[];
  /** Working copy of the expanded sub-contract list passed to the optimizer. */
  private expandedContracts: Contract[];
  private subRefs: Map<ContractId, SubContractRef>;
  private pendingOpportunityIds: Set<ContractId> = new Set();
  private declinedOpportunityIds: Set<ContractId> = new Set();

  private constructor(
    private readonly input: SimulatorInput,
    initialPlan: Plan,
    events: SimEvent[],
    expanded: Contract[],
    subRefs: Map<ContractId, SubContractRef>,
  ) {
    this.plan = initialPlan;
    this.scheduledEvents = events;
    this.originalContracts = input.contracts;
    this.expandedContracts = expanded.map((c) => ({ ...c }));
    this.subRefs = subRefs;

    this.contractsByEndpoint = new Map();
    for (const c of this.expandedContracts) {
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
    this.nodeFifoQueues = {};
    for (const id of this.nonOriginNodes) {
      this.inventory[id] = 0;
      this.nodeFifoQueues[id] = [];
    }

    for (const c of this.expandedContracts) {
      this.subContractDeliveries[c.id] = 0;
    }

    this.contractDeliveries = Object.fromEntries(
      this.originalContracts.map((c) => [
        c.id,
        {
          contractId: c.id,
          delivered: 0,
          trialDelivered: 0,
          mainDelivered: 0,
          status: c.trial ? ('trial-pending' as const) : ('on-track' as const),
          trialQualityPassed: undefined,
          trialMinShelfLife: Number.POSITIVE_INFINITY,
        },
      ]),
    );
    this.refreshAllStatuses(); // adjust for initial plan breach forecasts.

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

    const { expanded, subRefs } = expandContractsForOptimizer(
      input.contracts,
    );

    const plan = await solve({
      chain: input.chain,
      contracts: expanded,
      currentHour: 0,
      horizonHours: input.horizonHours,
      inFlight: [],
      delivered: {},
      currentInventory: {},
      activeDisruptions: [],
    });
    return new Simulator(input, plan, events, expanded, subRefs);
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

    const eventsAtH = this.scheduledEvents.filter(
      (e) => e.fireHour === h && !this.firedEventIds.has(e.id),
    );
    let needsReplan = false;
    if (!isWeekendHour(h)) {
      for (const e of eventsAtH) {
        this.firedEventIds.add(e.id);
        if (e.type === 'opportunity-arrival' && e.opportunityContract) {
          this.handleOpportunityArrival(e.opportunityContract);
          this.eventLog.push({
            hour: h,
            kind: 'opportunity-arrived',
            detail: e.description,
            eventId: e.id,
            contractId: e.opportunityContract.id,
          });
        } else {
          this.applyEvent(e);
          this.eventLog.push({
            hour: h,
            kind: 'event-fired',
            detail: e.description,
            eventId: e.id,
          });
        }
        needsReplan = true;
      }
    }

    this.currentHour = h + 1;

    // Evaluate trial-deadline transitions after arrivals at hour h
    // (since arrivals at hour h count against trial deadlines).
    const trialReplanNeeded = this.evaluateTrialDeadlines();
    if (trialReplanNeeded) needsReplan = true;

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
      this.totalCost = this.plan.totalCost;
      this.eventLog.push({
        hour: this.currentHour,
        kind: 'sim-complete',
        detail: `Run complete; total cost ${this.totalCost.toFixed(2)}`,
      });
    }
  }

  private async replan(): Promise<void> {
    const subToOriginal: Record<ContractId, ContractId> = {};
    for (const [subId, ref] of this.subRefs) {
      subToOriginal[subId] = ref.originalId;
    }
    const newPlan = await solve({
      chain: this.input.chain,
      contracts: this.expandedContracts,
      currentHour: this.currentHour,
      horizonHours: this.input.horizonHours,
      inFlight: this.inFlight.slice(),
      delivered: { ...this.subContractDeliveries },
      currentInventory: { ...this.inventory },
      activeDisruptions: this.activeDisruptions.slice(),
      pendingOpportunityIds: [...this.pendingOpportunityIds],
      subToOriginal,
    });
    this.plan = newPlan;
    this.indexPlan(newPlan);
    this.eventLog.push({
      hour: this.currentHour,
      kind: 'replan',
      detail: `Replan produced ${newPlan.shipments.length} new shipments, ${newPlan.deliveries.length} deliveries`,
    });
    this.processOpportunityDecisions(newPlan);
  }

  private processOpportunityDecisions(plan: Plan): void {
    for (const accId of plan.acceptedOpportunityIds ?? []) {
      if (!this.pendingOpportunityIds.has(accId)) continue;
      this.pendingOpportunityIds.delete(accId);
      this.eventLog.push({
        hour: this.currentHour,
        kind: 'opportunity-accepted',
        detail: `Optimizer accepted opportunity ${accId} (revenue exceeds marginal cost)`,
        contractId: accId,
      });
    }
    for (const decId of plan.declinedOpportunityIds ?? []) {
      if (!this.pendingOpportunityIds.has(decId)) continue;
      this.pendingOpportunityIds.delete(decId);
      this.declinedOpportunityIds.add(decId);

      // Remove the declined opportunity from the working contract list.
      const cd = this.contractDeliveries[decId];
      if (cd) cd.status = 'declined';
      // Zero out sub-contract quantities so future replans see no demand.
      for (const sub of this.expandedContracts) {
        const ref = this.subRefs.get(sub.id);
        if (ref?.originalId === decId) sub.quantity = 0;
      }
      this.eventLog.push({
        hour: this.currentHour,
        kind: 'opportunity-declined',
        detail: `Optimizer declined opportunity ${decId} (cost exceeds revenue or capacity bound by committed)`,
        contractId: decId,
      });
    }
  }

  private handleOpportunityArrival(opportunity: Contract): void {
    // Append to original list.
    this.originalContracts = [...this.originalContracts, opportunity];

    const { expanded, subRefs } = expandContractsForOptimizer([opportunity]);
    for (const sub of expanded) {
      this.expandedContracts.push(sub);
      this.subContractDeliveries[sub.id] = 0;
      const list = this.contractsByEndpoint.get(sub.endpoint) ?? [];
      list.push(sub);
      list.sort((a, b) => a.dueByHour - b.dueByHour);
      this.contractsByEndpoint.set(sub.endpoint, list);
    }
    for (const [k, v] of subRefs) this.subRefs.set(k, v);

    this.contractDeliveries[opportunity.id] = {
      contractId: opportunity.id,
      delivered: 0,
      trialDelivered: 0,
      mainDelivered: 0,
      status: opportunity.trial ? 'trial-pending' : 'on-track',
      trialQualityPassed: undefined,
      trialMinShelfLife: Number.POSITIVE_INFINITY,
    };

    this.pendingOpportunityIds.add(opportunity.id);
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

  private indexPlan(plan: Plan): void {
    this.plannedByReleaseHour = new Map();
    for (const s of plan.shipments) {
      const list = this.plannedByReleaseHour.get(s.releaseHour) ?? [];
      list.push(s);
      this.plannedByReleaseHour.set(s.releaseHour, list);
    }
  }

  private processArrivals(h: number): void {
    const arriving: Shipment[] = [];
    const remaining: Shipment[] = [];
    for (const s of this.inFlight) {
      if (s.arrivesAtHour === h) arriving.push(s);
      else remaining.push(s);
    }
    this.inFlight = remaining;

    for (const s of arriving) {
      const lane = this.input.chain.lanes.find((l) => l.id === s.laneId);
      if (!lane) continue;
      const node = lane.to;
      const transit = lane.modes[s.mode].transitHours;
      const arrivedShelfLife = Math.max(
        0,
        (s.shelfLifeAtRelease ?? 0) - shelfLifeCostOfLeg(s.mode, transit),
      );
      const isEndpoint = this.contractsByEndpoint.has(node);

      if (this.nonOriginNodes.has(node)) {
        this.inventory[node] = (this.inventory[node] ?? 0) + s.quantity;
      }

      if (isEndpoint) {
        this.allocateEndpointArrival(node, s.quantity, arrivedShelfLife, h);
      } else if (this.nonOriginNodes.has(node)) {
        this.enqueueAtNode(node, s.quantity, arrivedShelfLife);
      }
    }
  }

  private allocateEndpointArrival(
    endpoint: NodeId,
    units: number,
    shelfLife: number,
    arrivalHour: number,
  ): void {
    let remaining = units;
    const subList = this.contractsByEndpoint.get(endpoint) ?? [];
    for (const sub of subList) {
      if (remaining <= DELIVERY_EPSILON) break;
      if (sub.quantity <= DELIVERY_EPSILON) continue;
      // Skip past-deadline sub-contracts.
      if (sub.dueByHour <= arrivalHour) continue;
      const delivered = this.subContractDeliveries[sub.id] ?? 0;
      const need = sub.quantity - delivered;
      if (need <= DELIVERY_EPSILON) continue;
      const give = Math.min(need, remaining);
      this.subContractDeliveries[sub.id] = delivered + give;
      remaining -= give;

      const ref = this.subRefs.get(sub.id);
      if (ref?.phase === 'trial') {
        const cd = this.contractDeliveries[ref.originalId];
        if (cd && shelfLife < cd.trialMinShelfLife) {
          cd.trialMinShelfLife = shelfLife;
        }
      }
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
      let shelfLifeAtRelease: number;
      if (this.input.chain.origins.includes(lane.from)) {
        shelfLifeAtRelease = INITIAL_SHELF_LIFE;
      } else {
        shelfLifeAtRelease = this.popFromNodeQueue(lane.from, sc.quantity);
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
        shelfLifeAtRelease,
      });
    }
  }

  private enqueueAtNode(node: NodeId, qty: number, shelfLife: number): void {
    const queue = this.nodeFifoQueues[node];
    if (!queue) return;
    queue.push({ qty, shelfLife });
  }

  private popFromNodeQueue(node: NodeId, qty: number): number {
    const queue = this.nodeFifoQueues[node];
    if (!queue) return INITIAL_SHELF_LIFE;
    let remaining = qty;
    let minShelfLife = Number.POSITIVE_INFINITY;
    while (remaining > DELIVERY_EPSILON && queue.length > 0) {
      const head = queue[0]!;
      const take = Math.min(head.qty, remaining);
      head.qty -= take;
      remaining -= take;
      if (head.shelfLife < minShelfLife) minShelfLife = head.shelfLife;
      if (head.qty <= DELIVERY_EPSILON) queue.shift();
    }
    return minShelfLife === Number.POSITIVE_INFINITY
      ? 0
      : minShelfLife;
  }

  private evaluateTrialDeadlines(): boolean {
    let needsReplan = false;
    for (const c of this.originalContracts) {
      if (!c.trial) continue;
      const cd = this.contractDeliveries[c.id]!;
      if (cd.trialQualityPassed !== undefined) continue; // already evaluated
      if (this.currentHour <= c.trial.dueByHour) continue; // not yet
      const trialSubId = `${c.id}${TRIAL_SUFFIX}`;
      const delivered = this.subContractDeliveries[trialSubId] ?? 0;
      const fullyDelivered = delivered >= c.trial.quantity - DELIVERY_EPSILON;
      const qualityOK =
        cd.trialMinShelfLife >= c.trial.minShelfLifeAtDelivery;
      const passed = fullyDelivered && qualityOK;
      cd.trialQualityPassed = passed;
      this.eventLog.push({
        hour: this.currentHour,
        kind: 'trial-evaluated',
        detail: passed
          ? `Trial passed for ${c.id} (delivered=${delivered.toFixed(0)}, minShelfLife=${cd.trialMinShelfLife.toFixed(1)}h)`
          : `Trial FAILED for ${c.id} (delivered=${delivered.toFixed(0)} of ${c.trial.quantity}, minShelfLife=${cd.trialMinShelfLife === Infinity ? 'n/a' : cd.trialMinShelfLife.toFixed(1) + 'h'}; threshold=${c.trial.minShelfLifeAtDelivery}h)`,
        contractId: c.id,
      });
      if (!passed) {
        // Void the main sub-contract: zero its quantity for future replans.
        const mainSub = this.expandedContracts.find(
          (s) => s.id === `${c.id}::main`,
        );
        if (mainSub) mainSub.quantity = 0;
        needsReplan = true;
      }
    }
    return needsReplan;
  }

  private refreshAllStatuses(): void {
    for (const c of this.originalContracts) {
      const cd = this.contractDeliveries[c.id]!;
      // Aggregate sub-contract delivered counts for display.
      if (c.trial) {
        cd.trialDelivered = this.subContractDeliveries[`${c.id}::trial`] ?? 0;
        cd.mainDelivered = this.subContractDeliveries[`${c.id}::main`] ?? 0;
      } else {
        cd.trialDelivered = 0;
        cd.mainDelivered = this.subContractDeliveries[c.id] ?? 0;
      }
      cd.delivered = cd.trialDelivered + cd.mainDelivered;
      cd.status = deriveStatus(c, this.currentHour, cd, this.plan);
    }
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
        // No direct LP effect — quality already tracked per-shipment in slice 5.
        break;
      case 'opportunity-arrival':
        // Routed separately in step(); never reaches applyEvent.
        break;
    }
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
        push({
          effectKind: 'capacity-factor',
          capacityFactor: 1,
        });
        break;
    }
  }
}

const INITIAL_SHELF_LIFE = 96;

function deriveStatus(
  c: Contract,
  currentHour: number,
  cd: ContractDeliveryStatus,
  plan: Plan,
): ContractStatus {
  if (cd.status === 'declined') return 'declined';
  if (!c.trial) {
    if (cd.delivered >= c.quantity - DELIVERY_EPSILON) return 'delivered';
    if (currentHour > c.dueByHour) return 'breached';
    const plannedBreach = plan.breachByContract[c.id] ?? 0;
    if (plannedBreach > DELIVERY_EPSILON) return 'pending';
    return 'on-track';
  }
  // Trial-bearing contract.
  if (cd.trialQualityPassed === false) return 'voided';
  if (
    currentHour > c.trial.dueByHour &&
    cd.trialDelivered < c.trial.quantity - DELIVERY_EPSILON &&
    cd.trialQualityPassed === undefined
  ) {
    // Trial deadline passed without sufficient delivery and not yet evaluated.
    // The evaluator will mark voided on the next refresh.
    return 'voided';
  }
  if (cd.delivered >= c.quantity - DELIVERY_EPSILON) return 'delivered';
  if (currentHour > c.dueByHour) return 'breached';
  if (cd.trialQualityPassed === true) return 'main-active';
  return 'trial-pending';
}

export type { Mode };
