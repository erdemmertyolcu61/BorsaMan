# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# BIST AI Trading Terminal — Claude Code Context

## Proje Amaci
BIST (Borsa Istanbul) hisselerini cok katmanli teknik + temel + akilli para + makro perspektifle
analiz eden, sinyal uretip risk yoneten, Claude Sonnet 4 tabanli yapay zeka yorumcusu ile destekli,
masaustu bildirimli bir trading terminali. React 18 + Vite 5 ile gelistirilmis SPA, Electron ile
Windows masaustu ve Capacitor ile iOS/Android uygulamasi olarak paketlenir. 7 katmanli analiz
hiyerarsisi (Makro → Sektorel → Temel → Teknik → Zaman → Risk → Pozisyon) ve A/B/C/D setup
gradelemesi ile calisir.

## Komutlar

```bash
# Gelistirme
npm run dev                  # Vite dev server (localhost:5173)
npm run electron:dev         # Electron + Vite dev server birlikte

# Build
npm run build                # Vite production build -> dist/
npm run electron:prod        # Vite build + Electron calistir
npm run electron:build       # NSIS installer (.exe)

# Proxy (Vercel)
cd proxy && vercel --prod    # Self-hosted proxy deploy

# Test
npm test                     # Tum testleri calistir (Vitest)
npm run test:watch           # Watch mode
npm run test:coverage        # Coverage raporu -> coverage/index.html
npx vitest run src/utils/__tests__/signals.test.js   # Tek dosya testi

# Python
pytest tests/                # bist_bridge.py icin pytest

# Walk-Forward Optimizer (offline research, root-level)
python ml_forward_tester.py --symbol THYAO                    # SMC, 12M IS / 3M OOS, 2Y veri
python ml_forward_tester.py --symbol GARAN --strategy adx     # ADX trend stratejisi
python ml_forward_tester.py --symbol AKBNK --timeframe 5Y     # 5Y → 2Y fallback test
python ml_forward_tester.py --symbols THYAO,GARAN,SISE --quiet --out reports/wf.json

# Graphify (kod-haritasi token tasarrufu, ~15x reduction)
graphify update .              # Re-extract code → graphify-out/{graph.json,GRAPH_REPORT.md}
graphify query "<concept>"     # Sembol/topic ara
graphify path A B              # Iki node arasi en kisa yol
graphify explain <node>        # Bir node + komsulari aciklama
```

## Mimari

- **Frontend**: React 18 + Vite 5 SPA
- **Desktop**: Electron 41 (`electron/main.cjs`, preload: `electron/preload.cjs`)
- **Mobile**: Capacitor 8 (`android/`, `ios/`) — `capacitor.config.json`
- **Backend**: `proxy/` — Vercel Serverless CORS proxy (10 domain whitelist + `/api/claude`)
- **Python kopru**: `bist_bridge.py` — borsa-mcp server'i ile TradingAgents arasingi
- **Terminal estetigi**: Koyu tema (#0a0e17), JetBrains Mono + Space Grotesk
- **4 ana sekme**: Tekil Analiz, Strateji/Backtest, Intraday Trade, Portfoy
- **Sabit paneller**: AIAdvisorPanel (sol), AIAdvisorDetailPanel (alt, collapsible), SignalsTab (Sinyal Takibi — 4 alt-sekme)

## Teknik Ozellikler (v8)
- **Gostergeler**: MA-20/50/100/200, RSI(14), MACD(12/26/9), Bollinger Bands, ATR(14),
  Fibonacci, Pivot, MFI, OBV, VWAP, A/D Line, TTM Squeeze, Chandelier Exit, ADX, Wyckoff Phase
- **Akilli Para**: MFI kurumsal alim/satim, OBV birikim/dagilim trendi, VWAP pozisyonu,
  Wyckoff Phase (Accumulation / Markup / Distribution / Markdown)
- **Setup Tespiti**: 10+ pattern (Bollinger sikisma, oversold bounce, MACD diverjans,
  hacim kirilimi, golden cross, Wyckoff Spring, Volume Climax, Double Bottom, Cup & Handle)
- **Setup Grade**: A/B/C/D sinyal skoru + OBV birikim, MFI<40, ADX>25, fiyat>MA200 bonuslariyla
- **Sinyal Motoru (v21)**: 5 kademe (GUCLU AL → AL → TUT → SAT → GUCLU SAT), ATR-bazli stop,
  Fibonacci hedefler, R/R hesaplamasi, adaptive thresholds, regime detection
- **v21 Tukenis/Tuzak Tespiti**: Distribution trap (OBV dist + price up = -2.5), exhaustion pattern
  (3 gun yukselis + hacim kuruyor = -2.5), daralan govde (-1.5), gravestone doji (-2.5), MFI asiri alim (-2.0)
- **Signal Attribution**: `extractFiredSignals(ind, prices)` — 23+ sinyal tipi tespit eder;
  `useSignalTracker` kapanan trade'lerdeki per-signal-type win rate'i hesaplar;
  `genSignal` yeni sinyalleri gecmis basari oranina gore ±2 puan kalibre eder
- **Monte Carlo (v2)**: 500 senaryo log-return GBM, 90 bar pencere, Box-Muller Z, p5/p25/p50/p75/p95
  olasilik konisi, karda kapanma olasiligi, en iyi %5 / en kotu %5 senaryolar
- **Trailing Stop**: +%3 breakeven, +%5 uzerinde %50 kar kilitleme, kalan trailing
- **Pozisyon Boyutlandirici**: 10K TL varsayilan sermaye, risk % bazli lot hesabi
- **Sektor Rotasyonu**: Para akis skoru, birikim %, sektor bazli AL/SAT heatmap
- **Temel Analiz**: `fundamentalEngine.js` — grossMargin, opMargin, netMargin, ROE, ROA,
  debt/equity, currentRatio, profitTrend, 15+ esik; Yahoo + KAP bilanco harmanlamasi
- **Fundamental Grade**: A+ (8.5+), A, B+, B, C, D — `getFundamentalGrade(score)` renk doner
- **Backtest**: Sag panelde inline, 4 strateji (Sinyal / RSI / MACD / MA), equity curve;
  `G_data` uzerinden calisir, yeniden veri cekmez
- **Sanal Portfoy**: 10K baslangic, pozisyon ac/kapat, P&L takibi, localStorage kalici
- **Watchlist**: localStorage kalici, fiyat alarmlari, live_guard uyarilari

## Yapay Zeka — JARVIS v8 / Alpha Engine
- **Model**: `claude-sonnet-4-20250514`, `/api/claude` proxy uzerinden, temperature 0.6
- **7 katmanli prompt**: Makro → Sektorel → Temel → Teknik → Zaman → Risk → Pozisyon
- **Contrarian protokol**: Asiri iyimserlik/kotumserliklerde karsit gorus testi
- **Hafiza sistemi**: `MEMORY_KEY='bist_jarvis_memory'`, MAX_MEMORY=5 son etkilesim
- **Auto-reading**: Sembol degistiginde otomatik cross-system context yorumu
- **Cross-system context**: Advisor scan sonuclari + sinyal tracker gecmisi + portfoy + watchlist
  + sektor rotasyonu hepsi prompt'a enjekte edilir
- **Web search**: `web_search_20241020` toolu ile gunluk haber/sirket arastirmasi
- **Daily picks**: A/B/C grade ile portfoy onerisi, JSON mode (temp 0.3)
- **Event listener**: `advisor-scan-complete`, `trades-scan-complete` CustomEvent'lerini dinler
- **API dosyalari**: `src/utils/claude.js` (setApiKey, buildExpertPrompt, askExpert, chatClaude,
  analyzeKAPList, askDailyPicks)

## Sinyal Takip Sistemi (`useSignalTracker`)
- **Storage**: `bist_signal_history`, MAX_HISTORY=500
- **Dedup**: 4 saatlik pencerede ayni sembol + sinyali bloklar
- **Periyodik kontrol**: Her 10 dakikada `fetchBigParaQuote` ile fiyat alip outcome belirler
  (TARGET_HIT / STOP_HIT / WIN / LOSS / OPEN)
- **Performans**: 1 gun / 3 gun / 5 gun getiri otomatik dolar
- **Reliability skoru (0-100)**: `winRate*0.5 + sampleWeight*20 + ((expectancy+10)/20)*30`
- **Kirilim**: bySource (live_guard / watchlist / advisor / signal_tracker / manual) + byClass

## AI Advisor (`useAIAdvisor` — v21)
- **Piyasa saatleri**: `isMarketOpen()` — hafta ici 09:30-17:30; `isMarketClosedForDay()` export mevcut
- **Otomatik tarama**: AUTO_SCAN_INTERVAL_MS = 15 dk, SCAN_CONCURRENCY = 20 paralel worker, CHUNK_DELAY_MS = 60ms
- **Universe**: SCAN_UNIVERSE = 'bistall' (~648 sembol)
- **Per-symbol timeout**: `withSymTimeout(fn, 11000)` — tek yavas sembol tum chunk'i bekletmesin
- **Market sentiment**: sectorRotation (calcSectorMetrics + rankSectors), avgRSI, AL/SAT sayisi
- **Top picks filtresi**: score >= 55 ve rr >= 1.0 (market kapali: score >= 52, rr >= 1.0)
- **LIKIDITE KAPISI — IKI KADEMELI**:
  - `MIN_DAILY_VOLUME_TL = 2_000_000` — tam likit esigi, standart filtre
  - `EARLY_ENTRY_MIN_VOLUME_TL = 500_000` — erken alim icin minimum hacim
  - 500K-2M arasi: SADECE `detectEarlyAccumulation` 4+ sinyal verirse kabul → "🔍 ERKEN" rozeti
  - <500K: tamamen ele (manuel emir bile zor)
- **detectEarlyAccumulation(r)** — patlama oncesi 10 sinyal kontrolu:
  - ZORUNLU: recentPump <= 3% (henuz patlamamis) + atrPct <= 5%
  - SINYALLER: OBV birikim, CMF>0.08, Wyckoff Accumulation/Spring, TTM Squeeze, hacim 1.3-2.5x kademeli, MA20 ±%2-3 konsolidasyon, MFI 35-55, Boll %25-65, kataliz haber, RSI 40-55 sweet spot
  - 4+ sinyal → `_earlyPick: true`, ranking'de +12 (intraday) / +14 (afterHours) bonus
- **Sell sinyalleri**: `calcSellPotential(result)` — bearish scoring, buyPicks (max 8) + sellPicks (max 3) ayri
- **v21 composite confidence** — 7 bileskenli:
  - 28% teknik + 18% potansiyel + 10% sektor + 8% haber + 18% giris kalitesi + 8% likidite + 10% momentum sagligi
- **Momentum Health (v21)**: Hacim teyidi + OBV + RSI + CMF birlesiik saglik skoru (0-100)
- **Tier**: STRONG (>=75) / GOOD (>=65) / FAIR (>=55) / WEAK (<55) — UI'da rozet
- **Entry quality (v21)**: `recentPump` + `distFromMA20` + distribution trap + hacim teyidi karisimi
  - Distribution trap (OBV dist + price up): ek -35 ceza
  - Zayif hacim rallisi (volRatio < 0.8 + yukselis): ek -20 ceza
- **Konfluens bonusu**: `calcTomorrowPotential` — OBV+CMF+haber+supertrend+RSI sweet spot 4'te ittifak ederse +12 puan
- **Sektor diversifikasyon**: Ayni sektordan max 2 pick
- **Persistence**: `bist_last_ai_picks` localStorage — confidenceBreakdown + scanTs + dataSource + avgVolumeTL + distFromMA20 dahil
- **Risk alerts**: Portfoy uzerinde stop yakinligi, oversized lot, konsantrasyon
- **Event**: Tarama bittiginde `advisor-scan-complete` CustomEvent dispatch edilir

### v21 Buy Guard'ları (buyPicks filtresinde hard reject)
- **Confirmed Bearish**: supertrend DOWN + ichimoku below + OBV distribution → ele
- **Active Distribution**: OBV dist + CMF < -0.08 + RSI > 50 + score < 60 → ele
- **Cift Bearish Divergence**: RSI bearish + OBV bearish → ele
- **Distribution Trap**: OBV dist + CMF < -0.05 + price up + score < 65 → ele
- **Exhaustion**: RSI > 72 + MFI > 70 + yukselis + score < 70 → ele
- **Weak Rally**: change > 2% + volRatio < 0.9 + OBV ≠ accumulation + score < 60 → ele
- **Tavan/Exhaustion**: `isUnsafeForTomorrow(r)` — gap-up >=12%, RSI>88, MFI>88, cum>=22% mutlak red; 7-12% icin `calcContinuationProbability` >= 38% gerekli

### Scan kayit alanlari (`results[i]`)
- Standart: symbol, sector, price, change, signal, cls, score, rr, stop, target, atrPct
- Ranking icin: `avgVolume`, `avgVolumeTL`, `distFromMA20`, `_scanTs`, `_dataSource`, `volRatio`
- Composite icin: `confidence`, `grade`, `tier`, `entryQuality`, `liquidityScore`, `confidenceBreakdown { technical, potential, sector, news, entry, liquidity, momentumHealth }`
- Signal Attribution: `firedSignals` — hangi teknik sinyaller ateslendigini kaydeder

## AIAdvisorDetailPanel (`src/components/AIAdvisor/AIAdvisorPanel.jsx` — v18)
- Ekranin alt kisminda sabit, collapsible horizontal kart strip
- `<AIAdvisorDetailPanel advisor={advisor} portfolio={...} onAnalyze={...} />` — App.jsx'e mount edilmis
- Default `open = true`; scan sonuclari veya localStorage fallback ile populate olur
- Grade badge: A=yesil, B=cyan, C=sari, D=turuncu (composite confidence'a gore)
- "OTOMATIK YEDEK" badge sari → 20dk ustu cache'de "⚠ ESKI VERI" kirmizi rozete donusur
- **Stale cache otomatik refresh**: 30dk uzeri cache + scanning yoksa otomatik `manualScan()` tetiklenir
- **Manuel ↻ TARA / YENILE butonu**: header'da; stale durumda kirmizi vurgulu
- **Per-pick veri yasi pill**: kart sag-ust kosesinde `5dk` / `1s` formatinda; >1s ise turuncu
- **Confluence breakdown tooltip**: kart hover'inda confidence kirilimi (teknik/potansiyel/sektor/haber/giris/likidite) + ortalama hacim TL + MA20 mesafesi + veri kaynagi
- Stop/target: `normalizeStopTarget(r)` ile max 1.8×ATR'a clamplanmis (gercekci gunluk seviyeler)
- Hooks rules-of-hooks uyumlu: useState/useEffect tum erken return'lerden ONCE cagriliyor

## Live Guard (`useLivePrices` — v11 tiered adaptive)
- **3 polling tier** (BIST'in public WS'i yok — adaptif polling ile WS'e en yakin tazelik):
  - **FAST 5s**: stop/hedefe %1.5'tan yakin pozisyonlar (burst mode)
  - **NORMAL 15s**: acik pozisyonlar
  - **SLOW 45s**: watchlist + non-positioned semboller
- **Page Visibility API**: tab gizliyken tum tier'lar duraklar
- **Batch quote**: `fetchBiquoteLatest` ilk denenir; eksikleri `fetchBigParaQuote` ile per-symbol fallback
- **Trailing**: TRAIL_BREAKEVEN_PCT=3, TRAIL_ACTIVE_PCT=5, TRAIL_LOCK_FRACTION=0.5
- **Otomatik emir**: Pozisyon stop/hedef'e ulastiginda `updatePortfolio` cagirir
- **Alarm dedup**: `firedAlarmsRef` Set ile ayni alarm tekrar atilmaz
- **Kaynak tag**: Uyarilar `source: 'live_guard' | 'watchlist'` olarak alertLog'a dispatch edilir
- **tierStats**: hook `{ fast, normal, slow }` semboll sayilarini state olarak return eder

## ML Sinyal Kalibrasyon (`signalCalibration.js` — v11)
- **Amac**: Son 500 kapali sinyalin gercek `winRate × expectancy` performansini kullanarak yeni sinyal skorunu kalibre etmek
- **Bucket'lar**: cls (buy/sell) × scoreBucket (q1-q4) en spesifik; cls, source, grade, overall fallback
- **Min sample**: bir bucket >= 8 kapali sinyal sahibiyse hesaba katilir; yoksa pas
- **Multiplier**: skor 50 etrafinda merkezlenir, multiplier ile olceklenir, [0.55, 1.30] araligina clamplanir
- **Skor formul**: `score = (winRate - 0.5) + tanh(expectancy/7) × 0.7` -> agirlikli avgDelta
- **Wiring**: `useSignalTracker` her closed signal degisiminde `buildCalibrationModel(signals)` cagirir, `setSignalCalibration(model)` ile signals.js modulu seviyesinde yayinlar
- **genSignal**: score100 hesaplanir hesaplanmaz `applyCalibrationToScore` cagrilir, |delta| >= 1 ise reasons'a `ML KALIBRASYON` notu eklenir
- **Output**: baseSig.calibration = `{ multiplier, avgDelta, breakdown[] }` UI'da gosterilebilir

## Borsa Haber Motoru (`marketNewsEngine.js` — v13)
- **Amac**: KAP haricinde borsaningundemi.com / bigpara / mynet / bloomberght / dunya / sabah RSS akislarini cekip sembol+kategori bazli sentiment cikar
- **Default kaynaklar**: `DEFAULT_NEWS_SOURCES` listesi (eklenip cikarilabilir, her kaynak `weight` carpani tasir)
- **Kategori siniflandirma** (Turkce regex):
  - `fund_inflow`: yabanci alimi, kurumsal alim, para girisi, fon akisi (+5)
  - `fundamental_rank`: en karli, cari oran, F/K, ROE siralamasi (+3)
  - `buyback`: pay/hisse geri alim programi (+6)
  - `insider_buy`: yonetici/iceriden alim, hakim ortak alimi (+7)
  - `dividend`: temettu, kar payi (+4)
  - `upgrade` / `downgrade`: hedef fiyat yukselt/dusur, AL/SAT tavsiyesi (+5/-5)
  - `contract`: sozlesme imzala, ihale kazandi, yeni siparis (+4)
  - `risk`: sorusturma, ceza, dava, haciz, iflas, konkordato, temerrut (-7)
  - `sector_bull`: sektor pozitif/rekor/yukselis (+2)
- **Sentiment**: kategoriler topla, recency carpani (1G ×1.5 / 3G ×1.2 / 7G ×1.0 / older ×0.5), [-10, +10] clamp
- **`extractSymbols(text, universe)`**: 4-6 buyuk harf ticker yakalar; universe yoksa BIST/KAP/TUFE/EURO blacklist'i uygular
- **`indexBySymbol(news)`**: sembol bazli aggregate (score, count, kategoriler, topItem, highImpact sayisi)
- **5 dk LRU cache** (200 max), tum cagrilar best-effort — RSS down ise atlar
- **Wiring**: `useAIAdvisor` scan tamamlandiktan sonra top 10 pick'in symbol universe'unde haber cekip her pick'e `newsScore`, `newsCount`, `newsCategories`, `newsHeadline`, `newsHighImpact` enjekte eder
- **Claude prompt**: `buildDailyPicksPrompt` her satira `HABER[kategori]=skor(count) "baslik"` ekler; system prompt kategori semantigini ve A/B/C notuna katkisini aciklar
- **Event**: `advisor-scan-complete` artik `newsIndex` da tasiyor (AlertLog/ChatPanel reaktif kullanabilir)
- **Test**: 17/17 — symbol extraction, kategori siniflandirma, sentiment clamping, recency, indexBySymbol aggregate

## Walk-Forward Backtest (`walkForward.js` — v12)
- **Amac**: Tek-period backtest yerine rolling IS/OOS pencereleri ile overfit tespiti
- **Pencere yapisi**: Default 4 pencere; her pencerede %70 in-sample / %30 out-of-sample ardisik
- **Per-window metrics**: isWinRate, oosWinRate, efficiency (OOS/IS return), degradation (|ΔwinRate|)
- **Summary**: medianOOSReturn, medianEfficiency, pctProfitableOOS, avgDegradation
- **Verdict**:
  - `stable`: medianEfficiency >= 0.5 AND >= %60 OOS-positive AND avgDegradation < 20pp
  - `overfit`: medianEfficiency < 0.2 OR < %40 OOS-positive OR avgDegradation > 35pp
  - `borderline`: arasi
- **Strateji karsilastirma**: `compareStrategiesWalkForward(prices, [signal,rsi,macd,ma])` —
  composite score = medianOOSReturn × pctProfitableOOS/100, en saglam stratejiyi `winner` doner
- **Test**: 9/9 — synthetic LCG fiyatlari ile pure noise/trend ayrimi dogrulanmis

## Markowitz Portfoy Optimizasyonu (`portfolioOptimizer.js` — v12)
- **Girdi**: `seriesByAsset` = { SYMBOL: number[] (close fiyatlari) }
- **Metodoloji**:
  1. Log-getiri matrisi (252 bar annualize)
  2. Annualized expected return vector + covariance matrix
  3. Dirichlet(α=1) random search 6000 portfoy ornegi
  4. maxWeight cap iterative water-filling ile (clip → uncapped'lere overflow dagit)
  5. RF=%25 (TCMB benchmark) → Sharpe = (μ-rf)/σ
- **Cikti**:
  - `maxSharpe` portfoy: en yuksek risk-adjusted return
  - `minVariance` portfoy: en dusuk volatilite
  - `targetReturn` portfoy: opsiyonel hedef getiriye en yakin
  - `frontier`: 60 sample efficient frontier visualization icin
- **Diversification**: effectiveN (1/Herfindahl), maxWeight, evenness
- **`weightsToAllocations(w, syms, capital)`**: TL bazli pozisyon onerisi
- **`correlationMatrix(series)`**: UI heatmap icin korelasyon matrisi
- **Test**: 13/13 — single-asset trivial, weight cap, minVar < maxSharpe variance, target nearest

## Gerçek Portföy (`RealPortfolioTab` — v31.2)
Terminalin "Portföy" sekmesi **sanal** paper hesaptır; bu sekme **gerçek** çok-piyasalı
(ABD + BIST) pozisyonları takip eder. Ayrı bir Python CLI projesinden (`models.py` /
`calculations.py` / `alerts.py`) porte edildi.
- **`realPortfolio.js`** (saf, 17 test): `normalizePositions` (Python `portfolio.json`
  şeklini — snake_case `avg_cost` dahil — kabul eder), `positionMetrics`, `summarizeGroup`
  (fiyatı çekilemeyen pozisyon toplamlara GİRMEZ, `missingTickers`'da raporlanır),
  `allocationPct`, `biggestWinner/Loser`, `checkAlerts` (varsayılan -%10 / +%20, ticker
  bazlı override), `portfolioTotals` (USD bacağını USD/TRY ile çevirip birleşik TRY toplamı;
  kur yoksa `usConversionMissing` ile dürüstçe hariç tutar).
- **`useRealPortfolio.js`**: BIST fiyatları **önce `fetchBigParaBatchPrices` (batch)**, eksikler
  için `fetchBigParaQuote` fallback (per-symbol endpoint kırılgan — testte KCHOL'ü sessizce
  düşürdü). ABD fiyatları `fetchYahooSeries` ile (ham sembol; `fetchEngine`'in Yahoo
  yardımcıları `.IS` hardcode ettiği için kullanılamaz). USD/TRY `getMacroContext().usdtry`.
- **Otomatik seed**: ilk açılışta (localStorage boşken) `src/data/realPortfolio.local.json`
  varsa otomatik yüklenir → güncellemeden sonra elle yapıştırma gerekmez. Dosya
  **gitignore'lu** (kişisel finansal veri); şablonu `realPortfolio.example.json`. Yükleme
  `import.meta.glob` ile yapılır → dosya yoksa `{}` döner, build/CI kırılmaz.
- **Gizlilik**: pozisyonlar YALNIZCA yerel — `localStorage` (`bist_real_portfolio`) +
  gitignore'lu seed dosyası. Depoya asla girmez. UI'dan JSON ile de düzenlenebilir
  (Python `portfolio.json` içeriği doğrudan yapıştırılabilir).
- Finnhub anahtarı gerekmez (ABD fiyatları Yahoo'dan).

## AlertLog
- `useAlertLog(advisor)` hook'u ALARM verilerini toplar (source: live_guard / watchlist /
  advisor / signal_tracker / manual). Uyarılar bu hook üzerinden akar.
- **NOT (v31 temizlik):** Floating `AlertLog.jsx` bileşeni App.jsx'e import ediliyordu ama HİÇ
  render edilmiyordu (ölü kod) — kaldırıldı. Hook duruyor.

## Veri Cekme Motoru (v14)
- **Self-hosted Vercel Proxy** (ONCELIKLI): `proxy/api/proxy.js`, 10 domain whitelist
- **Public CORS proxies** (fallback): AllOrigins/get + corsproxy.io + AllOrigins/raw
- **Kaynak sirasi**: Self-proxy → Yahoo v8 (crumb auth) → Yahoo v7 → Is Yatirim → BigPara
- **DEVRE DISI**: Foreks (`web-paragaranti-pubsub.foreks.com`) — domain tamamen down, SOURCE 4 kaldirildi
- **fetchData()**: 3 retry (normal, cache temizle+500ms, farkli range); L2 stale fallback (dataConfidence='low')
- **Cache**: scan mode 60s / analysis mode 2-5dk; L2 localStorage kalici
- **applyLiveOverlay**: Batch cache oncelikli (120s TTL), per-symbol fallback; cache hit non-blocking
- **Circuit breaker recovery**: `fetchData` girisinde suresi dolmus backoff'lari resetler (single analysis priority)
- **Backtest**: ASLA yeniden veri cekmez — G_data kullanir

### Yahoo Crumb Authentication
- `ensureYahooCrumb()`: `fc.yahoo.com` → A3 cookie alir; `/v1/test/getcrumb` → crumb token; 55 dk cache
- `fetchYahooDirect(symbol, range, interval, ms)`: crumb+auth → v8-nocrumb → v7 → proxy zinciri

### Circuit Breaker — Gercek Exponansiyel Backoff
- `_recordFailure` kumulatif birikim ile ustel artis: 3 hata → 60s, 4 → 120s, 5 → 240s
- `_recordSuccess` failures = 0 yapar (recovery sonrasi taze baslangic)

### Race Fetch — Promise.any
- `getDataViaProxies(targetUrl, ms)` — 3 public CORS proxy AYNI ANDA fire ediliyor
- Ilk basarili (non-empty) response kazanir; RACE_PER_REQUEST_MS = 7000ms, RACE_CEILING_MS = 7500ms

## Proxy Server (`proxy/`)
- **Vercel Serverless**: `proxy/api/proxy.js`, `vercel.json`
- **Route**: `/api/proxy?source=yahoo|bigpara|isyatirim|...&symbol=...`
- **Whitelist**: 10 domain (Yahoo, BigPara, IsYatirim, KAP, TCMB, vb.) — Foreks whitelist'te ama dead
- **Cache**: `s-maxage=120, stale-while-revalidate=600` edge cache
- **Claude endpoint**: `/api/claude` — Anthropic API'ye x-api-key ile proxy; `anthropic-beta` header'ini upstream'e pass etmeli
- **Deploy**: `cd proxy && vercel --prod`
- **Regions**: fra1, ams1

## Electron (Desktop)
- **Main**: `electron/main.cjs`, preload: `electron/preload.cjs`
- **Window**: 1440x960 (workAreaSize'in %92'si), backgroundColor #0a0e17
- **webPreferences**: contextIsolation=true, nodeIntegration=false, webSecurity=false
- **Dev modu**: `process.argv.includes('--dev')` veya `NODE_ENV=development`
- **Safety net**: 4 saniyede `ready-to-show` fire etmezse pencere force show + devtools acar

### Bildirim Turleri
- Sinyal bildirimleri (skor >= 6.5)
- AI Advisor firsatlari (skor >= 7.5)
- Stop-loss / Hedef bildirimleri
- Intraday firsatlari
- Header'daki 🔔 butonundan yonetim (aktif/pasif, sessiz mod, min skor, tur secimi)

## Bilinen Sorunlar
1. CORS proxy rate limit — 100+ hisse taramasinda bazi istekler basarisiz (self-proxy ile minimize)
2. Veri 15-30 dk gecikmeli (ucretsiz API kisitlamasi)
3. Yahoo crumb auth browser ortaminda CORS kisitiyla dogrudan calismiyor; Electron/Vite dev proxy'si uzerinden `fetchYahooDirect` tetiklenir

## ML Forward Test Paper Trading Engine (2026-05)

### Mimari
- **DB Schema v4**: `paper_portfolio` (singleton) + `paper_trades` tabloları `DatabaseManager.js`'e eklendi
- **PaperTradeEngine.js** (`src/utils/`): SQLite-backed forward testing motoru
  - TOP 3 ML-scored picks: `mlConfidenceBoost > 0 && mlMatchedCount > 0`
  - 33% max capital allocation per trade
  - Strict -3% stop-loss (entry × 0.97)
  - Singleton pattern: `getPaperTradeEngine()` ile erişim
  - Electron IPC bridge: `electronAPI.paperDb.*` (8 handler)
  - localStorage fallback (web/dev mode)
- **usePaperTradeML.js** (`src/hooks/`): React hook wrapper
  - `advisor-scan-complete` CustomEvent'ini dinler → auto-trade
  - 30s fiyat monitoring → stop/target otomatik kapanış
  - Auto-trade toggle localStorage persistent

### UI (PaperTradingPanel.jsx — dual engine)
- **Engine selector tabs**: ML Forward Test (gold) | Standard Paper Trading (purple)
- **ML Forward Test**: Dashboard + open positions (ML badge, rule info) + trade history (ML Boost kolonu)
- **ML Buckets**: HIGH/MEDIUM/LOW/NONE ML confidence gruplarında win rate kırılımı
- **Standard**: Mevcut usePaperTrading hook'u aynen korundu (equity curve, settings, streak)

### IPC Handlers (preload.cjs)
```javascript
electronAPI.paperDb.getPortfolio()
electronAPI.paperDb.openTrade(trade)
electronAPI.paperDb.closeTrade(id, price, reason)
electronAPI.paperDb.getOpenTrades()
electronAPI.paperDb.getClosedTrades(limit)
electronAPI.paperDb.getStats()    // includes mlBuckets win rate by ML tier
electronAPI.paperDb.reset()
```

### Trade Akışı
1. AI Advisor scan tamamlanır → `advisor-scan-complete` event
2. `usePaperTradeML` hook event'i yakalar → `engine.processScanResults(picks)`
3. Engine picks'i filtreler: `cls='buy' && mlConfidenceBoost > 0 && mlMatchedCount > 0`
4. TOP 3 ML boost sırasıyla seçilir, her biri max %33 capital alır
5. Stop = entry × 0.97, target = pick.target (genSignal'dan)
6. Her 30s BigPara batch fiyat kontrolü → stop/target hit → otomatik kapanış
7. Kapanış SQLite'a yazılır: pnl_tl, pnl_pct, held_ms, exit_reason, conviction_tier, entry_regime
8. **Canlı-edge (v29.5)**: kapalı trade'ler `computeLiveEdge` ile conviction_tier × regime bazında segmentlenir → PaperTradingPanel'deki CANLI EDGE matrisi her kombinasyonun gerçek win-rate/expectancy'sini gösterir (bkz. "Canlı Edge Truth Layer")

## DB Schema v5 — Conviction Tier (2026-07)

### Yeni kolon
| Tablo | Kolon | Amaç |
|---|---|---|
| `paper_trades` | `conviction_tier TEXT` | sniper/flagged/early — canlı-edge segmentasyon anahtarı (win-rate/expectancy per conviction × regime) |

- `DB_VERSION = 5`; migration `from < 5`: `ALTER TABLE paper_trades ADD COLUMN conviction_tier TEXT`
- `openPaperTrade` payload'a `conviction_tier` yazar; `getClosedPaperTrades` (`SELECT *`) round-trip'te döner
- `entry_regime` (v4'ten beri) + `conviction_tier` birlikte canlı-edge'in iki eksenini oluşturur

> **NOT — kaldırılan "v5 feedback loop" (2026-07):** Bu bölüm eskiden paper trade
> outcome'larını `discovered_rules`'a geri besleyen bir döngüyü (`applyTradeFeedback`,
> `paper_win_count`/`paper_loss_count`, `paper_trades.rule_hash`, `paper:applyTradeFeedback`
> IPC, 🔄 LIVE rozeti) "sevk edildi" diye anlatıyordu. **Bu döngü hiçbir zaman
> kurulmadı** — DB kolonları, fonksiyon ve IPC yoktu; sadece okuma tarafı (useAIAdvisor
> `paperWinCount` okumaları + AIAdvisorPanel 🔄 LIVE rozeti) dead code olarak duruyordu ve
> rozet hep 0 örnek döndüğü için asla görünmüyordu. Dead code temizlendi. Paper-trade
> "gerçeğin kaynağı" ihtiyacı artık **Canlı Edge Truth Layer** ile gösterim seviyesinde
> karşılanıyor (skorlamaya geri beslenmiyor — measure-first: küçük canlı örnek skorları
> çarpıtmasın).

## Canlı Edge Truth Layer — `liveEdge.js` (v29.5, 2026-07)

Backtest "olması gereken"i söyler; bu katman "gerçekte olan"ı. Kapalı paper-trade'leri
advisor'ın pick'leri bucketladığı gibi (convictionTier × regime) segmentler.

- **`computeLiveEdge(closedTrades, { limit })`** (pure, test edilmiş): kapanışları
  `sniper/flagged/early` × `BULL/NEUTRAL/BEAR` hücrelerine böler → her hücre için win-rate,
  expectancy, profit-factor, `reliable` (>= `MIN_SAMPLE`=8 örnek). `overall` + `byTier` +
  `byRegime` roll-up'ları da döner. Son 120 kapanış penceresi (recency).
- **`getLiveEdgeStat(edge, tier, regime)`**: bir hücreyi SADECE güvenilirse (>=8 örnek) döner,
  yoksa `null` — küçük örnek yalan söyler.
- **PaperTradeEngine**: her trade'e `convictionTier` yazar; `_buildSnapshot` `liveEdge`'i expose eder.
- **PaperTradingPanel**: CANLI EDGE matrisi (tier satır × rejim sütun); beklentiye göre
  yeşil/sarı/kırmızı, <8 örnekte soluk, ilk kapanıştan önce boş-durum.
- **Salt-okunur**: henüz skorlamaya bağlı değil. Kovalar birikince `getLiveEdgeStat` hazır.
- **Test**: `liveEdge.test.js` — 13 senaryo (segmentasyon, snake/camel alan, recency limit,
  reliability eşiği, defensive null).

## Walk-Forward Optimizer (`ml_forward_tester.py` — 2026-05)

Standalone Python CLI; React UI'a hiç dokunmaz. Offline research surface — overfit kuralları yakalamak için.

### Mimari
- **`WalkForwardEngine`** sınıfı (root-level dosya): rolling IS/OOS pencereleri ile parametre-stabilitesi testi
- **Veri**: `bist_bridge.BistBridge.fetch_ohlcv(symbol, timeframe=...)` — yeni v5 DEFAULT_TIMEFRAME='2Y' + 5Y→2Y truncation fallback'ten faydalanır
- **Saf pandas/numpy**: TA-Lib gerekmez; ADX Wilder smoothing + swing-high/low rolling `.shift(1)` ile causal
- **Lookahead-safe**: pozisyon bar `t`'de karar, `t+1` return (`pos.shift(1)`)

### Stratejiler (`STRATEGIES` tablosu)
| Strateji | Giriş | Çıkış | Grid |
|---|---|---|---|
| `smc` | `close > rolling_swing_high(lookback)` + `confirm_bars` ardışık teyit | `close < rolling_swing_low(lookback)` | `swing_lookback ∈ {5,8,12,16,20}` × `confirm_bars ∈ {1,2,3}` = 15 |
| `adx` | `adx > threshold && (di+ − di−) > di_diff` | `di+ < di−` | `adx_threshold ∈ {15,20,25,30}` × `di_diff ∈ {1,3,5,8}` = 16 |

### Pipeline (per window)
1. IS slice (default 12M): grid-search → max profit-factor parametre seti (tiebreak: profit %)
2. OOS slice (default 3M): seçili parametreleri uygula, metrikleri hesapla
3. Pencereyi `oos_months` kadar kaydır, bitene kadar tekrarla

### Metrikler
- **Walk-Forward Efficiency (WFE)** = `ΣOOS_profit / ΣIS_profit`
  - `>= 0.5` robust, `< 0.2` overfit, arası borderline
- **Worst OOS Drawdown** — tüm forward pencerelerin en kötü DD'si
- **Avg OOS Profit Factor** — `(sum_wins / |sum_losses|)` pencere ortalaması
- **Avg OOS Win Rate** + **%profitable OOS** pencere oranı
- **Verdict**: `stable` (WFE≥0.5 + PF≥1.2 + %prof≥60), `overfit` (WFE<0.2 OR PF<0.9 OR %prof<40), arası `borderline`

### CLI
```bash
python ml_forward_tester.py --symbol THYAO
python ml_forward_tester.py --symbol GARAN --strategy adx
python ml_forward_tester.py --symbol AKBNK --timeframe 5Y    # bridge fallback'i tetikler
python ml_forward_tester.py --symbols THYAO,GARAN,SISE --quiet --out reports/wf.json
python ml_forward_tester.py --symbol THYAO --is-months 18 --oos-months 6
```
Output: pencere tablosu + summary + verdict; `--out` JSON dump; `--quiet` tek-satır verdict.

## bist_bridge.py — Timeframe API (v5, 2026-05)

### Sabitler (module-level)
```python
TIMEFRAME_DAYS = { "1M":30, "3M":90, "6M":180, "1Y":365, "2Y":730, "5Y":1825 }
TIMEFRAME_EXPECTED_CANDLES = { ..., "5Y": 1260 }  # ~252 sessions/yr
COMPLETENESS_RATIO = 0.80                           # < 80% expected → truncated
DEFAULT_TIMEFRAME = "2Y"                            # snappy cold boot
FALLBACK_TIMEFRAME = "2Y"                           # 5Y truncation rescue
```

### `fetch_ohlcv(symbol, lookback_days=None, timeframe=None)` davranışı
- `lookback_days` verilirse → bu sayıyı kullan (back-compat)
- Sadece `timeframe` verilirse → `TIMEFRAME_DAYS[label]` (örn. 5Y=1825 gün)
- Hiçbiri verilmezse → `DEFAULT_TIMEFRAME = "2Y"` (mevcut callers `fetch_ohlcv(symbol)` → 2Y alır)
- **5Y truncation guard**: dönen candle sayısı < %80 × 1260 ise log warning + `FALLBACK_TIMEFRAME` (2Y) ile yeniden çekim
- Log mesajı (kullanıcı kontratı): `"5Y Data Truncated - Falling back to stable 2Y window (symbol=X got=Y expected>=Z)"`
- Yeni private helper `_fetch_ohlcv_window(symbol, lookback_days)`: MCP→borsapy zinciri tek noktada; fallback path aynı zinciri reuse eder

## Graphify — Code Knowledge Graph (2026-05)

### Kurulum
- `uv tool install graphifyy` (`v0.5.0` runtime adı, exe: `graphify.exe`)
- `graphify claude install` → CLAUDE.md'ye section + `.claude/settings.json` PreToolUse Glob|Grep hook
- `graphify update .` → 177 file indexed → `graphify-out/{graph.json, graph.html, GRAPH_REPORT.md}`

### Hook'lar (`.claude/hooks/`)
- **`block_search_tools.py`** (PreToolUse:Bash): grep/find/rg/ag/fd komutlarını yakalar:
  - Önce `graphify query <term>` çalıştırır
  - Sonuç varsa: grep'i BLOKLAR, graphify çıktısını additionalContext olarak inject eder
  - Sonuç yoksa: grep'e fallback olarak izin verir (legitimate fallback note ile)
- **`subagent_graphify_context.py`** (SubagentStart): subagent'lara mandatory graphify-first kuralını enjekte eder

### Token tasarrufu (benchmark)
- Naive corpus: ~240k tokens
- Graphify query: ~15.9k tokens average → **15.1× reduction**
- Cross-module relation query'leri: **38×**
- Graph: 3640 nodes / 8924 edges / 110 communities

### Kullanım disiplini
- "Where is X / what uses Y / how does Z connect" — önce `graphify query`, sonra grep
- `graphify path <a> <b>` — iki node arası shortest path
- `graphify explain <node>` — bir node + komşuları plain-language
- Hook otomatik fallback'i yönetir; bilinçli grep gerekirse hook izin verir

## Rejim Kalite Tabani (v31.4) — "gevsettik, sonra dengeledik"

v29.2'de olcume dayali sert kapi vardi (DUSUS'te AL yok, YATAY'da sadece score>=75).
v30.x'te kullanici istegiyle **gevsetildi** (her rejimde 8 AL goster + uyari rozeti).
Sonuc: YATAY'da panel, olcumun kaybettigini soyledigi sub-65 "early" kademeyi 8 pick
olarak sunmaya basladi (**YATAY -%1,68 / WR %26** — 4 denemeden 3'u kayip).

v31.4 orta yol (kullanici karari):
- `regimeGate.COUNTER_REGIME_MIN_SCORE = 65` — BULL disinda sadece flagged+sniper AL gecer.
- `applyRegimeGate` neutralMaxBuys 8 → **4** (BEAR 3 olarak kaldi); 5. arg ile taban ayarlanabilir.
- `displayPicks.COUNTER_REGIME_BUY_TARGET = 4` + filler'lara ayni skor tabani —
  **kritik**: sadece gate'i sikmak yetmiyordu, panel filler'i listeyi 8'e geri sisiriyordu
  (sub-65 arka kapi). Bos-topPicks fallback dali da ayni tabana tabi.
- BULL'da hicbir sey degismedi (olcum orada pozitif: +%1,14 / WR %59,5).
- Dogrulama: YATAY simulasyonu — 23 AL'lik taramada panel 8 (cogu score 52) yerine
  **3 (hepsi score 72)** gosteriyor, zayif sizinti yok, hepsi ⚠ uyarili.

## Rejim Gevsetme + Garantili Gunluk Pick (v31.5) — "her gun bir tane"

Kullanici geri bildirimi: v31.4 tabani (65) YATAY/DUSUS'te paneli **neredeyse bos**
biraktu — "cok siki, ne kaybediyorum ne kazaniyorum; her gun BIST'ten bir aday
mutlaka gormeliyim (piyasa acilinca hareket edecek pre-pump coil, patlamis isim degil)".

Iki degisiklik:
- **Dengeli gevsetme**: `COUNTER_REGIME_MIN_SCORE` 65 → **58** (ust "early" bandi gecer,
  hepsi hala `_counterRegime` uyarili); `applyRegimeGate` neutralMaxBuys 4 → **6**,
  bearMaxBuys 3 → **4**; `displayPicks.COUNTER_REGIME_BUY_TARGET` 4 → **6**. BULL yine serbest.
- **`ensureBestOfDay(gatedPicks, candidates, regime)`** (saf, `regimeGate.js`, test edilmis):
  rejim kapisi TUM AL'leri sustursa bile, `results` havuzundan **en iyi pre-pump adayini**
  garanti eder → panel asla bos kalmaz. Secim: `_earlyPick` (erken birikim/coil) once,
  sonra sinyal gucu/score. **Zaten patlamis isim DEGIL** — filtre: recentPump<7,
  cumulativePump<15, RSI<=78, MFI<=82 (FOMO/tavan kovalamiyor). Tag: `_bestOfDay`
  (⭐ GUNUN EN IYISI rozeti) + rejim disiysa `_counterRegime` (⚠). SADECE gatelenmis
  listede sifir AL kaldiginda tetiklenir — gercek bir gated liste varsa dokunmaz.
- Wiring: `useAIAdvisor` TEK CIKIS KAPISI'nda (finalPicks, dispatch oncesi, satir ~2957)
  `applyRegimeGate`'ten hemen sonra cagrilir; `stampSegKeys` convictionTier'i sonra basar.
- UI: `AIAdvisorPanel` altin ⭐ rozet + tooltip; `MobilePicksStrip` chip'te ⭐ prefix.
- Dogrulama: `regimeGate.test.js` +7 (ensureBestOfDay: injection, early-oncelik, pump/
  overbought disi, no-op-if-buy-exists, BULL tag yok, bos-havuz defansif); tum suite 402 pass.

**Dürüst not degismedi**: garantili pick de rejim uyarisini tasir; olcum YATAY/DUSUS'te
negatif. Bu ozellik "her gun gorunurluk" saglar, edge yaratmaz — kullanici karariyle kucuk
pozisyon/siki stop onerilir.

## "YARIN UMUT" Hayal-Katmani Kaldirildi (v31.6) — kalite > miktar

Kullanici: "Yarina umut olanlari gosterme altta; gercekten umutluysak/yapacaksak goster."
Hedef: `⚡ YARIN UMUT` rozetli aspirasyonel filler tier'i (panel'i tomorrowPotential-agirlikli
"yarin +%4-5" isimleriyle N'e sisiren padding). Iki kaynak vardi, ikisi de kaldirildi:
- **Backend** `useAIAdvisor` "ACIL YEDEK" bloğu (`if (picks.length < 5)` → picks'i 5'e
  sisiren 2-tier emergency padder, `_emergencyPick: true`) — TAMAMEN silindi (~115 satir).
- **Display** `deriveDisplayPicks` topPicks-dali filler'i (scanResults'tan buyTarget'a kadar
  doldurup `_emergencyPick` etiketleyen blok) — silindi.
- **UI**: `AIAdvisorPanel` "YARIN UMUT" bandi + `⚡ YARIN UMUT` rozeti kaldirildi.
- **Yeni davranis**: panel yalniz GERCEK pickleri gosterir (rejim kapisindan gecen score>=58
  adaylar) + gerekiyorsa TEK garantili `⭐ GUNUN EN IYISI` (ensureBestOfDay, v31.5).
  "Hicbir zaman hep-SAT" garantisi artik display filler'da degil, UPSTREAM'de
  (ensureBestOfDay dispatch oncesi gercek bir AL enjekte eder). Miktar kaliteyi takip eder:
  2 gercek AL → 2 gosterilir, 6'ya sisirilmez.
- `_emergencyPick` alani tamamen olu → kaldirildi; persist'e `_bestOfDay` eklendi.
- Test: displayPicks filler testleri "padding yok" olarak yeniden yazildi; suite 402 pass.

## Tekil Analiz — "25 Yillik Uzman" Makro Zenginlestirmesi (v31.7)

Kullanici: "Hisse analiz sekmesini 25 yillik finans uzmani gibi yap — petrol, dunya
gelismeleri, guncel haberler, hisseyi etkileyecek her sey." Sorun: `buildExpertPrompt`
MAKRO katmani (`claude.js`) sadece XU100/USDTRY/sentiment tasiyordu; `getMacroContext`
(Brent/altin/gumus/bakir/dogalgaz/bugday/VIX/S&P500/TCMB) ve `thematicMacro` zaten VARDI
ama tekil-analiz promptuna HIC baglanmamisti (yalniz advisor taramasinda kullaniliyordu).
Ayrica tekil-analiz promptunda hisse-ozel HABER yoktu.

- **`buildExpertPrompt` MAKRO katmani yeniden yazildi**: `_renderMacroBlock(macro, fmt)`
  ile Kur/Faiz (USDTRY 5g + vol, TCMB + PPK gun sayaci), Kuresel risk (VIX+sinif, S&P500 5g,
  BIST/USD 20g), Emtia (Brent/Altin/Gumus/Bakir/Dogalgaz/Bugday 5g), Makro rejim + nedenler.
  Makro yoksa "web aramayla teyit et" notu (graceful).
- **Hisse-ozel tematik ruzgar satiri**: `computeThematicAdjust(macro, symbol)` → "MAKRO TEMA
  (TUPRS): Brent yukseliyor → rafineri lehine +6". Petrol artinca TUPRS, altin KOZAL vb.
  artik tekil-analizde acikca gorunur.
- **Guncel haber satiri**: `fetchSymbolMarketNews(symbol)` → kategori+skor+manset.
- **Persona**: "25 yillik BIST + kuresel piyasa stratejisti; hisseyi tek basina okuma —
  petrol/emtia, dunya borsalari, kur/faiz, jeopolitik, guncel haber hisseye etkisiyle tart."
- **Cevap formatina `[MAKRO_ETKI]`** eklendi: petrol/emtia+dunya+kur+haber bu hisseyi BUGUN
  nasil etkiliyor (somut).
- **Wiring** (`ChatPanel.handleExpertCall`): askExpert oncesi `getMacroContext` + thematic +
  news best-effort cekilir (feed down ise null'a duser, analiz kirilmaz); `market.macro` +
  `analysis.thematic/news` olarak gecirilir. `webSearch: true` zaten acikti (guncel teyit).
- Test: `expertPrompt.test.js` 7 senaryo (persona, makro blok, graceful fallback, tematik,
  haber, [MAKRO_ETKI], undefined sizmasi yok); suite 409 pass.

## Tarama Pipeline Kalite Yükseltmeleri (v31.8–v31.11)

Advisor tarama+analiz yolunun denetimi sonrası 4 somut zayıflık kapatıldı (grounded, satır-referanslı):

- **v31.8 — Haber SEÇİME giriyor**: Haber eskiden `picks.slice(0,10)`'dan SONRA çekiliyordu →
  #15'teki kataliz hisse asla top-10'a çıkamıyordu. Artık `picks.sort` ÖNCESİ tüm aday havuzuna
  haber çekilip (RSS aynı akışları universe boyutundan bağımsız çektiği için ~bedava) kataliz-ağırlıklı
  confidence deltası uygulanıyor (insider/buyback/fund_inflow/contract +5, upgrade +3, risk -8,
  ±15 clamp; sell için ters). `newsIndex` hoist edildi, enrichment [1] artık no-op fallback.
- **v31.9 — 1y pencere + Relatif Güç**: `fetchSingle` 6mo→**1y** (hem hisse hem XU100) →
  MA200 (~252 bar gerekiyordu, 6 ayda hep null'dı) + 60g RS ufku çalışıyor. Yeni saf
  `relativeStrength.js` (`computeRelativeStrength`, 9 test): 20g/60g hisse getirisini XU100'e
  kıyaslar → [-8,+8] `rsScore` composite'e girer (lider prim / geride kalan ceza; sell ters).
  UI: `🚀 LİDER / 🐢 GERİDE` rozeti. Not: 1y payload taramayı ~2× yavaşlatır (masaüstünde kabul).
- **v31.10 — Temel kalite kapısı**: Saf `fundamentalQualityGate` (`fundamentalEngine.js`, 8 test).
  HARD-REJECT: D/Ö>5, cari<0.4, net marj<-25%. SOFT-CEZA: D/Ö>2, cari<0.8, net zarar, kar düşüyor
  (max 15). SADECE veri VARSA aksiyon (eksik veri cezalandırılmaz; KCHOL cari ~0.86 asla elenmez).
  Performans: 612'ye değil, `picks.sort` öncesi en yüksek ~18 buy adayına fetch (6s timeout,
  best-effort). reject→listeden çıkar; UI `⚠ TEMEL -N` rozeti.
- **v31.11 — Sektöre-duyarlı makro**: Düz `macroCtx.scoreAdjust` her pick'e eşit uygulanıyordu.
  Saf `computeSectorMacroAdjust(macro, sector)` (`thematicMacro.js`, 8 test): (1) küresel risk
  (VIX+S&P) × sektör risk-betası — risk-off'ta döngüsel (Holding/Otomotiv/Havayolu) baskı, defansif
  (Telekom/Gıda) dayanıklı; (2) yüksek faiz (TCMB≥40) → GYO/İnşaat baskı, Banka/Sigorta lehine.
  [-6,+6] clamp, `enhancePick` composite'ine `sectorMacroAdj` olarak girer + `confidenceBreakdown.sectorMacro`.
  Hisse-özel tematik (petrol/altın/FX) katmanıyla ÇAKIŞMAZ (bu sektör düzeyi).

**Denetimde kalan 1 madde**: Yabancı akış (ücretsiz TR kaynağı yok — bilinen sınır, `foreignFlow:0`).
**Dürüst not**: bu 4 yükseltme ölçülen pick KALİTESİNİ hedefler; getiri garantisi yok. Harici veri
(makro futures/RSS/temel) in-app tarayıcıda CORS ile yüklenmez ama masaüstü/Electron'da yüklenir —
hepsi feed yoksa graceful null'a düşer, analiz kırılmaz. Suite 434 pass, 0 lint error.

## DÜŞÜŞ'te "İZLE · ALIM DEĞİL" — sermaye koruma (v31.13)

Kullanıcı geri bildirimi: "son 1 haftadaki önerdiğin hisseler hepsi ekside." Gerçek-veri
teşhisi (canlı XU100): piyasa **DÜŞÜŞ (BEAR)** rejiminde (-%2,7 5g / -%4,1 20g / MA20 -%3,3).
Ölçüm: DÜŞÜŞ'te AL beklentisi **-%3,36 / %18,8 WR** → düşen piyasada long'ların kaybetmesi
bug değil, ÖLÇÜMÜN öngördüğü sonuç. Kötüleştiren: bu oturumda `ensureBestOfDay` (v31.5)
DÜŞÜŞ'te bile GARANTİLİ günlük long üretiyor, tüm koruma kapılarını bypass ederek — düşüş
haftasında günlük garantili kaybeden. Profit Governor (measure-first) DEFENSE için ~20-30
kayıtlı sonuç ister → ilk kötü haftada koruyamıyor.

Düzeltme (görünürlük korunur, sermaye korunur):
- `applyRegimeGate` + `ensureBestOfDay`: **BEAR** rejiminde AL'lar `_watchOnly: true` etiketlenir
  — panelde GÖRÜNÜR ama "tradeable buy" değil. UI: `👁 İZLE · ALIM DEĞİL` (kırmızı) rozeti +
  tooltip (ölçüm negatif, bugün yeni uzun önerilmez). Mobil chip'te `👁` prefix.
- `PaperTradeEngine.processScanResults`: `_watchOnly` pick'ler auto-trade'e GİRMEZ.
- SAT'lar aktif kalır (düşüşte anlamlı). YATAY/YÜKSELİŞ değişmedi (YATAY zaten `_counterRegime`
  uyarılı; YÜKSELİŞ serbest — ölçüm orada pozitif).
- Test: `regimeGate.test.js` +2 (BEAR buys `_watchOnly`, guaranteed pick `_watchOnly`); suite 436 pass.

**Dürüst not**: hiçbir meşru sistem düşen piyasada long giderek istikrarlı kazanamaz. Sistemin
gerçek edge'i rejime bağımlı (sadece YÜKSELİŞ + yüksek skor pozitif). Bu değişiklik kaybı
"düzeltmez" — DÜŞÜŞ'te sistemi kaybettiren long önermekten alıkoyar (nakit/izleme = en iyi "işlem").

## Gün-Gün Takip + Mobil Kalıcılık + Uyarı Sadeleştirme (v31.14)

Kullanıcı 1 haftalık gözlem sonrası 3 geri bildirim verdi ("fena değiliz ama..."):
- **Çok uyarılı**: `_watchOnly` (👁 İZLE) zaten güçlü uyarıyken `_counterRegime` (⚠ REJİME KARŞI)
  da gösteriliyordu → çift uyarı gürültüsü. `AIAdvisorPanel`: `_counterRegime` rozeti
  `!p._watchOnly` iken gösterilir (BEAR'da tek net uyarı kalır). Gate GEVŞETİLMEDİ — BEAR
  koruması (v31.13) geçen hafta işe yaradı; sadece görsel gürültü azaltıldı.
- **Mobilde veriler tutulmuyor**: Kayıt YALNIZ canlı `advisor-scan-complete`'te oluyordu;
  mobilde uygulama tarama saatlerinde (09:55/18:15) açık olmadığından hiçbir şey birikmiyordu.
  `App.jsx` **açılış-tohumlama** efekti: mount'ta `bist_last_ai_picks`'ten BUGÜN taranmış
  (`_scanTs`) + bugün henüz kayıtlı olmayan picks'i Sinyal Takibi'ne bir kez kaydeder
  (advisor kaynağı dedup yapmadığı için gün-bazlı guard bayat/çift kaydı önler).
- **Gün-gün arttı/azaldı kaydı**: Saf `signalPerfHistory.js` (`appendDailyPerf`/`summarizeDailyPerf`,
  9 test). `useSignalTracker.checkSignals` her 10dk'da aktif sinyalin o günkü giriş-göreli
  (yön düzeltmeli) getirisini `dailyPerf[]`'e işler (aynı gün nokta güncellenir, yeni günde
  eklenir, 30 gün cap). `SignalsTab`'a **GÜN-GÜN** kolonu + `DailySpark` mini-bar sparkline.
  d1/d3/d5/d7 checkpoint'leri korundu; bu onların üstüne per-gün seri ekler.

**Sınır (dürüst)**: mobil kalıcılık, uygulama açık olduğunda çalışır — arka planda sunucu yok,
gün-gün nokta ancak uygulama açıkken yakalanır. Açılış-tohumlama en azından her açılışta o
günün picks'ini kaydeder. Suite 443 pass, 0 lint error.

## YATAY biraz açıldı — uyarılı ama tradeable AL (v31.15)

Kullanıcı: "YATAY'ı biraz aç, uyarılı ama izle-değil-AL göster." Rejim-özel taban getirildi:
- `regimeGate.NEUTRAL_MIN_SCORE = 54` (yeni) — YATAY tabanı DÜŞÜŞ'ten (58) daha açık.
- `applyRegimeGate`: `neutralMaxBuys` 6 → **8**; taban artık rejim-özel (açık geçilmezse
  YATAY 54, DÜŞÜŞ 58). YATAY AL'ları `_counterRegime` (⚠ REJİME KARŞI) uyarılı ama
  `_watchOnly` DEĞİL → tradeable AL. DÜŞÜŞ aynen korundu (58 + watch-only, v31.13).
- `displayPicks.COUNTER_REGIME_BUY_TARGET` 6 → **8** (boş-topPicks dalı tutarlılığı).
- Test: `regimeGate.test.js` NEUTRAL cap 8/floor 54 + BEAR<NEUTRAL taban ayrımı; suite 444 pass.

**Dürüst not**: YATAY ölçümü hâlâ negatif (-%1,68) — bu değişiklik daha fazla aday GÖSTERİR
(kullanıcı isteği), edge yaratmaz; hepsi ⚠ uyarılı, küçük pozisyon/sıkı stop önerilir.

## Canlı-Edge Kalibrasyonu Aktifleştirildi (v31.16)

Döngü v31.1'de bağlıydı ama DORMANT: yalnız `getPaperTradeEngine().closedTrades`'i okuyordu
→ ML-AUTO açık + top-3 trade'lerin kapanması gerekiyordu, veri neredeyse hiç birikmiyordu.
Aktifleştirme: döngüyü **sinyal-takip kapanışlarıyla** da besle — sinyal tracker HER tarama
pick'ini (~8-10/tarama) kaydeder ve `checkSignals` outcome'larını (perf.d5 / status) doldurur;
aynı `convictionTier × regime` kanıtı çok daha hızlı birikir.

- **`signalsToLiveEdgeTrades(signals)`** (saf, `liveEdge.js`, +5 test): kapalı (veya 5-gün
  settled) BUY sinyallerini live-edge trade şekline map eder (`pnlPct`=perf.d5, `regime`,
  `convictionTier` — yoksa score'dan türetilir). `computeLiveEdge` snake/camel okuduğu için uyumlu.
- **`App.jsx recordAdvisorPick`**: artık `convictionTier` (yoksa score'dan) + `regime` (`_regime`
  öncelikli) kaydeder → sinyaller segmentlenebilir.
- **`useAIAdvisor`**: kalibrasyon modeli iki kaynağın BİRLEŞİMİnden (`paperClosed` + `sigClosed`)
  hesaplanır (limit 200). Hücre GÜVENİLİR (>=8) ise confidence, hücrenin gerçek expectancy'sine
  göre ±%15 ölçeklenir; UI'da `📊 %WR` rozeti + `_liveEdge` persist.
- **`MIN_SAMPLE = 8` KORUNDU** — küçük örnek yalan söyler; measure-first bozulmadı.
- Doğrulama (önizleme, gerçek modül): 8 kapalı sniper×BULL sinyali → hücre reliable (n=8,
  WR %75, expectancy +1.75) → kalibrasyon çarpanı ×1.0525. Suite 449 pass, 0 lint error.

**Dürüst not**: bu döngü ölçülen expectancy'yi skorlamaya besler — pozitif hücreyi yukarı,
negatifi aşağı çeker. Getiri garantisi değil; sistem kendi gerçek sonuçlarından öğrenir.

## Mobilde Sinyal Takibi: günde-bir-kez populate (v31.17)

Kullanıcı: "mobilde sinyal takibi çalışmalı." Kök neden: mobil sürekli-tarama YALNIZ ML AUTO
açıkken kosuyordu (`useAIAdvisor` mobil efekti); ML AUTO kapalıyken mobilde hiç tarama
olmuyor → hiç pick kaydedilmiyor → Sinyal Takibi boş. v31.14 açılış-tohumlaması yalnız BUGÜN
taranmış cache picks'i kaydeder, ama tarama hiç kosmadıysa kaydedecek bir şey yok.

Düzeltme: **ML AUTO'dan BAĞIMSIZ günde-bir-kez populate**. Mobil efektin `tick()`'i, uygulama
görünürken + hafta içi + saat >= 09:55 (İstanbul) + o gün henüz taranmadıysa (`bist_last_scan_day`)
BİR kez `runScan` tetikler → o günün pickleri Sinyal Takibi'ne kaydedilir. `bist_last_scan_day`
damgası SADECE başarılı dispatch'te yazılır (başarısız tarama günü bloklamaz; populate tekrar
dener). ML AUTO sürekli-tarama dalı aynen korundu. Damga tüm scan yollarını kapsar (09:55/18:15
oto-tarama + ML AUTO + manuel), o yüzden çift tetikleme olmaz.

**Sınır (dürüst)**: hâlâ istemci-taraflı — populate ancak uygulama açıkken çalışır (arka planda
sunucu yok). Ama artık mobilde uygulamayı bir kez açmak (piyasa saatinde) o günü kaydeder;
gün-gün perf (v31.14) ve d1/d5 checkpoint'leri uygulama açık kaldıkça dolar. Not: bu populate
DESKTOP'ta da geçerli (geç açılışta o günü kaydeder) — günde bir ağır tarama, cache (v31.12) hafifletir.

## DÜRÜST BEKLENTİ (tekrar) — "günlük/haftalık kazandırmalı"
Ölçülen edge rejime bağımlı: **sadece YÜKSELİŞ + yüksek skor pozitif** (YATAY -%1,68, DÜŞÜŞ
-%3,36). Hiçbir sistem düşen/yatay piyasada long ile istikrarlı günlük/haftalık kazandıramaz.
Sistem artık (v31.16) kendi sonuçlarından kalibre oluyor + Sinyal Takibi (v31.14/v31.17) günlük/
haftalık getiriyi ŞEFFAF gösteriyor — ama getiri GARANTİSİ vaat edilmez, edilemez.

## Son Yapilanlar (2026-07 — v31)

> **DÜRÜST BEKLENTİ NOTU:** Sistemin edge'i rejime bağımlıdır — ölçüm: sadece YUKSELIS + score≥75
> AL sinyalleri pozitif beklentili (YATAY/DUSUS negatif). Hiçbir meşru sistematik strateji günlük
> +%2-3 net kârı istikrarlı VEREMEZ. Bu sürüm getiri vaat etmez; ölçülen expectancy'yi maksimize
> etmeyi + riski gerçekçi yönetmeyi hedefler. Canlı-edge birikince skorlamayı otomatik kalibre eder.

- [x] **Gerçekçi Monte Carlo (hibrit, v31)** — `monteCarlo.js` + `monteCarloWorker.js`:
  - Sabit-vol + normal GBM yerine: analiz edilen hissenin gerçek log-getirilerinin **moving-block
    bootstrap**'ı (fat-tail + çarpıklık + kısa-menzil otokorelasyon ampirik korunur; <20 getiri →
    Gaussian fallback). Paylaşılan `_mcCore` sync + worker'ı besler (model asla sapmaz).
  - **Sinyal-güdümlü drift eğimi** (opts.driftBias ±0.01/gün) — güçlü AL ile SAT artık aynı drift
    şeklini üretmiyor. **BIST ±%10 günlük limit** her adımda clamp. **Stop/hedef yol-sonlandırma**
    → pStopFirst/pTargetFirst/pNoExit/expectedExitPct/avgHoldDays. **Maliyet-farkında profitProbNet**
    (TOTAL_COST_PCT) + interpolasyonlu percentile. `AnalyzeTab` off-thread `runMonteCarloAsync` (5-10k yol).
  - Test: 11 (bootstrap/gaussian, ±%10 clamp, stop/hedef partisyon, cost-adj, drift yönü).
- [x] **Canlı-edge döngü kapanışı + entry-timing lever (v31.1)**:
  - **A1**: `useAIAdvisor` tarama başında paper engine kapalı trade'lerinden `computeLiveEdge` hesaplar;
    convictionTier atandıktan sonra `getLiveEdgeStat(edge, tier, regime)` ile confidence'ı gerçek
    expectancy'ye göre ±%15 ölçekler. Güvenilir hücre (≥8 örnek) yoksa no-op (bugünkü davranış).
    📊 %WR rozeti + `_liveEdge` persist. Veri birikince ("⚡ ML AUTO") otomatik aktifleşir. Bkz.
    [[scan-complete-event-critical]] / Canlı Edge Truth Layer.
  - **A2**: `_scoreEntryTiming` (MA20/RSI/BB/sessiz-çekilme) hesaplanıp UI'da gösteriliyordu ama
    skora girmiyordu → `enhancePick` entryQuality'sine harmanlandı (%60 pump/MA20 + %40 timing).
- [x] **Kapsamlı ölü-kod temizliği (v31)** — gerçekten ölü olanlar kaldırıldı:
  - top10 keşif kümesi (7 dosya + test — hiçbir tüketicisi yoktu; canlı ML yolu `ML_BacktestEngine`+
    `DatabaseManager` IPC), `AlertLog.jsx` + `ScanHistoryDrawer.jsx` (import edilip render edilmeyen),
    `borsajsAdapter.js` (+ fetchEngine ölü import'ları), root scratch script'ler, useSignalTracker
    yorumlu DISABLED bloğu, çeşitli ölü top-level import.
  - **KORUNDU (ölü DEĞİL):** `walkForward.js` (`scripts/tune-thresholds.mjs` kullanıyor + 9 test),
    `portfolioOptimizer.js` Markowitz yüzeyi (tested; `correlationCapFilter` app'te kullanılıyor) —
    körüne silme yerine dürüst mühendislik: tested offline araçlar durur.
  - ESLint warning 121 → 84; ratchet `--max-warnings 140` → 90.

## Son Yapilanlar (2026-05)
- [x] **Walk-Forward Optimizer (Python)** — `ml_forward_tester.py` root-level CLI:
  - `WalkForwardEngine` sınıfı: rolling 12M IS / 3M OOS pencereleri, IS'de grid-search → max-PF parametre seçimi, OOS'da seçili setle teyit
  - 2 strateji: **SMC** (`swing_lookback × confirm_bars` BOS+structure stop), **ADX** (`adx_threshold × di_diff` trend takip)
  - Saf pandas+numpy implementasyon (no TA-Lib gerekmiyor); ADX Wilder smoothing + swing-high/low `.shift(1)` ile causal
  - Metrikler: **WFE** (ΣOOS_profit/ΣIS_profit; >0.5 robust, <0.2 overfit), worst OOS DD, avg PF, win-rate, %profitable OOS
  - Verdict: `stable` / `borderline` / `overfit` (3 eşik kombinasyonu)
  - Lookahead-safe: pozisyon t'de karar verir, t+1'de return; swing struct shift(1)
  - **`bist_bridge.fetch_ohlcv(symbol, timeframe='5Y')` reuse** — yeni 5Y→2Y truncation fallback'ten faydalanır
  - CLI: `--symbol`, `--symbols`, `--strategy {smc,adx}`, `--is-months`, `--oos-months`, `--timeframe {1M,3M,6M,1Y,2Y,5Y}`, `--out <json>`, `--quiet`
- [x] **Canlı Edge Truth Layer (v29.5)** — paper-trade sonuçları conviction × regime bazında:
  - **`liveEdge.js`** (pure, test edilmiş): `computeLiveEdge(closedTrades, {limit})` kapanışları
    `sniper/flagged/early` × `BULL/NEUTRAL/BEAR` hücrelerine böler → win-rate/expectancy/PF/reliability
  - **DB Schema v5**: `paper_trades.conviction_tier` kolonu + migration (segmentasyon anahtarı)
  - `PaperTradeEngine`: her trade'e `convictionTier` yazar; snapshot `liveEdge` (son 120 kapanış) expose eder
  - `PaperTradingPanel`: CANLI EDGE matrisi (tier × rejim), yeşil/sarı/kırmızı, <8 örnekte soluk
  - Salt-okunur (skorlamaya bağlı değil — measure-first)
  - **Test**: `liveEdge.test.js` 13 senaryo → tüm suite 350/350 pass
- [x] **Dead "v5 feedback loop" temizliği (v29.6+)** — CLAUDE.md'de "sevk edildi" diye anlatılan
  ama hiç kurulmamış paper→rule geri besleme döngüsünün dead reading-side kodu kaldırıldı:
  `useAIAdvisor`'daki `paperWinCount`/`paperLossCount`/`mlBestRuleHash` okumaları + `AIAdvisorPanel`
  🔄 LIVE rozeti (hep 0 örnek → asla görünmüyordu). Karar: build yerine sil (measure-first);
  canlı paper-truth ihtiyacı Canlı Edge katmanıyla gösterim seviyesinde karşılanıyor.
- [x] **`bist_bridge.py` v5 — 5Y Truncation Fallback**:
  - **TIMEFRAME_DAYS** + **TIMEFRAME_EXPECTED_CANDLES** sabitleri (`1M`/`3M`/`6M`/`1Y`/`2Y`/`5Y`); 252 sessions/yr baz
  - `COMPLETENESS_RATIO = 0.80` — 5Y request <%80 expected candles → truncated sayılır
  - **`DEFAULT_TIMEFRAME = "2Y"`** (cold-boot snappy; 5Y opt-in)
  - **FALLBACK_TIMEFRAME = "2Y"** — known-stable rescue window
  - `fetch_ohlcv(symbol, lookback_days=None, timeframe=None)`: yeni opsiyonel `timeframe` parametresi; 5Y truncated ise log warning `"5Y Data Truncated - Falling back to stable 2Y window"` + 2Y'ye yeniden çekim
  - `_fetch_ohlcv_window` private helper: tek MCP-then-borsapy attempt; fallback path aynı zinciri reuse eder (no behavior drift)
  - Geriye uyumlu: `fetch_ohlcv(symbol, lookback_days=N)` çağrıları aynı şekilde çalışır
- [x] **Graphify Code-Knowledge-Graph (Claude Skill)** — proje genelinde token tasarrufu:
  - `graphifyy v0.5.0` (uv tool) — graph.json + GRAPH_REPORT.md + community wiki üretir
  - `graphify claude install`: CLAUDE.md'ye graphify section + `.claude/settings.json` PreToolUse hook
  - **Hook'lar** (gist'ten install edildi, oyilmaztekin/e4bfb7d...):
    - `.claude/hooks/block_search_tools.py` — PreToolUse:Bash: grep/find/rg/ag/fd algılarsa otomatik `graphify query` çalıştırır, sonuç varsa grep'i bloklayıp inject eder; yoksa fallback'e izin verir
    - `.claude/hooks/subagent_graphify_context.py` — SubagentStart: subagent'lara graphify-first kuralını enjekte eder
  - Benchmark: **15.1× ortalama token reduction** (240k naive → ~15.9k per query); cross-module relation query'lerde **38×**
  - Graph: 3640 nodes / 8924 edges / 110 communities (177 indexed files)
- [x] **ML Forward Test Paper Trading Engine** — SQLite-backed forward testing:
  - DB Schema v4: `paper_portfolio` + `paper_trades` tabloları
  - `PaperTradeEngine.js`: TOP 3 ML-scored, 33% alloc, -3% stop
  - `usePaperTradeML.js`: React hook, auto-trade, 30s price monitoring
  - Dual engine UI: ML Forward Test (gold) + Standard (purple) tab selector
  - IPC bridge: 8 handler (preload + main process)
  - ML performance buckets: HIGH/MEDIUM/LOW/NONE win rate kırılımı
- [x] **Autonomous Continuous Learning (CRON) Pipeline** — Haftalık otomatik yeniden eğitim:
  - **DB Schema v3**: `discovered_rules` tablosuna `created_at`, `last_seen_date`, `regime_tags` kolonları eklendi
  - **Weighted Merge UPSERT**: Yeni eğitim verisi eskiyi SİLMEZ — ağırlıklı ortalama ile birleştirir:
    `mergedWinRate = (oldWins + newWins) / (oldTotal + newTotal)`
    Eski rejim bilgisi korunur (piyasa rejimleri döngüseldir — 2021 boğa kuralları 2024'te yeniden çıkar)
  - **6 Ay Decay**: 6+ aydır görülmeyen kuralların sample count'u 0.85× decay ile azalır
  - **CRON Scheduler**: Her Cuma 20:00 (TR saati, BIST kapanışından sonra) otomatik tetiklenir
  - **Background Worker**: `electron/ml-training-worker.cjs` — `child_process.fork()` ile UI donmaz
  - **IPC Progress**: Worker → Main → Renderer zincirisinde 4 fazlı ilerleme bildirimi
  - **Desktop Notification**: "🧠 Otonom Öğrenme Tamamlandı: X kural hafızaya eklendi"
  - **Manuel Tetik**: `window.electronAPI.mlTraining.start()` ile renderer'dan da başlatılabilir
  - **Training DB Auto-Import**: `data/bist_ml_training.db` + `data/bist_ml_training_3yr.db` otomatik keşif
- [x] **ML Badge Visibility Fix** — 4 bug düzeltmesi ile ML rozetleri artık görünür:
  - DB path mismatch: Training scripts farklı dosya/dizine yazıyordu → auto-import bridge eklendi
  - Badge condition: `mlConfidenceBoost > 0` → `mlMatchedCount > 0` (zero-expectancy kurallar da gösterilir)
  - Minimum boost floor: Eşleşen kural varsa en az +1 confidence boost garantisi
  - Fallback path: scanResults→displayPicks mapping'e ML alanları eklendi
  - `getTopRules` relaxed fallback: min=10 bulamazsa min=3 ile tekrar dener
- [x] **ALTERNATİF LİSTE UI Kaldırıldı** — Panel'den warning fallback rozetleri temizlendi:
  - `isWarningFallback` / `warningPickCount` değişkenleri kaldırıldı
  - `⚠ ALTERNATİF LİSTE` banner JSX kaldırıldı
  - `⚠ DİKKAT` per-card badge kaldırıldı
  - `_fallback` tooltip satırı kaldırıldı
- [x] **ML Engine → Live Frontend Wiring** — SQLite self-learning engine canlı taramaya bağlandı:
  - `useAIAdvisor.js`: Tarama sonrası `scoreNewSignal()` ile her pick ML kurallarına karşı test edilir
  - `electronAPI.mlDb.getTopRules(50, 10)` ile en iyi 50 kural yüklenir (min 10 örnekli)
  - Her pick'e `mlConfidenceBoost`, `mlBestRule`, `mlMatchedCount` eklenir
  - ML boost composite confidence'a eklenir, grade/tier yeniden hesaplanır
  - `AIAdvisorPanel.jsx`: ML rozeti (🎯 %WR), gold/cyan/purple renk; setup adı + win rate satırı
  - Tooltip: kural adı, win rate, ortalama ROI, konfluens sayısı
  - `ML_BacktestEngine.js`: `_COL_ALIASES` ile scan→DB kolon eşleşme hataları düzeltildi
  - `DatabaseManager.js`: TLA kaldırıldı → lazy async `_ensureNodeRequire()` (Vite browser uyumu)
  - `localStorage` persistence: mlConfidenceBoost, mlBestRule, mlMatchedCount persist edilir
  - Graceful degradation: Electron yoksa, DB eğitilmemişse, kural yoksa sessizce atlanır
- [x] **v24 Filter Pipeline Overhaul** — ALTERNATİF LİSTE her gün çıkma sorunu kökten çözüldü:
  - **genSignal ZAYIF AL tier**: score>=57 + volRatio>0.8 + 3+ type + smart money → cls='buy'
    (önceki: score>=65 + volRatio>1.1 + 4+ type → BIST'in %85'i hold kalıyordu)
  - **R/R Quality Gate yumuşatıldı**: rr<0.5 → hold (önceki: rr<1.0 → hold = çift ceza)
  - **atrPct eşiği**: 1.2 → 0.8 (blue-chip THYAO/SISE/ASELS 1.0-1.2 arasıydı)
  - **TUT score eşiği**: buyPicks 52→45, fallback 48→42, afterHours 48→45
  - **afterHours filtre**: score + (RR veya trend veya smartMoney) = kabul; score>=55 tek başına yeterli
  - **lastResort quality tier genişletildi**: score>=45 + pozitif teknik sinyal; momentum tier de warning değil
  - **_warningPick**: quality + early + momentum üçü de OK → ALTERNATİF LİSTE sadece hiçbir tier'a girmeyenler
- [x] **v23 Filter Rebalancing** (önceki iterasyon):
  - Distribution Trap: `CMF<-0.05` → `CMF<-0.12 && change>1%` (sadece NET dagilim)
  - Weak Rally: `volRatio<0.9 + OBV!='accumulation'` → `volRatio<0.6 + OBV='distribution'`
  - Insider buy/score afterHours filtrelerinde ek kabul kriteri oldu
- [x] **Insider Trading Engine** — `insiderEngine.js` (654 satir): KAP JSON+HTML+title 3 kaynak;
  role detection (CEO 2x, board 2x); -10/+10 skor; 10dk LRU cache; batch concurrency=5
- [x] **fetchEngine 6x Optimizasyon** — Electron IPC bridge, L2 stale fix, parallel retries,
  hedge delay 1500→800ms, batch cache pre-warm, circuit breaker recovery
- [x] **MultiTimeframe parallel** — sequential for-of → Promise.all (4x hiz)

## Son Yapilanlar (2026-04)
- [x] JARVIS v8 / Alpha Engine 7 katmanli prompt, hafiza sistemi, auto-reading, cross-system context
- [x] Setup Grade A/B/C/D + contrarian protokol
- [x] Monte Carlo v2 — log-return GBM, Box-Muller, 500 senaryo; Web Worker ile UI 60fps
- [x] Fundamental Engine — 15+ metrik, A+ ile D arasi grade, Yahoo + KAP harmanlama
- [x] useSignalTracker — 1G/3G/5G performans + 0-100 reliability skoru
- [x] useAIAdvisor v15 — sell sinyalleri, composite confidence, sektor diversifikasyon, localStorage persistence
- [x] AIAdvisorDetailPanel — alt collapsible kart strip, grade badge, normalizeStopTarget, App.jsx mount
- [x] useLivePrices — BigPara 30s polling, trailing stop otomatik yonetimi
- [x] AlertLog + 24s Ozet paneli
- [x] Vercel proxy /api/claude + 10 domain whitelist (KAP dahil)
- [x] Electron safety net — 4s timeout ile zorla pencere gosterme, renderer hata loglama
- [x] Yahoo Finance crumb auth (fc.yahoo.com → getcrumb, 55dk cache) + fetchYahooDirect fallback zinciri
- [x] Stop/target hassasiyeti: recentLow/swingLow structure stop, maxRisk rejim-aware, T1 weighted cap@1.30, Fib T3; normalizeStopTarget max 1.8×ATR
- [x] Pump-continuation assessment: hard zero yok, 6 continuation signal kontrol, -5/-18/-30 ceza
- [x] fetchEngine circuit-breaker: kumulatif failure sayaci ile gercek exponansiyel backoff (3→60s, 4→120s, 5→240s)
- [x] Foreks SOURCE 4 devre disi — web-paragaranti-pubsub.foreks.com ENOTFOUND
- [x] setFetchTimestamp import hatasi duzeltildi — fetchBigParaList crash'i giderildi
- [x] proxyEngine.js getDataViaProxies — non-object options guard eklendi
- [x] **v18 Pre-Pump Coil Detection** — `calcTomorrowPotential` +25 explicit bonus
  (isCoiling = pump<=2 + cumPump<=5 + OBV accumulation + CMF>0.05); `detectEarlyAccumulation`
  artik TUM hisselere uygulanir, ranking bonus 8→14
- [x] **v18 Forming-Bar Hijyeni** — `_isForming` flag (live overlay'de gercek OHLC sarti),
  `calcAll`/`genSignal` forming barlari strip ediyor, chart hollow body + dashed wick + 0.45
  opacity ile ciziyor
- [x] **v18 Structural Health Guard** — Confirmed Bear / Active Distribution / Cift Bearish
  Divergence kombinasyonlari hard filter; taban yeme riski minimize edildi
- [x] **v18 AI Picks Panel parlatildi** — animated shimmer header (cyan-purple gradient),
  gradient text title, top-3 medal pill (gold/silver/bronze), glassmorphism backdrop,
  card hover translateY + glow shadow, top-3 inset halo
- [x] **v19 Wall Street Strict Filter** — `todayPumpReal` BigPara live'a dayanan ground truth;
  `isUnsafeForTomorrow(r, opts)` tek nokta tavan/exhaustion kapisi (gap-up >=12 ASLA, tavan
  >=9 sadece kuvvetli kataliz+4 teknik, 7-9% score>=60+2 teknik, cum>=18 haber yok ise red,
  RSI>88 ASLA); `calcContinuationProbability` 5-55% tavan devam tahmini; `_qualityRank`
  4-tier lastResort hierarchy (early=100, quality=80, momentum=60); top-3 garanti — non-pump
  picks daima onde, tavan picks (>=7%) en sona
- [x] **v19 Forming-Bar L2 Cache Lifecycle Fix** — `_isForming` flag L2 hydrate/persist'te
  strip, `applyLiveOverlay` duplicate guard (ayni gun forming bar update), `chartDraw.js`
  forming sadece son bar
- [x] **v19 isFromCache Logic** — `lastUpdate === null` ile birlikte `displayPicks` derive,
  scan complete sonrasi DAIMA fresh data (eski localStorage devirilir), `_warningPick`
  tum picks'te ise "ALTERNATIF LISTE" rozeti
- [x] **v19 Empty State** — kaliteli setup yoksa stale cache yerine bos state gosterimi:
  "Bugun kaliteli AL setup'i bulunamadi — sistem BUGUN tavan yapanlari degil YARIN tavan
  yapacaklari ariyor"
- [x] **v19 Borsa MCP Backtest Lab** — `borsa_bot_backtest/` standalone Python CLI: `single`/
  `sweep`/`wf`/`feedback`/`registry` komutlari; 4-fazli Optuna feedback loop
  (300 explore + 200 exploit + walk-forward filter + cross-symbol robustness); strict registry
  gate (ret>=8%, |DD|<=25%, sharpe>=0.6, PF>=1.4, trades>=12, WF stable, cross>=55%);
  SQLite-persistent study (resumable); model_registry JSON

## Production Hardening (2026-04 — v9)

### XSS Korumasi — DOMPurify
- `src/utils/sanitize.js` tum harici veri akislari icin tek giris noktasi
- `renderSafeMarkdown(text)`: Claude AI yanitlari icin; escape → mini markdown (bold/italic/br) → DOMPurify tarama
- `sanitizeHTML(dirty)`: News RSS / KAP HTML govdeleri icin; beyaz liste: b/strong/i/em/u/br/p/ul/ol/li/code/pre/span/a
- `sanitizeText(dirty)`: baslik/ozet alanlari icin TUM tag'leri siler
- ChatPanel.jsx artik AI yanitini `renderSafeMarkdown` ile render ediyor
- Dependency: `dompurify ^3.1.6`

### Claude Prompt Caching
- `callClaude` → `system` alanini array olarak gonderiyor: `[{ text: dynamic }, { text: SMC_RULEBOOK, cache_control: { type: 'ephemeral' } }]`
- `SMC_RULEBOOK` sabit: BOS/OB/FVG kurallari + 7-katmanli agirliklandirma + Contrarian + A/B/C/D grade
- Header: `anthropic-beta: prompt-caching-2024-07-31`
- `analyzeKAPList` cache KAPALI (kisa JSON ciktisi)
- Not: `/api/claude` Vercel handler'i `anthropic-beta` header'ini upstream'e pass etmeli

## Kodlama Kurallari
- Turkce degisken/fonksiyon isimleri KULLANMA — ingilizce yaz
- Turkcede ozel karakter (s,i,o,u,c,g) JS string icerisinde sorun yaratabilir — dikkatli ol
- HTML icinde Turkce metin kullanilabilir ama JS stringlerinde apostrof (') escape edilmeli
- Backtest ASLA ek veri cekmemeli — G_data (zaten cekilmis) kullanmali
- Yeni komponent yazarken mevcut `trade-box fi` stilini ve CSS degiskenlerini (--bg2, --t1, --cyan) kullan
- localStorage key'leri `bist_` prefix'i ile baslasin (bist_signal_history, bist_jarvis_memory, vb.)

## Test & CI Pipeline (2026-04 — v10)

### JS Test Coverage — 84.43% genel (esik gate: 40%)
- `vitest.config.js` — jsdom ortami + `@vitest/coverage-v8` provider
- Per-file thresholds: lines / functions / branches / statements hepsi >= 40%
- **187 gecen test / 15 dosya:**
  - `indicators.test.js` — MA/EMA/RSI/MACD/Bollinger/ATR/ADX/Wyckoff/StochRSI/calcAll — **%97.56**
  - `backtestEngine.test.js` — runBacktest kontrat + stats + drawdown + streak — **%100**
  - `signals.test.js` — calcPosition sizing + genSignal shape + grade multiplier + reliability hints
  - `signals.detectors.test.js` (v20 yeni) — detectBreakout / detectChartPattern / detectMomentumShift /
    detectSmartMoney / detectHolyGrail / detectSetups / getUnifiedAnalysis kontrat testleri (25 test)
  - signals.js toplam: %65 → **%77.19** (+12pp)
  - `SMC_Logic_Engine.test.js` — BOS bull/bear + FVG + mitigation — %56
  - `fundamentalEngine.test.js` — margins / ROE / ROA / grade / KAP aliases / trend — **%86.86**
  - `sanitize.test.js` — XSS hardening (script strip, event-handler strip, markdown escape) — **%94**
  - `monteCarlo.test.js` — percentile ordering + profit prob + vol caps — %81
  - `errorLogger.test.js` — dedupe window + silent flag + safeAsync/safeSync — **%97.53**
  - `walkForward.test.js` / `portfolioOptimizer.test.js` / `marketNewsEngine.test.js` /
    `signalCalibration.test.js` / `fetchEngine.test.js`
- Coverage raporu HTML: `coverage/index.html`

### GitHub Actions CI — `.github/workflows/ci.yml`
- **4 paralel job + gate:**
  1. `test-js` — npm ci + lint + vitest --coverage + junit.xml + PR'da coverage tablosu
  2. `build-web` — `npm run build` (Vite production smoke test, dist/ artifact)
  3. `test-python` — `pytest tests/` (borsapy best-effort install, MCP mocklanir)
  4. `ci-gate` — tum job'lar yesilse yesil (branch protection icin required)
- Node 20 + Python 3.11; Tetikleyiciler: push + PR (main / master / develop)

### Borsa MCP → TradingAgents Koprusu — `bist_bridge.py`
- `BistBridge` — `mcp.ClientSession` icin async context manager; `saidsurucu/borsa-mcp` server'i ile konusur
- MCP tool surface: `get_hisse_historical` / `get_hisse_finansal` / `get_kap_disclosures` / `get_hisse_bilgi` / `list_hisse_by_sector`
- `FundamentalsContext` dataclass: `to_agent_payload()` → TradingAgents `FundamentalsAnalyst` contract
- `feed_fundamentals_analyst(symbol, analyst=...)` — `.analyze()` (async) veya `.run()` (sync/async) route eden adapter
- `stream_universe(symbols, concurrency=4)` — BIST100 batch icin async generator
- Test seam: `session_factory` constructor param → FakeMCPSession CI'da offline calisir
- **`tests/test_bist_bridge.py` — 13 pytest case**

### Bilinen Takipler
- signals.js %55 — 1070 satirlik dosya; setup detectorlerinin ayri test dosyasina cekilmesi planli
- SMC %54 — OrderBlock + LiquiditySweep helpers icin targeted test yok
- Python CI'da borsapy best-effort; gercek integration `uvx saidsurucu-borsa-mcp` runner gerektirir

### ESLint Gate (v29.8, 2026-07) — GERCEK kapi
- ESLint 9 flat config (`eslint.config.js`); `npm run lint` = `eslint src --max-warnings 140`
  (herhangi bir error VEYA 140 ustu warning → exit 1). `|| true` no-op KALDIRILDI. `npm run lint:fix` mevcut.
- Kural felsefesi: bug'lar error (rules-of-hooks, no-undef, no-const-assign, no-dupe-keys,
  no-unreachable), stilistik gurultu kapali; unused-vars + exhaustive-deps warning.
- Dual browser+Node `DatabaseManager.js` → node globals; test dosyalari → Vitest globals.
- Su an: **0 error / 121 warning** (warning'ler cogunlukla god-file unused var; ratchet 140).
- Kurulumda 17 latent bug yakalandi+duzeltildi — en kritigi: `useAIAdvisor` scan-complete
  dispatch'inde `newsIndex` undeclared idi (blok-local `ni`) → ReferenceError outer catch'e
  dusup `advisor-scan-complete` event'i muhtemelen HIC dispatch olmuyordu (paper-trade
  auto-trade + AlertLog dinleyicileri sessizce bos kaliyordu).

## Intraday Engine — v2 (2026-04)

### IntradayEngine.js — Yetenekler
- **`computeORB(bars, orbMinutes=30)`**: BIST acilis 09:30'dan itibaren ORB high/low hesaplar. `breakoutUp`, `nearBreakoutUp`, `rangePct` doner
- **`computeRS(stockBars, marketBars)`**: Bugunun hisse % degisimi / BIST100 % degisimi → `leading`, `lagging`, `strongLeader`, `outperformance`
- **`intradayMomentumScore(bars15m, vwap)`**: 15dk RSI + MACD + VWAP pozisyonu + trend + hacim ivmesi → 0-100 kompozit skor
- **`volumeRate(bars15m, avgDailyVol)`**: Bugunun hacim birikimi / beklenen hacim pace → `rate`, `onPace`, `surge`
- **`calcIntradayStructureLevels(bars15m, vwap, orb)`**: 15dk structure low/high + VWAP bantlari + ORB seviyelerinden stop/target/rr
- **`classifyIntradayPlay(intradayData, dailyData)`**: `momentum | orb_breakout | vwap_reclaim | dip_bounce | squeeze | none`

### TradesTab.jsx
- **5 fazli tarama**: Market context → Daily scan → Pre-score top 16 → 15m fetch (paralel) → Full scoring
- **Intraday veri**: Her aday icin `fetchSingle(sym, '5d', '15m')` — VWAP, ORB, RS, hacim hizi
- **Play tipi filtreleme**: Tum | Momentum | ORB | VWAP | Squeeze sekmeleri
- **Session-aware stratejiler**: Acilis/Sabah/Ogle/Ogleden sonra/Kapanis icin farkli strateji notlari
- **applyLiveOverlay fix**: Sadece 1d/1wk intervalda tetiklenir — 15m barlari bozmaz

## Stop / Target Hassasiyeti (signals.js — v14)

### Stop-Loss Zinciri
1. `chandelierStop` = highest_high(22) - 3*ATR (varsa en guvenilir)
2. `structureStop` = min(son 3 bar low) * 0.997 (recent structure)
3. `swingStop` = min(son 10 bar low) * 0.993 (swing low)
4. `srStop` = support * 0.993 (destek seviyesi)
5. `atrStop` = entry - 1.8*ATR (son fallback)
- `maxRisk` rejim-aware: trend → 0.94, volatile (atr/p > 3%) → 0.90, normal → 0.92
- Tavan kurali: `stop > entry * 0.985` → zorla `entry * 0.985`
- `normalizeStopTarget(r)`: stop max entry * (1 - 1.8×ATR/entry), gercekci gunluk seviye

### T1 Hedef Agirlikli Secim
- Adaylar: direnc (w=4), ATR×2.8/2.0 (w=2), Fib0.618/1.0/1.272 (w=2/3/1), pivot (w=2/1), minRR floor (w=1)
- Filtreler: entry * 1.30 tavan, min %2, max %15
- T2: Fib 1.618 tercihli; T3: Fib 2.0 tercihli; gap: 1.05x carpani

## Pre-Pump Coil Detection (useAIAdvisor — v18, 2026-04)

### Sorun
v17'de TAVAN GUARD eklendi ama sistem hala patlamadan ONCE yakalayamiyordu — OZATD gibi
bir hisse +%10 yaptiktan SONRA ust siralarda gozukuyordu. Erken birikim tespiti yalnizca
500K-2M TL ILLIKIT hisseler icin calisiyordu, likit 2M+ TL hisselerde hic tetiklenmiyordu.

### Cozum
1. `detectEarlyAccumulation` ARTIK TUM HISSELERE uygulanir — likit/illikit fark etmez
2. `calcTomorrowPotential` icine explicit **PRE-PUMP COIL** bonusu eklendi:
   ```
   isCoiling = recentPump <= 2 + cumulativePump <= 5 + OBV accumulation + CMF > 0.05
     → +25 baz bonus
     → +10 (TTM Squeeze aktifse)
     → +8  (ATR% < 3, dar bant)
   ```
3. **Stealth volume buildup** sinyali: `recentPump <= 3 + volRatio 1.3-2.0 + OBV
   accumulation` → +12 (akilli para sessizce giriyor)
4. Erken pick ranking bonusu **8 → 14** (afterHours), **6 → 12** (intraday); pre-pump
   adaylar artik tavan hisselerin ONUNE gecer
5. Cardlarda altin/gumus/bronz medal pill (top-3), animated shimmer header, glassmorphism
   efekti, top-3 cardlarda renkli halo

### Beklenen Davranis
Yatay konsolidasyon + OBV birikim + TTM squeeze + dusuk pump kombinasyonu olan hisseler
artik +%50-60 tomorrow potential alir, top-3'e girer ve pre-pump rozetiyle gosterilir.
TAVAN bolgesi (recentPump >= 9) hisseler `buyPicks` filtresinde direkt elenir (haber +
3 teknik teyit + MFI<65 disindaki tum durumlar bloklanir).

## Forming-Bar Hijyeni (fetchEngine + useAIAdvisor — v18)

### Sorun
`applyLiveOverlay` BigPara quote yeni gun donduruyorsa otomatik bar appendliyor — fakat:
- Borsa acilmadan once BigPara bazen hatali quote (H=L=close) donderiyor → sifir-range
  mum olusuyor → ATR/Bollinger hesaplari bozuluyor
- Gunluk mum sekillenirken indicator hesabi yanlis cikip false buy sinyali ureebiliyor

### Cozum
- `applyLiveOverlay`: yeni-gun bar SADECE `live.high > live.low` ve `live.open > 0` ise
  push edilir, yoksa beklenir; eklenen bar `_isForming: true` isaretlenir
- `useAIAdvisor` scan loop: `_isForming` bar veya `H=L=C` zero-range bar `calcAll`/`genSignal`
  hesabindan strip edilir → indicators TAMAMLANMIS barlardan hesaplanir, `last.close` sadece
  display icin kullanilir
- `chartDraw.js`: `_isForming` mumlar **%55 opaklik + dashed wick + hollow gövde** ile
  cizilir — "henüz kapanmadi" görsel sinyali

## Structural Health Guard (useAIAdvisor — v18)

Buy picks filtresine 3 yeni hard kural:
1. **Confirmed Bear**: `supertrend DOWN + ichimoku cloud below + OBV distribution` → ele
2. **Active Distribution**: `OBV distribution + CMF < -0.08 + RSI > 50 + score < 60` → ele
3. **Cift Bearish Divergence**: `rsiDivergence === 'bearish' && obvDivergence === 'bearish'` → ele

Bu uc kuraldan birini tetikleyen hisseler taban (-%10) yeme riski yuksek oldugu icin
buy listesinden cikarilir.

## Tavan-Aware Pump Assessment (useAIAdvisor — v17)

### Sorun Tanimi
BIST gunluk tavan = +%10. Tavan ertesi gun istatistik:
- ~%30-35 devam, ~%55-60 geri cekilme, ~%10 yatay
Onceki sistem tavan hisseleri en yuksek skor olarak gosteriyordu — UI'da tum picks +%9.9 / +%10.0 idi.

### Yeni Mantik
- `recentPump`: son 3 barin EN YUKSEK gunluk yukselisi
- `cumulativePump`: son 3 barin TOPLAM kumulatif yukselisi (gradual pump tespiti)
- `isTavan = recentPump >= 9` → tavan bolgesi
- `isExhausted = cumulativePump >= 15` → 3 gunde +%15 = momentum yorgun

### Guclu Sinyaller (5/5)
1. `obvTrend === 'accumulation'`
2. `cmf > 0.12` (sıkılastirildi, eski: 0.10)
3. `wyckoffSpring === true`
4. `ttmSqueeze.squeezeRelease === true`
5. Haber kategorileri: fund_inflow / buyback / insider_buy / contract

### Puan Cezalari (`calcTomorrowPotential`)
| Bolge | Kosul | Ceza |
|-------|-------|------|
| TAVAN | 3+ guc + haber + MFI<65 | -12 |
| TAVAN | 2+ guc + haber | -25 |
| TAVAN | 3+ guc, haber yok | -30 |
| TAVAN | digerleri | -50 |
| pump 7-9% | 4+ sinyal | -8 |
| pump 7-9% | 2-3 sinyal | -22 |
| pump 7-9% | 0-1 sinyal | -35 |
| pump 5-7% | — | -10 |
| pump 3-5% | — | -3 |
| Kumulatif >=15% + haber yok | — | EK -15 |

### Hard Filter (`buyPicks` + `fallbackBuys`)
- `recentPump >= 9` (tavan): SADECE haber + 3+ teknik teyit + MFI<65 ise gecirilir
- `cumulativePump >= 15`: kataliz haberi yoksa elenir

### UI Rozetleri
- `⚠ TAVAN` (kirmizi): `recentPump >= 9`
- `⚠ YORGUN` (turuncu): `cumulativePump >= 15` (tavan disinda)
- Tooltip: "ertesi gün ~%55-60 ihtimalle geri çekilir"

## Wall Street Strict Filter — v19 (2026-04)

### Kritik Bug Fixleri Cozumu
**Sorun**: Tavan filtresinin guvenecegi `recentPump` calcPrices'in forming bar exclude
edilen halinden hesaplaniyordu. Sonuc: bugun tavan yapan hisseler `recentPump=0` ile tum
guard'lardan geciyordu. (OZATD/HURGZ +%10 hala top-3'te gorunuyordu.)

**Cozum**: Yeni alan `todayPumpReal` BigPara live + dunku kapanis'tan dogrudan
hesaplanir → calcPrices/forming bar logic'inden BAGIMSIZ ground truth.

```javascript
// useAIAdvisor.js — runScan icinde
todayPumpReal = ((live.price - yesterdayClose) / yesterdayClose) * 100;
recentPump    = max(todayPumpReal, son 4 bar'in bar-over-bar yukselisi);
cumulativePump = ((live.price - 4-gun-onceki-close) / 4-gun-onceki-close) * 100;
```

### `isUnsafeForTomorrow(r)` — Tek Nokta Tavan/Exhaustion Kapisi (v20)
Tum filter path'leri (buyPicks/fallbackBuys/lastResort) AYNI fonksiyonu cagirir.

| Kosul | Sonuc |
|---|---|
| `tp >= 12%` (gap-up/devre kesici) | MUTLAK RED |
| `RSI > 88` | MUTLAK RED |
| `MFI > 88` | MUTLAK RED |
| `cum >= 22%` (2 gun kumulatif tavan) | MUTLAK RED |
| `tp 7-12%` + `calcContinuationProbability >= 38%` | GEC (guclu devam sinyali) |
| `tp 7-12%` + `calcContinuationProbability < 38%` | RED (FOMO pump riski) |
| `cum >= 18%` haber yok | RED |

### Wall Street Quality Tier (lastResort)
Tavan gunu icin tavan-disinda kaliteli setup yoksa, yedek 4 katmanli hierarchy:

```
TIER 1 (qualityRank 100+): detectEarlyAccumulation isEarly=true (4+ sinyal)
TIER 2 (qualityRank 80+):  rp<3% + score>=50 + (OBV/CMF>0.05/squeeze)
TIER 3 (qualityRank 60+):  rp 3-7% + uptrend + score>=55
TIER 0:                    baz score (panel YEDI ALTERNATIF gosterir)
```

Tavan/exhausted hisseler `lastResort`'a HIC GIRMEZ. Eger panel'i hicbir kaliteli setup
dolduramiyorsa **bos state** gosterir: "Bugun kaliteli AL setup'i bulunamadi —
sistem BUGUN tavan yapanlari degil YARIN tavan yapacaklari ariyor".

### `calcContinuationProbability(r)` — Tavan Devam Olasiligi
BIST tavan ertesi devam istatistigi: ~%30-35 base rate. Bu fonksiyon 5-55% araliginda
deger doner. UI'da `⚡ %37 DEVAM` rozeti olarak gorunur.

| Sinyal | Etki |
|---|---|
| insider_buy / buyback / contract | +18 |
| OBV accumulation | +12, distribution -14 |
| CMF > 0.20 | +9, < -0.05 -9 |
| Wyckoff Markup | +7, Distribution -11 |
| TTM squeezeRelease | +7 |
| MFI > 82 | -12, < 60 +5 |
| RSI > 90 | -14, > 82 -6, < 68+rp9 +6 |
| Cumulative pump >=22% (2 gun ust uste tavan) | -18 |
| Sektor strength > 2 | +7 |

Renk: `>= 38%` yesil (guclu devam), `27-38%` sari (orta), `< 27%` kirmizi (yuksek geri cekilme).

### Final Sort Algoritmasi (Top 3 Garantisi)
```javascript
picks.sort((a, b) => {
  if (a.cls === 'sell' && b.cls !== 'sell') return 1;          // Sells en sona
  const aPump = max(a.todayPumpReal, a.recentPump);
  const bPump = max(b.todayPumpReal, b.recentPump);
  if (aPump >= 7 && bPump < 7) return 1;                       // Tavan/yuksek-pump arkaya
  if (bPump >= 7 && aPump < 7) return -1;
  if (aPump >= 7) return b.continuationProbability - a.continuationProbability;
  return b.confidence - a.confidence;                          // Non-pump confidence sirasi
});
```

Top-3'te +%10 hisse gormek icin **tum BIST'in tavan yapmasi VE her birinin kataliz haberi
olmasi VE 4+ teknik teyit gostermesi** gerekir — pratik olarak imkansiz.

## Forming-Bar Lifecycle Fixes — v19

### Hollow Mum Sorunu (4 Katmanli Fix)
**Onceki**: `_isForming: true` barlar L2 localStorage'a kaydediliyordu. Ertesi gun
yuklenince **dunun mumu da hollow** goruluyordu. Birden fazla hollow mum ust uste.

| # | Dosya | Fix |
|---|---|---|
| 1 | `fetchEngine.js` `_hydrateL2Cache` | L2'den yuklerken `_isForming` flag temizle |
| 2 | `fetchEngine.js` `_scheduleL2Persist` | L2'ye kaydetmeden once `_isForming` strip et |
| 3 | `fetchEngine.js` `applyLiveOverlay` | Duplicate guard: ayni gun forming bar varsa **update**, yeni eklemez |
| 4 | `chartDraw.js` | `forming` sadece `vi === visiblePrices.length - 1` (son bar) ise true |

### `prev` Bar Hesabi Duzeltildi
```javascript
// Onceki: forming bar oldugunda calcPrices[length-2] = day before yesterday (BUG)
// Yeni: forming bar varsa prev = calcPrices[length-1] (yesterday last completed)
const prev = isFormingBar
  ? calcPrices[calcPrices.length - 1]
  : calcPrices[calcPrices.length - 2] || calcPrices[calcPrices.length - 1];
```

## AIAdvisorPanel Cache & Sync Fixes — v19

### isFromCache Logic Yeniden
**Onceki**: `topPicks.length === 0 && displayPicks.length > 0` — scan tamamlandi ama
`topPicks` bos kalirsa "OTOMATIK YEDEK" gosteriliyor, eski localStorage degismiyordu.

**Yeni**:
```javascript
const isFromCache = lastUpdate === null && displayPicks.length > 0;  // sadece scan olmadan
const isWarningFallback = !isFromCache && lastUpdate !== null
  && picks.every(p => p._warningPick === true);                       // alternatif liste
```

### Scan Complete → DAIMA Fresh displayPicks
`lastUpdate` degistigi anda `displayPicks` yeniden derive edilir:
- `topPicks` varsa → kullan
- `topPicks` bos + `scanResults` varsa → score>=45 fallback (best-effort)
- Hicbiri yoksa → `[]` (empty state)

Eski localStorage cache **scan sonrasi devirilir**, asla stale kalmaz.

### Live Price Validation Loop
`isFromCache && displayPicks.length` ise BigPara batch ile her pick'in fiyatini kontrol et:
- `_isStaleAdverse`: AL onerisi -%3+ dustu / SAT onerisi +%3+ cikti
- `_divergenceWarn`: |divergence| > %6
- Adverse picks ranking'in **sonuna** sortlanir, silinmez (kullanici neden gecersiz oldugunu gorur)
- ≥%50 picks adverse → otomatik `manualScan()` tetiklenir

## v19 Yeni Sembol Alanlari (results[i])

`useAIAdvisor` her hisse icin standart alanlara ek olarak:
- `todayPumpReal`: BigPara live'a dayanan kesin bugun pump'i (filter ground truth)
- `continuationProbability`: 5-55% arasi tavan devam tahmini (sadece pump>=7% icin)
- `_warningPick`: lastResort'tan strict filter bypass — UI '⚠ DİKKAT' rozeti
- `_qualityRank`: lastResort tier skoru (100=erken birikim, 80=quality, 60=momentum)
- `_isQuality`, `_isEarlyResort`, `_isMomentum`: hangi tier'a ait
- `_isStaleAdverse`, `_divergenceWarn`, `_livePrice`, `_liveChange`, `_divergencePct`: cache validation

## v19 localStorage Persistence

`bist_last_ai_picks` artik su alanlari da persist eder:
```javascript
{ ...standartAlanlar,
  todayPumpReal, continuationProbability,
  _warningPick, _fallback, _earlyPick, _earlySignals, _earlyCount,
  recentPump, cumulativePump,
  confidenceBreakdown, volRatio }
```

## v21 World-Class Signal Engine (2026-04)

### Sinyal Motoru Yukseltmeleri (signals.js)
- **Distribution Trap**: OBV dist + price up + RSI>55 → -2.5; CMF negatif + price up → -1.5
- **Exhaustion Pattern**: 3 gun yukselis + hacim kuruyor → -2.5; daralan govde → -1.5
- **Gravestone Doji**: Ust golge > 4x govde → -2.5 (yeni mum pattern)
- **Hammer (dip donus)**: Alt golge > 2.5x govde + RSI<40 → +1.5 (yeni mum pattern)
- **Zayif Hacim Rallisi**: volRatio < 0.7 + yukselis → -1.5 (eskisi -0.5)
- **Agir Hacimli Dusus**: volRatio > 2.5 + dusus → -2.0 (yeni)
- **MFI Asiri Alim**: MFI>75 + change>2% → -2.0 (yeni)
- **Zayif Kapanis Kademe**: dayHighLowRange < 0.2 → -3.5 (yeni seviye)

### AI Advisor Yukseltmeleri (useAIAdvisor.js)
- **Composite Confidence v21**: 7 bilesen (teknik 28% + potansiyel 18% + sektor 10% + haber 8% + entry 18% + likidite 8% + momentum health 10%)
- **Momentum Health (yeni)**: Hacim teyidi + OBV + RSI + CMF bilesik saglik skoru
- **Entry Quality sertlestirildi**: Pump 3-5% cezasi 60→50, MA20 mesafesi cezalari 2x
- **3 yeni hard guard**: Distribution trap, exhaustion, weak rally — buyPicks filtresi
- **calcTomorrowPotential**: Distribution trap -18/-26, exhaustion -15, weak rally -12

### fetchEngine Optimizasyonlari
- **applyLiveOverlay batch cache**: `_batchPriceCache` 120s TTL ile oncelikli, per-symbol fallback yerine ~0ms
- **Cache hit non-blocking**: overlay fire-and-forget, data aninda doner
- **Fresh fetch 3s timeout**: overlay max 3s bekler
- **Retry bekleme**: 2000ms → 500ms
- **Circuit breaker recovery**: fetchData girisinde suresi dolmus backoff'lari resetler
- **L2 stale fallback**: Tum kaynaklar basarisiz olursa localStorage'dan stale data (dataConfidence='low')

### Signal Attribution Sistemi
- `extractFiredSignals(ind, prices)` — 23+ sinyal tipi: RSI_OVERSOLD, MACD_BULL_CROSS, OBV_ACC, TTM_FIRE, SUPERTREND_FLIP_UP, RESISTANCE_BREAK, CUP_HANDLE, vb.
- `useSignalTracker.calcStats()` — kapanan trade'lerdeki firedSignals'dan `bySignalType` win rate hesabi (min 8 ornek)
- `genSignal` — her fired sinyal tipinin gecmis basari oranina gore ±2 puan kalibre (signal attribution feedback)
- `usePaperTrading` — pozisyon acarken firedSignals kaydeder, kapaninca bySignalType guncellenir

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)

## İşlem Yönetim Planı + Kataliz-Olay Haberleri (v31.18)

Kullanıcı iki şey istedi: (1) "hedef/stop + hisseyi nasıl tutacağımı tam belirle", (2) "Salah
transferi sonrası TSPOR %6 arttı gibi hisse-özel olay haberlerini de tara".

- **`tradePlan.js`** (saf, 7 test): `buildTradePlan(sig)` → deterministik yönetim planı:
  KADEMELİ ALIM (%40 giriş / %30 geri çekiliş = entry−0.5ATR / %30 kırılım = entry+0.5ATR),
  STOP YÖNETİMİ (başlangıç stop → +%3 breakeven → +%5 üstü %50 kilit + trailing; useLivePrices
  sabitleriyle birebir), KADEMELİ KÂR ALMA (T1 %40 / T2 %30 / T3 veya trailing %30),
  geçersizleşme (stop altı günlük kapanış), tutma ufku. Sell için yön-simetrik.
  `AnalyzeTab` İşlem Kurulumu kutusunda "📋 İŞLEM YÖNETİM PLANI" olarak render (gerçek KCHOL
  verisiyle doğrulandı).
- **`marketNewsEngine` kataliz-olay kategorisi**: yeni `catalyst_event` (weight +4) — transfer/
  imza/kadroya katma, ortaklık/sponsorluk, satın alma/birleşme, yeni yatırım/kapasite/ürün,
  endekse dahil, lisans/patent, rekor ciro/ihracat. TSPOR/Salah tarzı olaylar artık yakalanıp
  puanlanıyor. Ayrıca `classifyNewsItem` artık `_normalize` ile eşleştiriyor → ASCII kurallar
  (sozlesme/imza) Türkçe metinle (sözleşme/imzâ) EŞLEŞİYOR (önceden diyakritik yüzünden sessizce
  kaçıyordu — tüm kategorileri iyileştirir). Scan'in CATALYST listesine `catalyst_event` eklendi
  (v31.8 haber-seçim +5 boost). Tekil analiz (v31.7) ve tarama (v31.8) otomatik faydalanır.
- Test: `tradePlan.test.js` (7) + `marketNewsEngine.test.js` (+2: transfer, diyakritik); suite 458 pass, 0 lint error.

## Haber Tüm Evrende + Mobil L2 Kota Sağlamlaştırma (v31.19)

Kullanıcı: "Haberleri tüm hisseler için yap, ayrıca mobilde düzgün çalışsın."

**(1) Haber artık TÜM taranan hisselerde** (v31.8'de yalnız aday havuzuna çekiliyordu):
`fetchMarketNews` aynı RSS akışlarını universe boyutundan BAĞIMSIZ çeker — `universe`
yalnız sembol ÇIKARIMINI filtreler. Bu yüzden 612 sembollük whitelist ~bedava ve çıkarımı
DAHA doğru yapar (blacklist sezgisi yerine bilinen-ticker eşleşmesi). Artık haber alanları
(`newsScore/newsCount/newsCategories/newsHeadline/newsHighImpact`) `results`'taki HER hisseye
enjekte edilir; aday havuzuna ayrıca confidence kataliz deltası uygulanır (seçimi etkiler).
`picks` map ile YENİ nesneler ürettiği için ikisi ayrı doldurulur. Log: "Haber taraması: N
hissede güncel haber bulundu (tüm evren)".

**(2) L2 cache kota sağlamlaştırma (mobil).** ÖLÇÜLDÜ: 1y penceresiyle (v31.9) bir sembol
~29.5KB → 612 sembol ≈ **17.2MB** tek blob. Eskiden tüm cache tek seferde yazılıyor, hata
`catch {}` ile SESSİZCE yutuluyordu. Mobil tarayıcılarda (iOS Safari / Android WebView /
Capacitor) localStorage sınırı tipik ~5MB → yazma başarısız → **L2 hiç kalıcı olmuyor** →
her açılışta 612 sembol sıfırdan. Düzeltme (`_scheduleL2Persist`):
- **Kompakt serileştirme**: fiyatlar 4 ondalığa yuvarlanır (Yahoo'nun 17 haneli double'ları
  yerine) → ölçülen 29.5KB → **26.6KB**/sembol.
- **Bayt bütçesi**: mobil/Capacitor/PWA **1.2MB**, masaüstü **3.5MB**; en TAZE girdiler
  (`_ts` sırası) bütçeye kadar yazılır.
- **Kota-farkında yeniden deneme**: hata alırsa girdi sayısını yarılayıp 3 kez dener.
- **Sessiz kalmaz**: kırpma/başarısızlık bir kez console'a bildirilir.

**Dürüstlük düzeltmesi**: Bu masaüstü Chrome önizlemesinde 17MB'lık tek yazma **hata
vermedi** (bu ortamın kotası cömert). Yani kota çöküşü **mobil-özel** — kullanıcının
"mobilde düzgün çalışmıyor" raporuyla tutarlı; masaüstünde reprodüksiyon yapılamadı.
**Bilinçli takas**: masaüstünde artık ~131 sembol kalıcı (öncesinde 612'ye kadar), ama
her mutasyonda 17MB JSON serileştirme jank'i de ortadan kalkar; oturum-içi 30dk bellek
cache (v31.12) zaten tarama içini kapsar, L2 yalnız yeniden-yükleme sıcak başlangıcıdır.
Doğrulandı: 6 sembol kalıcı (160.8KB), fiyatlar 4 ondalık, forming bayrağı yok.
Suite 458 pass, 0 lint error.

## Sektör Birim-Uyuşmazlığı Bug'ı + Grade Yeniden Kalibrasyonu (v31.20)

Kullanıcı: "çok fazla detay ekledik, sistem belki bu stresten hisse bulamıyor." Hipotez
ÖLÇÜLDÜ (gerçek tarama, 111 sonuç) — huni:

| Aşama | Kalan |
|---|---|
| Taranan | 111 |
| SAT olmayan | 96 |
| cls/skor kapısı (≥45) | 46 |
| ATR + likidite + **yapısal guard'lar** | **46 (SIFIR eleme)** |
| skor ≥ 54 | 19 |

**Bulgu**: Korkulan "aşırı detay" guard'ları (confirmed-bearish, distribution-trap,
exhaustion, weak-rally) hiçbir hisseyi elemedi. Sorun filtre SAYISI değildi.

**Gerçek bug — birim uyuşmazlığı**: `sectorStrengthMap[s.sector] = s.avgScore` (~40-60,
50 merkezli) ama `enhancePick` bunu `-3..+3` TILT bekleyen formüle veriyordu:
`sectorComponent = (50 + sectorScore*8) * 0.10`. Tasarım: 2.6-7.4 (≈%10 ağırlık).
Gerçek: **37-53** → tasarımın ~7 katı, composite'i eziyordu. Kanıt (canlı tarama):
GOZDE (skor 46, cls='neutral') sektör bileşeni 42 ile **confidence 97 / grade A** aldı ve
SOKM'u (skor 62.6, gerçek AL, bileşen 5) geçti. Confidence "kurulum ne kadar iyi"yi değil
"sektörüm haritada mı"yı ölçüyordu.

**Düzeltme**:
- `sectorEngine.normalizeSectorTilt(raw)` (saf, 6 test): 50-merkezli herhangi bir metriği
  (`avgScore` ~40-60 veya `strength` 0-100) tasarlanan ±3 tilt'e indirger. Doğrulandı:
  GOZDE 42→4.1 (conf 97→59), TUPRS 47→5.6 (conf 89→48); haritada olmayanlar 5→2.6.
- **Grade yeniden kalibrasyonu**: şişme kalkınca tüm confidence'lar düştü; eski 75/65/55
  eşikleri neredeyse her şeyi D yapıp paneli boşaltırdı (kullanıcının şikayetinin tersi).
  Yeni `confidenceGrade.js` (saf, 4 test) TEK KAYNAK: **A≥68 / B≥58 / C≥48**. Eşikler
  `useAIAdvisor` içinde **5 yerde kopyalanmıştı** → 8 çağrı tek fonksiyona bağlandı.

**Dürüst sınır**: yeni eşikler KÜÇÜK canlı örnekle (kısmi 111-sembollük taramadan 5 pick)
+ composite tasarım maksimumlarıyla kalibre edildi; büyük-örnek optimumu değil. Bilinçli
olarak biraz geçirgen — asıl kalite barı rejim kapısının skor tabanı olarak duruyor.
Veri biriktikçe yeniden ayarlanmalı.

**Ölçüm hatası düzeltmesi**: İlk analizimde "confidence≥55 olan 0" diye rapor ettim; bu
YANLIŞTI — `results` girdilerinde `enhancePick` hiç çalışmaz, confidence her zaman 0'dır.
Doğru ölçüm `topPicks` üzerinden yapıldı ve gerçek bug'ı ortaya çıkardı.
Suite 468 pass, 0 lint error.
