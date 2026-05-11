# TODO

- [ ] `bman.ta7tur` alt alan adini BorsaMan'e yonlendir.
  - Hedef servis: `http://100.94.85.108:8080/` veya LAN icinde `http://192.168.1.10:8080/`
  - Karar verilecek: DNS saglayicisi, Cloudflare Tunnel / reverse proxy / Tailscale-only erisim
  - Not: Public DNS ile acilacaksa TLS ve erisim kisitlari ayrica ayarlanmali.

- [ ] Guncel repoyu baz alarak tarihsel veri arastirma hattini tamamla.
  - Run oncesi repo/commit kaydi al: branch, commit SHA, bot ID, parametre hash'i.
  - Ciddi skorlamada resmi/lisansli kaynak kullan: Borsa Istanbul DataStore, BIST lisansli veri vendorleri veya kurumsal feed.
  - Ucretsiz/ikincil kaynaklari sadece smoke test ve capraz kontrol icin kullan.
  - Her veri batch'i icin kaynak, export tarihi, sembol listesi, ayarlama politikasi ve veri bosluklarini kaydet.
  - Yapildi: Yahoo QUICK_STOCKS maksimum katman havuzu indirildi (`data/yahoo`, 60 OHLCV dosyasi, 2026-05-02).
  - Manifestler: `data/yahoo/DOWNLOAD_MANIFEST.csv` ve `data/yahoo/DATA_CATALOG.csv`.
  - Sonraki karar: BIST100 icin once `1d_5y`, sonra gerekirse intraday katmanlari indir.

- [x] Binlerce rastgele tarih testi ve sanal bakiye karsilastirmasini standartlastir.
  - `--random-trials`, `--window-days`, `--seed`, `--bot-id` ile tekrar edilebilir deneyler kos.
  - Her bot/variant icin islem bazli metrikleri ayri tut: trade count, win rate, avg win/loss, payoff, expectancy, profit factor.
  - Bakiye gidisatini ayri tut: initial cash, position pct, final balance, net P/L, equity curve, balance drawdown.
  - Robustluk testleri ekle: rolling window, random window, out-of-sample, fee/slippage sensitivity, parametre sensitivity.
  - Standart dosya: `reports/research/SCOREBOARD_STANDARD.md`

- [x] Bot skor defteri standardini RPi'ye yaz.
  - RPi hedefi: `/home/rpi/BorsaMan/reports/research/SCOREBOARD_STANDARD.md`
  - Skor hedefi: `/home/rpi/BorsaMan/reports/research/scoreboard-<bot-id>.json`
  - Skor dosyalarinda `botId`, `variantId`, `runId`, commit SHA, veri kaynagi ve en iyi skorlar bulunmali.
  - Not: RPi'de `node` komutu PATH'te yok; runner'i RPi'de kosmak icin Node kurulumu/PATH ayari ayrica gerekli.

- [ ] Bot skor defterini Google Drive'a yaz.
  - Drive hedefi: kullanicinin belirleyecegi BorsaMan research klasoru.
  - Drive icin daha sonra Google Drive connector/API/rclone secimi yapilacak.

- [ ] Telegram bot kullanici deneyimini canliya al.
  - Yapildi: `docs/telegram-bot-ux.md` ile soru/komut katalogu ve gunluk/haftalik rapor akisi yazildi.
  - Yapildi: `scripts/telegram/telegram-bot.mjs` ile tokensiz lokal test edilebilir Telegram bot iskeleti eklendi.
  - Komutlar: `/durum`, `/katalog`, `/top`, `/sor`, `/kaydet`, `/oneriler`, `/sonuc`, `/hafta`, `/skor`, `/gun_oncesi`, `/gun_sonu`, `/admin`.
  - Furkan ve Erdem icin numeric Telegram user/chat ID alinacak.
  - Ortam degiskenleri: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_IDS`, `TELEGRAM_BROADCAST_CHAT_IDS`.
  - Sonraki adim: RPi'de Node kurulumu/PATH ayari ve systemd servis kurulumu.

- [ ] AI Advisor taramasini merkezi cache mimarisine al.
  - Yapildi: `scripts/advisor/build-advisor-cache.mjs` ile tek arka plan taramasi `reports/advisor/latest.json` uretecek.
  - Yapildi: `server.py` icinde `/api/advisor-cache` ve `/api/advisor-refresh` endpointleri eklendi.
  - Yapildi: React `useAIAdvisor` kullanici basina 648 hisse taramak yerine server cache okur.
  - RPi hedefi: systemd ortam degiskenleriyle concurrency dusuk, interval kontrollu calisacak.

- [ ] Telegram Gemini entegrasyonunu canliya al.
  - Yapildi: `BorsaManTelegram` icinde opsiyonel Gemini notu ve `/ai soru` komutu eklendi.
  - RPi hedefi: mevcut eski config icindeki Gemini/Google API key okunacak ya da `BMAN_GEMINI_API_KEY` verilecek.

- [ ] Web girisini kullanici/parola ile koru.
  - Yapildi: `server.py` session/cookie tabanli login kapisi ekledi.
  - Yapildi: React tarafina `AuthGate` login ekrani eklendi.
  - Yapildi: Parola duz metin tutulmasin diye `scripts/create_web_auth.py` PBKDF2 hash uretici eklendi.
  - Sonraki adim: RPi uzerinde `config/web-auth.json` icin Erdem/Furkan kullanicilari olusturulacak.
