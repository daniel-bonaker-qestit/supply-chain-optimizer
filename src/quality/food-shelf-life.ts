import type { Mode } from '../domain/types.ts';

const MODE_TRANSIT_MULTIPLIER: Record<Mode, number> = {
  slow: 1.5,
  fast: 1.0,
};

/**
 * Shelf-life remaining at the end of an in-transit period.
 *
 * Shelf-life starts at `initialShelfLife` when the shipment is released and
 * decreases by `(elapsed × mode multiplier)` while in transit.
 *
 * For slice 5 we ignore dwell at intermediate nodes — shipments pass through
 * non-origin handover nodes instantaneously in the live sim (the LP's flow
 * conservation ensures arrivals depart on the next outbound shipment, so any
 * dwell-induced loss is already captured by the next leg's transit time).
 */
export function shelfLifeAfterTransit(
  initial: number,
  mode: Mode,
  hoursElapsed: number,
): number {
  return Math.max(0, initial - hoursElapsed * MODE_TRANSIT_MULTIPLIER[mode]);
}

/** Hours of shelf-life consumed by a single (lane, mode) leg. */
export function shelfLifeCostOfLeg(
  mode: Mode,
  transitHours: number,
): number {
  return transitHours * MODE_TRANSIT_MULTIPLIER[mode];
}
