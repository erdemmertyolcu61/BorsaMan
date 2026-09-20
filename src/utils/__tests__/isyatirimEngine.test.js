import { describe, it, expect, vi, beforeEach } from 'vitest';

// v31.43: the balance-sheet fetch used to start with the Vite dev-server rewrite
// `/api/isyatirim/...`, which exists only on localhost. The deployed PWA got a 404 there
// and the public CORS proxies behind it failed too (measured 2026-09-19: allorigins 408,
// codetabs fail), so the phone never received financials — while the same URL through our
// own `/api/proxy?url=` returned 147 rows.
vi.mock('../fetchEngine.js', () => ({ getDataViaProxies: vi.fn() }));

const { getDataViaProxies } = await import('../fetchEngine.js');
const { planIsyRoutes, fetchIsYatirimFinancials } = await import('../isyatirimEngine.js');

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

describe('fetchIsYatirimFinancials', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(getDataViaProxies).mockReset();
    // the dev route is tried first under jsdom (hostname "localhost") and must not be fatal
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => 'not found' })));
  });

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
    expect(fin.ratios.roe).toBeCloseTo(120 / 2500 * 100, 6); // was null before
    expect(fin.ratios.debtToEquity).toBeCloseTo(1, 6);
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
