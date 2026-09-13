import { describe, it, expect } from 'vitest';
import { kapBuybackBoost, KAP_BUYBACK_CONFIDENCE_BOOST, KAP_EVENT_EVIDENCE } from '../kapFeed.js';

const buy = (o = {}) => ({ symbol: 'ASTOR', cls: 'buy', kapChecked: true, kapCategories: ['buyback'], ...o });

describe('kapBuybackBoost — user decision 2026-09-13: small plus for the one measured positive KAP event', () => {
  it('gives a buy candidate with a recent buyback filing a bounded +3', () => {
    expect(KAP_BUYBACK_CONFIDENCE_BOOST).toBe(3);
    expect(kapBuybackBoost(buy())).toEqual({ delta: 3, reason: 'applied' });
    // hold candidates that the advisor lists as buys get it too
    expect(kapBuybackBoost(buy({ cls: 'hold', kapCategories: ['dividend', 'buyback'] })).delta).toBe(3);
  });

  it('rests on the measured evidence and gives nothing for the other KAP events', () => {
    expect(KAP_EVENT_EVIDENCE.buyback.h10ExcessPct).toBeGreaterThan(0);
    expect(KAP_EVENT_EVIDENCE.buyback.stable).toBe(true);
    for (const type of ['new_business', 'bonus_issue', 'capital_increase', 'm_and_a', 'tender', 'dividend']) {
      expect(kapBuybackBoost(buy({ kapCategories: [type] })).delta).toBe(0);
    }
  });

  it('never boosts a sell, a stock under a trading measure or a stale session', () => {
    expect(kapBuybackBoost(buy({ cls: 'sell' })).reason).toBe('not_buy');
    expect(kapBuybackBoost(buy({ kapRisk: 'trading_measure' })).reason).toBe('blocked');
    expect(kapBuybackBoost(buy({ _staleSession: true })).reason).toBe('blocked');
  });

  it('does not count the same buyback twice when the news delta already credited it', () => {
    expect(kapBuybackBoost(buy({ _newsBuybackCredited: true }))).toEqual({ delta: 0, reason: 'news_credited' });
    expect(kapBuybackBoost(buy({ _newsBuybackCredited: false })).delta).toBe(3);
  });

  it('switches off with the policy flag', () => {
    expect(kapBuybackBoost(buy(), { enabled: false })).toEqual({ delta: 0, reason: 'disabled' });
  });

  it('is defensive', () => {
    expect(kapBuybackBoost(null).delta).toBe(0);
    expect(kapBuybackBoost({ cls: 'buy' }).reason).toBe('no_buyback');
    expect(kapBuybackBoost({ cls: 'buy', kapCategories: 'buyback' }).reason).toBe('no_buyback');
  });
});
