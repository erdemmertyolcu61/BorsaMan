# BIST AI Trading Terminal — Proje Beyni

Borsa İstanbul hisselerini teknik + temel + akıllı para + makro katmanlarıyla tarayan, sinyal üretip
riski yöneten, Claude destekli bir trading terminali. Tek kullanıcı: proje sahibi; telefonda **PWA**
olarak kullanıyor (ML AUTO açık), masaüstünde Electron. Veriler ücretsiz kaynaklardan, 15–30 dk gecikmeli.

**Bu dosya bir değişiklik günlüğü değil, bugünün doğrusudur.** Sürüm hikâyeleri commit mesajlarına
yazılır (`git log` tam tarihçeyi tutar). Bu dosyayı yalnız bir kural, bir değişmez ya da bir ölçülmüş
gerçek değiştiğinde güncelle; yeni bir "## vX.Y" bölümü ekleme.

## Çalışma anlaşması

- Kullanıcıyla **Türkçe** konuş. Kabuğu **PowerShell 5.1**: `&&` orada parse hatası, `curl` bir takma ad.
  Komut verirken npm script'i ya da blok başına tek komut ver.
- **Önce ölç, sonra değiştir.** Skora ya da filtreye dokunan her değişiklik gerçek veriyle ölçülür
  (olay çalışması / replay / walk-forward). Aşağıdaki "Ölçülmüş kararlar" tablosundaki eşikleri yeniden
  ölçmeden değiştirme; kullanıcı kararları da o tabloda.
- **Ölçümler taramanın evreninde yapılır** (v31.57'den beri 586 hisse, `.replay-cache`; 37 yeni halka arz 400 bardan
  kısa olduğu için dışarıda). v31.53–54 ölçümleri 257 hissedeydi; uygulama 623 hisse tarar ve sıralama tüm evrende
  yapılır — örneklem farklı sonuç verebilir (hareket listesi 257'de +0,44, 586'da +0,71).
- **Bir kural bulunduğu veride değil, görmediği veride sınanır.** Keşif kümesi 89 hisse; doğrulama
  kümesi başka 168 hisse + keşiften sonraki dönem (`feature-edge-report.mjs` üçünü ayrı basar). v31.53'te
  keşifte parlak görünen açılış-boşluğu kapısı doğrulamada tutmadı, sakinlik sıralaması son dönemde
  tutmadı — ikisi de bu yüzden seçime girmedi. Üç ölçüm tuzağı yaşandı, tekrarlama: rejimi **giriş**
  gününün kapanışıyla etiketlemek (1 gün ileri bakış), boşlukta stop'u seviyeden doldurmak, tek bir
  hisse kümesine ve tek bir çıkış kuralına bakmak (bir sıralayıcı bir çıkışla iyi, ötekiyle kötü olabilir).
- **Getiri vaat etme, kişiye özel yatırım tavsiyesi verme.** Ölçülen avantaj küçük ve döneme bağlı:
  işlem başına net beklenti 2022'de +%3 iken 2025'te +%0,2, 2026'da hafif eksi; rejim sıralaması
  (YÜKSELİŞ > YATAY > DÜŞÜŞ) sürüyor ama fark dar. Bunu dürüstçe söyle. "Her gün önerilerin çoğu yeşil
  kapatsın" isteği seçimle karşılanamıyor (taban %47, en iyi seçim %52 — aşağıda "Yeşil kapanış"); kullanıcı
  bunu yeniden isterse rakamı göster, eşik gevşetme.
- Her sürüm (vX.Y) commit + push edilir; commit mesajı neyi neden değiştirdiğini ve ölçümü anlatır.
  `.claude/worktrees/*` asla stage edilmez.
- Web'e giden değişikliği depoda değil **yayındaki pakette / canlı sitede** doğrula; bir 200 yanıtı
  verinin ekrana ulaştığını kanıtlamaz.

## Komutlar

```bash
npm run dev               # Vite (Vite proxy'leri /api/* yollarını yerelde karşılar)
npm run build             # prebuild: scripts/ensure-ml-rules.mjs — CI/Vercel'de kural dosyası yoksa build DÜŞER
npm test                  # Vitest (tek dosya: npx vitest run src/utils/__tests__/x.test.js)
npm run lint              # eslint src --max-warnings 90 — gerçek kapı
npm run build:engine      # engine-rs → wasm32 → src/engine/bistEngineWasm.js (gömülü, commit'lenir)
npm run parity:engine     # JS motoru vs Rust motoru, .replay-cache'teki tüm seriler (298) × 252 bar pencere, bit düzeyinde
npm run deploy:proxy      # proxy/ projesini yayınla + canlı doğrula (kökten çalıştır)
npm run check:proxy       # yayındaki proxy'yi doğrula; argümanla başka origin: -- https://bist-terminal-project.vercel.app
                          # çıkış 2 = sunucuya hiç ulaşılamadı (ağ: bu evin hattı *.vercel.app'i engelliyor, aşağıda) — eski proxy demek değil
npm run electron:dev      # Electron + Vite
pytest tests/             # bist_bridge.py

# Araştırma (gerçek üretim modüllerini Node'dan çalıştırır; bar önbelleği .replay-cache/)
node scripts/replay-signals.mjs          # sinyal motoru geçmiş replay (rejim × kademe)
node scripts/feature-edge-study.mjs      # aday satırları: her aday + canlı seçim zincirinin kopyası (--rebuild ~5 dk, --fetch N yeni hisse çeker)
node scripts/feature-edge-report.mjs     # aday seçimi ölçümü: rejim / filtre / sıralama / çıkış / boşluk / portföy — keşif, doğrulama, sonrası ayrı
node scripts/next-session-study.mjs      # ertesi seans satırları: evrenin tamamı × her gün (yeşil kapanış, gece/gün-içi, zirve)
node scripts/next-session-report.mjs     # ertesi seans ölçümü, ileri-yürüyüş; --fetch-hourly saatlik yol, --write-model modeli üretir
node scripts/scan-window-review.mjs --from 2026-11-09 --to 2026-11-20   # bir dönemin akşam taramalarını aynı kodla yeniden kur + ölç (AL, paper ilk 3, hareket listesi)
node scripts/fundamentals-fetch.mjs      # İş MaliTablo 20 çeyrek, tüm evren → .replay-cache/fin/
node scripts/fundamentals-study.mjs      # bilanço aday seçimine bir şey katıyor mu (noktasal, yayım gecikmeli)
node scripts/signal-event-study.mjs      # bir gösterge olayı sonraki getiri hakkında ne diyor
node scripts/kap-event-study.mjs         # KAP bildirimi × fiyat, 24 ay
node scripts/sweep-exit-params.mjs       # çıkış parametresi taraması, walk-forward zorunlu
```

**Proxy'yi asla `vercel --prod --cwd proxy` ile yayınlama**: CLI dosyaları proxy/'den yükleyip
`vercel.json`'u kökten okur ve build düşer. Proxy'ye no-op `build` script'i de ekleme.

## Mimari

| Katman | Yer |
|---|---|
| SPA | React 18 + Vite 5, `src/` (giriş `main.jsx` → `App.jsx`, durum `hooks/useAppState.js`) |
| Hesap motoru | `engine-rs/` (Rust→WASM: `calcAll` + `genSignal` çekirdeği), köprü `src/engine/engineCore.js`; JS referansı `utils/indicators.js` + `utils/signals.js` (`calcAllJs`/`genSignalJs`) yedek |
| Veri | `utils/fetchEngine.js` (her seri `sanitizePrices`'tan geçer), `utils/liveSession.js` (canlı fiyatı oturumuna göre birleştirir) |
| Tarama / öneri | `hooks/useAIAdvisor.js` (623 hisse), kapılar `utils/regimeGate.js`, `utils/pumpGuard.js`, gösterim `utils/displayPicks.js`; `utils/candidateRank.js` adaylara sakinlik sırası damgalar (ölçülür, sırayı değiştirmez) |
| Canlı fiyat | `hooks/useLivePrices.js` (5 sn / 15 sn / 45 sn kademeler) → `fetchQuotesBatch` |
| Sinyal takibi | `hooks/useSignalTracker.js` (`bist_signal_history`, 500 kayıt, 10 dk kontrol, gün-sonu kapanıştan kesin kayıt) |
| Tahmin karnesi | `utils/scanScorecard.js` + `hooks/useScanScorecard.js` (`bist_scan_scorecard_v1`, 60 gün): gösterilen AL önerileri, yargılayan seansın kapanışı + 1G/5G; ekran `components/Signals/ScanScorecardPanel.jsx`, AI panelinde tek satır özet |
| Ertesi seans | `utils/nextSession.js` (özellikler + iki doğrusal lojistik model: hareket = zirve ≥ açılış+%3, yeşil = kapanış > önceki kapanış; katsayılar üretilmiş `nextSessionModel.js`). Tarama her satıra `_ns` damgalar (yalnız kapanmış barlar), `rankMovers` gün içi hareket listesini kurar (kural `DAYTRADE_RULE`: ilk 3, +%4 kâr-al, açılış önceki kapanışın `maxGapPct` (%5,67) üstündeyse alınmaz; `detail.movers`; likit, işlem tedbirsiz, son 60 barda >%25 sıçrama = bozuk seri girmez — ölçümdeki `artB` ile aynı bayrak); ileri ölçüm `utils/moversScorecard.js` + `hooks/useMoversScorecard.js` (`bist_movers_scorecard_v1`); ekran `components/Signals/DayMoversPanel.jsx`, AI panelinde tek satır, Tekil Analiz'de iki olasılık. Skora, AL sırasına ve paper'a girmez |
| Lot önerisi | `utils/positionSizing.suggestPosition` — AI kartları ve Analiz ekranı aynı fonksiyon; sermaye `bist_trading_capital` (Ayarlar, yoksa 100.000 TL) |
| Paper | `utils/PaperTradeEngine.js` + `hooks/usePaperTradeML.js` (ML AUTO), `hooks/usePaperTrading.js` (standart). ML motorunun çıkışı `utils/trailingStop.js` (yalnız trailing, seans bazlı; durum `bist_paper_ml_trail_v1`) |
| Yapay zekâ | `utils/claude.js` — tarama sonrası günlük notlar (`useAIAdvisor`). JARVIS sohbeti, İstihbarat ve Gemini kaldırıldı (kullanıcı, v31.50–51) |
| Hisse detayı | `components/StockDetail/` + `utils/financialStatements.js` (İş MaliTablo, 16 çeyrek, 4 istek × 4 dönem) + `utils/technicalSnapshot.js` — tüm teknik/temel değerler, karar vermez |
| Backtest | `utils/backtestEngine.js` — çıkış `planSimulation.simulatePlanReturn` (canlı kural, trailing-only, ≤30 bar), giriş ertesi açılış |
| Proxy | `api/` (PWA ile aynı origin) ve `proxy/api/` (Electron/Capacitor; `DEFAULT_PROXY_URL` = `proxy-delta-mocha-43.vercel.app`) — `proxy.js` ve `claude.js` iki kopyada **birebir aynı** |
| Masaüstü / mobil | `electron/main.cjs` + `preload.cjs`; Capacitor `android/`, `ios/` |
| Sunucu tarafı takip | `.github/workflows/signal-tracker.yml` — seans içinde 15 dk'da bir sinyal fiyatı + Web Push. **Kurulu değil**: Upstash Redis ve VAPID gizlileri hiç girilmedi (31.08–20.11 arası 170 çalışmanın hepsi düştü); v31.57'den beri yapılandırma yoksa not yazıp temiz çıkar. Kurulum kullanıcıda: Vercel → Storage → Upstash Redis, aynı değerler GitHub Secrets'a |
| Python | `bist_bridge.py` (borsa-mcp köprüsü), `borsa_bot_backtest/` (çevrimdışı araştırma) |

**Sekmeler** — masaüstü: Tekil analiz (varsayılan), Hisse detayı, Günlük intraday, Sinyal takibi, Paper trading.
Mobil: Analiz · Hisse · Sinyal · Paper (intraday mobilde mount edilmez; ayarlar Profil › Ayarlar'da, masaüstünde
Ayarlar penceresinde: işlem sermayesi, Claude / EVDS anahtarı, arka plan bildirimi, proxy). "Aracı kurum
bağlantısı" v31.55'te kaldırıldı — seçimi okuyan ya da webhook'a istek atan kod hiç yoktu. İstihbarat, Gerçek Portföy, Piyasa Nabzı ve "Tahmin isabeti" paneli
kullanıcı kararıyla kaldırıldı; tahmin defteri arka planda çalışır (governor + adaptif stop okur). Sinyal sekmesi
gün içi hareket listesi ve tahmin karnesiyle açılır, veri katmanı ölçümü (yabancı/KAP) orada. İzleme listesi
Hisse detayında, sanal pozisyonlar Paper'da. **Hisse detayı kendiliğinden hisse yüklemez** (kullanıcı, v31.54):
sekme boş açılır, analiz edilen hisse oraya taşınmaz; yalnız kullanıcının o sekmede seçtiği ya da "Hisse detayı ›"
ile açtığı hisse yüklenir.
Sanal portföy UI'sı yok ama durumu arka planda çalışır (risk uyarıları, trailing stop, otomatik stop/hedef).

**Tekil Analiz ekranı sade tutulur** (kullanıcı isteği): bir satır ancak başka bir satırın söylemediği bir
şey söylüyorsa ekranda kalır. İşlem kurulumu yalnız stop + hedef (hedef referans, satış emri değil); KAP
paneli ve JARVIS yok. Temel analiz tek kutuda; ayrıntı "Hisse detayı"nda. Başlık fiyatın hangi oturumdan
geldiğini yazar.

**Hisse detayı ölçümleri.** F/K ve PD/DD aynı bilançoda İş Yatırım'ın kendi değerleriyle birebir (THYAO,
ASELS, EREGL, SISE, BIMAS, KCHOL, AKBNK, ISFIN). Tablo türleri: XI_29 sanayi, XI_29K kiralama/faktoring,
UFRS_K/UFRS banka-sigorta (paralel denenir). FAVÖK = 3H + 4B. 4. çeyrek = yıllık − 9 aylık (TMS 29 / kur
yüzünden şişkin görünebilir, ekranda "*"). Grid/flex öğeleri `minWidth: 0` almazsa iç tablo kaydırıcısı
çalışmaz (telefonda içerik taşar ve kesilir — ölçüldü).

**Görsel dil** (kullanıcı: "pixel-art havası var"): emoji ikon yok (alt menü SVG), başlık ve düğmelerde
büyük harf + geniş harf aralığı yok, neon parlama/nabız yok. Renk değişkenleri `globals.css` sonundaki
v31.47 bloğunda (sakin Tailwind-500 ailesi); satır içinde neon hex yazma. AI kartında rozetler
`utils/pickChips.js`'ten öncelik sırasıyla gelir, ilk 3'ü görünür, gerisi "+N" ipucunda.

## Değişmezler — ihlal edilirse bir şey sessizce bozulur

**İki hesap motoru.** Gösterge ya da sinyal mantığına dokunan her değişiklik hem Rust'ta (`engine-rs/src`)
hem JS referansında yapılır, sonra `npm run build:engine` + `npm test` + `npm run parity:engine`. Kırmızı
parity testi "motorlar ayrıştı" demektir. Rust yolu yalnız motorun aynı dizi için ürettiği, dokunulmamış
`ind` için kullanılır; `localStorage.bist_engine = 'js'` Rust'ı kapatır, `window.__bistEngine()` tanı verir.

**Boş ile yok aynı şey değil.** Bu projede altı veri katmanı fark edilmeden öldü, çünkü kaynak düşünce kod
sessizce boş döndü ve "bugün haber yok" gibi göründü (mekanizma: `catch {}`). Yeni bir dış kaynak
`unavailable: true` + sebep döndürür (`kapAvailability.js`, `valuationRatios.js` örnek), `sourceHealth.js`'e
bağlanır. Ters hata da oldu: iki "artık ücretsiz kaynak yok" hükmü yanlıştı — bir kaynağa ölü demeden önce
sitenin tüm JS parçalarını ve bakımı süren açık kaynak istemcileri (borsapy, borsa-mcp) tara.

**`advisor-scan-complete` tek kırılma noktası.** Sinyal kaydı, paper auto-trade ve uyarılar bu olaya bağlı;
panel ise state'ten beslenir. Dispatch'i asla sessiz `catch` ile yutma.

**Fiyat serisi doğruluğu.**
- Seriler kronolojik sıralanır (`sanitizePrices`, `mergeDailyBars`, `parseBarsPayload`). İş Yatırım satır
  sırasını garanti etmiyor; sıralanmamış seri "son 20 bar"ı rastgele 20 bar yapar.
- Günler `istanbulDayKey` ile karşılaştırılır — UTC ya da `toDateString()` değil (kaynakların bir kısmı bar
  tarihini yerel saatle kuruyor).
- Canlı fiyat günlük bara **oturum gününe** göre birleşir (`liveSession.mergeLiveQuote`); takvim gününe göre
  birleştirmek hafta sonu son seansı ikinci kez ekliyordu.
- İş Yatırım HisseTekil **açılış vermez** (AOF verir); proxy `source=bars` açılışı Yahoo'dan alır, Yahoo gün
  atlar. Son barın gerçek açılışını İş toplu listesi (TumHisseSenetleri, `open` alanı) taşır.
- Seans dışında oluşan AL bir sonraki seansın açılışında dolar (`sessionEntry.js`).
- **Açılış = önceki kapanış barların %20–30'unda gerçektir**, veri hatası değil: İş toplu listesinde 13.11.2026'da
  likit hisselerin %29'u önceki kapanıştan açıldı, Yahoo açılışları aynı gün %98 aynı. Yahoo günlük zirve/dip
  de İş HisseTekil ile barların %99,5'inde aynı (8.528 bar). Getirinin tamamı gecede: ortalama gece boşluğu
  +%0,2, açılış→kapanış eksi — "ertesi açılışta giriş" ilk gecenin getirisini almaz.
- Bar stop'un ötesinde açıldıysa çıkış seviyeden değil **açılıştan** yazılır (`planSimulation`, paper motoru
  `STOP_GAP`); açılış yaklaşıksa (`_openApprox`) eski konvansiyon kalır.

**Söylenen strateji ile ölçülen strateji aynı olmalı.** Çıkış kuralı tek: yalnız trailing stop
(`tradePlan.PLAN_CONST`). Onu üç yer uygular ve üçü aynı sonucu vermek zorunda: `planSimulation` (sinyal
takibi, karne, backtest, kalibrasyon), `trailingStop.advanceTrail` (paper ML motoru; testi planSimulation ile
eşitliği kilitler) ve `useLivePrices` (sanal portföy). Paper motoru v31.52'ye kadar başka bir çıkış
çalıştırıyordu (hedefte tam satış + 3. gün çıkışı) ve fark işlem başına 0,7 puandı — yani ileri test önerilen
stratejiyi ölçmüyordu. Paper'da stop bir seans boyunca sabittir; seansın zirvesi stop'u ertesi seans çeker.

**Mobil WebView arka planda JS'i dondurur.** Uygulama kapalıyken olan hiçbir şey istemcide görülmez:
paper çıkışları uzun aradan sonra seviyeden dolar (`exitFill.js`), arka plan takibi GitHub Actions'ta.
Paper trailing bu yüzden fiyat kaydının taşıdığı **seans açılış/zirve/dibine** bakar: uygulama kapalıyken
değen stop da oluşan zirve de kaybolmaz (seans içi alımda o günün aralığı girişten önce olabilir, kullanılmaz).
**Tarama ekran kapanınca kaybolmaz** (`scanKeepAlive.js`): tarama süresince Wake Lock, gizliyken yeni grup
başlamaz ve gizli süre bütçeden düşer, donma sırasında düşen semboller kısıtlama sayılmadan yeniden denenir,
sayfa ölürse `bist_scan_in_progress` işaretiyle açılışta yeniden başlar (45 dk, en fazla 2 kez).
Bu yüzden **ölçüm kayıtları resmi kapanıştan yerleşir**, canlı fiyat yalnız geçicidir: sinyal takibi
(`perfDaily`), tahmin defteri (`settleJournalFromBars`, canlı mandal `perfLive`'da denetim için durur)
ve tahmin karnesi. Defter skora geri döner (profit governor + adaptif stop), canlı mandal orada yanlıştı:
uygulama günlerce kapalıysa d1/d3/d5 aynı geç fiyatı alıyordu. Barlar taramanın anahtarıyla çekilir
(`dailyBarsBatch.js`, `SYM_1y_1d`); ağ hatası deneme sayılmaz, kaynak bar yayınlamadan önceki akşam da.

**PWA güncellemesi.** `public/sw.js` kurulumda `skipWaiting` yapar ve **veri isteklerini (`/api/`, başka
origin) yakalamaz**: tarayıcı, aktif worker'da süren fetch olayı varken bekleyen worker'ı devreye almaz; tarama
15 paralel istekle 10–20 dk sürdüğü için yeni sürüm `skipWaiting`'e rağmen "bekliyor"da kalıyordu (ölçüldü,
yerel önizleme). Otomatik taramalar açılıştaki güncelleme kontrolünü bekler (`utils/appUpdate.js` kapısı,
≤10 sn) ve güncelleme bekliyorsa başlamaz; öne gelişte kontrol 1 dk'da bir. Tarama sürerken gelen sürüm
`UpdateBanner` ile duyurulur ("Şimdi yenile" — yarım tarama açılışta devam eder); `/version.json` (her build)
çalışan paketle karşılaştırılır, worker takılırsa şerit önbelleği temizleyip yükler. Telefondaki paket
Profil'deki "Sürüm 31.x · <commit>" satırından okunur (`buildInfo.js`). Yerel deneme: `.claude/launch.json`
→ `preview-dist` (vite preview :4173), iki build arasında `reg.update()`.

**Evdeki Wi‑Fi `*.vercel.app`'i engelliyor** (ölçüldü 15.11.2026): hat Turkcell Superonline, "Güvenli İnternet"
**Standart Aile Profili** açık. TLS adından (SNI) kesiyor — DNS doğru, aynı Vercel IP'si başka adla (vercel.com)
açılıyor, düz HTTP `guvenliinternet.turkcell.com.tr/sol/?…&CAT=GI3`'e yönleniyor. Uygulama, proxy (`/api`), `sw.js`
ve `/version.json` aynı adda: o ağda **güncelleme inmez, veri gelmez**, ama önbellekteki kabuk açılır. Bu yüzden
`/version.json` yoklaması erişimi de sınıflar (`appUpdate.classifyReach`: HTTP yanıtı = erişim, ağ hatası + çevrimiçi
= engel) ve `ConnectionBanner` söyler; ağ değişince / "Tekrar dene"de yoklama yenilenir, yalnız son yoklama yazar.
Çözüm kullanıcıda: hattın profilini kapatmak ya da mobil veri. Geliştirme makinesi de aynı hatta — canlı site
buradan açılmaz, bu yayının bozuk olduğu anlamına gelmez (yayın durumu: `gh api repos/<repo>/commits/<sha>/status`).

**Gizlilik.** Gerçek portföy özelliği v31.50'de kaldırıldı; eski veri cihazda (`bist_real_portfolio`,
gitignore'lu `src/data/realPortfolio.local.json`) kalabilir, uygulama okumaz. Kök `.vercelignore` onu ve
`.env*`'yi açıkça hariç tutar.
API anahtarları depoya girmez, `proxy/.env` yazdırılmaz.

**Depolama.** localStorage anahtarları `bist_` önekli. Sıfırlamanın neyi silip neyi koruduğu
`utils/resetStorage.js`'te tek listede; yeni bir takip anahtarı eklersen oraya da ekle.

**Proxy.** İki kopya birebir aynı tutulur. Yeni bir `source=` adı ancak proxy yeniden yayınlanınca çalışır;
istemci eski dağıtımı "boş" değil `proxy_outdated` olarak raporlar. `.vercelignore` satırlarını `/` ile
çapala (çıplak `data` satırı `src/data/`'yı build'den siliyordu).

## Yapay zekâ entegrasyonu (`utils/claude.js`)

- **Maliyet yalnız kullanıcı Ayarlar'a Claude anahtarı girerse oluşur.** Anahtar yoksa hiçbir istek gitmez,
  tarama notlandırması atlanır. `claude.js`'te yalnız bu rota kaldı (`askDailyPicks`); tüketicisiz sohbet,
  uzman analizi, KAP özeti, piyasa istihbaratı ve strateji üretici v31.55'te silindi.
  Anahtar varsa her taramadan sonra otomatik bir notlandırma isteği gider (`useAIAdvisor`, 25 sn kesme —
  kesilen istek yine faturalanır).
- Model **`claude-opus-5-5`** (`CLAUDE_MODEL`), tüm rotalarda. İstek `/api/claude` proxy'si üzerinden gider;
  kullanıcının kendi anahtarı `x-api-key` başlığında, proxy `anthropic-beta`'yı yukarı iletir.
- Opus 5.5'te **örnekleme parametresi yok** (`temperature`/`top_p`/`top_k` → 400) ve **düşünme hep açık**:
  tek kontrol `output_config.effort` (API varsayılanı `medium`); günlük notlar `medium` verir.
- Düşünme `max_tokens`'a sayılır; çağıran yanıt bütçesini verir, `THINKING_HEADROOM` üstüne eklenir.
- Yanıt blok **türüne** göre okunur (düşünme blokları önce gelebilir). `stop_reason: "refusal"` açık bir
  hata mesajına çevrilir; sunucu tarafı yedek (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) açık.
- Süre: Vercel fonksiyonu `maxDuration: 60`, istemci 65 sn bekler. Akış (streaming) yok.
- Prompt'lar Türkçe ve ASCII-güvenli JS dizeleri (`buildDailyPicksPrompt`).

## Veri kaynakları (ölçülmüş durum)

| Kaynak | Ne için | Durum / tuzak |
|---|---|---|
| Proxy `source=bars` | günlük bar (İş günleri + Yahoo açılışları) | çalışıyor; sıralı döner |
| İş Yatırım TumHisseSenetleri | toplu canlı fiyat (704 sembol, gerçek açılış, önceki kapanış, `updateDate`) | çalışıyor; yanıt çıplak dizi |
| BigPara `hisseyuzeysel/<KOD>` | tek sembol canlı fiyat | çalışıyor; `X-Requested-With` olmadan 401, hızlı ardışık isteklerde geçici 401 (rate limit) |
| İş hisse tarama (`getScreenerDataNEW`) | `isy_foreign` yabancı oranı (40, 44/45, 8, 22/23); `isy_valuation` F/K (28) + PD/DD (30) | çalışıyor; kriterlerin **kesişimini** döndürür → metrikleri ayrı istekte tut |
| İş MaliTablo | bilanço, kümülatif | çalışıyor; istek başına 4 dönem (5.+ yok sayılır). Analiz kutusu: [bu dönem, geçen yılın aynı dönemi, son yıl, önceki yıl] → 12A ve YoY doğru. Hisse detayı: 16 çeyrek. Spor kulüpleri (haziran–mayıs) dönem etiketleri takvime oturmuyor |
| KAP `POST /tr/api/disclosure/list/main` | bildirim akışı | çalışıyor; içeriden öğrenen ve özet finansal uçları 404 |
| Yahoo chart / quoteSummary | bar yedeği, temel veri | çalışıyor (crumb `/v(7|8|10)/finance/`); BIST değerlemesi delikli (THYAO PD/DD 46 kat hatalı) → F/K-PD/DD İş'ten |
| RSS (BloombergHT, Dünya, Borsanın Gündemi, Sabah) | haber | çalışıyor; şirket adı → kod eşlemesi kısmi (`NAME_ALIASES`) |
| TCMB EVDS (evds3, `key` başlığı, `TP.MKNETHAR.M7`) | haftalık yabancı akış | anahtar gerekiyor (Ayarlar). İstemci anahtarı `X-Evds-Key` başlığında yollar (URL'de değil — günlüğe ve uç önbelleğe girerdi), proxy TCMB'ye `key` başlığıyla iletir, yanıt önbelleğe alınmaz. Ölçüldü: başlık yok → 403, yanlış anahtar → 401 (`evdsErrorMessage`). Anahtarlı başarılı yanıtın biçimi henüz doğrulanmadı |
| doviz.com/ekonomik-takvim | makroekonomik takvim (`econCalendar.js`, proxy `source=econ_calendar`) | çalışıyor, anahtarsız; sunucu tarafı HTML (~1 MB, TR dahil, gerçekleşen/beklenti/önceki). Ay sekmesi ayın sonunda biter → PPK günleri ayrıca TCMB'nin 2026 takviminden (`PPK_DATES_2026`). Ayrıştırıcı proxy'de birebir kopya, test eşitliği kilitler. ForexFactory JSON'da TR yok |
| TCMB "1 Hafta Repo" sayfası | politika faizi (`tcmbRate.js`, proxy `source=tcmb_rate`) | çalışıyor, anahtarsız; HTML olduğu için proxy sunucuda ayrıştırır (istemci zinciri HTML'i reddeder), yerelde Vite `/api/tcmb`. 23.10.2026: %36 |
| Yahoo makro (`USDTRY=X`, `^VIX`, `BZ=F`, emtia) | makro kutular + rejim ayarı + Claude makro satırı | çalışıyor; `fetchYahooSeries` → `getData` (yerelde Vite `/yahoo`, PWA'da kendi proxy). Gelmezse kutu "veri yok" der, sabit değer basmaz |
| biquote.io, Foreks, BigPara liste/HTML, eski İş yabancı sayfası | — | ölü (biquote'ta BIST hiç yok) |

Borsa MCP uzak sunucusu bağlı (`borsa`, borsa.surucu.dev/mcp) — oturumda araştırma için; uygulama kullanmaz.

## Ölçülmüş kararlar — yeniden ölçmeden değiştirme

v31.53 ölçümü (`feature-edge-report.mjs`): 257 hisse, 2022-09 → 2026-10, canlı AL filtresinden geçen ≈68.600
aday; sinyal günü rejimi, ertesi açılış girişi, canlı stop (1,8×ATR kırpması), yalnız-trailing, %0,3 maliyet
sonrası işlem başına net. Nominal TL ve bugün işlem gören hisseler — mutlak getiri değil karşılaştırma.

| Konu | Karar | Dayanak |
|---|---|---|
| Rejim kapısı | YÜKSELİŞ serbest; YATAY taban skor **70**, en fazla 4 AL; DÜŞÜŞ taban 58 ama AL'lar `_watchOnly` (görünür, açılmaz) | Dürüst etiketle (sinyal günü) YÜKSELİŞ +1,06 / YATAY +0,54 / DÜŞÜŞ +0,14; son iki yılda +0,20 / +0,03 / −0,19 — sıra aynı, fark dar. Eski dayanak ("yalnız YÜKSELİŞ pozitif, DÜŞÜŞ −3,4") rejimi giriş gününün kapanışıyla etiketliyordu (ileri bakış: aynı işlemler +1,55 / +0,38 / −0,53 görünüyor). **YATAY tabanı 70 yeni ölçümde tutmuyor**: YATAY günlerinde skor ≥70 adayların ortalaması −0,28, o günlerin tüm adayları +0,42 (keşif −0,73 / +0,73, doğrulama 0,00 / +0,30); YATAY'da skor 45–65 kademeleri +0,5…+0,7. **Kullanıcı kararı (12.11.2026): "şimdilik kalsın"** — rakamları ve öneriyi (taban 55, skor sıralaması yok, tavan 4 + yarım boyut aynı) gördü, tabanı 70'te bıraktı. Aynı kanıtla yeniden sorma; yeni veriyle (ileri karne, `feature-edge-report --only skor` tekrarı) ya da kullanıcı açarsa konuş |
| Günlük garanti | `ensureBestOfDay`: panelde en az **3** AL adayı (patlamamış, aşırı alımda değil). AL hiç yoksa ilki eski tek garanti pick (aynı etiketler); diğer tamamlayıcılar her rejimde `_watchOnly` (görünür, paper açmaz, lot 0) | kullanıcı: "her gün bir aday" → v31.51 "top 3". Maruziyet değişmez; edge yaratmaz |
| Çıkış | yalnız trailing stop (+%3 başabaş, +%5 üstü yarısını kilitle); hedefler referans, satış emri değil. Paper ML motoru da v31.53'ten beri bunu uygular (en fazla 30 seans) | kademeli satış getirinin yarısını yok ediyordu (26.855 sinyal, 5 yılın 5'inde). Paper'ın eski çıkışı (hedefte tam satış + 3. gün +%1 altında kapat) aynı giriş/stopla işlem başına −0,03, trailing +0,70; keşif (+0,05 / +0,83), doğrulama (−0,02 / +0,75) ve 2022–2026'nın her yılında aynı yön. Ölçülmemiş ipucu: hedefsiz + 3. gün tabanı +1,14 (2022–23'te daha iyi, 2025–26'da daha kötü) — walk-forward taraması gerekir. Sert düşüşte (2026 Eyl–Eki) eski çıkış daha az kaybetti (−1,5 / −2,3) |
| Aday sıralaması | Sıra bugünkü anahtarlarla (yarın-potansiyeli → güven + konviksiyon; paper skora göre). Sakinlik sırası (`candidateRank.js`: düşük oynaklık, düşük ADX, MA50'ye yakın, giriş kalitesi) damgalanır ve ölçülür, **seçime kapalı** (`dataLayerPolicy.calmRankSelection`) | Bugünkü anahtarlar adayları sıralamıyor: gün-içi sıra korelasyonu skor −0,00, yarın-potansiyeli +0,00, güven −0,01; canlı liste ilk-3 tabandan −0,21 (t −1,6). Sakinlik: keşif +0,049 (t 6,3), doğrulama +0,041 (t 5,7), ilk-3 tabandan +0,43 / +0,41; isim değil durum etkisi. Ama trailing çıkışla avantaj 2024 ortasına kadar +1…+2, sonra ≈0, 2026 ilk yarı −0,66 (t −2,8); eski paper çıkışıyla 10 dönemin 9'unda artı. Güvenden "endekse göre güç" terimini çıkarmak iki kümede tutarsız → dokunulmadı. **586 hissede tekrarlandı (22.11.2026):** gösterilen 8 o günün aday ortalamasından keşif +0,10 (t 1,0), doğrulama −0,06 (t −0,4); paper ilk 3 ≈0; motorun asıl AL'i ile skor ≥55 diye terfi eden TUT arasında tutarlı fark yok. Değer aday havuzunda (geçmişte işlem başına ≈+0,9, 2026'da eksi), sıralamada değil |
| Yeşil kapanış | Yeşil kapanış olasılığı gösterilir (Tekil Analiz, hareket listesi), **seçime ve sıraya girmez**; "her gün çoğunluk yeşil" bir hedef olarak kabul edilmez | `next-session-report.mjs`, 257 hisse, 237 bin hisse-gün: likit evrende yeşil kapatan %47–49, hisselerin çoğunun yeşil kapattığı gün %46. Model (ileri-yürüyüş, görmediği hisse + yıl) ilk-5'te %50–55'e çıkarıyor (257 hissede %52, 586 hissede %55; taban %47) — fazlası yok; doğrusal olmayan model daha iyi değil. Yön yerine yapı: açılışta alıp kapanışta satmak maliyet sonrası evrende −0,39 (t −8,3), yeşil modelinin ilk-5'inde −0,30 |
| Gün içi hareket | Liste gösterilir ve ileri ölçülür (`DayMoversPanel`, `moversScorecard`); AL listesinden bağımsız, paper açmaz. Kural: ilk **3** hisse, açılışta alış, **+%4 limit kâr-al**, dolmazsa kapanışta satış; **açılış önceki kapanışın %5,67 üstündeyse alma** (kâr-al tavanın +%10 üstünde kalır, dolamaz — eşik kuraldan türetilir); dar stop önerilmez. Model 586 hissenin 525 bin hisse-günüyle eğitildi (`--write-model`) | 586 hisse, ileri-yürüyüş (A'da eğit, B'nin sonraki yılında sına): ilk-5'in %66–76'sı açılışın ≥%3 üstünü görüyor (taban %28). Yön değil: aç-kapa ilk 3 +0,24 (t 1,7). Kâr-al +%4 ilk 3 +0,71 (t 7,1); **açılış sınırıyla +0,95 (t 9,2)**, 2024 / 2025 / 2026 / sonrası +0,76 / +0,89 / +1,39 / +0,73; atlanan 199 işlem tek başına −1,66 (t −4,4). Saatlik yolla sınırlı +1,35 (t 6,6), kârlı işlem %72, 6 yarıyılın 6'sı artı. Sınırı +%3–4'e çekmek biraz daha iyi görünür ama veriye uydurulmuş eşik olur — alınmadı. Stop %3: +0,12; %5: +0,79. En kötü %5 işlem −%8. 257 hissede aynı kural +0,44 idi (evren genişleyince güçlendi). 9–20 Kasım (görmediği hafta, düşen piyasa): ilk 3 alınabilen 27 işlem, ort. +2,55, 24'ü kârlı; 13.11 listesinin 1. ve 3. hissesi tavanda kilitli kaldı. İleri ölçüm 30 işlemi görmeden kural olarak sunma |
| Açılış boşluğu | Kapı yok (stop altında açılan emir zaten iptal, `decidePendingFill`) | ±%2 boşlukta girmeme kuralı keşifte iyi görünüyordu (aşağı boşluk ≤ −%2: −0,53), doğrulamada tersine döndü (+0,95); portföy simülasyonunda kapının etkisi yok |
| Stop dolumu | Bar stop'un ötesinde açıldıysa açılıştan (`planSimulation`, paper) | Seviyeden dolum işlem başına ~0,3–0,5 puan iyimserdi; giriş stop altında açıldığında hayalî kâr (+3,1 yazıyordu, gerçek −0,3) |
| Boyutlandırma | paper: risk %2 / stop mesafesi, %33 tavan; konviksiyon çarpanı (sniper 1 / flagged 0,75 / early 0,5, YATAY ×0,5) | gösterilen lot önerisiyle aynı kural (`suggestPosition`, çarpan `_positionSizeMult`, izle-only = 0); parametre taramaları portföy getirisiyle puanlanır. Skor kademesi YÜKSELİŞ'te hafif artı (45–55: +0,88 … ≥70: +1,5), YATAY'da ters — çarpan YÜKSELİŞ için savunulabilir |
| Öğrenme | kalibrasyon planın çıkışından öğrenir (`planSimulation`), canlı-edge hücresi ≥8 örnekte devreye girer | ham 5 gün getirisi farklı bir stratejiyi ölçüyordu |
| Veri katmanı | yabancı akış ve KAP katalizörü skora **kapalı**; KAP tedbiri AL'dan çıkarır; geri alım bildirimi +3; sakinlik sırası ve bilanço kapısı aynı politikada (Sinyal sekmesinde kovalar) | kullanıcı: "göster + ölç, sonra aç" (`dataLayerPolicy.js`); geri alım tek sağlam olumlu KAP olayı (10 seans +%1,16) |
| Anlaşma haberi | "yeni iş / sözleşme" haberi güvene artı vermez (ne bonus ne skor ağırlığı) | 1.132 olay: haber anında fiyatlanmış, sonrasında piyasanın gerisinde |
| Ölü kurallar | Wyckoff spring/UTAD, hacim klimaksı, TTM çözülmesi, DI yakınlaşma puanları silindi | hiçbiri pozitif değil; satış klimaksı tasarımın tam tersi (10 seans −%3,59) |
| Supertrend | yukarı dönüş +12 kaldırıldı, yön (+4) duruyor | iki ufukta negatif; kullanıcı kararı |
| Wyckoff spring | yarın potansiyelinde +15 **duruyor** | zayıf negatif kanıt; kullanıcı ileri veri bekliyor |
| Tavan kapısı | `pumpGuard.isUnsafeForTomorrow` — RSI>90 / MFI>92 mutlak red; bugünkü pump ≥%7 ise devam olasılığı ≥%38/45/50 (7–8 / 8–9,5 / ≥9,5); %5–7 ise kataliz + 4 teknik teyit şart | testlerle kilitli; sermayeyi en doğrudan koruyan kapı. Ölçüldü: reddettikleri alınsaydı +0,38, geçenler +0,70 (iki kümede de düşük). Asgari kalite kapısının redleri +0,01. "İki gün üst üste yükseliş" ve "aşırı alım" redleri ise geçenlerden kötü değil (+0,86 / +0,71) — zarar vermiyor ama ayırmıyor |
| Bilanço kapısı | `fundamentalQualityGate` (en iyi ~18 aday, Yahoo verisi): sert red D/Ö>5, cari<0,4, net marj<−%25; ceza D/Ö>2, cari<0,8, zarar, 3 çeyrek düşen kâr. **Kullanıcı kararı (22.11.2026): "çevir" — göster + ölç.** Veri yine çekilir, kartta bilgi rozeti ("Bilanço zayıf" / "Bilanço: dikkat"); karar `_fundGate` (red / ceza / temiz) sinyale yazılır ve Sinyal sekmesinde ölçülür; eleme ve güven cezası kapalı (`dataLayerPolicy.fundamentalGate`) | `fundamentals-study.mjs`: aynı eşikler İş MaliTablo verisiyle, noktasal (yayım gecikmesi Q1/Q3 +60, ilk yarı +75, yıl sonu +105 gün), 586 hisse, adayların %99'unda bilanço var. Elenenler temizlerden **kötü değil**: keşif +1,49 / +0,81, doğrulama +0,97 / +1,02, 2022–2026 her yıl elenenler önde. Kötü uç aynı (p1 −9,5, p5 −7,2 / −7,3, %10'dan büyük kayıp %0,7 / %0,7). Cezalılar karışık (keşif −0,06, doğrulama −0,41 temize göre). Kapı ne getiriyi ne riski koruyor |
| Değerleme ve bilanço faktörleri | F/K, PD/DD yalnız gösterim, skora girmez | 22.11.2026 ölçüldü (aynı çalışma): kazanç getirisi, defter/piyasa, özkaynak kârlılığı, marj, büyüme, borç, cari oran — doğrulamada gün-içi sıra korelasyonu en fazla +0,026 (defter/piyasa), ekonomik olarak önemsiz; keşifte daha zayıf, 2026-08 sonrasında hepsi ters. Kısa vadeli (trailing, günler-haftalar) seçimde bilanço bir şey katmıyor |

## Tarama hattı (özet)

Evren = sabit liste ∪ İş tarama listesi, bugün fiyatı olmayanlar çıkar (623). Tarama 30 paralel (mobil/PWA 15),
adaptif yavaşlama (`adaptiveThrottle.js`), başarısızlar sınırlı tekrar geçişiyle (200 sembol / 90 sn) yeniden
denenir; ana döngü veri akarken 20 dk'ya kadar, akmazken 8 dk'da kesilir ve kapsama ekrana yazılır. Likidite:
günlük ≥2M TL; 100K–2M yalnız erken birikim (4+ sinyal) varsa, 100K altı hiç (kod 4ec5104'ten beri böyle; belge
500K diyordu, ölçülmedi). Otomatik tarama 09:55 ve 18:15; her işlem
gününün kapanışı ayrıca bir kez kaydedilir (`scanSchedule.js`, damga yalnız başarılı dispatch'te). Sonuçlar
`bist_last_ai_picks`'e yazılır, faz süreleri her taramada loglanır.

## Test ve CI

- Vitest, 74 test dosyası; saf yardımcılar test edilir, orkestrasyon (`useAIAdvisor`, büyük paneller) büyük
  ölçüde testsiz — mantığı saf bir modüle çıkarıp test etmek tercih edilen yol.
- `npm run lint` 0 hata zorunlu, uyarı tavanı 90 (v31.55'ten beri **0** — yeni uyarı ölü kod ya da bayat
  kapanış demektir: v31.55'te `recordAdvisorPick` rejim yedeğini ilk açılıştaki değerle yazıyordu).
- Ölü kod: `main.jsx`'ten erişilemeyen `src/` dosyası tutulmaz; yalnız `scripts/` ya da Electron'un kullandığı
  modüller (`walkForward.js`, `trackingAlerts.js`, `DatabaseManager.js`) bilerek durur. Ölü kod silerken
  `scripts/live-ranker-replica.mjs`'i unutma: canlı seçim zincirinin kopyası `useAIAdvisor.js`'ten fonksiyonları
  **adıyla** keser (espree). v31.55'te bir komşu fonksiyon silinince kopya kırılmış ve fark edilmemişti;
  `liveReplica.test.js` artık bunu yakalar.
- GitHub Actions `ci.yml`: test-js (lint + coverage), build-web, test-python, ci-gate.
- Arayüz değişikliği önizlemede doğrulanır (`.claude/launch.json` → `dev`). Önizleme tarayıcısında dış istekler
  CORS'a takılır ve `innerWidth` 0 okunup masaüstü dalı mobil sanılabilir; canlı veri için yayındaki siteyi kullan.

## graphify

Kod grafiği `graphify-out/` altında (bir PreToolUse hook'u hatırlatır). Mimari sorularda önce
`graphify-out/GRAPH_REPORT.md`; CLI kuruluysa `graphify query "<soru>"`, kod değişince `graphify update .`.
