import { useRef, useState } from 'react';
import { getSectorDefinition } from './domain/sector-defs.ts';
import type { Sector } from './domain/types.ts';
import { Simulator, type SimulationState } from './sim/simulator.ts';

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
          {Object.values(simState.contractDeliveries).map((c) => (
            <p key={c.contractId}>
              <strong>Contract {c.contractId}:</strong>{' '}
              {c.delivered.toFixed(0)} delivered ({c.status})
            </p>
          ))}
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
        Seed (unused in slice 1): <code>{seed}</code>
      </footer>
    </main>
  );
}
