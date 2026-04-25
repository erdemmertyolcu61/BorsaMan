# BIST AI Trading Terminal — Claude Code Context

## Proje Amaci
BIST (Borsa Istanbul) hisselerini cok katmanli teknik + temel + akilli para + makro perspektifle
analiz eden, sinyal uretip risk yoneten, Claude Sonnet 4 tabanli yapay zeka yorumcusu ile destekli,
masaustu bildirimli bir trading terminali. React 18 + Vite 5 ile gelistirilmis SPA, Electron ile
Windows masaustu uygulamasi olarak paketlenir. 7 katmanli analiz hiyerarsisi
(Makro → Sektorel → Temel → Teknik → Zaman → Risk → Pozisyon) ve A/B/C/D setup
gradelemesi ile calisir.

## Mimari
- **Frontend**: React 18 + Vite 5 SPA, Electron 41 ile desktop paketleme
- **Backend**: `proxy/` altinda Vercel Serverless CORS proxy (10 domain whitelist + /api/claude)
- **Terminal estetigi**: Koyu tema (#0a0e17), JetBrains Mono + Space Grotesk
- **4 ana sekme**: Tekil Analiz, Strateji/Backtest, Intraday Trade, Portfoy
- **Sabit paneller**: AIAdvisorPanel, SignalTrackerPanel (3 tab), AlertLog (floating)

## Teknik Ozellikler (v8)
- **Gostergeler**: MA-20/50/100/200, RSI(14), MACD(12/26/9), Bollinger Bands, ATR(14),
  Fibonacci, Pivot, MFI, OBV, VWAP, A/D Line, TTM Squeeze, Chandelier Exit, ADX, Wyckoff Phase
- **Akilli Para**: MFI kurumsal alim/satim, OBV birikim/dagilim trendi, VWAP pozisyonu,
  Wyckoff Phase (Accumulation / Markup / Distribution / Markdown)
- **Setup Tespiti**: 10+ pattern (Bollinger sikisma, oversold bounce, MACD diverjans,
  hacim kirilimi, golden cross, Wyckoff Spring, Volume Climax, Double Bottom, Cup & Handle)
- **Setup Grade**: A/B/C/D sinyal skoru + OBV birikim, MFI<40, ADX>25, fiyat>MA200 bonuslariyla
- **Sinyal Motoru**: 5 kademe (GUCLU AL → AL → TUT → SAT → GUCLU SAT), ATR-bazli stop,
  Fibonacci hedefler, R/R hesaplamasi
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
- **Hafiza sistemi**: `MEMORY_KEY='bist_jarvis_memory'`, MAX_MEMORY=5 son etkilesim,
  hafiza sorgu kisayolu ile gecmisi hatirlama
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

## AI Advisor (`useAIAdvisor`)
- **Piyasa saatleri**: isMarketOpen() — hafta ici 09:30-17:30
- **Otomatik tarama**: AUTO_SCAN_INTERVAL_MS = 15 dk, SCAN_CONCURRENCY = 4 paralel worker
- **Universe**: SCAN_UNIVERSE = 'bist50' (degistirilebilir)
- **Market sentiment**: sectorRotation (calcSectorMetrics + rankSectors), avgRSI, AL/SAT sayisi
- **Top picks filtresi**: score >= 5 ve rr >= 1.5
- **Risk alerts**: Portfoy uzerinde stop yakinligi, oversized lot, konsantrasyon
- **Event**: Tarama bittiginde `advisor-scan-complete` CustomEvent dispatch edilir

## Live Guard (`useLivePrices` — v11 tiered adaptive)
- **3 polling tier** (BIST'in public WS'i yok — adaptif polling ile WS'e en yakin tazelik):
  - **FAST 5s**: stop/hedefe %1.5'tan yakin pozisyonlar (burst mode)
  - **NORMAL 15s**: acik pozisyonlar
  - **SLOW 45s**: watchlist + non-positioned semboller
- **Page Visibility API**: tab gizliyken tum tier'lar duraklar; gorunur olunca FAST tier hemen tetiklenir
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

## AlertLog (Floating panel)
- Sag-alt sabit konum, collapsible
- Kaynak filtresi (live_guard / watchlist / advisor / signal_tracker / manual)
- **24s Ozet**: marketContext, portfoy ozeti, topPicks, riskAlerts, critical signals

## Veri Cekme Motoru (v5)
- **Self-hosted Vercel Proxy** (ONCELIKLI): `proxy/api/proxy.js`, 10 domain whitelist
- **Public CORS proxies** (fallback): AllOrigins/get + corsproxy.io + AllOrigins/raw
- **Kaynak sirasi**: Self-proxy → Yahoo v8 → Yahoo v7 → Foreks → Is Yatirim → BigPara
- **fetchData()**: 3 retry (normal, cache temizle+2s, farkli range)
- **Cache**: 30dk timestamp bazli
- **Backtest**: ASLA yeniden veri cekmez — G_data kullanir

## Proxy Server (`proxy/`)
- **Vercel Serverless**: `proxy/api/proxy.js`, `vercel.json`
- **Route**: `/api/proxy?source=yahoo|bigpara|isyatirim|foreks|...&symbol=...`
- **Whitelist**: 10 domain (Yahoo, Foreks, BigPara, IsYatirim, KAP, TCMB, vb.)
- **Cache**: `s-maxage=120, stale-while-revalidate=600` edge cache
- **Timeout**: 10 saniye AbortController
- **Claude endpoint**: `/api/claude` — Anthropic API'ye x-api-key ile proxy
- **Deploy**: `cd proxy && vercel --prod`
- **Regions**: fra1, ams1

## Electron (Desktop)
- **Main**: `electron/main.cjs`, preload: `electron/preload.cjs`
- **Window**: 1440x960 (workAreaSize'in %92'si), backgroundColor #0a0e17
- **webPreferences**: contextIsolation=true, nodeIntegration=false, webSecurity=false
- **Dev modu**: `process.argv.includes('--dev')` veya `NODE_ENV=development`
- **Dev script**: `concurrently` + `wait-on` ile Vite dev server + Electron localhost:5173
- **Prod script**: `vite build && electron .`
- **Safety net**: 4 saniyede `ready-to-show` fire etmezse pencere force show + devtools acar
- **Event logging**: did-fail-load, render-process-gone, preload-error, console-message >= warn

### Bildirim Turleri
- Sinyal bildirimleri (skor >= 6.5)
- AI Advisor firsatlari (skor >= 7.5)
- Stop-loss / Hedef bildirimleri
- Intraday firsatlari
- Header'daki 🔔 butonundan yonetim (aktif/pasif, sessiz mod, min skor, tur secimi)

## Scripts
```json
"dev": "vite",
"build": "vite build",
"electron:dev": "concurrently -k -n vite,electron -c cyan,magenta \"vite\" \"wait-on http://localhost:5173 && electron . --dev\"",
"electron:prod": "vite build && electron .",
"electron:build": "vite build && electron-builder --win"
```

## Bilinen Sorunlar
1. CORS proxy rate limit — 100+ hisse taramasinda bazi istekler basarisiz (self-proxy ile minimize)
2. Veri 15-30 dk gecikmeli (ucretsiz API kisitlamasi)
3. WebSocket piyasa kapaliyken veri gondermez

## Son Yapilanlar (2026-04)
- [x] JARVIS v8 / Alpha Engine 7 katmanli prompt, hafiza sistemi, auto-reading, cross-system context
- [x] Setup Grade A/B/C/D + contrarian protokol
- [x] Monte Carlo v2 — log-return GBM, Box-Muller, 500 senaryo
- [x] Fundamental Engine — 15+ metrik, A+ ile D arasi grade, Yahoo + KAP harmanlama
- [x] useSignalTracker — 1G/3G/5G performans + 0-100 reliability skoru
- [x] useAIAdvisor — 15 dk otomatik tarama, 4 paralel worker, sector rotation
- [x] useLivePrices — BigPara 30s polling, trailing stop otomatik yonetimi
- [x] AlertLog + 24s Ozet paneli
- [x] Vercel proxy /api/claude + 10 domain whitelist (KAP dahil)
- [x] Electron `:dev` gercekten dev moda donusturuldu (Vite dev server + localhost:5173 + devtools)
- [x] Electron safety net — 4s timeout ile zorla pencere gosterme, renderer hata loglama
- [x] Yahoo Finance crumb auth (fc.yahoo.com → getcrumb, 55dk cache) + fetchYahooDirect fallback zinciri
- [x] Stop/target hassasiyeti: recentLow/swingLow structure stop, maxRisk rejim-aware, T1 weighted cap@1.30, Fib T3
- [x] Pump-continuation assessment: hard zero yok, 6 continuation signal kontrol, -5/-18/-30 ceza
- [x] fetchEngine circuit-breaker: kumulatif failure sayaci ile gercek exponansiyel backoff (3→60s, 4→120s, 5→240s)
- [x] fetchEngine.test.js: circuit-breaker + istanbulDayKey + isBistWeekend + applyLiveOverlay — 13 yeni test

## Production Hardening (2026-04 — v9)

### 1. XSS Korumasi — DOMPurify
- `src/utils/sanitize.js` tum harici veri akislari icin tek giris noktasi
- `renderSafeMarkdown(text)`: Claude AI yanitlari icin; escape → mini markdown (bold/italic/br) → DOMPurify tarama
- `sanitizeHTML(dirty)`: News RSS / KAP HTML govdeleri icin; beyaz liste: b/strong/i/em/u/br/p/ul/ol/li/code/pre/span/a
- `sanitizeText(dirty)`: baslik/ozet alanlari icin TUM tag'leri siler
- ChatPanel.jsx artik AI yanitini `renderSafeMarkdown` ile render ediyor; inline `__html` sablonlari kaldirildi
- Dependency: `dompurify ^3.1.6`

### 2. Sandboxed Strategy Compile — eval() KALDIRILDI
- StrategyBuilderTab eskisi gibi `eval(aiKodu)` calistirmiyor
- Denylist regex: `fetch|XMLHttpRequest|WebSocket|import|require|eval|Function|globalThis|window|document|localStorage|...` → reddedilir
- 4KB kod limiti + `new Function('"use strict"; return (' + code + ');')` ile izole scope
- Kompoz edilen strateji yalnizca `ind`, `sig`, `data` argumanlarini gorur — komponent closure'una erisim yok

### 3. Claude Prompt Caching — Maliyet Optimizasyonu
- `src/utils/claude.js` → `callClaude` artik `system` alanini array olarak gonderiyor:
  `[{ text: dynamic }, { text: SMC_RULEBOOK, cache_control: { type: 'ephemeral' } }]`
- `SMC_RULEBOOK` sabit: BOS/OB/FVG kurallari + 7-katmanli agirliklandirma + Contrarian + A/B/C/D grade
- Header: `anthropic-beta: prompt-caching-2024-07-31`
- Kullanim: tum `askExpert`, `chatClaude`, `chatClaudeHistory`, `askDailyPicks`, `generateStrategyCode` cagrilari cache'li (default `useCache: true`)
- `analyzeKAPList` cache KAPALI (kisa JSON ciktisi — overhead degmez)
- Beklenen tasarruf: BIST50 scan'de input token maliyetinin ~%85-90 dusmesi (rulebook tekrar gonderilmiyor)

### 4. Monte Carlo Web Worker — UI 60fps
- `src/utils/monteCarloWorker.js` (yeni): GBM donguleri dedicated thread'de
- `monteCarlo.js` -> `runMonteCarloAsync(prices, days, simulations)` Promise ile sonuc doner
- Tek worker instance — birden fazla bekleyen istek `id` ile keylenir
- Flat `Float64Array` matrix + kisitlanmis `Math.exp(drift + sigma*z)` — senaryolar 2x hizlandirildi
- Worker yoksa (SSR/test) otomatik sync fallback: eski `runMonteCarlo` kullanilir
- 10,000 path x 90 days artik chart scroll/drag'i BLOKE ETMIYOR

### 5. Parallel Race Fetch — Promise.any
- `fetchEngine.js` -> `getDataViaProxies` refaktor edildi
- Self-hosted proxy + 5 public CORS proxy AYNI ANDA fire ediliyor, ilk basarili (non-empty) response kazanir
- `Promise.any(probes)` semantigi — digerleri terk ediliyor
- Eski "await self → fallback sira" pattern'i kaldirildi; BIST50 scan'de ortalama latency ~40% dustu
- Absolute ceiling `ms + 2s` — hic birisi yanit vermezse null doner

### 6. Vitest + Regresyon Testleri
- `vitest ^2.1.0` devDependency; `npm test` / `npm run test:watch`
- `vitest.config.js`: node environment, `src/**/__tests__/**/*.test.js` pattern
- `src/utils/__tests__/SMC_Logic_Engine.test.js`:
  - `findBOS` bull/bear/insufficient-data
  - `findFVG` bullish gap bounds + mitigation invalidation
- `src/utils/__tests__/signals.test.js`:
  - `calcPosition` risk sizing + budget cap + zero-risk guard
  - `genSignal` shape contract (signal/cls/score) + bearish-path regression
- Amac: BOS/FVG ve pozisyon sizing sessizce bozulursa CI HATASI

### Bilinen Takipler
- `/api/claude` Vercel handler'i `anthropic-beta` header'ini upstream'e pass etmeli (yoksa caching pasif olur — yine de guvenli)
- DOMPurify bundle ~15KB gzipped; kritik olmayan sayfalarda lazy import dusunulebilir

## Kodlama Kurallari
- Turkce degisken/fonksiyon isimleri KULLANMA — ingilizce yaz
- Turkcede ozel karakter (s,i,o,u,c,g) JS string icerisinde sorun yaratabilir — dikkatli ol
- HTML icinde Turkce metin kullanilabilir ama JS stringlerinde apostrof (') escape edilmeli
- Backtest ASLA ek veri cekmemeli — G_data (zaten cekilmis) kullanmali
- Yeni komponent yazarken mevcut `trade-box fi` stilini ve CSS degiskenlerini (--bg2, --t1, --cyan) kullan
- localStorage key'leri `bist_` prefix'i ile baslasin (bist_signal_history, bist_jarvis_memory, vb.)

## Test & CI Pipeline (2026-04 — v10)

### JS Test Coverage — 73% genel (esik gate: 40%)
- `vitest.config.js` — jsdom ortami + `@vitest/coverage-v8` provider
- Per-file thresholds: lines / functions / branches / statements hepsi >= 40%
- **80 gecen test / 8 dosya:**
  - `indicators.test.js` — MA/EMA/RSI/MACD/Bollinger/ATR/ADX/Wyckoff/StochRSI/calcAll — **%94.7**
  - `backtestEngine.test.js` — runBacktest kontrat + stats + drawdown + streak — **%91**
  - `signals.test.js` — calcPosition sizing + genSignal shape + bearish flip — %55 (1070 satir)
  - `SMC_Logic_Engine.test.js` — BOS bull/bear + FVG + mitigation — %54
  - `fundamentalEngine.test.js` — margins / ROE / ROA / grade / KAP aliases / trend — **%85**
  - `sanitize.test.js` — XSS hardening (script strip, event-handler strip, markdown escape) — **%94**
  - `monteCarlo.test.js` — percentile ordering + profit prob + vol caps — %79
  - `errorLogger.test.js` — dedupe window + silent flag + safeAsync/safeSync — **%97**
- Scripts: `npm test`, `npm run test:watch`, `npm run test:coverage`
- Coverage raporu HTML: `coverage/index.html`

### GitHub Actions CI — `.github/workflows/ci.yml`
- **4 paralel job + gate:**
  1. `test-js` — npm ci + lint + vitest --coverage + junit.xml + coverage artifact + PR'da coverage tablosu (step-summary)
  2. `build-web` — `npm run build` (Vite production smoke test, dist/ artifact)
  3. `test-python` — `pytest tests/` (borsapy best-effort install, MCP mocklanir)
  4. `ci-gate` — tum job'lar yesilse yesil (branch protection icin required)
- Tetikleyiciler: push + PR (main / master / develop)
- Concurrency: ayni dal icin yeni push eskisini iptal eder
- Node 20 + Python 3.11; npm + pip cache aktif

### Borsa MCP → TradingAgents Koprusu — `bist_bridge.py`
- `BistBridge` — `mcp.ClientSession` icin async context manager; `saidsurucu/borsa-mcp` server'i ile konusur
- MCP tool surface: `get_hisse_historical` / `get_hisse_finansal` / `get_kap_disclosures` / `get_hisse_bilgi` / `list_hisse_by_sector`
- `FundamentalsContext` dataclass: `to_agent_payload()` → TradingAgents `FundamentalsAnalyst` contract (CONTEXT_KEYS: symbol, as_of, price_series, financials, kap_disclosures, sector, peers, notes)
- Dusme zinciri: MCP → borsapy → bos + warn log
- `feed_fundamentals_analyst(symbol, analyst=...)` — `.analyze()` (async) veya `.run()` (sync/async) route eden adapter
- `stream_universe(symbols, concurrency=4)` — BIST100 batch icin async generator
- Test seam: `session_factory` constructor param → FakeMCPSession CI'da offline calisir
- **`tests/test_bist_bridge.py` — 13 pytest case:**
  - Tam happy path (OHLCV + financials + KAP + sector)
  - Bos input → `no_price_data` / `financials_empty` notlari
  - Yahoo-style key alias (Date/Open/Close/Volume)
  - Sector fallback → peer listesi expansion
  - TradingAgents adapter `.analyze()` async route, `.run()` sync route
  - `stream_universe` tum sembolleri concurrency limit altinda yield eder
  - `to_prompt_block` + `to_agent_payload` shape checks

### Bilinen Takipler (v10)
- signals.js %55 — 1070 satirlik dosya; setup detectorlerinin ayri test dosyasina cekilmesi planli
- SMC %54 — OrderBlock + LiquiditySweep helpers icin targeted test yok
- Python CI'da borsapy best-effort; gercek integration `uvx saidsurucu-borsa-mcp` runner gerektirir
- `npm run lint` hook'unda ESLint dependency eklenmeli (su an `|| true` ile pass-through)
- Yahoo crumb auth browser ortaminda CORS kisitiyla dogrudan calismiyor; Electron/Vite dev proxy'si uzerinden fetchYahooDirect tetiklenir

## Intraday Engine — v2 (2026-04)

### IntradayEngine.js — Yeni Yetenekler
- **`computeORB(bars, orbMinutes=30)`**: BIST acilis 09:30'dan itibaren ORB high/low hesaplar. `breakoutUp`, `nearBreakoutUp`, `rangePct` doner
- **`computeRS(stockBars, marketBars)`**: Bugunun hisse % degisimi / BIST100 % degisimi → `leading`, `lagging`, `strongLeader`, `outperformance`
- **`intradayMomentumScore(bars15m, vwap)`**: 15dk RSI + MACD + VWAP pozisyonu + trend + hacim ivmesi → 0-100 kompozit skor
- **`volumeRate(bars15m, avgDailyVol)`**: Bugunun hacim birikimi / beklenen hacim pace → `rate`, `onPace`, `surge`
- **`calcIntradayStructureLevels(bars15m, vwap, orb)`**: 15dk structure low/high + VWAP bantlari + ORB seviyelerinden stop/target/rr
- **`classifyIntradayPlay(intradayData, dailyData)`**: `momentum | orb_breakout | vwap_reclaim | dip_bounce | squeeze | none`
- **`PLAY_TYPE_META`**: Her play tipi icin renk, ikon, aciklama

### TradesTab.jsx — Profesyonel Yeniden Yazim
- **5 fazli tarama**: Market context → Daily scan → Pre-score top 16 → 15m fetch (paralel) → Full scoring
- **Intraday veri**: Her aday icin `fetchSingle(sym, '5d', '15m')` — VWAP, ORB, RS, hacim hizi hesaplamasi
- **15dk momentum**: VWAP bandi pozisyonu + 15dk MACD ivmesi + intraday trend yonu
- **Relative Strength**: BIST100 15m barlar cekilir, her hisse RS vs market hesaplanir
- **Play tipi filtreleme**: Tum | Momentum | ORB | VWAP | Squeeze sekmeleri
- **Session-aware stratejiler**: Acilis/Sabah/Ogle/Ogleden sonra/Kapanis icin farkli strateji notlari ve uyarilar
- **Kart tasarimi**: VWAP seviyeleri, ORB durumu, 15dk momentum pill, RS lideri rozet, hacim hizi
- **applyLiveOverlay fix**: Artik sadece 1d/1wk intervalda tetiklenir — 15m barlari bozmaz

## Veri Cekme Motoru — v14 (2026-04)

### Yahoo Crumb Authentication
- `ensureYahooCrumb()`: `fc.yahoo.com` → A3 cookie alir; `/v1/test/getcrumb` → crumb token; 55 dk cache
- `yahooChartUrl(symbol, range, interval, crumb, version)`: crumb parametreli URL olusturur
- `fetchYahooDirect(symbol, range, interval, ms)`: crumb+auth → v8-nocrumb → v7 → proxy zinciri
- `_doFetchSingle` SOURCE 2: `fetchYahooDirect` ilk; basarisiz olursa CORS proxy race devreye girer
- `_doFetchSingle` SOURCE 3: Yahoo v7 artik `getDataViaProxies` kullanir (getData → CORS hatalari giderdi)

### Circuit Breaker — Gercek Exponansiyel Backoff
- Duzeltme: `_recordFailure` artik `s.failures` sifirlamiyor — kumulatif birikim ile ustel artis
- 3 hata → 60s backoff, 4 hata → 120s, 5 hata → 240s, ...
- `_recordSuccess` hala failures = 0 yapar (recovery sonrasi taze baslangi)

## Stop / Target Hassasiyeti (signals.js — v14)

### Stop-Loss Zinciri
1. `chandelierStop` = highest_high(22) - 3*ATR (varsa en guvenilir)
2. `structureStop` = min(son 3 bar low) * 0.997 (recent structure)
3. `swingStop` = min(son 10 bar low) * 0.993 (swing low)
4. `srStop` = support * 0.993 (destek seviyesi)
5. `atrStop` = entry - 1.8*ATR (son fallback)
- `maxRisk` rejim-aware: trend → 0.94, volatile (atr/p > 3%) → 0.90, normal → 0.92
- Tavan kurali: `stop > entry * 0.985` → zorla `entry * 0.985`

### T1 Hedef Agirlikli Secim
- Adaylar: direnc (w=4), ATR×2.8/2.0 (w=2), Fib0.618/1.0/1.272 (w=2/3/1), pivot (w=2/1), minRR floor (w=1)
- Filtreler: entry * 1.30 tavan, min %2, max %15
- T2: Fib 1.618 tercihli; T3: Fib 2.0 tercihli; gap: 1.05x carpani

## Pump-Continuation Assessment (useAIAdvisor — v14)

### Continuation Signal Sayaci
- `recentPump > 7%` hisseler tamamen cikarilmiyor — 6 devam sinyali kontrol edilir:
  1. `obvTrend === 'accumulation'`
  2. `cmf > 0.1`
  3. `mfi < 65`
  4. `wyckoffSpring === true`
  5. `ttmSqueeze.squeezeRelease === true`
  6. news: fund_inflow / buyback / insider_buy
- 3+ sinyal → -5 puan ceza (guclu devam sinyali)
- 1-2 sinyal → -18 puan ceza (zayif devam sinyali)
- 0 sinyal → -30 puan ceza (pur pump, devam yok)
- ATR < %1.5 (gunluk hareket yetersiz) → -20 puan ek ceza
