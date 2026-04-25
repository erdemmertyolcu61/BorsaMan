# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Commands

```bash
# Web dev server (Vite SPA)
npm run dev

# Run all tests once
npm test

# Watch mode
npm run test:watch

# Coverage report (output: coverage/index.html)
npm run test:coverage

# Run a single test file
npx vitest run src/utils/__tests__/fetchEngine.test.js

# Production build
npm run build

# Electron — dev (Vite dev server + Electron with devtools)
npm run electron:dev

# Electron — production
npm run electron:prod

# Electron — package as Windows NSIS installer (output: release/)
npm run electron:build

# Deploy Vercel CORS proxy
cd proxy && vercel --prod
```

**Lint** is `eslint src --max-warnings 0 || true` — the `|| true` makes it non-blocking in CI; ESLint is not currently a hard gate.

---

## Architecture

### Stack
- **React 18 + Vite 5** SPA, packaged as a Windows desktop app via **Electron 41**
- **Vercel Serverless** CORS proxy at `proxy/api/proxy.js` (deploy separately)
- **Capacitor** scaffolding exists (`ios/`, `android/`) but is not the primary target
- Theme: dark `#0a0e17`, fonts JetBrains Mono + Space Grotesk, CSS variables `--bg2 --t1 --cyan`

### Tab Layout (`src/App.jsx`)
Four main tabs managed by `useAppState`: `analyze` | `trades` | `portfolio` | `signals`.
Two always-visible side panels: `AIAdvisorPanel` (right) and `AlertLog` (floating bottom-right).

### Global State (`src/hooks/useAppState.js`)
Single hook that owns: `activeTab`, `gData`/`gInd`/`gSig` (current chart data + computed indicators + signal), `portfolio` (persisted to `localStorage` key `bist_portfolio`), `brokerConfig`. All child components receive slices via props — there is no Context or Redux.

### Data Flow

```
User picks symbol
  → fetchData() in fetchEngine.js
      → quickFetch() with _withTimeout(10s)
          → Electron: window.electronAPI.remoteFetch (CORS bypass via main process)
          → Browser: fetch() through Vite dev proxy or Vercel proxy
      → getDataViaProxies() — Promise.any() race across self-proxy + 5 public CORS proxies
      → Source waterfall: IsYatirim → Yahoo v8 → Yahoo v7 → Midas
      → 30-min memory cache (timestamp-gated)
      → applyLiveOverlay() merges BigPara quote on top (30s TTL per symbol)
  → calcAll() in indicators.js — returns all technical indicators
  → genSignal() in signals.js — 5-level signal + setup grade A/B/C/D
  → Chart.jsx renders candlestick + overlays
  → AnalyzeTab.jsx triggers AI prompt via claude.js
```

### Key Utility Files

| File | Role |
|------|------|
| `src/utils/fetchEngine.js` | All data fetching, caching, circuit-breaker, TZ helpers. **1350+ lines — do not inline new source adapters here; extract them.** |
| `src/utils/indicators.js` | Pure functions: MA/EMA/RSI/MACD/Bollinger/ATR/ADX/MFI/OBV/VWAP/Wyckoff/TTMSqueeze/ChEx/StochRSI/ADL. No side effects. |
| `src/utils/signals.js` | `genSignal()` → signal class + score + reliability feedback. `calcPosition()` → ATR-based lot sizing with grade multiplier (A/B+/B/C/D). `detectSetup()` → 10+ patterns. `setSignalReliabilityHints()` → module-level win-rate feedback from useSignalTracker. |
| `src/utils/fundamentalEngine.js` | `analyzeComprehensiveFinancials()` → 15+ metrics, grade A+→D. Blends Yahoo Finance + KAP data. |
| `src/utils/SMC_Logic_Engine.js` | Smart Money Concepts: `findBOS()`, `findFVG()`, Order Blocks, Liquidity Sweeps. |
| `src/utils/backtestEngine.js` | `runBacktest()` operates exclusively on `G_data` — **never fetches new data**. |
| `src/utils/monteCarlo.js` | `runMonteCarloAsync()` delegates to `monteCarloWorker.js` (Web Worker); sync fallback if Worker unavailable. |
| `src/utils/claude.js` | All Anthropic API calls. `SMC_RULEBOOK` is sent with `cache_control: ephemeral` to cache the static system prompt. |
| `src/utils/sanitize.js` | Single entry point for all external data: `renderSafeMarkdown()` for AI output, `sanitizeHTML()` for KAP/RSS, `sanitizeText()` for titles. |
| `src/utils/errorLogger.js` | `logError(domain, msg, err, {severity, silent})`. 5-min dedup window. `safeAsync` / `safeSync` wrappers. |
| `src/utils/constants.js` | `getStockList('bist30'|'bist50'|'bist100'|'bistall')`, `SECTORS` map, `QUICK_STOCKS`. |

### Hooks

| Hook | Role |
|------|------|
| `useAIAdvisor` | Scans BIST50 every 15 min with 4 parallel workers. TZ-stable `isMarketOpen()` via Istanbul `Intl.DateTimeFormat` + `isBistClosedDay()`. Stores previous scan's sector strength in `prevSectorStrengthRef` and passes it into `genSignal` per symbol. Blocks picks where sector strength ≤ 20 (CIKIS). Dispatches `advisor-scan-complete` CustomEvent. |
| `useSignalTracker` | Persists up to 500 signals in `bist_signal_history`. Checks outcomes every 10 min via BigPara. Computes 1D/3D/5D returns and 0–100 reliability score. ATR-aware dedup: same symbol+signal within 4h is only blocked if price moved < 1 ATR from last entry. Calls `setSignalReliabilityHints()` after each batch check to feed win-rate back into the signal engine. |
| `useLivePrices` | Polls BigPara every 30s during market hours (10:00–18:00 Mon–Fri). Manages trailing stop automation. |
| `useAlertLog` | Aggregates alerts from all sources (live_guard / watchlist / advisor / signal_tracker / manual). |
| `useAppState` | Global tab + chart data + portfolio state (see above). |

### AI / Claude Integration (`src/utils/claude.js`)
- Model: `claude-sonnet-4-20250514`, routed through `/api/claude` on the Vercel proxy
- Temperature 0.6 for analysis; 0.3 for daily picks JSON mode
- 7-layer prompt hierarchy: Macro → Sector → Fundamental → Technical → Time → Risk → Position
- Contrarian protocol triggers on extreme sentiment
- Memory: last 5 interactions in `localStorage` key `bist_jarvis_memory`
- Prompt caching: `SMC_RULEBOOK` (static rules block) sent with `cache_control: {type:'ephemeral'}` — saves ~85–90% input token cost on BIST50 scans
- `analyzeKAPList` has caching **disabled** (short output, overhead not worth it)

### Proxy Server (`proxy/`)
- `proxy/api/proxy.js` — Vercel Serverless function
- Domain whitelist: Yahoo, BigPara, IsYatirim, Foreks, KAP, TCMB, and others (see `ALLOWED_DOMAINS`)
- `proxy/api/claude.js` — forwards requests to Anthropic with `x-api-key`; must pass `anthropic-beta: prompt-caching-2024-07-31` header upstream for caching to work
- Edge cache: `s-maxage=120, stale-while-revalidate=600`
- Timeout: 10s AbortController

### Electron (`electron/`)
- Main: `electron/main.cjs`, Preload: `electron/preload.cjs`
- `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: false`
- `window.electronAPI.remoteFetch` — IPC bridge that bypasses CORS from the main process; `quickFetch()` in fetchEngine detects Electron automatically (absolute URL + `window.electronAPI` present)
- Safety net: if `ready-to-show` doesn't fire within 4s, window is force-shown and DevTools opened

---

## fetchEngine — Critical Details

### Istanbul Timezone Helpers
All day comparisons use `istanbulDayKey(d)` — a module-scoped `Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Istanbul'})` formatter. **Never use `getFullYear/getMonth/getDate`** for BIST day logic — those are runtime-TZ and will produce wrong results for non-Istanbul users.

Exported helpers: `istanbulDayKey`, `isBistWeekend`, `isBistHoliday`, `isBistClosedDay`, `isBistSessionStarted`, `stripUntradedToday`.

Holiday calendar is hard-coded for 2025/2026/2027 in `_bistHolidaySet`. **Manual update required for 2028.**

### BIST Piyasa Saatleri (Europe/Istanbul — UTC+3)

| Seans | Başlangıç | Bitiş | Not |
|-------|-----------|-------|-----|
| Sabah | **09:30** | **12:30** | `isBistSessionStarted()` → true |
| Öğle Arası | 12:30 | 14:00 | Piyasa kapalı |
| Öğleden Sonra | **14:00** | **17:30** | — |
| Kapanış Sonrası | 17:30 | — | Sadece BigPara overlay aktif |

`isMarketOpen()` (`useAIAdvisor`) her iki seans penceresini kontrol eder:
```js
const morning   = t >= 570 && t < 750;   // 09:30–12:30
const afternoon = t >= 840 && t < 1050;  // 14:00–17:30
```

**Tatil ertesi mum görünürlük sorunu (stale-day guard):** `fetchSingle` cache içindeki son barın günü bugünden önceyse ve `isBistSessionStarted()` true ise cache otomatik bozulur, taze fetch tetiklenir. Bu 23 Nisan tatili → 24 Nisan açılışı gibi senaryolarda mumun kaybolmasını önler.

### applyLiveOverlay
Extracted pure helper — runs on both fresh fetch and cache-hit paths (for `1d`/`1wk` intervals, max once per 30s via `_overlayTs`). Merges BigPara quote into the last bar or appends a new bar if it's a new trading day. Failures are logged silently via `logError(..., {silent: true})`.

### Circuit-Breaker
`_circuitState[label]` tracks `{failures, openedUntil}`. After 3 consecutive failures a proxy is skipped for `CIRCUIT_BASE_BACKOFF_MS` (60s), doubling on additional bursts. `_recordSuccess` resets the failure counter. Six symbols are exported for tests: `_isCircuitOpen`, `_recordFailure`, `_recordSuccess`, `_circuitState`, `CIRCUIT_FAILURE_THRESHOLD`, `CIRCUIT_BASE_BACKOFF_MS`.

---

## Tests

**Test environment**: jsdom (vitest.config.js).  
**Coverage gate**: 40% lines/functions/branches/statements per file.  
**Coverage scope** (only these files are measured):
`indicators.js`, `signals.js`, `SMC_Logic_Engine.js`, `backtestEngine.js`, `fundamentalEngine.js`, `sanitize.js`, `monteCarlo.js`, `errorLogger.js`.

Current pass rate: **112 tests / 10 files**.

| Test file | Coverage |
|-----------|----------|
| indicators.test.js | ~95% |
| backtestEngine.test.js | ~91% |
| fundamentalEngine.test.js | ~85% |
| sanitize.test.js | ~94% |
| errorLogger.test.js | ~97% |
| monteCarlo.test.js | ~79% |
| signals.test.js | ~55% |
| SMC_Logic_Engine.test.js | ~54% |
| fetchEngine.test.js | circuit-breaker + TZ helpers |
| top10Intelligence.test.js | top10 cycle |

**Important test constraints**:
- `applyLiveOverlay` network-dependent tests are excluded from the unit suite; only nil/empty guards are tested here
- `monteCarloWorker.js` is not in the coverage scope; the Worker is tested indirectly through `monteCarlo.test.js` sync fallback

### CI (`.github/workflows/ci.yml`)
4 parallel jobs: `test-js` → `build-web` → `test-python` → `ci-gate`. Triggered on push/PR to main/master/develop. Same-branch concurrency cancels older runs. Python job uses `FakeMCPSession` for offline testing of `bist_bridge.py`.

---

## Coding Rules

- **English only** for variable/function names. Turkish in UI strings is fine but escape apostrophes (`'`) in JS template literals.
- **Backtest never fetches data** — `runBacktest()` reads `G_data` (already-fetched global). Any code path that calls `fetchData()` inside backtest is a bug.
- **localStorage keys** must start with `bist_` prefix (e.g. `bist_signal_history`, `bist_jarvis_memory`, `bist_portfolio`).
- **New components** should use existing CSS variables (`--bg2`, `--t1`, `--cyan`) and the `trade-box fi` class pattern.
- **No `eval()`** in strategy compilation — use the sandboxed `new Function` path in `StrategyBuilderTab.jsx` with the denylist regex.
- **All external HTML** must go through `sanitize.js` before rendering with `dangerouslySetInnerHTML`.
- After modifying source files, run `graphify update .` to keep the knowledge graph current.

---

## Signal Engine — v12 Details

### `signals.js` key contracts
- **`calcPosition(capital, riskPct, entry, stop, options?)`**: After base lot calculation, applies `options.setupGrade` multiplier: A=1.0, B+=0.85, B=0.75, C=0.5, D=0 (returns `{shares:0, method:'grade_blocked'}`). Unknown grades fall through safely.
- **`setSignalReliabilityHints(hints)`**: Accepts `{ buy: {winRate, sampleSize}, sell: {winRate, sampleSize} }`. Module-level state. In `genSignal`, if `sampleSize >= 15`: winRate < 0.35 multiplies conf × 0.80; winRate > 0.65 (sampleSize ≥ 20) multiplies conf × 1.10.
- **Sector gate in `genSignal`**: `sectorStrength >= 80` → +2 score; `>= 70` → +1; `<= 20` → −2.5; `<= 30` → −1.5.
- **CHOPPY regime gate**: `requiredConf` raised from 80 → 88 when `detectMarketRegime` returns CHOPPY.
- **Smart money exit for sell**: Sell signal requires `ind.obvTrend === 'distribution'` OR `ind.cmf < -0.05` OR `ind.mfi > 75` (instead of raw volume check).

### `adaptiveThresholds.js` — Hidden Divergence Fix
`detectHiddenDivergence` now uses chronological swing pivot detection (`_findSwingHighs` / `_findSwingLows`) with `±lookback=3 bars` within a trailing `window=30 bars`. The old global-sort approach was producing false positives. Bearish hidden = price HH + RSI LH; Bullish hidden = price HL + RSI LL.

---

## Known Open Issues

- `fetchEngine.js` is 1350+ lines — Yahoo/IsYatirim/Midas/BigPara adapters are candidates for extraction into separate files.
- `signals.js` coverage ~55% (1070 lines) — setup detector functions need their own test file.
- `SMC_Logic_Engine.js` coverage ~54% — OrderBlock + LiquiditySweep helpers lack targeted tests.
- `proxy/api/claude.js` must forward `anthropic-beta` header upstream; if missing, prompt caching is silently skipped (no error, just higher cost).
- BIST holiday calendar needs manual update for 2028.
- ESLint is `|| true` in CI — not a hard gate yet.

---

## graphify

This project has a graphify knowledge graph at `graphify-out/`.

Rules:
- Before answering architecture or codebase questions, read `graphify-out/GRAPH_REPORT.md` for god nodes and community structure
- If `graphify-out/wiki/index.md` exists, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)
