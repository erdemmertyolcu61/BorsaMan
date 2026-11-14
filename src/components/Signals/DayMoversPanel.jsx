/**
 * DayMoversPanel — "yarın kim hareket eder?" (v31.54).
 *
 * Kullanıcı isteği: gün içinde büyük hareket yapacak hisseleri seans öncesi bulmak.
 * Ölçüm (scripts/next-session-report.mjs, 257 hisse, görmediği veri):
 *   - HAREKET öngörülebilir: listenin ilk 5'i %62–68 oranında açılışın en az %3 üstünü
 *     görüyor (taban %27).
 *   - YÖN öngörülemiyor: aynı hisselerde "açılışta al, kapanışta sat" net eksi.
 *   - Limit kâr-al kuralı (ilk 3, +%4) saatlik yolda 6 yarıyılın 6'sında artı.
 * Liste AL listesinden bağımsızdır, paper motoru açmaz; burada ileriye doğru ölçülür
 * (moversScorecard.js) — "göster + ölç" politikasının dördüncü katmanı.
 */
import { useEffect, useState } from 'react';
import { DAYTRADE_RULE, NEXT_SESSION_EVIDENCE as EV } from '../../utils/nextSession.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pct0 = (p) => (isNum(p) ? `%${Math.round(p * 100)}` : '—');
const num = (v, d = 1) => (isNum(v) ? v.toFixed(d).replace('.', ',') : '—');
const signed = (v, d = 2) => (isNum(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}%${Math.abs(v).toFixed(d).replace('.', ',')}` : '—');
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

function ForwardLine({ label, s }) {
  if (!s) return null;
  return (
    <div style={{ fontSize: 12, color: 'var(--t2)', lineHeight: 1.6, fontVariantNumeric: 'tabular-nums' }}>
      <span style={{ fontWeight: 600, color: 'var(--t1)' }}>{label}</span>
      {' · '}{s.n} işlem / {s.days} gün
      {' · '}hareket eden %{num(s.movedPct, 0)} <span style={{ color: 'var(--t3)' }}>(model %{num(s.expMovedPct, 0)} bekliyordu)</span>
      {' · '}kârlı işlem %{num(s.winPct, 0)}
      {' · '}işlem başına <span style={{ color: tone(s.avgNet), fontWeight: 600 }}>{signed(s.avgNet)}</span>
      {' · '}artı gün %{num(s.posDayPct, 0)}
      {isNum(s.greenPct) ? <> · yeşil kapatan %{num(s.greenPct, 0)}</> : null}
    </div>
  );
}

export default function DayMoversPanel({ card, onAnalyze }) {
  const movers = useDayMovers();
  const [showRule, setShowRule] = useState(false);
  const R = DAYTRADE_RULE;
  const basis = movers[0]?.basisDay || '';
  const settled = (card?.days || []).filter((d) => d.picks?.some((p) => p.result)).slice(0, 5);
  const grid = { display: 'grid', gridTemplateColumns: '22px minmax(0,1fr) 62px 62px 56px', gap: 6, alignItems: 'center' };

  return (
    <div style={{ margin: '12px 12px 0', padding: 14, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>Gün içi hareket adayları</span>
        {basis && <span style={{ fontSize: 11, color: 'var(--t3)' }}>{dayTxt(basis)} kapanışından sonraki ilk seans için</span>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 }}>
        Açılış fiyatının en az %{R.movePct} üstünü görme olasılığı en yüksek likit hisseler. Yön tahmini değildir ve
        AL listesinden bağımsızdır: bu hisseler çok günlük taşımaya uygun olmayabilir.
      </div>

      {movers.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 10 }}>Liste taramadan sonra oluşur.</div>
      ) : (
        <div style={{ marginTop: 10 }}>
          <div style={{ ...grid, fontSize: 11, color: 'var(--t3)', fontWeight: 600, paddingBottom: 3 }}>
            <span>#</span><span>Hisse</span>
            <span style={{ textAlign: 'right' }} title={`Sonraki seansta zirvenin açılışın en az %${R.movePct} üstüne çıkma olasılığı (taban %${EV.baseMovePct})`}>hareket</span>
            <span style={{ textAlign: 'right' }} title={`Sonraki seansı önceki kapanışın üstünde kapatma olasılığı (taban %${EV.baseGreenPct})`}>yeşil</span>
            <span style={{ textAlign: 'right' }} title="14 günlük ortalama gerçek aralık, fiyatın yüzdesi">ATR</span>
          </div>
          {movers.map((m) => (
            <div key={m.symbol} style={{
              ...grid, fontSize: 13, padding: '6px 0', borderTop: '1px solid var(--border)',
              fontVariantNumeric: 'tabular-nums', opacity: m.rank <= R.topN ? 1 : 0.62,
            }}>
              <span style={{ color: 'var(--t3)', fontSize: 12 }}>{m.rank}</span>
              <span style={{ minWidth: 0, display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <button type="button" onClick={() => onAnalyze && onAnalyze(m.symbol)}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
                  {m.symbol}
                </button>
                {m.limitUpClose && <span style={{ fontSize: 11, color: 'var(--yellow)' }} title="Son seansı tavanda kapattı: açılış tavandan gelirse emir dolmayabilir, tavan bozulursa sert döner.">tavan kapattı</span>}
              </span>
              <span style={{ textAlign: 'right', fontWeight: 600, color: 'var(--t1)' }}>{pct0(m.pMove)}</span>
              <span style={{ textAlign: 'right', color: 'var(--t2)' }}>{pct0(m.pGreen)}</span>
              <span style={{ textAlign: 'right', color: 'var(--t2)' }}>%{num(m.atrPct)}</span>
            </div>
          ))}
          <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 6 }}>
            Kural ilk {R.topN} hissede ölçüldü; {R.topN + 1}–{R.shownN}. sıralar bilgi içindir (ilk 10'da avantaj yok).
          </div>
        </div>
      )}

      <button type="button" onClick={() => setShowRule((v) => !v)}
        style={{ marginTop: 10, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, color: 'var(--blue)' }}>
        {showRule ? 'Ölçülen kuralı gizle' : 'Ölçülen kural ve riskler'}
      </button>
      {showRule && (
        <div style={{ fontSize: 12, color: 'var(--t2)', lineHeight: 1.6, marginTop: 6 }}>
          <div><b>Kural:</b> ilk {R.topN} hisse · açılışta alış · +%{R.takeProfitPct} seviyesine limit satış · dolmazsa kapanışta satış.</div>
          <div style={{ marginTop: 4 }}>
            <b>Ölçüm</b> ({EV.period}, modelin görmediği hisseler, saatlik fiyat yolu, %{String(R.costPct).replace('.', ',')} maliyet sonrası):
            işlem başına net {signed(EV.hourly.avgNet)}, işlemlerin %{EV.hourly.winPct}'ü kârlı, günlerin %{EV.hourly.posDayPct}'i artı,
            {' '}{EV.hourly.halves} yarıyılın {EV.hourly.halvesPositive}'sında artı. Öğlene kadar hedef gelmediyse çıkmak aynı getiriyi daha az dalgalanmayla verdi.
          </div>
          <div style={{ marginTop: 4 }}>
            <b>Riskler:</b> en kötü %5 işlem {signed(EV.hourly.p5, 0)}'den fazla kaybetti, en kötü gün {signed(EV.hourly.worstDay, 0)}.
            Dar stop (%3–4) sonucu eksiye çeviriyor; %{R.wideStopPct} stop getiriyi {signed(EV.hourly.withWideStop)}'e indirip en kötü işlemi sınırlıyor.
            Kâr-al koymadan kapanışa kadar beklemek kazandırmıyor ({signed(EV.daily.openToClose)}). Liste çoğunlukla tavan serisindeki
            hisselerden oluşur: sığ tahta, sert dönüş ve işlem tedbiri riski yüksektir.
          </div>
          <div style={{ marginTop: 4, color: 'var(--t3)' }}>
            Geçmiş ölçümdür, getiri vaadi ya da yatırım tavsiyesi değildir. Aşağıdaki ileri ölçüm aynı kuralı bu cihazda kaydedilen listelerle sınar.
          </div>
        </div>
      )}

      <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t1)', marginBottom: 4 }}>İleri ölçüm (kâr-al +%{R.takeProfitPct}, resmi günlük barla)</div>
        {card?.summary?.top || card?.summary?.shown ? (
          <>
            <ForwardLine label={`İlk ${R.topN}`} s={card.summary.top} />
            <ForwardLine label={`İlk ${R.shownN}`} s={card.summary.shown} />
            {(card.summary.top?.n || 0) < 30 && (
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>Örnek küçük — 30 işlemden önce bir şey söylemez.</div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--t3)' }}>Henüz yerleşmiş gün yok — ilk sonuç listenin yargılandığı seansın kapanışından sonra yazılır.</div>
        )}
        {settled.map((d) => (
          <div key={d.basisDay} style={{ fontSize: 12, color: 'var(--t2)', marginTop: 6, lineHeight: 1.6, fontVariantNumeric: 'tabular-nums' }}>
            <span style={{ color: 'var(--t3)' }}>{dayTxt(d.picks.find((p) => p.result)?.result?.day || d.basisDay)}</span>{' '}
            {d.picks.filter((p) => p.result).map((p) => (
              <span key={p.symbol} style={{ marginRight: 10, whiteSpace: 'nowrap', opacity: p.rank <= R.topN ? 1 : 0.62 }}>
                {p.symbol}{' '}
                {p.result.locked
                  ? <span style={{ color: 'var(--t3)' }}>kilitli</span>
                  : <span style={{ color: tone(p.result.netPct), fontWeight: 600 }}>{signed(p.result.netPct, 1)}</span>}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
