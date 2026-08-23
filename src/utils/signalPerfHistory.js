// ── DAY-BY-DAY SIGNAL PERFORMANCE HISTORY (v31.14) — pure, testable ────────
// The signal tracker captured fixed d1/d3/d5/d7 checkpoints + an instant return,
// but not a per-day series. The user wants "hisseleri gün gün arttı azaldı" — a
// day-by-day record of each recommended stock's gain/loss — saved into Sinyal
// Takibi. This appends ONE point per calendar day (entry-relative, direction-
// adjusted return), updating today's point on each intraday tick.

/**
 * Append/update a daily performance point (idempotent within a calendar day).
 * @param {Array<{d:string,pct:number}>} existing - prior daily series
 * @param {string} dayKey - 'YYYY-MM-DD' for the current point
 * @param {number} pct - direction-adjusted entry-relative return (%)
 * @param {number} [maxDays=30] - cap the series length
 * @returns {Array<{d:string,pct:number}>} new array (never mutates input)
 */
export function appendDailyPerf(existing, dayKey, pct, maxDays = 30) {
  const arr = Array.isArray(existing) ? existing.filter(p => p && typeof p.d === 'string') : [];
  if (pct == null || !Number.isFinite(pct) || !dayKey) return arr;
  const point = { d: dayKey, pct: Math.round(pct * 100) / 100 };
  // v31.22: de-dupe against ANY existing day, not just the last element — an
  // out-of-order series used to accumulate duplicates of the same day.
  const idx = arr.findIndex(p => p.d === dayKey);
  if (idx >= 0) return arr.map((p, i) => (i === idx ? point : p));
  return [...arr, point].slice(-maxDays); // new day → append (capped)
}

/**
 * Summarize a daily series for compact UI: best/worst day, up/down day counts,
 * latest return, and net day-over-day deltas.
 * @param {Array<{d:string,pct:number}>} dailyPerf
 */
export function summarizeDailyPerf(dailyPerf) {
  const arr = Array.isArray(dailyPerf) ? dailyPerf.filter(p => p && Number.isFinite(p.pct)) : [];
  if (!arr.length) return { days: 0, latest: null, best: null, worst: null, upDays: 0, downDays: 0 };
  let best = arr[0], worst = arr[0], upDays = 0, downDays = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].pct > best.pct) best = arr[i];
    if (arr[i].pct < worst.pct) worst = arr[i];
    // Day-over-day direction (first day compares to 0 = entry).
    const prev = i === 0 ? 0 : arr[i - 1].pct;
    const delta = arr[i].pct - prev;
    if (delta > 0) upDays++;
    else if (delta < 0) downDays++;
  }
  return { days: arr.length, latest: arr[arr.length - 1].pct, best, worst, upDays, downDays };
}

// ── BACKFILL FROM HISTORICAL BARS (v31.21) ────────────────────────────────
// appendDailyPerf only captures a point while the app is OPEN. A signal recorded
// 3 days ago therefore had an empty history — but the user wants to see each day's
// change for it. Daily closes are already available from the price engine, so the
// series can be reconstructed exactly: for every trading day at/after the entry,
// the direction-adjusted return of that day's CLOSE vs the entry price.

// v31.22: was toISOString() (UTC). Bar dates map to the same calendar day under
// both readings, so this is a no-op for bars — but it fixes the startKey of a
// signal recorded between 00:00-03:00 TRT, which previously admitted the
// PREVIOUS trading day's close as a fabricated entry-day point.
const dayKeyOf = (d) => istanbulDayKey(d) || null;

/**
 * Rebuild the day-by-day series for a signal from its symbol's daily bars.
 * @param {object} signal - { entryPrice|price, timestamp, cls }
 * @param {Array<{date:any, close:number}>} bars - daily bars, oldest → newest
 * @param {number} [maxDays=30]
 * @returns {Array<{d:string,pct:number}>}
 */
export function backfillDailyPerf(signal, bars, maxDays = 30) {
  const entry = signal?.entryPrice ?? signal?.price;
  if (!entry || !(entry > 0) || !Array.isArray(bars) || !bars.length) return [];
  const startKey = dayKeyOf(signal?.timestamp);
  if (!startKey) return [];
  const dir = signal?.cls === 'sell' ? -1 : 1;
  const out = [];
  for (const b of bars) {
    const k = dayKeyOf(b?.date);
    if (!k || k < startKey) continue;                       // before the signal
    const close = b?.close;
    if (!Number.isFinite(close) || close <= 0) continue;
    out.push({ d: k, pct: Math.round(((close - entry) / entry) * 100 * dir * 100) / 100 });
  }
  return out.slice(-maxDays);
}

/**
 * Merge a backfilled series with the live-captured one.
 * Backfill supplies missing past days (using official closes); any day already
 * captured live is kept ONLY for the most recent day (today's intraday value),
 * because a completed day's close is the more accurate record.
 */
export function mergeDailyPerf(existing, backfilled, maxDays = 30) {
  const cur = Array.isArray(existing) ? existing.filter(p => p && typeof p.d === 'string') : [];
  const back = Array.isArray(backfilled) ? backfilled.filter(p => p && typeof p.d === 'string') : [];
  if (!back.length) return cur.slice(-maxDays);
  const byDay = new Map();
  for (const p of back) byDay.set(p.d, p);                  // closes first
  const latestLive = cur.length ? cur[cur.length - 1] : null;
  for (const p of cur) if (!byDay.has(p.d)) byDay.set(p.d, p); // keep live-only days
  if (latestLive) {
    const latestBackKey = back[back.length - 1].d;
    if (latestLive.d >= latestBackKey) byDay.set(latestLive.d, latestLive); // today = live
  }
  return [...byDay.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0)).slice(-maxDays);
}

// ══ v31.22 — ISTANBUL DAY KEY, PATH QUALITY, SETTLEMENT ════════════════════
// Three problems this block closes:
//  1) The day key came from toISOString() (UTC). Istanbul is UTC+3, so the key
//     rolled over at 03:00 TRT — a point captured between 00:00 and 03:00 was
//     filed under the PREVIOUS day. BIST-hours captures were already correct,
//     so the migration is cheap (see normalizeDailyPerf).
//  2) appendDailyPerf only de-duped against the LAST element, so an out-of-order
//     series could accumulate duplicates of the same day.
//  3) A day's record was only ever captured while the app was OPEN. The daily
//     CLOSE is authoritative and retrievable later, so the live 10-min point is
//     treated as a provisional "today" marker and the settled record always
//     comes from closes (see lastSettledTradingDay / selectBackfillTargets).

/** 'YYYY-MM-DD' in Europe/Istanbul (no DST in TR since 2016). */
export function istanbulDayKey(d = Date.now()) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(dt);
  } catch {
    return new Date(dt.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  }
}

/**
 * Heal a stored series at READ time: drop invalid points, de-dupe by day key
 * (last wins), sort ascending, round, cap. Never rewrites values, so a bad
 * migration cannot corrupt data — genuinely mis-keyed points are repaired for
 * free by the backfill sweep, where official closes win for completed days.
 */
export function normalizeDailyPerf(series, maxDays = 30) {
  if (!Array.isArray(series)) return [];
  const byDay = new Map();
  for (const p of series) {
    if (!p || typeof p.d !== 'string' || !p.d || !Number.isFinite(p.pct)) continue;
    byDay.set(p.d, { d: p.d, pct: Math.round(p.pct * 100) / 100 });
  }
  return [...byDay.values()]
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
    .slice(-maxDays);
}

/**
 * The most recent Istanbul weekday whose daily close is final.
 * BIST holidays are not modelled (no holiday calendar in the repo) — a holiday
 * simply yields no bar, which the sweep's try-cap absorbs.
 */
export function lastSettledTradingDay(now = Date.now(), settleHourTRT = 18.5) {
  const t = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(t)) return '';
  const trt = new Date(t + 3 * 3600 * 1000);              // shift into TRT wall-clock
  const hour = trt.getUTCHours() + trt.getUTCMinutes() / 60;
  let cursor = trt;
  if (hour < settleHourTRT) cursor = new Date(cursor.getTime() - 86400000);
  // walk back to the nearest weekday (0 = Sun, 6 = Sat in the shifted frame)
  for (let i = 0; i < 7; i++) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) break;
    cursor = new Date(cursor.getTime() - 86400000);
  }
  return cursor.toISOString().slice(0, 10);
}

// ── PATH QUALITY ──────────────────────────────────────────────────────────
// A signal that ended +3% after sinking to -12% is NOT the same trade as one
// that walked steadily to +3%. These describe the SHAPE of the entry-relative
// curve so reliability can reward the second over the first.

const pctsOf = (s) => (Array.isArray(s) ? s.filter(p => p && Number.isFinite(p.pct)).map(p => p.pct) : []);

/** Worst peak-to-trough decline in percentage points, always >= 0. Peak starts at 0 (= entry). */
export function maxDrawdownPct(dailyPerf) {
  const a = pctsOf(dailyPerf);
  if (a.length < 2) return 0;
  let peak = 0, dd = 0;
  for (const v of a) {
    if (v > peak) peak = v;
    const drop = peak - v;
    if (drop > dd) dd = drop;
  }
  return Math.round(dd * 100) / 100;
}

/** Highest level reached, floored at 0 (entry). */
export function maxRunupPct(dailyPerf) {
  const a = pctsOf(dailyPerf);
  if (!a.length) return 0;
  return Math.round(Math.max(0, ...a) * 100) / 100;
}

/**
 * Share of day-over-day moves that were up, in [0,1]. Flat days are excluded
 * from BOTH sides. null when fewer than 3 directional days exist (callers treat
 * null as 0.5 = neutral) — a thin series must not vote.
 */
export function consistencyRatio(dailyPerf) {
  const a = pctsOf(dailyPerf);
  if (a.length < 2) return null;
  let up = 0, dir = 0;
  for (let i = 0; i < a.length; i++) {
    const prev = i === 0 ? 0 : a[i - 1];
    const delta = a[i] - prev;
    if (delta > 0) { up++; dir++; }
    else if (delta < 0) dir++;
  }
  if (dir < 3) return null;
  return up / dir;
}

/** One-shot descriptor of a single signal's path. */
export function pathQuality(dailyPerf) {
  const arr = Array.isArray(dailyPerf) ? dailyPerf.filter(p => p && Number.isFinite(p.pct)) : [];
  if (!arr.length) {
    return { days: 0, latest: null, peak: null, trough: null, troughIdx: -1,
             maxDD: 0, runup: 0, consistency: null, endedPositive: false, postTroughGain: 0 };
  }
  const a = arr.map(p => p.pct);
  const latest = a[a.length - 1];
  let trough = a[0], troughIdx = 0;
  for (let i = 1; i < a.length; i++) if (a[i] < trough) { trough = a[i]; troughIdx = i; }
  return {
    days: a.length,
    latest,
    peak: Math.max(...a),
    trough,
    troughIdx,
    maxDD: maxDrawdownPct(arr),
    runup: maxRunupPct(arr),
    consistency: consistencyRatio(arr),
    endedPositive: latest > 0,
    postTroughGain: Math.round((latest - trough) * 100) / 100,
  };
}

export const MIN_PATH_DAYS = 5;

/**
 * Bounded path score in [-1, +1]; null below MIN_PATH_DAYS so thin series never
 * vote. tanh-shaped like signalCalibration's expectancy term. By construction a
 * steady climb outscores a crash-then-recover with the SAME endpoint.
 */
export function scoreSignalPath(dailyPerf) {
  const q = pathQuality(dailyPerf);
  if (q.days < MIN_PATH_DAYS) return null;
  const raw =
    0.50 * Math.tanh(q.latest / 7) +
    0.30 * (((q.consistency == null ? 0.5 : q.consistency) - 0.5) * 2) +
    0.20 * (-Math.tanh(q.maxDD / 7));
  return Math.max(-1, Math.min(1, Math.round(raw * 1000) / 1000));
}

/**
 * Portfolio-level roll-up over signals with enough of a series to judge.
 * `stopQuality` answers "how often did a stop-out later recover above entry?"
 * — only measurable because tracking now continues AFTER close.
 */
export function aggregatePathQuality(signals) {
  const list = Array.isArray(signals) ? signals : [];
  const scores = [], dds = [], runups = [], cons = [];
  let stopped = 0, recovered = 0;
  for (const s of list) {
    const q = pathQuality(s?.dailyPerf);
    if (q.days >= MIN_PATH_DAYS) {
      const sc = scoreSignalPath(s?.dailyPerf);
      if (sc != null) scores.push(sc);
      dds.push(q.maxDD);
      runups.push(q.runup);
      if (q.consistency != null) cons.push(q.consistency);
    }
    if (s?.outcome === 'STOP_HIT' && q.days >= 2) {
      stopped++;
      if (q.latest > 0) recovered++;
    }
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return {
    n: scores.length,
    avgPathScore: scores.length ? Math.round(mean(scores) * 1000) / 1000 : null,
    avgMaxDD: Math.round(mean(dds) * 100) / 100,
    avgRunup: Math.round(mean(runups) * 100) / 100,
    avgConsistency: cons.length ? Math.round(mean(cons) * 1000) / 1000 : null,
    stopQuality: { stopped, recovered, ratio: stopped ? recovered / stopped : null },
  };
}

/**
 * Derive d1/d3/d5/d7 from the reconstructed series. series[0] is the entry day,
 * so the Nth TRADING day is series[N].
 *
 * NOTE — semantic change: the live latches age by CALENDAR days, these by
 * trading days. Trading days are the correct reading of "5-day performance"
 * (a Friday signal's calendar-d3 lands on a Monday), but it IS a change, so
 * these are written to a shadow field first and only read in a later phase.
 */
export function derivePerfCheckpoints(dailyPerf) {
  const a = Array.isArray(dailyPerf) ? dailyPerf.filter(p => p && Number.isFinite(p.pct)) : [];
  const at = (n) => (a.length > n ? a[n].pct : null);
  return { d1: at(1), d3: at(3), d5: at(5), d7: at(7) };
}

/**
 * Pick which signals need a close-based fill, and which SYMBOLS to fetch.
 * The window is "30 days from entry", NOT status — so a signal stopped out on
 * day 3 still records days 4-30, which is what makes stopQuality measurable.
 * Symbols are de-duped: one fetch serves every signal on that symbol.
 */
export function selectBackfillTargets(signals, now = Date.now(), opts = {}) {
  const { limit = 8, maxTries = 3, trackDays = 30 } = opts;
  const settled = lastSettledTradingDay(now);
  const eligible = (Array.isArray(signals) ? signals : []).filter(s => {
    if (!s || !s.symbol) return false;
    const entry = s.entryPrice ?? s.price;
    if (!(entry > 0)) return false;
    const t = new Date(s.timestamp).getTime();
    if (!Number.isFinite(t)) return false;
    if ((now - t) / 86400000 > trackDays) return false;
    if ((s.dailyPerfTries || 0) >= maxTries) return false;
    return (s.dailyPerfSettledThrough || '') < settled;
  });

  eligible.sort((a, b) => {
    const rank = (s) => (s.status === 'active' ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const sa = a.dailyPerfSettledThrough || '';
    const sb = b.dailyPerfSettledThrough || '';
    if (sa !== sb) return sa < sb ? -1 : 1;
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });

  const symbols = [];
  const targets = [];
  for (const s of eligible) {
    if (!symbols.includes(s.symbol)) {
      if (symbols.length >= limit) continue;   // cap counts SYMBOLS, not signals
      symbols.push(s.symbol);
    }
    targets.push(s);
  }
  return { targets, symbols };
}
