import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: parseInt(process.env.PORT || '5173'),
    open: false,
    proxy: {
      '/yahoo/v8': {
        target: 'https://query1.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/yahoo\/v8/, '/v8'),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      },
      '/yahoo/v7': {
        target: 'https://query2.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/yahoo\/v7/, '/v7'),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      },
      '/yahoo/v10': {
        target: 'https://query1.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/yahoo\/v10/, '/v10'),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      },
      '/api/tcmb': {
        target: 'https://www.tcmb.gov.tr',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/tcmb/, '/wps/wcm/connect/TR/TCMB+TR'),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      },
      '/api/ff_calendar_next': {
        target: 'https://nfs.faireconomy.media',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/ff_calendar_next/, '/ff_calendar_nextweek.json'),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      },
      '/api/ff_calendar': {
        target: 'https://nfs.faireconomy.media',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/ff_calendar/, '/ff_calendar_thisweek.json'),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      },
      '/api/tcmb_xml': {
        target: 'https://www.tcmb.gov.tr',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/tcmb_xml/, '/kurlar/today.xml'),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      },
      '/api/genelpara': {
        target: 'https://api.genelpara.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/genelpara/, '/embed/doviz.json'),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
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
      },
      '/api/isyatirim': {
        target: 'https://www.isyatirim.com.tr',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/isyatirim/, '/_layouts/15/IsYatirim.Website/Common/Data.aspx'),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.isyatirim.com.tr/',
        },
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
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
