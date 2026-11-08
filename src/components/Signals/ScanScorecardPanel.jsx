// ── Tahmin karnesi (v31.47) ────────────────────────────────────────────────
// "Sabah tarattigim hisseler bugun ne kadar artti / azaldi" + gecmis gunler.
// Veri: hooks/useScanScorecard → utils/scanScorecard (saf, testli).
import { useState } from 'react';
import { summarizeDay, FOLLOW_SESSIONS } from '../../utils/scanScorecard.js';

const nf2 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmtPct(v) {
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}%${nf2.format(Math.abs(v))}`;
}
const fmtPrice = (v) => (Number.isFinite(v) ? nf2.format(v) : '—');
const toneOf = (v) => (!Number.isFinite(v) || v === 0 ? 'var(--t2)' : v > 0 ? 'var(--green)' : 'var(--red)');

function dayLabel(day, opts = { weekday: 'long', day: 'numeric', month: 'long' }) {
  try {
    return new Date(`${day}T12:00:00Z`).toLocaleDateString('tr-TR', { ...opts, timeZone: 'Europe/Istanbul' });
  } catch { return day; }
}
function timeLabel(ts) {
  if (!Number.isFinite(ts)) return '';
  try {
    return new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' });
  } catch { return ''; }
}

const STATUS = {
  final:   { text: 'Kesin · resmi kapanış', fg: 'var(--green)' },
  closing: { text: 'Kapanış · resmi bar bekleniyor', fg: 'var(--yellow)' },
  live:    { text: 'Seans sürüyor · anlık', fg: 'var(--blue)' },
  pending: { text: 'Seans bekleniyor', fg: 'var(--t3)' },
};

function Stat({ label, value, tone }) {
  return (
    <div style={{ flex: 1, minWidth: 0, background: 'var(--bg3)', borderRadius: 10, padding: '10px 8px', textAlign: 'center' }}>
      <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: tone || 'var(--t1)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

function PickRow({ p, onAnalyze, showFollow }) {
  const r = p.result;
  const tags = [];
  if (p.watchOnly) tags.push('izle');
  if (p.bestOfDay) tags.push('günün adayı');
  if (p.when === 'before') tags.push('seans öncesi');
  if (r?.hitTarget) tags.push('hedefe değdi');
  if (r?.hitStop) tags.push('stop seviyesine indi');
  const d1 = r?.follow?.[0]?.pct;
  const d5 = r?.follow?.[FOLLOW_SESSIONS - 1]?.pct;
  return (
    <button
      type="button"
      onClick={() => onAnalyze && onAnalyze(p.symbol)}
      style={{
        display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '10px 2px',
        background: 'none', border: 'none', borderTop: '1px solid var(--border)', cursor: 'pointer',
        textAlign: 'left', fontFamily: 'inherit', color: 'var(--t1)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>{p.symbol}</span>
          <span style={{ fontSize: 11, color: 'var(--t3)' }}>{timeLabel(p.ts)}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
          {fmtPrice(p.refPrice)} → {r ? fmtPrice(r.close) : '…'}
          {r && Number.isFinite(r.dayPct) && <span style={{ color: 'var(--t3)' }}> · gün {fmtPct(r.dayPct)}</span>}
          {r && Number.isFinite(r.highPct) && <span style={{ color: 'var(--t3)' }}> · en yüksek {fmtPct(r.highPct)}</span>}
        </div>
        {showFollow && (Number.isFinite(d1) || Number.isFinite(d5)) && (
          <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
            Sonra: 1G <span style={{ color: toneOf(d1) }}>{fmtPct(d1)}</span>
            {' · '}5G <span style={{ color: toneOf(d5) }}>{fmtPct(d5)}</span>
          </div>
        )}
        {tags.length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
            {tags.map(t => (
              <span key={t} style={{ fontSize: 10, color: 'var(--t2)', background: 'var(--bg3)', borderRadius: 6, padding: '1px 6px' }}>{t}</span>
            ))}
          </div>
        )}
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color: toneOf(r?.pct), fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {r ? fmtPct(r.pct) : <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--t3)' }}>bekleniyor</span>}
      </div>
    </button>
  );
}

function DaySummary({ s }) {
  return (
    <>
      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        <Stat label="Yükselen" value={s.up} tone={s.up ? 'var(--green)' : undefined} />
        <Stat label="Düşen" value={s.down} tone={s.down ? 'var(--red)' : undefined} />
        <Stat label="Ortalama" value={fmtPct(s.avgPct)} tone={toneOf(s.avgPct)} />
        <Stat label="BIST100" value={fmtPct(s.benchPct)} tone={toneOf(s.benchPct)} />
      </div>
      {Number.isFinite(s.vsBench) && (
        <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 8 }}>
          Öneriler endeksin <b style={{ color: toneOf(s.vsBench) }}>{nf2.format(Math.abs(s.vsBench))} puan {s.vsBench >= 0 ? 'üstünde' : 'altında'}</b> kapattı.
        </div>
      )}
    </>
  );
}

export default function ScanScorecardPanel({ scorecard, onAnalyze }) {
  const [openDay, setOpenDay] = useState(null);
  const days = scorecard?.days || [];
  const featured = scorecard?.featured || null;

  const card = {
    background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14,
    padding: 14, margin: '12px 12px 0',
  };

  if (!featured) {
    return (
      <section style={card}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>Tahmin karnesi</div>
        <div style={{ fontSize: 13, color: 'var(--t2)', marginTop: 6, lineHeight: 1.5 }}>
          Henüz kayıtlı tarama yok. Tarama yaptığında önerilen hisseler buraya yazılır;
          seans kapandıktan sonra her birinin günü nasıl kapattığını görürsün.
        </div>
      </section>
    );
  }

  const s = summarizeDay(featured);
  const st = STATUS[s.status] || STATUS.pending;
  const history = days.filter(d => d.day !== featured.day && d.picks.length);
  const isPastDay = featured.picks.some(p => p.result?.follow?.length);

  return (
    <section style={card}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Tahmin karnesi</div>
          <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 2 }}>
            {dayLabel(featured.day)} · {s.n} öneri
          </div>
        </div>
        <span style={{ fontSize: 11, fontWeight: 600, color: st.fg, background: 'var(--bg3)', borderRadius: 999, padding: '3px 10px', whiteSpace: 'nowrap' }}>
          {st.text}
        </span>
      </div>

      {s.measured > 0 && <DaySummary s={s} />}

      <div style={{ marginTop: 10 }}>
        {featured.picks.map(p => <PickRow key={p.symbol} p={p} onAnalyze={onAnalyze} showFollow={isPastDay} />)}
      </div>

      {history.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t2)', marginBottom: 4 }}>Geçmiş günler</div>
          {history.map(d => {
            const hs = summarizeDay(d);
            const open = openDay === d.day;
            return (
              <div key={d.day} style={{ borderTop: '1px solid var(--border)' }}>
                <button
                  type="button"
                  onClick={() => setOpenDay(open ? null : d.day)}
                  aria-expanded={open}
                  style={{
                    display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '10px 2px',
                    background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                    color: 'var(--t1)', textAlign: 'left',
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{dayLabel(d.day, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
                    <span style={{ fontSize: 12, color: 'var(--t3)' }}>
                      {' · '}{hs.n} öneri
                      {hs.measured > 0 && <> · <span style={{ color: 'var(--green)' }}>{hs.up}↑</span> <span style={{ color: 'var(--red)' }}>{hs.down}↓</span></>}
                      {Number.isFinite(hs.avgD5) && <> · 5G {fmtPct(hs.avgD5)}</>}
                    </span>
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: toneOf(hs.avgPct), fontVariantNumeric: 'tabular-nums' }}>
                    {hs.measured > 0 ? fmtPct(hs.avgPct) : <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--t3)' }}>bekleniyor</span>}
                  </span>
                  <span style={{ color: 'var(--t3)', fontSize: 12, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>⌄</span>
                </button>
                {open && (
                  <div style={{ paddingBottom: 6 }}>
                    {hs.measured > 0 && <DaySummary s={hs} />}
                    <div style={{ marginTop: 6 }}>
                      {d.picks.map(p => <PickRow key={p.symbol} p={p} onAnalyze={onAnalyze} showFollow />)}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 12, lineHeight: 1.5 }}>
        Değişim, önerinin ilk göründüğü fiyattan kapanışa ölçülür. Seans öncesi önerilerde bu fiyat
        bir önceki kapanıştır. Ortalama eşit ağırlıklıdır, portföy getirisi değildir.
      </div>
    </section>
  );
}
