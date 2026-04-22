// RiskManager.js — Portfolio correlation matrix + heat gauge. Zero deps.

const MIN_WINDOW = 20;
const MAX_WINDOW = 60;
const CORR_ALERT = 0.7;
const CORR_PAIR_LIMIT = 2; // alert if > 2 highly-correlated assets open

function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1], b = closes[i];
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

function mean(xs) { let s = 0; for (const x of xs) s += x; return xs.length ? s / xs.length : 0; }
function stdev(xs, m = mean(xs)) {
  if (xs.length < 2) return 0;
  let s = 0;
  for (const x of xs) { const d = x - m; s += d * d; }
  return Math.sqrt(s / (xs.length - 1));
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return 0;
  const xa = a.slice(-n), xb = b.slice(-n);
  const ma = mean(xa), mb = mean(xb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const va = xa[i] - ma, vb = xb[i] - mb;
    num += va * vb; da += va * va; db += vb * vb;
  }
  const den = Math.sqrt(da * db);
  return den ? num / den : 0;
}

// ── Correlation matrix ──────────────────────────────────────────────
// positions: [{ symbol, sector?, ... }]
// pricesBySymbol: { SYMBOL: [closes...] }
export function correlationMatrix(positions, pricesBySymbol, window = MAX_WINDOW) {
  const symbols = [...new Set((positions || []).map(p => p.symbol).filter(Boolean))];
  const returns = {};
  for (const s of symbols) {
    const closes = pricesBySymbol?.[s];
    if (!closes || closes.length < MIN_WINDOW) continue;
    const slice = closes.slice(-Math.min(window, closes.length));
    returns[s] = logReturns(slice);
  }
  const matrix = {};
  for (const a of symbols) {
    matrix[a] = {};
    for (const b of symbols) {
      if (a === b) matrix[a][b] = 1;
      else if (returns[a] && returns[b]) matrix[a][b] = Number(pearson(returns[a], returns[b]).toFixed(3));
      else matrix[a][b] = null;
    }
  }
  return { symbols, matrix, window };
}

// ── Highly-correlated pair detection + sector concentration ─────────
export function correlationAlerts(positions, corrResult, threshold = CORR_ALERT) {
  const alerts = [];
  if (!corrResult?.symbols?.length) return alerts;
  const { symbols, matrix } = corrResult;

  const pairs = [];
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const c = matrix[symbols[i]]?.[symbols[j]];
      if (c != null && c >= threshold) pairs.push({ a: symbols[i], b: symbols[j], c });
    }
  }
  if (pairs.length > CORR_PAIR_LIMIT) {
    alerts.push({
      type: 'err',
      code: 'HIGH_CORRELATION_CLUSTER',
      msg: `${pairs.length} yuksek korele cift acik — tek yonlu risk (ornek: ${pairs.slice(0, 3).map(p => `${p.a}~${p.b} r=${p.c}`).join(', ')})`,
      pairs,
    });
  } else if (pairs.length > 0) {
    alerts.push({
      type: 'warn',
      code: 'CORRELATED_PAIR',
      msg: `Korele cift: ${pairs.map(p => `${p.a}~${p.b} r=${p.c}`).join(', ')}`,
      pairs,
    });
  }

  // Sector concentration
  const bySector = {};
  for (const p of positions || []) {
    const sec = p.sector || p.sectorName || 'Bilinmeyen';
    bySector[sec] = (bySector[sec] || 0) + 1;
  }
  for (const [sec, cnt] of Object.entries(bySector)) {
    if (cnt >= 3) alerts.push({ type: 'warn', code: 'SECTOR_CONCENTRATION', msg: `${sec} sektorunde ${cnt} acik pozisyon`, sector: sec, count: cnt });
  }
  return alerts;
}

// ── Heat gauge (0–100): volatility × exposure × correlation ─────────
// vols: { SYMBOL: realizedVol_pct } — if missing, computed from pricesBySymbol
export function portfolioHeat({ positions, pricesBySymbol, corrResult, equity, vols }) {
  const pos = (positions || []).filter(p => p.status === 'open');
  if (!pos.length || !equity) return { score: 0, components: {}, verdict: 'Pozisyon yok' };

  // 1) Exposure: sum(|notional|) / equity → cap at 1
  let gross = 0;
  for (const p of pos) {
    const qty = p.shares || p.qty || p.lot || 0;
    const px = p.currentPrice || p.entryPrice || p.price || 0;
    gross += Math.abs(qty * px);
  }
  const exposure = Math.min(1.5, gross / equity); // >100% = leverage

  // 2) Weighted avg volatility (realized, if available)
  const volMap = { ...(vols || {}) };
  for (const p of pos) {
    if (volMap[p.symbol] != null) continue;
    const closes = pricesBySymbol?.[p.symbol];
    if (!closes || closes.length < MIN_WINDOW) continue;
    const rets = logReturns(closes.slice(-MAX_WINDOW));
    volMap[p.symbol] = stdev(rets) * Math.sqrt(252) * 100; // annualized %
  }
  let wVolNum = 0, wVolDen = 0;
  for (const p of pos) {
    const w = Math.abs((p.shares || 0) * (p.currentPrice || p.entryPrice || 0));
    const v = volMap[p.symbol];
    if (v != null) { wVolNum += w * v; wVolDen += w; }
  }
  const avgVol = wVolDen ? wVolNum / wVolDen : 30; // default 30% annualized
  const volScore = Math.min(1, avgVol / 60); // 60%+ annualized = full heat

  // 3) Correlation concentration (avg of upper-triangle pairs)
  let corrAvg = 0, corrCount = 0;
  if (corrResult?.symbols?.length) {
    const { symbols, matrix } = corrResult;
    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        const c = matrix[symbols[i]]?.[symbols[j]];
        if (c != null) { corrAvg += Math.abs(c); corrCount++; }
      }
    }
    corrAvg = corrCount ? corrAvg / corrCount : 0;
  }

  // 4) Drawdown pressure from open P&L
  let openRiskTL = 0;
  for (const p of pos) {
    if (p.stopLoss && p.entryPrice) {
      const qty = p.shares || 0;
      openRiskTL += Math.max(0, (p.entryPrice - p.stopLoss) * qty);
    }
  }
  const ddScore = Math.min(1, openRiskTL / (equity * 0.08)); // 8% portfolio heat = full

  // Weighted sum
  const score = Math.round(
    100 * (exposure * 0.30 + volScore * 0.30 + corrAvg * 0.20 + ddScore * 0.20)
  );

  const verdict =
    score >= 75 ? 'ASIRI SICAK — yeni pozisyon acma, mevcut ısıyı azalt'
    : score >= 55 ? 'SICAK — dikkat, korelasyon ve stop mesafelerini gozden gecir'
    : score >= 30 ? 'ILIMAN — saglikli risk seviyesi'
    : 'SOGUK — risk istahi artirilabilir';

  return {
    score: Math.max(0, Math.min(100, score)),
    verdict,
    components: {
      exposure: Number(exposure.toFixed(2)),
      avgVolPct: Number(avgVol.toFixed(1)),
      corrAvg: Number(corrAvg.toFixed(2)),
      openRiskTL: Math.round(openRiskTL),
      openRiskPct: Number((openRiskTL / equity * 100).toFixed(2)),
    },
  };
}

export default {
  correlationMatrix,
  correlationAlerts,
  portfolioHeat,
};
