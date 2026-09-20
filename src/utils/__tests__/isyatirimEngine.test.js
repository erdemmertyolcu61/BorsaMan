import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// v31.43: the balance-sheet fetch used to start with the Vite dev-server rewrite
// `/api/isyatirim/...`, which exists only on localhost. The deployed PWA got a 404 there
// and the public CORS proxies behind it failed too (measured 2026-09-19: allorigins 408,
// codetabs fail), so the phone never received financials — while the same URL through our
// own `/api/proxy?url=` returned 147 rows.
vi.mock('../fetchEngine.js', () => ({ getDataViaProxies: vi.fn() }));

const { getDataViaProxies } = await import('../fetchEngine.js');
const { planIsyRoutes, buildPeriodPlan, fetchIsYatirimFinancials } = await import('../isyatirimEngine.js');

const row = (desc, v) => ({ itemDescTr: desc, itemValue1: v, itemValue2: v * 0.9, itemValue3: v * 0.8, itemValue4: v * 0.7 });
// Real İş Yatırım labels (XI_29): equity is plain "Özkaynaklar" and there is no
// "Toplam Yükümlülükler" row — short and long term are listed separately.
const MALI_TABLO = JSON.stringify({
  value: [
    row('Hasılat', 1000), row('Brüt Kar (Zarar)', 300), row('Dönem Karı (Zararı)', 120),
    row('Toplam Varlıklar', 5000), row('Dönen Varlıklar', 2000),
    row('Kısa Vadeli Yükümlülükler', 1200), row('Uzun Vadeli Yükümlülükler', 1300),
    row('Özkaynaklar', 2500),
  ],
});

describe('planIsyRoutes — which routes an İş Yatırım financials fetch tries', () => {
  it('uses the Vite dev route only on a local dev server', () => {
    expect(planIsyRoutes({ localDev: true })).toEqual(['vite', 'proxies']);
    expect(planIsyRoutes({})).toEqual(['proxies']);
  });

  it('prefers the Electron bridge when the desktop app provides one', () => {
    expect(planIsyRoutes({ electron: true })).toEqual(['electron', 'proxies']);
    expect(planIsyRoutes({ localDev: true, electron: true })).toEqual(['vite', 'electron', 'proxies']);
  });

  it('always ends with the proxy chain — own proxy first, same origin on the PWA', () => {
    for (const env of [{}, { localDev: true }, { electron: true }]) {
      expect(planIsyRoutes(env).at(-1)).toBe('proxies');
    }
  });
});

// v31.44: the four requested periods used to be four CONSECUTIVE quarters, and
// İş Yatırım reports CUMULATIVE figures — so "previous period" was a 3-month
// cumulative sitting next to a 6-month one. Growth was ~+100% by construction
// (measured on THYAO: +126.8%) and profit could not be annualised (ROE read
// 1.8% where the trailing-twelve-month figure is 13.1%).
describe('buildPeriodPlan', () => {
  it('pairs the current period with the SAME period a year earlier', () => {
    const plan = buildPeriodPlan(2026, 6);
    expect(plan.periods).toEqual([
      { year: 2026, period: 6 }, { year: 2025, period: 6 },
      { year: 2025, period: 12 }, { year: 2024, period: 12 },
    ]);
    expect(plan).toMatchObject({ current: '2026/6', prevYearSame: '2025/6', lastFY: '2025/12', isFullYear: false });
  });

  it('uses four year-ends when the newest statement is already a full year', () => {
    const plan = buildPeriodPlan(2025, 12);
    expect(plan.periods.map(p => p.period)).toEqual([12, 12, 12, 12]);
    expect(plan.periods.map(p => p.year)).toEqual([2025, 2024, 2023, 2022]);
    expect(plan.isFullYear).toBe(true);
  });
});

describe('fetchIsYatirimFinancials', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(getDataViaProxies).mockReset();
    // fixed clock: the period plan (and therefore the TTM arithmetic below)
    // depends on which statement is the newest one
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T09:00:00Z'));   // newest sheet = 2026/6
    // the dev route is tried first under jsdom (hostname "localhost") and must not be fatal
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => 'not found' })));
  });

  afterEach(() => { vi.useRealTimers(); });

  it('falls through to the proxy chain and parses the İş Yatırım payload', async () => {
    vi.mocked(getDataViaProxies).mockResolvedValue(MALI_TABLO);
    const fin = await fetchIsYatirimFinancials('THYAO');
    expect(getDataViaProxies).toHaveBeenCalled();
    const url = vi.mocked(getDataViaProxies).mock.calls[0][0];
    expect(url).toContain('isyatirim.com.tr');
    expect(url).toContain('MaliTablo?companyCode=THYAO');
    expect(fin?.symbol).toBe('THYAO');
    expect(Object.keys(fin.metrics).length).toBeGreaterThanOrEqual(3);
  });

  // v31.43: equity never mapped (the sheet says "Özkaynaklar", the table expected
  // "Toplam Özkaynaklar") and no total-liabilities row exists, so the panel showed
  // N/A for ROE and debt/equity on every real statement.
  it('maps plain "Özkaynaklar" and derives total liabilities from the two terms', async () => {
    vi.mocked(getDataViaProxies).mockResolvedValue(MALI_TABLO);
    const fin = await fetchIsYatirimFinancials('THYAO');
    expect(fin.latest.totalEquity).toBe(2500);
    expect(fin.derivedTotalLiabilities).toBe(true);
    expect(fin.latest.totalLiabilities).toBe(2500);          // 1200 + 1300
    expect(fin.ratios.roePeriod).toBeCloseTo(120 / 2500 * 100, 6); // was null before
    expect(fin.ratios.debtToEquity).toBeCloseTo(1, 6);
  });

  // TTM = last full year − same period last year + this period. The fixture's
  // columns are [2026/6, 2025/6, 2025/12, 2024/12] = [120, 108, 96, 84] for net
  // income, so trailing profit is 96 − 108 + 120 = 108.
  it('annualises profit and compares growth year-over-year', async () => {
    vi.mocked(getDataViaProxies).mockResolvedValue(MALI_TABLO);
    const fin = await fetchIsYatirimFinancials('THYAO');
    expect(fin.latest.period).toBe('2026/6');
    expect(fin.ttm.netIncome).toBeCloseTo(108, 6);
    expect(fin.ttm.revenue).toBeCloseTo(900, 6);          // 800 − 900 + 1000
    expect(fin.ratios.roeIsTtm).toBe(true);
    expect(fin.ratios.roe).toBeCloseTo(108 / 2500 * 100, 6);
    expect(fin.ratios.revenueGrowth).toBeCloseTo((1000 - 900) / 900 * 100, 6);  // was ~+11%, not a 6M-vs-3M artifact
  });

  it('returns null — never a half-parsed object — when every route fails', async () => {
    vi.mocked(getDataViaProxies).mockResolvedValue(null);
    expect(await fetchIsYatirimFinancials('GARAN')).toBeNull();
  });

  it('ignores a body that is not MaliTablo JSON (proxy error page)', async () => {
    vi.mocked(getDataViaProxies).mockResolvedValue('<!DOCTYPE html><html>error</html>');
    expect(await fetchIsYatirimFinancials('AKBNK')).toBeNull();
  });
});
