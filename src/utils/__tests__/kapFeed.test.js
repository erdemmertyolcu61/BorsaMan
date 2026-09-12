import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeTr, parseKapDate, formatKapRequestDate, kapDateRange, splitStockCodes,
  classifyKapItem, normalizeKapItems, buildKapIndex, attachKapFields, isKapBuyBlocked,
  learnKapOids, resolveKapOid, KAP_OID_LEARNED_KEY, _resetKapFeedCache,
} from '../kapFeed.js';

// Raw KAP row, shaped exactly like POST /tr/api/disclosure/list/main returns it.
const raw = (o = {}) => ({
  disclosureBasic: {
    disclosureIndex: 1000, stockCode: null, relatedStocks: null, title: '', summary: '',
    disclosureClass: 'ODA', publishDate: '12.09.2026 11:32:32', companyTitle: 'ORNEK A.Ş.',
    mkkMemberOid: null, ...o,
  },
});

const DAY = 24 * 60 * 60 * 1000;

describe('kapFeed — dates and codes', () => {
  it('parses KAP publish dates as Istanbul time (UTC+3)', () => {
    expect(parseKapDate('12.09.2026 11:32:32')).toBe(Date.UTC(2026, 8, 12, 8, 32, 32));
    expect(parseKapDate('12.09.2026')).toBe(Date.UTC(2026, 8, 11, 21, 0, 0));
    expect(parseKapDate('2026-09-12')).toBeNull();
    expect(parseKapDate(null)).toBeNull();
  });

  it('formats request dates on the Istanbul calendar day', () => {
    // 22:30 UTC is already 01:30 the next day in Istanbul.
    expect(formatKapRequestDate(Date.UTC(2026, 8, 12, 22, 30))).toBe('13.09.2026');
    const now = Date.UTC(2026, 8, 12, 9, 0);
    expect(kapDateRange(3, now)).toEqual({ fromDate: '09.09.2026', toDate: '12.09.2026' });
  });

  it('splits multi-code stock fields and drops non-tickers', () => {
    expect(splitStockCodes('OYA, OYYAT')).toEqual(['OYA', 'OYYAT']);
    expect(splitStockCodes('mrgyo, yksln')).toEqual(['MRGYO', 'YKSLN']);
    expect(splitStockCodes('A.Ş.')).toEqual([]);
    expect(splitStockCodes(null)).toEqual([]);
    expect(splitStockCodes('THYAO, THYAO')).toEqual(['THYAO']);
  });

  it('normalizes Turkish text for ASCII rules', () => {
    expect(normalizeTr('  Özel  Durum Açıklaması ')).toBe('ozel durum aciklamasi');
    expect(normalizeTr('BORSA İSTANBUL')).toBe('borsa istanbul');
  });
});

describe('kapFeed — classifyKapItem (rules measured on 14 days of real titles)', () => {
  it('flags a volatility-based trading measure on the stock as RISK', () => {
    const c = classifyKapItem({
      company: 'BORSA İSTANBUL A.Ş.', klass: 'DUY',
      title: 'BISTECH Pay Piyasası Alım Satım Sistemi Duyurusu',
      summary: 'Pay Piyasasında Volatilite Bazlı Tedbir Sistemi',
    });
    expect(c).toMatchObject({ kind: 'risk', type: 'trading_measure' });
  });

  it('does NOT flag other BISTECH announcements (block trades, rights)', () => {
    const c = classifyKapItem({
      company: 'BORSA İSTANBUL A.Ş.', klass: 'DUY',
      title: 'BISTECH Pay Piyasası Alım Satım Sistemi Duyurusu', summary: 'Toptan Alış Satış İşlemi',
    });
    expect(c.kind).not.toBe('risk');
  });

  it('flags an investor-based measure announced by the exchange as RISK', () => {
    const c = classifyKapItem({
      company: 'BORSA İSTANBUL A.Ş.', klass: 'DUY',
      title: 'Borsa İstanbul A.Ş. Duyurusu', summary: 'Yatırımcı Bazında Tedbir Uygulanması',
    });
    expect(c).toMatchObject({ kind: 'risk', type: 'trading_measure', label: 'Yatırımcı bazında tedbir' });
  });

  it('keeps the SPK investor-ban notice as CAUTION — one notice lists 68 blue chips', () => {
    // Measured 14.08.2026: this MKK notice named THYAO, AKBNK, GARAN and 65 others.
    // A hard filter here would silently remove the largest stocks for a week.
    const c = classifyKapItem({
      company: 'MERKEZİ KAYIT KURULUŞU A.Ş.', klass: 'DUY',
      title: 'SPK İşlem Yasağı Nedeniyle Pay Duyurusu', summary: 'SPK İşlem Yasağı Nedeniyle Pay Duyurusu',
    });
    expect(c).toMatchObject({ kind: 'caution', type: 'investor_ban_notice' });
  });

  it('separates a trading halt (RISK) from the reopening (CAUTION)', () => {
    const base = { company: 'BORSA İSTANBUL A.Ş.', klass: 'DUY', title: 'Pay İşlem Sırası Kapatma / Açma' };
    expect(classifyKapItem({ ...base, summary: 'Pay Sırasının İşleme Kapatılması' })).toMatchObject({ kind: 'risk', type: 'trading_halt' });
    expect(classifyKapItem({ ...base, summary: 'Pay Sırasının İşleme Açılması' })).toMatchObject({ kind: 'caution', type: 'halt_reopen' });
  });

  it('flags a missed coupon/redemption payment as RISK', () => {
    const c = classifyKapItem({
      company: 'MERKEZİ KAYIT KURULUŞU A.Ş.', klass: 'DUY',
      title: 'Merkezi Kayıt Kuruluşu A.Ş. Duyurusu', summary: 'Gerçekleşmeyen İtfa/Kupon/Getiri Ödemesi',
    });
    expect(c).toMatchObject({ kind: 'risk', type: 'payment_default' });
  });

  it('flags konkordato only in the company\'s own material-event disclosure', () => {
    expect(classifyKapItem({ klass: 'ODA', title: 'Özel Durum Açıklaması (Genel)', summary: 'Konkordato talebi hakkında' }))
      .toMatchObject({ kind: 'risk', type: 'insolvency' });
    expect(classifyKapItem({ klass: 'DUY', title: 'SPK Bülteni', summary: 'konkordato sureci' }).kind).not.toBe('risk');
  });

  it('shows a circuit breaker as CAUTION, not a filter (it fires on up-moves too)', () => {
    expect(classifyKapItem({ company: 'BORSA İSTANBUL A.Ş.', klass: 'DUY', title: 'Pay Bazında Devre Kesici Bildirimi', summary: 'OTTO.E işlem sırasında devre kesici' }))
      .toMatchObject({ kind: 'caution', type: 'circuit_breaker' });
  });

  it('treats bond issuance and fund-use reports as NOISE, not capital events', () => {
    expect(classifyKapItem({ klass: 'ODA', title: 'Pay Dışında Sermaye Piyasası Aracı İşlemlerine İlişkin Bildirim (Faiz İçeren)' }).kind).toBe('noise');
    expect(classifyKapItem({ klass: 'DG', title: 'Sermaye Artırımından Elde Edilecek - Edilen Fonun Kullanımına İlişkin Rapor' }).kind).toBe('noise');
    expect(classifyKapItem({ klass: 'DG', title: 'Şirket Genel Bilgi Formu' }).kind).toBe('noise');
  });

  it('classifies company events without claiming a direction', () => {
    const t = (title, extra = {}) => classifyKapItem({ klass: 'ODA', title, ...extra }).type;
    expect(t('Payların Geri Alınmasına İlişkin Bildirim')).toBe('buyback');
    expect(t('Pay Alım Satım Bildirimi')).toBe('insider_trade');
    expect(t('Yeni İş İlişkisi')).toBe('new_business');
    expect(t('Kar Payı Dağıtım İşlemlerine İlişkin Bildirim')).toBe('dividend');
    expect(t('Sermaye Artırımı - Azaltımı İşlemlerine İlişkin Bildirim', { summary: 'Bedelsiz sermaye artırımı' })).toBe('bonus_issue');
    expect(t('Sermaye Artırımı - Azaltımı İşlemlerine İlişkin Bildirim', { summary: 'Bedelli' })).toBe('capital_increase');
    expect(classifyKapItem({ klass: 'FR', title: 'Finansal Rapor' }).type).toBe('earnings');
    expect(classifyKapItem({ klass: 'DUY', title: 'Endeks Şirketlerinde Değişiklik' }).kind).toBe('event');
    expect(classifyKapItem({ klass: 'ODA', title: 'Özel Durum Açıklaması (Genel)', summary: 'Yeni fabrika' })).toMatchObject({ kind: 'info', type: 'material_event' });
  });
});

describe('kapFeed — normalizeKapItems', () => {
  it('accepts the raw KAP shape and the proxy\'s slim shape identically', () => {
    const fromRaw = normalizeKapItems([raw({ disclosureIndex: 7, stockCode: 'THYAO', title: 'Yeni İş İlişkisi', summary: 'x', mkkMemberOid: 'a'.repeat(32) })]);
    const fromSlim = normalizeKapItems({ items: [{ i: 7, c: 'THYAO', t: 'Yeni İş İlişkisi', s: 'x', k: 'ODA', d: '12.09.2026 11:32:32', m: 'ORNEK A.Ş.', o: 'a'.repeat(32) }] });
    expect(fromSlim).toEqual(fromRaw);
    expect(fromRaw[0]).toMatchObject({ id: 7, symbols: ['THYAO'], primary: ['THYAO'], url: 'https://www.kap.org.tr/tr/Bildirim/7' });
    expect(fromRaw[0].cls.type).toBe('new_business');
  });

  it('drops test disclosures and orders newest first', () => {
    const items = normalizeKapItems([
      raw({ disclosureIndex: 1, companyTitle: 'KAP TEST A.Ş.', title: 'Test Bildirimi' }),
      raw({ disclosureIndex: 2, title: 'Pay Bazında Devre Kesici Bildirimi', summary: 'Test bildirimi', companyTitle: 'BORSA İSTANBUL A.Ş.' }),
      raw({ disclosureIndex: 3, stockCode: 'AAA', title: 'Yeni İş İlişkisi', publishDate: '10.09.2026 10:00:00' }),
      raw({ disclosureIndex: 4, stockCode: 'BBB', title: 'Yeni İş İlişkisi', publishDate: '11.09.2026 10:00:00' }),
    ]);
    expect(items.map(i => i.id)).toEqual([4, 3]);
  });

  it('maps exchange announcements to the stocks in relatedStocks', () => {
    const [it0] = normalizeKapItems([raw({ stockCode: null, relatedStocks: 'MRGYO, YKSLN', companyTitle: 'BORSA İSTANBUL A.Ş.', klass: 'DUY', title: 'BISTECH Pay Piyasası Alım Satım Sistemi Duyurusu', summary: 'Pay Piyasasında Volatilite Bazlı Tedbir Sistemi', disclosureClass: 'DUY' })]);
    expect(it0.symbols).toEqual(['MRGYO', 'YKSLN']);
    expect(it0.subjects).toEqual(['MRGYO', 'YKSLN']);
    expect(it0.primary).toEqual([]);
    expect(it0.cls.kind).toBe('risk');
  });

  it('indexes a company disclosure under the company, not under its relatedStocks', () => {
    // Measured: a portfolio manager's "Pay Alım Satım Bildirimi" listed 29 holdings.
    // Counting it as an event for all 29 would pollute the measurement.
    const items = normalizeKapItems([raw({ stockCode: 'PA1', relatedStocks: 'ECILC, IZMDC, ODINE', title: 'Pay Alım Satım Bildirimi' })]);
    expect(items[0].subjects).toEqual(['PA1']);
    expect(items[0].symbols).toEqual(['PA1', 'ECILC', 'IZMDC', 'ODINE']);
    const idx = buildKapIndex(items, { now: parseKapDate('12.09.2026 12:00:00') });
    expect(idx.bySymbol.ECILC).toBeUndefined();
    expect(idx.bySymbol.PA1.events).toEqual(['insider_trade']);
  });

  it('skips rows without a usable id or date', () => {
    expect(normalizeKapItems([raw({ disclosureIndex: 'x' }), raw({ publishDate: 'bad' }), null, 5])).toEqual([]);
  });
});

describe('kapFeed — buildKapIndex / attachKapFields', () => {
  const now = Date.UTC(2026, 8, 12, 12, 0);
  const at = (daysAgo) => {
    const d = new Date(now - daysAgo * DAY + 3 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`;
  };

  const items = normalizeKapItems([
    raw({ disclosureIndex: 1, stockCode: 'AAA', title: 'Payların Geri Alınmasına İlişkin Bildirim', summary: 'geri alim', publishDate: at(1) }),
    raw({ disclosureIndex: 2, stockCode: 'AAA', title: 'Payların Geri Alınmasına İlişkin Bildirim', summary: 'ikinci', publishDate: at(0.5) }),
    raw({ disclosureIndex: 3, stockCode: 'AAA', title: 'Pay Dışında Sermaye Piyasası Aracı İşlemlerine İlişkin Bildirim (Faiz İçeren)', publishDate: at(0.2) }),
    raw({ disclosureIndex: 4, relatedStocks: 'BBB', companyTitle: 'BORSA İSTANBUL A.Ş.', disclosureClass: 'DUY', title: 'BISTECH Pay Piyasası Alım Satım Sistemi Duyurusu', summary: 'Pay Piyasasında Volatilite Bazlı Tedbir Sistemi', publishDate: at(2) }),
    raw({ disclosureIndex: 5, relatedStocks: 'CCC', companyTitle: 'BORSA İSTANBUL A.Ş.', disclosureClass: 'DUY', title: 'BISTECH Pay Piyasası Alım Satım Sistemi Duyurusu', summary: 'Pay Piyasasında Volatilite Bazlı Tedbir Sistemi', publishDate: at(10) }),
  ]);

  it('counts non-routine disclosures, dedupes event types, keeps the newest headline', () => {
    const idx = buildKapIndex(items, { now });
    expect(idx.noise).toBe(1);
    expect(idx.bySymbol.AAA).toMatchObject({ count: 2, events: ['buyback'], headline: 'ikinci' });
    expect(idx.bySymbol.AAA.risk).toBeNull();
  });

  it('only treats a trading measure as active risk inside the risk window', () => {
    const idx = buildKapIndex(items, { now, riskWindowDays: 7 });
    expect(idx.bySymbol.BBB.risk).toMatchObject({ type: 'trading_measure' });
    expect(idx.bySymbol.CCC?.risk ?? null).toBeNull();   // 10 days old
  });

  it('clears a trading halt once the order book reopened later (TRILC, 11.09.2026)', () => {
    const halt = (id, summary, hoursAgo) => raw({
      disclosureIndex: id, relatedStocks: 'TRILC', companyTitle: 'BORSA İSTANBUL A.Ş.', disclosureClass: 'DUY',
      title: 'Pay İşlem Sırası Kapatma / Açma', summary, publishDate: at(hoursAgo / 24),
    });
    const reopened = buildKapIndex(normalizeKapItems([halt(10, 'Pay Sırasının İşleme Kapatılması', 5), halt(11, 'Pay Sırasının İşleme Açılması', 3)]), { now });
    expect(reopened.bySymbol.TRILC.risk).toBeNull();
    expect(reopened.bySymbol.TRILC.cautions).toContain('halt_reopen');

    const stillHalted = buildKapIndex(normalizeKapItems([halt(12, 'Pay Sırasının İşleme Açılması', 5), halt(13, 'Pay Sırasının İşleme Kapatılması', 3)]), { now });
    expect(stillHalted.bySymbol.TRILC.risk).toMatchObject({ type: 'trading_halt' });
  });

  it('a reopening does not erase an unrelated older measure on the same stock', () => {
    const items = normalizeKapItems([
      raw({ disclosureIndex: 20, relatedStocks: 'XYZ', companyTitle: 'BORSA İSTANBUL A.Ş.', disclosureClass: 'DUY', title: 'BISTECH Pay Piyasası Alım Satım Sistemi Duyurusu', summary: 'Pay Piyasasında Volatilite Bazlı Tedbir Sistemi', publishDate: at(3) }),
      raw({ disclosureIndex: 21, relatedStocks: 'XYZ', companyTitle: 'BORSA İSTANBUL A.Ş.', disclosureClass: 'DUY', title: 'Pay İşlem Sırası Kapatma / Açma', summary: 'Pay Sırasının İşleme Kapatılması', publishDate: at(1) }),
      raw({ disclosureIndex: 22, relatedStocks: 'XYZ', companyTitle: 'BORSA İSTANBUL A.Ş.', disclosureClass: 'DUY', title: 'Pay İşlem Sırası Kapatma / Açma', summary: 'Pay Sırasının İşleme Açılması', publishDate: at(0.5) }),
    ]);
    expect(buildKapIndex(items, { now }).bySymbol.XYZ.risk).toMatchObject({ type: 'trading_measure' });
  });

  it('marks every row as checked so "no disclosure" is distinguishable from "no data"', () => {
    const idx = buildKapIndex(items, { now });
    const rows = [{ symbol: 'AAA' }, { symbol: 'BBB' }, { symbol: 'ZZZ' }];
    const tagged = attachKapFields(rows, idx);
    expect(tagged).toBe(2);
    expect(rows[0]).toMatchObject({ kapChecked: true, kapCount: 2, kapCategories: ['buyback'], kapRisk: null });
    expect(rows[1]).toMatchObject({ kapChecked: true, kapRisk: 'trading_measure' });
    expect(rows[2]).toMatchObject({ kapChecked: true, kapCount: 0, kapCategories: [] });
    expect(isKapBuyBlocked(rows[1])).toBe(true);
    expect(isKapBuyBlocked(rows[0])).toBe(false);
    expect(isKapBuyBlocked(null)).toBe(false);
  });

  it('is defensive with missing inputs', () => {
    expect(attachKapFields(null, {})).toBe(0);
    expect(attachKapFields([{ symbol: 'A' }], null)).toBe(0);
    expect(buildKapIndex(null).total).toBe(0);
  });
});

describe('kapFeed — OID resolution', () => {
  beforeEach(() => {
    try { localStorage.removeItem(KAP_OID_LEARNED_KEY); } catch { /* jsdom */ }
    _resetKapFeedCache();
  });

  it('resolves from the committed snapshot (generated from /tr/bist-sirketler)', async () => {
    // The old hard-coded table had a different id for THYAO — the reason the
    // per-company panel stayed empty. This is the id the live feed reports.
    expect(await resolveKapOid('thyao')).toBe('4028e4a140f2ed720140f376bebb01a7');
    expect(await resolveKapOid('NOPE1')).toBeNull();
  });

  it('prefers an OID learned from the live feed over the snapshot', async () => {
    const fresh = 'f'.repeat(32);
    const learned = learnKapOids(normalizeKapItems([raw({ stockCode: 'THYAO', title: 'Yeni İş İlişkisi', mkkMemberOid: fresh })]));
    expect(learned).toBe(1);
    expect(await resolveKapOid('THYAO')).toBe(fresh);
  });

  it('never learns from exchange announcements (no own stock code)', () => {
    const n = learnKapOids(normalizeKapItems([raw({ stockCode: null, relatedStocks: 'THYAO', companyTitle: 'BORSA İSTANBUL A.Ş.', title: 'Duyuru', mkkMemberOid: 'b'.repeat(32) })]));
    expect(n).toBe(0);
  });
});
