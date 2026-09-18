//! Port of genSignal's pure core (src/utils/signals.js).
//!
//! Two phases because the learned calibration model lives in JS
//! (signalCalibration.js, rebuilt from the user's own signal history):
//!   begin  — everything up to the normalized score (lines "MA" .. "NORMALIZE")
//!   finish — classification, guards, stop / targets, hold estimate, long-term
//!            view, intraday metrics — using the score after JS calibration.
//! The Wall Street meta layer, reliability hints and signal attribution run in
//! JS afterwards (they depend on the clock, the locale and learned JS state).

use crate::ind::{calc_atr, calc_fibonacci, calc_pivots, Bar, Fibs, Indicators, Pivots, Supertrend, Trix, VolProfile};
use crate::js::{self, to_fixed as tf, V};
use crate::json::{Jv, J};
use crate::regime;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum C {
    Neutral,
    Bull,
    Bear,
}

impl C {
    fn name(self) -> &'static str {
        match self {
            C::Neutral => "neutral",
            C::Bull => "bullish",
            C::Bear => "bearish",
        }
    }
}

/// Insertion-ordered set (JS Set semantics for iteration / join).
#[derive(Clone, Debug, Default)]
pub struct OSet(Vec<&'static str>);

impl OSet {
    fn add(&mut self, s: &'static str) {
        if !self.0.contains(&s) {
            self.0.push(s);
        }
    }
    fn has(&self, s: &str) -> bool {
        self.0.iter().any(|x| *x == s)
    }
    fn len(&self) -> usize {
        self.0.len()
    }
    fn join(&self) -> String {
        self.0.join(", ")
    }
}

#[derive(Clone, Debug)]
pub struct Htf {
    trend: Option<String>,
    weekly: Option<String>,
    adx: V,
    rsi: V,
    ma200: Option<bool>,
    weekly_rsi: V,
}

impl Htf {
    fn trend_is(&self, s: &str) -> bool {
        self.trend.as_deref() == Some(s)
    }
    fn weekly_is(&self, s: &str) -> bool {
        self.weekly.as_deref() == Some(s)
    }
}

#[derive(Clone, Debug)]
pub struct Kap {
    score: V,
    headline: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Opts {
    kap: Option<Kap>,
    htf: Option<Htf>,
    sector: V,
}

/// The JS wrapper validates types and omits falsy / undefined values before
/// serializing, so an absent key here always means `undefined` in JS.
pub fn parse_opts(j: &Jv) -> Opts {
    let htf = j.get("htfContext").map(|h| Htf {
        trend: h.s("trend").map(String::from),
        weekly: h.s("weeklyTrend").map(String::from),
        adx: h.v("adx"),
        rsi: h.v("rsi"),
        ma200: if h.is_true("ma200Above") {
            Some(true)
        } else if h.is_false("ma200Above") {
            Some(false)
        } else {
            None
        },
        weekly_rsi: h.v("weeklyRsi"),
    });
    let kap = j.get("kapSentiment").map(|k| Kap { score: k.v("score"), headline: k.s("headline").map(String::from) });
    Opts { kap, htf, sector: j.v("sectorStrength") }
}

pub struct Pending {
    raw_score: f64,
    reasons: Vec<(String, C)>,
    bull: OSet,
    bear: OSet,
    atr: V,
    fibs: Option<Fibs>,
    pivots: Pivots,
    regime_is_trend: bool,
    regime_is_volatile: bool,
    htf: Option<Htf>,
}

/// Result of phase one, handed to the JS calibration step.
pub struct Begin {
    pub score100: f64,
    pub provisional: &'static str,
    pub regime: Option<&'static str>,
}

fn is_js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
            | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

fn has(h: &str, p: &str) -> bool {
    h.contains(p)
}

/// `/<p>\s/i` (patterns are ASCII without self-overlap, so non-overlapping
/// match_indices sees every occurrence the regex would try)
fn has_ws(h: &str, p: &str) -> bool {
    h.match_indices(p).any(|(i, _)| h[i + p.len()..].chars().next().map_or(false, is_js_ws))
}

/// `/MA-\d/i`
fn has_ma_digit(h: &str) -> bool {
    h.match_indices("ma-").any(|(i, _)| h.as_bytes().get(i + 3).map_or(false, |b| b.is_ascii_digit()))
}

/// The reason → indicator-category classifier (regex chain in genSignal).
/// JS `/i` without the `u` flag folds ASCII letters only, which is exactly
/// `to_ascii_lowercase` on the haystack.
fn classify(text: &str) -> Option<&'static str> {
    let low = text.to_ascii_lowercase();
    let h = low.as_str();
    if has_ma_digit(h) || has(h, "golden") || has(h, "death") {
        return Some("MA");
    }
    if has_ws(h, "rsi") {
        return Some("RSI");
    }
    if has(h, "macd") || has(h, "histogram") {
        return Some("MACD");
    }
    if has(h, "stochrsi") {
        return Some("STOCH");
    }
    if has(h, "bollinger") || has(h, "bb") {
        return Some("BBAND");
    }
    if has(h, "hacim") || has(h, "vpvr") {
        return Some("VOL");
    }
    if ["mfi", "obv", "cmf", "vwap", "wyckoff", "akilli", "birikim", "dagilim"].iter().any(|p| has(h, p)) {
        return Some("SMART");
    }
    if has(h, "adx") || has_ws(h, "di") || has_ws(h, "trend") {
        return Some("ADX");
    }
    if has(h, "ttm") || has(h, "squeeze") {
        return Some("TTM");
    }
    if ["diverjans", "klimaks", "spring", "utad"].iter().any(|p| has(h, p)) {
        return Some("DIVERGENCE");
    }
    if has(h, "pivot") {
        return Some("PIVOT");
    }
    if has(h, "setup") {
        return Some("SETUP");
    }
    if has(h, "kap") {
        return Some("KAP");
    }
    if has(h, "mtf") {
        return Some("MTF");
    }
    if has(h, "sektor") {
        return Some("SECTOR");
    }
    None
}

struct Setup {
    name: &'static str,
    desc: String,
    score: f64,
}

fn detect_setups(b: &[Bar], ind: &Indicators) -> Vec<Setup> {
    let mut out = Vec::new();
    let p = ind.last_close;
    let n = b.len();
    let ni = n as isize;
    let (bu, bl, bm) = (ind.last_bu(), ind.last_bl(), ind.last_bm());
    if bu.truthy() && bl.truthy() && bm.truthy() {
        let bw = (bu.num() - bl.num()) / bm.num();
        if bw < 0.04 {
            out.push(Setup {
                name: "Bollinger Sikisma",
                desc: format!("Bantlar dar ({}%). Sert hareket kapida.", tf(bw * 100.0, 1)),
                score: 1.5,
            });
        }
    }
    let rsi = ind.last_rsi();
    if rsi.truthy() && rsi.num() < 32.0 && !ind.sr.is_empty() {
        let near = ind.sr.iter().any(|s| !s.res && (s.price - p).abs() / p < 0.02);
        if near {
            out.push(Setup {
                name: "Asiri Satim Sicramasi",
                desc: format!("RSI {} + destek seviyesinde.", tf(rsi.num(), 1)),
                score: 2.0,
            });
        }
    }
    if n >= 10 {
        let pl1 = js::min(js::min(b[n - 5].l, b[n - 4].l), b[n - 3].l);
        let pl2 = js::min(js::min(b[n - 10].l, b[n - 9].l), b[n - 8].l);
        let m_now = js::at(&ind.macd, ni - 1);
        let m_prev = js::at(&ind.macd, ni - 6);
        if !m_now.nullish() && !m_prev.nullish() && pl1 < pl2 && m_now.num() > m_prev.num() {
            out.push(Setup {
                name: "MACD Yükseliş Diverjans",
                desc: "Fiyat dusuk dip yaparken MACD yukseliyor.".to_string(),
                score: 2.0,
            });
        }
    }
    if ind.change_pct > 1.0 && ind.vol_ratio > 2.0 {
        out.push(Setup {
            name: "Hacim Kirilimi",
            desc: format!("Fiyat +{}% hacim {}x.", tf(ind.change_pct, 1), tf(ind.vol_ratio, 1)),
            score: 3.0,
        });
    }
    if n >= 4 {
        let (a1, b1) = (js::at(&ind.ma20, ni - 1), js::at(&ind.ma50, ni - 1));
        let (a4, b4) = (js::at(&ind.ma20, ni - 4), js::at(&ind.ma50, ni - 4));
        if a1.truthy() && b1.truthy() && a1.num() > b1.num() && a4.truthy() && b4.truthy() && a4.num() < b4.num() {
            out.push(Setup {
                name: "Taze Golden Cross",
                desc: "MA-20 son 3 gunde MA-50 yi yukari kirdi.".to_string(),
                score: 2.0,
            });
        }
    }
    let ma200 = ind.last_ma200();
    if ma200.truthy() && p > ma200.num() {
        let prev5 = js::atf(&ind.closes, ni - 5);
        if prev5.truthy() && prev5.num() < js::at(&ind.ma200, ni - 5).num() {
            out.push(Setup {
                name: "MA-200 Geri Kazanimi",
                desc: "Fiyat uzun vadeli trendi yukari kirdi.".to_string(),
                score: 2.0,
            });
        }
    }
    if n >= 20 {
        let lows: Vec<f64> = b[n - 20..].iter().map(|x| x.l).collect();
        let min_low = js::min_all(lows.iter().copied());
        let dips = lows.iter().filter(|l| (**l - min_low).abs() / min_low < 0.01).count();
        if dips >= 2 && p > min_low * 1.01 {
            out.push(Setup {
                name: "Cift Dip Formasyonu",
                desc: "Son 20 barda 2 dip. Guclu destek.".to_string(),
                score: 1.5,
            });
        }
    }
    // calcOBVTrend(calcOBV(prices), ind.closes, 20) == ind.obvTrend (same inputs)
    if ind.obv_trend == "distribution" {
        out.push(Setup {
            name: "Dağılım Uyarisi",
            desc: "Fiyat yukselirken OBV dusuyor. Akilli para cikiyor.".to_string(),
            score: -2.0,
        });
    }
    if ind.obv_trend == "accumulation" {
        out.push(Setup {
            name: "Akilli Para Birikimi",
            desc: "Fiyat dusukken OBV yukseliyor. Kurumsal birikim.".to_string(),
            score: 2.0,
        });
    }
    out
}

/// Phase one: genSignal from the top to the 0-100 normalization.
pub fn begin(b: &[Bar], ind: &Indicators, opts: Opts) -> (Pending, Begin) {
    let n = b.len();
    let ni = n as isize;
    let mut score = 0.0f64;
    let mut rs: Vec<(String, C)> = Vec::new();
    let p = ind.last_close;
    let atr = calc_atr(b, 14);
    let fibs = calc_fibonacci(b);
    let pivots = calc_pivots(b);
    let regime = regime::detect_market_regime(b, ind);
    let th = regime::get_adaptive_thresholds(&regime);
    let w = regime::weights(&regime);
    let hidden = regime::detect_hidden_divergence(b, ind);
    let rl = regime.label_text();

    let ma20 = ind.last_ma20();
    let ma50 = ind.last_ma50();
    let ma200 = ind.last_ma200();
    let rsi = ind.last_rsi();

    // ── MA ──
    if ma20.truthy() {
        if p > ma20.num() {
            score += 1.0;
            rs.push((format!("Fiyat MA-20 ({}) ustunde", tf(ma20.num(), 2)), C::Bull));
        } else {
            score -= 1.0;
            rs.push((format!("Fiyat MA-20 ({}) altinda", tf(ma20.num(), 2)), C::Bear));
        }
    }
    if ma50.truthy() {
        if p > ma50.num() {
            score += 1.0;
            rs.push(("Fiyat MA-50 ustunde".into(), C::Bull));
        } else {
            score -= 1.0;
            rs.push(("Fiyat MA-50 altinda".into(), C::Bear));
        }
    }
    if ma20.truthy() && ma50.truthy() {
        if ma20.num() > ma50.num() {
            score += 1.0;
            rs.push(("MA-20 > MA-50 Golden cross".into(), C::Bull));
        } else {
            score -= 1.0;
            rs.push(("MA-20 < MA-50 Death cross".into(), C::Bear));
        }
    }
    if ma200.truthy() {
        if p > ma200.num() {
            score += 0.5;
            rs.push(("Fiyat MA-200 ustunde".into(), C::Bull));
        } else {
            score -= 0.5;
            rs.push(("Fiyat MA-200 altinda".into(), C::Bear));
        }
    }

    // ── RSI (adaptive) ──
    if !rsi.nullish() {
        let r = rsi.num();
        let rw = w.rsi;
        let r1 = tf(r, 1);
        if r < th.rsi_oversold - 10.0 {
            score += 2.5 * rw;
            rs.push((format!("RSI {} — Asiri satim (Adaptif: {})", r1, tf(th.rsi_oversold, 0)), C::Bull));
        } else if r < th.rsi_oversold {
            score += 1.5 * rw;
            rs.push((format!("RSI {} — Satis baskisi azaliyor ({})", r1, rl), C::Bull));
        } else if r < th.rsi_weak_oversold {
            score += 0.5 * rw;
            rs.push((format!("RSI {} — Zayif ama iyilesme", r1), C::Bull));
        } else if r > th.rsi_very_overbought {
            score -= 2.5 * rw;
            rs.push((format!("RSI {} — Asiri alim ({})", r1, rl), C::Bear));
        } else if r > th.rsi_overbought {
            score -= 1.0 * rw;
            rs.push((format!("RSI {} — Yukari gerilmis", r1), C::Bear));
        } else {
            rs.push((format!("RSI {} — Normal bolge", r1), C::Neutral));
        }
    }

    // ── hidden divergence ──
    match hidden {
        Some("BULLISH_HIDDEN") => {
            score += 2.0;
            rs.push(("GIZLI YUKARI DIVERGANS — Trend devami".into(), C::Bull));
        }
        Some("BEARISH_HIDDEN") => {
            score -= 2.0;
            rs.push(("GIZLI ASAGI DIVERGANS — Trend devami".into(), C::Bear));
        }
        _ => {}
    }

    // ── Stochastic RSI ──
    let (skv, sdv) = (ind.last_stoch_k(), ind.last_stoch_d());
    if !skv.nullish() && !sdv.nullish() {
        let (sk, sd) = (skv.num(), sdv.num());
        let len = ind.stoch_k.len() as isize;
        let prev_k = if len >= 2 { js::at(&ind.stoch_k, len - 2) } else { V::N };
        let prev_d = if len >= 2 { js::at(&ind.stoch_d, len - 2) } else { V::N };
        if sk < 20.0 && sd < 20.0 {
            score += 1.5;
            rs.push((format!("StochRSI {}/{} — Asiri satim bolgesi", tf(sk, 0), tf(sd, 0)), C::Bull));
        } else if sk > 80.0 && sd > 80.0 {
            score -= 1.5;
            rs.push((format!("StochRSI {}/{} — Asiri alim bolgesi", tf(sk, 0), tf(sd, 0)), C::Bear));
        }
        let have_prev = !prev_k.nullish() && !prev_d.nullish();
        if have_prev && prev_k.num() <= prev_d.num() && sk > sd && sk < 50.0 {
            score += 1.0;
            rs.push(("StochRSI yukari kesiyor — Alim sinyali".into(), C::Bull));
        } else if have_prev && prev_k.num() >= prev_d.num() && sk < sd && sk > 50.0 {
            score -= 1.0;
            rs.push(("StochRSI asagi kesiyor — Satim sinyali".into(), C::Bear));
        }
    }

    // ── MACD ──
    let (lm, ls, lh) = (ind.last_macd(), ind.last_macd_sig(), ind.last_macd_hist());
    if !lm.nullish() && !ls.nullish() {
        if lm.num() > ls.num() {
            score += 1.0;
            rs.push(("MACD sinyal ustunde".into(), C::Bull));
        } else {
            score -= 1.0;
            rs.push(("MACD sinyal altinda".into(), C::Bear));
        }
        let hl = ind.macd_hist.len() as isize;
        let ph2 = js::at(&ind.macd_hist, hl - 2);
        if lh.num() > 0.0 && !ph2.nullish() && lh.num() > ph2.num() {
            score += 0.5;
            rs.push(("Histogram artiyor".into(), C::Bull));
        }
        if lh.num() < 0.0 && !ph2.nullish() && lh.num() > ph2.num() {
            score += 0.5;
            rs.push(("Histogram daraliyor".into(), C::Bull));
        }
        if ind.macd.len() >= 2 {
            let ml = ind.macd.len() as isize;
            let prev = js::at(&ind.macd, ml - 2);
            if !prev.nullish() {
                if prev.num() <= 0.0 && lm.num() > 0.0 {
                    score += 1.5;
                    rs.push(("MACD sifir cizgisini yukari kirdi — trend donusu".into(), C::Bull));
                } else if prev.num() >= 0.0 && lm.num() < 0.0 {
                    score -= 1.5;
                    rs.push(("MACD sifir cizgisini asagi kirdi — trend donusu".into(), C::Bear));
                }
            }
        }
    }

    // ── Bollinger ──
    let (bu, bl, bm) = (ind.last_bu(), ind.last_bl(), ind.last_bm());
    if bl.truthy() && bu.truthy() {
        let width = (bu.num() - bl.num()) / bm.num();
        if width < 0.05 {
            score += 0.5;
            rs.push(("Bollinger sikisma".into(), C::Neutral));
        }
        if p <= bl.num() * 1.01 {
            score += 1.5;
            rs.push(("Bollinger alt bandinda".into(), C::Bull));
        } else if p >= bu.num() * 0.99 {
            score -= 1.5;
            rs.push(("Bollinger ust bandinda — geri cekilme olasiligi".into(), C::Bear));
        }
    }

    // ── Volume (adaptive) ──
    let vw = w.volume;
    let overbought = rsi.or(50.0) > 68.0 || ind.mfi.or(50.0) > 65.0;
    let vmult = if overbought { 0.3 } else { 1.0 };
    let vr = ind.vol_ratio;
    let vr1 = tf(vr, 1);
    if vr > th.volume_explosion {
        score += 3.0 * vw * vmult;
        rs.push((
            format!("Hacim {}x — {} ({})", vr1, if overbought { "DAGILIM RISKI" } else { "KURUMSAL PATLAMA" }, rl),
            if overbought { C::Bear } else { C::Bull },
        ));
    } else if vr > th.volume_spike {
        score += 2.0 * vw * vmult;
        rs.push((format!("Hacim {}x — {}", vr1, if overbought { "Dikkat" } else { "Guclu" }), if overbought { C::Neutral } else { C::Bull }));
    } else if vr > 1.3 {
        score += 1.0 * vw * vmult;
        rs.push((format!("Hacim {}x", vr1), C::Bull));
    } else if vr < th.volume_low {
        score -= 1.0;
        rs.push(("Hacim dusuk — Ilgisizlik".into(), C::Neutral));
    }
    if ind.change_pct > 2.0 && vr > 1.5 && !overbought {
        score += 2.0;
        rs.push(("MOMENTUM KIRILIMI: Hacimli yukselis onayi".into(), C::Bull));
    }

    // ── smart money ──
    if !ind.mfi.nullish() {
        let m = ind.mfi.num();
        let m0 = tf(m, 0);
        if m < 20.0 {
            score += 3.0;
            rs.push((format!("MFI {} — Kurumsal asiri satim (2x agirlik)", m0), C::Bull));
        } else if m > 80.0 {
            score -= 3.0;
            rs.push((format!("MFI {} — Kar realizasyonu gerilimi", m0), C::Bear));
        } else if m < 35.0 {
            score += 1.0;
            rs.push((format!("MFI {} — Birikim bolgesi", m0), C::Bull));
        } else if m > 65.0 {
            score -= 1.0;
            rs.push((format!("MFI {} — Asiri alima yakin", m0), C::Bear));
        }
    }
    if ind.obv_trend == "accumulation" {
        score += if overbought { 1.0 } else { 3.0 };
        rs.push((
            format!("OBV Birikim — {}", if overbought { "Dikkat: overbought + birikim = olasi dagilim" } else { "Akilli para aliyor" }),
            if overbought { C::Neutral } else { C::Bull },
        ));
    } else if ind.obv_trend == "distribution" {
        score -= 3.0;
        rs.push(("OBV Dagilim — Akilli para satiyor (2x agirlik)".into(), C::Bear));
    } else if ind.obv_trend == "confirmation" {
        score += 1.0;
        rs.push(("OBV Teyit — Fiyat-hacim uyumu".into(), C::Bull));
    }
    if ind.vwap.truthy() && p > ind.vwap.num() {
        score += 0.5;
        rs.push(("VWAP ustunde — Alicilar guclu".into(), C::Bull));
    } else if ind.vwap.truthy() && p < ind.vwap.num() {
        score -= 0.5;
        rs.push(("VWAP altinda — Saticilar guclu".into(), C::Bear));
    }
    if !ind.cmf.nullish() {
        let c = ind.cmf.num();
        let c2 = tf(c, 2);
        if c > 0.15 {
            score += 2.0;
            rs.push((format!("CMF +{} — Guclu para girisi (2x)", c2), C::Bull));
        } else if c < -0.15 {
            score -= 2.0;
            rs.push((format!("CMF {} — Guclu para cikisi (2x)", c2), C::Bear));
        } else if c > 0.05 {
            score += 0.5;
            rs.push((format!("CMF +{} — Hafif para girisi", c2), C::Bull));
        } else if c < -0.05 {
            score -= 0.5;
            rs.push((format!("CMF {} — Hafif para cikisi", c2), C::Bear));
        }
    }

    // ── RSI + MFI divergence ──
    if !rsi.nullish() && !ind.mfi.nullish() {
        let (r, m) = (rsi.num(), ind.mfi.num());
        if ind.change_pct > 1.0 && r < 50.0 && m < 45.0 {
            score -= 1.5;
            rs.push(("BEARISH DIVERJANS: Fiyat yuksek ama momentum zayifliyor".into(), C::Bear));
        }
        if ind.change_pct < -1.0 && r > 35.0 && m > 30.0 {
            score += 1.5;
            rs.push(("BULLISH DIVERJANS: Fiyat dusuk ama momentum toplaniyor".into(), C::Bull));
        }
    }

    // ── advanced divergences ──
    match ind.obv_div {
        Some("bullish_div") => {
            score += 2.0;
            rs.push(("OBV BULLISH DIVERJANS: Fiyat dusuk dip, OBV yuksek dip — gizli alim".into(), C::Bull));
        }
        Some("bearish_div") => {
            score -= 2.0;
            rs.push(("OBV BEARISH DIVERJANS: Fiyat yuksek tepe, OBV dusuk tepe — gizli satim".into(), C::Bear));
        }
        Some("hidden_bullish") => {
            score += 1.0;
            rs.push(("OBV GIZLI YUKSELIS: Trend devam sinyali".into(), C::Bull));
        }
        Some("hidden_bearish") => {
            score -= 1.0;
            rs.push(("OBV GIZLI DUSUS: Trend devam sinyali".into(), C::Bear));
        }
        _ => {}
    }
    match ind.rsi_div {
        Some("bullish") => {
            score += 2.0;
            rs.push(("RSI BULLISH DIVERJANS: Fiyat dusuk dip, RSI yuksek dip — donus yakin".into(), C::Bull));
        }
        Some("bearish") => {
            score -= 2.0;
            rs.push(("RSI BEARISH DIVERJANS: Fiyat yuksek tepe, RSI dusuk tepe — zirve riski".into(), C::Bear));
        }
        _ => {}
    }
    // Wyckoff spring / volume climax / DI convergence: the JS compares objects
    // to strings (`ind.wyckoffSpring === 'spring'`), so those rules never fire.

    match ind.wyckoff_phase {
        "accumulation" => {
            score += 1.0;
            rs.push(("Wyckoff: BIRIKIM FAZI — Kurumsal pozisyon olusumu".into(), C::Bull));
        }
        "markup" => {
            score += 0.5;
            rs.push(("Wyckoff: YUKSELIS FAZI — Trend devam".into(), C::Bull));
        }
        "distribution" => {
            score -= 1.0;
            rs.push(("Wyckoff: DAGILIM FAZI — Kurumsal cikis basladi".into(), C::Bear));
        }
        "markdown" => {
            score -= 0.5;
            rs.push(("Wyckoff: DUSUS FAZI — Satim baskisi".into(), C::Bear));
        }
        _ => {}
    }

    // ── ADX ──
    let adx = ind.adx;
    let is_trending = !adx.nullish() && adx.num() > 25.0;
    let is_ranging = !adx.nullish() && adx.num() < 20.0;
    if !adx.nullish() {
        let a0 = tf(adx.num(), 0);
        if is_trending && ind.plus_di.num() > ind.minus_di.num() {
            score += 1.0;
            rs.push((format!("ADX {} Trend YUKSELIS (+DI>{})", a0, js::v_fixed(ind.plus_di, 0)), C::Bull));
        } else if is_trending && ind.minus_di.num() > ind.plus_di.num() {
            score -= 1.0;
            rs.push((format!("ADX {} Trend DUSUS (-DI>{})", a0, js::v_fixed(ind.minus_di, 0)), C::Bear));
        } else if is_ranging {
            rs.push((format!("ADX {} — Yatay piyasa (range)", a0), C::Neutral));
        } else {
            rs.push((format!("ADX {} — Zayif trend", a0), C::Neutral));
        }
    }

    // ── TTM ──
    if ind.ttm.firing {
        if ind.ttm.momentum > 0.0 {
            score += 1.5;
            rs.push(("TTM SQUEEZE ATIYOR — Yükseliş patlamasi".into(), C::Bull));
        } else {
            score -= 1.5;
            rs.push(("TTM SQUEEZE ATIYOR — Düşüş patlamasi".into(), C::Bear));
        }
    } else if ind.ttm.on {
        score += 0.3;
        rs.push(("Bollinger sikisma (Keltner icinde) — Patlama yaklasiyor".into(), C::Neutral));
    }

    // ── VPVR ──
    let poc = ind.vp.poc();
    if poc.truthy() {
        let pv = poc.num();
        let dist = (p - pv) / pv * 100.0;
        let p2 = tf(pv, 2);
        if dist > 0.0 && dist < 3.0 {
            score += 2.5;
            rs.push((format!("VPVR DESTEGI: Fiyat Kurumsal POC maliyetine ({}) cok yakin — Guclu destek", p2), C::Bull));
        } else if dist < 0.0 && dist > -3.0 {
            score -= 2.5;
            rs.push((format!("VPVR DIRENCI: Fiyat Kurumsal POC maliyetinin ({}) altinda — Guclu direnc", p2), C::Bear));
        } else if dist >= 3.0 {
            score += 0.5;
            rs.push((format!("VPVR: Fiyat ana maliyetlenmenin ({}) ustunde", p2), C::Bull));
        } else if dist <= -3.0 {
            score -= 0.5;
            rs.push((format!("VPVR: Fiyat ana maliyetlenmenin ({}) altinda", p2), C::Bear));
        }
    }

    // ── confluence over the reasons so far ──
    let mut bull = OSet::default();
    let mut bear = OSet::default();
    for (t, c) in &rs {
        if let Some(cat) = classify(t) {
            match c {
                C::Bull => bull.add(cat),
                C::Bear => bear.add(cat),
                C::Neutral => {}
            }
        }
    }
    if bull.len() >= 6 && bear.len() <= 2 {
        score += 2.0;
        rs.push((format!("GUCLU COKLU TEYIT: {} bagimsiz gosterge uyumlu ({})", bull.len(), bull.join()), C::Bull));
    } else if bull.len() >= 5 && bear.len() <= 2 {
        score += 1.0;
        rs.push((format!("COKLU TEYIT: {} bagimsiz gosterge uyumlu", bull.len()), C::Bull));
    } else if bear.len() >= 6 && bull.len() <= 2 {
        score -= 2.0;
        rs.push((format!("GUCLU COKLU TEYIT: {} bagimsiz gosterge dusus ({})", bear.len(), bear.join()), C::Bear));
    } else if bear.len() >= 5 && bull.len() <= 2 {
        score -= 1.0;
        rs.push((format!("COKLU TEYIT: {} bagimsiz gosterge dusus", bear.len()), C::Bear));
    }

    // ── setups ──
    for s in detect_setups(b, ind) {
        score += s.score;
        let c = if s.score > 0.0 {
            C::Bull
        } else if s.score < 0.0 {
            C::Bear
        } else {
            C::Neutral
        };
        rs.push((format!("SETUP: {} — {}", s.name, s.desc), c));
    }

    // ── pivots ──
    if p > pivots.pp && p < pivots.r1 {
        rs.push(("Pivot ustunde, R1 hedefliyor".into(), C::Bull));
    } else if p < pivots.pp && p > pivots.s1 {
        rs.push(("Pivot altinda, S1 destek".into(), C::Bear));
    }

    // ── regime ──
    let regime_is_trend = is_trending && adx.num() > 25.0;
    let regime_is_range = is_ranging && adx.num() < 18.0;
    let regime_is_volatile = atr.truthy() && p > 0.0 && atr.num() / p > 0.03;
    if regime_is_range {
        if rsi.num() < th.rsi_oversold {
            score += 1.5;
            rs.push((format!("RANGE BONUSU: RSI asiri satim {} daha degerli", rl), C::Bull));
        }
        if rsi.num() > th.rsi_very_overbought {
            score -= 1.5;
            rs.push((format!("RANGE CEZASI: RSI asiri alim {} daha tehlikeli", rl), C::Bear));
        }
    }
    if regime_is_trend && rsi.num() > 50.0 && rsi.num() < 70.0 && ind.plus_di.num() > ind.minus_di.num() {
        score += 0.5;
        rs.push((format!("TREND BONUSU: Momentum devamliligi {}", rl), C::Bull));
    }

    // ── extension guard ──
    if ma20.truthy() && ma20.num() > 0.0 {
        let dist = ((p - ma20.num()) / ma20.num()) * 100.0;
        if !regime_is_trend && dist > 4.0 {
            score -= 2.0;
            bear.add("EXTENSION");
            rs.push((format!("EKSTANSIYON CEZASI: Fiyat MA20'nin %{} ustunde (trend yok) — kovalamak riski", tf(dist, 1)), C::Bear));
        } else if dist > 9.0 {
            score -= 1.5;
            bear.add("EXTENSION");
            rs.push((format!("ASIRI UZANMA: Fiyat MA20'nin %{} ustunde — geri cekilme riski", tf(dist, 1)), C::Bear));
        } else if regime_is_range && dist < 1.0 && rsi.num() < 45.0 {
            score += 1.5;
            bull.add("MEANREVERT");
            rs.push((
                format!("ORTALAMAYA DONUS: Fiyat MA20 yakini/alti + RSI {} — yatay piyasada dip alim", tf(rsi.or(0.0), 0)),
                C::Bull,
            ));
        }
    }

    // ── gaps ──
    if n >= 3 {
        let (prev, curr) = (b[n - 2], b[n - 1]);
        if curr.l > prev.h && ind.vol_ratio > 1.5 {
            score += 1.5;
            rs.push((format!("YUKARI GAP: {} -> {} TL hacimle (kirildigi yerde destek)", tf(prev.h, 2), tf(curr.l, 2)), C::Bull));
        }
        if curr.h < prev.l && ind.vol_ratio > 1.5 {
            score -= 1.5;
            rs.push((format!("ASAGI GAP: {} -> {} TL hacimle (kirilma bolgesi direnc)", tf(prev.l, 2), tf(curr.h, 2)), C::Bear));
        }
    }

    // ── weak close / pin bars ──
    let dhl = ind.day_hl_range;
    if dhl < 0.2 {
        score -= 3.5;
        rs.push(("COK ZAYIF KAPANIS: Zirveden %80+ geri verildi — agir satis baskisi".into(), C::Bear));
    } else if dhl < 0.3 {
        score -= 2.5;
        rs.push(("ZAYIF KAPANIS: Zirveden sert satis yedi (Tuzak riski)".into(), C::Bear));
    } else if dhl < 0.4 {
        score -= 1.0;
        rs.push(("ORTA-ZAYIF KAPANIS: Gun icinde saticilar aktif".into(), C::Bear));
    }
    {
        let t = b[n - 1];
        if t.h > t.l {
            let top = js::max(t.o, t.c);
            let bottom = js::min(t.o, t.c);
            let upper = t.h - top;
            let lower = bottom - t.l;
            let body = js::or(top - bottom, 0.01);
            if upper > body * 2.0 && dhl < 0.4 {
                score -= 2.0;
                rs.push(("SHOOTING STAR / PIN BAR: Yukaridan reddedildi".into(), C::Bear));
            }
            if upper > body * 4.0 && body / (t.h - t.l) < 0.1 {
                score -= 2.5;
                rs.push(("GRAVESTONE DOJI: Guc tukenmesi — ertesi gun dusus riski cok yuksek".into(), C::Bear));
            }
            if lower > body * 2.5 && upper < body * 0.5 && rsi.num() < 40.0 {
                score += 1.5;
                rs.push(("HAMMER: Dipten guclu reddedilme — tersine donus sinyali".into(), C::Bull));
            }
        }
    }

    // ── exhaustion ──
    if n >= 5 {
        let last5 = &b[n - 5..];
        let last3 = &b[n - 3..];
        let rising3 = (1..3).all(|i| last3[i].c > last3[i - 1].c);
        let total_rise3 = (last3[2].c - last3[0].o) / last3[0].o * 100.0;
        if rising3 && total_rise3 > 6.0 && ind.vol_ratio < 1.0 {
            score -= 2.5;
            rs.push((
                format!("TUKENIS PATTERNI: 3 gun +%{} yukselis ama hacim dusuyor — akilli para almıyor", tf(total_rise3, 1)),
                C::Bear,
            ));
        } else if rising3 && total_rise3 > 4.0 && ind.vol_ratio < 0.8 {
            score -= 1.5;
            rs.push((format!("ZAYIF RALLI: 3 gunde +%{} ama hacim kuruyor", tf(total_rise3, 1)), C::Bear));
        }
        let b0 = (last3[0].c - last3[0].o).abs();
        let b1 = (last3[1].c - last3[1].o).abs();
        let b2 = (last3[2].c - last3[2].o).abs();
        if b0 > b1 && b1 > b2 && b2 > 0.0 && rising3 {
            score -= 1.5;
            rs.push(("DARALAN GOVDE: Her gun daha kucuk yukselis — momentum tukeniyor".into(), C::Bear));
        }
        let green = last5.iter().filter(|x| x.c > x.o).count();
        let red = last5.iter().filter(|x| x.c < x.o).count();
        if green >= 4 && rsi.or(50.0) > 65.0 {
            let pen = if ind.vol_ratio < 1.0 {
                2.5
            } else if ind.vol_ratio < 1.2 {
                1.5
            } else {
                1.0
            };
            score -= pen;
            rs.push((
                format!("UZAMIS RALLI: {}/5 yesil mum + RSI {} — duzeltme olasılığı yuksek", green, tf(rsi.or(50.0), 0)),
                C::Bear,
            ));
        }
        if red >= 4 && rsi.or(50.0) < 35.0 {
            score += 1.5;
            rs.push(("SICRAMA POTANSIYELI: 4+ dusus + RSI dusuk — tepki yukselisi yakin".into(), C::Bull));
        }
    }

    // ── smart money traps ──
    if ind.obv_trend == "distribution" && ind.change_pct > 0.0 && rsi.or(50.0) > 55.0 {
        score -= 2.5;
        rs.push(("AKILLI PARA TUZAGI: Fiyat yukselirken OBV dagilim — buyukler satiyor, KACINIZ".into(), C::Bear));
    }
    if ind.cmf.or(0.0) < -0.08 && ind.change_pct > 0.5 {
        score -= 1.5;
        rs.push(("CMF UYARISI: Fiyat artisi + para cikisi — sahte yukselis".into(), C::Bear));
    }
    if ind.mfi.or(50.0) > 75.0 && ind.change_pct > 2.0 {
        score -= 2.0;
        rs.push((
            format!("MFI ASIRI ALIM ({}): Yukselis + asiri MFI = kar realizasyonu yakın", tf(ind.mfi.or(50.0), 0)),
            C::Bear,
        ));
    }

    // ── momentum quality ──
    if n >= 5 {
        let last3 = &b[n - 3..];
        let up = (1..3).all(|i| last3[i].c >= last3[i - 1].c);
        let down = (1..3).all(|i| last3[i].c <= last3[i - 1].c);
        let v = ind.vol_ratio;
        if up && v > 1.5 {
            score += 1.0;
            rs.push(("MOMENTUM KALITESI: Yukselis hacimle teyit ediliyor".into(), C::Bull));
        }
        if up && v > 3.0 {
            score += 2.0;
            rs.push(("MOMENTUM KALITESI: ASIRI GUCLU kurumsal momentum".into(), C::Bull));
        }
        if down && v > 1.5 {
            score -= 1.5;
            rs.push(("MOMENTUM KALITESI: Dusus hacimle teyit — satis baskisi agir".into(), C::Bear));
        }
        if down && v > 2.5 {
            score -= 2.0;
            rs.push(("KURUMSAL SATIS: Agir hacimli dusus — panik modu".into(), C::Bear));
        }
        if up && v < 0.7 {
            score -= 1.5;
            rs.push(("ZAYIF RALLI: Yukselis dusuk hacimle — susdurulabilir (cok tehlikeli)".into(), C::Bear));
        } else if up && v < 1.0 {
            score -= 0.5;
            rs.push(("DUSUK HACIM RALLISI: Yukselis ortalamanin altinda hacimle".into(), C::Bear));
        }
    }

    // ── volume profile rejection / breakout ──
    if poc.truthy() {
        let pv = poc.num();
        let dist = ((p - pv) / pv) * 100.0;
        if dist < 0.0 && dist > -3.0 && dhl < 0.4 {
            score -= 1.5;
            rs.push((format!("HACIM PROFILI TUZAGI: Fiyat {} POC seviyesinin altinda baskilaniyor", tf(pv, 2)), C::Bear));
        } else if dist > 0.0 && dist < 3.0 && ind.vol_ratio > 1.3 {
            score += 1.5;
            rs.push((format!("HACIM PROFILI KIRILIMI: {} POC seviyesi hacimle asildi", tf(pv, 2)), C::Bull));
        }
    }

    // ── false breakouts ──
    if n >= 5 {
        let (prev2, prev1, curr) = (b[n - 3], b[n - 2], b[n - 1]);
        let mut res: Vec<f64> = ind.sr.iter().filter(|s| s.res).map(|s| s.price).collect();
        res.sort_by(|a, b| js::cmp_num(a - b));
        if let Some(r0) = res.first().copied() {
            if prev1.h > r0 && curr.c < r0 && prev2.c < r0 {
                score -= 1.5;
                rs.push((format!("SAHTE KIRILMA: {} TL direncini kirdi ama geri dusdu — tuzak", tf(r0, 2)), C::Bear));
            }
        }
        let mut sup: Vec<f64> = ind.sr.iter().filter(|s| !s.res).map(|s| s.price).collect();
        sup.sort_by(|a, b| js::cmp_num(b - a));
        if let Some(s0) = sup.first().copied() {
            if prev1.l < s0 && curr.c > s0 && prev2.c > s0 {
                score += 1.5;
                rs.push((format!("SAHTE KIRILMA (SPRING): {} TL destegi kirdi ama toparlanma — alis firsati", tf(s0, 2)), C::Bull));
            }
        }
    }

    // ── multi-timeframe ──
    if let Some(h) = &opts.htf {
        let strength = h.adx.or(15.0);
        let strong = strength > 25.0;
        let wbear = h.weekly_is("bear");
        let wbull = h.weekly_is("bull");
        if h.trend_is("bear") && score > 0.0 {
            if wbear {
                let pen = js::max(1.5, score * 0.25);
                score -= pen;
                rs.push((format!("MTF UYARI: Haftalik+Gunluk trend DUSUS — alis sinyal skoru %25 kesildi (-{})", tf(pen, 1)), C::Bear));
            } else if strong {
                score -= 1.5;
                rs.push((format!("MTF UYARI: Guclu gunluk dusus trendi (ADX:{}) — dipten donus riski (-1.5)", tf(strength, 0)), C::Bear));
            } else {
                score -= 1.0;
                rs.push(("MTF UYARI: Gunluk trend DUSUS — dipten donus potansiyeli (-1)".into(), C::Bear));
            }
        } else if h.trend_is("bull") && score > 0.0 {
            if wbull {
                score += 2.5;
                rs.push(("MTF GUCLU TEYIT: Haftalik+Gunluk trend YUKSELIS ile tam uyumlu (+2.5)".into(), C::Bull));
            } else {
                score += 1.5;
                rs.push(("MTF TEYIT: Gunluk trend YUKSELIS ile uyumlu (+1.5)".into(), C::Bull));
            }
        } else if h.trend_is("bull") && score < 0.0 {
            if wbull && !strong {
                score += 2.0;
                rs.push(("MTF TAMPON: Haftalik yukselis trendi satis baskisini onemli olcude hafifletiyor (+2)".into(), C::Neutral));
            } else {
                score += 1.0;
                rs.push(("MTF TAMPON: Gunluk yukselis trendi satis baskisini hafifletiyor (+1)".into(), C::Neutral));
            }
        } else if h.trend_is("bear") && score < 0.0 {
            if wbear {
                score -= 2.0;
                rs.push(("MTF TEYIT: Haftalik+Gunluk DUSUS trendi ile uyumlu satis (-2)".into(), C::Bear));
            } else {
                score -= 1.0;
                rs.push(("MTF TEYIT: Gunluk DUSUS trendi ile uyumlu satis (-1)".into(), C::Bear));
            }
        }
        if !h.rsi.nullish() && !rsi.nullish() {
            let hr = h.rsi.num();
            if hr > 70.0 && rsi.num() > 60.0 {
                score -= 1.5;
                rs.push((
                    format!(
                        "MTF RSI CIFT ASIRI ALIM: Hem gunluk ({}) hem kisa vadede ({}) asiri alim — ciddi duzeltme riski",
                        tf(hr, 0),
                        tf(rsi.num(), 0)
                    ),
                    C::Bear,
                ));
            }
            if hr < 30.0 && rsi.num() < 40.0 {
                score += 1.5;
                rs.push(("MTF RSI CIFT ASIRI SATIM: Coklu zaman diliminde dip — guclu dip firsati".into(), C::Bull));
            }
        }
        if h.ma200 == Some(false) && score > 0.0 {
            score -= 1.0;
            rs.push(("MTF MA200: Fiyat gunluk MA200 altinda — uzun vadeli dusus trendinde".into(), C::Bear));
        } else if h.ma200 == Some(true) && score > 0.0 {
            score += 0.5;
            rs.push(("MTF MA200: Gunluk MA200 uzerinde — uzun vadeli yukselis trendinde".into(), C::Bull));
        }
        if !h.weekly_rsi.nullish() && !rsi.nullish() {
            let wr = h.weekly_rsi.num();
            if wr > 70.0 && score > 3.0 {
                score -= 1.5;
                rs.push((format!("HAFTALIK ASIRI ALIM: Haftalik RSI {} — duzeltme riski yuksek", tf(wr, 0)), C::Bear));
            }
            if wr < 30.0 && score < -2.0 {
                score += 1.5;
                rs.push((format!("HAFTALIK ASIRI SATIM: Haftalik RSI {} — tersine donus potansiyeli", tf(wr, 0)), C::Bull));
            }
        }
    }

    // ── KAP sentiment ──
    if let Some(k) = &opts.kap {
        let not_zero = match k.score {
            V::F(x) => x != 0.0,
            _ => true, // undefined !== 0, null !== 0
        };
        if not_zero {
            let impact = js::max(-3.0, js::min(3.0, k.score.num() * 0.3));
            score += impact;
            let head = match &k.headline {
                Some(hl) if !hl.is_empty() => Some(hl.as_str()),
                _ => None,
            };
            if impact > 0.0 {
                rs.push((format!("KAP POZITIF: {} (+{})", head.unwrap_or("Olumlu haber akisi"), tf(impact, 1)), C::Bull));
            } else if impact < 0.0 {
                rs.push((format!("KAP NEGATIF: {} ({})", head.unwrap_or("Olumsuz haber akisi"), tf(impact, 1)), C::Bear));
            }
        }
    }

    // ── sector strength ──
    if let V::F(ss) = opts.sector {
        let s = js::num_str(ss);
        if ss >= 80.0 {
            score += 2.0;
            rs.push((format!("SEKTOR GUCLU GIRIS: Sektorde para akisi guclu ({}/100) — sektorel tailwind", s), C::Bull));
        } else if ss >= 70.0 {
            score += 1.0;
            rs.push((format!("SEKTOR GUCU: Sektor endekse karsi guclu ({}/100)", s), C::Bull));
        } else if ss <= 20.0 {
            score -= 2.5;
            rs.push((format!("SEKTOR CIKIS ALARMI: Para sektordan kacıyor ({}/100) — AL sinyali bastırıldı", s), C::Bear));
        } else if ss <= 30.0 {
            score -= 1.5;
            rs.push((format!("SEKTOR ZAYIF: Sektor endekse karsi zayif ({}/100)", s), C::Bear));
        }
    }

    // ── Ichimoku ──
    let ichi = &ind.ichimoku;
    match ichi.tk_cross {
        Some("bullish") => {
            score += 1.5;
            bull.add("ichimoku");
            rs.push(("ICHIMOKU TK CROSS: Tenkan Kijun ustune gecti — AL sinyali".into(), C::Bull));
        }
        Some("bearish") => {
            score -= 1.5;
            bear.add("ichimoku");
            rs.push(("ICHIMOKU TK CROSS: Tenkan Kijun altina indi — SAT sinyali".into(), C::Bear));
        }
        _ => {}
    }
    match ichi.kumo_breakout {
        Some("bullish") => {
            score += 2.0;
            bull.add("ichimoku");
            rs.push(("ICHIMOKU KUMO KIRILMA: Fiyat bulutun ustune cikti — guclu AL".into(), C::Bull));
        }
        Some("bearish") => {
            score -= 2.0;
            bear.add("ichimoku");
            rs.push(("ICHIMOKU KUMO KIRILMA: Fiyat bulutun altina indi — guclu SAT".into(), C::Bear));
        }
        _ => {}
    }
    if ichi.cloud == "above" && ichi.kumo_breakout.is_none() {
        score += 0.5;
        rs.push(("ICHIMOKU: Fiyat bulut ustunde — yukselis trendi devam".into(), C::Bull));
    } else if ichi.cloud == "below" && ichi.kumo_breakout.is_none() {
        score -= 0.5;
        rs.push(("ICHIMOKU: Fiyat bulut altinda — dusus trendi devam".into(), C::Bear));
    }
    match ichi.kumo_twist {
        Some("bullish") => {
            score += 0.5;
            rs.push(("ICHIMOKU KUMO TWIST: Bulut rengi degisti — gelecek yukselis isareti".into(), C::Bull));
        }
        Some("bearish") => {
            score -= 0.5;
            rs.push(("ICHIMOKU KUMO TWIST: Bulut rengi degisti — gelecek dusus isareti".into(), C::Bear));
        }
        _ => {}
    }

    // ── Supertrend ──
    if let Supertrend::Full { up, value, flip, .. } = &ind.supertrend {
        let vtxt = || if value.nullish() { "-".to_string() } else { tf(value.num(), 2) };
        match flip {
            Some("bullish") => {
                score += 2.0;
                bull.add("supertrend");
                rs.push(("SUPERTREND FLIP: Trend yukselise dondu — guclu AL sinyali".into(), C::Bull));
            }
            Some("bearish") => {
                score -= 2.0;
                bear.add("supertrend");
                rs.push(("SUPERTREND FLIP: Trend dususe dondu — guclu SAT sinyali".into(), C::Bear));
            }
            _ => {
                if *up {
                    score += 0.5;
                    bull.add("supertrend");
                    rs.push((format!("SUPERTREND: Yukselis trendinde — destek: {} TL", vtxt()), C::Bull));
                } else {
                    score -= 0.5;
                    bear.add("supertrend");
                    rs.push((format!("SUPERTREND: Dusus trendinde — direnc: {} TL", vtxt()), C::Bear));
                }
            }
        }
    }

    // ── Williams %R ──
    let wr = ind.last_williams();
    if !wr.nullish() {
        let x = wr.num();
        if x < -80.0 {
            score += 1.0;
            bull.add("williams");
            rs.push((format!("WILLIAMS %R ASIRI SATIM: %R={} — dip firsati", tf(x, 0)), C::Bull));
        } else if x > -20.0 {
            score -= 1.0;
            bear.add("williams");
            rs.push((format!("WILLIAMS %R ASIRI ALIM: %R={} — geri cekilme riski", tf(x, 0)), C::Bear));
        }
    }

    // ── TRIX ──
    if let Trix::Full { last, crossover, .. } = &ind.trix {
        match crossover {
            Some("bullish") => {
                score += 1.5;
                bull.add("trix");
                rs.push(("TRIX YUKARIS KESISIM: Uzun vadeli momentum yukselise dondu".into(), C::Bull));
            }
            Some("bearish") => {
                score -= 1.5;
                bear.add("trix");
                rs.push(("TRIX ASAGI KESISIM: Uzun vadeli momentum dususe dondu".into(), C::Bear));
            }
            _ => {
                if !last.nullish() && last.num() > 0.0 {
                    score += 0.3;
                } else if !last.nullish() && last.num() < 0.0 {
                    score -= 0.3;
                }
            }
        }
    }

    // ── volume profile proximity ──
    if let VolProfile::Full { poc: pv, vah, val, .. } = &ind.vp {
        let d = (p - pv).abs() / pv;
        if d < 0.02 {
            rs.push((format!("VOLUME PROFILE: Fiyat POC yakini ({} TL) — yogun islem bolgesi", tf(*pv, 2)), C::Neutral));
        }
        if p < *val && *val > 0.0 {
            score += 0.5;
            bull.add("volume_profile");
            rs.push(("VOLUME PROFILE: Fiyat deger alaninin altinda — deger firsati".into(), C::Bull));
        }
        if p > *vah && *vah > 0.0 {
            score -= 0.5;
            bear.add("volume_profile");
            rs.push(("VOLUME PROFILE: Fiyat deger alaninin ustunde — asiri uzanma".into(), C::Bear));
        }
    }

    // ── ROC ──
    let (r10, r20) = (ind.last_roc10(), ind.last_roc20());
    if !r10.nullish() && !r20.nullish() {
        let accel = r10.num() - r20.num();
        if r10.num() > 5.0 && accel > 2.0 {
            score += 1.0;
            bull.add("roc");
            rs.push((format!("ROC IVME: Momentum hizlaniyor (ROC10:+{}%, ivme:+{})", tf(r10.num(), 1), tf(accel, 1)), C::Bull));
        } else if r10.num() < -5.0 && accel < -2.0 {
            score -= 1.0;
            bear.add("roc");
            rs.push((format!("ROC IVME: Momentum dususe hizlaniyor (ROC10:{}%, ivme:{})", tf(r10.num(), 1), tf(accel, 1)), C::Bear));
        }
    }

    let raw_score = score;
    let score100 = js::max(0.0, js::min(100.0, 50.0 + (raw_score / 35.0) * 50.0));
    let provisional = if score100 >= 60.0 {
        "buy"
    } else if score100 <= 40.0 {
        "sell"
    } else {
        "hold"
    };
    let _ = ni;
    (
        Pending {
            raw_score,
            reasons: rs,
            bull,
            bear,
            atr,
            fibs,
            pivots,
            regime_is_trend,
            regime_is_volatile,
            htf: opts.htf,
        },
        Begin { score100, provisional, regime: regime.label() },
    )
}

struct Cand {
    price: f64,
    weight: f64,
}

/// Phase two. `score100` already went through JS calibration; `cal_reason` is
/// the calibration reason JS built (pushed here so the reasons keep JS order).
pub fn finish(b: &[Bar], ind: &Indicators, pd: Pending, score100_in: f64, cal_reason: Option<(String, C)>) -> String {
    let Pending { raw_score, mut reasons, bull, bear, atr, fibs, pivots, regime_is_trend, regime_is_volatile, htf } = pd;
    if let Some(r) = cal_reason {
        reasons.push(r);
    }
    let n = b.len();
    let p = ind.last_close;
    let mut score100 = score100_in;
    let rsi = ind.last_rsi();

    let mut conf = js::min(if score100 > 50.0 { (score100 - 50.0) * 2.0 } else { (50.0 - score100) * 2.0 }, 95.0);
    if let Some(h) = &htf {
        if h.trend_is("bear") && score100 > 50.0 {
            conf *= 0.70;
        }
        if h.weekly_is("bear") && score100 > 50.0 {
            conf *= 0.80;
        }
        if h.trend_is("bull") && score100 > 50.0 {
            conf = js::min(95.0, conf * 1.10);
        }
        if h.weekly_is("bull") && h.trend_is("bull") && score100 > 50.0 {
            conf = js::min(95.0, conf * 1.10);
        }
    }
    let vr = ind.vol_ratio;
    let vol_confirm = vr > 1.1;
    let vol_soft = vr > 0.8;
    let smart_buy = [
        ind.obv_trend == "accumulation",
        !ind.cmf.nullish() && ind.cmf.num() > 0.05,
        !ind.mfi.nullish() && ind.mfi.num() < 35.0,
    ]
    .iter()
    .filter(|x| **x)
    .count();
    let smart_money_buy = smart_buy >= 1;
    let smart_money_sell = ind.obv_trend == "distribution"
        || (!ind.cmf.nullish() && ind.cmf.num() < -0.05)
        || (!ind.mfi.nullish() && ind.mfi.num() > 75.0);
    let not_distribution = ind.obv_trend != "distribution";

    let (mut signal, mut cls): (&'static str, &'static str);
    if score100 >= 75.0 && vol_confirm && smart_money_buy && not_distribution && bull.len() >= 5 {
        signal = "GUCLU AL";
        cls = "buy";
    } else if score100 >= 65.0 && vol_confirm && bull.len() >= 4 && smart_money_buy && not_distribution {
        signal = "AL";
        cls = "buy";
    } else if score100 >= 57.0 && vol_soft && bull.len() >= 3 && smart_money_buy {
        signal = "AL";
        cls = "buy";
    } else if score100 <= 25.0 && vol_confirm && smart_money_sell && bear.len() >= 5 {
        signal = "GUCLU SAT";
        cls = "sell";
    } else if score100 <= 35.0 && bear.len() >= 4 {
        signal = "SAT";
        cls = "sell";
    } else if score100 <= 42.0 && bear.len() >= 3 && smart_money_sell {
        signal = "SAT";
        cls = "sell";
    } else {
        signal = "TUT";
        cls = "hold";
    }

    if cls == "buy" && ind.obv_trend == "distribution" && ind.change_pct > 0.0 && rsi.or(50.0) > 55.0 && ind.cmf.or(0.0) < -0.05 {
        signal = "TUT";
        cls = "hold";
        reasons.push(("DISTRIBUTION TRAP: OBV dagilim + CMF negatif + fiyat yukselis — AL sinyal iptal".into(), C::Bear));
    }

    {
        let rsi_v = rsi.or(50.0);
        let mfi_v = if !ind.mfi.nullish() { ind.mfi.num() } else { 50.0 };
        let ob = rsi_v > 70.0 || mfi_v > 72.0;
        if cls == "buy" && ob {
            let recent_high = if n >= 21 { V::F(js::max_all(b[n - 21..n - 1].iter().map(|x| x.h))) } else { V::N };
            let broke = !recent_high.nullish() && p > recent_high.num();
            let fresh = vr > 1.5 && ind.obv_trend == "accumulation" && broke;
            if !fresh {
                if rsi_v > 76.0 || mfi_v > 80.0 {
                    signal = "TUT";
                    cls = "hold";
                    reasons.push((
                        format!("ASIRI ALIM IPTAL: RSI {} / MFI {} — tepeden alim riski, AL sinyal iptal", tf(rsi_v, 0), tf(mfi_v, 0)),
                        C::Bear,
                    ));
                } else {
                    score100 = js::max(50.0, score100 - 10.0);
                    conf = js::max(15.0, conf * 0.75);
                    if signal == "GUCLU AL" {
                        signal = "AL";
                    }
                    reasons.push((format!("ASIRI ALIM UYARISI: RSI {} — geri cekilme riski, guven dusuruldu", tf(rsi_v, 0)), C::Bear));
                }
            }
        }
    }

    // ── levels ──
    let mut supports: Vec<f64> = ind.sr.iter().filter(|s| !s.res && s.price < p).map(|s| s.price).collect();
    supports.sort_by(|a, b| js::cmp_num(b - a));
    let mut resistances: Vec<f64> = ind.sr.iter().filter(|s| s.res && s.price > p).map(|s| s.price).collect();
    resistances.sort_by(|a, b| js::cmp_num(a - b));
    let sup = supports.first().copied();
    let res = resistances.first().copied();
    let res2 = resistances.get(1).copied();

    let recent_low = if n >= 3 { V::F(js::min(js::min(b[n - 1].l, b[n - 2].l), b[n - 3].l)) } else { V::N };
    let swing_low = if n >= 10 { V::F(js::min_all(b[n - 10..].iter().map(|x| x.l))) } else { V::N };
    let atr_mul = if regime_is_trend { 2.0 } else { 2.5 };
    let atr_stop = if atr.truthy() { V::F(p - atr_mul * atr.num()) } else { V::N };
    let sr_stop = match sup {
        Some(s) => V::F(s * 0.993),
        None => V::N,
    };
    let chandelier_stop = ind.chandelier.long_stop();
    let structure_stop = if recent_low.truthy() && recent_low.num() < p { V::F(recent_low.num() * 0.997) } else { V::N };
    let swing_stop = if swing_low.truthy() && swing_low.num() < p * 0.94 {
        V::N
    } else if swing_low.truthy() {
        V::F(swing_low.num() * 0.993)
    } else {
        V::N
    };
    let max_risk = if regime_is_trend {
        0.94
    } else if atr.truthy() && atr.num() / p > 0.03 {
        0.90
    } else {
        0.92
    };
    let cands: Vec<f64> = [chandelier_stop, sr_stop, structure_stop, swing_stop, atr_stop]
        .iter()
        .filter(|s| !s.nullish() && s.num() < p && s.num() > p * max_risk)
        .map(|s| s.num())
        .collect();
    let mut stop;
    if !cands.is_empty() {
        if regime_is_trend {
            stop = js::max_all(cands.iter().copied());
        } else if sr_stop.truthy() && sr_stop.num() > p * max_risk {
            stop = sr_stop.num();
        } else if structure_stop.truthy() && structure_stop.num() > p * max_risk {
            stop = structure_stop.num();
        } else {
            stop = js::max_all(cands.iter().copied());
        }
    } else {
        let def = if vr > 2.0 { 0.965 } else { 0.95 };
        stop = match sup {
            Some(s) => js::max(s * 0.99, p * def),
            None => p * def,
        };
    }
    if atr.truthy() {
        let min_stop = p - 2.0 * atr.num();
        if stop > min_stop && min_stop > p * max_risk {
            stop = min_stop;
        }
    }
    if stop < p * max_risk {
        stop = p * max_risk;
    }
    if stop > p * 0.975 {
        stop = p * 0.975;
    }

    let ma20 = ind.last_ma20();
    let mut entry = p;
    if cls == "hold" && ma20.truthy() && ma20.num() < p {
        entry = ma20.num();
    } else if cls == "hold" {
        if let Some(s) = sup {
            entry = s * 1.005;
        }
    }

    let mut t1c: Vec<Cand> = Vec::new();
    if let Some(r) = res {
        if r > entry * 1.008 {
            t1c.push(Cand { price: r, weight: 4.0 });
        }
    }
    if atr.truthy() {
        let m = if regime_is_trend { 2.8 } else { 2.0 };
        t1c.push(Cand { price: entry + m * atr.num(), weight: 2.0 });
    }
    if let Some(f) = &fibs {
        if f.up {
            if js::truthy(f.f618) && f.f618 > entry * 1.01 {
                t1c.push(Cand { price: f.f618, weight: 2.0 });
            }
            if js::truthy(f.f1) && f.f1 > entry * 1.01 {
                t1c.push(Cand { price: f.f1, weight: 3.0 });
            }
            if js::truthy(f.f1272) && f.f1272 > entry * 1.02 {
                t1c.push(Cand { price: f.f1272, weight: 1.0 });
            }
        }
    }
    if js::truthy(pivots.r1) && pivots.r1 > entry * 1.005 {
        t1c.push(Cand { price: pivots.r1, weight: 2.0 });
    }
    if js::truthy(pivots.r2) && pivots.r2 > entry * 1.02 {
        t1c.push(Cand { price: pivots.r2, weight: 1.0 });
    }
    let min_rr_target = entry + (entry - stop) * 1.5;
    t1c.push(Cand { price: min_rr_target, weight: 1.0 });

    let filtered: Vec<&Cand> = t1c.iter().filter(|c| c.price <= entry * 1.30 && c.price > entry * 1.005).collect();
    let mut t1 = if !filtered.is_empty() {
        let mut tw = 0.0;
        for c in &filtered {
            tw += c.weight;
        }
        let mut s = 0.0;
        for c in &filtered {
            s += c.price * c.weight;
        }
        s / tw
    } else {
        js::min_all(t1c.iter().map(|c| c.price).filter(|v| *v > entry))
    };
    if t1 < entry * 1.02 {
        t1 = entry * 1.02;
    }
    if t1 > entry * 1.20 {
        t1 = entry * 1.15;
    }

    let mut t2 = if res2.map_or(false, |r| r > t1 * 1.01) {
        res2.unwrap()
    } else if fibs.as_ref().map_or(false, |f| js::truthy(f.f1618) && f.f1618 > t1 * 1.01) {
        fibs.as_ref().unwrap().f1618
    } else if js::truthy(pivots.r2) && pivots.r2 > t1 * 1.01 {
        pivots.r2
    } else if atr.truthy() {
        entry + 3.5 * atr.num()
    } else {
        t1 * 1.05
    };
    // fibs['2.0'] never exists in calcFibonacci's output, so T3 skips it.
    let mut t3 = if js::truthy(pivots.r3) && pivots.r3 > t2 * 1.01 {
        pivots.r3
    } else if atr.truthy() {
        entry + 5.5 * atr.num()
    } else {
        t2 * 1.06
    };
    if t2 <= t1 {
        t2 = t1 * 1.05;
    }
    if t3 <= t2 {
        t3 = t2 * 1.05;
    }

    let risk = entry - stop;
    let reward = t1 - entry;
    let rr = if risk > 0.0 { reward / risk } else { 0.0 };
    let rr2 = if risk > 0.0 { (t2 - entry) / risk } else { 0.0 };
    let rr_quality = if rr >= 2.5 {
        "excellent"
    } else if rr >= 1.8 {
        "good"
    } else if rr >= 1.2 {
        "fair"
    } else {
        "poor"
    };
    let min_rr = if vr > 2.0 && score100 >= 65.0 { 0.5 } else { 0.8 };
    if rr < min_rr && cls == "buy" {
        signal = "TUT";
        cls = "hold";
        reasons.push((
            format!("R/R FILTRESI: Risk/Odul 1:{} yetersiz (Eşik: {}) — sinyal iptal", tf(rr, 1), js::num_str(min_rr)),
            C::Bear,
        ));
    } else if rr < 1.0 && cls == "buy" {
        conf = js::max(15.0, conf * 0.90);
        reasons.push((format!("R/R UYARISI: Risk/Odul 1:{} dusuk — diger faktorlerle dengelenecek", tf(rr, 1)), C::Neutral));
    }
    if cls == "buy" && vr < 0.7 && ind.change_pct > 0.5 {
        conf = js::max(10.0, conf * 0.90);
        reasons.push(("HACIM UYARISI: Yukselis dusuk hacimle — guvenilirlik azaltildi".into(), C::Neutral));
    }
    if cls == "buy" && bull.len() < 3 {
        conf = js::max(15.0, conf * 0.85);
        reasons.push((format!("TEYIT NOTU: {} bagimsiz yukselis teyidi — ek teyit aranmali", bull.len()), C::Neutral));
    }
    if cls == "sell" && bear.len() < 3 {
        conf = js::max(15.0, conf * 0.85);
        reasons.push((format!("TEYIT NOTU: {} bagimsiz dusus teyidi", bear.len()), C::Neutral));
    }

    // ── hold duration ──
    let mut hold_bars = V::N;
    let mut hold_text = "";
    if atr.truthy() && atr.num() > 0.0 {
        let a = atr.num();
        let target_distance = (((t1 + t2) / 2.0) - p).abs();
        let mut base = target_distance / a;
        if regime_is_trend {
            base *= 1.4;
        } else if !regime_is_volatile {
            base *= 0.8;
        }
        if regime_is_volatile {
            base *= 0.6;
        }
        let roc = ind.last_roc10().or(0.0);
        if roc > 10.0 || roc < -10.0 {
            base *= 0.7;
        }
        let structural = bull.has("wyckoff_spring")
            || bull.has("wyckoff_markup")
            || bear.has("wyckoff_distribution")
            || bull.has("golden_cross")
            || ind.wyckoff_phase == "accumulation";
        let trend_follow = ["supertrend", "ichimoku", "macd", "trix"].iter().any(|k| bull.has(k) || bear.has(k));
        let mean_rev = ["rsi", "williams", "bollinger"].iter().any(|k| bull.has(k) || bear.has(k));
        let mut ctx = base;
        if structural {
            ctx = js::max(base, 15.0);
        } else if trend_follow {
            ctx = js::max(base, 7.0);
        } else if mean_rev {
            ctx = js::min(base, 5.0);
        }
        let hb = js::max(1.0, ctx.ceil());
        hold_bars = V::F(hb);
        let intraday = hb <= 1.0 && vr > 2.0 && ind.day_hl_range > 0.3;
        hold_text = if intraday {
            "Gün İçi (Scalp / T-0)"
        } else if hb <= 3.0 {
            "1-3 gün (Kısa Vade Tepki)"
        } else if hb <= 8.0 {
            "3-8 gün (Swing Trade)"
        } else if hb <= 21.0 {
            "1-3 hafta (Orta Vade Trend)"
        } else if hb <= 45.0 {
            "3-6 hafta (Yapısal Formasyon)"
        } else {
            "6+ hafta (Orta-Uzun Vade)"
        };
    }

    // ── long-term view ──
    let (m200, m100, m50) = (ind.last_ma200(), ind.last_ma100(), ind.last_ma50());
    let long_ma = if m200.truthy() {
        m200
    } else if m100.truthy() {
        m100
    } else {
        m50
    };
    let long_arr = if m200.truthy() {
        &ind.ma200
    } else if m100.truthy() {
        &ind.ma100
    } else {
        &ind.ma50
    };
    let mut ltv: Option<(&str, &str, &str, &str)> = None;
    if n >= 50 && long_ma.truthy() {
        let above = p > long_ma.num();
        let slope_idx = core::cmp::min(20, n - 1) as isize;
        let a_now = js::at(long_arr, n as isize - 1);
        let a_then = js::at(long_arr, n as isize - 1 - slope_idx);
        let ma_slope = if a_now.truthy() && a_then.truthy() { (a_now.num() - a_then.num()) / a_then.num() * 100.0 } else { 0.0 };
        let strong_up = above && ma_slope > 1.0;
        let accum = ind.wyckoff_phase == "accumulation" || ind.wyckoff_phase == "markup";
        let smart = ind.obv_trend == "accumulation" || (!ind.cmf.nullish() && ind.cmf.num() > 0.05);
        let factors = [
            above,
            ma_slope > 0.5,
            accum,
            smart,
            !rsi.nullish() && rsi.num() > 40.0 && rsi.num() < 70.0,
            !ind.adx.nullish() && ind.adx.num() > 20.0 && ind.plus_di.num() > ind.minus_di.num(),
        ]
        .iter()
        .filter(|x| **x)
        .count();
        ltv = Some(if factors >= 5 {
            ("UZUN VADELI AL", "var(--green)", "1-3 yil", "Guclu yukselis trendi + akilli para birikimi + teknik uyum. Uzun vadeli portfoye uygun.")
        } else if factors >= 4 && strong_up {
            (
                "UZUN VADELI BIRIKIMDE TUT",
                "var(--cyan)",
                "6-12 ay",
                "MA-200 yukselis trendinde. Dusmelerde kademe kademe birikim stratejisi uygulanabilir.",
            )
        } else if factors >= 3 {
            ("IZLE", "var(--yellow)", "3-6 ay", "Karisik sinyaller. Birikime baslamadan once trend netlesmeyi bekle.")
        } else if factors <= 1 {
            (
                "UZUN VADELI UZAK DUR",
                "var(--red)",
                "-",
                "Uzun vadeli hareketli ortalama altinda, dusus trendinde. Uzun vadeli pozisyon icin uygun degil.",
            )
        } else {
            ("NOTR", "var(--t2)", "-", "Yeterli yukselis sinyali yok. Bekle.")
        });
    }

    // ── intraday metrics ──
    let mut daily_range = 0.0;
    let mut avg_daily_pct = 0.0;
    if n >= 5 {
        let mut ranges: Vec<f64> = Vec::new();
        for bar in &b[n.saturating_sub(10)..] {
            if bar.c > 0.0 {
                ranges.push((bar.h - bar.l) / bar.c * 100.0);
            }
        }
        if !ranges.is_empty() {
            let mut s = 0.0;
            for r in &ranges {
                s += *r;
            }
            avg_daily_pct = s / ranges.len() as f64;
        }
        daily_range = avg_daily_pct;
    }
    let intraday_target = p * (1.0 + avg_daily_pct * 0.4 / 100.0);
    let intraday_stop = p * (1.0 - avg_daily_pct * 0.25 / 100.0);
    let intraday_rr = {
        let num = intraday_target - p;
        let den = p - intraday_stop;
        if !js::truthy(den) || !den.is_finite() {
            0.0
        } else {
            let r = num / den;
            if r.is_finite() {
                r
            } else {
                0.0
            }
        }
    };

    let (bu, bl) = (ind.last_bu(), ind.last_bl());
    let ma50v = ind.last_ma50();
    let mut j = J::new();
    j.obj();
    j.ks("signal", signal);
    j.ks("cls", cls);
    j.kn("score", score100);
    j.kn("rawScore", raw_score);
    j.ks("conf", &tf(conf, 0));
    j.karr("reasons");
    for (t, c) in &reasons {
        j.obj();
        j.ks("t", t);
        j.ks("c", c.name());
        j.end_obj();
    }
    j.end_arr();
    j.kn("stop", stop);
    j.kn("t1", t1);
    j.kn("t2", t2);
    j.kn("t3", t3);
    j.kn("rr", rr);
    j.kn("rr2", rr2);
    j.ks("rrQuality", rr_quality);
    j.kn("entry", entry);
    j.kv("atr", atr);
    match &fibs {
        None => j.knull("fibs"),
        Some(f) => {
            j.kobj("fibs");
            j.ks("trend", if f.up { "up" } else { "down" });
            j.kn("high", f.high);
            j.kn("low", f.low);
            j.kn("0.0", f.f0);
            j.kn("0.236", f.f236);
            j.kn("0.382", f.f382);
            j.kn("0.5", f.f5);
            j.kn("0.618", f.f618);
            j.kn("1.0", f.f1);
            j.kn("1.272", f.f1272);
            j.kn("1.618", f.f1618);
            j.end_obj();
        }
    }
    j.kobj("pivots");
    j.kn("pp", pivots.pp);
    j.kn("r1", pivots.r1);
    j.kn("r2", pivots.r2);
    j.kn("r3", pivots.r3);
    j.kn("s1", pivots.s1);
    j.kn("s2", pivots.s2);
    j.kn("s3", pivots.s3);
    j.end_obj();
    j.kv("holdBars", hold_bars);
    j.ks("holdText", hold_text);
    match ltv {
        None => j.knull("longTermView"),
        Some((rec, color, horizon, reason)) => {
            j.kobj("longTermView");
            j.ks("recommendation", rec);
            j.ks("color", color);
            j.ks("horizon", horizon);
            j.ks("reason", reason);
            j.end_obj();
        }
    }
    j.kn("dailyRange", daily_range);
    j.kn("intradayTarget", intraday_target);
    j.kn("intradayStop", intraday_stop);
    j.kn("intradayRR", intraday_rr);
    if ma20.truthy() {
        j.kn("ma20pct", (p - ma20.num()) / ma20.num() * 100.0);
    } else {
        j.knull("ma20pct");
    }
    if ma50v.truthy() {
        j.kn("ma50pct", (p - ma50v.num()) / ma50v.num() * 100.0);
    } else {
        j.knull("ma50pct");
    }
    if bu.truthy() && bl.truthy() && bu.num() != bl.num() {
        j.kn("bollPct", (p - bl.num()) / (bu.num() - bl.num()) * 100.0);
    } else {
        j.knull("bollPct");
    }
    j.end_obj();
    j.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifier_mirrors_the_regex_chain() {
        // "StochRSI 15/12 ..." contains "RSI " → classified as RSI (JS order).
        assert_eq!(classify("StochRSI 15/12 — Asiri satim bolgesi"), Some("RSI"));
        assert_eq!(classify("Fiyat MA-20 (12.00) ustunde"), Some("MA"));
        assert_eq!(classify("MA-20 > MA-50 Golden cross"), Some("MA"));
        // "verildi —" has "di " → ADX before KAP ("KAPANIS")
        assert_eq!(classify("COK ZAYIF KAPANIS: Zirveden %80+ geri verildi — agir satis baskisi"), Some("ADX"));
        assert_eq!(classify("Hacim 2.1x"), Some("VOL"));
        assert_eq!(classify("OBV Dagilim — Akilli para satiyor (2x agirlik)"), Some("SMART"));
        assert_eq!(classify("Pivot ustunde, R1 hedefliyor"), Some("PIVOT"));
        assert_eq!(classify("hiçbiri"), None);
    }
}
