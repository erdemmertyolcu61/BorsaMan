/**
 * BacktestPanel — tek hissenin geçmişi (v31.51).
 *
 * Kullanıcı: "backtest kısmını güncelle". Eski panel hedefte tamamını satan bir
 * çıkışla ölçüyordu (sistemin v31.30'da bıraktığı, getirinin yarısını götürdüğü
 * ölçülen kural) ve Monte Carlo sonucuna göre "GİR — sermayenin %10-15'i" gibi
 * öneri veriyordu: hem kişiye özel tavsiye hem de uygulamanın kendi lot kuralıyla
 * (stopta %2 risk, %33 tavan) çelişkili. Şimdi:
 *  - çıkış = canlı kural (planSimulation: iz süren stop, hedefte satış yok, ≤30 bar),
 *  - sonuç sistemin konviksiyon kademelerine göre ayrılır (≥75 / 65–75 / 55–65),
 *  - aynı dönemin al-tut getirisi yanında durur,
 *  - Monte Carlo yalnız dağılımı gösterir, karar vermez.
 */
import { useEffect, useState } from 'react';
import { runBacktest, calcBacktestStats, tierBreakdown, buyAndHoldReturn, BACKTEST_MIN_SCORE } from '../../utils/backtestEngine.js';
import { runBacktestMonteCarlo } from '../../utils/backtestMonteCarlo.js';

const STRATEGIES = [
  { key: 'signal', label: 'Sistem sinyali', min: 25 },
  { key: 'rsi', label: 'RSI', min: 25 },
  { key: 'macd', label: 'MACD', min: 45 },
  { key: 'ma', label: 'MA kesişimi', min: 60 },
];

const TIER_LABEL = { sniper: 'Skor ≥75', flagged: 'Skor 65–75', early: `Skor ${BACKTEST_MIN_SCORE}–65` };
const RESULT_LABEL = { stop: 'Stop', trail: 'İz süren stop (kârda)', timeout: 'Süre doldu (30 bar)' };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pct = (v, d = 1) => (isNum(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}%${Math.abs(v).toFixed(d).replace('.', ',')}` : '—');
const plain = (v, d = 0) => (isNum(v) ? `%${v.toFixed(d).replace('.', ',')}` : '—');
const tone = (v) => (isNum(v) && v > 0 ? 'var(--green)' : isNum(v) && v < 0 ? 'var(--red)' : 'var(--t2)');

function compute(prices, key) {
  const trades = runBacktest(prices, key);
  const stats = calcBacktestStats(trades, prices.length);
  const minIdx = key === 'ma' ? 55 : key === 'macd' ? 40 : 20;
  return { key, trades, stats, tiers: tierBreakdown(trades), bh: buyAndHoldReturn(prices, minIdx), mc: null };
}

function Tile({ label, value, color = 'var(--t1)', sub }) {
  return (
    <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '7px 9px', minWidth: 0 }}>
      <div style={{ fontSize: 10.5, color: 'var(--t3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color, marginTop: 1 }}>{value}</div>
      {sub ? <div style={{ fontSize: 10.5, color: 'var(--t3)' }}>{sub}</div> : null}
    </div>
  );
}

function Pill({ active, onPress, children, disabled }) {
  return (
    <span role="button" tabIndex={disabled ? -1 : 0} aria-pressed={active}
      onClick={() => !disabled && onPress()}
      onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPress(); } }}
      style={{
        padding: '5px 11px', borderRadius: 8, fontSize: 12, cursor: disabled ? 'default' : 'pointer', userSelect: 'none',
        background: active ? 'var(--blue2)' : 'var(--bg3)', color: active ? 'var(--t1)' : 'var(--t2)',
        border: `1px solid ${active ? 'rgba(59,130,246,.45)' : 'var(--border)'}`, opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap',
      }}>{children}</span>
  );
}

export default function BacktestPanel({ prices, symbol }) {
  const data = Array.isArray(prices) ? prices : [];
  const [active, setActive] = useState('signal');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState(null);

  // Hisse değişince eski sonuç başka hisseye ait olur — temizle.
  useEffect(() => { setRes(null); setCompare(null); }, [symbol]);

  const run = (key) => {
    const strat = STRATEGIES.find(s => s.key === key);
    if (!strat || data.length < strat.min) return;
    setActive(key);
    setCompare(null);
    setBusy(true);
    setTimeout(() => {
      try { setRes(compute(data, key)); } finally { setBusy(false); }
    }, 10);
  };

  const runMc = () => {
    if (!res) return;
    setBusy(true);
    setTimeout(() => {
      try { setRes(r => ({ ...r, mc: runBacktestMonteCarlo(r.trades, 1000) })); } finally { setBusy(false); }
    }, 10);
  };

  const runCompare = () => {
    setBusy(true);
    setRes(null);
    setTimeout(() => {
      try {
        setCompare(STRATEGIES.filter(s => data.length >= s.min).map(s => compute(data, s.key)));
      } finally { setBusy(false); }
    }, 10);
  };

  const closed = res ? res.trades.filter(t => t.result !== 'open') : [];
  const s = res?.stats;
  const byResult = res
    ? Object.keys(RESULT_LABEL).map(k => {
      const t = closed.filter(x => x.result === k);
      return { k, n: t.length, avg: t.length ? t.reduce((a, x) => a + x.pnl, 0) / t.length : null };
    }).filter(r => r.n)
    : [];
  const open = res?.trades.find(t => t.result === 'open');
  const years = data.length ? (data.length / 252) : 0;

  return (
    <div className="trade-box fi" style={{ margin: 0 }}>
      <div className="trade-title" style={{ marginBottom: 4 }}>Backtest{symbol ? ` · ${symbol}` : ''}</div>
      <div style={{ fontSize: 11, color: 'var(--t3)', lineHeight: 1.5, marginBottom: 10 }}>
        Son {years >= 1 ? `${years.toFixed(1).replace('.', ',')} yıl` : `${data.length} gün`} · giriş ertesi açılış · çıkış canlı kuralla:
        iz süren stop (+%3 başabaş, +%5 üstü kârın yarısı kilitli), hedefte satış yok, en fazla 30 bar (sistemin ölçüm penceresi) · %0,3 gidiş-dönüş maliyet düşülmüş.
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {STRATEGIES.map(st => (
          <Pill key={st.key} active={!compare && active === st.key && !!res} disabled={busy || data.length < st.min} onPress={() => run(st.key)}>{st.label}</Pill>
        ))}
        <Pill active={!!compare} disabled={busy || data.length < 60} onPress={runCompare}>Karşılaştır</Pill>
      </div>

      {busy && <div style={{ fontSize: 12, color: 'var(--t3)', padding: '10px 0' }}>Hesaplanıyor…</div>}
      {!busy && !res && !compare && (
        <div style={{ fontSize: 12, color: 'var(--t3)', padding: '4px 0' }}>Bir strateji seç — sonuç bu hissenin geçmiş barlarından hesaplanır.</div>
      )}

      {!busy && res && s && (
        <>
          <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', marginBottom: 10 }}>
            <Tile label="İşlem" value={closed.length} sub={open ? '+1 açık' : null} />
            <Tile label="Kazanma oranı" value={plain(s.winRate)} />
            <Tile label="İşlem başına" value={pct(s.expectancy, 2)} color={tone(s.expectancy)} sub="ortalama, net" />
            <Tile label="Kâr faktörü" value={isNum(s.profitFactor) ? s.profitFactor.toFixed(2).replace('.', ',') : '—'} />
            <Tile label="Bileşik getiri" value={pct((s.finalEquity / 10000 - 1) * 100)} color={tone(s.finalEquity - 10000)} sub="tüm sermaye her işlemde" />
            <Tile label="Al-tut (aynı dönem)" value={pct(res.bh)} color={tone(res.bh)} />
            <Tile label="En büyük düşüş" value={plain(s.maxDrawdown)} />
            <Tile label="Ort. tutma" value={closed.length ? `${(closed.reduce((a, t) => a + t.days, 0) / closed.length).toFixed(1).replace('.', ',')} bar` : '—'} />
          </div>

          {byResult.length > 0 && (
            <Table head={['Çıkış', 'İşlem', 'Ort.']} rows={byResult.map(r => [RESULT_LABEL[r.k], r.n, <span key="a" style={{ color: tone(r.avg) }}>{pct(r.avg, 2)}</span>])} />
          )}

          {res.key === 'signal' && (
            <Table head={['Sinyal skoru', 'İşlem', 'Kazanma', 'Ort.']}
              rows={['sniper', 'flagged', 'early'].map(k => [TIER_LABEL[k], res.tiers[k].n, plain(res.tiers[k].winRate), <span key="a" style={{ color: tone(res.tiers[k].avg) }}>{pct(res.tiers[k].avg, 2)}</span>])}
              note="Sistemin ölçümü (piyasa geneli, 5 yıl): yalnız yükseliş rejiminde ve yüksek skorda avantaj pozitif. Tek hissenin az sayıdaki işlemi bunu ne doğrular ne çürütür." />
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
            <Pill active={!!res.mc} disabled={busy || closed.length < 5} onPress={runMc}>{res.mc ? 'Monte Carlo’yu yenile' : 'Monte Carlo (1000 senaryo)'}</Pill>
            {closed.length < 5 && <span style={{ fontSize: 11, color: 'var(--t3)' }}>en az 5 kapanmış işlem gerekir</span>}
          </div>
          {res.mc && <MonteCarlo mc={res.mc} />}
        </>
      )}

      {!busy && compare && (
        <Table head={['Strateji', 'İşlem', 'Kazanma', 'İşlem başına', 'Bileşik', 'Düşüş']}
          rows={compare.map(c => {
            const label = STRATEGIES.find(x => x.key === c.key)?.label;
            const n = c.trades.filter(t => t.result !== 'open').length;
            return [label, n, plain(c.stats.winRate), <span key="e" style={{ color: tone(c.stats.expectancy) }}>{pct(c.stats.expectancy, 2)}</span>,
              <span key="b" style={{ color: tone(c.stats.finalEquity - 10000) }}>{pct((c.stats.finalEquity / 10000 - 1) * 100)}</span>, plain(c.stats.maxDrawdown)];
          })}
          note={`Aynı dönem al-tut: ${pct(compare[0]?.bh)}. Hepsi aynı çıkış kuralıyla; fark yalnız giriş koşulunda.`} />
      )}

      <div style={{ fontSize: 10.5, color: 'var(--t3)', lineHeight: 1.5, marginTop: 10 }}>
        Geçmiş sonuç geleceği garanti etmez ve yatırım tavsiyesi değildir. Lot için uygulamanın tek kuralı geçerli: stopta sermayenin %2’si, pozisyon en fazla %33.
      </div>
    </div>
  );
}

function Table({ head, rows, note }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr>{head.map((h, i) => <th key={h} style={{ textAlign: i ? 'right' : 'left', color: 'var(--t3)', fontWeight: 600, fontSize: 11, padding: '0 6px 5px', whiteSpace: 'nowrap' }}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>{r.map((c, ci) => <td key={ci} style={{ textAlign: ci ? 'right' : 'left', padding: '5px 6px', borderTop: '1px solid var(--border)', color: ci ? 'var(--t1)' : 'var(--t2)', whiteSpace: 'nowrap' }}>{c}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      {note && <div style={{ fontSize: 10.5, color: 'var(--t3)', marginTop: 5, lineHeight: 1.5 }}>{note}</div>}
    </div>
  );
}

function MonteCarlo({ mc }) {
  const fe = mc.finalEquity, dd = mc.maxDrawdown;
  const k = (v) => `${(v / 1000).toFixed(1).replace('.', ',')}K`;
  return (
    <div style={{ marginTop: 8 }}>
      <Table head={['10.000 TL ile başlayan', '%5', 'Medyan', '%95']}
        rows={[
          ['Son bakiye', k(fe.p5), k(fe.median), k(fe.p95)],
          ['En büyük düşüş', plain(dd.p95), plain(dd.median), plain(dd.p5)],
          ['Kazanma oranı', plain(mc.winRate.p5), plain(mc.winRate.median), plain(mc.winRate.p95)],
        ]}
        note={`${mc.simulations} senaryo, geçmiş işlemlerden rastgele yeniden örneklenerek: senaryoların ${plain(mc.profitProb)}’i kârda bitti, ${plain(mc.ruinProb, 1)}’i sermayenin %20’sinden fazlasını kaybederek bitti. Bu bir dağılım; karar değil.`} />
    </div>
  );
}
