# BorsaMan Telegram Admin Panel

Bu panel sadece admin kullanicilar icindir. Bot uzun backtestleri Telegram
mesajini bekletmeden arka planda baslatir; sonucu `jobId` ile izlersin.

## Gunluk operasyon

```text
/gunluk
/kapanis
/cache
/site
/servis
/sistem
```

- `/gunluk`: Bugunun trade planini uretir.
- `/kapanis`: Hedef/stop/gun sonu ozetini verir.
- `/cache`: AI Advisor server cache durumunu gosterir.
- `/site`: Lokal web servis cevap kontrolu.
- `/servis`: `borsaman`, Telegram ve Cloudflare servislerini kontrol eder.
- `/sistem`: RAM, disk, load ve uptime ozetini verir.

## Backtest baslatma

Kisa deneme:

```text
/test symbols=THYAO,ASELS trials=50 window=252 seed=quick1 bot=telegram-quick
```

Daha ciddi random-window test:

```text
/test symbols=THYAO,ASELS,SISE,EREGL,GARAN trials=1000 window=252 oos=252 thresholds=55,65,75 rr=0,1 costs=0.0015,0.003 bot=telegram-v1 seed=v1
```

Rolling / walk-forward test:

```text
/test mode=rolling symbols=THYAO,SISE,KCHOL fold=252 step=63 oos=252 bot=rolling-v1
```

Daha genis evren:

```text
/test symbols=all limit=100 trials=300 window=252 bot=bist100-sample
```

## Sonuc alma

```text
/testdurum
/testdurum 20260503-153000
/raporlar
/skor
```

- `/testdurum`: Son isi gosterir.
- `/testdurum jobId`: Belirli isi gosterir.
- `/raporlar`: Son scoreboard dosyalarini ve en iyi varyanti listeler.
- `/skor`: En son skor defterini ozetler.

## Parametreler

| Parametre | Anlam |
|---|---|
| `symbols=THYAO,ASELS` | Sembol listesi |
| `symbols=all limit=50` | Veri klasorundeki ilk N sembol |
| `trials=1000` | Random pencere sayisi |
| `window=252` | Random pencere gun/bar sayisi |
| `mode=rolling` | Rolling walk-forward modu |
| `fold=252` | Rolling pencere uzunlugu |
| `step=63` | Rolling pencere adimi |
| `oos=252` | Out-of-sample son pencere |
| `thresholds=55,65,75` | Signal score esikleri |
| `rr=0,1` | Minimum risk/odul esikleri |
| `holds=15,25` | Maksimum elde tutma gunu |
| `stops=0.05` | Fallback stop orani |
| `targets=0.06` | Fallback hedef orani |
| `costs=0.0015,0.003` | Komisyon/slippage maliyet senaryolari |
| `cash=100000` | Sanal baslangic bakiyesi |
| `pos=0.25` | Islem basina bakiye orani |
| `mintrades=3` | Skora dahil olmak icin minimum kapanan islem |
| `bot=bot-v1` | Skor defteri bot kimligi |
| `seed=deneme1` | Tekrarlanabilir random seed |

## Dokumanlar

```text
/dokuman
/dokuman komutlar
/dokuman backtest
/dokuman skor
/dokuman sonuc
```

## Guvenlik ve limitler

- Komutlar sadece admin chat/user ID'leri icin calisir.
- Bot shell komutu kurmaz; backtest `subprocess` arguman listesiyle baslatilir.
- `trials` ve sembol sayisi config limitleri ile sinirlanir.
- Gercek token/config/state dosyalari git'e alinmaz.

