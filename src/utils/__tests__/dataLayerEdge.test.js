import { describe, it, expect } from 'vitest';
import {
  computeDataLayerEdge, foreignBucket, kapBucket, calmBucket, FOREIGN_FLOW_BAND_PP, CALM_TOP_MIN, CALM_BOTTOM_MAX,
} from '../dataLayerEdge.js';
import { DATA_LAYER_POLICY, isCalmRankSelectionEnabled } from '../dataLayerPolicy.js';

// A settled BUY signal: planReturn makes it settled and is the return learned.
const sig = (o = {}) => ({ cls: 'buy', planReturn: 1, ...o });

describe('dataLayerEdge — buckets', () => {
  it('splits foreign flow around ±0.3 percentage points', () => {
    expect(FOREIGN_FLOW_BAND_PP).toBe(0.3);
    expect(foreignBucket({ foreignChangeWeek: 0.3 })).toBe('inflow');
    expect(foreignBucket({ foreignChangeWeek: -0.31 })).toBe('outflow');
    expect(foreignBucket({ foreignChangeWeek: 0.1 })).toBe('flat');
    expect(foreignBucket({})).toBe('unknown');
    expect(foreignBucket({ foreignChangeWeek: '1' })).toBe('unknown');
  });

  it('treats a signal recorded without a KAP check as unknown, not as "no disclosure"', () => {
    expect(kapBucket({ kapCount: 0 })).toBe('unknown');
    expect(kapBucket({ kapChecked: true, kapCount: 0, kapCategories: [] })).toBe('none');
    expect(kapBucket({ kapChecked: true, kapCount: 2, kapCategories: ['buyback'] })).toBe('event');
    expect(kapBucket({ kapChecked: true, kapCount: 1, kapCategories: [] })).toBe('other');
    expect(kapBucket({ kapChecked: true, kapRisk: 'trading_measure', kapCategories: ['buyback'] })).toBe('risk');
  });
});

describe('dataLayerEdge — computeDataLayerEdge', () => {
  it('measures only settled BUY signals', () => {
    const edge = computeDataLayerEdge([
      sig({ foreignChangeWeek: 1 }),
      { cls: 'sell', planReturn: 5, foreignChangeWeek: 1 },          // sell: ignored
      { cls: 'buy', foreignChangeWeek: 1 },                            // not settled: ignored
    ]);
    expect(edge.settled).toBe(1);
    expect(edge.foreign.inflow.n).toBe(1);
  });

  it('reports win rate and average return per bucket', () => {
    const edge = computeDataLayerEdge([
      sig({ planReturn: 4, foreignChangeWeek: 0.8 }),
      sig({ planReturn: -2, foreignChangeWeek: 0.5 }),
      sig({ planReturn: -1, foreignChangeWeek: -0.9 }),
    ], { minSample: 2 });
    expect(edge.foreign.inflow).toEqual({ n: 2, winRate: 50, avgReturn: 1, reliable: true });
    expect(edge.foreign.outflow).toEqual({ n: 1, winRate: 0, avgReturn: -1, reliable: false });
    expect(edge.foreign.flat).toEqual({ n: 0, winRate: null, avgReturn: null, reliable: false });
    expect(edge.withForeign).toBe(3);
  });

  it('uses the same MIN_SAMPLE as live edge by default — small samples lie', () => {
    const seven = Array.from({ length: 7 }, () => sig({ kapChecked: true, kapCount: 1, kapCategories: ['buyback'] }));
    expect(computeDataLayerEdge(seven).kap.event.reliable).toBe(false);
    expect(computeDataLayerEdge([...seven, seven[0]]).kap.event.reliable).toBe(true);
  });

  it('counts signals without foreign/KAP data as settled but outside every bucket', () => {
    const edge = computeDataLayerEdge([sig(), sig({ kapChecked: true, kapCount: 0, kapCategories: [] })]);
    expect(edge.settled).toBe(2);
    expect(edge.withForeign).toBe(0);
    expect(edge.withKap).toBe(1);
    expect(edge.kap.none.n).toBe(1);
  });

  it('tracks buyback and new-business signals in their own, overlapping buckets (v31.41)', () => {
    const edge = computeDataLayerEdge([
      sig({ planReturn: 3, kapChecked: true, kapCount: 2, kapCategories: ['buyback'] }),
      sig({ planReturn: -1, kapChecked: true, kapCount: 2, kapCategories: ['buyback', 'new_business'] }),
      sig({ planReturn: 2, kapChecked: true, kapCount: 1, kapCategories: ['dividend'] }),
      // a trading measure outranks the event: counted as risk, not as a buyback
      sig({ planReturn: 5, kapChecked: true, kapCount: 1, kapRisk: 'trading_measure', kapCategories: ['buyback'] }),
    ], { minSample: 2 });
    expect(edge.kapEvents.buyback).toEqual({ n: 2, winRate: 50, avgReturn: 1, reliable: true });
    expect(edge.kapEvents.new_business).toEqual({ n: 1, winRate: 0, avgReturn: -1, reliable: false });
    expect(edge.kap.event.n).toBe(3);
    expect(edge.kap.risk.n).toBe(1);
  });

  it('is defensive', () => {
    expect(computeDataLayerEdge(null).settled).toBe(0);
  });
});

// v31.53: the calm rank is shown and measured, not used for selection (dataLayerPolicy).
describe('dataLayerEdge — calm rank thirds', () => {
  it('buckets the 0-100 rank into thirds and leaves pre-v31.53 signals out', () => {
    expect(calmBucket({ calmRank: CALM_TOP_MIN })).toBe('top');
    expect(calmBucket({ calmRank: 50 })).toBe('mid');
    expect(calmBucket({ calmRank: CALM_BOTTOM_MAX })).toBe('bottom');
    expect(calmBucket({ calmRank: 0 })).toBe('bottom');
    expect(calmBucket({})).toBe('unknown');
    expect(calmBucket({ calmRank: null })).toBe('unknown');
    expect(calmBucket({ calmRank: '80' })).toBe('unknown');
  });

  it('reports each third and counts only signals that carry a rank', () => {
    const edge = computeDataLayerEdge([
      sig({ planReturn: 3, calmRank: 90 }),
      sig({ planReturn: 1, calmRank: 70 }),
      sig({ planReturn: -2, calmRank: 10 }),
      sig({ planReturn: 5 }),                      // recorded before the rank existed
    ], { minSample: 2 });
    expect(edge.calm.top).toEqual({ n: 2, winRate: 100, avgReturn: 2, reliable: true });
    expect(edge.calm.bottom).toEqual({ n: 1, winRate: 0, avgReturn: -2, reliable: false });
    expect(edge.calm.mid.n).toBe(0);
    expect(edge.withCalm).toBe(3);
    expect(edge.settled).toBe(4);
  });

  it('the policy keeps it out of selection until the table says otherwise', () => {
    expect(DATA_LAYER_POLICY.calmRankSelection).toBe(false);
    expect(isCalmRankSelectionEnabled()).toBe(false);
  });
});
