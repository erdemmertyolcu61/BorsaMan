import { describe, it, expect } from 'vitest';
import { MOVERS_FORWARD_PLAN as PLAN, moversVerdict, verdictText } from '../forwardVerdict.js';
import { NEXT_SESSION_MODEL } from '../nextSessionModel.js';
import { dayT } from '../moversScorecard.js';

describe('ileri olcum plani', () => {
  it('kontrol noktalari daralan bir bant: alt sinir yukselir, sifir-avantaj siniri duser', () => {
    const c = PLAN.checkpoints;
    expect(c.map((x) => x.sessions)).toEqual([20, 40, 60]);
    for (let i = 1; i < c.length; i++) {
      expect(c[i].p5).toBeGreaterThan(c[i - 1].p5);
      expect(c[i].nullP95).toBeLessThan(c[i - 1].nullP95);
    }
    expect(c[c.length - 1].sessions).toBe(PLAN.finalSessions);
    expect(PLAN.firstBasisDay < PLAN.firstSession).toBe(true);
  });

  it('plan dondurulmus modele bagli — model yeniden egitilirse plan bozulur, once kullaniciya sor', () => {
    expect(NEXT_SESSION_MODEL.builtAt).toBe(PLAN.modelBuiltAt);
  });
});

describe('moversVerdict', () => {
  it('20 seanstan once ya da veri yoksa erken', () => {
    expect(moversVerdict({ sessions: 5, avgNet: 2 }).stage).toBe('early');
    expect(moversVerdict({ sessions: 25, avgNet: null }).stage).toBe('early');
    expect(moversVerdict({}).next).toBe(20);
  });

  it('ara kontrol noktalari: son gecilen noktanin alt sinirina gore', () => {
    expect(moversVerdict({ sessions: 25, avgNet: 0.1 })).toMatchObject({ stage: 'inBand', next: 40 });
    expect(moversVerdict({ sessions: 25, avgNet: -0.5 }).stage).toBe('belowBand');
    expect(moversVerdict({ sessions: 45, avgNet: 0.1 }).stage).toBe('belowBand');      // 40 seans alt siniri +0,15
    expect(moversVerdict({ sessions: 45, avgNet: 0.2 })).toMatchObject({ stage: 'inBand', next: 60 });
  });

  it('60 seansta karar: sifir-avantaj sinirinin ustu VE t > 2', () => {
    expect(moversVerdict({ sessions: 60, avgNet: 0.7, dayT: 2.5 }).stage).toBe('consistent');
    expect(moversVerdict({ sessions: 60, avgNet: 0.7, dayT: 1.5 }).stage).toBe('unclear');
    expect(moversVerdict({ sessions: 70, avgNet: 0.4, dayT: 3 }).stage).toBe('unclear');
    expect(moversVerdict({ sessions: 60, avgNet: 0.2, dayT: 1 }).stage).toBe('failing');
  });

  it('her durum icin tek cumle', () => {
    for (const [s, v] of [[3, { sessions: 3, avgNet: 1 }], [25, { sessions: 25, avgNet: 0.5 }], [25, { sessions: 25, avgNet: -1 }],
      [60, { sessions: 60, avgNet: 0.8, dayT: 3 }], [60, { sessions: 60, avgNet: 0, dayT: 0 }], [60, { sessions: 60, avgNet: 0.4, dayT: 1 }]]) {
      const txt = verdictText(moversVerdict(v), s);
      expect(typeof txt).toBe('string');
      expect(txt.length).toBeGreaterThan(20);
    }
    expect(verdictText(moversVerdict({ sessions: 3, avgNet: 1 }), 3)).toContain('3/20');
  });
});

describe('dayT', () => {
  it('en az 3 gun; sapma yoksa null', () => {
    expect(dayT([1, 2])).toBeNull();
    expect(dayT([1, 1, 1])).toBeNull();
    expect(dayT([1, 2, 3])).toBeCloseTo(2 / (1 / Math.sqrt(3)), 6);
  });
});
