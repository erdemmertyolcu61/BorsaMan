import { describe, it, expect } from 'vitest';
import { classifyNewsItem, indexBySymbol, symbolNewsScore } from '../marketNewsEngine.js';
import {
  newsConfidenceDelta, NEWS_UNSCORED_CATEGORIES, NEWS_CATALYST_CATEGORIES, NEWS_CATALYST_BONUS, NEWS_DELTA_CAP,
} from '../newsConfidence.js';

const DAY = 86400000;
// An RSS item as fetchMarketNews builds it: classified, tagged with a symbol and a source weight.
const item = (title, { daysAgo = 0, sourceWeight = 1 } = {}) => ({
  title, summary: '', symbols: ['ASTOR'], sourceWeight,
  ...classifyNewsItem({ title, date: new Date(Date.now() - daysAgo * DAY).toISOString() }),
});
const entryOf = (...items) => indexBySymbol(items).ASTOR;

describe('newsConfidenceDelta — user decision 2026-09-13: no plus for deal or event news', () => {
  it('gives a deal headline no confidence plus — neither the +5 nor its share of the news score', () => {
    const deal = entryOf(item('ASTOR yeni siparis aldi, sozlesme imzalandi', { sourceWeight: 1.1 }));
    expect(deal.categories).toEqual(['contract']);
    // Removing only the +5 would still have left 6.6 × 1.5 ≈ +10 through the score.
    expect(deal.score).toBeCloseTo(6.6, 5);
    expect(newsConfidenceDelta(deal)).toEqual({ delta: 0, catalystCategories: [], unscoredCategories: ['contract'] });
  });

  it('gives an event headline (transfer, partnership, acquisition) no plus either', () => {
    const event = entryOf(item('Kulup yildiz oyuncuyu transfer etti'));
    expect(event.categories).toEqual(['catalyst_event']);
    expect(newsConfidenceDelta(event).delta).toBe(0);
  });

  it('keeps the other catalysts: buyback news still earns +5 plus its score', () => {
    const bb = entryOf(item('Sirket pay geri alim programi acikladi', { daysAgo: 5 }));
    expect(bb.score).toBe(6);                                   // weight 6 × recency 1.0
    const r = newsConfidenceDelta(bb);
    expect(r.delta).toBe(6 * 1.5 + NEWS_CATALYST_BONUS);
    expect(r.catalystCategories).toEqual(['buyback']);
  });

  it('takes only the deal share out of a headline that also carries other news, at the same recency', () => {
    const upgradeOnly = entryOf(item('Hedef fiyat yukseltildi'));
    const mixedHeadline = entryOf(item('Hedef fiyat yukseltildi, yeni siparis aldi'));
    const twoItems = entryOf(item('Hedef fiyat yukseltildi'), item('Yeni siparis aldi'));
    expect(mixedHeadline.categories).toEqual(['upgrade', 'contract']);
    const expected = newsConfidenceDelta(upgradeOnly).delta;   // 7.5 × 1.5 + 3
    expect(expected).toBeCloseTo(14.25, 5);
    expect(newsConfidenceDelta(mixedHeadline).delta).toBeCloseTo(expected, 5);
    expect(newsConfidenceDelta(twoItems).delta).toBeCloseTo(expected, 5);
  });

  it('still lets negative news pull confidence down, and a sell reads it the other way', () => {
    const risk = entryOf(item('Sirket hakkinda sorusturma baslatildi'));
    expect(newsConfidenceDelta(risk).delta).toBe(-NEWS_DELTA_CAP);
    expect(newsConfidenceDelta(risk, { cls: 'sell' }).delta).toBe(NEWS_DELTA_CAP);
    // a deal headline is neutral for a sell too (and never -0)
    expect(newsConfidenceDelta(entryOf(item('Yeni siparis aldi')), { cls: 'sell' }).delta).toBe(0);
  });

  it('rebuilds the index score exactly when no item carries an excluded category', () => {
    const e = entryOf(
      item('Hedef fiyat yukseltildi', { daysAgo: 2, sourceWeight: 0.9 }),
      item('Temettu dagitim karari', { daysAgo: 5, sourceWeight: 0.7 }),
    );
    expect(e.score).toBeCloseTo(8.2, 5);
    expect(symbolNewsScore(e, { exclude: ['dilution'] })).toBe(e.score);
    expect(symbolNewsScore(e)).toBe(e.score);
  });

  it('documents the decision in its constants', () => {
    expect([...NEWS_UNSCORED_CATEGORIES].sort()).toEqual(['catalyst_event', 'contract']);
    for (const c of NEWS_UNSCORED_CATEGORIES) expect(NEWS_CATALYST_CATEGORIES).not.toContain(c);
    expect(NEWS_CATALYST_BONUS).toBe(5);
  });

  it('is defensive', () => {
    expect(newsConfidenceDelta(undefined).delta).toBe(0);
    expect(newsConfidenceDelta({ count: 0, score: 9 }).delta).toBe(0);
    expect(symbolNewsScore(null)).toBe(0);
    // without items the deal share can't be separated: a plus is dropped, a minus kept
    expect(symbolNewsScore({ score: 6, categories: ['contract'] }, { exclude: ['contract'] })).toBe(0);
    expect(symbolNewsScore({ score: -4, categories: ['contract', 'risk'] }, { exclude: ['contract'] })).toBe(-4);
  });
});
