// ── TARAMA EVRENI (v31.40) — saf, test edilmis ─────────────────────────────
//
// OLCULEN (2026-09-13): elle yazilmis 612'lik liste bayatlamisti.
//  - 5 kodun o gun fiyati yoktu (islem gormuyor): BEKO, ISGLK, MARKA, NPTLR, QTEMZ.
//    BEKO yanlis koddu — Arcelik ARCLK olarak isleniyor ve (piyasa degeri 64,7 mlr TL)
//    HIC taranmiyordu. Bu kodlar her taramada "veri vermeyen" sayiliyordu.
//  - 16 islem goren hisse listede yoktu, cogu yeni halka arz (KARCL, SARAE, BETAE,
//    ORZAX, QUICK, ISVEA, SSAAT, MASFN, EKIM, EKDMR, METEN, ALBTN, SOHOE, GOLDA, USHOL).
//  - Is Yatirim hisse tarama listesi (603) de TEK BASINA evren olamaz: BRKO, YONGA,
//    MTRYO, EMNIS gibi 20 hisse onda yok ama guncel barlari ve fiyatlari var.
//
// Kural: evren = sabit liste ∪ Is Yatirim hisse listesi. Toplu fiyat listesi
// guvenilir geldiyse o gun fiyati OLMAYANLAR cikarilir. Yeni halka arzlar kod
// degismeden girer, islemden kalkanlar kendiliginden duser. Fiyat listesi gelmediyse,
// cok kucukse ya da evrenin makul olmayan bir kismini silecekse (kismi kesinti)
// hicbir sey dusurulmez: dogrulanamayan evren daraltilmaz.

const SYMBOL_RE = /^[A-Z][A-Z0-9]{2,5}$/;

function cleanList(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const s = String(raw ?? '').trim().toUpperCase();
    if (!SYMBOL_RE.test(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * @param {object} p
 * @param {string[]} p.staticList                 elle tutulan liste (constants.getStockList)
 * @param {Iterable<string>} [p.listedSymbols]    Is Yatirim hisse listesi
 * @param {Iterable<string>|null} [p.pricedSymbols] bugun fiyati olan kodlar (toplu fiyat listesi)
 * @param {number} [p.minPricedRatio=0.8] fiyat listesi sabit listenin bu oranindan kucukse dogrulanmaz
 * @param {number} [p.maxDropRatio=0.05]  evrenin bundan fazlasi dusecekse liste supheli sayilir
 * @returns {{symbols:string[], added:string[], dropped:string[], verified:boolean, suspicious:boolean, staticCount:number}}
 */
export function buildScanUniverse({
  staticList = [], listedSymbols = [], pricedSymbols = null, minPricedRatio = 0.8, maxDropRatio = 0.05,
} = {}) {
  const base = cleanList(staticList);
  const baseSet = new Set(base);
  const extra = cleanList([...(listedSymbols || [])]).filter(s => !baseSet.has(s)).sort();
  const all = [...base, ...extra];
  const unverified = { symbols: all, added: extra, dropped: [], verified: false, suspicious: false, staticCount: base.length };

  const priced = pricedSymbols ? new Set(cleanList([...pricedSymbols])) : null;
  if (!priced || priced.size < Math.max(1, Math.floor(base.length * minPricedRatio))) return unverified;

  const dropped = all.filter(s => !priced.has(s));
  // Bir islem gunu evrenin %5'ini birden islemden kaldirmaz → liste eksik gelmis.
  if (dropped.length > Math.ceil(all.length * maxDropRatio)) return { ...unverified, suspicious: true };

  return {
    symbols: all.filter(s => priced.has(s)),
    added: extra.filter(s => priced.has(s)),
    dropped,
    verified: true,
    suspicious: false,
    staticCount: base.length,
  };
}
