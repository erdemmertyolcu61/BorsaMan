/**
 * Hisse detayı — 16 çeyreklik mali tablo (v31.50). Rakamlar THYAO'nun gerçek
 * İş Yatırım XI_29 yanıtından (2026-11-09, milyon TL'ye yuvarlanmış):
 * 3H net faaliyet kârı ve 4B amortisman kümülatif.
 */
import { describe, it, expect } from 'vitest';
import {
  latestQuarterEnd, quarterEndsBack, quarterName, parseIsyNumber, mergeMaliTablo,
  availableLabels, detectStatementKind, isFlowCode, singleQuarter, trailingFour,
  buildFinancialView, computeValuation, buildMaliTabloUrl,
} from '../financialStatements.js';

const M = 1e6;
const LABELS = ['2026/9', '2026/6', '2026/3', '2025/12', '2025/9', '2025/6', '2025/3', '2024/12'];

// Kümülatif (gelir/nakit) ve stok (bilanço) değerleri, LABELS sırasıyla, milyon TL.
const SERIES = {
  '3C':  ['Satış Gelirleri', [981030, 585069, 257961, 1187816, 880000, 520000, 230000, 1000000]],
  '3D':  ['BRÜT KAR (ZARAR)', [110381, 42587, 21568, 193388, 150000, 60000, 20000, 170000]],
  '3DF': ['FAALİYET KARI (ZARARI)', [39026, -5098, -2451, 112046, 80000, 10000, -3000, 95000]],
  '3H':  ['Net Faaliyet Kar/Zararı', [20556, -14734, -7097, 78985, 60000, 2000, -8000, 70000]],
  '3L':  ['DÖNEM KARI (ZARARI)', [80228, 18766, 9856, 146840, 90000, 30000, 8000, 120000]],
  '3Z':  ['Ana Ortaklık Payları', [80330, 18864, 9915, 146953, 90100, 30100, 8100, 120100]],
  '4B':  ['Amortisman Giderleri', [92559, 58665, 28358, 117706, 85000, 55000, 27000, 100000]],
  '4C':  [' İşletme Faaliyetlerinden Kaynaklanan Net Nakit', [138336, 74326, 43336, 230998, 160000, 90000, 40000, 200000]],
  '4CAI': ['  Sabit Sermaye Yatırımları', [-82038, -43613, -20125, -95496, -70000, -40000, -20000, -90000]],
  '4CB': ['Serbest Nakit Akım', [24314, 13887, -2921, 51149, 30000, 20000, 5000, 40000]],
  '4CBB': ['Temettü Ödemeleri', [-11128, -11128, 0, 0, 0, 0, 0, 0]],   // 2Ç26'da ödendi
  '4BE': ['Net Yabancı Para Pozisyonu', [-355567, -299075, -258931, -345161, -300000, -280000, -250000, -240000]],
  '1BL': ['TOPLAM VARLIKLAR', [2583379, 2360037, 2158033, 2482298, 2200000, 2100000, 2000000, 1900000]],
  '1A':  ['Dönen Varlıklar', [559178, 512191, 485646, 542535, 500000, 480000, 470000, 460000]],
  '1AA': ['  Nakit ve Nakit Benzerleri', [85290, 80346, 71141, 106956, 90000, 85000, 80000, 75000]],
  '1AB': ['  Finansal Yatırımlar', [229277, 213510, 212420, 227167, 200000, 190000, 180000, 170000]],
  '2A':  ['Kısa Vadeli Yükümlülükler', [578404, 566751, 498369, 549577, 500000, 490000, 480000, 470000]],
  '2AA': ['  Finansal Borçlar', [198276, 187257, 166590, 201936, 180000, 170000, 160000, 150000]],
  '2B':  ['Uzun Vadeli Yükümlülükler', [869926, 774833, 693301, 799873, 700000, 690000, 680000, 670000]],
  '2BA': ['  Finansal Borçlar', [813564, 726977, 647365, 748162, 700000, 690000, 680000, 670000]],
  '2N':  ['Özkaynaklar', [1135049, 1018453, 966363, 1132848, 1000000, 950000, 900000, 850000]],
  '2O':  ['  Ana Ortaklığa Ait Özkaynaklar', [1135117, 1018517, 966388, 1132806, 1000000, 950000, 900000, 850000]],
  '2OA': ['  Ödenmiş Sermaye', [1380, 1380, 1380, 1380, 1380, 1380, 1380, 1380]],
};

function chunkFor(labels) {
  return {
    labels,
    rows: Object.entries(SERIES).map(([code, [tr, vals]]) => {
      const row = { itemCode: code, itemDescTr: tr, itemDescEng: code };
      labels.forEach((l, i) => { row['value' + (i + 1)] = String(vals[LABELS.indexOf(l)] * M); });
      return row;
    }),
  };
}

const MERGED = mergeMaliTablo([chunkFor(LABELS.slice(0, 4)), chunkFor(LABELS.slice(4, 8))]);

describe('dönemler', () => {
  it('bugünden önce biten son çeyrek ve geriye doğru liste', () => {
    expect(latestQuarterEnd(new Date('2026-11-09T10:00:00'))).toEqual({ y: 2026, p: 9 });
    expect(latestQuarterEnd(new Date('2026-02-01T10:00:00'))).toEqual({ y: 2025, p: 12 });
    expect(quarterEndsBack(2026, 3, 3)).toEqual([{ y: 2026, p: 3 }, { y: 2025, p: 12 }, { y: 2025, p: 9 }]);
    expect(quarterName('2026/9')).toBe('3Ç26');
    expect(quarterName('2025/12')).toBe('4Ç25');
  });

  it('URL dört dönemi taşır', () => {
    const u = buildMaliTabloUrl('THYAO', 'XI_29', [{ y: 2026, p: 9 }, { y: 2026, p: 6 }]);
    expect(u).toContain('companyCode=THYAO');
    expect(u).toContain('financialGroup=XI_29');
    expect(u).toContain('&year1=2026&period1=9&year2=2026&period2=6');
  });
});

describe('birleştirme', () => {
  it('sayı biçimleri; boş hücre null', () => {
    expect(parseIsyNumber('981030000000')).toBe(981030000000);
    expect(parseIsyNumber('-0')).toBe(-0);
    expect(parseIsyNumber(null)).toBeNull();
    expect(parseIsyNumber('')).toBeNull();
    expect(parseIsyNumber('abc')).toBeNull();
  });

  it('dört isteği satır koduna göre tek tabloda toplar, girintiyi korur', () => {
    expect(MERGED.labels).toEqual(LABELS);
    const rev = MERGED.rows.find(r => r.code === '3C');
    expect(rev.values['2026/9']).toBe(981030 * M);
    expect(rev.values['2024/12']).toBe(1000000 * M);
    expect(MERGED.rows.find(r => r.code === '1AA').depth).toBe(1);
    expect(MERGED.rows.find(r => r.code === '1AA').tr).toBe('Nakit ve Nakit Benzerleri');
  });

  it('açıklanmamış dönem (tüm hücreler null) listeden düşer', () => {
    const c = chunkFor(['2026/9', '2026/6']);
    c.rows.forEach(r => { r.value1 = null; });
    const m = mergeMaliTablo([c]);
    expect(availableLabels(m.rows, m.labels)).toEqual(['2026/6']);
  });

  it('tablo türü', () => {
    expect(detectStatementKind(MERGED.rows)).toBe('industrial');
    expect(detectStatementKind([{ code: '3C', tr: 'III. NET FAİZ GELİRİ/GİDERİ (I - II)' }])).toBe('bank');
    expect(detectStatementKind([{ code: '3K', tr: 'J- Genel Teknik Bölüm Dengesi' }])).toBe('insurance');
    expect(isFlowCode('3C', 'industrial')).toBe(true);
    expect(isFlowCode('4C', 'industrial')).toBe(true);
    expect(isFlowCode('4BE', 'industrial')).toBe(false);   // döviz pozisyonu stok
    expect(isFlowCode('1BL', 'industrial')).toBe(false);
  });
});

describe('çeyreklik türetme', () => {
  it('Ç1 kendisi, diğerleri bir önceki kümülatiften fark; eksikse null', () => {
    const v = { '2026/3': 100, '2026/6': 250, '2026/9': 450 };
    expect(singleQuarter(v, '2026/3')).toBe(100);
    expect(singleQuarter(v, '2026/6')).toBe(150);
    expect(singleQuarter(v, '2026/9')).toBe(200);
    expect(singleQuarter({ '2026/9': 450 }, '2026/9')).toBeNull();
    expect(trailingFour({ a: 1 }, '2026/9')).toBeNull();
  });

  const view = buildFinancialView(MERGED);

  it('THYAO 3Ç26: hasılat 395,96 mr, FAVÖK = net faaliyet kârı + amortisman = 69,18 mr', () => {
    const q = view.quarters[0];
    expect(view.kind).toBe('industrial');
    expect(q.label).toBe('2026/9');
    expect(q.revenue).toBe((981030 - 585069) * M);
    expect(q.ebitda).toBe(((20556 - -14734) + (92559 - 58665)) * M);   // 35.290 + 33.894
    expect(q.ebitdaMargin).toBeCloseTo((69184 / 395961) * 100, 6);
    expect(q.parentNet).toBe((80330 - 18864) * M);
  });

  it('yıllık büyüme aynı çeyreğin bir yıl öncesiyle', () => {
    const q = view.quarters[0];
    const prevQ3 = (880000 - 520000) * M;
    expect(q.revenueYoY).toBeCloseTo(((395961 * M - prevQ3) / prevQ3) * 100, 6);
  });

  it('12A = son dört tek çeyrek; döviz pozisyonu farklanmaz', () => {
    // 3Ç26 + 2Ç26 + 1Ç26 + 4Ç25 = 9A26 + (12A25 − 9A25)
    expect(view.ttm.revenue).toBe((981030 + (1187816 - 880000)) * M);
    expect(view.ttm.parentNet).toBe((80330 + (146953 - 90100)) * M);
    expect(view.balance[0].netFxPosition).toBe(-355567 * M);
  });

  it('yıl sonları yıllık tabloda, FAVÖK yıllık kümülatiften', () => {
    const fy25 = view.annual.find(a => a.year === 2025);
    expect(fy25.revenue).toBe(1187816 * M);
    expect(fy25.ebitda).toBe((78985 + 117706) * M);
  });

  it('bilanço: net borç = finansal borç − nakit − kısa vadeli finansal yatırım', () => {
    const b = view.balance[0];
    expect(b.netDebt).toBe((198276 + 813564 - 85290 - 229277) * M);
    expect(b.currentRatio).toBeCloseTo(559178 / 578404, 9);
    expect(b.roe).toBeCloseTo((view.ttm.parentNet / (1135117 * M)) * 100, 9);
  });

  it('değerleme: pay adedi ödenmiş sermaye; F/K, PD/DD, FD/FAVÖK', () => {
    const val = computeValuation(view, 300);
    const mcap = 300 * 1380 * M;
    expect(val.mcap).toBe(mcap);
    expect(val.pe).toBeCloseTo(mcap / view.ttm.parentNet, 9);
    expect(val.pb).toBeCloseTo(mcap / (1135117 * M), 9);
    expect(val.evEbitda).toBeCloseTo((mcap + view.balance[0].netDebt) / view.ttm.ebitda, 9);
    expect(val.dividendYield).toBeCloseTo((11128 * M / mcap) * 100, 9);
  });

  it('zarar eden şirkette F/K yok, "zarar" bayrağı var', () => {
    const lossy = mergeMaliTablo([chunkFor(LABELS.slice(0, 4)), chunkFor(LABELS.slice(4, 8))]);
    lossy.rows.find(r => r.code === '3Z').values = Object.fromEntries(LABELS.map(l => [l, -5 * M]));
    const val = computeValuation(buildFinancialView(lossy), 300);
    expect(val.pe).toBeNull();
    expect(val.peLoss).toBe(true);
  });

  it('dönem yoksa boş görünüm, değerleme null', () => {
    const empty = buildFinancialView({ rows: [], labels: [] });
    expect(empty.quarters).toEqual([]);
    expect(computeValuation(empty, 100)).toBeNull();
  });
});

describe('banka', () => {
  it('grubun kârı varsa ana ortaklık payı olarak o kullanılır; FAVÖK yok', () => {
    const labels = ['2026/6', '2026/3', '2025/12', '2025/9', '2025/6'];
    const vals = (arr) => Object.fromEntries(labels.map((l, i) => [l, arr[i] * M]));
    const rows = [
      { code: '1Z', tr: 'AKTİF TOPLAMI', values: vals([4000, 3900, 3800, 3700, 3600]) },
      { code: '1AF', tr: 'VI. KREDİLER', values: vals([2000, 1900, 1800, 1700, 1600]) },
      { code: '2A', tr: 'I. MEVDUAT', values: vals([2500, 2400, 2300, 2200, 2100]) },
      { code: '2O', tr: 'XVI. ÖZKAYNAKLAR', values: vals([500, 480, 460, 440, 420]) },
      { code: '2OA', tr: '16.1 Ödenmiş Sermaye', values: vals([5, 5, 5, 5, 5]) },
      { code: '3C', tr: 'III. NET FAİZ GELİRİ/GİDERİ (I - II)', values: vals([120, 55, 200, 140, 90]) },
      { code: '3Z', tr: 'XXIII. NET DÖNEM KARI/ZARARI', values: vals([60, 28, 110, 80, 50]) },
      { code: '3ZA', tr: '23.1 Grubun Karı/Zararı', values: vals([61, 29, 111, 81, 51]) },
      { code: 'X1', tr: 'dolgu', values: vals([1, 1, 1, 1, 1]) },
    ];
    const view = buildFinancialView({ rows, labels });
    expect(view.kind).toBe('bank');
    expect(view.quarters[0].parentNet).toBe((61 - 29) * M);
    expect(view.quarters[0].netInterestIncome).toBe((120 - 55) * M);
    expect(view.quarters[0].ebitda).toBeUndefined();
    expect(view.balance[0].loanToDeposit).toBeCloseTo(80, 9);
    const val = computeValuation(view, 100);
    expect(val.evEbitda).toBeUndefined();
    expect(val.pb).toBeCloseTo((100 * 5 * M) / (500 * M), 9);
  });
});

describe('v31.51: kiralama/faktoring (XI_29K) ve katılım bankası', () => {
  const labels = ['2026/6', '2026/3', '2025/12', '2025/9', '2025/6'];
  const vals = (arr) => Object.fromEntries(labels.map((l, i) => [l, arr[i] * M]));

  it('XI_29K: A-kodlu gelir satırları akım, ana ortaklık kârı 3Z', () => {
    const rows = [
      { code: 'A1AK', tr: 'AKTİF TOPLAMI', values: vals([136, 124, 120, 110, 100]) },
      { code: '2N', tr: 'Özkaynaklar', values: vals([16, 15, 14, 13, 12]) },
      { code: '2O', tr: 'Ana Ortaklığa Ait Özkaynaklar', values: vals([14.6, 13.9, 13, 12, 11]) },
      { code: '2OA', tr: '13.1 Ödenmiş Sermaye', values: vals([0.7, 0.7, 0.7, 0.7, 0.7]) },
      { code: 'A3A', tr: 'I. ESAS FAALİYET GELİRLERİ', values: vals([18.7, 11.6, 30, 20, 12]) },
      { code: 'A3AH', tr: 'VII. NET FAALİYET K/Z (I+…+VI)', values: vals([4.4, 2.7, 7, 5, 3]) },
      { code: '3Z', tr: 'NET DÖNEM KARI (ZARARI)', values: vals([3.1, 2.06, 6, 4, 2.5]) },
    ];
    expect(detectStatementKind(rows)).toBe('finance');
    expect(isFlowCode('A3A', 'finance')).toBe(true);
    expect(isFlowCode('A1AK', 'finance')).toBe(false);
    const view = buildFinancialView({ rows, labels });
    expect(view.quarters[0].mainOpIncome).toBeCloseTo((18.7 - 11.6) * M, 3);
    expect(view.quarters[0].parentNet).toBeCloseTo((3.1 - 2.06) * M, 3);
    expect(view.balance[0].totalAssets).toBe(136 * M);   // stok, farklanmaz
    expect(computeValuation(view, 20).pb).toBeCloseTo((20 * 0.7 * M) / (14.6 * M), 9);
  });

  it('katılım bankası: "kâr payı" şablonu tanınır, yalnız güvenli satırlar eşlenir', () => {
    const rows = [
      { code: '1Z', tr: 'AKTİF TOPLAMI', values: vals([589, 541, 500, 480, 460]) },
      { code: '2A', tr: 'I. TOPLANAN FONLAR', values: vals([392, 330, 320, 300, 290]) },
      { code: '2O', tr: 'ÖZKAYNAK', values: vals([33.8, 32.2, 31, 30, 29]) },
      { code: '3A', tr: 'I. KAR PAYI GELİRLERİ', values: vals([69.1, 43.6, 80, 55, 35]) },
      { code: '3Z', tr: 'XVIII. NET DÖNEM KARI/ZARARI', values: vals([5.78, 3.96, 9, 6, 4]) },
      { code: '3ZA', tr: '23.1 Grubun Karı/Zararı', values: vals([5.78, 3.96, 9, 6, 4]) },
    ];
    expect(detectStatementKind(rows)).toBe('participation');
    const view = buildFinancialView({ rows, labels });
    expect(view.quarters[0].interestIncome).toBeCloseTo((69.1 - 43.6) * M, 3);
    expect(view.quarters[0].parentNet).toBeCloseTo((5.78 - 3.96) * M, 3);
    expect(computeValuation(view, 10)).toBeNull();          // pay adedi yok → İş Yatırım değerleri gösterilir
  });
});
