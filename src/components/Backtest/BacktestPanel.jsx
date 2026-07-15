import { useState } from 'react';
import { runBacktest, calcBacktestStats } from '../../utils/backtestEngine.js';
import { runBacktestMonteCarlo } from '../../utils/backtestMonteCarlo.js';

const STRATEGIES = [
  { key: 'signal', label: 'Sinyal', color: '#00e5ff' },
  { key: 'rsi', label: 'RSI', color: '#ff9800' },
  { key: 'macd', label: 'MACD', color: '#e040fb' },
  { key: 'ma', label: 'MA Cross', color: '#76ff03' },
];

export default function BacktestPanel({ prices, symbol, gData }) {
  const data = prices || gData;
  const [active, setActive] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [mcLoading, setMcLoading] = useState(false);
  const [compareResult, setCompareResult] = useState(null);
  const [compareLoading, setCompareLoading] = useState(false);

  const busy = loading || mcLoading || compareLoading;

  const runSingle = (strategy) => {
    const min = strategy === 'ma' ? 60 : strategy === 'macd' ? 45 : 25;
    if (!data || data.length < min) return;
    setActive(strategy);
    setResult(null);
    setCompareResult(null);
    setLoading(true);
    setTimeout(() => {
      const trades = runBacktest(data, strategy);
      const stats = calcBacktestStats(trades, data.length);
      setResult({ stats, mc: null, strategy, tradeCount: trades.length, trades });
      setLoading(false);
    }, 10);
  };

  const runMC = () => {
    if (!result || !result.trades) return;
    const closed = result.trades.filter(t => t.result !== 'open');
    if (closed.length < 5) return;
    setMcLoading(true);
    setTimeout(() => {
      const mc = runBacktestMonteCarlo(result.trades, 1000);
      setResult(prev => ({ ...prev, mc }));
      setMcLoading(false);
    }, 10);
  };

  const runCompare = () => {
    if (!data || data.length < 60) return;
    setActive(null);
    setResult(null);
    setCompareResult(null);
    setCompareLoading(true);
    setTimeout(() => {
      const results = STRATEGIES.map(({ key }) => {
        const min = key === 'ma' ? 60 : key === 'macd' ? 45 : 25;
        if (data.length < min) return { key, skip: true };
        const trades = runBacktest(data, key);
        const stats = calcBacktestStats(trades, data.length);
        const closed = trades.filter(t => t.result !== 'open');
        const mc = closed.length >= 5 ? runBacktestMonteCarlo(trades, 1000) : null;
        return { key, stats, mc, tradeCount: trades.length };
      });
      const best = results
        .filter(r => r.mc && !r.skip)
        .sort((a, b) => b.mc.profitProb - a.mc.profitProb)[0];
      setCompareResult({ results, bestKey: best?.key });
      setCompareLoading(false);
    }, 10);
  };

  const hasTrades = result && result.trades && result.trades.filter(t => t.result !== 'open').length >= 5;

  return (
    <div className="trade-box fi" style={{ margin: 0 }}>
      <div className="trade-title" style={{ color: 'var(--cyan)', fontSize: 11, fontWeight: 700, marginBottom: 8 }}>
        Backtest & Monte Carlo
      </div>

      {/* Strategy buttons */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
        {STRATEGIES.map(({ key, label, color }) => (
          <button
            key={key}
            className="btn btn-go"
            onClick={() => runSingle(key)}
            disabled={busy}
            style={{
              fontSize: 10, padding: '6px 10px', width: 'auto', flex: '1 1 auto', minWidth: 60,
              background: active === key ? color : 'var(--bg0)',
              color: active === key ? '#000' : 'var(--t2)',
              border: `1px solid ${active === key ? color : 'var(--border)'}`,
              fontWeight: active === key ? 700 : 400,
              opacity: busy ? 0.5 : 1,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* MC + Compare buttons row */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        <button
          className="btn btn-go"
          onClick={runMC}
          disabled={busy || !hasTrades}
          style={{
            fontSize: 10, padding: '7px 0', flex: 1,
            background: !hasTrades ? 'var(--bg2)' : result?.mc ? 'var(--bg2)' : 'linear-gradient(135deg, #8b5cf6, #6366f1)',
            color: !hasTrades ? 'var(--t3)' : '#fff',
            border: '1px solid rgba(139,92,246,0.4)',
            opacity: busy ? 0.5 : !hasTrades ? 0.4 : 1,
          }}
        >
          {mcLoading ? 'MC Hesaplaniyor...' : result?.mc ? '↻ MC Tekrar' : '🎲 Monte Carlo'}
        </button>
        <button
          className="btn btn-go"
          onClick={runCompare}
          disabled={busy || !data || data.length < 60}
          style={{
            fontSize: 10, padding: '7px 0', flex: 1,
            background: compareResult ? 'var(--bg2)' : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            color: '#fff', border: '1px solid rgba(99,102,241,0.4)',
            opacity: busy ? 0.5 : 1,
          }}
        >
          {compareLoading ? 'Karsilastiriliyor...' : '⚔ Karsilastir'}
        </button>
      </div>

      {/* Loading */}
      {(loading || mcLoading || compareLoading) && (
        <div style={{ padding: 16, textAlign: 'center', color: 'var(--cyan)', fontSize: 11 }}>
          {compareLoading ? '4 strateji × 1000 simulasyon hesaplaniyor...' : mcLoading ? '1000 Monte Carlo simulasyonu...' : 'Backtest hesaplaniyor...'}
        </div>
      )}

      {/* Single strategy result */}
      {result && !loading && <SingleResult r={result} />}

      {/* Compare result */}
      {compareResult && !compareLoading && <CompareResults data={compareResult} />}
    </div>
  );
}

function SingleResult({ r }) {
  const { stats: s, mc, strategy } = r;
  const label = STRATEGIES.find(st => st.key === strategy)?.label || strategy;

  return (
    <div>
      {/* Quick stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4, marginBottom: 8 }}>
        <MiniTile label="Islem" value={r.tradeCount} color="var(--cyan)" />
        <MiniTile label="Win Rate" value={`%${(s.winRate || 0).toFixed(0)}`} color={s.winRate >= 55 ? 'var(--green)' : s.winRate >= 45 ? 'var(--yellow)' : 'var(--red)'} />
        <MiniTile label="PF" value={(s.profitFactor || 0).toFixed(2)} color={s.profitFactor >= 1.5 ? 'var(--green)' : 'var(--yellow)'} />
        <MiniTile label="Sharpe" value={(s.sharpeRatio || 0).toFixed(2)} color={s.sharpeRatio >= 1 ? 'var(--green)' : s.sharpeRatio >= 0 ? 'var(--yellow)' : 'var(--red)'} />
      </div>

      {/* Verdict */}
      <div style={{ fontSize: 10, color: s.verdictColor || 'var(--yellow)', fontWeight: 700, padding: 6, borderLeft: `3px solid ${s.verdictColor || 'var(--yellow)'}`, background: 'var(--bg0)', marginBottom: 8, borderRadius: 2 }}>
        {label}: {s.verdict}
      </div>

      {/* MC results */}
      {mc && <MonteCarloResults mc={mc} />}
      {!mc && <div style={{ fontSize: 10, color: 'var(--t3)', padding: 8 }}>Yeterli islem yok (min 5)</div>}
    </div>
  );
}

function CompareResults({ data }) {
  const { results, bestKey } = data;
  const valid = results.filter(r => r.mc && !r.skip);

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#8b5cf6', marginBottom: 8, fontFamily: 'Space Grotesk,sans-serif' }}>
        MC Strateji Karsilastirmasi
      </div>

      {/* Comparison table */}
      <div style={{ background: 'var(--bg0)', borderRadius: 6, border: '1px solid var(--border)', overflow: 'hidden', marginBottom: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9 }}>
          <thead>
            <tr style={{ background: 'var(--bg2)' }}>
              {['Strateji', 'Kar %', 'Yikim %', 'Medyan', 'WR', 'Sharpe'].map(h => (
                <th key={h} style={{ padding: '5px 4px', color: 'var(--t3)', fontSize: 8, textTransform: 'uppercase', textAlign: 'center' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {valid.map(r => {
              const info = STRATEGIES.find(s => s.key === r.key);
              const isBest = r.key === bestKey;
              return (
                <tr key={r.key} style={{ borderBottom: '1px solid var(--border)', background: isBest ? 'rgba(139,92,246,0.08)' : 'transparent' }}>
                  <td style={{ padding: '5px 6px', fontWeight: 700, color: info.color }}>
                    {isBest && <span style={{ marginRight: 3 }}>★</span>}
                    {info.label}
                  </td>
                  <td style={{ padding: '5px 4px', textAlign: 'center', fontWeight: 600, color: r.mc.profitProb >= 60 ? 'var(--green)' : r.mc.profitProb >= 45 ? 'var(--yellow)' : 'var(--red)' }}>
                    %{r.mc.profitProb.toFixed(0)}
                  </td>
                  <td style={{ padding: '5px 4px', textAlign: 'center', color: r.mc.ruinProb <= 5 ? 'var(--green)' : r.mc.ruinProb <= 15 ? 'var(--yellow)' : 'var(--red)' }}>
                    %{r.mc.ruinProb.toFixed(0)}
                  </td>
                  <td style={{ padding: '5px 4px', textAlign: 'center', color: r.mc.finalEquity.median >= 10000 ? 'var(--green)' : 'var(--red)' }}>
                    {(r.mc.finalEquity.median / 1000).toFixed(1)}K
                  </td>
                  <td style={{ padding: '5px 4px', textAlign: 'center' }}>
                    %{r.mc.winRate.median.toFixed(0)}
                  </td>
                  <td style={{ padding: '5px 4px', textAlign: 'center', color: r.mc.sharpe.median >= 1 ? 'var(--green)' : r.mc.sharpe.median >= 0 ? 'var(--yellow)' : 'var(--red)' }}>
                    {r.mc.sharpe.median.toFixed(2)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Best strategy verdict */}
      {bestKey && (() => {
        const best = valid.find(r => r.key === bestKey);
        const info = STRATEGIES.find(s => s.key === bestKey);
        const verdictColor = best.mc.profitProb >= 65 ? 'var(--green)' : best.mc.profitProb >= 50 ? 'var(--yellow)' : 'var(--red)';
        return (
          <div style={{ fontSize: 10, fontWeight: 700, padding: 6, borderLeft: `3px solid ${info.color}`, background: 'var(--bg0)', borderRadius: 2, marginBottom: 8 }}>
            <span style={{ color: info.color }}>★ {info.label}</span>
            <span style={{ color: verdictColor, marginLeft: 6 }}>
              %{best.mc.profitProb.toFixed(0)} kar olasılığı ile en iyi strateji
            </span>
          </div>
        );
      })()}

      {/* Show best strategy MC details */}
      {bestKey && (() => {
        const best = valid.find(r => r.key === bestKey);
        return best?.mc ? <MonteCarloResults mc={best.mc} /> : null;
      })()}
    </div>
  );
}

function getActionAdvice(mc) {
  const pp = mc.profitProb;
  const ruin = mc.ruinProb;
  const pf = mc.profitFactor.median;
  const dd = mc.maxDrawdown.median;

  if (pp >= 70 && ruin <= 5 && pf >= 1.3) {
    return { icon: '✅', label: 'GIR', detail: 'Guclu setup. Sermayenin %10-15\'i ile pozisyon ac.', color: '#10b981', bg: 'rgba(16,185,129,0.08)', lot: '%10-15' };
  }
  if (pp >= 65 && ruin <= 10) {
    return { icon: '✅', label: 'GIR', detail: 'Saglam. Sermayenin %8-10\'u ile gir, stop\'a sadik kal.', color: '#10b981', bg: 'rgba(16,185,129,0.08)', lot: '%8-10' };
  }
  if (pp >= 55 && ruin <= 15) {
    return { icon: '⚠', label: 'DIKKATLI GIR', detail: 'Marjinal avantaj. Kucuk lot (%5). Zarar kesme disiplini sart.', color: '#f59e0b', bg: 'rgba(245,158,11,0.08)', lot: '%5' };
  }
  if (pp >= 50 && ruin <= 20) {
    return { icon: '⚠', label: 'SADECE DENEYIMLI', detail: 'Beklenti zayif. Max %3 sermaye. Stop mutlaka koy.', color: '#f59e0b', bg: 'rgba(245,158,11,0.08)', lot: '%3' };
  }
  if (pp >= 45) {
    return { icon: '❌', label: 'GIRME', detail: 'Kar olasılığı dusuk, yikim riski yuksek. Bu kombinasyonu kullanma.', color: '#ef4444', bg: 'rgba(239,68,68,0.08)', lot: '—' };
  }
  return { icon: '❌', label: 'KESINLIKLE GIRME', detail: `Strateji bu hissede calısmiyor. 1000 senaryonun %${(100 - pp).toFixed(0)}'inde zarar.`, color: '#ef4444', bg: 'rgba(239,68,68,0.08)', lot: '—' };
}

function MonteCarloResults({ mc }) {
  if (!mc) return null;
  const { finalEquity: fe, maxDrawdown: dd, winRate: wr, profitFactor: pf, sharpe: sh } = mc;

  const verdictColor = mc.profitProb >= 65 ? 'var(--green)' : mc.profitProb >= 50 ? 'var(--yellow)' : 'var(--red)';
  const verdictText = mc.profitProb >= 65
    ? 'SAGLAM — Farkli kosullarda da karli'
    : mc.profitProb >= 50
      ? 'MARJINAL — Kar garantisi yok'
      : 'RISKLI — Cogu senaryoda zarar';

  const advice = getActionAdvice(mc);

  return (
    <div style={{ padding: 8, background: 'var(--bg0)', borderRadius: 6, border: '1px solid rgba(139,92,246,0.2)', marginBottom: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#8b5cf6', marginBottom: 6 }}>
        {mc.simulations} Sim × {mc.tradeCount} Islem
      </div>

      <MCEquityBands bands={mc.equityBands} tradeCount={mc.tradeCount} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 4, marginBottom: 6 }}>
        <MCMetric label="Kar %" value={`%${mc.profitProb.toFixed(0)}`} color={mc.profitProb >= 60 ? 'var(--green)' : mc.profitProb >= 45 ? 'var(--yellow)' : 'var(--red)'} />
        <MCMetric label="Yikim %" value={`%${mc.ruinProb.toFixed(1)}`} color={mc.ruinProb <= 5 ? 'var(--green)' : mc.ruinProb <= 15 ? 'var(--yellow)' : 'var(--red)'} />
        <MCMetric label="Medyan" value={`${(fe.median / 1000).toFixed(1)}K`} color={fe.median >= 10000 ? 'var(--green)' : 'var(--red)'} />
      </div>

      <div style={{ fontSize: 8, color: 'var(--t3)', marginBottom: 6 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 1fr', gap: 2, textAlign: 'center', marginBottom: 2 }}>
          <span style={{ fontWeight: 700, color: 'var(--t2)', textAlign: 'left' }}>Metrik</span>
          <span style={{ color: 'var(--red)' }}>%5</span>
          <span style={{ color: 'var(--t1)' }}>Med</span>
          <span style={{ color: 'var(--green)' }}>%95</span>
        </div>
        <MCRow label="Bakiye" v5={`${(fe.p5/1000).toFixed(1)}K`} v50={`${(fe.median/1000).toFixed(1)}K`} v95={`${(fe.p95/1000).toFixed(1)}K`} />
        <MCRow label="Max DD" v5={`%${dd.p95.toFixed(0)}`} v50={`%${dd.median.toFixed(0)}`} v95={`%${dd.p5.toFixed(0)}`} />
        <MCRow label="Win Rate" v5={`%${wr.p5.toFixed(0)}`} v50={`%${wr.median.toFixed(0)}`} v95={`%${wr.p95.toFixed(0)}`} />
        <MCRow label="PF" v5={pf.p5.toFixed(2)} v50={pf.median.toFixed(2)} v95={pf.p95.toFixed(2)} />
      </div>

      <div style={{ fontSize: 9, color: verdictColor, fontWeight: 700, padding: 5, borderLeft: `3px solid ${verdictColor}`, background: 'var(--bg2)', borderRadius: 2, marginBottom: 6 }}>
        {verdictText}
      </div>

      <div style={{ padding: '6px 8px', background: advice.bg, borderRadius: 4, border: `1px solid ${advice.color}33` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 14 }}>{advice.icon}</span>
          <span style={{ fontSize: 11, fontWeight: 800, color: advice.color, letterSpacing: 1 }}>{advice.label}</span>
          {advice.lot !== '—' && (
            <span style={{ fontSize: 8, color: 'var(--t2)', background: 'var(--bg2)', padding: '1px 5px', borderRadius: 3, marginLeft: 'auto' }}>
              Sermaye: {advice.lot}
            </span>
          )}
        </div>
        <div style={{ fontSize: 8, color: 'var(--t2)', lineHeight: 1.4 }}>
          {advice.detail}
        </div>
        <div style={{ fontSize: 7, color: 'var(--t3)', marginTop: 4, borderTop: '1px solid var(--border)', paddingTop: 3 }}>
          Kar%={mc.profitProb.toFixed(0)} · Yikim%={mc.ruinProb.toFixed(1)} · PF={mc.profitFactor.median.toFixed(2)} · DD=%{mc.maxDrawdown.median.toFixed(0)}
        </div>
      </div>
    </div>
  );
}

function MiniTile({ label, value, color }) {
  return (
    <div style={{ background: 'var(--bg0)', padding: '4px 2px', borderRadius: 4, textAlign: 'center', border: '1px solid var(--border)' }}>
      <div style={{ fontSize: 7, textTransform: 'uppercase', color: 'var(--t3)', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color, fontFamily: 'Space Grotesk' }}>{value}</div>
    </div>
  );
}

function MCMetric({ label, value, color }) {
  return (
    <div style={{ background: 'var(--bg2)', padding: 6, borderRadius: 4, textAlign: 'center' }}>
      <div style={{ fontSize: 7, textTransform: 'uppercase', color: 'var(--t3)', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color, fontFamily: 'Space Grotesk' }}>{value}</div>
    </div>
  );
}

function MCRow({ label, v5, v50, v95 }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 1fr', gap: 2, textAlign: 'center', padding: '2px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ textAlign: 'left', color: 'var(--t2)', fontWeight: 600, fontSize: 8 }}>{label}</span>
      <span style={{ color: 'var(--red)', fontSize: 8 }}>{v5}</span>
      <span style={{ color: 'var(--t1)', fontSize: 8 }}>{v50}</span>
      <span style={{ color: 'var(--green)', fontSize: 8 }}>{v95}</span>
    </div>
  );
}

function MCEquityBands({ bands, tradeCount }) {
  const W = 400;
  const H = 80;
  const allVals = [...bands.p5, ...bands.p95];
  const min = Math.min(...allVals);
  const max = Math.max(...allVals);
  const range = max - min || 1;
  const n = tradeCount + 1;

  const toX = (i) => (i / (n - 1)) * W;
  const toY = (v) => H - 4 - ((v - min) / range) * (H - 8);

  const makePath = (arr) => arr.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');

  const outerPoly = bands.p5.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ')
    + ' ' + [...bands.p95].reverse().map((v, i) => `${toX(n - 1 - i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');

  const innerPoly = bands.p25.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ')
    + ' ' + [...bands.p75].reverse().map((v, i) => `${toX(n - 1 - i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');

  const baseY = toY(10000);

  return (
    <div style={{ marginBottom: 6 }}>
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ display: 'block', background: 'var(--bg2)', borderRadius: 4, border: '1px solid var(--border)' }}
      >
        <polygon fill="rgba(139,92,246,0.08)" points={outerPoly} />
        <polygon fill="rgba(139,92,246,0.15)" points={innerPoly} />
        <line x1="0" y1={baseY} x2={W} y2={baseY} stroke="#ffd600" strokeWidth="0.5" strokeDasharray="3,3" opacity="0.4" />
        <polyline fill="none" stroke="rgba(139,92,246,0.3)" strokeWidth="0.5" points={makePath(bands.p5)} />
        <polyline fill="none" stroke="rgba(139,92,246,0.5)" strokeWidth="0.5" points={makePath(bands.p25)} />
        <polyline fill="none" stroke="#8b5cf6" strokeWidth="1.5" points={makePath(bands.p50)} />
        <polyline fill="none" stroke="rgba(139,92,246,0.5)" strokeWidth="0.5" points={makePath(bands.p75)} />
        <polyline fill="none" stroke="rgba(139,92,246,0.3)" strokeWidth="0.5" points={makePath(bands.p95)} />
        <text x="4" y={baseY - 3} fill="#ffd600" fontSize="6" fontFamily="JetBrains Mono">10K</text>
        <text x={W - 4} y={toY(bands.p50[n-1]) - 3} fill="#8b5cf6" fontSize="6" fontFamily="JetBrains Mono" textAnchor="end">
          {(bands.p50[n-1] / 1000).toFixed(1)}K
        </text>
      </svg>
    </div>
  );
}
