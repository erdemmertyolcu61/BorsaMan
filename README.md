# BIST AI Trading Terminal

Borsa Istanbul (BIST) hisse senedi analiz terminali — teknik analiz, AI yorumlari, backtest, portfoy takibi.

## Hizli Baslatma

```bash
# Dosyayi tarayicida ac
open index.html
# veya
python3 -m http.server 8080
# sonra http://localhost:8080 adresine git
```

## Claude Code ile Gelistirme

### 1. Claude Code Kur
```bash
npm install -g @anthropic-ai/claude-code
```

### 2. Projeye Gir
```bash
cd bist-terminal-project
claude
```

### 3. Claude Code'a Sor
Claude Code, CLAUDE.md dosyasini otomatik okur ve projenin baglamini bilir.

Ornek komutlar:
- `"Veri cekme hata oranini dusur"`
- `"Yeni bir gosterge ekle: Stochastic RSI"`
- `"Backtest motorunu gelistir, trailing stop stratejisi ekle"`
- `"Kendi CORS proxy backend'imi yaz, Vercel'e deploy et"`
- `"React'e gecir, component yapisi olustur"`

## Proje Yapisi

```
bist-terminal-project/
├── CLAUDE.md          # Claude Code icin proje baglami
├── README.md          # Bu dosya
├── index.html         # Ana uygulama (tek dosya)
└── (gelecekte)
    ├── proxy/         # Kendi CORS proxy backend
    │   ├── api/
    │   │   └── proxy.js
    │   └── vercel.json
    ├── src/           # React gecisi
    │   ├── components/
    │   ├── hooks/
    │   └── utils/
    └── package.json
```

## Ozellikler

| Ozellik | Durum |
|---------|-------|
| Teknik gostergeler (RSI, MACD, BB, MA) | ✅ |
| Akilli para analizi (MFI, OBV, VWAP) | ✅ |
| Setup pattern tespiti (8 pattern) | ✅ |
| AL/SAT sinyal motoru | ✅ |
| Monte Carlo simulasyonu | ✅ |
| Trailing stop stratejisi | ✅ |
| Inline backtest (4 strateji) | ✅ |
| Sanal portfoy | ✅ |
| Watchlist + fiyat alarmlari | ✅ |
| Sektor rotasyonu | ✅ |
| Temel analiz (F/K, PD/DD) | ✅ |
| Claude AI uzman yorumu | ✅ |
| Intraday trade firsatlari | ✅ |
| Kendi CORS proxy | 📋 Planli |
| React/Next.js gecisi | 📋 Planli |
| Mobil uygulama (PWA/Capacitor) | 📋 Planli |

## Lisans

Kisisel kullanim. Yatirim tavsiyesi degildir.
