import { describe, it, expect } from 'vitest';
import {
  classifyNewsItem,
  extractSymbols,
  indexBySymbol,
  formatNewsForPrompt,
} from '../marketNewsEngine.js';

describe('extractSymbols', () => {
  it('finds 4-6 letter uppercase tickers', () => {
    const t = 'THYAO ve ASELS hisselerinde yabanci alimi devam ediyor.';
    const found = extractSymbols(t);
    expect(found).toContain('THYAO');
    expect(found).toContain('ASELS');
  });

  it('respects universe filter', () => {
    const t = 'THYAO ve XYZAB hisseleri hareketli.';
    const found = extractSymbols(t, ['THYAO']);
    expect(found).toEqual(['THYAO']);
  });

  it('blacklists common Turkish caps words when no universe', () => {
    const t = 'BIST 100 endeksi BORSA gun sonu yukseldi, TUFE acikladi.';
    const found = extractSymbols(t);
    expect(found).not.toContain('BIST');
    expect(found).not.toContain('BORSA');
    expect(found).not.toContain('TUFE');
  });

  it('returns empty for null/empty input', () => {
    expect(extractSymbols('')).toEqual([]);
    expect(extractSymbols(null)).toEqual([]);
  });
});

describe('classifyNewsItem', () => {
  it('detects fund_inflow category with positive sentiment', () => {
    const r = classifyNewsItem({
      title: 'BIST 100\'de yabanci alimi rekor seviyede',
      summary: 'Kurumsal alim ve para girisi son haftada artti',
      date: new Date().toISOString(),
    });
    expect(r.categories.some(c => c.cat === 'fund_inflow')).toBe(true);
    expect(r.sentiment).toBeGreaterThan(0);
  });

  it('detects fundamental_rank for current-ratio rankings', () => {
    const r = classifyNewsItem({
      title: 'BIST 100\'de 24 sirketin cari orani 2\'nin uzerinde',
      summary: 'Likidite oranlari ve cari oran siralamasi acikland',
      date: new Date().toISOString(),
    });
    expect(r.categories.some(c => c.cat === 'fundamental_rank')).toBe(true);
  });

  it('detects buyback', () => {
    const r = classifyNewsItem({
      title: 'Sirket pay geri alim programi acikladi',
      summary: 'Hisse geri alim programi onayland',
    });
    expect(r.categories.some(c => c.cat === 'buyback')).toBe(true);
    expect(r.sentiment).toBeGreaterThan(0);
  });

  it('detects analyst upgrade with positive sentiment', () => {
    const r = classifyNewsItem({
      title: 'X Bank: hedef fiyat yukseltildi, AL tavsiyesi',
      summary: 'Analist raporunda agirlik artirildi',
    });
    expect(r.categories.some(c => c.cat === 'upgrade')).toBe(true);
    expect(r.sentiment).toBeGreaterThan(0);
  });

  it('detects risk with negative sentiment', () => {
    const r = classifyNewsItem({
      title: 'Sirket hakkinda sorusturma baslatildi',
      summary: 'Ceza kesildi, dava acildi',
    });
    expect(r.categories.some(c => c.cat === 'risk')).toBe(true);
    expect(r.sentiment).toBeLessThan(0);
  });

  it('returns no categories + zero sentiment for generic text', () => {
    const r = classifyNewsItem({
      title: 'Hava bugun guneşli',
      summary: 'Genel bilgi haberi',
    });
    expect(r.categories).toEqual([]);
    expect(r.sentiment).toBe(0);
  });

  it('applies recency multiplier', () => {
    const recent = classifyNewsItem({
      title: 'Kurumsal alim yogunlasti',
      date: new Date().toISOString(),
    });
    const old = classifyNewsItem({
      title: 'Kurumsal alim yogunlasti',
      date: new Date(Date.now() - 30 * 86400000).toISOString(),
    });
    expect(recent.sentiment).toBeGreaterThan(old.sentiment);
  });

  it('clamps sentiment to [-10, +10]', () => {
    // pile every positive category
    const r = classifyNewsItem({
      title: 'Yabanci alimi, kurumsal alim, geri alim, iceriden alim, temettu, hedef fiyat yukseltildi, sozlesme imzalandi',
      summary: 'Tum pozitif sinyaller bir arada',
      date: new Date().toISOString(),
    });
    expect(r.sentiment).toBeLessThanOrEqual(10);
    expect(r.sentiment).toBeGreaterThanOrEqual(-10);
  });
});

describe('indexBySymbol', () => {
  it('groups news by symbol with aggregate score', () => {
    const news = [
      { title: 'THYAO yabanci alimi rekor', summary: '', symbols: ['THYAO'], categories: [{ cat: 'fund_inflow' }], sentiment: 5, impact: 'medium', date: new Date().toISOString(), sourceWeight: 1 },
      { title: 'THYAO temettu acikladi', summary: '', symbols: ['THYAO'], categories: [{ cat: 'dividend' }], sentiment: 4, impact: 'medium', date: new Date().toISOString(), sourceWeight: 1 },
      { title: 'ASELS sorusturma', summary: '', symbols: ['ASELS'], categories: [{ cat: 'risk' }], sentiment: -7, impact: 'high', date: new Date().toISOString(), sourceWeight: 1 },
    ];
    const idx = indexBySymbol(news);
    expect(idx.THYAO.count).toBe(2);
    expect(idx.THYAO.score).toBeGreaterThan(0);
    expect(idx.THYAO.categories).toContain('fund_inflow');
    expect(idx.THYAO.categories).toContain('dividend');
    expect(idx.ASELS.score).toBeLessThan(0);
    expect(idx.ASELS.highImpact).toBe(1);
  });

  it('clamps aggregate score to [-10, +10]', () => {
    const news = Array.from({ length: 8 }, () => ({
      title: 't', summary: '', symbols: ['THYAO'], categories: [{ cat: 'buyback' }],
      sentiment: 6, impact: 'high', date: new Date().toISOString(), sourceWeight: 1.1,
    }));
    const idx = indexBySymbol(news);
    expect(idx.THYAO.score).toBeLessThanOrEqual(10);
  });

  it('skips items with no symbols', () => {
    const idx = indexBySymbol([
      { title: 'genel haber', symbols: [], categories: [], sentiment: 0 },
    ]);
    expect(Object.keys(idx).length).toBe(0);
  });
});

describe('formatNewsForPrompt', () => {
  it('produces a prompt-ready short string', () => {
    const news = [
      { title: 'THYAO yabanci alimi rekor seviyede', symbols: ['THYAO'], categories: [{ cat: 'fund_inflow' }], sentiment: 5, impact: 'medium', date: new Date().toISOString(), sourceWeight: 1 },
    ];
    const idx = indexBySymbol(news);
    const out = formatNewsForPrompt(idx, 'THYAO');
    expect(out).toContain('HABER');
    expect(out).toContain('fund_inflow');
    expect(out).toContain('THYAO yabanci alimi rekor');
  });

  it('returns empty string when no entry', () => {
    expect(formatNewsForPrompt({}, 'XXX')).toBe('');
  });
});
