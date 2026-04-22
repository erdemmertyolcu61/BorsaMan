import { useState } from 'react';
import { runBacktest, calcBacktestStats } from '../../utils/backtestEngine.js';

const STRATEGY_LABELS = {
  signal: 'Sinyal Motoru',
  rsi: 'RSI<35 Bounce',
  macd: 'MACD Cross',
  ma: 'MA Cross',
};

export default function BacktestPanel({ prices, symbol, gData }) {
  const data = prices || gData;
  const [stats, setStats] = useState(null);
  const [active, setActive] = useState(null);

  const run = (strategy) => {
    const min = strategy === 'ma' ? 60 : strategy === 'macd' ? 45 : 25;
    if (!data || data.length < min) return;
    setActive(strategy);
    const trades = runBacktest(data, strategy);
    const s = calcBacktestStats(trades, data.length);
    setStats({ ...s, trades, strategy });
  };

  const s = stats;

  return (
    <div className="trade-box fi" style={{ margin: 0 }}>
      <div className="trade-title" style={{ color: 'var(--cyan)', fontSize: 11, fontWeight: 700, marginBottom: 10 }}>
        Backtest Motoru
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap' }}>
        {['signal', 'rsi', 'macd', 'ma'].map(st => (
          <button
            key={st}
            className="btn btn-go"
            onClick={() => run(st)}
            style={{
              fontSize: 10,
              padding: '7px 12px',
              width: 'auto',
              background: active === st ? 'linear-gradient(135deg,var(--cyan),var(--blue))' : 'var(--bg0)',
              color: active === st ? '#fff' : 'var(--t2)',
              border: '1px solid var(--border)',
            }}
          >
            {STRATEGY_LABELS[st]}
          </button>
        ))}
      </div>

      {s && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--cyan)', marginBottom: 12, fontFamily: 'Space Grotesk,sans-serif' }}>
            {symbol} — {STRATEGY_LABELS[s.strategy]} ({s.totalDays} gün)
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 12 }}>
            <MetricTile
              label="Kazanma"
              value={`%${s.winRate.toFixed(0)}`}
              color={s.winRate >= 55 ? 'var(--green)' : s.winRate >= 45 ? 'var(--yellow)' : 'var(--red)'}
              sub={`${s.wins.length}K / ${s.losses.length}Z`}
            />
            <MetricTile
              label="Toplam Getiri"
              value={`${s.totalReturn >= 0 ? '+' : ''}${s.totalReturn.toFixed(1)}%`}
              color={s.totalReturn >= 0 ? 'var(--green)' : 'var(--red)'}
            />
            <MetricTile
              label="10K Sonuç"
              value={`${(s.finalEquity / 1000).toFixed(1)}K`}
              color={s.finalEquity >= 10000 ? 'var(--green)' : 'var(--red)'}
            />
            <MetricTile
              label="Max Drawdown"
              value={`-${s.maxDrawdown.toFixed(1)}%`}
              color="var(--red)"
              sub={`${s.maxDDDuration || 0} gün`}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, marginBottom: 12 }}>
            <RatioTile label="Sharpe" value={s.sharpeRatio} border="var(--blue)" />
            <RatioTile label="Sortino" value={s.sortinoRatio} border="var(--purple)" />
            <RatioTile label="Calmar" value={s.calmarRatio} border="var(--cyan)" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 4, marginBottom: 12, fontSize: 10 }}>
            <Row label="Profit Factor" value={s.profitFactor > 10 ? '>10' : s.profitFactor.toFixed(2)} color={s.profitFactor >= 1.5 ? 'var(--green)' : 'var(--yellow)'} />
            <Row label="Payoff Oranı" value={s.payoffRatio.toFixed(2)} color={s.payoffRatio >= 1.5 ? 'var(--green)' : 'var(--yellow)'} />
            <Row label="Ort. Kazanç" value={`+${s.avgWin.toFixed(2)}%`} color="var(--green)" />
            <Row label="Ort. Kayıp" value={`${s.avgLoss.toFixed(2)}%`} color="var(--red)" />
            <Row label="Beklenti" value={`${s.expectancy.toFixed(2)}%`} color={s.expectancy > 0 ? 'var(--green)' : 'var(--red)'} />
            <Row label="İşlem Sayısı" value={s.closed.length} color="var(--cyan)" />
            <Row label="Ard. Kazanç" value={s.maxConsWins} color="var(--green)" />
            <Row label="Ard. Kayıp" value={s.maxConsLosses} color="var(--red)" />
          </div>

          {s.equity.length > 2 && <EquityCurve equity={s.equity} finalEquity={s.finalEquity} />}

          <div style={{
            padding: '8px 12px',
            borderLeft: `3px solid ${s.verdictColor}`,
            borderRadius: 4,
            fontSize: 11,
            color: s.verdictColor,
            fontWeight: 700,
            marginBottom: 10,
            background: 'var(--bg0)',
          }}>
            {s.verdict}
          </div>

          {s.trades.length > 0 && (
            <details style={{ fontSize: 10 }}>
              <summary style={{ cursor: 'pointer', color: 'var(--t2)', marginBottom: 6, fontWeight: 600 }}>
                İşlem Detayları ({s.trades.length} işlem)
              </summary>
              <div style={{ maxHeight: 200, overflowY: 'auto', background: 'var(--bg0)', borderRadius: 4, border: '1px solid var(--border)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg2)' }}>
                      {['#', 'Giriş', 'Çıkış', 'Gün', 'Sonuç', 'K/Z'].map((h, i) => (
                        <th key={h} style={{
                          padding: '4px 6px',
                          textAlign: i >= 3 ? 'right' : 'left',
                          color: 'var(--t3)',
                          fontSize: 7,
                          textTransform: 'uppercase',
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {s.trades.map((t, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '3px 6px', color: 'var(--t3)' }}>{i + 1}</td>
                        <td style={{ padding: '3px 6px' }}>
                          <span style={{ color: 'var(--t2)' }}>
                            {new Date(t.entryDate).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' })}
                          </span>
                          <span style={{ color: 'var(--cyan)', marginLeft: 4 }}>{t.entry.toFixed(2)}</span>
                        </td>
                        <td style={{ padding: '3px 6px' }}>
                          <span style={{ color: 'var(--t2)' }}>
                            {new Date(t.exitDate).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' })}
                          </span>
                          <span style={{ color: t.pnl >= 0 ? 'var(--green)' : 'var(--red)', marginLeft: 4 }}>{t.exit.toFixed(2)}</span>
                        </td>
                        <td style={{ padding: '3px 6px', textAlign: 'right', color: 'var(--t2)' }}>{t.days}</td>
                        <td style={{ padding: '3px 6px', textAlign: 'right' }}>
                          <span style={{
                            fontSize: 8,
                            padding: '1px 4px',
                            borderRadius: 2,
                            background: t.result === 'target' ? 'var(--green2)' : t.result === 'stop' ? 'var(--red2)' : 'var(--yellow2)',
                            color: t.result === 'target' ? 'var(--green)' : t.result === 'stop' ? 'var(--red)' : 'var(--yellow)',
                          }}>
                            {t.result === 'target' ? 'HEDEF' : t.result === 'stop' ? 'STOP' : t.result === 'open' ? 'AÇIK' : 'SÜRE'}
                          </span>
                        </td>
                        <td style={{
                          padding: '3px 6px',
                          textAlign: 'right',
                          fontWeight: 600,
                          color: t.pnl >= 0 ? 'var(--green)' : 'var(--red)',
                        }}>
                          {t.pnl >= 0 ? '+' : ''}{t.pnl.toFixed(1)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function MetricTile({ label, value, color, sub }) {
  return (
    <div style={{ background: 'var(--bg0)', padding: 10, borderRadius: 6, textAlign: 'center', border: '1px solid var(--border)' }}>
      <div style={{ fontSize: 8, textTransform: 'uppercase', color: 'var(--t3)', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color, fontFamily: 'Space Grotesk' }}>{value}</div>
      {sub && <div style={{ fontSize: 8, color: 'var(--t3)' }}>{sub}</div>}
    </div>
  );
}

function RatioTile({ label, value, border }) {
  const color = value > 1 ? 'var(--green)' : value > 0 ? 'var(--yellow)' : 'var(--red)';
  return (
    <div style={{ background: 'var(--bg0)', padding: 8, borderRadius: 4, borderLeft: `3px solid ${border}` }}>
      <div style={{ fontSize: 7, textTransform: 'uppercase', color: 'var(--t3)' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color }}>{value.toFixed(2)}</div>
    </div>
  );
}

function Row({ label, value, color }) {
  return (
    <div className="tr-row">
      <span className="tr-l">{label}</span>
      <span className="tr-v" style={{ color }}>{value}</span>
    </div>
  );
}

function EquityCurve({ equity, finalEquity }) {
  const W = 400;
  const H = 80;
  const min = Math.min(...equity);
  const range = Math.max(...equity) - min || 1;
  const points = equity
    .map((v, i) => `${((i / (equity.length - 1)) * W).toFixed(1)},${(H - 4 - ((v - min) / range) * (H - 8)).toFixed(1)}`)
    .join(' ');
  const baseY = H - 4 - ((10000 - min) / range) * (H - 8);
  const polyPoints = `${points} ${W},${H} 0,${H}`;
  const lastY = H - 4 - ((equity[equity.length - 1] - min) / range) * (H - 8) - 3;
  const good = finalEquity >= 10000;
  const stroke = good ? '#00e676' : '#ff1744';

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 8, color: 'var(--t3)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>
        Equity Curve
      </div>
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ display: 'block', background: 'var(--bg0)', borderRadius: 4, border: '1px solid var(--border)' }}
      >
        <defs>
          <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.3" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <polygon fill="url(#eqGrad)" points={polyPoints} />
        <line x1="0" y1={baseY} x2={W} y2={baseY} stroke="#ffd600" strokeWidth="0.5" strokeDasharray="3,3" opacity="0.5" />
        <polyline fill="none" stroke={stroke} strokeWidth="1.5" points={points} />
        <text x="4" y={baseY - 3} fill="#ffd600" fontSize="6" fontFamily="JetBrains Mono">10K</text>
        <text x={W - 4} y={lastY} fill={stroke} fontSize="6" fontFamily="JetBrains Mono" textAnchor="end">
          {(equity[equity.length - 1] / 1000).toFixed(1)}K
        </text>
      </svg>
    </div>
  );
}
