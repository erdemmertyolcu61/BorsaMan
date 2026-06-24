/**
 * PaperTradingPanel — Phase 8: Paper Trading Simulation UI
 *
 * Canli piyasada sanal islem simulasyonu. Gercek para yok — backtest bulgularini
 * canli ortamda dogrular. Phase 9'da bu sonuclar terminal parametrelerine otomatik
 * aktarilacak.
 *
 * 2 ENGINE:
 *   A. Standard Paper Trading (usePaperTrading) — confidence-based, risk-sized
 *   B. ML Forward Test (usePaperTradeML) — TOP 3 ML-scored, 33% allocation, -3% stop
 *
 * 4 panel per engine:
 *   1. Dashboard: kapital, P&L, win rate, max DD
 *   2. Acik Pozisyonlar: canli fiyat, unrealized P&L, stop/hedef progress bar
 *   3. Islem Gecmisi: kapali islemler, giris/cikis, neden
 *   4. Equity Curve: mini SVG sparkline + performans ozeti
 */

import { useState, useMemo } from 'react';

// ── Renk yardimcilari ──
const pnlColor = (v) => v > 0 ? '#10e87a' : v < 0 ? '#f43f5e' : '#9ca3af';
const pct = (v, dec = 1) => (v >= 0 ? '+' : '') + v.toFixed(dec) + '%';
const tl = (v) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.abs(v));

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 8, padding: '10px 14px', minWidth: 100,
    }}>
      <div style={{ fontSize: 9, color: 'var(--t3)', letterSpacing: 1, marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: color || 'var(--t1)', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// Mini equity curve (SVG sparkline)
function EquitySpark({ curve, startCapital }) {
  if (!curve || curve.length < 2) return null;
  const vals = curve.map(p => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const W = 280, H = 48;

  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * W;
    const y = H - ((v - min) / range) * H;
    return `${x},${y}`;
  });

  const isProfit = vals[vals.length - 1] >= startCapital;
  const color = isProfit ? '#10e87a' : '#f43f5e';
  const baselineY = H - ((startCapital - min) / range) * H;

  return (
    <svg width={W} height={H} style={{ display: 'block' }}>
      <line x1={0} y1={baselineY} x2={W} y2={baselineY} stroke="rgba(255,255,255,0.1)" strokeWidth={1} strokeDasharray="3,3" />
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.5} />
      <circle cx={W} cy={H - ((vals[vals.length - 1] - min) / range) * H} r={3} fill={color} />
    </svg>
  );
}

// Stop / Target progress bar bir pozisyon icin
function PosProgressBar({ pos }) {
  const cur = pos.currentPrice || pos.current_price || pos.entry || pos.entry_price;
  const stop = pos.stop || pos.stop_price;
  const target = pos.target || pos.target_price;
  const entry = pos.entry || pos.entry_price;
  const range = target - stop;
  if (range <= 0) return null;
  const progress = Math.max(0, Math.min(1, (cur - stop) / range));
  const pnlPct = (cur - entry) / entry * 100;

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: 'var(--t3)', marginBottom: 2 }}>
        <span style={{ color: '#f43f5e' }}>S: {stop?.toFixed(2)}</span>
        <span style={{ color: pnlColor(pnlPct), fontWeight: 700 }}>{pct(pnlPct)}</span>
        <span style={{ color: '#10e87a' }}>H: {target?.toFixed(2)}</span>
      </div>
      <div style={{ height: 3, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${progress * 100}%`,
          background: pnlPct > 0 ? '#10e87a' : '#f43f5e',
          transition: 'width 0.4s ease',
        }} />
      </div>
    </div>
  );
}

// ── ML Badge ──
function MLBadge({ trade }) {
  const boost = trade.ml_confidence || trade.mlConfidence || 0;
  const rule = trade.ml_best_rule || trade.mlBestRule || '';
  const matched = trade.ml_matched || trade.mlMatched || 0;
  if (!matched) return null;

  const color = boost >= 5 ? '#ffd700' : boost >= 2 ? '#06b6d4' : '#a78bfa';
  return (
    <span style={{
      fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 3, marginLeft: 5,
      background: `${color}20`, border: `1px solid ${color}40`, color,
    }}>
      {'🎯'} ML +{boost.toFixed(1)} {rule ? `· ${rule.split(' + ')[0]}` : ''}
    </span>
  );
}

// ══════════════════════════════════════════════════════════════
// ML FORWARD TEST PANEL
// ══════════════════════════════════════════════════════════════

function MLForwardTestPanel({ paperML }) {
  const [mlTab, setMlTab] = useState('positions');
  const [sortHistory, setSortHistory] = useState('date');

  // ✓ MOVE useMemo BEFORE early return to comply with Rules of Hooks
  const sortedHistory = useMemo(() => {
    if (!paperML?.snapshot?.closedTrades) return [];
    const h = [...paperML.snapshot.closedTrades];
    if (sortHistory === 'pnl')    return h.sort((a, b) => (b.pnl_tl || 0) - (a.pnl_tl || 0));
    if (sortHistory === 'symbol') return h.sort((a, b) => (a.symbol || '').localeCompare(b.symbol || ''));
    return h;
  }, [paperML?.snapshot?.closedTrades, sortHistory]);

  const { snapshot, autoTrade, toggleAutoTrade, closeTrade, reset } = paperML;

  if (!snapshot) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--t3)', fontSize: 12 }}>
        <div style={{ fontSize: 28, marginBottom: 10 }}>{'🧠'}</div>
        <div>ML Forward Test motoru yukleniyor...</div>
      </div>
    );
  }

  const {
    cash, startCapital, totalEquity, totalEquityPct, totalPnl, totalPnlPct,
    winRate, wins, losses, totalTrades, avgWinPct, avgLossPct,
    expectancy, profitFactor, maxDrawdown, openTrades, closedTrades, mlBuckets,
  } = snapshot;

  return (
    <div>
      {/* HEADER */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '16px 0 12px', borderBottom: '1px solid rgba(255,255,255,0.07)',
        flexWrap: 'wrap', gap: 10,
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--t1)', letterSpacing: 1 }}>
              {'🧠'} ML FORWARD TEST
            </span>
            <span style={{
              fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
              background: 'rgba(255,215,0,0.15)', color: '#ffd700',
              border: '1px solid rgba(255,215,0,0.3)', letterSpacing: 1,
            }}>SQLITE</span>
            <span style={{ fontSize: 9, color: 'var(--t3)' }}>
              TOP 3 ML · 33% alloc · -3% stop
            </span>
          </div>
          <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 2 }}>
            Sadece ML kurallarinin onerdigi hisseleri test eder — kural performansini olcer
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={toggleAutoTrade} style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontWeight: 700,
            fontSize: 11, letterSpacing: 0.5, transition: 'all 0.2s',
            background: autoTrade ? 'rgba(255,215,0,0.15)' : 'rgba(255,255,255,0.06)',
            border: autoTrade ? '1px solid rgba(255,215,0,0.5)' : '1px solid rgba(255,255,255,0.15)',
            color: autoTrade ? '#ffd700' : 'var(--t2)',
            boxShadow: autoTrade ? '0 0 16px rgba(255,215,0,0.12)' : 'none',
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: autoTrade ? '#ffd700' : '#6b7280',
              animation: autoTrade ? 'pulseDot 1.4s ease-in-out infinite' : 'none',
            }} />
            {autoTrade ? '⚡ ML AUTO ON' : '⏸ ML AUTO OFF'}
          </button>
        </div>
      </div>

      {/* STAT CARDS */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', padding: '14px 0' }}>
        <StatCard label="TOPLAM EQUİTY" value={`₺${tl(totalEquity)}`}
          sub={`${pct(totalEquityPct)}`} color={pnlColor(totalEquityPct)} />
        <StatCard label="SERBEST NAKİT" value={`₺${tl(cash)}`}
          sub={`${tl(startCapital - cash)} TL pozisyonda`} />
        <StatCard label="REALİZED P&L" value={`${totalPnl >= 0 ? '+' : ''}₺${tl(totalPnl)}`}
          sub={pct(totalPnlPct)} color={pnlColor(totalPnl)} />
        <StatCard label="WIN RATE" value={`%${winRate.toFixed(0)}`}
          sub={`${wins}K / ${losses}K`}
          color={winRate >= 55 ? '#10e87a' : winRate >= 40 ? '#f59e0b' : '#f43f5e'} />
        <StatCard label="EXPECTANCY" value={`${expectancy >= 0 ? '+' : ''}${expectancy.toFixed(2)}%`}
          sub={`PF: ${isFinite(profitFactor) ? profitFactor.toFixed(2) : '∞'}`}
          color={pnlColor(expectancy)} />
        <StatCard label="MAX DD" value={`-%${maxDrawdown.toFixed(1)}`}
          color={maxDrawdown > 15 ? '#f43f5e' : maxDrawdown > 8 ? '#f59e0b' : '#10e87a'} />
        <StatCard label="ACİK POZ" value={openTrades.length} sub="Max: 3"
          color={openTrades.length > 0 ? '#ffd700' : 'var(--t3)'} />
      </div>

      {/* ML / SMC Mode indicator */}
      <div style={{ padding: '0 0 12px' }}>
        {mlBuckets?.length > 0 ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <div style={{
              padding: '4px 10px', borderRadius: 5, fontSize: 9, fontWeight: 700,
              background: 'rgba(255,215,0,0.12)', border: '1px solid rgba(255,215,0,0.3)',
              color: '#ffd700',
            }}>🎯 ML KURALLARI AKTİF</div>
            {mlBuckets.map(b => (
              <div key={b.ml_tier} style={{
                padding: '4px 10px', borderRadius: 5,
                background: 'rgba(255,215,0,0.06)', border: '1px solid rgba(255,215,0,0.15)',
                fontSize: 9, color: '#ffd700',
              }}>
                <b>{b.ml_tier}</b>: {b.cnt} islem · WR %{b.wins && b.cnt ? ((b.wins / b.cnt) * 100).toFixed(0) : '0'}
                {b.avg_pnl != null && ` · avg ${b.avg_pnl > 0 ? '+' : ''}${b.avg_pnl.toFixed(2)}%`}
              </div>
            ))}
          </div>
        ) : (
          <div style={{
            padding: '6px 12px', borderRadius: 6, display: 'inline-flex', alignItems: 'center', gap: 8,
            background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.25)',
            fontSize: 9, color: '#06b6d4',
          }}>
            <span>📊 SMC FALLBACK MODU</span>
            <span style={{ color: 'var(--t3)' }}>ML kurallari egitilmemis — score≥55 en iyi hisseler seciliyor</span>
            <span style={{ color: '#fbbf24', marginLeft: 4 }}>
              (ML egitimi her isgunu 20:00&apos;de otomatik baslar)
            </span>
          </div>
        )}
      </div>

      {/* TAB NAV */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, borderBottom: '1px solid rgba(255,255,255,0.07)', paddingBottom: 8 }}>
        {[
          { id: 'positions', label: `📊 Acik (${openTrades.length})` },
          { id: 'history',   label: `📜 Gecmis (${closedTrades.length})` },
        ].map(t => (
          <button key={t.id} onClick={() => setMlTab(t.id)} style={{
            padding: '5px 12px', borderRadius: 5, cursor: 'pointer', fontSize: 10,
            fontWeight: 700, letterSpacing: 0.3,
            background: mlTab === t.id ? 'rgba(255,215,0,0.15)' : 'transparent',
            border: mlTab === t.id ? '1px solid rgba(255,215,0,0.4)' : '1px solid transparent',
            color: mlTab === t.id ? '#ffd700' : 'var(--t3)',
          }}>{t.label}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={reset} style={{
          padding: '5px 12px', borderRadius: 5, cursor: 'pointer', fontSize: 9,
          fontWeight: 700, background: 'rgba(244,63,94,0.1)',
          border: '1px solid rgba(244,63,94,0.3)', color: '#f87171',
        }}>{'🔄'} SIFIRLA</button>
      </div>

      {/* OPEN POSITIONS */}
      {mlTab === 'positions' && (
        <div>
          {openTrades.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--t3)', fontSize: 12 }}>
              <div style={{ fontSize: 28, marginBottom: 10 }}>{'🧠'}</div>
              <div>ML acik pozisyon yok.</div>
              {!autoTrade ? (
                <div style={{
                  marginTop: 12, padding: '10px 18px', borderRadius: 8, display: 'inline-block',
                  background: 'rgba(255,215,0,0.12)', border: '1px solid rgba(255,215,0,0.4)',
                  color: '#ffd700', fontSize: 11, fontWeight: 700,
                }}>
                  ⚡ Yukaridaki &ldquo;ML AUTO OFF&rdquo; butonuna tikla — tarama bittikce otomatik giris yapilir
                </div>
              ) : (
                <div style={{ fontSize: 10, marginTop: 6 }}>
                  ML Auto aktif — sonraki AI Advisor taramasinda en iyi 3 pick girilecek
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
              {openTrades.map(trade => {
                const entry = trade.entry_price;
                const cur = trade.current_price || entry;
                const unrlPct = entry > 0 ? (cur - entry) / entry * 100 : 0;
                const unrlTl = entry > 0 ? (cur - entry) / entry * trade.size_tl : 0;
                return (
                  <div key={trade.id} style={{
                    background: 'rgba(255,255,255,0.04)',
                    border: `1px solid ${unrlPct >= 0 ? 'rgba(255,215,0,0.2)' : 'rgba(244,63,94,0.2)'}`,
                    borderRadius: 8, padding: 12,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                      <div>
                        <span style={{ fontWeight: 800, fontSize: 13, color: 'var(--t1)' }}>{trade.symbol}</span>
                        <MLBadge trade={trade} />
                        <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 1 }}>
                          {trade.sector || ''} {trade.grade ? `· ${trade.grade}` : ''} {trade.tier ? `· ${trade.tier}` : ''}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 14, fontWeight: 800, color: pnlColor(unrlPct) }}>{pct(unrlPct)}</div>
                        <div style={{ fontSize: 9, color: pnlColor(unrlTl) }}>
                          {unrlTl >= 0 ? '+' : ''}₺{tl(unrlTl)}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 6 }}>
                      <span style={{ color: 'var(--t3)' }}>Giris: <b style={{ color: 'var(--t2)' }}>{entry?.toFixed(2)}</b></span>
                      <span style={{ color: 'var(--t3)' }}>Anlik: <b style={{ color: 'var(--t1)' }}>{cur?.toFixed(2)}</b></span>
                      <span style={{ color: 'var(--t3)' }}>Lot: <b style={{ color: 'var(--t2)' }}>₺{tl(trade.size_tl)}</b></span>
                    </div>

                    <PosProgressBar pos={trade} />

                    {/* ML Rule Info */}
                    {trade.ml_best_rule && (
                      <div style={{
                        marginTop: 6, padding: '4px 8px', borderRadius: 4,
                        background: 'rgba(255,215,0,0.06)', border: '1px solid rgba(255,215,0,0.12)',
                        fontSize: 8, color: '#ffd700',
                      }}>
                        {'🎯'} {trade.ml_best_rule} · {trade.ml_matched || 0} kural eslesti
                      </div>
                    )}

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                      <span style={{ fontSize: 8, color: 'var(--t3)' }}>
                        {new Date(trade.opened_at).toLocaleDateString('tr-TR')}
                      </span>
                      <button onClick={() => closeTrade(trade.id, cur)} style={{
                        fontSize: 9, padding: '3px 9px', borderRadius: 4, cursor: 'pointer',
                        background: 'rgba(244,63,94,0.15)', border: '1px solid rgba(244,63,94,0.35)',
                        color: '#f87171', fontWeight: 700,
                      }}>× KAPAT</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TRADE HISTORY */}
      {mlTab === 'history' && (
        <div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <span style={{ fontSize: 9, color: 'var(--t3)', alignSelf: 'center' }}>Siralama:</span>
            {['date', 'pnl', 'symbol'].map(s => (
              <button key={s} onClick={() => setSortHistory(s)} style={{
                fontSize: 9, padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
                background: sortHistory === s ? 'rgba(255,215,0,0.15)' : 'rgba(255,255,255,0.05)',
                border: `1px solid ${sortHistory === s ? 'rgba(255,215,0,0.4)' : 'rgba(255,255,255,0.1)'}`,
                color: sortHistory === s ? '#ffd700' : 'var(--t3)',
              }}>{s === 'date' ? 'Tarih' : s === 'pnl' ? 'P&L' : 'Sembol'}</button>
            ))}
          </div>

          {sortedHistory.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--t3)', fontSize: 12 }}>
              ML kapali islem yok. ML Auto Trade'i aktifle ve tarama bekle.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', color: 'var(--t3)' }}>
                    {['Sembol', 'ML Boost', 'Giris', 'Cikis', 'Neden', 'P&L TL', 'P&L %', 'Lot', 'Sure', 'ML Kural'].map(h => (
                      <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, letterSpacing: 0.3, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedHistory.map((t, i) => {
                    const heldH = Math.floor((t.held_ms || 0) / 3600000);
                    const heldM = Math.floor(((t.held_ms || 0) % 3600000) / 60000);
                    return (
                      <tr key={t.id || i} style={{
                        borderBottom: '1px solid rgba(255,255,255,0.04)',
                        background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                      }}>
                        <td style={{ padding: '7px 10px', fontWeight: 700, color: 'var(--t1)' }}>
                          {t.symbol}
                        </td>
                        <td style={{ padding: '7px 10px' }}>
                          <span style={{
                            fontSize: 8, padding: '1px 5px', borderRadius: 3, fontWeight: 700,
                            background: (t.ml_confidence || 0) >= 5 ? 'rgba(255,215,0,0.15)' : 'rgba(6,182,212,0.15)',
                            color: (t.ml_confidence || 0) >= 5 ? '#ffd700' : '#06b6d4',
                            border: `1px solid ${(t.ml_confidence || 0) >= 5 ? 'rgba(255,215,0,0.3)' : 'rgba(6,182,212,0.3)'}`,
                          }}>+{(t.ml_confidence || 0).toFixed(1)}</span>
                        </td>
                        <td style={{ padding: '7px 10px', color: 'var(--t2)' }}>{t.entry_price?.toFixed(2)}</td>
                        <td style={{ padding: '7px 10px', color: 'var(--t2)' }}>{t.exit_price?.toFixed(2)}</td>
                        <td style={{ padding: '7px 10px' }}>
                          <span style={{
                            fontSize: 8, padding: '1px 6px', borderRadius: 3, fontWeight: 700,
                            background: t.exit_reason === 'TARGET' ? 'rgba(16,232,122,0.15)'
                              : t.exit_reason === 'STOP' ? 'rgba(244,63,94,0.15)'
                              : 'rgba(255,255,255,0.08)',
                            color: t.exit_reason === 'TARGET' ? '#10e87a'
                              : t.exit_reason === 'STOP' ? '#f43f5e'
                              : 'var(--t3)',
                            border: `1px solid ${t.exit_reason === 'TARGET' ? 'rgba(16,232,122,0.3)'
                              : t.exit_reason === 'STOP' ? 'rgba(244,63,94,0.3)'
                              : 'rgba(255,255,255,0.1)'}`,
                          }}>{t.exit_reason}</span>
                        </td>
                        <td style={{ padding: '7px 10px', color: pnlColor(t.pnl_tl), fontWeight: 700 }}>
                          {(t.pnl_tl || 0) >= 0 ? '+' : ''}₺{tl(t.pnl_tl || 0)}
                        </td>
                        <td style={{ padding: '7px 10px', color: pnlColor(t.pnl_pct), fontWeight: 700 }}>
                          {pct(t.pnl_pct || 0)}
                        </td>
                        <td style={{ padding: '7px 10px', color: 'var(--t3)' }}>₺{tl(t.size_tl || 0)}</td>
                        <td style={{ padding: '7px 10px', color: 'var(--t3)', whiteSpace: 'nowrap' }}>
                          {heldH > 0 ? `${heldH}s` : ''}{heldM}d
                        </td>
                        <td style={{ padding: '7px 10px', color: '#ffd700', fontSize: 8, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {t.ml_best_rule || '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// MAIN PANEL — TABS BETWEEN STANDARD AND ML ENGINES
// ══════════════════════════════════════════════════════════════

export default function PaperTradingPanel({ paperTrading, paperML }) {
  const [engine, setEngine] = useState('ml'); // 'standard' | 'ml'
  const [tab, setTab] = useState('positions');
  const [sortHistory, setSortHistory] = useState('date');

  if (!paperTrading && !paperML) return null;

  return (
    <div style={{
      padding: '0 16px 24px',
      fontFamily: 'JetBrains Mono, monospace',
      maxWidth: 1400,
    }}>
      {/* ENGINE SELECTOR */}
      <div style={{
        display: 'flex', gap: 4, padding: '12px 0 0',
        borderBottom: '2px solid rgba(255,255,255,0.06)',
        marginBottom: 2,
      }}>
        <button onClick={() => setEngine('ml')} style={{
          padding: '8px 20px', borderRadius: '8px 8px 0 0', cursor: 'pointer',
          fontSize: 11, fontWeight: 800, letterSpacing: 0.5, transition: 'all 0.2s',
          background: engine === 'ml' ? 'rgba(255,215,0,0.12)' : 'rgba(255,255,255,0.03)',
          border: engine === 'ml' ? '1px solid rgba(255,215,0,0.3)' : '1px solid rgba(255,255,255,0.08)',
          borderBottom: engine === 'ml' ? '2px solid #ffd700' : '1px solid transparent',
          color: engine === 'ml' ? '#ffd700' : 'var(--t3)',
        }}>
          {'🧠'} ML Forward Test
        </button>
        <button onClick={() => setEngine('standard')} style={{
          padding: '8px 20px', borderRadius: '8px 8px 0 0', cursor: 'pointer',
          fontSize: 11, fontWeight: 800, letterSpacing: 0.5, transition: 'all 0.2s',
          background: engine === 'standard' ? 'rgba(124,58,237,0.12)' : 'rgba(255,255,255,0.03)',
          border: engine === 'standard' ? '1px solid rgba(124,58,237,0.3)' : '1px solid rgba(255,255,255,0.08)',
          borderBottom: engine === 'standard' ? '2px solid #a78bfa' : '1px solid transparent',
          color: engine === 'standard' ? '#a78bfa' : 'var(--t3)',
        }}>
          {'📄'} Standard Paper Trading
        </button>
      </div>

      {/* ML ENGINE */}
      {engine === 'ml' && paperML && (
        <MLForwardTestPanel paperML={paperML} />
      )}

      {/* STANDARD ENGINE */}
      {engine === 'standard' && paperTrading && (
        <StandardPaperPanel paperTrading={paperTrading} tab={tab} setTab={setTab}
          sortHistory={sortHistory} setSortHistory={setSortHistory} />
      )}
    </div>
  );
}

// ── Standard Paper Trading Panel (original) ──

function StandardPaperPanel({ paperTrading, tab, setTab, sortHistory, setSortHistory }) {
  const {
    capital, startCapital, startDate,
    positions, closedTrades, autoTrade, equityCurve, config,
    openPosition, closePosition, toggleAutoTrade, updateConfig, reset,
    performance: perf,
  } = paperTrading;

  const sortedHistory = useMemo(() => {
    const h = [...closedTrades];
    if (sortHistory === 'pnl')    return h.sort((a, b) => b.pnl - a.pnl);
    if (sortHistory === 'symbol') return h.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return h;
  }, [closedTrades, sortHistory]);

  const daysRunning = Math.max(1, Math.floor((Date.now() - new Date(startDate).getTime()) / 86400000));

  return (
    <div>
      {/* HEADER */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '16px 0 12px', borderBottom: '1px solid rgba(255,255,255,0.07)',
        flexWrap: 'wrap', gap: 10,
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--t1)', letterSpacing: 1 }}>
              {'📄'} PAPER TRADING
            </span>
            <span style={{
              fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
              background: 'rgba(124,58,237,0.2)', color: '#a78bfa',
              border: '1px solid rgba(124,58,237,0.3)', letterSpacing: 1,
            }}>PHASE 8</span>
            <span style={{ fontSize: 9, color: 'var(--t3)' }}>
              {daysRunning}g · {perf.totalTrades} islem
            </span>
          </div>
          <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 2 }}>
            Canli piyasada sanal simulasyon — backtest parametrelerini dogrulamak icin
          </div>
        </div>

        <button onClick={toggleAutoTrade} style={{
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontWeight: 700,
          fontSize: 11, letterSpacing: 0.5, transition: 'all 0.2s',
          background: autoTrade ? 'rgba(16,232,122,0.18)' : 'rgba(255,255,255,0.06)',
          border: autoTrade ? '1px solid rgba(16,232,122,0.5)' : '1px solid rgba(255,255,255,0.15)',
          color: autoTrade ? '#10e87a' : 'var(--t2)',
          boxShadow: autoTrade ? '0 0 16px rgba(16,232,122,0.15)' : 'none',
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: autoTrade ? '#10e87a' : '#6b7280',
            animation: autoTrade ? 'pulseDot 1.4s ease-in-out infinite' : 'none',
          }} />
          {autoTrade ? '⚡ AUTO ON' : '⏸ AUTO OFF'}
        </button>
      </div>

      {/* STAT CARDS */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', padding: '14px 0' }}>
        <StatCard label="TOPLAM KAPİTAL" value={`₺${tl(perf.totalEquity)}`}
          sub={`${pct(perf.totalEquityPct)} baslangica gore`} color={pnlColor(perf.totalEquityPct)} />
        <StatCard label="SERBEST KAPİTAL" value={`₺${tl(capital)}`}
          sub={`${tl(startCapital - capital)} TL pozisyonda`} />
        <StatCard label="REALIZED P&L" value={`${perf.totalPnl >= 0 ? '+' : ''}₺${tl(perf.totalPnl)}`}
          sub={pct(perf.totalPnlPct)} color={pnlColor(perf.totalPnl)} />
        <StatCard label="WIN RATE" value={`%${perf.winRate.toFixed(0)}`}
          sub={`${perf.wins}K / ${perf.losses}K`}
          color={perf.winRate >= 55 ? '#10e87a' : perf.winRate >= 40 ? '#f59e0b' : '#f43f5e'} />
        <StatCard label="EXPECTANCY" value={`${perf.expectancy >= 0 ? '+' : ''}${perf.expectancy.toFixed(2)}%`}
          sub={`Sharpe: ${perf.sharpe.toFixed(2)}`} color={pnlColor(perf.expectancy)} />
        <StatCard label="MAX DRAWDOWN" value={`-%${perf.maxDD.toFixed(1)}`}
          sub={`PF: ${isFinite(perf.profitFactor) ? perf.profitFactor.toFixed(2) : '∞'}`}
          color={perf.maxDD > 15 ? '#f43f5e' : perf.maxDD > 8 ? '#f59e0b' : '#10e87a'} />
        <StatCard label="ACİK POZİSYON" value={positions.length}
          sub={`Max: ${config?.maxPositions || 8}`}
          color={positions.length > 0 ? '#60a5fa' : 'var(--t3)'} />
        {perf.currentStreak !== 0 && (
          <StatCard label="STREAK"
            value={`${perf.currentStreak > 0 ? '🔥' : '❄️'} ${Math.abs(perf.currentStreak)}`}
            sub={perf.currentStreak > 0 ? 'kazanma serisi' : 'kayip serisi'}
            color={pnlColor(perf.currentStreak)} />
        )}
      </div>

      {/* TAB NAV */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, borderBottom: '1px solid rgba(255,255,255,0.07)', paddingBottom: 8 }}>
        {[
          { id: 'positions', label: `📊 Acik (${positions.length})` },
          { id: 'history',   label: `📜 Gecmis (${closedTrades.length})` },
          { id: 'equity',    label: '📈 Equity' },
          { id: 'settings',  label: '⚙ Ayarlar' },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '5px 12px', borderRadius: 5, cursor: 'pointer', fontSize: 10,
            fontWeight: 700, letterSpacing: 0.3,
            background: tab === t.id ? 'rgba(99,102,241,0.2)' : 'transparent',
            border: tab === t.id ? '1px solid rgba(99,102,241,0.5)' : '1px solid transparent',
            color: tab === t.id ? '#818cf8' : 'var(--t3)',
          }}>{t.label}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={reset} style={{
          padding: '5px 12px', borderRadius: 5, cursor: 'pointer', fontSize: 9,
          fontWeight: 700, background: 'rgba(244,63,94,0.1)',
          border: '1px solid rgba(244,63,94,0.3)', color: '#f87171',
        }}>{'🔄'} SIFIRLA</button>
      </div>

      {/* OPEN POSITIONS */}
      {tab === 'positions' && (
        <div>
          {positions.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--t3)', fontSize: 12 }}>
              <div style={{ fontSize: 28, marginBottom: 10 }}>{'📋'}</div>
              <div>Acik pozisyon yok.</div>
              <div style={{ fontSize: 10, marginTop: 6, color: 'var(--t3)' }}>
                {autoTrade ? 'AI Advisor sonraki taramada otomatik giris yapacak'
                  : 'Auto Trade\'i aktifle ya da AI Advisor\'dan manuel ekle'}
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
              {positions.map(pos => {
                const cur = pos.currentPrice || pos.entry;
                const unrlPnl = (cur - pos.entry) / pos.entry * pos.size;
                const unrlPct = (cur - pos.entry) / pos.entry * 100;
                return (
                  <div key={pos.id} style={{
                    background: 'rgba(255,255,255,0.04)',
                    border: `1px solid ${unrlPct >= 0 ? 'rgba(16,232,122,0.2)' : 'rgba(244,63,94,0.2)'}`,
                    borderRadius: 8, padding: 12, transition: 'border-color 0.3s',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                      <div>
                        <span style={{ fontWeight: 800, fontSize: 13, color: 'var(--t1)' }}>{pos.symbol}</span>
                        {pos._earlyPick && <span style={{ marginLeft: 5, fontSize: 8, color: '#a78bfa' }}>{'🔍'}ERKEN</span>}
                        <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 1 }}>
                          {pos.sector || ''} · {pos.tier || pos.grade || ''} · conf:{pos.confidence}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 14, fontWeight: 800, color: pnlColor(unrlPct) }}>{pct(unrlPct)}</div>
                        <div style={{ fontSize: 9, color: pnlColor(unrlPnl) }}>
                          {unrlPnl >= 0 ? '+' : ''}₺{tl(unrlPnl)}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 6 }}>
                      <span style={{ color: 'var(--t3)' }}>Giris: <b style={{ color: 'var(--t2)' }}>{pos.entry.toFixed(2)}</b></span>
                      <span style={{ color: 'var(--t3)' }}>Anlik: <b style={{ color: 'var(--t1)' }}>{cur.toFixed(2)}</b></span>
                      <span style={{ color: 'var(--t3)' }}>Lot: <b style={{ color: 'var(--t2)' }}>₺{tl(pos.size)}</b></span>
                    </div>
                    <PosProgressBar pos={pos} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                      <span style={{ fontSize: 8, color: 'var(--t3)' }}>
                        {new Date(pos.openedAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}
                        {pos.source === 'advisor_auto' ? ' · AUTO' : pos.source === 'manual' ? ' · MANUEL' : ''}
                      </span>
                      <button onClick={() => closePosition(pos.symbol, cur)} style={{
                        fontSize: 9, padding: '3px 9px', borderRadius: 4, cursor: 'pointer',
                        background: 'rgba(244,63,94,0.15)', border: '1px solid rgba(244,63,94,0.35)',
                        color: '#f87171', fontWeight: 700,
                      }}>× KAPAT</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TRADE HISTORY */}
      {tab === 'history' && (
        <div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <span style={{ fontSize: 9, color: 'var(--t3)', alignSelf: 'center' }}>Siralama:</span>
            {['date', 'pnl', 'symbol'].map(s => (
              <button key={s} onClick={() => setSortHistory(s)} style={{
                fontSize: 9, padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
                background: sortHistory === s ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.05)',
                border: `1px solid ${sortHistory === s ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.1)'}`,
                color: sortHistory === s ? '#818cf8' : 'var(--t3)',
              }}>{s === 'date' ? 'Tarih' : s === 'pnl' ? 'P&L' : 'Sembol'}</button>
            ))}
          </div>
          {sortedHistory.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--t3)', fontSize: 12 }}>
              Henuz kapali islem yok. Ilk pozisyonu ac.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', color: 'var(--t3)' }}>
                    {['Sembol', 'Giris', 'Cikis', 'Neden', 'P&L TL', 'P&L %', 'Lot', 'Sure', 'Conf'].map(h => (
                      <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, letterSpacing: 0.3, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedHistory.map((t, i) => {
                    const heldH = Math.floor((t.heldMs || 0) / 3600000);
                    const heldM = Math.floor(((t.heldMs || 0) % 3600000) / 60000);
                    return (
                      <tr key={t.id || i} style={{
                        borderBottom: '1px solid rgba(255,255,255,0.04)',
                        background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                      }}>
                        <td style={{ padding: '7px 10px', fontWeight: 700, color: 'var(--t1)' }}>
                          {t.symbol}
                          {t._earlyPick && <span style={{ marginLeft: 4, fontSize: 7, color: '#a78bfa' }}>ERKEN</span>}
                        </td>
                        <td style={{ padding: '7px 10px', color: 'var(--t2)' }}>{t.entry?.toFixed(2)}</td>
                        <td style={{ padding: '7px 10px', color: 'var(--t2)' }}>{t.exit?.toFixed(2)}</td>
                        <td style={{ padding: '7px 10px' }}>
                          <span style={{
                            fontSize: 8, padding: '1px 6px', borderRadius: 3, fontWeight: 700,
                            background: t.exitReason === 'TARGET' ? 'rgba(16,232,122,0.15)'
                              : t.exitReason === 'STOP' ? 'rgba(244,63,94,0.15)'
                              : t.exitReason === 'EOD' ? 'rgba(251,191,36,0.15)'
                              : 'rgba(255,255,255,0.08)',
                            color: t.exitReason === 'TARGET' ? '#10e87a'
                              : t.exitReason === 'STOP' ? '#f43f5e'
                              : t.exitReason === 'EOD' ? '#fbbf24'
                              : 'var(--t3)',
                            border: `1px solid ${t.exitReason === 'TARGET' ? 'rgba(16,232,122,0.3)'
                              : t.exitReason === 'STOP' ? 'rgba(244,63,94,0.3)'
                              : 'rgba(255,255,255,0.1)'}`,
                          }}>{t.exitReason}</span>
                        </td>
                        <td style={{ padding: '7px 10px', color: pnlColor(t.pnl), fontWeight: 700 }}>
                          {t.pnl >= 0 ? '+' : ''}₺{tl(t.pnl)}
                        </td>
                        <td style={{ padding: '7px 10px', color: pnlColor(t.pnlPct), fontWeight: 700 }}>
                          {pct(t.pnlPct)}
                        </td>
                        <td style={{ padding: '7px 10px', color: 'var(--t3)' }}>₺{tl(t.size)}</td>
                        <td style={{ padding: '7px 10px', color: 'var(--t3)', whiteSpace: 'nowrap' }}>
                          {heldH > 0 ? `${heldH}s` : ''}{heldM}d
                        </td>
                        <td style={{ padding: '7px 10px', color: 'var(--t3)' }}>{t.confidence || '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* EQUITY CURVE */}
      {tab === 'equity' && (
        <div>
          <div style={{
            background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: 10, padding: '16px 20px', marginBottom: 14,
          }}>
            <div style={{ fontSize: 10, color: 'var(--t3)', marginBottom: 10 }}>
              Equity Curve — Baslangic: ₺{tl(startCapital)} · Toplam: {equityCurve.length} nokta
            </div>
            <EquitySpark curve={equityCurve} startCapital={startCapital} />
          </div>
          <div style={{
            background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: 10, padding: '16px 20px',
          }}>
            <div style={{ fontSize: 10, color: 'var(--t3)', marginBottom: 10, letterSpacing: 1 }}>
              PERFORMANS OZETI — {daysRunning} gun · {perf.totalTrades} islem
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', fontSize: 11 }}>
              {[
                ['Net P&L', `${perf.totalPnl >= 0 ? '+' : ''}₺${tl(perf.totalPnl)} (${pct(perf.totalPnlPct)})`, pnlColor(perf.totalPnl)],
                ['Win Rate', `%${perf.winRate.toFixed(1)} (${perf.wins}K/${perf.losses}K)`, perf.winRate >= 50 ? '#10e87a' : '#f43f5e'],
                ['Avg Kazanc', `+${perf.avgWinPct.toFixed(2)}%`, '#10e87a'],
                ['Avg Kayip', `${perf.avgLossPct.toFixed(2)}%`, '#f43f5e'],
                ['Expectancy', `${perf.expectancy >= 0 ? '+' : ''}${perf.expectancy.toFixed(2)}%`, pnlColor(perf.expectancy)],
                ['Profit Factor', isFinite(perf.profitFactor) ? perf.profitFactor.toFixed(2) : '∞', perf.profitFactor >= 1.5 ? '#10e87a' : '#f59e0b'],
                ['Max Drawdown', `-%${perf.maxDD.toFixed(1)}`, perf.maxDD > 15 ? '#f43f5e' : perf.maxDD > 8 ? '#f59e0b' : '#10e87a'],
                ['Sharpe Ratio', perf.sharpe.toFixed(2), perf.sharpe >= 1 ? '#10e87a' : perf.sharpe >= 0.5 ? '#f59e0b' : '#f43f5e'],
                ['Unrealized', `${perf.unrealizedPnl >= 0 ? '+' : ''}₺${tl(perf.unrealizedPnl)}`, pnlColor(perf.unrealizedPnl)],
                ['Total Equity', `₺${tl(perf.totalEquity)}`, pnlColor(perf.totalEquityPct)],
              ].map(([label, val, color]) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <span style={{ color: 'var(--t3)' }}>{label}</span>
                  <span style={{ fontWeight: 700, color: color || 'var(--t1)' }}>{val}</span>
                </div>
              ))}
            </div>
            {perf.totalTrades >= 10 && (
              <div style={{
                marginTop: 14, padding: '10px 14px', borderRadius: 8,
                background: 'rgba(124,58,237,0.1)', border: '1px solid rgba(124,58,237,0.3)',
                fontSize: 10, color: '#c4b5fd',
              }}>
                <b>{'⚡'} Phase 9 Hazir:</b> {perf.totalTrades} islem kaydedildi.
                Win Rate: %{perf.winRate.toFixed(0)} · Expectancy: {perf.expectancy.toFixed(2)}% →
                Bu parametreler terminal ayarlarina aktarilabilir.
                {perf.winRate >= 55 && perf.expectancy > 0.5
                  ? ' Strateji KANITLANDI — mevcut parametrelere devam et.'
                  : perf.winRate < 45
                  ? ' Strateji gozden gecir — MIN_CONFIDENCE artir ya da islem sayisi tut.'
                  : ' Yeterli veri birikince Phase 9 otomatik tune edecek.'}
              </div>
            )}
          </div>
        </div>
      )}

      {/* SETTINGS */}
      {tab === 'settings' && (
        <div style={{ maxWidth: 480 }}>
          <div style={{
            background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: 10, padding: '16px 20px',
          }}>
            <div style={{ fontSize: 10, color: 'var(--t3)', marginBottom: 14, letterSpacing: 1 }}>
              STRATEJI PARAMETRELERI
            </div>
            {[
              { label: 'Min Confidence (GOOD=65, STRONG=75)', key: 'minConfidence', min: 40, max: 85, step: 5,
                hint: 'Dusuk = daha fazla islem, yuksek = secici. Backtest sonucuyla eslestir.' },
              { label: 'Risk per Trade (%)', key: 'riskPerTrade', min: 0.5, max: 4, step: 0.5, isPercent: true,
                hint: 'Kapitalin kac %\'ini risk aliyorsun. %2 standard.' },
              { label: 'Max Pozisyon Buyuklugu (%)', key: 'maxPosPct', min: 5, max: 25, step: 5, isPercent: true,
                hint: 'Tek pozisyon max kapital yuzdesi.' },
              { label: 'Max Esanlik Pozisyon', key: 'maxPositions', min: 2, max: 15, step: 1,
                hint: 'Daha az = konsantre, daha cok = diversifiye.' },
            ].map(({ label, key, min, max, step, isPercent, hint }) => {
              const val = config?.[key] ?? (key === 'minConfidence' ? 65 : key === 'riskPerTrade' ? 0.02 : key === 'maxPosPct' ? 0.15 : 8);
              const displayVal = isPercent ? (val * 100).toFixed(1) : val;
              return (
                <div key={key} style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 10, color: 'var(--t2)' }}>{label}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#60a5fa' }}>
                      {displayVal}{isPercent ? '%' : ''}
                    </span>
                  </div>
                  <input type="range" min={min} max={max} step={step}
                    value={isPercent ? val * 100 : val}
                    onChange={(e) => {
                      const newVal = isPercent ? parseFloat(e.target.value) / 100 : parseFloat(e.target.value);
                      updateConfig({ [key]: newVal });
                    }}
                    style={{ width: '100%', accentColor: '#6366f1', cursor: 'pointer' }} />
                  <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 3 }}>{hint}</div>
                </div>
              );
            })}
            <div style={{
              marginTop: 10, padding: '10px 12px', borderRadius: 6,
              background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)',
              fontSize: 9, color: '#fbbf24',
            }}>
              {'⚡'} <b>Phase 9 Hedef:</b> Bu parametreler backtest win rate ile %5 sapmayla eslesmeli.
              Espriyi kanitalamak icin en az 20 islem gerekli.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
