// ── CONFIDENCE GRADE / TIER (v31.20) — pure, single source of truth ───────
// The A/B/C/D thresholds were duplicated in FIVE places inside useAIAdvisor, so a
// recalibration risked drifting between them. Centralised here.
//
// RECALIBRATION (v31.20): the old 75/65/55 cut-offs were tuned against an INFLATED
// confidence scale — the sector component was ~7x its design weight (see
// normalizeSectorTilt in sectorEngine.js), pushing sector-favoured names to 89-97.
// With that bug fixed the composite lands in a realistic ~45-65 band for decent
// setups, so the old thresholds would have graded nearly everything D and emptied
// the panel (the user's "system can't find stocks" complaint, inverted).
//
// Honest note: these cut-offs are calibrated on a SMALL live sample (5 picks from a
// partial 111-symbol scan) plus the composite's design maxima — not a large-sample
// optimum. They are deliberately a little permissive; the real quality bar remains
// the regime gate's score floor. Re-tune when more scan data accumulates.
export const GRADE_THRESHOLDS = { A: 68, B: 58, C: 48 };

/** confidence (0-100) → 'A' | 'B' | 'C' | 'D' */
export function gradeFromConfidence(confidence) {
  const c = Number.isFinite(confidence) ? confidence : 0;
  if (c >= GRADE_THRESHOLDS.A) return 'A';
  if (c >= GRADE_THRESHOLDS.B) return 'B';
  if (c >= GRADE_THRESHOLDS.C) return 'C';
  return 'D';
}

/** confidence (0-100) → 'STRONG' | 'GOOD' | 'FAIR' | 'WEAK' (same cut-offs) */
export function tierFromConfidence(confidence) {
  const g = gradeFromConfidence(confidence);
  return g === 'A' ? 'STRONG' : g === 'B' ? 'GOOD' : g === 'C' ? 'FAIR' : 'WEAK';
}
