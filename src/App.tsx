import { useRef, useState, type CSSProperties } from 'react';
import { getSectorDefinition } from './domain/sector-defs.ts';
import type { Contract, Sector } from './domain/types.ts';
import {
  Simulator,
  type ContractStatus,
  type SimulationState,
} from './sim/simulator.ts';

type AppStatus = 'idle' | 'running' | 'complete' | 'error';

const DEFAULT_SEED = 'demo-1';
const HOUR_INTERVAL_MS = 25;

export function App() {
  const [sector, setSector] = useState<Sector>('food');
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [status, setStatus] = useState<AppStatus>('idle');
  const [simState, setSimState] = useState<SimulationState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const simRef = useRef<Simulator | null>(null);
  const runIdRef = useRef(0);

  async function start() {
    const myRunId = ++runIdRef.current;
    setError(null);
    setStatus('running');
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
        return;
      }
      try {
        await sim.step(state.currentHour);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
        return;
      }
      if (runId !== runIdRef.current) return;
      setSimState(sim.currentState());
      await sleep(HOUR_INTERVAL_MS);
    }
  }

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
    </main>
  );
}

const STATUS_COLORS: Record<ContractStatus, string> = {
  'on-track': '#1f6feb',
  pending: '#9a6700',
  delivered: '#1a7f37',
  breached: '#cf222e',
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
    return { contract: c, status: cd, breach: breachQty };
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

function kindColor(kind: SimulationState['eventLog'][number]['kind']): string {
  switch (kind) {
    case 'event-fired':
      return '#cf222e';
    case 'replan':
      return '#1f6feb';
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
