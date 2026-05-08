import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { getSectorDefinition } from './domain/sector-defs.ts';
import type { Contract, Sector } from './domain/types.ts';
import { pickHazard } from './hazards/hazard-generator.ts';
import type { Hazard } from './hazards/types.ts';
import {
  buildHazardFingerprint,
  buildRunId,
  deleteRun,
  exportRunJSON,
  importAndSaveRunJSON,
  listRuns,
  loadRun,
  saveRun,
  SCHEMA_VERSION,
  type PersistedRun,
  type RunSummary,
} from './persistence/run-archive.ts';
import { exportRunHTML } from './report/report-generator.ts';
import { bufferTime } from './risk/risk-computer.ts';
import {
  Simulator,
  type ContractStatus,
  type SimulationState,
} from './sim/simulator.ts';

type AppStatus = 'idle' | 'running' | 'paused' | 'complete' | 'error' | 'replay';

const DEFAULT_SEED = 'demo-1';

const SPEED_OPTIONS = [
  { label: 'Max speed', value: 0 },
  { label: '0.05 s / hour', value: 50 },
  { label: '0.1 s / hour', value: 100 },
  { label: '0.5 s / hour', value: 500 },
  { label: '2 s / hour', value: 2000 },
];

export function App() {
  const [sector, setSector] = useState<Sector>('food');
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [status, setStatus] = useState<AppStatus>('idle');
  const [simState, setSimState] = useState<SimulationState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hourIntervalMs, setHourIntervalMs] = useState<number>(25);
  const [paused, setPaused] = useState<boolean>(false);
  const [savedRuns, setSavedRuns] = useState<RunSummary[]>([]);
  const simRef = useRef<Simulator | null>(null);
  const runIdRef = useRef(0);
  const pausedRef = useRef<boolean>(false);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    void refreshSavedRuns();
  }, []);

  async function refreshSavedRuns() {
    try {
      const list = await listRuns();
      setSavedRuns(list);
    } catch (e) {
      // IndexedDB may be unavailable in some environments — don't surface as error.
      console.warn('listRuns failed:', e);
    }
  }

  async function start() {
    const myRunId = ++runIdRef.current;
    setError(null);
    setStatus('running');
    setPaused(false);
    setSimState(null);
    simRef.current = null;

    try {
      const def = getSectorDefinition(sector);
      const sim = await Simulator.start({
        chain: def.chain,
        contracts: def.contracts,
        horizonHours: def.horizonHours,
        seed,
      });
      if (myRunId !== runIdRef.current) return;
      simRef.current = sim;
      setSimState(sim.currentState());
      void runLoop(myRunId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }

  async function runLoop(runId: number) {
    while (runId === runIdRef.current) {
      const sim = simRef.current;
      if (!sim) return;
      const state = sim.currentState();
      if (state.status === 'complete') {
        setStatus('complete');
        setSimState(state);
        // Auto-save on completion.
        try {
          const hazardIds = state.injectedHazards.map((h) => h.id);
          const fp = buildHazardFingerprint(hazardIds);
          const id = buildRunId(sector, seed, fp);
          const persisted: PersistedRun = {
            schemaVersion: SCHEMA_VERSION,
            id,
            sector,
            seed,
            hazardFingerprint: fp,
            savedAt: new Date().toISOString(),
            state,
          };
          await saveRun(persisted);
          await refreshSavedRuns();
        } catch (e) {
          console.warn('auto-save failed:', e);
        }
        return;
      }
      while (pausedRef.current && runId === runIdRef.current) {
        await sleep(50);
      }
      if (runId !== runIdRef.current) return;
      try {
        await sim.step(state.currentHour);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
        return;
      }
      if (runId !== runIdRef.current) return;
      setSimState(sim.currentState());
      if (hourIntervalMs > 0) await sleep(hourIntervalMs);
    }
  }

  async function loadAndReplay(id: string) {
    runIdRef.current++; // cancel any current run
    simRef.current = null;
    const run = await loadRun(id);
    if (!run) {
      setError(`Run ${id} not found`);
      return;
    }
    setSimState(run.state);
    setSector(run.sector);
    setSeed(run.seed);
    setStatus('replay');
    setPaused(false);
  }

  async function handleDelete(id: string) {
    await deleteRun(id);
    await refreshSavedRuns();
  }

  async function handleImport(file: File) {
    try {
      await importAndSaveRunJSON(file);
      await refreshSavedRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function handleExport(summary: RunSummary) {
    void (async () => {
      const run = await loadRun(summary.id);
      if (!run) return;
      const blob = exportRunJSON(run);
      downloadBlob(blob, `${summary.id.replace(/::/g, '_')}.json`);
    })();
  }

  function handleExportHTML(summary: RunSummary) {
    void (async () => {
      const run = await loadRun(summary.id);
      if (!run) return;
      const blob = exportRunHTML(run);
      downloadBlob(blob, `${summary.id.replace(/::/g, '_')}.html`);
    })();
  }

  // Hash-route: #/run/<id> loads a saved run for replay.
  useEffect(() => {
    const tryHashRoute = () => {
      const hash = window.location.hash;
      const m = hash.match(/^#\/run\/(.+)$/);
      if (m) void loadAndReplay(decodeURIComponent(m[1]!));
    };
    tryHashRoute();
    window.addEventListener('hashchange', tryHashRoute);
    return () => window.removeEventListener('hashchange', tryHashRoute);
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '1.5rem' }}>
      <h1>Supply Chain Optimizer</h1>
      <p>
        Slice 3 — random events on a deterministic seeded timeline. The
        optimizer replans on every event.
      </p>

      <fieldset
        style={{
          display: 'grid',
          gap: '0.75rem',
          maxWidth: 360,
          padding: '1rem',
        }}
      >
        <label>
          Sector{' '}
          <select
            value={sector}
            onChange={(e) => setSector(e.target.value as Sector)}
            disabled={status === 'running'}
          >
            <option value="food">Food</option>
            <option value="pharma">Pharma cold-chain</option>
            <option value="electronics">Electronics</option>
          </select>
        </label>

        <label>
          Seed{' '}
          <input
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            disabled={status === 'running'}
          />
        </label>

        <button
          type="button"
          onClick={() => {
            void start();
          }}
          disabled={status === 'running'}
        >
          {status === 'running' ? 'Running…' : 'Start'}
        </button>
      </fieldset>

      {(status === 'running' || status === 'paused') && (
        <fieldset
          style={{
            display: 'flex',
            gap: '0.75rem',
            alignItems: 'center',
            marginTop: '0.75rem',
            padding: '0.5rem 1rem',
          }}
        >
          <label>
            Speed{' '}
            <select
              value={hourIntervalMs}
              onChange={(e) => setHourIntervalMs(Number(e.target.value))}
            >
              {SPEED_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => {
              setPaused((p) => !p);
              setStatus(paused ? 'running' : 'paused');
            }}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
        </fieldset>
      )}

      {status === 'replay' && (
        <p
          style={{
            marginTop: '0.75rem',
            padding: '0.5rem 0.75rem',
            background: '#fff8e1',
            border: '1px solid #f59f00',
            borderRadius: 4,
            color: '#9a6700',
          }}
        >
          <strong>Replay mode:</strong> viewing a saved run (read-only).
        </p>
      )}

      {simState && simState.status === 'running' && (
        <button
          type="button"
          onClick={() => {
            void injectRandomHazard(simRef.current, sector, simState);
          }}
          style={{
            marginTop: '1rem',
            padding: '0.6rem 1rem',
            background: '#cf222e',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Inject Random Hazard
        </button>
      )}

      {simState && simState.injectedHazards.length > 0 && (
        <ActiveHazardBanner simState={simState} />
      )}

      {error && (
        <pre style={{ color: 'crimson', marginTop: '1rem' }}>Error: {error}</pre>
      )}

      {simState && (
        <section
          style={{
            display: 'grid',
            gap: '1.5rem',
            gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
            marginTop: '1.5rem',
            alignItems: 'start',
          }}
        >
          <div>
            <p>
              <strong>Hour:</strong> {simState.currentHour} /{' '}
              {simState.horizonHours}
            </p>
            <p>
              <strong>Plan:</strong> {simState.plan.shipments.length} shipments,{' '}
              {simState.plan.deliveries.length} deliveries
            </p>
            <p>
              <strong>In flight:</strong> {simState.inFlight.length} ·{' '}
              <strong>Active disruptions:</strong>{' '}
              {simState.activeDisruptions.length} ·{' '}
              <strong>Events scheduled:</strong>{' '}
              {simState.scheduledEvents.length}
            </p>
            <NetworkGraph sector={sector} simState={simState} />
            <CostChart simState={simState} />
            <ContractListPanel
              simState={simState}
              contractsById={Object.fromEntries(
                getSectorDefinition(sector).contracts.map((c) => [c.id, c]),
              )}
            />
            {simState.status === 'complete' && (
              <p
                data-testid="run-complete"
                style={{
                  marginTop: '1rem',
                  padding: '0.75rem',
                  background: '#e8f5e9',
                  borderRadius: 4,
                }}
              >
                <strong>
                  Run complete — total cost: $
                  {simState.totalCost?.toFixed(2)}
                </strong>
              </p>
            )}
          </div>
          <EventLogPanel simState={simState} />
        </section>
      )}

      <SavedRunsPanel
        runs={savedRuns}
        onLoad={(id) => void loadAndReplay(id)}
        onDelete={(id) => void handleDelete(id)}
        onExport={handleExport}
        onExportHTML={handleExportHTML}
        onImport={handleImport}
      />

      <footer style={{ marginTop: '2rem', fontSize: '0.85em', color: '#666' }}>
        Seed: <code>{seed}</code> · {savedRuns.length} run
        {savedRuns.length === 1 ? '' : 's'} stored locally
      </footer>
    </main>
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function SavedRunsPanel({
  runs,
  onLoad,
  onDelete,
  onExport,
  onExportHTML,
  onImport,
}: {
  runs: RunSummary[];
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: (summary: RunSummary) => void;
  onExportHTML: (summary: RunSummary) => void;
  onImport: (file: File) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  return (
    <section style={{ marginTop: '2rem' }}>
      <h3 style={{ margin: '0 0 0.5rem 0' }}>Saved runs</h3>
      <div style={{ marginBottom: '0.5rem' }}>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImport(f);
            e.target.value = '';
          }}
        />
        <button type="button" onClick={() => fileRef.current?.click()}>
          Import JSON
        </button>
      </div>
      {runs.length === 0 ? (
        <p style={{ color: '#666' }}>(no saved runs yet)</p>
      ) : (
        <table
          style={{
            borderCollapse: 'collapse',
            fontSize: '0.85em',
            width: '100%',
            maxWidth: 760,
          }}
        >
          <thead>
            <tr>
              <th style={cellHead}>Saved</th>
              <th style={cellHead}>Sector</th>
              <th style={cellHead}>Seed</th>
              <th style={cellHead}>Cost</th>
              <th style={cellHead}>Contracts</th>
              <th style={cellHead}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td style={cell}>{r.savedAt.slice(0, 19).replace('T', ' ')}</td>
                <td style={cell}>{r.sector}</td>
                <td style={cell}>{r.seed}</td>
                <td style={cell}>
                  {r.totalCost === undefined
                    ? '—'
                    : `$${r.totalCost.toFixed(0)}`}
                </td>
                <td style={cell}>{r.contractsCount}</td>
                <td style={cell}>
                  <button type="button" onClick={() => onLoad(r.id)}>
                    Load
                  </button>{' '}
                  <button type="button" onClick={() => onExport(r)}>
                    JSON
                  </button>{' '}
                  <button type="button" onClick={() => onExportHTML(r)}>
                    HTML
                  </button>{' '}
                  <button
                    type="button"
                    onClick={() =>
                      navigator.clipboard
                        ?.writeText(
                          `${window.location.origin}${window.location.pathname}#/run/${encodeURIComponent(r.id)}`,
                        )
                        .catch(() => undefined)
                    }
                    title="Copy deep link to clipboard"
                  >
                    Link
                  </button>{' '}
                  <button
                    type="button"
                    onClick={() => onDelete(r.id)}
                    style={{ color: '#cf222e' }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const STATUS_COLORS: Record<ContractStatus, string> = {
  'on-track': '#1f6feb',
  pending: '#9a6700',
  delivered: '#1a7f37',
  breached: '#cf222e',
  'trial-pending': '#8250df',
  'main-active': '#0969da',
  voided: '#6e7781',
  declined: '#57606a',
};

function ContractListPanel({
  simState,
  contractsById,
}: {
  simState: SimulationState;
  contractsById: Record<string, Contract>;
}) {
  const rows = Object.values(simState.contractDeliveries).map((cd) => {
    const c = contractsById[cd.contractId];
    if (!c) return null;
    const breachQty = simState.plan.breachByContract[cd.contractId] ?? 0;
    const buffer = bufferTime(simState.plan, c);
    return { contract: c, status: cd, breach: breachQty, buffer };
  });

  return (
    <div style={{ marginTop: '1rem' }}>
      <h3 style={{ margin: '0 0 0.5rem 0' }}>Contracts</h3>
      <table
        style={{
          borderCollapse: 'collapse',
          fontSize: '0.9em',
          width: '100%',
        }}
      >
        <thead>
          <tr>
            <th style={cellHead}>ID</th>
            <th style={cellHead}>Endpoint</th>
            <th style={cellHead}>Qty</th>
            <th style={cellHead}>Due</th>
            <th style={cellHead}>Buffer</th>
            <th style={cellHead}>Delivered</th>
            <th style={cellHead}>Planned breach</th>
            <th style={cellHead}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) =>
            r === null ? null : (
              <tr key={r.contract.id}>
                <td style={cell}>{r.contract.id}</td>
                <td style={cell}>{r.contract.endpoint}</td>
                <td style={cell}>{r.contract.quantity}</td>
                <td style={cell}>h{r.contract.dueByHour}</td>
                <td
                  style={{
                    ...cell,
                    color:
                      r.buffer === Number.POSITIVE_INFINITY
                        ? '#888'
                        : r.buffer < 0
                          ? '#cf222e'
                          : r.buffer < 6
                            ? '#9a6700'
                            : '#1a7f37',
                    fontWeight: 600,
                  }}
                >
                  {r.buffer === Number.POSITIVE_INFINITY
                    ? '—'
                    : `${r.buffer >= 0 ? '+' : ''}${r.buffer.toFixed(0)}h`}
                </td>
                <td style={cell}>{r.status.delivered.toFixed(0)}</td>
                <td style={cell}>
                  {r.breach > 1e-6 ? r.breach.toFixed(0) : '—'}
                </td>
                <td
                  style={{
                    ...cell,
                    color: STATUS_COLORS[r.status.status],
                    fontWeight: 600,
                  }}
                >
                  {r.status.status}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

function CostChart({ simState }: { simState: SimulationState }) {
  const samples = simState.costHistory;
  if (samples.length < 2) return null;

  const W = 480;
  const H = 120;
  const pad = 24;

  const totals = samples.map((s: { transport: number; holding: number }) =>
    s.transport + s.holding,
  );
  const transports = samples.map(
    (s: { transport: number }) => s.transport,
  );
  const holdings = samples.map((s: { holding: number }) => s.holding);

  const xMax = simState.horizonHours;
  const yMax = Math.max(1, ...totals);

  const xFor = (h: number) => pad + ((W - pad * 2) * h) / xMax;
  const yFor = (v: number) => H - pad - ((H - pad * 2) * v) / yMax;

  const buildPath = (vals: number[]) =>
    samples
      .map(
        (s: { hour: number }, i: number) =>
          `${i === 0 ? 'M' : 'L'} ${xFor(s.hour)} ${yFor(vals[i]!)}`,
      )
      .join(' ');

  return (
    <div style={{ marginTop: '1rem' }}>
      <h3 style={{ margin: '0 0 0.5rem 0' }}>Realized cost over time</h3>
      <svg
        width={W}
        height={H}
        style={{ background: '#fafafa', border: '1px solid #ddd' }}
      >
        <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="#999" />
        <line x1={pad} y1={pad} x2={pad} y2={H - pad} stroke="#999" />
        <path
          d={buildPath(transports)}
          stroke="#1f6feb"
          strokeWidth={2}
          fill="none"
        />
        <path
          d={buildPath(holdings)}
          stroke="#9a6700"
          strokeWidth={2}
          fill="none"
        />
        <path
          d={buildPath(totals)}
          stroke="#1a7f37"
          strokeWidth={2}
          fill="none"
        />
        <text x={pad} y={pad - 6} fontSize="11" fill="#444">
          ${yMax.toFixed(0)}
        </text>
        <text x={W - pad - 50} y={H - pad + 14} fontSize="11" fill="#444">
          h{xMax}
        </text>
      </svg>
      <div style={{ fontSize: '0.8em', marginTop: 4 }}>
        <span style={{ color: '#1f6feb' }}>● transport</span>{' '}
        <span style={{ color: '#9a6700', marginLeft: 12 }}>● holding</span>{' '}
        <span style={{ color: '#1a7f37', marginLeft: 12 }}>● total</span>
      </div>
    </div>
  );
}

function NetworkGraph({
  sector,
  simState,
}: {
  sector: Sector;
  simState: SimulationState;
}) {
  const def = getSectorDefinition(sector);
  const W = 520;
  const H = 200;
  const pad = 30;
  const layers = new Map<number, typeof def.chain.nodes>();
  for (const n of def.chain.nodes) {
    if (!layers.has(n.layer)) layers.set(n.layer, []);
    layers.get(n.layer)!.push(n);
  }
  const maxLayer = Math.max(...def.chain.nodes.map((n) => n.layer));
  const xFor = (l: number) =>
    maxLayer === 0 ? W / 2 : pad + ((W - pad * 2) * l) / maxLayer;
  const yFor = (idx: number, count: number) =>
    pad + ((H - pad * 2) * (idx + 0.5)) / Math.max(count, 1);

  const positions = new Map<string, { x: number; y: number }>();
  for (const [layer, nodes] of layers) {
    nodes.forEach((n, i) =>
      positions.set(n.id, { x: xFor(layer), y: yFor(i, nodes.length) }),
    );
  }

  const disruptedNodes = new Set<string>();
  const disruptedLanes = new Set<string>();
  for (const d of simState.activeDisruptions) {
    if (simState.currentHour < d.fromHour || simState.currentHour >= d.toHour)
      continue;
    if (d.nodeId) disruptedNodes.add(d.nodeId);
    if (d.laneId) disruptedLanes.add(d.laneId);
  }

  return (
    <div style={{ marginTop: '1rem' }}>
      <h3 style={{ margin: '0 0 0.5rem 0' }}>Network</h3>
      <svg width={W} height={H} style={{ background: '#fafafa', border: '1px solid #ddd' }}>
        {def.chain.lanes.map((l) => {
          const a = positions.get(l.from);
          const b = positions.get(l.to);
          if (!a || !b) return null;
          const blocked = disruptedLanes.has(l.id);
          return (
            <line
              key={l.id}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={blocked ? '#cf222e' : '#888'}
              strokeWidth={blocked ? 2 : 1}
              strokeDasharray={blocked ? '4 2' : undefined}
            />
          );
        })}
        {def.chain.nodes.map((n) => {
          const p = positions.get(n.id)!;
          const isOrigin = def.chain.origins.includes(n.id);
          const isEndpoint = n.layer === maxLayer;
          const blocked = disruptedNodes.has(n.id);
          const fill = blocked
            ? '#cf222e'
            : isOrigin
              ? '#1a7f37'
              : isEndpoint
                ? '#1f6feb'
                : '#fff';
          return (
            <g key={n.id}>
              <circle
                cx={p.x}
                cy={p.y}
                r={6}
                fill={fill}
                stroke="#333"
                strokeWidth={1}
              />
              <text
                x={p.x}
                y={p.y - 10}
                fontSize="9"
                textAnchor="middle"
                fill="#333"
              >
                {n.id}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function EventLogPanel({ simState }: { simState: SimulationState }) {
  const entries = simState.eventLog.slice().reverse();
  return (
    <div>
      <h3 style={{ margin: '0 0 0.5rem 0' }}>Event log</h3>
      <ul
        style={{
          listStyle: 'none',
          padding: 0,
          margin: 0,
          maxHeight: '480px',
          overflowY: 'auto',
          border: '1px solid #ddd',
          borderRadius: 4,
          background: '#fafafa',
        }}
      >
        {entries.length === 0 ? (
          <li style={{ padding: '0.5rem 0.75rem', color: '#666' }}>
            (no events yet)
          </li>
        ) : (
          entries.map((e, i) => (
            <li
              key={`${e.hour}-${i}`}
              style={{
                padding: '0.4rem 0.75rem',
                borderBottom: '1px solid #eee',
                fontSize: '0.85em',
              }}
            >
              <span
                style={{
                  display: 'inline-block',
                  width: '4ch',
                  color: '#666',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                h{e.hour}
              </span>
              <span
                style={{
                  display: 'inline-block',
                  marginLeft: '0.5rem',
                  fontWeight: 600,
                  color: kindColor(e.kind),
                }}
              >
                {e.kind}
              </span>
              <span style={{ marginLeft: '0.5rem' }}>{e.detail}</span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

async function injectRandomHazard(
  sim: Simulator | null,
  sector: Sector,
  simState: SimulationState,
): Promise<void> {
  if (!sim) return;
  try {
    const def = getSectorDefinition(sector);
    const hazard = pickHazard({
      sector,
      chain: def.chain,
      currentHour: simState.currentHour,
      horizonHours: simState.horizonHours,
    });
    await sim.injectHazard(hazard);
  } catch (e) {
    console.error('hazard injection failed:', e);
  }
}

function ActiveHazardBanner({ simState }: { simState: SimulationState }) {
  const active = simState.injectedHazards.filter((h: Hazard) => {
    const end = h.persistThroughHorizon
      ? simState.horizonHours
      : h.injectedAtHour + h.durationHours;
    return simState.currentHour < end;
  });
  if (active.length === 0) return null;
  return (
    <div
      style={{
        marginTop: '1rem',
        padding: '0.75rem',
        background: '#fff5f5',
        border: '1px solid #cf222e',
        borderLeft: '6px solid #cf222e',
        borderRadius: 4,
      }}
    >
      <strong style={{ color: '#a40e26' }}>Active hazards:</strong>
      <ul style={{ margin: '0.4rem 0 0 1.25rem', padding: 0 }}>
        {active.map((h) => (
          <li key={h.id} style={{ marginBottom: '0.2rem' }}>
            <strong>{h.type}</strong>: {h.description}
          </li>
        ))}
      </ul>
      {simState.replanSuppressedUntilHour !== undefined &&
        simState.currentHour < simState.replanSuppressedUntilHour && (
          <p style={{ marginTop: '0.4rem', color: '#9a6700' }}>
            Visibility blackout active — replans suppressed until h
            {simState.replanSuppressedUntilHour}.
          </p>
        )}
    </div>
  );
}

function kindColor(kind: SimulationState['eventLog'][number]['kind']): string {
  switch (kind) {
    case 'event-fired':
      return '#cf222e';
    case 'replan':
      return '#1f6feb';
    case 'replan-suppressed':
      return '#9a6700';
    case 'hazard-injected':
      return '#a40e26';
    case 'trial-evaluated':
      return '#8250df';
    case 'opportunity-arrived':
      return '#0969da';
    case 'opportunity-accepted':
      return '#1a7f37';
    case 'opportunity-declined':
      return '#57606a';
    case 'sim-start':
    case 'sim-complete':
      return '#1a7f37';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const cellHead: CSSProperties = {
  textAlign: 'left',
  padding: '0.3rem 0.5rem',
  borderBottom: '2px solid #ddd',
};
const cell: CSSProperties = {
  padding: '0.3rem 0.5rem',
  borderBottom: '1px solid #eee',
};
