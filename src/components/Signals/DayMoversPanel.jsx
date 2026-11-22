/**
 * DayMoversPanel — "yarın hareketli olabilecek hisseler" (v31.54, sadeleştirildi v31.57).
 *
 * Kullanıcı (22.11): "gün içi adaylar bayadır çalışıyor, orayı daha basit, anlaşılır yap".
 * Eski panel bir sütun tablosu (hareket / yeşil / ATR), ayrıntılı ölçüm metni ve yoğun ileri
 * ölçüm satırları gösteriyordu. Şimdi: ilk 3 hisse ve tek bir ihtimal, üç adımlık kural,
 * tek cümlelik geçmiş ve bu telefonda biriken sonuç. Ayrıntı "Gün gün" altında.
 *
 * Liste AL listesinden bağımsızdır, paper motoru açmaz (nextSession.rankMovers); ileri ölçüm
 * moversScorecard.js — "göster + ölç" politikasının parçası.
 */
import { useEffect, useState } from 'react';
import { DAYTRADE_RULE as R, NEXT_SESSION_EVIDENCE as EV } from '../../utils/nextSession.js';
import { wasTaken, summarizeMovers } from '../../utils/moversScorecard.js';
import { MOVERS_FORWARD_PLAN as PLAN, moversVerdict, verdictText } from '../../utils/forwardVerdict.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pct0 = (p) => (isNum(p) ? `%${Math.round(p * 100)}` : '—');
const num1 = (v) => (isNum(v) ? v.toFixed(1).replace('.', ',') : '—');
const signed = (v, d = 1) => (isNum(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}%${Math.abs(v).toFixed(d).replace('.', ',')}` : '—');
const tone = (v) => (isNum(v) && v > 0 ? 'var(--green)' : isNum(v) && v < 0 ? 'var(--red)' : 'var(--t3)');
const dayTxt = (k) => (k && k.length >= 10 ? `${k.slice(8, 10)}.${k.slice(5, 7)}` : '');

function readStored() {
  try {
    const d = JSON.parse(localStorage.getItem('bist_last_ai_picks') || '{}');
    return Array.isArray(d?.movers) ? d.movers : [];
  } catch { return []; }
}

/** Son taramanın hareket listesi (kayıttan + canlı tarama olayından). */
export function useDayMovers() {
  const [movers, setMovers] = useState(readStored);
  useEffect(() => {
    const handler = (e) => { if (Array.isArray(e?.detail?.movers)) setMovers(e.detail.movers); };
    window.addEventListener('advisor-scan-complete', handler);
    return () => window.removeEventListener('advisor-scan-complete', handler);
  }, []);
  return movers;
}

function outcomeText(res) {
  if (!res) return { text: 'bekliyor', color: 'var(--t3)' };
  if (res.locked) return { text: 'tavanda kilitli, alınamadı', color: 'var(--t3)' };
  if (res.skipped) return { text: `açılış ${signed(res.gapPct)} — alınmadı`, color: 'var(--t3)' };
  if (!wasTaken(res)) return { text: '—', color: 'var(--t3)' };
  return { text: `${signed(res.netPct)}${res.hit ? ' (+%4 satıldı)' : ' (kapanışta)'}`, color: tone(res.netPct) };
}

export default function DayMoversPanel({ card, onAnalyze }) {
  const movers = useDayMovers();
  const [showDays, setShowDays] = useState(false);
  const basis = movers[0]?.basisDay || '';
  const top = movers.filter((m) => m.rank <= R.topN);
  const rest = movers.filter((m) => m.rank > R.topN);
  const s = card?.summary?.top || null;
  const settledDays = (card?.days || []).filter((d) => d.picks?.some((p) => p.result)).slice(0, 7);
  const gapTxt = num1(R.maxGapPct);
  // v31.60: onceden yazilmis ileri olcum plani — yalniz dondurulmus modelin gormedigi seanslar
  const planS = summarizeMovers((card?.days || []).filter((d) => d.basisDay >= PLAN.firstBasisDay)).top;
  const planV = moversVerdict({ sessions: planS?.days || 0, avgNet: planS?.avgNet ?? null, dayT: planS?.dayT ?? null });
  const planTone = planV.stage === 'belowBand' || planV.stage === 'failing' ? 'var(--red)' : planV.stage === 'consistent' ? 'var(--green)' : 'var(--t3)';

  return (
    <div style={{ margin: '12px 12px 0', padding: 14, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>Yarın hareketli olabilecek hisseler</span>
        {basis && <span style={{ fontSize: 11, color: 'var(--t3)' }}>{dayTxt(basis)} kapanışına göre</span>}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--t2)', marginTop: 4, lineHeight: 1.5 }}>
        Gün içinde açılış fiyatının en az %{R.movePct} üstüne çıkma ihtimali en yüksek hisseler.
        {' '}Yükseleceğini ya da düşeceğini söylemez — kâr, aşağıdaki kuralla alınır.
      </div>

      {top.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 12 }}>Liste ilk taramadan sonra oluşur.</div>
      ) : (
        <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
          {top.map((m) => (
            <div key={m.symbol} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', minWidth: 0,
              background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8,
            }}>
              <span style={{ width: 20, height: 20, borderRadius: 10, background: 'var(--bg4)', color: 'var(--t2)', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{m.rank}</span>
              <button type="button" onClick={() => onAnalyze && onAnalyze(m.symbol)}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 15, fontWeight: 700, color: 'var(--t1)', flexShrink: 0 }}>
                {m.symbol}
              </button>
              <span style={{ fontSize: 12.5, color: 'var(--t2)', minWidth: 0 }}>
                hareket ihtimali <b style={{ color: 'var(--t1)' }}>{pct0(m.pMove)}</b>
              </span>
              {m.limitUpClose && (
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--yellow)', whiteSpace: 'nowrap' }}>dün tavan kapattı</span>
              )}
            </div>
          ))}
          {rest.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--t3)' }}>
              Sıradakiler: {rest.map((m) => `${m.symbol} ${pct0(m.pMove)}`).join(' · ')}
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--bg3)', borderRadius: 8, fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.6 }}>
        <div style={{ fontWeight: 600, color: 'var(--t1)', marginBottom: 2 }}>Nasıl kullanılır</div>
        <div>1. Açılış fiyatına bak. Dünkü kapanışa göre <b>%{gapTxt} ya da daha fazla</b> yukarıdaysa <b>alma</b>: o gün +%{R.takeProfitPct} satış tavanın üstünde kalır, gerçekleşemez.</div>
        <div>2. Açılışta al, hemen <b>+%{R.takeProfitPct}</b>'e satış emri koy.</div>
        <div>3. Satış gerçekleşmezse <b>kapanışta</b> sat.</div>
        <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--t3)' }}>
          Geçmişte ({EV.period}, modelin görmediği hisseler, %{String(R.costPct).replace('.', ',')} maliyet sonrası): işlem başına ortalama {signed(EV.daily.avgNet, 2)},
          {' '}kârlı işlem oranı %{EV.daily.winPct}. Kötü günlerde tek işlemde −%{Math.abs(Math.round(EV.daily.p5))} ve daha büyük kayıplar görüldü; dar zarar-kes emri sonucu bozuyor.
          {' '}Getiri vaadi ya da yatırım tavsiyesi değildir.
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--t1)' }}>Bu telefondaki sonuçlar (ilk {R.topN})</div>
        {s && (s.n > 0 || s.locked > 0 || s.skipped > 0) ? (
          <div style={{ fontSize: 12.5, color: 'var(--t2)', marginTop: 3, lineHeight: 1.6, fontVariantNumeric: 'tabular-nums' }}>
            {s.n > 0 ? (
              <>
                {s.days} gün · {s.n} işlem · {s.wins} kârlı · işlem başına ortalama{' '}
                <b style={{ color: tone(s.avgNet) }}>{signed(s.avgNet, 2)}</b>
              </>
            ) : 'Henüz alınabilen işlem yok'}
            {(s.locked > 0 || s.skipped > 0) && (
              <span style={{ color: 'var(--t3)' }}>
                {' '}({[s.locked > 0 ? `${s.locked} tavanda kilitli` : null, s.skipped > 0 ? `${s.skipped} açılış sınırı yüzünden alınmadı` : null].filter(Boolean).join(', ')})
              </span>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 3 }}>
            İlk sonuç, listenin yargılandığı seansın kapanışından sonra yazılır (uygulama o akşam açılmalı).
          </div>
        )}
        <div style={{ fontSize: 11.5, color: planTone, marginTop: 4, lineHeight: 1.5 }}>
          Ölçüm planı ({dayTxt(PLAN.firstSession)} seansından beri{planS?.n ? `, ${planS.n} işlem, ortalama ${signed(planS.avgNet, 2)}` : ''}): {verdictText(planV, planS?.days || 0)}
        </div>
        {settledDays.length > 0 && (
          <button type="button" onClick={() => setShowDays((v) => !v)}
            style={{ marginTop: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, color: 'var(--blue)' }}>
            {showDays ? 'Gün gün sonuçları gizle' : 'Gün gün sonuçlar'}
          </button>
        )}
        {showDays && settledDays.map((d) => (
          <div key={d.basisDay} style={{ marginTop: 6, fontSize: 12, lineHeight: 1.6 }}>
            <div style={{ color: 'var(--t3)' }}>{dayTxt(d.picks.find((p) => p.result)?.result?.day || '')} seansı ({dayTxt(d.basisDay)} listesi)</div>
            {d.picks.filter((p) => p.rank <= R.topN).map((p) => {
              const o = outcomeText(p.result);
              return (
                <div key={p.symbol} style={{ display: 'flex', gap: 8 }}>
                  <span style={{ width: 54, color: 'var(--t2)', fontWeight: 600 }}>{p.symbol}</span>
                  <span style={{ color: o.color, fontVariantNumeric: 'tabular-nums' }}>{o.text}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
