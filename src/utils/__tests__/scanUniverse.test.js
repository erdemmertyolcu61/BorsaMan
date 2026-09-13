import { describe, it, expect } from 'vitest';
import { buildScanUniverse } from '../scanUniverse.js';

const staticList = ['THYAO', 'GARAN', 'BEKO', 'BRKO', 'YONGA', 'ISGLK'];
const listed = ['THYAO', 'GARAN', 'ARCLK', 'KARCL'];          // Is Yatirim equity list
const priced = ['THYAO', 'GARAN', 'BRKO', 'YONGA', 'ARCLK', 'KARCL', 'THYAOT', 'AVOD T'];

describe('buildScanUniverse (v31.40)', () => {
  // Tiny fixture: 2 of 8 codes vanish, so the "implausible share" guard is relaxed here.
  const small = { minPricedRatio: 0.5, maxDropRatio: 0.5 };

  it('the 2026-09-13 case: new listings come in, codes without a price go out', () => {
    const u = buildScanUniverse({ staticList, listedSymbols: listed, pricedSymbols: priced, ...small });
    expect(u.verified).toBe(true);
    expect(u.symbols).toEqual(['THYAO', 'GARAN', 'BRKO', 'YONGA', 'ARCLK', 'KARCL']);
    expect(u.added).toEqual(['ARCLK', 'KARCL']);
    expect(u.dropped).toEqual(['BEKO', 'ISGLK']);
  });

  it('keeps traded stocks the Is Yatirim list lacks (BRKO, YONGA)', () => {
    const u = buildScanUniverse({ staticList, listedSymbols: listed, pricedSymbols: priced, ...small });
    expect(u.symbols).toContain('BRKO');
    expect(u.symbols).toContain('YONGA');
  });

  it('drops nothing when the price list is missing', () => {
    const u = buildScanUniverse({ staticList, listedSymbols: listed, pricedSymbols: null });
    expect(u.verified).toBe(false);
    expect(u.dropped).toEqual([]);
    expect(u.symbols).toEqual(['THYAO', 'GARAN', 'BEKO', 'BRKO', 'YONGA', 'ISGLK', 'ARCLK', 'KARCL']);
  });

  it('drops nothing when the price list is too small to trust (partial outage)', () => {
    const u = buildScanUniverse({ staticList, listedSymbols: [], pricedSymbols: ['THYAO'] });
    expect(u.verified).toBe(false);
    expect(u.symbols).toHaveLength(staticList.length);
  });

  it('refuses to drop an implausible share of the universe', () => {
    const big = Array.from({ length: 100 }, (_, i) => `SYM${String(i).padStart(2, '0')}`);
    const pricedHalf = big.slice(0, 85);                  // enough to "verify", 15% would vanish
    const u = buildScanUniverse({ staticList: big, pricedSymbols: pricedHalf });
    expect(u.suspicious).toBe(true);
    expect(u.verified).toBe(false);
    expect(u.symbols).toHaveLength(100);
  });

  it('cleans codes: case, whitespace, duplicates and malformed entries', () => {
    const u = buildScanUniverse({ staticList: [' thyao ', 'THYAO', 'AVOD T', '', null, 'A1CAP'], listedSymbols: ['garan'] });
    expect(u.symbols).toEqual(['THYAO', 'A1CAP', 'GARAN']);
  });
});
