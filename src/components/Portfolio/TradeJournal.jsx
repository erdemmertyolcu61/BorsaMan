import { useState, useMemo } from 'react';

const JOURNAL_KEY = 'bist_trade_journal';

function loadJournal() {
  try {
    const raw = localStorage.getItem(JOURNAL_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function saveJournal(data) {
  try {
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(data));
  } catch {}
}

const EMOTIONS = [
  { label: 'Sakin',     value: 'calm',      color: 'var(--green)' },
  { label: 'Heyecanli', value: 'excited',   color: 'var(--yellow)' },
  { label: 'Korkulu',   value: 'fearful',   color: 'var(--red)' },
  { label: 'Acimasiz',  value: 'greedy',    color: 'var(--orange,#ff9800)' },
  { label: 'Karasiz',   value: 'uncertain', color: 'var(--t3)' },
];

const SETUPS = ['Kirilim', 'Geri Cekilme', 'Momentum', 'Reversal', 'Range', 'Squeeze', 'Trend Takip', 'Diger'];

const EMPTY_FORM = {
  symbol: '',
  date: '',
  direction: 'long',
  setup: '',
  entry: '',
  exit: '',
  shares: '',
  pnl: '',
  emotion: 'calm',
  note: '',
  lesson: '',
  rating: 3,
  screenshot: '',
};

export default function TradeJournal({ portfolio }) {
  const [journal, setJournal] = useState(loadJournal);
  const [showForm, setShowForm] = useState(false);
  const [showStats, setShowStats] = useState(true);
  const [filter, setFilter] = useState('all');
  const [form, setForm] = useState(() => ({ ...EMPTY_FORM, date: new Date().toISOString().slice(0, 10) }));

  const update = (next) => {
    setJournal(next);
    saveJournal(next);
  };

  const addTrade = () => {
    if (!form.symbol || !form.entry) return;
    const trade = {
      ...form,
      id: Date.now(),
      entry: parseFloat(form.entry) || 0,
      exit: parseFloat(form.exit) || 0,
      shares: parseInt(form.shares) || 0,
      pnl: parseFloat(form.pnl) || 0,
    };
    update([trade, ...journal]);
    setForm({ ...EMPTY_FORM, date: new Date().toISOString().slice(0, 10) });
    setShowForm(false);
  };

  const deleteTrade = (id) => update(journal.filter(t => t.id !== id));

  const autoImport = () => {
    const closed = (portfolio?.positions || []).filter(p => p.status === 'closed');
    const seen = new Set(journal.map(t => `${t.symbol}-${t.date}`));
    let added = 0;
    const next = [...journal];
    for (const pos of closed) {
      const date = pos.closedAt ? pos.closedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);
      const key = `${pos.symbol}-${date}`;
      if (seen.has(key)) continue;
      next.unshift({
        id: Date.now() + added,
        symbol: pos.symbol,
        date,
        direction: 'long',
        setup: pos.closeReason === 'TARGET' ? 'Trend Takip' : pos.closeReason === 'STOP' ? 'Diger' : '',
        entry: pos.entryPrice,
        exit: pos.currentPrice,
        shares: pos.shares,
        pnl: pos.pnl || 0,
        emotion: 'calm',
        note: `Otomatik iceaktarim. Kapanis nedeni: ${pos.closeReason || 'Manuel'}`,
        lesson: '',
        rating: (pos.pnl || 0) >= 0 ? 4 : 2,
        screenshot: '',
      });
      added++;
    }
    if (added > 0) update(next);
    return added;
  };

  const stats = useMemo(() => {
    if (journal.length === 0) return null;
    const wins = journal.filter(t => t.pnl > 0);
    const losses = journal.filter(t => t.pnl < 0);
    const breakeven = journal.filter(t => t.pnl === 0);
    const totalPnl = journal.reduce((s, t) => s + t.pnl, 0);
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
    const winRate = journal.length > 0 ? (wins.length / journal.length) * 100 : 0;
    const profitFactor = avgLoss > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : (avgWin > 0 ? Infinity : 0);
    const expectancy = journal.length > 0 ? totalPnl / journal.length : 0;
    const best = journal.reduce((acc, t) => t.pnl > acc.pnl ? t : acc, journal[0]);
    const worst = journal.reduce((acc, t) => t.pnl < acc.pnl ? t : acc, journal[0]);

    let maxWinStreak = 0, maxLossStreak = 0, curStreak = 0, lastType = null;
    for (const t of [...journal].reverse()) {
      const type = t.pnl > 0 ? 'win' : t.pnl < 0 ? 'loss' : null;
      if (type === lastType) curStreak++;
      else { curStreak = 1; lastType = type; }
      if (type === 'win') maxWinStreak = Math.max(maxWinStreak, curStreak);
      if (type === 'loss') maxLossStreak = Math.max(maxLossStreak, curStreak);
    }

    const setupStats = {};
    for (const t of journal) {
      const key = t.setup || 'Diger';
      if (!setupStats[key]) setupStats[key] = { count: 0, wins: 0, pnl: 0 };
      setupStats[key].count++;
      if (t.pnl > 0) setupStats[key].wins++;
      setupStats[key].pnl += t.pnl;
    }

    const emotionStats = {};
    for (const t of journal) {
      const key = t.emotion || 'calm';
      if (!emotionStats[key]) emotionStats[key] = { count: 0, wins: 0, pnl: 0 };
      emotionStats[key].count++;
      if (t.pnl > 0) emotionStats[key].wins++;
      emotionStats[key].pnl += t.pnl;
    }

    const weeklyPnl = {};
    for (const t of journal) {
      const key = t.date ? t.date.slice(0, 7) : 'unknown';
      weeklyPnl[key] = (weeklyPnl[key] || 0) + t.pnl;
    }

    const today = new Date().toISOString().slice(0, 10);
    const todayList = journal.filter(t => t.date === today);
    const todayPnl = todayList.reduce((s, t) => s + t.pnl, 0);
    const todayTrades = todayList.length;

    const sorted = [...journal].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const equityCurve = [];
    let cumul = 0;
    for (const t of sorted) {
      cumul += t.pnl;
      equityCurve.push({ date: t.date, pnl: cumul, symbol: t.symbol, single: t.pnl });
    }

    let peak = 0, maxDrawdown = 0;
    for (const pt of equityCurve) {
      if (pt.pnl > peak) peak = pt.pnl;
      const dd = peak - pt.pnl;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    const dailyPnl = {};
    for (const t of journal) {
      const key = t.date || 'unknown';
      if (!dailyPnl[key]) dailyPnl[key] = { pnl: 0, count: 0 };
      dailyPnl[key].pnl += t.pnl;
      dailyPnl[key].count++;
    }

    return {
      total: journal.length,
      wins: wins.length,
      losses: losses.length,
      breakeven: breakeven.length,
      totalPnl, avgWin, avgLoss, winRate, profitFactor, expectancy,
      best, worst, maxWinStreak, maxLossStreak,
      setupStats, emotionStats, weeklyPnl,
      todayPnl, todayTrades,
      equityCurve, maxDrawdown, dailyPnl,
    };
  }, [journal]);

  const filtered = filter === 'all'
    ? journal
    : filter === 'win'
      ? journal.filter(t => t.pnl > 0)
      : journal.filter(t => t.pnl < 0);

  return (
    <div style={{ marginTop: 24, borderTop: '2px solid var(--cyan)', paddingTop: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontFamily: 'Space Grotesk,sans-serif', fontSize: 16, fontWeight: 700, color: 'var(--cyan)' }}>
          Trade Gunlugu
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="scan-btn ai" onClick={() => setShowForm(!showForm)} style={{ fontSize: 9, padding: '6px 12px' }}>
            {showForm ? 'KAPAT' : '+ YENİ GİRİŞ'}
          </button>
          <button
            className="scan-btn go"
            onClick={() => {
              const n = autoImport();
              alert(n > 0 ? `${n} trade iceaktarildi.` : 'Yeni trade bulunamadi.');
            }}
            style={{ fontSize: 9, padding: '6px 12px', background: 'var(--bg3)', color: 'var(--t2)', border: '1px solid var(--border)' }}
          >
            OTO-AKTAR
          </button>
          <button
            className="scan-btn go"
            onClick={() => setShowStats(!showStats)}
            style={{ fontSize: 9, padding: '6px 12px', background: 'var(--bg3)', color: 'var(--purple)', border: '1px solid var(--purple)' }}
          >
            {showStats ? 'GİZLE İSTATİSTİK' : 'İSTATİSTİK'}
          </button>
        </div>
      </div>

      {/* Today's performance */}
      {stats && stats.todayTrades > 0 && (
        <div style={{
          background: stats.todayPnl >= 0 ? 'rgba(0,230,118,0.08)' : 'rgba(255,23,68,0.08)',
          border: `1px solid ${stats.todayPnl >= 0 ? 'var(--green)' : 'var(--red)'}`,
          borderRadius: 6, padding: '8px 12px', marginBottom: 10,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{ fontSize: 10, color: 'var(--t2)' }}>
            Bugunun Performansi ({stats.todayTrades} trade)
          </span>
          <span style={{ fontSize: 14, fontWeight: 700, color: stats.todayPnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
            {stats.todayPnl >= 0 ? '+' : ''}{stats.todayPnl.toFixed(0)} TL
          </span>
        </div>
      )}

      {/* Stats block */}
      {showStats && stats && (
        <div style={{ marginBottom: 12 }}>
          {/* Metric grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(100px,1fr))', gap: 6, marginBottom: 10 }}>
            {[
              { label: 'Toplam Trade', val: stats.total, color: 'var(--cyan)' },
              { label: 'Kazanma Orani', val: `%${stats.winRate.toFixed(1)}`, color: stats.winRate >= 50 ? 'var(--green)' : 'var(--red)' },
              { label: 'Beklenti', val: `${stats.expectancy >= 0 ? '+' : ''}${stats.expectancy.toFixed(0)} TL`, color: stats.expectancy >= 0 ? 'var(--green)' : 'var(--red)' },
              { label: 'Profit Faktor', val: stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2), color: stats.profitFactor >= 1.5 ? 'var(--green)' : stats.profitFactor >= 1 ? 'var(--yellow)' : 'var(--red)' },
              { label: 'Ort Kazanc', val: `+${stats.avgWin.toFixed(0)} TL`, color: 'var(--green)' },
              { label: 'Ort Kayip', val: `-${stats.avgLoss.toFixed(0)} TL`, color: 'var(--red)' },
              { label: 'Toplam K/Z', val: `${stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(0)} TL`, color: stats.totalPnl >= 0 ? 'var(--green)' : 'var(--red)' },
              { label: 'Max Seri Kazanc', val: stats.maxWinStreak, color: 'var(--green)' },
              { label: 'Max Seri Kayip', val: stats.maxLossStreak, color: 'var(--red)' },
            ].map((m, i) => (
              <div key={i} style={{ background: 'var(--bg3)', padding: '8px 6px', borderRadius: 4, textAlign: 'center' }}>
                <div style={{ fontSize: 7, textTransform: 'uppercase', color: 'var(--t3)', letterSpacing: 0.5 }}>{m.label}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: m.color, marginTop: 2 }}>{m.val}</div>
              </div>
            ))}
          </div>

          {/* Win/Loss bar */}
          <div style={{ background: 'var(--bg3)', borderRadius: 4, padding: 8, marginBottom: 8 }}>
            <div style={{ fontSize: 8, color: 'var(--t3)', marginBottom: 4 }}>KAZANMA / KAYIP DAGILIMI</div>
            <div style={{ display: 'flex', height: 14, borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${stats.winRate}%`, background: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {stats.winRate >= 15 && (
                  <span style={{ fontSize: 8, fontWeight: 700, color: '#000' }}>{stats.wins}W</span>
                )}
              </div>
              {stats.breakeven > 0 && (
                <div style={{ width: `${(stats.breakeven / stats.total) * 100}%`, background: 'var(--t3)' }} />
              )}
              <div style={{ flex: 1, background: 'var(--red)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {100 - stats.winRate >= 15 && (
                  <span style={{ fontSize: 8, fontWeight: 700, color: '#000' }}>{stats.losses}L</span>
                )}
              </div>
            </div>
          </div>

          {/* Setup perf */}
          {Object.keys(stats.setupStats).length > 1 && (
            <div style={{ background: 'var(--bg3)', borderRadius: 4, padding: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 8, color: 'var(--t3)', marginBottom: 4 }}>SETUP PERFORMANSI</div>
              {Object.entries(stats.setupStats).sort((a, b) => b[1].pnl - a[1].pnl).map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: 10 }}>
                  <span style={{ color: 'var(--t2)' }}>
                    {k} ({v.count}x, %{((v.wins / v.count) * 100).toFixed(0)})
                  </span>
                  <span style={{ color: v.pnl >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                    {v.pnl >= 0 ? '+' : ''}{v.pnl.toFixed(0)} TL
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Emotion perf */}
          {Object.keys(stats.emotionStats).length > 1 && (
            <div style={{ background: 'var(--bg3)', borderRadius: 4, padding: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 8, color: 'var(--t3)', marginBottom: 4 }}>DUYGU DURUMU & PERFORMANS</div>
              {Object.entries(stats.emotionStats).map(([k, v]) => {
                const cfg = EMOTIONS.find(e => e.value === k) || { label: k, color: 'var(--t2)' };
                return (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: 10 }}>
                    <span style={{ color: cfg.color }}>{cfg.label} ({v.count}x)</span>
                    <span style={{ color: v.pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                      {v.pnl >= 0 ? '+' : ''}{v.pnl.toFixed(0)} TL (%{((v.wins / v.count) * 100).toFixed(0)} win)
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Monthly PnL */}
          {Object.keys(stats.weeklyPnl).length > 1 && (
            <div style={{ background: 'var(--bg3)', borderRadius: 4, padding: 8 }}>
              <div style={{ fontSize: 8, color: 'var(--t3)', marginBottom: 4 }}>AYLIK K/Z</div>
              {Object.entries(stats.weeklyPnl).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 6).map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: 10 }}>
                  <span style={{ color: 'var(--t2)' }}>{k}</span>
                  <span style={{ color: v >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                    {v >= 0 ? '+' : ''}{v.toFixed(0)} TL
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Best/worst cards */}
          {stats.total > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 8 }}>
              <div style={{ background: 'rgba(0,230,118,0.06)', border: '1px solid var(--green)', borderRadius: 4, padding: 8 }}>
                <div style={{ fontSize: 7, textTransform: 'uppercase', color: 'var(--green)', letterSpacing: 0.5 }}>En Iyi Trade</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--green)' }}>
                  {stats.best.symbol} +{stats.best.pnl.toFixed(0)} TL
                </div>
                <div style={{ fontSize: 8, color: 'var(--t3)' }}>{stats.best.date}</div>
              </div>
              <div style={{ background: 'rgba(255,23,68,0.06)', border: '1px solid var(--red)', borderRadius: 4, padding: 8 }}>
                <div style={{ fontSize: 7, textTransform: 'uppercase', color: 'var(--red)', letterSpacing: 0.5 }}>En Kotu Trade</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--red)' }}>
                  {stats.worst.symbol} {stats.worst.pnl.toFixed(0)} TL
                </div>
                <div style={{ fontSize: 8, color: 'var(--t3)' }}>{stats.worst.date}</div>
              </div>
            </div>
          )}

          {/* Equity Curve */}
          {stats.equityCurve.length >= 2 && (
            <div style={{ background: 'var(--bg3)', borderRadius: 4, padding: 8, marginTop: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ fontSize: 8, color: 'var(--t3)', textTransform: 'uppercase' }}>EQUITY CURVE (Kumulatif K/Z)</div>
                <div style={{ fontSize: 9, fontWeight: 700, color: stats.totalPnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {stats.totalPnl >= 0 ? '+' : ''}{stats.totalPnl.toFixed(0)} TL | DD: {stats.maxDrawdown.toFixed(0)} TL
                </div>
              </div>
              <div style={{ height: 80, position: 'relative', borderBottom: '1px solid var(--border)' }}>
                {(() => {
                  const pts = stats.equityCurve;
                  const pnls = pts.map(p => p.pnl);
                  const min = Math.min(0, ...pnls);
                  const max = Math.max(0, ...pnls);
                  const range = (max - min) || 1;
                  const zeroY = ((max - 0) / range) * 100;
                  const width = pts.length * 10;
                  return (
                    <svg viewBox={`0 0 ${width} 80`} style={{ width: '100%', height: '100%' }} preserveAspectRatio="none">
                      <line x1="0" y1={zeroY * 0.8} x2={width} y2={zeroY * 0.8} stroke="rgba(255,255,255,0.15)" strokeDasharray="3,3" />
                      <path
                        d={pts.map((p, i) => {
                          const x = i * 10 + 5;
                          const y = ((max - p.pnl) / range) * 76 + 2;
                          return (i === 0 ? 'M' : 'L') + x + ',' + y;
                        }).join(' ') + ` L${(pts.length - 1) * 10 + 5},${zeroY * 0.76 + 2} L5,${zeroY * 0.76 + 2} Z`}
                        fill={stats.totalPnl >= 0 ? 'rgba(0,230,118,0.15)' : 'rgba(255,23,68,0.15)'}
                      />
                      <polyline
                        points={pts.map((p, i) => `${i * 10 + 5},${((max - p.pnl) / range) * 76 + 2}`).join(' ')}
                        fill="none"
                        stroke={stats.totalPnl >= 0 ? '#00e676' : '#ff1744'}
                        strokeWidth="1.5"
                      />
                      {pts.map((p, i) => (
                        <circle
                          key={i}
                          cx={i * 10 + 5}
                          cy={((max - p.pnl) / range) * 76 + 2}
                          r="2"
                          fill={p.single >= 0 ? '#00e676' : '#ff1744'}
                        />
                      ))}
                    </svg>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Daily PnL bars */}
          {stats.dailyPnl && Object.keys(stats.dailyPnl).length >= 2 && (
            <div style={{ background: 'var(--bg3)', borderRadius: 4, padding: 8, marginTop: 8 }}>
              <div style={{ fontSize: 8, color: 'var(--t3)', textTransform: 'uppercase', marginBottom: 6 }}>GUNLUK K/Z BARLARI</div>
              <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 60 }}>
                {(() => {
                  const entries = Object.entries(stats.dailyPnl).sort((a, b) => a[0].localeCompare(b[0])).slice(-20);
                  const peakAbs = Math.max(...entries.map(([, v]) => Math.abs(v.pnl)), 1);
                  return entries.map(([date, v]) => {
                    const h = (Math.abs(v.pnl) / peakAbs) * 50;
                    const positive = v.pnl >= 0;
                    return (
                      <div
                        key={date}
                        style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end' }}
                        title={`${date}: ${v.pnl >= 0 ? '+' : ''}${v.pnl.toFixed(0)} TL (${v.count} trade)`}
                      >
                        <div style={{
                          width: '80%', height: h, minHeight: 2, borderRadius: 2,
                          background: positive ? 'var(--green)' : 'var(--red)', opacity: 0.8,
                        }} />
                        <div style={{
                          fontSize: 6, color: 'var(--t3)', marginTop: 2,
                          transform: 'rotate(-45deg)', whiteSpace: 'nowrap',
                        }}>
                          {date.slice(5)}
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          )}
        </div>
      )}

      {/* New Entry Form */}
      {showForm && (
        <div style={{ background: 'var(--bg3)', border: '1px solid var(--cyan)', borderRadius: 6, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--cyan)', marginBottom: 8 }}>Yeni Trade Kaydi</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 8 }}>
            <div>
              <label style={{ fontSize: 8, color: 'var(--t3)', display: 'block', marginBottom: 2 }}>HİSSE</label>
              <input className="inp" value={form.symbol} onChange={e => setForm({ ...form, symbol: e.target.value.toUpperCase() })}
                placeholder="THYAO" style={{ width: '100%', fontSize: 10, padding: 6 }} />
            </div>
            <div>
              <label style={{ fontSize: 8, color: 'var(--t3)', display: 'block', marginBottom: 2 }}>TARİH</label>
              <input className="inp" type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })}
                style={{ width: '100%', fontSize: 10, padding: 6 }} />
            </div>
            <div>
              <label style={{ fontSize: 8, color: 'var(--t3)', display: 'block', marginBottom: 2 }}>YON</label>
              <select className="inp" value={form.direction} onChange={e => setForm({ ...form, direction: e.target.value })}
                style={{ width: '100%', fontSize: 10, padding: 6 }}>
                <option value="long">LONG</option>
                <option value="short">SHORT</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 8, color: 'var(--t3)', display: 'block', marginBottom: 2 }}>SETUP</label>
              <select className="inp" value={form.setup} onChange={e => setForm({ ...form, setup: e.target.value })}
                style={{ width: '100%', fontSize: 10, padding: 6 }}>
                <option value="">Sec...</option>
                {SETUPS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 8, color: 'var(--t3)', display: 'block', marginBottom: 2 }}>GİRİŞ</label>
              <input className="inp" type="number" value={form.entry} onChange={e => setForm({ ...form, entry: e.target.value })}
                placeholder="0.00" style={{ width: '100%', fontSize: 10, padding: 6 }} />
            </div>
            <div>
              <label style={{ fontSize: 8, color: 'var(--t3)', display: 'block', marginBottom: 2 }}>ÇIKIŞ</label>
              <input className="inp" type="number" value={form.exit} onChange={e => setForm({ ...form, exit: e.target.value })}
                placeholder="0.00" style={{ width: '100%', fontSize: 10, padding: 6 }} />
            </div>
            <div>
              <label style={{ fontSize: 8, color: 'var(--t3)', display: 'block', marginBottom: 2 }}>LOT</label>
              <input className="inp" type="number" value={form.shares} onChange={e => setForm({ ...form, shares: e.target.value })}
                placeholder="0" style={{ width: '100%', fontSize: 10, padding: 6 }} />
            </div>
            <div>
              <label style={{ fontSize: 8, color: 'var(--t3)', display: 'block', marginBottom: 2 }}>K/Z (TL)</label>
              <input className="inp" type="number" value={form.pnl} onChange={e => setForm({ ...form, pnl: e.target.value })}
                placeholder="0" style={{ width: '100%', fontSize: 10, padding: 6 }} />
            </div>
          </div>

          <div style={{ marginTop: 8 }}>
            <label style={{ fontSize: 8, color: 'var(--t3)', display: 'block', marginBottom: 2 }}>DUYGU DURUMU</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {EMOTIONS.map(em => (
                <button
                  key={em.value}
                  onClick={() => setForm({ ...form, emotion: em.value })}
                  style={{
                    fontSize: 9, padding: '4px 10px', borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit',
                    background: form.emotion === em.value ? em.color : 'var(--bg2)',
                    color: form.emotion === em.value ? '#000' : 'var(--t2)',
                    border: `1px solid ${form.emotion === em.value ? em.color : 'var(--border)'}`,
                  }}
                >
                  {em.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 8 }}>
            <label style={{ fontSize: 8, color: 'var(--t3)', display: 'block', marginBottom: 2 }}>DEĞERLENDİRME (1-5)</label>
            <div style={{ display: 'flex', gap: 4 }}>
              {[1, 2, 3, 4, 5].map(n => (
                <button
                  key={n}
                  onClick={() => setForm({ ...form, rating: n })}
                  style={{
                    fontSize: 12, padding: '2px 8px', borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit',
                    background: form.rating >= n ? 'var(--yellow)' : 'var(--bg2)',
                    color: form.rating >= n ? '#000' : 'var(--t3)',
                    border: 'none',
                  }}
                >
                  ★
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 8 }}>
            <label style={{ fontSize: 8, color: 'var(--t3)', display: 'block', marginBottom: 2 }}>NOT</label>
            <input className="inp" value={form.note} onChange={e => setForm({ ...form, note: e.target.value })}
              placeholder="Trade hakkinda notlar..." style={{ width: '100%', fontSize: 10, padding: 6 }} />
          </div>

          <div style={{ marginTop: 8 }}>
            <label style={{ fontSize: 8, color: 'var(--t3)', display: 'block', marginBottom: 2 }}>DERS</label>
            <input className="inp" value={form.lesson} onChange={e => setForm({ ...form, lesson: e.target.value })}
              placeholder="Bu tradeden ne ogrendim?" style={{ width: '100%', fontSize: 10, padding: 6 }} />
          </div>

          <button className="scan-btn ai" onClick={addTrade} style={{ marginTop: 10, fontSize: 10, padding: '8px 24px' }}>
            KAYDET
          </button>
        </div>
      )}

      {/* Filter tabs */}
      {journal.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          {[
            { key: 'all',  label: `Tumu (${journal.length})` },
            { key: 'win',  label: `Kazanc (${journal.filter(t => t.pnl > 0).length})` },
            { key: 'loss', label: `Kayip (${journal.filter(t => t.pnl < 0).length})` },
          ].map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                fontSize: 9, padding: '4px 10px', borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit',
                background: filter === f.key ? 'var(--cyan)' : 'var(--bg3)',
                color: filter === f.key ? '#000' : 'var(--t2)',
                border: `1px solid ${filter === f.key ? 'var(--cyan)' : 'var(--border)'}`,
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      {/* Empty state */}
      {filtered.length === 0 && journal.length === 0 && (
        <div style={{ textAlign: 'center', padding: 30, color: 'var(--t3)', fontSize: 11 }}>
          Henuz trade kaydi yok. Yeni giris ekleyin veya portfoydeki kapanan tradeleri otomatik aktarin.
        </div>
      )}

      {/* Trade list */}
      {filtered.slice(0, 20).map(t => {
        const entryStr = typeof t.entry === 'number' ? t.entry.toFixed(2) : (t.entry || '-');
        const exitStr = typeof t.exit === 'number' ? t.exit.toFixed(2) : (t.exit || '-');
        const pnlStr = typeof t.pnl === 'number' ? t.pnl.toFixed(0) : (t.pnl || 0);
        const emCfg = EMOTIONS.find(e => e.value === t.emotion) || {};
        return (
          <div key={t.id} style={{
            background: 'var(--bg3)',
            borderLeft: `3px solid ${t.pnl > 0 ? 'var(--green)' : t.pnl < 0 ? 'var(--red)' : 'var(--t3)'}`,
            borderRadius: 5, padding: 10, marginBottom: 6,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: 12 }}>{t.symbol}</span>
                  <span style={{
                    fontSize: 8, padding: '1px 5px', borderRadius: 2,
                    background: t.direction === 'long' ? 'var(--green)' : 'var(--red)',
                    color: '#000', fontWeight: 600,
                  }}>
                    {t.direction.toUpperCase()}
                  </span>
                  {t.setup && (
                    <span style={{
                      fontSize: 8, padding: '1px 5px', borderRadius: 2,
                      background: 'var(--bg2)', color: 'var(--cyan)', border: '1px solid var(--border)',
                    }}>
                      {t.setup}
                    </span>
                  )}
                  <span style={{ fontSize: 8, color: 'var(--t3)' }}>{t.date}</span>
                  {t.rating > 0 && (
                    <span style={{ fontSize: 9, color: 'var(--yellow)' }}>{'★'.repeat(t.rating)}</span>
                  )}
                </div>
                <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 3 }}>
                  Giris: {entryStr} → Cikis: {exitStr} | {t.shares} lot
                  {t.emotion && (
                    <span style={{ marginLeft: 6, color: emCfg.color || 'var(--t3)' }}>
                      [{emCfg.label || t.emotion}]
                    </span>
                  )}
                </div>
                {t.note && (
                  <div style={{ fontSize: 9, color: 'var(--t2)', marginTop: 2 }}>{t.note}</div>
                )}
                {t.lesson && (
                  <div style={{ fontSize: 9, color: 'var(--yellow)', marginTop: 2, fontStyle: 'italic' }}>
                    Ders: {t.lesson}
                  </div>
                )}
              </div>
              <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                <div style={{
                  fontWeight: 700, fontSize: 12,
                  color: t.pnl > 0 ? 'var(--green)' : t.pnl < 0 ? 'var(--red)' : 'var(--t2)',
                }}>
                  {t.pnl > 0 ? '+' : ''}{pnlStr} TL
                </div>
                <button
                  onClick={() => deleteTrade(t.id)}
                  style={{
                    fontSize: 8, padding: '1px 6px', background: 'none',
                    color: 'var(--t3)', border: '1px solid var(--border)',
                    borderRadius: 2, cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  SIL
                </button>
              </div>
            </div>
          </div>
        );
      })}

      {filtered.length > 20 && (
        <div style={{ textAlign: 'center', fontSize: 9, color: 'var(--t3)', padding: 8 }}>
          +{filtered.length - 20} daha fazla trade...
        </div>
      )}
    </div>
  );
}
