// ════════════════════════════════════════════════════════════════════
// live-ranker-replica.mjs — CANLI SECIM ZINCIRININ NODE KOPYASI (v31.53)
// ════════════════════════════════════════════════════════════════════
//
// NEDEN VAR: tarama sonucu ~24 adaydan hangilerinin gosterilecegini / paper'in
// hangisini acacagini useAIAdvisor.js icindeki bir zincir belirler (filtre →
// yarin-potansiyeli siralamasi → sektor siniri → rejim kapisi → guven skoru).
// Bu zincir React hook'unun icinde oldugu icin hic olculmedi. Burada seans-disi
// (aksam / acilis oncesi) dali Node'da yeniden kurulur ki feature-edge-study
// gercek siralayiciyi gecmis veride olcebilsin.
//
// SADAKAT:
//   - Modul duzeyindeki uc saf fonksiyon (`_deriveHTFContext`, `_scoreEntryTiming`,
//     `calcTomorrowPotential`) KAYNAKTAN DILIMLENIR — elle kopya degil, ayrisamaz.
//   - Hook icindeki kapanimlar (erken birikim, kirilim-oncesi, AL filtresi,
//     stop kirpma, guven skoru) elle tasindi; her biri kaynak satirinin
//     capasini yorumda tasir. useAIAdvisor degisirse burasi da degismeli.
//   - Tekrar uretilemeyenler NOTR: haber, KAP, iceriden alim, makro, sektor
//     gucu, pick hafizasi (basarisiz-tekrar / durgun), profit governor (delta 0),
//     temel kalite kapisi. Yani olculen sey zincirin FIYAT/HACIM kismidir.
// ════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const U = (f) => pathToFileURL(path.join(ROOT, 'src', f)).href;

const MIN_DAILY_VOLUME_TL = 2_000_000;
const MICRO_CAP_MIN_VOLUME_TL = 100_000;
/** normalizeStopTarget: BULL/RANGE varsayilani (adaptif ±0,2 ve rejim tablosu notr). */
export const LIVE_STOP_ATR_MULT = 1.8;

function sliceFn(src, name, nextName) {
  const a = src.indexOf(`function ${name}(`);
  const b = src.indexOf(`function ${nextName}(`, a + 1);
  if (a < 0 || b < 0) throw new Error(`useAIAdvisor.js icinde ${name} bulunamadi — kopya guncellenmeli`);
  return src.slice(a, b);
}

export async function makeLiveReplica() {
  const { isUnsafeForTomorrow, calcContinuationProbability } = await import(U('utils/pumpGuard.js'));
  const { netRR, TOTAL_COST_PCT } = await import(U('utils/tradingCosts.js'));
  const { computeRelativeStrength } = await import(U('utils/relativeStrength.js'));
  const { computeTopGainerPotential, topGainerConfidenceAdjust } = await import(U('utils/topGainerPotential.js'));
  const { SECTORS } = await import(U('utils/constants.js'));
  const { entryQualityOf } = await import(U('utils/candidateRank.js'));

  const src = fs.readFileSync(path.join(ROOT, 'src', 'hooks', 'useAIAdvisor.js'), 'utf8');
  const body = [
    sliceFn(src, '_deriveHTFContext', '_scoreEntryTiming'),
    sliceFn(src, '_scoreEntryTiming', 'calcTomorrowPotential'),
    sliceFn(src, 'calcTomorrowPotential', 'calcSellPotential'),
    'return { _deriveHTFContext, _scoreEntryTiming, calcTomorrowPotential };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  const live = new Function('TOTAL_COST_PCT', 'isForeignFlowScoringEnabled', body)(TOTAL_COST_PCT, () => false);

  /** useAIAdvisor "out" nesnesi (tarama satiri), aksam taramasi: canli fiyat = kapanis. */
  function buildResult(sym, ind, sig, hist, xuCloses, htf) {
    const n = hist.length;
    const lastC = hist[n - 1].close, prevC = hist[n - 2]?.close || 0;
    const todayPumpReal = prevC > 0 ? ((lastC - prevC) / prevC) * 100 : 0;
    const change = todayPumpReal;
    let recentPump = todayPumpReal;
    const rb = hist.slice(-4);
    for (let i = 1; i < rb.length; i++) {
      const pc = rb[i - 1].close;
      if (pc > 0) { const ch = ((rb[i].close - pc) / pc) * 100; if (ch > recentPump) recentPump = ch; }
    }
    // Kaynakta olusan bar yokken "dunku degisim" son barin degisimidir (bkz. PREV-DAY CHANGE).
    const prevDayChange = todayPumpReal;
    const startC = n >= 4 ? hist[n - 4].close : 0;
    const cumulativePump = startC > 0 ? ((lastC - startC) / startC) * 100 : todayPumpReal;
    const atrPct = ind.atr && ind.lastClose > 0 ? (ind.atr / ind.lastClose) * 100 : 0;
    const liq = hist.slice(-20);
    const avgVolume = liq.reduce((s, b) => s + (b.volume || 0), 0) / (liq.length || 1);
    const avgVolumeTL = avgVolume * (ind.lastClose || 0);
    const distFromMA20 = ind.lastMA20 > 0 ? ((ind.lastClose - ind.lastMA20) / ind.lastMA20) * 100 : null;

    const entry = lastC;
    const stop = sig.stop, target = sig.t1;
    const stopPct = stop && entry > 0 ? ((stop - entry) / entry) * 100 : 0;
    const targetPct = target && entry > 0 ? ((target - entry) / entry) * 100 : 0;
    const riskDist = Math.abs(entry - (stop || entry * 0.95));
    const rewardDist = Math.abs((target || entry * 1.10) - entry);
    const rr = riskDist > 0 ? rewardDist / riskDist : (sig.rr || 0);
    const rrNet = netRR(entry, stop || entry * 0.95, target || entry * 1.10);
    const timing = live._scoreEntryTiming(ind, hist);
    const rs = computeRelativeStrength(hist.map((b) => b.close), xuCloses);

    const out = {
      symbol: sym, sector: SECTORS[sym] || 'Diger', price: entry, change,
      cls: sig.cls, score: Number(sig.score) || 50, momentumScore: ind.momentumScore || 0,
      rsi: ind.lastRSI, adx: ind.adx, mfi: ind.mfi, cmf: ind.cmf, volRatio: ind.volRatio,
      obvTrend: ind.obvTrend, obvDivergence: ind.obvDivergence, rsiDivergence: ind.rsiDivergence,
      entry, stop, target,
      rr: Math.round(rr * 10) / 10, rrNet: rrNet != null ? Math.round(rrNet * 100) / 100 : null,
      stopPct: Math.round(stopPct * 10) / 10, targetPct: Math.round(targetPct * 10) / 10,
      ichimoku: ind.ichimoku ? { tkCross: ind.ichimoku.tkCross, kumoBreakout: ind.ichimoku.kumoBreakout, kumoTwist: ind.ichimoku.kumoTwist, cloudPosition: ind.ichimoku.cloudPosition } : null,
      supertrend: ind.supertrend ? { trend: ind.supertrend.trend, flip: ind.supertrend.flip, value: ind.supertrend.value } : null,
      williamsR: ind.lastWilliamsR,
      bollPct: ind.lastBU && ind.lastBL ? ((ind.lastClose - ind.lastBL) / (ind.lastBU - ind.lastBL)) * 100 : null,
      recentPump, cumulativePump, prevDayChange, todayPumpReal, atrPct,
      ttmSqueeze: ind.ttmSqueeze || null, wyckoffSpring: ind.wyckoffSpring || false,
      avgVolume, avgVolumeTL, distFromMA20,
      entryTimingScore: timing.score,
      rsScore: rs.rsScore,
      htfTrend: htf?.trend || 'neutral', htfWeeklyTrend: htf?.weeklyTrend || 'neutral',
    };
    out._topGainer = computeTopGainerPotential(out, hist);
    return out;
  }

  // useAIAdvisor › detectEarlyAccumulation (PRE-PUMP / ERKEN BIRIKIM TESPITI)
  function detectEarly(r) {
    const none = { isEarly: false, count: 0 };
    const rp = Math.max(r.todayPumpReal || 0, r.recentPump || 0);
    if (rp > 5) return none;
    if ((r.atrPct || 0) > 5) return none;
    if ((r.rsi || 50) > 68) return none;
    if ((r.mfi || 50) > 65) return none;
    let c = 0;
    if (r.obvTrend === 'accumulation') c++;
    if ((r.cmf || 0) > 0.08) c++;
    if (r.wyckoffSpring?.type === 'spring') c++;
    if (r.ttmSqueeze?.squeezeOn) c++;
    const vr = r.volRatio || 0;
    if (vr >= 1.3 && vr <= 2.5) c++;
    if (r.distFromMA20 != null && r.distFromMA20 >= -3 && r.distFromMA20 <= 4) c++;
    if (r.mfi != null && r.mfi >= 35 && r.mfi < 62) c++;
    if (r.bollPct != null && r.bollPct >= 25 && r.bollPct <= 70) c++;
    if (r.rsi != null && r.rsi >= 40 && r.rsi <= 58) c++;
    if (r.supertrend?.flip && r.supertrend?.trend === 'UP') c++;
    return { isEarly: c >= (rp <= 1 ? 3 : 4), count: c };
  }

  // useAIAdvisor › detectNearBreakout (v25: NEAR-BREAKOUT TESPITI)
  function detectNear(r) {
    const rp = Math.max(r.todayPumpReal || 0, r.recentPump || 0);
    if (rp > 4) return { isNear: false, count: 0 };
    let c = 0;
    if (r.bollPct != null && r.bollPct >= 70 && r.bollPct < 95) c++;
    if ((r.atrPct || 0) < 3) c++;
    if ((r.volRatio || 0) >= 1.5 && (r.volRatio || 0) < 3) c++;
    if (r.rsi != null && r.rsi >= 50 && r.rsi <= 70) c++;
    if (r.obvTrend === 'accumulation') c++;
    if ((r.cmf || 0) > 0.10) c++;
    if (r.supertrend?.trend === 'UP' && r.ichimoku?.cloudPosition === 'above') c++;
    if (r.mfi != null && r.mfi >= 55 && r.mfi < 78) c++;
    return { isNear: c >= 5, count: c };
  }

  /** useAIAdvisor › buyPicks filtresi, seans-disi dali. Donus: null = gecti, yoksa red sebebi. */
  function rejectReason(r, early) {
    if ((r.atrPct || 0) < 0.8) return 'atr';
    if (r.cls === 'sell') return 'sell';
    if (r.cls !== 'buy' && (r.score || 0) < 45) return 'score';
    const volTL = r.avgVolumeTL || 0;
    if (volTL < MICRO_CAP_MIN_VOLUME_TL) return 'liq';
    if (volTL < MIN_DAILY_VOLUME_TL) return early.isEarly ? null : 'liq';
    if (r.supertrend?.trend === 'DOWN' && r.ichimoku?.cloudPosition === 'below' && r.obvTrend === 'distribution') return 'bearish';
    if (r.obvTrend === 'distribution' && (r.cmf || 0) < -0.08 && (r.rsi || 50) > 50 && r.score < 60) return 'distributing';
    if (r.rsiDivergence === 'bearish' && r.obvDivergence === 'bearish') return 'divergence';
    if (r.obvTrend === 'distribution' && (r.cmf || 0) < -0.12 && (r.change || 0) > 1 && r.score < 60) return 'distTrap';
    if ((r.rsi || 50) > 70 && (r.mfi || 50) > 65 && (r.change || 0) > 0.5) return 'exhausted';
    if ((r.change || 0) > 3 && (r.volRatio || 1) < 0.6 && r.obvTrend === 'distribution' && r.score < 55) return 'weakRally';
    if (isUnsafeForTomorrow(r)) return 'pumpGuard';
    {
      const todayPump = r.todayPumpReal || r.recentPump || 0;
      const yestPump = r.prevDayChange || 0;
      if (todayPump >= 3 && yestPump >= 2 && (todayPump + yestPump) >= 6) return 'doubleDay';
    }
    if ((r.cumulativePump || 0) >= 15) return 'cumPump';
    if (r.obvTrend === 'distribution' && (r.cmf || 0) < -0.10 && r.score < 55) return 'minQuality';
    if (r.supertrend?.trend === 'DOWN' && (r.adx || 25) < 18 && r.score < 50) return 'minQuality';
    const hasSetup = r.score >= 45;
    const hasGoodRR = (r.rrNet ?? r.rr) >= 0.8;
    const hasTrend = r.ichimoku?.cloudPosition === 'above' || r.supertrend?.trend === 'UP';
    const hasSmartMoney = r.obvTrend === 'accumulation' || (r.cmf || 0) > 0.05;
    if (hasSetup && (hasGoodRR || hasTrend || hasSmartMoney)) return null;
    if (r.score >= 55) return null;
    return 'noSetup';
  }

  /** useAIAdvisor › normalizeStopTarget: AL stop'u giristen en fazla mult×ATR uzakta;
   *  stop kirpilirsa hedef de yeniden kurulur (kirpilan mesafe × max(1,5; R/R)). */
  function liveStopTarget(r, mult = LIVE_STOP_ATR_MULT) {
    const entry = r.entry || r.price || 0;
    let { stop, target } = r;
    if (entry && stop && stop < entry) {
      const maxDist = (entry * (r.atrPct || 2) / 100) * mult;
      if (entry - stop > maxDist) {
        stop = entry - maxDist;
        target = entry + maxDist * Math.max(1.5, r.rr || 1.5);
      }
    }
    return { stop, target };
  }
  const liveStop = (r, mult) => liveStopTarget(r, mult).stop;

  /** useAIAdvisor › enhancePick guven skoru (sektor / haber / makro terimleri notr). */
  function confidenceOf(r, tomorrowPotential) {
    const pump = Math.max(r.todayPumpReal || 0, r.recentPump || 0);
    const eq = entryQualityOf(r);       // uretim fonksiyonu (enhancePick de bunu cagirir)
    const volTL = r.avgVolumeTL || 0;
    const liq = volTL >= 50e6 ? 100 : volTL >= 20e6 ? 85 : volTL >= 10e6 ? 70 : volTL >= 5e6 ? 55 : volTL >= 2e6 ? 40 : 20;
    let mh = 50;
    const vr = r.volRatio || 1.0, rsi = r.rsi || 50;
    if (vr > 2.0) mh += 25; else if (vr > 1.3) mh += 15; else if (vr < 0.7) mh -= 25; else if (vr < 1.0) mh -= 10;
    if (rsi > 75) mh -= 30; else if (rsi > 68) mh -= 15; else if (rsi > 62) mh -= 8; else if (rsi < 35) mh += 15; else if (rsi >= 40 && rsi <= 55) mh += 10;
    if (r.obvTrend === 'accumulation') mh += 15; else if (r.obvTrend === 'distribution') mh -= 25;
    if ((r.cmf || 0) > 0.10) mh += 10; else if ((r.cmf || 0) < -0.08) mh -= 15;
    if (r.change > 2 && vr < 1.0) mh -= 20;
    mh = Math.max(0, Math.min(100, mh));
    const tgAdj = topGainerConfidenceAdjust({ score: r._topGainer?.score || 0 }, false);
    let conf = Math.round((r.score || 50) * 0.28 + (tomorrowPotential || 0) * 0.18 + 50 * 0.10 + 50 * 0.08
      + eq * 0.18 + liq * 0.08 + mh * 0.10 + (r.rsScore || 0) + tgAdj);
    const prob = calcContinuationProbability(r);
    if (pump >= 7 && prob !== null) conf = Math.max(5, conf - (prob < 25 ? 28 : prob < 32 ? 20 : prob < 40 ? 12 : 6));
    return { conf, eq, liq, mh, tg: r._topGainer?.score || 0, prob };
  }

  return { ...live, buildResult, detectEarly, detectNear, rejectReason, liveStop, liveStopTarget, confidenceOf };
}
