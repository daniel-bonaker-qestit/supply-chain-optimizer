import type { PersistedRun } from '../persistence/run-archive.ts';
import type { SimulationState } from '../sim/simulator.ts';

/**
 * Build a self-contained HTML report for a saved run.
 *
 * The output is a single .html document with no external resources — opening
 * it from `file://` performs zero network requests. All visualization is
 * inline SVG and inline CSS.
 */
export function exportRunHTML(run: PersistedRun): Blob {
  const html = renderRunHTML(run);
  return new Blob([html], { type: 'text/html' });
}

export function renderRunHTML(run: PersistedRun): string {
  const { state, sector, seed, savedAt, hazardFingerprint } = run;

  const costChart = renderCostChartSVG(state);
  const contractTable = renderContractTable(state);
  const eventLog = renderEventLog(state);
  const summary = renderRunSummary(run);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Supply Chain Optimizer — Run ${escapeHtml(run.id)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<header>
<h1>Supply Chain Optimizer — Run report</h1>
<p class="meta">
  <strong>ID:</strong> <code>${escapeHtml(run.id)}</code><br/>
  <strong>Sector:</strong> ${escapeHtml(sector)} · <strong>Seed:</strong> <code>${escapeHtml(seed)}</code> · <strong>Hazard fingerprint:</strong> <code>${escapeHtml(hazardFingerprint)}</code><br/>
  <strong>Saved at:</strong> ${escapeHtml(savedAt)}
</p>
</header>

<section>
<h2>Summary</h2>
${summary}
</section>

<section>
<h2>Realized cost over time</h2>
${costChart}
</section>

<section>
<h2>Contracts</h2>
${contractTable}
</section>

<section>
<h2>Event log</h2>
${eventLog}
</section>

<footer>
<p>Generated from a saved run by Supply Chain Optimizer. No external resources required.</p>
</footer>
</body>
</html>`;
}

const REPORT_CSS = `
body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; color: #1f2328; }
header h1 { margin-bottom: 0.25rem; }
.meta { color: #57606a; font-size: 0.95em; }
section { margin-top: 2rem; }
h2 { border-bottom: 1px solid #d0d7de; padding-bottom: 0.25rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
th, td { padding: 0.35rem 0.5rem; border-bottom: 1px solid #eaeef2; text-align: left; }
thead th { border-bottom: 2px solid #d0d7de; }
.badge-delivered { color: #1a7f37; font-weight: 600; }
.badge-breached { color: #cf222e; font-weight: 600; }
.badge-voided { color: #6e7781; font-weight: 600; }
.badge-declined { color: #57606a; font-weight: 600; }
.badge-on-track { color: #1f6feb; font-weight: 600; }
.badge-pending { color: #9a6700; font-weight: 600; }
.badge-trial-pending { color: #8250df; font-weight: 600; }
.badge-main-active { color: #0969da; font-weight: 600; }
.cost-summary { display: flex; gap: 2rem; margin-top: 0.5rem; }
.cost-summary div { padding: 0.5rem 0.75rem; background: #f6f8fa; border-radius: 4px; }
ul.event-log { list-style: none; padding: 0; max-height: 400px; overflow-y: auto; border: 1px solid #d0d7de; border-radius: 4px; background: #fafafa; }
ul.event-log li { padding: 0.4rem 0.75rem; border-bottom: 1px solid #eaeef2; font-size: 0.85em; }
ul.event-log li .hour { display: inline-block; width: 4ch; color: #57606a; }
ul.event-log li .kind { display: inline-block; margin-left: 0.5rem; font-weight: 600; min-width: 14ch; }
footer { margin-top: 3rem; color: #57606a; font-size: 0.85em; }
`;

function renderRunSummary(run: PersistedRun): string {
  const { state } = run;
  const totalCost = state.totalCost ?? 0;
  const breach = state.eventLog.find((e) => e.kind === 'sim-complete')?.detail ?? '';
  const eventCount = state.eventLog.filter((e) => e.kind === 'event-fired').length;
  const replanCount = state.eventLog.filter((e) => e.kind === 'replan').length;
  const hazardCount = state.injectedHazards.length;
  return `
<div class="cost-summary">
  <div><strong>Total realized cost</strong><br/>$${totalCost.toFixed(2)}</div>
  <div><strong>Hours simulated</strong><br/>${state.currentHour} / ${state.horizonHours}</div>
  <div><strong>Events fired</strong><br/>${eventCount}</div>
  <div><strong>Replans</strong><br/>${replanCount}</div>
  <div><strong>Hazards injected</strong><br/>${hazardCount}</div>
</div>
${breach ? `<p style="margin-top: 0.75rem; color: #57606a;">${escapeHtml(breach)}</p>` : ''}
`;
}

function renderCostChartSVG(state: SimulationState): string {
  const samples = state.costHistory;
  if (samples.length < 2) return '<p>(not enough data points to render chart)</p>';
  const W = 720;
  const H = 200;
  const pad = 40;
  const totals = samples.map((s) => s.transport + s.holding);
  const xMax = state.horizonHours;
  const yMax = Math.max(1, ...totals);

  const xFor = (h: number) => pad + ((W - pad * 2) * h) / xMax;
  const yFor = (v: number) => H - pad - ((H - pad * 2) * v) / yMax;

  const buildPath = (vals: number[]) =>
    samples
      .map((s, i) => `${i === 0 ? 'M' : 'L'} ${xFor(s.hour).toFixed(1)} ${yFor(vals[i] ?? 0).toFixed(1)}`)
      .join(' ');

  const transport = buildPath(samples.map((s) => s.transport));
  const holding = buildPath(samples.map((s) => s.holding));
  const total = buildPath(totals);

  return `
<svg width="${W}" height="${H}" style="background: #fafafa; border: 1px solid #d0d7de;">
  <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#999" />
  <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H - pad}" stroke="#999" />
  <path d="${transport}" stroke="#1f6feb" stroke-width="2" fill="none" />
  <path d="${holding}" stroke="#9a6700" stroke-width="2" fill="none" />
  <path d="${total}" stroke="#1a7f37" stroke-width="2" fill="none" />
  <text x="${pad}" y="${pad - 8}" font-size="11" fill="#444">$${yMax.toFixed(0)}</text>
  <text x="${W - pad - 50}" y="${H - pad + 14}" font-size="11" fill="#444">h${xMax}</text>
</svg>
<p style="font-size: 0.85em; margin-top: 0.4rem;">
<span style="color: #1f6feb;">● transport</span>
<span style="color: #9a6700; margin-left: 1rem;">● holding</span>
<span style="color: #1a7f37; margin-left: 1rem;">● total</span>
</p>
`;
}

function renderContractTable(state: SimulationState): string {
  const rows = Object.values(state.contractDeliveries)
    .map((cd) => {
      const breach = state.plan.breachByContract[cd.contractId] ?? 0;
      return `
<tr>
  <td><code>${escapeHtml(cd.contractId)}</code></td>
  <td>${cd.delivered.toFixed(0)}</td>
  <td>${breach > 1e-6 ? breach.toFixed(0) : '—'}</td>
  <td><span class="badge-${cd.status}">${escapeHtml(cd.status)}</span></td>
</tr>`;
    })
    .join('');
  return `<table>
<thead><tr><th>Contract</th><th>Delivered</th><th>Planned breach</th><th>Status</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

function renderEventLog(state: SimulationState): string {
  if (state.eventLog.length === 0) return '<p>(no events)</p>';
  const items = state.eventLog
    .map(
      (e) => `<li><span class="hour">h${e.hour}</span><span class="kind">${escapeHtml(e.kind)}</span> ${escapeHtml(e.detail)}</li>`,
    )
    .join('');
  return `<ul class="event-log">${items}</ul>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
