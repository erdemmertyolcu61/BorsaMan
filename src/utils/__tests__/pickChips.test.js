/**
 * AI Fırsatlar kart rozetleri (v31.47): up to ~20 chips used to pile onto a
 * 280 px card. They are now one list ordered by what changes the decision.
 */
import { describe, it, expect } from 'vitest';
import { buildPickChips, splitChips, MAX_VISIBLE_CHIPS } from '../pickChips.js';

describe('buildPickChips', () => {
  it('puts the warnings that block or change a buy first', () => {
    const chips = buildPickChips({
      cls: 'buy', convictionTier: 'sniper', score: 80, rsLeading: true, rsOutperf: 6,
      _watchOnly: true, kapRisk: 'trading_halt', _earlyPick: true,
    });
    expect(chips[0].key).toBe('watch');
    expect(chips[1].key).toBe('kaprisk');
    expect(chips.map(c => c.key)).toContain('sniper');
    expect(chips.findIndex(c => c.key === 'sniper')).toBeLessThan(chips.findIndex(c => c.key === 'early'));
  });

  it('labels carry no emoji and no shouting caps', () => {
    const chips = buildPickChips({
      cls: 'buy', convictionTier: 'sniper', score: 80, recentPump: 9.5, continuationProbability: 41,
      hasRecentInsiderBuy: true, _nearBreakoutPick: true, foreignFlowLabel: 'GIRIS', foreignFlowScore: 6,
    });
    for (const c of chips) {
      expect(c.label).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(c.label).not.toMatch(/^[A-ZÇĞİÖŞÜ\s·%0-9+]{6,}$/);
    }
  });

  it('does not repeat the counter-regime warning on a watch-only pick', () => {
    const keys = buildPickChips({ cls: 'buy', _watchOnly: true, _counterRegime: true }).map(c => c.key);
    expect(keys).toContain('watch');
    expect(keys).not.toContain('counter');
  });

  it('keeps every chip — the rest go behind "+N"', () => {
    const chips = buildPickChips({
      cls: 'buy', convictionTier: 'sniper', score: 80, _bestOfDay: true, _fundPenalty: 4,
      _earlyPick: true, _thematicBoost: 3, hasRecentInsiderBuy: true,
    });
    const { visible, hidden } = splitChips(chips);
    expect(visible).toHaveLength(MAX_VISIBLE_CHIPS);
    expect(visible.length + hidden.length).toBe(chips.length);
  });
});
