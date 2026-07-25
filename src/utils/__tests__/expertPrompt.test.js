import { describe, it, expect } from 'vitest';
import { buildExpertPrompt } from '../claude.js';

// The single-stock expert prompt must think like a 25yr strategist: it has to
// surface global macro (oil/gold/VIX/S&P/FX), this stock's thematic tailwind,
// and current news — not just the chart. These tests lock that wiring so a
// refactor can't silently drop the macro/thematic/news blocks again.

const baseAnalysis = {
  price: 100, change: 1.2, signal: 'AL', cls: 'buy', score: 7.1, conf: 62,
  rsi: 55, ma200: 90, atr: 2, stop: 96, entry: 100, target: 108, rr: 2,
};

const macro = {
  usdtry: { value: 34.2, change5d: 1.1, vol20d: 18 },
  vix: { value: 22.5, change5d: 3, classification: 'elevated' },
  sp500: { value: 5600, change5d: -1.4 },
  brent: { value: 82.3, change5d: 6.2 },
  gold: { value: 2650, change5d: 1.5 },
  copper: { change5d: 2.1 },
  tcmb: { rate: 50, nextMeeting: new Date(Date.now() + 10 * 86400000).toISOString() },
  regime: 'risk_off',
  reasons: ['VIX 22.5 (yuksek) -5', 'Brent 5g +%6.2 (enflasyon riski) -3'],
};

describe('buildExpertPrompt — 25yr strategist enrichment', () => {
  it('reframes the persona as a 25-year global strategist', () => {
    const p = buildExpertPrompt('TUPRS', baseAnalysis, {});
    expect(p).toMatch(/25 yillik/);
    expect(p).toMatch(/petrol\/emtia/i);
  });

  it('renders the global/commodity macro block when macro is provided', () => {
    const p = buildExpertPrompt('TUPRS', baseAnalysis, { macro });
    expect(p).toMatch(/Brent \$82\.3/);
    expect(p).toMatch(/VIX=22\.5/);
    expect(p).toMatch(/S&P500 5g -1\.4%/);
    expect(p).toMatch(/Altin \$2650/);
    expect(p).toMatch(/Makro rejim: RISK_OFF/);
  });

  it('degrades gracefully when macro is absent (points model to web search)', () => {
    const p = buildExpertPrompt('TUPRS', baseAnalysis, {});
    expect(p).toMatch(/kuresel\/emtia verisi su an yok/);
    expect(p).not.toMatch(/Brent \$/);
  });

  it('injects the per-stock thematic tailwind line', () => {
    const thematic = { delta: 6, reasons: ['Brent yukseliyor → rafineri lehine +6'], themes: ['brent_up'] };
    const p = buildExpertPrompt('TUPRS', { ...baseAnalysis, thematic }, { macro });
    expect(p).toMatch(/MAKRO TEMA \(TUPRS\)/);
    expect(p).toMatch(/rafineri lehine \+6/);
    expect(p).toMatch(/net \+6 puan/);
  });

  it('injects a current-news line when news exists', () => {
    const news = { count: 3, score: 5, categories: ['fund_inflow', 'contract'], topItem: { title: 'TUPRS yeni rafineri anlasmasi imzaladi' } };
    const p = buildExpertPrompt('TUPRS', { ...baseAnalysis, news }, { macro });
    expect(p).toMatch(/GUNCEL HABER \(TUPRS\)/);
    expect(p).toMatch(/fund_inflow,contract/);
    expect(p).toMatch(/yeni rafineri anlasmasi/);
  });

  it('adds a [MAKRO_ETKI] response section', () => {
    const p = buildExpertPrompt('TUPRS', baseAnalysis, { macro });
    expect(p).toMatch(/\[MAKRO_ETKI\]/);
  });

  it('omits thematic/news lines cleanly when absent (no "undefined")', () => {
    const p = buildExpertPrompt('THYAO', baseAnalysis, { macro });
    expect(p).not.toMatch(/undefined/);
    expect(p).toMatch(/aktif tematik ruzgar/); // macro present but no thematic → notr line
  });
});
