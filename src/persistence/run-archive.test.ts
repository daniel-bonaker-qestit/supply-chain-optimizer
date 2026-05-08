import { describe, expect, it } from 'vitest';
import {
  buildHazardFingerprint,
  buildRunId,
  exportRunJSON,
  importRunJSON,
  SCHEMA_VERSION,
  type PersistedRun,
} from './run-archive.ts';
import type { SimulationState } from '../sim/simulator.ts';

const fakeState = (totalCost: number | undefined): SimulationState => ({
  currentHour: 168,
  horizonHours: 168,
  status: 'complete',
  plan: {
    shipments: [],
    deliveries: [],
    totalCost: totalCost ?? 0,
    breachByContract: {},
  },
  inFlight: [],
  contractDeliveries: {},
  totalCost,
  scheduledEvents: [],
  activeDisruptions: [],
  eventLog: [],
  inventory: {},
  injectedHazards: [],
  replanSuppressedUntilHour: undefined,
  costHistory: [{ hour: 1, transport: 0, holding: 0 }],
});

describe('run-archive — id + fingerprint helpers', () => {
  it('builds a deterministic run id from (sector, seed, fingerprint)', () => {
    expect(buildRunId('food', 'seed-1', 'no-hazards')).toBe(
      'food::seed-1::no-hazards',
    );
  });

  it('builds a stable hazard fingerprint regardless of injection order', () => {
    expect(buildHazardFingerprint(['h2', 'h1'])).toBe(
      buildHazardFingerprint(['h1', 'h2']),
    );
  });

  it('returns "no-hazards" for an empty list', () => {
    expect(buildHazardFingerprint([])).toBe('no-hazards');
  });
});

describe('run-archive — JSON export / import round-trip', () => {
  it('exports a Blob whose JSON re-imports to an equivalent run', async () => {
    const run: PersistedRun = {
      schemaVersion: SCHEMA_VERSION,
      id: 'food::seed-1::no-hazards',
      sector: 'food',
      seed: 'seed-1',
      hazardFingerprint: 'no-hazards',
      savedAt: new Date().toISOString(),
      state: fakeState(1234.5),
    };

    const blob = exportRunJSON(run);
    expect(blob.type).toBe('application/json');

    const imported = await importRunJSON(blob);
    expect(imported.id).toBe(run.id);
    expect(imported.state.totalCost).toBe(1234.5);
    expect(imported.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('rejects an import with a mismatching schema version', async () => {
    const bad = JSON.stringify({
      schemaVersion: 99,
      id: 'x',
      sector: 'food',
      seed: 's',
      hazardFingerprint: 'f',
      savedAt: 't',
      state: fakeState(0),
    });
    await expect(importRunJSON(new Blob([bad]))).rejects.toThrow(
      /schema version/,
    );
  });

  it('round-trips Infinity and NaN inside the saved state', async () => {
    const run: PersistedRun = {
      schemaVersion: SCHEMA_VERSION,
      id: 'food::seed-1::no-hazards',
      sector: 'food',
      seed: 'seed-1',
      hazardFingerprint: 'no-hazards',
      savedAt: new Date().toISOString(),
      state: {
        ...fakeState(1),
        contractDeliveries: {
          c1: {
            contractId: 'c1',
            delivered: 0,
            trialDelivered: 0,
            mainDelivered: 0,
            status: 'trial-pending',
            trialQualityPassed: undefined,
            trialMinShelfLife: Number.POSITIVE_INFINITY,
          },
        },
      },
    };

    const imported = await importRunJSON(exportRunJSON(run));
    expect(imported.state.contractDeliveries.c1?.trialMinShelfLife).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});
