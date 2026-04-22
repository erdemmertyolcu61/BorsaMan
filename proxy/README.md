# BIST Proxy Server

Kendı CORS proxy backend - BIST AI Trading Terminal için optimize edilmiş veri proxy sunucusu ve WebSocket canlı veri stream'i.

## Ozellikler

- **CORS Proxy**: Tüm BIST veri kaynaklarına sorunsuz erisim
- **WebSocket Server**: Gercek zamanlı fiyat guncellemeleri
- **In-Memory Cache**: Verimli veri yonetimi
- **Rate Limiting**: Abuse koruması
- **Vercel Uyumlu**: Serverless deployment desteği

## Kurulum

```bash
cd proxy
npm install
cp .env.example .env
npm run dev        # HTTP + WebSocket birlikte
# veya
npm run start      # Sadece HTTP
npm run ws         # Sadece WebSocket
```

## API Endpoints

### HTTP API

| Endpoint | Method | Aciklaması |
|----------|--------|------------|
| `/api/yahoo/:symbol` | GET | Yahoo Finance OHLCV verisi |
| `/api/isyatirim/:symbol` | GET | İş Yatırım historical verisi |
| `/api/quote/:symbol` | GET | BigPara canlı fiyat |
| `/api/bist/list` | GET | BIST hisse listesi |
| `/api/quotes/batch` | POST | Toplu fiyat sorgusu |
| `/api/health` | GET | Sunucu saglık durumu |

### WebSocket API

```javascript
// Baglan
const ws = new WebSocket('ws://localhost:8080');

// Abone ol
ws.send(JSON.stringify({
  type: 'subscribe',
  symbols: ['THYAO', 'ASELS', 'AKBNK']
}));

// Canlı veri al
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'quotes') {
    console.log('Guncel fiyatlar:', data.data);
  }
};

// Aboneligi iptal et
ws.send(JSON.stringify({
  type: 'unsubscribe',
  symbols: ['THYAO']
}));
```

## Vercel Deployment

```bash
cd proxy
vercel deploy
```

Ortam değişkeni ayarla:
```bash
vercel env add ALLOWED_ORIGINS
# Deger: https://bist-terminal.vercel.app
```

## Frontend Entegrasyonu

### 1. Proxy URL Ayarla

```javascript
import { setProxyBaseUrl } from './utils/fetchEngine';

// Local gelistirme
setProxyBaseUrl('http://localhost:3001');

// Vercel deployment
setProxyBaseUrl('https://your-proxy.vercel.app');
```

### 2. WebSocket Kullanımı

```javascript
import { useWebSocket } from './hooks/useWebSocket';

function MyComponent() {
  const { quotes, subscribe, unsubscribe } = useWebSocket({
    url: 'ws://localhost:8080',
    symbols: ['THYAO', 'ASELS'],
    onMessage: (data) => console.log(data),
  });

  return (
    <div>
      {quotes.map(q => (
        <div key={q.symbol}>{q.symbol}: {q.price}</div>
      ))}
    </div>
  );
}
```

## Mimari

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (React)                         │
├─────────────────────────────────────────────────────────────┤
│  fetchEngine.js          │  useWebSocket.js                │
│  ─────────────           │  ───────────────                │
│  • Self-hosted proxy     │  • WebSocket client            │
│  • Rate limit bypass     │  • Auto-reconnect              │
│  • Cache yonetimi        │  • Subscription management     │
└───────────────┬───────────┴────────────────┬──────────────┘
                │                            │
    ┌───────────▼───────────┐    ┌───────────▼───────────┐
    │   Express Server      │    │   WebSocket Server    │
    │   (HTTP API)          │    │   (Canlı Veri)        │
    │   Port: 3001          │    │   Port: 8080          │
    ├───────────────────────┤    ├───────────────────────┤
    │   • Yahoo Finance      │    │   • BigPara quotes    │
    │   • İş Yatırım         │    │   • Yahoo charts      │
    │   • BigPara            │    │   • BIST indices      │
    │   • Rate limiting      │    │   • 5 saniye interval │
    │   • 5 dakika cache     │    │   • Auto-reconnect    │
    └───────────┬───────────┘    └───────────┬───────────┘
                │                            │
    ┌───────────▼────────────────────────────▼───────────┐
    │                   External APIs                    │
    │   Yahoo Finance  │  İş Yatırım  │  BigPara        │
    └────────────────────────────────────────────────────┘
```

## Performance

- **Cache Hit**: ~5ms yanıt süresi
- **API Call**: ~200-500ms (CORS bypass ile)
- **WebSocket Latency**: ~50-100ms
- **Rate Limit**: 100 istek/dakika/kullanıcı

## Ornek Kullanim

### Terminal'den Test

```bash
# Health check
curl http://localhost:3001/api/health

# Hisse verisi
curl "http://localhost:3001/api/yahoo/THYAO?range=6mo"

# Canlı fiyat
curl "http://localhost:3001/api/quote/THYAO"

# Toplu fiyatlar
curl -X POST "http://localhost:3001/api/quotes/batch" \
  -H "Content-Type: application/json" \
  -d '{"symbols":["THYAO","ASELS","AKBNK"]}'
```

### WebSocket Test

```bash
# wscat ile test
npx wscat -c ws://localhost:8080
> {"type":"subscribe","symbols":["THYAO","ASELS"]}
< {"type":"quotes","data":[...]}
```
