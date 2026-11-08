// ── TARAMA EKRAN KAPANINCA GITMESIN (v31.48) — saf yardimcilar, testli ─────────
//
// Kullanici: "hisseler taranirken ekran kapaninca gitmesin". Olculen mekanizma:
//   1. Telefon ekrani kilitlenince WebView JS'i dondurur. O an agda olan semboller
//      donuste zaman asimina duser ve "basarisiz" sayilir; bu ani basarisizlik
//      sicramasi adaptif hiz kontrolunce KISITLAMA diye okunur ve tarama 4 paralele
//      kadar yavaslar.
//   2. Ana dongunun sure butcesi duvar saatiyle olculuyordu: ekran 8-20 dk kapali
//      kalinca donuste dongu "butce doldu" deyip kalan sembolleri taramadan biter
//      ve eksik sonuc yayinlanir.
//   3. Telefon arka plandaki PWA'yi tamamen kapatirsa tarama iz birakmadan kaybolur.
//
// Cozum uc katman:
//   - Wake Lock: tarama surerken ekran kendiliginden kapanmaz (destekleyen
//     tarayicilarda; iOS 16.4+ / Android Chrome).
//   - Gorunurluk saati: gizli gecen sure butceden duser, gizliyken yeni grup
//     baslatilmaz, gizlenme sirasinda dusen semboller yeniden kuyruga girer.
//   - Yarim kalan tarama isareti: tarama bitmeden sayfa olurse acilista yeniden
//     baslatilir.

export const SCAN_MARKER_KEY = 'bist_scan_in_progress';
export const RESUME_MAX_AGE_MS = 45 * 60 * 1000;

/**
 * Gizli gecen sureyi sayan saat. epoch her gizlenmede artar — bir grup boyunca
 * degistiyse o grubun basarisizliklari ag/kaynak hatasi degil, donma kaynaklidir.
 */
export function createVisibilityClock(doc = (typeof document !== 'undefined' ? document : null), now = () => Date.now()) {
  const hiddenNow = () => !!doc && doc.visibilityState === 'hidden';
  let pausedMs = 0;
  let hiddenSince = hiddenNow() ? now() : null;
  let epoch = 0;
  let waiters = [];
  const onChange = () => {
    if (hiddenNow()) {
      if (hiddenSince == null) { hiddenSince = now(); epoch += 1; }
    } else {
      if (hiddenSince != null) { pausedMs += now() - hiddenSince; hiddenSince = null; }
      const w = waiters; waiters = [];
      for (const resolve of w) resolve(true);
    }
  };
  doc?.addEventListener?.('visibilitychange', onChange);
  const paused = () => pausedMs + (hiddenSince != null ? now() - hiddenSince : 0);
  return {
    get epoch() { return epoch; },
    isHidden: hiddenNow,
    pausedMs: paused,
    /** Baslangictan bu yana GORUNUR gecen sure (ms). */
    activeElapsed: (start) => Math.max(0, now() - start - paused()),
    /** Gorunur ise hemen false, degilse gorunur olunca true ile coz. */
    waitVisible: () => (hiddenNow() ? new Promise(resolve => { waiters.push(resolve); }) : Promise.resolve(false)),
    dispose: () => { doc?.removeEventListener?.('visibilitychange', onChange); const w = waiters; waiters = []; for (const r of w) r(false); },
  };
}

/**
 * Ekran uyanik kilidi. Sayfa gizlenince isletim sistemi kilidi birakir; gorunur
 * olunca yeniden alinir. status: 'unsupported' | 'off' | 'active' | 'paused' | 'denied'
 */
export function createScanWakeLock(
  nav = (typeof navigator !== 'undefined' ? navigator : null),
  doc = (typeof document !== 'undefined' ? document : null),
) {
  const supported = !!(nav && nav.wakeLock && typeof nav.wakeLock.request === 'function');
  let sentinel = null;
  let wanted = false;
  let status = supported ? 'off' : 'unsupported';
  const acquire = async () => {
    if (!supported || !wanted || sentinel || (doc && doc.visibilityState !== 'visible')) return;
    try {
      sentinel = await nav.wakeLock.request('screen');
      status = 'active';
      sentinel.addEventListener?.('release', () => {
        sentinel = null;
        if (wanted) status = 'paused';
      });
    } catch {
      status = 'denied';
    }
  };
  const onVisible = () => { if (!doc || doc.visibilityState === 'visible') acquire(); };
  return {
    get status() { return status; },
    get supported() { return supported; },
    async start() {
      wanted = true;
      doc?.addEventListener?.('visibilitychange', onVisible);
      await acquire();
      return status;
    },
    async stop() {
      wanted = false;
      doc?.removeEventListener?.('visibilitychange', onVisible);
      const s = sentinel;
      sentinel = null;
      try { await s?.release?.(); } catch { /* zaten birakildi */ }
      if (supported) status = 'off';
    },
  };
}

function store(storage) {
  if (storage) return storage;
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/** Tarama basladi / ilerledi isareti. */
export function markScanRunning(info = {}, storage, now = Date.now()) {
  const st = store(storage);
  if (!st) return;
  try {
    const prev = JSON.parse(st.getItem(SCAN_MARKER_KEY) || 'null');
    const startedAt = info.startedAt ?? prev?.startedAt ?? now;
    st.setItem(SCAN_MARKER_KEY, JSON.stringify({ ...prev, ...info, startedAt, updatedAt: now }));
  } catch { /* kota / bozuk kayit */ }
}

/** Tarama normal bitti (basarili ya da hatayla) — isareti kaldir. */
export function clearScanRunning(storage) {
  const st = store(storage);
  try { st?.removeItem(SCAN_MARKER_KEY); } catch { /* yok say */ }
}

/**
 * Bir onceki oturumda yarim kalmis tarama var mi? Cok eskiyse (veri artik baska
 * bir ana ait) yok sayilir ve temizlenir.
 */
export function readUnfinishedScan(storage, now = Date.now()) {
  const st = store(storage);
  if (!st) return null;
  try {
    const m = JSON.parse(st.getItem(SCAN_MARKER_KEY) || 'null');
    if (!m || !Number.isFinite(m.updatedAt)) return null;
    if (now - m.updatedAt > RESUME_MAX_AGE_MS) { st.removeItem(SCAN_MARKER_KEY); return null; }
    return m;
  } catch { return null; }
}
