/**
 * AlListPanel — AL listesi, hareket listesi gibi (v31.59).
 *
 * Kullanıcı (22.11): "AL listesini hareket listesi gibi iyileştirelim" → "Evet, sadeleştir".
 * Öğrenen bir sıralayıcı AL havuzunda tutmadı (scripts/swing-ranker-study.mjs), bu yüzden sıra
 * aynı; değişen sunum: kapanıştan sonra kurulan listenin ilk 3'ü, tek bir açık kural (açılışta al,
 * yalnız trailing stop — paper ile aynı), dürüst bir geçmiş cümlesi ve bu telefondaki sonuç.
 * İleri ölçüm alListScorecard.js; skora, sıraya, paper'a geri dönmez.
 */
import { useState } from 'react';
import { AL_RULE as R, AL_LIST_EVIDENCE as EV } from '../../utils/alListScorecard.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const nf2 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const price = (v) => (isNum(v) ? nf2.format(v) : '—');
const signed = (v, d = 1) => (isNum(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}%${Math.abs(v).toFixed(d).replace('.', ',')}` : '—');
const tone = (v) => (isNum(v) && v > 0 ? 'var(--green)' : isNum(v) && v < 0 ? 'var(--red)' : 'var(--t3)');
const dayTxt = (k) => (k && k.length >= 10 ? `${k.slice(8, 10)}.${k.slice(5, 7)}` : '');
const pctTxt = (v) => String(v).replace('.', ',');

function outcomeText(p) {
  const res = p.result;
  if (p.watchOnly) return { text: 'izle listesinde — alınmadı', color: 'var(--t3)' };
  if (!res) return { text: 'bekliyor', color: 'var(--t3)' };
  if (res.status === 'skipped') return { text: 'açılış stop\'un altında — alınmadı', color: 'var(--t3)' };
  const approx = res.approxEntry ? ' · açılış yaklaşık' : '';
  if (res.status === 'open') return { text: `sürüyor ${signed(res.netPct)} · ${res.sessions}. seans${approx}`, color: tone(res.netPct) };
  const why = res.exitReason === 'stop' ? 'stop' : `${R.maxSessions} seans doldu`;
  return { text: `${signed(res.netPct)} · ${res.sessions} seans · ${why}${approx}`, color: tone(res.netPct) };
}

export default function AlListPanel({ card, onAnalyze }) {
  const [showDays, setShowDays] = useState(false);
  const days = card?.days || [];
  const latest = days[0] || null;
  const top = latest?.picks || [];
  const rest = latest?.next || [];
  const s = card?.summary || null;
  const settledDays = days.filter((d) => d.picks?.some((p) => p.result)).slice(0, 7);
  const allWatch = top.length > 0 && top.every((p) => p.watchOnly);
  const someWatch = !allWatch && top.some((p) => p.watchOnly);

  return (
    <div style={{ margin: '12px 12px 0', padding: 14, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>Birkaç gün tutulacak AL adayları</span>
        {latest && <span style={{ fontSize: 11, color: 'var(--t3)' }}>{dayTxt(latest.basisDay)} kapanışına göre</span>}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--t2)', marginTop: 4, lineHeight: 1.5 }}>
        Kapanıştan sonra kurulan AL listesinin ilk {R.topN} hissesi. Sonraki seansın açılışında alınır, satışı
        {' '}stop belirler. Ölçümde sıra iyi adayı kötüden ayırmadı; kazancı kural korur.
      </div>

      {top.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 12 }}>
          Liste akşam kapanış taramasından sonra oluşur (seans içindeki taramalar kaydedilmez).
        </div>
      ) : (
        <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
          {top.map((p) => {
            const stopPct = isNum(p.stop) && isNum(p.ref) && p.ref > 0 ? (p.stop / p.ref - 1) * 100 : null;
            return (
              <div key={p.symbol} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', minWidth: 0,
                background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8,
              }}>
                <span style={{ width: 20, height: 20, borderRadius: 10, background: 'var(--bg4)', color: 'var(--t2)', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{p.rank}</span>
                <button type="button" onClick={() => onAnalyze && onAnalyze(p.symbol)}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 15, fontWeight: 700, color: 'var(--t1)', flexShrink: 0 }}>
                  {p.symbol}
                </button>
                <span style={{ fontSize: 12.5, color: 'var(--t2)', minWidth: 0, fontVariantNumeric: 'tabular-nums' }}>
                  stop <b style={{ color: 'var(--t1)' }}>{price(p.stop)}</b>
                  {isNum(stopPct) && <span style={{ color: 'var(--t3)' }}> ({signed(stopPct)})</span>}
                </span>
                {p.watchOnly && (
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--yellow)', whiteSpace: 'nowrap' }}>izle, alım değil</span>
                )}
              </div>
            );
          })}
          {rest.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--t3)' }}>
              Sıradakiler: {rest.map((m) => m.symbol).join(' · ')}
            </div>
          )}
          {allWatch && (
            <div style={{ fontSize: 12, color: 'var(--yellow)', lineHeight: 1.5 }}>
              {latest.regime === 'BEAR'
                ? 'Piyasa düşüş rejiminde: liste yalnız izlemek için, alım önerilmez (paper da açmaz).'
                : 'Bugün gerçek AL yok: liste yalnız izlemek için tamamlandı, alım önerilmez.'}
            </div>
          )}
          {someWatch && (
            <div style={{ fontSize: 12, color: 'var(--t3)', lineHeight: 1.5 }}>
              "İzle" işaretli hisse listeyi tamamlamak için gösterilir, alınmaz.
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--bg3)', borderRadius: 8, fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.6 }}>
        <div style={{ fontWeight: 600, color: 'var(--t1)', marginBottom: 2 }}>Nasıl kullanılır</div>
        <div>1. Seansın açılışına bak. Açılış <b>stop seviyesinin altındaysa alma</b>.</div>
        <div>2. Açılışta al, stop seviyesine zarar-kes emri koy.</div>
        <div>3. Kâr <b>+%{R.breakevenPct}</b>'e ulaşınca stop'u alış fiyatına çek. <b>+%{R.trailActivePct}</b>'i geçince stop'u kazancın yarısına çek ve en yüksek fiyat yükseldikçe yukarı taşı.</div>
        <div>4. Hedefte satma: stop'a değince sat, en fazla <b>{R.maxSessions} seans</b> tut.</div>
        <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--t3)' }}>
          Geçmişte ({EV.period}, %{pctTxt(R.costPct)} maliyet sonrası) listenin ilk {R.topN}'ü bu kuralla işlem başına ortalama {signed(EV.top3AvgNet, 2)} getirdi;
          {' '}tüm AL adaylarının ortalaması {signed(EV.poolAvgNet, 2)}. Kârlı işlem oranı %{EV.top3WinPct}: kazançlar az ama büyük, kayıplar çok ama stop'la sınırlı
          {' '}(en kötü %5 işlem {signed(EV.top3P5)}). Getiri yıldan yıla azaldı: 2022'de {signed(EV.poolByYear[2022])}, 2025'te {signed(EV.poolByYear[2025])},
          {' '}2026'da {signed(EV.poolByYear[2026])}. Getiri vaadi ya da yatırım tavsiyesi değildir.
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--t1)' }}>Bu telefondaki sonuçlar (ilk {R.topN})</div>
        {s ? (
          <div style={{ fontSize: 12.5, color: 'var(--t2)', marginTop: 3, lineHeight: 1.6, fontVariantNumeric: 'tabular-nums' }}>
            {s.closed > 0 ? (
              <div>
                {s.closed} kapanan işlem · {s.wins} kârlı · işlem başına ortalama{' '}
                <b style={{ color: tone(s.avgNet) }}>{signed(s.avgNet, 2)}</b>
              </div>
            ) : <div>Henüz kapanan işlem yok.</div>}
            {s.open > 0 && (
              <div>{s.open} işlem sürüyor · şu an ortalama <span style={{ color: tone(s.avgOpen) }}>{signed(s.avgOpen, 2)}</span> (kesin değil)</div>
            )}
            {(s.skipped > 0 || s.watch > 0) && (
              <div style={{ color: 'var(--t3)' }}>
                {[s.skipped > 0 ? `${s.skipped} hisse açılış stop'un altında olduğu için alınmadı` : null,
                  s.watch > 0 ? `${s.watch} hisse izle listesindeydi` : null].filter(Boolean).join(' · ')}
              </div>
            )}
            {s.closed < 30 && <div style={{ fontSize: 11.5, color: 'var(--t3)' }}>Henüz az veri — 30 kapanan işlemden önce bir şey söylemez.</div>}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 3, lineHeight: 1.5 }}>
            İlk sonuç, listenin alındığı seansın kapanışından sonra yazılır (uygulama o akşam açılmalı).
          </div>
        )}
        {settledDays.length > 0 && (
          <button type="button" onClick={() => setShowDays((v) => !v)}
            style={{ marginTop: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, color: 'var(--blue)' }}>
            {showDays ? 'Gün gün sonuçları gizle' : 'Gün gün sonuçlar'}
          </button>
        )}
        {showDays && settledDays.map((d) => {
          const entryDay = d.picks.find((p) => p.result?.entryDay)?.result?.entryDay || '';
          return (
            <div key={d.basisDay} style={{ marginTop: 6, fontSize: 12, lineHeight: 1.6 }}>
              <div style={{ color: 'var(--t3)' }}>{entryDay ? `${dayTxt(entryDay)} açılışında alınan` : 'Bekleyen'} ({dayTxt(d.basisDay)} listesi)</div>
              {d.picks.map((p) => {
                const o = outcomeText(p);
                return (
                  <div key={p.symbol} style={{ display: 'flex', gap: 8 }}>
                    <span style={{ width: 54, color: 'var(--t2)', fontWeight: 600, flexShrink: 0 }}>{p.symbol}</span>
                    <span style={{ color: o.color, fontVariantNumeric: 'tabular-nums', minWidth: 0 }}>{o.text}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
