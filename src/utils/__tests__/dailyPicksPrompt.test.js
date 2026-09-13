import { describe, it, expect } from 'vitest';
import { buildDailyPicksPrompt } from '../claude.js';

const base = { symbol: 'ASTOR', signal: 'AL', score: 72, price: 100, stop: 95, target: 110, rr: 2, rsi: 55 };

describe('buildDailyPicksPrompt — KAP reaches Claude with the measured evidence (v31.40)', () => {
  it('lists the current KAP event types of a pick (the old kapSentiment field was never filled)', () => {
    const txt = buildDailyPicksPrompt([{ ...base, kapCategories: ['new_business', 'buyback'], kapHeadline: 'Yeni İş İlişkisi' }]);
    expect(txt).toContain('KAP[new_business,buyback] "Yeni İş İlişkisi"');
  });

  it('flags a trading measure on the stock', () => {
    expect(buildDailyPicksPrompt([{ ...base, kapRisk: 'trading_measure' }])).toContain('KAP[TEDBIR:trading_measure]');
  });

  it('carries the 24-month event study so a deal headline is not read as a buy reason', () => {
    const txt = buildDailyPicksPrompt([base]);
    expect(txt).toMatch(/new_business: once \+1\.6%, 5 seans -0\.4%/);
    expect(txt).toMatch(/buyback: once \+0\.7%, 5 seans \+0\.6%, 10 seans \+1\.2%/);
    expect(txt).toContain('A notu gerekcesi DEGILDIR');
  });

  it('adds nothing KAP-specific to a row without KAP data', () => {
    const txt = buildDailyPicksPrompt([base]);
    expect(txt).toMatch(/- ASTOR \[[A-D]\] AL skor=72\.0 .*RSI=55\n/);
    expect(txt).not.toMatch(/ASTOR.*KAP\[/);
  });

  it('shows deal news but tells Claude it is not a confirmation (v31.41)', () => {
    const txt = buildDailyPicksPrompt([{ ...base, newsCount: 1, newsScore: 6.6, newsCategories: ['contract'], newsHeadline: 'Yeni siparis' }]);
    expect(txt).toContain('HABER[contract]=+6.6(1) "Yeni siparis"');
    expect(txt).toContain('contract ve catalyst_event bilgi amaclidir, TEYIT SAYILMAZ');
  });
});
