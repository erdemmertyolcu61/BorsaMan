/**
 * StockDetailTab — "Hisse detayı" (v31.50).
 *
 * Kullanıcı: "her hissenin teknik ve temel analizlerini, tüm değerlerini, FAVÖK'ü,
 * çeyrek kârlarını, her detayı görebileceğim bir sekme". İstihbarat, Gerçek
 * Portföy ve Piyasa Nabzı sekmelerinin yerini alır.
 *
 * Analiz sekmesi sade kalır (karar + plan); bu sekme her şeyi gösterir ama karar
 * VERMEZ — AL/SAT/TUT ve stop/hedef Analiz'de, tarama ile aynı yoldan.
 *
 * Veri: İş Yatırım MaliTablo 16 çeyrek (financialStatements.js — F/K ve PD/DD
 * İş Yatırım'ın kendi değerleriyle aynı bilançoda birebir ölçüldü), günlük barlar
 * (fetchData, canlı fiyat oturumuna göre birleşik), BIST 100 barları (göreli
 * getiri), İş Yatırım tarama (karşılaştırma ve yabancı payı).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchData, fetchSingle, fetchBigParaBatchPrices, istanbulDayKey } from '../../utils/fetchEngine.js';
import { calcAll } from '../../utils/indicators.js';
import { fetchFinancialHistory, buildFinancialView, computeValuation, quarterName } from '../../utils/financialStatements.js';
import { buildTechnicalSnapshot } from '../../utils/technicalSnapshot.js';
import { fetchSymbolValuation } from '../../utils/valuationRatios.js';
import { getSector } from '../../utils/sectorEngine.js';
import { QUICK_STOCKS } from '../../utils/constants.js';
import { useIsMobile } from '../../hooks/useIsMobile.js';
import { WatchlistPanel } from '../Portfolio/PortfolioExtras.jsx';
import QuarterChart from './QuarterChart.jsx';
import TechnicalPanel, { ReturnsTable } from './TechnicalPanel.jsx';
import { DataTable, FullStatement, Segmented, incomeRows, balanceRows, cashRows } from './FinancialTables.jsx';
import { fmtBig, fmtPct, fmtPrice, fmtX, signTone, DASH } from './fmt.js';

const SECTIONS = [
  { id: 'summary', label: 'Özet' },
  { id: 'quarters', label: 'Çeyrekler' },
  { id: 'balance', label: 'Bilanço' },
  { id: 'cash', label: 'Nakit akışı' },
  { id: 'technical', label: 'Teknik' },
  { id: 'all', label: 'Tüm kalemler' },
];

const GROUP_LABEL = {
  XI_29: 'UFRS · Seri XI No:29',
  XI_29K: 'Seri XI No:29 · konsolide (finans şirketi)',
  UFRS_K: 'UFRS · konsolide',
  UFRS: 'UFRS · solo',
};

const KIND_LABEL = { industrial: 'sanayi/hizmet', bank: 'banka', participation: 'katılım bankası', finance: 'kiralama/faktoring', insurance: 'sigorta', unknown: 'diğer' };

// v31.51: kulüplerin hesap dönemi haziran–mayıs; İş Yatırım dönem etiketleri takvim
// çeyreğine oturmuyor (BJKAS 2026/3 < 2025/12), kümülatiften çeyrek türetmek yanıltır.
const FISCAL_JUNE_MAY = new Set(['BJKAS', 'FENER', 'GSRAY', 'TSPOR']);

const CHART_METRICS = {
  industrial: [{ id: 'revenue', label: 'Hasılat' }, { id: 'ebitda', label: 'FAVÖK' }, { id: 'parentNet', label: 'Net kâr' }],
  bank: [{ id: 'netInterestIncome', label: 'Net faiz geliri' }, { id: 'parentNet', label: 'Net kâr' }],
  finance: [{ id: 'mainOpIncome', label: 'Esas faaliyet geliri' }, { id: 'parentNet', label: 'Net kâr' }],
  participation: [{ id: 'interestIncome', label: 'Kâr payı geliri' }, { id: 'parentNet', label: 'Net kâr' }],
  insurance: [{ id: 'techBalance', label: 'Teknik denge' }, { id: 'parentNet', label: 'Net kâr' }],
  unknown: [{ id: 'parentNet', label: 'Net kâr' }],
};
const YOY_KEY = { revenue: 'revenueYoY', ebitda: 'ebitdaYoY', parentNet: 'parentNetYoY', netInterestIncome: 'netInterestYoY', mainOpIncome: 'mainOpIncomeYoY', interestIncome: 'interestIncomeYoY' };

// v31.51: minWidth 0 — grid/flex öğesi varsayılan olarak içeriğinden dar olamaz;
// tablo kartı genişleyip ekranın dışına taşıyor, iç kaydırıcı hiç devreye girmiyordu
// (ölçüldü: 375 px telefonda içerik 488 px, sağ taraf kesik, sağa kaydırılamıyor).
function Card({ title, right, children, style }) {
  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', minWidth: 0, ...style }}>
      {(title || right) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {title && <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{title}</div>}
          <div style={{ flex: 1 }} />
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

function Stat({ label, value, sub, subTone, hint }) {
  return (
    <div title={hint || ''} style={{ background: 'var(--bg3)', borderRadius: 10, padding: '9px 11px', minWidth: 0 }}>
      <div style={{ fontSize: 11, color: 'var(--t3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--t1)', marginTop: 2, whiteSpace: 'nowrap' }}>{value}</div>
      {sub ? <div style={{ fontSize: 11, color: subTone || 'var(--t3)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div> : null}
    </div>
  );
}

function Pill({ onPress, children, active, title }) {
  return (
    <span role="button" tabIndex={0} title={title}
      onClick={onPress}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPress(); } }}
      style={{
        padding: '5px 11px', borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: 'pointer', userSelect: 'none',
        background: active ? 'var(--blue2)' : 'var(--bg3)', color: active ? 'var(--t1)' : 'var(--t2)',
        border: `1px solid ${active ? 'rgba(59,130,246,.45)' : 'var(--border)'}`, whiteSpace: 'nowrap',
      }}>{children}</span>
  );
}

const Loading = ({ text }) => (
  <Card><div style={{ fontSize: 12, color: 'var(--t3)', padding: '18px 0', textAlign: 'center' }}>{text}</div></Card>
);

const Note = ({ children }) => (
  <div style={{ fontSize: 11, color: 'var(--t3)', lineHeight: 1.55, marginTop: 10 }}>{children}</div>
);

const TMS29 = 'Çeyreklik değer = kümülatif raporların farkı. Enflasyon muhasebesi (TMS 29) nedeniyle her rapor kendi dönem sonunun satın alma gücüyle yayımlanır; farklı dönemleri karşılaştırırken bunu hesaba kat.';
const Q4_NOTE = '* 4. çeyrek = yıllık rapor − 9 aylık rapor. Yıl sonu raporu farklı bir satın alma gücüyle (TMS 29) ya da kurla yayımlandığından 4. çeyrek olduğundan büyük görünebilir. Eğilim için 12A görünümü piyasanın kullandığı yöntemdir (F/K da böyle hesaplanır). ';

function describeFailure(reason) {
  if (reason === 'network') return 'İş Yatırım’a ulaşılamadı — bağlantıyı kontrol edip yeniden dene. (“Veri yok” demek değil.)';
  if (reason === 'no_statements') return 'Bu şirket için çeyreklik mali tablo bulunamadı. Hesap dönemi farklı olabilir (ör. spor kulüpleri haziran–mayıs).';
  return 'Mali tablo alınamadı.';
}

export default function StockDetailTab({ active, symbol, onSymbolChange, onAnalyze, watchlist, setWatchlist, livePrice }) {
  const isMobile = useIsMobile();
  const [input, setInput] = useState(symbol || 'THYAO');
  const [section, setSection] = useState('summary');
  const [periodMode, setPeriodMode] = useState('quarter');   // quarter | ttm | annual
  const [chartMetric, setChartMetric] = useState(null);
  const [st, setSt] = useState({ symbol: null, loading: false });
  const reqRef = useRef(0);
  const loadedRef = useRef(null);

  useEffect(() => { if (symbol) setInput(symbol); }, [symbol]);

  // Parçalar geldikçe çizilir: tarama sürerken mali tablo yavaş gelebilir, teknik
  // bölüm onu beklememeli (ve tersi). Aynı hisse yenilenirken eski görünüm soluk
  // kalır; başka hisseye geçilince temizlenir — eski hissenin rakamı yeni başlığın
  // altında görünmesin.
  const load = useCallback((sym, { force = false } = {}) => {
    const id = ++reqRef.current;
    const alive = () => id === reqRef.current;   // kullanıcı bu arada başka hisse seçmedi
    setSt(prev => (prev.symbol === sym
      ? { ...prev, finLoading: true, pxLoading: true }
      : { symbol: sym, finLoading: true, pxLoading: true }));
    fetchFinancialHistory(sym, { force })
      .catch(() => ({ unavailable: true, reason: 'network' }))
      .then(fin => { if (alive()) setSt(p => ({ ...p, fin, finLoading: false })); });
    fetchSymbolValuation(sym).catch(() => null)
      .then(valuationRef => { if (alive()) setSt(p => ({ ...p, valuationRef })); });
    import('../../utils/foreignFlowEngine.js').then(m => m.fetchForeignRatio(sym)).catch(() => null)
      .then(foreign => { if (alive()) setSt(p => ({ ...p, foreign })); });
    (async () => {
      // Canlı fiyatın bara doğru eklenmesi için toplu fiyat önce ısınır (AnalyzeTab ile aynı sıra).
      await fetchBigParaBatchPrices().catch(() => {});
      const [data, bench] = await Promise.all([
        fetchData(sym, '2y', '1d').catch(() => null),
        fetchSingle('XU100', '2y', '1d', true).catch(() => null),
      ]);
      if (!alive()) return;
      const prices = Array.isArray(data?.prices) ? data.prices : [];
      let ind = null;
      try { ind = prices.length >= 30 ? calcAll(prices) : null; } catch { ind = null; }
      setSt(p => ({
        ...p, prices, ind, source: data?.source || null, pxLoading: false,
        bench: Array.isArray(bench?.prices) ? bench.prices : null,
      }));
    })();
  }, []);

  useEffect(() => {
    if (!active || !symbol || loadedRef.current === symbol) return;
    loadedRef.current = symbol;
    load(symbol);
  }, [active, symbol, load]);

  const submit = (raw) => {
    const s = String(raw || input).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!s || s.length > 10) return;
    setInput(s);
    if (s === symbol) { loadedRef.current = s; load(s, { force: true }); } else onSymbolChange?.(s);
  };

  const view = useMemo(() => (st.fin?.merged ? buildFinancialView(st.fin.merged) : null), [st.fin]);
  const kind = view?.kind || 'unknown';
  const prices = useMemo(() => st.prices || [], [st.prices]);
  const lastBar = prices[prices.length - 1];
  const prevBar = prices[prices.length - 2];
  const price = lastBar?.close ?? null;
  const changePct = lastBar && prevBar?.close ? ((lastBar.close - prevBar.close) / prevBar.close) * 100 : null;
  const valuation = useMemo(() => (view && price ? computeValuation(view, price) : null), [view, price]);
  const snapshot = useMemo(() => (st.ind && prices.length ? buildTechnicalSnapshot(prices, st.ind, { bench: st.bench }) : null), [st.ind, prices, st.bench]);
  const metrics = CHART_METRICS[kind] || CHART_METRICS.unknown;
  const metric = metrics.some(m => m.id === chartMetric) ? chartMetric : metrics[0].id;

  const shownSymbol = st.symbol || symbol;
  const dayKey = lastBar ? istanbulDayKey(lastBar.date) : '';
  const dayTxt = dayKey ? `${dayKey.slice(8, 10)}.${dayKey.slice(5, 7)}` : '';
  const inWatch = (watchlist || []).some(w => w.symbol === shownSymbol);
  const toggleWatch = () => {
    if (!shownSymbol || !setWatchlist) return;
    setWatchlist(inWatch
      ? watchlist.filter(w => w.symbol !== shownSymbol)
      : [...(watchlist || []), { symbol: shownSymbol, targetUp: null, targetDown: null, addedAt: Date.now() }]);
  };

  const periodColumns = view
    ? periodMode === 'annual' ? view.annual : periodMode === 'ttm' ? view.rolling : view.quarters
    : [];
  const chartPoints = [...periodColumns].reverse().map(c => ({ label: c.label, name: c.fromAnnual ? `${c.name}*` : c.name, value: c[metric] ?? null, yoy: c[YOY_KEY[metric]] ?? null }));
  const metricLabel = metrics.find(m => m.id === metric)?.label || '';
  const periodTitle = periodMode === 'annual' ? 'yıllık' : periodMode === 'ttm' ? 'son 12 ay, her çeyrek sonunda' : 'çeyreklik';

  const gutter = isMobile ? 12 : 16;
  const labelW = isMobile ? 130 : 190;
  const busy = !!(st.finLoading || st.pxLoading);
  const refreshing = (st.finLoading && st.fin) || (st.pxLoading && st.prices);
  const fadeStyle = refreshing ? { opacity: 0.55, transition: 'opacity .2s' } : { transition: 'opacity .2s' };

  // ── Özet bileşenleri ──
  const t = view?.ttm || {};
  const lastQ = view?.quarters?.[0];
  const b0 = view?.balance?.[0] || {};
  const ref = st.valuationRef && !st.valuationRef.unavailable ? st.valuationRef : null;

  const stats = [];
  if (valuation) {
    stats.push({ label: 'Piyasa değeri', value: fmtBig(valuation.mcap, { unit: 'TL' }), sub: `${fmtBig(valuation.shares)} pay` });
    stats.push({ label: 'F/K (12A)', value: valuation.pe != null ? fmtX(valuation.pe, 2) : valuation.peLoss ? 'zarar' : DASH, sub: ref?.pe != null ? `İş Yatırım: ${fmtX(ref.pe, 2)}` : null });
    stats.push({ label: 'PD/DD', value: fmtX(valuation.pb, 2), sub: ref?.pb != null ? `İş Yatırım: ${fmtX(ref.pb, 2)}` : null });
    if (kind === 'industrial') {
      stats.push({ label: 'FD/FAVÖK (12A)', value: fmtX(valuation.evEbitda, 2), sub: `FD ${fmtBig(valuation.ev)}`, hint: 'Firma değeri = piyasa değeri + net borç' });
      stats.push({ label: 'FD/Satışlar', value: fmtX(valuation.evSales, 2), sub: `F/S ${fmtX(valuation.ps, 2)}` });
      stats.push({ label: 'Net borç', value: fmtBig(valuation.netDebt), sub: b0.netDebtToEbitda != null ? `FAVÖK'ün ${fmtX(b0.netDebtToEbitda, 2)}` : (valuation.netDebt != null && valuation.netDebt < 0 ? 'net nakit' : null) });
    }
    stats.push({ label: 'Özkaynak kârlılığı', value: fmtPct(valuation.roe), sub: '12A net kâr / ana ortaklık özkaynağı' });
    stats.push({ label: 'Hisse başı kâr (12A)', value: valuation.eps != null ? `${fmtPrice(valuation.eps)} TL` : DASH, sub: valuation.bvps != null ? `Defter değeri ${fmtPrice(valuation.bvps)} TL` : null });
    if (kind === 'industrial') {
      stats.push({ label: 'Temettü verimi (12A)', value: fmtPct(valuation.dividendYield), sub: 'son 12 ayda ödenen / piyasa değeri' });
      stats.push({ label: 'Serbest nakit verimi', value: fmtPct(valuation.fcfYield), sub: `12A SNA ${fmtBig(t.fcf)}` });
    }
    if (kind === 'bank' && b0.loanToDeposit != null) stats.push({ label: 'Kredi / mevduat', value: fmtPct(b0.loanToDeposit) });
  } else if (ref) {
    // Pay adedi tablodan okunamadıysa (ör. katılım bankası şablonu) İş Yatırım'ın kendi
    // değerleri gösterilir — "veri yok" yerine kaynağı söylenen bir sayı.
    if (ref.mcapMnTL != null) stats.push({ label: 'Piyasa değeri', value: fmtBig(ref.mcapMnTL * 1e6, { unit: 'TL' }), sub: 'İş Yatırım tarama' });
    if (ref.pe != null) stats.push({ label: 'F/K', value: fmtX(ref.pe, 2), sub: 'İş Yatırım tarama' });
    if (ref.pb != null) stats.push({ label: 'PD/DD', value: fmtX(ref.pb, 2), sub: 'İş Yatırım tarama' });
    if (b0.roe != null) stats.push({ label: 'Özkaynak kârlılığı', value: fmtPct(b0.roe), sub: '12A net kâr / özkaynak' });
  }
  if (st.foreign?.ratio != null) {
    const w = st.foreign.changeWeek;
    stats.push({ label: 'Yabancı payı', value: fmtPct(st.foreign.ratio, { digits: 2 }), sub: w != null ? `1 hafta ${w > 0 ? '+' : w < 0 ? '−' : ''}${Math.abs(w).toFixed(2).replace('.', ',')} puan` : null, subTone: w != null ? signTone(w) : undefined });
  }
  if (snapshot?.range) {
    stats.push({ label: '52 hafta aralığı', value: `${fmtPrice(snapshot.range.low)} – ${fmtPrice(snapshot.range.high)}`, sub: `zirveden ${fmtPct(snapshot.range.fromHigh, { signed: true })}` });
  }

  const flowSummaryRows = kind === 'bank'
    ? [['netInterestIncome', 'Net faiz geliri', null, 'netInterestYoY'], ['operatingIncome', 'Faaliyet gelirleri', null, null], ['parentNet', 'Net kâr', null, 'parentNetYoY']]
    : kind === 'finance'
      ? [['mainOpIncome', 'Esas faaliyet gelirleri', null, 'mainOpIncomeYoY'], ['netOperatingProfit', 'Net faaliyet kârı', null, null], ['parentNet', 'Net kâr (ana ortaklık)', null, 'parentNetYoY']]
    : kind === 'participation'
      ? [['interestIncome', 'Kâr payı gelirleri', null, 'interestIncomeYoY'], ['parentNet', 'Net kâr', null, 'parentNetYoY']]
    : kind === 'insurance'
      ? [['techBalance', 'Teknik bölüm dengesi', null, null], ['parentNet', 'Net kâr', null, 'parentNetYoY']]
      : [['revenue', 'Hasılat', null, 'revenueYoY'], ['grossProfit', 'Brüt kâr', 'grossMargin', null], ['ebitda', 'FAVÖK', 'ebitdaMargin', 'ebitdaYoY'], ['operatingProfit', 'Esas faaliyet kârı', 'operatingMargin', null], ['parentNet', 'Net kâr (ana ortaklık)', 'netMargin', 'parentNetYoY'], ['fcf', 'Serbest nakit akımı', null, null]];
  const ttmGrowth = { revenueYoY: t.revenueGrowth, ebitdaYoY: t.ebitdaGrowth, parentNetYoY: t.parentNetGrowth, netInterestYoY: t.netInterestGrowth, mainOpIncomeYoY: t.mainOpIncomeGrowth, interestIncomeYoY: t.interestIncomeGrowth };

  return (
    <div style={{ padding: `12px ${gutter}px 28px`, maxWidth: 1280, margin: '0 auto' }}>
      {/* Hisse seçimi */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <input className="inp" value={input} onChange={e => setInput(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && submit()} placeholder="Hisse kodu" aria-label="Hisse kodu"
          style={{ width: isMobile ? 120 : 150, fontSize: 14, padding: '8px 10px', margin: 0 }} />
        <button className="btn btn-go" onClick={() => submit()} disabled={busy}
          style={{ width: 'auto', padding: '8px 16px', margin: 0, fontSize: 13 }}>
          {busy ? 'Yükleniyor…' : 'Getir'}
        </button>
        <div className="no-scrollbar" style={{ display: 'flex', gap: 6, flexWrap: isMobile ? 'nowrap' : 'wrap', overflowX: isMobile ? 'auto' : 'visible', minWidth: 0, flex: isMobile ? '1 1 100%' : '0 1 auto', paddingBottom: isMobile ? 2 : 0, WebkitOverflowScrolling: 'touch' }}>
          {QUICK_STOCKS.slice(0, isMobile ? 12 : 10).map(s => (
            <Pill key={s} onPress={() => submit(s)} active={s === shownSymbol}>{s}</Pill>
          ))}
        </div>
      </div>

      {/* Başlık */}
      {shownSymbol && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 12, ...fadeStyle }}>
          <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--t1)' }}>{shownSymbol}</span>
          <span style={{ fontSize: 12, color: 'var(--t3)' }}>{getSector(shownSymbol)}</span>
          {price != null && <span style={{ fontSize: 18, fontWeight: 600, color: 'var(--t1)' }}>{fmtPrice(price)} ₺</span>}
          {changePct != null && <span style={{ fontSize: 13, fontWeight: 600, color: signTone(changePct) }}>{fmtPct(changePct, { signed: true, digits: 2 })}</span>}
          {dayTxt && <span style={{ fontSize: 11, color: 'var(--t3)' }}>{dayTxt} {lastBar?._isForming ? 'canlı' : 'kapanış'}</span>}
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 6 }}>
            {setWatchlist && <Pill onPress={toggleWatch} active={inWatch}>{inWatch ? 'İzlemede' : 'İzlemeye ekle'}</Pill>}
            {onAnalyze && <Pill onPress={() => onAnalyze(shownSymbol)} title="AL/SAT kararı, stop ve hedef">Sinyal ve plan ›</Pill>}
          </div>
        </div>
      )}

      {/* Bölümler */}
      {/* v31.51: telefonda bölümler alt satıra kayar — yana kayan şeritte son ikisi görünmüyordu */}
      <div style={{ marginBottom: 12, minWidth: 0 }}>
        <Segmented options={SECTIONS} value={section} onChange={setSection} />
      </div>

      {!shownSymbol && (
        <Card><div style={{ fontSize: 12, color: 'var(--t3)' }}>Bir hisse kodu yaz ya da listeden seç.</div></Card>
      )}

      {shownSymbol && (
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'minmax(0, 1fr)', ...fadeStyle }}>
          {section !== 'technical' && !st.fin && st.finLoading && (
            <Loading text={`${shownSymbol} mali tabloları çekiliyor (16 çeyrek, İş Yatırım)…`} />
          )}
          {section === 'technical' && !st.prices && st.pxLoading && (
            <Loading text={`${shownSymbol} fiyat serisi çekiliyor…`} />
          )}
          {st.fin?.unavailable && section !== 'technical' && (
            <Card><div style={{ fontSize: 12, color: 'var(--orange)', lineHeight: 1.5 }}>{describeFailure(st.fin.reason)}</div></Card>
          )}
          {FISCAL_JUNE_MAY.has(shownSymbol) && view?.latest && section !== 'technical' && (
            <Card><div style={{ fontSize: 12, color: 'var(--orange)', lineHeight: 1.5 }}>
              Bu kulübün hesap dönemi haziran–mayıs. İş Yatırım dönem etiketleri takvim çeyreğine oturmadığı için çeyreklik
              rakamlar ve 12A güvenilir değil — “Tüm kalemler › Kümülatif” görünümünü kullan.
            </div></Card>
          )}

          {section === 'summary' && (
            <>
              {stats.length > 0 && (
                <div style={{ display: 'grid', gap: 8, gridTemplateColumns: `repeat(auto-fill, minmax(${isMobile ? 140 : 170}px, 1fr))` }}>
                  {stats.map(s => <Stat key={s.label} {...s} />)}
                </div>
              )}
              {view?.latest && (
                <Card title={`Son 12 ay ve son çeyrek (${quarterName(view.latest)})`}>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                      <thead>
                        <tr style={{ color: 'var(--t3)', fontSize: 11 }}>
                          <th style={{ textAlign: 'left', fontWeight: 600, padding: '0 8px 6px 0' }}>Kalem</th>
                          <th style={{ textAlign: 'right', fontWeight: 600, padding: '0 8px 6px' }}>12 ay</th>
                          <th style={{ textAlign: 'right', fontWeight: 600, padding: '0 8px 6px' }}>Yıllık değ.</th>
                          <th style={{ textAlign: 'right', fontWeight: 600, padding: '0 8px 6px' }}>{quarterName(view.latest)}</th>
                          <th style={{ textAlign: 'right', fontWeight: 600, padding: '0 0 6px 8px' }}>Yıllık değ.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {flowSummaryRows.filter(([k]) => t[k] != null || lastQ?.[k] != null).map(([k, label, marginKey, yoyKey]) => (
                          <tr key={k}>
                            <td style={{ padding: '6px 8px 6px 0', borderTop: '1px solid var(--border)', color: 'var(--t2)', whiteSpace: 'nowrap' }}>
                              {label}{marginKey && t[marginKey] != null ? <span style={{ color: 'var(--t3)', marginLeft: 6 }}>marj {fmtPct(t[marginKey])}</span> : null}
                            </td>
                            <td style={{ padding: '6px 8px', borderTop: '1px solid var(--border)', textAlign: 'right', color: 'var(--t1)', fontWeight: 600, whiteSpace: 'nowrap' }}>{fmtBig(t[k])}</td>
                            <td style={{ padding: '6px 8px', borderTop: '1px solid var(--border)', textAlign: 'right', color: signTone(ttmGrowth[yoyKey]), whiteSpace: 'nowrap' }}>{yoyKey ? fmtPct(ttmGrowth[yoyKey], { signed: true }) : ''}</td>
                            <td style={{ padding: '6px 8px', borderTop: '1px solid var(--border)', textAlign: 'right', color: 'var(--t1)', whiteSpace: 'nowrap' }}>{fmtBig(lastQ?.[k])}</td>
                            <td style={{ padding: '6px 0 6px 8px', borderTop: '1px solid var(--border)', textAlign: 'right', color: signTone(lastQ?.[yoyKey]), whiteSpace: 'nowrap' }}>{yoyKey ? fmtPct(lastQ?.[yoyKey], { signed: true }) : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {kind === 'industrial' && t.exportShare != null && (
                    <Note>Son 12 ay satışlarının {fmtPct(t.exportShare)}’i yurt dışı. Net döviz pozisyonu {fmtBig(b0.netFxPosition, { unit: 'TL' })}.</Note>
                  )}
                </Card>
              )}
              {snapshot?.returns?.length > 0 && (
                <Card title="Getiriler">
                  <ReturnsTable returns={snapshot.returns} />
                </Card>
              )}
              {view?.latest && (
                <Note>
                  Kaynak: İş Yatırım mali tablolar · {GROUP_LABEL[st.fin.group] || st.fin.group} · {KIND_LABEL[kind]} şablonu · {view.labels.length} çeyrek, son dönem {quarterName(view.latest)}.
                  {valuation
                    ? ' F/K ve PD/DD bu bilançodan ve güncel fiyattan hesaplanır; İş Yatırım tarama değeri farklıysa tarama henüz son bilançoyu almamıştır. Pay adedi = ödenmiş sermaye (nominal 1 TL).'
                    : ' Bu şablonda pay adedi okunamadığı için piyasa değeri, F/K ve PD/DD İş Yatırım taramasından.'}
                  {st.fin.missingChunks ? ` ${st.fin.missingChunks * 4} eski çeyrek alınamadı.` : ''}
                </Note>
              )}
              {setWatchlist && <WatchlistPanel watchlist={watchlist} setWatchlist={setWatchlist} livePrice={livePrice} />}
            </>
          )}

          {section === 'quarters' && view?.latest && (
            <>
              <Card
                title={`${metricLabel} — ${periodTitle}`}
                right={(
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <Segmented size="sm" options={metrics} value={metric} onChange={setChartMetric} />
                    <Segmented size="sm" value={periodMode} onChange={setPeriodMode}
                      options={[{ id: 'quarter', label: 'Çeyreklik' }, { id: 'ttm', label: '12A' }, { id: 'annual', label: 'Yıllık' }]} />
                  </div>
                )}>
                <QuarterChart points={chartPoints} title={`${shownSymbol} · TL`} />
              </Card>
              <Card title={kind === 'industrial' ? 'Gelir tablosu ve FAVÖK' : 'Gelir tablosu'}>
                <DataTable rows={incomeRows(kind)} columns={periodColumns} firstColWidth={labelW} />
                <Note>{periodMode === 'ttm' ? 'Her sütun o çeyrek sonunda biten 12 ayın toplamı. ' : ''}{periodMode === 'quarter' ? Q4_NOTE : ''}{TMS29}</Note>
              </Card>
            </>
          )}

          {section === 'balance' && view?.latest && (
            <Card title="Bilanço ve oranlar" right={<span style={{ fontSize: 11, color: 'var(--t3)' }}>çeyrek sonu değerleri</span>}>
              <DataTable rows={balanceRows(kind)} columns={view.balance} firstColWidth={labelW} />
              <Note>Oranlardaki 12A, o çeyrek sonunda biten 12 ayın kârı ve FAVÖK'üdür.</Note>
            </Card>
          )}

          {section === 'cash' && view?.latest && (
            kind === 'industrial' ? (
              <Card title="Nakit akışı" right={(
                <Segmented size="sm" value={periodMode} onChange={setPeriodMode}
                  options={[{ id: 'quarter', label: 'Çeyreklik' }, { id: 'ttm', label: '12A' }, { id: 'annual', label: 'Yıllık' }]} />
              )}>
                <DataTable rows={cashRows()} columns={periodColumns} firstColWidth={labelW} />
                <Note>Serbest nakit akımı İş Yatırım’ın tanımıyla (işletme nakdi + yatırım harcamaları). {TMS29}</Note>
              </Card>
            ) : (
              <Card><div style={{ fontSize: 12, color: 'var(--t3)' }}>İş Yatırım {KIND_LABEL[kind]} tablolarında nakit akışı yayımlamıyor — kalemler “Tüm kalemler” sekmesinde.</div></Card>
            )
          )}

          {section === 'technical' && (st.prices || !st.pxLoading) && (
            <>
              <TechnicalPanel snapshot={snapshot} isMobile={isMobile} />
              <Note>
                {prices.length} günlük bar ({st.source || 'kaynak'}). Değerler göstergenin klasik okumasıdır, işlem sinyali değildir —
                AL/SAT kararı, stop ve hedef için “Sinyal ve plan”.
              </Note>
            </>
          )}

          {section === 'all' && view?.latest && (
            <Card title="Tüm mali tablo kalemleri" right={<span style={{ fontSize: 11, color: 'var(--t3)' }}>{GROUP_LABEL[st.fin.group] || st.fin.group}</span>}>
              <FullStatement statements={view.statements} labels={view.labels} kind={kind} firstColWidth={isMobile ? 150 : 220} />
              <Note>{TMS29}</Note>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
