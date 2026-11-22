// ════════════════════════════════════════════════════════════════════
// forwardVerdict.js — HAREKET LISTESININ ILERI OLCUM PLANI (onceden yazildi, 23.11.2026)
// ════════════════════════════════════════════════════════════════════
//
// Kullanici (23.11.2026): "sinyal kismi uygulamanin asil amaci, onu detayli izleyelim; gercekten
// tutarliysa onun ustune yogunlasacagiz". "Tutarli" kararini sonuclari GORMEDEN tanimlamak icin
// olcutler burada, ileri veri gelmeden once yaziliyor ve degistirilmiyor.
//
// Kaynak: next-session-report.mjs'in gorulmemis veri serisi (720 seans, 1.926 islem; ilk 3, +%4
// kar-al, acilis siniri, %0,3 maliyet; islem basina +0,93, gun sd 2,77) uzerinde 5 gunluk blok
// bootstrap. Bant = "liste gecmisteki gibi davranirsa" N seans sonra islem basina ortalamanin
// %5–%95 araligi. nullP95 = gercek avantaj SIFIR olsaydi ayni oynaklikla gorulecek ortalamanin
// %95'lik ust siniri (yanlis alarm siniri).
//
//   20 seans: bant −0,17 … +1,91      (avantaj sifirken ust sinir +0,97 — ayirt edemez)
//   40 seans: bant +0,15 … +1,61      (sifir: +0,69)
//   60 seans: bant +0,29 … +1,48      (sifir: +0,56; gecmis gibiyse t>2 olasiligi %69)
//
// KARAR (60 seans, ~3 ay): ortalama >= +0,56 VE gun bazinda t > 2 → "tutarli".
// Herhangi bir kontrol noktasinda ortalama bandin %5 altinda → "gecmisle uyumsuz" (tutmuyor).
// Arada kalirsa → "belirsiz", 80–120 seansa kadar izlenir. Seans = en az bir islemin alindigi gun.
// ════════════════════════════════════════════════════════════════════

export const MOVERS_FORWARD_PLAN = Object.freeze({
  writtenAt: '2026-11-23',
  firstSession: '2026-11-23',     // modelin (2026-11-20'ye kadar egitildi) gormedigi ilk seans
  firstBasisDay: '2026-11-20',    // o seansi yargilayan listenin dayanak gunu
  modelBuiltAt: '2026-11-22',
  backtestAvgNet: 0.93,
  backtestWinPct: 70,
  finalSessions: 60,
  checkpoints: Object.freeze([
    Object.freeze({ sessions: 20, p5: -0.17, p50: 0.93, p95: 1.91, nullP95: 0.97 }),
    Object.freeze({ sessions: 40, p5: 0.15, p50: 0.92, p95: 1.61, nullP95: 0.69 }),
    Object.freeze({ sessions: 60, p5: 0.29, p50: 0.91, p95: 1.48, nullP95: 0.56 }),
  ]),
});

const isNum = Number.isFinite;

/**
 * Ileri olcumun bugunku durumu.
 * @param {{sessions:number, avgNet:number|null, dayT:number|null}} s
 * @returns {{stage:'early'|'inBand'|'belowBand'|'consistent'|'unclear'|'failing', checkpoint:object|null, next:number|null}}
 *   early      ilk kontrol noktasina (20 seans) gelinmedi
 *   inBand     kontrol noktasinda gecmisle uyumlu, karar 60 seansta
 *   belowBand  kontrol noktasinda bandin altinda — gecmisle uyumsuz
 *   consistent 60+ seans: ortalama sifir-avantaj sinirinin ustunde ve t > 2
 *   failing    60+ seans: bandin altinda
 *   unclear    60+ seans: ikisi de degil, izlemeye devam
 */
export function moversVerdict({ sessions, avgNet, dayT } = {}, plan = MOVERS_FORWARD_PLAN) {
  const n = isNum(sessions) ? sessions : 0;
  const passed = plan.checkpoints.filter((c) => n >= c.sessions);
  const cp = passed.length ? passed[passed.length - 1] : null;
  const next = plan.checkpoints.find((c) => n < c.sessions)?.sessions ?? null;
  if (!cp || !isNum(avgNet)) return { stage: 'early', checkpoint: null, next: next ?? plan.checkpoints[0].sessions };
  if (n >= plan.finalSessions) {
    if (avgNet >= cp.nullP95 && isNum(dayT) && dayT > 2) return { stage: 'consistent', checkpoint: cp, next: null };
    if (avgNet < cp.p5) return { stage: 'failing', checkpoint: cp, next: null };
    return { stage: 'unclear', checkpoint: cp, next: null };
  }
  return { stage: avgNet < cp.p5 ? 'belowBand' : 'inBand', checkpoint: cp, next };
}

const pct = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}%${Math.abs(v).toFixed(2).replace('.', ',')}`;

/** Ekranda / raporda tek cumle. */
export function verdictText(v, sessions, plan = MOVERS_FORWARD_PLAN) {
  const cp = v.checkpoint;
  switch (v.stage) {
    case 'early': return `Erken: ${sessions || 0}/${v.next} seans. İlk değerlendirme ${v.next}. seansta; karar ${plan.finalSessions} seansta.`;
    case 'inBand': return `${cp.sessions} seans geçti, geçmişle uyumlu (beklenen aralık ${pct(cp.p5)} … ${pct(cp.p95)}). Karar ${plan.finalSessions} seansta.`;
    case 'belowBand': return `Geçmişle uyumsuz: ${cp.sessions} seansta ortalama beklenen aralığın altında (alt sınır ${pct(cp.p5)}).`;
    case 'consistent': return `Tutarlı: ${sessions} seansta ortalama avantajsız bir listenin ulaşamayacağı düzeyde (${pct(cp.nullP95)} üstü) ve istatistiksel olarak sıfırdan ayrışıyor.`;
    case 'failing': return `Tutmuyor: ${sessions} seansta ortalama geçmişin beklenen aralığının altında (alt sınır ${pct(cp.p5)}).`;
    default: return `Belirsiz: ${sessions} seansta artıda ama avantajsız bir listeden henüz ayrışmadı; 80–120 seansa kadar izlenir.`;
  }
}
