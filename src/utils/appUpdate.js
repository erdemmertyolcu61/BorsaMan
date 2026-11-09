// appUpdate.js — PWA güncellemesinin taramayla yarışı (v31.52)
//
// Kullanıcı: "mobilde direkt güncellemesi lazımdı, güncellenmedi" (v31.51 push'undan
// sonra, 18:32). Ölçülen mekanizma: uygulama açılır açılmaz otomatik tarama
// başlıyor (akşam gün-sonu kapanış taraması, gündüz "bugün taranmadı" taraması,
// yarım kalan taramanın devamı). Service worker yeni sürümü birkaç saniye SONRA
// buluyor; v31.48'deki kural "tarama sürerken yenileme" yapmadığı için sayfa
// taramanın sonuna (10–20 dk, arka planda donunca daha uzun) kadar eski sürümde
// kalıyordu. Ayrıca öne gelişte kontrol en fazla 10 dakikada bir yapılıyordu.
//
// Şimdi: (1) otomatik taramalar açılıştaki güncelleme kontrolünü bekler (kapı),
// (2) güncelleme bekleniyorsa otomatik tarama başlamaz, (3) tarama sürerken gelen
// güncelleme görünür bir şeritle duyurulur ("Şimdi yenile"), (4) her dağıtımın
// yayımladığı /version.json ile çalışan paket karşılaştırılır — service worker
// takılırsa şerit önbelleği temizleyip yeniden yükler.

export const UPDATE_EVENT = 'bist-update-ready';
export const UPDATE_GATE_TIMEOUT_MS = 10000;

let _done = false;
let _resolve = null;
const _gate = new Promise((r) => { _resolve = r; });

/** Açılıştaki güncelleme kontrolü bitti (ya da yapılamaz) — otomatik taramalar başlayabilir. */
export function markUpdateCheckDone() {
  if (_done) return;
  _done = true;
  _resolve();
}

// Service worker'ı olmayan ortam (test, eski tarayıcı) kapıyı hiç kapatmaz.
if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) markUpdateCheckDone();

/** Otomatik tarama tetikleyicileri bunu bekler; en fazla `timeoutMs`. */
export function waitForUpdateCheck(timeoutMs = UPDATE_GATE_TIMEOUT_MS) {
  if (_done) return Promise.resolve();
  return Promise.race([_gate, new Promise((r) => setTimeout(r, timeoutMs))]);
}

/** Yeni sürüm kuruluyor ya da sayfa yenilenmek üzere — yeni otomatik tarama başlatma. */
export function isUpdatePending() {
  return typeof window !== 'undefined' && !!window.__bistUpdatePending;
}

export function setUpdatePending(on = true) {
  if (typeof window !== 'undefined') window.__bistUpdatePending = !!on;
}

/**
 * Şeridi göster. mode:
 *   'scan'  — yeni sürüm hazır, tarama bitince kendiliğinden yenilenecek
 *   'stuck' — sunucuda daha yeni paket var ama service worker almadı → zorla yenile
 */
export function announceUpdate(mode, info = null) {
  if (typeof window === 'undefined') return;
  const prev = window.__bistUpdateState;
  if (prev && prev.mode === mode) return;
  window.__bistUpdateState = { mode, info, at: Date.now() };
  try { window.dispatchEvent(new CustomEvent(UPDATE_EVENT, { detail: window.__bistUpdateState })); } catch { /* yok */ }
}

/** Sunucudaki paket çalışandan farklı mı? Yerel geliştirme ('dev') hiç "eski" sayılmaz. */
export function isNewerBuild(remote, local) {
  const r = remote?.sha;
  const l = local?.sha;
  if (!r || !l || l === 'dev' || r === 'dev') return false;
  return r !== l;
}

/** Service worker'ı ve tüm önbellekleri silip yeniden yükle — son çare. */
export async function hardRefresh() {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  } catch { /* yok */ }
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch { /* yok */ }
  window.location.reload();
}
