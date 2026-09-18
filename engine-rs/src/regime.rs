//! Port of src/utils/adaptiveThresholds.js (the parts genSignal uses).

use crate::ind::{Bar, Indicators};
use crate::js;

#[derive(Clone, Debug)]
pub enum Regime {
    /// detectMarketRegime returned the bare string 'NORMAL' (fewer than 20 bars):
    /// `regime.regime` is then undefined and the thresholds come out NaN.
    Bare,
    Obj { label: &'static str, atr_percent: f64 },
}

impl Regime {
    /// `regime?.regime`
    pub fn label(&self) -> Option<&'static str> {
        match self {
            Regime::Bare => None,
            Regime::Obj { label, .. } => Some(label),
        }
    }
    /// `${regime.regime}` inside a template literal.
    pub fn label_text(&self) -> &'static str {
        self.label().unwrap_or("undefined")
    }
}

pub fn detect_market_regime(b: &[Bar], ind: &Indicators) -> Regime {
    let n = b.len();
    if n < 20 {
        return Regime::Bare;
    }
    // JS: `ind.atr?.[ind.atr.length - 1] || 0` — ind.atr is a scalar, so this
    // always reads undefined and falls back to 0. Kept for parity: the ATR% is
    // therefore always 0 (VOLATILE never fires, threshold multiplier stays 0.5).
    let atr = 0.0;
    let price = js::or(js::or(ind.last_close, b[n - 1].c), 0.0);
    let atr_percent = if price > 0.0 { (atr / price) * 100.0 } else { 0.0 };
    let adx = ind.adx.or(0.0);
    let pdi = ind.plus_di.or(0.0);
    let mdi = ind.minus_di.or(0.0);
    let mk = |label: &'static str| Regime::Obj { label, atr_percent };
    if adx > 30.0 && pdi > mdi {
        return mk("TRENDING_UP");
    }
    if adx > 30.0 && mdi > pdi {
        return mk("TRENDING_DOWN");
    }
    if atr_percent > 5.0 {
        return mk("VOLATILE");
    }
    if adx < 15.0 && atr_percent < 2.0 {
        return mk("QUIET");
    }
    if adx < 20.0 {
        return mk("CHOPPY");
    }
    mk("NORMAL")
}

#[derive(Clone, Debug)]
pub struct Thresholds {
    pub rsi_oversold: f64,
    pub rsi_weak_oversold: f64,
    pub rsi_overbought: f64,
    pub rsi_very_overbought: f64,
    pub volume_spike: f64,
    pub volume_explosion: f64,
    pub volume_low: f64,
}

pub fn get_adaptive_thresholds(r: &Regime) -> Thresholds {
    let (label, atr_percent) = match r {
        Regime::Bare => (None, f64::NAN),
        Regime::Obj { label, atr_percent } => (Some(*label), *atr_percent),
    };
    let vm = js::max(0.5, js::min(2.0, atr_percent / 3.0));
    let mut t = Thresholds {
        rsi_oversold: 35.0,
        rsi_weak_oversold: 45.0,
        rsi_overbought: 65.0,
        rsi_very_overbought: 75.0,
        volume_spike: 2.0,
        volume_explosion: 3.0,
        volume_low: 0.5,
    };
    match label {
        Some("TRENDING_UP") | Some("TRENDING_DOWN") => {
            t.rsi_oversold = js::max(25.0, 35.0 - vm * 5.0);
            t.rsi_weak_oversold = js::max(35.0, 45.0 - vm * 5.0);
            t.rsi_overbought = js::max(60.0, 65.0 - vm * 3.0);
            t.rsi_very_overbought = js::max(70.0, 75.0 - vm * 3.0);
            t.volume_spike = 1.5 + vm * 0.3;
            t.volume_explosion = 2.5 + vm * 0.5;
        }
        Some("VOLATILE") => {
            t.rsi_oversold = js::max(20.0, 30.0 - vm * 5.0);
            t.rsi_weak_oversold = js::max(30.0, 40.0 - vm * 5.0);
            t.rsi_overbought = js::min(75.0, 70.0 + vm * 3.0);
            t.rsi_very_overbought = js::min(85.0, 80.0 + vm * 5.0);
            t.volume_spike = 2.5 + vm * 0.5;
            t.volume_explosion = 4.0 + vm;
            t.volume_low = 0.3;
        }
        Some("CHOPPY") => {
            t.rsi_oversold = js::max(30.0, 40.0 - vm * 3.0);
            t.rsi_weak_oversold = js::max(40.0, 50.0 - vm * 3.0);
            t.rsi_overbought = js::min(70.0, 60.0 + vm * 5.0);
            t.rsi_very_overbought = js::min(80.0, 70.0 + vm * 5.0);
            t.volume_spike = 2.0 + vm * 0.3;
            t.volume_explosion = 3.5 + vm * 0.5;
        }
        Some("QUIET") => {
            t.rsi_oversold = js::min(40.0, 35.0 + vm * 3.0);
            t.rsi_weak_oversold = js::min(50.0, 45.0 + vm * 3.0);
            t.rsi_overbought = js::max(60.0, 65.0 + vm * 3.0);
            t.rsi_very_overbought = js::max(70.0, 75.0 + vm * 3.0);
            t.volume_spike = 1.5 + vm * 0.2;
            t.volume_explosion = 2.0 + vm * 0.3;
            t.volume_low = 0.7;
        }
        _ => {
            t.rsi_oversold = 35.0 - vm * 3.0;
            t.rsi_weak_oversold = 45.0 - vm * 3.0;
            t.rsi_overbought = 65.0 + vm * 3.0;
            t.rsi_very_overbought = 75.0 + vm * 3.0;
            t.volume_spike = 2.0 + vm * 0.2;
            t.volume_explosion = 3.0 + vm * 0.3;
        }
    }
    t
}

pub struct Weights {
    pub rsi: f64,
    pub volume: f64,
}

pub fn weights(r: &Regime) -> Weights {
    match r.label() {
        Some("TRENDING_UP") | Some("TRENDING_DOWN") => Weights { rsi: 0.6, volume: 1.0 },
        Some("VOLATILE") => Weights { rsi: 1.3, volume: 1.4 },
        Some("CHOPPY") => Weights { rsi: 1.5, volume: 1.0 },
        Some("QUIET") => Weights { rsi: 1.2, volume: 0.8 },
        _ => Weights { rsi: 1.0, volume: 1.0 },
    }
}

fn swings(b: &[Bar], rsi: &[Option<f64>], high: bool) -> Vec<(f64, f64)> {
    let (lb, window) = (3usize, 30usize);
    let n = b.len();
    let start = core::cmp::max(lb, n.saturating_sub(window));
    let mut out = Vec::new();
    let mut i = start;
    while i + lb < n {
        let v = if high { b[i].h } else { b[i].l };
        if js::truthy(v) {
            let lo = i.saturating_sub(lb);
            let hi = core::cmp::min(n - 1, i + lb);
            let mut swing = true;
            for j in lo..=hi {
                if j == i {
                    continue;
                }
                let o = if high { b[j].h } else { b[j].l };
                if (high && o > v) || (!high && o < v) {
                    swing = false;
                    break;
                }
            }
            if swing {
                out.push((v, rsi[i].unwrap_or(50.0)));
            }
        }
        i += 1;
    }
    out
}

pub fn detect_hidden_divergence(b: &[Bar], ind: &Indicators) -> Option<&'static str> {
    if b.len() < 20 || ind.rsi.len() < 10 {
        return None;
    }
    let highs = swings(b, &ind.rsi, true);
    if highs.len() >= 2 {
        let (last, prev) = (highs[highs.len() - 1], highs[highs.len() - 2]);
        if last.0 > prev.0 && last.1 < prev.1 {
            return Some("BEARISH_HIDDEN");
        }
    }
    let lows = swings(b, &ind.rsi, false);
    if lows.len() >= 2 {
        let (last, prev) = (lows[lows.len() - 1], lows[lows.len() - 2]);
        if last.0 > prev.0 && last.1 < prev.1 {
            return Some("BULLISH_HIDDEN");
        }
    }
    None
}
