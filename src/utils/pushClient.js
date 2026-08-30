// ── WEB PUSH ISTEMCISI (v31.27) ───────────────────────────────────────────
//
// Neden gerekli: mobil WebView uygulama arka plana atilinca JS'i donduruyor —
// bu bir OS siniri. "Uygulama kapaliyken hedef tuttugunda haber ver" istegi bu
// yuzden sayfa icinde COZULEMEZ; isletim sisteminin service worker'a teslim
// ettigi bir push gerekiyor.
//
// Akis:
//   1) Kullanici bildirimi acar → tarayici push aboneligi uretir
//   2) Abonelik + takip edilen sinyaller /api/push-register'a POST edilir
//   3) Zamanlanmis is (GitHub Actions) fiyatlari kontrol eder ve push gonderir
//
// GIZLILIK: sinyaller repoya DEGIL, kullanicinin kendi Upstash deposuna gider.
// Gercek portfoy verisi bu akisa hic girmez.

const VAPID_PUBLIC_KEY = import.meta.env?.VITE_VAPID_PUBLIC_KEY || '';
const REGISTER_PATH = '/api/push-register';

/** base64url → Uint8Array (PushManager'in bekledigi bicim). */
export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Bu cihaz/ortam push destekliyor mu? */
export function isPushSupported() {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

/**
 * Neden calismayacagini DURUSTCE soyler — sessizce basarisiz olmak yerine.
 * iOS'ta en sik sebep: uygulama ana ekrana eklenmemis (Safari sekmesinde push yok).
 */
export function pushBlockedReason() {
  if (typeof window === 'undefined') return 'Taryici ortami yok';
  if (!('serviceWorker' in navigator)) return 'Service worker desteklenmiyor';
  if (!('PushManager' in window)) {
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches
      || window.navigator.standalone === true;
    if (isIos && !standalone) {
      return 'iOS\'ta bildirim icin uygulamayi ANA EKRANA EKLE (Paylas → Ana Ekrana Ekle), sonra oradan ac.';
    }
    return 'Push bu tarayicida desteklenmiyor';
  }
  if (Notification.permission === 'denied') {
    return 'Bildirim izni reddedilmis — tarayici site ayarlarindan acman gerekiyor';
  }
  if (!VAPID_PUBLIC_KEY) return 'VAPID public key tanimli degil (VITE_VAPID_PUBLIC_KEY)';
  return null;
}

/** Mevcut abonelik (varsa) — UI durumu icin. */
export async function getPushSubscription() {
  if (!isPushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch { return null; }
}

/**
 * Bildirimi ac: izin iste → abone ol → sunucuya kaydet.
 * @returns {Promise<{ok:boolean, reason?:string, subscription?:object}>}
 */
export async function enablePush() {
  const blocked = pushBlockedReason();
  if (blocked) return { ok: false, reason: blocked };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'Bildirim izni verilmedi' };

  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    return { ok: true, subscription: sub.toJSON() };
  } catch (err) {
    return { ok: false, reason: err?.message || 'Abonelik basarisiz' };
  }
}

export async function disablePush() {
  try {
    const sub = await getPushSubscription();
    if (sub) await sub.unsubscribe();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err?.message };
  }
}

/**
 * Takip edilecek sinyalleri aboneligle birlikte sunucuya gonder.
 * Kasitli olarak SADECE takip icin gereken alanlar gonderilir — sinyal
 * gecmisinin tamami degil.
 */
export function toTrackedSignals(signals, max = 40) {
  return (Array.isArray(signals) ? signals : [])
    .filter(s => s && s.symbol && (s.status === 'active' || !s.status))
    .slice(0, max)
    .map(s => ({
      id: s.id,
      symbol: s.symbol,
      cls: s.cls || 'buy',
      entryPrice: s.entryPrice ?? s.price ?? null,
      target: s.target ?? null,
      stop: s.stop ?? null,
      status: 'active',
    }))
    .filter(s => Number.isFinite(s.entryPrice) && s.entryPrice > 0);
}

/** Abonelik + takip listesini sunucuya yaz. */
export async function syncTracking(subscription, signals, proxyBase = '') {
  if (!subscription) return { ok: false, reason: 'Abonelik yok' };
  const body = {
    subscription,
    signals: toTrackedSignals(signals),
    updatedAt: new Date().toISOString(),
  };
  try {
    const res = await fetch((proxyBase || '') + REGISTER_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, reason: `Sunucu ${res.status}: ${text.slice(0, 120)}` };
    }
    return { ok: true, count: body.signals.length };
  } catch (err) {
    return { ok: false, reason: err?.message || 'Ag hatasi' };
  }
}
