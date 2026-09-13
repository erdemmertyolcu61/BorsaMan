/**
 * MarketPulsePanel — "Piyasa" (v31.38).
 *
 * Replaces the mobile Haber tab (AI market intel — needed a Gemini key and had
 * never refreshed on the phone). Three free, measured sources in one screen:
 *   - KAP disclosures  (kapFeed.js — KAP's JSON list endpoint via our proxy)
 *   - per-stock foreign ownership + relative momentum (İş Yatırım screener)
 *   - TCMB weekly foreign net equity purchases (EVDS, only with a free key)
 *
 * User decision 2026-09-12: none of this moves the score. It is shown, recorded
 * on every signal, and measured at the bottom of this screen. The only thing
 * that acts immediately is a trading measure on the stock itself, which keeps
 * that stock out of the buy list (dataLayerPolicy).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchKapFeed, buildKapIndex, describeKapFailure, KAP_FEED_DISPLAY_DAYS, KAP_RISK_WINDOW_DAYS,
} from '../../utils/kapFeed.js';
import {
  fetchAllForeignRatios, fetchMarketForeignFlow, getForeignRatiosFetchedAt,
  summarizeForeignBreadth, topRelativeMomentum,
} from '../../utils/foreignFlowEngine.js';
import { computeDataLayerEdge, FOREIGN_FLOW_BAND_PP } from '../../utils/dataLayerEdge.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const KIND = {
  risk:    { color: 'var(--red)',    bg: 'rgba(255,23,68,0.08)', icon: '⛔' },
  caution: { color: 'var(--orange)', bg: 'rgba(255,145,0,0.08)', icon: '⚠' },
  event:   { color: 'var(--cyan)',   bg: 'rgba(0,229,255,0.06)', icon: '📢' },
  info:    { color: 'var(--t3)',     bg: 'var(--bg3)',           icon: '•' },
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const signed = (v, digits = 2, suffix = '') => (isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(digits)}${suffix}` : '—');
const toneOf = (v) => (isNum(v) && v > 0 ? 'var(--green)' : isNum(v) && v < 0 ? 'var(--red)' : 'var(--t3)');

function fmtStamp(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Watchlist + BIST holdings in the real portfolio + recently signalled symbols. */
function collectMySymbols(watchlist, signals) {
  const out = new Set();
  for (const w of watchlist || []) if (w?.symbol) out.add(String(w.symbol).toUpperCase());
  try {
    const raw = localStorage.getItem('bist_real_portfolio');
    const parsed = raw ? JSON.parse(raw) : null;
    const list = Array.isArray(parsed) ? parsed : (parsed?.positions || []);
    for (const p of list) {
      const ticker = String(p?.ticker || p?.symbol || '').toUpperCase();
      if (ticker && String(p?.market || 'BIST').toUpperCase() !== 'US') out.add(ticker);
    }
  } catch { /* corrupt local data must not break the list */ }
  for (const s of (signals || []).slice(0, 40)) if (s?.symbol) out.add(String(s.symbol).toUpperCase());
  return out;
}

function Muted({ children, tone = 'var(--t3)' }) {
  return <div style={{ fontSize: 11, color: tone, padding: '6px 0', lineHeight: 1.5 }}>{children}</div>;
}

function Section({ title, right, accent = 'var(--cyan)', children }) {
  return (
    <div className="trade-box" style={{ marginBottom: 12 }}>
      <div className="trade-title" style={{ color: accent, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span>{title}</span>
        <div style={{ flex: 1 }} />
        {right}
      </div>
      {children}
    </div>
  );
}

// Spans, not buttons: the mobile stylesheet gives every button in a tab a 40px
// minimum height, which turns a row of ticker chips into a wall.
function Pressable({ onPress, style, children, title }) {
  return (
    <span
      role="button"
      tabIndex={0}
      title={title}
      onClick={onPress}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPress(); } }}
      style={{ cursor: 'pointer', ...style }}
    >
      {children}
    </span>
  );
}

function SymbolChip({ symbol, onAnalyze }) {
  return (
    <Pressable
      onPress={() => onAnalyze?.(symbol)}
      title={`${symbol} — analiz et`}
      style={{
        fontSize: 11, fontWeight: 800, color: 'var(--t1)', background: 'var(--bg2)',
        border: '1px solid var(--border)', borderRadius: 4, padding: '2px 7px', letterSpacing: 0.3,
      }}
    >
      {symbol}
    </Pressable>
  );
}

/** A stock under a KAP trading measure must never appear un-flagged in a "top" list. */
function RiskTag({ risk }) {
  if (!risk) return null;
  return (
    <span title={`${risk.label} — KAP, son ${KAP_RISK_WINDOW_DAYS} gün. AL listesine alınmaz.`}
      style={{ fontSize: 9, fontWeight: 800, color: '#fca5a5', background: '#7f1d1d', border: '1px solid #ef4444', borderRadius: 3, padding: '0 4px' }}>
      ⛔ tedbir
    </span>
  );
}

function FilterPill({ active, onPress, children }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        fontSize: 10, fontWeight: 700, padding: '4px 10px', borderRadius: 12,
        color: active ? '#000' : 'var(--t2)', background: active ? 'var(--cyan)' : 'var(--bg2)',
        border: `1px solid ${active ? 'var(--cyan)' : 'var(--border)'}`,
      }}
    >
      {children}
    </Pressable>
  );
}

function KapRow({ item, subjects, onAnalyze }) {
  const k = KIND[item.cls.kind] || KIND.info;
  return (
    <div style={{ background: k.bg, borderLeft: `3px solid ${k.color}`, borderRadius: 6, padding: '8px 10px', marginBottom: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {subjects.slice(0, 4).map((s) => <SymbolChip key={s} symbol={s} onAnalyze={onAnalyze} />)}
        {subjects.length > 4 && <span style={{ fontSize: 10, color: 'var(--t3)' }}>+{subjects.length - 4}</span>}
        <span style={{ fontSize: 10, fontWeight: 700, color: k.color }}>{k.icon} {item.cls.label}</span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--t3)', whiteSpace: 'nowrap' }}>{fmtStamp(item.ts)}</span>
      </div>
      {item.summary && item.summary !== item.title && (
        <div style={{
          fontSize: 11, color: 'var(--t2)', marginTop: 4, lineHeight: 1.45,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}>
          {item.summary}
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: 10, color: 'var(--t3)', alignItems: 'center' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{item.company}</span>
        <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 'auto', color: 'var(--cyan)' }}>KAP ↗</a>
      </div>
    </div>
  );
}

function MoverList({ title, rows, onAnalyze, riskOf }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--t3)', fontWeight: 700, marginBottom: 4 }}>{title}</div>
      {rows.length === 0 ? <Muted>—</Muted> : rows.map((r) => (
        <div key={r.symbol} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <SymbolChip symbol={r.symbol} onAnalyze={onAnalyze} />
          <RiskTag risk={riskOf(r.symbol)} />
          <span style={{ fontSize: 10, color: 'var(--t3)' }}>%{isNum(r.ratio) ? r.ratio.toFixed(1) : '—'}</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: toneOf(r.changeWeek) }}>{signed(r.changeWeek)} p</span>
          <span style={{ fontSize: 10, color: toneOf(r.changeMonth), minWidth: 58, textAlign: 'right' }}>1A {signed(r.changeMonth)}</span>
        </div>
      ))}
    </div>
  );
}

function EdgeTable({ title, rows }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 40px 60px 64px', gap: 6, fontSize: 10, color: 'var(--t3)', fontWeight: 700, paddingBottom: 3 }}>
        <span>{title}</span>
        <span style={{ textAlign: 'right' }}>n</span>
        <span style={{ textAlign: 'right' }}>kazanma</span>
        <span style={{ textAlign: 'right' }}>ort.</span>
      </div>
      {rows.map(([label, cell]) => (
        <div key={label} style={{
          display: 'grid', gridTemplateColumns: '1fr 40px 60px 64px', gap: 6, fontSize: 11, padding: '3px 0',
          borderTop: '1px solid rgba(255,255,255,0.04)', opacity: cell.reliable ? 1 : 0.55,
        }}>
          <span style={{ color: 'var(--t2)' }}>{label}</span>
          <span style={{ textAlign: 'right', color: 'var(--t2)' }}>{cell.n}</span>
          <span style={{ textAlign: 'right', color: cell.winRate == null ? 'var(--t3)' : cell.winRate >= 50 ? 'var(--green)' : 'var(--red)' }}>
            {cell.winRate == null ? '—' : `%${cell.winRate.toFixed(0)}`}
          </span>
          <span style={{ textAlign: 'right', color: toneOf(cell.avgReturn) }}>{signed(cell.avgReturn, 2, '%')}</span>
        </div>
      ))}
    </div>
  );
}

export default function MarketPulsePanel({ signals = [], watchlist = [], onAnalyze }) {
  const [kap, setKap] = useState({ loading: true, ok: false, items: [] });
  const [foreign, setForeign] = useState({ loading: true, ratios: {}, fetchedAt: null });
  const [evds, setEvds] = useState(undefined);
  const [filter, setFilter] = useState('important');
  const [limit, setLimit] = useState(25);
  // Listed codes from the committed KAP snapshot — the fallback "tradable" set.
  const [listed, setListed] = useState(null);

  const load = useCallback(async (force) => {
    setKap((s) => ({ ...s, loading: true }));
    setForeign((s) => ({ ...s, loading: true }));
    // One KAP request covers both the 7-day risk list and the 3-day feed.
    const [feed, ratios, flow] = await Promise.all([
      fetchKapFeed({ days: KAP_RISK_WINDOW_DAYS, force }),
      fetchAllForeignRatios().catch(() => ({})),
      fetchMarketForeignFlow().catch(() => null),
    ]);
    setKap({ loading: false, ...feed });
    setForeign({ loading: false, ratios: ratios || {}, fetchedAt: getForeignRatiosFetchedAt() });
    setEvds(flow);
  }, []);

  useEffect(() => { load(false); }, [load]);

  useEffect(() => {
    let alive = true;
    import('../../data/kapMemberOids.json')
      .then((m) => { if (alive) setListed(new Set(Object.keys((m.default || m).oids || {}))); })
      .catch(() => { /* without the snapshot every code counts as tradable */ });
    return () => { alive = false; };
  }, []);

  // Which codes are tradable BIST equities? Measured: portfolio managers (PA1,
  // GPO...) file dozens of notices under their own non-tradable codes, and lease
  // certificate issuers (ATAVK) appear in the risk list. İş Yatırım's screener
  // covers exactly the ~600 listed equities, so prefer it; the KAP snapshot is
  // the fallback while it loads.
  const tradable = useMemo(() => {
    const keys = Object.keys(foreign.ratios || {});
    return keys.length >= 100 ? new Set(keys) : listed;
  }, [foreign.ratios, listed]);
  const isTradable = useCallback((code) => !tradable || tradable.has(code), [tradable]);

  const index = useMemo(
    () => (kap.ok ? buildKapIndex(kap.items, { now: kap.fetchedAt || Date.now() }) : null),
    [kap],
  );
  const riskOf = useCallback((symbol) => index?.bySymbol?.[symbol]?.risk || null, [index]);
  const riskRows = useMemo(() => (index
    ? Object.values(index.bySymbol).filter((e) => e.risk && isTradable(e.symbol)).sort((a, b) => b.risk.ts - a.risk.ts)
    : []), [index, isTradable]);
  const mySymbols = useMemo(() => collectMySymbols(watchlist, signals), [watchlist, signals]);
  const feedRows = useMemo(() => {
    if (!kap.ok) return [];
    const cutoff = (kap.fetchedAt || Date.now()) - KAP_FEED_DISPLAY_DAYS * DAY_MS;
    const rows = [];
    for (const it of kap.items) {
      if (it.ts < cutoff || it.cls.kind === 'noise') continue;
      const onBoard = (it.subjects || []).filter(isTradable);
      if (filter === 'important' && (it.cls.kind === 'info' || onBoard.length === 0)) continue;
      if (filter === 'mine' && !onBoard.some((s) => mySymbols.has(s))) continue;
      rows.push({ item: it, subjects: filter === 'all' && onBoard.length === 0 ? (it.subjects || []) : onBoard });
    }
    return rows;
  }, [kap, filter, mySymbols, isTradable]);
  const breadth = useMemo(() => summarizeForeignBreadth(foreign.ratios, { minMcapMnTL: 1000, topN: 5 }), [foreign.ratios]);
  const momentum = useMemo(() => topRelativeMomentum(foreign.ratios, { minMcapMnTL: 3000, topN: 6 }), [foreign.ratios]);
  const edge = useMemo(() => computeDataLayerEdge(signals), [signals]);

  const loading = kap.loading || foreign.loading;
  const kapFailure = !kap.loading && !kap.ok ? describeKapFailure(kap.reason) : null;

  let evdsLine = '';
  if (evds === null) {
    evdsLine = 'TCMB haftalık yabancı net hisse alımı için EVDS anahtarı gerekir (ücretsiz: evds3.tcmb.gov.tr) — Ayarlar.';
  } else if (evds?.error) {
    evdsLine = `TCMB EVDS: ${evds.error}`;
  } else if (evds) {
    evdsLine = `TCMB haftalık yabancı net hisse alımı: ${signed(evds.latestWeeklyFlow, 1)} mn $ (${evds.latestDate}) · son 4 hafta ${signed(evds.fourWeekFlow, 1)} mn $`;
  }

  return (
    <div style={{ padding: '14px 16px 28px', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--t1)', letterSpacing: 1 }}>📡 PİYASA NABZI</span>
        <span style={{ fontSize: 10, color: 'var(--t3)' }}>KAP bildirimleri · yabancı oranı · göreli momentum</span>
        <div style={{ flex: 1 }} />
        <Pressable
          onPress={() => { if (!loading) load(true); }}
          style={{
            fontSize: 10, fontWeight: 700, padding: '5px 12px', borderRadius: 5,
            background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.35)', color: 'var(--cyan)',
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? '↻ Yükleniyor…' : '↻ Yenile'}
        </Pressable>
      </div>
      <div style={{ fontSize: 10, color: 'var(--t3)', lineHeight: 1.5, marginBottom: 12 }}>
        Bu veriler şu an <b style={{ color: 'var(--t2)' }}>skoru etkilemiyor</b> — her sinyale kaydedilip en altta ölçülüyor.
        Tek istisna: hissenin kendisine uygulanan <b style={{ color: 'var(--t2)' }}>işlem tedbiri</b> o hisseyi AL listesinden çıkarır.
      </div>

      <Section
        title={`⛔ İŞLEM TEDBİRİ / RİSK (son ${KAP_RISK_WINDOW_DAYS} gün)`}
        accent="var(--red)"
        right={kap.ok ? <span style={{ fontSize: 10, color: 'var(--t3)' }}>{riskRows.length} hisse</span> : null}
      >
        {kap.loading ? <Muted>KAP yükleniyor…</Muted>
          : kapFailure ? <Muted tone="var(--orange)">{kapFailure}</Muted>
          : riskRows.length === 0 ? <Muted>Tedbir altında hisse yok.</Muted>
          : riskRows.map((e) => (
            <div key={e.symbol} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.05)', flexWrap: 'wrap' }}>
              <SymbolChip symbol={e.symbol} onAnalyze={onAnalyze} />
              <span style={{ fontSize: 11, color: 'var(--red)', fontWeight: 700 }}>{e.risk.label}</span>
              <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--t3)' }}>{fmtStamp(e.risk.ts)}</span>
              <a href={e.risk.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: 'var(--cyan)' }}>KAP ↗</a>
            </div>
          ))}
      </Section>

      <Section
        title={`📢 KAP BİLDİRİMLERİ (son ${KAP_FEED_DISPLAY_DAYS} gün)`}
        right={(
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <FilterPill active={filter === 'important'} onPress={() => { setFilter('important'); setLimit(25); }}>Önemli</FilterPill>
            <FilterPill active={filter === 'mine'} onPress={() => { setFilter('mine'); setLimit(25); }}>Takibim</FilterPill>
            <FilterPill active={filter === 'all'} onPress={() => { setFilter('all'); setLimit(25); }}>Tümü</FilterPill>
          </div>
        )}
      >
        {kap.loading ? <Muted>KAP yükleniyor…</Muted>
          : kapFailure ? <Muted tone="var(--orange)">{kapFailure}</Muted>
          : feedRows.length === 0 ? (
            <Muted>{filter === 'mine' ? 'İzleme listen, portföyün ve son sinyallerindeki hisselerde bildirim yok.' : 'Bu filtrede bildirim yok.'}</Muted>
          ) : (
            <>
              {feedRows.slice(0, limit).map(({ item, subjects }) => (
                <KapRow key={item.id} item={item} subjects={subjects} onAnalyze={onAnalyze} />
              ))}
              {feedRows.length > limit && (
                <Pressable
                  onPress={() => setLimit((l) => l + 25)}
                  style={{ display: 'block', textAlign: 'center', fontSize: 11, color: 'var(--cyan)', padding: '8px 0' }}
                >
                  Daha fazla ({feedRows.length - limit})
                </Pressable>
              )}
            </>
          )}
        {kap.ok && index && (
          <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 6 }}>
            {kap.items.length} bildirim alındı · {index.noise} rutin kayıt (borçlanma aracı, form, bülten) gizlendi
          </div>
        )}
      </Section>

      <Section
        title="🌍 YABANCI ORANI (haftalık değişim)"
        accent="var(--green)"
        right={foreign.fetchedAt ? <span style={{ fontSize: 10, color: 'var(--t3)' }}>İş Yatırım · {fmtStamp(foreign.fetchedAt)}</span> : null}
      >
        {foreign.loading ? <Muted>Yükleniyor…</Muted>
          : breadth.n === 0 ? <Muted tone="var(--orange)">Hisse bazlı yabancı oranı alınamadı. Proxy güncel değilse yeniden deploy etmek gerekir.</Muted>
          : (
            <>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, marginBottom: 8 }}>
                <span><b style={{ color: 'var(--green)' }}>↑ {breadth.up}</b> hissede arttı</span>
                <span><b style={{ color: 'var(--red)' }}>↓ {breadth.down}</b> azaldı</span>
                <span style={{ color: 'var(--t3)' }}>medyan {signed(breadth.medianChg1w)} p</span>
                <span style={{ color: 'var(--t3)' }}>piyasa değeri ağırlıklı {signed(breadth.capWeightedChg1w)} p</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
                <MoverList title="En çok artan (1 hafta)" rows={breadth.topIn} onAnalyze={onAnalyze} riskOf={riskOf} />
                <MoverList title="En çok azalan (1 hafta)" rows={breadth.topOut} onAnalyze={onAnalyze} riskOf={riskOf} />
              </div>
              <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 6 }}>
                p = yüzde puan · piyasa değeri 1 milyar TL altı hareket listelerine alınmadı
              </div>
            </>
          )}
        {evdsLine && <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 8, lineHeight: 1.5 }}>{evdsLine}</div>}
      </Section>

      <Section title="🚀 GÖRELİ MOMENTUM (1 hafta, endekse göre)" accent="var(--yellow)">
        {foreign.loading ? <Muted>Yükleniyor…</Muted>
          : momentum.length === 0 ? <Muted>Veri yok.</Muted>
          : momentum.map((m) => (
            <div key={m.symbol} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <SymbolChip symbol={m.symbol} onAnalyze={onAnalyze} />
              <RiskTag risk={riskOf(m.symbol)} />
              <span style={{ fontSize: 11, fontWeight: 700, color: toneOf(m.rel1w) }}>{signed(m.rel1w, 1, '%')}</span>
              <span style={{ fontSize: 10, color: 'var(--t3)' }}>1A {signed(m.rel1m, 1, '%')}</span>
              <span style={{ marginLeft: 'auto', fontSize: 10, color: toneOf(m.changeWeek) }}>yabancı {signed(m.changeWeek)} p</span>
            </div>
          ))}
        <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 6 }}>
          Piyasa değeri 3 milyar TL üstü · görünüm, öneri değil — geçen haftanın güçlüsü bu haftayı garanti etmez;
          sert yükselişler çoğu zaman VBTS tedbirini de beraberinde getirir.
        </div>
      </Section>

      <Section title="📏 ÖLÇÜM — bu veriler işe yarıyor mu?" accent="var(--purple)">
        <div style={{ fontSize: 10, color: 'var(--t3)', lineHeight: 1.5 }}>
          Sonuçlanan {edge.settled} AL sinyali · yabancı verisiyle kaydedilen {edge.withForeign} · KAP kontrolüyle kaydedilen {edge.withKap}.
          {' '}{edge.minSample} örneğin altındaki satırlar soluk — küçük örnek yanıltır. Kayıt bu sürümle başladı; kovalar zamanla dolar.
        </div>
        <EdgeTable
          title={`Yabancı (hafta, ±${FOREIGN_FLOW_BAND_PP} p)`}
          rows={[['Giriş', edge.foreign.inflow], ['Nötr', edge.foreign.flat], ['Çıkış', edge.foreign.outflow]]}
        />
        <EdgeTable
          title="KAP (son 7 gün)"
          rows={[['Şirket olayı var', edge.kap.event], ['Diğer bildirim', edge.kap.other], ['Bildirim yok', edge.kap.none], ['İşlem tedbiri', edge.kap.risk]]}
        />
        {/* v31.41: geri alım artışı açıldı, yeni iş kapalı kaldı — ikisi de ölçülmeye devam ediyor */}
        <EdgeTable
          title="KAP olay türü (örtüşebilir)"
          rows={[['Pay geri alımı', edge.kapEvents.buyback], ['Yeni iş anlaşması', edge.kapEvents.new_business]]}
        />
      </Section>
    </div>
  );
}
