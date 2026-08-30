# Arka Plan Bildirimi — Kurulum (v31.27)

Uygulama **kapalıyken** hedef/stop bildirimi almak için. Tamamı ücretsiz katmanlarla çalışır.

## Neden sunucu gerekiyor

Mobil WebView, uygulama arka plana atıldığı an JavaScript'i dondurur — bu bir işletim
sistemi sınırıdır, uygulama içinden aşılamaz. Bu yüzden "kapalıyken haber ver" ancak
işletim sisteminin service worker'a teslim ettiği bir **push** ile çözülebilir.

**Gizlilik:** takip edilen sinyaller **repoya yazılmaz**, senin kendi Upstash deponda
durur. Gerçek portföy verisi bu akışa hiç girmez.

---

## 1. Upstash Redis (depolama)

Vercel panelinde: **Storage → Marketplace → Upstash for Redis → Create**.
Projene bağla; `UPSTASH_REDIS_REST_URL` ve `UPSTASH_REDIS_REST_TOKEN` otomatik gelir.

Ücretsiz katman bu kullanım için fazlasıyla yeterli (ayda 500K komut; bu iş günde
birkaç yüz komut kullanır).

## 2. VAPID anahtarları (push kimliği)

```bash
npx web-push generate-vapid-keys
```

Çıkan iki anahtarı sakla.

## 3. GitHub repo secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Değer |
|---|---|
| `UPSTASH_REDIS_REST_URL` | Upstash'ten |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash'ten |
| `VAPID_PUBLIC_KEY` | 2. adımdan |
| `VAPID_PRIVATE_KEY` | 2. adımdan |
| `VAPID_SUBJECT` | `mailto:senin@mail.com` |
| `PROXY_BASE_URL` | Vercel proxy adresin (opsiyonel ama önerilir) |

## 4. Vercel environment variable

Vercel projesine **`VITE_VAPID_PUBLIC_KEY`** = public key (2. adımdaki) ekle, sonra
yeniden deploy et. Bu, tarayıcının abone olabilmesi için gerekli.

## 5. Telefonda aç

1. Uygulamayı **ana ekrana ekle** (iOS'ta zorunlu — Safari sekmesinde push çalışmaz)
2. Ana ekrandaki ikondan aç
3. Ayarlar → **Arka Plan Bildirimi → BİLDİRİMİ AÇ**

## 6. Doğrula

GitHub → Actions → **Signal Tracker** → *Run workflow* → `dry_run: true`.
Log'da kaç cihaz ve kaç fiyat okunduğu, hangi uyarıların atılacağı görünür —
bildirim göndermeden.

---

## Bilinen sınırlar (dürüst)

- **GitHub cron gecikebilir.** Yoğunlukta zamanlanmış işler birkaç dakika kayar.
  Hedef/stop bildirimi için kabul edilebilir; saniye hassasiyeti için değil.
- **Fiyat 15-30 dk gecikmeli** (ücretsiz kaynak). Bildirim de o kadar gecikir.
- **iOS'ta push, ana ekrana eklenmiş PWA gerektirir** ve Apple teslimatta
  Android'e göre daha kısıtlayıcıdır.
- Takip listesi, uygulamayı her açıp bildirimi açtığında güncellenir. Yeni
  sinyaller bir sonraki senkronda takibe girer.
