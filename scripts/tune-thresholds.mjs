#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
// tune-thresholds.mjs — Offline threshold tuner (WS7)
// ════════════════════════════════════════════════════════════════════
//
// Sweeps the AI Advisor's key decision gates against the ACCUMULATED forward
// journal (exported via the app's "JSON İndir" button / exportJournalJSON) and
// reports which gate settings would have maximized net expectancy per pick.
//
//   node scripts/tune-thresholds.mjs path/to/bist_forward_journal_YYYY-MM-DD.json
//   node scripts/tune-thresholds.mjs journal.json --prices prices.json
//
// Optional --prices: { "THYAO": [closes...], ... } daily closes per symbol.
// When provided, each winning configuration is cross-checked with
// runWalkForward + walkForwardGate on the affected symbols; only 'stable'
// verdicts are marked promotable.
//
// PROMOTION IS MANUAL. This script only writes threshold-recommendations.json
// — nothing is auto-applied. With < 150 evaluated predictions the output is
// directional only (printed as a warning).
// ════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';

const ROUND_TRIP_COST_PP = 0.3; // mirrors tradingCosts.TOTAL_COST_PCT × 100
const MIN_PICKS_PER_WEEK = 3;   // avoid the degenerate "trade nothing" optimum
const DIRECTIONAL_ONLY_N = 150;

function fail(msg) { console.error('HATA: ' + msg); process.exit(1); }

const args = process.argv.slice(2);
const journalPath = args.find(a => !a.startsWith('--'));
if (!journalPath) fail('kullanim: node scripts/tune-thresholds.mjs <journal.json> [--prices prices.json]');
const pricesIdx = args.indexOf('--prices');
const pricesPath = pricesIdx >= 0 ? args[pricesIdx + 1] : null;

const journalRaw = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
const days = Array.isArray(journalRaw) ? journalRaw : journalRaw.days;
if (!Array.isArray(days)) fail('journal formati taninmadi (days[] bekleniyor)');

// Flatten evaluated predictions with their decision inputs
const preds = days.flatMap(d => (d.predictions || [])
  .filter(p => p.evaluatedAt && p.entryPrice)
  .map(p => ({
    symbol: p.symbol,
    score: p.score ?? 0,
    rrNet: p.rrNet ?? p.rr ?? 0,
    pump: p.recentPump ?? 0,
    gross: p.perf?.d5 ?? p.perf?.d3 ?? p.perf?.d1,
  }))
  .filter(p => p.gross != null));

if (!preds.length) fail('journal icinde degerlendirilmis prediction yok');

const weeks = Math.max(1, days.length / 5);
console.log(`Journal: ${days.length} gun, ${preds.length} degerlendirilmis prediction (~${weeks.toFixed(1)} hafta)`);
if (preds.length < DIRECTIONAL_ONLY_N) {
  console.warn(`UYARI: n=${preds.length} < ${DIRECTIONAL_ONLY_N} — sonuclar SADECE yon gostergesidir, promote etmeyin.`);
}

// ── Sweep ──
const scoreCuts = [50, 52.5, 55, 57.5, 60, 62.5, 65];
const rrCuts = [0.8, 1.0, 1.2, 1.4, 1.6];
const pumpScales = [0.5, 0.75, 1.0, 1.25, 1.5]; // pump penalty multiplier (pump cut = 7 / scale)

const results = [];
for (const sc of scoreCuts) {
  for (const rc of rrCuts) {
    for (const ps of pumpScales) {
      const pumpCut = 7 / ps;
      const kept = preds.filter(p => p.score >= sc && p.rrNet >= rc && p.pump < pumpCut);
      if (!kept.length) continue;
      const perWeek = kept.length / weeks;
      if (perWeek < MIN_PICKS_PER_WEEK) continue;
      const nets = kept.map(p => p.gross - ROUND_TRIP_COST_PP);
      const netExp = nets.reduce((a, v) => a + v, 0) / nets.length;
      const winRate = nets.filter(v => v > 0).length / nets.length;
      results.push({
        scoreCutoff: sc, rrNetCutoff: rc, pumpPenaltyScale: ps,
        picks: kept.length, picksPerWeek: +perWeek.toFixed(1),
        netExpectancy: +netExp.toFixed(3), winRate: +(winRate * 100).toFixed(1),
        symbols: [...new Set(kept.map(p => p.symbol))],
      });
    }
  }
}

if (!results.length) fail('hicbir konfigurasyon min-pick kisitini gecemedi');
results.sort((a, b) => b.netExpectancy - a.netExpectancy);

// Baseline = current live gates (score 55 / rrNet 1.0 / scale 1.0)
const baseline = results.find(r => r.scoreCutoff === 55 && r.rrNetCutoff === 1.0 && r.pumpPenaltyScale === 1.0)
  || { netExpectancy: 0, picks: 0, note: 'baseline kisitlari gecemedi' };

console.log('\nEn iyi 5 konfigurasyon (net beklenti %/pick):');
for (const r of results.slice(0, 5)) {
  console.log(`  score>=${r.scoreCutoff} rrNet>=${r.rrNetCutoff} pumpScale=${r.pumpPenaltyScale}`
    + ` → net %${r.netExpectancy} | WR %${r.winRate} | ${r.picks} pick (${r.picksPerWeek}/hafta)`);
}
console.log(`Baseline (mevcut): net %${baseline.netExpectancy ?? '—'} (${baseline.picks} pick)`);

// ── Optional walk-forward gate cross-check ──
let gateResults = null;
if (pricesPath) {
  const prices = JSON.parse(fs.readFileSync(pricesPath, 'utf8'));
  const { runWalkForward, walkForwardGate } = await import('../src/utils/walkForward.js');
  gateResults = [];
  for (const cand of results.slice(0, 3)) {
    let stable = 0, tested = 0;
    for (const sym of cand.symbols.slice(0, 10)) {
      const closes = prices[sym];
      if (!Array.isArray(closes) || closes.length < 120) continue;
      try {
        const wf = runWalkForward(closes.map(c => ({ close: c })), 'signal');
        const gate = walkForwardGate(wf, { allowBorderline: false });
        tested += 1;
        if (gate.pass) stable += 1;
      } catch { /* skip symbol */ }
    }
    const pass = tested > 0 && stable / tested >= 0.6;
    gateResults.push({ ...cand, wfTested: tested, wfStable: stable, promotable: pass });
    console.log(`  WF gate: score>=${cand.scoreCutoff}/rr>=${cand.rrNetCutoff} → ${stable}/${tested} stable → ${pass ? 'PROMOTABLE' : 'RED'}`);
  }
} else {
  console.log('\nNot: --prices verilmedi — walkForwardGate cross-check atlandi; oneriler "gate: skipped" olarak isaretlendi.');
}

const out = {
  generatedAt: new Date().toISOString(),
  evaluatedPredictions: preds.length,
  directionalOnly: preds.length < DIRECTIONAL_ONLY_N,
  baseline,
  top: results.slice(0, 10),
  walkForwardGate: gateResults ?? 'skipped (no --prices)',
  note: 'PROMOTION MANUEL — hicbir esik otomatik uygulanmaz.',
};
const outPath = path.join(path.dirname(journalPath), 'threshold-recommendations.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nYazildi: ${outPath}`);
