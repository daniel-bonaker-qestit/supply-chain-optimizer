import { describe, expect, it } from 'vitest';
import { renderRunHTML } from './report-generator.ts';
import type { PersistedRun } from '../persistence/run-archive.ts';
import { SCHEMA_VERSION } from '../persistence/run-archive.ts';
import type { SimulationState } from '../sim/simulator.ts';

const sampleRun = (): PersistedRun => {
  const state: SimulationState = {
    currentHour: 168,
    horizonHours: 168,
    status: 'complete',
    plan: {
      shipments: [],
      deliveries: [],
      totalCost: 1234.5,
      breachByContract: { 'food-c1': 0 },
    },
    inFlight: [],
    contractDeliveries: {
      'food-c1': {
        contractId: 'food-c1',
        delivered: 200,
        trialDelivered: 20,
        mainDelivered: 180,
        status: 'delivered',
        trialQualityPassed: true,
        trialMinShelfLife: 60,
      },
    },
    totalCost: 1234.5,
    scheduledEvents: [],
    activeDisruptions: [],
    eventLog: [
      { hour: 0, kind: 'sim-start', detail: 'Run started' },
      { hour: 30, kind: 'event-fired', detail: 'Lane disruption' },
      { hour: 30, kind: 'replan', detail: 'Replan produced 5 shipments' },
      { hour: 168, kind: 'sim-complete', detail: 'Run complete; total cost 1234.5' },
    ],
    inventory: {},
    injectedHazards: [],
    replanSuppressedUntilHour: undefined,
    costHistory: [
      { hour: 1, transport: 0, holding: 0 },
      { hour: 50, transport: 200, holding: 30 },
      { hour: 168, transport: 1200, holding: 34.5 },
    ],
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'food::seed-1::no-hazards',
    sector: 'food',
    seed: 'seed-1',
    hazardFingerprint: 'no-hazards',
    savedAt: '2026-05-08T20:00:00.000Z',
    state,
  };
};

describe('report-generator.renderRunHTML', () => {
  it('produces a self-contained HTML document with no external network references', () => {
    const html = renderRunHTML(sampleRun());
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<title>');
    expect(html).toContain('Supply Chain Optimizer');
    // No <script src=...>, <link href=...>, <img src=http..., or url(http...) references.
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(html).not.toMatch(/<link[^>]*\shref=/i);
    expect(html).not.toMatch(/url\((['"]?)https?:/i);
    expect(html).not.toMatch(/<img[^>]*\ssrc=["']?https?:/i);
  });

  it('includes the run id, sector, seed, total cost, and event-log entries', () => {
    const html = renderRunHTML(sampleRun());
    expect(html).toContain('food::seed-1::no-hazards');
    expect(html).toContain('food');
    expect(html).toContain('seed-1');
    expect(html).toContain('1234.50');
    expect(html).toContain('Lane disruption');
    expect(html).toContain('Replan produced 5 shipments');
  });

  it('renders the inline cost-history SVG chart', () => {
    const html = renderRunHTML(sampleRun());
    expect(html).toContain('<svg');
    expect(html).toContain('transport');
    expect(html).toContain('holding');
  });

  it('renders the contract row with proper status badge', () => {
    const html = renderRunHTML(sampleRun());
    expect(html).toContain('food-c1');
    expect(html).toContain('badge-delivered');
  });

  it('escapes HTML metacharacters in fields', () => {
    const r = sampleRun();
    r.id = 'food::<script>alert(1)</script>';
    const html = renderRunHTML(r);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
