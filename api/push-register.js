// ── PUSH KAYIT ENDPOINT'I (v31.27) ────────────────────────────────────────
//
// Uygulama, push aboneligini + takip edilecek sinyalleri buraya POST eder.
// Zamanlanmis is (.github/workflows/signal-tracker.yml) bu kaydi okuyup
// fiyatlari kontrol eder ve gerekirse bildirim gonderir.
//
// GIZLILIK — bilincli tasarim: bu veri REPOYA YAZILMAZ. Kullanicinin kendi
// Upstash Redis deposuna gider (Vercel Marketplace, ucretsiz katman). Boylece
// islem sinyalleri git gecmisine girmez ve depo kullanicinin kontrolunde kalir.
// Gercek portfoy verisi bu akisa HIC dahil edilmez.

const KEY_PREFIX = 'bist:track:';
const TTL_SECONDS = 60 * 60 * 24 * 45;   // 45 gun — takip penceresinden uzun

function redisEnv() {
  // Upstash, Vercel entegrasyonunda bu isimleri enjekte eder; KV_* eski
  // Vercel KV kurulumlarindan kalan takma adlar.
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return { url, token };
}

async function redisSet(key, value) {
  const { url, token } = redisEnv();
  if (!url || !token) throw new Error('REDIS_NOT_CONFIGURED');
  const res = await fetch(`${url}/set/${encodeURIComponent(key)}?EX=${TTL_SECONDS}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  return res.json();
}

async function redisSAdd(key, member) {
  const { url, token } = redisEnv();
  const res = await fetch(`${url}/sadd/${encodeURIComponent(key)}/${encodeURIComponent(member)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`redis sadd ${res.status}`);
  return res.json();
}

/** Abonelik endpoint'inden kararli, kisa bir kimlik uret. */
function deviceIdFrom(endpoint) {
  let h = 0;
  const s = String(endpoint || '');
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return 'd' + Math.abs(h).toString(36);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST bekleniyor' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Gecersiz JSON' }); }
  }
  const sub = body?.subscription;
  const signals = Array.isArray(body?.signals) ? body.signals : [];
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return res.status(400).json({ error: 'Gecersiz push aboneligi' });
  }
  if (signals.length > 100) {
    return res.status(400).json({ error: 'Cok fazla sinyal (max 100)' });
  }

  const id = deviceIdFrom(sub.endpoint);
  try {
    await redisSet(KEY_PREFIX + id, {
      subscription: sub,
      signals,
      updatedAt: body?.updatedAt || new Date().toISOString(),
    });
    await redisSAdd('bist:track:devices', id);
    return res.status(200).json({ ok: true, deviceId: id, tracked: signals.length });
  } catch (err) {
    if (err.message === 'REDIS_NOT_CONFIGURED') {
      // Sessizce basarisiz olmak yerine ne yapilmasi gerektigini soyle.
      return res.status(503).json({
        error: 'Depolama yapilandirilmamis',
        hint: 'Vercel → Storage → Upstash Redis ekle. UPSTASH_REDIS_REST_URL ve UPSTASH_REDIS_REST_TOKEN otomatik gelir.',
      });
    }
    return res.status(500).json({ error: 'Kayit basarisiz: ' + err.message });
  }
}
