import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'node:child_process';

const isElectron = process.env.BUILD_TARGET === 'electron';

// v31.48: build stamp shown in Profil — "is the phone on the latest deploy?" must be
// answerable without a laptop. Vercel provides the commit; locally fall back to git.
function buildSha() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7);
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return 'dev'; }
}

const BUILD_STAMP = { sha: buildSha(), time: new Date().toISOString() };

// v31.52: every deploy publishes its stamp; the running app compares (main.jsx) and
// offers a hard refresh if its service worker never picked the new build up.
const versionJson = {
  name: 'bist-version-json',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(BUILD_STAMP) });
  },
};

export default defineConfig({
  base: isElectron ? './' : '/',
  define: {
    __APP_BUILD__: JSON.stringify(BUILD_STAMP),
  },
  plugins: [
    react(),
    !isElectron && versionJson,
    !isElectron && VitePWA({
      strategies: 'injectManifest',
      srcDir: 'public',
      filename: 'sw.js',
      injectRegister: false,
      injectManifest: {
        injectionPoint: 'self.__WB_MANIFEST',
      },
      manifest: false,
      devOptions: { enabled: true },
    }),
  ].filter(Boolean),
  server: {
    port: parseInt(process.env.PORT || '5173'),
    open: false,
    proxy: {
      '/yahoo/v8': {
        target: 'https://query1.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/yahoo\/v8/, '/v8'),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        configure: (proxy) => { proxy.on('proxyReq', (pReq) => { pReq.removeHeader('cookie'); pReq.removeHeader('origin'); }); },
      },
      '/yahoo/v7': {
        target: 'https://query2.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/yahoo\/v7/, '/v7'),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        configure: (proxy) => { proxy.on('proxyReq', (pReq) => { pReq.removeHeader('cookie'); pReq.removeHeader('origin'); }); },
      },
      '/yahoo/v10': {
        target: 'https://query1.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/yahoo\/v10/, '/v10'),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        configure: (proxy) => { proxy.on('proxyReq', (pReq) => { pReq.removeHeader('cookie'); pReq.removeHeader('origin'); }); },
      },
      // v31.48: makroekonomik takvim (yerelde HTML burada ayristirilir, bkz. econCalendar.js)
      '/api/doviz-takvim': {
        target: 'https://www.doviz.com',
        changeOrigin: true,
        rewrite: () => '/ekonomik-takvim',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'tr-TR,tr;q=0.9' },
        configure: (proxy) => { proxy.on('proxyReq', (pReq) => { pReq.removeHeader('cookie'); pReq.removeHeader('origin'); }); },
      },
      '/api/tcmb': {
        target: 'https://www.tcmb.gov.tr',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/tcmb/, '/wps/wcm/connect/TR/TCMB+TR'),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        configure: (proxy) => { proxy.on('proxyReq', (pReq) => { pReq.removeHeader('cookie'); pReq.removeHeader('origin'); }); },
      },
      '/api/ff_calendar_next': {
        target: 'https://nfs.faireconomy.media',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/ff_calendar_next/, '/ff_calendar_nextweek.json'),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        configure: (proxy) => { proxy.on('proxyReq', (pReq) => { pReq.removeHeader('cookie'); pReq.removeHeader('origin'); }); },
      },
      '/api/ff_calendar': {
        target: 'https://nfs.faireconomy.media',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/ff_calendar/, '/ff_calendar_thisweek.json'),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        configure: (proxy) => { proxy.on('proxyReq', (pReq) => { pReq.removeHeader('cookie'); pReq.removeHeader('origin'); }); },
      },
      '/api/tcmb_xml': {
        target: 'https://www.tcmb.gov.tr',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/tcmb_xml/, '/kurlar/today.xml'),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        configure: (proxy) => { proxy.on('proxyReq', (pReq) => { pReq.removeHeader('cookie'); pReq.removeHeader('origin'); }); },
      },
      // KAP (Kamuoyu Aydınlatma Platformu)
      '/api/kap': {
        target: 'https://www.kap.org.tr',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/kap/, ''),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.kap.org.tr/',
        },
        configure: (proxy) => { proxy.on('proxyReq', (pReq) => { pReq.removeHeader('cookie'); pReq.removeHeader('origin'); }); },
      },
      '/api/genelpara': {
        target: 'https://api.genelpara.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/genelpara/, '/embed/doviz.json'),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        configure: (proxy) => { proxy.on('proxyReq', (pReq) => { pReq.removeHeader('cookie'); pReq.removeHeader('origin'); }); },
      },
      // v31.38: İş Yatırım hisse tarama — hisse bazlı yabancı oranı + göreli getiri.
      // Tarayıcı oraya cross-origin POST atamaz; üretimde proxy (source=isy_foreign),
      // yerelde bu kural. /api/isyatirim'den ÖNCE olmalı (önek eşleşmesi).
      '/api/isyatirim-screener': {
        target: 'https://www.isyatirim.com.tr',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/isyatirim-screener/, '/tr-tr/analiz/_Layouts/15/IsYatirim.Website/StockInfo/CompanyInfoAjax.aspx/getScreenerDataNEW'),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.isyatirim.com.tr/tr-tr/analiz/hisse/Sayfalar/gelismis-hisse-arama.aspx',
          'X-Requested-With': 'XMLHttpRequest',
        },
        configure: (proxy) => { proxy.on('proxyReq', (pReq) => { pReq.removeHeader('cookie'); pReq.removeHeader('origin'); }); },
      },
      // İş Yatırım HisseTekil — historical daily OHLCV (must be before /api/isyatirim)
      '/api/isyatirim-hisse': {
        target: 'https://www.isyatirim.com.tr',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/isyatirim-hisse/, '/_layouts/15/Isyatirim.Website/Common/Data.aspx/HisseTekil'),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.isyatirim.com.tr/',
        },
        configure: (proxy) => { proxy.on('proxyReq', (pReq) => { pReq.removeHeader('cookie'); pReq.removeHeader('origin'); }); },
      },
      '/api/isyatirim': {
        target: 'https://www.isyatirim.com.tr',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/isyatirim/, '/_layouts/15/IsYatirim.Website/Common/Data.aspx'),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.isyatirim.com.tr/',
        },
        configure: (proxy) => { proxy.on('proxyReq', (pReq) => { pReq.removeHeader('cookie'); pReq.removeHeader('origin'); }); },
      },
      // BigPara — real-time BIST stock quotes
      '/api/bigpara': {
        target: 'https://bigpara.hurriyet.com.tr',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/bigpara/, '/api/v1'),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://bigpara.hurriyet.com.tr/',
        },
        configure: (proxy) => { proxy.on('proxyReq', (pReq) => { pReq.removeHeader('cookie'); pReq.removeHeader('origin'); }); },
      },
      // Foreks/ParaGaranti — historical OHLCV data
      '/api/foreks': {
        target: 'https://web-paragaranti-pubsub.foreks.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/foreks/, '/web-services'),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.paragaranti.com/',
        },
        configure: (proxy) => { proxy.on('proxyReq', (pReq) => { pReq.removeHeader('cookie'); pReq.removeHeader('origin'); }); },
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
