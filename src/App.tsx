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
      });
      if (myRunId !== runIdRef.current) return;
      simRef.current = sim;
      setSimState(sim.currentState());
      scheduleTick(myRunId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }

  function scheduleTick(runId: number) {
    setTimeout(() => {
      if (runId !== runIdRef.current) return;
      const sim = simRef.current;
      if (!sim) return;
      const state = sim.currentState();
      if (state.status === 'complete') {
        setSimState(state);
        setStatus('complete');
        return;
      }
      sim.step(state.currentHour);
      setSimState(sim.currentState());
      scheduleTick(runId);
    }, HOUR_INTERVAL_MS);
  }

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '1.5rem' }}>
      <h1>Supply Chain Optimizer</h1>
      <p>Slice 1 — tracer bullet (food sector, single committed contract).</p>

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
        <section style={{ marginTop: '1.5rem' }}>
          <p>
            <strong>Hour:</strong> {simState.currentHour} /{' '}
            {simState.horizonHours}
          </p>
          <p>
            <strong>Plan:</strong> {simState.plan.shipments.length} shipments
            scheduled, {simState.plan.deliveries.length} deliveries
          </p>
          <p>
            <strong>In flight:</strong> {simState.inFlight.length}
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
              <strong>Run complete — total cost: $
              {simState.totalCost?.toFixed(2)}</strong>
            </p>
          )}
        </section>
      )}

      <footer style={{ marginTop: '2rem', fontSize: '0.85em', color: '#666' }}>
        Seed (unused until events / opportunities land): <code>{seed}</code>
      </footer>
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
          maxWidth: 640,
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

const cellHead: CSSProperties = {
  textAlign: 'left',
  padding: '0.3rem 0.5rem',
  borderBottom: '2px solid #ddd',
};
const cell: CSSProperties = {
  padding: '0.3rem 0.5rem',
  borderBottom: '1px solid #eee',
};
