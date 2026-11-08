import { useState, useEffect } from 'react';
import { getLiveIndicators } from '../../utils/macroData.js';
import { fetchEconCalendar, withPpkDates, nextPpkDate, selectCalendarView } from '../../utils/econCalendar.js';
import { istanbulDayKey } from '../../utils/signalPerfHistory.js';

// v31.47: the header used to count 8 client-generated "upcoming events" with
// invented forecasts; the tiles fell back to a hard-coded USDTRY 38.42 and a stale
// TCMB 50% shown as live. Every tile now says where its number comes from.
// v31.48: the calendar is back, from a real source (econCalendar.js: doviz.com's
// server-rendered table + TCMB's announced PPK dates).

const REGION_LABEL = { TR: 'TR', US: 'ABD', EU: 'EUR', DE: 'ALM', GB: 'İNG', CN: 'ÇİN', JP: 'JPN' };
const REASON_TEXT = {
  proxy_outdated: 'proxy eski — yeniden yayınlanmalı',
  timeout: 'kaynak zaman aşımına uğradı',
  network: 'bağlantı yok',
  empty: 'kaynak boş döndü',
  shape: 'kaynak biçimi değişmiş',
};

const nf = (d) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
const nf2 = nf(2);

function shortDate(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key || ''))) return '';
  try {
    return new Date(`${key}T12:00:00Z`).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', timeZone: 'Europe/Istanbul' });
  } catch { return key; }
}

function dayHeading(key, todayKey) {
  const t = Date.parse(`${todayKey}T12:00:00Z`);
  const diff = Math.round((Date.parse(`${key}T12:00:00Z`) - t) / 86400000);
  let label = '';
  try {
    label = new Date(`${key}T12:00:00Z`).toLocaleDateString('tr-TR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Istanbul' });
  } catch { label = key; }
  return diff === 0 ? `Bugün · ${label}` : diff === 1 ? `Yarın · ${label}` : label;
}

function shortDay(key) {
  try {
    return new Date(`${key}T12:00:00Z`).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', timeZone: 'Europe/Istanbul' });
  } catch { return key; }
}

function EventRow({ e }) {
  const isTr = e.c === 'TR';
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '6px 0', borderTop: '1px solid var(--border)' }}>
      <span style={{ fontSize: 11, color: 'var(--t3)', width: 42, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{e.t || '—'}</span>
      <span style={{
        fontSize: 10, fontWeight: 600, flexShrink: 0, borderRadius: 6, padding: '1px 5px',
        color: isTr ? 'var(--t1)' : 'var(--t2)', background: isTr ? 'rgba(239,68,68,0.16)' : 'var(--bg3)',
      }}>{REGION_LABEL[e.c] || e.c}</span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--t1)', fontWeight: e.imp === 'high' ? 600 : 400 }}>
        {e.ev}
      </span>
      <span style={{ fontSize: 11, color: 'var(--t3)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        {e.act ? <b style={{ color: 'var(--t1)' }}>{e.act}</b> : e.exp ? `bkl. ${e.exp}` : ''}
        {e.prev ? <span>{e.act || e.exp ? ' · ' : ''}önc. {e.prev}</span> : null}
      </span>
    </div>
  );
}

function Tile({ ind, kind }) {
  const has = Number.isFinite(ind?.value) && ind.value !== 0;
  let sub;
  let subColor = 'var(--t3)';
  if (!has) {
    sub = 'veri yok';
  } else if (kind === 'policyRate') {
    const when = shortDate(ind.asOf);
    if (ind.stale) {
      sub = `son bilinen${when ? ` · ${when}` : ''}`;
      subColor = 'var(--yellow)';
    } else {
      const arrow = ind.trend === 'dusus' ? '▼ ' : ind.trend === 'yukselis' ? '▲ ' : '';
      sub = `${arrow}karar${when ? ` ${when}` : ''}`;
      subColor = ind.trend === 'dusus' ? 'var(--green)' : ind.trend === 'yukselis' ? 'var(--red)' : 'var(--t3)';
    }
  } else if (ind.trend) {
    sub = `${ind.trend === 'yukselis' ? '▲' : '▼'} 5 gün`;
    subColor = ind.trend === 'yukselis' ? 'var(--green)' : 'var(--red)';
  } else {
    sub = '';
  }
  const value = !has ? '—'
    : kind === 'policyRate' ? `%${nf2.format(ind.value)}`
      : `${nf2.format(ind.value)}${ind.unit ? ` ${ind.unit}` : ''}`;
  return (
    <div style={{ padding: '10px', background: 'var(--bg3)', borderRadius: 10, textAlign: 'center' }}>
      <div style={{ fontSize: 11, color: 'var(--t3)' }}>{ind?.label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: has ? 'var(--t1)' : 'var(--t3)', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      <div style={{ fontSize: 11, fontWeight: 500, marginTop: 2, color: subColor }}>{sub}</div>
    </div>
  );
}

export default function MacroPanel() {
  const [indicators, setIndicators] = useState(null);
  const [foreignFlow, setForeignFlow] = useState(null);
  const [calendar, setCalendar] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    let alive = true;
    getLiveIndicators().then(data => { if (alive) setIndicators(data); });
    fetchEconCalendar().then(data => { if (alive) setCalendar(data); });
    import('../../utils/foreignFlowEngine.js')
      .then(m => m.fetchMarketForeignFlow())
      .then(data => { if (alive) setForeignFlow(data); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14,
      overflow: 'hidden', marginTop: 14,
    }}>
      <button
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
        style={{
          width: '100%', padding: '12px 14px', border: 'none', cursor: 'pointer',
          background: 'transparent', borderBottom: expanded ? '1px solid var(--border)' : 'none',
          display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'inherit', color: 'var(--t1)',
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600, flex: 1, textAlign: 'left' }}>Makroekonomik takvim</span>
        <span style={{ fontSize: 12, color: 'var(--t3)', transition: 'transform .2s', transform: expanded ? 'rotate(180deg)' : 'none' }}>⌄</span>
      </button>

      {expanded && (
        <div style={{ padding: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 14 }}>
            {!indicators ? (
              <div style={{ gridColumn: 'span 2', textAlign: 'center', padding: 16, color: 'var(--t3)', fontSize: 12 }}>
                Makro veriler yükleniyor…
              </div>
            ) : (
              ['policyRate', 'vix', 'usdtry', 'brent'].map(key => <Tile key={key} kind={key} ind={indicators[key]} />)
            )}
          </div>

          {(() => {
            const todayKey = istanbulDayKey(Date.now());
            const ppk = nextPpkDate(todayKey);
            const ppkDays = ppk ? Math.round((Date.parse(`${ppk}T12:00:00Z`) - Date.parse(`${todayKey}T12:00:00Z`)) / 86400000) : null;
            const ppkLine = ppk && (
              <div style={{ fontSize: 12, color: 'var(--t2)', marginBottom: 10 }}>
                Sıradaki PPK faiz kararı: <b style={{ color: 'var(--t1)' }}>{dayHeading(ppk, todayKey).replace(/^(Bugün|Yarın) · /, '')}</b>
                {ppkDays > 1 ? ` · ${ppkDays} gün sonra` : ppkDays === 1 ? ' · yarın' : ' · bugün 14:00'}
              </div>
            );
            if (!calendar) {
              return <>{ppkLine}<div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 14 }}>Takvim yükleniyor…</div></>;
            }
            if (calendar.unavailable) {
              return (
                <>
                  {ppkLine}
                  <div style={{ fontSize: 12, color: 'var(--yellow)', background: 'var(--bg3)', borderRadius: 10, padding: 10, marginBottom: 14 }}>
                    Takvim alınamadı: {REASON_TEXT[calendar.reason] || calendar.reason}.
                  </div>
                </>
              );
            }
            const { upcoming, recentTr } = selectCalendarView(withPpkDates(calendar.events), todayKey);
            const LIMIT = 10;
            const shown = showAll ? upcoming : upcoming.slice(0, LIMIT);
            const days = [];
            for (const e of shown) {
              const last = days[days.length - 1];
              if (last && last.d === e.d) last.items.push(e); else days.push({ d: e.d, items: [e] });
            }
            return (
              <div style={{ marginBottom: 14 }}>
                {ppkLine}
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t2)', marginBottom: 2 }}>Önümüzdeki 7 gün</div>
                {!upcoming.length && (
                  <div style={{ fontSize: 12, color: 'var(--t3)', padding: '6px 0' }}>Bu aralıkta önemli bir açıklama yok.</div>
                )}
                {days.map(g => (
                  <div key={g.d} style={{ marginTop: 6 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t3)' }}>{dayHeading(g.d, todayKey)}</div>
                    {g.items.map((e, i) => <EventRow key={`${e.d}-${e.t}-${e.c}-${i}`} e={e} />)}
                  </div>
                ))}
                {upcoming.length > LIMIT && (
                  <button
                    type="button"
                    onClick={() => setShowAll(v => !v)}
                    style={{ marginTop: 6, background: 'none', border: 'none', color: 'var(--blue)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}
                  >
                    {showAll ? 'Daha az göster' : `Tümünü göster (${upcoming.length})`}
                  </button>
                )}
                {recentTr.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t2)', marginBottom: 2 }}>Türkiye — son açıklananlar</div>
                    {recentTr.map((e, i) => <EventRow key={`r-${e.d}-${i}`} e={{ ...e, t: shortDay(e.d) }} />)}
                  </div>
                )}
                <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 6 }}>Kaynak: doviz.com ekonomik takvim · PPK: TCMB 2026 takvimi</div>
              </div>
            );
          })()}

          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t2)', marginBottom: 6, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>Yabancı net hisse alımı (TCMB, haftalık)</span>
              {foreignFlow && !foreignFlow.error && Number.isFinite(foreignFlow.latestWeeklyFlow) && (
                <span style={{ color: foreignFlow.latestWeeklyFlow >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {foreignFlow.latestWeeklyFlow > 0 ? '+' : ''}{nf(1).format(foreignFlow.latestWeeklyFlow)} mn $
                </span>
              )}
            </div>
            {!foreignFlow ? (
              <div style={{ fontSize: 12, color: 'var(--t3)', padding: 10, textAlign: 'center', background: 'var(--bg3)', borderRadius: 10, lineHeight: 1.5 }}>
                EVDS anahtarı yok — Ayarlar&apos;dan eklenince görünür (ücretsiz: evds3.tcmb.gov.tr).
                Hisse bazlı yabancı oranı anahtarsız: Piyasa sekmesi.
              </div>
            ) : foreignFlow.error ? (
              <div style={{ fontSize: 12, color: 'var(--red)', padding: 10, textAlign: 'center', background: 'var(--red2)', borderRadius: 10 }}>
                {foreignFlow.error}
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 44 }}>
                {foreignFlow.flows.slice(-8).map((f, i) => {
                  const h = Math.min(40, Math.max(8, Math.abs(f.valueUSD) / 10));
                  return (
                    <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }} title={`${f.date}: $${f.valueUSD}M`}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: f.valueUSD >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {f.valueUSD > 0 ? '+' : ''}{Math.round(f.valueUSD)}
                      </span>
                      <div style={{
                        width: '100%', height: h, borderRadius: 4,
                        background: f.valueUSD >= 0 ? 'rgba(34,197,94,.55)' : 'rgba(239,68,68,.55)',
                      }} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
