import {
  createStore,
  del,
  get,
  keys as idbKeys,
  set,
  type UseStore,
} from 'idb-keyval';
import type { SimulationState } from '../sim/simulator.ts';
import type { Sector } from '../domain/types.ts';

export const SCHEMA_VERSION = 1;
const STORE_NAME = 'sco-runs';

let store: UseStore | undefined;
function getStore(): UseStore {
  if (!store) {
    store = createStore('supply-chain-optimizer', STORE_NAME);
  }
  return store;
}

export interface PersistedRun {
  schemaVersion: number;
  id: string;
  sector: Sector;
  seed: string;
  hazardFingerprint: string;
  savedAt: string; // ISO timestamp
  state: SimulationState;
}

export interface RunSummary {
  id: string;
  sector: Sector;
  seed: string;
  savedAt: string;
  totalCost: number | undefined;
  contractsCount: number;
}

export function buildRunId(
  sector: Sector,
  seed: string,
  hazardFingerprint: string,
): string {
  return `${sector}::${seed}::${hazardFingerprint}`;
}

export function buildHazardFingerprint(
  hazardIds: ReadonlyArray<string>,
): string {
  if (hazardIds.length === 0) return 'no-hazards';
  return hazardIds.slice().sort().join(',');
}

export async function saveRun(run: PersistedRun): Promise<void> {
  await set(run.id, run, getStore());
}

export async function loadRun(id: string): Promise<PersistedRun | undefined> {
  return get<PersistedRun>(id, getStore());
}

export async function listRuns(): Promise<RunSummary[]> {
  const ks = (await idbKeys(getStore())) as string[];
  const out: RunSummary[] = [];
  for (const k of ks) {
    const r = await get<PersistedRun>(k, getStore());
    if (!r) continue;
    out.push({
      id: r.id,
      sector: r.sector,
      seed: r.seed,
      savedAt: r.savedAt,
      totalCost: r.state.totalCost,
      contractsCount: Object.keys(r.state.contractDeliveries).length,
    });
  }
  out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return out;
}

export async function deleteRun(id: string): Promise<void> {
  await del(id, getStore());
}

export function exportRunJSON(run: PersistedRun): Blob {
  return new Blob([JSON.stringify(run, replacer, 2)], {
    type: 'application/json',
  });
}

/** Parse and validate a run JSON; does NOT persist (call saveRun separately). */
export async function importRunJSON(file: File | Blob): Promise<PersistedRun> {
  const text = await file.text();
  const obj = JSON.parse(text, reviver) as PersistedRun;
  if (obj.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported run schema version: got ${obj.schemaVersion}, expected ${SCHEMA_VERSION}`,
    );
  }
  return obj;
}

export async function importAndSaveRunJSON(
  file: File | Blob,
): Promise<PersistedRun> {
  const run = await importRunJSON(file);
  await saveRun(run);
  return run;
}

// JSON helpers — handle Maps and Sets if any leak in, plus Infinity etc.
function replacer(_key: string, value: unknown): unknown {
  if (value === Number.POSITIVE_INFINITY) return '__Infinity__';
  if (value === Number.NEGATIVE_INFINITY) return '__-Infinity__';
  if (Number.isNaN(value as number)) return '__NaN__';
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value === '__Infinity__') return Number.POSITIVE_INFINITY;
  if (value === '__-Infinity__') return Number.NEGATIVE_INFINITY;
  if (value === '__NaN__') return Number.NaN;
  return value;
}
