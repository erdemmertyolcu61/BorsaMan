// Unified accuracy computation across 3 outcome tracking systems:
// forwardTestJournal, useSignalTracker, PaperTradeEngine

function tradingDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function bucket(acc, key, isWin, ret) {
  if (!key) key = '—';
  if (!acc[key]) acc[key] = { total: 0, wins: 0, sumRet: 0 };
  acc[key].total += 1;
  if (isWin) acc[key].wins += 1;
  acc[key].sumRet += ret;
}

function finalize(acc) {
  const out = {};
  for (const [k, v] of Object.entries(acc)) {
    out[k] = {
      total: v.total,
      wins: v.wins,
      winRate: v.total > 0 ? (v.wins / v.total) * 100 : 0,
      avgReturn: v.total > 0 ? v.sumRet / v.total : 0,
    };
  }
  return out;
}

export function computeUnifiedStats({ journalDays = [], signals = [], paperTrades = [] } = {}) {
  const seen = new Set();
  const entries = [];

  // 1. Forward journal — ground truth, takes priority
  for (const day of journalDays) {
    const regime = day.regime || day.marketBias || null;
    for (const p of (day.predictions || [])) {
      if (!p.evaluatedAt || p.directionalHit == null) continue;
      const key = `${p.symbol}|${day.date}`;
      seen.add(key);

      const ret = p.perf?.d5 ?? p.perf?.d3 ?? p.perf?.d1 ?? 0;
      const isWin = p.directionalHit;

      entries.push({
        source: 'journal',
        symbol: p.symbol,
        regime: regime,
        grade: p.grade || null,
        tier: p.tier || null,
        confidence: p.confidence ?? null,
        firedSignals: Array.isArray(p.firedSignals) ? p.firedSignals : [],
        isWin,
        ret,
      });
    }
  }

  // 2. Signal tracker — only non-overlapping
  for (const s of signals) {
    if (s.status !== 'closed' || !s.outcome) continue;
    const day = tradingDay(s.timestamp instanceof Date ? s.timestamp.getTime() : s.timestamp);
    const key = `${s.symbol}|${day}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const isWin = s.outcome === 'TARGET_HIT' || s.outcome === 'WIN';
    const ret = s.perf?.d5 ?? s.perf?.d3 ?? s.perf?.d1 ?? 0;

    entries.push({
      source: 'tracker',
      symbol: s.symbol,
      regime: s.regime || null,
      grade: s.grade || null,
      tier: s.tier || null,
      confidence: s.confidence ?? s.score100 ?? null,
      firedSignals: Array.isArray(s.firedSignals) ? s.firedSignals : [],
      isWin,
      ret,
    });
  }

  // 3. Paper trades — only non-overlapping
  for (const t of paperTrades) {
    if (t.pnl_pct == null && t.pnlPct == null) continue;
    const pnl = t.pnl_pct ?? t.pnlPct ?? 0;
    const day = tradingDay(t.closed_at || t.closedAt || t.opened_at || t.openedAt || Date.now());
    const key = `${t.symbol}|${day}`;
    if (seen.has(key)) continue;
    seen.add(key);

    entries.push({
      source: 'paper',
      symbol: t.symbol,
      regime: t.regime || null,
      grade: t.grade || null,
      tier: null,
      confidence: null,
      firedSignals: [],
      isWin: pnl > 0,
      ret: pnl,
    });
  }

  // Aggregate
  const overall = { total: 0, wins: 0, sumRet: 0 };
  const byRegime = {};
  const bySignalType = {};
  const byGrade = {};
  const byTier = {};
  const bySources = {};
  const calBuckets = {};

  for (const e of entries) {
    overall.total += 1;
    if (e.isWin) overall.wins += 1;
    overall.sumRet += e.ret;

    bucket(byRegime, e.regime, e.isWin, e.ret);
    bucket(byGrade, e.grade, e.isWin, e.ret);
    bucket(byTier, e.tier, e.isWin, e.ret);
    bucket(bySources, e.source, e.isWin, e.ret);

    for (const sig of e.firedSignals) {
      bucket(bySignalType, sig, e.isWin, e.ret);
    }

    // Confidence calibration (decile buckets)
    if (e.confidence != null && Number.isFinite(e.confidence)) {
      const dec = Math.min(90, Math.max(0, Math.floor(e.confidence / 10) * 10));
      const label = `${dec}-${dec + 10}`;
      bucket(calBuckets, label, e.isWin, e.ret);
    }
  }

  const calibration = Object.entries(calBuckets)
    .map(([label, v]) => ({
      bucket: label,
      predicted: parseInt(label.split('-')[0]) + 5,
      actual: v.total > 0 ? (v.wins / v.total) * 100 : 0,
      count: v.total,
    }))
    .sort((a, b) => a.predicted - b.predicted);

  return {
    overall: {
      total: overall.total,
      wins: overall.wins,
      winRate: overall.total > 0 ? (overall.wins / overall.total) * 100 : 0,
      avgReturn: overall.total > 0 ? overall.sumRet / overall.total : 0,
      expectancy: overall.total > 0 ? overall.sumRet / overall.total : 0,
    },
    byRegime: finalize(byRegime),
    bySignalType: finalize(bySignalType),
    byGrade: finalize(byGrade),
    byTier: finalize(byTier),
    calibration,
    bySources: finalize(bySources),
  };
}
