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

  it('v31.53: evidence lines quote the current measurement, not the retired one', () => {
    const text = buildPickChips({
      cls: 'buy', convictionTier: 'sniper', score: 80, _watchOnly: true,
    }).map(c => c.title).join('\n') + buildPickChips({
      cls: 'buy', convictionTier: 'flagged', score: 68, _counterRegime: true,
    }).map(c => c.title).join('\n');
    // The old lines came from an 81-signal study that tagged the regime with the entry
    // day's close (one day of lookahead) and from a small score backtest.
    expect(text).not.toMatch(/3,4|18,8|62,5|0,77|yazı-tura/);
    expect(text).toMatch(/257 hisse/);
  });

  it('v31.53: the calm rank is shown as information on the top third only', () => {
    const top = buildPickChips({ cls: 'buy', _calmRank: 80 }).find(c => c.key === 'calm');
    expect(top).toMatchObject({ tone: 'info' });
    expect(top.title).toMatch(/etkilemez/);
    expect(buildPickChips({ cls: 'buy', _calmRank: 50 }).some(c => c.key === 'calm')).toBe(false);
    expect(buildPickChips({ cls: 'sell', _calmRank: 90 }).some(c => c.key === 'calm')).toBe(false);
    expect(buildPickChips({ cls: 'buy' }).some(c => c.key === 'calm')).toBe(false);
  });

  it('v31.53: leading the index is information, not a green light', () => {
    const rs = buildPickChips({ cls: 'buy', rsLeading: true, rsOutperf: 6, rsScore: 3.6 }).find(c => c.key === 'rs');
    expect(rs.tone).toBe('neutral');
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
